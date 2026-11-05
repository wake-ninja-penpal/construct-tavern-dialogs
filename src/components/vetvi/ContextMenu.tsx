'use client'

/**
 * Контекстное меню холста — порт #ctx из прототипа.
 */

import { useEffect, useRef } from 'react'
import type { CtxEntry } from '@/lib/vetvi/types'
import { Icon } from './Icons'

export function ContextMenu({
  state,
  onClose,
}: {
  state: { x: number; y: number; items: CtxEntry[] } | null
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!state) return
    const el = ref.current
    if (el) {
      const r = el.getBoundingClientRect()
      el.style.left = Math.min(state.x, window.innerWidth - r.width - 10) + 'px'
      el.style.top = Math.min(state.y, window.innerHeight - r.height - 10) + 'px'
    }
  }, [state])

  if (!state) return null

  return (
    <div id="ctx" ref={ref} className="show" role="menu">
      {state.items.map((it, i) => {
        if (it === '-') return <div key={i} className="ctx-sep" />
        if (it.head) {
          return (
            <div key={i} className="ctx-h">
              {it.head}
            </div>
          )
        }
        return (
          <div
            key={i}
            className={'ctx-i' + (it.danger ? ' danger' : '')}
            role="menuitem"
            tabIndex={-1}
            onClick={(ev) => {
              ev.stopPropagation()
              onClose()
              it.fn?.()
            }}
          >
            {it.dot ? (
              <span className="dot" style={{ background: it.dot }} />
            ) : it.ico ? (
              <Icon name={it.ico} size={14} />
            ) : null}
            {it.label}
          </div>
        )
      })}
    </div>
  )
}
