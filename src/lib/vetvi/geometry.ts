/**
 * Геометрия связей — точный порт vetvi33.html:
 * плавные кривые (Catmull-Rom/Безье), ортогональные 90°/45°, мосты,
 * сэмплирование, подписи, точки излома.
 */

import type { VetviEdge, EdgePt, BendMode, BridgeOffsets } from './types'

export interface GeomPoint {
  x: number
  y: number
}

export interface EdgeGeom {
  x1: number
  y1: number
  x2: number
  y2: number
  pts: EdgePt[] | null
  bend: BendMode
  corners: GeomPoint[] | null
}

export function clamp(v: number, a: number, b: number): number {
  return Math.max(a, Math.min(b, v))
}

export function isBridge(e: VetviEdge): boolean {
  return e.kind === 'bridge'
}

/* ── Мосты ── */

export interface BridgeGeom {
  x1: number
  y1: number
  x2: number
  y2: number
  bx1: number
  bx2: number
  gy: number
}

/** Геометрия моста — точный порт: gy = (низ from + верх to) / 2 + dy. */
export function bridgeGeom(
  e: VetviEdge,
  na: GeomPoint,
  wA: number,
  hA: number,
  nb: GeomPoint,
  wB: number,
  hB: number,
): BridgeGeom {
  const bd: BridgeOffsets = e.bd ?? { dl: 0, dy: 0, dr: 0 }
  const x1 = na.x + wA
  const y1 = na.y + hA / 2
  const x2 = nb.x
  const y2 = nb.y + hB / 2
  const gy0 = (na.y + hA + nb.y) / 2
  return { x1, y1, x2, y2, bx1: x2 - 56 + bd.dl, bx2: x1 + 30 + bd.dr, gy: gy0 + bd.dy }
}

export function bridgeCorners(bg: BridgeGeom): GeomPoint[] {
  return [
    { x: bg.bx2, y: bg.y1 },
    { x: bg.bx2, y: bg.gy },
    { x: bg.bx1, y: bg.gy },
    { x: bg.bx1, y: bg.y2 },
  ]
}

/* ── Ортогональные маршруты ── */

export function routeOrtho(P: GeomPoint[]): GeomPoint[] {
  const R: GeomPoint[] = [P[0]]
  const last = P.length - 1
  for (let i = 1; i < P.length; i++) {
    const a = R[R.length - 1]
    const b = P[i]
    if (i === last) {
      if (Math.abs(b.y - a.y) < 1) {
        R.push(b)
        continue
      }
      const e = { x: b.x - 26, y: b.y }
      if (Math.abs(e.x - a.x) >= 1) R.push({ x: e.x, y: a.y })
      R.push(e)
      R.push(b)
      continue
    }
    if (Math.abs(b.x - a.x) < 1 || Math.abs(b.y - a.y) < 1) {
      R.push(b)
      continue
    }
    R.push({ x: b.x, y: a.y })
    R.push(b)
  }
  return R
}

