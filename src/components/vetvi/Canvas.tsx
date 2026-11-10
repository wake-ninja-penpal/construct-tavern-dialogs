'use client'

/**
 * Холст «Ветвей» — точный императивный порт рендера и жестов vetvi33.html.
 *
 * Мир (узлы/связи/группы) рендерится императивно с дифф-обновлениями по сигнатурам
 * (быстро даже при realtime-правках соавторов), React управляет только оболочкой.
 */

import { useEffect, useRef } from 'react'
import type { VetviSnapshot, VetviNode, VetviEdge, VetviGroup, CtxEntry } from '@/lib/vetvi/types'
import type { VetviStore } from '@/lib/vetvi/store'
import { NODE_W, GRID, GCARD_W, MAX_DLG_DEPTH, DLG_REPLY_INDENT } from '@/lib/vetvi/store'
import { isBridge, edgePathD, edgeSample, labelPos, nearestPointOnEdge, nearestSegIndex, segIntersect, bridgeGeom, bridgeCorners, type EdgeGeom, type GeomPoint } from '@/lib/vetvi/geometry'
import { hexToRgba, shadeHex, nodePaint } from '@/lib/vetvi/colors'
import { iconPath } from '@/lib/vetvi/icons'

interface Pt {
  x: number
  y: number
}

type Gesture =
  | { kind: 'pan'; sx: number; sy: number; vx: number; vy: number }
  | { kind: 'marquee'; sx: number; sy: number; add: boolean; preN: string[]; preG: string[] }
  | {
      kind: 'drag'
      sx: number
      sy: number
      moved: boolean
      extract: boolean
      dropEdge: string | null
      hoverG: string | null
      start: Map<string, Pt>
      ptBase: Map<string, Pt[]>
    }
  | {
      kind: 'gdrag'
      gid: string
      sx: number
      sy: number
      moved: boolean
      p0: string | null
      gx: number
      gy: number
      start: Map<string, Pt>
      cards: Map<string, Pt>
      frames: Map<string, Pt>
      ptEdges: Set<string>
      ptBase: Map<string, Pt[]>
      excl: Set<string>
      hoverG: string | null
    }
  | { kind: 'gcreate'; sx: number; sy: number }
  | { kind: 'connect'; from: string; fromReply: string | null; x1: number; y1: number; hl: HTMLElement | null; wx: number | null; wy: number | null; cx: number; cy: number }
  | { kind: 'inDrag'; nid: string; moved: boolean; hl: HTMLElement | null }
  | { kind: 'outDrag'; nid: string; moved: boolean; hl: HTMLElement | null }
  | { kind: 'repOutDrag'; nid: string; replyId: string; moved: boolean; hl: HTMLElement | null }
  | { kind: 'knife'; path: Pt[]; removed: Set<string>; startEdge: string | null; moved: boolean }
  | { kind: 'brDrag'; eid: string; mode: 'l' | 'r' | 'h'; moved: boolean; last: Pt }
  | { kind: 'wpDrag'; eid: string; idx: number; moved: boolean }
  | { kind: 'rpDrag'; eid: string; side: 'from' | 'to'; ax: number; ay: number }
  | { kind: 'lblDrag'; eid: string; moved: boolean }
  | { kind: 'grestore'; gid: string; mode: string; sx: number; sy: number; r0: { x: number; y: number; w: number; h: number }; moved: boolean }
  | { kind: 'dlgResize'; nid: string; sx: number; origWidth: number; moved: boolean }
  | { kind: 'carry'; ids: string[]; orig: Map<string, Pt>; cx: number; cy: number }

interface EdgeEls {
  g: SVGGElement
  line: SVGPathElement
  hit: SVGPathElement
  label: SVGTextElement
  labelHit: SVGTextElement
  wps: SVGCircleElement[]
  epFrom: SVGCircleElement
  epTo: SVGCircleElement
}

function svgEl(tag: string): SVGElement {
  return document.createElementNS('http://www.w3.org/2000/svg', tag)
}

function clampN(v: number, a: number, b: number): number {
  return Math.max(a, Math.min(b, v))
}

export function Canvas({
  store,
  snap,
  className,
  minimap,
}: {
  store: VetviStore
  snap: VetviSnapshot
  className?: string
  minimap: React.ReactNode
}) {
  const canvasRef = useRef<HTMLDivElement>(null)
  const worldRef = useRef<HTMLDivElement>(null)
  const framesLayerRef = useRef<HTMLDivElement>(null)
  const edgesSvgRef = useRef<SVGSVGElement>(null)
  const marqueeRef = useRef<HTMLDivElement>(null)
  const labelsRef = useRef<HTMLDivElement>(null)

  const canvasRefObj = useRef<VetviCanvasController | null>(null)

  useEffect(() => {
    const c = canvasRef.current
    if (!c) return
    const ctrl = new VetviCanvasController(c, worldRef.current!, framesLayerRef.current!, edgesSvgRef.current!, marqueeRef.current!, labelsRef.current!, store)
    canvasRefObj.current = ctrl
    ctrl.mount()
    return () => {
      ctrl.destroy()
      canvasRefObj.current = null
    }
  }, [store])

  // Дифф-рендер мира на каждое изменение снапшота.
  useEffect(() => {
    canvasRefObj.current?.renderAll()
  }, [snap])

  return (
    <div id="canvas" ref={canvasRef} className={className}>
      <div id="world" ref={worldRef}>
        <div id="framesLayer" ref={framesLayerRef} />
        <svg id="edges" ref={edgesSvgRef} width="10" height="10">
          <defs>
            <marker id="arw" viewBox="0 0 10 10" refX="8.6" refY="5" markerWidth="7.5" markerHeight="7.5" orient="auto">
              <path d="M10 5 L1.34 0.67 Q0 0 0 1.5 L0 8.5 Q0 10 1.34 9.33 Z" fill="#5d636d" />
            </marker>
            <marker id="arwHi" viewBox="0 0 10 10" refX="8.6" refY="5" markerWidth="7.5" markerHeight="7.5" orient="auto">
              <path d="M10 5 L1.34 0.67 Q0 0 0 1.5 L0 8.5 Q0 10 1.34 9.33 Z" fill="#9aa1ac" />
            </marker>
            <marker id="arwSel" viewBox="0 0 10 10" refX="8.6" refY="5" markerWidth="7.5" markerHeight="7.5" orient="auto">
              <path d="M10 5 L1.34 0.67 Q0 0 0 1.5 L0 8.5 Q0 10 1.34 9.33 Z" fill="#e2a54e" />
            </marker>
            <marker id="arwBridge" viewBox="0 0 10 10" refX="8.6" refY="5" markerWidth="5" markerHeight="5" orient="auto">
              <path d="M10 5 L1.34 0.67 Q0 0 0 1.5 L0 8.5 Q0 10 1.34 9.33 Z" fill="#79808d" />
            </marker>
            <marker id="arwBridgeHi" viewBox="0 0 10 10" refX="8.6" refY="5" markerWidth="5" markerHeight="5" orient="auto">
              <path d="M10 5 L1.34 0.67 Q0 0 0 1.5 L0 8.5 Q0 10 1.34 9.33 Z" fill="#a6adb8" />
            </marker>
            <marker id="arwBridgeSel" viewBox="0 0 10 10" refX="8.6" refY="5" markerWidth="5" markerHeight="5" orient="auto">
              <path d="M10 5 L1.34 0.67 Q0 0 0 1.5 L0 8.5 Q0 10 1.34 9.33 Z" fill="#e2a54e" />
            </marker>
          </defs>
        </svg>
      </div>
      <div id="labels" ref={labelsRef} />
      <div id="emptyHint">
        <div className="ring" />
        <p>Холст пуст — перетащите элемент с панели слева</p>
      </div>
      <div id="marquee" ref={marqueeRef} />
      {minimap}
    </div>
  )
}

/* ══════════════════════════════════════════════════════════════════ */
/* Императивный контроллер холста                                      */
/* ══════════════════════════════════════════════════════════════════ */

class VetviCanvasController {
  private store: VetviStore
  private canvas: HTMLDivElement
  private world: HTMLDivElement
  private framesLayer: HTMLDivElement
  private edgesSvg: SVGSVGElement
  private marquee: HTMLDivElement
  private labels: HTMLDivElement

  private nodeEls = new Map<string, HTMLDivElement>()
  private groupEls = new Map<string, HTMLDivElement>()
  private edgeEls = new Map<string, EdgeEls>()

  private nodeSigs = new Map<string, string>()
  private groupSigs = new Map<string, string>()
  private edgeSigs = new Map<string, string>()

  private gesture: Gesture | null = null
  private spaceDown = false
  private dropEdgeId: string | null = null
  private palHover: HTMLElement | null = null
  private previewPath: SVGPathElement | null = null
  private previewPaths: { eid: string; p: SVGPathElement }[] = []
  private cutline: SVGPathElement | null = null
  private animvTimer: ReturnType<typeof setTimeout> | null = null

  constructor(
    canvas: HTMLDivElement,
    world: HTMLDivElement,
    framesLayer: HTMLDivElement,
    edgesSvg: SVGSVGElement,
    marquee: HTMLDivElement,
    labels: HTMLDivElement,
    store: VetviStore,
  ) {
    this.canvas = canvas
    this.world = world
    this.framesLayer = framesLayer
    this.edgesSvg = edgesSvg
    this.marquee = marquee
    this.labels = labels
    this.store = store
  }

  private get snap(): VetviSnapshot {
    return this.store.getSnapshot()
  }

  mount() {
    this.store.geom = {
      edgeGeomById: (id) => {
        const e = this.snap.edges.find((x) => x.id === id)
        return e ? this.edgeGeom(e) : null
      },
      nearestEdgeAt: (x, y, maxDist, exclude) => this.nearestEdgeAt(x, y, maxDist, exclude),
      deepestGroupAt: (x, y) => this.deepestGroupAt(x, y),
      groupRectWorld: (g) => this.groupRectWorld(g),
      collapsedAncestorOf: (n) => this.collapsedAncestorOf(n),
      nodeDims: (n) => {
        const el = this.nodeEls.get(n.id)
        const visible = el && el.style.display !== 'none'
        return { w: visible ? el!.offsetWidth : this.dlgWOf(n), h: visible ? el!.offsetHeight : 90 }
      },
      refreshFrames: () => this.refreshGroupFrames(),
      fitView: (animate) => this.fitView(animate),
      centerOn: (id) => {
        const n = this.snap.nodes.find((x) => x.id === id)
        if (n) this.centerOn(n)
      },
      getCenterWorld: () => {
        const r = this.canvas.getBoundingClientRect()
        const vp = this.store.getVp()
        return { x: (r.width / 2 - vp.x) / vp.z, y: (r.height / 2 - vp.y) / vp.z }
      },
      flashSpawnNodes: (ids) => ids.forEach((id) => this.flashNode(id)),
      flashSpawnEdge: (id) => this.flashEdge(id),
    }

    this.store.canvasApi = {
      startInlineEdit: (id) => {
        const el = this.nodeEls.get(id)
        if (el && el.style.display !== 'none') this.startInlineEdit(el)
      },
      cancelGestures: () => this.cancelGestures(),
      cancelCarry: () => this.cancelCarry(),
      hasCarry: () => this.gesture?.kind === 'carry',
      cancelGroupCreate: () => {
        if (this.gesture?.kind === 'gcreate') {
          this.gesture = null
          this.marquee.style.display = 'none'
          this.marquee.classList.remove('mg')
        }
      },
      openCtxAdd: (x, y) => this.openCtxMenu(x, y, this.ctxAddItems(this.toWorld(x, y))),
      startCarry: (ids) => this.startCarry(ids),
    }

    this.canvas.addEventListener('pointerdown', this.onPointerDown)
    this.canvas.addEventListener('wheel', this.onWheel, { passive: false })
    this.canvas.addEventListener('dblclick', this.onDblClick)
    this.canvas.addEventListener('contextmenu', this.onContextMenu)
    this.canvas.addEventListener('dragover', this.onDragOver)
    this.canvas.addEventListener('dragleave', this.onDragLeave)
    window.addEventListener('dragend', this.onDragLeave)
    this.canvas.addEventListener('drop', this.onDrop)
    this.edgesSvg.addEventListener('pointerdown', this.onEdgesPointerDown)
    this.edgesSvg.addEventListener('dblclick', this.onEdgesDblClick)
    window.addEventListener('pointermove', this.onPointerMove)
    window.addEventListener('pointerup', this.onPointerUp)
    window.addEventListener('keydown', this.onKeyDown)
    window.addEventListener('keyup', this.onKeyUp)
    window.addEventListener('blur', this.onBlur)
    window.addEventListener('resize', this.onResize)

    this.measureCanvasSize()
    this.applyView()
    this.renderAll(true)
  }

  destroy() {
    this.canvas.removeEventListener('pointerdown', this.onPointerDown)
    this.canvas.removeEventListener('wheel', this.onWheel)
    this.canvas.removeEventListener('dblclick', this.onDblClick)
    this.canvas.removeEventListener('contextmenu', this.onContextMenu)
    this.canvas.removeEventListener('dragover', this.onDragOver)
    this.canvas.removeEventListener('dragleave', this.onDragLeave)
    window.removeEventListener('dragend', this.onDragLeave)
    this.canvas.removeEventListener('drop', this.onDrop)
    this.edgesSvg.removeEventListener('pointerdown', this.onEdgesPointerDown)
    this.edgesSvg.removeEventListener('dblclick', this.onEdgesDblClick)
    window.removeEventListener('pointermove', this.onPointerMove)
    window.removeEventListener('pointerup', this.onPointerUp)
    window.removeEventListener('keydown', this.onKeyDown)
    window.removeEventListener('keyup', this.onKeyUp)
    window.removeEventListener('blur', this.onBlur)
    window.removeEventListener('resize', this.onResize)
    this.store.geom = null
    this.store.canvasApi = null
  }

  /* ── вид ── */

  private measureCanvasSize() {
    const r = this.canvas.getBoundingClientRect()
    this.store.canvasSize = { w: r.width, h: r.height }
  }

  private onResize = () => {
    this.measureCanvasSize()
  }

  private applyView = () => {
    const vp = this.store.getVp()
    this.world.style.transform = `translate(${vp.x}px,${vp.y}px) scale(${vp.z})`
    const s = GRID * vp.z
    this.canvas.style.backgroundSize = `${s}px ${s}px`
    this.canvas.style.backgroundPosition = `${vp.x}px ${vp.y}px`
    const zEl = document.getElementById('zPct')
    if (zEl) zEl.textContent = Math.round(vp.z * 100) + '%'
    this.updateGroupBadges()
  }

  private animateView(x: number, y: number, z: number) {
    this.canvas.classList.add('animv')
    this.world.classList.add('animv')
    this.labels.classList.add('animv')
    this.store.setVp(x, y, z)
    this.applyView()
    if (this.animvTimer) clearTimeout(this.animvTimer)
    this.animvTimer = setTimeout(() => {
      this.canvas.classList.remove('animv')
      this.world.classList.remove('animv')
      this.labels.classList.remove('animv')
    }, 480)
  }

  private toWorld(cx: number, cy: number): Pt {
    const r = this.canvas.getBoundingClientRect()
    const vp = this.store.getVp()
    return { x: (cx - r.left - vp.x) / vp.z, y: (cy - r.top - vp.y) / vp.z }
  }

  fitView(_animate?: boolean) {
    const snap = this.snap
    const r = this.canvas.getBoundingClientRect()
    if (!snap.nodes.length) {
      this.store.setVp(r.width * 0.4, r.height * 0.4, 1)
      this.applyView()
      return
    }
    let x1 = 1e9
    let y1 = 1e9
    let x2 = -1e9
    let y2 = -1e9
    let any = false
    snap.nodes.forEach((n) => {
      if (this.collapsedAncestorOf(n)) return
      const d = this.dimsOf(n)
      any = true
      x1 = Math.min(x1, n.x)
      y1 = Math.min(y1, n.y)
      x2 = Math.max(x2, n.x + d.w)
      y2 = Math.max(y2, n.y + d.h)
    })
    snap.groups.forEach((g) => {
      if (this.groupInsideCollapsed(g)) return
      const rr = this.groupRectWorld(g)
      if (!rr) return
      any = true
      x1 = Math.min(x1, rr.x)
      y1 = Math.min(y1, rr.y)
      x2 = Math.max(x2, rr.x + rr.w)
      y2 = Math.max(y2, rr.y + rr.h)
    })
    void 0
    if (!any) {
      this.store.setVp(r.width * 0.4, r.height * 0.4, 1)
      this.applyView()
      return
    }
    const pad = 90
    const z = clampN(Math.min((r.width - pad * 2) / (x2 - x1), (r.height - pad * 2) / (y2 - y1)), 0.2, 1.15)
    this.animateView((r.width - (x2 - x1) * z) / 2 - x1 * z, (r.height - (y2 - y1) * z) / 2 - y1 * z, z)
  }

