'use client';

/**
 * Ветви — слой групп: рамки (fold=2), карточки со списком (fold=1),
 * компакты (fold=0), ярлыки, выделение, перенос, ресайз, сворачивание,
 * цепочки нод (stack): .qcard со строками .q-item, стрелками «кто за кем»
 * (.q-svg/.q-conn), портами входа/выхода (.qport) и перетаскиванием строк.
 * DOM 1:1 с оригиналом: .groupbox/.gcard + .gb-head, .qcard + .q-head/.q-list/
 * .q-item/.q-link/.q-svg, .qport.in/.out, #qGhost (элемент рисует CanvasBoard).
 * (оригинал: renderGroups 3440–3560, q-хелперы 3300–3439, qRowDrag 7390–7425)
 */

import { Fragment, useEffect, useLayoutEffect, useRef } from 'react';

import { clamp, nodeColor, screenToWorld, shadeHex } from '@/vetvi/core/geometry';
import { stackOrderIds } from '@/vetvi/core/chains';
import { condText, condWithOverride } from '@/vetvi/core/vars';
import { getMe } from '@/vetvi/core/identity';
import type { NodeSize, VetviDoc, VetviEdge, VetviGroup, VetviNode, VetviViewport } from '@/vetvi/core/types';
import { allDescNodes, groupFrameRect } from './ggroups';
import type { VetviStore } from './store';
import { ctxMenus } from './ctxMenus';

/** hexToRgba оригинала: hex → rgba(r,g,b,a). */
function hexToRgba(hex: string, a: number): string {
  const h = String(hex || '').replace('#', '');
  const s = h.length === 3 ? h[0] + h[0] + h[1] + h[1] + h[2] + h[2] : h;
  const r = parseInt(s.slice(0, 2), 16);
  const g = parseInt(s.slice(2, 4), 16);
  const b = parseInt(s.slice(4, 6), 16);
  if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return 'rgba(154,161,172,' + a + ')';
  return 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
}

/** ic() оригинала: линейные иконки 24×24 (stroke currentColor). */
function ic(name: 'target' | 'chev' | 'chevUp' | 'expand' | 'queue', size: number): React.ReactNode {
  let body: React.ReactNode;
  if (name === 'target') body = <><circle cx="12" cy="12" r="7" /><path d="M12 2v4M12 18v4M2 12h4M18 12h4" /></>;
  else if (name === 'chev') body = <path d="m6 9 6 6 6-6" />;
  else if (name === 'chevUp') body = <path d="m6 15 6-6 6 6" />;
  else if (name === 'queue') body = <><path d="M8 6h12M8 12h12M8 18h12" /><circle cx="3.7" cy="6" r="1.1" /><circle cx="3.7" cy="12" r="1.1" /><circle cx="3.7" cy="18" r="1.1" /></>;
  else body = <path d="M9 9 4 4m0 0v4M4 4h4M15 9l5-5m0 0v4M20 4h-4M9 15l-5 5m0 0v-4M4 20h4M15 15l5 5m0 0v-4M20 20h-4" />;
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">{body}</svg>
  );
}

/* ═══ цепочки: хелперы оригинала (3300–3439, без истории) ═══ */

/** applyQueueStyle (3307–3324): фон/рамка от цвета + CSS-переменные --qc/--qcb/--qcbg/--qchov/--qrow. */
function queueStyle(g: VetviGroup): { background?: string; borderColor?: string; vars: Record<string, string> } {
  const c = g.color ? shadeHex(g.color, clamp(typeof g.tint === 'number' ? g.tint : 0, -60, 60)) : null;
  const vars: Record<string, string> = {
    ['--qc']: c || '#9aa1ac',
    ['--qcb']: hexToRgba(c || '#9aa1ac', 0.25),
    ['--qcbg']: hexToRgba(c || '#9aa1ac', 0.16),
    ['--qchov']: hexToRgba(c || '#9aa1ac', 0.6),
  };
  if (c) vars['--qrow'] = 'linear-gradient(' + shadeHex(c, 16) + ',' + shadeHex(c, 2) + ')';
  return {
    background: c ? 'linear-gradient(' + shadeHex(c, 10) + ',' + shadeHex(c, -8) + ')' : undefined,
    borderColor: c ? shadeHex(c, -30) : undefined,
    vars,
  };
}

