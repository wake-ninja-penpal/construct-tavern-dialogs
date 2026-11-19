import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { canEditProject, requireTaskService } from '@/lib/tasks'

/**
 * PATCH /api/tm/boards/[id] — переименование/порядок доски.
 * DELETE /api/tm/boards/[id] — удалить доску: задачи уходят в бэклог проекта
 * (не теряются), колонки стираются каскадом.
 */
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireTaskService()
    if (!user) return NextResponse.json({ error: 'Сервис недоступен' }, { status: 403 })
    const { id } = await ctx.params
    const board = await db.taskBoard.findUnique({ where: { id } })
    if (!board) return NextResponse.json({ error: 'Доска не найдена' }, { status: 404 })
    if (!(await canEditProject(board.projectId, user.login))) {
      return NextResponse.json({ error: 'Недостаточно прав: режим наблюдателя' }, { status: 403 })
    }
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null
    if (!body) return NextResponse.json({ error: 'Некорректные данные' }, { status: 400 })
    const data: Record<string, unknown> = {}
    if (typeof body.title === 'string' && body.title.trim()) data.title = body.title.trim().slice(0, 120)
    if (typeof body.sortOrder === 'number' && Number.isFinite(body.sortOrder)) data.sortOrder = Math.round(body.sortOrder)
    if (!Object.keys(data).length) return NextResponse.json({ error: 'Нет полей для обновления' }, { status: 400 })
    const item = await db.taskBoard.update({ where: { id }, data })
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
    const board = await db.taskBoard.findUnique({ where: { id } })
    if (!board) return NextResponse.json({ error: 'Доска не найдена' }, { status: 404 })
    if (!(await canEditProject(board.projectId, user.login))) {
      return NextResponse.json({ error: 'Недостаточно прав: режим наблюдателя' }, { status: 403 })
    }
    /* задачи доски возвращаются в бэклог проекта */
    await db.taskItem.updateMany({ where: { boardId: id }, data: { boardId: null, columnId: null } })
    await db.taskBoard.delete({ where: { id } })
    return NextResponse.json({ ok: true })
  } catch {
    return NextResponse.json({ error: 'Внутренняя ошибка' }, { status: 500 })
  }
}
