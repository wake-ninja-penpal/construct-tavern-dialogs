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
