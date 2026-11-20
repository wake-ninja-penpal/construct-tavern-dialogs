import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import {
  appendSysMsg,
  canEditProject,
  ensureDefaultLabels,
  ensureProjectOwnerSeeds,
  myTeamIds,
  notifyTaskUser,
  notifyTmChanged,
  requireTaskService,
  sanitizeLabelIds,
  sanitizeLinks,
  sanitizeStickers,
} from '@/lib/tasks'

/**
 * GET /api/tm — всё пространство менеджера задач: проекты (с досками и
 * колонками) + задачи + метки + команды + строки доступов + мои сохранённые
 * виды + роли в проектах. Единый снапшот — UI держит его в памяти и шлёт
 * точечные мутации (POST/PATCH/DELETE).
 *
 * Доступ: проект видят ТОЛЬКО его участники — у кого есть персональная или
 * командная строка доступа (roles: null — проекта в списке нет). Создатель
 * получает админ-строку при создании, далее доступ раздаётся в окне «Доступ».
 */
export async function GET() {
  try {
    const user = await requireTaskService()
    if (!user) return NextResponse.json({ error: 'Сервис недоступен' }, { status: 403 })
    /* дефолтные метки: если палитра команды пуста — при первом входе
       появляются «баг/фича/дизайн/контент/техдолг/исследование» (идемпотентно);
       миграция старых «открытых» проектов: админ-строка автору ранней задачи */
    await Promise.all([ensureDefaultLabels(), ensureProjectOwnerSeeds()])
    const [projects, tasks, labels, teams, accessRows, views, teamIds] = await Promise.all([
      db.taskProject.findMany({
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
        include: { boards: { orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }], include: { columns: { orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] } } } },
      }),
      db.taskItem.findMany({ orderBy: [{ order: 'asc' }, { createdAt: 'asc' }] }),
      db.taskLabel.findMany({ orderBy: [{ name: 'asc' }] }),
      db.taskTeam.findMany({ orderBy: [{ name: 'asc' }], include: { members: { orderBy: { login: 'asc' } } } }),
      db.taskProjectAccess.findMany({ orderBy: [{ projectId: 'asc' }, { createdAt: 'asc' }] }),
      db.taskView.findMany({ where: { login: user.login }, orderBy: [{ createdAt: 'asc' }] }),
      myTeamIds(user.login),
    ])
    /* роли: projectId → admin|editor|viewer|null. Участия нет — проекта
       для пользователя нет: он не попадает ни в список, ни в задачи */
    const roles: Record<string, string | null> = {}
    const visible: typeof projects = []
    for (const p of projects) {
      const rows = accessRows.filter((r) => r.projectId === p.id)
      let best: string | null = null
      const rank: Record<string, number> = { viewer: 1, editor: 2, admin: 3 }
      for (const r of rows) {
        const mine = (r.login && r.login === user.login) || (r.teamId && teamIds.includes(r.teamId))
        if (!mine) continue
        const role = rank[r.role] ? r.role : 'viewer'
        if (!best || rank[role] > rank[best]) best = role
      }
      roles[p.id] = best
      if (best) visible.push(p)
    }
    const visibleIds = new Set(visible.map((p) => p.id))
    return NextResponse.json({
      projects: visible,
      tasks: tasks.filter((t) => visibleIds.has(t.projectId)),
      labels,
      teams,
      access: accessRows.filter((r) => visibleIds.has(r.projectId)),
      views,
      roles,
      me: { login: user.login, displayName: user.displayName, color: user.color },
    })
  } catch {
    return NextResponse.json({ error: 'Внутренняя ошибка' }, { status: 500 })
  }
}

/**
 * POST /api/tm — создание задачи.
 * { title, projectId, boardId?, columnId? (null — бэклог), parentId?,
 *   description?, stickers?, links?, labelIds? }
 * Нужен доступ editor/admin к проекту. Назначенные исполнители получают
 * уведомление (колокольчик + мгновенный push).
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
    if (!(await canEditProject(projectId, user.login))) {
      return NextResponse.json({ error: 'Недостаточно прав: режим наблюдателя' }, { status: 403 })
    }

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

    const stickers = sanitizeStickers(body.stickers)
    const stickersObj = JSON.parse(stickers) as { assignees?: string[]; deadline?: string | null; priority?: string | null }
    /* системная история: создал(а)… + назначил(а)… */
    let messages = appendSysMsg('[]', user.login, 'создал(а) ' + (parentId ? 'подзадачу' : 'задачу') + ' «' + title.slice(0, 80) + '»')
    if (stickersObj.assignees?.length) {
      messages = appendSysMsg(messages, user.login, 'назначил(а): ' + stickersObj.assignees.join(', '))
    }
    /* свой цвет задачи (палитра прототипа «Поток») */
    const color = typeof body.color === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(body.color) ? body.color : null
    const colorAlpha = typeof body.colorAlpha === 'number' && Number.isFinite(body.colorAlpha)
      ? Math.min(0.8, Math.max(0.04, body.colorAlpha))
      : (color ? 0.2 : null)

    const created = await db.taskItem.create({
      data: {
        projectId,
        boardId,
        columnId,
        parentId,
        title: title.slice(0, 200),
        description: String(body.description || '').slice(0, 20000),
        color,
        colorAlpha,
        stickers,
        links: sanitizeLinks(body.links),
        labelIds: sanitizeLabelIds(body.labelIds),
        messages,
        order: (last?.order ?? 0) + 1000,
        createdBy: user.login,
      },
    })

    /* уведомления назначенным (кроме автора) */
    const by = user.displayName || user.login
    for (const login of stickersObj.assignees || []) {
      if (login === user.login) continue
      void notifyTaskUser(login, 'task_assigned', {
        taskId: created.id,
        taskTitle: created.title,
        projectId,
        projectName: project.title,
        byLogin: user.login,
        byName: by,
      })
    }
    notifyTmChanged('task-create')
    return NextResponse.json({ item: created })
  } catch {
    return NextResponse.json({ error: 'Внутренняя ошибка' }, { status: 500 })
  }
}
