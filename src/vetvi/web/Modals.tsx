'use client';

/**
 * Ветви — модальные окна (этап 2): поиск по проекту (400 мс debounce, подсветка,
 * переход с миганием реплики), журнал действий (diff-записи, поиск 300 мс,
 * фильтр ноды/группы, откат проекта, показ на холсте), патчноут (версии+фильтр),
 * менеджер проектов (открыть/создать/переименовать/удалить/импорт), настройки
 * (хаб + горячие клавиши с перезахватом + хранилище LS/IDB), подтверждение,
 * создание группы из выделения.
 *
 * Разметка — 1:1 с классической версией (ветви/index.html):
 *  - generic-модалки (подтверждение, проекты, новая группа, sync-окна) —
 *    .modal-wrap > .m-card(.wide) с <h3>, содержимым и .m-btns (.btn/.primary/.danger);
 *  - «большие» окна — .dlg-modal(.sub).show > .dlg-modal-card (.log-card,
 *    .patch-card, .search-card, .set-card) с .dlg-modal-head/.dlg-modal-body/
 *    .dlg-modal-foot; поиск-бары — .search-bar (svg + input), футер-инфо —
 *    .log-foot-info, подвалы настроек — .set-foot-row + .set-store-msg.
 */

import { Fragment, useEffect, useRef, useState } from 'react';

import { APP_VERSION, PATCHNOTES, PATCH_TAGS } from '@/vetvi/core/patchnotes';
import { normalizeLogDiff, SECTION_TITLES } from '@/vetvi/core/logdiff';
import { looksLikeProject, projFmtDate, projList, readJsonFile } from '@/vetvi/core/projects';
import { LS_LIMITS, storeFmtSize, storeLsUsage, storeMode, storeSwitch, idbReadAll, storeSizeOf, storeCollectData } from '@/vetvi/core/storage';
import { hkConflict, hkDef, hkHuman, hkLoad, hkResetAll, hkSetUser, hkText, hkUserOverrides, HK_DEFS } from '@/vetvi/core/hotkeys';
import { condText } from '@/vetvi/core/vars';
import { STATUS_RU, TYPES } from '@/vetvi/core/constants';
import type { VetviNode } from '@/vetvi/core/types';
import type { LogEntry, VetviStore } from './store';
import { TypeEditorModal } from './TypeEditorModal';
import { TextsImportModal } from './TextsImportModal';
import { TypeIcon } from './NodeCard';
import { CopiesModal, CopyBarModal, MergeModal, PassRemoveModal, PassSetModal, RenameMeModal, RoomPassModal, ShareModal, SyncDiffModal } from './SyncModals';

/* ═══════════ иконки оригинала (ic(name,size): viewBox 24, stroke 1.7) ═══════════ */

function Ic(props: { size?: number; children: React.ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={props.size || 15}
      height={props.size || 15}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {props.children}
    </svg>
  );
}

const IC_PENCIL = (
  <Ic size={14}><path d="m4 20 1-4L16.3 4.7a2.1 2.1 0 0 1 3 3L8 19z" /><path d="M14.5 6.5l3 3" /></Ic>
);
const IC_TRASH = (
  <Ic size={14}><path d="M4 7h16M9 7V4h6v3M6.5 7l1 13h9l1-13M10 11v5M14 11v5" /></Ic>
);
const IC_RBACK = (
  <Ic size={12}><path d="M9 14 4 9l5-5" /><path d="M4 9h10.5A5.5 5.5 0 0 1 20 14.5v1" /><path d="M4 20h6" /></Ic>
);
const IC_TARGET = (
  <Ic size={12}><circle cx="12" cy="12" r="7" /><path d="M12 2v4M12 18v4M2 12h4M18 12h4" /></Ic>
);

/* ═══════════ общий каркас (generic: #modalWrap > .m-card) ═══════════ */

export function ModalShell(props: { title: string; onClose: () => void; children: React.ReactNode; foot?: React.ReactNode; wide?: boolean; cardClass?: string }) {
  return (
    <div className="modal-wrap" onClick={(e) => { if (e.target === e.currentTarget) props.onClose(); }} role="dialog" aria-label={props.title}>
      <div className={'m-card' + (props.wide ? ' wide' : '') + (props.cardClass ? ' ' + props.cardClass : '')}>
        <h3>{props.title}</h3>
        {props.children}
        <div className="m-btns">
          {props.foot !== undefined ? (
            props.foot
          ) : (
            <button type="button" className="btn primary" onClick={props.onClose}>Закрыть</button>
          )}
        </div>
      </div>
    </div>
  );
}

/* ── строка поиска .search-bar: лупа 15×15 (circle r7 + m21 21-4-4) ── */

export function SearchBar(props: { placeholder: string; onChange: (v: string) => void; autoFocus?: boolean; onEnter?: () => void; onEsc?: () => void; className?: string }) {
  return (
    <div className={'search-bar' + (props.className ? ' ' + props.className : '')}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="15" height="15" aria-hidden="true">
        <circle cx="11" cy="11" r="7" />
        <path d="m21 21-4-4" />
      </svg>
      <input
        autoFocus={props.autoFocus}
        placeholder={props.placeholder}
        onChange={(e) => props.onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && props.onEnter) props.onEnter();
          if (e.key === 'Escape' && props.onEsc) props.onEsc();
        }}
        aria-label={props.placeholder}
        autoComplete="off"
        spellCheck={false}
      />
    </div>
  );
}

/* подсветка совпадения: <mark class="search-mark"> */

function Mark({ text, q }: { text: string; q: string }) {
  if (!q) return <>{text}</>;
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, i)}
      <mark className="search-mark">{text.slice(i, i + q.length)}</mark>
      {text.slice(i + q.length)}
    </>
  );
}

/* ═══════════ поиск по проекту (.dlg-modal > .search-card) ═══════════ */

interface Hit { kind: string; frag: string; rid?: string }
interface HitNode { n: VetviNode; hits: Hit[]; more: number }