export function routeOrtho45(P: GeomPoint[]): GeomPoint[] {
  const R: GeomPoint[] = [P[0]]
  const last = P.length - 1
  for (let i = 1; i < P.length; i++) {
    let a = R[R.length - 1]
    const b = P[i]
    const isFirst = i === 1
    const isLast = i === last
    let dx = b.x - a.x
    let dy = b.y - a.y
    if (isFirst && isLast) {
      const stub = Math.min(26, Math.max(10, Math.abs(dx) * 0.5))
      const s1 = { x: a.x + (dx >= 0 ? stub : -stub), y: a.y }
      const e = { x: b.x - 26, y: b.y }
      R.push(s1)
      const dx2 = e.x - s1.x
      const dy2 = e.y - s1.y
      if (Math.abs(dy2) < 1) R.push(e)
      else if (Math.abs(dx2) >= Math.abs(dy2)) {
        R.push({ x: s1.x + (dx2 >= 0 ? 1 : -1) * Math.abs(dy2), y: e.y })
        R.push(e)
      } else {
        R.push({ x: e.x, y: s1.y + (dy2 >= 0 ? 1 : -1) * Math.abs(dx2) })
        R.push(e)
      }
      R.push(b)
      continue
    }
    if (isFirst) {
      const stubF = Math.min(26, Math.max(10, Math.abs(dx) * 0.5))
      const s1f = { x: a.x + (dx >= 0 ? stubF : -stubF), y: a.y }
      R.push(s1f)
      a = s1f
      dx = b.x - a.x
      dy = b.y - a.y
    }
    if (isLast) {
      if (Math.abs(dy) < 1) {
        R.push(b)
        continue
      }
      const eL = { x: b.x - 26, y: b.y }
      const exL = eL.x - a.x
      const eyL = eL.y - a.y
      if (exL === 0 || eyL === 0) {
        R.push(eL)
      } else {
        const aex = Math.abs(exL)
        const aey = Math.abs(eyL)
        const sxe = exL > 0 ? 1 : -1
        const sye = eyL > 0 ? 1 : -1
        if (aex >= aey) R.push({ x: a.x + sxe * (aex - aey), y: a.y })
        else R.push({ x: a.x, y: a.y + sye * (aey - aex) })
        R.push(eL)
      }
      R.push(b)
      continue
    }
    if (dx === 0 || dy === 0) {
      R.push(b)
      continue
    }
    const adx = Math.abs(dx)
    const ady = Math.abs(dy)
    const sx = dx > 0 ? 1 : -1
    const sy = dy > 0 ? 1 : -1
    if (adx >= ady) R.push({ x: a.x + sx * (adx - ady), y: a.y })
    else R.push({ x: a.x, y: a.y + sy * (ady - adx) })
    R.push(b)
  }
  return R
}

export function filletPath(R: GeomPoint[], r: number): string {
  if (R.length < 2) return ''
  if (R.length === 2) return `M${R[0].x} ${R[0].y} L${R[1].x} ${R[1].y}`
  let d = `M${R[0].x} ${R[0].y}`
  for (let i = 1; i < R.length - 1; i++) {
    const p0 = R[i - 1]
    const p1 = R[i]
    const p2 = R[i + 1]
    const v1x = p1.x - p0.x
    const v1y = p1.y - p0.y
    const l1 = Math.hypot(v1x, v1y) || 1
    const v2x = p2.x - p1.x
    const v2y = p2.y - p1.y
    const l2 = Math.hypot(v2x, v2y) || 1
    const rr = Math.min(r, l1 / 2, l2 / 2)
    if (rr < 1) {
      d += ` L${p1.x} ${p1.y}`
      continue
    }
    const ax = p1.x - (v1x / l1) * rr
    const ay = p1.y - (v1y / l1) * rr
    const bx = p1.x + (v2x / l2) * rr
    const by = p1.y + (v2y / l2) * rr
    d += ` L${ax} ${ay} Q${p1.x} ${p1.y} ${bx} ${by}`
  }
  d += ` L${R[R.length - 1].x} ${R[R.length - 1].y}`
  return d
}

/* ── Сглаживание ── */

export function catmullPath(P: GeomPoint[]): string {
  if (P.length < 2) return ''
  if (P.length === 2) return `M${P[0].x} ${P[0].y} L${P[1].x} ${P[1].y}`
  let d = `M${P[0].x} ${P[0].y}`
  for (let i = 0; i < P.length - 1; i++) {
    const p0 = P[i - 1] || P[i]
    const p1 = P[i]
    const p2 = P[i + 1]
    const p3 = P[i + 2] || p2
    const c1x = p1.x + (p2.x - p0.x) / 6
    const c1y = p1.y + (p2.y - p0.y) / 6
    const c2x = p2.x - (p3.x - p1.x) / 6
    const c2y = p2.y - (p3.y - p1.y) / 6
    d += ` C${c1x} ${c1y}, ${c2x} ${c2y}, ${p2.x} ${p2.y}`
  }
  return d
}

