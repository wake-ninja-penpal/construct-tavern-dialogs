'use client';

/**
 * Ветви — UI совместного редактирования (порт sync-окон оригинала).
 *
 * Разметка 1:1 с showModal/#modalWrap оригинала: .m-card(.wide) > h3 + контент
 * (.i-lab+.inp, .share-link/.share-pass, .sp-cap/.sp-st/.sp-acts, .cpy-item,
 * .mrg-item) + .m-btns (.btn/.primary/.danger). Плюс непанельные элементы:
 * попап участников #collabPop (.cp-*), экран пароля .lock-wrap/.lock-card
 * (lockWrap), подсказка «объект используется другим пользователем» #lockTip.
 * Поведение 1:1 с классической версией.
 */

import { useEffect, useRef, useState } from 'react';

import { getMe } from '@/vetvi/core/identity';
import { copiesAll, syncFmtDate, type MergeRequest } from './sync';
import type { VetviStore } from './store';

/* svg-иконки оригинала (ic()): контур 24×24, stroke currentColor */
const ICONS: Record<string, React.ReactNode> = {
  trash: <><path d="M4 7h16M9 7V4h6v3M6.5 7l1 13h9l1-13M10 11v5M14 11v5" /></>,
  copy: <><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V6a2 2 0 0 1 2-2h9" /></>,
  target: <><circle cx="12" cy="12" r="7" /><path d="M12 2v4M12 18v4M2 12h4M18 12h4" /></>,
  pencil: <><path d="m4 20 1-4L16.3 4.7a2.1 2.1 0 0 1 3 3L8 19z" /><path d="M14.5 6.5l3 3" /></>,
  x: <path d="M6 6l12 12M18 6 6 18" />,
  rback: <><path d="M9 14 4 9l5-5" /><path d="M4 9h10.5A5.5 5.5 0 0 1 20 14.5v1" /><path d="M4 20h6" /></>,
};

function Ic(props: { name: string; size: number }) {
  return (
    <svg viewBox="0 0 24 24" width={props.size} height={props.size} fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">
      {ICONS[props.name] || null}
    </svg>
  );
}

/* ═══════════ общий каркас (= showModal/#modalWrap оригинала) ═══════════ */

function SyncShell(props: { title: string; onClose: () => void; children: React.ReactNode; foot: React.ReactNode; wide?: boolean }) {
  return (
    <div id="modalWrap" className="show" role="dialog" aria-label={props.title} onPointerDown={(e) => { if ((e.target as HTMLElement).id === 'modalWrap') props.onClose(); }}>
      <div className={'m-card' + (props.wide ? ' wide' : '')}>
        <h3>{props.title}</h3>
        {props.children}
        <div className="m-btns">{props.foot}</div>
      </div>
    </div>
  );
}

/* ═══════════ «Совместный доступ» (shareProject → showShareModal) ═══════════ */

export function ShareModal({ store }: { store: VetviStore }) {
  const inpRef = useRef<HTMLInputElement>(null);
  void store.revision;
  const sc = store.sync;
  const u = sc ? sc.shareUrl() : '';
  const meta = store.doc.meta as unknown as { passHash?: string };
  const pwSet = !!(meta && meta.passHash);
  useEffect(() => { if (!u) store.toast('Комната ещё не открыта', 'warn'); }, []);
  /* showShareModal оригинала выделяет ссылку сразу после открытия */
  useEffect(() => {
    const tm = window.setTimeout(() => { if (inpRef.current) inpRef.current.select(); }, 80);
    return () => window.clearTimeout(tm);
  }, []);
  return (
    <SyncShell title="Совместный доступ" onClose={() => store.closeModal()} foot={<button type="button" className="btn primary" onClick={() => store.closeModal()}>Готово</button>}>
      <p>Отправьте эту ссылку соавторам — они смогут редактировать проект вместе с вами в реальном времени.</p>
      <div className="share-link">
        <input ref={inpRef} readOnly value={u} onClick={(e) => (e.currentTarget as HTMLInputElement).select()} aria-label="Ссылка комнаты" />
        <button type="button" className="btn primary" title="Скопировать ссылку" onClick={() => sc && sc.copyShareLink()}><Ic name="copy" size={14} /></button>
      </div>
      <p style={{ fontSize: '11.5px', color: 'var(--tx3)', margin: '4px 0 0' }}>Проект хранится на сервере комнаты: соавторы смогут подключиться, даже если вы офлайн. Статус — индикатор в панели сверху.</p>
      <div className="share-pass">
        <div className="sp-cap">Пароль проекта</div>
        {pwSet ? (
          <>
            <div className="sp-st">Установлен — вход в комнату по паролю: новый участник введёт его при подключении по ссылке.</div>
            <div className="sp-acts">
              <button type="button" className="btn" onClick={() => sc && sc.passSetModal(true)}>Сменить…</button>
              <button type="button" className="btn" onClick={() => store.openModal('passRemove')}>Убрать</button>
            </div>
          </>
        ) : (
          <>
            <div className="sp-st">Не установлен — редактировать сможет любой, у кого есть ссылка.</div>
            <div className="sp-acts">
              <button type="button" className="btn" onClick={() => sc && sc.passSetModal(false)}>Задать пароль…</button>
            </div>
          </>
        )}
      </div>
    </SyncShell>
  );
}

