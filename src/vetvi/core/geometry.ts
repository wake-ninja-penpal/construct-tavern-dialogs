/**
 * Ветви — геометрия холста: размеры, якоря связей, пути.
 * Формулы совпадают с классической версией (edgeAnchors/edgePathD/shadeHex),
 * чтобы документы выглядели одинаково в обоих редакторах.
 */

import { MAIN_BOTTOM_TYPES, NODE_W, TYPES, ZOOM_MAX, ZOOM_MIN } from './constants';
import type { EdgeGeom, NodeSize, VetviDoc, VetviEdge, VetviNode, VetviViewport } from './types';

export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

export function clampZoom(z: number): number {
  return clamp(z, ZOOM_MIN, ZOOM_MAX);
}

export function typeInfo(type: string): { name: string; color: string } {
  return TYPES[type] || { name: 'Нода', color: '#8b929c' };
}

/** Цвет ноды с учётом своего цвета и яркости (nodePaint оригинала). */
export function nodeColor(n: VetviNode): string {
  const base = n.color || typeInfo(n.type).color;
  return shadeHex(base, clamp(Number(n.tint ?? 0), -60, 60));
}

export function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(String(hex || ''));
  if (!m) return null;
  const v = parseInt(m[1], 16);
  return { r: (v >> 16) & 255, g: (v >> 8) & 255, b: v & 255 };
}

function rgbToHex(r: number, g: number, b: number): string {
  const c = (x: number) => clamp(Math.round(x), 0, 255).toString(16).padStart(2, '0');
  return '#' + c(r) + c(g) + c(b);
}

/** shadeHex оригинала: pct>0 — светлее, pct<0 — темнее. */
export function shadeHex(hex: string, pct: number): string {
  const c = hexToRgb(hex);
  if (!c) return hex;
  if (pct >= 0) {
    c.r += (255 - c.r) * (pct / 100);
    c.g += (255 - c.g) * (pct / 100);
    c.b += (255 - c.b) * (pct / 100);
  } else {
    c.r *= 1 + pct / 100;
    c.g *= 1 + pct / 100;
    c.b *= 1 + pct / 100;
  }
  return rgbToHex(c.r, c.g, c.b);
}

/** Ширина карточки: у диалога может быть своя (dlgWidth). */
export function nodeWidth(n: VetviNode, size?: NodeSize): number {
  if (size && size.w > 0) return size.w;
  if (n.dlgWidth && n.dlgWidth >= NODE_W) return n.dlgWidth;
  return NODE_W;
}

/** Оценка высоты до первого измерения DOM (fallback как «90» в оригинале). */
export function nodeHeight(n: VetviNode, size?: NodeSize): number {
  if (size && size.h > 0) return size.h;
  return 90;
}

/** Главный якорь выхода для диалога/действия/развилки — низ правой грани (dlgMainAnchor). */
export function mainAnchor(n: VetviNode, size?: NodeSize): { x: number; y: number } {
  return { x: n.x + nodeWidth(n, size), y: n.y + nodeHeight(n, size) - 21 };
}

/**
 * Якоря связи (edgeAnchors оригинала, свободные ноды):
 * from — главный/боковой пин исхода, to — левая грань середина.
 * Пины исходов (fromOut) и реплик (fromReply) позиционируются по измеренным портам.
 */
export function edgeAnchorsFree(
  e: VetviEdge,
  na: VetviNode,
  nb: VetviNode,
  sizes: Map<string, NodeSize>,
  ports: Map<string, { x: number; y: number }>,
): { x1: number; y1: number; x2: number; y2: number } | null {
  const sa = sizes.get(na.id);
  const sb = sizes.get(nb.id);
  let x1: number;
  let y1: number;
  if (e.fromOut && MAIN_BOTTOM_TYPES.indexOf(na.type) >= 0) {
    const p = ports.get(na.id + ':out:' + e.fromOut);
    if (p) {
      x1 = p.x;
      y1 = p.y;
    } else {
      const a = mainAnchor(na, sa);
      x1 = a.x;
      y1 = a.y;
    }
  } else if (MAIN_BOTTOM_TYPES.indexOf(na.type) >= 0 && !(e.fromReply && ports.get(na.id + ':reply:' + e.fromReply))) {
    const a = mainAnchor(na, sa);
    x1 = a.x;
    y1 = a.y;
  } else if (e.fromReply) {
    const p = ports.get(na.id + ':reply:' + e.fromReply);
    if (p) {
      x1 = p.x;
      y1 = p.y;
    } else {
      const a = mainAnchor(na, sa);
      x1 = a.x;
      y1 = a.y;
    }
  } else {
    x1 = na.x + nodeWidth(na, sa);
    y1 = na.y + nodeHeight(na, sa) / 2;
  }
  let x2: number;
  let y2: number;
  if (e.tin === 'var') {
    const p = ports.get(nb.id + ':varin');
    if (p) {
      x2 = p.x;
      y2 = p.y;
    } else {
      x2 = nb.x;
      y2 = nb.y + nodeHeight(nb, sb) / 2;
    }
  } else {
    x2 = nb.x;
    y2 = nb.y + nodeHeight(nb, sb) / 2;
  }
  return { x1, y1, x2, y2 };
}

