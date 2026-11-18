/**
 * «Ветви» — первичная инициализация И миграция базы авторизации (Docker-старт).
 *
 * Запускается entrypoint'ом web-контейнера перед server.js. Volume с базой
 * при первом старте пустой: SQLite-файл Prisma создаст сама, но таблиц в нём
 * не будет — все /api/auth/** и /api/admin/** упали бы с P2021. Поэтому
 * здесь применяется SQL-схема prisma/schema.sql (генерируется на этапе
 * сборки образа командой `prisma migrate diff --from-empty --to-schema-
 * datamodel prisma/schema.prisma --script`).
 *
 * МИГРАЦИЯ уже существующей базы: база в volume создана предыдущей версией
 * образа. Возможные расхождения с текущей схемой:
 *  1) недостающие КОЛОНКИ (например AuthUser.color) — добавляются через
 *     ALTER TABLE ADD COLUMN;
 *  2) отсутствующие ТАБЛИЦЫ (например новая модель) — создаются;
 *  3) УСТАРЕВШИЕ КОЛОНКИ прошлых схем — самая коварная история: колонка
 *     есть в таблице, но её больше нет в Prisma-схеме. Если она NOT NULL
 *     (как ProjectAccess.login из самой первой версии auth-scaffold), то
 *     каждый INSERT, не передающий её, падает с P2011 «Null constraint
 *     violation», хотя SELECT-ы работают. SQLite не умеет DROP COLUMN в
 *     старых версиях и не умеет снимать NOT NULL — таблица ПЕРЕСОБИРАЕТСЯ:
 *     создаётся точная копия по текущей схеме, данные переносятся по общим
 *     колонкам (строки, не подходящие под новые NOT NULL, отбрасываются
 *     с подсчётом), старая таблица удаляется. То же лечение для колонок
 *     NOT NULL без DEFAULT, которые нельзя добавить через ALTER.
 *  4) ИНДЕКСЫ — CREATE ... INDEX IF NOT EXISTS (индексы пересобранной
 *     таблицы создаются заново вместе с ней).
 *
 * Схема-источник — prisma/schema.sql, дублирования моделей в коде нет.
 * Идемпотентно: можно запускать при каждом старте контейнера.
 */

import { readFileSync } from 'fs';
import { PrismaClient } from '@prisma/client';

const SCHEMA_SQL_PATH = new URL('../prisma/schema.sql', import.meta.url);

const db = new PrismaClient({ log: [] });

/* разбор схемы: CREATE TABLE "Name" ( ... ) → { name, body } */
function parseTables(sql) {
  const tables = [];
  const re = /CREATE TABLE\s+"([^"]+)"\s*\(([\s\S]*?)\);/gi;
  let m;
  while ((m = re.exec(sql)) !== null) tables.push({ name: m[1], body: m[2] });
  return tables;
}

/* определения колонок из тела CREATE TABLE: строки, начинающиеся с "name"
   (табличные ограничения — PRIMARY KEY(...)/FOREIGN KEY(...)/UNIQUE(...) —
   пропускаем) → [{ name, def }] */
