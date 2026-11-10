'use client'

/**
 * MergeDialog — входящие/исходящие merge-запросы и резервные копии.
 */

import type { VetviStore } from '@/lib/vetvi/store'
import type { VetviSnapshot } from '@/lib/vetvi/types'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
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
import { History, RefreshCw } from 'lucide-react'
import { MergeRequestCard, formatDateTime } from './shared'

const SECONDARY_BTN =
  'border border-[#30343b] bg-[#23262b] text-[#e8eaed] shadow-none hover:bg-[#2b2f36] hover:text-white'
const DANGER_ACTION = 'bg-[#ff5a5f] text-white shadow-none hover:bg-[#e64c51]'
const CANCEL_ACTION =
  'border border-[#30343b] bg-[#23262b] text-[#e8eaed] hover:bg-[#2b2f36] hover:text-white'

export interface MergeDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  snapshot: VetviSnapshot
  store: VetviStore
}

export function MergeDialog({ open, onOpenChange, snapshot, store }: MergeDialogProps) {
  const isCopy = snapshot.mode === 'copy'
  const requests = isCopy ? snapshot.outgoing : snapshot.incoming

  const handleRefresh = () => {
    void store.refreshCopies()
    void store.refreshBackups()
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="border-[#30343b] bg-[#1b1d21] text-[#e8eaed] sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{isCopy ? 'Мои merge-запросы' : 'Merge-запросы'}</DialogTitle>
          <DialogDescription className="text-[#9aa0a6]">
            {isCopy
              ? 'Статус отправленных изменений из этой копии в оригинал'
              : 'Изменения, предложенные владельцами копий'}
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center justify-between gap-2">
          <p className="text-xs font-semibold uppercase tracking-wider text-[#9aa0a6]">
            {isCopy ? 'Исходящие' : 'Входящие'}
          </p>
          <Button variant="secondary" size="sm" className={SECONDARY_BTN} onClick={handleRefresh}>
            <RefreshCw className="size-3.5" aria-hidden />
            Обновить
          </Button>
        </div>

        <div className="vetvi-scroll flex max-h-[38vh] flex-col gap-3 overflow-y-auto pr-1">
          {requests.length === 0 ? (
            <p className="py-2 text-sm text-[#9aa0a6]">
              {isCopy ? 'Вы ещё не отправляли merge-запросов' : 'Входящих merge-запросов нет'}
            </p>
          ) : (
            requests.map((request) => (
              <MergeRequestCard
                key={request.id}
                request={request}
                onAccept={
                  !isCopy && snapshot.mailboxActive
                    ? (id) => void store.acceptMerge(id)
                    : undefined
                }
                onReject={!isCopy ? (id) => void store.rejectMerge(id) : undefined}
              />
            ))
          )}
        </div>

        {!isCopy && (
          <section aria-label="Резервные копии" className="flex flex-col gap-2">
            <p className="text-xs font-semibold uppercase tracking-wider text-[#9aa0a6]">
              Резервные копии
            </p>
            <div className="vetvi-scroll flex max-h-44 flex-col gap-2 overflow-y-auto pr-1">
              {snapshot.backups.length === 0 ? (
                <p className="py-1 text-sm text-[#9aa0a6]">Резервных копий пока нет</p>
              ) : (
                snapshot.backups.map((backup) => (
                  <div
                    key={backup.id}
                    className="flex items-center justify-between gap-3 rounded-lg border border-[#30343b] bg-[#14161a] p-3"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-[#e8eaed]" title={backup.label}>
                        {backup.label}
                      </p>
                      <p className="mt-0.5 text-xs text-[#9aa0a6]">
                        {formatDateTime(backup.createdAt)}
                      </p>
                    </div>
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button
                          variant="secondary"
                          size="sm"
                          className={`${SECONDARY_BTN} shrink-0`}
                        >
                          <History className="size-3.5" aria-hidden />
                          Восстановить
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent className="border-[#30343b] bg-[#1b1d21] text-[#e8eaed]">
                        <AlertDialogHeader>
                          <AlertDialogTitle>Восстановить состояние?</AlertDialogTitle>
                          <AlertDialogDescription className="text-[#9aa0a6]">
                            Текущее состояние проекта будет заменено состоянием из резервной копии
                            «{backup.label}».
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel className={CANCEL_ACTION}>Отмена</AlertDialogCancel>
                          <AlertDialogAction
                            className={DANGER_ACTION}
                            onClick={() => void store.restoreBackup(backup.id)}
                          >
                            Восстановить
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  </div>
                ))
              )}
            </div>
          </section>
        )}
      </DialogContent>
    </Dialog>
  )
}
