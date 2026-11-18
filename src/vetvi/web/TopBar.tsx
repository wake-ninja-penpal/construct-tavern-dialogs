'use client';

/**
 * Ветви — тулбар: 1:1 порт шапки оригинала (header#topbar, index.html 1082–1125).
 * Оригинальные классы/ids/иконки (.brand, .vsep, .btn, .ibtn, .save-wrap,
 * .save-menu, .sm-i, .collab-chip, .cc-dot, .m-badge, .spacer) + логика React.
 *
 * Шапка теперь горизонтально скроллится, когда кнопки не вмещаются в экран.
 * Блок кнопок холста (undo/redo/zoom/сетка/привязка/изгибы/мини-карта) —
 * отсоединяемый: тянем за «грип» — блок отстёгивается от шапки и превращается
 * в плавающую панель, которая прилипает к краям холста; перетаскивание обратно
 * на шапку возвращает его на место. Положение хранится в localStorage.
 */

import { useEffect, useRef, useState } from 'react';

import { hkText } from '@/vetvi/core/hotkeys';
import { getMe } from '@/vetvi/core/identity';
import type { VetviStore } from './store';
import { canvasApi } from './canvasApi';
import { avatarInitial } from './auth';
import { AccountPopover, NotificationsPopover, useNotifications } from './AccountMenu';

/* ── отсоединяемый блок кнопок холста ── */

const TOOLBLOCK_LS = 'vetvi-toolblock-v1';
const TOOL_EDGE = 12; // отступ плавающей панели от краёв экрана/шапки
const TOPBAR_H_FALLBACK = 56;

interface ToolDock { float: boolean; x: number; y: number }

function loadToolDock(): ToolDock {
  const def: ToolDock = { float: false, x: TOOL_EDGE, y: TOPBAR_H_FALLBACK + TOOL_EDGE };
  try {
    const raw = localStorage.getItem(TOOLBLOCK_LS);
    if (!raw) return def;
    const d = JSON.parse(raw) as ToolDock;
    if (!d || typeof d !== 'object') return def;
    return { float: !!d.float, x: Number(d.x) || def.x, y: Number(d.y) || def.y };
  } catch { return def; }
}

function saveToolDock(d: ToolDock): void {
  try { localStorage.setItem(TOOLBLOCK_LS, JSON.stringify(d)); } catch { /* нет доступа */ }
}

function GripIcon() {
  return (
    <svg viewBox="0 0 8 16" width="8" height="16" aria-hidden="true" fill="currentColor">
      <circle cx="2.2" cy="3" r="1.3" /><circle cx="5.8" cy="3" r="1.3" />
      <circle cx="2.2" cy="8" r="1.3" /><circle cx="5.8" cy="8" r="1.3" />
      <circle cx="2.2" cy="13" r="1.3" /><circle cx="5.8" cy="13" r="1.3" />
    </svg>
  );
}

