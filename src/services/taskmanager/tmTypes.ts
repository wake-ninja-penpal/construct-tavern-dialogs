'use client';

/**
 * Менеджер задач (сервис task-manager) — клиентские типы и модели.
 * Формат повторяет прототип «Поток»: проекты → доски → колонки → задачи,
 * системные колонки (Не взяты / В работе / Выполнено) задают статус,
 * стикеры (исполнители/дедлайн/приоритет), метки, чат задачи и связи
 * с нодами «Ветвей».
 */

export interface TmColumn {
  id: string;
  boardId: string;
  title: string;
  color: string;
  icon: string;
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

/** Запись чата задачи (комментарий или системная история). */
export interface TmMessage {
  id: string;
  login: string;
  text: string;
  ts: number;
  system?: boolean;
}

export interface TmLabel {
  id: string;
  name: string;
  color: string;
}

export interface TmTeamMember {
  id: string;
  teamId: string;
  login: string;
}

export interface TmTeam {
  id: string;
  name: string;
  color: string;
  icon: string;
  members: TmTeamMember[];
}

/** Строка доступов проекта: персональная (login) или командная (teamId). */
export interface TmAccessRow {
  id: string;
  projectId: string;
  login: string | null;
  teamId: string | null;
  role: string; // admin | editor | viewer
}

/** Сохранённый вид (пресет фильтров) — личный. */
export interface TmView {
  id: string;
  login: string;
  name: string;
  icon: string;
  state: TmViewState;
}

export interface TmFilters {
  assignee: string; // '' | 'me' | 'none' | login
  priorities: string[];
  labelId: string;
  due: string; // any | overdue | today | week | none
  showDone: boolean;
}

export interface TmViewState {
  view: string; // my | board | backlog | user
  projectId: string | null;
  boardId: string | null;
  userId: string | null;
  sort: string; // manual | due | priority | title | created
  filters: TmFilters;
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
  messages: TmMessage[];
  labelIds: string[];
  done: boolean;
  completedAt: string | null;
  order: number;
  /** Свой цвет задачи (палитра прототипа), null — цвет не задан. */
  color: string | null;
  /** Плотность заливки цветом 0.04…0.8 (по умолчанию 0.2). */
  colorAlpha: number | null;
  /** Блок «Связи с Ветвями» включён в этой задаче (иначе не показываем). */
  nodesOn: boolean;
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

/** Палитра цветов ЗАДАЧИ (как в прототипе «Поток», тёплые акценты). */
export const TM_TASK_PALETTE = ['#e2a54e', '#cf6b5a', '#8fbf7f', '#12a594', '#646bd0', '#c951a2', '#2f9e77', '#9aa1ac'];

/** Метки ролей проекта (как в прототипе: админ/редактор/наблюдатель). */
export const TM_ROLE_LABEL: Record<string, string> = {
  admin: 'Админ',
  editor: 'Редактор',
  viewer: 'Наблюдатель',
};

export const TM_ROLE_RANK: Record<string, number> = { viewer: 1, editor: 2, admin: 3 };

export const TM_TEAM_ICONS = ['shield', 'users', 'rocket', 'code', 'megaphone', 'star', 'flame', 'kanban'];

/** Описания системных колонок (подсказка в меню колонки и title, как в прототипе). */
export const TM_SYS_COL_INFO: Record<string, string> = {
  new: 'Задачи, которые ещё никто не взял. Стикер исполнителя немедленно переводит их в «В работе».',
  progress: 'Задачи в работе: назначен исполнитель, идёт работа. Прогресс виден на нодах «Ветвей».',
  done: 'Выполненные задачи — позиция в колонке и есть статус, ничего отмечать не нужно.',
};

export function childrenOf(ws: { tasks: TmTask[] } | null, parentId: string): TmTask[] {
  if (!ws) return [];
  return ws.tasks.filter((t) => t.parentId === parentId);
}

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

export function parseMessages(raw: string | null | undefined): TmMessage[] {
  try {
    const arr = raw ? (JSON.parse(raw) as unknown) : [];
    if (!Array.isArray(arr)) return [];
    return arr.filter((x): x is TmMessage => !!x && typeof x === 'object' && typeof (x as TmMessage).text === 'string');
  } catch {
    return [];
  }
}

export function parseLabelIds(raw: string | null | undefined): string[] {
  try {
    const arr = raw ? (JSON.parse(raw) as unknown) : [];
    if (!Array.isArray(arr)) return [];
    return arr.filter((x): x is string => typeof x === 'string');
  } catch {
    return [];
  }
}

export function parseViewState(raw: string | null | undefined): TmViewState {
  const fallback: TmViewState = { view: 'my', projectId: null, boardId: null, userId: null, sort: 'manual', filters: { assignee: '', priorities: [], labelId: '', due: 'any', showDone: true } };
  try {
    const o = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    const f = (o.filters && typeof o.filters === 'object' ? o.filters : {}) as Record<string, unknown>;
    return {
      view: typeof o.view === 'string' ? o.view : 'my',
      projectId: typeof o.projectId === 'string' ? o.projectId : null,
      boardId: typeof o.boardId === 'string' ? o.boardId : null,
      userId: typeof o.userId === 'string' ? o.userId : null,
      sort: typeof o.sort === 'string' ? o.sort : 'manual',
      filters: {
        assignee: typeof f.assignee === 'string' ? f.assignee : '',
        priorities: Array.isArray(f.priorities) ? f.priorities.filter((x): x is string => typeof x === 'string') : [],
        labelId: typeof f.labelId === 'string' ? f.labelId : '',
        due: typeof f.due === 'string' ? f.due : 'any',
        showDone: f.showDone !== false,
      },
    };
  } catch {
    return fallback;
  }
}

/** CSS-переменные цвета задачи для карточек/строк (как colorStyle прототипа). */
export function colorVars(color: string | null, alpha: number | null): React.CSSProperties | undefined {
  if (!color) return undefined;
  return { '--tc': color, '--ta': Math.round((alpha ?? 0.2) * 100) + '%' } as React.CSSProperties;
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

/** Порядок сортировки списка задач по ключу (как в прототипе «Поток»). */
export function sortTasks(list: TmTask[], sort: string): TmTask[] {
  const c = [...list];
  const w: Record<string, number> = { critical: 0, high: 1, normal: 2, low: 3 };
  if (sort === 'manual') c.sort((a, b) => a.order - b.order);
  else if (sort === 'due') c.sort((a, b) => (a.stickers.deadline || '9999').localeCompare(b.stickers.deadline || '9999'));
  else if (sort === 'priority') c.sort((a, b) => (w[a.stickers.priority || ''] ?? 4) - (w[b.stickers.priority || ''] ?? 4));
  else if (sort === 'title') c.sort((a, b) => a.title.localeCompare(b.title, 'ru'));
  else if (sort === 'created') c.sort((a, b) => (b.createdAt > a.createdAt ? 1 : -1));
  return c;
}

/** Применение фильтров к списку задач (как applyFilters прототипа). */
export function applyFilters(list: TmTask[], f: TmFilters, meLogin: string): TmTask[] {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const tIso = today.toISOString().slice(0, 10);
  let out = list;
  if (f.assignee === 'me') out = out.filter((x) => x.stickers.assignees.includes(meLogin));
  else if (f.assignee === 'none') out = out.filter((x) => !x.stickers.assignees.length);
  else if (f.assignee) out = out.filter((x) => x.stickers.assignees.includes(f.assignee));
  if (f.priorities.length) out = out.filter((x) => x.stickers.priority && f.priorities.includes(x.stickers.priority));
  if (f.labelId) out = out.filter((x) => (x.labelIds || []).includes(f.labelId));
  if (f.due === 'overdue') out = out.filter((x) => x.stickers.deadline && x.stickers.deadline < tIso && !x.done);
  else if (f.due === 'today') out = out.filter((x) => x.stickers.deadline && x.stickers.deadline <= tIso);
  else if (f.due === 'week') {
    const week = new Date(today.getTime() + 7 * 86400000).toISOString().slice(0, 10);
    out = out.filter((x) => x.stickers.deadline && x.stickers.deadline >= tIso && x.stickers.deadline <= week);
  } else if (f.due === 'none') out = out.filter((x) => !x.stickers.deadline);
  if (!f.showDone) out = out.filter((x) => !x.done);
  return out;
}

/** Число активных фильтров (бейдж на кнопке-воронке). */
export function filterBadge(f: TmFilters): number {
  return (f.assignee ? 1 : 0) + f.priorities.length + (f.labelId ? 1 : 0) + (f.due !== 'any' ? 1 : 0) + (f.showDone ? 0 : 1);
}

export function emptyFilters(): TmFilters {
  return { assignee: '', priorities: [], labelId: '', due: 'any', showDone: true };
}
