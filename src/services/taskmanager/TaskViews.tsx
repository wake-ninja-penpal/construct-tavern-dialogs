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

import { childrenOf, colorVars, firstName, fmtDeadline, initialsOf, TM_KIND_COLOR, TM_PRIO, TM_ROLE_LABEL, TM_ROLE_RANK, TM_PALETTE, TM_TEAM_ICONS, TM_SYS_COL_INFO, userColor, type TmColumn, type TmFilters, type TmLabel, type TmLink, type TmProject, type TmTask, type TmTeam } from './tmTypes';
import { mdPlain } from './md';
import { ColumnIcon } from './icons';
import { tmOpenMenu } from './TmMenu';
import type { TmUser, Ws } from './TaskManagerApp';

type UserMap = Map<string, TmUser>;

export type TmFilterState = TmFilters;

/* ═══ сайдбар ═══ */

function Ico(props: { d: string; size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={props.size ?? 15} height={props.size ?? 15} fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={props.d} />
    </svg>
  );
}

const ICO_MY = 'M4.5 6.5 6 8l2.5-2.8M4.5 12.5 6 14l2.5-2.8M4.5 18.5 6 20l2.5-2.8M11.5 7h8M11.5 13h8M11.5 19h8';
const ICO_TEAM = 'M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z';
const ICO_PEOPLE = 'M9 8a3.2 3.2 0 1 0 0-6.4A3.2 3.2 0 0 0 9 8zM3.5 19c.6-3 2.8-5 5.5-5s4.9 2 5.5 5M16 5.5a3 3 0 0 1 0 5M20.5 19c-.4-2.2-1.7-3.8-3.5-4.5';
const ICO_BOARD = 'M4 4h6.5v16H4zM13.5 4H20v10h-6.5z';
const ICO_BACKLOG = 'M4 7h16M4 12h10M4 17h7';
const ICO_VIEW = 'M19 21l-7-4.5L5 21V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z';

/* строки досок и бэклога — цели перетягивания задач (data-drop-*),
   ПКМ на любом элементе сайдбара открывает своё меню */
function BoardNavRow(props: {
  projectId: string; boardId: string; title: string; count: number; active: boolean; rail: boolean;
  onOpen: () => void;
  onCtx: (x: number, y: number) => void;
}) {
  if (props.rail) {
    return (
      <button
        type="button"
        className={'tm-rail-item sub' + (props.active ? ' cur' : '')}
        data-tip={props.title + ' · ' + props.count}
        data-drop-board={props.boardId}
        aria-label={props.title}
        onClick={props.onOpen}
        onContextMenu={(e) => { e.preventDefault(); props.onCtx(e.clientX, e.clientY); }}
      >
        <Ico d={ICO_BOARD} size={14} />
      </button>
    );
  }
  return (
    <button
      type="button"
      className={'tm-nav-row sub' + (props.active ? ' cur' : '')}
      data-drop-board={props.boardId}
      onClick={props.onOpen}
      onContextMenu={(e) => { e.preventDefault(); props.onCtx(e.clientX, e.clientY); }}
    >
      <span className="tm-nav-ico board"><Ico d={ICO_BOARD} size={13} /></span>
      <span className="tm-nav-t">{props.title}</span>
      {props.count > 0 && <span className="tm-nav-cnt">{props.count}</span>}
    </button>
  );
}

function BacklogNavRow(props: {
  projectId: string; count: number; active: boolean; rail: boolean;
  onOpen: () => void;
  onCtx: (x: number, y: number) => void;
}) {
  if (props.rail) {
    return (
      <button
        type="button"
        className={'tm-rail-item sub' + (props.active ? ' cur' : '')}
        data-tip={'Бэклог · ' + props.count}
        data-drop-backlog={props.projectId}
        aria-label="Бэклог"
        onClick={props.onOpen}
        onContextMenu={(e) => { e.preventDefault(); props.onCtx(e.clientX, e.clientY); }}
      >
        <Ico d={ICO_BACKLOG} size={14} />
      </button>
    );
  }
  return (
    <button
      type="button"
      className={'tm-nav-row sub' + (props.active ? ' cur' : '')}
      data-drop-backlog={props.projectId}
      onClick={props.onOpen}
      onContextMenu={(e) => { e.preventDefault(); props.onCtx(e.clientX, e.clientY); }}
    >
      <span className="tm-nav-ico board"><Ico d={ICO_BACKLOG} size={13} /></span>
      <span className="tm-nav-t">Бэклог</span>
      <span className="tm-nav-cnt">{props.count}</span>
    </button>
  );
}

