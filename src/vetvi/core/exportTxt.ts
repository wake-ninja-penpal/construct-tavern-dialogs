/**
 * Ветви — экспорт проекта в текстовый файл (exportTXT оригинала, 10255–10327
 * + помощники wrapText/indent 10204–10219 и dlgExportText 10220–10253).
 * Чистая функция над документом — без DOM (скачивание делает вызывающий).
 */

import { KIND_RU, MAX_DLG_DEPTH, STATUS_RU, TYPES } from './constants';
import { countReplies, findReply } from './dialog';
import { ensureDialog } from './factory';
import { stripRtfx } from './rtfx';
import type { VetviDoc, VetviNode, VetviReply } from './types';

/* ── свои типы документа: id/name/color/icon (customTypes pass-through) ── */

interface TypeRec { id: string; name: string; color: string; icon?: string }

function customTypesOf(doc: VetviDoc): TypeRec[] {
  const arr: unknown[] = Array.isArray(doc.customTypes) ? (doc.customTypes as unknown[]) : [];
  const out: TypeRec[] = [];
  for (const raw of arr) {
    if (!raw || typeof raw !== 'object') continue;
    const c = raw as Record<string, unknown>;
    if (typeof c.id !== 'string' || !c.id) continue;
    out.push({
      id: c.id,
      name: typeof c.name === 'string' && c.name ? c.name : 'Свой тип',
      color: typeof c.color === 'string' && c.color ? c.color : '#8b929c',
      icon: typeof c.icon === 'string' && c.icon ? c.icon : 'star',
    });
  }
  return out;
}

function customById(doc: VetviDoc, id: string): TypeRec | null {
  return customTypesOf(doc).find((c) => c.id === id) || null;
}

/** typeInfo(key) оригинала (2926): встроенный → свой тип → заметка. */
export function typeInfoOf(doc: VetviDoc, key: string): { name: string; color: string; icon: string } {
  const t = TYPES[key];
  if (t) {
    const icons: Record<string, string> = {
      scene: 'scene', quest: 'quest', dialog: 'dialog', skill: 'skill', action: 'action',
      branch: 'branch', varnode: 'variable', event: 'event', note: 'note',
    };
    return { name: t.name, color: t.color, icon: icons[key] || 'star' };
  }
  const c = customById(doc, key);
  if (c) return { name: c.name, color: c.color, icon: c.icon || 'star' };
  return { name: TYPES.note.name, color: TYPES.note.color, icon: 'note' };
}

/** allTypeKeys() оригинала (2963): встроенные + свои. */
export function allTypeKeysOf(doc: VetviDoc): string[] {
  return Object.keys(TYPES).concat(customTypesOf(doc).map((c) => c.id));
}

/* ── помощники переноса строк (10204–10219) ── */

function wrapText(s: string, w: number): string {
  const out: string[] = [];
  String(s).split('\n').forEach((par) => {
    const words = par.split(/\s+/);
    let line = '';
    words.forEach((word) => {
      if (!word) return;
      if ((line ? line + ' ' + word : word).length > w) {
        if (line) out.push(line);
        line = word;
      } else {
        line = line ? line + ' ' + word : word;
      }
    });
    out.push(line);
  });
  return out.join('\n');
}

function indent(s: string, pre: string): string {
  return s.split('\n').map((l) => pre + l).join('\n');
}

/* ── имена участников (charName оригинала, 1715) ── */

function charNameOf(doc: VetviDoc, id: string): string {
  const c = (doc.chars || []).find((x) => x.id === id);
  if (c) return c.name || '(без имени)';
  const n = doc.nodes.find((x) => x.id === id);
  if (n) return n.title || '(без имени)';
  return '(неизвестный)';
}

/* ── диалог (dlgExportText оригинала, 10220–10253) ── */

function dlgExportText(doc: VetviDoc, n: VetviNode): string[] {
  ensureDialog(n);
  const d = n.dialog!;
  const L: string[] = [];
  L.push('◆ Диалог: ' + n.title);
  let meta = 'Статус: ' + (STATUS_RU[n.status] || n.status);
  if (d.participants.length) meta += '  ·  Участники: ' + d.participants.map((p) => charNameOf(doc, p)).join(', ');
  meta += '  ·  Реплик: ' + countReplies(d.replies);
  L.push('  ' + meta);
  if (d.description) L.push('  ' + wrapText(d.description.trim(), 62).split('\n').map((l) => '  ' + l).join('\n').trim());
  const printReplies = (replies: VetviReply[], depth: number) => {
    if (depth >= MAX_DLG_DEPTH) return;
    replies.forEach((r) => {
      let pad = '    ';
      for (let i = 0; i < depth; i++) pad += '  ';
      const name = r.speaker ? charNameOf(doc, r.speaker) : '(неизвестный)';
      L.push(pad + '▸ ' + name + ': ' + (stripRtfx(r.text || '') || '(пусто)'));
      const outs = doc.edges.filter((e) => e.from === n.id && e.fromReply === r.id);
      outs.forEach((e) => {
        const t = doc.nodes.find((x) => x.id === e.to);
        L.push(pad + '     ' + (t ? t.title : '?') + (e.label ? ' [' + e.label + ']' : ''));
      });
      if (r.children && r.children.length) printReplies(r.children, depth + 1);
    });
  };
  printReplies(d.replies, 0);
  const mainOuts = doc.edges.filter((e) => e.from === n.id && !e.fromReply);
  if (mainOuts.length) {
    L.push('  Исход (после диалога):');
    mainOuts.forEach((e) => {
      const t = doc.nodes.find((x) => x.id === e.to);
      L.push('    → ' + (t ? t.title : '?') + (e.label ? ' [' + e.label + ']' : ''));
    });
  }
  return L;
}

