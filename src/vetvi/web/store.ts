'use client';

/**
 * Ветви — стор React-редактора (этап 2 порта).
 *
 * Классический ObservableStore + useSyncExternalStore (без внешних зависимостей):
 * документ мутабелен, перерисовка триггерится счётчиком revision.
 * История undo/redo — снимки serializeDoc (как pushHistory оригинала) с журналом
 * действий (diff-записи в meta.actionLog, лимит 60, снимки ≤800k символов).
 * Выделение трёх наборов: ноды/связи/группы (взаимоисключающие, shift добавляет).
 * Автосохранение — менеджер проектов классической версии через фасад LS/IDB.
 */

import { AUTOSAVE_MS, HISTORY_LIMIT, TYPES } from '@/vetvi/core/constants';
import { docFromParsed, loadAutosave, saveAutosave, serializeDoc } from '@/vetvi/core/doc';
import { defaultDoc, defaultViewport, newEdge, newReply, newNode, snapVal, uid } from '@/vetvi/core/factory';
import { clamp, clampZoom, docBounds, nodeHeight, nodeWidth, screenToWorld } from '@/vetvi/core/geometry';
import { logDiff, logDiffSummary, type LogDiff } from '@/vetvi/core/logdiff';
import { projDelete, projList, projMigrateLegacy, projReadSlot, projSaveCurrent, projSetCur, projSlotKey } from '@/vetvi/core/projects';
import { stItem, stRemoveItem, stSetItem } from '@/vetvi/core/storage';
import type { NodeSize, VetviChar, VetviDoc, VetviEdge, VetviGroup, VetviNode, VetviOutcome, VetviReply, VetviVar, VetviViewport } from '@/vetvi/core/types';
import { cleanupVarRefs, defValOf, varCastVal, varType } from '@/vetvi/core/vars';

type Listener = () => void;

export type SaveState = 'idle' | 'pending' | 'saved';
export type BendMode = 'smooth' | 'ortho90' | 'ortho45';

export interface CtxItem { label?: string; head?: string; sep?: boolean; danger?: boolean; dot?: string; fn?: () => void }
export interface Toast { id: number; msg: string; kind: 'ok' | 'warn' | 'err' }
export interface ConfirmBtn { label: string; primary?: boolean; danger?: boolean; fn?: () => void }
export interface ConfirmCfg { title: string; text?: string; buttons?: ConfirmBtn[]; wide?: boolean }

export interface LogEntry {
  id: string;
  t: number;
  by: { id: string; name: string; color: string };
  act: string;
  diff: LogDiff | null;
  snap?: string | null;
}

export function editIdentity(): { id: string; name: string; color: string } {
  try {
    const raw = window.localStorage.getItem('vetvi-me-v1');
    if (raw) {
      const me = JSON.parse(raw) as { id?: string; name?: string; color?: string };
      if (me && me.id && me.name) return { id: me.id, name: me.name, color: me.color || '#8b929c' };
    }
  } catch { /* локальная личность */ }
  return { id: 'вы', name: 'вы', color: '#8b929c' };
}

const LOG_LIMIT = 60;
const LOG_SNAP_ONE = 800000;
const LOG_SNAP_TOTAL = 1200000;

export class VetviStore {
  doc: VetviDoc;
  vp: VetviViewport = defaultViewport();
  bend: BendMode = 'smooth';
  snapOn = true;
  gridOn = true;

  sel = new Set<string>();
  selEdges = new Set<string>();
  selGroups = new Set<string>();

  /* ── UI-состояние ── */
  leftTab: 'pal' | 'list' | 'vars' | 'chars' = 'pal';
  leftWidth = 300;
  modal: string | null = null;
  modalArg: string | null = null;
  dialogEdit: string | null = null; // nodeId открытого редактора диалога
  ctx: { x: number; y: number; items: CtxItem[] } | null = null;
  toasts: Toast[] = [];
  confirm: ConfirmCfg | null = null;
  carry: { ids: string[]; pre: string } | null = null;
  renameId: string | null = null;
  flash: { nodeId: string; replyId: string | null; t: number } | null = null;
  centerReq: { id: string; t: number } | null = null;
  logFilterNode: string | null = null;
  logFilterGroup: string | null = null;
  knifeOn = false;
  spaceDown = false;
  ctrlDown = false;
  saveMenuOpen = false;

  /* ── совместное редактирование (заполняет SyncClient) ── */
  syncStatus: 'off' | 'conn' | 'on' | 'err' | 'lost' | 'copy' = 'off';
  syncMode: 'local' | 'room' | 'copy' = 'local';
  syncRoom: string | null = null;
  syncUsers: { id: string; name: string; color: string; cur?: string | null }[] = [];
  syncMergeCount = 0;
  syncLocks: Record<string, { id: string; name: string; color: string }> = {};
  syncBusyFlag = false;

  revision = 0;
  saveState: SaveState = 'idle';
  lastSavedAt = 0;

  private past: string[] = [];
  private future: string[] = [];
  private pendingLog: { pre: string; t: number; label: string | null } | null = null;
  private logFlushT: ReturnType<typeof setTimeout> | null = null;
  private listeners = new Set<Listener>();
  private saveT: ReturnType<typeof setTimeout> | null = null;
  private toastSeq = 1;

  constructor() {
    const isClient = typeof window !== 'undefined';
    if (isClient) projMigrateLegacy();
    const loaded = isClient ? loadAutosave() : { doc: defaultDoc(), vp: defaultViewport(), bend: 'smooth' };
    this.doc = loaded.doc;
    this.vp = loaded.vp;
    this.bend = (loaded.bend || 'smooth') as BendMode;
    this.leftWidth = isClient
      ? Math.min(560, Math.max(240, Number(window.localStorage.getItem('vetvi-left-w')) || 300))
      : 300;
  }

  /* ── подписка ── */

  subscribe = (l: Listener): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  getSnapshot = (): number => this.revision;

  emit(): void {
    this.revision++;
    this.listeners.forEach((l) => l());
  }

  /* ── журналы действий ── */

  private scheduleLogFlush(): void {
    if (this.logFlushT) clearTimeout(this.logFlushT);
    this.logFlushT = setTimeout(() => this.flushPendingLog(), 700);
  }

  flushPendingLog(): void {
    if (this.logFlushT) { clearTimeout(this.logFlushT); this.logFlushT = null; }
    if (!this.pendingLog) return;
    const { pre, label } = this.pendingLog;
    this.pendingLog = null;
    const cur = this.serialize();
    if (pre === cur) return;
    const diff = logDiff(pre, cur);
    this.logActionEntry({
      id: uid() + uid(),
      t: Date.now(),
      by: editIdentity(),
      act: label || logDiffSummary(diff),
      diff,
      snap: pre.length <= LOG_SNAP_ONE ? pre : null,
    });
  }

  private logActionEntry(entry: LogEntry): void {
    const meta = this.doc.meta;
    if (!Array.isArray(meta.actionLog)) meta.actionLog = [];
    const arr = meta.actionLog as LogEntry[];
    arr.unshift(entry);
    if (arr.length > LOG_LIMIT) arr.length = LOG_LIMIT;
    this.logTrimSnaps();
    this.scheduleSave();
    this.emit();
  }

  private logTrimSnaps(): void {
    const arr = (this.doc.meta.actionLog || []) as LogEntry[];
    let total = 0;
    for (const e of arr) total += e.snap ? e.snap.length : 0;
    if (total <= LOG_SNAP_TOTAL) return;
    for (let i = arr.length - 1; i >= 0 && total > LOG_SNAP_TOTAL; i--) {
      const sn = arr[i]?.snap;
      if (sn) {
        total -= sn.length;
        arr[i].snap = null;
      }
    }
  }

  logManual(act: string): void {
    this.flushPendingLog();
    this.logActionEntry({ id: uid() + uid(), t: Date.now(), by: editIdentity(), act, diff: null, snap: null });
  }

