'use client'

/**
 * Модальные окна и плавающие панели — порт из прототипа:
 * dlgModal (редактор реплик), noteModal/noteViewModal, редактор своих типов,
 * справка по горячим клавишам, групповая модалка, окно распределения (dstWin).
 */

import { useEffect, useRef, useState } from 'react'
import type { VetviSnapshot, DialogReply, VetviNode } from '@/lib/vetvi/types'
import { PALETTE_COLORS } from '@/lib/vetvi/types'
import type { VetviStore, NOTE_MAX } from '@/lib/vetvi/store'
import { BASE_ICON_KEYS, EXTRA_ICON_KEYS } from '@/lib/vetvi/icons'
import { Icon } from './Icons'
import { sanitizeNoteHtml } from './note-html'

/* ═══════════ Общая модалка (порт showModal) ═══════════ */

export interface ModalCfg {
  title: string
  text?: React.ReactNode
  buttons: { label: string; primary?: boolean; danger?: boolean; fn?: () => void }[]
  wide?: boolean
}

export function ModalWrap({ cfg, onClose }: { cfg: ModalCfg | null; onClose: () => void }) {
  useEffect(() => {
    if (!cfg) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [cfg, onClose])

  if (!cfg) return null
  return (
    <div
      id="modalWrap"
      className="show"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className={'m-card' + (cfg.wide ? ' wide' : '')}>
        <h3>{cfg.title}</h3>
        {cfg.text}
        <div className="m-btns">
          {cfg.buttons.map((b, i) => (
            <button
              key={i}
              className={'btn' + (b.primary ? ' primary' : '') + (b.danger ? ' danger' : '')}
              onClick={() => {
                onClose()
                b.fn?.()
              }}
            >
              {b.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

/* ═══════════ Редактор реплик диалога ═══════════ */

export function DlgEditorModal({ store, snap }: { store: VetviStore; snap: VetviSnapshot }) {
  const nodeId = snap.dlgEditorNodeId
  const node = nodeId ? store.nodeById(nodeId) : null
  const nodeRef = useRef<VetviNode | null>(node)
  useEffect(() => {
    nodeRef.current = node
  }, [node])

  useEffect(() => {
    if (!nodeId) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') store.openDlgEditor(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [nodeId, store])

  if (!nodeId || !node || node.type !== 'dialog' || !node.dialog) return null
  const chars = snap.nodes.filter((c) => c.type === 'char' && node.dialog!.participants.includes(c.id))

  const renderReplies = (replies: DialogReply[], depth: number) => {
    if (depth >= 10) return null
    return replies.map((r) => {
      const isRoot = depth === 0
      return (
        <div key={r.id} className={'dlg-reply-ed' + (isRoot ? ' root' : '')}>
          <div className="dlg-reply-row-ed">
            <select
              value={r.speaker ?? ''}
              onChange={(e) => store.setReplySpeaker(node.id, r.id, e.target.value || null)}
            >
              <option value="">— не выбран —</option>
              {chars.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.title}
                </option>
              ))}
            </select>
            <textarea
              placeholder="Текст реплики…"
              defaultValue={r.text}
              onChange={(e) => store.updateReplyText(node.id, r.id, e.target.value)}
            />
          </div>
          <div className="dlg-reply-acts">
            <button
              className="mini-btn"
              title="Добавить ответ"
              onClick={() => store.addReply(node.id, r.id)}
            >
              <Icon name="plus" size={11} />
            </button>
            <button
              className="mini-btn del"
              title="Удалить реплику"
              onClick={() => store.deleteReply(node.id, r.id)}
            >
              <Icon name="x" size={11} />
            </button>
          </div>
          {r.children && r.children.length > 0 && (
            <div className="dlg-children-ed">{renderReplies(r.children, depth + 1)}</div>
          )}
        </div>
      )
    })
  }

  return (
    <div
      id="dlgModal"
      className="dlg-modal show"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) store.openDlgEditor(null)
      }}
    >
      <div className="dlg-modal-card">
        <div className="dlg-modal-head">
          <span className="dlg-modal-title">Реплики: {node.title}</span>
          <button className="dlg-modal-close" title="Закрыть" onClick={() => store.openDlgEditor(null)}>
            ×
          </button>
        </div>
        <div className="dlg-modal-body">
          {renderReplies(node.dialog.replies, 0)}
          <div style={{ marginTop: 12 }}>
            <button className="dlg-add-root-btn" onClick={() => store.addReply(node.id, null)}>
              <Icon name="plus" size={11} /> Добавить корневую реплику
            </button>
          </div>
        </div>
        <div className="dlg-modal-foot">
          <button className="btn" onClick={() => store.openDlgEditor(null)}>
            Готово
          </button>
        </div>
      </div>
    </div>
  )
}

/* ═══════════ Редактор заметок ═══════════ */

export function NoteEditorModal({ store, snap }: { store: VetviStore; snap: VetviSnapshot }) {
  const state = snap.noteEditor
  const node = state ? store.nodeById(state.nodeId) : null
  const note = node && state ? node.notes?.[state.idx] : null
  const isNew = state?.idx === -1
  const titleRef = useRef<HTMLInputElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const initedRef = useRef<string>('')
  const initKey = state ? state.nodeId + ':' + state.idx : ''

  useEffect(() => {
    if (!state || !node) return
    if (initedRef.current === initKey) return
    initedRef.current = initKey
    if (titleRef.current) titleRef.current.value = state.idx >= 0 ? note?.title ?? '' : ''
    if (bodyRef.current) bodyRef.current.innerHTML = sanitizeNoteHtml(state.idx >= 0 ? note?.html ?? '' : '')
    const t = setTimeout(() => bodyRef.current?.focus(), 40)
    return () => clearTimeout(t)
  }, [state, node, initKey, note])

  useEffect(() => {
    if (!state) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') store.closeNoteEditor()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [state, store])

  if (!state || !node) return null

  const fmt = (cmd: string) => {
    try {
      document.execCommand(cmd)
    } catch {
      // ignore
    }
  }

  const insertCheck = () => {
    const body = bodyRef.current
    if (!body) return
    const row = document.createElement('div')
    row.className = 'nc-row'
    row.setAttribute('data-checked', '0')
    row.innerHTML =
      '<span class="nc-box" contenteditable="false"><svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 4.5 4.5L19 7"/></svg></span><span class="nc-txt">Задача</span>'
    body.appendChild(row)
    body.appendChild(document.createElement('br'))
  }

  const save = () => {
    const title = (titleRef.current?.value ?? '').trim() || 'Заметка'
    const html = sanitizeNoteHtml(bodyRef.current?.innerHTML ?? '')
    store.saveNote(node.id, state.idx, { title, html, hidden: false })
    store.closeNoteEditor()
  }

  return (
    <div
      id="noteModal"
      className="note-modal show"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) store.closeNoteEditor()
      }}
    >
      <div className="note-modal-card">
        <div className="note-modal-head">
          <span className="note-modal-title">{isNew ? 'Новая заметка' : 'Редактирование заметки'}</span>
          <button className="note-modal-close" title="Закрыть" onClick={() => store.closeNoteEditor()}>
            ×
          </button>
        </div>
        <div className="note-modal-body">
          <input ref={titleRef} className="inp" placeholder="Заголовок заметки…" maxLength={80} />
          <div className="note-toolbar">
            <button className="note-tb b" data-fmt="bold" title="Жирный" onPointerDown={(e) => e.preventDefault()} onClick={() => fmt('bold')}>
              Ж
            </button>
            <button className="note-tb i" title="Курсив" onPointerDown={(e) => e.preventDefault()} onClick={() => fmt('italic')}>
              К
            </button>
            <button className="note-tb s" title="Зачёркнутый" onPointerDown={(e) => e.preventDefault()} onClick={() => fmt('strikeThrough')}>
              S
            </button>
            <button className="note-tb" title="Нумерованный список" onPointerDown={(e) => e.preventDefault()} onClick={() => fmt('insertOrderedList')}>
              1.
            </button>
            <button className="note-tb" title="Маркированный список" onPointerDown={(e) => e.preventDefault()} onClick={() => fmt('insertUnorderedList')}>
              •
            </button>
            <button className="note-tb" title="Строка с чекбоксом" onPointerDown={(e) => e.preventDefault()} onClick={insertCheck}>
              ☑
            </button>
          </div>
          <div
            ref={bodyRef}
            className="note-editor"
            contentEditable
            suppressContentEditableWarning
            onClick={(e) => {
              const bx = (e.target as HTMLElement).closest?.('.nc-box')
              if (!bx) return
              e.preventDefault()
              const r = bx.closest('.nc-row')
              if (!r) return
              const on = r.getAttribute('data-checked') === '1'
              r.setAttribute('data-checked', on ? '0' : '1')
              r.classList.toggle('struck', !on)
            }}
          />
        </div>
        <div className="dlg-modal-foot">
          <button className="btn" onClick={() => store.closeNoteEditor()}>
            Отмена
          </button>
          <button className="btn primary" onClick={save}>
            Сохранить
          </button>
        </div>
      </div>
    </div>
  )
}

export function NoteViewModal({ store, snap }: { store: VetviStore; snap: VetviSnapshot }) {
  const state = snap.noteView
  const node = state && state.idx >= 0 ? store.nodeById(state.nodeId) : null
  const note = node && state ? node.notes?.[state.idx] : null
  const bodyRef = useRef<HTMLDivElement>(null)
  const initedRef = useRef<string>('')
  const initKey = state && note ? state.nodeId + ':' + state.idx + ':' + note.html.length : ''

  useEffect(() => {
    if (!state || !note) return
    if (initedRef.current === initKey) return
    initedRef.current = initKey
    if (bodyRef.current) {
      bodyRef.current.innerHTML = sanitizeNoteHtml(note.html || '<div class="note-empty">Пусто</div>')
      bodyRef.current.querySelectorAll('.nc-row').forEach((row) => {
        if (row.getAttribute('data-checked') === '1') row.classList.add('struck')
      })
    }
  }, [state, note, initKey])

  if (!state || !node || !note) return null

  const close = () => store.closeNoteView()

  return (
    <div
      id="noteViewModal"
      className="note-modal show"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) close()
      }}
    >
      <div className="note-modal-card">
        <div className="note-modal-head">
          <span className="note-modal-title">{note.title || 'Заметка'}</span>
          <button className="note-modal-close" title="Закрыть" onClick={close}>
            ×
          </button>
        </div>
        <div className="note-modal-body">
          <div
            ref={bodyRef}
            className="note-view-body"
            onClick={(e) => {
              const bx = (e.target as HTMLElement).closest?.('.nc-box')
              if (!bx) return
              e.stopPropagation()
              const r = bx.closest('.nc-row')
              if (!r) return
              const on = r.getAttribute('data-checked') === '1'
              r.setAttribute('data-checked', on ? '0' : '1')
              r.classList.toggle('struck', !on)
              store.setNoteCheck(node.id, state.idx, sanitizeNoteHtml(bodyRef.current?.innerHTML ?? ''))
            }}
          />
        </div>
      </div>
    </div>
  )
}

