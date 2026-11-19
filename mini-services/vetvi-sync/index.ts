/**
 * «Ветви» — сервер совместного доступа (realtime-синхронизация + merge-mailbox).
 *
 * Модель (по ТЗ TD.md, разделы 2, 8, 9, 16 — с сервером вместо P2P):
 *  - комнаты по roomId; состояние документа комнаты хранится на сервере,
 *    поэтому проект «живёт» даже когда владелец офлайн (снимает ограничение 8.3);
 *  - снапшот-синхронизация: клиент публикует полное состояние (debounce),
 *    сервер сохраняет и раздаёт остальным участникам;
 *  - живые события перетаскивания (vetvi:live) ретранслируются без сохранения;
 *  - участники (имя/цвет) — список онлайн-пользователей комнаты;
 *  - merge-mailbox: копии отправляют дельты, владелец принимает/отклоняет,
 *    статусы доступны отправителю (всё через socket.io ack-события — порт
 *    полностью занят транспортом socket.io, path '/').
 *
 * Транспорт: клиент подключается через шлюз io('/?XTransformPort=3003'),
 * путь socket.io — '/' (требование Caddy-шлюза).
 *
 * Персистентность: SQLite (data/store.db, bun:sqlite, режим WAL). Каждая
 * комната — отдельная запись таблицы rooms, каждая merge-заявка — отдельная
 * запись таблицы merges: сохранение одной комнаты больше не перезаписывает
 * «один огромный JSON» со всеми комнатами, а затрагивает только свою строку.
 * Форматы самих документов не меняются (doc/статистика/дельты — те же JSON-
 * структуры, что уходят на клиент). Legacy-хранилище data/store.json при
 * первом старте автоматически мигрируется в БД (по комнате/заявке построчно),
 * после чего исходный файл переименовывается в store.json.backup-<дата>
 * (не удаляется — страховка данных). Пароль комнаты (salt+sha256) тоже
 * персистится вместе с комнатой.
 */

import { createServer } from 'http'
import { createHash } from 'crypto'
import { Server, type Socket } from 'socket.io'
import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync, readFileSync, renameSync } from 'fs'

const PORT = 3003
const ROOM_TTL_MS = 60 * 60 * 1000 // освобождаем память через час простоя (состояние уже на диске)
const MAX_DOC_BYTES = 4 * 1024 * 1024
const MAX_MERGE_BYTES = 12 * 1024 * 1024
const MAX_MERGES_PER_ROOM = 60
const MAX_ROOMS = 500
const TRIM_EVERY_MS = 60 * 1000 // лимит комнат проверяется не чаще раза в минуту

interface UserMeta {
  id: string
  name: string
  color: string
  /* право на редактирование (аккаунт с доступом owner/editor) */
  canEdit?: boolean
}

interface RoomMember {
  socketId: string
  user: UserMeta
  canEdit: boolean
  /* id аккаунта (если вошёл по сессии) — нужен свипу ролей: права
     (owner/editor/reader) могут измениться, пока участник в комнате */
  accId: string | null
  /* роль вошедшего (owner/editor/reader/guest) — нужна при ограничении ссылки:
     когда владелец закрывает ссылку, гости вылетают из комнаты */
  role?: string
}

interface AccInfo {
  id: string
  name: string
  color: string
  login: string
}

interface MergeRequest {
  id: string
  roomId: string
  copyId: string
  sender: { name: string; color: string }
  createdAt: string
  status: 'pending' | 'applied' | 'rejected'
  stats: Record<string, number>
  doc: { current: unknown; base: unknown }
  /* 'copy' — слияние из локальной копии (трёхсторонний merge);
     'replace' — запрос на замену данных комнаты версией отправителя
     («Опубликовать локальную версию» от редактора). Подтверждает
     владелец или админ комнаты. */
  kind?: 'copy' | 'replace'
  decidedBy?: string | null
  decidedAt?: string | null
}

interface StoredRoom {
  doc: unknown
  updatedAt: string
  /* пароль комнаты (salt + sha256) — персистится вместе с комнатой */
  pass?: { salt: string; hash: string } | null
  /* доступ по ссылке: off — ссылка закрыта, members — только добавленные
     участники, open — все по ссылке (только чтение). Меняет владелец
     в окне «Поделиться» (vetvi:room-settings), персистится с комнатой. */
  linkMode?: 'off' | 'members' | 'open' | null
}

/* ─── персистентность: SQLite (bun:sqlite) ───
   Схема:
     rooms(id PK, doc, updated_at, pass_salt, pass_hash) — по записи на комнату;
     merges(id PK, room_id, copy_id, sender, created_at, status, stats, doc) —
       по записи на merge-заявку.
   JSON-колонки хранят те же структуры, что раньше лежали в store.json:
   формат данных не меняется — меняется только способ хранения. */

const DATA_DIR = new URL('./data/', import.meta.url).pathname
const DATA_FILE = DATA_DIR + 'store.json' // legacy-хранилище (только для миграции)
const DB_FILE = DATA_DIR + 'store.db'

/* ─── главная БД (аккаунты, сессии, доступы) ───
   Та же SQLite-база, куда пишет Next.js через Prisma (volume web-data,
   в контейнере монтируется в /db — см. docker-compose.yml). Читаем сессии
   при join и доступы (ProjectAccess) для роли/права редактирования.

   Открытие ЛЕНИВОЕ: база лежит в томе web-контейнера и может появиться
   позже первого старта sync (или таблицы в ней создаются init-db'ом уже
   после нас) — если при старте её нет, раньше mainDb навсегда оставался
   null и вся коллаборация считалась «гостями только для чтения». Теперь
   пробуем открыть при каждом обращении, пока не получится; после ошибки
   схемы («no such table») соединение сбрасывается и переоткрывается. */
const MAIN_DB_FILE =
  process.env.VETVI_MAIN_DB || new URL('../../db/custom.db', import.meta.url).pathname
let mainDb: Database | null = null
let mainDbWarnAt = 0
let qSessionRow: ReturnType<Database['prepare']> | null = null
let qAccessRole: ReturnType<Database['prepare']> | null = null
let qAccessCount: ReturnType<Database['prepare']> | null = null
let qAccessRename: ReturnType<Database['prepare']> | null = null

/* предупреждение о недоступной главной БД — не чаще раза в 30 секунд,
   чтобы не заспамить лог, но причина «все гости только для чтения»
   была видна в docker logs сразу */
function warnMainDb(reason: string, e?: unknown): void {
  if (Date.now() - mainDbWarnAt < 30_000) return
  mainDbWarnAt = Date.now()
  console.error(
    `[vetvi-sync] главная БД (${reason}): ${MAIN_DB_FILE}\n` +
      '  → без неё сессии/роли не проверяются, ВСЕ участники комнат — гости только для чтения.\n' +
      '  → проверьте docker-compose.yml: volume web-data:/db в сервисе sync и env VETVI_MAIN_DB=/db/custom.db,\n' +
      '    затем docker compose up -d --force-recreate sync',
    e || '',
  )
}

function openMainDb(): void {
  if (mainDb) return
  /* файла ещё нет — не создаём пустую базу вместо Prisma, попробуем позже */
  if (!existsSync(MAIN_DB_FILE)) {
    warnMainDb('файл не найден')
    return
  }
  try {
    const d = new Database(MAIN_DB_FILE)
    try { d.exec('PRAGMA journal_mode = WAL;') } catch { /* режим уже установлен */ }
    d.exec('PRAGMA busy_timeout = 5000;')
    qSessionRow = d.prepare(
      `SELECT s.userId AS userId, s.expiresAt AS expiresAt,
              a.login AS login, a.displayName AS displayName, a.color AS color
         FROM AuthSession s JOIN AuthUser a ON a.id = s.userId WHERE s.token = ?`,
    )
    qAccessRole = d.prepare('SELECT role FROM ProjectAccess WHERE roomId = ? AND userId = ?')
    qAccessCount = d.prepare('SELECT COUNT(*) AS c FROM ProjectAccess WHERE roomId = ?')
    qAccessRename = d.prepare('UPDATE ProjectAccess SET projectName = ? WHERE roomId = ?')
    mainDb = d
    mainDbWarnAt = 0
    console.log('[vetvi-sync] главная БД открыта:', MAIN_DB_FILE)
  } catch (e) {
    warnMainDb('ошибка открытия', e)
  }
}

function dropMainDb(): void {
  try { mainDb?.close() } catch { /* уже закрыта */ }
  mainDb = null
  qSessionRow = null
  qAccessRole = null
  qAccessCount = null
  qAccessRename = null
}

/* после «no such table» (база создана, но init-db ещё не отработал)
   соединение бессмысленно — сбрасываем, следующий вызов переоткроет */
function isSchemaError(e: unknown): boolean {
  const msg = String((e as Error)?.message || e)
  return msg.includes('no such table') || msg.includes('no such column')
}

/* сессия действительна? имя/цвет аккаунта всегда берём из БД —
   их больше нельзя менять произвольно. При SQLITE_BUSY — короткий ретрай. */
function verifySession(token: unknown, userId: unknown): AccInfo | null {
  openMainDb()
  if (!mainDb || !qSessionRow || typeof token !== 'string' || !token) return null
  const t = token.slice(0, 128)
  let lastErr: unknown = null
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const row = qSessionRow.get(t) as
        | { userId: string; expiresAt: string | number; login: string; displayName: string | null; color: string }
        | null
      if (!row) return null
      const exp = typeof row.expiresAt === 'number' ? row.expiresAt : Date.parse(String(row.expiresAt))
      if (!Number.isFinite(exp) || exp <= Date.now()) return null
      if (typeof userId === 'string' && userId && userId !== row.userId) return null
      return {
        id: row.userId,
        name: String(row.displayName || row.login || 'Гость').slice(0, 40),
        color: String(row.color || '#8b929c').slice(0, 20),
        login: String(row.login || ''),
      }
    } catch (e) {
      if (isSchemaError(e)) {
        dropMainDb()
        return null // переоткроем (и переподготовим запросы) на следующем вызове
      }
      lastErr = e
      const spin = Date.now() + 60
      while (Date.now() < spin) { /* busy spin */ }
    }
  }
  console.error('[vetvi-sync] session check error', lastErr)
  return null
}

