import { NextRequest, NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';

import { currentUser } from '@/lib/auth';
import { db } from '@/lib/db';

/** POST /api/access/init {roomId, projectId?, projectName?} — заявить владение
 *  комнатой (создание комнаты / первый вошедший с обновления). Идемпотентно:
 *  если запись уже есть — роль не меняется; если владелец уже есть — молчим.
 *
 *  Гонкоустойчивость: окно «Поделиться» и публикация проекта вызывают init
 *  параллельно — оба запроса не находят запись и оба доходят до INSERT.
 *  Второй ловит P2002 (нарушение уникального ключа roomId+userId) и раньше
 *  отвечал 500 — клиент считал init провалом, окно оставалось без поля
 *  поиска, а join успевал пройти «гостем». Теперь P2002 = «запись уже
 *  создана параллельным запросом» — перечитываем и отвечаем 200. */
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
      /* гонка параллельных init: запись владельца успел создать другой запрос
         С ЭТИМ ЖЕ аккаунтом — для нас это owner, а не «место занято» */
      return NextResponse.json({ ok: true, role: ownerRecord.userId === me.id ? 'owner' : null });
    }

    try {
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
    } catch (e) {
      /* P2002 — запись создала параллельная копия этого же запроса: не ошибка */
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        const winner = await db.projectAccess.findUnique({
          where: { roomId_userId: { roomId, userId: me.id } },
        });
        if (winner) return NextResponse.json({ ok: true, role: winner.role });
      }
      throw e;
    }

    return NextResponse.json({ ok: true, role: 'owner' });
  } catch (e) {
    /* настоящая ошибка — не глотаем молча: без лога в docker logs не видно,
       почему владелец не может заявить комнату (P2002 отфильтрован выше) */
    console.error('[access/init] ошибка:', e);
    return NextResponse.json({ error: 'Внутренняя ошибка' }, { status: 500 });
  }
}
