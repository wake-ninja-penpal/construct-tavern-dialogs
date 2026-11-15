'use client';

/**
 * Ветви — инспектор (этап 2): все типы нод — название/статус/цвет/текст,
 * диалог (участники + реплики + редактор в отдельном окне), развилка (исходы
 * с условиями по переменным + перебивание входом), действие (кнопки),
 * переменная (выбор/режим/операция/значение), связь (подпись/тип/условие/разворот),
 * мультивыделение (выравнивание/группа/дубль), группа (имя/вид/цвет/альфа/состав).
 */

import { useRef } from 'react';

import { PALETTE_COLORS, STATUS_CYCLE, STATUS_RU, TYPES } from '@/vetvi/core/constants';
import { shadeHex } from '@/vetvi/core/geometry';
import type { VetviNode } from '@/vetvi/core/types';
import { condOpsFor, condText, opsForType, varById, varType, varValText } from '@/vetvi/core/vars';
import type { Cond } from '@/vetvi/core/vars';
import type { VetviStore } from './store';

export function Inspector(props: { store: VetviStore; onClose: () => void }) {
  const { store } = props;
  void store.revision;
  const editPreRef = useRef<string | null>(null);

  /* ── группа ── */
  if (store.selGroups.size === 1 && !store.sel.size) {
    const gid = [...store.selGroups][0];
    const g = store.groupById(gid);
    if (g) return <GroupInspector store={store} gid={gid} onClose={props.onClose} editPreRef={editPreRef} />;
  }

  /* ── мультивыделение ── */
  if (store.sel.size > 1) {
    return (
      <aside className="rn-inspector" aria-label="Инспектор: выделение">
        <div className="rn-insp-head">
          <span className="rn-insp-type">Выделено: {store.sel.size}</span>
          <button type="button" className="rn-insp-x" title="Снять выделение" onClick={props.onClose}>×</button>
        </div>
        <div className="rn-btn-row">
          <button type="button" className="rn-mini" onClick={() => store.alignH()}>Выровнять в ряд</button>
          <button type="button" className="rn-mini" onClick={() => store.alignV()}>Выровнять в столбец</button>
        </div>
        <div className="rn-btn-row">
          <button type="button" className="rn-mini" onClick={() => { const r = store.duplicateSelection(); if (r) store.startCarry(r.ids, r.pre); }}>Дубль (Ctrl+D)</button>
          <button type="button" className="rn-mini" onClick={() => { store.openModal('groupCreate'); }}>Сгруппировать (Ctrl+G)</button>
          <button type="button" className="rn-mini" onClick={() => store.exportSelection()}>Экспорт в JSON</button>
        </div>
        <div className="rn-insp-foot">
          <button type="button" className="rn-danger" onClick={() => store.deleteSelected()}>Удалить выделенное</button>
        </div>
      </aside>
    );
  }

  /* ── связь ── */
  if (store.selEdges.size && !store.sel.size) {
    const eid = [...store.selEdges][0];
    const e = store.edgeById(eid);
    if (e) return <EdgeInspector store={store} eid={eid} onClose={props.onClose} editPreRef={editPreRef} />;
  }

  const id = store.sel.size ? [...store.sel][0] : null;
  const n = id ? store.nodeById(id) : null;
  if (!n) {
    return (
      <aside className="rn-inspector empty" aria-label="Инспектор">
        <div className="rn-insp-title">Инспектор</div>
        <div className="rn-insp-hint">Ничего не выбрано. Кликните по ноде, связи или группе на холсте.</div>
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

  const chars = store.doc.chars || [];
  const participants = isDialog && n.dialog ? n.dialog.participants || [] : [];

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
          onFocus={() => { editPreRef.current = store.beginEdit(); }}
          onChange={(e) => store.updateNode(n.id, { title: e.target.value }, { history: false })}
          onBlur={() => { store.commitEdit(editPreRef.current, 'Название ноды'); editPreRef.current = null; }}
          onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
          aria-label="Название ноды"
        />
      </label>

      <div className="rn-field">
        <span>Статус</span>
        <div className="rn-seg" role="group" aria-label="Статус ноды">
          {STATUS_CYCLE.map((s) => (
            <button key={s} type="button" className={'c-' + s + (n.status === s ? ' on' : '')} onClick={() => commit({ status: s })}>
              {STATUS_RU[s]}
            </button>
          ))}
        </div>
      </div>

      <div className="rn-field">
        <span>Цвет</span>
        <div className="rn-palette">
          {PALETTE_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              className={'rn-swatch' + (baseColor.toLowerCase() === c ? ' on' : '')}
              style={{ background: shadeHex(c, -60) }}
              title={c}
              aria-label={'Цвет ' + c}
              onClick={() => { commit({ color: c, tint: -60 }); }}
            />
          ))}
          <input
            type="color"
            className="rn-picker"
            title="Свой цвет"
            value={/^#[0-9a-fA-F]{6}$/.test(baseColor) ? baseColor : '#e2a54e'}
            onChange={(e) => commit({ color: e.target.value, tint: 0 })}
            aria-label="Свой цвет ноды"
          />
        </div>
        <div className="rn-tint-row">
          <span>Яркость</span>
          <input
            type="range"
            min={-60}
            max={60}
            step={10}
            value={Number(n.tint ?? -60)}
            onChange={(e) => store.updateNode(n.id, { tint: Number(e.target.value) }, { history: false })}
            onMouseUp={() => { store.commitEdit(editPreRef.current, 'Яркость ноды'); editPreRef.current = store.beginEdit(); }}
            aria-label="Яркость цвета"
          />
        </div>
      </div>

      {isDialog && n.dialog && (
        <>
          <div className="rn-field">
            <span>Участники диалога</span>
            <div className="rn-parts">
              {chars.length === 0 && <div className="rn-insp-hint">Нет персонажей — создайте их на вкладке «Персонажи» слева.</div>}
              {chars.map((c) => {
                const on = participants.includes(c.id);
                return (
                  <button
                    key={c.id}
                    type="button"
                    className={'rn-part' + (on ? ' on' : '')}
                    style={on ? { ['--pc' as string]: c.color || '#9cb878' } : undefined}
                    onClick={() => {
                      const next = on ? participants.filter((p) => p !== c.id) : [...participants, c.id];
                      store.setParticipants(n.id, next);
                    }}
                  >
                    <span className={'rn-av sm ' + (c.avShape === 'square' ? 'square' : 'circle') + (c.av ? '' : ' empty')} style={{ borderColor: c.color || '#9cb878' }}>
                      {c.av ? <img src={String(c.av)} alt="" /> : (c.name || '?')[0].toUpperCase()}
                    </span>
                    {c.name}
                  </button>
                );
              })}
            </div>
          </div>
          <label className="rn-field">
            <span>Описание диалога</span>
            <textarea
              rows={3}
              value={n.dialog.description}
              onFocus={() => { editPreRef.current = store.beginEdit(); }}
              onChange={(e) => store.updateNode(n.id, { dialog: { ...n.dialog!, description: e.target.value } }, { history: false })}
              onBlur={() => { store.commitEdit(editPreRef.current, 'Описание диалога'); editPreRef.current = null; }}
              aria-label="Описание диалога"
            />
          </label>
          <div className="rn-field">
            <div className="rn-row-head">
              <span>Реплики ({n.dialog.replies.length})</span>
              <button type="button" className="rn-mini" onClick={() => store.openDialogEditor(n.id)}>Открыть редактор…</button>
            </div>
            <div className="rn-seg">
              <button type="button" className={n.linear ? 'on' : ''} onClick={() => store.setDlgLinear(n.id, true)} title="Проигрывать реплики подряд">▸▸ подряд</button>
              <button type="button" className={!n.linear ? 'on' : ''} onClick={() => store.setDlgLinear(n.id, false)}>ветвление</button>
            </div>
          </div>
        </>
      )}

      {!isDialog && !isVar && (
        <label className="rn-field">
          <span>Текст</span>
          <textarea
            rows={4}
            value={n.text}
            onFocus={() => { editPreRef.current = store.beginEdit(); }}
            onChange={(e) => store.updateNode(n.id, { text: e.target.value }, { history: false })}
            onBlur={() => { store.commitEdit(editPreRef.current, 'Текст ноды'); editPreRef.current = null; }}
            aria-label="Текст ноды"
          />
        </label>
      )}

      <label className="rn-field">
        <span>Метки (через запятую)</span>
        <input
          value={Array.isArray(n.tags) ? (n.tags as string[]).join(', ') : ''}
          onFocus={() => { editPreRef.current = store.beginEdit(); }}
          onChange={(e) => store.updateNode(n.id, { tags: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) }, { history: false })}
          onBlur={() => { store.commitEdit(editPreRef.current, 'Метки ноды'); editPreRef.current = null; }}
          aria-label="Метки ноды"
        />
      </label>

      {isBranch && <OutcomesEditor store={store} n={n} editPreRef={editPreRef} />}
      {isAction && <ActionsEditor store={store} n={n} editPreRef={editPreRef} />}
      {isVar && <VarNodeEditor store={store} n={n} editPreRef={editPreRef} />}

      <div className="rn-insp-foot">
        <button type="button" className="rn-mini" onClick={() => { const r = store.duplicateSelection(); if (r) store.startCarry(r.ids, r.pre); }}>Дубль</button>
        {n.gid && <button type="button" className="rn-mini" onClick={() => store.leaveGroup(n.id)}>Покинуть группу</button>}
        <button type="button" className="rn-danger" onClick={() => store.deleteSelected()}>Удалить ноду</button>
      </div>
    </aside>
  );
}