  private centerOn(n: VetviNode) {
    const el = this.nodeEls.get(n.id)
    const h = el && el.style.display !== 'none' ? el.offsetHeight : 90
    const w = el && el.style.display !== 'none' ? el.offsetWidth : this.dlgWOf(n)
    const vp = this.store.getVp()
    const r = this.canvas.getBoundingClientRect()
    const z = Math.max(vp.z, 0.8)
    this.animateView(r.width / 2 - (n.x + w / 2) * z, r.height / 2 - (n.y + h / 2) * z, z)
  }

  private centerOnGroup(g: VetviGroup) {
    const el = this.groupEls.get(g.id)
    if (!el) return
    const cx = el.offsetLeft + el.offsetWidth / 2
    const cy = el.offsetTop + el.offsetHeight / 2
    const vp = this.store.getVp()
    const r = this.canvas.getBoundingClientRect()
    this.animateView(r.width / 2 - cx * vp.z, r.height / 2 - cy * vp.z, vp.z)
  }

  /* ── helpers модели ── */

  private nodeById(id: string): VetviNode | null {
    return this.snap.nodes.find((n) => n.id === id) ?? null
  }

  private edgeById(id: string): VetviEdge | null {
    return this.snap.edges.find((e) => e.id === id) ?? null
  }

  private groupById(id: string): VetviGroup | null {
    return this.snap.groups.find((g) => g.id === id) ?? null
  }

  private dlgWOf(n: VetviNode): number {
    if (n.type !== 'dialog') return NODE_W
    const maxD = dlgMaxDepth(n.dialog?.replies ?? [])
    return (n.dlgWidth || NODE_W) + maxD * DLG_REPLY_INDENT
  }

  private dimsOf(n: VetviNode): { w: number; h: number } {
    const el = this.nodeEls.get(n.id)
    const visible = el && el.style.display !== 'none'
    return { w: visible ? el!.offsetWidth : this.dlgWOf(n), h: visible ? el!.offsetHeight : 90 }
  }

  private collapsedAncestorOf(n: VetviNode): VetviGroup | null {
    let g = n.gid ? this.groupById(n.gid) : null
    let guard = 0
    while (g && guard++ < 40) {
      if (g.fold < 2) return g
      g = g.parent ? this.groupById(g.parent) : null
    }
    return null
  }

  private groupInsideCollapsed(g: VetviGroup): boolean {
    let p = g.parent ? this.groupById(g.parent) : null
    let guard = 0
    while (p && guard++ < 40) {
      if (p.fold < 2) return true
      p = p.parent ? this.groupById(p.parent) : null
    }
    return false
  }

  private groupDepth(g: VetviGroup): number {
    let d = 0
    let c: VetviGroup | null = g
    let guard = 0
    while (c && c.parent && guard++ < 40) {
      d++
      c = this.groupById(c.parent)
    }
    return d
  }

  private belongsToGroup(n: VetviNode, gid: string): boolean {
    if (!n.gid) return false
    let g = this.groupById(n.gid)
    let guard = 0
    while (g && guard++ < 40) {
      if (g.id === gid) return true
      g = g.parent ? this.groupById(g.parent) : null
    }
    return false
  }

  private allDescNodes(gid: string, visited = new Set<string>()): VetviNode[] {
    if (visited.has(gid)) return []
    visited.add(gid)
    let out = this.snap.nodes.filter((n) => n.gid === gid)
    this.snap.groups.forEach((cg) => {
      if (cg.parent === gid) out = out.concat(this.allDescNodes(cg.id, visited))
    })
    return out
  }

  private groupRectWorld(g: VetviGroup): { x: number; y: number; w: number; h: number } | null {
    const el = this.groupEls.get(g.id)
    if (g.fold === 2) {
      if (!g.auto && g.fx != null && g.fy != null && g.fw != null && g.fh != null)
        return { x: g.fx, y: g.fy, w: g.fw, h: g.fh }
      if (!el || el.style.display === 'none') return null
      return { x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight }
    }
    if (!el || el.style.display === 'none') return null
    return { x: g.x || 0, y: g.y || 0, w: GCARD_W, h: el.offsetHeight || 44 }
  }

  private deepestGroupAt(wx: number, wy: number): VetviGroup | null {
    let best: VetviGroup | null = null
    let bestDepth = -1
    this.snap.groups.forEach((g) => {
      if (this.groupInsideCollapsed(g)) return
      const r = this.groupRectWorld(g)
      if (!r) return
      if (wx >= r.x && wx <= r.x + r.w && wy >= r.y && wy <= r.y + r.h) {
        const d = this.groupDepth(g)
        if (d > bestDepth) {
          bestDepth = d
          best = g
        }
      }
    })
    return best
  }

  /* ── якоря и геометрия связей ── */

  private memberFrac(g: VetviGroup, n: VetviNode): number | null {
    const hh = (g.hh && g.hh[n.id]) || 90
    if (!g.bbox) return null
    const span = g.bbox[1] - g.bbox[0]
    if (span < 1) return null
    return clampN((n.y + hh / 2 - g.bbox[0]) / span, 0.07, 0.93)
  }

  private spreadFrac(gid: string, edgeId: string, dir: 'out' | 'in'): number {
    const list = this.snap.edges.filter((e) => {
      const nn = dir === 'out' ? this.nodeById(e.from) : this.nodeById(e.to)
      return nn ? this.belongsToGroup(nn, gid) : false
    })
    list.sort((a, b) => (a.id < b.id ? -1 : 1))
    let i = 0
    for (let k = 0; k < list.length; k++) {
      if (list[k].id === edgeId) {
        i = k
        break
      }
    }
    return (i + 1) / (list.length + 1)
  }

  private cardRowPoint(g: VetviGroup, n: VetviNode, side: 'out' | 'in'): Pt | null {
    const cardEl = this.groupEls.get(g.id)
    if (!cardEl || g.fold === 2) return null
    let row = cardEl.querySelector('.gc-row[data-nid="' + n.id + '"]') as HTMLElement | null
    if (!row) {
      let anc = n.gid ? this.groupById(n.gid) : null
      let guard = 0
      while (anc && anc.parent && anc.parent !== g.id && guard++ < 30) {
        anc = this.groupById(anc.parent)
      }
      if (anc && anc.parent === g.id) row = cardEl.querySelector('.gc-row[data-ngid="' + anc.id + '"]') as HTMLElement | null
    }
    if (!row) return null
    const x = side === 'out' ? row.offsetLeft + row.offsetWidth + 2 : row.offsetLeft - 2
    const y = row.offsetTop + row.offsetHeight / 2
    return { x: (g.x || 0) + x, y: (g.y || 0) + y }
  }

  private dlgMainAnchor(n: VetviNode, el: HTMLDivElement | undefined): Pt {
    const w = el ? el.offsetWidth : this.dlgWOf(n)
    const h = el ? el.offsetHeight : 200
    return { x: n.x + w, y: n.y + h - 21 }
  }

  private dlgReplyPortPos(nodeEl: HTMLDivElement, replyId: string): Pt | null {
    const portEl = nodeEl.querySelector('.dlg-reply-pin.out[data-reply-id="' + replyId + '"]') as HTMLElement | null
    if (!portEl) return null
    const nr = nodeEl.getBoundingClientRect()
    const pr = portEl.getBoundingClientRect()
    const vp = this.store.getVp()
    return {
      x: (pr.left + pr.width / 2 - nr.left) / vp.z + (parseFloat(nodeEl.style.left || '0') || 0),
      y: (pr.top + pr.height / 2 - nr.top) / vp.z + (parseFloat(nodeEl.style.top || '0') || 0),
    }
  }

  private dlgCollapsePortPos(nodeEl: HTMLDivElement): Pt | null {
    const pin = nodeEl.querySelector('.dlg-collapse-pin') as HTMLElement | null
    if (!pin) return null
    const nr = nodeEl.getBoundingClientRect()
    const pr = pin.getBoundingClientRect()
    if (pr.width === 0) return null
    const vp = this.store.getVp()
    return {
      x: (pr.left + pr.width / 2 - nr.left) / vp.z + (parseFloat(nodeEl.style.left || '0') || 0),
      y: (pr.top + pr.height / 2 - nr.top) / vp.z + (parseFloat(nodeEl.style.top || '0') || 0),
    }
  }

  private edgeAnchors(e: VetviEdge): { x1: number; y1: number; x2: number; y2: number } | null {
    const na = this.nodeById(e.from)
    const nb = this.nodeById(e.to)
    if (!na || !nb) return null
    if (isBridge(e)) {
      const dA = this.dimsOf(na)
      const dB = this.dimsOf(nb)
      return { x1: na.x + dA.w, y1: na.y + dA.h / 2, x2: nb.x, y2: nb.y + dB.h / 2 }
    }
    const ga = this.collapsedAncestorOf(na)
    const gb = this.collapsedAncestorOf(nb)
    const ca = !!ga
    const cb = !!gb
    if (ca && cb && ga!.id === gb!.id) return null
    let x1 = 0
    let y1 = 0
    let x2 = 0
    let y2 = 0
    if (na.type === 'dialog' && e.fromReply) {
      const nodeElA = this.nodeEls.get(na.id)
      let rp: Pt | null = null
      if (nodeElA) {
        rp = na.expand === 0 ? this.dlgCollapsePortPos(nodeElA) : this.dlgReplyPortPos(nodeElA, e.fromReply!)
      }
      if (rp) {
        x1 = rp.x
        y1 = rp.y
      } else {
        const ma = this.dlgMainAnchor(na, nodeElA ?? undefined)
        x1 = ma.x
        y1 = ma.y
      }
    } else if (ca) {
      const rp1 = this.cardRowPoint(ga!, na, 'out')
      if (rp1) {
        x1 = rp1.x
        y1 = rp1.y
      } else {
        const elA = this.groupEls.get(ga!.id)
        const hA = elA ? elA.offsetHeight : 44
        let fa = this.memberFrac(ga!, na)
        if (fa === null) fa = this.spreadFrac(ga!.id, e.id, 'out')
        x1 = ga!.x + GCARD_W
        y1 = ga!.y + hA * fa
      }
    } else {
      const a = this.nodeEls.get(na.id)
      if (!a) return null
      if (na.type === 'dialog') {
        const mm = this.dlgMainAnchor(na, a)
        x1 = mm.x
        y1 = mm.y
      } else {
        x1 = na.x + a.offsetWidth
        y1 = na.y + a.offsetHeight / 2
      }
    }
    if (cb) {
      const rp2 = this.cardRowPoint(gb!, nb, 'in')
      if (rp2) {
        x2 = rp2.x
        y2 = rp2.y
      } else {
        const elB = this.groupEls.get(gb!.id)
        const hB = elB ? elB.offsetHeight : 44
        let fb = this.memberFrac(gb!, nb)
        if (fb === null) fb = this.spreadFrac(gb!.id, e.id, 'in')
        x2 = gb!.x
        y2 = gb!.y + hB * fb
      }
    } else {
      const b = this.nodeEls.get(nb.id)
      if (!b) return null
      x2 = nb.x
      y2 = nb.y + b.offsetHeight / 2
    }
    return { x1, y1, x2, y2 }
  }

  private edgeGeom(e: VetviEdge): EdgeGeom | null {
    const a = this.edgeAnchors(e)
    if (!a) return null
    if (isBridge(e)) {
      const na = this.nodeById(e.from)!
      const nb = this.nodeById(e.to)!
      const dA = this.dimsOf(na)
      const dB = this.dimsOf(nb)
      const bg = bridgeGeom(e, { x: na.x, y: na.y }, dA.w, dA.h, { x: nb.x, y: nb.y }, dB.w, dB.h)
      return { x1: a.x1, y1: a.y1, x2: a.x2, y2: a.y2, pts: null, bend: 'smooth', corners: bridgeCorners(bg) }
    }
    return { x1: a.x1, y1: a.y1, x2: a.x2, y2: a.y2, pts: e.pts?.length ? e.pts : null, bend: this.snap.bendMode, corners: null }
  }

  private nearestEdgeAt(wx: number, wy: number, maxDistWorld: number, exclude?: Set<string>): string | null {
    let best: string | null = null
    let bd = maxDistWorld
    this.snap.edges.forEach((e) => {
      if (exclude && (exclude.has(e.from) || exclude.has(e.to))) return
      const g = this.edgeGeom(e)
      if (!g) return
      for (let i = 0; i <= 20; i++) {
        const p = edgeSample(g, i / 20)
        const d = Math.hypot(p.x - wx, p.y - wy)
        if (d < bd) {
          bd = d
          best = e.id
        }
      }
    })
    return best
  }

  private edgePolyline(e: VetviEdge, n: number): Pt[] | null {
    const g = this.edgeGeom(e)
    if (!g) return null
    const P: Pt[] = []
    for (let i = 0; i <= n; i++) P.push(edgeSample(g, i / n))
    return P
  }

  /* ── рендер: мир ── */

  renderAll(initial = false) {
    if (initial) this.applyView()
    this.renderGroups()
    this.renderWorld()
    this.updateDlgRowStates()
    this.renderEdges()
    this.refreshGroupFrames()
    this.updateGroupBadges()
    this.syncSel()
    const empty = this.snap.nodes.length === 0
    const hint = document.getElementById('emptyHint')
    if (hint) hint.classList.toggle('show', empty)
  }

  private static nodeSig(n: VetviNode, store: VetviStore): string {
    const dlg = n.dialog
    const dlgSig = dlg
      ? 'd' + dlg.participants.join(',') + '|' + dlg.description + '|' + dlgSigReplies(dlg.replies)
      : ''
    return [
      n.type,
      n.gid,
      n.x,
      n.y,
      n.title,
      n.text,
      n.status,
      (n.tags ?? []).join(','),
      n.expand,
      n.color,
      n.tint,
      n.dlgWidth,
      (n.notes ?? []).map((m) => (m.hidden ? '0' : '1') + m.title).join('|'),
      dlgSig,
      store.typeInfo(n.type).icon,
    ].join('\u0001')
  }

  private renderWorld() {
    const snap = this.snap
    const world = this.world
    const existing = new Set<string>()
    snap.nodes.forEach((n) => {
      existing.add(n.id)
      const sig = VetviCanvasController.nodeSig(n, this.store)
      let el = this.nodeEls.get(n.id)
      if (!el) {
        el = document.createElement('div')
        el.dataset.id = n.id
        el.className = 'node'
        el.addEventListener('animationend', () => el!.classList.remove('spawn'), { once: true })
        world.appendChild(el)
        this.nodeEls.set(n.id, el)
        this.nodeSigs.set(n.id, '')
      }
      if (this.nodeSigs.get(n.id) !== sig) {
        this.nodeSigs.set(n.id, sig)
        this.buildNodeInner(el, n)
      }
      // Позиция/классы — каждый кадр (дёшево).
      el.style.left = n.x + 'px'
      el.style.top = n.y + 'px'
      el.style.width = (n.type === 'dialog' ? this.dlgWOf(n) : NODE_W) + 'px'
      const collapsed = this.collapsedAncestorOf(n)
      el.style.display = collapsed ? 'none' : ''
    })
    // Удалённые.
    this.nodeEls.forEach((el, id) => {
      if (!existing.has(id)) {
        el.remove()
        this.nodeEls.delete(id)
        this.nodeSigs.delete(id)
      }
    })
  }

