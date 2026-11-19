'use client';

/**
 * Ветви — модалки заметок элементов (порт #noteModal / #noteViewModal оригинала:
 * noteIconSvg, sanitizeNoteHtml, ensureNotes, visibleNotes, noteFmt/insertNoteCheck,
 * openNoteEditor/closeNoteEditor/saveNoteEditor/openNoteView/closeNoteView,
 * биндинги bindNotesDelegation для тулбара и чекбоксов).
 *
 * Разметка 1:1: .note-modal(.show) > .note-modal-card > .note-modal-head
 * (.note-modal-title + .note-modal-close) + .note-modal-body (.inp + .note-toolbar
 * с .note-tb и #noteChk + contenteditable .note-editor + .dlg-modal-foot)
 * и .note-modal-body > .note-view-body.
 *
 * Открытие — из NodeCard/Inspector через модульную шину noteBus (store-независимую):
 * lockBlockedBy/showLockTip/lockTake на открытии редактора, lockGive на закрытии —
 * как в openNoteEditor/closeNoteEditor оригинала. Просмотр заметки локи не берёт.
 */

import { useEffect, useSyncExternalStore, useRef } from 'react';

import type { VetviNode } from '@/vetvi/core/types';
import type { VetviStore } from './store';

/** NOTE_MAX оригинала: максимум заметок на элементе. */
export const NOTE_MAX = 3;

/* ═══ sanitizeNoteHtml оригинала (6289): template + вырезание опасного ═══ */

function sanitizeNoteHtml(html: unknown): string {
  const tpl = document.createElement('template');
  tpl.innerHTML = String(html || '');
  tpl.content.querySelectorAll('script,style,iframe,object,embed,link,meta').forEach((el) => el.remove());
  const all = tpl.content.querySelectorAll('*');
  for (let j = 0; j < all.length; j++) {
    const el = all[j];
    const attrs = Array.prototype.slice.call(el.attributes);
    for (let k = 0; k < attrs.length; k++) {
      const an = attrs[k].name.toLowerCase();
      if (an.indexOf('on') === 0) el.removeAttribute(attrs[k].name);
      if ((an === 'href' || an === 'src') && /^\s*javascript:/i.test(attrs[k].value)) el.removeAttribute(attrs[k].name);
    }
  }
  return tpl.innerHTML;
}

/* ═══ шина заметок: открытие из карточки/инспектора без пропсов ═══ */

export interface NoteEditorOpen {
  nodeId: string;
  idx: number; // -1 = новая заметка
  isNew: boolean;
}

export interface NoteViewOpen {
  nodeId: string;
  idx: number;
}

type ModalSnap = { editor: NoteEditorOpen | null; view: NoteViewOpen | null };

let modalSnap: ModalSnap = { editor: null, view: null };
const modalListeners = new Set<() => void>();

function commitModalSnap(next: ModalSnap): void {
  modalSnap = next;
  modalListeners.forEach((l) => l());
}

function subscribeModals(l: () => void): () => void {
  modalListeners.add(l);
  return () => { modalListeners.delete(l); };
}

function getModalSnapshot(): ModalSnap {
  return modalSnap;
}

/** Открыта ли модалка заметок (редактор или просмотр) — для Escape-каскада. */
export function noteModalOpen(): boolean {
  return !!(modalSnap.editor || modalSnap.view);
}

type NoteBusEvent =
  | { kind: 'editor'; nodeId: string; idx: number; x: number; y: number }
  | { kind: 'view'; nodeId: string; idx: number }
  | { kind: 'closeAll' };

const busListeners = new Set<(e: NoteBusEvent) => void>();

function busDispatch(e: NoteBusEvent): void {
  busListeners.forEach((l) => l(e));
}

function ptrFallback(x?: number, y?: number): { x: number; y: number } {
  const w = typeof window !== 'undefined' ? window.innerWidth : 800;
  const h = typeof window !== 'undefined' ? window.innerHeight : 600;
  return { x: typeof x === 'number' ? x : w / 2, y: typeof y === 'number' ? y : h / 3 };
}

