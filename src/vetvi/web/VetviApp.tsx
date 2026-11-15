'use client';

/**
 * Ветви — корневой компонент React-редактора (этап 2 порта).
 * Компоновка: тулбар / левая панель + холст + инспектор / статусбар,
 * все модальные окна, проигрыватель, диспетчер горячих клавиш HK_DEFS
 * (строгая цепочка условий, как в оригинале, строки 9949–10033).
 */

import { useEffect, useMemo, useSyncExternalStore } from 'react';

import { hkIs, hkLoad, hkText } from '@/vetvi/core/hotkeys';
import { getStore, type VetviStore } from './store';
import { SyncClient } from './sync';
import { TopBar } from './TopBar';
import { CanvasBoard } from './CanvasBoard';
import { LeftPane } from './LeftPane';
import { Inspector } from './Inspector';
import { Player } from './Player';
import { DialogModal } from './DialogModal';
import { ModalHost, ConfirmHost, bindLogHelpers } from './Modals';
import { CtxMenuHost, ToastHost } from './CtxMenu';
import { CollabPopover, LockScreen, LockTipHost } from './SyncModals';
import { canvasApi } from './canvasApi';

function useStoreRevision(store: VetviStore): number {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

/* Рендер после монтирования: документ читается из localStorage при создании стора. */
const emptySubscribe = () => () => {};
function useMounted(): boolean {
  return useSyncExternalStore(emptySubscribe, () => true, () => false);
}

export default function VetviApp() {
  const store = useMemo(() => getStore(), []);
  useStoreRevision(store);
  const mounted = useMounted();

  /* личные хоткеи + проект из хеша (#project=<id>) + realtime-клиент */
  useEffect(() => {
    hkLoad();
    store.applyHashProject();
    store.applyLockState();
    store.setPlayerStart(null, false);
    (window as unknown as { __vetvi?: VetviStore }).__vetvi = store;
    bindLogHelpers((_e, nid) => {
      const n = store.nodeById(nid);
      return n ? (n.title || '') : null;
    });
    /* realtime-коллаборация: rooms/live/локи/копии/merge (этап 3) */
    if (!store.sync) {
      store.setSyncClient(new SyncClient(store));
      store.sync!.init();
    }
  }, [store]);

  /* попап участников закрывается кликом мимо (capture, как bindSyncUI оригинала) */
  useEffect(() => {
    if (!store.collabPop) return;
    const onDoc = (e: Event) => {
      const t = e.target as Element | null;
      if (!t) return;
      if (t.closest('.collab-pop')) return;
      if (t.closest('.rn-sync-chip')) return;
      store.setCollabPop(false);
    };
    document.addEventListener('pointerdown', onDoc, true);
    return () => document.removeEventListener('pointerdown', onDoc, true);
  }, [store, store.collabPop]);

  /* ── диспетчер горячих клавиш (цепочка условий оригинала) ── */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = !!t && t.isConnected && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
      const modal = store.modal;
      const dlgOpen = !!store.dialogEdit;
      const playerOpen = modal === 'player';
      const patchOpen = modal === 'patch';
      const searchOpen = modal === 'search';

      /* экран пароля запертого проекта/ввод пароля комнаты — хоткеи глушим */
      if (store.lockNeeded()) return;

      if (playerOpen) return; // Player слушает сам

      if (patchOpen) {
        if (e.key === 'Escape' || hkIs(e, 'patchnotes')) {
          e.preventDefault();
          store.closeModal();
        }
        return;
      }
      if (searchOpen) {
        if (e.key === 'Escape' || hkIs(e, 'search')) {
          e.preventDefault();
          store.closeModal();
        }
        return;
      }

      /* режим «нож» (Alt) и пан-модификаторы — CanvasBoard */

      if (typing) {
        /* в поле ввода глобальные Mod-сочетания работают всегда */
        if (hkIs(e, 'search')) { e.preventDefault(); store.openModal('search'); return; }
        if (hkIs(e, 'patchnotes')) { e.preventDefault(); store.openModal('patch'); return; }
        if (hkIs(e, 'save')) { e.preventDefault(); store.saveAs(); return; }
        if (hkIs(e, 'saveAs')) { e.preventDefault(); store.saveAs(); return; }
        if (hkIs(e, 'projects')) { e.preventDefault(); store.openModal('projects'); return; }
        if (e.key === 'Escape') (document.activeElement as HTMLElement | null)?.blur();
        return;
      }

      if (hkIs(e, 'patchnotes')) { e.preventDefault(); store.openModal('patch'); return; }
      if (hkIs(e, 'search')) { e.preventDefault(); store.openModal('search'); return; }

      if (hkIs(e, 'rename')) {
        e.preventDefault();
        if (store.sel.size === 1) store.startRename([...store.sel][0]);
        return;
      }
      if (hkIs(e, 'undo')) { e.preventDefault(); store.undo(); return; }
      if (hkIs(e, 'redo')) { e.preventDefault(); store.redo(); return; }
      if (hkIs(e, 'saveAs')) { e.preventDefault(); store.saveAs(); return; }
      if (hkIs(e, 'save')) { e.preventDefault(); store.saveAs(); return; }
      if (hkIs(e, 'projects')) { e.preventDefault(); store.openModal('projects'); return; }
      if (hkIs(e, 'newProject')) { e.preventDefault(); store.createProject(); return; }
      if (hkIs(e, 'duplicate')) {
        e.preventDefault();
        const r = store.duplicateSelection();
        if (r) store.startCarry(r.ids, r.pre);
        return;
      }
      if (hkIs(e, 'exportSel')) { e.preventDefault(); if (store.sel.size) store.exportSelection(); else store.toast('Выделите ноды для экспорта', 'warn'); return; }
      if (hkIs(e, 'alignH')) { e.preventDefault(); store.alignH(); return; }
      if (hkIs(e, 'alignV')) { e.preventDefault(); store.alignV(); return; }
      if (hkIs(e, 'ungroup')) {
        e.preventDefault();
        const gid = [...store.selGroups][0] || ([...store.sel][0] ? store.nodeById([...store.sel][0])?.gid : null);
        if (gid) store.dissolveGroup(gid);
        else store.toast('Нет группы для роспуска', 'warn');
        return;
      }
      if (hkIs(e, 'group')) {
        e.preventDefault();
        if (store.sel.size + store.selGroups.size >= 2) store.openModal('groupCreate');
        else store.toast('Выделите минимум два объекта (или нарисуйте группу: Ctrl+Shift+ЛКМ)', 'warn');
        return;
      }
      if (hkIs(e, 'selectAll')) { e.preventDefault(); store.selectAll(); return; }
      if (hkIs(e, 'deleteSel')) { e.preventDefault(); store.deleteSelected(); return; }

      if (e.key === 'Escape') {
        if (store.carry) { store.cancelCarry(); store.toast('Перенос дубликата отменён', 'warn'); return; }
        if (dlgOpen) { store.commitReplyEdit(null); store.closeDialogEditor(); return; }
        if (store.confirm) { store.closeConfirm(); return; }
        if (store.ctx) { store.closeCtx(); return; }
        if (modal && modal !== 'player') { store.closeModal(); return; }
        store.clearSelection();
        return;
      }

      if (hkIs(e, 'centerSel')) {
        if (store.sel.size === 1) store.requestCenter([...store.sel][0]);
        return;
      }
      if (hkIs(e, 'play')) {
        e.preventDefault();
        const pn = store.pointerNodeId();
        store.setPlayerStart(pn, false);
        store.openModal('player');
        return;
      }
      if (hkIs(e, 'playNode')) {
        e.preventDefault();
        const pn = store.pointerNodeId();
        if (!pn) {
          store.toast('Наведите курсор на ноду или выделите одну ноду — и её можно проиграть отдельно', 'warn');
          return;
        }
        store.setPlayerStart(pn, true);
        store.openModal('player');
        return;
      }
      if (hkIs(e, 'fitView')) {
        e.preventDefault();
        const api = canvasApi.current;
        const r = api ? api.getRect() : null;
        if (r && api) store.fitView(r.width, r.height, api.sizes);
        return;
      }
      if (hkIs(e, 'zoomIn') || hkIs(e, 'zoomOut')) {
        e.preventDefault();
        const api = canvasApi.current;
        const r = api ? api.getRect() : null;
        if (r) store.zoomAt(r.width / 2, r.height / 2, hkIs(e, 'zoomIn') ? 1.15 : 1 / 1.15);
        return;
      }
    };
    window.addEventListener('keydown', onKey);
    const beforeUnload = () => store.flushSave();
    window.addEventListener('beforeunload', beforeUnload);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('beforeunload', beforeUnload);
    };
  }, [store]);

  if (!mounted) {
    return <main className="rn-app" aria-label="Ветви — React-редактор" />;
  }

  return (
    <main className="rn-app" aria-label="Ветви — React-редактор">
      <TopBar store={store} />
      <div className="rn-main">
        <LeftPane store={store} />
        <div className="rn-center">
          <CanvasBoard store={store} />
        </div>
        <Inspector store={store} onClose={() => store.clearSelection()} />
      </div>
      <footer className="rn-statusbar" role="contentinfo">
        <span>React-версия · этап 3: realtime-коллаборация (комнаты, живые правки, локи, копии, merge, пароли)</span>
        <span className="rn-status-r">
          {store.doc.nodes.length} нод · {store.doc.edges.length} связей · {store.doc.vars?.length || 0} перем. · {store.doc.chars?.length || 0} персон. · масштаб {Math.round(store.vp.z * 100)}%
        </span>
      </footer>

      <DialogModal store={store} />
      <ModalHost store={store} />
      <ConfirmHost store={store} />
      {store.modal === 'player' && <Player store={store} />}
      <CtxMenuHost store={store} />
      <ToastHost store={store} />
      <CollabPopover store={store} />
      <LockTipHost store={store} />
      <LockScreen store={store} />
      {/* подсказки сочетаний на кнопках обновляет hkText при рендере */}
      <span hidden data-hk-play={hkText('play')} />
    </main>
  );
}
