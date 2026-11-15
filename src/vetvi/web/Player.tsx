'use client';

/**
 * Ветви — проигрыватель «режим новеллы» (порт PL/* оригинала, строки 12691–13529).
 * Только чтение: ничего не меняет в документе. Режимы: graph (весь сюжет) и
 * list (выделенные блоки/группы или одна нода по Alt+P). Условия исходов,
 * переменные (HUD + операции нодами), печатная машинка, история «Назад»,
 * «Заново», «К ноде» с подсветкой реплики, мёртвые ветки, экран «КОНЕЦ».
 */

import { Fragment, useEffect, useMemo, useRef, useState } from 'react';

import { clamp } from '@/vetvi/core/geometry';
import { TYPES } from '@/vetvi/core/constants';
import type { VetviDoc, VetviNode, VetviReply } from '@/vetvi/core/types';
import { condMet, condText, condWithOverride, opSym, varApplyOp, varById, varName, varType, varValText } from '@/vetvi/core/vars';
import { linearIds } from '@/vetvi/core/dialog';
import { hkIs } from '@/vetvi/core/hotkeys';
import type { VetviStore } from './store';

interface Choice {
  label: string;
  av?: { url: string | null; shape: string; color: string; letter: string } | null;
  ok: boolean;
  why?: string;
  targets: string[];
  fn: () => void;
}

interface Snap {
  nodeId: string | null;
  replyId: string | null;
  intro: boolean;
  seqIdx: number;
  vars: Record<string, unknown> | null;
  varChanged: string[] | null;
  dead: string[] | null;
  visited: string[] | null;
}

interface PlState {
  nodeId: string | null;
  replyId: string | null;
  intro: boolean;
  lastReply: string | null;
  full: string;
  shown: string;
  typing: boolean;
  hist: Snap[];
  path: string[];
  mode: 'graph' | 'list';
  list: string[];
  listSet: Set<string>;
  idx: number;
  vars: Record<string, unknown>;
  varChanged: Set<string>;
  visited: Set<string>;
  dead: Set<string>;
  seqList: string[] | null;
  seqIdx: number;
  choices: Choice[] | null;
  end: boolean;
  varFlash: { txt: string; t: number } | null;
  /* avCid — персонаж аватара слайда (аналог содержимого #plAv оригинала);
     hintOverride — подсказка «путь закрыт: … · ← назад» после заблокированного шага */
  avCid: string | null;
  hintOverride: string | null;
}

const PL_LIMIT = 120;