  logUndoRedo(pre: string, word: string): void {
    const cur = this.serialize();
    if (pre === cur) return;
    const diff = logDiff(pre, cur);
    this.logActionEntry({
      id: uid() + uid(),
      t: Date.now(),
      by: editIdentity(),
      act: word + (diff ? ' — ' + logDiffSummary(diff) : ''),
      diff,
      snap: pre.length <= LOG_SNAP_ONE ? pre : null,
    });
  }

  /* ── история и сохранение ── */

  serialize(): string {
    return serializeDoc(this.doc, this.vp, this.bend);
  }

  pushHistory(label?: string): void {
    this.flushPendingLog();
    const pre = this.serialize();
    this.pendingLog = { pre, t: Date.now(), label: label || null };
    this.scheduleLogFlush();
    this.past.push(pre);
    if (this.past.length > HISTORY_LIMIT) this.past.shift();
    this.future.length = 0;
  }

  beginEdit(): string {
    this.flushPendingLog();
    return this.serialize();
  }

  commitEdit(pre: string | null, label?: string): void {
    if (!pre) return;
    const cur = this.serialize();
    if (cur === pre) return;
    this.pendingLog = { pre, t: Date.now(), label: label || null };
    this.scheduleLogFlush();
    this.past.push(pre);
    if (this.past.length > HISTORY_LIMIT) this.past.shift();
    this.future.length = 0;
    this.scheduleSave();
    this.emit();
  }

  scheduleSave(): void {
    if (this.saveT) clearTimeout(this.saveT);
    this.saveState = 'pending';
    this.saveT = setTimeout(() => {
      this.saveT = null;
      this.doc.meta.modified = Date.now();
      this.persist();
      this.saveState = 'saved';
      this.lastSavedAt = Date.now();
      this.emit();
    }, AUTOSAVE_MS);
  }

  persist(): void {
    if (this.syncMode === 'room') {
      // в комнате слот всё равно ведётся для оффлайна
    }
    saveAutosave(this.doc, this.vp, this.bend);
    projSaveCurrent(this.doc, this.vp, this.bend, this.syncRoom);
  }

  /** Мутация с записью в историю. fn меняет this.doc напрямую. */
  mutate(fn: (doc: VetviDoc) => void, opts?: { history?: boolean; label?: string }): void {
    if (!opts || opts.history !== false) this.pushHistory(opts?.label);
    fn(this.doc);
    this.scheduleSave();
    this.emit();
  }

  /** Одноразовое «ручное» действие без diff (переименование проекта и т.п.). */
  mutateManual(fn: (doc: VetviDoc) => void, act: string, debounceMs = 900): void {
    this.flushPendingLog();
    fn(this.doc);
    if (this._manT) clearTimeout(this._manT);
    this._manT = setTimeout(() => this.logManual(act), debounceMs);
    this.scheduleSave();
    this.emit();
  }
  private _manT: ReturnType<typeof setTimeout> | null = null;

  undo(): void {
    this.flushPendingLog();
    if (!this.past.length) return;
    const pre = this.serialize();
    this.future.push(pre);
    const snap = this.past.pop();
    this.doc = docFromParsed(JSON.parse(snap as string));
    this.sel.clear();
    this.selEdges.clear();
    this.selGroups.clear();
    this.logUndoRedo(pre, 'Отмена');
    this.toast('Отменено', 'warn');
    this.scheduleSave();
    this.emit();
  }

  redo(): void {
    this.flushPendingLog();
    if (!this.future.length) return;
    const pre = this.serialize();
    this.past.push(pre);
    const snap = this.future.pop();
    this.doc = docFromParsed(JSON.parse(snap as string));
    this.sel.clear();
    this.selEdges.clear();
    this.selGroups.clear();
    this.logUndoRedo(pre, 'Повтор');
    this.toast('Повторено', 'ok');
    this.scheduleSave();
    this.emit();
  }

  canUndo(): boolean { return this.past.length > 0; }
  canRedo(): boolean { return this.future.length > 0; }

  logHistoryCount(): number { return this.past.length; }

  /** Откат проекта к моменту записи журнала (logRollbackProject). */
  rollbackToSnapshot(snap: string): void {
    this.pushHistory('Откат проекта по журналу');
    this.doc = docFromParsed(JSON.parse(snap));
    this.sel.clear();
    this.selEdges.clear();
    this.selGroups.clear();
    this.scheduleSave();
    this.emit();
  }

  flushSave(): void {
    this.flushPendingLog();
    if (this.saveT) { clearTimeout(this.saveT); this.saveT = null; }
    this.doc.meta.modified = Date.now();
    this.persist();
    this.saveState = 'saved';
    this.lastSavedAt = Date.now();
    this.emit();
  }

  /* ── выделение ── */

  selectOnly(id: string): void {
    this.sel.clear();
    this.selEdges.clear();
    this.selGroups.clear();
    this.sel.add(id);
    this.emit();
  }

  toggleSelect(id: string): void {
    this.selEdges.clear();
    this.selGroups.clear();
    if (this.sel.has(id)) this.sel.delete(id);
    else this.sel.add(id);
    this.emit();
  }

  selectEdgeOnly(id: string): void {
    this.sel.clear();
    this.selEdges.clear();
    this.selGroups.clear();
    this.selEdges.add(id);
    this.emit();
  }

  toggleEdge(id: string): void {
    this.sel.clear();
    this.selGroups.clear();
    if (this.selEdges.has(id)) this.selEdges.delete(id);
    else this.selEdges.add(id);
    this.emit();
  }

  selectGroupOnly(id: string): void {
    this.sel.clear();
    this.selEdges.clear();
    this.selGroups.clear();
    this.selGroups.add(id);
    this.emit();
  }

  toggleGroup(id: string): void {
    this.sel.clear();
    this.selEdges.clear();
    if (this.selGroups.has(id)) this.selGroups.delete(id);
    else this.selGroups.add(id);
    this.emit();
  }

  setSel(nodes: string[], groups: string[] = []): void {
    this.selEdges.clear();
    this.sel = new Set(nodes);
    this.selGroups = new Set(groups);
    this.emit();
  }

  clearSelection(): void {
    if (!this.sel.size && !this.selEdges.size && !this.selGroups.size) return;
    this.sel.clear();
    this.selEdges.clear();
    this.selGroups.clear();
    this.emit();
  }

  selectAll(): void {
    this.selEdges.clear();
    this.selGroups.clear();
    this.sel = new Set(this.doc.nodes.map((n) => n.id));
    this.emit();
  }

  /* ── UI ── */

  toast(msg: string, kind: 'ok' | 'warn' | 'err' = 'ok'): void {
    const t: Toast = { id: this.toastSeq++, msg, kind };
    this.toasts = [...this.toasts, t];
    setTimeout(() => {
      this.toasts = this.toasts.filter((x) => x.id !== t.id);
      this.emit();
    }, 2800);
    this.emit();
  }

  confirmBox(cfg: ConfirmCfg): void {
    this.confirm = cfg;
    this.emit();
  }

  closeConfirm(): void {
    this.confirm = null;
    this.emit();
  }

  openModal(kind: string, arg?: string | null): void {
    this.modal = kind;
    this.modalArg = arg ?? null;
    if (kind !== 'log') { this.logFilterNode = null; this.logFilterGroup = null; }
    if (kind === 'log' && arg) {
      const n = this.nodeById(arg);
      if (n && n.type === 'dialog') this.logFilterNode = arg;
    }
    this.ctx = null;
    this.emit();
  }

  closeModal(): void {
    this.modal = null;
    this.modalArg = null;
    this.emit();
  }