  private buildNodeInner(el: HTMLDivElement, n: VetviNode) {
    const vis = this.store.typeInfo(n.type)
    const ex = n.expand
    const baseC = vis.color
    el.className = 'node t-' + n.type + ' st-' + n.status + ' ex-' + ex
    el.style.setProperty('--c', baseC)
    if (n.color) {
      const ap = nodePaint(n.color, n.tint)
      el.style.background = 'linear-gradient(' + shadeHex(ap, 10) + ',' + shadeHex(ap, -8) + ')'
      el.style.borderColor = shadeHex(ap, -30)
    } else {
      el.style.background = ''
      el.style.borderColor = ''
    }
    el.innerHTML =
      '<div class="n-head">' +
      '<span class="n-ico">' + ic(vis.icon) + '</span>' +
      '<span class="n-title"></span>' +
      (n.type === 'dialog' ? '<span class="n-reply-cnt"></span>' : '') +
      '<span class="n-st st-' + n.status + '" title="' + STATUS[n.status] + '"></span>' +
      '<button class="n-fold" title="' + FOLD_TITLES[ex] + '">' + ic(FOLD_ICONS[ex], 12) + '</button>' +
      '</div>' +
      '<div class="n-body"><div class="n-text"></div><div class="n-tags"></div></div>' +
      '<i class="port pin" title="вход — потяните, чтобы перенести входящие стрелки"></i>' +
      '<i class="port pout" title="' +
      (n.type === 'dialog'
        ? 'выход диалога (правая грань, внизу) · Ctrl+тянуть — перенести исходящие'
        : 'выход — тяните к другому узлу · Ctrl+тянуть — отсоединить и перенести исходящие стрелки') +
      '"></i>'

    const titleEl = el.querySelector('.n-title') as HTMLElement
    titleEl.textContent = n.title
    if (n.type === 'dialog') {
      const cntEl = el.querySelector('.n-reply-cnt')
      if (cntEl) cntEl.textContent = countReplies(n.dialog?.replies ?? []) + ' репл.'
    }

    this.setNodeText(el, n)
    this.setNodeTags(el, n)

    if (n.type === 'dialog') {
      const body = el.querySelector('.n-body') as HTMLElement
      const col = document.createElement('div')
      col.className = 'dlg-collapse-out'
      col.innerHTML = '<span class="t">Исходы реплик</span><i class="dlg-collapse-pin"></i>'
      body.appendChild(col)
      const tree = document.createElement('div')
      tree.className = 'dlg-tree'
      tree.innerHTML = this.dlgTreeInner(n)
      body.appendChild(tree)
    }

    this.renderNodeNotes(n, el)
  }

  private setNodeText(el: HTMLDivElement, n: VetviNode) {
    const t = el.querySelector('.n-text') as HTMLElement
    if (n.type === 'dialog') {
      t.textContent = n.dialog?.description || 'Описание не задано'
      t.classList.toggle('empty', !n.dialog?.description)
    } else {
      t.textContent = n.text || 'без описания'
      t.classList.toggle('empty', !n.text)
    }
  }

  private setNodeTags(el: HTMLDivElement, n: VetviNode) {
    const w = el.querySelector('.n-tags') as HTMLElement
    w.innerHTML = (n.tags ?? []).map((t) => '<span>' + esc(t) + '</span>').join('')
    w.style.display = n.tags && n.tags.length ? '' : 'none'
  }

  private dlgTreeInner(n: VetviNode): string {
    const d = n.dialog
    if (!d) return ''
    let html = ''
    if (d.participants.length) {
      html += '<div class="dlg-participants">'
      d.participants.forEach((pid) => {
        const name = this.charName(pid)
        const color = this.charColor(pid)
        html += '<span class="dlg-participant" style="background:' + hexToRgba(color, 0.18) + ';color:' + color + '">' + esc(name) + '</span>'
      })
      html += '</div>'
    }
    if (d.replies.length) {
      html += '<div class="dlg-replies">' + this.dlgRenderReplies(d.replies, 0) + '</div>'
    } else {
      html += '<div class="dlg-empty">Нет реплик — откройте инспектор</div>'
    }
    return html
  }

  private dlgRenderReplies(replies: { id: string; speaker: string | null; text: string; children?: { id: string; speaker: string | null; text: string; children?: unknown[] }[] }[], depth: number): string {
    if (depth >= MAX_DLG_DEPTH || !replies.length) return ''
    let html = ''
    replies.forEach((r) => {
      const speakerName = r.speaker ? this.charName(r.speaker) : '?'
      const speakerColor = r.speaker ? this.charColor(r.speaker) : '#8b929c'
      html += '<div class="dlg-item">'
      html += '<div class="dlg-reply-row" data-reply-id="' + esc(r.id) + '">'
      html += '<span class="dot" style="background:' + esc(speakerColor) + ';color:' + esc(speakerColor) + '"></span>'
      html += '<span class="t"><span class="speaker" style="color:' + esc(speakerColor) + '">' + esc(speakerName) + ':</span>' + esc(r.text || '') + '</span>'
      html += '<i class="dlg-reply-pin out" data-reply-id="' + esc(r.id) + '" title="Выход из реплики — тяните к элементу"></i>'
      html += '</div>'
      if (r.children && r.children.length) {
        html += '<div class="dlg-children">' + this.dlgRenderReplies(r.children as typeof replies, depth + 1) + '</div>'
      }
      html += '</div>'
    })
    return html
  }

  private charName(id: string | null): string {
    const c = id ? this.nodeById(id) : null
    return c ? c.title : '(неизвестный)'
  }

  private charColor(id: string | null): string {
    const c = id ? this.nodeById(id) : null
    if (!c) return '#8b929c'
    return c.color ? c.color : this.store.typeInfo(c.type).color
  }

  private renderNodeNotes(n: VetviNode, el: HTMLDivElement) {
    const old = el.querySelector('.node-notes')
    if (old) old.remove()
    const vis = (n.notes ?? []).filter((x) => !x.hidden)
    if (!vis.length) return
    const box = document.createElement('div')
    box.className = 'node-notes'
    vis.forEach((note) => {
      const b = document.createElement('button')
      b.className = 'node-note-ico'
      b.title = note.title || 'Заметка'
      b.innerHTML = noteIconSvg(18)
      b.addEventListener('click', (ev) => {
        ev.stopPropagation()
        const idx = (n.notes ?? []).indexOf(note)
        this.store.openNoteView(n.id, idx)
      })
      box.appendChild(b)
    })
    el.appendChild(box)
  }

  private updateDlgRowStates() {
    this.snap.nodes.forEach((n) => {
      if (n.type !== 'dialog') return
      const el = this.nodeEls.get(n.id)
      if (!el) return
      const outs = new Set<string>()
      let any = false
      this.snap.edges.forEach((e) => {
        if (e.from === n.id && e.fromReply) {
          outs.add(e.fromReply)
          any = true
        }
      })
      const col = el.querySelector('.dlg-collapse-out')
      if (col) col.classList.toggle('has-any', any)
      const rows = el.querySelectorAll('.dlg-reply-row')
      rows.forEach((row) => {
        const has = outs.has(row.getAttribute('data-reply-id') ?? '')
        row.classList.toggle('has-out', has)
        const pin = row.querySelector('.dlg-reply-pin.out')
        if (pin) pin.classList.toggle('live', has)
      })
      this.layoutDlgConnectors(el)
    })
  }

  private layoutDlgConnectors(el: HTMLDivElement) {
    const chs = el.querySelectorAll('.dlg-children')
    chs.forEach((ch) => {
      const items = ch.children
      if (!items.length) return
      const last = items[items.length - 1] as HTMLElement
      if (!last.classList || !last.classList.contains('dlg-item')) return
      const row = last.querySelector('.dlg-reply-row') as HTMLElement | null
      if (!row) return
      const rowH = row.offsetHeight
      const topOff = last.previousElementSibling === null ? 7 : 3
      last.style.setProperty('--lk', 2 + rowH / 2 + topOff + 'px')
    })
  }

  private setRowSrcSel(e: VetviEdge) {
    if (!e.fromReply) return
    const ne = this.nodeEls.get(e.from)
    if (!ne) return
    const row = ne.querySelector('.dlg-reply-row[data-reply-id="' + e.fromReply + '"]')
    if (row) row.classList.toggle('src-sel', this.snap.selEdges.includes(e.id))
  }

  private setRowSrcHl(e: VetviEdge, on: boolean) {
    if (!e.fromReply) return
    const ne = this.nodeEls.get(e.from)
    if (!ne) return
    const row = ne.querySelector('.dlg-reply-row[data-reply-id="' + e.fromReply + '"]')
    if (row) row.classList.toggle('src-hl', on)
  }

  /* ── рендер: группы ── */

  private static groupSig(g: VetviGroup, ctrl: VetviCanvasController): string {
    const members = ctrl.allDescNodes(g.id).map((n) => n.id).join(',')
    return [g.name, g.fold, g.x, g.y, g.parent, g.color, g.alpha, g.badge, g.auto, g.fx, g.fy, g.fw, g.fh, members].join('\u0001')
  }

  private renderGroups() {
    const snap = this.snap
    const existing = new Set<string>()
    const sorted = [...snap.groups].sort((a, b) => this.groupDepth(a) - this.groupDepth(b))
    sorted.forEach((g) => {
      existing.add(g.id)
      const sig = VetviCanvasController.groupSig(g, this)
      let el = this.groupEls.get(g.id)
      const wantBox = g.fold === 2
      if (el && el.classList.contains('gcard') === wantBox) {
        // Неверный тип элемента — пересоздаём.
        el.remove()
        this.groupEls.delete(g.id)
        el = undefined
      }
      if (!el) {
        el = document.createElement('div')
        el.dataset.gid = g.id
        if (wantBox) {
          el.className = 'groupbox'
          this.framesLayer.appendChild(el)
        } else {
          el.className = 'gcard'
          this.world.appendChild(el)
        }
        this.groupEls.set(g.id, el)
        this.groupSigs.set(g.id, '')
      }
      if (this.groupSigs.get(g.id) !== sig) {
        this.groupSigs.set(g.id, sig)
        this.buildGroupInner(el, g)
      }
      if (wantBox) {
        const fr = this.frameRectOf(g)
        if (fr && !this.groupInsideCollapsed(g) && this.allDescNodes(g.id).length) {
          el.style.display = ''
          el.style.left = fr.x + 'px'
          el.style.top = fr.y + 'px'
          el.style.width = fr.w + 'px'
          el.style.height = fr.h + 'px'
        } else {
          el.style.display = 'none'
        }
      } else {
        el.style.left = (g.x || 0) + 'px'
        el.style.top = (g.y || 0) + 'px'
        el.style.display = !this.allDescNodes(g.id).length || this.groupInsideCollapsed(g) ? 'none' : ''
      }
      this.applyGroupStyle(g, el)
    })
    this.groupEls.forEach((el, id) => {
      if (!existing.has(id)) {
        el.remove()
        this.groupEls.delete(id)
        this.groupSigs.delete(id)
      }
    })
  }

  private buildGroupInner(el: HTMLDivElement, g: VetviGroup) {
    const ms = this.allDescNodes(g.id)
    const gcolor = g.color || '#9aa1ac'
    if (g.fold === 2) {
      el.innerHTML =
        '<div class="gb-head"><span class="gb-name">' + esc(g.name) + '</span><span class="gb-cnt">' + ms.length + '</span>' +
        '<button class="gb-fold" title="Свернуть группу">' + ic('chevUp', 11) + '</button></div>' +
        '<i class="gb-grip gr-r" data-gr="r" title="Изменить ширину"></i>' +
        '<i class="gb-grip gr-b" data-gr="b" title="Изменить высоту"></i>' +
        '<i class="gb-grip gr-br" data-gr="br" title="Изменить размер"></i>'
    } else {
      const btnIco = g.fold === 1 ? ic('chev', 11) : ic('expand', 11)
      const btnTitle = g.fold === 1 ? 'Сжать до компакта' : 'Развернуть группу'
      const direct = this.snap.nodes.filter((n) => n.gid === g.id)
      const childGroups = this.snap.groups.filter((cg) => cg.parent === g.id)
      let rows = direct
        .map((n) => {
          const v = this.store.typeInfo(n.type)
          const c = n.color ? n.color : v.color
          return (
            '<div class="gc-row" data-nid="' + n.id + '">' +
            '<i class="gc-pin in" style="border-color:' + esc(c) + '"></i>' +
            '<span class="dot" style="background:' + esc(c) + ';color:' + esc(c) + '"></span>' +
            '<span class="t">' + esc(n.title) + '</span>' +
            '<i class="gc-pin out" style="border-color:' + esc(c) + '"></i></div>'
          )
        })
        .join('')
      childGroups.forEach((cg) => {
        const c = cg.color || '#9aa1ac'
        rows +=
          '<div class="gc-row sub" data-ngid="' + cg.id + '">' +
          '<i class="gc-pin in" style="border-color:' + esc(c) + '"></i>' +
          '<span class="dot" style="background:' + esc(c) + ';color:' + esc(c) + '"></span>' +
          '<span class="t">' + esc(cg.name) + ' · ' + this.allDescNodes(cg.id).length + '</span>' +
          '<i class="gc-pin out" style="border-color:' + esc(c) + '"></i></div>'
      })
      el.innerHTML =
        '<div class="gb-head">' +
        '<span class="gb-name">' + esc(g.name) + '</span>' +
        '<span class="gb-cnt">' + ms.length + '</span>' +
        '<button class="gb-fold" title="' + btnTitle + '">' + btnIco + '</button>' +
        '</div>' +
        (g.fold === 1 ? '<div class="gb-list">' + rows + '</div>' : '')
    }
    void gcolor
  }

  private applyGroupStyle(g: VetviGroup, el: HTMLElement) {
    const a = clampN(typeof g.alpha === 'number' ? g.alpha : 0.55, 0.1, 1)
    const c = g.color || '#9aa1ac'
    el.style.setProperty('--gbcol', hexToRgba(c, Math.min(1, a + 0.15)))
    el.style.setProperty('--gbhov', hexToRgba(c, Math.min(1, a + 0.3)))
    el.style.setProperty('--gbfill', hexToRgba(c, a * 0.13))
  }

  private groupBounds(gid: string, visited = new Set<string>()): { minX: number; minY: number; maxX: number; maxY: number } | null {
    if (visited.has(gid)) return null
    visited.add(gid)
    const g = this.groupById(gid)
    if (!g) return null
    if (g.fold < 2) {
      const cel = this.groupEls.get(gid)
      const ch = cel ? cel.offsetHeight : 44
      return { minX: g.x || 0, minY: g.y || 0, maxX: (g.x || 0) + GCARD_W, maxY: (g.y || 0) + ch }
    }
    if (!g.auto && g.fx != null && g.fy != null && g.fw != null && g.fh != null) {
      return { minX: g.fx, minY: g.fy, maxX: g.fx + g.fw, maxY: g.fy + g.fh }
    }
    let minX = 1e9
    let minY = 1e9
    let maxX = -1e9
    let maxY = -1e9
    let found = false
    this.snap.nodes
      .filter((n) => n.gid === gid)
      .forEach((n) => {
        const d = this.dimsOf(n)
        found = true
        minX = Math.min(minX, n.x)
        minY = Math.min(minY, n.y)
        maxX = Math.max(maxX, n.x + d.w)
        maxY = Math.max(maxY, n.y + d.h)
      })
    this.snap.edges.forEach((e) => {
      if (!e.pts || !e.pts.length) return
      const nf = this.nodeById(e.from)
      const nt = this.nodeById(e.to)
      if (nf && nt && this.belongsToGroup(nf, gid) && this.belongsToGroup(nt, gid)) {
        e.pts.forEach((p) => {
          minX = Math.min(minX, p.x)
          minY = Math.min(minY, p.y)
          maxX = Math.max(maxX, p.x)
          maxY = Math.max(maxY, p.y)
        })
      }
    })
    this.snap.groups.forEach((cg) => {
      if (cg.parent !== gid) return
      const b = this.groupBounds(cg.id, visited)
      if (!b) return
      found = true
      minX = Math.min(minX, b.minX - 10)
      minY = Math.min(minY, b.minY - 8)
      maxX = Math.max(maxX, b.maxX + 10)
      maxY = Math.max(maxY, b.maxY + 10)
    })
    if (!found) return null
    return { minX, minY, maxX, maxY }
  }

  private frameRectOf(g: VetviGroup): { x: number; y: number; w: number; h: number } | null {
    if (!g.auto && g.fx != null && g.fy != null && g.fw != null && g.fh != null)
      return { x: g.fx, y: g.fy, w: g.fw, h: g.fh }
    const b = this.groupBounds(g.id)
    if (!b) return null
    const pad = 14
    const head = 26
    return { x: b.minX - pad, y: b.minY - pad - head, w: b.maxX - b.minX + pad * 2, h: b.maxY - b.minY + pad * 2 + head }
  }

