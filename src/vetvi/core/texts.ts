/**
 * Ветви — «Лёгкий JSON текстов»: экспорт/импорт текстов нод и связей.
 *
 * Порт классических exportTextsJson / textsImpParse / textsImpStep2-данных /
 * textsImpApply (index.html 10328–10600) без DOM: функции работают с документом,
 * файл собирает и скачивает store (downloadJson из core/projects).
 *
 * Формат «Текстов (JSON)» v3 (1:1 с оригиналом, строка 10390):
 * { texts: [{id, text}], service: { format: 'vetvi-texts-v3', app: 'vetvi',
 *   project, exported, nodes: [{id,title?,type?,replies?,outcomes?}],
 *   links: [{from,to,label?,fromReply?,fromOut?}] } }
 * Тексты сопоставляются по id (текст реплики — ключ «nodeId:replyId»);
 * читаются и старые форматы v2 (texts-строки по индексу r.i/x.i) и v1
 * (nodes+links на верхнем уровне, тексты внутри нод).
 */

import { TYPES } from './constants';
import { findReply } from './dialog';
import { ensureDialog, uid } from './factory';
import type { VetviDoc, VetviNode, VetviReply } from './types';

/* ═══ экспорт (exportTextsJson, 10329–10397) ═══ */

/** textsNodeText оригинала: текст ноды (у диалога — описание). */
export function textsNodeText(n: VetviNode): string {
  if (n.type === 'dialog') {
    ensureDialog(n);
    return n.dialog && typeof n.dialog.description === 'string' ? n.dialog.description : (n.text || '');
  }
  return n.text || '';
}

/** textsRepliesOut оригинала (v1-формат и заготовка): реплики с текстом внутри. */
export function textsRepliesOut(arr: unknown): { id: string; speaker: string | null; text: string; children?: unknown[] }[] {
  const out: { id: string; speaker: string | null; text: string; children?: unknown[] }[] = [];
  for (const r of Array.isArray(arr) ? arr as unknown[] : []) {
    if (!r || typeof r !== 'object') continue;
    const rr = r as Record<string, unknown>;
    out.push({
      id: (typeof rr.id === 'string' && rr.id) ? rr.id : uid(),
      speaker: (typeof rr.speaker === 'string' && rr.speaker) ? rr.speaker : null,
      text: (typeof rr.text === 'string') ? rr.text : '',
      children: textsRepliesOut(rr.children),
    });
  }
  return out;
}

export interface TxTextsOut {
  texts: { id: string; text: string }[];
  service: {
    format: string;
    app: string;
    project: string;
    exported: string;
    nodes: Record<string, unknown>[];
    links: Record<string, unknown>[];
  };
}

export interface TxExportStat { texts: number; nodes: number; nRep: number }

