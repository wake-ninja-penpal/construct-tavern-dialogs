'use client';

/**
 * Ветви — редактор своих типов: 1:1 порт openTypeEditor / iconGridHtml /
 * deleteCustomType классической версии (оригинал строки 10076–10151).
 *
 * Модалка .modal-wrap > .m-card.wide (те же классы, что у generic-модалок Modals.tsx,
 * но разметка своя — файл Modals.tsx не трогается): h3 «Новый тип элемента» /
 * «Редактирование типа», .i-lab «Название типа» + input.inp#ctName (maxlength 40,
 * placeholder «Например: Босс, Тайник, Спутник…»), .i-lab «Цвет» + палитра проекта
 * (paletteCoreHtml оригинала: свотчи проекта + базовые, «Ещё N ▾», свой цвет через
 * .sw-picker → paletteAdd), .i-lab «Иконка» + две сетки .ico-grid: «Базовые»
 * (иконки TYPES) и «Дополнительные — 50» (EXTRA_ICONS).
 *
 * Кнопки .m-btns: у существующего — «Удалить» (danger, сразу, без подтверждения —
 * как showModal оригинала) + «Отмена» + «Сохранить»; у нового — «Отмена» + «Создать».
 * Дефолты нового типа: цвет #e2a54e, иконка star. Escape/клик по фону закрывают.
 * Тосты: «Тип «X» создан» / «Тип «X» обновлён»; удаление — «Тип «X» удалён (его
 * узлы стали заметками)» (warn) с pushHistory «Удаление своего типа».
 * Новых стилей нет — vetvi.css применяется как есть.
 */

import { useEffect, useRef, useState } from 'react';

import {
  EXTRA_ICONS,
  PALETTE_COLORS,
  TYPES,
  TYPE_ICONS,
  customTypeById,
  iconPath,
  type CustomTypeRec,
} from '@/vetvi/core/constants';
import { uid } from '@/vetvi/core/factory';
import type { VetviDoc } from '@/vetvi/core/types';
import type { VetviStore } from './store';

/** PALETTE_VIS оригинала (строка 1533): видимы первые 16 свотчей (два ряда). */
const PALETTE_VIS = 16;

const P_PLUS = '<path d="M12 5v14M5 12h14"/>';

/** ic(name,size) оригинала — svg-обёртка над путём иконки. */
function Ic(props: { d: string; size?: number }) {
  const size = props.size || 15;
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <g dangerouslySetInnerHTML={{ __html: props.d }} />
    </svg>
  );
}

/** paletteAdd оригинала (строка 1534): свой цвет в начало project.palette (≤24, без дублей). */
function paletteAdd(doc: VetviDoc, hex: string): void {
  if (typeof hex !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(hex)) return;
  hex = hex.toLowerCase();
  if (PALETTE_COLORS.indexOf(hex) >= 0) return;
  if (!Array.isArray(doc.palette)) doc.palette = [];
  const i = doc.palette.indexOf(hex);
  if (i > 0) doc.palette.splice(i, 1);
  if (i !== 0) doc.palette.unshift(hex);
  if (doc.palette.length > 24) doc.palette.length = 24;
}

/** paletteAll(extraFirst) оригинала: свои цвета проекта + базовый набор. */
function paletteAll(doc: VetviDoc): string[] {
  return (Array.isArray(doc.palette) ? doc.palette : []).concat(PALETTE_COLORS);
}

/** openSwPicker оригинала (строка 1563). */
function openSwPicker(picker: HTMLInputElement | null): void {
  if (!picker) return;
  try {
    if (picker.showPicker) picker.showPicker();
    else picker.click();
  } catch {
    picker.click();
  }
}

/** deleteCustomType оригинала (строка 10133): удалить тип, его ноды → 'note',
    убрать из listHidden; pushHistory «Удаление своего типа», тост warn.
    Используется и крестиком в палитре LeftPane. */
