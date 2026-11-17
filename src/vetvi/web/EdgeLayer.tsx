'use client';

/**
 * Ветви — слой связей (этап 2): полная геометрия оригинала — smooth/орто/мосты/петли,
 * якоря к свёрнутым группам, изгибы (вейпоинты), подписи с условиями, режимы линий.
 * DOM 1:1 с оригиналом: svg#edges + defs (6 маркеров arw*) + g.edge (hit/line/ep-h/wp/elabel*).
 *
 * Оптимизация: buildEdgeItems ищет ноды по Map (не find по массиву на каждую связь) и
 * переиспользует объекты EdgeRender с неизменной геометрией — memo-строки EdgeItem
 * перерисовываются только у реально сдвинувшихся связей (перетаскивание ноды/пан/зум
 * не перекатывают все стрелки заново).
 */

import { memo, useMemo } from 'react';

import { catmullSamples, edgePathD, bridgeCorners, pathPoint, routeOrtho, routeOrtho45 } from '@/vetvi/core/edgepath';
import { clamp, mainAnchor, nodeHeight, nodeWidth } from '@/vetvi/core/geometry';
import { getMe } from '@/vetvi/core/identity';
import type { EdgeGeom, NodeSize, VetviDoc, VetviEdge, VetviNode } from '@/vetvi/core/types';
import { condText, condWithOverride } from '@/vetvi/core/vars';
import { collapsedAncestorOf, groupCardRect, memberFrac } from './ggroups';

export interface EdgeRender {
  e: VetviEdge;
  g: EdgeGeom;
  d: string;
  labelPt: { x: number; y: number } | null;
  cond: { vid: string; op: string; val: number | string } | null | undefined;
  pts: { x: number; y: number }[];
}

/* кэш готовых EdgeRender по объекту связи: переиспользуется, пока геометрия та же */
const edgeRenderCache = new WeakMap<VetviEdge, EdgeRender>();

