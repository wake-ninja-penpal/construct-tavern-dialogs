'use client';

/**
 * «Ветви» — React-редактор (ветка react-refactor, этап 1 порта).
 *
 * Редактор собран из компонентов src/vetvi/* (ядро без DOM пригодно и для
 * React Native). Классическая версия по-прежнему доступна целиком:
 * /vetvi/index.html — ссылка есть в тулбаре React-версии.
 *
 * ВАЖНО: здесь больше нет getStore() — стор создаётся только после прогрева
 * хранилища (storeBoot в VetviApp). Раньше эффект Home вызывал getStore()
 * сразу при монтировании — в режиме IndexedDB память была ещё пуста, и
 * синглтон навсегда «запоминал» пустой проект (локальные проекты терялись).
 */

import './vetvi.css';
import VetviApp from '@/vetvi/web/VetviApp';

export default function Home() {
  return <VetviApp />;
}
