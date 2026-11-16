'use client';

/**
 * Ветви — левая панель: 1:1 порт aside#left классической версии.
 * Вкладки .ltabs/.ltab/.lt-ic, палитра .pal-item/.pal-sep/.pal-group/.cv-card,
 * обзор .search/.nli (.grp/.ov-f/.garr/.dot/.t/.k/.list-empty),
 * переменные .v-item/.v-row/.v-grip/.v-name/.v-type/.v-val/.v-del/.v-fold/.v-edit/.ve-*,
 * персонажи .c-avpick/.c-av/.c-name/.ce-avrow/.shp/.swatches/.ce-desc.
 * Классы, id и структура DOM совпадают с оригиналом — стили vetvi.css применяются как есть.
 */

import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties, DragEvent, ReactNode } from 'react';

import { NODE_W, PALETTE_COLORS, STATUS_RU, TYPES } from '@/vetvi/core/constants';
import { nodeColor, typeInfo } from '@/vetvi/core/geometry';
import { opsForType, VAR_TYPES, varCastVal, varType, isTrueVal } from '@/vetvi/core/vars';
import type { VetviChar, VetviCharGroup, VetviDoc, VetviGroup, VetviNode, VetviVar } from '@/vetvi/core/types';
import { condOpsFor, varById } from '@/vetvi/core/vars';
import type { VetviStore } from './store';
import { TypeIcon } from './NodeCard';
import { CropModal, type CropReq } from './CropModal';

/* ── иконки (копия ALLICONS оригинала) ── */
const P_FOLDER = '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>';
const P_LIST = '<path d="M8 6h12M8 12h12M8 18h12"/><circle cx="3.7" cy="6" r="1.1"/><circle cx="3.7" cy="12" r="1.1"/><circle cx="3.7" cy="18" r="1.1"/>';
const P_VAR = '<path d="M5 8c2.6-5 5.4 5 8 0 1.4-2.6 3.4-3 6-1.5"/><path d="M5 12.5h14"/><path d="M5 17c2.6 5 5.4-5 8 0 1.4 2.6 3.4 3 6 1.5"/>';
const P_CHAR = '<circle cx="12" cy="8.2" r="3.6"/><path d="M4.8 20c1.1-3.4 3.9-5.2 7.2-5.2s6.1 1.8 7.2 5.2"/>';
const P_CHEV = '<path d="m6 9 6 6 6-6"/>';
const P_X = '<path d="M6 6l12 12M18 6 6 18"/>';
const P_GRIP = '<path d="M9 5.5h.01M9 12h.01M9 18.5h.01M15 5.5h.01M15 12h.01M15 18.5h.01"/>';
const P_EYE = '<path d="M2.5 12S6 5.8 12 5.8 21.5 12 21.5 12 18 18.2 12 18.2 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/>';
const P_EYE_OFF = '<path d="M2.5 12S6 5.8 12 5.8c1.2 0 2.3.3 3.3.7M21.5 12S18 18.2 12 18.2c-1.2 0-2.3-.3-3.3-.7"/><path d="M4 4l16 16"/>';
const P_PENCIL = '<path d="m4 20 1-4L16.3 4.7a2.1 2.1 0 0 1 3 3L8 19z"/><path d="M14.5 6.5l3 3"/>';
const P_PIN = '<path d="M9 3.5h6l-1 5 3 3.2V14h-4.2l-.3 6.5L12 17l-.5 3.5L11.2 14H7v-2.3l3-3.2z"/>';
const P_USER_PLUS = '<circle cx="10" cy="8" r="3.4"/><path d="M3.5 19.5c1-3.2 3.6-4.9 6.5-4.9 1.6 0 3.1.5 4.3 1.4"/><path d="M17 13v6M14 16h6"/>';
const P_FOLDER_PLUS = '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M12 10.5v5M9.5 13h5"/>';

/** ic(name,size) оригинала — svg-обёртка над путём иконки. */
function Ic(props: { d: string; size?: number }) {
  const size = props.size || 15;
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <g dangerouslySetInnerHTML={{ __html: props.d }} />
    </svg>
  );
}

/** Строка «или ссылка на картинку …» + кнопка ОК (ce-avurl оригинала, 5686–5689):
 * проверка картинки пробным Image с referrerPolicy=no-referrer (applyUrl, 5788–5806).
 * Поле — неконтролируемое: при смене аватара извне родитель перемонтирует его через key. */
function AvatarLinkRow(props: { c: VetviChar; store: VetviStore }) {
  const { c, store } = props;
  const inpRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const applyUrl = (): void => {
    const u = (inpRef.current?.value || '').trim();
    if (!u) return;
    if (!/^https?:\/\/\S+$/i.test(u)) {
      store.toast('Ссылка должна начинаться с http:// или https://', 'warn');
      return;
    }
    setBusy(true);
    const probe = new Image();
    probe.onload = () => {
      setBusy(false);
      store.updateChar(c.id, { av: u, ...(c.avShape !== 'square' ? { avShape: 'circle' } : null) }, { label: 'Аватар персонажа' });
      store.toast('Аватар по ссылке установлен');
    };
    probe.onerror = () => {
      setBusy(false);
      store.toast('По этой ссылке картинка не открылась', 'err');
    };
    probe.referrerPolicy = 'no-referrer';
    probe.src = u;
  };
  return (
    <div className="ce-avurl">
      <input
        ref={inpRef}
        className="inp ce-av-link"
        placeholder="или ссылка на картинку с другого ресурса (https://…)"
        defaultValue={c.av && !/^data:/i.test(String(c.av)) ? String(c.av) : ''}
        maxLength={2000}
        spellCheck={false}
        title="Ссылка на картинку — аватар загрузится прямо по ней"
        aria-label="Ссылка на картинку для аватара"
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); applyUrl(); } }}
      />
      <button type="button" className="ce-av-apply" title="Проверить ссылку и поставить аватар" disabled={busy} onClick={applyUrl}>ОК</button>
    </div>
  );
}

export function LeftPane(props: { store: VetviStore }) {
  const { store } = props;
  const tab = store.leftTab;
  void store.revision;

  const tabs = [['pal', 'Элементы'], ['list', 'Обзор'], ['vars', 'Переменные'], ['chars', 'Персонажи']] as const;

  /* кадрирование аватара: {src, onDone, onCancel} | null — модалка #cropWrap оригинала */
  const [crop, setCrop] = useState<CropReq | null>(null);
  const closeCrop = useCallback(() => setCrop(null), []);

  /* открытие кадрирования для ОБОИХ загрузок аватара (c-av-pick и ce-av-file):
     файл → FileReader → dataURL → CropModal; по «Применить» — сжатие и сохранение
     (charApplyFile → fileToAvatar(useCrop) → openAvatarCrop(dataUrl, cb) оригинала) */
  const onFile = (cid: string, file: File | null) => {
    if (!file || !/^image\//.test(file.type || '')) {
      store.toast('Нужен файл изображения', 'warn');
      return;
    }
    const fr = new FileReader();
    fr.onload = () => {
      setCrop({
        src: String(fr.result),
        onDone: (dataUrl) => {
          imageFromUrl(
            dataUrl,
            (img) => {
              compressAvatar(img, (out) => {
                /* проверка avCompressCrop оригинала: data:image/ и ≤60К символов,
                   иначе тост и модалка остаётся открытой (cb не вызывается) */
                if (!out || !/^data:image\//.test(out) || out.length > 60000) {
                  store.toast('Картинка слишком велика для аватара', 'warn');
                  return;
                }
                setCrop(null); /* closeAvatarCrop перед сохранением — как в cropApply оригинала */
                store.updateChar(cid, { av: out }, { label: 'Аватар персонажа' });
                store.toast('Аватар обновлён', 'ok');
              });
            },
            () => store.toast('Не удалось прочитать изображение', 'warn'),
          );
        },
        onCancel: () => { /* Отмена — ничего не сохранять */ },
      });
    };
    fr.onerror = () => {
      store.toast('Не удалось прочитать файл', 'warn');
    };
    fr.readAsDataURL(file);
  };

  /* перекадрирование уже установленного аватара (ce-av-crop оригинала, 5813):
     текущий аватар → CropModal → сохранение кадра с тостом «Аватар перекадрирован» */
  const onRecrop = (cid: string) => {
    const c = store.charById(cid);
    if (!c || !c.av) {
      store.toast('Аватар ещё не задан', 'warn');
      return;
    }
    setCrop({
      src: String(c.av),
      onDone: (dataUrl) => {
        imageFromUrl(
          dataUrl,
          (img) => {
            compressAvatar(img, (out) => {
              if (!out || !/^data:image\//.test(out) || out.length > 60000) {
                store.toast('Картинка слишком велика для аватара', 'warn');
                return;
              }
              setCrop(null);
              store.updateChar(cid, { av: out }, { label: 'Аватар персонажа' });
              store.toast('Аватар перекадрирован', 'ok');
            });
          },
          () => store.toast('Не удалось прочитать изображение', 'warn'),
        );
      },
      onCancel: () => { /* Отмена — ничего не сохранять */ },
    });
  };

  return (
    <aside id="left" style={{ width: store.leftWidth }} aria-label="Панель проекта">
      <nav className="ltabs" role="tablist">
        {tabs.map(([t, title]) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            data-t={t}
            title={title}
            className={'ltab' + (tab === t ? ' active' : '')}
            onClick={() => store.setLeftTab(t)}
          >
            <span className="lt-ic">
              <Ic d={t === 'pal' ? P_FOLDER : t === 'list' ? P_LIST : t === 'vars' ? P_VAR : P_CHAR} size={16} />
            </span>
          </button>
        ))}
      </nav>
      <PalettePane store={store} active={tab === 'pal'} onEditType={(id) => store.openModal('typeEditor', id)} onNewType={() => store.openModal('typeEditor', null)} />
      <ListPane store={store} active={tab === 'list'} />
      <VarsPane store={store} active={tab === 'vars'} />
      <CharsPane store={store} active={tab === 'chars'} onFile={onFile} onRecrop={onRecrop} />
      {crop && <CropModal store={store} req={crop} onClose={closeCrop} />}
    </aside>
  );
}

