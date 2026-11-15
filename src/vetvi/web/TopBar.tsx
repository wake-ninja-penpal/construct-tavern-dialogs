'use client';

/**
 * Ветви — тулбар (этап 2): имя проекта, Играть, undo/redo, меню сохранения
 * (JSON/экспорт выделенных/импорт), проекты, поиск, журнал, патчноут,
 * настройки, счётчики, автосохранение, классическая версия.
 */

import { useEffect, useRef, useState } from 'react';

import { TYPES } from '@/vetvi/core/constants';
import { hkText } from '@/vetvi/core/hotkeys';
import type { VetviStore } from './store';

export function TopBar(props: { store: VetviStore }) {
  const { store } = props;
  const [menuOpen, setMenuOpen] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const addRef = useRef<HTMLDivElement>(null);
  const saveRef = useRef<HTMLDivElement>(null);
  void store.revision;

  useEffect(() => {
    if (!menuOpen && !saveOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (menuOpen && addRef.current && !addRef.current.contains(e.target as Node)) setMenuOpen(false);
      if (saveOpen && saveRef.current && !saveRef.current.contains(e.target as Node)) setSaveOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [menuOpen, saveOpen]);

  const saveLabel =
    store.saveState === 'pending' ? 'сохранение…' : (store.saveState === 'saved' ? '✓ автосохранение' : 'готово');

  const statusChip = (() => {
    const map: Record<string, [string, string]> = {
      off: ['#6d7480', 'офлайн'],
      conn: ['#d8c96f', 'подключение…'],
      on: ['#8fbf7f', 'онлайн'],
      err: ['#cf6b5a', 'ошибка связи'],
      lost: ['#cf6b5a', 'связь потеряна'],
      copy: ['#e2a54e', 'копия'],
    };
    const [c, t] = map[store.syncStatus] || map.off;
    return (
      <button
        type="button"
        className="rn-sync-chip"
        style={{ ['--sc' as string]: c }}
        title="Совместное редактирование (ветка react-refactor: прототип)"
        onClick={() => { store.openModal('share'); }}
      >
        <i />
        {store.syncStatus === 'on' && store.syncUsers.length ? store.syncUsers.length + ' онлайн' : t}
      </button>
    );
  })();

  return (
    <header className="rn-topbar" role="banner">
      <span className="rn-brand">Ветви <em>React</em></span>

      <input
        className="rn-name"
        value={store.doc.meta.name || ''}
        aria-label="Название проекта"
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => store.setProjectName(e.target.value)}
      />

      <div className="rn-tools" role="toolbar" aria-label="Инструменты">
        <div className="rn-addwrap" ref={addRef}>
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

        <button type="button" className="rn-btn play" title={'Режим новеллы (' + hkText('play') + ') — выделенные блоки по порядку или весь сюжет'} onClick={() => {
          store.setPlayerStart(null, false);
          store.openModal('player');
        }}>▶ Играть</button>

        <div className="rn-savewrap" ref={saveRef}>
          <button type="button" className={'rn-btn' + (saveOpen ? ' on' : '')} title="Сохранение и экспорт" onClick={() => setSaveOpen((v) => !v)}>⬇ Меню</button>
          {saveOpen && (
            <div className="rn-menu" role="menu">
              <button type="button" role="menuitem" onClick={() => { setSaveOpen(false); store.saveAs(); }}>Сохранить проект (JSON) <kbd>{hkText('save')}</kbd></button>
              <button type="button" role="menuitem" onClick={() => { setSaveOpen(false); store.saveAs(); }}>Сохранить как… (JSON) <kbd>{hkText('saveAs')}</kbd></button>
              <button type="button" role="menuitem" onClick={() => { setSaveOpen(false); if (store.sel.size) store.exportSelection(); else store.toast('Выделите ноды для экспорта', 'warn'); }}>Экспорт выделенных нод <kbd>{hkText('exportSel')}</kbd></button>
              <div className="rn-menu-sep" />
              <button type="button" role="menuitem" onClick={() => { setSaveOpen(false); store.openModal('projects'); }}>Импорт из файла…</button>
            </div>
          )}
        </div>

        <button type="button" className="rn-btn" title={'Отменить (' + hkText('undo') + ')'} disabled={!store.canUndo()} onClick={() => store.undo()}>↺</button>
        <button type="button" className="rn-btn" title={'Повторить (' + hkText('redo') + ')'} disabled={!store.canRedo()} onClick={() => store.redo()}>↻</button>
        <span className="rn-sep" />
        <button type="button" className="rn-btn" title={'Менеджер проектов (' + hkText('projects') + ')'} onClick={() => store.openModal('projects')}>📁</button>
        <button type="button" className="rn-btn" title={'Поиск по проекту (' + hkText('search') + ')'} onClick={() => store.openModal('search')}>🔍</button>
        <button type="button" className="rn-btn" title="Журнал действий" onClick={() => { store.setLogFilters(null, null); store.openModal('log'); }}>🕘</button>
        <button type="button" className="rn-btn" title={'Что нового (' + hkText('patchnotes') + ')'} onClick={() => store.openModal('patch')}>v1.3.0</button>
        <button type="button" className="rn-btn" title="Настройки проекта" onClick={() => store.openModal('settings')}>⚙</button>
        <span className="rn-sep" />
        {statusChip}
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
