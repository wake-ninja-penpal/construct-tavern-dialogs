/**
 * Ветви — полная геометрия путей связей (порт edgeGeom/edgePathD оригинала, строки 3953–4140):
 * smooth-безье, орто-режимы (90/45), мосты, петли, позиция подписи, отрезки для «ножа».
 */

import { clamp } from './geometry';
import type { EdgeGeom } from './types';

export interface Pt { x: number; y: number }

/** routeOrtho оригинала: ломаная 90°. */
export function routeOrtho(P: Pt[]): Pt[] {
  const R = [P[0]];
  const last = P.length - 1;
  for (let i = 1; i < P.length; i++) {
    const a = R[R.length - 1];
    const b = P[i];
    if (i === last) {
      if (Math.abs(b.y - a.y) < 1) { R.push(b); continue; }
      const e = { x: b.x - 26, y: b.y };
      if (Math.abs(e.x - a.x) >= 1) R.push({ x: e.x, y: a.y });
      R.push(e);
      R.push(b);
      continue;
    }
    if (Math.abs(b.x - a.x) < 1 || Math.abs(b.y - a.y) < 1) { R.push(b); continue; }
    R.push({ x: b.x, y: a.y });
    R.push(b);
  }
  return R;
}

/** routeOrtho45 оригинала: диагонали 45°. */
export function routeOrtho45(P: Pt[]): Pt[] {
  const R = [P[0]];
  const last = P.length - 1;
  for (let i = 1; i < P.length; i++) {
    let a = R[R.length - 1];
    const b = P[i];
    const isFirst = i === 1;
    const isLast = i === last;
    let dx = b.x - a.x;
    let dy = b.y - a.y;
    if (isFirst && isLast) {
      const stub = Math.min(26, Math.max(10, Math.abs(dx) * 0.5));
      const s1 = { x: a.x + (dx >= 0 ? stub : -stub), y: a.y };
      const e = { x: b.x - 26, y: b.y };
      R.push(s1);
      const dx2 = e.x - s1.x;
      const dy2 = e.y - s1.y;
      if (Math.abs(dy2) < 1) R.push(e);
      else if (Math.abs(dx2) >= Math.abs(dy2)) { R.push({ x: s1.x + (dx2 >= 0 ? 1 : -1) * Math.abs(dy2), y: e.y }); R.push(e); }
      else { R.push({ x: e.x, y: s1.y + (dy2 >= 0 ? 1 : -1) * Math.abs(dx2) }); R.push(e); }
      R.push(b);
      continue;
    }
    if (isFirst) {
      const stubF = Math.min(26, Math.max(10, Math.abs(dx) * 0.5));
      const s1f = { x: a.x + (dx >= 0 ? stubF : -stubF), y: a.y };
      R.push(s1f);
      a = s1f;
      dx = b.x - a.x;
      dy = b.y - a.y;
    }
    if (isLast) {
      if (Math.abs(dy) < 1) { R.push(b); continue; }
      const eL = { x: b.x - 26, y: b.y };
      const exL = eL.x - a.x;
      const eyL = eL.y - a.y;
      if (exL === 0 || eyL === 0) R.push(eL);
      else {
        const aex = Math.abs(exL);
        const aey = Math.abs(eyL);
        const sxe = exL > 0 ? 1 : -1;
        const sye = eyL > 0 ? 1 : -1;
        if (aex >= aey) R.push({ x: a.x + sxe * (aex - aey), y: a.y });
        else R.push({ x: a.x, y: a.y + sye * (aey - aex) });
        R.push(eL);
      }
      R.push(b);
      continue;
    }
    if (dx === 0 || dy === 0) { R.push(b); continue; }
    const adx = Math.abs(dx);
    const ady = Math.abs(dy);
    const sx = dx > 0 ? 1 : -1;
    const sy = dy > 0 ? 1 : -1;
    if (adx >= ady) R.push({ x: a.x + sx * (adx - ady), y: a.y });
    else R.push({ x: a.x, y: a.y + sy * (ady - adx) });
    R.push(b);
  }
  return R;
}

