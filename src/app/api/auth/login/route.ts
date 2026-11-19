import { NextResponse } from 'next/server';

import { USER_COOKIE, authEnabled, createSession, currentUser, verifyPassword } from '@/lib/auth';
import { db } from '@/lib/db';

/** POST /api/auth/login {login, password} → cookie-сессия. */
export async function POST(req: Request) {
  if (!(await authEnabled())) {
    return NextResponse.json({ error: 'Авторизация отключена' }, { status: 400 });
  }
  const body = (await req.json().catch(() => null)) as { login?: string; password?: string } | null;
  const login = String(body?.login || '').trim();
  const password = String(body?.password || '');
  if (!login || !password) {
    return NextResponse.json({ error: 'Введите логин и пароль' }, { status: 400 });
  }
  const user = await db.authUser.findUnique({ where: { login } });
  if (!user || !verifyPassword(password, user.passwordHash)) {
    return NextResponse.json({ error: 'Неверный логин или пароль' }, { status: 401 });
  }
  if (user.disabled) {
    return NextResponse.json({ error: 'Аккаунт отключён администратором' }, { status: 403 });
  }
  const { token, expiresAt } = await createSession(user.id);
  const me = await currentUser();
  const res = NextResponse.json({ user: me ? { login: me.login, displayName: me.displayName || me.login } : { login: user.login, displayName: user.displayName || user.login } });
  res.cookies.set(USER_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    expires: expiresAt,
  });
  return res;
}
