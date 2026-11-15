'use client';

/**
 * Ветви — холст (этап 2): панорама (мышь/Space/Ctrl), зум, сетка,
 * рамка выделения, «нож» (Alt), рисование групп (Ctrl+Shift), перенос нод
 * и групп, создание связей от пинов (включая реплики/исходы/вход переменной),
 * перенос существующих стрелок (Ctrl+пин), изгибы, подписи, мосты,
 * ширина диалога, перенос дубликата за курсором,
 * drag&drop из палитры: на ноду (attachNewTo), на связь (встраивание),
 * в пустоту, нода переменной + подсветки drop-hover/drop-target и автораздвижка.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { snapVal, newNode } from '@/vetvi/core/factory';
import { GRID, NODE_W, QCARD_W } from '@/vetvi/core/constants';
import { clamp, clampZoom, nodeColor, nodeWidth, screenToWorld, typeInfo } from '@/vetvi/core/geometry';
import { isBridge, nearestEdgeIn } from '@/vetvi/core/insert';
import { nearestSegPoint } from '@/vetvi/core/edgepath';
import { queueEntryId, queueExitId, stackableType, stackSyncParks } from '@/vetvi/core/chains';
import { getMe } from '@/vetvi/core/identity';
import { defValOf, varById } from '@/vetvi/core/vars';
import type { NodeSize, VetviDoc, VetviGroup, VetviNode, VetviViewport } from '@/vetvi/core/types';
import type { VetviStore } from './store';
import { canvasApi } from './canvasApi';
import { NodeCard } from './NodeCard';
import { GroupLayer } from './GroupLayer';
import { EdgeLayer, buildEdgeItems } from './EdgeLayer';
import { collapsedAncestorOf, groupCardRect, groupFrameRect, snapG } from './ggroups';
import { ctxMenus } from './ctxMenus';
import { SyncDiffBadge } from './SyncModals';

type Gest =
  | { mode: 'pan'; sx: number; sy: number; lx: number; ly: number }
  | { mode: 'marquee'; sx: number; sy: number; add: boolean; preN: Set<string>; preG: Set<string> }
  | { mode: 'gcreate'; sx: number; sy: number; cx: number; cy: number }
  | { mode: 'knife'; sx: number; sy: number; lx: number; ly: number; wx: number; wy: number }
  | { mode: 'node'; lx: number; ly: number; stackHl: string | null; dropEdge: string | null }
  | { mode: 'group'; gid: string; lx: number; ly: number; base: Map<string, { x: number; y: number }> }
  | { mode: 'gresize'; gid: string; dir: 'r' | 'b' | 'br'; sx: number; sy: number; fw: number; fh: number }
  | { mode: 'link'; from: string; out: string | null; reply: string | null; wx: number; wy: number; sx: number; sy: number; target: string | null; varin: boolean }
  | { mode: 'reattachOut'; from: string; lx: number; ly: number; target: string | null }
  | { mode: 'reattachIn'; to: string; lx: number; ly: number; target: string | null }
  | { mode: 'wp'; eid: string; idx: number }
  | { mode: 'label'; eid: string }
  | { mode: 'bridge'; eid: string; part: 'l' | 'r' | 'h'; lx: number; ly: number; dl: number; dy: number; dr: number }
  | { mode: 'dlgW'; id: string; startX: number; startW: number }
  | null;

/* ═══ мини-карта: mmFit/mmRebuild/mmGeom/mmRender оригинала (строки 9269–9372 index.html) ═══
   Оригинал НЕ сохраняет размер карты в localStorage — ресайз живёт до перезагрузки (1:1). */
const MM_MIN_W = 180;
const MM_MIN_H = 130;
const MM_DEF_W = 260;
const MM_DEF_H = 180;

/* mmViewportBox оригинала: мировой прямоугольник, видимый на холсте */
function mmViewportBoxOf(vp: VetviViewport, cw: number, ch: number): { x1: number; y1: number; x2: number; y2: number } {
  const vx = -vp.x / vp.z;
  const vy = -vp.y / vp.z;
  return { x1: vx, y1: vy, x2: vx + cw / vp.z, y2: vy + ch / vp.z };
}

/* resolvedNodeColor оригинала (2945): персонаж-участник → своя краска → цвет типа */
function mmNodeColor(store: VetviStore, n: VetviNode, depth = 0): string {
  if (n.type !== 'dialog' && depth < 5 && Array.isArray(n.participants) && n.participants.length) {
    const c0 = store.charById(n.participants[0]);
    if (c0) return c0.color || '#9cb878';
    const n0 = store.nodeById(n.participants[0]);
    if (n0) {
      const sub = mmNodeColor(store, n0, depth + 1);
      if (sub) return sub;
    }
  }
  return n.color ? nodeColor(n, store.doc.customTypes) : (typeInfo(n.type, store.doc.customTypes).color || '#8b929c');
}

/* groupRectWorld оригинала (3050): fold=2 — рамка, fold<2 — карточка (GCARD_W/QCARD_W) */
function mmGroupWorldRect(doc: VetviDoc, g: VetviGroup, sizes: Map<string, NodeSize>, cardSizes: Map<string, { w: number; h: number }>): { x: number; y: number; w: number; h: number } {
  const fold = g.fold === undefined ? 2 : g.fold;
  if (fold === 2) return groupFrameRect(doc, g, sizes, cardSizes);
  const cr = groupCardRect(doc, g, cardSizes);
  return { x: g.x || 0, y: g.y || 0, w: cr.w, h: cr.h };
}

/**
 * stackDropTargetAt оригинала (7219–7238): цель сброса перетаскиваемой ноды —
 * stackable-нода под курсором (по центрам, расстояние |dx|+|dy|), вне цепочек.
 * Скрытые ноды (внутри свёрнутых групп/цепочек) не участвуют — как display:none в оригинале.
 */
function stackDropTargetAt(
  store: { doc: VetviDoc; nodeById(id: string): VetviNode | undefined; stackGroupOf(n: VetviNode): VetviGroup | null },
  dragId: string,
  wp: { x: number; y: number },
  sizes: Map<string, NodeSize>,
): VetviNode | null {
  const dn = store.nodeById(dragId);
  if (!dn || !stackableType(dn.type) || store.stackGroupOf(dn)) return null;
  const cx = wp.x;
  const cy = wp.y;
  let best: VetviNode | null = null;
  let bestD = 1e9;
  for (const o of store.doc.nodes) {
    if (o.id === dragId || !stackableType(o.type)) continue;
    if (collapsedAncestorOf(store.doc, o.id)) continue;
    const s = sizes.get(o.id);
    const ow = s ? s.w : NODE_W;
    const oh = s ? s.h : 90;
    if (cx >= o.x && cx <= o.x + ow && cy >= o.y && cy <= o.y + oh) {
      const d = Math.abs(o.x + ow / 2 - cx) + Math.abs(o.y + oh / 2 - cy);
      if (d < bestD) { bestD = d; best = o; }
    }
  }
  return best;
}

/* mmBBox оригинала: границы видимых нод и групп (свёрнутое пропускается) */
function mmBBoxOf(doc: VetviDoc, nodes: VetviNode[], sizes: Map<string, NodeSize>, cardSizes: Map<string, { w: number; h: number }>): { x1: number; y1: number; x2: number; y2: number } | null {
  let x1 = 1e9, y1 = 1e9, x2 = -1e9, y2 = -1e9, any = false;
  for (const n of nodes) {
    const s = sizes.get(n.id);
    const w = s ? s.w : NODE_W;
    const h = s ? s.h : 90;
    any = true;
    x1 = Math.min(x1, n.x);
    y1 = Math.min(y1, n.y);
    x2 = Math.max(x2, n.x + w);
    y2 = Math.max(y2, n.y + h);
  }
  for (const g of doc.groups) {
    if (groupInsideCollapsed(doc, g)) continue;
    const r = mmGroupWorldRect(doc, g, sizes, cardSizes);
    any = true;
    x1 = Math.min(x1, r.x);
    y1 = Math.min(y1, r.y);
    x2 = Math.max(x2, r.x + r.w);
    y2 = Math.max(y2, r.y + r.h);
  }
  if (!any) return null;
  return { x1, y1, x2, y2 };
}