/* ═══════════ пароль проекта: установка/смена (passSetModal) ═══════════ */

export function PassSetModal({ store }: { store: VetviStore }) {
  const sc = store.sync;
  const change = store.modalArg === 'change';
  const [cur, setCur] = useState('');
  const [a, setA] = useState('');
  const [b, setB] = useState('');
  const needCur = change && !!(store.doc.meta as unknown as { passHash?: string }).passHash;
  const submit = () => {
    if (!sc) return;
    if (sc.passSetApply(cur, a, b, change)) store.closeModal();
  };
  return (
    <SyncShell
      title={change ? 'Сменить пароль проекта' : 'Пароль проекта'}
      onClose={() => store.closeModal()}
      foot={
        <>
          <button type="button" className="btn" onClick={() => store.closeModal()}>Отмена</button>
          <button type="button" className="btn primary" onClick={submit}>{change ? 'Сменить' : 'Установить'}</button>
        </>
      }
    >
      {needCur && (
        <>
          <label className="i-lab">Текущий пароль</label>
          <input type="password" className="inp" value={cur} autoComplete="off" style={{ marginBottom: 8 }} onChange={(e) => setCur(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } }} />
        </>
      )}
      <label className="i-lab">Новый пароль</label>
      <input type="password" className="inp" value={a} autoComplete="off" autoFocus onChange={(e) => setA(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } }} />
      <label className="i-lab" style={{ marginTop: 8 }}>Повторите новый пароль</label>
      <input type="password" className="inp" value={b} autoComplete="off" onChange={(e) => setB(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } }} />
      <p style={{ fontSize: '11px', color: 'var(--tx3)', margin: '8px 0 0' }}>Хранится только хэш (sha256 с солью) — сам пароль нигде не сохраняется. Локально проект попросит пароль при открытии, в комнате — при подключении по ссылке.</p>
    </SyncShell>
  );
}

/* ═══════════ пароль проекта: снятие (passRemoveModal) ═══════════ */

export function PassRemoveModal({ store }: { store: VetviStore }) {
  const sc = store.sync;
  const [cur, setCur] = useState('');
  const submit = () => {
    if (!sc) return;
    if (sc.passRemoveApply(cur)) store.closeModal();
  };
  return (
    <SyncShell
      title="Убрать пароль проекта"
      onClose={() => store.closeModal()}
      foot={
        <>
          <button type="button" className="btn" onClick={() => store.closeModal()}>Отмена</button>
          <button type="button" className="btn danger" onClick={submit}>Убрать пароль</button>
        </>
      }
    >
      <label className="i-lab">Текущий пароль</label>
      <input type="password" className="inp" value={cur} autoComplete="off" autoFocus onChange={(e) => setCur(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } }} />
      <p style={{ fontSize: '11px', color: 'var(--tx3)', margin: '8px 0 0' }}>Проект снова откроется без пароля, а комната станет доступной всем, у кого есть ссылка.</p>
    </SyncShell>
  );
}

/* ═══════════ ввод пароля комнаты (syncAskRoomPassword) ═══════════ */

