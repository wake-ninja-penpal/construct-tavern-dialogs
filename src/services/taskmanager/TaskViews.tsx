'use client';

/**
 * Менеджер задач — представления и компоненты интерфейса:
 * сайдбар (мои задачи/команды/люди/проекты/сохранённые виды), канбан-доска
 * с drag&drop, бэклог, «Мои задачи» и задачи участника, «Команды», «Люди»,
 * фильтр задач ноды «Ветвей», попап ФИЛЬТРОВ, модалки ДОСТУПА проекта
 * (команды и люди с ролями админ/редактор/наблюдатель), команды и
 * сохранения вида, КОЛОКОЛЬЧИК уведомлений (назначили задачу/комментарий).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { childrenOf, firstName, fmtDeadline, initialsOf, TM_KIND_COLOR, TM_PRIO, TM_ROLE_LABEL, TM_ROLE_RANK, TM_PALETTE, TM_TEAM_ICONS, userColor, type TmColumn, type TmFilters, type TmLabel, type TmLink, type TmProject, type TmTask, type TmTeam } from './tmTypes';
import { mdPlain } from './md';
import type { TmUser, Ws } from './TaskManagerApp';

type UserMap = Map<string, TmUser>;

export type TmFilterState = TmFilters;

/* ═══ сайдбар ═══ */

