'use client'

/**
 * Инспектор — порт renderInspector из прототипа.
 * Приоритет: связь → мультивыбор → группа → узел → пусто.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import type { VetviSnapshot, VetviNode, VetviEdge, VetviGroup, NodeStatus, EdgeKind } from '@/lib/vetvi/types'
import { STATUS_RU, KINDS_RU, PALETTE_COLORS, FOLD_NAMES, type TypeInfo } from '@/lib/vetvi/types'
import type { VetviStore } from '@/lib/vetvi/store'
import { NOTE_MAX } from '@/lib/vetvi/store'
import { fmtD, hexToRgba } from '@/lib/vetvi/colors'
import { Icon } from './Icons'
import { sanitizeNoteHtml } from './note-html'

export function Inspector({
  store,
  snap,
  className,
}: {
  store: VetviStore
  snap: VetviSnapshot
  className?: string
}) {
  const content = useMemo(() => {
    if (snap.selEdge) return <InspEdge key={'e' + snap.selEdge} store={store} snap={snap} />
    const total = snap.sel.length + snap.selGroups.length
    if (total > 1) return <InspMulti store={store} snap={snap} />
    if (total === 1 && snap.selGroups.length === 1) return <InspGroup key={'g' + snap.selGroup} store={store} snap={snap} />
    if (snap.sel.length === 1) return <InspNode key={'n' + snap.sel[0]} store={store} snap={snap} />
    return <InspEmpty store={store} snap={snap} />
  }, [snap, store])

  return (
    <aside id="right" className={className}>
      <div className="i-cap">Инспектор элемента</div>
      <div id="insp">{content}</div>
    </aside>
  )
}

/* ═══════════ Связь ═══════════ */

function InspEdge({ store, snap }: { store: VetviStore; snap: VetviSnapshot }) {
  const e = snap.edges.find((x) => x.id === snap.selEdge)
  if (!e) return <InspEmpty store={store} snap={snap} />
  const A = store.nodeById(e.from)
  const B = store.nodeById(e.to)
  let fromReplyInfo: string | null = null
  if (A?.type === 'dialog' && e.fromReply && A.dialog) {
    const find = (arr: { id: string; text: string; children?: unknown[] }[]): { id: string; text: string } | null => {
      for (const r of arr) {
        if (r.id === e.fromReply) return r
        const ch = (r as { children?: { id: string; text: string }[] }).children
        if (ch) {
          const f = find(ch)
          if (f) return f
        }
      }
      return null
    }
    const r = find(A.dialog.replies)
    if (r) fromReplyInfo = `из реплики: «${(r.text || '').slice(0, 40)}»`
  }

  return (
    <>
      <div className="i-cap">Связь</div>
      <label className="i-lab">Подпись</label>
      <input
        className="inp"
        defaultValue={e.label}
        placeholder="например: условие выполнено"
        key={e.id + '-lbl'}
        onChange={(ev) => store.setEdgeLabel(e.id, ev.target.value)}
      />
      <label className="i-lab">Тип связи</label>
      <div className="seg">
        {(Object.keys(KINDS_RU) as EdgeKind[]).map((k) => (
          <button key={k} className={e.kind === k ? 'on' : ''} onClick={() => store.setEdgeKind(e.id, k)}>
            {KINDS_RU[k]}
          </button>
        ))}
      </div>
      <div className="i-meta">
        из: «{A ? A.title : '?'}»
        {fromReplyInfo && (
          <>
            <br />
            {fromReplyInfo}
          </>
        )}
        <br />в: «{B ? B.title : '?'}»
        <br />
        ID: {e.id}
        {snap.selEdges.length > 1 && (
          <>
            <br />
            выбрано связей: {snap.selEdges.length}
          </>
        )}
        {e.pts.length > 0 && (
          <>
            <br />
            точек излома: {e.pts.length}
          </>
        )}
      </div>
      <div className="i-actions">
        <button className="btn" onClick={() => store.swapEdge(e.id)}>
          <Icon name="swap" /> Развернуть
        </button>
        <button className="btn danger" onClick={() => store.removeSelected()}>
          <Icon name="trash" /> Удалить
        </button>
      </div>
    </>
  )
}

