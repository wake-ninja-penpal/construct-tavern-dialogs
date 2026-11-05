'use client'

/**
 * VetviStore — единый слой состояния «Ветвей» (ТЗ, Этап 1: adapter layer).
 *
 * Все изменения данных проходят через этот класс:
 *   UI  <->  VetviStore  <->  Yjs document  <->  (socket.io provider | IndexedDB)
 *
 * Подписка: subscribe(listener) + getSnapshot() — совместимо с useSyncExternalStore.
 */

import * as Y from 'yjs'
import { VetviProvider } from './provider'
import {
  base64ToUint8,
  ensureProjectSkeleton,
  exportProjectToJson,
  importProjectFromJson,
  uid,
  uint8ToBase64,
  upsertRecord,
  deleteRecord,
  validateProjectJson,
  yValueToPlain,
} from './yjs-model'
import {
  addProjectId,
  deleteBackup,
  deleteCopy,
  getBackupUpdate,
  getCopy,
  getOutbox,
  getProjectUpdate,
  listBackups,
  listCopies,
  saveBackup,
  saveCopy,
  saveOutbox,
  saveProjectUpdate,
} from './idb'
import { applyDelta, computeDelta, deltaStats, isDeltaEmpty } from './merge'
import {
  SCHEMA_VERSION,
  type BackupMeta,
  type CopyMeta,
  type CopyRecord,
  type ElementType,
  type MergeRequest,
  type PeerInfo,
  type ProjectMeta,
  type SaveState,
  type ToastKind,
  type VetviMode,
  type ConnectionState,
  type ElementRecord,
  type VetviSnapshot,
} from './types'

const USER_COLORS = ['#7c5cff', '#4cc9f0', '#2ecc71', '#f5a623', '#ff5a5f', '#ff6ec7', '#9ece6a', '#e0af68']

const LS_USER_ID = 'vetvi:userId'
const LS_USER_NAME = 'vetvi:userName'
const LS_LAST_PROJECT = 'vetvi:lastProjectId'

const NOTIFY_DEBOUNCE_MS = 60

function safeLocalStorage(): Storage | null {
  try {
    if (typeof window !== 'undefined' && window.localStorage) return window.localStorage
  } catch {
    // ignore
  }
  return null
}

function randomId(len = 24): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789'
  const bytes = new Uint8Array(len)
  if (typeof crypto !== 'undefined' && 'getRandomValues' in crypto) {
    crypto.getRandomValues(bytes)
  } else {
    for (let i = 0; i < len; i++) bytes[i] = Math.floor(Math.random() * 256)
  }
  return Array.from(bytes)
    .map((b) => alphabet[b % alphabet.length])
    .join('')
}

