import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import {
  notifyTaskUser,
  parseMessages,
  parseStickers,
  projectRole,
  requireTaskService,
} from '@/lib/tasks'

/**
 * POST /api/tm/tasks/[id]/comments { text } — комментарий в чат задачи.
 *
 * Право комментировать есть у любого имеющего доступ к проекту
 * (включая наблюдателя — он «читает и комментирует»).
 * Исполнители и автор задачи получают уведомление (кроме автора комментария).
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireTaskService()
    if (!user) return NextResponse.json({ error: 'Сервис недоступен' }, { status: 403 })
    const { id } = await ctx.params
    const task = await db.taskItem.findUnique({ where: { id } })
    if (!task) return NextResponse.json({ error: 'Задача не найдена' }, { status: 404 })
    const role = await projectRole(task.projectId, user.login)
    if (!role) return NextResponse.json({ error: 'Нет доступа к проекту задачи' }, { status: 403 })
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null
    const text = body && typeof body.text === 'string' ? body.text.trim() : ''
    if (!text) return NextResponse.json({ error: 'Пустой комментарий' }, { status: 400 })

    const list = parseMessages(task.messages)
    const msg = { id: Math.random().toString(36).slice(2, 12), login: user.login, text: text.slice(0, 4000), ts: Date.now(), system: false }
    list.push(msg)
    const item = await db.taskItem.update({
      where: { id },
      data: { messages: JSON.stringify(list.slice(-500)) },
    })

    /* уведомления: исполнители + автор задачи, кроме автора комментария */
    const st = parseStickers(task.stickers)
    const targets = new Set<string>(st.assignees)
    if (task.createdBy) targets.add(task.createdBy)
    targets.delete(user.login)
    const preview = text.length > 120 ? text.slice(0, 117) + '…' : text
    for (const login of targets) {
      void notifyTaskUser(login, 'task_comment', {
        taskId: task.id,
        taskTitle: task.title,
        byLogin: user.login,
        byName: user.displayName || user.login,
        preview,
      })
    }
    return NextResponse.json({ item, message: msg })
  } catch {
    return NextResponse.json({ error: 'Внутренняя ошибка' }, { status: 500 })
  }
}
