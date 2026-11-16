'use client';

/**
 * Ветви — модалка реплик диалога (порт #dlgModal оригинала:
 * dlgModalRender / dlgModalRenderReplies / dlgModalBind).
 * Разметка 1:1: .dlg-modal.show > .dlg-modal-card > .dlg-modal-head +
 * .dlg-modal-body (.dlg-participants с чипами участников, дерево .dlg-reply-ed(.root)
 * с .dlg-reply-row-ed (говорящий + текст), .dlg-reply-acts (.mini-btn), вложенность
 * .dlg-children-ed, кнопка корневой реплики .dlg-add-root-btn) + .dlg-modal-foot.
 * Логика сохранена: добавление ниже/веткой/корневой, порядок (вверх/вниз),
 * говорящий, текст с авторостом (.grow), «повтор» (.dlg-loop-tog.on), удаление,
 * подсветка целевой реплики (.dlg-flash) с автопрокруткой.
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { PALETTE_COLORS } from '@/vetvi/core/constants';
import { hkIs } from '@/vetvi/core/hotkeys';
import { RTFX_EFFECTS, rtfxWrap } from '@/vetvi/core/rtfx';
import type { VetviChar, VetviReply } from '@/vetvi/core/types';
import type { VetviStore } from './store';
import { RtfxView } from './RtfxView';

/* svg-иконки оригинала (ic()): контур 24×24, stroke currentColor, width/height по size */
const ICONS: Record<string, React.ReactNode> = {
  plus: <path d="M12 5v14M5 12h14" />,
  corner: <><path d="M5 5v4.6a3.9 3.9 0 0 0 3.9 3.9H19" /><path d="m15.5 9.5 3.5 3.5-3.5 3.5" /></>,
  x: <path d="M6 6l12 12M18 6 6 18" />,
  repeat: <><path d="M17 2.5 20.5 6 17 9.5" /><path d="M3.5 12V9a3 3 0 0 1 3-3h14" /><path d="M7 21.5 3.5 18 7 14.5" /><path d="M20.5 12v3a3 3 0 0 1-3 3h-14" /></>,
  chev: <path d="m6 9 6 6 6-6" />,
  chevUp: <path d="m6 15 6-6 6 6" />,
  target: <><circle cx="12" cy="12" r="7" /><path d="M12 2v4M12 18v4M2 12h4M18 12h4" /></>,
  grip: <path d="M9 5.5h.01M9 12h.01M9 18.5h.01M15 5.5h.01M15 12h.01M15 18.5h.01" />,
};

function Ic(props: { name: string; size: number }) {
  return (
    <svg viewBox="0 0 24 24" width={props.size} height={props.size} fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">
      {ICONS[props.name] || null}
    </svg>
  );
}

/* hexToRgba оригинала — подложка/рамка чипа участника */
function hexToRgba(hex: string, a: number): string {
  const h = String(hex || '').replace('#', '');
  const f = h.length === 3 ? h.split('').map((x) => x + x).join('') : h;
  const r = parseInt(f.slice(0, 2), 16);
  const g = parseInt(f.slice(2, 4), 16);
  const b = parseInt(f.slice(4, 6), 16);
  if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return 'rgba(154,161,172,' + a + ')';
  return 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
}

/* аватар персонажа (charAvatarHtml оригинала): рамка — цвет, без аватара — буква */
function CharAvatar({ c, extra }: { c: VetviChar; extra?: string }) {
  const shape = (c as { avShape?: string }).avShape === 'square' ? 'square' : 'circle';
  const av = (c as { av?: string }).av;
  const initial = (String(c.name || '').trim().charAt(0).toUpperCase()) || '?';
  return (
    <span className={'c-av ' + shape + (av ? '' : ' empty') + (extra ? ' ' + extra : '')} style={{ borderColor: c.color || '#9cb878' }}>
      {av ? <img src={av} alt="" /> : initial}
    </span>
  );
}

/* плавное раскрытие поля реплики: высота анимируется px→px (auto↔px не интерполируется,
   а height:auto у textarea не растёт с содержимым) — при фокусе поле плавно
   раскрывается под весь текст; схлопывание по blur — отложенно и мгновенно
   (taCollapseNow + scheduleReplyBlur: не сдвигать раскладку под идущим кликом) */
function taGrow(ta: HTMLTextAreaElement) {
  ta.style.height = (ta.scrollHeight + 2) + 'px'; /* +2 — верхняя и нижняя границы */
}

