'use client'

/**
 * Верхняя панель (тулбар) и нижний статус-бар — порт #topbar/#status из прототипа,
 * плюс коллаборативный блок (поделиться, копия, merge) из онлайн-версии.
 */

import { useEffect, useRef, useState } from 'react'
import {
  Loader2,
  Undo2,
  Redo2,
  Users,
  Inbox,
  Share2,
  Link2,
  CopyPlus,
  CornerUpLeft,
  LogOut,
  ChevronDown,
} from 'lucide-react'
import type { VetviSnapshot, VetviViewport, BendMode } from '@/lib/vetvi/types'
import type { VetviStore } from '@/lib/vetvi/store'
import { StatusPill } from './shared'
import { Icon } from './Icons'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
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
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

export function Header({
  store,
  snap,
  onOpenMerge,
  onOpenShare,
  minimapOn,
  onToggleMinimap,
}: {
  store: VetviStore
  snap: VetviSnapshot
  onOpenMerge: () => void
  onOpenShare: () => void
  minimapOn: boolean
  onToggleMinimap: () => void
}) {
  const [vp, setVp] = useState<VetviViewport>(store.getVp())
  const [saveMenuOpen, setSaveMenuOpen] = useState(false)
  const saveWrapRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => store.onVp(() => setVp({ ...store.getVp() })), [store])

  useEffect(() => {
    if (!saveMenuOpen) return
    const close = (e: PointerEvent) => {
      if (saveWrapRef.current && !saveWrapRef.current.contains(e.target as Node)) {
        setSaveMenuOpen(false)
      }
    }
    window.addEventListener('pointerdown', close, true)
    return () => window.removeEventListener('pointerdown', close, true)
  }, [saveMenuOpen])

  const isCopy = snap.mode === 'copy'
  const pendingIncoming = snap.incoming.filter((r) => String(r.status) === 'pending' || String(r.status) === 'sent').length
  const canUndo = store.canUndo()
  const canRedo = store.canRedo()

  const handleSaveJson = () => {
    const json = store.exportJson()
    if (!json) return
    store.downloadFile(`${snap.meta?.name || 'проект'}.json`, json, 'application/json')
  }

  const handleExportTxt = () => {
    const txt = store.exportTxt()
    if (!txt) return
    store.downloadFile(`${snap.meta?.name || 'проект'}.txt`, txt, 'text/plain;charset=utf-8')
  }

  const handleFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return
    const text = await file.text()
    await store.importJson(text)
    event.target.value = ''
  }

  const setBend = (m: BendMode) => store.setBendMode(m)

  return (
    <header id="topbar">
      <div className="brand">
        <svg viewBox="0 0 24 24" fill="none" aria-hidden>
          <path
            d="M7.5 12h3c3.2 0 2.4-6.5 6-6.5M10.5 12c3.2 0 2.4 6.5 6 6.5"
            stroke="#4d535e"
            strokeWidth="1.6"
            strokeLinecap="round"
          />
          <circle cx="5.5" cy="12" r="2.6" fill="#e2a54e" />
          <circle cx="18.5" cy="5.5" r="2.1" fill="#9cb878" />
          <circle cx="18.5" cy="18.5" r="2.1" fill="#cf6d4f" />
        </svg>
        <div>
          <div className="lg">ВЕТВИ</div>
          <div className="sub">конструктор нарратива</div>
        </div>
      </div>

      <input
        id="projName"
        spellCheck={false}
        title="Название проекта"
        defaultValue={snap.meta?.name ?? ''}
        key={snap.meta?.projectId ?? 'proj'}
        maxLength={120}
        onChange={(e) => store.setProjectName(e.target.value)}
      />

      <div className="vsep" />

      <AlertDialog>
        <AlertDialogTrigger asChild>
          <button className="btn" title="Новый проект">
            + Новый
          </button>
        </AlertDialogTrigger>
        <AlertDialogContent className="vetvi-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>Создать новый проект?</AlertDialogTitle>
            <AlertDialogDescription>
              Текущий проект сохранён локально и останется в списке. Продолжить?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Отмена</AlertDialogCancel>
            <AlertDialogAction onClick={() => void store.newProject()}>Создать</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <button className="btn" title="Открыть (JSON)" onClick={() => fileInputRef.current?.click()}>
        Открыть
      </button>

      <div className="save-wrap" ref={saveWrapRef}>
        <button className="btn primary" title="Сохранить (JSON)" onClick={handleSaveJson}>
          Сохранить
        </button>
        <button
          className="btn primary caret"
          title="Варианты сохранения"
          onClick={() => setSaveMenuOpen((v) => !v)}
        >
          <ChevronDown size={14} strokeWidth={2.2} />
        </button>
        {saveMenuOpen && (
          <div className="save-menu show">
            <div
              className="sm-i"
              role="menuitem"
              onClick={() => {
                setSaveMenuOpen(false)
                handleSaveJson()
              }}
            >
              <Icon name="note" size={15} />
              Сохранить (JSON)
              <kbd>Ctrl+S</kbd>
            </div>
            <div
              className="sm-i"
              role="menuitem"
              onClick={() => {
                setSaveMenuOpen(false)
                handleSaveJson()
              }}
            >
              <Icon name="note" size={15} />
              Сохранить как… (JSON)
              <kbd>Ctrl+Shift+S</kbd>
            </div>
            <div
              className="sm-i"
              role="menuitem"
              onClick={() => {
                setSaveMenuOpen(false)
                handleExportTxt()
              }}
            >
              <Icon name="note" size={15} />
              Текстовый файл (.txt)
            </div>
          </div>
        )}
      </div>

      <div className="vsep" />

      <button
        className={'btn ibtn' + (canUndo ? '' : ' disabled')}
        title="Отменить (Ctrl+Z)"
        onClick={() => store.undo()}
      >
        <Undo2 size={16} strokeWidth={1.7} />
      </button>
      <button
        className={'btn ibtn' + (canRedo ? '' : ' disabled')}
        title="Повторить (Ctrl+Y)"
        onClick={() => store.redo()}
      >
        <Redo2 size={16} strokeWidth={1.7} />
      </button>

      <div className="vsep" />

      <button className="btn ibtn" title="Отдалить (−)" onClick={() => store.zoomCenter(1 / 1.2)}>
        {/* зум от текущего центра холста — точка не важна, возьмём центр окна */}
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
          <path d="M5 12h14" />
        </svg>
      </button>
      <span id="zPct">{Math.round(vp.z * 100)}%</span>
      <button className="btn ibtn" title="Приблизить (+)" onClick={() => store.zoomCenter(1.2)}>
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
          <path d="M12 5v14M5 12h14" />
        </svg>
      </button>
      <button className="btn ibtn" title="Вписать всё (0)" onClick={() => store.geom?.fitView(true)}>
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" />
        </svg>
      </button>

      <div className="vsep" />

      <button
        className={'btn ibtn' + (snap.gridOn ? ' on' : '')}
        title="Сетка"
        onClick={() => store.setGrid(!snap.gridOn)}
      >
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round">
          <path d="M4 4h.01M12 4h.01M20 4h.01M4 12h.01M12 12h.01M20 12h.01M4 20h.01M12 20h.01M20 20h.01" />
        </svg>
      </button>
      <button
        className={'btn ibtn' + (snap.snapOn ? ' on' : '')}
        title="Привязка к сетке"
        onClick={() => store.setSnap(!snap.snapOn)}
      >
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
          <path d="M5 3v5a7 7 0 0 0 14 0V3" />
          <path d="M5 3h3v5H5zM16 3h3v5h-3z" />
        </svg>
      </button>

      <div className="vsep" style={{ margin: '0 8px' }} />

      <button
        className={'btn ibtn' + (snap.bendMode === 'smooth' ? ' on' : '')}
        title="Изгиб всех стрелок: плавный"
        onClick={() => setBend('smooth')}
      >
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round">
          <path d="M4 18c7 0 3-12 10-12h6" />
        </svg>
      </button>
      <button
        className={'btn ibtn' + (snap.bendMode === 'ortho90' ? ' on' : '')}
        title="Изгиб всех стрелок: прямые углы (90°)"
        onClick={() => setBend('ortho90')}
      >
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 18h9a3 3 0 0 0 3-3V6h4" />
        </svg>
      </button>
      <button
        className={'btn ibtn' + (snap.bendMode === 'ortho45' ? ' on' : '')}
        title="Изгиб всех стрелок: углы 45°"
        onClick={() => setBend('ortho45')}
      >
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 18h6l8-8h2" />
        </svg>
      </button>

      <div className="vsep" style={{ margin: '0 8px' }} />

      <button
        className={'btn ibtn' + (minimapOn ? ' on' : '')}
        title="Мини-карта"
        onClick={onToggleMinimap}
      >
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <rect x="7" y="8" width="7" height="6" rx="1" fill="currentColor" fillOpacity=".3" />
        </svg>
      </button>

      <div className="spacer" />

      {/* ── Коллаборативный блок ── */}
      {!isCopy && (
        <>
          <button className="btn" onClick={() => void store.makeCopy()} title="Сделать локальную копию">
            <CopyPlus size={14} strokeWidth={1.7} /> Копия
          </button>
          <button
            className="btn"
            onClick={() => void store.share().then(() => onOpenShare())}
            title="Открыть комнату для соавторов"
          >
            <Share2 size={14} strokeWidth={1.7} /> Поделиться
          </button>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                className="btn ibtn"
                onClick={() => void store.copyShareLink()}
                disabled={!snap.roomActive}
                title="Скопировать ссылку"
              >
                <Link2 size={15} strokeWidth={1.7} />
              </button>
            </TooltipTrigger>
            <TooltipContent>Скопировать ссылку-приглашение</TooltipContent>
          </Tooltip>
        </>
      )}
      {isCopy && (
        <>
          <button className="btn" onClick={() => void store.exitCopy()} title="Вернуться к оригиналу">
            <CornerUpLeft size={14} strokeWidth={1.7} /> К оригиналу
          </button>
        </>
      )}
      <button className="btn" onClick={onOpenMerge} title="Merge-запросы и копии">
        <Inbox size={14} strokeWidth={1.7} /> Merge
        {pendingIncoming > 0 && <span className="merge-badge">{pendingIncoming > 9 ? '9+' : pendingIncoming}</span>}
      </button>

      <Tooltip>
        <TooltipTrigger asChild>
          <div className="peers-pill" aria-label={`Участников: ${snap.peersCount}`}>
            <Users size={13} strokeWidth={1.7} />
            <span>{snap.peersCount}</span>
          </div>
        </TooltipTrigger>
        <TooltipContent>
          <div className="flex flex-col gap-1 p-1">
            {snap.peers.length === 0 && <span className="text-xs text-muted-foreground">Только вы</span>}
            {snap.peers.map((p) => (
              <span key={p.clientId} className="flex items-center gap-2 text-xs">
                <span className="inline-block size-2 rounded-full" style={{ background: p.color }} />
                {p.name}
                {p.isSelf ? ' (вы)' : ''}
              </span>
            ))}
          </div>
        </TooltipContent>
      </Tooltip>

      {!isCopy && snap.roomActive && (
        <button className="btn ibtn" title="Отключить комнату" onClick={() => store.leaveRoom()}>
          <LogOut size={14} strokeWidth={1.7} />
        </button>
      )}

      <Popover>
        <PopoverTrigger asChild>
          <button
            className="user-pill"
            title="Ваше имя (видно соавторам)"
            style={{ borderColor: snap.userColor }}
          >
            <span className="inline-block size-2.5 rounded-full" style={{ background: snap.userColor }} />
            {snap.userName}
          </button>
        </PopoverTrigger>
        <PopoverContent align="end" className="vetvi-dialog w-64">
          <label className="i-lab">Ваше имя</label>
          <input
            className="inp"
            defaultValue={snap.userName}
            maxLength={32}
            key={snap.userName}
            onBlur={(e) => {
              if (e.target.value.trim()) store.setUserName(e.target.value)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
            }}
          />
        </PopoverContent>
      </Popover>

      <button className="btn ibtn" title="Горячие клавиши" onClick={() => store.setHelpModal(true)}>
        ?
      </button>

      <input
        ref={fileInputRef}
        type="file"
        accept=".json,application/json"
        hidden
        tabIndex={-1}
        aria-hidden
        onChange={(event) => void handleFileChange(event)}
      />
    </header>
  )
}

