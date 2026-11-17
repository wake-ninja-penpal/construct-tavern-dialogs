'use client';

/**
 * «Ветви» — заготовка авторизации: полноэкранный вход/регистрация.
 *
 * Показывается, когда в админке включена авторизация и пользователь не залогинен.
 * Регистрация — ТОЛЬКО по ссылке-приглашению от администратора: открывается,
 * когда в адресе есть код инвайта (?invite=КОД). Если регистрации по ссылке
 * нет — форма входа с подсказкой.
 *
 * Если авторизация выключена в админке, гейт не показывается вовсе —
 * приложение работает как раньше (режим разработки/тестов).
 */

import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';

import { authApplyState } from './auth';

export interface AuthStateUser {
  id: string;
  login: string;
  displayName: string;
  color: string;
  token?: string | null;
}

export interface AuthState {
  authEnabled: boolean;
  registrationEnabled: boolean;
  user: AuthStateUser | null;
}

export async function fetchAuthState(): Promise<AuthState> {
  const r = await fetch('/api/auth/state', { cache: 'no-store' });
  if (!r.ok) throw new Error('state ' + r.status);
  return (await r.json()) as AuthState;
}

/** Код приглашения из адреса: ?invite=КОД (ссылка, которую выдаёт админ). */
export function inviteFromUrl(): string {
  if (typeof window === 'undefined') return '';
  const u = new URL(window.location.href);
  return (u.searchParams.get('invite') || '').trim();
}

export function AuthGate(props: { onPass: () => void }) {
  const invite = useRef(inviteFromUrl());
  const [mode, setMode] = useState<'login' | 'register'>(invite.current ? 'register' : 'login');
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  /* если кода в адресе нет, но регистрация открыта — дать вставить код вручную */
  const [manualInvite, setManualInvite] = useState('');
  const [regOpen, setRegOpen] = useState(true);

  useEffect(() => {
    let alive = true;
    void fetchAuthState().then((st) => {
      if (alive) setRegOpen(st.registrationEnabled);
    }).catch(() => undefined);
    return () => { alive = false; };
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setErr('');
    setBusy(true);
    try {
      const url = mode === 'login' ? '/api/auth/login' : '/api/auth/register';
      const payload = mode === 'login'
        ? { login, password }
        : { code: (invite.current || manualInvite).trim(), login, password, displayName };
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const j = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) {
        setErr(j.error || 'Не удалось выполнить запрос');
        return;
      }
      /* перезагрузка: сессия в cookie, адрес очищаем от ?invite */
      const u = new URL(window.location.href);
      u.searchParams.delete('invite');
      window.location.replace(u.pathname + u.search + u.hash);
    } catch {
      setErr('Сервер недоступен');
    } finally {
      setBusy(false);
    }
  };

  const code = invite.current || manualInvite;

  return (
    <main className="au-wrap" role="main" aria-label="Вход в Ветви">
      <form className="au-card" onSubmit={submit}>
        <div className="au-brand">
          <svg viewBox="0 0 24 24" fill="none" width={30} height={30} aria-hidden="true">
            <path d="M7.5 12h3c3.2 0 2.4-6.5 6-6.5M10.5 12c3.2 0 2.4 6.5 6 6.5" stroke="#4d535e" strokeWidth="1.6" strokeLinecap="round" />
            <circle cx="5.5" cy="12" r="2.6" fill="#e2a54e" />
            <circle cx="18.5" cy="5.5" r="2.1" fill="#9cb878" />
            <circle cx="18.5" cy="18.5" r="2.1" fill="#cf6d4f" />
          </svg>
          <span className="au-lg">ВЕТВИ</span>
        </div>

        {mode === 'register' ? (
          <>
            <h1 className="au-title">Регистрация по ссылке</h1>
            <p className="au-hint">
              {code
                ? 'Код приглашения из ссылки — придумайте логин и пароль.'
                : 'Вставьте код из ссылки-приглашения администратора.'}
            </p>
            {!invite.current && (
              <label className="au-field">
                <span>Код приглашения</span>
                <input
                  className="au-input"
                  value={manualInvite}
                  onChange={(e) => setManualInvite(e.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                  required
                />
              </label>
            )}
            <label className="au-field">
              <span>Логин</span>
              <input
                className="au-input"
                value={login}
                onChange={(e) => setLogin(e.target.value)}
                autoComplete="username"
                spellCheck={false}
                required
              />
            </label>
            <label className="au-field">
              <span>Пароль</span>
              <input
                className="au-input"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="new-password"
                required
              />
            </label>
            <label className="au-field">
              <span>Имя (как показывать другим)</span>
              <input
                className="au-input"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                autoComplete="off"
              />
            </label>
            {!regOpen && <div className="au-err">Регистрация сейчас закрыта администратором</div>}
            {err && <div className="au-err">{err}</div>}
            <button className="au-btn" type="submit" disabled={busy || !regOpen}>
              {busy ? 'Создаю аккаунт…' : 'Создать аккаунт'}
            </button>
            <button className="au-alt" type="button" onClick={() => { setMode('login'); setErr(''); }}>
              У меня уже есть аккаунт — войти
            </button>
          </>
        ) : (
          <>
            <h1 className="au-title">Вход</h1>
            <p className="au-hint">Введите логин и пароль. Регистрация — только по ссылке от администратора.</p>
            <label className="au-field">
              <span>Логин</span>
              <input
                className="au-input"
                value={login}
                onChange={(e) => setLogin(e.target.value)}
                autoComplete="username"
                spellCheck={false}
                required
              />
            </label>
            <label className="au-field">
              <span>Пароль</span>
              <input
                className="au-input"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                required
              />
            </label>
            {err && <div className="au-err">{err}</div>}
            <button className="au-btn" type="submit" disabled={busy}>
              {busy ? 'Вхожу…' : 'Войти'}
            </button>
            {regOpen && (
              <button className="au-alt" type="button" onClick={() => { setMode('register'); setErr(''); }}>
                Есть ссылка-приглашение? Регистрация
              </button>
            )}
          </>
        )}
      </form>
    </main>
  );
}