/** qRowCast (3327–3337): участники строки — цвет первого персонажа + плашки имён. */
function qRowCast(store: VetviStore, n: VetviNode): { ps: string[]; color: string | null; html: React.ReactNode } {
  let ps = (n.type === 'dialog')
    ? (((n.dialog && n.dialog.participants) || []))
    : (Array.isArray(n.participants) ? (n.participants as string[]) : []);
  ps = ps.filter((p) => !!store.charById(p) || !!store.nodeById(p));
  const cc = ps.length ? store.charColor(ps[0]) : null;
  const html = ps.length ? (
    <div className="q-cast">
      {ps.map((pid) => (
        <span key={pid} title="Прикреплённый персонаж" style={{ background: store.charColor(pid) }}>{store.charName(pid)}</span>
      ))}
    </div>
  ) : null;
  return { ps, color: cc, html };
}

/** qLinkInfo (3341–3346): связь между соседями строк — сначала q, затем не-var. */
function qLinkInfo(doc: VetviDoc, a: VetviNode, b: VetviNode): VetviEdge | null {
  if (!a || !b) return null;
  for (const e of doc.edges) if (e.from === a.id && e.to === b.id && e.q) return e;
  for (const e of doc.edges) if (e.from === a.id && e.to === b.id && e.tin !== 'var') return e;
  return null;
}

/** qLinkTagText (3347–3352): «если: …» или подпись связи. */
function qLinkTagText(store: VetviStore, e: VetviEdge | null): string | null {
  if (!e) return null;
  if (e.cond) return 'если: ' + condText(store.doc, condWithOverride(store.doc, e.cond, store.nodeById(e.from) || null));
  if (e.label) return e.label;
  return null;
}

/** qLinkTitle (3353–3360): подсказка стрелки/зазора между строками. */
function findReplyDeep(arr: { id?: string; text?: string; children?: unknown[] }[] | undefined | null, rid: string): { text?: string } | null {
  for (const r of arr || []) {
    if (r && r.id === rid) return r;
    const f = r && r.children ? findReplyDeep(r.children as typeof arr, rid) : null;
    if (f) return f;
  }
  return null;
}

function qLinkTitle(store: VetviStore, a: VetviNode, b: VetviNode, e: VetviEdge | null): string {
  let t = 'Связь «кто за кем»: «' + (a.title || '?') + '» → «' + (b.title || '?') + '»';
  if (!e) return t + ' · авто-связь убрана — порядок строк сохраняется';
  if (e.cond) t += '\nусловие: ' + condText(store.doc, condWithOverride(store.doc, e.cond, store.nodeById(e.from) || null));
  if (e.label) t += '\nметка: ' + e.label;
  if (e.fromReply && a.type === 'dialog') {
    const r = findReplyDeep(a.dialog && a.dialog.replies, e.fromReply);
    if (r) t += '\nпереход после реплики: «' + (r.text || '').slice(0, 60) + '»';
  }
  return t + ' · клик — выбрать связь';
}

