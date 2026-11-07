# ─────────────────────────────────────────────────────────────────────────────
# «Ветви» — realtime-сервер совместного редактирования (socket.io, порт 3003).
# Состояние комнат пишется в /app/data/store.json (контейнер монтирует туда
# volume sync-data из docker-compose.yml).
# ─────────────────────────────────────────────────────────────────────────────
FROM oven/bun:1
WORKDIR /app
ENV NODE_ENV=production
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY index.ts ./
EXPOSE 3003
CMD ["bun", "index.ts"]
