'use client';

/**
 * Ветви — модалка реплик диалога (порт #dlgModal оригинала:
 * dlgModalRender / dlgModalRenderReplies / dlgModalBind).
 * Разметка 1:1: .dlg-modal.show > .dlg-modal-card > .dlg-modal-head +
 * .dlg-modal-body (.dlg-participants с чипами участников, дерево .dlg-reply-ed(.root)
 * с .dlg-reply-row-ed (говорящий + текст), .dlg-reply-acts (.mini-btn), вложенность
 * .dlg-children-ed, кнопка корневой реплики .dlg-add-root-btn) + .dlg-modal-foot.
 * Логика сохранена: добавление ниже/веткой/корневой, порядок (вверх/вниз),
 * говорящий, текст с авторостом (.grow), «повтор» (.dlg-loop-tog.on), удаление,
 * подсветка целевой реплики (.dlg-flash) с автопрокруткой.
 */

import { useEffect, useRef } from 'react';

import type { VetviChar, VetviReply } from '@/vetvi/core/types';
import type { VetviStore } from './store';

/* svg-иконки оригинала (ic()): контур 24×24, stroke currentColor, width/height по size */
const ICONS: Record<string, React.ReactNode> = {
  plus: <path d="M12 5v14M5 12h14" />,
  corner: <><path d="M5 5v4.6a3.9 3.9 0 0 0 3.9 3.9H19" /><path d="m15.5 9.5 3.5 3.5-3.5 3.5" /></>,
  x: <path d="M6 6l12 12M18 6 6 18" />,
  repeat: <><path d="M17 2.5 20.5 6 17 9.5" /><path d="M3.5 12V9a3 3 0 0 1 3-3h14" /><path d="M7 21.5 3.5 18 7 14.5" /><path d="M20.5 12v3a3 3 0 0 1-3 3h-14" /></>,
  chev: <path d="m6 9 6 6 6-6" />,
  chevUp: <path d="m6 15 6-6 6 6" />,
  target: <><circle cx="12" cy="12" r="7" /><path d="M12 2v4M12 18v4M2 12h4M18 12h4" /></>,
  grip: <path d="M9 5.5h.01M9 12h.01M9 18.5h.01M15 5.5h.01M15 12h.01M15 18.5h.01" />,
};

function Ic(props: { name: string; size: number }) {
  return (
    <svg viewBox="0 0 24 24" width={props.size} height={props.size} fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">
      {ICONS[props.name] || null}
    </svg>
  );
}

/* hexToRgba оригинала — подложка/рамка чипа участника */
function hexToRgba(hex: string, a: number): string {
  const h = String(hex || '').replace('#', '');
  const f = h.length === 3 ? h.split('').map((x) => x + x).join('') : h;
  const r = parseInt(f.slice(0, 2), 16);
  const g = parseInt(f.slice(2, 4), 16);
  const b = parseInt(f.slice(4, 6), 16);
  if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return 'rgba(154,161,172,' + a + ')';
  return 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
}

/* аватар персонажа (charAvatarHtml оригинала): рамка — цвет, без аватара — буква */
function CharAvatar({ c, extra }: { c: VetviChar; extra?: string }) {
  const shape = (c as { avShape?: string }).avShape === 'square' ? 'square' : 'circle';
  const av = (c as { av?: string }).av;
  const initial = (String(c.name || '').trim().charAt(0).toUpperCase()) || '?';
  return (
    <span className={'c-av ' + shape + (av ? '' : ' empty') + (extra ? ' ' + extra : '')} style={{ borderColor: c.color || '#9cb878' }}>
      {av ? <img src={av} alt="" /> : initial}
    </span>
  );
}

/* авторазмер поля реплики (dlgTaGrow оригинала) */
function taGrow(ta: HTMLTextAreaElement) {
  ta.style.height = 'auto';
  ta.style.height = (ta.scrollHeight + 2) + 'px'; /* +2 — верхняя и нижняя границы */
}

/* ═══ перетаскивание реплик — порядок среди соседей одного уровня (dlgDragRid оригинала 4887–4949) ═══ */

let dlgDragRid: string | null = null;

interface ReplyLoc { arr: VetviReply[]; idx: number; parent: VetviReply[] | null }

function findReplyLoc(arr: VetviReply[], id: string, parent: VetviReply[] | null): ReplyLoc | null {
  for (let i = 0; i < arr.length; i++) {
    if (arr[i].id === id) return { arr, idx: i, parent };
    const ch = arr[i].children;
    if (ch && ch.length) {
      const hit = findReplyLoc(ch, id, arr);
      if (hit) return hit;
    }
  }
  return null;
}

