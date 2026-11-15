/**
 * Ветви — фабрики объектов документа. Дефолты совпадают с addNode/addEdge
 * классической версии, чтобы созданные React-редактором ноды безболезненно
 * открывались в /vetvi/index.html и наоборот.
 */

import { GRID, TYPES } from './constants';
import type { VetviDoc, VetviEdge, VetviNode, VetviOutcome, VetviReply, VetviViewport } from './types';

/** Короткий уникальный id (двойной вызов — как uid() оригинала). */
export function uid(): string {
  return Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);
}

/** Привязка к сетке (если включена). */
export function snapVal(v: number, snap: boolean): number {
  return snap ? Math.round(v / GRID) * GRID : Math.round(v);
}

/** Диалоговая структура ноды «Диалог» (ensureDialog оригинала). */
export function ensureDialog(n: VetviNode): void {
  if (n.type !== 'dialog') return;
  if (!n.dialog || typeof n.dialog !== 'object') n.dialog = { participants: [], description: '', replies: [] };
  if (!Array.isArray(n.dialog.participants)) n.dialog.participants = [];
  if (!Array.isArray(n.dialog.replies)) n.dialog.replies = [];
  if (typeof n.dialog.description !== 'string') n.dialog.description = '';
}

/** Новая нода с дефолтами addNode() классической версии. */
export function newNode(typeKey: string, x: number, y: number): VetviNode {
  const info = TYPES[typeKey] || { name: 'Нода', color: '#8b929c' };
  const n: VetviNode = {
    id: uid(),
    type: typeKey,
    gid: null,
    x: Math.round(x),
    y: Math.round(y),
    title: info.name,
    text: '',
    status: 'idea',
    tags: [],
    expand: 1,
    color: null,
    tint: -60,
    dlgWidth: null,
  };
  ensureDialog(n);
  if (typeKey === 'varnode') {
    n.varMode = 'set';
    n.varOp = '=';
    n.varVal = 0;
    n.vid = null;
  }
  if (typeKey === 'branch') n.outcomes = [];
  if (typeKey === 'action') n.actions = [];
  return n;
}

/** Новая связь (как в cloneNode/создании связей оригинала). */
export function newEdge(from: string, to: string, fromOut?: string | null): VetviEdge {
  return {
    id: uid(),
    from,
    to,
    label: null,
    kind: 'flow',
    pts: [],
    fromReply: null,
    fromOut: fromOut || null,
    bd: { dl: 0, dy: 0, dr: 0 },
  };
}

/** Новая реплика диалога. */
export function newReply(text: string, speaker: string | null): VetviReply {
  return { id: uid(), speaker, text };
}

/** Новый исход развилки. */
export function newOutcome(label: string): VetviOutcome {
  return { id: uid(), label, cond: null };
}

/** Чистый проект с одной стартовой нодой — как первый запуск оригинала. */
export function defaultDoc(): VetviDoc {
  const now = Date.now();
  const n = newNode('scene', 0, 0);
  n.x = 0;
  n.y = 0;
  return {
    meta: { name: 'Без названия', created: now, modified: now, actionLog: [], editLog: [] },
    nodes: [n],
    edges: [],
    groups: [],
    vars: [],
    chars: [],
    customTypes: [],
    palette: [],
    listHidden: {},
  };
}

/** Видовое состояние по умолчанию. */
export function defaultViewport(): VetviViewport {
  return { x: 0, y: 0, z: 1 };
}
