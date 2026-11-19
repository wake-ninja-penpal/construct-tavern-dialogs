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

/* ── инструменты редактора (панель над textarea) ── */

export const MD_TOOLS: { id: string; title: string; icon: string }[] = [
  { id: 'bold', title: 'Жирный (Ctrl+B)', icon: 'bold' },
  { id: 'italic', title: 'Курсив (Ctrl+I)', icon: 'italic' },
  { id: 'strike', title: 'Зачёркнутый', icon: 'strike' },
  { id: 'heading', title: 'Заголовок', icon: 'heading' },
  { id: 'quote', title: 'Цитата', icon: 'quote' },
  { id: 'ul', title: 'Маркированный список', icon: 'list' },
  { id: 'ol', title: 'Нумерованный список', icon: 'list-ol' },
  { id: 'task', title: 'Чек-лист', icon: 'check-square' },
  { id: 'code', title: 'Код', icon: 'code' },
  { id: 'codeblock', title: 'Блок кода', icon: 'note' },
  { id: 'link', title: 'Ссылка (Ctrl+K)', icon: 'link' },
  { id: 'table', title: 'Таблица', icon: 'table' },
  { id: 'hr', title: 'Разделитель', icon: 'minus' },
];

/** Применить инструмент к textarea (переносит выделение, как в прототипе). */
export function mdApplyTool(area: HTMLTextAreaElement, tool: string): void {
  const s = area.selectionStart;
  const e = area.selectionEnd;
  const v = area.value;
  const sel = v.slice(s, e);
  const wrap = (a: string, b: string) => {
    area.value = v.slice(0, s) + a + (sel || 'текст') + b + v.slice(e);
    const ns = s + a.length;
    area.setSelectionRange(ns, ns + (sel || 'текст').length);
  };
  const linePrefix = (pref: string) => {
    const ls = v.lastIndexOf('\n', s - 1) + 1;
    let le = v.indexOf('\n', e);
    if (le < 0) le = v.length;
    const lines = v.slice(ls, le).split('\n');
    const has = lines.every((l) => l.startsWith(pref));
    const nl = lines.map((l, i) => (has ? l.slice(pref.length) : (pref === '1. ' ? (i + 1) + '. ' : pref) + l)).join('\n');
    area.value = v.slice(0, ls) + nl + v.slice(le);
    area.setSelectionRange(ls, ls + nl.length);
  };
  const insert = (txt: string) => {
    area.value = v.slice(0, s) + txt + v.slice(e);
    area.setSelectionRange(s + txt.length, s + txt.length);
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
    case 'table': insert('\n| Колонка | Значение |\n| --- | --- |\n| строка | данные |\n'); break;
    case 'hr': insert('\n\n---\n\n'); break;
  }
  area.focus();
}