export function buildEdgeItems(
  doc: VetviDoc,
  edges: VetviEdge[],
  sizes: Map<string, NodeSize>,
  ports: Map<string, { x: number; y: number }>,
  cardSizes: Map<string, { w: number; h: number }>,
  bend: string,
): EdgeRender[] {
  /* O(1)-поиск нод: раньше doc.nodes.find на связь дважды — O(связи × ноды) */
  const nodeMap = new Map<string, VetviNode>();
  for (const n of doc.nodes) nodeMap.set(n.id, n);
  const collapsedCache = new Map<string, ReturnType<typeof collapsedAncestorOf>>();
  const collapsedOf = (id: string) => {
    let c = collapsedCache.get(id);
    if (c === undefined) { c = collapsedAncestorOf(doc, id); collapsedCache.set(id, c); }
    return c;
  };

  const out: EdgeRender[] = [];
  for (const e of edges) {
    const na = nodeMap.get(e.from);
    const nb = nodeMap.get(e.to);
    if (!na || !nb) continue;
    const ga = collapsedOf(na.id);
    const gb = collapsedOf(nb.id);
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
      /* свёрнутая нода: исходы реплик сходятся в .dlg-collapse-pin
         (edgeGeom оригинала 3895–3903: ex===0 → dlgCollapsePortPos) */
      const exA = (na.expand === 0 || na.expand === 1 || na.expand === 2) ? na.expand : 1;
      const p = exA === 0
        ? ports.get(na.id + ':collapse') || null
        : ports.get(na.id + ':reply:' + e.fromReply) || null;
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
    // полилиния для ножа/вейпоинтов/поиска связи — ВИДИМАЯ кривая, не хорды:
    // клик ножа по дуге изгиба обязан попадать (оригинал сэмплировал edgeSample)
    let pts: { x: number; y: number }[] = [];
    if (g.corners && g.corners.length) pts = [{ x: g.x1, y: g.y1 }, ...g.corners, { x: g.x2, y: g.y2 }];
    else {
      const P = [{ x: g.x1, y: g.y1 }];
      (g.pts || []).forEach((p) => P.push({ x: p.x, y: p.y }));
      P.push({ x: g.x2, y: g.y2 });
      if (P.length > 2) {
        const bend = g.bend || 'smooth';
        if (bend === 'ortho90') pts = routeOrtho(P);
        else if (bend === 'ortho45') pts = routeOrtho45(P);
        else pts = catmullSamples(P, 12);
      } else {
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
    const cond = (e as unknown as { cond?: { vid: string; op: string; val: number | string } }).cond;

    /* переиспользование кэша: та же связь, та же геометрия и подпись → тот же объект.
       Мemo-строка EdgeItem не перерисовывается. pts всегда свежие (нож/вейпоинты). */
    const prev = edgeRenderCache.get(e);
    if (
      prev && prev.e === e
      && prev.d === d
      && prev.g.x1 === x1 && prev.g.y1 === y1 && prev.g.x2 === x2 && prev.g.y2 === y2
      && prev.labelPt && prev.labelPt.x === labelPt.x && prev.labelPt.y === labelPt.y
      && prev.cond === cond
    ) {
      prev.pts = pts;
      out.push(prev);
      continue;
    }
    const item: EdgeRender = { e, g, d, labelPt, cond, pts };
    edgeRenderCache.set(e, item);
    out.push(item);
  }
  return out;
}

/* ── одна связь: memo по (item, sel, тексты, лок) — перерисовка только изменённых ── */
type EdgeItemProps = {
  it: EdgeRender;
  sel: boolean;
  labelText: string;
  ct: string;
  showFrom: boolean;
  showTo: boolean;
  showWps: boolean;
  lockKey: string;
  lockColor: string | undefined;
  onEdgeDown: (e: React.MouseEvent, id: string) => void;
  onBridgeDown: (e: React.MouseEvent, id: string, part: 'l' | 'r' | 'h') => void;
  onEdgeDbl: (e: React.MouseEvent, id: string) => void;
  onWpDown: (e: React.MouseEvent, id: string, i: number) => void;
  onWpDbl: (e: React.MouseEvent, id: string, i: number) => void;
  onLabelDown: (e: React.MouseEvent, id: string) => void;
};

const EdgeItem = memo(function EdgeItem(props: EdgeItemProps) {
  const { it, sel, labelText, ct, showFrom, showTo, showWps, lockKey, lockColor } = props;
  const e = it.e;
  const g = it.g;
  const bridge = (e.kind || 'flow') === 'bridge';
  const tvar = e.tin === 'var';
  return (
    <g key={e.id} data-id={e.id} className={'edge kind-' + (e.kind || 'flow') + (bridge ? ' bridge' : '') + (tvar ? ' tvar' : '') + (sel ? ' sel' : '') + (lockKey ? ' lkb' : '')} style={lockKey ? { ['--lkc' as string]: lockColor } : undefined}>
      <path
        className="hit"
        d={it.d}
        onMouseDown={bridge
          ? (ev: React.MouseEvent) => { if (ev.altKey && ev.button === 0) return; ev.stopPropagation(); props.onBridgeDown(ev, e.id, bridgePartAt(ev, g)); }
          : (ev: React.MouseEvent) => { if (ev.altKey && ev.button === 0) return; ev.stopPropagation(); props.onEdgeDown(ev, e.id); }}
        onDoubleClick={(ev) => props.onEdgeDbl(ev, e.id)}
      />
      <path className="line" d={it.d} markerEnd="url(#arw)" />
      <circle className="ep-h" r={6} data-ep="from" cx={g.x1} cy={g.y1} style={showFrom ? undefined : { display: 'none' }} />
      <circle className="ep-h" r={6} data-ep="to" cx={g.x2} cy={g.y2} style={showTo ? undefined : { display: 'none' }} />
      {showWps && !bridge && (e.pts || []).map((p, i) => (
        <circle
          key={i}
          className="wp"
          data-i={i}
          cx={Math.round(p.x)}
          cy={Math.round(p.y)}
          r={5}
          onMouseDown={(ev) => { if (ev.altKey && ev.button === 0) return; ev.stopPropagation(); props.onWpDown(ev, e.id, i); }}
          onDoubleClick={(ev) => { ev.stopPropagation(); props.onWpDbl(ev, e.id, i); }}
        />
      ))}
      {it.labelPt && (
        <g onMouseDown={(ev) => { if (ev.altKey && ev.button === 0) return; ev.stopPropagation(); props.onLabelDown(ev, e.id); }}>
          <text className="elabel-hit" x={it.labelPt.x} y={it.labelPt.y - 6} style={labelText ? undefined : { display: 'none' }}>{labelText}</text>
          <text className="elabel" x={it.labelPt.x} y={it.labelPt.y - 6} style={labelText ? undefined : { display: 'none' }}>{labelText}</text>
          <text className="ecnd" x={it.labelPt.x} y={e.label ? it.labelPt.y + 13 : it.labelPt.y - 6} style={ct ? undefined : { display: 'none' }}>{ct}</text>
        </g>
      )}
    </g>
  );
}, (a, b) =>
  a.it === b.it
  && a.sel === b.sel
  && a.labelText === b.labelText
  && a.ct === b.ct
  && a.showFrom === b.showFrom
  && a.showTo === b.showTo
  && a.showWps === b.showWps
  && a.lockKey === b.lockKey
  && a.lockColor === b.lockColor
  && a.onEdgeDown === b.onEdgeDown
  && a.onBridgeDown === b.onBridgeDown
  && a.onEdgeDbl === b.onEdgeDbl
  && a.onWpDown === b.onWpDown
  && a.onWpDbl === b.onWpDbl
  && a.onLabelDown === b.onLabelDown
);

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
  /** Линия «ножа» (Alt) в мировых координатах — рисуется как path.cutline внутри #edges (как в оригинале). */
  cutline?: { x1: number; y1: number; x2: number; y2: number } | null;
}) {
  const { doc, items, selected, pending, hoverTarget } = props;
  void hoverTarget;
  const locks = props.locks;

  const pendingD = useMemo(() => {
    if (!pending) return null;
    const sx = pending.startX;
    const sy = pending.startY;
    // превью оригинала: фиксированные выносы ±80
    return 'M' + sx + ' ' + sy + ' C ' + (sx + 80) + ' ' + sy + ', ' + (pending.x - 80) + ' ' + pending.y + ', ' + pending.x + ' ' + pending.y;
  }, [pending]);

  /* обычный Map на время рендера (не useMemo — мутабельные хук-значения под
     запретом react-hooks/immutability): кэш collapsedAncestorOf в рамках прохода */
  const collapsedCache = new Map<string, boolean>();
  const collapsedOf = (id: string): boolean => {
    let c = collapsedCache.get(id);
    if (c === undefined) { c = !!collapsedAncestorOf(doc, id); collapsedCache.set(id, c); }
    return c;
  };
  /* карта нод для «текст условия — только от развилки» (раньше find на связь) */
  const nodeMap = useMemo(() => {
    const m = new Map<string, VetviNode>();
    for (const n of doc.nodes) m.set(n.id, n);
    return m;
  }, [doc, items]);
  const meId = getMe().id;

  return (
    <svg id="edges" width={10} height={10} style={{ position: 'absolute', left: 0, top: 0, overflow: 'visible' }} className="rn-edges">
      <defs>
        <marker id="arw" viewBox="0 0 10 10" refX="8.6" refY="5" markerWidth="7.5" markerHeight="7.5" orient="auto"><path d="M10 5 L1.34 0.67 Q0 0 0 1.5 L0 8.5 Q0 10 1.34 9.33 Z" fill="#5d636d" /></marker>
        <marker id="arwHi" viewBox="0 0 10 10" refX="8.6" refY="5" markerWidth="7.5" markerHeight="7.5" orient="auto"><path d="M10 5 L1.34 0.67 Q0 0 0 1.5 L0 8.5 Q0 10 1.34 9.33 Z" fill="#9aa1ac" /></marker>
        <marker id="arwSel" viewBox="0 0 10 10" refX="8.6" refY="5" markerWidth="7.5" markerHeight="7.5" orient="auto"><path d="M10 5 L1.34 0.67 Q0 0 0 1.5 L0 8.5 Q0 10 1.34 9.33 Z" fill="#e2a54e" /></marker>
        <marker id="arwBridge" viewBox="0 0 10 10" refX="8.6" refY="5" markerWidth="5" markerHeight="5" orient="auto"><path d="M10 5 L1.34 0.67 Q0 0 0 1.5 L0 8.5 Q0 10 1.34 9.33 Z" fill="#79808d" /></marker>
        <marker id="arwBridgeHi" viewBox="0 0 10 10" refX="8.6" refY="5" markerWidth="5" markerHeight="5" orient="auto"><path d="M10 5 L1.34 0.67 Q0 0 0 1.5 L0 8.5 Q0 10 1.34 9.33 Z" fill="#a6adb8" /></marker>
        <marker id="arwBridgeSel" viewBox="0 0 10 10" refX="8.6" refY="5" markerWidth="5" markerHeight="5" orient="auto"><path d="M10 5 L1.34 0.67 Q0 0 0 1.5 L0 8.5 Q0 10 1.34 9.33 Z" fill="#e2a54e" /></marker>
      </defs>
      {items.map((it) => {
        const e = it.e;
        const cond = it.cond;
        const on = selected.has(e.id);
        const fnA = nodeMap.get(e.from);
        const ct = (cond && fnA && fnA.type === 'branch') ? '⟦ ' + condText(doc, condWithOverride(doc, cond, fnA)) + ' ⟧' : '';
        const labelText = String(e.label || '');
        const lkRawE = locks ? locks[e.id] : undefined;
        const lkE = (lkRawE && lkRawE.id && lkRawE.id !== meId) ? lkRawE : null;
        // ручки концов скрываем, если нода внутри свёрнутой группы (endCollapsed оригинала)
        const showFrom = !collapsedOf(e.from);
        const showTo = !collapsedOf(e.to);
        return (
          <EdgeItem
            key={e.id}
            it={it}
            sel={on}
            labelText={labelText}
            ct={ct}
            showFrom={showFrom}
            showTo={showTo}
            showWps={props.showWps}
            lockKey={lkE ? lkE.id : ''}
            lockColor={lkE ? lkE.color : undefined}
            onEdgeDown={props.onEdgeDown}
            onBridgeDown={props.onBridgeDown}
            onEdgeDbl={props.onEdgeDbl}
            onWpDown={props.onWpDown}
            onWpDbl={props.onWpDbl}
            onLabelDown={props.onLabelDown}
          />
        );
      })}
      {pendingD && <path className="preview" d={pendingD} />}
      {props.cutline && <path className="cutline" d={'M' + props.cutline.x1 + ' ' + props.cutline.y1 + ' L' + props.cutline.x2 + ' ' + props.cutline.y2} />}
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
  return 'h';
}
