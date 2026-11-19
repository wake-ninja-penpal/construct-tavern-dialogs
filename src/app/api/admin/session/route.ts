import { NextResponse } from 'next/server';

import { ADMIN_COOKIE, adminConfigured, isAdmin, issueAdminToken, setAdminPassword, verifyAdminPassword } from '@/lib/auth';

/** GET /api/admin/session — задан ли пароль админки и есть ли доступ. */
export async function GET() {
  return NextResponse.json({ configured: await adminConfigured(), authed: await isAdmin() });
}

/** POST /api/admin/session {password} — вход админа; при первом входе пароль
 *  запоминается (bootstrap) — дальше только по нему. */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { password?: string } | null;
  const password = String(body?.password || '');
  if (!password) return NextResponse.json({ error: 'Введите пароль' }, { status: 400 });

  if (!(await adminConfigured())) {
    await setAdminPassword(password);
    const token = await issueAdminToken();
    const res = NextResponse.json({ configured: true, authed: true, bootstrapped: true });
    res.cookies.set(ADMIN_COOKIE, token, { httpOnly: true, sameSite: 'strict', path: '/', maxAge: 12 * 60 * 60 });
    return res;
  }

  if (!(await verifyAdminPassword(password))) {
    return NextResponse.json({ error: 'Неверный пароль' }, { status: 401 });
  }
  const token = await issueAdminToken();
  const res = NextResponse.json({ configured: true, authed: true });
  res.cookies.set(ADMIN_COOKIE, token, { httpOnly: true, sameSite: 'strict', path: '/', maxAge: 12 * 60 * 60 });
  return res;
}
