/**
 * Ветви — менеджер проектов (порт proj* функций оригинала, строки 11336–11581).
 * Реестр vetvi-projects-v1, слоты vetvi-project-<id>, курсор vetvi-cur-v1,
 * миграция старых автосейвов. Чтение/запись — через фасад хранилища (LS/IDB).
 */

import { docFromParsed } from './doc';
import { stItem, stRemoveItem, stSetItem } from './storage';
import { uid } from './factory';
import type { VetviAutosave, VetviDoc, VetviViewport } from './types';

const LS_PROJECTS = 'vetvi-projects-v1';
const LS_CURPROJ = 'vetvi-cur-v1';
const LEGACY_KEYS = ['vetvi-autosave-v17', 'vetvi-autosave-v16', 'vetvi-autosave-v15'];

export interface ProjEntry {
  id: string;
  name: string;
  created?: string;
  modified?: string;
  nodes?: number;
  roomId?: string | null;
  at?: string;
  [k: string]: unknown;
}

export function projSlotKey(id: string): string {
  return 'vetvi-project-' + id;
}

export function projList(): ProjEntry[] {
  const raw = stItem(LS_PROJECTS);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((e) => e && typeof e === 'object' && typeof (e as ProjEntry).id === 'string') as ProjEntry[];
  } catch {
    return [];
  }
}

function projSaveList(list: ProjEntry[]): void {
  stSetItem(LS_PROJECTS, JSON.stringify(list));
}

export function projSetCur(id: string): void {
  stSetItem(LS_CURPROJ, id);
}

export function projCurId(): string {
  return stItem(LS_CURPROJ) || '';
}

export function projSkipSaveId(id: string | null): void {
  skipSaveId = id;
}
let skipSaveId: string | null = null;

/** Запись текущего проекта в слот + реестр (projSaveCurrent).
 * roomId «липкий» (как в оригинале): пишется только когда проект реально в комнате —
 * иначе запись сохраняет прежнюю привязку и проект переподключается после перезагрузки. */
export function projSaveCurrent(doc: VetviDoc, vp: VetviViewport, bend: string, roomId: string | null = null): void {
  let pid = typeof doc.meta.projectId === 'string' ? doc.meta.projectId : '';
  if (!pid) {
    pid = uid() + uid();
    doc.meta.projectId = pid;
  }
  if (skipSaveId === pid) return;
  const now = new Date().toISOString();
  stSetItem(projSlotKey(pid), JSON.stringify({ project: doc, vp, bend }));
  stSetItem(LS_CURPROJ, pid);
  const list = projList();
  const i = list.findIndex((e) => e.id === pid);
  const entry: ProjEntry = {
    id: pid,
    name: doc.meta.name || 'Без названия',
    created: (i >= 0 ? list[i].created : undefined) || now,
    modified: doc.meta.modified ? new Date(doc.meta.modified).toISOString() : now,
    nodes: doc.nodes.length,
    at: now,
  };
  if (roomId) entry.roomId = roomId;
  if (i >= 0) list[i] = { ...list[i], ...entry };
  else list.push(entry);
  list.sort((a, b) => String(b.modified || b.at || '').localeCompare(String(a.modified || a.at || '')));
  projSaveList(list);
}

/** Миграция старых автосейвов в менеджер проектов (projMigrateLegacy). */
export function projMigrateLegacy(): boolean {
  const list = projList();
  if (list.length) return false;
  for (const key of LEGACY_KEYS) {
    const raw = stItem(key);
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const doc = docFromParsed(parsed);
      if (!doc.nodes.length && !doc.edges.length) continue;
      const vpRaw = (parsed.vp && typeof parsed.vp === 'object' ? parsed.vp : {}) as Record<string, unknown>;
      const vp: VetviViewport = {
        x: typeof vpRaw.x === 'number' ? vpRaw.x : 0,
        y: typeof vpRaw.y === 'number' ? vpRaw.y : 0,
        z: typeof vpRaw.z === 'number' ? vpRaw.z : 1,
      };
      const bend = typeof parsed.bend === 'string' ? parsed.bend : 'smooth';
      projSaveCurrent(doc, vp, bend);
      return true;
    } catch { /* пробуем следующий ключ */ }
  }
  return false;
}

