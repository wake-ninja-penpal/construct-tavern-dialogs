import { NextResponse } from 'next/server';

import { currentUser } from '@/lib/auth';
import { db } from '@/lib/db';

/** POST /api/notifications/clear — полностью очистить список уведомлений
 *  аккаунта (кнопка «Очистить список» в попапе колокольчика). */
export async function POST() {
  try {
    const account = await currentUser();
    if (!account) return NextResponse.json({ error: 'Нужен вход' }, { status: 401 });

    const res = await db.notification.deleteMany({ where: { userId: account.id } });
    return NextResponse.json({ ok: true, deleted: res.count });
  } catch (e) {
    console.error('[notifications/clear] ошибка:', e);
    return NextResponse.json({ error: 'Внутренняя ошибка' }, { status: 500 });
  }
}
