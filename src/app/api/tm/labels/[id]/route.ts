import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { notifyTmChanged, requireTaskService } from '@/lib/tasks'

/**
 * PATCH /api/tm/labels/[id] { name?, color? } — правка метки.
 * DELETE — удалить метку: она снимается со всех задач (labelIds чистятся).
 */
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireTaskService()
    if (!user) return NextResponse.json({ error: 'Сервис недоступен' }, { status: 403 })
    const { id } = await ctx.params
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null
    if (!body) return NextResponse.json({ error: 'Некорректные данные' }, { status: 400 })
    const data: Record<string, unknown> = {}
    if (typeof body.name === 'string' && body.name.trim()) data.name = body.name.trim().slice(0, 20)
    if (typeof body.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(body.color)) data.color = body.color
    if (!Object.keys(data).length) return NextResponse.json({ error: 'Нет полей' }, { status: 400 })
    const item = await db.taskLabel.update({ where: { id }, data })
    notifyTmChanged('label-patch')
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
    /* метка снимается с задач: labelIds — JSON-массив, чистим вхождение */
    const tasks = await db.taskItem.findMany({
      where: { labelIds: { contains: '"' + id + '"' } },
      select: { id: true, labelIds: true },
    })
    for (const t of tasks) {
      try {
        const arr = JSON.parse(t.labelIds) as unknown[]
        const next = arr.filter((x) => x !== id)
        await db.taskItem.update({ where: { id: t.id }, data: { labelIds: JSON.stringify(next) } })
      } catch { /* битый JSON — пропускаем */ }
    }
    await db.taskLabel.delete({ where: { id } }).catch(() => undefined)
    notifyTmChanged('label-delete')
    return NextResponse.json({ ok: true })
  } catch {
    return NextResponse.json({ error: 'Внутренняя ошибка' }, { status: 500 })
  }
}
