import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { notifyTmChanged, requireTaskService } from '@/lib/tasks'

/**
 * GET /api/tm/teams — команды с составом (включены и в GET /api/tm; этот
 * маршрут — для точечного обновления).
 * POST /api/tm/teams { name, color?, icon?, members?: [login] } — новая команда.
 * Команды общие для сервиса: любой пользователь может создать свою команду
 * и включить в неё участников хаба.
 */
export async function GET() {
  try {
    const user = await requireTaskService()
    if (!user) return NextResponse.json({ error: 'Сервис недоступен' }, { status: 403 })
    const items = await db.taskTeam.findMany({ orderBy: [{ name: 'asc' }], include: { members: { orderBy: { login: 'asc' } } } })
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
    const color = body && typeof body.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(body.color) ? body.color : '#8b7cff'
    const icon = body && typeof body.icon === 'string' ? body.icon.slice(0, 20) : 'shield'
    const members = body && Array.isArray(body.members) ? body.members.filter((x): x is string => typeof x === 'string').slice(0, 60) : []
    const item = await db.taskTeam.create({
      data: {
        name,
        color,
        icon,
        members: { create: members.map((login) => ({ login: login.slice(0, 80) })) },
      },
      include: { members: true },
    })
    notifyTmChanged('team-create')
    return NextResponse.json({ item })
  } catch {
    return NextResponse.json({ error: 'Внутренняя ошибка' }, { status: 500 })
  }
}
