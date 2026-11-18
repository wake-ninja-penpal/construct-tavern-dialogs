import { NextRequest, NextResponse } from 'next/server';

import { currentUser, hashPassword, verifyPassword } from '@/lib/auth';
import { db } from '@/lib/db';

/** POST /api/auth/account {displayName?, currentPassword?, newPassword?} —
 *  редактирование аккаунта. Имя (displayName) меняется свободно; НИК (логин)
 *  изменить нельзя. Пароль меняется только с подтверждением текущего.
 *  Имя аккаунта — то самое имя в комнатах/журналах (сервер берёт его из БД). */
export async function POST(req: NextRequest) {
  try {
    const me = await currentUser();
    if (!me) return NextResponse.json({ error: 'Нужен вход' }, { status: 401 });

    const body = (await req.json().catch(() => null)) as
      | { displayName?: string; currentPassword?: string; newPassword?: string }
      | null;
    if (!body) return NextResponse.json({ error: 'Некорректные данные' }, { status: 400 });

    const data: { displayName?: string; passwordHash?: string } = {};

    /* имя: если поле передано — обновляем (пустое = ник) */
    if (typeof body.displayName === 'string') {
      const name = body.displayName.trim().slice(0, 60);
      data.displayName = name || me.login; /* стёрли имя — вернём ник */
    }

    /* пароль: только оба поля вместе, с проверкой текущего */
    const cur = typeof body.currentPassword === 'string' ? body.currentPassword : '';
    const next = typeof body.newPassword === 'string' ? body.newPassword : '';
    if (cur || next) {
      if (!cur || !next) {
        return NextResponse.json({ error: 'Для смены пароля нужны текущий и новый пароли' }, { status: 400 });
      }
      if (!verifyPassword(cur, me.passwordHash)) {
        return NextResponse.json({ error: 'Текущий пароль неверен' }, { status: 403 });
      }
      if (next.length < 4) {
        return NextResponse.json({ error: 'Новый пароль — минимум 4 символа' }, { status: 400 });
      }
      data.passwordHash = hashPassword(next);
    }

    if (!Object.keys(data).length) {
      return NextResponse.json({ error: 'Нечего менять' }, { status: 400 });
    }

    const updated = await db.authUser.update({ where: { id: me.id }, data });
    return NextResponse.json({
      ok: true,
      nameChanged: 'displayName' in data,
      passwordChanged: 'passwordHash' in data,
      user: {
        login: updated.login,
        displayName: updated.displayName || updated.login,
        color: updated.color,
      },
    });
  } catch {
    return NextResponse.json({ error: 'Внутренняя ошибка' }, { status: 500 });
  }
}
