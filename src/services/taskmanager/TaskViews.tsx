'use client';

/**
 * Менеджер задач — представления и компоненты интерфейса:
 * сайдбар (мои задачи/проекты/доски/бэклог), канбан-доска с drag&drop,
 * бэклог, «Мои задачи», фильтр задач ноды «Ветвей», дровер задачи
 * (стикеры, подзадачи, связи) и окно создания задачи.
 */

import { useEffect, useMemo, useRef, useState } from 'react';

import { childrenOf, firstName, fmtDeadline, initialsOf, parseLinks, parseStickers, TM_KIND_COLOR, TM_PRIO, userColor, type TmColumn, type TmLink, type TmProject, type TmTask } from './tmTypes';
import type { TmUser, Ws } from './TaskManagerApp';

type UserMap = Map<string, TmUser>;

/* ═══ сайдбар ═══ */

export function TmSidebar(props: {
  ws: Ws;
  view: { kind: string; projectId?: string; boardId?: string };
  myCount: number;
  onMy: () => void;
  onBoard: (projectId: string, boardId: string) => void;
  onBacklog: (projectId: string) => void;
  onNewProject: () => void;
  onRenameProject: (p: TmProject) => void;
  onDeleteProject: (p: TmProject) => void;
}) {
  const { ws, view } = props;
  return (
    <aside className="tm-side" aria-label="Разделы менеджера задач">
      <nav className="tm-nav" role="navigation">
        <button
          type="button"
          className={'tm-nav-row' + (view.kind === 'my' ? ' cur' : '')}
          onClick={props.onMy}
          title="Задачи, где вы исполнитель"
        >
          <span className="tm-nav-ico">
            <svg viewBox="0 0 24 24" width={15} height={15} fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M4.5 6.5 6 8l2.5-2.8M4.5 12.5 6 14l2.5-2.8M4.5 18.5 6 20l2.5-2.8M11.5 7h8M11.5 13h8M11.5 19h8" />
            </svg>
          </span>
          <span className="tm-nav-t">Мои задачи</span>
          {props.myCount > 0 && <span className="tm-nav-cnt">{props.myCount}</span>}
        </button>

        <div className="tm-nav-cap">
          <span>Проекты</span>
          <button type="button" className="tm-nav-plus" title="Новый проект" onClick={props.onNewProject}>+</button>
        </div>
        {ws.projects.length === 0 && (
          <div className="tm-side-empty">Проектов пока нет — создайте первый</div>
        )}
        {ws.projects.map((p) => (
          <div className="tm-proj" key={p.id}>
            <div className="tm-proj-head">
              <span className="tm-proj-dot" style={{ background: p.color }} />
              <button
                type="button"
                className="tm-proj-name"
                title={p.title + ' — двойной клик: переименовать'}
                onDoubleClick={() => props.onRenameProject(p)}
              >
                {p.title}
              </button>
              <span className="tm-proj-acts">
                <button type="button" className="tm-mini" title="Переименовать" onClick={() => props.onRenameProject(p)}>
                  <svg viewBox="0 0 24 24" width={11} height={11} fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true"><path d="M4 20l4-1L20 7l-3-3L5 16z" /></svg>
                </button>
                {p.id !== 'vetvi-protected' && (
                  <button type="button" className="tm-mini danger" title="Удалить проект" onClick={() => props.onDeleteProject(p)}>
                    <svg viewBox="0 0 24 24" width={11} height={11} fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
                  </button>
                )}
              </span>
            </div>
            <div className="tm-proj-boards">
              {p.boards.map((b) => {
                const active = view.kind === 'board' && view.projectId === p.id && view.boardId === b.id;
                const undone = ws.tasks.filter((t) => t.boardId === b.id && !t.done).length;
                return (
                  <button
                    key={b.id}
                    type="button"
                    className={'tm-nav-row sub' + (active ? ' cur' : '')}
                    onClick={() => props.onBoard(p.id, b.id)}
                  >
                    <span className="tm-nav-ico board">
                      <svg viewBox="0 0 24 24" width={13} height={13} fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><rect x="4" y="4" width="6.5" height="16" rx="1.6" /><rect x="13.5" y="4" width="6.5" height="10" rx="1.6" /></svg>
                    </span>
                    <span className="tm-nav-t">{b.title}</span>
                    {undone > 0 && <span className="tm-nav-cnt">{undone}</span>}
                  </button>
                );
              })}
              <button
                type="button"
                className={'tm-nav-row sub' + (view.kind === 'backlog' && view.projectId === p.id ? ' cur' : '')}
                onClick={() => props.onBacklog(p.id)}
              >
                <span className="tm-nav-ico board">
                  <svg viewBox="0 0 24 24" width={13} height={13} fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true"><path d="M4 7h16M4 12h10M4 17h7" /></svg>
                </span>
                <span className="tm-nav-t">Бэклог</span>
                <span className="tm-nav-cnt">{ws.tasks.filter((t) => t.projectId === p.id && !t.columnId && !t.done).length}</span>
              </button>
            </div>
          </div>
        ))}
      </nav>
      <div className="tm-side-foot">
        <span>Общее пространство команды</span>
      </div>
    </aside>
  );
}

