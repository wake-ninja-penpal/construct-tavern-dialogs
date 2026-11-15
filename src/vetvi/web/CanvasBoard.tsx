'use client';

/**
 * Ветви — холст (этап 2): панорама (мышь/Space/Ctrl), зум, сетка,
 * рамка выделения, «нож» (Alt), рисование групп (Ctrl+Shift), перенос нод
 * и групп, создание связей от пинов (включая реплики/исходы/вход переменной),
 * перенос существующих стрелок (Ctrl+пин), изгибы, подписи, мосты,
 * ширина диалога, перенос дубликата за курсором.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { snapVal } from '@/vetvi/core/factory';
import { clamp, clampZoom, screenToWorld } from '@/vetvi/core/geometry';
import { nearestSegPoint } from '@/vetvi/core/edgepath';
import type { NodeSize, VetviNode } from '@/vetvi/core/types';
import type { VetviStore } from './store';
import { canvasApi } from './canvasApi';
import { NodeCard } from './NodeCard';
import { GroupLayer } from './GroupLayer';
import { EdgeLayer, buildEdgeItems } from './EdgeLayer';
import { collapsedAncestorOf, groupCardRect, snapG } from './ggroups';
import { ctxMenus } from './ctxMenus';

type Gest =
  | { mode: 'pan'; sx: number; sy: number; lx: number; ly: number }
  | { mode: 'marquee'; sx: number; sy: number; add: boolean; preN: Set<string>; preG: Set<string> }
  | { mode: 'gcreate'; sx: number; sy: number; cx: number; cy: number }
  | { mode: 'knife'; sx: number; sy: number; lx: number; ly: number }
  | { mode: 'node'; lx: number; ly: number }
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
  const [cutline, setCutline] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null);
  const [pendingLink, setPendingLink] = useState<{ from: string; out: string | null; reply: string | null; x: number; y: number; startX: number; startY: number } | null>(null);
  const [hoverTarget, setHoverTarget] = useState<string | null>(null);
  const [altDown, setAltDown] = useState(false);

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
        store.setViewport({
          x: r.width / 2 - (n.x + w) * store.vp.z,
          y: r.height / 2 - (n.y + h) * store.vp.z,
        });
      },
    };
    return () => { canvasApi.current = null; };
  }, [store, sizesMap]);

  /* ── центрирование по запросу ── */
  useEffect(() => {
    if (store.centerReq && canvasApi.current) canvasApi.current.centerOn(store.centerReq.id);
     
  }, [store.centerReq?.t]);

  const items = useMemo(
    () => buildEdgeItems(doc, doc.edges, sizesMap, portsMap, cardSizes, store.bend),
     
    [doc, doc.edges, sizesMap, portsMap, cardSizes, store.bend, store.revision, tick],
  );

  /* ── скрытые ноды (внутри свёрнутых групп) ── */
  const hiddenGids = (() => {
    const set = new Set<string>();
    for (const g of doc.groups) {
      if ((g.fold === undefined ? 2 : g.fold) < 2) {
        // сам g и его предки — скрыты из рендера как рамки
        set.add(g.id);
        let p: string | null | undefined = g.parent;
        const seen = new Set<string>();
        while (p && !seen.has(p)) { seen.add(p); set.add(p); p = store.groupById(p)?.parent || null; }
      }
    }
    return set;
     
    })();

  const visibleNodes = doc.nodes.filter((n) => !collapsedAncestorOf(doc, n.id));

  /* ── колесо: зум к курсору / Shift — пан ── */
  const onWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    if (e.shiftKey) {
      store.panBy(-e.deltaY, 0);
      return;
    }
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    store.zoomAt(x, y, Math.pow(1.0015, -e.deltaY));
  }, [store]);

  /* ── клики по пустому месту ── */
  const onCanvasDown = useCallback((e: React.MouseEvent) => {
    const t = e.target as HTMLElement;
    if (t.closest('[data-node-id]') || t.closest('[data-pin]') || t.closest('.rn-gframe') || t.closest('.rn-gcard')) return;
    store.closeCtx();
    if (e.button === 1 || store.spaceDown || (store.ctrlDown && !e.shiftKey) || e.button === 2) {
      gestRef.current = { mode: 'pan', sx: e.clientX, sy: e.clientY, lx: e.clientX, ly: e.clientY };
      e.preventDefault();
      return;
    }
    if (e.button !== 0) return;
    if (altDown) {
      gestRef.current = { mode: 'knife', sx: e.clientX, sy: e.clientY, lx: e.clientX, ly: e.clientY };
      setCutline({ x1: e.clientX, y1: e.clientY, x2: e.clientX, y2: e.clientY });
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
    setMarquee({ x: e.clientX, y: e.clientY, w: 0, h: 0 });
    e.preventDefault();
  }, [store, altDown]);

  /* ── ноды ── */
  const onNodeDragStart = useCallback((e: React.MouseEvent, id: string) => {
    if (store.carry) return;
    gestRef.current = { mode: 'node', lx: e.clientX, ly: e.clientY };
    store.dragBegin();
    e.preventDefault();
  }, [store]);

  /* ── группы ── */
  const onGroupDown = useCallback((e: React.MouseEvent, gid: string) => {
    if (e.button !== 0) return;
    const t = e.target as HTMLElement;
    if (t.closest('[data-nodrag]')) return;
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
    e.preventDefault();
    e.stopPropagation();
  }, [store]);

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
    e.preventDefault();
  }, [store]);

  const onPinReattach = useCallback((e: React.MouseEvent, id: string) => {
    gestRef.current = { mode: 'reattachOut', from: id, lx: e.clientX, ly: e.clientY, target: null };
    e.preventDefault();
  }, []);

  const onResizeDown = useCallback((e: React.MouseEvent, id: string) => {
    const n = store.nodeById(id);
    if (!n) return;
    gestRef.current = { mode: 'dlgW', id, startX: e.clientX, startW: n.dlgWidth || 216 };
    e.preventDefault();
  }, [store]);

  const onNodeDbl = useCallback((id: string) => {
    store.startRename(id);
  }, [store]);

  const onReplyDbl = useCallback((nodeId: string, rid: string) => {
    store.openDialogEditor(nodeId);
    // прокрутка к реплике — редактор сам по flash
    store.requestFlash(nodeId, rid);
  }, [store]);

  /* ── связи: клики/вейпоинты/подписи/мосты ── */
  const onEdgeDown = useCallback((e: React.MouseEvent, id: string) => {
    if (e.shiftKey) store.toggleEdge(id);
    else store.selectEdgeOnly(id);
    e.preventDefault();
  }, [store]);

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
    gestRef.current = { mode: 'wp', eid: id, idx: i };
    e.preventDefault();
  }, []);

  const onWpDbl = (e: React.MouseEvent, id: string, i: number) => {
    store.deleteWaypoint(id, i);
  };

  const onLabelDown = (e: React.MouseEvent, id: string) => {
    gestRef.current = { mode: 'label', eid: id };
    e.preventDefault();
  };

  const onBridgeDown = useCallback((e: React.MouseEvent, id: string, part: 'l' | 'r' | 'h') => {
    const ed = store.edgeById(id);
    if (!ed) return;
    const bd = ed.bd || { dl: 0, dy: 0, dr: 0 };
    gestRef.current = { mode: 'bridge', eid: id, part, lx: e.clientX, ly: e.clientY, dl: bd.dl, dy: bd.dy, dr: bd.dr };
    store.dragBegin();
    e.preventDefault();
  }, [store]);

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

  /* ── глобальные обработчики жеста ── */
  useEffect(() => {
    const move = (e: MouseEvent) => {
      const g = gestRef.current;
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
          const x = Math.min(g.sx, e.clientX);
          const y = Math.min(g.sy, e.clientY);
          const w = Math.abs(e.clientX - g.sx);
          const h = Math.abs(e.clientY - g.sy);
          setMarquee({ x, y, w, h });
          // пересечение с нодами в экранных координатах
          const rect = canvasRef.current?.getBoundingClientRect();
          if (rect) {
            const wa = screenToWorld(store.vp, x - rect.left, y - rect.top);
            const wb = screenToWorld(store.vp, x + w - rect.left, y + h - rect.top);
            const ids: string[] = [];
            const gids: string[] = [];
            for (const n of doc.nodes) {
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
          const x = Math.min(g.cx, e.clientX);
          const y = Math.min(g.cy, e.clientY);
          setMarquee({ x, y, w: Math.abs(e.clientX - g.cx), h: Math.abs(e.clientY - g.cy), g: true });
          break;
        }
        case 'knife': {
          g.lx = e.clientX;
          g.ly = e.clientY;
          setCutline({ x1: g.sx, y1: g.sy, x2: e.clientX, y2: e.clientY });
          break;
        }
        case 'node': {
          const z = store.vp.z || 1;
          store.dragMoveBy((e.clientX - g.lx) / z, (e.clientY - g.ly) / z);
          g.lx = e.clientX;
          g.ly = e.clientY;
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
              if (sg) { sg.x += dx; sg.y += dy; }
            } else {
              const n = store.nodeById(id);
              if (n) { n.x += dx; n.y += dy; }
            }
          }
          store.emit();
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
          const varin = !!(el && el.closest('[data-pin="varin"]'));
          const target = node ? node.getAttribute('data-node-id') : null;
          g.target = target && target !== g.from ? target : null;
          g.varin = varin && !!g.target;
          setHoverTarget(g.target);
          break;
        }
        case 'reattachOut': {
          g.lx = e.clientX;
          g.ly = e.clientY;
          const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
          const node = el ? el.closest('[data-node-id]') : null;
          g.target = node ? node.getAttribute('data-node-id') : null;
          setHoverTarget(g.target);
          break;
        }
        case 'reattachIn': {
          g.lx = e.clientX;
          g.ly = e.clientY;
          const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
          const node = el ? el.closest('[data-node-id]') : null;
          g.target = node ? node.getAttribute('data-node-id') : null;
          setHoverTarget(g.target);
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
    const up = () => {
      const g = gestRef.current;
      gestRef.current = null;
      if (!g) return;
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
            const path = el ? el.closest('svg.rn-edges path.rn-edge-hit') : null;
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
            store.emit();
          }
          store.dragEnd();
          store.reparentAfterMove();
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
            for (const ed of edges) ed.from = g.target as string;
            store.commitEdit(pre, 'Перенос исходящих связей');
          }
          setHoverTarget(null);
          break;
        }
        case 'reattachIn': {
          if (g.target && g.target !== g.to) {
            const pre = store.beginEdit();
            const edges = store.doc.edges.filter((ed) => ed.to === g.to);
            for (const ed of edges) { ed.to = g.target as string; ed.fromReply = null; }
            store.commitEdit(pre, 'Перенос входящих связей');
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
    };
  }, [store, doc, items, sizesMap, cardSizes]);


  /* Alt → нож */
  useEffect(() => {
    const kd = (e: KeyboardEvent) => {
      if (e.key === 'Alt' && !isTyping()) { setAltDown(true); store.knifeOn = true; store.emit(); }
      if (e.key === 'Control' || e.key === 'Meta') { store.ctrlDown = true; store.emit(); }
      if (e.code === 'Space' && !isTyping()) { store.spaceDown = true; store.emit(); e.preventDefault(); }
    };
    const ku = (e: KeyboardEvent) => {
      if (e.key === 'Alt') { setAltDown(false); store.knifeOn = false; store.emit(); }
      if (e.key === 'Control' || e.key === 'Meta') { store.ctrlDown = false; store.emit(); }
      if (e.code === 'Space') { store.spaceDown = false; store.emit(); }
    };
    const kb = () => { setAltDown(false); store.knifeOn = false; store.spaceDown = false; store.ctrlDown = false; store.emit(); };
    window.addEventListener('keydown', kd);
    window.addEventListener('keyup', ku);
    window.addEventListener('blur', kb);
    return () => {
      window.removeEventListener('keydown', kd);
      window.removeEventListener('keyup', ku);
      window.removeEventListener('blur', kb);
    };
     
  }, []);

  /* отслеживание ноды под курсором (для старта плеера по P) */
  const lastPtr = useRef({ x: 0, y: 0 });
  useEffect(() => {
    const mm = (e: MouseEvent) => {
      lastPtr.current = { x: e.clientX, y: e.clientY };
      lastMouse.x = e.clientX;
      lastMouse.y = e.clientY;
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
    const egEl = t.closest('g.rn-eg') as SVGGElement | null;
    if (egEl) {
      const eid = egEl.getAttribute('data-edge-id');
      if (eid && store.edgeById(eid)) {
        store.selectEdgeOnly(eid);
        store.openCtx(e.clientX, e.clientY, menus.edge(eid));
        return;
      }
    }
    const gEl = t.closest('.rn-gframe, .rn-gcard') as HTMLElement | null;
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
    if (t.closest('[data-node-id]') || t.closest('svg.rn-edges') || t.closest('.rn-gframe') || t.closest('.rn-gcard')) return;
    const menus = ctxMenus(store);
    store.openCtx(e.clientX, e.clientY, menus.canvas(e.clientX, e.clientY, true));
  }, [store]);

  const fitNow = () => {
    const el = canvasRef.current;
    if (!el) return;
    store.fitView(el.clientWidth, el.clientHeight, sizesMap);
  };

  const zoomStep = (f: number) => {
    const el = canvasRef.current;
    if (!el) return;
    store.zoomAt(el.clientWidth / 2, el.clientHeight / 2, f);
  };

  void tick;

  const playerOpen = store.modal === 'player';

  return (
    <div
      ref={canvasRef}
      className={'rn-canvas' + (store.gridOn ? ' grid' : '') + (altDown ? ' knife' : '') + (store.spaceDown ? ' panning' : '') + (store.carry ? ' carry' : '') + (playerOpen ? ' dimmed' : '')}
      style={{
        backgroundImage: store.gridOn ? 'radial-gradient(circle, #262b33 1px, transparent 1px)' : undefined,
        backgroundSize: 26 * vp.z + 'px ' + 26 * vp.z + 'px',
        backgroundPosition: vp.x + 'px ' + vp.y + 'px',
      }}
      onWheel={onWheel}
      onMouseDown={onCanvasDown}
      onContextMenu={onCtx}
      onDoubleClick={onDbl}
      role="application"
      aria-label="Холст проекта"
    >
      <div className="rn-world" style={{ transform: 'translate(' + vp.x + 'px,' + vp.y + 'px) scale(' + vp.z + ')' }}>
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
        />
        <EdgeLayer
          doc={doc}
          items={items}
          selected={store.selEdges}
          pending={pendingLink}
          hoverTarget={hoverTarget}
          showWps={!altDown}
          onEdgeDown={onEdgeDown}
          onEdgeDbl={onEdgeDbl}
          onWpDown={onWpDown}
          onWpDbl={onWpDbl}
          onLabelDown={onLabelDown}
          onBridgeDown={onBridgeDown}
        />
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
        />
      </div>
      {marquee && (
        <div className={'rn-marquee' + (marquee.g ? ' mg' : '')} style={{ left: marquee.x, top: marquee.y, width: marquee.w, height: marquee.h }} />
      )}
      {cutline && (
        <svg className="rn-cutline-svg">
          <line className="rn-cutline" x1={cutline.x1} y1={cutline.y1} x2={cutline.x2} y2={cutline.y2} />
        </svg>
      )}
      <div className="rn-ctrls" role="toolbar" aria-label="Масштаб и сетка">
        <button type="button" title="Отдалить" onClick={() => zoomStep(1 / 1.2)}>−</button>
        <span className="rn-zoom">{Math.round(vp.z * 100)}%</span>
        <button type="button" title="Приблизить" onClick={() => zoomStep(1.2)}>+</button>
        <button type="button" title="Вписать всё" onClick={fitNow}>⤢</button>
        <button type="button" title="Сетка" className={store.gridOn ? 'on' : ''} onClick={() => store.toggleGrid()}>#</button>
        <button type="button" title="Привязка к сетке" className={store.snapOn ? 'on' : ''} onClick={() => store.toggleSnap()}>⌗</button>
        <button type="button" title="Связи: плавные" className={store.bend === 'smooth' ? 'on' : ''} onClick={() => store.setBend('smooth')}>⌒</button>
        <button type="button" title="Связи: прямые 90°" className={store.bend === 'ortho90' ? 'on' : ''} onClick={() => store.setBend('ortho90')}>┐</button>
        <button type="button" title="Связи: 45°" className={store.bend === 'ortho45' ? 'on' : ''} onClick={() => store.setBend('ortho45')}>◇</button>
      </div>
    </div>
  );
}

const lastMouse = { x: 0, y: 0 };

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
  // ищем по классам: у карточек нет data-атрибутов — сравниваем порядок
  const all = document.querySelectorAll('.rn-gframe, .rn-gcard');
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
