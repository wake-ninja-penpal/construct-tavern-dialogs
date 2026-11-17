import { NextResponse } from 'next/server';

import { authEnabled, isAdmin, registrationEnabled, setSetting } from '@/lib/auth';

/** GET /api/admin/settings — текущие тумблеры. */
export async function GET() {
  if (!(await isAdmin())) return NextResponse.json({ error: 'Только для администратора' }, { status: 403 });
  return NextResponse.json({ authEnabled: await authEnabled(), registrationEnabled: await registrationEnabled() });
}

/** POST /api/admin/settings {authEnabled?, registrationEnabled?} — вкл/выкл.
 *  Авторизация выключена → приложение работает как раньше, без входа. */
export async function POST(req: Request) {
  if (!(await isAdmin())) return NextResponse.json({ error: 'Только для администратора' }, { status: 403 });
  const body = (await req.json().catch(() => null)) as { authEnabled?: boolean; registrationEnabled?: boolean } | null;
  if (typeof body?.authEnabled === 'boolean') await setSetting('authEnabled', body.authEnabled ? '1' : '0');
  if (typeof body?.registrationEnabled === 'boolean') await setSetting('registrationEnabled', body.registrationEnabled ? '1' : '0');
  return NextResponse.json({ authEnabled: await authEnabled(), registrationEnabled: await registrationEnabled() });
}
