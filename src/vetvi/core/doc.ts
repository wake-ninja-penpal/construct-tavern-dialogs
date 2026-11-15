/**
 * Ветви — загрузка и сохранение документа.
 *
 * Pass-through порт: документ читается «как есть», ядро гарантирует только
 * наличие структурных полей (nodes/edges/groups/meta) и типы известных полей.
 * Неизвестные поля (переменные, персонажи, свои типы, журнал действий и т.д.)
 * сохраняются без изменений — React-редактор ничего не теряет из проектов
 * классической версии.
 */

import { LS_KEY } from './constants';
import { defaultDoc, defaultViewport, uid } from './factory';
import type { VetviAutosave, VetviDoc, VetviEdge, VetviGroup, VetviNode, VetviViewport } from './types';

/** Реестр проектов и текущий проект — как менеджер проектов классической версии. */
const LS_PROJECTS = 'vetvi-projects-v1';
const LS_CURPROJ = 'vetvi-cur-v1';

function slotKey(id: string): string {
  return 'vetvi-project-' + id;
}

function asString(v: unknown, dflt: string): string {
  return typeof v === 'string' ? v : dflt;
}

function asNum(v: unknown, dflt: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : dflt;
}

function asBool(v: unknown, dflt: boolean): boolean {
  return typeof v === 'boolean' ? v : dflt;
}

/** Мягкая нормализация одной ноды: известные поля приводятся к типам, остальное не трогается. */
function normalizeNode(raw: unknown): VetviNode | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.id !== 'string' || !o.id) return null;
  const n = o as unknown as VetviNode;
  n.type = asString(o.type, 'scene');
  n.gid = typeof o.gid === 'string' ? o.gid : null;
  n.x = asNum(o.x, 0);
  n.y = asNum(o.y, 0);
  n.title = asString(o.title, '');
  n.text = asString(o.text, '');
  n.status = asString(o.status, 'idea');
  if (!Array.isArray(o.tags)) n.tags = [];
  n.expand = asNum(o.expand, 1);
  n.color = typeof o.color === 'string' ? o.color : null;
  n.tint = asNum(o.tint, -60);
  n.dlgWidth = typeof o.dlgWidth === 'number' ? o.dlgWidth : null;
  if (n.type === 'dialog') {
    if (!n.dialog || typeof n.dialog !== 'object') n.dialog = { participants: [], description: '', replies: [] };
    if (!Array.isArray(n.dialog.participants)) n.dialog.participants = [];
    if (!Array.isArray(n.dialog.replies)) n.dialog.replies = [];
    if (typeof n.dialog.description !== 'string') n.dialog.description = '';
  }
  return n;
}

function normalizeEdge(raw: unknown): VetviEdge | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.id !== 'string' || !o.id) return null;
  if (typeof o.from !== 'string' || typeof o.to !== 'string') return null;
  const e = o as unknown as VetviEdge;
  e.kind = asString(o.kind, 'flow');
  if (!Array.isArray(o.pts)) e.pts = [];
  e.fromReply = typeof o.fromReply === 'string' ? o.fromReply : null;
  e.fromOut = typeof o.fromOut === 'string' ? o.fromOut : null;
  return e;
}

function normalizeGroup(raw: unknown): VetviGroup | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.id !== 'string' || !o.id) return null;
  const g = o as unknown as VetviGroup;
  g.name = asString(o.name, 'Группа');
  g.x = asNum(o.x, 0);
  g.y = asNum(o.y, 0);
  g.parent = typeof o.parent === 'string' ? o.parent : null;
  return g;
}

/**
 * Документ из произвольного JSON (pass-through). На входе — распарсенный
 * объект автосохранения или «сырой» project; на выходе — валидный VetviDoc.
 */
export function docFromParsed(parsed: unknown): VetviDoc {
  let project: Record<string, unknown> | null = null;
  if (parsed && typeof parsed === 'object') {
    const o = parsed as Record<string, unknown>;
    // Обёртка автосохранения {project, vp, bend} или сам проект.
    project = (o.nodes || o.edges) ? o : ((o.project && typeof o.project === 'object') ? (o.project as Record<string, unknown>) : null);
  }
  if (!project) return defaultDoc();
  const doc = project as unknown as VetviDoc;
  if (!doc.meta || typeof doc.meta !== 'object') doc.meta = { name: 'Без названия' } as VetviDoc['meta'];
  if (typeof doc.meta.name !== 'string') doc.meta.name = 'Без названия';
  doc.nodes = Array.isArray(project.nodes)
    ? (project.nodes.map(normalizeNode).filter(Boolean) as VetviNode[])
    : [];
  doc.edges = Array.isArray(project.edges)
    ? (project.edges.map(normalizeEdge).filter(Boolean) as VetviEdge[])
    : [];
  doc.groups = Array.isArray(project.groups)
    ? (project.groups.map(normalizeGroup).filter(Boolean) as VetviGroup[])
    : [];
  // Существующие связи на несуществующие ноды отбрасываются (как normalize оригинала).
  const ids = new Set(doc.nodes.map((n) => n.id));
  doc.edges = doc.edges.filter((e) => ids.has(e.from) && ids.has(e.to));
  if (!Array.isArray(doc.vars)) doc.vars = [];
  if (!Array.isArray(doc.chars)) doc.chars = [];
  if (!Array.isArray(doc.palette)) doc.palette = [];
  return doc;
}

