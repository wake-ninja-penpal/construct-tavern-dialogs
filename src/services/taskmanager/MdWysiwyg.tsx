'use client';

/**
 * Живой WYSIWYG-редактор Markdown (одно окно, результат виден сразу):
 * contenteditable с отрисованным Markdown внутри; на каждый ввод содержимое
 * сериализуется обратно в Markdown-исходник (mdHtmlToSource) и отдаётся
 * родителю на автосохранение. Никаких режимов «правка/сплит/просмотр» —
 * печатаем и сразу видим жирный/списки/чекбоксы как в режиме просмотра.
 *
 * Инструменты — document.execCommand (списки, инлайн-стили) + РУЧНАЯ
 * перестройка DOM для блоков (цитата → blockquote>p, как в отрисовке;
 * блок кода ↔ абзац; строка ↔ чек-пункт) — чтобы структура редактора
 * всегда совпадала со структурой «читалки» и отображалась одинаково.
 *
 * Enter внутри списков обрабатывается ВРУЧНУЮ (браузер в чек-листе рвал
 * структуру: новый li терял класс mdtask и чекбокс): пункт продолжается с
 * новым чекбоксом, КАРЕТКА СТАНОВИТСЯ ПОСЛЕ чекбокса (раньше текст попадал
 * ПЕРЕД квадратиком — браузер ставил каретку в начало li). Пустой пункт
 * закрывает список. Tab/Shift+Tab — подпункты. Чекбоксы кликабельны прямо
 * в тексте (contenteditable=false на квадратике). Вставка — только текст.
 *
 * ПАНЕЛЬ: активные кнопки подсвечиваются (onActiveChange — состояние под
 * кареткой/выделением: жирный/курсив/зачёркнутый/заголовок/цитата/списки/
 * чек-лист/код/блок кода), повторный клик снимает форматирование.
 *
 * Блоки кода переподсвечиваются под язык (highlightCode из md.ts) — блок,
 * в котором стоит каретка, не трогается (чтобы не рвать ввод), остальные
 * приводятся к актуальной подсветке после каждого ввода/перевода каретки.
 *
 * ПКМ на выделенном фрагменте — меню «Цитировать в комментарий» (quoteMenu).
 */

import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';

import { codeTextOf, highlightCode, mdHtmlToSource, mdToHtml } from './md';
import { tmOpenMenu } from './TmMenu';

export interface MdWysiwygHandle {
  /** Применить инструмент панели к текущему выделению и отдать новый исходник. */
  exec: (toolId: string) => void;
  /** Фокус в редактор. */
  focus: () => void;
  /** Текущий markdown-исходник содержимого. */
  source: () => string;
}

interface Props {
  value: string;
  onChange: (md: string) => void;
  disabled?: boolean;
  placeholder?: string;
  /** Класс-обёртка (высота/рамки задаёт родитель). */
  className?: string;
  /** Автовысота с потолком (композер чата: не выше трети окна задачи). */
  autoGrow?: boolean;
  maxGrow?: number;
  /** Enter — отдаём наружу (композер: отправка), а не перевод строки. */
  onEnter?: () => void;
  /** Esc — отдаём наружу (описание задачи: свернуть редактор). */
  onEsc?: () => void;
  /** Активные инструменты под кареткой/выделением — подсветка панели. */
  onActiveChange?: (active: string[]) => void;
  /** ПКМ на выделении открывает меню «Цитировать в комментарий». */
  quoteMenu?: boolean;
  ariaLabel?: string;
}

