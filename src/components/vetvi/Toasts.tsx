'use client'

/**
 * Тосты «Ветвей» — порт системы toast() из прототипа
 * (цветная точка ok/warn/err, справа снизу, авто-скрытие).
 */

import type { ToastItem } from '@/lib/vetvi/types'

export function Toasts({ items }: { items: ToastItem[] }) {
  if (typeof window === 'undefined') return null
  return (
    <div id="toasts" aria-live="polite">
      {items.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          <span className="td" />
          {t.message}
        </div>
      ))}
    </div>
  )
}
