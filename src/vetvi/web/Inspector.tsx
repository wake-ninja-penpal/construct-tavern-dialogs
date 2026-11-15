'use client';

/**
 * Ветви — инспектор: правая панель редактирования выделенной ноды.
 * Этап 1: название, статус, цвет, текст, реплики диалога, исходы развилки,
 * сводка переменной. Условия исходов, переменные-ссылки и заметки — этап 2.
 */

import { useState } from 'react';

import { PALETTE_COLORS, STATUS_CYCLE, STATUS_RU, TYPES } from '@/vetvi/core/constants';
import { shadeHex } from '@/vetvi/core/geometry';
import type { VetviNode } from '@/vetvi/core/types';
import { useRef } from 'react';
import type { VetviStore } from './store';

export function Inspector(props: { store: VetviStore; onClose: () => void }) {
  const { store } = props;
  const id = store.sel.size ? [...store.sel][0] : null;
  const n = id ? store.nodeById(id) : null;
  const [openPalette, setOpenPalette] = useState(false);
  const editPre = useRef<string | null>(null);

  if (!n) {
    return (
      <aside className="rn-inspector empty" aria-label="Инспектор">
        <div className="rn-insp-title">Инспектор</div>
        <div className="rn-insp-hint">Ничего не выбрано. Кликните по ноде или связи на холсте.</div>
      </aside>
    );
  }

  const info = TYPES[n.type] || { name: 'Нода', color: '#8b929c' };
  const baseColor = n.color || info.color;
  const isDialog = n.type === 'dialog';
  const isBranch = n.type === 'branch';
  const isAction = n.type === 'action';
  const isVar = n.type === 'varnode';

  const commit = (patch: Partial<VetviNode>) => {
    store.updateNode(n.id, patch, { history: true });
  };

  return (
    <aside className="rn-inspector" aria-label={'Инспектор: ' + info.name}>
      <div className="rn-insp-head">
        <span className="rn-insp-type" style={{ color: baseColor }}>{info.name}</span>
        <button type="button" className="rn-insp-x" title="Снять выделение" onClick={props.onClose}>×</button>
      </div>

      <label className="rn-field">
        <span>Название</span>
        <input
          value={n.title}
          onFocus={() => { editPre.current = store.beginEdit(); }}
          onChange={(e) => store.updateNode(n.id, { title: e.target.value }, { history: false })}
          onBlur={() => { store.commitEdit(editPre.current); editPre.current = null; }}
          onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
          aria-label="Название ноды"
        />
      </label>

      <div className="rn-field">
        <span>Статус</span>
        <div className="rn-seg" role="group" aria-label="Статус ноды">
          {STATUS_CYCLE.map((s) => (
            <button
              key={s}
              type="button"
              className={'c-' + s + (n.status === s ? ' on' : '')}
              onClick={() => commit({ status: s })}
            >
              {STATUS_RU[s]}
            </button>
          ))}
        </div>
      </div>

      <div className="rn-field">
        <span>Цвет</span>
        <div className="rn-palette">
          {(!openPalette ? PALETTE_COLORS.slice(0, 6) : PALETTE_COLORS).map((c) => (
            <button
              key={c}
              type="button"
              className={'rn-swatch' + (baseColor.toLowerCase() === c ? ' on' : '')}
              style={{ background: shadeHex(c, -60) }}
              title={c}
              aria-label={'Цвет ' + c}
              onClick={() => { commit({ color: c, tint: -60 }); setOpenPalette(false); }}
            />
          ))}
          <button type="button" className="rn-swatch more" title="Показать все цвета" onClick={() => setOpenPalette((v) => !v)}>
            {openPalette ? '▴' : '▾'}
          </button>
          <input
            type="color"
            className="rn-picker"
            title="Свой цвет"
            value={/^#[0-9a-fA-F]{6}$/.test(baseColor) ? baseColor : '#e2a54e'}
            onChange={(e) => commit({ color: e.target.value, tint: 0 })}
            aria-label="Свой цвет ноды"
          />
        </div>
      </div>

      {!isDialog && !isVar && (
        <label className="rn-field">
          <span>Текст</span>
          <textarea
            rows={4}
            value={n.text}
            onFocus={() => { editPre.current = store.beginEdit(); }}
            onChange={(e) => store.updateNode(n.id, { text: e.target.value }, { history: false })}
            onBlur={() => { store.commitEdit(editPre.current); editPre.current = null; }}
            aria-label="Текст ноды"
          />
        </label>
      )}

      {isDialog && n.dialog && (
        <div className="rn-field">
          <span>Описание диалога</span>
          <textarea
            rows={3}
            value={n.dialog.description}
            onFocus={() => { editPre.current = store.beginEdit(); }}
            onChange={(e) => store.updateNode(n.id, { dialog: { ...n.dialog!, description: e.target.value } }, { history: false })}
            onBlur={() => { store.commitEdit(editPre.current); editPre.current = null; }}
            aria-label="Описание диалога"
          />
          <div className="rn-row-head">
            <span>Реплики ({n.dialog.replies.length})</span>
            <button type="button" className="rn-mini" onClick={() => store.addReply(n.id)}>+ Реплика</button>
          </div>
          <div className="rn-replies-edit">
            {n.dialog.replies.map((r, i) => (
              <div className="rn-reply-edit" key={r.id}>
                <input
                  className="rn-reply-sp-inp"
                  value={r.speaker || ''}
                  placeholder="Говорящий"
                  aria-label={'Говорящий реплики ' + (i + 1)}
                  onFocus={() => { editPre.current = store.beginEdit(); }}
                  onChange={(e) => {
                    const arr = n.dialog!.replies.map((x) => x.id === r.id ? { ...x, speaker: e.target.value || null } : x);
                    store.updateNode(n.id, { dialog: { ...n.dialog!, replies: arr } }, { history: false });
                  }}
                  onBlur={() => { store.commitEdit(editPre.current); editPre.current = null; }}
                />
                <textarea
                  rows={2}
                  value={r.text}
                  placeholder="Текст реплики"
                  aria-label={'Текст реплики ' + (i + 1)}
                  onFocus={() => { editPre.current = store.beginEdit(); }}
                  onChange={(e) => {
                    const arr = n.dialog!.replies.map((x) => x.id === r.id ? { ...x, text: e.target.value } : x);
                    store.updateNode(n.id, { dialog: { ...n.dialog!, replies: arr } }, { history: false });
                  }}
                  onBlur={() => { store.commitEdit(editPre.current); editPre.current = null; }}
                />
                <div className="rn-reply-btns">
                  <button type="button" title="Выше" onClick={() => store.moveReply(n.id, r.id, -1)}>↑</button>
                  <button type="button" title="Ниже" onClick={() => store.moveReply(n.id, r.id, 1)}>↓</button>
                  <button type="button" title="Удалить реплику" onClick={() => store.deleteReply(n.id, r.id)}>×</button>
                </div>
              </div>
            ))}
            {n.dialog.replies.length === 0 && <div className="rn-insp-hint">Реплик пока нет.</div>}
          </div>
        </div>
      )}

      {isBranch && (
        <div className="rn-field">
          <div className="rn-row-head">
            <span>Исходы ({Array.isArray(n.outcomes) ? n.outcomes.length : 0})</span>
            <button type="button" className="rn-mini" onClick={() => store.addOutcome(n.id)}>+ Исход</button>
          </div>
          <div className="rn-replies-edit">
            {(Array.isArray(n.outcomes) ? n.outcomes : []).map((o, i) => (
              <div className="rn-reply-edit one" key={o.id}>
                <input
                  value={o.label}
                  placeholder="Подпись исхода"
                  aria-label={'Подпись исхода ' + (i + 1)}
                  onFocus={() => { editPre.current = store.beginEdit(); }}
                  onChange={(e) => {
                    const arr = (n.outcomes || []).map((x) => x.id === o.id ? { ...x, label: e.target.value } : x);
                    store.updateNode(n.id, { outcomes: arr }, { history: false });
                  }}
                  onBlur={() => { store.commitEdit(editPre.current); editPre.current = null; }}
                />
                <button type="button" title="Удалить исход" onClick={() => store.deleteOutcome(n.id, o.id)}>×</button>
              </div>
            ))}
          </div>
          <div className="rn-insp-hint">Условия исходов по переменным — следующий этап порта.</div>
        </div>
      )}

      {isAction && (
        <div className="rn-insp-hint">Кнопки действия создаются на карточке ноды; их связи тянутся от пинов исходов.</div>
      )}

      {isVar && (
        <div className="rn-field">
          <span>Переменная</span>
          <div className="rn-insp-hint">
            Режим: {n.varMode === 'get' ? 'чтение' : 'запись'} · операция {String(n.varOp ?? '=')} · значение {String(n.varVal ?? 0)}.
            Полный редактор переменных — следующий этап порта.
          </div>
        </div>
      )}

      <div className="rn-insp-foot">
        <button type="button" className="rn-danger" onClick={() => store.deleteSelected()}>
          Удалить ноду
        </button>
      </div>
    </aside>
  );
}