function accessRole(roomId: string, userId: string): 'owner' | 'admin' | 'editor' | 'reader' | null {
  openMainDb()
  if (!mainDb || !qAccessRole) return null
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const row = qAccessRole.get(roomId, userId) as { role: string } | null
      if (row && (row.role === 'owner' || row.role === 'admin' || row.role === 'editor' || row.role === 'reader')) return row.role
      return null
    } catch (e) {
      if (isSchemaError(e)) {
        dropMainDb()
        return null
      }
      if (attempt === 2) console.error('[vetvi-sync] access role error', e)
      const spin = Date.now() + 60
      while (Date.now() < spin) { /* busy spin */ }
    }
  }
  return null
}

function accessCount(roomId: string): number {
  openMainDb()
  if (!mainDb || !qAccessCount) return 0
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return (qAccessCount.get(roomId) as { c: number }).c
    } catch (e) {
      if (isSchemaError(e)) {
        dropMainDb()
        return 0
      }
      if (attempt === 2) console.error('[vetvi-sync] access count error', e)
      const spin = Date.now() + 60
      while (Date.now() < spin) { /* busy spin */ }
    }
  }
  return 0
}

mkdirSync(DATA_DIR, { recursive: true })
const db = new Database(DB_FILE)
db.exec('PRAGMA journal_mode = WAL;') // быстрые записи, устойчивость к сбоям
db.exec('PRAGMA synchronous = NORMAL;')
db.exec('PRAGMA busy_timeout = 5000;')

db.exec(`
  CREATE TABLE IF NOT EXISTS rooms (
    id         TEXT PRIMARY KEY,
    doc        TEXT,
    updated_at TEXT NOT NULL,
    pass_salt  TEXT,
    pass_hash  TEXT,
    link_mode  TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_rooms_updated ON rooms(updated_at);
  CREATE TABLE IF NOT EXISTS merges (
    id           TEXT PRIMARY KEY,
    room_id      TEXT NOT NULL,
    copy_id      TEXT NOT NULL,
    sender_name  TEXT NOT NULL DEFAULT 'Гость',
    sender_color TEXT NOT NULL DEFAULT '#8b929c',
    created_at   TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'pending',
    stats        TEXT,
    doc_current  TEXT,
    doc_base     TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_merges_room ON merges(room_id);
  CREATE INDEX IF NOT EXISTS idx_merges_copy ON merges(room_id, copy_id, status);
  CREATE TABLE IF NOT EXISTS snapshots (
    id         TEXT PRIMARY KEY,
    room_id    TEXT NOT NULL,
    kind       TEXT NOT NULL DEFAULT 'merge',
    label      TEXT,
    doc        TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_snaps_room ON snapshots(room_id, created_at);
`)

/* миграция существующих БД: колонки kind/decided_name/decided_at в merges
   появились позже — добавляем, если их нет (ALTER TABLE идемпотентно) */
try {
  const mcols = db.query('PRAGMA table_info(merges)').all() as { name: string }[]
  if (!mcols.some((c) => c.name === 'kind')) {
    db.exec("ALTER TABLE merges ADD COLUMN kind TEXT NOT NULL DEFAULT 'copy'")
    console.log('[vetvi-sync] merges: добавлена колонка kind')
  }
  if (!mcols.some((c) => c.name === 'decided_name')) {
    db.exec('ALTER TABLE merges ADD COLUMN decided_name TEXT')
    console.log('[vetvi-sync] merges: добавлена колонка decided_name')
  }
  if (!mcols.some((c) => c.name === 'decided_at')) {
    db.exec('ALTER TABLE merges ADD COLUMN decided_at TEXT')
    console.log('[vetvi-sync] merges: добавлена колонка decided_at')
  }
} catch (e) {
  console.error('[vetvi-sync] миграция merges (kind/decided) не удалась', e)
}

/* миграция существующих БД: колонка link_mode появилась позже — добавляем,
   если её нет (в старых базах таблица rooms уже создана без неё) */
try {
  const cols = db.query("PRAGMA table_info(rooms)").all() as { name: string }[]
  if (!cols.some((c) => c.name === 'link_mode')) {
    db.exec('ALTER TABLE rooms ADD COLUMN link_mode TEXT')
    console.log('[vetvi-sync] rooms: добавлена колонка link_mode')
  }
} catch (e) {
  console.error('[vetvi-sync] миграция link_mode не удалась', e)
}

interface RoomRow {
  id: string
  doc: string | null
  updated_at: string
  pass_salt: string | null
  pass_hash: string | null
  link_mode: string | null
}

interface MergeRow {
  id: string
  room_id: string
  copy_id: string
  sender_name: string
  sender_color: string
  created_at: string
  status: string
  stats: string | null
  doc_current: string | null
  doc_base: string | null
  kind?: string | null
  decided_name?: string | null
  decided_at?: string | null
}

/* подготовленные выражения */
const qRoomById = db.prepare(
  'SELECT id, doc, updated_at, pass_salt, pass_hash, link_mode FROM rooms WHERE id = ?',
)
/* лёгкая проверка существования комнаты (для статуса «офлайн» в списках доступов:
   выключенный владельцем сетевой режим удаляет строку комнаты) */
const qRoomExists = db.prepare('SELECT id FROM rooms WHERE id = ?')
const qRoomsCount = db.prepare('SELECT COUNT(*) AS c FROM rooms')
const qMergesCount = db.prepare('SELECT COUNT(*) AS c FROM merges')
const qRoomUpsertDoc = db.prepare(
  `INSERT INTO rooms (id, doc, updated_at) VALUES (?, ?, ?)
   ON CONFLICT(id) DO UPDATE SET doc = excluded.doc, updated_at = excluded.updated_at`,
)
/* pass-колонки не трогаем при сохранении документа — пароль комнаты живёт своей жизнью */
const qRoomUpsertPass = db.prepare(
  `INSERT INTO rooms (id, doc, updated_at, pass_salt, pass_hash) VALUES (?, NULL, ?, ?, ?)
   ON CONFLICT(id) DO UPDATE SET pass_salt = excluded.pass_salt, pass_hash = excluded.pass_hash`,
)
const qRoomClearPass = db.prepare('UPDATE rooms SET pass_salt = NULL, pass_hash = NULL WHERE id = ?')
const qRoomSetLinkMode = db.prepare('UPDATE rooms SET link_mode = ? WHERE id = ?')
/* удаление комнаты с сервера (владелец выключил сетевой режим): вместе с
   комнатой стираются её merge-заявки — в очереди не остаётся мусора */
const qRoomDelete = db.prepare('DELETE FROM rooms WHERE id = ?')
const qMergeDelRoom = db.prepare('DELETE FROM merges WHERE room_id = ?')
const qSnapDelRoom = db.prepare('DELETE FROM snapshots WHERE room_id = ?')
const qRoomTrim = db.prepare(
  `DELETE FROM rooms WHERE id NOT IN (
     SELECT id FROM rooms ORDER BY updated_at DESC LIMIT ?
   )`,
)
const qPendingCount = db.prepare(
  "SELECT COUNT(*) AS c FROM merges WHERE room_id = ? AND status = 'pending'",
)
const qMergeList = db.prepare('SELECT * FROM merges WHERE room_id = ? ORDER BY rowid DESC')
const qMergeById = db.prepare('SELECT id, room_id, copy_id, status FROM merges WHERE id = ?')
const qMergeByIdFull = db.prepare('SELECT id, room_id, copy_id, status, doc_current, doc_base FROM merges WHERE id = ?')
const qMergeSetStatus = db.prepare('UPDATE merges SET status = ? WHERE id = ?')
const qMergeSetDecided = db.prepare('UPDATE merges SET status = ?, decided_name = ?, decided_at = ? WHERE id = ?')
const qMergeInsert = db.prepare(
  `INSERT INTO merges (id, room_id, copy_id, sender_name, sender_color, created_at, status, stats, doc_current, doc_base, kind)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
)
const qMergeKindOf = db.prepare('SELECT kind FROM merges WHERE id = ?')

/* ── снимки проекта перед слиянием/заменой ──
   Полный снимок документа комнаты сохраняется на сервере ПЕРЕД применением
   merge-запроса или заменой данных («Опубликовать локальную версию») —
   с целью контроля и отката. Хранятся последние N снимков на комнату;
   N берётся из настроек проекта (meta.snapshotsLimit, 10–30, по умолчанию 20). */
const qSnapInsert = db.prepare(
  `INSERT INTO snapshots (id, room_id, kind, label, doc, created_at)
   VALUES (?, ?, ?, ?, ?, ?)`,
)
const qSnapTrimRoom = db.prepare(
  `DELETE FROM snapshots WHERE room_id = ? AND id NOT IN (
     SELECT id FROM snapshots WHERE room_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?
   )`,
)
const qSnapsCount = db.prepare('SELECT COUNT(*) AS c FROM snapshots')
const qMergeDelPendingOfCopy = db.prepare(
  "DELETE FROM merges WHERE room_id = ? AND copy_id = ? AND status = 'pending'",
)
const qMergeTrimRoom = db.prepare(
  `DELETE FROM merges WHERE room_id = ? AND id NOT IN (
     SELECT id FROM merges WHERE room_id = ? ORDER BY rowid DESC LIMIT ?
   )`,
)

/* ── миграция legacy store.json → SQLite ──
   Выполняется один раз: если store.json существует, а БД пуста, все комнаты
   и merge-заявки переносятся построчно в таблицы. Merge-заявки вставляются в
   обратном порядке (в JSON они хранились «новые первыми»), чтобы rowid
   воспроизводил прежний порядок списков. Исходный файл переименовывается в
   store.json.backup-<дата> — данные не удаляются. */
function migrateJsonToSqlite() {
  if (!existsSync(DATA_FILE)) return
  const roomsCount = (qRoomsCount.get() as { c: number }).c
  const mergesCount = (qMergesCount.get() as { c: number }).c
  if (roomsCount > 0 || mergesCount > 0) {
    console.log('[vetvi-sync] store.json найден, но в БД уже есть данные — миграция пропущена')
    return
  }
  try {
    const parsed = JSON.parse(readFileSync(DATA_FILE, 'utf8')) as {
      rooms?: Record<string, StoredRoom>
      merges?: Record<string, MergeRequest[]>
    }
    const legacyRooms = parsed?.rooms || {}
    const legacyMerges = parsed?.merges || {}
    const insRoom = db.prepare(
      'INSERT OR REPLACE INTO rooms (id, doc, updated_at, pass_salt, pass_hash) VALUES (?, ?, ?, ?, ?)',
    )
    const insMerge = db.prepare(
      `INSERT OR REPLACE INTO merges
       (id, room_id, copy_id, sender_name, sender_color, created_at, status, stats, doc_current, doc_base)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    let nRooms = 0
    let nMerges = 0
    db.transaction(() => {
      for (const [id, r] of Object.entries(legacyRooms)) {
        if (!r || typeof r !== 'object') continue
        const pass = r.pass
        insRoom.run(
          id,
          r.doc !== undefined && r.doc !== null ? JSON.stringify(r.doc) : null,
          String(r.updatedAt || new Date().toISOString()),
          pass && typeof pass.salt === 'string' ? pass.salt : null,
          pass && typeof pass.hash === 'string' ? pass.hash : null,
        )
        nRooms++
      }
      for (const [roomId, list] of Object.entries(legacyMerges)) {
        if (!Array.isArray(list)) continue
        for (const m of [...list].reverse()) {
          if (!m || typeof m.id !== 'string' || !m.id) continue
          insMerge.run(
            m.id,
            roomId,
            String(m.copyId || ''),
            String(m.sender?.name || 'Гость'),
            String(m.sender?.color || '#8b929c'),
            String(m.createdAt || new Date().toISOString()),
            m.status === 'applied' || m.status === 'rejected' ? m.status : 'pending',
            m.stats ? JSON.stringify(m.stats) : null,
            m.doc && m.doc.current !== undefined && m.doc.current !== null
              ? JSON.stringify(m.doc.current)
              : null,
            m.doc && m.doc.base !== undefined && m.doc.base !== null
              ? JSON.stringify(m.doc.base)
              : null,
          )
          nMerges++
        }
      }
    })()
    let backupNote = ''
    try {
      const backup = DATA_FILE + '.backup-' + new Date().toISOString().replace(/[:.]/g, '-')
      renameSync(DATA_FILE, backup)
      backupNote = `, исходный файл сохранён как ${backup}`
    } catch {
      backupNote = ' (исходный файл переименовать не удалось — оставлен на месте)'
    }
    console.log(
      `[vetvi-sync] миграция store.json → SQLite завершена: комнат ${nRooms}, merge-заявок ${nMerges}${backupNote}`,
    )
    scheduleTrim()
  } catch (e) {
    console.error('[vetvi-sync] ОШИБКА миграции store.json → SQLite (файл не тронут):', e)
  }
}

