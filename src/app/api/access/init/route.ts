import { NextRequest, NextResponse } from 'next/server';

import { currentUser } from '@/lib/auth';
import { db } from '@/lib/db';

/** POST /api/access/init {roomId, projectId?, projectName?} — заявить владение
 *  комнатой (создание комнаты / первый вошедший с обновления). Идемпотентно:
 *  если запись уже есть — роль не меняется; если владелец уже есть — молчим. */
export async function POST(req: NextRequest) {
  try {
    const me = await currentUser();
    if (!me) return NextResponse.json({ error: 'Нужен вход' }, { status: 401 });

    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return NextResponse.json({ error: 'Некорректные данные' }, { status: 400 });

    const roomId = typeof body.roomId === 'string' ? body.roomId : '';
    if (roomId.length < 1 || roomId.length > 256) {
      return NextResponse.json({ error: 'Некорректный roomId' }, { status: 400 });
    }

    const projectId = typeof body.projectId === 'string' && body.projectId ? body.projectId : null;
    const projectName = typeof body.projectName === 'string' && body.projectName ? body.projectName : null;

    const mine = await db.projectAccess.findUnique({
      where: { roomId_userId: { roomId, userId: me.id } },
    });
    if (mine) {
      /* запись есть: роль не меняется, свежие имя проекта/название подтянем */
      if ((projectId && projectId !== mine.projectId) || (projectName && projectName !== mine.projectName)) {
        await db.projectAccess.update({
          where: { id: mine.id },
          data: { projectId: projectId || mine.projectId, projectName: projectName || mine.projectName },
        });
      }
      return NextResponse.json({ ok: true, role: mine.role });
    }

    const ownerRecord = await db.projectAccess.findFirst({ where: { roomId, role: 'owner' } });
    if (ownerRecord) {
      return NextResponse.json({ ok: true, role: null });
    }

    await db.projectAccess.create({
      data: {
        roomId,
        userId: me.id,
        role: 'owner',
        projectId,
        projectName,
        ownerName: me.displayName || me.login,
      },
    });

    return NextResponse.json({ ok: true, role: 'owner' });
  } catch {
    return NextResponse.json({ error: 'Внутренняя ошибка' }, { status: 500 });
  }
}