export function CanvasBoard(props: { store: VetviStore }) {
  const { store } = props;
  const doc = store.doc;
  const vp = store.vp;

  const canvasRef = useRef<HTMLDivElement>(null);
  const [sizesMap] = useState(() => new Map<string, NodeSize>());
  const [portsMap] = useState(() => new Map<string, { x: number; y: number }>());
  const [cardSizes] = useState(() => new Map<string, { w: number; h: number }>());
  const [tick, setTick] = useState(0);
  const gestRef = useRef<Gest>(null);
  const [marquee, setMarquee] = useState<{ x: number; y: number; w: number; h: number; g?: boolean } | null>(null);
  /* линия «ножа» в мировых координатах (оригинал кладёт path.cutline в #edges) */
  const [cutline, setCutline] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null);
  const [pendingLink, setPendingLink] = useState<{ from: string; out: string | null; reply: string | null; x: number; y: number; startX: number; startY: number } | null>(null);
  const [hoverTarget, setHoverTarget] = useState<string | null>(null);
  const [altDown, setAltDown] = useState(false);
  /* dropready — перетаскивание из палитры над холстом; panning — активный пан; animv — анимация вида */
  const [dropReady, setDropReady] = useState(false);
  const [panning, setPanning] = useState(false);
  const worldRef = useRef<HTMLDivElement>(null);
  const labelsRef = useRef<HTMLDivElement>(null);
  const animT = useRef<ReturnType<typeof setTimeout> | null>(null);

  const sink = useMemo(
    () => ({
      setSize(id: string, w: number, h: number) {
        const prev = sizesMap.get(id);
        if (!prev || prev.w !== w || prev.h !== h) { sizesMap.set(id, { w, h }); setTick((t) => t + 1); }
      },
      setPort(key: string, p: { x: number; y: number }) {
        const prev = portsMap.get(key);
        if (!prev || prev.x !== p.x || prev.y !== p.y) { portsMap.set(key, p); setTick((t) => t + 1); }
      },
      setCardSize(id: string, w: number, h: number) {
        const prev = cardSizes.get(id);
        if (!prev || prev.w !== w || prev.h !== h) { cardSizes.set(id, { w, h }); setTick((t) => t + 1); }
      },
    }),
    [sizesMap, portsMap, cardSizes],
  );

  /* ── регистрация API для глобальных хоткеев ── */
  useEffect(() => {
    canvasApi.current = {
      getRect: () => {
        const el = canvasRef.current;
        return el ? { width: el.clientWidth, height: el.clientHeight } : null;
      },
      sizes: sizesMap,
      centerOn: (id: string) => {
        const el = canvasRef.current;
        if (!el) return;
        const n = store.nodeById(id);
        if (!n) return;
        const s = sizesMap.get(id);
        const w = (s ? s.w : 216) / 2;
        const h = (s ? s.h : 90) / 2;
        const r = el.getBoundingClientRect();
        /* centerOn оригинала (6880): приближение минимум до 0.8 */
        const z = Math.max(store.vp.z, 0.8);
        store.setViewport({
          x: r.width / 2 - (n.x + w) * z,
          y: r.height / 2 - (n.y + h) * z,
          z,
        });
      },
    };
    return () => { canvasApi.current = null; };
  }, [store, sizesMap]);

  /* ── центрирование по запросу (плавная анимация — animateView оригинала 7716):
       класс .animv вешается на DOM ДО изменения вида (в обход React — как в
       классической версии): CSS-переход срабатывает, вид едет плавно (0.45s) ── */
  useEffect(() => {
    if (store.centerReq && canvasApi.current) {
      const cv = canvasRef.current;
      const world = worldRef.current;
      const labels = labelsRef.current;
      if (cv) cv.classList.add('animv');
      if (world) world.classList.add('animv');
      if (labels) labels.classList.add('animv');
      canvasApi.current.centerOn(store.centerReq.id);
      if (animT.current) clearTimeout(animT.current);
      animT.current = setTimeout(() => {
        if (cv) cv.classList.remove('animv');
        if (world) world.classList.remove('animv');
        if (labels) labels.classList.remove('animv');
      }, 480);
    }
  }, [store.centerReq?.t]);

  const items = useMemo(
    () => buildEdgeItems(doc, doc.edges, sizesMap, portsMap, cardSizes, store.bend),
     
    [doc, doc.edges, sizesMap, portsMap, cardSizes, store.bend, store.revision, tick],
  );

  /* ── скрытые группы (внутри свёрнутых предков — groupInsideCollapsed оригинала 3028):
       сами свёрнутые группы рендерятся карточками/рамками, прячутся только их потомки ── */
  const hiddenGids = (() => {
    const set = new Set<string>();
    for (const g of doc.groups) {
      if ((g.fold === undefined ? 2 : g.fold) < 2) {
        // предки свёрнутой группы скрыты из рендера как рамки
        let p: string | null | undefined = g.parent;
        const seen = new Set<string>();
        while (p && !seen.has(p)) { seen.add(p); set.add(p); p = store.groupById(p)?.parent || null; }
      }
    }
    return set;

    })();

  const visibleNodes = doc.nodes.filter((n) => !collapsedAncestorOf(doc, n.id));

  /* ── колесо: зум к курсору / Shift — пан. Нативный слушатель passive:false —
     делегированный React onWheel пассивен, preventDefault в нём не работает ── */
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const onWheelNative = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      if (e.shiftKey) {
        store.panBy(-e.deltaY, 0);
        return;
      }
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      store.zoomAt(x, y, Math.pow(1.0015, -e.deltaY));
    };
    el.addEventListener('wheel', onWheelNative, { passive: false });
    return () => el.removeEventListener('wheel', onWheelNative);
  }, [store]);

  /* ── клики по пустому месту ── */

  /* пан-жест — используется и при зажатом Ctrl на нодах/группах/связях:
     объекты игнорируются, тянется холст (8104–8118 оригинала) */
  const startPanGesture = useCallback((e: React.MouseEvent) => {
    gestRef.current = { mode: 'pan', sx: e.clientX, sy: e.clientY, lx: e.clientX, ly: e.clientY };
    setPanning(true);
    document.body.classList.add('panning');
    e.preventDefault();
  }, []);

  /** Ctrl/⌘ зажат (без Alt/Space) — объект игнорируется, начинается пан холста;
   *  Ctrl+Shift — рисование новой группы. Исключения — пины/фолды/грипы (8104). */
  const modGestureInstead = useCallback((e: React.MouseEvent): boolean => {
    if (e.button !== 0) return false;
    const modK = e.ctrlKey || e.metaKey;
    if (!modK || e.altKey || store.spaceDown) return false;
    const t = e.target as HTMLElement;
    if (t.closest && t.closest('[data-pin], .qport, .dlg-reply-pin, .gb-grip, .gb-fold, .gb-salla, .n-seq, .n-fold, .opin, .vpinn, [data-nodrag]')) return false;
    if (e.shiftKey) {
      const rect = canvasRef.current!.getBoundingClientRect();
      const w = screenToWorld(store.vp, e.clientX - rect.left, e.clientY - rect.top);
      gestRef.current = { mode: 'gcreate', sx: w.x, sy: w.y, cx: e.clientX, cy: e.clientY };
      setMarquee({ x: e.clientX - rect.left, y: e.clientY - rect.top, w: 0, h: 0, g: true });
      e.preventDefault();
      return true;
    }
    startPanGesture(e);
    return true;
  }, [store, startPanGesture]);

  const onCanvasDown = useCallback((e: React.MouseEvent) => {
    const t = e.target as HTMLElement;
    store.closeCtx();
    if (e.button === 2) return;
    /* Ctrl/⌘+ЛКМ — перемещение по холсту, Ctrl+Shift — новая группа; ноды ИГНОРИРУЮТСЯ
       (8104 оригинала: исключения — только пины/фолды/грипы, но не тело ноды) */
    if (modGestureInstead(e)) return;
    /* средняя кнопка/Space — пан по холсту независимо от цели (8297 оригинала:
       делегированный обработчик — и на ноде/группе/стрелке тоже пан, не захват объекта) */
    if (e.button === 1 || store.spaceDown) {
      startPanGesture(e);
      return;
    }
    if (t.closest('[data-node-id]') || t.closest('[data-pin]') || t.closest('.rn-gframe, .groupbox') || t.closest('.rn-gcard, .gcard, .qcard')) return;
    if (e.button !== 0) return;
    if (altDown) {
      const rect = canvasRef.current!.getBoundingClientRect();
      const w0 = screenToWorld(store.vp, e.clientX - rect.left, e.clientY - rect.top);
      gestRef.current = { mode: 'knife', sx: e.clientX, sy: e.clientY, lx: e.clientX, ly: e.clientY, wx: w0.x, wy: w0.y };
      setCutline({ x1: w0.x, y1: w0.y, x2: w0.x, y2: w0.y });
      e.preventDefault();
      return;
    }
    if (e.ctrlKey && e.shiftKey) {
      const rect = canvasRef.current!.getBoundingClientRect();
      const w = screenToWorld(store.vp, e.clientX - rect.left, e.clientY - rect.top);
      gestRef.current = { mode: 'gcreate', sx: w.x, sy: w.y, cx: e.clientX, cy: e.clientY };
      setMarquee({ x: e.clientX, y: e.clientY, w: 0, h: 0, g: true });
      e.preventDefault();
      return;
    }
    // рамка выделения
    const preN = new Set(store.sel);
    const preG = new Set(store.selGroups);
    gestRef.current = { mode: 'marquee', sx: e.clientX, sy: e.clientY, add: e.shiftKey, preN, preG };
    if (!e.shiftKey) store.clearSelection();
    {
      const rect = canvasRef.current!.getBoundingClientRect();
      setMarquee({ x: e.clientX - rect.left, y: e.clientY - rect.top, w: 0, h: 0 });
    }
    e.preventDefault();
  }, [store, altDown, modGestureInstead, startPanGesture]);

  /* ── ноды ── */
  const onNodeDragStart = useCallback((e: React.MouseEvent, id: string) => {
    if (store.carry) return;
    if (store.spaceDown) return; /* Space над нодой: ни пан, ни drag (8158–8159 оригинала) */
    gestRef.current = { mode: 'node', lx: e.clientX, ly: e.clientY, stackHl: null, dropEdge: null };
    store.dragBegin();
    store.setGestureIds([...store.sel].map((x) => 'n:' + x));
    /* soft-lock: захват выделенных нод на время жеста */
    if (store.sync && store.sync.enabled) { store.sync.lockTake([...store.sel]); store.setGestureRollback(null); }
    e.preventDefault();
  }, [store]);

  /* ── группы ── */
  const onGroupDown = useCallback((e: React.MouseEvent, gid: string) => {
    if (e.button !== 0) return;
    /* Ctrl/⌘+ЛКМ по группе — пан по холсту, группа не захватывается (8104 оригинала);
       Space — тоже пан (средняя кнопка отфильтрована выше) */
    if (modGestureInstead(e)) return;
    if (store.spaceDown) { startPanGesture(e); return; }
    const t = e.target as HTMLElement;
    if (t.closest('[data-nodrag]')) return;
    // выделение группы при захвате (selectGroup, 8251–8261): shift — добавить/убрать
    if (e.shiftKey) store.toggleGroup(gid);
    else store.selectGroupOnly(gid);
    // если кликнули по строке ноды в карточке — та нода уже выделена; тянем группу
    const base = new Map<string, { x: number; y: number }>();
    const g = store.groupById(gid);
    if (!g) return;
    const members = store.doc.nodes.filter((n) => {
      let cur: string | null = n.gid;
      while (cur) {
        if (cur === gid) return true;
        cur = store.groupById(cur)?.parent || null;
      }
      return false;
    });
    for (const n of members) base.set(n.id, { x: n.x, y: n.y });
    for (const sg of store.doc.groups) {
      let cur: string | null = sg.parent || null;
      while (cur) {
        if (cur === gid) { base.set('g:' + sg.id, { x: sg.x, y: sg.y }); break; }
        cur = store.groupById(cur)?.parent || null;
      }
    }
    gestRef.current = { mode: 'group', gid, lx: e.clientX, ly: e.clientY, base };
    store.dragBegin();
    store.setGestureIds(['g:' + gid, ...[...base.keys()].map((k) => (k.startsWith('g:') ? k : 'n:' + k))]);
    /* soft-lock: члены группы + рамки */
    if (store.sync && store.sync.enabled) {
      const lkIds: string[] = [gid];
      for (const [k] of base) lkIds.push(k);
      store.sync.lockTake(lkIds);
      store.setGestureRollback(null);
    }
    e.preventDefault();
    e.stopPropagation();
  }, [store, modGestureInstead, startPanGesture]);

  const onGroupResize = useCallback((e: React.MouseEvent, gid: string, dir: 'r' | 'b' | 'br') => {
    const g = store.groupById(gid);
    if (!g) return;
    gestRef.current = { mode: 'gresize', gid, dir, sx: e.clientX, sy: e.clientY, fw: g.fw || 220, fh: g.fh || 150 };
    e.preventDefault();
    e.stopPropagation();
  }, [store]);

  /* ── пины: новая связь ── */
  const onPinDown = useCallback((e: React.MouseEvent, id: string, out: string | null, reply: string | null) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    const w = screenToWorld(store.vp, e.clientX - (rect?.left || 0), e.clientY - (rect?.top || 0));
    gestRef.current = { mode: 'link', from: id, out, reply, wx: w.x, wy: w.y, sx: w.x, sy: w.y, target: null, varin: false };
    setPendingLink({ from: id, out, reply, x: w.x, y: w.y, startX: w.x, startY: w.y });
    store.setGestureIds(['n:' + id]);
    if (store.sync && store.sync.enabled) {
      store.sync.lockTake([id]);
      store.setGestureRollback(() => { setPendingLink(null); setHoverTarget(null); });
    }
    e.preventDefault();
  }, [store]);

  const onPinReattach = useCallback((e: React.MouseEvent, id: string) => {
    gestRef.current = { mode: 'reattachOut', from: id, lx: e.clientX, ly: e.clientY, target: null };
    e.preventDefault();
  }, []);

  /* ── порты цепочки (qport.in/out, 8124–8136 → 7870–7921) ── */
  const onQPortDown = useCallback((ev: React.MouseEvent, gid: string, isIn: boolean) => {
    ev.stopPropagation();
    ev.preventDefault();
    if (ev.button !== 0) return;
    const g = store.groupById(gid);
    if (!g || g.stack !== true || (g.fold === undefined ? 2 : g.fold) >= 2) return;
    const modK = ev.ctrlKey || ev.metaKey;
    if (isIn) {
      /* вход цепочки — перенос входящих стрелок первой ноды (startQueuePinDrag, 7884) */
      const nid = queueEntryId(store.doc, g);
      if (!nid) { store.toast('Цепочка пуста', 'warn'); return; }
      const inc = store.doc.edges.filter((ed) => ed.to === nid);
      if (!inc.length) { store.toast('У цепочки нет входящих стрелок — вход свободен', 'warn'); return; }
      const lk = store.lockBlockedBy([nid]);
      if (lk) { store.showLockTip(ev.clientX, ev.clientY, lk); return; }
      if (store.sync && store.sync.enabled) store.sync.lockTake([nid]);
      store.selectGroupOnly(g.id);
      gestRef.current = { mode: 'reattachIn', to: nid, lx: ev.clientX, ly: ev.clientY, target: null };
      return;
    }
    if (modK) {
      /* Ctrl+вход выхода — перенос исходящих стрелок последней ноды (startQueueOutDrag, 7903) */
      const nid = queueExitId(store.doc, g);
      if (!nid) { store.toast('Цепочка пуста', 'warn'); return; }
      const outs = store.doc.edges.filter((ed) => ed.from === nid && !ed.fromReply && !ed.fromOut);
      if (!outs.length) { store.toast('У цепочки нет исходящих стрелок', 'warn'); return; }
      const lk = store.lockBlockedBy([nid]);
      if (lk) { store.showLockTip(ev.clientX, ev.clientY, lk); return; }
      if (store.sync && store.sync.enabled) store.sync.lockTake([nid]);
      store.selectGroupOnly(g.id);
      gestRef.current = { mode: 'reattachOut', from: nid, lx: ev.clientX, ly: ev.clientY, target: null };
      return;
    }
    /* выход цепочки — новая связь от последней ноды (startQueueConnect, 7870) */
    const nid2 = queueExitId(store.doc, g);
    if (!nid2) { store.toast('Цепочка пуста', 'warn'); return; }
    const lk2 = store.lockBlockedBy([nid2]);
    if (lk2) { store.showLockTip(ev.clientX, ev.clientY, lk2); return; }
    if (store.sync && store.sync.enabled) store.sync.lockTake([nid2]);
    store.selectGroupOnly(g.id);
    const cr = groupCardRect(store.doc, g, cardSizes);
    const ax = (g.x || 0) + (cr.w || QCARD_W); /* qCardPortAnchor, 7842–7845 */
    const ay = (g.y || 0) + 17;
    gestRef.current = { mode: 'link', from: nid2, out: null, reply: null, wx: ax, wy: ay, sx: ax, sy: ay, target: null, varin: false };
    setPendingLink({ from: nid2, out: null, reply: null, x: ax, y: ay, startX: ax, startY: ay });
  }, [store, cardSizes]);

  /* ── выход строки цепочки (startRowConnect, 7924–7944) ── */
  const onRowPinDown = useCallback((ev: React.MouseEvent, nid: string) => {
    ev.stopPropagation();
    ev.preventDefault();
    if (ev.button !== undefined && ev.button !== 0) return;
    const n = store.nodeById(nid);
    if (!n) return;
    const g = store.stackGroupOf(n);
    if (!g) return;
    const lk = store.lockBlockedBy([nid]);
    if (lk) { store.showLockTip(ev.clientX, ev.clientY, lk); return; }
    if (store.sync && store.sync.enabled) store.sync.lockTake([nid]);
    if (ev.ctrlKey || ev.metaKey) {
      /* Ctrl+ЛКМ — перенести исходящие стрелки ноды строки (7936) */
      gestRef.current = { mode: 'reattachOut', from: nid, lx: ev.clientX, ly: ev.clientY, target: null };
      return;
    }
    const row = (ev.currentTarget as HTMLElement).closest('.q-item') as HTMLElement | null;
    if (!row) return;
    const x1 = (g.x || 0) + row.offsetLeft + row.offsetWidth + 2;
    const y1 = (g.y || 0) + row.offsetTop + row.offsetHeight / 2;
    store.selectOnly(nid);
    gestRef.current = { mode: 'link', from: nid, out: null, reply: null, wx: x1, wy: y1, sx: x1, sy: y1, target: null, varin: false };
    setPendingLink({ from: nid, out: null, reply: null, x: x1, y: y1, startX: x1, startY: y1 });
  }, [store]);

  const onResizeDown = useCallback((e: React.MouseEvent, id: string) => {
    const n = store.nodeById(id);
    if (!n) return;
    gestRef.current = { mode: 'dlgW', id, startX: e.clientX, startW: n.dlgWidth || 216 };
    store.setGestureIds(['n:' + id]);
    if (store.sync && store.sync.enabled) store.sync.lockTake([id]);
    e.preventDefault();
  }, [store]);

  const onNodeDbl = useCallback((id: string) => {
    /* как в оригинале: двойной клик — только выделение; у диалога — открыть редактор реплик */
    if (store.nodeById(id)?.type === 'dialog') {
      store.openDialogEditor(id);
      store.requestFlash(id, null);
    }
  }, [store]);

  const onReplyDbl = useCallback((nodeId: string, rid: string) => {
    store.openDialogEditor(nodeId);
    // прокрутка к реплике — редактор сам по flash
    store.requestFlash(nodeId, rid);
  }, [store]);

  /* ── связи: клики/вейпоинты/подписи/мосты ── */
  const onEdgeDown = useCallback((e: React.MouseEvent, id: string) => {
    /* Ctrl/⌘+ЛКМ по стрелке — пан по холсту, связь не захватывается (8104 оригинала);
       средняя кнопка/Space — тоже пан */
    if (modGestureInstead(e)) return;
    if (e.button === 1 || store.spaceDown) { startPanGesture(e); return; }
    if (e.shiftKey) store.toggleEdge(id);
    else store.selectEdgeOnly(id);
    e.preventDefault();
  }, [store, modGestureInstead, startPanGesture]);

  const onEdgeDbl = useCallback((e: React.MouseEvent, id: string) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    const w = screenToWorld(store.vp, e.clientX - (rect?.left || 0), e.clientY - (rect?.top || 0));
    const it = items.find((x) => x.e.id === id);
    if (!it) return;
    const P = [{ x: it.g.x1, y: it.g.y1 }, ...(it.g.corners && it.g.corners.length ? it.g.corners : (it.g.pts || [])), { x: it.g.x2, y: it.g.y2 }];
    if (it.g.corners && it.g.corners.length) {
      store.toast('Мост: тяни его прямые отрезки', 'warn');
      return;
    }
    const near = nearestSegPoint(P, w.x, w.y);
    store.insertWaypoint(id, near.seg, near.pt.x, near.pt.y);
    store.selectEdgeOnly(id);
  }, [store, items]);

  const onWpDown = useCallback((e: React.MouseEvent, id: string, i: number) => {
    /* Ctrl/⌘+ЛКМ по вейпоинту — пан по холсту (8104 оригинала: изгибы не исключение) */
    if (modGestureInstead(e)) return;
    if (e.button === 1 || store.spaceDown) { startPanGesture(e); return; }
    gestRef.current = { mode: 'wp', eid: id, idx: i };
    store.dragBegin();
    store.setGestureIds(['e:' + id]);
    if (store.sync && store.sync.enabled) store.sync.lockTake([id]);
    e.preventDefault();
  }, [store, modGestureInstead, startPanGesture]);

  const onWpDbl = (e: React.MouseEvent, id: string, i: number) => {
    store.deleteWaypoint(id, i);
  };

  const onLabelDown = (e: React.MouseEvent, id: string) => {
    /* Ctrl/⌘+ЛКМ по подписи связи — пан по холсту (8104 оригинала) */
    if (modGestureInstead(e)) return;
    if (e.button === 1 || store.spaceDown) { startPanGesture(e); return; }
    gestRef.current = { mode: 'label', eid: id };
    store.setGestureIds(['e:' + id]);
    e.preventDefault();
  };

  const onBridgeDown = useCallback((e: React.MouseEvent, id: string, part: 'l' | 'r' | 'h') => {
    /* Ctrl/⌘+ЛКМ по мосту — пан по холсту (8104 оригинала) */
    if (modGestureInstead(e)) return;
    if (e.button === 1 || store.spaceDown) { startPanGesture(e); return; }
    const ed = store.edgeById(id);
    if (!ed) return;
    const bd = ed.bd || { dl: 0, dy: 0, dr: 0 };
    gestRef.current = { mode: 'bridge', eid: id, part, lx: e.clientX, ly: e.clientY, dl: bd.dl, dy: bd.dy, dr: bd.dr };
    store.dragBegin();
    store.setGestureIds(['e:' + id]);
    if (store.sync && store.sync.enabled) store.sync.lockTake([id]);
    e.preventDefault();
  }, [store, modGestureInstead, startPanGesture]);

  /* базовые позиции carry-клонов при старте режима */
  const carryBase = (() => {
    const m = new Map<string, { x: number; y: number }>();
    if (store.carry) {
      for (const id of store.carry.ids) {
        const n = store.nodeById(id);
        if (n) m.set(id, { x: n.x, y: n.y });
      }
    }
     
    return m;
    })();

  /* setDropEdge оригинала (4284–4288): класс drop-target на g.edge[data-id] */
  const dropEdgeRef = useRef<string | null>(null);
  const setDropEdge = useCallback((id: string | null) => {
    if (dropEdgeRef.current === id) return;
    if (dropEdgeRef.current) {
      const prev = document.querySelector('#edges g.edge[data-id="' + dropEdgeRef.current + '"]');
      if (prev) prev.classList.remove('drop-target');
    }
    dropEdgeRef.current = id;
    if (id) {
      const next = document.querySelector('#edges g.edge[data-id="' + id + '"]');
      if (next) next.classList.add('drop-target');
    }
  }, []);
  /* подсветка карточки цепочки как цели сброса (drop-hover, 8021/8382) — императивно */
  const qCardHlRef = useRef<HTMLElement | null>(null);
  const setQCardHl = useCallback((el: HTMLElement | null) => {
    if (qCardHlRef.current === el) return;
    if (qCardHlRef.current) qCardHlRef.current.classList.remove('drop-hover');
    qCardHlRef.current = el;
    if (el) el.classList.add('drop-hover');
  }, []);

  /* ── глобальные обработчики жеста ── */
  useEffect(() => {
    const move = (e: MouseEvent) => {
      const g = gestRef.current;
      if (g && !store.syncBusyFlag) store.syncBusyFlag = true;
      if (store.carry) {
        // дубликат следует за курсором
        const rect = canvasRef.current?.getBoundingClientRect();
        const w = screenToWorld(store.vp, e.clientX - (rect?.left || 0), e.clientY - (rect?.top || 0));
        const c = carryCenter(store, store.carry.ids);
        const dx = w.x - c.x;
        const dy = w.y - c.y;
        for (const id of store.carry.ids) {
          const n = store.nodeById(id);
          if (!n) continue;
          const b = carryBase.get(id);
          if (b) { n.x = snapVal(b.x + dx, store.snapOn); n.y = snapVal(b.y + dy, store.snapOn); }
        }
        store.emit();
        return;
      }
      if (!g) return;
      switch (g.mode) {
        case 'pan': {
          store.panBy(e.clientX - g.lx, e.clientY - g.ly);
          g.lx = e.clientX;
          g.ly = e.clientY;
          break;
        }
        case 'marquee': {
          /* рамка рисуется в координатах контейнера холста (e.clientX-cr0.left оригинала 8352) */
          const crect = canvasRef.current?.getBoundingClientRect();
          const ox = crect ? crect.left : 0;
          const oy = crect ? crect.top : 0;
          const ax = Math.min(g.sx, e.clientX);
          const ay = Math.min(g.sy, e.clientY);
          const x = ax - ox;
          const y = ay - oy;
          const w = Math.abs(e.clientX - g.sx);
          const h = Math.abs(e.clientY - g.sy);
          setMarquee({ x, y, w, h });
          // пересечение с нодами в экранных координатах
          if (crect) {
            const wa = screenToWorld(store.vp, ax - ox, ay - oy);
            const wb = screenToWorld(store.vp, ax + w - ox, ay + h - oy);
            const ids: string[] = [];
            const gids: string[] = [];
            for (const n of doc.nodes) {
              if (collapsedAncestorOf(doc, n.id)) continue; /* скрытые ноды не выделяются (8649) */
              const s = sizesMap.get(n.id);
              const nw = s ? s.w : 216;
              const nh = s ? s.h : 90;
              if (n.x < wb.x && n.x + nw > wa.x && n.y < wb.y && n.y + nh > wa.y) ids.push(n.id);
            }
            for (const gr of doc.groups) {
              if ((gr.fold === undefined ? 2 : gr.fold) !== 2) continue;
              const cr = groupCardRect(doc, gr, cardSizes);
              if (gr.x < wb.x && gr.x + cr.w > wa.x && gr.y < wb.y && gr.y + cr.h > wa.y) gids.push(gr.id);
            }
            store.setMarqueeSel(g.add ? [...g.preN, ...ids] : ids, g.add ? [...g.preG, ...gids] : gids);
          }
          break;
        }
        case 'gcreate': {
          const grect = canvasRef.current?.getBoundingClientRect();
          const x = Math.min(g.cx, e.clientX) - (grect ? grect.left : 0);
          const y = Math.min(g.cy, e.clientY) - (grect ? grect.top : 0);
          setMarquee({ x, y, w: Math.abs(e.clientX - g.cx), h: Math.abs(e.clientY - g.cy), g: true });
          break;
        }
        case 'knife': {
          g.lx = e.clientX;
          g.ly = e.clientY;
          const rect = canvasRef.current?.getBoundingClientRect();
          const wk = screenToWorld(store.vp, e.clientX - (rect?.left || 0), e.clientY - (rect?.top || 0));
          setCutline({ x1: g.wx, y1: g.wy, x2: wk.x, y2: wk.y });
          break;
        }
        case 'node': {
          const z = store.vp.z || 1;
          store.dragMoveBy((e.clientX - g.lx) / z, (e.clientY - g.ly) / z);
          g.lx = e.clientX;
          g.ly = e.clientY;
          if (!store.dragMoved) break;
          /* цели сброса перетаскиваемой ноды (8602–8632): цепочка → нода-цель,
             иначе связь (встраивание существующей ноды) */
          const rect = canvasRef.current?.getBoundingClientRect();
          const wp = screenToWorld(store.vp, e.clientX - (rect?.left || 0), e.clientY - (rect?.top || 0));
          const stT = (store.sel.size === 1) ? stackDropTargetAt(store, [...store.sel][0], wp, sizesMap) : null;
          if (g.stackHl && (!stT || stT.id !== g.stackHl)) {
            const shl = document.querySelector('.node[data-node-id="' + g.stackHl + '"]');
            if (shl) shl.classList.remove('drop-hover');
            g.stackHl = null;
          }
          if (stT && g.stackHl !== stT.id) {
            const shl2 = document.querySelector('.node[data-node-id="' + stT.id + '"]');
            if (shl2) shl2.classList.add('drop-hover');
            g.stackHl = stT.id;
          }
          if (stT) {
            setDropEdge(null);
            g.dropEdge = null;
          } else if (store.sel.size === 1) {
            let deId = nearestEdgeIn(items, wp.x, wp.y, 16 / (store.vp.z || 1), store.sel);
            if (deId) {
              const de = store.edgeById(deId);
              if (de && isBridge(de)) deId = null;
            }
            g.dropEdge = deId;
            setDropEdge(deId);
          }
          break;
        }
        case 'group': {
          const z = store.vp.z || 1;
          const dx = (e.clientX - g.lx) / z;
          const dy = (e.clientY - g.ly) / z;
          g.lx = e.clientX;
          g.ly = e.clientY;
          for (const [id, b] of g.base) {
            if (id.startsWith('g:')) {
              const sg = store.groupById(id.slice(2));
              if (sg) { sg.x += dx; sg.y += dy; store.touchPos(id); }
            } else {
              const n = store.nodeById(id);
              if (n) { n.x += dx; n.y += dy; store.touchPos('n:' + id); }
            }
          }
          /* карточка/цепочка (fold<2) едет вместе с содержимым (8556–8560) */
          const gc = store.groupById(g.gid);
          if (gc && (gc.fold === undefined ? 2 : gc.fold) < 2) { gc.x += dx; gc.y += dy; store.touchPos('g:' + g.gid); }
          store.emit();
          /* живые перетаскивания: члены группы + рамки (включая подгруппы) */
          if (store.sync) {
            const ids = new Set<string>();
            const cards = new Set<string>([g.gid]);
            for (const [id] of g.base) {
              if (id.startsWith('g:')) cards.add(id.slice(2));
              else ids.add(id);
            }
            store.sync.liveDrag({ ids, cards });
          }
          break;
        }
        case 'gresize': {
          const dx = e.clientX - g.sx;
          const dy = e.clientY - g.sy;
          const gz = store.vp.z || 1;
          const sg = store.groupById(g.gid);
          if (!sg) break;
          void e;
          sg.auto = false;
          if (g.dir !== 'b') sg.fw = Math.max(60, Math.round(g.fw + dx / gz));
          if (g.dir !== 'r') sg.fh = Math.max(50, Math.round(g.fh + dy / gz));
          store.emit();
          break;
        }
        case 'link': {
          const rect = canvasRef.current?.getBoundingClientRect();
          const w = screenToWorld(store.vp, e.clientX - (rect?.left || 0), e.clientY - (rect?.top || 0));
          g.wx = w.x;
          g.wy = w.y;
          setPendingLink({ from: g.from, out: g.out, reply: g.reply, x: w.x, y: w.y, startX: g.sx, startY: g.sy });
          const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
          const node = el ? el.closest('[data-node-id]') : null;
          let target = node ? node.getAttribute('data-node-id') : null;
          const varin = !!(el && el.closest('[data-pin="varin"]'));
          /* карточка цепочки под курсором → её вход (elemTargetNodeId, 7847–7854) */
          const qEl = (!target && el) ? (el.closest('.qcard') as HTMLElement | null) : null;
          let qHl: HTMLElement | null = null;
          if (!target && qEl) {
            const gq = store.groupById(qEl.getAttribute('data-gid') || '');
            const qid = gq ? queueEntryId(store.doc, gq) : null;
            const srcN = store.nodeById(g.from);
            const srcQ = srcN ? store.stackGroupOf(srcN) : null;
            /* свою цепочку подсвечивать нельзя (8377–8381) */
            if (qid && (!srcQ || srcQ.id !== gq!.id)) { target = qid; qHl = qEl; }
            else target = null;
          }
          g.target = target && target !== g.from ? target : (target === g.from && g.reply ? target : null);
          g.varin = varin && !!g.target;
          setHoverTarget(g.target);
          setQCardHl(qHl);
          break;
        }
        case 'reattachOut': {
          g.lx = e.clientX;
          g.ly = e.clientY;
          const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
          const node = el ? el.closest('[data-node-id]') : null;
          let target = node ? node.getAttribute('data-node-id') : null;
          /* карточка цепочки → выход цепочки (elemTargetExitNodeId, 7856–7863) */
          let qHl: HTMLElement | null = null;
          if (!target && el) {
            const q = el.closest('.qcard') as HTMLElement | null;
            if (q) {
              const gq = store.groupById(q.getAttribute('data-gid') || '');
              const qid = gq ? queueExitId(store.doc, gq) : null;
              if (qid) { target = qid; qHl = q; }
            }
          }
          g.target = target && target !== g.from ? target : null;
          setHoverTarget(g.target);
          setQCardHl(qHl);
          break;
        }
        case 'reattachIn': {
          g.lx = e.clientX;
          g.ly = e.clientY;
          const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
          const node = el ? el.closest('[data-node-id]') : null;
          let target = node ? node.getAttribute('data-node-id') : null;
          /* карточка цепочки → вход цепочки (elemTargetNodeId, 7847–7854) */
          let qHl: HTMLElement | null = null;
          if (!target && el) {
            const q = el.closest('.qcard') as HTMLElement | null;
            if (q) {
              const gq = store.groupById(q.getAttribute('data-gid') || '');
              const qid = gq ? queueEntryId(store.doc, gq) : null;
              if (qid) { target = qid; qHl = q; }
            }
          }
          g.target = target && target !== g.to ? target : null;
          setHoverTarget(g.target);
          setQCardHl(qHl);
          break;
        }
        case 'wp': {
          const rect = canvasRef.current?.getBoundingClientRect();
          const w = screenToWorld(store.vp, e.clientX - (rect?.left || 0), e.clientY - (rect?.top || 0));
          store.moveWaypointLive(g.eid, g.idx, w.x, w.y);
          break;
        }
        case 'label': {
          const it = items.find((x) => x.e.id === g.eid);
          if (!it) break;
          const rect = canvasRef.current?.getBoundingClientRect();
          const w = screenToWorld(store.vp, e.clientX - (rect?.left || 0), e.clientY - (rect?.top || 0));
          // пересчитать lt по ближайшей точке пути
          const P = [{ x: it.g.x1, y: it.g.y1 }, ...(it.g.corners && it.g.corners.length ? it.g.corners : (it.g.pts || [])), { x: it.g.x2, y: it.g.y2 }];
          const near = nearestSegPoint(P, w.x, w.y);
          const total = P.length - 1;
          const lt = clamp(total > 0 ? near.seg / total : 0.5, 0.04, 0.96);
          const mid = { x: (P[Math.min(near.seg + 1, total)].x + P[near.seg].x) / 2, y: (P[Math.min(near.seg + 1, total)].y + P[near.seg].y) / 2 };
          const dx = w.x - mid.x;
          const dy = w.y - mid.y;
          const len = Math.hypot(dx, dy) || 1;
          // знак по нормали
          const nx = -(P[Math.min(near.seg + 1, total)].y - P[near.seg].y);
          const ny = P[Math.min(near.seg + 1, total)].x - P[near.seg].x;
          const side = (dx * nx + dy * ny) >= 0 ? 1 : -1;
          const ed = store.edgeById(g.eid);
          if (ed) {
            ed.lt = lt;
            ed.lp = clamp(side * Math.min(44, len), -44, 44);
            store.touchPos('e:' + g.eid);
            store.emit();
          }
          break;
        }
        case 'bridge': {
          const z = store.vp.z || 1;
          const dx = (e.clientX - g.lx) / z;
          const dy = (e.clientY - g.ly) / z;
          g.lx = e.clientX;
          g.ly = e.clientY;
          const ndl = g.part === 'l' ? g.dl + dx : g.dl;
          const ndr = g.part === 'r' ? g.dr - dx : g.dr;
          const ndy = g.part === 'h' ? g.dy + dy : g.dy;
          g.dl = ndl;
          g.dr = ndr;
          g.dy = ndy;
          store.bridgeDragLive(g.eid, ndl, ndy, ndr);
          break;
        }
        case 'dlgW': {
          const z = store.vp.z || 1;
          store.setDlgWidth(g.id, g.startW + (e.clientX - g.startX) / z);
          break;
        }
      }
    };
    const up = (e: MouseEvent) => {
      const g = gestRef.current;
      gestRef.current = null;
      store.syncBusyFlag = false;
      store.gestureRollback = null;
      store.gestureIds.clear();
      /* жест завершён: отдаём локи жеста (8700 оригинала). Без активного жеста —
         ничего не отдаём: клик по полю инспектора не должен ронять edit-лок. */
      if (g && store.sync && store.sync.enabled) store.sync.lockGiveAll(store.editLockIds);
      if (g && g.mode === 'pan') { setPanning(false); document.body.classList.remove('panning'); }
      if (!g) return;
      setQCardHl(null);
      switch (g.mode) {
        case 'pan': store.panEnd(); break;
        case 'marquee': setMarquee(null); break;
        case 'gcreate': {
          setMarquee(null);
          const rect = canvasRef.current?.getBoundingClientRect();
          if (!rect) break;
          const wa = screenToWorld(store.vp, Math.min(g.cx, g.sx) - rect.left, Math.min(g.cy, g.sy) - rect.top);
          const wb = screenToWorld(store.vp, Math.max(g.cx, g.sx) - rect.left, Math.max(g.cy, g.sy) - rect.top);
          const w = wb.x - wa.x;
          const h = wb.y - wa.y;
          if (w < 10 && h < 10) {
            store.createDrawnGroup({ x: wa.x - 110, y: wa.y - 75, w: 220, h: 150 });
          } else {
            store.createDrawnGroup({ x: wa.x, y: wa.y, w, h });
          }
          break;
        }
        case 'knife': {
          setCutline(null);
          const rect = canvasRef.current?.getBoundingClientRect();
          if (!rect) break;
          const a = screenToWorld(store.vp, g.sx - rect.left, g.sy - rect.top);
          const b = screenToWorld(store.vp, g.lx - rect.left, g.ly - rect.top);
          const moved = Math.hypot(g.lx - g.sx, g.ly - g.sy) > 6;
          if (!moved) {
            // одиночный клик: разрезать связь под курсором
            const el = document.elementFromPoint(g.lx, g.ly) as HTMLElement | null;
            const path = el ? el.closest('svg.rn-edges path.hit, svg#edges path.hit') : null;
            void path;
            const hit = items.find((it) => {
              const pts = it.pts;
              for (let i = 0; i < pts.length - 1; i++) {
                const ax = pts[i].x * store.vp.z + store.vp.x + rect.left;
                const ay = pts[i].y * store.vp.z + store.vp.y + rect.top;
                const bx = pts[i + 1].x * store.vp.z + store.vp.x + rect.left;
                const by = pts[i + 1].y * store.vp.z + store.vp.y + rect.top;
                // расстояние от точки до отрезка < 12px
                const d = distToSeg(g.lx, g.ly, ax, ay, bx, by);
                if (d < 12) return true;
              }
              return false;
            });
            if (hit) store.knifeSingleEdge(hit.e.id);
            break;
          }
          store.knifeCut({ x1: a.x, y1: a.y, x2: b.x, y2: b.y }, (ed) => {
            const it = items.find((x) => x.e.id === ed.id);
            return it ? it.pts : null;
          });
          break;
        }
        case 'node': {
          /* подсветки сброса (8941–8945) */
          if (g.stackHl) {
            const shl = document.querySelector('.node[data-node-id="' + g.stackHl + '"]');
            if (shl) shl.classList.remove('drop-hover');
          }
          setDropEdge(null);
          const movedN = store.dragMoved;
          const preN = store.dragStartSnapshot || store.serialize();
          const dragId = store.sel.size === 1 ? [...store.sel][0] : null;
          const rectN = canvasRef.current?.getBoundingClientRect();
          const wpUp = rectN ? screenToWorld(store.vp, e.clientX - rectN.left, e.clientY - rectN.top) : null;
          /* нода брошена на stackable-ноду → сборка/пополнение цепочки (8946–8951) */
          if (movedN && dragId && wpUp) {
            const stT = stackDropTargetAt(store, dragId, wpUp, sizesMap);
            if (stT) {
              store.stackDropCreate(dragId, stT.id, preN);
              store.finishGestureDrag();
              break;
            }
          }
          /* нода брошена на связь → встраивание существующей ноды (8952–8956) */
          if (movedN && dragId && g.dropEdge) {
            const nIns = store.nodeById(dragId);
            const edIns = store.edgeById(g.dropEdge);
            if (nIns && edIns && !isBridge(edIns)) store.performInsert(nIns, edIns.id, preN, false);
            else if (nIns && edIns) store.toast('В мост нельзя вставить элемент', 'warn');
            store.finishGestureDrag();
            break;
          }
          /* захват групп/цепочек после переноса (8958–8982): нода над карточкой цепочки
             — в конец цепочки, иначе — gid глубочайшей группы под центром ноды */
          if (movedN) {
            let changedG = false;
            for (const id of store.sel) {
              const nn = store.nodeById(id);
              if (!nn) continue;
              const s = sizesMap.get(id);
              const w = s ? s.w : NODE_W;
              const h = s ? s.h : 90;
              const tg = store.deepestGroupAt(nn.x + w / 2, nn.y + h / 2, sizesMap, cardSizes);
              let appended = false;
              if (tg && tg.stack === true) appended = store.stackAppend(tg, id);
              else if (!tg && wpUp) {
                const tgS = store.deepestGroupAt(wpUp.x, wpUp.y, sizesMap, cardSizes);
                if (tgS && tgS.stack === true) appended = store.stackAppend(tgS, id);
              }
              if (!appended) {
                const ngid = tg ? tg.id : null;
                if ((nn.gid || null) !== ngid) { nn.gid = ngid; changedG = true; }
              } else {
                changedG = true;
              }
            }
            if (changedG) store.emit();
          }
          store.dragEnd();
          break;
        }
        case 'group': {
          if (store.snapOn) {
            for (const [id] of g.base) {
              if (id.startsWith('g:')) {
                const sg = store.groupById(id.slice(2));
                if (sg) { sg.x = snapVal(sg.x, true); sg.y = snapVal(sg.y, true); }
              } else {
                const n = store.nodeById(id);
                if (n) { n.x = snapVal(n.x, true); n.y = snapVal(n.y, true); }
              }
            }
            const gcS = store.groupById(g.gid);
            if (gcS && (gcS.fold === undefined ? 2 : gcS.fold) < 2) {
              gcS.x = snapVal(gcS.x, true);
              gcS.y = snapVal(gcS.y, true);
            }
            store.emit();
          }
          store.dragEnd();
          store.reparentAfterMove();
          /* перенос цепочки: парк-ноды выравниваются по карточке после жеста
             (8918 оригинала: if(ggU.stack)stackSyncParks(ggU)) */
          const gcU = store.groupById(g.gid);
          if (gcU && gcU.stack === true) {
            stackSyncParks(store.doc, gcU);
            store.scheduleSave();
            store.emit();
          }
          break;
        }
        case 'gresize': {
          store.commitEdit(store.dragStartSnapshot, 'Ресайз группы');
          store.finishGestureDrag();
          store.scheduleSave();
          store.emit();
          // ноды, чьи центры вышли за рамку, покидают группу
          const sg = store.groupById(g.gid);
          if (sg) {
            const rect = { x: sg.x, y: sg.y, w: sg.fw || 220, h: sg.fh || 150 };
            let changed = false;
            for (const n of store.doc.nodes) {
              if (n.gid !== g.gid) continue;
              const s = sizesMap.get(n.id);
              const cx = n.x + (s ? s.w : 216) / 2;
              const cy = n.y + (s ? s.h : 90) / 2;
              if (cx < rect.x || cx > rect.x + rect.w || cy < rect.y || cy > rect.y + rect.h) {
                n.gid = sg.parent || null;
                changed = true;
              }
            }
            if (changed) { store.scheduleSave(); store.emit(); }
          }
          break;
        }
        case 'link': {
          if (g.target) {
            if (g.varin) {
              const tn = store.nodeById(g.target);
              const fn = store.nodeById(g.from);
              if (tn && fn && fn.type === 'varnode' && tn.type === 'branch') {
                store.connectNodes(g.from, g.target, { tin: 'var' });
              } else {
                store.toast('Связь «вход переменной» — от ноды Переменной к Развилке', 'warn');
              }
            } else {
              store.connectNodes(g.from, g.target, { fromOut: g.out, fromReply: g.reply });
            }
          } else {
            // меню «Создать и подключить» в точке отпускания
            const menus = ctxMenus(store);
            store.openCtx(lastMouse.x, lastMouse.y, menus.connectFrom(g.from, g.out, g.reply, lastMouse.x, lastMouse.y));
          }
          setPendingLink(null);
          setHoverTarget(null);
          break;
        }
        case 'reattachOut': {
          if (g.target && g.target !== g.from) {
            const pre = store.beginEdit();
            const edges = store.doc.edges.filter((ed) => ed.from === g.from);
            let applied = 0;
            for (const ed of edges) {
              if (ed.to === g.target) continue;
              ed.from = g.target as string;
              ed.fromReply = null;
              applied++;
            }
            store.commitEdit(pre, 'Перенос исходящих стрелок');
            store.toast(applied > 1 ? 'Переподключено выходов: ' + applied : 'Исходящая стрелка переподключена');
          }
          setHoverTarget(null);
          break;
        }
        case 'reattachIn': {
          if (g.target && g.target !== g.to) {
            const pre = store.beginEdit();
            const edges = store.doc.edges.filter((ed) => ed.to === g.to);
            let applied = 0;
            for (const ed of edges) {
              if (ed.from === g.target) continue;
              ed.to = g.target as string;
              applied++;
            }
            store.commitEdit(pre, 'Перенос входящих стрелок');
            store.toast(applied > 1 ? 'Переподключено входов: ' + applied : 'Входящая стрелка переподключена');
          }
          setHoverTarget(null);
          break;
        }
        case 'wp': {
          store.commitEdit(store.dragStartSnapshot, 'Изгиб связи');
          store.finishGestureDrag();
          store.scheduleSave();
          store.emit();
          break;
        }
        case 'label': {
          store.commitEdit(store.dragStartSnapshot, 'Якорь подписи');
          store.finishGestureDrag();
          store.scheduleSave();
          store.emit();
          break;
        }
        case 'bridge': {
          store.bridgeDragEnd(store.dragStartSnapshot || store.serialize());
          store.finishGestureDrag();
          break;
        }
        case 'dlgW': {
          store.commitEdit(store.dragStartSnapshot, 'Ширина диалога');
          store.finishGestureDrag();
          store.scheduleSave();
          store.emit();
          break;
        }
      }
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      store.syncBusyFlag = false;
      store.gestureRollback = null;
    };
  }, [store, doc, items, sizesMap, cardSizes]);


  /* Alt → нож (курсор — через body.knife, как в оригинале) */
  useEffect(() => {
    const kd = (e: KeyboardEvent) => {
      if (e.key === 'Alt' && !isTyping()) { setAltDown(true); store.knifeOn = true; document.body.classList.add('knife'); store.emit(); }
      if (e.key === 'Control' || e.key === 'Meta') { store.ctrlDown = true; document.body.classList.add('ctrlpan'); store.emit(); }
      if (e.code === 'Space' && !isTyping()) { store.spaceDown = true; document.body.classList.add('space'); store.emit(); e.preventDefault(); }
    };
    const ku = (e: KeyboardEvent) => {
      if (e.key === 'Alt') { setAltDown(false); store.knifeOn = false; document.body.classList.remove('knife'); store.emit(); }
      if (e.key === 'Control' || e.key === 'Meta') { store.ctrlDown = false; document.body.classList.remove('ctrlpan'); store.emit(); }
      if (e.code === 'Space') { store.spaceDown = false; document.body.classList.remove('space'); store.emit(); }
    };
    const kb = () => {
      setAltDown(false);
      store.knifeOn = false;
      store.spaceDown = false;
      store.ctrlDown = false;
      document.body.classList.remove('knife', 'ctrlpan', 'space', 'panning');
      store.emit();
    };
    window.addEventListener('keydown', kd);
    window.addEventListener('keyup', ku);
    window.addEventListener('blur', kb);
    return () => {
      window.removeEventListener('keydown', kd);
      window.removeEventListener('keyup', ku);
      window.removeEventListener('blur', kb);
    };

  }, []);

  /* курсор copy при переносе дубликата (body.carry оригинала) */
  useEffect(() => {
    document.body.classList.toggle('carry', !!store.carry);
    return () => { document.body.classList.remove('carry'); };
  }, [store.carry]);

  /* ── drag&drop из палитры на холст (порт 9148–9267 оригинала) ──
     dropready — рамка на #canvas; dropping — на document.body (body.dropping .port в CSS);
     drop-hover — карточка ноды под курсором (palHover); drop-target — связь-цель
     (setDropEdge оригинала вешает класс на g.edge, React — императивно тот же элемент) */
  const hasPalData = (e: React.DragEvent): boolean => {
    const types = e.dataTransfer ? Array.from(e.dataTransfer.types) : [];
    return types.indexOf('text/vetvi-type') >= 0 || types.indexOf('text/vetvi-clone') >= 0 || types.indexOf('text/vetvi-var') >= 0;
  };
  const palHoverRef = useRef<HTMLElement | null>(null);
  const clearDropVisuals = useCallback(() => {
    setDropReady(false);
    document.body.classList.remove('dropping');
    setDropEdge(null);
    if (palHoverRef.current) { palHoverRef.current.classList.remove('drop-hover'); palHoverRef.current = null; }
  }, [setDropEdge]);
  const onDragOver = useCallback((e: React.DragEvent) => {
    if (!hasPalData(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    setDropReady(true);
    document.body.classList.add('dropping');
    /* нода под курсором (elpp оригинала): closest('.node') */
    const elp = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
    const nodeEl = elp ? (elp.closest('.node') as HTMLElement | null) : null;
    const under = nodeEl && nodeEl.style.display !== 'none' ? nodeEl : null;
    if (palHoverRef.current && palHoverRef.current !== under) palHoverRef.current.classList.remove('drop-hover');
    palHoverRef.current = under;
    if (under) {
      under.classList.add('drop-hover');
      setDropEdge(null);
    } else {
      /* хит-тест связи (nearestEdgeAt оригинала): 16/vp.z, мосты не подсвечиваем */
      const rect = canvasRef.current?.getBoundingClientRect();
      const w = screenToWorld(store.vp, e.clientX - (rect?.left || 0), e.clientY - (rect?.top || 0));
      let hovId = nearestEdgeIn(items, w.x, w.y, 16 / (store.vp.z || 1), null);
      if (hovId) {
        const hovE = store.edgeById(hovId);
        if (hovE && isBridge(hovE)) hovId = null;
      }
      setDropEdge(hovId);
    }
  }, [store, items, setDropEdge]);
  const onDragLeave = useCallback(() => {
    clearDropVisuals();
  }, [clearDropVisuals]);
  /* dragend на window — снятие подсветок при отмене перетаскивания (9176 оригинала) */
  useEffect(() => {
    const de = () => clearDropVisuals();
    window.addEventListener('dragend', de);
    return () => window.removeEventListener('dragend', de);
  }, [clearDropVisuals]);
  const onDrop = useCallback((e: React.DragEvent) => {
    const dt = e.dataTransfer;
    const t = dt ? dt.getData('text/vetvi-type') : '';
    const cl = dt ? dt.getData('text/vetvi-clone') : '';
    const vr = dt ? dt.getData('text/vetvi-var') : '';
    if (!t && !cl && !vr) { clearDropVisuals(); return; }
    e.preventDefault();
    const eid = dropEdgeRef.current;
    const hoverNode = palHoverRef.current;
    clearDropVisuals();
    const rect = canvasRef.current?.getBoundingClientRect();
    const w = screenToWorld(store.vp, e.clientX - (rect?.left || 0), e.clientY - (rect?.top || 0));
    /* переменная, перетащенная из вкладки «Переменные» → нода переменной (9210–9223) */
    if (vr && !t && !cl) {
      const vv = varById(store.doc, vr);
      if (vv) {
        const vn = newNode('varnode', Math.round(w.x - NODE_W / 2), Math.round(w.y - 20));
        vn.title = vv.name;
        vn.varMode = 'set';
        vn.varOp = '=';
        vn.varVal = defValOf(vv);
        vn.vid = vr;
        const tgV = store.deepestGroupAt(w.x, w.y, sizesMap, cardSizes);
        vn.gid = tgV ? tgV.id : null;
        store.mutate((d) => { d.nodes.push(vn); }, { label: 'Создание ноды переменной' });
        store.resolveOverlaps(new Set([vn.id]));
        store.selectOnly(vn.id);
        store.toast('Нода переменной «' + vv.name + '» создана. Режим «изменение» можно переключить на «чтение» в инспекторе.');
      }
      return;
    }
    /* тип/клон НА связь → встраивание (9224–9237) */
    const edge = eid ? store.edgeById(eid) : null;
    if (edge) {
      if (isBridge(edge)) { store.toast('В мост нельзя вставить элемент', 'warn'); return; }
      const it0 = items.find((x) => x.e.id === edge.id);
      const g0 = it0 ? it0.g : null;
      if (t) {
        store.insertNewAtEdge(edge.id, t, null, g0);
      } else {
        const src0 = store.nodeById(cl);
        if (src0) {
          const pre = store.serialize();
          const cn0 = store.cloneNodeAt(src0, w.x - NODE_W / 2, w.y - 20);
          store.performInsert(cn0, edge.id, pre, true, null, g0);
        }
      }
      return;
    }
    /* тип/клон НА ноду → справа и подключить (attachNewTo; свой клон на себя — в точку курсора) */
    if (hoverNode) {
      const tid = hoverNode.getAttribute('data-node-id');
      const target = tid ? store.nodeById(tid) : null;
      if (target) {
        if (cl && cl === target.id) {
          const srcX = store.nodeById(cl);
          if (srcX) {
            const cnX = store.cloneNodeAt(srcX, w.x - NODE_W / 2, w.y - 20);
            store.mutate((d) => { d.nodes.push(cnX); }, { label: 'Создание и подключение' });
            store.selectOnly(cnX.id);
          }
          return;
        }
        store.attachNewTo(target.id, t || null, cl || null, sizesMap, cardSizes);
        return;
      }
    }
    /* в пустоту: тип → addNode + группа в точке; клон → cloneNode + группа (9254–9266) */
    const ng = store.deepestGroupAt(w.x, w.y, sizesMap, cardSizes);
    if (t) {
      const nn = store.addNodeAt(t, w.x - NODE_W / 2, w.y - 20);
      if (nn && ng) store.updateNode(nn.id, { gid: ng.id }, { history: false });
      return;
    }
    const src = store.nodeById(cl);
    if (src) {
      const cn2 = store.cloneNodeAt(src, w.x - NODE_W / 2, w.y - 20);
      if (ng) cn2.gid = ng.id;
      store.mutate((d) => { d.nodes.push(cn2); }, { label: 'Создание и подключение' });
      store.selectOnly(cn2.id);
    }
  }, [store, items, sizesMap, cardSizes, clearDropVisuals]);

  /* отслеживание ноды под курсором (для старта плеера по P) */
  const lastPtr = useRef({ x: 0, y: 0 });
  useEffect(() => {
    const mm = (e: MouseEvent) => {
      lastPtr.current = { x: e.clientX, y: e.clientY };
      lastMouse.x = e.clientX;
      lastMouse.y = e.clientY;
      store.lastPtr = { x: e.clientX, y: e.clientY };
    };
    window.addEventListener('mousemove', mm);
    return () => window.removeEventListener('mousemove', mm);
  }, []);
  useEffect(() => {
    store.registerPointerFn(() => {
      const el = document.elementFromPoint(lastPtr.current.x, lastPtr.current.y) as HTMLElement | null;
      const node = el ? el.closest('[data-node-id]') : null;
      const nid = node ? node.getAttribute('data-node-id') : null;
      if (nid && store.nodeById(nid)) return nid;
      if (store.sel.size === 1) return [...store.sel][0];
      return null;
    });
  }, [store]);

  /* ── колбэки для встраивания в связь и автораздвижки (порт resolveOverlaps/performInsert) ──
     dims — измеренные карточки (dims оригинала через nodeEls; нет измерения → дефолт NODE_W/90);
     edgeGeom — геометрия связи из items EdgeLayer (аналог edgeGeom(e) оригинала) */
  useEffect(() => {
    store.registerDimsFn((id) => sizesMap.get(id) || null);
    store.registerEdgeGeomFn((eid) => {
      const it = items.find((x) => x.e.id === eid);
      return it ? it.g : null;
    });
  }, [store, sizesMap, items]);

  /* ПКМ по холсту/нодам/связям/группам → контекстные меню */
  const onCtx = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const t = e.target as HTMLElement;
    const menus = ctxMenus(store);
    const nodeEl = t.closest('[data-node-id]') as HTMLElement | null;
    if (nodeEl) {
      const nid = nodeEl.getAttribute('data-node-id') as string;
      if (!store.sel.has(nid)) store.selectOnly(nid);
      store.openCtx(e.clientX, e.clientY, menus.node(nid));
      return;
    }
    const egEl = t.closest('g.rn-eg, g.edge, [data-edge-id]') as SVGGElement | null;
    if (egEl) {
      const eid = egEl.getAttribute('data-edge-id');
      if (eid && store.edgeById(eid)) {
        store.selectEdgeOnly(eid);
        store.openCtx(e.clientX, e.clientY, menus.edge(eid));
        return;
      }
    }
    const gEl = t.closest('.rn-gframe, .rn-gcard, .groupbox, .gcard, .qcard') as HTMLElement | null;
    if (gEl) {
      const gid = findGidFromEl(store, gEl);
      if (gid) {
        if (!store.selGroups.has(gid)) store.selectGroupOnly(gid);
        store.openCtx(e.clientX, e.clientY, menus.group(gid));
        return;
      }
    }
    store.openCtx(e.clientX, e.clientY, menus.canvas(e.clientX, e.clientY));
  }, [store, items]);

  /* двойной клик по пустому месту → меню «Добавить» */
  const onDbl = useCallback((e: React.MouseEvent) => {
    const t = e.target as HTMLElement;
    if (t.closest('[data-node-id]') || t.closest('svg.rn-edges, svg#edges') || t.closest('.rn-gframe, .groupbox') || t.closest('.rn-gcard, .gcard, .qcard')) return;
    const menus = ctxMenus(store);
    store.openCtx(e.clientX, e.clientY, menus.canvas(e.clientX, e.clientY, true));
  }, [store]);

  void tick;

  /* ═══ мини-карта: состояние вида + жесты (1:1 с окном 9269–9372 оригинала) ═══
     mmView/mmDim — state (реф-в-рендер запрещён react-hooks/refs), жесты — через рефы */
  const mmRef = useRef<HTMLDivElement>(null);
  const [mmView, setMmView] = useState({ x: 0, y: 0, z: 0.2 });
  /* null — CSS-размер по умолчанию (260×180 / 170×120 в узких окнах), как в оригинале до ресайза */
  const [mmDim, setMmDim] = useState<{ w: number; h: number } | null>(null);
  const [canvasSize, setCanvasSize] = useState({ w: 0, h: 0 });
  const mmReadyRef = useRef(false);
  const mmFrameDragRef = useRef<{ wx: number; wy: number; cx: number; cy: number } | null>(null);
  const mmPanRef = useRef<{ sx: number; sy: number; vx: number; vy: number } | null>(null);
  const mmResizeRef = useRef<{ sw: number; sh: number; cx: number; cy: number } | null>(null);
  /* кулдаун ручных жестов карты (пан СКМ/колесо): автоследование подождёт, пока пользователь
     сам рассматривает карту — mmManualFollow оригинала не было, это доработка по фидбеку */
  const mmManualTRef = useRef(0);

  /* размер холста для рамки вида #mmView (canvas.clientWidth оригинала) */
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const measure = () => setCanvasSize({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    window.addEventListener('resize', measure);
    return () => { ro.disconnect(); window.removeEventListener('resize', measure); };
  }, []);

  /* mmToLocal/mmToWorld оригинала: координаты в логической системе viewBox (260×180 по умолчанию) */
  const mmToLocal = useCallback((clientX: number, clientY: number) => {
    const box = mmRef.current?.getBoundingClientRect();
    const hs = box ? (box.width / (mmDim ? mmDim.w : MM_DEF_W)) || 1 : 1;
    return { x: (clientX - (box ? box.left : 0)) / hs, y: (clientY - (box ? box.top : 0)) / hs };
  }, [mmDim]);

  /* mmFit оригинала — один раз, когда ноды измерены: bbox контента ∪ вид холста, pad 16, z 0.02..4 */
  useEffect(() => {
    if (mmReadyRef.current) return;
    const el = canvasRef.current;
    if (!el || !el.clientWidth) return;
    if (visibleNodes.length > 0 && sizesMap.size < visibleNodes.length) return;
    const b = mmBBoxOf(doc, visibleNodes, sizesMap, cardSizes);
    const v = mmViewportBoxOf(store.vp, el.clientWidth, el.clientHeight);
    const x1 = b ? Math.min(b.x1, v.x1) : v.x1;
    const y1 = b ? Math.min(b.y1, v.y1) : v.y1;
    const x2 = b ? Math.max(b.x2, v.x2) : v.x2;
    const y2 = b ? Math.max(b.y2, v.y2) : v.y2;
    const bw = Math.max(1, x2 - x1);
    const bh = Math.max(1, y2 - y1);
    const pad = 16;
    const z = clamp(Math.min(((mmDim ? mmDim.w : MM_DEF_W) - pad * 2) / bw, ((mmDim ? mmDim.h : MM_DEF_H) - pad * 2) / bh), 0.02, 4);
    const mvFit = { x: (x1 + x2) / 2 - (mmDim ? mmDim.w : MM_DEF_W) / (2 * z), y: (y1 + y2) / 2 - (mmDim ? mmDim.h : MM_DEF_H) / (2 * z), z };
    /* setState в кадре анимации — не синхронно в эффекте (иначе каскад рендеров) */
    const raf = requestAnimationFrame(() => { mmReadyRef.current = true; setMmView(mvFit); });
    return () => cancelAnimationFrame(raf);
  });

  /* Автоследование карты за видом холста: если рамка вида (#mmView) ушла за пределы
     окна карты (уход далеко в сторону/зум), обзор карты перецентрируется на наш вид,
     а масштаб ужмётся, если вид не влезает. Ручные жесты карты (пан СКМ, колесо)
     приостанавливают следование на 2.5с, чтобы можно было спокойно изучить карту.
     Эффект без зависимостей: CanvasBoard перерисовывается на каждый emit стора
     (пан/зум/правки) — следование проверяется в кадре rAF, без setState в теле. */
  const mmFollowNow = () => {
    if (!mmReadyRef.current) return;
    if (mmFrameDragRef.current || mmPanRef.current || mmResizeRef.current) return;
    if (Date.now() - mmManualTRef.current < 2500) return;
    const el = canvasRef.current;
    if (!el || !el.clientWidth) return;
    const v = mmViewportBoxOf(store.vp, el.clientWidth, el.clientHeight);
    const vw = Math.max(1, v.x2 - v.x1);
    const vh = Math.max(1, v.y2 - v.y1);
    const mw0 = mmDim ? mmDim.w : MM_DEF_W;
    const mh0 = mmDim ? mmDim.h : MM_DEF_H;
    const mw = mw0 / mmView.z;
    const mh = mh0 / mmView.z;
    /* покрытие рамки вида окном карты: видимы ≥60% — не мешаем; меньше — догоняем */
    const ix = Math.max(0, Math.min(v.x2, mmView.x + mw) - Math.max(v.x1, mmView.x));
    const iy = Math.max(0, Math.min(v.y2, mmView.y + mh) - Math.max(v.y1, mmView.y));
    if ((ix * iy) / (vw * vh) >= 0.6) return;
    let nz = mmView.z;
    if (vw > mw * 0.9 || vh > mh * 0.9) nz = clamp(Math.min((mw0 * 0.9) / vw, (mh0 * 0.9) / vh), 0.02, 6);
    const vcx = (v.x1 + v.x2) / 2;
    const vcy = (v.y1 + v.y2) / 2;
    setMmView({ x: vcx - mw0 / (2 * nz), y: vcy - mh0 / (2 * nz), z: nz });
  };
  useEffect(() => {
    const raf = requestAnimationFrame(() => mmFollowNow());
    return () => cancelAnimationFrame(raf);
  });

  /* mmFrameMove оригинала: ЛКМ на карте тянет вид холста за курсор */
  const mmFrameMove = useCallback((e: PointerEvent) => {
    const fd = mmFrameDragRef.current;
    const el = canvasRef.current;
    if (!fd || !el) return;
    const p = mmToLocal(e.clientX, e.clientY);
    const wx = mmView.x + p.x / mmView.z;
    const wy = mmView.y + p.y / mmView.z;
    const ncx = fd.cx + (wx - fd.wx);
    const ncy = fd.cy + (wy - fd.wy);
    const vw = el.clientWidth / store.vp.z;
    const vh = el.clientHeight / store.vp.z;
    store.setViewport({ x: -(ncx - vw / 2) * store.vp.z, y: -(ncy - vh / 2) * store.vp.z });
  }, [mmToLocal, mmView, store]);

  /* mmPanMove оригинала: СКМ панорамирует обзор самой карты */
  const mmPanMove = useCallback((e: PointerEvent) => {
    const pn = mmPanRef.current;
    if (!pn) return;
    const p = mmToLocal(e.clientX, e.clientY);
    setMmView((prev) => ({ x: pn.vx - (p.x - pn.sx) / prev.z, y: pn.vy - (p.y - pn.sy) / prev.z, z: prev.z }));
  }, [mmToLocal]);

  /* mmResizeMove оригинала: угол карты — px-размер #miniMap + viewBox #mmSvg, центр обзора на месте */
  const mmResizeMove = useCallback((e: PointerEvent) => {
    const s = mmResizeRef.current;
    if (!s) return;
    const dx = e.clientX - s.cx;
    const dy = e.clientY - s.cy;
    const nw = clamp(s.sw - dx, MM_MIN_W, 1400);
    const nh = clamp(s.sh + dy, MM_MIN_H, 1000);
    setMmDim({ w: nw, h: nh });
    setMmView((prev) => {
      const cwx = prev.x + s.sw / (2 * prev.z);
      const cwy = prev.y + s.sh / (2 * prev.z);
      return { x: cwx - nw / (2 * prev.z), y: cwy - nh / (2 * prev.z), z: prev.z };
    });
  }, []);

  /* глобальные pointermove/pointerup жестов карты (окно 8316/8700 оригинала) */
  useEffect(() => {
    const move = (e: PointerEvent) => {
      if (mmResizeRef.current) { mmResizeMove(e); return; }
      if (mmFrameDragRef.current) { mmFrameMove(e); return; }
      if (mmPanRef.current) { mmPanMove(e); return; }
    };
    const up = () => {
      if (mmResizeRef.current) {
        mmResizeRef.current = null;
        const mb = mmRef.current;
        if (mb) mb.classList.remove('mm-resizing');
        return;
      }
      if (mmFrameDragRef.current) {
        mmFrameDragRef.current = null;
        const mf = mmRef.current;
        if (mf) mf.style.cursor = '';
        return;
      }
      if (mmPanRef.current) {
        mmPanRef.current = null;
        const mf = mmRef.current;
        if (mf) mf.style.cursor = '';
        return;
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
  }, [mmResizeMove, mmFrameMove, mmPanMove]);

  /* wheel на карте — зум обзора оригинала (passive:false, 9337) */
  useEffect(() => {
    const el = mmRef.current;
    if (!el) return;
    const onMmWheel = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();
      mmManualTRef.current = Date.now(); /* ручной жест — приостановить автоследование */
      const p = mmToLocal(e.clientX, e.clientY);
      const f = e.deltaY < 0 ? 1.12 : 1 / 1.12;
      setMmView((prev) => {
        const wx = prev.x + p.x / prev.z;
        const wy = prev.y + p.y / prev.z;
        const nz = clamp(prev.z * f, 0.02, 6);
        return { x: wx - p.x / nz, y: wy - p.y / nz, z: nz };
      });
    };
    el.addEventListener('wheel', onMmWheel, { passive: false });
    return () => el.removeEventListener('wheel', onMmWheel);
  }, [mmToLocal]);

  /* pointerdown на карте: ЛКМ — тянет вид, СКМ — пан обзора (обработчик 9318 оригинала) */
  const onMmDown = useCallback((e: React.PointerEvent) => {
    const t = e.target as Element;
    if (t.closest && t.closest('.mm-resize')) return;
    const mb = mmRef.current;
    if (!mb) return;
    const p = mmToLocal(e.clientX, e.clientY);
    if (e.button === 0) {
      e.preventDefault();
      e.stopPropagation();
      const el = canvasRef.current;
      const vb = el && el.clientWidth ? mmViewportBoxOf(store.vp, el.clientWidth, el.clientHeight) : { x1: 0, y1: 0, x2: 0, y2: 0 };
      const wx = mmView.x + p.x / mmView.z;
      const wy = mmView.y + p.y / mmView.z;
      mmFrameDragRef.current = { wx, wy, cx: (vb.x1 + vb.x2) / 2, cy: (vb.y1 + vb.y2) / 2 };
      mb.style.cursor = 'grabbing';
      return;
    }
    if (e.button === 1) {
      e.preventDefault();
      e.stopPropagation();
      mmManualTRef.current = Date.now(); /* ручной жест — приостановить автоследование */
      mmPanRef.current = { sx: p.x, sy: p.y, vx: mmView.x, vy: mmView.y };
      mb.style.cursor = 'grabbing';
    }
  }, [mmToLocal, mmView, store]);

  /* pointerdown на .mm-resize — старт ресайза карты (9346 оригинала) */
  const onMmResizeDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const mb = mmRef.current;
    if (!mb) return;
    mb.classList.add('mm-resizing');
    mmResizeRef.current = { sw: mmDim ? mmDim.w : MM_DEF_W, sh: mmDim ? mmDim.h : MM_DEF_H, cx: e.clientX, cy: e.clientY };
  }, [mmDim]);

  const onMmCtx = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
  }, []);

  /* mmRebuild+mmGeom оригинала — декларативно: группы (пунктир цвета группы) / связи / ноды */
  const mmGroupRects: React.ReactNode[] = [];
  for (const g of doc.groups) {
    if (groupInsideCollapsed(doc, g)) continue;
    const r = mmGroupWorldRect(doc, g, sizesMap, cardSizes);
    mmGroupRects.push(
      <rect key={g.id} data-gid={g.id} fill="none" stroke={g.color || '#9aa1ac'} strokeOpacity="0.7" rx="3" strokeDasharray="4 3" vectorEffect="non-scaling-stroke" x={r.x} y={r.y} width={r.w} height={r.h} />,
    );
  }
  const mmEdgeLines: React.ReactNode[] = [];
  for (const it of items) {
    const k = it.e.kind;
    const col = k === 'bridge' ? '#79808d' : k === 'choice' ? '#8a8f99' : k === 'cond' ? '#6f7580' : '#575d68';
    mmEdgeLines.push(
      <line key={it.e.id} data-eid={it.e.id} x1={it.g.x1} y1={it.g.y1} x2={it.g.x2} y2={it.g.y2} stroke={col} strokeWidth={k === 'bridge' ? '2.4' : '1.2'} vectorEffect="non-scaling-stroke" />,
    );
  }
  const mmNodeRects: React.ReactNode[] = [];
  for (const n of visibleNodes) {
    const s = sizesMap.get(n.id);
    const w = s ? s.w : NODE_W;
    const h = s ? s.h : 90;
    mmNodeRects.push(
      <rect key={n.id} data-id={n.id} x={n.x} y={n.y} width={w} height={h} fill={mmNodeColor(store, n)} fillOpacity="0.92" stroke="rgba(0,0,0,.45)" strokeWidth="1" rx="2" vectorEffect="non-scaling-stroke" />,
    );
  }

  /* значения mmRender оригинала — декларативно из state (mmView/mmDim/canvasSize) */
  const mmW = mmDim ? mmDim.w : MM_DEF_W;
  const mmH = mmDim ? mmDim.h : MM_DEF_H;
  const mmTransform = 'scale(' + mmView.z + ') translate(' + (-mmView.x) + ',' + (-mmView.y) + ')';
  const mmVb = canvasSize.w > 0 ? mmViewportBoxOf(vp, canvasSize.w, canvasSize.h) : null;

  /* ── #labels: ярлыки групп (gbadge) и «✏ редактирует …» (gbadge lbadge) — updateGroupBadges оригинала ── */
  const labelBadges: { key: string; x: number; y: number; color: string; text: string; lbadge?: boolean }[] = [];
  for (const g of doc.groups) {
    if (!g.badge) continue;
    if ((g.fold === undefined ? 2 : g.fold) !== 2) continue;
    if (hiddenGids.has(g.id)) continue;
    if (!doc.nodes.some((nn) => nn.gid === g.id)) continue;
    const r = groupFrameRect(doc, g, sizesMap, cardSizes);
    labelBadges.push({
      key: 'g:' + g.id,
      x: vp.x + (r.x + r.w / 2) * vp.z,
      y: vp.y + r.y * vp.z - 8,
      color: g.color || '#9aa1ac',
      text: g.name || '',
    });
  }
  const meId = getMe().id;
  for (const oid of Object.keys(store.syncLocks)) {
    const l = store.syncLocks[oid];
    if (!l || !l.id || l.id === meId) continue;
    const nn = doc.nodes.find((x) => x.id === oid);
    if (nn && !collapsedAncestorOf(doc, nn.id)) {
      const w = nodeWidth(nn, sizesMap.get(nn.id));
      labelBadges.push({ key: 'l:' + oid, x: vp.x + (nn.x + w / 2) * vp.z, y: vp.y + nn.y * vp.z - 8, color: l.color || '#8b929c', text: '✏ редактирует ' + (l.name || '…'), lbadge: true });
      continue;
    }
    const g2 = doc.groups.find((x) => x.id === oid);
    if (g2 && !groupInsideCollapsed(doc, g2)) {
      const r = (g2.fold === undefined ? 2 : g2.fold) === 2
        ? groupFrameRect(doc, g2, sizesMap, cardSizes)
        : groupCardRect(doc, g2, cardSizes);
      labelBadges.push({ key: 'l:' + oid, x: vp.x + (r.x + r.w / 2) * vp.z, y: vp.y + r.y * vp.z - 8, color: l.color || '#8b929c', text: '✏ редактирует ' + (l.name || '…'), lbadge: true });
    }
  }

  return (
    <>
    <div
      ref={canvasRef}
      id="canvas"
      className={
        'rn-canvas'
        + (!store.gridOn ? ' nogrid' : '')
        + (dropReady ? ' dropready' : '')
        + (altDown ? ' knife' : '')
        + (store.carry ? ' carry' : '')
        + (store.spaceDown ? ' space' : '')
        + (store.ctrlDown ? ' ctrlpan' : '')
        + (panning ? ' panning' : '')
      }
      style={{
        backgroundSize: GRID * vp.z + 'px ' + GRID * vp.z + 'px',
        backgroundPosition: vp.x + 'px ' + vp.y + 'px',
      }}
      onMouseDown={onCanvasDown}
      onContextMenu={onCtx}
      onDoubleClick={onDbl}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      role="application"
      aria-label="Холст проекта"
    >
      <div
        id="world"
        ref={worldRef}
        style={{
          position: 'absolute',
          left: 0,
          top: 0,
          transformOrigin: '0 0',
          transform: 'translate(' + vp.x + 'px,' + vp.y + 'px) scale(' + vp.z + ')',
        }}
      >
        <div id="framesLayer">
          <GroupLayer
            groups={doc.groups.filter((g) => (g.fold === undefined ? 2 : g.fold) === 2 && !hiddenGids.has(g.id))}
            store={store}
            vp={vp}
            sizes={sizesMap}
            cardSizes={cardSizes}
            sink={sink}
            hiddenGids={new Set<string>()}
            onGroupDown={onGroupDown}
            onGroupResize={onGroupResize}
            onQPortDown={onQPortDown}
            onRowPinDown={onRowPinDown}
          />
        </div>
        <EdgeLayer
          doc={doc}
          items={items}
          selected={store.selEdges}
          pending={pendingLink}
          hoverTarget={hoverTarget}
          showWps={!altDown}
          locks={store.syncLocks}
          onEdgeDown={onEdgeDown}
          onEdgeDbl={onEdgeDbl}
          onWpDown={onWpDown}
          onWpDbl={onWpDbl}
          onLabelDown={onLabelDown}
          onBridgeDown={onBridgeDown}
        />
        {/* линия «ножа» — как path.cutline оригинала: поверх стрелок, под карточками нод */}
        <svg aria-hidden="true" style={{ position: 'absolute', left: 0, top: 0, width: 10, height: 10, overflow: 'visible', pointerEvents: 'none' }}>
          {cutline && <line className="cutline" x1={cutline.x1} y1={cutline.y1} x2={cutline.x2} y2={cutline.y2} style={CUTLINE_STYLE} />}
        </svg>
        {visibleNodes.map((n: VetviNode) => (
          <NodeCard
            key={n.id}
            node={n}
            vp={vp}
            selected={store.sel.has(n.id)}
            store={store}
            sink={sink}
            flash={store.flash}
            lockedBy={store.syncLocks[n.id] || null}
            onDragStart={onNodeDragStart}
            onPinDown={onPinDown}
            onPinReattach={onPinReattach}
            onResizeDown={onResizeDown}
            onDblClick={onNodeDbl}
            onReplyDbl={onReplyDbl}
          />
        ))}
        <GroupLayer
          groups={doc.groups.filter((g) => (g.fold === undefined ? 2 : g.fold) < 2 && !hiddenGids.has(g.id))}
          store={store}
          vp={vp}
          sizes={sizesMap}
          cardSizes={cardSizes}
          sink={sink}
          hiddenGids={new Set<string>()}
          onGroupDown={onGroupDown}
          onGroupResize={onGroupResize}
          onQPortDown={onQPortDown}
          onRowPinDown={onRowPinDown}
        />
      </div>
      <div id="labels" ref={labelsRef}>
        {labelBadges.map((b) => (
          <div
            key={b.key}
            className={'gbadge' + (b.lbadge ? ' lbadge' : '')}
            style={{ left: b.x + 'px', top: b.y + 'px', borderColor: hexToRgba(b.color, b.lbadge ? 0.9 : 0.85), color: b.color }}
          >
            {b.text}
          </div>
        ))}
      </div>
      <div id="emptyHint" className={doc.nodes.length ? undefined : 'show'}>
        <div className="ring" />
        <p>Холст пуст — перетащите элемент с панели слева</p>
      </div>
      <div
        id="marquee"
        className={marquee && marquee.g ? 'mg' : undefined}
        style={{
          left: (marquee ? marquee.x : 0) + 'px',
          top: (marquee ? marquee.y : 0) + 'px',
          width: (marquee ? marquee.w : 0) + 'px',
          height: (marquee ? marquee.h : 0) + 'px',
          display: marquee ? 'block' : 'none',
        }}
      />
      {/* ghost при вытягивании строки из цепочки (#qGhost, 1162 оригинала; текст/позиция — GroupLayer) */}
      <div id="qGhost" className="q-ghost" />
      {/* блок расхождения локальной копии и комнаты — в углу холста (новая система комнат) */}
      <SyncDiffBadge store={store} />
    </div>
    <div id="miniMap" ref={mmRef} onPointerDown={onMmDown} onContextMenu={onMmCtx} style={mmDim ? { width: mmDim.w + 'px', height: mmDim.h + 'px' } : undefined}>
      <svg id="mmSvg" viewBox={'0 0 ' + mmW + ' ' + mmH} preserveAspectRatio="none">
        <g id="mmContent" transform={mmTransform}>
          <g id="mmGroups">{mmGroupRects}</g>
          <g id="mmEdges">{mmEdgeLines}</g>
          <g id="mmNodes">{mmNodeRects}</g>
        </g>
        <rect
          id="mmView"
          x={mmVb ? (mmVb.x1 - mmView.x) * mmView.z : 0}
          y={mmVb ? (mmVb.y1 - mmView.y) * mmView.z : 0}
          width={mmVb ? (mmVb.x2 - mmVb.x1) * mmView.z : 0}
          height={mmVb ? (mmVb.y2 - mmVb.y1) * mmView.z : 0}
        />
      </svg>
      <i className="mm-resize" id="mmResize" title="Потяни за угол, чтобы изменить размер карты" onPointerDown={onMmResizeDown} />
    </div>
    </>
  );
}