/** qNodeContentHtml (7273–7296): читаемое содержимое ноды для строки цепочки. */
function qNodeContent(n: VetviNode): React.ReactNode {
  const lines: { t: string; cls: string }[] = [];
  if (n.type === 'dialog') {
    const d = ((n.dialog && n.dialog.description) || '').trim();
    if (d) lines.push({ t: d, cls: 'desc' });
    ((n.dialog && n.dialog.replies) || []).forEach((r) => {
      const t = (r.text || '').trim();
      if (!t) return;
      lines.push({ t: '— ' + t, cls: '' });
    });
  } else {
    const t = (n.text || '').trim();
    if (t) lines.push({ t, cls: '' });
    /* поле outs — как в оригинале (7287): у развилок исходы хранятся в outcomes,
       поэтому в оригинале строки «→ исход» не отрисовываются — повторяем 1:1 */
    const outs = (n as unknown as { outs?: unknown }).outs;
    if (n.type === 'branch' && Array.isArray(outs)) {
      (outs as { label?: string; name?: string }[]).forEach((o) => {
        const s = (o.label || o.name || '').trim();
        if (s) lines.push({ t: '→ ' + s, cls: '' });
      });
    }
  }
  if (!lines.length) return null;
  const max = 4;
  const shown = lines.slice(0, Math.min(max, lines.length)).map((l, i) => (
    <span key={i} className={'q-line ' + l.cls}>{l.t.slice(0, 140)}</span>
  ));
  if (lines.length > max) shown.push(<span key="more" className="q-line more">… ещё {lines.length - max}</span>);
  return <div className="q-text">{shown}</div>;
}

/** qRedrawConnectors (3399–3427): стрелки «кто за кем» на svg.q-svg карточки. */
const SVG_NS = 'http://www.w3.org/2000/svg';
function qRedrawConnectors(store: VetviStore, cardEl: HTMLElement): void {
  const svg = cardEl.querySelector('svg.q-svg');
  if (!svg) return;
  const frag = document.createDocumentFragment();
  cardEl.querySelectorAll<HTMLElement>('.q-link[data-a][data-b]').forEach((lk) => {
    const a = store.nodeById(lk.getAttribute('data-a') || '');
    const b = store.nodeById(lk.getAttribute('data-b') || '');
    if (!a || !b) return;
    const ra = cardEl.querySelector<HTMLElement>('.q-item[data-nid="' + a.id + '"]');
    const rb = cardEl.querySelector<HTMLElement>('.q-item[data-nid="' + b.id + '"]');
    if (!ra || !rb || ra.style.display === 'none' || rb.style.display === 'none') return;
    /* порты как у нод: выход — центр правого пина строки A, вход — центр левого пина строки B */
    const x1 = ra.offsetLeft + ra.offsetWidth + 0.5;
    const y1 = ra.offsetTop + ra.offsetHeight / 2;
    const x2 = rb.offsetLeft - 0.5;
    const y2 = rb.offsetTop + rb.offsetHeight / 2;
    /* та же кубическая кривая, что у связей на хосте (edgePathD, smooth) */
    const dx = clamp((x1 - x2) * 0.5 + 60, 70, 240);
    const d = 'M' + x1 + ' ' + y1 + ' C ' + (x1 + dx) + ' ' + y1 + ', ' + (x2 - dx) + ' ' + y2 + ', ' + x2 + ' ' + y2;
    const eid = lk.getAttribute('data-eid') || '';
    const e = eid ? store.edgeById(eid) : null;
    const selOn = e ? store.selEdges.has(e.id) : false;
    const gr = document.createElementNS(SVG_NS, 'g');
    gr.setAttribute('class', 'q-conn' + (e ? '' : ' no-e') + (selOn ? ' sel' : ''));
    const ln = document.createElementNS(SVG_NS, 'path');
    ln.setAttribute('class', 'q-edge');
    ln.setAttribute('d', d);
    /* наконечник — ориентирован по касательной у входа (горизонтально, внутрь строки) */
    const arr = document.createElementNS(SVG_NS, 'path');
    arr.setAttribute('class', 'q-arr');
    arr.setAttribute('d', 'M' + x2 + ' ' + y2 + ' L' + (x2 - 5) + ' ' + (y2 - 3.2) + ' L' + (x2 - 5) + ' ' + (y2 + 3.2) + ' Z');
    const hit = document.createElementNS(SVG_NS, 'path');
    hit.setAttribute('class', 'q-edge-hit');
    hit.setAttribute('d', d);
    if (e) {
      hit.setAttribute('data-eid', e.id);
      const tt = document.createElementNS(SVG_NS, 'title');
      tt.textContent = qLinkTitle(store, a, b, e);
      hit.appendChild(tt);
    }
    gr.appendChild(ln);
    gr.appendChild(arr);
    gr.appendChild(hit);
    frag.appendChild(gr);
  });
  svg.innerHTML = '';
  svg.appendChild(frag);
}

