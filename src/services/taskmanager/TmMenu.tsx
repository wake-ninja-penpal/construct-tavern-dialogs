'use client';

/**
 * Контекстные меню (ПКМ) по всему менеджеру задач — порт движка поповеров
 * прототипа «Поток» (#popover.ctx + openPopAt). Модульный стор: любой
 * компонент вызывает tmOpenMenu(kind, ctx, x, y), хост TmMenuHost (один на
 * приложение) рисует меню по роду: карточка задачи, колонка (название,
 * порядок, иконка, цвет, всё в бэклог, удаление), доска, проект, бэклог,
 * сохранённый вид, команда, человек, общий fallback. Закрытие — клик мимо,
 * Esc, скролл, ресайз. Вложенные подменю («На доску…», судьба задач при
 * удалении колонки) живут внутри того же поповера, как в прототипе.
 */

import { Fragment, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';

import { TM_PALETTE, TM_SYS_COL_INFO, TM_TASK_PALETTE, type TmColumn, type TmProject, type TmTask } from './tmTypes';
import { ColumnIcon, TM_COLUMN_ICONS } from './icons';
import { MD_TOOLS } from './md';
import { MdToolIcon } from './mdIcons';
import type { Ws } from './TaskManagerApp';

/* ── модульный стор состояния меню ── */

export type TmMenuKind = 'card' | 'column' | 'board' | 'project' | 'backlog' | 'view' | 'team' | 'user' | 'app' | 'color' | 'comment' | 'mdsel' | 'mdfmt';

export interface TmMenuState {
  kind: TmMenuKind;
  ctx: Record<string, string> | null;
  x: number;
  y: number;
  n: number; /* счётчик открытий — перерисовка даже на том же месте */
}

let menuState: TmMenuState | null = null;
const subs = new Set<() => void>();

export function tmOpenMenu(kind: TmMenuKind, ctx: Record<string, string> | null, x: number, y: number): void {
  menuState = { kind, ctx, x, y, n: (menuState?.n || 0) + 1 };
  subs.forEach((f) => f());
}

export function tmCloseMenu(): void {
  if (!menuState) return;
  menuState = null;
  subs.forEach((f) => f());
}

/** Точка открытия текущего меню (подменю «Цвет…» открывается там же). */
export function tmMenuPos(): { x: number; y: number } | null {
  return menuState ? { x: menuState.x, y: menuState.y } : null;
}

function subscribe(f: () => void): () => void {
  subs.add(f);
  return () => subs.delete(f);
}

function snapshot(): TmMenuState | null {
  return menuState;
}

/* ── иконка-помощник для пунктов меню ── */

function I(props: { d: string; size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={props.size ?? 14} height={props.size ?? 14} fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={props.d} />
    </svg>
  );
}

/* ── каркасы пунктов ── */

function MTitle(props: { icon?: React.ReactNode; text: string }) {
  return (
    <div className="tm-m-title">
      {props.icon}
      <span>{props.text}</span>
    </div>
  );
}

function MItem(props: {
  icon?: React.ReactNode;
  label: string;
  danger?: boolean;
  disabled?: boolean;
  hk?: string;
  dot?: string;
  sub?: string;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      className={'tm-m-item' + (props.danger ? ' danger' : '')}
      disabled={props.disabled}
      /* mousedown не трогаем: фокус остаётся в редакторе, выделение в
         contenteditable не сбрасывается (важно для меню форматирования) */
      onMouseDown={(e) => { e.preventDefault(); }}
      onClick={props.onClick}
    >
      {props.dot ? <span className="tm-m-dot" style={{ background: props.dot }} /> : props.icon}
      <span className="tm-m-l">{props.label}</span>
      {props.sub && <span className="tm-m-sub">{props.sub}</span>}
      {props.hk && <kbd className="tm-m-hk">{props.hk}</kbd>}
    </button>
  );
}

const MSep = () => <div className="tm-m-sep" />;

/* ── хост меню ── */

export function TmMenuHost(props: {
  ws: Ws;
  act: (name: string, arg?: unknown) => void;
  canEdit: (projectId: string) => boolean;
  canAdmin: (projectId: string) => boolean;
}) {
  const st = useSyncExternalStore(subscribe, snapshot, snapshot);
  const { ws, act } = props;
  const panelRef = useRef<HTMLDivElement>(null);

  /* позиция: в границах окна (как placePop прототипа) — правим DOM до отрисовки */
  useLayoutEffect(() => {
    const p = panelRef.current;
    if (!p) return;
    const x = st?.x ?? 0;
    const y = st?.y ?? 0;
    const r = p.getBoundingClientRect();
    const left = Math.min(Math.max(8, x), Math.max(8, window.innerWidth - r.width - 8));
    let top = y;
    if (top + r.height > window.innerHeight - 8) top = Math.max(8, window.innerHeight - r.height - 8);
    p.style.left = Math.round(left) + 'px';
    p.style.top = Math.round(top) + 'px';
  }, [st]);

  /* закрытие: клик мимо, Esc, скролл снаружи, ресайз */
  useEffect(() => {
    if (!st) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Element;
      if (t.closest && t.closest('.tm-menu')) return;
      tmCloseMenu();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); tmCloseMenu(); } };
    const onScroll = (e: Event) => {
      const t = e.target as Element;
      if (t.closest && t.closest('.tm-menu')) return;
      tmCloseMenu();
    };
    const onResize = () => tmCloseMenu();
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    };
  }, [st]);

  if (!st || !ws) return null;
  const c = st.ctx || {};

  /* сущности по ctx — если исчезли, меню закрывается */
  const task: TmTask | null = c.id ? ws.tasks.find((t) => t.id === c.id) || null : null;
  const column: TmColumn | null = c.id && (st.kind === 'column') ? findColumn(ws, c.id) : null;
  const project: TmProject | null = c.pid ? ws.projects.find((p) => p.id === c.pid) || null : null;

  if ((st.kind === 'card' || st.kind === 'color') && !task) return null;
  if (st.kind === 'column' && !column) return null;

  return (
    <div
      ref={panelRef}
      className="tm-menu"
      role="menu"
      style={{ left: -9999, top: -9999 }}
    >
      {st.kind === 'card' && task && <CardMenu ws={ws} task={task} act={act} canEdit={props.canEdit(task.projectId)} />}
      {st.kind === 'color' && task && <ColorMenu task={task} act={act} />}
      {st.kind === 'column' && column && <ColumnMenu ws={ws} col={column} act={act} />}
      {st.kind === 'board' && <BoardMenu ws={ws} boardId={c.bid || ''} act={act} />}
      {st.kind === 'project' && project && <ProjectMenu ws={ws} project={project} act={act} canEdit={props.canEdit(project.id)} canAdmin={props.canAdmin(project.id)} />}
      {st.kind === 'backlog' && project && <BacklogMenu project={project} act={act} canEdit={props.canEdit(project.id)} />}
      {st.kind === 'view' && <ViewMenu id={c.id || ''} name={c.name || 'Вид'} act={act} />}
      {st.kind === 'team' && <TeamMenu id={c.id || ''} name={c.name || ''} act={act} />}
      {st.kind === 'user' && <UserMenu ws={ws} login={c.login || ''} act={act} />}
      {st.kind === 'app' && <AppMenu act={act} rail={c.rail === '1'} />}
      {st.kind === 'comment' && <CommentMenu ctx={c} act={act} />}
      {st.kind === 'mdsel' && <MdSelMenu ctx={c} act={act} />}
      {st.kind === 'mdfmt' && <MdFmtMenu ctx={c} act={act} />}
    </div>
  );
}

