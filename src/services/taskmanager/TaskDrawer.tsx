'use client';

/**
 * Менеджер задач — дровер задачи (правая панель) и окно создания задачи.
 *
 * Дровер: название/описание (автосохранение), перенос между досками и
 * колонками (бэклог), стикеры (исполнители из аккаунтов хаба, приоритет,
 * дедлайн), подзадачи, СВЯЗИ с нодами «Ветвей» (чипы с переходом к ноде,
 * снятие связи), выполнить/дублировать/удалить.
 *
 * Окно создания: название, проект, размещение (бэклог/доска·колонка),
 * приоритет, дедлайн, описание; при переходе из «Ветвей» связи уже
 * привязаны (preset) и показываются чипами.
 */

import { useEffect, useMemo, useRef, useState } from 'react';

import {
  childrenOf,
  fmtDeadline,
  initialsOf,
  parseStickers,
  TM_PRIO,
  userColor,
  firstName,
  type TmLink,
  type TmTask,
} from './tmTypes';
import type { TmUser, Ws } from './TaskManagerApp';
import { VetviMark } from './TaskViews';

type UserMap = Map<string, TmUser>;

/* ═══ дровер задачи ═══ */

export function TmDrawer(props: {
  ws: Ws;
  users: TmUser[];
  userMap: UserMap;
  taskId: string;
  onClose: () => void;
  onPatch: (id: string, patch: Record<string, unknown>) => Promise<boolean>;
  onDelete: (id: string) => Promise<boolean>;
  onDuplicate: (task: TmTask) => Promise<void>;
  onCreateChild: (parentId: string, title: string) => Promise<void>;
  say: (text: string, tone?: 'ok' | 'warn' | 'err') => void;
}) {
  const { ws } = props;
  const task = ws.tasks.find((t) => t.id === props.taskId) || null;
  const project = task ? ws.projects.find((p) => p.id === task.projectId) : null;
  const board = task && project ? project.boards.find((b) => b.id === task.boardId) : null;
  const column = task && board ? board.columns.find((c) => c.id === task.columnId) : null;

  /* локальные поля с автосохранением (debounce 600 мс). Поля инициализируются
     при монтировании: дровер монтируется с key=taskId — смена задачи
     пересоздаёт компонент (без effect-сброса состояния). */
  const [title, setTitle] = useState(task?.title || '');
  const [desc, setDesc] = useState(task?.description || '');
  const [saving, setSaving] = useState(false);
  const [assigneePop, setAssigneePop] = useState(false);
  const debounceT = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSaved = useRef({ title: task?.title || '', desc: task?.description || '' });

  const saveText = (nt: string, nd: string) => {
    if (!task) return;
    if (nt === lastSaved.current.title && nd === lastSaved.current.desc) return;
    setSaving(true);
    void props.onPatch(task.id, { title: nt, description: nd }).then((ok) => {
      if (ok) lastSaved.current = { title: nt, desc: nd };
      setSaving(false);
    });
  };

  const queueSave = (nt: string, nd: string) => {
    if (debounceT.current) clearTimeout(debounceT.current);
    debounceT.current = setTimeout(() => saveText(nt, nd), 600);
  };

  if (!task || !project) {
    return (
      <aside className="tm-drawer" aria-label="Задача">
        <div className="tm-drawer-head">
          <span className="tm-drawer-crumb">Задача не найдена</span>
          <button type="button" className="btn ibtn" onClick={props.onClose} aria-label="Закрыть">×</button>
        </div>
      </aside>
    );
  }

  const st = task.stickers;
  const kids = childrenOf(ws, task.id).sort((a, b) => a.order - b.order);
  const kidsDone = kids.filter((k) => k.done).length;
  const prio = st.priority ? TM_PRIO[st.priority] : null;
  const links = task.links || [];
  const parent = task.parentId ? ws.tasks.find((t) => t.id === task.parentId) : null;

  const setStickers = (next: Partial<typeof st>) => {
    void props.onPatch(task.id, { stickers: { ...st, ...next } });
  };

  const setLinks = (next: TmLink[]) => {
    void props.onPatch(task.id, { links: next });
  };

  const duplicate = () => props.onDuplicate(task);

  return (
    <aside className="tm-drawer show" aria-label={'Задача: ' + task.title}>
      <div className="tm-drawer-head">
        <span className="tm-drawer-crumb">
          {project.title} · {board ? board.title + ' · ' : ''}
          {column ? column.title : 'Бэклог'}
        </span>
        <span className={'tm-drawer-save' + (saving ? ' on' : '')}>{saving ? 'сохранение…' : '✓ сохранено'}</span>
        <button type="button" className="btn ibtn" onClick={props.onClose} aria-label="Закрыть" title="Закрыть (Esc)">×</button>
      </div>

      {parent && (
        <button
          type="button"
          className="tm-parent-tag"
          onClick={() => { /* открыть родителя: закрываем и открываем его */ props.onClose(); window.setTimeout(() => { /* Drawer откроется из списка */ }, 0); }}
          title={parent.title}
        >
          ↳ Подзадача задачи «{parent.title.slice(0, 44)}»
        </button>
      )}

      <div className="tm-drawer-body">
        <textarea
          className="tm-title-ta"
          value={title}
          rows={2}
          aria-label="Название задачи"
          onChange={(e) => { setTitle(e.target.value); queueSave(e.target.value, desc); }}
          onBlur={() => saveText(title, desc)}
        />

        {/* стикеры: исполнители / приоритет / дедлайн */}
        <div className="tm-stickers">
          <span className="tm-sticker ass" onClick={() => setAssigneePop((v) => !v)} role="button" tabIndex={0}>
            {st.assignees.length === 0 ? '+ исполнитель' : (
              <span className="tm-avs">
                {st.assignees.map((login) => (
                  <span key={login} className="tm-av" style={{ background: userColor(login) }} title={firstName(props.userMap.get(login)?.displayName, login)}>
                    {initialsOf(props.userMap.get(login)?.displayName, login)}
                  </span>
                ))}
                <i>{st.assignees.length === 1 ? firstName(props.userMap.get(st.assignees[0])?.displayName, st.assignees[0]) : st.assignees.length + ' чел.'}</i>
              </span>
            )}
            {assigneePop && (
              <div className="tm-pop" onClick={(e) => e.stopPropagation()}>
                <div className="tm-pop-cap">Исполнители</div>
                {props.users.length === 0 && <div className="tm-pop-empty">Список аккаунтов недоступен</div>}
                {props.users.map((u) => {
                  const on = st.assignees.includes(u.login);
                  return (
                    <label key={u.login} className="tm-pop-row">
                      <input
                        type="checkbox"
                        checked={on}
                        onChange={() => {
                          const next = on ? st.assignees.filter((x) => x !== u.login) : [...st.assignees, u.login];
                          setStickers({ assignees: next });
                        }}
                      />
                      <span className="tm-av" style={{ background: userColor(u.login) }}>{initialsOf(u.displayName, u.login)}</span>
                      <span>{firstName(u.displayName, u.login)}</span>
                      <i className="tm-pop-login">@{u.login}</i>
                    </label>
                  );
                })}
              </div>
            )}
          </span>

          <select
            className="tm-sticker sel"
            value={st.priority || ''}
            aria-label="Приоритет"
            onChange={(e) => setStickers({ priority: e.target.value || null })}
          >
            <option value="">Без приоритета</option>
            {Object.entries(TM_PRIO).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
          </select>

          <input
            className="tm-sticker date"
            type="date"
            value={st.deadline || ''}
            aria-label="Дедлайн"
            onChange={(e) => setStickers({ deadline: e.target.value || null })}
          />
        </div>

        {/* перенос: доска/колонка */}
        <div className="tm-move">
          <select
            aria-label="Доска"
            value={board?.id || ''}
            onChange={(e) => {
              const b = project.boards.find((x) => x.id === e.target.value);
              if (!b) { void props.onPatch(task.id, { boardId: null, columnId: null }); return; }
              const col = b.columns.find((c) => c.kind === 'new') || b.columns[0];
              void props.onPatch(task.id, { boardId: b.id, columnId: col ? col.id : null });
            }}
          >
            <option value="">📥 Бэклог</option>
            {project.boards.map((b) => <option key={b.id} value={b.id}>{b.title}</option>)}
          </select>
          <select
            aria-label="Колонка"
            value={column?.id || ''}
            disabled={!board}
            onChange={(e) => { if (board && e.target.value) void props.onPatch(task.id, { boardId: board.id, columnId: e.target.value }); }}
          >
            {!board && <option value="">— бэклог —</option>}
            {board?.columns.map((c) => <option key={c.id} value={c.id}>{c.title}{c.locked ? ' 🔒' : ''}</option>)}
          </select>
          {st.deadline && (() => { const d = fmtDeadline(st.deadline); return <span className={'tm-chip dl ' + d.tone}>{d.text}</span>; })()}
        </div>

        {/* связи с нодами «Ветвей» */}
        <div className="tm-links">
          <div className="tm-sec-cap"><VetviMark /> Связи с «Ветвями» {links.length > 0 && <b>{links.length}</b>}</div>
          {links.length === 0 && (
            <p className="tm-hint">
              Связи создаются из редактора «Ветви»: выделите ноды → правый клик →
              «Создать задачу в Менеджере задач». Нода получит иконку прогресса по этой задаче.
            </p>
          )}
          {links.map((l, i) => (
            <span className="tm-link-chip" key={l.pid + ':' + l.nid + ':' + i}>
              <button
                type="button"
                className="tm-link-go"
                title="Открыть ноду в «Ветвях»"
                onClick={() => {
                  window.location.hash = (l.room ? 'room=' + encodeURIComponent(l.room) : 'project=' + encodeURIComponent(l.pid))
                    + '&node=' + encodeURIComponent(l.nid);
                }}
              >
                <VetviMark /> {l.t || l.nid.slice(0, 18)}
              </button>
              <button type="button" className="tm-link-x" title="Снять связь с нодой" onClick={() => setLinks(links.filter((_, j) => j !== i))}>×</button>
            </span>
          ))}
        </div>

        {/* описание */}
        <div className="tm-sec-cap">Описание</div>
        <textarea
          className="tm-desc-ta"
          value={desc}
          rows={5}
          placeholder="Что нужно сделать — детали, критерии, ссылки…"
          aria-label="Описание задачи"
          onChange={(e) => { setDesc(e.target.value); queueSave(title, e.target.value); }}
          onBlur={() => saveText(title, desc)}
        />

        {/* подзадачи */}
        <div className="tm-sec-cap">Дочерние задачи {kids.length > 0 && <b>{kidsDone}/{kids.length}</b>}</div>
        {kids.length > 0 && (
          <div className="tm-kids-progress"><span style={{ width: Math.round((kidsDone / kids.length) * 100) + '%' }} /></div>
        )}
        <div className="tm-kids">
          {kids.map((k) => (
            <div className={'tm-kid' + (k.done ? ' done' : '')} key={k.id}>
              <button
                type="button"
                className={'tm-donechk sm' + (k.done ? ' on' : '')}
                title={k.done ? 'Вернуть в работу' : 'Выполнить'}
                onClick={() => {
                  const b2 = project.boards.find((x) => x.id === k.boardId);
                  const target = k.done
                    ? (b2?.columns.find((c) => c.kind === (k.stickers.assignees.length ? 'progress' : 'new')))
                    : (b2?.columns.find((c) => c.kind === 'done'));
                  if (b2 && target) void props.onPatch(k.id, { boardId: b2.id, columnId: target.id });
                  else void props.onPatch(k.id, { done: !k.done });
                }}
              >
                {k.done && (
                  <svg viewBox="0 0 24 24" width={9} height={9} fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m5 13 4 4L19 7" /></svg>
                )}
              </button>
              <button type="button" className="tm-kid-title" onClick={() => { props.onClose(); }}>{k.title}</button>
              <button
                type="button"
                className="tm-mini danger"
                title="Удалить подзадачу"
                onClick={(e) => { e.stopPropagation(); void props.onDelete(k.id); }}
              >
                ×
              </button>
            </div>
          ))}
        </div>
        <input
          className="tm-kid-add"
          placeholder="+ подзадача (Enter) — появится в колонке родителя"
          aria-label="Новая подзадача"
          onKeyDown={(e) => {
            if (e.key !== 'Enter') return;
            const v = (e.target as HTMLInputElement).value.trim();
            if (!v) return;
            (e.target as HTMLInputElement).value = '';
            void props.onCreateChild(task.id, v);
          }}
        />

        {/* мета + действия */}
        <div className="tm-meta">
          Создал(а): {task.createdBy ? '@' + task.createdBy : '—'} · обновлено {fmtWhen(task.updatedAt)}
          {task.completedAt && <span className="tm-meta-done"> · выполнено {fmtWhen(task.completedAt)}</span>}
        </div>
        <div className="tm-acts">
          <button
            type="button"
            className={'btn ' + (task.done ? '' : 'primary')}
            onClick={() => {
              const b2 = project.boards.find((x) => x.id === task.boardId);
              if (!task.done) {
                const doneCol = b2?.columns.find((c) => c.kind === 'done');
                if (b2 && doneCol) void props.onPatch(task.id, { boardId: b2.id, columnId: doneCol.id });
                else void props.onPatch(task.id, { done: true });
              } else {
                const target = b2?.columns.find((c) => c.kind === (st.assignees.length ? 'progress' : 'new'));
                if (b2 && target) void props.onPatch(task.id, { boardId: b2.id, columnId: target.id });
                else void props.onPatch(task.id, { done: false });
              }
            }}
          >
            {task.done ? '↩ Вернуть в работу' : '✓ Выполнить'}
          </button>
          <button type="button" className="btn" onClick={() => void duplicate()} title="Копия задачи: название, стикеры и связи сохранятся">
            Дублировать
          </button>
          <button type="button" className="btn danger" onClick={() => {
            if (window.confirm('Удалить задачу «' + task.title.slice(0, 40) + '» вместе с подзадачами?')) void props.onDelete(task.id);
          }}>
            Удалить
          </button>
        </div>
      </div>

      {/* клик мимо попапа исполнителей закрывает его */}
      {assigneePop && <div className="tm-pop-scrim" onClick={() => setAssigneePop(false)} />}
    </aside>
  );
}

function fmtWhen(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

/* ═══ окно создания задачи ═══ */

export function TmCreateModal(props: {
  ws: Ws;
  preset: TmLink[] | null;
  onClose: () => void;
  onCreate: (payload: Record<string, unknown>) => Promise<void>;
  onCreateProject: (title: string) => Promise<unknown>;
}) {
  const { ws, preset } = props;
  const [title, setTitle] = useState('');
  const [projectId, setProjectId] = useState(ws.projects[0]?.id || '');
  const [place, setPlace] = useState<string>('backlog');
  const [priority, setPriority] = useState('');
  const [deadline, setDeadline] = useState('');
  const [desc, setDesc] = useState('');
  const [busy, setBusy] = useState(false);
  const [newProj, setNewProj] = useState('');
  const titleRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { titleRef.current?.focus(); }, []);

  /*preset задан из «Ветвей» — показать чипы связей */
  const presetLinks = preset || [];

  const submit = async () => {
    if (!title.trim() || !projectId || busy) return;
    setBusy(true);
    let pid = projectId;
    if (pid === '__new') {
      const t = newProj.trim() || 'Новый проект';
      const created = (await props.onCreateProject(t)) as { id?: string } | null;
      if (!created?.id) { setBusy(false); return; }
      pid = created.id;
    }
    const [boardId, columnId] = place === 'backlog' ? [null, null] : place.split(':');
    await props.onCreate({
      title: title.trim(),
      projectId: pid,
      boardId,
      columnId,
      description: desc,
      stickers: { assignees: [], deadline: deadline || null, priority: priority || null },
      links: presetLinks,
    });
    setBusy(false);
  };

  return (
    <div className="tm-modal-scrim" role="dialog" aria-label="Новая задача" onClick={(e) => { if (e.target === e.currentTarget) props.onClose(); }}>
      <div className="tm-modal">
        <div className="tm-modal-head">
          <span>{presetLinks.length > 0 ? 'Новая задача для нод «Ветвей»' : 'Новая задача'}</span>
          <button type="button" className="btn ibtn" onClick={props.onClose} aria-label="Закрыть">×</button>
        </div>
        <div className="tm-modal-body">
          <label className="tm-f">
            <span>Название <i>*</i></span>
            <textarea ref={titleRef} rows={2} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Что нужно сделать?" />
          </label>
          {presetLinks.length > 0 && (
            <div className="tm-f">
              <span>Связи с «Ветвями»</span>
              <div className="tm-modal-links">
                {presetLinks.map((l, i) => (
                  <span className="tm-link-chip static" key={i}><VetviMark /> {l.t || l.nid.slice(0, 24)}</span>
                ))}
              </div>
            </div>
          )}
          <div className="tm-f-row">
            <label className="tm-f">
              <span>Проект</span>
              <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
                {ws.projects.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
                <option value="__new">+ Новый проект…</option>
              </select>
            </label>
            {projectId === '__new' && (
              <label className="tm-f grow">
                <span>Название проекта</span>
                <input value={newProj} onChange={(e) => setNewProj(e.target.value)} placeholder="Например: Сюжет квеста" />
              </label>
            )}
          </div>
          <div className="tm-f-row">
            <label className="tm-f">
              <span>Размещение</span>
              <select value={place} onChange={(e) => setPlace(e.target.value)}>
                <option value="backlog">📥 Бэклог проекта</option>
                {ws.projects.filter((p) => p.id === projectId || projectId === '__new').flatMap((p) =>
                  p.boards.flatMap((b) => b.columns.map((c) => (
                    <option key={p.id + ':' + b.id + ':' + c.id} value={b.id + ':' + c.id}>
                      {p.title} · {b.title} → {c.title}
                    </option>
                  )))
                )}
              </select>
            </label>
            <label className="tm-f">
              <span>Приоритет</span>
              <select value={priority} onChange={(e) => setPriority(e.target.value)}>
                <option value="">Без приоритета</option>
                {Object.entries(TM_PRIO).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
              </select>
            </label>
            <label className="tm-f">
              <span>Дедлайн</span>
              <input type="date" value={deadline} onChange={(e) => setDeadline(e.target.value)} />
            </label>
          </div>
          <label className="tm-f">
            <span>Описание</span>
            <textarea rows={4} value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="Детали, критерии готовности…" />
          </label>
        </div>
        <div className="tm-modal-foot">
          <button type="button" className="btn" onClick={props.onClose}>Отмена</button>
          <button type="button" className="btn primary" disabled={!title.trim() || busy} onClick={() => void submit()}>
            {busy ? 'Создаю…' : 'Создать задачу'}
          </button>
        </div>
      </div>
    </div>
  );
}