export function samplePolyline(P: GeomPoint[], t: number): GeomPoint {
  const lens: number[] = []
  let total = 0
  for (let i = 1; i < P.length; i++) {
    const l = Math.hypot(P[i].x - P[i - 1].x, P[i].y - P[i - 1].y)
    lens.push(l)
    total += l
  }
  if (total < 0.001) return { x: P[0].x, y: P[0].y }
  const target = t * total
  let acc = 0
  for (let i = 0; i < lens.length; i++) {
    if (acc + lens[i] >= target) {
      const k = lens[i] ? (target - acc) / lens[i] : 0
      return { x: P[i].x + (P[i + 1].x - P[i].x) * k, y: P[i].y + (P[i + 1].y - P[i].y) * k }
    }
    acc += lens[i]
  }
  return { x: P[P.length - 1].x, y: P[P.length - 1].y }
}

export function catmullSample(P: GeomPoint[], t: number): GeomPoint {
  const pts: GeomPoint[] = []
  const per = 8
  for (let i = 0; i < P.length - 1; i++) {
    const p0 = P[i - 1] || P[i]
    const p1 = P[i]
    const p2 = P[i + 1]
    const p3 = P[i + 2] || p2
    const c1x = p1.x + (p2.x - p0.x) / 6
    const c1y = p1.y + (p2.y - p0.y) / 6
    const c2x = p2.x - (p3.x - p1.x) / 6
    const c2y = p2.y - (p3.y - p1.y) / 6
    for (let j = 0; j < per; j++) {
      const u = j / per
      const m = 1 - u
      pts.push({
        x: m * m * m * p1.x + 3 * m * m * u * c1x + 3 * m * u * u * c2x + u * u * u * p2.x,
        y: m * m * m * p1.y + 3 * m * m * u * c1y + 3 * m * u * u * c2y + u * u * u * p2.y,
      })
    }
  }
  pts.push(P[P.length - 1])
  return samplePolyline(pts, t)
}

function simpleBezierD(g: EdgeGeom): string {
  const dx =
    g.x2 >= g.x1
      ? clamp((g.x2 - g.x1) * 0.55, 46, 190)
      : clamp((g.x1 - g.x2) * 0.5 + 60, 70, 240)
  return `M${g.x1} ${g.y1} C ${g.x1 + dx} ${g.y1}, ${g.x2 - dx} ${g.y2}, ${g.x2} ${g.y2}`
}

function simpleBezierPoint(g: EdgeGeom, t: number): GeomPoint {
  const dx =
    g.x2 >= g.x1
      ? clamp((g.x2 - g.x1) * 0.55, 46, 190)
      : clamp((g.x1 - g.x2) * 0.5 + 60, 70, 240)
  const m = 1 - t
  return {
    x: m * m * m * g.x1 + 3 * m * m * t * (g.x1 + dx) + 3 * m * t * t * (g.x2 - dx) + t * t * t * g.x2,
    y: m * m * m * g.y1 + 3 * m * m * t * g.y1 + 3 * m * t * t * g.y2 + t * t * t * g.y2,
  }
}

/** Итоговый SVG-путь связи. */
export function edgePathD(g: EdgeGeom): string {
  if (g.corners && g.corners.length) {
    return filletPath([{ x: g.x1, y: g.y1 }, ...g.corners, { x: g.x2, y: g.y2 }], 12)
  }
  const P: GeomPoint[] = [{ x: g.x1, y: g.y1 }]
  if (g.pts) for (const p of g.pts) P.push({ x: p.x, y: p.y })
  P.push({ x: g.x2, y: g.y2 })
  const mode = g.bend || 'smooth'
  if (mode === 'ortho90') return filletPath(routeOrtho(P), 12)
  if (mode === 'ortho45') return filletPath(routeOrtho45(P), 12)
  if (P.length > 2) return catmullPath(P)
  return simpleBezierD(g)
}

