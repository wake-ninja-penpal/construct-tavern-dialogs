'use client';

/**
 * Ветви — карточка ноды. DOM 1:1 с классическим рендером (renderWorld):
 * .node > .n-head (n-ico/n-title/n-reply-cnt/n-seq/n-st/n-fold) + .n-body
 * (n-cast/n-text/n-vars/n-tags, dlg-collapse-out + dlg-tree у диалога,
 * n-outs с br-vin/br-out/br-add у развилки и действия) + порты .port.pin/.pout.
 * Классы — из оригинального vetvi.css, инлайн-стили — как в el.style оригинала.
 */

import { useLayoutEffect, useEffect, useRef, type CSSProperties, type ReactNode } from 'react';

import { NODE_W, STATUS_RU } from '@/vetvi/core/constants';
import { getMe } from '@/vetvi/core/identity';
import { nodeColor, shadeHex, typeInfo } from '@/vetvi/core/geometry';
import { branchVarOverride, condText, varName, varNodeChipText } from '@/vetvi/core/vars';
import type { VetviNode, VetviReply, VetviViewport } from '@/vetvi/core/types';
import type { VetviStore } from './store';
import type { MeasureSink } from './measure';
import { ctxMenus } from './ctxMenus';

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

const MAX_DLG_DEPTH = 10;
const DLG_REPLY_INDENT = 23;

/** Одиночная иконка оригинала (ic(): stroke 1.7, currentColor). */
function Ic({ d, size }: { d: string; size: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  );
}

export function TypeIcon({ type, size = 13 }: { type: string; size?: number }) {
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
  const d = paths[type] || paths.scene;
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

export function NodeCard(props: {
  node: VetviNode;
  vp: VetviViewport;
  selected: boolean;
  store: VetviStore;
  sink: MeasureSink;
  flash: { nodeId: string; replyId: string | null; t: number } | null;
  lockedBy?: { name: string; color: string } | null;
  onDragStart: (e: React.MouseEvent, id: string) => void;
  onPinDown: (e: React.MouseEvent, id: string, out: string | null, reply: string | null) => void;
  onPinReattach: (e: React.MouseEvent, id: string) => void;
  onResizeDown: (e: React.MouseEvent, id: string) => void;
  onDblClick: (id: string) => void;
  onReplyDbl: (nodeId: string, rid: string) => void;
}) {
  const { node: n, vp, selected, sink, store, flash } = props;
  const rootRef = useRef<HTMLDivElement>(null);
  const renameRef = useRef<HTMLInputElement>(null);

  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    sink.setSize(n.id, el.offsetWidth, el.offsetHeight);
    const rr = el.getBoundingClientRect();
    const z = vp.z || 1;
    el.querySelectorAll<HTMLElement>('[data-pin]').forEach((pin) => {
      const pr = pin.getBoundingClientRect();
      const key = n.id + ':' + String(pin.dataset.pin || '');
      sink.setPort(key, { x: n.x + (pr.left + pr.width / 2 - rr.left) / z, y: n.y + (pr.top + pr.height / 2 - rr.top) / z });
    });
    /* углы соединителей вложенных реплик (layoutDlgConnectors оригинала) */
    el.querySelectorAll<HTMLElement>('.dlg-children').forEach((ch) => {
      const items = ch.children;
      if (!items.length) return;
      const last = items[items.length - 1] as HTMLElement;
      if (!last.classList || !last.classList.contains('dlg-item')) return;
      const row = last.querySelector('.dlg-reply-row') as HTMLElement | null;
      if (!row) return;
      const rowH = row.offsetHeight;
      const topOff = last.previousElementSibling === null ? 7 : 3;
      last.style.setProperty('--lk', (2 + rowH / 2 + topOff) + 'px');
    });
  });

  const renaming = store.renameId === n.id;

  useEffect(() => {
    if (renaming && renameRef.current) {
      renameRef.current.focus();
      renameRef.current.select();
    }
  }, [renaming]);

  const isDlg = n.type === 'dialog';
  const info = typeInfo(n.type);
  const ex = (n.expand === 0 || n.expand === 1 || n.expand === 2) ? n.expand : 1;
  const status = STATUS_RU[n.status] ? n.status : 'idea';
  const isFlash = !!(flash && flash.nodeId === n.id);

  /* чужой лок: обводка цветом участника (lkb оригинала) */
  const lkRaw = props.lockedBy as { id?: string; name?: string; color?: string } | null | undefined;
  const lk = (lkRaw && lkRaw.id && lkRaw.id !== getMe().id) ? lkRaw : null;
  const lockBlocked = (): boolean => {
    if (!lk) return false;
    store.toast('Ноду сейчас правит ' + lk.name, 'warn');
    return true;
  };

  /* краска карточки: участники → цвет персонажа, иначе своя краска/цвет типа (renderWorld) */
  const castPs = (!isDlg && Array.isArray(n.participants)) ? (n.participants as string[]) : [];
  const cc = castPs.length ? store.charColor(castPs[0]) : null;
  const paint = (!cc && n.color) ? nodeColor(n) : null;

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

  const poutTitle =
    (isDlg ? 'выход диалога (правая грань, внизу)' : n.type === 'action' || n.type === 'branch' ? 'выход (правая грань, внизу)' : 'выход — тяните к другому узлу') +
    ' · Ctrl+тянуть — отсоединить и перенести исходящие';

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
    const flashing = isFlash && flash?.replyId === r.id;
    const connected = replyOutIds.has(r.id);
    return (
      <div className="dlg-item" key={r.id}>
        <div
          className={'dlg-reply-row' + (connected ? ' has-out' : '') + (flashing ? ' dlg-flash' : '')}
          data-reply-id={r.id}
          onDoubleClick={(e) => {
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
            {String(r.text || '')}
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
    ...(cc ? { background: 'linear-gradient(' + shadeHex(cc, 10) + ',' + shadeHex(cc, -8) + ')', borderColor: shadeHex(cc, -30) } : null),
    ...(paint ? { background: 'linear-gradient(' + shadeHex(paint, 10) + ',' + shadeHex(paint, -8) + ')', borderColor: shadeHex(paint, -30) } : null),
    ...(lk ? { ['--lkc']: lk.color } : null),
  } as CSSProperties;

  return (
    <div
      ref={rootRef}
      data-node-id={n.id}
      data-id={n.id}
      className={'node t-' + n.type + ' st-' + status + ' ex-' + ex + (selected ? ' sel' : '') + (lk ? ' lkb' : '')}
      style={rootStyle}
      onMouseDown={(e) => {
        const t = e.target as HTMLElement;
        if (t.closest('[data-pin]') || t.closest('[data-nodrag]')) return;
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
              return (
                <div className="br-out" key={o.id} data-oid={o.id}>
                  <span className="br-grip" title="Перетащите — изменить порядок исходов"><Ic d={GRIP_D} size={10} /></span>
                  <span className="lbl">{nm}</span>
                  <span
                    className={'cnd' + (o.cond ? ' on' : '')}
                    title={o.cond ? 'Условие: ' + condText(store.doc, o.cond) : 'Без условия — путь всегда открыт'}
                  >
                    {o.cond ? '⟦ ' + condText(store.doc, o.cond) + ' ⟧' : 'без условия'}
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
                <div className="br-out ac-out" key={a.id} data-oid={a.id}>
                  <span className="br-grip" title="Перетащите — изменить порядок кнопок"><Ic d={GRIP_D} size={10} /></span>
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
    </div>
  );
}
