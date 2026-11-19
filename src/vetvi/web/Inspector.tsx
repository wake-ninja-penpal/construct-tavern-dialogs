'use client';

/**
 * Ветви — инспектор: 1:1 порт правой панели оригинала (/vetvi/index.html).
 *
 * Корень — <aside id="right"> (как в оригинальном #layout) с .i-cap и #insp;
 * разметка, классы и id повторяют renderInspector и его хелперы:
 * renderInspNode / renderInspEdge / renderInspGroup (+ цепочка) / renderInspMulti /
 * renderInspEmpty, inspPartsHtml, inspOutsHtml, inspActionsHtml, inspVarHtml,
 * inspCondHtml, condRowHtml, paletteCoreHtml/bindPalette/toggleSwatches,
 * charAvatarHtml, applyInspectorLockState.
 * Стили — оригинальный дизайн-система (vetvi.css), новых классов нет; инлайн —
 * только динамические цвета и те инлайны, что были в оригинале.
 */

import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { PALETTE_COLORS, TYPES } from '@/vetvi/core/constants';
import { clamp, typeInfo } from '@/vetvi/core/geometry';
import { hkText } from '@/vetvi/core/hotkeys';
import { getMe } from '@/vetvi/core/identity';
import type { VetviDoc, VetviGroup, VetviNode, VetviNote, VetviReply } from '@/vetvi/core/types';
import {
  branchVarOverride, condOpsFor, isTrueVal, opsForType, outConds, outJoin,
  varById, varName, varType, varsList,
} from '@/vetvi/core/vars';
import type { Cond } from '@/vetvi/core/vars';
import { allDescNodes } from './ggroups';
import { PanelTab } from './PanelTab';
import type { VetviStore } from './store';
import { TypeIcon } from './NodeCard';
import { NOTE_MAX, noteBus } from './NoteModals';

/* ═══ константы оригинала ═══ */

const STATUS_INSP: Record<string, string> = { idea: 'Идея', draft: 'В работе', done: 'Готово' };
const KINDS: Record<string, string> = { flow: 'Обычная', choice: 'Выбор', cond: 'Условие', bridge: 'Мост' };
const FOLD_NAMES = ['Компакт', 'Список', 'Развёрнута'];
const PALETTE_VIS = 16;

/* ═══ иконки (порт ic() оригинала) ═══ */

const ICONS: Record<string, string> = {
  branch: '<circle cx="5" cy="12" r="2.3"/><circle cx="19" cy="5" r="2.3"/><circle cx="19" cy="19" r="2.3"/><path d="M7.3 12h3.2c2.6 0 2.9-7 6.2-7M10.5 12c2.6 0 2.9 7 6.2 7"/>',
  dialog: '<path d="M4 5.5h16v10.5h-9.5L6 20v-4H4z"/><path d="M8 9.5h8M8 12.3h5"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/>',
  swap: '<path d="M4 8h13M14 4.5 17.5 8 14 11.5M20 16H7M10 12.5 6.5 16l3.5 3.5"/>',
  target: '<circle cx="12" cy="12" r="7"/><path d="M12 2v4M12 18v4M2 12h4M18 12h4"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3M6.5 7l1 13h9l1-13M10 11v5M14 11v5"/>',
  pencil: '<path d="m4 20 1-4L16.3 4.7a2.1 2.1 0 0 1 3 3L8 19z"/><path d="M14.5 6.5l3 3"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  expand: '<path d="M9 9 4 4m0 0v4M4 4h4M15 9l5-5m0 0v4M20 4h-4M9 15l-5 5m0 0v-4M4 20h4M15 15l5 5m0 0v-4M20 20h-4"/>',
  corner: '<path d="M5 5v4.6a3.9 3.9 0 0 0 3.9 3.9H19"/><path d="m15.5 9.5 3.5 3.5-3.5 3.5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  alignH: '<path d="M2 12h20"/><rect x="4" y="8" width="4" height="8" rx="1"/><rect x="10" y="8" width="4" height="8" rx="1"/><rect x="16" y="8" width="4" height="8" rx="1"/>',
  alignV: '<path d="M12 2v20"/><rect x="8" y="4" width="8" height="4" rx="1"/><rect x="8" y="10" width="8" height="4" rx="1"/><rect x="8" y="16" width="8" height="4" rx="1"/>',
  grip: '<path d="M9 5.5h.01M9 12h.01M9 18.5h.01M15 5.5h.01M15 12h.01M15 18.5h.01"/>',
  eye: '<path d="M2.5 12S6 5.8 12 5.8 21.5 12 21.5 12 18 18.2 12 18.2 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/>',
  eyeOff: '<path d="M2.5 12S6 5.8 12 5.8c1.2 0 2.3.3 3.3.7M21.5 12S18 18.2 12 18.2c-1.2 0-2.3-.3-3.3-.7"/><path d="M4 4l16 16"/>',
  queue: '<path d="M8 6h12M8 12h12M8 18h12"/><circle cx="3.7" cy="6" r="1.1"/><circle cx="3.7" cy="12" r="1.1"/><circle cx="3.7" cy="18" r="1.1"/>',
};

function Ico({ name, size = 15 }: { name: string; size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <g dangerouslySetInnerHTML={{ __html: ICONS[name] || ICONS.branch }} />
    </svg>
  );
}

/* ═══ хелперы оригинала ═══ */

function hexToRgba(hex: string | null | undefined, a: number): string {
  let h = String(hex || '').replace('#', '');
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  if (isNaN(r) || isNaN(g) || isNaN(b)) return 'rgba(154,161,172,' + a + ')';
  return 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
}

/** varCastVal(v0, raw) как в оригинале: первый аргумент — объект переменной,
    поэтому значение фактически приводится к обрезанной строке (ветка else). */
function castInspVal(raw: unknown): string {
  return String(raw == null ? '' : raw).trim().slice(0, 200);
}

function customTypesOf(doc: VetviDoc): { id: string; name: string; color?: string }[] {
  return Array.isArray(doc.customTypes) ? (doc.customTypes as { id: string; name: string; color?: string }[]) : [];
}

/** paletteAdd оригинала: свой цвет в начало project.palette (≤24, без дублей). */
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

/** branchCondDefault оригинала. */
function branchCondDefault(doc: VetviDoc): { vid: string; op: string; val: number | string | boolean } {
  const v0 = varsList(doc)[0] || null;
  return { vid: v0 ? v0.id : '', op: '==', val: (v0 && varType(v0) === 'bool') ? true : 0 };
}

/** countReplies оригинала: реплики считаются с вложенными детьми. */
function countReplies(replies: VetviReply[] | undefined): number {
  if (!Array.isArray(replies)) return 0;
  let c = 0;
  for (const r of replies) {
    c++;
    if (r.children && r.children.length) c += countReplies(r.children);
  }
  return c;
}

function findReplyText(replies: VetviReply[] | undefined, rid: string): string | null {
  if (!Array.isArray(replies)) return null;
  for (const r of replies) {
    if (r.id === rid) return r.text || '';
    if (r.children) {
      const f = findReplyText(r.children, rid);
      if (f !== null) return f;
    }
  }
  return null;
}

/** Перестановка «src → tgt (выше/ниже)» — ядро branchMoveOutcome/actionMoveAction. */
function movePairInList(arr: { id: string }[], srcId: string, tgtId: string, below: boolean): boolean {
  let s = -1;
  let t = -1;
  for (let i = 0; i < arr.length; i++) {
    if (arr[i].id === srcId) s = i;
    if (arr[i].id === tgtId) t = i;
  }
  if (s < 0 || t < 0 || s === t) return false;
  const moved = arr.splice(s, 1)[0];
  const insAt = (s < t ? t - 1 : t) + (below ? 1 : 0);
  arr.splice(insAt, 0, moved);
  return true;
}

/** stackOrderIds оригинала: порядок нод цепочки по g.order + остаток по раскладке. */
function stackOrderIds(doc: VetviDoc, g: VetviGroup): string[] {
  const members = doc.nodes.filter((n) => n.gid === g.id);
  const known: Record<string, boolean> = {};
  const out: string[] = [];
  members.forEach((m) => { known[m.id] = true; });
  (Array.isArray(g.order) ? (g.order as string[]) : []).forEach((id) => {
    if (known[id]) { out.push(id); known[id] = false; }
  });
  members.forEach((m) => { if (known[m.id]) out.push(m.id); });
  return out;
}

function isDescGroup(doc: VetviDoc, ancestorId: string, childId: string): boolean {
  let cur: string | null | undefined = childId;
  const seen = new Set<string>();
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    if (cur === ancestorId) return true;
    cur = doc.groups.find((g) => g.id === cur)?.parent;
  }
  return false;
}

function fmtD(iso?: number | string | null): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleDateString('ru-RU', { day: '2-digit', month: 'short', year: 'numeric' });
  } catch {
    return '—';
  }
}

function nodeCap(n: VetviNode, cstName: string | null): string {
  if (n.type === 'dialog') return 'Диалог';
  if (TYPES[n.type]) return 'Элемент';
  return 'Свой тип: ' + (cstName || typeInfo(n.type).name);
}

