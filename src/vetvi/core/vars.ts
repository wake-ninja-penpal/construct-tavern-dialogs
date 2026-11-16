/**
 * Ветви — переменные и условия (порт var* функций классической версии, строки 2024–2120).
 * Чистые функции без DOM: используются редактором и проигрывателем.
 */

import type { VetviCond, VetviDoc, VetviEdge, VetviNode, VetviOutcome, VetviVar } from './types';

export const VARS_OPS: Record<string, string> = { '=': '=', '+': '+', '-': '−' };
export const COND_OPS: Record<string, string> = { '==': '=', '!=': '≠', '>': '>', '<': '<', '>=': '≥', '<=': '≤' };
export const COND_OPS_EQ: Record<string, string> = { '==': '=', '!=': '≠' };
export const VAR_TYPES: Record<string, string> = { num: 'number', str: 'string', bool: 'boolean' };

export function varsList(doc: VetviDoc): VetviVar[] {
  if (!Array.isArray(doc.vars)) doc.vars = [];
  return doc.vars;
}

export function varById(doc: VetviDoc, id: string | null | undefined): VetviVar | null {
  if (!id) return null;
  const l = varsList(doc);
  for (const v of l) if (v.id === id) return v;
  return null;
}

export function varName(doc: VetviDoc, id: string | null | undefined): string {
  const v = varById(doc, id);
  return v ? String(v.name || '?') : '?';
}

export function varType(v: VetviVar | null | undefined): string {
  const t = v && v.type;
  return (t === 'str' || t === 'bool' || t === 'num') ? t : 'num';
}

/** Приведение значения к типу переменной (varCastVal оригинала). */
export function varCastVal(type: string, raw: unknown): number | boolean | string {
  const s = String(raw == null ? '' : raw);
  if (type === 'num') {
    const t = s.trim();
    return (/^-?\d+(\.\d+)?$/.test(t)) ? parseFloat(t) : 0;
  }
  if (type === 'bool') {
    const t = s.trim().toLowerCase();
    if (['1', 'true', 'да', 'yes', 'истина'].indexOf(t) >= 0) return true;
    if (['0', 'false', 'нет', 'no'].indexOf(t) >= 0) return false;
    return true;
  }
  return s.slice(0, 200);
}

export function varCast(v: VetviVar | null | undefined, raw: unknown): number | boolean | string {
  return varCastVal(varType(v), raw);
}

/** Безопасный дефолт для новых привязок (defValOf). */
export function defValOf(v: VetviVar | null | undefined): number | boolean | string {
  if (!v) return 0;
  const t = varType(v);
  if (t === 'bool') return v.val === false ? false : true;
  if (t === 'str') return typeof v.val === 'string' ? v.val : '';
  return typeof v.val === 'number' && isFinite(v.val as number) ? v.val : 0;
}

export function isTrueVal(x: unknown): boolean {
  return x === true || x === 'true' || x === 'да' || x === 'Да' || x === 1;
}

export function varValText(val: unknown, v?: VetviVar | null): string {
  if (v && varType(v) === 'bool') return (val === true || val === 'true' || val === 1 || val === 'да') ? 'true' : 'false';
  if (val === true) return 'true';
  if (val === false) return 'false';
  if (typeof val === 'string') return '«' + val + '»';
  return String(val == null ? '' : val);
}

export function varNum(x: unknown): number {
  const n = (typeof x === 'number') ? x : parseFloat(String(x));
  return isFinite(n) ? n : 0;
}

export function opsForType(t: string): Record<string, string> {
  return t === 'num' ? VARS_OPS : { '=': '=' };
}

export function condOpsFor(t: string): Record<string, string> {
  return t === 'num' ? COND_OPS : COND_OPS_EQ;
}

/** Применение операции к текущему значению (varApplyOp): +/− только для чисел. */
export function varApplyOp(op: string, cur: unknown, val: unknown, type: string): unknown {
  if (op === '=') return varCastVal(type, val);
  if (type !== 'num') return cur;
  const a = varNum(cur);
  const b = varNum(val);
  if (op === '+') return a + b;
  if (op === '-') return a - b;
  return cur;
}

export function opSym(op: string | null | undefined): string {
  if (op === '+') return '+';
  if (op === '-') return '−';
  return '=';
}

export type Cond = VetviCond;

export function condText(doc: VetviDoc, c: Cond | null | undefined): string {
  if (!c) return '';
  return varName(doc, c.vid) + ' ' + (COND_OPS[c.op] || c.op || '=') + ' ' + varValText(c.val, varById(doc, c.vid));
}

/* ═══ несколько условий у одного исхода развилки (conds + condJoin) ═══
   Старые документы хранят одиночное условие в o.cond — читается через
   outConds; при правке в инспекторе список пишется в o.conds, а o.cond
   остаётся зеркалом первого условия для старых клиентов. */

function condLooksValid(c: unknown): c is Cond {
  const o = c as { vid?: unknown; op?: unknown };
  return !!o && typeof o === 'object' && typeof o.vid === 'string' && typeof o.op === 'string';
}

/** Условия исхода: массив conds, а для старых документов — одиночное cond.
 *  Пустой conds при заданном cond (смешанное состояние после внешних правок)
 *  считается задействованным — работает одиночное условие. */
