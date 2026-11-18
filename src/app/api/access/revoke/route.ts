import { NextRequest, NextResponse } from 'next/server';

import { currentUser } from '@/lib/auth';
import { db } from '@/lib/db';

/** POST /api/access/revoke {roomId, login} — забрать доступ (владелец).
 *  У пользователя остаётся уведомление об отзыве. */
export async function POST(req: NextRequest) {
  try {
    const caller = await currentUser();
    if (!caller) return NextResponse.json({ error: 'Нужен вход' }, { status: 401 });

    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return NextResponse.json({ error: 'Некорректные данные' }, { status: 400 });

    const roomId = typeof body.roomId === 'string' ? body.roomId : '';
    if (roomId.length < 1 || roomId.length > 256) {
      return NextResponse.json({ error: 'Некорректный roomId' }, { status: 400 });
    }

    const callerAccess = await db.projectAccess.findUnique({
      where: { roomId_userId: { roomId, userId: caller.id } },
    });
    if (!callerAccess || callerAccess.role !== 'owner') {
      return NextResponse.json({ error: 'Только владелец может управлять доступами' }, { status: 403 });
    }

    const login = typeof body.login === 'string' ? body.login.trim().toLowerCase() : '';
    if (!login) return NextResponse.json({ error: 'Некорректные данные' }, { status: 400 });

    const target = await db.authUser.findUnique({ where: { login } });
    if (!target) return NextResponse.json({ error: 'Пользователь не найден' }, { status: 404 });

    const targetAccess = await db.projectAccess.findUnique({
      where: { roomId_userId: { roomId, userId: target.id } },
    });
    if (!targetAccess) return NextResponse.json({ error: 'Доступ не найден' }, { status: 404 });
    if (targetAccess.role === 'owner') {
      return NextResponse.json({ error: 'Нельзя отозвать доступ у владельца' }, { status: 400 });
    }

    await db.projectAccess.delete({ where: { id: targetAccess.id } });

    await db.notification.create({
      data: {
        userId: target.id,
        type: 'access_revoked',
        payload: JSON.stringify({
          roomId,
          projectName: targetAccess.projectName,
          ownerName: caller.displayName || caller.login,
        }),
      },
    });

    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error(`[access/revoke] ошибка:`, e);
    return NextResponse.json({ error: 'Внутренняя ошибка' }, { status: 500 });
  }
}
