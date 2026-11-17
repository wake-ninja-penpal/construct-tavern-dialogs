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
import { stItem, stRemoveItem, stSetItem, storeFlushNow } from '@/vetvi/core/storage';
import type { EdgeGeom, NodeSize, VetviChar, VetviCharGroup, VetviDoc, VetviEdge, VetviGroup, VetviMeta, VetviNode, VetviOutcome, VetviReply, VetviVar, VetviVarGroup, VetviViewport } from '@/vetvi/core/types';
import { cleanupVarRefs, defValOf, VARS_OPS, varCastVal, varType, type Cond } from '@/vetvi/core/vars';
import { collapsedAncestorOf, groupCardRect, groupDepth, groupFrameRect } from './ggroups';
import { canvasApi } from './canvasApi';
import { noteModalOpen } from './NoteModals';
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
 * Расхождение локальных данных и данных комнаты (новая система входа в комнату):
 *  — 'local-server' — на входе комната загрузила серверную версию, а локальная
 *    копия проекта (слот) отличается от неё: блок в углу холста предлагает
 *    сравнение и выбор «опубликовать локальную / перезаписать локальными данными
 *    из комнаты / смерджить»;
 *  — 'incoming' — участник заменил данные на сервере (vetvi:replace): изменения
 *    НЕ применяются сразу — сравнение и кнопки «принять / отклонить / смерджить»;
 *  — 'foreign' — в комнате совсем другой проект (загрязнённая комната): локальный
 *    проект остаётся открытым, блок предлагает «загрузить из комнаты / опубликовать
 *    мою (вылечить комнату) / смерджить».
 */
export interface SyncDiffInfo {
  kind: 'local-server' | 'incoming' | 'foreign';
  /** Локальная версия: слот проекта (или снимок текущего документа до замены). */
  localDoc: Record<string, unknown>;
  /** Версия сервера (комнаты) / пришедшая замена. */
  serverDoc: Record<string, unknown>;
  /** Кто заменил данные (для kind='incoming'). */
  by?: { name?: string; color?: string } | null;
  at: number;
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
  /** Свёрнутая левая панель: мини-рейка с иконками разделов (клик по иконке —
   *  развернуть панель и открыть соответствующий раздел). */
  leftCollapsed = false;
  /** Панель открыта кликом по ИКОНКЕ раздела в мини-рейке — «подглядывание»:
   *  такой режим закрывается обратно кликом мимо панели (холст, ноды, что угодно
   *  вне блока левой панели). Открытие хлястиком/кнопкой — постоянное. */
  leftPeek = false;
  /** Свёрнутая правая панель (инспектор): открывается только когда мы что-то
   *  выделяем — чтобы показывать подробности и функционал выделенного объекта. */
  rightCollapsed = false;
  /** Версия выделения на момент сворачивания правой панели: свернули при активном
   *  выделении — пока выделение не сменится, панель не переоткрывается. */
  rightCollapseVer = -1;
  /** Счётчик изменений выделения (инкрементируется в noteSelFocus — его вызывают
   *  все селекторы стора); для режима «правая панель открывается при выделении». */
  selVer = 0;
  /** Мини-карта включена — кнопка #bMap тулбара (mmOn оригинала, 9371). */
  mmOn = true;
  /** Пределы масштаба холста (настройки интерфейса): минимум — как далеко
   *  можно отдалить, максимум — как близко приблизить. По умолчанию минимум
   *  шире константного ZOOM_MIN=0.25 — отдаляем до 10%. */
  uiZoomMin = 0.1;
  uiZoomMax = 3;
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

  /* локальные свёрнутые группы списков (НЕ синхронизируются — у каждого юзера своё) */
  charGroupsFold = new Set<string>();
  varGroupsFold = new Set<string>();

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
  /** Soft-lock редактируемого объекта (editLockIds оригинала): лок, взятый набором текста. */
  editLockIds: string[] = [];
  /** Расхождение локальной копии и комнаты (см. SyncDiffInfo) — блок в углу холста. */
  syncDiff: SyncDiffInfo | null = null;

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

  /** Показать блок расхождения в углу холста (новая система комнат). */
  setSyncDiff(info: SyncDiffInfo | null): void {
    this.syncDiff = info;
    this.emit();
  }

  /** Убрать блок расхождения (крестик/решение принято). */
  clearSyncDiff(): void {
    if (!this.syncDiff) return;
    this.syncDiff = null;
    this.emit();
  }

  revision = 0;
  /* ── каналы перерисовки (оптимизация) ──
   * docRev — изменилось содержимое документа; uiRev — UI-состояние (выделение,
   * модалки, тосты); geomRev — «геометрические» кадры (перетаскивание, панорама,
   * анимации). Корневой компонент подписан на doc+ui и НЕАТИВЕН к geom-кадрам:
   * во время жестов перерисовывается только холст. */
  docRev = 0;
  uiRev = 0;
  geomRev = 0;
  /** Версия «ссылочных» данных карточек: персонажи/переменные/свои типы/палитра/связи. */
  refVer = 0;
  saveState: SaveState = 'idle';
  lastSavedAt = 0;

  getDocRev = (): number => this.docRev;
  getUiRev = (): number => this.uiRev;
  getGeomRev = (): number => this.geomRev;

  /** Последняя позиция курсора (lastPtr оригинала) — для showLockTip вне жестов. */
  lastPtr: { x: number; y: number } = { x: 0, y: 0 };

  private past: string[] = [];
  private future: string[] = [];
  private pendingLog: { pre: string; t: number; label: string | null } | null = null;
  private logFlushT: ReturnType<typeof setTimeout> | null = null;
  private listeners = new Set<Listener>();
  private saveT: ReturnType<typeof setTimeout> | null = null;
  private toastSeq = 1;
  private notifyScheduled = false;
  private notifyFallbackT: ReturnType<typeof setTimeout> | null = null;
  private viewSaveT: ReturnType<typeof setTimeout> | null = null;

