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
 * ПЕРЕД квадратиком — браузер ставил каретку в начало li). Каретка в начале
 * пункта — новый пустой пункт ВЫШЕ. Пустой пункт закрывает список.
 * Tab/Shift+Tab — подпункты. Чекбоксы кликабельны прямо в тексте
 * (contenteditable=false на квадратике). Вставка — только текст.
 *
 * ПАНЕЛЬ: активные кнопки подсвечиваются (onActiveChange — состояние под
 * кареткой/выделением: жирный/курсив/зачёркнутый/заголовок/цитата/списки/
 * чек-лист/код/блок кода), повторный клик снимает форматирование.
 * «Код в строке» без выделения вставляет плейсхолдер и ВЫДЕЛЯЕТ его — первый
 * ввод заменяет слово «код».
 *
 * Enter в блоке кода — перенос строки (<br>, сериализуется в \n), поэтому
 * набранный код сохраняется; ПОСЛЕ цитаты и блока кода редактор добавляет
 * пустую строку — клик в неё выводит из форматирования; Enter на пустой
 * строке цитаты тоже выводит.
 *
 * СВОЙ СТЕК ОТМЕНЫ (Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z): браузерный undo рвался
 * от ручных операций с DOM (чек-листы, цитаты, блок кода). Каждый ввод и
 * каждый инструмент кладут снимок markdown в стек; Ctrl+Z/Ctrl+Y
 * восстанавливают содержимое целиком — и текст, и форматирование.
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
  /* свой стек отмены: снимки markdown до правки (+ группировка пачек ввода) */
  const undoRef = useRef<string[]>([]);
  const redoRef = useRef<string[]>([]);
  const lastSnap = useRef({ t: 0, text: false });
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

  /* ── свой undo/redo ── */

  /** Снимок ТЕКУЩЕГО содержимого в стек отмены (вызывать ДО мутации DOM).
   *  textEdit=true — пачка однотипного ввода склеивается в один шаг отмены. */
  const pushUndo = (textEdit: boolean): void => {
    const box = boxRef.current;
    if (!box) return;
    const now = Date.now();
    if (textEdit && lastSnap.current.text && now - lastSnap.current.t < 700) {
      lastSnap.current.t = now;
      return;
    }
    const md = mdHtmlToSource(box);
    if (undoRef.current.length && undoRef.current[undoRef.current.length - 1] === md) return;
    undoRef.current.push(md);
    if (undoRef.current.length > 300) undoRef.current.shift();
    redoRef.current = [];
    lastSnap.current = { t: now, text: textEdit };
  };

  /** Отменённое действие ничего не изменило — снять лишний снимок со стека. */
  const dropRedundantUndo = (): void => {
    const box = boxRef.current;
    if (!box || !undoRef.current.length) return;
    const before = undoRef.current[undoRef.current.length - 1];
    if (mdHtmlToSource(box) === before) {
      undoRef.current.pop();
      lastSnap.current = { t: 0, text: false };
    }
  };

  const restore = (md: string): void => {
    const box = boxRef.current;
    if (!box) return;
    box.innerHTML = mdToHtml(md);
    normalizeWidgets(box);
    refreshHighlight(box, null);
    syncEmpty(box);
    emitted.current = md;
    if (props.autoGrow) growTo(box, props.maxGrow ?? 120);
    placeCaretAtEnd(box);
    reportActive();
    cbRef.current.onChange(md);
  };

  const doUndo = (): void => {
    const box = boxRef.current;
    if (!box || !undoRef.current.length) return;
    redoRef.current.push(mdHtmlToSource(box));
    const prev = undoRef.current.pop() as string;
    lastSnap.current = { t: 0, text: false };
    restore(prev);
  };

  const doRedo = (): void => {
    const box = boxRef.current;
    if (!box || !redoRef.current.length) return;
    undoRef.current.push(mdHtmlToSource(box));
    const next = redoRef.current.pop() as string;
    lastSnap.current = { t: 0, text: false };
    restore(next);
  };

  /** Инструмент панели/хоткей: снимок в стек → применить → снять лишний. */
  const execWithUndo = (toolId: string): void => {
    const box = boxRef.current;
    if (!box || props.disabled) return;
    pushUndo(false);
    execTool(box, toolId, () => emit());
    dropRedundantUndo();
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
      execWithUndo(toolId);
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
        /* вставка только текстом — чужой HTML ломает наш рендер;
           вставка = отдельный шаг отмены (рвём группировку пачки ввода) */
        e.preventDefault();
        lastSnap.current = { t: 0, text: false };
        const text = e.clipboardData.getData('text/plain');
        document.execCommand('insertText', false, text);
      }}
      onClick={(e) => {
        const t = (e.target as HTMLElement).closest?.('.mdchk') as HTMLElement | null;
        if (!t || props.disabled) return;
        e.preventDefault();
        pushUndo(false);
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
        const mod = e.ctrlKey || e.metaKey;
        /* свой undo/redo: браузерный рвался от ручных операций с DOM */
        if (mod && e.key.toLowerCase() === 'z') {
          e.preventDefault();
          e.stopPropagation();
          if (e.shiftKey) doRedo(); else doUndo();
          return;
        }
        if (mod && e.key.toLowerCase() === 'y') {
          e.preventDefault();
          e.stopPropagation();
          doRedo();
          return;
        }
        if (e.key === 'Enter' && !e.shiftKey && props.onEnter && !mod) {
          e.preventDefault();
          props.onEnter();
          return;
        }
        const box = boxRef.current;
        /* Ctrl+B / Ctrl+I / Ctrl+K — как в прототипе */
        if (mod && ['b', 'i', 'k'].includes(e.key.toLowerCase())) {
          e.preventDefault();
          execWithUndo(e.key.toLowerCase() === 'b' ? 'bold' : e.key.toLowerCase() === 'i' ? 'italic' : 'link');
          return;
        }
        if (!box || props.disabled) return;
        if (e.key === 'Enter' && !e.shiftKey && !mod) {
          /* Enter в блоке кода — перенос строки (<br>): код сохраняется,
             выход — пустая строка после блока или кнопка «Блок кода» */
          if (preOfCaret(box)) {
            e.preventDefault();
            pushUndo(false);
            insertBrAtCaret();
            emit();
            return;
          }
          /* Enter на пустой строке цитаты — выход из цитаты */
          const bq = quoteOfCaret(box);
          if (bq) {
            pushUndo(false);
            if (enterInQuote(box, bq, e)) { emit(); return; }
            dropRedundantUndo();
          }
          /* Enter внутри списка — свой обработчик: чек-лист продолжается
             ЧЕКБОКСОМ, каретка ПОСЛЕ него (браузер рвал структуру и оставлял
             «обычную строку», текст попадал перед квадратиком) */
          const li = liOfCaret(box);
          if (li) {
            pushUndo(false);
            if (enterInList(box, li, e)) { emit(); return; }
            dropRedundantUndo();
          }
        }
        /* Tab / Shift+Tab — подпункты списков (indent/outdent) */
        if (e.key === 'Tab') {
          const li = liOfCaret(box);
          if (li) {
            pushUndo(false);
            if (e.shiftKey ? outdentList(li) : indentList(li)) {
              e.preventDefault();
              emit();
              return;
            }
            dropRedundantUndo();
          }
        }
      }}
      onBeforeInput={(ev) => {
        /* снимок ДО правки в стек отмены; пачки ввода текста склеиваются */
        if (composing.current || props.disabled) return;
        const it = (ev.nativeEvent as InputEvent).inputType || '';
        const textEdit = !it || it.startsWith('insert') || it.startsWith('delete');
        pushUndo(textEdit);
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

/* блок кода (pre), в котором стоит каретка (или null) */
function preOfCaret(box: HTMLElement): HTMLElement | null {
  const sel = window.getSelection();
  if (!sel || !sel.anchorNode || !box.contains(sel.anchorNode)) return null;
  let el: HTMLElement | null = sel.anchorNode.nodeType === 1 ? sel.anchorNode as HTMLElement : sel.anchorNode.parentElement;
  while (el && el !== box) {
    if (el.tagName === 'PRE') return el;
    el = el.parentElement;
  }
  return null;
}

/* цитата (blockquote), в которой стоит каретка (или null) */
function quoteOfCaret(box: HTMLElement): HTMLElement | null {
  const sel = window.getSelection();
  if (!sel || !sel.anchorNode || !box.contains(sel.anchorNode)) return null;
  let el: HTMLElement | null = sel.anchorNode.nodeType === 1 ? sel.anchorNode as HTMLElement : sel.anchorNode.parentElement;
  while (el && el !== box) {
    if (el.tagName === 'BLOCKQUOTE') return el;
    el = el.parentElement;
  }
  return null;
}

/* <br> в позиции каретки (перенос строки в блоке кода).
   Если br оказался последним узлом — Chromium считает его «пустой последней
   строкой» и ввод попадает ПЕРЕД ним; добавляем второй br-плейсхолдер, чтобы
   новая строка была настоящей и текст печатался на ней. */
function insertBrAtCaret(): void {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return;
  const r = sel.getRangeAt(0);
  r.deleteContents();
  const br = document.createElement('br');
  r.insertNode(br);
  if (!br.nextSibling) {
    const ph = document.createElement('br');
    br.parentNode?.appendChild(ph);
  }
  r.setStartAfter(br);
  r.collapse(true);
  sel.removeAllRanges();
  sel.addRange(r);
}

/** Пустой абзац ПОСЛЕ блока (цитаты/кода): есть — вернуть, нет — создать.
 *  Клик в эту строку выводит из форматирования (жалоба: «нельзя выйти»). */
function ensureEmptyParagraphAfter(el: HTMLElement): HTMLElement {
  const next = el.nextElementSibling;
  if (next && next.tagName === 'P' && !(next.textContent || '').trim() && !next.querySelector('img')) {
    return next as HTMLElement;
  }
  const p = document.createElement('p');
  p.appendChild(document.createElement('br'));
  el.parentNode?.insertBefore(p, el.nextSibling);
  return p;
}

/* Enter на пустой строке цитаты: удалить её и выйти — каретка в абзац
   после цитаты (или в новый пустой абзац). Непустую строку браузер
   продолжает сам (новый <p> внутри blockquote). */
function enterInQuote(box: HTMLElement, bq: HTMLElement, e: { preventDefault: () => void }): boolean {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return false;
  const range = sel.getRangeAt(0);
  let p = range.startContainer.nodeType === 1 ? range.startContainer as HTMLElement : range.startContainer.parentElement;
  while (p && p.parentElement !== bq) p = p.parentElement;
  if (!p || !bq.contains(p) || p.tagName !== 'P') return false;
  if ((p.textContent || '').replace('\u200b', '').trim()) return false;
  e.preventDefault();
  p.remove();
  if (!bq.querySelector('p')) {
    /* цитата опустела — убрать её вовсе */
    const after = document.createElement('p');
    after.appendChild(document.createElement('br'));
    bq.replaceWith(after);
    placeCaretAtStart(after);
    return true;
  }
  const next = ensureEmptyParagraphAfter(bq);
  placeCaretAtStart(next);
  return true;
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

  const isTask = li.classList.contains('mdtask');

  /* 2. Каретка в НАЧАЛЕ пункта — новый пустой пункт ВЫШЕ (текст остаётся,
     как в обычных редакторах), каретка — в новом пункте после маркера */
  const chkEl = li.querySelector(':scope > .mdchk');
  const probe = document.createRange();
  if (chkEl) probe.setStartAfter(chkEl); else probe.setStart(li, 0);
  probe.setEnd(range.startContainer, range.startOffset);
  const beforeLen = probe.toString().length + probe.cloneContents().querySelectorAll('img').length;
  if (range.collapsed && beforeLen === 0) {
    const nli = document.createElement('li');
    if (isTask) {
      nli.className = 'mdtask';
      nli.dataset.on = '0';
      const nchk = document.createElement('span');
      nchk.className = 'mdchk';
      nchk.setAttribute('aria-hidden', 'true');
      nchk.contentEditable = 'false';
      nli.appendChild(nchk);
    } else {
      nli.appendChild(document.createElement('br'));
    }
    li.parentNode?.insertBefore(nli, li);
    if (isTask) placeCaretAfterMarker(nli); else placeCaretAtStart(nli);
    return true;
  }

  /* 3. Продолжение: контент ПОСЛЕ каретки уезжает в новый li с тем же маркером */

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
   не применяется (там она ломает структуру). После включения добавляем
   пустую строку после цитаты — клик в неё выводит из форматирования. ── */
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
  ensureEmptyParagraphAfter(nbq);
}

/* ── чек-пункт ↔ обычная строка ── */
function toggleTask(box: HTMLElement, selected: string): void {
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
  /* нет списка: превратить текущий блок (или вставить новый список);
     КАРЕТКА — после чекбокса (иначе текст печатается перед квадратиком) */
  const ul = document.createElement('ul');
  const nli = document.createElement('li');
  nli.className = 'mdtask';
  nli.dataset.on = '0';
  const nchk = document.createElement('span');
  nchk.className = 'mdchk';
  nchk.setAttribute('aria-hidden', 'true');
  nchk.contentEditable = 'false';
  nli.appendChild(nchk);
  /* пункт создаётся из блока с текстом — текст сохраняется (не теряем абзац) */
  nli.appendChild(document.createTextNode(selected || (el ? el.textContent || '' : '')));
  ul.appendChild(nli);
  if (el && (el.tagName === 'P' || el.tagName === 'DIV' || /^H[1-6]$/.test(el.tagName))) {
    el.replaceWith(ul);
  } else {
    document.execCommand('insertHTML', false, '<ul><li class="mdtask"><span class="mdchk" contenteditable="false"></span></li></ul>');
  }
  const placed = liOfCaret(box);
  if (placed && placed.classList.contains('mdtask')) placeCaretAfterMarker(placed);
  else placeCaretAtStart(nli);
}

/* ── инлайновый код: повторный клик снимает разметку; без выделения
   вставляем плейсхолдер «код» и ВЫДЕЛЯЕМ его — первый ввод заменяет ── */
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
    /* ВРУЧНУЮ (не execCommand('insertHTML')): Chromium у каретки после стили
       превращает <code> в span со стилями — тот самый «жёлтый блок» */
    const s = window.getSelection();
    if (s && s.rangeCount) {
      const r = s.getRangeAt(0);
      r.deleteContents();
      const code = document.createElement('code');
      code.textContent = selected;
      r.insertNode(code);
      r.setStartAfter(code);
      r.collapse(true);
      s.removeAllRanges();
      s.addRange(r);
    }
  } else {
    /* плейсхолдер «код» — тоже вручную; выделяем его, ввод сразу заменяет */
    const s = window.getSelection();
    if (s && s.rangeCount) {
      const r = s.getRangeAt(0);
      r.deleteContents();
      const code = document.createElement('code');
      code.textContent = 'код';
      r.insertNode(code);
      const sr = document.createRange();
      sr.selectNodeContents(code);
      s.removeAllRanges();
      s.addRange(sr);
    }
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
    /* пустая строка после блока — клик в неё выводит из кода */
    ensureEmptyParagraphAfter(npre);
    placeCaretAtEnd(code);
    return;
  }
  document.execCommand('insertHTML', false, '<pre><span class="lang" contenteditable="false">ts</span><code>' + escapeHtml(selected || '// код') + '</code></pre><p><br/></p>');
}

