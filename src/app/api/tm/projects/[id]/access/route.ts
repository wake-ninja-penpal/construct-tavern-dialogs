import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { canAdminProject, notifyTaskUser, requireTaskService } from '@/lib/tasks'

/**
 * PUT /api/tm/projects/[id]/access { rows: [{login?|teamId?, role}] } —
 * заменить ВСЕ строки доступов проекта (админ проекта). Сохраняющий админ
 * всегда сохраняет себе персональную админ-строку — проект без участников
 * через это окно получить нельзя.
 * GET — текущие строки (только админ проекта: состав участников
 * невидимого для пользователя проекта не раскрываем).
 * Единая система уведомлений: персональные НОВЫЕ доступы (строка по логину,
 * которой раньше не было) создают tm_access_granted — колокольчик во всех
 * сервисах покажет «вам открыли доступ к проекту в менеджере задач».
 */
export async function GET(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireTaskService()
    if (!user) return NextResponse.json({ error: 'Сервис недоступен' }, { status: 403 })
    const { id } = await ctx.params
    if (!(await canAdminProject(id, user.login))) {
      return NextResponse.json({ error: 'Управлять доступом может только админ проекта' }, { status: 403 })
    }
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
    const project = await db.taskProject.findUnique({ where: { id }, select: { id: true, title: true } })
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
    /* прежние персональные доступы — чтобы уведомить только НОВЫЕ (единый
       колокольчик: замена списка не должна спамить всех каждый раз) */
    const prevRows = await db.taskProjectAccess.findMany({ where: { projectId: id }, select: { login: true } })
    const prevLogins = new Set(prevRows.map((r) => r.login).filter((x): x is string => !!x))
    await db.taskProjectAccess.deleteMany({ where: { projectId: id } })
    /* сохраняющий админ всегда сохраняет себе персональный админ-доступ:
       иначе, сняв команду или ошибившись в списке, он выкинет сам себя
       из проекта и потеряет право управлять доступом (и сам проект —
       участники — те, кто есть в этом списке) */
    if (!validRows.some((r) => r.login === user.login)) {
      validRows.push({ login: user.login, teamId: null, role: 'admin' })
    }
    if (validRows.length) {
      await db.taskProjectAccess.createMany({ data: validRows.map((r) => ({ projectId: id, ...r })) })
    }
    /* уведомления о новых персональных доступах (кроме самого администратора) */
    const by = user.displayName || user.login
    for (const row of validRows) {
      if (!row.login || row.login === user.login || prevLogins.has(row.login)) continue
      void notifyTaskUser(row.login, 'tm_access_granted', {
        projectId: id,
        projectName: project.title,
        role: row.role,
        byLogin: user.login,
        byName: by,
      })
    }
    const items = await db.taskProjectAccess.findMany({ where: { projectId: id }, orderBy: { createdAt: 'asc' } })
    return NextResponse.json({ items })
  } catch {
    return NextResponse.json({ error: 'Внутренняя ошибка' }, { status: 500 })
  }
}
