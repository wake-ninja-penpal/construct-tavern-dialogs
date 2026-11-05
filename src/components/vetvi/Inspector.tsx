'use client'

/**
 * Inspector — название проекта, свойства выбранного элемента и статус сохранения.
 *
 * Паттерн локального редактирования (проходит строгий react-hooks lint):
 *   - draft — активный ввод пользователя;
 *   - awaiting — значение, уже записанное в store, но ещё не подтверждённое снапшотом
 *     (убирает «мигание» старого значения из-за debounce нотификаций);
 *   - когда snapshot догоняет, показывается живое значение из store.
 * Текст элемента коммитится с live=true — снапшот обновляется мгновенно.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { VetviStore } from '@/lib/vetvi/store'
import type { VetviSnapshot, ElementRecord } from '@/lib/vetvi/types'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { ELEMENT_LABELS } from './shared'

const INPUT_CLS =
  'h-8 border-[#30343b] bg-[#14161a] text-sm text-[#e8eaed] placeholder:text-[#5f6570] focus-visible:ring-[#7c5cff]/40'
const DANGER_ACTION = 'bg-[#ff5a5f] text-white shadow-none hover:bg-[#e64c51]'
const CANCEL_ACTION =
  'border border-[#30343b] bg-[#23262b] text-[#e8eaed] hover:bg-[#2b2f36] hover:text-white'

export interface InspectorProps {
  store: VetviStore
  snapshot: VetviSnapshot
  className?: string
}

export function Inspector({ store, snapshot, className }: InspectorProps) {
  const selected: ElementRecord | null =
    snapshot.elements.find((el) => el.id === snapshot.selectedId) ?? null

  return (
    <aside
      aria-label="Инспектор"
      className={cn(
        'vetvi-scroll flex min-h-0 flex-col gap-3 overflow-y-auto border-t border-[#30343b] bg-[#1b1d21] p-3 md:border-l md:border-t-0',
        className,
      )}
    >
      <h3 className="text-xs font-semibold uppercase tracking-wider text-[#9aa0a6]">Инспектор</h3>

      {/* key — пересоздание локального черновика при смене проекта */}
      <ProjectNameSection
        key={snapshot.meta?.projectId ?? 'no-project'}
        store={store}
        name={snapshot.meta?.name ?? ''}
      />

      {selected ? (
        <ElementSection store={store} element={selected} />
      ) : (
        <p className="text-sm text-[#9aa0a6]">Выберите элемент на холсте</p>
      )}

      <StatusFooter snapshot={snapshot} />
    </aside>
  )
}

// ---------------------------
// Название проекта (debounce 250ms)
// ---------------------------

function ProjectNameSection({ store, name }: { store: VetviStore; name: string }) {
  const [draft, setDraft] = useState<string | null>(null)
  const [awaiting, setAwaiting] = useState<string | null>(null)
  const pendingRef = useRef<string | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const commitPending = useCallback(() => {
    const pending = pendingRef.current
    pendingRef.current = null
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    if (pending !== null) {
      store.setProjectName(pending)
    }
    return pending
  }, [store])

  // Незавершённый ввод фиксируется при размонтировании.
  useEffect(() => {
    const pending = pendingRef
    const timer = timerRef
    return () => {
      const value = pending.current
      pending.current = null
      if (timer.current) {
        clearTimeout(timer.current)
        timer.current = null
      }
      if (value !== null) {
        store.setProjectName(value)
      }
    }
  }, [store])

  const handleChange = (next: string) => {
    setDraft(next)
    pendingRef.current = next
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => {
      timerRef.current = null
      const value = commitPending()
      if (value !== null) {
        setAwaiting(value)
        setDraft(null)
      }
    }, 250)
  }

  const handleBlur = () => {
    const value = commitPending()
    if (value !== null) {
      setAwaiting(value)
      setDraft(null)
    }
  }

  // draft — активный ввод; awaiting — записано в store, снапшот ещё не обновился.
  const display = draft ?? (awaiting !== null && awaiting !== name ? awaiting : name)

  return (
    <section aria-label="Название проекта" className="flex flex-col gap-1.5">
      <Label htmlFor="vetvi-project-name" className="text-xs text-[#9aa0a6]">
        Название проекта
      </Label>
      <Input
        id="vetvi-project-name"
        value={display}
        onChange={(event) => handleChange(event.target.value)}
        onFocus={() => setAwaiting(null)}
        onBlur={handleBlur}
        className={INPUT_CLS}
        placeholder="Название проекта"
        maxLength={120}
      />
    </section>
  )
}

// ---------------------------
// Выбранный элемент
// ---------------------------

