'use client';

/**
 * Ветви — левая панель (порт вкладок оригинала): Элементы (палитра с drag),
 * Обзор (список нод), Переменные (полный редактор), Персонажи (аватары/цвета).
 */

import { useRef, useState } from 'react';

import { NODE_W, STATUS_RU, TYPES } from '@/vetvi/core/constants';
import { nodeColor, typeInfo } from '@/vetvi/core/geometry';
import { opsForType, VAR_TYPES, varCastVal, varType } from '@/vetvi/core/vars';
import type { VetviChar, VetviNode, VetviVar } from '@/vetvi/core/types';
import { condOpsFor, varById } from '@/vetvi/core/vars';
import type { VetviStore } from './store';
import { TypeIcon } from './NodeCard';

export function LeftPane(props: { store: VetviStore }) {
  const { store } = props;
  const tab = store.leftTab;
  void store.revision;

  return (
    <aside className="rn-left" style={{ width: store.leftWidth }} aria-label="Панель проекта">
      <div className="rn-ltabs" role="tablist">
        {([['pal', 'Элементы'], ['list', 'Обзор'], ['vars', 'Переменные'], ['chars', 'Персонажи']] as const).map(([t, title]) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            title={title}
            className={tab === t ? 'on' : ''}
            onClick={() => store.setLeftTab(t)}
          >
            {t === 'pal' && <FolderIcon />}
            {t === 'list' && <ListIcon />}
            {t === 'vars' && <VarIcon />}
            {t === 'chars' && <CharIcon />}
          </button>
        ))}
      </div>
      <div className="rn-lbody">
        {tab === 'pal' && <PalettePane store={store} />}
        {tab === 'list' && <ListPane store={store} />}
        {tab === 'vars' && <VarsPane store={store} />}
        {tab === 'chars' && <CharsPane store={store} />}
      </div>
    </aside>
  );
}

