/**
 * Ветви — diff для журнала действий (упрощённый порт logDiff оригинала, строки 2268–2479).
 * Секции нод/связей/групп/переменных с id-списками и человекочитаемыми полями.
 */

import type { VetviNode } from './types';

export interface LogFieldPair { k: string; a: string; b: string }
export interface LogItem { id: string; name: string; fields: LogFieldPair[] }
export interface LogSection { key: string; items: LogItem[] }
export interface LogDiff {
  sections: LogSection[];
  ids: string[];
  nodes: string[];
  groups: string[];
}

export const LOG_F_N: Record<string, string> = {
  title: 'название', text: 'текст', status: 'статус', color: 'цвет', tint: 'яркость',
  x: 'позиция', y: 'позиция', expand: 'сворачивание', dlgWidth: 'ширина', dialog: 'реплики/участники',
  notes: 'заметки', gid: 'группа', outcomes: 'исходы', outs: 'исходы', type: 'тип',
  vid: 'переменная', varMode: 'режим', varOp: 'операция', linear: 'проигрывание подряд',
};
export const LOG_F_E: Record<string, string> = {
  label: 'подпись', cond: 'условие', pts: 'изгибы', fromReply: 'исход из реплики', fromOut: 'исход',
  from: 'перенаправление', to: 'перенаправление', bd: 'форма моста', kind: 'тип линии', lt: 'якорь подписи', lp: 'якорь подписи',
};
export const LOG_F_G: Record<string, string> = {
  name: 'название', color: 'цвет', tint: 'яркость', fold: 'вид', stack: 'тип', parent: 'вложенность',
  alpha: 'прозрачность', badge: 'ярлык', auto: 'авторазмер', fx: 'рамка', fy: 'рамка', fw: 'рамка', fh: 'рамка', order: 'порядок',
};

const SKIP_N = new Set(['id', 'type']);
const SKIP_E = new Set(['id', 'from', 'to']);
const SKIP_G = new Set(['id']);

/** Стабильная сериализация значения (сортировка ключей — logStable оригинала). */
function stableKeyOf(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) || 'null';
  if (Array.isArray(v)) return '[' + v.map(stableKeyOf).join(',') + ']';
  const o = v as Record<string, unknown>;
  return '{' + Object.keys(o).sort().map((k) => JSON.stringify(k) + ':' + stableKeyOf(o[k])).join(',') + '}';
}

function txt(v: unknown, max = 60): string {
  const s = String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max) + '…' : s;
}

function nodeBrief(n: Partial<VetviNode> | undefined): string {
  if (!n) return '?';
  return txt(n.title || '', 40) || '?';
}

interface ById { map: Map<string, Record<string, unknown>>; order: string[] }

function byIdList(arr: unknown): ById {
  const map = new Map<string, Record<string, unknown>>();
  const order: string[] = [];
  if (Array.isArray(arr)) {
    for (const raw of arr) {
      if (raw && typeof raw === 'object') {
        const o = raw as Record<string, unknown>;
        if (typeof o.id === 'string') {
          map.set(o.id, o);
          order.push(o.id);
        }
      }
    }
  }
  return { map, order };
}

function fieldPairs(a: Record<string, unknown>, b: Record<string, unknown>, skip: Set<string>, names: Record<string, string>): LogFieldPair[] {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const out: LogFieldPair[] = [];
  for (const k of keys) {
    if (skip.has(k)) continue;
    const ka = stableKeyOf(a[k]);
    const kb = stableKeyOf(b[k]);
    if (ka === kb) continue;
    out.push({ k: names[k] || k, a: txt(a[k], 44), b: txt(b[k], 44) });
  }
  return out;
}

