import { NextRequest, NextResponse } from 'next/server';

import { currentUser } from '@/lib/auth';
import { db } from '@/lib/db';

/** POST /api/notifications/read {ids?: string[], all?: boolean} — отметить
 *  уведомления прочитанными (все или по списку id). */
export async function POST(req: NextRequest) {
  try {
    const me = await currentUser();
    if (!me) return NextResponse.json({ error: 'Нужен вход' }, { status: 401 });

    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return NextResponse.json({ error: 'Некорректные данные' }, { status: 400 });

    if (body.all === true) {
      await db.notification.updateMany({
        where: { userId: me.id, read: false },
        data: { read: true },
      });
      return NextResponse.json({ ok: true });
    }

    if (Array.isArray(body.ids)) {
      const ids = body.ids.filter((id: unknown): id is string => typeof id === 'string');
      if (ids.length > 0) {
        await db.notification.updateMany({
          where: { id: { in: ids }, userId: me.id },
          data: { read: true },
        });
      }
      return NextResponse.json({ ok: true });
    }

    return NextResponse.json({ error: 'Некорректные данные' }, { status: 400 });
  } catch {
    return NextResponse.json({ error: 'Внутренняя ошибка' }, { status: 500 });
  }
}
