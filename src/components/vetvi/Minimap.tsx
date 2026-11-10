'use client'

/**
 * Мини-карта — порт #miniMap из прототипа: SVG-обзор холста,
 * рамка вьюпорта, drag-навигация, зум колесом, ресайз панели.
 */

import { useEffect, useRef, useState } from 'react'
import type { VetviSnapshot } from '@/lib/vetvi/types'
import type { VetviStore } from '@/lib/vetvi/store'
import { NODE_W } from '@/lib/vetvi/store'
import { clamp } from '@/lib/vetvi/yjs-model'

const MM_MIN_W = 180
const MM_MIN_H = 130

export function Minimap({
  store,
  snap,
  visible,
}: {
  store: VetviStore
  snap: VetviSnapshot
  visible: boolean
}) {
  const boxRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<SVGGElement>(null)
  const viewRef = useRef<SVGRectElement>(null)

  const [size, setSize] = useState({ w: 260, h: 180 })
  const readyRef = useRef(false)

  const mmView = useRef({ x: 0, y: 0, z: 0.2 })
  const mmSig = useRef('')
  const frameDrag = useRef<{ wx: number; wy: number; cx: number; cy: number } | null>(null)
  const panState = useRef<{ sx: number; sy: number; vx: number; vy: number } | null>(null)
  const resizeState = useRef<{ sw: number; sh: number; cx: number; cy: number } | null>(null)
  const sizeRef = useRef(size)
  useEffect(() => {
    sizeRef.current = size
  }, [size])

  const viewportBox = () => {
    const vp = store.getVp()
    const vx = -vp.x / vp.z
    const vy = -vp.y / vp.z
    return { x1: vx, y1: vy, x2: vx + store.canvasSize.w / vp.z, y2: vy + store.canvasSize.h / vp.z }
  }

  const mmFit = () => {
    let x1 = 1e9
    let y1 = 1e9
    let x2 = -1e9
    let y2 = -1e9
    let any = false
    snap.nodes.forEach((n) => {
      if (store.storeCollapsedAncestorOf(n)) return
      any = true
      x1 = Math.min(x1, n.x)
      y1 = Math.min(y1, n.y)
      x2 = Math.max(x2, n.x + NODE_W)
      y2 = Math.max(y2, n.y + 90)
    })
    snap.groups.forEach((g) => {
      if (store.groupInsideCollapsed(g)) return
      const r = store.geom?.groupRectWorld(g)
      if (!r) return
      any = true
      x1 = Math.min(x1, r.x)
      y1 = Math.min(y1, r.y)
      x2 = Math.max(x2, r.x + r.w)
      y2 = Math.max(y2, r.y + r.h)
    })
    const v = viewportBox()
    if (any) {
      x1 = Math.min(x1, v.x1)
      y1 = Math.min(y1, v.y1)
      x2 = Math.max(x2, v.x2)
      y2 = Math.max(y2, v.y2)
    } else {
      x1 = v.x1
      y1 = v.y1
      x2 = v.x2
      y2 = v.y2
    }
    const bw = Math.max(1, x2 - x1)
    const bh = Math.max(1, y2 - y1)
    const pad = 16
    const z = clamp(Math.min((sizeRef.current.w - pad * 2) / bw, (sizeRef.current.h - pad * 2) / bh), 0.02, 4)
    mmView.current.z = z
    mmView.current.x = (x1 + x2) / 2 - sizeRef.current.w / (2 * z)
    mmView.current.y = (y1 + y2) / 2 - sizeRef.current.h / (2 * z)
  }

  const render = () => {
    const c = contentRef.current
    const v = viewRef.current
    if (!c || !v) return
    c.setAttribute('transform', `scale(${mmView.current.z}) translate(${-mmView.current.x},${-mmView.current.y})`)
    const vb = viewportBox()
    v.setAttribute('x', String((vb.x1 - mmView.current.x) * mmView.current.z))
    v.setAttribute('y', String((vb.y1 - mmView.current.y) * mmView.current.z))
    v.setAttribute('width', String((vb.x2 - vb.x1) * mmView.current.z))
    v.setAttribute('height', String((vb.y2 - vb.y1) * mmView.current.z))
  }

  // Содержимое + геометрия.
  useEffect(() => {
    if (!visible) return
    if (!readyRef.current) {
      readyRef.current = true
      mmFit()
    }
    const sig =
      snap.nodes.map((n) => n.id).join('|') +
      '#' +
      snap.edges.map((e) => e.id).join('|') +
      '#' +
      snap.groups.map((g) => g.id).join('|')
    const c = contentRef.current
    if (c && sig !== mmSig.current) {
      mmSig.current = sig
      c.innerHTML = ''
      const NS = 'http://www.w3.org/2000/svg'
      snap.groups.forEach((g) => {
        const r = document.createElementNS(NS, 'rect')
        r.dataset.gid = g.id
        r.setAttribute('fill', 'none')
        r.setAttribute('stroke', g.color || '#9aa1ac')
        r.setAttribute('stroke-opacity', '0.7')
        r.setAttribute('rx', '3')
        r.setAttribute('stroke-dasharray', '4 3')
        r.setAttribute('vector-effect', 'non-scaling-stroke')
        c.appendChild(r)
      })
      snap.edges.forEach((e) => {
        const l = document.createElementNS(NS, 'line')
        l.dataset.eid = e.id
        const col =
          e.kind === 'bridge' ? '#79808d' : e.kind === 'choice' ? '#8a8f99' : e.kind === 'cond' ? '#6f7580' : '#575d68'
        l.setAttribute('stroke', col)
        l.setAttribute('stroke-width', e.kind === 'bridge' ? '2.4' : '1.2')
        l.setAttribute('vector-effect', 'non-scaling-stroke')
        c.appendChild(l)
      })
      snap.nodes.forEach((n) => {
        const r = document.createElementNS(NS, 'rect')
        r.dataset.id = n.id
        r.setAttribute('fill', store.typeInfo(n.type).color)
        r.setAttribute('fill-opacity', '0.92')
        r.setAttribute('stroke', 'rgba(0,0,0,.45)')
        r.setAttribute('stroke-width', '1')
        r.setAttribute('rx', '2')
        r.setAttribute('vector-effect', 'non-scaling-stroke')
        c.appendChild(r)
      })
    }
    if (c) {
      const byId = new Map(snap.nodes.map((n) => [n.id, n]))
      const edgeById = new Map(snap.edges.map((e) => [e.id, e]))
      const groupById = new Map(snap.groups.map((g) => [g.id, g]))
      c.querySelectorAll('rect[data-id]').forEach((r0) => {
        const r = r0 as SVGRectElement & { dataset: DOMStringMap; style: CSSStyleDeclaration }
        const n = byId.get(r.dataset.id ?? '')
        if (!n) return
        if (store.storeCollapsedAncestorOf(n)) {
          r.style.display = 'none'
          return
        }
        r.style.display = ''
        r.setAttribute('x', String(n.x))
        r.setAttribute('y', String(n.y))
        r.setAttribute('width', String(NODE_W))
        r.setAttribute('height', '90')
      })
      c.querySelectorAll('line[data-eid]').forEach((l0) => {
        const l = l0 as SVGLineElement & { dataset: DOMStringMap; style: CSSStyleDeclaration }
        const e = edgeById.get(l.dataset.eid ?? '')
        if (!e) return
        const a = store.geom?.edgeGeomById(e.id)
        if (!a) {
          l.style.display = 'none'
          return
        }
        l.style.display = ''
        l.setAttribute('x1', String(a.x1))
        l.setAttribute('y1', String(a.y1))
        l.setAttribute('x2', String(a.x2))
        l.setAttribute('y2', String(a.y2))
      })
      c.querySelectorAll('rect[data-gid]').forEach((r0) => {
        const r = r0 as SVGRectElement & { dataset: DOMStringMap; style: CSSStyleDeclaration }
        const g = groupById.get(r.dataset.gid ?? '')
        if (!g || store.groupInsideCollapsed(g)) {
          r.style.display = 'none'
          return
        }
        const rect = store.geom?.groupRectWorld(g)
        if (!rect) {
          r.style.display = 'none'
          return
        }
        r.style.display = ''
        r.setAttribute('x', String(rect.x))
        r.setAttribute('y', String(rect.y))
        r.setAttribute('width', String(rect.w))
        r.setAttribute('height', String(rect.h))
      })
    }
    render()
     
  }, [snap, visible, size])

  useEffect(() => store.onVp(render), [store])

  // Жесты.
  useEffect(() => {
    if (!visible) return

    const mmToLocal = (e: PointerEvent) => {
      const box = boxRef.current?.getBoundingClientRect()
      const hs = (box?.width ?? sizeRef.current.w) / sizeRef.current.w || 1
      return { x: (e.clientX - (box?.left ?? 0)) / hs, y: (e.clientY - (box?.top ?? 0)) / hs }
    }
    const mmToWorld = (mx: number, my: number) => ({
      x: mmView.current.x + mx / mmView.current.z,
      y: mmView.current.y + my / mmView.current.z,
    })

    const down = (e: PointerEvent) => {
      const target = e.target as HTMLElement
      if (target.closest?.('.mm-resize')) return
      const p = mmToLocal(e)
      if (e.button === 0) {
        e.preventDefault()
        e.stopPropagation()
        const vb = viewportBox()
        const w0 = mmToWorld(p.x, p.y)
        frameDrag.current = { wx: w0.x, wy: w0.y, cx: (vb.x1 + vb.x2) / 2, cy: (vb.y1 + vb.y2) / 2 }
        if (boxRef.current) boxRef.current.style.cursor = 'grabbing'
        return
      }
      if (e.button === 1) {
        e.preventDefault()
        e.stopPropagation()
        panState.current = { sx: p.x, sy: p.y, vx: mmView.current.x, vy: mmView.current.y }
        if (boxRef.current) boxRef.current.style.cursor = 'grabbing'
      }
    }

    const move = (e: PointerEvent) => {
      const rs = resizeState.current
      if (rs) {
        const dx = e.clientX - rs.cx
        const dy = e.clientY - rs.cy
        const nw = clamp(rs.sw - dx, MM_MIN_W, 1400)
        const nh = clamp(rs.sh + dy, MM_MIN_H, 1000)
        const prev = sizeRef.current
        setSize({ w: nw, h: nh })
        // Сохраняем центр обзора.
        const cwx = mmView.current.x + prev.w / (2 * mmView.current.z)
        const cwy = mmView.current.y + prev.h / (2 * mmView.current.z)
        requestAnimationFrame(() => {
          mmView.current.x = cwx - nw / (2 * mmView.current.z)
          mmView.current.y = cwy - nh / (2 * mmView.current.z)
          render()
        })
        return
      }
      const fd = frameDrag.current
      if (fd) {
        const p = mmToLocal(e)
        const w = mmToWorld(p.x, p.y)
        const ncx = fd.cx + (w.x - fd.wx)
        const ncy = fd.cy + (w.y - fd.wy)
        const vp = store.getVp()
        const vw = store.canvasSize.w / vp.z
        const vh = store.canvasSize.h / vp.z
        store.setVp(-(ncx - vw / 2) * vp.z, -(ncy - vh / 2) * vp.z)
        return
      }
      const ps = panState.current
      if (ps) {
        const p = mmToLocal(e)
        mmView.current.x = ps.vx - (p.x - ps.sx) / mmView.current.z
        mmView.current.y = ps.vy - (p.y - ps.sy) / mmView.current.z
        render()
      }
    }

    const up = () => {
      if (resizeState.current) {
        resizeState.current = null
        boxRef.current?.classList.remove('mm-resizing')
      }
      if (frameDrag.current) {
        frameDrag.current = null
        if (boxRef.current) boxRef.current.style.cursor = ''
      }
      if (panState.current) {
        panState.current = null
        if (boxRef.current) boxRef.current.style.cursor = ''
      }
    }

    const box = boxRef.current
    box?.addEventListener('pointerdown', down)
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    return () => {
      box?.removeEventListener('pointerdown', down)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
     
  }, [visible, store])

  if (!visible) return null

  return (
    <div id="miniMap" ref={boxRef} style={{ width: size.w, height: size.h }}>
      <svg viewBox={`0 0 ${size.w} ${size.h}`} preserveAspectRatio="none">
        <g ref={contentRef} id="mmContent" />
        <rect ref={viewRef} id="mmView" x={0} y={0} width={0} height={0} />
      </svg>
      <i
        className="mm-resize"
        title="Потяни за угол, чтобы изменить размер карты"
        onPointerDown={(e) => {
          e.preventDefault()
          e.stopPropagation()
          resizeState.current = { sw: sizeRef.current.w, sh: sizeRef.current.h, cx: e.clientX, cy: e.clientY }
        }}
      />
    </div>
  )
}
