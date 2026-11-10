/**
 * Модель данных «Ветвей» — полный порт vetvi33.html (прототип v18)
 * с сохранением совместимости формата JSON-файлов прототипа.
 */

export const SCHEMA_VERSION = 18

export type VetviMode = 'project' | 'copy'
/** офлайн | подключение | подключено | ошибка */
export type ConnectionState = 'offline' | 'connecting' | 'connected' | 'error'

/* ═══════════ Базовые словари ═══════════ */

export type BaseTypeKey =
  | 'scene'
  | 'char'
  | 'quest'
  | 'dialog'
  | 'skill'
  | 'branch'
  | 'event'
  | 'note'

export type NodeStatus = 'idea' | 'draft' | 'done'
export type EdgeKind = 'flow' | 'choice' | 'cond' | 'bridge'
export type BendMode = 'smooth' | 'ortho90' | 'ortho45'

export interface TypeInfo {
  name: string
  color: string
  icon: string
}

export const BASE_TYPES: Record<BaseTypeKey, TypeInfo> = {
  scene: { name: 'Сцена', color: '#e2a54e', icon: 'scene' },
  char: { name: 'Персонаж', color: '#9cb878', icon: 'char' },
  quest: { name: 'Квест', color: '#cf6d4f', icon: 'quest' },
  dialog: { name: 'Диалог', color: '#cbbd92', icon: 'dialog' },
  skill: { name: 'Навык', color: '#7fb5a2', icon: 'skill' },
  branch: { name: 'Развилка', color: '#d6c96a', icon: 'branch' },
  event: { name: 'Событие', color: '#aab1bb', icon: 'event' },
  note: { name: 'Заметка', color: '#8b929c', icon: 'note' },
}

export const STATUS_RU: Record<NodeStatus, string> = {
  idea: 'идея',
  draft: 'в работе',
  done: 'готово',
}

export const KINDS_RU: Record<EdgeKind, string> = {
  flow: 'обычная',
  choice: 'выбор',
  cond: 'условие',
  bridge: 'мост',
}

export const FOLD_NAMES = ['Компакт', 'Список', 'Развёрнута']

export const PALETTE_COLORS = [
  '#e2a54e',
  '#e0b46b',
  '#d0714e',
  '#cf6b5a',
  '#c9857a',
  '#d6c96a',
  '#b7b26a',
  '#9cb878',
  '#7fb5a2',
  '#cbbd92',
  '#aab1bb',
  '#8b929c',
]

/* ═══════════ Сущности проекта ═══════════ */

export interface DialogReply {
  id: string
  speaker: string | null
  text: string
  children: DialogReply[]
}

export interface DialogData {
  participants: string[]
  description: string
  replies: DialogReply[]
}

export interface NoteRecord {
  title: string
  html: string
  hidden: boolean
}

export interface VetviNode {
  id: string
  type: string
  gid: string | null
  x: number
  y: number
  title: string
  text: string
  status: NodeStatus
  tags: string[]
  expand: 0 | 1 | 2
  color: string | null
  tint: number
  dlgWidth: number | null
  dialog?: DialogData
  notes: NoteRecord[]
}

export interface EdgePt {
  x: number
  y: number
}

export interface BridgeOffsets {
  dl: number
  dy: number
  dr: number
}

export interface VetviEdge {
  id: string
  from: string
  to: string
  label: string
  kind: EdgeKind
  pts: EdgePt[]
  lt: number
  lp: number
  fromReply: string | null
  bd: BridgeOffsets
}

export interface VetviGroup {
  id: string
  name: string
  fold: 0 | 1 | 2
  x: number
  y: number
  parent: string | null
  color: string | null
  alpha: number
  badge: boolean
  bbox: [number, number] | null
  hh: Record<string, number> | null
  auto: boolean
  fx: number | null
  fy: number | null
  fw: number | null
  fh: number | null
}

export interface CustomTypeRecord {
  id: string
  name: string
  color: string
  icon: string
}

export interface VetviViewport {
  x: number
  y: number
  z: number
}

/* ═══════════ Проект (плоский формат, совместим с прототипом v18) ═══════════ */

export interface PlainProject {
  meta: {
    name: string
    created: string
    modified: string
  }
  nodes: VetviNode[]
  edges: VetviEdge[]
  customTypes: CustomTypeRecord[]
  groups: VetviGroup[]
  listHidden: string[]
}

/* ═══════════ Merge ═══════════ */

export const MERGE_ROOTS = ['nodes', 'edges', 'groups', 'customTypes'] as const
export type MergeRoot = (typeof MERGE_ROOTS)[number]

export interface RootDelta {
  added: Record<string, Record<string, unknown>>
  updated: Record<string, Record<string, unknown>>
  deleted: string[]
}

