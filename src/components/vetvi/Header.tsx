'use client'

/**
 * Header — бренд, тулбар действий и статус-пилюли (режим, подключение, участники, имя).
 */

import { useState } from 'react'
import type { VetviStore } from '@/lib/vetvi/store'
import type { VetviSnapshot } from '@/lib/vetvi/types'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
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
  Copy,
  Download,
  FilePlus2,
  FileText,
  FolderOpen,
  GitPullRequestArrow,
  Inbox,
  Link2,
  Share2,
  Undo2,
  Users,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { MutedPill, StatusPill, isPendingMerge } from './shared'

const TOOLBAR_BTN =
  'border border-[#30343b] bg-[#23262b] text-[#e8eaed] shadow-none hover:bg-[#2b2f36] hover:text-white'
const ACCENT_BTN = 'bg-[#7c5cff] text-white shadow-none hover:bg-[#6d4ef2]'

export interface HeaderProps {
  store: VetviStore
  snapshot: VetviSnapshot
  onNewProject: () => void
  onOpenJson: () => void
  onSaveJson: () => void
  onExportTxt: () => void
  onShare: () => void
  onCopyLink: () => void
  onMakeCopy: () => void
  onSendMerge: () => void
  onOpenMerge: () => void
  onExitCopy: () => void
}