/* ── исходы развилки с условиями ── */
function OutcomesEditor({ store, n, editPreRef }: { store: VetviStore; n: VetviNode; editPreRef: React.MutableRefObject<string | null> }) {
  const outcomes = Array.isArray(n.outcomes) ? n.outcomes : [];
  const vars = store.doc.vars || [];
  const ov = store.doc.edges.find((e) => e.to === n.id && e.tin === 'var');
  const overrideSrc = ov ? store.nodeById(ov.from) : null;
  const overrideVid = overrideSrc && overrideSrc.type === 'varnode' ? overrideSrc.vid : null;
  return (
    <div className="rn-field">
      <div className="rn-row-head">
        <span>Исходы ({outcomes.length})</span>
        <button type="button" className="rn-mini" onClick={() => store.addOutcome(n.id)}>+ Исход</button>
      </div>
      {overrideVid && (
        <div className="rn-insp-hint warn">Условия исходов считаются по переменной «{store.charById(overrideVid)?.name || varById(store.doc, overrideVid)?.name || '…'}» — вход переменной перебивает индивидуальные.</div>
      )}
      <div className="rn-replies-edit">
        {outcomes.map((o, i) => {
          const cond = o.cond;
          return (
            <div className="rn-out-edit" key={o.id}>
              <div className="rn-out-line">
                <button type="button" title="Выше" onClick={() => store.moveOutcome(n.id, o.id, -1)}>↑</button>
                <input
                  value={o.label}
                  placeholder={'Исход ' + (i + 1)}
                  aria-label={'Подпись исхода ' + (i + 1)}
                  onFocus={() => { editPreRef.current = store.beginEdit(); }}
                  onChange={(e) => {
                    const arr = (n.outcomes || []).map((x) => x.id === o.id ? { ...x, label: e.target.value } : x);
                    store.updateNode(n.id, { outcomes: arr }, { history: false });
                  }}
                  onBlur={() => { store.commitEdit(editPreRef.current, 'Подпись исхода'); editPreRef.current = null; }}
                />
                <button type="button" title="Удалить исход" onClick={() => store.deleteOutcome(n.id, o.id)}>×</button>
              </div>
              <CondRow
                store={store}
                cond={cond}
                onChange={(c) => {
                  const cc = c as { vid: string; op: string; val: number | string } | null;
                  const arr = (n.outcomes || []).map((x) => x.id === o.id ? { ...x, cond: cc } : x);
                  store.updateNode(n.id, { outcomes: arr as typeof n.outcomes }, { label: cc ? 'Условие исхода' : 'Сброс условия исхода' });
                }}
                editPreRef={editPreRef}
              />
            </div>
          );
        })}
        {!outcomes.length && <div className="rn-insp-hint">Исходов нет — потяните связь от главного пина или добавьте исход.</div>}
      </div>
    </div>
  );
}

