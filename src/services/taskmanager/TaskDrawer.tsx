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

import { Fragment, useEffect, useRef, useState } from 'react';

import {
  childrenOf,
  colorVars,
  fmtDeadline,
  initialsOf,
  parseStickers,
  TM_PRIO,
  TM_PALETTE,
  TM_TASK_PALETTE,
  userColor,
  firstName,
  type TmLabel,
  type TmLink,
  type TmMessage,
  type TmTask,
} from './tmTypes';
import type { TmUser, Ws } from './TaskManagerApp';
import { VetviMark } from './TaskViews';
import { MD_TOOLS, checklistStats, mdToHtml } from './md';
import { MdWysiwyg, type MdWysiwygHandle } from './MdWysiwyg';
import { tmOpenMenu } from './TmMenu';

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
  /** правка/реакция комментария (PATCH /comments/[msgId]) */
  onPatchComment: (taskId: string, msgId: string, patch: { text?: string; react?: string }) => Promise<boolean>;
  /** удаление комментария (DELETE /comments/[msgId]) */
  onDeleteComment: (taskId: string, msgId: string) => Promise<boolean>;
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
  const [titleEdit, setTitleEdit] = useState(false);
  const [desc, setDesc] = useState(task?.description || '');
  /* описание: сначала ТЕКСТ (режим чтения), клик открывает живой редактор */
  const [descEdit, setDescEdit] = useState(false);
  const [saving, setSaving] = useState(false);
  const [stickerPop, setStickerPop] = useState(false);
  const [newLabel, setNewLabel] = useState('');
  const [labelInput, setLabelInput] = useState(false);
  const [chatDraft, setChatDraft] = useState('');
  /* активные инструменты панелей (подсветка кнопок под кареткой) */
  const [descActive, setDescActive] = useState<string[]>([]);
  const [chatActive, setChatActive] = useState<string[]>([]);
  /* комментарий в режиме правки + черновик правки */
  const [editMsgId, setEditMsgId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState('');
  const editRef = useRef<HTMLTextAreaElement>(null);
  const debounceT = useRef<ReturnType<typeof setTimeout> | null>(null);
  const alphaT = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSaved = useRef({ title: task?.title || '', desc: task?.description || '' });
  const chatEndRef = useRef<HTMLDivElement>(null);
  const descEdRef = useRef<MdWysiwygHandle>(null);
  const chatEdRef = useRef<MdWysiwygHandle>(null);
  const labelInputRef = useRef<HTMLInputElement>(null);
  const drawerRef = useRef<HTMLElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const layoutRef = useRef<HTMLDivElement>(null);
  /* потолок поля комментария = ТРЕТЬ высоты окна задачи (пересчёт на смену режима) */
  const [chatMax, setChatMax] = useState(120);
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      const dr = drawerRef.current;
      setChatMax(dr ? Math.max(72, Math.floor(dr.clientHeight / 3)) : 120);
    });
    return () => cancelAnimationFrame(raf);
  }, [props.mode]);

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

  /* «Дочерняя задача» из контекстного меню: фокус в поле новой подзадачи */
  useEffect(() => {
    const onFocusChild = () => {
      const el = document.querySelector<HTMLInputElement>('.tm-kid-add');
      if (el) el.focus();
    };
    window.addEventListener('tm-focus-child', onFocusChild);
    return () => window.removeEventListener('tm-focus-child', onFocusChild);
  }, []);

  /* действия из ПКМ-меню комментария: ответить (префикс в композере) и
     редактировать (поле правки под сообщением). Задача в меню = текущая */
  useEffect(() => {
    const onReply = (e: Event) => {
      const d = (e as CustomEvent<{ login: string; text: string }>).detail || { login: '', text: '' };
      setEditMsgId(null);
      setChatDraft((prev) => (prev ? prev : '') + (d.login ? '@' + firstName(props.userMap.get(d.login)?.displayName, d.login) + ': ' : ''));
      window.setTimeout(() => { try { chatEdRef.current?.focus(); } catch { /* нет фокуса */ } }, 30);
    };
    const onEdit = (e: Event) => {
      const d = (e as CustomEvent<{ msgId: string; text: string }>).detail;
      if (!d || !d.msgId) return;
      setChatDraft('');
      setEditMsgId(d.msgId);
      setEditDraft(d.text);
    };
    window.addEventListener('tm-msg-reply', onReply);
    window.addEventListener('tm-msg-edit', onEdit);
    return () => {
      window.removeEventListener('tm-msg-reply', onReply);
      window.removeEventListener('tm-msg-edit', onEdit);
    };
  }, [props.userMap]);

  /* «цитировать в комментарий» из ПКМ-меню выделения в описании:
     готовая цитата (> …) уезжает в композер чата */
  useEffect(() => {
    const onQuote = (e: Event) => {
      const d = (e as CustomEvent<{ text: string }>).detail;
      if (!d || !d.text) return;
      setEditMsgId(null);
      setChatDraft((prev) => (prev ? prev + '\n\n' : '') + d.text);
      window.setTimeout(() => { try { chatEdRef.current?.focus(); } catch { /* нет фокуса */ } }, 30);
    };
    window.addEventListener('tm-quote-comment', onQuote);
    return () => window.removeEventListener('tm-quote-comment', onQuote);
  }, []);

  /* фокус в поле правки комментария РОВНО при открытии (не на каждый ввод) */
  const openedMsg = useRef<string | null>(null);
  useEffect(() => {
    if (editMsgId && editMsgId !== openedMsg.current) {
      openedMsg.current = editMsgId;
      editRef.current?.focus();
      editRef.current?.setSelectionRange(editDraft.length, editDraft.length);
    }
    if (!editMsgId) openedMsg.current = null;
  }, [editMsgId]);

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

  /* свернуть редактор описания в режим текста: сначала сбрасываем отложенное
     автосохранение (иначе клик мимо потеряет последние символы) */
  const collapseDesc = () => {
    if (debounceT.current) { clearTimeout(debounceT.current); debounceT.current = null; }
    saveText(title, desc);
    setDescEdit(false);
  };

  /* редактор описания открыт — клик мимо поля (и панели) сворачивает его */
  useEffect(() => {
    if (!descEdit) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Element | null;
      if (t && t.closest && t.closest('.tm-mdw-wrap')) return;
      collapseDesc();
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  });

  const sendComment = async () => {
    if (!task || !chatDraft.trim()) return;
    const text = chatDraft.trim();
    setChatDraft('');
    const ok = await props.onSendComment(task.id, text);
    if (!ok) setChatDraft(text);
  };

  /* сохранение правки комментария (Ctrl+Enter тоже) */
  const saveEdit = async () => {
    if (!task || !editMsgId) return;
    const text = editDraft.trim();
    if (!text) return;
    const ok = await props.onPatchComment(task.id, editMsgId, { text });
    if (ok) setEditMsgId(null);
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
  /* шкала чек-листов описания — пересчитывается на каждую правку */
  const chk = checklistStats(desc);

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
        ref={drawerRef}
        className={'tm-drawer show ' + props.mode}
        aria-label={'Задача: ' + task.title}
        style={{ '--dpc': task.color || prio?.color || project.color } as React.CSSProperties}
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
          {/* название: просто текст — клик открывает правку (как в прототипе) */}
          {titleEdit ? (
            <input
              autoFocus
              className="tm-title-edit"
              value={title}
              aria-label="Название задачи"
              disabled={!ed}
              onChange={(e) => { setTitle(e.target.value); queueSave(e.target.value, desc); }}
              onBlur={() => {
                setTitleEdit(false);
                if (!title.trim()) { setTitle(task.title); return; }
                saveText(title, desc);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); (e.target as HTMLInputElement).blur(); }
                if (e.key === 'Escape') { e.preventDefault(); setTitleEdit(false); setTitle(task.title); }
              }}
            />
          ) : (
            <h1
              className={'tm-title-view' + (ed ? ' ed' : '')}
              onClick={ed ? () => setTitleEdit(true) : undefined}
              title={ed ? 'Нажмите, чтобы переименовать задачу' : undefined}
              role={ed ? 'button' : undefined}
              tabIndex={ed ? 0 : undefined}
              onKeyDown={ed ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setTitleEdit(true); } } : undefined}
            >
              {title || 'Без названия'}
            </h1>
          )}

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

          {/* связи с нодами «Ветвей» — включаются ФЛАГОМ в задаче (не засоряем вид):
              чип-переключатель в ряду стикеров + блок виден только когда включён */}
          <div className="tm-links-toggle">
            <button
              type="button"
              className={'tm-sticker vetvi-tog' + (task.nodesOn ? ' on' : '')}
              disabled={!ed}
              title={task.nodesOn ? 'Скрыть блок связей с «Ветвями»' : 'Включить блок связей с нодами «Ветвей» в этой задаче'}
              onClick={() => { void props.onPatch(task.id, { nodesOn: !task.nodesOn }); }}
            >
              <VetviMark /> Ветви{task.nodesOn ? ' ✓' : ''}
            </button>
            {!task.nodesOn && links.length > 0 && (
              <span className="tm-hint">есть связи ({links.length}) — включите блок, чтобы увидеть</span>
            )}
          </div>
          {(task.nodesOn || links.length > 0) && (
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
                    + привязать ноды
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
          )}

        {/* описание: сначала ТЕКСТ (как в читалке), клик открывает живой
            WYSIWYG-редактор с панелью; клик мимо — сворачивает обратно */}
        <div className="tm-sec-cap">Описание · Markdown <span className="tm-sec-note">видно на карточке</span></div>
        {descEdit && ed ? (
          <div className="tm-mdw-wrap">
            <div className="tm-md-bar">
              <MdToolbar disabled={!ed} active={descActive} onTool={(id) => descEdRef.current?.exec(id)} />
            </div>
            <MdWysiwyg
              ref={descEdRef}
              value={desc}
              onChange={(md) => { setDesc(md); queueSave(title, md); }}
              disabled={!ed}
              placeholder={'## Заголовок\n\n- [ ] пункт чек-листа\n**жирный**, *курсив*, `код`, [ссылка](https://…)'}
              className="tm-desc-ed"
              ariaLabel="Описание задачи"
              onEsc={collapseDesc}
              onActiveChange={setDescActive}
              quoteMenu
            />
          </div>
        ) : (
          <div
            className={'tm-desc-view md-body' + (!desc.trim() ? ' empty' : '') + (ed ? ' clickable' : '')}
            role={ed ? 'button' : undefined}
            tabIndex={ed ? 0 : undefined}
            aria-label={ed ? 'Редактировать описание' : undefined}
            title={ed ? 'Нажмите, чтобы редактировать описание' : undefined}
            onClick={(e) => {
              if (!ed) return;
              /* ссылки в тексте описания работают как ссылки */
              if ((e.target as HTMLElement).closest?.('a')) return;
              setDescEdit(true);
            }}
            onKeyDown={(e) => {
              if (!ed) return;
              if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setDescEdit(true); }
            }}
          >
            {desc.trim()
              ? <div dangerouslySetInnerHTML={{ __html: mdToHtml(desc) }} />
              : <span className="tm-desc-empty-hint">Нажмите, чтобы добавить описание…</span>}
          </div>
        )}
          {/* шкала чек-листа описания (как в прототипе: заполненные [x] считаются) */}
          {chk && (
            <div className="tm-checkbar-row" title={'Чек-лист: ' + chk.done + ' из ' + chk.total}>
              <div className="tm-checkbar"><span style={{ width: Math.round((chk.done / chk.total) * 100) + '%' }} /></div>
              <span className="tm-checkbar-cap">✓ {chk.done}/{chk.total}</span>
            </div>
          )}

          {/* подзадачи */}
          <div className="tm-sec-cap">Дочерние задачи {kids.length > 0 && <b>{kidsDone}/{kids.length}</b>}</div>
          {kids.length > 0 && (
            <div className="tm-kids-progress"><span style={{ width: Math.round((kidsDone / kids.length) * 100) + '%' }} /></div>
          )}
          <div className="tm-kids">
            {kids.map((k) => (
              <div className={'tm-kid' + (k.done ? ' done' : '') + (k.color ? ' colored' : '')} key={k.id} style={colorVars(k.color, k.colorAlpha)}>
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

          {/* цвет задачи (как в прототипе: палитра + плотность заливки + предпросмотр) */}
          <div className="tm-sec-cap">Цвет задачи</div>
          <div className="tm-color">
            <div className="tm-swatches">
              <button
                type="button"
                className={'tm-csw none' + (!task.color ? ' on' : '')}
                title="Без цвета"
                aria-label="Убрать цвет"
                disabled={!ed}
                onClick={() => void props.onPatch(task.id, { color: null })}
              >
                <svg viewBox="0 0 24 24" width={12} height={12} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
              </button>
              {TM_TASK_PALETTE.map((c) => (
                <button
                  key={c}
                  type="button"
                  className={'tm-csw' + (task.color === c ? ' on' : '')}
                  style={{ background: c }}
                  title="Цвет карточки"
                  aria-label={'Цвет карточки ' + c}
                  disabled={!ed}
                  onClick={() => void props.onPatch(task.id, { color: c, colorAlpha: task.colorAlpha ?? 0.2 })}
                />
              ))}
            </div>
            {task.color && (
              <div className="tm-alpha-row">
                <input
                  type="range"
                  min={4}
                  max={80}
                  value={Math.round((task.colorAlpha ?? 0.2) * 100)}
                  aria-label="Плотность заливки"
                  disabled={!ed}
                  onChange={(e) => {
                    const v = parseInt(e.target.value, 10) / 100;
                    if (alphaT.current) clearTimeout(alphaT.current);
                    alphaT.current = setTimeout(() => void props.onPatch(task.id, { colorAlpha: v }), 250);
                  }}
                />
                <b>{Math.round((task.colorAlpha ?? 0.2) * 100)}%</b>
              </div>
            )}
            <div className="tm-color-demo" style={colorVars(task.color, task.colorAlpha)}>
              {task.title.slice(0, 42) || 'Предпросмотр карточки'}
            </div>
          </div>

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
              const reacts = m.reactions || {};
              const reactKeys = Object.keys(reacts);
              const editing = editMsgId === m.id;
              return (
                <div
                  key={m.id}
                  className={'tm-msg' + (own ? ' own' : '')}
                  onContextMenu={(e) => {
                    /* ПКМ на комментарии: ответить/реагировать/копировать/править/удалить */
                    e.preventDefault();
                    e.stopPropagation();
                    tmOpenMenu('comment', { taskId: task.id, msgId: m.id, login: m.login, mine: own ? '1' : '0', text: m.text.slice(0, 60) }, e.clientX, e.clientY);
                  }}
                >
                  <span className="tm-av" style={{ background: userColor(m.login) }}>{initialsOf(u?.displayName, m.login)}</span>
                  <div className="tm-msg-b">
                    <div className="tm-msg-h">
                      <span className="tm-msg-n" style={{ color: userColor(m.login) }}>{firstName(u?.displayName, m.login)}</span>
                      <span className="tm-msg-t">{msgTime(m.ts)}</span>
                    </div>
                    {editing ? (
                      <div className="tm-msg-editwrap">
                        <textarea
                          ref={editRef}
                          className="tm-msg-edit"
                          value={editDraft}
                          aria-label="Правка комментария"
                          onChange={(e2) => setEditDraft(e2.target.value)}
                          onKeyDown={(e2) => {
                            if (e2.key === 'Enter' && (e2.ctrlKey || e2.metaKey)) { e2.preventDefault(); void saveEdit(); }
                            if (e2.key === 'Escape') { e2.preventDefault(); setEditMsgId(null); }
                          }}
                        />
                        <div className="tm-msg-edit-row">
                          <button type="button" className="btn" onClick={() => setEditMsgId(null)}>Отмена</button>
                          <button type="button" className="btn primary" onClick={() => void saveEdit()}>Сохранить</button>
                        </div>
                      </div>
                    ) : (
                      <div className="tm-msg-x md-body" dangerouslySetInnerHTML={{ __html: mdToHtml(m.text) }} />
                    )}
                    {reactKeys.length > 0 && (
                      <div className="tm-msg-reacts">
                        {reactKeys.map((r) => {
                          const who = reacts[r] || [];
                          const mine = who.includes(ws.me.login);
                          return (
                            <button
                              key={r}
                              type="button"
                              className={'tm-react' + (mine ? ' mine' : '')}
                              title={who.map((l) => firstName(props.userMap.get(l)?.displayName, l)).join(', ') + ' — клик: снять/поставить'}
                              onClick={() => void props.onPatchComment(task.id, m.id, { react: r })}
                            >
                              {r} <b>{who.length}</b>
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
            {chatMsgs.length === 0 && (
              <div className="tm-chat-empty">Комментариев нет. Обсудите задачу с командой — поддерживается Markdown.</div>
            )}
            <div ref={chatEndRef} />
          </div>
          {/* композер: ЖИВОЙ WYSIWYG (панель Markdown, растёт до трети окна,
              Enter — отправить, Shift+Enter — новая строка) */}
          <div className="tm-composer">
            <span className="tm-av" style={{ background: userColor(ws.me.login) }}>{initialsOf(ws.me.displayName, ws.me.login)}</span>
            <div className="tm-composer-box">
              <div className="tm-composer-bar">
                <MdToolbar mini active={chatActive} onTool={(id) => chatEdRef.current?.exec(id)} />
                <span className="tm-composer-hint">Enter — отправить</span>
              </div>
              <MdWysiwyg
                ref={chatEdRef}
                value={chatDraft}
                onChange={setChatDraft}
                onEnter={() => void sendComment()}
                autoGrow
                maxGrow={chatMax}
                placeholder="Сообщение команде…"
                className="tm-composer-ed"
                ariaLabel="Новый комментарий"
                onActiveChange={setChatActive}
              />
            </div>
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

/* панель инструментов markdown (описание + композер чата).
   Кнопки — прямые дети flex-контейнера с разделителями между группами:
   ровный ряд, как панель прототипа «Поток» (скрин 1).
   onMouseDown+preventDefault — чтобы не терять выделение в WYSIWYG-поле. */
function MdToolbar(props: {
  disabled?: boolean;
  mini?: boolean;
  /** Активные инструменты (под кареткой/выделением) — подсвечены. */
  active?: string[];
  onTool: (toolId: string) => void;
}) {
  return (
    <div className={'tm-md-tools' + (props.mini ? ' mini' : '')} role="toolbar" aria-label="Инструменты Markdown">
      {MD_TOOLS.map((tool) => (
        <Fragment key={tool.id}>
          {tool.sep && <i className="tm-md-sep" aria-hidden="true" />}
          <button
            type="button"
            title={tool.title}
            aria-label={tool.title}
            aria-pressed={props.active ? props.active.includes(tool.id) : undefined}
            className={props.active && props.active.includes(tool.id) ? 'on' : ''}
            disabled={props.disabled}
            onMouseDown={(e) => { e.preventDefault(); }}
            onClick={() => props.onTool(tool.id)}
          >
            <ToolIcon id={tool.icon} />
          </button>
        </Fragment>
      ))}
    </div>
  );
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
    case 'image': return <svg viewBox="0 0 24 24" {...common}><rect x="3" y="5" width="18" height="14" rx="2" /><circle cx="8.5" cy="10" r="1.5" /><path d="m21 15-5-5-9 9" /></svg>;
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
            <div className="tm-f-mdw">
              <MdWysiwyg
                value={desc}
                onChange={setDesc}
                placeholder="Детали, критерии готовности… (Markdown — видно сразу)"
                className="tm-create-desc"
                ariaLabel="Описание задачи"
              />
            </div>
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
