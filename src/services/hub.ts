'use client';

/**
 * Хаб сервисов — общие типы и клиентские помощники (используется и редактором
 * «Ветви», и экранами других сервисов).
 *
 * Переключение сервисов живёт в адресном хеше: #service=<path> — открыт сервис,
 * пустой хеш — «Ветви». Один маршрут «/» (как скрытая админка по своему хешу),
 * одна учётная запись (cookie vv_sess работает во всех сервисах).
 */

/* ── типы ── */

export interface ServiceDTO {
  key: string;
  name: string;
  description: string;
  icon: string;
  path: string;
  status: string; // 'ready' | 'placeholder'
  enabled: boolean;
}

/** Ключ сервиса «Ветви» (сам редактор) — синхронизирован с src/lib/services.ts. */
export const VETVI_SERVICE_KEY = 'vetvi';

/** Метаданные первичных сервисов для экранов «нет доступа» (сервис, которого
 *  нет в разрешённом списке, имени из API не имеет — берём из этой карты). */
export const SERVICE_META: Record<string, { name: string; description: string; icon: string }> = {
  vetvi: { name: 'Ветви', description: 'Конструктор нарратива — ноды, реплики, ветвления', icon: 'vetvi' },
  'sprite-editor': { name: 'Редактор спрайтов', description: 'Рисование и правка спрайтов для персонажей и объектов', icon: 'sprite' },
  'sprite-animator': { name: 'Аниматор спрайтов', description: 'Кадровая анимация спрайтов: таймлайн, превью, экспорт', icon: 'anim' },
  'task-manager': { name: 'Менеджер задач', description: 'Планы, задачи и прогресс по проектам команды', icon: 'tasks' },
};

export function serviceMeta(key: string): { name: string; description: string; icon: string } {
  return SERVICE_META[key] || { name: key, description: '', icon: 'grid' };
}

/* ── адресный хеш ── */

/** Ключ сервиса из адреса (#service=<path>) — null, если открыт «Ветви». */
export function parseServiceHash(): string | null {
  if (typeof window === 'undefined') return null;
  const m = /^#service=([a-z0-9-]+)$/i.exec(window.location.hash);
  return m ? m[1] : null;
}

/** Перейти к сервису (path пуст — вернуться в «Ветви», хеш очищается). */
export function setServiceHash(svc: { key: string; path: string }): void {
  if (svc.key === VETVI_SERVICE_KEY || !svc.path) {
    if (window.location.hash) {
      window.location.hash = '';
      return;
    }
    return;
  }
  window.location.hash = 'service=' + svc.path;
}

/* ── загрузка списка сервисов (короткий кэш: шапка и переключатель
   не дёргают API на каждый клик, но админские правки видны быстро) ── */

let cache: { at: number; items: ServiceDTO[] } | null = null;
const CACHE_MS = 8000;

export function invalidateServicesCache(): void {
  cache = null;
}

export async function fetchServices(force = false): Promise<ServiceDTO[]> {
  if (!force && cache && Date.now() - cache.at < CACHE_MS) return cache.items;
  const res = await fetch('/api/services', { cache: 'no-store' });
  if (!res.ok) throw new Error(res.status === 401 ? 'anon' : 'server');
  const data = (await res.json()) as { items?: ServiceDTO[] };
  const items = Array.isArray(data.items) ? data.items : [];
  cache = { at: Date.now(), items };
  return items;
}
