'use client';

/**
 * Менеджер задач — приложение хаба сервисов (сервис task-manager).
 *
 * Порт прототипа «Поток · командные доски» в дизайн-систему «Ветвей»:
 * канбан-доски проектов (системные колонки Не взяты / В работе / Выполнено —
 * позиция в колонках и есть статус), бэклог, «Мои задачи», «Команды»,
 * «Люди», дровер задачи ТРЕХ режимов (боковая панель / большое окно /
 * на весь экран) со стикерами, МЕТКАМИ, Markdown-описанием, ЧАТОМ
 * (комментарии + системная история) и СВЯЗЯМИ с нодами «Ветвей»
 * (в обе стороны: из задачи можно открыть «Ветви» и выбрать ноды).
 *
 * ФИЛЬТРЫ (исполнитель/приоритеты/метка/дедлайн/выполненные) с бейджем
 * и СОХРАНЁННЫЕ ВИДЫ (личные пресеты в сайдбаре) — как в прототипе.
 *
 * КОМАНДЫ И ПРАВА: проекты имеют строки доступов (персональные + командные),
 * роль = максимум из них: admin (управляет доступом), editor (задачи),
 * viewer (читает и комментирует). Проект без строк — открыт всем (как было).
 * Назначение исполнителя шлёт ему уведомление (колокольчик + push),
 * комментарии — тоже.
 *
 * Данные — общие для всей команды (единый аккаунт хаба), хранятся в БД хаба
 * (/api/tm/*). Сервер проверяет доступ к сервису И роль в проекте на каждом
 * запросе: при закрытом доступе изменения не сохраняются (403 → экран
 * «нет доступа»; наблюдателю — «режим наблюдателя»).
 *
 * Интеграция с «Ветвями»:
 *  - хеш #service=task-manager&mk=1&p=<pid>&r=<rid>&n=<ids>&t=<titles> —
 *    «Ветви» прислали ноды: открывается окно новой задачи с готовыми связями;
 *  - хеш #service=task-manager&nf=<pid>&nn=<nid>&nt=<title> — переход к задачам
 *    конкретной ноды (клик по иконке задач над нодой в «Ветвях»);
 *  - хеш #service=task-manager&ot=<taskId> — открыть задачу (возврат из
 *    «Ветвей» после привязки нод; также клик по уведомлению);
 *  - кнопка «Привязать ноды» в задаче уводит в «Ветви» (#attach=<taskId>),
 *    выбор нод возвращается сюда (ot=…), связи дописывает сервер;
 *  - чипы связей в карточке/дровере возвращают в «Ветви» к ноде
 *    (#project=<id>&room=<rid>&node=<nid>).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { parseHash, goVetviNode } from '../hub';
import { ServiceSwitcher } from '../ServiceSwitcher';
import { ServiceIcon } from '../ServiceIcon';
import { BoardView, BacklogView, MyView, NodeFilterView, TmSidebar, TmTeamsView, TmPeopleView, TmFilterPop, TmAccessModal, TmTeamModal, TmSaveViewModal, TmBell, TmAccountMenu, type TmFilterState } from './TaskViews';
import { TmDrawer, TmCreateModal } from './TaskDrawer';
import { TmMenuHost, tmOpenMenu, tmCloseMenu, tmMenuPos } from './TmMenu';
import {
  applyFilters,
  emptyFilters,
  filterBadge,
  firstName,
  parseLabelIds,
  parseLinks,
  parseMessages,
  parseStickers,
  parseViewState,
  sortTasks,
  TM_ROLE_RANK,
  type TmAccessRow,
  type TmFilters,
  type TmLabel,
  type TmLink,
  type TmProject,
  type TmTask,
  type TmTeam,
  type TmView,
} from './tmTypes';

interface TmUser { login: string; displayName: string | null }

interface Ws {
  projects: TmProject[];
  tasks: TmTask[];
  labels: TmLabel[];
  teams: TmTeam[];
  access: TmAccessRow[];
  views: TmView[];
  me: { login: string; displayName: string; color: string };
}

export type { TmUser, Ws };

export type View =
  | { kind: 'my' }
  | { kind: 'user'; userId: string }
  | { kind: 'teams' }
  | { kind: 'people' }
  | { kind: 'board'; projectId: string; boardId: string }
  | { kind: 'backlog'; projectId: string };

/* ── API-обёртка: 403 = сервис закрыт или нет прав (нужно показать) ── */

class TmDenied extends Error {
  constructor(public msg: string) { super(msg); }
}

async function tmFetch(url: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(url, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
    cache: 'no-store',
  });
  if (res.status === 403) {
    const j = (await res.json().catch(() => ({}))) as { error?: string };
    throw new TmDenied(j.error || 'service');
  }
  return res;
}

async function tmJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await tmFetch(url, init);
  const j = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(j.error || 'Ошибка сервера');
  return j;
}

/* ── роль в проекте (клиентский расчёт по строкам доступов + командам) ── */

export function roleOf(ws: Ws, projectId: string): 'admin' | 'editor' | 'viewer' | null {
  const exists = ws.projects.some((p) => p.id === projectId);
  if (!exists) return null;
  const rows = ws.access.filter((r) => r.projectId === projectId);
  if (!rows.length) return 'admin'; /* без строк — открытый проект: правят все */
  const myTeams = new Set(ws.teams.filter((t) => t.members.some((m) => m.login === ws.me.login)).map((t) => t.id));
  let best: string | null = null;
  for (const r of rows) {
    const mine = (r.login && r.login === ws.me.login) || (r.teamId && myTeams.has(r.teamId));
    if (!mine) continue;
    const role = TM_ROLE_RANK[r.role] ? r.role : 'viewer';
    if (!best || TM_ROLE_RANK[role] > TM_ROLE_RANK[best]) best = role;
  }
  return (best || null) as 'admin' | 'editor' | 'viewer' | null;
}

/* ═══ корневой компонент ═══ */

