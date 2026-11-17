'use client';

/**
 * «Ветви» — скрытая панель администратора.
 *
 * В приложении НЕТ ни кнопки, ни ссылки на неё — попасть можно только
 * открыв адрес с секретным хешем (ADMIN_PANEL_HASH, задаётся ниже и легко
 * меняется). Кто не знает хеш — не узнаёт и о существовании панели.
 *
 * Возможности:
 *  - вкл/выкл авторизации и регистрации (авторизация выключена → приложение
 *    работает как раньше, без входа — режим разработки и тестов);
 *  - создание ссылок-приглашений: одноразовые или на N регистраций,
 *    копирование ссылки, вкл/выкл, удаление;
 *  - список всех аккаунтов: отключение/включение, удаление.
 *
 * При первом входе админ сам задаёт пароль панели (bootstrap), дальше —
 * только по нему.
 */

import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';

/** Секретный хеш панели в адресной строке: http://…/#sys-root-2f8a1c */
const ADMIN_PANEL_HASH = '#sys-root-2f8a1c';

interface InviteRec {
  id: string;
  code: string;
  maxUses: number;
  uses: number;
  disabled: boolean;
  note: string | null;
  createdAt: string;
}

interface UserRec {
  id: string;
  login: string;
  displayName: string | null;
  disabled: boolean;
  createdAt: string;
}

export function isAdminHash(): boolean {
  return typeof window !== 'undefined' && window.location.hash === ADMIN_PANEL_HASH;
}