export const MdWysiwyg = forwardRef<MdWysiwygHandle, Props>(function MdWysiwyg(props, ref) {
  const boxRef = useRef<HTMLDivElement>(null);
  const mountedRef = useRef(false);
  const emitted = useRef<string>(props.value);
  const composing = useRef(false);
  const lastActive = useRef('');
  const { onChange, onEnter, onEsc, onActiveChange } = props;
  const cbRef = useRef({ onChange, onEnter, onEsc, onActiveChange });
  useEffect(() => { cbRef.current = { onChange, onEnter, onEsc, onActiveChange }; });

  /* монтируем содержимое РОВНО ОДИН раз (стабильный ref-объект — иначе React
     при каждом рендере вызывает колбэк-реф заново и сбрасывает innerHTML,
     ломая каретку и ввод — тот самый баг «обратного» текста) */
  useEffect(() => {
    const box = boxRef.current;
    if (!box || mountedRef.current) return;
    mountedRef.current = true;
    box.innerHTML = mdToHtml(props.value || '');
    emitted.current = props.value;
    normalizeWidgets(box);
    refreshHighlight(box, null);
    syncEmpty(box);
    if (props.autoGrow) growTo(box, props.maxGrow ?? 120);
  }, []);

  /* синхронизация снаружи: если value отличается от того, что мы отдали
     последними (внешняя правка/смена задачи/ОЧИСТКА после отправки):
     содержимое уже совпадает — просто фиксируем; пустое значение применяем
     всегда (чтобы отправка комментария очищала поле), непустое — только
     когда поле не в фокусе (не дёргаем каретку при вводе) */
  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    if (props.value === emitted.current) return;
    const cur = mdHtmlToSource(box);
    if (cur === props.value) { emitted.current = props.value; syncEmpty(box); return; }
    if (props.value === '' || document.activeElement !== box) {
      emitted.current = props.value;
      box.innerHTML = mdToHtml(props.value || '');
      normalizeWidgets(box);
      refreshHighlight(box, null);
      syncEmpty(box);
      if (props.autoGrow) growTo(box, props.maxGrow ?? 120);
    }
  }, [props.value, props.autoGrow, props.maxGrow]);

  /* активные инструменты панели — состояние под кареткой (или [] вне поля);
     вызывается на ввод, exec и любое движение каретки */
  const reportActive = (): void => {
    const box = boxRef.current;
    const cb = cbRef.current.onActiveChange;
    if (!box || !cb) return;
    const act = document.activeElement === box ? activeTools(box) : [];
    const key = act.join(',');
    if (key === lastActive.current) return;
    lastActive.current = key;
    cb(act);
  };

  const emit = (): void => {
    const box = boxRef.current;
    if (!box) return;
    const md = mdHtmlToSource(box);
    emitted.current = md;
    normalizeWidgets(box);
    refreshHighlight(box, document.activeElement === box ? codeUnderCaret() : null);
    syncEmpty(box);
    if (props.autoGrow) growTo(box, props.maxGrow ?? 120);
    reportActive();
    cbRef.current.onChange(md);
  };

  /* движение каретки: переподсветить код вне блока с кареткой + панель */
  useEffect(() => {
    const handler = () => {
      const box = boxRef.current;
      if (!box) return;
      if (document.activeElement === box) refreshHighlight(box, codeUnderCaret());
      reportActive();
    };
    document.addEventListener('selectionchange', handler);
    return () => document.removeEventListener('selectionchange', handler);
  }, []);

  useEffect(() => {
    const box = boxRef.current;
    if (box && props.autoGrow) growTo(box, props.maxGrow ?? 120);
    /* пересчёт потолка при смене режима окна */
  }, [props.autoGrow, props.maxGrow]);

  useImperativeHandle(ref, () => ({
    exec: (toolId: string) => {
      const box = boxRef.current;
      if (!box || props.disabled) return;
      execTool(box, toolId, () => emit());
    },
    focus: () => {
      const box = boxRef.current;
      if (box) { box.focus(); moveCaretToEnd(box); }
    },
    source: () => {
      const box = boxRef.current;
      return box ? mdHtmlToSource(box) : '';
    },
  }));

  return (
    <div
      ref={boxRef}
      className={'mdw md-body' + (props.className ? ' ' + props.className : '') + (props.disabled ? ' ro' : '')}
      contentEditable={!props.disabled}
      suppressContentEditableWarning
      role="textbox"
      aria-multiline="true"
      aria-label={props.ariaLabel || 'Редактор Markdown'}
      data-ph={props.placeholder || ''}
      onInput={() => { if (!composing.current) emit(); }}
      onBlur={() => { emit(); reportActive(); }}
      onCompositionStart={() => { composing.current = true; }}
      onCompositionEnd={() => { composing.current = false; emit(); }}
      onPaste={(e) => {
        /* вставка только текстом — чужой HTML ломает наш рендер */
        e.preventDefault();
        const text = e.clipboardData.getData('text/plain');
        document.execCommand('insertText', false, text);
      }}
      onClick={(e) => {
        const t = (e.target as HTMLElement).closest?.('.mdchk') as HTMLElement | null;
        if (!t || props.disabled) return;
        e.preventDefault();
        t.classList.toggle('on');
        emit();
      }}
      onContextMenu={(e) => {
        /* ПКМ на выделенном фрагменте: «цитировать в комментарий» */
        if (!props.quoteMenu || props.disabled) return;
        const box = boxRef.current;
        const sel = window.getSelection();
        if (!box || !sel || sel.isCollapsed || !sel.anchorNode || !box.contains(sel.anchorNode)) return;
        e.preventDefault();
        e.stopPropagation();
        const frag = sel.getRangeAt(0).cloneContents();
        const tmp = document.createElement('div');
        tmp.appendChild(frag);
        /* пункты списка без обёртки ul/ol — завернуть, иначе маркеры потеряются */
        if (tmp.querySelector('li')) {
          const list = document.createElement(tmp.querySelector('ol') ? 'ol' : 'ul');
          while (tmp.firstChild) list.appendChild(tmp.firstChild);
          tmp.appendChild(list);
        }
        const src = mdHtmlToSource(tmp);
        const quoted = src.split('\n').map((l) => (l.trim() ? '> ' + l : '>')).join('\n');
        tmOpenMenu('mdsel', { text: quoted, plain: sel.toString() }, e.clientX, e.clientY);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && props.onEsc) {
          e.preventDefault();
          e.stopPropagation();
          emit();
          props.onEsc();
          return;
        }
        if (e.key === 'Enter' && !e.shiftKey && props.onEnter && !e.ctrlKey && !e.metaKey) {
          e.preventDefault();
          props.onEnter();
          return;
        }
        /* Ctrl+B / Ctrl+I / Ctrl+K — как в прототипе */
        const mod = e.ctrlKey || e.metaKey;
        const box = boxRef.current;
        if (mod && ['b', 'i', 'k'].includes(e.key.toLowerCase())) {
          e.preventDefault();
          execTool(box!, e.key.toLowerCase() === 'b' ? 'bold' : e.key.toLowerCase() === 'i' ? 'italic' : 'link', () => emit());
          return;
        }
        if (!box || props.disabled) return;
        /* Enter внутри списка — свой обработчик: чек-лист продолжается
           ЧЕКБОКСОМ, каретка ПОСЛЕ него (браузер рвал структуру и оставлял
           «обычную строку», текст попадал перед квадратиком) */
        if (e.key === 'Enter' && !e.shiftKey && !mod) {
          const li = liOfCaret(box);
          if (li && enterInList(box, li, e)) { emit(); return; }
        }
        /* Tab / Shift+Tab — подпункты списков (indent/outdent) */
        if (e.key === 'Tab') {
          const li = liOfCaret(box);
          if (li && (e.shiftKey ? outdentList(li) : indentList(li))) {
            e.preventDefault();
            emit();
            return;
          }
        }
      }}
    />
  );
});

