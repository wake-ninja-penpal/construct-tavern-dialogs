import { NextResponse } from 'next/server';

import { authEnabled, currentUser } from '@/lib/auth';
import { db } from '@/lib/db';

/** GET /api/project-access?projectId=... — кто имеет доступ к проекту.
 *  Пока авторизация выключена — пустой список (доступы не применяются). */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const projectId = String(url.searchParams.get('projectId') || '').trim();
  if (!projectId) return NextResponse.json({ error: 'Нужен projectId' }, { status: 400 });
  const [me, authOn] = await Promise.all([currentUser(), authEnabled()]);
  const list = await db.projectAccess.findMany({ where: { projectId }, orderBy: { createdAt: 'asc' } });
  return NextResponse.json({
    list,
    authEnabled: authOn,
    me: me ? me.login : null,
  });
}

/** POST /api/project-access {projectId, login, role} — выдать доступ. */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as
    | { projectId?: string; login?: string; role?: string }
    | null;
  const projectId = String(body?.projectId || '').trim();
  const login = String(body?.login || '').trim();
  const role = body?.role === 'viewer' ? 'viewer' : 'editor';
  if (!projectId || !login) return NextResponse.json({ error: 'Нужны projectId и login' }, { status: 400 });
  const rec = await db.projectAccess.upsert({
    where: { projectId_login: { projectId, login } },
    create: { projectId, login, role },
    update: { role },
  });
  return NextResponse.json({ entry: rec });
}

/** DELETE /api/project-access?projectId=...&login=... — забрать доступ. */
export async function DELETE(req: Request) {
  const url = new URL(req.url);
  const projectId = String(url.searchParams.get('projectId') || '').trim();
  const login = String(url.searchParams.get('login') || '').trim();
  if (!projectId || !login) return NextResponse.json({ error: 'Нужны projectId и login' }, { status: 400 });
  await db.projectAccess.deleteMany({ where: { projectId, login } });
  return NextResponse.json({ ok: true });
}
