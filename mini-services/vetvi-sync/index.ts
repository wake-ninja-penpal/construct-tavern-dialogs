/**
 * «Ветви» — сервер совместного доступа (realtime-синхронизация + merge-mailbox).
 *
 * Модель (по ТЗ TD.md, разделы 2, 8, 9, 16 — с сервером вместо P2P):
 *  - комнаты по roomId; состояние документа комнаты хранится на сервере,
 *    поэтому проект «живёт» даже когда владелец офлайн (снимает ограничение 8.3);
 *  - снапшот-синхронизация: клиент публикует полное состояние (debounce),
 *    сервер сохраняет и раздаёт остальным участникам;
 *  - живые события перетаскивания (vetvi:live) ретранслируются без сохранения;
 *  - участники (имя/цвет) — список онлайн-пользователей комнаты;
 *  - merge-mailbox: копии отправляют дельты, владелец принимает/отклоняет,
 *    статусы доступны отправителю (всё через socket.io ack-события — порт
 *    полностью занят транспортом socket.io, path '/').
 *
 * Транспорт: клиент подключается через шлюз io('/?XTransformPort=3003'),
 * путь socket.io — '/' (требование Caddy-шлюза).
 *
 * Персистентность: SQLite (data/store.db, bun:sqlite, режим WAL). Каждая
 * комната — отдельная запись таблицы rooms, каждая merge-заявка — отдельная
 * запись таблицы merges: сохранение одной комнаты больше не перезаписывает
 * «один огромный JSON» со всеми комнатами, а затрагивает только свою строку.
 * Форматы самих документов не меняются (doc/статистика/дельты — те же JSON-
 * структуры, что уходят на клиент). Legacy-хранилище data/store.json при
 * первом старте автоматически мигрируется в БД (по комнате/заявке построчно),
 * после чего исходный файл переименовывается в store.json.backup-<дата>
 * (не удаляется — страховка данных). Пароль комнаты (salt+sha256) тоже
 * персистится вместе с комнатой.
 */

import { createServer } from 'http'
import { createHash } from 'crypto'
import { Server, type Socket } from 'socket.io'
import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync, readFileSync, renameSync } from 'fs'

const PORT = 3003
const ROOM_TTL_MS = 60 * 60 * 1000 // освобождаем память через час простоя (состояние уже на диске)
const MAX_DOC_BYTES = 4 * 1024 * 1024
const MAX_MERGE_BYTES = 12 * 1024 * 1024
const MAX_MERGES_PER_ROOM = 60
const MAX_ROOMS = 500
const TRIM_EVERY_MS = 60 * 1000 // лимит комнат проверяется не чаще раза в минуту

interface UserMeta {
  id: string
  name: string
  color: string
}

interface RoomMember {
  socketId: string
  user: UserMeta
}

interface MergeRequest {
  id: string
  roomId: string
  copyId: string
  sender: { name: string; color: string }
  createdAt: string
  status: 'pending' | 'applied' | 'rejected'
  stats: Record<string, number>
  doc: { current: unknown; base: unknown }
}

interface StoredRoom {
  doc: unknown
  updatedAt: string
  /* пароль комнаты (salt + sha256) — персистится вместе с комнатой */
  pass?: { salt: string; hash: string } | null
}

/* ─── персистентность: SQLite (bun:sqlite) ───
   Схема:
     rooms(id PK, doc, updated_at, pass_salt, pass_hash) — по записи на комнату;
     merges(id PK, room_id, copy_id, sender, created_at, status, stats, doc) —
       по записи на merge-заявку.
   JSON-колонки хранят те же структуры, что раньше лежали в store.json:
   формат данных не меняется — меняется только способ хранения. */

const DATA_DIR = new URL('./data/', import.meta.url).pathname
const DATA_FILE = DATA_DIR + 'store.json' // legacy-хранилище (только для миграции)
const DB_FILE = DATA_DIR + 'store.db'

mkdirSync(DATA_DIR, { recursive: true })
const db = new Database(DB_FILE)
db.exec('PRAGMA journal_mode = WAL;') // быстрые записи, устойчивость к сбоям
db.exec('PRAGMA synchronous = NORMAL;')
db.exec('PRAGMA busy_timeout = 5000;')

db.exec(`
  CREATE TABLE IF NOT EXISTS rooms (
    id         TEXT PRIMARY KEY,
    doc        TEXT,
    updated_at TEXT NOT NULL,
    pass_salt  TEXT,
    pass_hash  TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_rooms_updated ON rooms(updated_at);
  CREATE TABLE IF NOT EXISTS merges (
    id           TEXT PRIMARY KEY,
    room_id      TEXT NOT NULL,
    copy_id      TEXT NOT NULL,
    sender_name  TEXT NOT NULL DEFAULT 'Гость',
    sender_color TEXT NOT NULL DEFAULT '#8b929c',
    created_at   TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'pending',
    stats        TEXT,
    doc_current  TEXT,
    doc_base     TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_merges_room ON merges(room_id);
  CREATE INDEX IF NOT EXISTS idx_merges_copy ON merges(room_id, copy_id, status);
`)

