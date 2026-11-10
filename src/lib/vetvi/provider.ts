/**
 * Socket.io-провайдер Yjs для «Ветвей».
 *
 * Реализует стандартный протокол синхронизации Yjs (y-protocols/sync)
 * и awareness (y-protocols/awareness) поверх socket.io-транспорта.
 * Эквивалент y-websocket, но через собственный mini-service
 * (порт 3003 через шлюз: io('/?XTransformPort=3003')).
 */

import * as Y from 'yjs'
import * as syncProtocol from 'y-protocols/sync'
import * as awarenessProtocol from 'y-protocols/awareness'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import { io, type Socket } from 'socket.io-client'
import type { ConnectionState } from './types'

const MESSAGE_SYNC = 0
const MESSAGE_AWARENESS = 1

const SYNC_SERVER_URL = '/?XTransformPort=3003'
const JOIN_TIMEOUT_MS = 10000
const RESYNC_INTERVAL_MS = 12000

export interface VetviProviderOptions {
  onStatus?: (status: ConnectionState) => void
  onPeerJoined?: () => void
  onPeerLeft?: () => void
  onJoinAck?: (count: number) => void
  onAwareness?: () => void
}

export class VetviProvider {
  readonly doc: Y.Doc
  readonly awareness: awarenessProtocol.Awareness
  readonly room: string

  private socket: Socket
  private opts: VetviProviderOptions
  private joined = false
  private joinTimer: ReturnType<typeof setTimeout> | null = null
  private resyncInterval: ReturnType<typeof setInterval> | null = null
  private destroyed = false
  private status: ConnectionState = 'connecting'

  private docUpdateHandler = (update: Uint8Array, origin: unknown) => {
    if (origin === this || this.destroyed || !this.joined) return
    this.sendSyncUpdate(update)
  }

