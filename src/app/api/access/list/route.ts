import { NextRequest, NextResponse } from 'next/server';

import { currentUser } from '@/lib/auth';
import { db } from '@/lib/db';

const ROLE_ORDER: Record<string, number> = { owner: 0, editor: 1, reader: 2 };

/** GET /api/access/list?roomId=... — кто имеет доступ к комнате.
 *  Список видят ВСЕ участники комнаты (владелец, админ, редактор, читатель):
 *  окно «Поделиться» показывает его каждому, кто открыл проект — раньше
 *  читателям отвечало 403 и у них список выглядел пустым. Гость по ссылке
 *  (без записи ProjectAccess) список не получает — 403 как раньше. */
export async function GET(req: NextRequest) {
  try {
    const me = await currentUser();
    if (!me) return NextResponse.json({ error: 'Нужен вход' }, { status: 401 });

    const roomId = req.nextUrl.searchParams.get('roomId') ?? '';
    if (roomId.length < 1 || roomId.length > 256) {
      return NextResponse.json({ error: 'Некорректный roomId' }, { status: 400 });
    }

    const mine = await db.projectAccess.findUnique({
      where: { roomId_userId: { roomId, userId: me.id } },
    });
    if (!mine) {
      return NextResponse.json({ error: 'Нет доступа к списку' }, { status: 403 });
    }

    const records = await db.projectAccess.findMany({ where: { roomId } });
    const users = await db.authUser.findMany({
      where: { id: { in: records.map((r) => r.userId) } },
      select: { id: true, login: true, displayName: true, color: true },
    });
    const byId = new Map(users.map((u) => [u.id, u] as const));

    const items = records
      .map((r) => {
        const u = byId.get(r.userId);
        return {
          userId: r.userId,
          login: u?.login || '?',
          displayName: u?.displayName || u?.login || '?',
          color: u?.color || '#8b929c',
          role: r.role,
          createdAt: r.createdAt,
        };
      })
      .sort((a, b) => {
        const ra = ROLE_ORDER[a.role] ?? 99;
        const rb = ROLE_ORDER[b.role] ?? 99;
        if (ra !== rb) return ra - rb;
        return String(a.createdAt).localeCompare(String(b.createdAt));
      });

    return NextResponse.json({ me: { role: mine.role }, items });
  } catch (e) {
    console.error(`[access/list] ошибка:`, e);
    return NextResponse.json({ error: 'Внутренняя ошибка' }, { status: 500 });
  }
}
