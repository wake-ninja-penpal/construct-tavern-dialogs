/**
 * IndexedDB-хранилище «Ветвей».
 * Структура ключей (store: 'documents', db: 'vetvi'):
 *  - project:{projectId}            -> Uint8Array (Yjs update) — основная локальная версия
 *  - copy:{copyId}                  -> CopyRecord — локальные копии
 *  - copies-index                   -> string[] — индекс копий
 *  - merge-outbox                   -> MergeRequest[] — очередь merge-запросов
 *  - backups-index:{projectId}      -> BackupMeta[] — индекс backup'ов
 *  - backup:{backupId}              -> BackupRecord
 *  - projects-index                 -> string[] — известные projectId (для восстановления)
 */

import type { BackupMeta, BackupRecord, CopyRecord, MergeRequest } from './types'
import { base64ToUint8, uint8ToBase64 } from './yjs-model'

const IDB_NAME = 'vetvi'
const IDB_STORE = 'documents'

let _idbPromise: Promise<IDBDatabase> | null = null

function openIdb(): Promise<IDBDatabase> {
  if (_idbPromise) return _idbPromise

  _idbPromise = new Promise((resolve, reject) => {
    if (typeof window === 'undefined' || !('indexedDB' in window)) {
      reject(new Error('IndexedDB недоступен'))
      return
    }

    const request = indexedDB.open(IDB_NAME, 1)

    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        db.createObjectStore(IDB_STORE)
      }
    }

    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })

  _idbPromise.catch(() => {
    _idbPromise = null
  })

  return _idbPromise
}

export async function idbGet<T = unknown>(key: string): Promise<T | undefined> {
  try {
    const db = await openIdb()
    return await new Promise<T | undefined>((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readonly')
      const req = tx.objectStore(IDB_STORE).get(key)
      req.onsuccess = () => resolve(req.result as T | undefined)
      req.onerror = () => reject(req.error)
    })
  } catch (error) {
    console.warn('IndexedDB get error', error)
    return undefined
  }
}

export async function idbSet(key: string, value: unknown): Promise<boolean> {
  try {
    const db = await openIdb()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readwrite')
      tx.objectStore(IDB_STORE).put(value, key)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error)
    })
    return true
  } catch (error) {
    console.warn('IndexedDB set error', error)
    return false
  }
}

export async function idbDelete(key: string): Promise<boolean> {
  try {
    const db = await openIdb()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readwrite')
      tx.objectStore(IDB_STORE).delete(key)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error)
    })
    return true
  } catch (error) {
    console.warn('IndexedDB delete error', error)
    return false
  }
}

// ---------------------------
// Типизированные helpers
// ---------------------------

const PROJECTS_INDEX = 'projects-index'
const COPIES_INDEX = 'copies-index'
const MERGE_OUTBOX = 'merge-outbox'

function backupsIndexKey(projectId: string) {
  return `backups-index:${projectId}`
}

export async function addProjectId(projectId: string) {
  const list = (await idbGet<string[]>(PROJECTS_INDEX)) ?? []
  if (!list.includes(projectId)) {
    await idbSet(PROJECTS_INDEX, [...list, projectId])
  }
}

export async function getProjectUpdate(projectId: string): Promise<Uint8Array | undefined> {
  const saved = await idbGet<Uint8Array | ArrayBuffer | number[]>(`project:${projectId}`)
  if (!saved) return undefined
  if (saved instanceof Uint8Array) return saved
  if (saved instanceof ArrayBuffer) return new Uint8Array(saved)
  if (Array.isArray(saved)) return Uint8Array.from(saved)
  return undefined
}

export async function saveProjectUpdate(projectId: string, update: Uint8Array) {
  await idbSet(`project:${projectId}`, update)
}

// ---------------------------
// Копии
// ---------------------------

export async function listCopies(): Promise<CopyRecord[]> {
  const ids = (await idbGet<string[]>(COPIES_INDEX)) ?? []
  const records = await Promise.all(ids.map((id) => idbGet<CopyRecord>(`copy:${id}`)))
  const result = records.filter((r): r is CopyRecord => Boolean(r))
  result.sort((a, b) => b.meta.createdAt - a.meta.createdAt)
  return result
}

export async function getCopy(copyId: string): Promise<CopyRecord | undefined> {
  return idbGet<CopyRecord>(`copy:${copyId}`)
}

export async function saveCopy(record: CopyRecord) {
  await idbSet(`copy:${record.meta.copyId}`, record)
  const ids = (await idbGet<string[]>(COPIES_INDEX)) ?? []
  if (!ids.includes(record.meta.copyId)) {
    await idbSet(COPIES_INDEX, [...ids, record.meta.copyId])
  }
}

export async function deleteCopy(copyId: string) {
  await idbDelete(`copy:${copyId}`)
  const ids = (await idbGet<string[]>(COPIES_INDEX)) ?? []
  await idbSet(
    COPIES_INDEX,
    ids.filter((id) => id !== copyId),
  )
}

// ---------------------------
// Merge outbox (очередь исходящих merge-запросов)
// ---------------------------

export async function getOutbox(): Promise<MergeRequest[]> {
  return (await idbGet<MergeRequest[]>(MERGE_OUTBOX)) ?? []
}

export async function saveOutbox(items: MergeRequest[]) {
  await idbSet(MERGE_OUTBOX, items)
}

// ---------------------------
// Backups (снапшоты оригинала перед merge)
// ---------------------------

export async function listBackups(projectId: string): Promise<BackupMeta[]> {
  const list = (await idbGet<BackupMeta[]>(backupsIndexKey(projectId))) ?? []
  return [...list].sort((a, b) => b.createdAt - a.createdAt)
}

export async function saveBackup(meta: BackupMeta, update: Uint8Array) {
  const record: BackupRecord = { meta, update: uint8ToBase64(update) }
  await idbSet(`backup:${meta.id}`, record)
  const list = (await idbGet<BackupMeta[]>(backupsIndexKey(meta.projectId))) ?? []
  if (!list.some((b) => b.id === meta.id)) {
    await idbSet(backupsIndexKey(meta.projectId), [...list, meta])
  }
}

export async function getBackupUpdate(backupId: string): Promise<Uint8Array | undefined> {
  const record = await idbGet<BackupRecord>(`backup:${backupId}`)
  if (!record) return undefined
  try {
    return base64ToUint8(record.update)
  } catch (error) {
    console.warn('Не удалось декодировать backup', error)
    return undefined
  }
}

export async function deleteBackup(projectId: string, backupId: string) {
  await idbDelete(`backup:${backupId}`)
  const list = (await idbGet<BackupMeta[]>(backupsIndexKey(projectId))) ?? []
  await idbSet(
    backupsIndexKey(projectId),
    list.filter((b) => b.id !== backupId),
  )
}
