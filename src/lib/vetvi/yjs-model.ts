/**
 * Yjs-модель проекта «Ветви».
 * Порт логики из prototype.html — формат экспорта/импорта `vetvi-project` v1
 * сохранён бит-в-бит для совместимости с прототипом.
 */

import * as Y from 'yjs'
import { SCHEMA_VERSION, type PlainProject } from './types'

export const ROOTS = ['meta', 'elements', 'connections', 'dialogues', 'notes', 'viewport'] as const
export type RootName = (typeof ROOTS)[number]

export const TEXT_KEYS = new Set(['text', 'content', 'title', 'body', 'note', 'label', 'caption'])

export function uid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return Math.random().toString(36).slice(2) + Date.now().toString(36)
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
// Экспорт / импорт JSON
// ---------------------------

export function exportProjectToJson(ydoc: Y.Doc) {
  const data: Record<string, Record<string, unknown>> = {}
  for (const rootName of ROOTS) {
    data[rootName] = yValueToPlain(ydoc.getMap(rootName)) as Record<string, unknown>
  }
  return {
    format: 'vetvi-project',
    schemaVersion: SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    data,
  }
}

export function validateProjectJson(json: unknown): asserts json is {
  format: string
  schemaVersion: number
  data: Record<string, Record<string, unknown>>
} {
  if (!json || typeof json !== 'object') {
    throw new Error('Неверный формат проекта. Ожидался vetvi-project.')
  }
  const obj = json as Record<string, unknown>
  if (obj.format !== 'vetvi-project') {
    throw new Error('Неверный формат проекта. Ожидался vetvi-project.')
  }
  if (typeof obj.schemaVersion === 'number' && obj.schemaVersion > SCHEMA_VERSION) {
    console.warn(
      `Версия схемы файла (${obj.schemaVersion}) новее поддерживаемой (${SCHEMA_VERSION}).`,
    )
  }
  if (!obj.data || !isPlainObject(obj.data)) {
    throw new Error('В файле проекта отсутствуют данные (data).')
  }
}

export function importProjectFromJson(
  json: { format: string; schemaVersion: number; data: Record<string, Record<string, unknown>> },
  ydoc: Y.Doc,
  options: { clear?: boolean } = {},
) {
  const { clear = true } = options

  ydoc.transact(() => {
    if (clear) {
      ROOTS.forEach((rootName) => clearYMap(ydoc.getMap(rootName)))
    }
    for (const rootName of ROOTS) {
      const source = json.data?.[rootName]
      if (!source || !isPlainObject(source)) continue
      fillYMap(ydoc.getMap(rootName), source)
    }
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

/** Возвращает (или создаёт) Y.Text для коллаборативного редактирования поля. */
export function getYText(parentMap: Y.Map<unknown>, key: string): Y.Text {
  let value = parentMap.get(key)
  if (!(value instanceof Y.Text)) {
    const stringValue = typeof value === 'string' ? value : ''
    value = createYText(stringValue)
    parentMap.set(key, value)
  }
  return value as Y.Text
}

/** Полная замена содержимого Y.Text (MVP-подход к редактированию). */
export function replaceYText(yText: Y.Text, next: string) {
  const current = yText.toString()
  if (current === next) return
  yText.delete(0, current.length)
  if (next) yText.insert(0, next)
}

/** Плоский срез документа для merge/delta-вычислений. */
export function toPlainProject(ydoc: Y.Doc): PlainProject {
  const data = exportProjectToJson(ydoc).data as unknown as PlainProject
  return data
}