export function RoomPassModal({ store }: { store: VetviStore }) {
  const sc = store.sync;
  const [v, setV] = useState('');
  const wrong = !!(sc && sc.pwPending && sc.pwPending.wrong);
  const submit = () => {
    if (!sc) return;
    if (!v) { store.toast('Введите пароль комнаты', 'warn'); return; }
    sc.submitRoomPassword(v);
  };
  return (
    <SyncShell
      title="Комната защищена паролем"
      onClose={() => { if (sc) sc.cancelRoomPassword(); }}
      foot={
        <>
          <button type="button" className="btn" onClick={() => { if (sc) sc.cancelRoomPassword(); }}>Отмена</button>
          <button type="button" className="btn primary" onClick={submit}>Войти</button>
        </>
      }
    >
      {wrong && <p style={{ color: '#cf6b5a', fontSize: '12px', margin: '0 0 8px' }}>Неверный пароль — попробуйте ещё раз.</p>}
      <label className="i-lab">Пароль комнаты</label>
      <input type="password" className="inp" value={v} autoComplete="off" autoFocus placeholder="пароль проекта" onChange={(e) => setV(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } }} />
    </SyncShell>
  );
}

/* ═══════════ локальные копии (copiesModalRender) ═══════════ */

export function CopiesModal({ store }: { store: VetviStore }) {
  void store.revision;
  const sc = store.sync;
  const [list, setList] = useState(() => copiesAll());
  useEffect(() => {
    if (!sc) return;
    sc.refreshMergeStatuses(() => setList(copiesAll()));
  }, [sc]);
  return (
    <SyncShell
      title="Локальные копии"
      wide
      onClose={() => store.closeModal()}
      foot={
        <>
          <button type="button" className="btn primary" onClick={() => { if (sc) { sc.makeCopy(); setList(copiesAll()); } }}>Сделать копию сейчас</button>
          <button type="button" className="btn" onClick={() => store.closeModal()}>Закрыть</button>
        </>
      }
    >
      {!list.length && (
        <p className="mrg-empty">Локальных копий пока нет. Создайте копию, чтобы работать офлайн и позже отправить изменения владельцу оригинала.</p>
      )}
      {list.map((c) => {
        const st = c.lastMergeId
          ? ({ applied: 'merge принят', rejected: 'merge отклонён', pending: 'merge ожидает' }[c.lastMergeStatus || 'pending'])
          : '';
        return (
          <div key={c.copyId} className={'cpy-item' + (c.copyId === (sc && sc.activeCopy) ? ' active' : '')}>
            <div className="cpy-name">
              <b>{c.name}</b>
              <span className="cpy-meta">
                {syncFmtDate(c.createdAt)}{c.sourceRoomId ? ' · из комнаты' : ' · локальный проект'}{c.copyId === (sc && sc.activeCopy) ? ' · открыта' : ''}
              </span>
            </div>
            {st && <span className={'mrg-status st-' + (c.lastMergeStatus || 'pending')}>{st}</span>}
            <div className="cpy-row-btns">
              <button type="button" className="btn" onClick={() => { if (sc) { store.closeModal(); sc.openCopyById(c.copyId); } }}>Открыть</button>
              <button type="button" className="btn danger" title="Удалить копию" onClick={() => { if (sc) { sc.deleteCopyById(c.copyId); setList(copiesAll()); } }}><Ic name="trash" size={13} /></button>
            </div>
          </div>
        );
      })}
    </SyncShell>
  );
}

/* ═══════════ режим копии (copyBarModal) ═══════════ */

export function CopyBarModal({ store }: { store: VetviStore }) {
  void store.revision;
  const sc = store.sync;
  const cp = sc ? sc.activeCopyObj() : null;
  if (!cp) return null;
  return (
    <SyncShell
      title="Режим копии"
      onClose={() => store.closeModal()}
      foot={
        <>
          <button type="button" className="btn primary" onClick={() => { if (sc) { sc.sendMerge(); } }}>Отправить merge</button>
          <button type="button" className="btn" onClick={() => { if (sc) { store.closeModal(); sc.exitCopyMode(true); } }}>Вернуться к оригиналу</button>
          <button type="button" className="btn" onClick={() => store.closeModal()}>Закрыть</button>
        </>
      }
    >
      <p>Вы редактируете <b>локальную копию</b> «{cp.name}». Оригинал не изменяется. Отправьте merge-запрос, чтобы владелец оригинала рассмотрел и принял ваши изменения.</p>
      <p style={{ fontSize: '11.5px', color: 'var(--tx3)' }}>{cp.sourceRoomId ? 'Оригинал: комната ' + cp.sourceRoomId.slice(0, 10) + '…' : 'Копия локального проекта (без комнаты).'}</p>
    </SyncShell>
  );
}

/* ═══════════ merge-запросы копий (mergeModal) ═══════════ */