/** Открыть редактор заметки (idx=-1 — новая). x/y — точка показа подсказки лока. */
export function openNoteEditorBus(nodeId: string, idx: number, x?: number, y?: number): void {
  const p = ptrFallback(x, y);
  busDispatch({ kind: 'editor', nodeId, idx, x: p.x, y: p.y });
}

/** Открыть просмотр заметки (локи не берутся — как openNoteView оригинала). */
export function openNoteViewBus(nodeId: string, idx: number): void {
  busDispatch({ kind: 'view', nodeId, idx });
}

/** Закрыть модалки заметок (Escape-каскад VetviApp). */
export function closeNoteModals(): void {
  busDispatch({ kind: 'closeAll' });
}

/** API-объект для вызовов из NodeCard/Inspector. */
export const noteBus = {
  openEditor: openNoteEditorBus,
  openView: openNoteViewBus,
  closeAll: closeNoteModals,
};

/* ═══ тулбар редактора: note-tb[data-fmt] + #noteChk (HTML 1263–1270) ═══ */

const FMT_BTNS: { cmd: string; title: string; cls?: string; label: string }[] = [
  { cmd: 'bold', title: 'Жирный', cls: 'b', label: 'Ж' },
  { cmd: 'italic', title: 'Курсив', cls: 'i', label: 'К' },
  { cmd: 'strikeThrough', title: 'Зачёркнутый', cls: 's', label: 'S' },
  { cmd: 'insertOrderedList', title: 'Нумерованный список', label: '1.' },
  { cmd: 'insertUnorderedList', title: 'Маркированный список', label: '•' },
];

/** noteFmt оригинала (третий аргумент — null, как в классической версии). */
function noteFmt(cmd: string): void {
  try {
    (document.execCommand as (commandId: string, showUI?: boolean, value?: string | null) => boolean)(cmd, false, null);
  } catch { /* нет поддержки */ }
}

/** insertNoteCheck оригинала: строка .nc-row с чекбоксом, каретка в .nc-txt. */
function insertNoteCheck(body: HTMLElement | null): void {
  if (!body) return;
  const row = document.createElement('div');
  row.className = 'nc-row';
  row.setAttribute('data-checked', '0');
  row.innerHTML = '<span class="nc-box" contenteditable="false"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 4.5 4.5L19 7"/></svg></span><span class="nc-txt">Задача</span>';
  body.appendChild(row);
  body.appendChild(document.createElement('br'));
  const s = window.getSelection();
  const txt = row.querySelector('.nc-txt');
  if (!s || !txt) return;
  s.removeAllRanges();
  const r = document.createRange();
  r.selectNodeContents(txt);
  r.collapse(false);
  s.addRange(r);
}

/** Чекбокс редактора: клик по .nc-box → data-checked 0/1 + .struck (6454–6461). */
function toggleEditorBox(e: React.MouseEvent): void {
  const t = e.target as HTMLElement;
  const bx = t.closest ? t.closest('.nc-box') : null;
  if (!bx) return;
  e.preventDefault();
  const r = bx.closest('.nc-row');
  if (!r) return;
  const on = r.getAttribute('data-checked') === '1';
  r.setAttribute('data-checked', on ? '0' : '1');
  r.classList.toggle('struck', !on);
}

/* ═══ хост модалок ═══ */

