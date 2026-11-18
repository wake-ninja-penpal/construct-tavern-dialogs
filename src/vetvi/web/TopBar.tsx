'use client';

/**
 * Ветви — тулбар: 1:1 порт шапки оригинала (header#topbar, index.html 1082–1125).
 * Оригинальные классы/ids/иконки (.brand, .vsep, .btn, .ibtn, .save-wrap,
 * .save-menu, .sm-i, .collab-chip, .cc-dot, .m-badge, .spacer) + логика React.
 *
 * Компоновка шапки: слева фиксированные кнопки, посередине — блок кнопок холста
 * (undo/redo/zoom/сетка/привязка/изгибы/мини-карта), справа — ПРИЖАТЫЙ к краю
 * блок (поиск, уведомления, аккаунт): он никогда не двигается и не уезжает за экран.
 * Шапка целиком не скроллится: скролл есть только у блока кнопок холста, причём
 * если кнопки скрыты скроллом — на краю панели появляется стрелка «там есть ещё».
 *
 * Блок кнопок холста — отсоединяемый: тянем за «грип» — блок отстёгивается от
 * шапки и ТЯНЕТСЯ ЗА КУРСОРОМ: панель следует за курсором в любую точку холста;
 * рядом с местами крепления (края холста и шапка) панель МАГНИТИТСЯ к ним,
 * а когда её оттягивают прочь — снова следует за курсором. У края панель
 * ориентируется по нему (сверху/снизу — горизонтально, слева/справа — ВЕРТИКАЛЬНО),
 * сама выравнивается (ничего не вылезает за экран), не налезает на боковые панели
 * (двигается вместе с их открытием/закрытием) и сдвигает мини-карту/плашки в углах
 * холста. Отпускание над шапкой возвращает блок на место. Положение — localStorage.
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import { hkText } from '@/vetvi/core/hotkeys';
import { getMe } from '@/vetvi/core/identity';
import type { VetviStore } from './store';
import { canvasApi } from './canvasApi';
import { avatarInitial } from './auth';
import { AccountPopover, NotificationsPopover, useNotifications } from './AccountMenu';

/* ── отсоединяемый блок кнопок холста ── */

const TOOLBLOCK_LS = 'vetvi-toolblock-v3';
const GAP = 12; // отступ плавающей панели от краёв экрана/панелей
const TOPBAR_H_FALLBACK = 56;
const MAGNET = 56; // радиус магнита: ближе этого расстояния до места крепления панель «прилипает»

type ToolEdge = 'top' | 'bottom' | 'left' | 'right';

/* edge+along — панель у края холста; free — панель в произвольной точке холста
   (тянется за курсором, магнитится к краям и шапке) */
interface ToolDock {
  float: boolean; edge: ToolEdge; along: number;
  free?: boolean; x?: number; y?: number;
}

function loadToolDock(): ToolDock {
  const def: ToolDock = { float: false, edge: 'top', along: GAP };
  try {
    /* миграция v1 ({float,x,y}) и v2 (edge+along) → v3 (edge+along | free+x+y) */
    const old = localStorage.getItem('vetvi-toolblock-v1');
    if (old) localStorage.removeItem('vetvi-toolblock-v1');
    const old2 = localStorage.getItem('vetvi-toolblock-v2');
    if (old2) localStorage.removeItem('vetvi-toolblock-v2');
    const raw = localStorage.getItem(TOOLBLOCK_LS) || old2 || (old && (() => {
      try {
        const o = JSON.parse(old) as { float?: boolean; x?: number; y?: number };
        if (!o || !o.float) return null;
        const cx = Number(o.x) || 0; const cy = Number(o.y) || 0;
        const dTop = Math.abs(cy - 68); const dBottom = Math.abs(window.innerHeight - cy);
        const dLeft = Math.abs(cx); const dRight = Math.abs(window.innerWidth - cx);
        const edge = dTop < dBottom && dTop < dLeft && dTop < dRight ? 'top'
          : dBottom < dLeft && dBottom < dRight ? 'bottom' : dLeft < dRight ? 'left' : 'right';
        return JSON.stringify({ float: true, edge, along: edge === 'top' || edge === 'bottom' ? cx : cy });
      } catch { return null; }
    })());
    if (!raw) return def;
    const d = JSON.parse(raw as string) as Partial<ToolDock>;
    if (!d || typeof d !== 'object') return def;
    const edge: ToolEdge = d.edge === 'bottom' || d.edge === 'left' || d.edge === 'right' ? d.edge : 'top';
    /* свободная позиция (v3): панель в произвольной точке холста */
    if (d.float && d.free && Number.isFinite(Number(d.x)) && Number.isFinite(Number(d.y))) {
      return { float: true, edge, along: Number(d.along) || def.along, free: true, x: Number(d.x), y: Number(d.y) };
    }
    return { float: !!d.float, edge, along: Number(d.along) || def.along };
  } catch { return def; }
}

function saveToolDock(d: ToolDock): void {
  try { localStorage.setItem(TOOLBLOCK_LS, JSON.stringify(d)); } catch { /* нет доступа */ }
}

function GripIcon({ vert }: { vert?: boolean }) {
  return (
    <svg viewBox="0 0 8 16" width="8" height="16" aria-hidden="true" fill="currentColor" style={vert ? { transform: 'rotate(90deg)' } : undefined}>
      <circle cx="2.2" cy="3" r="1.3" /><circle cx="5.8" cy="3" r="1.3" />
      <circle cx="2.2" cy="8" r="1.3" /><circle cx="5.8" cy="8" r="1.3" />
      <circle cx="2.2" cy="13" r="1.3" /><circle cx="5.8" cy="13" r="1.3" />
    </svg>
  );
}

function ArrowIcon({ dir }: { dir: 'l' | 'r' }) {
  return (
    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {dir === 'l' ? <path d="m14 6-6 6 6 6" /> : <path d="m10 6 6 6-6 6" />}
    </svg>
  );
}

interface Rect { left: number; top: number; right: number; bottom: number; width: number; height: number }