function taFocusGrow(ta: HTMLTextAreaElement) {
  const from = ta.offsetHeight;
  ta.style.transition = 'none';
  ta.style.height = from + 'px';
  void ta.offsetWidth; /* фиксируем стартовую высоту — дальше анимация px→px */
  ta.style.transition = '';
  taGrow(ta);
}

/* мгновенное схлопывание поля к авто-высоте (без анимации): анимация .22s
   держала бы раскладку «плавающей» ещё 220 мс — клик, начатый в этот
   промежуток, промахивался бы мимо сдвинувшейся кнопки (см. scheduleReplyBlur) */
function taCollapseNow(ta: HTMLTextAreaElement) {
  ta.style.transition = 'none';
  ta.style.height = '';
  ta.classList.remove('grow'); /* возврат к CSS: max-height:120px, overflow:auto */
  void ta.offsetWidth;
  ta.style.transition = '';
}

/* зажата ли сейчас кнопка мыши/пера (глобальный счётчик) — пока нажатие идёт,
   клик считается «в полёте» и раскладку двигать нельзя (scheduleReplyBlur) */
let vetviPtrDown = 0;
let vetviPtrInstalled = false;
function ptrButtonsDown(): boolean {
  if (typeof window === 'undefined') return false;
  if (!vetviPtrInstalled) {
    vetviPtrInstalled = true;
    window.addEventListener('pointerdown', () => { vetviPtrDown++; }, true);
    window.addEventListener('pointerup', () => { vetviPtrDown = Math.max(0, vetviPtrDown - 1); }, true);
    window.addEventListener('pointercancel', () => { vetviPtrDown = Math.max(0, vetviPtrDown - 1); }, true);
  }
  return vetviPtrDown > 0;
}

/* ═══ панель форматирования реплики (Ж/К/Цвет + эффекты) ═══
   Появляется над полем текста, пока оно активно (жёлтая рамка). Кнопки НЕ
   забирают фокус (preventDefault на mousedown) — курсор в поле жив, эффект
   применяется к слову под курсором или к выделению.
   Всплывашки (цвета/эффекты) рендерятся порталом в body с position:fixed:
   раньше они жили внутри .dlg-modal-body и резались его прокруткой —
   появлялся общий скролл, часть эффектов была видна только после прокрутки
   списка реплик. Теперь список всегда поверх всего (z выше модалки). */

const RT_POP_Z = 1200; /* выше .dlg-modal (110) и всего его содержимого */