/* ═══════════ Мультивыбор ═══════════ */

function InspMulti({ store, snap }: { store: VetviStore; snap: VetviSnapshot }) {
  const [name, setName] = useState('')
  const gn = snap.selGroups.length
  return (
    <>
      <div className="i-cap">Группа</div>
      <div className="i-empty" style={{ paddingTop: 6 }}>
        <h3>
          Выбрано: {snap.sel.length} узлов{gn ? `, ${gn} групп` : ''}
        </h3>
        <p>Выделенные группы станут вложенными в новую. Узлы внутри выделенных групп останутся в них.</p>
      </div>
      <div className="grp-row">
        <input
          className="inp"
          placeholder="Название группы…"
          maxLength={60}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') store.createGroupFromSel(name)
          }}
        />
        <button className="btn primary" title="Сгруппировать (Ctrl+G)" onClick={() => store.createGroupFromSel(name)}>
          Сгруппировать
        </button>
      </div>
      <div className="i-actions">
        <button className="btn" title="Ctrl+Shift+A" onClick={() => store.alignSelH()}>
          <Icon name="alignH" /> Выровнять
        </button>
        <button
          className="btn"
          onClick={() => {
            const r = store.duplicateSel()
            if (r) store.canvasApi?.hasCarry()
          }}
        >
          <Icon name="copy" /> Дубль
        </button>
        <button className="btn danger" onClick={() => store.removeSelected()}>
          <Icon name="trash" /> Удалить
        </button>
      </div>
    </>
  )
}

/* ═══════════ Группа ═══════════ */

function InspGroup({ store, snap }: { store: VetviStore; snap: VetviSnapshot }) {
  const gid = snap.selGroup && snap.selGroups.includes(snap.selGroup) ? snap.selGroup : snap.selGroups[0]
  const g = store.groupById(gid)
  if (!g) return <InspEmpty store={store} snap={snap} />
  const ms = store.allDescNodes(g.id)
  const gcolor = g.color || '#9aa1ac'
  const gAlpha = Math.round((typeof g.alpha === 'number' ? g.alpha : 0.55) * 100)

  return (
    <>
      <div className="i-cap">Группа</div>
      <label className="i-lab">Название</label>
      <input
        className="inp"
        defaultValue={g.name}
        maxLength={60}
        key={g.id + '-name'}
        onChange={(e) => store.updateGroup(g.id, { name: e.target.value })}
      />
      <label className="i-lab">Вид</label>
      <div className="seg">
        {[2, 1, 0].map((f) => (
          <button key={f} className={g.fold === f ? 'on' : ''} onClick={() => store.updateGroup(g.id, { fold: f as 0 | 1 | 2 })}>
            {FOLD_NAMES[f]}
          </button>
        ))}
      </div>
      <label className="i-lab">Родительская группа</label>
      <select
        className="inp"
        value={g.parent ?? ''}
        onChange={(e) => store.updateGroup(g.id, { parent: e.target.value || null })}
      >
        <option value="">— нет —</option>
        {snap.groups.map((o) => {
          if (o.id === g.id) return null
          if (store.isDescendantGroup(o.id, g.id)) return null
          return (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          )
        })}
      </select>
      <label className="i-lab">Цвет</label>
      <div className="swatches">
        {['#9aa1ac', ...PALETTE_COLORS].map((c) => (
          <button
            key={c}
            className={'swatch' + (gcolor.toLowerCase() === c.toLowerCase() ? ' on' : '')}
            style={{ background: c }}
            title={c}
            onClick={() => store.updateGroup(g.id, { color: c === '#9aa1ac' ? null : c })}
          />
        ))}
      </div>
      <label className="i-lab">
        Прозрачность: <span>{gAlpha}%</span>
      </label>
      <input
        type="range"
        className="inp"
        min={10}
        max={100}
        defaultValue={gAlpha}
        key={g.id + '-alpha' + gAlpha}
        onChange={(e) => store.updateGroup(g.id, { alpha: Number(e.target.value) / 100 })}
      />
      <label className="chk">
        <input
          type="checkbox"
          checked={g.badge}
          onChange={(e) => store.updateGroup(g.id, { badge: e.target.checked })}
        />{' '}
        Ярлык с именем (не зависит от зума)
      </label>
      <label className="chk">
        <input type="checkbox" checked={g.auto} onChange={() => store.toggleGroupAuto(g.id)} /> Авторазмер (рамка
        следует за содержимым)
      </label>
      <label className="i-lab">Состав ({ms.length})</label>
      <div className="gm-list">
        {ms.map((n) => {
          const v = store.typeInfo(n.type)
          return (
            <div className="gm-row" key={n.id}>
              <span className="dot" style={{ background: v.color }} />
              {n.title}
            </div>
          )
        })}
      </div>
      <div className="i-actions">
        <button className="btn danger" onClick={() => store.ungroup(g.id)}>
          <Icon name="x" /> Распустить
        </button>
      </div>
    </>
  )
}