/** Точка на связи по параметру t∈[0,1]. */
export function edgeSample(g: EdgeGeom, t: number): GeomPoint {
  if (g.corners && g.corners.length) {
    const Q: GeomPoint[] = [{ x: g.x1, y: g.y1 }, ...g.corners, { x: g.x2, y: g.y2 }]
    return samplePolyline(Q, t)
  }
  const P: GeomPoint[] = [{ x: g.x1, y: g.y1 }]
  if (g.pts) for (const p of g.pts) P.push({ x: p.x, y: p.y })
  P.push({ x: g.x2, y: g.y2 })
  const mode = g.bend || 'smooth'
  if (mode === 'ortho90') return samplePolyline(routeOrtho(P), t)
  if (mode === 'ortho45') return samplePolyline(routeOrtho45(P), t)
  if (P.length > 2) return catmullSample(P, t)
  return simpleBezierPoint(g, t)
}

/** Позиция подписи на связи. */
export function labelPos(e: Pick<VetviEdge, 'lt' | 'lp'>, g: EdgeGeom): GeomPoint {
  const lt = typeof e.lt === 'number' ? clamp(e.lt, 0.04, 0.96) : 0.5
  const p = edgeSample(g, lt)
  const p2 = edgeSample(g, Math.min(1, lt + 0.02))
  const p0 = edgeSample(g, Math.max(0, lt - 0.02))
  const tx = p2.x - p0.x
  const ty = p2.y - p0.y
  const l = Math.hypot(tx, ty) || 1
  const nx = -ty / l
  const ny = tx / l
  const off = typeof e.lp === 'number' ? clamp(e.lp, -44, 44) : 0
  return { x: p.x + nx * off, y: p.y + ny * off }
}

/** Ближайшая точка на связи к мировой точке. */
export function nearestPointOnEdge(g: EdgeGeom, w: GeomPoint): { p: GeomPoint; t: number } {
  let best: GeomPoint | null = null
  let bd = 1e9
  let bt = 0.5
  for (let i = 0; i <= 40; i++) {
    const p = edgeSample(g, i / 40)
    const d = Math.hypot(p.x - w.x, p.y - w.y)
    if (d < bd) {
      bd = d
      best = p
      bt = i / 40
    }
  }
  return best ? { p: best, t: bt } : { p: { x: w.x, y: w.y }, t: 0.5 }
}

/** Индекс сегмента полилинии, ближайшего к точке (для вставки излома). */
export function nearestSegIndex(g: EdgeGeom, w: GeomPoint): number {
  const P: GeomPoint[] = [{ x: g.x1, y: g.y1 }]
  if (g.pts) for (const p of g.pts) P.push({ x: p.x, y: p.y })
  P.push({ x: g.x2, y: g.y2 })
  let best = 0
  let bd = 1e9
  for (let i = 1; i < P.length; i++) {
    const ax = P[i - 1].x
    const ay = P[i - 1].y
    const bx = P[i].x
    const by = P[i].y
    const vx = bx - ax
    const vy = by - ay
    const len2 = vx * vx + vy * vy || 1
    const t = clamp(((w.x - ax) * vx + (w.y - ay) * vy) / len2, 0, 1)
    const px = ax + vx * t
    const py = ay + vy * t
    const d = Math.hypot(w.x - px, w.y - py)
    if (d < bd) {
      bd = d
      best = i - 1
    }
  }
  return best
}

/** Пересечение отрезков (для ножа). */
export function segIntersect(a: GeomPoint, b: GeomPoint, c: GeomPoint, d: GeomPoint): boolean {
  const r1x = b.x - a.x
  const r1y = b.y - a.y
  const r2x = d.x - c.x
  const r2y = d.y - c.y
  const den = r1x * r2y - r1y * r2x
  if (Math.abs(den) < 1e-9) return false
  const t = ((c.x - a.x) * r2y - (c.y - a.y) * r2x) / den
  const u = ((c.x - a.x) * r1y - (c.y - a.y) * r1x) / den
  return t >= 0 && t <= 1 && u >= 0 && u <= 1
}