/* чекбоксы и язык кода — служебные виджеты: их нельзя править текстом;
   li.mdtask без чекбокса (после браузерных split/indent) получает его обратно */
function normalizeWidgets(box: HTMLElement): void {
  box.querySelectorAll<HTMLElement>('.mdchk').forEach((c) => { c.contentEditable = 'false'; });
  box.querySelectorAll<HTMLElement>('.lang').forEach((c) => { c.contentEditable = 'false'; });
  box.querySelectorAll<HTMLElement>('li.mdtask').forEach((li) => {
    const chk = li.querySelector(':scope > .mdchk');
    if (chk) {
      /* состояние пункта дублируем в data-атрибут — переживёт потерю чекбокса */
      li.dataset.on = chk.classList.contains('on') ? '1' : '0';
    } else {
      const nchk = document.createElement('span');
      nchk.className = 'mdchk' + (li.dataset.on === '1' ? ' on' : '');
      nchk.setAttribute('aria-hidden', 'true');
      li.insertBefore(nchk, li.firstChild);
    }
  });
}

/* ── подсветка кода в редакторе: pre>code без каретки обновляется ── */
function codeUnderCaret(): HTMLElement | null {
  const sel = window.getSelection();
  if (!sel || !sel.anchorNode) return null;
  let el: HTMLElement | null = sel.anchorNode.nodeType === Node.ELEMENT_NODE
    ? sel.anchorNode as HTMLElement
    : sel.anchorNode.parentElement;
  while (el) {
    if (el.tagName === 'CODE' && el.parentElement?.tagName === 'PRE') return el;
    el = el.parentElement;
  }
  return null;
}

