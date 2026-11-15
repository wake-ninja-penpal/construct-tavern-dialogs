'use client';

/**
 * Ветви — измерения карточек и пинов (общий sink для холста).
 */

export interface MeasureSink {
  setSize(id: string, w: number, h: number): void;
  setPort(key: string, p: { x: number; y: number }): void;
}