const lastMouse = { x: 0, y: 0 };

/* path.cutline оригинала (#edges path.cutline) — линия в отдельном svg, стили инлайном */
const CUTLINE_STYLE: React.CSSProperties = {
  fill: 'none',
  stroke: '#cf6b5a',
  strokeWidth: 2,
  strokeDasharray: '8 6',
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  pointerEvents: 'none',
  filter: 'drop-shadow(0 0 6px rgba(207,107,90,.6))',
  animation: 'dashmove .5s linear infinite',
};

function hexToRgba(hex: string, a: number): string {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex);
  if (!m) return hex;
  const v = parseInt(m[1], 16);
  return 'rgba(' + ((v >> 16) & 255) + ',' + ((v >> 8) & 255) + ',' + (v & 255) + ',' + a + ')';
}

/* группа спрятана внутри свёрнутой (groupInsideCollapsed оригинала) */
function groupInsideCollapsed(doc: VetviDoc, g: VetviGroup): boolean {
  let cur: string | null | undefined = g.parent;
  const seen = new Set<string>();
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const p = doc.groups.find((x) => x.id === cur);
    if (!p) return false;
    if ((p.fold === undefined ? 2 : p.fold) < 2) return true;
    cur = p.parent;
  }
  return false;
}

function isTyping(): boolean {
  const a = document.activeElement as HTMLElement | null;
  if (a && !a.isConnected) return false;
  return !!a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || a.isContentEditable);
}