  private refreshGroupFrames() {
    const byDepth = [...this.snap.groups].sort((a, b) => this.groupDepth(b) - this.groupDepth(a))
    byDepth.forEach((g) => {
      if (g.fold < 2) return
      if (!g.auto && g.fx != null && g.fw != null && g.fh != null && g.fy != null) {
        let fx: number = g.fx
        let fy: number = g.fy
        let fw: number = g.fw
        let fh: number = g.fh
        this.snap.groups.forEach((cg) => {
          if (cg.parent !== g.id) return
          const cr = this.frameRectOf(cg)
          if (!cr) return
          const mSide = 10
          const mTop = 30
          const mBot = 10
          if (cr.x - mSide < fx) fx = cr.x - mSide
          if (cr.y - mTop < fy) fy = cr.y - mTop
          if (cr.x + cr.w + mSide > fx + fw) fw = cr.x + cr.w + mSide - fx
          if (cr.y + cr.h + mBot > fy + fh) fh = cr.y + cr.h + mBot - fy
        })
        g.fx = fx
        g.fy = fy
        g.fw = fw
        g.fh = fh
      }
    })
    this.snap.groups.forEach((g) => {
      if (g.fold < 2) return
      const el = this.groupEls.get(g.id)
      if (!el) return
      if (this.groupInsideCollapsed(g)) {
        el.style.display = 'none'
        return
      }
      const fr = this.frameRectOf(g)
      if (!fr) {
        el.style.display = 'none'
        return
      }
      el.style.display = ''
      el.style.left = fr.x + 'px'
      el.style.top = fr.y + 'px'
      el.style.width = fr.w + 'px'
      el.style.height = fr.h + 'px'
    })
    this.updateGroupBadges()
  }

  private updateGroupBadges() {
    const layer = this.labels
    if (!layer) return
    layer.innerHTML = ''
    const vp = this.store.getVp()
    this.snap.groups.forEach((g) => {
      if (!g.badge) return
      const el = this.groupEls.get(g.id)
      if (!el || el.style.display === 'none') return
      const sx = vp.x + (el.offsetLeft + el.offsetWidth / 2) * vp.z
      const sy = vp.y + el.offsetTop * vp.z - 8
      const chip = document.createElement('div')
      chip.className = 'gbadge'
      chip.style.left = sx + 'px'
      chip.style.top = sy + 'px'
      chip.style.borderColor = hexToRgba(g.color || '#9aa1ac', 0.85)
      chip.style.color = g.color || '#9aa1ac'
      chip.textContent = g.name
      layer.appendChild(chip)
    })
  }

  /* ── рендер: связи ── */

  private static edgeSig(e: VetviEdge, ctrl: VetviCanvasController): string {
    return [
      e.from,
      e.to,
      e.kind,
      e.label,
      e.fromReply,
      JSON.stringify(e.pts),
      e.lt,
      e.lp,
      JSON.stringify(e.bd),
      ctrl.snap.bendMode,
      ctrl.snap.selEdges.includes(e.id),
      ctrl.endCollapsed(e, 'from'),
      ctrl.endCollapsed(e, 'to'),
    ].join('\u0001')
  }

  private endCollapsed(e: VetviEdge, side: 'from' | 'to'): boolean {
    const id = side === 'from' ? e.from : e.to
    const n = this.nodeById(id)
    return n ? !!this.collapsedAncestorOf(n) : false
  }

  private renderEdges() {
    const snap = this.snap
    const existing = new Set<string>()
    snap.edges.forEach((e) => {
      existing.add(e.id)
      const sig = VetviCanvasController.edgeSig(e, this)
      let r = this.edgeEls.get(e.id)
      if (!r) {
        const g = svgEl('g') as SVGGElement
        g.dataset.id = e.id
        const hit = svgEl('path') as SVGPathElement
        hit.setAttribute('class', 'hit')
        const line = svgEl('path') as SVGPathElement
        line.setAttribute('class', 'line')
        const labelHit = svgEl('text') as SVGTextElement
        labelHit.setAttribute('class', 'elabel-hit')
        const label = svgEl('text') as SVGTextElement
        label.setAttribute('class', 'elabel')
        const epFrom = svgEl('circle') as SVGCircleElement
        epFrom.setAttribute('class', 'ep-h')
        epFrom.setAttribute('r', '6')
        epFrom.dataset.ep = 'from'
        const epTo = svgEl('circle') as SVGCircleElement
        epTo.setAttribute('class', 'ep-h')
        epTo.setAttribute('r', '6')
        epTo.dataset.ep = 'to'
        g.appendChild(hit)
        g.appendChild(line)
        g.appendChild(epFrom)
        g.appendChild(epTo)
        g.appendChild(labelHit)
        g.appendChild(label)
        this.edgesSvg.appendChild(g)
        r = { g, line, hit, label, labelHit, wps: [], epFrom, epTo }
        this.edgeEls.set(e.id, r)
        this.edgeSigs.set(e.id, '')
        g.addEventListener('mouseenter', () => this.setRowSrcHl(e, true))
        g.addEventListener('mouseleave', () => this.setRowSrcHl(e, false))
      }
      const cls =
        'edge kind-' + (e.kind || 'flow') + (isBridge(e) ? ' bridge' : '') + (snap.selEdges.includes(e.id) ? ' sel' : '')
      if (r.g.getAttribute('class') !== cls) r.g.setAttribute('class', cls)
      if (this.edgeSigs.get(e.id) !== sig) {
        this.edgeSigs.set(e.id, sig)
      }
      this.updateEdgeGeom(e)
    })
    this.edgeEls.forEach((r, id) => {
      if (!existing.has(id)) {
        r.g.remove()
        this.edgeEls.delete(id)
        this.edgeSigs.delete(id)
      }
    })
  }

  private updateEdgeGeom(e: VetviEdge) {
    const r = this.edgeEls.get(e.id)
    if (!r) return
    const g = this.edgeGeom(e)
    if (!g) {
      r.g.style.display = 'none'
      return
    }
    r.g.style.display = ''
    const d = edgePathD(g)
    r.line.setAttribute('d', d)
    r.hit.setAttribute('d', d)
    const pts = isBridge(e) ? [] : g.pts || []
    while (r.wps.length < pts.length) {
      const c = svgEl('circle') as SVGCircleElement
      c.setAttribute('class', 'wp')
      c.setAttribute('r', '5')
      r.g.insertBefore(c, r.labelHit)
      r.wps.push(c)
    }
    while (r.wps.length > pts.length) {
      const rm = r.wps.pop()
      rm?.remove()
    }
    pts.forEach((p, i) => {
      r!.wps[i].setAttribute('cx', String(Math.round(p.x)))
      r!.wps[i].setAttribute('cy', String(Math.round(p.y)))
      r!.wps[i].dataset.i = String(i)
    })
    const showFrom = !this.endCollapsed(e, 'from')
    const showTo = !this.endCollapsed(e, 'to')
    r.epFrom.style.display = showFrom ? '' : 'none'
    r.epTo.style.display = showTo ? '' : 'none'
    r.epFrom.setAttribute('cx', String(g.x1))
    r.epFrom.setAttribute('cy', String(g.y1))
    r.epTo.setAttribute('cx', String(g.x2))
    r.epTo.setAttribute('cy', String(g.y2))
    const lp = labelPos(e, g)
    r.label.setAttribute('x', String(lp.x))
    r.label.setAttribute('y', String(lp.y - 6))
    r.label.textContent = e.label || ''
    r.label.style.display = e.label ? '' : 'none'
    r.labelHit.setAttribute('x', String(lp.x))
    r.labelHit.setAttribute('y', String(lp.y - 6))
    r.labelHit.textContent = e.label || ''
    r.labelHit.style.display = e.label ? '' : 'none'
    this.setRowSrcSel(e)
  }

  private updateEdgesFor(id: string) {
    this.snap.edges.forEach((e) => {
      if (e.from === id || e.to === id) this.updateEdgeGeom(e)
    })
  }

  private updateGroupEdges(gid: string) {
    const ids = new Set(this.allDescNodes(gid).map((n) => n.id))
    this.snap.edges.forEach((e) => {
      if (ids.has(e.from) || ids.has(e.to)) this.updateEdgeGeom(e)
    })
  }

  private syncSel() {
    const selSet = new Set(this.snap.sel)
    this.nodeEls.forEach((el, id) => el.classList.toggle('sel', selSet.has(id)))
    const selE = new Set(this.snap.selEdges)
    this.edgeEls.forEach((r, id) => {
      r.g.classList.toggle('sel', selE.has(id))
    })
    const selG = new Set(this.snap.selGroups)
    this.groupEls.forEach((el, gid) => el.classList.toggle('sel', selG.has(gid)))
    this.snap.edges.forEach((e) => this.setRowSrcSel(e))
    document.querySelectorAll('#palList .cv-card').forEach((el) => {
      el.classList.toggle('sel', selSet.has((el as HTMLElement).dataset.node ?? ''))
    })
    document.querySelectorAll('#nodeList .nli[data-id]').forEach((el) => {
      el.classList.toggle('sel', selSet.has((el as HTMLElement).dataset.id ?? ''))
    })
    document.querySelectorAll('#nodeList .nli[data-gid]').forEach((el) => {
      el.classList.toggle('sel', selG.has((el as HTMLElement).dataset.gid ?? ''))
    })
  }

  private flashNode(id: string) {
    const el = this.nodeEls.get(id)
    if (el) {
      el.classList.add('spawn')
      setTimeout(() => el.classList.remove('spawn'), 600)
    }
  }

  private flashEdge(id: string) {
    const r = this.edgeEls.get(id)
    if (r) {
      r.g.classList.add('spawn')
      r.line.setAttribute('pathLength', '1')
      setTimeout(() => {
        r.g.classList.remove('spawn')
        r.line.removeAttribute('pathLength')
      }, 650)
    }
  }

  /* ── выделение (drag для мультипереноса) ── */

  /* ── обработчики ── */

  private onKeyDown = (e: KeyboardEvent) => {
    if (e.code === 'Space' && !isTyping()) {
      this.spaceDown = true
      document.body.classList.add('space')
    }
    if (e.key === 'Alt' && !isTyping()) document.body.classList.add('knife')
  }

  private onKeyUp = (e: KeyboardEvent) => {
    if (e.code === 'Space') {
      this.spaceDown = false
      document.body.classList.remove('space')
    }
    if (e.key === 'Alt') document.body.classList.remove('knife')
  }

  private onBlur = () => {
    document.body.classList.remove('knife')
    this.spaceDown = false
    document.body.classList.remove('space')
  }

  private elpp(elp: Element | null): HTMLElement | null {
    if (!elp || !elp.closest) return null
    const n = elp.closest('.node') as HTMLElement | null
    if (n && n.style.display !== 'none') return n
    return null
  }

  private setDropEdge(id: string | null) {
    if (this.dropEdgeId === id) return
    if (this.dropEdgeId) {
      const r = this.edgeEls.get(this.dropEdgeId)
      if (r) r.g.classList.remove('drop-target')
    }
    this.dropEdgeId = id
    if (id) {
      const r = this.edgeEls.get(id)
      if (r) r.g.classList.add('drop-target')
    }
  }

  private onPointerDown = (e: PointerEvent) => {
    this.store.closeCtxMenu()
    const g = this.gesture
    if (g?.kind === 'carry') {
      if (e.button === 0) {
        this.placeCarry()
        return
      }
      if (e.button !== 1) {
        this.cancelCarry()
        return
      }
    }
    if (e.button === 2) return
    const target = e.target as HTMLElement
    if (target.closest && target.closest('.n-title-inp')) return
    const modK = e.ctrlKey || e.metaKey
    if (e.button === 0 && modK && !e.altKey && !this.spaceDown && !(target.closest && (target.closest('.port') || target.closest('.dlg-reply-pin')))) {
      this.gesture = { kind: 'gcreate', sx: e.clientX, sy: e.clientY }
      const cr0 = this.canvas.getBoundingClientRect()
      this.marquee.classList.add('mg')
      this.marquee.style.display = 'block'
      this.marquee.style.left = e.clientX - cr0.left + 'px'
      this.marquee.style.top = e.clientY - cr0.top + 'px'
      this.marquee.style.width = '0px'
      this.marquee.style.height = '0px'
      e.preventDefault()
      return
    }

    if (e.button === 0) {
      const replyPort = target.closest ? (target.closest('.dlg-reply-pin.out') as HTMLElement | null) : null
      if (replyPort) {
        if (modK) this.startReplyOutDrag(e, replyPort)
        else this.startReplyConnect(e, replyPort)
        return
      }
      const port = target.closest ? (target.closest('.port') as HTMLElement | null) : null
      const fold = target.closest ? target.closest('.n-fold') : null
      const nodeEl = target.closest ? (target.closest('.node') as HTMLDivElement | null) : null
      if (port && port.classList.contains('pin') && nodeEl) {
        this.startPinDrag(e, nodeEl)
        return
      }
      if (port && port.classList.contains('pout') && nodeEl) {
        if (modK) this.startOutDrag(e, nodeEl)
        else this.startConnect(e, nodeEl)
        return
      }
      if (port) return
      if (fold && nodeEl) {
        this.store.cycleExpand(nodeEl.dataset.id!)
        e.stopPropagation()
        return
      }
      if (nodeEl) {
        if (this.spaceDown) return
        const id = nodeEl.dataset.id!
        const nN = this.nodeById(id)
        if (nN && nN.type === 'dialog' && !e.altKey) {
          const wp0 = this.toWorld(e.clientX, e.clientY)
          if (this.dlgResizeBandHit(nN, nodeEl, wp0.x, wp0.y)) {
            e.preventDefault()
            if (!this.snap.sel.includes(id)) this.store.selectOnly(id)
            this.gesture = { kind: 'dlgResize', nid: id, sx: e.clientX, origWidth: nN.dlgWidth || NODE_W, moved: false }
            return
          }
        }
        e.preventDefault()
        const isExtract = e.altKey
        if (isExtract) {
          this.store.selectOnly(id)
          this.store.detachNode(id)
          const nn = this.nodeById(id)
          const start = new Map<string, Pt>()
          if (nn) start.set(id, { x: nn.x, y: nn.y })
          this.gesture = { kind: 'drag', sx: e.clientX, sy: e.clientY, moved: false, extract: true, dropEdge: null, hoverG: null, start, ptBase: new Map() }
          return
        }
        if (e.shiftKey) {
          this.store.toggleNodeInSel(id)
        } else if (!this.snap.sel.includes(id)) {
          this.store.selectOnly(id)
        }
        const start = new Map<string, Pt>()
        this.snap.sel.forEach((sid) => {
          const n = this.nodeById(sid)
          if (n) start.set(sid, { x: n.x, y: n.y })
        })
        this.gesture = { kind: 'drag', sx: e.clientX, sy: e.clientY, moved: false, extract: false, dropEdge: null, hoverG: null, start, ptBase: new Map() }
        return
      }

      const grip = target.closest ? (target.closest('.gb-grip') as HTMLElement | null) : null
      if (grip) {
        const contG = grip.closest('.groupbox') as HTMLElement | null
        const gg = contG ? this.groupById(contG.dataset.gid!) : null
        if (gg) {
          e.stopPropagation()
          e.preventDefault()
          this.store.selectGroup(gg.id)
          const r0 = this.frameRectOf(gg)
          if (r0) {
            if (gg.auto) this.store.toggleGroupAuto(gg.id)
            this.gesture = { kind: 'grestore', gid: gg.id, mode: grip.dataset.gr!, sx: e.clientX, sy: e.clientY, r0, moved: false }
          }
        }
        return
      }
      const gfold = target.closest ? (target.closest('.gb-fold') as HTMLElement | null) : null
      if (gfold) {
        const cont = gfold.closest('.gcard,.groupbox') as HTMLElement | null
        if (cont) this.store.cycleGroupFold(cont.dataset.gid!)
        e.stopPropagation()
        return
      }
    }

    const gbox = target.closest ? (target.closest('.groupbox,.gcard') as HTMLElement | null) : null
    if (gbox && e.button === 0 && !e.altKey) {
      if (this.spaceDown) return
      const gid = gbox.dataset.gid!
      const isCard = gbox.classList.contains('gcard')
      const onHead = target.closest && target.closest('.gb-head')
      let okGrab = isCard || !!onHead
      if (!okGrab) {
        const gg = this.groupById(gid)
        const gRect = gg ? this.groupRectWorld(gg) : null
        if (gg && gRect) {
          const wpt = this.toWorld(e.clientX, e.clientY)
          const strip = 12
          const inX = wpt.x >= gRect.x && wpt.x <= gRect.x + gRect.w
          const inY = wpt.y >= gRect.y && wpt.y <= gRect.y + gRect.h
          okGrab =
            inX &&
            inY &&
            (wpt.x < gRect.x + strip || wpt.x > gRect.x + gRect.w - strip || wpt.y < gRect.y + strip || wpt.y > gRect.y + gRect.h - strip)
        }
      }
      if (okGrab) {
        e.preventDefault()
        if (e.shiftKey) {
          this.store.toggleGroupInSel(gid)
        } else {
          this.store.selectGroup(gid)
        }
        const g = this.groupById(gid)
        if (!g) return
        document.body.classList.add('panning')
        const excl = new Set([gid, ...this.descGroupIds(gid)])
        const start = new Map<string, Pt>()
        this.allDescNodes(gid).forEach((n) => start.set(n.id, { x: n.x, y: n.y }))
        const cards = new Map<string, Pt>()
        const frames = new Map<string, Pt>()
        if (g.fold < 2) cards.set(gid, { x: g.x || 0, y: g.y || 0 })
        else if (!g.auto && g.fx != null) frames.set(gid, { x: g.fx, y: g.fy ?? 0 })
        const collect = (pg: string) => {
          this.snap.groups.forEach((cg) => {
            if (cg.parent === pg) {
              if (cg.fold < 2) cards.set(cg.id, { x: cg.x || 0, y: cg.y || 0 })
              else if (!cg.auto && cg.fx != null) frames.set(cg.id, { x: cg.fx, y: cg.fy ?? 0 })
              collect(cg.id)
            }
          })
        }
        collect(gid)
        const ptEdges = new Set<string>()
        const ptBase = new Map<string, Pt[]>()
        const gr0 = this.groupRectWorld(g)
        this.snap.edges.forEach((edP) => {
          if (!edP.pts || !edP.pts.length) return
          const both = start.has(edP.from) && start.has(edP.to)
          let inside = false
          if (!both && gr0) {
            inside = edP.pts.some((p) => p.x >= gr0.x && p.x <= gr0.x + gr0.w && p.y >= gr0.y && p.y <= gr0.y + gr0.h)
          }
          if (both || inside) {
            ptEdges.add(edP.id)
            ptBase.set(edP.id, edP.pts.map((p) => ({ x: p.x, y: p.y })))
          }
        })
        this.gesture = {
          kind: 'gdrag',
          gid,
          sx: e.clientX,
          sy: e.clientY,
          moved: false,
          p0: g.parent ?? null,
          gx: g.x || 0,
          gy: g.y || 0,
          start,
          cards,
          frames,
          ptEdges,
          ptBase,
          excl,
          hoverG: null,
        }
        return
      }
    }

    if (e.button === 1 || this.spaceDown) {
      const vp = this.store.getVp()
      this.gesture = { kind: 'pan', sx: e.clientX, sy: e.clientY, vx: vp.x, vy: vp.y }
      document.body.classList.add('panning')
      e.preventDefault()
      return
    }

    if (e.button === 0) {
      if (e.altKey) {
        const w0 = this.toWorld(e.clientX, e.clientY)
        this.gesture = {
          kind: 'knife',
          path: [w0],
          removed: new Set(),
          startEdge: this.nearestEdgeAt(w0.x, w0.y, 12 / this.store.getVp().z, undefined),
          moved: false,
        }
        const cp = svgEl('path') as SVGPathElement
        cp.setAttribute('class', 'cutline')
        this.edgesSvg.appendChild(cp)
        this.cutline = cp
        e.preventDefault()
        return
      }
      const marS: Gesture = {
        kind: 'marquee',
        sx: e.clientX,
        sy: e.clientY,
        add: e.shiftKey,
        preN: this.snap.sel,
        preG: this.snap.selGroups,
      }
      this.gesture = marS
      if (!e.shiftKey) this.store.clearSel()
      e.preventDefault()
    }
  }

