import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireTaskService, sanitizeLinks, sanitizeStickers } from '@/lib/tasks'

/**
 * PATCH /api/tm/tasks/[id] — правка задачи: название/описание/стикеры/связи/
 * выполненность/перенос (boardId+columnId, null+null — бэклог) /порядок.
 *
 * Перенос в колонку с kind='done' помечает задачу выполненной (и наоборот —
 * возвращает в работу), как в прототипе: позиция в колонках = статус.
 *
 * DELETE /api/tm/tasks/[id] — удалить задачу вместе с подзадачами (каскад).
 */
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireTaskService()
    if (!user) return NextResponse.json({ error: 'Сервис недоступен' }, { status: 403 })
    const { id } = await ctx.params
    const task = await db.taskItem.findUnique({ where: { id } })
    if (!task) return NextResponse.json({ error: 'Задача не найдена' }, { status: 404 })
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null
    if (!body) return NextResponse.json({ error: 'Некорректные данные' }, { status: 400 })

    const data: Record<string, unknown> = {}
    if (typeof body.title === 'string' && body.title.trim()) data.title = body.title.trim().slice(0, 200)
    if (typeof body.description === 'string') data.description = body.description.slice(0, 20000)
    if (body.stickers !== undefined) data.stickers = sanitizeStickers(body.stickers)
    if (body.links !== undefined) data.links = sanitizeLinks(body.links)

    /* перенос между колонками/досками/бэклогом */
    if ('columnId' in body || 'boardId' in body) {
      const moveCol = typeof body.columnId === 'string' && body.columnId ? body.columnId : null
      const moveBoard = typeof body.boardId === 'string' && body.boardId ? body.boardId : null
      if (moveCol) {
        const col = await db.taskColumn.findUnique({ where: { id: moveCol } })
        if (!col) return NextResponse.json({ error: 'Колонка не найдена' }, { status: 400 })
        data.columnId = moveCol
        data.boardId = col.boardId
        /* семантика системных колонок: позиция = статус */
        if (col.kind === 'done') {
          data.done = true
          data.completedAt = new Date()
        } else if (task.done) {
          data.done = false
          data.completedAt = null
        }
      } else {
        /* бэклог проекта */
        data.columnId = null
        data.boardId = null
        if (task.done) {
          data.done = false
          data.completedAt = null
        }
      }
      void moveBoard
      const last = await db.taskItem.findFirst({
        where: { projectId: task.projectId, columnId: data.columnId as string | null },
        orderBy: { order: 'desc' },
        select: { order: true },
      })
      data.order = (last?.order ?? 0) + 1000
    }
    if (typeof body.order === 'number' && Number.isFinite(body.order)) data.order = body.order

    /* прямой флаг выполненности (задача в бэклоге, без колонок) */
    if (typeof body.done === 'boolean') {
      data.done = body.done
      data.completedAt = body.done ? new Date() : null
    }

    if (!Object.keys(data).length) return NextResponse.json({ error: 'Нет полей для обновления' }, { status: 400 })
    const item = await db.taskItem.update({ where: { id }, data })
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
    /* подзадачи (parentId=id) удаляем вручную — на один уровень вложенности,
       затем сама задача; более глубокие вложения удаляются рекурсивно */
    const deleteDeep = async (pid: string): Promise<void> => {
      const kids = await db.taskItem.findMany({ where: { parentId: pid }, select: { id: true } })
      for (const k of kids) await deleteDeep(k.id)
      await db.taskItem.delete({ where: { id: pid } }).catch(() => undefined)
    }
    await deleteDeep(id)
    return NextResponse.json({ ok: true })
  } catch {
    return NextResponse.json({ error: 'Внутренняя ошибка' }, { status: 500 })
  }
}