export function TaskManagerApp({ svcKey }: { svcKey: string }) {
  const [ws, setWs] = useState<Ws | null>(null);
  const [phase, setPhase] = useState<'load' | 'ok' | 'err'>('load');
  const [errMsg, setErrMsg] = useState('');
  const [users, setUsers] = useState<TmUser[]>([]);
  const [view, setView] = useState<View>({ kind: 'my' });
  const [query, setQuery] = useState('');
  const [filters, setFilters] = useState<TmFilters>(emptyFilters());
  const [sort, setSort] = useState('manual');
  const [savedId, setSavedId] = useState<string | null>(null);
  const [drawerId, setDrawerId] = useState<string | null>(null);
  const [drawerMode, setDrawerMode] = useState<'side' | 'wide' | 'full'>(() => {
    if (typeof window === 'undefined') return 'side';
    return (localStorage.getItem('tm-drawer-mode') as 'side' | 'wide' | 'full') || 'side';
  });
  const [createOpen, setCreateOpen] = useState(false);
  const [createPreset, setCreatePreset] = useState<TmLink[] | null>(null);
  const [nodeFilter, setNodeFilter] = useState<{ pid: string; nid: string; title: string } | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [accessProjectId, setAccessProjectId] = useState<string | null>(null);
  const [teamModal, setTeamModal] = useState<{ team: TmTeam | null; mode?: 'members' | 'settings' | null } | null>(null);
  const [saveViewOpen, setSaveViewOpen] = useState(false);
  const [toast, setToast] = useState<{ text: string; tone: 'ok' | 'warn' | 'err' } | null>(null);
  const toastT = useRef<ReturnType<typeof setTimeout> | null>(null);
  /* свёрнутая панель (rail, как в прототипе) — запоминается */
  const [rail, setRail] = useState<boolean>(() => {
    try { return localStorage.getItem('tm-rail') === '1'; } catch { return false; }
  });
  const toggleRail = useCallback(() => {
    setRail((r) => {
      try { localStorage.setItem('tm-rail', r ? '0' : '1'); } catch { /* нет localStorage */ }
      return !r;
    });
  }, []);

  /* режим окна задачи (из настроек аккаунта и шапки дровера — один обработчик) */
  const handleDrawerMode = useCallback((m: 'side' | 'wide' | 'full') => {
    setDrawerMode(m);
    try { localStorage.setItem('tm-drawer-mode', m); } catch { /* нет localStorage */ }
  }, []);

  const say = useCallback((text: string, tone: 'ok' | 'warn' | 'err' = 'ok') => {
    if (toastT.current) clearTimeout(toastT.current);
    setToast({ text, tone });
    toastT.current = setTimeout(() => setToast(null), 3200);
  }, []);

  /* ── загрузка пространства ── */
  const load = useCallback(async () => {
    try {
      const j = await tmJson<{
        projects: TmProject[]; tasks: TmTask[]; labels: TmLabel[]; teams: TmTeam[];
        access: TmAccessRow[]; views: TmView[]; me: Ws['me'];
      }>('/api/tm');
      setWs({
        projects: j.projects || [],
        /* JSON-поля приходят строками — разворачиваем в объекты */
        tasks: (j.tasks || []).map((t) => ({
          ...t,
          stickers: parseStickers(t.stickers as unknown as string),
          links: parseLinks(t.links as unknown as string),
          messages: parseMessages(t.messages as unknown as string),
          labelIds: parseLabelIds(t.labelIds as unknown as string),
        })),
        labels: j.labels || [],
        teams: j.teams || [],
        access: j.access || [],
        views: (j.views || []).map((v) => ({ ...v, state: parseViewState(v.state as unknown as string) })),
        me: j.me,
      });
      setPhase('ok');
    } catch (e) {
      if (e instanceof TmDenied) throw e; /* наверх: экран «нет доступа» */
      setErrMsg(e instanceof Error ? e.message : 'Сервер недоступен');
      setPhase('err');
    }
  }, []);

  const loadUsers = useCallback(async () => {
    try {
      const r = await fetch('/api/users', { cache: 'no-store' });
      if (r.ok) setUsers(((await r.json()) as { list: TmUser[] }).list || []);
    } catch { /* список пользователей необязателен */ }
  }, []);

  /* ── первый вход: данные + разбор хеша интеграций ── */
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        await load();
        void loadUsers();
      } catch (e) {
        if (e instanceof TmDenied) { setPhase('err'); setErrMsg('denied'); }
        return;
      }
      if (!alive) return;
      /* прямые ссылки из «Ветвей»: mk=1 — создать задачу для нод;
         nf/nn — фильтр задач ноды; ot — открыть задачу (возврат из привязки
         или из уведомления). После разбора хеш чистится. */
      const { params } = parseHash();
      if (params.mk === '1' && params.n) {
        const ids = params.n.split(',').map((s) => decodeURIComponent(s.trim())).filter(Boolean);
        let titles: string[] = [];
        try { titles = JSON.parse(params.t || '[]') as string[]; } catch { titles = []; }
        const links: TmLink[] = ids.map((nid, i) => ({
          pid: params.p || '',
          nid,
          room: params.r && params.r !== '-' ? params.r : null,
          t: titles[i] || '',
        }));
        setCreatePreset(links);
        setCreateOpen(true);
        cleanHash();
      } else if (params.nf && params.nn) {
        setNodeFilter({ pid: params.nf, nid: params.nn, title: params.nt || '' });
        cleanHash();
      } else if (params.ot) {
        setDrawerId(params.ot);
        cleanHash();
      }
    })();
    return () => { alive = false; };
  }, [load, loadUsers]);

  /* ── helpers ── */

  const canEdit = useCallback((projectId: string): boolean => {
    if (!ws) return false;
    const r = roleOf(ws, projectId);
    return r === 'admin' || r === 'editor';
  }, [ws]);

  const canAdmin = useCallback((projectId: string): boolean => {
    if (!ws) return false;
    return roleOf(ws, projectId) === 'admin';
  }, [ws]);

  /* замена задачи в ws (ответ PATCH/POST — JSON-поля строками) */
  const putTask = useCallback((raw: TmTask) => {
    const t: TmTask = {
      ...raw,
      stickers: parseStickers(raw.stickers as unknown as string),
      links: parseLinks(raw.links as unknown as string),
      messages: parseMessages(raw.messages as unknown as string),
      labelIds: parseLabelIds(raw.labelIds as unknown as string),
    };
    setWs((w) => (w ? { ...w, tasks: w.tasks.map((x) => (x.id === t.id ? t : x)) } : w));
    return t;
  }, []);

  const addTask = useCallback((raw: TmTask) => {
    const t: TmTask = {
      ...raw,
      stickers: parseStickers(raw.stickers as unknown as string),
      links: parseLinks(raw.links as unknown as string),
      messages: parseMessages(raw.messages as unknown as string),
      labelIds: parseLabelIds(raw.labelIds as unknown as string),
    };
    setWs((w) => (w ? { ...w, tasks: [...w.tasks, t] } : w));
    return t;
  }, []);

  const guardEdit = useCallback((projectId: string): boolean => {
    if (canEdit(projectId)) return true;
    say('Недостаточно прав: режим наблюдателя', 'warn');
    return false;
  }, [canEdit, say]);

  /* ── открытая задача по событию (переход к родителю/подзадаче из дровера) ── */
  useEffect(() => {
    const onOpen = (e: Event) => {
      const id = (e as CustomEvent<string>).detail;
      if (typeof id === 'string' && id) setDrawerId(id);
    };
    window.addEventListener('tm-open-task', onOpen);
    return () => window.removeEventListener('tm-open-task', onOpen);
  }, []);

  /* ── Esc закрывает дровер; [ — сворачивает панель; N — новая задача; / — поиск ── */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = !!(t && t.closest && t.closest('input,textarea,select,[contenteditable="true"]'));
      if (e.key === 'Escape') {
        if (!drawerId) return;
        setDrawerId(null);
        return;
      }
      if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === '[' || e.key === 'х') { e.preventDefault(); toggleRail(); return; }
      if (e.key.toLowerCase() === 'n' || e.key.toLowerCase() === 'т') { e.preventDefault(); setCreatePreset(null); setCreateOpen(true); return; }
      if (e.key === '/') {
        e.preventDefault();
        const inp = document.querySelector<HTMLInputElement>('.tm-head .tm-search input');
        if (inp) inp.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drawerId, toggleRail]);

  /* ── мутации ── */

  const createTask = useCallback(async (payload: Record<string, unknown>): Promise<TmTask | null> => {
    try {
      const j = await tmJson<{ item: TmTask }>('/api/tm', { method: 'POST', body: JSON.stringify(payload) });
      const t = addTask(j.item);
      return t;
    } catch (e) {
      if (e instanceof TmDenied) { say(e.msg === 'service' ? 'Сервис недоступен' : e.msg, 'err'); if (e.msg === 'service') { setPhase('err'); setErrMsg('denied'); } return null; }
      say(e instanceof Error ? e.message : 'Не удалось создать задачу', 'err');
      return null;
    }
  }, [addTask, say]);

  /** Дублировать задачу: та же колонка/стикеры/связи/метки, копия ставится рядом. */
  const duplicateTask = useCallback(async (src: TmTask): Promise<void> => {
    const created = await createTask({
      title: src.title + ' (копия)',
      projectId: src.projectId,
      boardId: src.boardId,
      columnId: src.columnId,
      description: src.description,
      color: src.color,
      colorAlpha: src.colorAlpha,
      stickers: { ...src.stickers },
      links: (src.links || []).map((l) => ({ ...l })),
      labelIds: [...(src.labelIds || [])],
    });
    if (created) {
      say('Задача продублирована');
      setDrawerId(created.id);
    }
  }, [createTask, say]);

  const patchTask = useCallback(async (id: string, patch: Record<string, unknown>): Promise<boolean> => {
    try {
      const j = await tmJson<{ item: TmTask; moved?: TmTask[] }>('/api/tm/tasks/' + id, { method: 'PATCH', body: JSON.stringify(patch) });
      putTask(j.item);
      /* перенос родителя тянет подзадачи в ту же колонку (сервер их переносит
         и возвращает список — обновляем их в состоянии) */
      for (const m of j.moved || []) putTask(m);
      return true;
    } catch (e) {
      if (e instanceof TmDenied) {
        if (e.msg === 'service') { setPhase('err'); setErrMsg('denied'); }
        else say(e.msg, 'warn');
        return false;
      }
      say(e instanceof Error ? e.message : 'Не удалось сохранить задачу', 'err');
      return false;
    }
  }, [putTask, say]);

  const deleteTask = useCallback(async (id: string): Promise<boolean> => {
    try {
      await tmJson('/api/tm/tasks/' + id, { method: 'DELETE' });
      setWs((w) => {
        if (!w) return w;
        const gone = new Set<string>();
        const collect = (tid: string) => {
          gone.add(tid);
          for (const t of w.tasks) if (t.parentId === tid) collect(t.id);
        };
        collect(id);
        return { ...w, tasks: w.tasks.filter((t) => !gone.has(t.id)) };
      });
      setDrawerId((d) => (d === id ? null : d));
      return true;
    } catch (e) {
      if (e instanceof TmDenied) { if (e.msg === 'service') { setPhase('err'); setErrMsg('denied'); } else say(e.msg, 'warn'); return false; }
      say(e instanceof Error ? e.message : 'Не удалось удалить задачу', 'err');
      return false;
    }
  }, [say]);

  const createProject = useCallback(async (title: string, open = true): Promise<TmProject | null> => {
    try {
      const j = await tmJson<{ item: TmProject }>('/api/tm/projects', { method: 'POST', body: JSON.stringify({ title, open }) });
      setWs((w) => (w ? { ...w, projects: [...w.projects, j.item] } : w));
      say('Проект создан');
      return j.item;
    } catch (e) {
      if (e instanceof TmDenied) { say(e.msg, 'err'); return null; }
      say(e instanceof Error ? e.message : 'Не удалось создать проект', 'err');
      return null;
    }
  }, [say]);

  const createBoard = useCallback(async (projectId: string, title: string): Promise<TmBoardType | null> => {
    try {
      const j = await tmJson<{ item: TmBoardType }>('/api/tm/boards', { method: 'POST', body: JSON.stringify({ projectId, title }) });
      setWs((w) => (w ? {
        ...w,
        projects: w.projects.map((p) => (p.id === projectId ? { ...p, boards: [...p.boards, j.item] } : p)),
      } : w));
      return j.item;
    } catch (e) {
      if (e instanceof TmDenied) { say(e.msg, 'err'); return null; }
      say(e instanceof Error ? e.message : 'Не удалось создать доску', 'err');
      return null;
    }
  }, [say]);

  const createColumn = useCallback(async (boardId: string, title: string): Promise<TmColumnType | null> => {
    try {
      const j = await tmJson<{ item: TmColumnType }>('/api/tm/columns', { method: 'POST', body: JSON.stringify({ boardId, title }) });
      setWs((w) => (w ? {
        ...w,
        projects: w.projects.map((p) => ({
          ...p,
          boards: p.boards.map((b) => (b.id === boardId ? { ...b, columns: [...b.columns, j.item] } : b)),
        })),
      } : w));
      return j.item;
    } catch (e) {
      if (e instanceof TmDenied) { say(e.msg, 'err'); return null; }
      say(e instanceof Error ? e.message : 'Не удалось создать колонку', 'err');
      return null;
    }
  }, [say]);

  const renameProject = useCallback(async (id: string, title: string) => {
    try {
      const j = await tmJson<{ item: TmProject }>('/api/tm/projects/' + id, { method: 'PATCH', body: JSON.stringify({ title }) });
      setWs((w) => (w ? { ...w, projects: w.projects.map((p) => (p.id === id ? { ...p, title: j.item.title } : p)) } : w));
    } catch (e) {
      if (e instanceof TmDenied) { say(e.msg, 'warn'); return; }
      say(e instanceof Error ? e.message : 'Не удалось переименовать', 'err');
    }
  }, [say]);

  const deleteProject = useCallback(async (id: string) => {
    try {
      await tmJson('/api/tm/projects/' + id, { method: 'DELETE' });
      setWs((w) => (w ? {
        ...w,
        projects: w.projects.filter((p) => p.id !== id),
        access: w.access.filter((r) => r.projectId !== id),
        tasks: w.tasks.filter((t) => t.projectId !== id),
      } : w));
      setView((v) => (v.kind !== 'my' && 'projectId' in v && v.projectId === id ? { kind: 'my' } : v));
      say('Проект удалён');
    } catch (e) {
      if (e instanceof TmDenied) { say(e.msg, 'warn'); return; }
      say(e instanceof Error ? e.message : 'Не удалось удалить проект', 'err');
    }
  }, [say]);

  const renameBoard = useCallback(async (id: string, title: string) => {
    try {
      const j = await tmJson<{ item: TmBoardType }>('/api/tm/boards/' + id, { method: 'PATCH', body: JSON.stringify({ title }) });
      setWs((w) => (w ? {
        ...w,
        projects: w.projects.map((p) => ({ ...p, boards: p.boards.map((b) => (b.id === id ? { ...b, title: j.item.title } : b)) })),
      } : w));
    } catch (e) {
      if (e instanceof TmDenied) { say(e.msg, 'warn'); return; }
      say(e instanceof Error ? e.message : 'Не удалось переименовать', 'err');
    }
  }, [say]);

  const deleteBoard = useCallback(async (id: string) => {
    try {
      await tmJson('/api/tm/boards/' + id, { method: 'DELETE' });
      setWs((w) => {
        if (!w) return w;
        /* задачи доски уходят в бэклог (boardId/columnId → null) */
        return {
          ...w,
          projects: w.projects.map((p) => ({ ...p, boards: p.boards.filter((b) => b.id !== id) })),
          tasks: w.tasks.map((t) => (t.boardId === id ? { ...t, boardId: null, columnId: null } : t)),
        };
      });
      setView((v) => (v.kind === 'board' && v.boardId === id ? { kind: 'backlog', projectId: v.projectId } : v));
      say('Доска удалена — задачи в бэклоге');
    } catch (e) {
      if (e instanceof TmDenied) { say(e.msg, 'warn'); return; }
      say(e instanceof Error ? e.message : 'Не удалось удалить доску', 'err');
    }
  }, [say]);

  /* ── колонки: правка любого поля (название у ВСЕХ — вкл. дефолтных,
     иконка только у не-системных — сервер фильтрует), порядок, очистка ── */
  const updateColumn = useCallback(async (id: string, data: Record<string, unknown>): Promise<boolean> => {
    try {
      const j = await tmJson<{ item: TmColumnType }>('/api/tm/columns/' + id, { method: 'PATCH', body: JSON.stringify(data) });
      setWs((w) => (w ? {
        ...w,
        projects: w.projects.map((p) => ({
          ...p,
          boards: p.boards.map((b) => ({ ...b, columns: b.columns.map((c) => (c.id === id ? j.item : c)) })),
        })),
      } : w));
      return true;
    } catch (e) {
      if (e instanceof TmDenied) { say(e.msg, 'warn'); return false; }
      say(e instanceof Error ? e.message : 'Не удалось сохранить колонку', 'err');
      return false;
    }
  }, [say]);

  const renameColumn = useCallback((id: string, title: string) => updateColumn(id, { title }), [updateColumn]);

  /** Перестановка колонок (после DnD или «влево/вправо»): sortOrder = позиция в списке. */
  const reorderColumns = useCallback(async (boardId: string, columnIds: string[]) => {
    setWs((w) => {
      if (!w) return w;
      const rank = new Map(columnIds.map((id, i) => [id, i + 1]));
      return {
        ...w,
        projects: w.projects.map((p) => ({
          ...p,
          boards: p.boards.map((b) => (b.id === boardId
            ? { ...b, columns: [...b.columns].sort((x, y) => (rank.get(x.id) ?? x.sortOrder) - (rank.get(y.id) ?? y.sortOrder)).map((c) => ({ ...c, sortOrder: rank.get(c.id) ?? c.sortOrder })) }
            : b)),
        })),
      };
    });
    for (let i = 0; i < columnIds.length; i++) {
      void tmJson('/api/tm/columns/' + columnIds[i], { method: 'PATCH', body: JSON.stringify({ sortOrder: i + 1 }) }).catch(() => undefined);
    }
  }, []);

  /** Сдвиг колонки влево/вправо из меню. */
  const moveColumn = useCallback((id: string, dir: number) => {
    if (!ws) return;
    for (const p of ws.projects) for (const b of p.boards) {
      const idx = b.columns.findIndex((c) => c.id === id);
      if (idx < 0) continue;
      const ni = idx + dir;
      if (ni < 0 || ni >= b.columns.length) return;
      const ids = b.columns.map((c) => c.id);
      [ids[idx], ids[ni]] = [ids[ni], ids[idx]];
      void reorderColumns(b.id, ids);
      return;
    }
  }, [reorderColumns, ws]);

  /** «Всё в бэклог»: все задачи колонки переезжают в бэклог проекта. */
  const clearColumn = useCallback(async (id: string) => {
    if (!ws) return;
    const inCol = ws.tasks.filter((t) => t.columnId === id);
    for (const t of inCol) await patchTask(t.id, { boardId: null, columnId: null });
    say('Задачи колонки — в бэклог');
  }, [patchTask, say, ws]);

  /** Удаление колонки с выбором судьбы задач (как в прототипе): в бэклог или вместе с задачами. */
  const deleteColumnFate = useCallback(async (id: string, fate: 'backlog' | 'delete') => {
    if (!ws) return;
    const inCol = ws.tasks.filter((t) => t.columnId === id);
    if (fate === 'delete') {
      for (const t of inCol) await deleteTask(t.id);
    }
    try {
      await tmJson('/api/tm/columns/' + id, { method: 'DELETE' });
      setWs((w) => {
        if (!w) return w;
        return {
          ...w,
          projects: w.projects.map((p) => ({ ...p, boards: p.boards.map((b) => ({ ...b, columns: b.columns.filter((c) => c.id !== id) })) })),
          tasks: w.tasks.filter((t) => t.columnId !== id),
        };
      });
      say(fate === 'delete' ? 'Колонка удалена вместе с задачами' : 'Колонка удалена — задачи в бэклоге');
    } catch (e) {
      if (e instanceof TmDenied) { say(e.msg, 'warn'); return; }
      say(e instanceof Error ? e.message : 'Не удалось удалить колонку', 'err');
    }
  }, [deleteTask, say, ws]);

  /* ── метки ── */
  const createLabel = useCallback(async (name: string, color: string): Promise<TmLabel | null> => {
    try {
      const j = await tmJson<{ item: TmLabel }>('/api/tm/labels', { method: 'POST', body: JSON.stringify({ name, color }) });
      setWs((w) => (w ? (w.labels.some((l) => l.id === j.item.id) ? w : { ...w, labels: [...w.labels, j.item].sort((a, b) => a.name.localeCompare(b.name, 'ru')) }) : w));
      return j.item;
    } catch (e) {
      say(e instanceof Error ? e.message : 'Не удалось создать метку', 'err');
      return null;
    }
  }, [say]);

  const deleteLabel = useCallback(async (id: string) => {
    try {
      await tmJson('/api/tm/labels/' + id, { method: 'DELETE' });
      setWs((w) => (w ? {
        ...w,
        labels: w.labels.filter((l) => l.id !== id),
        tasks: w.tasks.map((t) => ({ ...t, labelIds: (t.labelIds || []).filter((x) => x !== id) })),
      } : w));
      setFilters((f) => (f.labelId === id ? { ...f, labelId: '' } : f));
      say('Метка удалена');
    } catch (e) {
      say(e instanceof Error ? e.message : 'Не удалось удалить метку', 'err');
    }
  }, [say]);

  /* ── команды ── */
  const saveTeam = useCallback(async (payload: Record<string, unknown>, id?: string): Promise<boolean> => {
    try {
      const j = await tmJson<{ item: TmTeam }>(id ? '/api/tm/teams/' + id : '/api/tm/teams', {
        method: id ? 'PATCH' : 'POST',
        body: JSON.stringify(payload),
      });
      setWs((w) => {
        if (!w) return w;
        const teams = id ? w.teams.map((t) => (t.id === id ? j.item : t)) : [...w.teams, j.item];
        return { ...w, teams: [...teams].sort((a, b) => a.name.localeCompare(b.name, 'ru')) };
      });
      say(id ? 'Команда сохранена' : 'Команда создана');
      return true;
    } catch (e) {
      say(e instanceof Error ? e.message : 'Не удалось сохранить команду', 'err');
      return false;
    }
  }, [say]);

  const deleteTeam = useCallback(async (id: string) => {
    try {
      await tmJson('/api/tm/teams/' + id, { method: 'DELETE' });
      setWs((w) => (w ? {
        ...w,
        teams: w.teams.filter((t) => t.id !== id),
        access: w.access.filter((r) => r.teamId !== id),
      } : w));
      say('Команда удалена — доступ по ней снят');
    } catch (e) {
      say(e instanceof Error ? e.message : 'Не удалось удалить команду', 'err');
    }
  }, [say]);

  /* ── доступы проекта ── */
  const saveAccess = useCallback(async (projectId: string, rows: { login?: string | null; teamId?: string | null; role: string }[]): Promise<boolean> => {
    try {
      const j = await tmJson<{ items: TmAccessRow[] }>('/api/tm/projects/' + projectId + '/access', {
        method: 'PUT',
        body: JSON.stringify({ rows }),
      });
      setWs((w) => (w ? { ...w, access: [...w.access.filter((r) => r.projectId !== projectId), ...j.items] } : w));
      say('Доступ проекта сохранён');
      return true;
    } catch (e) {
      say(e instanceof Error ? e.message : 'Не удалось сохранить доступ', 'err');
      return false;
    }
  }, [say]);

  /* ── сохранённые виды ── */
  const saveView = useCallback(async (name: string): Promise<boolean> => {
    try {
      const state = {
        view: view.kind === 'user' ? 'user' : view.kind,
        projectId: 'projectId' in view ? view.projectId : null,
        boardId: view.kind === 'board' ? view.boardId : null,
        userId: view.kind === 'user' ? view.userId : null,
        sort,
        filters,
      };
      const j = await tmJson<{ item: TmView }>('/api/tm/views', { method: 'POST', body: JSON.stringify({ name, state }) });
      setWs((w) => (w ? { ...w, views: [...w.views, { ...j.item, state: parseViewState(j.item.state as unknown as string) }] } : w));
      setSavedId(j.item.id);
      say('Вид «' + name + '» сохранён');
      return true;
    } catch (e) {
      say(e instanceof Error ? e.message : 'Не удалось сохранить вид', 'err');
      return false;
    }
  }, [filters, say, sort, view]);

  const applySavedView = useCallback((v: TmView) => {
    const st = v.state;
    setSavedId(v.id);
    setNodeFilter(null);
    setFilters(st.filters);
    setSort(st.sort);
    /* доска/бэклог вида могла быть удалена — тогда мягкий фоллбек:
       первая доска проекта, иначе бэклог, иначе «Мои задачи» */
    if (st.view === 'board' && st.projectId && st.boardId) {
      const p = ws?.projects.find((x) => x.id === st.projectId);
      if (p?.boards.some((b) => b.id === st.boardId)) { setView({ kind: 'board', projectId: st.projectId, boardId: st.boardId }); return; }
      if (p?.boards[0]) { setView({ kind: 'board', projectId: st.projectId, boardId: p.boards[0].id }); return; }
      if (p) { setView({ kind: 'backlog', projectId: st.projectId }); return; }
      setView({ kind: 'my' });
      return;
    }
    if (st.view === 'backlog' && st.projectId && ws?.projects.some((x) => x.id === st.projectId)) { setView({ kind: 'backlog', projectId: st.projectId }); return; }
    if (st.view === 'user' && st.userId) { setView({ kind: 'user', userId: st.userId }); return; }
    setView({ kind: 'my' });
  }, [ws]);

  const deleteView = useCallback(async (id: string) => {
    try {
      await tmJson('/api/tm/views/' + id, { method: 'DELETE' });
      setWs((w) => (w ? { ...w, views: w.views.filter((v) => v.id !== id) } : w));
      setSavedId((s) => (s === id ? null : s));
    } catch { /* вид уже удалён */ }
  }, []);

  /* ── комментарии ── */
  const sendComment = useCallback(async (taskId: string, text: string): Promise<boolean> => {
    try {
      const j = await tmJson<{ item: TmTask }>('/api/tm/tasks/' + taskId + '/comments', { method: 'POST', body: JSON.stringify({ text }) });
      putTask(j.item);
      return true;
    } catch (e) {
      if (e instanceof TmDenied) { say(e.msg, 'warn'); return false; }
      say(e instanceof Error ? e.message : 'Не удалось отправить комментарий', 'err');
      return false;
    }
  }, [putTask, say]);

  /* правка/реакция комментария */
  const patchComment = useCallback(async (taskId: string, msgId: string, patch: { text?: string; react?: string }): Promise<boolean> => {
    try {
      const j = await tmJson<{ item: TmTask }>('/api/tm/tasks/' + taskId + '/comments/' + msgId, { method: 'PATCH', body: JSON.stringify(patch) });
      putTask(j.item);
      return true;
    } catch (e) {
      if (e instanceof TmDenied) { say(e.msg, 'warn'); return false; }
      say(e instanceof Error ? e.message : 'Не удалось сохранить комментарий', 'err');
      return false;
    }
  }, [putTask, say]);

  /* удаление комментария */
  const deleteComment = useCallback(async (taskId: string, msgId: string): Promise<boolean> => {
    try {
      const j = await tmJson<{ item: TmTask }>('/api/tm/tasks/' + taskId + '/comments/' + msgId, { method: 'DELETE' });
      putTask(j.item);
      return true;
    } catch (e) {
      if (e instanceof TmDenied) { say(e.msg, 'warn'); return false; }
      say(e instanceof Error ? e.message : 'Не удалось удалить комментарий', 'err');
      return false;
    }
  }, [putTask, say]);

  /* ── привязка нод из задачи: уводим в «Ветви» в режим привязки ── */
  const goAttachNodes = useCallback((taskId: string, taskTitle: string) => {
    try {
      window.location.hash = 'attach=' + encodeURIComponent(taskId) + '&at=' + encodeURIComponent(taskTitle.slice(0, 60));
    } catch { /* нет window */ }
  }, []);

  /* ── диспетчер действий контекстных меню и поповера цвета ── */
  const menuAct = useCallback(async (name: string, arg?: unknown): Promise<void> => {
    const A = (arg || {}) as Record<string, string>;
    const close = () => tmCloseMenu();
    switch (name) {
      case 'open-task': close(); setDrawerId(A.id || String(arg)); return;
      case 'toggle-done': {
        const t = ws?.tasks.find((x) => x.id === A.id);
        if (t && ws) { close(); await toggleDone(t, ws, patchTask); }
        return;
      }
      case 'color-pop': {
        const pos = tmMenuPos();
        tmOpenMenu('color', { id: A.id || String(arg || '') }, pos?.x || 100, pos?.y || 100);
        return;
      }
      case 'color-set': await patchTask(A.id, { color: A.color || null }); return;
      case 'color-alpha': await patchTask(A.id, { colorAlpha: parseFloat(A.alpha) }); return;
      case 'move-task': {
        close();
        const t = ws?.tasks.find((x) => x.id === A.id);
        if (!t) return;
        if (A.columnId) await patchTask(t.id, { columnId: A.columnId });
        else await patchTask(t.id, { boardId: null, columnId: null });
        return;
      }
      case 'add-child': {
        close(); setDrawerId(A.id);
        window.setTimeout(() => {
          try { window.dispatchEvent(new CustomEvent('tm-focus-child')); } catch { /* нет CustomEvent */ }
        }, 60);
        return;
      }
      case 'dup-task': { close(); if (ws) { const t = ws.tasks.find((x) => x.id === A.id); if (t) await duplicateTask(t); } return; }
      case 'del-task': {
        close();
        const t = ws?.tasks.find((x) => x.id === A.id);
        if (t && window.confirm('Удалить задачу «' + t.title.slice(0, 40) + '» вместе с подзадачами?')) await deleteTask(t.id);
        return;
      }
      case 'col-rename': await updateColumn(A.id, { title: A.title }); return;
      case 'col-move': moveColumn(A.id, parseInt(A.dir, 10)); return;
      case 'col-icon': await updateColumn(A.id, { icon: A.icon }); return;
      case 'col-color': await updateColumn(A.id, { color: A.color }); return;
      case 'col-clear': close(); await clearColumn(A.id); return;
      case 'col-del': close(); await deleteColumnFate(A.id, A.fate === 'delete' ? 'delete' : 'backlog'); return;
      case 'board-rename': await renameBoard(A.id, A.title); return;
      case 'add-column': {
        close();
        const board = ws?.projects.flatMap((p) => p.boards).find((b) => b.id === A.id || b.id === String(arg));
        const bid = board?.id || String(arg);
        const project = ws?.projects.find((p) => p.boards.some((b) => b.id === bid));
        if (!project) return;
        const title = window.prompt('Название новой колонки:', '') || '';
        if (!title.trim() || !guardEdit(project.id)) return;
        const c = await createColumn(bid, title.trim());
        if (c) say('Колонка добавлена');
        return;
      }
      case 'new-task': {
        close(); setCreatePreset(null); setCreateOpen(true);
        return;
      }
      case 'access-project': close(); setAccessProjectId(String(arg) || A.id); return;
      case 'del-board': {
        close();
        const b = ws?.projects.flatMap((p) => p.boards).find((x) => x.id === A.id);
        if (b && window.confirm('Удалить доску «' + b.title + '»? Задачи уйдут в бэклог проекта.')) await deleteBoard(b.id);
        return;
      }
      case 'open-project': {
        close();
        const p = ws?.projects.find((x) => x.id === String(arg));
        if (!p) return;
        if (p.boards[0]) setView({ kind: 'board', projectId: p.id, boardId: p.boards[0].id });
        else setView({ kind: 'backlog', projectId: p.id });
        return;
      }
      case 'add-board': {
        close();
        const pid = String(arg);
        const p = ws?.projects.find((x) => x.id === pid);
        if (!p) return;
        const title = window.prompt('Название новой доски:', '') || '';
        if (!title.trim() || !guardEdit(pid)) return;
        const b = await createBoard(pid, title.trim());
        if (b) setView({ kind: 'board', projectId: pid, boardId: b.id });
        return;
      }
      case 'rename-project': {
        close();
        const p = ws?.projects.find((x) => x.id === String(arg));
        if (!p) return;
        const title = window.prompt('Название проекта:', p.title) || '';
        if (title.trim() && title.trim() !== p.title && guardEdit(p.id)) await renameProject(p.id, title.trim());
        return;
      }
      case 'del-project': {
        close();
        const p = ws?.projects.find((x) => x.id === String(arg));
        if (p && window.confirm('Удалить проект «' + p.title + '» с досками и задачами? Отменить нельзя.')) await deleteProject(p.id);
        return;
      }
      case 'open-backlog': close(); setView({ kind: 'backlog', projectId: String(arg) }); return;
      case 'open-view': { close(); const v = ws?.views.find((x) => x.id === String(arg)); if (v) applySavedView(v); return; }
      case 'del-view': close(); await deleteView(String(arg)); return;
      case 'open-team': {
        close();
        const t = ws?.teams.find((x) => x.id === A.id);
        if (t) setTeamModal({ team: t, mode: (A.mode === 'members' || A.mode === 'settings' ? A.mode : null) as 'members' | 'settings' | null });
        return;
      }
      case 'del-team': {
        close();
        const t = ws?.teams.find((x) => x.id === String(arg));
        if (t && window.confirm('Удалить команду «' + t.name + '»? Доступ по ней к проектам будет снят.')) await deleteTeam(t.id);
        return;
      }
      case 'open-user': close(); setView({ kind: 'user', userId: String(arg) }); return;
      case 'new-project': {
        close();
        const title = window.prompt('Название нового проекта:', '') || '';
        if (!title.trim()) return;
        const p = await createProject(title.trim());
        if (p && p.boards[0]) setView({ kind: 'board', projectId: p.id, boardId: p.boards[0].id });
        return;
      }
      case 'new-team': close(); setTeamModal({ team: null, mode: null }); return;
      case 'toggle-rail': close(); toggleRail(); return;
      case 'save-view': close(); setSaveViewOpen(true); return;
      /* ── действия над комментариями (ПКМ в чате задачи) ── */
      case 'msg-reply': {
        close();
        const t = ws?.tasks.find((x) => x.id === A.taskId);
        const msg = t?.messages.find((m) => m.id === A.msgId);
        try { window.dispatchEvent(new CustomEvent('tm-msg-reply', { detail: { login: A.login || msg?.login || '', text: msg?.text || '' } })); } catch { /* нет CustomEvent */ }
        return;
      }
      case 'msg-edit': {
        close();
        const t = ws?.tasks.find((x) => x.id === A.taskId);
        const msg = t?.messages.find((m) => m.id === A.msgId);
        if (!msg) return;
        try { window.dispatchEvent(new CustomEvent('tm-msg-edit', { detail: { msgId: msg.id, text: msg.text } })); } catch { /* нет CustomEvent */ }
        return;
      }
      case 'msg-react': {
        const t = ws?.tasks.find((x) => x.id === A.taskId);
        if (!t) return;
        await patchComment(A.taskId, A.msgId, { react: A.react || '👍' });
        return;
      }
      case 'msg-copy': {
        close();
        for (const t of ws?.tasks || []) {
          const msg = t.messages.find((m) => m.id === A.msgId);
          if (msg) {
            try { await navigator.clipboard.writeText(msg.text); say('Текст комментария скопирован'); } catch { say('Не удалось скопировать', 'warn'); }
            return;
          }
        }
        return;
      }
      case 'msg-del': {
        close();
        const t = ws?.tasks.find((x) => x.id === A.taskId);
        const msg = t?.messages.find((m) => m.id === A.msgId);
        if (!msg) return;
        if (window.confirm('Удалить комментарий' + (msg.login !== ws?.me.login ? ' участника @' + msg.login : '') + '?')) await deleteComment(A.taskId, A.msgId);
        return;
      }
      /* ── выделенный фрагмент в WYSIWYG-редакторе (цитировать/копировать) ── */
      case 'md-quote': {
        close();
        try { window.dispatchEvent(new CustomEvent('tm-quote-comment', { detail: { text: String(A.text || '') } })); } catch { /* нет CustomEvent */ }
        return;
      }
      case 'md-copy-sel': {
        close();
        try { await navigator.clipboard.writeText(String(A.text || '')); say('Фрагмент скопирован'); } catch { say('Не удалось скопировать', 'warn'); }
        return;
      }
      default: return;
    }
  }, [applySavedView, clearColumn, createBoard, createColumn, deleteBoard, deleteColumnFate, deleteComment, deleteProject, deleteTeam, deleteTask, deleteView, duplicateTask, guardEdit, moveColumn, patchComment, patchTask, renameBoard, renameProject, say, toggleRail, updateColumn, ws]);

  /* ── готовые данные для представлений ── */
  const userMap = useMemo(() => {
    const m = new Map<string, TmUser>();
    for (const u of users) m.set(u.login, u);
    return m;
  }, [users]);

  const matchQuery = useCallback((t: TmTask, q: string): boolean => {
    if (!q) return true;
    const s = q.toLowerCase();
    if (t.title.toLowerCase().includes(s) || (t.description || '').toLowerCase().includes(s)) return true;
    /* как в прототипе: ищем по чатам, меткам, исполнителям и проекту */
    if ((t.messages || []).some((m) => m.text.toLowerCase().includes(s))) return true;
    const labelQ = s.replace(/^#/, '');
    if ((t.labelIds || []).some((id) => (ws?.labels.find((l) => l.id === id)?.name || '').toLowerCase().includes(labelQ))) return true;
    if (t.stickers.assignees.some((a) => a.toLowerCase().includes(s) || firstName(userMap.get(a)?.displayName, a).toLowerCase().includes(s))) return true;
    const proj = ws?.projects.find((p) => p.id === t.projectId);
    if (proj && proj.title.toLowerCase().includes(s)) return true;
    return false;
  }, [ws, userMap]);

  const filteredByView = useCallback((list: TmTask[]): TmTask[] => {
    return sortTasks(applyFilters(list, filters, ws?.me.login || ''), sort);
  }, [filters, sort, ws]);

  const myTasks = useMemo(() => {
    if (!ws) return [];
    return ws.tasks.filter((t) => t.stickers && t.stickers.assignees.includes(ws.me.login) && !t.done);
  }, [ws]);

  /* ═══ рендер ═══ */

  if (phase === 'err' && errMsg === 'denied') {
    return (
      <main className="tm-app" aria-label="Менеджер задач — нет доступа">
        <div className="tm-denied">
          <span className="svc-ico-big lock"><ServiceIcon icon="lock" size={34} /></span>
          <h1 className="svc-title">Нет доступа к сервису</h1>
          <p className="svc-desc">Администратор закрыл доступ к менеджеру задач.</p>
          <button type="button" className="btn primary" onClick={() => { window.location.hash = ''; }}>
            ← Ветви
          </button>
        </div>
      </main>
    );
  }

  const badge = filterBadge(filters);

  return (
    <main className="tm-app" aria-label="Менеджер задач">
      <header className="svc-head tm-head">
        <div className="svc-head-brand">
          <ServiceSwitcher current={svcKey} />
          <span className="svc-head-ico"><ServiceIcon icon="tasks" size={18} /></span>
          <span className="svc-head-name">Менеджер задач</span>
        </div>
        <div className="tm-search">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Поиск: название, описание…"
            aria-label="Поиск задач"
          />
          {query && <button type="button" className="tm-search-x" title="Очистить" onClick={() => setQuery('')}>×</button>}
        </div>
        <div className="svc-head-right">
          {ws && (
            <TmBell
              me={ws.me}
              say={say}
              onOpenTask={(taskId) => { setDrawerId(taskId); setNodeFilter(null); }}
            />
          )}
          <button
            type="button"
            className="btn primary tm-new"
            onClick={() => { setCreatePreset(null); setCreateOpen(true); }}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
            Задача
          </button>
          <TmAccountMenu
            say={say}
            drawerMode={drawerMode}
            onDrawerMode={handleDrawerMode}
            rail={rail}
            onRail={toggleRail}
          />
        </div>
      </header>

      <div className="tm-layout">
        {ws && (
          <TmSidebar
            ws={ws}
            view={view}
            savedId={savedId}
            filtersActive={badge > 0}
            myCount={myTasks.length}
            rail={rail}
            onToggleRail={toggleRail}
            /* переход на любой раздел СБРАСЫВАЕТ фильтры сохранённого вида
               (жалоба: «фильтр вида не сбрасывается при клике на доску») */
            onMy={() => { setView({ kind: 'my' }); setNodeFilter(null); setFilters(emptyFilters()); setSavedId(null); }}
            onTeams={() => { setView({ kind: 'teams' }); setNodeFilter(null); setFilters(emptyFilters()); setSavedId(null); }}
            onPeople={() => { setView({ kind: 'people' }); setNodeFilter(null); setFilters(emptyFilters()); setSavedId(null); }}
            onUser={(login) => { setView({ kind: 'user', userId: login }); setNodeFilter(null); setFilters(emptyFilters()); setSavedId(null); }}
            onBoard={(projectId, boardId) => { setView({ kind: 'board', projectId, boardId }); setNodeFilter(null); setFilters(emptyFilters()); setSavedId(null); }}
            onBacklog={(projectId) => { setView({ kind: 'backlog', projectId }); setNodeFilter(null); setFilters(emptyFilters()); setSavedId(null); }}
            onOpenProject={(projectId) => {
              /* клик по проекту — сразу основная (первая) доска или бэклог */
              const p = ws.projects.find((x) => x.id === projectId);
              if (!p) return;
              if (p.boards[0]) setView({ kind: 'board', projectId, boardId: p.boards[0].id });
              else setView({ kind: 'backlog', projectId });
              setNodeFilter(null);
              setFilters(emptyFilters());
              setSavedId(null);
            }}
            onApplyView={applySavedView}
            onDeleteView={(id) => void deleteView(id)}
            onSaveView={() => setSaveViewOpen(true)}
            onNewProject={async () => {
              const title = window.prompt('Название нового проекта:', '') || '';
              if (!title.trim()) return;
              const p = await createProject(title.trim());
              if (p && p.boards[0]) setView({ kind: 'board', projectId: p.id, boardId: p.boards[0].id });
            }}
            onRenameProject={(p) => {
              if (!guardEdit(p.id)) return;
              const title = window.prompt('Название проекта:', p.title) || '';
              if (title.trim() && title.trim() !== p.title) void renameProject(p.id, title.trim());
            }}
            onAccessProject={(p) => setAccessProjectId(p.id)}
            onDeleteProject={(p) => {
              if (!window.confirm('Удалить проект «' + p.title + '» с досками и задачами? Отменить нельзя.')) return;
              void deleteProject(p.id);
            }}
          />
        )}

        <section className="tm-main" aria-label="Задачи">
          {phase === 'load' && <div className="tm-loading">Загрузка задач…</div>}
          {phase === 'err' && errMsg !== 'denied' && (
            <div className="tm-loading tm-loading-err">
              {errMsg}
              <button type="button" className="btn" onClick={() => { setPhase('load'); void load(); }}>Повторить</button>
            </div>
          )}
          {phase === 'ok' && ws && nodeFilter && (
            <NodeFilterView
              ws={ws}
              filter={nodeFilter}
              userMap={userMap}
              onClose={() => setNodeFilter(null)}
              onOpen={(t) => setDrawerId(t.id)}
              onGoVetvi={(l) => goVetviNode({ projectId: l.room ? null : l.pid, roomId: l.room || null, nodeId: l.nid })}
            />
          )}
          {phase === 'ok' && ws && !nodeFilter && view.kind === 'my' && (
            <MyView
              ws={ws}
              query={query}
              matchQuery={matchQuery}
              userMap={userMap}
              filtered={filteredByView}
              onOpen={(t) => setDrawerId(t.id)}
              onGoBoard={(projectId, boardId) => setView({ kind: 'board', projectId, boardId })}
              headExtra={(
                <TmFilterButtons
                  badge={badge}
                  sort={sort}
                  onSort={setSort}
                  onFilter={() => setFiltersOpen((v) => !v)}
                  onSaveView={() => setSaveViewOpen(true)}
                />
              )}
            />
          )}
          {phase === 'ok' && ws && !nodeFilter && view.kind === 'user' && (
            <MyView
              ws={ws}
              query={query}
              targetUid={view.userId}
              userMap={userMap}
              matchQuery={matchQuery}
              filtered={filteredByView}
              onOpen={(t) => setDrawerId(t.id)}
              onGoBoard={(projectId, boardId) => setView({ kind: 'board', projectId, boardId })}
              onBackToPeople={() => setView({ kind: 'people' })}
              headExtra={(
                <TmFilterButtons
                  badge={badge}
                  sort={sort}
                  onSort={setSort}
                  onFilter={() => setFiltersOpen((v) => !v)}
                  onSaveView={() => setSaveViewOpen(true)}
                />
              )}
            />
          )}
          {phase === 'ok' && ws && !nodeFilter && view.kind === 'teams' && (
            <TmTeamsView
              ws={ws}
              userMap={userMap}
              me={ws.me}
              onNewTeam={() => setTeamModal({ team: null, mode: null })}
              onEditTeam={(t, mode) => setTeamModal({ team: t, mode: mode ?? null })}
              onDeleteTeam={(t) => {
                if (window.confirm('Удалить команду «' + t.name + '»? Доступ по ней к проектам будет снят.')) void deleteTeam(t.id);
              }}
            />
          )}
          {phase === 'ok' && ws && !nodeFilter && view.kind === 'people' && (
            <TmPeopleView
              ws={ws}
              userMap={userMap}
              onOpenUser={(login) => setView({ kind: 'user', userId: login })}
              onGoBoard={(projectId, boardId) => setView({ kind: 'board', projectId, boardId })}
            />
          )}
          {phase === 'ok' && ws && !nodeFilter && view.kind === 'backlog' && (
            <BacklogView
              ws={ws}
              projectId={view.projectId}
              query={query}
              matchQuery={matchQuery}
              userMap={userMap}
              canEdit={canEdit(view.projectId)}
              filtered={filteredByView}
              labels={ws.labels}
              onOpen={(t) => setDrawerId(t.id)}
              onQuickAdd={async (title) => {
                if (!guardEdit(view.projectId)) return;
                const t = await createTask({ title, projectId: view.projectId });
                if (t) say('Задача добавлена в бэклог');
              }}
              onToBoard={async (t) => {
                if (!guardEdit(t.projectId)) return;
                const p = ws.projects.find((x) => x.id === t.projectId);
                const board = p?.boards[0];
                const col = board?.columns.find((c) => c.kind === 'new') || board?.columns[0];
                if (board && col) await patchTask(t.id, { boardId: board.id, columnId: col.id });
                else say('У проекта нет досок — создайте доску', 'warn');
              }}
              onDropBoard={async (t, boardId) => {
                /* перетянули строку бэклога на доску в сайдбаре (внутри проекта
                   и между проектами): первая системная колонка цели */
                if (!guardEdit(t.projectId)) return;
                const b = ws.projects.flatMap((x) => x.boards).find((x) => x.id === boardId);
                const col = b ? (b.columns.find((c) => c.kind === 'new') || b.columns[0]) : null;
                if (b && col) await patchTask(t.id, { boardId: b.id, columnId: col.id });
                else say('У этого проекта нет досок — задача осталась в бэклоге', 'warn');
              }}
              onDropBacklog={async (t) => {
                if (t.projectId === view.projectId) return; /* уже в этом бэклоге */
                if (!guardEdit(t.projectId)) return;
                await patchTask(t.id, { boardId: null, columnId: null });
              }}
              headExtra={(
                <TmFilterButtons
                  badge={badge}
                  sort={sort}
                  onSort={setSort}
                  onFilter={() => setFiltersOpen((v) => !v)}
                  onSaveView={() => setSaveViewOpen(true)}
                />
              )}
            />
          )}
          {phase === 'ok' && ws && !nodeFilter && view.kind === 'board' && (
            <BoardView
              ws={ws}
              projectId={view.projectId}
              boardId={view.boardId}
              query={query}
              matchQuery={matchQuery}
              userMap={userMap}
              labels={ws.labels}
              canEdit={canEdit(view.projectId)}
              canAdmin={canAdmin(view.projectId)}
              roleLabel={roleOf(ws, view.projectId)}
              filtered={filteredByView}
              onOpen={(t) => setDrawerId(t.id)}
              onMove={async (t, boardId, columnId, order) => {
                if (!guardEdit(t.projectId)) return;
                await patchTask(t.id, { boardId, columnId, ...(typeof order === 'number' ? { order } : {}) });
              }}
              onPickBoard={(boardId) => setView({ kind: 'board', projectId: view.projectId, boardId })}
              onToggleDone={async (t) => {
                if (!guardEdit(t.projectId)) return;
                await toggleDone(t, ws, patchTask);
              }}
              onQuickAdd={async (columnId, title) => {
                if (!guardEdit(view.projectId)) return;
                const t = await createTask({ title, projectId: view.projectId, boardId: view.boardId, columnId });
                if (t) say('Задача создана');
              }}
              onAddColumn={async (title) => {
                if (!guardEdit(view.projectId)) return;
                const c = await createColumn(view.boardId, title);
                if (c) say('Колонка добавлена');
              }}
              onReorderColumns={(boardId, ids) => {
                if (!guardEdit(view.projectId)) return;
                void reorderColumns(boardId, ids);
              }}
              onAddBoard={async () => {
                if (!guardEdit(view.projectId)) return;
                const p = ws.projects.find((x) => x.id === view.projectId);
                const title = window.prompt('Название новой доски:', '') || '';
                if (!title.trim() || !p) return;
                const b = await createBoard(p.id, title.trim());
                if (b) setView({ kind: 'board', projectId: p.id, boardId: b.id });
              }}
              onRenameBoard={(b) => {
                if (!guardEdit(view.projectId)) return;
                const title = window.prompt('Название доски:', b.title) || '';
                if (title.trim() && title.trim() !== b.title) void renameBoard(b.id, title.trim());
              }}
              onAccess={() => setAccessProjectId(view.projectId)}
              headExtra={(
                <TmFilterButtons
                  badge={badge}
                  sort={sort}
                  onSort={setSort}
                  onFilter={() => setFiltersOpen((v) => !v)}
                  onSaveView={() => setSaveViewOpen(true)}
                />
              )}
            />
          )}
        </section>
      </div>

      {/* контекстные меню (ПКМ) и поповер цвета — один хост на приложение */}
      {ws && (
        <TmMenuHost
          ws={ws}
          act={menuAct}
          canEdit={canEdit}
          canAdmin={canAdmin}
        />
      )}

      {/* попап фильтров — поверх интерфейса, позиция у кнопки-воронки */}
      {ws && filtersOpen && (
        <TmFilterPop
          filters={filters}
          ws={ws}
          userMap={userMap}
          onClose={() => setFiltersOpen(false)}
          onChange={(f) => { setFilters(f); setSavedId(null); }}
        />
      )}

      {ws && drawerId && (() => {
        const dt = ws.tasks.find((x) => x.id === drawerId);
        return (
          <TmDrawer
            key={drawerId}
            ws={ws}
            users={users}
            userMap={userMap}
            taskId={drawerId}
            canEdit={!!dt && canEdit(dt.projectId)}
            mode={drawerMode}
            onMode={handleDrawerMode}
            onClose={() => setDrawerId(null)}
            onPatch={patchTask}
            onDelete={deleteTask}
            onDuplicate={duplicateTask}
            onSendComment={sendComment}
            onPatchComment={patchComment}
            onDeleteComment={deleteComment}
            onAttachNodes={goAttachNodes}
            onCreateLabel={createLabel}
            onDeleteLabel={deleteLabel}
            onCreateChild={async (parentId, title) => {
              const parent = ws.tasks.find((t) => t.id === parentId);
              if (!parent || !guardEdit(parent.projectId)) return;
              const t = await createTask({
                title,
                projectId: parent.projectId,
                boardId: parent.boardId,
                columnId: parent.columnId,
                parentId,
              });
              if (t) say('Подзадача создана');
            }}
            say={say}
          />
        );
      })()}

      {ws && createOpen && (
        <TmCreateModal
          ws={ws}
          preset={createPreset}
          onClose={() => { setCreateOpen(false); setCreatePreset(null); }}
          onCreate={async (payload) => {
            const t = await createTask(payload);
            if (t) {
              say('Задача создана');
              setCreateOpen(false);
              setCreatePreset(null);
              setDrawerId(t.id);
            }
          }}
          onCreateProject={createProject}
        />
      )}

      {ws && accessProjectId && (
        <TmAccessModal
          ws={ws}
          projectId={accessProjectId}
          users={users}
          canAdmin={canAdmin(accessProjectId)}
          onClose={() => setAccessProjectId(null)}
          onSave={saveAccess}
        />
      )}

      {ws && teamModal && (
        <TmTeamModal
          ws={ws}
          users={users}
          team={teamModal.team}
          mode={teamModal.mode ?? null}
          onClose={() => setTeamModal(null)}
          onSave={saveTeam}
          onDelete={(t) => {
            if (window.confirm('Удалить команду «' + t.name + '»? Доступ по ней к проектам будет снят.')) {
              void deleteTeam(t.id);
              setTeamModal(null);
            }
          }}
        />
      )}

      {ws && saveViewOpen && (
        <TmSaveViewModal
          filters={filters}
          sort={sort}
          view={view}
          ws={ws}
          onClose={() => setSaveViewOpen(false)}
          onSave={async (name) => {
            const ok = await saveView(name);
            if (ok) setSaveViewOpen(false);
          }}
        />
      )}

      {toast && <div className={'tm-toast ' + toast.tone} role="status">{toast.text}</div>}
    </main>
  );
}