/* ── кнопки действия ── */
function ActionsEditor({ store, n, editPreRef }: { store: VetviStore; n: VetviNode; editPreRef: React.MutableRefObject<string | null> }) {
  const actions = Array.isArray(n.actions) ? (n.actions as { id: string; label?: string }[]) : [];
  return (
    <div className="rn-field">
      <div className="rn-row-head">
        <span>Кнопки ({actions.length})</span>
        <button type="button" className="rn-mini" onClick={() => store.addAction(n.id)}>+ Кнопка</button>
      </div>
      <div className="rn-replies-edit">
        {actions.map((a, i) => (
          <div className="rn-out-line" key={a.id}>
            <input
              value={a.label || ''}
              placeholder={'Кнопка ' + (i + 1)}
              aria-label={'Кнопка ' + (i + 1)}
              onFocus={() => { editPreRef.current = store.beginEdit(); }}
              onChange={(e) => {
                const arr = actions.map((x) => x.id === a.id ? { ...x, label: e.target.value } : x);
                store.updateNode(n.id, { actions: arr }, { history: false });
              }}
              onBlur={() => { store.commitEdit(editPreRef.current, 'Кнопка действия'); editPreRef.current = null; }}
            />
            <button type="button" title="Удалить кнопку" onClick={() => store.deleteAction(n.id, a.id)}>×</button>
          </div>
        ))}
        {!actions.length && <div className="rn-insp-hint">Кнопок нет — добавьте и потяните от пина кнопки связь.</div>}
      </div>
    </div>
  );
}

