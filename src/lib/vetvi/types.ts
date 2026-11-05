/**
 * Общие типы слоя состояния «Ветвей».
 * Соответствуют ТЗ (TD.md, раздел 10 — модель данных).
 */

export const SCHEMA_VERSION = 1

export type VetviMode = 'project' | 'copy'

/** офлайн | подключение | подключено | ошибка */
export type ConnectionState = 'offline' | 'connecting' | 'connected' | 'error'

export type ElementType = 'note' | 'dialogue' | 'text'

export interface ElementRecord {
  id: string
  type: ElementType
  x: number
  y: number
  width: number
  height: number
  text: string
  createdAt: number
  updatedAt: number
}

export interface ProjectMeta {
  projectId: string
  name: string
  schemaVersion: number
  createdAt: number
  updatedAt: number
  createdBy?: string
  sourceProjectId?: string
}

/** Плоский (JSON) срез Yjs-документа — формат экспорта `vetvi-project`. */
export interface PlainProject {
  meta: Record<string, unknown>
  elements: Record<string, Record<string, unknown>>
  connections: Record<string, Record<string, unknown>>
  dialogues: Record<string, Record<string, unknown>>
  notes: Record<string, Record<string, unknown>>
  viewport: Record<string, Record<string, unknown>>
}

/** Корневые коллекции с сущностями-записями (для merge). */
export const MERGE_ROOTS = ['elements', 'connections', 'dialogues', 'notes'] as const
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
  baseState: PlainProject
}

export interface BackupMeta {
  id: string
  projectId: string
  createdAt: number
  label: string
}

export interface BackupRecord {
  meta: BackupMeta
  /** base64 полного Yjs-update оригинала перед применением merge */
  update: string
}

export interface PeerInfo {
  clientId: number
  name: string
  color: string
  isSelf: boolean
}

export type SaveState = 'saved' | 'saving'

export type ToastKind = 'ok' | 'warn' | 'error'

export interface VetviSnapshot {
  ready: boolean
  mode: VetviMode
  meta: ProjectMeta | null
  elements: ElementRecord[]
  selectedId: string | null
  connection: ConnectionState
  roomActive: boolean
  mailboxActive: boolean
  peers: PeerInfo[]
  peersCount: number
  copies: CopyMeta[]
  incoming: MergeRequest[]
  outgoing: MergeRequest[]
  backups: BackupMeta[]
  shareUrl: string | null
  roomId: string | null
  copyMeta: CopyMeta | null
  saveState: SaveState
  userName: string
  userColor: string
}
