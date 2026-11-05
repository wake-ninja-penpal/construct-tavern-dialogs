'use client'

/**
 * Левая панель: вкладки «Элементы» (палитра) и «Обзор» (дерево с поиском)
 * + кнопка создания своего типа. Порт #left из прототипа.
 */

import { useMemo, useRef, useState } from 'react'
import type { VetviSnapshot, VetviNode, VetviGroup } from '@/lib/vetvi/types'
import type { VetviStore } from '@/lib/vetvi/store'
import { STATUS_RU } from '@/lib/vetvi/types'
import { Icon } from './Icons'

export function LeftPanel({
  store,
  snap,
  className,
}: {
  store: VetviStore
  snap: VetviSnapshot
  className?: string
}) {
  const [tab, setTab] = useState<'pal' | 'list'>('pal')
  const [q, setQ] = useState('')

  return (
    <aside id="left" className={className}>
      <nav className="ltabs">
        <button className={'ltab' + (tab === 'pal' ? ' active' : '')} data-t="pal" onClick={() => setTab('pal')}>
          Элементы
        </button>
        <button
          className={'ltab' + (tab === 'list' ? ' active' : '')}
          data-t="list"
          onClick={() => setTab('list')}
        >
          Обзор
        </button>
        <button className="add-type" id="bAddType" title="Создать свой тип элемента" onClick={() => store.openTypeEditor(null)}>
          +
        </button>
      </nav>

      <div className={'tabpane' + (tab === 'pal' ? ' active' : '')} id="panePal">
        <Palette store={store} snap={snap} />
      </div>

      <div className={'tabpane' + (tab === 'list' ? ' active' : '')} id="paneList">
        <div className="search">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden>
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" />
          </svg>
          <input
            id="sQ"
            placeholder="Поиск по узлам и группам…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        <OverviewList store={store} snap={snap} q={q.toLowerCase().trim()} />
      </div>
    </aside>
  )
}

/* ═══════════ Палитра ═══════════ */

function Palette({ store, snap }: { store: VetviStore; snap: VetviSnapshot }) {
  const hiddenSet = useMemo(() => new Set(snap.listHidden), [snap.listHidden])
  const nodesByType = useMemo(() => {
    const m = new Map<string, VetviNode[]>()
    snap.nodes.forEach((n) => {
      const arr = m.get(n.type) ?? []
      arr.push(n)
      m.set(n.type, arr)
    })
    return m
  }, [snap.nodes])

  const addToCenter = (typeKey: string) => {
    const c = store.geom?.getCenterWorld() ?? { x: 0, y: 0 }
    store.addNode(typeKey, c.x - 108, c.y - 46, true)
  }

  const anyShown = store.allTypeKeys().some((key) => !hiddenSet.has(key) && (nodesByType.get(key)?.length ?? 0) > 0)

  return (
    <div id="palList">
      {store.allTypeKeys().map((key) => {
        const info = store.typeInfo(key)
        const isCustom = !(['scene', 'char', 'quest', 'dialog', 'skill', 'branch', 'event', 'note'] as string[]).includes(key)
        const off = hiddenSet.has(key)
        const cnt = (nodesByType.get(key) ?? []).length
        return (
          <div
            key={key}
            className={'pal-item' + (isCustom ? ' custom' : '') + (off ? ' dim' : '')}
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData('text/vetvi-type', key)
              e.dataTransfer.effectAllowed = 'copy'
            }}
            style={{ ['--c' as string]: info.color }}
            title={(isCustom ? 'Свой тип · ' : '') + info.name}
            onClick={() => addToCenter(key)}
          >
            <span className="pal-ico">
              <Icon name={info.icon} size={16} />
            </span>
            <span className="pal-name">{info.name}</span>
            <span className="pal-cnt">{cnt}</span>
            <button
              className={'mini-btn eye' + (off ? ' off' : '')}
              title={off ? 'Вернуть тип в раздел «На холсте»' : 'Убрать тип из раздела «На холсте»'}
              onClick={(e) => {
                e.stopPropagation()
                store.toggleListVis(key)
              }}
            >
              <Icon name={off ? 'eyeOff' : 'eye'} size={13} />
            </button>
            {isCustom && (
              <span className="item-acts">
                <button
                  className="mini-btn"
                  title="Редактировать"
                  onClick={(e) => {
                    e.stopPropagation()
                    store.openTypeEditor(key)
                  }}
                >
                  <Icon name="pencil" size={12} />
                </button>
                <button
                  className="mini-btn del"
                  title="Удалить тип"
                  onClick={(e) => {
                    e.stopPropagation()
                    store.deleteCustomType(key)
                  }}
                >
                  <Icon name="x" size={12} />
                </button>
              </span>
            )}
          </div>
        )
      })}

      <div className="pal-sep">на холсте</div>

      {!snap.nodes.length ? (
        <div className="pal-hint" style={{ textAlign: 'center' }}>
          Холст пуст — перетащите что-нибудь сверху.
        </div>
      ) : !anyShown ? (
        <div className="pal-hint" style={{ textAlign: 'center' }}>
          Все типы убраны глазиками выше.
        </div>
      ) : (
        store.allTypeKeys().map((key) => {
          if (hiddenSet.has(key)) return null
          const list = nodesByType.get(key) ?? []
          if (!list.length) return null
          const info = store.typeInfo(key)
          const fk = 'cv:' + key
          const folded = !!snap.palFold[fk]
          const isCustom = !(['scene', 'char', 'quest', 'dialog', 'skill', 'branch', 'event', 'note'] as string[]).includes(key)
          return (
            <div key={key}>
              <div
                className={'pal-group foldable' + (folded ? ' folded' : '')}
                title={folded ? 'Развернуть' : 'Свернуть'}
                onClick={() => store.togglePalFold(fk)}
              >
                <span className="pg-chev">
                  <Icon name="chev" size={10} />
                </span>
                <span className="dot" style={{ background: info.color }} />
                {info.name}
                {isCustom ? ' ·' : ''}
                <span className="pg-cnt">{list.length}</span>
              </div>
              {!folded &&
                list.map((n) => {
                  const vis = store.typeInfo(n.type)
                  const desc =
                    n.type === 'dialog'
                      ? n.dialog?.description
                        ? n.dialog.description
                        : 'диалог'
                      : n.text || 'без описания'
                  return (
                    <div
                      key={n.id}
                      className={'pal-item cv-card' + (snap.sel.includes(n.id) ? ' sel' : '')}
                      draggable
                      onDragStart={(e) => {
                        e.dataTransfer.setData('text/vetvi-clone', n.id)
                        e.dataTransfer.effectAllowed = 'copy'
                      }}
                      style={{ ['--c' as string]: vis.color }}
                      title="Клик — перейти · перетащите, чтобы создать копию"
                      onClick={() => {
                        store.geom?.centerOn(n.id)
                        store.selectOnly(n.id)
                      }}
                    >
                      <span className="pal-ico">
                        <Icon name={vis.icon} size={16} />
                      </span>
                      <span className="cv-info">
                        <span className="pal-name">{n.title}</span>
                        <span className="cv-desc">{desc}</span>
                      </span>
                      <span className={'n-st st-' + n.status} title={STATUS_RU[n.status]} />
                    </div>
                  )
                })}
            </div>
          )
        })
      )}
    </div>
  )
}

