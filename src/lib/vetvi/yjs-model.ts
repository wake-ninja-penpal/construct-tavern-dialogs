/**
 * Yjs-модель проекта «Ветви».
 * Полный порт модели vetvi33.html: узлы/связи/группы/свои типы.
 * Экспорт/импорт JSON совместим бит-в-бит с форматом прототипа (app:'vetvi', version:18).
 */

import * as Y from 'yjs'
import {
  SCHEMA_VERSION,
  BASE_TYPES,
  STATUS_RU,
  type PlainProject,
  type VetviNode,
  type VetviEdge,
  type VetviGroup,
  type CustomTypeRecord,
  type NodeStatus,
  type EdgeKind,
  type DialogReply,
} from './types'

export const ROOTS = ['meta', 'nodes', 'edges', 'groups', 'customTypes', 'viewport'] as const
export type RootName = (typeof ROOTS)[number]

/** Текстовые поля хранятся как Y.Text (посимвольная коллаборативная правка). */
export const TEXT_KEYS = new Set(['text', 'content', 'title', 'body', 'label', 'caption', 'description'])

export function uid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return Math.random().toString(36).slice(2) + Date.now().toString(36)
}

export function clamp(v: number, a: number, b: number): number {
  return Math.max(a, Math.min(b, v))
}

export function uint8ToBase64(u8: Uint8Array): string {
  let binary = ''
  const chunkSize = 0x8000
  for (let i = 0; i < u8.length; i += chunkSize) {
    const chunk = u8.subarray(i, i + chunkSize)
    binary += String.fromCharCode.apply(null, Array.from(chunk) as unknown as number[])
  }
  return btoa(binary)
}

export function base64ToUint8(b64: string): Uint8Array {
  const binary = atob(b64)
  const u8 = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) u8[i] = binary.charCodeAt(i)
  return u8
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    !(value instanceof Uint8Array) &&
    !(value instanceof Y.Map) &&
    !(value instanceof Y.Array) &&
    !(value instanceof Y.Text)
  )
}

// ---------------------------
// Yjs <-> plain
// ---------------------------

export function createYText(value = ''): Y.Text {
  const yText = new Y.Text()
  if (value) yText.insert(0, value)
  return yText
}

export function yValueToPlain(value: unknown): unknown {
  if (value instanceof Y.Text) return value.toString()
  if (value instanceof Y.Map) {
    const result: Record<string, unknown> = {}
    value.forEach((childValue, key) => {
      result[key] = yValueToPlain(childValue)
    })
    return result
  }
  if (value instanceof Y.Array) {
    return value.toArray().map((item) => yValueToPlain(item))
  }
  return value
}

export function plainToYValue(plain: unknown, key?: string): unknown {
  if (plain === undefined) return undefined
  if (plain === null) return null

  if (typeof plain === 'string' && key && TEXT_KEYS.has(key)) {
    return createYText(plain)
  }

  if (Array.isArray(plain)) {
    const yArray = new Y.Array()
    yArray.push(plain.map((item) => plainToYValue(item)))
    return yArray
  }

  if (isPlainObject(plain)) {
    const yMap = new Y.Map()
    fillYMap(yMap, plain)
    return yMap
  }

  return plain
}

export function fillYMap(yMap: Y.Map<unknown>, sourceObject: Record<string, unknown>) {
  for (const [key, value] of Object.entries(sourceObject)) {
    const yValue = plainToYValue(value, key)
    if (yValue !== undefined) yMap.set(key, yValue)
  }
}

export function clearYMap(yMap: Y.Map<unknown>) {
  const keys = Array.from(yMap.keys())
  keys.forEach((key) => yMap.delete(key))
}

export function ensureProjectSkeleton(ydoc: Y.Doc, projectId: string, name = 'Новый проект') {
  ydoc.transact(() => {
    const meta = ydoc.getMap('meta')
    if (!meta.get('projectId')) meta.set('projectId', projectId)
    if (!meta.get('name')) meta.set('name', name)
    meta.set('schemaVersion', SCHEMA_VERSION)
    if (!meta.get('createdAt')) meta.set('createdAt', Date.now())
    meta.set('updatedAt', Date.now())
    ROOTS.forEach((root) => ydoc.getMap(root))
  }, 'ensure-project-skeleton')
}

