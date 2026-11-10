/**
 * Цветовые хелперы — порт из vetvi33.html.
 */

import { clamp } from './yjs-model'

export function hexToRgba(hex: string, a: number): string {
  let h = String(hex || '').replace('#', '')
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2]
  const r = parseInt(h.slice(0, 2), 16)
  const g = parseInt(h.slice(2, 4), 16)
  const b = parseInt(h.slice(4, 6), 16)
  if (isNaN(r) || isNaN(g) || isNaN(b)) return `rgba(154,161,172,${a})`
  return `rgba(${r},${g},${b},${a})`
}

export interface Rgb {
  r: number
  g: number
  b: number
}

export function hexToRgb(hex: string): Rgb | null {
  let h = String(hex || '').replace('#', '')
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2]
  const n = parseInt(h, 16)
  if (isNaN(n)) return null
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 }
}

export function rgbToHex(r: number, g: number, b: number): string {
  return (
    '#' +
    [r, g, b]
      .map((v) => {
        const c = clamp(Math.round(v), 0, 255)
        return ('0' + c.toString(16)).slice(-2)
      })
      .join('')
  )
}

export function shadeHex(hex: string, pct: number): string {
  const c = hexToRgb(hex)
  if (!c) return hex
  if (pct >= 0) {
    c.r += ((255 - c.r) * pct) / 100
    c.g += ((255 - c.g) * pct) / 100
    c.b += ((255 - c.b) * pct) / 100
  } else {
    c.r *= 1 + pct / 100
    c.g *= 1 + pct / 100
    c.b *= 1 + pct / 100
  }
  return rgbToHex(c.r, c.g, c.b)
}

/** Итоговый цвет фона узла с учётом tint. */
export function nodePaint(color: string, tint: number): string {
  return shadeHex(color, clamp(tint, -60, 60))
}

export function slug(s: string): string {
  const r = (s || 'proekt')
    .toLowerCase()
    .replace(/[^a-zа-яё0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '')
  return r.slice(0, 60) || 'proekt'
}

export function fmtD(iso: string | number): string {
  try {
    return new Date(iso).toLocaleDateString('ru-RU', {
      day: '2-digit',
      month: 'short',
      year: 'numeric',
    })
  } catch {
    return '—'
  }
}
