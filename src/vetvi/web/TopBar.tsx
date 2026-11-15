'use client';

/**
 * Ветви — верхняя панель React-редактора: имя проекта, undo/redo,
 * добавление нод, состояние автосохранения и переход к классической версии.
 */

import { useEffect, useRef, useState } from 'react';

import { TYPES } from '@/vetvi/core/constants';
import type { VetviStore } from './store';

export function TopBar(props: { store: VetviStore }) {
  const { store } = props;
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [menuOpen]);

  const saveLabel =
    store.saveState === 'pending' ? 'сохранение…' : (store.saveState === 'saved' ? '✓ автосохранение' : 'готово');

  return (
    <header className="rn-topbar" role="banner">
      <span className="rn-brand">Ветви <em>React</em></span>

      <input
        className="rn-name"
        value={store.doc.meta.name}
        aria-label="Название проекта"
        onChange={(e) => store.setProjectName(e.target.value)}
      />

      <div className="rn-tools" role="toolbar" aria-label="Инструменты">
        <div className="rn-addwrap" ref={menuRef}>
          <button
            type="button"
            className="rn-btn primary"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((v) => !v)}
          >
            + Нода
          </button>
          {menuOpen && (
            <div className="rn-menu" role="menu" aria-label="Тип новой ноды">
              {Object.entries(TYPES).map(([key, info]) => (
                <button
                  key={key}
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    const el = document.querySelector('.rn-canvas');
                    const r = el ? el.getBoundingClientRect() : { width: 800, height: 600, left: 0, top: 0 };
                    const wx = (r.width / 2 - store.vp.x) / store.vp.z - 108;
                    const wy = (r.height / 2 - store.vp.y) / store.vp.z - 40;
                    store.addNodeAt(key, wx, wy);
                  }}
                >
                  <span className="rn-dot" style={{ background: info.color }} />
                  {info.name}
                </button>
              ))}
            </div>
          )}
        </div>
        <button type="button" className="rn-btn" title="Отменить (Ctrl+Z)" onClick={() => store.undo()}>↺</button>
        <button type="button" className="rn-btn" title="Повторить (Ctrl+Y)" onClick={() => store.redo()}>↻</button>
      </div>

      <span className="rn-counts">
        узлов: {store.doc.nodes.length} · связей: {store.doc.edges.length}
      </span>

      <span className="rn-save" data-state={store.saveState}>{saveLabel}</span>

      <a className="rn-classic" href="/vetvi/index.html" title="Классическая версия редактора">
        Классическая версия
      </a>
    </header>
  );
}
