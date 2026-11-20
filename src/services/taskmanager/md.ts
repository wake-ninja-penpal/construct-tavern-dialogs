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
      out += '<pre>' + (lang ? '<span class="lang">' + esc(lang) + '</span>' : '') + '<code>' + highlightCode(buf.join('\n'), lang) + '</code></pre>';
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

/* ═══ подсветка кода по языку (лёгкий токенайзер без внешних библиотек) ═══
   На входе исходный код, на выходе безопасный HTML с span.tok-*: ключевые
   слова, строки, комментарии, числа, вызовы функций и html-теги. Используется
   и в отрисовке (mdToHtml), и в живом редакторе (MdWysiwyg — переподсветка
   блоков кода, в которых каретка не стоит). */

const escTok = (s: string): string => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c] || c));

const LANG_ALIAS: Record<string, string> = {
  javascript: 'js', mjs: 'js', cjs: 'js', jsx: 'js', node: 'js',
  typescript: 'ts', tsx: 'ts',
  python3: 'py', python: 'py', py: 'py',
  bash: 'sh', shell: 'sh', zsh: 'sh', console: 'sh', sh: 'sh',
  yml: 'yaml', yaml: 'yaml',
  'c++': 'cpp', 'c plus plus': 'cpp',
  'c#': 'cs', csharp: 'cs',
  golang: 'go',
  ruby: 'rb',
  html: 'html', xhtml: 'html', xml: 'html', svg: 'html', svelte: 'html', vue: 'html',
  postgres: 'sql', postgresql: 'sql', mysql: 'sql', sqlite: 'sql',
  dockerfile: 'sh', makefile: 'sh', dotenv: 'sh', ini: 'sh', toml: 'sh', conf: 'sh',
  kotlin: 'java', kt: 'java',
};

