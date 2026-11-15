'use client';

/**
 * Ветви — слой связей (этап 2): полная геометрия оригинала — smooth/орто/мосты/петли,
 * якоря к свёрнутым группам, изгибы (вейпоинты), подписи с условиями, режимы линий.
 */

import { useMemo } from 'react';

import { edgePathD, bridgeCorners, pathPoint } from '@/vetvi/core/edgepath';
import { clamp, mainAnchor, nodeHeight, nodeWidth } from '@/vetvi/core/geometry';
import { getMe } from '@/vetvi/core/identity';
import type { EdgeGeom, NodeSize, VetviDoc, VetviEdge } from '@/vetvi/core/types';
import { condText } from '@/vetvi/core/vars';
import { collapsedAncestorOf, groupCardRect, memberFrac } from './ggroups';

export interface EdgeRender {
  e: VetviEdge;
  g: EdgeGeom;
  d: string;
  labelPt: { x: number; y: number } | null;
  cond: { vid: string; op: string; val: number | string } | null | undefined;
  pts: { x: number; y: number }[];
}

export function buildEdgeItems(
  doc: VetviDoc,
  edges: VetviEdge[],
  sizes: Map<string, NodeSize>,
  ports: Map<string, { x: number; y: number }>,
  cardSizes: Map<string, { w: number; h: number }>,
  bend: string,
): EdgeRender[] {
  const out: EdgeRender[] = [];
  for (const e of edges) {
    const na = doc.nodes.find((n) => n.id === e.from);
    const nb = doc.nodes.find((n) => n.id === e.to);
    if (!na || !nb) continue;
    const ga = collapsedAncestorOf(doc, na.id);
    const gb = collapsedAncestorOf(doc, nb.id);
    if (ga && gb && ga.id === gb.id) continue;
    const isBridge = e.kind === 'bridge';

    // FROM
    let x1: number;
    let y1: number;
    if (ga) {
      const cr = groupCardRect(doc, ga, cardSizes);
      x1 = cr.x + cr.w;
      y1 = cr.y + cr.h * memberFrac(cr.rows, na.id);
    } else if (na.type === 'dialog' && e.fromReply) {
      const p = ports.get(na.id + ':reply:' + e.fromReply);
      const m = mainAnchor(na, sizes.get(na.id));
      x1 = p ? p.x : m.x;
      y1 = p ? p.y : m.y;
    } else if (e.fromOut && (na.type === 'branch' || na.type === 'action')) {
      const p = ports.get(na.id + ':out:' + e.fromOut);
      const m = mainAnchor(na, sizes.get(na.id));
      x1 = p ? p.x : m.x;
      y1 = p ? p.y : m.y;
    } else if (na.type === 'dialog' || na.type === 'action' || na.type === 'branch') {
      const m = mainAnchor(na, sizes.get(na.id));
      x1 = m.x;
      y1 = m.y;
    } else {
      const w = nodeWidth(na, sizes.get(na.id));
      x1 = na.x + w;
      y1 = na.y + nodeHeight(na, sizes.get(na.id)) / 2;
    }

    // TO
    let x2: number;
    let y2: number;
    if (gb) {
      const cr = groupCardRect(doc, gb, cardSizes);
      x2 = cr.x;
      y2 = cr.y + cr.h * memberFrac(cr.rows, nb.id);
    } else if (e.tin === 'var') {
      const p = ports.get(nb.id + ':varin');
      x2 = p ? p.x : nb.x;
      y2 = p ? p.y : nb.y + nodeHeight(nb, sizes.get(nb.id)) / 2;
    } else {
      x2 = nb.x;
      y2 = nb.y + nodeHeight(nb, sizes.get(nb.id)) / 2;
    }

    let g: EdgeGeom;
    if (isBridge) {
      const gy0 = (ga || gb) ? (y1 + y2) / 2 : (na.y + nodeHeight(na, sizes.get(na.id)) + nb.y) / 2;
      const bd = e.bd || { dl: 0, dy: 0, dr: 0 };
      g = { x1, y1, x2, y2, corners: bridgeCorners(x1, y1, x2, y2, gy0, bd), bend: undefined };
    } else if (e.from === e.to) {
      const hS = nodeHeight(na, sizes.get(na.id));
      const bot = na.y + hS + 26;
      g = { x1, y1, x2, y2, corners: [{ x: x1 + 34, y: y1 }, { x: x1 + 34, y: bot }, { x: x2 - 34, y: bot }, { x: x2 - 34, y: y2 }], bend: undefined };
    } else {
      g = { x1, y1, x2, y2, pts: (e.pts && e.pts.length ? e.pts : null), bend };
    }

    const d = edgePathD(g);
    // полилиния для ножа/вейпоинтов
    let pts: { x: number; y: number }[] = [];
    if (g.corners && g.corners.length) pts = [{ x: g.x1, y: g.y1 }, ...g.corners, { x: g.x2, y: g.y2 }];
    else {
      const P = [{ x: g.x1, y: g.y1 }];
      (g.pts || []).forEach((p) => P.push({ x: p.x, y: p.y }));
      P.push({ x: g.x2, y: g.y2 });
      if (P.length > 2) pts = P;
      else {
        // сэмплы кубика
        const dx = g.x2 >= g.x1 ? clamp((g.x2 - g.x1) * 0.55, 46, 190) : clamp((g.x1 - g.x2) * 0.5 + 60, 70, 240);
        const c1 = { x: g.x1 + dx, y: g.y1 };
        const c2 = { x: g.x2 - dx, y: g.y2 };
        for (let i = 0; i <= 24; i++) {
          const t = i / 24;
          const m = 1 - t;
          pts.push({
            x: m * m * m * g.x1 + 3 * m * m * t * c1.x + 3 * m * t * t * c2.x + t * t * t * g.x2,
            y: m * m * m * g.y1 + 3 * m * m * t * c1.y + 3 * m * t * t * c2.y + t * t * t * g.y2,
          });
        }
      }
    }
    const lt = typeof e.lt === 'number' ? clamp(e.lt, 0.04, 0.96) : 0.5;
    const p0 = pathPoint(g, lt);
    // смещение по нормали (lp)
    const lp = typeof e.lp === 'number' ? e.lp : 0;
    const t2 = Math.min(1, lt + 0.01);
    const p1 = pathPoint(g, t2);
    const nx = -(p1.y - p0.y);
    const ny = p1.x - p0.x;
    const nl = Math.hypot(nx, ny) || 1;
    const labelPt = { x: p0.x + (nx / nl) * lp, y: p0.y + (ny / nl) * lp };
    out.push({ e, g, d, labelPt, cond: (e as unknown as { cond?: { vid: string; op: string; val: number | string } }).cond, pts });
  }
  return out;
}

