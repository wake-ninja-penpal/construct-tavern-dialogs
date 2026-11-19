'use client';

/**
 * Менеджер задач — приложение хаба сервисов (сервис task-manager).
 *
 * Порт прототипа «Поток · командные доски» в дизайн-систему «Ветвей»:
 * канбан-доски проектов (системные колонки Не взяты / В работе / Выполнено —
 * позиция в колонках и есть статус), бэклог, «Мои задачи», дровер задачи
 * со стикерами (исполнители/приоритет/дедлайн), подзадачи и СВЯЗИ с нодами
 * «Ветвей» (прямые ссылки: задача ↔ нода, в обе стороны).
 *
 * Данные — общие для всей команды (единый аккаунт хаба), хранятся в БД хаба
 * (TaskProject/TaskBoard/TaskColumn/TaskItem через /api/tm/*). Сервер
 * проверяет доступ к сервису на каждом запросе: при закрытом доступе
 * изменения не сохраняются (403 → экран «нет доступа»).
 *
 * Интеграция с «Ветвями»:
 *  - хеш #service=task-manager&mk=1&p=<pid>&r=<rid>&n=<ids>&t=<titles> —
 *    «Ветви» прислали ноды: открывается окно новой задачи с готовыми связями;
 *  - хеш #service=task-manager&nf=<pid>&nn=<nid>&nt=<title> — переход к задачам
 *    конкретной ноды (клик по иконке задач над нодой в «Ветвях»);
 *  - чипы связей в карточке/дровере возвращают в «Ветви» к ноде
 *    (#project=<id>&room=<rid>&node=<nid>).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { parseHash, goVetviNode } from '../hub';
import { ServiceSwitcher } from '../ServiceSwitcher';
import { ServiceIcon } from '../ServiceIcon';
import { AccountChip } from '../ServiceScreen';
import { BoardView, BacklogView, MyView, NodeFilterView, TmSidebar } from './TaskViews';
import { TmDrawer, TmCreateModal } from './TaskDrawer';
import { parseLinks, parseStickers, type TmBoard, type TmColumn, type TmLink, type TmProject, type TmTask } from './tmTypes';

interface TmUser { login: string; displayName: string | null }

interface Ws {
  projects: TmProject[];
  tasks: TmTask[];
  me: { login: string; displayName: string; color: string };
}

export type { TmUser, Ws };

type View = { kind: 'my' } | { kind: 'board'; projectId: string; boardId: string } | { kind: 'backlog'; projectId: string };

/* ── API-обёртка: 403 = сервис закрыт (нужно показать «нет доступа») ── */

class TmDenied extends Error {}

async function tmFetch(url: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(url, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) },
    cache: 'no-store',
  });
  if (res.status === 403) throw new TmDenied('service');
  return res;
}

async function tmJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await tmFetch(url, init);
  const j = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(j.error || 'Ошибка сервера');
  return j;
}

/* ═══ корневой компонент ═══ */

