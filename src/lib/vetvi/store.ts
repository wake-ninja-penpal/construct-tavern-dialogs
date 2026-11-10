'use client'

/**
 * VetviStore — единый слой состояния «Ветвей».
 *
 * Полный порт модели и операций vetvi33.html поверх Yjs:
 *   UI  <->  VetviStore  <->  Yjs document  <->  (socket.io provider | IndexedDB)
 *
 * Все мутации данных идут в транзакциях Yjs и потому автоматически
 * синхронизируются между участниками комнаты (realtime).
 *
 * Подписка: subscribe(listener) + getSnapshot() — совместимо с useSyncExternalStore.
 */

import * as Y from 'yjs'
import { VetviProvider } from './provider'
import {
  base64ToUint8,
  ensureProjectSkeleton,
  exportPrototypeJson,
  isPlainObject,
  normalizeProject,
  patchYMap,
  plainToYValue,
  replaceYText,
  toPlainProject,
  uid,
  uint8ToBase64,
  validateProjectJson,
  yValueToPlain,
  clamp,
} from './yjs-model'
import {
  addProjectId,
  deleteCopy as deleteCopyIdb,
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
import { buildTxtExport } from './txt-export'
import {
  BASE_TYPES,
  STATUS_RU,
  emptySnapshot,
  type BackupMeta,
  type BendMode,
  type CopyMeta,
  type CopyRecord,
  type CustomTypeRecord,
  type DialogReply,
  type EdgeKind,
  type MergeRequest,
  type NoteRecord,
  type NodeStatus,
  type PeerInfo,
  type SaveState,
  type ToastItem,
  type ToastKind,
  type VetviEdge,
  type VetviGroup,
  type VetviMode,
  type VetviNode,
  type VetviSnapshot,
  type VetviViewport,
  type ConnectionState,
  type CtxEntry,
  type TypeInfo,
} from './types'

/* ── Константы прототипа ── */
export const NODE_W = 216
export const GRID = 26
export const GCARD_W = 200
export const MAX_DLG_DEPTH = 10
export const DLG_REPLY_INDENT = 23
export const NOTE_MAX = 3

const USER_COLORS = ['#7c5cff', '#4cc9f0', '#2ecc71', '#f5a623', '#ff5a5f', '#ff6ec7', '#9ece6a', '#e0af68']

const LS_USER_ID = 'vetvi:userId'
const LS_USER_NAME = 'vetvi:userName'
const LS_LAST_PROJECT = 'vetvi:lastProjectId'

const NOTIFY_DEBOUNCE_MS = 60
const DATA_ROOTS = ['nodes', 'edges', 'groups', 'customTypes'] as const
const UNDO_ORIGIN = 'ui'
const DRAG_ORIGIN = 'drag'

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

/* ════════════════════════════════════════════════════════════ */

export class VetviStore {
  ydoc: Y.Doc | null = null
  private undoManager: Y.UndoManager | null = null
  private provider: VetviProvider | null = null
  private mailboxDoc: Y.Doc | null = null
  private mailboxProvider: VetviProvider | null = null
  private mailboxRoomId: string | null = null

  private projectId: string | null = null
  private roomId: string | null = null
  private mode: VetviMode = 'project'
  private copyMeta: CopyMeta | null = null
  private currentCopyRecord: CopyRecord | null = null

  /* Локальное выделение (не синкается — как в однопользовательском прототипе). */
  private sel = new Set<string>()
  private selGroups = new Set<string>()
  private selEdges = new Set<string>()
  private selGroup: string | null = null
  private selEdge: string | null = null

  /* Локальный viewport (не синкается; сохраняется в LS). */
  vp: VetviViewport = { x: 80, y: 80, z: 1 }
  private vpListeners = new Set<() => void>()
  private vpSaveTimer: ReturnType<typeof setTimeout> | null = null

  bendMode: BendMode = 'smooth'

  /* UI-состояние (локальное). */
  private ctxMenuState: { x: number; y: number; items: CtxEntry[] } | null = null
  private dlgEditorNodeId: string | null = null
  private noteEditorState: { nodeId: string; idx: number } | null = null
  private noteViewState: { nodeId: string; idx: number } | null = null
  private ctypeEditorState: { existingId: string | null } | null = null
  private groupModalOpenState = false
  private dstWinState: { ids: string[]; k: number } | null = null
  private helpModalOpenState = false
  private palFoldState: Record<string, boolean> = {}
  private ovFoldState: Record<string, boolean> = {}

  private connection: ConnectionState = 'offline'
  private mailboxConnection: ConnectionState = 'offline'
  private saveState: SaveState = 'saved'
  private autosaveFlashCounter = 0

  private userId = ''
  private userName = ''
  private userColor = USER_COLORS[0]

  private copies: CopyMeta[] = []
  private outbox: MergeRequest[] = []
  private backups: BackupMeta[] = []
  private shareUrl: string | null = null

  private toastsArr: ToastItem[] = []
  private toastSeq = 1

  private ready = false
  private bootstrapped = false
  private snapshot: VetviSnapshot
  private listeners = new Set<() => void>()
  private notifyTimer: ReturnType<typeof setTimeout> | null = null
  private autoSaveTimer: ReturnType<typeof setTimeout> | null = null

  /** Колбэк для toast-уведомлений (назначается UI). */
  onToast: ((message: string, kind?: ToastKind) => void) | null = null

  /**
   * Геометрические хуки, назначаемые Canvas после монтирования:
   * точные якоря/размеры по DOM (как в прототипе — offsetWidth/offsetHeight).
   */
  geom: {
    edgeGeomById: (id: string) => import('./geometry').EdgeGeom | null
    nearestEdgeAt: (x: number, y: number, maxDist: number, exclude?: Set<string>) => string | null
    deepestGroupAt: (x: number, y: number) => VetviGroup | null
    groupRectWorld: (g: VetviGroup) => { x: number; y: number; w: number; h: number } | null
    collapsedAncestorOf: (n: VetviNode) => VetviGroup | null
    nodeDims: (n: VetviNode) => { w: number; h: number }
    refreshFrames: () => void
    fitView: (animate?: boolean) => void
    centerOn: (id: string) => void
    getCenterWorld: () => { x: number; y: number }
    flashSpawnNodes: (ids: string[]) => void
    flashSpawnEdge: (id: string) => void
  } | null = null

  /** Императивный API холста (назначается Canvas): жесты, инлайн-редактирование. */
  canvasApi: {
    startInlineEdit: (id: string) => void
    cancelGestures: () => boolean
    cancelCarry: () => void
    hasCarry: () => boolean
    cancelGroupCreate: () => void
    openCtxAdd: (x: number, y: number) => void
    startCarry: (ids: string[]) => void
  } | null = null

  constructor() {
    this.snapshot = emptySnapshot()
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
    const item: ToastItem = { id: this.toastSeq++, message, kind }
    this.toastsArr = [...this.toastsArr, item]
    if (this.toastsArr.length > 5) this.toastsArr = this.toastsArr.slice(-5)
    this.onToast?.(message, kind)
    this.notify(true)
    setTimeout(() => {
      this.toastsArr = this.toastsArr.filter((t) => t.id !== item.id)
      this.notify(true)
    }, 2800)
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

  // ---------------------------
  // Доступ к корням Yjs
  // ---------------------------

  private get doc(): Y.Doc | null {
    return this.ydoc
  }

  private rootMap(root: string): Y.Map<unknown> | null {
    return this.ydoc ? this.ydoc.getMap(root) : null
  }

  /* ── Чтение сущностей ── */

  private readNodes(): VetviNode[] {
    const map = this.rootMap('nodes')
    if (!map) return []
    const out: VetviNode[] = []
    map.forEach((value, id) => {
      const rec = yValueToPlain(value) as Record<string, unknown>
      out.push(plainToNode(id, rec))
    })
    out.sort((a, b) => a.id.localeCompare(b.id))
    return out
  }

  private readEdges(): VetviEdge[] {
    const map = this.rootMap('edges')
    if (!map) return []
    const out: VetviEdge[] = []
    map.forEach((value, id) => {
      const rec = yValueToPlain(value) as Record<string, unknown>
      out.push(plainToEdge(id, rec))
    })
    out.sort((a, b) => a.id.localeCompare(b.id))
    return out
  }

  private readGroups(): VetviGroup[] {
    const map = this.rootMap('groups')
    if (!map) return []
    const out: VetviGroup[] = []
    map.forEach((value, id) => {
      const rec = yValueToPlain(value) as Record<string, unknown>
      out.push(plainToGroup(id, rec))
    })
    out.sort((a, b) => a.id.localeCompare(b.id))
    return out
  }

  private readCustomTypes(): CustomTypeRecord[] {
    const map = this.rootMap('customTypes')
    if (!map) return []
    const out: CustomTypeRecord[] = []
    map.forEach((value, id) => {
      const rec = yValueToPlain(value) as Record<string, unknown>
      out.push({
        id,
        name: String(rec.name ?? 'Элемент'),
        color: typeof rec.color === 'string' ? rec.color : '#e2a54e',
        icon: typeof rec.icon === 'string' ? rec.icon : 'star',
      })
    })
    out.sort((a, b) => a.id.localeCompare(b.id))
    return out
  }

  private readListHidden(): string[] {
    const meta = this.rootMap('meta')
    if (!meta) return []
    const raw = meta.get('listHidden')
    if (typeof raw !== 'string') return []
    try {
      const arr = JSON.parse(raw)
      return Array.isArray(arr) ? arr.map(String) : []
    } catch {
      return []
    }
  }

  nodeById(id: string): VetviNode | null {
    return this.snapshot.nodes.find((n) => n.id === id) ?? null
  }

  edgeById(id: string): VetviEdge | null {
    return this.snapshot.edges.find((e) => e.id === id) ?? null
  }

  groupById(id: string): VetviGroup | null {
    return this.snapshot.groups.find((g) => g.id === id) ?? null
  }

  customTypeById(id: string): CustomTypeRecord | null {
    return this.snapshot.customTypes.find((c) => c.id === id) ?? null
  }

  /** Информация о типе (базовый или свой). */
  typeInfo(key: string): TypeInfo {
    const base = (BASE_TYPES as Record<string, TypeInfo>)[key]
    if (base) return base
    const c = this.snapshot.customTypes.find((ct) => ct.id === key)
    if (c) return { name: c.name, color: c.color, icon: c.icon }
    return BASE_TYPES.note
  }

  allTypeKeys(): string[] {
    return [...Object.keys(BASE_TYPES), ...this.snapshot.customTypes.map((c) => c.id)]
  }

  /* ── Транзакции ── */

  tx(fn: () => void, origin: string = UNDO_ORIGIN) {
    const doc = this.doc
    if (!doc) return
    doc.transact(fn, origin)
  }

  /** Транзакция без записи в undo-историю (импорт, merge). */
  txSystem(fn: () => void, origin = 'system') {
    this.tx(fn, origin)
  }

  /* ── Y-хелперы для горячих путей (drag) ── */

  nodeY(id: string): Y.Map<unknown> | null {
    const v = this.rootMap('nodes')?.get(id)
    return v instanceof Y.Map ? v : null
  }

  edgeY(id: string): Y.Map<unknown> | null {
    const v = this.rootMap('edges')?.get(id)
    return v instanceof Y.Map ? v : null
  }

  groupY(id: string): Y.Map<unknown> | null {
    const v = this.rootMap('groups')?.get(id)
    return v instanceof Y.Map ? v : null
  }

  setNodePos(id: string, x: number, y: number) {
    const ym = this.nodeY(id)
    if (!ym) return
    this.tx(() => {
      ym.set('x', Math.round(x))
      ym.set('y', Math.round(y))
      this.touch()
    }, DRAG_ORIGIN)
  }

  moveNodesLive(moves: { id: string; x: number; y: number }[]) {
    if (!moves.length) return
    this.tx(() => {
      for (const m of moves) {
        const ym = this.nodeY(m.id)
        if (!ym) continue
        ym.set('x', Math.round(m.x))
        ym.set('y', Math.round(m.y))
      }
      this.touch()
    }, DRAG_ORIGIN)
  }

  setEdgePt(eid: string, idx: number, x: number, y: number) {
    const ym = this.edgeY(eid)
    if (!ym) return
    const pts = ym.get('pts')
    if (!(pts instanceof Y.Array)) return
    const p = pts.get(idx)
    if (!(p instanceof Y.Map)) return
    this.tx(() => {
      p.set('x', x)
      p.set('y', y)
      this.touch()
    }, DRAG_ORIGIN)
  }

  setGroupCardPos(gid: string, x: number, y: number) {
    const ym = this.groupY(gid)
    if (!ym) return
    this.tx(() => {
      ym.set('x', Math.round(x))
      ym.set('y', Math.round(y))
      this.touch()
    }, DRAG_ORIGIN)
  }

  setGroupFramePos(gid: string, fx: number, fy: number) {
    const ym = this.groupY(gid)
    if (!ym) return
    this.tx(() => {
      ym.set('fx', Math.round(fx))
      ym.set('fy', Math.round(fy))
      this.touch()
    }, DRAG_ORIGIN)
  }

  setGroupFrameSize(gid: string, fx: number, fy: number, fw: number, fh: number) {
    const ym = this.groupY(gid)
    if (!ym) return
    this.tx(() => {
      ym.set('auto', false)
      ym.set('fx', Math.round(fx))
      ym.set('fy', Math.round(fy))
      ym.set('fw', Math.round(fw))
      ym.set('fh', Math.round(fh))
      this.touch()
    }, DRAG_ORIGIN)
  }

  endDragHistory() {
    try {
      this.undoManager?.stopCapturing()
    } catch {
      // ignore
    }
  }

  private touch() {
    this.doc?.getMap('meta').set('updatedAt', Date.now())
  }

  // ---------------------------
  // Снапшот
  // ---------------------------

  private buildSnapshot(): VetviSnapshot {
    const doc = this.doc

    const metaPlain = doc ? (yValueToPlain(doc.getMap('meta')) as Record<string, unknown>) : {}

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
      meta: {
        projectId: String(metaPlain.projectId ?? this.projectId ?? ''),
        name: String(metaPlain.name ?? 'Без названия'),
        createdAt: Number(metaPlain.createdAt ?? 0),
        updatedAt: Number(metaPlain.updatedAt ?? 0),
      },
      nodes: this.readNodes(),
      edges: this.readEdges(),
      groups: this.readGroups(),
      customTypes: this.readCustomTypes(),
      listHidden: this.readListHidden(),
      bendMode: this.bendMode,
      snapOn: this.snapOn,
      gridOn: this.gridOn,
      sel: [...this.sel],
      selGroups: [...this.selGroups],
      selEdges: [...this.selEdges],
      selGroup: this.selGroup,
      selEdge: this.selEdge,
      ctxMenu: this.ctxMenuState,
      dlgEditorNodeId: this.dlgEditorNodeId,
      noteEditor: this.noteEditorState,
      noteView: this.noteViewState,
      ctypeEditor: this.ctypeEditorState,
      groupModalOpen: this.groupModalOpenState,
      dstWin: this.dstWinState,
      helpModalOpen: this.helpModalOpenState,
      palFold: this.palFoldState,
      ovFold: this.ovFoldState,
      connection,
      roomActive: this.provider !== null,
      roomId: this.roomId,
      shareUrl: this.shareUrl,
      peers,
      peersCount: peers.length,
      mailboxActive: this.mailboxProvider !== null,
      copies: this.copies,
      incoming: this.mode === 'project' ? this.readIncoming() : [],
      outgoing: this.outbox.filter((r) => (this.copyMeta ? r.copyId === this.copyMeta.copyId : false)),
      backups: this.backups,
      copyMeta: this.copyMeta,
      saveState: this.saveState,
      userName: this.userName,
      userColor: this.userColor,
      autosaveFlash: this.autosaveFlashCounter,
      toasts: this.toastsArr,
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
      await this.openProject(projectId, {
        name: project ? 'Проект' : 'Проект из комнаты',
        restoreRoom: false,
      })
      this.connectRoom(room)
      writeHashParams({ room, project: projectId, copy: null })
      return
    }

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
    this.mode = 'project'
    this.copyMeta = null
    this.currentCopyRecord = null
    const projectId = uid()
    await this.createDoc(projectId, 'Новый проект')
    writeHashParams({ room: null, project: null, copy: null })
    safeLocalStorage()?.setItem(LS_LAST_PROJECT, projectId)
    this.ready = true
    if (!options.silent) this.toast('Создан новый проект')
    // Как в прототипе: новый проект начинается с одной сцены в (0,0).
    this.addNode('scene', 0, 0, true)
    this.vp = { x: 80, y: 80, z: 1 }
    this.emitVp()
    this.notify(true)
  }

  private async createDoc(
    projectId: string,
    name: string,
    options: { restoreRoom?: boolean } = {},
  ) {
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

    this.normalizeDocOnLoad()

    // Undo/redo: отслеживаем только локальные правки.
    this.undoManager = new Y.UndoManager(
      [doc.getMap('nodes'), doc.getMap('edges'), doc.getMap('groups'), doc.getMap('customTypes')],
      { captureTimeout: 400, trackedOrigins: new Set([UNDO_ORIGIN, DRAG_ORIGIN]) },
    )
    this.undoManager.on('stack-item-popped', () => {
      this.cleanupSelectionToExisting()
      this.notify(true)
    })

    // Автосохранение на ЛЮБОЕ изменение документа (в т.ч. правки соавторов).
    doc.on('update', () => {
      this.notify()
      this.scheduleSave()
    })

    if (options.restoreRoom !== false) {
      this.maybeRestoreRoom()
    }
  }

  /**
   * Нормализация документа после загрузки (порт loadProject из прототипа):
   * ensureDialog для диалогов, чистка fromReply, удаление пустых групп,
   * восстановление bendMode.
   */
  private normalizeDocOnLoad() {
    const doc = this.doc
    if (!doc) return
    doc.transact(() => {
      const nodes = doc.getMap('nodes')
      nodes.forEach((value, id) => {
        if (!(value instanceof Y.Map)) return
        const type = String(value.get('type') ?? 'note')
        if (type === 'dialog') this.ensureDialogY(value)
      })
      // Чистка fromReply.
      const edges = doc.getMap('edges')
      edges.forEach((value) => {
        if (!(value instanceof Y.Map)) return
        const fr = value.get('fromReply')
        if (typeof fr !== 'string' || !fr) return
        const fromId = String(value.get('from') ?? '')
        const fromY = nodes.get(fromId)
        if (!(fromY instanceof Y.Map)) {
          value.set('fromReply', null)
          return
        }
        const fromType = String(fromY.get('type') ?? '')
        const dlg = fromY.get('dialog')
        const replies = dlg instanceof Y.Map ? dlg.get('replies') : null
        if (fromType !== 'dialog' || !(replies instanceof Y.Array) || !this.findReplyY(replies, fr)) {
          value.set('fromReply', null)
        }
      })
      // Пустые группы удаляем.
      const groups = doc.getMap('groups')
      const groupIds: string[] = []
      groups.forEach((_v, gid) => groupIds.push(gid))
      const gidsSet = new Set(groupIds)
      for (const gid of groupIds) {
        const gY = groups.get(gid)
        if (!(gY instanceof Y.Map)) continue
        const parentId = gY.get('parent')
        if (typeof parentId === 'string' && !gidsSet.has(parentId)) gY.set('parent', null)
      }
      let removed = true
      while (removed) {
        removed = false
        const memberGids = new Set<string>()
        nodes.forEach((nv) => {
          if (!(nv instanceof Y.Map)) return
          const gid = nv.get('gid')
          if (typeof gid === 'string') memberGids.add(gid)
        })
        groups.forEach((gv, gid) => {
          if (!(gv instanceof Y.Map)) return
          const parent = typeof gv.get('parent') === 'string' ? (gv.get('parent') as string) : null
          if (!memberGids.has(gid) && !(parent && memberGids.has(parent))) {
            // Внутри могут быть дочерние группы с узлами — проверим рекурсивно
            const hasDescNodes = this.groupHasDescNodesY(groups, gid)
            if (!hasDescNodes) {
              groups.delete(gid)
              removed = true
            }
          }
        })
      }
      // bendMode из meta.
      const bm = doc.getMap('meta').get('bendMode')
      if (bm === 'ortho90' || bm === 'ortho45' || bm === 'smooth') this.bendMode = bm
    }, 'normalize-load')
  }

  private groupHasDescNodesY(groups: Y.Map<unknown>, gid: string, visited = new Set<string>()): boolean {
    if (visited.has(gid)) return false
    visited.add(gid)
    let direct = false
    this.doc?.getMap('nodes').forEach((nv) => {
      if (nv instanceof Y.Map && nv.get('gid') === gid) direct = true
    })
    if (direct) return true
    let child = false
    groups.forEach((gv, cid) => {
      if (gv instanceof Y.Map && gv.get('parent') === gid) {
        if (this.groupHasDescNodesY(groups, cid, visited)) child = true
      }
    })
    return child
  }

  private async openProject(projectId: string, options: { name?: string; restoreRoom?: boolean } = {}) {
    this.cleanupDoc()
    this.mode = 'project'
    this.copyMeta = null
    this.currentCopyRecord = null
    await this.createDoc(projectId, options.name ?? 'Новый проект', {
      restoreRoom: options.restoreRoom,
    })
    safeLocalStorage()?.setItem(LS_LAST_PROJECT, projectId)
    this.restoreViewportLS()
    this.notify(true)
  }

  private maybeRestoreRoom() {
    if (this.mode === 'copy') return
    const doc = this.ydoc
    if (!doc || this.provider) return
    const savedRoom = doc.getMap('meta').get('roomId')
    if (typeof savedRoom === 'string' && savedRoom) {
      this.connectRoom(savedRoom)
    }
  }

  private cleanupDoc() {
    this.disconnectRoom()
    if (this.autoSaveTimer) {
      clearTimeout(this.autoSaveTimer)
      this.autoSaveTimer = null
    }
    try {
      this.undoManager?.destroy()
    } catch {
      // ignore
    }
    this.undoManager = null
    try {
      this.ydoc?.destroy()
    } catch {
      // ignore
    }
    this.ydoc = null
    this.sel.clear()
    this.selGroups.clear()
    this.selGroup = null
    this.selEdges.clear()
    this.selEdge = null
    this.saveState = 'saved'
    this.ctxMenuState = null
    this.dlgEditorNodeId = null
    this.noteEditorState = null
    this.noteViewState = null
    this.ctypeEditorState = null
    this.groupModalOpenState = false
    this.dstWinState = null
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
        this.autosaveFlashCounter++
        this.notify()
      } catch (error) {
        console.warn('AutoSave error', error)
        this.saveState = 'saved'
      }
    }, 500)
  }

  setProjectName(name: string) {
    const doc = this.ydoc
    if (!doc) return
    doc.transact(() => {
      doc.getMap('meta').set('name', name || 'Без названия')
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
  // Viewport (локально)
  // ---------------------------

  onVp(cb: () => void): () => void {
    this.vpListeners.add(cb)
    return () => this.vpListeners.delete(cb)
  }

  getVp(): VetviViewport {
    return this.vp
  }

  setVp(x: number, y: number, z?: number) {
    this.vp = {
      x,
      y,
      z: clamp(z !== undefined ? z : this.vp.z, 0.2, 2.5),
    }
    this.emitVp()
    this.scheduleVpSave()
  }

  private emitVp() {
    this.vpListeners.forEach((cb) => cb())
  }

  private scheduleVpSave() {
    if (this.vpSaveTimer) clearTimeout(this.vpSaveTimer)
    this.vpSaveTimer = setTimeout(() => {
      this.vpSaveTimer = null
      const storage = safeLocalStorage()
      if (!storage || !this.projectId) return
      try {
        storage.setItem(`vetvi2:vp:${this.projectId}`, JSON.stringify(this.vp))
      } catch {
        // ignore
      }
    }, 700)
  }

  private restoreViewportLS() {
    const storage = safeLocalStorage()
    if (!storage || !this.projectId) return
    try {
      const raw = storage.getItem(`vetvi2:vp:${this.projectId}`)
      if (raw) {
        const v = JSON.parse(raw)
        if (v && typeof v.x === 'number' && typeof v.y === 'number' && typeof v.z === 'number') {
          this.vp = { x: v.x, y: v.y, z: clamp(v.z, 0.2, 2.5) }
          this.emitVp()
        }
      } else {
        this.vp = { x: 80, y: 80, z: 1 }
        this.emitVp()
      }
    } catch {
      // ignore
    }
  }

  /** Размер холста (назначается Canvas) — для зума от центра. */
  canvasSize: { w: number; h: number } = { w: 800, h: 600 }

  zoomCenter(f: number) {
    this.zoomAt(this.canvasSize.w / 2, this.canvasSize.h / 2, f)
  }

  zoomAt(cx: number, cy: number, f: number) {
    const nz = clamp(this.vp.z * f, 0.2, 2.5)
    const nx = cx - (cx - this.vp.x) * (nz / this.vp.z)
    const ny = cy - (cy - this.vp.y) * (nz / this.vp.z)
    this.setVp(nx, ny, nz)
  }

  setBendMode(m: BendMode) {
    this.bendMode = m
    this.txSystem(() => {
      this.doc?.getMap('meta').set('bendMode', m)
    }, 'bend-mode')
    this.notify(true)
  }

  // ---------------------------
  // Выделение
  // ---------------------------

  private cleanupSelectionToExisting() {
    const nodeIds = new Set(this.snapshot.nodes.map((n) => n.id))
    const edgeIds = new Set(this.snapshot.edges.map((e) => e.id))
    const groupIds = new Set(this.snapshot.groups.map((g) => g.id))
    this.sel = new Set([...this.sel].filter((id) => nodeIds.has(id)))
    this.selEdges = new Set([...this.selEdges].filter((id) => edgeIds.has(id)))
    this.selGroups = new Set([...this.selGroups].filter((id) => groupIds.has(id)))
    if (this.selEdge && !edgeIds.has(this.selEdge)) this.selEdge = null
    if (this.selGroup && !groupIds.has(this.selGroup)) this.selGroup = null
  }

  private syncSelEmit() {
    this.cleanupSelectionToExisting()
    this.notify(true)
  }

  selectOnly(id: string) {
    this.sel = new Set([id])
    this.selGroups.clear()
    this.selGroup = null
    this.selEdges.clear()
    this.selEdge = null
    this.syncSelEmit()
  }

  selectEdgeOnly(id: string) {
    this.selEdge = id
    this.selEdges = new Set([id])
    this.sel.clear()
    this.selGroups.clear()
    this.selGroup = null
    this.syncSelEmit()
  }

  selectGroup(gid: string) {
    this.selGroup = gid
    this.selGroups = new Set([gid])
    this.sel.clear()
    this.selEdges.clear()
    this.selEdge = null
    this.syncSelEmit()
  }

  toggleNodeInSel(id: string) {
    if (this.sel.has(id)) this.sel.delete(id)
    else this.sel.add(id)
    this.selEdges.clear()
    this.selEdge = null
    this.syncSelEmit()
  }

  toggleGroupInSel(gid: string) {
    if (this.selGroups.has(gid)) {
      this.selGroups.delete(gid)
      if (this.selGroup === gid) this.selGroup = this.selGroups.values().next().value ?? null
    } else {
      this.selGroups.add(gid)
      this.selGroup = gid
    }
    this.selEdges.clear()
    this.selEdge = null
    this.syncSelEmit()
  }

  toggleEdgeInSel(id: string) {
    if (this.selEdges.has(id)) {
      this.selEdges.delete(id)
      if (this.selEdge === id) this.selEdge = null
    } else {
      this.selEdges.add(id)
      this.selEdge = id
    }
    this.sel.clear()
    this.selGroups.clear()
    this.selGroup = null
    this.syncSelEmit()
  }

  clearSel() {
    this.sel.clear()
    this.selGroups.clear()
    this.selGroup = null
    this.selEdges.clear()
    this.selEdge = null
    this.syncSelEmit()
  }

  selectAllVisible() {
    this.sel = new Set(
      this.snapshot.nodes.filter((n) => !this.storeCollapsedAncestorOf(n)).map((n) => n.id),
    )
    this.selGroups.clear()
    this.selGroup = null
    this.selEdges.clear()
    this.selEdge = null
    this.syncSelEmit()
  }

  /** Группа-предок в свёрнутом состоянии (по снапшоту). */
  storeCollapsedAncestorOf(n: VetviNode): VetviGroup | null {
    let g = n.gid ? this.groupById(n.gid) : null
    let guard = 0
    while (g && guard++ < 40) {
      if (g.fold < 2) return g
      g = g.parent ? this.groupById(g.parent) : null
    }
    return null
  }

  // ---------------------------
  // Узлы
  // ---------------------------

  addNode(typeKey: string, x: number, y: number, select = false): VetviNode | null {
    const info = this.typeInfo(typeKey)
    const id = uid()
    const node: Record<string, unknown> = {
      id,
      type: typeKey,
      gid: null,
      x: Math.round(x),
      y: Math.round(y),
      title: info.name,
      text: '',
      status: 'idea',
      tags: [],
      expand: 1,
      color: null,
      tint: 0,
      dlgWidth: null,
      notes: [],
    }
    this.tx(() => {
      this.doc!.getMap('nodes').set(id, plainToYValue(node))
      if (typeKey === 'dialog') {
        const ym = this.doc!.getMap('nodes').get(id)
        if (ym instanceof Y.Map) this.ensureDialogY(ym)
      }
      this.touch()
    })
    this.geom?.flashSpawnNodes([id])
    if (select) this.selectOnly(id)
    this.notify(true)
    return this.nodeById(id)
  }

  /** Клон узла (без рёбер). */
  cloneNode(src: VetviNode, x: number, y: number): VetviNode {
    const copy: VetviNode = {
      ...src,
      id: uid(),
      x: Math.round(x),
      y: Math.round(y),
      tags: [...(src.tags ?? [])],
      notes: (src.notes ?? []).map((m) => ({ ...m })),
      dialog: src.dialog
        ? {
            participants: [...src.dialog.participants],
            description: src.dialog.description,
            replies: cloneReplies(src.dialog.replies),
          }
        : undefined,
    }
    return copy
  }

  insertNode(node: VetviNode, select = false) {
    this.tx(() => {
      this.doc!.getMap('nodes').set(node.id, plainToYValue(node as unknown as Record<string, unknown>))
      this.touch()
    })
    this.geom?.flashSpawnNodes([node.id])
    if (select) this.selectOnly(node.id)
    this.notify(true)
  }

  updateNode(id: string, patch: Partial<VetviNode>) {
    const ym = this.nodeY(id)
    if (!ym) return
    this.tx(() => {
      patchYMap(ym, patch as Record<string, unknown>)
      this.touch()
    })
    this.notify()
  }

  /** Живое обновление текстового поля узла (title/text/description). */
  updateNodeTextField(id: string, field: 'title' | 'text', value: string) {
    const ym = this.nodeY(id)
    if (!ym) return
    this.tx(() => {
      const cur = ym.get(field)
      if (cur instanceof Y.Text) replaceYText(cur, value)
      else ym.set(field, value)
      if (field === 'text') {
        const type = String(ym.get('type') ?? '')
        if (type === 'dialog') {
          const dlg = ym.get('dialog')
          if (dlg instanceof Y.Map) {
            const d = dlg.get('description')
            if (d instanceof Y.Text) replaceYText(d, value)
          }
        }
      }
      this.touch()
    }, 'text-live')
    this.notify()
  }

  setNodeStatus(id: string, status: NodeStatus) {
    this.updateNode(id, { status })
  }

  setNodeType(id: string, type: string) {
    this.updateNode(id, { type })
  }

  setNodeColor(id: string, color: string | null) {
    this.tx(() => {
      const ym = this.nodeY(id)
      if (!ym) return
      if (color) ym.set('color', color)
      else {
        ym.set('color', null)
        ym.set('tint', 0)
      }
      this.touch()
    })
    this.notify(true)
  }

  setNodeTint(id: string, tint: number) {
    this.updateNode(id, { tint: clamp(tint, -60, 60) })
  }

  setNodeExpand(id: string, expand: 0 | 1 | 2) {
    this.updateNode(id, { expand })
  }

  cycleExpand(id: string) {
    const n = this.nodeById(id)
    if (!n) return
    const cur = n.expand
    this.setNodeExpand(id, ((cur + 1) % 3) as 0 | 1 | 2)
  }

  setDlgWidth(id: string, w: number) {
    this.updateNode(id, { dlgWidth: clamp(Math.round(w), NODE_W, 1200) })
  }

  setNodeTags(id: string, tags: string[]) {
    this.updateNode(id, { tags })
  }

  /** Alt+перенос: выдернуть узел, сшив входы×выходы. */
  detachNode(id: string) {
    const ins = this.snapshot.edges.filter((e) => e.to === id)
    const outs = this.snapshot.edges.filter((e) => e.from === id)
    if (!ins.length && !outs.length) return
    this.tx(() => {
      const edgesMap = this.doc!.getMap('edges')
      const removed = this.snapshot.edges.filter((e) => e.from === id || e.to === id)
      removed.forEach((e) => edgesMap.delete(e.id))
      ins.forEach((ei) => {
        outs.forEach((eo) => {
          if (ei.from === eo.to) return
          const dup = this.snapshot.edges.some(
            (x) => x.from === ei.from && x.to === eo.to && x.id !== ei.id && x.id !== eo.id,
          )
          if (!dup) {
            const ne: Record<string, unknown> = {
              id: uid(),
              from: ei.from,
              to: eo.to,
              label: eo.label || '',
              kind: eo.kind || 'flow',
              pts: [],
              lt: 0.5,
              lp: 0,
              fromReply: null,
              bd: { dl: 0, dy: 0, dr: 0 },
            }
            edgesMap.set(String(ne.id), plainToYValue(ne))
          }
        })
      })
      this.touch()
    })
    this.notify(true)
    this.toast('Узел выдернут, цепочка сохранена')
  }

  removeSelected() {
    if (this.selEdge || this.selEdges.size) {
      const ids = new Set(this.selEdges.size ? [...this.selEdges] : this.selEdge ? [this.selEdge] : [])
      this.tx(() => {
        const edgesMap = this.doc!.getMap('edges')
        ids.forEach((id) => edgesMap.delete(id))
        this.touch()
      })
      this.selEdges.clear()
      this.selEdge = null
      this.notify(true)
      return
    }
    if (!this.sel.size && !this.selGroups.size) return
    this.tx(() => {
      const nodesMap = this.doc!.getMap('nodes')
      const edgesMap = this.doc!.getMap('edges')
      const groupsMap = this.doc!.getMap('groups')

      if (this.selGroups.size) {
        const gids = new Set(this.selGroups)
        const arr = [...this.selGroups].sort(
          (a, b) => this.groupDepthOf(b) - this.groupDepthOf(a),
        )
        arr.forEach((gid) => {
          const g = this.groupById(gid)
          const parent = g?.parent ?? null
          this.snapshot.nodes.forEach((n) => {
            if (n.gid === gid) {
              const ym = nodesMap.get(n.id)
              if (ym instanceof Y.Map) ym.set('gid', parent)
            }
          })
          this.snapshot.groups.forEach((cg) => {
            if (cg.parent === gid) {
              const ym = groupsMap.get(cg.id)
              if (ym instanceof Y.Map) ym.set('parent', parent)
            }
          })
        })
        gids.forEach((gid) => groupsMap.delete(gid))
      }

      if (this.sel.size) {
        const ids = new Set(this.sel)
        const doomed: string[] = []
        nodesMap.forEach((_v, nid) => {
          if (ids.has(nid)) doomed.push(nid)
        })
        doomed.forEach((nid) => nodesMap.delete(nid))
        const deadEdges: string[] = []
        edgesMap.forEach((ev, eid) => {
          if (!(ev instanceof Y.Map)) return
          const from = ev.get('from')
          const to = ev.get('to')
          if ((typeof from === 'string' && ids.has(from)) || (typeof to === 'string' && ids.has(to)))
            deadEdges.push(eid)
        })
        deadEdges.forEach((eid) => edgesMap.delete(eid))
      }

      // Пустые группы удаляем (циклично).
      let changed = true
      while (changed) {
        changed = false
        const memberGids = new Set<string>()
        nodesMap.forEach((nv) => {
          if (nv instanceof Y.Map && typeof nv.get('gid') === 'string') {
            memberGids.add(nv.get('gid') as string)
          }
        })
        const groupList: { id: string; parent: string | null }[] = []
        groupsMap.forEach((gv, gid) => {
          if (gv instanceof Y.Map) {
            groupList.push({
              id: gid,
              parent: typeof gv.get('parent') === 'string' ? (gv.get('parent') as string) : null,
            })
          }
        })
        for (const g of groupList) {
          const hasDirect = memberGids.has(g.id)
          const hasDescNodes = !hasDirect && this.groupHasDescNodesY(groupsMap, g.id)
          if (!hasDirect && !hasDescNodes) {
            groupsMap.delete(g.id)
            changed = true
          }
        }
      }

      this.touch()
    })
    this.sel.clear()
    this.selGroups.clear()
    this.selGroup = null
    this.notify(true)
  }

  private groupDepthOf(gid: string): number {
    let d = 0
    let g = this.groupById(gid)
    let guard = 0
    while (g && g.parent && guard++ < 40) {
      d++
      g = this.groupById(g.parent)
    }
    return d
  }

  duplicateSel(): { ids: string[] } | null {
    if (!this.sel.size) {
      this.toast('Нет узлов для дублирования', 'warn')
      return null
    }
    const map = new Map<string, string>()
    const spawn: string[] = []
    const clones: VetviNode[] = []
    const srcNodes = [...this.sel].map((id) => this.nodeById(id)).filter((n): n is VetviNode => !!n)
    srcNodes.forEach((o) => {
      const c = this.cloneNode(o, o.x + 32, o.y + 32)
      map.set(o.id, c.id)
      clones.push(c)
      spawn.push(c.id)
    })
    const addEdges = this.snapshot.edges
      .filter((e) => map.has(e.from) && map.has(e.to))
      .map((e) => ({
        id: uid(),
        from: map.get(e.from)!,
        to: map.get(e.to)!,
        label: e.label,
        kind: e.kind,
        pts: e.pts.map((p) => ({ x: p.x, y: p.y })),
        lt: e.lt,
        lp: e.lp,
        fromReply: e.fromReply,
        bd: { ...e.bd },
      }))
    this.tx(() => {
      const nodesMap = this.doc!.getMap('nodes')
      const edgesMap = this.doc!.getMap('edges')
      clones.forEach((c) => nodesMap.set(c.id, plainToYValue(c as unknown as Record<string, unknown>)))
      addEdges.forEach((e) => edgesMap.set(e.id, plainToYValue(e as unknown as Record<string, unknown>)))
      this.touch()
    })
    this.sel = new Set(spawn)
    this.geom?.flashSpawnNodes(spawn)
    this.notify(true)
    return { ids: spawn }
  }

  alignSelH() {
    const ids: string[] = []
    this.sel.forEach((id) => {
      const n = this.nodeById(id)
      if (n && !this.storeCollapsedAncestorOf(n)) ids.push(id)
    })
    if (ids.length < 2) {
      this.toast('Выделите минимум два узла', 'warn')
      return
    }
    let sum = 0
    ids.forEach((id) => {
      const n = this.nodeById(id)!
      const d = this.geom?.nodeDims(n) ?? { w: NODE_W, h: 90 }
      sum += n.y + d.h / 2
    })
    const avg = sum / ids.length
    this.tx(() => {
      ids.forEach((id) => {
        const n = this.nodeById(id)!
        const d = this.geom?.nodeDims(n) ?? { w: NODE_W, h: 90 }
        const ym = this.nodeY(id)
        if (ym) ym.set('y', Math.round(avg - d.h / 2))
      })
      this.touch()
    })
    this.notify(true)
    this.toast('Выровнено по горизонтали')
  }

  // ---------------------------
  // Связи
  // ---------------------------

  addEdge(from: string, to: string, fromReply: string | null = null, select = true): string | null {
    if (from === to) return null
    const dup = this.snapshot.edges.some(
      (x) => x.from === from && x.to === to && (x.fromReply ?? null) === fromReply,
    )
    if (dup) {
      this.toast('Такая связь уже есть', 'warn')
      return null
    }
    const id = uid()
    const edge: Record<string, unknown> = {
      id,
      from,
      to,
      label: '',
      kind: 'flow',
      pts: [],
      lt: 0.5,
      lp: 0,
      fromReply,
      bd: { dl: 0, dy: 0, dr: 0 },
    }
    this.tx(() => {
      this.doc!.getMap('edges').set(id, plainToYValue(edge))
      this.touch()
    })
    this.geom?.flashSpawnEdge(id)
    if (select) this.selectEdgeOnly(id)
    this.notify(true)
    return id
  }

  updateEdge(id: string, patch: Partial<VetviEdge>) {
    const ym = this.edgeY(id)
    if (!ym) return
    this.tx(() => {
      patchYMap(ym, patch as Record<string, unknown>)
      this.touch()
    })
    this.notify()
  }

  setEdgeLabel(id: string, label: string) {
    const ym = this.edgeY(id)
    if (!ym) return
    this.tx(() => {
      const cur = ym.get('label')
      if (cur instanceof Y.Text) replaceYText(cur, label)
      else ym.set('label', label)
      this.touch()
    }, 'text-live')
    this.notify()
  }

  setEdgeKind(id: string, kind: EdgeKind) {
    this.tx(() => {
      const ym = this.edgeY(id)
      if (!ym) return
      ym.set('kind', kind)
      if (kind === 'bridge') {
        const bd = ym.get('bd')
        if (!(bd instanceof Y.Map)) ym.set('bd', plainToYValue({ dl: 0, dy: 0, dr: 0 }))
      }
      this.touch()
    })
    this.notify(true)
  }

  swapEdge(id: string) {
    this.tx(() => {
      const ym = this.edgeY(id)
      if (!ym) return
      const from = ym.get('from')
      ym.set('from', ym.get('to'))
      ym.set('to', from)
      ym.set('fromReply', null)
      this.touch()
    })
    this.notify(true)
  }

  resetEdgeBends(id: string) {
    this.updateEdge(id, { pts: [] })
    this.notify(true)
  }

  addWaypoint(id: string, index: number, x: number, y: number) {
    const ym = this.edgeY(id)
    if (!ym) return
    this.tx(() => {
      const pts = ym.get('pts')
      if (!(pts instanceof Y.Array)) {
        const arr = new Y.Array()
        const m = new Y.Map()
        m.set('x', Math.round(x))
        m.set('y', Math.round(y))
        arr.push([m])
        ym.set('pts', arr)
      } else {
        const m = new Y.Map()
        m.set('x', Math.round(x))
        m.set('y', Math.round(y))
        pts.insert(Math.min(index, pts.length), [m])
      }
      this.touch()
    })
    this.notify(true)
  }

  removeWaypoint(id: string, index: number) {
    const ym = this.edgeY(id)
    if (!ym) return
    const pts = ym.get('pts')
    if (!(pts instanceof Y.Array)) return
    this.tx(() => {
      if (index < pts.length) pts.delete(index, 1)
      this.touch()
    })
    this.toast('Точка излома удалена', 'warn')
    this.notify(true)
  }

  deleteEdges(ids: string[]) {
    this.tx(() => {
      const edgesMap = this.doc!.getMap('edges')
      ids.forEach((id) => edgesMap.delete(id))
      this.touch()
    })
    this.notify(true)
  }

  // ---------------------------
  // Диалоги
  // ---------------------------

  /** Гарантирует структуру dialog в Y-узле. */
  private ensureDialogY(ym: Y.Map<unknown>) {
    let dlg = ym.get('dialog')
    if (!(dlg instanceof Y.Map)) {
      dlg = new Y.Map()
      ym.set('dialog', dlg)
    }
    const d = dlg as Y.Map<unknown>
    if (!(d.get('participants') instanceof Y.Array)) {
      const arr = new Y.Array()
      d.set('participants', arr)
    }
    if (!(d.get('replies') instanceof Y.Array)) d.set('replies', new Y.Array())
    if (!(d.get('description') instanceof Y.Text)) d.set('description', plainToYValue('', 'description'))
  }

  private findReplyY(replies: Y.Array<unknown>, id: string): Y.Map<unknown> | null {
    for (let i = 0; i < replies.length; i++) {
      const r = replies.get(i)
      if (!(r instanceof Y.Map)) continue
      if (r.get('id') === id) return r
      const ch = r.get('children')
      if (ch instanceof Y.Array) {
        const f = this.findReplyY(ch, id)
        if (f) return f
      }
    }
    return null
  }

  private findReplyParentY(
    replies: Y.Array<unknown>,
    id: string,
  ): { arr: Y.Array<unknown>; idx: number } | null {
    for (let i = 0; i < replies.length; i++) {
      const r = replies.get(i)
      if (!(r instanceof Y.Map)) continue
      if (r.get('id') === id) return { arr: replies, idx: i }
      const ch = r.get('children')
      if (ch instanceof Y.Array) {
        const f = this.findReplyParentY(ch, id)
        if (f) return f
      }
    }
    return null
  }

  /** Дерево реплик → plain (для редактора). */
  repliesToPlain(replies: Y.Array<unknown>): DialogReply[] {
    const out: DialogReply[] = []
    for (let i = 0; i < replies.length; i++) {
      const r = replies.get(i)
      if (!(r instanceof Y.Map)) continue
      out.push({
        id: String(r.get('id') ?? ''),
        speaker: typeof r.get('speaker') === 'string' ? (r.get('speaker') as string) : null,
        text: r.get('text') instanceof Y.Text ? (r.get('text') as Y.Text).toString() : String(r.get('text') ?? ''),
        children:
          r.get('children') instanceof Y.Array
            ? this.repliesToPlain(r.get('children') as Y.Array<unknown>)
            : [],
      })
    }
    return out
  }

  addDialogParticipant(nodeId: string, charId: string) {
    const ym = this.nodeY(nodeId)
    if (!ym) return
    this.tx(() => {
      this.ensureDialogY(ym)
      const dlg = ym.get('dialog') as Y.Map<unknown>
      const parts = dlg.get('participants') as Y.Array<unknown>
      let exists = false
      for (let i = 0; i < parts.length; i++) if (parts.get(i) === charId) exists = true
      if (!exists) parts.push([charId])
      this.touch()
    })
    this.notify(true)
  }

  removeDialogParticipant(nodeId: string, charId: string) {
    const ym = this.nodeY(nodeId)
    if (!ym) return
    this.tx(() => {
      this.ensureDialogY(ym)
      const dlg = ym.get('dialog') as Y.Map<unknown>
      const parts = dlg.get('participants') as Y.Array<unknown>
      const idx: number[] = []
      for (let i = 0; i < parts.length; i++) if (parts.get(i) === charId) idx.push(i)
      for (let k = idx.length - 1; k >= 0; k--) parts.delete(idx[k], 1)
      // Спикеры удалённого участника → первый оставшийся.
      const firstPart = parts.length ? (parts.get(0) as string) : null
      const cleanReplies = (arr: Y.Array<unknown>) => {
        for (let i = 0; i < arr.length; i++) {
          const r = arr.get(i)
          if (!(r instanceof Y.Map)) continue
          if (r.get('speaker') === charId) r.set('speaker', firstPart)
          const ch = r.get('children')
          if (ch instanceof Y.Array) cleanReplies(ch)
        }
      }
      cleanReplies(dlg.get('replies') as Y.Array<unknown>)
      this.touch()
    })
    this.notify(true)
  }

  addReply(nodeId: string, parentReplyId: string | null) {
    const ym = this.nodeY(nodeId)
    if (!ym) return
    this.tx(() => {
      this.ensureDialogY(ym)
      const dlg = ym.get('dialog') as Y.Map<unknown>
      const parts = dlg.get('participants') as Y.Array<unknown>
      const firstChar = parts.length ? (parts.get(0) as string) : null
      const rid = uid()
      const r = new Y.Map()
      r.set('id', rid)
      r.set('speaker', firstChar)
      r.set('text', plainToYValue('', 'text'))
      r.set('children', new Y.Array())
      if (parentReplyId) {
        const parent = this.findReplyY(dlg.get('replies') as Y.Array<unknown>, parentReplyId)
        if (parent) {
          let ch = parent.get('children')
          if (!(ch instanceof Y.Array)) {
            ch = new Y.Array()
            parent.set('children', ch)
          }
          ;(ch as Y.Array<unknown>).push([r])
        }
      } else {
        ;(dlg.get('replies') as Y.Array<unknown>).push([r])
      }
      this.touch()
    })
    this.notify(true)
  }

  deleteReply(nodeId: string, replyId: string) {
    const ym = this.nodeY(nodeId)
    if (!ym) return
    this.tx(() => {
      this.ensureDialogY(ym)
      const dlg = ym.get('dialog') as Y.Map<unknown>
      const loc = this.findReplyParentY(dlg.get('replies') as Y.Array<unknown>, replyId)
      if (loc) loc.arr.delete(loc.idx, 1)
      // Связи из реплики удаляем.
      const edgesMap = this.doc!.getMap('edges')
      const dead: string[] = []
      edgesMap.forEach((ev, eid) => {
        if (ev instanceof Y.Map && ev.get('from') === nodeId && ev.get('fromReply') === replyId)
          dead.push(eid)
      })
      dead.forEach((eid) => edgesMap.delete(eid))
      this.touch()
    })
    this.notify(true)
  }

  updateReplyText(nodeId: string, replyId: string, text: string) {
    const ym = this.nodeY(nodeId)
    if (!ym) return
    this.tx(() => {
      this.ensureDialogY(ym)
      const dlg = ym.get('dialog') as Y.Map<unknown>
      const r = this.findReplyY(dlg.get('replies') as Y.Array<unknown>, replyId)
      if (!r) return
      const t = r.get('text')
      if (t instanceof Y.Text) replaceYText(t, text)
      else r.set('text', text)
      this.touch()
    }, 'text-live')
    this.notify()
  }

  setReplySpeaker(nodeId: string, replyId: string, speaker: string | null) {
    const ym = this.nodeY(nodeId)
    if (!ym) return
    this.tx(() => {
      this.ensureDialogY(ym)
      const dlg = ym.get('dialog') as Y.Map<unknown>
      const r = this.findReplyY(dlg.get('replies') as Y.Array<unknown>, replyId)
      if (r) r.set('speaker', speaker)
      this.touch()
    })
    this.notify(true)
  }

  // ---------------------------
  // Заметки узлов
  // ---------------------------

  saveNote(nodeId: string, idx: number, note: NoteRecord) {
    const ym = this.nodeY(nodeId)
    if (!ym) return
    this.tx(() => {
      let notes = ym.get('notes')
      if (!(notes instanceof Y.Array)) {
        notes = new Y.Array()
        ym.set('notes', notes)
      }
      const record = plainToYValue({ ...note })
      if (idx < 0) (notes as Y.Array<unknown>).push([record])
      else {
        const ynotes = notes as Y.Array<unknown>
        if (idx < ynotes.length) ynotes.delete(idx, 1)
        ynotes.insert(Math.min(idx, ynotes.length), [record])
      }
      this.touch()
    })
    this.notify(true)
  }

  deleteNote(nodeId: string, idx: number) {
    const ym = this.nodeY(nodeId)
    if (!ym) return
    this.tx(() => {
      const notes = ym.get('notes')
      if (!(notes instanceof Y.Array)) return
      if (idx < notes.length) notes.delete(idx, 1)
      this.touch()
    })
    this.notify(true)
    this.toast('Заметка удалена', 'warn')
  }

  toggleNoteHidden(nodeId: string, idx: number) {
    const ym = this.nodeY(nodeId)
    if (!ym) return
    this.tx(() => {
      const notes = ym.get('notes')
      if (!(notes instanceof Y.Array) || idx >= notes.length) return
      const rec = notes.get(idx)
      if (rec instanceof Y.Map) rec.set('hidden', !rec.get('hidden'))
      this.touch()
    })
    this.notify(true)
  }

  toggleAllNotes(nodeId: string) {
    const ym = this.nodeY(nodeId)
    if (!ym) return
    const n = this.nodeById(nodeId)
    if (!n) return
    const anyVisible = (n.notes ?? []).some((x) => !x.hidden)
    this.tx(() => {
      const notes = ym.get('notes')
      if (!(notes instanceof Y.Array)) return
      for (let i = 0; i < notes.length; i++) {
        const rec = notes.get(i)
        if (rec instanceof Y.Map) rec.set('hidden', anyVisible)
      }
      this.touch()
    })
    this.notify(true)
  }

  setNoteCheck(nodeId: string, idx: number, html: string) {
    const ym = this.nodeY(nodeId)
    if (!ym) return
    this.tx(() => {
      const notes = ym.get('notes')
      if (!(notes instanceof Y.Array) || idx >= notes.length) return
      const rec = notes.get(idx)
      if (rec instanceof Y.Map) rec.set('html', html)
      this.touch()
    })
    this.notify(true)
  }

  // ---------------------------
  // Группы
  // ---------------------------

  createGroupFromSel(name: string) {
    const nodeIds: string[] = []
    this.sel.forEach((id) => {
      if (this.nodeById(id)) nodeIds.push(id)
    })
    const groupIds = [...this.selGroups].filter((gid) => this.groupById(gid))
    if (nodeIds.length + groupIds.length < 2) {
      this.toast('Выделите минимум два объекта (узлы и/или группы)', 'warn')
      return
    }
    const selGset = new Set(groupIds)
    const topGroups = groupIds.filter((gid) => {
      const g = this.groupById(gid)
      if (!g) return false
      let p = g.parent ? this.groupById(g.parent) : null
      let guard = 0
      while (p && guard++ < 40) {
        if (selGset.has(p.id)) return false
        p = p.parent ? this.groupById(p.parent) : null
      }
      return true
    })
    const chains: string[][] = []
    nodeIds.forEach((id) => {
      const n = this.nodeById(id)
      chains.push(n && n.gid ? this.chainOfG(n.gid) : [])
    })
    topGroups.forEach((gid) => {
      const g = this.groupById(gid)
      chains.push(g && g.parent ? this.chainOfG(g.parent) : [])
    })
    let common: string | null = null
    if (chains.length) {
      let inter = new Set(chains[0])
      for (let i = 1; i < chains.length; i++) {
        const s = new Set(chains[i])
        const nxt = new Set<string>()
        inter.forEach((x) => {
          if (s.has(x)) nxt.add(x)
        })
        inter = nxt
      }
      let best: string | null = null
      let bestD = -1
      inter.forEach((gid) => {
        if (selGset.has(gid)) return
        const d = this.groupDepthOf(gid)
        if (d > bestD) {
          bestD = d
          best = gid
        }
      })
      common = best
    }
    const gidN = uid()
    const newG: Record<string, unknown> = {
      id: gidN,
      name: name.trim() || 'Группа',
      fold: 2,
      x: 0,
      y: 0,
      parent: common,
      color: null,
      alpha: 0.55,
      badge: false,
      bbox: null,
      hh: null,
      auto: false,
      fx: null,
      fy: null,
      fw: null,
      fh: null,
    }
    this.tx(() => {
      const groupsMap = this.doc!.getMap('groups')
      groupsMap.set(gidN, plainToYValue(newG))
      topGroups.forEach((gid) => {
        const gy = groupsMap.get(gid)
        if (gy instanceof Y.Map) gy.set('parent', gidN)
      })
      nodeIds.forEach((id) => {
        const n = this.nodeById(id)
        if (!n) return
        let inside = false
        if (n.gid) {
          const ch = this.chainOfG(n.gid)
          for (const c of ch) {
            if (selGset.has(c)) {
              inside = true
              break
            }
          }
        }
        if (!inside) {
          const ym = this.nodeY(id)
          if (ym) ym.set('gid', gidN)
        }
      })
      this.touch()
    })
    // Авторазмер: фиксируем ручную рамку по содержимому (после рендера).
    setTimeout(() => {
      const g = this.groupById(gidN)
      if (!g) return
      const fr = this.geom?.groupRectWorld(g)
      if (fr) {
        this.txSystem(() => {
          const gy = this.groupY(gidN)
          if (gy) {
            gy.set('fx', fr.x)
            gy.set('fy', fr.y)
            gy.set('fw', fr.w)
            gy.set('fh', fr.h)
          }
        }, 'group-frame')
        this.notify(true)
      }
    }, 60)
    this.selectGroup(gidN)
    this.notify(true)
    this.toast(
      `Группа «${name.trim() || 'Группа'}» создана${common ? ` (внутри «${this.groupById(common)?.name}») ` : ''}`.trimEnd(),
    )
  }

  createDrawnGroup(rx: number, ry: number, rw: number, rh: number) {
    const gid = uid()
    const g: Record<string, unknown> = {
      id: gid,
      name: `Группа ${this.snapshot.groups.length + 1}`,
      fold: 2,
      x: 0,
      y: 0,
      parent: null,
      color: null,
      alpha: 0.55,
      badge: false,
      bbox: null,
      hh: null,
      auto: false,
      fx: rx,
      fy: ry,
      fw: rw,
      fh: rh,
    }
    this.tx(() => {
      this.doc!.getMap('groups').set(gid, plainToYValue(g))
      this.touch()
    })
    const gRec = { ...(g as unknown as VetviGroup) }
    const cntN = this.captureNodesInto(gRec)
    const cntG = this.captureGroupsInto(gRec)
    const cx = rx + rw / 2
    const cy = ry + rh / 2
    const t2 = this.groupDropTargetAt(cx, cy, new Set([gid]))
    this.tx(() => {
      const gy = this.groupY(gid)
      if (gy) gy.set('parent', t2 ? t2.id : null)
      this.touch()
    })
    this.selectGroup(gid)
    this.notify(true)
    this.toast(
      `Группа создана${cntN ? ` · элементов: ${cntN}` : ''}${cntG ? ` · вложено групп: ${cntG}` : ''}`,
    )
  }

  private chainOfG(gid: string): string[] {
    const out: string[] = []
    let g = this.groupById(gid)
    let guard = 0
    while (g && guard++ < 40) {
      out.push(g.id)
      g = g.parent ? this.groupById(g.parent) : null
    }
    return out
  }

  membersOf(gid: string): VetviNode[] {
    return this.snapshot.nodes.filter((n) => n.gid === gid)
  }

  allDescNodes(gid: string, visited = new Set<string>()): VetviNode[] {
    if (visited.has(gid)) return []
    visited.add(gid)
    let out = this.membersOf(gid)
    this.snapshot.groups.forEach((cg) => {
      if (cg.parent === gid) out = out.concat(this.allDescNodes(cg.id, visited))
    })
    return out
  }

  /** Захват узлов (центры внутри рамки) в группу. */
  captureNodesInto(g: VetviGroup): number {
    const rect = this.geom?.groupRectWorld(g)
    if (!rect) return 0
    const cnt: { id: string; gid: string }[] = []
    this.snapshot.nodes.forEach((n) => {
      if (this.storeCollapsedAncestorOf(n)) return
      if (this.belongsToGroup(n, g.id)) return
      const d = this.geom?.nodeDims(n) ?? { w: NODE_W, h: 90 }
      const cx = n.x + d.w / 2
      const cy = n.y + d.h / 2
      if (cx >= rect.x && cx <= rect.x + rect.w && cy >= rect.y && cy <= rect.y + rect.h) {
        cnt.push({ id: n.id, gid: g.id })
      }
    })
    if (!cnt.length) return 0
    this.tx(() => {
      cnt.forEach((m) => {
        const ym = this.nodeY(m.id)
        if (ym) ym.set('gid', m.gid)
      })
      this.touch()
    })
    return cnt.length
  }

  /** Захват полностью покрытых дочерних групп. */
  captureGroupsInto(g: VetviGroup): number {
    const rect = this.geom?.groupRectWorld(g)
    if (!rect) return 0
    const ancSet = new Set(this.chainOfG(g.id))
    const covered: VetviGroup[] = []
    this.snapshot.groups.forEach((o) => {
      if (o.id === g.id || ancSet.has(o.id)) return
      if (o.fold < 2) return
      const or = this.geom?.groupRectWorld(o)
      if (!or) return
      const tol = 4
      if (
        or.x >= rect.x - tol &&
        or.y >= rect.y - tol &&
        or.x + or.w <= rect.x + rect.w + tol &&
        or.y + or.h <= rect.y + rect.h + tol
      )
        covered.push(o)
    })
    const cnt: { id: string; parent: string }[] = []
    covered.forEach((o) => {
      let hasCAnc = false
      let a = o.parent ? this.groupById(o.parent) : null
      let guard = 0
      while (a && guard++ < 40) {
        if (covered.some((c) => c.id === a!.id)) {
          hasCAnc = true
          break
        }
        a = a.parent ? this.groupById(a.parent) : null
      }
      if (hasCAnc) return
      if ((o.parent ?? null) !== g.id) cnt.push({ id: o.id, parent: g.id })
    })
    if (!cnt.length) return 0
    this.tx(() => {
      cnt.forEach((m) => {
        const gy = this.groupY(m.id)
        if (gy) gy.set('parent', m.parent)
      })
      this.touch()
    })
    return cnt.length
  }

  belongsToGroup(n: VetviNode, gid: string): boolean {
    if (!n.gid) return false
    const chain = this.chainOfG(n.gid)
    return chain.includes(gid)
  }

  groupDropTargetAt(wx: number, wy: number, excludeIds: Set<string>): VetviGroup | null {
    let best: VetviGroup | null = null
    let bestDepth = -1
    this.snapshot.groups.forEach((g) => {
      if (g.fold !== 2) return
      if (excludeIds.has(g.id)) return
      if (this.groupInsideCollapsed(g)) return
      const r = this.geom?.groupRectWorld(g)
      if (!r) return
      if (wx >= r.x && wx <= r.x + r.w && wy >= r.y && wy <= r.y + r.h) {
        const d = this.groupDepthOf(g.id)
        if (d > bestDepth) {
          bestDepth = d
          best = g
        }
      }
    })
    return best
  }

  groupInsideCollapsed(g: VetviGroup): boolean {
    let p = g.parent ? this.groupById(g.parent) : null
    let guard = 0
    while (p && guard++ < 40) {
      if (p.fold < 2) return true
      p = p.parent ? this.groupById(p.parent) : null
    }
    return false
  }

  /** Переподчинение после перемещения группы. */
  reparentAfterMove(g: VetviGroup): boolean {
    let changed = false
    const capturedG = this.captureGroupsInto(g)
    const capturedN = this.captureNodesInto(g)
    if (capturedG > 0 || capturedN > 0) changed = true
    const excl = new Set([g.id, ...this.descGroupIds(g.id)])
    const rect = this.geom?.groupRectWorld(g)
    const target = rect ? this.groupDropTargetAt(rect.x + rect.w / 2, rect.y + rect.h / 2, excl) : null
    const newPar = target ? target.id : null
    if ((g.parent ?? null) !== newPar) {
      this.tx(() => {
        const gy = this.groupY(g.id)
        if (gy) gy.set('parent', newPar)
        this.touch()
      })
      changed = true
    }
    return changed
  }

  descGroupIds(gid: string): string[] {
    const out: string[] = []
    const walk = (id: string) => {
      this.snapshot.groups.forEach((cg) => {
        if (cg.parent === id) {
          out.push(cg.id)
          walk(cg.id)
        }
      })
    }
    walk(gid)
    return out
  }

  isDescendantGroup(childId: string, ancestorId: string): boolean {
    let g = this.groupById(childId)
    let guard = 0
    while (g && g.parent && guard++ < 40) {
      if (g.parent === ancestorId) return true
      g = this.groupById(g.parent)
    }
    return false
  }

  updateGroup(gid: string, patch: Partial<VetviGroup>) {
    const gy = this.groupY(gid)
    if (!gy) return
    this.tx(() => {
      patchYMap(gy, patch as Record<string, unknown>)
      this.touch()
    })
    this.notify(true)
  }

  cycleGroupFold(gid: string) {
    const g = this.groupById(gid)
    if (!g) return
    const wasOpen = g.fold === 2
    const nf = (g.fold === 2 ? 1 : g.fold === 1 ? 0 : 2) as 0 | 1 | 2
    if (wasOpen && nf < 2) this.prepareGroupCard(gid, nf as 0 | 1)
    this.updateGroup(gid, { fold: nf })
  }

  /** Кэш позиций для карточки группы (fold<2): центрирование на центроиде. */
  prepareGroupCard(gid: string, fold: 0 | 1) {
    const ms = this.allDescNodes(gid)
    let cx = 0
    let cy = 0
    const y0 = 1e9
    const y1 = -1e9
    const hh: Record<string, number> = {}
    ms.forEach((n) => {
      const d = this.geom?.nodeDims(n) ?? { w: NODE_W, h: 90 }
      hh[n.id] = d.h
      cx += n.x + d.w / 2
      cy += n.y + d.h / 2
    })
    if (ms.length) {
      cx /= ms.length
      cy /= ms.length
    } else {
      cx = 0
      cy = 0
    }
    const gx = Math.round(cx - GCARD_W / 2)
    const gy = Math.round(cy - 40)
    void y0
    void y1
    this.tx(() => {
      const gyMap = this.groupY(gid)
      if (!gyMap) return
      gyMap.set('fold', fold)
      gyMap.set('x', gx)
      gyMap.set('y', gy)
      const hhY = plainToYValue(hh)
      gyMap.set('hh', hhY)
      const bboxArr = new Y.Array()
      bboxArr.push([0, 90])
      gyMap.set('bbox', bboxArr)
      this.touch()
    })
  }

  toggleGroupAuto(gid: string) {
    const g = this.groupById(gid)
    if (!g) return
    if (g.auto) {
      const fr = this.geom?.groupRectWorld(g)
      this.tx(() => {
        const gy = this.groupY(gid)
        if (!gy) return
        gy.set('auto', false)
        if (fr) {
          gy.set('fx', fr.x)
          gy.set('fy', fr.y)
          gy.set('fw', fr.w)
          gy.set('fh', fr.h)
        }
        this.touch()
      })
    } else {
      this.tx(() => {
        const gy = this.groupY(gid)
        if (!gy) return
        gy.set('auto', true)
        gy.set('fx', null)
        gy.set('fy', null)
        gy.set('fw', null)
        gy.set('fh', null)
        this.touch()
      })
    }
    this.notify(true)
  }

  ungroup(gid: string) {
    const g = this.groupById(gid)
    if (!g) return
    this.tx(() => {
      const groupsMap = this.doc!.getMap('groups')
      const parent = g.parent ?? null
      this.snapshot.nodes.forEach((n) => {
        if (n.gid === gid) {
          const ym = this.nodeY(n.id)
          if (ym) ym.set('gid', parent)
        }
      })
      this.snapshot.groups.forEach((cg) => {
        if (cg.parent === gid) {
          const cy = groupsMap.get(cg.id)
          if (cy instanceof Y.Map) cy.set('parent', parent)
        }
      })
      groupsMap.delete(gid)
      this.touch()
    })
    this.selGroups.delete(gid)
    if (this.selGroup === gid) this.selGroup = null
    this.notify(true)
    this.toast(`Группа «${g.name}» расформирована`, 'warn')
  }

  leaveGroup(nodeId: string) {
    const n = this.nodeById(nodeId)
    if (!n || !n.gid) return
    const gid = n.gid
    this.updateNode(nodeId, { gid: null })
    const g = this.groupById(gid)
    if (g && this.allDescNodes(gid).length === 0 && !this.groupHasDescNodesY(this.rootMap('groups')!, gid)) {
      this.tx(() => {
        this.doc!.getMap('groups').delete(gid)
      })
    }
    this.notify(true)
    this.toast('Узел исключён из группы', 'warn')
  }

  // ---------------------------
  // Свои типы
  // ---------------------------

  saveCustomType(id: string | null, name: string, color: string, icon: string) {
    this.tx(() => {
      const map = this.doc!.getMap('customTypes')
      const rid = id ?? uid()
      map.set(rid, plainToYValue({ id: rid, name: name.slice(0, 40) || 'Элемент', color, icon }))
      this.touch()
    })
    this.notify(true)
    this.toast(id ? `Тип «${name}» обновлён` : `Тип «${name}» создан`)
  }

  deleteCustomType(id: string) {
    const c = this.customTypeById(id)
    if (!c) return
    this.tx(() => {
      this.doc!.getMap('customTypes').delete(id)
      const nodesMap = this.doc!.getMap('nodes')
      nodesMap.forEach((value) => {
        if (value instanceof Y.Map && value.get('type') === id) value.set('type', 'note')
      })
      this.touch()
    })
    const hidden = this.readListHidden().filter((k) => k !== id)
    this.txSystem(() => {
      this.doc?.getMap('meta').set('listHidden', JSON.stringify(hidden))
    }, 'list-hidden')
    this.notify(true)
    this.toast(`Тип «${c.name}» удалён (его узлы стали заметками)`, 'warn')
  }

  toggleListVis(key: string) {
    const hidden = this.readListHidden()
    const i = hidden.indexOf(key)
    if (i >= 0) hidden.splice(i, 1)
    else hidden.push(key)
    this.txSystem(() => {
      this.doc?.getMap('meta').set('listHidden', JSON.stringify(hidden))
    }, 'list-hidden')
    this.notify(true)
    this.toast(
      hidden.includes(key) ? 'Тип убран из раздела «На холсте»' : 'Тип возвращён в раздел «На холсте»',
    )
  }

  // ---------------------------
  // Встраивание в связь / раскладки
  // ---------------------------

  /** Встройка узла в связь (разрыв пополам). */
  performInsert(
    node: VetviNode | null,
    newNodeSpec: { type: string } | null,
    edgeId: string,
    ptsA: { x: number; y: number }[],
    ptsB: { x: number; y: number }[],
    pos: { x: number; y: number },
  ) {
    const e = this.edgeById(edgeId)
    if (!e) return
    let nid: string
    let nodeRec: Record<string, unknown>
    if (node) {
      nid = node.id
      nodeRec = null as unknown as Record<string, unknown>
    } else {
      const info = this.typeInfo(newNodeSpec?.type ?? 'scene')
      nid = uid()
      nodeRec = {
        id: nid,
        type: newNodeSpec?.type ?? 'scene',
        gid: null,
        x: 0,
        y: 0,
        title: info.name,
        text: '',
        status: 'idea',
        tags: [],
        expand: 1,
        color: null,
        tint: 0,
        dlgWidth: null,
        notes: [],
      }
      if (newNodeSpec?.type === 'dialog') {
        // ensureDialog после вставки
      }
    }
    this.tx(() => {
      const nodesMap = this.doc!.getMap('nodes')
      const edgesMap = this.doc!.getMap('edges')
      if (node) {
        // существующий узел: позиционируем
        const d = this.geom?.nodeDims(node) ?? { w: NODE_W, h: 90 }
        const ym = this.nodeY(node.id)
        if (ym) {
          ym.set('x', Math.round(pos.x - d.w / 2))
          ym.set('y', Math.round(pos.y - d.h / 2))
        }
      } else {
        nodeRec.x = Math.round(pos.x - NODE_W / 2)
        nodeRec.y = Math.round(pos.y - 45)
        nodesMap.set(nid, plainToYValue(nodeRec))
        const ym = nodesMap.get(nid)
        if (ym instanceof Y.Map && nodeRec.type === 'dialog') this.ensureDialogY(ym)
      }
      edgesMap.delete(e.id)
      const mk = (over: Record<string, unknown>) =>
        plainToYValue({
          id: uid(),
          from: '',
          to: '',
          label: '',
          kind: e.kind,
          pts: [],
          lt: 0.5,
          lp: 0,
          fromReply: null,
          bd: { dl: 0, dy: 0, dr: 0 },
          ...over,
        })
      edgesMap.set(uid(), mk({ from: e.from, to: nid, pts: ptsA, fromReply: e.fromReply ?? null }))
      edgesMap.set(uid(), mk({ from: nid, to: e.to, label: e.label, pts: ptsB }))
      if (this.selEdge === e.id) {
        this.selEdge = null
        this.selEdges.clear()
      }
      this.touch()
    })
    this.geom?.flashSpawnNodes([nid])
    this.resolveOverlaps(new Set([nid]))
    this.notify(true)
  }

  /** Автораздвижка перекрывающихся узлов (порт resolveOverlaps, без анимации сдвига — CSS). */
  resolveOverlaps(fixedIds: Set<string>) {
    const pad = 18
    const nodes = this.snapshot.nodes
    const dims = (n: VetviNode) => this.geom?.nodeDims(n) ?? { w: NODE_W, h: 90 }
    const moves = new Map<string, { x: number; y: number }>()
    nodes.forEach((n) => moves.set(n.id, { x: n.x, y: n.y }))
    let changed = false
    for (let it = 0; it < 30; it++) {
      let moved = false
      for (let i = 0; i < nodes.length; i++) {
        if (this.storeCollapsedAncestorOf(nodes[i])) continue
        for (let j = i + 1; j < nodes.length; j++) {
          if (this.storeCollapsedAncestorOf(nodes[j])) continue
          const a = nodes[i]
          const b = nodes[j]
          const da = dims(a)
          const db = dims(b)
          const pa = moves.get(a.id)!
          const pb = moves.get(b.id)!
          const acx = pa.x + da.w / 2
          const acy = pa.y + da.h / 2
          const bcx = pb.x + db.w / 2
          const bcy = pb.y + db.h / 2
          const ox = (da.w + db.w) / 2 + pad - Math.abs(acx - bcx)
          const oy = (da.h + db.h) / 2 + pad - Math.abs(acy - bcy)
          if (ox > 0 && oy > 0) {
            moved = true
            changed = true
            const fx = fixedIds.has(a.id)
            const fy = fixedIds.has(b.id)
            if (ox <= oy) {
              const ax = acx <= bcx ? -1 : 1
              if (fx && !fy) pb.x -= ax * ox
              else if (fy && !fx) pa.x += ax * ox
              else {
                pa.x += (ax * ox) / 2
                pb.x -= (ax * ox) / 2
              }
            } else {
              const ay = acy <= bcy ? -1 : 1
              if (fx && !fy) pb.y -= ay * oy
              else if (fy && !fx) pa.y += ay * oy
              else {
                pa.y += (ay * oy) / 2
                pb.y -= (ay * oy) / 2
              }
            }
          }
        }
      }
      if (!moved) break
    }
    if (!changed) return
    const updates: { id: string; x: number; y: number }[] = []
    nodes.forEach((n) => {
      if (fixedIds.has(n.id)) return
      const m = moves.get(n.id)!
      let x = m.x
      let y = m.y
      if (this.snapOn) {
        x = Math.round(x / GRID) * GRID
        y = Math.round(y / GRID) * GRID
      }
      if (x !== n.x || y !== n.y) updates.push({ id: n.id, x, y })
    })
    if (!updates.length) return
    this.tx(() => {
      updates.forEach((u) => {
        const ym = this.nodeY(u.id)
        if (ym) {
          ym.set('x', u.x)
          ym.set('y', u.y)
        }
      })
      this.touch()
    })
  }

  snapOn = true
  gridOn = true

  setSnap(on: boolean) {
    this.snapOn = on
    this.notify(true)
  }

  setGrid(on: boolean) {
    this.gridOn = on
    this.notify(true)
  }

  /** Раскладка выделения по строкам + мосты (порт layoutRows). */
  layoutRows(ids: string[], k: number) {
    const rows: string[][] = []
    for (let i = 0; i < ids.length; i += k) rows.push(ids.slice(i, i + k))
    let maxW = 0
    let maxH = 0
    ids.forEach((id) => {
      const n = this.nodeById(id)
      if (!n) return
      const d = this.geom?.nodeDims(n) ?? { w: NODE_W, h: 90 }
      maxW = Math.max(maxW, d.w)
      maxH = Math.max(maxH, d.h)
    })
    const colStep = maxW + 70
    const rowStep = maxH + 120
    let mnX = 1e9
    let mnY = 1e9
    ids.forEach((id) => {
      const n = this.nodeById(id)
      if (!n) return
      mnX = Math.min(mnX, n.x)
      mnY = Math.min(mnY, n.y)
    })
    if (this.snapOn) {
      mnX = Math.round(mnX / GRID) * GRID
      mnY = Math.round(mnY / GRID) * GRID
    }
    const newBridges: string[] = []
    this.tx(() => {
      const edgesMap = this.doc!.getMap('edges')
      rows.forEach((row, i) => {
        row.forEach((id, j) => {
          const ym = this.nodeY(id)
          if (!ym) return
          ym.set('x', Math.round(mnX + j * colStep))
          ym.set('y', Math.round(mnY + i * rowStep))
        })
      })
      const idSet = new Set(ids)
      edgesMap.forEach((ev) => {
        if (!(ev instanceof Y.Map)) return
        const from = ev.get('from')
        const to = ev.get('to')
        if (
          typeof from === 'string' &&
          typeof to === 'string' &&
          idSet.has(from) &&
          idSet.has(to) &&
          ev.get('kind') === 'bridge'
        )
          ev.set('kind', 'flow')
      })
      for (let ri = 0; ri < rows.length - 1; ri++) {
        const U = rows[ri][rows[ri].length - 1]
        const L = rows[ri + 1][0]
        let existing: Y.Map<unknown> | null = null
        edgesMap.forEach((ev) => {
          if (ev instanceof Y.Map && ev.get('from') === U && ev.get('to') === L) existing = ev
        })
        if (existing) {
          ;(existing as Y.Map<unknown>).set('kind', 'bridge')
          if (!(existing as Y.Map<unknown>).get('bd'))
            (existing as Y.Map<unknown>).set('bd', plainToYValue({ dl: 0, dy: 0, dr: 0 }))
        } else {
          const eid = uid()
          edgesMap.set(
            eid,
            plainToYValue({
              id: eid,
              from: U,
              to: L,
              label: '',
              kind: 'bridge',
              pts: [],
              lt: 0.5,
              lp: 0,
              fromReply: null,
              bd: { dl: 0, dy: 0, dr: 0 },
            }),
          )
          newBridges.push(eid)
        }
      }
      this.touch()
    })
    if (newBridges.length) this.geom?.flashSpawnEdge(newBridges[newBridges.length - 1])
    this.notify(true)
  }

  /** Мост между двумя узлами. */
  createBridgeBetween(srcId: string, dstId: string) {
    const ex = this.snapshot.edges.find((e) => e.from === srcId && e.to === dstId)
    if (ex) {
      this.setEdgeKind(ex.id, 'bridge')
    } else {
      const eid = uid()
      this.tx(() => {
        this.doc!.getMap('edges').set(
          eid,
          plainToYValue({
            id: eid,
            from: srcId,
            to: dstId,
            label: '',
            kind: 'bridge',
            pts: [],
            lt: 0.5,
            lp: 0,
            fromReply: null,
            bd: { dl: 0, dy: 0, dr: 0 },
          }),
        )
        this.touch()
      })
      this.geom?.flashSpawnEdge(eid)
    }
    this.notify(true)
    this.toast('Мост создан')
  }

  bridgePairCandidate(): { a: string; b: string } | null {
    if (this.sel.size !== 2 || this.selGroups.size !== 0) return null
    const it = this.sel.values()
    const a = this.nodeById(it.next().value as string)
    const b = this.nodeById(it.next().value as string)
    if (!a || !b) return null
    const hasOut = (n: VetviNode) => this.snapshot.edges.some((e) => e.from === n.id)
    const hasIn = (n: VetviNode) => this.snapshot.edges.some((e) => e.to === n.id)
    if (!hasOut(a) && !hasIn(b)) return { a: a.id, b: b.id }
    if (!hasOut(b) && !hasIn(a)) return { a: b.id, b: a.id }
    return null
  }

  /** Публичный тост (используется холстом). */
  showToast(message: string, kind: ToastKind = 'ok') {
    this.toast(message, kind)
  }

  /** Удалить узлы по списку id (для отмены дублирования). */
  deleteNodesById(ids: string[]) {
    if (!ids.length) return
    this.tx(() => {
      const nodesMap = this.doc!.getMap('nodes')
      const edgesMap = this.doc!.getMap('edges')
      const idSet = new Set(ids)
      const deadEdges: string[] = []
      edgesMap.forEach((ev, eid) => {
        if (!(ev instanceof Y.Map)) return
        const from = ev.get('from')
        const to = ev.get('to')
        if ((typeof from === 'string' && idSet.has(from)) || (typeof to === 'string' && idSet.has(to))) deadEdges.push(eid)
      })
      deadEdges.forEach((eid) => edgesMap.delete(eid))
      ids.forEach((id) => nodesMap.delete(id))
      this.touch()
    })
    this.notify(true)
  }

  /** Прямоугольное выделение (вызывается холстом во время marquee). */
  marqueeSelect(
    wa: { x: number; y: number },
    wb: { x: number; y: number },
    base: { n: string[]; g: string[] } | null,
  ) {
    const sel = new Set<string>(base ? base.n : [])
    const selG = new Set<string>(base ? base.g : [])
    this.snapshot.nodes.forEach((n) => {
      if (this.storeCollapsedAncestorOf(n)) return
      const d = this.geom?.nodeDims(n) ?? { w: NODE_W, h: 90 }
      if (n.x < wb.x && n.x + d.w > wa.x && n.y < wb.y && n.y + d.h > wa.y) sel.add(n.id)
    })
    this.snapshot.groups.forEach((g) => {
      if (this.groupInsideCollapsed(g)) return
      const r = this.geom?.groupRectWorld(g)
      if (!r) return
      if (r.x < wb.x && r.x + r.w > wa.x && r.y < wb.y && r.y + r.h > wa.y) selG.add(g.id)
    })
    this.sel = sel
    this.selGroups = selG
    this.selEdges.clear()
    this.selEdge = null
    this.selGroup = null
    this.notify(true)
  }

  /**
   * Переподключение концов связей (порт inDrag/outDrag/repOutDrag/rpDrag commit).
   */
  reconnectEnds(
    edgeIds: string[],
    side: 'from' | 'to',
    targetNodeId: string,
    fromReply: string | null,
    excludeNodeId: string | null,
  ) {
    const list = edgeIds.map((id) => this.edgeById(id)).filter((e): e is VetviEdge => !!e)
    if (!list.length) return
    let applied = 0
    this.tx(() => {
      list.forEach((ed) => {
        const ym = this.edgeY(ed.id)
        if (!ym) return
        if (side === 'to') {
          if (ed.from === targetNodeId) return
          ym.set('to', targetNodeId)
          applied++
        } else {
          if (ed.to === targetNodeId) return
          ym.set('from', targetNodeId)
          ym.set('fromReply', fromReply ?? null)
          applied++
        }
      })
      this.touch()
    })
    if (applied > 0) {
      this.notify(true)
      if (applied > 1) this.showToast('Переподключено связей: ' + applied)
      else this.showToast(side === 'to' ? 'Входящая стрелка переподключена' : 'Исходящая стрелка переподключена')
    }
    void excludeNodeId
  }

  // ---------------------------
  // Undo / redo
  // ---------------------------

  canUndo(): boolean {
    return !!this.undoManager && this.undoManager.undoStack.length > 0
  }

  canRedo(): boolean {
    return !!this.undoManager && this.undoManager.redoStack.length > 0
  }

  undo() {
    if (!this.undoManager || !this.undoManager.undoStack.length) return
    this.undoManager.undo()
    this.cleanupSelectionToExisting()
    this.notify(true)
    this.toast('Отменено', 'warn')
  }

  redo() {
    if (!this.undoManager || !this.undoManager.redoStack.length) return
    this.undoManager.redo()
    this.cleanupSelectionToExisting()
    this.notify(true)
    this.toast('Повторено')
  }

  // ---------------------------
  // UI-состояние (контекстное меню, модалки)
  // ---------------------------

  openCtxMenu(x: number, y: number, items: CtxEntry[]) {
    this.ctxMenuState = { x, y, items }
    this.notify(true)
  }

  closeCtxMenu() {
    if (!this.ctxMenuState) return
    this.ctxMenuState = null
    this.notify(true)
  }

  openDlgEditor(nodeId: string | null) {
    this.dlgEditorNodeId = nodeId
    this.notify(true)
  }

  closeNoteEditor() {
    this.noteEditorState = null
    this.notify(true)
  }

  closeNoteView() {
    this.noteViewState = null
    this.notify(true)
  }

  openNoteEditor(nodeId: string, idx: number) {
    const n = this.nodeById(nodeId)
    if (!n) return
    if (idx < 0 && (n.notes?.length ?? 0) >= NOTE_MAX) {
      this.toast(`Максимум ${NOTE_MAX} заметки`, 'warn')
      return
    }
    this.noteEditorState = { nodeId, idx }
    this.notify(true)
  }

  openNoteView(nodeId: string, idx: number) {
    this.noteViewState = { nodeId, idx }
    this.notify(true)
  }

  openTypeEditor(existingId: string | null) {
    this.ctypeEditorState = { existingId }
    this.notify(true)
  }

  setGroupModal(open: boolean) {
    this.groupModalOpenState = open
    this.notify(true)
  }

  openDstWin(ids: string[], k: number) {
    this.dstWinState = { ids, k }
    this.notify(true)
  }

  setDstK(k: number) {
    if (!this.dstWinState) return
    const max = this.dstWinState.ids.length
    const nk = clamp(isNaN(k) ? 1 : k, 1, max)
    this.dstWinState = { ids: this.dstWinState.ids, k: nk }
    this.layoutRows(this.dstWinState.ids, nk)
    this.notify(true)
  }

  closeDstWin() {
    this.dstWinState = null
    this.notify(true)
  }

  setHelpModal(open: boolean) {
    this.helpModalOpenState = open
    this.notify(true)
  }

  togglePalFold(key: string) {
    this.palFoldState = { ...this.palFoldState, [key]: !this.palFoldState[key] }
    this.notify(true)
  }

  toggleOvFold(gid: string) {
    this.ovFoldState = { ...this.ovFoldState, [gid]: !this.ovFoldState[gid] }
    this.notify(true)
  }

  /** Распределить выделение по строкам (открытие окна/спецслучай 2 узлов). */
  openDistribute() {
    const ids: string[] = []
    this.sel.forEach((id) => {
      if (this.nodeById(id)) ids.push(id)
    })
    if (ids.length < 2) {
      this.toast('Выделите минимум два элемента', 'warn')
      return
    }
    let minX = 1e9
    let minY = 1e9
    let maxX = -1e9
    let maxY = -1e9
    ids.forEach((id) => {
      const n = this.nodeById(id)!
      minX = Math.min(minX, n.x)
      minY = Math.min(minY, n.y)
      maxX = Math.max(maxX, n.x + NODE_W)
      maxY = Math.max(maxY, n.y + 90)
    })
    const horizontal = maxX - minX >= maxY - minY
    ids.sort((a, b) => {
      const na = this.nodeById(a)!
      const nb = this.nodeById(b)!
      if (horizontal) return na.x - nb.x || na.y - nb.y
      return na.y - nb.y || na.x - nb.x
    })
    if (ids.length === 2) {
      this.layoutRows(ids, 1)
      this.toast('Две строки по одному элементу, стык соединён мостом')
      return
    }
    this.layoutRows(ids, Math.min(4, ids.length))
    this.openDstWin(ids, Math.min(4, ids.length))
  }

  // ---------------------------
  // Экспорт / импорт
  // ---------------------------

  exportJson(): string | null {
    if (!this.ydoc) return null
    return exportPrototypeJson(this.ydoc, this.bendMode, this.vp)
  }

  exportTxt(): string | null {
    const snap = this.snapshot
    if (!snap.ready) return null
    return buildTxtExport(
      {
        metaName: snap.meta.name,
        nodes: snap.nodes,
        edges: snap.edges,
        groups: snap.groups,
        customTypes: snap.customTypes,
      },
      {
        typeName: (key) => this.typeInfo(key).name,
        isBaseType: (key) => key in BASE_TYPES,
        charName: (id) => {
          const c = id ? this.nodeById(id) : null
          return c ? c.title : '(неизвестный)'
        },
        groupOfNode: (n) => (n.gid ? this.groupById(n.gid) : null),
        membersOf: (gid) => this.membersOf(gid),
        allDescNodes: (gid) => this.allDescNodes(gid),
        findReply: (replies, id) => {
          const walk = (arr: DialogReply[]): DialogReply | null => {
            for (const r of arr) {
              if (r.id === id) return r
              const f = walk(r.children ?? [])
              if (f) return f
            }
            return null
          }
          return walk(replies)
        },
      },
    )
  }

  async importJson(text: string): Promise<boolean> {
    try {
      const json: unknown = JSON.parse(text)
      validateProjectJson(json)
      const proto = json as Record<string, unknown>

      // Legacy online-формат → форма прототипа.
      let protoShaped = proto
      if (proto.app !== 'vetvi') {
        const data = proto.data as Record<string, unknown>
        const els = (data.elements as Record<string, Record<string, unknown>>) ?? {}
        protoShaped = {
          meta: isPlainObject(data.meta) ? data.meta : {},
          nodes: Object.values(els).map((el) => {
            const t = el.type === 'dialogue' ? 'dialog' : el.type === 'text' ? 'scene' : 'note'
            const textVal = typeof el.text === 'string' ? el.text : ''
            return {
              id: el.id,
              type: t,
              x: el.x ?? 0,
              y: el.y ?? 0,
              title: String(textVal.split('\n')[0] ?? '').slice(0, 80) || BASE_TYPES[t as 'note']?.name,
              text: textVal,
            }
          }),
          edges: [],
          customTypes: [],
          groups: [],
          listHidden: [],
        }
      }

      const plain = normalizeProject(protoShaped)
      this.applyPlainProject(plain)
      // Режим изгиба стрелок из файла (как в прототипе).
      const pb = (protoShaped as { bend?: unknown }).bend
      if (pb === 'ortho90' || pb === 'ortho45' || pb === 'smooth') this.setBendMode(pb)
      this.scheduleSave()
      this.toast('Проект импортирован')
      this.notify(true)
      return true
    } catch (error) {
      console.warn('importJson failed', error)
      const message = error instanceof Error ? error.message : 'Не удалось прочитать файл'
      this.toast(message, 'err')
      return false
    }
  }

  /** Замена содержимого документа нормализованным плоским проектом. */
  private applyPlainProject(plain: {
    meta: { name: string; created: string; modified: string }
    nodes: VetviNode[]
    edges: VetviEdge[]
    customTypes: CustomTypeRecord[]
    groups: VetviGroup[]
    listHidden: string[]
  }) {
    const doc = this.ydoc
    if (!doc) return
    doc.transact(() => {
      for (const root of DATA_ROOTS) {
        const map = doc.getMap(root)
        const keys = Array.from(map.keys())
        keys.forEach((k) => map.delete(k))
      }
      const fill = (root: string, list: Record<string, unknown>[]) => {
        const map = doc.getMap(root)
        list.forEach((item) => {
          const id = typeof item.id === 'string' ? item.id : uid()
          map.set(id, plainToYValue({ ...item, id }))
        })
      }
      fill('customTypes', plain.customTypes as unknown as Record<string, unknown>[])
      fill('nodes', plain.nodes as unknown as Record<string, unknown>[])
      fill('edges', plain.edges as unknown as Record<string, unknown>[])
      fill('groups', plain.groups as unknown as Record<string, unknown>[])
      doc.getMap('nodes').forEach((value) => {
        if (value instanceof Y.Map && value.get('type') === 'dialog') this.ensureDialogY(value)
      })
      const meta = doc.getMap('meta')
      meta.set('name', plain.meta.name || 'Без названия')
      if (plain.meta.created) meta.set('created', plain.meta.created)
      meta.set('modified', plain.meta.modified || new Date().toISOString())
      meta.set('listHidden', JSON.stringify(plain.listHidden))
      meta.set('updatedAt', Date.now())
      meta.delete('roomId')
    }, 'import-project')
    this.clearSel()
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
      this.toast('Не удалось скачать файл', 'err')
    }
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
      await this.copyShareLink()
      return this.shareUrl
    }

    const room = randomId(24)
    this.connectRoom(room)
    writeHashParams({ room, project: this.projectId, copy: null })
    this.toast('Комната открыта — отправьте ссылку соавтору')
    this.notify(true)
    return this.shareUrl
  }

  leaveRoom() {
    if (!this.provider && !this.roomId) {
      return
    }
    this.disconnectRoom()
    if (this.mode !== 'copy' && this.ydoc) {
      this.ydoc.getMap('meta').delete('roomId')
      this.scheduleSave()
    }
    this.toast('Комната отключена — проект снова только локальный')
    this.notify(true)
  }

  private connectRoom(room: string) {
    this.disconnectRoom()
    if (!this.ydoc) return

    this.roomId = room

    if (this.mode !== 'copy') {
      this.ydoc.transact(() => {
        this.ydoc!.getMap('meta').set('roomId', room)
        this.ydoc!.getMap('meta').set('updatedAt', Date.now())
      }, 'set-room-id')
    }

    this.provider = new VetviProvider(room, this.ydoc, {
      onStatus: (status) => {
        const previous = this.connection
        this.connection = status
        if (status === 'error' && previous !== 'error') {
          this.toast('Сервер синхронизации недоступен — работаем локально, переподключаемся…', 'err')
        }
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
      const baseState = toPlainProject(doc)
      const copyId = uid()
      const meta: CopyMeta = {
        copyId,
        name: `${this.snapshot.meta?.name || 'Проект'} — копия`,
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
      this.toast('Не удалось создать копию', 'err')
      return false
    }
  }

  async openCopy(copyId: string) {
    const record = await getCopy(copyId)
    if (!record) {
      this.toast('Копия не найдена', 'err')
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
    this.normalizeDocOnLoad()

    this.undoManager = new Y.UndoManager(
      [doc.getMap('nodes'), doc.getMap('edges'), doc.getMap('groups'), doc.getMap('customTypes')],
      { captureTimeout: 400, trackedOrigins: new Set([UNDO_ORIGIN, DRAG_ORIGIN]) },
    )
    this.undoManager.on('stack-item-popped', () => {
      this.cleanupSelectionToExisting()
      this.notify(true)
    })

    doc.on('update', () => {
      this.notify()
      this.scheduleSave()
    })

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
    const { deleteCopy: delCopy } = await import('./idb')
    await delCopy(copyId)
    await this.refreshCopies()
    this.toast('Копия удалена')
  }

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
      this.toast('У копии нет комнаты оригинала — используйте экспорт JSON', 'err')
      return false
    }

    try {
      const current = toPlainProject(doc)
      const base = this.currentCopyRecord?.baseState ?? {}
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
          this.mailboxDoc!.getMap('requests').set(request.id, request as unknown as Record<string, unknown>)
        }, 'merge-send')
      }

      this.outbox = [request, ...this.outbox.filter((r) => r.id !== request.id)]
      this.persistOutbox()

      if (request.status === 'queued') {
        this.toast('Владелец офлайн — merge-запрос в очереди, отправим при подключении', 'warn')
      } else {
        this.toast(
          `Merge-запрос отправлен (+${request.stats.added} / ~${request.stats.updated} / −${request.stats.deleted})`,
        )
      }
      this.notify(true)
      return true
    } catch (error) {
      console.error('sendMerge failed', error)
      this.toast('Не удалось отправить merge-запрос', 'err')
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
          this.mailboxDoc!.getMap('requests').set(request.id, request as unknown as Record<string, unknown>)
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
      this.toast('Merge-комната не подключена', 'err')
      return
    }

    const remote = this.mailboxDoc.getMap('requests').get(requestId)
    if (!remote) {
      this.toast('Merge-запрос не найден', 'err')
      return
    }

    const plain = yValueToPlain(remote) as Record<string, unknown>
    const delta = (plain.delta ?? {}) as MergeRequest['delta']
    const senderName = String(plain.senderName ?? 'Неизвестный')

    try {
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
      this.toast('Ошибка применения merge-запроса', 'err')
    }
  }

  async rejectMerge(requestId: string) {
    if (!this.mailboxDoc) return
    try {
      const plain = yValueToPlain(this.mailboxDoc.getMap('requests').get(requestId)) as
        | Record<string, unknown>
        | undefined
      if (!plain) {
        this.toast('Merge-запрос не найден', 'err')
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
      this.toast('Не удалось отклонить merge-запрос', 'err')
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
    const doc = this.ydoc
    if (!bytes) {
      this.toast('Backup не найден', 'err')
      return
    }
    if (!doc) return

    try {
      const backupDoc = new Y.Doc()
      try {
        Y.applyUpdate(backupDoc, bytes, 'backup-snapshot')
        const backupPlain = toPlainProject(backupDoc)
        const currentPlain = toPlainProject(doc)
        const delta = computeDelta(this.projectId ?? 'unknown', currentPlain, backupPlain)
        applyDelta(doc, delta)
      } finally {
        try {
          backupDoc.destroy()
        } catch {
          // ignore
        }
      }

      this.clearSel()
      this.scheduleSave()
      this.toast('Состояние восстановлено из backup')
      this.notify(true)
    } catch (error) {
      console.error('restoreBackup failed', error)
      this.toast('Не удалось восстановить backup', 'err')
    }
  }
}

/* ════════════════════════════════════════════════════════════ */
/* Преобразования plain → типизированные записи                  */
/* ════════════════════════════════════════════════════════════ */

function cloneReplies(replies: DialogReply[]): DialogReply[] {
  return replies.map((r) => ({
    id: r.id,
    speaker: r.speaker,
    text: r.text,
    children: cloneReplies(r.children ?? []),
  }))
}

function plainToNode(id: string, rec: Record<string, unknown>): VetviNode {
  const type = String(rec.type ?? 'note')
  const dlgRaw = isPlainObject(rec.dialog) ? rec.dialog : null
  const node: VetviNode = {
    id,
    type,
    gid: typeof rec.gid === 'string' ? rec.gid : null,
    x: Number(rec.x ?? 0),
    y: Number(rec.y ?? 0),
    title: String(rec.title ?? ''),
    text: String(rec.text ?? ''),
    status: (String(rec.status ?? 'idea') as NodeStatus) ?? 'idea',
    tags: Array.isArray(rec.tags) ? (rec.tags as string[]).map(String) : [],
    expand: (rec.expand === 0 || rec.expand === 1 || rec.expand === 2 ? rec.expand : 1) as 0 | 1 | 2,
    color: typeof rec.color === 'string' ? rec.color : null,
    tint: Number(rec.tint ?? 0),
    dlgWidth: typeof rec.dlgWidth === 'number' ? rec.dlgWidth : null,
    notes: Array.isArray(rec.notes)
      ? (rec.notes as Record<string, unknown>[]).map((m) => ({
          title: String(m?.title ?? ''),
          html: String(m?.html ?? ''),
          hidden: !!m?.hidden,
        }))
      : [],
  }
  if (type === 'dialog' && dlgRaw) {
    node.dialog = {
      participants: Array.isArray(dlgRaw.participants)
        ? (dlgRaw.participants as string[]).map(String)
        : [],
      description: String(dlgRaw.description ?? ''),
      replies: Array.isArray(dlgRaw.replies) ? (dlgRaw.replies as unknown as DialogReply[]) : [],
    }
  }
  return node
}

function plainToEdge(id: string, rec: Record<string, unknown>): VetviEdge {
  return {
    id,
    from: String(rec.from ?? ''),
    to: String(rec.to ?? ''),
    label: String(rec.label ?? ''),
    kind: (['flow', 'choice', 'cond', 'bridge'].includes(String(rec.kind))
      ? String(rec.kind)
      : 'flow') as EdgeKind,
    pts: Array.isArray(rec.pts)
      ? (rec.pts as { x: number; y: number }[]).map((p) => ({ x: Number(p?.x ?? 0), y: Number(p?.y ?? 0) }))
      : [],
    lt: Number(rec.lt ?? 0.5),
    lp: Number(rec.lp ?? 0),
    fromReply: typeof rec.fromReply === 'string' ? rec.fromReply : null,
    bd: isPlainObject(rec.bd)
      ? {
          dl: Number(rec.bd.dl ?? 0),
          dy: Number(rec.bd.dy ?? 0),
          dr: Number(rec.bd.dr ?? 0),
        }
      : { dl: 0, dy: 0, dr: 0 },
  }
}

function plainToGroup(id: string, rec: Record<string, unknown>): VetviGroup {
  const bboxRaw = rec.bbox
  const hhRaw = rec.hh
  return {
    id,
    name: String(rec.name ?? 'Группа'),
    fold: ((rec.fold === 0 || rec.fold === 1 || rec.fold === 2 ? rec.fold : 2) as 0 | 1 | 2) ?? 2,
    x: Number(rec.x ?? 0),
    y: Number(rec.y ?? 0),
    parent: typeof rec.parent === 'string' ? rec.parent : null,
    color: typeof rec.color === 'string' ? rec.color : null,
    alpha: typeof rec.alpha === 'number' ? rec.alpha : 0.55,
    badge: !!rec.badge,
    bbox:
      Array.isArray(bboxRaw) && bboxRaw.length === 2
        ? [Number(bboxRaw[0]), Number(bboxRaw[1])]
        : null,
    hh:
      isPlainObject(hhRaw)
        ? Object.fromEntries(Object.entries(hhRaw).map(([k, v]) => [k, Number(v) || 90]))
        : null,
    auto: rec.auto === true,
    fx: typeof rec.fx === 'number' ? rec.fx : null,
    fy: typeof rec.fy === 'number' ? rec.fy : null,
    fw: typeof rec.fw === 'number' ? rec.fw : null,
    fh: typeof rec.fh === 'number' ? rec.fh : null,
  }
}
