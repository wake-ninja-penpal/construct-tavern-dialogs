'use client';

/**
 * «Ветви» — React-редактор (ветка react-refactor, этап 1 порта).
 *
 * Редактор собран из компонентов src/vetvi/* (ядро без DOM пригодно и для
 * React Native). Классическая версия по-прежнему доступна целиком:
 * /vetvi/index.html — ссылка есть в тулбаре React-версии.
 */

import { useEffect } from 'react';

import './vetvi.css';
import VetviApp from '@/vetvi/web/VetviApp';
import { getStore } from '@/vetvi/web/store';

export default function Home() {
  // Восстановить последний вид при загрузке (хранится в автосохранении).
  useEffect(() => {
    const store = getStore();
    const save = () => store.flushSave();
    window.addEventListener('pagehide', save);
    return () => window.removeEventListener('pagehide', save);
  }, []);

  return <VetviApp />;
}