/* ═══ шапка представления (иконка/заголовок/подзаголовок) ═══ */

export function TmViewHead(props: { title: string; sub?: string; children?: React.ReactNode }) {
  return (
    <div className="tm-vhead">
      <div className="tm-vhead-txt">
        <h2>{props.title}</h2>
        {props.sub && <p>{props.sub}</p>}
      </div>
      <div className="tm-vhead-acts">{props.children}</div>
    </div>
  );
}

/* ═══ канбан-доска ═══ */

let dragTaskId: string | null = null;

export function BoardView(props: {
  ws: Ws;
  projectId: string;
  boardId: string;
  query: string;
  matchQuery: (t: TmTask, q: string) => boolean;
  userMap: UserMap;
  onOpen: (t: TmTask) => void;
  onMove: (t: TmTask, boardId: string, columnId: string) => void;
  onPickBoard: (boardId: string) => void;
  onToggleDone: (t: TmTask) => void;
  onQuickAdd: (columnId: string, title: string) => void;
  onAddColumn: (title: string) => void;
  onRenameColumn: (c: TmColumn) => void;
  onDeleteColumn: (c: TmColumn) => void;
  onAddBoard: () => void;
  onRenameBoard: (b: { id: string; title: string }) => void;
  onDeleteBoard: (b: { id: string; title: string }) => void;
}) {
  const { ws } = props;
  const project = ws.projects.find((p) => p.id === props.projectId);
  const board = project?.boards.find((b) => b.id === props.boardId);
  const [overCol, setOverCol] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  if (!project || !board) {
    return <div className="tm-loading">Доска не найдена</div>;
  }

  const columnTasks = (colId: string): TmTask[] =>
    ws.tasks
      .filter((t) => t.columnId === colId && !t.parentId && props.matchQuery(t, props.query))
      .sort((a, b) => a.order - b.order);

  return (
    <div className="tm-boardwrap">
      <TmViewHead
        title={project.title}
        sub={board.title + ' · ' + board.columns.length + ' колонок · перетащите карточку между колонками'}
      >
        <div className="tm-tabs" role="tablist" aria-label="Доски проекта">
          {project.boards.map((b) => (
            <button
              key={b.id}
              type="button"
              role="tab"
              aria-selected={b.id === board.id}
              className={'tm-tab' + (b.id === board.id ? ' cur' : '')}
              onDoubleClick={() => props.onRenameBoard(b)}
              onClick={() => { if (b.id !== board.id) props.onPickBoard(b.id); }}
              title={b.title + ' — двойной клик: переименовать'}
            >
              {b.title}
            </button>
          ))}
          <button type="button" className="tm-tab add" title="Новая доска" onClick={props.onAddBoard}>+ доска</button>
        </div>
        <button type="button" className="btn danger tm-viewdel" title="Удалить доску" onClick={() => props.onDeleteBoard(board)}>Удалить доску</button>
      </TmViewHead>

      <div className={'tm-kanban' + (dragging ? ' dragging' : '')}>
        {board.columns.map((col) => {
          const tasks = columnTasks(col.id);
          return (
            <section
              key={col.id}
              className={'tm-kcol' + (overCol === col.id ? ' over' : '')}
              onDragOver={(e) => { e.preventDefault(); setOverCol(col.id); }}
              onDragLeave={() => setOverCol((c) => (c === col.id ? null : c))}
              onDrop={(e) => {
                e.preventDefault();
                setOverCol(null);
                setDragging(false);
                const id = dragTaskId || e.dataTransfer.getData('text/plain');
                dragTaskId = null;
                if (!id) return;
                const t = ws.tasks.find((x) => x.id === id);
                if (t) props.onMove(t, board.id, col.id);
              }}
              aria-label={'Колонка ' + col.title}
            >
              <header className="tm-kcol-head" style={{ '--cc': col.color } as React.CSSProperties}>
                <span className="tm-kcol-dot" style={{ background: col.color }} />
                <span className="tm-kcol-title">{col.title}{col.locked && <i title="Системная колонка — задаёт статус задач">🔒</i>}</span>
                <span className="tm-kcol-cnt">{tasks.filter((t) => !t.done).length}</span>
                {!col.locked && (
                  <span className="tm-kcol-menu">
                    <button type="button" className="tm-mini" title="Переименовать" onClick={() => props.onRenameColumn(col)}>
                      <svg viewBox="0 0 24 24" width={11} height={11} fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true"><path d="M4 20l4-1L20 7l-3-3L5 16z" /></svg>
                    </button>
                    <button type="button" className="tm-mini danger" title="Удалить колонку" onClick={() => props.onDeleteColumn(col)}>
                      <svg viewBox="0 0 24 24" width={11} height={11} fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
                    </button>
                  </span>
                )}
              </header>
              <div className="tm-kcol-body">
                {tasks.map((t) => (
                  <TaskCard
                    key={t.id}
                    task={t}
                    ws={ws}
                    userMap={props.userMap}
                    onOpen={props.onOpen}
                    onToggleDone={props.onToggleDone}
                    draggable
                    onDragStart={() => { dragTaskId = t.id; setDragging(true); }}
                    onDragEnd={() => { dragTaskId = null; setDragging(false); }}
                  />
                ))}
                {tasks.length === 0 && <div className="tm-kcol-empty">Пусто</div>}
              </div>
              <footer className="tm-kcol-add">
                <input
                  placeholder="+ задача (Enter)"
                  aria-label={'Новая задача в колонку ' + col.title}
                  onKeyDown={(e) => {
                    if (e.key !== 'Enter') return;
                    const v = (e.target as HTMLInputElement).value.trim();
                    if (!v) return;
                    (e.target as HTMLInputElement).value = '';
                    props.onQuickAdd(col.id, v);
                  }}
                />
              </footer>
            </section>
          );
        })}
        <div className="tm-kcol-addcol">
          <input
            placeholder="+ колонка (Enter)"
            aria-label="Новая колонка"
            onKeyDown={(e) => {
              if (e.key !== 'Enter') return;
              const v = (e.target as HTMLInputElement).value.trim();
              if (!v) return;
              (e.target as HTMLInputElement).value = '';
              props.onAddColumn(v);
            }}
          />
        </div>
      </div>
    </div>
  );
}

