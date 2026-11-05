'use client'

/**
 * LeftPanel — добавление элементов, список копий и merge-запросы.
 */

import type { VetviStore } from '@/lib/vetvi/store'
import type { VetviSnapshot } from '@/lib/vetvi/types'
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
import {
  GitPullRequestArrow,
  MessageSquareText,
  StickyNote,
  Trash2,
  Type,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { MergeRequestCard, formatDateTime } from './shared'

const ACCENT_BTN = 'bg-[#7c5cff] text-white shadow-none hover:bg-[#6d4ef2]'

export interface LeftPanelProps {
  store: VetviStore
  snapshot: VetviSnapshot
  className?: string
  onSendMerge: () => void
}

export function LeftPanel({ store, snapshot, className, onSendMerge }: LeftPanelProps) {
  const isCopy = snapshot.mode === 'copy'
  const requests = isCopy ? snapshot.outgoing : snapshot.incoming

  return (
    <aside
      aria-label="Панель элементов и копий"
      className={cn(
        'vetvi-scroll flex min-h-0 flex-col gap-4 overflow-y-auto border-b border-[#30343b] bg-[#1b1d21] p-3 md:border-b-0 md:border-r',
        className,
      )}
    >
      {/* Элементы */}
      <section aria-label="Добавить элемент" className="flex flex-col gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-[#9aa0a6]">Элементы</h3>
        <div className="grid grid-cols-3 gap-2">
          <Button
            variant="secondary"
            className="h-auto flex-col gap-1.5 border border-[#30343b] bg-[#23262b] px-1 py-2.5 text-[11px] font-medium text-[#e8eaed] shadow-none hover:bg-[#2b2f36] hover:text-white"
            onClick={() => store.addElement('note')}
            aria-label="Добавить заметку"
          >
            <StickyNote className="size-4 text-[#7c5cff]" aria-hidden />
            Заметка
          </Button>
          <Button
            variant="secondary"
            className="h-auto flex-col gap-1.5 border border-[#30343b] bg-[#23262b] px-1 py-2.5 text-[11px] font-medium text-[#e8eaed] shadow-none hover:bg-[#2b2f36] hover:text-white"
            onClick={() => store.addElement('dialogue')}
            aria-label="Добавить реплику"
          >
            <MessageSquareText className="size-4 text-[#4cc9f0]" aria-hidden />
            Реплика
          </Button>
          <Button
            variant="secondary"
            className="h-auto flex-col gap-1.5 border border-[#30343b] bg-[#23262b] px-1 py-2.5 text-[11px] font-medium text-[#e8eaed] shadow-none hover:bg-[#2b2f36] hover:text-white"
            onClick={() => store.addElement('text')}
            aria-label="Добавить текстовый блок"
          >
            <Type className="size-4 text-[#f5a623]" aria-hidden />
            Текст
          </Button>
        </div>
      </section>

      {/* Копии */}
      <section aria-label="Копии проекта" className="flex flex-col gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-[#9aa0a6]">Копии</h3>
        {snapshot.copies.length === 0 ? (
          <p className="text-xs text-[#9aa0a6]">Копий пока нет</p>
        ) : (
          <ul className="vetvi-scroll flex max-h-56 flex-col gap-2 overflow-y-auto pr-1">
            {snapshot.copies.map((copy) => (
              <li
                key={copy.copyId}
                className="rounded-lg border border-[#30343b] bg-[#14161a] p-2.5"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-[#e8eaed]" title={copy.name}>
                      {copy.name}
                    </p>
                    <p className="mt-0.5 text-[11px] text-[#9aa0a6]">
                      {formatDateTime(copy.createdAt)}
                    </p>
                  </div>
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-7 shrink-0 text-[#ff5a5f] hover:bg-[#ff5a5f]/10 hover:text-[#ff5a5f]"
                        aria-label={`Удалить копию «${copy.name}»`}
                      >
                        <Trash2 className="size-3.5" aria-hidden />
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent className="border-[#30343b] bg-[#1b1d21] text-[#e8eaed]">
                      <AlertDialogHeader>
                        <AlertDialogTitle>Удалить копию?</AlertDialogTitle>
                        <AlertDialogDescription className="text-[#9aa0a6]">
                          Копия «{copy.name}» будет удалена безвозвратно.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel className="border-[#30343b] bg-[#23262b] text-[#e8eaed] hover:bg-[#2b2f36] hover:text-white">
                          Отмена
                        </AlertDialogCancel>
                        <AlertDialogAction
                          className="bg-[#ff5a5f] text-white shadow-none hover:bg-[#e64c51]"
                          onClick={() => void store.deleteCopy(copy.copyId)}
                        >
                          Удалить
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                </div>
                <Button
                  variant="secondary"
                  size="sm"
                  className="mt-2 h-7 w-full border border-[#30343b] bg-[#23262b] text-xs text-[#e8eaed] shadow-none hover:bg-[#2b2f36] hover:text-white"
                  onClick={() => void store.openCopy(copy.copyId)}
                >
                  Открыть
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* Merge-запросы */}
      <section aria-label="Merge-запросы" className="flex flex-col gap-2">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-[#9aa0a6]">
          Merge-запросы
        </h3>

        {isCopy && (
          <Button
            variant="secondary"
            size="sm"
            className="h-8 border border-[#30343b] bg-[#23262b] text-xs text-[#e8eaed] shadow-none hover:bg-[#2b2f36] hover:text-white"
            onClick={onSendMerge}
          >
            <GitPullRequestArrow className="size-3.5" aria-hidden />
            Отправить merge
          </Button>
        )}

        {!isCopy && !snapshot.mailboxActive && (
          <p className="text-xs text-[#9aa0a6]">
            Поделитесь проектом, чтобы получать merge-запросы
          </p>
        )}

        {requests.length === 0 ? (
          <p className="text-xs text-[#9aa0a6]">
            {isCopy ? 'Вы ещё не отправляли merge-запросов' : 'Входящих merge-запросов нет'}
          </p>
        ) : (
          <div className="vetvi-scroll flex max-h-56 flex-col gap-2 overflow-y-auto pr-1">
            {requests.map((request) => (
              <MergeRequestCard
                key={request.id}
                request={request}
                compact
                onAccept={
                  !isCopy && snapshot.mailboxActive
                    ? (id) => void store.acceptMerge(id)
                    : undefined
                }
                onReject={!isCopy ? (id) => void store.rejectMerge(id) : undefined}
              />
            ))}
          </div>
        )}
      </section>
    </aside>
  )
}
