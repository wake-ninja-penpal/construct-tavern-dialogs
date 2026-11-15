'use client';

/**
 * Ветви — кадрирование аватара: 1:1 порт модалки #cropWrap классической версии
 * (openAvatarCrop / cropApplyView / cropSetZoom / cropApply / closeAvatarCrop + биндинги stage,
 * оригинал строки 1777–1892). Квадратная рамка по центру .crop-stage, картинка тянется,
 * слайдер масштаба 100..400 (зум вокруг центра рамки), «Сброс», «Отмена», «Применить»,
 * клик по фону и Escape закрывают. Классы, id и структура DOM совпадают с оригиналом —
 * новых стилей нет, vetvi.css применяется как есть.
 *
 * Отличие по контракту: здесь только геометрия кадра — «Применить» рисует выбранную
 * область исходника на canvas и отдаёт dataURL в req.onDone; сжатие до аватара
 * (192px webp → 128px jpeg, ≤60К символов — avCompressCrop оригинала) выполняет
 * вызывающий (LeftPane) тем же кодом, что раньше fileToAvatar.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

import { clamp } from '@/vetvi/core/geometry';
import type { VetviStore } from './store';

/** Состояние кадрирования — аналог var cropS оригинала. */
type CropS = {
  img: HTMLImageElement;
  iw: number;
  ih: number;
  fx: number;
  fy: number;
  side: number;
  base: number;
  zoom: number;
  dx: number;
  dy: number;
  drag: { x: number; y: number; dx: number; dy: number } | null;
};

/** Запрос кадрирования: {src, onDone, onCancel} | null — создаёт LeftPane при выборе файла. */
export type CropReq = {
  src: string;
  /** «Применить»: dataURL области кадра из исходной картинки (без сжатия). */
  onDone: (dataUrl: string) => void;
  /** «Отмена»/клик по фону/Escape: ничего не сохранять. */
  onCancel: () => void;
};