  /* ── сигнатуры объектов (для memo-карточек при мутабельном документе) ── */
  private sigDocRef: VetviDoc | null = null;
  private sigNodes = new Map<string, string>();
  private sigChars = new Map<string, string>();
  private sigAux = '';

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
    /* свёрнутые панели и мини-карта — личные UI-настройки (не синхронизируются) */
    this.leftCollapsed = isClient && window.localStorage.getItem('vetvi-left-col') === '1';
    this.rightCollapsed = isClient && window.localStorage.getItem('vetvi-right-col') === '1';
    this.mmOn = isClient ? window.localStorage.getItem('vetvi-mm-on') !== '0' : true;
    /* пределы масштаба (настройки интерфейса) */
    if (isClient) {
      const zmin = Number(window.localStorage.getItem('vetvi-zoom-min'));
      const zmax = Number(window.localStorage.getItem('vetvi-zoom-max'));
      if (Number.isFinite(zmin) && zmin > 0) this.uiZoomMin = zmin;
      if (Number.isFinite(zmax) && zmax > 0) this.uiZoomMax = zmax;
      this.vp.z = clampZoom(this.vp.z, this.uiZoomMin, this.uiZoomMax);
    }
  }

  /* ── подписка ── */

  subscribe = (l: Listener): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  getSnapshot = (): number => this.revision;

  /** Эмит с каналом: 'all' (по умолчанию) трогает все счётчики — поведение как раньше;
   *  'doc'/'ui'/'geom' — точечные кадры. Подписчики (useSyncExternalStore) перерисовываются
   *  только если изменился ИХ счётчик. */
  emit(ch: 'all' | 'doc' | 'ui' | 'geom' = 'all'): void {
    this.revision++;
    if (ch === 'all' || ch === 'doc') this.docRev++;
    if (ch === 'all' || ch === 'ui') this.uiRev++;
    if (ch === 'all' || ch === 'geom') this.geomRev++;
    this.scheduleNotify();
  }

  /** Одно уведомление подписчиков на кадр: высокочастотные пути (перетаскивание нод,
   *  панорама, зум колесом 1000+ событий/сек, печать) больше не создают очередь
   *  рендеров — все эмитты одного кадра сливаются в один проход React.
   *  rAF + fallback-таймер: в скрытой вкладке rAF замирает. */
  private scheduleNotify(): void {
    if (this.notifyScheduled) return;
    this.notifyScheduled = true;
    const notify = () => {
      if (!this.notifyScheduled) return;
      this.notifyScheduled = false;
      if (this.notifyFallbackT) { clearTimeout(this.notifyFallbackT); this.notifyFallbackT = null; }
      this.listeners.forEach((l) => l());
    };
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(notify);
      this.notifyFallbackT = setTimeout(notify, 50);
    } else {
      queueMicrotask(notify);
    }
  }

  /**
   * Сигнатуры объектов документа: после каждой мутации нода/персонаж с изменившимся
   * содержимым ЗАМЕНЯЕТСЯ новым объектом ({...n}). Мутабельный документ остаётся
   * правдой, но React.memo карточек получает честный сигнал «данные изменились»
   * (сравнение по ссылке объекта). Дешевле полной перерисовки всех карточек на
   * каждое движение на порядки.
   */
  private refreshSigs(): void {
    const doc = this.doc;
    if (this.sigDocRef !== doc) {
      this.sigDocRef = doc;
      this.sigNodes.clear();
      this.sigChars.clear();
      this.sigAux = '';
    }
    const nodes = doc.nodes;
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      const sig = JSON.stringify(n);
      if (this.sigNodes.get(n.id) !== sig) {
        this.sigNodes.set(n.id, sig);
        nodes[i] = { ...n };
      }
    }
    if (this.sigNodes.size > nodes.length + 32) {
      const alive = new Set(nodes.map((x) => x.id));
      for (const k of Array.from(this.sigNodes.keys())) if (!alive.has(k)) this.sigNodes.delete(k);
    }
    const chars = Array.isArray(doc.chars) ? doc.chars : [];
    for (let i = 0; i < chars.length; i++) {
      const c = chars[i];
      const sig = JSON.stringify(c);
      if (this.sigChars.get(c.id) !== sig) {
        this.sigChars.set(c.id, sig);
        chars[i] = { ...c };
      }
    }
    if (this.sigChars.size > chars.length + 32) {
      const aliveC = new Set(chars.map((x) => x.id));
      for (const k of Array.from(this.sigChars.keys())) if (!aliveC.has(k)) this.sigChars.delete(k);
    }
    /* ссылочные данные карточек: переменные/группы/свои типы/палитра + состав связей
       (pts исключены — меняются только жестами с явной заменой объекта связи) */
    const aux = JSON.stringify([
      doc.vars || null,
      doc.varGroups || null,
      doc.customTypes || null,
      doc.palette || null,
      (doc.edges || []).map((e) => [
        e.id, e.from, e.to, e.kind || null, e.label ?? null,
        (e as unknown as { cond?: unknown }).cond ?? null,
        e.fromReply ?? null, e.fromOut ?? null, (e as unknown as { tin?: unknown }).tin ?? null,
        (e as unknown as { lt?: number | null }).lt ?? null, (e as unknown as { lp?: number | null }).lp ?? null,
        e.bd ? e.bd.dy : null,
      ]),
    ]);
    if (aux !== this.sigAux) {
      this.sigAux = aux;
      this.refVer++;
    }
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
    if (this.syncDiff && this.syncDiff.kind === 'local-server') this.syncDiff = null;
    this.scheduleSave();
    /* прямые мутации между beginEdit и commitEdit могли изменить ноды —
       обновить сигнатуры (замена объектов) до перерисовки memo-карточек */
    this.refreshSigs();
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
    /* roomId «липнет» только к своему проекту: если подключены к комнате другого
       проекта (диалог ещё открыт, фоновой автосейв сработал раньше ответа) —
       запись реестра текущего проекта не должна получить чужой roomId,
       иначе смена проектов вечно переподключается не в ту комнату. */
    let roomForEntry = this.syncRoom;
    if (roomForEntry && this.sync && this.sync.projectId) {
      const pid = typeof this.doc.meta.projectId === 'string' ? this.doc.meta.projectId : '';
      if (this.sync.projectId !== pid) roomForEntry = null;
    }
    projSaveCurrent(this.doc, this.vp, this.bend, roomForEntry);
    if (this.syncMode === 'copy' && this.sync) this.sync.persistCopyTick();
  }

  /** Мутация с записью в историю. fn меняет this.doc напрямую. */
  mutate(fn: (doc: VetviDoc) => void, opts?: { history?: boolean; label?: string; ch?: 'all' | 'doc' | 'ui' | 'geom' }): void {
    if (!opts || opts.history !== false) this.pushHistory(opts?.label);
    fn(this.doc);
    this.refreshSigs();
    this.noteEditor();
    /* правка после входа в комнату: локальная копия начинает следовать за серверной
       версией — блок «данные отличаются» (local-server) больше не актуален */
    if (this.syncDiff && this.syncDiff.kind === 'local-server') this.syncDiff = null;
    this.scheduleSave();
    this.emit(opts?.ch || 'all');
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

  /** Применение снимка истории/журнала (applySnap оригинала, 2127): заменяются только
   *  nodes/edges/groups/vars/chars/customTypes (плюс прочие структурные поля docFromParsed).
   *  МЕТА (имя, projectId, журнал действий, editLog) НЕ откатывается — иначе после отката
   *  проект с уходящей метой писал данные в другой слот и «откат не работал» в проектах,
   *  где снимки старше появления projectId. */
  private applyHistorySnap(snap: string): void {
    const d = docFromParsed(JSON.parse(snap));
    d.meta = this.doc.meta;
    this.doc = d;
    const ids = new Set(this.doc.nodes.map((n) => n.id));
    const ns = new Set<string>();
    for (const id of this.sel) if (ids.has(id)) ns.add(id);
    this.sel = ns;
    const eids = new Set(this.doc.edges.map((e) => e.id));
    const es = new Set<string>();
    for (const id of this.selEdges) if (eids.has(id)) es.add(id);
    this.selEdges = es;
    const gids = new Set(this.doc.groups.map((g) => g.id));
    const gs = new Set<string>();
    for (const id of this.selGroups) if (gids.has(id)) gs.add(id);
    this.selGroups = gs;
    this.noteSelFocus();
    this.noteEditor();
  }

  undo(): void {
    this.flushPendingLog();
    if (!this.past.length) return;
    const pre = this.serialize();
    this.future.push(pre);
    const snap = this.past.pop();
    this.applyHistorySnap(snap as string);
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
    this.applyHistorySnap(snap as string);
    this.logUndoRedo(pre, 'Повтор');
    this.toast('Повторено', 'ok');
    this.scheduleSave();
    this.emit();
  }

  canUndo(): boolean { return this.past.length > 0; }
  canRedo(): boolean { return this.future.length > 0; }

  logHistoryCount(): number { return this.past.length; }

  /** Откат проекта к моменту записи журнала (logRollbackProject оригинала):
   *  как applySnap — метаданные проекта не трогаются, откат можно отменить (undo). */
  rollbackToSnapshot(snap: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(snap);
    } catch {
      this.toast('Снимок повреждён — откат невозможен', 'warn');
      return;
    }
    const cur = this.serialize();
    if (cur === snap) {
      this.toast('Проект уже в этом состоянии', 'ok');
      return;
    }
    this.pushHistory('Откат проекта по журналу');
    const d = docFromParsed(parsed);
    d.meta = this.doc.meta;
    this.doc = d;
    this.sel.clear();
    this.selEdges.clear();
    this.selGroups.clear();
    this.noteSelFocus();
    this.noteEditor();
    this.scheduleSave();
    this.emit();
  }

  /** Немедленное сохранение в слот (saveNow оригинала: только localStorage,
   *  БЕЗ публикации в комнату — publish делает только queueState после реальных правок.
   *  Публикация здесь загрязняла комнату снимком чужого проекта при каждой смене
   *  проекта/перезагрузке страницы — источник «вечного» диалога про комнату). */
  flushSave(): void {
    this.flushPendingLog();
    if (this.saveT) { clearTimeout(this.saveT); this.saveT = null; }
    this.doc.meta.modified = Date.now();
    this.persist();
    this.saveState = 'saved';
    this.lastSavedAt = Date.now();
    /* режим IndexedDB: отложенная запись 350 мс не доживёт до выгрузки страницы —
       сбрасываем очередь в базу немедленно (закрытие вкладки, F5, смена проекта) */
    storeFlushNow();
    this.emit();
  }

  /* ── выделение ── */

  /** Трансляция «работаю здесь» соавторам после любого изменения выделения:
   *  выделена нода — показываем её, выделения нет (клик по пустому месту холста,
   *  снятие галочки, рамка) — метка снимается (focusTrack(null) → сервер удаляет
   *  фокус участника, плашка на чужой стороне исчезает). */
  private noteSelFocus(): void {
    /* любое изменение выделения (все селекторы вызывают этот метод) — новый «кадр»
       выделения: правая панель в свёрнутом режиме открывается именно по нему */
    this.selVer++;
    if (!this.sync) return;
    const first = this.sel.size ? (this.sel.values().next().value as string) : null;
    this.sync.focusTrack(first || null);
  }

  selectOnly(id: string): void {
    this.sel.clear();
    this.selEdges.clear();
    this.selGroups.clear();
    this.sel.add(id);
    this.emit();
    this.noteSelFocus();
  }

  toggleSelect(id: string): void {
    this.selEdges.clear();
    this.selGroups.clear();
    if (this.sel.has(id)) this.sel.delete(id);
    else this.sel.add(id);
    this.emit();
    /* выделение (даже Shift/Ctrl-добавление) — тоже «работаю здесь» для соавторов */
    this.noteSelFocus();
  }

  selectEdgeOnly(id: string): void {
    this.sel.clear();
    this.selEdges.clear();
    this.selGroups.clear();
    this.selEdges.add(id);
    this.emit();
    this.noteSelFocus();
  }

  toggleEdge(id: string): void {
    this.sel.clear();
    this.selGroups.clear();
    if (this.selEdges.has(id)) this.selEdges.delete(id);
    else this.selEdges.add(id);
    this.emit();
    this.noteSelFocus();
  }

  selectGroupOnly(id: string): void {
    this.sel.clear();
    this.selEdges.clear();
    this.selGroups.clear();
    this.selGroups.add(id);
    this.emit();
    this.noteSelFocus();
  }

  toggleGroup(id: string): void {
    this.sel.clear();
    this.selEdges.clear();
    if (this.selGroups.has(id)) this.selGroups.delete(id);
    else this.selGroups.add(id);
    this.emit();
    this.noteSelFocus();
  }

  setSel(nodes: string[], groups: string[] = []): void {
    this.selEdges.clear();
    this.sel = new Set(nodes);
    this.selGroups = new Set(groups);
    this.emit();
    this.noteSelFocus();
  }

  clearSelection(): void {
    if (!this.sel.size && !this.selEdges.size && !this.selGroups.size) return;
    this.sel.clear();
    this.selEdges.clear();
    this.selGroups.clear();
    this.emit();
    /* снятие выделения (клик по пустому месту) — снимаем и метку «работаю здесь» */
    this.noteSelFocus();
  }

  selectAll(): void {
    this.selEdges.clear();
    this.selGroups.clear();
    this.sel = new Set(this.doc.nodes.map((n) => n.id));
    this.emit();
    this.noteSelFocus();
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

  /** Сворачивание/разворачивание левой панели: свёрнутая — мини-рейка с иконками
   *  разделов, клик по иконке разворачивает панель и открывает раздел. */
  setLeftCollapsed(v: boolean): void {
    this.leftCollapsed = v;
    this.leftPeek = false;
    try { window.localStorage.setItem('vetvi-left-col', v ? '1' : '0'); } catch { /* нет доступа */ }
    this.emit();
  }

  /** Клик по иконке раздела в мини-рейке: панель разворачивается на этом разделе,
   *  но в режиме «подглядывания» (leftPeek) — клик мимо панели сворачивает её
   *  обратно. localStorage не трогаем: после перезагрузки панель снова свёрнута. */
  openLeftSection(t: 'pal' | 'list' | 'vars' | 'chars'): void {
    this.leftTab = t;
    this.leftCollapsed = false;
    this.leftPeek = true;
    this.emit();
  }

  /** Сворачивание правой панели: после сворачивания она открывается только при
   *  выделении объекта. Запоминаем версию выделения на момент сворачивания —
   *  пока выделение не сменилось, панель не переоткрывается. */
  setRightCollapsed(v: boolean): void {
    this.rightCollapsed = v;
    if (v) this.rightCollapseVer = this.selVer;
    try { window.localStorage.setItem('vetvi-right-col', v ? '1' : '0'); } catch { /* нет доступа */ }
    this.emit();
  }

  /** Кнопка «Мини-карта» тулбара (#bMap оригинала, строка 9371): переключает
   *  видимость #miniMap (класс mm-hidden), состояние — личная настройка. */
  toggleMm(): void {
    this.mmOn = !this.mmOn;
    try { window.localStorage.setItem('vetvi-mm-on', this.mmOn ? '1' : '0'); } catch { /* нет доступа */ }
    this.emit();
  }

  /** Пределы масштаба холста (настройки интерфейса): минимум — до скольки можно
   *  отдалить, максимум — до скольки приблизить. Значения валидируются (0.01…10,
   *  min < max), текущий вид переприжимается к новым границам. Личная настройка. */
  setZoomLimits(min: number, max: number): void {
    const lo = Math.min(10, Math.max(0.01, Number(min) || 0.1));
    const hi = Math.min(10, Math.max(0.01, Number(max) || 3));
    this.uiZoomMin = Math.min(lo, hi);
    this.uiZoomMax = Math.max(lo, hi);
    try {
      window.localStorage.setItem('vetvi-zoom-min', String(this.uiZoomMin));
      window.localStorage.setItem('vetvi-zoom-max', String(this.uiZoomMax));
    } catch { /* нет доступа */ }
    /* текущий зум может выйти за новые границы — прижать и применить вид */
    const z = clampZoom(this.vp.z, this.uiZoomMin, this.uiZoomMax);
    if (z !== this.vp.z) this.setViewport({ z });
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

  updateNode(id: string, patch: Partial<VetviNode>, opts?: { history?: boolean; label?: string; ch?: 'all' | 'doc' | 'ui' | 'geom' }): void {
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
    this.updateNode(id, { dlgWidth: clamp(Math.round(w), 216, 1200) }, { history: false, ch: 'geom' });
    this.touchPos('n:' + id);
    const n = this.nodeById(id);
    if (n && this.sync) this.sync.liveDlg(n);
  }

  /** «Выдернуть ноду» (detachNode оригинала, 6604): все связи ноды удаляются,
   *  входящие перекидываются на исходящие (A→N→B превращается в A→B) — цепочка
   *  сохраняется. САМА НОДА ОСТАЁТСЯ на холсте (в React-версии она ошибочно
   *  удалялась — через контекстное меню нода и стрелки исчезали).
   *  opts.history:false — жест «выдергивания» (Alt+ЛКМ по ноде): запись истории
   *  сделает dragEnd одним шагом «до жеста → после» (как pre оригинала 8177). */
  detachNode(id: string, opts?: { history?: boolean }): void {
    let extracted = false;
    this.mutate((doc) => {
      const ins = doc.edges.filter((e) => e.to === id && e.from !== id);
      const outs = doc.edges.filter((e) => e.from === id && e.to !== id);
      if (!ins.length && !outs.length) return;
      const bypass: VetviEdge[] = [];
      for (const ei of ins) {
        for (const eo of outs) {
          if (ei.from === eo.to) continue;
          const dup = doc.edges.some((x) => x.from === ei.from && x.to === eo.to && x.fromReply === ei.fromReply)
            || bypass.some((x) => x.from === ei.from && x.to === eo.to && x.fromReply === ei.fromReply);
          if (!dup) bypass.push(newEdge(ei.from, eo.to, ei.fromOut));
        }
      }
      doc.edges = doc.edges.filter((e) => e.from !== id && e.to !== id).concat(bypass);
      extracted = true;
    }, { label: 'Выдернуть ноду', history: opts?.history !== false });
    if (extracted && opts?.history !== false) this.toast('Узел выдернут, цепочка сохранена', 'ok');
    this.emit();
  }

  dragStartSnapshot: string | null = null;
  dragMoved = false;

  /* ── время последнего локального сдвига объекта (позиционная гонка синка) ──
     Когда отложенный снимок комнаты применяется после жеста, объекты, сдвинутые
     локально ПОСЛЕ прихода снимка, не перезаписываются устаревшими координатами —
     иначе нода «прыгает» обратно и обе стороны начинают гонять позиции по кругу. */
  posTouched: Map<string, number> = new Map();

  /** Отметить объект как локально сдвинутый сейчас (n:<id>/g:<gid>/e:<eid>). */
  touchPos(key: string): void {
    this.posTouched.set(key, Date.now());
    if (this.posTouched.size > 3000) {
      const cut = Date.now() - 60000;
      for (const [k, t] of this.posTouched) {
        if (t < cut) this.posTouched.delete(k);
      }
      if (this.posTouched.size > 3000) this.posTouched.clear();
    }
  }

  /** Идентификаторы объектов активного жеста холста ('n:id'/'g:id'/'e:id'). */
  gestureIds: Set<string> = new Set();

  setGestureIds(ids: Iterable<string>): void {
    this.gestureIds = new Set(ids);
  }

  dragBegin(): void {
    this.dragStartSnapshot = this.serialize();
    this.dragMoved = false;
  }

  dragMoveBy(dx: number, dy: number): void {
    if (!dx && !dy) return;
    this.dragMoved = true;
    const nodes = this.doc.nodes;
    for (const id of this.sel) {
      const i = nodes.findIndex((x) => x.id === id);
      if (i < 0) continue;
      const n = nodes[i];
      /* новый объект — честный сигнал перерисовки для memo-карточки */
      nodes[i] = { ...n, x: n.x + dx, y: n.y + dy };
      this.touchPos('n:' + id);
    }
    this.emit('geom');
    if (this.sync) this.sync.liveDrag({ ids: this.sel });
  }

  dragEnd(): void {
    if (this.dragMoved && this.dragStartSnapshot) {
      const snap = this.dragStartSnapshot;
      this.dragStartSnapshot = null;
      this.dragMoved = false;
      if (this.snapOn) {
        const nodes = this.doc.nodes;
        for (const id of this.sel) {
          const i = nodes.findIndex((x) => x.id === id);
          if (i < 0) continue;
          const n = nodes[i];
          nodes[i] = { ...n, x: snapVal(n.x, true), y: snapVal(n.y, true) };
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
    this.gestureIds.clear();
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
    if (!this.sel.size) { this.toast('Нет узлов для дублирования', 'warn'); return null; }
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
    /* оригинал (6547–6565): история пишется один раз — при размещении переносимого дубликата */
    this.mutate((doc) => {
      doc.nodes.push(...clones);
      doc.edges.push(...newEdges);
    }, { history: false, label: 'Дублирование (' + clones.length + ')' });
    this.sel = new Set(ids);
    this.selEdges.clear();
    this.selGroups.clear();
    this.emit();
    return { ids, pre };
  }

  alignH(): void { this.alignSelAxis(false); }

  alignV(): void { this.alignSelAxis(true); }

  /** alignSelAxis оригинала (6621): ряд/столбец с отступами вокруг общего центра выделения. */
  private alignSelAxis(vert: boolean): void {
    const ids: string[] = [];
    for (const id of this.sel) {
      const n = this.nodeById(id);
      if (n && !collapsedAncestorOf(this.doc, id)) ids.push(id);
    }
    if (ids.length < 2) { this.toast('Выделите минимум два узла', 'warn'); return; }
    const dims = (id: string): { w: number; h: number } => {
      const n = this.nodeById(id);
      const el = this.dimsFn ? this.dimsFn(id) : null;
      return { w: el && el.w > 0 ? el.w : this.dlgNodeWidthOf(n!), h: el && el.h > 0 ? el.h : 90 };
    };
    const GAP = 70;
    let bnx = 1e9, bny = 1e9, bxx = -1e9, bxy = -1e9, scx = 0, scy = 0;
    ids.forEach((id) => {
      const n = this.nodeById(id)!; const d = dims(id);
      bnx = Math.min(bnx, n.x); bny = Math.min(bny, n.y);
      bxx = Math.max(bxx, n.x + d.w); bxy = Math.max(bxy, n.y + d.h);
      scx += n.x + d.w / 2; scy += n.y + d.h / 2;
    });
    const ccx = scx / ids.length, ccy = scy / ids.length;
    const vertSpread = (bxy - bny) >= (bxx - bnx); /* стояли вертикально → порядок сверху вниз (и наоборот) */
    const order = ids.slice().sort((p, q) => {
      const a = this.nodeById(p)!, b = this.nodeById(q)!, da = dims(p), db = dims(q); let d: number;
      if (vertSpread) {
        d = (a.y + da.h / 2) - (b.y + db.h / 2);
        if (d) return d;
        return (a.x + da.w / 2) - (b.x + db.w / 2);
      }
      d = (a.x + da.w / 2) - (b.x + db.w / 2);
      if (d) return d;
      return (a.y + da.h / 2) - (b.y + db.h / 2);
    });
    let total = 0;
    order.forEach((id) => { total += dims(id)[vert ? 'h' : 'w']; });
    total += GAP * (order.length - 1);
    const cursor0 = vert ? ((bny + bxy) / 2 - total / 2) : ((bnx + bxx) / 2 - total / 2);
    this.mutate((doc) => {
      let cursor = cursor0;
      for (const id of order) {
        const n = doc.nodes.find((m) => m.id === id);
        if (!n) continue;
        const d = dims(id);
        if (vert) { n.x = Math.round(ccx - d.w / 2); n.y = Math.round(cursor); cursor += d.h + GAP; }
        else { n.x = Math.round(cursor); n.y = Math.round(ccy - d.h / 2); cursor += d.w + GAP; }
        if (this.snapOn) { n.x = Math.round(n.x / GRID) * GRID; n.y = Math.round(n.y / GRID) * GRID; }
      }
    }, { label: vert ? 'Выравнивание нод по вертикали' : 'Выравнивание нод по горизонтали' });
    this.toast(vert ? 'Выровнено по вертикали — столбец с отступами' : 'Выровнено по горизонтали — ряд с отступами');
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
    const edges = this.doc.edges;
    const i = edges.findIndex((x2) => x2.id === id);
    if (i < 0) return;
    const e = edges[i];
    if (!Array.isArray(e.pts) || !e.pts[index]) return;
    /* новый массив + новый объект связи — сигнал пересборки геометрии */
    edges[i] = { ...e, pts: e.pts.map((p, pi) => (pi === index ? { x: Math.round(x), y: Math.round(y) } : p)) };
    this.touchPos('e:' + id);
    this.emit('geom');
    if (this.sync) this.sync.livePts(edges[i]);
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
    const edges = this.doc.edges;
    const i = edges.findIndex((x2) => x2.id === id);
    if (i < 0) return;
    const e = edges[i];
    edges[i] = { ...e, bd: { dl: Math.round(dl), dy: Math.round(dy), dr: Math.round(dr) } };
    this.touchPos('e:' + id);
    this.emit('geom');
  }

  bridgeDragEnd(pre: string): void {
    this.commitEdit(pre, 'Правка моста');
  }

  /** Разрез стрелок ножом по траектории (knifeS.path оригинала, 8435–8460):
   *  пересекаются все связи, чья полилиния пересекает ЛЮБОЙ отрезок пути жеста.
   *  Раньше резалась только прямая «старт—конец» — короткий надрез поперёк стрелки
   *  не срабатывал, приходилось вести длинный разрез. */
  knifeCutPath(path: { x: number; y: number }[], sampleFn: (e: VetviEdge) => { x: number; y: number }[] | null): number {
    const pre = this.serialize();
    const victims: string[] = [];
    if (path.length < 2) return 0;
    for (const e of this.doc.edges) {
      const pts = sampleFn(e);
      if (!pts) continue;
      let hit = false;
      for (let i = 0; i < pts.length - 1 && !hit; i++) {
        const a = pts[i];
        const b = pts[i + 1];
        for (let j = 0; j < path.length - 1; j++) {
          const l1 = path[j];
          const l2 = path[j + 1];
          const d1x = l2.x - l1.x;
          const d1y = l2.y - l1.y;
          const d2x = b.x - a.x;
          const d2y = b.y - a.y;
          const denom = d1x * d2y - d1y * d2x;
          if (Math.abs(denom) < 1e-9) continue;
          const t = ((a.x - l1.x) * d2y - (a.y - l1.y) * d2x) / denom;
          const u = ((a.x - l1.x) * d1y - (a.y - l1.y) * d1x) / denom;
          if (t >= 0 && t <= 1 && u >= 0 && u <= 1) { victims.push(e.id); hit = true; break; }
        }
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
    /* позиции пишутся через putNode (замена объекта в doc.nodes): карточка ноды —
       memo по ССЫЛКЕ объекта (a.node === b.node), мутация x/y на месте не
       перерисовывает карточку — стрелки тогда рисуются к «новому» месту, а сама
       нода визуально остаётся на старом (главная причина «стрелки входа и
       выхода рисуются не на входе и выходе вставленной ноды») */
    const putNode = (id: string, x: number, y: number) => {
      const i = doc.nodes.findIndex((q) => q.id === id);
      if (i >= 0) doc.nodes[i] = { ...doc.nodes[i], x: Math.round(x), y: Math.round(y) };
    };
    let nx = n.x;
    let ny = n.y;
    if (p) {
      nx = p.x - (d0 ? d0.w : NODE_W) / 2;
      ny = p.y - hh / 2;
    }
    /* место для изгибов (фикс «стрелки подключаются как попало»): обе новые связи
       (A→n в ЛЕВУЮ грань ноды — её «вход», n→B из правого нижнего якоря — её
       «выход») обязаны идти «вперёд» с запасом — при тесных краях контрольные
       точки кубика перекрещиваются и связи дают петли-зацепы, а стрелки
       визуально входят/выходят не на входе/выходе вставленной ноды.
       Раздвижка ведётся по ВЗАИМНОМУ РАСПОЛОЖЕНИЮ СОСЕДОВ (центр B относительно
       центра A), а не по якорям связи: связь из нижнего якоря A в левую грань B
       часто «вертикальна» даже у горизонтальных соседей — старое условие по
       доминанте якорей отключало раздвижку ровно на изогнутых связях тесных нод
       (скрин: нода наезжает на соседей, стрелки не входят в разъёмы).
       Горизонтальные соседи: раздвигаем A/B по X (A влево, B вправо — порядок
       сохраняется), n зажимаем между ними с зазором GAP. Обратные связи (B левее
       A) — без раздвижки: S-кривые edgePathD (формула x2<x1) дают аккуратные
       встречные дуги. Вертикальные соседи (A над B или под B): n встраивается
       «лесенкой» — правее правого края A (стрелка входит в левую грань-разъём),
       вертикально между A и B; если по высоте места мало — раздвижка по Y: A
       уходит от n вверх, B — вниз (или наоборот при B выше), тоже с сохранением
       порядка. */
    let spread = false;
    let nx0 = nx;
    let ny0 = ny;
    if (gm && p && A !== B) {
      const na = doc.nodes.find((x) => x.id === A);
      const nb = doc.nodes.find((x) => x.id === B);
      if (na && nb) {
        const GAP = 72;
        const GAPV = 56;
        const dA = this.dimsOf(na.id);
        const dB = this.dimsOf(nb.id);
        const wN = d0 ? d0.w : NODE_W;
        const hN = hh;
        const dcx = (nb.x + dB.w / 2) - (na.x + dA.w / 2);
        const dcy = (nb.y + dB.h / 2) - (na.y + dA.h / 2);
        if (Math.abs(dcx) >= Math.abs(dcy)) {
          /* «вперёд» — по фактическому расположению нод (центр B правее центра A) */
          if (dcx >= 0) {
            let lo = na.x + dA.w + GAP;
            let hi = nb.x - wN - GAP;
            if (lo > hi) {
              const deficit = lo - hi;
              putNode(na.id, na.x - deficit / 2, na.y);
              putNode(nb.id, nb.x + deficit / 2, nb.y);
              const na2 = doc.nodes.find((x) => x.id === A);
              const nb2 = doc.nodes.find((x) => x.id === B);
              lo = (na2 ? na2.x : na.x) + dA.w + GAP;
              hi = (nb2 ? nb2.x : nb.x) - wN - GAP;
              spread = deficit > 0;
            }
            if (nx < lo) nx = lo;
            else if (nx > hi) nx = hi;
          }
        } else {
          /* вертикальные соседи: слот для n — по вертикали между A и B */
          const below = dcy >= 0; /* B ниже A */
          let lo = below ? na.y + dA.h + GAPV : nb.y + dB.h + GAPV;
          let hi = below ? nb.y - hN - GAPV : na.y - hN - GAPV;
          if (lo > hi) {
            const deficit = lo - hi;
            if (below) {
              putNode(na.id, na.x, na.y - deficit / 2);
              putNode(nb.id, nb.x, nb.y + deficit / 2);
            } else {
              putNode(na.id, na.x, na.y + deficit / 2);
              putNode(nb.id, nb.x, nb.y - deficit / 2);
            }
            const na2 = doc.nodes.find((x) => x.id === A);
            const nb2 = doc.nodes.find((x) => x.id === B);
            lo = below ? (na2 ? na2.y : na.y) + dA.h + GAPV : (nb2 ? nb2.y : nb.y) + dB.h + GAPV;
            hi = below ? (nb2 ? nb2.y : nb.y) - hN - GAPV : (na2 ? na2.y : na.y) - hN - GAPV;
            spread = deficit > 0;
          }
          if (ny < lo) ny = lo;
          else if (ny > hi) ny = hi;
          /* «лесенка»: вход вставленной ноды — её левая грань, поэтому n правее
             правого края A (стрелка A→n заходит в разъём входа «вперёд», без
             обратной петли); наезд на B гасит resolveOverlaps (n фиксирована) */
          const na3 = doc.nodes.find((x) => x.id === A);
          if (na3 && nx < na3.x + dA.w + 24) nx = na3.x + dA.w + 24;
        }
      }
    }
    putNode(n.id, nx, ny);
    /* при раздвижке/сдвиге старые waypoints исходной связи (абсолютные точки
       бывшей кривой) больше не совпадают с новой геометрией: связь A→n могла
       петляться НАЗАД к входу вставленной ноды — сбрасываем, гладкий кубик
       честнее. Если нода легла ровно в точку дропа — изгибы сохраняются. */
    const nMoved = spread || Math.abs(nx - nx0) > 2 || Math.abs(ny - ny0) > 2;
    const ptsA = nMoved ? [] : (sp[0] || []);
    const ptsB = nMoved ? [] : (sp[1] || []);
    doc.edges.push({ id: uid(), from: A, to: n.id, label: '', kind, pts: ptsA, lt: 0.5, lp: 0, fromReply: fromReplyA, fromOut: null, bd: { dl: 0, dy: 0, dr: 0 } });
    doc.edges.push({ id: uid(), from: n.id, to: B, label, kind, pts: ptsB, lt: 0.5, lp: 0, fromReply: null, fromOut: null, bd: { dl: 0, dy: 0, dr: 0 } });
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
   * frameOverride — снимок рамок на момент старта перетаскивания ноды: авторамки
   * «морожены» на время жеста (не растягиваются и не следуют за нодой), и решение
   * «остаться в группе / выйти» принимается по той же замороженной рамке.
   */
  deepestGroupAt(wx: number, wy: number, sizes: Map<string, NodeSize>, cardSizes: Map<string, { w: number; h: number }>, frameOverride?: Map<string, { x: number; y: number; w: number; h: number }> | null): VetviGroup | null {
    let best: VetviGroup | null = null;
    let bestDepth = -1;
    for (const g of this.doc.groups) {
      if (this.groupInsideCollapsed(g)) continue;
      const fold = g.fold === undefined ? 2 : g.fold;
      let r: { x: number; y: number; w: number; h: number };
      const frozen = frameOverride ? frameOverride.get(g.id) : null;
      if (fold === 2) r = frozen || groupFrameRect(this.doc, g, sizes, cardSizes);
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
        this.setNodePos(g.n.id, g.fromX + (g.toX - g.fromX) * e2, g.fromY + (g.toY - g.fromY) * e2);
      }
      this.emit('geom');
      if (k < 1) {
        requestAnimationFrame(step);
      } else {
        this.busyAnim = false;
        this.scheduleSave();
        this.emit('all');
      }
    };
    requestAnimationFrame(step);
  }

  /**
   * Позиция ноды без истории (жесты/анимация/перенос дубликата): замена объекта
   * ноды — сигнал перерисовки memo-карточки. Без эмита (жест эмитит один раз за кадр).
   */
  setNodePos(id: string, x: number, y: number): void {
    const nodes = this.doc.nodes;
    const i = nodes.findIndex((x2) => x2.id === id);
    if (i < 0) return;
    const n = nodes[i];
    if (n.x === x && n.y === y) return;
    nodes[i] = { ...n, x, y };
    this.touchPos('n:' + id);
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

  /** Перестановка реплики перетаскиванием (drop в dlgModal оригинала 4937–4945):
   *  только среди соседей одного уровня (проверка вызывающего), вставка выше/ниже цели. */
  moveReplyPair(nodeId: string, srcRid: string, tgtRid: string, below: boolean): boolean {
    let moved = false;
    this.mutate((doc) => {
      const n = doc.nodes.find((x) => x.id === nodeId);
      if (!n || !n.dialog) return;
      const findLoc = (arr: VetviReply[], id: string, parent: VetviReply[] | null): { arr: VetviReply[]; idx: number; parent: VetviReply[] | null } | null => {
        for (let i = 0; i < arr.length; i++) {
          if (arr[i].id === id) return { arr, idx: i, parent };
          const ch = arr[i].children;
          if (ch && ch.length) {
            const hit = findLoc(ch, id, arr);
            if (hit) return hit;
          }
        }
        return null;
      };
      const s = findLoc(n.dialog.replies, srcRid, null);
      const t = findLoc(n.dialog.replies, tgtRid, null);
      if (!s || !t || s.parent !== t.parent) return;
      const m = s.arr.splice(s.idx, 1)[0];
      const insAt = (s.idx < t.idx) ? (t.idx - 1) : t.idx;
      t.arr.splice(below ? insAt + 1 : insAt, 0, m);
      moved = true;
    }, { label: 'Порядок реплик' });
    return moved;
  }

  /**
   * Свободное перетаскивание реплики с автоподстройкой вложенности (новое поведение,
   * запрос 2024-11): реплику можно бросить в любое место дерева —
   *  place='before'/'after' — соседом цели (вложенная становится корневой рядом с
   *    корневой и наоборот — уровень берётся от цели);
   *  place='inside' — последним ответом-веткой внутри цели;
   *  place='root' — корневой в конец списка (бросок на пустое место списка).
   * Поддерево реплики переезжает целиком; бросок внутрь собственного поддерева запрещён.
   */
  moveReplyTo(nodeId: string, srcRid: string, tgtRid: string | null, place: 'before' | 'after' | 'inside' | 'root'): boolean {
    let moved = false;
    this.mutate((doc) => {
      const n = doc.nodes.find((x) => x.id === nodeId);
      if (!n || !n.dialog) return;
      const replies = Array.isArray(n.dialog.replies) ? n.dialog.replies : (n.dialog.replies = []);
      const findLoc = (arr: VetviReply[], id: string): { arr: VetviReply[]; idx: number } | null => {
        for (let i = 0; i < arr.length; i++) {
          if (arr[i].id === id) return { arr, idx: i };
          const ch = arr[i].children;
          if (ch && ch.length) {
            const hit = findLoc(ch, id);
            if (hit) return hit;
          }
        }
        return null;
      };
      const s = findLoc(replies, srcRid);
      if (!s) return;
      if (!tgtRid || place === 'root') {
        /* в корень, в конец списка */
        if (s.arr === replies && s.idx === replies.length - 1) return;
        const m = s.arr.splice(s.idx, 1)[0];
        replies.push(m);
        moved = true;
        return;
      }
      if (srcRid === tgtRid) return;
      const t0 = findLoc(replies, tgtRid);
      if (!t0) return;
      /* бросок внутрь собственного поддерева запрещён (цикл): цель не должна
         лежать в поддереве ПЕРЕНОСИМОЙ реплики. Проверка ведётся ИЗ источника.
         ВАЖНО: обратная ситуация — источник лежит в поддереве цели (цель —
         предок) — это легальный подъём по цепочке (внук становится прямым
         ребёнком корневой); прежняя инвертированная проверка молча отклоняла
         такие броски, и реплика «возвращалась на место» при попытке перетащить
         её в свою же корневую или просто уровнем выше. */
      const tgtInsideSrc = (r: VetviReply): boolean => {
        if (r.id === tgtRid) return true;
        for (const ch of r.children || []) if (tgtInsideSrc(ch)) return true;
        return false;
      };
      if (tgtInsideSrc(s.arr[s.idx])) return;
      const m = s.arr.splice(s.idx, 1)[0];
      /* после удаления позиция цели могла сдвинуться — ищем заново */
      const t = findLoc(replies, tgtRid);
      if (!t) { s.arr.splice(s.idx, 0, m); return; }
      if (place === 'inside') {
        const tr = t.arr[t.idx];
        if (!Array.isArray(tr.children)) tr.children = [];
        tr.children.push(m);
      } else {
        t.arr.splice(place === 'before' ? t.idx : t.idx + 1, 0, m);
      }
      moved = true;
    }, { label: 'Порядок реплик' });
    return moved;
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
      n.outcomes.push({ id: uid(), label: '', cond: null, conds: [], condJoin: 'and' } as unknown as typeof n.outcomes[number]);
    }, { label: 'Новый исход' });
  }

  /** Правка списка условий исхода (несколько условий + способ объединения). */
  setOutcomeConds(nodeId: string, oid: string, conds: Cond[], join: 'and' | 'or', label: string, opts?: { history?: boolean }): void {
    this.mutate((doc) => {
      const n = doc.nodes.find((x) => x.id === nodeId);
      if (!n || !Array.isArray(n.outcomes)) return;
      const o = n.outcomes.find((x) => x.id === oid);
      if (!o) return;
      o.conds = conds;
      o.condJoin = join;
      (o as unknown as { cond?: unknown }).cond = conds.length ? conds[0] : null;
    }, opts ? { ...opts, label } : { label });
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

  /** Перестановка исходов перетаскиванием за строку (branchMoveOutcome оригинала 5850). */
  moveOutcomePair(nodeId: string, srcOid: string, tgtOid: string, below: boolean): boolean {
    let changed = false;
    this.mutate((doc) => {
      const n = doc.nodes.find((x) => x.id === nodeId);
      if (!n || !Array.isArray(n.outcomes)) return;
      const arr = n.outcomes as { id: string }[];
      const s = arr.findIndex((o) => o.id === srcOid);
      const t = arr.findIndex((o) => o.id === tgtOid);
      if (s < 0 || t < 0 || s === t) return;
      const m = arr.splice(s, 1)[0];
      const insAt = (s < t) ? (t - 1) : t;
      arr.splice(below ? insAt + 1 : insAt, 0, m);
      changed = true;
    }, { label: 'Изменение порядка исходов' });
    return changed;
  }

  /** Перестановка кнопок действия перетаскиванием (actionMoveAction оригинала). */
  moveActionPair(nodeId: string, srcAid: string, tgtAid: string, below: boolean): boolean {
    let changed = false;
    this.mutate((doc) => {
      const n = doc.nodes.find((x) => x.id === nodeId);
      if (!n || !Array.isArray(n.actions)) return;
      const arr = n.actions as { id: string }[];
      const s = arr.findIndex((a) => a.id === srcAid);
      const t = arr.findIndex((a) => a.id === tgtAid);
      if (s < 0 || t < 0 || s === t) return;
      const m = arr.splice(s, 1)[0];
      const insAt = (s < t) ? (t - 1) : t;
      arr.splice(below ? insAt + 1 : insAt, 0, m);
      changed = true;
    }, { label: 'Изменение порядка кнопок' });
    return changed;
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

  /* ── группы переменных (сортировка списка, аналог групп персонажей) ── */

  varGroups(): VetviVarGroup[] {
    return this.doc.varGroups || [];
  }

  addVarGroup(): VetviVarGroup {
    const g: VetviVarGroup = {
      id: 'g' + Date.now().toString(36) + Math.floor(Math.random() * 10000).toString(36),
      name: 'Новая группа',
    };
    this.mutate((doc) => {
      if (!Array.isArray(doc.varGroups)) doc.varGroups = [];
      doc.varGroups.push(g);
    }, { label: 'Создание группы переменных' });
    this.toast('Группа «' + g.name + '» создана', 'ok');
    return g;
  }

  updateVarGroup(id: string, patch: Partial<VetviVarGroup>, opts?: { history?: boolean; label?: string }): void {
    this.mutate((doc) => {
      const g = (doc.varGroups || []).find((x) => x.id === id);
      if (g) Object.assign(g, patch);
    }, opts);
  }

  /** Удаление группы: сами переменные не удаляются — выкидываются из группы (groupId → null). */
  deleteVarGroup(id: string): void {
    const g = (this.doc.varGroups || []).find((x) => x.id === id);
    this.mutate((doc) => {
      doc.varGroups = (doc.varGroups || []).filter((x) => x.id !== id);
      for (const v of doc.vars || []) {
        if ((v as { groupId?: string | null }).groupId === id) (v as { groupId?: string | null }).groupId = null;
      }
    }, { label: 'Удаление группы переменных' });
    this.toast('Группа «' + (g ? g.name : '') + '» удалена — переменные выведены из неё', 'warn');
  }

  /** Сворачивание группы переменных — ЛОКАЛЬНОЕ действие, соавторам не транслируется. */
  toggleVarGroupCollapsed(id: string): void {
    if (this.varGroupsFold.has(id)) this.varGroupsFold.delete(id);
    else this.varGroupsFold.add(id);
    this.emit();
  }

  charGroupFolded(id: string): boolean {
    return this.charGroupsFold.has(id);
  }

  varGroupFolded(id: string): boolean {
    return this.varGroupsFold.has(id);
  }

  /** Перенос переменной в группу (null — без группы). */
  setVarGroup(vid: string, gid: string | null, opts?: { history?: boolean; label?: string }): void {
    const cur = (this.doc.vars || []).find((x) => x.id === vid);
    if (!cur) return;
    if (((cur as { groupId?: string | null }).groupId || null) === (gid || null)) return;
    const gname = gid ? ((this.doc.varGroups || []).find((g) => g.id === gid)?.name || '') : '';
    this.updateVar(vid, { groupId: gid || null }, opts || { label: gid ? 'Перенос переменной в группу' : 'Переменная без группы' });
    if (!opts) this.toast(gid ? 'Переменная перенесена в группу «' + gname + '»' : 'Переменная выведена из группы', 'ok');
  }

  /**
   * Позиционная перестановка переменной (для drag&drop списка): вставить рядом
   * с refVid (before/after) внутри зоны группы gid, или в конец зоны (refVid=null).
   * Порядок членов группы определяется порядком в doc.vars — перестановка делается
   * именно в общем массиве, с одновременной сменой groupId.
   */
  placeVarInList(vid: string, gid: string | null, refVid: string | null, place: 'before' | 'after'): void {
    const cur = (this.doc.vars || []).find((x) => x.id === vid);
    if (!cur) return;
    const same = ((cur as { groupId?: string | null }).groupId || null) === (gid || null);
    const ref = refVid ? (this.doc.vars || []).find((x) => x.id === refVid) : null;
    if (same && !ref) return; /* бросили в пустое место своей же зоны — нечего делать */
    this.mutate((doc) => {
      const arr = doc.vars || (doc.vars = []);
      const meIdx = arr.findIndex((x) => x.id === vid);
      if (meIdx < 0) return;
      const [me] = arr.splice(meIdx, 1);
      (me as { groupId?: string | null }).groupId = gid || null;
      let inserted = false;
      if (refVid && refVid !== vid && arr.some((x) => x.id === refVid)) {
        const idx = arr.findIndex((x) => x.id === refVid);
        arr.splice(place === 'after' ? idx + 1 : idx, 0, me);
        inserted = true;
      }
      if (!inserted && gid) {
        let last = -1;
        arr.forEach((x, i) => { if ((x as { groupId?: string | null }).groupId === gid) last = i; });
        arr.splice(last >= 0 ? last + 1 : arr.length, 0, me);
        inserted = true;
      }
      if (!inserted) arr.splice(Math.min(meIdx, arr.length), 0, me); /* без группы — вернуть на прежнее место */
    }, { label: 'Перестановка переменной' });
  }

  /** Перестановка группы переменных на позицию toIndex (индекс в текущем массиве до переноса). */
  moveVarGroup(id: string, toIndex: number): void {
    this.mutate((doc) => {
      const arr = doc.varGroups || [];
      const from = arr.findIndex((g) => g.id === id);
      if (from < 0 || toIndex < 0 || toIndex > arr.length) return;
      const [g] = arr.splice(from, 1);
      let idx = toIndex;
      if (idx > from) idx -= 1;
      idx = Math.max(0, Math.min(arr.length, idx));
      arr.splice(idx, 0, g);
    }, { label: 'Перестановка групп переменных' });
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

  /* ── группы персонажей (сортировка списка) ── */

  charGroups(): VetviCharGroup[] {
    return this.doc.charGroups || [];
  }

  addCharGroup(): VetviCharGroup {
    const g: VetviCharGroup = {
      id: 'g' + Date.now().toString(36) + Math.floor(Math.random() * 10000).toString(36),
      name: 'Новая группа',
    };
    this.mutate((doc) => {
      if (!Array.isArray(doc.charGroups)) doc.charGroups = [];
      doc.charGroups.push(g);
    }, { label: 'Создание группы персонажей' });
    this.toast('Группа «' + g.name + '» создана', 'ok');
    return g;
  }

  updateCharGroup(id: string, patch: Partial<VetviCharGroup>, opts?: { history?: boolean; label?: string }): void {
    this.mutate((doc) => {
      const g = (doc.charGroups || []).find((x) => x.id === id);
      if (g) Object.assign(g, patch);
    }, opts);
  }

  /** Удаление группы: сами персонажи не удаляются — выкидываются из группы (groupId → null). */
  deleteCharGroup(id: string): void {
    const g = (this.doc.charGroups || []).find((x) => x.id === id);
    this.mutate((doc) => {
      doc.charGroups = (doc.charGroups || []).filter((x) => x.id !== id);
      for (const c of doc.chars || []) {
        if (c.groupId === id) c.groupId = null;
      }
    }, { label: 'Удаление группы персонажей' });
    this.toast('Группа «' + (g ? g.name : '') + '» удалена — персонажи выведены из неё', 'warn');
  }

  /** Перенос персонажа в группу (null — без группы). */
  setCharGroup(cid: string, gid: string | null, opts?: { history?: boolean; label?: string }): void {
    const cur = this.charById(cid);
    if (!cur) return;
    if ((cur.groupId || null) === (gid || null)) return;
    const gname = gid ? ((this.doc.charGroups || []).find((g) => g.id === gid)?.name || '') : '';
    this.updateChar(cid, { groupId: gid || null }, opts || { label: gid ? 'Перенос персонажа в группу' : 'Персонаж без группы' });
    if (!opts) this.toast(gid ? 'Персонаж перенесён в группу «' + gname + '»' : 'Персонаж выведен из группы', 'ok');
  }

  /** Сворачивание группы персонажей — ЛОКАЛЬНОЕ действие, соавторам не транслируется:
   *  у каждого юзера свой вид списка. */
  toggleCharGroupCollapsed(id: string): void {
    if (this.charGroupsFold.has(id)) this.charGroupsFold.delete(id);
    else this.charGroupsFold.add(id);
    this.emit();
  }

  /**
   * Позиционная перестановка персонажа (для drag&drop списка): вставить рядом
   * с refCid (before/after) внутри зоны группы gid, или в конец зоны (refCid=null).
   * Порядок членов группы определяется порядком в doc.chars — поэтому перестановка
   * делается именно в общем массиве, с одновременной сменой groupId.
   */
  placeCharInList(cid: string, gid: string | null, refCid: string | null, place: 'before' | 'after'): void {
    const cur = this.charById(cid);
    if (!cur) return;
    const same = (cur.groupId || null) === (gid || null);
    const ref = refCid ? this.charById(refCid) : null;
    if (same && !ref) return; /* бросили в пустое место своей же зоны — нечего делать */
    this.mutate((doc) => {
      const arr = doc.chars || (doc.chars = []);
      const meIdx = arr.findIndex((c) => c.id === cid);
      if (meIdx < 0) return;
      const [me] = arr.splice(meIdx, 1);
      (me as { groupId?: string | null }).groupId = gid || null;
      let inserted = false;
      if (refCid && refCid !== cid && arr.some((c) => c.id === refCid)) {
        const idx = arr.findIndex((c) => c.id === refCid);
        arr.splice(place === 'after' ? idx + 1 : idx, 0, me);
        inserted = true;
      }
      if (!inserted && gid) {
        let last = -1;
        arr.forEach((c, i) => { if ((c as { groupId?: string | null }).groupId === gid) last = i; });
        arr.splice(last >= 0 ? last + 1 : arr.length, 0, me);
        inserted = true;
      }
      if (!inserted) arr.splice(Math.min(meIdx, arr.length), 0, me); /* без группы — вернуть на прежнее место */
    }, { label: 'Перестановка персонажа' });
  }

  /** Перестановка группы на позицию toIndex (индекс в текущем массиве до переноса). */
  moveCharGroup(id: string, toIndex: number): void {
    this.mutate((doc) => {
      const arr = doc.charGroups || [];
      const from = arr.findIndex((g) => g.id === id);
      if (from < 0 || toIndex < 0 || toIndex > arr.length) return;
      const [g] = arr.splice(from, 1);
      let idx = toIndex;
      if (idx > from) idx -= 1;
      idx = Math.max(0, Math.min(arr.length, idx));
      arr.splice(idx, 0, g);
    }, { label: 'Перестановка групп персонажей' });
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
   *  Если нода внутри цепочки — созданные реплики входят в неё на место исходной.
   *  После создания: горизонтальный ряд реальными ширинами, вытеснение соседей
   *  из полосы ряда (вверх/вниз — что ближе) и общий resolveOverlaps. */
  splitDialogNode(id: string, deep: boolean): void {
    const n = this.nodeById(id);
    if (!n || n.type !== 'dialog' || !n.dialog) return;
    const reps = deep ? this.flatReplies(n.dialog.replies) : n.dialog.replies.filter((r) => !!r);
    if (reps.length < 2) {
      this.toast(deep ? 'Нужен диалог минимум с двумя репликами' : 'Нужен диалог минимум с двумя репликами верхнего уровня', 'warn');
      return;
    }
    const lk = this.lockBlockedBy([id]);
    if (lk) { this.showLockTip(this.lastPtr.x, this.lastPtr.y, lk); return; }
    const dlg = n.dialog;
    const gS = this.stackGroupOf(n);
    const kS = gS ? stackOrderIds(this.doc, gS).indexOf(id) : -1;
    const pre = this.serialize();
    /* созданные ноды якорятся в левый верхний угол исходной ноды (7475–7476) */
    const baseX = Math.round(n.x);
    const baseY = Math.round(n.y);
    const createdIds: string[] = [];
    reps.forEach((r, i) => {
      const t = (i === 0) ? (n.title || 'Диалог') : ((r.text || ('Реплика ' + (i + 1))).slice(0, 42));
      const rc = JSON.parse(JSON.stringify(r)) as VetviReply;
      if (deep) rc.children = []; /* при разбивке на все реплики дети уходят в свои ноды */
      const c: VetviNode = {
        id: uid(),
        type: 'dialog',
        gid: null,
        x: baseX,
        y: baseY + i * 175,
        title: t,
        text: '',
        status: n.status || 'idea',
        tags: (n.tags || []).slice(),
        expand: 1,
        color: n.color || null,
        tint: n.tint || 0,
        dlgWidth: n.dlgWidth || null,
        notes: i === 0 ? (n.notes || []) : [],
        linear: (i === 0 && n.linear === true) ? true : undefined,
        dialog: {
          participants: (dlg.participants || []).slice(),
          description: i === 0 ? (dlg.description || '') : '',
          replies: [rc],
        },
      };
      this.doc.nodes.push(c);
      createdIds.push(c.id);
    });
    /* входящие — на первую копию (7486–7488) */
    for (const e of this.doc.edges) {
      if (e.to === id) e.to = createdIds[0];
    }
    /* исходящие: по реплике — в её ноду; обычный выход — последней ноде (7489–7498) */
    for (const e of this.doc.edges) {
      if (e.from === id && e.fromReply) {
        let idx = -1;
        for (let i = 0; i < reps.length; i++) {
          if (deep ? (reps[i].id === e.fromReply) : !!findReply([reps[i]], e.fromReply)) { idx = i; break; }
        }
        if (idx >= 0) e.from = createdIds[idx];
      } else if (e.from === id && e.tin !== 'var') {
        e.from = createdIds[createdIds.length - 1];
        e.fromOut = null;
      }
    }
    this.doc.nodes = this.doc.nodes.filter((x) => x.id !== id);
    this.doc.edges = this.doc.edges.filter((e) => e.from !== id && e.to !== id);
    if (gS) {
      /* созданные ноды занимают место исходной в цепочке (7501–7507) */
      const newOrder = stackOrderIds(this.doc, gS).filter((x) => x !== id);
      newOrder.splice(Math.max(0, kS), 0, ...createdIds);
      gS.order = newOrder;
      for (const cid of createdIds) {
        const cn = this.nodeById(cid);
        if (cn) cn.gid = gS.id;
      }
      stackRebuildChains(this.doc, gS);
    } else {
      for (let ci = 0; ci < createdIds.length - 1; ci++) this.doc.edges.push(stackChainEdgeObj(createdIds[ci], createdIds[ci + 1]));
    }
    this.sel = new Set([createdIds[0]]);
    this.selEdges.clear();
    this.selGroups.clear();
    this.commitEdit(pre, deep ? 'Разбивка диалога на все реплики' : 'Разбивка диалога на реплики');
    this.emit(); /* ноды видимы — можно измерить реальные ширины (renderAll, 7512) */
    /* раскладка ряда и вытеснение соседей — после перерисовки (7513–7560).
       Через mutate: замена объектов нод (сигнатуры) → memo-карточки честно
       перерисуются на новые позиции. */
    setTimeout(() => {
      this.mutate(() => {
        let rx = baseX, ry = baseY;
        if (this.snapOn) { rx = Math.round(rx / GRID) * GRID; ry = Math.round(ry / GRID) * GRID; }
        const rowNodes: VetviNode[] = [];
        for (const cid of createdIds) {
          const cn = this.nodeById(cid);
          if (!cn) continue;
          const w = this.dimsOf(cid).w;
          cn.x = Math.round(rx);
          cn.y = Math.round(ry);
          rx += w + 56;
          rowNodes.push(cn);
        }
        const anyVisible = rowNodes.length > 0;
        if (anyVisible) {
          const pad = 18;
          let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
          for (const c of rowNodes) {
            const d = this.dimsOf(c.id);
            const w = d.w > 0 ? d.w : NODE_W;
            const h = d.h > 0 ? d.h : 150;
            minX = Math.min(minX, c.x); maxX = Math.max(maxX, c.x + w);
            minY = Math.min(minY, c.y); maxY = Math.max(maxY, c.y + h);
          }
          minX -= pad; maxX += pad; minY -= pad; maxY += pad;
          for (const m of this.doc.nodes) {
            if (createdIds.includes(m.id)) continue;
            if (collapsedAncestorOf(this.doc, m.id)) continue;
            const d = this.dimsOf(m.id);
            const w = d.w > 0 ? d.w : NODE_W;
            const h = d.h > 0 ? d.h : 150;
            if (m.x + w > minX && m.x < maxX && m.y + h > minY && m.y < maxY) {
              /* минимальный сдвиг по вертикали из полосы: вверх или вниз — что ближе */
              const up = m.y + h - minY;
              const down = maxY - m.y;
              m.y = Math.round(m.y + ((up < down) ? -up : down));
            }
          }
          this.resolveOverlaps(new Set(createdIds));
        }
      }, { history: false, ch: 'geom' });
      this.toast('Диалог разбит на ' + createdIds.length + ' нод' + (deep ? ' — по одной на каждую реплику' : ' — стрелки реплик сохранены') + (gS ? ' (внутри цепочки)' : ''));
    }, 0);
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
    /* через mutate: замена объектов нод (парки/строки) для memo-карточек */
    this.mutate(() => {
      g.order = newOrder;
      stackRebuildChains(this.doc, g);
      stackSyncParks(this.doc, g);
    }, { history: false });
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
    /* через mutate: замена объектов нод для memo-карточек */
    this.mutate(() => {
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
    }, { history: false });
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
    /* через mutate: замена объектов нод (парк-позиции) для memo-карточек */
    this.mutate(() => {
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
    }, { history: false });
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
    /* через mutate: замена объектов нод (парк-позиции) для memo-карточек */
    this.mutate(() => {
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
    }, { history: false });
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

  /* ── вид ──
   * Панорама/зум — САМЫЕ высокочастотные события (колесо мыши до 1000 Гц).
   * Они НЕ эмитят полную перерисовку: вид применяется императивно через
   * canvasApi.applyVp (transform #world, сетка, миникарта, %, ярлыки), а React
   * догоняет при следующей перерисовке по store.vp. Сохранение — с отложкой. */

  /** Отложенное сохранение вида: таймер перезапускается на каждом событии. */
  private viewChanged(): void {
    canvasApi.current?.applyVp(this.vp);
    if (this.viewSaveT) clearTimeout(this.viewSaveT);
    this.viewSaveT = setTimeout(() => { this.viewSaveT = null; this.scheduleSave(); }, 500);
  }

  setViewport(vp: Partial<VetviViewport>): void {
    if (typeof vp.x === 'number') this.vp.x = vp.x;
    if (typeof vp.y === 'number') this.vp.y = vp.y;
    if (typeof vp.z === 'number') this.vp.z = clampZoom(vp.z, this.uiZoomMin, this.uiZoomMax);
    canvasApi.current?.applyVp(this.vp);
    this.scheduleSave();
    this.emit('geom');
  }

  zoomAt(screenX: number, screenY: number, factor: number): void {
    const z0 = this.vp.z;
    const z1 = clampZoom(z0 * factor, this.uiZoomMin, this.uiZoomMax);
    if (z1 === z0) return;
    const w = screenToWorld(this.vp, screenX, screenY);
    this.vp.z = z1;
    this.vp.x = screenX - w.x * z1;
    this.vp.y = screenY - w.y * z1;
    canvasApi.current?.applyVp(this.vp);
    /* порты пинов измеряются в экранных px и делятся на z — при смене зума
       пересчитать (императивно, без перерисовки карточек) */
    canvasApi.current?.measurePorts();
    this.viewChanged();
    this.emit('geom');
  }

  panBy(dx: number, dy: number): void {
    this.vp.x += dx;
    this.vp.y += dy;
    this.viewChanged();
  }

  panEnd(): void {
    if (this.viewSaveT) { clearTimeout(this.viewSaveT); this.viewSaveT = null; this.scheduleSave(); }
    this.emit('geom');
  }

  fitView(vw: number, vh: number, sizes: Map<string, NodeSize>): void {
    const b = docBounds(this.doc, sizes);
    if (!b) {
      this.setViewport({ x: 0, y: 0, z: 1 });
      return;
    }
    const pad = 70;
    const z = clampZoom(Math.min((vw - pad * 2) / Math.max(b.w, 1), (vh - pad * 2) / Math.max(b.h, 1)), this.uiZoomMin, this.uiZoomMax);
    this.vp.z = z;
    this.vp.x = vw / 2 - (b.x + b.w / 2) * z;
    this.vp.y = vh / 2 - (b.y + b.h / 2) * z;
    canvasApi.current?.applyVp(this.vp);
    this.scheduleSave();
    this.emit('geom');
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

  openProject(id: string, roomHint?: string | null): void {
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
    /* проект привязан к комнате — подключаемся после разблокировки (projOpen оригинала);
       roomHint (комната из ссылки) приоритетнее «липкой» записи реестра */
    const entry = projList().find((e) => e.id === id);
    const roomId = roomHint || (entry ? entry.roomId : null);
    if (roomId && this.sync) {
      this.sync.mode = 'room';
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
      charGroups: [],
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
    if (!ids || !ids.length) return;
    this.carry = { ids, pre };
    this.emit();
    /* тост оригинала (6578) */
    this.toast('Дубликат следует за курсором: клик — поставить, Esc/ПКМ — отменить');
  }

  /** placeCarry оригинала (6580–6593): клоны уже следуют за курсором — позиция не меняется,
   *  назначается gid — глубочайшая группа под центром клона; история «Дублирование (перенос)». */
  placeCarry(): void {
    if (!this.carry) return;
    const ids = this.carry.ids;
    const pre = this.carry.pre;
    this.carry = null;
    const sizes = new Map<string, NodeSize>();
    const cardSizes = new Map<string, { w: number; h: number }>();
    for (const id of ids) {
      const d = this.dimsFn ? this.dimsFn(id) : null;
      if (d) sizes.set(id, { w: d.w, h: d.h });
    }
    for (const id of ids) {
      const n = this.nodeById(id);
      if (!n) continue;
      const s = sizes.get(id);
      const w = s ? s.w : NODE_W;
      const h = s ? s.h : 90;
      const tg = this.deepestGroupAt(n.x + w / 2, n.y + h / 2, sizes, cardSizes);
      n.gid = tg ? tg.id : null;
    }
    this.commitEdit(pre, 'Дублирование (перенос)');
    this.emit();
    this.toast('Дубликат размещён');
  }

  cancelCarry(): void {
    if (!this.carry) return;
    const snap = this.carry.pre;
    this.carry = null;
    this.doc = docFromParsed(JSON.parse(snap));
    this.emit();
    /* тост оригинала (6601) */
    this.toast('Дублирование отменено', 'warn');
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
    this.gestureIds.clear();
  }

  /**
   * Проигранная гонка лока: откат ТОЛЬКО объектов активного жеста к снимку начала
   * (applySnap оригинала — жест отменяется, но чужие параллельные правки,
   * пришедшие пока жест шёл, не затираются целиком, как было при полном applyRemoteDoc).
   */
  restoreGesturePositions(snapJson: string | null, ids: Set<string>): boolean {
    if (!snapJson || !ids.size) return false;
    let parsed: { nodes?: VetviNode[]; edges?: VetviEdge[]; groups?: VetviGroup[] };
    try { parsed = JSON.parse(snapJson); } catch { return false; }
    let hit = false;
    for (const key of ids) {
      const kind = key.slice(0, 2);
      const id = key.slice(2);
      if (kind === 'n:') {
        const src = (parsed.nodes || []).find((n) => n.id === id);
        const dst = this.nodeById(id);
        if (src && dst && (dst.x !== src.x || dst.y !== src.y)) { dst.x = src.x; dst.y = src.y; hit = true; }
      } else if (kind === 'g:') {
        const src = (parsed.groups || []).find((g) => g.id === id);
        const dst = this.groupById(id);
        if (src && dst && (dst.x !== src.x || dst.y !== src.y)) { dst.x = src.x; dst.y = src.y; hit = true; }
      } else if (kind === 'e:') {
        const src = (parsed.edges || []).find((e) => e.id === id);
        const dst = this.edgeById(id);
        if (src && dst) {
          if (src.pts) dst.pts = src.pts;
          dst.lt = src.lt;
          dst.lp = src.lp;
          if (src.bd) dst.bd = src.bd;
          hit = true;
        }
      }
    }
    if (hit) this.emit();
    return hit;
  }

  pointerFn: (() => string | null) | null = null;

  registerPointerFn(fn: () => string | null): void {
    this.pointerFn = fn;
  }

  pointerNodeId(): string | null {
    return this.pointerFn ? this.pointerFn() : null;
  }

  /* ── совместное редактирование: помощь SyncClient ── */

  /** Активный ввод/жест/анимация: в комнате удалённые снимки ждут (pendingRemote).
   *  Как syncBusy оригинала (11636): жесты холста, ввод текста, редактор реплик и
   *  заметок. Обычные модалки/окна подтверждения НЕ ждут — чужие снимки применяются
   *  сразу (в оригинале #modalWrap в syncBusy не входит; лишнее ожидание было
   *  источником «прыгающих» отложенных применений). */
  busyNow(): boolean {
    const t = typeof document !== 'undefined' ? document.activeElement : null;
    /* ввод в модалках синхронизацию не держит: в оригинале #modalWrap не входит
       в syncBusy — иначе (фокус в поле ссылки «Совместного доступа» и т.п.)
       чужие снимки зависают в pendingRemote, пока окно открыто */
    const inModal = !!t && !!(t.closest('.modal-wrap') || t.closest('#dlgModal') || t.closest('#noteModal'));
    const typing = !inModal && !!t && t.isConnected && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || (t as HTMLElement).isContentEditable);
    return typing || this.dialogEdit != null || this.carry != null || this.confirm != null || this.syncBusyFlag || this.busyAnim || noteModalOpen();
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
      varGroups: Array.isArray(this.doc.varGroups) ? this.doc.varGroups : [],
      chars: Array.isArray(this.doc.chars) ? this.doc.chars : [],
      charGroups: Array.isArray(this.doc.charGroups) ? this.doc.charGroups : [],
      palette: (Array.isArray(this.doc.palette) ? this.doc.palette : []).slice(0, 24),
    };
  }

  /**
   * Применение удалённого состояния комнаты (syncApplyRemote оригинала):
   * журнал действий объединяется с пришедшим (правки участников не теряют
   * друг друга), выделение подрезается до живых id, история не пишется.
   * keepPid: снимок комнаты без meta.projectId — сохраняем привязку к проекту.
   * preserveTouchedAfter: метка времени прихода снимка — объекты, сдвинутые
   * локально ПОЗЖЕ (жест/перетаскивание/живой синк), сохраняют свои координаты
   * (иначе отложенное применение устаревшего снимка отбрасывает ноду назад —
   * «прыгающие» позиции у обоих участников).
   */
  applyRemoteDoc(doc: Record<string, unknown> | null, keepPid = false, preserveTouchedAfter = 0, skipSave = false): void {
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
      varGroups?: VetviVarGroup[];
      chars?: VetviChar[];
      charGroups?: VetviCharGroup[];
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
    /* позиции, тронутые локально позже прихода снимка, не перезаписываем */
    const pres = preserveTouchedAfter > 0 ? this.posTouched : null;
    const newer = (key: string) => !!(pres && (pres.get(key) || 0) > preserveTouchedAfter);
    const incNodes = (d.nodes || []) as VetviNode[];
    let newNodes = incNodes;
    if (pres) {
      const oldById = new Map(this.doc.nodes.map((n) => [n.id, n] as const));
      let need = false;
      for (const rn of incNodes) { if (newer('n:' + rn.id)) { need = true; break; } }
      if (need) {
        newNodes = incNodes.map((rn) => {
          if (!newer('n:' + rn.id)) return rn;
          const local = oldById.get(rn.id);
          if (!local) return rn;
          return { ...rn, x: local.x, y: local.y, ...(rn.dlgWidth !== undefined ? { dlgWidth: local.dlgWidth } : null) } as VetviNode;
        });
      }
    }
    this.doc.nodes = newNodes;
    const incEdges = (d.edges || []) as VetviEdge[];
    let newEdges = incEdges;
    if (pres) {
      const oldEdgeById = new Map(this.doc.edges.map((e) => [e.id, e] as const));
      let needE = false;
      for (const re of incEdges) { if (newer('e:' + re.id)) { needE = true; break; } }
      if (needE) {
        newEdges = incEdges.map((re) => {
          if (!newer('e:' + re.id)) return re;
          const local = oldEdgeById.get(re.id);
          if (!local) return re;
          return { ...re, pts: local.pts, lt: local.lt, lp: local.lp, bd: local.bd } as VetviEdge;
        });
      }
    }
    this.doc.edges = newEdges;
    const incGroups = (d.groups || []) as VetviGroup[];
    let newGroups = incGroups;
    if (pres) {
      const oldGrById = new Map(this.doc.groups.map((g) => [g.id, g] as const));
      let needG = false;
      for (const rg of incGroups) { if (newer('g:' + rg.id)) { needG = true; break; } }
      if (needG) {
        newGroups = incGroups.map((rg) => {
          if (!newer('g:' + rg.id)) return rg;
          const local = oldGrById.get(rg.id);
          if (!local) return rg;
          return { ...rg, x: local.x, y: local.y } as VetviGroup;
        });
      }
    }
    this.doc.groups = newGroups;
    this.doc.customTypes = Array.isArray(d.customTypes) ? d.customTypes : [];
    /* цепочки всегда fold=1; старое «Очередь» → «Цепочка» */
    for (const g of this.doc.groups) {
      if (g.stack && (g.fold !== 1 || g.name === 'Очередь')) {
        g.fold = 1;
        if (g.name === 'Очередь') g.name = 'Цепочка';
      }
    }
    this.doc.listHidden = (d.listHidden && typeof d.listHidden === 'object') ? d.listHidden as Record<string, unknown> : {};
    this.doc.vars = Array.isArray(d.vars) ? d.vars : [];
    /* группы переменных: снимок без поля (старый клиент/старый слот) локальные не затирает */
    if (Array.isArray(d.varGroups)) this.doc.varGroups = d.varGroups;
    this.doc.chars = Array.isArray(d.chars) ? d.chars : [];
    /* группы персонажей: снимок без поля (старый клиент/старый слот) локальные не затирает —
       иначе чужой снимок стирает созданные группы до их первой публикации */
    if (Array.isArray(d.charGroups)) this.doc.charGroups = d.charGroups;
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
    /* skipSave — вход в комнату (новая система): серверная версия открыта в редакторе,
       но слот локальной копии пока не перезаписывается — блок в углу холста предлагает
       сравнить версии и решить (при первой правке автосейв запишет как обычно). */
    if (!skipSave) this.scheduleSave();
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

  /* ── soft-lock редактируемого объекта (editStart/editEnd оригинала, 2158–2214) ──
     Пока один участник набирает текст в инспекторе/модалке, объект залочен:
     другие видят обводку «✏ редактирует …», а попытка правки отбивается тултипом. */

  /** Какой объект сейчас правится (editStartIds оригинала 2160): единственное выделение. */
  private editStartIds(): string[] {
    if (!this.sync || !this.sync.enabled) return [];
    if (this.selEdges && this.selEdges.size === 1 && !this.sel.size && !this.selGroups.size) return [[...this.selEdges][0]];
    if (this.sel && this.sel.size === 1 && !this.selGroups.size) return [[...this.sel][0]];
    if (this.selGroups && this.selGroups.size === 1 && !this.sel.size) return [[...this.selGroups][0]];
    return [];
  }

  /** Фокус в поле инспектора/модалки: захват soft-lock объекта (editStart оригинала 2188). */
  editSoftLock(): void {
    if (!this.sync || !this.sync.enabled) return;
    const ids = this.editStartIds();
    for (const id of ids) {
      if (this.sync.myLocks[id]) continue; /* уже залочено жестом/модалкой — не трогаем */
      this.editLockIds.push(id);
      this.sync.lockTake([id]);
    }
  }

  /** Активный жест/модалка удерживают лок объекта (lockHeldByGesture оригинала 2170). */
  private gestureHoldsId(id: string): boolean {
    if (this.dialogEdit && this.dialogEdit === id) return true; /* модалка реплик */
    if (this.carry && this.carry.ids.includes(id)) return true; /* «выдернутая» копия */
    if (this.syncBusyFlag && (this.sel.has(id) || this.selGroups.has(id))) return true; /* канвасный жест */
    return false;
  }

  /** Уход фокуса: отдаём лок через 220мс, если не вернулись к вводу и жест не перехватил (editEnd оригинала 2199). */
  editSoftUnlock(): void {
    if (!this.editLockIds.length) return;
    const rel = this.editLockIds.slice();
    this.editLockIds = [];
    setTimeout(() => {
      if (!this.sync) return;
      const rem: string[] = [];
      for (const id of rel) {
        if (this.editLockIds.indexOf(id) >= 0) continue; /* снова печатаем */
        if (this.gestureHoldsId(id)) continue; /* жест перехватил лок (lockHeldByGesture) */
        rem.push(id);
      }
      if (rem.length) this.sync.lockGive(rem);
    }, 220);
  }

  /** Проигранная гонка набора текста: поле теряет фокус (11974–11986 оригинала). true — был наш edit-лок. */
  editLockDenied(deniedIds: Set<string>): boolean {
    if (!this.editLockIds.length) return false;
    const keep: string[] = [];
    let dropped = false;
    for (const id of this.editLockIds) {
      if (deniedIds.has(id)) { dropped = true; if (this.sync) delete this.sync.myLocks[id]; }
      else keep.push(id);
    }
    if (dropped) {
      this.editLockIds = keep;
      try {
        const ae = document.activeElement as HTMLElement | null;
        if (ae && ae !== document.body) ae.blur();
      } catch { /* нет доступа */ }
      return true;
    }
    return false;
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