/* ── свой тип из документа (customTypes оригинала; отображение без редактора) ── */
interface CustomTypeRec { id: string; name: string; color: string; icon: string }

function customTypesOf(doc: VetviDoc): CustomTypeRec[] {
  const arr: unknown[] = Array.isArray(doc.customTypes) ? (doc.customTypes as unknown[]) : [];
  const out: CustomTypeRec[] = [];
  for (const raw of arr) {
    if (!raw || typeof raw !== 'object') continue;
    const c = raw as Record<string, unknown>;
    if (typeof c.id !== 'string' || !c.id) continue;
    out.push({
      id: c.id,
      name: typeof c.name === 'string' && c.name ? c.name : 'Свой тип',
      color: typeof c.color === 'string' && c.color ? c.color : '#8b929c',
      icon: typeof c.icon === 'string' && c.icon ? c.icon : 'star',
    });
  }
  return out;
}

function typeInfoEx(doc: VetviDoc, key: string): { name: string; color: string; icon: string } {
  if (TYPES[key]) {
    const icons: Record<string, string> = {
      scene: 'scene', quest: 'quest', dialog: 'dialog', skill: 'skill', action: 'action',
      branch: 'branch', varnode: 'variable', event: 'event', note: 'note',
    };
    return { name: TYPES[key].name, color: TYPES[key].color, icon: icons[key] || 'star' };
  }
  const c = customTypesOf(doc).find((x) => x.id === key);
  return c ? { name: c.name, color: c.color, icon: c.icon } : { name: 'Заметка', color: '#8b929c', icon: 'note' };
}

/** listHidden(key) оригинала: в классике — массив, в ядре — record. */
function listHiddenAt(doc: VetviDoc, key: string): boolean {
  const lh = doc.listHidden;
  if (Array.isArray(lh)) return ((lh as unknown[]).indexOf(key) >= 0);
  if (lh && typeof lh === 'object') return Boolean((lh as Record<string, unknown>)[key]);
  return false;
}

function gColorOf(g: VetviGroup): string {
  return typeof g.color === 'string' && g.color ? g.color : '#9aa1ac';
}

/** allDescNodes(gid) оригинала: ноды группы + всех вложенных групп. */
function allDescNodes(store: VetviStore, gid: string, visited?: Set<string>): VetviNode[] {
  const seen = visited || new Set<string>();
  if (seen.has(gid)) return [];
  seen.add(gid);
  const out: VetviNode[] = [];
  for (const n of store.doc.nodes) if (n.gid === gid) out.push(n);
  for (const cg of store.doc.groups) if (cg.parent === gid) out.push(...allDescNodes(store, cg.id, seen));
  return out;
}

/* ── Элементы (палитра с перетаскиванием; eye/pencil/x — ориг. 4298–4307, 4355–4363) ── */
function PalettePane({ store, active, onEditType, onNewType }: {
  store: VetviStore;
  active: boolean;
  onEditType: (id: string) => void;
  onNewType: () => void;
}) {
  const [palFold, setPalFold] = useState<Record<string, boolean>>({});

  const drop = (e: React.DragEvent) => {
    e.preventDefault();
    const type = e.dataTransfer.getData('text/vetvi-type');
    if (!type) return;
    const el = document.querySelector('.rn-canvas');
    const r = el ? el.getBoundingClientRect() : { left: 0, top: 0, width: 800, height: 600 };
    const w = {
      x: (e.clientX - r.left - store.vp.x) / store.vp.z - NODE_W / 2,
      y: (e.clientY - r.top - store.vp.y) / store.vp.z - 20,
    };
    store.addNodeAt(type, w.x, w.y);
  };

  const isHidden = (key: string) => listHiddenAt(store.doc, key);
  const typeKeys = Object.keys(TYPES).concat(customTypesOf(store.doc).map((c) => c.id));
  const canvasGroups = typeKeys
    .filter((key) => !isHidden(key))
    .map((key) => ({ key, list: store.doc.nodes.filter((n) => n.type === key) }))
    .filter((g) => g.list.length > 0);

  return (
    <div className={'tabpane' + (active ? ' active' : '')} id="panePal" onDragOver={(e) => e.preventDefault()} onDrop={drop}>
      <div className="v-head" style={{ margin: '2px 10px 8px' }}>
        <span>Элементы</span>
        <button type="button" className="btn primary" id="bAddType" title="Создать свой тип элемента" onClick={onNewType}>
          + Свой тип
        </button>
      </div>
      <div id="palList">
        {typeKeys.map((key) => {
          const info = typeInfoEx(store.doc, key);
          const isCustom = !TYPES[key];
          const off = isHidden(key);
          const cnt = store.doc.nodes.filter((n) => n.type === key).length;
          return (
            <div
              key={key}
              className={'pal-item' + (isCustom ? ' custom' : '') + (off ? ' dim' : '')}
              draggable
              data-type={key}
              style={{ '--c': info.color } as CSSProperties}
              title={(isCustom ? 'Свой тип · ' : '') + info.name}
              onDragStart={(e) => {
                e.dataTransfer.setData('text/vetvi-type', key);
                e.dataTransfer.effectAllowed = 'copy';
              }}
              onClick={() => {
                const el = document.querySelector('.rn-canvas');
                const r = el ? el.getBoundingClientRect() : { width: 800, height: 600 };
                const wx = (r.width / 2 - store.vp.x) / store.vp.z - NODE_W / 2;
                const wy = (r.height / 2 - store.vp.y) / store.vp.z - 40;
                store.addNodeAt(key, wx, wy);
              }}
            >
              <span className="pal-ico"><TypeIcon type={key} size={16} icon={isCustom ? info.icon : null} /></span>
              <span className="pal-name">{info.name}</span>
              <span className="pal-cnt">{cnt}</span>
              <button
                type="button"
                className={'mini-btn eye' + (off ? ' off' : '')}
                data-eye={key}
                title={off ? 'Вернуть тип в раздел «На холсте»' : 'Убрать тип из раздела «На холсте»'}
                onClick={(e) => { e.stopPropagation(); store.toggleListVis(key); }}
              >
                <Ic d={off ? P_EYE_OFF : P_EYE} size={13} />
              </button>
              {isCustom && (
                <span className="item-acts">
                  <button type="button" className="mini-btn" data-edit={key} title="Редактировать" onClick={(e) => { e.stopPropagation(); onEditType(key); }}>
                    <Ic d={P_PENCIL} size={12} />
                  </button>
                  <button type="button" className="mini-btn del" data-del={key} title="Удалить тип" onClick={(e) => { e.stopPropagation(); store.deleteCustomType(key); }}>
                    <Ic d={P_X} size={12} />
                  </button>
                </span>
              )}
            </div>
          );
        })}
        <div className="pal-sep">на холсте</div>
        {!store.doc.nodes.length && (
          <div className="pal-hint" style={{ textAlign: 'center' }}>Холст пуст — перетащите что-нибудь сверху.</div>
        )}
        {!!store.doc.nodes.length && !canvasGroups.length && (
          <div className="pal-hint" style={{ textAlign: 'center' }}>Все типы убраны глазиками выше.</div>
        )}
        {canvasGroups.map(({ key, list }) => {
          const info = typeInfoEx(store.doc, key);
          const isCustom = !TYPES[key];
          const fk = 'cv:' + key;
          const folded = !!palFold[fk];
          return (
            <Fragment key={fk}>
              <div
                className={'pal-group foldable' + (folded ? ' folded' : '')}
                title={folded ? 'Развернуть' : 'Свернуть'}
                onClick={() => setPalFold({ ...palFold, [fk]: !folded })}
              >
                <span className="pg-chev"><Ic d={P_CHEV} size={10} /></span>
                <span className="dot" style={{ background: info.color }} />
                {info.name}{isCustom ? ' ·' : null}
                <span className="pg-cnt">{list.length}</span>
              </div>
              {!folded && list.map((n) => {
                const desc = n.type === 'dialog'
                  ? (n.dialog && n.dialog.description ? n.dialog.description : 'диалог')
                  : (n.text || 'без описания');
                return (
                  <div
                    key={n.id}
                    className="pal-item cv-card"
                    draggable
                    data-node={n.id}
                    style={{ '--c': nodeColor(n, store.doc.customTypes) } as CSSProperties}
                    title="Клик — перейти · перетащите, чтобы создать копию"
                    onDragStart={(e) => {
                      e.dataTransfer.setData('text/vetvi-clone', n.id);
                      e.dataTransfer.effectAllowed = 'copy';
                    }}
                    onClick={() => { store.selectOnly(n.id); store.requestCenter(n.id); }}
                  >
                    <span className="pal-ico"><TypeIcon type={n.type} size={16} /></span>
                    <span className="cv-info">
                      <span className="pal-name">{n.title}</span>
                      <span className="cv-desc">{desc}</span>
                    </span>
                    <span className={'n-st st-' + (STATUS_RU[n.status] ? n.status : 'idea')} title={STATUS_RU[n.status] || ''} />
                  </div>
                );
              })}
            </Fragment>
          );
        })}
      </div>
    </div>
  );
}

