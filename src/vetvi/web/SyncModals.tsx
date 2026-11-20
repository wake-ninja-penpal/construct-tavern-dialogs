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
import { mergeStats } from '@/vetvi/core/merge';
import { accessGrant, accessInit, accessList, accessRevoke, type AccessListItem } from './auth';
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

const ROLE_BADGE: Record<string, string> = {
  owner: 'владелец',
  admin: 'администратор',
  editor: 'редактор',
  reader: 'чтение',
};

interface UserLite { login: string; displayName: string | null }

/** Секция «Участники»: поиск по имени/нику с подсказками → открыть доступ;
 *  ниже — список всех, у кого он есть: у каждого можно сменить права
 *  (редактор/чтение) и отозвать доступ. Работает и для ЛОКАЛЬНОГО проекта:
 *  roomId резервируется в meta заранее, запись владельца создаётся сразу —
 *  участники заведены до публикации. Грант шлёт получателю уведомление —
 *  проект появится в его списке. */
function ShareAccess({ store }: { store: VetviStore }) {
  void store.revision;
  const sc = store.sync;
  const [items, setItems] = useState<AccessListItem[]>([]);
  const [meRole, setMeRole] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [login, setLogin] = useState('');
  const [users, setUsers] = useState<UserLite[]>([]);
  const [focused, setFocused] = useState(false);
  const [role, setRole] = useState<'admin' | 'editor' | 'reader'>('editor');
  const [busy, setBusy] = useState(false);
  /* проект сейчас на сервере? серость участников и автопубликация
     привязаны к этому состоянию (обновляется emit'ом стора) */
  const isPub = !!(sc && sc.enabled && sc.mode === 'room');
  const reload = (attempt = 0) => {
    if (!sc) return;
    void accessList(sc.shareRoomId()).then((r) => {
      if (r.ok) {
        setItems(r.items);
        setMeRole((prev) => prev || r.meRole || null);
        setLoaded(true);
        return;
      }
      /* запись владельца могла ещё не сохраниться (гонка init/join) —
         пара тихих повторов, прежде чем показать «список недоступен» */
      if (attempt < 2) window.setTimeout(() => reload(attempt + 1), 800);
      else setLoaded(true);
    });
  };
  useEffect(() => {
    if (!sc) return;
    let alive = true;
    void (async () => {
      /* запись владельца: идемпотентна — без неё API доступов отвечает «только
         владелец может управлять», и добавить участников невозможно */
      try {
        const init = await accessInit(
          sc.shareRoomId(),
          String(store.doc.meta.projectId || '') || null,
          (store.doc.meta.name as string) || null,
        );
        if (alive && init.ok && init.role) setMeRole((prev) => prev || init.role || null);
      } catch { /* сервер недоступен — покажем список как есть */ }
      if (alive) reload();
    })();
    void fetch('/api/users', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : { list: [] }))
      .then((j: { list: UserLite[] }) => { if (alive) setUsers(j.list || []); })
      .catch(() => undefined);
    return () => { alive = false; };
  }, []);
  const isOwner = meRole === 'owner';

  /** Ввод принимаем как по логину, так и по имени (не зависит от регистра).
   *  Подсказки ищут по ВХОЖДЕНИЮ подстроки («bas» → «basya»), поэтому и здесь
   *  точное совпадение дополняем тем же поиском: иначе частично набранный ник
   *  из подсказок уходил на сервер как есть — «Пользователь не найден». */
  const resolveLogin = (raw: string): string | null => {
    const q = raw.trim().toLowerCase();
    if (!q) return null;
    const nick = q.startsWith('@') ? q.slice(1) : q;
    if (!nick) return null;
    const byLogin = users.find((u) => u.login.toLowerCase() === nick);
    if (byLogin) return byLogin.login;
    const byName = users.find((u) => (u.displayName || '').toLowerCase() === nick);
    if (byName) return byName.login;
    /* частичный ввод: тот же порядок, что у подсказок (логин → имя,
       сначала начало строки, потом вхождение) */
    const prefLogin = users.find((u) => u.login.toLowerCase().startsWith(nick));
    if (prefLogin) return prefLogin.login;
    const prefName = users.find((u) => (u.displayName || '').toLowerCase().startsWith(nick));
    if (prefName) return prefName.login;
    const subLogin = users.find((u) => u.login.toLowerCase().includes(nick));
    if (subLogin) return subLogin.login;
    const subName = users.find((u) => (u.displayName || '').toLowerCase().includes(nick));
    if (subName) return subName.login;
    return nick; /* может, пользователь с таким логином есть, но списка нет */
  };

  const grant = async (raw?: string) => {
    if (!sc || busy) return;
    const lg = resolveLogin(raw !== undefined ? raw : login);
    if (!lg) { store.toast('Введите имя или логин пользователя', 'warn'); return; }
    setBusy(true);
    /* первый сторонний участник: проект ещё локальный — после выдачи доступа
       он САМ переходит в сетевой режим (иначе новому участнику некуда входить) */
    const noExternalYet = !items.some((it) => it.role !== 'owner');
    const r = await accessGrant(
      sc.shareRoomId(),
      lg,
      role,
      String(store.doc.meta.projectId || '') || null,
      (store.doc.meta.name as string) || null,
    );
    setBusy(false);
    if (!r.ok) { store.toast(r.error || 'Не удалось открыть доступ', 'err'); return; }
    setLogin('');
    setRole('editor');
    if (noExternalYet && !(sc.enabled && sc.mode === 'room')) {
      /* публикация проверяется по факту: тост только когда документ реально
         сохранён на сервере. Раньше «переведён в сетевой режим» показывалось
         сразу, а публикация могла тихо не состояться — участник оставался
         офлайн до выключения/включения общего доступа. */
      sc.publishProject((ok) => {
        if (ok) store.toast('Первый участник добавлен — проект переведён в сетевой режим', 'ok');
        else store.toast('Проект не удалось перевести в сетевой режим — участники пока не смогут его открыть. Проверьте соединение и переключите «Общедоступный (на сервере)».', 'warn');
      });
    } else {
      store.toast('Доступ открыт — пользователю отправлено уведомление', 'ok');
    }
    reload();
  };
  const revoke = async (lg: string) => {
    if (!sc) return;
    const r = await accessRevoke(sc.shareRoomId(), lg);
    if (!r.ok) { store.toast(r.error || 'Не удалось отозвать доступ', 'err'); return; }
    store.toast('Доступ отозван', 'ok');
    reload();
  };
  const ROLE_NAME: Record<string, string> = { admin: 'администратор', editor: 'редактор', reader: 'только чтение' };
  const setRoleOf = async (it: AccessListItem, next: 'admin' | 'editor' | 'reader') => {
    if (!sc || next === it.role) return;
    const r = await accessGrant(sc.shareRoomId(), it.login, next, null, null);
    if (!r.ok) { store.toast(r.error || 'Не удалось изменить права', 'err'); return; }
    store.toast(it.displayName + ': права — ' + (ROLE_NAME[next] || next), 'ok');
    reload();
  };

  const q = login.trim().toLowerCase();
  const suggestions = q
    ? users
        .filter((u) => {
          const lg = u.login.toLowerCase();
          const nm = (u.displayName || '').toLowerCase();
          return (lg.includes(q) || nm.includes(q)) && !items.some((it) => it.login === u.login);
        })
        .slice(0, 8)
    : [];

  return (
    <div className="share-acc">
      <div className="sp-cap">Участники проекта</div>
      {!loaded && <div className="sa-empty">Загрузка участников…</div>}
      {loaded && !items.length && <div className="sa-empty">Пока никого — найдите пользователя по имени или нику ниже</div>}
      {!isPub && items.some((it) => it.role !== 'owner') && (
        <div className="sa-empty">Сетевой режим выключен — участники серые и открыть проект не могут. Включите «Общедоступный (на сервере)» ниже, чтобы вернуть им доступ.</div>
      )}
      <div className="sa-list">
        {items.map((it) => (
          <div
            key={it.userId}
            className={'sa-item' + (!isPub && it.role !== 'owner' ? ' off' : '')}
            title={!isPub && it.role !== 'owner' ? 'Сетевой режим выключен — доступ приостановлен' : undefined}
          >
            <span className="avatar-circle" style={{ background: it.color || '#8b929c' }}>{(it.displayName || it.login || '?')[0].toUpperCase()}</span>
            <div className="sa-who">
              <b>{it.displayName}</b>
              <i>@{it.login}</i>
            </div>
            {isOwner && it.role !== 'owner' ? (
              <>
                <select
                  className="inp sa-role-sel"
                  value={it.role}
                  aria-label="Права доступа"
                  title="Сменить права доступа (администратор подтверждает merge-запросы и замены)"
                  onChange={(e) => void setRoleOf(it, e.target.value === 'reader' ? 'reader' : e.target.value === 'admin' ? 'admin' : 'editor')}
                >
                  <option value="admin">администратор</option>
                  <option value="editor">редактор</option>
                  <option value="reader">только чтение</option>
                </select>
                <button type="button" className="btn danger" title="Отозвать доступ" aria-label={'Отозвать доступ у ' + it.displayName} onClick={() => void revoke(it.login)}>×</button>
              </>
            ) : (
              <span className={'sa-role r-' + it.role}>{ROLE_BADGE[it.role] || it.role}</span>
            )}
          </div>
        ))}
      </div>
      {isOwner && (
        <div className="sa-form">
          <input
            className="inp"
            value={login}
            placeholder="Поиск по имени или нику…"
            aria-label="Поиск пользователя для доступа"
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => setLogin(e.target.value)}
            onFocus={() => setFocused(true)}
            onBlur={() => window.setTimeout(() => setFocused(false), 150)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void grant(); } }}
          />
          {focused && suggestions.length > 0 && (
            <div className="sa-suggest" role="listbox" aria-label="Найденные пользователи">
              {suggestions.map((usr) => (
                <button
                  type="button"
                  key={usr.login}
                  role="option"
                  aria-selected={false}
                  className="sa-sug-i"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => { setLogin(usr.login); void grant(usr.login); }}
                >
                  <b>{usr.displayName || usr.login}</b>
                  <i>@{usr.login}</i>
                </button>
              ))}
            </div>
          )}
          <select
            className="inp sa-new-role"
            value={role}
            aria-label="Права для нового пользователя"
            title="Права доступа для нового пользователя"
            onChange={(e) => setRole(e.target.value === 'reader' ? 'reader' : e.target.value === 'admin' ? 'admin' : 'editor')}
          >
            <option value="admin">администратор</option>
            <option value="editor">редактор</option>
            <option value="reader">только чтение</option>
          </select>
          <button type="button" className="btn primary" disabled={busy || !login.trim()} onClick={() => void grant()}>
            {busy ? 'Открываю…' : 'Добавить'}
          </button>
        </div>
      )}
      {isOwner && users.length === 0 && loaded && <div className="sa-empty">Зарегистрированных пользователей пока нет — аккаунты создаются по ссылкам-приглашениям</div>}
      <p style={{ fontSize: '11px', color: 'var(--tx3)', margin: '8px 0 0' }}>
        Участник получит уведомление и увидит проект в своём списке. Открыть его можно, когда проект на сервере: первый добавленный участник сам включает сетевой режим.
      </p>
    </div>
  );
}