export function outConds(o: VetviOutcome | null | undefined): Cond[] {
  if (!o) return [];
  const oo = o as { conds?: unknown; cond?: unknown };
  const legacy = condLooksValid(oo.cond) ? [oo.cond as Cond] : [];
  if (Array.isArray(oo.conds)) {
    const cs = oo.conds.filter(condLooksValid) as Cond[];
    return cs.length ? cs : legacy;
  }
  return legacy;
}

/** Нормализация исхода: conds становится каноническим хранилищем,
 *  cond — зеркалом первого условия (совместимость со старыми версиями). */
export function ensureOutConds(o: VetviOutcome): Cond[] {
  const cs = outConds(o);
  o.conds = cs;
  const legacy = (o as unknown as { cond?: unknown });
  legacy.cond = cs.length ? cs[0] : null;
  return cs;
}

/** Как объединяются условия исхода: 'and' — все сразу, 'or' — достаточно любого. */
export function outJoin(o: VetviOutcome | null | undefined): 'and' | 'or' {
  return o && o.condJoin === 'or' ? 'or' : 'and';
}

function condJoinText(join: 'and' | 'or', parts: string[]): string {
  const sep = join === 'or' ? ' или ' : ' и ';
  return parts.join(sep);
}

/** Текст всех условий исхода («A = 1 и B = 2», «A = 1 или B = 2»).
 *  fn — нода развилки: перебивание входной переменной учитывается. */
export function outCondText(doc: VetviDoc, o: VetviOutcome | null | undefined, fn?: VetviNode | null): string {
  const cs = outConds(o).map((c) => condWithOverride(doc, c, fn || null));
  if (!cs.length) return '';
  return condJoinText(outJoin(o), cs.map((c) => condText(doc, c)));
}

/** Проверка всех условий исхода: пусто — истина; 'and' — все, 'or' — любой. */
export function outCondsMet(doc: VetviDoc, o: VetviOutcome | null | undefined, live?: Record<string, unknown> | null, fn?: VetviNode | null): boolean {
  const cs = outConds(o).map((c) => condWithOverride(doc, c, fn || null));
  if (!cs.length) return true;
  const met = cs.map((c) => condMet(doc, c, live));
  return outJoin(o) === 'or' ? met.some(Boolean) : met.every(Boolean);
}

/** Проверка условия (condMet): неизвестная переменная — условие считается выполненным. */
export function condMet(doc: VetviDoc, c: Cond | null | undefined, live?: Record<string, unknown> | null): boolean {
  if (!c || !c.vid) return true;
  const v = varById(doc, c.vid);
  if (!v) return true;
  let val: unknown = v.val;
  if (live && live[v.id] !== undefined && live[v.id] !== null) val = live[v.id];
  const t = varType(v);
  if (t === 'bool') return isTrueVal(val) === isTrueVal(c.val);
  if (t === 'str') return String(val) === String(c.val);
  const a = varNum(val);
  const b = varNum(c.val);
  switch (c.op) {
    case '==': return a === b;
    case '!=': return a !== b;
    case '>': return a > b;
    case '<': return a < b;
    case '>=': return a >= b;
    case '<=': return a <= b;
    default: return a === b;
  }
}

/** Переменная, перебивающая условия развилки (branchVarOverride): связь tin:'var' от varnode. */
export function branchVarOverride(doc: VetviDoc, n: VetviNode | null): string | null {
  if (!n || n.type !== 'branch') return null;
  for (const e of doc.edges) {
    if (e.to !== n.id || e.tin !== 'var') continue;
    const src = doc.nodes.find((x) => x.id === e.from);
    if (src && src.type === 'varnode' && src.vid) return src.vid;
  }
  return null;
}

export function condWithOverride(doc: VetviDoc, c: Cond | null | undefined, fn: VetviNode | null): Cond | null {
  if (!c || !fn || fn.type !== 'branch') return c || null;
  const ov = branchVarOverride(doc, fn);
  if (!ov || ov === c.vid) return c;
  return { vid: ov, op: c.op, val: c.val };
}

/** Текст плашки ноды переменной (nodeVarChipText). */
export function varNodeChipText(doc: VetviDoc, n: VetviNode): string {
  const v = varById(doc, n.vid);
  if (!v) return 'переменная не выбрана';
  if (n.varMode === 'get') return 'чтение: ' + v.name;
  return v.name + ' ' + opSym(n.varOp) + ' ' + varValText(n.varVal, v);
}

/** Удаление переменной с чисткой привязок (как deleteVar оригинала). */
export function cleanupVarRefs(doc: VetviDoc, vid: string): void {
  for (const n of doc.nodes) {
    if (n.type === 'varnode') n.vid = n.vid === vid ? null : n.vid;
    if (n.type === 'branch' && Array.isArray(n.outcomes)) {
      for (const o of n.outcomes as unknown as { cond?: Cond | null; conds?: Cond[] | null }[]) {
        if (o.cond && o.cond.vid === vid) o.cond = null;
        if (Array.isArray(o.conds)) o.conds = o.conds.filter((c) => c && c.vid !== vid);
      }
    }
  }
  for (const e of doc.edges) {
    const ce = e as unknown as { cond?: Cond | null };
    if (ce.cond && ce.cond.vid === vid) ce.cond = null;
  }
}