function parseColumnDefs(body) {
  return body
    .split(/,\s*\n/)
    .map((s) => s.trim())
    .filter((s) => s.startsWith('"'))
    .map((def) => ({ name: def.match(/^"([^"]+)"/)?.[1] || '', def }))
    .filter((c) => c.name);
}

/* колонка, которую нельзя добавить через ALTER TABLE ADD COLUMN:
   NOT NULL без DEFAULT (SQLite запретит) или PRIMARY KEY */
function isHardColumn(def) {
  if (/PRIMARY\s+KEY/i.test(def)) return true;
  return /NOT\s+NULL/i.test(def) && !/DEFAULT\s/i.test(def);
}

/* инструкции CREATE INDEX / CREATE UNIQUE INDEX из схемы (без комментариев) */
function parseIndexes(sql) {
  return sql
    .split(/;\s*\n/)
    .map((s) => s.replace(/^\s*--.*$/gm, '').trim())
    .filter((s) => /^CREATE\s+(UNIQUE\s+)?INDEX\s/i.test(s));
}

/* индексы конкретной таблицы (для пересоздания после rebuild) */
function parseTableIndexes(sql, tableName) {
  return parseIndexes(sql).filter((st) =>
    new RegExp(`ON\\s+"${tableName}"`, 'i').test(st),
  );
}

/* пересборка таблицы по текущей схеме: копия → перенос данных → замена.
   Возвращает [перенесено, отброшено] строк. */
async function rebuildTable(name, body, defs) {
  const tmp = `${name}__mig`;
  await db.$executeRawUnsafe(`DROP TABLE IF EXISTS "${tmp}"`);
  await db.$executeRawUnsafe(`CREATE TABLE "${tmp}" (${body});`);

  const colNames = defs.map((c) => c.name);
  const collist = colNames.map((c) => `"${c}"`).join(', ');
  const placeholders = colNames.map(() => '?').join(', ');
  const ins = `INSERT INTO "${tmp}" (${collist}) VALUES (${placeholders})`;

  const rows = await db.$queryRawUnsafe(`SELECT * FROM "${name}"`);
  let copied = 0;
  let skipped = 0;
  for (const row of rows) {
    try {
      await db.$executeRawUnsafe(
        ins,
        ...colNames.map((c) => {
          const v = row[c];
          return v === undefined ? null : v;
        }),
      );
      copied++;
    } catch {
      /* строка не подходит под новую схему (NULL в NOT NULL-колонке,
         битый ключ) — отбрасываем: это доступы/сессии прошлых версий */
      skipped++;
    }
  }

  await db.$executeRawUnsafe(`DROP TABLE "${name}"`);
  await db.$executeRawUnsafe(`ALTER TABLE "${tmp}" RENAME TO "${name}"`);
  return [copied, skipped];
}

try {
  const sql = readFileSync(SCHEMA_SQL_PATH, 'utf8');
  const tables = parseTables(sql);

  const rows = await db.$queryRawUnsafe(
    `SELECT name FROM sqlite_master WHERE type='table' AND name IN (${tables.map(() => '?').join(',')})`,
    ...tables.map((t) => t.name),
  );
  const existing = new Set(rows.map((r) => r.name));
  const fresh = existing.size === 0;

  if (fresh) {
    /* база пустая — применяем всю схему целиком (как раньше) */
    const statements = sql
      .split(/;\s*\n/)
      .map((s) => s.replace(/^\s*--.*$/gm, '').trim())
      .filter((s) => s.length > 0);
    await db.$transaction(statements.map((s) => db.$executeRawUnsafe(s)));
    console.log(`[init-db] созданы таблицы авторизации (${statements.length} инструкций)`);
  } else {
    /* база из предыдущей версии образа: создаём отсутствующие таблицы,
       пересобираем таблицы с устаревшими колонками, добавляем недостающие
       колонки и индексы */
    let addedTables = 0;
    let addedCols = 0;
    let rebuilt = 0;
    let addedIdx = 0;
    const rebuiltTables = new Set();

    /* FK-ограничения на время пересборки не нужны: пересобираемая таблица
       только заменяется собой же (Prisma connection_limit=1 — один коннект) */
    try { await db.$executeRawUnsafe('PRAGMA foreign_keys=OFF'); } catch { /* не критично */ }

    for (const t of tables) {
      if (existing.has(t.name)) continue;
      try {
        await db.$executeRawUnsafe(`CREATE TABLE "${t.name}" (${t.body});`);
        addedTables++;
        console.log(`[init-db] создана таблица ${t.name}`);
      } catch (e) {
        console.error(`[init-db] не удалось создать таблицу ${t.name}:`, e?.message);
      }
    }

    for (const t of tables) {
      const defs = parseColumnDefs(t.body);
      let cols;
      try {
        cols = await db.$queryRawUnsafe(`PRAGMA table_info("${t.name}")`);
      } catch {
        continue;
      }
      if (!cols || cols.length === 0) continue; // таблица не создалась — ошибки уже показаны

      const expected = new Set(defs.map((c) => c.name));
      const actual = cols.map((c) => c.name);
      const extras = actual.filter((n) => !expected.has(n));
      const missing = defs.filter((c) => !actual.includes(c.name));
      const hardMissing = missing.filter((c) => isHardColumn(c.def));

      if (extras.length > 0 || hardMissing.length > 0) {
        /* расхождение, которое ALTER не чинит: устаревшие колонки (среди них
           бывают NOT NULL — они ломают каждый INSERT) или NOT NULL-колонки,
           которые нельзя дописать. Пересборка с переносом данных. */
        try {
          const [copied, skipped] = await rebuildTable(t.name, t.body, defs);
          rebuilt++;
          rebuiltTables.add(t.name);
          console.log(
            `[init-db] ${t.name}: пересобрана по схеме (убраны: ${extras.join(', ') || '—'}; строк перенесено ${copied}, отброшено ${skipped})`,
          );
        } catch (e) {
          console.error(`[init-db] ${t.name}: пересборка не удалась:`, e?.message);
        }
        continue;
      }

      for (const c of missing) {
        try {
          await db.$executeRawUnsafe(`ALTER TABLE "${t.name}" ADD COLUMN ${c.def}`);
          addedCols++;
          console.log(`[init-db] ${t.name}: добавлена колонка ${c.name}`);
        } catch (e) {
          console.error(`[init-db] ${t.name}: не удалось добавить колонку ${c.name}:`, e?.message);
        }
      }
    }

    try { await db.$executeRawUnsafe('PRAGMA foreign_keys=ON'); } catch { /* не критично */ }

    const idxNames = await db.$queryRawUnsafe(
      "SELECT name FROM sqlite_master WHERE type='index'",
    );
    const haveIdx = new Set(idxNames.map((r) => r.name));

    for (const st of parseIndexes(sql)) {
      const name = st.match(/^CREATE\s+(?:UNIQUE\s+)?INDEX\s+"([^"]+)"/i)?.[1];
      if (!name || haveIdx.has(name)) continue;
      try {
        await db.$executeRawUnsafe(st);
        haveIdx.add(name);
        addedIdx++;
        console.log(`[init-db] создан индекс ${name}`);
      } catch (e) {
        console.error('[init-db] не удалось создать индекс:', e?.message);
      }
    }

    /* индексы пересобранных таблиц: вместе со старой таблицей удалились и
       её индексы — восстанавливаем те, что нужны по схеме */
    for (const t of tables) {
      if (!rebuiltTables.has(t.name)) continue;
      for (const st of parseTableIndexes(sql, t.name)) {
        const name = st.match(/^CREATE\s+(?:UNIQUE\s+)?INDEX\s+"([^"]+)"/i)?.[1];
        if (!name || haveIdx.has(name)) continue;
        try {
          await db.$executeRawUnsafe(st);
          haveIdx.add(name);
          addedIdx++;
          console.log(`[init-db] ${t.name}: восстановлен индекс ${name}`);
        } catch (e) {
          console.error(`[init-db] ${t.name}: не удалось создать индекс:`, e?.message);
        }
      }
    }

    console.log(
      `[init-db] миграция готова: таблиц +${addedTables}, колонок +${addedCols}, пересобрано ${rebuilt}, индексов +${addedIdx}`,
    );
  }
} catch (e) {
  console.error('[init-db] ошибка инициализации базы:', e);
  process.exitCode = 1;
} finally {
  await db.$disconnect().catch(() => undefined);
}