interface RoomRow {
  id: string
  doc: string | null
  updated_at: string
  pass_salt: string | null
  pass_hash: string | null
}

interface MergeRow {
  id: string
  room_id: string
  copy_id: string
  sender_name: string
  sender_color: string
  created_at: string
  status: string
  stats: string | null
  doc_current: string | null
  doc_base: string | null
}

/* подготовленные выражения */
const qRoomById = db.prepare(
  'SELECT id, doc, updated_at, pass_salt, pass_hash FROM rooms WHERE id = ?',
)
const qRoomsCount = db.prepare('SELECT COUNT(*) AS c FROM rooms')
const qMergesCount = db.prepare('SELECT COUNT(*) AS c FROM merges')
const qRoomUpsertDoc = db.prepare(
  `INSERT INTO rooms (id, doc, updated_at) VALUES (?, ?, ?)
   ON CONFLICT(id) DO UPDATE SET doc = excluded.doc, updated_at = excluded.updated_at`,
)
/* pass-колонки не трогаем при сохранении документа — пароль комнаты живёт своей жизнью */
const qRoomUpsertPass = db.prepare(
  `INSERT INTO rooms (id, doc, updated_at, pass_salt, pass_hash) VALUES (?, NULL, ?, ?, ?)
   ON CONFLICT(id) DO UPDATE SET pass_salt = excluded.pass_salt, pass_hash = excluded.pass_hash`,
)
const qRoomClearPass = db.prepare('UPDATE rooms SET pass_salt = NULL, pass_hash = NULL WHERE id = ?')
const qRoomTrim = db.prepare(
  `DELETE FROM rooms WHERE id NOT IN (
     SELECT id FROM rooms ORDER BY updated_at DESC LIMIT ?
   )`,
)
const qPendingCount = db.prepare(
  "SELECT COUNT(*) AS c FROM merges WHERE room_id = ? AND status = 'pending'",
)
const qMergeList = db.prepare('SELECT * FROM merges WHERE room_id = ? ORDER BY rowid DESC')
const qMergeById = db.prepare('SELECT id, room_id, copy_id, status FROM merges WHERE id = ?')
const qMergeSetStatus = db.prepare('UPDATE merges SET status = ? WHERE id = ?')
const qMergeInsert = db.prepare(
  `INSERT INTO merges (id, room_id, copy_id, sender_name, sender_color, created_at, status, stats, doc_current, doc_base)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
)
const qMergeDelPendingOfCopy = db.prepare(
  "DELETE FROM merges WHERE room_id = ? AND copy_id = ? AND status = 'pending'",
)
const qMergeTrimRoom = db.prepare(
  `DELETE FROM merges WHERE room_id = ? AND id NOT IN (
     SELECT id FROM merges WHERE room_id = ? ORDER BY rowid DESC LIMIT ?
   )`,
)

/* ── миграция legacy store.json → SQLite ──
   Выполняется один раз: если store.json существует, а БД пуста, все комнаты
   и merge-заявки переносятся построчно в таблицы. Merge-заявки вставляются в
   обратном порядке (в JSON они хранились «новые первыми»), чтобы rowid
   воспроизводил прежний порядок списков. Исходный файл переименовывается в
   store.json.backup-<дата> — данные не удаляются. */
function migrateJsonToSqlite() {
  if (!existsSync(DATA_FILE)) return
  const roomsCount = (qRoomsCount.get() as { c: number }).c
  const mergesCount = (qMergesCount.get() as { c: number }).c
  if (roomsCount > 0 || mergesCount > 0) {
    console.log('[vetvi-sync] store.json найден, но в БД уже есть данные — миграция пропущена')
    return
  }
  try {
    const parsed = JSON.parse(readFileSync(DATA_FILE, 'utf8')) as {
      rooms?: Record<string, StoredRoom>
      merges?: Record<string, MergeRequest[]>
    }
    const legacyRooms = parsed?.rooms || {}
    const legacyMerges = parsed?.merges || {}
    const insRoom = db.prepare(
      'INSERT OR REPLACE INTO rooms (id, doc, updated_at, pass_salt, pass_hash) VALUES (?, ?, ?, ?, ?)',
    )
    const insMerge = db.prepare(
      `INSERT OR REPLACE INTO merges
       (id, room_id, copy_id, sender_name, sender_color, created_at, status, stats, doc_current, doc_base)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    let nRooms = 0
    let nMerges = 0
    db.transaction(() => {
      for (const [id, r] of Object.entries(legacyRooms)) {
        if (!r || typeof r !== 'object') continue
        const pass = r.pass
        insRoom.run(
          id,
          r.doc !== undefined && r.doc !== null ? JSON.stringify(r.doc) : null,
          String(r.updatedAt || new Date().toISOString()),
          pass && typeof pass.salt === 'string' ? pass.salt : null,
          pass && typeof pass.hash === 'string' ? pass.hash : null,
        )
        nRooms++
      }
      for (const [roomId, list] of Object.entries(legacyMerges)) {
        if (!Array.isArray(list)) continue
        for (const m of [...list].reverse()) {
          if (!m || typeof m.id !== 'string' || !m.id) continue
          insMerge.run(
            m.id,
            roomId,
            String(m.copyId || ''),
            String(m.sender?.name || 'Гость'),
            String(m.sender?.color || '#8b929c'),
            String(m.createdAt || new Date().toISOString()),
            m.status === 'applied' || m.status === 'rejected' ? m.status : 'pending',
            m.stats ? JSON.stringify(m.stats) : null,
            m.doc && m.doc.current !== undefined && m.doc.current !== null
              ? JSON.stringify(m.doc.current)
              : null,
            m.doc && m.doc.base !== undefined && m.doc.base !== null
              ? JSON.stringify(m.doc.base)
              : null,
          )
          nMerges++
        }
      }
    })()
    let backupNote = ''
    try {
      const backup = DATA_FILE + '.backup-' + new Date().toISOString().replace(/[:.]/g, '-')
      renameSync(DATA_FILE, backup)
      backupNote = `, исходный файл сохранён как ${backup}`
    } catch {
      backupNote = ' (исходный файл переименовать не удалось — оставлен на месте)'
    }
    console.log(
      `[vetvi-sync] миграция store.json → SQLite завершена: комнат ${nRooms}, merge-заявок ${nMerges}${backupNote}`,
    )
    scheduleTrim()
  } catch (e) {
    console.error('[vetvi-sync] ОШИБКА миграции store.json → SQLite (файл не тронут):', e)
  }
}

