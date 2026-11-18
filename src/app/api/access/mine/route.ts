import { NextResponse } from 'next/server';

import { currentUser } from '@/lib/auth';
import { db } from '@/lib/db';
import { syncRoomsStatus } from '@/lib/syncNotify';

/** GET /api/access/mine — комнаты/проекты, к которым у меня есть доступ
 *  (раздел «Вам открыли доступ» в списке проектов + openShared).
 *  Для каждой комнаты — флаг online: жива ли она на realtime-сервере.
 *  Выключенный владельцем сетевой режим удаляет комнату — такой проект
 *  помечается офлайн и не открывается. null = статус неизвестен
 *  (sync недоступен) — клиент не блокирует открытие, решает сервер комнат. */
export async function GET() {
  try {
    const me = await currentUser();
    if (!me) return NextResponse.json({ error: 'Нужен вход' }, { status: 401 });

    const records = await db.projectAccess.findMany({
      where: { userId: me.id },
      orderBy: { createdAt: 'desc' },
    });

    const roomIds = [...new Set(records.map((r) => r.roomId))];
    const status = roomIds.length ? await syncRoomsStatus(roomIds) : null;

    const items = records.map((r) => ({
      roomId: r.roomId,
      projectId: r.projectId,
      projectName: r.projectName,
      role: r.role,
      ownerName: r.ownerName,
      online: status ? (status[r.roomId]?.online ?? null) : null,
    }));

    return NextResponse.json({ items });
  } catch (e) {
    console.error(`[access/mine] ошибка:`, e);
    return NextResponse.json({ error: 'Внутренняя ошибка' }, { status: 500 });
  }
}
