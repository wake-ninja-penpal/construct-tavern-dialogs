import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { isAdmin } from '@/lib/auth'
import { SERVICE_KEY_RE, ensureServicesSeeded } from '@/lib/services'

/**
 * GET /api/admin/services — панель администратора: полный реестр сервисов
 * (включая выключенные) + все аккаунты с их персональными доступами
 * (матрица «пользователи × сервисы» для ограничения доступов).
 *
 * POST /api/admin/services — подключить новый сервис (key, name, …).
 */
export async function GET() {
  try {
    if (!(await isAdmin())) return NextResponse.json({ error: 'Только администратор' }, { status: 403 })
    await ensureServicesSeeded()
    const [services, users, access] = await Promise.all([
      db.serviceApp.findMany({ orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] }),
      db.authUser.findMany({
        orderBy: { createdAt: 'asc' },
        select: { id: true, login: true, displayName: true, color: true, disabled: true, createdAt: true },
      }),
      db.serviceAccess.findMany(),
    ])
    const byUser = new Map<string, Record<string, boolean>>()
    for (const a of access) {
      const m = byUser.get(a.userId) || {}
      m[a.serviceKey] = a.allowed
      byUser.set(a.userId, m)
    }
    return NextResponse.json({
      list: services,
      users: users.map((u) => ({ ...u, access: byUser.get(u.id) || {} })),
    })
  } catch {
    return NextResponse.json({ error: 'Внутренняя ошибка' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    if (!(await isAdmin())) return NextResponse.json({ error: 'Только администратор' }, { status: 403 })
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null
    if (!body) return NextResponse.json({ error: 'Некорректные данные' }, { status: 400 })

    const key = String(body.key || '').trim()
    const name = String(body.name || '').trim()
    if (!SERVICE_KEY_RE.test(key)) {
      return NextResponse.json({ error: 'Ключ: латиница/цифры/дефис, 2–40 символов (например sprite-editor)' }, { status: 400 })
    }
    if (name.length < 1 || name.length > 60) {
      return NextResponse.json({ error: 'Название: от 1 до 60 символов' }, { status: 400 })
    }
    const exists = await db.serviceApp.findUnique({ where: { key }, select: { id: true } })
    if (exists) return NextResponse.json({ error: 'Сервис с таким ключом уже подключён' }, { status: 400 })

    const maxOrder = await db.serviceApp.aggregate({ _max: { sortOrder: true } })
    const created = await db.serviceApp.create({
      data: {
        key,
        name,
        description: String(body.description || '').slice(0, 200),
        icon: String(body.icon || 'grid').slice(0, 30),
        path: String(body.path || key).slice(0, 60),
        status: body.status === 'ready' ? 'ready' : 'placeholder',
        sortOrder: (maxOrder._max.sortOrder ?? 0) + 1,
      },
    })
    return NextResponse.json({ item: created })
  } catch {
    return NextResponse.json({ error: 'Внутренняя ошибка' }, { status: 500 })
  }
}
