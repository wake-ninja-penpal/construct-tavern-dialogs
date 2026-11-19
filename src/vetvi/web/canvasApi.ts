/**
 * Ветви — мост между глобальными обработчиками и холстом (fit/zoom/центрирование).
 * applyVp/measurePorts — императивное применение вида (панорама/зум без перерисовки
 * React) и пересчёт портов пинов при смене зума.
 */

import type { NodeSize, VetviViewport } from '@/vetvi/core/types';

export interface CanvasApi {
  getRect(): { width: number; height: number } | null;
  sizes: Map<string, NodeSize>;
  centerOn(id: string): void;
  /** Императивно применить вид: #world transform, сетка, миникарта, %, ярлыки. */
  applyVp(vp: VetviViewport): void;
  /** Пересчитать мировые позиции портов пинов (после смены зума). */
  measurePorts(): void;
}

export const canvasApi: { current: CanvasApi | null } = { current: null };
