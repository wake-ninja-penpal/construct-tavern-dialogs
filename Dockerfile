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

FROM oven/bun:1 AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
# Примечание: Prisma в рантайме приложения не используется (страница —
# статический /vetvi/index.html + socket.io-сервис), поэтому prisma generate
# здесь не выполняется. Если появятся API-роуты с базой — добавьте
# `RUN bunx prisma generate` перед сборкой и volume для db/custom.db.
RUN bun run build

FROM oven/bun:1 AS runner
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    NEXT_TELEMETRY_DISABLED=1
COPY --from=builder /app/.next/standalone ./
EXPOSE 3000
CMD ["bun", "server.js"]
