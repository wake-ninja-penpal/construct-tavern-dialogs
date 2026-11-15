'use client';

/**
 * Ветви — левая панель: 1:1 порт aside#left классической версии.
 * Вкладки .ltabs/.ltab/.lt-ic, палитра .pal-item/.pal-sep/.pal-group/.cv-card,
 * обзор .search/.nli (.grp/.ov-f/.garr/.dot/.t/.k/.list-empty),
 * переменные .v-item/.v-row/.v-grip/.v-name/.v-type/.v-val/.v-del/.v-fold/.v-edit/.ve-*,
 * персонажи .c-avpick/.c-av/.c-name/.ce-avrow/.shp/.swatches/.ce-desc.
 * Классы, id и структура DOM совпадают с оригиналом — стили vetvi.css применяются как есть.
 */

import { Fragment, useCallback, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';

import { NODE_W, PALETTE_COLORS, STATUS_RU, TYPES, customTypesOfDoc, typeInfoOf } from '@/vetvi/core/constants';
import type { CustomTypeRec } from '@/vetvi/core/constants';
import { nodeColor } from '@/vetvi/core/geometry';
import { newNode, snapVal } from '@/vetvi/core/factory';
import { opsForType, VAR_TYPES, varCastVal, varType, isTrueVal } from '@/vetvi/core/vars';
import type { VetviChar, VetviDoc, VetviGroup, VetviNode, VetviVar } from '@/vetvi/core/types';
import { condOpsFor, varById } from '@/vetvi/core/vars';
import type { VetviStore } from './store';
import { TypeIcon } from './NodeCard';
import { CropModal, type CropReq } from './CropModal';
import { CustomTypeModal, deleteCustomTypeOf } from './CustomTypeModal';

/* ── иконки (копия ALLICONS оригинала) ── */
const P_FOLDER = '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>';
const P_LIST = '<path d="M8 6h12M8 12h12M8 18h12"/><circle cx="3.7" cy="6" r="1.1"/><circle cx="3.7" cy="12" r="1.1"/><circle cx="3.7" cy="18" r="1.1"/>';
const P_VAR = '<path d="M5 8c2.6-5 5.4 5 8 0 1.4-2.6 3.4-3 6-1.5"/><path d="M5 12.5h14"/><path d="M5 17c2.6 5 5.4-5 8 0 1.4 2.6 3.4 3 6 1.5"/>';
const P_CHAR = '<circle cx="12" cy="8.2" r="3.6"/><path d="M4.8 20c1.1-3.4 3.9-5.2 7.2-5.2s6.1 1.8 7.2 5.2"/>';
const P_CHEV = '<path d="m6 9 6 6 6-6"/>';
const P_X = '<path d="M6 6l12 12M18 6 6 18"/>';
const P_GRIP = '<path d="M9 5.5h.01M9 12h.01M9 18.5h.01M15 5.5h.01M15 12h.01M15 18.5h.01"/>';
const P_PENCIL = '<path d="m4 20 1-4L16.3 4.7a2.1 2.1 0 0 1 3 3L8 19z"/><path d="M14.5 6.5l3 3"/>';
const P_EYE = '<path d="M2.5 12S6 5.8 12 5.8 21.5 12 21.5 12 18 18.2 12 18.2 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/>';
const P_EYE_OFF = '<path d="M2.5 12S6 5.8 12 5.8c1.2 0 2.3.3 3.3.7M21.5 12S18 18.2 12 18.2c-1.2 0-2.3-.3-3.3-.7"/><path d="M4 4l16 16"/>';

/** ic(name,size) оригинала — svg-обёртка над путём иконки. */
function Ic(props: { d: string; size?: number }) {
  const size = props.size || 15;
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <g dangerouslySetInnerHTML={{ __html: props.d }} />
    </svg>
  );
}

