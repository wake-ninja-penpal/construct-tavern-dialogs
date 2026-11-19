/**
 * «Ветви» — менеджер задач (сервис task-manager, только backend!).
 *
 * Единое командное kanban-пространство хаба: проекты → доски → колонки →
 * задачи (TaskItem). Доступ — через сервис-хаб: любой включённый сервис
 * «Менеджер задач» разрешён всем, персональный запрет — через ServiceAccess
 * (матрица доступов в админке). Все маршруты /api/tm/* проверяют доступ
 * через requireTaskService(): запись с закрытым доступом не сохраняется
 * и не раздаётся (защита на сервере, а не только скрытие UI).
 *
 * Связи задач с нодами «Ветвей» хранятся на задаче (links JSON):
 * [{ pid: roomId || projectId, nid: id ноды, room: roomId | null, t: название }].
 * Иконки прогресса над нодами в «Ветвях» читаются запросом /api/tm/nodes.
 */

import 'server-only';

import { db } from '@/lib/db';
import { currentUser } from '@/lib/auth';
import { userHasService } from '@/lib/services';
import type { AuthUser } from '@prisma/client';

export const TASK_SERVICE_KEY = 'task-manager';

export const TM_PRIORITIES: Record<string, { label: string; color: string }> = {
  critical: { label: 'Критичный', color: '#cf6b5a' },
  high: { label: 'Высокий', color: '#e2a54e' },
  normal: { label: 'Обычный', color: '#646bd0' },
  low: { label: 'Низкий', color: '#6d7480' },
};

export const TM_KIND_COLORS: Record<string, string> = {
  new: '#6d7480',
  progress: '#e2a54e',
  done: '#8fbf7f',
};

/** Форма связи задача↔нода (строго типизируем при разборе JSON). */
export interface TaskLink {
  pid: string;
  nid: string;
  room?: string | null;
  t?: string;
}

export function parseLinks(raw: string | null | undefined): TaskLink[] {
  if (!raw) return [];
  try {
    const arr: unknown = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    const out: TaskLink[] = [];
    for (const x of arr) {
      if (!x || typeof x !== 'object') continue;
      const o = x as Record<string, unknown>;
      const pid = typeof o.pid === 'string' ? o.pid.slice(0, 80) : '';
      const nid = typeof o.nid === 'string' ? o.nid.slice(0, 80) : '';
      if (!pid || !nid) continue;
      out.push({
        pid,
        nid,
        room: typeof o.room === 'string' && o.room ? o.room.slice(0, 80) : null,
        t: typeof o.t === 'string' ? o.t.slice(0, 160) : '',
      });
    }
    return out.slice(0, 50);
  } catch {
    return [];
  }
}

export function sanitizeLinks(input: unknown): string {
  if (!Array.isArray(input)) return '[]';
  const out: TaskLink[] = [];
  for (const x of input) {
    if (!x || typeof x !== 'object') continue;
    const o = x as Record<string, unknown>;
    const pid = typeof o.pid === 'string' ? o.pid.trim().slice(0, 80) : '';
    const nid = typeof o.nid === 'string' ? o.nid.trim().slice(0, 80) : '';
    if (!pid || !nid) continue;
    out.push({
      pid,
      nid,
      room: typeof o.room === 'string' && o.room ? o.room.slice(0, 80) : null,
      t: typeof o.t === 'string' ? o.t.slice(0, 160) : '',
    });
    if (out.length >= 50) break;
  }
  return JSON.stringify(out);
}

export interface TaskStickers {
  assignees?: string[];
  deadline?: string | null;
  priority?: string | null;
}

export function parseStickers(raw: string | null | undefined): TaskStickers {
  if (!raw) return {};
  try {
    const o: unknown = JSON.parse(raw);
    if (!o || typeof o !== 'object' || Array.isArray(o)) return {};
    const s = o as Record<string, unknown>;
    return {
      assignees: Array.isArray(s.assignees) ? s.assignees.filter((x): x is string => typeof x === 'string').slice(0, 8) : [],
      deadline: typeof s.deadline === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s.deadline) ? s.deadline : null,
      priority: typeof s.priority === 'string' && TM_PRIORITIES[s.priority] ? s.priority : null,
    };
  } catch {
    return {};
  }
}

export function sanitizeStickers(input: unknown): string {
  /* вход — объект или JSON-строка: приводим к строгой форме стикеров */
  const s = parseStickers(typeof input === 'string' ? input : JSON.stringify(input || {}));
  return JSON.stringify({
    assignees: s.assignees || [],
    deadline: s.deadline || null,
    priority: s.priority || null,
  });
}

/** Проверка доступа к сервису «Менеджер задач».
 *  Возвращает пользователя или null — маршруты отвечают 403. */
export async function requireTaskService(): Promise<AuthUser | null> {
  const user = await currentUser();
  if (!user) return null;
  const ok = await userHasService(user, TASK_SERVICE_KEY);
  if (!ok) return null;
  return user;
}

/** Колонки по умолчанию новой доски: три системные (как в прототипе «Поток»). */
export async function ensureDefaultColumns(boardId: string): Promise<void> {
  const count = await db.taskColumn.count({ where: { boardId } });
  if (count > 0) return;
  await db.taskColumn.createMany({
    data: [
      { boardId, title: 'Не взяты', color: '#6d7480', kind: 'new', locked: true, sortOrder: 0 },
      { boardId, title: 'В работе', color: '#e2a54e', kind: 'progress', locked: true, sortOrder: 1 },
      { boardId, title: 'Выполнено', color: '#8fbf7f', kind: 'done', locked: true, sortOrder: 2 },
    ],
  });
}
