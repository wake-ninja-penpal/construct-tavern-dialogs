import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { isAdmin } from '@/lib/auth'
import { notifyServiceAccess } from '@/lib/services'
import { notifyServicesChanged } from '@/lib/syncNotify'

/**
 * PUT /api/admin/services/access — персональное ограничение доступа к сервису.
 *
 * { userId, serviceKey, allowed: true|false } — upsert записи ServiceAccess.
 * allowed=false запрещает сервис пользователю (пропадает из переключателя,
 * по прямой ссылке открывается экран «нет доступа»), true — возвращает.
 * Смена сопровождается уведомлением в колокольчик пользователя.
 */
export async function PUT(req: NextRequest) {
  try {
    if (!(await isAdmin())) return NextResponse.json({ error: 'Только администратор' }, { status: 403 })
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null
    if (!body) return NextResponse.json({ error: 'Некорректные данные' }, { status: 400 })

    const userId = String(body.userId || '')
    const serviceKey = String(body.serviceKey || '')
    if (typeof body.allowed !== 'boolean' || !userId || !serviceKey) {
      return NextResponse.json({ error: 'Нужны userId, serviceKey и allowed' }, { status: 400 })
    }
    const [svc, user] = await Promise.all([
      db.serviceApp.findUnique({ where: { key: serviceKey } }),
      db.authUser.findUnique({ where: { id: userId } }),
    ])
    if (!svc) return NextResponse.json({ error: 'Сервис не найден' }, { status: 404 })
    if (!user) return NextResponse.json({ error: 'Пользователь не найден' }, { status: 404 })

    await db.serviceAccess.upsert({
      where: { serviceKey_userId: { serviceKey, userId } },
      create: { serviceKey, userId, allowed: body.allowed },
      update: { allowed: body.allowed },
    })
    void notifyServiceAccess(userId, svc, body.allowed).catch(() => undefined)
    /* адресный сигнал: пользователь сразу перечитает список сервисов —
       запрещённый пропадает без перезагрузки; если он был в этом сервисе,
       его выведет в доступный (защита записей — на сервере) */
    notifyServicesChanged([userId])
    return NextResponse.json({ ok: true })
  } catch {
    return NextResponse.json({ error: 'Внутренняя ошибка' }, { status: 500 })
  }
}
