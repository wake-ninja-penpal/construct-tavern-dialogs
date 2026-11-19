/**
 * «Ветви» — реестр сервисов хаба (только backend!).
 *
 * Несколько приложений под одной учётной записью: аккаунт общий (AuthUser +
 * сессия vv_sess), сервисы перечислены в ServiceApp, персональные ограничения —
 * в ServiceAccess (строка allowed=false запрещает сервис; нет строки —
 * разрешено по умолчанию). «Ветви» — первый сервис, остальные (редактор
 * спрайтов, аниматор, менеджер задач) пока заглушки и подключаются позже.
 */

import 'server-only';

import { db } from '@/lib/db';
import type { AuthUser, ServiceApp } from '@prisma/client';
import { notifyUserPush } from '@/lib/syncNotify';

/** Системный ключ сервиса «Ветви» — сам редактор, живёт по адресу «/». */
export const VETVI_SERVICE_KEY = 'vetvi';

/** Скрытый ключ от удаления: без «Ветвей» хаб не имеет смысла. */
const PROTECTED_KEYS = new Set([VETVI_SERVICE_KEY]);

export const SERVICE_KEY_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;

/* ── первичный набор сервисов (заполняется идемпотентно при первом чтении) ── */

const SEED_SERVICES = [
  {
    key: VETVI_SERVICE_KEY,
    name: 'Ветви',
    description: 'Конструктор нарратива — ноды, реплики, ветвления',
    icon: 'vetvi',
    path: '',
    status: 'ready',
    sortOrder: 0,
  },
  {
    key: 'sprite-editor',
    name: 'Редактор спрайтов',
    description: 'Рисование и правка спрайтов для персонажей и объектов',
    icon: 'sprite',
    path: 'sprite-editor',
    status: 'placeholder',
    sortOrder: 1,
  },
  {
    key: 'sprite-animator',
    name: 'Аниматор спрайтов',
    description: 'Кадровая анимация спрайтов: таймлайн, превью, экспорт',
    icon: 'anim',
    path: 'sprite-animator',
    status: 'placeholder',
    sortOrder: 2,
  },
  {
    key: 'task-manager',
    name: 'Менеджер задач',
    description: 'Планы, задачи и прогресс по проектам команды',
    icon: 'tasks',
    path: 'task-manager',
    status: 'placeholder',
    sortOrder: 3,
  },
];

let seeded = false;

/** Идемпотентный посев реестра: создаёт только ОТСУТСТВУЮЩИЕ сервисы,
 *  существующие записи (переименованные/настроенные админом) не трогает. */
export async function ensureServicesSeeded(): Promise<void> {
  if (seeded) return;
  try {
    for (const s of SEED_SERVICES) {
      const exists = await db.serviceApp.findUnique({ where: { key: s.key }, select: { id: true } });
      if (!exists) await db.serviceApp.create({ data: s });
    }
    seeded = true;
  } catch {
    /* БД недоступна — попробуем при следующем чтении */
  }
}

/* ── DTO для клиента ── */

export interface ServiceDTO {
  key: string;
  name: string;
  description: string;
  icon: string;
  path: string;
  status: string;
  enabled: boolean;
}

function dto(s: ServiceApp): ServiceDTO {
  return {
    key: s.key,
    name: s.name,
    description: s.description,
    icon: s.icon,
    path: s.path,
    status: s.status,
    enabled: s.enabled,
  };
}

/**
 * Сервисы, видимые пользователю: включённые в реестре и не запрещённые
 * лично ему. Не залогиненному (режим без авторизации) — все включённые.
 */
export async function listServicesForUser(user: AuthUser | null): Promise<ServiceDTO[]> {
  await ensureServicesSeeded();
  const rows = await db.serviceApp.findMany({
    where: { enabled: true },
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
  });
  let denied = new Set<string>();
  if (user) {
    const acc = await db.serviceAccess.findMany({
      where: { userId: user.id, allowed: false },
      select: { serviceKey: true },
    });
    denied = new Set(acc.map((a) => a.serviceKey));
  }
  return rows.filter((s) => !denied.has(s.key)).map(dto);
}

/** Есть ли у пользователя доступ к конкретному сервису (включён и не запрещён). */
export async function userHasService(user: AuthUser | null, key: string): Promise<boolean> {
  await ensureServicesSeeded();
  const svc = await db.serviceApp.findUnique({ where: { key } });
  if (!svc || !svc.enabled) return false;
  if (!user) return true;
  const acc = await db.serviceAccess.findUnique({
    where: { serviceKey_userId: { serviceKey: key, userId: user.id } },
  });
  return acc ? acc.allowed : true;
}

/* ── уведомления об изменении доступа ── */

/** Уведомить пользователя об открытии/закрытии доступа к сервису
 *  (запись в БД для колокольчика + мгновенный push через vetvi-sync). */
export async function notifyServiceAccess(
  userId: string,
  service: ServiceApp,
  allowed: boolean,
): Promise<void> {
  const rec = await db.notification.create({
    data: {
      userId,
      type: allowed ? 'service_granted' : 'service_denied',
      payload: JSON.stringify({
        serviceKey: service.key,
        serviceName: service.name,
        allowed,
      }),
    },
  });
  notifyUserPush(userId, {
    id: rec.id,
    type: rec.type,
    payload: { serviceKey: service.key, serviceName: service.name, allowed },
    createdAt: rec.createdAt.toISOString(),
  });
}

export { PROTECTED_KEYS };
