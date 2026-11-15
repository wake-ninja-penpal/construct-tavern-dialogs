'use client';

/**
 * Ветви — корневой компонент React-редактора (этап 1 порта index.html).
 * Компоновка: тулбар / холст / инспектор + глобальные горячие клавиши.
 * Полная дорожная карта порта — REFACTORING.md в корне репозитория.
 */

import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';

import { getStore, type VetviStore } from './store';
import { TopBar } from './TopBar';
import { CanvasBoard } from './CanvasBoard';
import { Inspector } from './Inspector';

function useStoreRevision(store: VetviStore): number {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

/* Признак монтирования: SSR даёт false, клиент после гидрации — true.
   Рендерим приложение только после монтирования: документ читается из
   localStorage при создании стора, сервер и клиент должны совпадать. */
const emptySubscribe = () => () => {};
function useMounted(): boolean {
  return useSyncExternalStore(emptySubscribe, () => true, () => false);
}

export default function VetviApp() {
  const store = useMemo(() => getStore(), []);
  useStoreRevision(store);
  const mounted = useMounted();

  /* Глобальные клавиши: undo/redo, удаление, снятие выделения.
     В полях ввода сочетания не перехватываются (там работает нативный undo). */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
      const mod = e.ctrlKey || e.metaKey;
      if (mod && !typing && (e.code === 'KeyZ')) {
        e.preventDefault();
        if (e.shiftKey) store.redo();
        else store.undo();
        return;
      }
      if (mod && !typing && e.code === 'KeyY') {
        e.preventDefault();
        store.redo();
        return;
      }
      if (!typing && (e.key === 'Delete' || e.key === 'Backspace')) {
        if (store.sel.size || store.selEdges.size) {
          e.preventDefault();
          store.deleteSelected();
        }
        return;
      }
      if (!typing && e.key === 'Escape') {
        store.clearSelection();
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
    <main className="rn-app" aria-label="Ветви — React-редактор (этап 1 порта)">
      <TopBar store={store} />
      <div className="rn-main">
        <CanvasBoard store={store} />
        <Inspector store={store} onClose={() => store.clearSelection()} />
      </div>
      <footer className="rn-statusbar" role="contentinfo">
        <span>React-версия · этап 1: холст, ноды, связи, инспектор, undo/redo, автосохранение</span>
        <span className="rn-status-r">
          {store.doc.nodes.length} нод · {store.doc.edges.length} связей · масштаб {Math.round(store.vp.z * 100)}%
        </span>
      </footer>
    </main>
  );
}
