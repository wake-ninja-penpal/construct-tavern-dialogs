'use client';

/**
 * Ветви — подписка на каналы стора (оптимизация перерисовок).
 *
 * Стор эмитит с каналом: 'all' | 'doc' | 'ui' | 'geom' | 'view'. useStoreRev возвращает
 * счётчик своего канала — useSyncExternalStore перерисовывает компонент только
 * если ЕГО счётчик изменился. Высокочастотные geom-кадры (жесты холста) не
 * перерисовывают панели/модалки; view-кадры (панорама/зум) не перерисовывают
 * вообще ничего — вид применяется императивно (canvasApi.applyVp).
 */

import { useSyncExternalStore } from 'react';

import type { VetviStore } from './store';

export type RevChannel = 'doc' | 'ui' | 'geom' | 'view';

export function useStoreRev(store: VetviStore, ch: RevChannel): number {
  const get = ch === 'doc' ? store.getDocRev : ch === 'ui' ? store.getUiRev : ch === 'geom' ? store.getGeomRev : store.getViewRev;
  return useSyncExternalStore(store.subscribe, get, get);
}