function refreshHighlight(box: HTMLElement, except: HTMLElement | null): void {
  box.querySelectorAll<HTMLElement>('pre > code').forEach((code) => {
    if (except && (code === except || code.contains(except))) return;
    const pre = code.parentElement as HTMLElement;
    const langEl = pre?.querySelector<HTMLElement>(':scope > .lang');
    const html = highlightCode(codeTextOf(code), langEl?.textContent || '');
    if (code.innerHTML !== html) code.innerHTML = html;
  });
}

function syncEmpty(box: HTMLElement): void {
  const empty = !box.textContent?.trim() && !box.querySelector('img') && !box.querySelector('.mdchk');
  box.classList.toggle('empty', empty);
}

function moveCaretToEnd(box: HTMLElement): void {
  const sel = window.getSelection();
  if (!sel) return;
  const r = document.createRange();
  r.selectNodeContents(box);
  r.collapse(false);
  sel.removeAllRanges();
  sel.addRange(r);
}

/* ── активные инструменты под кареткой/выделением ──
   Проходим по предкам (структура надёжнее execCommand) + дублируем
   queryCommandState для инлайна (жирный/курсив/зачёркнутый). */
function activeTools(box: HTMLElement): string[] {
  const sel = window.getSelection();
  const act = new Set<string>();
  if (!sel || !sel.anchorNode || !box.contains(sel.anchorNode)) return [];
  let el: HTMLElement | null = sel.anchorNode.nodeType === Node.ELEMENT_NODE
    ? sel.anchorNode as HTMLElement
    : sel.anchorNode.parentElement;
  for (let n = el; n && n !== box; n = n.parentElement) {
    const t = n.tagName;
    if (t === 'STRONG' || t === 'B') act.add('bold');
    if (t === 'EM' || t === 'I') act.add('italic');
    if (t === 'DEL' || t === 'S' || t === 'STRIKE') act.add('strike');
    if (t === 'CODE' && n.parentElement && n.parentElement.tagName !== 'PRE') act.add('code');
    if (t === 'PRE') { act.add('codeblock'); act.delete('code'); }
    if (t === 'BLOCKQUOTE') act.add('quote');
    if (/^H[1-6]$/.test(t)) act.add('heading');
    if (t === 'UL') act.add('ul');
    if (t === 'OL') act.add('ol');
    if (t === 'LI' && (n as HTMLElement).classList.contains('mdtask')) act.add('task');
  }
  /* NOTE: без queryCommandState — он считает «жирным» любой текст с
     жирным стилем (например, наш `код` с font-weight 600) и подсвечивает
     кнопку без реальной разметки; предки надёжнее: наш рендер всегда
     оборачивает инлайн в STRONG/EM/DEL */
  return Array.from(act);
}

/* автовысота: поле растёт по содержимому до потолка maxGrow */
function growTo(box: HTMLDivElement, max: number): void {
  box.style.height = 'auto';
  const h = Math.min(box.scrollHeight, max);
  box.style.height = Math.max(h, 38) + 'px';
  box.style.overflowY = box.scrollHeight > max ? 'auto' : 'hidden';
}

