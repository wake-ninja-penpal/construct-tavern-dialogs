/**
 * «Ветви» — синхронизационный сервер (signaling + relay) на socket.io.
 *
 * Реализует протокол синхронизации Yjs (y-protocols/sync) поверх socket.io:
 *  - комнаты по roomId (проект) и `${roomId}::mailbox` (merge-запросы);
 *  - держит in-memory Y.Doc комнаты, чтобы поздние участники получали
 *    полное состояние, даже если создатель временно переподключается;
 *  - ретранслирует awareness (имена/цвета участников) и события входа/выхода.
 *
 * Транспорт: клиент всегда подключается через шлюз: io('/?XTransformPort=3003'),
 * путь socket.io — '/' (требование Caddy-шлюза).
 */

import { createServer } from 'http'
import { Server, type Socket } from 'socket.io'
import * as Y from 'yjs'
import * as syncProtocol from 'y-protocols/sync'
import * as awarenessProtocol from 'y-protocols/awareness'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'

const PORT = 3003
const ROOM_TTL_MS = 30 * 60 * 1000 // держим состояние комнаты 30 минут после ухода всех

const MESSAGE_SYNC = 0
const MESSAGE_AWARENESS = 1

const SYNC_STEP1 = 0
const SYNC_STEP2 = 1
const SYNC_UPDATE = 2

interface RoomMember {
  socketId: string
  yjsClientId: number
  lastAwareness: Uint8Array | null
}

interface RoomState {
  name: string
  doc: Y.Doc
  awareness: awarenessProtocol.Awareness
  members: Map<string, RoomMember>
  gcTimer: ReturnType<typeof setTimeout> | null
}

const rooms = new Map<string, RoomState>()

function getRoom(name: string): RoomState {
  let room = rooms.get(name)
  if (!room) {
    const doc = new Y.Doc()
    const awareness = new awarenessProtocol.Awareness(doc)
    room = { name, doc, awareness, members: new Map(), gcTimer: null }
    rooms.set(name, room)
  }
  if (room.gcTimer) {
    clearTimeout(room.gcTimer)
    room.gcTimer = null
  }
  return room
}

function scheduleRoomGc(room: RoomState) {
  if (room.gcTimer) clearTimeout(room.gcTimer)
  room.gcTimer = setTimeout(() => {
    if (room.members.size === 0) {
      try {
        room.awareness.destroy()
        room.doc.destroy()
      } catch {
        // ignore
      }
      rooms.delete(room.name)
      console.log(`[vetvi-sync] room "${room.name}" reclaimed (idle)`)
    }
  }, ROOM_TTL_MS)
}

/** Полное сообщение (с префиксом messageSync) с update-диффом. */
function encodeSyncUpdateMessage(update: Uint8Array): Uint8Array {
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, MESSAGE_SYNC)
  syncProtocol.writeUpdate(encoder, update)
  return encoding.toUint8Array(encoder)
}

function encodeSyncStep1Message(doc: Y.Doc): Uint8Array {
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, MESSAGE_SYNC)
  syncProtocol.writeSyncStep1(encoder, doc)
  return encoding.toUint8Array(encoder)
}

function encodeAwarenessMessage(rawUpdate: Uint8Array): Uint8Array {
  const encoder = encoding.createEncoder()
  encoding.writeVarUint(encoder, MESSAGE_AWARENESS)
  encoding.writeVarUint8Array(encoder, rawUpdate)
  return encoding.toUint8Array(encoder)
}

function emitPeersCount(io: Server, room: RoomState) {
  io.to(room.name).emit('vetvi:peers', { room: room.name, count: room.members.size })
}

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
  maxHttpBufferSize: 8e6, // merge-запросы и снапшоты могут быть крупными
})

