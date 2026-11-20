'use client';

/**
 * Хаб сервисов — служебный сокет realtime-событий (вне комнат).
 *
 * Редактор «Ветвей» держит свой сокет уведомлений (SyncClient), но экраны
 * сторонних сервисов (менеджер задач, заглушки) SyncClient не монтируют —
 * без отдельного сокета они не узнают о смене доступов, пока страница
 * не перезагружена. Этот модуль создаёт ОДИН общий сокет на вкладку
 * (и в редакторе, и в сервисах) и раздаёт события через window:
 *
 *  - vetvi:services (смена реестра/доступов) → window 'vetvi:services-changed'
 *    → слушатели перечитывают /api/services: список сервисов обновляется без
 *    перезагрузки, находящийся в закрытом сервисе пользователь выводится
 *    в доступный (принудительный выход);
 *  - vetvi:ntf типов service_granted/service_denied — тот же сигнал
 *    (адресная доставка при персональном запрете);
 *  - vetvi:tm — мутация менеджера задач у любого участника (задачи, проекты,
 *    доски, колонки, доступы, комментарии): открытый менеджер задач
 *    перечитывает снапшот /api/tm — данные синхронизируются в реальном
 *    времени, без перезагрузки страницы.
 *
 * Регистрация (vetvi:ntf-hello) — по токену сессии; повторный hello после
 * переподключения безопасен (set dedupe на сервере). hello можно вызвать
 * повторно после входа (servicesLiveHello) — токен уже есть.
 */

import { io, type Socket } from 'socket.io-client';

import { dispatchServicesChanged } from './hub';
import { getAccount, getAccountToken } from '@/vetvi/web/auth';

/* адрес realtime-сервера: через Caddy-шлюз (/?XTransformPort=3003 — НЕ менять),
   NEXT_PUBLIC_SYNC_URL — для локальной разработки без шлюза */
const SYNC_URL = process.env.NEXT_PUBLIC_SYNC_URL || '/?XTransformPort=3003';

let sock: Socket | null = null;

export function ensureServicesLive(): Socket | null {
  if (sock || typeof window === 'undefined') return sock;
  const s = io(SYNC_URL, {
    path: '/',
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionDelay: 800,
    reconnectionDelayMax: 4000,
  });
  sock = s;
  /* отладочный хэндл (диагностика регистрации в консоли) */
  try { (window as unknown as { __vetviLive?: Socket }).__vetviLive = s; } catch { /* нет window */ }
  s.on('connect', () => { servicesLiveHello(); });
  s.on('vetvi:services', () => {
    dispatchServicesChanged();
  });
  s.on('vetvi:tm', () => {
    /* мутация менеджера задач (кто-то из участников): открытый менеджер
       перечитает снапшот /api/tm — новые проекты (у кого выдали доступ),
       задачи, переносы, комментарии появляются без перезагрузки страницы */
    try { window.dispatchEvent(new CustomEvent('vetvi:tm-changed')); } catch { /* нет window */ }
  });
  s.on('vetvi:ntf', (n: { type?: string } | null) => {
    /* персональный запрет/разрешение — тот же канал реакции, что и реестр */
    if (n && (n.type === 'service_granted' || n.type === 'service_denied')) dispatchServicesChanged();
  });
  if (s.connected) servicesLiveHello();
  return s;
}

/** (Пере)регистрация сокета за аккаунтом — вызывается после входа/смены сессии. */
export function servicesLiveHello(): void {
  const s = sock;
  if (!s) return;
  const acc = getAccount();
  const tok = getAccountToken();
  if (!acc || !tok) return; /* не залогинен — регистрировать нечего */
  try { s.emit('vetvi:ntf-hello', { token: tok, userId: acc.id }); } catch { /* сокет умер */ }
}
