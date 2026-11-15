'use client';

/**
 * Ветви — построители контекстных меню (порт ctx-меню оригинала, строки 9404–9532).
 */

import { hkText } from '@/vetvi/core/hotkeys';
import { NODE_W, TYPES } from '@/vetvi/core/constants';
import { screenToWorld } from '@/vetvi/core/geometry';
import type { CtxItem, VetviStore } from './store';

export function ctxMenus(store: VetviStore) {
  const w2 = (clientX: number, clientY: number): { x: number; y: number } => {
    const el = document.querySelector('.rn-canvas');
    const r = el ? el.getBoundingClientRect() : { left: 0, top: 0 };
    return screenToWorld(store.vp, clientX - r.left, clientY - r.top);
  };

  const addItems = (x: number, y: number): CtxItem[] => {
    const items: CtxItem[] = [{ head: 'Добавить' }];
    for (const [key, info] of Object.entries(TYPES)) {
      items.push({ dot: info.color, label: info.name, fn: () => { store.addNodeAt(key, x - NODE_W / 2, y - 20); } });
    }
    return items;
  };

  return {
    addItems,

    node(id: string): CtxItem[] {
      const n = store.nodeById(id);
      if (!n) return [{ label: 'Нода не найдена', fn: () => undefined }];
      const selCount = store.sel.size;
      const allDialogs = selCount >= 2 && [...store.sel].every((nid) => store.nodeById(nid)?.type === 'dialog');
      const items: CtxItem[] = [];
      items.push({ label: 'Играть отсюда (' + hkText('play') + ')', fn: () => {
        store.setPlayerStart(id, false);
        store.openModal('player');
      } });
      items.push({ label: 'Дублировать (' + hkText('duplicate') + ')', fn: () => {
        const r = store.duplicateSelection();
        if (r) store.startCarry(r.ids, r.pre);
      } });
      items.push({ label: 'Экспорт выделенных в JSON (' + hkText('exportSel') + ')', fn: () => store.exportSelection() });
      items.push({ label: 'Центрировать (' + hkText('centerSel') + ')', fn: () => store.requestCenter(id) });
      items.push({ label: 'Журнал изменений', fn: () => { store.setLogFilters(id, null); store.openModal('log'); } });
      if (n.type === 'dialog' && n.dialog && n.dialog.replies.length >= 2) {
        items.push({ label: 'Разбить на реплики (' + n.dialog.replies.length + ')', fn: () => store.splitDialogNode(id, false) });
      }
      if (allDialogs) items.push({ label: 'Объединить в один диалог', fn: () => store.mergeDialogNodes() });
      if (selCount > 1) {
        items.push({ sep: true });
        items.push({ label: 'Выровнять в ряд (' + hkText('alignH') + ')', fn: () => store.alignH() });
        items.push({ label: 'Выровнять в столбец (' + hkText('alignV') + ')', fn: () => store.alignV() });
      }
      items.push({ sep: true });
      items.push({ label: 'Свернуть / развернуть', fn: () => store.cycleExpand(id) });
      items.push({ label: 'Переименовать (F2)', fn: () => store.startRename(id) });
      items.push({ label: 'Выдернуть (как Alt+перенос)', fn: () => { store.detachNode(id); } });
      if (n.gid) {
        items.push({ sep: true });
        items.push({ label: 'Покинуть группу', fn: () => store.leaveGroup(id) });
      }
      items.push({ sep: true });
      items.push({ danger: true, label: 'Удалить', fn: () => store.deleteSelected() });
      return items;
    },

    edge(id: string): CtxItem[] {
      const e = store.edgeById(id);
      if (!e) return [{ label: 'Связь не найдена', fn: () => undefined }];
      const items: CtxItem[] = [];
      items.push({ label: 'Развернуть направление', fn: () => store.reverseEdge(id) });
      if (e.pts && e.pts.length) items.push({ label: 'Сбросить изгибы (' + e.pts.length + ')', fn: () => store.resetEdgePts(id) });
      items.push({ sep: true });
      items.push({ danger: true, label: 'Удалить связь', fn: () => store.deleteEdge(id) });
      return items;
    },

    group(gid: string): CtxItem[] {
      const g = store.groupById(gid);
      if (!g) return [{ label: 'Группа не найдена', fn: () => undefined }];
      const fold = g.fold === undefined ? 2 : g.fold;
      const items: CtxItem[] = [];
      items.push({ label: fold === 2 ? 'Свернуть в список' : fold === 1 ? 'Сжать в компакта' : 'Развернуть группу', fn: () => {
        const next = fold === 2 ? 1 : fold === 1 ? 0 : 2;
        store.updateGroup(gid, { fold: next }, { label: 'Вид группы' });
      } });
      items.push({ label: 'Выделить все ноды группы', fn: () => store.setSel(store.membersOf(gid).map((n) => n.id)) });
      items.push({ label: 'Переименовать / настроить', fn: () => store.selectGroupOnly(gid) });
      items.push({ label: 'Журнал изменений', fn: () => { store.setLogFilters(null, gid); store.openModal('log'); } });
      items.push({ label: 'Экспорт группы в JSON', fn: () => {
        const nodes = store.membersOf(gid);
        const ids = new Set(nodes.map((n) => n.id));
        import('@/vetvi/core/projects').then((m) => {
          m.downloadJson('vetvi-group.json', {
            app: 'vetvi-export', version: 1,
            nodes,
            edges: store.doc.edges.filter((e) => ids.has(e.from) && ids.has(e.to)),
            groups: [g],
          });
        });
      } });
      if (g.parent) items.push({ label: 'Вынуть из родителя', fn: () => store.updateGroup(gid, { parent: null }, { label: 'Вложенность группы' }) });
      items.push({ sep: true });
      items.push({ danger: true, label: 'Распустить группу', fn: () => store.dissolveGroup(gid) });
      return items;
    },

    canvas(clientX: number, clientY: number, addOnly = false): CtxItem[] {
      const w = w2(clientX, clientY);
      const items = addItems(w.x, w.y);
      if (!addOnly) {
        items.push({ sep: true });
        items.push({ label: 'Новая группа здесь (пустая)', fn: () => { store.createDrawnGroup({ x: w.x - 110, y: w.y - 75, w: 220, h: 150 }); } });
      }
      items.push({ sep: true });
      items.push({ label: 'Вписать всё (' + hkText('fitView') + ')', fn: () => {
        import('@/vetvi/web/canvasApi').then((m) => {
          const api = m.canvasApi.current;
          const r = api ? api.getRect() : null;
          if (r && api) store.fitView(r.width, r.height, api.sizes);
        });
      } });
      return items;
    },

    /** Меню «Создать и подключить» при броске связи в пустоту. */
    connectFrom(from: string, out: string | null, reply: string | null, clientX: number, clientY: number): CtxItem[] {
      const w = w2(clientX, clientY);
      const items: CtxItem[] = [{ head: 'Создать и подключить' }];
      for (const [key, info] of Object.entries(TYPES)) {
        items.push({ dot: info.color, label: info.name, fn: () => {
          const n = store.addNodeAt(key, w.x - NODE_W / 2, w.y - 20);
          store.connectNodes(from, n.id, { fromOut: out, fromReply: reply });
        } });
      }
      items.push({ head: 'Копия из раздела «На холсте»' });
      const pool = store.doc.nodes.filter((n) => n.id !== from).slice(0, 20);
      for (const src of pool) {
        items.push({ dot: src.color || (TYPES[src.type]?.color) || '#8b929c', label: (src.title || TYPES[src.type]?.name || '…').slice(0, 34), fn: () => {
          const pre = store.beginEdit();
          const clone = JSON.parse(JSON.stringify(src)) as typeof src;
          clone.id = Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);
          clone.x = Math.round(w.x - NODE_W / 2);
          clone.y = Math.round(w.y - 20);
          store.doc.nodes.push(clone);
          store.connectNodes(from, clone.id, { fromOut: out, fromReply: reply });
          store.commitEdit(pre, 'Создание и подключение');
          store.selectOnly(clone.id);
        } });
      }
      return items;
    },
  };
}
