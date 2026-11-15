'use client';

/**
 * Ветви — стор React-редактора.
 *
 * Классический ObservableStore + useSyncExternalStore (без внешних зависимостей):
 * документ мутабелен, перерисовка триггерится счётчиком revision.
 * История undo/redo — снимки serializeDoc (как pushHistory оригинала),
 * автосохранение — тот же ключ localStorage, что у /vetvi/index.html.
 */

import { AUTOSAVE_MS, HISTORY_LIMIT } from '@/vetvi/core/constants';
import { docFromParsed, loadAutosave, saveAutosave, serializeDoc } from '@/vetvi/core/doc';
import { defaultViewport } from '@/vetvi/core/factory';
import { clamp, clampZoom, docBounds, nodeHeight, nodeWidth, screenToWorld } from '@/vetvi/core/geometry';
import type { NodeSize, VetviDoc, VetviEdge, VetviNode, VetviViewport } from '@/vetvi/core/types';
import { newEdge, newNode, snapVal, uid } from '@/vetvi/core/factory';

type Listener = () => void;

export type SaveState = 'idle' | 'pending' | 'saved';

export class VetviStore {
  doc: VetviDoc;
  vp: VetviViewport = defaultViewport();
  bend = 'smooth';
  snapOn = true;
  gridOn = true;

  sel = new Set<string>();
  selEdges = new Set<string>();

  revision = 0;
  saveState: SaveState = 'idle';
  lastSavedAt = 0;