/* ═══ карточка задачи (канбан) ═══ */

export function TaskCard(props: {
  task: TmTask;
  ws: Ws;
  userMap: UserMap;
  onOpen: (t: TmTask) => void;
  onToggleDone: (t: TmTask) => void;
  draggable?: boolean;
  onDragStart?: () => void;
  onDragEnd?: () => void;
}) {
  const t = props.task;
  const st = t.stickers;
  const kids = childrenOf(props.ws, t.id);
  const kidsDone = kids.filter((k) => k.done).length;
  const prio = st.priority ? TM_PRIO[st.priority] : null;
  const links = t.links || [];
  return (
    <article
      className={'tm-card' + (t.done ? ' done' : '')}
      draggable={!!props.draggable}
      onDragStart={(e) => { e.dataTransfer.setData('text/plain', t.id); e.dataTransfer.effectAllowed = 'move'; props.onDragStart?.(); }}
      onDragEnd={() => props.onDragEnd?.()}
      onClick={() => props.onOpen(t)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); props.onOpen(t); } }}
    >
      {t.parentId && <span className="tm-child-tag" title="Подзадача">↳ подзадача</span>}
      <div className="tm-card-top">
        <button
          type="button"
          className={'tm-donechk' + (t.done ? ' on' : '')}
          style={{ borderColor: prio?.color || 'var(--line2)' }}
          title={t.done ? 'Вернуть в работу' : 'Выполнить'}
          aria-label={t.done ? 'Вернуть в работу' : 'Выполнить'}
          onClick={(e) => { e.stopPropagation(); props.onToggleDone(t); }}
        >
          {t.done && (
            <svg viewBox="0 0 24 24" width={11} height={11} fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m5 13 4 4L19 7" /></svg>
          )}
        </button>
        <span className="tm-card-title">{t.title}</span>
      </div>
      {t.description && <p className="tm-card-desc">{t.description.slice(0, 132)}</p>}
      {(prio || st.deadline || kids.length > 0 || st.assignees.length > 0 || links.length > 0) && (
        <div className="tm-card-chips">
          {prio && <span className="tm-chip prio" style={{ color: prio.color, borderColor: prio.color }}>{prio.label}</span>}
          {st.deadline && (() => { const d = fmtDeadline(st.deadline); return <span className={'tm-chip dl ' + d.tone}>{d.text}</span>; })()}
          {kids.length > 0 && (
            <span className={'tm-chip kids' + (kidsDone === kids.length ? ' all' : '')}>
              {kidsDone}/{kids.length}
            </span>
          )}
          {links.length > 0 && (
            <span className="tm-chip vetvi" title={'Связана с «Ветвями»: ' + links.map((l) => l.t || l.nid).join(', ')}>
              <VetviMark /> {links.length}
            </span>
          )}
          <span className="tm-card-avs">
            {st.assignees.slice(0, 3).map((login) => (
              <span key={login} className="tm-av" title={firstName(props.userMap.get(login)?.displayName, login)} style={{ background: userColor(login) }}>
                {initialsOf(props.userMap.get(login)?.displayName, login)}
              </span>
            ))}
            {st.assignees.length > 3 && <span className="tm-av more">+{st.assignees.length - 3}</span>}
          </span>
        </div>
      )}
    </article>
  );
}