/* кнопки фильтра/сортировки/сохранения вида (в шапке представления) */
function TmFilterButtons(props: {
  badge: number;
  sort: string;
  onSort: (s: string) => void;
  onFilter: () => void;
  onSaveView: () => void;
}) {
  return (
    <>
      <button
        type="button"
        className={'tm-ibtn' + (props.badge ? ' on' : '')}
        title="Фильтры"
        aria-label="Фильтры"
        onClick={props.onFilter}
      >
        <svg viewBox="0 0 24 24" width={15} height={15} fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 5h18l-7 8v4.5L10 20v-7z" /></svg>
        {props.badge > 0 && <span className="tm-fbadge">{props.badge}</span>}
      </button>
      <select
        className="tm-sortsel"
        value={props.sort}
        aria-label="Сортировка"
        onChange={(e) => props.onSort(e.target.value)}
      >
        <option value="manual">Вручную</option>
        <option value="due">По дедлайну</option>
        <option value="priority">По приоритету</option>
        <option value="title">По названию</option>
        <option value="created">По дате создания</option>
      </select>
      <button type="button" className="tm-ibtn" title="Сохранить текущий вид" aria-label="Сохранить вид" onClick={props.onSaveView}>
        <svg viewBox="0 0 24 24" width={15} height={15} fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M19 21l-7-4.5L5 21V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" /></svg>
      </button>
    </>
  );
}