/* ── доступ к хранилищу ── */

function rowToMerge(r: MergeRow): MergeRequest {
  let stats: Record<string, number> = {}
  if (r.stats) {
    try {
      stats = JSON.parse(r.stats)
    } catch {
      stats = {}
    }
  }
  let current: unknown = null
  let base: unknown = null
  if (r.doc_current) {
    try {
      current = JSON.parse(r.doc_current)
    } catch {
      current = null
    }
  }
  if (r.doc_base) {
    try {
      base = JSON.parse(r.doc_base)
    } catch {
      base = null
    }
  }
  return {
    id: r.id,
    roomId: r.room_id,
    copyId: r.copy_id,
    sender: { name: r.sender_name, color: r.sender_color },
    createdAt: r.created_at,
    status: r.status === 'applied' || r.status === 'rejected' ? r.status : 'pending',
    stats,
    doc: { current, base },
  }
}

function getStoredRoom(roomId: string): StoredRoom | null {
  const row = qRoomById.get(roomId) as RoomRow | null
  if (!row) return null
  let doc: unknown = null
  if (row.doc) {
    try {
      doc = JSON.parse(row.doc)
    } catch {
      doc = null
    }
  }
  const out: StoredRoom = { doc, updatedAt: row.updated_at }
  if (row.pass_salt && row.pass_hash) out.pass = { salt: row.pass_salt, hash: row.pass_hash }
  return out
}

function saveRoomDoc(roomId: string, doc: unknown, updatedAt: string) {
  qRoomUpsertDoc.run(roomId, JSON.stringify(doc), updatedAt)
}

function saveRoomPass(roomId: string, pass: { salt: string; hash: string } | null) {
  if (pass) {
    qRoomUpsertPass.run(roomId, new Date().toISOString(), pass.salt, pass.hash)
  } else {
    qRoomClearPass.run(roomId)
  }
}

function pendingCount(roomId: string): number {
  return (qPendingCount.get(roomId) as { c: number }).c
}

function mergeListOf(roomId: string): MergeRequest[] {
  return (qMergeList.all(roomId) as MergeRow[]).map(rowToMerge)
}

function mergeStatusesByIds(ids: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const id of ids) {
    const row = qMergeById.get(id) as { id: string; status: string } | null
    if (row) out[row.id] = row.status
  }
  return out
}

/* ─── комнаты ─── */