/* ── Элементы (палитра с перетаскиванием) ── */
function PalettePane({ store }: { store: VetviStore }) {
  const drop = (e: React.DragEvent, target: 'canvas') => {
    void target;
    e.preventDefault();
    const type = e.dataTransfer.getData('text/vetvi-type');
    if (!type) return;
    const el = document.querySelector('.rn-canvas');
    const r = el ? el.getBoundingClientRect() : { left: 0, top: 0, width: 800, height: 600 };
    const w = {
      x: (e.clientX - r.left - store.vp.x) / store.vp.z - NODE_W / 2,
      y: (e.clientY - r.top - store.vp.y) / store.vp.z - 20,
    };
    store.addNodeAt(type, w.x, w.y);
  };
  return (
    <div className="rn-pane" onDragOver={(e) => e.preventDefault()} onDrop={(e) => drop(e, 'canvas')}>
      <div className="rn-pane-head">Элементы сюжета</div>
      <div className="rn-pane-hint">Перетащите на холст или кликните, чтобы добавить в центр вида.</div>
      <div className="rn-pal-list">
        {Object.entries(TYPES).map(([key, info]) => (
          <div
            key={key}
            className="rn-pal-item"
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData('text/vetvi-type', key);
              e.dataTransfer.effectAllowed = 'copy';
            }}
            onClick={() => {
              const el = document.querySelector('.rn-canvas');
              const r = el ? el.getBoundingClientRect() : { width: 800, height: 600 };
              const wx = (r.width / 2 - store.vp.x) / store.vp.z - NODE_W / 2;
              const wy = (r.height / 2 - store.vp.y) / store.vp.z - 40;
              store.addNodeAt(key, wx, wy);
            }}
          >
            <span className="rn-pal-ico" style={{ color: info.color }}><TypeIcon type={key} /></span>
            <span className="rn-pal-name">{info.name}</span>
            <span className="rn-pal-dot" style={{ background: info.color }} />
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── Обзор (список нод) ── */
function ListPane({ store }: { store: VetviStore }) {
  const [q, setQ] = useState('');
  const nodes = store.doc.nodes.filter((n) => {
    if (!q.trim()) return true;
    const s = q.toLowerCase();
    return (n.title || '').toLowerCase().includes(s) || (n.text || '').toLowerCase().includes(s);
  });
  return (
    <div className="rn-pane">
      <div className="rn-pane-head">Обзор проекта</div>
      <input className="rn-lsearch" placeholder="Фильтр по названию или тексту…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Фильтр нод" />
      <div className="rn-list-list">
        {nodes.map((n: VetviNode) => (
          <button
            key={n.id}
            type="button"
            className={'rn-list-item' + (store.sel.has(n.id) ? ' on' : '')}
            onClick={() => { store.selectOnly(n.id); store.requestCenter(n.id); }}
          >
            <span className="rn-list-dot" style={{ background: nodeColor(n) }} />
            <span className="rn-list-title">{n.title || typeInfo(n.type).name}</span>
            <span className="rn-list-type">{typeInfo(n.type).name}</span>
            <span className={'rn-st st-' + (STATUS_RU[n.status] ? n.status : 'idea')} />
          </button>
        ))}
        {!nodes.length && <div className="rn-pane-hint">Ничего не найдено.</div>}
      </div>
    </div>
  );
}

/* ── Переменные ── */
function VarsPane({ store }: { store: VetviStore }) {
  const vars = store.doc.vars || [];
  const [open, setOpen] = useState<Set<string>>(new Set());
  const dragVid = useRef<string | null>(null);
  const editPreRef = useRef<string | null>(null);

  const toggleOpen = (id: string) => {
    const s = new Set(open);
    if (s.has(id)) s.delete(id);
    else s.add(id);
    setOpen(s);
  };

  const dropToCanvas = (e: React.DragEvent) => {
    e.preventDefault();
    const vid = e.dataTransfer.getData('text/vetvi-var') || dragVid.current;
    if (!vid) return;
    const el = document.querySelector('.rn-canvas');
    const r = el ? el.getBoundingClientRect() : { left: 0, top: 0, width: 800, height: 600 };
    const wx = (e.clientX - r.left - store.vp.x) / store.vp.z - NODE_W / 2;
    const wy = (e.clientY - r.top - store.vp.y) / store.vp.z - 20;
    const v = varById(store.doc, vid);
    const pre = store.beginEdit();
    const n = store.addNodeAtRaw('varnode', wx, wy);
    if (n) {
      n.varMode = 'set';
      n.varOp = '=';
      n.varVal = v ? (typeof v.val === 'number' ? v.val : 0) : 0;
      n.vid = vid;
    }
    store.commitEdit(pre, 'Нода переменной');
    store.toast('Нода переменной создана', 'ok');
  };

  return (
    <div className="rn-pane" onDragOver={(e) => e.preventDefault()} onDrop={dropToCanvas}>
      <div className="rn-pane-head rn-between">
        <span>Переменные сюжета</span>
        <button type="button" className="rn-mini" onClick={() => { const v = store.addVar(); setOpen(new Set([...open, v.id])); }}>+ Переменная</button>
      </div>
      {!vars.length && (
        <div className="rn-pane-hint">
          Переменная — это число (number), текст (string) или флаг true/false. Перетащите её на холст, чтобы создать ноду переменной; условия исходов развилки читают значения при проигрывании.
        </div>
      )}
      <div className="rn-vars-list">
        {vars.map((v: VetviVar) => {
          const isOpen = open.has(v.id);
          const t = varType(v);
          return (
            <div className="rn-var-row" key={v.id}>
              <div className="rn-var-line">
                <span
                  className="rn-var-grip"
                  draggable
                  title="Перетащите на холст — создастся нода переменной"
                  onDragStart={(e) => {
                    e.dataTransfer.setData('text/vetvi-var', v.id);
                    e.dataTransfer.effectAllowed = 'copy';
                    dragVid.current = v.id;
                  }}
                >⠿</span>
                <input
                  className="rn-var-name"
                  maxLength={40}
                  value={String(v.name || '')}
                  aria-label="Имя переменной"
                  onFocus={() => { editPreRef.current = store.beginEdit(); }}
                  onChange={(e) => store.updateVar(v.id, { name: e.target.value }, { history: false })}
                  onBlur={() => { store.commitEdit(editPreRef.current, 'Правка переменной'); editPreRef.current = null; }}
                />
                <select
                  className="rn-var-type"
                  value={t}
                  aria-label="Тип переменной"
                  onChange={(e) => store.updateVar(v.id, { type: e.target.value, val: varCastVal(e.target.value, v.val) }, { label: 'Тип переменной' })}
                >
                  {Object.entries(VAR_TYPES).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
                </select>
                {t === 'bool' ? (
                  <select
                    className="rn-var-val"
                    value={v.val === true || v.val === 'true' ? 'true' : 'false'}
                    aria-label="Значение"
                    onChange={(e) => store.updateVar(v.id, { val: e.target.value === 'true' }, { label: 'Значение переменной' })}
                  >
                    <option value="true">true</option>
                    <option value="false">false</option>
                  </select>
                ) : (
                  <input
                    className="rn-var-val"
                    value={String(v.val ?? '')}
                    aria-label="Значение по умолчанию"
                    onFocus={() => { editPreRef.current = store.beginEdit(); }}
                    onChange={(e) => store.updateVar(v.id, { val: e.target.value }, { history: false })}
                    onBlur={() => { store.commitEdit(editPreRef.current, 'Значение переменной'); editPreRef.current = null; }}
                  />
                )}
                <button type="button" className="rn-var-del" title="Удалить переменную" onClick={() => store.deleteVar(v.id)}>×</button>
                <button type="button" className="rn-var-fold" title="Подробнее" onClick={() => toggleOpen(v.id)}>{isOpen ? '▾' : '▸'}</button>
              </div>
              {isOpen && (
                <div className="rn-var-edit">
                  {t === 'num' && (
                    <div className="rn-var-steps">
                      <button type="button" onClick={() => store.updateVar(v.id, { val: (typeof v.val === 'number' ? v.val : 0) - 1 }, { history: false })}>−</button>
                      <button type="button" onClick={() => store.updateVar(v.id, { val: (typeof v.val === 'number' ? v.val : 0) + 1 }, { history: false })}>+</button>
                    </div>
                  )}
                  {t === 'bool' && (
                    <div className="rn-var-steps">
                      <button type="button" onClick={() => store.updateVar(v.id, { val: true }, { history: false })}>true</button>
                      <button type="button" onClick={() => store.updateVar(v.id, { val: false }, { history: false })}>false</button>
                    </div>
                  )}
                  <div className="rn-var-use">{varUseText(store, v.id)}</div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function varUseText(store: VetviStore, vid: string): string {
  let nodes = 0;
  let conds = 0;
  let vin = false;
  for (const n of store.doc.nodes) {
    if (n.type === 'varnode' && n.vid === vid) nodes++;
    if (n.type === 'branch' && Array.isArray(n.outcomes)) {
      for (const o of n.outcomes) if ((o as { cond?: { vid?: string } }).cond?.vid === vid) conds++;
    }
  }
  for (const e of store.doc.edges) {
    const c = (e as unknown as { cond?: { vid?: string } }).cond;
    if (c && c.vid === vid) conds++;
    if (e.tin === 'var') {
      const src = store.nodeById(e.from);
      if (src && src.type === 'varnode' && src.vid === vid) vin = true;
    }
  }
  return 'используется на холсте — ноды: ' + nodes + ' · условия: ' + conds + (vin ? ' · вход развилки: да' : '');
}

/* ── Персонажи ── */
function CharsPane({ store }: { store: VetviStore }) {
  const chars = store.doc.chars || [];
  const [open, setOpen] = useState<Set<string>>(new Set());
  const editPreRef = useRef<string | null>(null);
  const fileRefs = useRef(new Map<string, HTMLInputElement | null>());

  const toggleOpen = (id: string) => {
    const s = new Set(open);
    if (s.has(id)) s.delete(id);
    else s.add(id);
    setOpen(s);
  };

  const onFile = (cid: string, file: File | null) => {
    if (!file || !/^image\//.test(file.type)) return;
    fileToAvatar(file, (dataUrl) => {
      store.updateChar(cid, { av: dataUrl }, { label: 'Аватар персонажа' });
      store.toast('Аватар обновлён', 'ok');
    });
  };

  return (
    <div className="rn-pane">
      <div className="rn-pane-head rn-between">
        <span>Персонажи истории</span>
        <button type="button" className="rn-mini" onClick={() => { const c = store.addChar(); setOpen(new Set([...open, c.id])); }}>+ Персонаж</button>
      </div>
      {!chars.length && (
        <div className="rn-pane-hint">
          Персонаж — участник диалогов: имя, цвет и аватар. Добавьте персонажа и выберите его участником диалога — реплики получат говорящего.
        </div>
      )}
      <div className="rn-chars-list">
        {chars.map((c: VetviChar) => {
          const isOpen = open.has(c.id);
          return (
            <div className="rn-char-row" key={c.id}>
              <div className="rn-char-line">
                <button type="button" className="rn-char-avpick" title="Загрузить аватар" onClick={() => fileRefs.current.get(c.id)?.click()}>
                  <span className={'rn-av ' + (c.avShape === 'square' ? 'square' : 'circle') + (c.av ? '' : ' empty')} style={{ borderColor: c.color || '#9cb878' }}>
                    {c.av ? <img src={String(c.av)} alt={'Аватар: ' + c.name} /> : (c.name || '?')[0].toUpperCase()}
                  </span>
                </button>
                <input
                  ref={(el) => { fileRefs.current.set(c.id, el); }}
                  type="file"
                  accept="image/*"
                  hidden
                  onChange={(e) => onFile(c.id, e.target.files?.[0] || null)}
                />
                <input
                  className="rn-char-name"
                  maxLength={60}
                  value={String(c.name || '')}
                  aria-label="Имя персонажа"
                  onFocus={() => { editPreRef.current = store.beginEdit(); }}
                  onChange={(e) => store.updateChar(c.id, { name: e.target.value }, { history: false })}
                  onBlur={() => { store.commitEdit(editPreRef.current, 'Правка персонажа'); editPreRef.current = null; }}
                />
                <button type="button" className="rn-var-del" title="Удалить персонажа" onClick={() => store.deleteChar(c.id)}>×</button>
                <button type="button" className="rn-var-fold" title="Подробнее" onClick={() => toggleOpen(c.id)}>{isOpen ? '▾' : '▸'}</button>
              </div>
              {isOpen && (
                <div className="rn-char-edit">
                  <div className="rn-char-avrow">
                    <span className={'rn-av big ' + (c.avShape === 'square' ? 'square' : 'circle') + (c.av ? '' : ' empty')} style={{ borderColor: c.color || '#9cb878' }}>
                      {c.av ? <img src={String(c.av)} alt="" /> : (c.name || '?')[0].toUpperCase()}
                    </span>
                    <div className="rn-char-avbtns">
                      <button type="button" className="rn-mini" onClick={() => fileRefs.current.get(c.id)?.click()}>Загрузить…</button>
                      {!!c.av && <button type="button" className="rn-mini" onClick={() => store.updateChar(c.id, { av: null }, { label: 'Убрать аватар' })}>Убрать</button>}
                    </div>
                    <div className="rn-seg sm">
                      <button type="button" className={c.avShape !== 'square' ? 'on' : ''} onClick={() => store.updateChar(c.id, { avShape: 'circle' }, { history: false })}>круг</button>
                      <button type="button" className={c.avShape === 'square' ? 'on' : ''} onClick={() => store.updateChar(c.id, { avShape: 'square' }, { history: false })}>квадрат</button>
                    </div>
                  </div>
                  <div className="rn-palette sm">
                    {['#e2a54e', '#e0b46b', '#d0714e', '#cf6b5a', '#c9857a', '#d6c96a', '#b7b26a', '#9cb878', '#7fb5a2', '#cbbd92', '#aab1bb', '#8b929c'].map((col) => (
                      <button key={col} type="button" className={'rn-swatch' + (c.color === col ? ' on' : '')} style={{ background: col }} title={col} aria-label={'Цвет ' + col} onClick={() => store.updateChar(c.id, { color: col }, { label: 'Цвет персонажа' })} />
                    ))}
                  </div>
                  <textarea
                    rows={2}
                    placeholder="Описание персонажа"
                    value={String(c.text || '')}
                    aria-label="Описание персонажа"
                    onFocus={() => { editPreRef.current = store.beginEdit(); }}
                    onChange={(e) => store.updateChar(c.id, { text: e.target.value }, { history: false })}
                    onBlur={() => { store.commitEdit(editPreRef.current, 'Описание персонажа'); editPreRef.current = null; }}
                  />
                  <div className="rn-var-use">{charUseText(store, c.id)}</div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function charUseText(store: VetviStore, cid: string): string {
  let dialogs = 0;
  let replies = 0;
  let nodes = 0;
  for (const n of store.doc.nodes) {
    if (n.dialog) {
      if ((n.dialog.participants || []).includes(cid)) dialogs++;
      const walk = (arr: { speaker?: string | null }[]) => {
        for (const r of arr) {
          if (r.speaker === cid) replies++;
          const ch = (r as { children?: { speaker?: string | null }[] }).children;
          if (ch) walk(ch);
        }
      };
      walk(n.dialog.replies || []);
    }
    if (Array.isArray(n.participants) && (n.participants as string[]).includes(cid)) nodes++;
  }
  return 'используется — диалогов: ' + dialogs + ' · реплик: ' + replies + (nodes ? ' · узлов: ' + nodes : '');
}

/** Сжатие аватара в dataURL (avCompressCrop оригинала: 192px webp → 128px jpeg). */
export function fileToAvatar(file: File, cb: (dataUrl: string) => void): void {
  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = () => {
      const side = Math.min(img.width, img.height);
      const sx = (img.width - side) / 2;
      const sy = (img.height - side) / 2;
      const put = (size: number, mime: string, q: number) => {
        const cv = document.createElement('canvas');
        cv.width = size;
        cv.height = size;
        const ctx = cv.getContext('2d');
        if (!ctx) return;
        ctx.drawImage(img, sx, sy, side, side, 0, 0, size, size);
        return cv.toDataURL(mime, q);
      };
      let out = put(192, 'image/webp', 0.85) || '';
      if (!out || out.length > 60000) out = put(128, 'image/jpeg', 0.8) || out;
      cb(out);
    };
    img.src = String(reader.result);
  };
  reader.readAsDataURL(file);
}

/* иконки */
function FolderIcon() {
  return <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /></svg>;
}
function ListIcon() {
  return <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M8 6h12M8 12h12M8 18h12" /><circle cx="3.7" cy="6" r="1.1" /><circle cx="3.7" cy="12" r="1.1" /><circle cx="3.7" cy="18" r="1.1" /></svg>;
}
function VarIcon() {
  return <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M5 8c2.6-5 5.4 5 8 0 1.4-2.6 3.4-3 6-1.5" /><path d="M5 12.5h14" /><path d="M5 17c2.6 5 5.4-5 8 0 1.4 2.6 3.4 3 6 1.5" /></svg>;
}
function CharIcon() {
  return <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="8.2" r="3.6" /><path d="M4.8 20c1.1-3.4 3.9-5.2 7.2-5.2s6.1 1.8 7.2 5.2" /></svg>;
}

/* helpers used by pane */
export { condOpsFor, opsForType };