/* ── доступ к хранилищу ── */

function rowToMerge(r: MergeRow): MergeRequest {
  let stats: Record<string, number> = {}
  if (r.stats) {
    try {
      stats = JSON.parse(r.stats)
    } catch {
      stats = {}
    }
  }
  let current: unknown = null
  let base: unknown = null
  if (r.doc_current) {
    try {
      current = JSON.parse(r.doc_current)
    } catch {
      current = null
    }
  }
  if (r.doc_base) {
    try {
      base = JSON.parse(r.doc_base)
    } catch {
      base = null
    }
  }
  return {
    id: r.id,
    roomId: r.room_id,
    copyId: r.copy_id,
    sender: { name: r.sender_name, color: r.sender_color },
    createdAt: r.created_at,
    status: r.status === 'applied' || r.status === 'rejected' ? r.status : 'pending',
    stats,
    doc: { current, base },
    kind: r.kind === 'replace' ? 'replace' : 'copy',
    decidedBy: r.decided_name || null,
    decidedAt: r.decided_at || null,
  }
}

/* ── снимки: вставка (полный doc комнаты) + подрезка по лимиту проекта ── */
function snapshotInsert(roomId: string, kind: 'merge' | 'replace', label: string, doc: unknown): boolean {
  try {
    const json = JSON.stringify(doc)
    if (!json || json === '{"nodes":[]}') return false
    qSnapInsert.run('sn' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8), roomId, kind, label.slice(0, 160), json, new Date().toISOString())
    qSnapTrimRoom.run(roomId, roomId, snapshotsLimitFor(roomId))
    return true
  } catch (e) {
    console.error('[vetvi-sync] snapshot insert error', e)
    return false
  }
}

/* лимит снимков комнаты: meta.snapshotsLimit из сохранённого документа проекта
   (настройки проекта синхронизируются с комнатой как обычные правки).
   10–30 по требованию, по умолчанию 20. */
function snapshotsLimitFor(roomId: string): number {
  let limit = 20
  try {
    const row = qRoomById.get(roomId) as { doc: string | null } | null
    if (row && row.doc) {
      const parsed = JSON.parse(row.doc) as { meta?: { snapshotsLimit?: unknown } } | null
      const n = Number(parsed?.meta?.snapshotsLimit)
      if (Number.isFinite(n)) limit = n
    }
  } catch { /* нет комнаты/документа — лимит по умолчанию */ }
  return Math.max(10, Math.min(30, Math.floor(limit)))
}

function getStoredRoom(roomId: string): StoredRoom | null {
  const row = qRoomById.get(roomId) as RoomRow | null
  if (!row) return null
  let doc: unknown = null
  if (row.doc) {
    try {
      doc = JSON.parse(row.doc)
    } catch {
      doc = null
    }
  }
  const out: StoredRoom = { doc, updatedAt: row.updated_at }
  if (row.pass_salt && row.pass_hash) out.pass = { salt: row.pass_salt, hash: row.pass_hash }
  if (row.link_mode === 'off' || row.link_mode === 'members' || row.link_mode === 'open') {
    out.linkMode = row.link_mode
  }
  return out
}

function saveRoomLinkMode(roomId: string, mode: 'off' | 'members' | 'open') {
  qRoomSetLinkMode.run(mode, roomId)
}

function saveRoomDoc(roomId: string, doc: unknown, updatedAt: string) {
  qRoomUpsertDoc.run(roomId, JSON.stringify(doc), updatedAt)
}

function saveRoomPass(roomId: string, pass: { salt: string; hash: string } | null) {
  if (pass) {
    qRoomUpsertPass.run(roomId, new Date().toISOString(), pass.salt, pass.hash)
  } else {
    qRoomClearPass.run(roomId)
  }
}

function pendingCount(roomId: string): number {
  return (qPendingCount.get(roomId) as { c: number }).c
}

function mergeListOf(roomId: string): MergeRequest[] {
  return (qMergeList.all(roomId) as MergeRow[]).map(rowToMerge)
}

function mergeStatusesByIds(ids: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const id of ids) {
    const row = qMergeById.get(id) as { id: string; status: string } | null
    if (row) out[row.id] = row.status
  }
  return out
}

/* ─── комнаты ─── */

interface RoomState {
  name: string
  members: Map<string, RoomMember>
  locks: Map<string, ObjLock>
  focus: Map<string, SocketFocus>
  /* пароль комнаты: первый вошедший с защищённым проектом закрепляет salt+hash,
     дальнейшие join требуют пароль (проверка на сервере) */
  pass: { salt: string; hash: string } | null
  /* доступ по ссылке (см. StoredRoom.linkMode) — меняет владелец из окна */
  linkMode: 'off' | 'members' | 'open'
  /* актуальное название проекта комнаты: обновляется при публикации документа
     (meta.name) — синхронизируется в ProjectAccess.projectName (списки проектов
     участников показывают свежее имя даже пока проект закрыт) и раздаётся
     подписчикам события vetvi:room-meta */
  pname: string | null
  gcTimer: ReturnType<typeof setTimeout> | null
}

/* ── «где сейчас работает участник» ──
   Клиент сообщает id ноды, с которой работает (открыл редактор, тянет, выбрал);
   сервер держит по одному фокусу на сокет и раздаёт список по комнате.
   Эфемерно: не персистится, чистится при disconnect. */
interface SocketFocus {
  userId: string
  nodeId: string
  ts: number
}

/* ─── блокировки объектов (soft-lock) ───
   Эфемерны: не персистятся, снимаются при disconnect или по TTL.
   Клиент, начавший редактирование объекта, захватывает lock; остальные
   получают vetvi:locks и показывают «объект используется другим пользователем». */

interface ObjLock {
  sid: string
  userId: string
  name: string
  color: string
  ts: number
}

const LOCK_TTL_MS = 3 * 60 * 1000 // страховка: если клиент «завис» и не шлёт heartbeat
const MAX_LOCKS_PER_SOCKET = 400

const rooms = new Map<string, RoomState>()

function room_members_get(roomName: string, sid: string): RoomMember | null {
  return rooms.get(roomName)?.members.get(sid) || null
}

function getRoom(name: string): RoomState {
  let room = rooms.get(name)
  if (!room) {
    room = { name, members: new Map(), locks: new Map(), focus: new Map(), pass: null, linkMode: 'open', pname: null, gcTimer: null }
    rooms.set(name, room)
  }
  if (room.gcTimer) {
    clearTimeout(room.gcTimer)
    room.gcTimer = null
  }
  return room
}

/* имя проекта из документа комнаты (meta.name), безопасно */
function docProjectName(doc: unknown): string | null {
  if (!doc || typeof doc !== 'object') return null
  const meta = (doc as { meta?: unknown }).meta
  if (!meta || typeof meta !== 'object') return null
  const nm = (meta as { name?: unknown }).name
  if (typeof nm !== 'string') return null
  const t = nm.trim().slice(0, 120)
  return t || null
}