export function NoteModals({ store }: { store: VetviStore }) {
  /* ревизия стора: если редактируемую ноду удалили синхронно — закрыть редактор (11973) */
  useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const modal = useSyncExternalStore(subscribeModals, getModalSnapshot, getModalSnapshot);

  const titleRef = useRef<HTMLInputElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const viewBodyRef = useRef<HTMLDivElement | null>(null);

  const ed = modal.editor;
  const vw = modal.view;
  const edNode: VetviNode | null = ed ? (store.nodeById(ed.nodeId) || null) : null;
  const vwNote = (() => {
    if (!vw) return null;
    const n = store.nodeById(vw.nodeId);
    return n && Array.isArray(n.notes) ? (n.notes[vw.idx] || null) : null;
  })();

  /* ── closeNoteEditor оригинала: lockGive + скрытие модалки ── */
  const closeEditor = () => {
    const st = getModalSnapshot().editor;
    if (!st) return;
    if (store.sync) store.sync.lockGive([st.nodeId]);
    commitModalSnap({ editor: null, view: getModalSnapshot().view });
  };

  /* ── closeNoteView оригинала ── */
  const closeView = () => {
    if (!getModalSnapshot().view) return;
    commitModalSnap({ editor: getModalSnapshot().editor, view: null });
  };

  /* ── Escape/каскад: закрыть обе модалки заметок ── */
  const closeAll = () => {
    const st = getModalSnapshot();
    if (st.editor) {
      if (store.sync) store.sync.lockGive([st.editor.nodeId]);
    }
    if (!st.editor && !st.view) return;
    commitModalSnap({ editor: null, view: null });
  };

  /* ── saveNoteEditor оригинала ── */
  const saveEditor = () => {
    const st = getModalSnapshot().editor;
    if (!st) return;
    const title = (titleRef.current?.value || '').trim() || 'Заметка';
    const html = sanitizeNoteHtml(bodyRef.current?.innerHTML || '');
    store.mutate((doc) => {
      const nn = doc.nodes.find((x) => x.id === st.nodeId);
      if (!nn) return;
      if (!Array.isArray(nn.notes)) nn.notes = [];
      if (st.isNew) nn.notes.push({ title, html, hidden: false });
      else if (nn.notes[st.idx]) {
        nn.notes[st.idx].title = title;
        nn.notes[st.idx].html = html;
      }
    }, { label: 'Заметка сохранена' });
    closeEditor();
    store.toast('Заметка сохранена');
  };

  /* ── чекбокс просмотра: toggle + запись html без истории (6408–6417) ── */
  const onViewBoxClick = (e: React.MouseEvent) => {
    const t = e.target as HTMLElement;
    const bx = t.closest ? t.closest('.nc-box') : null;
    if (!bx) return;
    e.stopPropagation();
    const body = viewBodyRef.current;
    const st = getModalSnapshot().view;
    if (!body || !st) return;
    const r = bx.closest('.nc-row');
    if (!r) return;
    const on = r.getAttribute('data-checked') === '1';
    r.setAttribute('data-checked', on ? '0' : '1');
    r.classList.toggle('struck', !on);
    const html = sanitizeNoteHtml(body.innerHTML);
    store.mutate((doc) => {
      const nn = doc.nodes.find((x) => x.id === st.nodeId);
      if (!nn || !Array.isArray(nn.notes)) return;
      const note = nn.notes[st.idx];
      if (note) note.html = html;
    }, { history: false });
  };

  /* ── шина событий: openNoteEditor/openNoteView/closeAll ── */
  useEffect(() => {
    const onBus = (e: NoteBusEvent) => {
      if (e.kind === 'editor') {
        const n = store.nodeById(e.nodeId);
        if (!n) return;
        /* lockBlockedBy([n.id]) оригинала: чужой лок → подсказка и отказ */
        const lk = (store.sync && store.sync.enabled) ? store.sync.blockedBy([e.nodeId]) : null;
        if (lk) {
          store.showLockTip(e.x, e.y, { id: lk.id, name: lk.name, color: lk.color });
          return;
        }
        const isNew = e.idx < 0;
        const notes = Array.isArray(n.notes) ? n.notes : [];
        if (isNew && notes.length >= NOTE_MAX) {
          store.toast('Максимум ' + NOTE_MAX + ' заметки', 'warn');
          return;
        }
        if (store.sync) {
          store.sync.lockTake([e.nodeId]);
          store.sync.focusTrack(e.nodeId);
        }
        commitModalSnap({ editor: { nodeId: e.nodeId, idx: e.idx, isNew }, view: null });
        return;
      }
      if (e.kind === 'view') {
        const n = store.nodeById(e.nodeId);
        if (!n || !Array.isArray(n.notes) || !n.notes[e.idx]) return;
        if (store.sync) store.sync.focusTrack(e.nodeId);
        commitModalSnap({ editor: getModalSnapshot().editor, view: { nodeId: e.nodeId, idx: e.idx } });
        return;
      }
      closeAll();
    };
    busListeners.add(onBus);
    return () => { busListeners.delete(onBus); };
  });

  /* ── открытие редактора: заполнение полей + фокус через 40 мс (6373–6377).
     Эффект — только по факту открытия (ed создаётся заново каждым openEditor),
     чтобы придящие правки документа не затирали ввод ── */
  useEffect(() => {
    if (!ed) return;
    const n = store.nodeById(ed.nodeId);
    const note = (n && Array.isArray(n.notes) && !ed.isNew) ? n.notes[ed.idx] : null;
    if (titleRef.current) titleRef.current.value = (note && note.title) || '';
    if (bodyRef.current) bodyRef.current.innerHTML = sanitizeNoteHtml((note && note.html) || '');
    const t = setTimeout(() => { bodyRef.current?.focus(); }, 40);
    return () => clearTimeout(t);
  }, [ed, store]);

  /* ── открытие просмотра: html + .struck у data-checked="1" (6400–6407) ── */
  useEffect(() => {
    if (!vw) return;
    const body = viewBodyRef.current;
    if (!body) return;
    const n = store.nodeById(vw.nodeId);
    const note = (n && Array.isArray(n.notes)) ? n.notes[vw.idx] : null;
    body.innerHTML = sanitizeNoteHtml((note && note.html) || '<div class="note-empty">Пусто</div>');
    body.querySelectorAll<HTMLElement>('.nc-box').forEach((bx) => {
      const row = bx.closest('.nc-row');
      if (row && row.getAttribute('data-checked') === '1') row.classList.add('struck');
    });
  }, [vw, store]);

  /* ── ноду редактируемой заметки удалили из другой копии — закрыть редактор ── */
  useEffect(() => {
    const st = getModalSnapshot().editor;
    if (st && !store.nodeById(st.nodeId)) closeEditor();
  });

  return (
    <>
      <div
        id="noteModal"
        className={'note-modal' + (ed && edNode ? ' show' : '')}
        onPointerDown={(e) => { if (e.target === e.currentTarget) closeEditor(); }}
      >
        {ed && edNode && (
          <div className="note-modal-card">
            <div className="note-modal-head">
              <span className="note-modal-title" id="noteModalTitle">{ed.isNew ? 'Новая заметка' : 'Редактирование заметки'}</span>
              <button type="button" className="note-modal-close" id="noteModalClose" title="Закрыть" onClick={closeEditor}>×</button>
            </div>
            <div className="note-modal-body">
              <input ref={titleRef} className="inp" id="noteTitle" placeholder="Заголовок заметки…" maxLength={80} />
              <div className="note-toolbar">
                {FMT_BTNS.map((b) => (
                  <button
                    key={b.cmd}
                    type="button"
                    className={'note-tb' + (b.cls ? ' ' + b.cls : '')}
                    data-fmt={b.cmd}
                    title={b.title}
                    onMouseDown={(ev) => ev.preventDefault()}
                    onClick={() => { noteFmt(b.cmd); bodyRef.current?.focus(); }}
                  >
                    {b.label}
                  </button>
                ))}
                <button
                  type="button"
                  className="note-tb"
                  id="noteChk"
                  title="Строка с чекбоксом"
                  onMouseDown={(ev) => ev.preventDefault()}
                  onClick={() => insertNoteCheck(bodyRef.current)}
                >
                  ☑
                </button>
              </div>
              <div ref={bodyRef} className="note-editor" id="noteBody" contentEditable onClick={toggleEditorBox} />
            </div>
            <div className="dlg-modal-foot">
              <button type="button" className="btn" id="noteCancel" onClick={closeEditor}>Отмена</button>
              <button type="button" className="btn primary" id="noteSave" onClick={saveEditor}>Сохранить</button>
            </div>
          </div>
        )}
      </div>
      <div
        id="noteViewModal"
        className={'note-modal' + (vw ? ' show' : '')}
        onPointerDown={(e) => { if (e.target === e.currentTarget) closeView(); }}
      >
        {vw && (
          <div className="note-modal-card">
            <div className="note-modal-head">
              <span className="note-modal-title" id="noteViewTitle">{(vwNote && vwNote.title) || 'Заметка'}</span>
              <button type="button" className="note-modal-close" id="noteViewClose" title="Закрыть" onClick={closeView}>×</button>
            </div>
            <div className="note-modal-body">
              <div ref={viewBodyRef} className="note-view-body" id="noteViewBody" onClick={onViewBoxClick} />
            </div>
          </div>
        )}
      </div>
    </>
  );
}