/* li, в котором стоит каретка (или null) */
function liOfCaret(box: HTMLElement): HTMLElement | null {
  const sel = window.getSelection();
  if (!sel || !sel.anchorNode || !box.contains(sel.anchorNode)) return null;
  let el: HTMLElement | null = sel.anchorNode.nodeType === 1 ? sel.anchorNode as HTMLElement : sel.anchorNode.parentElement;
  while (el && el !== box && el.tagName !== 'LI') el = el.parentElement;
  return el && el !== box && el.tagName === 'LI' ? el : null;
}

/* блочный элемент под кареткой (для инструментов-«переключателей») */
function blockOfCaret(box: HTMLElement): HTMLElement | null {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount || !sel.anchorNode || !box.contains(sel.anchorNode)) return null;
  let el: HTMLElement | null = sel.anchorNode.nodeType === 1 ? sel.anchorNode as HTMLElement : sel.anchorNode.parentElement;
  while (el && el !== box && !/^(H[1-6]|P|DIV|BLOCKQUOTE|LI|PRE)$/.test(el.tagName)) el = el.parentElement;
  return el && el !== box ? el : null;
}

/* инлайновый <code> (не внутри pre), в котором стоит каретка */
function inlineCodeOf(box: HTMLElement): HTMLElement | null {
  const sel = window.getSelection();
  if (!sel || !sel.anchorNode || !box.contains(sel.anchorNode)) return null;
  let el: HTMLElement | null = sel.anchorNode.nodeType === 1 ? sel.anchorNode as HTMLElement : sel.anchorNode.parentElement;
  while (el && el !== box) {
    if (el.tagName === 'CODE' && el.parentElement?.tagName !== 'PRE') return el;
    el = el.parentElement;
  }
  return null;
}

function placeCaretAtStart(el: HTMLElement): void {
  const sel = window.getSelection();
  if (!sel) return;
  const r = document.createRange();
  const first = el.firstChild;
  if (first && first.nodeType === 3) r.setStart(first, 0);
  else r.setStart(el, 0);
  r.collapse(true);
  sel.removeAllRanges();
  sel.addRange(r);
}

function placeCaretAtEnd(el: HTMLElement): void {
  const sel = window.getSelection();
  if (!sel) return;
  const r = document.createRange();
  r.selectNodeContents(el);
  r.collapse(false);
  sel.removeAllRanges();
  sel.addRange(r);
}

/* каретка ПОСЛЕ чекбокса пункта чек-листа (текст пишется после квадратика) */
function placeCaretAfterMarker(li: HTMLElement): void {
  const sel = window.getSelection();
  if (!sel) return;
  const r = document.createRange();
  const chk = li.querySelector(':scope > .mdchk');
  const first: Node | null = chk ? chk.nextSibling : li.firstChild;
  if (first) r.setStart(first, 0);
  else r.setStart(li, chk ? 1 : 0);
  r.collapse(true);
  sel.removeAllRanges();
  sel.addRange(r);
}

/* ── Enter внутри списка: продолжить пункт с его маркером ──
   Возвращает true, если нажатие обработано (emit нужен). */