interface RoomState {
  name: string
  members: Map<string, RoomMember>
  locks: Map<string, ObjLock>
  focus: Map<string, SocketFocus>
  /* пароль комнаты: первый вошедший с защищённым проектом закрепляет salt+hash,
     дальнейшие join требуют пароль (проверка на сервере) */
  pass: { salt: string; hash: string } | null
  gcTimer: ReturnType<typeof setTimeout> | null
}

/* ── «где сейчас работает участник» ──
   Клиент сообщает id ноды, с которой работает (открыл редактор, тянет, выбрал);
   сервер держит по одному фокусу на сокет и раздаёт список по комнате.
   Эфемерно: не персистится, чистится при disconnect. */
interface SocketFocus {
  userId: string
  nodeId: string
  ts: number
}

/* ─── блокировки объектов (soft-lock) ───
   Эфемерны: не персистятся, снимаются при disconnect или по TTL.
   Клиент, начавший редактирование объекта, захватывает lock; остальные
   получают vetvi:locks и показывают «объект используется другим пользователем». */

interface ObjLock {
  sid: string
  userId: string
  name: string
  color: string
  ts: number
}

const LOCK_TTL_MS = 3 * 60 * 1000 // страховка: если клиент «завис» и не шлёт heartbeat
const MAX_LOCKS_PER_SOCKET = 400

const rooms = new Map<string, RoomState>()

function getRoom(name: string): RoomState {
  let room = rooms.get(name)
  if (!room) {
    room = { name, members: new Map(), locks: new Map(), focus: new Map(), pass: null, gcTimer: null }
    rooms.set(name, room)
  }
  if (room.gcTimer) {
    clearTimeout(room.gcTimer)
    room.gcTimer = null
  }
  return room
}

/* sha256 в hex — тот же формат, что и на клиенте (utf-8) */
const sha256hex = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex')

function scheduleRoomGc(room: RoomState) {
  if (room.gcTimer) clearTimeout(room.gcTimer)
  room.gcTimer = setTimeout(() => {
    if (room.members.size === 0) {
      rooms.delete(room.name)
      console.log(`[vetvi-sync] room "${room.name}" reclaimed (idle)`)
    }
  }, ROOM_TTL_MS)
}

function userList(room: RoomState) {
  const out: UserMeta[] = []
  const seen = new Set<string>()
  for (const m of room.members.values()) {
    if (seen.has(m.user.id)) continue
    seen.add(m.user.id)
    out.push(m.user)
  }
  return out
}

/* Чистка «призраков»: сокет мог отвалиться без события disconnect
   (обрыв соединения, рестарт транспорта) — если сокета больше нет
   в списке подключённых, участник не считается онлайн-пользователем. */
function sweepStaleMembers(io: Server, room: RoomState): boolean {
  let changed = false
  for (const [sid] of room.members) {
    if (!io.of('/').sockets.has(sid)) {
      room.members.delete(sid)
      changed = true
    }
  }
  return changed
}

function broadcastUsers(io: Server, room: RoomState) {
  io.to(room.name).emit('vetvi:users', { roomId: room.name, users: userList(room) })
}

/* ─── блокировки объектов ─── */

function lockList(room: RoomState) {
  const now = Date.now()
  const out: { id: string; userId: string; name: string; color: string }[] = []
  for (const [id, l] of room.locks) {
    if (now - l.ts > LOCK_TTL_MS) {
      room.locks.delete(id)
      continue
    }
    out.push({ id, userId: l.userId, name: l.name, color: l.color })
  }
  return out
}

function broadcastLocks(io: Server, room: RoomState) {
  io.to(room.name).emit('vetvi:locks', { roomId: room.name, locks: lockList(room) })
}

/* ── фокус участников (id ноды, с которой работает) ── */

const MAX_FOCUS_NODE_LEN = 80

function focusList(room: RoomState) {
  const byUser = new Map<string, { userId: string; nodeId: string; ts: number }>()
  for (const f of room.focus.values()) {
    if (!f.userId || !f.nodeId) continue
    const prev = byUser.get(f.userId)
    if (!prev || prev.ts < f.ts) byUser.set(f.userId, { userId: f.userId, nodeId: f.nodeId, ts: f.ts })
  }
  return Array.from(byUser.values()).map((f) => ({ userId: f.userId, nodeId: f.nodeId }))
}

function broadcastFocus(io: Server, room: RoomState) {
  io.to(room.name).emit('vetvi:focus', { roomId: room.name, focus: focusList(room) })
}

function releaseSocketFocus(io: Server, room: RoomState, sid: string) {
  if (room.focus.delete(sid)) broadcastFocus(io, room)
}