  private descGroupIds(gid: string): string[] {
    const out: string[] = []
    const walk = (id: string) => {
      this.snap.groups.forEach((cg) => {
        if (cg.parent === id) {
          out.push(cg.id)
          walk(cg.id)
        }
      })
    }
    walk(gid)
    return out
  }

  private dlgResizeBandHit(n: VetviNode, el: HTMLElement, wx: number, wy: number): boolean {
    if (!n || n.type !== 'dialog' || !el) return false
    const w = el.offsetWidth
    const h = el.offsetHeight
    return wx >= n.x + w - 6 && wx <= n.x + w + 3 && wy >= n.y && wy <= n.y + h
  }

  private startConnect(e: PointerEvent, nodeEl: HTMLElement) {
    e.stopPropagation()
    e.preventDefault()
    const id = nodeEl.dataset.id!
    const n = this.nodeById(id)
    if (!n) return
    const prev = svgEl('path') as SVGPathElement
    prev.setAttribute('class', 'preview')
    this.edgesSvg.appendChild(prev)
    this.previewPath = prev
    let x1: number
    let y1: number
    if (n.type === 'dialog') {
      const mm = this.dlgMainAnchor(n, nodeEl as HTMLDivElement)
      x1 = mm.x
      y1 = mm.y
    } else {
      x1 = n.x + nodeEl.offsetWidth
      y1 = n.y + nodeEl.offsetHeight / 2
    }
    this.gesture = { kind: 'connect', from: id, fromReply: null, x1, y1, hl: null, wx: null, wy: null, cx: e.clientX, cy: e.clientY }
    document.body.classList.add('connecting')
  }

  private startReplyConnect(e: PointerEvent, portEl: HTMLElement) {
    e.stopPropagation()
    e.preventDefault()
    const replyId = portEl.getAttribute('data-reply-id')
    const nodeEl = portEl.closest('.node') as HTMLDivElement | null
    if (!nodeEl || !replyId) return
    const nodeId = nodeEl.dataset.id!
    const n = this.nodeById(nodeId)
    if (!n) return
    const pos = this.dlgReplyPortPos(nodeEl, replyId)
    if (!pos) return
    const prev = svgEl('path') as SVGPathElement
    prev.setAttribute('class', 'preview')
    this.edgesSvg.appendChild(prev)
    this.previewPath = prev
    this.gesture = { kind: 'connect', from: nodeId, fromReply: replyId, x1: pos.x, y1: pos.y, hl: null, wx: null, wy: null, cx: e.clientX, cy: e.clientY }
    document.body.classList.add('connecting')
  }

  private startPinDrag(e: PointerEvent, nodeEl: HTMLElement) {
    e.stopPropagation()
    e.preventDefault()
    const nid = nodeEl.dataset.id!
    const inc = this.snap.edges.filter((ed) => ed.to === nid)
    if (!inc.length) {
      this.storeToast('У узла нет входящих стрелок', 'warn')
      return
    }
    this.store.selectOnly(nid)
    this.previewPaths = []
    inc.forEach((ed) => {
      const r = this.edgeEls.get(ed.id)
      if (r) r.g.style.display = 'none'
      const p = svgEl('path') as SVGPathElement
      p.setAttribute('class', 'preview')
      this.edgesSvg.appendChild(p)
      this.previewPaths.push({ eid: ed.id, p })
    })
    this.gesture = { kind: 'inDrag', nid, moved: false, hl: null }
  }

  private startOutDrag(e: PointerEvent, nodeEl: HTMLElement) {
    e.stopPropagation()
    e.preventDefault()
    const nid = nodeEl.dataset.id!
    const outs = this.snap.edges.filter((ed) => ed.from === nid && !ed.fromReply)
    if (!outs.length) {
      this.storeToast('У узла нет исходящих стрелок', 'warn')
      return
    }
    this.store.selectOnly(nid)
    this.previewPaths = []
    outs.forEach((ed) => {
      const r = this.edgeEls.get(ed.id)
      if (r) r.g.style.display = 'none'
      const p = svgEl('path') as SVGPathElement
      p.setAttribute('class', 'preview')
      this.edgesSvg.appendChild(p)
      this.previewPaths.push({ eid: ed.id, p })
    })
    this.gesture = { kind: 'outDrag', nid, moved: false, hl: null }
  }

  private startReplyOutDrag(e: PointerEvent, portEl: HTMLElement) {
    e.stopPropagation()
    e.preventDefault()
    const replyId = portEl.getAttribute('data-reply-id')
    const nodeEl = portEl.closest('.node') as HTMLDivElement | null
    if (!nodeEl || !replyId) return
    const nodeId = nodeEl.dataset.id!
    const outs = this.snap.edges.filter((ed) => ed.from === nodeId && ed.fromReply === replyId)
    if (!outs.length) {
      this.storeToast('У этой реплики нет исходящих стрелок', 'warn')
      return
    }
    this.store.selectOnly(nodeId)
    this.previewPaths = []
    outs.forEach((ed) => {
      const r = this.edgeEls.get(ed.id)
      if (r) r.g.style.display = 'none'
      const p = svgEl('path') as SVGPathElement
      p.setAttribute('class', 'preview')
      this.edgesSvg.appendChild(p)
      this.previewPaths.push({ eid: ed.id, p })
    })
    this.gesture = { kind: 'repOutDrag', nid: nodeId, replyId, moved: false, hl: null }
  }

  private storeToast(msg: string, kind: 'ok' | 'warn' | 'err' = 'ok') {
    this.store.showToast?.(msg, kind)
  }

  /* ── pointermove ── */

