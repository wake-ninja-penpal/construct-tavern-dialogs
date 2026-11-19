import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { isAdmin } from '@/lib/auth'
import { PROTECTED_KEYS } from '@/lib/services'
import { notifyServicesChanged } from '@/lib/syncNotify'

/**
 * PATCH /api/admin/services/[key] — правка сервиса: name/description/icon/
 * path/status/enabled/sortOrder. Отключённый сервис пропадает из
 * переключателя у всех и не открывается по прямой ссылке.
 *
 * DELETE /api/admin/services/[key] — отключить-и-удалить сервис из реестра.
 * Системный сервис «Ветви» (vetvi) удалить нельзя.
 */
export async function PATCH(req: NextRequest, ctx: { params: Promise<{ key: string }> }) {
  try {
    if (!(await isAdmin())) return NextResponse.json({ error: 'Только администратор' }, { status: 403 })
    const { key } = await ctx.params
    const svc = await db.serviceApp.findUnique({ where: { key } })
    if (!svc) return NextResponse.json({ error: 'Сервис не найден' }, { status: 404 })

    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null
    if (!body) return NextResponse.json({ error: 'Некорректные данные' }, { status: 400 })

    const data: Record<string, unknown> = {}
    if (typeof body.name === 'string' && body.name.trim()) data.name = body.name.trim().slice(0, 60)
    if (typeof body.description === 'string') data.description = body.description.slice(0, 200)
    if (typeof body.icon === 'string' && body.icon.trim()) data.icon = body.icon.trim().slice(0, 30)
    if (typeof body.path === 'string') data.path = body.path.slice(0, 60)
    if (body.status === 'ready' || body.status === 'placeholder') data.status = body.status
    if (typeof body.enabled === 'boolean') data.enabled = body.enabled
    if (typeof body.sortOrder === 'number' && Number.isFinite(body.sortOrder)) data.sortOrder = Math.round(body.sortOrder)
    if (!Object.keys(data).length) return NextResponse.json({ error: 'Нет полей для обновления' }, { status: 400 })

    const updated = await db.serviceApp.update({ where: { key }, data })
    /* вкл/выкл сервиса — мгновенно всем: список обновится без перезагрузки,
       кто был в выключенном сервисе — выйдет в доступный */
    if (typeof data.enabled === 'boolean') notifyServicesChanged()
    return NextResponse.json({ item: updated })
  } catch {
    return NextResponse.json({ error: 'Внутренняя ошибка' }, { status: 500 })
  }
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ key: string }> }) {
  try {
    if (!(await isAdmin())) return NextResponse.json({ error: 'Только администратор' }, { status: 403 })
    const { key } = await ctx.params
    if (PROTECTED_KEYS.has(key)) {
      return NextResponse.json({ error: 'Сервис «Ветви» — основа хаба, удалить его нельзя' }, { status: 400 })
    }
    const svc = await db.serviceApp.findUnique({ where: { key } })
    if (!svc) return NextResponse.json({ error: 'Сервис не найден' }, { status: 404 })
    await db.$transaction([db.serviceAccess.deleteMany({ where: { serviceKey: key } }), db.serviceApp.delete({ where: { key } })])
    notifyServicesChanged()
    return NextResponse.json({ ok: true })
  } catch {
    return NextResponse.json({ error: 'Внутренняя ошибка' }, { status: 500 })
  }
}
