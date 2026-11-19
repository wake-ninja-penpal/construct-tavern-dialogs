'use client';

/**
 * Ветви — «хлястик» панели: маленькая кнопка-язычок НАРУЖИ панели (в верхней
 * части блока), за которую можно ПОТЯНУТЬ, чтобы свернуть/развернуть панель,
 * или просто нажать (как прежние кнопки сворачивания в шапках панелей).
 *
 * side='l' — панель слева, язычок торчит вправо (тянут влево — свернуть,
 *            вправо — развернуть). side='r' — панель справа, язычок торчит
 *            влево (тянут вправо — свернуть, влево — развернуть).
 *
 * Тянуть = потянуть курсором за язычок на ≥ PULL_THRESHOLD: на отпускании
 * срабатывает onPull(±1) — направление в экранных осях X. Клик (сдвиг меньше
 * CLICK_MAX) — обычный toggle onToggle. Сам язычок при потягивании смещается
 * за курсором (до ±PULL_VISUAL) и отпружинивает обратно на отпускании.
 */

import { useRef } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';

const PULL_THRESHOLD = 26;
const CLICK_MAX = 6;
const PULL_VISUAL = 30;

const P_CHEV_L = '<path d="m15 6-6 6 6 6"/>';
const P_CHEV_R = '<path d="m9 6 6 6-6 6"/>';

export function PanelTab(props: {
  side: 'l' | 'r';
  open: boolean;
  title: string;
  onToggle: () => void;
  onPull: (dir: 1 | -1) => void;
}) {
  const ref = useRef<HTMLButtonElement | null>(null);
  const drag = useRef<{ x: number } | null>(null);
  /* флаг «это был drag, а не клик» — гасит native click, который браузер
     всё равно генерирует после pointerup (setPointerCapture возвращает
     клик на кнопку даже при смещении) */
  const suppressClick = useRef(false);

  const down = (e: ReactPointerEvent<HTMLButtonElement>) => {
    if (e.button !== 0) return;
    drag.current = { x: e.clientX };
    suppressClick.current = false;
    try { ref.current?.setPointerCapture(e.pointerId); } catch { /* нет capture */ }
    document.body.classList.add('ptab-drag');
  };

  const move = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const d = drag.current;
    if (!d || !ref.current) return;
    const dx = e.clientX - d.x;
    if (Math.abs(dx) > CLICK_MAX) suppressClick.current = true;
    const cl = Math.max(-PULL_VISUAL, Math.min(PULL_VISUAL, dx));
    ref.current.style.transform = 'translateX(' + cl + 'px)';
  };

  const finish = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const d = drag.current;
    drag.current = null;
    document.body.classList.remove('ptab-drag');
    if (ref.current) ref.current.style.transform = '';
    if (!d) return;
    try { ref.current?.releasePointerCapture(e.pointerId); } catch { /* уже отпущен */ }
    const dx = e.clientX - d.x;
    if (Math.abs(dx) > CLICK_MAX) suppressClick.current = true; /* был сдвиг — не клик */
    if (Math.abs(dx) >= PULL_THRESHOLD) props.onPull(dx > 0 ? 1 : -1);
  };

  const click = () => {
    if (suppressClick.current) { suppressClick.current = false; return; }
    props.onToggle();
  };

  return (
    <button
      ref={ref}
      type="button"
      className={'ptab ptab-' + props.side}
      title={props.title}
      aria-label={props.title}
      aria-expanded={props.open}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={finish}
      onPointerCancel={() => {
        drag.current = null;
        suppressClick.current = true; /* отмена жеста — не считать кликом */
        document.body.classList.remove('ptab-drag');
        if (ref.current) ref.current.style.transform = '';
      }}
      onClick={click}
    >
      <svg viewBox="0 0 24 24" width={11} height={11} fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <g dangerouslySetInnerHTML={{ __html: (props.side === 'l') === props.open ? P_CHEV_L : P_CHEV_R }} />
      </svg>
    </button>
  );
}