export function TopBar(props: { store: VetviStore }) {
  const { store } = props;
  const [saveOpen, setSaveOpen] = useState(false);
  const [savePos, setSavePos] = useState<{ left: number; top: number } | null>(null);
  const saveRef = useRef<HTMLDivElement>(null);
  const me = getMe();
  const ntf = useNotifications(store);
  void store.revision;

  /* ── отсоединяемый блок инструментов ── */
  const [toolDock, setToolDock] = useState<ToolDock>(loadToolDock);
  const [toolDragging, setToolDragging] = useState(false);
  const dragRef = useRef<{
    moved: boolean; grabX: number; grabY: number; w: number; h: number;
    lastClientY: number; pos: { x: number; y: number };
  } | null>(null);
  const floatRef = useRef<HTMLDivElement>(null);

  const topbarHeight = () => document.getElementById('topbar')?.offsetHeight || TOPBAR_H_FALLBACK;

  const clampToolPos = (x: number, y: number, w: number, h: number): { x: number; y: number } => {
    const minX = TOOL_EDGE;
    const maxX = Math.max(minX, window.innerWidth - w - TOOL_EDGE);
    const minY = topbarHeight() + TOOL_EDGE;
    const maxY = Math.max(minY, window.innerHeight - h - TOOL_EDGE);
    return { x: Math.max(minX, Math.min(maxX, x)), y: Math.max(minY, Math.min(maxY, y)) };
  };

  const onGripMove = (e: PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    d.lastClientY = e.clientY;
    if (!d.moved) {
      d.moved = true;
      setToolDragging(true);
      setToolDock((v) => (v.float ? v : { ...v, float: true }));
    }
    d.pos = clampToolPos(e.clientX - d.grabX, e.clientY - d.grabY, d.w, d.h);
    setToolDock((v) => ({ ...v, x: d.pos.x, y: d.pos.y }));
  };

  const onGripUp = () => {
    window.removeEventListener('pointermove', onGripMove);
    window.removeEventListener('pointerup', onGripUp);
    const d = dragRef.current;
    dragRef.current = null;
    setToolDragging(false);
    if (!d || !d.moved) return;
    /* тянем обратно на шапку — блок встаёт на своё место */
    if (d.lastClientY <= topbarHeight()) {
      const next: ToolDock = { float: false, x: 0, y: 0 };
      setToolDock(next);
      saveToolDock(next);
      return;
    }
    /* на холсте панель прилипает к ближайшим краям (не висит над рабочей областью) */
    const cx = d.pos.x + d.w / 2;
    const cy = d.pos.y + d.h / 2;
    const snapped: ToolDock = {
      float: true,
      x: cx < window.innerWidth / 2 ? TOOL_EDGE : window.innerWidth - d.w - TOOL_EDGE,
      y: cy < (topbarHeight() + window.innerHeight) / 2 ? topbarHeight() + TOOL_EDGE : window.innerHeight - d.h - TOOL_EDGE,
    };
    setToolDock(snapped);
    saveToolDock(snapped);
  };

  const onGripDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const el = (e.currentTarget as HTMLElement).closest('.tool-block, .tool-float') as HTMLElement | null;
    if (!el) return;
    const r = el.getBoundingClientRect();
    dragRef.current = { moved: false, grabX: e.clientX - r.left, grabY: e.clientY - r.top, w: r.width, h: r.height, lastClientY: e.clientY, pos: { x: r.left, y: r.top } };
    e.preventDefault();
    window.addEventListener('pointermove', onGripMove);
    window.addEventListener('pointerup', onGripUp);
  };

  /* плавающая панель не должна уехать за экран при ресайзе окна */
  useEffect(() => {
    if (!toolDock.float) return;
    const onResize = () => {
      const el = floatRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const c = clampToolPos(r.left, r.top, r.width, r.height);
      setToolDock((v) => ({ ...v, x: c.x, y: c.y }));
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [toolDock.float]);

  /* закрытие попапов аккаунта/уведомлений кликом мимо (capture, как bindSyncUI) */
  useEffect(() => {
    const onDoc = (e: Event) => {
      const t = e.target as Element | null;
      if (!t) return;
      if (store.accPop && !t.closest('.acc-pop') && !t.closest('#accBtn')) store.setAccPop(false);
      if (ntf.open && !t.closest('.ntf-pop') && !t.closest('#bellBtn')) ntf.setOpen(false);
    };
    document.addEventListener('pointerdown', onDoc, true);
    return () => document.removeEventListener('pointerdown', onDoc, true);
  }, [store, store.accPop, ntf.open, ntf.setOpen]);

  const zoomStep = (factor: number) => {
    const r = canvasApi.current?.getRect();
    if (r) store.zoomAt(r.width / 2, r.height / 2, factor);
  };

  const fitAll = () => {
    const api = canvasApi.current;
    const r = api ? api.getRect() : null;
    if (r && api) store.fitView(r.width, r.height, api.sizes);
  };

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
    const isCopy = store.syncMode === 'copy';
    const [baseColor, baseText] = map[store.syncStatus] || map.off;
    const color = isCopy ? '#e2a54e' : baseColor;
    const label = isCopy
      ? 'копия'
      : store.syncStatus === 'on'
        ? (store.syncUsers.length || 1) + ' онлайн'
        : baseText;
    const title = isCopy
      ? 'Режим копии: ' + ((sc && sc.activeCopyObj()?.name) || '')
      : 'Совместный доступ: статус и участники';
    return (
      <button
        type="button"
        id="bCollab"
        className={'btn collab-chip' + (isCopy ? ' copy-mode' : '')}
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
        <span className={'cc-dot' + (store.syncStatus === 'conn' ? ' pulse' : '')} style={{ background: color }} />
        <span>{label}</span>
      </button>
    );
  })();

  /* содержимое отсоединяемого блока (одинаково в шапке и в плавающей панели) */
  const toolContent = (
    <>
      <button type="button" className="btn ibtn" id="bUndo" title={'Отменить (' + hkText('undo') + ')'} disabled={!store.canUndo()} onClick={() => store.undo()}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M8 5 3.5 9.5 8 14" /><path d="M4 9.5h10a6 6 0 1 1 0 12h-3" /></svg>
      </button>
      <button type="button" className="btn ibtn" id="bRedo" title={'Повторить (' + hkText('redo') + ')'} disabled={!store.canRedo()} onClick={() => store.redo()}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M16 5l4.5 4.5L16 14" /><path d="M20 9.5H10a6 6 0 1 0 0 12h3" /></svg>
      </button>

      <div className="vsep" />

      <button type="button" className="btn ibtn" id="bZOut" title={'Отдалить (' + hkText('zoomOut') + ')'} onClick={() => zoomStep(1 / 1.15)}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"><path d="M5 12h14" /></svg>
      </button>
      <span id="zPct">{Math.round(store.vp.z * 100)}%</span>
      <button type="button" className="btn ibtn" id="bZIn" title={'Приблизить (' + hkText('zoomIn') + ')'} onClick={() => zoomStep(1.15)}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
      </button>
      <button type="button" className="btn ibtn" id="bFit" title={'Вписать всё (' + hkText('fitView') + ')'} onClick={fitAll}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" /></svg>
      </button>

      <div className="vsep" />

      <button type="button" className={'btn ibtn' + (store.gridOn ? ' on' : '')} id="bGrid" title="Сетка" onClick={() => store.toggleGrid()}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round"><path d="M4 4h.01M12 4h.01M20 4h.01M4 12h.01M12 12h.01M20 12h.01M4 20h.01M12 20h.01M20 20h.01" /></svg>
      </button>
      <button type="button" className={'btn ibtn' + (store.snapOn ? ' on' : '')} id="bSnap" title="Привязка к сетке" onClick={() => store.toggleSnap()}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M5 3v5a7 7 0 0 0 14 0V3" /><path d="M5 3h3v5H5zM16 3h3v5h-3z" /></svg>
      </button>
      <div className="vsep" style={{ margin: '0 8px' }} />
      <button type="button" className={'btn ibtn' + (store.bend === 'smooth' ? ' on' : '')} id="bBendS" title="Изгиб всех стрелок: плавный" onClick={() => store.setBend('smooth')}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"><path d="M4 18c7 0 3-12 10-12h6" /></svg>
      </button>
      <button type="button" className={'btn ibtn' + (store.bend === 'ortho90' ? ' on' : '')} id="bBend90" title="Изгиб всех стрелок: прямые углы (90°)" onClick={() => store.setBend('ortho90')}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M4 18h9a3 3 0 0 0 3-3V6h4" /></svg>
      </button>
      <button type="button" className={'btn ibtn' + (store.bend === 'ortho45' ? ' on' : '')} id="bBend45" title="Изгиб всех стрелок: углы 45°" onClick={() => store.setBend('ortho45')}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"><path d="M4 18h6l8-8h2" /></svg>
      </button>
      <div className="vsep" style={{ margin: '0 8px' }} />
      {/* Мини-карта (#bMap оригинала, 1115/9371): показывает/скрывает #miniMap */}
      <button type="button" className={'btn ibtn' + (store.mmOn ? ' on' : '')} id="bMap" title="Мини-карта" onClick={() => store.toggleMm()}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="16" rx="2" /><rect x="7" y="8" width="7" height="6" rx="1" fill="currentColor" fillOpacity=".3" /></svg>
      </button>
    </>
  );

  return (
    <>
    <header id="topbar" role="banner">
      <div className="brand">
        <svg viewBox="0 0 24 24" fill="none">
          <path d="M7.5 12h3c3.2 0 2.4-6.5 6-6.5M10.5 12c3.2 0 2.4 6.5 6 6.5" stroke="#4d535e" strokeWidth="1.6" strokeLinecap="round" />
          <circle cx="5.5" cy="12" r="2.6" fill="#e2a54e" />
          <circle cx="18.5" cy="5.5" r="2.1" fill="#9cb878" />
          <circle cx="18.5" cy="18.5" r="2.1" fill="#cf6d4f" />
        </svg>
        <div>
          <div className="lg">ВЕТВИ</div>
          <div className="sub">конструктор нарратива · react</div>
        </div>
      </div>

      <input
        id="projName"
        spellCheck={false}
        title="Название проекта"
        value={store.doc.meta.name || ''}
        aria-label="Название проекта"
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => store.setProjectName(e.target.value)}
      />

      <div className="vsep" />

      <button type="button" className="btn" id="bNew" title={'Новый проект (' + hkText('newProject') + ')'} onClick={() => store.createProject()}>
        + Новый
      </button>
      <button type="button" className="btn" id="bOpen" title={'Открыть (' + hkText('projects') + ')'} onClick={() => store.openModal('projects')}>
        Открыть
      </button>

      <div className={'save-wrap' + (saveOpen ? ' open' : '')} ref={saveRef}>
        <button type="button" className="btn primary" id="bSave" title={'Сохранить (' + hkText('save') + ')'} onClick={() => store.saveAs()}>
          Сохранить
        </button>
        <button
          type="button"
          className="btn primary caret"
          id="bSaveMenu"
          title="Варианты сохранения"
          aria-haspopup="menu"
          aria-expanded={saveOpen}
          onClick={() => {
            /* меню позиционируется fixed: шапка теперь scroll-контейнер
               и обрезала бы absolute-выпадашку */
            const el = saveRef.current;
            if (el) {
              const r = el.getBoundingClientRect();
              setSavePos({ left: Math.max(8, Math.min(r.left, window.innerWidth - 266)), top: r.bottom + 7 });
            }
            setSaveOpen((v) => !v);
          }}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6" /></svg>
        </button>
        <div
          className={'save-menu' + (saveOpen ? ' show' : '')}
          role="menu"
          aria-label="Сохранение и экспорт"
          style={savePos ? { position: 'fixed', left: savePos.left, top: savePos.top } : undefined}
        >
          <div className="sm-i" role="menuitem" onClick={() => { setSaveOpen(false); store.saveAs(); }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M5 3h11l4 4v14H5z" /><path d="M8 3v5h7V3M8 21v-7h8v7" /></svg>
            Сохранить (JSON)
            <kbd>{hkText('save')}</kbd>
          </div>
          <div className="sm-i" role="menuitem" onClick={() => { setSaveOpen(false); store.saveAs(); }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M5 3h11l4 4v14H5z" /><path d="M8 3v5h7V3" /></svg>
            Сохранить как… (JSON)
            <kbd>{hkText('saveAs')}</kbd>
          </div>
          <div className="sm-i" role="menuitem" onClick={() => { setSaveOpen(false); store.exportTxtFile(); }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M6.5 3h11v18l-2.8-2-2.7 2-2.7-2L6.5 21z" /><path d="M9.5 8.5h5M9.5 12h5" /></svg>
            Текстовый файл (.txt)
          </div>
          <div className="sm-i" role="menuitem" onClick={() => { setSaveOpen(false); store.exportTextsJson(false); }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M5 3h11l4 4v14H5z" /><path d="M9 12.5h6M9 16h6M9 9h2" /></svg>
            Тексты (JSON)
          </div>
          <div className="sm-i" role="menuitem" onClick={() => { setSaveOpen(false); store.exportTextsJson(true); }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M5 3h11l4 4v14H5z" /><path d="M9 12.5h4M11 10.5v4" /><rect x="3" y="3" width="5" height="5" rx="1" strokeDasharray="1.6 1.4" /><rect x="16" y="16" width="5" height="5" rx="1" strokeDasharray="1.6 1.4" /></svg>
            Тексты выделенных нод (JSON)
            <kbd>{hkText('exportSel')}</kbd>
          </div>
          <div className="sm-i" role="menuitem" onClick={() => { setSaveOpen(false); store.openTextsImport(); }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3v10.5" /><path d="m7.5 9.5 4.5 4.5 4.5-4.5" /><path d="M4.5 20.5h15" /></svg>
            Импорт текстов (JSON)…
          </div>
        </div>
      </div>

      <div className="vsep" />

      {/* отсоединяемый блок кнопок холста (в шапке — до «Играть») */}
      {!toolDock.float && (
        <div className="tool-block">
          <button
            type="button"
            className="tool-grip"
            title="Отсоединить: перетащите блок на холст"
            aria-label="Отсоединить панель инструментов"
            onPointerDown={onGripDown}
          >
            <GripIcon />
          </button>
          {toolContent}
        </div>
      )}

      <button type="button" className="btn" id="bPlay" title={'Режим новеллы (' + hkText('play') + ') — выделенные блоки по порядку или весь сюжет'} onClick={() => {
        store.setPlayerStart(null, false);
        store.openModal('player');
      }}>
        <svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M8 5.5v13l10.5-6.5z" /></svg>
        <span className="t">Играть</span>
      </button>

      {statusChip}

      {(sc && sc.enabled && store.syncMode !== 'copy') && (
        <button type="button" className="btn" id="bMerge" title="Merge-запросы копий" onClick={() => store.openModal('merge')}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><circle cx="18" cy="18" r="2.6" /><circle cx="6" cy="6" r="2.6" /><path d="M6 21V9a9 9 0 0 0 9 9" /></svg>
          <span className="t">Merge</span>
          {store.syncMergeCount > 0 && <span className="m-badge">{store.syncMergeCount}</span>}
        </button>
      )}

      <button type="button" className="btn" id="bCopies" title="Локальные копии проекта" onClick={() => store.openModal('copies')}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
        <span className="t">Копии</span>
      </button>

      <button type="button" className="btn" id="bLog" title="Журнал действий: кто и что менял в проекте" onClick={() => { store.setLogFilters(null, null); store.openModal('log'); }}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="8.6" /><path d="M12 7.4V12l3.2 2" /></svg>
        <span className="t">Журнал</span>
      </button>

      <button type="button" className="btn primary" id="bShare" title="Поделиться ссылкой на проект" onClick={() => {
        if (!sc) return;
        if (store.syncMode === 'copy') store.openModal('copyBar');
        else sc.shareProject();
      }}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><circle cx="18" cy="5" r="2.6" /><circle cx="6" cy="12" r="2.6" /><circle cx="18" cy="19" r="2.6" /><path d="m8.4 13.4 7.2 4.2M15.6 6.4 8.4 10.6" /></svg>
        <span className="t">Поделиться</span>
      </button>

      {/* React-экстры (в оригинале нет) */}
      <button type="button" className="btn" id="bSearch" title={'Поиск по проекту (' + hkText('search') + ')'} onClick={() => store.openModal('search')}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
      </button>
      <button type="button" className="btn" id="bPatch" title={'Что нового (' + hkText('patchnotes') + ')'} onClick={() => store.openModal('patch')}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3c.7 4.9 3.4 7.6 8.3 8.3-4.9.7-7.6 3.4-8.3 8.3-.7-4.9-3.4-7.6-8.3-8.3C8.6 10.6 11.3 7.9 12 3z" /></svg>
      </button>

      <div className="spacer" />

      <button
        type="button"
        className="btn ibtn"
        id="bellBtn"
        title="Уведомления"
        aria-label="Уведомления"
        onClick={() => { ntf.toggle(); store.setAccPop(false); }}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9.5a6 6 0 0 1 12 0c0 5 2 6.5 2 6.5H4s2-1.5 2-6.5" /><path d="M10.3 20a2 2 0 0 0 3.4 0" /></svg>
        {ntf.state.unread > 0 && (
          <span className="m-badge bell-badge" aria-label={ntf.state.unread + ' непрочитанных уведомлений'}>
            {ntf.state.unread > 9 ? '9+' : ntf.state.unread}
          </span>
        )}
      </button>

      {/* аватар аккаунта вместо старой кнопки настроек: инфо о аккаунте, настройки, выход */}
      <button
        type="button"
        className="btn ibtn avatar-btn"
        id="accBtn"
        title={me.name + ' — аккаунт'}
        aria-label="Аккаунт"
        onClick={() => { store.setAccPop(!store.accPop); ntf.setOpen(false); }}
      >
        <span className="avatar-circle" style={{ background: me.color }}>{avatarInitial(me.name)}</span>
      </button>

      <button type="button" className="btn ibtn" id="bHelp" title="Горячие клавиши" onClick={() => store.openModal('settingsHk')}>
        ?
      </button>
    </header>

    {/* плавающая панель инструментов: отсоединена от шапки, прилипает к краям холста */}
    {toolDock.float && (
      <div
        className={'tool-float' + (toolDragging ? ' dragging' : '')}
        ref={floatRef}
        style={{ left: toolDock.x, top: toolDock.y }}
        role="toolbar"
        aria-label="Панель инструментов холста"
      >
        <button
          type="button"
          className="tool-grip"
          title="Перетащите — вернёте на шапку или переставите"
          aria-label="Переместить панель инструментов"
          onPointerDown={onGripDown}
        >
          <GripIcon />
        </button>
        {toolContent}
      </div>
    )}

    <AccountPopover store={store} onClose={() => store.setAccPop(false)} />
    {ntf.open && (
      <NotificationsPopover
        items={ntf.state.items}
        onOpenItem={(n) => void ntf.openItem(n)}
        onClose={() => ntf.setOpen(false)}
      />
    )}
    </>
  );
}