export function Player(props: { store: VetviStore }) {
  const { store } = props;
  const doc = store.doc;
  const start = store.playerStart;
  const [st, setSt] = useState<PlState | null>(null);
  const stRef = useRef<PlState | null>(null);
  stRef.current = st;
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [, forceTick] = useState(0);

  /* ── эффекты-обёртки: всегда работают с актуальным состоянием ── */
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);
  const actRef = useRef<(fn: (cur: PlState) => PlState | null | void) => void>(() => undefined);
  actRef.current = (fn) => {
    if (!mountedRef.current) return;
    const cur = stRef.current;
    if (!cur) return;
    const next = fn(cur);
    if (next) setSt(next);
    else forceTick((t) => t + 1);
  };

  const pushHist = (cur: PlState): void => {
    cur.hist.push({
      nodeId: cur.nodeId, replyId: cur.replyId, intro: cur.intro, seqIdx: cur.seqIdx,
      vars: { ...cur.vars }, varChanged: [...cur.varChanged], dead: [...cur.dead], visited: [...cur.visited],
    });
    if (cur.hist.length > PL_LIMIT) cur.hist.shift();
  };

  const trackPath = (cur: PlState, id: string): string[] => {
    if (cur.path[cur.path.length - 1] === id) return cur.path;
    return [...cur.path, id].slice(-40);
  };

  const showEnd = (cur: PlState): PlState => {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    return { ...cur, typing: false, choices: null, end: true, shown: cur.full };
  };

  const showSlide = (cur: PlState, n: VetviNode, text: string, keepIntro?: boolean, avCid?: string | null): PlState => {
    return {
      ...cur,
      nodeId: n.id, replyId: null, intro: !!keepIntro,
      full: text || '…', shown: '', typing: true,
      choices: null, end: false,
      seqList: null, seqIdx: -1,
      path: n.type === 'varnode' ? cur.path : trackPath(cur, n.id),
      avCid: avCid ?? null, hintOverride: null,
    };
  };

  const goNode = (cur0: PlState, n: VetviNode, keepPath: boolean): void => {
    actRef.current((cur) => {
      let s: PlState = {
        ...cur,
        nodeId: n.id, replyId: null, intro: false,
        choices: null, end: false,
        seqList: (n.type === 'dialog' && n.linear) ? linearIds(n.dialog?.replies || []) : null,
        seqIdx: -1,
        path: keepPath ? cur.path : (n.type === 'varnode' ? cur.path : trackPath(cur, n.id)),
      };
      if (s.mode === 'list') s.visited = new Set([...s.visited, n.id]);
      if (n.type === 'varnode') {
        // применение переменной без слайда
        const v = varById(doc, n.vid);
        if (!v) {
          s = { ...s, varFlash: { txt: 'Переменная не привязана — выберите её в инспекторе.', t: Date.now() } };
        } else if (n.varMode !== 'get') {
          const after = varApplyOp(String(n.varOp ?? '='), s.vars[v.id], n.varVal, varType(v));
          const vc = new Set(s.varChanged);
          vc.add(v.id);
          s = {
            ...s, vars: { ...s.vars, [v.id]: after }, varChanged: vc,
            varFlash: { txt: varName(doc, v.id) + ' ' + opSym(String(n.varOp ?? '=')) + ' ' + varValText(n.varVal, v) + '  →  ' + varValText(after, v), t: Date.now() },
          };
        } else {
          const gv = s.vars[v.id] !== undefined && s.vars[v.id] !== null ? s.vars[v.id] : v.val;
          s = { ...s, varFlash: { txt: 'чтение: ' + v.name + ' = ' + varValText(gv, v), t: Date.now() } };
        }
        // отложенный переход после показа всплывашки
        setTimeout(() => {
          actRef.current((c2) => {
            if (c2.end) return c2;
            afterVarnode(c2, n);
            return null;
          });
        }, 420);
        return s;
      }
      if (n.type === 'dialog' && n.dialog) {
        const rs = n.dialog.replies || [];
        if (n.linear) {
          if (n.dialog.description) return showSlide(s, n, n.dialog.description, true);
          linearShow(s, n, 0);
          return null;
        }
        if (n.dialog.description) return showSlide(s, n, n.dialog.description, true);
        if (rs.length > 1) return { ...s, typing: false, shown: '', full: '', choices: dialogChoices(n, rs), avCid: null, hintOverride: null };
        if (rs.length === 1) { showReply(s, n, rs[0]); return null; }
        return showSlide(s, n, '…', false, castAvCid(doc, n));
      }
      return showSlide(s, n, n.text || '…', false, castAvCid(doc, n));
    });
  };
  const goNodeRef = useRef(goNode);
  goNodeRef.current = goNode;

  const linearShow = (cur: PlState, n: VetviNode, idx: number): void => {
    const ids = linearIds(n.dialog?.replies || []);
    if (idx >= ids.length) {
      afterNodeFinal(cur, n);
      return;
    }
    const r = findReplyDeep(n.dialog?.replies || [], ids[idx]);
    if (!r) { afterNodeFinal(cur, n); return; }
    actRef.current((c) => ({
      ...c,
      nodeId: n.id, replyId: null, intro: false,
      full: r.text || '…', shown: '', typing: true,
      choices: null, end: false,
      seqList: ids, seqIdx: idx,
      lastReply: r.id,
      avCid: r.speaker || null, hintOverride: null,
    }));
  };

  const showReply = (cur: PlState, n: VetviNode, r: VetviReply): void => {
    actRef.current((c) => ({
      ...c,
      nodeId: n.id, replyId: r.id, intro: false,
      full: r.text || '…', shown: '', typing: true,
      choices: null, end: false,
      lastReply: r.id,
      avCid: r.speaker || null, hintOverride: null,
    }));
  };

  const afterVarnode = (cur: PlState, n: VetviNode): void => {
    const nx = playableEdges(doc, cur, n.id).filter((e) => !e.fromReply);
    if (nx.length === 1) {
      const e = nx[0];
      const c0 = edgeCond(e);
      const cw = c0 ? condWithOverride(doc, c0, n) : null;
      if (cw && !condMet(doc, cw, cur.vars)) {
        /* нода переменной: закрытый путь — всплывашка и сразу экран «КОНЕЦ» (plAfterVarnode) */
        actRef.current((c) => showEnd({ ...c, varFlash: { txt: 'путь закрыт: ' + condText(doc, cw), t: Date.now() } }));
        return;
      }
      const t = doc.nodes.find((x) => x.id === e.to);
      if (t) goNodeRef.current(cur, t, true);
      else actRef.current(showEnd);
      return;
    }
    if (nx.length > 1) {
      const bc = branchChoices(n, nx);
      if (bc) { actRef.current((c) => ({ ...c, choices: bc })); return; }
      actRef.current((c) => ({ ...c, choices: genericEdgeChoices(nx) }));
      return;
    }
    listNextOrEnd(cur);
  };

  const afterNodeFinal = (cur: PlState, n: VetviNode): void => {
    /* как plAfterNodeFinal оригинала: сначала стрелки узла, потом резерв списка выделения */
    const nx = playableEdges(doc, cur, n.id);
    if (nx.length === 1) {
      const e = nx[0];
      const c0 = edgeCond(e);
      const cw = c0 ? condWithOverride(doc, c0, n) : null;
      if (cw && !condMet(doc, cw, cur.vars)) {
        cur.hist.pop(); /* шаг не состоялся — снимаем запись в истории */
        actRef.current((c) => ({ ...c, hintOverride: 'путь закрыт: ' + condText(doc, cw) + ' · ← назад' }));
        return;
      }
      const t = doc.nodes.find((x) => x.id === e.to);
      if (t) goNodeRef.current(cur, t, false);
      else actRef.current(showEnd);
      return;
    }
    if (nx.length > 1) {
      const bc = branchChoices(n, nx);
      if (bc) { actRef.current((c) => ({ ...c, choices: bc })); return; }
      actRef.current((c) => ({ ...c, choices: genericEdgeChoices(nx) }));
      return;
    }
    if (cur.mode === 'list') { listNextOrEnd(cur); return; }
    actRef.current(showEnd);
  };

  const listNextOrEnd = (cur: PlState): void => {
    if (cur.mode === 'list' && plListHasNext(cur)) listJumpNext(cur);
    else actRef.current(showEnd);
  };

  const listJumpNext = (cur: PlState): void => {
    for (let i = 0; i < cur.list.length; i++) {
      const id = cur.list[i];
      if (!cur.visited.has(id) && !cur.dead.has(id)) {
        const n = doc.nodes.find((x) => x.id === id);
        if (n) {
          actRef.current((c) => ({ ...c, idx: i }));
          setTimeout(() => {
            const c2 = stRef.current;
            if (c2) goNodeRef.current(c2, n, false);
          }, 0);
          return;
        }
      }
    }
    actRef.current(showEnd);
  };

  const plListHasNext = (cur: PlState): boolean => {
    return cur.list.some((id) => !cur.visited.has(id) && !cur.dead.has(id) && doc.nodes.some((x) => x.id === id));
  };

  const finishType = (): void => {
    const cur = stRef.current;
    if (!cur || !cur.typing) return;
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    setSt({ ...cur, shown: cur.full, typing: false });
  };

  /* ── фабрики вариантов ── */
  const genericEdgeChoices = (nx: VetviDoc['edges']): Choice[] => {
    return nx.map((e) => ({
      label: edgeLabel(doc, e),
      ok: true,
      targets: [e.to],
      fn: () => {
        const c2 = stRef.current;
        const t2 = c2 ? doc.nodes.find((x) => x.id === e.to) : null;
        if (c2 && t2) goNodeRef.current(c2, t2, false);
      },
    }));
  };

  const dialogChoices = (n: VetviNode, rs: VetviReply[]): Choice[] => {
    return rs.map((r) => {
      const c = r.speaker ? store.charById(r.speaker) : null;
      return {
        label: (c?.name ? c.name + ': ' : '') + (r.text || '…'),
        av: c ? { url: (c.av as string | null) || null, shape: c.avShape === 'square' ? 'square' : 'circle', color: c.color || '#9cb878', letter: charInitialOf(c) } : null,
        ok: true,
        targets: replyTargets(doc, n, r),
        fn: () => {
          const c2 = stRef.current;
          if (c2) showReply(c2, n, r);
        },
      };
    });
  };

  const branchChoices = (n: VetniAlias, nx: VetviDoc['edges']): Choice[] | null => {
    const cur = stRef.current as PlState;
    const outs = n.type === 'branch' && Array.isArray(n.outcomes) ? n.outcomes : [];
    const acts = n.type === 'action' && Array.isArray(n.actions) ? (n.actions as { id: string; label?: string }[]) : [];
    type PoolCond = { vid: string; op: string; val: number | string } | null | undefined;
    const pool: { id: string; label?: string; cond?: PoolCond }[] =
      outs.length
        ? outs.map((o) => ({ id: o.id, label: o.label, cond: (o.cond || undefined) as PoolCond }))
        : acts.map((a) => ({ id: a.id, label: a.label, cond: undefined }));
    if (!pool.length) return null;
    const items: Choice[] = [];
    for (const o of pool) {
      const ed = nx.find((e) => e.fromOut === o.id);
      let c = (o.cond || (ed ? (ed as unknown as { cond?: PoolCond }).cond : undefined)) as PoolCond;
      if (c) c = condWithOverride(doc, c, n) as PoolCond;
      const ok = !c || condMet(doc, c, cur.vars);
      const targetNode = ed ? doc.nodes.find((x) => x.id === ed.to) : null;
      items.push({
        label: o.label || '…',
        ok,
        why: !ok ? 'нужно: ' + condText(doc, c) : (!ed ? 'исход не подключён стрелкой' : undefined),
        targets: ed ? [ed.to] : [],
        fn: () => {
          const c2 = stRef.current;
          if (!c2) return;
          if (targetNode) goNodeRef.current(c2, targetNode, false);
        },
      });
    }
    // авто-переход: единственный выход без условий не показывается кнопкой
    if (items.length === 1 && items[0].ok && !pool[0].cond) {
      const ed = nx.find((e) => e.fromOut === pool[0].id);
      const ec = ed ? (ed as unknown as { cond?: unknown }).cond : undefined;
      if (!ec) return null;
    }
    return items;
  };

  /* ── шаг вперёд ── */
  const advance = (): void => {
    const cur = stRef.current;
    if (!cur) return;
    if (cur.typing) { finishType(); return; }
    if (cur.choices && cur.choices.length) return;
    if (cur.end) return;
    const n = cur.nodeId ? doc.nodes.find((x) => x.id === cur.nodeId) : null;
    if (!n) { actRef.current(showEnd); return; }
    pushHist(cur);

    if (cur.intro && n.type === 'dialog' && n.dialog) {
      const rs = n.dialog.replies || [];
      actRef.current((c) => ({ ...c, intro: false }));
      if (n.linear) { linearShow(cur, n, 0); return; }
      if (rs.length > 1) { actRef.current((c) => ({ ...c, choices: dialogChoices(n, rs) })); return; }
      if (rs.length === 1) { showReply(cur, n, rs[0]); return; }
      afterNodeFinal(cur, n);
      return;
    }

    if (n.type === 'dialog' && n.linear && cur.seqList) {
      const curRep = cur.seqIdx >= 0 ? findReplyDeep(n.dialog?.replies || [], cur.seqList[cur.seqIdx]) : null;
      if (curRep && (curRep as unknown as { loop?: boolean }).loop) { goNodeRef.current(cur, n, false); return; }
      const nextIdx = cur.seqIdx + 1;
      if (nextIdx < cur.seqList.length) { linearShow(cur, n, nextIdx); return; }
      afterNodeFinal(cur, n);
      return;
    }

    if (cur.replyId && n.type === 'dialog' && n.dialog) {
      const r = findReplyDeep(n.dialog.replies || [], cur.replyId);
      if (r) {
        const kids = r.children || [];
        if (kids.length > 1) {
          actRef.current((c) => ({ ...c, choices: kids.map((ch) => ({
            label: ch.text || 'Продолжить…',
            ok: true,
            targets: replyTargets(doc, n, ch),
            fn: () => { const c2 = stRef.current; if (c2) showReply(c2, n, ch); },
          })) }));
          return;
        }
        if (kids.length === 1) { showReply(cur, n, kids[0]); return; }
        const ex = doc.edges.filter((e) => e.from === n.id && e.fromReply === r.id && e.tin !== 'var' && (cur.mode !== 'list' || cur.listSet.has(e.to)));
        if (ex.length === 1) {
          const c0 = edgeCond(ex[0]);
          const cw = c0 ? condWithOverride(doc, c0, n) : null;
          if (cw && !condMet(doc, cw, cur.vars)) {
            cur.hist.pop(); /* шаг не состоялся — снимаем запись в истории */
            actRef.current((c) => ({ ...c, hintOverride: 'путь закрыт: ' + condText(doc, cw) + ' · ← назад' }));
            return;
          }
          const t = doc.nodes.find((x) => x.id === ex[0].to);
          if (t) { goNodeRef.current(cur, t, false); return; }
        }
        if (ex.length > 1) {
          actRef.current((c) => ({ ...c, choices: ex.map((e) => ({
            label: edgeLabel(doc, e),
            ok: true,
            targets: [e.to],
            fn: () => { const c2 = stRef.current; const t2 = c2 ? doc.nodes.find((x) => x.id === e.to) : null; if (c2 && t2) goNodeRef.current(c2, t2, false); },
          })) }));
          return;
        }
        const nx = playableEdges(doc, cur, n.id).filter((e) => !e.fromReply);
        if (nx.length === 1) {
          const c0 = edgeCond(nx[0]);
          const cw = c0 ? condWithOverride(doc, c0, n) : null;
          if (cw && !condMet(doc, cw, cur.vars)) {
            cur.hist.pop(); /* шаг не состоялся — снимаем запись в истории */
            actRef.current((c) => ({ ...c, hintOverride: 'путь закрыт: ' + condText(doc, cw) + ' · ← назад' }));
            return;
          }
          const t = doc.nodes.find((x) => x.id === nx[0].to);
          if (t) { goNodeRef.current(cur, t, false); return; }
        }
        if (nx.length > 1) {
          const bc = branchChoices(n, nx);
          if (bc) { actRef.current((c) => ({ ...c, choices: bc })); return; }
          actRef.current((c) => ({ ...c, choices: genericEdgeChoices(nx) }));
          return;
        }
        if ((r as unknown as { loop?: boolean }).loop) {
          actRef.current((c) => ({ ...c, typing: false }));
          goNodeRef.current(cur, n, false);
          return;
        }
        actRef.current(showEnd);
        return;
      }
    }
    afterNodeFinal(cur, n);
  };
  const advanceRef = useRef(advance);
  advanceRef.current = advance;

  /* ── назад / заново / к ноде ── */
  const back = (): void => {
    const cur = stRef.current;
    if (!cur || !cur.hist.length) return;
    const snap = cur.hist.pop() as Snap;
    const restored: PlState = {
      ...cur,
      nodeId: snap.nodeId, replyId: snap.replyId, intro: snap.intro, seqIdx: snap.seqIdx,
      vars: snap.vars ? { ...snap.vars } : { ...cur.vars },
      varChanged: new Set(snap.varChanged || []),
      dead: new Set(snap.dead || []),
      visited: new Set(snap.visited || []),
      choices: null, end: false, typing: false, shown: '', full: '',
      path: cur.path.slice(0, -1),
      avCid: null, hintOverride: null,
    };
    let guard = 0;
    while (restored.nodeId && guard++ < 50) {
      const nn = doc.nodes.find((x) => x.id === restored.nodeId);
      if (nn && nn.type !== 'varnode') break;
      const prev = restored.hist.pop();
      if (!prev) break;
      restored.nodeId = prev.nodeId;
      restored.replyId = prev.replyId;
      restored.intro = prev.intro;
      restored.seqIdx = prev.seqIdx;
      restored.vars = prev.vars ? { ...prev.vars } : restored.vars;
    }
    const n2 = restored.nodeId ? doc.nodes.find((x) => x.id === restored.nodeId) : null;
    if (!n2) { setSt(showEnd(restored)); return; }
    if (restored.intro && n2.dialog?.description) {
      setSt({ ...restored, full: n2.dialog.description, shown: n2.dialog.description, typing: false });
      return;
    }
    if (restored.replyId && n2.dialog) {
      const r = findReplyDeep(n2.dialog.replies || [], restored.replyId);
      if (r) { setSt({ ...restored, full: r.text || '…', shown: r.text || '…', typing: false, avCid: r.speaker || null }); return; }
    }
    if (restored.seqIdx >= 0 && restored.seqList && n2.dialog) {
      const r = findReplyDeep(n2.dialog.replies || [], restored.seqList[restored.seqIdx]);
      if (r) { setSt({ ...restored, full: r.text || '…', shown: r.text || '…', typing: false, avCid: r.speaker || null }); return; }
    }
    setSt({ ...restored, full: n2.text || '…', shown: n2.text || '…', typing: false, avCid: castAvCid(doc, n2) });
  };
  const backRef = useRef(back);
  backRef.current = back;

  const restart = (): void => {
    const cur = stRef.current;
    if (!cur) return;
    const startId = cur.mode === 'list' ? cur.list[0] : (cur.path[0] || cur.nodeId);
    const n = startId ? doc.nodes.find((x) => x.id === startId) : null;
    if (!n) return;
    const s0: PlState = {
      ...cur,
      nodeId: null, replyId: null, intro: false, lastReply: null,
      full: '', shown: '', typing: false,
      hist: [], path: [], idx: cur.mode === 'list' ? 0 : -1,
      varChanged: new Set(), visited: new Set<string>(), dead: new Set(),
      seqList: null, seqIdx: -1, choices: null, end: false, varFlash: null,
      avCid: null, hintOverride: null,
    };
    setSt(s0);
    setTimeout(() => { const c2 = stRef.current; if (c2) goNodeRef.current(c2, n, false); }, 0);
  };
  const restartRef = useRef(restart);
  restartRef.current = restart;

  const showNodeOnCanvas = (): void => {
    const cur = stRef.current;
    if (!cur) return;
    let rid = cur.replyId;
    if (!rid && cur.seqList && cur.seqIdx >= 0 && cur.seqList[cur.seqIdx]) rid = cur.seqList[cur.seqIdx];
    if (!rid) rid = cur.lastReply;
    const nid = cur.nodeId;
    store.closeModal();
    if (nid) {
      store.selectOnly(nid);
      store.requestCenter(nid);
      if (rid) store.requestFlash(nid, rid);
    }
  };
  const showRef = useRef(showNodeOnCanvas);
  showRef.current = showNodeOnCanvas;

  const pick = (list: Choice[], it: Choice): void => {
    const cur = stRef.current;
    if (!cur) return;
    if (!it.ok) {
      actRef.current((c) => ({ ...c, varFlash: { txt: 'Путь закрыт: ' + (it.why || ''), t: Date.now() } }));
      return;
    }
    pushHist(cur);
    // мёртвые ветки: непрошедшие альтернативы помечаются, общие части остаются живыми
    const alive = plReach(doc, cur, it.targets || []);
    const dead = new Set(cur.dead);
    for (const o of list) {
      if (o === it) continue;
      for (const t of o.targets || []) markDead(doc, dead, t, alive);
    }
    actRef.current((c) => ({ ...c, dead, choices: null }));
    it.fn();
  };
  const pickRef = useRef(pick);
  pickRef.current = pick;

  /* ── инициализация ── */
  useEffect(() => {
    const selIds = [...store.sel];
    const selNodes = selIds.map((id) => doc.nodes.find((n) => n.id === id)).filter(Boolean) as VetviNode[];
    let mode: 'graph' | 'list' = 'graph';
    let list: string[] = [];
    let startNode: VetviNode | null = null;
    if (start && start.only) {
      const n = doc.nodes.find((x) => x.id === start.nodeId);
      if (n) { mode = 'list'; list = [n.id]; startNode = n; }
    } else if (!start && selNodes.length >= 1) {
      const setIds = new Set<string>(selIds);
      for (const gid of store.selGroups) {
        for (const n of doc.nodes) {
          let cur: string | null = n.gid;
          while (cur) {
            if (cur === gid) { setIds.add(n.id); break; }
            cur = doc.groups.find((g) => g.id === cur)?.parent || null;
          }
        }
      }
      const arr = [...setIds].map((id) => doc.nodes.find((x) => x.id === id)).filter(Boolean) as VetviNode[];
      if (arr.length >= 1) { mode = 'list'; list = plBuildPlaylist(doc, arr).map((x) => x.id); startNode = arr[0]; }
    }
    if (!startNode) {
      startNode = start && start.nodeId ? doc.nodes.find((x) => x.id === start.nodeId) || null : null;
      if (!startNode) startNode = plPickStartNode(doc, selNodes);
    }
    if (!startNode) {
      store.toast('Проект пуст — нечего проигрывать', 'warn');
      store.closeModal();
      return;
    }
    const vars: Record<string, unknown> = {};
    for (const v of doc.vars || []) vars[v.id] = v.val;
    const s0: PlState = {
      nodeId: null, replyId: null, intro: false, lastReply: null,
      full: '', shown: '', typing: false,
      hist: [], path: [], mode, list, listSet: new Set(list), idx: mode === 'list' ? 0 : -1,
      vars, varChanged: new Set(), visited: new Set<string>(), dead: new Set(),
      seqList: null, seqIdx: -1, choices: null, end: false, varFlash: null,
      avCid: null, hintOverride: null,
    };
    setSt(s0);
    setTimeout(() => { const c = stRef.current; if (c) goNodeRef.current(c, startNode as VetviNode, false); }, 0);
     
  }, []);

  /* ── печатная машинка ── */
  useEffect(() => {
    if (!st || !st.typing) return;
    if (timerRef.current) clearInterval(timerRef.current);
    const t0 = performance.now();
    const dur = Math.min(2200, Math.max(260, st.full.length * 22));
    timerRef.current = setInterval(() => {
      const cur = stRef.current;
      if (!cur) return;
      const k = clamp((performance.now() - t0) / dur, 0, 1);
      if (k >= 1) {
        if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
        setSt({ ...cur, shown: cur.full, typing: false });
      } else {
        setSt({ ...cur, shown: cur.full.slice(0, Math.floor(k * cur.full.length)) });
      }
    }, 33);
    return () => {
      if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    };
  }, [st?.nodeId, st?.replyId, st?.intro, st?.seqIdx, st?.typing]);

  /* ── всплывашка изменения переменной: скрыть через 2.6с (plVarFlash оригинала) ── */
  useEffect(() => {
    if (!st?.varFlash) return;
    const ft = st.varFlash.t;
    const t = setTimeout(() => {
      setSt((c) => (c && c.varFlash && c.varFlash.t === ft ? { ...c, varFlash: null } : c));
    }, 2600);
    return () => clearTimeout(t);
  }, [st?.varFlash?.t]);

  /* ── клавиатура ── */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const cur = stRef.current;
      if (!cur) return;
      if (e.key === 'Escape') { e.preventDefault(); store.closeModal(); return; }
      if (e.key === ' ' || e.key === 'Enter' || e.key === 'ArrowRight') { e.preventDefault(); advanceRef.current(); return; }
      if (e.key === 'ArrowLeft' || e.key === 'Backspace') { e.preventDefault(); backRef.current(); return; }
      if (hkIs(e, 'plRestart')) { e.preventDefault(); restartRef.current(); return; }
      if (hkIs(e, 'plShow')) { e.preventDefault(); showRef.current(); return; }
      const m = /^Digit([1-9])$/.exec(e.code);
      if (m && cur.choices && cur.choices[Number(m[1]) - 1]) {
        e.preventDefault();
        pickRef.current(cur.choices, cur.choices[Number(m[1]) - 1]);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
     
  }, []);

  /* ── рендер ── */
  const n = st && st.nodeId ? doc.nodes.find((x) => x.id === st.nodeId) : null;

  /* реплика текущего слайда: выбранная (replyId) или «подряд» (seqList/seqIdx) — как plShowReply/plLinearShow */
  const curReply: VetviReply | null = (() => {
    if (!st || !n || !n.dialog) return null;
    if (st.replyId) return findReplyDeep(n.dialog.replies || [], st.replyId);
    if (st.seqList && st.seqIdx >= 0) return findReplyDeep(n.dialog.replies || [], st.seqList[st.seqIdx]);
    return null;
  })();
  const repChar = curReply && curReply.speaker ? store.charById(curReply.speaker) : null;

  /* цвет слайда --plc: реплика — цвет персонажа (иначе #8b929c), слайд — цвет ноды */
  const slideColor = curReply
    ? (repChar ? repChar.color || '#9cb878' : '#8b929c')
    : (n ? resolvedColor(doc, n) : '#e2a54e');
  /* подпись плашки имени: реплика — имя говорящего, слайд — первый участник (plCastName) */
  const nameStr = curReply
    ? (repChar ? repChar.name || '(без имени)' : null)
    : (n ? castName(doc, n) : null);
  /* аватар слайда — из состояния (#plAv): рамка в цвет персонажа, без аватара — буква */
  const avChar = st && st.avCid ? store.charById(st.avCid) : null;
  const sideAv = avChar
    ? { url: (avChar.av as string | null) || null, shape: avChar.avShape === 'square' ? 'square' : 'circle', color: avChar.color || '#9cb878', letter: charInitialOf(avChar) }
    : null;
  /* точка чипа главы — всегда цвет ноды (plChapterHtml использует nodeVisual) */
  const chipColor = n ? resolvedColor(doc, n) : '#e2a54e';

  const pathTail = st ? st.path.slice(-4) : [];
  const hasCnt = !!(st && st.mode === 'list' && st.list.length);
  const varsHud = useMemo(() => {
    if (!st) return [];
    return (doc.vars || []).map((v) => ({
      v,
      cur: st.vars[v.id] !== undefined && st.vars[v.id] !== null ? st.vars[v.id] : v.val,
      chg: st.varChanged.has(v.id),
    }));

  }, [st, doc.vars]);

  if (!st) return null;

  /* подсказка: оригинал показывает её всегда, кроме выбора и экрана «КОНЕЦ» */
  const hintVisible = !(st.choices && st.choices.length) && !st.end;
  const hint = st.hintOverride || hintFor(doc, st, n ?? null);
  /* пересборка .pl-box на каждый слайд — перезапуск анимации pl-anim */
  const slideKey = (st.nodeId || '') + '|' + (st.replyId || '') + '|' + st.seqIdx + '|' + (st.intro ? 'i' : 's');

  return (
    <div
      id="player"
      className="show"
      role="dialog"
      aria-label="Режим новеллы"
      onClick={(e) => { const t = e.target as HTMLElement | null; if (t && t.closest && t.closest('button')) return; advanceRef.current(); }}
    >
      <div className="pl-vig" />
      <div className="pl-top">
        <div className="pl-path" id="plPath">
          {hasCnt && <span className="pl-cnt">{Math.max(0, st.idx) + 1} / {st.list.length}</span>}
          {pathTail.map((id, i) => {
            const pn = doc.nodes.find((x) => x.id === id);
            return (
              <Fragment key={id + ':' + i}>
                {(i > 0 || hasCnt) && <span className="sep">→</span>}
                {i === pathTail.length - 1 ? <b>{pn?.title || '…'}</b> : <span>{pn?.title || '…'}</span>}
              </Fragment>
            );
          })}
        </div>
      </div>
      <div className="pl-vars" id="plVars" style={{ display: varsHud.length ? 'flex' : 'none' }}>
        {varsHud.map(({ v, cur, chg }) => (
          <span
            className={'pl-var' + (chg ? ' chg' : '')}
            key={v.id + '|' + String(cur) + (chg ? '|chg' : '')}
            title={chg ? 'значение изменилось в проигрывании' : undefined}
          >
            <i>{v.name}</i>
            <b>{varValText(cur, v)}</b>
          </span>
        ))}
      </div>
      <div className={'pl-varflash' + (st.varFlash ? ' show' : '')} id="plVarFlash">{st.varFlash ? st.varFlash.txt : ''}</div>
      <div className="pl-body">
        <div className="pl-wrap">
          <div className="pl-choices" id="plChoices" style={{ display: st.choices && st.choices.length ? 'flex' : 'none' }}>
            {(st.choices || []).map((c, i) => (
              <button
                key={i}
                type="button"
                className={'pl-choice' + (c.ok ? '' : ' lock')}
                onClick={(e) => { e.stopPropagation(); pickRef.current(st.choices as Choice[], c); }}
              >
                <span className="num">{i + 1}</span>
                {c.av && (
                  <span className={'pl-av sm ' + c.av.shape + (c.av.url ? '' : ' empty')} style={{ borderColor: c.av.color }}>
                    {c.av.url ? <img src={c.av.url} alt="" /> : c.av.letter}
                  </span>
                )}
                <span className="lbl">
                  {c.label}
                  {!c.ok && c.why && <i className="why">путь закрыт — {c.why}</i>}
                </span>
              </button>
            ))}
          </div>
          <div className="pl-chapter" id="plChapter">
            {n && (
              <span className="pl-chip">
                <i className="dot" style={{ background: chipColor }} />
                {typeNameOf(doc, n)}
                <span className="ttl">· {n.title || ''}</span>
              </span>
            )}
          </div>
          <div className={'pl-row' + (sideAv ? ' has-av' : '')} id="plRow">
            <div className="pl-side" id="plAv">
              {sideAv && (
                <span className={'pl-av ' + sideAv.shape + (sideAv.url ? '' : ' empty') + ' side'} style={{ borderColor: sideAv.color }}>
                  {sideAv.url ? <img src={sideAv.url} alt="" /> : sideAv.letter}
                </span>
              )}
            </div>
            <div className="pl-box pl-anim" id="plBox" key={slideKey} style={{ ['--plc' as string]: slideColor }}>
              <div className={'pl-name' + (nameStr ? '' : ' hidden')} id="plName">
                {nameStr && <span className="pl-t">{nameStr}</span>}
              </div>
              <div className="pl-text" id="plText">{st.shown}{st.typing && <span className="caret" />}</div>
              <div className="pl-hint" id="plHint" style={{ display: hintVisible ? undefined : 'none' }}>{hint}</div>
            </div>
          </div>
          <div className="pl-actions">
            <button type="button" className="pl-btn" id="plBackBtn" style={{ opacity: st.hist.length ? '1' : '.4' }} title="Шаг назад (←)" onClick={() => backRef.current()}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M10 19l-7-7 7-7" /><path d="M3 12h13a5 5 0 0 1 0 10h-3" /></svg>Назад
            </button>
            <button type="button" className="pl-btn" id="plRestartBtn" data-hk-title="plRestart" data-hk-base="Сначала" title="Сначала" onClick={() => restartRef.current()}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7" /><path d="M3 4v5h5" /></svg>Заново
            </button>
            <button type="button" className="pl-btn" id="plShowBtn" data-hk-title="plShow" data-hk-base="Выйти из проигрывания и показать на холсте ноду текущего текста" title="Выйти из проигрывания и показать на холсте ноду текущего текста" onClick={() => showRef.current()}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="7" /><path d="M12 2v4M12 18v4M2 12h4M18 12h4" /></svg>К ноде
            </button>
            <button type="button" className="pl-btn accent" id="plExitBtn" title="Выйти в редактор (Esc)" onClick={() => store.closeModal()}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18M6 6l12 12" /></svg>Выход
            </button>
          </div>
        </div>
      </div>
      {st.end && (
        <div className="pl-end show" id="plEnd">
          <h2>~ КОНЕЦ ~</h2>
          <div className="pl-sub">{st.mode === 'list' ? 'выделенный фрагмент проигран' : 'эта ветка истории завершена'}</div>
          <div className="pl-btns">
            <button type="button" className="pl-btn" id="plEndBack" title="Вернуться на шаг назад (←)" onClick={() => backRef.current()}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M10 19l-7-7 7-7" /><path d="M3 12h13a5 5 0 0 1 0 10h-3" /></svg>Назад
            </button>
            <button type="button" className="pl-btn" id="plEndRestart" data-hk-title="plRestart" data-hk-base="Сначала" onClick={() => restartRef.current()}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7" /><path d="M3 4v5h5" /></svg>Заново
            </button>
            <button type="button" className="pl-btn" id="plEndShow" data-hk-title="plShow" data-hk-base="Показать на холсте ноду текущего текста" title="Показать на холсте ноду текущего текста" onClick={() => showRef.current()}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="7" /><path d="M12 2v4M12 18v4M2 12h4M18 12h4" /></svg>К ноде
            </button>
            <button type="button" className="pl-btn accent" id="plEndExit" onClick={() => store.closeModal()}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18M6 6l12 12" /></svg>В редактор
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/* ── чистые помощники ── */

type Doc = VetviDoc;

function plPickStartNode(doc: Doc, selNodes: VetviNode[]): VetviNode | null {
  if (selNodes.length === 1) return selNodes[0];
  const roots = doc.nodes.filter((x) => !doc.edges.some((e) => e.to === x.id));
  const sc = roots.filter((x) => x.type === 'scene');
  return sc[0] || roots[0] || doc.nodes[0] || null;
}

function plBuildPlaylist(doc: Doc, arr: VetviNode[]): VetviNode[] {
  const set = new Set(arr.map((x) => x.id));
  const indeg: Record<string, number> = {};
  for (const x of arr) indeg[x.id] = 0;
  for (const e of doc.edges) {
    if (!set.has(e.from) || !set.has(e.to)) continue;
    if (e.tin === 'var') continue;
    if (indeg[e.to] !== undefined) indeg[e.to]++;
  }
  const byPos = (a: VetviNode, b: VetviNode) => (a.y - b.y) || (a.x - b.x);
  const ready = arr.filter((x) => !indeg[x.id]).sort(byPos);
  const out: VetviNode[] = [];
  const done = new Set<string>();
  const walk = (x: VetviNode) => {
    if (done.has(x.id)) return;
    done.add(x.id);
    out.push(x);
    const nexts = doc.edges.filter((e) => e.from === x.id && set.has(e.to) && e.tin !== 'var')
      .map((e) => arr.find((y) => y.id === e.to))
      .filter(Boolean) as VetviNode[];
    nexts.sort(byPos).forEach(walk);
  };
  ready.forEach(walk);
  arr.filter((x) => !done.has(x.id)).sort(byPos).forEach((x) => out.push(x));
  return out;
}

function playableEdges(doc: Doc, cur: PlState, nid: string): VetviDoc['edges'] {
  return doc.edges.filter((e) => {
    if (e.from !== nid || e.tin === 'var') return false;
    if (cur.mode === 'list' && !cur.listSet.has(e.to)) return false;
    return true;
  });
}

function replyTargets(doc: Doc, n: VetviNode, r: VetviReply): string[] {
  const direct = doc.edges.filter((e) => e.from === n.id && e.fromReply === r.id && e.tin !== 'var').map((e) => e.to);
  if (direct.length) return direct;
  const out: string[] = [];
  const walk = (x: VetviReply) => {
    for (const e of doc.edges) if (e.from === n.id && e.fromReply === x.id && e.tin !== 'var') out.push(e.to);
    if (x.children) x.children.forEach(walk);
  };
  r.children?.forEach(walk);
  return out.length ? out : [n.id];
}

function edgeLabel(doc: Doc, e: { label?: string | null; to: string }): string {
  if (e.label) return e.label;
  const t = doc.nodes.find((x) => x.id === e.to);
  return t?.title || 'далее';
}

function plReach(doc: Doc, cur: PlState, targets: string[]): Set<string> {
  const seen = new Set<string>();
  const q = [...targets];
  while (q.length) {
    const id = q.pop() as string;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const e of doc.edges) {
      if (e.from === id && e.tin !== 'var' && (cur.mode !== 'list' || cur.listSet.has(e.to))) q.push(e.to);
    }
  }
  return seen;
}

function markDead(doc: Doc, dead: Set<string>, from: string, alive: Set<string>): void {
  const q = [from];
  while (q.length) {
    const id = q.pop() as string;
    if (dead.has(id) || alive.has(id)) continue;
    dead.add(id);
    for (const e of doc.edges) {
      if (e.from === id && e.tin !== 'var') q.push(e.to);
    }
  }
}

function castName(doc: Doc, n: VetviNode): string | null {
  const parts = n.dialog ? n.dialog.participants || [] : (Array.isArray(n.participants) ? n.participants as string[] : []);
  if (!parts.length) return null;
  const first = (doc.chars || []).find((c) => c.id === parts[0]);
  const nm = first ? first.name : null;
  return parts.length > 1 ? (nm || '?') + ' +' + (parts.length - 1) : (nm || null);
}

function resolvedColor(doc: Doc, n: VetviNode): string {
  const parts = n.dialog ? n.dialog.participants || [] : (Array.isArray(n.participants) ? n.participants as string[] : []);
  if (parts.length && n.type !== 'dialog') {
    const c = (doc.chars || []).find((x) => x.id === parts[0]);
    if (c && c.color) return c.color;
  }
  if (n.color) return shade(n.color, clamp(Number(n.tint ?? 0), -60, 60));
  return typeColor(n.type);
}

function shade(hex: string, pct: number): string {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex);
  if (!m) return hex;
  const v = parseInt(m[1], 16);
  let r = (v >> 16) & 255;
  let g = (v >> 8) & 255;
  let b = v & 255;
  if (pct >= 0) {
    r += (255 - r) * (pct / 100);
    g += (255 - g) * (pct / 100);
    b += (255 - b) * (pct / 100);
  } else {
    r *= 1 + pct / 100;
    g *= 1 + pct / 100;
    b *= 1 + pct / 100;
  }
  const c = (x: number) => clamp(Math.round(x), 0, 255).toString(16).padStart(2, '0');
  return '#' + c(r) + c(g) + c(b);
}

const TYPE_COLORS: Record<string, string> = {
  scene: '#e2a54e', quest: '#cf6d4f', dialog: '#cbbd92', skill: '#7fb5a2', action: '#c9857a',
  branch: '#d6c96a', varnode: '#b7b26a', event: '#aab1bb', note: '#8b929c',
};

function typeColor(t: string): string {
  return TYPE_COLORS[t] || '#8b929c';
}

/* имя типа для чипа главы — typeInfo(name) оригинала: встроенный → свой тип → «Заметка» */
function typeNameOf(doc: Doc, n: VetviNode): string {
  const t = TYPES[n.type];
  if (t) return t.name;
  for (const c of doc.customTypes || []) {
    const ct = c as { id?: string; name?: string };
    if (ct.id === n.type && ct.name) return ct.name;
  }
  return TYPES.note.name;
}

/* первый участник ноды — как plCastAv оригинала */
function castAvCid(doc: Doc, n: VetviNode): string | null {
  const parts = n.dialog ? n.dialog.participants || [] : (Array.isArray(n.participants) ? n.participants as string[] : []);
  return parts.length ? (parts[0] as string) : null;
}

/* первая буква имени — charInitial оригинала */
function charInitialOf(c: { name?: string } | null | undefined): string {
  const nm = String((c && c.name) || '').trim();
  return nm ? nm[0].toUpperCase() : '?';
}

/* условие на стрелке (старое поле cond) */
function edgeCond(e: unknown): { vid: string; op: string; val: number | string } | null {
  const c = (e as { cond?: { vid: string; op: string; val: number | string } | null }).cond;
  return c || null;
}

/* текст подсказки после печати — как plAfterType/plListHint оригинала */
function hintFor(doc: Doc, st: PlState, n: VetviNode | null): string {
  const DURING = 'клик — далее ▸';
  if (!n || st.typing || st.intro) return DURING;
  const blocked = (e: VetviDoc['edges'][number]): string | null => {
    const c0 = edgeCond(e);
    const cw = c0 ? condWithOverride(doc, c0, n) : null;
    return cw && !condMet(doc, cw, st.vars) ? 'путь закрыт: ' + condText(doc, cw) + ' · ← назад' : null;
  };
  if (n.type === 'dialog' && n.linear && st.seqIdx >= 0) return DURING;
  if (st.replyId && n.type === 'dialog') {
    const r = findReplyDeep(n.dialog?.replies || [], st.replyId);
    if (r) {
      if ((r as unknown as { loop?: boolean }).loop) return 'клик — повтор диалога ▸';
      const kids = r.children || [];
      if (kids.length >= 1) return DURING;
      const ex = doc.edges.filter((e) => e.from === n.id && e.fromReply === r.id && e.tin !== 'var' && (st.mode !== 'list' || st.listSet.has(e.to)));
      if (ex.length > 1) return DURING;
      if (ex.length === 1) return blocked(ex[0]) || ('далее: ' + edgeLabel(doc, ex[0]) + ' ▸');
      const nx = doc.edges.filter((e) => e.from === n.id && !e.fromReply && e.tin !== 'var' && (st.mode !== 'list' || st.listSet.has(e.to)));
      if (nx.length > 1) return DURING;
      if (nx.length === 1) return blocked(nx[0]) || ('далее: ' + edgeLabel(doc, nx[0]) + ' ▸');
    }
  }
  const nx2 = doc.edges.filter((e) => e.from === n.id && !e.fromReply && e.tin !== 'var' && (st.mode !== 'list' || st.listSet.has(e.to)));
  if (nx2.length > 1) return DURING;
  if (nx2.length === 1) return blocked(nx2[0]) || ('далее: ' + edgeLabel(doc, nx2[0]) + ' ▸');
  if (st.mode === 'list') {
    const hasNext = st.list.some((id) => !st.visited.has(id) && !st.dead.has(id) && doc.nodes.some((x) => x.id === id));
    return hasNext ? DURING : 'клик — конец ▸';
  }
  return 'клик — конец ▸';
}

function findReplyDeep(replies: VetviReply[], id: string): VetviReply | null {
  for (const r of replies) {
    if (r.id === id) return r;
    if (r.children) {
      const f = findReplyDeep(r.children, id);
      if (f) return f;
    }
  }
  return null;
}

type VetniAlias = VetviNode;