/** Блокировка инспектора, если объект редактирует ДРУГОЙ участник (lockBlockedBy оригинала 11912:
 * свой лок не блокирует — иначе эхо собственного lockTake дизейблит поле под фокусом и сбивает ввод). */
function lockFor(store: VetviStore, ids: string[]): { id: string; name: string; color: string } | null {
  const me = getMe().id;
  for (const id of ids) {
    const l = store.syncLocks[id];
    if (l && l.id && l.id !== me) return l;
  }
  return null;
}

/* ═══ заметки элемента: notesSectionHtml + bindNotesDelegation ═══ */

function NotesSection({ store, n }: { store: VetviStore; n: VetviNode }) {
  const notes: VetviNote[] = Array.isArray(n.notes) ? n.notes : [];
  const cnt = notes.length;
  const anyVisible = notes.some((x) => !x.hidden);

  /* #notesHideAll: есть видимые — скрыть все, иначе показать все (6429) */
  const hideAll = () => {
    store.mutate((doc) => {
      const nn = doc.nodes.find((x) => x.id === n.id);
      if (!nn) return;
      if (!Array.isArray(nn.notes)) nn.notes = [];
      const anyVis = nn.notes.some((x) => !x.hidden);
      nn.notes.forEach((x) => { x.hidden = anyVis; });
    }, { label: 'Заметки элемента' });
  };

  /* #notesAdd (6427): лимит NOTE_MAX → warn, иначе openNoteEditor(n,-1) */
  const add = (ev: React.MouseEvent) => {
    if (cnt >= NOTE_MAX) {
      store.toast('Максимум ' + NOTE_MAX + ' заметки', 'warn');
      return;
    }
    noteBus.openEditor(n.id, -1, ev.clientX, ev.clientY);
  };

  /* data-note-act="hide" (6436): toggle hidden отдельной заметки */
  const toggleHidden = (ni: number) => {
    store.mutate((doc) => {
      const nn = doc.nodes.find((x) => x.id === n.id);
      if (!nn || !Array.isArray(nn.notes) || !nn.notes[ni]) return;
      nn.notes[ni].hidden = !nn.notes[ni].hidden;
    }, { label: 'Заметки элемента' });
  };

  /* data-note-act="del" (6435): удалить заметку */
  const del = (ni: number) => {
    store.mutate((doc) => {
      const nn = doc.nodes.find((x) => x.id === n.id);
      if (!nn || !Array.isArray(nn.notes)) return;
      nn.notes.splice(ni, 1);
    }, { label: 'Удаление заметки' });
    store.toast('Заметка удалена', 'warn');
  };

  return (
    <>
      <label className="i-lab" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        Заметки ({cnt}/{NOTE_MAX})
        <span style={{ display: 'flex', gap: 4 }}>
          <button
            type="button"
            className={'mini-btn eye' + (anyVisible ? '' : ' off')}
            id="notesHideAll"
            title={anyVisible ? 'Скрыть все у элемента' : 'Показать все'}
            onClick={hideAll}
          >
            <Ico name={anyVisible ? 'eye' : 'eyeOff'} size={12} />
          </button>
          <button
            type="button"
            className="mini-btn"
            id="notesAdd"
            title="Добавить заметку"
            disabled={cnt >= NOTE_MAX}
            style={cnt >= NOTE_MAX ? { opacity: 0.35 } : undefined}
            onClick={add}
          >
            <Ico name="plus" size={12} />
          </button>
        </span>
      </label>
      <div className="note-list">
        {cnt ? notes.map((note, ni) => (
          <div key={ni} className={'note-row' + (note.hidden ? ' hidden' : '')} data-ni={ni}>
            <span className="note-row-title" data-note-view={ni} onClick={() => noteBus.openView(n.id, ni)}>{note.title || 'Без названия'}</span>
            <span className="note-row-acts">
              <button
                type="button"
                className="mini-btn"
                data-note-act="edit"
                data-ni={ni}
                title="Редактировать"
                onClick={(ev) => noteBus.openEditor(n.id, ni, ev.clientX, ev.clientY)}
              >
                <Ico name="pencil" size={12} />
              </button>
              <button
                type="button"
                className={'mini-btn eye' + (note.hidden ? ' off' : '')}
                data-note-act="hide"
                data-ni={ni}
                title={note.hidden ? 'Показать' : 'Скрыть от элемента'}
                onClick={() => toggleHidden(ni)}
              >
                <Ico name={note.hidden ? 'eyeOff' : 'eye'} size={12} />
              </button>
              <button
                type="button"
                className="mini-btn del"
                data-note-act="del"
                data-ni={ni}
                title="Удалить"
                onClick={() => del(ni)}
              >
                <Ico name="x" size={12} />
              </button>
            </span>
          </div>
        )) : (
          <div className="note-empty">Заметок нет — добавьте через +</div>
        )}
      </div>
    </>
  );
}

/* ═══ палитра: paletteCoreHtml + bindPalette + toggleSwatches ═══ */