function distToSeg(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const l2 = dx * dx + dy * dy || 1;
  let t = ((px - ax) * dx + (py - ay) * dy) / l2;
  t = clamp(t, 0, 1);
  return Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
}

function carryCenter(store: VetviStore, ids: string[]): { x: number; y: number } {
  const ns = ids.map((id) => store.nodeById(id)).filter(Boolean) as VetviNode[];
  if (!ns.length) return { x: 0, y: 0 };
  return { x: ns.reduce((s, n) => s + n.x, 0) / ns.length, y: ns.reduce((s, n) => s + n.y, 0) / ns.length };
}

function findGidFromEl(store: VetviStore, el: HTMLElement): string | null {
  /* у рамок/карточек GroupLayer есть data-gid — читаем напрямую */
  const direct = el.getAttribute('data-gid') || (el.closest('[data-gid]') as HTMLElement | null)?.getAttribute('data-gid') || null;
  if (direct && store.groupById(direct)) return direct;
  /* запасной путь: по классам (порядок рендера GroupLayer) */
  const all = document.querySelectorAll('.rn-gframe, .rn-gcard, .groupbox, .gcard, .qcard');
  const idx = Array.from(all).indexOf(el);
  if (idx < 0) return null;
  const gids: string[] = [];
  for (const g of store.doc.groups) {
    const f = g.fold === undefined ? 2 : g.fold;
    if (f !== 2) gids.push(g.id);
  }
  for (const g of store.doc.groups) {
    const f = g.fold === undefined ? 2 : g.fold;
    if (f === 2) gids.push(g.id);
  }
  return gids[idx] || null;
}

export { clampZoom };