export function logDiff(preStr: string, curStr: string): LogDiff | null {
  if (preStr === curStr) return null;
  let A: Record<string, unknown>;
  let B: Record<string, unknown>;
  try {
    A = JSON.parse(preStr) as Record<string, unknown>;
    B = JSON.parse(curStr) as Record<string, unknown>;
  } catch {
    return null;
  }
  const sections: LogSection[] = [];
  const ids: string[] = [];
  const nodeIds: string[] = [];
  const groupIds: string[] = [];

  const na = byIdList(A.nodes);
  const nb = byIdList(B.nodes);
  const ea = byIdList(A.edges);
  const eb = byIdList(B.edges);
  const ga = byIdList(A.groups);
  const gb = byIdList(B.groups);
  const va = byIdList(A.vars);
  const vb = byIdList(B.vars);

  const push = (key: string, items: LogItem[]) => {
    if (items.length) sections.push({ key, items });
  };

  const added: LogItem[] = [];
  for (const id of nb.order) if (!na.map.has(id)) added.push({ id, name: nodeBrief(nb.map.get(id) as Partial<VetviNode>), fields: [] });
  push('nA', added);

  const removed: LogItem[] = [];
  for (const id of na.order) if (!nb.map.has(id)) removed.push({ id, name: nodeBrief(na.map.get(id) as Partial<VetviNode>), fields: [] });
  push('nD', removed);

  const changed: LogItem[] = [];
  for (const id of nb.order) {
    const a = na.map.get(id);
    const b = nb.map.get(id);
    if (!a || !b) continue;
    const pairs = fieldPairs(a, b, SKIP_N, LOG_F_N);
    if (pairs.length) changed.push({ id, name: nodeBrief(b as Partial<VetviNode>), fields: pairs.slice(0, 6) });
  }
  push('nC', changed);

  const eAdded: LogItem[] = [];
  for (const id of eb.order) if (!ea.map.has(id)) eAdded.push({ id, name: edgeBrief(eb.map.get(id), nb.map), fields: [] });
  push('eA', eAdded);
  const eRemoved: LogItem[] = [];
  for (const id of ea.order) if (!eb.map.has(id)) eRemoved.push({ id, name: edgeBrief(ea.map.get(id), na.map), fields: [] });
  push('eD', eRemoved);
  const eChanged: LogItem[] = [];
  for (const id of eb.order) {
    const a = ea.map.get(id);
    const b = eb.map.get(id);
    if (!a || !b) continue;
    const pairs = fieldPairs(a, b, SKIP_E, LOG_F_E);
    if (pairs.length) eChanged.push({ id, name: edgeBrief(b, nb.map), fields: pairs.slice(0, 5) });
  }
  push('eC', eChanged);

  const gAdded: LogItem[] = [];
  for (const id of gb.order) if (!ga.map.has(id)) gAdded.push({ id, name: String((gb.map.get(id) as { name?: string }).name || 'Группа'), fields: [] });
  push('gA', gAdded);
  const gRemoved: LogItem[] = [];
  for (const id of ga.order) if (!gb.map.has(id)) gRemoved.push({ id, name: String((ga.map.get(id) as { name?: string }).name || 'Группа'), fields: [] });
  push('gD', gRemoved);
  const gChanged: LogItem[] = [];
  for (const id of gb.order) {
    const a = ga.map.get(id);
    const b = gb.map.get(id);
    if (!a || !b) continue;
    const pairs = fieldPairs(a, b, SKIP_G, LOG_F_G);
    if (pairs.length) gChanged.push({ id, name: String((b as { name?: string }).name || 'Группа'), fields: pairs.slice(0, 5) });
  }
  push('gC', gChanged);

  const vAdded: LogItem[] = [];
  for (const id of vb.order) if (!va.map.has(id)) vAdded.push({ id, name: String((vb.map.get(id) as { name?: string }).name || '?'), fields: [] });
  push('vA', vAdded);
  const vRemoved: LogItem[] = [];
  for (const id of va.order) if (!vb.map.has(id)) vRemoved.push({ id, name: String((va.map.get(id) as { name?: string }).name || '?'), fields: [] });
  push('vD', vRemoved);
  const vChanged: LogItem[] = [];
  for (const id of vb.order) {
    const a = va.map.get(id);
    const b = vb.map.get(id);
    if (!a || !b) continue;
    const pairs = fieldPairs(a, b, new Set(['id']), {});
    if (pairs.length) vChanged.push({ id, name: String((b as { name?: string }).name || '?'), fields: pairs.slice(0, 5) });
  }
  push('vC', vChanged);

  for (const s of sections) {
    for (const it of s.items) {
      if (ids.length < 12) ids.push(it.id);
      if (s.key[0] === 'n') { if (nodeIds.length < 60) nodeIds.push(it.id); }
      else if (s.key[0] === 'g') { if (groupIds.length < 60) groupIds.push(it.id); }
      else if (s.key[0] === 'e') {
        const e = nb.map.get(it.id) || na.map.get(it.id);
        if (e) {
          for (const end of [e.from, e.to]) {
            if (typeof end === 'string' && nodeIds.length < 60 && !nodeIds.includes(end)) nodeIds.push(end);
          }
        }
      }
    }
  }

  if (!sections.length) return null;
  return { sections, ids, nodes: nodeIds, groups: groupIds };
}

function edgeBrief(e: Record<string, unknown> | undefined, nodes: Map<string, Record<string, unknown>>): string {
  if (!e) return '?';
  const f = nodes.get(String(e.from || ''));
  const t = nodes.get(String(e.to || ''));
  const fr = nodeBrief(f as Partial<VetviNode>);
  const to = nodeBrief(t as Partial<VetviNode>);
  return fr + ' → ' + to;
}

export function logDiffSummary(d: LogDiff | null): string {
  if (!d) return 'Изменение проекта';
  const parts: string[] = [];
  const cnt = (key: string): number => {
    const s = d.sections.find((x) => x.key === key);
    return s ? s.items.length : 0;
  };
  const nA = cnt('nA'); const nD = cnt('nD'); const nC = cnt('nC');
  if (nA) parts.push('+' + nA + ' нод');
  if (nD) parts.push('−' + nD + ' нод');
  if (nC) parts.push('правка нод: ' + nC);
  const eA = cnt('eA'); const eD = cnt('eD'); const eC = cnt('eC');
  if (eA) parts.push('+' + eA + ' связей');
  if (eD) parts.push('−' + eD + ' связей');
  if (eC) parts.push('правка связей: ' + eC);
  const gA = cnt('gA'); const gD = cnt('gD'); const gC = cnt('gC');
  if (gA) parts.push('+' + gA + ' групп');
  if (gD) parts.push('−' + gD + ' групп');
  if (gC) parts.push('правка групп: ' + gC);
  const vA = cnt('vA'); const vD = cnt('vD'); const vC = cnt('vC');
  if (vA) parts.push('+' + vA + ' переменных');
  if (vD) parts.push('−' + vD + ' переменных');
  if (vC) parts.push('правка переменных: ' + vC);
  return parts.join(', ') || 'Изменение проекта';
}

export const SECTION_TITLES: Record<string, string> = {
  nA: 'добавлены ноды', nD: 'удалены ноды', nC: 'изменены ноды',
  eA: 'добавлены связи', eD: 'удалены связи', eC: 'изменены связи',
  gA: 'добавлены группы', gD: 'удалены группы', gC: 'изменены группы',
  vA: 'добавлены переменные', vD: 'удалены переменные', vC: 'изменены переменные',
};