  private awarenessChangeHandler = (
    changes: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ) => {
    if (origin === this) {
      // Удалённое изменение — обновим UI.
      this.opts.onAwareness?.()
      return
    }
    const changedClients = [...changes.added, ...changes.updated, ...changes.removed]
    if (!changedClients.includes(this.awareness.clientID)) return
    if (!this.joined) return

    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, MESSAGE_AWARENESS)
    encoding.writeVarUint8Array(
      encoder,
      awarenessProtocol.encodeAwarenessUpdate(this.awareness, [this.awareness.clientID]),
    )
    this.socket.emit('vetvi:msg', this.room, encoding.toUint8Array(encoder))
  }

  constructor(room: string, doc: Y.Doc, opts: VetviProviderOptions = {}) {
    this.room = room
    this.doc = doc
    this.opts = opts

    this.awareness = new awarenessProtocol.Awareness(doc)

    this.socket = io(SYNC_SERVER_URL, {
      // Начинаем сразу с websocket: polling→websocket upgrade в socket.io
      // имеет окно гонки, в котором редкие сообщения могут теряться.
      // Fallback на polling остаётся для сетей с блокировкой websocket —
      // целостность данных обеспечивает периодический re-sync (см. ниже).
      transports: ['websocket', 'polling'],
      forceNew: true,
      reconnection: true,
      reconnectionDelay: 1200,
      reconnectionDelayMax: 6000,
      timeout: 12000,
    })

    this.socket.on('connect', () => {
      this.joinRoom()
    })

    this.socket.on('disconnect', () => {
      this.joined = false
      this.setStatus('offline')
    })

    this.socket.on('connect_error', () => {
      this.setStatus('error')
    })

    this.socket.on('reconnect_attempt', () => {
      if (!this.destroyed) this.setStatus('connecting')
    })

    this.socket.on('vetvi:msg', (roomName: unknown, data: unknown) => {
      if (roomName !== this.room) return
      // Socket.io доставляет бинарные данные как ArrayBuffer в браузере
      // и как Uint8Array/Buffer в Node/Bun — нормализуем.
      let payload: Uint8Array | null = null
      if (data instanceof Uint8Array) payload = data
      else if (data instanceof ArrayBuffer) payload = new Uint8Array(data)
      else if (Array.isArray(data)) payload = Uint8Array.from(data)
      if (!payload) return
      this.handleMessage(payload)
    })

    this.socket.on('vetvi:peer-joined', () => {
      // Перевысылаем свой awareness и дифф состояния (на случай сбоя сервера).
      this.announceLocalAwareness()
      this.sendSyncStep1()
      this.opts.onPeerJoined?.()
    })

    this.socket.on('vetvi:peer-left', () => {
      this.opts.onPeerLeft?.()
    })

    doc.on('update', this.docUpdateHandler)
    this.awareness.on('update', this.awarenessChangeHandler)

    // Страховочный периодический re-sync: Yjs-синхронизация идемпотентна,
    // поэтому потерянные пакеты (гонка upgrade, кратковременные разрывы)
    // восстанавливаются следующим циклом step1→step2.
    this.resyncInterval = setInterval(() => {
      if (this.joined && !this.destroyed) this.sendSyncStep1()
    }, RESYNC_INTERVAL_MS)
  }

  private setStatus(status: ConnectionState) {
    if (this.status === status) return
    this.status = status
    this.opts.onStatus?.(status)
  }

  private joinRoom() {
    if (this.destroyed) return
    this.setStatus('connecting')

    if (this.joinTimer) clearTimeout(this.joinTimer)
    this.joinTimer = setTimeout(() => {
      if (!this.joined && !this.destroyed) this.setStatus('error')
    }, JOIN_TIMEOUT_MS)

    this.socket.emit(
      'vetvi:join',
      { room: this.room, yjsClientId: this.doc.clientID },
      (response: { ok?: boolean; count?: number } | undefined) => {
        if (this.destroyed) return
        if (this.joinTimer) {
          clearTimeout(this.joinTimer)
          this.joinTimer = null
        }
        if (response?.ok) {
          this.joined = true
          this.setStatus('connected')
          this.announceLocalAwareness()
          this.sendSyncStep1()
          this.opts.onJoinAck?.(response.count ?? 1)
        } else {
          this.setStatus('error')
        }
      },
    )
  }

  private announceLocalAwareness() {
    if (this.destroyed || !this.joined) return
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, MESSAGE_AWARENESS)
    encoding.writeVarUint8Array(
      encoder,
      awarenessProtocol.encodeAwarenessUpdate(this.awareness, [this.awareness.clientID]),
    )
    this.socket.emit('vetvi:msg', this.room, encoding.toUint8Array(encoder))
  }

  private sendSyncStep1() {
    if (this.destroyed || !this.joined) return
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, MESSAGE_SYNC)
    syncProtocol.writeSyncStep1(encoder, this.doc)
    this.socket.emit('vetvi:msg', this.room, encoding.toUint8Array(encoder))
  }

  private sendSyncUpdate(update: Uint8Array) {
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, MESSAGE_SYNC)
    syncProtocol.writeUpdate(encoder, update)
    this.socket.emit('vetvi:msg', this.room, encoding.toUint8Array(encoder))
  }

  private handleMessage(data: Uint8Array) {
    try {
      const decoder = decoding.createDecoder(data)
      const messageType = decoding.readVarUint(decoder)

      if (messageType === MESSAGE_SYNC) {
        const responseEncoder = encoding.createEncoder()
        // ВАЖНО: префикс MESSAGE_SYNC добавляет вызывающий — readSyncMessage
        // пишет только тип вложенного sync-сообщения (step1/step2/update).
        encoding.writeVarUint(responseEncoder, MESSAGE_SYNC)
        syncProtocol.readSyncMessage(decoder, responseEncoder, this.doc, this)
        if (encoding.length(responseEncoder) > 1) {
          this.socket.emit('vetvi:msg', this.room, encoding.toUint8Array(responseEncoder))
        }
      } else if (messageType === MESSAGE_AWARENESS) {
        const update = decoding.readVarUint8Array(decoder)
        try {
          awarenessProtocol.applyAwarenessUpdate(this.awareness, update, this)
        } catch {
          // Повреждённый/устаревший awareness-пакет не должен ронять синхронизацию.
        }
      }
    } catch (error) {
      console.warn('vetvi-provider: не удалось обработать сообщение', error)
    }
  }

  destroy() {
    if (this.destroyed) return
    this.destroyed = true

    if (this.joinTimer) clearTimeout(this.joinTimer)
    if (this.resyncInterval) clearInterval(this.resyncInterval)

    try {
      this.doc.off('update', this.docUpdateHandler)
      this.awareness.off('update', this.awarenessChangeHandler)
    } catch {
      // ignore
    }

    try {
      this.awareness.destroy()
    } catch {
      // ignore
    }

    try {
      this.socket.removeAllListeners()
      this.socket.disconnect()
    } catch {
      // ignore
    }
  }
}
