import { NextResponse } from 'next/server';

import { currentUser } from '@/lib/auth';
import { db } from '@/lib/db';

/** GET /api/access/mine — комнаты/проекты, к которым у меня есть доступ
 *  (раздел «Вам открыли доступ» в списке проектов + openShared). */
export async function GET() {
  try {
    const me = await currentUser();
    if (!me) return NextResponse.json({ error: 'Нужен вход' }, { status: 401 });

    const records = await db.projectAccess.findMany({
      where: { userId: me.id },
      orderBy: { createdAt: 'desc' },
    });

    const items = records.map((r) => ({
      roomId: r.roomId,
      projectId: r.projectId,
      projectName: r.projectName,
      role: r.role,
      ownerName: r.ownerName,
    }));

    return NextResponse.json({ items });
  } catch (e) {
    console.error(`[access/mine] ошибка:`, e);
    return NextResponse.json({ error: 'Внутренняя ошибка' }, { status: 500 });
  }
}