/* ── нода переменной ── */
function VarNodeEditor({ store, n, editPreRef }: { store: VetviStore; n: VetviNode; editPreRef: React.MutableRefObject<string | null> }) {
  const vars = store.doc.vars || [];
  const v = varById(store.doc, n.vid);
  const mode = n.varMode === 'get' ? 'get' : 'set';
  const t = v ? varType(v) : 'num';
  return (
    <>
      <div className="rn-field">
        <span>Переменная</span>
        {vars.length === 0 ? (
          <div className="rn-insp-hint">Нет переменных — создайте их на вкладке «Переменные» слева.</div>
        ) : (
          <select
            value={n.vid || ''}
            aria-label="Привязка переменной"
            onChange={(e) => store.updateNode(n.id, { vid: e.target.value || null }, { label: 'Привязка переменной' })}
          >
            <option value="">— не выбрана —</option>
            {vars.map((vv) => <option key={vv.id} value={vv.id}>{vv.name}</option>)}
          </select>
        )}
      </div>
      {v && (
        <>
          <div className="rn-field">
            <span>Режим</span>
            <div className="rn-seg">
              <button type="button" className={mode === 'get' ? 'on' : ''} onClick={() => store.updateNode(n.id, { varMode: 'get' }, { label: 'Режим переменной' })}>Чтение (get)</button>
              <button type="button" className={mode === 'set' ? 'on' : ''} onClick={() => store.updateNode(n.id, { varMode: 'set' }, { label: 'Режим переменной' })}>Изменение (set)</button>
            </div>
          </div>
          {mode === 'set' && (
            <div className="rn-field">
              <span>Операция и значение</span>
              <div className="rn-var-op-row">
                <select
                  value={String(n.varOp ?? '=')}
                  aria-label="Операция"
                  onChange={(e) => store.updateNode(n.id, { varOp: e.target.value }, { label: 'Операция переменной' })}
                >
                  {Object.entries(opsForType(t)).map(([k, sym]) => <option key={k} value={k}>{sym}</option>)}
                </select>
                {t === 'bool' ? (
                  <select
                    value={n.varVal === true || n.varVal === 'true' ? 'true' : 'false'}
                    aria-label="Значение"
                    onChange={(e) => store.updateNode(n.id, { varVal: e.target.value === 'true' }, { label: 'Значение переменной' })}
                  >
                    <option value="true">true</option>
                    <option value="false">false</option>
                  </select>
                ) : (
                  <input
                    value={String(n.varVal ?? '')}
                    placeholder={t === 'num' ? 'На сколько изменить' : 'Новое значение'}
                    aria-label="Значение"
                    onFocus={() => { editPreRef.current = store.beginEdit(); }}
                    onChange={(e) => store.updateNode(n.id, { varVal: e.target.value }, { history: false })}
                    onBlur={() => { store.commitEdit(editPreRef.current, 'Значение переменной'); editPreRef.current = null; }}
                  />
                )}
              </div>
            </div>
          )}
          <div className="rn-insp-hint">
            {mode === 'get'
              ? 'Режим «чтение»: в проигрывателе показывает значение; связь с пином «вход переменной» развилки перебивает условия её исходов.'
              : 'Текущее: ' + v.name + ' ' + String(n.varOp ?? '=') + ' ' + varValText(n.varVal, v) + '. В проигрывателе значение меняется при проходе через ноду.'}
          </div>
        </>
      )}
    </>
  );
}