/** exportTextsJson оригинала (10344–10397) без download/toast: строит объект + счётчики. */
export function buildTextsExport(doc: VetviDoc, selIds: Set<string> | null): { out: TxTextsOut; stat: TxExportStat } {
  const texts: { id: string; text: string }[] = [];
  const nodes: Record<string, unknown>[] = [];
  const links: Record<string, unknown>[] = [];
  let nRep = 0;
  const put = (id: string, s: string) => { texts.push({ id, text: s }); };
  const repsOut = (nid: string, arr: unknown): Record<string, unknown>[] => {
    const out: Record<string, unknown>[] = [];
    for (const r of Array.isArray(arr) ? arr as unknown[] : []) {
      if (!r || typeof r !== 'object') continue;
      const rr = r as Record<string, unknown>;
      const rid = (typeof rr.id === 'string' && rr.id) ? rr.id : uid();
      const o: Record<string, unknown> = { id: rid };
      if (typeof rr.text === 'string' && rr.text) put(nid + ':' + rid, rr.text);
      if (typeof rr.speaker === 'string' && rr.speaker) o.speaker = rr.speaker;
      const ch = repsOut(nid, rr.children);
      if (ch.length) o.children = ch;
      out.push(o);
      nRep++;
    }
    return out;
  };
  doc.nodes.forEach((n) => {
    if (selIds && !selIds.has(n.id)) return;
    const o: Record<string, unknown> = { id: n.id };
    const tx = textsNodeText(n);
    if (tx) put(n.id, tx);
    if (n.title) o.title = n.title;
    if (TYPES[n.type]) o.type = n.type;
    if (n.type === 'dialog') {
      ensureDialog(n);
      const rp = repsOut(n.id, n.dialog!.replies);
      if (rp.length) o.replies = rp;
    }
    if (n.type === 'branch' && Array.isArray(n.outcomes) && n.outcomes.length) {
      const oc = (n.outcomes as { id?: unknown; label?: unknown }[])
        .filter((x) => x && typeof x.id === 'string')
        .map((x) => ({ id: x.id as string, label: String(x.label || '') }));
      if (oc.length) o.outcomes = oc;
    }
    nodes.push(o);
  });
  doc.edges.forEach((e) => {
    if (selIds && !(selIds.has(e.from) && selIds.has(e.to))) return;
    const o: Record<string, unknown> = { from: e.from, to: e.to };
    if (e.label) o.label = e.label;
    if (e.fromReply) o.fromReply = e.fromReply;
    if (e.fromOut) o.fromOut = e.fromOut;
    links.push(o);
  });
  const nm = doc.meta.name || '';
  const out: TxTextsOut = {
    texts,
    service: {
      format: 'vetvi-texts-v3',
      app: 'vetvi',
      project: selIds ? ((nm ? nm + ' — ' : '') + 'выделенные ноды (' + nodes.length + ')') : nm,
      exported: new Date().toISOString(),
      nodes,
      links,
    },
  };
  return { out, stat: { texts: texts.length, nodes: nodes.length, nRep } };
}

/** slug оригинала (10156): имя файла из названия проекта. */
export function slug(s: string): string {
  const r = (s || 'proekt').toLowerCase().replace(/[^a-zа-яё0-9]+/gi, '-').replace(/^-+|-+$/g, '');
  return r.slice(0, 60) || 'proekt';
}

/* ═══ разбор файла импорта (textsImpParse, 10398–10472) ═══ */

export interface TxImpReply { id: string; speaker: string | null; text: string; children?: TxImpReply[] }

export interface TxImpNode {
  id: string;
  title: string | null;
  text: string | null;
  type: string | null;
  replies: TxImpReply[] | null;
  outcomes: { id: string; label: string }[] | null;
}

export interface TxImpLink {
  from: string;
  to: string;
  label: string | null;
  fromReply: string | null;
  fromOut: string | null;
}

export interface TxImpData {
  nodes: TxImpNode[];
  links: TxImpLink[];
  skip: number;
  /** количество текстов в файле (v3/v2) или null (v1 — тексты внутри нод). */
  tx: number | null;
  srcName: string;
  fmt: string;
}

export type TxImpParseResult = { err: string } | { data: TxImpData };

function txImpParseLinks(src: unknown): TxImpLink[] {
  const links: TxImpLink[] = [];
  for (const l of Array.isArray(src) ? src as unknown[] : []) {
    if (!l || typeof l !== 'object') continue;
    const ll = l as Record<string, unknown>;
    if (typeof ll.from !== 'string' || !ll.from || typeof ll.to !== 'string' || !ll.to) continue;
    links.push({
      from: ll.from,
      to: ll.to,
      label: (typeof ll.label === 'string') ? ll.label : null,
      fromReply: (typeof ll.fromReply === 'string' && ll.fromReply) ? ll.fromReply : null,
      fromOut: (typeof ll.fromOut === 'string' && ll.fromOut) ? ll.fromOut : null,
    });
  }
  return links;
}

