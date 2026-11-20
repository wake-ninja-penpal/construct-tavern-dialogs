'use client';

/**
 * Хаб сервисов — общие типы и клиентские помощники (используется и редактором
 * «Ветви», и экранами других сервисов).
 *
 * Переключение сервисов живёт в адресном хеше: #service=<path> — открыт сервис,
 * пустой хеш — «Ветви». Один маршрут «/» (как скрытая админка по своему хешу),
 * одна учётная запись (cookie vv_sess работает во всех сервисах).
 *
 * Хеш — общий формат пар «ключ=значение» через «&»: помимо service там живут
 * прямые ссылки интеграции «Ветви ↔ Менеджер задач»:
 *  #project=<id>&room=<rid>&node=<nid>   — открыть «Ветви» на ноде (из задачи);
 *  #service=task-manager&mk=1&p=<pid>&r=<rid>&n=<ids>&t=<titles>
 *                                        — создать задачу для нод (из «Ветвей»);
 *  #service=task-manager&nf=<pid>&nn=<nid>&nt=<title>
 *                                        — задачи конкретной ноды (из «Ветвей»).
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

export interface HashInfo {
  /** Ключ стороннего сервиса (service≠vetvi) или null — открыт «Ветви». */
  service: string | null;
  /** Остальные пары хеша (node/p/r/mk/nf/…). */
  params: Record<string, string>;
}

/** Разбор хеша «#k=v&k=v» — сервис и дополнительные параметры интеграций. */
export function parseHash(): HashInfo {
  if (typeof window === 'undefined') return { service: null, params: {} };
  const raw = window.location.hash.replace(/^#/, '');
  const params: Record<string, string> = {};
  for (const part of raw.split('&')) {
    if (!part) continue;
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i);
    let v = part.slice(i + 1);
    try { v = decodeURIComponent(v); } catch { /* сырой вид */ }
    params[k] = v;
  }
  const service = params.service && params.service !== VETVI_SERVICE_KEY ? params.service : null;
  return { service, params };
}

/** Ключ сервиса из адреса (#service=<path>) — null, если открыт «Ветви». */
export function parseServiceHash(): string | null {
  return parseHash().service;
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

/* ── прямые ссылки «Ветви ↔ Менеджер задач» ── */

/** Открыть «Ветви» на конкретной ноде (переход из задачи менеджера задач).
 *  project — id локального слота (свой проект), room — id сетевой комнаты
 *  (чужой проект: ищем слот по roomId). */
export function goVetviNode(p: { projectId?: string | null; roomId?: string | null; nodeId: string }): void {
  const segs: string[] = [];
  if (p.projectId) segs.push('project=' + encodeURIComponent(p.projectId));
  if (p.roomId) segs.push('room=' + encodeURIComponent(p.roomId));
  segs.push('node=' + encodeURIComponent(p.nodeId));
  window.location.hash = segs.join('&');
}

/** Ссылка «создать задачу для нод» из «Ветвей»: менеджер задач откроет
 *  новое окно задачи с уже привязанными нодами. */
export function goTaskCreate(payload: {
  projectId: string;
  roomId: string | null;
  nodes: { id: string; title: string }[];
}): void {
  const segs: string[] = ['service=task-manager', 'mk=1', 'p=' + encodeURIComponent(payload.projectId)];
  if (payload.roomId) segs.push('r=' + encodeURIComponent(payload.roomId));
  segs.push('n=' + payload.nodes.map((x) => encodeURIComponent(x.id)).join(','));
  segs.push('t=' + encodeURIComponent(JSON.stringify(payload.nodes.map((x) => x.title))));
  window.location.hash = segs.join('&');
}

/** Ссылка «задачи этой ноды» из «Ветвей»: менеджер задач откроет фильтр
 *  по привязанным задачам. */
export function goTaskFilter(p: { projectId: string; nodeId: string; title?: string }): void {
  const segs: string[] = ['service=task-manager', 'nf=' + encodeURIComponent(p.projectId), 'nn=' + encodeURIComponent(p.nodeId)];
  if (p.title) segs.push('nt=' + encodeURIComponent(p.title));
  window.location.hash = segs.join('&');
}

/* ── переходы из уведомлений (единый колокольчик всех сервисов) ──
   Клик «Открыть» ведёт в СЕРВИС-владелец сущности: комната — в «Ветви»,
   задача — в менеджер задач (#service=task-manager&ot=<id> — дровер задачи
   откроется на входе), сервис — в сам сервис. */

/** Открыть «Ветви» на комнате, к которой дали доступ (уведомление
 *  access_granted из менеджера задач). VetviApp разберёт #openroom=… и
 *  вызовет store.openShared (слот по roomId — или заглушка + вход в комнату). */
export function goVetviRoom(p: { roomId: string; projectId?: string | null; projectName?: string | null; role?: string | null }): void {
  const segs: string[] = ['openroom=' + encodeURIComponent(p.roomId)];
  if (p.projectId) segs.push('orpid=' + encodeURIComponent(p.projectId));
  if (p.projectName) segs.push('orpn=' + encodeURIComponent(p.projectName));
  if (p.role) segs.push('orrole=' + encodeURIComponent(p.role));
  window.location.hash = segs.join('&');
}

/** Открыть задачу менеджера задач из «Ветвей» (уведомление task_assigned /
 *  task_comment): параметр ot обрабатывает TaskManagerApp на входе. */
export function goTaskOpen(taskId: string): void {
  window.location.hash = 'service=task-manager&ot=' + encodeURIComponent(taskId);
}

/** Перейти в сервис по ключу уведомления (service_granted): «Ветви» —
 *  пустой хеш, остальные — #service=<key> (ключи совпадают с путями хеша). */
export function goServiceByKey(key: string): void {
  if (!key || key === VETVI_SERVICE_KEY) {
    if (window.location.hash) window.location.hash = '';
    return;
  }
  window.location.hash = 'service=' + encodeURIComponent(key);
}

/* ── события realtime-сервисов (доставка — src/services/live.ts) ──
   Админ включил/выключил сервис или сменил персональный доступ → sync-сервер
   пушит vetvi:services, live.ts диспатчит window-событие, слушатели
   (переключатель, экраны сервисов, «Ветви») перечитывают список БЕЗ
   перезагрузки; кто находился в закрытом сервисе — выходит в доступный. */

export const SVC_EVENT = 'vetvi:services-changed';

export function dispatchServicesChanged(): void {
  try { window.dispatchEvent(new CustomEvent(SVC_EVENT)); } catch { /* нет CustomEvent */ }
}

export function onServicesChanged(cb: () => void): () => void {
  window.addEventListener(SVC_EVENT, cb);
  return () => window.removeEventListener(SVC_EVENT, cb);
}

/* ── загрузка списка сервисов (короткий кэш: шапка и переключатель
   не дёргают API на каждый клик, но админские правки видны быстро) ── */

let cache: { at: number; items: ServiceDTO[] } | null = null;
const CACHE_MS = 8000;

export function invalidateServicesCache(): void {
  cache = null;
}

/** Текущий кэш без запроса (для синхронных проверок доступности сервиса). */
export function peekServices(): ServiceDTO[] | null {
  return cache ? cache.items : null;
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
