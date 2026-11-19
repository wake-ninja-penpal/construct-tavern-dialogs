/**
 * Ветви — цепочки нод (стек-карточки): чистая логика без DOM.
 *
 * Порт ядра строк 7178–7208 и 7840–7841 классической версии (/vetvi/index.html):
 * stackableType, stackOrderIds, stackChainEdgeObj, stackDetachEdges,
 * stackRebuildChains, stackParkPos, stackSyncParks, queueEntryId/queueExitId.
 * Документ мутабелен — функции правят doc напрямую (как project.* в оригинале).
 */

import { QCARD_W } from './constants';
import { uid } from './factory';
import type { VetviDoc, VetviEdge, VetviGroup } from './types';

/** В цепочки входят все типы, кроме персонажей и заметок (stackableType, 7179). */
export function stackableType(t: string): boolean {
  return t !== 'char' && t !== 'note';
}

/**
 * Порядок нод цепочки (stackOrderIds, 7181–7187): по g.order, известные члены
 * идут в этом порядке; неучтённые в order члены догоняют в конце.
 */
export function stackOrderIds(doc: VetviDoc, g: VetviGroup): string[] {
  const members = doc.nodes.filter((n) => n.gid === g.id);
  const known: Record<string, boolean> = {};
  members.forEach((m) => { known[m.id] = true; });
  const out: string[] = [];
  (Array.isArray(g.order) ? (g.order as string[]) : []).forEach((id) => {
    if (known[id]) { out.push(id); known[id] = false; }
  });
  members.forEach((m) => { if (known[m.id]) out.push(m.id); });
  return out;
}

/** Связь «кто за кем» между соседями цепочки (stackChainEdgeObj, 7188). */
export function stackChainEdgeObj(aId: string, bId: string): VetviEdge {
  return {
    id: uid(),
    from: aId,
    to: bId,
    label: '',
    kind: 'flow',
    pts: [],
    lt: 0.5,
    lp: 0,
    fromReply: null,
    fromOut: null,
    tin: null,
    bd: { dl: 0, dy: 0, dr: 0 },
    cond: null,
    q: 1,
  };
}

/**
 * При помещении ноды в цепочку её старые связи убираются; связи переменных
 * не трогаем (stackDetachEdges, 7190–7192).
 */
export function stackDetachEdges(doc: VetviDoc, nid: string): void {
  doc.edges = doc.edges.filter((e) => e.tin === 'var' || (e.from !== nid && e.to !== nid));
}

/**
 * Перестройка связей «кто за кем» по порядку цепочки (stackRebuildChains, 7193–7201):
 * старые q-связи между членами чистятся, для каждой пары соседей оставляем
 * существующую не-var связь или создаём авто-связь.
 */
export function stackRebuildChains(doc: VetviDoc, g: VetviGroup): void {
  const ids = stackOrderIds(doc, g);
  const set = new Set(ids);
  doc.edges = doc.edges.filter((e) => !(e.q && set.has(e.from) && set.has(e.to)));
  for (let i = 0; i < ids.length - 1; i++) {
    const a = ids[i];
    const b = ids[i + 1];
    const exists = doc.edges.some((e) => e.from === a && e.to === b && e.tin !== 'var');
    if (!exists) doc.edges.push(stackChainEdgeObj(a, b));
  }
}

/** Парк-позиция ноды цепочки (stackParkPos, 7202): правее карточки, колонкой. */
export function stackParkPos(g: VetviGroup, idx: number): { x: number; y: number } {
  return { x: Math.round((g.x || 0) + QCARD_W + 36), y: Math.round((g.y || 0) + 14 + idx * 40) };
}

/** Расстановка всех членов цепочки по парк-позициям (stackSyncParks, 7203–7208). */
export function stackSyncParks(doc: VetviDoc, g: VetviGroup): void {
  stackOrderIds(doc, g).forEach((id, i) => {
    const n = doc.nodes.find((x) => x.id === id);
    if (!n) return;
    const pk = stackParkPos(g, i);
    n.x = pk.x;
    n.y = pk.y;
  });
}

/** Вход цепочки = первая нода (queueEntryId, 7840). */
export function queueEntryId(doc: VetviDoc, g: VetviGroup): string | null {
  const ids = stackOrderIds(doc, g);
  return ids.length ? ids[0] : null;
}

/** Выход цепочки = последняя нода (queueExitId, 7841). */
export function queueExitId(doc: VetviDoc, g: VetviGroup): string | null {
  const ids = stackOrderIds(doc, g);
  return ids.length ? ids[ids.length - 1] : null;
}