const LANGS: Record<string, { kw?: string[]; hash?: boolean; tags?: boolean; clike?: boolean }> = {
  _: { clike: true },
  js: { clike: true, kw: ['async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do', 'else', 'export', 'extends', 'false', 'finally', 'for', 'function', 'get', 'if', 'import', 'in', 'instanceof', 'let', 'new', 'null', 'of', 'return', 'set', 'static', 'super', 'switch', 'this', 'throw', 'true', 'try', 'typeof', 'undefined', 'var', 'void', 'while', 'yield'] },
  ts: { clike: true, kw: ['abstract', 'any', 'as', 'async', 'await', 'boolean', 'break', 'case', 'catch', 'class', 'const', 'continue', 'declare', 'default', 'delete', 'do', 'else', 'enum', 'export', 'extends', 'false', 'finally', 'for', 'from', 'function', 'get', 'if', 'implements', 'import', 'in', 'infer', 'instanceof', 'interface', 'keyof', 'let', 'never', 'new', 'null', 'number', 'of', 'private', 'protected', 'public', 'readonly', 'return', 'set', 'static', 'string', 'super', 'switch', 'this', 'throw', 'true', 'try', 'type', 'typeof', 'undefined', 'unknown', 'var', 'void', 'while', 'yield'] },
  py: { hash: true, kw: ['and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def', 'del', 'elif', 'else', 'except', 'False', 'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda', 'None', 'nonlocal', 'not', 'or', 'pass', 'print', 'raise', 'return', 'self', 'True', 'try', 'while', 'with', 'yield'] },
  go: { clike: true, kw: ['break', 'case', 'chan', 'const', 'continue', 'default', 'defer', 'else', 'fallthrough', 'false', 'for', 'func', 'go', 'goto', 'if', 'import', 'interface', 'map', 'nil', 'package', 'range', 'return', 'select', 'struct', 'switch', 'true', 'type', 'var'] },
  rust: { clike: true, kw: ['as', 'async', 'await', 'break', 'const', 'continue', 'crate', 'dyn', 'else', 'enum', 'extern', 'false', 'fn', 'for', 'if', 'impl', 'in', 'let', 'loop', 'match', 'mod', 'move', 'mut', 'pub', 'ref', 'return', 'self', 'static', 'struct', 'super', 'trait', 'true', 'type', 'unsafe', 'use', 'where', 'while'] },
  java: { clike: true, kw: ['abstract', 'boolean', 'break', 'byte', 'case', 'catch', 'char', 'class', 'const', 'continue', 'default', 'do', 'double', 'else', 'enum', 'extends', 'final', 'finally', 'float', 'for', 'if', 'implements', 'import', 'instanceof', 'int', 'interface', 'long', 'native', 'new', 'null', 'package', 'private', 'protected', 'public', 'return', 'short', 'static', 'super', 'switch', 'synchronized', 'this', 'throw', 'throws', 'true', 'false', 'try', 'var', 'void', 'volatile', 'while'] },
  cpp: { clike: true, kw: ['auto', 'bool', 'break', 'case', 'catch', 'char', 'class', 'const', 'constexpr', 'continue', 'default', 'delete', 'do', 'double', 'else', 'enum', 'explicit', 'extern', 'false', 'float', 'for', 'friend', 'goto', 'if', 'inline', 'int', 'long', 'mutable', 'namespace', 'new', 'nullptr', 'operator', 'private', 'protected', 'public', 'return', 'short', 'signed', 'sizeof', 'static', 'struct', 'switch', 'template', 'this', 'throw', 'true', 'try', 'typedef', 'typename', 'union', 'unsigned', 'using', 'virtual', 'void', 'volatile', 'while'] },
  cs: { clike: true, kw: ['abstract', 'as', 'base', 'bool', 'break', 'byte', 'case', 'catch', 'char', 'checked', 'class', 'const', 'continue', 'decimal', 'default', 'do', 'double', 'else', 'enum', 'event', 'false', 'finally', 'float', 'for', 'foreach', 'get', 'if', 'in', 'int', 'interface', 'internal', 'is', 'lock', 'long', 'namespace', 'new', 'null', 'object', 'operator', 'out', 'override', 'params', 'private', 'protected', 'public', 'readonly', 'ref', 'return', 'set', 'sealed', 'short', 'sizeof', 'static', 'string', 'struct', 'switch', 'this', 'throw', 'true', 'try', 'typeof', 'uint', 'ulong', 'unsafe', 'ushort', 'using', 'var', 'virtual', 'void', 'while'] },
  php: { hash: true, clike: true, kw: ['and', 'array', 'as', 'break', 'case', 'catch', 'class', 'clone', 'const', 'continue', 'default', 'do', 'echo', 'else', 'elseif', 'empty', 'extends', 'false', 'final', 'finally', 'fn', 'for', 'foreach', 'function', 'global', 'if', 'implements', 'include', 'instanceof', 'interface', 'isset', 'list', 'match', 'new', 'null', 'or', 'print', 'private', 'protected', 'public', 'require', 'return', 'static', 'switch', 'throw', 'true', 'try', 'unset', 'use', 'var', 'while', 'xor', 'yield'] },
  rb: { hash: true, kw: ['attr_accessor', 'begin', 'break', 'case', 'class', 'def', 'defined?', 'do', 'else', 'elsif', 'end', 'ensure', 'false', 'for', 'if', 'in', 'lambda', 'module', 'new', 'next', 'nil', 'proc', 'puts', 'raise', 'require', 'rescue', 'return', 'self', 'then', 'true', 'unless', 'until', 'while', 'yield'] },
  sql: { kw: ['add', 'all', 'alter', 'and', 'as', 'asc', 'avg', 'begin', 'between', 'boolean', 'by', 'case', 'commit', 'count', 'create', 'cross', 'database', 'date', 'delete', 'desc', 'distinct', 'drop', 'else', 'end', 'exists', 'foreign', 'from', 'full', 'group', 'having', 'in', 'index', 'inner', 'insert', 'int', 'into', 'is', 'join', 'key', 'left', 'like', 'limit', 'max', 'min', 'not', 'null', 'offset', 'on', 'or', 'order', 'outer', 'primary', 'references', 'rollback', 'select', 'set', 'sum', 'table', 'text', 'then', 'timestamp', 'transaction', 'union', 'unique', 'update', 'values', 'varchar', 'view', 'when', 'where', 'with'] },
  sh: { hash: true, kw: ['alias', 'break', 'case', 'cd', 'continue', 'do', 'done', 'echo', 'elif', 'else', 'esac', 'eval', 'exec', 'exit', 'export', 'fi', 'for', 'function', 'if', 'in', 'local', 'readonly', 'return', 'set', 'shift', 'source', 'then', 'trap', 'true', 'false', 'unset', 'until', 'while'] },
  json: { clike: true, kw: ['true', 'false', 'null'] },
  css: { clike: true, kw: ['important', 'media', 'import', 'keyframes', 'font-face', 'supports', 'charset', 'layer', 'container'] },
  html: { tags: true, clike: true },
};