export function GroupLayer(props: {
  groups: VetviGroup[];
  store: VetviStore;
  vp: VetviViewport;
  sizes: Map<string, NodeSize>;
  cardSizes: Map<string, { w: number; h: number }>;
  sink: { setCardSize(id: string, w: number, h: number): void };
  hiddenGids: Set<string>;
  onGroupDown: (e: React.MouseEvent, gid: string) => void;
  onGroupResize: (e: React.MouseEvent, gid: string, dir: 'r' | 'b' | 'br') => void;
  /** qport.in/qport.out (7870–7921): вход/выход цепочки (isIn=true — вход). */
  onQPortDown: (e: React.MouseEvent, gid: string, isIn: boolean) => void;
  /** выход строки (startRowConnect, 7924–7944): новая связь / Ctrl — перенос исходящих. */
  onRowPinDown: (e: React.MouseEvent, nid: string) => void;
}) {
  const { groups, store, vp, sizes, cardSizes, sink, hiddenGids } = props;
  const refs = useRef(new Map<string, HTMLDivElement | null>());

  useLayoutEffect(() => {
    const z = vp.z || 1;
    refs.current.forEach((el, gid) => {
      if (!el) return;
      if (hiddenGids.has(gid)) return;
      sink.setCardSize(gid, el.offsetWidth, el.offsetHeight);
      void z;
    });
    /* стрелки «кто за кем» — после каждого коммита (qRedrawConnectors, 3556) */
    for (const g of groups) {
      if (g.stack !== true) continue;
      const cardEl = refs.current.get(g.id);
      if (cardEl) qRedrawConnectors(store, cardEl);
    }
  });

  /* ── перетаскивание строк цепочки (qRowDrag, 7329–7425 оригинала) ── */
  const qRowDragRef = useRef<{ gid: string; nid: string; row: HTMLElement; cardEl: HTMLElement; sx: number; sy: number; moved: boolean; outMode: boolean } | null>(null);
  const qLastInsRef = useRef<number | null>(null);

  const qRowUnmark = () => {
    document.querySelectorAll('.q-item.q-ins-above,.q-item.q-ins-below').forEach((r) => r.classList.remove('q-ins-above', 'q-ins-below'));
  };
  const qGhostEl = () => document.getElementById('qGhost');
  const qGhostShow = (nid: string) => {
    const gh = qGhostEl();
    const n = store.nodeById(nid);
    if (!gh || !n) return;
    gh.textContent = (n.title || 'Нода') + ' — отпустите вне карточки, чтобы вывести из цепочки';
    gh.classList.add('show');
  };
  const qGhostMove = (cx: number, cy: number) => {
    const gh = qGhostEl();
    if (!gh) return;
    gh.style.left = (cx + 14) + 'px';
    gh.style.top = (cy + 16) + 'px';
  };
  const qGhostHide = () => {
    const gh = qGhostEl();
    if (gh) gh.classList.remove('show');
  };
  const qRowMark = (y: number) => {
    qRowUnmark();
    const qd = qRowDragRef.current;
    if (!qd) return;
    const list = qd.row.parentElement;
    if (!list) return;
    const rows = Array.from(list.querySelectorAll<HTMLElement>('.q-item[data-nid]')).filter((r) => r !== qd.row && r.style.display !== 'none');
    let idx = rows.length;
    for (let i = 0; i < rows.length; i++) {
      const rc = rows[i].getBoundingClientRect();
      if (y < rc.top + rc.height / 2) { idx = i; break; }
    }
    qLastInsRef.current = idx;
    if (idx < rows.length) rows[idx].classList.add('q-ins-above');
    else if (rows.length) rows[rows.length - 1].classList.add('q-ins-below');
  };
  const toWorldPt = (clientX: number, clientY: number): { x: number; y: number } => {
    const el = document.querySelector('.rn-canvas');
    const r = el ? el.getBoundingClientRect() : { left: 0, top: 0 };
    return screenToWorld(vp, clientX - r.left, clientY - r.top);
  };

  const onRowPointerDown = (ev: React.MouseEvent, gid: string, nid: string) => {
    ev.stopPropagation();
    if (ev.button !== 0) return;
    const row = ev.currentTarget as HTMLElement;
    const cardEl = row.closest('.qcard') as HTMLElement | null;
    if (!cardEl) return;
    qLastInsRef.current = null;
    qRowDragRef.current = { gid, nid, row, cardEl, sx: ev.clientX, sy: ev.clientY, moved: false, outMode: false };
  };

  useEffect(() => {
    const move = (e: PointerEvent) => {
      const qd = qRowDragRef.current;
      if (!qd) return;
      if (!qd.moved && Math.abs(e.clientY - qd.sy) + Math.abs(e.clientX - qd.sx) > 6) {
        qd.moved = true;
        qd.row.classList.add('q-src');
      }
      if (!qd.moved) return;
      /* за пределами карточки — режим «вытащить из цепочки»; внутри — перестановка строк */
      const r = qd.cardEl.getBoundingClientRect();
      const out = e.clientX < r.left - 8 || e.clientX > r.right + 8 || e.clientY < r.top - 8 || e.clientY > r.bottom + 8;
      if (out !== qd.outMode) {
        qd.outMode = out;
        if (out) { qRowUnmark(); qd.row.classList.add('q-out'); qGhostShow(qd.nid); }
        else { qd.row.classList.remove('q-out'); qGhostHide(); qRowMark(e.clientY); }
      }
      if (qd.outMode) qGhostMove(e.clientX, e.clientY);
      else qRowMark(e.clientY);
    };
    const up = (e: PointerEvent) => {
      const qd = qRowDragRef.current;
      if (!qd) return;
      qRowDragRef.current = null;
      qd.row.classList.remove('q-src');
      qd.row.classList.remove('q-out');
      qGhostHide();
      qRowUnmark();
      if (qd.moved && qd.outMode) {
        store.extractStackRow(qd.gid, qd.nid, toWorldPt(e.clientX, e.clientY), { x: e.clientX, y: e.clientY });
        qLastInsRef.current = null;
      } else if (qd.moved) {
        store.reorderStackRows(qd.gid, qd.nid, qLastInsRef.current);
        qLastInsRef.current = null;
      } else if (e.button === 0 || e.button === undefined) {
        if (store.nodeById(qd.nid)) store.selectOnly(qd.nid);
      }
    };
    const cancel = () => {
      const qd = qRowDragRef.current;
      if (!qd) return;
      qd.row.classList.remove('q-src');
      qd.row.classList.remove('q-out');
      qGhostHide();
      qRowDragRef.current = null;
      qLastInsRef.current = null;
      qRowUnmark();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
    };
  });

  const sorted = [...groups].sort((a, b) => {
    const da = depthOf(store, a);
    const db = depthOf(store, b);
    return db - da; // глубокие раньше (ниже слоем)
  });

  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      {sorted.map((g) => {
        if (hiddenGids.has(g.id)) return null;
        const sel = store.selGroups.has(g.id);
        /* чужой лок — обводка цветом участника */
        const lkRawG = store.syncLocks[g.id];
        const lkG = (lkRawG && lkRawG.id && lkRawG.id !== getMe().id) ? lkRawG : null;
        const lkbStyle = lkG ? { ['--lkc' as string]: lkG.color } : {};

        if (g.stack === true) {
          /* цепочка — отдельный элемент (не группа): строки с содержимым диалогов,
             порядок — перетаскиванием, разворачивания нет (3448–3480) */
          const doc = store.doc;
          const idsQ = stackOrderIds(doc, g);
          const direct = idsQ.map((id) => store.nodeById(id)).filter(Boolean) as VetviNode[];
          const qs = queueStyle(g);
          return (
            <div
              key={g.id}
              ref={(el) => { refs.current.set(g.id, el); }}
              className={'qcard' + (sel ? ' sel' : '') + (lkG ? ' lkb' : '')}
              data-gid={g.id}
              style={{
                left: g.x,
                top: g.y,
                display: direct.length ? undefined : 'none',
                background: qs.background,
                borderColor: qs.borderColor,
                ...qs.vars,
                ...lkbStyle,
              }}
              onMouseDown={(e) => props.onGroupDown(e, g.id)}
              onDoubleClick={(e) => { e.stopPropagation(); store.selectGroupOnly(g.id); }}
              onContextMenu={(e) => { e.preventDefault(); if (!sel) store.selectGroupOnly(g.id); store.openCtx(e.clientX, e.clientY, ctxMenus(store).group(g.id)); }}
            >
              <i
                className="qport in"
                title="вход цепочки (первая нода) — потяните, чтобы перенести входящие стрелки"
                onMouseDown={(e) => props.onQPortDown(e, g.id, true)}
              />
              <div className="q-head">
                {ic('queue', 14)}
                <span className="q-name">{g.name === 'Очередь' ? 'Цепочка' : (g.name || 'Цепочка')}</span>
                <span className="q-cnt">{direct.length}</span>
              </div>
              <div className="q-list">
                {direct.length ? direct.map((n, i) => {
                  const cast = qRowCast(store, n);
                  const rowCol = cast.color || nodeColor(n);
                  const link = i < direct.length - 1 ? qLinkInfo(doc, n, direct[i + 1]) : null;
                  const linkTag = link ? qLinkTagText(store, link) : null;
                  const row = (
                    <div
                      key={n.id}
                      className="q-item"
                      data-nid={n.id}
                      style={cast.color ? { borderColor: hexToRgba(cast.color, 0.6) } : undefined}
                      title="Тяните строку — поменять порядок · тяните за пределы карточки — вывести из цепочки · клик — выбрать ноду"
                      onMouseDown={(ev) => onRowPointerDown(ev, g.id, n.id)}
                    >
                      <i className="gc-pin in" style={{ borderColor: rowCol }} title="вход строки — сюда заходит стрелка от предыдущей ноды цепочки" />
                      <span className="q-num">{i + 1}</span>
                      <div className="q-body">
                        <div className="q-title" style={{ color: rowCol }}>{n.title || ''}</div>
                        {cast.html}
                        {qNodeContent(n)}
                      </div>
                      <button
                        type="button"
                        className="q-x"
                        data-nid={n.id}
                        title="Вывести из цепочки"
                        onMouseDown={(ev) => ev.stopPropagation()}
                        onClick={(ev) => { ev.stopPropagation(); store.stackRowAction(g.id, n.id); }}
                      >✕</button>
                      <i
                        className="gc-pin out"
                        style={{ borderColor: rowCol }}
                        title="выход строки — тяните отсюда связь к любой ноде, как у обычной ноды · Ctrl+тянуть — перенести исходящие"
                        onMouseDown={(ev) => props.onRowPinDown(ev, n.id)}
                      />
                    </div>
                  );
                  if (i < direct.length - 1) {
                    const nb = direct[i + 1];
                    return (
                      <Fragment key={n.id}>
                        {row}
                        <div
                          className={'q-link' + (link ? ' has-e' : ' no-e')}
                          data-a={n.id}
                          data-b={nb.id}
                          data-eid={link ? link.id : undefined}
                          title={qLinkTitle(store, n, nb, link)}
                          onMouseDown={(ev) => ev.stopPropagation()}
                          onClick={(ev) => { ev.stopPropagation(); if (link) store.selectEdgeOnly(link.id); }}
                        >
                          {link && linkTag ? <span className="q-tag">{linkTag}</span> : null}
                        </div>
                      </Fragment>
                    );
                  }
                  return row;
                }) : <div className="q-empty">Цепочка пуста</div>}
              </div>
              {/* клик по линии на SVG-слое — выбрать связь; pointerdown не двигает карточку (3534–3543) */}
              <svg
                className="q-svg"
                onMouseDown={(ev) => ev.stopPropagation()}
                onClick={(ev) => {
                  const t = ev.target as Element;
                  const hp = t.closest ? t.closest('.q-edge-hit') : null;
                  const eid = hp ? hp.getAttribute('data-eid') : null;
                  if (eid) { ev.stopPropagation(); store.selectEdgeOnly(eid); }
                }}
              />
              <i
                className="qport out"
                title="выход цепочки (последняя нода) — тяните к другому элементу · Ctrl+тянуть — перенести исходящие стрелки"
                onMouseDown={(e) => props.onQPortDown(e, g.id, false)}
              />
            </div>
          );
        }

        const col = g.color || '#9aa1ac';
        /* gAlpha/gColor оригинала + applyGroupStyle: --gbcol/--gbhov/--gbfill */
        const alpha = clamp(typeof g.alpha === 'number' ? g.alpha : 0.55, 0.1, 1);
        const gbcol = hexToRgba(col, Math.min(1, alpha + 0.15));
        const gbhov = hexToRgba(col, Math.min(1, alpha + 0.3));
        const gbfill = hexToRgba(col, alpha * 0.13);
        const fold = g.fold === undefined ? 2 : g.fold;
        const head = (
          <div className="gb-head" data-grab="1">
            <span className="gb-name">{g.name || 'Группа'}</span>
            <span className="gb-cnt">{fold === 2 ? store.membersOf(g.id).length : (fold === 0 ? '' : store.membersOf(g.id).length)}</span>
            <button
              type="button"
              className="gb-salla"
              data-nodrag
              title="Выделить все ноды группы"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                const ids = store.membersOf(g.id).map((n) => n.id);
                store.setSel(ids, []);
              }}
            >{ic('target', 11)}</button>
            <button
              type="button"
              className="gb-fold"
              data-nodrag
              title={fold === 2 ? 'Свернуть группу' : fold === 1 ? 'Сжать до компакта' : 'Развернуть группу'}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => { e.stopPropagation(); foldCycle(store, g); }}
            >{ic(fold === 2 ? 'chevUp' : fold === 1 ? 'chev' : 'expand', 11)}</button>
          </div>
        );
        if (fold === 2) {
          const manual = g.auto === false && typeof g.fw === 'number' && typeof g.fh === 'number';
          const rect = manual
            ? { x: g.x, y: g.y, w: g.fw as number, h: g.fh as number }
            : groupFrameRect(store.doc, g, sizes, cardSizes);
          return (
            <div
              key={g.id}
              ref={(el) => { refs.current.set(g.id, el); }}
              className={'groupbox' + (sel ? ' sel' : '') + (lkG ? ' lkb' : '')}
              data-gid={g.id}
              style={{
                left: rect.x, top: rect.y, width: rect.w, height: rect.h,
                ['--gbcol' as string]: gbcol,
                ['--gbhov' as string]: gbhov,
                ['--gbfill' as string]: gbfill,
                ...lkbStyle,
              }}
              onMouseDown={(e) => props.onGroupDown(e, g.id)}
              onDoubleClick={(e) => { e.stopPropagation(); store.selectGroupOnly(g.id); }}
              onContextMenu={(e) => { e.preventDefault(); if (!sel) store.selectGroupOnly(g.id); store.openCtx(e.clientX, e.clientY, ctxMenus(store).group(g.id)); }}
            >
              {head}
              <i className="gb-grip gr-r" data-nodrag data-gr="r" title="Изменить ширину" onMouseDown={(e) => { e.stopPropagation(); props.onGroupResize(e, g.id, 'r'); }} />
              <i className="gb-grip gr-b" data-nodrag data-gr="b" title="Изменить высоту" onMouseDown={(e) => { e.stopPropagation(); props.onGroupResize(e, g.id, 'b'); }} />
              <i className="gb-grip gr-br" data-nodrag data-gr="br" title="Изменить размер" onMouseDown={(e) => { e.stopPropagation(); props.onGroupResize(e, g.id, 'br'); }} />

            </div>
          );
        }
        // карточка fold=1/0
        const rows = store.membersOf(g.id);
        const subs = store.doc.groups.filter((s) => (s.parent || null) === g.id && s.id !== g.id);
        return (
          <div
            key={g.id}
            ref={(el) => { refs.current.set(g.id, el); }}
            className={'gcard' + (sel ? ' sel' : '') + (lkG ? ' lkb' : '')}
            data-gid={g.id}
            style={{ left: g.x, top: g.y, ['--gbcol' as string]: gbcol, ['--gbhov' as string]: gbhov, ['--gbfill' as string]: gbfill, ...lkbStyle }}
            onMouseDown={(e) => props.onGroupDown(e, g.id)}
            onDoubleClick={(e) => { e.stopPropagation(); store.selectGroupOnly(g.id); }}
            onContextMenu={(e) => { e.preventDefault(); if (!sel) store.selectGroupOnly(g.id); store.openCtx(e.clientX, e.clientY, ctxMenus(store).group(g.id)); }}
          >
            {head}
            {fold === 1 && (
              <div className="gb-list">
                {rows.map((n) => {
                  const rc = nodeColor(n);
                  return (
                    <div className="gc-row" key={n.id} data-nid={n.id}
                      onMouseDown={(e) => { e.stopPropagation(); store.selectOnly(n.id); props.onGroupDown(e, g.id); }}
                      onDoubleClick={(e) => { e.stopPropagation(); store.requestCenter(n.id); }}
                    >
                      <i className="gc-pin in" style={{ borderColor: rc }} />
                      <span className="dot" style={{ background: rc, color: rc }} />
                      <span className="t">{n.title || '…'}</span>
                      <i className="gc-pin out" style={{ borderColor: rc }} />
                    </div>
                  );
                })}
                {subs.map((s) => {
                  const sc = s.color || '#9aa1ac';
                  return (
                    <div className="gc-row sub" key={s.id} data-ngid={s.id}
                      onMouseDown={(e) => { e.stopPropagation(); store.selectGroupOnly(s.id); }}
                    >
                      <i className="gc-pin in" style={{ borderColor: sc }} />
                      <span className="dot" style={{ background: sc, color: sc }} />
                      <span className="t">{(s.name || 'Группа') + ' · ' + allDescNodes(store.doc, s.id).length}</span>
                      <i className="gc-pin out" style={{ borderColor: sc }} />
                    </div>
                  );
                })}
                {!rows.length && !subs.length && <div className="gc-row empty">пусто</div>}
              </div>
            )}

          </div>
        );
      })}
    </div>
  );
}

