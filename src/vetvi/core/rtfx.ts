/**
 * Ветви — текстовые эффекты и форматирование реплик (rtfx).
 *
 * Формат текста реплики дополнен лёгкой разметкой вручную вводимыми маркерами —
 * символами, не встречающимися в обычных текстах (двойные скобки, слеши, двоеточия):
 *
 *   Форматирование (можно комбинировать с эффектами и между собой):
 *     **жирный**            — жирность
 *     __курсив__            — курсив
 *     {#rrggbb}цвет{/}      — цвет (hex без #)
 *
 *   Эффекты (НЕ комбинируются друг с другом — новый эффект заменяет старый):
 *     [[тряска]]            — тряска всего слова (агрессия)
 *     {{дрожь}}             — мелкая дрожь каждой буквы с разной амплитудой (страх)
 *     //волна//             — волнообразное искажение (растягивание в фразе)
 *     ::мерцание::          — мерцание прозрачности (призрачный голос)
 *     @@пульс@@             — пульсация масштабом (акцент, привлечение внимания)
 *     ##отскок##            — буквы подпрыгивают по очереди (радость, оживление)
 *
 * Парсер терпит незакрытые маркеры (печатная машинка в плеере срезает текст
 * посреди разметки — незакрытый маркер считается действующим до конца текста).
 * Чистые функции без DOM — используются редактором, нодами и проигрывателем.
 */

/** Описание эффекта: маркеры, подпись, css-класс и флаг «каждая буква отдельно». */
export interface RtfxEffect {
  id: string;
  label: string;
  hint: string;
  open: string;
  close: string;
  css: string;
  /** Рендер по-буквенно (дрожь с разной амплитудой, волна со сдвигом фазы). */
  perLetter?: boolean;
}

/** Эффекты в порядке выпадающего списка. */
export const RTFX_EFFECTS: RtfxEffect[] = [
  {
    id: 'shake',
    label: 'Тряска',
    hint: 'Тряска всего слова — агрессия, крик',
    open: '[[',
    close: ']]',
    css: 'rtfx-shake',
  },
  {
    id: 'jitter',
    label: 'Дрожь букв',
    hint: 'Мелкая дрожь каждой буквы с разной амплитудой — страх',
    open: '{{',
    close: '}}',
    css: 'rtfx-jitter',
    perLetter: true,
  },
  {
    id: 'wave',
    label: 'Волна',
    hint: 'Волнообразное искажение — растягивание слова во фразе',
    open: '//',
    close: '//',
    css: 'rtfx-wave',
    perLetter: true,
  },
  {
    id: 'flicker',
    label: 'Мерцание',
    hint: 'Мерцание прозрачности — призрачный, тихий голос',
    open: '::',
    close: '::',
    css: 'rtfx-flicker',
  },
  {
    id: 'pulse',
    label: 'Пульс',
    hint: 'Слово пульсирует масштабом — акцент, привлечение внимания',
    open: '@@',
    close: '@@',
    css: 'rtfx-pulse',
  },
  {
    id: 'bounce',
    label: 'Отскок',
    hint: 'Буквы подпрыгивают по очереди — оживление, радость',
    open: '##',
    close: '##',
    css: 'rtfx-bounce',
    perLetter: true,
  },
];

export function rtfxEffectById(id: string | null | undefined): RtfxEffect | null {
  return RTFX_EFFECTS.find((e) => e.id === id) || null;
}

/** Сегмент разобранного текста. fx — id эффекта или null. */
export interface RtfxSpan {
  text: string;
  bold: boolean;
  italic: boolean;
  color: string | null;
  fx: string | null;
}

interface RawSeg {
  text: string;
  fx: string | null;
}