/* мини-знак «Ветви» для чипа связи */
export function VetviMark() {
  return (
    <svg viewBox="0 0 24 24" width={11} height={11} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M7.5 12h3c3.2 0 2.4-6.5 6-6.5M10.5 12c3.2 0 2.4 6.5 6 6.5" />
      <circle cx="5.5" cy="12" r="1.6" fill="currentColor" stroke="none" />
    </svg>
  );
}

/* ═══ строка задачи (бэклог / мои задачи / фильтр ноды) ═══ */

export function TaskRow(props: {
  task: TmTask;
  ws: Ws;
  userMap: UserMap;
  onOpen: (t: TmTask) => void;
  onToggleDone?: (t: TmTask) => void;
  context?: React.ReactNode;
  action?: React.ReactNode;
}) {
  const t = props.task;
  const st = t.stickers;
  const prio = st.priority ? TM_PRIO[st.priority] : null;
  const project = props.ws.projects.find((p) => p.id === t.projectId);
  return (
    <div className={'tm-row' + (t.done ? ' done' : '')} onClick={() => props.onOpen(t)} role="button" tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); props.onOpen(t); } }}>
      {props.onToggleDone && (
        <button
          type="button"
          className={'tm-donechk' + (t.done ? ' on' : '')}
          style={{ borderColor: prio?.color || 'var(--line2)' }}
          title={t.done ? 'Вернуть в работу' : 'Выполнить'}
          onClick={(e) => { e.stopPropagation(); props.onToggleDone?.(t); }}
        >
          {t.done && (
            <svg viewBox="0 0 24 24" width={11} height={11} fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m5 13 4 4L19 7" /></svg>
          )}
        </button>
      )}
      <span className="tm-row-title">{t.title}</span>
      {props.context}
      {(prio || st.deadline || st.assignees.length > 0) && (
        <span className="tm-row-chips">
          {prio && <span className="tm-chip prio" style={{ color: prio.color, borderColor: prio.color }}>{prio.label}</span>}
          {st.deadline && (() => { const d = fmtDeadline(st.deadline); return <span className={'tm-chip dl ' + d.tone}>{d.text}</span>; })()}
          <span className="tm-card-avs">
            {st.assignees.slice(0, 3).map((login) => (
              <span key={login} className="tm-av" title={firstName(props.userMap.get(login)?.displayName, login)} style={{ background: userColor(login) }}>
                {initialsOf(props.userMap.get(login)?.displayName, login)}
              </span>
            ))}
          </span>
        </span>
      )}
      {props.action}
      <span className="tm-row-proj" title={project?.title || ''}>{project?.title || ''}</span>
    </div>
  );
}

