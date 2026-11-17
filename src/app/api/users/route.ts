import { NextResponse } from 'next/server';

import { currentUser } from '@/lib/auth';
import { db } from '@/lib/db';

/** GET /api/users — активные аккаунты (логин + имя) для выбора в доступах.
 *  Доступно любому залогиненному пользователю. */
export async function GET() {
  const me = await currentUser();
  if (!me) return NextResponse.json({ error: 'Нужен вход' }, { status: 401 });
  const list = await db.authUser.findMany({
    where: { disabled: false },
    orderBy: { login: 'asc' },
    select: { login: true, displayName: true },
  });
  return NextResponse.json({ list });
}
