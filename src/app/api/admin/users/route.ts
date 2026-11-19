import { NextResponse } from 'next/server';

import { isAdmin } from '@/lib/auth';
import { db } from '@/lib/db';

/** GET /api/admin/users — список всех аккаунтов. */
export async function GET() {
  if (!(await isAdmin())) return NextResponse.json({ error: 'Только для администратора' }, { status: 403 });
  const list = await db.authUser.findMany({
    orderBy: { createdAt: 'desc' },
    select: { id: true, login: true, displayName: true, disabled: true, createdAt: true },
  });
  return NextResponse.json({ list });
}