export interface MergeDelta {
  baseProjectId: string
  createdAt: number
  sections: Partial<Record<MergeRoot, RootDelta>>
}

export interface MergeStats {
  added: number
  updated: number
  deleted: number
}

export type MergeStatus = 'queued' | 'sent' | 'applied' | 'rejected' | 'failed'

export interface MergeRequest {
  id: string
  senderId: string
  senderName: string
  copyId: string
  sourceRoomId: string | null
  createdAt: number
  delta: MergeDelta
  stats: MergeStats
  status: MergeStatus
}

/* ═══════════ Копии и бэкапы ═══════════ */

export interface CopyMeta {
  copyId: string
  name: string
  sourceProjectId: string
  sourceRoomId: string | null
  createdAt: number
  lastOpenedAt?: number
}

export interface CopyRecord {
  meta: CopyMeta
  /** base64 полного Yjs-update на момент копирования */
  snapshotUpdate: string
  /** плоский JSON-срез оригинала на момент копирования (baseline для merge) */
  baseState: Record<string, Record<string, unknown>>
}

export interface BackupMeta {
  id: string
  projectId: string
  createdAt: number
  label: string
}

export interface BackupRecord {
  meta: BackupMeta
  /** base64 Yjs-update */
  update: string
}

/* ═══════════ Presence ═══════════ */

export interface PeerInfo {
  clientId: number
  name: string
  color: string
  isSelf: boolean
}

export type SaveState = 'saved' | 'saving'
export type ToastKind = 'ok' | 'warn' | 'err'

export interface ToastItem {
  id: number
  message: string
  kind: ToastKind
}

/* ═══════════ Контекстное меню ═══════════ */

export interface CtxItem {
  ico?: string
  dot?: string
  label: string
  danger?: boolean
  head?: string
  fn?: () => void
}

/** Элемент контекстного меню или разделитель '-'. */
export type CtxEntry = CtxItem | '-'

/* ═══════════ Снапшот для React ═══════════ */

export interface VetviSnapshot {
  ready: boolean
  mode: VetviMode
  meta: { projectId: string; name: string; createdAt: number; updatedAt: number }
  nodes: VetviNode[]
  edges: VetviEdge[]
  groups: VetviGroup[]
  customTypes: CustomTypeRecord[]
  listHidden: string[]
  bendMode: BendMode
  snapOn: boolean
  gridOn: boolean
  /** локальное выделение */
  sel: string[]
  selGroups: string[]
  selEdges: string[]
  selGroup: string | null
  selEdge: string | null
  /* UI-состояние */
  ctxMenu: { x: number; y: number; items: CtxEntry[] } | null
  dlgEditorNodeId: string | null
  noteEditor: { nodeId: string; idx: number } | null
  noteView: { nodeId: string; idx: number } | null
  ctypeEditor: { existingId: string | null } | null
  groupModalOpen: boolean
  dstWin: { ids: string[]; k: number } | null
  helpModalOpen: boolean
  palFold: Record<string, boolean>
  ovFold: Record<string, boolean>
  /* Коллаборация */
  connection: ConnectionState
  roomActive: boolean
  roomId: string | null
  shareUrl: string | null
  peers: PeerInfo[]
  peersCount: number
  mailboxActive: boolean
  copies: CopyMeta[]
  incoming: MergeRequest[]
  outgoing: MergeRequest[]
  backups: BackupMeta[]
  copyMeta: CopyMeta | null
  saveState: SaveState
  userName: string
  userColor: string
  autosaveFlash: number
  toasts: ToastItem[]
}

/** Плейсхолдер-снапшот до инициализации стора (детерминирован для SSR). */
export function emptySnapshot(): VetviSnapshot {
  return {
    ready: false,
    mode: 'project',
    meta: { projectId: '', name: 'Без названия', createdAt: 0, updatedAt: 0 },
    nodes: [],
    edges: [],
    groups: [],
    customTypes: [],
    listHidden: [],
    bendMode: 'smooth',
    snapOn: true,
    gridOn: true,
    sel: [],
    selGroups: [],
    selEdges: [],
    selGroup: null,
    selEdge: null,
    ctxMenu: null,
    dlgEditorNodeId: null,
    noteEditor: null,
    noteView: null,
    ctypeEditor: null,
    groupModalOpen: false,
    dstWin: null,
    helpModalOpen: false,
    palFold: {},
    ovFold: {},
    connection: 'offline',
    roomActive: false,
    roomId: null,
    shareUrl: null,
    peers: [],
    peersCount: 0,
    mailboxActive: false,
    copies: [],
    incoming: [],
    outgoing: [],
    backups: [],
    copyMeta: null,
    saveState: 'saved',
    userName: '',
    userColor: '#8b929c',
    autosaveFlash: 0,
    toasts: [],
  }
}