function findColumn(ws: Ws, id: string): TmColumn | null {
  for (const p of ws.projects) for (const b of p.boards) for (const col of b.columns) if (col.id === id) return col;
  return null;
}

/* ── меню карточки/строки задачи ── */

function CardMenu(props: { ws: Ws; task: TmTask; act: (n: string, a?: unknown) => void; canEdit: boolean }) {
  const { ws, task, act } = props;
  const [moveOpen, setMoveOpen] = useState(false);
  const [moveBid, setMoveBid] = useState<string | null>(null);
  const project = ws.projects.find((p) => p.id === task.projectId);
  const otherProjects = ws.projects.filter((p) => p.id !== task.projectId);
  const moveBoard = moveBid ? ws.projects.flatMap((p) => p.boards).find((b) => b.id === moveBid) : null;
  return (
    <>
      <MTitle icon={<I d="M8 4h9a1 1 0 0 1 1 1v15l-3-2-3 2-3-2-3 2V5a1 1 0 0 1 1-1z" />} text={task.title} />
      {task.parentId && <MItem icon={<I d="M9 6h6l3 6-3 6H9M12 9v10" />} label="К родительской задаче" onClick={() => act('open-task', task.parentId)} />}
      <MItem icon={<I d="M4 20l4-1L20 7l-3-3L5 16z" />} label="Открыть задачу" hk="Enter" onClick={() => act('open-task', task.id)} />
      {props.canEdit && <MItem icon={task.done ? <I d="M3 12a9 9 0 1 0 3-6.7M3 4v5h5" /> : <I d="M20 7 10 17l-6-6" />} label={task.done ? 'Вернуть в работу' : 'Выполнить'} onClick={() => act('toggle-done', task.id)} />}
      {props.canEdit && <MItem icon={<I d="M12 3a7 7 0 0 1 7 7c0 4-3 6-4.5 8H9.5C8 16 5 14 5 10a7 7 0 0 1 7-7zM10 21h4" />} label="Цвет задачи…" onClick={() => act('color-pop', task.id)} />}
      {props.canEdit && task.boardId && <MItem icon={<I d="M4 7h16M4 12h10M4 17h7" />} label="В бэклог" onClick={() => act('move-task', { id: task.id, boardId: null })} />}
      {props.canEdit && !task.parentId && <MItem icon={<I d="M8 8l-4 4 4 4M16 8l4 4-4 4" />} label="Дочерняя задача" onClick={() => act('add-child', task.id)} />}
      {props.canEdit && <MItem icon={<I d="M8 8h8v8H8zM4 4h5M4 4v5M20 20h-5M20 20v-5M4 15v5h5M20 9V4h-5" />} label="Дублировать" onClick={() => act('dup-task', task.id)} />}
      {props.canEdit && (
        <>
          <MSep />
          <MItem icon={<I d="M6 6l12 12M18 6 6 18" />} label="Удалить" hk="Del" danger onClick={() => act('del-task', task.id)} />
        </>
      )}
      {!props.canEdit && !task.parentId && (
        /* наблюдателю тоже нужен перенос между досками? Нет — правки недоступны */
        null
      )}
      {props.canEdit && (
        <>
          <MSep />
          {moveBoard ? (
            <>
              <div className="tm-m-cap">{moveBoard.title} → колонка</div>
              {moveBoard.columns.map((col) => (
                <MItem key={col.id} dot={col.color} label={col.title} onClick={() => act('move-task', { id: task.id, columnId: col.id })} />
              ))}
              <MItem icon={<I d="M3 12a9 9 0 1 0 3-6.7M3 4v5h5" />} label="Назад" onClick={() => setMoveBid(null)} />
            </>
          ) : moveOpen ? (
            <>
              <div className="tm-m-cap">Переместить задачу</div>
              <MItem icon={<I d="M4 7h16M4 12h10M4 17h7" />} label={'Бэклог · ' + (project?.title || '')} onClick={() => act('move-task', { id: task.id, boardId: null })} />
              {(project?.boards || []).map((b) => (
                <MItem key={b.id} icon={<I d="M4 4h6.5v16H4zM13.5 4H20v10h-6.5z" />} label={b.title} sub={b.columns.length + ' кол.'} onClick={() => setMoveBid(b.id)} />
              ))}
              {otherProjects.length > 0 && <MSep />}
              {otherProjects.map((p) => (
                <div key={p.id}>
                  <div className="tm-m-cap">{p.title}</div>
                  {p.boards.map((b) => (
                    <MItem key={b.id} icon={<I d="M4 4h6.5v16H4zM13.5 4H20v10h-6.5z" />} label={b.title} sub={b.columns.length + ' кол.'} onClick={() => act('move-task', { id: task.id, columnId: (b.columns.find((x) => x.kind === 'new') || b.columns[0])?.id || '' })} />
                  ))}
                  {p.boards.length === 0 && <MItem icon={<I d="M4 7h16M4 12h10M4 17h7" />} label={'Бэклог · ' + p.title} onClick={() => act('move-task', { id: task.id, boardId: null })} />}
                </div>
              ))}
              <MItem icon={<I d="M3 12a9 9 0 1 0 3-6.7M3 4v5h5" />} label="Назад" onClick={() => setMoveOpen(false)} />
            </>
          ) : (
            <MItem icon={<I d="M5 12h14M13 6l6 6-6 6" />} label="На доску…" onClick={() => setMoveOpen(true)} />
          )}
        </>
      )}
    </>
  );
}