/* ═══════════ Узел ═══════════ */

function InspNode({ store, snap }: { store: VetviStore; snap: VetviSnapshot }) {
  const n = store.nodeById(snap.sel[0])
  if (!n) return <InspEmpty store={store} snap={snap} />
  const vis = store.typeInfo(n.type)
  const isCustom = !(['scene', 'char', 'quest', 'dialog', 'skill', 'branch', 'event', 'note'] as string[]).includes(n.type)
  const gr = n.gid ? store.groupById(n.gid) : null
  let out = 0
  let inn = 0
  snap.edges.forEach((e) => {
    if (e.from === n.id) out++
    if (e.to === n.id) inn++
  })

  const typeOpts = store.allTypeKeys()

  return (
    <InspNodeInner
      key={n.id}
      store={store}
      snap={snap}
      n={n}
      vis={vis}
      isCustom={isCustom}
      grName={gr?.name ?? null}
      inn={inn}
      out={out}
      typeOpts={typeOpts}
    />
  )
}

function InspNodeInner({
  store,
  snap,
  n,
  vis,
  isCustom,
  grName,
  inn,
  out,
  typeOpts,
}: {
  store: VetviStore
  snap: VetviSnapshot
  n: VetviNode
  vis: TypeInfo
  isCustom: boolean
  grName: string | null
  inn: number
  out: number
  typeOpts: string[]
}) {
  const isDialog = n.type === 'dialog'
  const d = n.dialog
  const notes = n.notes ?? []

  const availChars = useMemo(() => {
    if (!isDialog || !d) return []
    return snap.nodes.filter((c) => c.type === 'char' && !d.participants.includes(c.id))
  }, [isDialog, d, snap.nodes])

  return (
    <>
      <div className="i-cap">{isCustom ? `Свой тип: ${vis.name}` : isDialog ? 'Диалог' : 'Элемент'}</div>
      <div className="i-typehead">
        <span className="i-typeico" style={{ color: vis.color, background: 'rgba(255,255,255,.05)' }}>
          <Icon name={vis.icon} size={18} />
        </span>
        <select className="inp" value={n.type} onChange={(e) => store.setNodeType(n.id, e.target.value)}>
          {typeOpts.map((t) => {
            const info = store.typeInfo(t)
            const isCustomT = !(['scene', 'char', 'quest', 'dialog', 'skill', 'branch', 'event', 'note'] as string[]).includes(t)
            return (
              <option key={t} value={t}>
                {info.name}
                {isCustomT ? ' (свой)' : ''}
              </option>
            )
          })}
        </select>
      </div>

      <label className="i-lab">Название {isDialog ? 'диалога' : '(или F2 на холсте)'}</label>
      <input
        className="inp"
        defaultValue={n.title}
        maxLength={80}
        onChange={(e) => store.updateNodeTextField(n.id, 'title', e.target.value)}
      />

      <label className="i-lab">Статус</label>
      <div className="seg">
        {(Object.keys(STATUS_RU) as NodeStatus[]).map((k) => (
          <button
            key={k}
            className={(n.status === k ? 'on ' : '') + (n.status === k ? 'c-' + k : '')}
            onClick={() => store.setNodeStatus(n.id, k)}
          >
            {STATUS_RU[k]}
          </button>
        ))}
      </div>

      {isDialog && d && (
        <>
          <label className="i-lab">Участники</label>
          <div id="dlgParts">
            {d.participants.map((pid) => {
              const c = store.nodeById(pid)
              const color = c ? (c.color ? c.color : store.typeInfo(c.type).color) : '#8b929c'
              return (
                <span
                  key={pid}
                  className="dlg-chip"
                  style={{ background: hexToRgba(color, 0.15), color, borderColor: hexToRgba(color, 0.55) }}
                >
                  <span>{c ? c.title : '(неизвестный)'}</span>
                  <span className="x" title="Убрать" onClick={() => store.removeDialogParticipant(n.id, pid)}>
                    <Icon name="x" size={10} />
                  </span>
                </span>
              )
            })}
          </div>
          <select
            className="inp"
            style={{ marginTop: 6, height: 28, fontSize: 11.5 }}
            value=""
            onChange={(e) => {
              if (e.target.value) store.addDialogParticipant(n.id, e.target.value)
            }}
          >
            <option value="">+ добавить участника…</option>
            {availChars.map((c) => (
              <option key={c.id} value={c.id}>
                {c.title}
              </option>
            ))}
          </select>
          <label className="i-lab">Описание</label>
          <textarea
            className="inp"
            placeholder="Кратко о чём диалог, контекст…"
            style={{ minHeight: 60 }}
            defaultValue={d.description}
            onChange={(e) => store.updateNodeTextField(n.id, 'text', e.target.value)}
          />
          <label className="i-lab">Реплики ({countAllReplies(d.replies)})</label>
          <div style={{ marginTop: 6 }}>
            <button className="btn primary" style={{ width: '100%' }} onClick={() => store.openDlgEditor(n.id)}>
              <Icon name="pencil" size={14} />
              Редактировать реплики
            </button>
          </div>
        </>
      )}

      {!isDialog && (
        <>
          <label className="i-lab">Цвет фона элемента</label>
          <div className="swatches">
            {PALETTE_COLORS.map((c) => (
              <button
                key={c}
                className={'swatch' + (n.color === c ? ' on' : '')}
                style={{ background: c }}
                title={c}
                onClick={() => store.setNodeColor(n.id, c)}
              />
            ))}
            <button
              className={'swatch reset' + (n.color ? '' : ' on')}
              title="Сбросить к базовому виду"
              onClick={() => store.setNodeColor(n.id, null)}
            >
              <Icon name="x" size={12} />
            </button>
          </div>
          <label className="i-lab">
            Яркость цвета: <span>{(n.tint > 0 ? '+' : '') + n.tint}%</span>
          </label>
          <input
            type="range"
            className="inp"
            min={-60}
            max={60}
            defaultValue={n.tint}
            key={'tint' + n.tint}
            onChange={(e) => store.setNodeTint(n.id, Number(e.target.value))}
          />
          <label className="i-lab">Описание</label>
          <textarea
            className="inp"
            placeholder="Что здесь происходит?"
            defaultValue={n.text}
            onChange={(e) => store.updateNodeTextField(n.id, 'text', e.target.value)}
          />
          <label className="i-lab">Теги, через запятую</label>
          <input
            className="inp"
            defaultValue={(n.tags ?? []).join(', ')}
            placeholder="акт 1, хаб…"
            onBlur={(e) =>
              store.setNodeTags(
                n.id,
                e.target.value
                  .split(',')
                  .map((s) => s.trim())
                  .filter(Boolean),
              )
            }
          />
        </>
      )}

      <NotesSection store={store} snap={snap} n={n} />

      <div className="i-meta">
        тип: {vis.name}
        {grName && (
          <>
            <br />
            группа: {grName}
          </>
        )}
        <br />
        ID: {n.id} · входов: {inn} · выходов: {out}
      </div>
      <div className="i-actions">
        <button className="btn" onClick={() => store.duplicateSel()}>
          <Icon name="copy" /> Дубль
        </button>
        <button className="btn" onClick={() => store.geom?.centerOn(n.id)}>
          <Icon name="target" /> Центр
        </button>
        <button className="btn danger" onClick={() => store.removeSelected()}>
          <Icon name="trash" /> Удалить
        </button>
      </div>
    </>
  )
}