function ReplyFmtBar(props: {
  apply: (kind: 'b' | 'i' | 'c' | 'fx', fxId: string | null, colorHex: string | null) => void;
}) {
  const { apply } = props;
  const [pop, setPop] = useState<'' | 'color' | 'fx'>('');
  const [popXY, setPopXY] = useState<{ x: number; y: number } | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const cBtnRef = useRef<HTMLButtonElement | null>(null);
  const fxBtnRef = useRef<HTMLButtonElement | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);

  const closePop = () => { setPop(''); setPopXY(null); };

  /* открытие: первичная позиция — под кнопкой; точная подгонка (замер,
     переворот вверх у нижнего края, отсечение правого) — после монтирования */
  const togglePop = (kind: 'color' | 'fx') => {
    if (pop === kind) { closePop(); return; }
    const btn = kind === 'fx' ? fxBtnRef.current : cBtnRef.current;
    if (!btn) return;
    const r = btn.getBoundingClientRect();
    setPopXY({ x: r.left, y: r.bottom + 6 });
    setPop(kind);
  };

  useLayoutEffect(() => {
    const el = popRef.current;
    if (!pop || !el || !popXY) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const anchor = pop === 'fx' ? fxBtnRef.current : cBtnRef.current;
    const ar = anchor ? anchor.getBoundingClientRect() : null;
    let x = Math.max(8, Math.min(popXY.x, vw - w - 8));
    let y = popXY.y;
    if (y + h > vh - 8) {
      y = ar ? ar.top - h - 6 : vh - h - 8; /* снизу не хватает — раскрываем вверх */
      if (y < 8) y = Math.max(8, vh - h - 8);
    }
    if (x === popXY.x && y === popXY.y) return;
    setPopXY({ x, y });
  }, [pop, popXY]);

  useEffect(() => {
    if (!pop) return;
    const insidePop = (t: Node | null) =>
      !!(t && ((wrapRef.current && wrapRef.current.contains(t)) || (popRef.current && popRef.current.contains(t))));
    const onDoc = (ev: MouseEvent) => {
      if (!insidePop(ev.target instanceof Node ? ev.target : null)) closePop();
    };
    const onScroll = (ev: Event) => {
      /* скролл внутри самого списка эффектов не закрывает его; любой другой —
         закрывает: всплывашка фиксирована к экрану и «отклеилась» бы от кнопки */
      if (ev.target instanceof Node && popRef.current && popRef.current.contains(ev.target)) return;
      closePop();
    };
    const onResize = () => closePop();
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    };
  }, [pop]);

  const noFocus = (e: React.MouseEvent) => e.preventDefault(); /* фокус остаётся в поле */

  return (
    <div className="dlg-fmt" ref={wrapRef} onMouseDown={noFocus}>
      <button
        type="button"
        className="rt-btn b"
        title="Жирность (Ctrl+B, маркер **текст**)
Можно комбинировать с эффектами"
        aria-label="Жирность"
        onClick={() => apply('b', null, null)}
      >Ж</button>
      <button
        type="button"
        className="rt-btn i"
        title="Курсив (Ctrl+I, маркер __текст__)
Можно комбинировать с эффектами"
        aria-label="Курсив"
        onClick={() => apply('i', null, null)}
      >К</button>
      <span className="rt-sep" />
      <button
        type="button"
        ref={cBtnRef}
        className="rt-btn c"
        title="Цвет слова (маркер {#hex}текст{/})
Можно комбинировать с эффектами"
        aria-label="Цвет"
        aria-expanded={pop === 'color'}
        onClick={() => togglePop('color')}
      >Ц<i className="rt-cbar" /></button>
      <button
        type="button"
        ref={fxBtnRef}
        className={'rt-btn fx' + (pop === 'fx' ? ' on' : '')}
        title="Эффекты: применяются к слову под курсором.
Эффекты между собой не комбинируются"
        aria-expanded={pop === 'fx'}
        onClick={() => togglePop('fx')}
      >Эффекты<svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round"><path d="m6 9 6 6 6-6" /></svg></button>
      {pop && popXY && createPortal(
        <div
          ref={popRef}
          className={'rt-pop ' + (pop === 'fx' ? 'rt-fxlist' : 'rt-colors')}
          role="menu"
          aria-label={pop === 'fx' ? 'Эффекты текста' : 'Цвет слова'}
          style={{ position: 'fixed', left: popXY.x, top: popXY.y, zIndex: RT_POP_Z }}
          onMouseDown={noFocus}
        >
          {pop === 'color' ? (
            <>
              {PALETTE_COLORS.map((col) => (
                <button
                  key={col}
                  type="button"
                  className="rt-swatch"
                  style={{ background: col }}
                  title={col}
                  aria-label={'Цвет ' + col}
                  onClick={() => { apply('c', null, col); closePop(); }}
                />
              ))}
              <button
                type="button"
                className="rt-swatch rt-swatch-auto"
                title="Убрать цвет"
                aria-label="Убрать цвет"
                onClick={() => { apply('c', null, ''); closePop(); }}
              >×</button>
            </>
          ) : (
            <>
              {RTFX_EFFECTS.map((e) => (
                <button
                  key={e.id}
                  type="button"
                  className="rt-fx-it"
                  title={e.hint}
                  onClick={() => { apply('fx', e.id, null); closePop(); }}
                >
                  {/* предпросмотр — реальный рендер реплики (RtfxView): per-letter эффекты
                      (дрожь/волна/отскок) анимируются и красятся по буквам, как в плеере,
                      а не целиком по слову */}
                  <span className="rt-fx-lbl"><RtfxView text={e.open + e.label + e.close} /></span>
                  <span className="rt-fx-hint">
                    <code>{e.open}слово{e.close}</code>
                    {e.hint}
                  </span>
                </button>
              ))}
              <div className="rt-fx-note">Эффект применяется к слову под курсором (или к выделению). Повторный выбор снимает эффект; эффекты между собой не комбинируются, но сочетаются с жирностью/курсивом/цветом. В поле эффект виден маркерами — вручную их тоже можно ввести.</div>
            </>
          )}
        </div>,
        document.body
      )}
    </div>
  );}