export function CropModal(props: { store: VetviStore; req: CropReq; onClose: () => void }) {
  const { store, req, onClose } = props;
  const [shown, setShown] = useState(false);
  const s = useRef<CropS | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const frameRef = useRef<HTMLDivElement | null>(null);
  const zoomRef = useRef<HTMLInputElement | null>(null);

  /* cropApplyView оригинала: размер/позиция картинки, рамка всегда внутри картинки */
  const applyView = useCallback(() => {
    const cs = s.current;
    const imgEl = imgRef.current;
    if (!cs || !imgEl) return;
    const scale = cs.base * cs.zoom;
    const dw = cs.iw * scale;
    const dh = cs.ih * scale;
    const loX = cs.fx + cs.side - dw;
    const loY = cs.fy + cs.side - dh;
    cs.dx = clamp(cs.dx, Math.min(loX, cs.fx), cs.fx);
    cs.dy = clamp(cs.dy, Math.min(loY, cs.fy), cs.fy);
    imgEl.style.width = dw + 'px';
    imgEl.style.height = dh + 'px';
    imgEl.style.left = cs.dx + 'px';
    imgEl.style.top = cs.dy + 'px';
  }, []);

  /* cropSetZoom оригинала: зум вокруг ЦЕНТРА РАМКИ — точка картинки под центром сохраняется */
  const setZoom = useCallback((z: number) => {
    const cs = s.current;
    if (!cs) return;
    z = clamp(z, 1, 4);
    const s0 = cs.base * cs.zoom;
    const s1 = cs.base * z;
    if (s0 <= 0) {
      cs.zoom = z;
      applyView();
      return;
    }
    const cx = cs.fx + cs.side / 2;
    const cy = cs.fy + cs.side / 2;
    const px = (cx - cs.dx) / s0;
    const py = (cy - cs.dy) / s0;
    cs.zoom = z;
    cs.dx = cx - px * s1;
    cs.dy = cy - py * s1;
    applyView();
  }, [applyView]);

  /* closeAvatarCrop оригинала: закрыть без сохранения (unmount убирает wrap и img.src) */
  const cancel = useCallback(() => {
    req.onCancel();
    onClose();
  }, [req, onClose]);

  /* openAvatarCrop оригинала: прелоад исходника, после — показ wrap и расстановка рамки */
  useEffect(() => {
    let dead = false;
    const img = new Image();
    if (/^https?:\/\//i.test(req.src)) img.crossOrigin = 'anonymous';
    img.onload = () => {
      if (dead) return;
      const iw = img.naturalWidth || img.width;
      const ih = img.naturalHeight || img.height;
      if (!iw || !ih) {
        store.toast('Не удалось прочитать изображение', 'warn');
        onClose();
        return;
      }
      s.current = { img, iw, ih, fx: 0, fy: 0, side: 0, base: 1, zoom: 1, dx: 0, dy: 0, drag: null };
      setShown(true); /* wrap получает .show — рамку расставит layout-эффект ниже */
    };
    img.onerror = () => {
      if (dead) return;
      store.toast('Картинка не открылась — кадрирование недоступно', 'warn');
      onClose();
    };
    img.src = req.src;
    return () => {
      dead = true;
    };
  }, [req.src, store, onClose]);

  /* рамка и начальный вид — как в openAvatarCrop после показа wrap (синхронно до первой отрисовки) */
  useLayoutEffect(() => {
    if (!shown) return;
    const cs = s.current;
    const stage = stageRef.current;
    const fr = frameRef.current;
    if (!cs || !stage || !fr) return;
    const stW = stage.clientWidth || stage.offsetWidth;
    const stH = stage.clientHeight || stage.offsetHeight;
    const side = Math.max(80, Math.floor(Math.min(stW, stH)) - 56);
    const fx = Math.floor((stW - side) / 2);
    const fy = Math.floor((stH - side) / 2);
    fr.style.left = fx + 'px';
    fr.style.top = fy + 'px';
    fr.style.width = side + 'px';
    fr.style.height = side + 'px';
    /* начальный масштаб: картинка целиком покрывает рамку (центр-кроп по умолчанию) */
    const base = Math.max(side / cs.iw, side / cs.ih);
    cs.fx = fx;
    cs.fy = fy;
    cs.side = side;
    cs.base = base;
    cs.zoom = 1;
    cs.drag = null;
    cs.dx = fx + (side - cs.iw * base) / 2;
    cs.dy = fy + (side - cs.ih * base) / 2;
    if (zoomRef.current) zoomRef.current.value = '100';
    applyView();
  }, [shown, applyView]);

  /* колесо мыши над stage: зум ±10% за шаг с синхронизацией слайдера.
     Нативный слушатель passive:false — React вешает wheel пассивно, preventDefault нужен как в оригинале */
  useEffect(() => {
    if (!shown) return;
    const stage = stageRef.current;
    if (!stage) return;
    const onWheel = (e: WheelEvent) => {
      const cs = s.current;
      if (!cs) return;
      e.preventDefault();
      const nz = clamp(cs.zoom * (e.deltaY < 0 ? 1.1 : 0.9), 1, 4);
      setZoom(nz);
      const sl = zoomRef.current;
      if (sl) sl.value = String(Math.round(nz * 100));
    };
    stage.addEventListener('wheel', onWheel, { passive: false });
    return () => stage.removeEventListener('wheel', onWheel);
  }, [shown, setZoom]);

  /* Escape закрывает модалку — document keydown оригинала (действует, когда cropS задан) */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!s.current || e.key !== 'Escape') return;
      e.preventDefault();
      cancel();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [cancel]);

  /* cropApply оригинала: область кадра → canvas → dataURL в req.onDone.
     Геометрия и clamp'ы — как в cropApply/avCompressCrop; сжатие (192px webp → 128px jpeg)
     делает вызывающий, поэтому экспорт без потерь ('image/png') в native-размере кадра */
  const applyCrop = () => {
    const cs = s.current;
    if (!cs) return;
    const scale = cs.base * cs.zoom;
    const sx = (cs.fx - cs.dx) / scale;
    const sy = (cs.fy - cs.dy) / scale;
    const side = cs.side / scale;
    try {
      const w = cs.img.naturalWidth || cs.img.width;
      const h = cs.img.naturalHeight || cs.img.height;
      if (!w || !h) {
        store.toast('Не удалось прочитать изображение', 'warn');
        return;
      }
      const x = clamp(sx, 0, w - 8);
      const y = clamp(sy, 0, h - 8);
      const sd = clamp(side, 8, Math.min(w - x, h - y));
      const cv = document.createElement('canvas');
      cv.width = sd;
      cv.height = sd;
      const ctx = cv.getContext('2d');
      if (!ctx) return;
      ctx.drawImage(cs.img, x, y, sd, sd, 0, 0, sd, sd);
      req.onDone(cv.toDataURL('image/png'));
    } catch {
      store.toast('Не удалось обработать изображение (возможно, запрет CORS по ссылке)', 'warn');
    }
  };

  /* cropFit оригинала: вернуть исходный вид (zoom=1, центр-кроп) */
  const fitView = () => {
    const cs = s.current;
    if (!cs) return;
    cs.zoom = 1;
    cs.dx = cs.fx + (cs.side - cs.iw * cs.base) / 2;
    cs.dy = cs.fy + (cs.side - cs.ih * cs.base) / 2;
    if (zoomRef.current) zoomRef.current.value = '100';
    applyView();
  };

  /* перетаскивание картинки: pointer events на stage (в оригинале img pointer-events:none) */
  const onStageDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const cs = s.current;
    if (!cs) return;
    e.preventDefault();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {}
    cs.drag = { x: e.clientX, y: e.clientY, dx: cs.dx, dy: cs.dy };
  };
  const onStageMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const cs = s.current;
    if (!cs || !cs.drag) return;
    cs.dx = cs.drag.dx + (e.clientX - cs.drag.x);
    cs.dy = cs.drag.dy + (e.clientY - cs.drag.y);
    applyView();
  };
  const onStageUp = () => {
    const cs = s.current;
    if (cs) cs.drag = null;
  };

  return (
    <div
      id="cropWrap"
      className={'crop-wrap' + (shown ? ' show' : '')}
      role="dialog"
      aria-modal="true"
      aria-label="Кадрирование аватара"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) cancel(); /* клик по фону — closeAvatarCrop */
      }}
    >
      <div className="crop-card">
        <div className="crop-cap">Кадрирование аватара</div>
        <div
          className="crop-stage"
          id="cropStage"
          ref={stageRef}
          onPointerDown={onStageDown}
          onPointerMove={onStageMove}
          onPointerUp={onStageUp}
          onPointerCancel={onStageUp}
        >
          <img id="cropImg" ref={imgRef} alt="исходник аватара" src={shown ? req.src : undefined} draggable={false} />
          <div className="crop-frame" id="cropFrame" ref={frameRef} />
        </div>
        <div className="crop-zoom">
          <span>масштаб</span>
          <input
            type="range"
            id="cropZoom"
            ref={zoomRef}
            min={100}
            max={400}
            step={10}
            defaultValue={100}
            onInput={(e) => setZoom(Number((e.target as HTMLInputElement).value) / 100)}
          />
          <button type="button" className="btn" id="cropFit" title="Вернуть исходный вид" onClick={fitView}>Сброс</button>
        </div>
        <div className="crop-hint">Тяните картинку, чтобы выбрать область в рамке. В рамку попадёт квадратная область — она станет аватаром.</div>
        <div className="crop-acts">
          <button type="button" className="btn" id="cropCancel" onClick={(e) => { e.stopPropagation(); cancel(); }}>Отмена</button>
          <button type="button" className="btn primary" id="cropApply" onClick={(e) => { e.stopPropagation(); applyCrop(); }}>Применить</button>
        </div>
      </div>
    </div>
  );
}