// ---------------------------
// Экспорт / импорт JSON (формат прототипа vetvi33 v18)
// ---------------------------

/** Плоский срез документа (все корни → plain). */
export function toPlainProject(ydoc: Y.Doc): Record<string, Record<string, unknown>> {
  const data: Record<string, Record<string, unknown>> = {}
  for (const rootName of ROOTS) {
    data[rootName] = yValueToPlain(ydoc.getMap(rootName)) as Record<string, unknown>
  }
  return data
}

/**
 * Собирает JSON в формате прототипа vetvi33.html:
 * {app:'vetvi', version:18, bend, meta:{name,created,modified}, viewport, nodes, edges, customTypes, groups, listHidden}
 */
export function exportPrototypeJson(
  ydoc: Y.Doc,
  bendMode: string,
  viewport: { x: number; y: number; z: number },
): string {
  const plain = toPlainProject(ydoc)
  const meta = plain.meta as Record<string, unknown>
  const nodesMap = plain.nodes as Record<string, Record<string, unknown>>
  const edgesMap = plain.edges as Record<string, Record<string, unknown>>
  const groupsMap = plain.groups as Record<string, Record<string, unknown>>
  const ctsMap = plain.customTypes as Record<string, Record<string, unknown>>

  return JSON.stringify(
    {
      app: 'vetvi',
      version: SCHEMA_VERSION,
      bend: bendMode,
      meta: {
        name: meta.name ?? 'Без названия',
        created: meta.created ?? '',
        modified: new Date().toISOString(),
      },
      viewport,
      nodes: Object.values(nodesMap),
      edges: Object.values(edgesMap),
      customTypes: Object.values(ctsMap),
      groups: Object.values(groupsMap),
      listHidden: (meta.listHidden as string[] | undefined) ?? [],
    },
    null,
    2,
  )
}

export function validateProjectJson(json: unknown): asserts json is Record<string, unknown> {
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    throw new Error('Файл не похож на проект Ветвей')
  }
  const obj = json as Record<string, unknown>
  const isProto = obj.app === 'vetvi' && Array.isArray(obj.nodes) && Array.isArray(obj.edges)
  const isLegacy =
    obj.format === 'vetvi-project' &&
    isPlainObject(obj.data) &&
    isPlainObject((obj.data as Record<string, unknown>).elements)
  if (!isProto && !isLegacy) {
    throw new Error('Файл не похож на проект Ветвей')
  }
}

/** Удаляет содержимое всех корней данных. */
function clearDataRoots(ydoc: Y.Doc) {
  for (const root of ['nodes', 'edges', 'groups', 'customTypes'] as const) {
    clearYMap(ydoc.getMap(root))
  }
}

function fillRootFromList(ydoc: Y.Doc, root: string, list: unknown) {
  if (!Array.isArray(list)) return
  const map = ydoc.getMap(root)
  for (const item of list) {
    if (!isPlainObject(item)) continue
    const id = typeof item.id === 'string' ? item.id : uid()
    map.set(id, plainToYValue({ ...item, id }))
  }
}

/**
 * Импорт JSON (формат прототипа или legacy vetvi-project) в документ.
 * clear=true — полностью заменить содержимое.
 */