export function Swatches({ cur, doc, extraFirst, onPick, children, id }: {
  cur: string | null | undefined;
  doc: VetviDoc;
  extraFirst?: string[];
  onPick: (v: string | null, fromPicker: boolean) => void;
  children?: ReactNode;
  id?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const pickerRef = useRef<HTMLInputElement | null>(null);
  const list: string[] = [
    ...(Array.isArray(doc.palette) ? (doc.palette as string[]) : []),
    ...(extraFirst || []),
    ...PALETTE_COLORS,
  ];
  const vis: ReactNode[] = [];
  const hidden: ReactNode[] = [];
  list.forEach((c, i) => {
    const on = !!(cur && String(cur).toLowerCase() === String(c).toLowerCase());
    const b = (
      <button
        key={c + ':' + i}
        type="button"
        className={'swatch' + (on ? ' on' : '')}
        style={{ background: c }}
        title={c}
        onClick={() => onPick(c, false)}
      />
    );
    if (i < PALETTE_VIS) vis.push(b);
    else hidden.push(b);
  });
  const more = hidden.length;
  const openPicker = () => {
    const p = pickerRef.current;
    if (!p) return;
    try {
      if (p.showPicker) p.showPicker();
      else p.click();
    } catch {
      p.click();
    }
  };
  return (
    <div className={'swatches' + (expanded ? ' sw-x' : '')} id={id}>
      {vis}
      {more > 0 && <span className="sw-more">{hidden}</span>}
      {more > 0 && (
        <button
          type="button"
          className="sw-toggle"
          title={expanded ? 'Свернуть палитру' : 'Показать скрытые цвета'}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? 'Свернуть ▴' : 'Ещё ' + more + ' ▾'}
        </button>
      )}
      <button type="button" className="swatch custom" title="Свой цвет — выбрать любой и добавить в палитру" onClick={openPicker}>
        <Ico name="plus" size={13} />
      </button>
      <input
        ref={pickerRef}
        type="color"
        className="sw-picker"
        tabIndex={-1}
        aria-hidden="true"
        value={/^#[0-9a-fA-F]{6}$/.test(String(cur || '')) ? String(cur) : '#e2a54e'}
        onChange={(ev) => {
          const hex = (ev.target.value || '').toLowerCase();
          if (/^#[0-9a-f]{6}$/.test(hex)) onPick(hex, true);
        }}
      />
      {children}
    </div>
  );
}

/* ═══ плашка участника: dlg-chip + c-av chip (charAvatarHtml) ═══ */

function PartChip({ store, pid, onRemove }: { store: VetviStore; pid: string; onRemove: () => void }) {
  const c = store.charById(pid);
  const color = store.charColor(pid);
  const name = store.charName(pid);
  const shape = c && c.avShape === 'square' ? 'square' : 'circle';
  const av = c ? ((c.av as string | null) || null) : null;
  return (
    <span className="dlg-chip" style={{ background: hexToRgba(color, 0.15), color, borderColor: hexToRgba(color, 0.55) }}>
      <span className={'c-av ' + shape + (av ? '' : ' empty') + ' chip'} style={{ borderColor: color }}>
        {av ? <img src={av} alt="" /> : (name || '?')[0].toUpperCase()}
      </span>
      <span>{name}</span>
      <span className="x" title="Убрать" onClick={onRemove}><Ico name="x" size={10} /></span>
    </span>
  );
}

/** Удаление участника диалога с чисткой спикеров реплик (как .x в renderInspNode). */
function removeDialogPart(store: VetviStore, nodeId: string, pid: string): void {
  store.mutate((doc) => {
    const nn = doc.nodes.find((x) => x.id === nodeId);
    if (!nn || !nn.dialog) return;
    nn.dialog.participants = nn.dialog.participants.filter((p) => p !== pid);
    const clean = (arr: VetviReply[]) => {
      for (const r of arr) {
        if (r.speaker === pid) r.speaker = nn.dialog!.participants[0] || null;
        if (r.children) clean(r.children);
      }
    };
    clean(nn.dialog.replies || []);
  }, { label: 'Участники диалога' });
}

/* ═══ строка условия: condRowHtml + bindCondRow ═══ */

function CondRow({ doc, cond, cls, onChange, onEditPre, onEditEnd }: {
  doc: VetviDoc;
  cond: Cond;
  cls?: string;
  onChange: (next: Cond, live?: boolean) => void;
  onEditPre: () => void;
  onEditEnd: () => void;
}) {
  const vars = varsList(doc);
  const v0 = varById(doc, cond.vid);
  const vt = v0 ? varType(v0) : 'num';
  const cops = condOpsFor(vt);
  const setVar = (vid: string) => {
    const nv = varById(doc, vid);
    const op = (nv && !condOpsFor(varType(nv))[cond.op]) ? '==' : cond.op;
    onChange({ vid, op, val: castInspVal(cond.val) });
  };
  return (
    <div className={'v-row op' + (cls ? ' ' + cls : '')}>
      <select className="inp v-var" title="Переменная" value={cond.vid} onChange={(ev) => setVar(ev.target.value)}>
        {vars.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
      </select>
      <select className="inp v-op" title="Сравнение" value={cond.op} onChange={(ev) => onChange({ ...cond, op: ev.target.value })}>
        {Object.keys(cops).map((k) => <option key={k} value={k}>{cops[k]}</option>)}
      </select>
      {vt === 'bool' ? (
        <select
          className="inp v-val"
          title="Значение"
          value={isTrueVal(cond.val) ? '1' : '0'}
          onChange={(ev) => onChange({ ...cond, val: ev.target.value === '1' })}
        >
          <option value="1">true</option>
          <option value="0">false</option>
        </select>
      ) : (
        <input
          className="inp v-val"
          title="Значение"
          value={String(cond.val ?? '')}
          onFocus={onEditPre}
          onChange={(ev) => onChange({ ...cond, val: castInspVal(ev.target.value) }, true)}
          onBlur={onEditEnd}
        />
      )}
    </div>
  );
}

/* ═══ grip-перетаскивание строк исходов/кнопок (bindOutcomeDrag) ═══ */

let outDragOid: string | null = null;

function GripCell({ title }: { title: string }) {
  return (
    <span
      className="out-grip"
      title={title}
      onPointerDown={(ev) => ev.stopPropagation()}
      onMouseDown={(ev) => {
        const row = (ev.currentTarget as HTMLElement).closest('.out-ed');
        if (row) row.setAttribute('draggable', 'true');
      }}
      onDoubleClick={(ev) => ev.preventDefault()}
    >
      <Ico name="grip" size={10} />
    </span>
  );
}

/* ═══ нода: инспектор (renderInspNode) ═══ */

/* ── ввод тегов ноды (iTags): сырой черновик в локальном состоянии ──
   Классический контролируемый input с value={tags.join(', ')} съедал запятую:
   «акт 1,» → split+filter(Boolean) → tags без пустого хвоста → value
   перерисовывался как «акт 1» и запятую было не ввести — второй тег создать
   было нельзя. Черновик живёт до blur, в стор уходит разобранный список. */
function TagInput({ store, n, commit, editPreRef }: {
  store: VetviStore;
  n: VetviNode;
  commit: (patch: Partial<VetviNode>, opts?: { history?: boolean; label?: string }) => void;
  editPreRef: React.MutableRefObject<string | null>;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const joined = Array.isArray(n.tags) ? (n.tags as string[]).join(', ') : '';
  return (
    <input
      className="inp"
      id="iTags"
      value={draft !== null ? draft : joined}
      placeholder="акт 1, хаб…"
      onFocus={() => {
        editPreRef.current = store.beginEdit();
        setDraft(joined);
      }}
      onChange={(ev) => {
        const raw = ev.target.value;
        setDraft(raw);
        commit(
          { tags: raw.split(',').map((s) => s.trim()).filter(Boolean) },
          { history: false },
        );
      }}
      onBlur={() => {
        store.commitEdit(editPreRef.current, 'Метки ноды');
        editPreRef.current = null;
        setDraft(null);
      }}
    />
  );
}

function NodeBody({ store, n, editPreRef }: { store: VetviStore; n: VetviNode; editPreRef: React.MutableRefObject<string | null> }) {
  const doc = store.doc;
  const isDialog = n.type === 'dialog';
  const customs = customTypesOf(doc);
  const isCustom = !TYPES[n.type];
  const cst = customs.find((c) => c.id === n.type) || null;
  const baseInfo = typeInfo(n.type);
  const typeName = isCustom ? (cst ? cst.name : baseInfo.name) : baseInfo.name;
  const typeColor = isCustom ? ((cst && cst.color) ? cst.color : '#8b929c') : baseInfo.color;
  const gr = n.gid ? store.groupById(n.gid) : null;
  const inn = doc.edges.filter((e) => e.to === n.id).length;
  const out = doc.edges.filter((e) => e.from === n.id).length;
  const chars = doc.chars || [];

  const commit = (patch: Partial<VetviNode>, opts?: { history?: boolean; label?: string }) => store.updateNode(n.id, patch, opts);

  const changeType = (v: string) => {
    if (isDialog) { commit({ type: v }, { label: 'Тип ноды' }); return; }
    store.mutate((d) => {
      const nn = d.nodes.find((x) => x.id === n.id);
      if (!nn) return;
      nn.type = v;
      if (v !== 'varnode') { delete nn.vid; delete nn.varMode; delete nn.varOp; delete nn.varVal; }
      if (v !== 'branch' && Array.isArray(nn.outcomes)) delete nn.outcomes;
    }, { label: 'Тип ноды' });
  };

  const pickColor = (v: string | null, fromPicker: boolean) => {
    store.mutate((d) => {
      const nn = d.nodes.find((x) => x.id === n.id);
      if (!nn) return;
      if (v === null) { nn.color = null; nn.tint = 0; return; }
      if (fromPicker) paletteAdd(d, v);
      nn.color = v;
    }, { label: v === null ? 'Сброс цвета элемента' : 'Цвет элемента' });
  };

  const typehead = (
    <div className="i-typehead" id="iTypeWrap">
      <span className="i-typeico" style={{ color: typeColor, background: 'rgba(255,255,255,.05)' }}>
        <TypeIcon type={n.type} size={18} />
      </span>
      <select className="inp" id="iType" value={n.type} onChange={(ev) => changeType(ev.target.value)}>
        {Object.keys(TYPES).map((t) => <option key={t} value={t}>{TYPES[t].name}</option>)}
        {customs.map((c) => <option key={c.id} value={c.id}>{c.name} (свой)</option>)}
      </select>
    </div>
  );

  const statusSeg = (
    <>
      <label className="i-lab">Статус</label>
      <div className="seg" id="iSt">
        {Object.keys(STATUS_INSP).map((k) => (
          <button
            key={k}
            type="button"
            data-s={k}
            className={n.status === k ? 'on c-' + k : ''}
            onClick={() => commit({ status: k }, { label: 'Статус ноды' })}
          >
            {STATUS_INSP[k]}
          </button>
        ))}
      </div>
    </>
  );

  const titleInput = (
    <input
      className="inp"
      id="iTitle"
      value={n.title}
      maxLength={80}
      onFocus={() => { editPreRef.current = store.beginEdit(); }}
      onChange={(ev) => commit({ title: ev.target.value }, { history: false })}
      onBlur={() => { store.commitEdit(editPreRef.current, 'Название ноды'); editPreRef.current = null; }}
      onKeyDown={(ev) => { if (ev.key === 'Enter') (ev.target as HTMLInputElement).blur(); }}
    />
  );

  const meta = (
    <div className="i-meta">
      тип: {typeName}
      {gr ? <><br />группа: {gr.name}</> : null}
      <br />ID: {n.id} · входов: {inn} · выходов: {out}
    </div>
  );

  const capEl = <div className="i-cap">{nodeCap(n, isCustom && cst ? cst.name : null)}</div>;

  const nodeActs = (
    <div className="i-actions">
      <button type="button" className="btn" title={'Дубль (' + hkText('duplicate') + ')'} onClick={() => { const r = store.duplicateSelection(); if (r) store.startCarry(r.ids, r.pre); }}>
        <Ico name="copy" />Дубль
      </button>
      <button type="button" className="btn" title={'Центр (' + hkText('centerSel') + ')'} onClick={() => store.requestCenter(n.id)}>
        <Ico name="target" />Центр
      </button>
      <button type="button" className="btn danger" title={'Удалить (' + hkText('deleteSel') + ')'} onClick={() => store.deleteSelected()}>
        <Ico name="trash" />Удалить
      </button>
    </div>
  );

  /* ── диалог (ветка dialog оригинала) ── */
  if (isDialog && n.dialog) {
    const d = n.dialog;
    const parts = Array.isArray(d.participants) ? d.participants : [];
    const avail = chars.filter((c) => parts.indexOf(c.id) < 0);
    const replies = Array.isArray(d.replies) ? d.replies : [];
    const cr = countReplies(replies);
    return (
      <>
        {capEl}
        {typehead}
        <label className="i-lab">Название диалога</label>
        {titleInput}
        {statusSeg}
        <div className="i-seqrow" title="Режим проигрывания этой ноды в новелле">
          <button type="button" className={'n-seq' + (n.linear ? ' on' : '')} id="iSeq" onClick={() => store.setDlgLinear(n.id, !n.linear)}><i /></button>
          <span className="i-seqlab">Проигрывать подряд — все реплики диалога идут одна за другой, без выбора ответа</span>
        </div>
        <label className="i-lab">Участники</label>
        <div id="dlgParts">
          {parts.map((pid) => (
            <PartChip key={pid} store={store} pid={pid} onRemove={() => removeDialogPart(store, n.id, pid)} />
          ))}
        </div>
        <select
          className="inp"
          id="dlgAddPart"
          style={{ marginTop: 6, height: 28, fontSize: 11.5 }}
          value=""
          onChange={(ev) => {
            const v = ev.target.value;
            if (v) store.setParticipants(n.id, [...parts, v]);
          }}
        >
          <option value="">+ добавить участника…</option>
          {avail.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <label className="i-lab">Описание</label>
        <textarea
          className="inp"
          id="dlgDesc"
          placeholder="Кратко о чём диалог, контекст…"
          style={{ minHeight: 60 }}
          value={d.description || ''}
          onFocus={() => { editPreRef.current = store.beginEdit(); }}
          onChange={(ev) => {
            const v = ev.target.value;
            store.mutate((d2) => {
              const nn = d2.nodes.find((x) => x.id === n.id);
              if (nn && nn.dialog) nn.dialog.description = v;
            }, { history: false });
          }}
          onBlur={() => { store.commitEdit(editPreRef.current, 'Описание диалога'); editPreRef.current = null; }}
        />
        <label className="i-lab">Реплики ({cr})</label>
        <div style={{ marginTop: 6 }}>
          <button type="button" className="btn primary" id="dlgEditReplies" style={{ width: '100%' }} onClick={() => store.openDialogEditor(n.id)}>
            <Ico name="pencil" size={14} />Редактировать реплики
          </button>
        </div>
        {replies.length >= 2 && (
          <div style={{ marginTop: 6 }}>
            <button type="button" className="btn" id="dlgSplitBtn" style={{ width: '100%' }} title="Разбить диалог на отдельные ноды — по одной на реплику" onClick={() => store.splitDialogNode(n.id, false)}>
              <Ico name="expand" size={14} />Разбить на реплики ({replies.length})
            </button>
          </div>
        )}
        {cr > replies.length && cr >= 2 && (
          <div style={{ marginTop: 6 }}>
            <button type="button" className="btn" id="dlgSplitAllBtn" style={{ width: '100%' }} title="Разбить на отдельные ноды — по одной на каждую реплику, включая вложенные (ответ-ветки); порядок — сверху вниз" onClick={() => store.splitDialogNode(n.id, true)}>
              <Ico name="corner" size={14} />Разбить на все реплики ({cr})
            </button>
          </div>
        )}
        <NotesSection store={store} n={n} />
        {meta}
        {nodeActs}
      </>
    );
  }

  /* ── обычная нода (общая ветка renderInspNode) ── */
  const parts = Array.isArray(n.participants) ? (n.participants as string[]) : [];
  const avail = chars.filter((c) => parts.indexOf(c.id) < 0);
  const tint = clamp(typeof n.tint === 'number' ? n.tint : 0, -60, 60);
  const isBranch = n.type === 'branch';
  const isAction = n.type === 'action';
  const isVar = n.type === 'varnode';
  return (
    <>
      {capEl}
      {typehead}
      <label className="i-lab">Название (или {hkText('rename')} на холсте)</label>
      {titleInput}
      {statusSeg}
      <label className="i-lab">Участники</label>
      <div id="nParts">
        {parts.length
          ? parts.map((pid) => (
            <PartChip
              key={pid}
              store={store}
              pid={pid}
              onRemove={() => store.updateNode(n.id, { participants: parts.filter((p) => p !== pid) }, { label: 'Участники элемента' })}
            />
          ))
          : <span style={{ fontSize: 11, color: 'var(--tx3)' }}>пока никого — добавьте персонажей</span>}
      </div>
      <select
        className="inp"
        id="nAddPart"
        style={{ marginTop: 6, height: 28, fontSize: 11.5 }}
        value=""
        disabled={!avail.length}
        onChange={(ev) => {
          const v = ev.target.value;
          if (!v) return;
          store.updateNode(n.id, { participants: [...parts, v] }, { label: 'Участники элемента' });
        }}
      >
        <option value="">+ добавить участника…</option>
        {avail.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
      </select>
      <label className="i-lab">Цвет фона элемента</label>
      <Swatches id="inSw" cur={n.color} doc={doc} onPick={pickColor}>
        <button
          type="button"
          className={'swatch reset' + (n.color ? '' : ' on')}
          title="Сбросить к базовому виду"
          onClick={() => pickColor(null, false)}
        >
          <Ico name="x" size={12} />
        </button>
      </Swatches>
      <label className="i-lab">Яркость цвета: <span id="inTintVal">{(tint > 0 ? '+' : '') + tint}%</span></label>
      <input
        type="range"
        className="inp"
        id="inTint"
        min={-60}
        max={60}
        value={tint}
        onPointerDown={() => { editPreRef.current = store.beginEdit(); }}
        onChange={(ev) => commit({ tint: Number(ev.target.value) }, { history: false })}
        onPointerUp={() => { store.commitEdit(editPreRef.current, 'Яркость ноды'); editPreRef.current = null; }}
        onBlur={() => { store.commitEdit(editPreRef.current, 'Яркость ноды'); editPreRef.current = null; }}
      />
      <label className="i-lab">Описание</label>
      <textarea
        className="inp"
        id="iText"
        placeholder="Что здесь происходит?"
        value={n.text || ''}
        onFocus={() => { editPreRef.current = store.beginEdit(); }}
        onChange={(ev) => commit({ text: ev.target.value }, { history: false })}
        onBlur={() => { store.commitEdit(editPreRef.current, 'Текст ноды'); editPreRef.current = null; }}
      />
      <label className="i-lab">Теги, через запятую</label>
      <TagInput key={n.id} store={store} n={n} commit={commit} editPreRef={editPreRef} />
      {isBranch && <OutcomesEditor store={store} n={n} editPreRef={editPreRef} />}
      {isAction && <ActionsEditor store={store} n={n} editPreRef={editPreRef} />}
      {isVar && <VarNodeEditor store={store} n={n} editPreRef={editPreRef} />}
      <NotesSection store={store} n={n} />
      {meta}
      {nodeActs}
    </>
  );
}

/* ═══ развилка: исходы с условиями (inspOutsHtml + bindInspOuts) ═══ */

function OutcomesEditor({ store, n, editPreRef }: { store: VetviStore; n: VetviNode; editPreRef: React.MutableRefObject<string | null> }) {
  const doc = store.doc;
  const outcomes = Array.isArray(n.outcomes) ? n.outcomes : [];
  const vars = varsList(doc);
  const ov = branchVarOverride(doc, n);
  return (
    <>
      <label className="i-lab">Исходы развилки ({outcomes.length})</label>
      {ov && (
        <div className="vin-hint">
          <span>вход: переменная «{varName(doc, ov)}» — перебивает переменные во всех условиях исходов</span>
          <button
            type="button"
            className="mini-btn"
            id="iVinDel"
            title="Отключить переменную от входа развилки"
            onClick={() => store.mutate((d) => {
              d.edges = d.edges.filter((e) => !(e.to === n.id && e.tin === 'var'));
            }, { label: 'Отключение переменной от входа' })}
          >
            <Ico name="x" size={12} />
          </button>
        </div>
      )}
      <div id="iOuts">
        {!outcomes.length && (
          <div className="v-empty">Добавьте исходы — у каждого появится свой пин на узле (тяните стрелку от строки исхода). Исходу можно привязать переменную: путь откроется только при совпадении значения.</div>
        )}
        {outcomes.map((o, i) => {
          const cs = outConds(o);
          const join = outJoin(o);
          const hasCond = cs.length > 0;
          return (
            <div
              className="out-ed"
              data-i={i}
              key={o.id}
              onDragStart={(ev) => {
                const row = ev.currentTarget as HTMLElement;
                if (row.getAttribute('draggable') !== 'true') { ev.preventDefault(); return; }
                ev.dataTransfer.effectAllowed = 'move';
                try { ev.dataTransfer.setData('text/plain', o.id); } catch { /* старые браузеры */ }
                outDragOid = o.id;
                setTimeout(() => row.classList.add('dragging'), 0);
              }}
              onDragEnd={(ev) => {
                const row = ev.currentTarget as HTMLElement;
                row.removeAttribute('draggable');
                row.classList.remove('dragging', 'drop-above', 'drop-below');
                outDragOid = null;
              }}
              onDragOver={(ev) => {
                if (!outDragOid || outDragOid === o.id) return;
                ev.preventDefault();
                ev.dataTransfer.dropEffect = 'move';
                const row = ev.currentTarget as HTMLElement;
                const rect = row.getBoundingClientRect();
                const below = (ev.clientY - rect.top) > rect.height / 2;
                row.classList.toggle('drop-below', below);
                row.classList.toggle('drop-above', !below);
              }}
              onDragLeave={(ev) => (ev.currentTarget as HTMLElement).classList.remove('drop-above', 'drop-below')}
              onDrop={(ev) => {
                ev.preventDefault();
                ev.stopPropagation();
                const row = ev.currentTarget as HTMLElement;
                const rect = row.getBoundingClientRect();
                const below = (ev.clientY - rect.top) > rect.height / 2;
                row.classList.remove('drop-above', 'drop-below');
                const srcOid = outDragOid;
                outDragOid = null;
                if (!srcOid || srcOid === o.id) return;
                const arr = outcomes;
                const s = arr.findIndex((x) => x.id === srcOid);
                const t = arr.findIndex((x) => x.id === o.id);
                if (s < 0 || t < 0 || s === t) return;
                store.mutate((d) => {
                  const nn = d.nodes.find((x) => x.id === n.id);
                  if (!nn || !Array.isArray(nn.outcomes)) return;
                  movePairInList(nn.outcomes as { id: string }[], srcOid, o.id, below);
                }, { label: 'Изменение порядка исходов' });
              }}
            >
              <div className="out-ed-row">
                <GripCell title="Перетащите — изменить порядок исходов" />
                <input
                  className="inp out-lbl"
                  value={o.label || ''}
                  placeholder="Название исхода…"
                  maxLength={60}
                  onFocus={() => { editPreRef.current = store.beginEdit(); }}
                  onChange={(ev) => store.updateOutcome(n.id, o.id, { label: ev.target.value }, { history: false })}
                  onBlur={() => { store.commitEdit(editPreRef.current, 'Подпись исхода'); editPreRef.current = null; }}
                />
                <button type="button" className="v-del out-del" title="Удалить исход" onClick={() => store.deleteOutcome(n.id, o.id)}>
                  <Ico name="x" size={12} />
                </button>
              </div>
              <div className="out-ed-cond">
                <div className="seg out-cond-tog">
                  <button
                    type="button"
                    data-s="off"
                    className={hasCond ? '' : 'on'}
                    onClick={() => store.setOutcomeConds(n.id, o.id, [], join, 'Сброс условия исхода')}
                  >
                    Без условия
                  </button>
                  <button
                    type="button"
                    data-s="on"
                    className={hasCond ? 'on' : ''}
                    onClick={() => store.setOutcomeConds(n.id, o.id, [branchCondDefault(doc)], join, 'Условие исхода')}
                  >
                    По переменной
                  </button>
                </div>
                {hasCond && vars.length > 0 && (
                  <>
                    {cs.length > 1 && (
                      <div className="seg out-cond-join" title="Как объединяются условия исхода: «все (И)» — путь открыт, когда выполняются все; «любое (ИЛИ)» — достаточно одного">
                        <button
                          type="button"
                          className={join === 'and' ? 'on' : ''}
                          onClick={() => store.setOutcomeConds(n.id, o.id, cs, 'and', 'Объединение условий исхода')}
                        >
                          все (И)
                        </button>
                        <button
                          type="button"
                          className={join === 'or' ? 'on' : ''}
                          onClick={() => store.setOutcomeConds(n.id, o.id, cs, 'or', 'Объединение условий исхода')}
                        >
                          любое (ИЛИ)
                        </button>
                      </div>
                    )}
                    {cs.map((c, ci) => (
                      <div className="out-cond-item" key={ci}>
                        <CondRow
                          doc={doc}
                          cond={c}
                          cls="out-cond-row"
                          onChange={(next, live) => {
                            const arr = cs.map((x, k) => (k === ci ? next : x));
                            store.setOutcomeConds(n.id, o.id, arr, join, 'Условие исхода', live ? { history: false } : undefined);
                          }}
                          onEditPre={() => { editPreRef.current = store.beginEdit(); }}
                          onEditEnd={() => { store.commitEdit(editPreRef.current, 'Условие исхода'); editPreRef.current = null; }}
                        />
                        {cs.length > 1 && (
                          <button
                            type="button"
                            className="v-del out-cond-del"
                            title="Удалить это условие"
                            aria-label="Удалить условие"
                            onClick={() => store.setOutcomeConds(n.id, o.id, cs.filter((_, k) => k !== ci), join, 'Удаление условия исхода')}
                          >
                            <Ico name="x" size={12} />
                          </button>
                        )}
                      </div>
                    ))}
                    {/* иконка вместо текста: текстовая кнопка не влезала в узкую колонку условий.
                        Тултип — название + описание (перенос строки внутри title). */}
                    <button
                      type="button"
                      className="mini-btn out-cond-add"
                      aria-label="Добавить условие"
                      title={'Добавить условие\nДобавляет ещё одну строку проверки переменной. Условия исхода объединяются переключателем выше: «все (И)» — выполняются все сразу, «любое (ИЛИ)» — достаточно одного (например: var1 = true и var2 = 10).'}
                      onClick={() => store.setOutcomeConds(n.id, o.id, [...cs, branchCondDefault(doc)], join, 'Добавление условия исхода')}
                    >
                      <Ico name="plus" size={14} />
                    </button>
                  </>
                )}
                {hasCond && !vars.length && <div className="v-empty">Нет переменных — создайте на вкладке «Переменные».</div>}
              </div>
            </div>
          );
        })}
      </div>
      <div style={{ margin: '6px 0 10px' }}>
        <button type="button" className="btn" id="iOutAdd" style={{ width: '100%' }} onClick={() => store.addOutcome(n.id)}>
          <Ico name="plus" size={14} />Добавить исход
        </button>
      </div>
    </>
  );
}

/* ═══ действие: список кнопок (inspActionsHtml + bindInspActions) ═══ */

function ActionsEditor({ store, n, editPreRef }: { store: VetviStore; n: VetviNode; editPreRef: React.MutableRefObject<string | null> }) {
  const actions = Array.isArray(n.actions) ? (n.actions as { id: string; label?: string }[]) : [];
  return (
    <>
      <label className="i-lab">Кнопки действия ({actions.length})</label>
      <div id="iActs">
        {!actions.length && (
          <div className="v-empty">Добавьте кнопки с коротким текстом — у каждой свой пин на узле. В проигрывании игрок нажимает кнопку: исход задаётся стрелкой от её пина.</div>
        )}
        {actions.map((a, i) => (
          <div
            className="out-ed"
            data-i={i}
            key={a.id}
            onDragStart={(ev) => {
              const row = ev.currentTarget as HTMLElement;
              if (row.getAttribute('draggable') !== 'true') { ev.preventDefault(); return; }
              ev.dataTransfer.effectAllowed = 'move';
              try { ev.dataTransfer.setData('text/plain', a.id); } catch { /* старые браузеры */ }
              outDragOid = a.id;
              setTimeout(() => row.classList.add('dragging'), 0);
            }}
            onDragEnd={(ev) => {
              const row = ev.currentTarget as HTMLElement;
              row.removeAttribute('draggable');
              row.classList.remove('dragging', 'drop-above', 'drop-below');
              outDragOid = null;
            }}
            onDragOver={(ev) => {
              if (!outDragOid || outDragOid === a.id) return;
              ev.preventDefault();
              ev.dataTransfer.dropEffect = 'move';
              const row = ev.currentTarget as HTMLElement;
              const rect = row.getBoundingClientRect();
              const below = (ev.clientY - rect.top) > rect.height / 2;
              row.classList.toggle('drop-below', below);
              row.classList.toggle('drop-above', !below);
            }}
            onDragLeave={(ev) => (ev.currentTarget as HTMLElement).classList.remove('drop-above', 'drop-below')}
            onDrop={(ev) => {
              ev.preventDefault();
              ev.stopPropagation();
              const row = ev.currentTarget as HTMLElement;
              const rect = row.getBoundingClientRect();
              const below = (ev.clientY - rect.top) > rect.height / 2;
              row.classList.remove('drop-above', 'drop-below');
              const srcOid = outDragOid;
              outDragOid = null;
              if (!srcOid || srcOid === a.id) return;
              const s = actions.findIndex((x) => x.id === srcOid);
              const t = actions.findIndex((x) => x.id === a.id);
              if (s < 0 || t < 0 || s === t) return;
              store.mutate((d) => {
                const nn = d.nodes.find((x) => x.id === n.id);
                if (!nn || !Array.isArray(nn.actions)) return;
                movePairInList(nn.actions as { id: string }[], srcOid, a.id, below);
              }, { label: 'Изменение порядка кнопок' });
            }}
          >
            <div className="out-ed-row">
              <GripCell title="Перетащите — изменить порядок кнопок" />
              <input
                className="inp out-lbl"
                value={a.label || ''}
                placeholder="Текст кнопки…"
                maxLength={60}
                onFocus={() => { editPreRef.current = store.beginEdit(); }}
                onChange={(ev) => store.updateAction(n.id, a.id, { label: ev.target.value }, { history: false })}
                onBlur={() => { store.commitEdit(editPreRef.current, 'Кнопка действия'); editPreRef.current = null; }}
              />
              <button type="button" className="v-del out-del" title="Удалить кнопку" onClick={() => store.deleteAction(n.id, a.id)}>
                <Ico name="x" size={12} />
              </button>
            </div>
          </div>
        ))}
      </div>
      <div style={{ margin: '6px 0 10px' }}>
        <button type="button" className="btn" id="iActAdd" style={{ width: '100%' }} onClick={() => store.addAction(n.id)}>
          <Ico name="plus" size={14} />Добавить кнопку
        </button>
      </div>
    </>
  );
}

/* ═══ нода переменной (inspVarHtml + bindInspVar) ═══ */

function VarNodeEditor({ store, n, editPreRef }: { store: VetviStore; n: VetviNode; editPreRef: React.MutableRefObject<string | null> }) {
  const doc = store.doc;
  const vars = varsList(doc);
  const v0 = varById(doc, n.vid);
  const vt = v0 ? varType(v0) : 'num';
  const mode = n.varMode === 'get' ? 'get' : 'set';
  const opd = opsForType(vt);
  return (
    <>
      <label className="i-lab">Переменная</label>
      <select
        className="inp"
        id="iVarSel"
        value={n.vid || ''}
        onChange={(ev) => store.updateNode(n.id, { vid: ev.target.value || null }, { label: 'Привязка переменной' })}
      >
        <option value="">— не выбрана —</option>
        {vars.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
      </select>
      {!vars.length && <div className="v-empty">Нет переменных — создайте их на вкладке «Переменные» слева, либо перетащите переменную на холст.</div>}
      <label className="i-lab">Режим ноды</label>
      <div className="seg" id="iVarMode">
        <button
          type="button"
          data-m="get"
          className={mode === 'get' ? 'on' : ''}
          title="Показывает значение переменной"
          onClick={() => store.updateNode(n.id, { varMode: 'get' }, { label: 'Режим переменной' })}
        >
          Чтение
        </button>
        <button
          type="button"
          data-m="set"
          className={mode === 'set' ? 'on' : ''}
          title="Меняет значение переменной"
          onClick={() => store.updateNode(n.id, { varMode: 'set' }, { label: 'Режим переменной' })}
        >
          Изменение
        </button>
      </div>
      {mode === 'set' && vars.length > 0 && (
        <div className="v-row op" id="iVarOpRow" style={{ marginTop: 6 }}>
          <select
            className="inp v-op"
            title="Операция"
            value={String(n.varOp ?? '=')}
            onChange={(ev) => store.updateNode(n.id, { varOp: ev.target.value }, { label: 'Операция переменной' })}
          >
            {Object.keys(opd).map((k) => <option key={k} value={k}>{opd[k]}</option>)}
          </select>
          {vt === 'bool' ? (
            <select
              className="inp v-val"
              title="Значение"
              value={isTrueVal(n.varVal) ? '1' : '0'}
              onChange={(ev) => store.updateNode(n.id, { varVal: ev.target.value === '1' }, { label: 'Значение переменной' })}
            >
              <option value="1">true</option>
              <option value="0">false</option>
            </select>
          ) : (
            <input
              className="inp v-val"
              title={vt === 'num' ? 'На сколько изменить' : 'Новое значение'}
              value={String(n.varVal ?? '')}
              onFocus={() => { editPreRef.current = store.beginEdit(); }}
              onChange={(ev) => store.updateNode(n.id, { varVal: castInspVal(ev.target.value) }, { history: false })}
              onBlur={() => { store.commitEdit(editPreRef.current, 'Значение переменной'); editPreRef.current = null; }}
            />
          )}
        </div>
      )}
      {mode === 'get' && <div className="v-empty" style={{ marginTop: 6 }}>В режиме новеллы эта нода считает значение (всплывашка у HUD) и ведёт дальше; её можно соединить со входом «переменная» у развилки.</div>}
    </>
  );
}

/* ═══ связь (renderInspEdge + inspCondHtml) ═══ */

function EdgeBody({ store, eid, editPreRef }: { store: VetviStore; eid: string; editPreRef: React.MutableRefObject<string | null> }) {
  const e = store.edgeById(eid);
  if (!e) return null;
  const A = store.nodeById(e.from);
  const B = store.nodeById(e.to);
  const kind = e.kind || 'flow';

  let fromReplyInfo: ReactNode = null;
  if (A && A.type === 'dialog' && e.fromReply) {
    const r = findReplyText(A.dialog?.replies, e.fromReply);
    if (r) fromReplyInfo = <><br />из реплики: «{r.slice(0, 40)}»</>;
  }
  let fromOutInfo: ReactNode = null;
  if (A && A.type === 'branch' && e.fromOut) {
    const oo = (A.outcomes || []).find((o) => o.id === e.fromOut);
    if (oo) fromOutInfo = <><br />из исхода: «{oo.label || 'Исход'}»</>;
  }

  return (
    <>
      <div className="i-cap">Связь</div>
      <label className="i-lab">Подпись</label>
      <input
        className="inp"
        id="iLbl"
        value={e.label || ''}
        placeholder="например: условие выполнено"
        onFocus={() => { editPreRef.current = store.beginEdit(); }}
        onChange={(ev) => store.setEdgeLabel(eid, ev.target.value, { history: false })}
        onBlur={() => { store.commitEdit(editPreRef.current, 'Подпись связи'); editPreRef.current = null; }}
      />
      <label className="i-lab">Тип связи</label>
      <div className="seg" id="iKind">
        {Object.keys(KINDS).map((k) => (
          <button key={k} type="button" data-k={k} className={kind === k ? 'on' : ''} onClick={() => store.setEdgeKind(eid, k)}>
            {KINDS[k]}
          </button>
        ))}
      </div>
      {A && A.type === 'branch' && <EdgeCondSection store={store} e={e} editPreRef={editPreRef} />}
      <div className="i-meta">
        из: «{A ? A.title : '?'}»{fromReplyInfo}{fromOutInfo}
        <br />в: «{B ? B.title : '?'}»
        <br />ID: {e.id}
      </div>
      {store.selEdges.size > 1 && <div className="i-meta">выбрано связей: {store.selEdges.size}</div>}
      {!!(e.pts && e.pts.length) && <div className="i-meta">точек излома: {e.pts.length}</div>}
      <div className="i-actions">
        <button type="button" className="btn" id="iSwap" onClick={() => store.reverseEdge(eid)}>
          <Ico name="swap" />Развернуть
        </button>
        <button type="button" className="btn danger" id="iDelE" onClick={() => store.deleteEdge(eid)}>
          <Ico name="trash" />Удалить
        </button>
      </div>
    </>
  );
}

function EdgeCondSection({ store, e, editPreRef }: { store: VetviStore; e: { id: string; cond?: unknown }; editPreRef: React.MutableRefObject<string | null> }) {
  const doc = store.doc;
  const vars = varsList(doc);
  const on = !!e.cond;
  const cond = (e.cond || null) as Cond | null;
  return (
    <>
      <label className="i-lab">Условие перехода (развилка)</label>
      <div className="seg" id="iCondTog">
        <button
          type="button"
          data-s="off"
          className={on ? '' : 'on'}
          onClick={() => store.setEdgeCond(e.id, null)}
        >
          Без условия
        </button>
        <button
          type="button"
          data-s="on"
          className={on ? 'on' : ''}
          onClick={() => store.setEdgeCond(e.id, branchCondDefault(doc) as { vid: string; op: string; val: number | string })}
        >
          По переменной
        </button>
      </div>
      {on && vars.length > 0 && (
        <CondRow
          doc={doc}
          cond={cond as Cond}
          cls="iCondRow"
          onChange={(next, live) => {
            if (live) store.updateEdge(e.id, { cond: next as { vid: string; op: string; val: number | string } }, { history: false });
            else store.setEdgeCond(e.id, next as { vid: string; op: string; val: number | string });
          }}
          onEditPre={() => { editPreRef.current = store.beginEdit(); }}
          onEditEnd={() => { store.commitEdit(editPreRef.current, 'Условие связи'); editPreRef.current = null; }}
        />
      )}
      {on && !vars.length && <div className="v-empty">Нет переменных — создайте на вкладке «Переменные» слева.</div>}
    </>
  );
}

/* ═══ группа / цепочка (renderInspGroup) ═══ */

function GroupBody({ store, gid, editPreRef }: { store: VetviStore; gid: string; editPreRef: React.MutableRefObject<string | null> }) {
  const g = store.groupById(gid);
  if (!g) return null;
  if (g.stack === true) return <StackBody store={store} g={g} editPreRef={editPreRef} />;

  const doc = store.doc;
  const ms = allDescNodes(doc, gid);
  const fold = typeof g.fold === 'number' ? g.fold : 2;
  const parents = doc.groups.filter((o) => o.id !== gid && !isDescGroup(doc, o.id, gid));
  const alpha = Math.round(clamp(typeof g.alpha === 'number' ? g.alpha : 0.55, 0.1, 1) * 100);

  const pickColor = (v: string | null, fromPicker: boolean) => {
    store.mutate((d) => {
      const gg = d.groups.find((x) => x.id === gid);
      if (!gg) return;
      if (fromPicker && v) paletteAdd(d, v);
      gg.color = v;
    }, { label: 'Цвет группы' });
  };

  return (
    <>
      <div className="i-cap">Группа</div>
      <label className="i-lab">Название</label>
      <input
        className="inp"
        id="igName"
        value={g.name || ''}
        maxLength={60}
        onFocus={() => { editPreRef.current = store.beginEdit(); }}
        onChange={(ev) => store.updateGroup(gid, { name: ev.target.value }, { history: false })}
        onBlur={() => { store.commitEdit(editPreRef.current, 'Название группы'); editPreRef.current = null; }}
      />
      <label className="i-lab">Вид</label>
      <div className="seg" id="igFoldSeg">
        {[2, 1, 0].map((f) => (
          <button
            key={f}
            type="button"
            data-f={f}
            className={fold === f ? 'on' : ''}
            onClick={() => store.updateGroup(gid, { fold: f }, { label: 'Смена вида группы' })}
          >
            {FOLD_NAMES[f]}
          </button>
        ))}
      </div>
      <label className="i-lab">Родительская группа</label>
      <select
        className="inp"
        id="igParent"
        value={g.parent || ''}
        onChange={(ev) => store.updateGroup(gid, { parent: ev.target.value || null }, { label: 'Вложенность группы' })}
      >
        <option value="">— нет —</option>
        {parents.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>
      <label className="i-lab">Цвет</label>
      <Swatches id="igSw" cur={g.color || null} doc={doc} extraFirst={['#9aa1ac']} onPick={pickColor} />
      <label className="i-lab">Прозрачность: <span id="igAlphaVal">{alpha}%</span></label>
      <input
        type="range"
        className="inp"
        id="igAlpha"
        min={10}
        max={100}
        value={alpha}
        onPointerDown={() => { editPreRef.current = store.beginEdit(); }}
        onChange={(ev) => store.updateGroup(gid, { alpha: Number(ev.target.value) / 100 }, { history: false })}
        onPointerUp={() => { store.commitEdit(editPreRef.current, 'Прозрачность группы'); editPreRef.current = null; }}
        onBlur={() => { store.commitEdit(editPreRef.current, 'Прозрачность группы'); editPreRef.current = null; }}
      />
      <label className="chk">
        <input
          type="checkbox"
          id="igBadge"
          checked={!!g.badge}
          onChange={(ev) => {
            const on = ev.target.checked;
            store.mutate((d) => {
              const gg = d.groups.find((x) => x.id === gid);
              if (gg) (gg as { badge?: unknown }).badge = on;
            }, { label: on ? 'Ярлык группы: вкл' : 'Ярлык группы: выкл' });
          }}
        />
        Ярлык с именем (не зависит от зума)
      </label>
      <label className="chk">
        <input
          type="checkbox"
          id="igAuto"
          checked={!!g.auto}
          onChange={(ev) => {
            const on = ev.target.checked;
            /* toggleAuto оригинала (4548–4559): ВКЛ — очистить ручную рамку (следует за
               содержимым), ВЫКЛ — «морозить» текущий расчётный размер в fw/fh (иначе
               после выключения рамка продолжала бы тянуться и ноду не вынести) */
            const box = document.querySelector('.groupbox[data-gid="' + gid + '"]') as HTMLElement | null;
            store.mutate((d) => {
              const gg = d.groups.find((x) => x.id === gid);
              if (!gg) return;
              if (on) {
                gg.auto = true;
                delete gg.fx;
                delete gg.fy;
                delete gg.fw;
                delete gg.fh;
              } else {
                gg.auto = false;
                if (box) {
                  gg.x = box.offsetLeft;
                  gg.y = box.offsetTop;
                  gg.fw = box.offsetWidth;
                  gg.fh = box.offsetHeight;
                }
              }
            }, { label: 'Авторазмер группы' });
          }}
        />
        Авторазмер (рамка следует за содержимым)
      </label>
      <label className="i-lab">Состав ({ms.length})</label>
      <div className="gm-list">
        {ms.map((m) => (
          <div className="gm-row" key={m.id}>
            <span className="dot" style={{ background: m.color || typeInfo(m.type).color }} />
            {m.title || typeInfo(m.type).name}
          </div>
        ))}
      </div>
      <div className="i-actions">
        <button
          type="button"
          className="btn"
          id="igSelAll"
          onClick={() => { const ids = ms.map((m) => m.id); if (ids.length) store.setSel(ids); }}
        >
          <Ico name="target" />Выделить все ноды
        </button>
        {store.membersOf(gid).length >= 2 && (
          <button type="button" className="btn" id="igToQ" onClick={() => store.groupToStack(gid)}>
            <Ico name="queue" />Преобразовать в цепочку
          </button>
        )}
        <button type="button" className="btn danger" id="igUng" onClick={() => store.dissolveGroup(gid)}>
          <Ico name="x" />Распустить
        </button>
      </div>
      <div className="i-meta">«Преобразовать в цепочку»: порядок нод берётся по раскладке (сверху вниз, у широкой группы — слева направо), первая нода сохраняет входящие связи, у остальных старые связи убираются; между соседями появятся связи «кто за кем».</div>
    </>
  );
}

/* цепочка (stack-ветка renderInspGroup) */
function StackBody({ store, g, editPreRef }: { store: VetviStore; g: VetviGroup; editPreRef: React.MutableRefObject<string | null> }) {
  const doc = store.doc;
  const ids = stackOrderIds(doc, g);
  const tint = typeof g.tint === 'number' ? g.tint : 0;
  const pickColor = (v: string | null, fromPicker: boolean) => {
    store.mutate((d) => {
      const gg = d.groups.find((x) => x.id === g.id);
      if (!gg) return;
      if (v === null) { gg.color = null; gg.tint = 0; return; }
      if (fromPicker) paletteAdd(d, v);
      gg.color = v;
    }, { label: v === null ? 'Сброс цвета цепочки' : 'Цвет цепочки' });
  };
  return (
    <>
      <div className="i-cap">Цепочка</div>
      <label className="i-lab">Название</label>
      <input
        className="inp"
        id="igName"
        value={g.name || ''}
        maxLength={60}
        onFocus={() => { editPreRef.current = store.beginEdit(); }}
        onChange={(ev) => store.updateGroup(g.id, { name: ev.target.value }, { history: false })}
        onBlur={() => { store.commitEdit(editPreRef.current, 'Название группы'); editPreRef.current = null; }}
      />
      <label className="i-lab">Цвет фона карточки</label>
      <Swatches id="iqSw" cur={g.color || null} doc={doc} onPick={pickColor}>
        <button
          type="button"
          className={'swatch reset' + (g.color ? '' : ' on')}
          title="Сбросить к обычному цвету нод"
          onClick={() => pickColor(null, false)}
        >
          <Ico name="x" size={12} />
        </button>
      </Swatches>
      <label className="i-lab">Яркость цвета: <span id="iqTintVal">{(tint > 0 ? '+' : '') + tint}%</span></label>
      <input
        type="range"
        className="inp"
        id="iqTint"
        min={-60}
        max={60}
        value={tint}
        onPointerDown={() => { editPreRef.current = store.beginEdit(); }}
        onChange={(ev) => store.updateGroup(g.id, { tint: Number(ev.target.value) }, { history: false })}
        onPointerUp={() => { store.commitEdit(editPreRef.current, 'Яркость цепочки'); editPreRef.current = null; }}
        onBlur={() => { store.commitEdit(editPreRef.current, 'Яркость цепочки'); editPreRef.current = null; }}
      />
      <div className="i-meta" />
      <label className="i-lab">Порядок ({ids.length})</label>
      <div className="gm-list">
        {ids.map((id, i) => {
          const nq = store.nodeById(id);
          if (!nq) return null;
          const ps = (nq.type === 'dialog')
            ? ((nq.dialog && nq.dialog.participants) || [])
            : (Array.isArray(nq.participants) ? (nq.participants as string[]) : []);
          const psOk = ps.filter((p) => store.charById(p));
          const dot = psOk.length ? store.charColor(psOk[0]) : (nq.color || typeInfo(nq.type).color);
          let snip = '';
          if (nq.type === 'dialog' && nq.dialog) {
            const dq = (nq.dialog.description || '').trim();
            const rq = (nq.dialog.replies || []).map((r) => (r.text || '').trim()).filter(Boolean);
            snip = [dq].concat(rq).slice(0, 2).join(' · ');
          } else {
            snip = (nq.text || '').trim();
          }
          if (snip.length > 70) snip = snip.slice(0, 70) + '…';
          return (
            <div className="gm-row" data-nid={nq.id} key={nq.id}>
              <span className="q-num">{i + 1}</span>
              <span className="dot" style={{ background: dot, color: dot }} />
              <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {nq.title}{snip ? <span className="gm-snip"> — {snip}</span> : null}
              </span>
              {psOk.length > 0 && (
                <div className="q-cast">
                  {psOk.map((pid) => (
                    <span key={pid} title="Прикреплённый персонаж" style={{ background: store.charColor(pid) }}>
                      {store.charName(pid)}
                    </span>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div className="i-actions">
        <button type="button" className="btn" id="igToGrp" onClick={() => store.stackToGroup(g.id)}>
          <Ico name="expand" />Преобразовать в группу
        </button>
        <button type="button" className="btn danger" id="igUng" onClick={() => store.dissolveGroup(g.id)}>
          <Ico name="x" />Разобрать цепочку
        </button>
      </div>
      <div className="i-meta">
        тип: цепочка нод<br />ID: {g.id} · входов в цепочку: {doc.edges.filter((e) => ids[0] && e.to === ids[0] && e.tin !== 'var').length}
      </div>
    </>
  );
}

/* ═══ мультивыделение (renderInspMulti) ═══ */

function MultiBody({ store }: { store: VetviStore }) {
  const gn = store.selGroups.size;
  const [name, setName] = useState('');
  const allDialogs = store.sel.size >= 2 && [...store.sel].every((id) => store.nodeById(id)?.type === 'dialog');
  const create = () => store.createGroupFromSel(name.trim());
  return (
    <>
      <div className="i-cap">Группа</div>
      <div className="i-empty" style={{ paddingTop: 6 }}>
        <h3>Выбрано: {store.sel.size} узлов{gn ? ', ' + gn + ' групп' : ''}</h3>
        <p>Выделенные группы станут вложенными в новую. Узлы внутри выделенных групп останутся в них.</p>
      </div>
      <div className="grp-row">
        <input
          className="inp"
          id="mgName"
          placeholder="Название группы…"
          maxLength={60}
          value={name}
          onChange={(ev) => setName(ev.target.value)}
          onKeyDown={(ev) => { if (ev.key === 'Enter') create(); }}
        />
        <button type="button" className="btn primary" id="mgGo" title={'Сгруппировать (' + hkText('group') + ')'} onClick={create}>
          Сгруппировать
        </button>
      </div>
      {allDialogs && (
        <button type="button" className="btn primary" id="mgMerge" style={{ width: '100%', marginTop: 8 }} onClick={() => store.mergeDialogNodes()}>
          <Ico name="dialog" size={14} />Объединить в один диалог
        </button>
      )}
      {store.sel.size >= 2 && store.selAllStackable() && (
        <button type="button" className="btn" id="mgQueue" style={{ width: '100%', marginTop: 8 }} onClick={() => store.stackFromSelection()}>
          <Ico name="queue" size={14} />Собрать в цепочку (по порядку выделения)
        </button>
      )}
      <div className="i-actions">
        <button type="button" className="btn" title={'В ряд (' + hkText('alignH') + ')'} onClick={() => store.alignH()}>
          <Ico name="alignH" />В ряд
        </button>
        <button type="button" className="btn" title={'В столбец (' + hkText('alignV') + ')'} onClick={() => store.alignV()}>
          <Ico name="alignV" />В столбец
        </button>
        <button type="button" className="btn" id="gDup" onClick={() => { const r = store.duplicateSelection(); if (r) store.startCarry(r.ids, r.pre); }}>
          <Ico name="copy" />Дубль
        </button>
        <button type="button" className="btn danger" id="gDel" onClick={() => store.deleteSelected()}>
          <Ico name="trash" />Удалить
        </button>
      </div>
    </>
  );
}

/* ═══ пусто (renderInspEmpty) ═══ */

function EmptyBody({ store }: { store: VetviStore }) {
  const doc = store.doc;
  const customs = customTypesOf(doc);
  const keys = [...Object.keys(TYPES), ...customs.map((c) => c.id)];
  const cells = keys.map((key) => {
    const c = customs.find((x) => x.id === key) || null;
    const info = typeInfo(key);
    const name = c ? c.name : info.name;
    const color = c ? (c.color || '#8b929c') : info.color;
    const cnt = doc.nodes.filter((x) => x.type === key).length;
    return (
      <div className="ovcell" key={key}>
        <span className="d" style={{ background: color }} />
        <span className="n">{name}</span>
        <span className="c">{cnt}</span>
      </div>
    );
  });
  return (
    <div className="i-empty">
      <div className="ghost"><Ico name="branch" size={26} /></div>
      <h3>Ничего не выбрано</h3>
      <p>
        Кликните по узлу, связи или рамке группы.<br />
        <b>Ctrl+ЛКМ</b> (зажать и тянуть) — перемещение по холсту.<br />
        <b>Ctrl+Shift+ЛКМ</b> по холсту — нарисовать новую группу.
      </p>
      <div className="ovgrid">{cells}</div>
      <div className="ovmeta">
        создан: {fmtD(doc.meta.created)}<br />
        изменён: {fmtD(doc.meta.modified)}<br />
        своих типов: {customs.length} · групп: {doc.groups.length}
      </div>
    </div>
  );
}

/* ═══ корень: aside#right → .i-cap → #insp ═══ */

export function Inspector(props: { store: VetviStore; onClose: () => void }) {
  const { store } = props;
  void store.revision;
  const editPreRef = useRef<string | null>(null);
  const inspRef = useRef<HTMLDivElement | null>(null);

  /* ── сворачивание правой панели: свернули — открывается только при ВЫДЕЛЕНИИ ──
     Панель скрыта, пока нет выделения ИЛИ выделение то же, что было активным в
     момент сворачивания (selVer растёт при любом изменении выделения — noteSelFocus).
     Выделили объект — панель открылась с подробностями и функционалом выделенного. */
  const hasSel = store.sel.size > 0 || store.selEdges.size > 0 || store.selGroups.size > 0;
  const inspHidden = store.rightCollapsed && (!hasSel || store.selVer === store.rightCollapseVer);

  /* выбор режима — как в renderInspector оригинала; свой .i-cap у каждого режима внутри #insp */
  let body: ReactNode = null;
  let lockIds: string[] = [];

  const edgeSel = store.selEdges.size > 0 && store.sel.size === 0;
  const eSel = edgeSel ? store.edgeById([...store.selEdges][0]) : undefined;

  if (eSel) {
    lockIds = [eSel.id];
    body = <EdgeBody store={store} eid={eSel.id} editPreRef={editPreRef} />;
  } else {
    const total = store.sel.size + store.selGroups.size;
    if (total > 1) {
      body = <MultiBody store={store} />;
    } else if (total === 1 && store.selGroups.size === 1) {
      const gid = [...store.selGroups][0];
      const g = store.groupById(gid);
      if (g) {
        lockIds = [gid];
        body = <GroupBody store={store} gid={gid} editPreRef={editPreRef} />;
      } else {
        body = <EmptyBody store={store} />;
      }
    } else if (store.sel.size === 1) {
      const nid = [...store.sel][0];
      const n = store.nodeById(nid);
      if (n) {
        lockIds = [nid];
        body = <NodeBody store={store} n={n} editPreRef={editPreRef} />;
      } else {
        body = <EmptyBody store={store} />;
      }
    } else {
      body = <EmptyBody store={store} />;
    }
  }

  /* applyInspectorLockState: блокировка полей, если объект правит другой участник */
  const blk = lockFor(store, lockIds);
  useEffect(() => {
    const box = inspRef.current;
    if (!box) return;
    const els = box.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | HTMLButtonElement>('input,textarea,select,button');
    els.forEach((el) => { el.disabled = false; el.removeAttribute('data-lklock'); });
    const hint = box.querySelector('#inspLockHint');
    if (hint) hint.remove();
    if (!blk) return;
    els.forEach((el) => {
      if (!el.disabled) { el.disabled = true; el.setAttribute('data-lklock', '1'); }
    });
    const d = document.createElement('div');
    d.id = 'inspLockHint';
    d.style.cssText = 'display:flex;align-items:center;gap:7px;margin:2px 0 10px;padding:7px 10px;border:1px solid ' + hexToRgba(blk.color, 0.6) + ';border-radius:8px;background:rgba(226,165,78,.07);font:600 11.5px var(--body);color:#f4d9b8';
    d.innerHTML = '<span style="width:8px;height:8px;border-radius:50%;flex:none;background:' + (blk.color || '#8b929c') + '"></span>Объект используется другим пользователем' + (blk.name ? ' — ' + blk.name : '');
    box.insertBefore(d, box.firstChild);
  });

  /* ── единый aside (всегда смонтирован — ширина/прозрачность анимируются CSS).
     Свёрнутый режим (inspHidden): панель «задвинута» — полоски на всю высоту
     НЕТ, снаружи блока остаётся только хлястик со стрелкой. Контент обёрнут
     в .r-body с overflow:hidden — панель выезжает/заезжает плавно. ── */
  return (
    <aside id="right" className={inspHidden ? 'rcollapsed' : undefined} aria-label="Инспектор">
      <div className="r-body">
        <div className="i-cap">
          Инспектор элемента
          <button
            type="button"
            className="mini-btn"
            title="Снять выделение"
            style={{ float: 'right', width: 20, height: 20, marginTop: -2, marginRight: 4 }}
            onClick={props.onClose}
          >
            ×
          </button>
        </div>
        <div id="insp" ref={inspRef}>
          {body}
        </div>
      </div>
      {/* хлястик: снаружи блока, сверху; клик — свернуть/развернуть, потянуть вправо —
          свернуть (откроется снова при выделении объекта), влево из «задвинутого» — развернуть */}
      <PanelTab
        side="r"
        open={!inspHidden}
        title={inspHidden ? 'Развернуть инспектор — нажать или потянуть влево' : 'Свернуть панель — откроется при выделении объекта (или потянуть вправо)'}
        onToggle={() => store.setRightCollapsed(!store.rightCollapsed)}
        onPull={(dir) => {
          if (!inspHidden && dir === 1) store.setRightCollapsed(true);
          else if (inspHidden && dir === -1) store.setRightCollapsed(false);
        }}
      />
    </aside>
  );
}