  openCtx(cx: number, cy: number, items: CtxItem[]): void {
    // clamp к границам окна (меню ~230x320)
    const x = Math.min(cx, Math.max(10, window.innerWidth - 240));
    const y = Math.min(cy, Math.max(10, window.innerHeight - 330));
    this.ctx = { x, y, items };
    this.emit();
  }

  closeCtx(): void {
    if (!this.ctx) return;
    this.ctx = null;
    this.emit();
  }

  openDialogEditor(nodeId: string): void {
    this.dialogEdit = nodeId;
    this.ctx = null;
    this.emit();
  }

  closeDialogEditor(): void {
    this.dialogEdit = null;
    this.emit();
  }

  startRename(id: string): void {
    this.renameId = id;
    this.emit();
  }

  cancelRename(): void {
    this.renameId = null;
    this.emit();
  }

  requestCenter(id: string): void {
    this.centerReq = { id, t: Date.now() };
    this.emit();
  }

  requestFlash(nodeId: string, replyId: string | null): void {
    const n = this.nodeById(nodeId);
    if (n && replyId && n.expand === 0) n.expand = 1;
    this.flash = { nodeId, replyId, t: Date.now() };
    this.emit();
  }

  setLeftTab(t: 'pal' | 'list' | 'vars' | 'chars'): void {
    this.leftTab = t;
    this.emit();
  }

  setLeftWidth(w: number): void {
    this.leftWidth = clamp(w, 240, 560);
    try { window.localStorage.setItem('vetvi-left-w', String(this.leftWidth)); } catch { /* нет доступа */ }
    this.emit();
  }

  /* ── операции с нодами ── */

  addNodeAt(type: string, wx: number, wy: number): VetviNode {
    const n = newNode(type, snapVal(wx, this.snapOn), snapVal(wy, this.snapOn));
    this.mutate((doc) => { doc.nodes.push(n); }, { label: 'Создание ноды «' + (TYPES[type]?.name || type) + '»' });
    this.selectOnly(n.id);
    return n;
  }

  /** Добавление ноды без записи в историю (история пишется вызывающим commitEdit). */
  addNodeAtRaw(type: string, wx: number, wy: number): VetviNode | null {
    const n = newNode(type, Math.round(wx), Math.round(wy));
    this.doc.nodes.push(n);
    return n;
  }

  updateNode(id: string, patch: Partial<VetviNode>, opts?: { history?: boolean; label?: string }): void {
    this.mutate((doc) => {
      const n = doc.nodes.find((x) => x.id === id);
      if (n) Object.assign(n, patch);
    }, opts);
  }

  cycleStatus(id: string): void {
    const n = this.nodeById(id);
    if (!n) return;
    const order = ['idea', 'draft', 'done'];
    const i = order.indexOf(n.status);
    this.updateNode(id, { status: order[(i + 1) % 3] }, { label: 'Статус ноды «' + (n.title || '…') + '»' });
  }

  cycleExpand(id: string): void {
    const n = this.nodeById(id);
    if (!n) return;
    this.updateNode(id, { expand: n.expand === 0 ? 1 : n.expand === 1 ? 2 : 0 }, { history: false });
    this.scheduleSave();
    this.emit();
  }

  setDlgWidth(id: string, w: number): void {
    this.updateNode(id, { dlgWidth: clamp(Math.round(w), 216, 1200) }, { history: false });
  }

  /** Входящие перекидываются на исходящие (detachNode «Выдернуть»). */
  detachNode(id: string): void {
    this.mutate((doc) => {
      const ins = doc.edges.filter((e) => e.to === id && e.from !== id);
      const outs = doc.edges.filter((e) => e.from === id && e.to !== id);
      for (const e of doc.edges) {
        if (ins.includes(e)) {
          for (const o of outs) {
            const dup = doc.edges.some((x) => x.from === e.from && x.to === o.to && x.fromReply === e.fromReply);
            if (!dup && o.to !== e.from) doc.edges.push(newEdge(e.from, o.to, e.fromOut));
          }
        }
      }
      doc.edges = doc.edges.filter((e) => !ins.includes(e));
      doc.nodes = doc.nodes.filter((n) => n.id !== id);
    }, { label: 'Выдернуть ноду' });
    this.sel.delete(id);
    this.emit();
  }

  dragStartSnapshot: string | null = null;
  dragMoved = false;

  dragBegin(): void {
    this.dragStartSnapshot = this.serialize();
    this.dragMoved = false;
  }

  dragMoveBy(dx: number, dy: number): void {
    if (!dx && !dy) return;
    this.dragMoved = true;
    for (const id of this.sel) {
      const n = this.doc.nodes.find((x) => x.id === id);
      if (!n) continue;
      n.x += dx;
      n.y += dy;
    }
    this.emit();
  }

  dragEnd(): void {
    if (this.dragMoved && this.dragStartSnapshot) {
      const snap = this.dragStartSnapshot;
      this.dragStartSnapshot = null;
      this.dragMoved = false;
      if (this.snapOn) {
        for (const id of this.sel) {
          const n = this.doc.nodes.find((x) => x.id === id);
          if (!n) continue;
          n.x = snapVal(n.x, true);
          n.y = snapVal(n.y, true);
        }
      }
      this.flushPendingLog();
      this.pendingLog = { pre: snap, t: Date.now(), label: 'Перенос нод' };
      this.scheduleLogFlush();
      this.past.push(snap);
      if (this.past.length > HISTORY_LIMIT) this.past.shift();
      this.future.length = 0;
      this.scheduleSave();
      this.emit();
    } else {
      this.dragStartSnapshot = null;
      this.dragMoved = false;
    }
  }

  deleteSelected(): void {
    if (!this.sel.size && !this.selEdges.size && !this.selGroups.size) return;
    this.pushHistory('Удаление');
    const doc = this.doc;
    if (this.selEdges.size) {
      const eids = new Set(this.selEdges);
      doc.edges = doc.edges.filter((e) => !eids.has(e.id));
      this.selEdges.clear();
      this.scheduleSave();
      this.emit();
      return;
    }
    if (this.selGroups.size) {
      for (const gid of this.selGroups) this.dissolveGroupIn(doc, gid);
      this.selGroups.clear();
      this.pruneEmptyGroups(doc);
      this.scheduleSave();
      this.emit();
      return;
    }
    const ids = new Set(this.sel);
    doc.nodes = doc.nodes.filter((n) => !ids.has(n.id));
    doc.edges = doc.edges.filter((e) => !ids.has(e.from) && !ids.has(e.to));
    this.sel.clear();
    this.pruneEmptyGroups(doc);
    this.scheduleSave();
    this.emit();
  }

  private pruneEmptyGroups(doc: VetviDoc): void {
    let changed = true;
    while (changed) {
      changed = false;
      doc.groups = doc.groups.filter((g) => {
        const has = doc.nodes.some((n) => n.gid === g.id);
        const hasSub = doc.groups.some((x) => x.parent === g.id);
        if (!has && !hasSub) { changed = true; return false; }
        return true;
      });
    }
  }

  duplicateSelection(): { ids: string[]; pre: string } | null {
    if (!this.sel.size) return null;
    const pre = this.serialize();
    const ids: string[] = [];
    const map = new Map<string, string>();
    const src = this.doc.nodes.filter((n) => this.sel.has(n.id));
    const clones: VetviNode[] = [];
    for (const o of src) {
      const c = JSON.parse(JSON.stringify(o)) as VetviNode;
      c.id = uid();
      c.x = o.x + 32;
      c.y = o.y + 32;
      map.set(o.id, c.id);
      clones.push(c);
      ids.push(c.id);
    }
    const newEdges: VetviEdge[] = [];
    for (const e of this.doc.edges) {
      const f = map.get(e.from);
      const t = map.get(e.to);
      if (f && t) {
        const ne = JSON.parse(JSON.stringify(e)) as VetviEdge;
        ne.id = uid();
        ne.from = f;
        ne.to = t;
        newEdges.push(ne);
      }
    }
    this.mutate((doc) => {
      doc.nodes.push(...clones);
      doc.edges.push(...newEdges);
    }, { label: 'Дублирование (' + clones.length + ')' });
    this.sel = new Set(ids);
    this.selEdges.clear();
    this.selGroups.clear();
    this.emit();
    return { ids, pre };
  }