  private onPointerMove = (e: PointerEvent) => {
    const g = this.gesture
    if (!g) {
      // Курсоры над группами/диалогами.
      const tgt = e.target as HTMLElement
      if (tgt && tgt.closest) {
        const gbx = tgt.closest('.groupbox') as HTMLElement | null
        if (gbx) {
          const gg3 = this.groupById(gbx.dataset.gid ?? '')
          let cur = 'default'
          if (tgt.closest('.gb-head')) cur = 'grab'
          else if (gg3) {
            const rr = this.groupRectWorld(gg3)
            if (rr) {
              const wpt2 = this.toWorld(e.clientX, e.clientY)
              const strip2 = 12
              const inX2 = wpt2.x >= rr.x && wpt2.x <= rr.x + rr.w
              const inY2 = wpt2.y >= rr.y && wpt2.y <= rr.y + rr.h
              if (inX2 && inY2 && (wpt2.x < rr.x + strip2 || wpt2.x > rr.x + rr.w - strip2 || wpt2.y < rr.y + strip2 || wpt2.y > rr.y + rr.h - strip2)) cur = 'grab'
            }
          }
          gbx.style.cursor = cur
        }
        const nd = tgt.closest('.node') as HTMLElement | null
        if (nd) {
          const gn = this.nodeById(nd.dataset.id ?? '')
          if (gn && gn.type === 'dialog') {
            const w5 = this.toWorld(e.clientX, e.clientY)
            nd.style.cursor = this.dlgResizeBandHit(gn, nd, w5.x, w5.y) ? 'ew-resize' : ''
          } else if (nd.style.cursor) {
            nd.style.cursor = ''
          }
        }
      }
      return
    }

    switch (g.kind) {
      case 'pan': {
        this.store.setVp(g.vx + e.clientX - g.sx, g.vy + e.clientY - g.sy)
        this.applyView()
        return
      }
      case 'dlgResize': {
        const nR = this.nodeById(g.nid)
        if (!nR) {
          this.gesture = null
          return
        }
        const dxR = (e.clientX - g.sx) / this.store.getVp().z
        if (Math.abs(e.clientX - g.sx) > 2) g.moved = true
        let newW = clampN(Math.round(g.origWidth + dxR), NODE_W, 1200)
        if (this.store.snapOn) newW = Math.max(NODE_W, Math.round(newW / GRID) * GRID)
        if (newW !== (nR.dlgWidth || NODE_W)) {
          this.store.setDlgWidth(g.nid, newW)
          const elR = this.nodeEls.get(nR.id)
          if (elR) elR.style.width = this.dlgWOf(nR) + 'px'
          this.updateEdgesFor(nR.id)
          this.refreshGroupFrames()
        }
        return
      }
      case 'connect': {
        const p = this.toWorld(e.clientX, e.clientY)
        g.wx = p.x
        g.wy = p.y
        g.cx = e.clientX
        g.cy = e.clientY
        this.previewPath?.setAttribute('d', `M${g.x1} ${g.y1} C ${g.x1 + 80} ${g.y1}, ${p.x - 80} ${p.y}, ${p.x} ${p.y}`)
        const elp = document.elementFromPoint(e.clientX, e.clientY)
        const under = this.elpp(elp)
        if (g.hl) g.hl.classList.remove('drop-hover')
        g.hl = null
        if (under && under.dataset.id !== g.from) {
          under.classList.add('drop-hover')
          g.hl = under
        }
        return
      }
      case 'inDrag': {
        const wI = this.toWorld(e.clientX, e.clientY)
        g.moved = true
        this.previewPaths.forEach((pr) => {
          const ed = this.edgeById(pr.eid)
          if (!ed) return
          const an = this.edgeAnchors(ed)
          if (!an) return
          pr.p.setAttribute('d', `M${an.x1} ${an.y1} L ${wI.x} ${wI.y}`)
        })
        const elpI = document.elementFromPoint(e.clientX, e.clientY)
        const underI = this.elpp(elpI)
        if (g.hl) g.hl.classList.remove('drop-hover')
        g.hl = null
        if (underI && underI.dataset.id !== g.nid) {
          underI.classList.add('drop-hover')
          g.hl = underI
        }
        return
      }
      case 'outDrag': {
        const wO = this.toWorld(e.clientX, e.clientY)
        g.moved = true
        this.previewPaths.forEach((pr) => {
          const ed = this.edgeById(pr.eid)
          if (!ed) return
          const an = this.edgeAnchors(ed)
          if (!an) return
          pr.p.setAttribute('d', `M${wO.x} ${wO.y} L ${an.x2} ${an.y2}`)
        })
        const elpO = document.elementFromPoint(e.clientX, e.clientY)
        const underO = this.elpp(elpO)
        if (g.hl) g.hl.classList.remove('drop-hover')
        g.hl = null
        if (underO && underO.dataset.id !== g.nid) {
          underO.classList.add('drop-hover')
          g.hl = underO
        }
        return
      }
      case 'repOutDrag': {
        const wR = this.toWorld(e.clientX, e.clientY)
        g.moved = true
        this.previewPaths.forEach((pr) => {
          const ed = this.edgeById(pr.eid)
          if (!ed) return
          const an = this.edgeAnchors(ed)
          if (!an) return
          pr.p.setAttribute('d', `M${wR.x} ${wR.y} L ${an.x2} ${an.y2}`)
        })
        const elpR = document.elementFromPoint(e.clientX, e.clientY)
        const underR = this.elpp(elpR)
        if (g.hl && g.hl !== underR) g.hl.classList.remove('drop-hover')
        g.hl = underR
        if (underR && underR.dataset.id !== g.nid) underR.classList.add('drop-hover')
        return
      }
      case 'knife': {
        const wK = this.toWorld(e.clientX, e.clientY)
        const lastP = g.path[g.path.length - 1]
        if (Math.hypot(wK.x - lastP.x, wK.y - lastP.y) < 2 / this.store.getVp().z) return
        g.moved = true
        g.path.push(wK)
        this.cutline?.setAttribute('d', 'M' + g.path.map((p) => p.x + ' ' + p.y).join(' L'))
        const hits = new Set<string>()
        this.snap.edges.forEach((ed) => {
          if (g.removed.has(ed.id)) return
          const poly = this.edgePolyline(ed, 24)
          if (!poly) return
          for (let iK = 0; iK < poly.length - 1; iK++) {
            if (segIntersect(lastP, wK, poly[iK], poly[iK + 1])) {
              hits.add(ed.id)
              break
            }
          }
        })
        if (hits.size) {
          hits.forEach((hid) => g.removed.add(hid))
          this.store.deleteEdges([...hits])
          this.syncSel()
          this.updateDlgRowStates()
        }
        return
      }
      case 'brDrag': {
        const eb2 = this.edgeById(g.eid)
        if (!eb2) {
          this.gesture = null
          return
        }
        const wB = this.toWorld(e.clientX, e.clientY)
        const dxB = wB.x - g.last.x
        const dyB = wB.y - g.last.y
        g.last = wB
        if (dxB || dyB) g.moved = true
        const bd = { ...eb2.bd }
        if (g.mode === 'l') bd.dl += dxB
        else if (g.mode === 'r') bd.dr += dxB
        else bd.dy += dyB
        this.store.updateEdge(g.eid, { bd })
        return
      }
      case 'wpDrag': {
        const w1 = this.toWorld(e.clientX, e.clientY)
        g.moved = true
        this.store.setEdgePt(g.eid, g.idx, w1.x, w1.y)
        // Обновим геометрию немедленно (до отклика снапшота).
        const ew = this.edgeById(g.eid)
        if (ew) {
          const live = { ...ew, pts: ew.pts.map((p, i) => (i === g.idx ? { x: w1.x, y: w1.y } : p)) }
          this.updateEdgeGeom(live)
        }
        return
      }
      case 'rpDrag': {
        const w2 = this.toWorld(e.clientX, e.clientY)
        this.previewPath?.setAttribute('d', `M${g.ax} ${g.ay} L ${w2.x} ${w2.y}`)
        const elp2 = document.elementFromPoint(e.clientX, e.clientY)
        const under2 = this.elpp(elp2)
        document.querySelectorAll('.drop-hover').forEach((el) => {
          if (el !== under2) el.classList.remove('drop-hover')
        })
        if (under2) under2.classList.add('drop-hover')
        return
      }
      case 'lblDrag': {
        const ed2 = this.edgeById(g.eid)
        if (!ed2) {
          this.gesture = null
          return
        }
        const g2 = this.edgeGeom(ed2)
        if (!g2) return
        const w3 = this.toWorld(e.clientX, e.clientY)
        const np = nearestPointOnEdge(g2, w3)
        const d1 = edgeSample(g2, Math.min(1, np.t + 0.02))
        const d0 = edgeSample(g2, Math.max(0, np.t - 0.02))
        const tx = d1.x - d0.x
        const ty = d1.y - d0.y
        const l = Math.hypot(tx, ty) || 1
        const nx = -ty / l
        const ny = tx / l
        const off = (w3.x - np.p.x) * nx + (w3.y - np.p.y) * ny
        g.moved = true
        this.store.updateEdge(g.eid, { lt: clampN(np.t, 0.04, 0.96), lp: clampN(off, -44, 44) })
        return
      }
      case 'grestore': {
        const gr = this.groupById(g.gid)
        if (!gr) {
          this.gesture = null
          return
        }
        const dx = (e.clientX - g.sx) / this.store.getVp().z
        const dy = (e.clientY - g.sy) / this.store.getVp().z
        if (Math.hypot(e.clientX - g.sx, e.clientY - g.sy) > 3) g.moved = true
        let fw = g.r0.w
        let fh = g.r0.h
        if (g.mode === 'r' || g.mode === 'br') fw = Math.max(60, Math.round(g.r0.w + dx))
        if (g.mode === 'b' || g.mode === 'br') fh = Math.max(50, Math.round(g.r0.h + dy))
        if (this.store.snapOn) {
          fw = Math.max(60, Math.round(fw / GRID) * GRID)
          fh = Math.max(50, Math.round(fh / GRID) * GRID)
        }
        this.store.setGroupFrameSize(g.gid, g.r0.x, g.r0.y, fw, fh)
        // Немедленное обновление рамки.
        const live = { ...gr, auto: false, fx: g.r0.x, fy: g.r0.y, fw, fh }
        const el = this.groupEls.get(g.gid)
        if (el) {
          el.style.left = g.r0.x + 'px'
          el.style.top = g.r0.y + 'px'
          el.style.width = fw + 'px'
          el.style.height = fh + 'px'
        }
        void live
        return
      }
      case 'gdrag': {
        const gg2 = this.groupById(g.gid)
        if (!gg2) {
          this.gesture = null
          return
        }
        let gdx = (e.clientX - g.sx) / this.store.getVp().z
        let gdy = (e.clientY - g.sy) / this.store.getVp().z
        if (!g.moved && Math.hypot(e.clientX - g.sx, e.clientY - g.sy) > 3) g.moved = true
        if (!g.moved) return
        if (this.store.snapOn) {
          gdx = Math.round(gdx / GRID) * GRID
          gdy = Math.round(gdy / GRID) * GRID
        }
        const moves: { id: string; x: number; y: number }[] = []
        g.start.forEach((s, id) => moves.push({ id, x: Math.round(s.x + gdx), y: Math.round(s.y + gdy) }))
        this.store.moveNodesLive(moves)
        // Немедленный DOM-сдвиг.
        moves.forEach((m) => {
          const nel = this.nodeEls.get(m.id)
          if (nel && nel.style.display !== 'none') {
            nel.style.left = m.x + 'px'
            nel.style.top = m.y + 'px'
          }
        })
        g.cards.forEach((s, cgid) => {
          this.store.setGroupCardPos(cgid, Math.round(s.x + gdx), Math.round(s.y + gdy))
          const cel = this.groupEls.get(cgid)
          if (cel) {
            cel.style.left = Math.round(s.x + gdx) + 'px'
            cel.style.top = Math.round(s.y + gdy) + 'px'
          }
        })
        g.frames.forEach((s, cgid) => {
          this.store.setGroupFramePos(cgid, Math.round(s.x + gdx), Math.round(s.y + gdy))
        })
        // Точки излома внутри группы.
        const affected = [...g.ptEdges]
        if (affected.length) {
          const edgesMap = new Map(this.snap.edges.map((x) => [x.id, x]))
          affected.forEach((eid) => {
            const base = g.ptBase.get(eid)
            const ed = edgesMap.get(eid)
            if (!base || !ed) return
            ed.pts.forEach((p, i) => {
              if (base[i]) this.store.setEdgePt(eid, i, base[i].x + gdx, base[i].y + gdy)
            })
            const live = { ...ed, pts: ed.pts.map((p, i) => (base[i] ? { x: base[i].x + gdx, y: base[i].y + gdy } : p)) }
            this.updateEdgeGeom(live)
          })
        }
        if (gg2.fold < 2) {
          this.store.setGroupCardPos(gg2.id, Math.round(g.gx + gdx), Math.round(g.gy + gdy))
          const cel2 = this.groupEls.get(gg2.id)
          if (cel2) {
            cel2.style.left = Math.round(g.gx + gdx) + 'px'
            cel2.style.top = Math.round(g.gy + gdy) + 'px'
          }
        }
        moves.forEach((m) => this.updateEdgesFor(m.id))
        this.refreshGroupFrames()
        this.updateGroupEdges(gg2.id)
        const wpG = this.toWorld(e.clientX, e.clientY)
        const tgtG = this.store.groupDropTargetAt(wpG.x, wpG.y, g.excl)
        if (g.hoverG && (!tgtG || tgtG.id !== g.hoverG)) {
          this.groupEls.get(g.hoverG)?.classList.remove('drop-hover-g')
        }
        if (tgtG) this.groupEls.get(tgtG.id)?.classList.add('drop-hover-g')
        g.hoverG = tgtG ? tgtG.id : null
        return
      }
      case 'drag': {
        let dx2 = (e.clientX - g.sx) / this.store.getVp().z
        let dy2 = (e.clientY - g.sy) / this.store.getVp().z
        if (!g.moved && Math.hypot(e.clientX - g.sx, e.clientY - g.sy) > 3) {
          g.moved = true
          g.start.forEach((_s, id) => this.nodeEls.get(id)?.classList.add('dragging'))
        }
        if (!g.moved) return
        const moves: { id: string; x: number; y: number }[] = []
        g.start.forEach((s, id) => {
          moves.push({
            id,
            x: this.store.snapOn ? Math.round((s.x + dx2) / GRID) * GRID : Math.round(s.x + dx2),
            y: this.store.snapOn ? Math.round((s.y + dy2) / GRID) * GRID : Math.round(s.y + dy2),
          })
        })
        void dx2
        void dy2
        this.store.moveNodesLive(moves)
        moves.forEach((m) => {
          const el = this.nodeEls.get(m.id)
          if (el && el.style.display !== 'none') {
            el.style.left = m.x + 'px'
            el.style.top = m.y + 'px'
          }
          this.updateEdgesFor(m.id)
        })
        this.refreshGroupFrames()
        if (!g.extract) {
          const wp = this.toWorld(e.clientX, e.clientY)
          const hg = this.deepestGroupAt(wp.x, wp.y)
          if (g.hoverG && (!hg || hg.id !== g.hoverG)) {
            this.groupEls.get(g.hoverG)?.classList.remove('drop-hover-g')
          }
          if (hg) this.groupEls.get(hg.id)?.classList.add('drop-hover-g')
          g.hoverG = hg ? hg.id : null
          if (this.snap.sel.length === 1) {
            let deId = this.nearestEdgeAt(wp.x, wp.y, 16 / this.store.getVp().z, new Set<string>(this.snap.sel))
            if (deId) {
              const deE = this.edgeById(deId)
              if (deE && isBridge(deE)) deId = null
            }
            g.dropEdge = deId
            this.setDropEdge(deId)
          }
        }
        return
      }
      case 'marquee': {
        const x = Math.min(g.sx, e.clientX)
        const y = Math.min(g.sy, e.clientY)
        const w4 = Math.abs(e.clientX - g.sx)
        const h = Math.abs(e.clientY - g.sy)
        const cr = this.canvas.getBoundingClientRect()
        this.marquee.style.display = 'block'
        this.marquee.style.left = x - cr.left + 'px'
        this.marquee.style.top = y - cr.top + 'px'
        this.marquee.style.width = w4 + 'px'
        this.marquee.style.height = h + 'px'
        const wa = this.toWorld(x, y)
        const wb = this.toWorld(x + w4, y + h)
        this.store.marqueeSelect(wa, wb, g.add ? { n: g.preN, g: g.preG } : null)
        return
      }
      case 'carry': {
        const wC = this.toWorld(e.clientX, e.clientY)
        let dx = wC.x - g.cx
        let dy = wC.y - g.cy
        if (this.store.snapOn) {
          dx = Math.round(dx / GRID) * GRID
          dy = Math.round(dy / GRID) * GRID
        }
        const moves: { id: string; x: number; y: number }[] = []
        g.ids.forEach((id) => {
          const o = g.orig.get(id)
          if (o) moves.push({ id, x: Math.round(o.x + dx), y: Math.round(o.y + dy) })
        })
        this.store.moveNodesLive(moves)
        moves.forEach((m) => {
          const el = this.nodeEls.get(m.id)
          if (el && el.style.display !== 'none') {
            el.style.left = m.x + 'px'
            el.style.top = m.y + 'px'
          }
          this.updateEdgesFor(m.id)
        })
        this.refreshGroupFrames()
        return
      }
      case 'gcreate': {
        const cr0 = this.canvas.getBoundingClientRect()
        const x = Math.min(g.sx, e.clientX)
        const y = Math.min(g.sy, e.clientY)
        const w = Math.abs(e.clientX - g.sx)
        const h = Math.abs(e.clientY - g.sy)
        this.marquee.style.left = x - cr0.left + 'px'
        this.marquee.style.top = y - cr0.top + 'px'
        this.marquee.style.width = w + 'px'
        this.marquee.style.height = h + 'px'
        return
      }
    }
  }

  /* ── pointerup ── */

  private onPointerUp = (e: PointerEvent) => {
    const g = this.gesture
    document.body.classList.remove('panning')
    if (!g) return
    this.gesture = null

    switch (g.kind) {
      case 'dlgResize': {
        this.store.endDragHistory()
        this.updateDlgRowStates()
        return
      }
      case 'gcreate': {
        this.marquee.style.display = 'none'
        this.marquee.classList.remove('mg')
        const p1 = this.toWorld(g.sx, g.sy)
        const p2 = this.toWorld(e.clientX, e.clientY)
        let rx = Math.min(p1.x, p2.x)
        let ry = Math.min(p1.y, p2.y)
        let rw = Math.abs(p1.x - p2.x)
        let rh = Math.abs(p1.y - p2.y)
        if (rw < 10 && rh < 10) {
          rw = 220
          rh = 150
          rx = p2.x - rw / 2
          ry = p2.y - rh / 2
        }
        if (this.store.snapOn) {
          rx = Math.round(rx / GRID) * GRID
          ry = Math.round(ry / GRID) * GRID
          rw = Math.max(GRID, Math.round(rw / GRID) * GRID)
          rh = Math.max(GRID, Math.round(rh / GRID) * GRID)
        }
        this.store.createDrawnGroup(rx, ry, rw, rh)
        return
      }
      case 'inDrag':
      case 'outDrag':
      case 'repOutDrag': {
        this.previewPaths.forEach((pr) => pr.p.remove())
        this.previewPaths = []
        const elpU = document.elementFromPoint(e.clientX, e.clientY)
        let tgtN: string | null = null
        let tgtR: string | null = null
        if (g.kind === 'repOutDrag') {
          const pinU = elpU?.closest('.dlg-reply-pin.out') as HTMLElement | null
          const nodeU = this.elpp(elpU)
          tgtN = nodeU?.dataset.id ?? null
          if (pinU) {
            const pinNode = pinU.closest('.node') as HTMLElement | null
            if (pinNode) tgtN = pinNode.dataset.id ?? null
            tgtR = pinU.getAttribute('data-reply-id')
          }
        } else {
          tgtN = this.elpp(elpU)?.dataset.id ?? null
        }
        if (g.hl) g.hl.classList.remove('drop-hover')
        if (tgtN && g.moved) {
          this.store.reconnectEnds(
            this.previewIds(),
            g.kind === 'inDrag' ? 'to' : 'from',
            tgtN,
            g.kind === 'repOutDrag' ? tgtR : null,
            g.nid,
          )
        } else {
          this.previewIds().forEach((eid) => {
            const r = this.edgeEls.get(eid)
            if (r) r.g.style.display = ''
          })
        }
        return
      }
      case 'knife': {
        this.cutline?.remove()
        this.cutline = null
        if (!g.moved && g.startEdge && !g.removed.size) {
          this.store.deleteEdges([g.startEdge])
          this.store.showToast?.('Связь удалена', 'warn')
          this.renderEdges()
          this.syncSel()
          this.updateDlgRowStates()
          return
        }
        if (g.removed.size) {
          this.store.showToast?.('Разрезано связей: ' + g.removed.size, 'warn')
          this.updateDlgRowStates()
        }
        return
      }
      case 'brDrag': {
        this.store.endDragHistory()
        return
      }
      case 'wpDrag': {
        this.store.endDragHistory()
        return
      }
      case 'rpDrag': {
        this.previewPath?.remove()
        this.previewPath = null
        const elp2 = document.elementFromPoint(e.clientX, e.clientY)
        const under2 = this.elpp(elp2)
        document.querySelectorAll('.drop-hover').forEach((el) => el.classList.remove('drop-hover'))
        const tgt2 = under2?.dataset.id
        if (tgt2) {
          this.store.reconnectEnds([g.eid], g.side === 'to' ? 'to' : 'from', tgt2, null, null)
        }
        return
      }
      case 'lblDrag': {
        this.store.endDragHistory()
        return
      }
      case 'grestore': {
        if (g.moved) {
          const gr = this.groupById(g.gid)
          let exitedN = 0
          const exitedGr: string[] = []
          let capG = 0
          let capN = 0
          if (gr && gr.fx != null) {
            const rect = { x: gr.fx, y: gr.fy!, w: gr.fw!, h: gr.fh! }
            this.snap.nodes
              .filter((n) => n.gid === gr.id)
              .forEach((n) => {
                const d = this.dimsOf(n)
                const cx = n.x + d.w / 2
                const cy = n.y + d.h / 2
                if (cx < rect.x || cx > rect.x + rect.w || cy < rect.y || cy > rect.y + rect.h) {
                  this.store.updateNode(n.id, { gid: gr.parent ?? null })
                  exitedN++
                }
              })
            this.snap.groups.forEach((cg) => {
              if (cg.parent !== gr.id) return
              const cc = this.groupRectWorld(cg)
              const center = cc ? { x: cc.x + cc.w / 2, y: cc.y + cc.h / 2 } : null
              if (center && !(center.x >= rect.x && center.x <= rect.x + rect.w && center.y >= rect.y && center.y <= rect.y + rect.h)) {
                this.store.updateGroup(cg.id, { parent: gr.parent ?? null })
                exitedGr.push(cg.name)
              }
            })
            const liveG = { ...gr, auto: false, fx: rect.x, fy: rect.y, fw: rect.w, fh: rect.h }
            capG = this.store.captureGroupsInto(liveG)
            capN = this.store.captureNodesInto(liveG)
          }
          this.store.endDragHistory()
          if (exitedN || exitedGr.length || capG || capN) {
            this.renderAll()
            const parts: string[] = []
            if (exitedN) parts.push('вышло элементов: ' + exitedN)
            if (exitedGr.length) parts.push('вышли группы: ' + exitedGr.join(', '))
            if (capG) parts.push('вложено групп: ' + capG)
            if (capN) parts.push('захвачено элементов: ' + capN)
            this.store.showToast?.(parts.join(' · '), 'warn')
          }
        }
        return
      }
      case 'gdrag': {
        this.setDropEdge(null)
        if (g.hoverG) this.groupEls.get(g.hoverG)?.classList.remove('drop-hover-g')
        let changed = false
        if (g.moved) {
          const ggU = this.groupById(g.gid)
          if (ggU) changed = this.store.reparentAfterMove(ggU)
        }
        this.store.endDragHistory()
        if (changed) {
          this.renderAll()
          const ggT = this.groupById(g.gid)
          if (ggT) {
            if (ggT.parent) this.store.showToast?.(`Группа «${ggT.name}» теперь внутри «${this.groupById(ggT.parent)?.name}»`)
            else if (g.p0) this.store.showToast?.(`Группа «${ggT.name}» вынесена из родителя`, 'warn')
            else this.store.showToast?.(`Состав группы «${ggT.name}» обновлён`)
          }
        }
        return
      }
      case 'drag': {
        this.nodeEls.forEach((el) => el.classList.remove('dragging'))
        this.setDropEdge(null)
        if (g.hoverG) {
          this.groupEls.get(g.hoverG)?.classList.remove('drop-hover-g')
        }
        if (!g.extract && g.moved && g.dropEdge && this.snap.sel.length === 1) {
          const nid = this.snap.sel[0]
          const n = this.nodeById(nid)
          const ed = this.edgeById(g.dropEdge)
          if (n && ed && !isBridge(ed)) {
            // Встройка: считаем разрез точек по геометрии.
            const eg = this.edgeGeom(ed)
            const wp = this.toWorld(e.clientX, e.clientY)
            const p = wp
            const sp = splitPtsAtHalf(ed, eg)
            this.store.performInsert(n, null, ed.id, sp[0] ?? [], sp[1] ?? [], p)
            this.store.showToast?.('Элемент встроен в связь')
          } else if (n && ed) {
            this.store.showToast?.('В мост нельзя вставить элемент', 'warn')
          }
        } else if (g.moved) {
          let changedG = false
          const wp = this.toWorld(e.clientX, e.clientY)
          const updates: { id: string; gid: string | null }[] = []
          g.start.forEach((_s, id) => {
            const nn = this.nodeById(id)
            if (!nn) return
            const d = this.dimsOf(nn)
            const tg = this.deepestGroupAt(nn.x + d.w / 2, nn.y + d.h / 2) ?? (this.deepestGroupAt(wp.x, wp.y) ? null : null)
            void tg
            const tg2 = this.deepestGroupAt(nn.x + d.w / 2, nn.y + d.h / 2)
            const ngid = tg2 ? tg2.id : null
            if ((nn.gid ?? null) !== ngid) {
              updates.push({ id, gid: ngid })
              changedG = true
            }
          })
          this.store.endDragHistory()
          updates.forEach((u) => this.store.updateNode(u.id, { gid: u.gid }))
          if (changedG) this.renderAll()
        } else {
          this.store.endDragHistory()
        }
        return
      }
      case 'marquee': {
        this.marquee.style.display = 'none'
        return
      }
      case 'connect': {
        document.body.classList.remove('connecting')
        this.previewPath?.remove()
        this.previewPath = null
        if (g.hl) g.hl.classList.remove('drop-hover')
        const from = g.from
        const fromReply = g.fromReply
        const to = g.hl?.dataset.id ?? null
        const pt = g.wx != null ? { x: g.wx, y: g.wy! } : null
        if (to && to !== from) {
          this.store.addEdge(from, to, fromReply)
          return
        }
        if (from && pt) {
          this.openCtxMenu(g.cx, g.cy, this.connectMenuItems(from, pt, fromReply))
        }
        return
      }
      case 'carry': {
        return
      }
      case 'pan':
      case 'gcreate':
        return
    }
  }

