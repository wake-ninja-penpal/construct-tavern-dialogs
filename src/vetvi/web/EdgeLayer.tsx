'use client';

/**
 * Ветви — слой связей: SVG-пути между пинами нод.
 * Форма пути совпадает с классической версией (smooth-безье с clamp-плечом);
 * выбор связи — широкая прозрачная зона попадания.
 */

import { useMemo } from 'react';

import { edgeGeometry, edgePathD } from '@/vetvi/core/geometry';
import type { NodeSize, VetviDoc } from '@/vetvi/core/types';

export function EdgeLayer(props: {
  doc: VetviDoc;
  sizes: Map<string, NodeSize>;
  ports: Map<string, { x: number; y: number }>;
  selected: Set<string>;
  pending: { from: string; out: string | null; x: number; y: number } | null;
  rev: string;
  onSelectEdge: (id: string) => void;
}) {
  const { doc, sizes, ports, selected, pending, rev } = props;

  const items = useMemo(() => {
    return doc.edges
      .map((e) => {
        const g = edgeGeometry(e, doc, sizes, ports);
        if (!g) return null;
        return { e, d: edgePathD(g), mid: { x: (g.x1 + g.x2) / 2, y: (g.y1 + g.y2) / 2 } };
      })
      .filter(Boolean) as { e: (typeof doc.edges)[number]; d: string; mid: { x: number; y: number } }[];
  }, [doc, sizes, ports, rev]);

  const pendingPath = useMemo(() => {
    if (!pending) return null;
    const from = ports.get(pending.from + ':out') || (pending.out ? ports.get(pending.from + ':out:' + pending.out) : null);
    const start = from || ports.get(pending.from + ':out');
    if (!start) return null;
    const dx =
      pending.x >= start.x
        ? Math.min(Math.max((pending.x - start.x) * 0.55, 46), 190)
        : Math.min(Math.max((start.x - pending.x) * 0.5 + 60, 70), 240);
    return 'M' + start.x + ' ' + start.y + ' C ' + (start.x + dx) + ' ' + start.y + ', ' + (pending.x - dx) + ' ' + pending.y + ', ' + pending.x + ' ' + pending.y;
  }, [pending, ports]);

  return (
    <svg className="rn-edges" aria-hidden="true">
      <defs>
        <marker id="rn-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0 1.5 L9 5 L0 8.5 z" fill="#565d6a" />
        </marker>
        <marker id="rn-arrow-sel" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M0 1.5 L9 5 L0 8.5 z" fill="#e2a54e" />
        </marker>
      </defs>
      {items.map(({ e, d, mid }) => {
        const on = selected.has(e.id);
        return (
          <g key={e.id}>
            <path
              className="rn-edge-hit"
              d={d}
              onMouseDown={(ev) => {
                ev.stopPropagation();
                props.onSelectEdge(e.id);
              }}
            />
            <path className={'rn-edge' + (on ? ' sel' : '')} d={d} markerEnd={'url(#' + (on ? 'rn-arrow-sel' : 'rn-arrow') + ')'} />
            {e.label ? (
              <text className="rn-edge-label" x={mid.x} y={mid.y - 6}>{String(e.label)}</text>
            ) : null}
          </g>
        );
      })}
      {pendingPath && <path className="rn-edge pending" d={pendingPath} />}
    </svg>
  );
}
