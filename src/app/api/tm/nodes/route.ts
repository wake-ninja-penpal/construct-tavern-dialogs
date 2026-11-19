import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { parseLinks, requireTaskService, TASK_SERVICE_KEY } from '@/lib/tasks'
import { userHasService } from '@/lib/services'

/**
 * GET /api/tm/nodes?scope=<roomId|projectId>&ids=<nodeId,nodeId…>
 *
 * Подсказки для «Ветвей»: какие задачи привязаны к нодам открытого проекта.
 * scope — идентификатор проекта «Ветвей» (roomId сетевой комнаты или id
 * локального слота — тот же, что пишется в link.pid при создании задачи).
 * Возвращает map: nodeId → { n: всего задач, a: активных, s: состояние
 * ('new'|'progress'|'done'), ts: [{id,title,done}] } — «Ветви» рисуют иконку
 * прогресса над нодой; цвет иконки = состояние задач (серый/янтарный/зелёный).
 */
export async function GET(req: NextRequest) {
  try {
    const user = await requireTaskService()
    if (!user) return NextResponse.json({ error: 'Сервис недоступен' }, { status: 403 })
    const url = new URL(req.url)
    const scope = String(url.searchParams.get('scope') || '').slice(0, 80)
    const idsRaw = String(url.searchParams.get('ids') || '')
    const ids = idsRaw.split(',').map((s) => s.trim().slice(0, 80)).filter(Boolean).slice(0, 120)
    if (!scope || !ids.length) return NextResponse.json({ items: {} })
    /* сервис выключен/запрещён — подсказок нет (как и сам сервис) */
    const svcOk = await userHasService(user, TASK_SERVICE_KEY)
    if (!svcOk) return NextResponse.json({ items: {} })

    const tasks = await db.taskItem.findMany({
      where: { links: { contains: '"pid":"' + scope + '"' } },
      select: { id: true, title: true, done: true, columnId: true, links: true },
    })
    /* kind колонок — для состояния «в работе» */
    const colIds = [...new Set(tasks.map((t) => t.columnId).filter((x): x is string => !!x))]
    const cols = colIds.length
      ? await db.taskColumn.findMany({ where: { id: { in: colIds } }, select: { id: true, kind: true } })
      : []
    const colKind = new Map(cols.map((c) => [c.id, c.kind]))

    const out: Record<string, { n: number; a: number; s: string; ts: { id: string; title: string; done: boolean }[] }> = {}
    for (const t of tasks) {
      const links = parseLinks(t.links)
      for (const l of links) {
        if (l.pid !== scope) continue
        if (!ids.includes(l.nid)) continue
        const rec = out[l.nid] || { n: 0, a: 0, s: 'new', ts: [] }
        rec.n++
        if (!t.done) rec.a++
        rec.ts.push({ id: t.id, title: String(t.title || '').slice(0, 120), done: t.done })
        /* состояние ноды: «в работе» если хоть одна активная задача в progress-
           колонке; «не взяты» если активные есть в new/бэклоге; «выполнено» —
           все задачи выполнены */
        const kind = t.columnId ? colKind.get(t.columnId) || '' : ''
        if (!t.done) {
          if (kind === 'progress') rec.s = 'progress'
          else if (rec.s !== 'progress') rec.s = 'new'
        }
        out[l.nid] = rec
      }
    }
    /* все задачи выполнены → состояние done (перекрывает 'new') */
    for (const nid of Object.keys(out)) {
      const rec = out[nid]
      if (rec.a === 0 && rec.n > 0) rec.s = 'done'
    }
    return NextResponse.json({ items: out })
  } catch {
    return NextResponse.json({ error: 'Внутренняя ошибка' }, { status: 500 })
  }
}
