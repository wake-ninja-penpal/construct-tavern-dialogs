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
 * образа. Если в схему позже добавили колонку (например AuthUser.color),
 * таблицы уже есть — старый скрипт просто пропускал инициализацию, и все
 * API падали с P2022 «The column ... does not exist in the current
 * database». Теперь недостающие колонки добавляются через ALTER TABLE
 * ADD COLUMN, отсутствующие таблицы создаются, индексы — CREATE ... INDEX
 * IF NOT EXISTS. Схема-источник — тот же prisma/schema.sql, дублирования
 * моделей в коде нет.
 *
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
   (табличные ограничения — PRIMARY KEY(...)/FOREIGN KEY(...) — пропускаем) */
function parseColumns(body) {
  return body
    .split(/,\s*\n/)
    .map((s) => s.trim())
    .filter((s) => s.startsWith('"'));
}

/* инструкции CREATE INDEX / CREATE UNIQUE INDEX из схемы (без комментариев) */
function parseIndexes(sql) {
  return sql
    .split(/;\s*\n/)
    .map((s) => s.replace(/^\s*--.*$/gm, '').trim())
    .filter((s) => /^CREATE\s+(UNIQUE\s+)?INDEX\s/i.test(s));
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
    /* база из предыдущей версии образа: создаём отсутствующие таблицы
       (например новую модель), добавляем недостающие колонки и индексы */
    let addedTables = 0;
    let addedCols = 0;
    let addedIdx = 0;

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
      const cols = await db.$queryRawUnsafe(`PRAGMA table_info("${t.name}")`);
      if (cols.length === 0) continue; // таблица не создалась — ошибки уже показаны
      const have = new Set(cols.map((c) => c.name));
      for (const def of parseColumns(t.body)) {
        const col = def.match(/^"([^"]+)"/)?.[1];
        if (!col || have.has(col)) continue;
        try {
          await db.$executeRawUnsafe(`ALTER TABLE "${t.name}" ADD COLUMN ${def}`);
          have.add(col);
          addedCols++;
          console.log(`[init-db] ${t.name}: добавлена колонка ${col}`);
        } catch (e) {
          console.error(`[init-db] ${t.name}: не удалось добавить колонку ${col}:`, e?.message);
        }
      }
    }

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

    console.log(
      `[init-db] миграция готова: таблиц +${addedTables}, колонок +${addedCols}, индексов +${addedIdx}`,
    );
  }
} catch (e) {
  console.error('[init-db] ошибка инициализации базы:', e);
  process.exitCode = 1;
} finally {
  await db.$disconnect().catch(() => undefined);
}