/** Геометрия связи: без мостов (этап 2) и петель — свободные ноды. */
export function edgeGeometry(
  e: VetviEdge,
  doc: VetviDoc,
  sizes: Map<string, NodeSize>,
  ports: Map<string, { x: number; y: number }>,
): EdgeGeom | null {
  const na = doc.nodes.find((n) => n.id === e.from);
  const nb = doc.nodes.find((n) => n.id === e.to);
  if (!na || !nb) return null;
  const a = edgeAnchorsFree(e, na, nb, sizes, ports);
  if (!a) return null;
  return { x1: a.x1, y1: a.y1, x2: a.x2, y2: a.y2, pts: (e.pts && e.pts.length ? e.pts : null), bend: 'smooth' };
}

/** Путь связи — формула edgePathD оригинала (smooth; орто-режимы — этап 2). */
export function edgePathD(g: EdgeGeom): string {
  const P: { x: number; y: number }[] = [{ x: g.x1, y: g.y1 }];
  if (g.pts) for (const p of g.pts) P.push({ x: p.x, y: p.y });
  P.push({ x: g.x2, y: g.y2 });
  if (P.length > 2) return catmullPath(P);
  const dx =
    g.x2 >= g.x1
      ? clamp((g.x2 - g.x1) * 0.55, 46, 190)
      : clamp((g.x1 - g.x2) * 0.5 + 60, 70, 240);
  return (
    'M' + g.x1 + ' ' + g.y1 +
    ' C ' + (g.x1 + dx) + ' ' + g.y1 + ', ' + (g.x2 - dx) + ' ' + g.y2 + ', ' + g.x2 + ' ' + g.y2
  );
}

/** Catmull-Rom → кубические безье (catmullPath оригинала) для связей с точками. */
export function catmullPath(P: { x: number; y: number }[]): string {
  if (P.length < 3) return edgePathD({ x1: P[0].x, y1: P[0].y, x2: P[P.length - 1].x, y2: P[P.length - 1].y });
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
    d += ' C ' + c1x.toFixed(1) + ' ' + c1y.toFixed(1) + ', ' + c2x.toFixed(1) + ' ' + c2y.toFixed(1) + ', ' + p2.x + ' ' + p2.y;
  }
  return d;
}

/** Точка на пути связи для выборки по t (bezP оригинала, только базовый кубик). */
export function bezPoint(g: EdgeGeom, t: number): { x: number; y: number } {
  const m = 1 - t;
  const dx =
    g.x2 >= g.x1
      ? clamp((g.x2 - g.x1) * 0.55, 46, 190)
      : clamp((g.x1 - g.x2) * 0.5 + 60, 70, 240);
  const c1x = g.x1 + dx;
  const c1y = g.y1;
  const c2x = g.x2 - dx;
  const c2y = g.y2;
  return {
    x: m * m * m * g.x1 + 3 * m * m * t * c1x + 3 * m * t * t * c2x + t * t * t * g.x2,
    y: m * m * m * g.y1 + 3 * m * m * t * c1y + 3 * m * t * t * c2y + t * t * t * g.y2,
  };
}

/** Экранные координаты → мировые. */
export function screenToWorld(vp: VetviViewport, sx: number, sy: number): { x: number; y: number } {
  return { x: (sx - vp.x) / vp.z, y: (sy - vp.y) / vp.z };
}

/** Мировые координаты → экранные. */
export function worldToScreen(vp: VetviViewport, wx: number, wy: number): { x: number; y: number } {
  return { x: wx * vp.z + vp.x, y: wy * vp.z + vp.y };
}

/** Габариты содержимого документа (для «вписать всё»). */
export function docBounds(doc: VetviDoc, sizes: Map<string, NodeSize>): { x: number; y: number; w: number; h: number } | null {
  if (!doc.nodes.length) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const n of doc.nodes) {
    const w = nodeWidth(n, sizes.get(n.id));
    const h = nodeHeight(n, sizes.get(n.id));
    if (n.x < minX) minX = n.x;
    if (n.y < minY) minY = n.y;
    if (n.x + w > maxX) maxX = n.x + w;
    if (n.y + h > maxY) maxY = n.y + h;
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}