/* переименование проекта комнаты: название хранится в ProjectAccess (списки
   «Мои проекты»/«Вам открыли доступ» у участников обновляются даже пока проект
   у них закрыт — в реальном времени по vetvi:room-meta и после перезагрузки
   страницы через /api/rooms/names). Ошибки БД не роняют комнату. */
function applyRoomRename(roomId: string, name: string): void {
  const room = getRoom(roomId)
  if (room.pname === name) return
  room.pname = name
  try {
    openMainDb()
    if (mainDb && qAccessRename) {
      qAccessRename.run(name, roomId)
    }
  } catch (e) {
    if (isSchemaError(e)) dropMainDb()
    else warnMainDb('обновление projectName', e)
  }
  io.to(roomId).emit('vetvi:room-meta', { roomId, name })
}

/* sha256 в hex — тот же формат, что и на клиенте (utf-8) */
const sha256hex = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex')

function scheduleRoomGc(room: RoomState) {
  if (room.gcTimer) clearTimeout(room.gcTimer)
  room.gcTimer = setTimeout(() => {
    if (room.members.size === 0) {
      rooms.delete(room.name)
      console.log(`[vetvi-sync] room "${room.name}" reclaimed (idle)`)
    }
  }, ROOM_TTL_MS)
}

function userList(room: RoomState) {
  const out: UserMeta[] = []
  const seen = new Set<string>()
  for (const m of room.members.values()) {
    if (seen.has(m.user.id)) continue
    seen.add(m.user.id)
    out.push({ ...m.user, canEdit: m.canEdit })
  }
  return out
}

/* Чистка «призраков»: сокет мог отвалиться без события disconnect
   (обрыв соединения, рестарт транспорта) — если сокета больше нет
   в списке подключённых, участник не считается онлайн-пользователем. */
function sweepStaleMembers(io: Server, room: RoomState): boolean {
  let changed = false
  for (const [sid] of room.members) {
    if (!io.of('/').sockets.has(sid)) {
      room.members.delete(sid)
      changed = true
    }
  }
  return changed
}

/* есть ли живые участники в комнате (до создания RoomState) */
function room_members_count(roomName: string): number {
  return rooms.get(roomName)?.members.size || 0
}

function broadcastUsers(io: Server, room: RoomState) {
  io.to(room.name).emit('vetvi:users', { roomId: room.name, users: userList(room) })
}

/* ─── push-уведомления аккаунтам (колокольчик) ───
   Сокет авторизованного аккаунта регистрируется событием vetvi:ntf-hello
   (токен сессии проверяется по общей БД) — независимо от комнат. Web-сервер
   (POST /api/access/grant|revoke) после записи уведомления в БД пушит его
   на /internal/notify — сокетам этого пользователя летит vetvi:ntf, и
   колокольчик (точка непрочитанного) обновляется мгновенно, без ожидания
   опроса. Опрос /api/notifications остаётся страховкой (sync перезапустили,
   сокет умер — новое уведомление всё равно появится). */
const ntfSockets = new Map<string, Set<Socket>>()

function ntfRegister(userId: string, sock: Socket): void {
  const uid = String(userId || '')
  if (!uid) return
  let set = ntfSockets.get(uid)
  if (!set) {
    set = new Set()
    ntfSockets.set(uid, set)
  }
  set.add(sock)
}

function ntfUnregister(sock: Socket): void {
  for (const [uid, set] of ntfSockets) {
    if (set.delete(sock) && set.size === 0) ntfSockets.delete(uid)
  }
}

function notifyUser(userId: string, ntf: unknown): number {
  const set = ntfSockets.get(String(userId || ''))
  if (!set || set.size === 0) return 0
  let sent = 0
  for (const sock of set) {
    try {
      sock.emit('vetvi:ntf', ntf)
      sent++
    } catch {
      /* сокет умер — unregister сделает disconnect */
    }
  }
  return sent
}

/* ─── свип ролей: доступы могут измениться, пока участник онлайн ───
   Владелец выдал/отозвал/поменял роль через окно «Поделиться» — участник
   получает актуальное право редактирования без переподключения сокета:
   свип каждые ROLE_SWEEP_MS перечитывает ProjectAccess, обновляет canEdit,
   шлёт vetvi:role (смена прав) и выгоняет отозванных. Мгновенный путь —
   внутренний HTTP-push (порт VETVI_INTERNAL_PORT) от /api/access/*. */
const ROLE_SWEEP_MS = 3 * 1000

function sweepRoles(io: Server) {
  for (const room of rooms.values()) {
    if (room.members.size === 0) continue
    /* legacy-комната (ни одной записи ProjectAccess): роли не применяются —
       там право правки определяется legacy-claim'ом клиента, не БД */
    if (accessCount(room.name) === 0) continue
    const seen = new Map<string, string[]>()
    for (const [sid, m] of room.members) {
      if (!m.accId) continue
      const arr = seen.get(m.accId)
      if (arr) arr.push(sid)
      else seen.set(m.accId, [sid])
    }
    let changed = false
    for (const [accId, sids] of seen) {
      const role = accessRole(room.name, accId)
      for (const sid of sids) {
        const sock = io.of('/').sockets.get(sid)
        if (!sock) continue // призрак — уберёт sweepStaleMembers
        if (applyAccessRole(room, sid, role, sock) !== 'kept') changed = true
      }
    }
    if (changed) broadcastUsers(io, room)
  }
}

/* ── мгновенное применение смены прав доступа ──
   Роли (ProjectAccess в общей БД) могут измениться, пока участник в комнате.
   Сервер замечает это тремя путями: внутренний HTTP-push (Next.js → /internal
   после grant/revoke), свип ролей (ROLE_SWEEP_MS) и проверка при каждой
   попытке записи (sockCanEditNow). При отзыве доступа участник немедленно
   выгоняется из комнаты (vetvi:kicked reason=revoked); при смене роли сразу
   получает vetvi:role — право правки меняется БЕЗ перезагрузки страницы. */

/* право сокета на правку: по socket.id — чтобы менять извне (не только в join) */
const sockCanEditMap = new Map<string, boolean>()
const sockRoleCheckedAt = new Map<string, number>()
const ROLE_CHECK_MS = 2500

function applyAccessRole(room: RoomState, sid: string, role: string | null, sock: Socket): 'kept' | 'updated' | 'kicked' {
  const m = room.members.get(sid)
  if (!m) return 'kicked'
  /* записи доступа больше нет (отзыв) — выгоняем ТОЛЬКО того, у кого доступ
     был (owner/editor/reader). Гость по открытой ссылке (role='guest', даже
     с сессией аккаунта) остаётся в комнате: его нахождение регулирует
     linkMode (vetvi:room-settings), а не записи ProjectAccess. */
  if (!role) {
    if (m.role && m.role !== 'guest') {
      try { sock.emit('vetvi:kicked', { roomId: room.name, reason: 'revoked' }) } catch { /* сокет умер */ }
      room.members.delete(sid)
      releaseSocketLocks(io, room, sid)
      releaseSocketFocus(io, room, sid)
      sockCanEditMap.set(sid, false)
      sock.leave(room.name)
      console.log(`[vetvi-sync] access revoked → kicked "${m.user.name}" from "${room.name}"`)
      return 'kicked'
    }
    /* гость без записи: право правки не выдаётся (страховка) */
    sockCanEditMap.set(sid, false)
    m.canEdit = false
    return 'kept'
  }
  const canEdit = role === 'owner' || role === 'admin' || role === 'editor'
  const was = sockCanEditMap.get(sid) === true
  m.role = role
  m.canEdit = canEdit
  sockCanEditMap.set(sid, canEdit)
  if (canEdit !== was) {
    try { sock.emit('vetvi:role', { roomId: room.name, role, canEdit }) } catch { /* сокет умер */ }
    console.log(`[vetvi-sync] role "${m.user.name}" in "${room.name}" → ${role} (canEdit=${canEdit})`)
    return 'updated'
  }
  return canEdit ? 'kept' : 'updated'
}

/* проверка права записи: кэш ROLE_CHECK_MS на сокет, свіжая проверка по БД —
   смена прав запрещает правки быстрее любого свипа (первая же попытка записи) */
function sockCanEditNow(socket: Socket, roomName: string | null): boolean {
  const room = roomName ? rooms.get(roomName) : null
  if (!room) return false
  const now = Date.now()
  const last = sockRoleCheckedAt.get(socket.id) || 0
  if (now - last < ROLE_CHECK_MS) return sockCanEditMap.get(socket.id) === true
  sockRoleCheckedAt.set(socket.id, now)
  if (accessCount(room.name) === 0) return sockCanEditMap.get(socket.id) === true
  const m = room.members.get(socket.id)
  if (!m || !m.accId) return sockCanEditMap.get(socket.id) === true
  const role = accessRole(room.name, m.accId)
  const st = applyAccessRole(room, socket.id, role, socket)
  if (st !== 'kept') broadcastUsers(io, room)
  return sockCanEditMap.get(socket.id) === true
}

/* ─── блокировки объектов ─── */

function lockList(room: RoomState) {
  const now = Date.now()
  const out: { id: string; userId: string; name: string; color: string }[] = []
  for (const [id, l] of room.locks) {
    if (now - l.ts > LOCK_TTL_MS) {
      room.locks.delete(id)
      continue
    }
    out.push({ id, userId: l.userId, name: l.name, color: l.color })
  }
  return out
}

function broadcastLocks(io: Server, room: RoomState) {
  io.to(room.name).emit('vetvi:locks', { roomId: room.name, locks: lockList(room) })
}

/* ── фокус участников (id ноды, с которой работает) ── */

const MAX_FOCUS_NODE_LEN = 80

function focusList(room: RoomState) {
  const byUser = new Map<string, { userId: string; nodeId: string; ts: number }>()
  for (const f of room.focus.values()) {
    if (!f.userId || !f.nodeId) continue
    const prev = byUser.get(f.userId)
    if (!prev || prev.ts < f.ts) byUser.set(f.userId, { userId: f.userId, nodeId: f.nodeId, ts: f.ts })
  }
  return Array.from(byUser.values()).map((f) => ({ userId: f.userId, nodeId: f.nodeId }))
}

