'use client';

/**
 * Ветви — редактор своих типов нод (openTypeEditor оригинала, 10076–10151).
 *
 * Модалка .m-card.wide: «Название типа» (#ctName), палитра цветов (Swatches
 * с paletteAdd оригинала — свой цвет встаёт в начало project.palette) и сетка
 * иконок iconGridHtml (10077–10089): «Базовые» (иконки встроенных типов) +
 * «Дополнительные — 50» (EXTRA_ICONS). Кнопки: «Удалить» (у существующего,
 * danger), «Отмена», «Создать»/«Сохранить» (primary).
 */

import { useState } from 'react';

import { TYPES } from '@/vetvi/core/constants';
import { EXTRA_ICONS, iconSvgInner } from '@/vetvi/core/icons';
import type { VetviStore } from './store';
import { ModalShell } from './Modals';
import { Swatches } from './Inspector';

/** Сетка иконок редактора (iconGridHtml оригинала, 10077–10089). */
function IconGrid({ selected, onPick }: { selected: string; onPick: (name: string) => void }) {
  const baseNames = Object.keys(TYPES).map((k) => (k === 'varnode' ? 'variable' : k));
  return (
    <>
      <div className="ico-cap">Базовые</div>
      <div className="ico-grid">
        {baseNames.map((ik) => (
          <button
            key={ik}
            type="button"
            className={'ico-btn' + (ik === selected ? ' on' : '')}
            data-i={ik}
            title={ik}
            onClick={() => onPick(ik)}
          >
            <IconSvg name={ik} size={16} />
          </button>
        ))}
      </div>
      <div className="ico-cap" style={{ marginTop: 9 }}>Дополнительные — {Object.keys(EXTRA_ICONS).length}</div>
      <div className="ico-grid">
        {Object.keys(EXTRA_ICONS).map((k) => (
          <button
            key={k}
            type="button"
            className={'ico-btn' + (k === selected ? ' on' : '')}
            data-i={k}
            title={k}
            onClick={() => onPick(k)}
          >
            <IconSvg name={k} size={16} />
          </button>
        ))}
      </div>
    </>
  );
}

function IconSvg({ name, size }: { name: string; size: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <g dangerouslySetInnerHTML={{ __html: iconSvgInner(name) }} />
    </svg>
  );
}

export function TypeEditorModal({ store, id }: { store: VetviStore; id: string | null }) {
  const existing = id ? store.customById(id) : null;
  const isNew = !existing;
  const [name, setName] = useState(existing ? existing.name : '');
  const [color, setColor] = useState(existing ? existing.color : '#e2a54e');
  const [icon, setIcon] = useState(existing ? existing.icon : 'star');

  const close = () => store.closeModal();

  const save = () => {
    store.saveCustomType(id, name, color, icon);
    close();
  };

  return (
    <ModalShell
      title={isNew ? 'Новый тип элемента' : 'Редактирование типа'}
      onClose={close}
      wide
      foot={
        <>
          {!isNew && (
            <button type="button" className="btn danger" onClick={() => { store.deleteCustomType(id as string); close(); }}>
              Удалить
            </button>
          )}
          <button type="button" className="btn" onClick={close}>Отмена</button>
          <button type="button" className="btn primary" onClick={save}>{isNew ? 'Создать' : 'Сохранить'}</button>
        </>
      }
    >
      <label className="i-lab">Название типа</label>
      <input
        className="inp"
        id="ctName"
        maxLength={40}
        placeholder="Например: Босс, Тайник, Спутник…"
        value={name}
        onChange={(e) => setName(e.target.value)}
        autoFocus
      />
      <label className="i-lab">Цвет</label>
      <Swatches
        cur={color}
        doc={store.doc}
        id="ctSw"
        onPick={(v) => { if (v) setColor(v); }}
      />
      <label className="i-lab">Иконка</label>
      <IconGrid selected={icon} onPick={setIcon} />
    </ModalShell>
  );
}
