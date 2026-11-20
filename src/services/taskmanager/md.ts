'use client';

/**
 * Менеджер задач — Markdown для описаний и комментариев (порт прототипа
 * «Поток»): заголовки, списки (обычные, нумерованные, чек-листы), цитаты,
 * блоки кода, таблицы, разделители; инлайн — **жирный**, *курсив*, `код`,
 * ~~зачёркнутый~~, [ссылки](url) и картинки. HTML экранируется ВСЕГДА —
 * в разметку попадает только наш сгенерированный HTML, URL проходят
 * whitelist (http/https/mailto/относительные).
 */

const esc = (s: string): string => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c] || c));

const safeUrl = (u: string): boolean => /^(https?:\/\/|mailto:|\/|#)/i.test(u);

function mdInline(s: string): string {
  let o = s.replace(/`([^`]+)`/g, (_m, c: string) => '<code>' + c + '</code>');
  o = o.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_m, a: string, u: string) => safeUrl(u) ? '<img src="' + u + '" alt="' + a + '" loading="lazy">' : a);
  o = o.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, t: string, u: string) => safeUrl(u) ? '<a href="' + u + '" target="_blank" rel="noopener noreferrer">' + t + '</a>' : t);
  o = o.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/__([^_]+)__/g, '<strong>$1</strong>');
  o = o.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  o = o.replace(/(^|[^*\w])\*([^*\n]+)\*/g, '$1<em>$2</em>').replace(/(^|[^_\w])_([^_\n]+)_/g, '$1<em>$2</em>');
  return o;
}

const LI_RE = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;

function buildList(items: { indent: number; ordered: boolean; text: string; checked: boolean | null }[], pos: number, ind: number): [string, number] {
  const ordered = items[pos].ordered;
  let h = ordered ? '<ol>' : '<ul>';
  while (pos < items.length && items[pos].indent >= ind) {
    if (items[pos].indent > ind) {
      const r = buildList(items, pos, items[pos].indent);
      h = h.replace(/<\/li>$/, '') + r[0] + '</li>';
      pos = r[1];
      continue;
    }
    if (items[pos].ordered !== ordered) break;
    const it = items[pos];
    h += '<li' + (it.checked !== null ? ' class="mdtask"' : '') + '>'
      + (it.checked !== null ? '<span class="mdchk' + (it.checked ? ' on' : '') + '" aria-hidden="true"></span><span>' + mdInline(esc(it.text)) + '</span>' : mdInline(esc(it.text)))
      + '</li>';
    pos++;
  }
  return [h + (ordered ? '</ol>' : '</ul>'), pos];
}

export function mdToHtml(src: string): string {
  const lines = String(src || '').replace(/\r\n/g, '\n').split('\n');
  let out = '', i = 0;
  const isBlock = (l: string) => LI_RE.test(l) || /^\s*```/.test(l) || /^\s*#{1,6}\s/.test(l) || /^\s*>/.test(l) || /^\s*(-{3,}|\*{3,})\s*$/.test(l);
  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      const lang = line.trim().slice(3).trim();
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) { buf.push(lines[i]); i++; }
      i++;
      out += '<pre>' + (lang ? '<span class="lang">' + esc(lang) + '</span>' : '') + '<code>' + esc(buf.join('\n')) + '</code></pre>';
      continue;
    }
    if (/^\s*$/.test(line)) { i++; continue; }
    const h = line.match(/^\s*(#{1,6})\s+(.*)$/);
    if (h) { out += '<h' + h[1].length + '>' + mdInline(esc(h[2])) + '</h' + h[1].length + '>'; i++; continue; }
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) { out += '<hr>'; i++; continue; }
    if (/^\s*>/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) { buf.push(lines[i].replace(/^\s*>\s?/, '')); i++; }
      out += '<blockquote>' + mdToHtml(buf.join('\n')) + '</blockquote>';
      continue;
    }
    if (line.includes('|') && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1])) {
      const cells = (r: string) => r.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());
      const head = cells(line);
      i += 2;
      let body = '';
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
        body += '<tr>' + cells(lines[i]).map((c) => '<td>' + mdInline(esc(c)) + '</td>').join('') + '</tr>';
        i++;
      }
      out += '<table><thead><tr>' + head.map((c) => '<th>' + mdInline(esc(c)) + '</th>').join('') + '</tr></thead><tbody>' + body + '</tbody></table>';
      continue;
    }
    if (LI_RE.test(line)) {
      const items: { indent: number; ordered: boolean; text: string; checked: boolean | null }[] = [];
      while (i < lines.length && LI_RE.test(lines[i])) {
        const m = lines[i].match(LI_RE);
        if (!m) break;
        let txt = m[3];
        let checked: boolean | null = null;
        const cm = txt.match(/^\[([ xX])\]\s*(.*)$/);
        if (cm) { checked = cm[1].toLowerCase() === 'x'; txt = cm[2]; }
        items.push({ indent: m[1].replace(/\t/g, '  ').length, ordered: /\d/.test(m[2]), text: txt, checked });
        i++;
      }
      if (items.length) {
        const r = buildList(items, 0, items[0].indent);
        out += r[0];
      }
      continue;
    }
    const buf: string[] = [];
    while (i < lines.length && !/^\s*$/.test(lines[i]) && !isBlock(lines[i])) { buf.push(lines[i]); i++; }
    if (buf.length) out += '<p>' + mdInline(esc(buf.join('\n'))).replace(/\n/g, '<br>') + '</p>';
    else i++;
  }
  return out;
}

