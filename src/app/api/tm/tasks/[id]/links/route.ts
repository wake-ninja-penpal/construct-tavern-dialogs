import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import {
  appendSysMsg,
  canEditProject,
  parseLinks,
  notifyTmChanged,
  requireTaskService,
  sanitizeLinks,
} from '@/lib/tasks'

/**
 * POST /api/tm/tasks/[id]/links { links: [{pid,nid,room?,t?}] } — ДОБАВИТЬ
 * связи с нодами «Ветвей» из самой задачи: редактор «Ветвей» в режиме
 * привязки (#attach=<taskId>) шлёт выбранные ноды сюда; сервер мерджит
 * с существующими (дубликат pid:nid пропускается) и возвращает задачу.
 *
 * PUT не поддерживается — снятие связи идёт через PATCH задачи (links целиком).
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
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
    if (!body || !Array.isArray(body.links)) return NextResponse.json({ error: 'Некорректные данные' }, { status: 400 })

    const existing = parseLinks(task.links)
    const seen = new Set(existing.map((l) => l.pid + ':' + l.nid))
    const addedNames: string[] = []
    for (const x of body.links.slice(0, 50)) {
      if (!x || typeof x !== 'object') continue
      const o = x as Record<string, unknown>
      const pid = typeof o.pid === 'string' ? o.pid.trim().slice(0, 80) : ''
      const nid = typeof o.nid === 'string' ? o.nid.trim().slice(0, 80) : ''
      if (!pid || !nid || seen.has(pid + ':' + nid)) continue
      seen.add(pid + ':' + nid)
      existing.push({
        pid,
        nid,
        room: typeof o.room === 'string' && o.room ? o.room.slice(0, 80) : null,
        t: typeof o.t === 'string' ? o.t.slice(0, 160) : '',
      })
      if (o.t && typeof o.t === 'string') addedNames.push(o.t.slice(0, 40))
    }
    if (addedNames.length) {
      const item = await db.taskItem.update({
        where: { id },
        data: {
          links: sanitizeLinks(existing),
          messages: appendSysMsg(task.messages, user.login, 'привязал(а) ноды «Ветвей»: ' + addedNames.slice(0, 6).join(', ') + (addedNames.length > 6 ? ' и ещё ' + (addedNames.length - 6) : '')),
        },
      })
      notifyTmChanged('task-links')
      return NextResponse.json({ item, added: addedNames.length })
    }
    const item = await db.taskItem.update({ where: { id }, data: { links: sanitizeLinks(existing) } })
    notifyTmChanged('task-links')
    return NextResponse.json({ item, added: 0 })
  } catch {
    return NextResponse.json({ error: 'Внутренняя ошибка' }, { status: 500 })
  }
}