/* ── связь ── */
function EdgeInspector({ store, eid, onClose, editPreRef }: { store: VetviStore; eid: string; onClose: () => void; editPreRef: React.MutableRefObject<string | null> }) {
  const e = store.edgeById(eid);
  if (!e) {
    return <aside className="rn-inspector empty" aria-label="Инспектор"><div className="rn-insp-hint">Связь не найдена.</div></aside>;
  }
  const from = store.nodeById(e.from);
  const to = store.nodeById(e.to);
  const cond = (e as unknown as { cond?: Cond }).cond;
  const fromOutName = e.fromOut && from ? (
    from.type === 'branch' ? (from.outcomes || []).find((o) => o.id === e.fromOut)?.label : (from.actions || []).find((a) => (a as { id: string }).id === e.fromOut) && (from.actions as { id: string; label?: string }[]).find((a) => (a as { id: string }).id === e.fromOut)!.label
  ) : null;
  const fromReplyText = e.fromReply && from && from.dialog ? (findReplyText(from.dialog.replies, e.fromReply) || '') : null;
  return (
    <aside className="rn-inspector" aria-label="Инспектор: связь">
      <div className="rn-insp-head">
        <span className="rn-insp-type">Связь</span>
        <button type="button" className="rn-insp-x" title="Снять выделение" onClick={onClose}>×</button>
      </div>
      <div className="rn-insp-hint">
        {from?.title || '…'}{fromOutName ? ' · исход «' + fromOutName + '»' : fromReplyText ? ' · из реплики «' + fromReplyText.slice(0, 24) + '…»' : ''} → {to?.title || '…'}
        {e.tin === 'var' && ' · вход переменной развилки'}
      </div>
      <label className="rn-field">
        <span>Подпись</span>
        <input
          value={e.label || ''}
          onFocus={() => { editPreRef.current = store.beginEdit(); }}
          onChange={(ev) => store.setEdgeLabel(eid, ev.target.value, { history: false })}
          onBlur={() => { store.commitEdit(editPreRef.current, 'Подпись связи'); editPreRef.current = null; }}
          aria-label="Подпись связи"
        />
      </label>
      <div className="rn-field">
        <span>Тип линии</span>
        <div className="rn-seg">
          {[['flow', 'Обычная'], ['choice', 'Выбор'], ['cond', 'Условие'], ['bridge', 'Мост']].map(([k, lbl]) => (
            <button key={k} type="button" className={(e.kind || 'flow') === k ? 'on' : ''} onClick={() => store.setEdgeKind(eid, k)}>{lbl}</button>
          ))}
        </div>
      </div>
      {from?.type === 'branch' && (
        <div className="rn-field">
          <span>Условие перехода (развилка)</span>
          <CondRow
            store={store}
            cond={cond}
            onChange={(c) => store.setEdgeCond(eid, c as { vid: string; op: string; val: number | string } | null)}
            editPreRef={editPreRef}
          />
        </div>
      )}
      <div className="rn-btn-row">
        <button type="button" className="rn-mini" onClick={() => store.reverseEdge(eid)}>Развернуть направление</button>
        {!!(e.pts && e.pts.length) && <button type="button" className="rn-mini" onClick={() => store.resetEdgePts(eid)}>Сбросить изгибы ({e.pts!.length})</button>}
      </div>
      <div className="rn-insp-hint">Двойной клик по линии — добавить изгиб; двойной по точке — убрать; мост правится перетаскиванием его отрезков.</div>
      <div className="rn-insp-foot">
        <button type="button" className="rn-danger" onClick={() => store.deleteEdge(eid)}>Удалить связь</button>
      </div>
    </aside>
  );
}