export function AdminPanel() {
  const [phase, setPhase] = useState<'check' | 'gate' | 'open'>('check');
  const [bootstrapping, setBootstrapping] = useState(false);
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const [authOn, setAuthOn] = useState(true);
  const [regOn, setRegOn] = useState(true);
  const [tab, setTab] = useState<'settings' | 'invites' | 'users'>('settings');

  const [invites, setInvites] = useState<InviteRec[]>([]);
  const [users, setUsers] = useState<UserRec[]>([]);
  const [newMaxUses, setNewMaxUses] = useState('1');
  const [newNote, setNewNote] = useState('');
  const [toast, setToast] = useState('');

  const flash = (t: string) => {
    setToast(t);
    setTimeout(() => setToast(''), 2600);
  };

  /* ── загрузка данных ── */

  const loadInvites = useCallback(async () => {
    const r = await fetch('/api/admin/invites', { cache: 'no-store' });
    if (r.ok) setInvites(((await r.json()) as { list: InviteRec[] }).list);
  }, []);

  const loadUsers = useCallback(async () => {
    const r = await fetch('/api/admin/users', { cache: 'no-store' });
    if (r.ok) setUsers(((await r.json()) as { list: UserRec[] }).list);
  }, []);

  const loadSettings = useCallback(async () => {
    const r = await fetch('/api/admin/settings', { cache: 'no-store' });
    if (r.ok) {
      const j = (await r.json()) as { authEnabled: boolean; registrationEnabled: boolean };
      setAuthOn(j.authEnabled);
      setRegOn(j.registrationEnabled);
    }
  }, []);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const r = await fetch('/api/admin/session', { cache: 'no-store' });
        const j = (await r.json()) as { configured: boolean; authed: boolean };
        if (!alive) return;
        setBootstrapping(!j.configured);
        if (j.authed) {
          setPhase('open');
          await Promise.all([loadSettings(), loadInvites(), loadUsers()]);
        } else {
          setPhase('gate');
        }
      } catch {
        if (alive) setErr('Сервер недоступен');
        if (alive) setPhase('gate');
      }
    })();
    return () => { alive = false; };
  }, [loadSettings, loadInvites, loadUsers]);

  /* ── действия ── */

  const enter = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setErr('');
    setBusy(true);
    try {
      const r = await fetch('/api/admin/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      const j = (await r.json().catch(() => ({}))) as { error?: string; authed?: boolean };
      if (!r.ok || !j.authed) {
        setErr(j.error || 'Не удалось войти');
        return;
      }
      setPassword('');
      setPhase('open');
      await Promise.all([loadSettings(), loadInvites(), loadUsers()]);
    } catch {
      setErr('Сервер недоступен');
    } finally {
      setBusy(false);
    }
  };

  const toggleSetting = async (key: 'authEnabled' | 'registrationEnabled', v: boolean) => {
    const r = await fetch('/api/admin/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [key]: v }),
    });
    if (r.ok) {
      const j = (await r.json()) as { authEnabled: boolean; registrationEnabled: boolean };
      setAuthOn(j.authEnabled);
      setRegOn(j.registrationEnabled);
      flash('Сохранено');
    } else {
      flash('Ошибка сохранения');
    }
  };

  const createInvite = async () => {
    const r = await fetch('/api/admin/invites', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ maxUses: Number(newMaxUses) || 1, note: newNote }),
    });
    if (r.ok) {
      setNewMaxUses('1');
      setNewNote('');
      await loadInvites();
      flash('Ссылка создана');
    } else {
      flash('Ошибка создания');
    }
  };

  const toggleInvite = async (inv: InviteRec) => {
    await fetch('/api/admin/invites/' + inv.id, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ disabled: !inv.disabled }),
    });
    await loadInvites();
  };

  const deleteInvite = async (inv: InviteRec) => {
    if (!window.confirm('Удалить ссылку «' + inv.code.slice(0, 6) + '…»?')) return;
    await fetch('/api/admin/invites/' + inv.id, { method: 'DELETE' });
    await loadInvites();
    flash('Ссылка удалена');
  };

  const toggleUser = async (u: UserRec) => {
    const r = await fetch('/api/admin/users/' + u.id, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ disabled: !u.disabled }),
    });
    if (r.ok) {
      await loadUsers();
      flash(u.disabled ? 'Аккаунт включён' : 'Аккаунт отключён — сессии аннулированы');
    } else {
      flash('Ошибка');
    }
  };

  const deleteUser = async (u: UserRec) => {
    if (!window.confirm('Удалить аккаунт «' + u.login + '»? Отменить нельзя.')) return;
    await fetch('/api/admin/users/' + u.id, { method: 'DELETE' });
    await loadUsers();
    flash('Аккаунт удалён');
  };

  const copyLink = async (code: string) => {
    const url = window.location.origin + '/?invite=' + code;
    try {
      await navigator.clipboard.writeText(url);
      flash('Ссылка скопирована');
    } catch {
      window.prompt('Скопируйте ссылку вручную:', url);
    }
  };

  /* ── рендер ── */

  if (phase === 'check') {
    return <main className="au-wrap"><div className="au-card"><p className="au-hint">Проверка доступа…</p></div></main>;
  }

  if (phase === 'gate') {
    return (
      <main className="au-wrap" role="main" aria-label="Панель администратора">
        <form className="au-card" onSubmit={enter}>
          <div className="au-brand">
            <svg viewBox="0 0 24 24" fill="none" width={30} height={30} aria-hidden="true">
              <path d="M7.5 12h3c3.2 0 2.4-6.5 6-6.5M10.5 12c3.2 0 2.4 6.5 6 6.5" stroke="#4d535e" strokeWidth="1.6" strokeLinecap="round" />
              <circle cx="5.5" cy="12" r="2.6" fill="#e2a54e" />
              <circle cx="18.5" cy="5.5" r="2.1" fill="#9cb878" />
              <circle cx="18.5" cy="18.5" r="2.1" fill="#cf6d4f" />
            </svg>
            <span className="au-lg">ВЕТВИ</span>
            <span className="adm-tag">панель администратора</span>
          </div>
          <h1 className="au-title">{bootstrapping ? 'Первый вход' : 'Вход'}</h1>
          <p className="au-hint">
            {bootstrapping
              ? 'Пароль панели ещё не задан — придумайте его сейчас. Он будет запрошен при следующих входах.'
              : 'Введите пароль панели администратора.'}
          </p>
          <label className="au-field">
            <span>Пароль</span>
            <input className="au-input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
          </label>
          {err && <div className="au-err">{err}</div>}
          <button className="au-btn" type="submit" disabled={busy}>{busy ? 'Проверяю…' : bootstrapping ? 'Задать пароль и открыть' : 'Войти'}</button>
        </form>
      </main>
    );
  }

  return (
    <main className="au-wrap adm-wrap" role="main" aria-label="Панель администратора">
      <div className="adm-card">
        <div className="adm-head">
          <span className="adm-title">Панель администратора</span>
          {toast && <span className="adm-toast">{toast}</span>}
        </div>

        <nav className="adm-tabs" role="tablist">
          <button type="button" role="tab" aria-selected={tab === 'settings'} className={'adm-tab' + (tab === 'settings' ? ' active' : '')} onClick={() => setTab('settings')}>Настройки</button>
          <button type="button" role="tab" aria-selected={tab === 'invites'} className={'adm-tab' + (tab === 'invites' ? ' active' : '')} onClick={() => setTab('invites')}>Ссылки-приглашения</button>
          <button type="button" role="tab" aria-selected={tab === 'users'} className={'adm-tab' + (tab === 'users' ? ' active' : '')} onClick={() => setTab('users')}>Пользователи</button>
        </nav>

        <div className="adm-body">
          {tab === 'settings' && (
            <>
              <label className="adm-switch">
                <input type="checkbox" checked={authOn} onChange={(e) => toggleSetting('authEnabled', e.target.checked)} />
                <span className="adm-sw-txt">
                  <b>Требовать вход в приложение</b>
                  <i>Выключено — приложение работает как раньше, без логина и пароля (режим разработки и тестов)</i>
                </span>
                <span className={'adm-badge' + (authOn ? ' on' : ' off')}>{authOn ? 'включена' : 'выключена'}</span>
              </label>
              <label className="adm-switch">
                <input type="checkbox" checked={regOn} onChange={(e) => toggleSetting('registrationEnabled', e.target.checked)} />
                <span className="adm-sw-txt">
                  <b>Разрешить регистрацию по ссылкам-приглашениям</b>
                  <i>Выключено — существующие ссылки перестают работать до включения</i>
                </span>
                <span className={'adm-badge' + (regOn ? ' on' : ' off')}>{regOn ? 'открыта' : 'закрыта'}</span>
              </label>
              <p className="adm-note">
                Изменения применяются сразу: на странице приложения состояние проверяется при загрузке.
                Ссылка на эту панель нигде в приложении не показывается — вход только по адресу с секретным хешем.
              </p>
            </>
          )}

          {tab === 'invites' && (
            <>
              <div className="adm-create">
                <label className="adm-field">
                  <span>Регистраций по ссылке</span>
                  <input className="au-input" type="number" min={0} max={10000} value={newMaxUses} onChange={(e) => setNewMaxUses(e.target.value)} />
                  <i className="adm-field-note">1 — одноразовая · N — N регистраций · 0 — без ограничений</i>
                </label>
                <label className="adm-field adm-field-grow">
                  <span>Заметка (для себя)</span>
                  <input className="au-input" value={newNote} onChange={(e) => setNewNote(e.target.value)} placeholder="напр. для Маши" />
                </label>
                <button className="au-btn" type="button" onClick={createInvite}>Создать ссылку</button>
              </div>

              <div className="adm-list">
                {invites.length === 0 && <div className="adm-empty">Ссылок пока нет</div>}
                {invites.map((inv) => (
                  <div className="adm-row" key={inv.id}>
                    <div className="adm-row-main">
                      <code className="adm-code" title={inv.code}>{inv.code}</code>
                      {inv.note && <span className="adm-note-chip">{inv.note}</span>}
                      <span className={'adm-badge' + (inv.disabled ? ' off' : (inv.maxUses > 0 && inv.uses >= inv.maxUses) ? ' done' : ' on')}>
                        {inv.disabled ? 'отключена' : (inv.maxUses > 0 && inv.uses >= inv.maxUses) ? 'исчерпана' : 'активна'}
                      </span>
                    </div>
                    <div className="adm-row-sub">
                      <span className="adm-uses">использовано: {inv.uses}{inv.maxUses > 0 ? ' из ' + inv.maxUses : ' — без лимита'}</span>
                    </div>
                    <div className="adm-acts">
                      <button className="adm-ib" type="button" title="Скопировать ссылку регистрации" onClick={() => copyLink(inv.code)}>копировать</button>
                      <button className="adm-ib" type="button" onClick={() => toggleInvite(inv)}>{inv.disabled ? 'включить' : 'отключить'}</button>
                      <button className="adm-ib danger" type="button" onClick={() => deleteInvite(inv)}>удалить</button>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}

          {tab === 'users' && (
            <div className="adm-list">
              {users.length === 0 && <div className="adm-empty">Аккаунтов пока нет</div>}
              {users.map((u) => (
                <div className="adm-row" key={u.id}>
                  <div className="adm-row-main">
                    <b className="adm-login">{u.displayName || u.login}</b>
                    <span className="adm-login-sub">@{u.login}</span>
                    <span className={'adm-badge' + (u.disabled ? ' off' : ' on')}>{u.disabled ? 'отключён' : 'активен'}</span>
                  </div>
                  <div className="adm-row-sub">
                    <span className="adm-uses">создан: {new Date(u.createdAt).toLocaleDateString('ru-RU')}</span>
                  </div>
                  <div className="adm-acts">
                    <button className="adm-ib" type="button" onClick={() => toggleUser(u)}>{u.disabled ? 'включить' : 'отключить'}</button>
                    <button className="adm-ib danger" type="button" onClick={() => deleteUser(u)}>удалить</button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