function broadcastFocus(io: Server, room: RoomState) {
  io.to(room.name).emit('vetvi:focus', { roomId: room.name, focus: focusList(room) })
}

function releaseSocketFocus(io: Server, room: RoomState, sid: string) {
  if (room.focus.delete(sid)) broadcastFocus(io, room)
}

function releaseSocketLocks(io: Server, room: RoomState, sid: string) {
  let changed = false
  for (const [id, l] of room.locks) {
    if (l.sid === sid) {
      room.locks.delete(id)
      changed = true
    }
  }
  if (changed) broadcastLocks(io, room)
}

/* ─── лимит комнат (было MAX_ROOMS в общем JSON, теперь — строк таблицы rooms) ─── */

function trimRooms() {
  const cnt = (qRoomsCount.get() as { c: number }).c
  if (cnt <= MAX_ROOMS) return
  qRoomTrim.run(MAX_ROOMS)
  const left = (qRoomsCount.get() as { c: number }).c
  console.log(`[vetvi-sync] trimRooms: удалено комнат ${cnt - left} (лимит ${MAX_ROOMS})`)
}

let trimTimer: ReturnType<typeof setTimeout> | null = null

function scheduleTrim() {
  if (trimTimer) return
  trimTimer = setTimeout(() => {
    trimTimer = null
    try {
      trimRooms()
    } catch (e) {
      console.error('[vetvi-sync] trim error', e)
    }
  }, TRIM_EVERY_MS)
}

/* ─── socket.io ─── */

const httpServer = createServer()

const io = new Server(httpServer, {
  // DO NOT change the path, it is used by Caddy to forward the request to the correct port
  path: '/',
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
  pingTimeout: 60000,
  pingInterval: 25000,
  maxHttpBufferSize: MAX_MERGE_BYTES,
})

const isSafeRoom = (room: unknown): room is string =>
  typeof room === 'string' && room.length > 0 && room.length <= 256