function countAllReplies(replies: { children?: unknown[] }[]): number {
  let c = 0
  replies.forEach((r) => {
    c++
    const ch = r.children as { children?: unknown[] }[] | undefined
    if (ch) c += countAllReplies(ch)
  })
  return c
}

/* ═══════════ Заметки ═══════════ */

export function NotesSection({ store, snap, n }: { store: VetviStore; snap: VetviSnapshot; n: VetviNode }) {
  const notes = n.notes ?? []
  const anyVisible = notes.some((x) => !x.hidden)
  return (
    <>
      <label className="i-lab" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        Заметки ({notes.length}/{NOTE_MAX})
        <span style={{ display: 'flex', gap: 4 }}>
          <button
            className={'mini-btn eye' + (anyVisible ? '' : ' off')}
            title={anyVisible ? 'Скрыть все у элемента' : 'Показать все'}
            onClick={() => store.toggleAllNotes(n.id)}
          >
            <Icon name={anyVisible ? 'eye' : 'eyeOff'} size={12} />
          </button>
          <button
            className="mini-btn"
            title="Добавить заметку"
            disabled={notes.length >= NOTE_MAX}
            style={notes.length >= NOTE_MAX ? { opacity: 0.35 } : undefined}
            onClick={() => store.openNoteEditor(n.id, -1)}
          >
            <Icon name="plus" size={12} />
          </button>
        </span>
      </label>
      <div className="note-list">
        {notes.length === 0 && <div className="note-empty">Заметок нет — добавьте через +</div>}
        {notes.map((note, ni) => (
          <div key={ni} className={'note-row' + (note.hidden ? ' hidden' : '')}>
            <span className="note-row-title" onClick={() => store.openNoteView(n.id, ni)} role="button">
              {note.title || 'Без названия'}
            </span>
            <span className="note-row-acts">
              <button className="mini-btn" title="Редактировать" onClick={() => store.openNoteEditor(n.id, ni)}>
                <Icon name="pencil" size={12} />
              </button>
              <button
                className={'mini-btn eye' + (note.hidden ? ' off' : '')}
                title={note.hidden ? 'Показать' : 'Скрыть от элемента'}
                onClick={() => store.toggleNoteHidden(n.id, ni)}
              >
                <Icon name={note.hidden ? 'eyeOff' : 'eye'} size={12} />
              </button>
              <button className="mini-btn del" title="Удалить" onClick={() => store.deleteNote(n.id, ni)}>
                <Icon name="x" size={12} />
              </button>
            </span>
          </div>
        ))}
      </div>
    </>
  )
}

