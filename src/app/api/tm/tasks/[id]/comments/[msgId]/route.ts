import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import {
  notifyTmChanged,
  parseMessages,
  projectRole,
  requireTaskService,
} from '@/lib/tasks'

/**
 * PATCH  /api/tm/tasks/[id]/comments/[msgId] — правка своего комментария
 *         { text } ИЛИ реакция { react: '👍' } (переключает реакцию текущего
 *         пользователя; реагировать может любой участник проекта).
 * DELETE /api/tm/tasks/[id]/comments/[msgId] — удалить комментарий
 *         (свой — у любого; чужой — только админ проекта).
 *
 * Право комментировать есть у любого имеющего доступ к проекту (включая
 * наблюдателя). Реакции хранятся прямо в записи сообщения (reactions).
 */
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string; msgId: string }> }) {
  try {
    const user = await requireTaskService()
    if (!user) return NextResponse.json({ error: 'Сервис недоступен' }, { status: 403 })
    const { id, msgId } = await ctx.params
    const task = await db.taskItem.findUnique({ where: { id } })
    if (!task) return NextResponse.json({ error: 'Задача не найдена' }, { status: 404 })
    const role = await projectRole(task.projectId, user.login)
    if (!role) return NextResponse.json({ error: 'Нет доступа к проекту задачи' }, { status: 403 })
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null
    if (!body) return NextResponse.json({ error: 'Некорректные данные' }, { status: 400 })

    const list = parseMessages(task.messages)
    const msg = list.find((m) => m.id === msgId)
    if (!msg || msg.system) return NextResponse.json({ error: 'Комментарий не найден' }, { status: 404 })

    /* реакция: переключение эмодзи текущего пользователя */
    if (typeof body.react === 'string' && body.react) {
      const emoji = body.react.slice(0, 8)
      const reacts = { ...(msg.reactions || {}) } as Record<string, string[]>
      const mine = reacts[emoji] || []
      if (mine.includes(user.login)) {
        const rest = mine.filter((x) => x !== user.login)
        if (rest.length) reacts[emoji] = rest
        else delete reacts[emoji]
      } else {
        reacts[emoji] = [...mine, user.login]
      }
      const hasAny = Object.keys(reacts).length > 0
      const item = await db.taskItem.update({
        where: { id },
        data: {
          messages: JSON.stringify(list.map((m) => (m.id === msgId ? { ...m, reactions: hasAny ? reacts : undefined } : m))),
        },
      })
      notifyTmChanged('comment-react')
      return NextResponse.json({ item })
    }

    /* правка текста: только автор комментария */
    if (typeof body.text === 'string') {
      if (msg.login !== user.login) return NextResponse.json({ error: 'Править можно только свои комментарии' }, { status: 403 })
      const text = body.text.trim()
      if (!text) return NextResponse.json({ error: 'Пустой комментарий' }, { status: 400 })
      msg.text = text.slice(0, 4000)
      msg.ts = Date.now() /* время правки — поверх (в интерфейсе видна метка) */
      const item = await db.taskItem.update({
        where: { id },
        data: { messages: JSON.stringify(list) },
      })
      notifyTmChanged('comment-edit')
      return NextResponse.json({ item })
    }

    return NextResponse.json({ error: 'Нечего изменять' }, { status: 400 })
  } catch {
    return NextResponse.json({ error: 'Внутренняя ошибка' }, { status: 500 })
  }
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string; msgId: string }> }) {
  try {
    const user = await requireTaskService()
    if (!user) return NextResponse.json({ error: 'Сервис недоступен' }, { status: 403 })
    const { id, msgId } = await ctx.params
    const task = await db.taskItem.findUnique({ where: { id } })
    if (!task) return NextResponse.json({ error: 'Задача не найдена' }, { status: 404 })
    const role = await projectRole(task.projectId, user.login)
    if (!role) return NextResponse.json({ error: 'Нет доступа к проекту задачи' }, { status: 403 })
    const list = parseMessages(task.messages)
    const msg = list.find((m) => m.id === msgId)
    if (!msg || msg.system) return NextResponse.json({ error: 'Комментарий не найден' }, { status: 404 })
    /* свой комментарий — у любого; чужой — только админ проекта */
    if (msg.login !== user.login && role !== 'admin') {
      return NextResponse.json({ error: 'Удалять чужие комментарии может только админ проекта' }, { status: 403 })
    }
    const item = await db.taskItem.update({
      where: { id },
      data: { messages: JSON.stringify(list.filter((m) => m.id !== msgId)) },
    })
    notifyTmChanged('comment-delete')
    return NextResponse.json({ item })
  } catch {
    return NextResponse.json({ error: 'Внутренняя ошибка' }, { status: 500 })
  }
}