io.on('connection', (socket: Socket) => {
  let joinedRoom: string | null = null

  const isSafeRoom = (room: unknown): room is string =>
    typeof room === 'string' && room.length > 0 && room.length <= 256

  socket.on(
    'vetvi:join',
    (payload: { room?: string; yjsClientId?: number }, ack?: (r: unknown) => void) => {
      try {
        const roomName = payload?.room
        if (!isSafeRoom(roomName)) {
          ack?.({ ok: false, error: 'bad room' })
          return
        }

        joinedRoom = roomName
        const room = getRoom(roomName)
        socket.join(roomName)

        room.members.set(socket.id, {
          socketId: socket.id,
          yjsClientId: Number(payload?.yjsClientId ?? 0),
          lastAwareness: null,
        })

        // 1) Полное состояние комнаты новому участнику.
        socket.emit('vetvi:msg', roomName, encodeSyncUpdateMessage(Y.encodeStateAsUpdate(room.doc)))
        // 2) Просим у нового участника недостающее (если сервер отстал от него).
        socket.emit('vetvi:msg', roomName, encodeSyncStep1Message(room.doc))

        // Просим остальных участников перевыслать awareness и диффы.
        socket.to(roomName).emit('vetvi:peer-joined', { room: roomName, socketId: socket.id })

        // Отправляем новичку известные awareness-состояния остальных.
        for (const member of room.members.values()) {
          if (member.socketId !== socket.id && member.lastAwareness) {
            socket.emit('vetvi:msg', roomName, member.lastAwareness)
          }
        }

        emitPeersCount(io, room)
        console.log(`[vetvi-sync] join "${roomName}" (${socket.id}), peers: ${room.members.size}`)
        ack?.({ ok: true, count: room.members.size })
      } catch (error) {
        console.error('[vetvi-sync] join error', error)
        ack?.({ ok: false, error: 'join failed' })
      }
    },
  )

  socket.on('vetvi:msg', (roomName: unknown, data: unknown) => {
    try {
      if (!isSafeRoom(roomName) || roomName !== joinedRoom) return
      if (!(data instanceof Uint8Array)) {
        console.warn(`[vetvi-sync] некорректный payload от ${socket.id}`)
        return
      }

      const room = rooms.get(roomName)
      if (!room) return

      const decoder = decoding.createDecoder(data)
      const messageType = decoding.readVarUint(decoder)

      if (messageType === MESSAGE_SYNC) {
        const syncType = decoding.readVarUint(decoder)

        if (syncType === SYNC_STEP1) {
          // Участник просит недостающее: отвечаем своим диффом и просим его —
          // взаимная сверка делает цикл синхронизации полным (защита от потерь).
          const stateVector = decoding.readVarUint8Array(decoder)
          const diff = Y.encodeStateAsUpdate(room.doc, stateVector)
          socket.emit('vetvi:msg', roomName, encodeSyncUpdateMessage(diff))
          socket.emit('vetvi:msg', roomName, encodeSyncStep1Message(room.doc))
          return
        }

        if (syncType === SYNC_STEP2 || syncType === SYNC_UPDATE) {
          const update = decoding.readVarUint8Array(decoder)
          // Применяем к документу комнаты и ретранслируем остальным как update.
          Y.applyUpdate(room.doc, update, 'relay')
          socket.to(roomName).emit('vetvi:msg', roomName, encodeSyncUpdateMessage(update))
        }
      } else if (messageType === MESSAGE_AWARENESS) {
        const rawUpdate = decoding.readVarUint8Array(decoder)
        // Сервер отслеживает awareness, чтобы уметь чистить состояния при выходе.
        try {
          awarenessProtocol.applyAwarenessUpdate(room.awareness, rawUpdate, 'remote')
        } catch {
          // ignore malformed awareness
        }

        const member = room.members.get(socket.id)
        if (member) {
          member.lastAwareness = encodeAwarenessMessage(rawUpdate)
        }

        socket.to(roomName).emit('vetvi:msg', roomName, encodeAwarenessMessage(rawUpdate))
      }
    } catch (error) {
      console.error('[vetvi-sync] msg error', error)
    }
  })

  socket.on('disconnect', () => {
    try {
      if (!joinedRoom) return
      const room = rooms.get(joinedRoom)
      if (!room) return

      const member = room.members.get(socket.id)
      room.members.delete(socket.id)

      if (member && member.yjsClientId) {
        try {
          // Помечаем состояние участника как удалённое и раздаём это остальным.
          awarenessProtocol.removeAwarenessStates(room.awareness, [member.yjsClientId], 'disconnect')
          const removal = awarenessProtocol.encodeAwarenessUpdate(room.awareness, [member.yjsClientId])
          socket.to(room.name).emit('vetvi:msg', room.name, encodeAwarenessMessage(removal))
        } catch {
          // ignore
        }
      }

      socket.to(room.name).emit('vetvi:peer-left', { room: room.name, socketId: socket.id })
      emitPeersCount(io, room)
      console.log(`[vetvi-sync] leave "${room.name}" (${socket.id}), peers: ${room.members.size}`)

      if (room.members.size === 0) scheduleRoomGc(room)
    } catch (error) {
      console.error('[vetvi-sync] disconnect error', error)
    }
  })

  socket.on('error', (error) => {
    console.error(`[vetvi-sync] socket error (${socket.id})`, error)
  })
})

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
