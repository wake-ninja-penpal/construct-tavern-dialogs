import { NextResponse } from 'next/server';

import { currentUser } from '@/lib/auth';
import { db } from '@/lib/db';

function parsePayload(payload: string): unknown {
  try {
    return JSON.parse(payload);
  } catch {
    return payload;
  }
}

/** GET /api/notifications — последние 50 уведомлений + число непрочитанных. */
export async function GET() {
  try {
    const me = await currentUser();
    if (!me) return NextResponse.json({ error: 'Нужен вход' }, { status: 401 });

    const [records, unread] = await Promise.all([
      db.notification.findMany({
        where: { userId: me.id },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
      db.notification.count({
        where: { userId: me.id, read: false },
      }),
    ]);

    const items = records.map((n) => ({
      id: n.id,
      type: n.type,
      payload: parsePayload(n.payload),
      read: n.read,
      createdAt: n.createdAt,
    }));

    return NextResponse.json({ items, unread });
  } catch {
    return NextResponse.json({ error: 'Внутренняя ошибка' }, { status: 500 });
  }
}