/** Окно «Поделиться» (v2): участники с поиском по имени/нику, переключатель
 *  «общедоступный (сервер)» — проект становится сетевым ТОЛЬКО им, ссылка
 *  появляется только после публикации, с выключателем и режимом доступа
 *  (все по ссылке / только добавленные участники). Пароль комнаты — тоже
 *  только в сетевом режиме. */
export function ShareModal({ store }: { store: VetviStore }) {
  void store.revision;
  const sc = store.sync;
  const isCopy = !!(sc && sc.mode === 'copy');
  const isPublic = !!(sc && sc.enabled && sc.mode === 'room');
  const linkMode = sc ? sc.linkMode : 'open';
  const meta = store.doc.meta as unknown as { passHash?: string };
  const pwSet = !!(meta && meta.passHash);
  const isOwner = !isCopy && (!isPublic || sc?.role === 'owner');
  /* showShareModal оригинала выделяет ссылку сразу после открытия */
  const inpRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const tm = window.setTimeout(() => { if (inpRef.current) inpRef.current.select(); }, 80);
    return () => window.clearTimeout(tm);
  }, []);
  const u = sc && isPublic ? sc.shareUrl() : '';
  return (
    <SyncShell title="Поделиться проектом" onClose={() => store.closeModal()} foot={<button type="button" className="btn primary" onClick={() => store.closeModal()}>Готово</button>}>
      {/* участники и доступы — работают и пока проект локальный */}
      {!isCopy ? <ShareAccess store={store} /> : (
        <div className="share-acc">
          <div className="sp-cap">Участники проекта</div>
          <div className="sa-empty">Это локальная копия — участников и ссылку управляет оригинал проекта</div>
        </div>
      )}

      {/* сетевой режим: включается ТОЛЬКО явным переключателем владельца.
          Не-владельцу (участник/гость чужой комнаты) переключатель не
          показывается — выключение удаляет комнату с сервера, это
          исключительно решение владельца. */}
      <div className="share-pub">
        <div className="sp-cap">Сетевой проект</div>
        {isCopy ? (
          <div className="sp-st">Копия не публикуется: откройте оригинал и включите сетевой режим там.</div>
        ) : !isOwner ? (
          <div className="sp-st">Сетевой режим управляет владелец проекта — вы {sc?.role === 'editor' ? 'редактор' : sc?.role === 'reader' ? 'читатель' : 'гость'} этой комнаты.</div>
        ) : (
          <label className="pub-row">
            <input
              type="checkbox"
              className="pub-switch"
              role="switch"
              aria-label="Общедоступный сетевой проект"
              checked={isPublic}
              onChange={(e) => {
                if (!sc) return;
                if (e.target.checked) sc.publishProject();
                else sc.unpublishProject();
              }}
            />
            <span className="pub-text">
              <b>Общедоступный (на сервере)</b>
              <span className="sp-st">
                {isPublic
                  ? 'Проект на сервере комнаты: соавторы редактируют вместе в реальном времени, данные ждут вас даже офлайн.'
                  : 'Проект хранится только локально. Включите — появится ссылка, и участники из списка смогут открыть проект с сервера.'}
              </span>
            </span>
          </label>
        )}
      </div>

      {/* ссылка: появляется только в сетевом режиме */}
      {isPublic && !isCopy && (
        <div className="share-linksec">
          <div className="sp-cap">Ссылка на проект</div>
          {isOwner && (
          <label className="pub-row pub-row-sm">
            <input
              type="checkbox"
              className="pub-switch"
              role="switch"
              aria-label="Ссылка включена"
              checked={linkMode !== 'off'}
              onChange={(e) => {
                if (!sc) return;
                if (e.target.checked) sc.setRoomLinkMode('open');
                else sc.setRoomLinkMode('off');
              }}
            />
            <span className="pub-text">
              <b>{linkMode !== 'off' ? 'Ссылка включена' : 'Ссылка отключена'}</b>
              <span className="sp-st">
                {linkMode === 'off'
                  ? 'Ссылка не работает: войти могут только участники из списка выше (через свой список проектов).'
                  : 'Отключите, чтобы проект открывался только приглашённым участникам.'}
              </span>
            </span>
          </label>
          )}
          {linkMode !== 'off' && (
            <>
              <div className="share-link">
                <input ref={inpRef} readOnly value={u} onClick={(e) => (e.currentTarget as HTMLInputElement).select()} aria-label="Ссылка комнаты" />
                <button type="button" className="btn primary" title="Скопировать ссылку" onClick={() => sc && sc.copyShareLink()}><Ic name="copy" size={14} /></button>
              </div>
              {isOwner && (
                <label className="pub-policy">
                  <span>По ссылке могут войти:</span>
                  <select
                    className="inp"
                    value={linkMode}
                    aria-label="Кто может войти по ссылке"
                    onChange={(e) => sc && sc.setRoomLinkMode(e.target.value === 'members' ? 'members' : 'open')}
                  >
                    <option value="open">все — просмотр без правки</option>
                    <option value="members">только добавленные участники</option>
                  </select>
                </label>
              )}
              <p style={{ fontSize: '11.5px', color: 'var(--tx3)', margin: '4px 0 0' }}>
                {linkMode === 'members'
                  ? 'Пользователь без доступа по ссылке войти не сможет.'
                  : 'Пользователи по ссылке увидят проект в режиме «только чтение»; участники из списка редактируют.'}
              </p>
            </>
          )}
        </div>
      )}

      {/* пароль комнаты — смысл имеет только в сетевом режиме */}
      {isPublic && !isCopy && (
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
              <div className="sp-st">Не установлен — по ссылке войдут все, но правка доступна только пользователям с доступом (остальным — только чтение).</div>
              <div className="sp-acts">
                <button type="button" className="btn" onClick={() => sc && sc.passSetModal(false)}>Задать пароль…</button>
              </div>
            </>
          )}
        </div>
      )}
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

