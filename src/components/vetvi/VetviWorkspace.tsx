'use client'

/**
 * VetviWorkspace — корневой клиентский компонент «Ветвей».
 * Компоновка: тулбар / левая панель / холст / инспектор / статус-бар
 * + модалки, контекстное меню, тосты, глобальные горячие клавиши.
 */

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { Loader2 } from 'lucide-react'

import { VetviStore } from '@/lib/vetvi/store'
import type { VetviSnapshot } from '@/lib/vetvi/types'

import { Header, Statusbar } from './Header'
import { LeftPanel } from './LeftPanel'
import { Canvas } from './Canvas'
import { Inspector } from './Inspector'
import { Minimap } from './Minimap'
import { ContextMenu } from './ContextMenu'
import { Toasts } from './Toasts'
import {
  ModalWrap,
  DlgEditorModal,
  NoteEditorModal,
  NoteViewModal,
  TypeEditorModal,
  HelpModal,
  DstWin,
  GroupModal,
  type ModalCfg,
} from './Modals'
import { ShareDialog } from './ShareDialog'
import { MergeDialog } from './MergeDialog'

let storeInstance: VetviStore | null = null

function createVetviStore(): VetviStore {
  const store = new VetviStore()
  if (typeof window !== 'undefined') {
    ;(window as unknown as { __vetviStore?: VetviStore }).__vetviStore = store
  }
  return store
}

export function getVetviStore(): VetviStore {
  if (!storeInstance) storeInstance = createVetviStore()
  return storeInstance
}