/* ── меню цвета задачи (палитра + плотность + предпросмотр) ── */

function ColorMenu(props: { task: TmTask; act: (n: string, a?: unknown) => void }) {
  const t = props.task;
  const [alpha, setAlpha] = useState(Math.round((t.colorAlpha ?? 0.2) * 100));
  const alphaT = useRef<ReturnType<typeof setTimeout> | null>(null);
  const setAlphaDeb = (v: number) => {
    setAlpha(v);
    if (alphaT.current) clearTimeout(alphaT.current);
    alphaT.current = setTimeout(() => props.act('color-alpha', { id: t.id, alpha: v / 100 }), 250);
  };
  return (
    <>
      <MTitle icon={<I d="M12 3a7 7 0 0 1 7 7c0 4-3 6-4.5 8H9.5C8 16 5 14 5 10a7 7 0 0 1 7-7zM10 21h4" />} text="Цвет задачи" />
      <div className="tm-m-swatches">
        <button type="button" className={'tm-m-sw none' + (!t.color ? ' on' : '')} title="Без цвета" onClick={() => props.act('color-set', { id: t.id, color: null })}>
          <svg viewBox="0 0 24 24" width={12} height={12} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
        </button>
        {TM_TASK_PALETTE.map((col) => (
          <button key={col} type="button" className={'tm-m-sw' + (t.color === col ? ' on' : '')} style={{ background: col }} title={col} onClick={() => props.act('color-set', { id: t.id, color: col })} />
        ))}
      </div>
      {t.color && (
        <div className="tm-m-alpha">
          <input type="range" min={4} max={80} value={alpha} aria-label="Плотность заливки" onChange={(e) => setAlphaDeb(parseInt(e.target.value, 10))} />
          <b>{alpha}%</b>
        </div>
      )}
      <div className="tm-m-demo" style={t.color ? { background: `color-mix(in srgb, ${t.color} ${alpha}%, #14161a)`, borderColor: `color-mix(in srgb, ${t.color} 45%, #2b2f37)` } : undefined}>
        {t.title.slice(0, 42) || 'Предпросмотр'}
      </div>
    </>
  );
}