function releaseSocketLocks(io: Server, room: RoomState, sid: string) {
  let changed = false
  for (const [id, l] of room.locks) {
    if (l.sid === sid) {
      room.locks.delete(id)
      changed = true
    }
  }
  if (changed) broadcastLocks(io, room)
}

/* ─── лимит комнат (было MAX_ROOMS в общем JSON, теперь — строк таблицы rooms) ─── */

function trimRooms() {
  const cnt = (qRoomsCount.get() as { c: number }).c
  if (cnt <= MAX_ROOMS) return
  qRoomTrim.run(MAX_ROOMS)
  const left = (qRoomsCount.get() as { c: number }).c
  console.log(`[vetvi-sync] trimRooms: удалено комнат ${cnt - left} (лимит ${MAX_ROOMS})`)
}

let trimTimer: ReturnType<typeof setTimeout> | null = null

function scheduleTrim() {
  if (trimTimer) return
  trimTimer = setTimeout(() => {
    trimTimer = null
    try {
      trimRooms()
    } catch (e) {
      console.error('[vetvi-sync] trim error', e)
    }
  }, TRIM_EVERY_MS)
}

/* ─── socket.io ─── */

const httpServer = createServer()

const io = new Server(httpServer, {
  // DO NOT change the path, it is used by Caddy to forward the request to the correct port
  path: '/',
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
  pingTimeout: 60000,
  pingInterval: 25000,
  maxHttpBufferSize: MAX_MERGE_BYTES,
})

const isSafeRoom = (room: unknown): room is string =>
  typeof room === 'string' && room.length > 0 && room.length <= 256