/* автоскролл списка реплик при перетаскивании к краям модалки (dlgAutoScroll оригинала 1601–1626):
   без него дотащить реплику до конца длинного списка нельзя — браузер сам не листает */
let dlgScrollEl: HTMLElement | null = null;
let dlgScrollDir = 0;
let dlgScrollRaf = 0;
let dlgScrollLast = 0;

function dlgAutoScrollStop(): void {
  dlgScrollDir = 0;
  dlgScrollLast = 0;
  dlgScrollEl = null;
  if (dlgScrollRaf) { cancelAnimationFrame(dlgScrollRaf); dlgScrollRaf = 0; }
}

function dlgAutoScrollStep(ts: number): void {
  if (!dlgScrollEl || !dlgScrollDir) { dlgScrollRaf = 0; dlgScrollLast = 0; return; }
  if (!dlgScrollLast) dlgScrollLast = ts;
  const dt = Math.min(50, ts - dlgScrollLast);
  dlgScrollLast = ts;
  dlgScrollEl.scrollTop += dlgScrollDir * dt * 0.75; /* ~750px/с независимо от герцовки */
  dlgScrollRaf = requestAnimationFrame(dlgAutoScrollStep);
}

function dlgAutoScrollUpdate(ev: DragEvent): void {
  if (!dlgDragRid) { dlgAutoScrollStop(); return; }
  const sc = document.getElementById('dlgModalBody');
  if (!sc) { dlgAutoScrollStop(); return; }
  const r = sc.getBoundingClientRect();
  const Z = 46;
  const y = ev.clientY;
  const dir = (y < r.top + Z) ? -1 : ((y > r.bottom - Z) ? 1 : 0);
  if (dir !== dlgScrollDir) { dlgScrollDir = dir; dlgScrollLast = 0; }
  if (dlgScrollDir) {
    dlgScrollEl = sc;
    if (!dlgScrollRaf) dlgScrollRaf = requestAnimationFrame(dlgAutoScrollStep);
  } else {
    dlgAutoScrollStop();
  }
}