function enterInList(box: HTMLElement, li: HTMLElement, e: { preventDefault: () => void }): boolean {
  e.preventDefault();
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return false;
  const range = sel.getRangeAt(0);

  /* 1. Пустой пункт — выход из списка: li → p, пустой ul/ol удалить */
  const text = (li.textContent || '').trim();
  if (!text) {
    const list = li.parentElement as HTMLElement;
    const p = document.createElement('p');
    p.appendChild(document.createElement('br'));
    li.replaceWith(p);
    if (list && (list.tagName === 'UL' || list.tagName === 'OL') && !list.querySelector('li')) {
      /* список опустел — разворачиваем, наш абзац остаётся на его месте */
      const parent = list.parentElement;
      if (parent) parent.insertBefore(p, list.nextSibling);
      list.remove();
    }
    placeCaretAtStart(p);
    return true;
  }

  /* 2. Продолжение: контент ПОСЛЕ каретки уезжает в новый li с тем же маркером */
  const isTask = li.classList.contains('mdtask');

  /* диапазон от каретки до конца «своего» содержимого li (вложенные списки
     не трогаем — они остаются в исходном пункте) */
  const tail = document.createRange();
  const inner = li.querySelector(':scope > ul, :scope > ol');
  tail.setStart(range.startContainer, range.startOffset);
  if (inner) tail.setEndBefore(inner); else tail.setEndAfter(li.lastChild as Node);
  const frag = tail.extractContents();

  const nli = document.createElement('li');
  if (isTask) {
    nli.className = 'mdtask';
    nli.dataset.on = '0';
    const nchk = document.createElement('span');
    nchk.className = 'mdchk';
    nchk.setAttribute('aria-hidden', 'true');
    nchk.contentEditable = 'false';
    nli.appendChild(nchk);
  }
  nli.appendChild(frag);

  /* вложенный список внутри li стоит ПОСЛЕ текста: новый пункт вставляем
     перед ним, если хвост был до вложенного списка */
  if (inner) li.insertBefore(nli, inner); else li.after(nli);

  /* каретка ПОСЛЕ чекбокса нового пункта (не перед ним — иначе текст
     печатается «перед квадратиком» и не двигается) */
  placeCaretAfterMarker(nli);
  return true;
}

/* ── подпункты: Tab — вложенный список, Shift+Tab — уровень вверх ── */
function indentList(li: HTMLElement): boolean {
  const prev = li.previousElementSibling;
  if (!prev || prev.tagName !== 'LI') return false;
  let sub = prev.querySelector(':scope > ul, :scope > ol') as HTMLElement | null;
  if (!sub) {
    sub = document.createElement('ul');
    prev.appendChild(sub);
  }
  sub.appendChild(li);
  return true;
}

function outdentList(li: HTMLElement): boolean {
  const sub = li.parentElement;
  if (!sub || (sub.tagName !== 'UL' && sub.tagName !== 'OL')) return false;
  const parentLi = sub.parentElement;
  if (!parentLi || parentLi.tagName !== 'LI') return false;
  const list = parentLi.parentElement as HTMLElement;
  if (!list) return false;
  /* хвост родительского пункта после вложенного списка уезжает вместе с поднятным */
  let after: Node | null = sub.nextSibling;
  const moved: Node[] = [];
  while (after) { moved.push(after); after = after.nextSibling; }
  list.insertBefore(li, parentLi.nextSibling);
  for (const n of moved) li.appendChild(n);
  if (!sub.querySelector('li')) sub.remove();
  return true;
}

/* ── цитата: РУЧНОЙ переключатель (не execCommand) — Chromium обёртывает
   p в blockquote ВНУТРЬ, а нам нужна та же структура, что в отрисовке:
   <blockquote><p>текст</p></blockquote>. В блоке кода и списках цитата
   не применяется (там она ломает структуру). ── */
function toggleQuote(box: HTMLElement): void {
  const el = blockOfCaret(box);
  if (!el) { document.execCommand('formatBlock', false, 'blockquote'); return; }
  /* в блоке кода и в списках цитату не надеваем/не снимаем */
  if (el.tagName === 'PRE' || el.tagName === 'LI' || el.closest('pre') || el.closest('li')) return;
  const bq = (el.tagName === 'BLOCKQUOTE' ? el : el.closest('blockquote')) as HTMLElement | null;
  if (bq && box.contains(bq)) {
    /* снять цитату: содержимое blockquote — наружу перед ним */
    const frag = document.createDocumentFragment();
    while (bq.firstChild) frag.appendChild(bq.firstChild);
    bq.parentNode?.insertBefore(frag, bq);
    bq.remove();
    const first = frag.firstChild;
    if (first) {
      const sel = window.getSelection();
      if (sel) {
        const r = document.createRange();
        r.setStart(first, 0);
        r.collapse(true);
        sel.removeAllRanges();
        sel.addRange(r);
      }
    }
    return;
  }
  /* надеть цитату: текущий блок становится <p> внутри blockquote */
  const nbq = document.createElement('blockquote');
  const p = document.createElement('p');
  while (el.firstChild) p.appendChild(el.firstChild);
  el.replaceWith(nbq);
  nbq.appendChild(p);
  placeCaretAtStart(p);
}

