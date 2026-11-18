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
  /* право на редактирование (аккаунт с доступом owner/editor) */
  canEdit?: boolean
}

interface RoomMember {
  socketId: string
  user: UserMeta
  canEdit: boolean
  /* id аккаунта (если вошёл по сессии) — нужен свипу ролей: права
     (owner/editor/reader) могут измениться, пока участник в комнате */
  accId: string | null
  /* роль вошедшего (owner/editor/reader/guest) — нужна при ограничении ссылки:
     когда владелец закрывает ссылку, гости вылетают из комнаты */
  role?: string
}

interface AccInfo {
  id: string
  name: string
  color: string
  login: string
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
  /* доступ по ссылке: off — ссылка закрыта, members — только добавленные
     участники, open — все по ссылке (только чтение). Меняет владелец
     в окне «Поделиться» (vetvi:room-settings), персистится с комнатой. */
  linkMode?: 'off' | 'members' | 'open' | null
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

/* ─── главная БД (аккаунты, сессии, доступы) ───
   Та же SQLite-база, куда пишет Next.js через Prisma (volume web-data,
   в контейнере монтируется в /db — см. docker-compose.yml). Читаем сессии
   при join и доступы (ProjectAccess) для роли/права редактирования.

   Открытие ЛЕНИВОЕ: база лежит в томе web-контейнера и может появиться
   позже первого старта sync (или таблицы в ней создаются init-db'ом уже
   после нас) — если при старте её нет, раньше mainDb навсегда оставался
   null и вся коллаборация считалась «гостями только для чтения». Теперь
   пробуем открыть при каждом обращении, пока не получится; после ошибки
   схемы («no such table») соединение сбрасывается и переоткрывается. */
const MAIN_DB_FILE =
  process.env.VETVI_MAIN_DB || new URL('../../db/custom.db', import.meta.url).pathname
let mainDb: Database | null = null
let mainDbWarnAt = 0
let qSessionRow: ReturnType<Database['prepare']> | null = null
let qAccessRole: ReturnType<Database['prepare']> | null = null
let qAccessCount: ReturnType<Database['prepare']> | null = null

/* предупреждение о недоступной главной БД — не чаще раза в 30 секунд,
   чтобы не заспамить лог, но причина «все гости только для чтения»
   была видна в docker logs сразу */
function warnMainDb(reason: string, e?: unknown): void {
  if (Date.now() - mainDbWarnAt < 30_000) return
  mainDbWarnAt = Date.now()
  console.error(
    `[vetvi-sync] главная БД (${reason}): ${MAIN_DB_FILE}\n` +
      '  → без неё сессии/роли не проверяются, ВСЕ участники комнат — гости только для чтения.\n' +
      '  → проверьте docker-compose.yml: volume web-data:/db в сервисе sync и env VETVI_MAIN_DB=/db/custom.db,\n' +
      '    затем docker compose up -d --force-recreate sync',
    e || '',
  )
}

function openMainDb(): void {
  if (mainDb) return
  /* файла ещё нет — не создаём пустую базу вместо Prisma, попробуем позже */
  if (!existsSync(MAIN_DB_FILE)) {
    warnMainDb('файл не найден')
    return
  }
  try {
    const d = new Database(MAIN_DB_FILE)
    try { d.exec('PRAGMA journal_mode = WAL;') } catch { /* режим уже установлен */ }
    d.exec('PRAGMA busy_timeout = 5000;')
    qSessionRow = d.prepare(
      `SELECT s.userId AS userId, s.expiresAt AS expiresAt,
              a.login AS login, a.displayName AS displayName, a.color AS color
         FROM AuthSession s JOIN AuthUser a ON a.id = s.userId WHERE s.token = ?`,
    )
    qAccessRole = d.prepare('SELECT role FROM ProjectAccess WHERE roomId = ? AND userId = ?')
    qAccessCount = d.prepare('SELECT COUNT(*) AS c FROM ProjectAccess WHERE roomId = ?')
    mainDb = d
    mainDbWarnAt = 0
    console.log('[vetvi-sync] главная БД открыта:', MAIN_DB_FILE)
  } catch (e) {
    warnMainDb('ошибка открытия', e)
  }
}

function dropMainDb(): void {
  try { mainDb?.close() } catch { /* уже закрыта */ }
  mainDb = null
  qSessionRow = null
  qAccessRole = null
  qAccessCount = null
}

/* после «no such table» (база создана, но init-db ещё не отработал)
   соединение бессмысленно — сбрасываем, следующий вызов переоткроет */
function isSchemaError(e: unknown): boolean {
  const msg = String((e as Error)?.message || e)
  return msg.includes('no such table') || msg.includes('no such column')
}

/* сессия действительна? имя/цвет аккаунта всегда берём из БД —
   их больше нельзя менять произвольно. При SQLITE_BUSY — короткий ретрай. */
function verifySession(token: unknown, userId: unknown): AccInfo | null {
  openMainDb()
  if (!mainDb || !qSessionRow || typeof token !== 'string' || !token) return null
  const t = token.slice(0, 128)
  let lastErr: unknown = null
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const row = qSessionRow.get(t) as
        | { userId: string; expiresAt: string | number; login: string; displayName: string | null; color: string }
        | null
      if (!row) return null
      const exp = typeof row.expiresAt === 'number' ? row.expiresAt : Date.parse(String(row.expiresAt))
      if (!Number.isFinite(exp) || exp <= Date.now()) return null
      if (typeof userId === 'string' && userId && userId !== row.userId) return null
      return {
        id: row.userId,
        name: String(row.displayName || row.login || 'Гость').slice(0, 40),
        color: String(row.color || '#8b929c').slice(0, 20),
        login: String(row.login || ''),
      }
    } catch (e) {
      if (isSchemaError(e)) {
        dropMainDb()
        return null // переоткроем (и переподготовим запросы) на следующем вызове
      }
      lastErr = e
      const spin = Date.now() + 60
      while (Date.now() < spin) { /* busy spin */ }
    }
  }
  console.error('[vetvi-sync] session check error', lastErr)
  return null
}

