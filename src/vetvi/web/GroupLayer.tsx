'use client';

/**
 * Ветви — слой групп: рамки (fold=2), карточки со списком (fold=1),
 * компакты (fold=0), ярлыки, выделение, перенос, ресайз, сворачивание.
 * DOM 1:1 с оригиналом: .groupbox/.gcard + .gb-head (.gb-name/.gb-cnt/.gb-salla/.gb-fold)
 * + .gb-grip (.gr-r .gr-b .gr-br), .gb-list, .gc-row (.dot .t .gc-pin.in .gc-pin.out), .gbadge.
 */

import { useLayoutEffect, useRef } from 'react';

import { clamp, nodeColor } from '@/vetvi/core/geometry';
import { getMe } from '@/vetvi/core/identity';
import type { NodeSize, VetviGroup, VetviViewport } from '@/vetvi/core/types';
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
function ic(name: 'target' | 'chev' | 'chevUp' | 'expand', size: number): React.ReactNode {
  let body: React.ReactNode;
  if (name === 'target') body = <><circle cx="12" cy="12" r="7" /><path d="M12 2v4M12 18v4M2 12h4M18 12h4" /></>;
  else if (name === 'chev') body = <path d="m6 9 6 6 6-6" />;
  else if (name === 'chevUp') body = <path d="m6 15 6-6 6 6" />;
  else body = <path d="M9 9 4 4m0 0v4M4 4h4M15 9l5-5m0 0v4M20 4h-4M9 15l-5 5m0 0v-4M4 20h4M15 15l5 5m0 0v-4M20 20h-4" />;
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">{body}</svg>
  );
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
        const col = g.color || '#9aa1ac';
        /* gAlpha/gColor оригинала + applyGroupStyle: --gbcol/--gbhov/--gbfill */
        const alpha = clamp(typeof g.alpha === 'number' ? g.alpha : 0.55, 0.1, 1);
        const gbcol = hexToRgba(col, Math.min(1, alpha + 0.15));
        const gbhov = hexToRgba(col, Math.min(1, alpha + 0.3));
        const gbfill = hexToRgba(col, alpha * 0.13);
        const fold = g.fold === undefined ? 2 : g.fold;
        /* чужой лок — обводка цветом участника */
        const lkRawG = store.syncLocks[g.id];
        const lkG = (lkRawG && lkRawG.id && lkRawG.id !== getMe().id) ? lkRawG : null;
        const lkbStyle = lkG ? { ['--lkc' as string]: lkG.color } : {};
        /* ярлык группы рисует CanvasBoard в слое #labels (как в оригинале) */
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