export function deleteCustomTypeOf(store: VetviStore, id: string): void {
  const c = customTypeById(store.doc, id);
  if (!c) return;
  store.mutate((doc) => {
    const arr = Array.isArray(doc.customTypes) ? doc.customTypes : [];
    doc.customTypes = arr.filter((raw) => {
      if (!raw || typeof raw !== 'object') return true;
      return (raw as Record<string, unknown>).id !== id;
    });
    for (const n of doc.nodes) if (n.type === id) n.type = 'note';
    const lh: unknown = doc.listHidden;
    if (Array.isArray(lh)) {
      const i = lh.indexOf(id);
      if (i >= 0) lh.splice(i, 1);
    } else if (lh && typeof lh === 'object') {
      delete (lh as Record<string, unknown>)[id];
    }
  }, { label: 'Удаление своего типа' });
  store.toast('Тип «' + c.name + '» удалён (его узлы стали заметками)', 'warn');
}

export function CustomTypeModal(props: { store: VetviStore; existing: CustomTypeRec | null; onClose: () => void }) {
  const { store, existing, onClose } = props;
  const isNew = !existing;
  void store.revision; /* перерисовка при изменении doc (палитра проекта) */

  /* curColor/curIcon оригинала; дефолты нового типа — #e2a54e / star */
  const [color, setColor] = useState<string>(existing ? existing.color : '#e2a54e');
  const [icon, setIcon] = useState<string>(existing ? existing.icon : 'star');
  const [swX, setSwX] = useState<boolean>(false); /* .swatches.sw-x — «Ещё N» развёрнута */

  const nameRef = useRef<HTMLInputElement | null>(null);
  const pickerRef = useRef<HTMLInputElement | null>(null);

  /* Escape закрывает модалку (глобальный keydown оригинала, строка 10009: closeModal()) */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  /* фокус на название через 60 мс — setTimeout оригинала после showModal */
  useEffect(() => {
    const t = setTimeout(() => {
      if (nameRef.current) nameRef.current.focus();
    }, 60);
    return () => clearTimeout(t);
  }, []);

  /* клик по свотчу: свой цвет через .sw-picker, иначе выбор data-c (click-делегат #mCard) */
  const pickSwatch = (hex: string) => {
    setColor(hex);
  };

  /* change .sw-picker оригинала: валидный hex → paletteAdd + curColor (и перерисовка свотчей) */
  const onPickerChange = (hex: string) => {
    if (!/^#[0-9a-f]{6}$/.test(hex)) return;
    store.mutate((doc) => {
      paletteAdd(doc, hex);
    }, { history: false });
    setColor(hex);
  };

  /* Сохранить/Создать: pushHistory «Правка своих типов» → правка customTypes → тост */
  const save = () => {
    const name = ((nameRef.current?.value || '')).trim() || 'Элемент';
    if (existing) {
      store.mutate((doc) => {
        const arr = Array.isArray(doc.customTypes) ? doc.customTypes : [];
        const rec = arr.find((x) => !!x && typeof x === 'object' && (x as Record<string, unknown>).id === existing.id);
        if (rec && typeof rec === 'object') {
          const r = rec as Record<string, unknown>;
          r.name = name;
          r.color = color;
          r.icon = icon;
        }
      }, { label: 'Правка своих типов' });
      store.toast('Тип «' + name + '» обновлён');
    } else {
      store.mutate((doc) => {
        const arr = Array.isArray(doc.customTypes) ? doc.customTypes : [];
        arr.push({ id: uid(), name, color, icon });
        doc.customTypes = arr;
      }, { label: 'Правка своих типов' });
      store.toast('Тип «' + name + '» создан');
    }
    onClose();
  };

  /* «Удалить»: showModal оригинала сначала закрывает модалку, затем зовёт deleteCustomType */
  const del = () => {
    if (!existing) return;
    onClose();
    deleteCustomTypeOf(store, existing.id);
  };

  /* paletteCoreHtml оригинала: первые 16 свотчей, остальные — за «Ещё N ▾» */
  const list = paletteAll(store.doc);
  const more = Math.max(0, list.length - PALETTE_VIS);

  const swatch = (c: string, key: string) => {
    const on = color && String(color).toLowerCase() === String(c).toLowerCase();
    return (
      <button
        type="button"
        key={key}
        className={'swatch' + (on ? ' on' : '')}
        data-c={c}
        style={{ background: c }}
        title={c}
        onClick={() => pickSwatch(c)}
      />
    );
  };

  return (
    <div
      className="modal-wrap"
      role="dialog"
      aria-modal="true"
      aria-label={isNew ? 'Новый тип элемента' : 'Редактирование типа'}
      onPointerDown={(e) => {
        if (e.target === e.currentTarget) onClose(); /* pointerdown по фону #modalWrap */
      }}
    >
      <div className="m-card wide">
        <h3>{isNew ? 'Новый тип элемента' : 'Редактирование типа'}</h3>

        <label className="i-lab">Название типа</label>
        <input
          className="inp"
          id="ctName"
          ref={nameRef}
          maxLength={40}
          placeholder="Например: Босс, Тайник, Спутник…"
          defaultValue={existing ? existing.name : ''}
        />

        <label className="i-lab">Цвет</label>
        <div className={'swatches' + (swX ? ' sw-x' : '')} id="ctSw">
          {list.map((c, i) => (i < PALETTE_VIS ? swatch(c, 'p' + i) : null))}
          {more > 0 && (
            <>
              <span className="sw-more">{list.slice(PALETTE_VIS).map((c, i) => swatch(c, 'r' + i))}</span>
              <button
                type="button"
                className="sw-toggle"
                data-n={more}
                title={swX ? 'Свернуть палитру' : 'Показать скрытые цвета'}
                onClick={() => setSwX(!swX)}
              >
                {swX ? 'Свернуть ▴' : 'Ещё ' + more + ' ▾'}
              </button>
            </>
          )}
          <button
            type="button"
            className="swatch custom"
            data-custom="1"
            title="Свой цвет — выбрать любой и добавить в палитру"
            onClick={() => openSwPicker(pickerRef.current)}
          >
            <Ic d={P_PLUS} size={13} />
          </button>
          <input
            type="color"
            className="sw-picker"
            ref={pickerRef}
            tabIndex={-1}
            aria-hidden="true"
            value={/^#[0-9a-fA-F]{6}$/.test(String(color)) ? color : '#e2a54e'}
            onChange={(e) => onPickerChange((e.target as HTMLInputElement).value)}
          />
        </div>

        <label className="i-lab">Иконка</label>
        <div className="ico-cap">Базовые</div>
        <div className="ico-grid">
          {Object.keys(TYPES).map((k) => {
            const ik = TYPE_ICONS[k];
            return (
              <button
                type="button"
                key={k}
                className={'ico-btn' + (ik === icon ? ' on' : '')}
                data-i={ik}
                title={ik}
                onClick={() => setIcon(ik)}
              >
                <Ic d={iconPath(ik)} size={16} />
              </button>
            );
          })}
        </div>
        <div className="ico-cap" style={{ marginTop: 9 }}>Дополнительные — 50</div>
        <div className="ico-grid">
          {Object.keys(EXTRA_ICONS).map((k) => (
            <button
              type="button"
              key={k}
              className={'ico-btn' + (k === icon ? ' on' : '')}
              data-i={k}
              title={k}
              onClick={() => setIcon(k)}
            >
              <Ic d={EXTRA_ICONS[k]} size={16} />
            </button>
          ))}
        </div>

        <div className="m-btns">
          {!isNew && (
            <button type="button" className="btn danger" onClick={del}>Удалить</button>
          )}
          <button type="button" className="btn" onClick={onClose}>Отмена</button>
          <button type="button" className="btn primary" onClick={save}>{isNew ? 'Создать' : 'Сохранить'}</button>
        </div>
      </div>
    </div>
  );
}