/** Разрез по маркерам эффектов (незакрытый — до конца текста; вложенность запрещена). */
function splitFx(text: string): RawSeg[] {
  const out: RawSeg[] = [];
  let buf = '';
  let fx: RtfxEffect | null = null;
  let i = 0;
  while (i < text.length) {
    if (!fx) {
      const hit = RTFX_EFFECTS.find((e) => text.startsWith(e.open, i));
      if (hit) {
        if (buf) { out.push({ text: buf, fx: null }); buf = ''; }
        fx = hit;
        i += hit.open.length;
        continue;
      }
      buf += text[i];
      i++;
    } else {
      if (text.startsWith(fx.close, i)) {
        out.push({ text: buf, fx: fx.id });
        buf = '';
        i += fx.close.length;
        fx = null;
        continue;
      }
      buf += text[i];
      i++;
    }
  }
  if (buf) out.push({ text: buf, fx: fx ? fx.id : null });
  return out.length ? out : [{ text: '', fx: null }];
}

/** Форматирование внутри сегмента: **жирный**, __курсив__, {#hex}цвет{/}.
 *  Незакрытый открыватель (печатная машинка срезала текст посреди разметки)
 *  считается действующим до конца показанного текста — маркер не мигает. */
const RE_FMT_OPEN = /\*\*|__|\{#[0-9a-fA-F]{6}\}/;

interface FmtSpan { text: string; bold: boolean; italic: boolean; color: string | null }

function splitFmt(text: string, bold: boolean, italic: boolean, color: string | null): FmtSpan[] {
  const m = RE_FMT_OPEN.exec(text);
  if (!m) return text ? [{ text, bold, italic, color }] : [];
  const at = m.index;
  const open = m[0];
  const kind: 'b' | 'i' | 'c' = open === '**' ? 'b' : open === '__' ? 'i' : 'c';
  const close = kind === 'c' ? '{/}' : open;
  const rest = text.slice(at + open.length);
  const closeAt = rest.indexOf(close);
  const inner = closeAt >= 0 ? rest.slice(0, closeAt) : rest;
  const after = closeAt >= 0 ? rest.slice(closeAt + close.length) : '';
  const nb = kind === 'b' ? true : bold;
  const ni = kind === 'i' ? true : italic;
  const nc = kind === 'c' ? ('#' + open.slice(2, 8).toLowerCase()) : color;
  return [
    ...splitFmt(text.slice(0, at), bold, italic, color),
    ...splitFmt(inner, nb, ni, nc),
    ...splitFmt(after, bold, italic, color),
  ];
}

/** Полный разбор текста реплики в плоские сегменты (порядок исходного текста). */
export function parseRtfx(text: string): RtfxSpan[] {
  const src = String(text || '');
  const out: RtfxSpan[] = [];
  for (const seg of splitFx(src)) {
    for (const fs of splitFmt(seg.text, false, false, null)) {
      if (!fs.text) continue;
      out.push({ text: fs.text, bold: fs.bold, italic: fs.italic, color: fs.color, fx: seg.fx });
    }
  }
  return out.length ? out : [{ text: '', bold: false, italic: false, color: null, fx: null }];
}

/** Убрать всю разметку (экспорт в текст, подписи в журнале и т.п.). */
export function stripRtfx(text: string): string {
  let s = String(text || '');
  let prev = '';
  while (prev !== s) {
    prev = s;
    for (const e of RTFX_EFFECTS) {
      s = s.split(e.open).join('');
      s = s.split(e.close).join('');
    }
    s = s.replace(/\*\*([\s\S]*?)\*\*/g, '$1');
    s = s.replace(/__([\s\S]*?)__/g, '$1');
    s = s.replace(/\{#[0-9a-fA-F]{6}\}([\s\S]*?)\{\/\}/g, '$1');
    s = s.replace(/\*\*/g, '').replace(/__/g, '').replace(/\{\/\}/g, '');
    s = s.replace(/\{#[0-9a-fA-F]{0,6}\}/g, '');
  }
  return s;
}

/** Границы «слова» под курсором: непробельные символы вокруг pos. */
export function rtfxWordBounds(text: string, pos: number): { start: number; end: number } {
  const isW = (ch: string) => !!ch && !/\s/.test(ch);
  let start = Math.max(0, Math.min(pos, text.length));
  let end = start;
  while (start > 0 && isW(text[start - 1])) start--;
  while (end < text.length && isW(text[end])) end++;
  return { start, end };
}

/** Диапазон пары маркеров в тексте (включая сами маркеры). */
interface MarkerRange { kind: 'b' | 'i' | 'c' | 'fx'; fx: string | null; start: number; end: number; open: string; close: string }

/** Все пары маркеров в тексте с координатами (эффекты — без вложенности, как в парсере). */
function markerRanges(text: string): MarkerRange[] {
  const out: MarkerRange[] = [];
  let i = 0;
  let cur: { e: RtfxEffect; start: number } | null = null;
  while (i < text.length) {
    if (!cur) {
      const hit = RTFX_EFFECTS.find((e) => text.startsWith(e.open, i));
      if (hit) { cur = { e: hit, start: i }; i += hit.open.length; continue; }
      i++;
    } else {
      if (text.startsWith(cur.e.close, i)) {
        out.push({ kind: 'fx', fx: cur.e.id, start: cur.start, end: i + cur.e.close.length, open: cur.e.open, close: cur.e.close });
        i += cur.e.close.length;
        cur = null;
        continue;
      }
      i++;
    }
  }
  for (const m of text.matchAll(/\*\*([\s\S]*?)\*\*/g)) {
    out.push({ kind: 'b', fx: null, start: m.index || 0, end: (m.index || 0) + m[0].length, open: '**', close: '**' });
  }
  for (const m of text.matchAll(/__([\s\S]*?)__/g)) {
    out.push({ kind: 'i', fx: null, start: m.index || 0, end: (m.index || 0) + m[0].length, open: '__', close: '__' });
  }
  for (const m of text.matchAll(/\{#([0-9a-fA-F]{6})\}([\s\S]*?)\{\/\}/g)) {
    out.push({ kind: 'c', fx: null, start: m.index || 0, end: (m.index || 0) + m[0].length, open: '{#' + m[1] + '}', close: '{/}' });
  }
  return out;
}

/** Уже обёрнут ли отрезок [start,end) парой маркеров (маркеры сразу до и после). */
function wrappedWith(text: string, start: number, end: number, open: string, close: string): boolean {
  return text.slice(Math.max(0, start - open.length), start) === open
    && text.slice(end, end + close.length) === close;
}

/**
 * Обёртка диапазона/слова маркерами (кнопки Ж/К/Цвет и эффекты).
 * - пустое выделение → берётся слово под курсором;
 * - курсор внутри готовой пары: Ж/К — тумблер (снять), Цвет — заменить цвет,
 *   эффект — снять (тот же) или заменить (другой);
 * - эффект поверх другого эффекта заменяет его (эффекты не комбинируются);
 * - форматирование с эффектом комбинируется (вложением).
 * Возвращает новый текст + координаты выделения для восстановления курсора.
 * Для цвета colorHex=''/null без пары вокруг курсора означает «убрать цвет».
 */
export function rtfxWrap(
  text: string,
  selStart: number,
  selEnd: number,
  kind: 'b' | 'i' | 'c' | 'fx',
  fxId: string | null,
  colorHex: string | null,
): { text: string; start: number; end: number } {
  let open: string;
  let close: string;
  if (kind === 'b') { open = '**'; close = '**'; }
  else if (kind === 'i') { open = '__'; close = '__'; }
  else if (kind === 'fx') {
    const e = rtfxEffectById(fxId);
    if (!e) return { text, start: selStart, end: selEnd };
    open = e.open;
    close = e.close;
  } else {
    open = '{#' + String(colorHex || 'e2a54e').replace('#', '') + '}';
    close = '{/}';
  }

  let start = selStart;
  let end = selEnd;
  let hit: MarkerRange | null = null;
  if (start === end) {
    /* курсор внутри готовой пары маркеров — разворачиваем до всей пары */
    const inside = markerRanges(text)
      .filter((r) => selStart >= r.start && selStart <= r.end)
      .sort((a, b) => (a.end - a.start) - (b.end - b.start));
    hit = (kind === 'fx' ? inside.find((r) => r.kind === 'fx') : inside.find((r) => r.kind === kind)) || null;
    if (hit) {
      start = hit.start;
      end = hit.end;
    } else {
      const wb = rtfxWordBounds(text, start);
      start = wb.start;
      end = wb.end;
    }
  } else {
    start = Math.max(0, Math.min(start, text.length));
    end = Math.max(start, Math.min(end, text.length));
  }
  if (end <= start) return { text, start: selStart, end: selEnd };

  /* 1. курсор был внутри готовой пары: снять/заменить точно по её маркерам */
  if (hit) {
    const inner = text.slice(hit.start + hit.open.length, hit.end - hit.close.length);
    if (kind === 'fx') {
      if (hit.fx === fxId) {
        /* тот же эффект — снять */
        const next = text.slice(0, hit.start) + inner + text.slice(hit.end);
        return { text: next, start: hit.start, end: hit.start + inner.length };
      }
      /* другой эффект — заменить (эффекты не комбинируются) */
      const next = text.slice(0, hit.start) + open + inner + close + text.slice(hit.end);
      return { text: next, start: hit.start + open.length, end: hit.start + open.length + inner.length };
    }
    if (kind === 'c') {
      if (!colorHex) {
        /* «убрать цвет» */
        const next = text.slice(0, hit.start) + inner + text.slice(hit.end);
        return { text: next, start: hit.start, end: hit.start + inner.length };
      }
      /* другой цвет — заменить */
      const next = text.slice(0, hit.start) + open + inner + close + text.slice(hit.end);
      return { text: next, start: hit.start + open.length, end: hit.start + open.length + inner.length };
    }
    /* жирность/курсив — тумблер */
    const next = text.slice(0, hit.start) + inner + text.slice(hit.end);
    return { text: next, start: hit.start, end: hit.start + inner.length };
  }

  /* 2. отрезок сам начинается и кончается маркером (выделение/слово захватило
     маркеры) или маркеры сразу вокруг выделения — снять */
  let target = text.slice(start, end);
  if (target.startsWith(open) && target.endsWith(close) && target.length > open.length + close.length) {
    const inner = target.slice(open.length, target.length - close.length);
    const next = text.slice(0, start) + inner + text.slice(end);
    return { text: next, start, end: end - open.length };
  }
  if (wrappedWith(text, start, end, open, close)) {
    const inner = text.slice(start, end);
    const next = text.slice(0, start - open.length) + inner + text.slice(end + close.length);
    return { text: next, start: start - open.length, end: end - open.length };
  }

  /* цвет без слова-цели (пустое слово) — нечего размечать */
  if (kind === 'c' && !colorHex) return { text, start: selStart, end: selEnd };

  /* 3. эффекты не комбинируются: снять с отрезка все прочие эффекты */
  if (kind === 'fx') {
    let prevT = '';
    while (prevT !== target) {
      prevT = target;
      for (const e of RTFX_EFFECTS) {
        if (target.startsWith(e.open) && target.endsWith(e.close) && target.length > e.open.length + e.close.length) {
          target = target.slice(e.open.length, target.length - e.close.length);
        }
      }
    }
    const next = text.slice(0, start) + open + target + close + text.slice(end);
    return { text: next, start: start + open.length, end: start + open.length + target.length };
  }

  /* 4. обычная обёртка */
  const next = text.slice(0, start) + open + text.slice(start, end) + close + text.slice(end);
  return { text: next, start: start + open.length, end: start + open.length + (end - start) };
}
