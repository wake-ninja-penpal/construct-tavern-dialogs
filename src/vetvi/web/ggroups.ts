/**
 * Ветви — геометрия групп: цепочки вложенности, свёрнутые предки, карточки групп.
 * Аналог collapsedAncestorOf/membersOf/groupRectWorld оригинала (строки 2913–3146).
 */

import { GCARD_W, GRID } from '@/vetvi/core/constants';
import { nodeHeight, nodeWidth } from '@/vetvi/core/geometry';
import type { VetviDoc, VetviGroup, VetviNode } from '@/vetvi/core/types';

export const GROUP_ROW_H = 26;
export const GROUP_HEAD_H = 30;

export function groupById(doc: VetviDoc, id: string | null | undefined): VetviGroup | undefined {
  if (!id) return undefined;
  return doc.groups.find((g) => g.id === id);
}

/** Ближайшая группа-предок, которая не показана как рамка (fold<2). */
export function collapsedAncestorOf(doc: VetviDoc, nid: string): VetviGroup | null {
  let gid = doc.nodes.find((n) => n.id === nid)?.gid || null;
  const seen = new Set<string>();
  while (gid && !seen.has(gid)) {
    seen.add(gid);
    const g = groupById(doc, gid);
    if (!g) return null;
    if (g.fold !== undefined && g.fold < 2 && !g.stack) return g;
    if (g.fold !== undefined && g.fold < 2 && g.stack) return g;
    gid = g.parent || null;
  }
  return null;
}

/** Все ноды группы и её подгрупп. */
export function allDescNodes(doc: VetviDoc, gid: string): VetviNode[] {
  const out: VetviNode[] = [];
  const walk = (id: string) => {
    for (const n of doc.nodes) if (n.gid === id) out.push(n);
    for (const g of doc.groups) if (g.parent === id) walk(g.id);
  };
  walk(gid);
  return out;
}

/** Прямые члены + прямые подгруппы (для карточек fold=1). */
export function groupRows(doc: VetviDoc, gid: string): { nodes: VetviNode[]; subgroups: VetviGroup[] } {
  return {
    nodes: doc.nodes.filter((n) => n.gid === gid),
    subgroups: doc.groups.filter((g) => (g.parent || null) === gid),
  };
}

export function groupDepth(doc: VetviDoc, gid: string | null): number {
  let d = 0;
  let cur = gid;
  const seen = new Set<string>();
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const g = groupById(doc, cur);
    if (!g) break;
    d++;
    cur = g.parent || null;
  }
  return d;
}

export interface GroupCardGeom { x: number; y: number; w: number; h: number; rows: VetviNode[]; subs: VetviGroup[] }

/** Прямоугольник карточки группы fold=1/0 (или цепочки — qcard). */
export function groupCardRect(doc: VetviDoc, g: VetviGroup, cardSizes: Map<string, { w: number; h: number }>): GroupCardGeom {
  const rows = doc.nodes.filter((n) => n.gid === g.id);
  const subs = doc.groups.filter((s) => (s.parent || null) === g.id && s.stack !== true);
  const stack = g.stack === true;
  const w = stack ? 300 : GCARD_W;
  const subCount = stack ? 0 : subs.length;
  const measured = cardSizes.get(g.id);
  const h = measured ? measured.h : GROUP_HEAD_H + (rows.length + subCount) * GROUP_ROW_H + (stack ? 0 : 8);
  return { x: g.x, y: g.y, w, h, rows, subs };
}

/** Прямоугольник рамки группы fold=2 — по членам (или ручная рамка fw/fh). */
export function groupFrameRect(doc: VetviDoc, g: VetviGroup, sizes: Map<string, { w: number; h: number }>, cardSizes: Map<string, { w: number; h: number }>): { x: number; y: number; w: number; h: number } {
  if (typeof g.fw === 'number' && typeof g.fh === 'number' && g.fw > 0 && g.fh > 0 && !g.auto) {
    return { x: g.x, y: g.y, w: g.fw, h: g.fh };
  }
  const ms = allDescNodes(doc, g.id);
  const subCards = doc.groups.filter((s) => (s.parent || null) === g.id);
  if (!ms.length && !subCards.length) return { x: g.x, y: g.y, w: 220, h: 150 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const n of ms) {
    const w = nodeWidth(n, sizes.get(n.id));
    const h = nodeHeight(n, sizes.get(n.id));
    minX = Math.min(minX, n.x);
    minY = Math.min(minY, n.y);
    maxX = Math.max(maxX, n.x + w);
    maxY = Math.max(maxY, n.y + h);
  }
  for (const s of subCards) {
    if (s.fold === 2) continue;
    const cr = groupCardRect(doc, s, cardSizes);
    minX = Math.min(minX, cr.x);
    minY = Math.min(minY, cr.y);
    maxX = Math.max(maxX, cr.x + cr.w);
    maxY = Math.max(maxY, cr.y + cr.h);
  }
  return { x: minX - 26, y: minY - 44, w: maxX - minX + 52, h: maxY - minY + 66 };
}

/** Доля члена в карточке (для якорей связей). */
export function memberFrac(rows: VetviNode[], nid: string): number {
  const i = rows.findIndex((n) => n.id === nid);
  if (i < 0 || rows.length < 2) return 0.5;
  return i / (rows.length - 1);
}

export function snapG(v: number, on: boolean): number {
  return on ? Math.round(v / GRID) * GRID : Math.round(v);
}
