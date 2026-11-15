'use client';

/**
 * Ветви — UI совместного редактирования (этап 3 порта).
 *
 * Окна: «Совместный доступ» (ссылка + пароль проекта), задание/смена/снятие
 * пароля, ввод пароля комнаты, «Локальные копии» (создать/открыть/удалить),
 * «Режим копии» (merge/возврат), «Merge-запросы копий» (принять/отклонить),
 * смена имени участника. Плюс непанельные элементы: попап участников с
 * фокусами («перейти к ноде»), экран пароля запертого проекта (lockWrap),
 * подсказка «объект используется другим пользователем» (lockTip).
 * Поведение 1:1 с классической версией.
 */

import { useEffect, useState } from 'react';

import { getMe } from '@/vetvi/core/identity';
import { copiesAll, syncFmtDate, type MergeRequest } from './sync';
import type { VetviStore } from './store';
import { ModalShell } from './Modals';

/* ═══════════ «Совместный доступ» (shareProject → showShareModal) ═══════════ */

export function ShareModal({ store }: { store: VetviStore }) {
  void store.revision;
  const sc = store.sync;
  const u = sc ? sc.shareUrl() : '';
  const meta = store.doc.meta as unknown as { passHash?: string };
  const pwSet = !!(meta && meta.passHash);
  useEffect(() => { if (!u) store.toast('Комната ещё не открыта', 'warn'); }, []);
  return (
    <ModalShell title="Совместный доступ" onClose={() => store.closeModal()}>
      <div className="rn-share-body">
        <p className="rn-share-p">Отправьте эту ссылку соавторам — они смогут редактировать проект вместе с вами в реальном времени.</p>
        <div className="share-link">
          <input readOnly value={u} onClick={(e) => (e.currentTarget as HTMLInputElement).select()} aria-label="Ссылка комнаты" />
          <button type="button" className="rn-btn primary" title="Скопировать ссылку" onClick={() => sc && sc.copyShareLink()}>⧉</button>
        </div>
        <p className="rn-share-note">Проект хранится на сервере комнаты: соавторы смогут подключиться, даже если вы офлайн. Статус — индикатор в панели сверху.</p>
        <div className="share-pass">
          <div className="sp-cap">Пароль проекта</div>
          {pwSet ? (
            <>
              <div className="sp-st">Установлен — вход в комнату по паролю: новый участник введёт его при подключении по ссылке.</div>
              <div className="sp-acts">
                <button type="button" className="rn-btn" onClick={() => sc && sc.passSetModal(true)}>Сменить…</button>
                <button type="button" className="rn-btn" onClick={() => store.openModal('passRemove')}>Убрать</button>
              </div>
            </>
          ) : (
            <>
              <div className="sp-st">Не установлен — редактировать сможет любой, у кого есть ссылка.</div>
              <div className="sp-acts">
                <button type="button" className="rn-btn" onClick={() => sc && sc.passSetModal(false)}>Задать пароль…</button>
              </div>
            </>
          )}
        </div>
      </div>
    </ModalShell>
  );
}