/* ── чек-пункт ↔ обычная строка ── */
function toggleTask(box: HTMLElement, selected: string, escapeHtml: (s: string) => string): void {
  const el = blockOfCaret(box);
  /* в блоке кода чек-пункты не применяются */
  if (el && (el.tagName === 'PRE' || el.closest('pre'))) return;
  const li = el ? (el.tagName === 'LI' ? el : (el.closest('li') as HTMLElement | null)) : null;
  if (li && box.contains(li)) {
    if (li.classList.contains('mdtask')) {
      /* выключить: li → p с тем же текстом; опустевший список развернуть */
      const text = li.textContent || '';
      const p = document.createElement('p');
      if (text) p.textContent = text; else p.appendChild(document.createElement('br'));
      const list = li.parentElement as HTMLElement;
      li.replaceWith(p);
      if (list && (list.tagName === 'UL' || list.tagName === 'OL') && !list.querySelector('li')) {
        const parent = list.parentElement;
        if (parent) parent.insertBefore(p, list.nextSibling);
        list.remove();
      }
      placeCaretAtStart(p);
    } else {
      /* обычный пункт списка → чек-лист */
      li.classList.add('mdtask');
      li.dataset.on = '0';
      const nchk = document.createElement('span');
      nchk.className = 'mdchk';
      nchk.setAttribute('aria-hidden', 'true');
      nchk.contentEditable = 'false';
      li.insertBefore(nchk, li.firstChild);
      placeCaretAfterMarker(li);
    }
    return;
  }
  /* нет списка: превратить текущий блок (или вставить новый список) */
  const ul = document.createElement('ul');
  const nli = document.createElement('li');
  nli.className = 'mdtask';
  nli.dataset.on = '0';
  const nchk = document.createElement('span');
  nchk.className = 'mdchk';
  nchk.setAttribute('aria-hidden', 'true');
  nchk.contentEditable = 'false';
  nli.appendChild(nchk);
  nli.appendChild(document.createTextNode(selected || 'пункт'));
  ul.appendChild(nli);
  if (el && (el.tagName === 'P' || el.tagName === 'DIV' || /^H[1-6]$/.test(el.tagName))) el.replaceWith(ul);
  else document.execCommand('insertHTML', false, '<ul><li class="mdtask"><span class="mdchk" contenteditable="false"></span><span>' + escapeHtml(selected || 'пункт') + '</span></li></ul>');
}

/* ── инлайновый код: повторный клик снимает разметку ── */
function toggleInlineCode(box: HTMLElement, selected: string, escapeHtml: (s: string) => string): void {
  /* внутри блока кода инлайновый <code> не нужен */
  const cur = blockOfCaret(box);
  if (cur && (cur.tagName === 'PRE' || cur.closest('pre'))) return;
  const c = inlineCodeOf(box);
  if (c) {
    const text = document.createTextNode(c.textContent || '');
    const next = c.nextSibling;
    c.replaceWith(text);
    const sel = window.getSelection();
    if (sel) {
      const r = document.createRange();
      if (next) r.setStartBefore(next); else r.setStartAfter(text);
      r.collapse(true);
      sel.removeAllRanges();
      sel.addRange(r);
    }
  } else if (selected) {
    document.execCommand('insertHTML', false, '<code>' + escapeHtml(selected) + '</code>');
  } else {
    document.execCommand('insertHTML', false, '<code>код</code>');
  }
}