/* ═══ бэклог проекта ═══ */

export function BacklogView(props: {
  ws: Ws;
  projectId: string;
  query: string;
  matchQuery: (t: TmTask, q: string) => boolean;
  userMap: UserMap;
  onOpen: (t: TmTask) => void;
  onQuickAdd: (title: string) => void;
  onToBoard: (t: TmTask) => void;
}) {
  const project = props.ws.projects.find((p) => p.id === props.projectId);
  const tasks = props.ws.tasks
    .filter((t) => t.projectId === props.projectId && !t.columnId && !t.parentId && props.matchQuery(t, props.query))
    .sort((a, b) => a.order - b.order);
  if (!project) return <div className="tm-loading">Проект не найден</div>;
  return (
    <div className="tm-listwrap">
      <TmViewHead title={'Бэклог · ' + project.title} sub="Идеи и будущие задачи живут здесь, пока не попадут на доску">
      </TmViewHead>
      <div className="tm-quickadd">
        <input
          placeholder="Добавить в бэклог (Enter)"
          aria-label="Новая задача в бэклог"
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return;
            const v = (e.target as HTMLInputElement).value.trim();
            if (!v) return;
            (e.target as HTMLInputElement).value = '';
            props.onQuickAdd(v);
          }}
        />
      </div>
      <div className="tm-rows">
        {tasks.map((t) => (
          <TaskRow
            key={t.id}
            task={t}
            ws={props.ws}
            userMap={props.userMap}
            onOpen={props.onOpen}
            action={(
              <button
                type="button"
                className="btn tm-row-act"
                title="На первую доску проекта, в «Не взяты»"
                onClick={(e) => { e.stopPropagation(); props.onToBoard(t); }}
              >
                На доску →
              </button>
            )}
          />
        ))}
        {tasks.length === 0 && <div className="tm-empty">Бэклог пуст</div>}
      </div>
    </div>
  );
}

/* ═══ мои задачи ═══ */