/* очистка интеграционных параметров хеша (после разбора mk/nf/ot) */
function cleanHash(): void {
  try { window.history.replaceState(null, '', window.location.pathname + window.location.search + '#service=task-manager'); } catch { /* нет history */ }
}

/* ═══ перевод задачи в выполненные/обратно (семантика системных колонок) ═══ */

async function toggleDone(
  t: TmTask,
  ws: Ws,
  patchTask: (id: string, patch: Record<string, unknown>) => Promise<boolean>,
): Promise<void> {
  if (!t.done) {
    /* выполнить: в «Выполнено» доски (или прямым флагом для бэклога) */
    const p = ws.projects.find((x) => x.id === t.projectId);
    const board = p?.boards.find((b) => b.id === t.boardId);
    const doneCol = board?.columns.find((c) => c.kind === 'done');
    if (board && doneCol) await patchTask(t.id, { boardId: board.id, columnId: doneCol.id });
    else await patchTask(t.id, { done: true });
    return;
  }
  /* вернуть в работу: «В работе» при исполнителях, иначе «Не взяты»; бэклог — флагом */
  const p = ws.projects.find((x) => x.id === t.projectId);
  const board = p?.boards.find((b) => b.id === t.boardId);
  const hasAssignees = t.stickers.assignees.length > 0;
  const target = board?.columns.find((c) => c.kind === (hasAssignees ? 'progress' : 'new'));
  if (board && target) await patchTask(t.id, { boardId: board.id, columnId: target.id });
  else await patchTask(t.id, { done: false });
}

type TmBoardType = import('./tmTypes').TmBoard;
type TmColumnType = import('./tmTypes').TmColumn;