export function LeftPane(props: { store: VetviStore }) {
  const { store } = props;
  const tab = store.leftTab;
  void store.revision;

  const tabs = [['pal', 'Элементы'], ['list', 'Обзор'], ['vars', 'Переменные'], ['chars', 'Персонажи']] as const;

  /* редактор своих типов (openTypeEditor оригинала): rec:null — новый тип, rec — правка */
  const [typeEd, setTypeEd] = useState<{ rec: CustomTypeRec | null } | null>(null);
  const closeTypeEd = useCallback(() => setTypeEd(null), []);
  const openNewType = useCallback(() => setTypeEd({ rec: null }), []);
  const openEditType = useCallback((id: string) => {
    const c = customTypesOfDoc(store.doc).find((x) => x.id === id);
    if (c) setTypeEd({ rec: c });
  }, [store]);

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
      <PalettePane store={store} active={tab === 'pal'} onAddType={openNewType} onEditType={openEditType} />
      <ListPane store={store} active={tab === 'list'} />
      <VarsPane store={store} active={tab === 'vars'} />
      <CharsPane store={store} active={tab === 'chars'} onFile={onFile} onRecrop={onRecrop} />
      {crop && <CropModal store={store} req={crop} onClose={closeCrop} />}
      {typeEd && <CustomTypeModal store={store} existing={typeEd.rec} onClose={closeTypeEd} />}
    </aside>
  );
}

/* ── свой тип из документа (customTypes оригинала) ── */

/** addNode оригинала (строка 6479): дефолты newNode; у ноды своего типа
    заголовок = имя типа (typeInfo(typeKey).name). Возвращает id созданной ноды. */
