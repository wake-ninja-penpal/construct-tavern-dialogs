import { NextResponse } from 'next/server';

import { USER_COOKIE, authEnabled, checkInvite, createSession, hashPassword, pickUserColor, registrationEnabled } from '@/lib/auth';
import { db } from '@/lib/db';

/** POST /api/auth/register {code, login, password, displayName} — регистрация
 *  ТОЛЬКО по ссылке-инвайту от админа. Расходует использование ссылки. */
export async function POST(req: Request) {
  if (!(await authEnabled())) {
    return NextResponse.json({ error: 'Авторизация отключена' }, { status: 400 });
  }
  if (!(await registrationEnabled())) {
    return NextResponse.json({ error: 'Регистрация закрыта администратором' }, { status: 403 });
  }
  const body = (await req.json().catch(() => null)) as
    | { code?: string; login?: string; password?: string; displayName?: string }
    | null;
  const code = String(body?.code || '').trim();
  const login = String(body?.login || '').trim();
  const password = String(body?.password || '');
  const displayName = String(body?.displayName || '').trim();
  if (!code) return NextResponse.json({ error: 'Отсутствует код ссылки-приглашения' }, { status: 400 });
  if (!/^[a-zA-Z0-9_.-]{3,40}$/.test(login)) {
    return NextResponse.json({ error: 'Логин: 3–40 символов, латиница/цифры/._-' }, { status: 400 });
  }
  if (password.length < 4) {
    return NextResponse.json({ error: 'Пароль — минимум 4 символа' }, { status: 400 });
  }

  const inv = await checkInvite(code);
  if (!inv.ok) return NextResponse.json({ error: inv.reason }, { status: 403 });

  const exists = await db.authUser.findUnique({ where: { login } });
  if (exists) return NextResponse.json({ error: 'Такой логин уже занят' }, { status: 409 });

  const user = await db.authUser.create({
    data: { login, passwordHash: hashPassword(password), displayName: displayName || null, color: pickUserColor() },
  });
  await db.inviteLink.update({ where: { code }, data: { uses: { increment: 1 } } });

  const { token, expiresAt } = await createSession(user.id);
  const res = NextResponse.json({ user: { login: user.login, displayName: user.displayName || user.login } });
  res.cookies.set(USER_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    expires: expiresAt,
  });
  return res;
}