io.on('connection', (socket: Socket) => {
  let joinedRoom: string | null = null

  /* ── вход в комнату ── */
  socket.on(
    'vetvi:join',
    (
      payload: {
        roomId?: string
        user?: UserMeta
        /* пароль комнаты (если защищена) */
        password?: string
        /* salt+hash защищённого проекта: закрепляется за комнатой первым вошедшим */
        pass?: { salt?: string; hash?: string }
      },
      ack?: (r: unknown) => void,
    ) => {
      try {
        const roomName = payload?.roomId
        if (!isSafeRoom(roomName)) {
          ack?.({ ok: false, error: 'bad room' })
          return
        }
        const user: UserMeta = {
          id: String(payload?.user?.id || socket.id),
          name: String(payload?.user?.name || 'Гость').slice(0, 40),
          color: String(payload?.user?.color || '#8b929c').slice(0, 20),
        }

        const room = getRoom(roomName)

        /* пароль комнаты: восстановить из SQLite */
        const storedRoom = getStoredRoom(roomName)
        if (!room.pass && storedRoom?.pass?.salt && storedRoom?.pass?.hash) {
          room.pass = { salt: String(storedRoom.pass.salt), hash: String(storedRoom.pass.hash) }
        }

        const isMember = room.members.has(socket.id)

        /* закрепление пароля: комната ещё без пароля, вошедший пришёл salt+hash
           защищённого проекта. Пустая комната — закрепляем сразу; в комнате с
           документом — только если это тот же защищённый проект. */
        if (
          !room.pass &&
          !isMember &&
          payload.pass &&
          typeof payload.pass.salt === 'string' &&
          typeof payload.pass.hash === 'string' &&
          /^[0-9a-f]{16,64}$/.test(payload.pass.salt) &&
          /^[0-9a-f]{64}$/.test(payload.pass.hash)
        ) {
          const claimSalt = payload.pass.salt.slice(0, 64)
          const claimHash = payload.pass.hash.slice(0, 64)
          const storedDoc = storedRoom?.doc as { meta?: { passHash?: string } } | undefined
          const docHash =
            storedDoc && typeof storedDoc === 'object' && storedDoc.meta
              ? storedDoc.meta.passHash
              : null
          if (!storedDoc || !docHash || docHash === claimHash) {
            room.pass = { salt: claimSalt, hash: claimHash }
            saveRoomPass(roomName, room.pass) // пароль сразу персистится в БД
          }
        }

        /* проверка пароля: участник комнаты (rejoin/rename) проходит без повторного ввода */
        if (room.pass && !isMember) {
          const given = typeof payload.password === 'string' ? payload.password : ''
          if (sha256hex(room.pass.salt + ':' + given) !== room.pass.hash) {
            ack?.({ ok: false, error: 'password', needPassword: true })
            return
          }
        }

        joinedRoom = roomName
        socket.join(roomName)
        room.members.set(socket.id, { socketId: socket.id, user })

        // удаляем призраков перед расчётом списка — счётчик онлайн всегда актуальный
        if (sweepStaleMembers(io, room)) broadcastUsers(io, room)

        ack?.({
          ok: true,
          count: userList(room).length,
          doc: storedRoom ? storedRoom.doc : null,
          updatedAt: storedRoom ? storedRoom.updatedAt : null,
          users: userList(room),
          pendingMerges: pendingCount(roomName),
          locks: lockList(room),
          focus: focusList(room),
        })

        broadcastUsers(io, room)
        console.log(
          `[vetvi-sync] join "${roomName}" (${user.name}), peers: ${userList(room).length}`,
        )
      } catch (error) {
        console.error('[vetvi-sync] join error', error)
        ack?.({ ok: false, error: 'join failed' })
      }
    },
  )

  /* ── снапшот состояния ── */
  socket.on('vetvi:state', (msg: { roomId?: string; doc?: unknown }) => {
    try {
      if (!isSafeRoom(msg?.roomId) || msg.roomId !== joinedRoom) return
      const doc = msg.doc as { nodes?: unknown[] } | undefined
      if (!doc || !Array.isArray(doc.nodes)) return
      const json = JSON.stringify(doc)
      if (json.length > MAX_DOC_BYTES) {
        socket.emit('vetvi:error', { message: 'Документ слишком большой для синхронизации' })
        return
      }
      saveRoomDoc(msg.roomId, doc, new Date().toISOString()) // только строка этой комнаты
      scheduleTrim()
      socket.to(msg.roomId).emit('vetvi:state', { roomId: msg.roomId, doc })
    } catch (error) {
      console.error('[vetvi-sync] state error', error)
    }
  })

  /* ── живые перетаскивания ── */
  socket.on(
    'vetvi:live',
    (msg: {
      roomId?: string
      nodes?: { id: string; x: number; y: number }[]
      groups?: { id: string; x: number; y: number }[]
      pts?: { eid: string; pts: { x: number; y: number }[] }[]
      dlgW?: { id: string; w: number }[]
    }) => {
      try {
        if (!isSafeRoom(msg?.roomId) || msg.roomId !== joinedRoom) return
        socket.to(msg.roomId).emit('vetvi:live', {
          roomId: msg.roomId,
          nodes: msg.nodes,
          groups: msg.groups,
          pts: msg.pts,
          dlgW: msg.dlgW,
        })
      } catch {
        // ignore
      }
    },
  )

  /* ── merge-почта ── */

  // Отправить merge-запрос из копии (отправитель может не состоять в комнате)
  socket.on(
    'vetvi:merge-send',
    (
      payload: {
        roomId?: string
        copyId?: string
        sender?: { name?: string; color?: string }
        stats?: Record<string, number>
        doc?: { current?: unknown; base?: unknown }
      },
      ack?: (r: unknown) => void,
    ) => {
      try {
        const roomId = payload?.roomId
        if (!isSafeRoom(roomId) || !payload?.copyId || !payload?.doc?.current) {
          ack?.({ ok: false, error: 'bad merge payload' })
          return
        }
        const entry: MergeRequest = {
          id: 'mr' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
          roomId,
          copyId: String(payload.copyId),
          sender: {
            name: String(payload.sender?.name || 'Гость').slice(0, 40),
            color: String(payload.sender?.color || '#8b929c').slice(0, 20),
          },
          createdAt: new Date().toISOString(),
          status: 'pending',
          stats: payload.stats || {},
          doc: { current: payload.doc.current, base: payload.doc.base || null },
        }
        // повторная отправка из той же копии обновляет существующую заявку:
        // снимаем прежнюю pending этой копии, вставляем новую, подрезаем лимит
        db.transaction((e: MergeRequest) => {
          qMergeDelPendingOfCopy.run(e.roomId, e.copyId)
          qMergeInsert.run(
            e.id,
            e.roomId,
            e.copyId,
            e.sender.name,
            e.sender.color,
            e.createdAt,
            e.status,
            JSON.stringify(e.stats || {}),
            e.doc.current !== undefined && e.doc.current !== null ? JSON.stringify(e.doc.current) : null,
            e.doc.base !== undefined && e.doc.base !== null ? JSON.stringify(e.doc.base) : null,
          )
          qMergeTrimRoom.run(e.roomId, e.roomId, MAX_MERGES_PER_ROOM)
        })(entry)
        io.to(roomId).emit('vetvi:merge-new', {
          roomId,
          id: entry.id,
          sender: entry.sender,
          stats: entry.stats,
          createdAt: entry.createdAt,
        })
        console.log(`[vetvi-sync] merge "${entry.id}" → room "${roomId}"`)
        ack?.({ ok: true, id: entry.id })
      } catch (error) {
        console.error('[vetvi-sync] merge-send error', error)
        ack?.({ ok: false, error: 'merge failed' })
      }
    },
  )

  // Список заявок комнаты (для владельца)
  socket.on(
    'vetvi:merge-list',
    (payload: { roomId?: string }, ack?: (r: unknown) => void) => {
      try {
        const roomId = payload?.roomId
        if (!isSafeRoom(roomId)) {
          ack?.({ ok: false, error: 'bad room' })
          return
        }
        ack?.({ ok: true, requests: mergeListOf(roomId), pending: pendingCount(roomId) })
      } catch (error) {
        console.error('[vetvi-sync] merge-list error', error)
        ack?.({ ok: false, error: 'list failed' })
      }
    },
  )

  // Решение владельца: принять/отклонить
  socket.on(
    'vetvi:merge-decide',
    (
      payload: { roomId?: string; requestId?: string; decision?: string },
      ack?: (r: unknown) => void,
    ) => {
      try {
        const roomId = payload?.roomId
        const requestId = String(payload?.requestId || '')
        const decision = payload?.decision === 'applied' ? 'applied' : 'rejected'
        if (!isSafeRoom(roomId)) {
          ack?.({ ok: false, error: 'bad room' })
          return
        }
        const entry = qMergeById.get(requestId) as
          | { id: string; room_id: string; copy_id: string; status: string }
          | null
        if (!entry || entry.room_id !== roomId) {
          ack?.({ ok: false, error: 'merge not found' })
          return
        }
        qMergeSetStatus.run(decision, requestId)
        io.to(roomId).emit('vetvi:merge-decision', {
          roomId,
          requestId,
          status: decision,
          copyId: entry.copy_id,
        })
        console.log(`[vetvi-sync] merge "${requestId}" → ${decision}`)
        ack?.({ ok: true, status: decision })
      } catch (error) {
        console.error('[vetvi-sync] merge-decide error', error)
        ack?.({ ok: false, error: 'decide failed' })
      }
    },
  )

  // Статусы merge-заявок для отправителя
  socket.on(
    'vetvi:merge-status',
    (payload: { ids?: string[] }, ack?: (r: unknown) => void) => {
      try {
        const ids = (payload?.ids || []).map(String).filter(Boolean).slice(0, 500)
        ack?.({ ok: true, statuses: mergeStatusesByIds(ids) })
      } catch (error) {
        console.error('[vetvi-sync] merge-status error', error)
        ack?.({ ok: false, error: 'status failed' })
      }
    },
  )

  /* ── блокировки объектов ── */

  // Захват/продление (heartbeat) блокировок: свободные id — выдаём, занятые другими — в denied
  socket.on(
    'vetvi:lock',
    (payload: { roomId?: string; ids?: string[] }, ack?: (r: unknown) => void) => {
      try {
        if (!isSafeRoom(payload?.roomId) || payload.roomId !== joinedRoom) {
          ack?.({ ok: false, denied: [] })
          return
        }
        const room = rooms.get(payload.roomId)
        const me = room?.members.get(socket.id)
        if (!room || !me) {
          ack?.({ ok: false, denied: [] })
          return
        }
        const ids = (Array.isArray(payload.ids) ? payload.ids : [])
          .map(String)
          .filter(Boolean)
          .slice(0, MAX_LOCKS_PER_SOCKET)
        const now = Date.now()
        const denied: { id: string; by: { name: string; color: string } }[] = []
        for (const id of ids) {
          const cur = room.locks.get(id)
          if (cur && cur.sid !== socket.id && now - cur.ts < LOCK_TTL_MS) {
            denied.push({ id, by: { name: cur.name, color: cur.color } })
          } else {
            room.locks.set(id, {
              sid: socket.id,
              userId: me.user.id,
              name: me.user.name,
              color: me.user.color,
              ts: now,
            })
          }
        }
        broadcastLocks(io, room)
        ack?.({ ok: true, denied })
      } catch (error) {
        console.error('[vetvi-sync] lock error', error)
        ack?.({ ok: false, denied: [] })
      }
    },
  )

  // Освобождение блокировок (жест завершён / модалка закрыта)
  socket.on(
    'vetvi:unlock',
    (payload: { roomId?: string; ids?: string[] }, ack?: (r: unknown) => void) => {
      try {
        if (!isSafeRoom(payload?.roomId) || payload.roomId !== joinedRoom) {
          ack?.({ ok: false })
          return
        }
        const room = rooms.get(payload.roomId)
        if (room) {
          const ids = (Array.isArray(payload.ids) ? payload.ids : []).map(String).filter(Boolean)
          let changed = false
          for (const id of ids) {
            const cur = room.locks.get(id)
            if (cur && cur.sid === socket.id) {
              room.locks.delete(id)
              changed = true
            }
          }
          if (changed) broadcastLocks(io, room)
        }
        ack?.({ ok: true })
      } catch (error) {
        console.error('[vetvi-sync] unlock error', error)
        ack?.({ ok: false })
      }
    },
  )

  /* ── фокус: на какой ноде участник работает прямо сейчас ── */
  socket.on('vetvi:focus', (payload: { roomId?: string; nodeId?: string | null }) => {
    try {
      if (!isSafeRoom(payload?.roomId) || payload.roomId !== joinedRoom) return
      const room = rooms.get(payload.roomId)
      const me = room?.members.get(socket.id)
      if (!room || !me) return
      const nodeId =
        typeof payload.nodeId === 'string' && payload.nodeId
          ? payload.nodeId.slice(0, MAX_FOCUS_NODE_LEN)
          : null
      if (!nodeId) {
        releaseSocketFocus(io, room, socket.id)
        return
      }
      room.focus.set(socket.id, { userId: me.user.id, nodeId, ts: Date.now() })
      broadcastFocus(io, room)
    } catch {
      // ignore
    }
  })

  /* ── управление паролем комнаты (только для участников): set/clear ──
     Для смены/снятия нужен действующий пароль (если он установлен). */
  socket.on(
    'vetvi:pass',
    (
      payload: { roomId?: string; mode?: 'set' | 'clear'; salt?: string; hash?: string; password?: string },
      ack?: (r: unknown) => void,
    ) => {
      try {
        if (!isSafeRoom(payload?.roomId) || payload.roomId !== joinedRoom) {
          ack?.({ ok: false, error: 'not joined' })
          return
        }
        const room = rooms.get(payload.roomId)
        if (!room) {
          ack?.({ ok: false, error: 'no room' })
          return
        }
        if (room.pass) {
          const given = typeof payload?.password === 'string' ? payload.password : ''
          if (sha256hex(room.pass.salt + ':' + given) !== room.pass.hash) {
            ack?.({ ok: false, error: 'password' })
            return
          }
        }
        if (payload?.mode === 'clear') {
          room.pass = null
          saveRoomPass(payload.roomId, null)
          ack?.({ ok: true })
          return
        }
        if (
          payload?.mode === 'set' &&
          typeof payload.salt === 'string' &&
          typeof payload.hash === 'string' &&
          /^[0-9a-f]{16,64}$/.test(payload.salt) &&
          /^[0-9a-f]{64}$/.test(payload.hash)
        ) {
          room.pass = { salt: payload.salt.slice(0, 64), hash: payload.hash.slice(0, 64) }
          saveRoomPass(payload.roomId, room.pass) // пароль сразу персистится в БД
          ack?.({ ok: true })
          return
        }
        ack?.({ ok: false, error: 'bad payload' })
      } catch (error) {
        console.error('[vetvi-sync] pass error', error)
        ack?.({ ok: false })
      }
    },
  )

  socket.on('disconnect', () => {
    try {
      if (!joinedRoom) return
      const room = rooms.get(joinedRoom)
      if (!room) return
      room.members.delete(socket.id)
      releaseSocketLocks(io, room, socket.id)
      releaseSocketFocus(io, room, socket.id)
      broadcastUsers(io, room)
      console.log(`[vetvi-sync] leave "${room.name}", peers: ${userList(room).length}`)
      if (room.members.size === 0) scheduleRoomGc(room)
    } catch (error) {
      console.error('[vetvi-sync] disconnect error', error)
    }
  })

  socket.on('error', (error) => {
    console.error(`[vetvi-sync] socket error (${socket.id})`, error)
  })
})

