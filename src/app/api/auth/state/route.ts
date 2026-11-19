import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

import { USER_COOKIE, authEnabled, currentUser, publicUser, registrationEnabled } from '@/lib/auth';

/** GET /api/auth/state — нужен ли вход и кто сейчас залогинен.
 *  Для залогиненного отдаём публичные данные аккаунта (id/логин/имя/цвет) и
 *  токен сессии: его кладёт в vetvi:join клиент — сервер vetvi-sync проверяет
 *  сессию по общей БД и берёт имя/цвет из записи AuthUser (в комнате их менять
 *  нельзя). */
export async function GET() {
  const [authOn, regOn, user, jar] = await Promise.all([
    authEnabled(),
    registrationEnabled(),
    currentUser(),
    cookies(),
  ]);
  const token = jar.get(USER_COOKIE)?.value || null;
  return NextResponse.json({
    authEnabled: authOn,
    registrationEnabled: regOn,
    user: user ? { ...publicUser(user), token } : null,
  });
}