export function projReadSlot(id: string): { doc: VetviDoc; vp: VetviViewport; bend: string } | null {
  const raw = stItem(projSlotKey(id));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const doc = docFromParsed(parsed);
    doc.meta.projectId = id;
    const vpRaw = (parsed.vp && typeof parsed.vp === 'object' ? parsed.vp : {}) as Record<string, unknown>;
    const vp: VetviViewport = {
      x: typeof vpRaw.x === 'number' ? vpRaw.x : 0,
      y: typeof vpRaw.y === 'number' ? vpRaw.y : 0,
      z: typeof vpRaw.z === 'number' ? vpRaw.z : 1,
    };
    const bend = typeof parsed.bend === 'string' ? parsed.bend : 'smooth';
    return { doc, vp, bend };
  } catch {
    return null;
  }
}

export function projDelete(id: string): ProjEntry[] {
  const list = projList().filter((e) => e.id !== id);
  projSaveList(list);
  stRemoveItem(projSlotKey(id));
  return list;
}

export function projRename(id: string, name: string): void {
  const list = projList();
  const e = list.find((x) => x.id === id);
  if (e) {
    e.name = name;
    projSaveList(list);
  }
}

export function projFmtDate(iso: string | undefined): string {
  try {
    const d = iso ? new Date(iso) : new Date();
    return d.toLocaleDateString('ru-RU', { day: '2-digit', month: 'short' }) + ' ' +
      d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '—';
  }
}

/* Короткое/длинное время правки (fmtWhenShort/fmtWhenLong оригинала, 1373–1391).
 * В статусбаре «✓ автосохранение · 14:32», во всплывашке редакторов — «сегодня в 14:32». */
export function fmtWhenShort(iso: string | number | undefined): string {
  if (!iso) return '';
  try {
    const d = new Date(iso), n = new Date();
    const t = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    if (d.getFullYear() === n.getFullYear() && d.getMonth() === n.getMonth() && d.getDate() === n.getDate()) return t;
    return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' }) + ' ' + t;
  } catch {
    return '';
  }
}

export function fmtWhenLong(iso: string | number | undefined): string {
  if (!iso) return '';
  try {
    const d = new Date(iso), n = new Date();
    const t = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    const day = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const today = new Date(n.getFullYear(), n.getMonth(), n.getDate());
    const diff = Math.round((today.getTime() - day.getTime()) / 864e5);
    if (diff === 0) return 'сегодня в ' + t;
    if (diff === -1) return 'вчера в ' + t;
    return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }) + ', в ' + t;
  } catch {
    return '';
  }
}

/** Скачивание JSON проекта (экспорт текущего или выделенных нод). */
export function downloadJson(filename: string, data: unknown): void {
  downloadFile(JSON.stringify(data, null, 2), filename, 'application/json');
}

/** Скачивание файла с готовым содержимым (download оригинала, 10160–10165). */
export function downloadFile(content: string, name: string, mime?: string): void {
  const blob = new Blob([content], { type: mime || 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(url);
    a.remove();
  }, 100);
}

/** Чтение JSON-файла (импорт проекта). */
export function readJsonFile(file: File): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      try {
        resolve(JSON.parse(String(r.result)));
      } catch (e) {
        reject(e);
      }
    };
    r.onerror = () => reject(r.error);
    r.readAsText(file);
  });
}

export function looksLikeProject(parsed: unknown): boolean {
  if (!parsed || typeof parsed !== 'object') return false;
  const o = parsed as Record<string, unknown>;
  const proj = (o.nodes && o.edges) ? o : (o.project as Record<string, unknown> | undefined);
  return !!(proj && Array.isArray(proj.nodes) && Array.isArray(proj.edges));
}

export function autosaveOf(doc: VetviDoc, vp: VetviViewport, bend: string): VetviAutosave {
  return { project: doc, vp, bend };
}
