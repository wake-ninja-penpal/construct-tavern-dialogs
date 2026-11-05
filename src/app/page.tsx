'use client';

import { useEffect, useRef } from 'react';

/**
 * «Ветви» — совместный конструктор нарратива.
 * Приложение (полный функционал vetvi33.html + realtime-слой) живёт в
 * /vetvi/index.html и открывается на весь экран один раз при монтировании.
 * Hash-часть URL (#room=…&project=…) передаётся в iframe при загрузке;
 * дальше приложение само управляет hash-ом родителя (same-origin),
 * поэтому повторно src НЕ присваивается — это вызывало перезагрузку
 * приложения и сброс режима копии.
 */
export default function Home() {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const bootedRef = useRef(false);

  useEffect(() => {
    if (bootedRef.current) return;
    bootedRef.current = true;
    if (frameRef.current) {
      frameRef.current.src = '/vetvi/index.html' + window.location.hash;
    }
  }, []);

  return (
    <main
      style={{
        position: 'fixed',
        inset: 0,
        background: '#0c0d0f',
      }}
      aria-label="Ветви — конструктор нарратива"
    >
      <iframe
        ref={frameRef}
        title="Ветви — конструктор нарратива"
        allow="clipboard-write; clipboard-read"
        style={{
          position: 'absolute',
          inset: 0,
          width: '100%',
          height: '100%',
          border: '0',
          display: 'block',
        }}
      />
    </main>
  );
}
