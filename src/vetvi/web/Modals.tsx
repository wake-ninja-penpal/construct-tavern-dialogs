'use client';

/**
 * Ветви — модальные окна (этап 2): поиск по проекту (400 мс debounce, подсветка,
 * переход с миганием реплики), журнал действий (diff-записи, поиск 300 мс,
 * фильтр ноды/группы, откат проекта, показ на холсте), патчноут (версии+фильтр),
 * менеджер проектов (открыть/создать/переименовать/удалить/импорт), настройки
 * (хаб + горячие клавиши с перезахватом + хранилище LS/IDB), подтверждение,
 * создание группы из выделения.
 */

import { useEffect, useMemo, useRef, useState } from 'react';

import { APP_VERSION, PATCHNOTES, PATCH_TAGS } from '@/vetvi/core/patchnotes';
import { SECTION_TITLES } from '@/vetvi/core/logdiff';
import { looksLikeProject, projFmtDate, projList, readJsonFile } from '@/vetvi/core/projects';
import { LS_LIMITS, storeFmtSize, storeLsUsage, storeMode, storeSwitch, idbReadAll, storeSizeOf, storeCollectData } from '@/vetvi/core/storage';
import { hkConflict, hkDef, hkHuman, hkLoad, hkResetAll, hkSetUser, hkText, hkUserOverrides, HK_DEFS } from '@/vetvi/core/hotkeys';
import { condText } from '@/vetvi/core/vars';
import { STATUS_RU, TYPES } from '@/vetvi/core/constants';
import type { VetviNode } from '@/vetvi/core/types';
import type { LogEntry, VetviStore } from './store';
import { TypeIcon } from './NodeCard';
import { CopiesModal, CopyBarModal, MergeModal, PassRemoveModal, PassSetModal, RenameMeModal, RoomPassModal, ShareModal } from './SyncModals';

/* ═══════════ общий каркас ═══════════ */

export function ModalShell(props: { title: string; onClose: () => void; children: React.ReactNode; foot?: React.ReactNode; wide?: boolean; cardClass?: string }) {
  return (
    <div className="rn-modal show" onClick={(e) => { if (e.target === e.currentTarget) props.onClose(); }} role="dialog" aria-label={props.title}>
      <div className={'rn-modal-card' + (props.wide ? ' wide' : '') + (props.cardClass ? ' ' + props.cardClass : '')}>
        <div className="rn-modal-head">
          <span className="rn-modal-title">{props.title}</span>
          <button type="button" className="rn-modal-close" title="Закрыть" onClick={props.onClose}>×</button>
        </div>
        {props.children}
        {props.foot !== undefined ? (
          <div className="rn-modal-foot">{props.foot}</div>
        ) : (
          <div className="rn-modal-foot">
            <button type="button" className="rn-btn primary" onClick={props.onClose}>Закрыть</button>
          </div>
        )}
      </div>
    </div>
  );
}

