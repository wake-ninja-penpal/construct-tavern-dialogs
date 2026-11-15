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

import { AUTOSAVE_MS, GRID, HISTORY_LIMIT, NODE_W, TYPES } from '@/vetvi/core/constants';
import { buildTxtExport, slugOf } from '@/vetvi/core/exportTxt';
import { buildTextsPayload, textsImpParse, type ImpData } from '@/vetvi/core/textsjson';
import {
  stackableType,
  stackChainEdgeObj,
  stackDetachEdges,
  stackOrderIds,
  stackParkPos,
  stackRebuildChains,
  stackSyncParks,
} from '@/vetvi/core/chains';
import { docFromParsed, loadAutosave, saveAutosave, serializeDoc } from '@/vetvi/core/doc';
import { dlgMaxDepth, findReply } from '@/vetvi/core/dialog';
import { isBridge, splitPtsAtHalf } from '@/vetvi/core/insert';
import { defaultDoc, defaultViewport, ensureDialog, newEdge, newReply, newNode, snapVal, uid } from '@/vetvi/core/factory';
import { clamp, clampZoom, docBounds, nodeHeight, nodeWidth, screenToWorld } from '@/vetvi/core/geometry';
import { pathPoint } from '@/vetvi/core/edgepath';
import { getMe, setMeName, type MeIdentity } from '@/vetvi/core/identity';
import { logDiff, logDiffSummary, type LogDiff } from '@/vetvi/core/logdiff';
import { passVerify } from '@/vetvi/core/passlock';
import { downloadFile, projDelete, projList, projMigrateLegacy, projReadSlot, projSaveCurrent, projSetCur, projSkipSaveId, projSlotKey } from '@/vetvi/core/projects';
import { stItem, stRemoveItem, stSetItem } from '@/vetvi/core/storage';
import type { EdgeGeom, NodeSize, VetviChar, VetviDoc, VetviEdge, VetviGroup, VetviMeta, VetviNode, VetviOutcome, VetviReply, VetviVar, VetviViewport } from '@/vetvi/core/types';
import { cleanupVarRefs, defValOf, VARS_OPS, varCastVal, varType } from '@/vetvi/core/vars';
import { collapsedAncestorOf, groupCardRect, groupDepth, groupFrameRect } from './ggroups';
import { canvasApi } from './canvasApi';
import type { SyncClient } from './sync';

type Listener = () => void;

export type SaveState = 'idle' | 'pending' | 'saved';
export type BendMode = 'smooth' | 'ortho90' | 'ortho45';

export interface CtxItem { label?: string; head?: string; sep?: boolean; danger?: boolean; dot?: string; fn?: () => void }
export interface Toast { id: number; msg: string; kind: 'ok' | 'warn' | 'err' }
export interface ConfirmBtn { label: string; primary?: boolean; danger?: boolean; fn?: () => void }
export interface ConfirmCfg { title: string; text?: string; buttons?: ConfirmBtn[]; wide?: boolean }

/** Цель анимации сдвига (animateShift оригинала): нода и её позиции from→to. */
export interface ShiftTarget {
  n: VetviNode;
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
}

/** Запись своих типов (customTypes оригинала). */
export interface CustomTypeRec { id: string; name: string; color: string; icon: string }

export interface LogEntry {
  id: string;
  t: number;
  by: { id: string; name: string; color: string };
  act: string;
  diff: LogDiff | null;
  snap?: string | null;
}

/**
 * Личность редактора (editIdentity оригинала, 2850): в комнате совместного доступа —
 * участник синхронизации (имя/цвет, под которым его видят другие), локально — «вы».
 */
export function editIdentity(inRoom = false): MeIdentity {
  if (inRoom) return getMe();
  return { id: 'вы', name: 'вы', color: '#8b929c' };
}

export function renameMe(name: string): MeIdentity {
  return setMeName(name);
}