/** textsImpParse оригинала: форматы «texts»+«service» v3/v2 и старый v1. */
export function textsImpParse(str: string): TxImpParseResult {
  let p: unknown;
  try { p = JSON.parse(str); } catch { return { err: 'Не удалось разобрать JSON — проверьте синтаксис' }; }
  if (!p || typeof p !== 'object' || Array.isArray(p)) return { err: 'Не удалось разобрать JSON — это не объект' };
  const obj = p as Record<string, unknown>;
  const finish = (nodes: TxImpNode[], links: TxImpLink[], skip: number, srcName: string, fmt: string, tx: number | null): TxImpParseResult => {
    if (!nodes.length) return { err: 'В файле нет ни одной ноды с id' + (skip ? ' — записей без id пропущено: ' + skip : '') };
    return { data: { nodes, links, skip, tx, srcName, fmt } };
  };
  const parseOutcomes = (src: unknown): { id: string; label: string }[] | null => {
    if (!Array.isArray(src)) return null;
    const oc = (src as unknown[])
      .filter((o) => o && typeof o === 'object' && typeof (o as Record<string, unknown>).id === 'string' && (o as Record<string, unknown>).id)
      .map((o) => {
        const oo = o as Record<string, unknown>;
        return { id: (oo.id as string).slice(0, 40), label: (typeof oo.label === 'string') ? oo.label : '' };
      });
    return oc.length ? oc : null;
  };
  /* Форматы «texts» + «service»: v3 — texts:[{id,text}] (по id), v2 — texts:["…"] (по индексу) */
  if (obj.service && typeof obj.service === 'object' && !Array.isArray(obj.service)) {
    const sv = obj.service as Record<string, unknown>;
    const texts = Array.isArray(obj.texts) ? obj.texts as unknown[] : [];
    const nodes: TxImpNode[] = [];
    let skip = 0;
    const tmap: Record<string, string> = {};
    let tcount = 0;
    let hasObj = false;
    texts.forEach((t) => {
      if (t && typeof t === 'object' && !Array.isArray(t)) {
        hasObj = true;
        const tt = t as Record<string, unknown>;
        if (typeof tt.id === 'string' && tt.id && typeof tt.text === 'string' && !(tt.id in tmap)) { tmap[tt.id] = tt.text; tcount++; }
      }
    });
    const pick = (i: unknown) => (typeof i === 'number' && i >= 0 && i < texts.length && typeof texts[i] === 'string') ? texts[i] as string : null;
    const pickId = (id: string) => (id && Object.prototype.hasOwnProperty.call(tmap, id)) ? tmap[id] : null;
    const repliesV3 = (nid: string, arr: unknown): TxImpReply[] => {
      const out: TxImpReply[] = [];
      for (const r of Array.isArray(arr) ? arr as unknown[] : []) {
        if (!r || typeof r !== 'object') continue;
        const rr = r as Record<string, unknown>;
        const rid = (typeof rr.id === 'string' && rr.id) ? rr.id : uid();
        let t = pickId(nid + ':' + rid);
        if (t === null) t = pick(rr.i);
        out.push({
          id: rid,
          speaker: (typeof rr.speaker === 'string' && rr.speaker) ? rr.speaker : null,
          text: (t !== null) ? t : '',
          children: repliesV3(nid, rr.children),
        });
      }
      return out;
    };
    for (const x of Array.isArray(sv.nodes) ? sv.nodes as unknown[] : []) {
      if (!x || typeof x !== 'object') continue;
      const xx = x as Record<string, unknown>;
      if (typeof xx.id !== 'string' || !xx.id) { skip++; continue; }
      let tx = pickId(xx.id);
      if (tx === null) tx = pick(xx.i);
      const en: TxImpNode = {
        id: xx.id,
        title: (typeof xx.title === 'string') ? xx.title : null,
        text: tx,
        type: (typeof xx.type === 'string' && TYPES[xx.type]) ? xx.type : null,
        replies: null,
        outcomes: null,
      };
      const rp = repliesV3(xx.id, xx.replies);
      if (rp.length) en.replies = rp;
      en.outcomes = parseOutcomes(xx.outcomes);
      nodes.push(en);
    }
    return finish(nodes, txImpParseLinks(sv.links), skip, (typeof sv.project === 'string') ? sv.project : '', (typeof sv.format === 'string') ? sv.format : '', hasObj ? tcount : texts.length);
  }
  /* Старый формат v1 (nodes + links на верхнем уровне) — для совместимости */
  if (!Array.isArray(obj.nodes)) return { err: 'Это не JSON текстов «Ветвей» — нужен массив «texts» и служебный блок «service»' };
  const nodes: TxImpNode[] = [];
  let skip = 0;
  for (const x of obj.nodes as unknown[]) {
    if (!x || typeof x !== 'object') continue;
    const xx = x as Record<string, unknown>;
    if (typeof xx.id !== 'string' || !xx.id) { skip++; continue; }
    const en: TxImpNode = {
      id: xx.id,
      title: (typeof xx.title === 'string') ? xx.title : null,
      text: (typeof xx.text === 'string') ? xx.text : null,
      type: (typeof xx.type === 'string' && TYPES[xx.type]) ? xx.type : null,
      replies: null,
      outcomes: null,
    };
    if (Array.isArray(xx.replies)) {
      const rp = textsRepliesOut(xx.replies) as TxImpReply[];
      if (rp.length) en.replies = rp;
    }
    en.outcomes = parseOutcomes(xx.outcomes);
    nodes.push(en);
  }
  return finish(nodes, txImpParseLinks(obj.links), skip, (typeof obj.project === 'string') ? obj.project : '', (typeof obj.format === 'string') ? obj.format : '', null);
}

