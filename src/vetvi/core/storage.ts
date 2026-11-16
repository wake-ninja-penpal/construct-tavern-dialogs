/**
 * Ветви — фасад хранилища: LocalStorage ↔ IndexedDB (порт storeMode/stItem
 * классической версии, строки 11022–11130). В режиме idb данные держатся в памяти
 * с отложенной записью в базу vetvi-store (store kv) через 350 мс.
 */

export const STORE_MODE_KEY = 'vetvi-store-mode';
const LS_LIMIT_CHARS = 4500000;
const LS_LIMIT_BYTES = 5242880;
const IDB_FLUSH_MS = 350;

export type StoreMode = 'ls' | 'idb';

const _storeMem: Record<string, string> = {};
let _storeDirty = new Set<string>();
let _storeFlushT: ReturnType<typeof setTimeout> | null = null;
let _idbPr: Promise<IDBDatabase | null> | null = null;
let _idbErrAt = 0;

export function storeMode(): StoreMode {
  try {
    const m = window.localStorage.getItem(STORE_MODE_KEY);
    return m === 'idb' ? 'idb' : 'ls';
  } catch {
    return 'ls';
  }
}

export function storeSetMode(m: StoreMode): void {
  try { window.localStorage.setItem(STORE_MODE_KEY, m === 'idb' ? 'idb' : 'ls'); } catch { /* нет доступа */ }
}

/** Ключи с данными приложения — переносятся между хранилищами. */
export function isDataKey(k: string): boolean {
  return typeof k === 'string' && k.indexOf('vetvi-') === 0 && k !== STORE_MODE_KEY && k !== 'vetvi-left-w' && k !== 'vetvi-hotkeys';
}

function idbOpen(): Promise<IDBDatabase | null> {
  if (_idbPr) return _idbPr;
  _idbPr = new Promise((resolve) => {
    try {
      /* без версии: берём текущую (БД могла вырасти после ремонта хранилища);
         новая БД создаётся с версией 1, апгрейд создаёт хранилище kv */
      const req = window.indexedDB.open('vetvi-store');
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
      };
      req.onsuccess = () => {
        const db = req.result;
        /* БД может существовать БЕЗ хранилища kv (создана «голым» open раньше) —
           тогда апгрейд не сработает никогда и все записи будут падать молча.
           Пересоздаём с версией +1, чтобы onupgradeneeded создал хранилище. */
        if (!db.objectStoreNames.contains('kv')) {
          const v = db.version;
          db.close();
          const req2 = window.indexedDB.open('vetvi-store', v + 1);
          req2.onupgradeneeded = () => {
            const db2 = req2.result;
            if (!db2.objectStoreNames.contains('kv')) db2.createObjectStore('kv');
          };
          req2.onsuccess = () => resolve(req2.result);
          req2.onerror = () => resolve(null);
          return;
        }
        resolve(db);
      };
      req.onerror = () => resolve(null);
      req.onblocked = () => { /* ждём освобождения другой вкладкой */ };
    } catch {
      resolve(null);
    }
  });
  return _idbPr;
}