function depthOf(store: VetviStore, g: VetviGroup): number {
  let d = 0;
  let cur: string | null = g.parent || null;
  const seen = new Set<string>();
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    d++;
    cur = store.groupById(cur)?.parent || null;
  }
  return d;
}

export function foldCycle(store: VetviStore, g: VetviGroup): void {
  const cur = g.fold === undefined ? 2 : g.fold;
  if (g.stack === true) {
    /* cycleGroupFold, 7115–7126: у цепочки нет видов группы */
    store.toast('У цепочки нет видов группы — «Преобразовать в группу» в меню ПКМ по карточке или в инспекторе', 'warn');
    return;
  }
  const next = cur === 2 ? 1 : cur === 1 ? 0 : 2;
  if (next !== 2 && cur === 2) {
    // сворачиваем: карточка в левый-верхний угол области нод
    const ms = store.membersOf(g.id);
    if (ms.length) {
      const x = Math.min(...ms.map((n) => n.x)) - 20;
      const y = Math.min(...ms.map((n) => n.y)) - 34;
      store.updateGroup(g.id, { fold: next, x, y }, { history: false });
    } else {
      store.updateGroup(g.id, { fold: next }, { history: false });
    }
  } else if (next === 2 && cur !== 2) {
    // разворачиваем: рамка от точки карточки
    store.updateGroup(g.id, { fold: 2, x: g.x + 20, y: g.y + 34 }, { history: false });
  } else {
    store.updateGroup(g.id, { fold: next }, { history: false });
  }
  void 0;
  store.scheduleSave();
  store.emit();
}