/* ═══ перетаскивание реплик — свободное, с автоподстройкой вложенности ═══
   Реплику можно бросить в любое место дерева: выше/ниже цели (уровень берётся
   от цели — вложенная становится корневой и наоборот) или ВНУТРЬ цели
   (последним ответом-веткой). Бросок на пустое место списка — корневой в конец.

   Геометрия (единый резолвер для подсветки И броска — индикатор всегда
   совпадает с результатом): список разбивается на «полосы» строк. Полоса
   строки — её собственный контент БЕЗ детей: у родителя это верхняя часть
   карточки до первого ребёнка, у листа — вся карточка. Раньше зоны считались
   от полного rect строки, куда входят все дети ветки, — из-за этого у родителя
   с детьми зона «ниже (корень)» начиналась внутри области детей, индикатор
   прыгал между уровнями, а drop уходил не туда. Теперь:
   • курсор в полосе строки: лист — 28%/44%/28% → выше/внутрь/ниже;
     родитель — 40%/60% → выше/внутрь (дальше вниз идут полосы детей);
   • курсор в зазоре между полосами — граница: выше середины зазора —
     «после верхней» строки (её уровень), ниже — «перед нижней» (её уровень);
   • ниже всех полос — корневой в конец списка.
   Мёртвых зон нет: любая точка списка разрешается в конкретное место, и drop
   разрешается той же функцией, что и подсветка. */

let dlgDragRid: string | null = null;
let dlgIndRow: HTMLElement | null = null;

type DlgDrop = { rid: string | null; place: 'before' | 'after' | 'inside' | 'root' };

function replyById(arr: VetviReply[], id: string): VetviReply | null {
  for (const r of arr) {
    if (r.id === id) return r;
    if (r.children && r.children.length) {
      const hit = replyById(r.children, id);
      if (hit) return hit;
    }
  }
  return null;
}

/** Цель лежит в поддереве root (перетаскивать внутрь собственного поддерева нельзя). */
function replySubtreeHas(root: VetviReply | null, id: string): boolean {
  if (!root) return false;
  if (root.id === id) return true;
  for (const ch of root.children || []) if (replySubtreeHas(ch, id)) return true;
  return false;
}

/** Нижняя граница «полосы» строки — верх первого ребёнка (у родителя)
 *  или низ самой строки (у листа). */
function dlgBandOf(row: HTMLElement): { top: number; bot: number; leaf: boolean } {
  const rc = row.getBoundingClientRect();
  const fc = row.querySelector(':scope > .dlg-children-ed > .dlg-reply-ed') as HTMLElement | null;
  return { top: rc.top, bot: fc ? fc.getBoundingClientRect().top : rc.bottom, leaf: !fc };
}

/** Резолюция курсора (по вертикали) в цель броска. */
function dlgResolveDrop(y: number): DlgDrop {
  const body = document.getElementById('dlgModalBody');
  if (!body) return { rid: null, place: 'root' };
  const rows = Array.from(body.querySelectorAll('.dlg-reply-ed')) as HTMLElement[];
  if (!rows.length) return { rid: null, place: 'root' };
  const bands = rows.map(dlgBandOf);
  /* полоса, содержащая курсор */
  for (let i = 0; i < bands.length; i++) {
    const b = bands[i];
    if (y >= b.top && y < b.bot) {
      const rel = (y - b.top) / Math.max(1, b.bot - b.top);
      if (b.leaf) return { rid: rows[i].dataset.rid || null, place: rel < 0.28 ? 'before' : rel > 0.72 ? 'after' : 'inside' };
      return { rid: rows[i].dataset.rid || null, place: rel < 0.4 ? 'before' : 'inside' };
    }
  }
  /* зазор: up — последняя полоса выше курсора, down — первая ниже */
  let up: { r: HTMLElement; bot: number } | null = null;
  let down: { r: HTMLElement; top: number } | null = null;
  for (let i = 0; i < bands.length; i++) {
    if (bands[i].bot <= y) up = { r: rows[i], bot: bands[i].bot };
    else { down = { r: rows[i], top: bands[i].top }; break; }
  }
  if (up && down) {
    const mid = (up.bot + down.top) / 2;
    return y < mid ? { rid: up.r.dataset.rid || null, place: 'after' } : { rid: down.r.dataset.rid || null, place: 'before' };
  }
  if (down) return { rid: down.r.dataset.rid || null, place: 'before' }; /* выше первой полосы */
  return { rid: null, place: 'root' }; /* ниже всех полос — корневой в конец */
}

