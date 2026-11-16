'use client';

/**
 * Ветви — подписка на каналы стора (оптимизация перерисовок).
 *
 * Стор эмитит с каналом: 'all' | 'doc' | 'ui' | 'geom'. useStoreRev возвращает
 * счётчик своего канала — useSyncExternalStore перерисовывает компонент только
 * если ЕГО счётчик изменился. Высокочастотные geom-кадры (жесты холста) не
 * перерисовывают панели/модалки, панорама/зум не перерисовывают ничего.
 */

import { useSyncExternalStore } from 'react';

import type { VetviStore } from './store';

export type RevChannel = 'doc' | 'ui' | 'geom';

export function useStoreRev(store: VetviStore, ch: RevChannel): number {
  const get = ch === 'doc' ? store.getDocRev : ch === 'ui' ? store.getUiRev : store.getGeomRev;
  return useSyncExternalStore(store.subscribe, get, get);
}
