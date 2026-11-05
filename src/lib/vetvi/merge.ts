/**
 * Merge-дельта «Ветвей» (ТЗ FR-7, FR-8, FR-11).
 *
 * Дельта вычисляется структурно: сравнивается плоский JSON-срез копии
 * с baseline (состоянием оригинала на момент копирования).
 * Владелец применяет дельту к своему документу вручную (accept).
 */

import * as Y from 'yjs'
import {
  isPlainObject,
  patchYMap,
  plainToYValue,
} from './yjs-model'
import { MERGE_ROOTS, type MergeDelta, type MergeRoot, type MergeStats, type RootDelta } from './types'

function stableStringify(value: unknown): string {
  if (!isPlainObject(value)) return JSON.stringify(value) ?? 'null'
  const keys = Object.keys(value).sort()
  const parts: string[] = []
  for (const key of keys) {
    parts.push(`${JSON.stringify(key)}:${stableStringify(value[key])}`)
  }
  return `{${parts.join(',')}}`
}

export function computeRootDelta(
  base: Record<string, unknown> | undefined,
  current: Record<string, unknown> | undefined,
): RootDelta {
  const baseMap = base ?? {}
  const currentMap = current ?? {}

  const added: Record<string, Record<string, unknown>> = {}
  const updated: Record<string, Record<string, unknown>> = {}
  const deleted: string[] = []

  for (const [id, record] of Object.entries(currentMap)) {
    const rec = record as Record<string, unknown>
    if (!(id in baseMap)) {
      added[id] = rec
    } else if (stableStringify(baseMap[id]) !== stableStringify(rec)) {
      updated[id] = rec
    }
  }

  for (const id of Object.keys(baseMap)) {
    if (!(id in currentMap)) deleted.push(id)
  }

  return { added, updated, deleted }
}

export function computeDelta(
  baseProjectId: string,
  base: PlainProjectLike,
  current: PlainProjectLike,
): MergeDelta {
  const sections: Partial<Record<MergeRoot, RootDelta>> = {}

  for (const root of MERGE_ROOTS) {
    const delta = computeRootDelta(base[root], current[root])
    if (delta.added && Object.keys(delta.added).length > 0) {
      sections[root] = delta
      continue
    }
    if (Object.keys(delta.updated).length > 0 || delta.deleted.length > 0) {
      sections[root] = delta
    }
  }

  return {
    baseProjectId,
    createdAt: Date.now(),
    sections,
  }
}

// Совместимое описание плоского среза (избегаем жёсткой связки с типами export).
export interface PlainProjectLike {
  nodes?: Record<string, unknown>
  edges?: Record<string, unknown>
  groups?: Record<string, unknown>
  customTypes?: Record<string, unknown>
}

export function deltaStats(delta: MergeDelta): MergeStats {
  const stats: MergeStats = { added: 0, updated: 0, deleted: 0 }
  for (const root of MERGE_ROOTS) {
    const section = delta.sections?.[root]
    if (!section) continue
    stats.added += Object.keys(section.added ?? {}).length
    stats.updated += Object.keys(section.updated ?? {}).length
    stats.deleted += (section.deleted ?? []).length
  }
  return stats
}

export function isDeltaEmpty(delta: MergeDelta): boolean {
  const stats = deltaStats(delta)
  return stats.added === 0 && stats.updated === 0 && stats.deleted === 0
}

export function emptyDelta(baseProjectId: string): MergeDelta {
  return { baseProjectId, createdAt: Date.now(), sections: {} }
}

/**
 * Применяет дельту к Yjs-документу оригинала (в одной транзакции).
 * Обновлённые/добавленные записи upsert'ятся, удалённые — удаляются.
 */
export function applyDelta(ydoc: Y.Doc, delta: MergeDelta) {
  ydoc.transact(() => {
    for (const root of MERGE_ROOTS) {
      const section = delta.sections?.[root]
      if (!section) continue
      const rootMap = ydoc.getMap(root)

      for (const [id, record] of Object.entries(section.added ?? {})) {
        const existing = rootMap.get(id)
        if (existing instanceof Y.Map) {
          patchYMap(existing, record)
        } else {
          rootMap.set(id, plainToYValue({ id, ...record }))
        }
      }

      for (const [id, record] of Object.entries(section.updated ?? {})) {
        const existing = rootMap.get(id)
        if (existing instanceof Y.Map) {
          patchYMap(existing, record)
        } else {
          rootMap.set(id, plainToYValue({ id, ...record }))
        }
      }

      for (const id of section.deleted ?? []) {
        rootMap.delete(id)
      }
    }

    ydoc.getMap('meta').set('updatedAt', Date.now())
  }, 'merge-apply')
}