export function DialogModal({ store }: { store: VetviStore }) {
  const nodeId = store.dialogEdit;
  const node = nodeId ? store.nodeById(nodeId) : null;
  const editPreRef = useRef<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  void store.revision;

  useEffect(() => {
    if (store.dialogEdit) editPreRef.current = store.beginEdit();
    else editPreRef.current = null;
     
  }, [store.dialogEdit]);

  /* подсветка реплики: прокрутить к ней и мигнуть (dlgFlashReply оригинала) */
  const flash = store.flash;
  useEffect(() => {
    const el = listRef.current && flash ? listRef.current.querySelector('.dlg-flash') : null;
    if (!el) return;
    (el as HTMLElement).scrollIntoView({ block: 'center', behavior: 'smooth' });
    (el as HTMLElement).classList.remove('dlg-flash');
    void (el as HTMLElement).offsetWidth; /* перезапуск анимации, если подсветка ещё идёт */
    (el as HTMLElement).classList.add('dlg-flash');
  }, [flash]);

  /* автоскролл списка реплик при перетаскивании (слушатели делегированные — модалка не пересоздаётся, 4959–4963 оригинала) */
  useEffect(() => {
    if (!store.dialogEdit) return;
    const body = listRef.current;
    if (!body) return;
    const onOver = (ev: DragEvent) => dlgAutoScrollUpdate(ev);
    const onLeave = (ev: DragEvent) => {
      const rt = ev.relatedTarget as Node | null;
      if (!(rt && body.contains(rt))) dlgAutoScrollStop();
    };
    body.addEventListener('dragover', onOver);
    body.addEventListener('dragleave', onLeave);
    return () => {
      body.removeEventListener('dragover', onOver);
      body.removeEventListener('dragleave', onLeave);
      dlgAutoScrollStop();
    };
  }, [store.dialogEdit]);

  const n = node;
  const chars: VetviChar[] = store.doc.chars || [];
  const participants = n && n.dialog ? n.dialog.participants || [] : [];
  const partChars = participants
    .map((pid) => chars.find((c) => c.id === pid))
    .filter(Boolean) as VetviChar[];
  const close = () => {
    store.commitReplyEdit(editPreRef.current);
    store.closeDialogEditor();
  };

  if (!n || n.type !== 'dialog' || !n.dialog) {
    return null;
  }

  const removePart = (pid: string) => {
    store.setParticipants(n.id, participants.filter((p) => p !== pid));
  };

  /* локальная ссылка на диалог (сужение типа для замыканий drag-обработчиков) */
  const dlg = n.dialog;

  const renderReply = (r: VetviReply, depth: number): React.ReactNode => {
    const isRoot = depth === 0;
    const isFlash = !!(flash && flash.nodeId === n.id && flash.replyId === r.id);
    const loop = !!(r as unknown as { loop?: boolean }).loop;
    /* перетаскивание реплик (dlgDragRid оригинала): grip по mousedown делает строку draggable,
       drop выше/ниже цели переставляет; только среди соседей одного уровня */
    const onDragStart = (ev: React.DragEvent) => {
      const row = ev.currentTarget as HTMLElement;
      if (ev.target !== row) return; /* dragstart от вложенной реплики — не мешаем */
      if (row.getAttribute('draggable') !== 'true') { ev.preventDefault(); return; }
      ev.dataTransfer.effectAllowed = 'move';
      try { ev.dataTransfer.setData('text/plain', r.id); } catch { /* старые браузеры */ }
      dlgDragRid = r.id;
      setTimeout(() => row.classList.add('dragging'), 0);
    };
    const onDragEnd = (ev: React.DragEvent) => {
      const row = ev.currentTarget as HTMLElement;
      row.removeAttribute('draggable');
      row.classList.remove('dragging');
      document.querySelectorAll('#dlgModalBody .dlg-reply-ed').forEach((x) => x.classList.remove('drop-above', 'drop-below'));
      dlgDragRid = null;
      dlgAutoScrollStop();
    };
    const onDragOver = (ev: React.DragEvent) => {
      if (!dlgDragRid || dlgDragRid === r.id) return;
      const inner = (ev.target as HTMLElement).closest ? (ev.target as HTMLElement).closest('.dlg-reply-ed') : null;
      if (inner && inner !== ev.currentTarget) return; /* вложенная реплика обработает сама */
      const srcLoc = findReplyLoc(dlg.replies, dlgDragRid, null);
      const tgtLoc = findReplyLoc(dlg.replies, r.id, null);
      if (!srcLoc || !tgtLoc || srcLoc.parent !== tgtLoc.parent) return; /* только соседние */
      ev.preventDefault();
      ev.dataTransfer.dropEffect = 'move';
      const rect = (ev.currentTarget as HTMLElement).getBoundingClientRect();
      const below = (ev.clientY - rect.top) > (rect.height / 2);
      (ev.currentTarget as HTMLElement).classList.toggle('drop-below', below);
      (ev.currentTarget as HTMLElement).classList.toggle('drop-above', !below);
    };
    const onDragLeave = (ev: React.DragEvent) => {
      (ev.currentTarget as HTMLElement).classList.remove('drop-above', 'drop-below');
    };
    const onDrop = (ev: React.DragEvent) => {
      ev.preventDefault();
      ev.stopPropagation();
      dlgAutoScrollStop();
      const row = ev.currentTarget as HTMLElement;
      const rect = row.getBoundingClientRect();
      const below = (ev.clientY - rect.top) > (rect.height / 2);
      row.classList.remove('drop-above', 'drop-below');
      const srcRid = dlgDragRid;
      dlgDragRid = null;
      if (!srcRid || srcRid === r.id) return;
      const srcLoc = findReplyLoc(dlg.replies, srcRid, null);
      const tgtLoc = findReplyLoc(dlg.replies, r.id, null);
      if (!srcLoc || !tgtLoc || srcLoc.parent !== tgtLoc.parent) {
        store.toast('Перемещать можно только реплики одного уровня', 'warn');
        return;
      }
      store.moveReplyPair(n.id, srcRid, r.id, below);
    };
    return (
      <div
        key={r.id}
        className={'dlg-reply-ed' + (isRoot ? ' root' : '') + (isFlash ? ' dlg-flash' : '')}
        data-rid={r.id}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        <div className="dlg-reply-row-ed">
          <select
            data-f="speaker"
            value={r.speaker || ''}
            aria-label="Говорящий"
            onFocus={() => { editPreRef.current = editPreRef.current || store.beginEdit(); }}
            onChange={(e) => {
              const pre = editPreRef.current;
              store.updateReply(n.id, r.id, { speaker: e.target.value || null }, { history: false });
              if (pre) store.commitReplyEdit(pre);
              editPreRef.current = store.beginEdit();
            }}
          >
            <option value="">— не выбран —</option>
            {partChars.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <textarea
            data-f="text"
            placeholder="Текст реплики…"
            value={r.text}
            aria-label={'Текст реплики ' + r.id}
            onFocus={(e) => {
              editPreRef.current = editPreRef.current || store.beginEdit();
              e.currentTarget.classList.add('grow');
              taGrow(e.currentTarget);
            }}
            onChange={(e) => {
              store.updateReply(n.id, r.id, { text: e.target.value }, { history: false });
              taGrow(e.currentTarget);
            }}
            onBlur={(e) => {
              e.currentTarget.classList.remove('grow');
              e.currentTarget.style.height = '';
              const pre = editPreRef.current;
              if (pre) { store.commitReplyEdit(pre); editPreRef.current = store.beginEdit(); }
            }}
          />
        </div>
        <div className="dlg-reply-acts">
          <button
            type="button"
            className={'mini-btn dlg-loop-tog' + (loop ? ' on' : '')}
            data-act="loop"
            title="Повтор: после этой реплики диалог начнётся заново. Включите, чтобы зациклить проигрывание после вывода реплики"
            onClick={() => {
              store.updateReply(n.id, r.id, { loop: !loop } as Partial<VetviReply>, { label: 'Повтор реплики' });
            }}
          ><Ic name="repeat" size={11} /></button>
          <button
            type="button"
            className="mini-btn dlg-drag"
            data-act="drag"
            title="Перетащить — изменить порядок (тяните реплику за grip)"
            onMouseDown={(ev) => {
              const row = (ev.currentTarget as HTMLElement).closest('.dlg-reply-ed');
              if (row) row.setAttribute('draggable', 'true');
            }}
            onDoubleClick={(ev) => ev.preventDefault()}
          ><Ic name="grip" size={11} /></button>
          <button type="button" className="mini-btn" title="Реплика выше" onClick={() => store.moveReply(n.id, r.id, -1)}><Ic name="chevUp" size={11} /></button>
          <button type="button" className="mini-btn" title="Реплика ниже" onClick={() => store.moveReply(n.id, r.id, 1)}><Ic name="chev" size={11} /></button>
          <button type="button" className="mini-btn" title="К реплике на холсте" onClick={() => { store.requestFlash(n.id, r.id); }}><Ic name="target" size={11} /></button>
          <button type="button" className="mini-btn" data-act="add-below" title="Новая реплика ниже" onClick={() => store.addReply(n.id, r.id, false)}><Ic name="plus" size={11} /></button>
          <button type="button" className="mini-btn" data-act="add-child" title="Ответ-ветка (вложенная)" onClick={() => store.addReply(n.id, r.id, true)}><Ic name="corner" size={11} /></button>
          <button type="button" className="mini-btn del" data-act="del" title="Удалить реплику" onClick={() => store.deleteReply(n.id, r.id)}><Ic name="x" size={11} /></button>
        </div>
        {r.children && r.children.length ? (
          <div className="dlg-children-ed">{r.children.map((ch) => renderReply(ch, depth + 1))}</div>
        ) : null}
      </div>
    );
  };

  return (
    <div
      id="dlgModal"
      className="dlg-modal show"
      role="dialog"
      aria-label="Редактор диалога"
      onPointerDown={(e) => { if ((e.target as HTMLElement).id === 'dlgModal') close(); }}
    >
      <div className="dlg-modal-card">
        <div className="dlg-modal-head">
          <span className="dlg-modal-title">Реплики: {n.title || 'Диалог'}</span>
          <button type="button" className="dlg-modal-close" title="Закрыть" onClick={close}>×</button>
        </div>
        <div className="dlg-modal-body" id="dlgModalBody" ref={listRef}>
          {partChars.length > 0 && (
            <div className="dlg-participants">
              {partChars.map((c) => {
                const color = c.color || '#9cb878';
                return (
                  <span key={c.id} className="dlg-chip" style={{ background: hexToRgba(color, 0.15), color, borderColor: hexToRgba(color, 0.55) }}>
                    <CharAvatar c={c} extra="chip" />
                    <span>{c.name}</span>
                    <span className="x" title="Убрать" onClick={() => removePart(c.id)}><Ic name="x" size={10} /></span>
                  </span>
                );
              })}
            </div>
          )}
          {n.dialog.replies.map((r) => renderReply(r, 0))}
          {!n.dialog.replies.length && <div className="dlg-empty">Реплик пока нет — добавьте первую.</div>}
          <div style={{ marginTop: 12 }}>
            <button type="button" className="dlg-add-root-btn" onClick={() => store.addReply(n.id)}>
              <Ic name="plus" size={11} /> Добавить корневую реплику
            </button>
          </div>
        </div>
        <div className="dlg-modal-foot">
          <button type="button" className="btn primary" onClick={close}>Готово</button>
        </div>
      </div>
    </div>
  );
}