/** Плоский текст из markdown — для превью на карточках (как mdPlain прототипа). */
export function mdPlain(s: string): string {
  return String(s || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s*[-*+]\s+\[[ xX]\]\s*/gm, '')
    .replace(/[#>*_`~|]/g, ' ')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/* ═══ WYSIWYG: сериализация DOM редактора обратно в markdown ═══
   Редактор живой: пользователь видит отрисованный markdown и правит его.
   На каждый ввод содержимое contenteditable сериализуется в markdown-исходник
   (обратная сторона mdToHtml). HTML-экранирование не нужно — на выходе
   ИСХОДНИК, а не разметка; безопасный рендер гарантирует mdToHtml. */

function mdInlineSource(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent || '';
  if (node.nodeType !== Node.ELEMENT_NODE) return '';
  const el = node as HTMLElement;
  const tag = el.tagName;
  /* служебные элементы рендера — в исходник не попадают */
  if (el.classList.contains('mdchk') || el.classList.contains('lang')) return '';
  const inner = (): string => {
    let s = '';
    for (const c of Array.from(el.childNodes)) s += mdInlineSource(c);
    return s;
  };
  switch (tag) {
    case 'BR': return '\n';
    case 'STRONG': case 'B': {
      const t = inner();
      return t ? '**' + t.replace(/\*\*/g, '') + '**' : '';
    }
    case 'EM': case 'I': {
      const t = inner();
      return t ? '*' + t.replace(/^\*|\*$/g, '') + '*' : '';
    }
    case 'DEL': case 'S': {
      const t = inner();
      return t ? '~~' + t.replace(/~~/g, '') + '~~' : '';
    }
    case 'CODE': return '`' + (el.textContent || '').replace(/`/g, '') + '`';
    case 'A': {
      const t = inner();
      const href = el.getAttribute('href') || '';
      return t ? '[' + t + '](' + href + ')' : '';
    }
    case 'IMG': return '![' + (el.getAttribute('alt') || '') + '](' + (el.getAttribute('src') || '') + ')';
    case 'UL': case 'OL': {
      /* вложенный список внутри li — с отступом */
      return '\n' + mdListSource(el, 1).replace(/^\n/, '');
    }
    case 'BLOCKQUOTE': {
      const t = mdBlocksSource(el.childNodes);
      return t.split('\n').map((l) => '> ' + l).join('\n');
    }
    default: return inner();
  }
}

function mdListSource(list: HTMLElement, level: number): string {
  const ordered = list.tagName === 'OL';
  const items = Array.from(list.children).filter((c) => c.tagName === 'LI') as HTMLElement[];
  let out = '';
  let n = 1;
  for (const li of items) {
    const ind = '  '.repeat(level - 1);
    const isTask = li.classList.contains('mdtask');
    const chk = li.querySelector('.mdchk');
    const marker = isTask ? (chk && chk.classList.contains('on') ? '- [x] ' : '- [ ] ') : (ordered ? (n++) + '. ' : '- ');
    let line = '';
    for (const c of Array.from(li.childNodes)) {
      if (c.nodeType === Node.ELEMENT_NODE && (c as HTMLElement).tagName === 'UL') continue;
      if (c.nodeType === Node.ELEMENT_NODE && (c as HTMLElement).tagName === 'OL') continue;
      line += mdInlineSource(c);
    }
    let nested = '';
    for (const c of Array.from(li.children)) {
      if (c.tagName === 'UL' || c.tagName === 'OL') nested += (nested || line ? '\n' : '') + mdListSource(c as HTMLElement, level + 1);
    }
    out += (out ? '\n' : '') + ind + marker + line.replace(/\n/g, ' ').trim() + (nested ? '\n' + nested : '');
  }
  return out;
}

function mdBlocksSource(nodes: NodeList | Node[]): string {
  const chunks: string[] = [];
  for (const node of Array.from(nodes as Node[])) {
    if (node.nodeType === Node.TEXT_NODE) {
      const t = (node.textContent || '').trim();
      if (t) chunks.push(t);
      continue;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) continue;
    const el = node as HTMLElement;
    const tag = el.tagName;
    if (tag === 'UL' || tag === 'OL') { chunks.push(mdListSource(el, 1)); continue; }
    if (tag === 'HR') { chunks.push('---'); continue; }
    if (tag === 'PRE') {
      const code = el.querySelector('code') || el;
      chunks.push('```\n' + (code.textContent || '') + '\n```');
      continue;
    }
    if (tag === 'BLOCKQUOTE') {
      const t = mdBlocksSource(el.childNodes);
      chunks.push(t.split('\n').map((l) => (l ? '> ' + l : '>')).join('\n'));
      continue;
    }
    if (tag === 'TABLE') {
      const rows = Array.from(el.querySelectorAll('tr'));
      const cells = (tr: Element) => Array.from(tr.children).map((c) => (c.textContent || '').replace(/\|/g, '\\|').trim());
      const out: string[] = [];
      rows.forEach((tr, i) => {
        out.push('| ' + cells(tr).join(' | ') + ' |');
        if (i === 0) out.push('|' + cells(tr).map(() => ' --- ').join('|') + '|');
      });
      chunks.push(out.join('\n'));
      continue;
    }
    if (/^H[1-6]$/.test(tag)) {
      chunks.push('#'.repeat(parseInt(tag.slice(1), 10)) + ' ' + mdInlineSource(el).replace(/\n/g, ' ').trim());
      continue;
    }
    /* P / DIV / LI-в-воздухе: инлайн-содержимое */
    const t = mdInlineSource(el).replace(/\n\n+/g, '\n');
    if (t.trim()) chunks.push(t);
  }
  return chunks.filter((c) => c !== undefined).join('\n\n');
}

/** DOM contenteditable-редактора → markdown-исходник. */
export function mdHtmlToSource(root: HTMLElement): string {
  if (!root) return '';
  const src = mdBlocksSource(root.childNodes);
  return src.replace(/\n{3,}/g, '\n\n').trim();
}

/* ── инструменты редактора (панель над textarea) ──
   Группы с разделителями — как в прототипе «Поток»:
   жирный/курсив/зачёркнутый | заголовок/цитата | списки | код/блок/ссылка/картинка/таблица/разделитель */

export const MD_TOOLS: { id: string; title: string; icon: string; sep?: boolean }[] = [
  { id: 'bold', title: 'Жирный (Ctrl+B)', icon: 'bold' },
  { id: 'italic', title: 'Курсив (Ctrl+I)', icon: 'italic' },
  { id: 'strike', title: 'Зачёркнутый', icon: 'strike' },
  { id: 'heading', title: 'Заголовок', icon: 'heading', sep: true },
  { id: 'quote', title: 'Цитата', icon: 'quote' },
  { id: 'ul', title: 'Маркированный список', icon: 'list', sep: true },
  { id: 'ol', title: 'Нумерованный список', icon: 'list-ol' },
  { id: 'task', title: 'Чек-лист', icon: 'check-square' },
  { id: 'code', title: 'Код', icon: 'code', sep: true },
  { id: 'codeblock', title: 'Блок кода', icon: 'note' },
  { id: 'link', title: 'Ссылка (Ctrl+K)', icon: 'link' },
  { id: 'image', title: 'Картинка', icon: 'image' },
  { id: 'table', title: 'Таблица', icon: 'table' },
  { id: 'hr', title: 'Разделитель', icon: 'minus' },
];

/** Применить инструмент к textarea, вернуть НОВЫЙ текст (controlled-компоненты
    сами обновляют состояние; выделение восстанавливается, как в прототипе). */
export function mdApplyTool(area: HTMLTextAreaElement, tool: string): string {
  const s = area.selectionStart;
  const e = area.selectionEnd;
  const v = area.value;
  const sel = v.slice(s, e);
  let nv = v;
  const wrap = (a: string, b: string) => {
    nv = v.slice(0, s) + a + (sel || 'текст') + b + v.slice(e);
    const ns = s + a.length;
    requestAnimationFrame(() => area.setSelectionRange(ns, ns + (sel || 'текст').length));
  };
  const linePrefix = (pref: string) => {
    const ls = v.lastIndexOf('\n', s - 1) + 1;
    let le = v.indexOf('\n', e);
    if (le < 0) le = v.length;
    const lines = v.slice(ls, le).split('\n');
    const has = lines.every((l) => l.startsWith(pref));
    const nl = lines.map((l, i) => (has ? l.slice(pref.length) : (pref === '1. ' ? (i + 1) + '. ' : pref) + l)).join('\n');
    nv = v.slice(0, ls) + nl + v.slice(le);
    requestAnimationFrame(() => area.setSelectionRange(ls, ls + nl.length));
  };
  const insert = (txt: string) => {
    nv = v.slice(0, s) + txt + v.slice(e);
    const np = s + txt.length;
    requestAnimationFrame(() => area.setSelectionRange(np, np));
  };
  switch (tool) {
    case 'bold': wrap('**', '**'); break;
    case 'italic': wrap('*', '*'); break;
    case 'strike': wrap('~~', '~~'); break;
    case 'code': wrap('`', '`'); break;
    case 'heading': linePrefix('## '); break;
    case 'quote': linePrefix('> '); break;
    case 'ul': linePrefix('- '); break;
    case 'ol': linePrefix('1. '); break;
    case 'task': linePrefix('- [ ] '); break;
    case 'codeblock': insert('\n```ts\n' + (sel || '// код') + '\n```\n'); break;
    case 'link': wrap('[', '](https://)'); break;
    case 'image': insert('![описание](https://)'); break;
    case 'table': insert('\n| Колонка | Значение |\n| --- | --- |\n| строка | данные |\n'); break;
    case 'hr': insert('\n\n---\n\n'); break;
  }
  area.focus();
  return nv;
}

/** Клавиатура markdown-редактора (порт обработчика textarea прототипа):
    Ctrl+B/I/K — жирный/курсив/ссылка, Tab — отступ, Enter — продолжение
    списка (маркированный/нумерованный/чек-лист): переносит префикс на новую
    строку, пустой пункт списка закрывает список. Возвращает НОВЫЙ текст,
    если нажатие обработано (иначе null); действие браузера при обработке
    предотвращается здесь же. */
export function mdEditorKeyDown(area: HTMLTextAreaElement, e: KeyboardEvent | React.KeyboardEvent<HTMLTextAreaElement>): string | null {
  const mod = e.ctrlKey || e.metaKey;
  const key = e.key;
  /* Ctrl+B / Ctrl+I / Ctrl+K */
  if (mod && ['b', 'i', 'k'].includes(key.toLowerCase())) {
    e.preventDefault();
    return mdApplyTool(area, key.toLowerCase() === 'b' ? 'bold' : key.toLowerCase() === 'i' ? 'italic' : 'link');
  }
  /* Tab — отступ двумя пробелами */
  if (key === 'Tab') {
    e.preventDefault();
    const s = area.selectionStart;
    const nv = area.value.slice(0, s) + '  ' + area.value.slice(area.selectionEnd);
    requestAnimationFrame(() => area.setSelectionRange(s + 2, s + 2));
    area.focus();
    return nv;
  }
  /* Enter — продолжение списка */
  if (key === 'Enter' && !e.shiftKey && !mod) {
    const v = area.value;
    const s = area.selectionStart;
    const ls = v.lastIndexOf('\n', s - 1) + 1;
    const line = v.slice(ls, s);
    const m = line.match(/^(\s*)(- \[[ xX]\] |[-*+] |\d+[.)] )(.*)$/);
    if (!m) return null;
    e.preventDefault();
    /* пустой пункт — выйти из списка (убрать префикс строки) */
    if (!m[3].trim()) {
      const nv = v.slice(0, ls) + v.slice(s);
      requestAnimationFrame(() => area.setSelectionRange(ls, ls));
      return nv;
    }
    let pref = m[2];
    if (/\d/.test(pref)) pref = (parseInt(pref, 10) + 1) + '. ';
    if (/\[[xX]\]/.test(pref)) pref = pref.replace(/\[[xX]\]/, '[ ]');
    const ins = '\n' + m[1] + pref;
    const nv = v.slice(0, s) + ins + v.slice(area.selectionEnd);
    const np = s + ins.length;
    requestAnimationFrame(() => area.setSelectionRange(np, np));
    return nv;
  }
  return null;
}