export function MergeModal({ store }: { store: VetviStore }) {
  void store.revision;
  const sc = store.sync;
  const [list, setList] = useState<MergeRequest[]>([]);
  const [loaded, setLoaded] = useState(false);
  const reload = () => {
    if (!sc) return;
    sc.mergeRequests((res) => {
      setList((res && res.requests) || []);
      setLoaded(true);
    });
  };
  useEffect(() => { reload(); }, []);
  const chip = (v: number | undefined, label: string) => (v ? <span className="mrg-chip">{label}: {v}</span> : null);
  return (
    <SyncShell
      title="Merge-запросы копий"
      wide
      onClose={() => store.closeModal()}
      foot={
        <>
          <button type="button" className="btn" onClick={reload}>Обновить</button>
          <button type="button" className="btn primary" onClick={() => store.closeModal()}>Закрыть</button>
        </>
      }
    >
      {loaded && !list.length && <p className="mrg-empty">Merge-запросов пока нет. Копии проекта будут отправлять изменения сюда.</p>}
      {list.map((r) => {
        const s = r.stats || {} as Record<string, number>;
        return (
          <div key={r.id} className="mrg-item">
            <div className="mrg-top">
              <span className="mrg-dot" style={{ background: (r.sender && r.sender.color) || '#8b929c' }} />
              <b>{(r.sender && r.sender.name) || 'Гость'}</b>
              <span className="mrg-date">{syncFmtDate(r.createdAt)}</span>
              <span className={'mrg-status st-' + (r.status || 'pending')}>
                {r.status === 'pending' ? 'ожидает' : r.status === 'applied' ? 'принят' : 'отклонён'}
              </span>
            </div>
            <div className="mrg-stats">
              {chip(s.addedNodes, '+ узлов')}
              {chip(s.changedNodes, '~ узлов')}
              {chip(s.removedNodes, '− узлов')}
              {chip(s.changedDialogs, '~ реплик')}
              {chip(s.changedNotes, '~ заметок')}
              {chip(s.addedEdges, '+ связей')}
              {chip(s.changedEdges, '~ связей')}
              {chip(s.removedEdges, '− связей')}
              {chip(s.addedGroups, '+ групп')}
              {chip(s.changedGroups, '~ групп')}
            </div>
            {r.status === 'pending' && (
              <div className="mrg-acts">
                <button type="button" className="btn primary" onClick={() => { if (sc) { sc.decideMerge(r.id, 'apply'); setList((l) => l.map((x) => (x.id === r.id ? { ...x, status: 'applied' } : x))); } }}>Принять</button>
                <button type="button" className="btn danger" onClick={() => { if (sc) { sc.decideMerge(r.id, 'reject'); setList((l) => l.map((x) => (x.id === r.id ? { ...x, status: 'rejected' } : x))); } }}>Отклонить</button>
              </div>
            )}
          </div>
        );
      })}
    </SyncShell>
  );
}

/* ═══════════ смена имени участника (syncRenameModal) ═══════════ */

export function RenameMeModal({ store }: { store: VetviStore }) {
  const [v, setV] = useState(() => getMe().name);
  const submit = () => {
    const val = v.trim();
    if (!val) return;
    if (store.sync) store.sync.renameMe(val);
    store.closeModal();
  };
  return (
    <SyncShell
      title="Ваше имя в комнате"
      onClose={() => store.closeModal()}
      foot={
        <>
          <button type="button" className="btn" onClick={() => store.closeModal()}>Отмена</button>
          <button type="button" className="btn primary" onClick={submit}>Сохранить</button>
        </>
      }
    >
      <label className="i-lab">Имя участника</label>
      <input className="inp" value={v} maxLength={40} autoFocus onFocus={(e) => e.currentTarget.select()} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } }} />
    </SyncShell>
  );
}

/* ═══════════ попап участников (#collabPop / syncRenderPop) ═══════════ */

