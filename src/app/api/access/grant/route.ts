import { NextRequest, NextResponse } from 'next/server';

import { currentUser } from '@/lib/auth';
import { db } from '@/lib/db';

/** POST /api/access/grant {roomId, login, role, projectId?, projectName?} —
 *  открыть доступ пользователю по ЛОГИНУ аккаунта. Получателю создаётся
 *  уведомление (access_granted) — проект появится у него в списке. */
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

    const role = typeof body.role === 'string' ? body.role : '';
    if (role !== 'editor' && role !== 'reader') {
      return NextResponse.json({ error: 'Некорректная роль' }, { status: 400 });
    }

    const callerAccess = await db.projectAccess.findUnique({
      where: { roomId_userId: { roomId, userId: caller.id } },
    });
    if (!callerAccess || callerAccess.role !== 'owner') {
      return NextResponse.json({ error: 'Только владелец может управлять доступами' }, { status: 403 });
    }

    const login = typeof body.login === 'string' ? body.login.trim().toLowerCase() : '';
    if (!login) return NextResponse.json({ error: 'Некорректный логин' }, { status: 400 });

    const target = await db.authUser.findUnique({ where: { login } });
    if (!target) return NextResponse.json({ error: 'Пользователь с таким логином не найден' }, { status: 404 });
    if (target.id === caller.id) {
      return NextResponse.json({ error: 'Это ваш собственный доступ' }, { status: 400 });
    }
    if (target.disabled) return NextResponse.json({ error: 'Аккаунт отключён' }, { status: 400 });

    const targetAccess = await db.projectAccess.findUnique({
      where: { roomId_userId: { roomId, userId: target.id } },
    });
    if (targetAccess && targetAccess.role === 'owner') {
      return NextResponse.json({ error: 'Пользователь уже владелец' }, { status: 400 });
    }

    const projectId = typeof body.projectId === 'string' && body.projectId ? body.projectId : null;
    const projectName = typeof body.projectName === 'string' && body.projectName ? body.projectName : null;

    await db.projectAccess.upsert({
      where: { roomId_userId: { roomId, userId: target.id } },
      update: {
        role,
        ...(projectId ? { projectId } : {}),
        ...(projectName ? { projectName } : {}),
      },
      create: {
        roomId,
        userId: target.id,
        role,
        projectId,
        projectName,
        ownerName: caller.displayName || caller.login,
      },
    });

    await db.notification.create({
      data: {
        userId: target.id,
        type: 'access_granted',
        payload: JSON.stringify({
          roomId,
          projectId,
          projectName,
          role,
          granterName: caller.displayName || caller.login,
          ownerName: caller.displayName || caller.login,
        }),
      },
    });

    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: 'Внутренняя ошибка' }, { status: 500 });
  }
}