export function SearchModal({ store }: { store: VetviStore }) {
  const [q, setQ] = useState('');
  const [applied, setApplied] = useState('');
  const [results, setResults] = useState<HitNode[]>([]);
  const [stats, setStats] = useState('');
const runSearch = (query: string) => {
    const s = query.replace(/\s+/g, ' ').trim().toLowerCase();
    if (s.length < 2) { setResults([]); setStats(''); return; }
    const out: HitNode[] = [];
    let total = 0;
    let nodes = 0;
    for (const n of store.doc.nodes) {
      const hits = hitsOf(n, s);
      if (hits.length) {
        nodes++;
        total += hits.length;
        out.push({ n, hits: hits.slice(0, 5), more: Math.max(0, hits.length - 5) });
      }
    }
    setResults(out.slice(0, 80));
    setStats('Найдено: нод — ' + nodes + ', совпадений — ' + total + (out.length > 80 ? ' (показаны первые)' : ''));
  };

  const hitsOf = (n: VetviNode, s: string): Hit[] => {
    const hits: Hit[] = [];
    const add = (kind: string, text: string, rid?: string) => {
      const t = String(text || '');
      if (t.toLowerCase().includes(s)) hits.push({ kind, frag: fragOf(t, s), rid });
    };
    add('Название', n.title);
    add('Текст', n.text);
    for (const t of Array.isArray(n.tags) ? n.tags as string[] : []) add('Метка', t);
    /* заметки: заголовок + html-текст (как searchPlainHtml оригинала — теги в пробел) */
    const notes = Array.isArray(n.notes) ? n.notes as { title?: string; html?: string; hidden?: boolean }[] : [];
    for (const nt of notes) {
      if (!nt) continue;
      if (nt.title) add('Заметка', nt.title);
      if (nt.html) {
        const plain = String(nt.html)
          .replace(/<br\s*\/?>/gi, ' ')
          .replace(/<[^>]*>/g, ' ')
          .replace(/&nbsp;/gi, ' ')
          .replace(/&amp;/gi, '&')
          .replace(/&lt;/gi, '<')
          .replace(/&gt;/gi, '>')
          .replace(/&quot;/gi, '"')
          .replace(/\s+/g, ' ')
          .trim();
        if (plain) add('Заметка', plain);
      }
    }
    if (n.dialog) {
      add('Описание', n.dialog.description);
      for (const p of n.dialog.participants || []) add('Участник', store.charName(p));
      const walk = (arr: { id: string; text?: string; speaker?: string | null; children?: { id: string; text?: string; speaker?: string | null }[] }[]) => {
        for (const r of arr) {
          add('Реплика', r.text || '', r.id);
          if (r.speaker) add('Говорящий', store.charName(r.speaker));
          if (r.children) walk(r.children as typeof arr);
        }
      };
      walk(n.dialog.replies || []);
    }
    if (n.type === 'branch' && Array.isArray(n.outcomes)) {
      for (const o of n.outcomes) {
        add('Исход', o.label);
        if (o.cond) add('Условие исхода', condText(store.doc, o.cond));
      }
    }
    if (n.type === 'action' && Array.isArray(n.actions)) {
      for (const a of n.actions as { label?: string }[]) add('Кнопка', a.label || '');
    }
    if (n.type === 'varnode') add('Значение переменной', String(n.varVal ?? '') + ' ' + String(n.vid ? varNameSafe(store, n.vid) : ''));
    return hits;
  };
  useEffect(() => {
    const t = setTimeout(() => {
      setApplied(q);
      runSearch(q);
    }, 400);
    return () => clearTimeout(t);

  }, [q]);

  const go = (nid: string, rid?: string) => {
    store.closeModal();
    store.selectOnly(nid);
    store.requestCenter(nid);
    if (rid) store.requestFlash(nid, rid);
  };

  const qs = applied.trim();
  return (
    <div className="dlg-modal show" onClick={(e) => { if (e.target === e.currentTarget) store.closeModal(); }} role="dialog" aria-label="Поиск по проекту">
      <div className="dlg-modal-card search-card">
        <div className="dlg-modal-head">
          <span className="dlg-modal-title">Поиск по проекту</span>
          <button type="button" className="dlg-modal-close" title="Закрыть" onClick={() => store.closeModal()}>×</button>
        </div>
        <div className="dlg-modal-body search-body">
          <SearchBar
            autoFocus
            placeholder="Найти в репликах, названиях, заметках, метках, исходах…"
            onChange={setQ}
            onEnter={() => {
              const first = results[0];
              if (first) go(first.n.id, first.hits[0]?.rid);
            }}
            onEsc={() => { if (q) setQ(''); else store.closeModal(); }}
          />
          <div className="search-hint">{stats}</div>
          <div className="search-results">
            {results.map(({ n, hits, more }) => (
              <div className="search-node-row" key={n.id}>
                <button type="button" className="search-node-head" onClick={() => go(n.id)}>
                  <span className="search-nico" style={{ color: n.color || TYPES[n.type]?.color }}><TypeIcon type={n.type} /></span>
                  <span className="search-ntitle">{n.title || 'Без названия'}</span>
                  <span className="search-ntype">{TYPES[n.type]?.name || n.type}</span>
                </button>
                {hits.map((h, i) => (
                  <button type="button" className="search-hit" key={i} onClick={() => go(n.id, h.rid)}>
                    <span className="search-kind">{h.kind}</span>
                    <span className="search-frag"><Mark text={h.frag} q={applied} /></span>
                  </button>
                ))}
                {more > 0 && <div className="search-more">ещё совпадений: {more}</div>}
              </div>
            ))}
            {qs.length < 2 && !results.length && <div className="search-empty">Введите минимум два символа — поиск идёт по всем нодам проекта</div>}
            {qs.length >= 2 && !results.length && <div className="search-empty">Ничего не найдено по «{qs}»</div>}
          </div>
        </div>
        <div className="dlg-modal-foot">
          <span className="log-foot-info">Enter — к первой находке · Esc — закрыть</span>
          <button type="button" className="btn primary" onClick={() => store.closeModal()}>Закрыть</button>
        </div>
      </div>
    </div>
  );
}