/* ═══════════ Пусто ═══════════ */

function InspEmpty({ store, snap }: { store: VetviStore; snap: VetviSnapshot }) {
  const cells = store.allTypeKeys().map((key) => {
    const info = store.typeInfo(key)
    const cnt = snap.nodes.filter((x) => x.type === key).length
    return (
      <div className="ovcell" key={key}>
        <span className="d" style={{ background: info.color }} />
        <span className="n">{info.name}</span>
        <span className="c">{cnt}</span>
      </div>
    )
  })
  return (
    <div className="i-empty">
      <div className="ghost">
        <Icon name="branch" size={26} />
      </div>
      <h3>Ничего не выбрано</h3>
      <p>
        Кликните по узлу, связи или рамке группы.
        <br />
        <b>Ctrl+ЛКМ</b> по холсту — нарисовать новую группу.
      </p>
      <div className="ovgrid">{cells}</div>
      <div className="ovmeta">
        создан: {snap.meta.createdAt ? fmtD(snap.meta.createdAt) : '—'}
        <br />
        изменён: {snap.meta.updatedAt ? fmtD(snap.meta.updatedAt) : '—'}
        <br />
        своих типов: {snap.customTypes.length} · групп: {snap.groups.length}
      </div>
    </div>
  )
}

/* Вспомогательное: превью текста реплики в мета (не используется напрямую) */
export function edgeLabelPreview(e: VetviEdge): string {
  return e.label || KINDS_RU[e.kind]
}
