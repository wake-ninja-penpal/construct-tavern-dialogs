'use client';

/**
 * Ветви — контекстное меню и тосты (порт openCtxMenu/toast оригинала).
 * Позиция меню уже обрезана к границам окна в store.openCtx.
 */

import { useEffect, useRef } from 'react';

import type { VetviStore } from './store';

export function CtxMenuHost({ store }: { store: VetviStore }) {
  const ref = useRef<HTMLDivElement>(null);
  const ctx = store.ctx;
  void store.revision;

  useEffect(() => {
    if (!ctx) return;
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) store.closeCtx();
    };
    window.addEventListener('pointerdown', onDown, true);
    return () => window.removeEventListener('pointerdown', onDown, true);
  }, [ctx, store]);

  if (!ctx) return null;
  const items = ctx.items;
  const x = ctx.x;
  const y = ctx.y;

  return (
    <div ref={ref} className="rn-ctx show" style={{ left: x, top: y }} role="menu" aria-label="Контекстное меню">
      {items.map((it, i) => {
        if (it.sep) return <div className="rn-ctx-sep" key={i} />;
        if (it.head) return <div className="rn-ctx-h" key={i}>{it.head}</div>;
        return (
          <button
            key={i}
            type="button"
            role="menuitem"
            className={'rn-ctx-item' + (it.danger ? ' danger' : '')}
            onClick={() => { store.closeCtx(); if (it.fn) it.fn(); }}
          >
            {it.dot && <span className="rn-ctx-dot" style={{ background: it.dot }} />}
            {it.label}
          </button>
        );
      })}
    </div>
  );
}

export function ToastHost({ store }: { store: VetviStore }) {
  void store.revision;
  return (
    <div className="rn-toasts" aria-live="polite">
      {store.toasts.map((t) => (
        <div className={'rn-toast ' + t.kind} key={t.id}>
          <span className="td" />
          {t.msg}
        </div>
      ))}
    </div>
  );
}
