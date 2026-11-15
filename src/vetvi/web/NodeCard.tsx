'use client';

/**
 * Ветви — карточка ноды (этап 2): спикеры/цвета персонажей, пины реплик,
 * «повтор», сворачивание с пином, исходы с пинами и условиями, вход переменной
 * развилки, инлайн-переименование, ресайз ширины диалога, вспышка реплики.
 */

import { useLayoutEffect, useEffect, useRef } from 'react';

import { STATUS_RU } from '@/vetvi/core/constants';
import { nodeColor, typeInfo } from '@/vetvi/core/geometry';
import type { VetviNode, VetviViewport } from '@/vetvi/core/types';
import { condText, varNodeChipText } from '@/vetvi/core/vars';
import type { VetviStore } from './store';
import type { MeasureSink } from './measure';

const STATUS_COLOR: Record<string, string> = { idea: '#d8c96f', draft: '#8f96a2', done: '#8fbf7f' };

export function TypeIcon({ type, size = 13 }: { type: string; size?: number }) {
  const paths: Record<string, string> = {
    scene: '<rect x="3" y="6" width="18" height="14" rx="2"/><path d="M3 10h18M8 6l-2 4M13 6l-2 4M18 6l-2 4"/>',
    quest: '<path d="M6 3v18"/><path d="M6 4.5h11l-2.6 3.7 2.6 3.8H6"/>',
    dialog: '<path d="M4 5.5h16v10.5h-9.5L6 20v-4H4z"/><path d="M8 9.5h8M8 12.3h5"/>',
    skill: '<path d="M13 2 5.5 13H11l-1.2 9L18 10.5h-5.5z"/>',
    action: '<path d="M5 7h14M5 12h9M5 17h14"/>',
    branch: '<circle cx="5" cy="12" r="2.3"/><circle cx="19" cy="5" r="2.3"/><circle cx="19" cy="19" r="2.3"/><path d="M7.3 12h3.2c2.6 0 2.9-7 6.2-7M10.5 12c2.6 0 2.9 7 6.2 7"/>',
    varnode: '<path d="M7 4h10M12 4v16M8 20h8"/>',
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

function textOf(n: VetviNode): string {
  if (n.type === 'dialog' && n.dialog) return n.dialog.description || '';
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
  });

  const renaming = store.renameId === n.id;

  useEffect(() => {
    if (renaming && renameRef.current) {
      renameRef.current.focus();
      renameRef.current.select();
    }
  }, [renaming]);

  const color = nodeColor(n);
  const info = typeInfo(n.type);
  const status = STATUS_RU[n.status] ? n.status : 'idea';
  const collapsed = n.expand === 0;
  const mainBottom = n.type === 'dialog' || n.type === 'action' || n.type === 'branch';
  const width = n.dlgWidth && n.dlgWidth >= 216 ? n.dlgWidth : 216;
  const isFlash = !!(flash && flash.nodeId === n.id);
  const chars = store.doc.chars || [];

  const replies = (!collapsed && n.type === 'dialog' && n.dialog?.replies) ? n.dialog.replies : [];
  const outcomes = (!collapsed && n.type === 'branch' && Array.isArray(n.outcomes)) ? n.outcomes : [];
  const actions = (!collapsed && n.type === 'action' && Array.isArray(n.actions)) ? (n.actions as { id: string; label?: string }[]) : [];
  const outs = n.type === 'action' ? actions : outcomes;
  const hasVarIn = n.type === 'branch';

  const commitRename = () => {
    const v = renameRef.current?.value ?? '';
    store.updateNode(n.id, { title: v }, { label: 'Переименование ноды' });
    store.cancelRename();
  };

  const speakerOf = (sid: string | null): { name: string; color: string; av: string | null; shape: string } | null => {
    if (!sid) return null;
    const c = store.charById(sid);
    if (c) return { name: c.name || '(без имени)', color: c.color || '#8b929c', av: (c.av as string | null) || null, shape: c.avShape === 'square' ? 'square' : 'circle' };
    const nn = store.nodeById(sid);
    if (nn) return { name: nn.title || '(без имени)', color: nn.color || info.color, av: null, shape: 'circle' };
    return { name: '(неизвестный)', color: '#8b929c', av: null, shape: 'circle' };
  };

  const renderReply = (r: { id: string; speaker?: string | null; text?: string; loop?: boolean; children?: { id: string }[] }) => {
    const sp = speakerOf(r.speaker ?? null);
    const flashing = isFlash && flash?.replyId === r.id;
    return (
      <div className={'rn-reply' + (flashing ? ' flash' : '')} key={r.id} data-reply-id={r.id}>
        <span className="rn-reply-sp" style={sp ? { color: sp.color } : undefined}>
          {sp && <span className={'rn-av ' + sp.shape + (sp.av ? '' : ' empty')} style={{ borderColor: sp.color }}>{sp.av ? <img src={sp.av} alt="" /> : (sp.name[0] || '?').toUpperCase()}</span>}
          {sp ? sp.name : '—'}
        </span>
        <span className="rn-reply-t">{String(r.text || '')}</span>
        {!!r.loop && <span className="rn-loop" title="Повтор: диалог зациклен">↻</span>}
        <span
          className="rn-reply-pin"
          data-pin={'reply:' + r.id}
          title="Исход из реплики: потянуть связь"
          onMouseDown={(e) => { e.stopPropagation(); props.onPinDown(e, n.id, null, r.id); }}
        />
        {(r.children || []).map((ch) => renderReply(ch as { id: string; speaker?: string | null; text?: string; loop?: boolean; children?: { id: string }[] }))}
      </div>
    );
  };

  return (
    <div
      ref={rootRef}
      data-node-id={n.id}
      className={'rn-node' + (selected ? ' sel' : '') + (collapsed ? ' ex-0' : n.expand === 2 ? ' ex-2' : ' ex-1') + (isFlash ? ' flash' : '')}
      style={{ left: n.x, top: n.y, width, ['--c' as string]: color }}
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
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); if (!selected) store.selectOnly(n.id); }}
    >
      <span className="rn-bar" aria-hidden="true" />
      <div className="rn-head">
        <span className="rn-ico" style={{ color }}><TypeIcon type={n.type} /></span>
        {renaming ? (
          <input
            ref={renameRef}
            className="rn-rename"
            defaultValue={n.title}
            aria-label="Название ноды"
            onMouseDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitRename();
              if (e.key === 'Escape') store.cancelRename();
            }}
            onBlur={commitRename}
          />
        ) : (
          <span className="rn-title" title={n.title}>{n.title || info.name}</span>
        )}
        <span className={'rn-st st-' + status} data-nodrag title={'Статус: ' + (STATUS_RU[status] || status)} onClick={(e) => { e.stopPropagation(); store.cycleStatus(n.id); }} />
        <button type="button" className="rn-exp" data-nodrag title="Свернуть/развернуть" onClick={(e) => { e.stopPropagation(); store.cycleExpand(n.id); }}>
          <svg viewBox="0 0 24 24" width={11} height={11} fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            {n.expand === 0 ? <path d="m6 9 6 6 6-6" /> : <path d="m6 15 6-6 6 6" />}
          </svg>
        </button>
      </div>
      {!collapsed && (
        <div className="rn-body">
          {n.type === 'varnode' ? (
            <div className="rn-text rn-varchip">{varNodeChipText(store.doc, n)}</div>
          ) : (
            textOf(n) ? <div className="rn-text">{textOf(n)}</div> : <div className="rn-text empty">— пусто —</div>
          )}
          {n.type === 'dialog' && !!n.linear && <div className="rn-linear" title="Проигрывать подряд">▸▸ подряд</div>}
          {n.type === 'dialog' && !n.dialog?.replies.length && <div className="rn-text empty">реплик пока нет</div>}
          {replies.length > 0 && <div className="rn-replies">{replies.map((r) => renderReply(r))}</div>}
          {outs.length > 0 && (
            <div className="rn-outs">
              {outs.map((o) => {
                const oid = (o as { id: string }).id;
                const cond = (o as { cond?: { vid: string; op: string; val: number | string } }).cond;
                return (
                  <div className="rn-out" key={oid}>
                    <span className="rn-out-l">{String((o as { label?: string }).label || '—')}</span>
                    {cond && <span className="rn-out-cond" title={condText(store.doc, cond)}>⌥</span>}
                    <span
                      className="rn-opin"
                      data-pin={'out:' + oid}
                      data-out={oid}
                      title="Исход: потянуть связь"
                      onMouseDown={(e) => { e.stopPropagation(); props.onPinDown(e, n.id, oid, null); }}
                    />
                  </div>
                );
              })}
            </div>
          )}
          {hasVarIn && (
            <div className="rn-varin">
              <span>вход переменной</span>
              <span className="rn-vpinn" data-pin="varin" title="Вход переменной развилки: потяните связь от ноды «Переменная»" />
            </div>
          )}
          {Array.isArray(n.tags) && n.tags.length > 0 && (
            <div className="rn-tags">{(n.tags as string[]).slice(0, 4).map((t, i) => <span key={i}>{String(t)}</span>)}</div>
          )}
        </div>
      )}
      {collapsed && n.type === 'dialog' && !!n.dialog?.replies?.length && (
        <div className="rn-collapsed-info">{n.dialog.replies.length} репл.</div>
      )}
      <span className="rn-ipin" data-pin="in" title="Вход" />
      {collapsed && (
        <span className="rn-cpin" data-pin="collapse" title="Выход свернутого диалога" />
      )}
      <span
        className={'rn-opin main' + (mainBottom ? ' mb' : '')}
        data-pin="out"
        title="Выход: потянуть связь. Ctrl — перенести исходящие"
        onMouseDown={(e) => { e.stopPropagation(); if (e.ctrlKey || e.metaKey) props.onPinReattach(e, n.id); else props.onPinDown(e, n.id, null, null); }}
      />
      {n.type === 'dialog' && (
        <span
          className="rn-wband"
          data-nodrag
          title="Ширина диалога: потянуть"
          onMouseDown={(e) => { e.stopPropagation(); props.onResizeDown(e, n.id); }}
        />
      )}
      {props.lockedBy && <span className="rn-lock" style={{ ['--lc' as string]: props.lockedBy.color }} title={'Правит: ' + props.lockedBy.name} />}
    </div>
  );
}