/* ═══════════ Редактор своего типа ═══════════ */

export function TypeEditorModal({ store, snap }: { store: VetviStore; snap: VetviSnapshot }) {
  const state = snap.ctypeEditor
  const [draft, setDraft] = useState<{ id: string | null; name: string; color: string; icon: string }>({
    id: null,
    name: '',
    color: '#e2a54e',
    icon: 'star',
  })
  // Инициализация черновика при открытии/смене типа — до первого рендера содержимого.
  if (state && draft.id !== state.existingId) {
    const ex = state.existingId ? store.customTypeById(state.existingId) : null
    setDraft({ id: state.existingId, name: ex?.name ?? '', color: ex?.color ?? '#e2a54e', icon: ex?.icon ?? 'star' })
  }
  if (!state) return null
  const existing = state.existingId ? store.customTypeById(state.existingId) : null
  const name = draft.name
  const color = draft.color
  const icon = draft.icon
  const setName = (v: string) => setDraft({ ...draft, name: v })
  const setColor = (v: string) => setDraft({ ...draft, color: v })
  const setIcon = (v: string) => setDraft({ ...draft, icon: v })
  const close = () => store.openTypeEditor(null)
  const isNew = !existing

  const iconGrid = (keys: string[]) =>
    keys.map((k) => (
      <button key={k} className={'ico-btn' + (k === icon ? ' on' : '')} data-i={k} title={k} onClick={() => setIcon(k)}>
        <Icon name={k} size={16} />
      </button>
    ))

  return (
    <div
      id="modalWrap"
      className="show"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) close()
      }}
    >
      <div className="m-card wide">
        <h3>{isNew ? 'Новый тип элемента' : 'Редактирование типа'}</h3>
        <label className="i-lab">Название типа</label>
        <input
          className="inp"
          maxLength={40}
          placeholder="Например: Босс, Тайник, Спутник…"
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoFocus
        />
        <label className="i-lab">Цвет</label>
        <div className="swatches">
          {PALETTE_COLORS.map((c) => (
            <button
              key={c}
              className={'swatch' + (c === color ? ' on' : '')}
              style={{ background: c }}
              title={c}
              onClick={() => setColor(c)}
            />
          ))}
        </div>
        <label className="i-lab">Иконка</label>
        <div className="ico-cap">Базовые</div>
        <div className="ico-grid">{iconGrid(BASE_ICON_KEYS)}</div>
        <div className="ico-cap" style={{ marginTop: 9 }}>
          Дополнительные — {EXTRA_ICON_KEYS.length}
        </div>
        <div className="ico-grid">{iconGrid(EXTRA_ICON_KEYS)}</div>
        <div className="m-btns">
          {!isNew && (
            <button
              className="btn danger"
              onClick={() => {
                store.deleteCustomType(existing!.id)
                close()
              }}
            >
              Удалить
            </button>
          )}
          <button className="btn" onClick={close}>
            Отмена
          </button>
          <button
            className="btn primary"
            onClick={() => {
              store.saveCustomType(existing?.id ?? null, name, color, icon)
              close()
            }}
          >
            {isNew ? 'Создать' : 'Сохранить'}
          </button>
        </div>
      </div>
    </div>
  )
}