io.on('connection', (socket: Socket) => {
  let joinedRoom: string | null = null

  /* ── вход в комнату ── */
  socket.on(
    'vetvi:join',
    (
      payload: {
        roomId?: string
        user?: UserMeta
        /* пароль комнаты (если защищена) */
        password?: string
        /* salt+hash защищённого проекта: закрепляется за комнатой первым вошедшим */
        pass?: { salt?: string; hash?: string }
        /* сессия аккаунта: токен + id — имя/цвет берутся из БД */
        token?: string
        userId?: string
        /* тихий rejoin (обновление роли): без «X — в комнате» остальным */
        quiet?: boolean
        /* вошедший публикует локальный проект (переключатель «Общедоступный»):
           может открыть комнату, которой ещё/уже нет на сервере */
        own?: boolean
      },
      ack?: (r: unknown) => void,
    ) => {
      try {
        const roomName = payload?.roomId
        if (!isSafeRoom(roomName)) {
          ack?.({ ok: false, error: 'bad room' })
          return
        }

        /* аккаунт и роль: сессия проверяется по главной БД, доступ — по ProjectAccess.
           Без сессии/доступа — «гость по ссылке»: имя из payload, только чтение. */
        const acc = verifySession(payload?.token, payload?.userId)
        const role = acc ? accessRole(roomName, acc.id) : null
        const canEdit = role === 'owner' || role === 'admin' || role === 'editor'
        if (process.env.VETVI_DEBUG) {
          console.log(`[vetvi-sync][debug] join "${roomName}" tok=${typeof payload?.token === 'string' ? payload.token.slice(0, 8) : JSON.stringify(payload?.token)} userId=${JSON.stringify(payload?.userId)} acc=${acc ? acc.id : null} role=${role}`)
        }

        /* комната на сервере — это сохранённый документ. Если его НЕТ (комната
           никогда не публиковалась или удалена владельцем при выключении
           сетевого режима), открыть комнату может только тот, кто публикует
           локальный проект (own — переключатель «Общедоступный»). Все остальные
           — гости по ссылке и УЧАСТНИКИ С РОЛЬЮ (они «серые» после выключения)
           получают room_closed: комната удалена — никто не подключается,
           вместо тихого создания пустой комнаты. */
        const storedRoomEarly = getStoredRoom(roomName)
        const ownClaim = payload?.own === true
        if (!storedRoomEarly && room_members_count(roomName) === 0 && !ownClaim) {
          ack?.({ ok: false, error: 'room_closed' })
          return
        }

        const user: UserMeta = acc
          ? { id: acc.id, name: acc.name, color: acc.color }
          : {
              id: String(payload?.user?.id || socket.id),
              name: String(payload?.user?.name || 'Гость').slice(0, 40),
              color: String(payload?.user?.color || '#8b929c').slice(0, 20),
            }

        const room = getRoom(roomName)

        /* пароль комнаты: восстановить из SQLite */
        const storedRoom = storedRoomEarly
        if (!room.pass && storedRoom?.pass?.salt && storedRoom?.pass?.hash) {
          room.pass = { salt: String(storedRoom.pass.salt), hash: String(storedRoom.pass.hash) }
        }
        /* доступ по ссылке: восстановить из SQLite (меняется в окне «Поделиться») */
        if (storedRoom?.linkMode) room.linkMode = storedRoom.linkMode

        const isMember = room.members.has(socket.id)

        /* ограничение ссылки: пользователь БЕЗ записи доступа (гость по ссылке)
           входит только при linkMode = 'open'. Участники с доступом (и legacy-
           комнаты вообще без записей доступов) проходят как раньше. */
        if (!isMember && !role && room.linkMode !== 'open' && accessCount(roomName) > 0) {
          ack?.({
            ok: false,
            error: room.linkMode === 'off' ? 'link_off' : 'members_only',
          })
          return
        }

        /* закрепление пароля: комната ещё без пароля, вошедший пришёл salt+hash
           защищённого проекта. Пустая комната — закрепляем сразу; в комнате с
           документом — только если это тот же защищённый проект. */
        if (
          !room.pass &&
          !isMember &&
          payload.pass &&
          typeof payload.pass.salt === 'string' &&
          typeof payload.pass.hash === 'string' &&
          /^[0-9a-f]{16,64}$/.test(payload.pass.salt) &&
          /^[0-9a-f]{64}$/.test(payload.pass.hash)
        ) {
          const claimSalt = payload.pass.salt.slice(0, 64)
          const claimHash = payload.pass.hash.slice(0, 64)
          const storedDoc = storedRoom?.doc as { meta?: { passHash?: string } } | undefined
          const docHash =
            storedDoc && typeof storedDoc === 'object' && storedDoc.meta
              ? storedDoc.meta.passHash
              : null
          if (!storedDoc || !docHash || docHash === claimHash) {
            room.pass = { salt: claimSalt, hash: claimHash }
            saveRoomPass(roomName, room.pass) // пароль сразу персистится в БД
          }
        }

        /* проверка пароля: участник комнаты (rejoin) и пользователи с доступом
           (owner/editor/reader) проходят без повторного ввода */
        if (room.pass && !isMember && !role) {
          const given = typeof payload.password === 'string' ? payload.password : ''
          if (sha256hex(room.pass.salt + ':' + given) !== room.pass.hash) {
            ack?.({ ok: false, error: 'password', needPassword: true })
            return
          }
        }

        joinedRoom = roomName
        sockCanEditMap.set(socket.id, canEdit)
        sockRoleCheckedAt.delete(socket.id)
        socket.join(roomName)
        room.members.set(socket.id, { socketId: socket.id, user, canEdit, accId: acc ? acc.id : null, role: role || 'guest' })

        // удаляем призраков перед расчётом списка — счётчик онлайн всегда актуальный
        if (sweepStaleMembers(io, room)) broadcastUsers(io, room)

        /* актуальное имя проекта комнаты: из хранящегося документа (или БД при
           первом взгляде) — клиент обновляет свой список проектов при входе */
        const roomName0 = docProjectName(storedRoom ? storedRoom.doc : null)
        if (roomName0 && !room.pname) {
          room.pname = roomName0
        }

        ack?.({
          ok: true,
          count: userList(room).length,
          doc: storedRoom ? storedRoom.doc : null,
          updatedAt: storedRoom ? storedRoom.updatedAt : null,
          users: userList(room),
          pendingMerges: pendingCount(roomName),
          locks: lockList(room),
          focus: focusList(room),
          /* роль вошедшего и право на редактирование */
          role: role || 'guest',
          canEdit,
          /* режим доступа по ссылке — его показывает окно «Поделиться» */
          linkMode: room.linkMode,
          /* название проекта комнаты (meta.name хранящегося документа) */
          name: room.pname || roomName0 || undefined,
          /* legacy: в комнате ещё нет ни одной записи доступа — клиент может
             заявить владение (первый перешедший с обновления) */
          legacy: !role && accessCount(roomName) === 0,
        })

        broadcastUsers(io, room)
        /* уведомление остальным: кто вошёл (имя аккаунта + роль) — так в комнате
           сразу видят, кто перешёл по ссылке без доступа. quiet (rejoin для
           обновления роли) — без повторного «X — в комнате». */
        if (!payload?.quiet) {
          socket.to(roomName).emit('vetvi:notice', {
            roomId: roomName,
            kind: 'join',
            user: { id: user.id, name: user.name, color: user.color },
            role: role || 'guest',
            canEdit,
          })
        }
        console.log(
          `[vetvi-sync] join "${roomName}" (${user.name}${role ? ', ' + role : ''}), peers: ${userList(room).length}`,
        )
      } catch (error) {
        console.error('[vetvi-sync] join error', error)
        ack?.({ ok: false, error: 'join failed' })
      }
    },
  )

  /* ── настройки комнаты (доступ по ссылке) — меняет только владелец ──
     linkMode: off — ссылка закрыта, members — по ссылке входят только
     добавленные участники, open — все по ссылке (только чтение). */
  socket.on(
    'vetvi:room-settings',
    (
      msg: { roomId?: string; linkMode?: string },
      ack?: (r: unknown) => void,
    ) => {
      try {
        const roomName = msg?.roomId
        if (!isSafeRoom(roomName) || roomName !== joinedRoom) {
          ack?.({ ok: false, error: 'bad room' })
          return
        }
        const mode = msg?.linkMode
        if (mode !== 'off' && mode !== 'members' && mode !== 'open') {
          ack?.({ ok: false, error: 'bad mode' })
          return
        }
        /* право менять настройки: только владелец комнаты */
        const me = room_members_get(roomName, socket.id)
        const myRole = me && me.accId ? accessRole(roomName, me.accId) : null
        if (myRole !== 'owner') {
          ack?.({ ok: false, error: 'Только владелец может менять настройки ссылки' })
          return
        }
        const room = getRoom(roomName)
        room.linkMode = mode
        try { saveRoomLinkMode(roomName, mode) } catch (e) { console.error('[vetvi-sync] link_mode save error', e) }
        ack?.({ ok: true, linkMode: mode })
        io.to(roomName).emit('vetvi:room-settings', { roomId: roomName, linkMode: mode })
        /* ссылку закрыли для гостей — они покидают комнату немедленно
           (участники с доступом остаются: их право — запись ProjectAccess) */
        if (mode !== 'open') {
          for (const [sid, m] of room.members) {
            if (m.role && m.role !== 'guest') continue
            const sock = io.of('/').sockets.get(sid)
            if (!sock) continue
            sock.emit('vetvi:kicked', { roomId: roomName, reason: mode })
            sock.leave(roomName)
            room.members.delete(sid)
            releaseSocketLocks(io, room, sid)
            releaseSocketFocus(io, room, sid)
          }
          broadcastUsers(io, room)
        }
        console.log(`[vetvi-sync] room "${roomName}" linkMode → ${mode}`)
      } catch (error) {
        console.error('[vetvi-sync] room-settings error', error)
        ack?.({ ok: false, error: 'settings failed' })
      }
    },
  )

  /* ── удаление комнаты с сервера — только владелец ──
     Выключение «Общедоступный» в окне «Поделиться»: документ комнаты и её
     настройки (пароль, режим ссылки) стираются из БД, merge-заявки комнаты
     тоже, все участники выгоняются (в т.ч. по ссылке и из списка проектов).
     Записи ProjectAccess НЕ удаляются: список участников сохраняется — в
     окне владельца они показываются серыми, а при повторной публикации
     снова получают доступ. */
  socket.on(
    'vetvi:room-delete',
    (msg: { roomId?: string }, ack?: (r: unknown) => void) => {
      try {
        const roomName = msg?.roomId
        if (!isSafeRoom(roomName) || roomName !== joinedRoom) {
          ack?.({ ok: false, error: 'bad room' })
          return
        }
        const me = room_members_get(roomName, socket.id)
        const myRole = me && me.accId ? accessRole(roomName, me.accId) : null
        if (myRole !== 'owner') {
          ack?.({ ok: false, error: 'Только владелец может удалить комнату' })
          return
        }
        const room = rooms.get(roomName)
        if (room) {
          /* выгоняем всех, кроме запросившего удаление (он сам закрывает
             соединение сразу после ack — без двойного уведомления) */
          for (const [sid, m] of room.members) {
            if (sid === socket.id) continue
            const sock = io.of('/').sockets.get(sid)
            if (sock) sock.emit('vetvi:kicked', { roomId: roomName, reason: 'closed' })
            releaseSocketLocks(io, room, sid)
            releaseSocketFocus(io, room, sid)
          }
          if (room.gcTimer) {
            clearTimeout(room.gcTimer)
            room.gcTimer = null
          }
          rooms.delete(roomName)
        }
        try {
          qRoomDelete.run(roomName)
          qMergeDelRoom.run(roomName)
          qSnapDelRoom.run(roomName)
        } catch (e) {
          console.error('[vetvi-sync] room delete db error', e)
        }
        ack?.({ ok: true })
        console.log(`[vetvi-sync] room "${roomName}" удалена владельцем`)
      } catch (error) {
        console.error('[vetvi-sync] room-delete error', error)
        ack?.({ ok: false, error: 'delete failed' })
      }
    },
  )

  /* ── снапшот состояния ── */
  socket.on('vetvi:state', (msg: { roomId?: string; doc?: unknown }) => {
    try {
      if (!isSafeRoom(msg?.roomId) || msg.roomId !== joinedRoom) return
      if (!sockCanEditNow(socket, joinedRoom)) return // только чтение: снапшоты не принимаются
      const doc = msg.doc as { nodes?: unknown[] } | undefined
      if (!doc || !Array.isArray(doc.nodes)) return
      const json = JSON.stringify(doc)
      if (json.length > MAX_DOC_BYTES) {
        socket.emit('vetvi:error', { message: 'Документ слишком большой для синхронизации' })
        return
      }
      saveRoomDoc(msg.roomId, doc, new Date().toISOString()) // только строка этой комнаты
      scheduleTrim()
      socket.to(msg.roomId).emit('vetvi:state', { roomId: msg.roomId, doc })
      /* название проекта могло измениться — в БД (списки участников) и в комнату */
      const nm = docProjectName(doc)
      if (nm) applyRoomRename(msg.roomId, nm)
    } catch (error) {
      console.error('[vetvi-sync] state error', error)
    }
  })

  /* ── переименование проекта в комнате (мгновенное, без ожидания публикации):
       обновляет ProjectAccess.projectName и раздаёт vetvi:room-meta участникам ── */
  socket.on('vetvi:rename', (msg: { roomId?: string; name?: string }) => {
    try {
      if (!isSafeRoom(msg?.roomId) || msg.roomId !== joinedRoom) return
      if (!sockCanEditNow(socket, joinedRoom)) return // только чтение
      const nm = typeof msg?.name === 'string' ? msg.name.trim().slice(0, 120) : ''
      if (!nm) return
      applyRoomRename(msg.roomId, nm)
    } catch {
      // ignore
    }
  })

  /* ── замена данных комнаты (новая система: прилетает соавторам на сравнение,
        НЕ применяется сразу — клиент показывает блок расхождения) ── */
  socket.on('vetvi:replace', (msg: { roomId?: string; doc?: unknown; by?: { name?: string; color?: string } | null }) => {
    try {
      if (!isSafeRoom(msg?.roomId) || msg.roomId !== joinedRoom) return
      if (!sockCanEditNow(socket, joinedRoom)) return // только чтение
      const doc = msg.doc as { nodes?: unknown[] } | undefined
      if (!doc || !Array.isArray(doc.nodes)) return
      const json = JSON.stringify(doc)
      if (json.length > MAX_DOC_BYTES) {
        socket.emit('vetvi:error', { message: 'Документ слишком большой для синхронизации' })
        return
      }
      saveRoomDoc(msg.roomId, doc, new Date().toISOString())
      scheduleTrim()
      socket.to(msg.roomId).emit('vetvi:replace', {
        roomId: msg.roomId,
        doc,
        by: msg.by && typeof msg.by === 'object' ? { name: String(msg.by.name || '').slice(0, 40), color: String(msg.by.color || '').slice(0, 20) } : null,
      })
      const nmR = docProjectName(doc)
      if (nmR) applyRoomRename(msg.roomId, nmR)
      console.log(`[vetvi-sync] replace in "${msg.roomId}" by ${msg.by?.name || '?'}`)
    } catch (error) {
      console.error('[vetvi-sync] replace error', error)
    }
  })

  /* ── живые перетаскивания ── */
  socket.on(
    'vetvi:live',
    (msg: {
      roomId?: string
      nodes?: { id: string; x: number; y: number }[]
      groups?: { id: string; x: number; y: number }[]
      pts?: { eid: string; pts: { x: number; y: number }[] }[]
      dlgW?: { id: string; w: number }[]
    }) => {
      try {
        if (!isSafeRoom(msg?.roomId) || msg.roomId !== joinedRoom) return
        if (!sockCanEditNow(socket, joinedRoom)) return // только чтение: live-события не ретранслируются
        socket.to(msg.roomId).emit('vetvi:live', {
          roomId: msg.roomId,
          nodes: msg.nodes,
          groups: msg.groups,
          pts: msg.pts,
          dlgW: msg.dlgW,
        })
      } catch {
        // ignore
      }
    },
  )

  /* ── merge-почта ── */

  // Отправить merge-запрос из копии (отправитель может не состоять в комнате)
  socket.on(
    'vetvi:merge-send',
    (
      payload: {
        roomId?: string
        copyId?: string
        sender?: { name?: string; color?: string }
        stats?: Record<string, number>
        doc?: { current?: unknown; base?: unknown }
        kind?: string
      },
      ack?: (r: unknown) => void,
    ) => {
      try {
        const roomId = payload?.roomId
        if (!isSafeRoom(roomId) || !payload?.copyId || !payload?.doc?.current) {
          ack?.({ ok: false, error: 'bad merge payload' })
          return
        }
        const kind = payload.kind === 'replace' ? 'replace' : 'copy'
        const entry: MergeRequest = {
          id: 'mr' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
          roomId,
          copyId: String(payload.copyId).slice(0, 80),
          sender: {
            name: String(payload.sender?.name || 'Гость').slice(0, 40),
            color: String(payload.sender?.color || '#8b929c').slice(0, 20),
          },
          createdAt: new Date().toISOString(),
          status: 'pending',
          stats: payload.stats || {},
          doc: { current: payload.doc.current, base: payload.doc.base || null },
          kind,
        }
        // повторная отправка из той же копии (или от того же автора замены)
        // обновляет существующую заявку: снимаем прежнюю pending этой копии,
        // вставляем новую, подрезаем лимит
        db.transaction((e: MergeRequest) => {
          qMergeDelPendingOfCopy.run(e.roomId, e.copyId)
          qMergeInsert.run(
            e.id,
            e.roomId,
            e.copyId,
            e.sender.name,
            e.sender.color,
            e.createdAt,
            e.status,
            JSON.stringify(e.stats || {}),
            e.doc.current !== undefined && e.doc.current !== null ? JSON.stringify(e.doc.current) : null,
            e.doc.base !== undefined && e.doc.base !== null ? JSON.stringify(e.doc.base) : null,
            e.kind || 'copy',
          )
          qMergeTrimRoom.run(e.roomId, e.roomId, MAX_MERGES_PER_ROOM)
        })(entry)
        io.to(roomId).emit('vetvi:merge-new', {
          roomId,
          id: entry.id,
          sender: entry.sender,
          stats: entry.stats,
          createdAt: entry.createdAt,
          kind: entry.kind,
        })
        console.log(`[vetvi-sync] merge "${entry.id}" (${entry.kind}) → room "${roomId}"`)
        ack?.({ ok: true, id: entry.id })
      } catch (error) {
        console.error('[vetvi-sync] merge-send error', error)
        ack?.({ ok: false, error: 'merge failed' })
      }
    },
  )

  // Список заявок комнаты (все: активные и выполненные — для контроля).
  // docs=false — лёгкий список без документов (окно запросов), docs=true — с ними.
  socket.on(
    'vetvi:merge-list',
    (payload: { roomId?: string; docs?: boolean }, ack?: (r: unknown) => void) => {
      try {
        const roomId = payload?.roomId
        if (!isSafeRoom(roomId)) {
          ack?.({ ok: false, error: 'bad room' })
          return
        }
        const withDocs = payload?.docs !== false
        const requests = mergeListOf(roomId)
        if (!withDocs) {
          for (const r of requests) r.doc = { current: null, base: null }
        }
        ack?.({ ok: true, requests, pending: pendingCount(roomId) })
      } catch (error) {
        console.error('[vetvi-sync] merge-list error', error)
        ack?.({ ok: false, error: 'list failed' })
      }
    },
  )

  // Решение владельца/админа: принять/отклонить.
  // Право подтверждать — роль owner или admin (проверяется по сессии токена).
  // Перед применением сервер сохраняет ПОЛНЫЙ снимок текущего документа
  // комнаты (таблица snapshots) — контроль и возможность отката.
  socket.on(
    'vetvi:merge-decide',
    (
      payload: { roomId?: string; requestId?: string; decision?: string; token?: string; userId?: string },
      ack?: (r: unknown) => void,
    ) => {
      try {
        const roomId = payload?.roomId
        const requestId = String(payload?.requestId || '')
        const decision = payload?.decision === 'applied' ? 'applied' : 'rejected'
        if (!isSafeRoom(roomId)) {
          ack?.({ ok: false, error: 'bad room' })
          return
        }
        const acc = verifySession(payload?.token, payload?.userId)
        if (!acc) {
          ack?.({ ok: false, error: 'forbidden: нужна сессия аккаунта' })
          return
        }
        const myRole = accessRole(roomId, acc.id)
        if (myRole !== 'owner' && myRole !== 'admin') {
          ack?.({ ok: false, error: 'forbidden: подтверждать слияние может владелец или админ' })
          return
        }
        const entry = qMergeById.get(requestId) as
          | { id: string; room_id: string; copy_id: string; status: string }
          | null
        if (!entry || entry.room_id !== roomId) {
          ack?.({ ok: false, error: 'merge not found' })
          return
        }
        const kindRow = qMergeKindOf.get(requestId) as { kind?: string } | null
        const kind = kindRow?.kind === 'replace' ? 'replace' : 'copy'
        const decidedAt = new Date().toISOString()
        let snapshotOk = false
        if (decision === 'applied') {
          // снимок ДО применения: текущий документ комнаты
          const roomRow = qRoomById.get(roomId) as { doc: string | null } | null
          if (roomRow && roomRow.doc) {
            try {
              snapshotOk = snapshotInsert(roomId, kind === 'replace' ? 'replace' : 'merge', `Перед ${kind === 'replace' ? 'заменой' : 'слиянием'} · решил ${acc.name}`, JSON.parse(roomRow.doc))
            } catch { /* снимок не критичен */ }
          }
        }
        qMergeSetDecided.run(decision, acc.name, decidedAt, requestId)

        if (decision === 'applied' && kind === 'replace') {
          // замена подтверждена: сервер сам применяет версию отправителя ко всей
          // комнате (все участники, включая отправителя, получают готовый документ)
          const full = qMergeByIdFull.get(requestId) as { doc_current: string | null } | null
          let doc: unknown = null
          if (full && full.doc_current) {
            try { doc = JSON.parse(full.doc_current) } catch { doc = null }
          }
          if (doc && Array.isArray((doc as { nodes?: unknown }).nodes)) {
            saveRoomDoc(roomId, doc, decidedAt)
            scheduleTrim()
            const nmR = docProjectName(doc)
            if (nmR) applyRoomRename(roomId, nmR)
            io.to(roomId).emit('vetvi:replaced', {
              roomId,
              doc,
              by: { name: acc.name, color: acc.color },
              requestId,
            })
            console.log(`[vetvi-sync] replace "${requestId}" applied by ${acc.name} (snapshot: ${snapshotOk ? 'yes' : 'no'})`)
          } else {
            ack?.({ ok: false, error: 'повреждённый документ замены' })
            return
          }
        }

        io.to(roomId).emit('vetvi:merge-decision', {
          roomId,
          requestId,
          status: decision,
          copyId: entry.copy_id,
          kind,
          decidedBy: acc.name,
        })
        console.log(`[vetvi-sync] merge "${requestId}" (${kind}) → ${decision} by ${acc.name}`)
        ack?.({ ok: true, status: decision, kind, snapshot: snapshotOk })
      } catch (error) {
        console.error('[vetvi-sync] merge-decide error', error)
        ack?.({ ok: false, error: 'decide failed' })
      }
    },
  )

  // Статусы merge-заявок для отправителя
  socket.on(
    'vetvi:merge-status',
    (payload: { ids?: string[] }, ack?: (r: unknown) => void) => {
      try {
        const ids = (payload?.ids || []).map(String).filter(Boolean).slice(0, 500)
        ack?.({ ok: true, statuses: mergeStatusesByIds(ids) })
      } catch (error) {
        console.error('[vetvi-sync] merge-status error', error)
        ack?.({ ok: false, error: 'status failed' })
      }
    },
  )

  /* ── блокировки объектов ── */

  // Захват/продление (heartbeat) блокировок: свободные id — выдаём, занятые другими — в denied
  socket.on(
    'vetvi:lock',
    (payload: { roomId?: string; ids?: string[] }, ack?: (r: unknown) => void) => {
      try {
        if (!isSafeRoom(payload?.roomId) || payload.roomId !== joinedRoom) {
          ack?.({ ok: false, denied: [] })
          return
        }
        const room = rooms.get(payload.roomId)
        const me = room?.members.get(socket.id)
        if (!room || !me) {
          ack?.({ ok: false, denied: [] })
          return
        }
        if (!sockCanEditNow(socket, joinedRoom)) {
          ack?.({ ok: true, denied: [] }) // только чтение: локи не выдаются
          return
        }
        const ids = (Array.isArray(payload.ids) ? payload.ids : [])
          .map(String)
          .filter(Boolean)
          .slice(0, MAX_LOCKS_PER_SOCKET)
        const now = Date.now()
        const denied: { id: string; by: { name: string; color: string } }[] = []
        for (const id of ids) {
          const cur = room.locks.get(id)
          if (cur && cur.sid !== socket.id && now - cur.ts < LOCK_TTL_MS) {
            denied.push({ id, by: { name: cur.name, color: cur.color } })
          } else {
            room.locks.set(id, {
              sid: socket.id,
              userId: me.user.id,
              name: me.user.name,
              color: me.user.color,
              ts: now,
            })
          }
        }
        broadcastLocks(io, room)
        ack?.({ ok: true, denied })
      } catch (error) {
        console.error('[vetvi-sync] lock error', error)
        ack?.({ ok: false, denied: [] })
      }
    },
  )

  // Освобождение блокировок (жест завершён / модалка закрыта)
  socket.on(
    'vetvi:unlock',
    (payload: { roomId?: string; ids?: string[] }, ack?: (r: unknown) => void) => {
      try {
        if (!isSafeRoom(payload?.roomId) || payload.roomId !== joinedRoom) {
          ack?.({ ok: false })
          return
        }
        const room = rooms.get(payload.roomId)
        if (room) {
          const ids = (Array.isArray(payload.ids) ? payload.ids : []).map(String).filter(Boolean)
          let changed = false
          for (const id of ids) {
            const cur = room.locks.get(id)
            if (cur && cur.sid === socket.id) {
              room.locks.delete(id)
              changed = true
            }
          }
          if (changed) broadcastLocks(io, room)
        }
        ack?.({ ok: true })
      } catch (error) {
        console.error('[vetvi-sync] unlock error', error)
        ack?.({ ok: false })
      }
    },
  )

  /* ── фокус: на какой ноде участник работает прямо сейчас ── */
  socket.on('vetvi:focus', (payload: { roomId?: string; nodeId?: string | null }) => {
    try {
      if (!isSafeRoom(payload?.roomId) || payload.roomId !== joinedRoom) return
      const room = rooms.get(payload.roomId)
      const me = room?.members.get(socket.id)
      if (!room || !me) return
      const nodeId =
        typeof payload.nodeId === 'string' && payload.nodeId
          ? payload.nodeId.slice(0, MAX_FOCUS_NODE_LEN)
          : null
      if (!nodeId) {
        releaseSocketFocus(io, room, socket.id)
        return
      }
      room.focus.set(socket.id, { userId: me.user.id, nodeId, ts: Date.now() })
      broadcastFocus(io, room)
    } catch {
      // ignore
    }
  })

  /* ── управление паролем комнаты (только для участников): set/clear ──
     Для смены/снятия нужен действующий пароль (если он установлен). */
  socket.on(
    'vetvi:pass',
    (
      payload: { roomId?: string; mode?: 'set' | 'clear'; salt?: string; hash?: string; password?: string },
      ack?: (r: unknown) => void,
    ) => {
      try {
        if (!isSafeRoom(payload?.roomId) || payload.roomId !== joinedRoom) {
          ack?.({ ok: false, error: 'not joined' })
          return
        }
        const room = rooms.get(payload.roomId)
        if (!room) {
          ack?.({ ok: false, error: 'no room' })
          return
        }
        if (!sockCanEditNow(socket, joinedRoom)) {
          ack?.({ ok: false, error: 'read only' }) // пароль комнаты меняют только редакторы
          return
        }
        if (room.pass) {
          const given = typeof payload?.password === 'string' ? payload.password : ''
          if (sha256hex(room.pass.salt + ':' + given) !== room.pass.hash) {
            ack?.({ ok: false, error: 'password' })
            return
          }
        }
        if (payload?.mode === 'clear') {
          room.pass = null
          saveRoomPass(payload.roomId, null)
          ack?.({ ok: true })
          return
        }
        if (
          payload?.mode === 'set' &&
          typeof payload.salt === 'string' &&
          typeof payload.hash === 'string' &&
          /^[0-9a-f]{16,64}$/.test(payload.salt) &&
          /^[0-9a-f]{64}$/.test(payload.hash)
        ) {
          room.pass = { salt: payload.salt.slice(0, 64), hash: payload.hash.slice(0, 64) }
          saveRoomPass(payload.roomId, room.pass) // пароль сразу персистится в БД
          ack?.({ ok: true })
          return
        }
        ack?.({ ok: false, error: 'bad payload' })
      } catch (error) {
        console.error('[vetvi-sync] pass error', error)
        ack?.({ ok: false })
      }
    },
  )

  /* ── регистрация сокета для push-уведомлений (колокольчик) ──
     Вне комнат: клиент при старте шлёт токен сессии — сервер проверяет его
     по общей БД и запоминает сокет за accountId. Re-hello после reconnect
     безопасен (set dedupe); после перезапуска sync клиент пере-регистрируется
     на 'connect' автоматически. */
  socket.on('vetvi:ntf-hello', (payload: { token?: string; userId?: string }) => {
    try {
      const acc = verifySession(payload?.token, payload?.userId)
      if (!acc) return
      ntfRegister(acc.id, socket)
      socket.data.ntfUserId = acc.id
    } catch (e) {
      console.error('[vetvi-sync] ntf-hello error', e)
    }
  })

  socket.on('disconnect', () => {
    try {
      ntfUnregister(socket)
      sockCanEditMap.delete(socket.id)
      sockRoleCheckedAt.delete(socket.id)
      if (!joinedRoom) return
      const room = rooms.get(joinedRoom)
      if (!room) return
      room.members.delete(socket.id)
      releaseSocketLocks(io, room, socket.id)
      releaseSocketFocus(io, room, socket.id)
      broadcastUsers(io, room)
      console.log(`[vetvi-sync] leave "${room.name}", peers: ${userList(room).length}`)
      if (room.members.size === 0) scheduleRoomGc(room)
    } catch (error) {
      console.error('[vetvi-sync] disconnect error', error)
    }
  })

  socket.on('error', (error) => {
    console.error(`[vetvi-sync] socket error (${socket.id})`, error)
  })
})