async function idbPutMany(map: Record<string, string | null>): Promise<void> {
  const db = await idbOpen();
  if (!db) throw new Error('no idb');
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction('kv', 'readwrite');
    const st = tx.objectStore('kv');
    for (const k of Object.keys(map)) {
      const v = map[k];
      if (v == null) st.delete(k);
      else st.put(v, k);
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function idbReadAll(): Promise<Record<string, string>> {
  const db = await idbOpen();
  if (!db) return {};
  return new Promise((resolve) => {
    const out: Record<string, string> = {};
    try {
      const tx = db.transaction('kv', 'readonly');
      const st = tx.objectStore('kv');
      const keysReq = st.getAllKeys();
      const valsReq = st.getAll();
      tx.oncomplete = () => {
        const keys = keysReq.result || [];
        const vals = valsReq.result || [];
        for (let i = 0; i < keys.length; i++) {
          const v = vals[i];
          if (typeof v === 'string') out[String(keys[i])] = v;
        }
        resolve(out);
      };
      tx.onerror = () => resolve(out);
    } catch {
      resolve(out);
    }
  });
}

export function storeFlushNow(): void {
  if (storeMode() !== 'idb' || !_storeDirty.size) return;
  const map: Record<string, string | null> = {};
  for (const k of _storeDirty) map[k] = _storeMem[k] ?? null;
  _storeDirty = new Set();
  void idbPutMany(map).catch(() => {
    const now = Date.now();
    if (now - _idbErrAt > 10000) {
      _idbErrAt = now;
      _idbPr = null;
    }
  });
}

/** Синхронное чтение (в режиме idb — из памяти, прогретой storeBoot). */
export function stItem(key: string): string | null {
  if (storeMode() === 'ls') {
    try { return window.localStorage.getItem(key); } catch { return null; }
  }
  return Object.prototype.hasOwnProperty.call(_storeMem, key) ? _storeMem[key] : null;
}

export function stSetItem(key: string, val: string): void {
  if (storeMode() === 'ls') {
    try { window.localStorage.setItem(key, val); } catch { /* квота */ }
    return;
  }
  _storeMem[key] = val;
  _storeDirty.add(key);
  if (_storeFlushT) clearTimeout(_storeFlushT);
  _storeFlushT = setTimeout(storeFlushNow, IDB_FLUSH_MS);
}

export function stRemoveItem(key: string): void {
  if (storeMode() === 'ls') {
    try { window.localStorage.removeItem(key); } catch { /* нет доступа */ }
    return;
  }
  delete _storeMem[key];
  _storeDirty.add(key);
  if (_storeFlushT) clearTimeout(_storeFlushT);
  _storeFlushT = setTimeout(storeFlushNow, IDB_FLUSH_MS);
}

/** Прогрев памяти из IndexedDB до старта приложения. */
export async function storeBoot(): Promise<void> {
  if (storeMode() !== 'idb') return;
  const all = await idbReadAll();
  for (const k of Object.keys(all)) _storeMem[k] = all[k];
}

export function storeCollectData(): Record<string, string> {
  const out: Record<string, string> = {};
  if (storeMode() === 'ls') {
    try {
      for (let i = 0; i < window.localStorage.length; i++) {
        const k = window.localStorage.key(i);
        if (k && isDataKey(k)) out[k] = window.localStorage.getItem(k) || '';
      }
    } catch { /* нет доступа */ }
  } else {
    for (const k of Object.keys(_storeMem)) if (isDataKey(k)) out[k] = _storeMem[k];
  }
  return out;
}

export function storeSizeOf(k: string, v: string): number {
  return (k.length + v.length) * 2;
}

export function storeFmtSize(bytes: number): string {
  if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + ' МБ';
  if (bytes >= 1024) return Math.round(bytes / 1024) + ' КБ';
  return bytes + ' Б';
}

export function storeLsUsage(): number {
  let total = 0;
  try {
    for (let i = 0; i < window.localStorage.length; i++) {
      const k = window.localStorage.key(i) || '';
      const v = window.localStorage.getItem(k) || '';
      total += storeSizeOf(k, v);
    }
  } catch { /* нет доступа */ }
  return total;
}

export const LS_LIMITS = { chars: LS_LIMIT_CHARS, bytes: LS_LIMIT_BYTES };

/** Переключение хранилища с копированием данных. Возвращает текст ошибки или null. */
export async function storeSwitch(to: StoreMode): Promise<string | null> {
  const data = storeCollectData();
  if (to === 'idb') {
    const map: Record<string, string | null> = {};
    for (const k of Object.keys(data)) map[k] = data[k];
    try {
      await idbPutMany(map);
    } catch {
      return 'Не удалось записать данные в IndexedDB — режим не изменён.';
    }
    storeSetMode('idb');
    for (const k of Object.keys(data)) {
      try { window.localStorage.removeItem(k); } catch { /* нет доступа */ }
    }
    return null;
  }
  // в LocalStorage: проверка лимита
  let total = 0;
  for (const k of Object.keys(data)) total += storeSizeOf(k, data[k]);
  if (total > LS_LIMIT_BYTES * 0.9) {
    return 'Данные (' + storeFmtSize(total) + ') не поместятся в LocalStorage (лимит ~5.0 МБ). Освободите место: удалите лишние копии и резервные архивы или уменьшите аватары.';
  }
  const written: string[] = [];
  try {
    for (const k of Object.keys(data)) {
      window.localStorage.setItem(k, data[k]);
      written.push(k);
    }
  } catch {
    for (const k of written) {
      try { window.localStorage.removeItem(k); } catch { /* нет доступа */ }
    }
    return 'LocalStorage переполнен — режим не изменён.';
  }
  storeSetMode('ls');
  return null;
}
