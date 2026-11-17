/**
 * «Ветви» — первичная инициализация базы авторизации (для Docker-старта).
 *
 * Запускается entrypoint'ом web-контейнера перед server.js. Volume с базой
 * при первом старте пустой: SQLite-файл Prisma создаст сама, но таблиц в нём
 * не будет — все /api/auth/** и /api/admin/** упали бы с P2021. Поэтому
 * здесь применяется SQL-схема prisma/schema.sql (генерируется на этапе
 * сборки образа командой `prisma migrate diff --from-empty --to-schema-
 * datamodel prisma/schema.prisma --script`).
 *
 * Идемпотентно: если таблица AuthUser уже существует (база из volume после
 * перезапуска/обновления) — ничего не делаем. При ИЗМЕНЕНИИ схемы в будущем
 * нужен настоящий миграционный шаг — пока заготовка этого не требует.
 */

import { readFileSync } from 'fs';
import { PrismaClient } from '@prisma/client';

const SCHEMA_SQL_PATH = new URL('../prisma/schema.sql', import.meta.url);

const db = new PrismaClient({ log: [] });

try {
  const rows = await db.$queryRawUnsafe(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='AuthUser'",
  );
  if (rows && rows.length > 0) {
    console.log('[init-db] таблицы авторизации уже существуют — пропускаю инициализацию');
  } else {
    const sql = readFileSync(SCHEMA_SQL_PATH, 'utf8');
    // Схема из `migrate diff --script`: инструкции через ";" в конце строки,
    // триггеров/процедур нет — простой сплит безопасен.
    const statements = sql
      .split(/;\s*\n/)
      .map((s) => s.replace(/^\s*--.*$/gm, '').trim())
      .filter((s) => s.length > 0);
    await db.$transaction(statements.map((s) => db.$executeRawUnsafe(s)));
    console.log(`[init-db] созданы таблицы авторизации (${statements.length} инструкций)`);
  }
} catch (e) {
  console.error('[init-db] ошибка инициализации базы:', e);
  process.exitCode = 1;
} finally {
  await db.$disconnect().catch(() => undefined);
}