function dlgClearInd(): void {
  if (dlgIndRow) { dlgIndRow.classList.remove('drop-above', 'drop-below', 'drop-in'); dlgIndRow = null; }
  document.getElementById('dlgModalBody')?.classList.remove('drop-root');
}

function dlgShowInd(res: DlgDrop): void {
  dlgClearInd();
  if (!res.rid) {
    document.getElementById('dlgModalBody')?.classList.add('drop-root');
    return;
  }
  const row = document.querySelector('#dlgModalBody .dlg-reply-ed[data-rid="' + res.rid + '"]') as HTMLElement | null;
  if (!row) return;
  row.classList.add(res.place === 'before' ? 'drop-above' : res.place === 'after' ? 'drop-below' : 'drop-in');
  dlgIndRow = row;
}

/* автоскролл списка реплик при перетаскивании к краям модалки (dlgAutoScroll оригинала 1601–1626):
   без него дотащить реплику до конца длинного списка нельзя — браузер сам не листает */
let dlgScrollEl: HTMLElement | null = null;
let dlgScrollDir = 0;
let dlgScrollRaf = 0;
let dlgScrollLast = 0;

function dlgAutoScrollStop(): void {
  dlgScrollDir = 0;
  dlgScrollLast = 0;
  dlgScrollEl = null;
  if (dlgScrollRaf) { cancelAnimationFrame(dlgScrollRaf); dlgScrollRaf = 0; }
}

function dlgAutoScrollStep(ts: number): void {
  if (!dlgScrollEl || !dlgScrollDir) { dlgScrollRaf = 0; dlgScrollLast = 0; return; }
  if (!dlgScrollLast) dlgScrollLast = ts;
  const dt = Math.min(50, ts - dlgScrollLast);
  dlgScrollLast = ts;
  dlgScrollEl.scrollTop += dlgScrollDir * dt * 0.75; /* ~750px/с независимо от герцовки */
  dlgScrollRaf = requestAnimationFrame(dlgAutoScrollStep);
}

function dlgAutoScrollUpdate(ev: DragEvent): void {
  if (!dlgDragRid) { dlgAutoScrollStop(); return; }
  const sc = document.getElementById('dlgModalBody');
  if (!sc) { dlgAutoScrollStop(); return; }
  const r = sc.getBoundingClientRect();
  const Z = 46;
  const y = ev.clientY;
  const dir = (y < r.top + Z) ? -1 : ((y > r.bottom - Z) ? 1 : 0);
  if (dir !== dlgScrollDir) { dlgScrollDir = dir; dlgScrollLast = 0; }
  if (dlgScrollDir) {
    dlgScrollEl = sc;
    if (!dlgScrollRaf) dlgScrollRaf = requestAnimationFrame(dlgAutoScrollStep);
  } else {
    dlgAutoScrollStop();
  }
}