/* ─── запуск ─── */

migrateJsonToSqlite()

console.log(
  `[vetvi-sync] SQLite «${DB_FILE}»: комнат ${(qRoomsCount.get() as { c: number }).c}, merge-заявок ${(qMergesCount.get() as { c: number }).c}`,
)

/* периодическая чистка призраков во всех комнатах — онлайн-счётчик остаётся точным,
   даже если новый join давно не приходил */
setInterval(() => {
  try {
    for (const room of rooms.values()) {
      if (sweepStaleMembers(io, room)) broadcastUsers(io, room)
    }
  } catch (e) {
    console.error('[vetvi-sync] sweep error', e)
  }
}, 60_000)

httpServer.listen(PORT, () => {
  console.log(`[vetvi-sync] server running on port ${PORT}`)
})

process.on('SIGTERM', () => {
  console.log('[vetvi-sync] SIGTERM, shutting down...')
  try {
    db.close() // чекпоинт WAL при закрытии
  } catch {
    // уже закрыта
  }
  httpServer.close(() => process.exit(0))
})

process.on('SIGINT', () => {
  console.log('[vetvi-sync] SIGINT, shutting down...')
  try {
    db.close()
  } catch {
    // уже закрыта
  }
  httpServer.close(() => process.exit(0))
})
