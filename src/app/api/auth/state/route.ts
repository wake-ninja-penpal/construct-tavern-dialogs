import { NextResponse } from 'next/server';

import { authEnabled, currentUser, registrationEnabled } from '@/lib/auth';

/** GET /api/auth/state — нужен ли вход и кто сейчас залогинен. */
export async function GET() {
  const [authOn, regOn, user] = await Promise.all([authEnabled(), registrationEnabled(), currentUser()]);
  return NextResponse.json({
    authEnabled: authOn,
    registrationEnabled: regOn,
    user: user ? { login: user.login, displayName: user.displayName || user.login } : null,
  });
}