/* ═══════════ Обзор ═══════════ */

function nodeMatches(n: VetviNode, q: string): boolean {
  if (!q) return true
  if (n.title.toLowerCase().includes(q)) return true
  const txt = n.type === 'dialog' ? n.dialog?.description || '' : n.text || ''
  return txt.toLowerCase().includes(q)
}

function OverviewList({ store, snap, q }: { store: VetviStore; snap: VetviSnapshot; q: string }) {
  const groupRows: React.ReactNode[] = []

  const renderGroup = (g: VetviGroup, depth: number, keyPrefix: string) => {
    const desc = store.allDescNodes(g.id)
    const matchSelf = !q || g.name.toLowerCase().includes(q)
    const matched = desc.filter((n) => nodeMatches(n, q))
    if (q && !matchSelf && !matched.length) return
    const indent = 9 + depth * 14
    const isF = !!snap.ovFold[g.id] && !q
    const gcolor = g.color || '#9aa1ac'
    groupRows.push(
      <div
        key={keyPrefix + g.id}
        className={'nli grp' + (snap.selGroups.includes(g.id) ? ' sel' : '')}
        style={{ paddingLeft: indent }}
        onClick={(ev) => {
          if ((ev.target as HTMLElement).closest?.('.ov-f')) return
          store.geom?.centerOn(g.id)
          store.selectGroup(g.id)
        }}
      >
        <button
          className={'ov-f' + (isF ? ' folded' : '')}
          title="Свернуть/развернуть"
          onClick={(ev) => {
            ev.stopPropagation()
            store.toggleOvFold(g.id)
          }}
        >
          <Icon name="chev" size={10} />
        </button>
        <span className="garr">
          <Icon name="folder" size={11} />
        </span>
        <span className="dot" style={{ background: gcolor }} />
        <span className="t">{g.name}</span>
        <span className="k">{desc.length}</span>
      </div>,
    )
    if (isF) return
    snap.groups.forEach((cg) => {
      if (cg.parent === g.id) renderGroup(cg, depth + 1, keyPrefix + g.id + '/')
    })
    const direct = store.membersOf(g.id).filter((n) => matchSelf || nodeMatches(n, q))
    direct.forEach((n) => {
      const vis = store.typeInfo(n.type)
      groupRows.push(
        <div
          key={keyPrefix + g.id + '/' + n.id}
          className={'nli' + (snap.sel.includes(n.id) ? ' sel' : '')}
          style={{ paddingLeft: indent + 22 }}
          onClick={() => {
            store.geom?.centerOn(n.id)
            store.selectOnly(n.id)
          }}
        >
          <span className="dot" style={{ background: vis.color }} />
          <span className="t">{n.title}</span>
          <span className="k">{vis.name}</span>
        </div>,
      )
    })
  }

  snap.groups.forEach((g, i) => {
    if (!g.parent) renderGroup(g, 0, 'g' + i)
  })

  const loose = snap.nodes.filter((n) => !n.gid && nodeMatches(n, q))
  const looseRows = loose.map((n) => {
    const vis = store.typeInfo(n.type)
    return (
      <div
        key={'l' + n.id}
        className={'nli' + (snap.sel.includes(n.id) ? ' sel' : '')}
        onClick={() => {
          store.geom?.centerOn(n.id)
          store.selectOnly(n.id)
        }}
      >
        <span className="dot" style={{ background: vis.color }} />
        <span className="t">{n.title}</span>
        <span className="k">{vis.name}</span>
      </div>
    )
  })

  return (
    <div id="nodeList">
      {groupRows}
      {snap.groups.length > 0 && loose.length > 0 && (
        <div className="pal-sep" style={{ margin: '16px 4px 2px' }}>
          без группы
        </div>
      )}
      {looseRows}
      {!groupRows.length && !looseRows.length && (
        <div className="list-empty">{q ? 'Ничего не найдено' : 'Пока нет узлов'}</div>
      )}
    </div>
  )
}