export function Statusbar({ snap }: { snap: VetviSnapshot }) {
  const flashRef = useRef<HTMLSpanElement>(null)
  const prevFlash = useRef(snap.autosaveFlash)

  useEffect(() => {
    if (snap.autosaveFlash !== prevFlash.current && flashRef.current) {
      const el = flashRef.current
      el.classList.remove('flash')
      void el.offsetWidth
      el.classList.add('flash')
    }
    prevFlash.current = snap.autosaveFlash
  }, [snap.autosaveFlash])

  return (
    <footer id="status">
      <div className="st-left">
        <span id="stFile">{snap.mode === 'copy' ? `${snap.meta?.name} (копия)` : snap.meta?.name || '—'}</span>
        <span id="stDirty" className={snap.saveState === 'saving' ? 'show' : ''} />
      </div>
      <div className="spacer" />
      <div className="st-right">
        {snap.mode === 'copy' ? (
          <span className="st-mode">копия · изменения не попадут в оригинал автоматически</span>
        ) : (
          <StatusPill connection={snap.connection} />
        )}
        {snap.saveState === 'saving' ? (
          <span className="st-saving">
            <Loader2 size={11} className="animate-spin" /> сохранение…
          </span>
        ) : null}
        <span id="stCounts">
          узлов: {snap.nodes.length} · связей: {snap.edges.length} · групп: {snap.groups.length}
        </span>
        <span id="stAuto" ref={flashRef}>
          ✓ автосохранение
        </span>
      </div>
    </footer>
  )
}