function varNameSafe(store: VetviStore, vid: string): string {
  const v = (store.doc.vars || []).find((x) => x.id === vid);
  return v ? v.name : '';
}

function fragOf(text: string, q: string): string {
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  const start = Math.max(0, i - 48);
  const end = Math.min(text.length, i + q.length + 48);
  return (start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '');
}

/* ═══════════ журнал действий (.dlg-modal > .log-card) ═══════════ */

/* префиксы пунктов деталей: добавленное — «+», удалённое — «−» (logDetSec оригинала) */
const LOG_PREFIX: Record<string, string> = { nA: '+', nD: '−', eA: '+', eD: '−', gA: '+', gD: '−' };
const LOG_RB_NO_SNAP = 'Снимок состояния для этой записи недоступен: запись старая, от другого участника, или снимок вытеснен более новыми.';

/* значение поля: hex — цветной ромбик .ld-dot, иначе «текст» старым/новым классом */
function LdSide({ val, cls }: { val: string; cls: string }) {
  if (/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(val)) {
    return <span className="ld-dot" style={{ background: val }} title={val} />;
  }
  if (val) return <span className={cls}>«{val}»</span>;
  return null;
}

export function LogModal({ store }: { store: VetviStore }) {
  const [q, setQ] = useState('');
  const [applied, setApplied] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const entries = (store.doc.meta.actionLog || []) as LogEntry[];
  void store.revision;

  useEffect(() => {
    const t = setTimeout(() => setApplied(q), 300);
    return () => clearTimeout(t);
  }, [q]);

  const filtered = entries.filter((e) => {
    if (store.logFilterNode) {
      if (!entryForNode(e, store.logFilterNode)) return false;
    }
    if (store.logFilterGroup) {
      if (!entryForGroup(e, store.logFilterGroup)) return false;
    }
    if (!applied) return true;
    const hay = (e.act + ' ' + (e.by?.name || '') + ' ' + JSON.stringify(e.diff || '') + ' ' + fmtWhen(new Date(e.t).toISOString())).toLowerCase();
    return hay.includes(applied.toLowerCase());
  });

  const fn = store.logFilterNode ? store.nodeById(store.logFilterNode) : null;
  const fg = store.logFilterGroup ? store.groupById(store.logFilterGroup) : null;
  const capTitle = store.logFilterNode
    ? 'Журнал: «' + ((fn && fn.title) || 'нода удалена') + '»'
    : store.logFilterGroup
      ? 'Журнал: «' + ((fg && fg.name) || 'группа удалена') + '»'
      : 'Журнал действий';
  const gone = store.logFilterNode ? !fn : store.logFilterGroup ? !fg : false;

  const closeAll = () => { store.setLogFilters(null, null); store.closeModal(); };

  const showOnCanvas = (e: LogEntry) => {
    const ids = (e.diff && e.diff.ids) || [];
    if (ids.length && store.nodeById(ids[0])) {
      store.closeModal();
      store.selectOnly(ids[0]);
      store.requestCenter(ids[0]);
    } else {
      store.toast('Объекты записи не найдены на холсте', 'warn');
    }
  };

  const lq = applied.trim();
  const emptyMsg = lq
    ? 'По «' + lq + '» в журнале ничего нет'
    : store.logFilterNode
      ? 'Для этой ноды пока нет записей в журнале.'
      : store.logFilterGroup
        ? 'Для этой группы пока нет записей в журнале.'
        : 'Пока пусто. Сделайте что-нибудь на холсте — действия появятся здесь: кто, когда и что именно изменил.';

  return (
    <div className="dlg-modal show" role="dialog" aria-label={capTitle}>
      <div className="dlg-modal-card log-card">
        <div className="dlg-modal-head">
          <span className="dlg-modal-title">{capTitle}</span>
          <button type="button" className="dlg-modal-close" title="Закрыть" onClick={closeAll}>×</button>
        </div>
        <div className="log-tools">
          <SearchBar
            autoFocus
            placeholder="Поиск по журналу: действие, автор, объект, дата…"
            onChange={setQ}
            onEsc={() => { if (q) setQ(''); else closeAll(); }}
          />
        </div>
        <div className="dlg-modal-body">
          {filtered.length ? (
            <div className="log-list">
              {filtered.map((e) => {
                const c = (e.by && e.by.color) || '#8b929c';
                const nm = (e.by && e.by.name) || '—';
                /* записи классической версии приезжают со старым форматом diff
                   (nA/nD/nC… кортежи) — нормализуем в секции перед рендером */
                const diff = normalizeLogDiff(e.diff);
                return (
                  <div
                    className={'log-row' + (openId === e.id ? ' open' : '')}
                    key={e.id}
                    onClick={() => setOpenId(openId === e.id ? null : e.id)}
                  >
                    <div className="log-line">
                      <span className="log-when"><Mark text={fmtWhen(new Date(e.t).toISOString())} q={applied} /></span>
                      <span className="log-dot" style={{ background: c, color: c }} />
                      <span className="log-who"><Mark text={nm} q={applied} /></span>
                      <span className="log-act"><Mark text={e.act || ''} q={applied} /></span>
                    </div>
                    {openId === e.id && (
                      <div className="log-det">
                        {!diff ? (
                          <div className="log-item log-fields">Детали этой записи недоступны</div>
                        ) : (
                          diff.sections.map((sec) => (
                            <Fragment key={sec.key}>
                              <div className="log-sec">{SECTION_TITLES[sec.key] || sec.key}</div>
                              {sec.items.slice(0, 8).map((it) => (
                                <div className="log-item" key={it.id}>
                                  {LOG_PREFIX[sec.key] ? LOG_PREFIX[sec.key] + ' ' : ''}<b>{it.name}</b>
                                  {!!it.fields.length && (
                                    <div className="log-dtxt">
                                      {it.fields.map((f, fi) => (
                                        <div className="ld-row" key={fi}>
                                          <span className="ld-k">{f.k}:</span>{' '}
                                          <LdSide val={f.a} cls="ld-old" />
                                          {f.a && f.b ? <span className="ld-arr"> → </span> : null}
                                          <LdSide val={f.b} cls="ld-new" />
                                        </div>
                                      ))}
                                    </div>
                                  )}
                                </div>
                              ))}
                              {sec.items.length > 8 && <div className="log-item log-fields">… ещё {sec.items.length - 8}</div>}
                            </Fragment>
                          ))
                        )}
                        <button
                          type="button"
                          className={'log-rb log-rb-proj' + (e.snap ? '' : ' dis')}
                          title={e.snap
                            ? 'Проект вернётся к состоянию до этого изменения: ноды, связи, группы, переменные. Сам откат можно отменить (' + hkText('undo') + ').'
                            : LOG_RB_NO_SNAP}
                          disabled={!e.snap}
                          onClick={(ev) => {
                            ev.stopPropagation();
                            if (!e.snap) return;
                            store.rollbackToSnapshot(e.snap as string);
                            store.toast('Проект откачен к моменту записи', 'ok');
                            store.closeModal();
                          }}
                        >
                          {IC_RBACK} Откатить проект к этому моменту
                        </button>
                        <button
                          type="button"
                          className="log-loc"
                          onClick={(ev) => { ev.stopPropagation(); showOnCanvas(e); }}
                        >
                          {IC_TARGET} Показать на холсте
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="log-empty">{emptyMsg}</div>
          )}
        </div>
        <div className="dlg-modal-foot">
          <span className="log-foot-info">записей: {filtered.length}{gone ? ' · объект удалён' : ''}</span>
          {(store.logFilterNode || store.logFilterGroup) && (
            <button type="button" className="btn" title="Показать все записи" onClick={() => store.setLogFilters(null, null)}>Все записи</button>
          )}
          <button type="button" className="btn primary" onClick={closeAll}>Готово</button>
        </div>
      </div>
    </div>
  );
}

function fmtWhen(iso: string): string {
  try {
    const d = new Date(iso);
    const today = new Date();
    const sameDay = d.toDateString() === today.toDateString();
    const hm = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    return sameDay ? hm : d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' }) + ' ' + hm;
  } catch {
    return '—';
  }
}

function entryForNode(e: LogEntry, nid: string): boolean {
  if (e.diff?.nodes?.includes(nid)) return true;
  if (e.diff?.ids?.includes(nid)) return true;
  const n = storeNodeName(e, nid);
  return n ? e.act.toLowerCase().includes(n.toLowerCase()) : false;
}

function entryForGroup(e: LogEntry, gid: string): boolean {
  if (e.diff?.groups?.includes(gid)) return true;
  return false;
}

let storeNodeName: (e: LogEntry, nid: string) => string | null = () => null;

export function bindLogHelpers(fn: (e: LogEntry, nid: string) => string | null): void {
  storeNodeName = fn;
}

/* ═══════════ патчноут (.dlg-modal > .patch-card) ═══════════ */

export function PatchModal({ store }: { store: VetviStore }) {
  const [q, setQ] = useState('');
  const [applied, setApplied] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setApplied(q), 300);
    return () => clearTimeout(t);
  }, [q]);
  const list = PATCHNOTES.map((v) => {
    const items = v.items.filter((it) => {
      if (!applied) return true;
      const s = applied.toLowerCase();
      return it.t.toLowerCase().includes(s) || (PATCH_TAGS[it.k] || '').includes(s) || v.ver.toLowerCase().startsWith(s);
    });
    return { v, items };
  }).filter(({ v, items }) => !applied || items.length > 0 || v.ver.toLowerCase().startsWith(applied.toLowerCase()));

  return (
    <div className="dlg-modal show" onClick={(e) => { if (e.target === e.currentTarget) store.closeModal(); }} role="dialog" aria-label="Что нового — патчноут">
      <div className="dlg-modal-card patch-card">
        <div className="dlg-modal-head">
          <span className="dlg-modal-title">Что нового</span>
          <button type="button" className="dlg-modal-close" title="Закрыть" onClick={() => store.closeModal()}>×</button>
        </div>
        <div className="patch-tools">
          <SearchBar placeholder="Фильтр журнала: текст записи или версия…" onChange={setQ} />
        </div>
        <div className="dlg-modal-body patch-body">
          {list.map(({ v, items }, i) => (
            <div className="patch-ver" key={v.ver}>
              <div className="patch-ver-head">
                <span className="patch-ver-v">v{v.ver}</span>
                {i === 0 && !applied && <span className="patch-latest">актуально</span>}
              </div>
              {items.map((it, k) => (
                <div className="patch-item" key={k}>
                  <span className={'patch-tag ' + it.k}>{PATCH_TAGS[it.k] || it.k}</span>
                  <span>{it.t}</span>
                </div>
              ))}
              {applied && !items.length && (
                <div className="patch-item"><span className="patch-tag chg">версия</span><span>совпадений в этой версии нет</span></div>
              )}
            </div>
          ))}
          {applied && !list.length && <div className="patch-empty">По «{applied.trim()}» в журнале ничего нет</div>}
        </div>
        <div className="dlg-modal-foot">
          <span className="log-foot-info">Текущая версия: v{APP_VERSION}</span>
          <button type="button" className="btn primary" onClick={() => store.closeModal()}>Закрыть</button>
        </div>
      </div>
    </div>
  );
}

/* ═══════════ менеджер проектов (.m-card > .pj-list + .pj-foot) ═══════════ */

export function ProjectsModal({ store }: { store: VetviStore }) {
  const [, tick] = useState(0);
  const cur = String(store.doc.meta.projectId || '');
  const impRef = useRef<HTMLInputElement>(null);
  const [ren, setRen] = useState<{ id: string; val: string } | null>(null);

  const list = projList();
  const refresh = () => tick((t) => t + 1);
  const curFlag = (id: string) => id === cur && store.syncMode !== 'copy';

  return (
    <ModalShell title="Мои проекты" onClose={() => store.closeModal()}>
      <div className="pj-list">
        {list.map((e) => (
          <div
            className={'pj-row' + (e.id === cur ? ' cur' : '')}
            key={e.id}
            title="Открыть проект"
            onClick={(ev) => {
              const t = ev.target as HTMLElement | null;
              if (t && t.closest && t.closest('.pj-ib')) return;
              store.openProject(e.id);
              store.closeModal();
            }}
          >
            {ren && ren.id === e.id ? (
              <input
                className="inp"
                autoFocus
                maxLength={80}
                value={ren.val}
                onClick={(ev) => ev.stopPropagation()}
                onChange={(ev) => setRen({ id: e.id, val: ev.target.value })}
                onKeyDown={(ev) => {
                  if (ev.key === 'Enter') {
                    store.renameProject(e.id, ren.val.trim() || e.name);
                    setRen(null);
                    refresh();
                  }
                  if (ev.key === 'Escape') setRen(null);
                }}
                onBlur={() => { store.renameProject(e.id, ren.val.trim() || e.name); setRen(null); refresh(); }}
                aria-label="Имя проекта"
              />
            ) : (
              <div className="pj-main">
                <div className="pj-name">
                  {e.name || 'Без названия'}
                  {curFlag(e.id) && <span style={{ color: 'var(--acc)', fontSize: '10px', whiteSpace: 'nowrap' }}> · текущий</span>}
                </div>
                <div className="pj-meta">{[projFmtDate(e.modified || e.at), (e.nodes ?? 0) + ' узл.'].filter(Boolean).join(' · ')}</div>
              </div>
            )}
            {e.roomId ? <span className="pj-badge">комната</span> : null}
            <div className="pj-acts">
              <button type="button" className="pj-ib" title="Переименовать" onClick={(ev) => { ev.stopPropagation(); setRen({ id: e.id, val: e.name }); }}>
                {IC_PENCIL}
              </button>
              <button
                type="button"
                className="pj-ib danger"
                title="Удалить"
                onClick={(ev) => {
                  ev.stopPropagation();
                  const last = list.length <= 1;
                  store.confirmBox({
                    title: 'Удалить проект?',
                    text: '<p>«' + e.name + '» будет удалён с этого устройства безвозвратно.</p>',
                    buttons: [
                      { label: 'Отмена', primary: true },
                      { label: 'Удалить', danger: true, fn: () => { store.deleteProject(e.id); refresh(); } },
                    ],
                  });
                  void last;
                }}
              >
                {IC_TRASH}
              </button>
            </div>
          </div>
        ))}
        {!list.length && <div className="pj-empty">Пока нет проектов — создайте первый</div>}
      </div>
      <div className="pj-foot">
        <button type="button" className="btn" onClick={() => { store.createProject(); store.closeModal(); }}>+ Новый проект</button>
        <button type="button" className="btn" onClick={() => impRef.current?.click()}>Импорт из файла…</button>
      </div>
      <input
        ref={impRef}
        type="file"
        accept=".json,application/json"
        hidden
        onChange={async (ev) => {
          const f = ev.target.files?.[0];
          if (!f) return;
          try {
            const parsed = await readJsonFile(f);
            if (!looksLikeProject(parsed)) {
              store.toast('Файл не похож на проект Ветвей', 'err');
              return;
            }
            store.importProject(parsed, f.name);
            store.closeModal();
          } catch {
            store.toast('Не удалось прочитать JSON', 'err');
          }
        }}
      />
    </ModalShell>
  );
}

/* ═══════════ подтверждение (.m-card + .m-btns) ═══════════ */

export function ConfirmHost({ store }: { store: VetviStore }) {
  const cfg = store.confirm;
  if (!cfg) return null;
  return (
    <div className="modal-wrap" onClick={(e) => { if (e.target === e.currentTarget) store.closeConfirm(); }} role="alertdialog" aria-label={cfg.title}>
      <div className={'m-card' + (cfg.wide ? ' wide' : '')}>
        <h3>{cfg.title}</h3>
        {cfg.text && <div dangerouslySetInnerHTML={{ __html: cfg.text }} />}
        <div className="m-btns">
          {(cfg.buttons || [{ label: 'Отмена', primary: true }]).map((b, i) => (
            <button
              key={i}
              type="button"
              className={'btn' + (b.primary ? ' primary' : '') + (b.danger ? ' danger' : '')}
              onClick={() => { store.closeConfirm(); if (b.fn) b.fn(); }}
            >
              {b.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ═══════════ создание группы из выделения (.m-card) ═══════════ */

export function GroupCreateModal({ store }: { store: VetviStore }) {
  const [name, setName] = useState('Группа');
  return (
    <ModalShell title="Новая группа" onClose={() => store.closeModal()} foot={
      <>
        <button type="button" className="btn" onClick={() => store.closeModal()}>Отмена</button>
        <button type="button" className="btn primary" onClick={() => {
          const gid = store.createGroupFromSel(name.trim());
          store.closeModal();
          if (gid) store.toast('Группа создана · элементов: ' + (store.membersOf(gid).length), 'ok');
        }}>Создать</button>
      </>
    }>
      <p>Объектов в выделении: {store.sel.size} узлов, {store.selGroups.size} групп. Выделенные группы станут вложенными.</p>
      <label className="i-lab">Название группы</label>
      <input
        className="inp"
        autoFocus
        value={name}
        maxLength={60}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            const gid = store.createGroupFromSel(name.trim());
            store.closeModal();
            if (gid) store.toast('Группа создана', 'ok');
          }
        }}
        aria-label="Название группы"
      />
    </ModalShell>
  );
}

/* ═══════════ настройки: хаб + горячие клавиши + хранилище (.dlg-modal > .set-card) ═══════════ */

export function SettingsModal({ store, section }: { store: VetviStore; section: 'hub' | 'hk' | 'store' | 'ui' }) {
  if (section === 'hk') return <HkModal store={store} />;
  if (section === 'store') return <StoreModal store={store} />;
  if (section === 'ui') return <UiModal store={store} />;
  return (
    <div className="dlg-modal show" role="dialog" aria-label="Настройки проекта">
      <div className="dlg-modal-card set-card">
        <div className="dlg-modal-head">
          <span className="dlg-modal-title">Настройки проекта</span>
          <button type="button" className="dlg-modal-close" title="Закрыть" onClick={() => store.closeModal()}>×</button>
        </div>
        <div className="dlg-modal-body">
          <div className="set-hint">Каждый раздел открывается в отдельном окне — выберите нужный.</div>
          <button type="button" className="set-item" onClick={() => store.openModal('settingsStore')}>
            <span className="set-item-ico">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" width="20" height="20" aria-hidden="true">
                <ellipse cx="12" cy="5" rx="8" ry="3" />
                <path d="M4 5v6c0 1.66 3.58 3 8 3s8-1.34 8-3V5" />
                <path d="M4 11v6c0 1.66 3.58 3 8 3s8-1.34 8-3v-6" />
              </svg>
            </span>
            <span className="set-item-info">
              <span className="set-item-name">Хранилище данных</span>
              <span className="set-item-desc">LocalStorage или IndexedDB: занятое место и переключение режима</span>
            </span>
            <span className="set-item-go">→</span>
          </button>
          <button type="button" className="set-item" onClick={() => store.openModal('settingsHk')}>
            <span className="set-item-ico">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" width="20" height="20" aria-hidden="true">
                <rect x="2" y="6" width="20" height="12" rx="2" />
                <path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M6 14h.01M18 14h.01M9 14h6" />
              </svg>
            </span>
            <span className="set-item-info">
              <span className="set-item-name">Горячие клавиши</span>
              <span className="set-item-desc">Список действий и переназначение сочетаний</span>
            </span>
            <span className="set-item-go">→</span>
          </button>
          <button type="button" className="set-item" onClick={() => store.openModal('settingsUi')}>
            <span className="set-item-ico">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" width="20" height="20" aria-hidden="true">
                <rect x="3" y="4" width="18" height="13" rx="2" />
                <path d="M8 21h8M12 17v4" />
                <path d="M7 9h4M7 12h7" />
              </svg>
            </span>
            <span className="set-item-info">
              <span className="set-item-name">Настройки интерфейса</span>
              <span className="set-item-desc">Пределы масштаба холста: отдаление и приближение</span>
            </span>
            <span className="set-item-go">→</span>
          </button>
        </div>
        <div className="dlg-modal-foot">
          <span className="log-foot-info"></span>
          <button type="button" className="btn primary" onClick={() => store.closeModal()}>Готово</button>
        </div>
      </div>
    </div>
  );
}

function HkModal({ store }: { store: VetviStore }) {
  const [filter, setFilter] = useState('');
  const [applied, setApplied] = useState('');
  const [msg, setMsg] = useState<{ t: string; cls: string } | null>(null);
  const [cap, setCap] = useState<string | null>(null);
  const [, tick] = useState(0);
  void store.revision;

  useEffect(() => {
    hkLoad();
  }, []);

  useEffect(() => {
    const t = setTimeout(() => setApplied(filter), 300);
    return () => clearTimeout(t);
  }, [filter]);

  /* захват нового сочетания — capture-фаза, глушит всё */
  useEffect(() => {
    if (!cap) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const k = e.key;
      if (k === 'Escape') { setCap(null); setMsg({ t: 'Захват отменён', cls: '' }); return; }
      if (['Control', 'Meta', 'Shift', 'Alt', 'OS', 'NumLock', 'CapsLock'].includes(k)) return;
      const combo = comboOf(e);
      const conf = hkConflict(combo, cap);
      if (conf) {
        setMsg({ t: '«' + hkHuman(combo) + '» уже занято — «' + conf + '». Сначала сбросьте или переназначьте его.', cls: 'err' });
        setCap(null);
        return;
      }
      hkSetUser(cap, combo);
      setCap(null);
      setMsg({ t: '«' + hkDef(cap)?.name + '» — назначено ' + hkHuman(combo), cls: 'ok' });
      tick((t) => t + 1);
      store.toast('«' + hkDef(cap)?.name + '» — ' + hkHuman(combo), 'ok');
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);

  }, [cap]);

  const list = HK_DEFS.filter((d) => {
    if (!applied) return true;
    const s = applied.toLowerCase();
    return d.name.toLowerCase().includes(s) || hkHuman(hkText2(d.id)).toLowerCase().includes(s);
  });

  return (
    <div className="dlg-modal sub show" role="dialog" aria-label="Настройки — Горячие клавиши">
      <div className="dlg-modal-card set-card">
        <div className="dlg-modal-head">
          <span className="dlg-modal-title">Настройки — Горячие клавиши</span>
          <button type="button" className="dlg-modal-close" title="Закрыть" onClick={() => store.closeModal()}>×</button>
        </div>
        <div className="dlg-modal-body">
          <div className="set-hint"></div>
          <SearchBar autoFocus className="hk-search" placeholder="Фильтр по названию действия или клавишам…" onChange={setFilter} />
          <div className="hk-list">
            {list.map((d) => {
              const isUser = !!hkUserOverrides()[d.id];
              return (
                <div className={'hk-row' + (cap === d.id ? ' cap' : '')} key={d.id}>
                  <span className="hk-name">{d.name}</span>
                  {cap === d.id ? (
                    <>
                      <span className="hk-keys hk-wait">нажмите сочетание…</span>
                      <span className="hk-acts">
                        <button type="button" className="btn btn-xs" onClick={() => { setCap(null); setMsg({ t: 'Захват отменён', cls: '' }); }}>Отмена</button>
                      </span>
                    </>
                  ) : (
                    <>
                      <span className="hk-keys">
                        <kbd>{hkHuman(hkText2(d.id))}</kbd>
                        {isUser && <i className="hk-flag" title="Значение изменено вручную">своё</i>}
                      </span>
                      <span className="hk-acts">
                        <button type="button" className="btn btn-xs" onClick={() => { setCap(d.id); setMsg(null); }}>Изменить</button>
                        {isUser && (
                          <button type="button" className="btn btn-xs" title="Вернуть по умолчанию" onClick={() => {
                            hkSetUser(d.id, null);
                            setMsg({ t: '«' + d.name + '» — по умолчанию ' + hkHuman(d.def), cls: 'ok' });
                            tick((t) => t + 1);
                          }}>↺</button>
                        )}
                      </span>
                    </>
                  )}
                </div>
              );
            })}
            {!list.length && <div className="hk-empty">Ничего не найдено по «{filter.trim()}»</div>}
          </div>
          <div className="set-foot-row">
            <button type="button" className="btn btn-xs" onClick={() => { hkResetAll(); setMsg({ t: 'Все горячие клавиши возвращены к значениям по умолчанию', cls: 'ok' }); tick((t) => t + 1); }}>Сбросить все</button>
            {msg && <span className={'set-store-msg' + (msg.cls ? ' ' + msg.cls : '')}>{msg.t}</span>}
          </div>
        </div>
        <div className="dlg-modal-foot">
          <button type="button" className="btn" onClick={() => store.openModal('settings')}>← Назад</button>
          <button type="button" className="btn primary" onClick={() => store.closeModal()}>Готово</button>
        </div>
      </div>
    </div>
  );
}

function hkText2(id: string): string {
  return hkText(id);
}

/* ── настройки интерфейса: пределы масштаба холста ── */

function UiModal({ store }: { store: VetviStore }) {
  const [zmin, setZmin] = useState(String(store.uiZoomMin));
  const [zmax, setZmax] = useState(String(store.uiZoomMax));
  const [msg, setMsg] = useState<{ t: string; cls: string } | null>(null);

  const parse = (v: string): number | null => {
    const n = Number(v.replace(',', '.'));
    return Number.isFinite(n) && n > 0 ? n : null;
  };

  const apply = (min: number, max: number, quiet?: boolean) => {
    if (min >= max) {
      setMsg({ t: 'Минимум должен быть меньше максимума', cls: 'err' });
      return false;
    }
    store.setZoomLimits(min, max);
    setZmin(String(store.uiZoomMin));
    setZmax(String(store.uiZoomMax));
    if (!quiet) setMsg({ t: 'Пределы масштаба сохранены: ' + Math.round(store.uiZoomMin * 100) + '% … ' + Math.round(store.uiZoomMax * 100) + '%', cls: 'ok' });
    return true;
  };

  const invalid = (() => {
    const lo = parse(zmin);
    const hi = parse(zmax);
    if (lo === null || hi === null) return 'Введите положительные числа (например 0.1 и 3)';
    if (lo >= hi) return 'Минимум должен быть меньше максимума';
    return null;
  })();

  return (
    <div className="dlg-modal sub show" role="dialog" aria-label="Настройки — Интерфейс">
      <div className="dlg-modal-card set-card">
        <div className="dlg-modal-head">
          <span className="dlg-modal-title">Настройки — Интерфейс</span>
          <button type="button" className="dlg-modal-close" title="Закрыть" onClick={() => store.closeModal()}>×</button>
        </div>
        <div className="dlg-modal-body">
          <div className="set-hint">Пределы масштаба холста: как далеко можно отдалить и как близко приблизить. Колесо мыши и кнопки «±» работают в этих границах.</div>
          <div className="ui-zoom-row">
            <label className="ui-zoom-field">
              <span className="ui-zoom-name">Минимальный масштаб</span>
              <span className="ui-zoom-desc">Насколько далеко можно отдалить холст</span>
              <span className="ui-zoom-input">
                <input
                  type="text"
                  inputMode="decimal"
                  value={zmin}
                  aria-label="Минимальный масштаб холста"
                  onChange={(e) => setZmin(e.target.value)}
                />
                <span className="ui-zoom-pct">= {Math.round((parse(zmin) || 0) * 100)}%</span>
              </span>
            </label>
            <label className="ui-zoom-field">
              <span className="ui-zoom-name">Максимальный масштаб</span>
              <span className="ui-zoom-desc">Насколько близко можно приблизить холст</span>
              <span className="ui-zoom-input">
                <input
                  type="text"
                  inputMode="decimal"
                  value={zmax}
                  aria-label="Максимальный масштаб холста"
                  onChange={(e) => setZmax(e.target.value)}
                />
                <span className="ui-zoom-pct">= {Math.round((parse(zmax) || 0) * 100)}%</span>
              </span>
            </label>
          </div>
          <div className="set-foot-row">
            <button
              type="button"
              className="btn primary"
              disabled={!!invalid}
              title={invalid || 'Применить пределы масштаба'}
              onClick={() => {
                const lo = parse(zmin);
                const hi = parse(zmax);
                if (lo !== null && hi !== null) apply(lo, hi);
              }}
            >
              Применить
            </button>
            <button
              type="button"
              className="btn"
              title="Вернуть значения по умолчанию (10% … 300%)"
              onClick={() => apply(0.1, 3)}
            >
              Сбросить
            </button>
            {msg && <span className={'set-store-msg' + (msg.cls ? ' ' + msg.cls : '')}>{msg.t}</span>}
          </div>
        </div>
        <div className="dlg-modal-foot">
          <button type="button" className="btn" onClick={() => store.openModal('settings')}>← Назад</button>
          <button type="button" className="btn primary" onClick={() => store.closeModal()}>Готово</button>
        </div>
      </div>
    </div>
  );
}

function comboOf(e: KeyboardEvent): string {
  const p: string[] = [];
  if (e.ctrlKey || e.metaKey) p.push('Mod');
  if (e.altKey) p.push('Alt');
  if (e.shiftKey) p.push('Shift');
  let code = e.code;
  if (!code) {
    const k = (e.key || '').toLowerCase();
    code = /^[0-9]$/.test(k) ? 'Digit' + k : (/^[a-z]$/.test(k) ? 'Key' + k.toUpperCase() : k);
  }
  p.push(code);
  return p.join('+');
}

function StoreModal({ store }: { store: VetviStore }) {
  const [mode, setMode] = useState<'ls' | 'idb'>(storeMode());
  const [msg, setMsg] = useState<{ t: string; cls: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [idbSize, setIdbSize] = useState<number | null>(null);
  const [, tick] = useState(0);

  useEffect(() => {
    if (storeMode() === 'ls') {
      void idbReadAll().then((all) => {
        let total = 0;
        for (const k of Object.keys(all)) total += storeSizeOf(k, all[k]);
        setIdbSize(total);
      });
    }
  }, []);

  const lsUsage = storeLsUsage();
  const dataUsage = Object.entries(storeCollectData()).reduce((s, [k, v]) => s + storeSizeOf(k, v), 0);

  return (
    <div className="dlg-modal sub show" role="dialog" aria-label="Настройки — Хранилище данных">
      <div className="dlg-modal-card set-card">
        <div className="dlg-modal-head">
          <span className="dlg-modal-title">Настройки — Хранилище данных</span>
          <button type="button" className="dlg-modal-close" title="Закрыть" onClick={() => store.closeModal()}>×</button>
        </div>
        <div className="dlg-modal-body">
          <div className="set-hint">При переключении данные копируются в другое хранилище, и страница перезагружается.</div>
          <div className={'set-store-opt' + (mode === 'ls' ? ' sel' : '')} role="button" tabIndex={0} onClick={() => { setMode('ls'); tick((t) => t + 1); }}>
            <span className="set-radio" />
            <span className="set-store-info">
              <span className="set-store-name">LocalStorage{storeMode() === 'ls' ? <em className="set-cur">— текущий</em> : null}</span>
              <span className="set-store-desc">Классическое хранилище браузера. Ограничено ~5 МБ</span>
              <span className="set-store-size">Занято: {storeFmtSize(lsUsage)} из ~{storeFmtSize(LS_LIMITS.bytes)}{dataUsage ? ' · данных приложения: ' + storeFmtSize(dataUsage) : ''}</span>
              <span className={'set-store-bar' + (lsUsage / LS_LIMITS.bytes > 0.8 ? ' warn' : '')}>
                <i style={{ width: Math.min(100, (lsUsage / LS_LIMITS.bytes) * 100) + '%' }} />
              </span>
            </span>
          </div>
          <div className={'set-store-opt' + (mode === 'idb' ? ' sel' : '')} role="button" tabIndex={0} onClick={() => { setMode('idb'); tick((t) => t + 1); }}>
            <span className="set-radio" />
            <span className="set-store-info">
              <span className="set-store-name">IndexedDB{storeMode() === 'idb' ? <em className="set-cur">— текущий</em> : null}</span>
              <span className="set-store-desc">База данных браузера. Практически без ограничений по объёму — рекомендуется</span>
              <span className="set-store-size">{idbSize === null ? (storeMode() === 'ls' ? 'Занято: измеряем…' : '') : idbSize ? 'Занято: ' + storeFmtSize(idbSize) : 'Хранилище пока пустое'}</span>
            </span>
          </div>
          <div className="set-foot-row">
            <button
              type="button"
              className="btn primary"
              disabled={busy || mode === storeMode()}
              onClick={async () => {
                setBusy(true);
                setMsg({ t: 'Копирую данные…', cls: '' });
                const err = await storeSwitch(mode);
                setBusy(false);
                if (err) { setMsg({ t: err, cls: 'err' }); return; }
                setMsg({ t: 'Данные перенесены — страница перезагрузится…', cls: 'ok' });
                store.toast('Хранилище переключено', 'ok');
                setTimeout(() => window.location.reload(), 800);
              }}
            >
              {mode === storeMode() ? 'Сейчас используется этот вариант' : 'Переключить на ' + (mode === 'idb' ? 'IndexedDB' : 'LocalStorage')}
            </button>
            {msg && <span className={'set-store-msg' + (msg.cls ? ' ' + msg.cls : '')}>{msg.t}</span>}
          </div>
          <div className="set-reload-note">Переносятся все ключи «vetvi-*» (проекты, автосейв, копии, личность). Настройки интерфейса остаются в LocalStorage.</div>
        </div>
        <div className="dlg-modal-foot">
          <button type="button" className="btn" onClick={() => store.openModal('settings')}>← Назад</button>
          <button type="button" className="btn primary" onClick={() => store.closeModal()}>Готово</button>
        </div>
      </div>
    </div>
  );
}

/* хост всех модалок по store.modal */
export function ModalHost({ store }: { store: VetviStore }) {
  void store.revision;
  switch (store.modal) {
    case 'search': return <SearchModal store={store} />;
    case 'log': return <LogModal store={store} />;
    case 'patch': return <PatchModal store={store} />;
    case 'projects': return <ProjectsModal store={store} />;
    case 'groupCreate': return <GroupCreateModal store={store} />;
    case 'settings': return <SettingsModal store={store} section="hub" />;
    case 'settingsHk': return <SettingsModal store={store} section="hk" />;
    case 'settingsStore': return <SettingsModal store={store} section="store" />;
    case 'settingsUi': return <SettingsModal store={store} section="ui" />;
    case 'share': return <ShareModal store={store} />;
    case 'passSet': return <PassSetModal store={store} />;
    case 'passRemove': return <PassRemoveModal store={store} />;
    case 'roomPass': return <RoomPassModal store={store} />;
    case 'copies': return <CopiesModal store={store} />;
    case 'copyBar': return <CopyBarModal store={store} />;
    case 'merge': return <MergeModal store={store} />;
    case 'syncDiff': return <SyncDiffModal store={store} />;
    case 'renameMe': return <RenameMeModal store={store} />;
    case 'typeEditor': return <TypeEditorModal store={store} id={store.modalArg} />;
    case 'textsImport': return <TextsImportModal store={store} />;
    default: return null;
  }
}
