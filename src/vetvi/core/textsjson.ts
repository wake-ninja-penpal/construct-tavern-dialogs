/**
 * Ветви — лёгкий JSON текстов: экспорт/парсинг (ориг. 10328–10472).
 *
 * Экспорт: {texts:[{id,text}], service:{format:'vetvi-texts-v3', app:'vetvi',
 * project, exported, nodes, links}} — texts собирает тексты нод и реплик
 * (реплика имеет id «<nodeId>:<replyId>»), service — структура нод/связей.
 *
 * Парсинг: v3 (texts:[{id,text}] по id) и v2 (texts:["…"] по индексу),
 * а также старый v1 (nodes+links на верхнем уровне) — для совместимости.
 */

import { TYPES } from './constants';
import { uid } from './factory';
import { ensureDialog } from './factory';
import type { VetviDoc, VetviNode, VetviReply } from './types';

/* ── общие помощники (textsNodeText 10329, textsRepliesOut 10333) ── */

function textsNodeText(n: VetviNode): string {
  if (n.type === 'dialog') {
    ensureDialog(n);
    return (n.dialog && typeof n.dialog.description === 'string') ? n.dialog.description : (n.text || '');
  }
  return n.text || '';
}

interface OutReply { id: string; speaker?: string; text?: string; children?: OutReply[] }

function textsRepliesOut(arr: unknown): OutReply[] {
  const out: OutReply[] = [];
  (Array.isArray(arr) ? arr : []).forEach((r) => {
    if (!r || typeof r !== 'object') return;
    const rr = r as Record<string, unknown>;
    const o: OutReply = {
      id: (typeof rr.id === 'string' && rr.id) ? rr.id : uid(),
      speaker: (typeof rr.speaker === 'string' && rr.speaker) ? rr.speaker : undefined,
      text: (typeof rr.text === 'string') ? rr.text : '',
      children: textsRepliesOut(rr.children),
    };
    if (!o.speaker) delete o.speaker;
    if (!o.children || !o.children.length) delete o.children;
    out.push(o);
  });
  return out;
}

/* ── сборка payload (exportTextsJson 10344–10397) ── */

export interface TextsPayload {
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

/**
 * Сборка «Текстов (JSON)». onlyIds — ограничение выделенными нодами
 * (узлы выделения + содержимое выделенных групп — plSelectionIds оригинала);
 * null — весь проект.
 */
export function buildTextsPayload(doc: VetviDoc, onlyIds: Set<string> | null): { payload: TextsPayload; nRep: number } {
  const texts: { id: string; text: string }[] = [];
  const nodes: Record<string, unknown>[] = [];
  const links: Record<string, unknown>[] = [];
  let nRep = 0;
  const put = (id: string, s: string) => { texts.push({ id, text: s }); };
  const repsOut = (nid: string, arr: unknown): OutReply[] => {
    const out: OutReply[] = [];
    (Array.isArray(arr) ? arr : []).forEach((r) => {
      if (!r || typeof r !== 'object') return;
      const rr = r as Record<string, unknown>;
      const rid = (typeof rr.id === 'string' && rr.id) ? rr.id : uid();
      const o: OutReply = { id: rid };
      if (typeof rr.text === 'string' && rr.text) put(nid + ':' + rid, rr.text);
      if (typeof rr.speaker === 'string' && rr.speaker) o.speaker = rr.speaker;
      const ch = repsOut(nid, rr.children);
      if (ch.length) o.children = ch;
      out.push(o);
      nRep++;
    });
    return out;
  };
  doc.nodes.forEach((n) => {
    if (onlyIds && !onlyIds.has(n.id)) return;
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
      const oc = n.outcomes
        .filter((x: Record<string, unknown>) => x && typeof x.id === 'string')
        .map((x: Record<string, unknown>) => ({ id: x.id, label: String(x.label || '') }));
      if (oc.length) o.outcomes = oc;
    }
    nodes.push(o);
  });
  doc.edges.forEach((e) => {
    if (onlyIds && !(onlyIds.has(e.from) && onlyIds.has(e.to))) return;
    const o: Record<string, unknown> = { from: e.from, to: e.to };
    if (e.label) o.label = e.label;
    if (e.fromReply) o.fromReply = e.fromReply;
    if (e.fromOut) o.fromOut = e.fromOut;
    links.push(o);
  });
  const nm = doc.meta.name || '';
  const payload: TextsPayload = {
    texts,
    service: {
      format: 'vetvi-texts-v3',
      app: 'vetvi',
      project: onlyIds ? ((nm ? nm + ' — ' : '') + 'выделенные ноды (' + nodes.length + ')') : nm,
      exported: new Date().toISOString(),
      nodes,
      links,
    },
  };
  return { payload, nRep };
}

