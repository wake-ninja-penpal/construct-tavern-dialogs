# ─────────────────────────────────────────────────────────────────────────────
# «Ветви» — Next.js (web-контейнер).
# Сборка многоэтапная: зависимости → next build (output: standalone) → рантайм.
# Скрипт build из package.json сам копирует .next/static и public внутрь
# standalone-папки, поэтому рантайму нужен только .next/standalone.
# ─────────────────────────────────────────────────────────────────────────────
# syntax=docker/dockerfile:1

FROM oven/bun:1 AS deps
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
# Prisma: bun не запускает postinstall-скрипты зависимостей, поэтому после
# bun install сгенерированного клиента нет и `next build` падает при сборе
# данных страниц («Cannot find module '.prisma/client/default'») — все
# API-роуты с базой (/api/auth/**, /api/admin/**) импортируют @prisma/client.
# Генерируем клиент здесь: схема нужна до `COPY . .`, слой кэшируется, пока
# не изменятся lockfile или prisma/schema.prisma.
COPY prisma/schema.prisma ./prisma/schema.prisma
RUN bunx prisma generate

FROM oven/bun:1 AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1 \
    DATABASE_URL=file:/app/db/custom.db
# Каталог базы SQLite (страница и API-роуты динамические, БД при сборке не
# читается, но каталог должен существовать, если соединение всё же откроется).
RUN mkdir -p /app/db
# SQL-схема для первичной инициализации базы в рантайме (scripts/init-db.mjs):
# при первом старте volume пустой, таблиц нет — иначе все /api/auth/** и
# /api/admin/** падают с P2021 «table does not exist».
RUN bunx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script > prisma/schema.sql
RUN bun run build

FROM oven/bun:1 AS runner
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    NEXT_TELEMETRY_DISABLED=1 \
    DATABASE_URL=file:/app/db/custom.db
COPY --from=builder /app/.next/standalone ./
# Сгенерированный Prisma-клиент и движки (libquery_engine-*.so): Turbopack
# внешнит @prisma/client и грузит .prisma/client в рантайме — файл-трейсинг
# standalone не всегда захватывает их целиком, поэтому копируем явно.
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma
# SQL-схема и скрипт первичной инициализации базы (идемпотентный, см. скрипт)
COPY --from=builder /app/prisma/schema.sql ./prisma/schema.sql
COPY --from=builder /app/scripts/init-db.mjs ./scripts/init-db.mjs
# Каталог базы: в docker-compose сюда монтируется volume web-data — аккаунты,
# сессии и ссылки-инвайты переживают перезапуск и пересборку контейнера.
RUN mkdir -p /app/db
EXPOSE 3000
# Перед сервером применяем схему к базе (на живом volume это no-op)
CMD ["sh", "-c", "bun scripts/init-db.mjs && exec bun server.js"]