/* ── Обзор (список нод и групп) ── */
function ListPane({ store, active }: { store: VetviStore; active: boolean }) {
  const [q, setQ] = useState('');
  const [ovFold, setOvFold] = useState<Record<string, boolean>>({});
  const query = q.toLowerCase();

  const nodeMatches = (n: VetviNode) => {
    if (!q.trim()) return true;
    return (n.title || '').toLowerCase().includes(query) || (n.text || '').toLowerCase().includes(query);
  };

  const selectGroupCenter = (gid: string) => {
    store.selectGroupOnly(gid);
    const ms = allDescNodes(store, gid);
    if (!ms.length) return;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const n of ms) {
      if (n.x < minX) minX = n.x;
      if (n.y < minY) minY = n.y;
      if (n.x > maxX) maxX = n.x;
      if (n.y > maxY) maxY = n.y;
    }
    const el = document.querySelector('.rn-canvas');
    const r = el ? el.getBoundingClientRect() : { width: 800, height: 600 };
    store.setViewport({
      x: r.width / 2 - ((minX + maxX) / 2) * store.vp.z,
      y: r.height / 2 - ((minY + maxY) / 2) * store.vp.z,
    });
  };

  const nodeRow = (n: VetviNode, indent: number | null): ReactNode => (
    <div
      key={n.id}
      className={'nli' + (store.sel.has(n.id) ? ' sel' : '')}
      data-id={n.id}
      style={indent == null ? undefined : { paddingLeft: indent }}
      onClick={() => { store.selectOnly(n.id); store.requestCenter(n.id); }}
    >
      <span className="dot" style={{ background: nodeColor(n, store.doc.customTypes), color: nodeColor(n, store.doc.customTypes) }} />
      <span className="t">{n.title}</span>
      <span className="k">{typeInfo(n.type).name}</span>
    </div>
  );

  const groupRows = (g: VetviGroup, depth: number, out: ReactNode[]) => {
    const desc = allDescNodes(store, g.id);
    const matchSelf = !query || g.name.toLowerCase().includes(query);
    const matched = desc.filter(nodeMatches);
    if (query && !matchSelf && !matched.length) return;
    const indent = 9 + depth * 14;
    const isF = !!ovFold[g.id] && !query;
    out.push(
      <div
        key={'g:' + g.id}
        className={'nli grp' + (store.selGroups.has(g.id) ? ' sel' : '')}
        data-gid={g.id}
        style={{ paddingLeft: indent }}
        onClick={(ev) => {
          const tgt = ev.target as Element | null;
          if (tgt && tgt.closest && tgt.closest('.ov-f')) return;
          selectGroupCenter(g.id);
        }}
      >
        <button
          type="button"
          className={'ov-f' + (isF ? ' folded' : '')}
          title="Свернуть/развернуть"
          onClick={(ev) => { ev.stopPropagation(); setOvFold({ ...ovFold, [g.id]: !ovFold[g.id] }); }}
        >
          <Ic d={P_CHEV} size={10} />
        </button>
        <span className="garr"><Ic d={P_FOLDER} size={11} /></span>
        <span className="dot" style={{ background: gColorOf(g), color: gColorOf(g) }} />
        <span className="t">{g.name}</span>
        <span className="k">{desc.length}</span>
      </div>
    );
    if (isF) return;
    for (const cg of store.doc.groups) if (cg.parent === g.id) groupRows(cg, depth + 1, out);
    for (const n of store.membersOf(g.id).filter((x) => matchSelf || nodeMatches(x))) out.push(nodeRow(n, indent + 22));
  };

  const rows: ReactNode[] = [];
  for (const g of store.childGroups(null)) groupRows(g, 0, rows);
  const loose = store.doc.nodes.filter((n) => !n.gid && nodeMatches(n));
  if (store.doc.groups.length && loose.length) {
    rows.push(<div key="sep-loose" className="pal-sep" style={{ margin: '16px 4px 2px' }}>без группы</div>);
  }
  for (const n of loose) rows.push(nodeRow(n, null));
  if (!rows.length) {
    rows.push(<div key="empty" className="list-empty">{query.trim() ? 'Ничего не найдено' : 'Пока нет узлов'}</div>);
  }

  return (
    <div className={'tabpane' + (active ? ' active' : '')} id="paneList">
      <div className="search">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
        <input id="sQ" placeholder="Поиск по узлам и группам…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Фильтр нод" />
      </div>
      <div id="nodeList">{rows}</div>
    </div>
  );
}