export function DialogModal({ store }: { store: VetviStore }) {
  const nodeId = store.dialogEdit;
  const node = nodeId ? store.nodeById(nodeId) : null;
  const editPreRef = useRef<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  void store.revision;

  /* активное поле реплики: показывает панель Ж/К/Цвет + эффекты над текстом.
     taRef — само поле (курсор), editRid — какая реплика редактируется */
  const [editRid, setEditRid] = useState<string | null>(null);
  const taRef = useRef<HTMLTextAreaElement | null>(null);

  /* таймер отложенного blur-коллапса поля (см. комментарий в scheduleReplyBlur) */
  const blurTRef = useRef<number>(0);
  useEffect(() => () => { if (blurTRef.current) window.clearTimeout(blurTRef.current); }, []);

  /* ── отложенное схлопывание поля реплики при blur ──
     Карточка модалки центрируется flex'ом: «мгновенный» коллапс по blur
     (снятие панели формата + возврат высоты поля) сдвигает содержимое между
     mousedown и mouseup нажатия — click уходит общему предку, и кнопки
     («добавить реплику», «закрыть» и прочие) не срабатывают с первого раза.
     Поэтому коллапс откладывается: пока кнопка мыши зажата (клик ещё «в
     полёте») — ждём; выполняем без анимации, чтобы раскладка сразу стала
     стабильной для следующих нажатий. */
  const scheduleReplyBlur = (ta: HTMLTextAreaElement, rid: string) => {
    if (blurTRef.current) window.clearTimeout(blurTRef.current);
    blurTRef.current = window.setTimeout(function collapse() {
      blurTRef.current = 0;
      if (document.activeElement === ta) return; /* фокус вернулся в то же поле */
      if (ptrButtonsDown()) { blurTRef.current = window.setTimeout(collapse, 120); return; } /* клик ещё в полёте */
      taCollapseNow(ta);
      if (taRef.current === ta) taRef.current = null;
      setEditRid((cur) => (cur === rid ? null : cur));
    }, 260);
  };

  /** Применение разметки (Ж/К/Цвет/эффект) к слову под курсором активного поля. */
  const applyFmt = (kind: 'b' | 'i' | 'c' | 'fx', fxId: string | null, colorHex: string | null) => {
    const ta = taRef.current;
    if (!ta || !node) return;
    const s = ta.selectionStart ?? 0;
    const epos = ta.selectionEnd ?? s;
    const res = rtfxWrap(ta.value, s, epos, kind, fxId, colorHex);
    if (res.text === ta.value) return;
    store.updateReply(node.id, editRid as string, { text: res.text } as Partial<VetviReply>, { history: false });
    taGrow(ta);
    /* курсор обратно в поле: контролируемое значение доедет после рендера */
    window.setTimeout(() => {
      const t = taRef.current;
      if (!t) return;
      t.focus();
      t.setSelectionRange(res.start, res.end);
    }, 0);
  };

  useEffect(() => {
    if (store.dialogEdit) editPreRef.current = store.beginEdit();
    else editPreRef.current = null;
     
  }, [store.dialogEdit]);

  /* подсветка реплики: прокрутить к ней и мигнуть (dlgFlashReply оригинала) */
  const flash = store.flash;
  useEffect(() => {
    const el = listRef.current && flash ? listRef.current.querySelector('.dlg-flash') : null;
    if (!el) return;
    (el as HTMLElement).scrollIntoView({ block: 'center', behavior: 'smooth' });
    (el as HTMLElement).classList.remove('dlg-flash');
    void (el as HTMLElement).offsetWidth; /* перезапуск анимации, если подсветка ещё идёт */
    (el as HTMLElement).classList.add('dlg-flash');
  }, [flash]);

  /* автоскролл списка реплик при перетаскивании (слушатели делегированные — модалка не пересоздаётся, 4959–4963 оригинала) */
  useEffect(() => {
    if (!store.dialogEdit) return;
    const body = listRef.current;
    if (!body) return;
    const onOver = (ev: DragEvent) => dlgAutoScrollUpdate(ev);
    const onLeave = (ev: DragEvent) => {
      const rt = ev.relatedTarget as Node | null;
      if (!(rt && body.contains(rt))) dlgAutoScrollStop();
    };
    body.addEventListener('dragover', onOver);
    body.addEventListener('dragleave', onLeave);
    return () => {
      body.removeEventListener('dragover', onOver);
      body.removeEventListener('dragleave', onLeave);
      dlgAutoScrollStop();
    };
  }, [store.dialogEdit]);

  const n = node;
  const chars: VetviChar[] = store.doc.chars || [];
  const participants = n && n.dialog ? n.dialog.participants || [] : [];
  const partChars = participants
    .map((pid) => chars.find((c) => c.id === pid))
    .filter(Boolean) as VetviChar[];
  const close = () => {
    store.commitReplyEdit(editPreRef.current);
    store.closeDialogEditor();
  };

  if (!n || n.type !== 'dialog' || !n.dialog) {
    return null;
  }

  const removePart = (pid: string) => {
    store.setParticipants(n.id, participants.filter((p) => p !== pid));
  };

  /* локальная ссылка на диалог (сужение типа для замыканий drag-обработчиков) */
  const dlg = n.dialog;

  const renderReply = (r: VetviReply, depth: number): React.ReactNode => {
    const isRoot = depth === 0;
    const isFlash = !!(flash && flash.nodeId === n.id && flash.replyId === r.id);
    const loop = !!(r as unknown as { loop?: boolean }).loop;
    /* перетаскивание реплик: grip по mousedown делает строку draggable.
       Подсветка и бросок — делегированные, на теле списка (dlgResolveDrop),
       поэтому на строке только старт/конец перетаскивания */
    const onDragStart = (ev: React.DragEvent) => {
      const row = ev.currentTarget as HTMLElement;
      if (ev.target !== row) return; /* dragstart от вложенной реплики — не мешаем */
      if (row.getAttribute('draggable') !== 'true') { ev.preventDefault(); return; }
      ev.dataTransfer.effectAllowed = 'move';
      try { ev.dataTransfer.setData('text/plain', r.id); } catch { /* старые браузеры */ }
      dlgDragRid = r.id;
      setTimeout(() => row.classList.add('dragging'), 0);
    };
    const onDragEnd = (ev: React.DragEvent) => {
      const row = ev.currentTarget as HTMLElement;
      row.removeAttribute('draggable');
      row.classList.remove('dragging');
      dlgClearInd();
      dlgDragRid = null;
      dlgAutoScrollStop();
    };
    return (
      <div
        key={r.id}
        className={'dlg-reply-ed' + (isRoot ? ' root' : '') + (isFlash ? ' dlg-flash' : '')}
        data-rid={r.id}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
      >
        {editRid === r.id && <ReplyFmtBar apply={applyFmt} />}
        <div className="dlg-reply-row-ed">
          <select
            data-f="speaker"
            value={r.speaker || ''}
            aria-label="Говорящий"
            onFocus={() => { editPreRef.current = editPreRef.current || store.beginEdit(); }}
            onChange={(e) => {
              const pre = editPreRef.current;
              store.updateReply(n.id, r.id, { speaker: e.target.value || null }, { history: false });
              if (pre) store.commitReplyEdit(pre);
              editPreRef.current = store.beginEdit();
            }}
          >
            <option value="">— не выбран —</option>
            {partChars.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <textarea
            data-f="text"
            placeholder="Текст реплики…"
            value={r.text}
            aria-label={'Текст реплики ' + r.id}
            onFocus={(e) => {
              editPreRef.current = editPreRef.current || store.beginEdit();
              const ta = e.currentTarget;
              taRef.current = ta;
              setEditRid(r.id);
              ta.classList.add('grow');
              taFocusGrow(ta);
            }}
            onChange={(e) => {
              store.updateReply(n.id, r.id, { text: e.target.value }, { history: false });
              taGrow(e.currentTarget);
            }}
            onKeyDown={(e) => {
              /* Ctrl+B / Ctrl+I — разметка жирности/курсива прямо в поле (слово
                 под курсором или выделение); переназначается в настройках хоткеев */
              const ke = e.nativeEvent;
              if (hkIs(ke, 'fmtBold')) { e.preventDefault(); applyFmt('b', null, null); return; }
              if (hkIs(ke, 'fmtItalic')) { e.preventDefault(); applyFmt('i', null, null); }
            }}
            onBlur={(e) => {
              /* история правки — сразу (на раскладку не влияет); схлопывание поля
                 и снятие панели формата — отложенно (scheduleReplyBlur), иначе
                 клик по кнопкам модалки «теряется» между mousedown и mouseup */
              const pre = editPreRef.current;
              if (pre) { store.commitReplyEdit(pre); editPreRef.current = store.beginEdit(); }
              scheduleReplyBlur(e.currentTarget, r.id);
            }}
          />
        </div>
        <div className="dlg-reply-acts">
          <button
            type="button"
            className={'mini-btn dlg-loop-tog' + (loop ? ' on' : '')}
            data-act="loop"
            title="Повтор: после этой реплики диалог начнётся заново. Включите, чтобы зациклить проигрывание после вывода реплики"
            onClick={() => {
              store.updateReply(n.id, r.id, { loop: !loop } as Partial<VetviReply>, { label: 'Повтор реплики' });
            }}
          ><Ic name="repeat" size={11} /></button>
          <button
            type="button"
            className="mini-btn dlg-drag"
            data-act="drag"
            title="Перетащите — изменить порядок или вложенность: выше/ниже цели — на уровень цели, на середину — ответ-веткой внутрь"
            onMouseDown={(ev) => {
              const row = (ev.currentTarget as HTMLElement).closest('.dlg-reply-ed');
              if (row) row.setAttribute('draggable', 'true');
            }}
            onDoubleClick={(ev) => ev.preventDefault()}
          ><Ic name="grip" size={11} /></button>
          <button type="button" className="mini-btn" title="К реплике на холсте" onClick={() => { store.requestFlash(n.id, r.id); }}><Ic name="target" size={11} /></button>
          <button type="button" className="mini-btn" data-act="add-below" title="Новая реплика ниже" onClick={() => store.addReply(n.id, r.id, false)}><Ic name="plus" size={11} /></button>
          <button type="button" className="mini-btn" data-act="add-child" title="Ответ-ветка (вложенная)" onClick={() => store.addReply(n.id, r.id, true)}><Ic name="corner" size={11} /></button>
          <button type="button" className="mini-btn del" data-act="del" title="Удалить реплику" onClick={() => store.deleteReply(n.id, r.id)}><Ic name="x" size={11} /></button>
        </div>
        {r.children && r.children.length ? (
          <div className="dlg-children-ed">{r.children.map((ch) => renderReply(ch, depth + 1))}</div>
        ) : null}
      </div>
    );
  };

  return (
    <div
      id="dlgModal"
      className="dlg-modal show"
      role="dialog"
      aria-label="Редактор диалога"
      onPointerDown={(e) => { if ((e.target as HTMLElement).id === 'dlgModal') close(); }}
    >
      <div className="dlg-modal-card">
        <div className="dlg-modal-head">
          <span className="dlg-modal-title">Реплики: {n.title || 'Диалог'}</span>
          <button type="button" className="dlg-modal-close" title="Закрыть" onClick={close}>×</button>
        </div>
        <div
          className="dlg-modal-body"
          id="dlgModalBody"
          ref={listRef}
          onDragOver={(ev) => {
            /* делегированная подсветка: любая точка списка разрешается резолвером —
               индикатор всегда на том месте, куда реплика реально попадёт */
            if (!dlgDragRid) return;
            const res = dlgResolveDrop(ev.clientY);
            if (res.rid) {
              /* на саму себя и в собственное поддерево бросок не разрешаем —
                 и подсветку снимаем, чтобы старый индикатор не «висел» */
              if (res.rid === dlgDragRid) { dlgClearInd(); return; }
              const src = replyById(dlg.replies, dlgDragRid);
              if (replySubtreeHas(src, res.rid)) { dlgClearInd(); return; }
            }
            ev.preventDefault();
            ev.dataTransfer.dropEffect = 'move';
            dlgShowInd(res);
          }}
          onDragLeave={(ev) => {
            const rt = ev.relatedTarget as Node | null;
            const el = ev.currentTarget as HTMLElement;
            if (!rt || !el.contains(rt)) { dlgClearInd(); dlgAutoScrollStop(); }
          }}
          onDrop={(ev) => {
            const res = dlgResolveDrop(ev.clientY);
            ev.preventDefault();
            dlgAutoScrollStop();
            const srcRid = dlgDragRid;
            dlgDragRid = null;
            dlgClearInd();
            if (!srcRid) return;
            if (!res.rid) { store.moveReplyTo(n.id, srcRid, null, 'root'); return; }
            if (res.rid === srcRid) return;
            const src = replyById(dlg.replies, srcRid);
            if (replySubtreeHas(src, res.rid)) {
              store.toast('Нельзя переложить реплику внутрь её собственной ветки', 'warn');
              return;
            }
            store.moveReplyTo(n.id, srcRid, res.rid, res.place);
          }}
        >
          {partChars.length > 0 && (
            <div className="dlg-participants">
              {partChars.map((c) => {
                const color = c.color || '#9cb878';
                return (
                  <span key={c.id} className="dlg-chip" style={{ background: hexToRgba(color, 0.15), color, borderColor: hexToRgba(color, 0.55) }}>
                    <CharAvatar c={c} extra="chip" />
                    <span>{c.name}</span>
                    <span className="x" title="Убрать" onClick={() => removePart(c.id)}><Ic name="x" size={10} /></span>
                  </span>
                );
              })}
            </div>
          )}
          {n.dialog.replies.map((r) => renderReply(r, 0))}
          {!n.dialog.replies.length && <div className="dlg-empty">Реплик пока нет — добавьте первую.</div>}
          <div style={{ marginTop: 12 }}>
            <button type="button" className="dlg-add-root-btn" onClick={() => store.addReply(n.id)}>
              <Ic name="plus" size={11} /> Добавить корневую реплику
            </button>
          </div>
        </div>
        <div className="dlg-modal-foot">
          <button type="button" className="btn primary" onClick={close}>Готово</button>
        </div>
      </div>
    </div>
  );
}