/* ── парсинг файла импорта (textsImpParse 10398–10472) ── */

export interface ImpNode {
  id: string;
  title: string | null;
  text: string | null;
  type: string | null;
  replies: OutReply[] | null;
  outcomes: { id: string; label: string }[] | null;
}

export interface ImpData {
  nodes: ImpNode[];
  links: { from: string; to: string; label: string | null; fromReply: string | null; fromOut: string | null }[];
  skip: number;
  tx: number | null;
  srcName: string;
  fmt: string;
}

export type ImpResult = { err: string } | { data: ImpData };

function parseLinks(src: unknown): ImpData['links'] {
  const links: ImpData['links'] = [];
  (Array.isArray(src) ? src : []).forEach((l) => {
    if (!l || typeof l !== 'object') return;
    const ll = l as Record<string, unknown>;
    if (typeof ll.from !== 'string' || !ll.from || typeof ll.to !== 'string' || !ll.to) return;
    links.push({
      from: ll.from,
      to: ll.to,
      label: (typeof ll.label === 'string') ? ll.label : null,
      fromReply: (typeof ll.fromReply === 'string' && ll.fromReply) ? ll.fromReply : null,
      fromOut: (typeof ll.fromOut === 'string' && ll.fromOut) ? ll.fromOut : null,
    });
  });
  return links;
}

function repliesV3(nid: string, arr: unknown, pick: (i: number) => string | null, pickId: (id: string) => string | null): OutReply[] {
  const out: OutReply[] = [];
  (Array.isArray(arr) ? arr : []).forEach((r) => {
    if (!r || typeof r !== 'object') return;
    const rr = r as Record<string, unknown>;
    const rid = (typeof rr.id === 'string' && rr.id) ? rr.id : uid();
    let t = pickId(nid + ':' + rid);
    if (t === null) t = pick(rr.i as number);
    const o: OutReply = {
      id: rid,
      speaker: (typeof rr.speaker === 'string' && rr.speaker) ? rr.speaker : undefined,
      text: (t !== null) ? t : '',
      children: repliesV3(nid, rr.children, pick, pickId),
    };
    if (!o.speaker) delete o.speaker;
    out.push(o);
  });
  return out;
}

function parseOutcomes(x: Record<string, unknown>): { id: string; label: string }[] | null {
  if (!Array.isArray(x.outcomes)) return null;
  const oc = x.outcomes
    .filter((o) => o && typeof o === 'object' && typeof (o as Record<string, unknown>).id === 'string' && (o as Record<string, unknown>).id)
    .map((o) => {
      const oo = o as Record<string, unknown>;
      return { id: String(oo.id).slice(0, 40), label: (typeof oo.label === 'string') ? oo.label : '' };
    });
  return oc.length ? oc : null;
}

function parseReplies(nid: string, x: Record<string, unknown>, v3: boolean, pick?: (i: number) => string | null, pickId?: (id: string) => string | null): OutReply[] | null {
  if (!Array.isArray(x.replies)) return null;
  const rp = v3
    ? repliesV3(nid, x.replies, pick as (i: number) => string | null, pickId as (id: string) => string | null)
    : textsRepliesOut(x.replies);
  return rp.length ? rp : null;
}