export function Header({
  store,
  snapshot,
  onNewProject,
  onOpenJson,
  onSaveJson,
  onExportTxt,
  onShare,
  onCopyLink,
  onMakeCopy,
  onSendMerge,
  onOpenMerge,
  onExitCopy,
}: HeaderProps) {
  const isCopy = snapshot.mode === 'copy'
  const pendingIncoming = snapshot.incoming.filter((r) => isPendingMerge(r.status)).length

  const [nameOpen, setNameOpen] = useState(false)
  const [nameDraft, setNameDraft] = useState(snapshot.userName)

  const submitName = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    store.setUserName(nameDraft)
    setNameOpen(false)
  }

  const originalOnlyTitle = 'Доступно только для оригинала'

  return (
    <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-[#30343b] bg-gradient-to-r from-[#1d2025] to-[#15171a] px-3 py-2">
      {/* Бренд */}
      <div className="flex min-w-0 items-baseline gap-2">
        <span className="text-sm font-extrabold tracking-widest text-[#e8eaed]">ВЕТВИ</span>
        <span className="hidden truncate text-xs text-[#9aa0a6] sm:inline">
          коллаборативный конструктор
        </span>
      </div>

      {/* Тулбар */}
      <div className="flex flex-wrap items-center gap-2" role="toolbar" aria-label="Действия с проектом">
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button variant="secondary" size="sm" className={TOOLBAR_BTN}>
              <FilePlus2 className="size-3.5" aria-hidden />
              Новый
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent className="border-[#30343b] bg-[#1b1d21] text-[#e8eaed]">
            <AlertDialogHeader>
              <AlertDialogTitle>Создать новый проект?</AlertDialogTitle>
              <AlertDialogDescription className="text-[#9aa0a6]">
                Текущий проект будет заменён новым. Продолжить?
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel className="border-[#30343b] bg-[#23262b] text-[#e8eaed] hover:bg-[#2b2f36] hover:text-white">
                Отмена
              </AlertDialogCancel>
              <AlertDialogAction className={ACCENT_BTN} onClick={onNewProject}>
                Создать
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>

        <Button variant="secondary" size="sm" className={TOOLBAR_BTN} onClick={onOpenJson}>
          <FolderOpen className="size-3.5" aria-hidden />
          Открыть JSON
        </Button>

        <Button variant="secondary" size="sm" className={TOOLBAR_BTN} onClick={onSaveJson}>
          <Download className="size-3.5" aria-hidden />
          Сохранить JSON
        </Button>

        <Button variant="secondary" size="sm" className={TOOLBAR_BTN} onClick={onExportTxt}>
          <FileText className="size-3.5" aria-hidden />
          Текст
        </Button>

        <Button
          size="sm"
          className={ACCENT_BTN}
          onClick={onShare}
          disabled={isCopy}
          title={isCopy ? originalOnlyTitle : undefined}
        >
          <Share2 className="size-3.5" aria-hidden />
          Поделиться
        </Button>

        <Button
          variant="secondary"
          size="sm"
          className={TOOLBAR_BTN}
          onClick={onCopyLink}
          disabled={isCopy}
          title={isCopy ? originalOnlyTitle : undefined}
        >
          <Link2 className="size-3.5" aria-hidden />
          Ссылка
        </Button>

        {!isCopy && (
          <>
            <Button
              variant="secondary"
              size="sm"
              className={TOOLBAR_BTN}
              onClick={onMakeCopy}
              title="Сохранить локальную копию проекта"
            >
              <Copy className="size-3.5" aria-hidden />
              Сделать копию
            </Button>
            <Button
              variant="secondary"
              size="sm"
              className={TOOLBAR_BTN}
              onClick={onSendMerge}
              disabled
              title="Отправить merge можно только из копии проекта — сделайте копию и откройте её"
            >
              <GitPullRequestArrow className="size-3.5" aria-hidden />
              Отправить merge
            </Button>
          </>
        )}

        {isCopy && (
          <>
            <Button
              variant="secondary"
              size="sm"
              className={TOOLBAR_BTN}
              onClick={onSendMerge}
              title="Отправить изменения из копии владельцу оригинала"
            >
              <GitPullRequestArrow className="size-3.5" aria-hidden />
              Отправить merge
            </Button>
            <Button variant="secondary" size="sm" className={TOOLBAR_BTN} onClick={onExitCopy}>
              <Undo2 className="size-3.5" aria-hidden />
              К оригиналу
            </Button>
          </>
        )}

        <Button
          variant="secondary"
          size="sm"
          className={cn(TOOLBAR_BTN, 'relative')}
          onClick={onOpenMerge}
          aria-label={`Merge-запросы${pendingIncoming ? ` (${pendingIncoming} новых)` : ''}`}
        >
          <Inbox className="size-3.5" aria-hidden />
          Merge-запросы
          {pendingIncoming > 0 && (
            <span className="absolute -right-1.5 -top-1.5 flex size-4 items-center justify-center rounded-full bg-[#f5a623] text-[10px] font-bold leading-none text-[#111214]">
              {pendingIncoming > 9 ? '9+' : pendingIncoming}
            </span>
          )}
        </Button>
      </div>

      {/* Статус-пилюли */}
      <div className="ml-auto flex flex-wrap items-center gap-2">
        {isCopy ? (
          <span className="inline-flex items-center whitespace-nowrap rounded-full border border-[#f5a623]/40 bg-[#f5a623]/10 px-2.5 py-0.5 text-xs font-medium text-[#f5a623]">
            копия
          </span>
        ) : (
          <MutedPill>проект</MutedPill>
        )}

        {snapshot.mode === 'project' && !snapshot.roomActive ? (
          <MutedPill>локально</MutedPill>
        ) : (
          <StatusPill connection={snapshot.connection} />
        )}

        {/* Участники */}
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              className="inline-flex cursor-default items-center gap-1.5 whitespace-nowrap rounded-full border border-[#30343b] bg-[#1b1d21] px-2.5 py-0.5 text-xs font-medium text-[#9aa0a6]"
              aria-label={`Участников: ${snapshot.peersCount}`}
            >
              <Users className="size-3.5" aria-hidden />
              {snapshot.peersCount}
            </span>
          </TooltipTrigger>
          <TooltipContent className="border border-[#30343b] bg-[#23262b] text-[#e8eaed]">
            {snapshot.peers.length === 0 ? (
              <p>Нет подключённых участников</p>
            ) : (
              <ul className="flex flex-col gap-1">
                {snapshot.peers.map((peer) => (
                  <li key={peer.clientId} className="flex items-center gap-2">
                    <span
                      className="size-2 shrink-0 rounded-full"
                      style={{ backgroundColor: peer.color }}
                      aria-hidden
                    />
                    <span>
                      {peer.name}
                      {peer.isSelf ? ' (вы)' : ''}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </TooltipContent>
        </Tooltip>

        {/* Имя пользователя */}
        <Popover
          open={nameOpen}
          onOpenChange={(open) => {
            setNameOpen(open)
            if (open) setNameDraft(snapshot.userName)
          }}
        >
          <PopoverTrigger asChild>
            <button
              type="button"
              className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border border-[#30343b] bg-[#1b1d21] px-2.5 py-0.5 text-xs font-medium text-[#e8eaed] transition-colors hover:border-[#7c5cff]/60 hover:text-white"
              aria-label={`Ваше имя: ${snapshot.userName}. Нажмите, чтобы изменить`}
            >
              <span
                className="size-2 shrink-0 rounded-full"
                style={{ backgroundColor: snapshot.userColor }}
                aria-hidden
              />
              {snapshot.userName}
            </button>
          </PopoverTrigger>
          <PopoverContent className="w-64 border-[#30343b] bg-[#1b1d21] p-3 text-[#e8eaed]" align="end">
            <form onSubmit={submitName} className="flex flex-col gap-2">
              <Label htmlFor="vetvi-user-name" className="text-xs text-[#9aa0a6]">
                Ваше имя
              </Label>
              <Input
                id="vetvi-user-name"
                value={nameDraft}
                onChange={(event) => setNameDraft(event.target.value)}
                className="h-8 border-[#30343b] bg-[#14161a] text-sm text-[#e8eaed] placeholder:text-[#5f6570] focus-visible:ring-[#7c5cff]/40"
                placeholder="Как вас видят соавторы"
                maxLength={32}
              />
              <Button type="submit" size="sm" className={cn(ACCENT_BTN, 'h-8')}>
                ОК
              </Button>
            </form>
          </PopoverContent>
        </Popover>
      </div>
    </header>
  )
}