/* ═══════════ пароль проекта: установка/смена ═══════════ */

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
    <ModalShell
      title={change ? 'Сменить пароль проекта' : 'Пароль проекта'}
      onClose={() => store.closeModal()}
      foot={
        <>
          <button type="button" className="rn-btn" onClick={() => store.closeModal()}>Отмена</button>
          <button type="button" className="rn-btn primary" onClick={submit}>{change ? 'Сменить' : 'Установить'}</button>
        </>
      }
    >
      <div className="rn-form">
        {needCur && (
          <label className="i-lab">Текущий пароль
            <input type="password" value={cur} autoComplete="off" onChange={(e) => setCur(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') submit(); }} />
          </label>
        )}
        <label className="i-lab">Новый пароль
          <input type="password" value={a} autoComplete="off" autoFocus onChange={(e) => setA(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') submit(); }} />
        </label>
        <label className="i-lab">Повторите новый пароль
          <input type="password" value={b} autoComplete="off" onChange={(e) => setB(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') submit(); }} />
        </label>
        <p className="rn-form-note">Хранится только хэш (sha256 с солью) — сам пароль нигде не сохраняется. Локально проект попросит пароль при открытии, в комнате — при подключении по ссылке.</p>
      </div>
    </ModalShell>
  );
}

/* ═══════════ пароль проекта: снятие ═══════════ */

export function PassRemoveModal({ store }: { store: VetviStore }) {
  const sc = store.sync;
  const [cur, setCur] = useState('');
  const submit = () => {
    if (!sc) return;
    if (sc.passRemoveApply(cur)) store.closeModal();
  };
  return (
    <ModalShell
      title="Убрать пароль проекта"
      onClose={() => store.closeModal()}
      foot={
        <>
          <button type="button" className="rn-btn" onClick={() => store.closeModal()}>Отмена</button>
          <button type="button" className="rn-btn danger" onClick={submit}>Убрать пароль</button>
        </>
      }
    >
      <div className="rn-form">
        <label className="i-lab">Текущий пароль
          <input type="password" value={cur} autoComplete="off" autoFocus onChange={(e) => setCur(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') submit(); }} />
        </label>
        <p className="rn-form-note">Проект снова откроется без пароля, а комната станет доступной всем, у кого есть ссылка.</p>
      </div>
    </ModalShell>
  );
}

/* ═══════════ ввод пароля комнаты ═══════════ */

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
    <ModalShell
      title="Комната защищена паролем"
      onClose={() => { if (sc) sc.cancelRoomPassword(); }}
      foot={
        <>
          <button type="button" className="rn-btn" onClick={() => { if (sc) sc.cancelRoomPassword(); }}>Отмена</button>
          <button type="button" className="rn-btn primary" onClick={submit}>Войти</button>
        </>
      }
    >
      <div className="rn-form">
        {wrong && <p className="rn-form-err">Неверный пароль — попробуйте ещё раз.</p>}
        <label className="i-lab">Пароль комнаты
          <input type="password" value={v} autoComplete="off" autoFocus placeholder="пароль проекта" onChange={(e) => setV(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } }} />
        </label>
      </div>
    </ModalShell>
  );
}

/* ═══════════ локальные копии ═══════════ */

export function CopiesModal({ store }: { store: VetviStore }) {
  void store.revision;
  const sc = store.sync;
  const [list, setList] = useState(() => copiesAll());
  useEffect(() => {
    if (!sc) return;
    sc.refreshMergeStatuses(() => setList(copiesAll()));
  }, [sc]);
  return (
    <ModalShell
      title="Локальные копии"
      wide
      onClose={() => store.closeModal()}
      foot={
        <>
          <button type="button" className="rn-btn primary" onClick={() => { if (sc) { sc.makeCopy(); setList(copiesAll()); } }}>Сделать копию сейчас</button>
          <button type="button" className="rn-btn" onClick={() => store.closeModal()}>Закрыть</button>
        </>
      }
    >
      <div className="rn-copies-list">
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
                <button type="button" className="rn-btn" onClick={() => { if (sc) { store.closeModal(); sc.openCopyById(c.copyId); } }}>Открыть</button>
                <button type="button" className="rn-btn danger" title="Удалить копию" onClick={() => { if (sc) { sc.deleteCopyById(c.copyId); setList(copiesAll()); } }}>🗑</button>
              </div>
            </div>
          );
        })}
      </div>
    </ModalShell>
  );
}

/* ═══════════ режим копии (панель копии) ═══════════ */

export function CopyBarModal({ store }: { store: VetviStore }) {
  void store.revision;
  const sc = store.sync;
  const cp = sc ? sc.activeCopyObj() : null;
  if (!cp) return null;
  return (
    <ModalShell
      title="Режим копии"
      onClose={() => store.closeModal()}
      foot={
        <>
          <button type="button" className="rn-btn primary" onClick={() => { if (sc) { sc.sendMerge(); } }}>Отправить merge</button>
          <button type="button" className="rn-btn" onClick={() => { if (sc) { store.closeModal(); sc.exitCopyMode(true); } }}>Вернуться к оригиналу</button>
          <button type="button" className="rn-btn" onClick={() => store.closeModal()}>Закрыть</button>
        </>
      }
    >
      <div className="rn-share-body">
        <p>Вы редактируете <b>локальную копию</b> «{cp.name}». Оригинал не изменяется. Отправьте merge-запрос, чтобы владелец оригинала рассмотрел и принял ваши изменения.</p>
        <p className="rn-share-note">{cp.sourceRoomId ? 'Оригинал: комната ' + cp.sourceRoomId.slice(0, 10) + '…' : 'Копия локального проекта (без комнаты).'}</p>
      </div>
    </ModalShell>
  );
}