/* ═══════════ Справка ═══════════ */

export function HelpModal({ store }: { store: VetviStore }) {
  if (!store.getSnapshot().helpModalOpen) return null
  const close = () => store.setHelpModal(false)
  return (
    <div
      id="modalWrap"
      className="show"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) close()
      }}
    >
      <div className="m-card wide">
        <h3>Горячие клавиши и приёмы</h3>
        <div className="klist">
          <div>
            <kbd>Ctrl</kbd>+<kbd>Z</kbd> / <kbd>Ctrl</kbd>+<kbd>Y</kbd>
          </div>
          <div>отменить / повторить</div>
          <div>
            <kbd>Ctrl</kbd>+ЛКМ (рамка)
          </div>
          <div>нарисовать новую группу (можно пустую)</div>
          <div>
            <kbd>Ctrl</kbd>+<kbd>G</kbd> / <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>G</kbd>
          </div>
          <div>создать группу из выделенного / распустить</div>
          <div>
            <kbd>Ctrl</kbd>+<kbd>D</kbd>
          </div>
          <div>дубликат следует за курсором: клик — поставить, Esc — отменить</div>
          <div>диалог: правый край</div>
          <div>тянуть — изменить ширину блока</div>
          <div>диалог: точки реплик</div>
          <div>стрелки исходов из конкретных реплик; точка внизу правой грани — исход диалога</div>
          <div>перенос / размер группы</div>
          <div>накрываемая группа становится дочерней; выход за рамку родителя — разгруппировка</div>
          <div>
            <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>A</kbd>
          </div>
          <div>выровнять выделенные блоки по горизонтали</div>
          <div>
            <kbd>Alt</kbd> + провести по стрелкам
          </div>
          <div>нож — разрезать стрелки</div>
          <div>входная точка узла (левая)</div>
          <div>потянуть — перенести все входящие стрелки</div>
          <div>выходная точка в пустоту</div>
          <div>меню: создать элемент и сразу подключить</div>
          <div>
            <kbd>Alt</kbd>+перенос узла · <kbd>F2</kbd> · <kbd>Delete</kbd>
          </div>
          <div>выдернуть · переименовать · удалить</div>
          <div>
            СКМ · <kbd>Space</kbd> · колесо · <kbd>0</kbd>
          </div>
          <div>панорама (всегда) · панорама · масштаб · вписать</div>
        </div>
        <div className="m-btns">
          <button className="btn primary" onClick={close}>
            Понятно
          </button>
        </div>
      </div>
    </div>
  )
}