export function TmSidebar(props: {
  ws: Ws;
  view: { kind: string; projectId?: string; boardId?: string; userId?: string };
  savedId: string | null;
  filtersActive: boolean;
  myCount: number;
  rail: boolean;
  onToggleRail: () => void;
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
  const rail = props.rail;

  /* активный проект: тот, чья доска/бэклог открыта */
  const activePid = view.kind === 'board' || view.kind === 'backlog' ? view.projectId : undefined;

  if (rail) {
    /* РЕЙК: свёрнутый сайдбар — только иконки с подсказками (как rail прототипа) */
    const curProject = ws.projects.find((p) => p.id === activePid);
    return (
      <aside className="tm-side rail" aria-label="Разделы (свёрнуто — наведите для подсказки)">
        <div className="tm-rail-scroll">
          <button type="button" className="tm-rail-item prime" data-tip="Развернуть панель · [" aria-label="Развернуть панель" onClick={props.onToggleRail}>
            <Ico d="M11 19l-7-7 7-7M19 19l-7-7" size={16} />
          </button>
          <button type="button" className={'tm-rail-item' + (view.kind === 'my' ? ' cur' : '')} data-tip={'Мои задачи · ' + props.myCount} aria-label="Мои задачи" onClick={props.onMy}>
            <Ico d={ICO_MY} size={17} />
            {props.myCount > 0 && <span className="tm-rail-cnt">{props.myCount}</span>}
          </button>
          <button type="button" className={'tm-rail-item' + (view.kind === 'teams' ? ' cur' : '')} data-tip="Команды" aria-label="Команды" onClick={props.onTeams}>
            <Ico d={ICO_TEAM} size={17} />
          </button>
          <button type="button" className={'tm-rail-item' + (view.kind === 'people' || view.kind === 'user' ? ' cur' : '')} data-tip="Люди" aria-label="Люди" onClick={props.onPeople}>
            <Ico d={ICO_PEOPLE} size={17} />
          </button>
          <div className="tm-rail-div" />
          {ws.projects.map((p) => (
            <span key={p.id} className="tm-rail-proj">
              <button
                type="button"
                className={'tm-rail-item proj' + (activePid === p.id ? ' cur' : '')}
                style={{ '--c': p.color } as React.CSSProperties}
                data-tip={p.title}
                aria-label={p.title}
                onClick={() => {
                  const b = p.boards[0];
                  if (b) props.onBoard(p.id, b.id);
                  else props.onBacklog(p.id);
                }}
                onContextMenu={(e) => { e.preventDefault(); tmOpenMenu('project', { pid: p.id }, e.clientX, e.clientY); }}
              >
                <span className="tm-rail-ptile" style={{ background: p.color }}>
                  <Ico d={ICO_BOARD} size={13} />
                </span>
              </button>
              {activePid === p.id && (
                <span className="tm-rail-subs">
                  {p.boards.map((b) => (
                    <BoardNavRow
                      key={b.id}
                      rail
                      projectId={p.id}
                      boardId={b.id}
                      title={b.title}
                      count={ws.tasks.filter((t) => t.boardId === b.id && !t.done).length}
                      active={view.kind === 'board' && view.boardId === b.id}
                      onOpen={() => props.onBoard(p.id, b.id)}
                      onCtx={(x, y) => tmOpenMenu('board', { bid: b.id }, x, y)}
                    />
                  ))}
                  <BacklogNavRow
                    rail
                    projectId={p.id}
                    count={ws.tasks.filter((t) => t.projectId === p.id && !t.columnId && !t.done).length}
                    active={view.kind === 'backlog'}
                    onOpen={() => props.onBacklog(p.id)}
                    onCtx={(x, y) => tmOpenMenu('backlog', { pid: p.id }, x, y)}
                  />
                </span>
              )}
            </span>
          ))}
          {!ws.projects.length && (
            <button type="button" className="tm-rail-item sub" data-tip="Новый проект" aria-label="Новый проект" onClick={props.onNewProject}>
              <Ico d="M12 5v14M5 12h14" size={14} />
            </button>
          )}
          <div className="tm-rail-div" />
          {ws.views.map((v) => (
            <span key={v.id} className="tm-rail-proj">
              <button
                type="button"
                className={'tm-rail-item sub' + (props.savedId === v.id ? ' cur' : '')}
                data-tip={'Вид: ' + v.name}
                aria-label={'Вид: ' + v.name}
                onClick={() => props.onApplyView(v)}
                onContextMenu={(e) => { e.preventDefault(); tmOpenMenu('view', { id: v.id, name: v.name }, e.clientX, e.clientY); }}
              >
                <Ico d={ICO_VIEW} size={14} />
              </button>
            </span>
          ))}
          <button type="button" className={'tm-rail-item sub' + (props.filtersActive ? ' hint' : '')} data-tip="Сохранить текущий вид" aria-label="Сохранить вид" onClick={props.onSaveView}>
            <Ico d="M12 5v14M5 12h14" size={14} />
          </button>
        </div>
        <div className="tm-side-foot rail">
          {curProject && <span className="tm-proj-dot" style={{ background: curProject.color }} />}
        </div>
      </aside>
    );
  }

  return (
    <aside className="tm-side" aria-label="Разделы менеджера задач">
      <nav className="tm-nav" role="navigation">
        <button
          type="button"
          className={'tm-nav-row' + (view.kind === 'my' ? ' cur' : '')}
          onClick={props.onMy}
          title="Задачи, где вы исполнитель"
          onContextMenu={(e) => { e.preventDefault(); tmOpenMenu('app', { rail: '0' }, e.clientX, e.clientY); }}
        >
          <span className="tm-nav-ico"><Ico d={ICO_MY} /></span>
          <span className="tm-nav-t">Мои задачи</span>
          {props.myCount > 0 && <span className="tm-nav-cnt">{props.myCount}</span>}
        </button>
        <button
          type="button"
          className={'tm-nav-row' + (view.kind === 'teams' ? ' cur' : '')}
          onClick={props.onTeams}
          title="Команды — доступ к проектам выдаётся командам"
          onContextMenu={(e) => { e.preventDefault(); tmOpenMenu('app', { rail: '0' }, e.clientX, e.clientY); }}
        >
          <span className="tm-nav-ico"><Ico d={ICO_TEAM} /></span>
          <span className="tm-nav-t">Команды</span>
          {ws.teams.length > 0 && <span className="tm-nav-cnt">{ws.teams.length}</span>}
        </button>
        <button
          type="button"
          className={'tm-nav-row' + (view.kind === 'people' || view.kind === 'user' ? ' cur' : '')}
          onClick={props.onPeople}
          title="Люди хаба и их задачи"
          onContextMenu={(e) => { e.preventDefault(); tmOpenMenu('app', { rail: '0' }, e.clientX, e.clientY); }}
        >
          <span className="tm-nav-ico"><Ico d={ICO_PEOPLE} /></span>
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
            <div
              className="tm-proj-head"
              onContextMenu={(e) => { e.preventDefault(); tmOpenMenu('project', { pid: p.id }, e.clientX, e.clientY); }}
            >
              <span className="tm-proj-tile" style={{ background: p.color }}><Ico d={ICO_BOARD} size={12} /></span>
              <button
                type="button"
                className="tm-proj-name"
                title={p.title + ' — двойной клик: переименовать, ПКМ: меню'}
                onDoubleClick={() => props.onRenameProject(p)}
              >
                {p.title}
              </button>
              <span className="tm-proj-acts">
                <button type="button" className="tm-mini" title="Меню проекта: новая доска, задача, доступ…" onClick={(e) => { e.stopPropagation(); tmOpenMenu('project', { pid: p.id }, e.clientX, e.clientY); }}>
                  <Ico d="M12 5v14M5 12h14" size={11} />
                </button>
                <button type="button" className="tm-mini" title="Доступ команд и людей" onClick={() => props.onAccessProject(p)}>
                  <Ico d={ICO_TEAM} size={11} />
                </button>
              </span>
            </div>
            <div className="tm-proj-boards">
              {p.boards.map((b) => (
                <BoardNavRow
                  key={b.id}
                  rail={false}
                  projectId={p.id}
                  boardId={b.id}
                  title={b.title}
                  count={ws.tasks.filter((t) => t.boardId === b.id && !t.done).length}
                  active={view.kind === 'board' && view.projectId === p.id && view.boardId === b.id}
                  onOpen={() => props.onBoard(p.id, b.id)}
                  onCtx={(x, y) => tmOpenMenu('board', { bid: b.id }, x, y)}
                />
              ))}
              <BacklogNavRow
                rail={false}
                projectId={p.id}
                count={ws.tasks.filter((t) => t.projectId === p.id && !t.columnId && !t.done).length}
                active={view.kind === 'backlog' && view.projectId === p.id}
                onOpen={() => props.onBacklog(p.id)}
                onCtx={(x, y) => tmOpenMenu('backlog', { pid: p.id }, x, y)}
              />
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
            <button
              type="button"
              className="tm-nav-row sub"
              onClick={() => props.onApplyView(v)}
              onContextMenu={(e) => { e.preventDefault(); tmOpenMenu('view', { id: v.id, name: v.name }, e.clientX, e.clientY); }}
              title="Применить вид · ПКМ: меню"
            >
              <span className="tm-nav-ico board"><Ico d={ICO_VIEW} size={13} /></span>
              <span className="tm-nav-t">{v.name}</span>
            </button>
            <button type="button" className="tm-view-del" title="Удалить вид" onClick={() => props.onDeleteView(v.id)}>×</button>
          </div>
        ))}
      </nav>
      <div className="tm-side-foot">
        <span>Общее пространство команды</span>
        <button type="button" className="tm-mini" title="Свернуть панель · [" aria-label="Свернуть панель" onClick={props.onToggleRail}>
          <Ico d="M19 12H5M11 6l-6 6 6 6" size={12} />
        </button>
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