function addNodeOf(store: VetviStore, key: string, x: number, y: number): string {
  let nid = '';
  store.mutate((doc) => {
    const n = newNode(key, snapVal(x, store.snapOn), snapVal(y, store.snapOn));
    if (!TYPES[key]) {
      const c = customTypesOfDoc(doc).find((x2) => x2.id === key);
      if (c) n.title = c.name;
    }
    doc.nodes.push(n);
    nid = n.id;
  }, { label: 'Создание ноды «' + typeInfoOf(store.doc, key).name + '»' });
  if (nid) store.selectOnly(nid);
  return nid;
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

/* ── Элементы (палитра с перетаскиванием) ── */
function PalettePane({ store, active, onAddType, onEditType }: {
  store: VetviStore;
  active: boolean;
  onAddType: () => void;
  onEditType: (id: string) => void;
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
    addNodeOf(store, type, w.x, w.y);
  };

  /* toggleListVis оригинала (2964–2970): переключить listHidden + тост (без записи в историю) */
  const toggleListVis = (key: string) => {
    store.mutate((doc) => {
      const lh: unknown = doc.listHidden;
      if (Array.isArray(lh)) {
        const i = lh.indexOf(key);
        if (i >= 0) lh.splice(i, 1);
        else lh.push(key);
      } else if (lh && typeof lh === 'object') {
        const rec = lh as Record<string, unknown>;
        if (rec[key]) delete rec[key];
        else rec[key] = true;
      } else {
        doc.listHidden = { [key]: true };
      }
    }, { history: false });
    store.toast(listHiddenAt(store.doc, key)
      ? 'Тип убран из раздела «На холсте»'
      : 'Тип возвращён в раздел «На холсте»');
  };

  const isHidden = (key: string) => listHiddenAt(store.doc, key);
  const typeKeys = Object.keys(TYPES).concat(customTypesOfDoc(store.doc).map((c) => c.id));
  const canvasGroups = typeKeys
    .filter((key) => !isHidden(key))
    .map((key) => ({ key, list: store.doc.nodes.filter((n) => n.type === key) }))
    .filter((g) => g.list.length > 0);

  return (
    <div className={'tabpane' + (active ? ' active' : '')} id="panePal" onDragOver={(e) => e.preventDefault()} onDrop={drop}>
      <div className="v-head" style={{ margin: '2px 10px 8px' }}>
        <span>Элементы</span>
        {/* bAddType оригинала (строка 1135) */}
        <button type="button" className="btn primary" id="bAddType" title="Создать свой тип элемента" onClick={onAddType}>+ Свой тип</button>
      </div>
      <div id="palList">
        {typeKeys.map((key) => {
          const info = typeInfoOf(store.doc, key);
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
                const wy = (r.height / 2 - store.vp.y) / store.vp.z - 46;
                addNodeOf(store, key, wx, wy);
              }}
            >
              <span className="pal-ico"><TypeIcon type={key} size={16} icon={info.icon} /></span>
              <span className="pal-name">{info.name}</span>
              <span className="pal-cnt">{cnt}</span>
              {/* глазик видимости в разделе «на холсте» — у каждого типа (data-eye 4355) */}
              <button
                type="button"
                className={'mini-btn eye' + (off ? ' off' : '')}
                data-eye={key}
                title={off ? 'Вернуть тип в раздел «На холсте»' : 'Убрать тип из раздела «На холсте»'}
                onClick={(e) => { e.stopPropagation(); toggleListVis(key); }}
              >
                <Ic d={off ? P_EYE_OFF : P_EYE} size={13} />
              </button>
              {/* карандаш/крестик только у своих типов (item-acts 4285–4312) */}
              {isCustom && (
                <span className="item-acts">
                  <button
                    type="button"
                    className="mini-btn"
                    data-edit={key}
                    title="Редактировать"
                    onClick={(e) => { e.stopPropagation(); onEditType(key); }}
                  >
                    <Ic d={P_PENCIL} size={12} />
                  </button>
                  <button
                    type="button"
                    className="mini-btn del"
                    data-del={key}
                    title="Удалить тип"
                    onClick={(e) => { e.stopPropagation(); deleteCustomTypeOf(store, key); }}
                  >
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
          const info = typeInfoOf(store.doc, key);
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
                    style={{ '--c': n.color ? nodeColor(n) : typeInfoOf(store.doc, n.type).color } as CSSProperties}
                    title="Клик — перейти · перетащите, чтобы создать копию"
                    onDragStart={(e) => {
                      e.dataTransfer.setData('text/vetvi-clone', n.id);
                      e.dataTransfer.effectAllowed = 'copy';
                    }}
                    onClick={() => { store.selectOnly(n.id); store.requestCenter(n.id); }}
                  >
                    <span className="pal-ico"><TypeIcon type={n.type} size={16} icon={typeInfoOf(store.doc, n.type).icon} /></span>
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

  const nodeRow = (n: VetviNode, indent: number | null): ReactNode => {
    /* vis оригинала (nodeVisual): имя/цвет типа — в т.ч. своего */
    const ti = typeInfoOf(store.doc, n.type);
    const rowColor = n.color ? nodeColor(n) : ti.color;
    return (
      <div
        key={n.id}
        className={'nli' + (store.sel.has(n.id) ? ' sel' : '')}
        data-id={n.id}
        style={indent == null ? undefined : { paddingLeft: indent }}
        onClick={() => { store.selectOnly(n.id); store.requestCenter(n.id); }}
      >
        <span className="dot" style={{ background: rowColor, color: rowColor }} />
        <span className="t">{n.title}</span>
        <span className="k">{ti.name}</span>
      </div>
    );
  };

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
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [dragReady, setDragReady] = useState<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const dragVid = useRef<string | null>(null);
  const editPreRef = useRef<string | null>(null);

  const toggleOpen = (id: string) => {
    const s = new Set(open);
    if (s.has(id)) s.delete(id);
    else s.add(id);
    setOpen(s);
  };

  const dropToCanvas = (e: React.DragEvent) => {
    e.preventDefault();
    const vid = e.dataTransfer.getData('text/vetvi-var') || dragVid.current;
    if (!vid) return;
    const el = document.querySelector('.rn-canvas');
    const r = el ? el.getBoundingClientRect() : { left: 0, top: 0, width: 800, height: 600 };
    const wx = (e.clientX - r.left - store.vp.x) / store.vp.z - NODE_W / 2;
    const wy = (e.clientY - r.top - store.vp.y) / store.vp.z - 20;
    const v = varById(store.doc, vid);
    const pre = store.beginEdit();
    const n = store.addNodeAtRaw('varnode', wx, wy);
    if (n) {
      n.varMode = 'set';
      n.varOp = '=';
      n.varVal = v ? (typeof v.val === 'number' ? v.val : 0) : 0;
      n.vid = vid;
    }
    store.commitEdit(pre, 'Нода переменной');
    store.toast('Нода переменной создана', 'ok');
  };

  const nameFocus = () => { editPreRef.current = store.beginEdit(); };
  const nameBlur = () => { store.commitEdit(editPreRef.current, 'Правка переменной'); editPreRef.current = null; };
  const valFocus = () => { editPreRef.current = store.beginEdit(); };
  const valBlur = () => { store.commitEdit(editPreRef.current, 'Значение переменной'); editPreRef.current = null; };

  return (
    <div className={'tabpane' + (active ? ' active' : '')} id="paneVars" onDragOver={(e) => e.preventDefault()} onDrop={dropToCanvas}>
      <div className="v-head">
        <span>Переменные сюжета</span>
        <button type="button" className="btn primary" title="Создать переменную" onClick={() => { const v = store.addVar(); setOpen(new Set([...open, v.id])); }}>+ Переменная</button>
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
      <div id="vRows">
        {vars.map((v: VetviVar) => {
          const isOpen = open.has(v.id);
          const t = varType(v);
          return (
            <div
              key={v.id}
              data-vid={v.id}
              className={'v-item' + (isOpen ? ' open' : '') + (draggingId === v.id ? ' dragging' : '')}
              draggable={dragReady === v.id}
              onDragStart={(e) => {
                e.dataTransfer.setData('text/vetvi-var', v.id);
                e.dataTransfer.effectAllowed = 'copy';
                dragVid.current = v.id;
                setDraggingId(v.id);
              }}
              onDragEnd={() => { setDragReady(null); setDraggingId(null); }}
            >
              <div className="v-row">
                <span
                  className="v-grip"
                  title="Перетащите на холст — создать ноду переменной"
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
                  <div className="ve-use">{varUseText(store, v.id)}</div>
                </div>
              )}
            </div>
          );
        })}
      </div>
      {!!vars.length && (
        <div className="v-hint">
          <b>Как пользоваться:</b> перетащите строку на холст — появится <b>нода переменной</b> (в инспекторе переключается «чтение / изменение»). В режиме новеллы ноды не показываются как слайды: нода изменения применяет операцию и ведёт дальше, нода чтения считывает значение. Тяните связь от ноды переменной ко входу «переменная» у <b>развилки</b> — она перебьёт переменные в условиях исходов.
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
  const [open, setOpen] = useState<Set<string>>(new Set());
  const editPreRef = useRef<string | null>(null);

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

  return (
    <div className={'tabpane' + (active ? ' active' : '')} id="paneChars">
      <div className="v-head">
        <span>Персонажи истории</span>
        <button type="button" className="btn primary" title="Создать персонажа" onClick={() => { const c = store.addChar(); setOpen(new Set([...open, c.id])); }}>+ Персонаж</button>
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
      <div id="cRows">
        {chars.map((c: VetviChar) => {
          const isOpen = open.has(c.id);
          const shape = c.avShape === 'square' ? 'square' : 'circle';
          return (
            <div key={c.id} data-cid={c.id} className={'v-item' + (isOpen ? ' open' : '')}>
              <div className="v-row">
                <label className="c-avpick" title={c.av ? 'Сменить аватар' : 'Задать аватар — загрузить картинку'}>
                  <span className={'c-av ' + shape + (c.av ? '' : ' empty') + ' row'} style={{ borderColor: c.color || '#9cb878' }} title="Аватар персонажа">
                    {c.av ? <img src={String(c.av)} alt={'Аватар: ' + c.name} /> : (c.name || '?')[0].toUpperCase()}
                  </span>
                  <input type="file" className="c-av-pick" accept="image/*" hidden onChange={(e) => { const el = e.currentTarget; onFile(c.id, el.files?.[0] || null); el.value = ''; }} />
                </label>
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
        })}
      </div>
      {!!chars.length && <div className="v-hint" />}
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