  private previewIds(): string[] {
    return this.previewPaths.map((p) => p.eid)
  }

  /* ── клавиатурные/carry helpers ── */

  startCarry(ids: string[]) {
    if (!ids || !ids.length) return
    const orig = new Map<string, Pt>()
    let cx = 0
    let cy = 0
    ids.forEach((id) => {
      const n = this.nodeById(id)
      if (!n) return
      orig.set(id, { x: n.x, y: n.y })
      cx += n.x + NODE_W / 2
      cy += n.y + 45
    })
    cx /= ids.length
    cy /= ids.length
    this.gesture = { kind: 'carry', ids, orig, cx, cy }
    document.body.classList.add('carry')
    this.store.showToast?.('Дубликат следует за курсором: клик — поставить, Esc/ПКМ — отменить')
  }

  private placeCarry() {
    const g = this.gesture
    if (!g || g.kind !== 'carry') return
    const updates: { id: string; gid: string | null }[] = []
    g.ids.forEach((id) => {
      const n = this.nodeById(id)
      if (!n) return
      const d = this.dimsOf(n)
      const tg = this.deepestGroupAt(n.x + d.w / 2, n.y + d.h / 2)
      updates.push({ id, gid: tg ? tg.id : null })
    })
    updates.forEach((u) => this.store.updateNode(u.id, { gid: u.gid }))
    this.endCarry()
    this.renderAll()
    this.store.showToast?.('Дубликат размещён')
  }

  private cancelCarry() {
    const g = this.gesture
    if (!g || g.kind !== 'carry') return
    this.store.deleteEdges([])
    this.store.deleteNodesById(g.ids)
    this.endCarry()
    this.store.showToast?.('Дублирование отменено', 'warn')
  }

  private endCarry() {
    document.body.classList.remove('carry')
    this.gesture = null
  }

  /** Esc-каскад: true — жест погашен. */
  private cancelGestures(): boolean {
    const g = this.gesture
    if (!g) return false
    if (g.kind === 'carry') {
      this.cancelCarry()
      return true
    }
    if (g.kind === 'gcreate') {
      this.gesture = null
      this.marquee.style.display = 'none'
      this.marquee.classList.remove('mg')
      return true
    }
    if (g.kind === 'connect') {
      document.body.classList.remove('connecting')
      this.previewPath?.remove()
      this.previewPath = null
      if (g.hl) g.hl.classList.remove('drop-hover')
      this.gesture = null
      return true
    }
    if (g.kind === 'inDrag' || g.kind === 'outDrag' || g.kind === 'repOutDrag') {
      this.previewPaths.forEach((pr) => pr.p.remove())
      this.previewPaths = []
      if (g.hl) g.hl.classList.remove('drop-hover')
      this.previewIds().forEach((eid) => {
        const r = this.edgeEls.get(eid)
        if (r) r.g.style.display = ''
      })
      this.gesture = null
      return true
    }
    if (g.kind === 'knife') {
      this.cutline?.remove()
      this.cutline = null
      this.gesture = null
      return true
    }
    // Остальные жесты просто завершаем.
    this.gesture = null
    document.body.classList.remove('panning')
    return true
  }

  private startInlineEdit(nodeEl: HTMLElement) {
    const n = this.nodeById(nodeEl.dataset.id ?? '')
    if (!n) return
    const tEl = nodeEl.querySelector('.n-title')
    if (!tEl) return
    const inp = document.createElement('input')
    inp.className = 'n-title-inp'
    inp.value = n.title
    inp.maxLength = 80
    tEl.replaceWith(inp)
    inp.focus()
    inp.select()
    let closed = false
    const done = (cancel: boolean) => {
      if (closed) return
      closed = true
      const v = inp.value.trim()
      if (!cancel && v && v !== n.title) this.store.updateNode(n.id, { title: v })
      const sp = document.createElement('span')
      sp.className = 'n-title'
      sp.textContent = this.nodeById(n.id)?.title ?? n.title
      inp.replaceWith(sp)
    }
    inp.addEventListener('keydown', (ev) => {
      ev.stopPropagation()
      if (ev.key === 'Enter') done(false)
      if (ev.key === 'Escape') done(true)
    })
    inp.addEventListener('blur', () => done(false))
    inp.addEventListener('pointerdown', (ev) => ev.stopPropagation())
  }

  /* ── wheel ── */

  private onWheel = (e: WheelEvent) => {
    e.preventDefault()
    if (e.shiftKey && !e.ctrlKey) {
      const vp = this.store.getVp()
      this.store.setVp(vp.x - e.deltaY, vp.y)
      this.applyView()
      return
    }
    const r = this.canvas.getBoundingClientRect()
    this.store.zoomAt(e.clientX - r.left, e.clientY - r.top, e.deltaY < 0 ? 1.11 : 1 / 1.11)
  }

  /* ── dblclick ── */

  private onDblClick = (e: MouseEvent) => {
    const t = e.target as HTMLElement
    if (t.closest && (t.closest('.n-fold') || t.closest('.port') || t.closest('.dlg-reply-pin') || t.closest('.n-title-inp'))) return
    const nodeEl = t.closest ? (t.closest('.node') as HTMLElement | null) : null
    const edgeEl = t.closest ? (t.closest('.edge') as HTMLElement | null) : null
    const gbD = t.closest ? (t.closest('.groupbox,.gcard') as HTMLElement | null) : null
    if (nodeEl) {
      const idd = nodeEl.dataset.id!
      if (!this.snap.sel.includes(idd)) this.store.selectOnly(idd)
      this.store.removeSelected()
      return
    }
    if (edgeEl) {
      const eid = edgeEl.dataset.id!
      const ed = this.edgeById(eid)
      if (!ed) return
      if (isBridge(ed)) {
        this.store.showToast?.('Мост: тяни его прямые отрезки, чтобы сместить', 'warn')
        return
      }
      const wpt = this.toWorld(e.clientX, e.clientY)
      const g = this.edgeGeom(ed)
      if (!g) return
      const idx = nearestSegIndex(g, wpt)
      this.store.addWaypoint(eid, idx, wpt.x, wpt.y)
      this.store.selectEdgeOnly(eid)
      return
    }
    if (gbD) {
      this.store.selectGroup(gbD.dataset.gid!)
      setTimeout(() => {
        const i = document.getElementById('igName') as HTMLInputElement | null
        if (i) {
          i.focus()
          i.select()
        }
      }, 30)
      return
    }
    this.openCtxMenu(e.clientX, e.clientY, this.ctxAddItems(this.toWorld(e.clientX, e.clientY)))
  }

  /* ── контекстное меню ── */

  private ctxAddItems(w: Pt): CtxEntry[] {
    const arr: CtxEntry[] = [{ head: 'Добавить' } as CtxEntry]
    this.store.allTypeKeys().forEach((key) => {
      const info = this.store.typeInfo(key)
      const isCustom = !(['scene', 'char', 'quest', 'dialog', 'skill', 'branch', 'event', 'note'] as string[]).includes(key)
      arr.push({
        dot: info.color,
        label: info.name + (isCustom ? ' ·' : ''),
        fn: () => this.store.addNode(key, w.x - NODE_W / 2, w.y - 20, true),
      })
    })
    return arr
  }

  private connectMenuItems(fromId: string, pt: Pt, fromReply: string | null): CtxEntry[] {
    const arr: CtxEntry[] = [{ head: 'Создать и подключить' } as CtxEntry]
    this.store.allTypeKeys().forEach((key) => {
      const info = this.store.typeInfo(key)
      const isCustom = !(['scene', 'char', 'quest', 'dialog', 'skill', 'branch', 'event', 'note'] as string[]).includes(key)
      arr.push({
        dot: info.color,
        label: info.name + (isCustom ? ' ·' : ''),
        fn: () => this.createConnected(fromId, key, null, pt, fromReply),
      })
    })
    let cands: VetviNode[] = []
    this.store.allTypeKeys().forEach((key) => {
      if (this.snap.listHidden.includes(key)) return
      this.snap.nodes.forEach((n) => {
        if (n.type === key && n.id !== fromId) cands.push(n)
      })
    })
    cands = cands.slice(0, 20)
    if (cands.length) {
      arr.push({ head: 'Копия из раздела «На холсте»' } as CtxEntry)
      cands.forEach((n) => {
        const v = this.store.typeInfo(n.type)
        const c = n.color ? n.color : v.color
        arr.push({ dot: c, label: '«' + n.title + '»', fn: () => this.createConnected(fromId, null, n.id, pt, fromReply) })
      })
    }
    return arr
  }

  private createConnected(fromId: string, typeKey: string | null, cloneId: string | null, pt: Pt, fromReply: string | null) {
    const src = this.nodeById(fromId)
    if (!src) return
    let n: VetviNode | null = null
    if (cloneId) {
      const s = this.nodeById(cloneId)
      if (!s) return
      n = this.store.cloneNode(s, pt.x, pt.y)
    } else if (typeKey) {
      const info = this.store.typeInfo(typeKey)
      n = {
        id: Math.random().toString(36).slice(2) + Date.now().toString(36),
        type: typeKey,
        gid: null,
        x: 0,
        y: 0,
        title: info.name,
        text: '',
        status: 'idea',
        tags: [],
        expand: 1,
        color: null,
        tint: 0,
        dlgWidth: null,
        notes: [],
        dialog: typeKey === 'dialog' ? { participants: [], description: '', replies: [] } : undefined,
      }
    }
    if (!n) return
    n.x = Math.round(pt.x - NODE_W / 2)
    n.y = Math.round(pt.y - 46)
    const tgtGroup = this.collapsedAncestorOf(src) ? null : this.deepestGroupAt(pt.x, pt.y)
    n.gid = tgtGroup ? tgtGroup.id : null
    this.store.insertNode(n)
    const eid = this.store.addEdge(fromId, n.id, fromReply ?? null, false)
    void eid
    this.store.resolveOverlaps(new Set([n.id]))
    this.store.selectOnly(n.id)
  }