export function EdgeLayer(props: {
  doc: VetviDoc;
  items: EdgeRender[];
  selected: Set<string>;
  pending: { from: string; out: string | null; reply: string | null; x: number; y: number; startX: number; startY: number } | null;
  hoverTarget: string | null;
  onEdgeDown: (e: React.MouseEvent, id: string) => void;
  onEdgeDbl: (e: React.MouseEvent, id: string) => void;
  onWpDown: (e: React.MouseEvent, id: string, i: number) => void;
  onWpDbl: (e: React.MouseEvent, id: string, i: number) => void;
  onLabelDown: (e: React.MouseEvent, id: string) => void;
  onBridgeDown: (e: React.MouseEvent, id: string, part: 'l' | 'r' | 'h') => void;
  showWps: boolean;
  /** Карта локов объектов: ключ — id связи, значение — {id: userId, name, color}. */
  locks?: Record<string, { id: string; name: string; color: string }>;
}) {
  const { doc, items, selected, pending, hoverTarget } = props;
  void doc;
  const locks = props.locks;

  const pendingD = useMemo(() => {
    if (!pending) return null;
    const sx = pending.startX;
    const sy = pending.startY;
    const dx = pending.x >= sx ? clamp((pending.x - sx) * 0.55, 46, 190) : clamp((sx - pending.x) * 0.5 + 60, 70, 240);
    return 'M' + sx + ' ' + sy + ' C ' + (sx + dx) + ' ' + sy + ', ' + (pending.x - dx) + ' ' + pending.y + ', ' + pending.x + ' ' + pending.y;
  }, [pending]);

  return (
    <svg className="rn-edges" aria-hidden="true">
      <defs>
        <marker id="rn-arw" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M10 5 L1.34 0.67 Q0 0 0 1.5 L0 8.5 Q0 10 1.34 9.33 Z" fill="#575d68" />
        </marker>
        <marker id="rn-arw-hi" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M10 5 L1.34 0.67 Q0 0 0 1.5 L0 8.5 Q0 10 1.34 9.33 Z" fill="#8f97a3" />
        </marker>
        <marker id="rn-arw-sel" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M10 5 L1.34 0.67 Q0 0 0 1.5 L0 8.5 Q0 10 1.34 9.33 Z" fill="#e2a54e" />
        </marker>
        <marker id="rn-arw-br" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
          <path d="M10 5 L1.34 0.67 Q0 0 0 1.5 L0 8.5 Q0 10 1.34 9.33 Z" fill="#79808d" />
        </marker>
      </defs>
      {items.map(({ e, g, d, labelPt, cond, pts }) => {
        const on = selected.has(e.id);
        const kind = e.kind || 'flow';
        const bridge = kind === 'bridge';
        const tvar = e.tin === 'var';
        const hover = hoverTarget === e.id;
        const lkRawE = locks ? locks[e.id] : undefined;
        const lkE = (lkRawE && lkRawE.id && lkRawE.id !== getMe().id) ? lkRawE : null;
        const marker = on ? 'rn-arw-sel' : bridge ? 'rn-arw-br' : hover ? 'rn-arw-hi' : 'rn-arw';
        return (
          <g key={e.id} data-edge-id={e.id} className={'rn-eg k-' + kind + (tvar ? ' tvar' : '') + (on ? ' sel' : '') + (hover ? ' hover' : '') + (lkE ? ' lkb' : '')} style={lkE ? { ['--lkc' as string]: lkE.color } : undefined}>
            {bridge ? (
              <>
                <path className="rn-edge-hit br" d={d} onMouseDown={(ev) => { ev.stopPropagation(); props.onEdgeDown(ev, e.id); }} onDoubleClick={(ev) => props.onEdgeDbl(ev, e.id)} />
                <path className="rn-edge bridge" d={d} markerEnd={'url(#' + marker + ')'} />
                {/* зоны перетаскивания моста */}
                <path className="rn-br-zone" d={d} onMouseDown={(ev) => {
                  ev.stopPropagation();
                  props.onBridgeDown(ev, e.id, bridgePartAt(ev, g));
                }} />
              </>
            ) : (
              <>
                <path className="rn-edge-hit" d={d} onMouseDown={(ev) => { ev.stopPropagation(); props.onEdgeDown(ev, e.id); }} onDoubleClick={(ev) => props.onEdgeDbl(ev, e.id)} />
                <path className="rn-edge" d={d} markerEnd={'url(#' + marker + ')'} />
              </>
            )}
            {labelPt && (e.label || cond) && (
              <g className="rn-elabel-g" onMouseDown={(ev) => { ev.stopPropagation(); props.onLabelDown(ev, e.id); }}>
                <text className="rn-elabel" x={labelPt.x} y={labelPt.y - 7}>{String(e.label || '')}</text>
                {cond && (
                  <text className="rn-ecnd" x={labelPt.x} y={labelPt.y + 6}>{'⟦ ' + condText(props.doc, cond) + ' ⟧'}</text>
                )}
              </g>
            )}
            {props.showWps && (e.pts || []).map((p, i) => (
              <circle
                key={i}
                className="rn-wp"
                cx={p.x}
                cy={p.y}
                r={5}
                onMouseDown={(ev) => { ev.stopPropagation(); props.onWpDown(ev, e.id, i); }}
                onDoubleClick={(ev) => { ev.stopPropagation(); props.onWpDbl(ev, e.id, i); }}
              />
            ))}
          </g>
        );
      })}
      {pendingD && <path className="rn-edge pending" d={pendingD} />}
    </svg>
  );
}