export function MyView(props: {
  ws: Ws;
  query: string;
  matchQuery: (t: TmTask, q: string) => boolean;
  userMap: UserMap;
  onOpen: (t: TmTask) => void;
  onGoBoard: (projectId: string, boardId: string) => void;
}) {
  const groups = useMemo(() => {
    const byProj = new Map<string, TmTask[]>();
    for (const t of props.ws.tasks) {
      if (!t.stickers.assignees.includes(props.ws.me.login) || !props.matchQuery(t, props.query)) continue;
      const arr = byProj.get(t.projectId) || [];
      arr.push(t);
      byProj.set(t.projectId, arr);
    }
    return [...byProj.entries()].map(([pid, list]) => ({
      project: props.ws.projects.find((p) => p.id === pid),
      tasks: list.sort((a, b) => Number(a.done) - Number(b.done) || a.order - b.order),
    })).filter((g) => g.project);
  }, [props.ws, props.matchQuery, props.query]);

  const active = groups.reduce((n, g) => n + g.tasks.filter((t) => !t.done).length, 0);
  const doneCount = groups.reduce((n, g) => n + g.tasks.filter((t) => t.done).length, 0);

  return (
    <div className="tm-listwrap">
      <TmViewHead title="Мои задачи" sub={active + ' активных · ' + doneCount + ' выполнено'}>
      </TmViewHead>
      <div className="tm-rows">
        {groups.map((g) => (
          <div className="tm-group" key={g.project!.id}>
            <div className="tm-group-h">
              <span className="tm-proj-dot" style={{ background: g.project!.color }} />
              <span>{g.project!.title}</span>
              <span className="tm-group-cnt">{g.tasks.length}</span>
              {g.project!.boards[0] && (
                <button type="button" className="btn tm-row-act" onClick={() => props.onGoBoard(g.project!.id, g.project!.boards[0].id)}>
                  К доске →
                </button>
              )}
            </div>
            {g.tasks.map((t) => {
              const board = g.project!.boards.find((b) => b.id === t.boardId);
              const col = board?.columns.find((c) => c.id === t.columnId);
              return (
                <TaskRow
                  key={t.id}
                  task={t}
                  ws={props.ws}
                  userMap={props.userMap}
                  onOpen={props.onOpen}
                  context={col ? <span className="tm-chip ctx" style={{ color: col.color }}>{board!.title} · {col.title}</span> : <span className="tm-chip ctx">Бэклог</span>}
                />
              );
            })}
          </div>
        ))}
        {groups.length === 0 && <div className="tm-empty">Всё разобрано! Задач с вашим участием нет.</div>}
      </div>
    </div>
  );
}

/* ═══ фильтр задач ноды «Ветвей» ═══ */

export function NodeFilterView(props: {
  ws: Ws;
  filter: { pid: string; nid: string; title: string };
  userMap: UserMap;
  onClose: () => void;
  onOpen: (t: TmTask) => void;
  onGoVetvi: (l: TmLink) => void;
}) {
  const tasks = props.ws.tasks
    .filter((t) => (t.links || []).some((l) => l.pid === props.filter.pid && l.nid === props.filter.nid))
    .sort((a, b) => Number(a.done) - Number(b.done));
  const active = tasks.filter((t) => !t.done).length;
  /* для кнопки «Открыть в Ветвях»: комната из существующей связи —
     тогда у другого пользователя проект найдётся по roomId */
  const room = useMemo(() => {
    for (const t of tasks) {
      const l = (t.links || []).find((x) => x.pid === props.filter.pid && x.nid === props.filter.nid);
      if (l?.room) return l.room;
    }
    return null;
  }, [tasks, props.filter]);
  return (
    <div className="tm-listwrap">
      <TmViewHead
        title={props.filter.title ? 'Задачи ноды «' + props.filter.title + '»' : 'Задачи ноды «Ветвей»'}
        sub={active + ' активных · ' + (tasks.length - active) + ' выполнено'}
      >
        <button
          type="button"
          className="btn"
          onClick={() => props.onGoVetvi({ pid: props.filter.pid, nid: props.filter.nid, room })}
          title="Открыть ноду в «Ветвях»"
        >
          <VetviMark /> Открыть в Ветвях
        </button>
        <button type="button" className="btn" onClick={props.onClose}>Сбросить фильтр</button>
      </TmViewHead>
      <div className="tm-rows">
        {tasks.map((t) => (
          <TaskRow key={t.id} task={t} ws={props.ws} userMap={props.userMap} onOpen={props.onOpen} />
        ))}
        {tasks.length === 0 && <div className="tm-empty">К этой ноде пока не привязаны задачи. Выделите её в «Ветвях» и создайте задачу через контекстное меню.</div>}
      </div>
    </div>
  );
}