/* ═══ превью проверки (данные textsImpStep2, 10498–10503) ═══ */

export interface TxImpPreview { matched: TxImpNode[]; fresh: TxImpNode[]; hasRep: boolean; hasOut: boolean }

/** Сопоставление по id с нодами проекта + признаки реплик/развилок в файле. */
export function textsImpPreview(doc: VetviDoc, d: TxImpData): TxImpPreview {
  const have: Record<string, boolean> = {};
  doc.nodes.forEach((n) => { have[n.id] = true; });
  const matched: TxImpNode[] = [];
  const fresh: TxImpNode[] = [];
  d.nodes.forEach((en) => { (have[en.id] ? matched : fresh).push(en); });
  return {
    matched,
    fresh,
    hasRep: d.nodes.some((en) => !!en.replies),
    hasOut: d.nodes.some((en) => !!en.outcomes),
  };
}

/* ═══ применение (textsImpApply, 10530–10600) ═══ */

export interface TxImpOpt { upd: boolean; cre: boolean; med: boolean; lnk: boolean }

export interface TxImpStat { upd: number; cre: number; rep: number; out: number; lnkUp: number; lnkNew: number; lnkSkip: number }

/**
 * textsImpApply оригинала: мутация документа (историю/тосты ведёт store).
 * Совпавшие ноды обновляются по opt.upd/opt.med, отсутствующие создаются
 * сеткой 4 колонки от левого верхнего угла проекта (opt.cre), связи
 * синхронизируются по паре from/to+fromReply/fromOut (opt.lnk).
 */
