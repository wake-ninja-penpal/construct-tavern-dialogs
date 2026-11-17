import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';

import { USER_COOKIE, dropSession } from '@/lib/auth';

/** POST /api/auth/logout — удалить сессию и cookie. */
export async function POST() {
  const jar = await cookies();
  const token = jar.get(USER_COOKIE)?.value;
  if (token) await dropSession(token);
  const res = NextResponse.json({ ok: true });
  res.cookies.set(USER_COOKIE, '', { httpOnly: true, sameSite: 'lax', path: '/', maxAge: 0 });
  return res;
}