export function TmSidebar(props: {
  ws: Ws;
  view: { kind: string; projectId?: string; boardId?: string; userId?: string };
  savedId: string | null;
  filtersActive: boolean;
  myCount: number;
  onMy: () => void;
  onTeams: () => void;
  onPeople: () => void;
  onUser: (login: string) => void;
  onBoard: (projectId: string, boardId: string) => void;
  onBacklog: (projectId: string) => void;
  onApplyView: (v: Ws['views'][number]) => void;
  onDeleteView: (id: string) => void;
  onSaveView: () => void;
  onNewProject: () => void;
  onRenameProject: (p: TmProject) => void;
  onAccessProject: (p: TmProject) => void;
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
        <button
          type="button"
          className={'tm-nav-row' + (view.kind === 'teams' ? ' cur' : '')}
          onClick={props.onTeams}
          title="Команды — доступ к проектам выдаётся командам"
        >
          <span className="tm-nav-ico">
            <svg viewBox="0 0 24 24" width={15} height={15} fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z" /></svg>
          </span>
          <span className="tm-nav-t">Команды</span>
          {ws.teams.length > 0 && <span className="tm-nav-cnt">{ws.teams.length}</span>}
        </button>
        <button
          type="button"
          className={'tm-nav-row' + (view.kind === 'people' || view.kind === 'user' ? ' cur' : '')}
          onClick={props.onPeople}
          title="Люди хаба и их задачи"
        >
          <span className="tm-nav-ico">
            <svg viewBox="0 0 24 24" width={15} height={15} fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="9" cy="8" r="3.2" /><path d="M3.5 19c.6-3 2.8-5 5.5-5s4.9 2 5.5 5M16 5.5a3 3 0 0 1 0 5M20.5 19c-.4-2.2-1.7-3.8-3.5-4.5" /></svg>
          </span>
          <span className="tm-nav-t">Люди</span>
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
                <button type="button" className="tm-mini" title="Доступ команд и людей" onClick={() => props.onAccessProject(p)}>
                  <svg viewBox="0 0 24 24" width={11} height={11} fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z" /></svg>
                </button>
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

        <div className="tm-nav-cap">
          <span>Мои виды</span>
          <button type="button" className={'tm-nav-plus' + (props.filtersActive ? ' hint' : '')} title="Сохранить текущий вид (фильтры + раздел)" onClick={props.onSaveView}>+</button>
        </div>
        {ws.views.length === 0 && (
          <div className="tm-side-empty">Настройте фильтры и сохраните вид</div>
        )}
        {ws.views.map((v) => (
          <div key={v.id} className={'tm-view-row' + (props.savedId === v.id ? ' cur' : '')}>
            <button type="button" className="tm-nav-row sub" onClick={() => props.onApplyView(v)} title="Применить сохранённый вид">
              <span className="tm-nav-ico board">
                <svg viewBox="0 0 24 24" width={13} height={13} fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M19 21l-7-4.5L5 21V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" /></svg>
              </span>
              <span className="tm-nav-t">{v.name}</span>
            </button>
            <button type="button" className="tm-view-del" title="Удалить вид" onClick={() => props.onDeleteView(v.id)}>×</button>
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

/* ═══ попап фильтров ═══ */

export function TmFilterPop(props: {
  filters: TmFilters;
  ws: Ws;
  userMap: UserMap;
  onClose: () => void;
  onChange: (f: TmFilters) => void;
}) {
  const f = props.filters;
  const { ws } = props;
  /* список вариантов исполнителя: логины из задач проекта (все пользователи хаба слишком широки) */
  const assignees = useMemo(() => {
    const set = new Set<string>();
    for (const t of ws.tasks) for (const a of t.stickers.assignees) set.add(a);
    return [...set].sort((a, b) => a.localeCompare(b, 'ru'));
  }, [ws.tasks]);

  return (
    <>
      <div className="tm-pop-scrim" onClick={props.onClose} />
      <div className="tm-filterpop" role="dialog" aria-label="Фильтры задач">
        <div className="tm-fp-cap">
          <span>Фильтры</span>
          <button type="button" className="tm-mini" onClick={props.onClose} aria-label="Закрыть">×</button>
        </div>
        <div className="tm-fp-sec">
          <div className="tm-fp-h">Исполнитель</div>
          <select
            value={f.assignee}
            onChange={(e) => props.onChange({ ...f, assignee: e.target.value })}
            aria-label="Фильтр по исполнителю"
          >
            <option value="">Все</option>
            <option value="me">Мои задачи</option>
            <option value="none">Без исполнителя</option>
            {assignees.map((a) => (
              <option key={a} value={a}>{firstName(props.userMap.get(a)?.displayName, a)}</option>
            ))}
          </select>
        </div>
        <div className="tm-fp-sec">
          <div className="tm-fp-h">Приоритет</div>
          <div className="tm-fp-chips">
            {Object.entries(TM_PRIO).map(([k, v]) => {
              const on = f.priorities.includes(k);
              return (
                <button
                  key={k}
                  type="button"
                  className={'tm-fchip' + (on ? ' on' : '')}
                  style={{ '--pc': v.color } as React.CSSProperties}
                  onClick={() => props.onChange({ ...f, priorities: on ? f.priorities.filter((x) => x !== k) : [...f.priorities, k] })}
                >
                  {v.label}
                </button>
              );
            })}
          </div>
        </div>
        <div className="tm-fp-sec">
          <div className="tm-fp-h">Метка</div>
          <select
            value={f.labelId}
            onChange={(e) => props.onChange({ ...f, labelId: e.target.value })}
            aria-label="Фильтр по метке"
          >
            <option value="">Все метки</option>
            {ws.labels.map((l) => <option key={l.id} value={l.id}>#{l.name}</option>)}
          </select>
        </div>
        <div className="tm-fp-sec">
          <div className="tm-fp-h">Дедлайн</div>
          <div className="tm-fp-radios">
            {([['any', 'Любой'], ['overdue', 'Просрочен'], ['today', 'Сегодня и раньше'], ['week', 'Ближайшая неделя'], ['none', 'Без дедлайна']] as [string, string][]).map(([v, n]) => (
              <label key={v}>
                <input type="radio" name="tm-f-due" checked={f.due === v} onChange={() => props.onChange({ ...f, due: v })} />
                {n}
              </label>
            ))}
          </div>
        </div>
        <div className="tm-fp-sec">
          <label className="tm-fp-check">
            <input type="checkbox" checked={f.showDone} onChange={(e) => props.onChange({ ...f, showDone: e.target.checked })} />
            Показывать выполненные
          </label>
        </div>
        <div className="tm-fp-foot">
          <button type="button" className="btn" onClick={() => props.onChange({ assignee: '', priorities: [], labelId: '', due: 'any', showDone: true })}>Сбросить</button>
          <button type="button" className="btn primary" onClick={props.onClose}>Готово</button>
        </div>
      </div>
    </>
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
  labels: TmLabel[];
  canEdit: boolean;
  canAdmin: boolean;
  roleLabel: string | null;
  filtered: (list: TmTask[]) => TmTask[];
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
  onAccess: () => void;
  headExtra?: React.ReactNode;
}) {
  const { ws } = props;
  const project = ws.projects.find((p) => p.id === props.projectId);
  const board = project?.boards.find((b) => b.id === props.boardId);
  const [overCol, setOverCol] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  if (!project || !board) {
    return <div className="tm-loading">Доска не найдена</div>;
  }

  const columnTasks = (colId: string): TmTask[] => {
    const inCol = ws.tasks.filter((t) => t.columnId === colId && !t.parentId && props.matchQuery(t, props.query));
    return props.filtered(inCol).sort((a, b) => a.order - b.order);
  };

  const activeN = ws.tasks.filter((t) => t.boardId === board.id && !t.done && !t.parentId).length;

  return (
    <div className="tm-boardwrap">
      <TmViewHead
        title={board.title}
        sub={project.title + ' · ' + activeN + ' активных' + (!props.canEdit ? ' · наблюдатель' : '')}
      >
        {props.headExtra}
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
          {props.canEdit && <button type="button" className="tm-tab add" title="Новая доска" onClick={props.onAddBoard}>+ доска</button>}
        </div>
        {props.canAdmin && (
          <button type="button" className="btn tm-viewdel" title="Доступ команд и людей к проекту" onClick={props.onAccess}>
            Доступ
          </button>
        )}
        {props.canEdit && <button type="button" className="btn danger tm-viewdel" title="Удалить доску" onClick={() => props.onDeleteBoard(board)}>Удалить</button>}
      </TmViewHead>

      <div className={'tm-kanban' + (dragging ? ' dragging' : '')}>
        {board.columns.map((col) => {
          const tasks = columnTasks(col.id);
          return (
            <section
              key={col.id}
              className={'tm-kcol' + (overCol === col.id ? ' over' : '')}
              onDragOver={(e) => { if (!props.canEdit) return; e.preventDefault(); setOverCol(col.id); }}
              onDragLeave={() => setOverCol((c) => (c === col.id ? null : c))}
              onDrop={(e) => {
                e.preventDefault();
                setOverCol(null);
                setDragging(false);
                if (!props.canEdit) return;
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
                {!col.locked && props.canEdit && (
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
                    labels={props.labels}
                    onOpen={props.onOpen}
                    onToggleDone={props.onToggleDone}
                    draggable={props.canEdit}
                    onDragStart={() => { dragTaskId = t.id; setDragging(true); }}
                    onDragEnd={() => { dragTaskId = null; setDragging(false); }}
                  />
                ))}
                {tasks.length === 0 && <div className="tm-kcol-empty">Пусто</div>}
              </div>
              {props.canEdit && (
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
              )}
            </section>
          );
        })}
        {props.canEdit && (
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
        )}
      </div>
    </div>
  );
}

/* ═══ чипы меток (карточки и строки) ═══ */

export function LabelChips(props: { task: TmTask; labels: TmLabel[]; limit?: number }) {
  const ids = props.task.labelIds || [];
  if (!ids.length) return null;
  const shown = props.labels.filter((l) => ids.includes(l.id)).slice(0, props.limit ?? 3);
  const rest = ids.length - shown.length;
  return (
    <>
      {shown.map((l) => (
        <span key={l.id} className="tm-chip label" style={{ color: l.color, borderColor: l.color }}>#{l.name}</span>
      ))}
      {rest > 0 && <span className="tm-chip label more">+{rest}</span>}
    </>
  );
}

/* ═══ карточка задачи (канбан) ═══ */

export function TaskCard(props: {
  task: TmTask;
  ws: Ws;
  userMap: UserMap;
  labels: TmLabel[];
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
  const comments = (t.messages || []).filter((m) => !m.system).length;
  const plain = mdPlain(t.description);
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
      {plain && <p className="tm-card-desc">{plain.slice(0, 132)}</p>}
      {(prio || st.deadline || kids.length > 0 || st.assignees.length > 0 || links.length > 0 || (t.labelIds || []).length > 0 || comments > 0) && (
        <div className="tm-card-chips">
          {prio && <span className="tm-chip prio" style={{ color: prio.color, borderColor: prio.color }}>{prio.label}</span>}
          {st.deadline && (() => { const d = fmtDeadline(st.deadline); return <span className={'tm-chip dl ' + d.tone}>{d.text}</span>; })()}
          <LabelChips task={t} labels={props.labels} limit={2} />
          {kids.length > 0 && (
            <span className={'tm-chip kids' + (kidsDone === kids.length ? ' all' : '')}>
              {kidsDone}/{kids.length}
            </span>
          )}
          {comments > 0 && <span className="tm-chip cmt" title="Комментарии">💬 {comments}</span>}
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
  labels?: TmLabel[];
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
      {(prio || st.deadline || st.assignees.length > 0 || (t.labelIds || []).length > 0) && (
        <span className="tm-row-chips">
          {prio && <span className="tm-chip prio" style={{ color: prio.color, borderColor: prio.color }}>{prio.label}</span>}
          {st.deadline && (() => { const d = fmtDeadline(st.deadline); return <span className={'tm-chip dl ' + d.tone}>{d.text}</span>; })()}
          {props.labels && <LabelChips task={t} labels={props.labels} limit={2} />}
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
  labels: TmLabel[];
  canEdit: boolean;
  filtered: (list: TmTask[]) => TmTask[];
  onOpen: (t: TmTask) => void;
  onQuickAdd: (title: string) => void;
  onToBoard: (t: TmTask) => void;
  headExtra?: React.ReactNode;
}) {
  const project = props.ws.projects.find((p) => p.id === props.projectId);
  const tasks = props.filtered(
    props.ws.tasks.filter((t) => t.projectId === props.projectId && !t.columnId && !t.parentId && props.matchQuery(t, props.query)),
  ).sort((a, b) => a.order - b.order);
  if (!project) return <div className="tm-loading">Проект не найден</div>;
  return (
    <div className="tm-listwrap">
      <TmViewHead title={'Бэклог · ' + project.title} sub="Идеи и будущие задачи живут здесь, пока не попадут на доску">
        {props.headExtra}
      </TmViewHead>
      {props.canEdit && (
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
      )}
      <div className="tm-rows">
        {tasks.map((t) => (
          <TaskRow
            key={t.id}
            task={t}
            ws={props.ws}
            userMap={props.userMap}
            labels={props.labels}
            onOpen={props.onOpen}
            action={props.canEdit ? (
              <button
                type="button"
                className="btn tm-row-act"
                title="На первую доску проекта, в «Не взяты»"
                onClick={(e) => { e.stopPropagation(); props.onToBoard(t); }}
              >
                На доску →
              </button>
            ) : undefined}
          />
        ))}
        {tasks.length === 0 && <div className="tm-empty">Бэклог пуст</div>}
      </div>
    </div>
  );
}

/* ═══ мои задачи (или задачи участника) ═══ */

export function MyView(props: {
  ws: Ws;
  query: string;
  targetUid?: string;
  matchQuery: (t: TmTask, q: string) => boolean;
  userMap: UserMap;
  labels?: TmLabel[];
  filtered: (list: TmTask[]) => TmTask[];
  onOpen: (t: TmTask) => void;
  onGoBoard: (projectId: string, boardId: string) => void;
  onBackToPeople?: () => void;
  headExtra?: React.ReactNode;
}) {
  const uid = props.targetUid || props.ws.me.login;
  const { ws, filtered, matchQuery, query, userMap } = props;
  const groups = useMemo(() => {
    const byProj = new Map<string, TmTask[]>();
    for (const t of filtered(ws.tasks)) {
      if (!t.stickers.assignees.includes(uid) || !matchQuery(t, query)) continue;
      const arr = byProj.get(t.projectId) || [];
      arr.push(t);
      byProj.set(t.projectId, arr);
    }
    return [...byProj.entries()].map(([pid, list]) => ({
      project: ws.projects.find((p) => p.id === pid),
      tasks: list.sort((a, b) => Number(a.done) - Number(b.done) || a.order - b.order),
    })).filter((g) => g.project);
  }, [ws, filtered, matchQuery, query, uid]);

  const active = groups.reduce((n, g) => n + g.tasks.filter((t) => !t.done).length, 0);
  const doneCount = groups.reduce((n, g) => n + g.tasks.filter((t) => t.done).length, 0);
  const target = props.targetUid ? props.userMap.get(props.targetUid) : null;

  return (
    <div className="tm-listwrap">
      <TmViewHead
        title={props.targetUid ? (firstName(target?.displayName, props.targetUid) + ' — задачи') : 'Мои задачи'}
        sub={active + ' активных · ' + doneCount + ' выполнено'}
      >
        {props.targetUid && props.onBackToPeople && (
          <button type="button" className="btn" onClick={props.onBackToPeople}>← Люди</button>
        )}
        {props.headExtra}
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
                  labels={props.labels}
                  onOpen={props.onOpen}
                  context={col ? <span className="tm-chip ctx" style={{ color: col.color }}>{board!.title} · {col.title}</span> : <span className="tm-chip ctx">Бэклог</span>}
                />
              );
            })}
          </div>
        ))}
        {groups.length === 0 && <div className="tm-empty">{props.targetUid ? 'У этого участника задач нет.' : 'Всё разобрано! Задач с вашим участием нет.'}</div>}
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
        {tasks.length === 0 && <div className="tm-empty">К этой ноде пока не привязаны задачи. Выделите её в «Ветвях» и создайте задачу через контекстное меню — или привяжите ноду из самой задачи.</div>}
      </div>
    </div>
  );
}

/* ═══ команды ═══ */

export function TmTeamsView(props: {
  ws: Ws;
  userMap: UserMap;
  me: Ws['me'];
  onNewTeam: () => void;
  onEditTeam: (t: TmTeam, focusMembers?: boolean) => void;
  onDeleteTeam: (t: TmTeam) => void;
}) {
  const { ws } = props;
  return (
    <div className="tm-listwrap">
      <TmViewHead title="Команды" sub="Команды выдают доступ к проектам сразу всем участникам — с общей ролью">
        <button type="button" className="btn primary" onClick={props.onNewTeam}>+ Команда</button>
      </TmViewHead>
      <div className="tm-teams">
        {ws.teams.map((t) => {
          const inTeam = t.members.some((m) => m.login === props.me.login);
          const projects = ws.access.filter((r) => r.teamId === t.id).length;
          return (
            <div className="tm-teamcard" key={t.id} style={{ '--tc': t.color } as React.CSSProperties}>
              <div className="tm-teamcard-top">
                <span className="tm-team-ico" style={{ background: t.color }}>
                  <TeamIcon icon={t.icon} />
                </span>
                <div className="tm-teamcard-name">
                  <b>{t.name}</b>
                  <i>{t.members.length} {pluralRu(t.members.length, 'участник', 'участника', 'участников')}{projects > 0 ? ' · в ' + projects + ' ' + pluralRu(projects, 'проекте', 'проектах', 'проектах') : ''}{inTeam ? ' · вы участник' : ''}</i>
                </div>
              </div>
              <div className="tm-teamcard-avs">
                {t.members.slice(0, 6).map((m) => (
                  <span key={m.login} className="tm-av" style={{ background: userColor(m.login) }} title={firstName(props.userMap.get(m.login)?.displayName, m.login)}>
                    {initialsOf(props.userMap.get(m.login)?.displayName, m.login)}
                  </span>
                ))}
                {t.members.length > 6 && <span className="tm-av more">+{t.members.length - 6}</span>}
              </div>
              <div className="tm-teamcard-acts">
                <button type="button" className="btn tm-row-act" onClick={() => props.onEditTeam(t, true)}>Состав</button>
                <button type="button" className="btn tm-row-act" onClick={() => props.onEditTeam(t)}>Настройки</button>
                <button type="button" className="btn danger tm-row-act" onClick={() => props.onDeleteTeam(t)}>Удалить</button>
              </div>
            </div>
          );
        })}
        {ws.teams.length === 0 && (
          <div className="tm-empty">
            Команд пока нет. Создайте команду — и добавьте её в проект через «Доступ»,
            чтобы каждый участник команды получил доску задач.
            <button type="button" className="btn primary" style={{ marginTop: 12 }} onClick={props.onNewTeam}>+ Создать команду</button>
          </div>
        )}
      </div>
    </div>
  );
}

export function TeamIcon({ icon }: { icon: string }) {
  const paths: Record<string, string> = {
    shield: 'M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z',
    users: 'M8.5 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM2.5 19c.6-3 3-5 6-5s5.4 2 6 5M16 4.5a3 3 0 0 1 0 6M17.5 14c2 .7 3.4 2.3 4 5',
    rocket: 'M5 15c-1.5 1.5-2 5-2 5s3.5-.5 5-2M14 4c3 0 6 3 6 6l-8.5 8.5c-.5.5-8.5-7.5-8-8zM15 9h.01',
    code: 'M8 8l-4 4 4 4M16 8l4 4-4 4M13 5l-2 14',
    megaphone: 'M3 10v4l11 4V6zM14 6l7-2v16l-7-2M5 14v4',
    star: 'M12 3l2.7 5.8 6.3.8-4.6 4.3 1.2 6.1L12 17l-5.6 3 1.2-6.1L3 9.6l6.3-.8z',
    flame: 'M12 21c4 0 7-2.5 7-6.5C19 10 12 3 12 3S5 10 5 14.5C5 18.5 8 21 12 21zM12 17a2.5 2.5 0 0 0 2.5-2.5c0-1.5-2.5-4-2.5-4s-2.5 2.5-2.5 4A2.5 2.5 0 0 0 12 17z',
    kanban: 'M4 4h6.5v16H4zM13.5 4H20v10h-6.5z',
  };
  return (
    <svg viewBox="0 0 24 24" width={14} height={14} fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={paths[icon] || paths.shield} />
    </svg>
  );
}

function pluralRu(n: number, a: string, b: string, c: string): string {
  const m = n % 100;
  if (m >= 11 && m <= 14) return c;
  const k = n % 10;
  if (k === 1) return a;
  if (k >= 2 && k <= 4) return b;
  return c;
}

/* ═══ люди ═══ */

export function TmPeopleView(props: {
  ws: Ws;
  userMap: UserMap;
  onOpenUser: (login: string) => void;
  onGoBoard: (projectId: string, boardId: string) => void;
}) {
  const stats = useMemo(() => {
    const map = new Map<string, { open: number; done: number }>();
    for (const t of props.ws.tasks) {
      for (const a of t.stickers.assignees) {
        const rec = map.get(a) || { open: 0, done: 0 };
        if (t.done) rec.done++; else rec.open++;
        map.set(a, rec);
      }
    }
    return map;
  }, [props.ws.tasks]);

  const users = [...props.userMap.values()];

  return (
    <div className="tm-listwrap">
      <TmViewHead title="Люди" sub="Участники хаба: клик по карточке — задачи человека" />
      <div className="tm-teams">
        {users.map((u) => {
          const st = stats.get(u.login) || { open: 0, done: 0 };
          const teams = props.ws.teams.filter((t) => t.members.some((m) => m.login === u.login));
          return (
            <button type="button" className="tm-teamcard people" key={u.login} onClick={() => props.onOpenUser(u.login)}>
              <span className="tm-av big" style={{ background: userColor(u.login) }}>
                {initialsOf(u.displayName, u.login)}
              </span>
              <div className="tm-teamcard-name">
                <b>{firstName(u.displayName, u.login)}</b>
                <i>@{u.login}{teams.length ? ' · ' + teams.map((t) => t.name).slice(0, 2).join(', ') : ''}</i>
              </div>
              <span className="tm-people-cnt">{st.open} активных · {st.done} выполнено</span>
            </button>
          );
        })}
        {users.length === 0 && <div className="tm-empty">Список участников недоступен</div>}
      </div>
    </div>
  );
}

/* ═══ модалка доступов проекта (команды + люди с ролями) ═══ */

interface AccessDraft { key: string; login: string | null; teamId: string | null; role: string }

export function TmAccessModal(props: {
  ws: Ws;
  projectId: string;
  users: TmUser[];
  canAdmin: boolean;
  onClose: () => void;
  onSave: (projectId: string, rows: { login?: string | null; teamId?: string | null; role: string }[]) => Promise<boolean>;
}) {
  const project = props.ws.projects.find((p) => p.id === props.projectId);
  const [rows, setRows] = useState<AccessDraft[]>(() => {
    const cur = props.ws.access.filter((r) => r.projectId === props.projectId);
    return cur.map((r) => ({ key: r.id, login: r.login, teamId: r.teamId, role: r.role }));
  });
  const [busy, setBusy] = useState(false);
  const [showAddTeam, setShowAddTeam] = useState(false);
  const [showAddUser, setShowAddUser] = useState(false);
  if (!project) return null;

  const usedTeams = new Set(rows.map((r) => r.teamId).filter(Boolean) as string[]);
  const usedLogins = new Set(rows.map((r) => r.login).filter(Boolean) as string[]);
  const outTeams = props.ws.teams.filter((t) => !usedTeams.has(t.id));
  const outUsers = props.users.filter((u) => !usedLogins.has(u.login));

  const addTeam = (t: TmTeam) => {
    setRows((rs) => [...rs, { key: 'new-' + t.id, login: null, teamId: t.id, role: 'editor' }]);
    setShowAddTeam(false);
  };
  const addUser = (login: string) => {
    setRows((rs) => [...rs, { key: 'new-u-' + login, login, teamId: null, role: 'editor' }]);
    setShowAddUser(false);
  };
  const setRole = (key: string, role: string) => {
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, role } : r)));
  };
  const removeRow = (key: string) => setRows((rs) => rs.filter((r) => r.key !== key));

  const save = async () => {
    setBusy(true);
    const ok = await props.onSave(props.projectId, rows.map((r) => ({ login: r.login, teamId: r.teamId, role: r.role })));
    setBusy(false);
    if (ok) props.onClose();
  };

  return (
    <div className="tm-modal-scrim" role="dialog" aria-label={'Доступ · ' + project.title} onClick={(e) => { if (e.target === e.currentTarget) props.onClose(); }}>
      <div className="tm-modal wide">
        <div className="tm-modal-head">
          <span>Доступ · {project.title}</span>
          <button type="button" className="btn ibtn" onClick={props.onClose} aria-label="Закрыть">×</button>
        </div>
        <p className="tm-modal-sub">
          Роль берётся максимумом из персональной и командных: админ управляет доступом,
          редактор создаёт и правит задачи, наблюдатель читает и комментирует.
          Без строк доступов проект открыт всем пользователям сервиса.
        </p>
        {!props.canAdmin && (
          <div className="tm-note">Вы видите доступ в режиме чтения: управлять им может только админ проекта.</div>
        )}
        <div className="tm-modal-body">
          <div className="tm-fp-h" style={{ margin: '2px 0 8px' }}>Команды проекта</div>
          <div className="tm-acc-list">
            {rows.filter((r) => r.teamId).map((r) => {
              const t = props.ws.teams.find((x) => x.id === r.teamId);
              if (!t) return null;
              return (
                <div className="tm-acc-row" key={r.key}>
                  <span className="tm-team-ico sm" style={{ background: t.color }}><TeamIcon icon={t.icon} /></span>
                  <span className="tm-acc-name">{t.name}<i>{t.members.length} участн. · по команде</i></span>
                  {props.canAdmin ? (
                    <select value={r.role} onChange={(e) => setRole(r.key, e.target.value)} aria-label="Роль команды">
                      {Object.keys(TM_ROLE_LABEL).map((k) => <option key={k} value={k}>{TM_ROLE_LABEL[k]}</option>)}
                    </select>
                  ) : <span className="tm-acc-role">{TM_ROLE_LABEL[r.role] || r.role}</span>}
                  {props.canAdmin && <button type="button" className="tm-mini danger" title="Убрать команду" onClick={() => removeRow(r.key)}>×</button>}
                </div>
              );
            })}
            {!rows.some((r) => r.teamId) && <div className="tm-acc-empty">Ни одна команда не назначена.</div>}
          </div>
          {props.canAdmin && (
            showAddTeam ? (
              <div className="tm-acc-add">
                {outTeams.map((t) => (
                  <button type="button" key={t.id} className="tm-acc-pick" onClick={() => addTeam(t)}>
                    <span className="tm-team-ico sm" style={{ background: t.color }}><TeamIcon icon={t.icon} /></span>
                    {t.name}
                    <i>+ редактор</i>
                  </button>
                ))}
                {outTeams.length === 0 && <span className="tm-acc-empty">Все команды уже добавлены</span>}
                <button type="button" className="btn" onClick={() => setShowAddTeam(false)}>Отмена</button>
              </div>
            ) : (
              <button type="button" className="btn" onClick={() => { setShowAddTeam(true); setShowAddUser(false); }}>+ Добавить команду</button>
            )
          )}

          <div className="tm-fp-h" style={{ margin: '16px 0 8px' }}>Персональный доступ</div>
          <div className="tm-acc-list">
            {rows.filter((r) => r.login).map((r) => {
              const u = props.users.find((x) => x.login === r.login);
              return (
                <div className="tm-acc-row" key={r.key}>
                  <span className="tm-av" style={{ background: userColor(r.login || '') }}>{initialsOf(u?.displayName, r.login || '')}</span>
                  <span className="tm-acc-name">{firstName(u?.displayName, r.login || '')}<i>@{r.login} · персонально</i></span>
                  {props.canAdmin ? (
                    <select value={r.role} onChange={(e) => setRole(r.key, e.target.value)} aria-label="Роль участника">
                      {Object.keys(TM_ROLE_LABEL).map((k) => <option key={k} value={k}>{TM_ROLE_LABEL[k]}</option>)}
                    </select>
                  ) : <span className="tm-acc-role">{TM_ROLE_LABEL[r.role] || r.role}</span>}
                  {props.canAdmin && <button type="button" className="tm-mini danger" title="Убрать доступ" onClick={() => removeRow(r.key)}>×</button>}
                </div>
              );
            })}
            {!rows.some((r) => r.login) && <div className="tm-acc-empty">Персонального доступа ни у кого нет.</div>}
          </div>
          {props.canAdmin && (
            showAddUser ? (
              <div className="tm-acc-add scroll">
                {outUsers.map((u) => (
                  <button type="button" key={u.login} className="tm-acc-pick" onClick={() => addUser(u.login)}>
                    <span className="tm-av" style={{ background: userColor(u.login) }}>{initialsOf(u.displayName, u.login)}</span>
                    {firstName(u.displayName, u.login)}
                    <i>@{u.login}</i>
                  </button>
                ))}
                {outUsers.length === 0 && <span className="tm-acc-empty">Все пользователи уже добавлены</span>}
                <button type="button" className="btn" onClick={() => setShowAddUser(false)}>Отмена</button>
              </div>
            ) : (
              <button type="button" className="btn" onClick={() => { setShowAddUser(true); setShowAddTeam(false); }}>+ Добавить человека</button>
            )
          )}
        </div>
        <div className="tm-modal-foot">
          <button type="button" className="btn" onClick={props.onClose}>Отмена</button>
          {props.canAdmin && (
            <button type="button" className="btn primary" disabled={busy} onClick={() => void save()}>
              {busy ? 'Сохраняю…' : 'Сохранить доступ'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/* ═══ модалка команды (создание/редактирование) ═══ */

export function TmTeamModal(props: {
  ws: Ws;
  users: TmUser[];
  team: TmTeam | null;
  focusMembers?: boolean;
  onClose: () => void;
  onSave: (payload: Record<string, unknown>, id?: string) => Promise<boolean>;
  onDelete: (t: TmTeam) => void;
}) {
  const t = props.team;
  const [name, setName] = useState(t?.name || '');
  const [color, setColor] = useState(t?.color || TM_PALETTE[0]);
  const [icon, setIcon] = useState(t?.icon || 'shield');
  const [members, setMembers] = useState<Set<string>>(() => new Set(t?.members.map((m) => m.login) || []));
  const membersRef = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (props.focusMembers && membersRef.current) membersRef.current.scrollIntoView({ block: 'center' });
  }, [props.focusMembers]);

  const submit = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    const ok = await props.onSave({ name: name.trim(), color, icon, members: [...members] }, t?.id);
    setBusy(false);
    if (ok) props.onClose();
  };

  return (
    <div className="tm-modal-scrim" role="dialog" aria-label={t ? 'Редактирование команды' : 'Новая команда'} onClick={(e) => { if (e.target === e.currentTarget) props.onClose(); }}>
      <div className="tm-modal">
        <div className="tm-modal-head">
          <span>{t ? 'Редактирование команды' : 'Новая команда'}</span>
          <button type="button" className="btn ibtn" onClick={props.onClose} aria-label="Закрыть">×</button>
        </div>
        <div className="tm-modal-body">
          <label className="tm-f">
            <span>Название команды <i>*</i></span>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Например: Сюжетная группа" maxLength={40} autoFocus={!props.focusMembers} />
          </label>
          <label className="tm-f">
            <span>Цвет</span>
            <div className="tm-swatches">
              {TM_PALETTE.map((c) => (
                <button key={c} type="button" className={'tm-swatch' + (c === color ? ' on' : '')} style={{ background: c }} onClick={() => setColor(c)} aria-label={'Цвет ' + c} />
              ))}
            </div>
          </label>
          <label className="tm-f">
            <span>Иконка</span>
            <div className="tm-iconpick">
              {TM_TEAM_ICONS.map((i) => (
                <button key={i} type="button" className={i === icon ? 'on' : ''} onClick={() => setIcon(i)} aria-label={'Иконка ' + i}>
                  <TeamIcon icon={i} />
                </button>
              ))}
            </div>
          </label>
          <div className="tm-f" ref={membersRef}>
            <span>Состав · {props.users.length} чел.</span>
            <div className="tm-memblist">
              {props.users.map((u) => {
                const on = members.has(u.login);
                return (
                  <label key={u.login} className="tm-pop-row">
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={() => {
                        const next = new Set(members);
                        if (on) next.delete(u.login); else next.add(u.login);
                        setMembers(next);
                      }}
                    />
                    <span className="tm-av" style={{ background: userColor(u.login) }}>{initialsOf(u.displayName, u.login)}</span>
                    <span>{firstName(u.displayName, u.login)}</span>
                    <i className="tm-pop-login">@{u.login}</i>
                  </label>
                );
              })}
              {props.users.length === 0 && <div className="tm-pop-empty">Список аккаунтов недоступен</div>}
            </div>
          </div>
        </div>
        <div className="tm-modal-foot">
          {t && <button type="button" className="btn danger" onClick={() => props.onDelete(t)}>Удалить</button>}
          <span className="tm-modal-sp" />
          <button type="button" className="btn" onClick={props.onClose}>Отмена</button>
          <button type="button" className="btn primary" disabled={!name.trim() || busy} onClick={() => void submit()}>
            {busy ? 'Сохраняю…' : t ? 'Сохранить' : 'Создать команду'}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ═══ модалка сохранения вида ═══ */

export function TmSaveViewModal(props: {
  filters: TmFilters;
  sort: string;
  view: { kind: string; projectId?: string; boardId?: string; userId?: string };
  ws: Ws;
  onClose: () => void;
  onSave: (name: string) => Promise<void>;
}) {
  const { view, filters, ws } = props;
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const viewName = view.kind === 'board' ? (ws.projects.find((p) => p.id === view.projectId)?.boards.find((b) => b.id === view.boardId)?.title || 'Доска')
    : view.kind === 'backlog' ? 'Бэклог · ' + (ws.projects.find((p) => p.id === view.projectId)?.title || '')
    : view.kind === 'user' ? 'Задачи участника'
    : view.kind === 'teams' ? 'Команды'
    : view.kind === 'people' ? 'Люди' : 'Мои задачи';
  const activeFilters = (filters.assignee ? 1 : 0) + filters.priorities.length + (filters.labelId ? 1 : 0) + (filters.due !== 'any' ? 1 : 0) + (filters.showDone ? 0 : 1);

  const submit = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    await props.onSave(name.trim());
    setBusy(false);
  };

  return (
    <div className="tm-modal-scrim" role="dialog" aria-label="Сохранить вид" onClick={(e) => { if (e.target === e.currentTarget) props.onClose(); }}>
      <div className="tm-modal">
        <div className="tm-modal-head">
          <span>Сохранить вид</span>
          <button type="button" className="btn ibtn" onClick={props.onClose} aria-label="Закрыть">×</button>
        </div>
        <p className="tm-modal-sub">Раздел, фильтры и сортировка — одним кликом из сайдбара.</p>
        <div className="tm-modal-body">
          <div className="tm-viewchips">
            <span className="tm-chip ctx">{viewName}</span>
            <span className="tm-chip ctx">сортировка: {props.sort}</span>
            {filters.assignee && <span className="tm-chip ctx">исполнитель</span>}
            {filters.priorities.length > 0 && <span className="tm-chip ctx">приоритеты: {filters.priorities.length}</span>}
            {filters.labelId && <span className="tm-chip ctx">метка</span>}
            {filters.due !== 'any' && <span className="tm-chip ctx">дедлайн</span>}
            {!filters.showDone && <span className="tm-chip ctx">скрыть выполненные</span>}
            {activeFilters === 0 && <span className="tm-chip ctx">без фильтров</span>}
          </div>
          <label className="tm-f">
            <span>Название <i>*</i></span>
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} placeholder="Например: Горящие баги" autoFocus />
          </label>
        </div>
        <div className="tm-modal-foot">
          <button type="button" className="btn" onClick={props.onClose}>Отмена</button>
          <button type="button" className="btn primary" disabled={!name.trim() || busy} onClick={() => void submit()}>
            {busy ? 'Сохраняю…' : 'Сохранить вид'}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ═══ колокольчик уведомлений (назначение задач, комментарии) ═══ */

interface NtfItem {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  read: boolean;
  createdAt: string;
}

export function TmBell(props: {
  me: Ws['me'];
  say: (text: string, tone?: 'ok' | 'warn' | 'err') => void;
  onOpenTask: (taskId: string) => void;
}) {
  const [items, setItems] = useState<NtfItem[]>([]);
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  const seen = useRef<Set<string>>(new Set());
  const first = useRef(true);
  const say = props.say;

  const refresh = useCallback(async (markRead = false) => {
    try {
      const r = await fetch('/api/notifications', { cache: 'no-store' });
      if (!r.ok) return;
      const j = (await r.json()) as { items: NtfItem[]; unread: number };
      if (!first.current) {
        for (const n of j.items) {
          if (!n.read && !seen.current.has(n.id)) {
            const p = n.payload || {};
            if (n.type === 'task_assigned') say('Вам назначили задачу «' + String(p.taskTitle || '').slice(0, 40) + '»', 'ok');
            else if (n.type === 'task_comment') say('Комментарий к задаче от ' + String(p.byName || ''), 'ok');
          }
        }
      }
      first.current = false;
      for (const n of j.items) seen.current.add(n.id);
      setItems(j.items || []);
      setUnread(j.unread || 0);
      if (markRead && j.unread > 0) {
        void fetch('/api/notifications/read', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        setUnread(0);
        setItems((xs) => xs.map((x) => ({ ...x, read: true })));
      }
    } catch { /* опрос — страховка */ }
  }, [say]);

  useEffect(() => {
    const t0 = setTimeout(() => void refresh(), 400);
    const t = setInterval(() => void refresh(), 15000);
    return () => { clearTimeout(t0); clearInterval(t); };
  }, [refresh]);

  const openItem = async (n: NtfItem) => {
    setOpen(false);
    void fetch('/api/notifications/read', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: [n.id] }) });
    const p = n.payload || {};
    if (p.taskId) props.onOpenTask(String(p.taskId));
  };

  return (
    <div className="tm-bell-wrap">
      <button
        type="button"
        className={'tm-bell' + (unread > 0 ? ' has' : '')}
        title="Уведомления"
        aria-label={'Уведомления' + (unread ? ' — ' + unread + ' непрочитанных' : '')}
        onClick={() => { setOpen(!open); if (!open) void refresh(true); }}
      >
        <svg viewBox="0 0 24 24" width={17} height={17} fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 9a6 6 0 1 1 12 0c0 5 2 6 2 6H4s2-1 2-6M10 20a2 2 0 0 0 4 0" /></svg>
        {unread > 0 && <span className="tm-bell-badge">{unread > 9 ? '9+' : unread}</span>}
      </button>
      {open && (
        <>
          <div className="tm-pop-scrim" onClick={() => setOpen(false)} />
          <div className="tm-ntfpop" role="dialog" aria-label="Уведомления">
            <div className="tm-fp-cap">
              <span>Уведомления</span>
              <button type="button" className="tm-mini" onClick={() => setOpen(false)} aria-label="Закрыть">×</button>
            </div>
            <div className="tm-ntf-list">
              {items.map((n) => {
                const p = n.payload || {};
                const isTask = n.type === 'task_assigned' || n.type === 'task_comment';
                return (
                  <button
                    type="button"
                    key={n.id}
                    className={'tm-ntf-item' + (n.read ? '' : ' unread') + (isTask ? ' task' : '')}
                    onClick={() => void openItem(n)}
                  >
                    <b>
                      {n.type === 'task_assigned' && <>Вам назначили задачу{p.taskTitle ? <> «{String(p.taskTitle).slice(0, 50)}»</> : ''}</>}
                      {n.type === 'task_comment' && <>Комментарий к задаче{p.taskTitle ? <> «{String(p.taskTitle).slice(0, 40)}»</> : ''}</>}
                      {!isTask && <>Уведомление</>}
                    </b>
                    <i>
                      {n.type === 'task_assigned' && (String(p.byName || '') + ' · ')}
                      {n.type === 'task_comment' && ((p.preview ? String(p.preview).slice(0, 60) + ' · ' : '') + String(p.byName || '') + ' · ')}
                      {fmtNtfDate(n.createdAt)}
                    </i>
                  </button>
                );
              })}
              {items.length === 0 && <div className="tm-ntf-empty">Пока пусто — здесь появится назначение задач и комментарии</div>}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function fmtNtfDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString('ru-RU', { day: '2-digit', month: 'short' }) + ' ' +
      d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}
