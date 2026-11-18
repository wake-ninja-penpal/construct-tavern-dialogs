/**
 * Мгновенное уведомление realtime-сервера (vetvi-sync) о смене прав доступа.
 *
 * Права хранятся в общей БД (ProjectAccess) — sync-сервер и так подхватывает
 * их свипом (раз в 3 с) и проверкой при каждой попытке записи. Этот push
 * делает применение мгновенным: участник с открытой комнатой сразу получает
 * vetvi:role (смена права правки) или выгоняется при отзыве доступа —
 * без перезагрузки страницы.
 *
 * Адрес: VETVI_SYNC_INTERNAL_URL (в docker — http://sync:3004,
 * локально — http://127.0.0.1:3004). Ключ: VETVI_INTERNAL_KEY — общий секрет
 * между web и sync. Отправка fire-and-forget: недоступность sync не влияет
 * на ответ API (роли применятся при следующем join/свипе).
 */
export function notifyAccessChanged(
  roomId: string,
  changed: { userId: string; role: 'editor' | 'reader' | null }[],
): void {
  try {
    const base = process.env.VETVI_SYNC_INTERNAL_URL || 'http://127.0.0.1:3004';
    const key = process.env.VETVI_INTERNAL_KEY || 'vetvi-internal-key';
    void fetch(base + '/internal/access-sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-vetvi-key': key },
      body: JSON.stringify({ roomId, changed }),
    }).catch(() => { /* sync недоступен — роль применит свип/переподключение */ });
  } catch {
    /* уведомление необязательно: свип ролей надёжно применит изменения */
  }
}

/** Мгновенный push одного уведомления аккаунту (колокольчик).
 *
 *  После записи уведомления в БД (access_granted / access_revoked) сообщаем
 *  realtime-серверу — он раздаёт vetvi:ntf всем сокетам этого пользователя
 *  (все вкладки/устройства): точка непрочитанного на колокольчике появляется
 *  сразу, без ожидания опроса. Опрос /api/notifications остаётся страховкой —
 *  недоступность sync или офлайн-получатель не теряют уведомление. */
export function notifyUserPush(
  userId: string,
  ntf: { id: string; type: string; payload: unknown; createdAt: string },
): void {
  try {
    const base = process.env.VETVI_SYNC_INTERNAL_URL || 'http://127.0.0.1:3004';
    const key = process.env.VETVI_INTERNAL_KEY || 'vetvi-internal-key';
    void fetch(base + '/internal/notify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-vetvi-key': key },
      body: JSON.stringify({ userId, ntf }),
    }).catch(() => { /* sync недоступен — уведомление доставит опрос */ });
  } catch {
    /* push необязателен: опрос доставит уведомление */
  }
}

/** Живы ли комнаты на realtime-сервере (vetvi-sync).
 *
 *  «Вам открыли доступ» помечает офлайн-проекты: владелец выключил сетевой
 *  режим — комната удалена с сервера, открывать её нельзя. sync хранит
 *  комнаты в своей БД, поэтому статус спрашиваем у него по внутреннему
 *  HTTP-API. Недоступность sync — null (статус неизвестен, решение остаётся
 *  за сервером комнат при join: он ответит room_closed). */
export async function syncRoomsStatus(
  roomIds: string[],
): Promise<Record<string, { online: boolean; members?: number }> | null> {
  try {
    const base = process.env.VETVI_SYNC_INTERNAL_URL || 'http://127.0.0.1:3004';
    const key = process.env.VETVI_INTERNAL_KEY || 'vetvi-internal-key';
    const ac = new AbortController();
    const tm = setTimeout(() => ac.abort(), 2500);
    try {
      const res = await fetch(base + '/internal/rooms-status', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-vetvi-key': key },
        body: JSON.stringify({ roomIds: roomIds.slice(0, 200) }),
        signal: ac.signal,
      });
      if (!res.ok) return null;
      const j = (await res.json()) as { rooms?: Record<string, { online: boolean; members?: number }> };
      return j.rooms || null;
    } finally {
      clearTimeout(tm);
    }
  } catch {
    return null; /* sync недоступен — статус неизвестен */
  }
}
