import { NextResponse } from 'next/server'
import { authEnabled, currentUser } from '@/lib/auth'
import { listServicesForUser } from '@/lib/services'

/**
 * GET /api/services — список сервисов, видимых текущему пользователю
 * (включённые в реестре, без персонального запрета).
 *
 * Не залогинен: если авторизация выключена — все включённые сервисы
 * (fail-open режим разработки); если включена — 401.
 */
export async function GET() {
  try {
    const user = await currentUser()
    if (!user && (await authEnabled())) {
      return NextResponse.json({ error: 'anon' }, { status: 401 })
    }
    const items = await listServicesForUser(user)
    return NextResponse.json({ items })
  } catch {
    return NextResponse.json({ error: 'Внутренняя ошибка' }, { status: 500 })
  }
}
