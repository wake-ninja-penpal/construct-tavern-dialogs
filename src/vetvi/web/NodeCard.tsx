'use client';

/**
 * Ветви — карточка ноды на холсте (React-слой).
 * Визуальный язык классической версии: тёмная карточка с цветной полосой слева,
 * пины входа слева и выхода справа (у диалога/действия/развилки — внизу правой грани),
 * у развилки и действия — пин на каждом исходе.
 */

import { useLayoutEffect, useRef } from 'react';

import { MAIN_BOTTOM_TYPES, STATUS_RU } from '@/vetvi/core/constants';
import { nodeColor, typeInfo } from '@/vetvi/core/geometry';
import type { VetviNode, VetviViewport } from '@/vetvi/core/types';

export interface MeasureSink {
  setSize(id: string, w: number, h: number): void;
  setPort(key: string, p: { x: number; y: number }): void;
}

const STATUS_COLOR: Record<string, string> = {
  idea: '#d8c96f',
  draft: '#8f96a2',
  done: '#8fbf7f',
};

function TypeIcon({ type }: { type: string }) {
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
    <svg viewBox="0 0 24 24" width={13} height={13} fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
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
  dimmed?: boolean;
  store: {
    selectOnly(id: string): void;
    toggleSelect(id: string): void;
    updateNode(id: string, patch: Partial<VetviNode>, opts?: { history?: boolean }): void;
  };
  sink: MeasureSink;
  onDragStart: (e: React.MouseEvent, id: string) => void;
  onPinDown: (e: React.MouseEvent, id: string, out?: string | null) => void;
}) {
  const { node: n, vp, selected, sink, store } = props;
  const rootRef = useRef<HTMLDivElement>(null);

  // Измерение карточки и пинов после каждой отрисовки — значения в мировых координатах.
  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    sink.setSize(n.id, el.offsetWidth, el.offsetHeight);
    const rr = el.getBoundingClientRect();
    const z = vp.z || 1;
    el.querySelectorAll<HTMLElement>('[data-pin]').forEach((pin) => {
      const pr = pin.getBoundingClientRect();
      const key = n.id + ':' + String(pin.dataset.pin || '');
      sink.setPort(key, {
        x: n.x + (pr.left + pr.width / 2 - rr.left) / z,
        y: n.y + (pr.top + pr.height / 2 - rr.top) / z,
      });
    });
  });

  const color = nodeColor(n);
  const info = typeInfo(n.type);
  const status = STATUS_RU[n.status] ? n.status : 'idea';
  const collapsed = n.expand === 0;
  const text = collapsed ? '' : textOf(n);
  const mainBottom = MAIN_BOTTOM_TYPES.indexOf(n.type) >= 0;

  const replies = (!collapsed && n.type === 'dialog' && n.dialog?.replies) ? n.dialog.replies : [];
  const outcomes = (!collapsed && (n.type === 'branch') && Array.isArray(n.outcomes)) ? n.outcomes : [];
  const actions = (!collapsed && (n.type === 'action') && Array.isArray(n.actions)) ? (n.actions as { id: string; label?: string }[]) : [];

  const width = n.dlgWidth && n.dlgWidth >= 216 ? n.dlgWidth : 216;

  const cycleExpand = () => {
    const next = n.expand === 0 ? 1 : n.expand === 1 ? 2 : 0;
    store.updateNode(n.id, { expand: next });
  };

  return (
    <div
      ref={rootRef}
      data-node-id={n.id}
      className={
        'rn-node' +
        (selected ? ' sel' : '') +
        (collapsed ? ' ex-0' : n.expand === 2 ? ' ex-2' : ' ex-1') +
        (props.dimmed ? ' dim' : '')
      }
      style={{ left: n.x, top: n.y, width, ['--c' as string]: color }}
      onMouseDown={(e) => {
        if ((e.target as HTMLElement).closest('[data-pin]')) return;
        e.stopPropagation();
        if (e.shiftKey) store.toggleSelect(n.id);
        else if (!selected) store.selectOnly(n.id);
        props.onDragStart(e, n.id);
      }}
    >
      <span className="rn-bar" aria-hidden="true" />
      <div className="rn-head">
        <span className="rn-ico" style={{ color }}><TypeIcon type={n.type} /></span>
        <span className="rn-title" title={n.title}>{n.title || info.name}</span>
        <span className={'rn-st st-' + status} title={'Статус: ' + (STATUS_RU[status] || status)} />
        <button type="button" className="rn-exp" title="Свернуть/развернуть" onClick={(e) => { e.stopPropagation(); cycleExpand(); }}>
          <svg viewBox="0 0 24 24" width={11} height={11} fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            {n.expand === 0 ? <path d="m6 9 6 6 6-6" /> : <path d="m6 15 6-6 6 6" />}
          </svg>
        </button>
      </div>
      {!collapsed && (
        <div className="rn-body">
          {n.type === 'varnode' ? null : (
            text ? <div className="rn-text">{text}</div> : <div className="rn-text empty">— пусто —</div>
          )}
          {n.type === 'varnode' && (
            <div className="rn-text">{String(n.varMode === 'get' ? 'чтение' : 'запись') + ' · ' + String(n.varOp ?? '=') + ' · ' + String(n.varVal ?? 0)}</div>
          )}
          {n.type === 'dialog' && !n.dialog?.replies.length && (
            <div className="rn-text empty">реплик пока нет</div>
          )}
          {replies.length > 0 && (
            <div className="rn-replies">
              {replies.map((r) => (
                <div className="rn-reply" key={r.id} data-reply-id={r.id}>
                  <span className="rn-reply-sp">{r.speaker ? String(r.speaker) : '—'}</span>
                  <span className="rn-reply-t">{String(r.text || '')}</span>
                </div>
              ))}
            </div>
          )}
          {outcomes.length > 0 && (
            <div className="rn-outs">
              {outcomes.map((o) => (
                <div className="rn-out" key={o.id}>
                  <span className="rn-out-l">{String(o.label || '—')}</span>
                  <span
                    className="rn-opin"
                    data-pin={'out:' + o.id}
                    data-out={o.id}
                    title="Исход: потянуть связь"
                    onMouseDown={(e) => { e.stopPropagation(); props.onPinDown(e, n.id, o.id); }}
                  />
                </div>
              ))}
            </div>
          )}
          {actions.length > 0 && (
            <div className="rn-outs">
              {actions.map((a) => (
                <div className="rn-out" key={a.id}>
                  <span className="rn-out-l">{String(a.label || '—')}</span>
                  <span
                    className="rn-opin"
                    data-pin={'out:' + a.id}
                    data-out={a.id}
                    title="Действие: потянуть связь"
                    onMouseDown={(e) => { e.stopPropagation(); props.onPinDown(e, n.id, a.id); }}
                  />
                </div>
              ))}
            </div>
          )}
          {Array.isArray(n.tags) && n.tags.length > 0 && (
            <div className="rn-tags">
              {n.tags.slice(0, 4).map((t, i) => <span key={i}>{String(t)}</span>)}
            </div>
          )}
        </div>
      )}
      {/* пин входа слева */}
      <span
        className="rn-ipin"
        data-pin="in"
        title="Вход"
      />
      {/* главный пин выхода справа: у dialog/action/branch — низ правой грани */}
      <span
        className={'rn-opin main' + (mainBottom ? ' mb' : '')}
        data-pin="out"
        title="Выход: потянуть связь"
        onMouseDown={(e) => { e.stopPropagation(); props.onPinDown(e, n.id, null); }}
      />
    </div>
  );
}
