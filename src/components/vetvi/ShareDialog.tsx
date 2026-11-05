'use client'

/**
 * ShareDialog — управление realtime-комнатой: ссылка-приглашение, статус, отключение.
 */

import type { VetviStore } from '@/lib/vetvi/store'
import type { VetviSnapshot } from '@/lib/vetvi/types'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Copy, Unlink, Users } from 'lucide-react'
import { StatusPill } from './shared'

export interface ShareDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  snapshot: VetviSnapshot
  store: VetviStore
}

export function ShareDialog({ open, onOpenChange, snapshot, store }: ShareDialogProps) {
  const handleDisconnect = () => {
    store.disconnectRoom()
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="border-[#30343b] bg-[#1b1d21] text-[#e8eaed] sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Поделиться проектом</DialogTitle>
          <DialogDescription className="text-[#9aa0a6]">
            Проект доступен для совместного редактирования, пока открыта комната
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="flex gap-2">
            <Input
              readOnly
              value={snapshot.shareUrl ?? ''}
              placeholder={snapshot.shareUrl ? undefined : 'Комната не открыта'}
              aria-label="Ссылка-приглашение"
              className="vetvi-scroll h-9 flex-1 overflow-hidden border-[#30343b] bg-[#14161a] font-mono text-xs text-[#9aa0a6]"
            />
            <Button
              variant="secondary"
              size="icon"
              className="size-9 shrink-0 border border-[#30343b] bg-[#23262b] text-[#e8eaed] shadow-none hover:bg-[#2b2f36] hover:text-white"
              onClick={() => void store.copyShareLink()}
              aria-label="Скопировать ссылку-приглашение"
            >
              <Copy className="size-4" aria-hidden />
            </Button>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2">
            <StatusPill connection={snapshot.connection} />
            <span
              className="inline-flex items-center gap-1.5 rounded-full border border-[#30343b] bg-[#1b1d21] px-2.5 py-0.5 text-xs font-medium text-[#9aa0a6]"
              aria-label={`Участников: ${snapshot.peersCount}`}
            >
              <Users className="size-3.5" aria-hidden />
              {snapshot.peersCount}
            </span>
          </div>

          <Button
            variant="ghost"
            className="justify-start text-[#ff5a5f] hover:bg-[#ff5a5f]/10 hover:text-[#ff5a5f]"
            onClick={handleDisconnect}
          >
            <Unlink className="size-4" aria-hidden />
            Отключить комнату
          </Button>

          <p className="text-xs leading-relaxed text-[#9aa0a6]">
            Участники, открывшие ссылку, смогут редактировать проект вместе с вами. Данные
            передаются через сервер-релей.
          </p>
        </div>
      </DialogContent>
    </Dialog>
  )
}
