/**
 * Ветви — реестр горячих клавиш (порт HK_DEFS оригинала, строки 9542–9658).
 * Сочетания хранятся по e.code — независимы от раскладки; RU2CODE восстанавливает
 * клавишу из кириллицы. Переназначения пользователя — per-user ключ.
 */

export interface HkDef { id: string; name: string; def: string; alias?: string[] }

export const HK_DEFS: HkDef[] = [
  { id: 'undo', name: 'Отменить', def: 'Mod+KeyZ' },
  { id: 'redo', name: 'Вернуть (повторить)', def: 'Mod+KeyY', alias: ['Mod+Shift+KeyZ'] },
  { id: 'save', name: 'Сохранить проект (JSON)', def: 'Mod+KeyS' },
  { id: 'saveAs', name: 'Сохранить как… (JSON)', def: 'Mod+Shift+KeyS' },
  { id: 'projects', name: 'Менеджер проектов', def: 'Mod+KeyO' },
  { id: 'search', name: 'Поиск по проекту', def: 'Mod+KeyF' },
  { id: 'newProject', name: 'Новый проект', def: 'Mod+Alt+KeyN' },
  { id: 'duplicate', name: 'Дублировать выделение', def: 'Mod+KeyD' },
  { id: 'exportSel', name: 'Экспорт выделенных нод (JSON)', def: 'Mod+KeyE' },
  { id: 'selectAll', name: 'Выделить все ноды', def: 'Mod+KeyA' },
  { id: 'group', name: 'Сгруппировать выделение', def: 'Mod+KeyG' },
  { id: 'ungroup', name: 'Разгруппировать', def: 'Mod+Shift+KeyG' },
  { id: 'alignH', name: 'Выровнять в ряд', def: 'Mod+Shift+KeyA' },
  { id: 'alignV', name: 'Выровнять в столбец', def: 'Mod+Shift+KeyV' },
  { id: 'rename', name: 'Переименовать ноду', def: 'F2' },
  { id: 'deleteSel', name: 'Удалить выделенное', def: 'Delete', alias: ['Backspace'] },
  { id: 'centerSel', name: 'Центрировать на выделенной ноде', def: 'KeyF' },
  { id: 'play', name: 'Проиграть диалог', def: 'KeyP' },
  { id: 'playNode', name: 'Проиграть только эту ноду', def: 'Alt+KeyP' },
  { id: 'plRestart', name: 'Плеер: заново (кнопка «Заново»)', def: 'KeyR' },
  { id: 'plShow', name: 'Плеер: к ноде на холсте (кнопка «К ноде»)', def: 'KeyG' },
  { id: 'fitView', name: 'Вписать весь проект', def: 'Digit0' },
  { id: 'zoomIn', name: 'Приблизить', def: 'Equal', alias: ['Shift+Equal'] },
  { id: 'zoomOut', name: 'Отдалить', def: 'Minus' },
  { id: 'patchnotes', name: 'Что нового (патчноут)', def: 'Mod+KeyH' },
];

export function hkDef(id: string): HkDef | null {
  for (const d of HK_DEFS) if (d.id === id) return d;
  return null;
}

const RU2CODE: Record<string, string> = {
  й: 'KeyQ', ц: 'KeyW', у: 'KeyE', к: 'KeyR', е: 'KeyT', н: 'KeyY', г: 'KeyU', ш: 'KeyI', щ: 'KeyO',
  з: 'KeyP', ф: 'KeyA', ы: 'KeyS', в: 'KeyD', а: 'KeyF', п: 'KeyG', р: 'KeyH', о: 'KeyJ', л: 'KeyK',
  д: 'KeyL', я: 'KeyZ', ч: 'KeyX', с: 'KeyC', м: 'KeyV', и: 'KeyB', т: 'KeyN', ь: 'KeyM',
  х: 'BracketLeft', ъ: 'BracketRight', ж: 'Semicolon', э: 'Quote', б: 'Comma', ю: 'Period', ё: 'Backquote',
};