export function textsImpApply(doc: VetviDoc, d: TxImpData, opt: TxImpOpt): { stat: TxImpStat } {
  const stat: TxImpStat = { upd: 0, cre: 0, rep: 0, out: 0, lnkUp: 0, lnkNew: 0, lnkSkip: 0 };
  const byId: Record<string, VetviNode> = {};
  const have: Record<string, boolean> = {};
  doc.nodes.forEach((n) => { byId[n.id] = n; have[n.id] = true; });
  let bx = 1e9;
  let by = 1e9;
  doc.nodes.forEach((n) => { if (n.x < bx) bx = n.x; if (n.y < by) by = n.y; });
  if (bx > 1e8) { bx = 100; by = 100; }
  let col = 0;
  let row = 0;
  d.nodes.forEach((en) => {
    const n = byId[en.id];
    if (n) {
      if (opt.upd) {
        let ch = false;
        if (en.title !== null && n.title !== en.title) { n.title = en.title; ch = true; }
        if (en.text !== null) {
          if (n.type === 'dialog') {
            ensureDialog(n);
            if (n.dialog!.description !== en.text || n.text !== en.text) { n.dialog!.description = en.text; n.text = en.text; ch = true; }
          } else if (n.text !== en.text) { n.text = en.text; ch = true; }
        }
        if (opt.med) {
          if (en.replies && n.type === 'dialog') {
            ensureDialog(n);
            n.dialog!.replies = en.replies as unknown as VetviReply[];
            stat.rep++;
            ch = true;
          }
          if (en.outcomes && n.type === 'branch' && Array.isArray(n.outcomes)) {
            const outs = n.outcomes as { id: string; label: string; cond?: unknown }[];
            en.outcomes.forEach((oo) => {
              let hit: { id: string; label: string; cond?: unknown } | null = null;
              for (const x of outs) { if (x && x.id === oo.id) { hit = x; break; } }
              if (hit) {
                if (hit.label !== oo.label) { hit.label = oo.label; ch = true; }
              } else {
                outs.push({ id: (typeof oo.id === 'string' && oo.id) ? oo.id.slice(0, 40) : uid(), label: oo.label, cond: null });
                if (outs.length > 24) outs.length = 24;
                ch = true;
              }
            });
            stat.out++;
          }
        }
        if (ch) stat.upd++;
      }
      return;
    }
    if (!opt.cre) return;
    const t = (en.type && TYPES[en.type]) ? en.type : 'note';
    const nn = {
      id: en.id,
      type: t,
      gid: null,
      x: Math.round(bx + col * 300 + (row % 2) * 60),
      y: Math.round(by + 170 + row * 210),
      title: (en.title !== null) ? en.title : TYPES[t].name,
      text: '',
      status: 'idea',
      tags: [] as string[],
      expand: 1,
      color: null,
      tint: -60,
      dlgWidth: null,
    } as VetviNode;
    if (t === 'dialog') {
      ensureDialog(nn);
      if (en.text !== null) { nn.dialog!.description = en.text; nn.text = en.text; }
      if (opt.med && en.replies) nn.dialog!.replies = en.replies as unknown as VetviReply[];
    } else if (en.text !== null) nn.text = en.text;
    if (t === 'branch' && opt.med && en.outcomes) {
      nn.outcomes = en.outcomes.map((oo) => ({ id: oo.id, label: oo.label, cond: null }));
    }
    doc.nodes.push(nn);
    byId[nn.id] = nn;
    have[nn.id] = true;
    col++;
    if (col >= 4) { col = 0; row++; }
    stat.cre++;
  });
  if (opt.lnk) {
    d.links.forEach((l) => {
      if (!have[l.from] || !have[l.to] || l.from === l.to) { stat.lnkSkip++; return; }
      let fr = l.fromReply;
      let fo = l.fromOut;
      const fnode = byId[l.from];
      if (fo && !(fnode && fnode.type === 'branch' && Array.isArray(fnode.outcomes) && (fnode.outcomes as { id?: unknown }[]).some((o) => o && o.id === fo))) fo = null;
      if (fr && !(fnode && fnode.type === 'dialog' && findReply((fnode.dialog && fnode.dialog.replies) || [], fr))) fr = null;
      const hit = doc.edges.find((e) => e.from === l.from && e.to === l.to && (e.fromReply || null) === fr && (e.fromOut || null) === fo);
      if (hit) {
        if (l.label !== null && hit.label !== l.label) { hit.label = l.label; stat.lnkUp++; }
      } else {
        doc.edges.push({
          id: uid(), from: l.from, to: l.to,
          label: (l.label !== null) ? l.label : '',
          kind: 'flow', pts: [], lt: 0.5, lp: 0,
          fromReply: fr, fromOut: fo,
          tin: null, bd: { dl: 0, dy: 0, dr: 0 }, cond: null, q: 1,
        });
        stat.lnkNew++;
      }
    });
  }
  return { stat };
}