export function CollabPopover({ store }: { store: VetviStore }) {
  void store.revision;
  const sc = store.sync;
  if (!sc || !store.collabPop || !sc.enabled) return null;
  const me = getMe();
  const users = store.syncUsers || [];
  /* позиция — под чипом синхронизации (bindSyncUI оригинала) */
  let popStyle: React.CSSProperties = { position: 'fixed', top: 52, right: 8 };
  if (typeof document !== 'undefined') {
    const anchor = document.querySelector('.collab-chip');
    if (anchor) {
      const r = anchor.getBoundingClientRect();
      popStyle = { position: 'fixed', top: r.bottom + 8, right: Math.max(8, window.innerWidth - r.right), left: 'auto' };
    }
  }
  return (
    <div id="collabPop" className="collab-pop show" style={popStyle} role="dialog" aria-label="Участники комнаты">
      <div className="cp-cap">Участники комнаты</div>
      {!users.length && <div className="cp-row"><span className="cp-name">Пока только вы</span></div>}
      {users.map((u) => {
        const nid = store.syncFocus ? store.syncFocus[u.id] : null;
        const fnNode = nid ? store.nodeById(nid) : null;
        return (
          <div key={u.id} className={'cp-row' + (u.id === me.id ? ' me' : '')} title={fnNode ? 'Сейчас у «' + u.name + '»: нода «' + (fnNode.title || '…') + '»' : undefined}>
            <span className="cp-dot" style={{ background: u.color || '#8b929c' }} />
            <span className="cp-name">{u.name}{u.id === me.id ? ' (вы)' : ''}</span>
            {fnNode && (
              <>
                <span className="cp-node">{fnNode.title || '…'}</span>
                <button type="button" className="cp-go" title={'Перейти к ноде «' + (fnNode.title || '…') + '»'} onClick={(e) => { e.stopPropagation(); store.setCollabPop(false); sc.focusGo(u.id); }}><Ic name="target" size={13} /></button>
              </>
            )}
          </div>
        );
      })}
      <div className="cp-acts">
        {sc.status !== 'on' && (
          <button type="button" className="cp-act" onClick={() => { store.setCollabPop(false); sc.reconnect(); }}><Ic name="rback" size={13} />Переподключиться</button>
        )}
        <button type="button" className="cp-act" onClick={() => { store.setCollabPop(false); store.openModal('renameMe'); }}><Ic name="pencil" size={13} />Сменить имя</button>
        {sc.room && (
          <button type="button" className="cp-act" onClick={() => { store.setCollabPop(false); sc.copyShareLink(); }}><Ic name="copy" size={13} />Скопировать ссылку</button>
        )}
        <button type="button" className="cp-act" onClick={() => {
          store.setCollabPop(false);
          if (sc.mode === 'copy') sc.exitCopyPanel();
          else sc.disconnect();
        }}><Ic name="x" size={13} />{sc.mode === 'copy' ? 'Закрыть панель' : 'Выйти из комнаты'}</button>
      </div>
    </div>
  );
}

/* ═══════════ экран пароля запертого проекта (#lockWrap) ═══════════ */

export function LockScreen({ store }: { store: VetviStore }) {
  void store.revision;
  const [v, setV] = useState('');
  const [err, setErr] = useState('');
  if (!store.lockNeeded()) return null;
  const submit = () => {
    if (!v) { setErr('Введите пароль'); return; }
    if (!store.applyUnlock(v)) {
      setErr('Неверный пароль');
      setV('');
      return;
    }
    setErr('');
    setV('');
  };
  return (
    <div className="lock-wrap show" role="dialog" aria-label="Проект защищён паролем">
      <div className="lock-card">
        <span className="lock-ico">
          <svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
            <rect x="5" y="11" width="14" height="9" rx="2" />
            <path d="M8 11V8a4 4 0 0 1 8 0v3" />
            <path d="M12 14.5v2" />
          </svg>
        </span>
        <h3>Проект защищён паролем</h3>
        <div className="lock-name">{store.doc.meta.name || 'Без названия'}</div>
        <input
          type="password"
          className="inp"
          value={v}
          autoComplete="off"
          autoFocus
          placeholder="пароль проекта"
          aria-label="Пароль проекта"
          onChange={(e) => { setV(e.target.value); setErr(''); }}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } }}
        />
        <div className="lock-err">{err}</div>
        <button type="button" className="btn primary" onClick={submit}>Открыть проект</button>
      </div>
    </div>
  );
}

/* ═══════════ подсказка о чужой блокировке (#lockTip) ═══════════ */

export function LockTipHost({ store }: { store: VetviStore }) {
  void store.revision;
  const tip = store.lockTip;
  if (!tip) return null;
  const by = tip.by;
  const color = (by && by.color) || '#8b929c';
  return (
    <div id="lockTip" className="show" style={{ left: tip.x, top: tip.y }}>
      <span className="lt-dot" style={{ background: color, color }} />
      Объект используется другим пользователем{(by && by.name) ? ' — ' + by.name : ''}
    </div>
  );
}
