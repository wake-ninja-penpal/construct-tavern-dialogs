'use client';

/**
 * Ветви — слой групп: рамки (fold=2), карточки со списком (fold=1),
 * компакты (fold=0), ярлыки, выделение, перенос, ресайз, сворачивание.
 */

import { useLayoutEffect, useRef } from 'react';

import { nodeColor, shadeHex } from '@/vetvi/core/geometry';
import { getMe } from '@/vetvi/core/identity';
import type { NodeSize, VetviGroup, VetviViewport } from '@/vetvi/core/types';
import { groupFrameRect } from './ggroups';
import type { VetviStore } from './store';

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
    <div className="rn-groups" aria-hidden="false">
      {sorted.map((g) => {
        if (hiddenGids.has(g.id)) return null;
        const sel = store.selGroups.has(g.id);
        const col = g.color || '#8b929c';
        const alpha = typeof g.alpha === 'number' ? g.alpha : 0.55;
        const fold = g.fold === undefined ? 2 : g.fold;
        if (fold === 2) {
          const manual = g.auto === false && typeof g.fw === 'number' && typeof g.fh === 'number';
          const rect = manual
            ? { x: g.x, y: g.y, w: g.fw as number, h: g.fh as number }
            : groupFrameRect(store.doc, g, sizes, cardSizes);
          /* чужой лок рамки — обводка цветом участника */
          const lkRawG = store.syncLocks[g.id];
          const lkG = (lkRawG && lkRawG.id && lkRawG.id !== getMe().id) ? lkRawG : null;
          return (
            <div
              key={g.id}
              ref={(el) => { refs.current.set(g.id, el); }}
              className={'rn-gframe' + (sel ? ' sel' : '') + (lkG ? ' lkb' : '')}
              style={{
                left: rect.x, top: rect.y, width: rect.w, height: rect.h,
                ['--gc' as string]: col,
                ['--gca' as string]: String(alpha),
                ['--gcb' as string]: shadeHex(col, 30),
                ...(lkG ? { ['--lkc' as string]: lkG.color } : {}),
              }}
              onMouseDown={(e) => props.onGroupDown(e, g.id)}
              onDoubleClick={(e) => { e.stopPropagation(); store.selectGroupOnly(g.id); }}
              onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); if (!sel) store.selectGroupOnly(g.id); }}
            >
              <div className="rn-ghead" data-grab="1">
                <span className="rn-gname">{g.name || 'Группа'}</span>
                <span className="rn-gcount">{store.membersOf(g.id).length}</span>
                <button
                  type="button"
                  className="rn-gsalla"
                  data-nodrag
                  title="Выделить все ноды группы"
                  onClick={(e) => {
                    e.stopPropagation();
                    const ids = store.membersOf(g.id).map((n) => n.id);
                    store.setSel(ids, []);
                  }}
                >✥</button>
                <button
                  type="button"
                  className="rn-gfold"
                  data-nodrag
                  title="Свернуть в карточку"
                  onClick={(e) => { e.stopPropagation(); foldCycle(store, g); }}
                >▾</button>
              </div>
              <span className="rn-ggrip gr-r" data-nodrag onMouseDown={(e) => { e.stopPropagation(); props.onGroupResize(e, g.id, 'r'); }} />
              <span className="rn-ggrip gr-b" data-nodrag onMouseDown={(e) => { e.stopPropagation(); props.onGroupResize(e, g.id, 'b'); }} />
              <span className="rn-ggrip gr-br" data-nodrag onMouseDown={(e) => { e.stopPropagation(); props.onGroupResize(e, g.id, 'br'); }} />
              {store.syncLocks[g.id] && <span className="rn-lock gl" style={{ ['--lc' as string]: store.syncLocks[g.id].color }} />}
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
            className={'rn-gcard' + (sel ? ' sel' : '') + (fold === 0 ? ' compact' : '')}
            style={{ left: g.x, top: g.y, ['--gc' as string]: col }}
            onMouseDown={(e) => props.onGroupDown(e, g.id)}
            onDoubleClick={(e) => { e.stopPropagation(); store.selectGroupOnly(g.id); }}
            onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); if (!sel) store.selectGroupOnly(g.id); }}
          >
            <div className="rn-gchead" data-grab="1">
              <span className="rn-gdot" style={{ background: col }} />
              <span className="rn-gname">{g.name || 'Группа'}</span>
              <span className="rn-gcount">{fold === 0 ? '' : rows.length}</span>
              <button type="button" className="rn-gfold" data-nodrag title="Развернуть группу" onClick={(e) => { e.stopPropagation(); foldCycle(store, g); }}>▸</button>
            </div>
            {fold === 1 && (
              <div className="rn-gclist">
                {rows.map((n) => (
                  <div className="rn-gcrow" key={n.id} data-row-node={n.id}
                    onMouseDown={(e) => { e.stopPropagation(); store.selectOnly(n.id); props.onGroupDown(e, g.id); }}
                    onDoubleClick={(e) => { e.stopPropagation(); store.requestCenter(n.id); }}
                  >
                    <span className="rn-gcdot" style={{ background: nodeColor(n) }} />
                    <span className="rn-gctitle">{n.title || '…'}</span>
                    <span className="rn-gcpin out" data-pin={'grow:' + n.id} title="Выход строки: потянуть связь"
                      onMouseDown={(e) => { e.stopPropagation(); }}
                    />
                  </div>
                ))}
                {subs.filter((s) => s.fold !== 2).map((s) => (
                  <div className="rn-gcrow sub" key={s.id} onMouseDown={(e) => { e.stopPropagation(); store.selectGroupOnly(s.id); }}>
                    <span className="rn-gcdot" style={{ background: s.color || '#8b929c' }} />
                    <span className="rn-gctitle">{s.name || 'Группа'}</span>
                  </div>
                ))}
                {!rows.length && !subs.length && <div className="rn-gcrow empty">пусто</div>}
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
