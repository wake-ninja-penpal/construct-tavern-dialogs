import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireTaskService } from '@/lib/tasks'

/**
 * PATCH /api/tm/columns/[id] — правка колонки: название/цвет/порядок.
 * Системные колонки (locked) переименовывать нельзя — их семантика
 * (Не взяты / В работе / Выполнено) показывает прогресс на нодах «Ветвей».
 * DELETE /api/tm/columns/[id] — удалить колонку: задачи уходят в бэклог.
 */
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireTaskService()
    if (!user) return NextResponse.json({ error: 'Сервис недоступен' }, { status: 403 })
    const { id } = await ctx.params
    const col = await db.taskColumn.findUnique({ where: { id } })
    if (!col) return NextResponse.json({ error: 'Колонка не найдена' }, { status: 404 })
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null
    if (!body) return NextResponse.json({ error: 'Некорректные данные' }, { status: 400 })
    const data: Record<string, unknown> = {}
    if (typeof body.title === 'string' && body.title.trim() && !col.locked) data.title = body.title.trim().slice(0, 80)
    if (typeof body.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(body.color) && !col.locked) data.color = body.color
    if (typeof body.sortOrder === 'number' && Number.isFinite(body.sortOrder)) data.sortOrder = Math.round(body.sortOrder)
    if (!Object.keys(data).length) return NextResponse.json({ error: col.locked ? 'Системную колонку изменить нельзя' : 'Нет полей для обновления' }, { status: 400 })
    const item = await db.taskColumn.update({ where: { id }, data })
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
    const col = await db.taskColumn.findUnique({ where: { id } })
    if (!col) return NextResponse.json({ error: 'Колонка не найдена' }, { status: 404 })
    if (col.locked) return NextResponse.json({ error: 'Системную колонку удалить нельзя' }, { status: 400 })
    await db.taskItem.updateMany({ where: { columnId: id }, data: { boardId: null, columnId: null } })
    await db.taskColumn.delete({ where: { id } })
    return NextResponse.json({ ok: true })
  } catch {
    return NextResponse.json({ error: 'Внутренняя ошибка' }, { status: 500 })
  }
}