/* ── блок кода ↔ абзац (перенос строк внутри сохраняется) ── */
function toggleCodeBlock(box: HTMLElement, selected: string, escapeHtml: (s: string) => string): void {
  const el = blockOfCaret(box);
  const pre = (el ? (el.tagName === 'PRE' ? el : (el.closest('pre') as HTMLElement | null)) : null);
  if (pre && box.contains(pre)) {
    /* снять: pre → p, строки кода через <br> */
    const code = pre.querySelector('code') || pre;
    const lines = (code.textContent || '').split('\n');
    const p = document.createElement('p');
    lines.forEach((line, i) => {
      if (i) p.appendChild(document.createElement('br'));
      p.appendChild(document.createTextNode(line));
    });
    pre.replaceWith(p);
    placeCaretAtEnd(p);
    return;
  }
  /* надеть: заменяем текущий блок pre>code ВРУЧНУЮ — execCommand('insertHTML')
     в Chromium при каретке внутри абзаца растворяет pre в span со стилями;
     в списках блок кода не применяется. Блок сразу с языком (ts) — подсветка
     работает сразу, как в панели прототипа */
  if (el && el.tagName !== 'LI' && !el.closest('li')) {
    const text = (selected || el.textContent || '').trim() || '// код';
    const code = document.createElement('code');
    text.split('\n').forEach((line, i) => {
      if (i) code.appendChild(document.createElement('br'));
      code.appendChild(document.createTextNode(line));
    });
    const npre = document.createElement('pre');
    const langEl = document.createElement('span');
    langEl.className = 'lang';
    langEl.contentEditable = 'false';
    langEl.textContent = 'ts';
    npre.appendChild(langEl);
    npre.appendChild(code);
    el.replaceWith(npre);
    placeCaretAtEnd(code);
    return;
  }
  document.execCommand('insertHTML', false, '<pre><span class="lang" contenteditable="false">ts</span><code>' + escapeHtml(selected || '// код') + '</code></pre><p><br/></p>');
}

function execTool(box: HTMLElement, toolId: string, done: () => void): void {
  box.focus();
  const sel = window.getSelection();
  const selected = sel && !sel.isCollapsed ? sel.toString() : '';
  const escapeHtml = (s: string): string => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] || c));
  const insertHtml = (html: string): void => { document.execCommand('insertHTML', false, html); };
  const blockTag = (): string => {
    let el: HTMLElement | null = sel && sel.anchorNode ? (sel.anchorNode.nodeType === 1 ? sel.anchorNode as HTMLElement : sel.anchorNode.parentElement) : null;
    while (el && el !== box && !/^(H[1-6]|P|DIV|BLOCKQUOTE|LI|PRE)$/.test(el.tagName)) el = el.parentElement;
    return el && el !== box ? el.tagName : 'P';
  };
  switch (toolId) {
    case 'bold': document.execCommand('bold'); break;
    case 'italic': document.execCommand('italic'); break;
    case 'strike': document.execCommand('strikeThrough'); break;
    case 'heading': {
      const cur = blockTag();
      if (cur === 'PRE') break; /* заголовок внутри блока кода не применяется */
      document.execCommand('formatBlock', false, cur === 'H2' ? 'p' : 'h2');
      break;
    }
    case 'quote': toggleQuote(box); break;
    case 'ul': case 'ol': {
      /* списки внутри блока кода не применяются */
      if (blockTag() === 'PRE') break;
      document.execCommand(toolId === 'ul' ? 'insertUnorderedList' : 'insertOrderedList');
      break;
    }
    case 'task': toggleTask(box, selected, escapeHtml); break;
    case 'code': toggleInlineCode(box, selected, escapeHtml); break;
    case 'codeblock': toggleCodeBlock(box, selected, escapeHtml); break;
    case 'link': {
      if (selected) insertHtml('<a href="https://" target="_blank" rel="noopener noreferrer">' + escapeHtml(selected) + '</a>');
      else insertHtml('<a href="https://" target="_blank" rel="noopener noreferrer">текст ссылки</a>');
      break;
    }
    case 'image': {
      insertHtml('<img src="https://" alt="описание" /><p><br/></p>');
      break;
    }
    case 'table': {
      insertHtml('<table><thead><tr><th>Колонка</th><th>Значение</th></tr></thead><tbody><tr><td>строка</td><td>данные</td></tr></tbody></table><p><br/></p>');
      break;
    }
    case 'hr': {
      document.execCommand('insertHorizontalRule');
      break;
    }
    default: break;
  }
  /* нормализуем: чекбоксы служебные, li.mdtask без чекбокса получает его */
  normalizeWidgets(box);
  done();
}
