'use client'

/**
 * VetviWorkspace — корневой клиентский компонент «Ветвей».
 * Держит singleton VetviStore, подписку на снапшот и компоновку панелей.
 */

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { Loader2 } from 'lucide-react'

// Значимый импорт класса: инстанс создаётся ровно один раз ниже (модульный singleton).
import { VetviStore } from '@/lib/vetvi/store'
import type { VetviSnapshot, ToastKind } from '@/lib/vetvi/types'
import { toast as showToast } from '@/hooks/use-toast'

import { Header } from './Header'
import { LeftPanel } from './LeftPanel'
import { Canvas } from './Canvas'
import { Inspector } from './Inspector'
import { ShareDialog } from './ShareDialog'
import { MergeDialog } from './MergeDialog'
import { isPendingMerge } from './shared'

let storeInstance: VetviStore | null = null

/** Мост тостов: store -> use-toast (модульная функция toast не привязана к компоненту). */
function handleStoreToast(message: string, kind?: ToastKind) {
  if (kind === 'error') {
    showToast({ title: message, variant: 'destructive' })
  } else {
    // 'ok' и 'warn' — обычный тост.
    showToast({ title: message })
  }
}

function createVetviStore(): VetviStore {
  const store = new VetviStore()
  store.onToast = handleStoreToast
  if (typeof window !== 'undefined') {
    // Отладочный хук (используется E2E-тестами и консолью разработчика).
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
  // Третий аргумент обязателен для SSR: до bootstrap снапшот детерминирован (ready: false).
  const snapshot: VetviSnapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)

  const [shareOpen, setShareOpen] = useState(false)
  const [mergeOpen, setMergeOpen] = useState(false)
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

  // ----- Колбэки тулбара -----

  const handleShare = async () => {
    if (!snapshot.roomActive) {
      await store.share()
    }
    setShareOpen(true)
  }

  const handleSaveJson = () => {
    const json = store.exportJson()
    if (!json) return
    store.downloadFile(`${snapshot.meta?.name || 'проект'}.json`, json, 'application/json')
  }

  const handleExportTxt = () => {
    const txt = store.exportTxt()
    if (!txt) return
    store.downloadFile(`${snapshot.meta?.name || 'проект'}.txt`, txt, 'text/plain;charset=utf-8')
  }

  const handleFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return
    const text = await file.text()
    await store.importJson(text)
    event.target.value = ''
  }

  const isCopy = snapshot.mode === 'copy'
  const pendingIncoming = snapshot.incoming.filter((r) => isPendingMerge(r.status)).length

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
    <div className="flex h-dvh flex-col overflow-hidden bg-[#111214] text-[#e8eaed]">
      <Header
        store={store}
        snapshot={snapshot}
        onNewProject={() => void store.newProject()}
        onOpenJson={() => fileInputRef.current?.click()}
        onSaveJson={handleSaveJson}
        onExportTxt={handleExportTxt}
        onShare={() => void handleShare()}
        onCopyLink={() => void store.copyShareLink()}
        onMakeCopy={() => void store.makeCopy()}
        onSendMerge={() => void store.sendMerge()}
        onOpenMerge={() => setMergeOpen(true)}
        onExitCopy={() => void store.exitCopy()}
      />

      {/* Скрытый input для импорта JSON */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".json,application/json"
        className="hidden"
        aria-hidden="true"
        tabIndex={-1}
        onChange={(event) => void handleFileChange(event)}
      />

      <main className="flex min-h-0 flex-1 flex-col md:grid md:grid-cols-[220px_minmax(0,1fr)_260px] md:grid-rows-[minmax(0,1fr)] lg:grid-cols-[260px_minmax(0,1fr)_300px]">
        <LeftPanel
          store={store}
          snapshot={snapshot}
          className="max-h-40 shrink-0 md:max-h-none"
          onSendMerge={() => void store.sendMerge()}
        />
        <Canvas
          elements={snapshot.elements}
          selectedId={snapshot.selectedId}
          className="min-h-0 flex-1"
          onSelectElement={(id) => store.selectElement(id)}
          onElementDrag={(id, x, y) => store.updateElement(id, { x, y }, true)}
        />
        <Inspector store={store} snapshot={snapshot} className="max-h-72 shrink-0 md:max-h-none" />
      </main>

      <ShareDialog open={shareOpen} onOpenChange={setShareOpen} snapshot={snapshot} store={store} />
      <MergeDialog open={mergeOpen} onOpenChange={setMergeOpen} snapshot={snapshot} store={store} />
    </div>
  )
}