/* ═══════════ merge-запросы копий ═══════════ */

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
    <ModalShell
      title="Merge-запросы копий"
      wide
      onClose={() => store.closeModal()}
      foot={
        <>
          <button type="button" className="rn-btn" onClick={reload}>Обновить</button>
          <button type="button" className="rn-btn primary" onClick={() => store.closeModal()}>Закрыть</button>
        </>
      }
    >
      <div className="rn-copies-list">
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
                  <button type="button" className="rn-btn primary" onClick={() => { if (sc) { sc.decideMerge(r.id, 'apply'); setList((l) => l.map((x) => (x.id === r.id ? { ...x, status: 'applied' } : x))); } }}>Принять</button>
                  <button type="button" className="rn-btn danger" onClick={() => { if (sc) { sc.decideMerge(r.id, 'reject'); setList((l) => l.map((x) => (x.id === r.id ? { ...x, status: 'rejected' } : x))); } }}>Отклонить</button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </ModalShell>
  );
}

/* ═══════════ смена имени участника ═══════════ */

export function RenameMeModal({ store }: { store: VetviStore }) {
  const [v, setV] = useState(() => getMe().name);
  const submit = () => {
    const val = v.trim();
    if (!val) return;
    if (store.sync) store.sync.renameMe(val);
    store.closeModal();
  };
  return (
    <ModalShell
      title="Ваше имя в комнате"
      onClose={() => store.closeModal()}
      foot={
        <>
          <button type="button" className="rn-btn" onClick={() => store.closeModal()}>Отмена</button>
          <button type="button" className="rn-btn primary" onClick={submit}>Сохранить</button>
        </>
      }
    >
      <div className="rn-form">
        <label className="i-lab">Имя участника
          <input value={v} maxLength={40} autoFocus onFocus={(e) => e.currentTarget.select()} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') submit(); }} />
        </label>
      </div>
    </ModalShell>
  );
}

/* ═══════════ попап участников (collabPop) ═══════════ */

export function CollabPopover({ store }: { store: VetviStore }) {
  void store.revision;
  const sc = store.sync;
  if (!sc || !store.collabPop || !sc.enabled) return null;
  const me = getMe();
  const users = store.syncUsers || [];
  return (
    <div className="collab-pop show" role="dialog" aria-label="Участники комнаты">
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
                <button type="button" className="cp-go" title={'Перейти к ноде «' + (fnNode.title || '…') + '»'} onClick={() => { store.setCollabPop(false); sc.focusGo(u.id); }}>◎</button>
              </>
            )}
          </div>
        );
      })}
      <div className="cp-acts">
        {sc.status !== 'on' && (
          <button type="button" className="cp-act" onClick={() => { store.setCollabPop(false); sc.reconnect(); }}>⟳ Переподключиться</button>
        )}
        <button type="button" className="cp-act" onClick={() => { store.setCollabPop(false); store.openModal('renameMe'); }}>✎ Сменить имя</button>
        <button type="button" className="cp-act" onClick={() => { store.setCollabPop(false); sc.copyShareLink(); }}>⧉ Скопировать ссылку</button>
        <button type="button" className="cp-act" onClick={() => {
          store.setCollabPop(false);
          if (sc.mode === 'copy') sc.exitCopyPanel();
          else sc.disconnect();
        }}>✕ {sc.mode === 'copy' ? 'Закрыть панель' : 'Выйти из комнаты'}</button>
      </div>
    </div>
  );
}

/* ═══════════ экран пароля запертого проекта (lockWrap) ═══════════ */

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
    <div className="rn-lockwrap show" role="dialog" aria-label="Проект защищён паролем">
      <div className="rn-lockcard">
        <div className="rn-lock-ico">🔒</div>
        <div className="rn-lock-name">{store.doc.meta.name || 'Без названия'}</div>
        <div className="rn-lock-cap">Проект защищён паролем. Введите его, чтобы продолжить работу.</div>
        <input
          type="password"
          className="rn-lock-inp"
          value={v}
          autoComplete="off"
          autoFocus
          placeholder="пароль проекта"
          aria-label="Пароль проекта"
          onChange={(e) => { setV(e.target.value); setErr(''); }}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } }}
        />
        {err && <div className="rn-lock-err">{err}</div>}
        <button type="button" className="rn-btn primary rn-lock-go" onClick={submit}>Открыть проект</button>
      </div>
    </div>
  );
}

/* ═══════════ подсказка о чужой блокировке (lockTip) ═══════════ */

export function LockTipHost({ store }: { store: VetviStore }) {
  void store.revision;
  const tip = store.lockTip;
  if (!tip) return null;
  const by = tip.by;
  const color = (by && by.color) || '#8b929c';
  return (
    <div className="lock-tip show" style={{ left: tip.x, top: tip.y }} role="tooltip">
      <span className="lt-dot" style={{ background: color, color }} />
      Объект используется другим пользователем{(by && by.name) ? ' — ' + by.name : ''}
    </div>
  );
}
