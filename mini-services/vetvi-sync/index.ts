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
 * Персистентность: data/store.json (debounced), переживает перезапуск.
 */

import { createServer } from 'http'
import { createHash } from 'crypto'
import { Server, type Socket } from 'socket.io'
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'fs'

const PORT = 3003
const ROOM_TTL_MS = 60 * 60 * 1000 // освобождаем память через час простоя (состояние уже на диске)
const MAX_DOC_BYTES = 4 * 1024 * 1024
const MAX_MERGE_BYTES = 12 * 1024 * 1024
const MAX_MERGES_PER_ROOM = 60
const MAX_ROOMS = 500
const FLUSH_MS = 600

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

interface StoreShape {
  rooms: Record<string, StoredRoom>
  merges: Record<string, MergeRequest[]>
}

const DATA_DIR = new URL('./data/', import.meta.url).pathname
const DATA_FILE = DATA_DIR + 'store.json'

const store: StoreShape = { rooms: {}, merges: {} }

/* ─── персистентность ─── */

let flushTimer: ReturnType<typeof setTimeout> | null = null

function schedulePersist() {
  if (flushTimer) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    try {
      mkdirSync(DATA_DIR, { recursive: true })
      const tmp = DATA_FILE + '.tmp'
      writeFileSync(tmp, JSON.stringify(store))
      renameSync(tmp, DATA_FILE)
    } catch (e) {
      console.error('[vetvi-sync] persist error', e)
    }
  }, FLUSH_MS)
}

function loadPersist() {
  try {
    const raw = readFileSync(DATA_FILE, 'utf8')
    const parsed = JSON.parse(raw) as StoreShape
    if (parsed && typeof parsed === 'object') {
      store.rooms = parsed.rooms || {}
      store.merges = parsed.merges || {}
      console.log(
        `[vetvi-sync] загружено комнат: ${Object.keys(store.rooms).length}, merge-комнат: ${Object.keys(store.merges).length}`,
      )
    }
  } catch {
    // первый запуск или пустой файл
  }
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

/* ─── merge mailbox ─── */

function mergesOf(roomId: string): MergeRequest[] {
  if (!store.merges[roomId]) store.merges[roomId] = []
  return store.merges[roomId]
}

function pendingCount(roomId: string): number {
  return mergesOf(roomId).filter((r) => r.status === 'pending').length
}

function trimRooms() {
  const ids = Object.keys(store.rooms)
  if (ids.length <= MAX_ROOMS) return
  ids
    .sort((a, b) => (store.rooms[a].updatedAt < store.rooms[b].updatedAt ? -1 : 1))
    .slice(0, ids.length - MAX_ROOMS)
    .forEach((id) => delete store.rooms[id])
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

        /* пароль комнаты: восстановить из персистентного хранилища */
        const storedRoom = store.rooms[roomName]
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
            schedulePersist()
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

        const stored = store.rooms[roomName] || null
        ack?.({
          ok: true,
          count: userList(room).length,
          doc: stored ? stored.doc : null,
          updatedAt: stored ? stored.updatedAt : null,
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
      store.rooms[msg.roomId] = { doc, updatedAt: new Date().toISOString() }
      trimRooms()
      schedulePersist()
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
        const list = mergesOf(roomId)
        // повторная отправка из той же копии обновляет существующую заявку
        const prevIdx = list.findIndex(
          (r) => r.copyId === entry.copyId && r.status === 'pending',
        )
        if (prevIdx >= 0) list.splice(prevIdx, 1)
        list.unshift(entry)
        while (list.length > MAX_MERGES_PER_ROOM) list.pop()
        schedulePersist()
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
        ack?.({ ok: true, requests: mergesOf(roomId), pending: pendingCount(roomId) })
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
        const entry = mergesOf(roomId).find((r) => r.id === requestId)
        if (!entry) {
          ack?.({ ok: false, error: 'merge not found' })
          return
        }
        entry.status = decision
        schedulePersist()
        io.to(roomId).emit('vetvi:merge-decision', {
          roomId,
          requestId,
          status: decision,
          copyId: entry.copyId,
        })
        console.log(`[vetvi-sync] merge "${requestId}" → ${decision}`)
        ack?.({ ok: true, status: entry.status })
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
        const ids = (payload?.ids || []).map(String).filter(Boolean)
        const statuses: Record<string, string> = {}
        for (const list of Object.values(store.merges)) {
          for (const r of list) {
            if (ids.includes(r.id)) statuses[r.id] = r.status
          }
        }
        ack?.({ ok: true, statuses })
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
          schedulePersist()
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
          schedulePersist()
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

loadPersist()

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
  httpServer.close(() => process.exit(0))
})

process.on('SIGINT', () => {
  console.log('[vetvi-sync] SIGINT, shutting down...')
  httpServer.close(() => process.exit(0))
})