/* ─── запуск ─── */

migrateJsonToSqlite()

console.log(
  `[vetvi-sync] SQLite «${DB_FILE}»: комнат ${(qRoomsCount.get() as { c: number }).c}, merge-заявок ${(qMergesCount.get() as { c: number }).c}, снимков ${(qSnapsCount.get() as { c: number }).c}`,
)

/* периодическая чистка призраков во всех комнатах — онлайн-счётчик остаётся точным,
   даже если новый join давно не приходил */
setInterval(() => {
  try {
    for (const room of rooms.values()) {
      if (sweepStaleMembers(io, room)) broadcastUsers(io, room)
    }
  } catch (e) {
    console.error('[vetvi-sync] sweep error', e)
  }
}, 60_000)

/* свип ролей: выданные/отозванные/сменённые доступы подхватываются участниками
   в комнате без переподключения (клиент делает тихий rejoin по canEdit) */
setInterval(() => {
  try {
    sweepRoles(io)
  } catch (e) {
    console.error('[vetvi-sync] role sweep error', e)
  }
}, ROLE_SWEEP_MS)

httpServer.listen(PORT, () => {
  console.log(`[vetvi-sync] server running on port ${PORT}`)
})

/* ── внутренний HTTP-push смены прав (порт 3004) ──
   Next.js (POST /api/access/grant|revoke) сразу после записи в общую БД
   уведомляет sync-сервер: участник с открытой комнатой мгновенно теряет
   право правки (vetvi:role) или выгоняется (vetvi:kicked reason=revoked) —
   без перезагрузки страницы и без ожидания свипа. Защита общим ключом
   VETVI_INTERNAL_KEY. Отдельный порт: socket.io на path '/' перехватывает
   ВСЕ запросы основного порта (engine.io check: любой url начинается с '/'). */
