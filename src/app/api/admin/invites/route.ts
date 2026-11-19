import { NextResponse } from 'next/server';

import { inviteCode, isAdmin } from '@/lib/auth';
import { db } from '@/lib/db';

/** GET /api/admin/invites — все ссылки-приглашения. */
export async function GET() {
  if (!(await isAdmin())) return NextResponse.json({ error: 'Только для администратора' }, { status: 403 });
  const list = await db.inviteLink.findMany({ orderBy: { createdAt: 'desc' } });
  return NextResponse.json({ list });
}

/** POST /api/admin/invites {maxUses, note} — создать ссылку.
 *  maxUses=1 — одноразовая; maxUses=0 — без ограничений; N — N регистраций. */
export async function POST(req: Request) {
  if (!(await isAdmin())) return NextResponse.json({ error: 'Только для администратора' }, { status: 403 });
  const body = (await req.json().catch(() => null)) as { maxUses?: number; note?: string } | null;
  let maxUses = Number(body?.maxUses);
  if (!Number.isFinite(maxUses) || maxUses < 0) maxUses = 1;
  maxUses = Math.min(10000, Math.floor(maxUses));
  const note = String(body?.note || '').trim().slice(0, 120) || null;
  const inv = await db.inviteLink.create({ data: { code: inviteCode(), maxUses, note } });
  return NextResponse.json({ invite: inv });
}
