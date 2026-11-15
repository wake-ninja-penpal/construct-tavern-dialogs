'use client';

/**
 * Ветви — контекстное меню и тосты (порт #ctx/#toasts оригинала).
 * Разметка 1:1: #ctx.show > .ctx-sep/.ctx-h/.ctx-i(.danger)>span.dot,
 * #toasts > .toast(.ok|.warn|.err)>.td. Позиция меню уже обрезана к границам
 * окна в store.openCtx; авто-скрытие тоста — store (2800 мс), здесь фаза .out.
 */

import { useEffect, useRef, useState } from 'react';

import type { Toast, VetviStore } from './store';

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

  return (
    <div id="ctx" ref={ref} className="show" style={{ left: ctx.x, top: ctx.y }} role="menu" aria-label="Контекстное меню">
      {ctx.items.map((it, i) => {
        if (it.sep) return <div className="ctx-sep" key={i} />;
        if (it.head) return <div className="ctx-h" key={i}>{it.head}</div>;
        return (
          <div
            key={i}
            className={'ctx-i' + (it.danger ? ' danger' : '')}
            role="menuitem"
            onClick={(ev) => { ev.stopPropagation(); store.closeCtx(); if (it.fn) it.fn(); }}
          >
            {it.dot && <span className="dot" style={{ background: it.dot }} />}
            {it.label}
          </div>
        );
      })}
    </div>
  );
}

/* один тост: за 320 мс до удаления из store включается класс .out (tOut оригинала) */
function ToastRow({ t }: { t: Toast }) {
  const [out, setOut] = useState(false);
  useEffect(() => {
    const tm = window.setTimeout(() => setOut(true), 2480);
    return () => window.clearTimeout(tm);
  }, []);
  return (
    <div className={'toast ' + t.kind + (out ? ' out' : '')}>
      <span className="td" />
      {t.msg}
    </div>
  );
}

export function ToastHost({ store }: { store: VetviStore }) {
  void store.revision;
  return (
    <div id="toasts" aria-live="polite">
      {store.toasts.map((t) => (
        <ToastRow key={t.id} t={t} />
      ))}
    </div>
  );
}
