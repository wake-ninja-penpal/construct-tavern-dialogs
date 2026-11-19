'use client';

/**
 * Менеджер задач (сервис task-manager) — клиентские типы и модели.
 * Формат повторяет прототип «Поток»: проекты → доски → колонки → задачи,
 * системные колонки (Не взяты / В работе / Выполнено) задают статус,
 * стикеры (исполнители/дедлайн/приоритет) и связи с нодами «Ветвей».
 */

export interface TmColumn {
  id: string;
  boardId: string;
  title: string;
  color: string;
  kind: string; // 'new' | 'progress' | 'done' | ''
  locked: boolean;
  sortOrder: number;
}

export interface TmBoard {
  id: string;
  projectId: string;
  title: string;
  sortOrder: number;
  columns: TmColumn[];
}

export interface TmProject {
  id: string;
  title: string;
  color: string;
  sortOrder: number;
  createdAt: string;
  boards: TmBoard[];
}

export interface TmStickers {
  assignees: string[];
  deadline: string | null;
  priority: string | null;
}

/** Связь задачи с нодой «Ветвей»: pid — roomId или id слота проекта. */
export interface TmLink {
  pid: string;
  nid: string;
  room?: string | null;
  t?: string;
}

export interface TmTask {
  id: string;
  projectId: string;
  boardId: string | null;
  columnId: string | null;
  parentId: string | null;
  title: string;
  description: string;
  stickers: TmStickers;
  links: TmLink[];
  done: boolean;
  completedAt: string | null;
  order: number;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Приоритеты (как в прототипе «Поток», цвета — палитра «Ветвей»). */
export const TM_PRIO: Record<string, { label: string; color: string }> = {
  critical: { label: 'Критичный', color: '#cf6b5a' },
  high: { label: 'Высокий', color: '#e2a54e' },
  normal: { label: 'Обычный', color: '#646bd0' },
  low: { label: 'Низкий', color: '#6d7480' },
};

/** Цвета статусов/системных колонок — совпадают с иконками на нодах «Ветвей». */
export const TM_KIND_COLOR: Record<string, string> = {
  new: '#9aa1ac',
  progress: '#e2a54e',
  done: '#8fbf7f',
};

export const TM_PALETTE = ['#e2a54e', '#8fbf7f', '#cf6b5a', '#646bd0', '#2f9e77', '#12a594', '#c951a2', '#9aa1ac'];

export function parseStickers(raw: string | null | undefined): TmStickers {
  try {
    const o = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    return {
      assignees: Array.isArray(o.assignees) ? o.assignees.filter((x): x is string => typeof x === 'string') : [],
      deadline: typeof o.deadline === 'string' ? o.deadline : null,
      priority: typeof o.priority === 'string' ? o.priority : null,
    };
  } catch {
    return { assignees: [], deadline: null, priority: null };
  }
}

export function parseLinks(raw: string | null | undefined): TmLink[] {
  try {
    const arr = raw ? (JSON.parse(raw) as unknown) : [];
    if (!Array.isArray(arr)) return [];
    return arr.filter((x): x is TmLink => !!x && typeof x === 'object'
      && typeof (x as TmLink).pid === 'string' && typeof (x as TmLink).nid === 'string');
  } catch {
    return [];
  }
}

export function taskOf(ws: { projects: TmProject[]; tasks: TmTask[] } | null, id: string): TmTask | null {
  if (!ws) return null;
  return ws.tasks.find((t) => t.id === id) || null;
}

export function childrenOf(ws: { tasks: TmTask[] } | null, parentId: string): TmTask[] {
  if (!ws) return [];
  return ws.tasks.filter((t) => t.parentId === parentId);
}

/** Дедлайн — короткий формат: Сегодня / Завтра / Вчера / 12 мар. */
export function fmtDeadline(d: string): { text: string; tone: 'over' | 'today' | 'ok' } {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const [y, m, dd] = d.split('-').map((x) => parseInt(x, 10));
  const dt = new Date(y, (m || 1) - 1, dd || 1);
  const diff = Math.round((dt.getTime() - today.getTime()) / 86400000);
  const months = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
  const md = dd + ' ' + (months[(m || 1) - 1] || '');
  if (diff < 0) return { text: 'Просрочено · ' + md, tone: 'over' };
  if (diff === 0) return { text: 'Сегодня', tone: 'today' };
  if (diff === 1) return { text: 'Завтра', tone: 'ok' };
  return { text: md, tone: diff < 0 ? 'over' : 'ok' };
}

export function firstName(displayName: string | null | undefined, login: string): string {
  const src = (displayName || login || '').trim();
  return src.split(/\s+/)[0] || src;
}

export function initialsOf(displayName: string | null | undefined, login: string): string {
  const src = (displayName || login || '?').trim();
  const parts = src.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return src.slice(0, 2).toUpperCase();
}

/** Цвет аватара пользователя: стабильный хеш логина в палитру. */
export function userColor(login: string): string {
  let h = 0;
  for (let i = 0; i < login.length; i++) h = (h * 31 + login.charCodeAt(i)) >>> 0;
  return TM_PALETTE[h % TM_PALETTE.length];
}