/** filletPath оригинала: скругление углов r=12. */
export function filletPath(R: Pt[], r = 12): string {
  if (R.length < 2) return '';
  if (R.length < 3) return 'M' + R[0].x + ' ' + R[0].y + (R[1] ? ' L' + R[1].x + ' ' + R[1].y : '');
  let d = 'M' + R[0].x + ' ' + R[0].y;
  for (let i = 1; i < R.length - 1; i++) {
    const p0 = R[i - 1];
    const p1 = R[i];
    const p2 = R[i + 1];
    const v1x = p1.x - p0.x;
    const v1y = p1.y - p0.y;
    const l1 = Math.hypot(v1x, v1y) || 1;
    const v2x = p2.x - p1.x;
    const v2y = p2.y - p1.y;
    const l2 = Math.hypot(v2x, v2y) || 1;
    const rr = Math.min(r, l1 / 2, l2 / 2);
    if (rr < 1) { d += ' L' + p1.x + ' ' + p1.y; continue; }
    const ax = p1.x - (v1x / l1) * rr;
    const ay = p1.y - (v1y / l1) * rr;
    const bx = p1.x + (v2x / l2) * rr;
    const by = p1.y + (v2y / l2) * rr;
    d += ' L' + ax + ' ' + ay + ' Q' + p1.x + ' ' + p1.y + ' ' + bx + ' ' + by;
  }
  d += ' L' + R[R.length - 1].x + ' ' + R[R.length - 1].y;
  return d;
}

/** orthoPath для corners (мосты/петли). */
export function orthoPath(a: EdgeGeom): string {
  const P: Pt[] = [{ x: a.x1, y: a.y1 }];
  (a.corners || []).forEach((q) => P.push(q));
  P.push({ x: a.x2, y: a.y2 });
  return filletPath(P, 12);
}

/** Геометрия моста (bridgeGeom) → 4 угла. */
export function bridgeCorners(x1: number, y1: number, x2: number, y2: number, gy0: number, bd: { dl: number; dy: number; dr: number }): Pt[] {
  const bx1 = x2 - 56 + bd.dl;
  const bx2 = x1 + 30 + bd.dr;
  const gy = gy0 + bd.dy;
  return [
    { x: bx2, y: y1 },
    { x: bx2, y: gy },
    { x: bx1, y: gy },
    { x: bx1, y: y2 },
  ];
}

/** catmullPath для точек изгибов (совпадает с оригиналом). */
export function catmullPath(P: Pt[]): string {
  if (P.length < 3) return 'M' + P[0].x + ' ' + P[0].y + (P[1] ? ' L' + P[1].x + ' ' + P[1].y : '');
  let d = 'M' + P[0].x + ' ' + P[0].y;
  for (let i = 0; i < P.length - 1; i++) {
    const p0 = P[i - 1] || P[i];
    const p1 = P[i];
    const p2 = P[i + 1];
    const p3 = P[i + 2] || p2;
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = p2.y - (p3.y - p1.y) / 6;
    d += ' C' + c1x.toFixed(1) + ' ' + c1y.toFixed(1) + ', ' + c2x.toFixed(1) + ' ' + c2y.toFixed(1) + ', ' + p2.x + ' ' + p2.y;
  }
  return d;
}

function samplePolyline(P: Pt[], t: number): Pt {
  const lens: number[] = [];
  let total = 0;
  for (let i = 1; i < P.length; i++) {
    const l = Math.hypot(P[i].x - P[i - 1].x, P[i].y - P[i - 1].y);
    lens.push(l);
    total += l;
  }
  if (total < 0.001) return { x: P[0].x, y: P[0].y };
  const target = t * total;
  let acc = 0;
  for (let i = 0; i < lens.length; i++) {
    if (acc + lens[i] >= target) {
      const k = lens[i] ? (target - acc) / lens[i] : 0;
      return { x: P[i].x + (P[i + 1].x - P[i].x) * k, y: P[i].y + (P[i + 1].y - P[i].y) * k };
    }
    acc += lens[i];
  }
  return { x: P[P.length - 1].x, y: P[P.length - 1].y };
}

