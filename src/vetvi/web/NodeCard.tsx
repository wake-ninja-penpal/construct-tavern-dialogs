'use client';

/**
 * Ветви — карточка ноды. DOM 1:1 с классическим рендером (renderWorld):
 * .node > .n-head (n-ico/n-title/n-reply-cnt/n-seq/n-st/n-fold) + .n-body
 * (n-cast/n-text/n-vars/n-tags, dlg-collapse-out + dlg-tree у диалога,
 * n-outs с br-vin/br-out/br-add у развилки и действия) + порты .port.pin/.pout.
 * Классы — из оригинального vetvi.css, инлайн-стили — как в el.style оригинала.
 */

import { memo, useLayoutEffect, useEffect, useRef, type CSSProperties, type ReactNode } from 'react';

import { NODE_W, STATUS_RU } from '@/vetvi/core/constants';
import { ALL_ICONS } from '@/vetvi/core/icons';
import { getMe } from '@/vetvi/core/identity';
import { nodeColor, shadeHex, typeInfo } from '@/vetvi/core/geometry';
import { branchVarOverride, outCondText, outConds, varName, varNodeChipText } from '@/vetvi/core/vars';
import type { VetviNode, VetviReply, VetviViewport } from '@/vetvi/core/types';
import type { VetviStore } from './store';
import type { MeasureSink } from './measure';
import { ctxMenus } from './ctxMenus';
import { noteBus } from './NoteModals';
import { RtfxView } from './RtfxView';

const STATUS_TITLE: Record<string, string> = { idea: 'Идея', draft: 'В работе', done: 'Готово' };

/* FOLD_TITLES/FOLD_ICONS оригинала: «Развернуть / Развернуть полностью / Свернуть» */
const FOLD_TITLES = ['Развернуть', 'Развернуть полностью', 'Свернуть'];
const FOLD_PATHS = [
  'm6 9 6 6 6-6',
  'm6 15 6-6 6 6',
  'M9 9 4 4m0 0v4M4 4h4M15 9l5-5m0 0v4M20 4h-4M9 15l-5 5m0 0v-4M4 20h4M15 15l5 5m0 0v-4M20 20h-4',
];

const REPEAT_D = 'M17 2.5 20.5 6 17 9.5M3.5 12V9a3 3 0 0 1 3-3h14M7 21.5 3.5 18 7 14.5M20.5 12v3a3 3 0 0 1-3 3h-14';
const GRIP_D = 'M9 5.5h.01M9 12h.01M9 18.5h.01M15 5.5h.01M15 12h.01M15 18.5h.01';
const X_D = 'M6 6l12 12M18 6 6 18';
const VAR_D = 'M5 8c2.6-5 5.4 5 8 0 1.4-2.6 3.4-3 6-1.5M5 12.5h14M5 17c2.6 5 5.4-5 8 0 1.4 2.6 3.4 3 6 1.5';

/* перетаскивание строк исходов/кнопок на карточке (bindOutcomeDrag оригинала 5864):
   grip по mousedown делает строку draggable, drop выше/ниже цели переставляет */
let cardDragOid: string | null = null;

const MAX_DLG_DEPTH = 10;
const DLG_REPLY_INDENT = 23;

/* ── отложенная запись --lk (углы соединителей вложенных реплик) ──
   Псевдоэлемент position:absolute — var ни на что в layout не влияет, поэтому
   запись можно унести в rAF: 86 карточек при загрузке проекта меряются против
   ОДНОЙ чистой layout-версии вместо 86 принудительных reflow вперемешку с
   записями стилей (главный источник лага «загрузка проекта на 80+ нод»). */
const lkWrites = new Map<HTMLElement, string>();
let lkFlushRaf = 0;
function flushLkWrites(): void {
  lkFlushRaf = 0;
  for (const [el, val] of lkWrites) {
    if (!el.isConnected) continue;
    if (el.style.getPropertyValue('--lk') !== val) el.style.setProperty('--lk', val);
  }
  lkWrites.clear();
}
function queueLkWrite(el: HTMLElement, val: string): void {
  lkWrites.set(el, val);
  if (!lkFlushRaf) lkFlushRaf = requestAnimationFrame(flushLkWrites);
}

