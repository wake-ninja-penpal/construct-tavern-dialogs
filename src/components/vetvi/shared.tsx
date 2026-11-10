'use client'

/**
 * Общие дизайн-токены и мелкие компоненты «Ветвей».
 * Тёмная тема прототипа: bg #111214, панели #1b1d21, accent #7c5cff.
 */

import type { ConnectionState, MergeRequest } from '@/lib/vetvi/types'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
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
import { GitMerge } from 'lucide-react'

// ---------------------------
// Метки типов элементов
// ---------------------------

export const ELEMENT_LABELS: Record<'note' | 'dialogue' | 'text', string> = {
  note: 'Заметка',
  dialogue: 'Реплика',
  text: 'Текст',
}

// ---------------------------
// Пилюли статуса подключения
// ---------------------------

const CONNECTION_PILL: Record<ConnectionState, { label: string; className: string; pulse?: boolean }> = {
  offline: { label: 'офлайн', className: 'border-[#30343b] bg-[#1b1d21] text-[#9aa0a6]' },
  connecting: {
    label: 'подключение',
    className: 'border-[#f5a623]/40 bg-[#f5a623]/10 text-[#f5a623]',
    pulse: true,
  },
  connected: { label: 'подключено', className: 'border-[#2ecc71]/40 bg-[#2ecc71]/10 text-[#2ecc71]' },
  error: { label: 'ошибка', className: 'border-[#ff5a5f]/40 bg-[#ff5a5f]/10 text-[#ff5a5f]' },
}

export function StatusPill({ connection, className }: { connection: ConnectionState; className?: string }) {
  const cfg = CONNECTION_PILL[connection]
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-0.5 text-xs font-medium',
        cfg.className,
        cfg.pulse && 'animate-pulse',
        className,
      )}
    >
      <span className="size-1.5 shrink-0 rounded-full bg-current" aria-hidden />
      {cfg.label}
    </span>
  )
}

/** Серая нейтральная пилюля (режим «локально», «проект» и т.п.). */
export function MutedPill({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-[#30343b] bg-[#1b1d21] px-2.5 py-0.5 text-xs font-medium text-[#9aa0a6]',
        className,
      )}
    >
      {children}
    </span>
  )
}

// ---------------------------
// Merge-запросы
// ---------------------------

/**
 * Запрос ждёт решения владельца, пока он не applied/rejected/failed.
 * Отправитель кладёт запрос со статусом 'sent' (или 'queued'), поэтому
 * actionable-статусы для владельца — 'pending' и 'sent'.
 */
export function isPendingMerge(status: MergeRequest['status']): boolean {
  const s = String(status)
  return s === 'pending' || s === 'sent'
}

export function mergeStatusView(status: MergeRequest['status']): { label: string; className: string } {
  switch (String(status)) {
    case 'pending':
      return { label: 'ожидает решения', className: 'border-[#f5a623]/40 bg-[#f5a623]/10 text-[#f5a623]' }
    case 'queued':
      return { label: 'в очереди', className: 'border-[#30343b] bg-[#1b1d21] text-[#9aa0a6]' }
    case 'sent':
      return { label: 'ожидает решения', className: 'border-[#f5a623]/40 bg-[#f5a623]/10 text-[#f5a623]' }
    case 'applied':
      return { label: 'принят', className: 'border-[#2ecc71]/40 bg-[#2ecc71]/10 text-[#2ecc71]' }
    case 'rejected':
      return { label: 'отклонён', className: 'border-[#ff5a5f]/40 bg-[#ff5a5f]/10 text-[#ff5a5f]' }
    case 'failed':
      return { label: 'ошибка', className: 'border-[#ff5a5f]/40 bg-[#ff5a5f]/10 text-[#ff5a5f]' }
    default:
      return { label: String(status), className: 'border-[#30343b] bg-[#1b1d21] text-[#9aa0a6]' }
  }
}

export function MergeStatusBadge({ status }: { status: MergeRequest['status'] }) {
  const view = mergeStatusView(status)
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center whitespace-nowrap rounded-full border px-2 py-0.5 text-[10px] font-medium',
        view.className,
      )}
    >
      {view.label}
    </span>
  )
}

export function formatDateTime(ts: number): string {
  if (!ts) return '—'
  return new Date(ts).toLocaleString('ru-RU')
}

export function formatStats(stats: MergeRequest['stats']): string {
  return `+${stats.added} / ~${stats.updated} / −${stats.deleted}`
}

// ---------------------------
// Карточка merge-запроса
// ---------------------------

export function MergeRequestCard({
  request,
  compact = false,
  onAccept,
  onReject,
}: {
  request: MergeRequest
  /** compact — маленькая карточка для левой панели; иначе крупнее (для диалога). */
  compact?: boolean
  onAccept?: (id: string) => void
  onReject?: (id: string) => void
}) {
  const pending = isPendingMerge(request.status)
  const showActions = pending && Boolean(onAccept || onReject)

  return (
    <div
      className={cn(
        'rounded-lg border border-[#30343b] bg-[#14161a]',
        compact ? 'p-2.5' : 'p-4',
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <p className="truncate text-sm font-medium text-[#e8eaed]">{request.senderName}</p>
        <MergeStatusBadge status={request.status} />
      </div>
      <p className={cn('mt-0.5 text-xs text-[#9aa0a6]', compact && 'text-[11px]')}>
        <span className="font-medium text-[#9aa0a6]">{formatStats(request.stats)}</span>
        {' · '}
        {formatDateTime(request.createdAt)}
      </p>

      {showActions && (
        <div className="mt-2.5 flex gap-2">
          {onAccept && (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  size="sm"
                  className="h-8 flex-1 bg-[#2ecc71] text-[#0f1114] shadow-none hover:bg-[#29b765]"
                >
                  <GitMerge className="size-3.5" aria-hidden />
                  Принять
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent className="border-[#30343b] bg-[#1b1d21] text-[#e8eaed]">
                <AlertDialogHeader>
                  <AlertDialogTitle>Принять merge-запрос?</AlertDialogTitle>
                  <AlertDialogDescription className="text-[#9aa0a6]">
                    Создать backup и применить изменения от «{request.senderName}» (
                    {formatStats(request.stats)})?
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel className="border-[#30343b] bg-[#23262b] text-[#e8eaed] hover:bg-[#2b2f36] hover:text-white">
                    Отмена
                  </AlertDialogCancel>
                  <AlertDialogAction
                    className="bg-[#2ecc71] text-[#0f1114] hover:bg-[#29b765]"
                    onClick={() => onAccept(request.id)}
                  >
                    Принять
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
          {onReject && (
            <Button
              size="sm"
              variant="ghost"
              className="h-8 flex-1 text-[#ff5a5f] hover:bg-[#ff5a5f]/10 hover:text-[#ff5a5f]"
              onClick={() => onReject(request.id)}
            >
              Отклонить
            </Button>
          )}
        </div>
      )}
    </div>
  )
}
