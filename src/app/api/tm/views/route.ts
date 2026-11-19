import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireTaskService } from '@/lib/tasks'

/**
 * GET /api/tm/views — мои сохранённые виды (пресеты фильтров).
 * POST { name, icon?, state } — сохранить текущий вид: раздел + фильтры +
 * сортировка (state — JSON-объект, приводится к строгой форме).
 */
export async function GET() {
  try {
    const user = await requireTaskService()
    if (!user) return NextResponse.json({ error: 'Сервис недоступен' }, { status: 403 })
    const items = await db.taskView.findMany({ where: { login: user.login }, orderBy: { createdAt: 'asc' } })
    return NextResponse.json({ items })
  } catch {
    return NextResponse.json({ error: 'Внутренняя ошибка' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await requireTaskService()
    if (!user) return NextResponse.json({ error: 'Сервис недоступен' }, { status: 403 })
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null
    const name = body && typeof body.name === 'string' ? body.name.trim().slice(0, 40) : ''
    if (!name) return NextResponse.json({ error: 'Нужно название' }, { status: 400 })
    const st = body && body.state && typeof body.state === 'object' ? body.state as Record<string, unknown> : {}
    /* строгая форма состояния вида: раздел, проект, доска, фильтры, сортировка */
    const filters = st.filters && typeof st.filters === 'object' ? st.filters as Record<string, unknown> : {}
    const safeState = {
      view: typeof st.view === 'string' ? st.view.slice(0, 20) : 'my',
      projectId: typeof st.projectId === 'string' ? st.projectId.slice(0, 40) : null,
      boardId: typeof st.boardId === 'string' ? st.boardId.slice(0, 40) : null,
      userId: typeof st.userId === 'string' ? st.userId.slice(0, 80) : null,
      sort: typeof st.sort === 'string' ? st.sort.slice(0, 12) : 'manual',
      filters: {
        assignee: typeof filters.assignee === 'string' ? filters.assignee.slice(0, 80) : '',
        priorities: Array.isArray(filters.priorities) ? filters.priorities.filter((x): x is string => typeof x === 'string').slice(0, 6) : [],
        labelId: typeof filters.labelId === 'string' ? filters.labelId.slice(0, 40) : '',
        due: typeof filters.due === 'string' ? filters.due.slice(0, 10) : 'any',
        showDone: filters.showDone !== false,
      },
    }
    const icon = body && typeof body.icon === 'string' && body.icon.trim() ? body.icon.trim().slice(0, 20) : 'bookmark'
    const item = await db.taskView.create({ data: { login: user.login, name, icon, state: JSON.stringify(safeState) } })
    return NextResponse.json({ item })
  } catch {
    return NextResponse.json({ error: 'Внутренняя ошибка' }, { status: 500 })
  }
}
