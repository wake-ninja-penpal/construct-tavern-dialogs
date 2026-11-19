import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { canEditProject, ensureDefaultColumns, requireTaskService } from '@/lib/tasks'

/**
 * POST /api/tm/boards — новая доска проекта { projectId, title }.
 * Создаётся с тремя системными колонками.
 */
export async function POST(req: NextRequest) {
  try {
    const user = await requireTaskService()
    if (!user) return NextResponse.json({ error: 'Сервис недоступен' }, { status: 403 })
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null
    if (!body) return NextResponse.json({ error: 'Некорректные данные' }, { status: 400 })
    const projectId = String(body.projectId || '')
    const title = String(body.title || '').trim().slice(0, 120)
    if (!projectId || !title) return NextResponse.json({ error: 'Нужны проект и название' }, { status: 400 })
    const project = await db.taskProject.findUnique({ where: { id: projectId }, select: { id: true } })
    if (!project) return NextResponse.json({ error: 'Проект не найден' }, { status: 404 })
    if (!(await canEditProject(projectId, user.login))) {
      return NextResponse.json({ error: 'Недостаточно прав: режим наблюдателя' }, { status: 403 })
    }
    const maxOrder = await db.taskBoard.aggregate({ where: { projectId }, _max: { sortOrder: true } })
    const board = await db.taskBoard.create({ data: { projectId, title, sortOrder: (maxOrder._max.sortOrder ?? 0) + 1 } })
    await ensureDefaultColumns(board.id)
    const full = await db.taskBoard.findUnique({
      where: { id: board.id },
      include: { columns: { orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] } },
    })
    return NextResponse.json({ item: full })
  } catch {
    return NextResponse.json({ error: 'Внутренняя ошибка' }, { status: 500 })
  }
}
