import { NextResponse } from 'next/server';

import { isAdmin } from '@/lib/auth';
import { db } from '@/lib/db';

type Ctx = { params: Promise<{ id: string }> };

/** PATCH /api/admin/users/:id {disabled} — отключить/включить аккаунт.
 *  Отключённый не может войти, его сессии аннулируются при обращении. */
export async function PATCH(req: Request, ctx: Ctx) {
  if (!(await isAdmin())) return NextResponse.json({ error: 'Только для администратора' }, { status: 403 });
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => null)) as { disabled?: boolean } | null;
  if (typeof body?.disabled !== 'boolean') {
    return NextResponse.json({ error: 'Нужно поле disabled' }, { status: 400 });
  }
  try {
    const u = await db.authUser.update({
      where: { id },
      data: { disabled: body.disabled },
      select: { id: true, login: true, displayName: true, disabled: true, createdAt: true },
    });
    /* при отключении сразу выкинуть из всех сессий */
    if (body.disabled) await db.authSession.deleteMany({ where: { userId: id } });
    return NextResponse.json({ user: u });
  } catch {
    return NextResponse.json({ error: 'Аккаунт не найден' }, { status: 404 });
  }
}

/** DELETE /api/admin/users/:id — удалить аккаунт (вместе с сессиями). */
export async function DELETE(_req: Request, ctx: Ctx) {
  if (!(await isAdmin())) return NextResponse.json({ error: 'Только для администратора' }, { status: 403 });
  const { id } = await ctx.params;
  await db.authUser.deleteMany({ where: { id } });
  return NextResponse.json({ ok: true });
}