  alignH(): void {
    const ns = this.doc.nodes.filter((n) => this.sel.has(n.id));
    if (ns.length < 2) return;
    const y = Math.round(ns.reduce((s, n) => s + n.y, 0) / ns.length);
    this.mutate((doc) => {
      for (const n of doc.nodes) if (this.sel.has(n.id)) { n.y = y; n.x = snapVal(n.x, true); }
    }, { label: 'Выровнять в ряд' });
  }

  alignV(): void {
    const ns = this.doc.nodes.filter((n) => this.sel.has(n.id));
    if (ns.length < 2) return;
    const x = Math.round(ns.reduce((s, n) => s + n.x, 0) / ns.length);
    this.mutate((doc) => {
      for (const n of doc.nodes) if (this.sel.has(n.id)) { n.x = x; n.y = snapVal(n.y, true); }
    }, { label: 'Выровнять в столбец' });
  }

  /* ── связи ── */

  connectNodes(from: string, to: string, opts?: { fromOut?: string | null; fromReply?: string | null; tin?: string }): VetviEdge | null {
    if (from === to && !opts?.fromReply) return null;
    const dup = this.doc.edges.find(
      (e) => e.from === from && e.to === to &&
        (e.fromOut || null) === (opts?.fromOut || null) &&
        (e.fromReply || null) === (opts?.fromReply || null),
    );
    if (dup) { this.toast('Такая связь уже есть', 'warn'); return null; }
    const e = newEdge(from, to, opts?.fromOut || null);
    if (opts?.fromReply) e.fromReply = opts.fromReply;
    if (opts?.tin) e.tin = opts.tin;
    this.mutate((doc) => { doc.edges.push(e); }, { label: 'Новая связь' });
    this.selectEdgeOnly(e.id);
    return e;
  }

  updateEdge(id: string, patch: Partial<VetviEdge>, opts?: { history?: boolean; label?: string }): void {
    this.mutate((doc) => {
      const e = doc.edges.find((x) => x.id === id);
      if (e) Object.assign(e, patch);
    }, opts);
  }

  deleteEdge(id: string): void {
    this.mutate((doc) => {
      doc.edges = doc.edges.filter((e) => e.id !== id);
      this.selEdges.delete(id);
    }, { label: 'Удаление связи' });
  }

  reverseEdge(id: string): void {
    this.mutate((doc) => {
      const e = doc.edges.find((x) => x.id === id);
      if (!e) return;
      const f = e.from;
      e.from = e.to;
      e.to = f;
      e.fromReply = null;
      e.fromOut = null;
      if (e.tin) delete e.tin;
    }, { label: 'Разворот связи' });
  }

  resetEdgePts(id: string): void {
    this.updateEdge(id, { pts: [] }, { label: 'Сброс изгибов' });
  }

  addWaypoint(id: string, x: number, y: number): void {
    this.mutate((doc) => {
      const e = doc.edges.find((x2) => x2.id === id);
      if (!e) return;
      if (!Array.isArray(e.pts)) e.pts = [];
      // точка вставляется в ближайший сегмент (упрощение: по индексу из компонента)
      e.pts.push({ x: Math.round(x), y: Math.round(y) });
    }, { label: 'Изгиб связи' });
  }

  insertWaypoint(id: string, index: number, x: number, y: number): void {
    this.mutate((doc) => {
      const e = doc.edges.find((x2) => x2.id === id);
      if (!e) return;
      if (!Array.isArray(e.pts)) e.pts = [];
      e.pts.splice(clamp(index, 0, e.pts.length), 0, { x: Math.round(x), y: Math.round(y) });
    }, { label: 'Изгиб связи' });
  }

  moveWaypointLive(id: string, index: number, x: number, y: number): void {
    const e = this.doc.edges.find((x2) => x2.id === id);
    if (!e || !Array.isArray(e.pts) || !e.pts[index]) return;
    e.pts[index] = { x: Math.round(x), y: Math.round(y) };
    this.emit();
  }

  deleteWaypoint(id: string, index: number): void {
    this.mutate((doc) => {
      const e = doc.edges.find((x2) => x2.id === id);
      if (!e || !Array.isArray(e.pts)) return;
      e.pts.splice(index, 1);
    }, { label: 'Удаление изгиба' });
  }

  setEdgeLabel(id: string, label: string, opts?: { history?: boolean }): void {
    this.updateEdge(id, { label: label || null }, { history: opts?.history !== false, label: 'Подпись связи' });
  }

  setEdgeCond(id: string, cond: { vid: string; op: string; val: number | string } | null): void {
    this.updateEdge(id, { cond }, { label: cond ? 'Условие связи' : 'Сброс условия связи' });
  }

  setEdgeKind(id: string, kind: string): void {
    this.updateEdge(id, { kind }, { label: 'Тип связи' });
  }

  /** Создание моста между двумя нодами (createBridgeBetween). */
  createBridge(aId: string, bId: string): void {
    const a = this.nodeById(aId);
    const b = this.nodeById(bId);
    if (!a || !b) return;
    let from = aId;
    let to = bId;
    const aOut = this.doc.edges.some((e) => e.from === aId);
    const bIn = this.doc.edges.some((e) => e.to === bId);
    if (aOut && !bIn) { /* a→b */ }
    else if (!aOut) { /* a→b */ }
    else { from = bId; to = aId; }
    const e = newEdge(from, to);
    e.kind = 'bridge';
    e.bd = { dl: 0, dy: 0, dr: 0 };
    this.mutate((doc) => { doc.edges.push(e); }, { label: 'Создание моста' });
    this.selectEdgeOnly(e.id);
  }

  bridgeDragLive(id: string, dl: number, dy: number, dr: number): void {
    const e = this.doc.edges.find((x) => x.id === id);
    if (!e) return;
    e.bd = { dl: Math.round(dl), dy: Math.round(dy), dr: Math.round(dr) };
    this.emit();
  }

  bridgeDragEnd(pre: string): void {
    this.commitEdit(pre, 'Правка моста');
  }

