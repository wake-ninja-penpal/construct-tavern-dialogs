'use client'

/**
 * Canvas — бесконечный холст с перетаскиваемыми узлами (заметка / реплика / текст).
 * Drag реализован через Pointer Events + rAF-throttle (live-обновления стора).
 */

import { useRef, useState } from 'react'
import type { ElementRecord } from '@/lib/vetvi/types'
import { cn } from '@/lib/utils'
import { ELEMENT_LABELS } from './shared'

export const CANVAS_WIDTH = 4000
export const CANVAS_HEIGHT = 3000

const NODE_STYLES: Record<ElementRecord['type'], { background: string; borderColor: string }> = {
  note: { background: 'linear-gradient(135deg, #20242a 0%, #191c20 100%)', borderColor: '#3a4048' },
  dialogue: { background: 'linear-gradient(135deg, #1d2a33 0%, #172028 100%)', borderColor: '#2f596b' },
  text: { background: 'linear-gradient(135deg, #2a241d 0%, #201c17 100%)', borderColor: '#6b5a2f' },
}

interface DragState {
  startClientX: number
  startClientY: number
  startElX: number
  startElY: number
  moved: boolean
  raf: number
  pending: { x: number; y: number } | null
}

export interface CanvasProps {
  elements: ElementRecord[]
  selectedId: string | null
  className?: string
  onSelectElement: (id: string | null) => void
  onElementDrag: (id: string, x: number, y: number) => void
}

export function Canvas({
  elements,
  selectedId,
  className,
  onSelectElement,
  onElementDrag,
}: CanvasProps) {
  const handleBackgroundPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) {
      onSelectElement(null)
    }
  }

  return (
    <div
      className={cn('vetvi-scroll relative overflow-auto', className)}
      style={{
        background:
          'radial-gradient(circle at 1px 1px, rgba(255,255,255,.08) 1px, transparent 0) 0 0 / 24px 24px, #0f1114',
      }}
    >
      <div
        id="canvas"
        className="relative"
        style={{ width: CANVAS_WIDTH, height: CANVAS_HEIGHT }}
        onPointerDown={handleBackgroundPointerDown}
      >
        {elements.map((el) => (
          <CanvasNode
            key={el.id}
            el={el}
            selected={el.id === selectedId}
            onSelect={() => onSelectElement(el.id)}
            onDragMove={(x, y) => onElementDrag(el.id, x, y)}
          />
        ))}

        {elements.length === 0 && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <p className="rounded-lg bg-[#14161a]/80 px-4 py-2 text-sm text-[#9aa0a6]">
              Холст пуст — добавьте элемент слева
            </p>
          </div>
        )}
      </div>
    </div>
  )
}

function CanvasNode({
  el,
  selected,
  onSelect,
  onDragMove,
}: {
  el: ElementRecord
  selected: boolean
  onSelect: () => void
  onDragMove: (x: number, y: number) => void
}) {
  const style = NODE_STYLES[el.type] ?? NODE_STYLES.note
  const dragRef = useRef<DragState | null>(null)
  const [grabbing, setGrabbing] = useState(false)

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    // Только основная кнопка мыши / палец / перо.
    if (event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()

    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {
      // pointer уже неактивен — не критично
    }

    dragRef.current = {
      startClientX: event.clientX,
      startClientY: event.clientY,
      startElX: el.x,
      startElY: el.y,
      moved: false,
      raf: 0,
      pending: null,
    }

    // Выделяем сразу при нажатии (и клик, и drag).
    onSelect()
    setGrabbing(false)
  }

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag) return

    const dx = event.clientX - drag.startClientX
    const dy = event.clientY - drag.startClientY

    if (!drag.moved) {
      if (Math.hypot(dx, dy) <= 3) return
      drag.moved = true
      setGrabbing(true)
    }

    drag.pending = { x: drag.startElX + dx, y: drag.startElY + dy }
    if (!drag.raf) {
      drag.raf = requestAnimationFrame(() => {
        drag.raf = 0
        if (dragRef.current !== drag || !drag.pending) return
        onDragMove(drag.pending.x, drag.pending.y)
      })
    }
  }

  const endDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag) return
    dragRef.current = null

    if (drag.raf) {
      cancelAnimationFrame(drag.raf)
      drag.raf = 0
    }
    // Финальная позиция — фиксируем сразу.
    if (drag.moved && drag.pending) {
      onDragMove(drag.pending.x, drag.pending.y)
    }

    setGrabbing(false)
    try {
      event.currentTarget.releasePointerCapture(event.pointerId)
    } catch {
      // ignore
    }
  }

  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={`${ELEMENT_LABELS[el.type]}${el.text ? `: ${el.text.slice(0, 60)}` : ' (пусто)'}`}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onSelect()
        }
      }}
      className={cn(
        'absolute select-none touch-none overflow-hidden rounded-xl border p-3 shadow-lg outline-none transition-shadow duration-150',
        grabbing ? 'cursor-grabbing' : 'cursor-grab',
        selected && 'z-10 ring-2 ring-[#7c5cff]/25',
        !selected && 'hover:shadow-xl',
      )}
      style={{
        left: el.x,
        top: el.y,
        width: el.width,
        height: el.height,
        background: style.background,
        borderColor: selected ? '#7c5cff' : style.borderColor,
      }}
    >
      <p className="text-[10px] font-semibold uppercase tracking-wider text-[#9aa0a6]">
        {ELEMENT_LABELS[el.type]}
      </p>
      {el.text ? (
        <p className="mt-1 line-clamp-[8] whitespace-pre-wrap break-words text-[13px] leading-snug text-[#e8eaed]">
          {el.text}
        </p>
      ) : (
        <p className="mt-1 text-[13px] italic leading-snug text-[#9aa0a6]">
          Пусто — выберите и отредактируйте в инспекторе
        </p>
      )}
    </div>
  )
}
