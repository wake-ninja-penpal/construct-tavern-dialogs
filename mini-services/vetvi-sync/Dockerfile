# ─────────────────────────────────────────────────────────────────────────────
# «Ветви» — realtime-сервер совместного редактирования (socket.io, порт 3003).
# Состояние хранится в SQLite: /app/data/store.db (bun:sqlite, WAL; контейнер
# монтирует туда volume sync-data из docker-compose.yml). Каждая комната —
# отдельная запись; legacy data/store.json мигрируется в БД при первом старте
# (исходный файл сохраняется рядом как store.json.backup-<дата>).
# ─────────────────────────────────────────────────────────────────────────────
FROM oven/bun:1
WORKDIR /app
ENV NODE_ENV=production
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY index.ts ./
EXPOSE 3003
CMD ["bun", "index.ts"]
