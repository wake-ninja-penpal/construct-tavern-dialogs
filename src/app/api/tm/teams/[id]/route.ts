import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { notifyTmChanged, requireTaskService } from '@/lib/tasks'

/**
 * PATCH /api/tm/teams/[id] { name?, color?, icon?, members?: [login] } —
 * правка команды; состав заменяется целиком (как в прототипе: чек-боксы
 * участников в окне редактирования).
 * DELETE — удалить команду: строки доступов проектов, ссылающиеся на неё,
 * стираются (доступ по команде исчезает).
 */
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireTaskService()
    if (!user) return NextResponse.json({ error: 'Сервис недоступен' }, { status: 403 })
    const { id } = await ctx.params
    const team = await db.taskTeam.findUnique({ where: { id } })
    if (!team) return NextResponse.json({ error: 'Команда не найдена' }, { status: 404 })
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null
    if (!body) return NextResponse.json({ error: 'Некорректные данные' }, { status: 400 })
    const data: Record<string, unknown> = {}
    if (typeof body.name === 'string' && body.name.trim()) data.name = body.name.trim().slice(0, 40)
    if (typeof body.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(body.color)) data.color = body.color
    if (typeof body.icon === 'string' && body.icon.trim()) data.icon = body.icon.trim().slice(0, 20)
    if (Array.isArray(body.members)) {
      const members = body.members.filter((x): x is string => typeof x === 'string').slice(0, 60)
      await db.taskTeamMember.deleteMany({ where: { teamId: id } })
      if (members.length) {
        await db.taskTeamMember.createMany({ data: members.map((login) => ({ teamId: id, login: login.slice(0, 80) })) })
      }
    }
    if (!Object.keys(data).length) return NextResponse.json({ error: 'Нет полей' }, { status: 400 })
    const item = await db.taskTeam.update({ where: { id }, data, include: { members: { orderBy: { login: 'asc' } } } })
    notifyTmChanged('team-patch')
    return NextResponse.json({ item })
  } catch {
    return NextResponse.json({ error: 'Внутренняя ошибка' }, { status: 500 })
  }
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireTaskService()
    if (!user) return NextResponse.json({ error: 'Сервис недоступен' }, { status: 403 })
    const { id } = await ctx.params
    await db.taskTeam.delete({ where: { id } }).catch(() => undefined)
    notifyTmChanged('team-delete')
    return NextResponse.json({ ok: true })
  } catch {
    return NextResponse.json({ error: 'Внутренняя ошибка' }, { status: 500 })
  }
}