/** Разметить код цветом под язык (безопасный HTML, без внешних библиотек). */
export function highlightCode(src: string, lang: string): string {
  const raw = String(src || '');
  const l = LANG_ALIAS[String(lang || '').toLowerCase().trim()] || String(lang || '').toLowerCase().trim();
  const def = LANGS[l] || LANGS._;
  const kw = def.kw ? new Set(def.kw) : null;
  const hashCom = !!def.hash;
  const tags = !!def.tags;
  const clike = !!def.clike;
  let out = '';
  let i = 0;
  const n = raw.length;
  const push = (cls: string, text: string): void => {
    out += cls ? '<span class="tok-' + cls + '">' + escTok(text) + '</span>' : escTok(text);
  };
  const prevCh = (): string => (i > 0 ? raw[i - 1] : '');
  while (i < n) {
    const c = raw[i];
    /* комментарии: //… /* … *\/ и <!— — —> и #… (для языков с решёткой) */
    if (clike && c === '/' && raw[i + 1] === '/' && prevCh() !== ':') {
      let j = raw.indexOf('\n', i);
      if (j < 0) j = n;
      push('c', raw.slice(i, j)); i = j; continue;
    }
    if (clike && c === '/' && raw[i + 1] === '*') {
      let j = raw.indexOf('*/', i + 2);
      j = j < 0 ? n : j + 2;
      push('c', raw.slice(i, j)); i = j; continue;
    }
    if (tags && raw.startsWith('<!--', i)) {
      let j = raw.indexOf('-->', i);
      j = j < 0 ? n : j + 3;
      push('c', raw.slice(i, j)); i = j; continue;
    }
    if (hashCom && c === '#') {
      let j = raw.indexOf('\n', i);
      if (j < 0) j = n;
      push('c', raw.slice(i, j)); i = j; continue;
    }
    /* строки: '…' "…" `…` (с экранированием \\) */
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < n) {
        if (raw[j] === '\\') { j += 2; continue; }
        if (raw[j] === c) { j++; break; }
        if (raw[j] === '\n' && c !== '`') break;
        j++;
      }
      push('s', raw.slice(i, j)); i = j; continue;
    }
    /* html-теги: <tag …> */
    if (tags && c === '<' && /[a-zA-Z/!]/.test(raw[i + 1] || '')) {
      const m = /^<\/?[a-zA-Z][\w:-]*/.exec(raw.slice(i));
      if (m) { push('t', m[0]); i += m[0].length; continue; }
    }
    /* числа (не внутри идентификатора) */
    if (/\d/.test(c) && !/[\w$]/.test(prevCh())) {
      const m = /^(?:0[xXbBoO][\da-fA-F_]+|\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(raw.slice(i));
      if (m) { push('n', m[0]); i += m[0].length; continue; }
    }
    /* идентификаторы: ключевое слово / вызов функции / просто слово */
    if (/[A-Za-z_$]/.test(c)) {
      let j = i + 1;
      while (j < n && /[\w$]/.test(raw[j])) j++;
      const word = raw.slice(i, j);
      if (kw && kw.has(word)) push('k', word);
      else if (kw) {
        let k = j;
        while (k < n && raw[k] === ' ') k++;
        push(raw[k] === '(' ? 'f' : '', word);
      } else push('', word);
      i = j; continue;
    }
    /* остальной текст — группой до ближайшего «начального» символа */
    let j = i;
    while (j < n) {
      const ch = raw[j];
      if (ch === '"' || ch === "'" || ch === '`') break;
      if (clike && ch === '/' && (raw[j + 1] === '/' || raw[j + 1] === '*')) break;
      if (hashCom && ch === '#') break;
      if (tags && ch === '<' && /[a-zA-Z/!]/.test(raw[j + 1] || '')) break;
      if (/\d/.test(ch) && !/[\w$.]/.test(j > i || j > 0 ? raw[j - 1] : '')) break;
      if (/[A-Za-z_$]/.test(ch)) break;
      j++;
    }
    if (j === i) j = i + 1;
    push('', raw.slice(i, j)); i = j;
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

/** Статистика чек-листов описания: сколько пунктов [ ] / [x] в тексте.
    Подпункты с отступом тоже считаются. null — чек-листов в тексте нет. */
export function checklistStats(s: string): { total: number; done: number } | null {
  let total = 0;
  let done = 0;
  const re = /^\s*[-*+]\s+\[([ xX])\]/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(String(s || ''))) !== null) {
    total++;
    if (m[1].toLowerCase() === 'x') done++;
  }
  return total ? { total, done } : null;
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

/* текст блока кода с учётом <br> (textContent теряет переводы строк) */
export function codeTextOf(code: HTMLElement): string {
  let out = '';
  for (const node of Array.from(code.childNodes)) {
    if (node.nodeType === Node.ELEMENT_NODE) {
      const e = node as HTMLElement;
      if (e.tagName === 'BR') { out += '\n'; continue; }
      out += codeTextOf(e);
    } else {
      out += node.textContent || '';
    }
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
      /* язык блока (```py) — подпись .lang обязана вернуться в исходник,
         иначе после правки в редакторе подсветка теряется */
      const langEl = el.querySelector<HTMLElement>(':scope > .lang');
      const lang = (langEl?.textContent || '').trim();
      chunks.push('```' + lang + '\n' + codeTextOf(code) + '\n```');
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
  { id: 'code', title: 'Код в строке (`…` — повторный клик снимает)', icon: 'code', sep: true },
  { id: 'codeblock', title: 'Блок кода с подсветкой (```язык)', icon: 'note' },
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