export default function VetviWorkspace() {
  const store = useMemo(() => getVetviStore(), [])
  const snapshot: VetviSnapshot = useSyncExternalStoreCompat(store)
  const [shareOpen, setShareOpen] = useState(false)
  const [mergeOpen, setMergeOpen] = useState(false)
  const [minimapOn, setMinimapOn] = useState(true)
  const [guardModal, setGuardModal] = useState<ModalCfg | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  // Bootstrap + первичное наполнение списков копий/бекапов/исходящих.
  useEffect(() => {
    let cancelled = false
    void store.bootstrap().then(() => {
      if (cancelled) return
      void store.refreshCopies()
      void store.refreshBackups()
      void store.refreshOutbox()
    })
    return () => {
      cancelled = true
    }
  }, [store])

  /* ── Глобальная клавиатура (порт keydown из прототипа) ── */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping()) {
        if (e.key === 'Escape') (document.activeElement as HTMLElement)?.blur?.()
        return
      }
      const mod = e.ctrlKey || e.metaKey
      const code = e.code

      if (e.key === 'F2' && store.getSnapshot().sel.length === 1) {
        e.preventDefault()
        store.canvasApi?.startInlineEdit(store.getSnapshot().sel[0])
        return
      }
      if (mod && code === 'KeyZ' && !e.shiftKey) {
        e.preventDefault()
        store.undo()
        return
      }
      if (mod && (code === 'KeyY' || (code === 'KeyZ' && e.shiftKey))) {
        e.preventDefault()
        store.redo()
        return
      }
      if (mod && code === 'KeyS') {
        e.preventDefault()
        const json = store.exportJson()
        const name = store.getSnapshot().meta?.name || 'проект'
        if (json) store.downloadFile(`${name}.json`, json, 'application/json')
        return
      }
      if (mod && code === 'KeyO') {
        e.preventDefault()
        fileInputRef.current?.click()
        return
      }
      if (mod && e.altKey && code === 'KeyN') {
        e.preventDefault()
        void store.newProject()
        return
      }
      if (mod && code === 'KeyD') {
        e.preventDefault()
        const r = store.duplicateSel()
        if (r) store.canvasApi?.startCarry(r.ids)
        return
      }
      if (mod && e.shiftKey && code === 'KeyA') {
        e.preventDefault()
        store.alignSelH()
        return
      }
      if (mod && !e.shiftKey && code === 'KeyG') {
        e.preventDefault()
        const s = store.getSnapshot()
        if (s.sel.length + s.selGroups.length >= 2) store.setGroupModal(true)
        else store.showToast?.('Выделите минимум два объекта (или нарисуйте группу: Ctrl+ЛКМ)', 'warn')
        return
      }
      if (mod && e.shiftKey && code === 'KeyG') {
        e.preventDefault()
        const s = store.getSnapshot()
        let gidU = s.selGroup
        if (!gidU && s.selGroups.length) gidU = s.selGroups[0]
        if (!gidU && s.sel.length === 1) {
          const nn = store.nodeById(s.sel[0])
          if (nn) gidU = nn.gid
        }
        if (gidU) store.ungroup(gidU)
        else store.showToast?.('Нет группы для роспуска', 'warn')
        return
      }
      if (mod && code === 'KeyA') {
        e.preventDefault()
        store.selectAllVisible()
        return
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault()
        store.removeSelected()
        return
      }
      if (e.key === 'Escape') {
        if (store.canvasApi?.hasCarry()) {
          store.canvasApi?.cancelCarry()
          return
        }
        if (store.canvasApi?.cancelGestures()) return
        if (store.getSnapshot().dstWin) {
          store.closeDstWin()
          return
        }
        if (store.getSnapshot().dlgEditorNodeId) {
          store.openDlgEditor(null)
          return
        }
        store.closeCtxMenu()
        store.clearSel()
        return
      }
      if (code === 'KeyF') {
        const s = store.getSnapshot()
        if (s.sel.length === 1) store.geom?.centerOn(s.sel[0])
        return
      }
      if (e.key === '0') {
        store.geom?.fitView(true)
        return
      }
      if (e.key === '=' || e.key === '+') {
        store.zoomCenter(1.15)
        return
      }
      if (e.key === '-') {
        store.zoomCenter(1 / 1.15)
        return
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [store])

  // Экспорт TXT через меню уже в Header; здесь — скрытый input для Ctrl+O / «Открыть».
  const handleFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return
    const text = await file.text()
    await store.importJson(text)
    event.target.value = ''
  }

  const isCopy = snapshot.mode === 'copy'
  const pendingIncoming = snapshot.incoming.filter((r) => String(r.status) === 'pending' || String(r.status) === 'sent').length

  // Экран загрузки до готовности стора.
  if (!snapshot.ready) {
    return (
      <div
        className="flex h-dvh flex-col items-center justify-center gap-3 bg-[#111214] text-[#e8eaed]"
        role="status"
        aria-live="polite"
      >
        <Loader2 className="size-6 animate-spin text-[#7c5cff]" aria-hidden />
        <p className="animate-pulse text-sm text-[#9aa0a6]">Загрузка…</p>
      </div>
    )
  }

  return (
    <div className="vetvi-root" style={{ background: 'var(--bg)', color: 'var(--tx)' }}>
      <Header
        store={store}
        snap={snapshot}
        minimapOn={minimapOn}
        onToggleMinimap={() => setMinimapOn((v) => !v)}
        onOpenShare={() => setShareOpen(true)}
        onOpenMerge={() => setMergeOpen(true)}
      />

      <div id="layout">
        <LeftPanel store={store} snap={snapshot} />
        <section id="stage">
          <Canvas
            store={store}
            snap={snapshot}
            minimap={<Minimap store={store} snap={snapshot} visible={minimapOn} />}
          />
        </section>
        <Inspector store={store} snap={snapshot} />
      </div>

      <Statusbar snap={snapshot} />

      <ContextMenu state={snapshot.ctxMenu} onClose={() => store.closeCtxMenu()} />
      <Toasts items={snapshot.toasts} />

      <ModalWrap
        cfg={guardModal}
        onClose={() => setGuardModal(null)}
      />
      <GroupModal store={store} snap={snapshot} />
      <DlgEditorModal store={store} snap={snapshot} />
      <NoteEditorModal store={store} snap={snapshot} />
      <NoteViewModal store={store} snap={snapshot} />
      <TypeEditorModal store={store} snap={snapshot} />
      <HelpModal store={store} />
      <DstWin store={store} snap={snapshot} />

      <ShareDialog open={shareOpen} onOpenChange={setShareOpen} snapshot={snapshot} store={store} />
      <MergeDialog open={mergeOpen} onOpenChange={setMergeOpen} snapshot={snapshot} store={store} />

      <input
        ref={fileInputRef}
        type="file"
        accept=".json,application/json"
        hidden
        tabIndex={-1}
        aria-hidden
        onChange={(event) => void handleFileChange(event)}
      />
      <span className="hidden">{pendingIncoming}</span>
    </div>
  )
}

/* useSyncExternalStore с SSR-фолбэком (третий аргумент обязателен). */
function useSyncExternalStoreCompat(store: VetviStore): VetviSnapshot {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
}

function isTyping(): boolean {
  const a = document.activeElement
  return !!a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || (a as HTMLElement).isContentEditable === true)
}
