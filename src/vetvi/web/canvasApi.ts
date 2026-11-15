/**
 * Ветви — мост между глобальными обработчиками и холстом (fit/zoom/центрирование).
 */

import type { NodeSize } from '@/vetvi/core/types';

export interface CanvasApi {
  getRect(): { width: number; height: number } | null;
  sizes: Map<string, NodeSize>;
  centerOn(id: string): void;
}

export const canvasApi: { current: CanvasApi | null } = { current: null };