export function TaskManagerApp({ svcKey }: { svcKey: string }) {
  const [ws, setWs] = useState<Ws | null>(null);
  const [phase, setPhase] = useState<'load' | 'ok' | 'err'>('load');
  const [errMsg, setErrMsg] = useState('');
  const [users, setUsers] = useState<TmUser[]>([]);
  const [view, setView] = useState<View>({ kind: 'my' });
  const [query, setQuery] = useState('');
  const [drawerId, setDrawerId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [createPreset, setCreatePreset] = useState<TmLink[] | null>(null);
  const [nodeFilter, setNodeFilter] = useState<{ pid: string; nid: string; title: string } | null>(null);
  const [toast, setToast] = useState<{ text: string; tone: 'ok' | 'warn' | 'err' } | null>(null);
  const toastT = useRef<ReturnType<typeof setTimeout> | null>(null);

  const say = useCallback((text: string, tone: 'ok' | 'warn' | 'err' = 'ok') => {
    if (toastT.current) clearTimeout(toastT.current);
    setToast({ text, tone });
    toastT.current = setTimeout(() => setToast(null), 3200);
  }, []);

  /* ── загрузка пространства ── */
  const load = useCallback(async () => {
    try {
      const j = await tmJson<{ projects: TmProject[]; tasks: TmTask[]; me: Ws['me'] }>('/api/tm');
      setWs({
        projects: j.projects || [],
        /* стикеры/связи приходят JSON-строками — разворачиваем в объекты */
        tasks: (j.tasks || []).map((t) => ({ ...t, stickers: parseStickers(t.stickers as unknown as string), links: parseLinks(t.links as unknown as string) })),
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
         nf/nn — фильтр задач ноды. После разбора хеш чистится
         (replaceState — без повторного срабатывания hashchange). */
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
      }
    })();
    return () => { alive = false; };
  }, [load, loadUsers]);

  /* ── мутации ── */

  const createTask = useCallback(async (payload: Record<string, unknown>): Promise<TmTask | null> => {
    try {
      const j = await tmJson<{ item: TmTask }>('/api/tm', { method: 'POST', body: JSON.stringify(payload) });
      setWs((w) => (w ? { ...w, tasks: [...w.tasks, { ...j.item, stickers: parseStickers(j.item.stickers as unknown as string), links: parseLinks(j.item.links as unknown as string) }] } : w));
      return j.item;
    } catch (e) {
      if (e instanceof TmDenied) { setPhase('err'); setErrMsg('denied'); return null; }
      say(e instanceof Error ? e.message : 'Не удалось создать задачу', 'err');
      return null;
    }
  }, [say]);

  /** Дублировать задачу: та же колонка/стикеры/связи, копия ставится рядом. */
  const duplicateTask = useCallback(async (src: TmTask): Promise<void> => {
    const created = await createTask({
      title: src.title + ' (копия)',
      projectId: src.projectId,
      boardId: src.boardId,
      columnId: src.columnId,
      description: src.description,
      stickers: { ...src.stickers },
      links: (src.links || []).map((l) => ({ ...l })),
    });
    if (created) {
      say('Задача продублирована');
      setDrawerId(created.id);
    }
  }, [createTask, say]);

  const patchTask = useCallback(async (id: string, patch: Record<string, unknown>): Promise<boolean> => {
    try {
      const j = await tmJson<{ item: TmTask }>('/api/tm/tasks/' + id, { method: 'PATCH', body: JSON.stringify(patch) });
      setWs((w) => (w ? {
        ...w,
        tasks: w.tasks.map((t) => (t.id === id ? { ...j.item, stickers: parseStickers(j.item.stickers as unknown as string), links: parseLinks(j.item.links as unknown as string) } : t)),
      } : w));
      return true;
    } catch (e) {
      if (e instanceof TmDenied) { setPhase('err'); setErrMsg('denied'); return false; }
      say(e instanceof Error ? e.message : 'Не удалось сохранить задачу', 'err');
      return false;
    }
  }, [say]);

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
      if (e instanceof TmDenied) { setPhase('err'); setErrMsg('denied'); return false; }
      say(e instanceof Error ? e.message : 'Не удалось удалить задачу', 'err');
      return false;
    }
  }, [say]);

  const createProject = useCallback(async (title: string): Promise<TmProject | null> => {
    try {
      const j = await tmJson<{ item: TmProject }>('/api/tm/projects', { method: 'POST', body: JSON.stringify({ title }) });
      setWs((w) => (w ? { ...w, projects: [...w.projects, j.item] } : w));
      say('Проект создан');
      return j.item;
    } catch (e) {
      if (e instanceof TmDenied) { setPhase('err'); setErrMsg('denied'); return null; }
      say(e instanceof Error ? e.message : 'Не удалось создать проект', 'err');
      return null;
    }
  }, [say]);

  const createBoard = useCallback(async (projectId: string, title: string): Promise<TmBoard | null> => {
    try {
      const j = await tmJson<{ item: TmBoard }>('/api/tm/boards', { method: 'POST', body: JSON.stringify({ projectId, title }) });
      setWs((w) => (w ? {
        ...w,
        projects: w.projects.map((p) => (p.id === projectId ? { ...p, boards: [...p.boards, j.item] } : p)),
      } : w));
      return j.item;
    } catch (e) {
      if (e instanceof TmDenied) { setPhase('err'); setErrMsg('denied'); return null; }
      say(e instanceof Error ? e.message : 'Не удалось создать доску', 'err');
      return null;
    }
  }, [say]);

  const createColumn = useCallback(async (boardId: string, title: string): Promise<TmColumn | null> => {
    try {
      const j = await tmJson<{ item: TmColumn }>('/api/tm/columns', { method: 'POST', body: JSON.stringify({ boardId, title }) });
      setWs((w) => (w ? {
        ...w,
        projects: w.projects.map((p) => ({
          ...p,
          boards: p.boards.map((b) => (b.id === boardId ? { ...b, columns: [...b.columns, j.item] } : b)),
        })),
      } : w));
      return j.item;
    } catch (e) {
      if (e instanceof TmDenied) { setPhase('err'); setErrMsg('denied'); return null; }
      say(e instanceof Error ? e.message : 'Не удалось создать колонку', 'err');
      return null;
    }
  }, [say]);

  const renameProject = useCallback(async (id: string, title: string) => {
    try {
      const j = await tmJson<{ item: TmProject }>('/api/tm/projects/' + id, { method: 'PATCH', body: JSON.stringify({ title }) });
      setWs((w) => (w ? { ...w, projects: w.projects.map((p) => (p.id === id ? { ...p, title: j.item.title } : p)) } : w));
    } catch (e) {
      if (e instanceof TmDenied) { setPhase('err'); setErrMsg('denied'); return; }
      say(e instanceof Error ? e.message : 'Не удалось переименовать', 'err');
    }
  }, [say]);

  const deleteProject = useCallback(async (id: string) => {
    try {
      await tmJson('/api/tm/projects/' + id, { method: 'DELETE' });
      setWs((w) => (w ? { ...w, projects: w.projects.filter((p) => p.id !== id), tasks: w.tasks.filter((t) => t.projectId !== id) } : w));
      setView((v) => (v.kind !== 'my' && v.projectId === id ? { kind: 'my' } : v));
      say('Проект удалён');
    } catch (e) {
      if (e instanceof TmDenied) { setPhase('err'); setErrMsg('denied'); return; }
      say(e instanceof Error ? e.message : 'Не удалось удалить проект', 'err');
    }
  }, [say]);

  const renameBoard = useCallback(async (id: string, title: string) => {
    try {
      const j = await tmJson<{ item: TmBoard }>('/api/tm/boards/' + id, { method: 'PATCH', body: JSON.stringify({ title }) });
      setWs((w) => (w ? {
        ...w,
        projects: w.projects.map((p) => ({ ...p, boards: p.boards.map((b) => (b.id === id ? { ...b, title: j.item.title } : b)) })),
      } : w));
    } catch (e) {
      if (e instanceof TmDenied) { setPhase('err'); setErrMsg('denied'); return; }
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
      setView((v) => (v.kind === 'board' && v.boardId === id ? { kind: 'backlog', projectId: (v as { projectId: string }).projectId } : v));
      say('Доска удалена — задачи в бэклоге');
    } catch (e) {
      if (e instanceof TmDenied) { setPhase('err'); setErrMsg('denied'); return; }
      say(e instanceof Error ? e.message : 'Не удалось удалить доску', 'err');
    }
  }, [say]);

  const renameColumn = useCallback(async (id: string, title: string) => {
    try {
      const j = await tmJson<{ item: TmColumn }>('/api/tm/columns/' + id, { method: 'PATCH', body: JSON.stringify({ title }) });
      setWs((w) => (w ? {
        ...w,
        projects: w.projects.map((p) => ({
          ...p,
          boards: p.boards.map((b) => ({ ...b, columns: b.columns.map((c) => (c.id === id ? j.item : c)) })),
        })),
      } : w));
    } catch (e) {
      if (e instanceof TmDenied) { setPhase('err'); setErrMsg('denied'); return; }
      say(e instanceof Error ? e.message : 'Не удалось переименовать колонку', 'err');
    }
  }, [say]);

  const deleteColumn = useCallback(async (id: string) => {
    try {
      await tmJson('/api/tm/columns/' + id, { method: 'DELETE' });
      setWs((w) => {
        if (!w) return w;
        return {
          ...w,
          projects: w.projects.map((p) => ({ ...p, boards: p.boards.map((b) => ({ ...b, columns: b.columns.filter((c) => c.id !== id) })) })),
          tasks: w.tasks.map((t) => (t.columnId === id ? { ...t, boardId: null, columnId: null } : t)),
        };
      });
      say('Колонка удалена — задачи в бэклоге');
    } catch (e) {
      if (e instanceof TmDenied) { setPhase('err'); setErrMsg('denied'); return; }
      say(e instanceof Error ? e.message : 'Не удалось удалить колонку', 'err');
    }
  }, [say]);

  /* ── готовые данные для представлений ── */
  const userMap = useMemo(() => {
    const m = new Map<string, TmUser>();
    for (const u of users) m.set(u.login, u);
    return m;
  }, [users]);

  const matchQuery = useCallback((t: TmTask, q: string): boolean => {
    if (!q) return true;
    const s = q.toLowerCase();
    return t.title.toLowerCase().includes(s) || (t.description || '').toLowerCase().includes(s);
  }, []);

  const myTasks = useMemo(() => {
    if (!ws) return [];
    return ws.tasks.filter((t) => t.stickers && t.stickers.assignees.includes(ws.me.login) && !t.done);
  }, [ws]);

  /* ═══ рендер ═══ */

  if (phase === 'err' && errMsg === 'denied') {
    /* доступ к сервису закрыт на сервере — экран «нет доступа» рисует родитель,
       здесь же страховка: если вдруг отрисованы мы, даём выход в «Ветви» */
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
          <button
            type="button"
            className="btn primary tm-new"
            onClick={() => { setCreatePreset(null); setCreateOpen(true); }}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
            Задача
          </button>
          <AccountChip />
        </div>
      </header>

      <div className="tm-layout">
        {ws && (
          <TmSidebar
            ws={ws}
            view={view}
            myCount={myTasks.length}
            onMy={() => { setView({ kind: 'my' }); setNodeFilter(null); }}
            onBoard={(projectId, boardId) => { setView({ kind: 'board', projectId, boardId }); setNodeFilter(null); }}
            onBacklog={(projectId) => { setView({ kind: 'backlog', projectId }); setNodeFilter(null); }}
            onNewProject={async () => {
              const title = window.prompt('Название нового проекта:', '') || '';
              if (!title.trim()) return;
              const p = await createProject(title.trim());
              if (p && p.boards[0]) setView({ kind: 'board', projectId: p.id, boardId: p.boards[0].id });
            }}
            onRenameProject={(p) => {
              const title = window.prompt('Название проекта:', p.title) || '';
              if (title.trim() && title.trim() !== p.title) void renameProject(p.id, title.trim());
            }}
            onDeleteProject={(p) => {
              if (window.confirm('Удалить проект «' + p.title + '» с досками и задачами? Отменить нельзя.')) void deleteProject(p.id);
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
              onOpen={(t) => setDrawerId(t.id)}
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
              onOpen={(t) => setDrawerId(t.id)}
              onQuickAdd={async (title) => {
                const t = await createTask({ title, projectId: view.projectId });
                if (t) say('Задача добавлена в бэклог');
              }}
              onToBoard={async (t) => {
                const p = ws.projects.find((x) => x.id === t.projectId);
                const board = p?.boards[0];
                const col = board?.columns.find((c) => c.kind === 'new') || board?.columns[0];
                if (board && col) await patchTask(t.id, { boardId: board.id, columnId: col.id });
                else say('У проекта нет досок — создайте доску', 'warn');
              }}
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
              onOpen={(t) => setDrawerId(t.id)}
              onMove={async (t, boardId, columnId) => { await patchTask(t.id, { boardId, columnId }); }}
              onPickBoard={(boardId) => setView({ kind: 'board', projectId: view.projectId, boardId })}
              onToggleDone={async (t) => { await toggleDone(t, ws, patchTask); }}
              onQuickAdd={async (columnId, title) => {
                const t = await createTask({ title, projectId: view.projectId, boardId: view.boardId, columnId });
                if (t) say('Задача создана');
              }}
              onAddColumn={async (title) => {
                const c = await createColumn(view.boardId, title);
                if (c) say('Колонка добавлена');
              }}
              onRenameColumn={(c) => {
                const title = window.prompt('Название колонки:', c.title) || '';
                if (title.trim() && title.trim() !== c.title) void renameColumn(c.id, title.trim());
              }}
              onDeleteColumn={(c) => {
                if (window.confirm('Удалить колонку «' + c.title + '»? Задачи уйдут в бэклог.')) void deleteColumn(c.id);
              }}
              onAddBoard={async () => {
                const p = ws.projects.find((x) => x.id === view.projectId);
                const title = window.prompt('Название новой доски:', '') || '';
                if (!title.trim() || !p) return;
                const b = await createBoard(p.id, title.trim());
                if (b) setView({ kind: 'board', projectId: p.id, boardId: b.id });
              }}
              onRenameBoard={(b) => {
                const title = window.prompt('Название доски:', b.title) || '';
                if (title.trim() && title.trim() !== b.title) void renameBoard(b.id, title.trim());
              }}
              onDeleteBoard={(b) => {
                if (window.confirm('Удалить доску «' + b.title + '»? Задачи уйдут в бэклог проекта.')) void deleteBoard(b.id);
              }}
            />
          )}
        </section>
      </div>

      {ws && drawerId && (
        <TmDrawer
          key={drawerId}
          ws={ws}
          users={users}
          userMap={userMap}
          taskId={drawerId}
          onClose={() => setDrawerId(null)}
          onPatch={patchTask}
          onDelete={deleteTask}
          onDuplicate={duplicateTask}
          onCreateChild={async (parentId, title) => {
            const parent = ws.tasks.find((t) => t.id === parentId);
            if (!parent) return;
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
      )}

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

      {toast && <div className={'tm-toast ' + toast.tone} role="status">{toast.text}</div>}
    </main>
  );
}

/* очистка интеграционных параметров хеша (после разбора mk/nf) */
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