/* ── меню колонки ── */

function ColumnMenu(props: { ws: Ws; col: TmColumn; act: (n: string, a?: unknown) => void }) {
  const { ws, col, act } = props;
  const board = ws.projects.flatMap((p) => p.boards).find((b) => b.id === col.boardId);
  const cols = board?.columns || [];
  const idx = cols.findIndex((x) => x.id === col.id);
  const [name, setName] = useState(col.title);
  const [fate, setFate] = useState(false);
  const t = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sysDef = col.kind ? TM_SYS_COL_INFO[col.kind] : null;
  const inCol = ws.tasks.filter((x) => x.columnId === col.id).length;
  useEffect(() => () => { if (t.current) clearTimeout(t.current); }, []);
  const rename = (v: string) => {
    setName(v);
    if (t.current) clearTimeout(t.current);
    t.current = setTimeout(() => {
      const nv = v.trim();
      if (nv && nv !== col.title) act('col-rename', { id: col.id, title: nv });
    }, 400);
  };
  if (fate) {
    return (
      <>
        <MTitle icon={<I d="M4 7h16M4 12h10M4 17h7" />} text={'Удалить «' + col.title + '»'} />
        <div className="tm-m-cap">Что сделать с задачами ({inCol})?</div>
        <MItem icon={<I d="M4 7h16M4 12h10M4 17h7" />} label="Переместить в бэклог" onClick={() => act('col-del', { id: col.id, fate: 'backlog' })} />
        <MItem icon={<I d="M6 6l12 12M18 6 6 18" />} label="Удалить вместе с задачами" danger onClick={() => act('col-del', { id: col.id, fate: 'delete' })} />
        <MSep />
        <MItem icon={<I d="M3 12a9 9 0 1 0 3-6.7M3 4v5h5" />} label="Назад" onClick={() => setFate(false)} />
      </>
    );
  }
  return (
    <>
      <MTitle icon={<ColumnIcon id={col.icon} size={13} />} text={col.title} />
      <div className="tm-m-sec">
        <div className="tm-m-cap">Название</div>
        <input className="tm-m-inp" value={name} maxLength={30} onChange={(e) => rename(e.target.value)} onFocus={(e) => e.currentTarget.select()} aria-label="Название колонки" />
        {sysDef && <p className="tm-m-note">{sysDef}</p>}
      </div>
      <div className="tm-m-sec">
        <div className="tm-m-cap">Порядок колонок</div>
        <div className="tm-m-two">
          <button type="button" className="btn" disabled={idx <= 0} onClick={() => act('col-move', { id: col.id, dir: -1 })}>← Влево</button>
          <button type="button" className="btn" disabled={idx < 0 || idx >= cols.length - 1} onClick={() => act('col-move', { id: col.id, dir: 1 })}>Вправо →</button>
        </div>
      </div>
      <div className="tm-m-sec">
        <div className="tm-m-cap">Иконка</div>
        {col.locked ? (
          <p className="tm-m-note">Иконка системной колонки неизменяема — она задаёт статус задач на нодах «Ветвей».</p>
        ) : (
          <div className="tm-m-icons">
            {TM_COLUMN_ICONS.map((ic) => (
              <button key={ic.id} type="button" className={col.icon === ic.id ? 'on' : ''} title={ic.title} onClick={() => act('col-icon', { id: col.id, icon: ic.id })}>
                <ColumnIcon id={ic.id} size={14} />
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="tm-m-sec">
        <div className="tm-m-cap">Цвет</div>
        <div className="tm-m-swatches">
          {TM_PALETTE.map((col2) => (
            <button key={col2} type="button" className={'tm-m-sw' + (col.color === col2 ? ' on' : '')} style={{ background: col2 }} title={col2} onClick={() => act('col-color', { id: col.id, color: col2 })} />
          ))}
        </div>
      </div>
      <MSep />
      <MItem icon={<I d="M4 7h16M4 12h10M4 17h7" />} label={'Всё в бэклог' + (inCol ? ' (' + inCol + ')' : '')} disabled={inCol === 0} onClick={() => act('col-clear', col.id)} />
      {col.locked
        ? <MItem icon={<I d="M7 11V8a5 5 0 0 1 10 0v3M5 11h14v9H5z" />} label="Удалить нельзя — системная" disabled />
        : <MItem icon={<I d="M6 6l12 12M18 6 6 18" />} label="Удалить колонку" danger onClick={() => setFate(true)} />}
    </>
  );
}

/* ── меню доски (ПКМ на пустом месте канбана / «⋯» / доска в сайдбаре) ── */

function BoardMenu(props: { ws: Ws; boardId: string; act: (n: string, a?: unknown) => void }) {
  const { boardId, act, ws } = props;
  const board = ws.projects.flatMap((p) => p.boards).find((b) => b.id === boardId);
  const [name, setName] = useState(board?.title || '');
  const t = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (t.current) clearTimeout(t.current); }, []);
  if (!board) return null;
  const rename = (v: string) => {
    setName(v);
    if (t.current) clearTimeout(t.current);
    t.current = setTimeout(() => {
      const nv = v.trim();
      if (nv && nv !== board.title) act('board-rename', { id: board.id, title: nv });
    }, 400);
  };
  return (
    <>
      <MTitle icon={<I d="M4 4h6.5v16H4zM13.5 4H20v10h-6.5z" />} text={board.title} />
      <div className="tm-m-sec">
        <div className="tm-m-cap">Название доски</div>
        <input className="tm-m-inp" value={name} maxLength={40} onChange={(e) => rename(e.target.value)} onFocus={(e) => e.currentTarget.select()} aria-label="Название доски" />
      </div>
      <MItem icon={<I d="M12 5v14M5 12h14" />} label="Новая колонка" onClick={() => act('add-column', board.id)} />
      <MItem icon={<I d="M12 5v14M5 12h14" />} label="Новая задача" onClick={() => act('new-task', { projectId: board.projectId, boardId: board.id })} />
      <MItem icon={<I d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z" />} label="Доступ команд и людей" onClick={() => act('access-project', board.projectId)} />
      <MSep />
      <MItem icon={<I d="M6 6l12 12M18 6 6 18" />} label="Удалить доску" danger onClick={() => act('del-board', board.id)} />
    </>
  );
}

/* ── меню проекта ── */

function ProjectMenu(props: { ws: Ws; project: TmProject; act: (n: string, a?: unknown) => void; canEdit: boolean; canAdmin: boolean }) {
  const { project, act } = props;
  return (
    <>
      <MTitle icon={<span className="tm-m-ptile" style={{ background: project.color }} />} text={project.title} />
      <MItem icon={<I d="M4 4h6.5v16H4zM13.5 4H20v10h-6.5z" />} label="Открыть проект" onClick={() => act('open-project', project.id)} />
      {props.canEdit && <MItem icon={<I d="M12 5v14M5 12h14" />} label="Новая доска" onClick={() => act('add-board', project.id)} />}
      {props.canEdit && <MItem icon={<I d="M12 5v14M5 12h14" />} label="Новая задача" onClick={() => act('new-task', { projectId: project.id })} />}
      <MItem icon={<I d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z" />} label="Доступ команд и людей" onClick={() => act('access-project', project.id)} />
      {props.canEdit && <MItem icon={<I d="M4 20l4-1L20 7l-3-3L5 16z" />} label="Переименовать проект" onClick={() => act('rename-project', project.id)} />}
      <MSep />
      {props.canAdmin && <MItem icon={<I d="M6 6l12 12M18 6 6 18" />} label="Удалить проект" danger onClick={() => act('del-project', project.id)} />}
    </>
  );
}

/* ── меню бэклога ── */

function BacklogMenu(props: { project: TmProject; act: (n: string, a?: unknown) => void; canEdit: boolean }) {
  const { project, act } = props;
  return (
    <>
      <MTitle icon={<I d="M4 7h16M4 12h10M4 17h7" />} text={'Бэклог · ' + project.title} />
      <MItem icon={<I d="M5 12h14M13 6l6 6-6 6" />} label="Открыть бэклог" onClick={() => act('open-backlog', project.id)} />
      {props.canEdit && <MItem icon={<I d="M12 5v14M5 12h14" />} label="Новая задача в бэклоге" onClick={() => act('new-task', { projectId: project.id, backlog: '1' })} />}
      <MItem icon={<I d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z" />} label="Доступ" onClick={() => act('access-project', project.id)} />
      {props.canEdit && <MItem icon={<I d="M4 20l4-1L20 7l-3-3L5 16z" />} label="Переименовать проект" onClick={() => act('rename-project', project.id)} />}
    </>
  );
}

/* ── меню сохранённого вида ── */

function ViewMenu(props: { id: string; name: string; act: (n: string, a?: unknown) => void }) {
  return (
    <>
      <MTitle icon={<I d="M19 21l-7-4.5L5 21V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z" />} text={props.name} />
      <MItem icon={<I d="M5 12h14M13 6l6 6-6 6" />} label="Открыть вид" onClick={() => props.act('open-view', props.id)} />
      <MItem icon={<I d="M6 6l12 12M18 6 6 18" />} label="Удалить вид" danger onClick={() => props.act('del-view', props.id)} />
    </>
  );
}

/* ── меню команды ── */

function TeamMenu(props: { id: string; name: string; act: (n: string, a?: unknown) => void }) {
  return (
    <>
      <MTitle icon={<I d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z" />} text={props.name} />
      <MItem icon={<I d="M4 20l4-1L20 7l-3-3L5 16z" />} label="Настройки команды" onClick={() => props.act('open-team', { id: props.id, mode: 'settings' })} />
      <MItem icon={<I d="M8.5 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM2.5 19c.6-3 3-5 6-5s5.4 2 6 5M16 4.5a3 3 0 0 1 0 6M17.5 14c2 .7 3.4 2.3 4 5" />} label="Состав команды" onClick={() => props.act('open-team', { id: props.id, mode: 'members' })} />
      <MSep />
      <MItem icon={<I d="M6 6l12 12M18 6 6 18" />} label="Удалить команду" danger onClick={() => props.act('del-team', props.id)} />
    </>
  );
}

/* ── меню человека ── */

function UserMenu(props: { ws: Ws; login: string; act: (n: string, a?: unknown) => void }) {
  void props.ws;
  return (
    <>
      <MTitle icon={<I d="M8.5 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM2.5 19c.6-3 3-5 6-5s5.4 2 6 5" />} text={props.login} />
      <MItem icon={<I d="M9 6h6l3 6-3 6H9" />} label="Задачи участника" onClick={() => props.act('open-user', props.login)} />
    </>
  );
}

/* ── меню комментария чата: ответить / реагировать / копировать / править / удалить ── */

const TM_REACTS = ['👍', '❤️', '😂', '🔥', '🙏', '👀'];

function CommentMenu(props: { ctx: Record<string, string>; act: (n: string, a?: unknown) => void }) {
  const c = props.ctx;
  const mine = c.mine === '1';
  const [reactsOpen, setReactsOpen] = useState(false);
  if (reactsOpen) {
    return (
      <>
        <MTitle icon={<I d="M9 12l2 2 4-5M12 3a9 9 0 1 0 .3 0z" />} text="Реакция" />
        <div className="tm-m-reacts">
          {TM_REACTS.map((r) => (
            <button key={r} type="button" onClick={() => props.act('msg-react', { taskId: c.taskId, msgId: c.msgId, react: r })}>{r}</button>
          ))}
        </div>
        <MSep />
        <MItem icon={<I d="M3 12a9 9 0 1 0 3-6.7M3 4v5h5" />} label="Назад" onClick={() => setReactsOpen(false)} />
      </>
    );
  }
  return (
    <>
      <MTitle icon={<I d="M21 12a8 8 0 0 1-8 8H4l2-3a8 8 0 1 1 15-5z" />} text={'Комментарий · @' + (c.login || '')} />
      <MItem icon={<I d="M10 9V5l-7 7 7 7v-4.1c5 0 8.5 1.6 11 5.1-1-5-4-10-11-11z" />} label="Ответить" onClick={() => props.act('msg-reply', { taskId: c.taskId, msgId: c.msgId, login: c.login })} />
      <MItem icon={<I d="M12 21c-4.4 0-8-3.6-8-8s3.6-8 8-8 8 3.6 8 8-3.6 8-8 8zM9 12l2 2 4-5" />} label="Реагировать…" onClick={() => setReactsOpen(true)} />
      <MItem icon={<I d="M8 8h12v12H8zM4 4h12v3M4 4v12h3" />} label="Копировать текст" onClick={() => props.act('msg-copy', { msgId: c.msgId })} />
      {mine && <MItem icon={<I d="M4 20l4-1L20 7l-3-3L5 16z" />} label="Редактировать" onClick={() => props.act('msg-edit', { taskId: c.taskId, msgId: c.msgId })} />}
      <MSep />
      <MItem icon={<I d="M6 6l12 12M18 6 6 18" />} label="Удалить" danger onClick={() => props.act('msg-del', { taskId: c.taskId, msgId: c.msgId, text: c.text || '' })} />
    </>
  );
}

/* ── меню выделенного фрагмента в WYSIWYG-редакторе: цитировать в
   комментарий (готовая цитата "> …" уезжает в композер чата задачи) ── */

function MdSelMenu(props: { ctx: Record<string, string>; act: (n: string, a?: unknown) => void }) {
  return (
    <>
      <MTitle icon={<I d="M5 4h14v4H5zM5 14h9v6H5zM14 16h5v4h-5z" />} text="Выделенный фрагмент" />
      <MItem icon={<I d="M6 17c0-4 1-7 4-10M12 17c0-4 1-7 4-10M4 17h6M10 17h6" />} label="Цитировать в комментарий" onClick={() => props.act('md-quote', { text: props.ctx.text || '' })} />
      <MItem icon={<I d="M8 8h12v12H8zM4 4h12v3M4 4v12h3" />} label="Копировать" onClick={() => props.act('md-copy-sel', { text: props.ctx.plain || '' })} />
    </>
  );
}

/* ── контекстное меню редактора описания (ПКМ): ВСЕ инструменты
   форматирования панели (жирный/курсив/зачёркнутый/заголовок/цитата/
   списки/чек-лист/код/блок кода/ссылка/картинка/таблица/разделитель),
   применяются к выделенному фрагменту (или от каретки), плюс
   «цитировать в комментарий» и «Копировать» при непустом выделении.
   Адресат — владелец стэша выделения (owner): событие 'tm-md-tool'
   обрабатывает ТОЛЬКО редактор, вызвавший меню. ── */

function MdFmtMenu(props: { ctx: Record<string, string>; act: (n: string, a?: unknown) => void }) {
  const hasSel = props.ctx.hasSel === '1';
  const owner = props.ctx.owner || '';
  return (
    <>
      <MTitle icon={<I d="M4 20l4-1L20 7l-3-3L5 16zM14 6l3 3" />} text={hasSel ? 'Форматирование выделения' : 'Форматирование'} />
      {MD_TOOLS.map((tool) => (
        <Fragment key={tool.id}>
          {tool.sep && <MSep />}
          <MItem
            icon={<MdToolIcon id={tool.icon} />}
            label={tool.title.replace(/\s*\(.*\)\s*$/, '')}
            onClick={() => props.act('md-tool', { tool: tool.id, owner })}
          />
        </Fragment>
      ))}
      {hasSel && (
        <>
          <MSep />
          <MItem icon={<I d="M6 17c0-4 1-7 4-10M12 17c0-4 1-7 4-10M4 17h6M10 17h6" />} label="Цитировать в комментарий" onClick={() => props.act('md-quote', { text: props.ctx.text || '' })} />
          <MItem icon={<I d="M8 8h12v12H8zM4 4h12v3M4 4v12h3" />} label="Копировать" onClick={() => props.act('md-copy-sel', { text: props.ctx.plain || '' })} />
        </>
      )}
    </>
  );
}

/* ── общий fallback: действия приложения ── */

function AppMenu(props: { act: (n: string, a?: unknown) => void; rail: boolean }) {
  return (
    <>
      <MTitle icon={<I d="M12 3l2.7 5.8 6.3.8-4.6 4.3 1.2 6.1L12 17l-5.6 3 1.2-6.1L3 9.6l6.3-.8z" />} text="Менеджер задач" />
      <MItem icon={<I d="M12 5v14M5 12h14" />} label="Новая задача" hk="N" onClick={() => props.act('new-task', null)} />
      <MItem icon={<I d="M4 5h7v15H4zM13 5h7v10h-7z" />} label="Новый проект" onClick={() => props.act('new-project', null)} />
      <MItem icon={<I d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z" />} label="Новая команда" onClick={() => props.act('new-team', null)} />
      <MSep />
      <MItem icon={<I d="M4 6h16M4 12h16M4 18h16" />} label={props.rail ? 'Развернуть панель' : 'Свернуть панель'} hk="[" onClick={() => props.act('toggle-rail', null)} />
      <MItem icon={<I d="M12 5v14M5 12h14" />} label="Сохранить текущий вид" onClick={() => props.act('save-view', null)} />
    </>
  );
}