function rectOf(el: HTMLElement): Rect {
  const r = el.getBoundingClientRect();
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
}

function overlap(a: Rect, b: Rect): boolean {
  return a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1;
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

/* ── сдвиг угловых элементов холста (мини-карта, «только чтение», плашка
   расхождения) CSS-переменными; текущие значения хранятся здесь, чтобы мерить
   базовые позиции без уже применённого трансформа ── */
const shiftVars = { mmX: 0, mmY: 0, voY: 0, sdY: 0 };

function applyShiftVars(): void {
  const s = document.documentElement.style;
  s.setProperty('--flt-mm-x', shiftVars.mmX + 'px');
  s.setProperty('--flt-mm-y', shiftVars.mmY + 'px');
  s.setProperty('--flt-vo-y', shiftVars.voY + 'px');
  s.setProperty('--flt-sd-y', shiftVars.sdY + 'px');
}

function resetShiftVars(): void {
  shiftVars.mmX = 0; shiftVars.mmY = 0; shiftVars.voY = 0; shiftVars.sdY = 0;
  applyShiftVars();
}

/* зарезервированные полосы экрана: шапка сверху, статусбар снизу, левая панель,
   инспектор справа. Заодно публикует их в CSS-переменные — по ним CSS ставит
   плавающую панель перпендикулярно её краю (панель двигается вместе с
   открытием/закрытием боковых панелей и не налезает на них). */
function reservedStrips(): { top: number; bottom: number; left: number; right: number } {
  const top = document.getElementById('topbar')?.offsetHeight || TOPBAR_H_FALLBACK;
  const status = document.getElementById('status');
  const bottom = status ? status.offsetHeight : 0;
  const leftEl = document.getElementById('left');
  const left = leftEl ? leftEl.offsetWidth : 0;
  const rightEl = document.getElementById('right');
  const right = rightEl ? rightEl.offsetWidth : 0;
  const s = document.documentElement.style;
  s.setProperty('--flt-strip-top', top + 'px');
  s.setProperty('--flt-strip-bottom', bottom + 'px');
  s.setProperty('--flt-strip-left', left + 'px');
  s.setProperty('--flt-strip-right', right + 'px');
  return { top, bottom, left, right };
}

export function TopBar(props: { store: VetviStore }) {
  const { store } = props;
  const [saveOpen, setSaveOpen] = useState(false);
  const [savePos, setSavePos] = useState<{ left: number; top: number } | null>(null);
  const saveRef = useRef<HTMLDivElement>(null);
  const me = getMe();
  const ntf = useNotifications(store);
  void store.revision;

  /* ── отсоединяемый блок инструментов ── */
  const [toolDock, setToolDock] = useState<ToolDock>(loadToolDock);
  const [toolDragging, setToolDragging] = useState(false);
  /* перетаскивание: панель тянется за курсором (точка хвата сохраняется — grabAlong
     вдоль оси, grabCross поперёк), а рядом с местами крепления (края холста, шапка)
     магнитится к ним. Размеры перемеряются вживую: шапка даёт блок «растянутым»,
     плавающая панель — по содержимому, ориентация меняет оси. */
  const dragRef = useRef<{
    moved: boolean;
    grabFrac: number; grabAlong: number; grabCross: number;
    horiz: boolean; len: number; cross: number;
    pos: { x: number; y: number };
    snap: ToolEdge | 'header' | null; // активный магнит в этот кадр
  } | null>(null);
  const floatRef = useRef<HTMLDivElement>(null);
  const toolDockRef = useRef(toolDock);
  const toolDraggingRef = useRef(false);
  /* подсветка магнита: у какого края панель «прилипла» во время перетаскивания */
  const [toolMagnet, setToolMagnet] = useState<ToolEdge | null>(null);
  /* refs синхронизируются в useLayoutEffect (не useEffect): fitDock и подгонка
     при перетаскивании читают их ДО отрисовки кадра — иначе на смене ориентации
     fitDock видит старый edge и возвращает панель по старой оси */
  useLayoutEffect(() => { toolDockRef.current = toolDock; }, [toolDock]);
  useLayoutEffect(() => { toolDraggingRef.current = toolDragging; }, [toolDragging]);

  /* ── стрелки скролла блоков шапки (блок меню и блок кнопок холста):
     если кнопки скрыты скроллом — на краю блока появляется стрелка «там есть ещё» ── */
  const scrollRef = useRef<HTMLDivElement>(null);
  const menuScrollRef = useRef<HTMLDivElement>(null);
  const [arrows, setArrows] = useState({ l: false, r: false });
  const [menuArrows, setMenuArrows] = useState({ l: false, r: false });

  const measureArrows = () => {
    const el = scrollRef.current;
    if (el) {
      const has = el.scrollWidth > el.clientWidth + 2;
      const l = has && el.scrollLeft > 2;
      const r = has && el.scrollLeft + el.clientWidth < el.scrollWidth - 2;
      setArrows((p) => (p.l === l && p.r === r ? p : { l, r }));
    }
    const mf = menuScrollRef.current;
    if (mf) {
      const has = mf.scrollWidth > mf.clientWidth + 2;
      const l = has && mf.scrollLeft > 2;
      const r = has && mf.scrollLeft + mf.clientWidth < mf.scrollWidth - 2;
      setMenuArrows((p) => (p.l === l && p.r === r ? p : { l, r }));
    }
  };

  useEffect(() => {
    const t0 = setTimeout(measureArrows, 0); // первичный замер — вне тела эффекта
    const ro = new ResizeObserver(() => measureArrows());
    const el = scrollRef.current;
    const mf = menuScrollRef.current;
    if (el) ro.observe(el);
    if (mf) ro.observe(mf);
    const t = setInterval(measureArrows, 1200); // шрифты/контент могли догрузиться
    return () => { clearTimeout(t0); ro.disconnect(); clearInterval(t); };
  }, [toolDock.float, toolDock.edge, saveOpen]);

  const scrollTool = (dir: 1 | -1, which: 'tools' | 'menu' = 'tools') => {
    const el = which === 'tools' ? scrollRef.current : menuScrollRef.current;
    if (!el) return;
    el.scrollBy({ left: dir * Math.max(160, el.clientWidth * 0.6), behavior: 'smooth' });
  };

  /* позиция панели по краю (для проверки пересечений с угловыми элементами) */
  const dockRect = (edge: ToolEdge, along: number, w: number, h: number): Rect => {
    const st = reservedStrips();
    const iw = window.innerWidth;
    const ih = window.innerHeight;
    if (edge === 'top') return { left: along, top: st.top + GAP, right: along + w, bottom: st.top + GAP + h, width: w, height: h };
    if (edge === 'bottom') return { left: along, top: ih - st.bottom - GAP - h, right: along + w, bottom: ih - st.bottom - GAP, width: w, height: h };
    if (edge === 'left') return { left: st.left + GAP, top: along, right: st.left + GAP + w, bottom: along + h, width: w, height: h };
    return { left: iw - st.right - GAP - w, top: along, right: iw - st.right - GAP, bottom: along + h, width: w, height: h };
  };

  /* сдвиг угловых элементов (мини-карта, «только чтение», плашка расхождения),
     чтобы плавающая панель не налезала на них: карта уезжает вниз/влево,
     плашки — вверх, освобождая полосу панели */
  const pushOverlays = (edge: ToolEdge | 'free', rect: Rect) => {
    const mmEl = document.getElementById('miniMap');
    if (mmEl && store.mmOn) {
      const base = rectOf(mmEl);
      const mm: Rect = { ...base, left: base.left - shiftVars.mmX, top: base.top - shiftVars.mmY, right: base.right - shiftVars.mmX, bottom: base.bottom - shiftVars.mmY };
      if (overlap(rect, mm)) {
        if (edge === 'top') shiftVars.mmY = rect.bottom - mm.top + 10;
        else if (edge === 'right') shiftVars.mmX = -(mm.right - rect.left) - 10;
        else if (edge === 'free') {
          /* свободная позиция: освобождаем сторону с меньшим перекрытием */
          const pushDown = rect.bottom - mm.top;
          const pushLeft = mm.right - rect.left;
          if (pushDown <= pushLeft) shiftVars.mmY = pushDown + 10;
          else shiftVars.mmX = -(pushLeft + 10);
        }
        else { shiftVars.mmX = 0; shiftVars.mmY = 0; }
      } else { shiftVars.mmX = 0; shiftVars.mmY = 0; }
    }
    const voEl = document.querySelector('.vo-corner') as HTMLElement | null;
    if (voEl) {
      const base = rectOf(voEl);
      const vo: Rect = { ...base, top: base.top - shiftVars.voY, bottom: base.bottom - shiftVars.voY };
      if (overlap(rect, vo)) shiftVars.voY = -(vo.bottom - rect.top) - 10;
      else shiftVars.voY = 0;
    }
    const sdEl = document.getElementById('syncDiffBadge');
    if (sdEl) {
      const base = rectOf(sdEl);
      const sd: Rect = { ...base, top: base.top - shiftVars.sdY, bottom: base.bottom - shiftVars.sdY };
      if (overlap(rect, sd)) shiftVars.sdY = -(sd.bottom - rect.top) - 10;
      else shiftVars.sdY = 0;
    }
    applyShiftVars();
  };

  /* авто-выравнивание плавающей панели: ничего не вылезает за экран, панель не
     налезает на боковые панели/статусбар и угловые элементы. Подгонка НЕ
     перезаписывает желанную позицию (d.along): пока боковая панель открыта,
     блок визуально отодвигается (клэмп), а после её закрытия возвращается
     ровно туда, где его оставили. Вызывается перед отрисовкой, при ресайзе
     окна и при изменении размеров панелей (RO). */
  const fitDock = () => {
    if (!toolDockRef.current.float || toolDraggingRef.current) return;
    const st = reservedStrips();
    const el = floatRef.current;
    if (!el) return;
    const d = toolDockRef.current;
    const r = rectOf(el);
    /* свободная позиция: клэмп внутрь холста (шапка/статусбар/боковые панели учтены) */
    if (d.free) {
      const x = clamp(Number(d.x) || GAP, st.left + GAP, Math.max(st.left + GAP, window.innerWidth - st.right - GAP - r.width));
      const y = clamp(Number(d.y) || GAP, st.top + GAP, Math.max(st.top + GAP, window.innerHeight - st.bottom - GAP - r.height));
      el.style.left = x + 'px';
      el.style.top = y + 'px';
      el.style.right = '';
      el.style.bottom = '';
      pushOverlays('free', { left: x, top: y, right: x + r.width, bottom: y + r.height, width: r.width, height: r.height });
      return;
    }
    const vert = d.edge === 'left' || d.edge === 'right';
    const len = vert ? r.height : r.width;
    const min = (vert ? st.top : st.left) + GAP;
    const max = vert
      ? window.innerHeight - st.bottom - GAP - len
      : window.innerWidth - st.right - GAP - len;
    const along = clamp(d.along, min, Math.max(min, max));
    /* позицию панель принимает ДО отрисовки кадра (правим DOM напрямую) —
       панель никогда не стоит за пределами экрана и не мигает; чужая ось
       очищается, чтобы не осталось позиции от прошлой ориентации */
    if (vert) { el.style.top = along + 'px'; el.style.left = ''; el.style.right = ''; el.style.bottom = ''; }
    else { el.style.left = along + 'px'; el.style.top = ''; el.style.right = ''; el.style.bottom = ''; }
    pushOverlays(d.edge, dockRect(d.edge, along, vert ? r.width : len, vert ? len : r.height));
  };

  useLayoutEffect(() => {
    fitDock();
  });

  /* панель двигается вместе с открытием/закрытием боковых панелей и ресайзом окна:
     полосы (CSS-переменные перпендикуляра) обновляются, позиция переподгоняется,
     угловые элементы (мини-карта и т.п.) уступают место заново */
  useEffect(() => {
    if (!toolDock.float) return;
    const onLayout = () => fitDock();
    const ro = new ResizeObserver(onLayout);
    const leftEl = document.getElementById('left');
    const rightEl = document.getElementById('right');
    if (leftEl) ro.observe(leftEl);
    if (rightEl) ro.observe(rightEl);
    if (floatRef.current) ro.observe(floatRef.current);
    window.addEventListener('resize', onLayout);
    return () => { ro.disconnect(); window.removeEventListener('resize', onLayout); };
  }, [toolDock.float]);

  /* возврат блока в шапку (или размонтирование): сдвиги угловых элементов больше не нужны */
  useEffect(() => {
    if (!toolDock.float) resetShiftVars();
  }, [toolDock.float]);
  useEffect(() => () => resetShiftVars(), []);

  /* перетаскивание: панель меняет размер при отрыве от шапки (там блок
     «растянут») и при смене ориентации — перемеряем её и пересчитываем точку
     хвата, чтобы блок не прыгал и не дёргался в руке */
  useLayoutEffect(() => {
    if (!toolDragging) return;
    const d = dragRef.current;
    const el = floatRef.current;
    if (!d || !el) return;
    const r = rectOf(el);
    const horiz = d.horiz;
    const len = horiz ? r.width : r.height;
    const cross = horiz ? r.height : r.width;
    if (Math.abs(len - d.len) < 1 && Math.abs(cross - d.cross) < 1) return;
    d.len = len;
    d.cross = cross;
    d.grabAlong = d.grabFrac * len;
    /* свободный режим: точка хвата остаётся под курсором при смене размера */
    if (toolDockRef.current.free && Number.isFinite(d.pos.x)) {
      const st = reservedStrips();
      const x = clamp(d.pos.x - d.grabAlong, st.left + GAP, Math.max(st.left + GAP, window.innerWidth - st.right - GAP - r.width));
      const y = clamp(d.pos.y - d.grabCross, st.top + GAP, Math.max(st.top + GAP, window.innerHeight - st.bottom - GAP - r.height));
      el.style.left = x + 'px';
      el.style.top = y + 'px';
      el.style.right = '';
      el.style.bottom = '';
      pushOverlays('free', { left: x, top: y, right: x + r.width, bottom: y + r.height, width: r.width, height: r.height });
      return;
    }
    const st = reservedStrips();
    const min = horiz ? st.left + GAP : st.top + GAP;
    const max = horiz
      ? Math.max(min, window.innerWidth - st.right - GAP - len)
      : Math.max(min, window.innerHeight - st.bottom - GAP - len);
    const along = clamp((horiz ? d.pos.x : d.pos.y) - d.grabAlong, min, max);
    /* правим позицию до отрисовки кадра — без прыжка; чужая ось очищается */
    if (horiz) { el.style.left = along + 'px'; el.style.top = ''; el.style.right = ''; el.style.bottom = ''; }
    else { el.style.top = along + 'px'; el.style.left = ''; el.style.right = ''; el.style.bottom = ''; }
    pushOverlays(toolDock.edge, dockRect(toolDock.edge, along, horiz ? len : cross, horiz ? cross : len));
  }, [toolDock.float, toolDock.edge, toolDock.free, toolDragging]);

  const onGripMove = (e: PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    if (!d.moved) {
      d.moved = true;
      setToolDragging(true);
    }
    d.pos = { x: e.clientX, y: e.clientY };
    const st = reservedStrips();
    const ih = window.innerHeight;
    const iw = window.innerWidth;
    const cTop = st.top + GAP;
    const cBottom = ih - st.bottom - GAP;
    const cLeft = st.left + GAP;
    const cRight = iw - st.right - GAP;
    const topbarH = document.getElementById('topbar')?.offsetHeight || TOPBAR_H_FALLBACK;

    /* ── магнит: места крепления — шапка и четыре края холста ──
       в радиусе MAGNET от линии крепления панель «прилипает» к ней,
       дальше от всех мест крепления — свободно следует за курсором */
    const dHeader = e.clientY - topbarH; /* ≤0 — курсор над шапкой */
    const edges: Array<{ e: ToolEdge; v: number }> = [
      { e: 'top', v: Math.abs(e.clientY - cTop) },
      { e: 'bottom', v: Math.abs(e.clientY - cBottom) },
      { e: 'left', v: Math.abs(e.clientX - cLeft) },
      { e: 'right', v: Math.abs(e.clientX - cRight) },
    ];
    edges.sort((a, b) => a.v - b.v);
    const nearEdge = edges[0];
    const headerHit = dHeader <= 0 || (dHeader < MAGNET && dHeader < nearEdge.v);
    const edgeHit = !headerHit && nearEdge.v <= MAGNET;

    /* магнит шапки: блок возвращается на своё место прямо во время drag'а,
       оттягиваем прочь — снова тянется за курсором */
    if (headerHit) {
      d.snap = 'header';
      setToolMagnet(null);
      setToolDock((v) => (v.float ? { float: false, edge: 'top', along: 0 } : v));
      return;
    }

    /* магнит края: панель встаёт на край (сверху/снизу — горизонтально,
       слева/справа — вертикально), точка хвата переносится пропорционально */
    if (edgeHit) {
      const dist = nearEdge.e;
      d.snap = dist;
      setToolMagnet(dist);
      const horiz = dist === 'top' || dist === 'bottom';
      if (horiz !== d.horiz) {
        d.horiz = horiz;
        d.grabAlong = d.grabFrac * d.len;
      }
      const pointerAlong = horiz ? e.clientX : e.clientY;
      const min = horiz ? cLeft : cTop;
      const max = horiz ? Math.max(min, cRight - d.len) : Math.max(min, cBottom - d.len);
      const along = clamp(pointerAlong - d.grabAlong, min, max);
      setToolDock((v) => ({ ...v, float: true, free: false, x: undefined, y: undefined, edge: dist, along }));
      /* мини-карта/плашки уступают место СРАЗУ, пока панель тянут над ними */
      pushOverlays(dist, dockRect(dist, along, horiz ? d.len : d.cross, horiz ? d.cross : d.len));
      return;
    }

    /* ── свободный режим: панель тянется за курсором в любой точке холста ── */
    d.snap = null;
    setToolMagnet(null);
    d.horiz = true;
    const x = clamp(e.clientX - d.grabAlong, cLeft, Math.max(cLeft, cRight - d.len));
    const y = clamp(e.clientY - d.grabCross, cTop, Math.max(cTop, cBottom - d.cross));
    setToolDock((v) => ({ ...v, float: true, free: true, x, y }));
    pushOverlays('free', { left: x, top: y, right: x + d.len, bottom: y + d.cross, width: d.len, height: d.cross });
  };

  const onGripUp = () => {
    window.removeEventListener('pointermove', onGripMove);
    window.removeEventListener('pointerup', onGripUp);
    const d = dragRef.current;
    dragRef.current = null;
    /* флаг сбрасываем СИНХРОННО (до setState): иначе подгонка в useLayoutEffect
       пропускалась (ref догонял позже) — блок оставался заэкранным до клика */
    toolDraggingRef.current = false;
    setToolDragging(false);
    setToolMagnet(null);
    if (!d || !d.moved) return;
    const topbarH = document.getElementById('topbar')?.offsetHeight || TOPBAR_H_FALLBACK;
    /* отпустили над шапкой (или магнит держал за шапку) — блок встаёт на своё место */
    if (d.snap === 'header' || d.pos.y <= topbarH) {
      const next: ToolDock = { float: false, edge: 'top', along: 0 };
      setToolDock(next);
      saveToolDock(next);
      return;
    }
    const st = reservedStrips();
    const ih = window.innerHeight;
    const iw = window.innerWidth;
    /* магнит края при отпускании: панель закрепляется у этого края (финальный
       клэмп по фактическому размеру — панель немедленно стоит целиком на экране);
       шапка исключена выше (первая проверка) — здесь остаётся только край */
    if (d.snap) {
      const dist: ToolEdge = d.snap;
      const el = floatRef.current;
      const r = el ? rectOf(el) : null;
      const len = r ? (dist === 'top' || dist === 'bottom' ? r.width : r.height) : d.len;
      const horiz = dist === 'top' || dist === 'bottom';
      if (horiz !== d.horiz) {
        d.horiz = horiz;
        d.grabAlong = d.grabFrac * len;
      }
      const min = horiz ? st.left + GAP : st.top + GAP;
      const max = horiz
        ? Math.max(min, iw - st.right - GAP - len)
        : Math.max(min, ih - st.bottom - GAP - len);
      const along = clamp((horiz ? d.pos.x : d.pos.y) - d.grabAlong, min, max);
      const next: ToolDock = { float: true, edge: dist, along, free: false };
      setToolDock(next);
      saveToolDock(next);
      return;
    }
    /* свободная позиция: клэмп по фактическому размеру и сохранение */
    const el = floatRef.current;
    const r = el ? rectOf(el) : null;
    const w = r ? r.width : d.len;
    const h = r ? r.height : d.cross;
    const prev = toolDockRef.current;
    const x = clamp(Number(prev.x) || GAP, st.left + GAP, Math.max(st.left + GAP, iw - st.right - GAP - w));
    const y = clamp(Number(prev.y) || GAP, st.top + GAP, Math.max(st.top + GAP, ih - st.bottom - GAP - h));
    const next: ToolDock = { float: true, free: true, edge: prev.edge || 'top', along: prev.along || GAP, x, y };
    setToolDock(next);
    saveToolDock(next);
  };

  const onGripDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const el = (e.currentTarget as HTMLElement).closest('.tool-block, .tool-float') as HTMLElement | null;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const floatStart = el.classList.contains('tool-float');
    const horizStart = !el.classList.contains('vert');
    const len = horizStart ? r.width : r.height;
    const cross = horizStart ? r.height : r.width;
    const along0 = horizStart ? e.clientX - r.left : e.clientY - r.top;
    dragRef.current = {
      moved: false,
      /* точка хвата: вдоль оси — пропорция (переживает смену ориентации/размера),
         поперёк — пиксели (панель держится за взятую высоту); при отрыве от шапки
         панель встаёт центром под курсор */
      grabFrac: len > 0 ? clamp(along0 / len, 0, 1) : 0.5,
      grabAlong: along0,
      grabCross: floatStart ? e.clientY - r.top : cross / 2,
      horiz: horizStart,
      len,
      cross,
      pos: { x: e.clientX, y: e.clientY },
      snap: null,
    };
    e.preventDefault();
    window.addEventListener('pointermove', onGripMove);
    window.addEventListener('pointerup', onGripUp);
  };

  /* закрытие попапов аккаунта/уведомлений и меню сохранения кликом мимо
     (capture, как bindSyncUI). Меню сохранения — .save-menu внутри .save-wrap:
     клик по пункту меню до capture-обработчика не «долетит» (onClick на .sm-i
     сработает раньше на том же pointerup→click), клик мимо — закрывает меню. */
  useEffect(() => {
    const onDoc = (e: Event) => {
      const t = e.target as Element | null;
      if (!t) return;
      if (store.accPop && !t.closest('.acc-pop') && !t.closest('#accBtn')) store.setAccPop(false);
      if (ntf.open && !t.closest('.ntf-pop') && !t.closest('#bellBtn')) ntf.setOpen(false);
      if (saveOpen && !t.closest('.save-wrap')) {
        setSaveOpen(false);
        setSavePos(null);
      }
    };
    document.addEventListener('pointerdown', onDoc, true);
    return () => document.removeEventListener('pointerdown', onDoc, true);
  }, [store, store.accPop, ntf.open, ntf.setOpen, saveOpen]);

  const zoomStep = (factor: number) => {
    const r = canvasApi.current?.getRect();
    if (r) store.zoomAt(r.width / 2, r.height / 2, factor);
  };

  const fitAll = () => {
    const api = canvasApi.current;
    const r = api ? api.getRect() : null;
    if (r && api) store.fitView(r.width, r.height, api.sizes);
  };

  const sc = store.sync;
  /* статус синхронизации: цвет точки и число участников онлайн (для правой
     половины составной кнопки «Поделиться») */
  const statusInfo = (() => {
    const map: Record<string, [string, string]> = {
      off: ['#cf6b5a', 'офлайн'],
      conn: ['#d8c96f', 'подключение…'],
      on: ['#8fbf7f', 'онлайн'],
      err: ['#cf6b5a', 'ошибка связи'],
      lost: ['#cf6b5a', 'связь потеряна'],
      copy: ['#e2a54e', 'копия'],
    };
    const isCopy = store.syncMode === 'copy';
    const [baseColor, baseText] = map[store.syncStatus] || map.off;
    const color = isCopy ? '#e2a54e' : baseColor;
    const count = store.syncStatus === 'on' ? (store.syncUsers.length || 1) : 0;
    const title = isCopy
      ? 'Режим копии: ' + ((sc && sc.activeCopyObj()?.name) || '') + ' — статус и участники'
      : store.syncStatus === 'on'
        ? 'В проекте сейчас работают: ' + count + ' — статус и участники'
        : baseText + ' — совместный доступ';
    return { color, count, title, isCopy };
  })();

  /* содержимое отсоединяемого блока (одинаково в шапке и в плавающей панели) */
  const toolContent = (
    <>
      <button type="button" className="btn ibtn" id="bUndo" title={'Отменить (' + hkText('undo') + ')'} disabled={!store.canUndo()} onClick={() => store.undo()}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M8 5 3.5 9.5 8 14" /><path d="M4 9.5h10a6 6 0 1 1 0 12h-3" /></svg>
      </button>
      <button type="button" className="btn ibtn" id="bRedo" title={'Повторить (' + hkText('redo') + ')'} disabled={!store.canRedo()} onClick={() => store.redo()}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M16 5l4.5 4.5L16 14" /><path d="M20 9.5H10a6 6 0 1 0 0 12h3" /></svg>
      </button>

      <div className="vsep" />

      <button type="button" className="btn ibtn" id="bZOut" title={'Отдалить (' + hkText('zoomOut') + ')'} onClick={() => zoomStep(1 / 1.15)}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"><path d="M5 12h14" /></svg>
      </button>
      <span id="zPct">{Math.round(store.vp.z * 100)}%</span>
      <button type="button" className="btn ibtn" id="bZIn" title={'Приблизить (' + hkText('zoomIn') + ')'} onClick={() => zoomStep(1.15)}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
      </button>
      <button type="button" className="btn ibtn" id="bFit" title={'Вписать всё (' + hkText('fitView') + ')'} onClick={fitAll}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" /></svg>
      </button>

      <div className="vsep" />

      <button type="button" className={'btn ibtn' + (store.gridOn ? ' on' : '')} id="bGrid" title="Сетка" onClick={() => store.toggleGrid()}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round"><path d="M4 4h.01M12 4h.01M20 4h.01M4 12h.01M12 12h.01M20 12h.01M4 20h.01M12 20h.01M20 20h.01" /></svg>
      </button>
      <button type="button" className={'btn ibtn' + (store.snapOn ? ' on' : '')} id="bSnap" title="Привязка к сетке" onClick={() => store.toggleSnap()}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M5 3v5a7 7 0 0 0 14 0V3" /><path d="M5 3h3v5H5zM16 3h3v5h-3z" /></svg>
      </button>
      <div className="vsep" style={{ margin: '0 8px' }} />
      <button type="button" className={'btn ibtn' + (store.bend === 'smooth' ? ' on' : '')} id="bBendS" title="Изгиб всех стрелок: плавный" onClick={() => store.setBend('smooth')}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"><path d="M4 18c7 0 3-12 10-12h6" /></svg>
      </button>
      <button type="button" className={'btn ibtn' + (store.bend === 'ortho90' ? ' on' : '')} id="bBend90" title="Изгиб всех стрелок: прямые углы (90°)" onClick={() => store.setBend('ortho90')}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M4 18h9a3 3 0 0 0 3-3V6h4" /></svg>
      </button>
      <button type="button" className={'btn ibtn' + (store.bend === 'ortho45' ? ' on' : '')} id="bBend45" title="Изгиб всех стрелок: углы 45°" onClick={() => store.setBend('ortho45')}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"><path d="M4 18h6l8-8h2" /></svg>
      </button>
      <div className="vsep" style={{ margin: '0 8px' }} />
      {/* Мини-карта (#bMap оригинала, 1115/9371): показывает/скрывает #miniMap */}
      <button type="button" className={'btn ibtn' + (store.mmOn ? ' on' : '')} id="bMap" title="Мини-карта" onClick={() => store.toggleMm()}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="16" rx="2" /><rect x="7" y="8" width="7" height="6" rx="1" fill="currentColor" fillOpacity=".3" /></svg>
      </button>
    </>
  );

  const vertFloat = toolDock.edge === 'left' || toolDock.edge === 'right';

  return (
    <>
    <header id="topbar" role="banner">
      <div className="brand">
        <svg viewBox="0 0 24 24" fill="none">
          <path d="M7.5 12h3c3.2 0 2.4-6.5 6-6.5M10.5 12c3.2 0 2.4 6.5 6 6.5" stroke="#4d535e" strokeWidth="1.6" strokeLinecap="round" />
          <circle cx="5.5" cy="12" r="2.6" fill="#e2a54e" />
          <circle cx="18.5" cy="5.5" r="2.1" fill="#9cb878" />
          <circle cx="18.5" cy="18.5" r="2.1" fill="#cf6d4f" />
        </svg>
        <div>
          <div className="lg">ВЕТВИ</div>
          <div className="sub">конструктор нарратива · react</div>
        </div>
      </div>

      <input
        id="projName"
        spellCheck={false}
        title="Название проекта"
        value={store.doc.meta.name || ''}
        aria-label="Название проекта"
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => store.setProjectName(e.target.value)}
      />

      <div className="vsep" />

      {/* блок кнопок меню: та же ширина, что у блока кнопок холста, со скроллом
          и стрелками — в узких окнах ни один из блоков не пропадает */}
      <div className="tb-fixed">
        {menuArrows.l && (
          <button type="button" className="tb-arrow l" title="Здесь есть ещё кнопки" aria-label="Прокрутить меню влево" onMouseDown={(e) => e.preventDefault()} onClick={() => scrollTool(-1, 'menu')}>
            <ArrowIcon dir="l" />
          </button>
        )}
        <div className="tb-fixed-scroll" ref={menuScrollRef} onScroll={measureArrows}>
          <button type="button" className="btn ibtn" id="bNew" title={'Новый проект (' + hkText('newProject') + ')'} aria-label="Новый проект" onClick={() => store.createProject()}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14M5 12h14" /></svg>
          </button>
          <button type="button" className="btn ibtn" id="bOpen" title={'Открыть (' + hkText('projects') + ')'} aria-label="Открыть проект" onClick={() => store.openModal('projects')}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg>
          </button>

          <div className={'save-wrap' + (saveOpen ? ' open' : '')} ref={saveRef}>
            <button type="button" className="btn primary ibtn" id="bSave" title={'Сохранить (' + hkText('save') + ')'} aria-label="Сохранить" onClick={() => store.saveAs()}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M5 3h11l4 4v14H5z" /><path d="M8 3v5h7V3M8 21v-7h8v7" /></svg>
            </button>
            <button
              type="button"
              className="btn primary caret"
              id="bSaveMenu"
              title="Варианты сохранения"
              aria-haspopup="menu"
              aria-expanded={saveOpen}
              onClick={() => {
                /* меню позиционируется fixed: не зависит от прокруток шапки */
                const el = saveRef.current;
                if (el) {
                  const r = el.getBoundingClientRect();
                  setSavePos({ left: Math.max(8, Math.min(r.left, window.innerWidth - 266)), top: r.bottom + 7 });
                }
                setSaveOpen((v) => !v);
              }}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6" /></svg>
            </button>
          <div
            className={'save-menu' + (saveOpen ? ' show' : '')}
            role="menu"
            aria-label="Сохранение и экспорт"
            style={savePos ? { position: 'fixed', left: savePos.left, top: savePos.top } : undefined}
          >
            <div className="sm-i" role="menuitem" onClick={() => { setSaveOpen(false); store.saveAs(); }}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M5 3h11l4 4v14H5z" /><path d="M8 3v5h7V3M8 21v-7h8v7" /></svg>
              Сохранить (JSON)
              <kbd>{hkText('save')}</kbd>
            </div>
            <div className="sm-i" role="menuitem" onClick={() => { setSaveOpen(false); store.saveAs(); }}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M5 3h11l4 4v14H5z" /><path d="M8 3v5h7V3" /></svg>
              Сохранить как… (JSON)
              <kbd>{hkText('saveAs')}</kbd>
            </div>
            <div className="sm-i" role="menuitem" onClick={() => { setSaveOpen(false); store.exportTxtFile(); }}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M6.5 3h11v18l-2.8-2-2.7 2-2.7-2L6.5 21z" /><path d="M9.5 8.5h5M9.5 12h5" /></svg>
              Текстовый файл (.txt)
            </div>
            <div className="sm-i" role="menuitem" onClick={() => { setSaveOpen(false); store.exportTextsJson(false); }}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M5 3h11l4 4v14H5z" /><path d="M9 12.5h6M9 16h6M9 9h2" /></svg>
              Тексты (JSON)
            </div>
            <div className="sm-i" role="menuitem" onClick={() => { setSaveOpen(false); store.exportTextsJson(true); }}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M5 3h11l4 4v14H5z" /><path d="M9 12.5h4M11 10.5v4" /><rect x="3" y="3" width="5" height="5" rx="1" strokeDasharray="1.6 1.4" /><rect x="16" y="16" width="5" height="5" rx="1" strokeDasharray="1.6 1.4" /></svg>
              Тексты выделенных нод (JSON)
              <kbd>{hkText('exportSel')}</kbd>
            </div>
            <div className="sm-i" role="menuitem" onClick={() => { setSaveOpen(false); store.openTextsImport(); }}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3v10.5" /><path d="m7.5 9.5 4.5 4.5 4.5-4.5" /><path d="M4.5 20.5h15" /></svg>
              Импорт текстов (JSON)…
            </div>
          </div>
        </div>

        <div className="vsep" />

        <button type="button" className="btn ibtn" id="bPlay" title={'Режим новеллы (' + hkText('play') + ') — выделенные блоки по порядку или весь сюжет'} aria-label="Играть" onClick={() => {
          store.setPlayerStart(null, false);
          store.openModal('player');
        }}>
          <svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M8 5.5v13l10.5-6.5z" /></svg>
        </button>

        {(sc && sc.enabled && store.syncMode !== 'copy') && (
          <button type="button" className="btn ibtn" id="bMerge" title="Merge-запросы копий" aria-label="Merge-запросы" onClick={() => store.openModal('merge')}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><circle cx="18" cy="18" r="2.6" /><circle cx="6" cy="6" r="2.6" /><path d="M6 21V9a9 9 0 0 0 9 9" /></svg>
            {store.syncMergeCount > 0 && <span className="m-badge">{store.syncMergeCount}</span>}
          </button>
        )}

        <button type="button" className="btn ibtn" id="bCopies" title="Локальные копии проекта" aria-label="Копии" onClick={() => store.openModal('copies')}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
        </button>

        <button type="button" className="btn ibtn" id="bLog" title="Журнал действий: кто и что менял в проекте" aria-label="Журнал действий" onClick={() => { store.setLogFilters(null, null); store.openModal('log'); }}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="8.6" /><path d="M12 7.4V12l3.2 2" /></svg>
        </button>

        {/* составная кнопка «Поделиться + онлайн»: слева — иконка поделиться
            (окно «Поделиться»), справа — статус: красная точка офлайн или зелёная
            с числом участников в проекте сейчас */}
        <div className="share-split" role="group" aria-label="Поделиться и статус совместной работы">
          <button type="button" className="btn primary sg-main" id="bShare" title="Поделиться ссылкой на проект" aria-label="Поделиться" onClick={() => {
            if (!sc) return;
            if (store.syncMode === 'copy') store.openModal('copyBar');
            else sc.shareProject();
          }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><circle cx="18" cy="5" r="2.6" /><circle cx="6" cy="12" r="2.6" /><circle cx="18" cy="19" r="2.6" /><path d="m8.4 13.4 7.2 4.2M15.6 6.4 8.4 10.6" /></svg>
          </button>
          <button
            type="button"
            className="btn primary sg-status"
            id="bCollab"
            title={statusInfo.title}
            aria-label="Статус совместной работы"
            onClick={() => {
              if (!sc) return;
              if (!sc.enabled) {
                if (store.syncMode === 'copy') store.openModal('copyBar');
                else sc.shareProject();
                return;
              }
              /* разрыв связи: клик по статусу — немедленное переподключение */
              if (sc.status !== 'on') { sc.reconnect(); return; }
              store.setCollabPop(!store.collabPop);
            }}
          >
            <span className={'cc-dot' + (store.syncStatus === 'conn' ? ' pulse' : '')} style={{ background: statusInfo.color }} />
            {statusInfo.count > 0 && <span className="sg-count">{statusInfo.count}</span>}
          </button>
        </div>

        {menuArrows.r && (
          <button type="button" className="tb-arrow r" title="Здесь есть ещё кнопки" aria-label="Прокрутить меню вправо" onMouseDown={(e) => e.preventDefault()} onClick={() => scrollTool(1, 'menu')}>
            <ArrowIcon dir="r" />
          </button>
        )}
        </div>
      </div>

      {/* отсоединяемый блок кнопок холста: в шапке — со внутренним скроллом и
          стрелками по краям, если кнопки не вмещаются */}
      {!toolDock.float && (
        <div className="tool-block">
          <button
            type="button"
            className="tool-grip"
            title="Отсоединить: перетащите блок на холст"
            aria-label="Отсоединить панель инструментов"
            onPointerDown={onGripDown}
          >
            <GripIcon />
          </button>
          {arrows.l && (
            <button type="button" className="tb-arrow l" title="Здесь есть ещё кнопки" aria-label="Прокрутить панель влево" onMouseDown={(e) => e.preventDefault()} onClick={() => scrollTool(-1)}>
              <ArrowIcon dir="l" />
            </button>
          )}
          <div className="tool-scroll" ref={scrollRef} onScroll={measureArrows}>
            {toolContent}
          </div>
          {arrows.r && (
            <button type="button" className="tb-arrow r" title="Здесь есть ещё кнопки" aria-label="Прокрутить панель вправо" onMouseDown={(e) => e.preventDefault()} onClick={() => scrollTool(1)}>
              <ArrowIcon dir="r" />
            </button>
          )}
        </div>
      )}

      <div className="spacer" />

      {/* правый прижатый блок: поиск, уведомления, аккаунт — всегда у края шапки,
          никуда не сдвигаются и не уезжают за экран */}
      <div className="tb-right">
        <button type="button" className="btn" id="bSearch" title={'Поиск по проекту (' + hkText('search') + ')'} onClick={() => store.openModal('search')}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
        </button>

        <button
          type="button"
          className="btn ibtn"
          id="bellBtn"
          title="Уведомления"
          aria-label="Уведомления"
          onClick={() => { ntf.toggle(); store.setAccPop(false); }}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9.5a6 6 0 0 1 12 0c0 5 2 6.5 2 6.5H4s2-1.5 2-6.5" /><path d="M10.3 20a2 2 0 0 0 3.4 0" /></svg>
          {ntf.state.unread > 0 && (
            <span className="m-badge bell-badge" aria-label={ntf.state.unread + ' непрочитанных уведомлений'}>
              {ntf.state.unread > 9 ? '9+' : ntf.state.unread}
            </span>
          )}
        </button>

        {/* аватар аккаунта вместо старой кнопки настроек: инфо о аккаунте, настройки, выход */}
        <button
          type="button"
          className="btn ibtn avatar-btn"
          id="accBtn"
          title={me.name + ' — аккаунт'}
          aria-label="Аккаунт"
          onClick={() => { store.setAccPop(!store.accPop); ntf.setOpen(false); }}
        >
          <span className="avatar-circle" style={{ background: me.color }}>{avatarInitial(me.name)}</span>
        </button>
      </div>
    </header>

    {/* плавающая панель инструментов: у любого края холста — горизонтальная
        (сверху/снизу) или вертикальная (слева/справа), либо в свободной позиции —
        тянется за курсором и магнитится к местам крепления. Перпендикулярная
        координата у края — в CSS по data-edge, вдоль края / свободная — here. */}
    {toolDock.float && (
      <div
        className={'tool-float' + (toolDock.free ? ' free' : '') + (vertFloat ? ' vert' : '') + (toolDragging ? ' dragging' : '') + (!toolDock.free && toolMagnet && toolDragging ? ' magnet' : '')}
        ref={floatRef}
        style={toolDock.free
          ? { left: toolDock.x, top: toolDock.y, right: '', bottom: '' }
          : vertFloat
            ? { top: toolDock.along, left: '', right: '', bottom: '' }
            : { left: toolDock.along, top: '', right: '', bottom: '' }}
        data-edge={toolDock.free ? 'free' : toolDock.edge}
        role="toolbar"
        aria-label="Панель инструментов холста"
      >
        <button
          type="button"
          className="tool-grip"
          title="Перетащите — панель следует за курсором; у края холста или шапки примагнитится"
          aria-label="Переместить панель инструментов"
          onPointerDown={onGripDown}
        >
          <GripIcon vert={vertFloat && !toolDock.free} />
        </button>
        <div className="float-scroll">
          {toolContent}
        </div>
      </div>
    )}

    <AccountPopover store={store} onClose={() => store.setAccPop(false)} />
    {ntf.open && (
      <NotificationsPopover
        items={ntf.state.items}
        onOpenItem={(n) => void ntf.openItem(n)}
        onClose={() => ntf.setOpen(false)}
      />
    )}
    </>
  );
}