/* ── группы (FOLD_NAMES оригинала 1528, membersOf/allDescNodes) ── */

const FOLD_NAMES = ['Компакт', 'Список', 'Развёрнута'];

function membersOf(doc: VetviDoc, gid: string): VetviNode[] {
  return doc.nodes.filter((n) => n.gid === gid);
}

function allDescNodes(doc: VetviDoc, gid: string, visited?: Set<string>): VetviNode[] {
  const seen = visited || new Set<string>();
  if (seen.has(gid)) return [];
  seen.add(gid);
  const out: VetviNode[] = doc.nodes.filter((n) => n.gid === gid);
  for (const cg of doc.groups) if (cg.parent === gid) out.push(...allDescNodes(doc, cg.id, seen));
  return out;
}

function groupOfNode(doc: VetviDoc, n: VetviNode) {
  return n.gid ? doc.groups.find((g) => g.id === n.gid) || null : null;
}

/* ── сам экспорт (exportTXT оригинала, 10255–10327) ── */

export function buildTxtExport(doc: VetviDoc): string {
  const L: string[] = [];
  const title = (doc.meta.name || 'Проект').toUpperCase();
  L.push(title);
  L.push(new Array(Math.min(64, Math.max(title.length, 24)) + 1).join('='));
  L.push('Экспорт из инструмента «Ветви» · ' + new Date().toLocaleString('ru-RU'));
  L.push('Узлов: ' + doc.nodes.length + ' · Связей: ' + doc.edges.length + ' · Групп: ' + doc.groups.length);
  let secNum = 0;
  allTypeKeysOf(doc).forEach((key) => {
    const nodes = doc.nodes.filter((n) => n.type === key);
    if (!nodes.length) return;
    secNum++;
    const info = typeInfoOf(doc, key);
    const head = '[' + secNum + '] ' + info.name.toUpperCase() + (TYPES[key] ? '' : ' (СВОЙ ТИП)') + ' — ' + nodes.length;
    L.push('');
    L.push('');
    L.push(head);
    L.push(new Array(Math.min(64, head.length + 3)).join('-'));
    nodes.forEach((n) => {
      L.push('');
      if (n.type === 'dialog') {
        dlgExportText(doc, n).forEach((line) => L.push(line));
      } else {
        L.push('◆ ' + n.title);
        let meta = 'Статус: ' + (STATUS_RU[n.status] || n.status);
        if (n.tags && n.tags.length) meta += '  ·  Теги: ' + n.tags.join(', ');
        if (n.color) meta += '  ·  Цвет фона: ' + n.color + (n.tint ? ' (' + (n.tint > 0 ? '+' : '') + n.tint + '%)' : '');
        const gg = groupOfNode(doc, n);
        if (gg) meta += '  ·  Группа: ' + gg.name;
        L.push('  ' + meta);
        if (n.text) L.push(indent(wrapText(n.text.trim(), 62), '  '));
        else L.push('  (без описания)');
        const outs = doc.edges.filter((e) => e.from === n.id && !e.fromReply);
        const ins = doc.edges.filter((e) => e.to === n.id);
        if (outs.length || ins.length) {
          L.push('  Связи:');
          outs.forEach((e) => {
            const t = doc.nodes.find((x) => x.id === e.to);
            L.push('    → ' + (t ? t.title : '?') + (e.label ? '  [' + e.label + ']' : '') + '  (' + (KIND_RU[e.kind || 'flow'] || 'обычная') + ')');
          });
          if (ins.length) L.push('    ← входов: ' + ins.length);
        }
      }
    });
  });
  if (doc.groups.length) {
    L.push('');
    L.push('');
    L.push('ГРУППЫ');
    L.push(new Array(41).join('-'));
    const txtGroup = (g: { id: string; name: string; fold?: number; auto?: boolean }, depth: number) => {
      let padStr = '';
      for (let i = 0; i < depth; i++) padStr += '   ';
      L.push(padStr + '■ ' + g.name + '  [' + FOLD_NAMES[g.fold === undefined ? 2 : g.fold] + (g.auto ? ', авторазмер' : '') + '] — узлов: ' + allDescNodes(doc, g.id).length);
      membersOf(doc, g.id).forEach((n) => L.push(padStr + '    · ' + n.title));
      doc.groups.forEach((cg) => { if (cg.parent === g.id) txtGroup(cg, depth + 1); });
    };
    doc.groups.forEach((g) => { if (!g.parent) txtGroup(g, 0); });
  }
  L.push('');
  L.push('');
  L.push('КАРТА СВЯЗЕЙ');
  L.push(new Array(41).join('-'));
  if (!doc.edges.length) L.push('(связей нет)');
  doc.edges.forEach((e) => {
    const a = doc.nodes.find((x) => x.id === e.from);
    const b = doc.nodes.find((x) => x.id === e.to);
    let fromLabel = a ? a.title : '?';
    if (a && a.type === 'dialog' && e.fromReply) {
      ensureDialog(a);
      const r = findReply(a.dialog!.replies, e.fromReply);
      if (r) fromLabel = a.title + ' / «' + stripRtfx(r.text || '').slice(0, 30) + '»';
    }
    L.push(fromLabel + ' → ' + (b ? b.title : '?') + (e.label ? '  [' + e.label + ']' : '') + (e.pts && e.pts.length ? '  (изломов: ' + e.pts.length + ')' : ''));
  });
  return L.join('\r\n');
}

/** slug оригинала (10156): имя файла из названия проекта. */
export function slugOf(s: string): string {
  const r = (s || 'proekt').toLowerCase().replace(/[^a-zа-яё0-9]+/gi, '-').replace(/^-+|-+$/g, '');
  return r.slice(0, 60) || 'proekt';
}