export function hkKeyCode(e: KeyboardEvent): string {
  if (e.code) return e.code;
  const k = (e.key || '').toLowerCase();
  if (RU2CODE[k]) return RU2CODE[k];
  if (/^[0-9]$/.test(k)) return 'Digit' + k;
  if (/^[a-z]$/.test(k)) return 'Key' + k.toUpperCase();
  return e.key || '';
}

export function hkComboOf(e: KeyboardEvent): string {
  const p: string[] = [];
  if (e.ctrlKey || e.metaKey) p.push('Mod');
  if (e.altKey) p.push('Alt');
  if (e.shiftKey) p.push('Shift');
  p.push(hkKeyCode(e));
  return p.join('+');
}

/** Переназначения пользователя {id: combo} — ключ vetvi-hotkeys-<userId|anon>. */
let hkUser: Record<string, string> = {};

function hkStoreKey(): string {
  let id = 'anon';
  try {
    const m = window.localStorage.getItem('vetvi-me-v1');
    if (m) {
      const o = JSON.parse(m) as { id?: string };
      if (o && o.id) id = o.id;
    }
  } catch { /* аноним */ }
  return 'vetvi-hotkeys-' + id;
}

export function hkLoad(): void {
  let obj: Record<string, string> | null = null;
  try {
    obj = JSON.parse(window.localStorage.getItem(hkStoreKey()) || '{}') || null;
  } catch { obj = null; }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) obj = {};
  hkUser = obj;
  Object.keys(hkUser).forEach((k) => { if (!hkDef(k)) delete hkUser[k]; });
}

export function hkUserOverrides(): Record<string, string> {
  return hkUser;
}

export function hkSaveUser(): void {
  try { window.localStorage.setItem(hkStoreKey(), JSON.stringify(hkUser)); } catch { /* квота */ }
}

export function hkBound(id: string): string {
  const d = hkDef(id);
  return (d && hkUser[id]) ? hkUser[id] : (d ? d.def : '');
}

export function hkIs(e: KeyboardEvent, id: string): boolean {
  const d = hkDef(id);
  if (!d) return false;
  const c = hkComboOf(e);
  if (c === hkBound(id)) return true;
  return !!(!hkUser[id] && d.alias && d.alias.indexOf(c) >= 0);
}

/** Имя действия, занявшего combo, или null. */
export function hkConflict(combo: string, exceptId: string): string | null {
  for (const d of HK_DEFS) {
    if (d.id === exceptId) continue;
    if (hkBound(d.id) === combo) return d.name;
    if (!hkUser[d.id] && d.alias && d.alias.indexOf(combo) >= 0) return d.name;
  }
  return null;
}

const hkMac = typeof navigator !== 'undefined' && /mac/i.test(navigator.platform || '');

export function hkHuman(combo: string | null | undefined): string {
  if (!combo) return '—';
  const parts = combo.split('+');
  const code = parts[parts.length - 1];
  const mods = parts.slice(0, -1);
  let k = code;
  if (code.indexOf('Key') === 0) k = code.slice(3);
  else if (code.indexOf('Digit') === 0) k = code.slice(5);
  else if (code === 'Equal') k = '=';
  else if (code === 'Minus') k = '-';
  else if (code === 'Backquote') k = '`';
  else if (code === 'BracketLeft') k = '[';
  else if (code === 'BracketRight') k = ']';
  else if (code === 'Semicolon') k = ';';
  else if (code === 'Quote') k = "'";
  else if (code === 'Comma') k = ',';
  else if (code === 'Period') k = '.';
  else if (code === 'Delete') k = 'Del';
  const map = hkMac ? { Mod: '⌘', Alt: '⌥', Shift: '⇧' } : { Mod: 'Ctrl', Alt: 'Alt', Shift: 'Shift' };
  const out = mods.map((m) => map[m] || m);
  out.push(k);
  return out.join(hkMac ? '' : '+');
}

export function hkSetUser(id: string, combo: string | null): void {
  if (combo) hkUser[id] = combo;
  else delete hkUser[id];
  hkSaveUser();
}

export function hkResetAll(): void {
  hkUser = {};
  hkSaveUser();
}

export function hkText(id: string): string {
  return hkHuman(hkBound(id));
}
