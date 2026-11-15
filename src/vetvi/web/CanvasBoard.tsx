'use client';

/**
 * Ветви — холст: панорама, зум, сетка, слои (связи под карточками),
 * перетаскивание нод, создание связей пинами, выделение рамкой не входит
 * в первый этап (см. REFACTORING.md).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { clampZoom, screenToWorld } from '@/vetvi/core/geometry';
import type { NodeSize } from '@/vetvi/core/types';
import type { VetviStore } from './store';
import { NodeCard, type MeasureSink } from './NodeCard';
import { EdgeLayer } from './EdgeLayer';

export function CanvasBoard(props: { store: VetviStore }) {
  const { store } = props;
  const doc = store.doc;
  const vp = store.vp;

  const canvasRef = useRef<HTMLDivElement>(null);
  const [sizesMap] = useState(() => new Map<string, NodeSize>());
  const [portsMap] = useState(() => new Map<string, { x: number; y: number }>());
  const [tick, setTick] = useState(0);

  const dragRef = useRef<{
    mode: 'pan' | 'node' | 'link';
    startX: number;
    startY: number;
    lastX: number;
    lastY: number;
    linkFrom: string;
    linkOut: string | null;
    curX: number;
    curY: number;
    target: string | null;
  } | null>(null);
  const [pendingLink, setPendingLink] = useState<{ from: string; out: string | null; x: number; y: number } | null>(null);
  const [hoverTarget, setHoverTarget] = useState<string | null>(null);

  const sink: MeasureSink = useMemo(
    () => ({
      setSize(id: string, w: number, h: number) {
        const prev = sizesMap.get(id);
        if (!prev || prev.w !== w || prev.h !== h) {
          sizesMap.set(id, { w, h });
          setTick((t) => t + 1);
        }
      },
      setPort(key: string, p: { x: number; y: number }) {
        const prev = portsMap.get(key);
        if (!prev || prev.x !== p.x || prev.y !== p.y) {
          portsMap.set(key, p);
          setTick((t) => t + 1);
        }
      },
    }),
    [sizesMap, portsMap],
  );

  /* ── панорама и зум ── */

  const onWheel = useCallback(
    (e: React.WheelEvent) => {
      e.preventDefault();
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const factor = Math.pow(1.0015, -e.deltaY);
      store.zoomAt(x, y, factor);
    },
    [store],
  );

  const onBackgroundDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 0 && e.button !== 1) return;
      dragRef.current = {
        mode: 'pan',
        startX: e.clientX,
        startY: e.clientY,
        lastX: e.clientX,
        lastY: e.clientY,
        linkFrom: '',
        linkOut: null,
        curX: 0,
        curY: 0,
        target: null,
      };
      e.preventDefault();
    },
    [],
  );

  /* ── перетаскивание нод ── */

  const onNodeDragStart = useCallback(
    (e: React.MouseEvent, id: string) => {
      dragRef.current = {
        mode: 'node',
        startX: e.clientX,
        startY: e.clientY,
        lastX: e.clientX,
        lastY: e.clientY,
        linkFrom: '',
        linkOut: null,
        curX: 0,
        curY: 0,
        target: null,
      };
      store.dragBegin();
      e.preventDefault();
    },
    [store],
  );

  /* ── создание связи от пина ── */

  const onPinDown = useCallback(
    (e: React.MouseEvent, id: string, out: string | null) => {
      dragRef.current = {
        mode: 'link',
        startX: e.clientX,
        startY: e.clientY,
        lastX: e.clientX,
        lastY: e.clientY,
        linkFrom: id,
        linkOut: out,
        curX: 0,
        curY: 0,
        target: null,
      };
      const w = screenToWorld(store.vp, e.clientX, e.clientY);
      setPendingLink({ from: id, out, x: w.x, y: w.y });
      e.preventDefault();
    },
    [store],
  );

  /* ── глобальные обработчики жеста ── */

  useEffect(() => {
    const move = (e: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      if (d.mode === 'pan') {
        store.panBy(e.clientX - d.lastX, e.clientY - d.lastY);
        d.lastX = e.clientX;
        d.lastY = e.clientY;
      } else if (d.mode === 'node') {
        const z = store.vp.z || 1;
        store.dragMoveBy((e.clientX - d.lastX) / z, (e.clientY - d.lastY) / z);
        d.lastX = e.clientX;
        d.lastY = e.clientY;
      } else if (d.mode === 'link') {
        const w = screenToWorld(store.vp, e.clientX, e.clientY);
        d.curX = w.x;
        d.curY = w.y;
        setPendingLink({ from: d.linkFrom, out: d.linkOut, x: w.x, y: w.y });
        const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
        const node = el ? el.closest('[data-node-id]') : null;
        const target = node ? node.getAttribute('data-node-id') : null;
        d.target = target && target !== d.linkFrom ? target : null; // цель — в ref: state мог бы не успеть
        setHoverTarget(d.target);
      }
    };
    const up = () => {
      const d = dragRef.current;
      dragRef.current = null;
      if (!d) return;
      if (d.mode === 'pan') {
        store.panEnd();
      } else if (d.mode === 'node') {
        store.dragEnd();
      } else if (d.mode === 'link') {
        if (d.target) store.connectNodes(d.linkFrom, d.target, d.linkOut);
        setPendingLink(null);
        setHoverTarget(null);
      }
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
  }, [store]);

  /* ── рендер ── */

  void tick; // измерения обновляют tick, чтобы связи перерисовывались после измерения

  const fitNow = () => {
    const el = canvasRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    store.fitView(r.width, r.height, sizesMap);
  };

  const zoomStep = (f: number) => {
    const el = canvasRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    store.zoomAt(r.width / 2, r.height / 2, f);
  };

  return (
    <div
      ref={canvasRef}
      className={'rn-canvas' + (store.gridOn ? ' grid' : '')}
      style={{
        backgroundImage: store.gridOn
          ? 'radial-gradient(circle, #262b33 1px, transparent 1px)'
          : undefined,
        backgroundSize: 26 * vp.z + 'px ' + 26 * vp.z + 'px',
        backgroundPosition: vp.x + 'px ' + vp.y + 'px',
      }}
      onWheel={onWheel}
      onMouseDown={(e) => {
        const t = e.target as HTMLElement;
        if (t.closest('[data-node-id]') || t.closest('svg.rn-edges path')) return;
        if (!e.shiftKey) store.clearSelection();
        onBackgroundDown(e);
      }}
      role="application"
      aria-label="Холст проекта: панорама мышью, зум колесом"
    >
      <div
        className="rn-world"
        style={{ transform: 'translate(' + vp.x + 'px,' + vp.y + 'px) scale(' + vp.z + ')' }}
      >
        <EdgeLayer
          doc={doc}
          sizes={sizesMap}
          ports={portsMap}
          selected={store.selEdges}
          pending={pendingLink}
          rev={store.revision + ':' + tick}
          onSelectEdge={(id) => store.selectEdgeOnly(id)}
        />
        {doc.nodes.map((n) => (
          <NodeCard
            key={n.id}
            node={n}
            vp={vp}
            selected={store.sel.has(n.id)}
            dimmed={hoverTarget === n.id}
            store={store}
            sink={sink}
            onDragStart={onNodeDragStart}
            onPinDown={onPinDown}
          />
        ))}
      </div>
      <div className="rn-ctrls" role="toolbar" aria-label="Масштаб и сетка">
        <button type="button" title="Отдалить" onClick={() => zoomStep(1 / 1.2)}>−</button>
        <span className="rn-zoom">{Math.round(vp.z * 100)}%</span>
        <button type="button" title="Приблизить" onClick={() => zoomStep(1.2)}>+</button>
        <button type="button" title="Вписать всё" onClick={fitNow}>⤢</button>
        <button
          type="button"
          title="Сетка"
          className={store.gridOn ? 'on' : ''}
          onClick={() => store.toggleGrid()}
        >
          #
        </button>
        <button
          type="button"
          title="Привязка к сетке"
          className={store.snapOn ? 'on' : ''}
          onClick={() => store.toggleSnap()}
        >
          ⌗
        </button>
      </div>
    </div>
  );
}