/** Иконка заметки на карточке (noteIconSvg оригинала, size 18). */
function NoteIc({ size }: { size: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 3h9l4 4v14H6z" />
      <path d="M15 3v4h4" />
      <path d="M9 12h7M9 15.5h7M9 8.5h3" />
    </svg>
  );
}

/** Одиночная иконка оригинала (ic(): stroke 1.7, currentColor). */
function Ic({ d, size }: { d: string; size: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

export function TypeIcon({ type, size = 13, icon }: { type: string; size?: number; icon?: string | null }) {
  const paths: Record<string, string> = {
    scene: '<rect x="3" y="6" width="18" height="14" rx="2"/><path d="M3 10h18M8 6l-2 4M13 6l-2 4M18 6l-2 4"/>',
    quest: '<path d="M6 3v18"/><path d="M6 4.5h11l-2.6 3.7 2.6 3.8H6"/>',
    dialog: '<path d="M4 5.5h16v10.5h-9.5L6 20v-4H4z"/><path d="M8 9.5h8M8 12.3h5"/>',
    skill: '<path d="M13 2 5.5 13H11l-1.2 9L18 10.5h-5.5z"/>',
    action: '<path d="M9 11V5.2a1.4 1.4 0 0 1 2.8 0V11"/><path d="M11.8 10V8.6a1.3 1.3 0 0 1 2.6 0V11"/><path d="M14.4 10.6V9.8a1.3 1.3 0 0 1 2.6 0v4.7c0 3.6-2.2 5.5-5.5 5.5-2.6 0-3.9-.9-5-2.8L4.6 13.6a1.3 1.3 0 0 1 2-1.6L9 14"/>',
    branch: '<circle cx="5" cy="12" r="2.3"/><circle cx="19" cy="5" r="2.3"/><circle cx="19" cy="19" r="2.3"/><path d="M7.3 12h3.2c2.6 0 2.9-7 6.2-7M10.5 12c2.6 0 2.9 7 6.2 7"/>',
    varnode: '<path d="M5 8c2.6-5 5.4 5 8 0 1.4-2.6 3.4-3 6-1.5"/><path d="M5 12.5h14"/><path d="M5 17c2.6 5 5.4-5 8 0 1.4 2.6 3.4 3 6 1.5"/>',
    event: '<path d="M12 3v3.5M12 17.5V21M3 12h3.5M17.5 12H21M6 6l2.4 2.4M15.6 15.6 18 18M18 6l-2.4 2.4M8.4 15.6 6 18"/>',
    note: '<path d="M6.5 3h11v18l-2.8-2-2.7 2-2.7-2L6.5 21z"/><path d="M9.5 8.5h5M9.5 12h5"/>',
  };
  /* ic(name) оригинала: явная иконка (свой тип) → ALL_ICONS → fallback star */
  const d = (icon ? (ALL_ICONS[icon] || ALL_ICONS.star) : null)
    || paths[type]
    || ALL_ICONS[type]
    || ALL_ICONS.star;
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <g dangerouslySetInnerHTML={{ __html: d }} />
    </svg>
  );
}

function hexToRgba(hex: string, a: number): string {
  let h = String(hex || '').replace('#', '');
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  if (isNaN(r) || isNaN(g) || isNaN(b)) return 'rgba(154,161,172,' + a + ')';
  return 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
}

/** Число реплик с вложенными (countReplies оригинала). */
function countReplies(replies: VetviReply[]): number {
  let c = 0;
  for (const r of replies || []) {
    c++;
    if (Array.isArray(r.children)) c += countReplies(r.children);
  }
  return c;
}

/** Максимальная глубина дерева реплик (dlgMaxDepth оригинала). */
function dlgMaxDepth(replies: VetviReply[], d = 0): number {
  let max = d;
  for (const r of replies || []) {
    if (r && Array.isArray(r.children) && r.children.length) {
      const c = dlgMaxDepth(r.children, d + 1);
      if (c > max) max = c;
    }
  }
  return max;
}

/** Ширина карточки диалога (dlgNodeWidth): своя ширина + отступы вложенности. */
function dlgNodeWidthOf(n: VetviNode, replies: VetviReply[]): number {
  return (n.dlgWidth || NODE_W) + dlgMaxDepth(replies) * DLG_REPLY_INDENT;
}

function textOf(n: VetviNode): string {
  if (n.type === 'dialog') return (n.dialog && n.dialog.description) || '';
  return n.text || '';
}

function NodeCardImpl(props: {
  node: VetviNode;
  vp: VetviViewport;
  selected: boolean;
  store: VetviStore;
  sink: MeasureSink;
  /** Мигание «показать реплику» на карточке — булево (объект flash меняется на каждый запрос). */
  flashNow: boolean;
  /** Реплика, к которой прокручивает мигание (для подсветки строки диалога). */
  flashReplyId?: string | null;
  /** Метка времени запроса мигания: каждый «К ноде» — новый t, даже для той же реплики
   *  (иначе повторный показ не перезапускает анимацию подсветки). */
  flashT?: number;
  /** Поле переименования открыто на этой карточке. */
  renaming: boolean;
  /** Версия «ссылочных» данных карточек: персонажи/переменные/свои типы/связи (store.refVer). */
  depVer: number;
  lockedBy?: { id?: string; name: string; color: string } | null;
  /** Соавтор выделил эту ноду (просто рамка выделения у него) — показываем «работает здесь». */
  focusBy?: { id: string; name: string; color: string } | null;
  onDragStart: (e: React.MouseEvent, id: string) => void;
  onPinDown: (e: React.MouseEvent, id: string, out: string | null, reply: string | null) => void;
  onPinReattach: (e: React.MouseEvent, id: string) => void;
  onResizeDown: (e: React.MouseEvent, id: string) => void;
  onDblClick: (id: string) => void;
  onReplyDbl: (nodeId: string, rid: string) => void;
}) {
  const { node: n, vp, selected, sink, store, flashNow } = props;
  const rootRef = useRef<HTMLDivElement>(null);
  const renameRef = useRef<HTMLInputElement>(null);
  /* последняя замеренная версия ноды: контент меняется только заменой объекта
     (refreshSigs/mutate) — тот же объект ⇒ размеры/порты не могли измениться */
  const measuredRef = useRef<VetviNode | null>(null);

  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el || measuredRef.current === n) return;
    measuredRef.current = n;
    sink.setSize(n.id, el.offsetWidth, el.offsetHeight);
    /* порты: (rect пина − rect карточки)/z — мир-координаты НЕ зависят от зума
       (разница экранных координат уже промасштабирована, деление возвращает мир),
       поэтому пересчитывать порты на каждый шаг зума не нужно — раньше это было
       главным источником лагов: сотни принудительных layout-чтений на колесо */
    const rr = el.getBoundingClientRect();
    const z = vp.z || 1;
    el.querySelectorAll<HTMLElement>('[data-pin]').forEach((pin) => {
      const pr = pin.getBoundingClientRect();
      const key = n.id + ':' + String(pin.dataset.pin || '');
      sink.setPort(key, { x: n.x + (pr.left + pr.width / 2 - rr.left) / z, y: n.y + (pr.top + pr.height / 2 - rr.top) / z });
    });
    /* углы соединителей вложенных реплик (layoutDlgConnectors оригинала) —
       запись отложена в rAF, чтобы не ломать layout между замерами карточек */
    el.querySelectorAll<HTMLElement>('.dlg-children').forEach((ch) => {
      const items = ch.children;
      if (!items.length) return;
      const last = items[items.length - 1] as HTMLElement;
      if (!last.classList || !last.classList.contains('dlg-item')) return;
      const row = last.querySelector('.dlg-reply-row') as HTMLElement | null;
      if (!row) return;
      const rowH = row.offsetHeight;
      const topOff = last.previousElementSibling === null ? 7 : 3;
      queueLkWrite(last, (2 + rowH / 2 + topOff) + 'px');
    });
  });

  const renaming = props.renaming === undefined ? store.renameId === n.id : props.renaming;

  useEffect(() => {
    if (renaming && renameRef.current) {
      renameRef.current.focus();
      renameRef.current.select();
    }
  }, [renaming]);

  /* мигание реплики («К ноде» из проигрывателя / двойной клик): класс .dlg-flash
     в рендере не перезапускает анимацию, если он УЖЕ на строке (повторный показ
     той же реплики при выделенной ноде). Перезапускаем вручную: снять класс →
     принудительный reflow → вернуть (тот же приём, что в DialogModal). */
  const flashT = props.flashT || 0;
  const flashReplyId = props.flashReplyId || null;
  useEffect(() => {
    if (!flashNow || !flashReplyId) return;
    const el = rootRef.current?.querySelector('.dlg-flash') as HTMLElement | null;
    if (!el) return;
    el.classList.remove('dlg-flash');
    void el.offsetWidth;
    el.classList.add('dlg-flash');
  }, [flashNow, flashReplyId, flashT]);

  const isDlg = n.type === 'dialog';
  const info = typeInfo(n.type, store.doc.customTypes);
  const ex = (n.expand === 0 || n.expand === 1 || n.expand === 2) ? n.expand : 1;
  const status = STATUS_RU[n.status] ? n.status : 'idea';
  const isFlash = flashNow;

  /* чужой лок: обводка цветом участника (lkb оригинала) */
  const lkRaw = props.lockedBy as { id?: string; name?: string; color?: string } | null | undefined;
  const lk = (lkRaw && lkRaw.id && lkRaw.id !== getMe().id) ? lkRaw : null;
  /* чужое выделение: мягкая пунктирная рамка + плашка с именем участника */
  const focusBy = (props.focusBy && props.focusBy.id !== getMe().id) ? props.focusBy : null;
  const lockBlocked = (): boolean => {
    if (!lk) return false;
    store.toast('Ноду сейчас правит ' + lk.name, 'warn');
    return true;
  };

  /* краска карточки: участники → цвет персонажа, иначе своя краска/цвет типа (renderWorld) */
  const castPs = (!isDlg && Array.isArray(n.participants)) ? (n.participants as string[]) : [];
  const cc = castPs.length ? store.charColor(castPs[0]) : null;
  const paint = (!cc && n.color) ? nodeColor(n, store.doc.customTypes) : null;

  const dlgReplies: VetviReply[] = (isDlg && n.dialog && Array.isArray(n.dialog.replies)) ? n.dialog.replies : [];
  const dlgParticipants = (isDlg && n.dialog && Array.isArray(n.dialog.participants)) ? n.dialog.participants : [];
  const width = isDlg ? dlgNodeWidthOf(n, dlgReplies) : NODE_W;

  /* исходящие связи ноды: подсветка «живых» пинов и «Исходы реплик» (updateDlgRowStates) */
  const fromEdges = store.doc.edges.filter((e) => e.from === n.id);
  const replyOutIds = new Set<string>(fromEdges.filter((e) => !!e.fromReply).map((e) => e.fromReply as string));
  const outPinIds = new Set<string>(fromEdges.filter((e) => !!e.fromOut).map((e) => e.fromOut as string));

  const outcomes = (n.type === 'branch' && Array.isArray(n.outcomes)) ? n.outcomes : [];
  const actions: { id: string; label?: string }[] = (n.type === 'action' && Array.isArray(n.actions)) ? (n.actions as { id: string; label?: string }[]) : [];
  const ovIn = branchVarOverride(store.doc, n);
  const tags = Array.isArray(n.tags) ? n.tags : [];
  const txt = textOf(n);

  /* заметки элемента: видимые стикеры с индексом в n.notes (renderNodeNotes) */
  const notesArr = Array.isArray(n.notes) ? n.notes : [];
  const visNotes = notesArr.map((note, ni) => ({ note, ni })).filter((x) => !x.note.hidden);

  const poutTitle =
    (isDlg ? 'выход диалога (правая грань, внизу)' : n.type === 'action' || n.type === 'branch' ? 'выход (правая грань, внизу)' : 'выход — тяните к другому узлу') +
    ' · Ctrl+тянуть — отсоединить и перенести исходящие';

  /* каркас перетаскивания строки исхода/кнопки за grip (bindOutcomeDrag оригинала) */
  const rowDrag = (oid: string, kind: 'outcome' | 'action') => ({
    onDragStart: (ev: React.DragEvent) => {
      const row = ev.currentTarget as HTMLElement;
      if (row.getAttribute('draggable') !== 'true') { ev.preventDefault(); return; }
      ev.dataTransfer.effectAllowed = 'move';
      try { ev.dataTransfer.setData('text/plain', oid); } catch { /* старые браузеры */ }
      cardDragOid = oid;
      setTimeout(() => row.classList.add('dragging'), 0);
    },
    onDragEnd: (ev: React.DragEvent) => {
      const row = ev.currentTarget as HTMLElement;
      row.removeAttribute('draggable');
      row.classList.remove('dragging', 'drop-above', 'drop-below');
      cardDragOid = null;
    },
    onDragOver: (ev: React.DragEvent) => {
      if (!cardDragOid || cardDragOid === oid) return;
      ev.preventDefault();
      ev.dataTransfer.dropEffect = 'move';
      const row = ev.currentTarget as HTMLElement;
      const rect = row.getBoundingClientRect();
      const below = (ev.clientY - rect.top) > (rect.height / 2);
      row.classList.toggle('drop-below', below);
      row.classList.toggle('drop-above', !below);
    },
    onDragLeave: (ev: React.DragEvent) => {
      (ev.currentTarget as HTMLElement).classList.remove('drop-above', 'drop-below');
    },
    onDrop: (ev: React.DragEvent) => {
      ev.preventDefault();
      ev.stopPropagation();
      const row = ev.currentTarget as HTMLElement;
      const rect = row.getBoundingClientRect();
      const below = (ev.clientY - rect.top) > (rect.height / 2);
      row.classList.remove('drop-above', 'drop-below');
      const src = cardDragOid;
      cardDragOid = null;
      if (!src || src === oid) return;
      if (kind === 'outcome') store.moveOutcomePair(n.id, src, oid, below);
      else store.moveActionPair(n.id, src, oid, below);
    },
  });

  const rowGrip = (title: string) => ({
    'data-nodrag': true,
    title,
    onPointerDown: (ev: React.PointerEvent) => ev.stopPropagation(),
    onMouseDown: (ev: React.MouseEvent) => {
      const row = (ev.currentTarget as HTMLElement).closest('.br-out');
      if (row) row.setAttribute('draggable', 'true');
    },
    onDoubleClick: (ev: React.MouseEvent) => ev.preventDefault(),
  });

  const commitRename = () => {
    const v = renameRef.current?.value ?? '';
    store.updateNode(n.id, { title: v }, { label: 'Переименование ноды' });
    store.cancelRename();
  };

  /* дерево реплик (dlgNodeAvatar/dlgRenderReplies оригинала) */
  const renderReply = (r: VetviReply, depth: number): ReactNode => {
    if (depth >= MAX_DLG_DEPTH) return null;
    const sid = r.speaker || null;
    const spChar = sid ? store.charById(sid) : null;
    const speakerName = sid ? store.charName(sid) : '?';
    const speakerColor = sid ? store.charColor(sid) : '#8b929c';
    const spAv = spChar ? ((spChar.av as string | null) || null) : null;
    const spShape = spChar && spChar.avShape === 'square' ? 'square' : 'circle';
    const initial = spChar ? ((String(spChar.name || '').trim()[0] || '?').toUpperCase()) : '';
    const flashing = isFlash && props.flashReplyId === r.id;
    const connected = replyOutIds.has(r.id);
    return (
      <div className="dlg-item" key={r.id}>
        <div
          className={'dlg-reply-row' + (connected ? ' has-out' : '') + (flashing ? ' dlg-flash' : '')}
          data-reply-id={r.id}
          onDoubleClick={(e) => {
            e.stopPropagation(); /* не даём нодному dblclick затереть flash реплики */
            const t = e.target as HTMLElement;
            if (t.closest('[data-pin]') || t.closest('button')) return;
            props.onReplyDbl(n.id, r.id);
          }}
        >
          {spChar && (
            <span className={'dlg-av ' + spShape + (spAv ? '' : ' empty')} style={{ borderColor: speakerColor }} title={spChar.name || ''}>
              {spAv ? <img src={spAv} alt="" /> : initial}
            </span>
          )}
          <span className="t">
            <span className="speaker" style={{ color: speakerColor }}>{speakerName}:</span>
            <RtfxView text={String(r.text || '')} />
          </span>
          <button
            type="button"
            className={'dlg-loop' + (r.loop ? ' on' : '')}
            data-loop={r.id}
            data-nodrag
            title="Повтор: после этой реплики диалог начнётся заново — клик включит или выключит зацикливание"
            onClick={(e) => { e.stopPropagation(); if (!lockBlocked()) store.updateReply(n.id, r.id, { loop: !r.loop }, { label: 'Повтор реплики' }); }}
          >
            <Ic d={REPEAT_D} size={10} />
          </button>
          <i
            className={'dlg-reply-pin out' + (connected ? ' live' : '')}
            data-reply-id={r.id}
            data-pin={'reply:' + r.id}
            title="Выход из реплики — тяните к элементу (можно и на саму ноду — диалог начнётся заново)"
            onMouseDown={(e) => { e.stopPropagation(); props.onPinDown(e, n.id, null, r.id); }}
          />
        </div>
        {Array.isArray(r.children) && r.children.length > 0 && (
          <div className="dlg-children">{r.children.map((ch) => renderReply(ch, depth + 1))}</div>
        )}
      </div>
    );
  };

  const rootStyle = {
    left: n.x,
    top: n.y,
    width,
    ['--c']: cc || info.color,
    /* цвет персонажа — ОБВОДКА карточки, а не заливка: фон ноды остаётся базовым,
       цвет идёт в рамку (цвет + внутреннее кольцо тем же тоном) */
    ...(cc ? { borderColor: cc, boxShadow: '0 6px 18px rgba(0,0,0,.38), inset 0 0 0 1px ' + shadeHex(cc, -14) } : null),
    ...(paint ? { background: 'linear-gradient(' + shadeHex(paint, 10) + ',' + shadeHex(paint, -8) + ')', borderColor: shadeHex(paint, -30) } : null),
    ...(lk ? { ['--lkc']: lk.color } : null),
    ...(focusBy ? { ['--fc']: focusBy.color } : null),
  } as CSSProperties;

  return (
    <div
      ref={rootRef}
      data-node-id={n.id}
      data-id={n.id}
      className={'node t-' + n.type + ' st-' + status + ' ex-' + ex + (selected ? ' sel' : '') + (lk ? ' lkb' : '') + (focusBy ? ' foc' : '')}
      style={rootStyle}
      onMouseDown={(e) => {
        const t = e.target as HTMLElement;
        if (t.closest('[data-pin]') || t.closest('[data-nodrag]')) return;
        /* Ctrl/⌘+ЛКМ, Space, средняя кнопка — пан по холсту, нода игнорируется
           (8104/8297 оригинала: не выделяем и не тащим — событие уходит на canvas) */
        if (e.button === 1 || store.spaceDown || ((e.ctrlKey || e.metaKey) && !e.altKey)) return;
        e.stopPropagation();
        if (e.shiftKey) store.toggleSelect(n.id);
        else if (!selected) store.selectOnly(n.id);
        props.onDragStart(e, n.id);
      }}
      onDoubleClick={(e) => {
        const t = e.target as HTMLElement;
        if (t.closest('[data-pin]') || t.closest('[data-nodrag]')) return;
        props.onDblClick(n.id);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        if (!selected) store.selectOnly(n.id);
        store.openCtx(e.clientX, e.clientY, ctxMenus(store).node(n.id));
      }}
    >
      {focusBy && (
        <span className="n-focus-chip" title={(focusBy.name || 'Участник') + ' работает с этой нодой'}>
          <i className="dot" style={{ background: focusBy.color || '#8b929c' }} />
          <span className="nm">{focusBy.name || 'участник'}</span>
        </span>
      )}
      <div className="n-head">
        <span className="n-ico"><TypeIcon type={n.type} size={15} /></span>
        {renaming ? (
          <input
            ref={renameRef}
            className="n-title-inp"
            defaultValue={n.title}
            aria-label="Название ноды"
            data-nodrag
            onMouseDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitRename();
              if (e.key === 'Escape') store.cancelRename();
            }}
            onBlur={commitRename}
          />
        ) : (
          <span className="n-title">{n.title}</span>
        )}
        {isDlg && <span className="n-reply-cnt">{countReplies(dlgReplies)} репл.</span>}
        {isDlg && (
          <button
            type="button"
            className={'n-seq' + (n.linear ? ' on' : '')}
            data-nodrag
            title="Проигрывать реплики подряд — все реплики одна за другой, без выбора ответа"
            onClick={(e) => { e.stopPropagation(); if (!lockBlocked()) store.setDlgLinear(n.id, !n.linear); }}
          >
            <i />
          </button>
        )}
        <span
          className={'n-st st-' + status}
          data-nodrag
          title={STATUS_TITLE[status] || status}
          onClick={(e) => { e.stopPropagation(); store.cycleStatus(n.id); }}
        />
        <button
          type="button"
          className="n-fold"
          data-nodrag
          title={FOLD_TITLES[ex]}
          onClick={(e) => { e.stopPropagation(); store.cycleExpand(n.id); }}
        >
          <Ic d={FOLD_PATHS[ex]} size={12} />
        </button>
      </div>
      <div className="n-body">
        {castPs.length > 0 && (
          <div className="n-cast">
            {castPs.map((pid) => (
              <span key={pid} data-cid={pid} title="Прикреплённый персонаж" style={{ background: store.charColor(pid), color: '#16181d' }}>
                {store.charName(pid)}
              </span>
            ))}
          </div>
        )}
        <div className={'n-text' + (txt ? '' : ' empty')}>{isDlg ? (txt || 'Описание не задано') : (txt || 'без описания')}</div>
        <div className="n-vars">{n.type === 'varnode' ? <span>{varNodeChipText(store.doc, n)}</span> : null}</div>
        <div className="n-tags" style={tags.length ? undefined : { display: 'none' }}>
          {tags.map((t, i) => <span key={i}>{String(t)}</span>)}
        </div>
        {isDlg && (
          <div className={'dlg-collapse-out' + (replyOutIds.size ? ' has-any' : '')}>
            <span className="t">Исходы реплик</span>
            <i className="dlg-collapse-pin" data-pin="collapse" />
          </div>
        )}
        {isDlg && (
          <div className="dlg-tree">
            {dlgParticipants.length > 0 && (
              <div className="dlg-participants">
                {dlgParticipants.map((pid) => {
                  const c = store.charById(pid);
                  const color = store.charColor(pid);
                  const av = c ? ((c.av as string | null) || null) : null;
                  const shape = c && c.avShape === 'square' ? 'square' : 'circle';
                  return (
                    <span key={pid} className="dlg-participant" style={{ background: hexToRgba(color, 0.18), color }}>
                      {c && (
                        <span className={'c-av mini ' + shape + (av ? '' : ' empty')} style={{ borderColor: c.color || '#9cb878' }}>
                          {av ? <img src={av} alt="" /> : (String(c.name || '').trim()[0] || '?').toUpperCase()}
                        </span>
                      )}
                      {store.charName(pid)}
                    </span>
                  );
                })}
              </div>
            )}
            {dlgReplies.length > 0 ? (
              <div className="dlg-replies">{dlgReplies.map((r) => renderReply(r, 0))}</div>
            ) : (
              <div className="dlg-empty">Нет реплик — откройте инспектор</div>
            )}
          </div>
        )}
        {n.type === 'branch' && (
          <div className="n-outs">
            <div
              className={'br-vin' + (ovIn ? '' : ' none')}
              title="Вход переменной: потяните сюда связь от ноды переменной — она перебьёт переменные в условиях исходов"
            >
              <i className={'vpinn' + (ovIn ? ' has' : '')} data-pin="varin" title="Вход переменной" />
              <span className="t"><Ic d={VAR_D} size={11} /><span>переменная</span></span>
              <span className="vv">{ovIn ? '⟵ ' + varName(store.doc, ovIn) : 'не подключена'}</span>
            </div>
            {outcomes.map((o, i) => {
              const nm = o.label || ('Исход ' + (i + 1));
              const oc = outConds(o);
              const ocTxt = oc.length ? outCondText(store.doc, o, n) : '';
              return (
                <div className="br-out" key={o.id} data-oid={o.id} {...rowDrag(o.id, 'outcome')}>
                  <span className="br-grip" {...rowGrip('Перетащите — изменить порядок исходов')}><Ic d={GRIP_D} size={10} /></span>
                  <span className="lbl">{nm}</span>
                  <span
                    className={'cnd' + (oc.length ? ' on' : '')}
                    title={oc.length ? 'Условия исхода: ' + ocTxt : 'Без условия — путь всегда открыт'}
                  >
                    {oc.length ? '⟦ ' + ocTxt + ' ⟧' : 'без условия'}
                  </span>
                  <button
                    type="button"
                    className="br-x"
                    data-oid={o.id}
                    data-nodrag
                    title="Убрать исход"
                    onClick={(e) => { e.stopPropagation(); if (!lockBlocked()) store.deleteOutcome(n.id, o.id); }}
                  >
                    <Ic d={X_D} size={10} />
                  </button>
                  <i
                    className={'opin' + (outPinIds.has(o.id) ? ' live' : '')}
                    data-out={o.id}
                    data-pin={'out:' + o.id}
                    title={'Исход «' + nm + '» — тяните к другому узлу'}
                    onMouseDown={(e) => { e.stopPropagation(); props.onPinDown(e, n.id, o.id, null); }}
                  />
                </div>
              );
            })}
            <button
              type="button"
              className="br-add"
              data-nodrag
              title="Добавить исход (пин на узле)"
              onClick={(e) => { e.stopPropagation(); if (!lockBlocked()) store.addOutcome(n.id); }}
            >
              + исход
            </button>
          </div>
        )}
        {n.type === 'action' && (
          <div className="n-outs">
            {actions.map((a, i) => {
              const nm = a.label || ('Кнопка ' + (i + 1));
              return (
                <div className="br-out ac-out" key={a.id} data-oid={a.id} {...rowDrag(a.id, 'action')}>
                  <span className="br-grip" {...rowGrip('Перетащите — изменить порядок кнопок')}><Ic d={GRIP_D} size={10} /></span>
                  <span className="lbl">{nm}</span>
                  <button
                    type="button"
                    className="br-x"
                    data-oid={a.id}
                    data-nodrag
                    title="Убрать кнопку"
                    onClick={(e) => { e.stopPropagation(); if (!lockBlocked()) store.deleteAction(n.id, a.id); }}
                  >
                    <Ic d={X_D} size={10} />
                  </button>
                  <i
                    className="opin"
                    data-out={a.id}
                    data-pin={'out:' + a.id}
                    title={'Кнопка «' + nm + '» — тяните к другому узлу'}
                    onMouseDown={(e) => { e.stopPropagation(); props.onPinDown(e, n.id, a.id, null); }}
                  />
                </div>
              );
            })}
            <button
              type="button"
              className="br-add"
              data-nodrag
              title="Добавить кнопку — у неё будет свой пин-исход на узле"
              onClick={(e) => { e.stopPropagation(); if (!lockBlocked()) store.addAction(n.id); }}
            >
              + кнопка
            </button>
          </div>
        )}
      </div>
      {isDlg && (
        <div
          style={{ position: 'absolute', top: 0, right: -3, bottom: 0, width: 9, cursor: 'ew-resize' }}
          data-nodrag
          title="Ширина диалога: потянуть"
          onMouseDown={(e) => { e.stopPropagation(); props.onResizeDown(e, n.id); }}
        />
      )}
      <i className="port pin" data-pin="in" title="вход — потяните, чтобы перенести входящие стрелки" />
      <i className="port pin" data-pin="in" title="вход — потяните (можно с Ctrl), чтобы отсоединить и перенести входящие стрелки" />
      <i
        className="port pout"
        data-pin="out"
        title={poutTitle}
        onMouseDown={(e) => { e.stopPropagation(); if (e.ctrlKey || e.metaKey) props.onPinReattach(e, n.id); else props.onPinDown(e, n.id, null, null); }}
      />
      {visNotes.length > 0 && (
        <div className="node-notes">
          {visNotes.map(({ note, ni }) => (
            <button
              key={ni}
              type="button"
              className="node-note-ico"
              title={note.title || 'Заметка'}
              data-nodrag
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => { e.stopPropagation(); noteBus.openView(n.id, ni); }}
            >
              <NoteIc size={18} />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ── memo: карточка перерисовывается только когда изменились ЕЁ данные ──
   node — новый объект при любом изменении содержимого (store.refreshSigs);
   depVer — персонажи/переменные/свои типы/связи; остальные props — примитивы
   или стабильные ссылки (store/sink/callbacks). Благодаря этому перетаскивание
   ноды, панорама, зум и печать в инспекторе не перекатывают сотни карточек. */
function lockEq(a: { id?: string; name?: string; color?: string } | null | undefined, b: { id?: string; name?: string; color?: string } | null | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.id === b.id && a.name === b.name && a.color === b.color;
}
export const NodeCard = memo(NodeCardImpl, (a, b) =>
  a.node === b.node
  && a.selected === b.selected
  && a.depVer === b.depVer
  && a.flashNow === b.flashNow
  && a.flashReplyId === b.flashReplyId
  && (a.flashT || 0) === (b.flashT || 0)
  && a.renaming === b.renaming
  && lockEq(a.lockedBy, b.lockedBy)
  && lockEq(a.focusBy, b.focusBy)
);
