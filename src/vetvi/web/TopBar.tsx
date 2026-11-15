'use client';

/**
 * Ветви — тулбар: 1:1 порт шапки оригинала (header#topbar, index.html 1082–1125).
 * Оригинальные классы/ids/иконки (.brand, .vsep, .btn, .ibtn, .save-wrap,
 * .save-menu, .sm-i, .collab-chip, .cc-dot, .m-badge, .spacer) + логика React.
 * Пункты меню сохранения txjson/txsel/tximp — «Лёгкий JSON текстов»
 * (10328–10600): экспорт текстов, экспорт выделенных, модалка импорта
 * (openTextsImport/textsImpStep2 оригинала, 10473–10528).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { hkText } from '@/vetvi/core/hotkeys';
import { TYPES } from '@/vetvi/core/constants';
import { textsImpPreview, type TxImpData } from '@/vetvi/core/texts';
import type { VetviStore } from './store';
import { canvasApi } from './canvasApi';
import { ModalShell } from './Modals';
import { isTyping } from './CanvasBoard';

/* ═══ Импорт текстов из JSON (openTextsImport/textsImpStep2 оригинала) ═══ */

type TxImpState = { step: 1; keep: string } | { step: 2; d: TxImpData; fname?: string };

/** Шаг 1 — вставка JSON/выбор файла (openTextsImport, 10473–10487). */
function TxImpStep1(props: {
  store: VetviStore;
  keep: string;
  close: () => void;
  reopen: (keep: string) => void;
  toStep2: (d: TxImpData, fname?: string) => void;
}) {
  const { store, keep, close, reopen, toStep2 } = props;
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [val, setVal] = useState(keep);

  /* автофокус пустого поля через 60 мс (10486) */
  useEffect(() => {
    const t = setTimeout(() => {
      if (taRef.current && !taRef.current.value) taRef.current.focus();
    }, 60);
    return () => clearTimeout(t);
  }, []);

  const parse = (s: string): void => {
    const r = store.textsImpParse(s);
    if ('err' in r) {
      store.toast(r.err, 'err');
      reopen(s); /* openTextsImport(keep) — окно открывается с введённым текстом */
      return;
    }
    toStep2(r.data);
  };

  const onFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    const rd = new FileReader();
    rd.onload = () => parse(String(rd.result));
    rd.readAsText(f);
  };

  return (
    <ModalShell
      title="Импорт текстов из JSON"
      onClose={close}
      foot={
        <>
          <button type="button" className="btn primary" onClick={() => parse(taRef.current ? taRef.current.value : '')}>Проверить</button>
          <button type="button" className="btn" onClick={close}>Отмена</button>
        </>
      }
    >
      <p style={{ margin: '2px 0 9px', fontSize: 12.5, color: 'var(--tx2)' }}>
        Вставьте JSON с текстами нод: массив <b style={{ color: 'var(--acc2)' }}>texts</b> — пары{' '}
        <b style={{ color: 'var(--acc2)' }}>{'{id, text}'}</b> (каждая строка встаёт по своему id, порядок не важен) — и служебный блок{' '}
        <b style={{ color: 'var(--acc2)' }}>service</b>. Ноды сопоставляются по <b>id</b>: совпавшие — обновятся, отсутствующие — можно создать.
      </p>
      <textarea
        id="txImpTa"
        ref={taRef}
        className="tx-imp-ta"
        spellCheck={false}
        value={val}
        onChange={(e) => setVal(e.target.value)}
        placeholder={'{ "texts": [ { "id": "…", "text": "…" } ], "service": { "format": "vetvi-texts-v3", "nodes": [ … ], "links": [ … ] } }'}
      />
      <div style={{ display: 'flex', gap: 10, marginTop: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <button
          type="button"
          className="btn"
          id="txImpFile"
          onClick={() => {
            if (fileRef.current) { fileRef.current.value = ''; fileRef.current.click(); }
          }}
        >
          Выбрать файл…
        </button>
        <span style={{ fontSize: 11, color: 'var(--tx3)' }}>файл — из меню «Сохранить» → «Тексты (JSON)» или «Тексты выделенных нод (JSON)»: ноды из него вернутся в проект</span>
      </div>
      <input ref={fileRef} type="file" id="txtFileInput" accept=".json,.txt,application/json,text/plain" hidden onChange={onFile} />
    </ModalShell>
  );
}

/** Шаг 2 — проверка и опции (textsImpStep2, 10498–10528). */
function TxImpStep2(props: { store: VetviStore; d: TxImpData; fname?: string; close: () => void }) {
  const { store, d, fname, close } = props;
  const pv = useMemo(() => textsImpPreview(store.doc, d), [store, d]);
  const [upd, setUpd] = useState(pv.matched.length > 0);
  const [cre, setCre] = useState(pv.fresh.length > 0);
  const [med, setMed] = useState(true);
  const [lnk, setLnk] = useState(true);

  const rows: React.ReactNode[] = [];
  let shown = 0;
  pv.matched.slice(0, 24).forEach((en) => {
    shown++;
    rows.push(
      <div key={'u:' + en.id} className="tx-imp-row up">
        <span className="mk">✎</span>
        <span className="tt">{en.title || '(без названия)'}</span>
        <span className="sub">{en.id}</span>
      </div>,
    );
  });
  pv.fresh.slice(0, 24).forEach((en) => {
    shown++;
    rows.push(
      <div key={'n:' + en.id} className="tx-imp-row new">
        <span className="mk">＋</span>
        <span className="tt">{en.title || '(без названия)'}</span>
        <span className="sub">{en.id}</span>
      </div>,
    );
  });
  if (d.nodes.length - shown > 0) {
    rows.push(<div key="more" className="tx-imp-row"><span className="sub">и ещё {d.nodes.length - shown}…</span></div>);
  }

  return (
    <ModalShell
      title="Импорт текстов — проверка"
      onClose={close}
      foot={
        <>
          <button
            type="button"
            className="btn primary"
            onClick={() => {
              store.textsImpApply(d, { upd, cre, med, lnk });
              close();
            }}
          >
            Импортировать
          </button>
          <button type="button" className="btn" onClick={close}>Отмена</button>
        </>
      }
    >
      <div className="tx-imp-sum">
        {d.fmt ? <b>{d.fmt}</b> : null}{d.fmt ? ' · ' : ''}
        {d.srcName ? '«' + d.srcName + '» · ' : ''}
        {fname ? fname + ' · ' : ''}
        в файле: текстов — <b>{typeof d.tx === 'number' ? d.tx : '—'}</b>, нод — <b>{d.nodes.length}</b>, связей — <b>{d.links.length}</b>
        {d.skip ? ', без id пропущено — ' + d.skip : ''}
        <br />
        в проекте совпадают по id: <b>{pv.matched.length}</b>, новых: <b>{pv.fresh.length}</b>
      </div>
      <div className="tx-imp-list">{rows}</div>
      <div className="tx-imp-chk">
        <label>
          <input type="checkbox" checked={upd} disabled={!pv.matched.length} onChange={(e) => setUpd(e.target.checked)} />
          <span>Обновить тексты и заголовки совпавших нод<span className="hint">совпадений по id: {pv.matched.length}</span></span>
        </label>
        <label>
          <input type="checkbox" checked={cre} disabled={!pv.fresh.length} onChange={(e) => setCre(e.target.checked)} />
          <span>Создать ноды, которых нет в проекте<span className="hint">новых: {pv.fresh.length} — разместятся сеткой на свободном месте</span></span>
        </label>
        {(pv.hasRep || pv.hasOut) && (
          <label>
            <input type="checkbox" checked={med} onChange={(e) => setMed(e.target.checked)} />
            <span>Обновить реплики диалогов{pv.hasOut ? ' и подписи вариантов развилок' : ''}<span className="hint">реплики заменяются списком из файла целиком</span></span>
          </label>
        )}
        <label>
          <input type="checkbox" checked={lnk} onChange={(e) => setLnk(e.target.checked)} />
          <span>Синхронизировать связи<span className="hint">подписи существующих связей обновятся, недостающие — добавятся</span></span>
        </label>
      </div>
    </ModalShell>
  );
}

/** Оболочка модалки импорта: шаг 1/2 + Escape-каскад (closeModal оригинала, 10017). */
function TextsImportModal(props: {
  store: VetviStore;
  st: TxImpState;
  close: () => void;
  reopen: (keep: string) => void;
  toStep2: (d: TxImpData, fname?: string) => void;
}) {
  const { store, st, close, reopen, toStep2 } = props;
  useEffect(() => {
    const onEsc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (isTyping()) return; /* курсор в поле — Escape лишь снимает фокус (9974) */
      e.preventDefault();
      e.stopPropagation();
      close();
    };
    window.addEventListener('keydown', onEsc, true);
    return () => window.removeEventListener('keydown', onEsc, true);
  }, [close]);
  if (st.step === 2) return <TxImpStep2 store={store} d={st.d} fname={st.fname} close={close} />;
  return <TxImpStep1 store={store} keep={st.keep} close={close} reopen={reopen} toStep2={toStep2} />;
}