  private past: string[] = [];
  private future: string[] = [];
  private listeners = new Set<Listener>();
  private saveT: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    const loaded = loadAutosave();
    this.doc = loaded.doc;
    this.vp = loaded.vp;
    this.bend = loaded.bend;
  }

  /* ── подписка ── */

  subscribe = (l: Listener): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  getSnapshot = (): number => this.revision;

  private emit(): void {
    this.revision++;
    this.listeners.forEach((l) => l());
  }

  /* ── история и сохранение ── */

  /** Снимок текущего документа в стек undo (перед мутацией). */
  pushHistory(): void {
    this.past.push(serializeDoc(this.doc, this.vp, this.bend));
    if (this.past.length > HISTORY_LIMIT) this.past.shift();
    this.future.length = 0;
  }

  /** Начало серии правок из поля ввода: снимок «до». */
  beginEdit(): string {
    return serializeDoc(this.doc, this.vp, this.bend);
  }

  /** Конец серии правок: если документ изменился — снимок «до» уходит в undo. */
  commitEdit(pre: string | null): void {
    if (!pre) return;
    const cur = serializeDoc(this.doc, this.vp, this.bend);
    if (cur === pre) return;
    this.past.push(pre);
    if (this.past.length > HISTORY_LIMIT) this.past.shift();
    this.future.length = 0;
    this.scheduleSave();
    this.emit();
  }

  private scheduleSave(): void {
    if (this.saveT) clearTimeout(this.saveT);
    this.saveState = 'pending';
    this.saveT = setTimeout(() => {
      this.saveT = null;
      this.doc.meta.modified = Date.now();
      saveAutosave(this.doc, this.vp, this.bend);
      this.saveState = 'saved';
      this.lastSavedAt = Date.now();
      this.emit();
    }, AUTOSAVE_MS);
  }

  /** Мутация с записью в историю. fn меняет this.doc напрямую. */
  mutate(fn: (doc: VetviDoc) => void, opts?: { history?: boolean }): void {
    if (!opts || opts.history !== false) this.pushHistory();
    fn(this.doc);
    this.scheduleSave();
    this.emit();
  }

  undo(): void {
    const pre = this.past.pop();
    if (!pre) return;
    this.future.push(serializeDoc(this.doc, this.vp, this.bend));
    this.doc = docFromParsed(JSON.parse(pre));
    this.sel.clear();
    this.selEdges.clear();
    this.scheduleSave();
    this.emit();
  }

  redo(): void {
    const nxt = this.future.pop();
    if (!nxt) return;
    this.past.push(serializeDoc(this.doc, this.vp, this.bend));
    this.doc = docFromParsed(JSON.parse(nxt));
    this.sel.clear();
    this.selEdges.clear();
    this.scheduleSave();
    this.emit();
  }

  canUndo(): boolean {
    return this.past.length > 0;
  }

  canRedo(): boolean {
    return this.future.length > 0;
  }

  /** Немедленно сохранить (перед выгрузкой страницы). */
  flushSave(): void {
    if (this.saveT) {
      clearTimeout(this.saveT);
      this.saveT = null;
    }
    this.doc.meta.modified = Date.now();
    saveAutosave(this.doc, this.vp, this.bend);
    this.saveState = 'saved';
    this.lastSavedAt = Date.now();
    this.emit();
  }

  /* ── выделение ── */

  selectOnly(id: string): void {
    this.sel.clear();
    this.selEdges.clear();
    this.sel.add(id);
    this.emit();
  }

  toggleSelect(id: string): void {
    this.selEdges.clear();
    if (this.sel.has(id)) this.sel.delete(id);
    else this.sel.add(id);
    this.emit();
  }

  selectEdgeOnly(id: string): void {
    this.sel.clear();
    this.selEdges.clear();
    this.selEdges.add(id);
    this.emit();
  }

  clearSelection(): void {
    if (!this.sel.size && !this.selEdges.size) return;
    this.sel.clear();
    this.selEdges.clear();
    this.emit();
  }

  /* ── операции с нодами ── */

  addNodeAt(type: string, wx: number, wy: number): VetviNode {
    const n = newNode(type, wx, wy);
    this.mutate((doc) => {
      doc.nodes.push(n);
    });
    this.selectOnly(n.id);
    return n;
  }

  updateNode(id: string, patch: Partial<VetviNode>, opts?: { history?: boolean }): void {
    this.mutate((doc) => {
      const n = doc.nodes.find((x) => x.id === id);
      if (n) Object.assign(n, patch);
    }, opts);
  }

  /** Перемещение выделенных нод (перетаскивание): одна запись истории на жест. */
  dragStartSnapshot: string | null = null;
  dragMoved = false;

  dragBegin(): void {
    this.dragStartSnapshot = serializeDoc(this.doc, this.vp, this.bend);
    this.dragMoved = false;
  }

  dragMoveBy(dx: number, dy: number): void {
    if (!dx && !dy) return;
    this.dragMoved = true;
    for (const id of this.sel) {
      const n = this.doc.nodes.find((x) => x.id === id);
      if (!n) continue;
      n.x += dx;
      n.y += dy;
    }
    this.emit();
  }

  dragEnd(): void {
    if (this.dragMoved && this.dragStartSnapshot) {
      const snap = this.dragStartSnapshot;
      this.dragStartSnapshot = null;
      if (this.snapOn) {
        for (const id of this.sel) {
          const n = this.doc.nodes.find((x) => x.id === id);
          if (!n) continue;
          n.x = snapVal(n.x, true);
          n.y = snapVal(n.y, true);
        }
      }
      this.past.push(snap);
      if (this.past.length > HISTORY_LIMIT) this.past.shift();
      this.future.length = 0;
      this.scheduleSave();
      this.emit();
    } else {
      this.dragStartSnapshot = null;
      this.dragMoved = false;
    }
  }

  deleteSelected(): void {
    if (!this.sel.size && !this.selEdges.size) return;
    this.mutate((doc) => {
      if (this.selEdges.size) {
        const eids = new Set(this.selEdges);
        doc.edges = doc.edges.filter((e) => !eids.has(e.id));
        this.selEdges.clear();
        return;
      }
      const ids = new Set(this.sel);
      doc.nodes = doc.nodes.filter((n) => !ids.has(n.id));
      doc.edges = doc.edges.filter((e) => !ids.has(e.from) && !ids.has(e.to));
      // группы без нод убираются
      let changed = true;
      while (changed) {
        changed = false;
        doc.groups = doc.groups.filter((g) => {
          const has = doc.nodes.some((n) => n.gid === g.id);
          if (!has) {
            changed = true;
            return false;
          }
          return true;
        });
      }
      this.sel.clear();
    });
  }

  /* ── связи ── */

  connectNodes(from: string, to: string, fromOut?: string | null): VetviEdge | null {
    if (from === to) return null;
    const dup = this.doc.edges.find(
      (e) => e.from === from && e.to === to && (e.fromOut || null) === (fromOut || null),
    );
    if (dup) return null;
    const e = newEdge(from, to, fromOut);
    this.mutate((doc) => {
      doc.edges.push(e);
    });
    return e;
  }

  deleteEdge(id: string): void {
    this.mutate((doc) => {
      doc.edges = doc.edges.filter((e) => e.id !== id);
      this.selEdges.clear();
    });
  }

  updateEdge(id: string, patch: Partial<VetviEdge>): void {
    this.mutate((doc) => {
      const e = doc.edges.find((x) => x.id === id);
      if (e) Object.assign(e, patch);
    });
  }

  /* ── реплики диалога (первый уровень; вложенность — этап 2) ── */

  addReply(nodeId: string): void {
    this.mutate((doc) => {
      const n = doc.nodes.find((x) => x.id === nodeId);
      if (!n || n.type !== 'dialog' || !n.dialog) return;
      if (!Array.isArray(n.dialog.replies)) n.dialog.replies = [];
      n.dialog.replies.push({ id: uid(), speaker: null, text: '' });
    });
  }

  deleteReply(nodeId: string, replyId: string): void {
    this.mutate((doc) => {
      const n = doc.nodes.find((x) => x.id === nodeId);
      if (!n || !n.dialog) return;
      n.dialog.replies = n.dialog.replies.filter((r) => r.id !== replyId);
    });
  }

  moveReply(nodeId: string, replyId: string, dir: -1 | 1): void {
    this.mutate((doc) => {
      const n = doc.nodes.find((x) => x.id === nodeId);
      if (!n || !n.dialog) return;
      const arr = n.dialog.replies;
      const i = arr.findIndex((r) => r.id === replyId);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= arr.length) return;
      const tmp = arr[i];
      arr[i] = arr[j];
      arr[j] = tmp;
    });
  }

  /* ── исходы развилки ── */

  addOutcome(nodeId: string): void {
    this.mutate((doc) => {
      const n = doc.nodes.find((x) => x.id === nodeId);
      if (!n || n.type !== 'branch') return;
      if (!Array.isArray(n.outcomes)) n.outcomes = [];
      n.outcomes.push({ id: uid(), label: '', cond: null });
    });
  }

  deleteOutcome(nodeId: string, oid: string): void {
    this.mutate((doc) => {
      const n = doc.nodes.find((x) => x.id === nodeId);
      if (!n || !Array.isArray(n.outcomes)) return;
      n.outcomes = n.outcomes.filter((o) => o.id !== oid);
      doc.edges = doc.edges.filter((e) => !(e.from === nodeId && e.fromOut === oid));
    });
  }

  /* ── проект ── */

  setProjectName(name: string): void {
    this.mutate((doc) => {
      doc.meta.name = name;
    });
  }

  /* ── вид ── */

  setViewport(vp: Partial<VetviViewport>): void {
    if (typeof vp.x === 'number') this.vp.x = vp.x;
    if (typeof vp.y === 'number') this.vp.y = vp.y;
    if (typeof vp.z === 'number') this.vp.z = clampZoom(vp.z);
    this.scheduleSave();
    this.emit();
  }

  zoomAt(screenX: number, screenY: number, factor: number): void {
    const z0 = this.vp.z;
    const z1 = clampZoom(z0 * factor);
    if (z1 === z0) return;
    const w = screenToWorld(this.vp, screenX, screenY);
    this.vp.z = z1;
    this.vp.x = screenX - w.x * z1;
    this.vp.y = screenY - w.y * z1;
    this.scheduleSave();
    this.emit();
  }

  panBy(dx: number, dy: number): void {
    this.vp.x += dx;
    this.vp.y += dy;
    this.emit();
  }

  panEnd(): void {
    this.scheduleSave();
    this.emit();
  }

  fitView(vw: number, vh: number, sizes: Map<string, NodeSize>): void {
    const b = docBounds(this.doc, sizes);
    if (!b) {
      this.setViewport({ x: 0, y: 0, z: 1 });
      return;
    }
    const pad = 70;
    const z = clampZoom(Math.min((vw - pad * 2) / Math.max(b.w, 1), (vh - pad * 2) / Math.max(b.h, 1)));
    this.vp.z = z;
    this.vp.x = vw / 2 - (b.x + b.w / 2) * z;
    this.vp.y = vh / 2 - (b.y + b.h / 2) * z;
    this.scheduleSave();
    this.emit();
  }

  toggleSnap(): void {
    this.snapOn = !this.snapOn;
    this.emit();
  }

  toggleGrid(): void {
    this.gridOn = !this.gridOn;
    this.emit();
  }

  /* ── вспомогательное для компонентов ── */

  nodeById(id: string): VetviNode | undefined {
    return this.doc.nodes.find((n) => n.id === id);
  }

  nodeSize(id: string, sizes: Map<string, NodeSize>): { w: number; h: number } {
    const n = this.nodeById(id);
    const s = sizes.get(id);
    if (!n) return { w: 0, h: 0 };
    return { w: nodeWidth(n, s), h: nodeHeight(n, s) };
  }
}

/** Хуки доступа к стору (единственный экземпляр на вкладку). */
let singleton: VetviStore | null = null;

export function getStore(): VetviStore {
  if (!singleton) singleton = new VetviStore();
  return singleton;
}