/** Небольшой блок в углу холста: «данные отличаются» — клик открывает сравнение
 *  версий. В блоке есть кнопка «Merge-запросы» (список всех заявок комнаты);
 *  когда расхождения нет, но есть запросы в очереди — показывается компактный
 *  блок «Merge-запросы: N» (контроль входящих заявок копий и замен). */
export function SyncDiffBadge({ store }: { store: VetviStore }) {
  void store.revision;
  const d = store.syncDiff;
  const sc = store.sync;
  const pending = store.syncMergeCount || 0;
  if (!d) {
    /* нет расхождения — есть ли запросы в очереди? */
    if (!sc || !sc.enabled || store.syncMode === 'copy' || !pending) return null;
    return (
      <div id="syncDiffBadge" className="requests-only" role="status" aria-label="Merge-запросы в очереди">
        <button
          type="button"
          className="sd-badge-btn"
          title="Список Merge-запросов (активные и выполненные)"
          onClick={(e) => { e.stopPropagation(); store.openModal('merge'); }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <span className="sd-badge-dot pulse" />
          <span className="sd-badge-text">
            <b>Merge-запросы: {pending}</b>
            <i>нажмите, чтобы открыть список запросов</i>
          </span>
        </button>
      </div>
    );
  }
  const stats = mergeStats(d.serverDoc as Record<string, unknown>, d.localDoc as Record<string, unknown>);
  const n = stats.addedNodes + stats.changedNodes + stats.removedNodes + stats.addedEdges + stats.changedEdges + stats.removedEdges + stats.addedGroups + stats.changedGroups + stats.removedGroups + stats.changedTypes;
  const label = d.kind === 'incoming'
    ? 'Пришли изменения' + (d.by?.name ? ' от ' + d.by.name : '')
    : d.kind === 'foreign'
      ? 'В комнате другой проект'
      : 'Данные отличаются от локальной копии';
  return (
    <div id="syncDiffBadge" role="status" aria-label={label}>
      <button
        type="button"
        className="sd-badge-btn"
        title="Нажмите, чтобы сравнить версии локальной копии и комнаты"
        onClick={(e) => { e.stopPropagation(); store.openModal('syncDiff'); }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <span className="sd-badge-dot" />
        <span className="sd-badge-text">
          <b>{label}</b>
          <i>{n ? 'различий: ' + n + ' — нажмите для сравнения' : 'нажмите для сравнения версий'}</i>
        </span>
      </button>
      {sc && sc.enabled && store.syncMode !== 'copy' && (
        <button
          type="button"
          className="sd-badge-mrg"
          title="Список Merge-запросов копий и замен (активные и выполненные)"
          onClick={(e) => { e.stopPropagation(); store.openModal('merge'); }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          Merge-запросы{pending > 0 ? ' · ' + pending : ''}
        </button>
      )}
      <button
        type="button"
        className="sd-badge-x"
        title="Скрыть блок (версии останутся без изменений)"
        aria-label="Скрыть блок расхождения"
        onClick={(e) => { e.stopPropagation(); if (store.sync) store.sync.diffDismiss(); }}
        onMouseDown={(e) => e.stopPropagation()}
      >×</button>
    </div>
  );
}

/* ═══════════ сравнение версий (блок расхождения local/server, новая система комнат) ═══════════ */

interface IdTitle { id?: string; title?: string; text?: string }

function titleOf(o: IdTitle | undefined): string {
  const t = o && (o.title || o.text);
  return t ? String(t).slice(0, 60) : '(без названия)';
}

/** Списки различий по нодам (для сравнения двух версий в SyncDiffModal). */
function nodeDiffLists(localNodes: IdTitle[] | undefined, serverNodes: IdTitle[] | undefined) {
  const lm: Record<string, IdTitle> = {};
  (localNodes || []).forEach((n) => { if (n && n.id) lm[String(n.id)] = n; });
  const sm: Record<string, IdTitle> = {};
  (serverNodes || []).forEach((n) => { if (n && n.id) sm[String(n.id)] = n; });
  const onlyLocal: IdTitle[] = [];
  const changed: IdTitle[] = [];
  (localNodes || []).forEach((n) => {
    if (!n || !n.id) return;
    const s = sm[String(n.id)];
    if (!s) onlyLocal.push(n);
    else if (JSON.stringify(s) !== JSON.stringify(n)) changed.push(n);
  });
  const onlyServer: IdTitle[] = [];
  (serverNodes || []).forEach((n) => { if (n && n.id && !lm[String(n.id)]) onlyServer.push(n); });
  return { onlyLocal, onlyServer, changed };
}

function DiffList({ cap, rows, max = 12, cls }: { cap: string; rows: IdTitle[]; max?: number; cls: string }) {
  if (!rows.length) return null;
  const show = rows.slice(0, max);
  return (
    <div className="sd-list">
      <div className="sd-cap">{cap} ({rows.length})</div>
      {show.map((r, i) => (
        <div className={'sd-row ' + cls} key={(r.id || '') + i}>«{titleOf(r)}»{rows.length > max && i === max - 1 ? '' : ''}</div>
      ))}
      {rows.length > max && <div className="sd-row more">… и ещё {rows.length - max}</div>}
    </div>
  );
}

export function SyncDiffModal({ store }: { store: VetviStore }) {
  void store.revision;
  const d = store.syncDiff;
  const sc = store.sync;
  if (!d || !sc) return null;
  const stats = mergeStats(d.serverDoc as Record<string, unknown>, d.localDoc as Record<string, unknown>);
  const lists = nodeDiffLists(d.localDoc.nodes as IdTitle[], d.serverDoc.nodes as IdTitle[]);
  const chip = (v: number, label: string) => (v ? <span className="mrg-chip">{label}: {v}</span> : null);
  const total = stats.addedNodes + stats.changedNodes + stats.removedNodes + stats.addedEdges + stats.changedEdges + stats.removedEdges + stats.addedGroups + stats.changedGroups + stats.removedGroups + stats.changedTypes;
  const head = d.kind === 'incoming'
    ? <>Участник <b style={{ color: d.by?.color || undefined }}>{d.by?.name || '—'}</b> заменил данные на сервере. Изменения не применены — сравните версии и решите, что делать.</>
    : d.kind === 'foreign'
      ? <>В комнате находится <b>другой проект</b>. Ваши данные не заменялись: сравните версии и выберите — загрузить данные комнаты, опубликовать свою версию (комната перейдёт на ваш проект) или смерджить.</>
      : <>Локальная копия проекта отличается от данных комнаты. Комната загружена как рабочая версия, локальная копия сохранена — сравните и решите, что делать.</>;
  const localCap = d.kind === 'incoming' ? 'Ваша текущая версия' : 'Локальная копия';
  const serverCap = d.kind === 'incoming' ? 'Пришедшая версия (замена)' : 'Версия комнаты (сервер)';
  /* замена/слияние от участника без права подтверждения уходит ЗАПРОСОМ:
     применит владелец или админ комнаты (снимок сохранит сервер) */
  const canDecide = !!sc.canDecideMerge();
  return (
    <SyncShell
      title="Сравнение версий проекта"
      wide
      onClose={() => { store.closeModal(); }}
      foot={
        <>
          {d.kind === 'incoming' && <button type="button" className="btn primary" onClick={() => { sc.diffTakeServer(); store.closeModal(); }}>Принять изменения</button>}
          {d.kind !== 'incoming' && <button type="button" className="btn primary" onClick={() => { sc.diffTakeServer(); store.closeModal(); }}>{d.kind === 'foreign' ? 'Загрузить из комнаты' : 'Перезаписать локальные данные'}</button>}
          {d.kind !== 'incoming' && <button type="button" className="btn" title={canDecide ? 'Заменить данные комнаты вашей версией' : 'Отправить запрос на замену — применит владелец или админ'} onClick={() => { sc.diffPushLocal(); store.closeModal(); }}>{canDecide ? (d.kind === 'foreign' ? 'Опубликовать мою (комнату)' : 'Опубликовать локальную версию') : 'Запрос на замену'}</button>}
          <button type="button" className="btn" title={canDecide ? 'Объединить версии и опубликовать результат' : 'Отправить объединённую версию запросом на замену'} onClick={() => { sc.diffMerge(); store.closeModal(); }}>{canDecide ? 'Смерджить' : 'Смерджить (запросом)'}</button>
          <button type="button" className="btn" onClick={() => { sc.diffDismiss(); store.closeModal(); }}>{d.kind === 'incoming' ? 'Отклонить' : 'Закрыть'}</button>
        </>
      }
    >
      <p className="sd-head">{head}</p>
      <div className="sd-cols">
        <div className="sd-col">
          <div className="sd-col-cap">{localCap}</div>
          <div className="sd-col-sub">{((d.localDoc.meta as { name?: string }) || {}).name || 'Без названия'} · нод: {(d.localDoc.nodes as unknown[])?.length || 0}</div>
        </div>
        <div className="sd-col">
          <div className="sd-col-cap">{serverCap}</div>
          <div className="sd-col-sub">{((d.serverDoc.meta as { name?: string }) || {}).name || 'Без названия'} · нод: {(d.serverDoc.nodes as unknown[])?.length || 0}</div>
        </div>
      </div>
      <div className="sd-stats mrg-stats">
        {chip(stats.addedNodes, '+ узлов (локальные)')}
        {chip(stats.removedNodes, '− узлов (есть только в комнате)')}
        {chip(stats.changedNodes, '~ узлов изменено')}
        {chip(stats.changedDialogs, '~ реплик диалогов')}
        {chip(stats.changedNotes, '~ заметок')}
        {chip(stats.addedEdges, '+ связей')}
        {chip(stats.changedEdges, '~ связей')}
        {chip(stats.removedEdges, '− связей')}
        {chip(stats.addedGroups, '+ групп')}
        {chip(stats.changedGroups, '~ групп')}
        {chip(stats.removedGroups, '− групп')}
        {chip(stats.changedTypes, '~ своих типов')}
      </div>
      {!total && (
        <p className="sd-empty">Содержимое версий совпадает — отличаются только служебные данные (время правки, журнал).</p>
      )}
      {!!total && (
        <div className="sd-lists">
          <DiffList cap="Только в локальной версии" rows={lists.onlyLocal} cls="add" />
          <DiffList cap="Только в версии комнаты" rows={lists.onlyServer} cls="del" />
          <DiffList cap="Изменены в обеих версиях" rows={lists.changed} cls="chg" />
        </div>
      )}
    </SyncShell>
  );
}

/* ═══════════ merge-запросы: копий + замен проекта + откатов к версии ═══════════ */

const MRG_KIND: Record<string, string> = {
  copy: 'слияние копии',
  replace: 'замена проекта',
};

/** Это заявка на откат к версии из журнала? (sendRollbackRequest:
 *  kind replace + copyId 'rollback:…' + stats.rollback = 1) */
function mrgIsRollback(r: MergeRequest): boolean {
  if (r.kind !== 'replace') return false;
  if (typeof r.copyId === 'string' && r.copyId.startsWith('rollback:')) return true;
  const s = r.stats as Record<string, unknown> | undefined;
  return !!(s && s.rollback === 1);
}

/** Окно списка Merge-запросов: АКТИВНЫЕ и ВЫПОЛНЕННЫЕ (контроль).
 *  Подтвердить (принять/отклонить) может владелец комнаты и админ.
 *  Перед применением замены/слияния сервер сохраняет снимок проекта. */
export function MergeModal({ store }: { store: VetviStore }) {
  void store.revision;
  const sc = store.sync;
  const [list, setList] = useState<MergeRequest[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [onlyPending, setOnlyPending] = useState(true);
  const reload = () => {
    if (!sc) return;
    sc.mergeRequests((res) => {
      setList((res && res.requests) || []);
      setLoaded(true);
    });
  };
  useEffect(() => { reload(); }, []);
  const canDecide = !!(sc && sc.canDecideMerge());
  const chip = (v: number | undefined, label: string) => (v ? <span className="mrg-chip">{label}: {v}</span> : null);
  const shown = onlyPending ? list.filter((r) => (r.status || 'pending') === 'pending') : list;
  const pendingN = list.filter((r) => (r.status || 'pending') === 'pending').length;
  return (
    <SyncShell
      title="Merge-запросы"
      wide
      onClose={() => store.closeModal()}
      foot={
        <>
          <button type="button" className="btn" onClick={reload}>Обновить</button>
          <button type="button" className="btn primary" onClick={() => store.closeModal()}>Закрыть</button>
        </>
      }
    >
      <div className="mrg-filters" role="tablist" aria-label="Фильтр запросов">
        <button type="button" className={'mrg-fbtn' + (onlyPending ? ' on' : '')} onClick={() => setOnlyPending(true)}>
          Активные{pendingN ? ' · ' + pendingN : ''}
        </button>
        <button type="button" className={'mrg-fbtn' + (!onlyPending ? ' on' : '')} onClick={() => setOnlyPending(false)}>
          Все ({list.length})
        </button>
        {!canDecide && (
          <span className="mrg-note">Подтверждает владелец комнаты или админ</span>
        )}
      </div>
      {loaded && !shown.length && (
        <p className="mrg-empty">
          {onlyPending
            ? 'Активных запросов нет — копии проекта и участники будут отправлять изменения сюда.'
            : 'Запросов пока не было.'}
        </p>
      )}
      {shown.map((r) => {
        const s = r.stats || {} as Record<string, number>;
        const status = r.status || 'pending';
        const kind = r.kind === 'replace' ? 'replace' : 'copy';
        const isRb = mrgIsRollback(r);
        return (
          <div key={r.id} className="mrg-item">
            <div className="mrg-top">
              <span className="mrg-dot" style={{ background: (r.sender && r.sender.color) || '#8b929c' }} />
              <b>{(r.sender && r.sender.name) || 'Гость'}</b>
              <span className="mrg-kind">{isRb ? 'откат к версии' : MRG_KIND[kind]}</span>
              <span className="mrg-date">{syncFmtDate(r.createdAt)}</span>
              <span className={'mrg-status st-' + status}>
                {status === 'pending' ? 'ожидает' : status === 'applied' ? (isRb ? 'применён' : 'принят') : 'отклонён'}
              </span>
            </div>
            {isRb && typeof s.rollbackAt === 'number' && s.rollbackAt > 0 && (
              <div className="mrg-stats">
                <span className="mrg-chip">к версии от {syncFmtDate(new Date(s.rollbackAt).toISOString())}</span>
              </div>
            )}
            {!isRb && (
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
            )}
            {status !== 'pending' && (
              <div className="mrg-decided">
                {status === 'applied' ? 'Принят' : 'Отклонён'}
                {r.decidedBy ? ' — ' + r.decidedBy : ''}
                {r.decidedAt ? ' · ' + syncFmtDate(r.decidedAt) : ''}
                {' · снимок проекта сохранён'}
              </div>
            )}
            {status === 'pending' && canDecide && (
              <div className="mrg-acts">
                <button
                  type="button"
                  className="btn primary"
                  title={kind === 'replace'
                    ? (isRb
                      ? 'Откатить проект комнаты к выбранной версии (снимок текущего состояния сохранится на сервере)'
                      : 'Применить версию отправителя ко всей комнате (снимок сохранится на сервере)')
                    : 'Смерджить изменения копии в проект (снимок сохранится на сервере)'}
                  onClick={() => { if (sc) { sc.decideMerge(r.id, 'apply'); setList((l) => l.map((x) => (x.id === r.id ? { ...x, status: 'applied', decidedBy: 'вы' } : x))); } }}
                >
                  {isRb ? 'Откатить' : 'Принять'}
                </button>
                <button
                  type="button"
                  className="btn danger"
                  onClick={() => { if (sc) { sc.decideMerge(r.id, 'reject'); setList((l) => l.map((x) => (x.id === r.id ? { ...x, status: 'rejected', decidedBy: 'вы' } : x))); } }}
                >
                  Отклонить
                </button>
              </div>
            )}
          </div>
        );
      })}
      {canDecide && (
        <p className="mrg-hint">Перед применением любого запроса сервер сохраняет полный снимок проекта (хранятся последние {store.projectSnapshotsLimit()} — настройка в «Настройки проекта → Снимки»).</p>
      )}
    </SyncShell>
  );
}

/* ═══════════ попап участников (#collabPop / syncRenderPop) ═══════════
   Имена — из аккаунтов (сервер берёт их из БД), смена имени удалена. */

export function CollabPopover({ store }: { store: VetviStore }) {
  void store.revision;
  const sc = store.sync;
  if (!sc || !store.collabPop || !sc.enabled) return null;
  const me = getMe();
  const users = store.syncUsers || [];
  /* позиция — ПОД кнопкой статуса (правая серая половина составной кнопки
     «Поделиться+онлайн», id=bCollab); раньше якорем был чип .collab-chip,
     который исчез после объединения кнопок — попап уезжал в правый край экрана */
  let popStyle: React.CSSProperties = { position: 'fixed', top: 52, right: 8 };
  if (typeof document !== 'undefined') {
    const anchor = document.getElementById('bCollab') || document.querySelector('.collab-chip');
    if (anchor) {
      const r = anchor.getBoundingClientRect();
      popStyle = { position: 'fixed', top: r.bottom + 8, right: Math.max(8, window.innerWidth - r.right), left: 'auto' };
    }
  }
  return (
    <div id="collabPop" className="collab-pop show" style={popStyle} role="dialog" aria-label="Участники комнаты">
      <div className="cp-cap">Участники комнаты</div>
      {store.viewOnly && (
        <div className="cp-ro">У вас доступ только на чтение</div>
      )}
      {!users.length && <div className="cp-row"><span className="cp-name">Пока только вы</span></div>}
      {users.map((u) => {
        const nid = store.syncFocus ? store.syncFocus[u.id] : null;
        const fnNode = nid ? store.nodeById(nid) : null;
        return (
          <div key={u.id} className={'cp-row' + (u.id === me.id ? ' me' : '')} title={fnNode ? 'Сейчас у «' + u.name + '»: нода «' + (fnNode.title || '…') + '»' : undefined}>
            <span className="cp-dot" style={{ background: u.color || '#8b929c' }} />
            <span className="cp-name">{u.name}{u.id === me.id ? ' (вы)' : ''}{u.canEdit === false ? <i className="cp-ro-tag">чтение</i> : null}</span>
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
        {sc.room && (
          <button type="button" className="cp-act" onClick={() => { store.setCollabPop(false); sc.copyShareLink(); }}><Ic name="copy" size={13} />Скопировать ссылку</button>
        )}
        <button type="button" className="cp-act" onClick={() => { store.setCollabPop(false); store.openModal('share'); }}><Ic name="pencil" size={13} />Доступы и ссылка</button>
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