function ElementSection({ store, element }: { store: VetviStore; element: ElementRecord }) {
  return (
    <section aria-label="Свойства элемента" className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="vetvi-element-type" className="text-xs text-[#9aa0a6]">
          Тип элемента
        </Label>
        <Input
          id="vetvi-element-type"
          readOnly
          value={ELEMENT_LABELS[element.type]}
          className={cn(INPUT_CLS, 'cursor-default text-[#9aa0a6]')}
        />
      </div>

      <div className="grid grid-cols-2 gap-2">
        <NumberField
          label="X"
          value={element.x}
          onCommit={(n) => store.updateElement(element.id, { x: n }, true)}
        />
        <NumberField
          label="Y"
          value={element.y}
          onCommit={(n) => store.updateElement(element.id, { y: n }, true)}
        />
        <NumberField
          label="Ширина"
          value={element.width}
          onCommit={(n) => store.updateElement(element.id, { width: n }, true)}
        />
        <NumberField
          label="Высота"
          value={element.height}
          onCommit={(n) => store.updateElement(element.id, { height: n }, true)}
        />
      </div>

      <ElementTextEditor store={store} element={element} />

      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button variant="destructive" className={cn(DANGER_ACTION, 'h-9')}>
            <Trash2 className="size-3.5" aria-hidden />
            Удалить элемент
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent className="border-[#30343b] bg-[#1b1d21] text-[#e8eaed]">
          <AlertDialogHeader>
            <AlertDialogTitle>Удалить элемент?</AlertDialogTitle>
            <AlertDialogDescription className="text-[#9aa0a6]">
              {ELEMENT_LABELS[element.type]} будет удалён с холста безвозвратно.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className={CANCEL_ACTION}>Отмена</AlertDialogCancel>
            <AlertDialogAction
              className={DANGER_ACTION}
              onClick={() => store.deleteElement(element.id)}
            >
              Удалить
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
}

function NumberField({
  label,
  value,
  onCommit,
}: {
  label: string
  value: number
  onCommit: (n: number) => void
}) {
  return (
    <div className="flex flex-col gap-1">
      <Label className="text-[11px] text-[#9aa0a6]">{label}</Label>
      <Input
        type="number"
        aria-label={label}
        value={value}
        onChange={(event) => {
          const n = Number(event.target.value)
          if (Number.isFinite(n)) {
            onCommit(n)
          }
        }}
        className={INPUT_CLS}
      />
    </div>
  )
}

// ---------------------------
// Текст элемента (локальный draft + debounce 300ms)
// ---------------------------

function ElementTextEditor({ store, element }: { store: VetviStore; element: ElementRecord }) {
  const [draft, setDraft] = useState<{ id: string; text: string } | null>(null)
  const pendingRef = useRef<{ id: string; text: string } | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const commitPending = useCallback(() => {
    const pending = pendingRef.current
    pendingRef.current = null
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
    // live=true — снапшот обновится синхронно, без «мигания» значения.
    if (pending) {
      store.updateElement(pending.id, { text: pending.text }, true)
    }
    return pending
  }, [store])

  // Незавершённый ввод фиксируется при размонтировании.
  useEffect(() => {
    const pending = pendingRef
    const timer = timerRef
    return () => {
      const value = pending.current
      pending.current = null
      if (timer.current) {
        clearTimeout(timer.current)
        timer.current = null
      }
      if (value) {
        store.updateElement(value.id, { text: value.text }, true)
      }
    }
  }, [store])

  const handleChange = (next: string) => {
    // Переключение элемента до срабатывания таймера — фиксируем чужой черновик.
    if (pendingRef.current && pendingRef.current.id !== element.id) {
      commitPending()
    }
    setDraft({ id: element.id, text: next })
    pendingRef.current = { id: element.id, text: next }
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => {
      timerRef.current = null
      commitPending()
      setDraft(null)
    }, 300)
  }

  const handleBlur = () => {
    if (pendingRef.current && pendingRef.current.id === element.id) {
      commitPending()
      setDraft(null)
    }
  }

  // draft показываем только пока он относится к текущему элементу;
  // после коммита draft сбрасывается и отображается живое значение из store.
  const draftText = draft && draft.id === element.id ? draft.text : null
  const display = draftText ?? element.text

  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor="vetvi-element-text" className="text-xs text-[#9aa0a6]">
        Текст
      </Label>
      <Textarea
        id="vetvi-element-text"
        value={display}
        onChange={(event) => handleChange(event.target.value)}
        onBlur={handleBlur}
        placeholder="Введите текст…"
        className="vetvi-scroll min-h-[120px] resize-y border-[#30343b] bg-[#14161a] text-[13px] text-[#e8eaed] placeholder:text-[#5f6570] focus-visible:ring-[#7c5cff]/40"
      />
    </div>
  )
}

// ---------------------------
// Статусная строка
// ---------------------------

function StatusFooter({ snapshot }: { snapshot: VetviSnapshot }) {
  return (
    <div
      className="mt-auto flex flex-col gap-1 border-t border-[#30343b] pt-3 text-xs"
      aria-live="polite"
    >
      <p className={cn('text-[#9aa0a6]', snapshot.saveState === 'saving' && 'animate-pulse')}>
        {snapshot.saveState === 'saving' ? 'Сохранение…' : 'Сохранено локально'}
      </p>

      {snapshot.roomActive && (
        <p className={snapshot.connection === 'connected' ? 'text-[#2ecc71]' : 'text-[#f5a623]'}>
          {snapshot.connection === 'connected'
            ? 'Синхронизировано с комнатой'
            : 'Ожидание подключения…'}
        </p>
      )}

      {snapshot.mode === 'copy' && (
        <p className="text-[#f5a623]">
          Режим копии: изменения не попадут в оригинал автоматически
        </p>
      )}
    </div>
  )
}
