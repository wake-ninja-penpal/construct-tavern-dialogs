import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireTaskService } from '@/lib/tasks'

/**
 * POST /api/tm/projects — новый проект менеджера задач.
 * { title, color? } — вместе с проектом создаётся доска «Основная»
 * с тремя системными колонками (Не взяты / В работе / Выполнено).
 * Создатель становится админом проекта (строка доступов): далее доступ
 * раздаётся командам и людям в окне «Доступ».
 */
export async function POST(req: NextRequest) {
  try {
    const user = await requireTaskService()
    if (!user) return NextResponse.json({ error: 'Сервис недоступен' }, { status: 403 })
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null
    if (!body) return NextResponse.json({ error: 'Некорректные данные' }, { status: 400 })
    const title = String(body.title || '').trim().slice(0, 120)
    if (!title) return NextResponse.json({ error: 'Нужно название' }, { status: 400 })
    const color = /^#[0-9a-fA-F]{6}$/.test(String(body.color || '')) ? String(body.color) : '#e2a54e'
    const open = body.open !== false // open:false — закрытый проект (админ = создатель)
    const maxOrder = await db.taskProject.aggregate({ _max: { sortOrder: true } })
    const project = await db.taskProject.create({
      data: {
        title,
        color,
        sortOrder: (maxOrder._max.sortOrder ?? 0) + 1,
        boards: { create: { title: 'Основная', sortOrder: 0 } },
      },
      include: { boards: { include: { columns: true } } },
    })
    const board = project.boards[0]
    if (board) {
      await db.taskColumn.createMany({
        data: [
          { boardId: board.id, title: 'Не взяты', color: '#6d7480', kind: 'new', locked: true, sortOrder: 0 },
          { boardId: board.id, title: 'В работе', color: '#e2a54e', kind: 'progress', locked: true, sortOrder: 1 },
          { boardId: board.id, title: 'Выполнено', color: '#8fbf7f', kind: 'done', locked: true, sortOrder: 2 },
        ],
      })
    }
    /* закрытый проект: создатель — админ (доступ раздаётся в окне «Доступ»);
       открытый — строк не пишем, редактировать могут все */
    if (!open) {
      await db.taskProjectAccess.create({ data: { projectId: project.id, login: user.login, role: 'admin' } })
    }
    const full = await db.taskProject.findUnique({
      where: { id: project.id },
      include: { boards: { orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }], include: { columns: { orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] } } } },
    })
    return NextResponse.json({ item: full })
  } catch {
    return NextResponse.json({ error: 'Внутренняя ошибка' }, { status: 500 })
  }
}