export function importProjectFromJson(ydoc: Y.Doc, json: unknown, clear = true) {
  const proto = json as Record<string, unknown>
  let nodes: unknown[] = []
  let edges: unknown[] = []
  let groups: unknown[] = []
  let customTypes: unknown[] = []
  let listHidden: string[] = []
  let name = 'Без названия'
  let created = ''
  let bend: unknown = undefined

  if (proto.app === 'vetvi') {
    // Прямой формат прототипа.
    nodes = (proto.nodes as unknown[]) ?? []
    edges = (proto.edges as unknown[]) ?? []
    groups = (proto.groups as unknown[]) ?? []
    customTypes = (proto.customTypes as unknown[]) ?? []
    listHidden = Array.isArray(proto.listHidden) ? (proto.listHidden as string[]) : []
    const meta = isPlainObject(proto.meta) ? proto.meta : {}
    name = typeof meta.name === 'string' ? meta.name : name
    created = typeof meta.created === 'string' ? meta.created : ''
    bend = proto.bend
  } else {
    // Legacy online-формат: миграция корней elements/dialogues/notes → nodes.
    const data = proto.data as Record<string, unknown>
    const els = (data.elements as Record<string, Record<string, unknown>>) ?? {}
    nodes = Object.values(els).map((el) => {
      const text = typeof el.text === 'string' ? el.text : ''
      const type = el.type === 'dialogue' ? 'dialog' : el.type === 'text' ? 'scene' : 'note'
      const firstLine = text.split('\n')[0] ?? ''
      const title = firstLine.slice(0, 80) || BASE_TYPES[(type as keyof typeof BASE_TYPES)]?.name || 'Элемент'
      return {
        id: el.id,
        type,
        x: el.x ?? 0,
        y: el.y ?? 0,
        title,
        text,
        status: 'idea',
        tags: [],
        expand: 1,
      }
    })
    const meta = (data.meta as Record<string, unknown>) ?? {}
    name = typeof meta.name === 'string' ? meta.name : name
  }

  ydoc.transact(() => {
    if (clear) clearDataRoots(ydoc)
    fillRootFromList(ydoc, 'customTypes', customTypes)
    fillRootFromList(ydoc, 'nodes', nodes)
    fillRootFromList(ydoc, 'edges', edges)
    fillRootFromList(ydoc, 'groups', groups)
    const meta = ydoc.getMap('meta')
    meta.set('name', name)
    if (created) meta.set('created', created)
    meta.set('listHidden', listHidden)
    if (bend === 'ortho90' || bend === 'ortho45' || bend === 'smooth') meta.set('bendMode', bend)
    meta.set('updatedAt', Date.now())
  }, 'import-project-json')
}

// ---------------------------
// CRUD записей
// ---------------------------

export function patchYMap(targetMap: Y.Map<unknown>, patchObject: Record<string, unknown>) {
  for (const [key, value] of Object.entries(patchObject)) {
    const existing = targetMap.get(key)

    // Сохраняем идентичность Y.Text — важно для observers и CRDT-истории.
    if (typeof value === 'string' && existing instanceof Y.Text && TEXT_KEYS.has(key)) {
      replaceYText(existing, value)
      continue
    }

    if (isPlainObject(value) && existing instanceof Y.Map && !TEXT_KEYS.has(key)) {
      patchYMap(existing, value)
    } else {
      const yValue = plainToYValue(value, key)
      if (yValue === undefined) {
        targetMap.delete(key)
      } else {
        targetMap.set(key, yValue)
      }
    }
  }
}

export function upsertRecord(
  ydoc: Y.Doc,
  rootName: string,
  record: Record<string, unknown>,
): void {
  const recordId = typeof record?.id === 'string' ? record.id : null
  if (!recordId) {
    throw new Error(`Запись в ${rootName} должна иметь id.`)
  }

  const rootMap = ydoc.getMap(rootName)
  ydoc.transact(() => {
    const existing = rootMap.get(recordId)
    if (existing instanceof Y.Map) {
      patchYMap(existing, record)
    } else {
      rootMap.set(recordId, plainToYValue(record))
    }
    ydoc.getMap('meta').set('updatedAt', Date.now())
  }, `upsert-${rootName}`)
}

export function deleteRecord(ydoc: Y.Doc, rootName: string, id: string): void {
  const rootMap = ydoc.getMap(rootName)
  ydoc.transact(() => {
    rootMap.delete(id)
    ydoc.getMap('meta').set('updatedAt', Date.now())
  }, `delete-${rootName}`)
}

/** Полная замена содержимого Y.Text (MVP-подход к редактированию). */
export function replaceYText(yText: Y.Text, next: string) {
  const current = yText.toString()
  if (current === next) return
  yText.delete(0, current.length)
  if (next) yText.insert(0, next)
}

// ---------------------------
// Нормализация (порт normalize() из прототипа)
// ---------------------------