/* ═══════════ Окно распределения по строкам ═══════════ */

export function DstWin({ store, snap }: { store: VetviStore; snap: VetviSnapshot }) {
  const state = snap.dstWin
  const winRef = useRef<HTMLDivElement>(null)
  const [val, setVal] = useState(state?.k ?? 4)

  const valProxy = state?.k ?? val
  void valProxy

  useEffect(() => {
    if (!state) return
    const w = winRef.current
    if (!w) return
    // Размещение по умолчанию: правый верх стадии.
    const st = w.parentElement?.getBoundingClientRect()
    if (st) {
      const ww = w.offsetWidth || 170
      const left = st.right - ww - 24
      const top = st.top + 40
      w.style.left = Math.max(st.left + 8, Math.min(left, st.right - ww - 8)) + 'px'
      w.style.top = Math.max(st.top + 8, top) + 'px'
    }
  }, [state])

  useEffect(() => {
    if (!state) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') store.closeDstWin()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [state, store])

  if (!state) return null
  const max = state.ids.length

  const clampK = (v: number) => Math.max(1, Math.min(max, isNaN(v) ? 1 : v))

  return (
    <div ref={winRef} className="dst-win show" id="dstWin">
      <div
        className="dst-win-head"
        onPointerDown={(e) => {
          if ((e.target as HTMLElement).closest?.('.dst-win-close')) return
          e.preventDefault()
          const w = winRef.current
          if (!w) return
          const r = w.getBoundingClientRect()
          const ox = e.clientX - r.left
          const oy = e.clientY - r.top
          const mv = (ev: PointerEvent) => {
            const st = w.parentElement?.getBoundingClientRect()
            if (!st) return
            const L = Math.max(st.left + 4, Math.min(ev.clientX - ox, st.right - w.offsetWidth - 4))
            const T = Math.max(st.top + 4, Math.min(ev.clientY - oy, st.bottom - w.offsetHeight - 4))
            w.style.left = L + 'px'
            w.style.top = T + 'px'
          }
          const up = () => {
            window.removeEventListener('pointermove', mv)
            window.removeEventListener('pointerup', up)
          }
          window.addEventListener('pointermove', mv)
          window.addEventListener('pointerup', up)
        }}
      >
        <span className="dst-win-title">Распределить по строкам</span>
        <button className="dst-win-close" title="Закрыть" onClick={() => store.closeDstWin()}>
          ×
        </button>
      </div>
      <div className="dst-win-body">
        <button className="btn ibtn" title="Больше элементов в строке" onClick={() => store.setDstK(val + 1)}>
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="m6 15 6-6 6 6" />
          </svg>
        </button>
        <input
          className="dst-val"
          value={val}
          inputMode="numeric"
          maxLength={3}
          onChange={(e) => {
            const v = parseInt(e.target.value, 10)
            setVal(isNaN(v) ? 1 : clampK(v))
          }}
          onBlur={() => setVal(state.k)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
            else if (e.key === 'ArrowUp') {
              e.preventDefault()
              store.setDstK(state.k + 1)
            } else if (e.key === 'ArrowDown') {
              e.preventDefault()
              store.setDstK(state.k - 1)
            }
          }}
        />
        <button className="btn ibtn" title="Меньше элементов в строке" onClick={() => store.setDstK(val - 1)}>
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="m6 9 6 6 6-6" />
          </svg>
        </button>
        <div className="dst-hint">элементов в строке</div>
        <button className="btn primary" style={{ width: '100%', justifyContent: 'center', marginTop: 6 }} onClick={() => store.closeDstWin()}>
          Готово
        </button>
      </div>
    </div>
  )
}

/* ═══════════ Модалка группы (Ctrl+G) ═══════════ */

export function GroupModal({ store, snap }: { store: VetviStore; snap: VetviSnapshot }) {
  const [name, setName] = useState('Группа')
  if (!snap.groupModalOpen) return null
  const close = () => store.setGroupModal(false)
  return (
    <div
      id="modalWrap"
      className="show"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) close()
      }}
    >
      <div className="m-card">
        <h3>Новая группа</h3>
        <p>
          Объектов в выделении: {snap.sel.length} узлов, {snap.selGroups.length} групп. Выделенные группы станут
          вложенными.
        </p>
        <label className="i-lab">Название группы</label>
        <input
          className="inp"
          value={name}
          maxLength={60}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              close()
              store.createGroupFromSel(name)
            }
          }}
          autoFocus
        />
        <div className="m-btns">
          <button className="btn" onClick={close}>
            Отмена
          </button>
          <button
            className="btn primary"
            onClick={() => {
              close()
              store.createGroupFromSel(name)
            }}
          >
            Создать
          </button>
        </div>
      </div>
    </div>
  )
}

/** Просмотр количества заметок (для совместимости типов). */
export function noteCount(n: VetviNode): number {
  return (n.notes ?? []).length
}

export { NOTE_MAX }