function accessRole(roomId: string, userId: string): 'owner' | 'editor' | 'reader' | null {
  openMainDb()
  if (!mainDb || !qAccessRole) return null
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const row = qAccessRole.get(roomId, userId) as { role: string } | null
      if (row && (row.role === 'owner' || row.role === 'editor' || row.role === 'reader')) return row.role
      return null
    } catch (e) {
      if (isSchemaError(e)) {
        dropMainDb()
        return null
      }
      if (attempt === 2) console.error('[vetvi-sync] access role error', e)
      const spin = Date.now() + 60
      while (Date.now() < spin) { /* busy spin */ }
    }
  }
  return null
}

function accessCount(roomId: string): number {
  openMainDb()
  if (!mainDb || !qAccessCount) return 0
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return (qAccessCount.get(roomId) as { c: number }).c
    } catch (e) {
      if (isSchemaError(e)) {
        dropMainDb()
        return 0
      }
      if (attempt === 2) console.error('[vetvi-sync] access count error', e)
      const spin = Date.now() + 60
      while (Date.now() < spin) { /* busy spin */ }
    }
  }
  return 0
}

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
    pass_hash  TEXT,
    link_mode  TEXT
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

/* миграция существующих БД: колонка link_mode появилась позже — добавляем,
   если её нет (в старых базах таблица rooms уже создана без неё) */
try {
  const cols = db.query("PRAGMA table_info(rooms)").all() as { name: string }[]
  if (!cols.some((c) => c.name === 'link_mode')) {
    db.exec('ALTER TABLE rooms ADD COLUMN link_mode TEXT')
    console.log('[vetvi-sync] rooms: добавлена колонка link_mode')
  }
} catch (e) {
  console.error('[vetvi-sync] миграция link_mode не удалась', e)
}

interface RoomRow {
  id: string
  doc: string | null
  updated_at: string
  pass_salt: string | null
  pass_hash: string | null
  link_mode: string | null
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
  'SELECT id, doc, updated_at, pass_salt, pass_hash, link_mode FROM rooms WHERE id = ?',
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
const qRoomSetLinkMode = db.prepare('UPDATE rooms SET link_mode = ? WHERE id = ?')
/* удаление комнаты с сервера (владелец выключил сетевой режим): вместе с
   комнатой стираются её merge-заявки — в очереди не остаётся мусора */
const qRoomDelete = db.prepare('DELETE FROM rooms WHERE id = ?')
const qMergeDelRoom = db.prepare('DELETE FROM merges WHERE room_id = ?')
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
  if (row.link_mode === 'off' || row.link_mode === 'members' || row.link_mode === 'open') {
    out.linkMode = row.link_mode
  }
  return out
}

