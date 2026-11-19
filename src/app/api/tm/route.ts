import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireTaskService, sanitizeLinks, sanitizeStickers } from '@/lib/tasks'

/**
 * GET /api/tm — всё пространство менеджера задач: проекты (с досками и
 * колонками) + задачи. Единый снапшот — UI держит его в памяти и шлёт
 * точечные мутации (POST/PATCH/DELETE).
 */
export async function GET() {
  try {
    const user = await requireTaskService()
    if (!user) return NextResponse.json({ error: 'Сервис недоступен' }, { status: 403 })
    const [projects, tasks] = await Promise.all([
      db.taskProject.findMany({
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
        include: { boards: { orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }], include: { columns: { orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] } } } },
      }),
      db.taskItem.findMany({ orderBy: [{ order: 'asc' }, { createdAt: 'asc' }] }),
    ])
    return NextResponse.json({ projects, tasks, me: { login: user.login, displayName: user.displayName, color: user.color } })
  } catch {
    return NextResponse.json({ error: 'Внутренняя ошибка' }, { status: 500 })
  }
}

/**
 * POST /api/tm — создание задачи.
 * { title, projectId, boardId?, columnId? (null — бэклог), parentId?,
 *   description?, stickers?, links?, order? }
 */
export async function POST(req: NextRequest) {
  try {
    const user = await requireTaskService()
    if (!user) return NextResponse.json({ error: 'Сервис недоступен' }, { status: 403 })
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null
    if (!body) return NextResponse.json({ error: 'Некорректные данные' }, { status: 400 })

    const projectId = String(body.projectId || '')
    const title = String(body.title || '').trim()
    if (!projectId || !title) return NextResponse.json({ error: 'Нужны проект и название' }, { status: 400 })
    const project = await db.taskProject.findUnique({ where: { id: projectId } })
    if (!project) return NextResponse.json({ error: 'Проект не найден' }, { status: 404 })

    /* позиция: конец указанной колонки/бэклога (order = max + 1000) */
    let boardId: string | null = typeof body.boardId === 'string' && body.boardId ? body.boardId : null
    let columnId: string | null = typeof body.columnId === 'string' && body.columnId ? body.columnId : null
    if (columnId) {
      const col = await db.taskColumn.findUnique({ where: { id: columnId } })
      if (!col || (boardId && col.boardId !== boardId)) return NextResponse.json({ error: 'Колонка не найдена' }, { status: 400 })
      boardId = col.boardId
    } else {
      columnId = null
      boardId = null // бэклог проекта
    }
    const last = await db.taskItem.findFirst({
      where: { projectId, columnId },
      orderBy: { order: 'desc' },
      select: { order: true },
    })
    const parentId = typeof body.parentId === 'string' && body.parentId ? body.parentId : null
    if (parentId) {
      const parent = await db.taskItem.findUnique({ where: { id: parentId } })
      if (!parent || parent.projectId !== projectId) return NextResponse.json({ error: 'Родительская задача не найдена' }, { status: 400 })
    }

    const created = await db.taskItem.create({
      data: {
        projectId,
        boardId,
        columnId,
        parentId,
        title: title.slice(0, 200),
        description: String(body.description || '').slice(0, 20000),
        stickers: sanitizeStickers(body.stickers),
        links: sanitizeLinks(body.links),
        order: (last?.order ?? 0) + 1000,
        createdBy: user.login,
      },
    })
    return NextResponse.json({ item: created })
  } catch {
    return NextResponse.json({ error: 'Внутренняя ошибка' }, { status: 500 })
  }
}
