'use client';

/**
 * Менеджер задач — дровер задачи (ТРИ режима, как в прототипе «Поток»):
 *  side — боковая панель справа, wide — большое окно с колонкой чата,
 *  full — на весь экран. Переключение кнопками в шапке, режим запоминается.
 *
 * Дровер: название/описание (автосохранение, MARKDOWN-редактор с панелью
 * инструментов и просмотром), перенос между досками и колонками (бэклог),
 * стикеры (исполнители из аккаунтов хаба с автосохранением-попапом,
 * приоритет, дедлайн с быстрыми датами), МЕТКИ (создание/удаление/назначение),
 * ЧАТ ЗАДАЧИ (комментарии с Markdown + системная история действий сервера),
 * подзадачи, СВЯЗИ с нодами «Ветвей» (чипы с переходом к ноде, снятие связи
 * и ДОБАВЛЕНИЕ СВЯЗИ ИЗ ЗАДАЧИ: кнопка уводит в «Ветви» в режим привязки),
 * выполнить/дублировать/удалить.
 *
 * Окно создания: название, проект, размещение (бэклог/доска·колонка),
 * приоритет, дедлайн, описание; при переходе из «Ветвей» связи уже
 * привязаны (preset) и показываются чипами.
 */

import { useEffect, useRef, useState } from 'react';

import {
  childrenOf,
  fmtDeadline,
  initialsOf,
  parseStickers,
  TM_PRIO,
  TM_PALETTE,
  userColor,
  firstName,
  type TmLabel,
  type TmLink,
  type TmMessage,
  type TmTask,
} from './tmTypes';
import type { TmUser, Ws } from './TaskManagerApp';
import { VetviMark } from './TaskViews';
import { MD_TOOLS, mdApplyTool, mdToHtml, mdPlain } from './md';

type UserMap = Map<string, TmUser>;
export type DrawerMode = 'side' | 'wide' | 'full';

/* ═══ дровер задачи ═══ */

