'use client';

/**
 * Ветви — плавающее окно «Распределить по строкам» (#dstWin оригинала,
 * 893–903 CSS, 1246–1257 разметка, 6672–6831 поведение).
 *
 * Внутри: кнопка «больше» (#dstUp), поле значения (#dstVal, clamp 1..N),
 * кнопка «меньше» (#dstDown), подсказка «элементов в строке», «Готово»
 * (#dstDone). Перетаскивание за шапку с clamp внутрь #stage (6810–6831),
 * позиция по умолчанию — правый верх холста (placeDstWinDefault, 6746).
 * Каждый сдвиг значения сразу переприсовывает ноды (dstApply → layoutRows).
 */

import { useEffect, useRef, useState } from 'react';

import type { VetviStore } from './store';

export function DstWin({ store }: { store: VetviStore }) {
  const k = store.dstState.k;
  const n = store.dstState.ids ? store.dstState.ids.length : 0;
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const winRef = useRef<HTMLDivElement | null>(null);
  const [val, setVal] = useState(String(k));

  useEffect(() => { setVal(String(k)); }, [k]);

  /* placeDstWinDefault (6746–6756): правый верх #stage */
  useEffect(() => {
    const w = winRef.current;
    const st = document.getElementById('stage');
    if (!w || !st) return;
    const r = st.getBoundingClientRect();
    const ww = w.offsetWidth || 170, wh = w.offsetHeight || 150;
    const left = Math.max(r.left + 8, Math.min(r.right - ww - 24, r.right - ww - 24));
    const top = Math.max(r.top + 8, Math.min(r.top + 40, r.bottom - wh - 8));
    setPos({ x: left, y: top });
  }, []);

  /* перетаскивание за шапку (6810–6831) */
  const onHeadDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest && (e.target as HTMLElement).closest('.dst-win-close')) return;
    e.preventDefault();
    const w = winRef.current;
    const st = document.getElementById('stage');
    if (!w || !st) return;
    const r = w.getBoundingClientRect();
    const ox = e.clientX - r.left, oy = e.clientY - r.top;
    const mv = (ev: PointerEvent) => {
      const sr = st.getBoundingClientRect();
      const ww = w.offsetWidth, wh = w.offsetHeight;
      const L = Math.max(sr.left + 4, Math.min(ev.clientX - ox, sr.right - ww - 4));
      const T = Math.max(sr.top + 4, Math.min(ev.clientY - oy, sr.bottom - wh - 4));
      setPos({ x: L, y: T });
    };
    const up = () => {
      window.removeEventListener('pointermove', mv);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', mv);
    window.addEventListener('pointerup', up);
  };

  const style: React.CSSProperties = pos
    ? { left: pos.x, top: pos.y, position: 'fixed', display: 'flex' }
    : { display: 'flex', visibility: 'hidden', position: 'fixed' };

  return (
    <div id="dstWin" className="dst-win" ref={winRef} style={style} role="dialog" aria-label="Распределить по строкам">
      <div className="dst-win-head" id="dstWinHead" onPointerDown={onHeadDown}>
        <span className="dst-win-title">Распределить по строкам</span>
        <button type="button" className="dst-win-close" id="dstWinClose" title="Закрыть" onClick={() => store.closeDstWin()}>×</button>
      </div>
      <div className="dst-win-body">
        <button type="button" className="btn ibtn" id="dstUp" title="Больше элементов в строке" onClick={() => store.dstSetK(k + 1)}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="m6 15 6-6 6 6" /></svg>
        </button>
        <input
          id="dstVal"
          className="dst-val"
          value={val}
          inputMode="numeric"
          maxLength={3}
          onChange={(e) => {
            const v = parseInt(e.target.value, 10);
            if (isNaN(v)) { setVal(e.target.value); return; }
            const c = Math.max(1, Math.min(n || 1, v));
            setVal(String(c));
            if (c !== k) store.dstSetK(c);
          }}
          onBlur={() => setVal(String(k))}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            else if (e.key === 'ArrowUp') { e.preventDefault(); store.dstSetK(k + 1); }
            else if (e.key === 'ArrowDown') { e.preventDefault(); store.dstSetK(k - 1); }
          }}
        />
        <button type="button" className="btn ibtn" id="dstDown" title="Меньше элементов в строке" onClick={() => store.dstSetK(k - 1)}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round"><path d="m6 9 6 6 6-6" /></svg>
        </button>
        <div className="dst-hint">элементов в строке</div>
        <button type="button" className="btn primary" id="dstDone" style={{ width: '100%', justifyContent: 'center', marginTop: 6 }} onClick={() => store.closeDstWin()}>
          Готово
        </button>
      </div>
    </div>
  );
}
