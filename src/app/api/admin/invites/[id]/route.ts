import { NextResponse } from 'next/server';

import { isAdmin } from '@/lib/auth';
import { db } from '@/lib/db';

type Ctx = { params: Promise<{ id: string }> };

/** PATCH /api/admin/invites/:id {disabled} — вкл/выкл ссылку. */
export async function PATCH(req: Request, ctx: Ctx) {
  if (!(await isAdmin())) return NextResponse.json({ error: 'Только для администратора' }, { status: 403 });
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => null)) as { disabled?: boolean } | null;
  if (typeof body?.disabled !== 'boolean') {
    return NextResponse.json({ error: 'Нужно поле disabled' }, { status: 400 });
  }
  try {
    const inv = await db.inviteLink.update({ where: { id }, data: { disabled: body.disabled } });
    return NextResponse.json({ invite: inv });
  } catch {
    return NextResponse.json({ error: 'Ссылка не найдена' }, { status: 404 });
  }
}

/** DELETE /api/admin/invites/:id — удалить ссылку. */
export async function DELETE(_req: Request, ctx: Ctx) {
  if (!(await isAdmin())) return NextResponse.json({ error: 'Только для администратора' }, { status: 403 });
  const { id } = await ctx.params;
  await db.inviteLink.deleteMany({ where: { id } });
  return NextResponse.json({ ok: true });
}