/** Точка на итоговом пути по параметру t (catmullSample) — позиция подписи. */
export function pathPoint(g: EdgeGeom, t: number): Pt {
  if (g.corners && g.corners.length) {
    const P: Pt[] = [{ x: g.x1, y: g.y1 }].concat(g.corners, [{ x: g.x2, y: g.y2 }]);
    return samplePolyline(P, clamp(t, 0, 1));
  }
  const P: Pt[] = [{ x: g.x1, y: g.y1 }];
  (g.pts || []).forEach((p) => P.push({ x: p.x, y: p.y }));
  P.push({ x: g.x2, y: g.y2 });
  if (P.length > 2) {
    const pts: Pt[] = [];
    const per = 8;
    for (let i = 0; i < P.length - 1; i++) {
      const p0 = P[i - 1] || P[i];
      const p1 = P[i];
      const p2 = P[i + 1];
      const p3 = P[i + 2] || p2;
      const c1x = p1.x + (p2.x - p0.x) / 6;
      const c1y = p1.y + (p2.y - p0.y) / 6;
      const c2x = p2.x - (p3.x - p1.x) / 6;
      const c2y = p2.y - (p3.y - p1.y) / 6;
      for (let j = 0; j < per; j++) {
        const u = j / per;
        const m = 1 - u;
        pts.push({
          x: m * m * m * p1.x + 3 * m * m * u * c1x + 3 * m * u * u * c2x + u * u * u * p2.x,
          y: m * m * m * p1.y + 3 * m * m * u * c1y + 3 * m * u * u * c2y + u * u * u * p2.y,
        });
      }
    }
    pts.push(P[P.length - 1]);
    return samplePolyline(pts, t);
  }
  const dx = g.x2 >= g.x1 ? clamp((g.x2 - g.x1) * 0.55, 46, 190) : clamp((g.x1 - g.x2) * 0.5 + 60, 70, 240);
  const c1x = g.x1 + dx;
  const c1y = g.y1;
  const c2x = g.x2 - dx;
  const c2y = g.y2;
  const m = 1 - t;
  return {
    x: m * m * m * g.x1 + 3 * m * m * t * c1x + 3 * m * t * t * c2x + t * t * t * g.x2,
    y: m * m * m * g.y1 + 3 * m * m * t * c1y + 3 * m * t * t * c2y + t * t * t * g.y2,
  };
}

/** Полный d-путь связи (edgePathD оригинала). */
export function edgePathD(g: EdgeGeom): string {
  if (g.corners && g.corners.length) return orthoPath(g);
  const P: Pt[] = [{ x: g.x1, y: g.y1 }];
  (g.pts || []).forEach((p) => P.push({ x: p.x, y: p.y }));
  P.push({ x: g.x2, y: g.y2 });
  const mode = g.bend || 'smooth';
  if (mode === 'ortho90') return filletPath(routeOrtho(P), 12);
  if (mode === 'ortho45') return filletPath(routeOrtho45(P), 12);
  if (P.length > 2) return catmullPath(P);
  const dx = g.x2 >= g.x1 ? clamp((g.x2 - g.x1) * 0.55, 46, 190) : clamp((g.x1 - g.x2) * 0.5 + 60, 70, 240);
  return 'M' + g.x1 + ' ' + g.y1 + ' C ' + (g.x1 + dx) + ' ' + g.y1 + ', ' + (g.x2 - dx) + ' ' + g.y2 + ', ' + g.x2 + ' ' + g.y2;
}

/** Пересечение отрезков — для «ножа». */
export function segIntersect(a1: Pt, a2: Pt, b1: Pt, b2: Pt): boolean {
  const d1x = a2.x - a1.x;
  const d1y = a2.y - a1.y;
  const d2x = b2.x - b1.x;
  const d2y = b2.y - b1.y;
  const denom = d1x * d2y - d1y * d2x;
  if (Math.abs(denom) < 1e-9) return false;
  const t = ((b1.x - a1.x) * d2y - (b1.y - a1.y) * d2x) / denom;
  const u = ((b1.x - a1.x) * d1y - (b1.y - a1.y) * d1x) / denom;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1;
}

/** Точка на кривой по клику — выбор сегмента для вейпоинта: возвращает индекс сегмента и точку. */
export function nearestSegPoint(P: Pt[], x: number, y: number): { seg: number; pt: Pt } {
  let best = { seg: 0, dist: Infinity, pt: P[0] };
  for (let i = 0; i < P.length - 1; i++) {
    const a = P[i];
    const b = P[i + 1];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const l2 = dx * dx + dy * dy || 1;
    let t = ((x - a.x) * dx + (y - a.y) * dy) / l2;
    t = clamp(t, 0, 1);
    const px = a.x + dx * t;
    const py = a.y + dy * t;
    const d = Math.hypot(px - x, py - y);
    if (d < best.dist) best = { seg: i, dist: d, pt: { x: px, y: py } };
  }
  return { seg: best.seg, pt: best.pt };
}
