import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { canAdminProject, requireTaskService } from '@/lib/tasks'

/**
 * PUT /api/tm/projects/[id]/access { rows: [{login?|teamId?, role}] } —
 * заменить ВСЕ строки доступов проекта (админ проекта). Пустой массив —
 * проект снова открыт всем пользователям сервиса.
 * GET — текущие строки (для модалки доступов; админ или обычный просмотр).
 */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireTaskService()
    if (!user) return NextResponse.json({ error: 'Сервис недоступен' }, { status: 403 })
    const { id } = await ctx.params
    const items = await db.taskProjectAccess.findMany({ where: { projectId: id }, orderBy: { createdAt: 'asc' } })
    return NextResponse.json({ items })
  } catch {
    return NextResponse.json({ error: 'Внутренняя ошибка' }, { status: 500 })
  }
}

export async function PUT(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireTaskService()
    if (!user) return NextResponse.json({ error: 'Сервис недоступен' }, { status: 403 })
    const { id } = await ctx.params
    if (!(await canAdminProject(id, user.login))) {
      return NextResponse.json({ error: 'Управлять доступом может только админ проекта' }, { status: 403 })
    }
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null
    const rowsIn = body && Array.isArray(body.rows) ? body.rows : []
    const okRole = (r: unknown): string | null => (r === 'admin' || r === 'editor' || r === 'viewer' ? r : null)
    /* проверяем проект и существование команд */
    const project = await db.taskProject.findUnique({ where: { id }, select: { id: true } })
    if (!project) return NextResponse.json({ error: 'Проект не найден' }, { status: 404 })
    const validRows: { login: string | null; teamId: string | null; role: string }[] = []
    for (const raw of rowsIn.slice(0, 120)) {
      if (!raw || typeof raw !== 'object') continue
      const o = raw as Record<string, unknown>
      const role = okRole(o.role)
      if (!role) continue
      if (typeof o.login === 'string' && o.login.trim()) {
        validRows.push({ login: o.login.trim().slice(0, 80), teamId: null, role })
      } else if (typeof o.teamId === 'string' && o.teamId.trim()) {
        const team = await db.taskTeam.findUnique({ where: { id: o.teamId.trim().slice(0, 40) }, select: { id: true } })
        if (team) validRows.push({ login: null, teamId: team.id, role })
      }
    }
    await db.taskProjectAccess.deleteMany({ where: { projectId: id } })
    /* сохраняющий админ всегда сохраняет себе персональный админ-доступ:
       иначе, сняв команду или ошибившись в списке, он выкинет сам себя
       из проекта и потеряет право управлять доступом */
    if (!validRows.some((r) => r.login === user.login)) {
      validRows.push({ login: user.login, teamId: null, role: 'admin' })
    }
    if (validRows.length) {
      await db.taskProjectAccess.createMany({ data: validRows.map((r) => ({ projectId: id, ...r })) })
    }
    const items = await db.taskProjectAccess.findMany({ where: { projectId: id }, orderBy: { createdAt: 'asc' } })
    return NextResponse.json({ items })
  } catch {
    return NextResponse.json({ error: 'Внутренняя ошибка' }, { status: 500 })
  }
}