function saveRoomLinkMode(roomId: string, mode: 'off' | 'members' | 'open') {
  qRoomSetLinkMode.run(mode, roomId)
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
  /* доступ по ссылке (см. StoredRoom.linkMode) — меняет владелец из окна */
  linkMode: 'off' | 'members' | 'open'
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

function room_members_get(roomName: string, sid: string): RoomMember | null {
  return rooms.get(roomName)?.members.get(sid) || null
}

function getRoom(name: string): RoomState {
  let room = rooms.get(name)
  if (!room) {
    room = { name, members: new Map(), locks: new Map(), focus: new Map(), pass: null, linkMode: 'open', gcTimer: null }
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
    out.push({ ...m.user, canEdit: m.canEdit })
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

/* есть ли живые участники в комнате (до создания RoomState) */
function room_members_count(roomName: string): number {
  return rooms.get(roomName)?.members.size || 0
}

function broadcastUsers(io: Server, room: RoomState) {
  io.to(room.name).emit('vetvi:users', { roomId: room.name, users: userList(room) })
}

/* ─── свип ролей: доступы могут измениться, пока участник онлайн ───
   Владелец выдал/отозвал/поменял роль через окно «Поделиться» — участник
   получает актуальное право редактирования без переподключения сокета:
   каждые 10 секунд перечитываем ProjectAccess и обновляем canEdit. */
const ROLE_SWEEP_MS = 10 * 1000

function sweepRoles(io: Server) {
  for (const room of rooms.values()) {
    if (room.members.size === 0) continue
    let changed = false
    for (const m of room.members.values()) {
      if (!m.accId) continue
      const role = accessRole(room.name, m.accId)
      const canEdit = role === 'owner' || role === 'editor'
      if (canEdit !== m.canEdit) {
        m.canEdit = canEdit
        changed = true
      }
    }
    if (changed) broadcastUsers(io, room)
  }
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
  /* право этого сокета на изменение состояния (роль из join) */
  let canEditSock = false

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
        /* сессия аккаунта: токен + id — имя/цвет берутся из БД */
        token?: string
        userId?: string
        /* тихий rejoin (обновление роли): без «X — в комнате» остальным */
        quiet?: boolean
        /* вошедший публикует локальный проект (переключатель «Общедоступный»):
           может открыть комнату, которой ещё/уже нет на сервере */
        own?: boolean
      },
      ack?: (r: unknown) => void,
    ) => {
      try {
        const roomName = payload?.roomId
        if (!isSafeRoom(roomName)) {
          ack?.({ ok: false, error: 'bad room' })
          return
        }

        /* аккаунт и роль: сессия проверяется по главной БД, доступ — по ProjectAccess.
           Без сессии/доступа — «гость по ссылке»: имя из payload, только чтение. */
        const acc = verifySession(payload?.token, payload?.userId)
        const role = acc ? accessRole(roomName, acc.id) : null
        const canEdit = role === 'owner' || role === 'editor'
        if (process.env.VETVI_DEBUG) {
          console.log(`[vetvi-sync][debug] join "${roomName}" tok=${typeof payload?.token === 'string' ? payload.token.slice(0, 8) : JSON.stringify(payload?.token)} userId=${JSON.stringify(payload?.userId)} acc=${acc ? acc.id : null} role=${role}`)
        }

        /* комната на сервере — это сохранённый документ. Если его НЕТ (комната
           никогда не публиковалась или удалена владельцем при выключении
           сетевого режима), открыть комнату может только тот, кто публикует
           локальный проект (own — переключатель «Общедоступный»). Все остальные
           — гости по ссылке и УЧАСТНИКИ С РОЛЬЮ (они «серые» после выключения)
           получают room_closed: комната удалена — никто не подключается,
           вместо тихого создания пустой комнаты. */
        const storedRoomEarly = getStoredRoom(roomName)
        const ownClaim = payload?.own === true
        if (!storedRoomEarly && room_members_count(roomName) === 0 && !ownClaim) {
          ack?.({ ok: false, error: 'room_closed' })
          return
        }

        const user: UserMeta = acc
          ? { id: acc.id, name: acc.name, color: acc.color }
          : {
              id: String(payload?.user?.id || socket.id),
              name: String(payload?.user?.name || 'Гость').slice(0, 40),
              color: String(payload?.user?.color || '#8b929c').slice(0, 20),
            }

        const room = getRoom(roomName)

        /* пароль комнаты: восстановить из SQLite */
        const storedRoom = storedRoomEarly
        if (!room.pass && storedRoom?.pass?.salt && storedRoom?.pass?.hash) {
          room.pass = { salt: String(storedRoom.pass.salt), hash: String(storedRoom.pass.hash) }
        }
        /* доступ по ссылке: восстановить из SQLite (меняется в окне «Поделиться») */
        if (storedRoom?.linkMode) room.linkMode = storedRoom.linkMode

        const isMember = room.members.has(socket.id)

        /* ограничение ссылки: пользователь БЕЗ записи доступа (гость по ссылке)
           входит только при linkMode = 'open'. Участники с доступом (и legacy-
           комнаты вообще без записей доступов) проходят как раньше. */
        if (!isMember && !role && room.linkMode !== 'open' && accessCount(roomName) > 0) {
          ack?.({
            ok: false,
            error: room.linkMode === 'off' ? 'link_off' : 'members_only',
          })
          return
        }

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

        /* проверка пароля: участник комнаты (rejoin) и пользователи с доступом
           (owner/editor/reader) проходят без повторного ввода */
        if (room.pass && !isMember && !role) {
          const given = typeof payload.password === 'string' ? payload.password : ''
          if (sha256hex(room.pass.salt + ':' + given) !== room.pass.hash) {
            ack?.({ ok: false, error: 'password', needPassword: true })
            return
          }
        }

        joinedRoom = roomName
        canEditSock = canEdit
        socket.join(roomName)
        room.members.set(socket.id, { socketId: socket.id, user, canEdit, accId: acc ? acc.id : null, role: role || 'guest' })

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
          /* роль вошедшего и право на редактирование */
          role: role || 'guest',
          canEdit,
          /* режим доступа по ссылке — его показывает окно «Поделиться» */
          linkMode: room.linkMode,
          /* legacy: в комнате ещё нет ни одной записи доступа — клиент может
             заявить владение (первый перешедший с обновления) */
          legacy: !role && accessCount(roomName) === 0,
        })

        broadcastUsers(io, room)
        /* уведомление остальным: кто вошёл (имя аккаунта + роль) — так в комнате
           сразу видят, кто перешёл по ссылке без доступа. quiet (rejoin для
           обновления роли) — без повторного «X — в комнате». */
        if (!payload?.quiet) {
          socket.to(roomName).emit('vetvi:notice', {
            roomId: roomName,
            kind: 'join',
            user: { id: user.id, name: user.name, color: user.color },
            role: role || 'guest',
            canEdit,
          })
        }
        console.log(
          `[vetvi-sync] join "${roomName}" (${user.name}${role ? ', ' + role : ''}), peers: ${userList(room).length}`,
        )
      } catch (error) {
        console.error('[vetvi-sync] join error', error)
        ack?.({ ok: false, error: 'join failed' })
      }
    },
  )

  /* ── настройки комнаты (доступ по ссылке) — меняет только владелец ──
     linkMode: off — ссылка закрыта, members — по ссылке входят только
     добавленные участники, open — все по ссылке (только чтение). */
  socket.on(
    'vetvi:room-settings',
    (
      msg: { roomId?: string; linkMode?: string },
      ack?: (r: unknown) => void,
    ) => {
      try {
        const roomName = msg?.roomId
        if (!isSafeRoom(roomName) || roomName !== joinedRoom) {
          ack?.({ ok: false, error: 'bad room' })
          return
        }
        const mode = msg?.linkMode
        if (mode !== 'off' && mode !== 'members' && mode !== 'open') {
          ack?.({ ok: false, error: 'bad mode' })
          return
        }
        /* право менять настройки: только владелец комнаты */
        const me = room_members_get(roomName, socket.id)
        const myRole = me && me.accId ? accessRole(roomName, me.accId) : null
        if (myRole !== 'owner') {
          ack?.({ ok: false, error: 'Только владелец может менять настройки ссылки' })
          return
        }
        const room = getRoom(roomName)
        room.linkMode = mode
        try { saveRoomLinkMode(roomName, mode) } catch (e) { console.error('[vetvi-sync] link_mode save error', e) }
        ack?.({ ok: true, linkMode: mode })
        io.to(roomName).emit('vetvi:room-settings', { roomId: roomName, linkMode: mode })
        /* ссылку закрыли для гостей — они покидают комнату немедленно
           (участники с доступом остаются: их право — запись ProjectAccess) */
        if (mode !== 'open') {
          for (const [sid, m] of room.members) {
            if (m.role && m.role !== 'guest') continue
            const sock = io.of('/').sockets.get(sid)
            if (!sock) continue
            sock.emit('vetvi:kicked', { roomId: roomName, reason: mode })
            sock.leave(roomName)
            room.members.delete(sid)
            releaseSocketLocks(io, room, sid)
            releaseSocketFocus(io, room, sid)
          }
          broadcastUsers(io, room)
        }
        console.log(`[vetvi-sync] room "${roomName}" linkMode → ${mode}`)
      } catch (error) {
        console.error('[vetvi-sync] room-settings error', error)
        ack?.({ ok: false, error: 'settings failed' })
      }
    },
  )

  /* ── удаление комнаты с сервера — только владелец ──
     Выключение «Общедоступный» в окне «Поделиться»: документ комнаты и её
     настройки (пароль, режим ссылки) стираются из БД, merge-заявки комнаты
     тоже, все участники выгоняются (в т.ч. по ссылке и из списка проектов).
     Записи ProjectAccess НЕ удаляются: список участников сохраняется — в
     окне владельца они показываются серыми, а при повторной публикации
     снова получают доступ. */
  socket.on(
    'vetvi:room-delete',
    (msg: { roomId?: string }, ack?: (r: unknown) => void) => {
      try {
        const roomName = msg?.roomId
        if (!isSafeRoom(roomName) || roomName !== joinedRoom) {
          ack?.({ ok: false, error: 'bad room' })
          return
        }
        const me = room_members_get(roomName, socket.id)
        const myRole = me && me.accId ? accessRole(roomName, me.accId) : null
        if (myRole !== 'owner') {
          ack?.({ ok: false, error: 'Только владелец может удалить комнату' })
          return
        }
        const room = rooms.get(roomName)
        if (room) {
          /* выгоняем всех, кроме запросившего удаление (он сам закрывает
             соединение сразу после ack — без двойного уведомления) */
          for (const [sid, m] of room.members) {
            if (sid === socket.id) continue
            const sock = io.of('/').sockets.get(sid)
            if (sock) sock.emit('vetvi:kicked', { roomId: roomName, reason: 'closed' })
            releaseSocketLocks(io, room, sid)
            releaseSocketFocus(io, room, sid)
          }
          if (room.gcTimer) {
            clearTimeout(room.gcTimer)
            room.gcTimer = null
          }
          rooms.delete(roomName)
        }
        try {
          qRoomDelete.run(roomName)
          qMergeDelRoom.run(roomName)
        } catch (e) {
          console.error('[vetvi-sync] room delete db error', e)
        }
        ack?.({ ok: true })
        console.log(`[vetvi-sync] room "${roomName}" удалена владельцем`)
      } catch (error) {
        console.error('[vetvi-sync] room-delete error', error)
        ack?.({ ok: false, error: 'delete failed' })
      }
    },
  )

  /* ── снапшот состояния ── */
  socket.on('vetvi:state', (msg: { roomId?: string; doc?: unknown }) => {
    try {
      if (!isSafeRoom(msg?.roomId) || msg.roomId !== joinedRoom) return
      if (!canEditSock) return // только чтение: снапшоты не принимаются
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

  /* ── замена данных комнаты (новая система: прилетает соавторам на сравнение,
        НЕ применяется сразу — клиент показывает блок расхождения) ── */
  socket.on('vetvi:replace', (msg: { roomId?: string; doc?: unknown; by?: { name?: string; color?: string } | null }) => {
    try {
      if (!isSafeRoom(msg?.roomId) || msg.roomId !== joinedRoom) return
      if (!canEditSock) return // только чтение
      const doc = msg.doc as { nodes?: unknown[] } | undefined
      if (!doc || !Array.isArray(doc.nodes)) return
      const json = JSON.stringify(doc)
      if (json.length > MAX_DOC_BYTES) {
        socket.emit('vetvi:error', { message: 'Документ слишком большой для синхронизации' })
        return
      }
      saveRoomDoc(msg.roomId, doc, new Date().toISOString())
      scheduleTrim()
      socket.to(msg.roomId).emit('vetvi:replace', {
        roomId: msg.roomId,
        doc,
        by: msg.by && typeof msg.by === 'object' ? { name: String(msg.by.name || '').slice(0, 40), color: String(msg.by.color || '').slice(0, 20) } : null,
      })
      console.log(`[vetvi-sync] replace in "${msg.roomId}" by ${msg.by?.name || '?'}`)
    } catch (error) {
      console.error('[vetvi-sync] replace error', error)
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
        if (!canEditSock) return // только чтение: live-события не ретранслируются
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
        if (!me.canEdit) {
          ack?.({ ok: true, denied: [] }) // только чтение: локи не выдаются
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
        if (!canEditSock) {
          ack?.({ ok: false, error: 'read only' }) // пароль комнаты меняют только редакторы
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

/* свип ролей: выданные/отозванные/сменённые доступы подхватываются участниками
   в комнате без переподключения (клиент делает тихий rejoin по canEdit) */
setInterval(() => {
  try {
    sweepRoles(io)
  } catch (e) {
    console.error('[vetvi-sync] role sweep error', e)
  }
}, ROLE_SWEEP_MS)

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
