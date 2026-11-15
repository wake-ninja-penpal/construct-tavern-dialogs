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

  const sc = store.sync;
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
    const title = store.syncMode === 'copy'
      ? 'Режим копии: ' + ((sc && sc.activeCopyObj()?.name) || '')
      : 'Совместный доступ: статус и участники';
    return (
      <button
        type="button"
        className={'rn-sync-chip' + (store.syncMode === 'copy' ? ' copy-mode' : '')}
        style={{ ['--sc' as string]: c }}
        title={title}
        onClick={() => {
          if (!sc) return;
          if (!sc.enabled) {
            if (store.syncMode === 'copy') store.openModal('copyBar');
            else sc.shareProject();
            return;
          }
          /* разрыв связи: клик по чипу — немедленное переподключение */
          if (sc.status !== 'on') { sc.reconnect(); return; }
          store.setCollabPop(!store.collabPop);
        }}
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
        <button type="button" className="rn-btn" title={'Что нового (' + hkText('patchnotes') + ')'} onClick={() => store.openModal('patch')}>v1.4.0</button>
        <button type="button" className="rn-btn" title="Настройки проекта" onClick={() => store.openModal('settings')}>⚙</button>
        <span className="rn-sep" />
        <button type="button" className="rn-btn" title={store.syncMode === 'copy' ? 'Режим копии — отправить merge' : 'Совместный доступ по ссылке'} onClick={() => {
          if (!sc) return;
          if (store.syncMode === 'copy') store.openModal('copyBar');
          else sc.shareProject();
        }}>
          <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'inline', verticalAlign: '-2px' }}><circle cx="6" cy="12" r="2.6" /><circle cx="17" cy="6" r="2.6" /><circle cx="17" cy="18" r="2.6" /><path d="M8.4 11l6.2-4M8.4 13l6.2 4" /></svg>
        </button>
        <button type="button" className="rn-btn" title="Локальные копии" onClick={() => store.openModal('copies')}>🗂</button>
        {(sc && sc.enabled && store.syncMode !== 'copy') && (
          <button type="button" className="rn-btn merge-btn" title="Merge-запросы копий" onClick={() => store.openModal('merge')}>
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" style={{ display: 'inline', verticalAlign: '-2px' }}><circle cx="18" cy="18" r="2.6" /><circle cx="6" cy="6" r="2.6" /><path d="M6 21V9a9 9 0 0 0 9 9" /></svg>
            {store.syncMergeCount > 0 && <span className="m-badge">{store.syncMergeCount}</span>}
          </button>
        )}
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