/** Схлопывание подряд идущих записей об одном редакторе (collapseEditLog оригинала). */
function collapseEditLog(log: Record<string, unknown>[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const e of log || []) {
    const p = out[out.length - 1] as { id?: string; name?: string } | undefined;
    const c = e as { id?: string; name?: string };
    if (p && ((p.id && p.id === c.id) || (p.name && p.name === c.name))) continue;
    out.push(e);
    if (out.length >= 6) break;
  }
  return out;
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

  /* ── импорт текстов (окно 2-шаговое: окно → сверка) ── */
  /** Сохранённый текст после ошибки парсинга (keep в openTextsImport оригинала). */
  textsKeep: string | null = null;
  /** Распознанные данные импорта — показывают второй шаг (textsImpStep2). */
  textsImp: ImpData | null = null;
  /** Имя файла импорта (если импорт из файла, а не из textarea). */
  textsImpFname: string | null = null;

  /* ── совместное редактирование (заполняет SyncClient) ── */
  syncStatus: 'off' | 'conn' | 'on' | 'err' | 'lost' | 'copy' = 'off';
  syncMode: 'local' | 'room' | 'copy' = 'local';
  syncRoom: string | null = null;
  syncUsers: { id: string; name: string; color: string; cur?: string | null }[] = [];
  syncMergeCount = 0;
  syncLocks: Record<string, { id: string; name: string; color: string }> = {};
  syncBusyFlag = false;
  syncFocus: Record<string, string> = {};
  syncJoinPass: string | null = null;
  syncProjPass: string | null = null;
  lockUnlocked = false;
  lockPendingCb: (() => void) | null = null;
  lockTip: { x: number; y: number; by: { id: string; name: string; color: string } | null } | null = null;
  /** Показан попап участников комнаты. */
  collabPop = false;

  /** Клиент realtime-коллаборации (подключается в VetviApp). */
  sync: SyncClient | null = null;
  /** Активная группа/канвасный жест: при блокировке чужим локом откатываем его. */
  gestureRollback: (() => void) | null = null;
  /** Идёт анимация автораздвижки (animateShift): удалённые снимки комнаты ждут, как при жесте. */
  busyAnim = false;

  setSyncClient(c: SyncClient | null): void {
    this.sync = c;
    this.emit();
  }

  /** Откат активного жеста при проигранной гонке локов (замыкание ставит холст). */
  setGestureRollback(fn: (() => void) | null): void {
    this.gestureRollback = fn;
  }

  revision = 0;
  saveState: SaveState = 'idle';
  lastSavedAt = 0;

  /** Последняя позиция курсора (lastPtr оригинала) — для showLockTip вне жестов. */
  lastPtr: { x: number; y: number } = { x: 0, y: 0 };

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

  /** Личность для журналов: в комнате — мой профиль, локально — «вы». */
  private identity(): MeIdentity {
    const inRoom = !!(this.sync && this.sync.enabled && this.syncMode !== 'copy');
    return editIdentity(inRoom);
  }

  /**
   * Кто и когда последним менял проект (noteEditor оригинала, 2857–2871):
   * meta.editLog — последние редакторы (переносится с документом комнаты),
   * meta.lastEditBy — последний. Вызывается из mutate/commitEdit/… как markDirty оригинала.
   */
  noteEditor(): void {
    try {
      const me = this.identity();
      const now = Date.now();
      this.doc.meta.modified = now;
      const log = Array.isArray(this.doc.meta.editLog)
        ? (this.doc.meta.editLog as Record<string, unknown>[]).slice()
        : [];
      const first = log[0] as { id?: string; name?: string; color?: string; at?: number } | undefined;
      /* тот же человек (по id или имени) — обновить верхнюю запись, а не добавлять новую */
      if (first && (first.id === me.id || (me.name && first.name === me.name))) {
        first.id = me.id;
        first.name = me.name;
        first.color = me.color;
        first.at = now;
      } else {
        log.unshift({ id: me.id, name: me.name, color: me.color, at: now });
      }
      this.doc.meta.editLog = collapseEditLog(log);
      this.doc.meta.lastEditBy = { id: me.id, name: me.name, color: me.color, at: now };
    } catch { /* журнал — необязательное поле */ }
  }

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
      by: this.identity(),
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
    this.logActionEntry({ id: uid() + uid(), t: Date.now(), by: this.identity(), act, diff: null, snap: null });
  }

  logUndoRedo(pre: string, word: string): void {
    const cur = this.serialize();
    if (pre === cur) return;
    const diff = logDiff(pre, cur);
    this.logActionEntry({
      id: uid() + uid(),
      t: Date.now(),
      by: this.identity(),
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

  /** pushHistory(s,label) оригинала: снимок уже посчитан вызывающим (performInsert). */
  private pushHistoryPre(pre: string, label?: string | null): void {
    this.flushPendingLog();
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
    this.noteEditor();
    this.scheduleSave();
    this.emit();
  }

  scheduleSave(): void {
    if (this.saveT) clearTimeout(this.saveT);
    this.saveState = 'pending';
    if (this.sync) this.sync.queueState();
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
    if (this.syncMode === 'copy' && this.sync) this.sync.persistCopyTick();
  }

  /** Мутация с записью в историю. fn меняет this.doc напрямую. */
  mutate(fn: (doc: VetviDoc) => void, opts?: { history?: boolean; label?: string }): void {
    if (!opts || opts.history !== false) this.pushHistory(opts?.label);
    fn(this.doc);
    this.noteEditor();
    this.scheduleSave();
    this.emit();
  }

  /** Одноразовое «ручное» действие без diff (переименование проекта и т.п.). */
  mutateManual(fn: (doc: VetviDoc) => void, act: string, debounceMs = 900): void {
    this.flushPendingLog();
    fn(this.doc);
    this.noteEditor();
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
    this.noteEditor();
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
    this.noteEditor();
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
    this.noteEditor();
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
    if (this.sync) this.sync.flushState(false);
    this.emit();
  }

  /* ── выделение ── */

  selectOnly(id: string): void {
    this.sel.clear();
    this.selEdges.clear();
    this.selGroups.clear();
    this.sel.add(id);
    this.emit();
    if (this.sync) this.sync.focusTrack(id);
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
    if (this.sync) this.sync.focusTrack(nodeId);
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
    /* addNode оригинала (6480): заголовок из typeInfo — у своего типа это его имя */
    if (!TYPES[type]) n.title = this.typeInfoOf(type).name;
    this.mutate((doc) => { doc.nodes.push(n); }, { label: 'Создание ноды «' + (this.typeInfoOf(type).name || type) + '»' });
    this.selectOnly(n.id);
    return n;
  }

  /** Добавление ноды без записи в историю (история пишется вызывающим commitEdit). */
  addNodeAtRaw(type: string, wx: number, wy: number): VetviNode | null {
    const n = newNode(type, Math.round(wx), Math.round(wy));
    if (!TYPES[type]) n.title = this.typeInfoOf(type).name;
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
    const n = this.nodeById(id);
    if (n && this.sync) this.sync.liveDlg(n);
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
    if (this.sync) this.sync.liveDrag({ ids: this.sel });
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
    if (this.sync) this.sync.livePts(e);
  }

  /** Старые снимки: ноды «Персонаж» → записи списка персонажей (migrateCharNodesInPlace). */
  migrateCharNodesInPlace(): void {
    const legacy = this.doc.nodes.filter((n) => n.type === 'char');
    if (!legacy.length) return;
    if (!Array.isArray(this.doc.chars)) this.doc.chars = [];
    const have: Record<string, number> = {};
    this.doc.chars.forEach((c) => { have[c.id] = 1; });
    legacy.forEach((n) => {
      if (have[n.id]) return;
      this.doc.chars!.push({
        id: n.id,
        name: String(n.title || 'Персонаж').slice(0, 60),
        color: (typeof n.color === 'string' && /^#([0-9a-f]{6})$/i.test(n.color)) ? n.color : '#9cb878',
        text: String(n.text || '').slice(0, 500),
      });
    });
    const ids = new Set(legacy.map((n) => n.id));
    this.doc.nodes = this.doc.nodes.filter((n) => n.type !== 'char');
    this.doc.edges = this.doc.edges.filter((e) => !ids.has(e.from) && !ids.has(e.to));
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

  /* ═══ встраивание в связь, автораздвижка (порт 7596–7709, 6488–6503 оригинала) ═══ */

  dimsFn: ((id: string) => { w: number; h: number } | null) | null = null;

  /** Колбэк измеренных размеров карточек (dims оригинала через nodeEls) — регистрирует CanvasBoard. */
  registerDimsFn(fn: (id: string) => { w: number; h: number } | null): void {
    this.dimsFn = fn;
  }

  edgeGeomFn: ((edgeId: string) => EdgeGeom | null) | null = null;

  /** Колбэк геометрии связи (edgeGeom оригинала) — регистрирует CanvasBoard из items EdgeLayer. */
  registerEdgeGeomFn(fn: ((edgeId: string) => EdgeGeom | null) | null): void {
    this.edgeGeomFn = fn;
  }

  /** Размер карточки для расчётов (dims оригинала): измеренный или дефолт NODE_W/90. */
  private dimsOf(id: string): { w: number; h: number } {
    const m = this.dimsFn ? this.dimsFn(id) : null;
    return m ? { w: m.w, h: m.h } : { w: NODE_W, h: 90 };
  }

  /**
   * Встраивание ноды/клона в середину связи (performInsert оригинала, 7614–7632):
   * история с готовым снимком pre, исходная связь удаляется, добавляются две новые
   * (A→n с pts[0] и fromReply исхода, label:''; n→B с pts[1], label исходной,
   * lt:0.5, lp:0), нода позиционируется в точке дропа (или середине пути),
   * выделение связи снимается, затем автораздвижка с фиксированной новой нодой.
   */
  performInsert(n: VetviNode, edgeId: string, pre: string, isNew: boolean, pt?: { x: number; y: number } | null, g?: EdgeGeom | null): void {
    const doc = this.doc;
    const e = doc.edges.find((x) => x.id === edgeId);
    if (!e) return;
    this.pushHistoryPre(pre, 'Создание и подключение ноды');
    const geom = g || (this.edgeGeomFn ? this.edgeGeomFn(edgeId) : null);
    /* запасная геометрия свободных нод (edgeAnchors оригинала), если items её не дали */
    let gm = geom;
    if (!gm) {
      const na = doc.nodes.find((x) => x.id === e.from);
      const nb = doc.nodes.find((x) => x.id === e.to);
      if (na && nb) {
        const da = this.dimsOf(na.id);
        const db = this.dimsOf(nb.id);
        gm = { x1: na.x + da.w, y1: na.y + da.h / 2, x2: nb.x, y2: nb.y + db.h / 2, pts: (e.pts && e.pts.length ? e.pts : null) };
      }
    }
    const sp = splitPtsAtHalf(e, gm);
    const p = pt || (gm ? pathPoint(gm, 0.5) : null);
    const A = e.from;
    const B = e.to;
    const kind = e.kind || 'flow';
    const label = e.label || '';
    const fromReplyA = e.fromReply || null;
    doc.edges = doc.edges.filter((x) => x.id !== e.id);
    if (isNew) doc.nodes.push(n);
    const d0 = isNew ? null : this.dimsOf(n.id);
    const hh = d0 ? d0.h : 96;
    if (p) {
      n.x = Math.round(p.x - (d0 ? d0.w : NODE_W) / 2);
      n.y = Math.round(p.y - hh / 2);
    }
    doc.edges.push({ id: uid(), from: A, to: n.id, label: '', kind, pts: sp[0] || [], lt: 0.5, lp: 0, fromReply: fromReplyA, fromOut: null, bd: { dl: 0, dy: 0, dr: 0 } });
    doc.edges.push({ id: uid(), from: n.id, to: B, label, kind, pts: sp[1] || [], lt: 0.5, lp: 0, fromReply: null, fromOut: null, bd: { dl: 0, dy: 0, dr: 0 } });
    if (this.selEdges.has(e.id)) this.selEdges.clear();
    this.emit();
    this.resolveOverlaps(new Set([n.id]));
    this.scheduleSave();
    this.emit();
  }

  /**
   * Создание ноды типа typeKey сразу встроенной в связь (insertNewAtEdge
   * оригинала, 7633–7641): фабрика newNode (ensureDialog + varnode-дефолты),
   * performInsert, toast «Элемент встроен в связь».
   */
  insertNewAtEdge(edgeId: string, typeKey: string, pt?: { x: number; y: number } | null, g?: EdgeGeom | null): void {
    const e = this.edgeById(edgeId);
    if (!e) return;
    const pre = this.serialize();
    const n = newNode(typeKey, 0, 0);
    this.performInsert(n, edgeId, pre, true, pt || null, g);
    this.toast('Элемент встроен в связь');
  }

  /**
   * Копия одной ноды (cloneNode оригинала, 6488–6503): глубокая, новый id,
   * gid сброшен, позиция округлена; varnode/branch — с валидацией полей.
   */
  cloneNodeAt(src: VetviNode, x: number, y: number): VetviNode {
    const c = JSON.parse(JSON.stringify(src)) as VetviNode;
    c.id = uid();
    c.gid = null;
    c.x = Math.round(x);
    c.y = Math.round(y);
    c.expand = (src.expand === 0 || src.expand === 1 || src.expand === 2) ? src.expand : 1;
    c.color = src.color || null;
    c.tint = src.tint || 0;
    c.dlgWidth = src.dlgWidth || null;
    c.notes = src.notes ? (JSON.parse(JSON.stringify(src.notes)) as NonNullable<VetviNode['notes']>) : [];
    if (src.linear !== true) delete c.linear;
    if (src.type === 'varnode') {
      c.vid = src.vid || null;
      c.varMode = src.varMode === 'get' ? 'get' : 'set';
      c.varOp = VARS_OPS[src.varOp || '='] ? src.varOp : '=';
      c.varVal = src.varVal;
    }
    if (src.type === 'branch' && Array.isArray(src.outcomes)) {
      c.outcomes = (src.outcomes as VetviOutcome[]).map((o) => ({
        id: o.id,
        label: o.label || '',
        cond: o.cond ? { vid: o.cond.vid, op: o.cond.op, val: o.cond.val } : null,
      }));
    }
    return c;
  }

  /** Группа спрятана внутри свёрнутой (groupInsideCollapsed оригинала, 3028–3035). */
  private groupInsideCollapsed(g: VetviGroup): boolean {
    let cur = g.parent || null;
    const seen = new Set<string>();
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      const p = this.groupById(cur);
      if (!p) return false;
      if ((p.fold === undefined ? 2 : p.fold) < 2) return true;
      cur = p.parent || null;
    }
    return false;
  }

  /**
   * Глубочайшая группа в мировой точке (deepestGroupAt оригинала, 3064–3076):
   * fold=2 — по рамке, fold<2 — по карточке; размеры — измеренные (sizes/cardSizes
   * из CanvasBoard, в оригинале offsetWidth/offsetHeight элементов).
   */
  deepestGroupAt(wx: number, wy: number, sizes: Map<string, NodeSize>, cardSizes: Map<string, { w: number; h: number }>): VetviGroup | null {
    let best: VetviGroup | null = null;
    let bestDepth = -1;
    for (const g of this.doc.groups) {
      if (this.groupInsideCollapsed(g)) continue;
      const fold = g.fold === undefined ? 2 : g.fold;
      let r: { x: number; y: number; w: number; h: number };
      if (fold === 2) r = groupFrameRect(this.doc, g, sizes, cardSizes);
      else {
        const cr = groupCardRect(this.doc, g, cardSizes);
        r = { x: g.x || 0, y: g.y || 0, w: cr.w, h: cr.h };
      }
      if (wx >= r.x && wx <= r.x + r.w && wy >= r.y && wy <= r.y + r.h) {
        const d = groupDepth(this.doc, g.id);
        if (d > bestDepth) { bestDepth = d; best = g; }
      }
    }
    return best;
  }

  /**
   * Бросок из палитры НА ноду (attachNewTo оригинала, 9177–9199): новая нода или
   * клон справа от цели (nx=+NODE_W+70, snap), gid — глубочайшая группа в точке
   * (если цель не внутри свёрнутой), связь target→n, автораздвижка, выделение.
   */
  attachNewTo(targetId: string, typeKey: string | null, cloneId: string | null, sizes: Map<string, NodeSize>, cardSizes: Map<string, { w: number; h: number }>): void {
    const target = this.nodeById(targetId);
    if (!target) return;
    const nx = snapVal(target.x + NODE_W + 70, this.snapOn);
    const ny = snapVal(target.y, this.snapOn);
    let n: VetviNode;
    if (cloneId) {
      const src = this.nodeById(cloneId);
      if (!src) return;
      n = this.cloneNodeAt(src, nx, ny);
    } else {
      n = newNode(typeKey || 'note', nx, ny);
    }
    const tgtGroup = collapsedAncestorOf(this.doc, target.id) ? null : this.deepestGroupAt(target.x + NODE_W / 2, target.y + 40, sizes, cardSizes);
    n.gid = tgtGroup ? tgtGroup.id : null;
    const eid = uid();
    this.mutate((doc) => {
      doc.nodes.push(n);
      doc.edges.push({ id: eid, from: target.id, to: n.id, label: '', kind: 'flow', pts: [], lt: 0.5, lp: 0, fromReply: null, fromOut: null, bd: { dl: 0, dy: 0, dr: 0 } });
    });
    this.resolveOverlaps(new Set([n.id]));
    this.selectOnly(n.id);
  }

  /**
   * Автораздвижка наезжающих карточек (resolveOverlaps оригинала, 7642–7691):
   * pad=18, до 60 итераций, ноды внутри свёрнутых групп не участвуют, разводим
   * по горизонтали (ox<=oy) или вертикали, fixed-ноды стоят на месте, snap
   * не-fixed, затем анимация сдвига от старых позиций к новым.
   */
  resolveOverlaps(fixedIds: Set<string>): void {
    const pad = 18;
    const doc = this.doc;
    const dims = (n: VetviNode) => this.dimsOf(n.id);
    const oldPos = new Map<string, { x: number; y: number }>();
    for (const n of doc.nodes) oldPos.set(n.id, { x: n.x, y: n.y });
    /* ноды внутри свёрнутых групп не участвуют (collapsedAncestorOf оригинала) —
       считаем один раз, чтобы не искать предков на каждую пару */
    const collapsed = new Set<string>();
    for (const n of doc.nodes) {
      if (collapsedAncestorOf(doc, n.id)) collapsed.add(n.id);
    }
    let changed = false;
    for (let it = 0; it < 60; it++) {
      let moved = false;
      for (let i = 0; i < doc.nodes.length; i++) {
        if (collapsed.has(doc.nodes[i].id)) continue;
        for (let j = i + 1; j < doc.nodes.length; j++) {
          if (collapsed.has(doc.nodes[j].id)) continue;
          const a = doc.nodes[i];
          const b = doc.nodes[j];
          const da = dims(a);
          const db = dims(b);
          const acx = a.x + da.w / 2;
          const acy = a.y + da.h / 2;
          const bcx = b.x + db.w / 2;
          const bcy = b.y + db.h / 2;
          const ox = (da.w + db.w) / 2 + pad - Math.abs(acx - bcx);
          const oy = (da.h + db.h) / 2 + pad - Math.abs(acy - bcy);
          if (ox > 0 && oy > 0) {
            moved = true;
            changed = true;
            const fx = fixedIds.has(a.id);
            const fy = fixedIds.has(b.id);
            if (ox <= oy) {
              const ax = acx <= bcx ? -1 : 1;
              if (fx && !fy) b.x -= ax * ox;
              else if (fy && !fx) a.x += ax * ox;
              else { a.x += ax * ox / 2; b.x -= ax * ox / 2; }
            } else {
              const ay = acy <= bcy ? -1 : 1;
              if (fx && !fy) b.y -= ay * oy;
              else if (fy && !fx) a.y += ay * oy;
              else { a.y += ay * oy / 2; b.y -= ay * oy / 2; }
            }
          }
        }
      }
      if (!moved) break;
    }
    if (!changed) return;
    if (this.snapOn) {
      for (const n of doc.nodes) {
        if (!fixedIds.has(n.id)) { n.x = snapVal(n.x, true); n.y = snapVal(n.y, true); }
      }
    }
    const targets: ShiftTarget[] = [];
    for (const n of doc.nodes) {
      const o = oldPos.get(n.id) as { x: number; y: number };
      if (o.x !== n.x || o.y !== n.y) {
        targets.push({ n, fromX: o.x, fromY: o.y, toX: n.x, toY: n.y });
        n.x = o.x;
        n.y = o.y;
      }
    }
    if (targets.length) this.animateShift(targets);
    /* refreshGroupFrames() оригинала не нужен: рамки групп пересчитываются декларативно по emit() */
  }

  /**
   * Анимация сдвига (animateShift оригинала, 7692–7708): rAF 340ms, ease-out
   * cubic (e2=1-(1-k)^3), позиции нод обновляются в doc напрямую + emit() каждый
   * кадр (React перерисовывает ноды/связи/рамки по doc — updateEdgesFor не нужен).
   * На время анимации busyAnim=true: удалённые снимки комнаты не врываются.
   */
  animateShift(targets: ShiftTarget[]): void {
    const t0 = performance.now();
    const dur = 340;
    this.busyAnim = true;
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / dur);
      const e2 = 1 - Math.pow(1 - k, 3);
      for (const g of targets) {
        g.n.x = g.fromX + (g.toX - g.fromX) * e2;
        g.n.y = g.fromY + (g.toY - g.fromY) * e2;
      }
      this.emit();
      if (k < 1) {
        requestAnimationFrame(step);
      } else {
        this.busyAnim = false;
        this.scheduleSave();
        this.emit();
      }
    };
    requestAnimationFrame(step);
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

  /** Разбить диалог на цепочку нод по репликам (splitDialogNode, 7463–7563).
   *  Если нода внутри цепочки — созданные реплики входят в неё на место исходной. */
  splitDialogNode(id: string, deep: boolean): void {
    const n = this.nodeById(id);
    if (!n || n.type !== 'dialog' || !n.dialog) return;
    const flat: VetviReply[] = deep ? this.flatReplies(n.dialog.replies) : n.dialog.replies.filter((r) => !!r);
    if (flat.length < 2) return;
    const pre = this.serialize();
    /* нода в цепочке: запоминаем группу и позицию для якорения созданных нод (7472–7473) */
    const gS = this.stackGroupOf(n);
    const kS = gS ? stackOrderIds(this.doc, gS).indexOf(id) : -1;
    const created: string[] = [];
    let prevId: string | null = null;
    for (let i = 0; i < flat.length; i++) {
      const r = flat[i];
      const c = JSON.parse(JSON.stringify(n)) as VetviNode;
      c.id = uid();
      c.gid = null;
      c.x = n.x + i * 260;
      c.y = n.y;
      c.dialog = { participants: n.dialog.participants.slice(), description: i === 0 ? n.dialog.description : '', replies: [{ ...r, children: undefined }] };
      c.expand = 1;
      this.doc.nodes.push(c);
      created.push(c.id);
      if (prevId && !gS) this.doc.edges.push(stackChainEdgeObj(prevId, c.id));
      prevId = c.id;
    }
    // входящие на первую копию, исходящие с последней
    for (const e of this.doc.edges.slice()) {
      if (e.to === id) e.to = created[0];
      if (e.from === id) { e.from = created[created.length - 1]; e.fromReply = null; e.fromOut = null; }
    }
    this.doc.nodes = this.doc.nodes.filter((x) => x.id !== id);
    this.doc.edges = this.doc.edges.filter((e) => e.from !== id && e.to !== id);
    if (gS) {
      /* созданные ноды занимают место исходной в цепочке (7501–7507) */
      const newOrder = stackOrderIds(this.doc, gS).filter((x) => x !== id);
      newOrder.splice(Math.max(0, kS), 0, ...created);
      gS.order = newOrder;
      for (const cid of created) {
        const cn = this.nodeById(cid);
        if (cn) cn.gid = gS.id;
      }
      stackRebuildChains(this.doc, gS);
    }
    this.commitEdit(pre, 'Разбивка диалога на реплики');
    this.toast('Диалог разбит на ' + created.length + ' нод' + (gS ? ' (внутри цепочки)' : ''), 'ok');
  }

  private flatReplies(arr: VetviReply[], out?: VetviReply[]): VetviReply[] {
    const o = out || [];
    for (const r of arr) {
      o.push({ ...r, children: undefined });
      if (r.children && r.children.length) this.flatReplies(r.children, o);
    }
    return o;
  }

  /** Объединить выделенные диалоги в один (mergeDialogNodes, 7564+). */
  mergeDialogNodes(): void {
    const ids = [...this.sel].filter((id) => this.nodeById(id)?.type === 'dialog');
    if (ids.length < 2) return;
    /* ноды внутри цепочки объединять нельзя (7568) */
    for (const nid of ids) {
      const nn = this.nodeById(nid);
      if (nn && this.stackGroupOf(nn)) {
        this.toast('Ноды внутри цепочки объединять нельзя — сначала выведите их (✕ на строке цепочки)', 'warn');
        return;
      }
    }
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

  /* ═══ цепочки нод (стек-карточки): порт 7022–7462, 7839–7945 оригинала ═══ */

  /** Группа-цепочка ноды (stackGroupOf, 7180). */
  stackGroupOf(n: VetviNode): VetviGroup | null {
    const g = n.gid ? this.groupById(n.gid) : undefined;
    return g && g.stack === true ? g : null;
  }

  /** Лок, мешающий правке (lockBlockedBy оригинала). */
  lockBlockedBy(ids: string[] | Set<string>): { id: string; name: string; color: string } | null {
    return this.sync ? this.sync.blockedBy(ids) : null;
  }

  /** Все выделенные — stackable-ноды вне цепочек (selAllStackable, 7453). */
  selAllStackable(): boolean {
    if (this.sel.size < 2 || this.selGroups.size) return false;
    for (const id of this.sel) {
      const n = this.nodeById(id);
      if (!n || !stackableType(n.type) || this.stackGroupOf(n)) return false;
    }
    return true;
  }

  /**
   * Добавить ноду в конец цепочки без записи в историю (stackAppend, 7209–7218):
   * старые связи убираются, нода встаёт в свой парк-слот, связи «кто за кем»
   * перестраиваются. Историю пишет жест переноса (как в оригинале).
   */
  stackAppend(g: VetviGroup, nid: string): boolean {
    const ids = stackOrderIds(this.doc, g);
    if (ids.indexOf(nid) >= 0) return false;
    stackDetachEdges(this.doc, nid);
    g.order = ids.concat([nid]);
    const n = this.nodeById(nid);
    if (n) {
      n.gid = g.id;
      const pk = stackParkPos(g, ids.length);
      n.x = pk.x;
      n.y = pk.y;
    }
    stackRebuildChains(this.doc, g);
    return true;
  }

  /**
   * Сброс перетащенной ноды на свободную ноду/члена цепочки
   * (stackDropCreate, 7239–7266): в существующую цепочку — в конец,
   * иначе создаётся новая цепочка из пары. История — снимок pre жеста.
   */
  stackDropCreate(dragId: string, targetId: string, pre: string): boolean {
    const A = this.nodeById(dragId);
    const T = this.nodeById(targetId);
    if (!A || !T) return false;
    const sg = this.stackGroupOf(T);
    this.pushHistoryPre(pre, 'Сборка цепочки');
    const doc = this.doc;
    if (sg) {
      const ids = stackOrderIds(doc, sg);
      /* нода попадает в цепочку: старые связи убираются, новая — по порядку цепочки */
      stackDetachEdges(doc, dragId);
      sg.order = ids.concat([dragId]);
      A.gid = sg.id;
      const pk = stackParkPos(sg, ids.length);
      A.x = pk.x;
      A.y = pk.y;
      stackRebuildChains(doc, sg);
      this.scheduleSave();
      this.emit();
      this.toast('«' + A.title + '» добавлена в цепочку «' + sg.name + '» (позиция ' + (ids.length + 1) + ') — старые связи убраны, добавлена связь от предыдущей ноды');
      return true;
    }
    const g: VetviGroup = {
      id: uid(),
      name: 'Цепочка',
      fold: 1,
      x: Math.round(T.x),
      y: Math.round(T.y),
      parent: T.gid || null,
      color: null,
      alpha: 0.55,
      badge: null,
      auto: false,
      stack: true,
      order: [T.id, dragId],
    };
    stackDetachEdges(doc, dragId);
    doc.groups.push(g);
    T.gid = g.id;
    A.gid = g.id;
    const pk2 = stackParkPos(g, 1);
    A.x = pk2.x;
    A.y = pk2.y;
    stackRebuildChains(doc, g);
    this.sel.clear();
    this.selEdges.clear();
    this.selGroups = new Set([g.id]);
    this.scheduleSave();
    this.emit();
    this.toast('Объединены в цепочку: «' + T.title + '» → «' + A.title + '» — стандартная связь по порядку, старые связи «' + A.title + '» убраны. Порядок меняется перетаскиванием строк');
    return true;
  }

  /** ✕ на строке цепочки (stackRowAction, 7267–7271): проверка локов → leaveGroup. */
  stackRowAction(gid: string, nid: string): void {
    const g = this.groupById(gid);
    if (!g || g.stack !== true) return;
    const lk = this.lockBlockedBy(stackOrderIds(this.doc, g));
    if (lk) {
      this.showLockTip(this.lastPtr.x, this.lastPtr.y, lk);
      return;
    }
    this.leaveGroup(nid);
  }

  /** Перестановка строк цепочки (qRowApply, 7346–7362). */
  reorderStackRows(gid: string, nid: string, insIdx: number | null): void {
    const g = this.groupById(gid);
    if (!g || g.stack !== true) return;
    const lk = this.lockBlockedBy(stackOrderIds(this.doc, g));
    if (lk) {
      this.showLockTip(this.lastPtr.x, this.lastPtr.y, lk);
      return;
    }
    const ids = stackOrderIds(this.doc, g);
    const from = ids.indexOf(nid);
    if (from < 0) return;
    const rest = ids.filter((x) => x !== nid);
    let idx = insIdx == null || insIdx < 0 ? rest.length : insIdx;
    if (idx > rest.length) idx = rest.length;
    const newOrder = rest.slice(0, idx).concat([nid], rest.slice(idx));
    if (newOrder.join('\u0001') === ids.join('\u0001')) return;
    this.pushHistory('Перестановка строк цепочки');
    g.order = newOrder;
    stackRebuildChains(this.doc, g);
    stackSyncParks(this.doc, g);
    this.scheduleSave();
    this.emit();
    this.toast('Порядок цепочки изменён — связи «кто за кем» перестроены');
  }

  /**
   * Вывод ноды из цепочки перетаскиванием (qExtractRow, 7364–7389): связь с
   * соседями склеивается, нода ложится в точку отпускания, пустая цепочка
   * удаляется. wp — мировая точка, client — экранные координаты для lock-подсказки.
   */
  extractStackRow(gid: string, nid: string, wp: { x: number; y: number }, client?: { x: number; y: number }): void {
    const g = this.groupById(gid);
    if (!g || g.stack !== true) return;
    const n = this.nodeById(nid);
    if (!n) return;
    const order0 = stackOrderIds(this.doc, g);
    const idx = order0.indexOf(nid);
    if (idx < 0) return;
    const lk = this.lockBlockedBy(order0);
    if (lk) {
      this.showLockTip(client ? client.x : this.lastPtr.x, client ? client.y : this.lastPtr.y, lk);
      return;
    }
    const prev = idx > 0 ? order0[idx - 1] : null;
    const next = idx >= 0 && idx < order0.length - 1 ? order0[idx + 1] : null;
    this.pushHistory('Вывод из цепочки');
    const doc = this.doc;
    doc.edges = doc.edges.filter((ed) => !(ed.q && (ed.from === nid || ed.to === nid)));
    n.gid = g.parent || null;
    g.order = order0.filter((x) => x !== nid);
    if (prev && next && !doc.edges.some((ed) => ed.from === prev && ed.to === next && ed.tin !== 'var')) {
      doc.edges.push(stackChainEdgeObj(prev, next));
    }
    /* ширина карточки диалога (dlgNodeWidth оригинала): своя ширина + отступы вложенности */
    const w0 = n.type === 'dialog'
      ? ((n.dlgWidth || NODE_W) + dlgMaxDepth((n.dialog && n.dialog.replies) || [], 0) * 23)
      : NODE_W;
    n.x = Math.round(wp.x - w0 / 2);
    n.y = Math.round(wp.y - 24);
    this.resolveOverlaps(new Set([nid]));
    if (!g.order.length) {
      doc.groups = doc.groups.filter((x) => x.id !== gid);
      this.selGroups.delete(gid);
    }
    this.scheduleSave();
    this.emit();
    this.toast('Нода выведена из цепочки — связи с соседями склеены');
  }

  /**
   * Цепочка → группа (stackToGroup, 7025–7052): ноды возвращаются на холст
   * колонкой в порядке цепочки (вторая фаза — по реальным высотам после
   * перерисовки), группа открывается рамкой с авторазмером.
   */
  stackToGroup(gid: string): void {
    const g = this.groupById(gid);
    if (!g || g.stack !== true) return;
    const ids = stackOrderIds(this.doc, g);
    if (!ids.length) {
      this.toast('Цепочка пуста', 'warn');
      return;
    }
    const lk = this.lockBlockedBy(ids);
    if (lk) {
      this.showLockTip(this.lastPtr.x, this.lastPtr.y, lk);
      return;
    }
    const pre = this.serialize();
    this.pushHistoryPre(pre, 'Цепочка → группа');
    const gx = g.x || 0;
    const gy = g.y || 0;
    g.stack = false;
    g.order = [];
    g.fold = 2;
    const gr = g as unknown as Record<string, unknown>;
    gr.bbox = null;
    gr.hh = null;
    g.auto = true;
    delete g.fx;
    delete g.fy;
    delete g.fw;
    delete g.fh;
    ids.forEach((id, i) => {
      const n = this.nodeById(id);
      if (!n) return;
      n.x = Math.round(gx);
      n.y = Math.round(gy + i * 130);
    });
    this.scheduleSave();
    this.emit(); /* ноды видимы — можно измерить реальные высоты (renderAll, 7041) */
    setTimeout(() => {
      /* вторая фаза: колонка по реальным высотам (7042–7048) */
      let yy = Math.round(gy);
      for (const id of ids) {
        const n = this.nodeById(id);
        if (!n) continue;
        const h = this.dimsOf(id).h;
        n.y = Math.round(yy);
        yy += h + 24;
      }
      this.resolveOverlaps(new Set(ids));
      this.sel.clear();
      this.selEdges.clear();
      this.selGroups = new Set([g.id]);
      this.scheduleSave();
      this.emit();
      this.toast('Цепочка «' + g.name + '» преобразована в группу: ноды на холсте в порядке цепочки, связи «кто за кем» сохранены');
    }, 0);
  }

  /**
   * Группа → цепочка (groupToStack, 7057–7099): порядок — по раскладке
   * (шире, чем выше → слева направо, иначе сверху вниз), первая нода — якорь,
   * у остальных старые связи убираются, между соседями — связи «кто за кем».
   */
  groupToStack(gid: string): void {
    const g = this.groupById(gid);
    if (!g || g.stack === true) return;
    const ms = this.membersOf(g.id);
    if (ms.length < 2) {
      this.toast('Для цепочки нужно минимум две ноды в группе', 'warn');
      return;
    }
    const bad = ms.filter((n) => !stackableType(n.type));
    if (bad.length) {
      this.toast('В цепочку нельзя: ' + bad.slice(0, 3).map((n) => '«' + (n.title || '?') + '»').join(', ') + (bad.length > 3 ? '…' : '') + ' — персонажи и заметки в цепочки не входят', 'warn');
      return;
    }
    const kids = this.doc.groups.filter((cg) => cg.parent === gid);
    if (kids.length) {
      this.toast('Сначала распустите или выньте вложенные группы (' + kids.length + ')', 'warn');
      return;
    }
    const lk = this.lockBlockedBy(ms.map((n) => n.id));
    if (lk) {
      this.showLockTip(this.lastPtr.x, this.lastPtr.y, lk);
      return;
    }
    let x0 = 1e9;
    let x1 = -1e9;
    let y0 = 1e9;
    let y1 = -1e9;
    ms.forEach((n) => {
      const d = this.dimsOf(n.id);
      x0 = Math.min(x0, n.x);
      x1 = Math.max(x1, n.x + d.w);
      y0 = Math.min(y0, n.y);
      y1 = Math.max(y1, n.y + d.h);
    });
    const ids = (x1 - x0 >= y1 - y0)
      ? ms.slice().sort((a, b) => a.x - b.x || a.y - b.y).map((n) => n.id)
      : ms.slice().sort((a, b) => a.y - b.y || a.x - b.x).map((n) => n.id);
    this.pushHistory('Группа → цепочка');
    const doc = this.doc;
    g.stack = true;
    g.fold = 1;
    g.order = ids.slice();
    const gr = g as unknown as Record<string, unknown>;
    gr.bbox = null;
    gr.hh = null;
    /* карточка цепочки — в левый верхний угол области группы (7080) */
    g.x = Math.round(x0);
    g.y = Math.round(y0);
    ids.forEach((id, i) => {
      const n = this.nodeById(id);
      if (!n) return;
      if (i > 0) stackDetachEdges(doc, id);
      const pk = stackParkPos(g, i);
      n.x = pk.x;
      n.y = pk.y;
    });
    const set = new Set(ids);
    const consec: Record<string, boolean> = {};
    for (let ci = 0; ci < ids.length - 1; ci++) consec[ids[ci] + '>' + ids[ci + 1]] = true;
    doc.edges = doc.edges.filter((e) => {
      if (e.q && set.has(e.from) && set.has(e.to)) return !!consec[e.from + '>' + e.to];
      return true;
    });
    for (let cj = 0; cj < ids.length - 1; cj++) {
      const aC = ids[cj];
      const bC = ids[cj + 1];
      if (!doc.edges.some((e) => e.from === aC && e.to === bC && e.q)) doc.edges.push(stackChainEdgeObj(aC, bC));
    }
    this.sel.clear();
    this.selEdges.clear();
    this.selGroups = new Set([g.id]);
    this.scheduleSave();
    this.emit();
    this.toast('Группа «' + g.name + '» преобразована в цепочку (' + ids.length + '): порядок — по раскладке, у нод кроме первой старые связи убраны');
  }

  /** «Собрать в цепочку (по порядку выделения)» (stackFromSelection, 7426–7445). */
  stackFromSelection(): void {
    const ids: string[] = [];
    for (const id of this.sel) {
      const n = this.nodeById(id);
      if (n && stackableType(n.type) && !this.stackGroupOf(n)) ids.push(id);
    }
    if (this.selGroups.size || ids.length !== this.sel.size || ids.length < 2) {
      this.toast('Выделите минимум две ноды вне цепочек', 'warn');
      return;
    }
    const lk = this.lockBlockedBy(ids);
    if (lk) {
      this.showLockTip(this.lastPtr.x, this.lastPtr.y, lk);
      return;
    }
    this.pushHistory('Сборка цепочки из выделения');
    const doc = this.doc;
    const first = this.nodeById(ids[0]) as VetviNode;
    const g: VetviGroup = {
      id: uid(),
      name: 'Цепочка',
      fold: 1,
      x: Math.round(first.x),
      y: Math.round(first.y),
      parent: first.gid || null,
      color: null,
      alpha: 0.55,
      badge: null,
      auto: false,
      stack: true,
      order: ids.slice(),
    };
    doc.groups.push(g);
    ids.forEach((id, i) => {
      const n = this.nodeById(id) as VetviNode;
      n.gid = g.id;
      /* первая нода — якорь: её связи сохраняются; остальные — старые связи убираются */
      if (i > 0) stackDetachEdges(doc, id);
      const pk = stackParkPos(g, i);
      n.x = pk.x;
      n.y = pk.y;
    });
    stackRebuildChains(doc, g);
    this.sel.clear();
    this.selEdges.clear();
    this.selGroups = new Set([g.id]);
    this.scheduleSave();
    this.emit();
    this.toast('Цепочка из ' + ids.length + ' нод собрана: связи перестроены по порядку (как «кто за кем»), вход в первую ноду сохранён');
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
    if (g.stack === true) {
      /* ungroup, 6997–7012: ноды колонкой от точки карточки; q-связи «кто за кем»
         СОХРАНЯЮТСЯ как обычные связи на холсте (авто-связи не удаляются) */
      const ids = stackOrderIds(doc, g);
      ids.forEach((id, i) => {
        const n = doc.nodes.find((x) => x.id === id);
        if (!n) return;
        n.gid = parent;
        n.x = Math.round(g.x || 0);
        n.y = Math.round((g.y || 0) + i * 130);
      });
    }
    for (const n of doc.nodes) if (n.gid === gid) n.gid = parent;
    for (const sg of doc.groups) if (sg.parent === gid) sg.parent = parent;
    doc.groups = doc.groups.filter((x) => x.id !== gid);
  }

  /** Роспуск группы/разбор цепочки (ungroup, 6992–7021): локи, тосты 1:1. */
  dissolveGroup(gid: string): void {
    const g = this.groupById(gid);
    if (!g) return;
    const lk = this.lockBlockedBy([gid].concat(this.membersOf(gid).map((n) => n.id)));
    if (lk) {
      this.showLockTip(this.lastPtr.x, this.lastPtr.y, lk);
      return;
    }
    const wasStack = g.stack === true;
    const ids = wasStack ? stackOrderIds(this.doc, g) : [];
    this.mutate((doc) => { this.dissolveGroupIn(doc, gid); }, { label: 'Разбор группы/цепочки' });
    if (wasStack && ids.length) this.resolveOverlaps(new Set(ids));
    this.toast(wasStack ? 'Цепочка разобрана — авто-связи «кто за кем» сохранены' : 'Группа «' + g.name + '» расформирована', 'warn');
  }

  /** Покинуть группу / вывести из цепочки (leaveGroup, 7148–7177). */
  leaveGroup(nodeId: string): void {
    const n = this.nodeById(nodeId);
    if (!n || !n.gid) return;
    const gid = n.gid;
    const g0 = this.groupById(gid);
    if (g0 && g0.stack === true) {
      /* цепочка (7152–7172): q-связи ноды убираются, соседи склеиваются, нода
         встаёт в свой парк-слот; пустая цепочка удаляется */
      const order0 = stackOrderIds(this.doc, g0);
      const idx = order0.indexOf(nodeId);
      const prev = idx > 0 ? order0[idx - 1] : null;
      const next = idx >= 0 && idx < order0.length - 1 ? order0[idx + 1] : null;
      this.mutate((doc) => {
        const gg = doc.groups.find((x) => x.id === gid);
        if (!gg) return;
        doc.edges = doc.edges.filter((e) => !(e.q && (e.from === nodeId || e.to === nodeId)));
        n.gid = gg.parent || null;
        gg.order = order0.filter((x) => x !== nodeId);
        if (prev && next && !doc.edges.some((e) => e.from === prev && e.to === next && e.tin !== 'var')) {
          doc.edges.push(stackChainEdgeObj(prev, next));
        }
        const pk = stackParkPos(gg, Math.max(0, idx));
        n.x = pk.x;
        n.y = pk.y;
      });
      if (g0.order && !g0.order.length) {
        this.doc.groups = this.doc.groups.filter((x) => x.id !== gid);
        this.selGroups.delete(gid);
      }
      this.emit();
      this.toast('Узел выведен из цепочки', 'warn');
      return;
    }
    this.mutate((doc) => {
      const nn = doc.nodes.find((x) => x.id === nodeId);
      if (nn) nn.gid = null;
    }, { label: 'Покинуть группу' });
    this.pruneEmptyGroups(this.doc);
    this.emit();
    this.toast('Узел исключён из группы', 'warn');
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
    /* как projOpen оригинала: текущий проект уже открыт — нечего делать */
    if (id === String(this.doc.meta.projectId || '') && this.syncMode !== 'copy') {
      this.toast('Этот проект уже открыт');
      return;
    }
    const slot = projReadSlot(id);
    if (!slot) {
      const left = projList().filter((e) => e.id !== id);
      this.toast('Данные проекта не найдены — запись убрана из списка', 'warn');
      this.emit();
      if (left.length) { this.openProject(left[0].id); }
      return;
    }
    this.flushSave();
    /* смена проекта — всегда выход из текущей комнаты (loadProject → syncLeaveIfRoom оригинала):
       без этого новый проект публикуется в чужую комнату, и у соавторов пустеет холст */
    if (this.sync) this.sync.leaveIfRoom();
    this.doc = slot.doc;
    this.vp = slot.vp;
    this.bend = slot.bend as BendMode;
    this.sel.clear();
    this.selEdges.clear();
    this.selGroups.clear();
    this.past = [];
    this.future = [];
    /* экран пароля: смена проекта сбрасывает разблокировку (сессия помнит ввод) */
    this.lockUnlocked = false;
    const pv = this.passSessionLookup();
    if (pv) { this.syncProjPass = pv; this.lockUnlocked = true; }
    projSetCur(id);
    this.toast('Открыт проект: ' + (this.doc.meta.name || 'Без названия'), 'ok');
    /* проект привязан к комнате — подключаемся после разблокировки (projOpen оригинала) */
    const entry = projList().find((e) => e.id === id);
    if (entry && entry.roomId && this.sync) {
      this.sync.mode = 'room';
      const roomId = entry.roomId;
      this.lockAfterUnlock(() => {
        this.sync!.connect(roomId, id, { own: true, silent: true });
        this.sync!.setHash(roomId, id);
      });
    } else if (this.sync) {
      /* проект вне комнаты — обязательно сбрасываем хэш, чтобы не цепляться к комнате предыдущего проекта */
      this.sync.setHash(null);
    }
    this.emit();
  }

  createProject(): void {
    this.flushSave();
    /* projCreate/loadProject оригинала: новый проект пока вне комнаты — выходим из текущей
       и сбрасываем хэш, чтобы не наследовать комнату и не публиковать пустой проект соавторам */
    if (this.sync) this.sync.leaveIfRoom();
    if (this.sync) this.sync.setHash(null);
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
    this.noteEditor();
    this.persist();
    this.toast('Создан новый проект — предыдущий сохранён в списке', 'ok');
    this.emit();
  }

  deleteProject(id: string): void {
    /* projSkipSaveId оригинала: удаляемый проект не должен «воскреснуть» через
       flushSave внутри openProject/createProject при переключении на следующий */
    projSkipSaveId(id);
    const list = projDelete(id);
    if (id === String(this.doc.meta.projectId || '')) {
      if (list.length) this.openProject(list[0].id);
      else { this.createProject(); projSkipSaveId(null); return; }
    }
    projSkipSaveId(null);
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
    /* 1:1 с оригиналом (9426): «Экспорт выделенных в JSON» — это «Тексты (JSON)»
       выделения, а не отдельный формат. */
    this.exportTextsJson(true);
  }

  /* ── лёгкий JSON текстов (exportTextsJson/textsImp оригинала, 10328–10600) ── */

  /** Узлы выделения + содержимое выделенных групп (plSelectionIds, 12730). */
  plSelectionIds(): Set<string> | null {
    if (!this.sel.size && !this.selGroups.size) return null;
    const seen = new Set<string>();
    const out = new Set<string>();
    const add = (n: VetviNode | null | undefined) => {
      if (n && !seen.has(n.id)) { seen.add(n.id); out.add(n.id); }
    };
    this.sel.forEach((id) => add(this.nodeById(id)));
    this.selGroups.forEach((gid) => {
      const seen = new Set<string>();
      const walk = (g: string) => {
        if (seen.has(g)) return;
        seen.add(g);
        this.doc.nodes.forEach((n) => { if (n.gid === g) add(n); });
        this.doc.groups.forEach((cg) => { if (cg.parent === g) walk(cg.id); });
      };
      walk(gid);
    });
    return out;
  }

  /** Экспорт «Тексты (JSON)» (exportTextsJson оригинала, 10344–10397). */
  exportTextsJson(onlySel: boolean): void {
    let selIds: Set<string> | null = null;
    if (onlySel) {
      const pl = this.plSelectionIds();
      if (!pl || !pl.size) {
        this.toast('Сначала выделите ноды на холсте: клик по карточке, Shift+клик — добавить, рамкой или группой', 'warn');
        return;
      }
      selIds = pl;
    }
    const { payload, nRep } = buildTextsPayload(this.doc, selIds);
    const fname = slugOf(this.doc.meta.name || '') + (selIds ? '-teksty-vydel' : '-teksty') + '.json';
    downloadFile(JSON.stringify(payload, null, 2), fname, 'application/json;charset=utf-8');
    this.toast(
      selIds
        ? ('Экспортировано выделенных: нод ' + payload.service.nodes.length + ', текстов ' + payload.texts.length + (nRep ? ', реплик ' + nRep : '') + ' — вернуть в проект можно через «Импорт текстов (JSON)»')
        : ('Экспортировано: текстов ' + payload.texts.length + ', нод ' + payload.service.nodes.length + (nRep ? ', реплик ' + nRep : '') + ' — связи в блоке service'),
      'ok',
    );
  }

  /** Экспорт в текстовый файл (.txt) — exportTXT оригинала (10255–10327). */
  exportTxtFile(): void {
    downloadFile(buildTxtExport(this.doc), slugOf(this.doc.meta.name || '') + '.txt', 'text/plain;charset=utf-8');
    this.logManual('Экспорт в текстовый файл');
    this.toast('Экспортировано в текстовый файл', 'ok');
  }

  /** Открыть окно «Импорт текстов (JSON)» (openTextsImport, 10473): keep — текст после ошибки. */
  openTextsImport(keep?: string): void {
    this.textsKeep = keep ?? null;
    this.openModal('textsImport');
  }

  /** «Проверить» в окне импорта: парсинг и переход к шагу сверки (textsImpStep2, 10498). */
  textsImportCheck(str: string, fname?: string): void {
    const r = textsImpParse(str);
    if ('err' in r) {
      this.toast(r.err, 'err');
      this.openTextsImport(str);
      return;
    }
    this.textsImp = r.data;
    this.textsImpFname = fname || null;
    this.emit();
  }

  /** Применение импорта с выбранными флажками (textsImpApply оригинала, 10530–10600). */
  textsImportApply(opt: { upd: boolean; cre: boolean; med: boolean; lnk: boolean }): void {
    const d = this.textsImp;
    if (!d) return;
    const pre = this.beginEdit();
    const stat = { upd: 0, cre: 0, rep: 0, out: 0, lnkUp: 0, lnkNew: 0, lnkSkip: 0 };
    const newIds: string[] = [];
    const byId: Record<string, VetviNode> = {};
    const have: Record<string, boolean> = {};
    this.doc.nodes.forEach((n) => { byId[n.id] = n; have[n.id] = true; });
    let bx = 1e9, by = 1e9;
    this.doc.nodes.forEach((n) => { if (n.x < bx) bx = n.x; if (n.y < by) by = n.y; });
    if (bx > 1e8) { bx = 100; by = 100; }
    let col = 0, row = 0;
    d.nodes.forEach((en) => {
      const n = byId[en.id];
      if (n) {
        if (opt.upd) {
          let ch = false;
          if (en.title !== null && n.title !== en.title) { n.title = en.title; ch = true; }
          if (en.text !== null) {
            if (n.type === 'dialog') {
              ensureDialog(n);
              if (n.dialog!.description !== en.text || n.text !== en.text) { n.dialog!.description = en.text; n.text = en.text; ch = true; }
            } else if (n.text !== en.text) { n.text = en.text; ch = true; }
          }
          if (opt.med) {
            if (en.replies && n.type === 'dialog') { ensureDialog(n); n.dialog!.replies = en.replies as unknown as VetviReply[]; stat.rep++; ch = true; }
            if (en.outcomes && n.type === 'branch' && Array.isArray(n.outcomes)) {
              en.outcomes.forEach((oo) => {
                let hit: { id: string; label: string; cond?: unknown } | null = null;
                n.outcomes!.forEach((x) => { if (x && x.id === oo.id) hit = x as { id: string; label: string; cond?: unknown }; });
                const h = hit as { id: string; label: string } | null;
                if (h) { if (h.label !== oo.label) { h.label = oo.label; ch = true; } }
                else {
                  n.outcomes!.push({ id: oo.id ? oo.id.slice(0, 40) : uid(), label: oo.label, cond: null });
                  if (n.outcomes!.length > 24) n.outcomes!.length = 24;
                  ch = true;
                }
              });
              stat.out++;
            }
          }
          if (ch) stat.upd++;
        }
        return;
      }
      if (!opt.cre) return;
      const t = (en.type && TYPES[en.type]) ? en.type : 'note';
      const nn: VetviNode = {
        id: en.id, type: t, gid: null,
        x: Math.round(bx + col * 300 + (row % 2) * 60), y: Math.round(by + 170 + row * 210),
        title: (en.title !== null) ? en.title : (TYPES[t] ? TYPES[t].name : 'Заметка'),
        text: '', status: 'idea', tags: [], expand: 1, color: null, tint: -60, dlgWidth: null,
      };
      if (t === 'dialog') {
        ensureDialog(nn);
        if (en.text !== null) { nn.dialog!.description = en.text; nn.text = en.text; }
        if (opt.med && en.replies) nn.dialog!.replies = en.replies as unknown as VetviReply[];
      } else if (en.text !== null) nn.text = en.text;
      if (t === 'branch' && opt.med && en.outcomes) nn.outcomes = en.outcomes.map((oo) => ({ id: oo.id, label: oo.label, cond: null })) as typeof nn.outcomes;
      this.doc.nodes.push(nn); byId[nn.id] = nn; have[nn.id] = true; newIds.push(nn.id);
      col++; if (col >= 4) { col = 0; row++; }
      stat.cre++;
    });
    if (opt.lnk) {
      d.links.forEach((l) => {
        if (!have[l.from] || !have[l.to] || l.from === l.to) { stat.lnkSkip++; return; }
        let fr = l.fromReply, fo = l.fromOut;
        const fnode = byId[l.from];
        if (fo && !(fnode && fnode.type === 'branch' && Array.isArray(fnode.outcomes) && fnode.outcomes.some((o) => o && o.id === fo))) fo = null;
        if (fr && !(fnode && fnode.type === 'dialog' && findReply((fnode.dialog && fnode.dialog.replies) || [], fr))) fr = null;
        let hit: VetviEdge | null = null;
        this.doc.edges.forEach((e) => { if (e.from === l.from && e.to === l.to && (e.fromReply || null) === fr && (e.fromOut || null) === fo) hit = e; });
        if (hit) {
          if (l.label !== null && (hit as VetviEdge).label !== l.label) { (hit as VetviEdge).label = l.label; stat.lnkUp++; }
        } else {
          this.doc.edges.push({
            id: uid(), from: l.from, to: l.to, label: (l.label !== null) ? l.label : '', kind: 'flow', pts: [],
            lt: 0.5, lp: 0, fromReply: fr, fromOut: fo, tin: null, bd: { dl: 0, dy: 0, dr: 0 }, cond: null, q: 1,
          });
          stat.lnkNew++;
        }
      });
    }
    this.textsImp = null;
    this.textsImpFname = null;
    this.closeModal();
    if (pre !== this.serialize()) {
      this.commitEdit(pre, 'Импорт текстов из JSON');
      this.logUndoRedo(pre, 'Импорт текстов из JSON');
    }
    const parts: string[] = [];
    if (stat.upd) parts.push('обновлено нод: ' + stat.upd);
    if (stat.cre) parts.push('создано нод: ' + stat.cre);
    if (stat.rep) parts.push('реплики обновлены: ' + stat.rep);
    if (stat.out) parts.push('развилки обновлены: ' + stat.out);
    if (stat.lnkUp) parts.push('связей исправлено: ' + stat.lnkUp);
    if (stat.lnkNew) parts.push('связей добавлено: ' + stat.lnkNew);
    if (stat.lnkSkip) parts.push('связей пропущено: ' + stat.lnkSkip);
    this.toast(parts.length ? 'Импорт завершён — ' + parts.join(', ') : 'Импорт: тексты уже совпадают', 'ok');
  }

  /* ── распределение по строкам (layoutRows/dstState оригинала, 6672–6831) ── */

  dstState: { ids: string[] | null; k: number } = { ids: null, k: 4 };

  /** layoutRows оригинала (6672): сетка по измеренным размерам, мосты на стыках строк. */
  private layoutRows(ids: string[], k: number): void {
    const rows: string[][] = [];
    for (let i = 0; i < ids.length; i += k) rows.push(ids.slice(i, i + k));
    let maxW = 0, maxH = 0;
    ids.forEach((id) => {
      const n = this.nodeById(id);
      if (!n) return;
      const el = this.dimsFn ? this.dimsFn(id) : null;
      maxW = Math.max(maxW, el ? el.w : this.dlgNodeWidthOf(n));
      maxH = Math.max(maxH, el ? el.h : 90);
    });
    const colStep = maxW + 70, rowStep = maxH + 120;
    let mnX = 1e9, mnY = 1e9;
    ids.forEach((id) => { const n = this.nodeById(id); if (n) { mnX = Math.min(mnX, n.x); mnY = Math.min(mnY, n.y); } });
    if (this.snapOn) { mnX = Math.round(mnX / GRID) * GRID; mnY = Math.round(mnY / GRID) * GRID; }
    rows.forEach((rw, i) => {
      rw.forEach((id, j) => {
        const n = this.nodeById(id);
        if (!n) return;
        n.x = Math.round(mnX + j * colStep);
        n.y = Math.round(mnY + i * rowStep);
      });
    });
    const idSet = new Set(ids);
    this.doc.edges.forEach((e) => { if (idSet.has(e.from) && idSet.has(e.to) && isBridge(e)) e.kind = 'flow'; });
    for (let ri = 0; ri < rows.length - 1; ri++) {
      const U = this.nodeById(rows[ri][rows[ri].length - 1]);
      const L = this.nodeById(rows[ri + 1][0]);
      if (!U || !L) continue;
      const ex = this.doc.edges.find((e) => e.from === U.id && e.to === L.id) || null;
      if (ex) { ex.kind = 'bridge'; if (!ex.bd) ex.bd = { dl: 0, dy: 0, dr: 0 }; }
      else {
        this.doc.edges.push({ id: uid(), from: U.id, to: L.id, label: '', kind: 'bridge', pts: [], lt: 0.5, lp: 0, fromReply: null, bd: { dl: 0, dy: 0, dr: 0 } });
      }
    }
  }

  /** Размер карточки диалога для расчётов (dlgNodeWidth оригинала). */
  private dlgNodeWidthOf(n: VetviNode): number {
    return (n.dlgWidth || NODE_W) + (n.dialog ? dlgMaxDepth(n.dialog.replies, 1) * 23 : 0);
  }

  private dstApply(): void {
    if (!this.dstState.ids) return;
    this.layoutRows(this.dstState.ids, this.dstState.k);
    this.scheduleSave();
    this.emit();
  }

  private dstClamp(v: number): number {
    const m = this.dstState.ids ? this.dstState.ids.length : 1;
    if (isNaN(v)) v = 1;
    if (v < 1) v = 1;
    if (v > m) v = m;
    return v;
  }

  /** dstSetK оригинала (6739). */
  dstSetK(v: number): void {
    const nk = this.dstClamp(v);
    this.dstState.k = nk;
    this.dstApply();
  }

  /** closeDstWin оригинала (6757). */
  closeDstWin(): void {
    this.dstState.ids = null;
    this.emit();
  }

  /** openDistributeModal оригинала (6761–6792). */
  openDistribute(): void {
    const ids: string[] = [];
    this.sel.forEach((id) => { if (this.nodeById(id)) ids.push(id); });
    if (ids.length < 2) { this.toast('Выделите минимум два элемента', 'warn'); return; }
    let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
    ids.forEach((id) => {
      const n = this.nodeById(id);
      if (!n) return;
      minX = Math.min(minX, n.x); minY = Math.min(minY, n.y);
      maxX = Math.max(maxX, n.x + NODE_W); maxY = Math.max(maxY, n.y + 90);
    });
    const horizontal = (maxX - minX) >= (maxY - minY);
    ids.sort((a, b) => {
      const na = this.nodeById(a), nb = this.nodeById(b);
      if (!na || !nb) return 0;
      if (horizontal) return (na.x - nb.x) || (na.y - nb.y);
      return (na.y - nb.y) || (na.x - nb.x);
    });
    if (ids.length === 2) {
      const pre = this.beginEdit();
      this.layoutRows(ids, 1);
      this.commitEdit(pre, 'Растягивание в строку');
      this.toast('Две строки по одному элементу, стык соединён мостом', 'ok');
      return;
    }
    this.dstState.ids = ids;
    this.dstState.k = Math.min(4, ids.length);
    const pre = this.beginEdit();
    this.dstApply();
    this.commitEdit(pre, 'Распределение по строкам');
    this.emit();
  }

  /** bridgePairCandidate оригинала (6704): пара без связи для «Создать мост». */
  bridgePairCandidate(): { a: string; b: string } | null {
    if (this.sel.size !== 2 || this.selGroups.size !== 0) return null;
    const ids = [...this.sel];
    const a = this.nodeById(ids[0]);
    const b = this.nodeById(ids[1]);
    if (!a || !b) return null;
    const hasOut = (n: VetviNode) => this.doc.edges.some((e) => e.from === n.id);
    const hasIn = (n: VetviNode) => this.doc.edges.some((e) => e.to === n.id);
    if (!hasOut(a) && !hasIn(b)) return { a: a.id, b: b.id };
    if (!hasOut(b) && !hasIn(a)) return { a: b.id, b: a.id };
    return null;
  }

  /* ── свои типы нод (customTypes оригинала, 2914–2963 + 10076–10151) ── */

  customTypesRecs(): CustomTypeRec[] {
    const arr: unknown[] = Array.isArray(this.doc.customTypes) ? (this.doc.customTypes as unknown[]) : [];
    const out: CustomTypeRec[] = [];
    for (const raw of arr) {
      if (!raw || typeof raw !== 'object') continue;
      const c = raw as Record<string, unknown>;
      if (typeof c.id !== 'string' || !c.id) continue;
      out.push({
        id: c.id,
        name: typeof c.name === 'string' && c.name ? c.name : 'Свой тип',
        color: typeof c.color === 'string' && c.color ? c.color : '#8b929c',
        icon: typeof c.icon === 'string' && c.icon ? c.icon : 'star',
      });
    }
    return out;
  }

  customById(id: string): CustomTypeRec | null {
    return this.customTypesRecs().find((c) => c.id === id) || null;
  }

  /** typeInfo(key) оригинала (2926): встроенный → свой тип → заметка. */
  typeInfoOf(key: string): { name: string; color: string; icon: string } {
    const t = TYPES[key];
    if (t) {
      const icons: Record<string, string> = {
        scene: 'scene', quest: 'quest', dialog: 'dialog', skill: 'skill', action: 'action',
        branch: 'branch', varnode: 'variable', event: 'event', note: 'note',
      };
      return { name: t.name, color: t.color, icon: icons[key] || 'star' };
    }
    const c = this.customById(key);
    if (c) return { name: c.name, color: c.color, icon: c.icon || 'star' };
    return { name: TYPES.note.name, color: TYPES.note.color, icon: 'note' };
  }

  /** allTypeKeys() оригинала (2963). */
  allTypeKeys(): string[] {
    return Object.keys(TYPES).concat(this.customTypesRecs().map((c) => c.id));
  }

  /** listHidden(key) оригинала: record в ядре, массив в старых данных. */
  listHiddenAt(key: string): boolean {
    const lh: unknown = this.doc.listHidden;
    if (Array.isArray(lh)) return (lh as unknown[]).indexOf(key) >= 0;
    if (lh && typeof lh === 'object') return Boolean((lh as Record<string, unknown>)[key]);
    return false;
  }

  /** toggleListVis(key) оригинала (2965–2971). */
  toggleListVis(key: string): void {
    const was = this.listHiddenAt(key);
    this.mutate(() => {
      const lh = this.doc.listHidden as Record<string, unknown>;
      if (was) delete lh[key];
      else lh[key] = true;
    }, { label: 'Видимость типа в списке' });
    this.toast(was ? 'Тип возвращён в раздел «На холсте»' : 'Тип убран из раздела «На холсте»', 'ok');
  }

  /** Сохранение редактора своих типов (10103–10114): новый или правка существующего. */
  saveCustomType(id: string | null, name: string, color: string, icon: string): void {
    const nm = (name || '').trim() || 'Элемент';
    if (id) {
      const exists = this.customById(id);
      if (!exists) return;
      this.mutate(() => {
        const arr = (this.doc.customTypes || []) as Record<string, unknown>[];
        const c = arr.find((x) => x && x.id === id);
        if (c) { c.name = nm; c.color = color; c.icon = icon; }
      }, { label: 'Правка своих типов' });
      this.toast('Тип «' + nm + '» обновлён', 'ok');
    } else {
      this.mutate(() => {
        if (!Array.isArray(this.doc.customTypes)) this.doc.customTypes = [];
        (this.doc.customTypes as unknown[]).push({ id: uid(), name: nm, color, icon });
      }, { label: 'Правка своих типов' });
      this.toast('Тип «' + nm + '» создан', 'ok');
    }
  }

  /** deleteCustomType(id) оригинала (10142–10151): узлы типа становятся заметками. */
  deleteCustomType(id: string): void {
    const c = this.customById(id);
    if (!c) return;
    this.mutate((doc) => {
      doc.customTypes = ((doc.customTypes || []) as unknown[]).filter((x) => (x as { id?: string }).id !== id);
      doc.nodes.forEach((n) => { if (n.type === id) n.type = 'note'; });
      const lh = doc.listHidden as Record<string, unknown>;
      delete lh[id];
    }, { label: 'Удаление своего типа' });
    this.toast('Тип «' + c.name + '» удалён (его узлы стали заметками)', 'warn');
  }


  importProject(parsed: unknown, filename?: string): void {
    /* файл обязан содержать массивы nodes/edges («bad»-проверка openProject оригинала) —
       без неё docFromParsed от мусора вернёт defaultDoc и «импортируется» пустой проект */
    const raw = (parsed && typeof parsed === 'object' ? parsed : {}) as Record<string, unknown>;
    const projRaw = (raw.nodes && raw.edges)
      ? raw
      : (raw.project && typeof raw.project === 'object' ? (raw.project as Record<string, unknown>) : null);
    if (!projRaw || !Array.isArray(projRaw.nodes) || !Array.isArray(projRaw.edges)) {
      this.toast('Файл не похож на проект Ветвей', 'err');
      return;
    }
    const doc = docFromParsed(parsed);
    if (!doc.nodes.length && !doc.edges.length) {
      this.toast('Файл не похож на проект Ветвей', 'err');
      return;
    }
    this.flushSave();
    /* импорт = загрузка другого проекта: выходим из комнаты и сбрасываем хэш
       (loadProject → syncLeaveIfRoom оригинала) */
    if (this.sync) this.sync.leaveIfRoom();
    if (this.sync) this.sync.setHash(null);
    /* имя файла — только если в проекте нет осмысленного названия (loadProject оригинала
       держал fileName отдельно и не портил meta.name) */
    if (filename && (!doc.meta.name || doc.meta.name === 'Без названия')) {
      doc.meta.name = filename.replace(/\.json$/i, '').slice(0, 80);
    }
    /* projectId из файла сохраняем (projSaveCurrent оригинала): повторный импорт
       того же файла обновляет тот же проект, а не плодит копии */
    const filePid = typeof doc.meta.projectId === 'string' ? doc.meta.projectId : '';
    const pid = filePid || (uid() + uid());
    doc.meta.projectId = pid;
    /* viewport/bend из экспортированного файла (loadProject оригинала) */
    const vpRaw = (raw.viewport && typeof raw.viewport === 'object' ? raw.viewport : {}) as Record<string, unknown>;
    const hasVp = typeof vpRaw.x === 'number' && typeof vpRaw.y === 'number' && typeof vpRaw.z === 'number' && (vpRaw.z as number) > 0;
    const bRaw = raw.bend;
    this.doc = doc;
    this.vp = hasVp
      ? { x: vpRaw.x as number, y: vpRaw.y as number, z: vpRaw.z as number }
      : defaultViewport();
    this.bend = (bRaw === 'ortho90' || bRaw === 'ortho45' || bRaw === 'smooth') ? bRaw : 'smooth';
    this.sel.clear();
    this.selEdges.clear();
    this.selGroups.clear();
    this.past = [];
    this.future = [];
    /* импортированный проект может быть запаролен (lockApplyState оригинала) */
    this.lockUnlocked = false;
    const pv = this.passSessionLookup();
    if (pv) { this.syncProjPass = pv; this.lockUnlocked = true; }
    this.noteEditor();
    this.persist();
    this.logManual('Импорт проекта из JSON');
    this.toast('Проект импортирован: ' + (doc.meta.name || 'Без названия'), 'ok');
    this.emit();
    /* если в файле нет viewport — вписать проект в окно (иначе ноды далеко за экраном:
       «после импорта ничего не видно, пока не кликнешь ноду в списке») */
    if (!hasVp) {
      const api = canvasApi.current;
      const r = api ? api.getRect() : null;
      if (r && api) this.fitView(r.width, r.height, api.sizes);
    }
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

  setCollabPop(v: boolean): void {
    this.collabPop = v;
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

  /* ── совместное редактирование: помощь SyncClient ── */

  /** Активный ввод/модалка/жест/анимация: в комнате удалённые снимки ждут (pendingRemote). */
  busyNow(): boolean {
    const t = typeof document !== 'undefined' ? document.activeElement : null;
    const typing = !!t && t.isConnected && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || (t as HTMLElement).isContentEditable);
    return typing || this.modal != null || this.dialogEdit != null || this.carry != null || this.confirm != null || this.syncBusyFlag || this.busyAnim;
  }

  /** Снимок проекта для комнаты (syncDocObj оригинала). */
  syncDocObj(): Record<string, unknown> {
    return {
      app: 'vetvi-room',
      version: 1,
      meta: this.doc.meta,
      bend: this.bend,
      nodes: this.doc.nodes,
      edges: this.doc.edges,
      customTypes: Array.isArray(this.doc.customTypes) ? this.doc.customTypes : [],
      groups: this.doc.groups,
      listHidden: this.doc.listHidden && typeof this.doc.listHidden === 'object' ? this.doc.listHidden : {},
      vars: Array.isArray(this.doc.vars) ? this.doc.vars : [],
      chars: Array.isArray(this.doc.chars) ? this.doc.chars : [],
      palette: (Array.isArray(this.doc.palette) ? this.doc.palette : []).slice(0, 24),
    };
  }

  /**
   * Применение удалённого состояния комнаты (syncApplyRemote оригинала):
   * журнал действий объединяется с пришедшим (правки участников не теряют
   * друг друга), выделение подрезается до живых id, история не пишется.
   * keepPid: снимок комнаты без meta.projectId — сохраняем привязку к проекту.
   */
  applyRemoteDoc(doc: Record<string, unknown> | null, keepPid = false): void {
    if (!doc || !Array.isArray(doc.nodes)) return;
    this.flushPendingLog();
    const d = doc as {
      meta?: Record<string, unknown>;
      bend?: string;
      nodes?: VetviNode[];
      edges?: VetviEdge[];
      groups?: VetviGroup[];
      customTypes?: unknown[];
      listHidden?: unknown;
      vars?: VetviVar[];
      chars?: VetviChar[];
      palette?: unknown[];
    };
    const localMeta = this.doc.meta as Record<string, unknown>;
    const myPid = typeof localMeta.projectId === 'string' ? localMeta.projectId : null;
    if (d.meta && typeof d.meta === 'object') {
      this.doc.meta = d.meta as VetviMeta;
      const newMeta = this.doc.meta as unknown as Record<string, unknown>;
      if (keepPid && !newMeta.projectId && myPid) newMeta.projectId = myPid;
      /* журнал действий и список редакторов — объединить локальные записи с пришедшими */
      try {
        const seen: Record<string, number> = {};
        const merged: unknown[] = [];
        const loc = Array.isArray(localMeta.actionLog) ? localMeta.actionLog : [];
        const rem = Array.isArray(newMeta.actionLog) ? newMeta.actionLog : [];
        loc.concat(rem).forEach((en) => {
          const e = en as { id?: string };
          if (!e || !e.id || seen[e.id]) return;
          seen[e.id] = 1;
          merged.push(en);
        });
        merged.sort((a, b) => (((b as { t?: number }).t || 0) - ((a as { t?: number }).t || 0)));
        if (merged.length > 60) merged.length = 60;
        if (merged.length) newMeta.actionLog = merged;
        this.logTrimSnaps();
        const seenE: Record<string, number> = {};
        const mE: unknown[] = [];
        const locE = Array.isArray(localMeta.editLog) ? localMeta.editLog : [];
        const remE = Array.isArray(newMeta.editLog) ? newMeta.editLog : [];
        locE.concat(remE).forEach((en) => {
          const e = en as { id?: string; name?: string; at?: string };
          const k = (((e.id || e.name) || '?') + '|' + (e.at || ''));
          if (seenE[k]) return;
          seenE[k] = 1;
          mE.push(en);
        });
        mE.sort((a, b) => {
          const ta = Date.parse((a as { at?: string }).at || '') || 0;
          const tb = Date.parse((b as { at?: string }).at || '') || 0;
          return tb - ta;
        });
        if (mE.length) {
          const out: unknown[] = [];
          for (const en of mE) {
            const p = out[out.length - 1] as { id?: string; name?: string } | undefined;
            const c = en as { id?: string; name?: string };
            if (p && ((p.id && p.id === c.id) || (p.name && p.name === c.name))) continue;
            out.push(c);
            if (out.length >= 6) break;
          }
          newMeta.editLog = out;
        }
      } catch { /* журнал — необязательное поле */ }
    }
    if (d.bend === 'ortho90' || d.bend === 'ortho45' || d.bend === 'smooth') {
      if (d.bend !== this.bend) this.bend = d.bend;
    }
    this.doc.nodes = d.nodes || [];
    this.doc.edges = d.edges || [];
    this.doc.customTypes = Array.isArray(d.customTypes) ? d.customTypes : [];
    this.doc.groups = Array.isArray(d.groups) ? d.groups : [];
    /* цепочки всегда fold=1; старое «Очередь» → «Цепочка» */
    for (const g of this.doc.groups) {
      if (g.stack && (g.fold !== 1 || g.name === 'Очередь')) {
        g.fold = 1;
        if (g.name === 'Очередь') g.name = 'Цепочка';
      }
    }
    this.doc.listHidden = (d.listHidden && typeof d.listHidden === 'object') ? d.listHidden as Record<string, unknown> : {};
    this.doc.vars = Array.isArray(d.vars) ? d.vars : [];
    this.doc.chars = Array.isArray(d.chars) ? d.chars : [];
    this.doc.palette = (Array.isArray(d.palette) ? d.palette : []).filter((c) => typeof c === 'string' && /^#[0-9a-fA-F]{6}$/.test(c as string)).slice(0, 24) as string[];
    /* снимок от старой версии: ноды персонажей → список */
    this.migrateCharNodesInPlace();
    const ids = new Set(this.doc.nodes.map((n) => n.id));
    const ns = new Set<string>();
    this.sel.forEach((id) => { if (ids.has(id)) ns.add(id); });
    this.sel = ns;
    const eids = new Set(this.doc.edges.map((e) => e.id));
    const es = new Set<string>();
    this.selEdges.forEach((id) => { if (eids.has(id)) es.add(id); });
    this.selEdges = es;
    const gids = new Set(this.doc.groups.map((g) => g.id));
    const gs = new Set<string>();
    this.selGroups.forEach((id) => { if (gids.has(id)) gs.add(id); });
    this.selGroups = gs;
    /* открытый редактор диалога: нода удалена — закрываем */
    if (this.dialogEdit && !this.nodeById(this.dialogEdit)) this.closeDialogEditor();
    this.scheduleSave();
    this.emit();
  }

  /* ── пароль проекта (passSalt+passHash в meta, сам пароль — только память сессии) ── */

  projLocked(): boolean {
    return !!(this.doc.meta && typeof (this.doc.meta as unknown as { passHash?: string }).passHash === 'string' && (this.doc.meta as unknown as { passHash?: string }).passHash);
  }

  passOk(v: string): boolean {
    return passVerify(this.doc.meta as unknown as { passSalt?: string; passHash?: string }, v);
  }

  passRememberSession(): void {
    try {
      const pid = this.doc.meta.projectId as string | undefined;
      if (pid) window.sessionStorage.setItem('vetvi-unlock-' + pid, this.syncProjPass || '');
    } catch { /* нет доступа */ }
  }

  passSessionLookup(): string | null {
    try {
      const pid = this.doc.meta.projectId as string | undefined;
      if (!pid) return null;
      const v = window.sessionStorage.getItem('vetvi-unlock-' + pid);
      return (v && this.passOk(v)) ? v : null;
    } catch {
      return null;
    }
  }

  /** Нужно ли показывать экран пароля. */
  lockNeeded(): boolean {
    return this.projLocked() && !this.lockUnlocked;
  }

  /** Состояние замка при старте/смене проекта: сессия помнит ввод (lockApplyState). */
  applyLockState(): void {
    this.lockUnlocked = false;
    const v = this.passSessionLookup();
    if (v) {
      this.syncProjPass = v;
      this.lockUnlocked = true;
      return;
    }
    this.emit();
  }

  /** Выполнить fn после разблокировки (или сразу, если проект не заперт). */
  lockAfterUnlock(fn: () => void): void {
    if (!this.lockNeeded()) { fn(); return; }
    this.lockPendingCb = fn;
    this.emit();
  }

  /** Ввод пароля на экране блокировки: true — принято (и выполнен отложенный вход). */
  applyUnlock(v: string): boolean {
    if (!v) return false;
    if (!this.passOk(v)) return false;
    this.syncProjPass = v;
    this.lockUnlocked = true;
    this.passRememberSession();
    const cb = this.lockPendingCb;
    this.lockPendingCb = null;
    this.emit();
    if (cb) cb();
    return true;
  }

  /** Подсказка «объект используется другим пользователем» (lockTip оригинала). */
  showLockTip(x: number, y: number, by: { id: string; name: string; color: string } | null): void {
    this.lockTip = { x: clamp(x, 110, (typeof window !== 'undefined' ? window.innerWidth : 800) - 110), y: Math.max(48, y), by };
    this.emit();
    setTimeout(() => { this.lockTip = null; this.emit(); }, 2400);
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
      /* конструктор уже загрузил этот слот по хешу (loadAutosave) — не «переоткрывать» */
      if (m[1] === String(this.doc.meta.projectId || '')) return true;
      this.openProject(m[1]);
      return true;
    }
    return false;
  }

  /**
   * Перезапуск страницы: у открытого проекта есть комната — тихо переподключиться
   * (projInitStartup оригинала: «подключаемся только к комнате этого проекта»).
   */
  bootReconnectRoom(): void {
    if (!this.sync || this.sync.enabled) return;
    const hp = this.sync.hashParams();
    if (hp.room) return; /* комната из хеша обрабатывается в sync.init() */
    const pid = String(this.doc.meta.projectId || '');
    if (!pid) return;
    const entry = projList().find((e) => e.id === pid);
    if (!entry || !entry.roomId) return;
    this.sync.mode = 'room';
    const roomId = entry.roomId;
    this.lockAfterUnlock(() => {
      this.sync!.connect(roomId, pid, { own: true, silent: true });
      this.sync!.setHash(roomId, pid);
    });
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