function findReplyText(replies: { id: string; text?: string; children?: { id: string; text?: string }[] }[], rid: string): string | null {
  for (const r of replies) {
    if (r.id === rid) return r.text || '';
    if (r.children) {
      const f = findReplyText(r.children as typeof replies, rid);
      if (f !== null) return f;
    }
  }
  return null;
}

/* ── группа ── */
function GroupInspector({ store, gid, onClose, editPreRef }: { store: VetviStore; gid: string; onClose: () => void; editPreRef: React.MutableRefObject<string | null> }) {
  const g = store.groupById(gid);
  if (!g) return null;
  const fold = g.fold === undefined ? 2 : g.fold;
  const members = store.membersOf(gid);
  const parents = store.doc.groups.filter((x) => x.id !== gid && !isDescendantOf(store, gid, x.id));
  return (
    <aside className="rn-inspector" aria-label="Инспектор: группа">
      <div className="rn-insp-head">
        <span className="rn-insp-type" style={{ color: g.color || '#8b929c' }}>Группа</span>
        <button type="button" className="rn-insp-x" title="Снять выделение" onClick={onClose}>×</button>
      </div>
      <label className="rn-field">
        <span>Название</span>
        <input
          value={g.name || ''}
          onFocus={() => { editPreRef.current = store.beginEdit(); }}
          onChange={(e) => store.updateGroup(gid, { name: e.target.value }, { history: false })}
          onBlur={() => { store.commitEdit(editPreRef.current, 'Название группы'); editPreRef.current = null; }}
          aria-label="Название группы"
        />
      </label>
      <div className="rn-field">
        <span>Вид</span>
        <div className="rn-seg">
          {[2, 1, 0].map((f) => (
            <button key={f} type="button" className={fold === f ? 'on' : ''} onClick={() => store.updateGroup(gid, { fold: f }, { label: 'Вид группы' })}>
              {f === 2 ? 'рамка' : f === 1 ? 'список' : 'компакт'}
            </button>
          ))}
        </div>
      </div>
      <div className="rn-field">
        <span>Родительская группа</span>
        <select
          value={g.parent || ''}
          onChange={(e) => store.updateGroup(gid, { parent: e.target.value || null }, { label: 'Вложенность группы' })}
          aria-label="Родительская группа"
        >
          <option value="">— нет —</option>
          {parents.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </div>
      <div className="rn-field">
        <span>Цвет</span>
        <div className="rn-palette sm">
          {PALETTE_COLORS.map((c) => (
            <button key={c} type="button" className={'rn-swatch' + ((g.color || '') === c ? ' on' : '')} style={{ background: c }} title={c} aria-label={'Цвет ' + c} onClick={() => store.updateGroup(gid, { color: c }, { label: 'Цвет группы' })} />
          ))}
          <input type="color" className="rn-picker" title="Свой цвет" value={/^#[0-9a-fA-F]{6}$/.test(g.color || '') ? (g.color as string) : '#8b929c'} onChange={(e) => store.updateGroup(gid, { color: e.target.value }, { label: 'Цвет группы' })} aria-label="Свой цвет группы" />
        </div>
      </div>
      <div className="rn-field">
        <span>Прозрачность {Math.round((typeof g.alpha === 'number' ? g.alpha : 0.55) * 100)}%</span>
        <input
          type="range"
          min={10}
          max={100}
          value={Math.round((typeof g.alpha === 'number' ? g.alpha : 0.55) * 100)}
          onChange={(e) => store.updateGroup(gid, { alpha: Number(e.target.value) / 100 }, { history: false })}
          onMouseUp={() => { store.commitEdit(editPreRef.current, 'Прозрачность группы'); editPreRef.current = store.beginEdit(); }}
          aria-label="Прозрачность группы"
        />
      </div>
      <div className="rn-field">
        <span>Состав ({members.length})</span>
        <div className="rn-group-members">
          {members.map((m) => (
            <button key={m.id} type="button" className="rn-gmember" onClick={() => { store.selectOnly(m.id); store.requestCenter(m.id); }}>
              <span className="rn-gcdot" style={{ background: m.color || TYPES[m.type]?.color }} />
              {m.title || TYPES[m.type]?.name}
            </button>
          ))}
          {!members.length && <div className="rn-insp-hint">Пусто — перенесите ноды внутрь рамки.</div>}
        </div>
      </div>
      <div className="rn-btn-row">
        <button type="button" className="rn-mini" onClick={() => store.setSel(members.map((m) => m.id))}>Выделить все ноды</button>
        <button type="button" className="rn-mini" onClick={() => { store.setLogFilters(null, gid); store.openModal('log'); }}>Журнал группы</button>
      </div>
      <div className="rn-insp-foot">
        <button type="button" className="rn-danger" onClick={() => store.dissolveGroup(gid)}>Распустить группу</button>
      </div>
    </aside>
  );
}

function isDescendantOf(store: VetviStore, ancestorId: string, ofId: string): boolean {
  let cur: string | null | undefined = ofId;
  const seen = new Set<string>();
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    if (cur === ancestorId) return true;
    cur = store.groupById(cur)?.parent;
  }
  return false;
}

/* ── строка условия по переменной ── */
function CondRow({ store, cond, onChange, editPreRef }: {
  store: VetviStore;
  cond: Cond | null | undefined;
  onChange: (c: Cond | null) => void;
  editPreRef: React.MutableRefObject<string | null>;
}) {
  const vars = store.doc.vars || [];
  const on = !!cond;
  const v = cond ? varById(store.doc, cond.vid) : null;
  const t = v ? varType(v) : 'num';
  return (
    <div className="rn-cond">
      <div className="rn-seg sm">
        <button type="button" className={!on ? 'on' : ''} onClick={() => onChange(null)}>Без условия</button>
        <button type="button" className={on ? 'on' : ''} disabled={!vars.length} onClick={() => {
          const v0 = vars[0];
          onChange(v0 ? { vid: v0.id, op: '==', val: varType(v0) === 'bool' ? true : 0 } : null);
        }}>По переменной</button>
      </div>
      {on && cond && (
        <div className="rn-cond-row">
          <select
            value={cond.vid}
            aria-label="Переменная условия"
            onChange={(e) => onChange({ vid: e.target.value, op: '==', val: varType(varById(store.doc, e.target.value)) === 'bool' ? true : 0 })}
          >
            {vars.map((vv) => <option key={vv.id} value={vv.id}>{vv.name}</option>)}
          </select>
          <select
            value={cond.op}
            aria-label="Оператор"
            onChange={(e) => onChange({ ...cond, op: e.target.value })}
          >
            {Object.entries(condOpsFor(t)).map(([k, sym]) => <option key={k} value={k}>{sym}</option>)}
          </select>
          {t === 'bool' ? (
            <select
              value={cond.val === true || cond.val === 'true' ? 'true' : 'false'}
              aria-label="Значение условия"
              onChange={(e) => onChange({ ...cond, val: e.target.value === 'true' })}
            >
              <option value="true">true</option>
              <option value="false">false</option>
            </select>
          ) : (
            <input
              value={String(cond.val ?? '')}
              aria-label="Значение условия"
              onFocus={() => { editPreRef.current = store.beginEdit(); }}
              onChange={(e) => onChange({ ...cond, val: e.target.value })}
              onBlur={() => { store.commitEdit(editPreRef.current, 'Значение условия'); editPreRef.current = null; }}
            />
          )}
          <span className="rn-cond-hint">{condText(store.doc, cond)}</span>
        </div>
      )}
      {on && !vars.length && <div className="rn-insp-hint warn">Нет переменных — создайте их на вкладке «Переменные».</div>}
    </div>
  );
}