/* ── Переменные ── */
function VarsPane({ store, active }: { store: VetviStore; active: boolean }) {
  const vars = store.doc.vars || [];
  const groups = store.varGroups();
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [dragReady, setDragReady] = useState<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [renGid, setRenGid] = useState<string | null>(null);
  const dragVid = useRef<string | null>(null);
  const editPreRef = useRef<string | null>(null);
  const renRef = useRef<HTMLInputElement | null>(null);

  const toggleOpen = (id: string) => {
    const s = new Set(open);
    if (s.has(id)) s.delete(id);
    else s.add(id);
    setOpen(s);
  };

  /* ── drag & drop: переменная → группа/позиция, группа → позиция в списке ──
     та же раздвижка-подсказка, что у персонажей: dropHint показывает, между
     какими блоками встанет перетаскиваемая строка (классы dnd-gap-…).
     Бросок на ХОЛСТ (вне панели) по-прежнему создаёт ноду переменной —
     drop обрабатывает CanvasBoard; в списках — перестановка/перенос. */
  const dtHas = (e: DragEvent, t: string) => Array.from(e.dataTransfer.types).includes(t);
  type VarDropHint =
    | { kind: 'root' }
    | { kind: 'group'; id: string }
    | { kind: 'row'; gid: string | null; refVid: string; place: 'before' | 'after' }
    | { kind: 'ghead'; id: string; place: 'before' | 'after' }
    | null;
  const [dropHint, setDropHint] = useState<VarDropHint>(null);
  const markOver = (next: VarDropHint) =>
    setDropHint((p) => {
      if (p === next) return p;
      if (p && next && p.kind === next.kind
        && (p as { id?: string }).id === (next as { id?: string }).id
        && (p as { refVid?: string }).refVid === (next as { refVid?: string }).refVid
        && (p as { place?: string }).place === (next as { place?: string }).place) return p;
      return next;
    });
  /** до или после середины строки упал курсор — туда и вставляем */
  const placeOf = (el: HTMLElement, clientY: number): 'before' | 'after' => {
    const r = el.getBoundingClientRect();
    return (clientY - r.top) > r.height / 2 ? 'after' : 'before';
  };

  const commitRenG = (g: { id: string; name: string }) => {
    const v = (renRef.current?.value || '').trim();
    if (v && v !== g.name) store.updateVarGroup(g.id, { name: v }, { label: 'Переименование группы' });
    setRenGid(null);
  };

  const nameFocus = () => { editPreRef.current = store.beginEdit(); };
  const nameBlur = () => { store.commitEdit(editPreRef.current, 'Правка переменной'); editPreRef.current = null; };
  const valFocus = () => { editPreRef.current = store.beginEdit(); };
  const valBlur = () => { store.commitEdit(editPreRef.current, 'Значение переменной'); editPreRef.current = null; };

  /** строка переменной — можно перетащить на группу или между строками (позиционная вставка);
      тянется за grip (dragReady), бросок на холст создаёт ноду (CanvasBoard) */
  const varRow = (v: VetviVar, zoneGid: string | null) => {
    const isOpen = open.has(v.id);
    const t = varType(v);
    const hint = dropHint && dropHint.kind === 'row' && dropHint.refVid === v.id ? dropHint.place : null;
    return (
      <div
        key={v.id}
        data-vid={v.id}
        className={'v-item' + (isOpen ? ' open' : '') + (draggingId === v.id ? ' dragging' : '')
          + (hint === 'before' ? ' dnd-gap-above' : hint === 'after' ? ' dnd-gap-below' : '')}
        draggable={dragReady === v.id}
        onDragStart={(e) => {
          e.dataTransfer.setData('text/vetvi-var', v.id);
          e.dataTransfer.effectAllowed = 'copyMove'; /* холст — копия (нода), списки — перенос */
          dragVid.current = v.id;
          setDraggingId(v.id);
        }}
        onDragEnd={() => { setDragReady(null); setDraggingId(null); markOver(null); }}
      >
        <div
          className="v-row"
          onDragOver={(e) => {
            if (!dtHas(e, 'text/vetvi-var')) return;
            e.preventDefault();
            e.stopPropagation();
            e.dataTransfer.dropEffect = 'move';
            markOver({ kind: 'row', gid: zoneGid, refVid: v.id, place: placeOf(e.currentTarget as HTMLElement, e.clientY) });
          }}
          onDrop={(e) => {
            const vid = e.dataTransfer.getData('text/vetvi-var');
            e.preventDefault();
            e.stopPropagation();
            if (vid && vid !== v.id) store.placeVarInList(vid, zoneGid, v.id, placeOf(e.currentTarget as HTMLElement, e.clientY));
            markOver(null);
          }}
        >
          <span
            className="v-grip"
            title="Перетащите — на холст: создать ноду переменной, в списке: сменить группу или порядок"
            onMouseDown={() => setDragReady(v.id)}
            onDoubleClick={(e) => e.preventDefault()}
          ><Ic d={P_GRIP} size={12} /></span>
          <input
            className="inp v-name"
            maxLength={40}
            value={String(v.name || '')}
            title="Название переменной"
            placeholder="название"
            aria-label="Имя переменной"
            onFocus={nameFocus}
            onChange={(e) => store.updateVar(v.id, { name: e.target.value }, { history: false })}
            onBlur={nameBlur}
          />
          <select
            className="inp v-type"
            value={t}
            title="Тип переменной"
            aria-label="Тип переменной"
            onChange={(e) => store.updateVar(v.id, { type: e.target.value, val: varCastVal(e.target.value, v.val) }, { label: 'Тип переменной' })}
          >
            {Object.entries(VAR_TYPES).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
          </select>
          {t === 'bool' ? (
            <select
              className="inp v-val"
              title="Начальное значение"
              aria-label="Значение"
              value={isTrueVal(v.val) ? '1' : '0'}
              onChange={(e) => store.updateVar(v.id, { val: e.target.value === '1' }, { label: 'Значение переменной' })}
            >
              <option value="1">true</option>
              <option value="0">false</option>
            </select>
          ) : (
            <input
              className="inp v-val"
              value={String(v.val ?? '')}
              title="Начальное значение"
              placeholder={t === 'num' ? '0' : 'текст'}
              aria-label="Значение по умолчанию"
              onFocus={valFocus}
              onChange={(e) => store.updateVar(v.id, { val: e.target.value }, { history: false })}
              onBlur={valBlur}
            />
          )}
          <button
            type="button"
            className={'v-pin' + (v.pinned ? ' on' : '')}
            title={v.pinned ? 'Открепить — переменная показывается в проигрывании только в задействованных цепочках' : 'Закрепить — переменная всегда выводится в проигрывании, даже если не задействована в цепочке'}
            aria-label={v.pinned ? 'Открепить переменную' : 'Закрепить переменную'}
            onClick={() => store.updateVar(v.id, { pinned: !v.pinned }, { label: v.pinned ? 'Открепление переменной' : 'Закрепление переменной' })}
          ><Ic d={P_PIN} size={12} /></button>
          <button type="button" className="v-del" title="Удалить переменную" onClick={() => store.deleteVar(v.id)}><Ic d={P_X} size={12} /></button>
          <button type="button" className="v-fold" title={isOpen ? 'Свернуть' : 'Развернуть для редактирования'} onClick={() => toggleOpen(v.id)}><Ic d={P_CHEV} size={12} /></button>
        </div>
        {isOpen && (
          <div className="v-edit">
            <div>
              <label>Название</label>
              <input
                className="inp ve-name"
                maxLength={40}
                value={String(v.name || '')}
                placeholder="название переменной"
                aria-label="Имя переменной (расширенный редактор)"
                onFocus={nameFocus}
                onChange={(e) => store.updateVar(v.id, { name: e.target.value }, { history: false })}
                onBlur={nameBlur}
              />
            </div>
            <div>
              <label>Тип</label>
              <div className="ve-types">
                {Object.keys(VAR_TYPES).map((tk) => (
                  <button
                    key={tk}
                    type="button"
                    className={t === tk ? 'on' : ''}
                    onClick={() => {
                      if (varType(v) === tk) return;
                      store.updateVar(v.id, { type: tk, val: varCastVal(tk, v.val) }, { label: 'Тип переменной' });
                    }}
                  >{VAR_TYPES[tk]}</button>
                ))}
              </div>
            </div>
            <div>
              <label>Начальное значение</label>
              {t === 'num' ? (
                <div className="ve-valrow">
                  <button type="button" className="ve-step" title="−1" onClick={() => store.updateVar(v.id, { val: (typeof v.val === 'number' ? v.val : 0) - 1 }, { history: false })}>−</button>
                  <input
                    className="inp ve-val"
                    value={String(v.val ?? '')}
                    title="Начальное значение"
                    onFocus={valFocus}
                    onChange={(e) => store.updateVar(v.id, { val: e.target.value }, { history: false })}
                    onBlur={valBlur}
                  />
                  <button type="button" className="ve-step" title="+1" onClick={() => store.updateVar(v.id, { val: (typeof v.val === 'number' ? v.val : 0) + 1 }, { history: false })}>+</button>
                </div>
              ) : t === 'bool' ? (
                <div className="ve-bools">
                  <button type="button" className={isTrueVal(v.val) ? 'on' : ''} onClick={() => store.updateVar(v.id, { val: true }, { history: false })}>true</button>
                  <button type="button" className={!isTrueVal(v.val) ? 'on' : ''} onClick={() => store.updateVar(v.id, { val: false }, { history: false })}>false</button>
                </div>
              ) : (
                <input
                  className="inp ve-val"
                  value={String(v.val == null ? '' : v.val)}
                  title="Начальное значение"
                  placeholder="текст"
                  onFocus={valFocus}
                  onChange={(e) => store.updateVar(v.id, { val: e.target.value }, { history: false })}
                  onBlur={valBlur}
                />
              )}
            </div>
            <div>
              <label>Группа</label>
              <VarGroupCombo store={store} v={v} />
            </div>
            <div className="ve-use">{varUseText(store, v.id)}</div>
          </div>
        )}
      </div>
    );
  };

  const ungrouped = vars.filter((v) => !v.groupId || !groups.some((g) => g.id === v.groupId));
  const groupOf = (gid: string) => vars.filter((v) => v.groupId === gid);

  return (
    <div className={'tabpane' + (active ? ' active' : '')} id="paneVars">
      <div className="v-head">
        <span>Переменные сюжета</span>
        <div className="v-head-btns">
          <button type="button" className="btn primary" title="Создать переменную" onClick={() => { const v = store.addVar(); setOpen(new Set([...open, v.id])); }}>+ Переменная</button>
          <button type="button" className="btn ibtn" title="Создать группу переменных" aria-label="Создать группу переменных" onClick={() => store.addVarGroup()}>
            <Ic d={P_FOLDER_PLUS} size={15} />
          </button>
        </div>
      </div>
      {!vars.length && (
        <div className="v-hint">
          <b>Переменных пока нет.</b><br /><br />
          Переменная — это число (number), текст (string) или флаг true/false (boolean), которые меняются по ходу истории: «доверие», «золото», «имя героя»…<br /><br />
          1. Создайте переменную кнопкой выше.<br />
          2. <b>Перетащите строку переменной на холст</b> — получится нода изменения или чтения (режим меняется в инспекторе).<br />
          3. У <b>«Развилки»</b> добавляйте исходы и привязывайте к ним переменную — исход сработает при совпадении значения.
        </div>
      )}
      <div
        id="vRows"
        className={dropHint?.kind === 'root' ? 'drop-ok' : ''}
        onDragOver={(e) => {
          if (!dtHas(e, 'text/vetvi-var')) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          markOver({ kind: 'root' });
        }}
        onDrop={(e) => {
          const vid = e.dataTransfer.getData('text/vetvi-var');
          if (vid) { e.preventDefault(); store.placeVarInList(vid, null, null, 'after'); }
          markOver(null);
        }}
      >
        {ungrouped.map((v) => varRow(v, null))}
        {groups.map((g) => {
          const members = groupOf(g.id);
          const folded = store.varGroupFolded(g.id);
          const gHint = dropHint?.kind === 'ghead' && dropHint.id === g.id ? dropHint.place : null;
          return (
            <div
              key={g.id}
              data-gid={g.id}
              className={'vargroup' + (folded ? '' : ' open')
                + (dropHint?.kind === 'group' && dropHint.id === g.id ? ' drop-ok' : '')
                + (gHint === 'before' ? ' dnd-gap-above' : gHint === 'after' ? ' dnd-gap-below' : '')}
              onDragOver={(e) => {
                if (!dtHas(e, 'text/vetvi-var')) return;
                e.preventDefault();
                e.stopPropagation();
                e.dataTransfer.dropEffect = 'move';
                markOver({ kind: 'group', id: g.id });
              }}
              onDrop={(e) => {
                const vid = e.dataTransfer.getData('text/vetvi-var');
                if (vid) { e.preventDefault(); e.stopPropagation(); store.placeVarInList(vid, g.id, null, 'after'); }
                markOver(null);
              }}
            >
              <div
                className={'vargroup-head' + (dropHint?.kind === 'group' && dropHint.id === g.id ? ' drop-ok' : '')}
                draggable
                title="Перетащите, чтобы сменить порядок групп"
                onDragStart={(e) => { e.dataTransfer.setData('text/vetvi-vargroup', g.id); e.dataTransfer.effectAllowed = 'move'; }}
                onDragEnd={() => markOver(null)}
                onDragOver={(e) => {
                  const isVar = dtHas(e, 'text/vetvi-var');
                  const isGroup = dtHas(e, 'text/vetvi-vargroup');
                  if (!isVar && !isGroup) return;
                  e.preventDefault();
                  e.stopPropagation();
                  e.dataTransfer.dropEffect = 'move';
                  if (isGroup && !isVar) markOver({ kind: 'ghead', id: g.id, place: placeOf(e.currentTarget as HTMLElement, e.clientY) });
                  else markOver({ kind: 'group', id: g.id });
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  const gid = e.dataTransfer.getData('text/vetvi-vargroup');
                  const vid = e.dataTransfer.getData('text/vetvi-var');
                  if (vid) store.placeVarInList(vid, g.id, null, 'after');
                  else if (gid && gid !== g.id) {
                    const tIdx = store.varGroups().findIndex((x) => x.id === g.id);
                    const place = placeOf(e.currentTarget as HTMLElement, e.clientY);
                    store.moveVarGroup(gid, place === 'before' ? tIdx : tIdx + 1);
                  }
                  markOver(null);
                }}
              >
                <span className="cgroup-grip" title="Перетащите, чтобы сменить порядок групп"><Ic d={P_GRIP} size={12} /></span>
                {renGid === g.id ? (
                  <input
                    ref={renRef}
                    className="inp cgroup-name-inp"
                    defaultValue={g.name}
                    maxLength={60}
                    aria-label="Название группы"
                    autoFocus
                    onKeyDown={(e) => { if (e.key === 'Enter') commitRenG(g); if (e.key === 'Escape') setRenGid(null); }}
                    onBlur={() => commitRenG(g)}
                    onMouseDown={(e) => e.stopPropagation()}
                    onDoubleClick={(e) => e.stopPropagation()}
                  />
                ) : (
                  <span className="cgroup-name" title="Двойной клик — переименовать группу" onDoubleClick={(e) => { e.stopPropagation(); setRenGid(g.id); }}>{g.name}</span>
                )}
                <span className="cgroup-cnt">{members.length} перем.</span>
                <button type="button" className="v-del cgroup-del" title="Удалить группу — переменные останутся без группы" onClick={() => store.deleteVarGroup(g.id)}><Ic d={P_X} size={12} /></button>
                <button type="button" className="v-fold" title={folded ? 'Развернуть группу' : 'Свернуть группу — виден только у вас, не синхронизируется'} onClick={() => store.toggleVarGroupCollapsed(g.id)}><Ic d={P_CHEV} size={12} /></button>
              </div>
              {!folded && <div className="cgroup-body">{members.map((v) => varRow(v, g.id))}</div>}
            </div>
          );
        })}
      </div>
      {!!vars.length && (
        <div className="v-hint">
          <b>Как пользоваться:</b> перетащите строку на холст — появится <b>нода переменной</b> (в инспекторе переключается «чтение / изменение»). Тяните связь от ноды переменной ко входу «переменная» у <b>развилки</b> — она перебьёт переменные в условиях исходов. Кнопка-булавка <b>закрепляет</b> переменную — она всегда видна в проигрывании.
        </div>
      )}
    </div>
  );
}

/** Выпадающий список групп переменных с поиском (параметр «Группа» в редакторе переменной). */
function VarGroupCombo({ store, v }: { store: VetviStore; v: VetviVar }) {
  const [openList, setOpenList] = useState(false);
  const [q, setQ] = useState('');
  const wrapRef = useRef<HTMLDivElement | null>(null);
  void store.revision; /* перерисовываться при изменении групп/переменной */
  const groups = store.varGroups();
  const current = v.groupId ? groups.find((g) => g.id === v.groupId) || null : null;

  useEffect(() => {
    if (!openList) return;
    const onDoc = (ev: MouseEvent) => {
      if (!wrapRef.current || !(ev.target instanceof Node) || !wrapRef.current.contains(ev.target)) setOpenList(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [openList]);

  const pick = (gid: string | null) => {
    store.setVarGroup(v.id, gid, { label: gid ? 'Перенос переменной в группу' : 'Переменная без группы' });
    setOpenList(false);
  };

  const nq = q.trim().toLowerCase();
  const filtered = nq ? groups.filter((g) => String(g.name || '').toLowerCase().includes(nq)) : groups;

  return (
    <div className="cgcombo" ref={wrapRef}>
      <button type="button" className="inp cgcombo-btn" title="Группа переменной" aria-label="Группа переменной" onClick={() => { setOpenList(!openList); setQ(''); }}>
        <span className={current ? '' : 'placeholder'}>{current ? current.name : '— без группы —'}</span>
        <Ic d={P_CHEV} size={11} />
      </button>
      {openList && (
        <div className="cgcombo-pop">
          <input
            className="inp cgcombo-q"
            autoFocus
            placeholder="Поиск группы…"
            aria-label="Поиск группы"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') setOpenList(false); }}
          />
          <div className="cgcombo-list">
            <button type="button" className={'cgcombo-it' + (!current ? ' on' : '')} onClick={() => pick(null)}>— без группы —</button>
            {filtered.map((g) => (
              <button key={g.id} type="button" className={'cgcombo-it' + (current && current.id === g.id ? ' on' : '')} onClick={() => pick(g.id)}>
                <Ic d={P_FOLDER} size={11} />
                <span>{g.name}</span>
              </button>
            ))}
            {!filtered.length && <div className="cgcombo-empty">Группы не найдены</div>}
          </div>
        </div>
      )}
    </div>
  );
}
function varUseText(store: VetviStore, vid: string): string {
  let nodes = 0;
  let conds = 0;
  let vin = false;
  for (const n of store.doc.nodes) {
    if (n.type === 'varnode' && n.vid === vid) nodes++;
    if (n.type === 'branch' && Array.isArray(n.outcomes)) {
      for (const o of n.outcomes) if ((o as { cond?: { vid?: string } }).cond?.vid === vid) conds++;
    }
  }
  for (const e of store.doc.edges) {
    const c = (e as unknown as { cond?: { vid?: string } }).cond;
    if (c && c.vid === vid) conds++;
    if (e.tin === 'var') {
      const src = store.nodeById(e.from);
      if (src && src.type === 'varnode' && src.vid === vid) vin = true;
    }
  }
  return 'используется на холсте — ноды: ' + nodes + ' · условия: ' + conds + (vin ? ' · вход развилки: да' : '');
}

/* ── Персонажи ── */

function CharsPane({ store, active, onFile, onRecrop }: { store: VetviStore; active: boolean; onFile: (cid: string, file: File | null) => void; onRecrop: (cid: string) => void }) {
  const chars = store.doc.chars || [];
  const groups = store.charGroups();
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [renGid, setRenGid] = useState<string | null>(null);
  const editPreRef = useRef<string | null>(null);
  const renRef = useRef<HTMLInputElement | null>(null);

  const toggleOpen = (id: string) => {
    const s = new Set(open);
    if (s.has(id)) s.delete(id);
    else s.add(id);
    setOpen(s);
  };

  const nameFocus = () => { editPreRef.current = store.beginEdit(); };
  const nameBlur = () => { store.commitEdit(editPreRef.current, 'Правка персонажа'); editPreRef.current = null; };
  const descFocus = () => { editPreRef.current = store.beginEdit(); };
  const descBlur = () => { store.commitEdit(editPreRef.current, 'Описание персонажа'); editPreRef.current = null; };
  const roleFocus = () => { editPreRef.current = store.beginEdit(); };
  const roleBlur = () => { store.commitEdit(editPreRef.current, 'Роль персонажа'); editPreRef.current = null; };

  /* ── drag & drop: персонаж → группа/позиция, группа → позиция в списке ──
     dropHint показывает, между какими блоками встанет перетаскиваемый объект:
     соседи «расступаются» (классы dnd-gap-…), строка-цель подсвечивает слот вставки. */
  const dtHas = (e: DragEvent, t: string) => Array.from(e.dataTransfer.types).includes(t);
  type CharDropHint =
    | { kind: 'root' }
    | { kind: 'group'; id: string }
    | { kind: 'row'; gid: string | null; refCid: string; place: 'before' | 'after' }
    | { kind: 'ghead'; id: string; place: 'before' | 'after' }
    | null;
  const [dropHint, setDropHint] = useState<CharDropHint>(null);
  const markOver = (next: CharDropHint) =>
    setDropHint((p) => {
      if (p === next) return p;
      if (p && next && p.kind === next.kind
        && (p as { id?: string }).id === (next as { id?: string }).id
        && (p as { refCid?: string }).refCid === (next as { refCid?: string }).refCid
        && (p as { place?: string }).place === (next as { place?: string }).place) return p;
      return next;
    });
  /** до или после середины строки упал курсор — туда и вставляем */
  const placeOf = (el: HTMLElement, clientY: number): 'before' | 'after' => {
    const r = el.getBoundingClientRect();
    return (clientY - r.top) > r.height / 2 ? 'after' : 'before';
  };

  const commitRenG = (g: VetviCharGroup) => {
    const v = (renRef.current?.value || '').trim();
    if (v && v !== g.name) store.updateCharGroup(g.id, { name: v }, { label: 'Переименование группы' });
    setRenGid(null);
  };

  /** строка персонажа — можно перетащить на группу или между строками (позиционная вставка) */
  const charRow = (c: VetviChar, zoneGid: string | null) => {
    const isOpen = open.has(c.id);
    const shape = c.avShape === 'square' ? 'square' : 'circle';
    const roleText = String(c.role || '').trim();
    const hint = dropHint && dropHint.kind === 'row' && dropHint.refCid === c.id ? dropHint.place : null;
    return (
      <div
        key={c.id}
        data-cid={c.id}
        className={'v-item' + (isOpen ? ' open' : '') + (hint === 'before' ? ' dnd-gap-above' : hint === 'after' ? ' dnd-gap-below' : '')}
      >
        <div
          className="v-row c-dragrow"
          draggable
          title="Перетащите: на группу — переместить в неё, между строками — вставить в это место, на область над группами — вывести из группы"
          onDragStart={(e) => { e.dataTransfer.setData('text/vetvi-char', c.id); e.dataTransfer.effectAllowed = 'move'; }}
          onDragEnd={() => markOver(null)}
          onDragOver={(e) => {
            if (!dtHas(e, 'text/vetvi-char')) return;
            e.preventDefault();
            e.stopPropagation();
            e.dataTransfer.dropEffect = 'move';
            markOver({ kind: 'row', gid: zoneGid, refCid: c.id, place: placeOf(e.currentTarget as HTMLElement, e.clientY) });
          }}
          onDrop={(e) => {
            const cid = e.dataTransfer.getData('text/vetvi-char');
            e.preventDefault();
            e.stopPropagation();
            if (cid && cid !== c.id) store.placeCharInList(cid, zoneGid, c.id, placeOf(e.currentTarget as HTMLElement, e.clientY));
            markOver(null);
          }}
        >
          <span className="c-grip" title="Перетащите — сменить группу или порядок в списке"><Ic d={P_GRIP} size={12} /></span>
          <label className="c-avpick" title={c.av ? 'Сменить аватар' : 'Задать аватар — загрузить картинку'}>
            <span className={'c-av ' + shape + (c.av ? '' : ' empty') + ' row'} style={{ borderColor: c.color || '#9cb878' }} title="Аватар персонажа">
              {c.av ? <img src={String(c.av)} alt={'Аватар: ' + c.name} /> : (c.name || '?')[0].toUpperCase()}
            </span>
            <input type="file" className="c-av-pick" accept="image/*" hidden onChange={(e) => { const el = e.currentTarget; onFile(c.id, el.files?.[0] || null); el.value = ''; }} />
          </label>
          <div className="c-namewrap">
            <input
              className="inp v-name c-name"
              maxLength={60}
              value={String(c.name || '')}
              title="Имя персонажа"
              placeholder="имя персонажа"
              aria-label="Имя персонажа"
              onFocus={nameFocus}
              onChange={(e) => store.updateChar(c.id, { name: e.target.value }, { history: false })}
              onBlur={nameBlur}
            />
            {roleText ? <div className="c-role" title={'Роль: ' + roleText}>{roleText}</div> : null}
          </div>
          <button type="button" className="v-del" title="Удалить персонажа" onClick={() => store.deleteChar(c.id)}><Ic d={P_X} size={12} /></button>
          <button type="button" className="v-fold" title={isOpen ? 'Свернуть' : 'Развернуть для редактирования'} onClick={() => toggleOpen(c.id)}><Ic d={P_CHEV} size={12} /></button>
        </div>
        {isOpen && (
          <div className="v-edit">
            <div className="ce-avrow">
              <span className={'c-av ' + shape + (c.av ? '' : ' empty') + ' big'} style={{ borderColor: c.color || '#9cb878' }} title="Аватар персонажа">
                {c.av ? <img src={String(c.av)} alt="" /> : (c.name || '?')[0].toUpperCase()}
              </span>
              <div className="ce-avctl">
                <div className="ce-avbtns">
                  <label className="ce-av-up" title="Загрузить картинку — откроется кадрирование">
                    Загрузить…
                    <input type="file" className="ce-av-file" accept="image/*" hidden onChange={(e) => { const el = e.currentTarget; onFile(c.id, el.files?.[0] || null); el.value = ''; }} />
                  </label>
                  {!!c.av && (
                    <button type="button" className="ce-av-crop" title="Открыть текущий аватар и кадрировать заново" onClick={() => onRecrop(c.id)}>Кадрировать</button>
                  )}
                  {!!c.av && (
                    <button type="button" className="ce-av-rm" title="Убрать аватар" onClick={() => store.updateChar(c.id, { av: null }, { label: 'Убрать аватар' })}>Убрать</button>
                  )}
                </div>
                <div className="ce-av-shape">
                  <button type="button" className={'shp' + (shape === 'circle' ? ' on' : '')} title="Аватар-круг" onClick={() => store.updateChar(c.id, { avShape: 'circle' }, { history: false })}><i className="shp-ic circle" />круг</button>
                  <button type="button" className={'shp' + (shape === 'square' ? ' on' : '')} title="Аватар-квадрат со скруглёнными углами" onClick={() => store.updateChar(c.id, { avShape: 'square' }, { history: false })}><i className="shp-ic square" />квадрат</button>
                </div>
              </div>
            </div>
            {/* ссылка на картинку с другого ресурса (ce-avurl оригинала 5686);
                key по аватару — перемонтирование поля при смене аватара извне */}
            <AvatarLinkRow key={'avurl:' + c.id + ':' + String(c.av || '')} c={c} store={store} />
            <div>
              <label>Имя</label>
              <input
                className="inp ce-name"
                maxLength={60}
                value={String(c.name || '')}
                placeholder="имя персонажа"
                aria-label="Имя персонажа (расширенный редактор)"
                onFocus={nameFocus}
                onChange={(e) => store.updateChar(c.id, { name: e.target.value }, { history: false })}
                onBlur={nameBlur}
              />
            </div>
            <div>
              <label>Цвет</label>
              <div className="swatches">
                {PALETTE_COLORS.map((col) => (
                  <button
                    key={col}
                    type="button"
                    className={'swatch' + (c.color === col ? ' on' : '')}
                    style={{ background: col }}
                    title={col}
                    aria-label={'Цвет ' + col}
                    onClick={() => store.updateChar(c.id, { color: col }, { label: 'Цвет персонажа' })}
                  />
                ))}
              </div>
            </div>
            <div>
              <label>Роль</label>
              <input
                className="inp ce-role"
                maxLength={80}
                value={String(c.role || '')}
                placeholder="например: главный герой"
                aria-label="Роль персонажа"
                onFocus={roleFocus}
                onChange={(e) => store.updateChar(c.id, { role: e.target.value }, { history: false })}
                onBlur={roleBlur}
              />
            </div>
            <div>
              <label>Группа</label>
              <CharGroupCombo store={store} c={c} />
            </div>
            <div>
              <label>Описание</label>
              <textarea
                className="inp ce-desc"
                placeholder="Кто это, какова его роль в истории…"
                style={{ minHeight: 52 }}
                aria-label="Описание персонажа"
                onFocus={descFocus}
                onChange={(e) => store.updateChar(c.id, { text: e.target.value }, { history: false })}
                onBlur={descBlur}
              />
            </div>
            <div className="ve-use">{charUseText(store, c.id)}</div>
          </div>
        )}
      </div>
    );
  };

  const ungrouped = chars.filter((c) => !c.groupId || !groups.some((g) => g.id === c.groupId));
  const groupOf = (gid: string) => chars.filter((c) => c.groupId === gid);

  return (
    <div className={'tabpane' + (active ? ' active' : '')} id="paneChars">
      <div className="v-head">
        <span>Персонажи истории</span>
        <div className="v-head-btns">
          <button type="button" className="btn ibtn" title="Создать персонажа" aria-label="Создать персонажа" onClick={() => { const c = store.addChar(); setOpen(new Set([...open, c.id])); }}>
            <Ic d={P_USER_PLUS} size={15} />
          </button>
          <button type="button" className="btn ibtn" title="Создать группу персонажей" aria-label="Создать группу персонажей" onClick={() => store.addCharGroup()}>
            <Ic d={P_FOLDER_PLUS} size={15} />
          </button>
        </div>
      </div>
      {!chars.length && (
        <div className="v-hint">
          <b>Персонажей пока нет.</b><br /><br />
          Персонаж — действующее лицо истории: его добавляют <b>участником диалога</b> (и автором реплик), а также участником обычных узлов — блок окрасится в его цвет.<br /><br />
          1. Создайте персонажа кнопкой выше.<br />
          2. Откройте диалог → «Участники» → добавьте персонажа.<br />
          3. Имя и цвет меняются в любой момент — плашки на холсте обновятся сами.
        </div>
      )}
      <div
        id="cRows"
        className={dropHint?.kind === 'root' ? 'drop-ok' : ''}
        onDragOver={(e) => {
          if (!dtHas(e, 'text/vetvi-char')) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          markOver({ kind: 'root' });
        }}
        onDrop={(e) => {
          const cid = e.dataTransfer.getData('text/vetvi-char');
          if (cid) { e.preventDefault(); store.setCharGroup(cid, null); }
          markOver(null);
        }}
      >
        {ungrouped.map((c) => charRow(c, null))}
        {groups.map((g) => {
          const members = groupOf(g.id);
          const folded = store.charGroupFolded(g.id);
          const gHint = dropHint?.kind === 'ghead' && dropHint.id === g.id ? dropHint.place : null;
          return (
            <div
              key={g.id}
              data-gid={g.id}
              className={'cgroup' + (folded ? '' : ' open')
                + (dropHint?.kind === 'group' && dropHint.id === g.id ? ' drop-ok' : '')
                + (gHint === 'before' ? ' dnd-gap-above' : gHint === 'after' ? ' dnd-gap-below' : '')}
              onDragOver={(e) => {
                if (!dtHas(e, 'text/vetvi-char')) return;
                e.preventDefault();
                e.stopPropagation();
                e.dataTransfer.dropEffect = 'move';
                markOver({ kind: 'group', id: g.id });
              }}
              onDrop={(e) => {
                const cid = e.dataTransfer.getData('text/vetvi-char');
                if (cid) { e.preventDefault(); e.stopPropagation(); store.placeCharInList(cid, g.id, null, 'after'); }
                markOver(null);
              }}
            >
              <div
                className={'cgroup-head' + (dropHint?.kind === 'group' && dropHint.id === g.id ? ' drop-ok' : '')}
                draggable
                title="Перетащите, чтобы сменить порядок групп"
                onDragStart={(e) => { e.dataTransfer.setData('text/vetvi-chargroup', g.id); e.dataTransfer.effectAllowed = 'move'; }}
                onDragEnd={() => markOver(null)}
                onDragOver={(e) => {
                  const isChar = dtHas(e, 'text/vetvi-char');
                  const isGroup = dtHas(e, 'text/vetvi-chargroup');
                  if (!isChar && !isGroup) return;
                  e.preventDefault();
                  e.stopPropagation();
                  e.dataTransfer.dropEffect = 'move';
                  if (isGroup && !isChar) markOver({ kind: 'ghead', id: g.id, place: placeOf(e.currentTarget as HTMLElement, e.clientY) });
                  else markOver({ kind: 'group', id: g.id });
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  const gid = e.dataTransfer.getData('text/vetvi-chargroup');
                  const cid = e.dataTransfer.getData('text/vetvi-char');
                  if (cid) store.placeCharInList(cid, g.id, null, 'after');
                  else if (gid && gid !== g.id) {
                    const tIdx = store.charGroups().findIndex((x) => x.id === g.id);
                    const place = placeOf(e.currentTarget as HTMLElement, e.clientY);
                    store.moveCharGroup(gid, place === 'before' ? tIdx : tIdx + 1);
                  }
                  markOver(null);
                }}
              >
                <span className="cgroup-grip" title="Перетащите, чтобы сменить порядок групп"><Ic d={P_GRIP} size={12} /></span>
                {renGid === g.id ? (
                  <input
                    ref={renRef}
                    className="inp cgroup-name-inp"
                    defaultValue={g.name}
                    maxLength={60}
                    aria-label="Название группы"
                    autoFocus
                    onKeyDown={(e) => { if (e.key === 'Enter') commitRenG(g); if (e.key === 'Escape') setRenGid(null); }}
                    onBlur={() => commitRenG(g)}
                    onMouseDown={(e) => e.stopPropagation()}
                    onDoubleClick={(e) => e.stopPropagation()}
                  />
                ) : (
                  <span className="cgroup-name" title="Двойной клик — переименовать группу" onDoubleClick={(e) => { e.stopPropagation(); setRenGid(g.id); }}>{g.name}</span>
                )}
                <span className="cgroup-cnt">{members.length} перс.</span>
                <button type="button" className="v-del cgroup-del" title="Удалить группу — персонажи останутся без группы" onClick={() => store.deleteCharGroup(g.id)}><Ic d={P_X} size={12} /></button>
                <button type="button" className="v-fold" title={folded ? 'Развернуть группу' : 'Свернуть группу — виден только у вас, не синхронизируется'} onClick={() => store.toggleCharGroupCollapsed(g.id)}><Ic d={P_CHEV} size={12} /></button>
              </div>
              {!folded && <div className="cgroup-body">{members.map((c) => charRow(c, g.id))}</div>}
            </div>
          );
        })}
      </div>
      {!!chars.length && <div className="v-hint" />}
    </div>
  );
}

/** Выпадающий список групп с поиском (параметр «Группа» в редакторе персонажа). */
function CharGroupCombo({ store, c }: { store: VetviStore; c: VetviChar }) {
  const [openList, setOpenList] = useState(false);
  const [q, setQ] = useState('');
  const wrapRef = useRef<HTMLDivElement | null>(null);
  void store.revision; /* перерисовываться при изменении групп/персонажа */
  const groups = store.charGroups();
  const current = c.groupId ? groups.find((g) => g.id === c.groupId) || null : null;

  useEffect(() => {
    if (!openList) return;
    const onDoc = (ev: MouseEvent) => {
      if (!wrapRef.current || !(ev.target instanceof Node) || !wrapRef.current.contains(ev.target)) setOpenList(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [openList]);

  const pick = (gid: string | null) => {
    store.setCharGroup(c.id, gid, { label: gid ? 'Перенос персонажа в группу' : 'Персонаж без группы' });
    setOpenList(false);
  };

  const nq = q.trim().toLowerCase();
  const filtered = nq ? groups.filter((g) => String(g.name || '').toLowerCase().includes(nq)) : groups;

  return (
    <div className="cgcombo" ref={wrapRef}>
      <button type="button" className="inp cgcombo-btn" title="Группа персонажа" aria-label="Группа персонажа" onClick={() => { setOpenList(!openList); setQ(''); }}>
        <span className={current ? '' : 'placeholder'}>{current ? current.name : '— без группы —'}</span>
        <Ic d={P_CHEV} size={11} />
      </button>
      {openList && (
        <div className="cgcombo-pop">
          <input
            className="inp cgcombo-q"
            autoFocus
            placeholder="Поиск группы…"
            aria-label="Поиск группы"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') setOpenList(false); }}
          />
          <div className="cgcombo-list">
            <button type="button" className={'cgcombo-it' + (!current ? ' on' : '')} onClick={() => pick(null)}>— без группы —</button>
            {filtered.map((g) => (
              <button key={g.id} type="button" className={'cgcombo-it' + (current && current.id === g.id ? ' on' : '')} onClick={() => pick(g.id)}>
                <Ic d={P_FOLDER} size={11} />
                <span>{g.name}</span>
              </button>
            ))}
            {!filtered.length && <div className="cgcombo-empty">Группы не найдены</div>}
          </div>
        </div>
      )}
    </div>
  );
}

function charUseText(store: VetviStore, cid: string): string {
  let dialogs = 0;
  let replies = 0;
  let nodes = 0;
  for (const n of store.doc.nodes) {
    if (n.dialog) {
      if ((n.dialog.participants || []).includes(cid)) dialogs++;
      const walk = (arr: { speaker?: string | null }[]) => {
        for (const r of arr) {
          if (r.speaker === cid) replies++;
          const ch = (r as { children?: { speaker?: string | null }[] }).children;
          if (ch) walk(ch);
        }
      };
      walk(n.dialog.replies || []);
    }
    if (Array.isArray(n.participants) && (n.participants as string[]).includes(cid)) nodes++;
  }
  return 'используется — диалогов: ' + dialogs + ' · реплик: ' + replies + (nodes ? ' · узлов: ' + nodes : '');
}

/** dataURL → Image: загрузка готового кадра перед сжатием (readAsDataURL-часть fileToAvatar оригинала). */
function imageFromUrl(src: string, ok: (img: HTMLImageElement) => void, fail: () => void): void {
  const img = new Image();
  if (/^https?:\/\//i.test(src)) img.crossOrigin = 'anonymous';
  img.onload = () => ok(img);
  img.onerror = fail;
  img.src = src;
}

/** Сжатие квадрата-исходника в dataURL аватара — код прежнего fileToAvatar (avCompressCrop
 *  оригинала: 192px webp 0.85 → если >60К символов, 128px jpeg 0.8). */
export function compressAvatar(img: HTMLImageElement, cb: (dataUrl: string) => void): void {
  const side = Math.min(img.width, img.height);
  const sx = (img.width - side) / 2;
  const sy = (img.height - side) / 2;
  const put = (size: number, mime: string, q: number) => {
    const cv = document.createElement('canvas');
    cv.width = size;
    cv.height = size;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(img, sx, sy, side, side, 0, 0, size, size);
    return cv.toDataURL(mime, q);
  };
  let out = put(192, 'image/webp', 0.85) || '';
  if (!out || out.length > 60000) out = put(128, 'image/jpeg', 0.8) || out;
  cb(out);
}

/* helpers used by pane */
export { condOpsFor, opsForType };
