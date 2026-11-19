import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireTaskService } from '@/lib/tasks'

/**
 * POST /api/tm/columns — новая колонка доски { boardId, title, color?, kind? }.
 */
export async function POST(req: NextRequest) {
  try {
    const user = await requireTaskService()
    if (!user) return NextResponse.json({ error: 'Сервис недоступен' }, { status: 403 })
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null
    if (!body) return NextResponse.json({ error: 'Некорректные данные' }, { status: 400 })
    const boardId = String(body.boardId || '')
    const title = String(body.title || '').trim().slice(0, 80)
    if (!boardId || !title) return NextResponse.json({ error: 'Нужны доска и название' }, { status: 400 })
    const board = await db.taskBoard.findUnique({ where: { id: boardId }, select: { id: true } })
    if (!board) return NextResponse.json({ error: 'Доска не найдена' }, { status: 404 })
    const color = /^#[0-9a-fA-F]{6}$/.test(String(body.color || '')) ? String(body.color) : '#8b929c'
    const maxOrder = await db.taskColumn.aggregate({ where: { boardId }, _max: { sortOrder: true } })
    const item = await db.taskColumn.create({
      data: { boardId, title, color, sortOrder: (maxOrder._max.sortOrder ?? 0) + 1 },
    })
    return NextResponse.json({ item })
  } catch {
    return NextResponse.json({ error: 'Внутренняя ошибка' }, { status: 500 })
  }
}
