/**
 * Ветви — чистая логика встраивания ноды/клона в связь (порт оригинала без DOM):
 * isBridge (строка 4000), splitPtsAtHalf (7597–7613), nearestEdgeAt (4257–4269).
 * Геометрия связи приходит готовой (EdgeGeom из buildEdgeItems) — здесь только
 * чистые вычисления, никаких обращений к документу и DOM.
 */

import type { EdgeGeom, VetviEdge } from './types';

export interface Pt { x: number; y: number }

/** Мост (isBridge оригинала, строка 4000): в мост вставлять элементы нельзя. */
export function isBridge(e: VetviEdge): boolean {
  return e.kind === 'bridge';
}

/**
 * splitPtsAtHalf оригинала (7597–7613): делит точки изгибов связи на «до половины
 * пути» и «после» (по накопленной длине полилинии) — эти две группы становятся
 * точками новой связи A→n и n→B при встраивании ноды в середину.
 */
export function splitPtsAtHalf(e: VetviEdge, g: EdgeGeom | null): [Pt[] | null, Pt[] | null] {
  const pts = e.pts;
  if (!pts || !pts.length || !g) return [null, null];
  const P: Pt[] = [{ x: g.x1, y: g.y1 }];
  for (const p of pts) P.push({ x: p.x, y: p.y });
  P.push({ x: g.x2, y: g.y2 });
  const lens: number[] = [];
  let total = 0;
  for (let i = 1; i < P.length; i++) {
    const l = Math.hypot(P[i].x - P[i - 1].x, P[i].y - P[i - 1].y);
    lens.push(l);
    total += l;
  }
  const half = total / 2;
  let acc = 0;
  const a: Pt[] = [];
  const b: Pt[] = [];
  for (let i = 1; i < P.length - 1; i++) {
    if (acc + lens[i - 1] < half) a.push({ x: P[i].x, y: P[i].y });
    else b.push({ x: P[i].x, y: P[i].y });
    acc += lens[i - 1];
  }
  return [a.length ? a : null, b.length ? b : null];
}

/**
 * nearestEdgeAt оригинала (4257–4269) по готовым полилиниям рендера (items холста):
 * ближайшая связь к мировой точке в пределах maxDistWorld; exclude — набор id концов
 * (исключение связей перетаскиваемых нод). Возвращает id связи или null.
 */
export function nearestEdgeIn(
  items: { e: { id: string; from: string; to: string }; pts: Pt[] }[],
  wx: number,
  wy: number,
  maxDistWorld: number,
  exclude: Set<string> | null,
): string | null {
  let best: string | null = null;
  let bd = maxDistWorld;
  for (const it of items) {
    if (exclude && (exclude.has(it.e.from) || exclude.has(it.e.to))) continue;
    const pts = it.pts;
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const l2 = dx * dx + dy * dy || 1;
      let t = ((wx - a.x) * dx + (wy - a.y) * dy) / l2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const d = Math.hypot(wx - (a.x + dx * t), wy - (a.y + dy * t));
      if (d < bd) { bd = d; best = it.e.id; }
    }
  }
  return best;
}