export function TmDrawer(props: {
  ws: Ws;
  users: TmUser[];
  userMap: UserMap;
  taskId: string;
  canEdit: boolean;
  mode: DrawerMode;
  onMode: (m: DrawerMode) => void;
  onClose: () => void;
  onPatch: (id: string, patch: Record<string, unknown>) => Promise<boolean>;
  onDelete: (id: string) => Promise<boolean>;
  onDuplicate: (task: TmTask) => Promise<void>;
  onSendComment: (taskId: string, text: string) => Promise<boolean>;
  onAttachNodes: (taskId: string, taskTitle: string) => void;
  onCreateLabel: (name: string, color: string) => Promise<TmLabel | null>;
  onDeleteLabel: (id: string) => Promise<void>;
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
  const [mdMode, setMdMode] = useState<'edit' | 'split' | 'preview'>(props.mode === 'side' ? 'edit' : 'split');
  /* смена прав (наблюдатель): переключаемся в просмотр, правки недоступны */
  useEffect(() => {
    if (!props.canEdit) setMdMode('preview');
  }, [props.canEdit]);
  const [saving, setSaving] = useState(false);
  const [stickerPop, setStickerPop] = useState(false);
  const [newLabel, setNewLabel] = useState('');
  const [labelInput, setLabelInput] = useState(false);
  const [chatDraft, setChatDraft] = useState('');
  const debounceT = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSaved = useRef({ title: task?.title || '', desc: task?.description || '' });
  const chatEndRef = useRef<HTMLDivElement>(null);
  const mdAreaRef = useRef<HTMLTextAreaElement>(null);
  const labelInputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const layoutRef = useRef<HTMLDivElement>(null);

  /* в боковой панели при открытии сразу показываем конец содержимого —
     как в прототипе: внизу оказывается чат задачи с полем ввода */
  useEffect(() => {
    if (props.mode !== 'side') return;
    const l = layoutRef.current;
    if (l) l.scrollTop = l.scrollHeight;
  }, [props.mode]);

  /* открыли ввод названия метки — фокус внутрь */
  useEffect(() => {
    if (labelInput) labelInputRef.current?.focus();
  }, [labelInput]);

  /* сменился режим — split→edit в боковой панели */
  useEffect(() => {
    setMdMode((m) => (m === 'split' && props.mode === 'side' ? 'edit' : m));
  }, [props.mode]);

  /* чат: автоскролл к низу при новых сообщениях */
  const chatKey = task ? task.messages.map((m) => m.id).join(',') : '';
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ block: 'nearest' });
  }, [chatKey]);

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

  const sendComment = async () => {
    if (!task || !chatDraft.trim()) return;
    const text = chatDraft.trim();
    setChatDraft('');
    const ok = await props.onSendComment(task.id, text);
    if (!ok) setChatDraft(text);
  };

  /* права: наблюдатель читает и комментирует, но не правит */
  const ed = props.canEdit;

  if (!task || !project) {
    return (
      <>
        <div className="tm-drawer-scrim" onClick={props.onClose} aria-hidden="true" />
        <aside className="tm-drawer show" aria-label="Задача">
          <div className="tm-drawer-head">
            <span className="tm-drawer-crumb">Задача не найдена</span>
            <button type="button" className="btn ibtn" onClick={props.onClose} aria-label="Закрыть">×</button>
          </div>
        </aside>
      </>
    );
  }

  const st = task.stickers;
  const kids = childrenOf(ws, task.id).sort((a, b) => a.order - b.order);
  const kidsDone = kids.filter((k) => k.done).length;
  const prio = st.priority ? TM_PRIO[st.priority] : null;
  const links = task.links || [];
  const parent = task.parentId ? ws.tasks.find((t) => t.id === task.parentId) : null;
  const sysMsgs = (task.messages || []).filter((m) => m.system);
  const chatMsgs = (task.messages || []).filter((m) => !m.system);

  const setStickers = (next: Partial<typeof st>) => {
    void props.onPatch(task.id, { stickers: { ...st, ...next } });
  };

  const setLinks = (next: TmLink[]) => {
    void props.onPatch(task.id, { links: next });
  };

  const setLabels = (next: string[]) => {
    void props.onPatch(task.id, { labelIds: next });
  };

  const quickDeadline = (v: string) => {
    if (v === 'none') { setStickers({ deadline: null }); return; }
    const d = new Date();
    if (v === 'tomorrow') d.setDate(d.getDate() + 1);
    if (v === 'week') d.setDate(d.getDate() + 7);
    setStickers({ deadline: d.toISOString().slice(0, 10) });
  };

  const addNewLabel = async () => {
    const name = newLabel.trim();
    if (!name) return;
    setNewLabel('');
    setLabelInput(false);
    const l = await props.onCreateLabel(name, TM_PALETTE[Math.floor(Math.random() * TM_PALETTE.length)]);
    if (l) {
      setLabels([...(task.labelIds || []), l.id]);
      props.say('Метка #' + l.name + ' создана и назначена');
    }
  };

  const mdPrevHtml = mdToHtml(desc || '');
  const hasDesc = mdPlain(desc).length > 0;

  const openParent = () => {
    if (!parent) return;
    /* открыть родителя: закрываем текущий, родитель открывается из списка
       (дровер монтируется с key=taskId — просто просим приложение открыть) */
    props.onClose();
    window.setTimeout(() => {
      try {
        window.dispatchEvent(new CustomEvent('tm-open-task', { detail: parent.id }));
      } catch { /* нет CustomEvent */ }
    }, 0);
  };

  return (
    <>
      {/* затемнение за дровером: клик закрывает, как в прототипе */}
      <div className="tm-drawer-scrim" onClick={props.onClose} aria-hidden="true" />
      <aside
        className={'tm-drawer show ' + props.mode}
        aria-label={'Задача: ' + task.title}
        style={{ '--dpc': prio?.color || project.color } as React.CSSProperties}
      >
        <div className="tm-drawer-topline" />

      <div className="tm-drawer-head">
        {parent && (
          <button type="button" className="tm-drawer-back" onClick={openParent} title="К родительской задаче">↳</button>
        )}
        <span className="tm-drawer-crumb">
          {project.title} · {board ? board.title + ' · ' : ''}
          {column ? column.title : 'Бэклог'}
        </span>
        <span className={'tm-drawer-save' + (saving ? ' on' : '')}>{saving ? 'сохранение…' : '✓ сохранено'}</span>
        {!ed && <span className="tm-lockchip">Наблюдатель</span>}
        <span className="tm-drawer-sizes" role="group" aria-label="Режим окна">
          <button type="button" className={props.mode === 'side' ? 'on' : ''} title="Боковая панель" aria-label="Боковая панель" onClick={() => props.onMode('side')}>
            <svg viewBox="0 0 24 24" width={13} height={13} fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M15 4v16" /></svg>
          </button>
          <button type="button" className={props.mode === 'wide' ? 'on' : ''} title="Большое окно" aria-label="Большое окно" onClick={() => props.onMode('wide')}>
            <svg viewBox="0 0 24 24" width={13} height={13} fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true"><rect x="4" y="7" width="16" height="10" rx="1.5" /><path d="M8 3.5 5 6.5M16 3.5l3 3M8 20.5l-3-3M16 20.5l3-3" /></svg>
          </button>
          <button type="button" className={props.mode === 'full' ? 'on' : ''} title="На весь экран" aria-label="На весь экран" onClick={() => props.onMode('full')}>
            <svg viewBox="0 0 24 24" width={13} height={13} fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" /></svg>
          </button>
        </span>
        <button type="button" className="btn ibtn" onClick={props.onClose} aria-label="Закрыть" title="Закрыть (Esc)">×</button>
      </div>

      <div className="tm-drawer-layout" ref={layoutRef}>
        <div className="tm-drawer-body" ref={scrollRef}>
          <textarea
            className="tm-title-ta"
            value={title}
            rows={2}
            aria-label="Название задачи"
            disabled={!ed}
            onChange={(e) => { setTitle(e.target.value); queueSave(e.target.value, desc); }}
            onBlur={() => saveText(title, desc)}
          />

          {/* стикеры: исполнители / приоритет / дедлайн */}
          <div className="tm-stickers">
            <span className={'tm-sticker ass' + (ed ? '' : ' ro')} onClick={ed ? () => setStickerPop((v) => !v) : undefined} role={ed ? 'button' : undefined} tabIndex={ed ? 0 : undefined}
              onKeyDown={ed ? (e) => { if (e.key === 'Enter') setStickerPop((v) => !v); } : undefined}>
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
              {stickerPop && (
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
                  <p className="tm-pop-note">Назначение из «Не взяты» переводит задачу в «В работе». Исполнитель получит уведомление.</p>
                </div>
              )}
            </span>

            <select
              className="tm-sticker sel"
              value={st.priority || ''}
              aria-label="Приоритет"
              disabled={!ed}
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
              disabled={!ed}
              onChange={(e) => setStickers({ deadline: e.target.value || null })}
            />
            {ed && (
              <div className="tm-qdates">
                <button type="button" onClick={() => quickDeadline('today')}>Сегодня</button>
                <button type="button" onClick={() => quickDeadline('tomorrow')}>Завтра</button>
                <button type="button" onClick={() => quickDeadline('week')}>+7 дней</button>
                <button type="button" onClick={() => quickDeadline('none')}>Убрать</button>
              </div>
            )}
            {st.deadline && (() => { const d = fmtDeadline(st.deadline); return <span className={'tm-chip dl ' + d.tone}>{d.text}</span>; })()}
          </div>

          {/* метки */}
          <div className="tm-labels">
            <div className="tm-sec-cap">Метки</div>
            <div className="tm-label-chips">
              {(task.labelIds || []).map((lid) => {
                const l = ws.labels.find((x) => x.id === lid);
                if (!l) return null;
                return (
                  <span key={lid} className="tm-sticker label" style={{ '--lc': l.color } as React.CSSProperties}>
                    #{l.name}
                    {ed && <button type="button" className="tm-link-x" title="Снять метку" onClick={() => setLabels((task.labelIds || []).filter((x) => x !== lid))}>×</button>}
                  </span>
                );
              })}
              {ed && !labelInput && (
                <button type="button" className="tm-sticker add" onClick={() => setLabelInput(true)} title="Прикрепить или создать метку">
                  + метка
                </button>
              )}
              {ed && labelInput && (
                <input
                  ref={labelInputRef}
                  className="tm-label-new inrow"
                  value={newLabel}
                  placeholder="название метки (Enter)"
                  maxLength={20}
                  onChange={(e) => setNewLabel(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') { e.preventDefault(); void addNewLabel(); }
                    if (e.key === 'Escape') { e.preventDefault(); setNewLabel(''); setLabelInput(false); }
                  }}
                  onBlur={() => { if (!newLabel.trim()) setLabelInput(false); }}
                />
              )}
            </div>
            {ed && (
              <div className="tm-label-manager">
              {ws.labels.length > 0 && <div className="tm-sec-note">все метки команды — клик назначает/снимает</div>}
              {ws.labels.map((l) => {
                const on = (task.labelIds || []).includes(l.id);
                return (
                  <span key={l.id} className={'tm-fchip' + (on ? ' on' : '')} style={{ '--pc': l.color } as React.CSSProperties}>
                    <button type="button" onClick={() => setLabels(on ? (task.labelIds || []).filter((x) => x !== l.id) : [...(task.labelIds || []), l.id])}>
                      #{l.name}
                    </button>
                    <button type="button" className="tm-link-x" title="Удалить метку совсем" onClick={() => { void props.onDeleteLabel(l.id); }}>×</button>
                  </span>
                );
              })}
              </div>
            )}
          </div>

          {/* перенос: доска/колонка */}
          {ed && (
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
          </div>
          )}

          {/* связи с нодами «Ветвей» */}
          <div className="tm-links">
            <div className="tm-sec-cap"><VetviMark /> Связи с «Ветвями» {links.length > 0 && <b>{links.length}</b>}</div>
            <div className="tm-link-chips">
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
                  {ed && <button type="button" className="tm-link-x" title="Снять связь с нодой" onClick={() => setLinks(links.filter((_, j) => j !== i))}>×</button>}
                </span>
              ))}
              {ed && (
                <button
                  type="button"
                  className="tm-link-add"
                  title="Открыть «Ветви», выбрать ноды и привязать к этой задаче"
                  onClick={() => props.onAttachNodes(task.id, task.title)}
                >
                  + привязать ноды из «Ветвей»
                </button>
              )}
            </div>
            {links.length === 0 && (
              <p className="tm-hint">
                Связи создаются из редактора «Ветви» (выделить ноды → ПКМ → «Создать задачу»)
                или кнопкой выше: «Ветви» откроются в режиме привязки — выберите ноды, они
                вернутся в эту задачу. Нода получит иконку прогресса.
              </p>
            )}
          </div>

          {/* описание: markdown-редактор с панелью и просмотром */}
          <div className="tm-sec-cap">Описание · Markdown <span className="tm-sec-note">видно на карточке</span></div>
          <div className={'tm-md ' + mdMode}>
            <div className="tm-md-bar">
              <div className="tm-md-tools">
                {MD_TOOLS.map((tool, i) => (
                  <span key={tool.id}>
                    {i === 3 || i === 5 || i === 8 ? <i className="tm-md-sep" /> : null}
                    <button type="button" title={tool.title} aria-label={tool.title} disabled={!ed}
                      onClick={() => { if (mdAreaRef.current) mdApplyTool(mdAreaRef.current, tool.id); }}>
                      <ToolIcon id={tool.icon} />
                    </button>
                  </span>
                ))}
              </div>
              <div className="tm-md-modes">
                {(['edit', 'split', 'preview'] as const).map((m) => (
                  <button key={m} type="button" className={mdMode === m ? 'on' : ''} onClick={() => setMdMode(m)}>
                    {m === 'edit' ? 'Правка' : m === 'split' ? 'Сплит' : 'Просмотр'}
                  </button>
                ))}
              </div>
            </div>
            <div className="tm-md-body">
              <textarea
                ref={mdAreaRef}
                className="tm-desc-ta"
                value={desc}
                rows={props.mode === 'side' ? 6 : 10}
                placeholder={'## Заголовок\n\n- [ ] пункт чек-листа\n**жирный**, *курсив*, `код`, [ссылка](https://…)'}
                aria-label="Описание задачи (Markdown)"
                disabled={!ed}
                onChange={(e) => { setDesc(e.target.value); queueSave(title, e.target.value); }}
                onBlur={() => saveText(title, desc)}
                onKeyDown={(e) => {
                  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b') { e.preventDefault(); if (mdAreaRef.current) mdApplyTool(mdAreaRef.current, 'bold'); }
                  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'i') { e.preventDefault(); if (mdAreaRef.current) mdApplyTool(mdAreaRef.current, 'italic'); }
                  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); if (mdAreaRef.current) mdApplyTool(mdAreaRef.current, 'link'); }
                }}
              />
              <div className="tm-md-prev">
                {hasDesc
                  ? <div className="md-body" dangerouslySetInnerHTML={{ __html: mdPrevHtml }} />
                  : <p className="tm-md-empty">Пусто. Напишите описание — поддерживается Markdown.</p>}
              </div>
            </div>
          </div>

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
                  disabled={!ed}
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
                <button
                  type="button"
                  className="tm-kid-title"
                  onClick={() => {
                    /* открыть подзадачу в дровере (через приложение) */
                    try { window.dispatchEvent(new CustomEvent('tm-open-task', { detail: k.id })); } catch { /* нет CustomEvent */ }
                  }}
                  title={'Открыть подзадачу: ' + k.title}
                >
                  {k.title}
                </button>
                {ed && (
                  <button
                    type="button"
                    className="tm-mini danger"
                    title="Удалить подзадачу"
                    onClick={(e) => { e.stopPropagation(); void props.onDelete(k.id); }}
                  >
                    ×
                  </button>
                )}
              </div>
            ))}
          </div>
          {ed && (
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
          )}

          {/* мета + действия */}
          <div className="tm-meta">
            Создал(а): {task.createdBy ? '@' + task.createdBy : '—'} · обновлено {fmtWhen(task.updatedAt)}
            {task.completedAt && <span className="tm-meta-done"> · выполнено {fmtWhen(task.completedAt)}</span>}
          </div>
          {ed && (
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
              <button type="button" className="btn" onClick={() => void props.onDuplicate(task)} title="Копия задачи: название, стикеры и связи сохранятся">
                Дублировать
              </button>
              <button type="button" className="btn danger" onClick={() => {
                if (window.confirm('Удалить задачу «' + task.title.slice(0, 40) + '» вместе с подзадачами?')) void props.onDelete(task.id);
              }}>
                Удалить
              </button>
            </div>
          )}
        </div>

        {/* чат задачи: комментарии + системная история */}
        <div className="tm-drawer-chat">
          <div className="tm-chat-head">
            <svg viewBox="0 0 24 24" width={14} height={14} fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M21 12a8 8 0 0 1-8 8H4l2-3a8 8 0 1 1 15-5z" /></svg>
            Чат задачи
            <span className="tm-chat-cnt">{chatMsgs.length > 0 && chatMsgs.length}</span>
          </div>
          <div className="tm-chat">
            {sysMsgs.length > 0 && (
              <div className="tm-chat-sys">
                {sysMsgs.slice(-8).map((m: TmMessage) => (
                  <div key={m.id} className="tm-sysmsg">
                    <span><b>@{m.login}</b> {m.text}</span>
                    <i>{msgTime(m.ts)}</i>
                  </div>
                ))}
              </div>
            )}
            {chatMsgs.map((m) => {
              const own = m.login === ws.me.login;
              const u = props.userMap.get(m.login);
              return (
                <div key={m.id} className={'tm-msg' + (own ? ' own' : '')}>
                  <span className="tm-av" style={{ background: userColor(m.login) }}>{initialsOf(u?.displayName, m.login)}</span>
                  <div className="tm-msg-b">
                    <div className="tm-msg-h">
                      <span className="tm-msg-n" style={{ color: userColor(m.login) }}>{firstName(u?.displayName, m.login)}</span>
                      <span className="tm-msg-t">{msgTime(m.ts)}</span>
                    </div>
                    <div className="tm-msg-x md-body" dangerouslySetInnerHTML={{ __html: mdToHtml(m.text) }} />
                  </div>
                </div>
              );
            })}
            {chatMsgs.length === 0 && (
              <div className="tm-chat-empty">Комментариев нет. Обсудите задачу с командой — поддерживается Markdown.</div>
            )}
            <div ref={chatEndRef} />
          </div>
          <div className="tm-composer">
            <span className="tm-av" style={{ background: userColor(ws.me.login) }}>{initialsOf(ws.me.displayName, ws.me.login)}</span>
            <textarea
              rows={1}
              placeholder="Сообщение команде… Markdown тоже работает (Enter — отправить)"
              aria-label="Новый комментарий"
              value={chatDraft}
              onChange={(e) => setChatDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void sendComment(); }
              }}
            />
            <button type="button" className="tm-send" aria-label="Отправить" onClick={() => void sendComment()}>
              <svg viewBox="0 0 24 24" width={14} height={14} fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M22 2 11 13M22 2l-7 20-4-9-9-4z" /></svg>
            </button>
          </div>
        </div>
      </div>

      {/* клик мимо попапа исполнителей закрывает его */}
      {stickerPop && <div className="tm-pop-scrim" onClick={() => setStickerPop(false)} />}
      </aside>
    </>
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

