import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { requireTaskService } from '@/lib/tasks'

/**
 * GET /api/tm/labels — все метки (общие для сервиса, как в прототипе).
 * POST /api/tm/labels { name, color? } — новая метка (любой пользователь
 * сервиса; метки — общая палитра команды).
 */
export async function GET() {
  try {
    const user = await requireTaskService()
    if (!user) return NextResponse.json({ error: 'Сервис недоступен' }, { status: 403 })
    const items = await db.taskLabel.findMany({ orderBy: [{ name: 'asc' }] })
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
    const name = body && typeof body.name === 'string' ? body.name.trim().slice(0, 20) : ''
    if (!name) return NextResponse.json({ error: 'Нужно название' }, { status: 400 })
    const dupe = await db.taskLabel.findFirst({ where: { name } })
    if (dupe) return NextResponse.json({ item: dupe, existed: true })
    const color = body && typeof body.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(body.color) ? body.color : '#8b7cff'
    const item = await db.taskLabel.create({ data: { name, color } })
    return NextResponse.json({ item })
  } catch {
    return NextResponse.json({ error: 'Внутренняя ошибка' }, { status: 500 })
  }
}