export function TopBar(props: { store: VetviStore }) {
  const { store } = props;
  const [menuOpen, setMenuOpen] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  /* модалка «Импорт текстов (JSON)…» — два шага (openTextsImport/textsImpStep2) */
  const [txImp, setTxImp] = useState<TxImpState | null>(null);
  const [txImpSeq, setTxImpSeq] = useState(0);
  const addRef = useRef<HTMLDivElement>(null);
  const saveRef = useRef<HTMLDivElement>(null);
  void store.revision;

  const openTxImp = useCallback((keep = '') => {
    setTxImp({ step: 1, keep });
    setTxImpSeq((s) => s + 1);
  }, []);
  const closeTxImp = useCallback(() => setTxImp(null), []);
  const txImpToStep2 = useCallback((d: TxImpData, fname?: string) => {
    setTxImp({ step: 2, d, fname });
    setTxImpSeq((s) => s + 1); /* перемонтировать — чекбоксы по свежему превью */
  }, []);

  useEffect(() => {
    if (!menuOpen && !saveOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (menuOpen && addRef.current && !addRef.current.contains(e.target as Node)) setMenuOpen(false);
      if (saveOpen && saveRef.current && !saveRef.current.contains(e.target as Node)) setSaveOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [menuOpen, saveOpen]);

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

      {/* React-экстры оригинала нет: меню добавления ноды — как .save-wrap/.save-menu */}
      <div className="save-wrap" style={{ position: 'relative' }} ref={addRef}>
        <button
          type="button"
          className="btn"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          title="Добавить ноду в центр холста"
          onClick={() => setMenuOpen((v) => !v)}
        >
          ＋ Элемент
        </button>
        <div className={'save-menu' + (menuOpen ? ' show' : '')} role="menu" aria-label="Тип новой ноды">
          {Object.entries(TYPES).map(([key, info]) => (
            <div
              key={key}
              role="menuitem"
              className="sm-i"
              onClick={() => {
                setMenuOpen(false);
                const el = document.querySelector('.rn-canvas');
                const r = el ? el.getBoundingClientRect() : { width: 800, height: 600, left: 0, top: 0 };
                const wx = (r.width / 2 - store.vp.x) / store.vp.z - 108;
                const wy = (r.height / 2 - store.vp.y) / store.vp.z - 40;
                store.addNodeAt(key, wx, wy);
              }}
            >
              <span className="dot" style={{ background: info.color, width: 8, height: 8, borderRadius: '50%' }} />
              {info.name}
            </div>
          ))}
        </div>
      </div>

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
          onClick={() => setSaveOpen((v) => !v)}
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6" /></svg>
        </button>
        <div className={'save-menu' + (saveOpen ? ' show' : '')} role="menu" aria-label="Сохранение и экспорт">
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
          <div className="sm-i" role="menuitem" onClick={() => { setSaveOpen(false); if (store.sel.size) store.exportSelection(); else store.toast('Выделите ноды для экспорта', 'warn'); }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M5 3h11l4 4v14H5z" /><path d="M9 12.5h4M11 10.5v4" /><rect x="3" y="3" width="5" height="5" rx="1" strokeDasharray="1.6 1.4" /><rect x="16" y="16" width="5" height="5" rx="1" strokeDasharray="1.6 1.4" /></svg>
            Экспорт выделенных нод
            <kbd>{hkText('exportSel')}</kbd>
          </div>
          {/* ═══ Лёгкий JSON текстов: txjson/txsel/tximp (1098–1100 оригинала) ═══ */}
          <div className="sm-i" role="menuitem" onClick={() => { setSaveOpen(false); store.textsExport(false); }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M5 3h11l4 4v14H5z" /><path d="M9 12.5h6M9 16h6M9 9h2" /></svg>
            Тексты (JSON)
          </div>
          <div
            className="sm-i"
            role="menuitem"
            title={'Экспортировать только выделенные ноды: клик по карточке, Shift+клик — добавить, рамкой или группой. Файл того же формата «Текстов (JSON)» — подходит для «Импорт текстов (JSON)»: совпавшие ноды обновятся, отсутствующие создадутся. Также доступно по ' + hkText('exportSel') + ' и из контекстного меню ноды, группы или цепочки (правый клик)'}
            onClick={() => { setSaveOpen(false); store.textsExport(true); }}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M5 3h11l4 4v14H5z" /><path d="M9 12.5h4M11 10.5v4" /><rect x="3" y="3" width="5" height="5" rx="1" strokeDasharray="1.6 1.4" /><rect x="16" y="16" width="5" height="5" rx="1" strokeDasharray="1.6 1.4" /></svg>
            Тексты выделенных нод (JSON)
          </div>
          <div className="sm-i" role="menuitem" onClick={() => { setSaveOpen(false); openTxImp(); }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3v10.5" /><path d="m7.5 9.5 4.5 4.5 4.5-4.5" /><path d="M4.5 20.5h15" /></svg>
            Импорт текстов (JSON)…
          </div>
          <div className="ctx-sep" />
          <div className="sm-i" role="menuitem" onClick={() => { setSaveOpen(false); store.openModal('projects'); }}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M12 3v10.5" /><path d="m7.5 9.5 4.5 4.5 4.5-4.5" /><path d="M4.5 20.5h15" /></svg>
            Импорт из файла…
          </div>
        </div>
      </div>

      <div className="vsep" />

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
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M4 18h6l8-8h2" /></svg>
      </button>
      <div className="vsep" style={{ margin: '0 8px' }} />

      <button
        type="button"
        className="btn"
        id="bPlay"
        title={'Режим новеллы (' + hkText('play') + ') — выделенные блоки по порядку или весь сюжет'}
        onClick={() => {
          store.setPlayerStart(null, false);
          store.openModal('player');
        }}
      >
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

      <button type="button" className="btn ibtn" id="bSettings" title="Настройки проекта" onClick={() => store.openModal('settings')}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>
      </button>
      <button type="button" className="btn ibtn" id="bHelp" title="Горячие клавиши" onClick={() => store.openModal('settingsHk')}>
        ?
      </button>
    </header>
    {/* модалка «Импорт текстов (JSON)…»: шаг 1 (ввод) / шаг 2 (проверка) */}
    {txImp && (
      <TextsImportModal
        key={txImpSeq}
        store={store}
        st={txImp}
        close={closeTxImp}
        reopen={openTxImp}
        toStep2={txImpToStep2}
      />
    )}
    </>
  );
}