  /** Нож: удаление связей, пересекаемых линией. */
  knifeCut(line: { x1: number; y1: number; x2: number; y2: number }, sampleFn: (e: VetviEdge) => { x: number; y: number }[] | null): number {
    const pre = this.serialize();
    const victims: string[] = [];
    const l1 = { x: line.x1, y: line.y1 };
    const l2 = { x: line.x2, y: line.y2 };
    for (const e of this.doc.edges) {
      const pts = sampleFn(e);
      if (!pts) continue;
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i];
        const b = pts[i + 1];
        const d1x = l2.x - l1.x;
        const d1y = l2.y - l1.y;
        const d2x = b.x - a.x;
        const d2y = b.y - a.y;
        const denom = d1x * d2y - d1y * d2x;
        if (Math.abs(denom) < 1e-9) continue;
        const t = ((a.x - l1.x) * d2y - (a.y - l1.y) * d2x) / denom;
        const u = ((a.x - l1.x) * d1y - (a.y - l1.y) * d1x) / denom;
        if (t >= 0 && t <= 1 && u >= 0 && u <= 1) { victims.push(e.id); break; }
      }
    }
    if (victims.length) {
      this.doc.edges = this.doc.edges.filter((e) => !victims.includes(e.id));
      this.commitEdit(pre, 'Нож: разрез стрелок');
      this.toast('Разрезано связей: ' + victims.length, 'ok');
    }
    return victims.length;
  }

  /** Разрез одиночного клика ножа по связи. */
  knifeSingleEdge(id: string): void {
    this.deleteEdge(id);
    this.toast('Связь удалена', 'ok');
  }

  /* ── реплики диалога ── */

  addReply(nodeId: string, afterId?: string | null, asChild?: boolean): void {
    this.mutate((doc) => {
      const n = doc.nodes.find((x) => x.id === nodeId);
      if (!n || n.type !== 'dialog' || !n.dialog) return;
      if (!Array.isArray(n.dialog.replies)) n.dialog.replies = [];
      const ps = Array.isArray(n.dialog.participants) ? n.dialog.participants : [];
    const sp = ps[0] || null;
      const r = newReply('', sp);
      if (!afterId && !asChild) { n.dialog.replies.push(r); return; }
      const attach = (arr: VetviReply[]): boolean => {
        if (!Array.isArray(arr)) return false;
        for (let i = 0; i < arr.length; i++) {
          const cur = arr[i];
          if (cur && cur.id === afterId) {
            if (asChild) {
              if (!Array.isArray(cur.children)) cur.children = [];
              cur.children.push(r);
            } else {
              arr.splice(i + 1, 0, r);
            }
            return true;
          }
          if (cur && cur.children && attach(cur.children)) return true;
        }
        return false;
      };
      if (!attach(n.dialog.replies)) n.dialog.replies.push(r);
    }, { label: 'Новая реплика' });
  }

  updateReply(nodeId: string, rid: string, patch: Partial<VetviReply>, opts?: { history?: boolean; label?: string }): void {
    this.mutate((doc) => {
      const n = doc.nodes.find((x) => x.id === nodeId);
      if (!n || !n.dialog) return;
      const walk = (arr: VetviReply[]): boolean => {
        for (const r of arr) {
          if (r.id === rid) { Object.assign(r, patch); return true; }
          if (r.children && walk(r.children)) return true;
        }
        return false;
      };
      walk(n.dialog.replies || []);
    }, opts);
  }

  beginReplyEdit(nodeId: string, rid: string): string | null {
    const n = this.nodeById(nodeId);
    if (!n || !n.dialog) return null;
    this.replyEditPre = this.serialize();
    return this.replyEditPre;
  }
  replyEditPre: string | null = null;

  commitReplyEdit(pre: string | null): void {
    this.commitEdit(pre, 'Правка реплик');
    this.replyEditPre = null;
  }

  deleteReply(nodeId: string, rid: string): void {
    this.mutate((doc) => {
      const n = doc.nodes.find((x) => x.id === nodeId);
      if (!n || !n.dialog) return;
      const walk = (arr: VetviReply[]): boolean => {
        const i = arr.findIndex((r) => r.id === rid);
        if (i >= 0) { arr.splice(i, 1); return true; }
        for (const r of arr) if (r.children && walk(r.children)) return true;
        return false;
      };
      walk(n.dialog.replies || []);
      doc.edges = doc.edges.filter((e) => e.fromReply !== rid);
    }, { label: 'Удаление реплики' });
  }

  moveReply(nodeId: string, rid: string, dir: -1 | 1): void {
    this.mutate((doc) => {
      const n = doc.nodes.find((x) => x.id === nodeId);
      if (!n || !n.dialog) return;
      const arr = n.dialog.replies;
      const i = arr.findIndex((r) => r.id === rid);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= arr.length) return;
      const tmp = arr[i];
      arr[i] = arr[j];
      arr[j] = tmp;
    }, { label: 'Порядок реплик' });
  }

  setDlgLinear(nodeId: string, on: boolean): void {
    this.updateNode(nodeId, { linear: on }, { label: on ? 'Проигрывание подряд: вкл' : 'Проигрывание подряд: выкл' });
  }

  setParticipants(nodeId: string, pids: string[]): void {
    this.mutate((doc) => {
      const n = doc.nodes.find((x) => x.id === nodeId);
      if (!n || !n.dialog) return;
      n.dialog.participants = pids;
    }, { label: 'Участники диалога' });
  }

  /* ── исходы развилки и кнопки действия ── */

  addOutcome(nodeId: string): void {
    this.mutate((doc) => {
      const n = doc.nodes.find((x) => x.id === nodeId);
      if (!n || n.type !== 'branch') return;
      if (!Array.isArray(n.outcomes)) n.outcomes = [];
      if (n.outcomes.length >= 24) return;
      n.outcomes.push({ id: uid(), label: '', cond: null });
    }, { label: 'Новый исход' });
  }

  updateOutcome(nodeId: string, oid: string, patch: Partial<VetviOutcome>, opts?: { history?: boolean }): void {
    this.mutate((doc) => {
      const n = doc.nodes.find((x) => x.id === nodeId);
      if (!n || !Array.isArray(n.outcomes)) return;
      const o = n.outcomes.find((x) => x.id === oid);
      if (o) Object.assign(o, patch);
    }, opts);
  }

  deleteOutcome(nodeId: string, oid: string): void {
    this.mutate((doc) => {
      const n = doc.nodes.find((x) => x.id === nodeId);
      if (!n || !Array.isArray(n.outcomes)) return;
      n.outcomes = n.outcomes.filter((o) => o.id !== oid);
      doc.edges = doc.edges.filter((e) => !(e.from === nodeId && e.fromOut === oid));
    }, { label: 'Удаление исхода' });
  }

  moveOutcome(nodeId: string, oid: string, dir: -1 | 1): void {
    this.mutate((doc) => {
      const n = doc.nodes.find((x) => x.id === nodeId);
      if (!n || !Array.isArray(n.outcomes)) return;
      const arr = n.outcomes;
      const i = arr.findIndex((o) => o.id === oid);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= arr.length) return;
      const tmp = arr[i];
      arr[i] = arr[j];
      arr[j] = tmp;
    }, { history: false });
    this.scheduleSave();
    this.emit();
  }

  addAction(nodeId: string): void {
    this.mutate((doc) => {
      const n = doc.nodes.find((x) => x.id === nodeId);
      if (!n || n.type !== 'action') return;
      if (!Array.isArray(n.actions)) n.actions = [];
      n.actions.push({ id: uid(), label: 'Действие' });
    }, { label: 'Новая кнопка действия' });
  }

  updateAction(nodeId: string, aid: string, patch: { label?: string }, opts?: { history?: boolean }): void {
    this.mutate((doc) => {
      const n = doc.nodes.find((x) => x.id === nodeId);
      if (!n || !Array.isArray(n.actions)) return;
      const a = n.actions.find((x) => (x as { id: string }).id === aid);
      if (a) Object.assign(a, patch);
    }, opts);
  }

  deleteAction(nodeId: string, aid: string): void {
    this.mutate((doc) => {
      const n = doc.nodes.find((x) => x.id === nodeId);
      if (!n || !Array.isArray(n.actions)) return;
      n.actions = n.actions.filter((a) => (a as { id: string }).id !== aid);
      doc.edges = doc.edges.filter((e) => !(e.from === nodeId && e.fromOut === aid));
    }, { label: 'Удаление кнопки' });
  }

  /* ── переменные ── */

  addVar(): VetviVar {
    const v: VetviVar = {
      id: 'v' + Date.now().toString(36) + Math.floor(Math.random() * 10000).toString(36),
      name: 'переменная',
      type: 'num',
      val: 0,
    };
    this.mutate((doc) => {
      if (!Array.isArray(doc.vars)) doc.vars = [];
      doc.vars.push(v);
    }, { label: 'Новая переменная' });
    return v;
  }

  updateVar(id: string, patch: Partial<VetviVar>, opts?: { history?: boolean; label?: string }): void {
    this.mutate((doc) => {
      const v = (doc.vars || []).find((x) => x.id === id);
      if (!v) return;
      const wasType = varType(v);
      Object.assign(v, patch);
      if (patch.type && patch.type !== wasType) v.val = varCastVal(varType(v), v.val);
    }, opts);
  }

  deleteVar(id: string): void {
    this.mutate((doc) => {
      doc.vars = (doc.vars || []).filter((v) => v.id !== id);
      cleanupVarRefs(doc, id);
    }, { label: 'Удаление переменной' });
    this.toast('Переменная удалена (привязки очищены)', 'warn');
  }

  /* ── персонажи ── */

  addChar(): VetviChar {
    const colors = ['#e2a54e', '#9cb878', '#7fb5a2', '#c9857a', '#cbbd92', '#d6c96a', '#aab1bb'];
    const c: VetviChar = {
      id: 'c' + Date.now().toString(36) + Math.floor(Math.random() * 10000).toString(36),
      name: 'Персонаж',
      color: colors[Math.floor(Math.random() * colors.length)],
      text: '',
      av: null,
      avShape: 'circle',
    };
    this.mutate((doc) => {
      if (!Array.isArray(doc.chars)) doc.chars = [];
      doc.chars.push(c);
    }, { label: 'Создание персонажа' });
    return c;
  }

  updateChar(id: string, patch: Partial<VetviChar>, opts?: { history?: boolean; label?: string }): void {
    this.mutate((doc) => {
      const c = (doc.chars || []).find((x) => x.id === id);
      if (c) Object.assign(c, patch);
    }, opts);
  }

  deleteChar(id: string): void {
    this.mutate((doc) => {
      doc.chars = (doc.chars || []).filter((c) => c.id !== id);
      for (const n of doc.nodes) {
        if (n.dialog) {
          n.dialog.participants = (n.dialog.participants || []).filter((p) => p !== id);
          const walk = (arr: VetviReply[]) => {
            for (const r of arr) {
              if (r.speaker === id) r.speaker = null;
              if (r.children) walk(r.children);
            }
          };
          walk(n.dialog.replies || []);
        }
        if (Array.isArray(n.participants)) n.participants = (n.participants as string[]).filter((p) => p !== id);
      }
    }, { label: 'Удаление персонажа' });
    this.toast('Персонаж удалён', 'warn');
  }

  charById(id: string | null | undefined): VetviChar | null {
    if (!id) return null;
    return (this.doc.chars || []).find((c) => c.id === id) || null;
  }

  charName(id: string | null | undefined): string {
    const c = this.charById(id);
    if (c) return c.name || '(без имени)';
    const n = id ? this.nodeById(id) : null;
    return n ? (n.title || '(без имени)') : '(неизвестный)';
  }

  charColor(id: string | null | undefined): string {
    const c = this.charById(id);
    if (c && c.color) return c.color;
    const n = id ? this.nodeById(id) : null;
    if (n && n.color) return n.color;
    return '#8b929c';
  }

  /** Разбить диалог на цепочку нод по репликам верхнего уровня (splitDialogNode). */
  splitDialogNode(id: string, deep: boolean): void {
    const n = this.nodeById(id);
    if (!n || n.type !== 'dialog' || !n.dialog) return;
    const flat: VetviReply[] = deep ? this.flatReplies(n.dialog.replies) : n.dialog.replies.filter((r) => !!r);
    if (flat.length < 2) return;
    const pre = this.serialize();
    const created: string[] = [];
    let prevId: string | null = null;
    for (let i = 0; i < flat.length; i++) {
      const r = flat[i];
      const c = JSON.parse(JSON.stringify(n)) as VetviNode;
      c.id = uid();
      c.x = n.x + i * 260;
      c.y = n.y;
      c.dialog = { participants: n.dialog.participants.slice(), description: i === 0 ? n.dialog.description : '', replies: [{ ...r, children: undefined }] };
      c.expand = 1;
      this.doc.nodes.push(c);
      created.push(c.id);
      if (prevId) this.doc.edges.push(newEdge(prevId, c.id));
      prevId = c.id;
    }
    // входящие на первую копию, исходящие с последней
    for (const e of this.doc.edges.slice()) {
      if (e.to === id) e.to = created[0];
      if (e.from === id) { e.from = created[created.length - 1]; e.fromReply = null; e.fromOut = null; }
    }
    this.doc.nodes = this.doc.nodes.filter((x) => x.id !== id);
    this.doc.edges = this.doc.edges.filter((e) => e.from !== id && e.to !== id);
    this.commitEdit(pre, 'Разбивка диалога на реплики');
    this.toast('Диалог разбит на ' + created.length + ' нод', 'ok');
  }

  private flatReplies(arr: VetviReply[], out?: VetviReply[]): VetviReply[] {
    const o = out || [];
    for (const r of arr) {
      o.push({ ...r, children: undefined });
      if (r.children && r.children.length) this.flatReplies(r.children, o);
    }
    return o;
  }

  /** Объединить выделенные диалоги в один (mergeDialogNodes). */
  mergeDialogNodes(): void {
    const ids = [...this.sel].filter((id) => this.nodeById(id)?.type === 'dialog');
    if (ids.length < 2) return;
    const pre = this.serialize();
    const keep = this.nodeById(ids[0]) as VetviNode;
    const created: string[] = [];
    for (let i = 1; i < ids.length; i++) {
      const m = this.nodeById(ids[i]);
      if (!m || !m.dialog || !keep.dialog) continue;
      keep.dialog.replies = (keep.dialog.replies || []).concat(m.dialog.replies || []);
      keep.dialog.participants = Array.from(new Set([...(keep.dialog.participants || []), ...(m.dialog.participants || [])]));
      for (const e of this.doc.edges.slice()) {
        if (e.to === m.id) e.to = keep.id;
        if (e.from === m.id) { e.from = keep.id; e.fromReply = null; e.fromOut = null; }
      }
      created.push(m.id);
    }
    this.doc.nodes = this.doc.nodes.filter((x) => !created.includes(x.id));
    this.doc.edges = this.doc.edges.filter((e) => !created.includes(e.from) && !created.includes(e.to));
    this.commitEdit(pre, 'Объединение диалогов');
    this.toast('Диалогы объединены: ' + (created.length + 1), 'ok');
  }

  /* ── группы ── */

  groupById(id: string): VetviGroup | undefined {
    return this.doc.groups.find((g) => g.id === id);
  }

  membersOf(gid: string): VetviNode[] {
    return this.doc.nodes.filter((n) => n.gid === gid);
  }

  childGroups(gid: string | null): VetviGroup[] {
    return this.doc.groups.filter((g) => (g.parent || null) === (gid || null));
  }

  createGroupFromSel(name: string): string | null {
    if (this.sel.size + this.selGroups.size < 2) {
      this.toast('Выделите минимум два объекта', 'warn');
      return null;
    }
    const pre = this.serialize();
    const g: VetviGroup = {
      id: uid(),
      name: name || 'Группа',
      x: 0,
      y: 0,
      color: null,
      fold: 2,
      alpha: 0.55,
      badge: null,
      parent: null,
      auto: true,
    };
    const doc = this.doc;
    // выделенные группы верхнего уровня становятся вложенными
    const selGroups = new Set(this.selGroups);
    for (const gid of selGroups) {
      const sg = this.groupById(gid);
      if (sg) sg.parent = g.id;
    }
    // ноды вне выделенных групп получают gid
    const covered = new Set<string>();
    for (const gid of selGroups) {
      for (const n of this.membersOf(gid)) covered.add(n.id);
    }
    for (const n of doc.nodes) {
      if (this.sel.has(n.id) || covered.has(n.id)) n.gid = g.id;
    }
    this.doc.groups.push(g);
    // позиция: средняя по нодам
    const ms = this.membersOf(g.id);
    if (ms.length) {
      g.x = Math.min(...ms.map((n) => n.x)) - 26;
      g.y = Math.min(...ms.map((n) => n.y)) - 40;
    }
    this.commitEdit(pre, 'Создание группы');
    this.selGroups = new Set([g.id]);
    this.sel.clear();
    this.selEdges.clear();
    this.emit();
    return g.id;
  }

  /** Группа, нарисованная рамкой (createDrawnGroup): захват нод по центру. */
  createDrawnGroup(rect: { x: number; y: number; w: number; h: number }): string {
    const g: VetviGroup = {
      id: uid(),
      name: 'Группа',
      x: snapVal(rect.x, this.snapOn),
      y: snapVal(rect.y, this.snapOn),
      color: null,
      fold: 2,
      alpha: 0.55,
      badge: null,
      parent: null,
      auto: true,
      fw: Math.max(220, Math.round(rect.w)),
      fh: Math.max(150, Math.round(rect.h)),
    };
    this.mutate((doc) => {
      doc.groups.push(g);
      for (const n of doc.nodes) {
        const cx = n.x + nodeWidth(n) / 2;
        const cy = n.y + nodeHeight(n) / 2;
        if (cx >= rect.x && cx <= rect.x + rect.w && cy >= rect.y && cy <= rect.y + rect.h) n.gid = g.id;
      }
      // группы, целиком покрытые рамкой
      for (const sg of doc.groups) {
        if (sg.id === g.id || sg.parent) continue;
        const ms = doc.nodes.filter((n) => n.gid === sg.id);
        if (!ms.length) continue;
        const sx = Math.min(...ms.map((n) => n.x)) - 20;
        const sy = Math.min(...ms.map((n) => n.y)) - 34;
        const ex = Math.max(...ms.map((n) => n.x + nodeWidth(n))) + 20;
        const ey = Math.max(...ms.map((n) => n.y + nodeHeight(n))) + 20;
        if (sx >= rect.x - 4 && sy >= rect.y - 4 && ex <= rect.x + rect.w + 4 && ey <= rect.y + rect.h + 4) sg.parent = g.id;
      }
    }, { label: 'Создание группы (рамкой)' });
    this.toast('Группа создана', 'ok');
    return g.id;
  }

  updateGroup(id: string, patch: Partial<VetviGroup>, opts?: { history?: boolean; label?: string }): void {
    this.mutate((doc) => {
      const g = doc.groups.find((x) => x.id === id);
      if (g) Object.assign(g, patch);
    }, opts);
  }

  dissolveGroupIn(doc: VetviDoc, gid: string): void {
    const g = doc.groups.find((x) => x.id === gid);
    if (!g) return;
    const parent = g.parent || null;
    if (g.stack && g.order) {
      // цепочка: раскладываем ноды вертикально
      const nodes = (g.order || []).map((id) => doc.nodes.find((n) => n.id === id)).filter(Boolean) as VetviNode[];
      let y = g.y;
      for (const n of nodes) {
        n.x = g.x;
        n.y = y;
        y += 130;
        n.gid = parent;
      }
      doc.edges = doc.edges.filter((e) => !e.q);
    }
    for (const n of doc.nodes) if (n.gid === gid) n.gid = parent;
    for (const sg of doc.groups) if (sg.parent === gid) sg.parent = parent;
    doc.groups = doc.groups.filter((x) => x.id !== gid);
  }

  dissolveGroup(gid: string): void {
    this.mutate((doc) => { this.dissolveGroupIn(doc, gid); }, { label: 'Роспуск группы' });
  }

  leaveGroup(nodeId: string): void {
    const n = this.nodeById(nodeId);
    if (!n || !n.gid) return;
    this.mutate((doc) => {
      const g = doc.groups.find((x) => x.id === n.gid);
      n.gid = null;
      if (g && g.stack && g.order) {
        doc.edges = doc.edges.filter((e) => !e.q);
      }
    }, { label: 'Покинуть группу' });
    this.pruneEmptyGroups(this.doc);
    this.emit();
  }

  /** После переноса: захват нод/групп под прямоугольником (reparentAfterMove). */
  reparentAfterMove(): void {
    if (!this.selGroups.size) return;
    const doc = this.doc;
    let changed = false;
    for (const gid of this.selGroups) {
      const g = doc.groups.find((x) => x.id === gid);
      if (!g || g.stack) continue;
      const ms = doc.nodes.filter((n) => n.gid === gid);
      if (!ms.length) continue;
      const x = Math.min(...ms.map((n) => n.x)) - 20;
      const y = Math.min(...ms.map((n) => n.y)) - 34;
      const w = Math.max(...ms.map((n) => n.x + nodeWidth(n))) + 20 - x;
      const h = Math.max(...ms.map((n) => n.y + nodeHeight(n))) + 20 - y;
      // группа под центром
      const cx = x + w / 2;
      const cy = y + h / 2;
      const target = doc.groups.find((tgt) => {
        if (tgt.id === gid || tgt.stack) return false;
        if (this.isGroupAncestor(tgt.id, gid)) return false;
        const tm = doc.nodes.filter((n) => n.gid === tgt.id);
        if (!tm.length) return false;
        const tx = Math.min(...tm.map((n) => n.x)) - 20;
        const ty = Math.min(...tm.map((n) => n.y)) - 34;
        const tw = Math.max(...tm.map((n) => n.x + nodeWidth(n))) + 20 - tx;
        const th = Math.max(...tm.map((n) => n.y + nodeHeight(n))) + 20 - ty;
        return cx >= tx && cx <= tx + tw && cy >= ty && cy <= ty + th;
      });
      const newParent = target ? target.id : null;
      if ((g.parent || null) !== newParent) {
        g.parent = newParent;
        changed = true;
      }
    }
    if (changed) { this.scheduleSave(); this.emit(); }
  }

  private isGroupAncestor(maybeAncestor: string, ofGroup: string): boolean {
    let cur: string | null = ofGroup;
    const seen = new Set<string>();
    while (cur) {
      if (seen.has(cur)) return false;
      seen.add(cur);
      if (cur === maybeAncestor) return true;
      const g = this.groupById(cur);
      cur = g?.parent || null;
    }
    return false;
  }

  /* ── вид ── */

  setViewport(vp: Partial<VetviViewport>): void {
    if (typeof vp.x === 'number') this.vp.x = vp.x;
    if (typeof vp.y === 'number') this.vp.y = vp.y;
    if (typeof vp.z === 'number') this.vp.z = clampZoom(vp.z);
    this.scheduleSave();
    this.emit();
  }

  zoomAt(screenX: number, screenY: number, factor: number): void {
    const z0 = this.vp.z;
    const z1 = clampZoom(z0 * factor);
    if (z1 === z0) return;
    const w = screenToWorld(this.vp, screenX, screenY);
    this.vp.z = z1;
    this.vp.x = screenX - w.x * z1;
    this.vp.y = screenY - w.y * z1;
    this.scheduleSave();
    this.emit();
  }

  panBy(dx: number, dy: number): void {
    this.vp.x += dx;
    this.vp.y += dy;
    this.emit();
  }

  panEnd(): void {
    this.scheduleSave();
    this.emit();
  }

  fitView(vw: number, vh: number, sizes: Map<string, NodeSize>): void {
    const b = docBounds(this.doc, sizes);
    if (!b) {
      this.setViewport({ x: 0, y: 0, z: 1 });
      return;
    }
    const pad = 70;
    const z = clampZoom(Math.min((vw - pad * 2) / Math.max(b.w, 1), (vh - pad * 2) / Math.max(b.h, 1)));
    this.vp.z = z;
    this.vp.x = vw / 2 - (b.x + b.w / 2) * z;
    this.vp.y = vh / 2 - (b.y + b.h / 2) * z;
    this.scheduleSave();
    this.emit();
  }

  toggleSnap(): void { this.snapOn = !this.snapOn; this.emit(); }
  toggleGrid(): void { this.gridOn = !this.gridOn; this.emit(); }
  setBend(m: BendMode): void {
    this.bend = m;
    this.pushHistory('Режим связей: ' + m);
    this.scheduleSave();
    this.emit();
  }

  /* ── проекты ── */

  setProjectName(name: string): void {
    this.mutateManual((doc) => { doc.meta.name = name; }, 'Переименование проекта');
  }

  openProject(id: string): void {
    const slot = projReadSlot(id);
    if (!slot) {
      const left = projList().filter((e) => e.id !== id);
      this.toast('Данные проекта не найдены — запись убрана из списка', 'warn');
      this.emit();
      if (left.length) { this.openProject(left[0].id); }
      return;
    }
    this.flushSave();
    this.doc = slot.doc;
    this.vp = slot.vp;
    this.bend = slot.bend as BendMode;
    this.sel.clear();
    this.selEdges.clear();
    this.selGroups.clear();
    this.past = [];
    this.future = [];
    projSetCur(id);
    this.toast('Открыт проект: ' + (this.doc.meta.name || 'Без названия'), 'ok');
    this.emit();
  }

  createProject(): void {
    this.flushSave();
    const now = Date.now();
    const pid = uid() + uid();
    const n = newNode('scene', 0, 0);
    const doc: VetviDoc = {
      meta: { name: 'Новый проект', created: now, modified: now, projectId: pid, actionLog: [], editLog: [] },
      nodes: [n],
      edges: [],
      groups: [],
      vars: [],
      chars: [],
      customTypes: [],
      palette: [],
      listHidden: {},
    };
    this.doc = doc;
    this.vp = defaultViewport();
    this.bend = 'smooth';
    this.sel.clear();
    this.selEdges.clear();
    this.selGroups.clear();
    this.past = [];
    this.future = [];
    this.selectOnly(n.id);
    this.persist();
    this.toast('Создан новый проект — предыдущий сохранён в списке', 'ok');
    this.emit();
  }

  deleteProject(id: string): void {
    const list = projDelete(id);
    if (id === this.doc.meta.projectId) {
      if (list.length) this.openProject(list[0].id);
      else { this.createProject(); return; }
    }
    this.emit();
  }

  renameProject(id: string, name: string): void {
    if (id === this.doc.meta.projectId) {
      this.setProjectName(name);
      return;
    }
    import('@/vetvi/core/projects').then((m) => {
      m.projRename(id, name);
      this.emit();
    });
  }

  saveAs(): void {
    const name = (this.doc.meta.name || 'проект').replace(/[^\w\u0400-\u04ff]+/g, '_').slice(0, 60) || 'проект';
    import('@/vetvi/core/projects').then((m) => {
      m.downloadJson(name + '.vetvi.json', JSON.parse(this.serialize()));
      this.logManual('Сохранение проекта в JSON');
    });
  }

  exportSelection(): void {
    if (!this.sel.size) return;
    const ids = new Set(this.sel);
    const nodes = this.doc.nodes.filter((n) => ids.has(n.id));
    const edges = this.doc.edges.filter((e) => ids.has(e.from) && ids.has(e.to));
    import('@/vetvi/core/projects').then((m) => {
      m.downloadJson('vetvi-nodes.json', {
        app: 'vetvi-export',
        version: 1,
        nodes,
        edges,
        groups: this.doc.groups.filter((g) => ids.has(g.id)),
      });
      this.logManual('Экспорт выделенных нод');
    });
  }

  importProject(parsed: unknown, filename?: string): void {
    const doc = docFromParsed(parsed);
    if (!doc.nodes.length && !doc.edges.length) {
      this.toast('Файл не похож на проект Ветвей', 'err');
      return;
    }
    this.flushSave();
    if (filename) doc.meta.name = filename.replace(/\.json$/i, '').slice(0, 80);
    const pid = uid() + uid();
    doc.meta.projectId = pid;
    this.doc = doc;
    this.vp = defaultViewport();
    this.sel.clear();
    this.selEdges.clear();
    this.selGroups.clear();
    this.past = [];
    this.future = [];
    this.persist();
    this.logManual('Импорт текстов из JSON');
    this.toast('Проект импортирован: ' + (doc.meta.name || 'Без названия'), 'ok');
    this.emit();
  }

  /* ── перенос дубликата (carry) ── */

  startCarry(ids: string[], pre: string): void {
    this.carry = { ids, pre };
    this.emit();
  }

  placeCarry(x: number, y: number): void {
    const ids = this.carry?.ids || [];
    this.carry = null;
    const dx = x - this.centerOf(ids).x;
    const dy = y - this.centerOf(ids).y;
    for (const id of ids) {
      const n = this.nodeById(id);
      if (!n) continue;
      n.x = snapVal(n.x + dx, this.snapOn);
      n.y = snapVal(n.y + dy, this.snapOn);
    }
    this.commitEdit(this.carryPre, 'Размещение дубликата');
    this.emit();
  }
  carryPre: string | null = null;

  cancelCarry(): void {
    if (!this.carry) return;
    const snap = this.carry.pre;
    this.carry = null;
    this.doc = docFromParsed(JSON.parse(snap));
    this.emit();
  }

  private centerOf(ids: string[]): { x: number; y: number } {
    const ns = ids.map((id) => this.nodeById(id)).filter(Boolean) as VetviNode[];
    if (!ns.length) return { x: 0, y: 0 };
    return {
      x: ns.reduce((s, n) => s + n.x, 0) / ns.length,
      y: ns.reduce((s, n) => s + n.y, 0) / ns.length,
    };
  }

  /* ── setter-методы для UI (мутации только здесь) ── */

  playerStart: { nodeId: string; only: boolean } | null = null;

  setPlayerStart(nodeId: string | null, only: boolean): void {
    this.playerStart = nodeId ? { nodeId, only } : null;
    this.emit();
  }

  setLogFilters(node: string | null, group: string | null): void {
    this.logFilterNode = node;
    this.logFilterGroup = group;
    this.emit();
  }

  setMarqueeSel(nodes: string[], groups: string[]): void {
    this.sel = new Set(nodes);
    this.selGroups = new Set(groups);
    this.emit();
  }

  finishGestureDrag(): void {
    this.dragStartSnapshot = null;
    this.dragMoved = false;
  }

  pointerFn: (() => string | null) | null = null;

  registerPointerFn(fn: () => string | null): void {
    this.pointerFn = fn;
  }

  pointerNodeId(): string | null {
    return this.pointerFn ? this.pointerFn() : null;
  }

  /* ── вспомогательное ── */

  nodeById(id: string): VetviNode | undefined {
    return this.doc.nodes.find((n) => n.id === id);
  }

  edgeById(id: string): VetviEdge | undefined {
    return this.doc.edges.find((e) => e.id === id);
  }

  nodeSize(id: string, sizes: Map<string, NodeSize>): { w: number; h: number } {
    const n = this.nodeById(id);
    const s = sizes.get(id);
    if (!n) return { w: 0, h: 0 };
    return { w: nodeWidth(n, s), h: nodeHeight(n, s) };
  }

  /** Проект из хеша при старте (#project=<id>). */
  applyHashProject(): boolean {
    const m = /project=([A-Za-z0-9_-]+)/.exec(window.location.hash || '');
    if (m && projReadSlot(m[1])) {
      this.openProject(m[1]);
      return true;
    }
    return false;
  }

  setVarDefaultOnVarNode(n: VetviNode): void {
    if (n.type !== 'varnode') return;
    const v = (this.doc.vars || []).find((x) => x.id === n.vid);
    if (v && n.varVal === undefined) n.varVal = defValOf(v);
  }
}

/** Хуки доступа к стору (единственный экземпляр на вкладку). */
let singleton: VetviStore | null = null;

export function getStore(): VetviStore {
  if (!singleton) singleton = new VetviStore();
  return singleton;
}

/** Мягкий сброс стора при переключении проектов через хеш. */
export function resetStore(): void {
  singleton = null;
}

export { projSlotKey, stItem, stRemoveItem, stSetItem };