const INTERNAL_PORT = Number(process.env.VETVI_INTERNAL_PORT || 3004)
const INTERNAL_KEY = process.env.VETVI_INTERNAL_KEY || 'vetvi-internal-key'

function applyAccessSync(msg: { roomId?: string; changed?: { userId?: string; role?: string | null }[] }): { ok: boolean; error?: string; kicked?: number; updated?: number } {
  const roomId = msg?.roomId
  if (!isSafeRoom(roomId)) return { ok: false, error: 'bad room' }
  const room = rooms.get(roomId)
  const list = Array.isArray(msg?.changed) ? msg!.changed! : []
  if (!room) return { ok: true, kicked: 0, updated: 0 } // комната не открыта — роли применятся при join
  let kicked = 0
  let updated = 0
  for (const ch of list) {
    const uid = String(ch?.userId || '')
    if (!uid) continue
    const role = ch?.role === 'editor' || ch?.role === 'reader' || ch?.role === 'admin' || ch?.role === 'owner' ? ch.role : null
    for (const [sid, m] of room.members) {
      if (m.accId !== uid) continue
      const sock = io.of('/').sockets.get(sid)
      if (!sock) continue
      if (applyAccessRole(room, sid, role, sock) === 'kicked') kicked++
      else updated++
    }
  }
  if (kicked || updated) {
    broadcastUsers(io, room)
    if (room.members.size === 0) scheduleRoomGc(room)
  }
  return { ok: true, kicked, updated }
}

const internalServer = createServer((req, res) => {
  const url = req.url || ''
  const isStatus = url.startsWith('/internal/rooms-status') && req.method === 'POST'
  const isAccess = url.startsWith('/internal/access-sync') && req.method === 'POST'
  const isNotify = url.startsWith('/internal/notify') && req.method === 'POST'
  if (!isStatus && !isAccess && !isNotify) {
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: false, error: 'not found' }))
    return
  }
  if (String(req.headers['x-vetvi-key'] || '') !== INTERNAL_KEY) {
    res.writeHead(403, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: false, error: 'forbidden' }))
    return
  }
  let body = ''
  let overflow = false
  req.on('data', (c: Buffer) => {
    body += c.toString('utf8')
    if (body.length > 1e6) { overflow = true; req.destroy() }
  })
  req.on('end', () => {
    if (overflow) return
    try {
      const parsed = JSON.parse(body) as {
        roomId?: string
        roomIds?: unknown
        changed?: { userId?: string; role?: string | null }[]
        userId?: string
        ntf?: unknown
      }
      if (isNotify) {
        /* push одного уведомления аккаунту (grant/revoke в Next.js): раздаём
           vetvi:ntf всем сокетам пользователя (все вкладки/устройства). */
        const uid = String(parsed?.userId || '')
        const sent = uid && parsed?.ntf ? notifyUser(uid, parsed.ntf) : 0
        if (sent > 0) console.log(`[vetvi-sync] notify push → user ${uid.slice(0, 8)}…, sockets: ${sent}`)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, sent }))
        return
      }
      if (isStatus) {
        /* какие из перечисленных комнат живы на сервере: строка в БД или активная
           комната в памяти. «Вам открыли доступ» помечает офлайн-проекты и не
           открывает их (владелец выключил сетевой режим — комната удалена). */
        const ids = Array.isArray(parsed?.roomIds)
          ? (parsed.roomIds as unknown[]).filter((x): x is string => isSafeRoom(x)).slice(0, 200)
          : []
        const out: Record<string, { online: boolean; members: number }> = {}
        for (const id of ids) {
          let stored: unknown = null
          try { stored = qRoomExists.get(id) } catch (e) { console.error('[vetvi-sync] rooms-status db error', e) }
          const active = rooms.get(id)
          out[id] = { online: !!stored || !!active, members: active ? active.members.size : 0 }
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, rooms: out }))
        return
      }
      const out = applyAccessSync(parsed)
      console.log(`[vetvi-sync] access-sync "${parsed?.roomId || '?'}": kicked=${out.kicked || 0}, updated=${out.updated || 0}`)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(out))
    } catch (e) {
      console.error('[vetvi-sync] internal error', e)
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: 'bad payload' }))
    }
  })
})

try {
  internalServer.listen(INTERNAL_PORT, () => {
    console.log(`[vetvi-sync] internal API (access-sync/rooms-status/notify) on port ${INTERNAL_PORT}`)
  })
  internalServer.on('error', (e) => {
    console.error('[vetvi-sync] internal port error (свип ролей продолжает работать)', e)
  })
} catch (e) {
  console.error('[vetvi-sync] internal server failed', e)
}

process.on('SIGTERM', () => {
  console.log('[vetvi-sync] SIGTERM, shutting down...')
  try {
    db.close() // чекпоинт WAL при закрытии
  } catch {
    // уже закрыта
  }
  try { internalServer.close() } catch { /* уже закрыт */ }
  httpServer.close(() => process.exit(0))
})

process.on('SIGINT', () => {
  console.log('[vetvi-sync] SIGINT, shutting down...')
  try {
    db.close()
  } catch {
    // уже закрыта
  }
  try { internalServer.close() } catch { /* уже закрыт */ }
  httpServer.close(() => process.exit(0))
})