/* каретка СТОИТ внутри инлайн-формата (жирный/курсив/зачёркнутый) — вернуть
   элемент; для выключения по клику панели без выделения выделяем весь кусок */
function inlineWrapOfCaret(box: HTMLElement, tags: string[]): HTMLElement | null {
  const sel = window.getSelection();
  if (!sel || !sel.anchorNode || !box.contains(sel.anchorNode)) return null;
  let el: HTMLElement | null = sel.anchorNode.nodeType === 1 ? sel.anchorNode as HTMLElement : sel.anchorNode.parentElement;
  for (let n = el; n && n !== box; n = n.parentElement) {
    if (tags.includes(n.tagName)) return n;
  }
  return null;
}

/** Выделить инлайн-формат под СВЁРНУТОЙ кареткой (для toggle-выключения).
 *  Возвращает true, если выделение было расширено. */
function expandCollapsedInline(box: HTMLElement, tags: string[]): boolean {
  const sel = window.getSelection();
  if (!sel || !sel.isCollapsed) return false;
  const wrap = inlineWrapOfCaret(box, tags);
  if (!wrap || !box.contains(wrap)) return false;
  const r = document.createRange();
  r.selectNodeContents(wrap);
  sel.removeAllRanges();
  sel.addRange(r);
  return true;
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
    case 'bold':
      /* каретка внутри жирного без выделения — выделяем кусок: клик снимет формат */
      if (sel && sel.isCollapsed) expandCollapsedInline(box, ['STRONG', 'B']);
      document.execCommand('bold'); break;
    case 'italic':
      if (sel && sel.isCollapsed) expandCollapsedInline(box, ['EM', 'I']);
      document.execCommand('italic'); break;
    case 'strike':
      if (sel && sel.isCollapsed) expandCollapsedInline(box, ['DEL', 'S', 'STRIKE']);
      document.execCommand('strikeThrough'); break;
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
    case 'task': toggleTask(box, selected); break;
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