/** Какой сегмент моста схвачен: точки в координатах пользователя через getScreenCTM. */
function bridgePartAt(ev: React.MouseEvent, g: EdgeGeom): 'l' | 'r' | 'h' {
  try {
    const svg = (ev.target as SVGElement).ownerSVGElement;
    const el = ev.target as unknown as SVGGraphicsElement;
    if (svg && el.getScreenCTM && el.getScreenCTM()) {
      const pt = svg.createSVGPoint();
      pt.x = ev.clientX;
      pt.y = ev.clientY;
      const u = pt.matrixTransform(el.getScreenCTM()!.inverse());
      const dl = Math.abs(u.x - g.x1 + 0);
      const corners = g.corners || [];
      const bx2 = corners.length ? corners[0].x : g.x1;
      const bx1 = corners.length ? corners[2].x : g.x2;
      const gy = corners.length ? corners[1].y : (g.y1 + g.y2) / 2;
      const dr = Math.abs(u.x - bx1);
      const dh = Math.abs(u.y - gy);
      const dvr = Math.abs(u.x - bx2);
      const min = Math.min(dr, dh, dvr);
      if (min === dvr) return 'r';
      if (min === dh) return 'h';
      return 'l';
    }
  } catch { /* фолбэк */ }
  void dlUnused;
  return 'h';
}
const dlUnused = 0;