function msgTime(ts: number): string {
  try {
    const d = new Date(ts);
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    const tm = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    if (sameDay) return tm;
    return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }) + ', ' + tm;
  } catch {
    return '';
  }
}

/* иконки инструментов markdown */
function ToolIcon({ id }: { id: string }) {
  const common = { width: 13, height: 13, fill: 'none' as const, stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true };
  switch (id) {
    case 'bold': return <svg viewBox="0 0 24 24" {...common}><path d="M7 5h6a3.5 3.5 0 1 1 0 7H7zM7 12h7a3.5 3.5 0 1 1 0 7H7z" /></svg>;
    case 'italic': return <svg viewBox="0 0 24 24" {...common}><path d="M14 5h-4M14 5l-4 14M10 19H6" /></svg>;
    case 'strike': return <svg viewBox="0 0 24 24" {...common}><path d="M5 12h14M8 8a4 4 0 0 1 8-.5M16 16a4 4 0 0 1-8 .5" /></svg>;
    case 'heading': return <svg viewBox="0 0 24 24" {...common}><path d="M6 5v14M16 5v14M6 12h10" /></svg>;
    case 'quote': return <svg viewBox="0 0 24 24" {...common}><path d="M6 17c0-4 1-7 4-10M12 17c0-4 1-7 4-10M4 17h6M10 17h6" /></svg>;
    case 'list': return <svg viewBox="0 0 24 24" {...common}><path d="M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01" /></svg>;
    case 'list-ol': return <svg viewBox="0 0 24 24" {...common}><path d="M10 6h10M10 12h10M10 18h10M4 6l1-1v4" /></svg>;
    case 'check-square': return <svg viewBox="0 0 24 24" {...common}><rect x="4" y="4" width="16" height="16" rx="2" /><path d="m8.5 12 2.5 2.5 5-5" /></svg>;
    case 'code': return <svg viewBox="0 0 24 24" {...common}><path d="M8 8l-4 4 4 4M16 8l4 4-4 4" /></svg>;
    case 'note': return <svg viewBox="0 0 24 24" {...common}><rect x="4" y="4" width="16" height="16" rx="2" /><path d="M8 9h8M8 13h5" /></svg>;
    case 'link': return <svg viewBox="0 0 24 24" {...common}><path d="M10 14a4 4 0 0 0 6 0l3-3a4 4 0 0 0-6-6l-1.5 1.5M14 10a4 4 0 0 0-6 0l-3 3a4 4 0 0 0 6 6L12.5 17.5" /></svg>;
    case 'table': return <svg viewBox="0 0 24 24" {...common}><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3 10h18M9 10v9M15 10v9" /></svg>;
    case 'minus': return <svg viewBox="0 0 24 24" {...common}><path d="M5 12h14" /></svg>;
    default: return <svg viewBox="0 0 24 24" {...common}><circle cx="12" cy="12" r="3" /></svg>;
  }
}

/* ═══ окно создания задачи ═══ */

export function TmCreateModal(props: {
  ws: Ws;
  preset: TmLink[] | null;
  onClose: () => void;
  onCreate: (payload: Record<string, unknown>) => Promise<void>;
  onCreateProject: (title: string, open?: boolean) => Promise<unknown>;
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

  /* preset задан из «Ветвей» — показать чипы связей */
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
            <textarea rows={4} value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="Детали, критерии готовности… (Markdown)" />
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