/* ═══ канбан-доска ═══
   Перетягивание карточек — ПОИНТЕРНЫЙ движок как в прототипе «Поток»:
   карточка визуально ЗАБИРАЕТСЯ из колонки (на её месте остаётся слот-заглушка,
   рядом с курсором летит призрачная копия), позиция вставки подсвечивается,
   порядок сохраняется дробным order. Во время drag React не перерисовывается —
   весь визуал двигает голый DOM, коммит происходит одним PATCH при drop. */

interface CardDragState {
  el: HTMLElement;
  task: TmTask;
  rect: DOMRect;
  ox: number;
  oy: number;
  px: number;
  py: number;
  sx: number;
  sy: number;
  started: boolean;
  wrap: HTMLElement | null;
  ph: HTMLElement | null;
  cont: HTMLElement | null;
  hint: HTMLElement | null;
  /** цель в сайдбаре (доска/бэклог) — задача улетает туда целиком */
  sb: HTMLElement | null;
  raf: number;
}

interface ColDragState {
  el: HTMLElement;
  colId: string;
  rect: DOMRect;
  ox: number;
  oy: number;
  px: number;
  py: number;
  sx: number;
  sy: number;
  started: boolean;
  wrap: HTMLElement | null;
  ph: HTMLElement | null;
  raf: number;
}

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
  onMove: (t: TmTask, boardId: string, columnId: string, order?: number) => void;
  onPickBoard: (boardId: string) => void;
  onToggleDone: (t: TmTask) => void;
  onQuickAdd: (columnId: string, title: string) => void;
  onAddColumn: (title: string) => void;
  /** перестановка колонок (после DnD): boardId + колонки в новом порядке */
  onReorderColumns: (boardId: string, columnIds: string[]) => void;
  onAddBoard: () => void;
  onRenameBoard: (b: { id: string; title: string }) => void;
  onAccess: () => void;
  headExtra?: React.ReactNode;
}) {
  const { ws } = props;
  const project = ws.projects.find((p) => p.id === props.projectId);
  const board = project?.boards.find((b) => b.id === props.boardId);
  /* drag живёт в ref: никакие setState во время переноса — DOM двигаем руками */
  const drag = useRef<CardDragState | null>(null);
  const colDrag = useRef<ColDragState | null>(null);
  const suppressClick = useRef(0);

  if (!project || !board) {
    return <div className="tm-loading">Доска не найдена</div>;
  }

  const columnTasks = (colId: string): TmTask[] => {
    /* подзадачи живут в колонке рядом с родителем (как в прототипе —
       «подзадача создана — она видна и в колонке») */
    const inCol = ws.tasks.filter((t) => t.columnId === colId && props.matchQuery(t, props.query));
    return props.filtered(inCol).sort((a, b) => a.order - b.order);
  };

  const activeN = ws.tasks.filter((t) => t.boardId === board.id && !t.done && !t.parentId).length;

  /* открыть карточку: сразу после перетягивания клик подавляется */
  const openCard = (t: TmTask) => {
    if (Date.now() < suppressClick.current) return;
    props.onOpen(t);
  };

  /* позиция вставки в колонке: делим карточки серединами по вертикали.
     ПЕРВЫМ ДЕЛОМ проверяем сайдбар (строки досок/бэклога — цели переноса
     между досками и проектами, как в прототипе: ghost.mini + drop-hint) */
  const placePh = (st: CardDragState): void => {
    if (!st.started || !st.ph) return;
    const u = document.elementFromPoint(st.px, st.py);
    /* цель в сайдбаре? */
    let sb: HTMLElement | null = null;
    if (u && u.closest) sb = u.closest<HTMLElement>('[data-drop-board],[data-drop-backlog]');
    if (st.sb && st.sb !== sb) st.sb.classList.remove('drop-hint');
    st.sb = sb;
    if (st.wrap) st.wrap.classList.toggle('mini', !!sb);
    if (sb) {
      sb.classList.add('drop-hint');
      if (st.hint) { st.hint.classList.remove('drop-hint'); st.hint = null; }
      st.cont = null;
      return;
    }
    let cont: HTMLElement | null = null;
    if (u && u.closest) {
      cont = u.closest<HTMLElement>('.tm-kcol-body');
      if (!cont) {
        const kc = u.closest<HTMLElement>('.tm-kcol');
        cont = kc ? kc.querySelector<HTMLElement>('.tm-kcol-body') : null;
      }
    }
    if (!cont || !cont.isConnected || !cont.dataset.col) return;
    st.cont = cont;
    const kcol = cont.closest<HTMLElement>('.tm-kcol');
    if (st.hint !== kcol) {
      if (st.hint) st.hint.classList.remove('drop-hint');
      if (kcol) kcol.classList.add('drop-hint');
      st.hint = kcol;
    }
    const items = Array.from(cont.querySelectorAll<HTMLElement>('.tm-card')).filter((c) => c !== st.el);
    let idx = items.length;
    for (let i = 0; i < items.length; i++) {
      const r = items[i].getBoundingClientRect();
      if (st.py < r.top + r.height / 2) { idx = i; break; }
    }
    const kids = Array.from(cont.children);
    const phIdx = kids.indexOf(st.ph);
    const cur = phIdx < 0 ? -1 : kids.slice(0, phIdx).filter((x) => x.matches('.tm-card') && x !== st.el).length;
    if (st.ph.parentNode !== cont || cur !== idx) {
      const empty = cont.querySelector('.tm-kcol-empty');
      if (empty && items.length === 0) cont.insertBefore(st.ph, empty);
      else cont.insertBefore(st.ph, items[idx] || null);
    }
  };

  const beginCardDrag = (e: React.PointerEvent, t: TmTask): void => {
    if (!props.canEdit || drag.current || colDrag.current) return;
    if (e.pointerType !== 'mouse' || (e.button !== undefined && e.button !== 0)) return;
    /* не тянем за кнопки/поля внутри карточки */
    const target = e.target as Element;
    if (target.closest('button,input,textarea,select,a')) return;
    const el = e.currentTarget as HTMLElement;
    const rect = el.getBoundingClientRect();
    const st: CardDragState = {
      el,
      task: t,
      rect,
      ox: e.clientX - rect.left,
      oy: e.clientY - rect.top,
      px: e.clientX,
      py: e.clientY,
      sx: e.clientX,
      sy: e.clientY,
      started: false,
      wrap: null,
      ph: null,
      cont: null,
      hint: null,
      sb: null,
      raf: 0,
    };
    drag.current = st;
    let finished = false;

    const loop = (): void => {
      if (!st.started || finished) return;
      const kb = document.querySelector('.tm-kanban');
      if (kb) {
        const r = kb.getBoundingClientRect();
        if (st.px < r.left + 80) kb.scrollLeft -= Math.min(20, (r.left + 80 - st.px) / 3);
        else if (st.px > r.right - 80) kb.scrollLeft += Math.min(20, (st.px - (r.right - 80)) / 3);
      }
      const sc = st.cont;
      if (sc && sc.isConnected) {
        const r = sc.getBoundingClientRect();
        if (st.py < r.top + 50) sc.scrollTop -= Math.min(16, (r.top + 50 - st.py) / 3);
        else if (st.py > r.bottom - 50) sc.scrollTop += Math.min(16, (st.py - (r.bottom - 50)) / 3);
      }
      placePh(st);
      st.raf = requestAnimationFrame(loop);
    };

    const start = (): void => {
      st.started = true;
      document.body.classList.add('dragging');
      const wrap = document.createElement('div');
      wrap.className = 'tm-ghostwrap';
      wrap.style.width = st.rect.width + 'px';
      const g = st.el.cloneNode(true) as HTMLElement;
      g.classList.add('tm-ghost');
      g.style.width = st.rect.width + 'px';
      g.style.height = st.rect.height + 'px';
      wrap.appendChild(g);
      document.body.appendChild(wrap);
      st.wrap = wrap;
      const ph = document.createElement('div');
      ph.className = 'tm-dragph';
      ph.style.height = st.rect.height + 'px';
      st.el.parentNode?.insertBefore(ph, st.el);
      st.el.style.display = 'none';
      st.ph = ph;
      wrap.style.transform = 'translate3d(' + (st.px - st.ox) + 'px,' + (st.py - st.oy) + 'px,0)';
      st.raf = requestAnimationFrame(loop);
    };

    const finish = (commit: boolean): void => {
      if (finished) return;
      finished = true;
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      document.removeEventListener('pointercancel', cancel);
      document.removeEventListener('keydown', escH, true);
      cancelAnimationFrame(st.raf);
      /* цель переноса считаем ДО уборки слота: позиция вставки = сколько
         карточек стоит перед заглушкой в её колонке */
      let target: { colId: string; idx: number } | null = null;
      if (commit && st.started && st.cont && st.cont.dataset.col && st.ph) {
        const kids = Array.from(st.cont.children);
        const phIdx = kids.indexOf(st.ph);
        const idx = Math.max(0, kids.slice(0, phIdx < 0 ? kids.length : phIdx).filter((x) => x.matches('.tm-card') && x !== st.el).length);
        target = { colId: st.cont.dataset.col, idx };
      }
      const sidebar = commit && st.started && st.sb
        ? { kind: st.sb.dataset.dropBoard ? ('board' as const) : ('backlog' as const), id: st.sb.dataset.dropBoard || st.sb.dataset.dropBacklog || '' }
        : null;
      if (st.wrap) st.wrap.remove();
      if (st.ph) st.ph.remove();
      st.el.style.display = '';
      if (st.hint) { st.hint.classList.remove('drop-hint'); st.hint = null; }
      if (st.sb) { st.sb.classList.remove('drop-hint'); st.sb = null; }
      document.body.classList.remove('dragging');
      drag.current = null;
      if (!st.started) return;
      suppressClick.current = Date.now() + 260;
      /* перенос на ДРУГУЮ ДОСКУ/БЭКЛОГ через сайдбар — внутри проекта
         и между проектами (сервер сам сменит projectId по колонке) */
      if (sidebar) {
        if (sidebar.kind === 'backlog') props.onMove(st.task, '', '');
        else {
          const b = ws.projects.flatMap((p) => p.boards).find((x) => x.id === sidebar.id);
          const col = b ? (b.columns.find((c) => c.kind === 'new') || b.columns[0]) : null;
          if (b && col) props.onMove(st.task, b.id, col.id);
        }
        return;
      }
      if (target) moveTaskTo(st.task, target.colId, target.idx);
    };

    const move = (ev: PointerEvent): void => {
      st.px = ev.clientX;
      st.py = ev.clientY;
      if (!st.started) {
        if (Math.hypot(ev.clientX - st.sx, ev.clientY - st.sy) < 5) return;
        start();
      }
      if (st.wrap) st.wrap.style.transform = 'translate3d(' + (ev.clientX - st.ox) + 'px,' + (ev.clientY - st.oy) + 'px,0)';
    };
    const up = (): void => finish(true);
    const cancel = (): void => finish(false);
    const escH = (ev: KeyboardEvent): void => { if (ev.key === 'Escape') { ev.stopPropagation(); ev.preventDefault(); finish(false); } };

    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
    document.addEventListener('pointercancel', cancel);
    document.addEventListener('keydown', escH, true);
  };

  /* ═══ перетягивание КОЛОНОК (grip в шапке, порядок сохраняется) ═══ */
  const beginColDrag = (e: React.PointerEvent, colId: string): void => {
    if (!props.canEdit || colDrag.current || drag.current) return;
    if (e.pointerType === 'touch' || (e.button !== undefined && e.button !== 0)) return;
    const el = (e.currentTarget as HTMLElement).closest<HTMLElement>('.tm-kcol');
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const st: ColDragState = {
      el,
      colId,
      rect,
      ox: e.clientX - rect.left,
      oy: e.clientY - rect.top,
      px: e.clientX,
      py: e.clientY,
      sx: e.clientX,
      sy: e.clientY,
      started: false,
      wrap: null,
      ph: null,
      raf: 0,
    };
    colDrag.current = st;
    let finished = false;

    const place = (): void => {
      const kb = document.querySelector<HTMLElement>('.tm-kanban');
      if (!kb) return;
      const items = Array.from(kb.querySelectorAll<HTMLElement>('.tm-kcol')).filter((c) => c !== st.el);
      let idx = items.length;
      for (let i = 0; i < items.length; i++) {
        const r = items[i].getBoundingClientRect();
        if (st.px < r.left + r.width / 2) { idx = i; break; }
      }
      const kids = Array.from(kb.children);
      const phIdx = kids.indexOf(st.ph!);
      const cur = phIdx < 0 ? -1 : kids.slice(0, phIdx).filter((x) => x.matches('.tm-kcol') && x !== st.el).length;
      if (st.ph && (st.ph.parentNode !== kb || cur !== idx)) kb.insertBefore(st.ph, items[idx] || null);
    };

    const loop = (): void => {
      if (!st.started || finished) return;
      const kb = document.querySelector('.tm-kanban');
      if (kb) {
        const r = kb.getBoundingClientRect();
        if (st.px < r.left + 90) kb.scrollLeft -= Math.min(22, (r.left + 90 - st.px) / 3);
        else if (st.px > r.right - 90) kb.scrollLeft += Math.min(22, (st.px - (r.right - 90)) / 3);
      }
      place();
      st.raf = requestAnimationFrame(loop);
    };

    const start = (): void => {
      st.started = true;
      document.body.classList.add('dragging');
      const wrap = document.createElement('div');
      wrap.className = 'tm-ghostwrap col';
      wrap.style.width = st.rect.width + 'px';
      const g = st.el.cloneNode(true) as HTMLElement;
      g.classList.add('tm-ghost');
      g.style.width = st.rect.width + 'px';
      g.style.height = Math.min(st.rect.height, window.innerHeight * 0.7) + 'px';
      wrap.appendChild(g);
      document.body.appendChild(wrap);
      st.wrap = wrap;
      const ph = document.createElement('div');
      ph.className = 'tm-dragph col';
      ph.style.width = st.rect.width + 'px';
      ph.style.height = st.rect.height + 'px';
      st.el.parentNode?.insertBefore(ph, st.el);
      st.el.style.display = 'none';
      st.ph = ph;
      wrap.style.transform = 'translate3d(' + (st.px - st.ox) + 'px,' + (st.py - st.oy) + 'px,0)';
      st.raf = requestAnimationFrame(loop);
    };

    const finish = (commit: boolean): void => {
      if (finished) return;
      finished = true;
      document.removeEventListener('pointermove', move);
      document.removeEventListener('pointerup', up);
      document.removeEventListener('pointercancel', cancel);
      document.removeEventListener('keydown', escH, true);
      cancelAnimationFrame(st.raf);
      const kb = document.querySelector<HTMLElement>('.tm-kanban');
      let ids: string[] | null = null;
      if (commit && st.started && kb && st.ph) {
        /* порядок = заглушка (перетащенная колонка) + все прочие .tm-kcol;
           скрытый оригинал (st.el) исключаем — иначе он задваивает колонку */
        ids = Array.from(kb.children)
          .filter((x) => x === st.ph || (x.matches && x.matches('.tm-kcol') && x !== st.el))
          .map((x) => (x === st.ph ? st.colId : (x as HTMLElement).dataset.col || ''))
          .filter(Boolean);
      }
      if (st.wrap) st.wrap.remove();
      if (st.ph) st.ph.remove();
      st.el.style.display = '';
      document.body.classList.remove('dragging');
      colDrag.current = null;
      if (!st.started) return;
      suppressClick.current = Date.now() + 260;
      if (ids && props.onReorderColumns) props.onReorderColumns(board.id, ids);
    };

    const move = (ev: PointerEvent): void => {
      st.px = ev.clientX;
      st.py = ev.clientY;
      if (!st.started) {
        if (Math.hypot(ev.clientX - st.sx, ev.clientY - st.sy) < 6) return;
        start();
      }
      if (st.wrap) st.wrap.style.transform = 'translate3d(' + (ev.clientX - st.ox) + 'px,' + (ev.clientY - st.oy) + 'px,0)';
    };
    const up = (): void => finish(true);
    const cancel = (): void => finish(false);
    const escH = (ev: KeyboardEvent): void => { if (ev.key === 'Escape') { ev.stopPropagation(); ev.preventDefault(); finish(false); } };

    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', up);
    document.addEventListener('pointercancel', cancel);
    document.addEventListener('keydown', escH, true);
  };

  /* коммит переноса: колонка + позиция → дробный order между соседями */
  const moveTaskTo = (t: TmTask, colId: string, idx: number): void => {
    const col = board.columns.find((c) => c.id === colId);
    if (!col) return;
    const others = ws.tasks.filter((x) => x.columnId === colId && x.id !== t.id).sort((a, b) => a.order - b.order);
    const curIdx = t.columnId === colId ? others.filter((x) => x.order < t.order).length : -1;
    if (t.columnId === colId && curIdx === idx) return; /* позиция не изменилась */
    const prev = others[idx - 1]?.order;
    const next = others[idx]?.order;
    let order: number;
    if (prev !== undefined && next !== undefined) order = (prev + next) / 2;
    else if (prev !== undefined) order = prev + 1000;
    else if (next !== undefined) order = next - 1000;
    else order = 1000;
    props.onMove(t, board.id, colId, order);
  };

  return (
    <div className="tm-boardwrap">
      <TmViewHead
        title={board.title}
        sub={project.title + ' · ' + activeN + ' активных · ПКМ — меню' + (!props.canEdit ? ' · наблюдатель' : '')}
      >
        {props.headExtra}
        <div className="tm-tabs" role="tablist" aria-label="Доски проекта">
          {project.boards.map((b) => {
            const n = ws.tasks.filter((t) => t.boardId === b.id && !t.done && !t.parentId).length;
            return (
              <button
                key={b.id}
                type="button"
                role="tab"
                aria-selected={b.id === board.id}
                className={'tm-tab' + (b.id === board.id ? ' cur' : '')}
                onDoubleClick={() => props.onRenameBoard(b)}
                onClick={() => { if (b.id !== board.id) props.onPickBoard(b.id); }}
                onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); tmOpenMenu('board', { bid: b.id }, e.clientX, e.clientY); }}
                title={b.title + ' — двойной клик: переименовать, ПКМ: меню'}
              >
                {b.title}
                {n > 0 && <span className="tm-tab-cnt">{n}</span>}
              </button>
            );
          })}
          {props.canEdit && <button type="button" className="tm-tab add" title="Новая доска" onClick={props.onAddBoard}>+ доска</button>}
        </div>
        {props.canAdmin && (
          <button type="button" className="btn tm-viewdel" title="Доступ команд и людей к проекту" onClick={props.onAccess}>
            Доступ
          </button>
        )}
        <button
          type="button"
          className="tm-ibtn"
          title="Меню доски"
          aria-label="Меню доски"
          onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); tmOpenMenu('board', { bid: board.id }, r.left, r.bottom + 6); }}
        >
          <svg viewBox="0 0 24 24" width={15} height={15} fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.7" /><circle cx="12" cy="12" r="1.7" /><circle cx="19" cy="12" r="1.7" /></svg>
        </button>
      </TmViewHead>

      <div
        className="tm-kanban"
        onContextMenu={(e) => {
          /* пустое место доски → меню доски (как в прототипе) */
          const t = e.target as Element;
          if (t.closest('.tm-kcol') || t.closest('.tm-kcol-addcol') || !props.canEdit) return;
          e.preventDefault();
          tmOpenMenu('board', { bid: board.id }, e.clientX, e.clientY);
        }}
      >
        {board.columns.map((col) => {
          const tasks = columnTasks(col.id);
          const sysDef = col.kind ? TM_SYS_COL_INFO[col.kind] : null;
          return (
            <section
              key={col.id}
              className="tm-kcol"
              data-col={col.id}
              aria-label={'Колонка ' + col.title}
              onContextMenu={(e) => {
                if (!props.canEdit) return;
                e.preventDefault();
                tmOpenMenu('column', { id: col.id }, e.clientX, e.clientY);
              }}
            >
              <header className="tm-kcol-head" style={{ '--cc': col.color } as React.CSSProperties}>
                {props.canEdit && (
                  <span
                    className="tm-kcol-grip"
                    title="Перетащите колонку — порядок сохранится"
                    onPointerDown={(e) => beginColDrag(e, col.id)}
                    aria-hidden="true"
                  >
                    <svg viewBox="0 0 24 24" width={11} height={11} fill="currentColor" aria-hidden="true"><circle cx="9" cy="6" r="1.4" /><circle cx="15" cy="6" r="1.4" /><circle cx="9" cy="12" r="1.4" /><circle cx="15" cy="12" r="1.4" /><circle cx="9" cy="18" r="1.4" /><circle cx="15" cy="18" r="1.4" /></svg>
                  </span>
                )}
                <span className="tm-kcol-ico" style={{ color: col.color }}><ColumnIcon id={col.icon} size={13} /></span>
                <span className="tm-kcol-title" title={sysDef || col.title}>{col.title}{col.locked && <i title="Системная колонка — задаёт статус задач">🔒</i>}</span>
                <span className="tm-kcol-cnt">{tasks.filter((t) => !t.done).length}</span>
                {props.canEdit && (
                  <button
                    type="button"
                    className="tm-mini"
                    title="Меню колонки"
                    aria-label={'Меню колонки ' + col.title}
                    onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(); tmOpenMenu('column', { id: col.id }, r.left, r.bottom + 6); }}
                  >
                    <svg viewBox="0 0 24 24" width={11} height={11} fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.5" /><circle cx="12" cy="12" r="1.5" /><circle cx="19" cy="12" r="1.5" /></svg>
                  </button>
                )}
              </header>
              <div className="tm-kcol-body" data-col={col.id}>
                {tasks.map((t) => (
                  <TaskCard
                    key={t.id}
                    task={t}
                    ws={ws}
                    userMap={props.userMap}
                    labels={props.labels}
                    onOpen={openCard}
                    onToggleDone={props.onToggleDone}
                    canDrag={props.canEdit}
                    onDragPointerDown={beginCardDrag}
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
  canDrag?: boolean;
  onDragPointerDown?: (e: React.PointerEvent, t: TmTask) => void;
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
      className={'tm-card' + (t.done ? ' done' : '') + (t.color ? ' colored' : '') + (props.canDrag ? ' grab' : '')}
      onPointerDown={props.canDrag ? (e) => props.onDragPointerDown?.(e, t) : undefined}
      onClick={() => props.onOpen(t)}
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); tmOpenMenu('card', { id: t.id }, e.clientX, e.clientY); }}
      role="button"
      tabIndex={0}
      style={{ '--pc': prio?.color || 'var(--line2)', ...colorVars(t.color, t.colorAlpha) } as React.CSSProperties}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); props.onOpen(t); } }}
    >
      {t.parentId && (() => {
        const par = props.ws.tasks.find((x) => x.id === t.parentId);
        return (
          <button
            type="button"
            className="tm-child-tag"
            title={'Открыть родительскую задачу: ' + (par?.title || '')}
            onClick={(e) => { e.stopPropagation(); if (par) { try { window.dispatchEvent(new CustomEvent('tm-open-task', { detail: par.id })); } catch { /* нет CustomEvent */ } } }}
          >↳ подзадача · {par ? par.title : '—'}</button>
        );
      })()}
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
    <div
      className={'tm-row' + (t.done ? ' done' : '') + (t.color ? ' colored' : '')}
      onClick={() => props.onOpen(t)}
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); tmOpenMenu('card', { id: t.id }, e.clientX, e.clientY); }}
      role="button"
      tabIndex={0}
      style={{ '--pc': prio?.color || 'var(--line2)', ...colorVars(t.color, t.colorAlpha) } as React.CSSProperties}
      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); props.onOpen(t); } }}
    >
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
  /* подзадачи бэклога тоже видны — с меткой «↳ подзадача» (как в прототипе) */
  const tasks = props.filtered(
    props.ws.tasks.filter((t) => t.projectId === props.projectId && !t.columnId && props.matchQuery(t, props.query)),
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
  onEditTeam: (t: TmTeam, mode?: 'members' | 'settings') => void;
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
            <div className="tm-teamcard" key={t.id} style={{ '--tc': t.color } as React.CSSProperties}
              onContextMenu={(e) => { e.preventDefault(); tmOpenMenu('team', { id: t.id, name: t.name }, e.clientX, e.clientY); }}
            >
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
                <button type="button" className="btn tm-row-act" onClick={() => props.onEditTeam(t, 'members')}>Состав</button>
                <button type="button" className="btn tm-row-act" onClick={() => props.onEditTeam(t, 'settings')}>Настройки</button>
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
  /** отдельные окна (как просил пользователь): Состав — только участники,
      Настройки — только название/цвет/иконка/удаление; null — всё сразу */
  mode?: 'members' | 'settings' | null;
  onClose: () => void;
  onSave: (payload: Record<string, unknown>, id?: string) => Promise<boolean>;
  onDelete: (t: TmTeam) => void;
}) {
  const t = props.team;
  const mode = props.mode || (t ? null : null); /* null = всё сразу */
  const [name, setName] = useState(t?.name || '');
  const [color, setColor] = useState(t?.color || TM_PALETTE[0]);
  const [icon, setIcon] = useState(t?.icon || 'shield');
  const [members, setMembers] = useState<Set<string>>(() => new Set(t?.members.map((m) => m.login) || []));
  const [busy, setBusy] = useState(false);

  const showMembers = mode === 'members';
  const showSettings = mode === 'settings' || mode === null;
  const showMemberList = mode === 'members' || mode === null;

  const submit = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    const ok = await props.onSave({ name: name.trim(), color, icon, members: [...members] }, t?.id);
    setBusy(false);
    if (ok) props.onClose();
  };

  return (
    <div className="tm-modal-scrim" role="dialog" aria-label={t ? (mode === 'members' ? 'Состав команды' : 'Настройки команды') : 'Новая команда'} onClick={(e) => { if (e.target === e.currentTarget) props.onClose(); }}>
      <div className="tm-modal">
        <div className="tm-modal-head">
          <span>{t ? (mode === 'members' ? 'Состав · ' + t.name : 'Настройки · ' + t.name) : 'Новая команда'}</span>
          <button type="button" className="btn ibtn" onClick={props.onClose} aria-label="Закрыть">×</button>
        </div>
        <div className="tm-modal-body">
          {showSettings && (
            <>
              <label className="tm-f">
                <span>Название команды <i>*</i></span>
                <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Например: Сюжетная группа" maxLength={40} autoFocus />
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
            </>
          )}
          {showMemberList && (
            <div className="tm-f">
              <span>Состав · {props.users.length} чел.{showMembers ? ' · клик переключает' : ''}</span>
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
          )}
        </div>
        <div className="tm-modal-foot">
          {t && mode === 'settings' && <button type="button" className="btn danger" onClick={() => props.onDelete(t)}>Удалить</button>}
          <span className="tm-modal-sp" />
          <button type="button" className="btn" onClick={props.onClose}>Отмена</button>
          <button type="button" className="btn primary" disabled={!name.trim() || busy} onClick={() => void submit()}>
            {busy ? 'Сохраняю…' : 'Сохранить'}
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
