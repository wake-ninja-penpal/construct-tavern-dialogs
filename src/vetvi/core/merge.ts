/**
 * Ветви — merge-запросы копий (ядро): статистика изменений и трёхстороннее
 * слияние. Функции чистые — работают на plain-объектах документа комнаты
 * (syncDocObj), как mergeStats/mergeDocInto классической версии.
 */

interface IdObj { id?: string; type?: string; dialog?: unknown; notes?: unknown }
interface EdgeLike { id?: string; from?: string; to?: string }

function mapById<T extends IdObj>(arr: T[] | undefined): Record<string, T> {
  const m: Record<string, T> = {};
  (arr || []).forEach((x) => { if (x && x.id) m[x.id] = x; });
  return m;
}

function cntChanged(bm: Record<string, IdObj>, arr: IdObj[] | undefined): number {
  let c = 0;
  (arr || []).forEach((x) => {
    const a = bm[String(x.id)];
    if (a && JSON.stringify(a) !== JSON.stringify(x)) c++;
  });
  return c;
}

function cntAdded(bm: Record<string, IdObj>, arr: IdObj[] | undefined): number {
  let c = 0;
  (arr || []).forEach((x) => { if (!bm[String(x.id)]) c++; });
  return c;
}

function cntRemoved(bm: Record<string, IdObj>, arr: IdObj[] | undefined): number {
  let c = 0;
  Object.keys(bm).forEach((id) => {
    let found = false;
    (arr || []).forEach((x) => { if (String(x.id) === id) found = true; });
    if (!found) c++;
  });
  return c;
}

export interface MergeStats {
  addedNodes: number; changedNodes: number; removedNodes: number;
  changedDialogs: number; changedNotes: number;
  addedEdges: number; changedEdges: number; removedEdges: number;
  addedGroups: number; changedGroups: number; removedGroups: number;
  changedTypes: number;
}

/** Статистика отличий копии (cur) от её базы (base) — для карточки merge-запроса. */
export function mergeStats(baseIn: Record<string, unknown> | null | undefined, cur: Record<string, unknown>): MergeStats {
  const base = (baseIn || {}) as { nodes?: IdObj[]; edges?: EdgeLike[]; groups?: IdObj[]; customTypes?: IdObj[] };
  const bN = mapById(base.nodes), cN = (cur.nodes || []) as IdObj[];
  const bE = mapById(base.edges as IdObj[]), cE = (cur.edges || []) as IdObj[];
  const bG = mapById(base.groups), cG = (cur.groups || []) as IdObj[];
  const bT = mapById(base.customTypes), cT = (cur.customTypes || []) as IdObj[];
  let chD = 0, chNotes = 0;
  cN.forEach((n) => {
    const a = bN[String(n.id)];
    if (!a) return;
    if (n.type === 'dialog' && a.type === 'dialog' && JSON.stringify(a.dialog || {}) !== JSON.stringify(n.dialog || {})) chD++;
    if (JSON.stringify(a.notes || []) !== JSON.stringify(n.notes || [])) chNotes++;
  });
  return {
    addedNodes: cntAdded(bN, cN), changedNodes: cntChanged(bN, cN), removedNodes: cntRemoved(bN, cN),
    changedDialogs: chD, changedNotes: chNotes,
    addedEdges: cntAdded(bE, cE), changedEdges: cntChanged(bE, cE), removedEdges: cntRemoved(bE, cE),
    addedGroups: cntAdded(bG, cG), changedGroups: cntChanged(bG, cG), removedGroups: cntRemoved(bG, cG),
    changedTypes: cntChanged(bT, cT),
  };
}

export interface MergeResult {
  nodes: IdObj[];
  edges: EdgeLike[];
  groups: IdObj[];
  customTypes: IdObj[];
  listHidden: Record<string, unknown> | null;
  name: string | null;
}

/**
 * Трёхстороннее слияние (mergeDocInto оригинала, без мутаций):
 *   — объекты, изменённые в копии, берутся из копии;
 *   — объекты, удалённые в копии (есть в base, нет в current), выпадают;
 *   — локальные объекты, которых нет ни в base, ни в current, остаются;
 *   — связи фильтруются по выжившим концам, самосвязи отбрасываются.
 */
export function mergeDocs(
  baseIn: Record<string, unknown> | null | undefined,
  cur: Record<string, unknown>,
  local: { nodes?: IdObj[]; edges?: EdgeLike[]; groups?: IdObj[]; customTypes?: IdObj[] },
): MergeResult {
  const base = (baseIn || {}) as { nodes?: IdObj[]; edges?: EdgeLike[]; groups?: IdObj[]; customTypes?: IdObj[] };
  const bN = mapById(base.nodes), cNm = mapById(cur.nodes as IdObj[]);
  const bE = mapById(base.edges as IdObj[]), cEm = mapById(cur.edges as IdObj[]);
  const bG = mapById(base.groups), cGm = mapById(cur.groups as IdObj[]);
  const bT = mapById(base.customTypes), cTm = mapById(cur.customTypes as IdObj[]);
  const resIds: Record<string, number> = {};

  function union(curMap: Record<string, IdObj>, baseMap: Record<string, IdObj>, curArr: IdObj[] | undefined, curList: IdObj[] | undefined): IdObj[] {
    const out: IdObj[] = [];
    (curList || []).forEach((n) => {
      if (n && curMap[String(n.id)]) { out.push(curMap[String(n.id)]); resIds[String(n.id)] = 1; }
      else if (n && baseMap[String(n.id)]) { /* удалено в копии — выпадает */ }
      else if (n) { out.push(n); resIds[String(n.id)] = 1; }
    });
    (curArr || []).forEach((n) => {
      if (n && n.id && !resIds[String(n.id)]) { out.push(n); resIds[String(n.id)] = 1; }
    });
    return out;
  }

  const nodes = union(cNm, bN, cur.nodes as IdObj[] | undefined, local.nodes);
  const groups = union(cGm, bG, cur.groups as IdObj[] | undefined, local.groups);
  const customTypes = union(cTm, bT, cur.customTypes as IdObj[] | undefined, local.customTypes);
  const edges = union(cEm, bE, cur.edges as EdgeLike[] | undefined, local.edges).filter((e) => {
    const ed = e as EdgeLike;
    return resIds[String(ed.from)] && resIds[String(ed.to)] && ed.from !== ed.to;
  });
  const listHidden = (cur.listHidden && typeof cur.listHidden === 'object') ? (cur.listHidden as Record<string, unknown>) : null;
  const meta = cur.meta as { name?: string } | null;
  const name = (meta && meta.name && !(local as { meta?: { projectId?: string } }).meta?.projectId) ? meta.name : null;
  return { nodes, edges, groups, customTypes, listHidden, name };
}