  private onContextMenu = (e: MouseEvent) => {
    e.preventDefault()
    if (this.gesture?.kind === 'carry') {
      this.cancelCarry()
      return
    }
    const t = e.target as HTMLElement
    const nodeEl = t.closest ? (t.closest('.node') as HTMLElement | null) : null
    const edgeG = t.closest ? (t.closest('.edge') as HTMLElement | null) : null
    const gb = t.closest ? (t.closest('.groupbox,.gcard') as HTMLElement | null) : null
    if (nodeEl) {
      const id = nodeEl.dataset.id!
      if (!this.snap.sel.includes(id)) this.store.selectOnly(id)
      const n = this.nodeById(id)
      if (!n) return
      const items: CtxEntry[] = [
        { ico: 'copy', label: 'Дублировать', fn: () => {
          const r = this.store.duplicateSel()
          if (r) this.startCarry(r.ids)
        } },
        { ico: 'target', label: 'Центрировать', fn: () => this.centerOn(n) },
      ]
      if (this.snap.sel.length + this.snap.selGroups.length > 1) {
        items.push({ ico: 'alignH', label: 'Распределить по строкам…', fn: () => this.store.openDistribute() })
      }
      if (this.snap.sel.length === 2 && this.snap.selGroups.length === 0) {
        const bp = this.store.bridgePairCandidate()
        if (bp) items.push({ ico: 'swap', label: 'Создать мост', fn: () => this.store.createBridgeBetween(bp.a, bp.b) })
      }
      items.push({ ico: 'chev', label: 'Свернуть / развернуть', fn: () => this.store.cycleExpand(id) })
      items.push({
        ico: 'swap',
        label: 'Выдернуть (как Alt+перенос)',
        fn: () => {
          this.store.detachNode(id)
        },
      })
      if (n.gid) {
        items.push('-')
        items.push({ ico: 'x', label: 'Покинуть группу', fn: () => this.store.leaveGroup(id) })
      }
      items.push('-')
      items.push({ ico: 'trash', label: 'Удалить', danger: true, fn: () => this.store.removeSelected() })
      this.openCtxMenu(e.clientX, e.clientY, items)
      return
    }
    if (edgeG) {
      const eid = edgeG.dataset.id!
      if (!this.snap.selEdges.includes(eid)) this.store.selectEdgeOnly(eid)
      const ed = this.edgeById(eid)
      const itemsE: CtxEntry[] = [
        { ico: 'swap', label: 'Развернуть направление', fn: () => this.store.swapEdge(this.snap.selEdge ?? eid) },
      ]
      if (ed && ed.pts && ed.pts.length) {
        itemsE.push({
          ico: 'x',
          label: 'Сбросить изгибы (' + ed.pts.length + ')',
          fn: () => this.store.resetEdgeBends(eid),
        })
      }
      itemsE.push('-')
      itemsE.push({ ico: 'trash', label: 'Удалить связь', danger: true, fn: () => this.store.removeSelected() })
      this.openCtxMenu(e.clientX, e.clientY, itemsE)
      return
    }
    if (gb) {
      const gid = gb.dataset.gid!
      const g = this.groupById(gid)
      if (!g) return
      this.store.selectGroup(gid)
      const nextName = g.fold === 2 ? 'Свернуть в список' : g.fold === 1 ? 'Сжать в компакта' : 'Развернуть группу'
      const itemsG: CtxEntry[] = [
        { ico: 'chev', label: nextName, fn: () => this.store.cycleGroupFold(gid) },
        {
          ico: 'pencil',
          label: 'Переименовать / настроить',
          fn: () => {
            setTimeout(() => {
              const i = document.getElementById('igName') as HTMLInputElement | null
              if (i) {
                i.focus()
                i.select()
              }
            }, 30)
          },
        },
        {
          ico: g.badge ? 'eyeOff' : 'eye',
          label: g.badge ? 'Скрыть ярлык' : 'Показать ярлык',
          fn: () => this.store.updateGroup(gid, { badge: !g.badge }),
        },
        { ico: 'expand', label: g.auto ? 'Авторазмер: выключить' : 'Авторазмер: включить', fn: () => this.store.toggleGroupAuto(gid) },
      ]
      if (g.parent) {
        itemsG.push({ ico: 'x', label: 'Вынуть из родителя', fn: () => this.store.updateGroup(gid, { parent: null }) })
      }
      itemsG.push('-')
      itemsG.push({ ico: 'trash', label: 'Распустить группу', danger: true, fn: () => this.store.ungroup(gid) })
      this.openCtxMenu(e.clientX, e.clientY, itemsG)
      return
    }
    const items2 = this.ctxAddItems(this.toWorld(e.clientX, e.clientY))
    items2.push('-')
    items2.push({
      ico: 'folder',
      label: 'Новая группа здесь (пустая)',
      fn: () => {
        const w = this.toWorld(e.clientX, e.clientY)
        const rw = 220
        const rh = 150
        let rx = Math.round(w.x - rw / 2)
        let ry = Math.round(w.y - rh / 2)
        if (this.store.snapOn) {
          rx = Math.round(rx / GRID) * GRID
          ry = Math.round(ry / GRID) * GRID
        }
        this.store.createDrawnGroup(rx, ry, rw, rh)
      },
    })
    items2.push({ ico: 'target', label: 'Вписать всё', fn: () => this.fitView(true) })
    this.openCtxMenu(e.clientX, e.clientY, items2)
  }

  private openCtxMenu(x: number, y: number, items: CtxEntry[]) {
    this.store.openCtxMenu(x, y, items)
  }

  /* ── edges svg события ── */

  private onEdgesPointerDown = (e: PointerEvent) => {
    if (e.button !== 0 || e.altKey) return
    const tg = e.target as SVGElement
    const gB = tg.closest ? (tg.closest('.edge') as SVGGElement | null) : null
    if (gB) {
      const eb = this.edgeById(gB.dataset.id ?? '')
      if (eb && isBridge(eb)) {
        const wb = this.toWorld(e.clientX, e.clientY)
        const na = this.nodeById(eb.from)
        const nb = this.nodeById(eb.to)
        if (!na || !nb) return
        const dA = this.dimsOf(na)
        const dB = this.dimsOf(nb)
        const bgm = bridgeGeom(eb, { x: na.x, y: na.y }, dA.w, dA.h, { x: nb.x, y: nb.y }, dB.w, dB.h)
        let mode: 'l' | 'r' | 'h' | null = null
        if (Math.abs(wb.x - bgm.bx1) <= 10 && wb.y >= bgm.gy - 12 && wb.y <= bgm.y2 + 12) mode = 'l'
        else if (Math.abs(wb.x - bgm.bx2) <= 10 && wb.y >= bgm.y1 - 12 && wb.y <= bgm.gy + 12) mode = 'r'
        else if (Math.abs(wb.y - bgm.gy) <= 10 && wb.x >= bgm.bx1 - 12 && wb.x <= bgm.bx2 + 12) mode = 'h'
        if (mode) {
          e.stopPropagation()
          e.preventDefault()
          this.store.selectEdgeOnly(eb.id)
          this.gesture = { kind: 'brDrag', eid: eb.id, mode, moved: false, last: wb }
          return
        }
      }
    }
    if (tg.classList && tg.classList.contains('wp')) {
      const gW = tg.closest ? (tg.closest('.edge') as SVGGElement | null) : null
      if (!gW) return
      e.stopPropagation()
      e.preventDefault()
      this.store.selectEdgeOnly(gW.dataset.id ?? '')
      this.gesture = { kind: 'wpDrag', eid: gW.dataset.id ?? '', idx: Number(tg.dataset.i ?? 0), moved: false }
      return
    }
    if (tg.classList && tg.classList.contains('ep-h')) {
      const gE = tg.closest ? (tg.closest('.edge') as SVGGElement | null) : null
      if (!gE) return
      e.stopPropagation()
      e.preventDefault()
      const eidE = gE.dataset.id ?? ''
      const sideE = (tg.dataset.ep as 'from' | 'to') ?? 'from'
      this.store.selectEdgeOnly(eidE)
      const prim = this.edgeById(eidE)
      if (!prim) return
      const g = this.edgeGeom(prim)
      if (!g) return
      const prev = svgEl('path') as SVGPathElement
      prev.setAttribute('class', 'preview')
      this.edgesSvg.appendChild(prev)
      this.previewPath = prev
      this.gesture = {
        kind: 'rpDrag',
        eid: eidE,
        side: sideE,
        ax: sideE === 'to' ? g.x1 : g.x2,
        ay: sideE === 'to' ? g.y1 : g.y2,
      }
      return
    }
    if (tg.classList && (tg.classList.contains('elabel') || tg.classList.contains('elabel-hit'))) {
      const gg = tg.closest ? (tg.closest('.edge') as SVGGElement | null) : null
      if (!gg) return
      e.stopPropagation()
      e.preventDefault()
      const eid = gg.dataset.id ?? ''
      this.store.selectEdgeOnly(eid)
      this.gesture = { kind: 'lblDrag', eid, moved: false }
      return
    }
    const g = tg.closest ? (tg.closest('.edge') as SVGGElement | null) : null
    if (!g) return
    e.stopPropagation()
    const id = g.dataset.id ?? ''
    if (e.shiftKey) {
      this.store.toggleEdgeInSel(id)
    } else {
      this.store.selectEdgeOnly(id)
    }
  }

  private onEdgesDblClick = (e: MouseEvent) => {
    const tg = e.target as SVGElement
    if (tg.classList && tg.classList.contains('wp')) {
      const gW = tg.closest ? (tg.closest('.edge') as SVGGElement | null) : null
      if (!gW) return
      e.stopPropagation()
      e.preventDefault()
      const ed = this.edgeById(gW.dataset.id ?? '')
      if (ed && ed.pts) {
        this.store.removeWaypoint(ed.id, Number(tg.dataset.i ?? 0))
      }
    }
  }

  /* ── drag&drop из палитры ── */

  private clearDropVisuals() {
    this.canvas.classList.remove('dropready')
    document.body.classList.remove('dropping')
    this.setDropEdge(null)
    if (this.palHover) {
      this.palHover.classList.remove('drop-hover')
      this.palHover = null
    }
  }

  private onDragOver = (e: DragEvent) => {
    const ty = e.dataTransfer?.types
    if (!ty || (Array.from(ty).indexOf('text/vetvi-type') < 0 && Array.from(ty).indexOf('text/vetvi-clone') < 0)) return
    e.preventDefault()
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
    this.canvas.classList.add('dropready')
    document.body.classList.add('dropping')
    const elp = document.elementFromPoint(e.clientX, e.clientY)
    const under = this.elpp(elp)
    if (this.palHover && this.palHover !== under) this.palHover.classList.remove('drop-hover')
    this.palHover = under
    if (under) {
      under.classList.add('drop-hover')
      this.setDropEdge(null)
    } else {
      const w = this.toWorld(e.clientX, e.clientY)
      let hovId = this.nearestEdgeAt(w.x, w.y, 16 / this.store.getVp().z, undefined)
      if (hovId) {
        const hovE = this.edgeById(hovId)
        if (hovE && isBridge(hovE)) hovId = null
      }
      this.setDropEdge(hovId)
    }
  }

  private onDragLeave = () => {
    this.clearDropVisuals()
  }

  private onDrop = (e: DragEvent) => {
    const t = e.dataTransfer?.getData('text/vetvi-type') ?? ''
    const cl = e.dataTransfer?.getData('text/vetvi-clone') ?? ''
    if (!t && !cl) {
      this.clearDropVisuals()
      return
    }
    e.preventDefault()
    const eid = this.dropEdgeId
    const hoverNode = this.palHover
    this.clearDropVisuals()
    const w = this.toWorld(e.clientX, e.clientY)
    const edge = eid ? this.edgeById(eid) : null
    if (edge) {
      if (isBridge(edge)) {
        this.store.showToast?.('В мост нельзя вставить элемент', 'warn')
        return
      }
      if (t) {
        this.insertNewAtEdge(edge.id, t)
      } else {
        const src0 = cl ? this.nodeById(cl) : null
        if (src0) {
          const cn0 = this.store.cloneNode(src0, w.x - NODE_W / 2, w.y - 20)
          const eg = this.edgeGeom(edge)
          const sp = splitPtsAtHalf(edge, eg)
          this.store.performInsert(cn0, null, edge.id, sp[0] ?? [], sp[1] ?? [], { x: w.x, y: w.y })
        }
      }
      return
    }
    if (hoverNode) {
      const target = hoverNode.dataset.id ? this.nodeById(hoverNode.dataset.id) : null
      if (target) {
        if (cl && cl === target.id) {
          const srcX = this.nodeById(cl)
          if (srcX) {
            const cnX = this.store.cloneNode(srcX, w.x - NODE_W / 2, w.y - 20)
            this.store.insertNode(cnX, true)
          }
          return
        }
        this.attachNewTo(target, t || null, cl || null)
        return
      }
    }
    const ng = this.deepestGroupAt(w.x, w.y)
    if (t) {
      const nn = this.store.addNode(t, w.x - NODE_W / 2, w.y - 20, true)
      if (nn && ng) this.store.updateNode(nn.id, { gid: ng.id })
      return
    }
    const src = cl ? this.nodeById(cl) : null
    if (src) {
      const cn2 = this.store.cloneNode(src, w.x - NODE_W / 2, w.y - 20)
      if (ng) cn2.gid = ng.id
      this.store.insertNode(cn2, true)
    }
  }

  private insertNewAtEdge(edgeId: string, typeKey: string) {
    const e = this.edgeById(edgeId)
    if (!e) return
    const eg = this.edgeGeom(e)
    const p = eg ? edgeSample(eg, 0.5) : { x: 0, y: 0 }
    const sp = splitPtsAtHalf(e, eg)
    this.store.performInsert(null, { type: typeKey }, edgeId, sp[0] ?? [], sp[1] ?? [], p)
    this.store.showToast?.('Элемент встроен в связь')
  }

  private attachNewTo(target: VetviNode, typeKey: string | null, cloneId: string | null) {
    let nx = target.x + NODE_W + 70
    let ny = target.y
    if (this.store.snapOn) {
      nx = Math.round(nx / GRID) * GRID
      ny = Math.round(ny / GRID) * GRID
    }
    let n: VetviNode | null = null
    if (cloneId) {
      const src = this.nodeById(cloneId)
      if (!src) return
      n = this.store.cloneNode(src, nx, ny)
    } else if (typeKey) {
      const info = this.store.typeInfo(typeKey)
      n = {
        id: Math.random().toString(36).slice(2) + Date.now().toString(36),
        type: typeKey,
        gid: null,
        x: nx,
        y: ny,
        title: info.name,
        text: '',
        status: 'idea',
        tags: [],
        expand: 1,
        color: null,
        tint: 0,
        dlgWidth: null,
        notes: [],
        dialog: typeKey === 'dialog' ? { participants: [], description: '', replies: [] } : undefined,
      }
    }
    if (!n) return
    const tgtGroup = this.collapsedAncestorOf(target) ? null : this.deepestGroupAt(target.x + NODE_W / 2, target.y + 40)
    n.gid = tgtGroup ? tgtGroup.id : null
    this.store.insertNode(n)
    this.store.addEdge(target.id, n.id, null, false)
    this.store.resolveOverlaps(new Set([n.id]))
    this.store.selectOnly(n.id)
  }
}

/* ══════════════════════════════════════════════════════════════════ */
/* Утилиты                                                             */
/* ══════════════════════════════════════════════════════════════════ */

const STATUS: Record<string, string> = { idea: 'Идея', draft: 'В работе', done: 'Готово' }
const FOLD_ICONS = ['chev', 'chevUp', 'expand']
const FOLD_TITLES = ['Развернуть', 'Развернуть полностью', 'Свернуть']

function dlgSigReplies(replies: { id: string; speaker: string | null; text: string; children?: unknown[] }[]): string {
  return replies
    .map((r) => r.id + '~' + (r.speaker ?? '') + '~' + r.text + '~' + dlgSigReplies((r.children ?? []) as never))
    .join('|')
}

function esc(s: string | null | undefined): string {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c)
}

function ic(name: string, size = 15): string {
  return '<svg viewBox="0 0 24 24" width="' + size + '" height="' + size + '" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' + iconPath(name) + '</svg>'
}

function countReplies(replies: { children?: unknown[] }[]): number {
  let c = 0
  replies.forEach((r) => {
    c++
    if (r.children) c += countReplies(r.children as { children?: unknown[] }[])
  })
  return c
}

function dlgMaxDepth(replies: { children?: unknown[] }[], d = 0): number {
  let max = d
  replies.forEach((r) => {
    const ch = r.children as { children?: unknown[] }[] | undefined
    if (ch && ch.length) {
      const c = dlgMaxDepth(ch, d + 1)
      if (c > max) max = c
    }
  })
  return max
}

function noteIconSvg(size: number): string {
  return '<svg viewBox="0 0 24 24" width="' + size + '" height="' + size + '" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h9l4 4v14H6z"/><path d="M15 3v4h4"/><path d="M9 12h7M9 15.5h7M9 8.5h3"/></svg>'
}

/** Разрезает pts связи пополам (для встройки). */
function splitPtsAtHalf(e: VetviEdge, g: EdgeGeom | null): [{ x: number; y: number }[], { x: number; y: number }[]] {
  const pts = e.pts
  if (!pts || !pts.length || !g) return [[], []]
  const P: Pt[] = [{ x: g.x1, y: g.y1 }]
  pts.forEach((p) => P.push({ x: p.x, y: p.y }))
  P.push({ x: g.x2, y: g.y2 })
  const lens: number[] = []
  let total = 0
  for (let i = 1; i < P.length; i++) {
    const l = Math.hypot(P[i].x - P[i - 1].x, P[i].y - P[i - 1].y)
    lens.push(l)
    total += l
  }
  const half = total / 2
  let acc = 0
  const a: Pt[] = []
  const b: Pt[] = []
  for (let i = 1; i < P.length - 1; i++) {
    if (acc + lens[i - 1] < half) a.push({ x: P[i].x, y: P[i].y })
    else b.push({ x: P[i].x, y: P[i].y })
    acc += lens[i - 1]
  }
  return [a, b]
}

function isTyping(): boolean {
  const a = document.activeElement
  return !!a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || (a as HTMLElement).isContentEditable === true)
}