function normHex(v: unknown): string | null {
  return typeof v === 'string' && /^#([0-9a-f]{6})$/i.test(v) ? v : null
}

/** Строгая нормализация плоского проекта прототипа. */
export function normalizeProject(p: Record<string, unknown>): PlainProject {
  const customTypes: CustomTypeRecord[] = (Array.isArray(p.customTypes) ? p.customTypes : []).map(
    (c: unknown) => {
      const ct = (c ?? {}) as Record<string, unknown>
      return {
        id: typeof ct.id === 'string' ? ct.id : uid(),
        name: String(ct.name ?? 'Элемент').slice(0, 40),
        color: typeof ct.color === 'string' ? ct.color : '#e2a54e',
        icon: typeof ct.icon === 'string' ? ct.icon : 'star',
      }
    },
  )
  const cmap = new Map(customTypes.map((c) => [c.id, c]))

  const rawGroups = Array.isArray(p.groups) ? p.groups : []
  const groups: VetviGroup[] = rawGroups.map((gUnknown: unknown) => {
    const g = (gUnknown ?? {}) as Record<string, unknown>
    const foldRaw = g.fold
    const foldLegacy = g.collapsed ? (g.listOpen === false ? 0 : 1) : 2
    const fold = foldRaw === 0 || foldRaw === 1 || foldRaw === 2 ? foldRaw : foldLegacy
    const bbox = Array.isArray(g.bbox) && g.bbox.length === 2 ? ([Number(g.bbox[0]), Number(g.bbox[1])] as [number, number]) : null
    const hh =
      g.hh && typeof g.hh === 'object' && !Array.isArray(g.hh)
        ? (Object.fromEntries(
            Object.entries(g.hh as Record<string, unknown>).map(([k, v]) => [k, Number(v) || 90]),
          ) as Record<string, number>)
        : null
    return {
      id: typeof g.id === 'string' ? g.id : uid(),
      name: String(g.name ?? 'Группа').slice(0, 60),
      fold: fold as 0 | 1 | 2,
      x: Number(g.x) || 0,
      y: Number(g.y) || 0,
      parent: typeof g.parent === 'string' && g.parent !== g.id ? g.parent : null,
      color: normHex(g.color),
      alpha: typeof g.alpha === 'number' ? clamp(g.alpha, 0.1, 1) : 0.55,
      badge: !!g.badge,
      bbox,
      hh,
      auto: g.auto === true,
      fx: typeof g.fx === 'number' ? g.fx : null,
      fy: typeof g.fy === 'number' ? g.fy : null,
      fw: typeof g.fw === 'number' ? g.fw : null,
      fh: typeof g.fh === 'number' ? g.fh : null,
    }
  })
  const gids = new Set(groups.map((g) => g.id))
  groups.forEach((g) => {
    if (g.parent && !gids.has(g.parent)) g.parent = null
  })

  const rawNodes = Array.isArray(p.nodes) ? p.nodes : []
  const nodes: VetviNode[] = rawNodes.map((nUnknown: unknown) => {
    const n = (nUnknown ?? {}) as Record<string, unknown>
    let t = typeof n.type === 'string' ? n.type : 'note'
    if (!BASE_TYPES[t as BaseTypeKeySafe] && !cmap.has(t)) {
      if (typeof n.ctype === 'string' && cmap.has(n.ctype)) t = n.ctype
      else t = 'note'
    }
    const exRaw = n.expand
    const ex = exRaw === 0 || exRaw === 1 || exRaw === 2 ? exRaw : n.collapsed ? 0 : 1
    const defTitle =
      BASE_TYPES[t as BaseTypeKeySafe]?.name ?? cmap.get(t)?.name ?? 'Элемент'
    const isDialog = t === 'dialog'
    const dlgRaw = isPlainObject(n.dialog) ? n.dialog : {}
    const node: VetviNode = {
      id: typeof n.id === 'string' ? n.id : uid(),
      type: t,
      gid: typeof n.gid === 'string' && gids.has(n.gid) ? n.gid : null,
      x: Number(n.x) || 0,
      y: Number(n.y) || 0,
      title: typeof n.title === 'string' && n.title ? n.title : defTitle,
      text: typeof n.text === 'string' ? n.text : '',
      status: (typeof n.status === 'string' && n.status in STATUS_RU ? n.status : 'idea') as NodeStatus,
      tags: Array.isArray(n.tags) ? (n.tags as string[]).map(String) : [],
      expand: ex as 0 | 1 | 2,
      color: normHex(n.color),
      tint: typeof n.tint === 'number' ? clamp(n.tint, -60, 60) : 0,
      dlgWidth: typeof n.dlgWidth === 'number' ? clamp(n.dlgWidth, 216, 1200) : null,
      notes: Array.isArray(n.notes)
        ? (n.notes as Record<string, unknown>[]).map((m) => ({
            title: String(m?.title ?? '').slice(0, 80),
            html: String(m?.html ?? ''),
            hidden: !!m?.hidden,
          }))
        : [],
    }
    if (isDialog) {
      node.dialog = {
        participants: Array.isArray(dlgRaw.participants) ? (dlgRaw.participants as string[]).map(String) : [],
        description:
          typeof dlgRaw.description === 'string'
            ? dlgRaw.description
            : typeof n.text === 'string'
              ? n.text
              : '',
        replies: Array.isArray(dlgRaw.replies) ? (dlgRaw.replies as DialogReply[]) : [],
      }
    }
    return node
  })
  const ids = new Set(nodes.map((n) => n.id))

  const rawEdges = Array.isArray(p.edges) ? p.edges : []
  const edges: VetviEdge[] = rawEdges
    .map((eUnknown: unknown): VetviEdge | null => {
      const e = (eUnknown ?? {}) as Record<string, unknown>
      if (typeof e.from !== 'string' || typeof e.to !== 'string') return null
      if (!ids.has(e.from) || !ids.has(e.to) || e.from === e.to) return null
      let kind = (typeof e.kind === 'string' && ['flow', 'choice', 'cond', 'bridge'].includes(e.kind)
        ? e.kind
        : 'flow') as EdgeKind
      if (e.bridge === true) kind = 'bridge'
      return {
        id: typeof e.id === 'string' ? e.id : uid(),
        from: e.from,
        to: e.to,
        label: typeof e.label === 'string' ? e.label : '',
        kind,
        pts: Array.isArray(e.pts)
          ? (e.pts as { x: number; y: number }[])
              .filter((pt) => pt && isFinite(Number(pt.x)) && isFinite(Number(pt.y)))
              .map((pt) => ({ x: Number(pt.x), y: Number(pt.y) }))
          : [],
        lt: typeof e.lt === 'number' ? clamp(e.lt, 0.04, 0.96) : 0.5,
        lp: typeof e.lp === 'number' ? clamp(e.lp, -44, 44) : 0,
        fromReply: typeof e.fromReply === 'string' && e.fromReply ? e.fromReply : null,
        bd:
          isPlainObject(e.bd) && isFinite(Number(e.bd.dl))
            ? { dl: Number(e.bd.dl) || 0, dy: Number(e.bd.dy) || 0, dr: Number(e.bd.dr) || 0 }
            : { dl: 0, dy: 0, dr: 0 },
      }
    })
    .filter((e): e is VetviEdge => e !== null)

  const keptGroups = groups.filter((g) => nodes.some((n) => n.gid === g.id))

  let listHidden = Array.isArray(p.listHidden)
    ? (p.listHidden as string[]).map(String)
    : Array.isArray(p.hiddenTypes)
      ? (p.hiddenTypes as string[]).map(String)
      : []
  listHidden = listHidden.filter((k) => (BASE_TYPES as Record<string, unknown>)[k] || cmap.has(k))

  const metaRaw = isPlainObject(p.meta) ? p.meta : {}
  const meta = {
    name: typeof metaRaw.name === 'string' ? metaRaw.name : 'Без названия',
    created: typeof metaRaw.created === 'string' ? metaRaw.created : '',
    modified: typeof metaRaw.modified === 'string' ? metaRaw.modified : '',
  }

  return { meta, nodes, edges, customTypes, groups: keptGroups, listHidden }
}

type BaseTypeKeySafe = keyof typeof BASE_TYPES
