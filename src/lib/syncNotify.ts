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
  changed: { userId: string; role: 'owner' | 'admin' | 'editor' | 'reader' | null }[],
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

/** Мгновенное оповещение об изменении реестра/доступов сервисов хаба.
 *
 *  Админ включил/выключил сервис или сменил персональный доступ — клиент
 *  должен СРАЗУ перечитать /api/services: сервис появляется/исчезает из
 *  переключателя без перезагрузки, а пользователь, находящийся в закрытом
 *  сервисе, принудительно выходит из него (кик на любой доступный сервис).
 *
 *  userIds — кому адресовано (смена персонального доступа); без userIds —
 *  широковещательно всем подключённым клиентам (смена реестра). Событие
 *  vetvi:services принимают и редактор «Ветвей», и экраны других сервисов
 *  (у них свой служебный сокет — src/services/live.ts). */
export function notifyServicesChanged(userIds?: string[]): void {
  try {
    const base = process.env.VETVI_SYNC_INTERNAL_URL || 'http://127.0.0.1:3004';
    const key = process.env.VETVI_INTERNAL_KEY || 'vetvi-internal-key';
    void fetch(base + '/internal/services-sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-vetvi-key': key },
      body: JSON.stringify({ userIds: Array.isArray(userIds) ? userIds.slice(0, 200) : null }),
    }).catch(() => { /* sync недоступен — список перечитается при открытии попапа */ });
  } catch {
    /* push необязателен: список сервисов перечитается при следующем открытии */
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

/** Мгновенное оповещение «данные менеджера задач изменились».
 *
 *  Любая мутация /api/tm/* (задачи, проекты, доски, колонки, метки, команды,
 *  доступы, комментарии) вызывает этот push — realtime-сервер раздаёт всем
 *  авторизованным сокетам vetvi:tm, и открытый менеджер задач СРАЗУ
 *  перечитывает снапшот /api/tm: новый проект появляется у тех, кому выдали
 *  доступ, задачи/переносы/комментарии обновляются у всех участников без
 *  перезагрузки страницы. kind — необязательная пометка для логов sync.
 *  Отправка fire-and-forget: недоступность sync не влияет на ответ API
 *  (изменения увидят при следующей перезагрузке/опросе). */
export function notifyTmChanged(kind?: string): void {
  try {
    const base = process.env.VETVI_SYNC_INTERNAL_URL || 'http://127.0.0.1:3004';
    const key = process.env.VETVI_INTERNAL_KEY || 'vetvi-internal-key';
    void fetch(base + '/internal/tm-sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-vetvi-key': key },
      body: JSON.stringify({ kind: kind || 'tm' }),
    }).catch(() => { /* sync недоступен — снапшот перечитается при следующем действии */ });
  } catch {
    /* push необязателен: снапшот перечитается при следующем действии */
  }
}
