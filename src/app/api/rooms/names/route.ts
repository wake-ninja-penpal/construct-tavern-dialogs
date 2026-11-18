import { NextResponse } from 'next/server';

import { currentUser } from '@/lib/auth';
import { db } from '@/lib/db';

/** POST /api/rooms/names — актуальные названия проектов по комнатам.
 *  Список «Мои проекты» хранится в localStorage и устаревает, пока проект
 *  закрыт: кто-то из соавторов мог переименовать его в комнате. Сервер
 *  (vetvi-sync) обновляет projectName в ProjectAccess при каждой публикации
 *  документа — здесь отдаём свежие имена, клиент обновляет реестр. */
export async function POST(req: Request) {
  try {
    const me = await currentUser();
    if (!me) return NextResponse.json({ error: 'Нужен вход' }, { status: 401 });

    const body = (await req.json().catch(() => null)) as { roomIds?: unknown } | null;
    const ids = Array.isArray(body?.roomIds)
      ? (body!.roomIds as unknown[]).filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length <= 256).slice(0, 200)
      : [];
    if (!ids.length) return NextResponse.json({ names: {} });

    /* комнаты, к которым у меня есть доступ (владелец/участник): чужие комнаты
       не раскрываем — названия видны только тем, кто имеет запись доступа */
    const rows = await db.projectAccess.findMany({
      where: { roomId: { in: ids }, userId: me.id },
      select: { roomId: true, projectName: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
    });

    const names: Record<string, string> = {};
    for (const r of rows) {
      if (r.projectName && !(r.roomId in names)) names[r.roomId] = r.projectName;
    }
    return NextResponse.json({ names });
  } catch (e) {
    console.error('[rooms/names] ошибка:', e);
    return NextResponse.json({ error: 'Внутренняя ошибка' }, { status: 500 });
  }
}
