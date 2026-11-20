'use client';

/**
 * Живой WYSIWYG-редактор Markdown (одно окно, результат виден сразу):
 * contenteditable с отрисованным Markdown внутри; на каждый ввод содержимое
 * сериализуется обратно в Markdown-исходник (mdHtmlToSource) и отдаётся
 * родителю на автосохранение. Никаких режимов «правка/сплит/просмотр» —
 * печатаем и сразу видим жирный/списки/чекбоксы как в режиме просмотра.
 *
 * Инструменты — document.execCommand (formatBlock/списки/стиль) + вставка
 * HTML для блоков кода, таблиц, ссылок и картинок. Enter внутри списков
 * браузер продолжает САМ (баг «Enter не переносит строку» исчез по определению),
 * чекбоксы кликабельны прямо в тексте (contenteditable=false на квадратике).
 * Вставка из буфера — только простой текст (чужая разметка не протекает).
 */

import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';

import { mdHtmlToSource, mdToHtml } from './md';

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
  ariaLabel?: string;
}

export const MdWysiwyg = forwardRef<MdWysiwygHandle, Props>(function MdWysiwyg(props, ref) {
  const boxRef = useRef<HTMLDivElement>(null);
  const mountedRef = useRef(false);
  const emitted = useRef<string>(props.value);
  const composing = useRef(false);
  const { onChange, onEnter } = props;
  const cbRef = useRef({ onChange, onEnter });
  useEffect(() => { cbRef.current = { onChange, onEnter }; });

  /* монтируем содержимое РОВНО ОДИН раз (стабильный ref-объект — иначе React
     при каждом рендере вызывает колбэк-реф заново и сбрасывает innerHTML,
     ломая каретку и ввод — тот самый баг «обратного» текста) */
  useEffect(() => {
    const box = boxRef.current;
    if (!box || mountedRef.current) return;
    mountedRef.current = true;
    box.innerHTML = mdToHtml(props.value || '');
    emitted.current = props.value;
    prepWidgets(box);
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
      prepWidgets(box);
      syncEmpty(box);
      if (props.autoGrow) growTo(box, props.maxGrow ?? 120);
    }
  }, [props.value, props.autoGrow, props.maxGrow]);

  const emit = (): void => {
    const box = boxRef.current;
    if (!box) return;
    const md = mdHtmlToSource(box);
    emitted.current = md;
    syncEmpty(box);
    if (props.autoGrow) growTo(box, props.maxGrow ?? 120);
    cbRef.current.onChange(md);
  };

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
      onBlur={() => emit()}
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
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !e.shiftKey && props.onEnter && !e.ctrlKey && !e.metaKey) {
          e.preventDefault();
          props.onEnter();
          return;
        }
        /* Ctrl+B / Ctrl+I / Ctrl+K — как в прототипе */
        const mod = e.ctrlKey || e.metaKey;
        if (mod && ['b', 'i', 'k'].includes(e.key.toLowerCase())) {
          e.preventDefault();
          execTool(boxRef.current!, e.key.toLowerCase() === 'b' ? 'bold' : e.key.toLowerCase() === 'i' ? 'italic' : 'link', () => emit());
        }
      }}
    />
  );
});

/* чекбоксы и язык кода — служебные виджеты: их нельзя править текстом */
function prepWidgets(box: HTMLElement): void {
  box.querySelectorAll<HTMLElement>('.mdchk').forEach((c) => { c.contentEditable = 'false'; });
  box.querySelectorAll<HTMLElement>('.lang').forEach((c) => { c.contentEditable = 'false'; });
}

function syncEmpty(box: HTMLElement): void {
  const empty = !box.textContent?.trim() && !box.querySelector('img');
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

/* автовысота: поле растёт по содержимому до потолка maxGrow */
function growTo(box: HTMLDivElement, max: number): void {
  box.style.height = 'auto';
  const h = Math.min(box.scrollHeight, max);
  box.style.height = Math.max(h, 38) + 'px';
  box.style.overflowY = box.scrollHeight > max ? 'auto' : 'hidden';
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
      document.execCommand('formatBlock', false, cur === 'H2' ? 'p' : 'h2');
      break;
    }
    case 'quote': {
      const cur = blockTag();
      document.execCommand('formatBlock', false, cur === 'BLOCKQUOTE' ? 'p' : 'blockquote');
      break;
    }
    case 'ul': document.execCommand('insertUnorderedList'); break;
    case 'ol': document.execCommand('insertOrderedList'); break;
    case 'task': {
      /* строка внутри чек-листа → убрать маркер; иначе вставить чек-лист */
      let el: HTMLElement | null = sel && sel.anchorNode ? (sel.anchorNode.nodeType === 1 ? sel.anchorNode as HTMLElement : sel.anchorNode.parentElement) : null;
      let li: HTMLElement | null = null;
      while (el && el !== box) { if (el.tagName === 'LI' && el.classList.contains('mdtask')) { li = el; break; } if (el.tagName === 'LI') break; el = el.parentElement; }
      if (li) {
        const text = li.textContent || '';
        const p = document.createElement('p');
        p.textContent = text;
        li.replaceWith(p);
      } else {
        insertHtml('<ul><li class="mdtask"><span class="mdchk" contenteditable="false"></span><span>' + escapeHtml(selected || 'пункт') + '</span></li></ul>');
      }
      break;
    }
    case 'code': {
      if (selected) insertHtml('<code>' + escapeHtml(selected) + '</code>');
      else insertHtml('<code>код</code>');
      break;
    }
    case 'codeblock': {
      insertHtml('<pre><code>' + escapeHtml(selected || '// код') + '</code></pre><p><br/></p>');
      break;
    }
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
  /* нормализуем: пустые контейнеры с краской ввода могли остаться */
  box.querySelectorAll('.mdchk').forEach((c) => { (c as HTMLElement).contentEditable = 'false'; });
  done();
}
