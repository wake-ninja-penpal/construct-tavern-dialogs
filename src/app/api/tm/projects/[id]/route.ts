import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { canAdminProject, canEditProject, notifyTmChanged, requireTaskService } from '@/lib/tasks'

/**
 * PATCH /api/tm/projects/[id] — переименование/цвет/порядок проекта
 * (editor/admin проекта).
 * DELETE /api/tm/projects/[id] — удалить проект вместе с досками и задачами
 * (каскад по схеме БД) — только админ проекта.
 */
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireTaskService()
    if (!user) return NextResponse.json({ error: 'Сервис недоступен' }, { status: 403 })
    const { id } = await ctx.params
    if (!(await canEditProject(id, user.login))) {
      return NextResponse.json({ error: 'Недостаточно прав: режим наблюдателя' }, { status: 403 })
    }
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null
    if (!body) return NextResponse.json({ error: 'Некорректные данные' }, { status: 400 })
    const data: Record<string, unknown> = {}
    if (typeof body.title === 'string' && body.title.trim()) data.title = body.title.trim().slice(0, 120)
    if (typeof body.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(body.color)) data.color = body.color
    if (typeof body.sortOrder === 'number' && Number.isFinite(body.sortOrder)) data.sortOrder = Math.round(body.sortOrder)
    if (!Object.keys(data).length) return NextResponse.json({ error: 'Нет полей для обновления' }, { status: 400 })
    const item = await db.taskProject.update({ where: { id }, data })
    notifyTmChanged('project-patch')
    return NextResponse.json({ item })
  } catch {
    return NextResponse.json({ error: 'Внутренняя ошибка' }, { status: 500 })
  }
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireTaskService()
    if (!user) return NextResponse.json({ error: 'Сервис недоступен' }, { status: 403 })
    const { id } = await ctx.params
    if (!(await canAdminProject(id, user.login))) {
      return NextResponse.json({ error: 'Удалить проект может только админ проекта' }, { status: 403 })
    }
    await db.taskItem.deleteMany({ where: { projectId: id } })
    await db.taskProject.delete({ where: { id } })
    notifyTmChanged('project-delete')
    return NextResponse.json({ ok: true })
  } catch {
    return NextResponse.json({ error: 'Внутренняя ошибка' }, { status: 500 })
  }
}