/** Парсер файла «Текстов (JSON)»: v3/v2 (service) или v1 (nodes+links). */
export function textsImpParse(str: string): ImpResult {
  let p: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = JSON.parse(str);
    p = (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed as Record<string, unknown> : null;
  } catch {
    return { err: 'Не удалось разобрать JSON — проверьте синтаксис' };
  }
  if (!p) return { err: 'Не удалось разобрать JSON — это не объект' };
  const finish = (nodes: ImpNode[], links: ImpData['links'], skip: number, srcName: string, fmt: string, tx: number | null): ImpResult => {
    if (!nodes.length) return { err: 'В файле нет ни одной ноды с id' + (skip ? ' — записей без id пропущено: ' + skip : '') };
    return { data: { nodes, links, skip, tx, srcName, fmt } };
  };

  /* Форматы «texts» + «service»: v3 — texts:[{id,text}] (по id), v2 — texts:["…"] (по индексу) */
  if (p.service && typeof p.service === 'object' && !Array.isArray(p.service)) {
    const sv = p.service as Record<string, unknown>;
    const texts: unknown[] = Array.isArray(p.texts) ? p.texts : [];
    const nodes: ImpNode[] = [];
    let skip = 0;
    const tmap: Record<string, string> = {};
    let tcount = 0;
    let hasObj = false;
    texts.forEach((t) => {
      if (t && typeof t === 'object' && !Array.isArray(t)) {
        hasObj = true;
        const tt = t as Record<string, unknown>;
        if (typeof tt.id === 'string' && tt.id && typeof tt.text === 'string' && !(tt.id in tmap)) {
          tmap[tt.id] = tt.text;
          tcount++;
        }
      }
    });
    const pick = (i: unknown) => (typeof i === 'number' && i >= 0 && i < texts.length && typeof texts[i] === 'string') ? texts[i] as string : null;
    const pickId = (id: unknown) => (id && Object.prototype.hasOwnProperty.call(tmap, id as PropertyKey)) ? tmap[id as string] : null;
    (Array.isArray(sv.nodes) ? sv.nodes : []).forEach((x) => {
      if (!x || typeof x !== 'object') return;
      const xx = x as Record<string, unknown>;
      if (typeof xx.id !== 'string' || !xx.id) { skip++; return; }
      let tx = pickId(xx.id);
      if (tx === null) tx = pick(xx.i);
      const en: ImpNode = {
        id: xx.id,
        title: (typeof xx.title === 'string') ? xx.title : null,
        text: tx,
        type: (typeof xx.type === 'string' && TYPES[xx.type]) ? xx.type : null,
        replies: parseReplies(xx.id, xx, true, pick, pickId),
        outcomes: parseOutcomes(xx),
      };
      nodes.push(en);
    });
    return finish(nodes, parseLinks(sv.links), skip, (typeof sv.project === 'string') ? sv.project : '', (typeof sv.format === 'string') ? sv.format : '', hasObj ? tcount : texts.length);
  }

  /* Старый формат v1 (nodes + links на верхнем уровне) — для совместимости */
  if (!Array.isArray(p.nodes)) return { err: 'Это не JSON текстов «Ветвей» — нужен массив «texts» и служебный блок «service»' };
  const nodes: ImpNode[] = [];
  let skip = 0;
  p.nodes.forEach((x) => {
    if (!x || typeof x !== 'object') return;
    const xx = x as Record<string, unknown>;
    if (typeof xx.id !== 'string' || !xx.id) { skip++; return; }
    const en: ImpNode = {
      id: xx.id,
      title: (typeof xx.title === 'string') ? xx.title : null,
      text: (typeof xx.text === 'string') ? xx.text : null,
      type: (typeof xx.type === 'string' && TYPES[xx.type]) ? xx.type : null,
      replies: parseReplies(xx.id, xx, false),
      outcomes: parseOutcomes(xx),
    };
    nodes.push(en);
  });
  return finish(nodes, parseLinks(p.links), skip, (typeof p.project === 'string') ? p.project : '', (typeof p.format === 'string') ? p.format : '', null);
}