/** Документ из JSON-строки. */
export function docFromJson(json: string): VetviDoc | null {
  try {
    return docFromParsed(JSON.parse(json));
  } catch {
    return null;
  }
}

/**
 * Загрузка автосохранения: сначала слот текущего проекта менеджера проектов
 * классической версии (vetvi-cur-v1 → vetvi-project-<id>), затем fallback —
 * старое зеркало LS_KEY. Поддержан и hash #project=<id> (открыть конкретный проект).
 */
export function loadAutosave(): { doc: VetviDoc; vp: VetviViewport; bend: string } {
  if (typeof window === 'undefined') {
    return { doc: defaultDoc(), vp: defaultViewport(), bend: 'smooth' };
  }
  const fromRaw = (raw: string | null): { doc: VetviDoc; vp: VetviViewport; bend: string } | null => {
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const doc = docFromParsed(parsed);
      const vpRaw = (parsed.vp && typeof parsed.vp === 'object' ? parsed.vp : {}) as Record<string, unknown>;
      const vp: VetviViewport = {
        x: asNum(vpRaw.x, 0),
        y: asNum(vpRaw.y, 0),
        z: asNum(vpRaw.z, 1),
      };
      if (!(vp.z > 0)) vp.z = 1;
      const bend = asString(parsed.bend, 'smooth');
      return { doc, vp, bend };
    } catch {
      return null;
    }
  };
  // 1) текущий проект менеджера проектов (или указанный в hash)
  let curId = '';
  try {
    curId = window.localStorage.getItem(LS_CURPROJ) || '';
  } catch {
    curId = '';
  }
  const hashProject = /project=([A-Za-z0-9_-]+)/.exec(window.location.hash || '');
  if (hashProject) curId = hashProject[1];
  if (curId) {
    try {
      const raw = window.localStorage.getItem(slotKey(curId));
      const res = fromRaw(raw);
      if (res) {
        res.doc.meta.projectId = curId;
        return res;
      }
    } catch {
      // слот недоступен — уходим в fallback
    }
  }
  // 2) legacy-зеркало автосохранения
  try {
    const res = fromRaw(window.localStorage.getItem(LS_KEY));
    if (res) return res;
  } catch {
    // пусто — читаем ниже дефолт
  }
  return { doc: defaultDoc(), vp: defaultViewport(), bend: 'smooth' };
}

/** Сериализация документа (совместима с serialize() оригинала, версия 18). */
export function serializeDoc(doc: VetviDoc, vp: VetviViewport, bend: string): string {
  return JSON.stringify({
    app: 'vetvi',
    version: 18,
    bend,
    meta: doc.meta,
    viewport: vp,
    nodes: doc.nodes,
    edges: doc.edges,
    customTypes: Array.isArray(doc.customTypes) ? doc.customTypes : [],
    groups: doc.groups,
    listHidden: doc.listHidden && typeof doc.listHidden === 'object' ? doc.listHidden : {},
    vars: Array.isArray(doc.vars) ? doc.vars : [],
    chars: Array.isArray(doc.chars) ? doc.chars : [],
    palette: Array.isArray(doc.palette) ? doc.palette : [],
  });
}

/**
 * Запись автосохранения: слот текущего проекта + реестр менеджера проектов
 * классической версии + legacy-зеркало LS_KEY. Благодаря этому проект,
 * отредактированный в React-версии, открывается в /vetvi/index.html «как свой».
 */
export function saveAutosave(doc: VetviDoc, vp: VetviViewport, bend: string): void {
  if (typeof window === 'undefined') return;
  // id проекта: как в оригинале — meta.projectId, иначе генерируем и прописываем
  let pid = typeof doc.meta.projectId === 'string' ? doc.meta.projectId : '';
  if (!pid) {
    pid = uid();
    doc.meta.projectId = pid;
  }
  const payload: VetviAutosave = { project: doc, vp, bend };
  const raw = JSON.stringify(payload);
  try {
    window.localStorage.setItem(slotKey(pid), raw);
    window.localStorage.setItem(LS_KEY, raw);
    window.localStorage.setItem(LS_CURPROJ, pid);
  } catch {
    // переполнение квоты — автосохранение пропускается, как в оригинале
    return;
  }
  // реестр проектов: обновить запись (name/modified/nodes/at), сорт по modified
  try {
    const now = new Date().toISOString();
    let list: { id: string; name?: string; created?: string; modified?: string; nodes?: number; roomId?: string | null; at?: string }[] = [];
    const regRaw = window.localStorage.getItem(LS_PROJECTS);
    if (regRaw) {
      const parsed: unknown = JSON.parse(regRaw);
      if (Array.isArray(parsed)) list = parsed as typeof list;
    }
    const i = list.findIndex((e) => e && e.id === pid);
    const entry = { id: pid, name: doc.meta.name || 'Без названия', created: (i >= 0 ? list[i].created : undefined) || now, modified: now, nodes: doc.nodes.length, roomId: null, at: now };
    if (i >= 0) list[i] = { ...list[i], ...entry };
    else list.push(entry);
    list.sort((a, b) => String(b.modified || b.at || '').localeCompare(String(a.modified || a.at || '')));
    window.localStorage.setItem(LS_PROJECTS, JSON.stringify(list));
  } catch {
    // реестр не обновился — слот и зеркало всё равно записаны
  }
}
