import { NextRequest, NextResponse } from 'next/server'
import { TaskItem } from '@prisma/client'
import { db } from '@/lib/db'
import {
  appendSysMsg,
  canEditProject,
  parseStickers,
  notifyTaskUser,
  notifyTmChanged,
  requireTaskService,
  sanitizeLabelIds,
  sanitizeLinks,
  sanitizeStickers,
} from '@/lib/tasks'

/**
 * GET /api/tm/tasks/[id] — одна задача (для режима привязки нод из «Ветвей»
 * и прямых ссылок #service=task-manager&ot=<id>).
 */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireTaskService()
    if (!user) return NextResponse.json({ error: 'Сервис недоступен' }, { status: 403 })
    const { id } = await ctx.params
    const task = await db.taskItem.findUnique({ where: { id } })
    if (!task) return NextResponse.json({ error: 'Задача не найдена' }, { status: 404 })
    return NextResponse.json({ item: task })
  } catch {
    return NextResponse.json({ error: 'Внутренняя ошибка' }, { status: 500 })
  }
}

/**
 * PATCH /api/tm/tasks/[id] — правка задачи: название/описание/стикеры/связи/
 * метки/выполненность/перенос (boardId+columnId, null+null — бэклог) /порядок.
 *
 * Права: editor/admin проекта (наблюдателю отказ — 403 «режим наблюдателя»).
 * Сервер сам пишет системную историю в чат задачи (назначил/перенёс/выполнил…)
 * и шлёт уведомления newly-назначенным исполнителям.
 *
 * Перенос в колонку с kind='done' помечает задачу выполненной (и наоборот —
 * возвращает в работу), как в прототипе: позиция в колонках = статус.
 *
 * DELETE — удалить задачу вместе с подзадачами (каскад), нужно editor/admin.
 */
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireTaskService()
    if (!user) return NextResponse.json({ error: 'Сервис недоступен' }, { status: 403 })
    const { id } = await ctx.params
    const task = await db.taskItem.findUnique({ where: { id } })
    if (!task) return NextResponse.json({ error: 'Задача не найдена' }, { status: 404 })
    if (!(await canEditProject(task.projectId, user.login))) {
      return NextResponse.json({ error: 'Недостаточно прав: режим наблюдателя' }, { status: 403 })
    }
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null
    if (!body) return NextResponse.json({ error: 'Некорректные данные' }, { status: 400 })

    const oldSt = { ...parseStickers(task.stickers), assignees: parseStickers(task.stickers).assignees || [] }
    const data: Record<string, unknown> = {}
    const sys: string[] = []
    const project = await db.taskProject.findUnique({ where: { id: task.projectId }, select: { title: true } })

    if (typeof body.title === 'string' && body.title.trim() && body.title.trim() !== task.title) {
      data.title = body.title.trim().slice(0, 200)
      sys.push('переименовал(а): «' + task.title.slice(0, 60) + '» → «' + (data.title as string).slice(0, 60) + '»')
    }
    if (typeof body.description === 'string') data.description = body.description.slice(0, 20000)
    if (body.labelIds !== undefined) data.labelIds = sanitizeLabelIds(body.labelIds)
    if (body.links !== undefined) data.links = sanitizeLinks(body.links)
    /* блок «Связи с Ветвями» включается флагом в самой задаче */
    if (typeof body.nodesOn === 'boolean' && body.nodesOn !== task.nodesOn) {
      data.nodesOn = body.nodesOn
    }

    /* свой цвет задачи: строка-палитра или null (снять цвет); плотность заливки */
    if (body.color !== undefined) {
      const c = typeof body.color === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(body.color) ? body.color : null
      if (c !== task.color) {
        data.color = c
        sys.push(c ? 'цвет задачи: ' + c : 'цвет снят')
        if (c && task.colorAlpha == null) data.colorAlpha = 0.2
      }
    }
    if (typeof body.colorAlpha === 'number' && Number.isFinite(body.colorAlpha)) {
      const a = Math.min(0.8, Math.max(0.04, body.colorAlpha))
      if (a !== task.colorAlpha) data.colorAlpha = a
    }

    /* стикеры: дифф для истории и уведомлений */
    if (body.stickers !== undefined) {
      const next = sanitizeStickers(body.stickers)
      data.stickers = next
      const st = JSON.parse(next) as { assignees: string[]; deadline: string | null; priority: string | null }
      const added = st.assignees.filter((a) => !oldSt.assignees.includes(a))
      const removed = oldSt.assignees.filter((a) => !st.assignees.includes(a))
      if (added.length) sys.push('назначил(а): ' + added.join(', '))
      if (removed.length) sys.push('снял(а) исполнителя: ' + removed.join(', '))
      if (st.priority !== oldSt.priority) {
        sys.push(st.priority ? 'приоритет: ' + st.priority : 'приоритет снят')
      }
      if (st.deadline !== oldSt.deadline) {
        sys.push(st.deadline ? 'дедлайн: ' + st.deadline : 'дедлайн убран')
      }
      /* уведомления только новым исполнителям (кроме автора правки) */
      for (const login of added) {
        if (login === user.login) continue
        void notifyTaskUser(login, 'task_assigned', {
          taskId: task.id,
          taskTitle: typeof data.title === 'string' ? data.title : task.title,
          projectId: task.projectId,
          projectName: project?.title || '',
          byLogin: user.login,
          byName: user.displayName || user.login,
        })
      }
    }

    /* перенос между колонками/досками/бэклогом (в т.ч. НА ДРУГОЙ ПРОЕКТ —
       projectId берётся из колонки цели) */
    if ('columnId' in body || 'boardId' in body) {
      const moveCol = typeof body.columnId === 'string' && body.columnId ? body.columnId : null
      const moveBoard = typeof body.boardId === 'string' && body.boardId ? body.boardId : null
      if (moveCol) {
        const col = await db.taskColumn.findUnique({ where: { id: moveCol } })
        if (!col) return NextResponse.json({ error: 'Колонка не найдена' }, { status: 400 })
        const colBoard = await db.taskBoard.findUnique({ where: { id: col.boardId }, select: { projectId: true } })
        data.columnId = moveCol
        data.boardId = col.boardId
        if (colBoard && colBoard.projectId !== task.projectId) {
          data.projectId = colBoard.projectId
          data.parentId = null /* подзадача не может жить в другом проекте */
          sys.push('перенёс(ла) в другой проект')
        }
        /* семантика системных колонок: позиция = статус */
        if (col.kind === 'done') {
          data.done = true
          data.completedAt = new Date()
          sys.push('перенёс(ла) в «' + col.title + '» — выполнено')
        } else if (task.done) {
          data.done = false
          data.completedAt = null
          sys.push('вернул(а) в работу → «' + col.title + '»')
        } else if (task.columnId !== moveCol) {
          sys.push('переместил(а) в «' + col.title + '»')
        }
      } else {
        /* бэклог проекта */
        data.columnId = null
        data.boardId = null
        if (task.done) {
          data.done = false
          data.completedAt = null
          sys.push('вернул(а) в работу → бэклог')
        } else if (task.columnId) {
          sys.push('переместил(а) в бэклог')
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
    if (typeof body.done === 'boolean' && !('columnId' in body || 'boardId' in body)) {
      data.done = body.done
      data.completedAt = body.done ? new Date() : null
      sys.push(body.done ? 'отметил(а) выполненной' : 'вернул(а) в работу')
    }

    if (!Object.keys(data).length && !sys.length) {
      return NextResponse.json({ error: 'Нет полей для обновления' }, { status: 400 })
    }
    if (sys.length) {
      data.messages = appendSysMsg(task.messages, user.login, sys.join(' · '))
    }
    const item = await db.taskItem.update({ where: { id }, data })

    /* autoTake (как в прототипе «Поток»): назначили исполнителя задаче из
       «Не взяты» — она немедленно переезжает в «В работе» */
    const assignedAdded = body.stickers !== undefined && typeof data.stickers === 'string'
      ? (JSON.parse(data.stickers) as { assignees?: string[] }).assignees?.filter((a) => !oldSt.assignees.includes(a)) || []
      : []
    if (assignedAdded.length && item.columnId && !('columnId' in data)) {
      const curCol = await db.taskColumn.findUnique({ where: { id: item.columnId } })
      if (curCol && curCol.kind === 'new' && item.boardId) {
        const progress = await db.taskColumn.findFirst({ where: { boardId: item.boardId, kind: 'progress' } })
        if (progress) {
          const taken = await db.taskItem.update({
            where: { id },
            data: {
              columnId: progress.id,
              boardId: item.boardId,
              messages: appendSysMsg(item.messages, user.login, 'перенёс(ла) в «' + progress.title + '» — назначен исполнитель'),
            },
          })
          await db.taskItem.updateMany({ where: { parentId: id }, data: { columnId: progress.id, boardId: item.boardId } })
          notifyTmChanged('task-autotake')
          return NextResponse.json({ item: taken, moved: await db.taskItem.findMany({ where: { parentId: id } }) })
        }
      }
    }
    /* перенос родителя: подзадачи едут вместе с ним (как placeIn потомков в прототипе) */
    let moved: TaskItem[] = []
    if ('columnId' in data || 'boardId' in data) {
      await db.taskItem.updateMany({
        where: { parentId: id },
        data: { projectId: item.projectId, boardId: item.boardId, columnId: item.columnId },
      })
      moved = await db.taskItem.findMany({ where: { parentId: id } })
    }
    notifyTmChanged('task-patch')
    return NextResponse.json({ item, moved })
  } catch {
    return NextResponse.json({ error: 'Внутренняя ошибка' }, { status: 500 })
  }
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireTaskService()
    if (!user) return NextResponse.json({ error: 'Сервис недоступен' }, { status: 403 })
    const { id } = await ctx.params
    const task = await db.taskItem.findUnique({ where: { id }, select: { projectId: true } })
    if (!task) return NextResponse.json({ error: 'Задача не найдена' }, { status: 404 })
    if (!(await canEditProject(task.projectId, user.login))) {
      return NextResponse.json({ error: 'Недостаточно прав для удаления' }, { status: 403 })
    }
    /* подзадачи (parentId=id) удаляем вручную — на один уровень вложенности,
       затем сама задача; более глубокие вложения удаляются рекурсивно */
    const deleteDeep = async (pid: string): Promise<void> => {
      const kids = await db.taskItem.findMany({ where: { parentId: pid }, select: { id: true } })
      for (const k of kids) await deleteDeep(k.id)
      await db.taskItem.delete({ where: { id: pid } }).catch(() => undefined)
    }
    await deleteDeep(id)
    notifyTmChanged('task-delete')
    return NextResponse.json({ ok: true })
  } catch {
    return NextResponse.json({ error: 'Внутренняя ошибка' }, { status: 500 })
  }
}