function readHashParams(): URLSearchParams {
  if (typeof window === 'undefined') return new URLSearchParams()
  return new URLSearchParams(window.location.hash.replace(/^#/, ''))
}

function writeHashParams(paramsObject: Record<string, string | null>) {
  if (typeof window === 'undefined') return
  const params = readHashParams()
  for (const [key, value] of Object.entries(paramsObject)) {
    if (!value) params.delete(key)
    else params.set(key, value)
  }
  const hash = params.toString()
  const newUrl = `${window.location.pathname}${window.location.search}${hash ? `#${hash}` : ''}`
  try {
    window.history.replaceState(null, '', newUrl)
  } catch {
    window.location.hash = hash
  }
}

export class VetviStore {
  private ydoc: Y.Doc | null = null
  private provider: VetviProvider | null = null
  private mailboxDoc: Y.Doc | null = null
  private mailboxProvider: VetviProvider | null = null
  private mailboxRoomId: string | null = null

  private projectId: string | null = null
  private roomId: string | null = null
  private mode: VetviMode = 'project'
  private copyMeta: CopyMeta | null = null
  private currentCopyRecord: CopyRecord | null = null

  private selectedId: string | null = null
  private connection: ConnectionState = 'offline'
  private mailboxConnection: ConnectionState = 'offline'
  private saveState: SaveState = 'saved'

  private userId = ''
  private userName = ''
  private userColor = USER_COLORS[0]

  private copies: CopyMeta[] = []
  private outbox: MergeRequest[] = []
  private backups: BackupMeta[] = []
  private shareUrl: string | null = null

  private ready = false
  private bootstrapped = false
  private snapshot: VetviSnapshot
  private listeners = new Set<() => void>()
  private notifyTimer: ReturnType<typeof setTimeout> | null = null
  private autoSaveTimer: ReturnType<typeof setTimeout> | null = null
  private textTimer: ReturnType<typeof setTimeout> | null = null

  /** Колбэк для toast-уведомлений (назначается UI). */
  onToast: ((message: string, kind?: ToastKind) => void) | null = null

  constructor() {
    this.snapshot = this.buildSnapshot()
  }

  // ---------------------------
  // Подписка / снапшот
  // ---------------------------

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  getSnapshot = (): VetviSnapshot => this.snapshot

  private toast(message: string, kind: ToastKind = 'ok') {
    this.onToast?.(message, kind)
  }

  private notify(live = false) {
    if (live) {
      if (this.notifyTimer) {
        clearTimeout(this.notifyTimer)
        this.notifyTimer = null
      }
      this.rebuildAndEmit()
      return
    }
    if (this.notifyTimer) return
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = null
      this.rebuildAndEmit()
    }, NOTIFY_DEBOUNCE_MS)
  }

  private rebuildAndEmit() {
    this.snapshot = this.buildSnapshot()
    this.listeners.forEach((listener) => listener())
  }

  private buildSnapshot(): VetviSnapshot {
    const doc = this.ydoc

    let meta: ProjectMeta | null = null
    const elements: ElementRecord[] = []

    if (doc) {
      const metaPlain = yValueToPlain(doc.getMap('meta')) as Record<string, unknown>
      meta = {
        projectId: String(metaPlain.projectId ?? this.projectId ?? ''),
        name: String(metaPlain.name ?? ''),
        schemaVersion: Number(metaPlain.schemaVersion ?? SCHEMA_VERSION),
        createdAt: Number(metaPlain.createdAt ?? 0),
        updatedAt: Number(metaPlain.updatedAt ?? 0),
      }

      doc.getMap('elements').forEach((value, id) => {
        const rec = yValueToPlain(value) as Record<string, unknown>
        elements.push({
          id,
          type: (rec.type as ElementType) ?? 'text',
          x: Number(rec.x ?? 0),
          y: Number(rec.y ?? 0),
          width: Number(rec.width ?? 220),
          height: Number(rec.height ?? 120),
          text: String(rec.text ?? ''),
          createdAt: Number(rec.createdAt ?? 0),
          updatedAt: Number(rec.updatedAt ?? 0),
        })
      })

      elements.sort(
        (a, b) => (a.createdAt || 0) - (b.createdAt || 0) || a.id.localeCompare(b.id),
      )
    }

    const peers: PeerInfo[] = []
    const activeProvider = this.provider ?? this.mailboxProvider
    if (activeProvider) {
      activeProvider.awareness.getStates().forEach((state, clientId) => {
        const user = (state as { user?: { name?: string; color?: string } } | undefined)?.user
        peers.push({
          clientId,
          name: user?.name || `Участник ${String(clientId).slice(-4)}`,
          color: user?.color || '#9aa0a6',
          isSelf: clientId === activeProvider.awareness.clientID,
        })
      })
      peers.sort((a, b) => (a.isSelf ? -1 : b.isSelf ? 1 : a.clientId - b.clientId))
    }

    const connection = this.mode === 'copy' ? this.mailboxConnection : this.connection

    return {
      ready: this.ready,
      mode: this.mode,
      meta,
      elements,
      selectedId: this.selectedId,
      connection,
      roomActive: this.provider !== null,
      mailboxActive: this.mailboxProvider !== null,
      peers,
      peersCount: peers.length,
      copies: this.copies,
      incoming: this.mode === 'project' ? this.readIncoming() : [],
      outgoing: this.outbox.filter((r) =>
        this.copyMeta ? r.copyId === this.copyMeta.copyId : false,
      ),
      backups: this.backups,
      shareUrl: this.shareUrl,
      roomId: this.roomId,
      copyMeta: this.copyMeta,
      saveState: this.saveState,
      userName: this.userName,
      userColor: this.userColor,
    }
  }

  private readIncoming(): MergeRequest[] {
    if (!this.mailboxDoc) return []
    const requestsMap = this.mailboxDoc.getMap('requests')
    const requests: MergeRequest[] = []
    requestsMap.forEach((value, id) => {
      const plain = yValueToPlain(value) as Record<string, unknown> | null
      if (!plain) return
      requests.push({
        id: String(plain.id ?? id),
        senderId: String(plain.senderId ?? ''),
        senderName: String(plain.senderName ?? 'Неизвестный'),
        copyId: String(plain.copyId ?? ''),
        sourceRoomId: plain.sourceRoomId ? String(plain.sourceRoomId) : null,
        createdAt: Number(plain.createdAt ?? 0),
        delta: (plain.delta ?? {}) as MergeRequest['delta'],
        stats: (plain.stats ?? { added: 0, updated: 0, deleted: 0 }) as MergeRequest['stats'],
        status: (plain.status as MergeRequest['status']) ?? 'pending',
      })
    })
    requests.sort((a, b) => b.createdAt - a.createdAt)
    return requests
  }

  // ---------------------------
  // Bootstrap / маршрутизация
  // ---------------------------

  async bootstrap() {
    if (this.bootstrapped || typeof window === 'undefined') return
    this.bootstrapped = true

    const storage = safeLocalStorage()
    this.userId = storage?.getItem(LS_USER_ID) || uid()
    storage?.setItem(LS_USER_ID, this.userId)

    this.userName = storage?.getItem(LS_USER_NAME) || `Гость-${this.userId.slice(0, 4)}`
    storage?.setItem(LS_USER_NAME, this.userName)

    let colorIndex = 0
    for (let i = 0; i < this.userId.length; i++) colorIndex += this.userId.charCodeAt(i)
    this.userColor = USER_COLORS[colorIndex % USER_COLORS.length]

    await this.routeFromHash(readHashParams())

    this.ready = true

    window.addEventListener('hashchange', () => {
      void this.handleHashChange()
    })

    this.rebuildAndEmit()
  }

  private async handleHashChange() {
    const params = readHashParams()
    const room = params.get('room')
    const copyId = params.get('copy')

    if (room && room !== this.roomId) {
      await this.routeFromHash(params)
      return
    }
    if (copyId && this.copyMeta?.copyId !== copyId) {
      await this.routeFromHash(params)
      return
    }
    if (!room && !copyId && (this.roomId || this.copyMeta)) {
      await this.routeFromHash(params)
    }
  }

  private async routeFromHash(params: URLSearchParams) {
    const room = params.get('room')
    const project = params.get('project')
    const copyId = params.get('copy')

    if (copyId) {
      const record = await getCopy(copyId)
      if (record) {
        await this.openCopy(copyId)
        return
      }
    }

    if (room) {
      const projectId = project || uid()
      await this.openProject(projectId, { name: project ? 'Проект' : 'Проект из комнаты' })
      this.connectRoom(room)
      writeHashParams({ room, project: projectId, copy: null })
      return
    }

    // Без параметров — последний локальный проект или новый.
    const storage = safeLocalStorage()
    const last = storage?.getItem(LS_LAST_PROJECT)
    if (last && (await getProjectUpdate(last))) {
      await this.openProject(last)
      return
    }

    await this.newProject({ silent: true })
  }

  // ---------------------------
  // Проекты
  // ---------------------------

  async newProject(options: { silent?: boolean } = {}) {
    this.cleanupDoc()
    const projectId = uid()
    await this.createDoc(projectId, 'Новый проект')
    writeHashParams({ room: null, project: null, copy: null })
    safeLocalStorage()?.setItem(LS_LAST_PROJECT, projectId)
    this.mode = 'project'
    this.copyMeta = null
    this.ready = true
    if (!options.silent) this.toast('Создан новый проект')
    this.notify(true)
  }

  private async createDoc(projectId: string, name: string) {
    const doc = new Y.Doc()
    this.ydoc = doc
    this.projectId = projectId

    const saved = await getProjectUpdate(projectId)
    if (saved) {
      try {
        Y.applyUpdate(doc, saved, 'idb-load')
      } catch (error) {
        console.warn('Не удалось загрузить проект из IndexedDB', error)
      }
    }

    ensureProjectSkeleton(doc, projectId, name)
    await addProjectId(projectId)

    doc.on('update', () => this.notify())
    this.scheduleSave()
  }

  async openProject(projectId: string, options: { name?: string } = {}) {
    this.cleanupDoc()
    await this.createDoc(projectId, options.name ?? 'Новый проект')
    safeLocalStorage()?.setItem(LS_LAST_PROJECT, projectId)
    this.mode = 'project'
    this.copyMeta = null
    this.notify(true)
  }

  private cleanupDoc() {
    this.disconnectRoom()

    if (this.autoSaveTimer) {
      clearTimeout(this.autoSaveTimer)
      this.autoSaveTimer = null
    }
    if (this.textTimer) {
      clearTimeout(this.textTimer)
      this.textTimer = null
    }

    try {
      this.ydoc?.destroy()
    } catch {
      // ignore
    }
    this.ydoc = null
    this.selectedId = null
    this.saveState = 'saved'
  }

  private scheduleSave() {
    if (this.autoSaveTimer) clearTimeout(this.autoSaveTimer)
    this.saveState = 'saving'
    this.autoSaveTimer = setTimeout(async () => {
      this.autoSaveTimer = null
      const doc = this.ydoc
      if (!doc) return
      try {
        const update = Y.encodeStateAsUpdate(doc)
        if (this.mode === 'copy' && this.currentCopyRecord) {
          await saveCopy({
            ...this.currentCopyRecord,
            snapshotUpdate: uint8ToBase64(update),
            meta: { ...this.currentCopyRecord.meta, lastOpenedAt: Date.now() },
          })
        } else if (this.projectId) {
          await saveProjectUpdate(this.projectId, update)
        }
        this.saveState = 'saved'
        this.notify()
      } catch (error) {
        console.warn('AutoSave error', error)
        this.saveState = 'saved'
      }
    }, 400)
  }

  setProjectName(name: string) {
    const doc = this.ydoc
    if (!doc) return
    doc.transact(() => {
      doc.getMap('meta').set('name', name)
      doc.getMap('meta').set('updatedAt', Date.now())
    }, 'set-project-name')
    this.notify()
  }

  setUserName(name: string) {
    const trimmed = name.trim() || this.userName
    this.userName = trimmed
    safeLocalStorage()?.setItem(LS_USER_NAME, trimmed)
    this.mailboxProvider?.awareness.setLocalStateField('user', {
      name: trimmed,
      color: this.userColor,
    })
    this.provider?.awareness.setLocalStateField('user', {
      name: trimmed,
      color: this.userColor,
    })
    this.notify(true)
  }

  // ---------------------------
  // Элементы
  // ---------------------------

  addElement(type: ElementType, position?: { x: number; y: number }) {
    const doc = this.ydoc
    if (!doc) return
    const now = Date.now()
    const id = uid()
    const count = doc.getMap('elements').size
    const fallback = { x: 140 + (count % 6) * 36, y: 120 + (count % 6) * 32 }

    upsertRecord(doc, 'elements', {
      id,
      type,
      x: position?.x ?? fallback.x,
      y: position?.y ?? fallback.y,
      width: 220,
      height: 120,
      text: '',
      createdAt: now,
      updatedAt: now,
    })

    this.selectedId = id
    this.notify(true)
  }

  updateElement(id: string, patch: Partial<Omit<ElementRecord, 'id'>>, live = false) {
    const doc = this.ydoc
    if (!doc) return
    const existingValue = doc.getMap('elements').get(id)
    if (!(existingValue instanceof Y.Map)) return
    const existing = yValueToPlain(existingValue) as Record<string, unknown>

    upsertRecord(doc, 'elements', {
      ...existing,
      ...patch,
      id,
      updatedAt: Date.now(),
    })
    this.scheduleSave()
    this.notify(live)
  }

  deleteElement(id: string) {
    const doc = this.ydoc
    if (!doc) return
    deleteRecord(doc, 'elements', id)
    if (this.selectedId === id) this.selectedId = null
    this.scheduleSave()
    this.notify(true)
  }

  selectElement(id: string | null) {
    if (this.selectedId === id) return
    this.selectedId = id
    this.notify(true)
  }

  // ---------------------------
  // Realtime-комната
  // ---------------------------

  async share(): Promise<string | null> {
    if (this.mode === 'copy') {
      this.toast('Это локальная копия — поделиться ссылкой нельзя', 'warn')
      return null
    }
    if (!this.ydoc || !this.projectId) return null

    if (this.roomId && this.provider) {
      this.copyShareLink()
      return this.shareUrl
    }

    const room = randomId(24)
    this.connectRoom(room)
    writeHashParams({ room, project: this.projectId, copy: null })
    this.toast('Комната открыта — отправьте ссылку соавтору')
    this.notify(true)
    return this.shareUrl
  }

  private connectRoom(room: string) {
    this.disconnectRoom()
    if (!this.ydoc) return

    this.roomId = room

    this.provider = new VetviProvider(room, this.ydoc, {
      onStatus: (status) => {
        this.connection = status
        this.notify(true)
      },
      onPeerJoined: () => {
        this.toast('Участник подключился к проекту')
        this.notify(true)
      },
      onPeerLeft: () => {
        this.notify(true)
      },
      onAwareness: () => this.notify(true),
      onJoinAck: () => {
        this.notify(true)
      },
    })

    this.provider.awareness.setLocalStateField('user', {
      name: this.userName,
      color: this.userColor,
    })

    this.shareUrl = this.buildShareUrl(room, this.projectId ?? '')

    // Владелец/участник слушает merge-mailbox оригинала.
    this.connectMailbox(`${room}::mailbox`)
  }

  disconnectRoom() {
    if (this.provider) {
      try {
        this.provider.destroy()
      } catch {
        // ignore
      }
      this.provider = null
    }
    this.disconnectMailbox()
    this.roomId = null
    this.shareUrl = null
    this.connection = 'offline'
  }

  private buildShareUrl(room: string, projectId: string): string {
    if (typeof window === 'undefined') return ''
    const params = new URLSearchParams({ room, project: projectId })
    return `${window.location.origin}${window.location.pathname}#${params.toString()}`
  }

  async copyShareLink(): Promise<boolean> {
    const url = this.shareUrl ?? (this.roomId ? this.buildShareUrl(this.roomId, this.projectId ?? '') : null)
    if (!url) {
      this.toast('Сначала откройте доступ («Поделиться»)', 'warn')
      return false
    }
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(url)
      } else {
        const textarea = document.createElement('textarea')
        textarea.value = url
        textarea.style.position = 'fixed'
        textarea.style.opacity = '0'
        document.body.appendChild(textarea)
        textarea.select()
        document.execCommand('copy')
        textarea.remove()
      }
      this.toast('Ссылка скопирована')
      return true
    } catch {
      this.toast('Не удалось скопировать — скопируйте вручную', 'warn')
      return false
    }
  }

  // ---------------------------
  // Mailbox (merge-комната)
  // ---------------------------

  private connectMailbox(mailboxRoom: string) {
    this.disconnectMailbox()
    this.mailboxRoomId = mailboxRoom
    this.mailboxDoc = new Y.Doc()

    this.mailboxDoc.getMap('requests').observe(() => {
      this.syncOutboxStatuses()
      this.notify()
    })

    this.mailboxProvider = new VetviProvider(mailboxRoom, this.mailboxDoc, {
      onStatus: (status) => {
        this.mailboxConnection = status
        if (status === 'connected') void this.retryOutbox()
        this.notify(true)
      },
      onAwareness: () => this.notify(true),
      onJoinAck: () => {
        void this.retryOutbox()
      },
    })

    this.mailboxProvider.awareness.setLocalStateField('user', {
      name: this.userName,
      color: this.userColor,
    })
  }

  private disconnectMailbox() {
    if (this.mailboxProvider) {
      try {
        this.mailboxProvider.destroy()
      } catch {
        // ignore
      }
      this.mailboxProvider = null
    }
    if (this.mailboxDoc) {
      try {
        this.mailboxDoc.destroy()
      } catch {
        // ignore
      }
      this.mailboxDoc = null
    }
    this.mailboxRoomId = null
    this.mailboxConnection = 'offline'
  }

  // ---------------------------
  // Копии
  // ---------------------------

  async refreshCopies() {
    const records = await listCopies()
    this.copies = records.map((r) => r.meta)
    this.notify()
  }

  async makeCopy(): Promise<boolean> {
    const doc = this.ydoc
    if (!doc) return false

    if (this.mode === 'copy') {
      this.toast('Уже открыта копия — создавать вложенную копию нельзя', 'warn')
      return false
    }

    try {
      const snapshotUpdate = Y.encodeStateAsUpdate(doc)
      const baseState = exportProjectToJson(doc).data as unknown as CopyRecord['baseState']
      const copyId = uid()
      const meta: CopyMeta = {
        copyId,
        name: `${(this.snapshot.meta?.name || 'Проект')} — копия`,
        sourceProjectId: this.projectId ?? '',
        sourceRoomId: this.roomId,
        createdAt: Date.now(),
        lastOpenedAt: Date.now(),
      }
      const record: CopyRecord = {
        meta,
        snapshotUpdate: uint8ToBase64(snapshotUpdate),
        baseState,
      }
      await saveCopy(record)
      await this.refreshCopies()
      this.toast('Копия сохранена локально')
      return true
    } catch (error) {
      console.error('makeCopy failed', error)
      this.toast('Не удалось создать копию', 'error')
      return false
    }
  }

  async openCopy(copyId: string) {
    const record = await getCopy(copyId)
    if (!record) {
      this.toast('Копия не найдена', 'error')
      return
    }

    this.cleanupDoc()

    const doc = new Y.Doc()
    this.ydoc = doc
    this.projectId = record.meta.sourceProjectId || copyId
    this.mode = 'copy'
    this.copyMeta = record.meta
    this.currentCopyRecord = record

    try {
      Y.applyUpdate(doc, base64ToUint8(record.snapshotUpdate), 'copy-load')
    } catch (error) {
      console.warn('Не удалось загрузить копию', error)
    }

    ensureProjectSkeleton(doc, this.projectId, record.meta.name)
    doc.on('update', () => this.notify())
    this.scheduleSave()

    writeHashParams({ room: null, project: null, copy: copyId })

    if (record.meta.sourceRoomId) {
      this.connectMailbox(`${record.meta.sourceRoomId}::mailbox`)
    }

    await Promise.all([this.refreshCopies(), this.refreshOutbox()])
    this.toast(`Открыта копия: ${record.meta.name}`)
    this.notify(true)
  }

  async deleteCopy(copyId: string) {
    if (this.copyMeta?.copyId === copyId) {
      this.toast('Нельзя удалить открытую копию', 'warn')
      return
    }
    await deleteCopy(copyId)
    await this.refreshCopies()
    this.toast('Копия удалена')
  }

  /** Вернуться из копии к оригиналу (если он есть локально) или к последнему проекту. */
  async exitCopy() {
    const sourceProjectId = this.copyMeta?.sourceProjectId
    const storage = safeLocalStorage()
    const last = storage?.getItem(LS_LAST_PROJECT)

    const target =
      (sourceProjectId && (await getProjectUpdate(sourceProjectId)) ? sourceProjectId : null) ??
      (last && (await getProjectUpdate(last)) ? last : null)

    writeHashParams({ room: null, project: null, copy: null })

    if (target) {
      await this.openProject(target)
    } else {
      await this.newProject()
    }
  }

  // ---------------------------
  // Merge
  // ---------------------------

  async refreshOutbox() {
    this.outbox = await getOutbox()
    this.notify()
  }

  private persistOutbox() {
    void saveOutbox(this.outbox)
  }

  async sendMerge(): Promise<boolean> {
    const doc = this.ydoc
    if (!doc || this.mode !== 'copy' || !this.copyMeta) {
      this.toast('Merge доступен только из копии', 'warn')
      return false
    }

    if (!this.copyMeta.sourceRoomId) {
      this.toast('У копии нет комнаты оригинала — используйте экспорт JSON', 'error')
      return false
    }

    try {
      const current = exportProjectToJson(doc).data as unknown as CopyRecord['baseState']
      const base = this.currentCopyRecord?.baseState ?? ({} as CopyRecord['baseState'])
      const delta = computeDelta(this.copyMeta.sourceProjectId, base, current)

      if (isDeltaEmpty(delta)) {
        this.toast('Нет изменений для merge — копия совпадает с базой', 'warn')
        return false
      }

      const request: MergeRequest = {
        id: uid(),
        senderId: this.userId,
        senderName: this.userName,
        copyId: this.copyMeta.copyId,
        sourceRoomId: this.copyMeta.sourceRoomId,
        createdAt: Date.now(),
        delta,
        stats: deltaStats(delta),
        status: this.mailboxProvider ? 'sent' : 'queued',
      }

      if (this.mailboxProvider && this.mailboxDoc) {
        this.mailboxDoc.transact(() => {
          this.mailboxDoc!.getMap('requests').set(request.id, request)
        }, 'merge-send')
      }

      this.outbox = [request, ...this.outbox.filter((r) => r.id !== request.id)]
      this.persistOutbox()

      if (request.status === 'queued') {
        this.toast('Владелец офлайн — merge-запрос в очереди, отправим при подключении', 'warn')
      } else {
        this.toast(`Merge-запрос отправлен (+${request.stats.added} / ~${request.stats.updated} / −${request.stats.deleted})`)
      }
      this.notify(true)
      return true
    } catch (error) {
      console.error('sendMerge failed', error)
      this.toast('Не удалось отправить merge-запрос', 'error')
      return false
    }
  }

  private async retryOutbox() {
    const queued = this.outbox.filter((r) => r.status === 'queued')
    if (!queued.length) return
    if (!this.mailboxProvider || !this.mailboxDoc) return

    for (const request of queued) {
      try {
        this.mailboxDoc.transact(() => {
          this.mailboxDoc!.getMap('requests').set(request.id, request)
        }, 'merge-retry')
        request.status = 'sent'
      } catch (error) {
        console.warn('retryOutbox failed', error)
        request.status = 'failed'
      }
    }
    this.persistOutbox()
    if (queued.some((r) => r.status === 'sent')) {
      this.toast('Отложенные merge-запросы отправлены')
    }
    this.notify(true)
  }

  private syncOutboxStatuses() {
    if (!this.mailboxDoc) return
    const requestsMap = this.mailboxDoc.getMap('requests')
    let changed = false

    for (const item of this.outbox) {
      const remote = requestsMap.get(item.id)
      if (!remote) continue
      const plain = yValueToPlain(remote) as Record<string, unknown>
      const status = plain.status as MergeRequest['status']
      if (status && status !== item.status && (status === 'applied' || status === 'rejected')) {
        item.status = status
        changed = true
        if (status === 'applied') {
          this.toast('Владелец принял ваш merge-запрос')
        } else {
          this.toast('Владелец отклонил ваш merge-запрос', 'warn')
        }
      }
    }

    if (changed) this.persistOutbox()
  }

  async acceptMerge(requestId: string) {
    if (!this.ydoc || !this.mailboxDoc) {
      this.toast('Merge-комната не подключена', 'error')
      return
    }

    const remote = this.mailboxDoc.getMap('requests').get(requestId)
    if (!remote) {
      this.toast('Merge-запрос не найден', 'error')
      return
    }

    const plain = yValueToPlain(remote) as Record<string, unknown>
    const delta = (plain.delta ?? {}) as MergeRequest['delta']
    const senderName = String(plain.senderName ?? 'Неизвестный')

    try {
      // FR-11: backup перед применением.
      const backupId = uid()
      const backupMeta: BackupMeta = {
        id: backupId,
        projectId: this.projectId ?? 'unknown',
        createdAt: Date.now(),
        label: `Перед merge от ${senderName}`,
      }
      await saveBackup(backupMeta, Y.encodeStateAsUpdate(this.ydoc!))
      await this.refreshBackups()

      applyDelta(this.ydoc!, delta)
      this.scheduleSave()

      this.mailboxDoc.transact(() => {
        const existing = this.mailboxDoc!.getMap('requests').get(requestId)
        if (existing instanceof Y.Map) {
          existing.set('status', 'applied')
        } else {
          this.mailboxDoc!.getMap('requests').set(requestId, { ...plain, status: 'applied' })
        }
      }, 'merge-accept')

      this.toast(`Merge от ${senderName} применён (создан backup)`)
      this.notify(true)
    } catch (error) {
      console.error('acceptMerge failed', error)
      this.toast('Ошибка применения merge-запроса', 'error')
    }
  }

  async rejectMerge(requestId: string) {
    if (!this.mailboxDoc) return
    try {
      const plain = yValueToPlain(this.mailboxDoc.getMap('requests').get(requestId)) as
        | Record<string, unknown>
        | undefined
      if (!plain) {
        this.toast('Merge-запрос не найден', 'error')
        return
      }
      this.mailboxDoc.transact(() => {
        const existing = this.mailboxDoc!.getMap('requests').get(requestId)
        if (existing instanceof Y.Map) {
          existing.set('status', 'rejected')
        } else {
          this.mailboxDoc!.getMap('requests').set(requestId, { ...plain, status: 'rejected' })
        }
      }, 'merge-reject')
      this.toast('Merge-запрос отклонён')
      this.notify(true)
    } catch (error) {
      console.error('rejectMerge failed', error)
      this.toast('Не удалось отклонить merge-запрос', 'error')
    }
  }

  // ---------------------------
  // Backups
  // ---------------------------

  async refreshBackups() {
    if (!this.projectId) return
    this.backups = await listBackups(this.projectId)
    this.notify()
  }

  async restoreBackup(backupId: string) {
    const bytes = await getBackupUpdate(backupId)
    if (!bytes) {
      this.toast('Backup не найден', 'error')
      return
    }

    try {
      const roomId = this.roomId
      const backupMeta = this.backups.find((b) => b.id === backupId)

      this.cleanupDoc()

      const doc = new Y.Doc()
      this.ydoc = doc
      this.projectId = backupMeta?.projectId ?? this.projectId
      this.mode = 'project'
      this.copyMeta = null
      this.currentCopyRecord = null

      Y.applyUpdate(doc, bytes, 'backup-restore')
      doc.on('update', () => this.notify())
      this.scheduleSave()

      if (roomId) {
        this.connectRoom(roomId)
      }

      this.selectedId = null
      this.toast('Состояние восстановлено из backup')
      this.notify(true)
    } catch (error) {
      console.error('restoreBackup failed', error)
      this.toast('Не удалось восстановить backup', 'error')
    }
  }

  // ---------------------------
  // Экспорт / импорт
  // ---------------------------

  exportJson(): string | null {
    if (!this.ydoc) return null
    return JSON.stringify(exportProjectToJson(this.ydoc), null, 2)
  }

  exportTxt(): string | null {
    const snap = this.snapshot
    if (!snap.meta) return null
    const lines: string[] = []
    lines.push(`ВЕТВИ — ${snap.meta.name}`)
    lines.push(`Экспорт: ${new Date().toLocaleString('ru-RU')}`)
    lines.push('')

    const dialogues = snap.elements.filter((e) => e.type === 'dialogue')
    const notes = snap.elements.filter((e) => e.type === 'note')
    const texts = snap.elements.filter((e) => e.type === 'text')

    if (dialogues.length) {
      lines.push('=== Реплики диалога ===')
      dialogues.forEach((e) => lines.push(`— ${e.text}`))
      lines.push('')
    }
    if (notes.length) {
      lines.push('=== Заметки ===')
      notes.forEach((e) => lines.push(`• ${e.text}`))
      lines.push('')
    }
    if (texts.length) {
      lines.push('=== Текстовые блоки ===')
      texts.forEach((e) => lines.push(e.text))
      lines.push('')
    }

    if (!snap.elements.length) lines.push('(проект пуст)')
    return lines.join('\n')
  }

  async importJson(text: string): Promise<boolean> {
    try {
      const json = JSON.parse(text)
      validateProjectJson(json)

      if (!this.ydoc) {
        await this.newProject({ silent: true })
      }
      if (!this.ydoc) return false

      importProjectFromJson(json, this.ydoc, { clear: true })
      this.scheduleSave()
      this.toast('Проект импортирован')
      this.notify(true)
      return true
    } catch (error) {
      console.warn('importJson failed', error)
      const message = error instanceof Error ? error.message : 'Неизвестная ошибка импорта'
      this.toast(message, 'error')
      return false
    }
  }

  downloadFile(filename: string, content: string, mime: string) {
    try {
      const blob = new Blob([content], { type: mime })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch (error) {
      console.error('downloadFile failed', error)
      this.toast('Не удалось скачать файл', 'error')
    }
  }
}