export function SearchBar(props: { placeholder: string; onChange: (v: string) => void; autoFocus?: boolean; onEnter?: () => void; onEsc?: () => void }) {
  return (
    <div className="rn-searchbar">
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><circle cx="11" cy="11" r="6.5" /><path d="m16 16 4.5 4.5" /></svg>
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

/* ═══════════ поиск по проекту ═══════════ */

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

  return (
    <ModalShell title="Поиск по проекту" onClose={() => store.closeModal()} wide>
      <div className="rn-modal-body">
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
        <div className="rn-search-hint">{stats || 'Введите минимум два символа — поиск идёт по всем нодам проекта'}</div>
        <div className="rn-search-results">
          {results.map(({ n, hits, more }) => (
            <div className="rn-hitnode" key={n.id}>
              <button type="button" className="rn-hitnode-head" onClick={() => go(n.id)}>
                <span className="rn-hit-ico" style={{ color: n.color || TYPES[n.type]?.color }}><TypeIcon type={n.type} /></span>
                <span className="rn-hit-title">{n.title || TYPES[n.type]?.name}</span>
                <span className="rn-hit-type">{TYPES[n.type]?.name || n.type}</span>
              </button>
              {hits.map((h, i) => (
                <button type="button" className="rn-hit" key={i} onClick={() => go(n.id, h.rid)}>
                  <span className="rn-hit-kind">{h.kind}</span>
                  <span className="rn-hit-frag"><Mark text={h.frag} q={applied} /></span>
                </button>
              ))}
              {more > 0 && <div className="rn-hit-more">ещё совпадений: {more}</div>}
            </div>
          ))}
          {applied.length >= 2 && !results.length && <div className="rn-pane-hint">Ничего не найдено по «{applied}»</div>}
        </div>
      </div>
      <div className="rn-modal-foot">
        <span className="rn-foot-info">Enter — к первой находке · Esc — закрыть</span>
        <button type="button" className="rn-btn primary" onClick={() => store.closeModal()}>Закрыть</button>
      </div>
    </ModalShell>
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

/* ═══════════ журнал действий ═══════════ */

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

  const filterName = store.logFilterNode ? (store.nodeById(store.logFilterNode)?.title || '…') : store.logFilterGroup ? (store.groupById(store.logFilterGroup)?.name || '…') : null;

  return (
    <ModalShell
      title={filterName ? 'Журнал: «' + filterName + '»' : 'Журнал действий'}
      onClose={() => { store.setLogFilters(null, null); store.closeModal(); }}
      wide
      cardClass="rn-log-card"
      foot={
        <>
          <span className="rn-foot-info">записей: {filtered.length}{filterName ? ' · объект удалён' : ''}</span>
          {filterName && (
            <button type="button" className="rn-mini" onClick={() => store.setLogFilters(null, null)}>Все записи</button>
          )}
          <button type="button" className="rn-btn primary" onClick={() => { store.setLogFilters(null, null); store.closeModal(); }}>Готово</button>
        </>
      }
    >
      <div className="rn-modal-body">
        <SearchBar
          autoFocus
          placeholder="Поиск по журналу: действие, автор, объект, дата…"
          onChange={setQ}
          onEsc={() => { if (q) setQ(''); else { store.setLogFilters(null, null); store.closeModal(); } }}
        />
        <div className="rn-log-list">
          {filtered.map((e) => (
            <div className="rn-log-row" key={e.id}>
              <button type="button" className="rn-log-head" onClick={() => setOpenId(openId === e.id ? null : e.id)}>
                <span className="rn-log-when">{fmtWhen(new Date(e.t).toISOString())}</span>
                <span className="rn-log-dot" style={{ background: e.by?.color || '#8b929c' }} />
                <span className="rn-log-who">{e.by?.name || '?'}</span>
                <span className="rn-log-act"><Mark text={e.act} q={applied} /></span>
              </button>
              {openId === e.id && (
                <div className="rn-log-det">
                  {e.diff && e.diff.sections.map((sec) => (
                    <div className="rn-log-sec" key={sec.key}>
                      <div className="rn-log-sec-h">{SECTION_TITLES[sec.key] || sec.key}{sec.items.length > 1 ? ' (' + sec.items.length + ')' : ''}</div>
                      {sec.items.slice(0, 8).map((it) => (
                        <div className="rn-log-item" key={it.id}>
                          <span className="rn-log-item-name">{it.name}</span>
                          {it.fields.map((f, fi) => (
                            <div className="rn-log-field" key={fi}>
                              <i>{f.k}:</i>
                              <s>{f.a || '—'}</s>
                              <em>→</em>
                              <b>{f.b || '—'}</b>
                            </div>
                          ))}
                        </div>
                      ))}
                      {sec.items.length > 8 && <div className="rn-hit-more">… ещё {sec.items.length - 8}</div>}
                    </div>
                  ))}
                  {!e.diff && <div className="rn-insp-hint">Детали недоступны для этой записи.</div>}
                  <div className="rn-log-btns">
                    <button type="button" className="rn-mini" onClick={() => {
                      const ids = e.diff?.ids || [];
                      if (ids.length && store.nodeById(ids[0])) {
                        store.closeModal();
                        store.selectOnly(ids[0]);
                        store.requestCenter(ids[0]);
                      } else {
                        store.toast('Объекты записи не найдены на холсте', 'warn');
                      }
                    }}>Показать на холсте</button>
                    {e.snap && (
                      <button type="button" className="rn-mini" onClick={() => {
                        store.rollbackToSnapshot(e.snap as string);
                        store.toast('Проект откатлен к моменту записи', 'ok');
                        store.closeModal();
                      }}>Откатить проект к этому моменту</button>
                    )}
                    {!e.snap && <span className="rn-log-nosnap">Снимок состояния недоступен: запись старая, от другого участника, или снимок вытеснен более новыми.</span>}
                  </div>
                </div>
              )}
            </div>
          ))}
          {!filtered.length && <div className="rn-pane-hint">{applied ? 'По «' + applied + '» в журнале ничего нет' : 'Журнал пуст — правьте холст, и записи появятся здесь.'}</div>}
        </div>
      </div>
    </ModalShell>
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

/* ═══════════ патчноут ═══════════ */

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
    <ModalShell
      title="Что нового — патчноут"
      onClose={() => store.closeModal()}
      cardClass="rn-patch-card"
      foot={
        <>
          <span className="rn-foot-info">Текущая версия: v{APP_VERSION}</span>
          <button type="button" className="rn-btn primary" onClick={() => store.closeModal()}>Закрыть</button>
        </>
      }
    >
      <div className="rn-modal-body">
        <SearchBar placeholder="Фильтр журнала: текст записи или версия…" onChange={setQ} />
        <div className="rn-patch-body">
          {list.map(({ v, items }, i) => (
            <div className="rn-patch-ver" key={v.ver}>
              <div className="rn-patch-verhead">
                <span className="rn-patch-v">v{v.ver}</span>
                {i === 0 && !applied && <span className="rn-patch-latest">актуально</span>}
              </div>
              {items.map((it, k) => (
                <div className="rn-patch-item" key={k}>
                  <span className={'rn-patch-tag ' + it.k}>{PATCH_TAGS[it.k] || it.k}</span>
                  <span>{it.t}</span>
                </div>
              ))}
              {applied && !items.length && <div className="rn-patch-item"><span className="rn-patch-tag chg">версия</span><span>совпадений в этой версии нет</span></div>}
            </div>
          ))}
          {applied && !list.length && <div className="rn-pane-hint">По «{applied}» в журнале ничего нет</div>}
        </div>
      </div>
    </ModalShell>
  );
}

/* ═══════════ менеджер проектов ═══════════ */

export function ProjectsModal({ store }: { store: VetviStore }) {
  const [, tick] = useState(0);
  const cur = String(store.doc.meta.projectId || '');
  const impRef = useRef<HTMLInputElement>(null);
  const renRef = useRef<{ id: string; val: string } | null>(null);
  const [ren, setRen] = useState<{ id: string; val: string } | null>(null);

  const list = projList();
  const refresh = () => tick((t) => t + 1);

  return (
    <ModalShell title="Мои проекты" onClose={() => store.closeModal()} wide>
      <div className="rn-modal-body">
        <div className="rn-proj-list">
          {list.map((e) => (
            <div className={'rn-proj-row' + (e.id === cur ? ' cur' : '')} key={e.id}>
              {ren && ren.id === e.id ? (
                <input
                  autoFocus
                  maxLength={80}
                  value={ren.val}
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
                <button type="button" className="rn-proj-open" onClick={() => { store.openProject(e.id); store.closeModal(); }}>
                  <span className="rn-proj-name">{e.name}{e.id === cur && store.syncMode !== 'copy' ? ' · текущий' : ''}</span>
                  <span className="rn-proj-meta">{projFmtDate(e.modified || e.at)} · {e.nodes ?? 0} узл.{e.roomId ? ' · комната' : ''}</span>
                </button>
              )}
              <button type="button" className="rn-proj-act" title="Переименовать" onClick={() => setRen({ id: e.id, val: e.name })}>✎</button>
              <button
                type="button"
                className="rn-proj-act danger"
                title="Удалить"
                onClick={() => {
                  const last = list.length <= 1;
                  store.confirmBox({
                    title: 'Удалить проект?',
                    text: '<p>«' + e.name + '» будет удалён с этого устройства безвозвательно.</p>',
                    buttons: [
                      { label: 'Отмена', primary: true },
                      { label: 'Удалить', danger: true, fn: () => { store.deleteProject(e.id); refresh(); } },
                    ],
                  });
                  void last;
                }}
              >🗑</button>
            </div>
          ))}
          {!list.length && <div className="rn-pane-hint">Пока нет проектов — создайте первый.</div>}
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
      </div>
      <div className="rn-modal-foot">
        <button type="button" className="rn-btn" onClick={() => { store.createProject(); store.closeModal(); }}>+ Новый проект</button>
        <button type="button" className="rn-btn" onClick={() => impRef.current?.click()}>Импорт из файла…</button>
        <button type="button" className="rn-btn primary" onClick={() => store.closeModal()}>Закрыть</button>
      </div>
    </ModalShell>
  );
}

/* ═══════════ подтверждение ═══════════ */

export function ConfirmHost({ store }: { store: VetviStore }) {
  const cfg = store.confirm;
  if (!cfg) return null;
  return (
    <div className="rn-modal show top" onClick={(e) => { if (e.target === e.currentTarget) store.closeConfirm(); }} role="alertdialog" aria-label={cfg.title}>
      <div className={'rn-modal-card' + (cfg.wide ? ' wide' : '')}>
        <div className="rn-modal-head">
          <span className="rn-modal-title">{cfg.title}</span>
        </div>
        <div className="rn-modal-body">
          {cfg.text && <div className="rn-confirm-text" dangerouslySetInnerHTML={{ __html: cfg.text }} />}
        </div>
        <div className="rn-modal-foot">
          {(cfg.buttons || [{ label: 'Отмена', primary: true }]).map((b, i) => (
            <button
              key={i}
              type="button"
              className={'rn-btn' + (b.primary ? ' primary' : '') + (b.danger ? ' danger' : '')}
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

/* ═══════════ создание группы из выделения ═══════════ */

export function GroupCreateModal({ store }: { store: VetviStore }) {
  const [name, setName] = useState('Группа');
  return (
    <ModalShell title="Сгруппировать выделение" onClose={() => store.closeModal()} foot={
      <>
        <button type="button" className="rn-btn" onClick={() => store.closeModal()}>Отмена</button>
        <button type="button" className="rn-btn primary" onClick={() => {
          const gid = store.createGroupFromSel(name.trim());
          store.closeModal();
          if (gid) store.toast('Группа создана · элементов: ' + (store.membersOf(gid).length), 'ok');
        }}>Создать</button>
      </>
    }>
      <div className="rn-modal-body">
        <label className="rn-field">
          <span>Название группы</span>
          <input
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
        </label>
        <div className="rn-insp-hint">Выделенные группы станут вложенными; ноды вне выделенных групп войдут в новую.</div>
      </div>
    </ModalShell>
  );
}

/* ═══════════ настройки: хаб + горячие клавиши + хранилище ═══════════ */

export function SettingsModal({ store, section }: { store: VetviStore; section: 'hub' | 'hk' | 'store' }) {
  if (section === 'hk') return <HkModal store={store} />;
  if (section === 'store') return <StoreModal store={store} />;
  return (
    <ModalShell title="Настройки проекта" onClose={() => store.closeModal()}>
      <div className="rn-modal-body">
        <div className="rn-insp-hint">Каждый раздел открывается в отдельном окне — выберите нужный.</div>
        <button type="button" className="rn-set-item" onClick={() => store.openModal('settingsStore')}>
          <span className="rn-set-ico">🗄</span>
          <span className="rn-set-info">
            <span className="rn-set-name">Хранилище данных</span>
            <span className="rn-set-desc">LocalStorage или IndexedDB: занятое место и переключение режима</span>
          </span>
          <span className="rn-set-go">→</span>
        </button>
        <button type="button" className="rn-set-item" onClick={() => store.openModal('settingsHk')}>
          <span className="rn-set-ico">⌨</span>
          <span className="rn-set-info">
            <span className="rn-set-name">Горячие клавиши</span>
            <span className="rn-set-desc">Список действий и переназначение сочетаний</span>
          </span>
          <span className="rn-set-go">→</span>
        </button>
      </div>
    </ModalShell>
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
    <ModalShell title="Настройки — Горячие клавиши" onClose={() => store.closeModal()} foot={
      <>
        <button type="button" className="rn-btn" onClick={() => store.openModal('settings')}>← Назад</button>
        <button type="button" className="rn-btn primary" onClick={() => store.closeModal()}>Готово</button>
      </>
    }>
      <div className="rn-modal-body">
        <SearchBar autoFocus placeholder="Фильтр по названию действия или клавишам…" onChange={setFilter} />
        <div className="rn-hk-list">
          {list.map((d) => {
            const isUser = !!hkUserOverrides()[d.id];
            return (
              <div className={'rn-hk-row' + (cap === d.id ? ' cap' : '')} key={d.id}>
                <span className="rn-hk-name">{d.name}</span>
                {cap === d.id ? (
                  <span className="rn-hk-keys wait">нажмите сочетание…</span>
                ) : (
                  <span className="rn-hk-keys"><kbd>{hkHuman(hkText2(d.id))}</kbd>{isUser && <i className="rn-hk-flag" title="Значение изменено вручную">своё</i>}</span>
                )}
                <span className="rn-hk-acts">
                  {cap !== d.id && (
                    <>
                      <button type="button" className="rn-mini" onClick={() => { setCap(d.id); setMsg(null); }}>Изменить</button>
                      {isUser && (
                        <button type="button" className="rn-mini" title="Вернуть по умолчанию" onClick={() => {
                          hkSetUser(d.id, null);
                          setMsg({ t: '«' + d.name + '» — по умолчанию ' + hkHuman(d.def), cls: 'ok' });
                          tick((t) => t + 1);
                        }}>↺</button>
                      )}
                    </>
                  )}
                  {cap === d.id && <button type="button" className="rn-mini" onClick={() => { setCap(null); setMsg({ t: 'Захват отменён', cls: '' }); }}>Отмена</button>}
                </span>
              </div>
            );
          })}
          {!list.length && <div className="rn-pane-hint">Ничего не найдено по «{filter.trim()}»</div>}
        </div>
        <div className="rn-foot-row">
          <button type="button" className="rn-mini" onClick={() => { hkResetAll(); setMsg({ t: 'Все горячие клавиши возвращены к значениям по умолчанию', cls: 'ok' }); tick((t) => t + 1); }}>Сбросить все</button>
          {msg && <span className={'rn-store-msg ' + msg.cls}>{msg.t}</span>}
        </div>
      </div>
    </ModalShell>
  );
}

function hkText2(id: string): string {
  return hkText(id);
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
  const [msg, setMsg] = useState('');
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
    <ModalShell title="Настройки — Хранилище данных" onClose={() => store.closeModal()} foot={
      <>
        <button type="button" className="rn-btn" onClick={() => store.openModal('settings')}>← Назад</button>
        <button
          type="button"
          className="rn-btn primary"
          disabled={busy || mode === storeMode()}
          onClick={async () => {
            setBusy(true);
            setMsg('Копирую данные…');
            const err = await storeSwitch(mode);
            setBusy(false);
            if (err) { setMsg(err); return; }
            setMsg('Данные перенесены — страница перезагрузится…');
            store.toast('Хранилище переключено', 'ok');
            setTimeout(() => window.location.reload(), 800);
          }}
        >
          {mode === storeMode() ? 'Сейчас используется этот вариант' : 'Переключить на ' + (mode === 'idb' ? 'IndexedDB' : 'LocalStorage')}
        </button>
      </>
    }>
      <div className="rn-modal-body">
        <div className="rn-insp-hint">При переключении данные копируются в другое хранилище, и страница перезагружается.</div>
        <button type="button" className={'rn-store-opt' + (mode === 'ls' ? ' sel' : '')} onClick={() => { setMode('ls'); tick((t) => t + 1); }}>
          <span className="rn-radio" />
          <span className="rn-store-info">
            <span className="rn-store-name">LocalStorage{mode === 'ls' ? <em className="rn-cur"> — выбрано</em> : storeMode() === 'ls' ? <em className="rn-cur"> — текущий</em> : null}</span>
            <span className="rn-store-desc">Классическое хранилище браузера. Ограничено ~5 МБ</span>
            <span className="rn-store-size">Занято: {storeFmtSize(lsUsage)} из ~{storeFmtSize(LS_LIMITS.bytes)}{dataUsage ? ' · данных приложения: ' + storeFmtSize(dataUsage) : ''}</span>
            <span className="rn-store-bar"><i style={{ width: Math.min(100, (lsUsage / LS_LIMITS.bytes) * 100) + '%', background: lsUsage / LS_LIMITS.bytes > 0.8 ? '#cf6d4f' : undefined }} /></span>
          </span>
        </button>
        <button type="button" className={'rn-store-opt' + (mode === 'idb' ? ' sel' : '')} onClick={() => { setMode('idb'); tick((t) => t + 1); }}>
          <span className="rn-radio" />
          <span className="rn-store-info">
            <span className="rn-store-name">IndexedDB{mode === 'idb' ? <em className="rn-cur"> — выбрано</em> : storeMode() === 'idb' ? <em className="rn-cur"> — текущий</em> : null}</span>
            <span className="rn-store-desc">База данных браузера. Практически без ограничений по объёму — рекомендуется</span>
            <span className="rn-store-size">{idbSize === null ? (storeMode() === 'ls' ? 'Занято: измеряем…' : '') : idbSize ? 'Занято: ' + storeFmtSize(idbSize) : 'Хранилище пока пустое'}</span>
          </span>
        </button>
        {msg && <div className="rn-store-msg">{msg}</div>}
        <div className="rn-insp-hint dim">Переносятся все ключи «vetvi-*» (проекты, автосейв, копии, личность). Настройки интерфейса остаются в LocalStorage.</div>
      </div>
    </ModalShell>
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
    case 'share': return <ShareModal store={store} />;
    case 'passSet': return <PassSetModal store={store} />;
    case 'passRemove': return <PassRemoveModal store={store} />;
    case 'roomPass': return <RoomPassModal store={store} />;
    case 'copies': return <CopiesModal store={store} />;
    case 'copyBar': return <CopyBarModal store={store} />;
    case 'merge': return <MergeModal store={store} />;
    case 'renameMe': return <RenameMeModal store={store} />;
    default: return null;
  }
}


