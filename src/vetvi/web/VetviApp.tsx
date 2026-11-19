'use client';

/**
 * Ветви — корневой компонент React-редактора (этап 2 порта).
 * Компоновка: тулбар / левая панель + холст + инспектор / статусбар,
 * все модальные окна, проигрыватель, диспетчер горячих клавиш HK_DEFS
 * (строгая цепочка условий, как в оригинале, строки 9949–10033).
 */

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';

import { hkIs, hkLoad, hkText } from '@/vetvi/core/hotkeys';
import { fmtWhenLong, fmtWhenShort } from '@/vetvi/core/projects';
import { APP_VERSION } from '@/vetvi/core/patchnotes';
import { storeBoot, storeMode } from '@/vetvi/core/storage';
import { getStore, type VetviStore } from './store';
import { useStoreRev } from './rev';
import { SyncClient } from './sync';
import { TopBar } from './TopBar';
import { CanvasBoard } from './CanvasBoard';
import { LeftPane } from './LeftPane';
import { Inspector } from './Inspector';
import { Player } from './Player';
import { NoteModals, noteBus, noteModalOpen } from './NoteModals';
import { DialogModal } from './DialogModal';
import { ModalHost, ConfirmHost, bindLogHelpers } from './Modals';
import { CtxMenuHost, ToastHost } from './CtxMenu';
import { DstWin } from './DstWin';
import { CollabPopover, LockScreen, LockTipHost } from './SyncModals';
import { canvasApi } from './canvasApi';
import { AuthGate, fetchAuthState } from './AuthGate';
import { AdminPanel, isAdminHash } from './AdminPanel';
import { authApplyState } from './auth';
import { ServiceScreen } from '@/services/ServiceScreen';
import {
  fetchServices,
  invalidateServicesCache,
  onServicesChanged,
  parseHash,
  VETVI_SERVICE_KEY,
} from '@/services/hub';
import { ensureServicesLive, servicesLiveHello } from '@/services/live';

/* Рендер после монтирования: документ читается из localStorage при создании стора. */
const emptySubscribe = () => () => {};
function useMounted(): boolean {
  return useSyncExternalStore(emptySubscribe, () => true, () => false);
}

/* useStoreRev импортируется из ./rev (общая подписка на каналы стора). */

/* ── всплывашка над «✓ автосохранение»: кто и когда менял проект (editTip оригинала) ──
   Кликабельна: курсор можно перевести на неё; кнопка открывает «Журнал действий». */
interface EditLogRec { id?: string; name?: string; color?: string; at?: number | string }

function EditTipHost({ store }: { store: VetviStore }) {
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const tipHover = useRef(false);
  const hideT = useRef<ReturnType<typeof setTimeout> | null>(null);
  void store.revision;

  const meta = store.doc.meta as VetviStore['doc']['meta'] & { editLog?: unknown[]; modified?: number };
  const when = fmtWhenShort(meta.modified);

  const show = () => {
    if (hideT.current) { clearTimeout(hideT.current); hideT.current = null; }
    const el = document.getElementById('stAuto');
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos({
      left: Math.max(150, Math.min(window.innerWidth - 150, r.left + r.width / 2)),
      top: Math.max(70, r.top - 8),
    });
  };
  const hide = () => setPos(null);
  const lateHide = () => {
    if (hideT.current) clearTimeout(hideT.current);
    hideT.current = setTimeout(() => { if (!tipHover.current) hide(); }, 110);
  };

  useEffect(() => {
    const onWinBlur = () => hide();
    window.addEventListener('blur', onWinBlur);
    return () => {
      window.removeEventListener('blur', onWinBlur);
      if (hideT.current) clearTimeout(hideT.current);
    };
  }, []);

  /* схлопывание подряд идущих записей одного человека (как collapseEditLog оригинала) */
  const rows: EditLogRec[] = [];
  const rawLog = Array.isArray(meta.editLog) ? (meta.editLog as EditLogRec[]) : [];
  for (const e of rawLog) {
    const p = rows[rows.length - 1];
    if (p && ((p.id && p.id === e.id) || (p.name && p.name === e.name))) continue;
    rows.push(e);
    if (rows.length >= 6) break;
  }

  return (
    <>
      <span
        id="stAuto"
        tabIndex={0}
        aria-label="Когда проект изменён последний раз и кто это сделал"
        onMouseEnter={show}
        onMouseLeave={lateHide}
        onFocus={show}
        onBlur={lateHide}
      >
        {'✓ автосохранение' + (when ? ' · ' + when : '')}
      </span>
      {pos && (
        <div
          id="editTip"
          className="show"
          role="tooltip"
          style={{ left: pos.left, top: pos.top }}
          onMouseEnter={() => { tipHover.current = true; }}
          onMouseLeave={() => { tipHover.current = false; hide(); }}
        >
          <div className="et-cap">Последнее изменение</div>
          {rows.length
            ? rows.map((e, i) => (
              <div className="et-row" key={i}>
                <span className="et-dot" style={{ background: e.color || '#8b929c', color: e.color || '#8b929c' }} />
                <span className="et-who">{e.name || '—'}</span>
                <span className="et-when">{fmtWhenLong(e.at)}</span>
              </div>
            ))
            : (
              <div className="et-row">
                <span>{meta.modified ? 'Изменён: ' + fmtWhenLong(meta.modified) : 'Изменений пока не было'}</span>
              </div>
            )}
          <button
            type="button"
            className="et-btn"
            onClick={() => { hide(); store.setLogFilters(null, null); store.openModal('log'); }}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" width={11} height={11} aria-hidden="true">
              <path d="M4 5h16M4 12h16M4 19h10" />
            </svg>
            Журнал действий
          </button>
        </div>
      )}
    </>
  );
}

/**
 * Boot-обёртка: в режиме IndexedDB данные читаются асинхронно — хранилище прогревается
 * storeBoot() ДО создания стора (getStore читает слот проекта синхронно из памяти).
 * Без прогрева в idb-режиме приложение стартовало с пустым проектом, и «локальные
 * проекты не сохранялись в браузере» — на деле они писались в базу, но никогда не читались.
 *
 * Заготовка авторизации: секретный хеш в адресе открывает скрытую панель админа;
 * при включённой авторизации без залогина показывается гейт входа/регистрации.
 * Если сервер авторизации недоступен — работаем как раньше (fail-open для разработки).
 */
export default function VetviApp() {
  /* скрытая админка: только по секретному хешу в адресе, ссылок в приложении нет.
     Проверяем ПОСЛЕ монтирования (и на hashchange) — иначе рассинхрон SSR/клиент
     даёт ошибку гидратации. */
  const [adminHash, setAdminHash] = useState(false);
  const [authPhase, setAuthPhase] = useState<'loading' | 'ok' | 'gate'>('loading');
  const [booted, setBooted] = useState(() => storeMode() !== 'idb');
  /* хаб сервисов: #service=<path> в адресе — открыт сторонний сервис,
     пустой хеш — «Ветви». Как и админка, живёт на единственном маршруте «/». */
  const [svcKey, setSvcKey] = useState<string | null>(null);
  /* «Ветви» тоже сервис: админ может запретить его пользователю — тогда
     редактор не открывается вовсе (экран «нет доступа» вместо холста). */
  const [vetviBlocked, setVetviBlocked] = useState(false);
  /* прямая ссылка на ноду (из задачи менеджера задач): #…node=<id> —
     после монтирования редактора центрируем и подсвечиваем ноду */
  const [nodeGoto, setNodeGoto] = useState<string | null>(null);
  /* режим привязки нод к задаче менеджера задач: #attach=<taskId>&at=<title> */
  const [attachTask, setAttachTask] = useState<{ id: string; title: string } | null>(null);

  useEffect(() => {
    /* служебный сокет сервисов: живёт и в редакторе, и на экранах сервисов —
       мгновенная реакция на вкл/выкл сервисов и смену персональных доступов */
    ensureServicesLive();
  }, []);

  useEffect(() => {
    const check = () => {
      const info = parseHash();
      setAdminHash(isAdminHash());
      setSvcKey(info.service);
      /* уход из редактора в другой сервис: сбрасываем отложенное сохранение,
         чтобы последняя правка гарантированно легла в хранилище */
      if (info.service) {
        const st = (window as unknown as { __vetvi?: VetviStore }).__vetvi;
        try { st?.flushSave(); } catch { /* хранилище ещё не создано */ }
      }
      /* прямая ссылка на ноду (#project=<id>&node=<nid> или #room=<rid>&node=<nid>) */
      setNodeGoto(info.params.node || null);
      /* режим привязки нод к задаче (кнопка «привязать ноды» в задаче) */
      setAttachTask(info.params.attach ? { id: info.params.attach, title: info.params.at || '' } : null);
      /* пользователь вернулся в «Ветви» из сервиса — подсказки задач могли
         измениться (задачи создали/перенесли) */
      if (!info.service) {
        const st = (window as unknown as { __vetvi?: VetviStore }).__vetvi;
        try { st?.refreshTaskHints(true); } catch { /* ещё не готово */ }
      }
    };
    check();
    window.addEventListener('hashchange', check);
    return () => window.removeEventListener('hashchange', check);
  }, []);

  /* реестр/доступы сервисов изменились (push от vetvi-sync) — «Ветви» тоже
     сервис: пропали из списка → экран «нет доступа» БЕЗ перезагрузки */
  useEffect(() => {
    return onServicesChanged(() => {
      invalidateServicesCache();
      void fetchServices(true)
        .then((list) => setVetviBlocked(!list.some((s) => s.key === VETVI_SERVICE_KEY)))
        .catch(() => { /* сервер недоступен — прежнее состояние */ });
    });
  }, []);

  /* кто я: если авторизация включена и не залогинен — гейт входа/регистрации.
     При успехе личность аккаунта становится личностью редактора (имя/цвет
     в комнате больше не меняются произвольно). */
  useEffect(() => {
    let alive = true;
    const t0 = setTimeout(() => {
      void fetchAuthState()
        .then((st) => {
          if (!alive) return;
          authApplyState(st);
          setAuthPhase(st.authEnabled && !st.user ? 'gate' : 'ok');
          /* токен сессии появился — регистрируем служебный сокет сервисов
             (вход мог случиться уже после его подключения) */
          servicesLiveHello();
        })
        .catch(() => {
          if (alive) setAuthPhase('ok'); /* сервер недоступен — как раньше */
        });
    }, 0);
    return () => { alive = false; clearTimeout(t0); };
  }, []);

  /* доступ к «Ветвям»: сервис в списке разрешённых? Проверяем после входа
     и при каждом возврате из другого сервиса (админ мог закрыть доступ,
     пока пользователь был в другом приложении). Сбой сервера — как раньше. */
  useEffect(() => {
    if (authPhase !== 'ok') return;
    let alive = true;
    void fetchServices()
      .then((list) => {
        if (alive) setVetviBlocked(!list.some((s) => s.key === VETVI_SERVICE_KEY));
      })
      .catch(() => { if (alive) setVetviBlocked(false); });
    return () => { alive = false; };
  }, [authPhase, svcKey]);

  /* прогрев хранилища (idb) — сторонний сервис в прогреве не нуждается */
  useEffect(() => {
    if (booted || svcKey) return;
    let alive = true;
    void storeBoot().catch(() => { /* нет idb — стартуем с пустой памятью */ }).finally(() => {
      if (alive) {
        (window as unknown as { __bootDebug?: string }).__bootDebug = 'booted-at-' + Date.now();
        setBooted(true);
      }
    });
    return () => { alive = false; };
  }, [booted, svcKey]);

  if (adminHash) return <AdminPanel />;
  if (authPhase === 'gate') return <AuthGate onPass={() => setAuthPhase('ok')} />;
  /* сторонний сервис: авторизация уже решена (или выключена) — экран сервиса
     вместо редактора; хранилище редактора не греем и не монтируем */
  if (svcKey && authPhase !== 'loading') return <ServiceScreen svcKey={svcKey} />;
  if (!booted) return <main className="rn-app" aria-label="Ветви — React-редактор" />;
  /* authPhase 'loading': ждём /api/auth/state — токен сессии и личность аккаунта
     должны быть применены ДО первого входа в комнату. Раньше соединение с комнатой
     стартовало параллельно с запросом: join уходил без токена, сервер отвечал
     «гость» и сетевые проекты открывались «только чтение». */
  if (authPhase === 'loading') return <main className="rn-app" aria-label="Ветви — React-редактор" />;
  /* «Ветви» запрещены пользователю админом — вместо редактора экран «нет доступа» */
  if (vetviBlocked) return <ServiceScreen svcKey={VETVI_SERVICE_KEY} />;
  return <VetviAppInner nodeGoto={nodeGoto} attachTask={attachTask} />;
}

function VetviAppInner({ nodeGoto, attachTask }: { nodeGoto: string | null; attachTask: { id: string; title: string } | null }) {
  const store = useMemo(() => getStore(), []);
  /* Каналы doc+ui: геометрические кадры (жесты холста) не перерисовывают корень —
     их подхватывает сам CanvasBoard своей подпиской, панели/модалки не трогаются. */
  useStoreRev(store, 'doc');
  useStoreRev(store, 'ui');
  const mounted = useMounted();

  /* личные хоткеи + проект из хеша (#project=<id>) + realtime-клиент */
  useEffect(() => {
    hkLoad();
    store.applyHashProject();
    store.applyLockState();
    store.setPlayerStart(null, false);
    (window as unknown as { __vetvi?: VetviStore }).__vetvi = store;
    bindLogHelpers((_e, nid) => {
      const n = store.nodeById(nid);
      return n ? (n.title || '') : null;
    });
    /* realtime-коллаборация: rooms/live/локи/копии/merge (этап 3) */
    if (!store.sync) {
      store.setSyncClient(new SyncClient(store));
      store.sync!.init();
    }
    /* свой проект с комнатой — тихо переподключиться после перезагрузки (projInitStartup) */
    store.bootReconnectRoom();
    /* свежие имена проектов в комнатах: соавторы могли переименовать их, пока
       страница была закрыта (названия в списке проектов актуальны сразу) */
    store.refreshRoomNames();
    /* иконки задач над нодами: первый сбор + опрос + при возврате на вкладку */
    store.startTaskHints();
    /* прямая ссылка на ноду (из менеджера задач): открыть проект (в т.ч. чужой —
       по roomId), центрировать ноду и подсветить выделением */
    if (nodeGoto) {
      store.gotoNodeFromHash(nodeGoto);
      try { window.history.replaceState(null, '', window.location.pathname + window.location.search); } catch { /* нет history */ }
    }
    /* режим привязки нод к задаче (из менеджера задач): баннер + выбор нод.
       attachTask в зависимостях: хеш могли поставить и без перемонтирования
       (Ветви уже открыты) — эффект обязан перезапуститься. */
    if (attachTask) store.startAttach(attachTask.id, attachTask.title);
  }, [store, attachTask]);

  /* попап участников закрывается кликом мимо (capture, как bindSyncUI оригинала) */
  useEffect(() => {
    if (!store.collabPop) return;
    const onDoc = (e: Event) => {
      const t = e.target as Element | null;
      if (!t) return;
      if (t.closest('.collab-pop')) return;
      /* составная кнопка «Поделиться+онлайн»: клик по статусу (правая половина)
         переключает попап сам — закрывать его здесь нельзя, иначе повторный
         клик по кнопке снова откроет попап (toggle всегда true) */
      if (t.closest('.share-split')) return;
      store.setCollabPop(false);
    };
    document.addEventListener('pointerdown', onDoc, true);
    return () => document.removeEventListener('pointerdown', onDoc, true);
  }, [store, store.collabPop]);

  /* soft-lock редактируемого объекта: фокус в поле инспектора/модалки/редактора
     диалога — editStart (2188 оригинала), уход фокуса — editEnd (2199).
     Делегировано, как BINDS editStart/editEnd на полях инспектора оригинала. */
  useEffect(() => {
    const isEditable = (t: EventTarget | null): boolean => {
      const el = t as HTMLElement | null;
      if (!el || !el.isConnected) return false;
      return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || !!el.isContentEditable;
    };
    const inEditorArea = (el: HTMLElement): boolean =>
      !!(el.closest('#insp') || el.closest('#modalWrap') || el.closest('#dlgModal') || el.closest('#noteModal') || el.closest('.v-edit'));
    const onFocusIn = (e: FocusEvent) => {
      if (!isEditable(e.target)) return;
      const el = e.target as HTMLElement;
      if (!inEditorArea(el)) return;
      /* только чтение: поля правки ПРОЕКТА (инспектор, диалог, заметки) не получают
         фокус; модалки (#modalWrap — пароль комнаты, ссылка, поиск) остаются доступны */
      if (store.viewOnly && (el.closest('#insp') || el.closest('#dlgModal') || el.closest('#noteModal') || el.closest('.v-edit'))) {
        el.blur();
        store.denyEdit();
        return;
      }
      store.editSoftLock();
    };
    const onFocusOut = (e: FocusEvent) => {
      if (!isEditable(e.target)) return;
      const el = e.target as HTMLElement;
      if (!inEditorArea(el)) return;
      store.editSoftUnlock();
    };
    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('focusout', onFocusOut);
    return () => {
      document.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('focusout', onFocusOut);
    };
  }, [store]);

  /* ── диспетчер горячих клавиш (цепочка условий оригинала) ── */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      /* модалки заметок: Esc закрывает первой — capture-обработчик оригинала (13531) */
      if (e.key === 'Escape' && noteModalOpen()) {
        e.preventDefault();
        noteBus.closeAll();
        return;
      }
      const t = e.target as HTMLElement | null;
      const typing = !!t && t.isConnected && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
      const modal = store.modal;
      const dlgOpen = !!store.dialogEdit;
      const playerOpen = modal === 'player';
      const patchOpen = modal === 'patch';
      const searchOpen = modal === 'search';

      /* экран пароля запертого проекта/ввод пароля комнаты — хоткеи глушим */
      if (store.lockNeeded()) return;

      if (playerOpen) return; // Player слушает сам

      if (patchOpen) {
        if (e.key === 'Escape' || hkIs(e, 'patchnotes')) {
          e.preventDefault();
          store.closeModal();
        }
        return;
      }
      if (searchOpen) {
        if (e.key === 'Escape' || hkIs(e, 'search')) {
          e.preventDefault();
          store.closeModal();
        }
        return;
      }

      /* режим «нож» (Alt) и пан-модификаторы — CanvasBoard */

      if (typing) {
        /* в поле ввода глобальные Mod-сочетания работают всегда */
        if (hkIs(e, 'search')) { e.preventDefault(); store.openModal('search'); return; }
        if (hkIs(e, 'patchnotes')) { e.preventDefault(); store.openModal('patch'); return; }
        if (hkIs(e, 'save')) { e.preventDefault(); store.saveAs(); return; }
        if (hkIs(e, 'saveAs')) { e.preventDefault(); store.saveAs(); return; }
        if (hkIs(e, 'projects')) { e.preventDefault(); store.openModal('projects'); return; }
        if (e.key === 'Escape') (document.activeElement as HTMLElement | null)?.blur();
        return;
      }

      if (hkIs(e, 'patchnotes')) { e.preventDefault(); store.openModal('patch'); return; }
      if (hkIs(e, 'search')) { e.preventDefault(); store.openModal('search'); return; }

      if (hkIs(e, 'rename')) {
        e.preventDefault();
        if (store.sel.size === 1) store.startRename([...store.sel][0]);
        return;
      }
      if (hkIs(e, 'undo')) { e.preventDefault(); store.undo(); return; }
      if (hkIs(e, 'redo')) { e.preventDefault(); store.redo(); return; }
      if (hkIs(e, 'saveAs')) { e.preventDefault(); store.saveAs(); return; }
      if (hkIs(e, 'save')) { e.preventDefault(); store.saveAs(); return; }
      if (hkIs(e, 'projects')) { e.preventDefault(); store.openModal('projects'); return; }
      if (hkIs(e, 'newProject')) { e.preventDefault(); store.createProject(); return; }
      if (hkIs(e, 'duplicate')) {
        e.preventDefault();
        const r = store.duplicateSelection();
        if (r) store.startCarry(r.ids, r.pre);
        return;
      }
      if (hkIs(e, 'exportSel')) { e.preventDefault(); if (store.sel.size) store.exportSelection(); else store.toast('Выделите ноды для экспорта', 'warn'); return; }
      if (hkIs(e, 'alignH')) { e.preventDefault(); store.alignH(); return; }
      if (hkIs(e, 'alignV')) { e.preventDefault(); store.alignV(); return; }
      if (hkIs(e, 'ungroup')) {
        e.preventDefault();
        const gid = [...store.selGroups][0] || ([...store.sel][0] ? store.nodeById([...store.sel][0])?.gid : null);
        if (gid) store.dissolveGroup(gid);
        else store.toast('Нет группы для роспуска', 'warn');
        return;
      }
      if (hkIs(e, 'group')) {
        e.preventDefault();
        if (store.sel.size + store.selGroups.size >= 2) store.openModal('groupCreate');
        else store.toast('Выделите минимум два объекта (или нарисуйте группу: Ctrl+Shift+ЛКМ)', 'warn');
        return;
      }
      if (hkIs(e, 'selectAll')) { e.preventDefault(); store.selectAll(); return; }
      if (hkIs(e, 'deleteSel')) { e.preventDefault(); store.deleteSelected(); return; }

      if (e.key === 'Escape') {
        if (store.carry) { store.cancelCarry(); return; }
        if (dlgOpen) { store.commitReplyEdit(null); store.closeDialogEditor(); return; }
        if (store.confirm) { store.closeConfirm(); return; }
        if (store.ctx) { store.closeCtx(); return; }
        if (modal && modal !== 'player') { store.closeModal(); return; }
        store.clearSelection();
        return;
      }

      if (hkIs(e, 'centerSel')) {
        if (store.sel.size === 1) store.requestCenter([...store.sel][0]);
        return;
      }
      if (hkIs(e, 'play')) {
        e.preventDefault();
        const pn = store.pointerNodeId();
        store.setPlayerStart(pn, false);
        store.openModal('player');
        return;
      }
      if (hkIs(e, 'playNode')) {
        e.preventDefault();
        const pn = store.pointerNodeId();
        if (!pn) {
          store.toast('Наведите курсор на ноду или выделите одну ноду — и её можно проиграть отдельно', 'warn');
          return;
        }
        store.setPlayerStart(pn, true);
        store.openModal('player');
        return;
      }
      if (hkIs(e, 'fitView')) {
        e.preventDefault();
        const api = canvasApi.current;
        const r = api ? api.getRect() : null;
        if (r && api) store.fitView(r.width, r.height, api.sizes);
        return;
      }
      if (hkIs(e, 'zoomIn') || hkIs(e, 'zoomOut')) {
        e.preventDefault();
        const api = canvasApi.current;
        const r = api ? api.getRect() : null;
        if (r) store.zoomAt(r.width / 2, r.height / 2, hkIs(e, 'zoomIn') ? 1.15 : 1 / 1.15);
        return;
      }
    };
    window.addEventListener('keydown', onKey);
    /* pagehide раньше вешался в page.tsx на getStore() при монтировании — теперь
       здесь, после прогрева хранилища: сохранение при уходе со страницы/bfcache */
    const pageHide = () => store.flushSave();
    const beforeUnload = () => store.flushSave();
    window.addEventListener('beforeunload', beforeUnload);
    window.addEventListener('pagehide', pageHide);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('beforeunload', beforeUnload);
      window.removeEventListener('pagehide', pageHide);
    };
  }, [store]);

  if (!mounted) {
    return <main className="rn-app" aria-label="Ветви — React-редактор" />;
  }

  return (
    <main className="rn-app" aria-label="Ветви — React-редактор">
      <TopBar store={store} />
      <div id="layout">
        <LeftPane store={store} />
        <section id="stage">
          <CanvasBoard store={store} />
        </section>
        <Inspector store={store} onClose={() => store.clearSelection()} />
      </div>
      <footer id="status" role="contentinfo">
        <div className="st-left">
          <span id="stFile">{store.doc.meta?.name || 'Без названия'}</span>
          <span id="stDirty" className={store.saveState === 'pending' ? 'show' : undefined} />
          <a className="st-classic" href="/vetvi/index.html" target="_blank" rel="noreferrer" title="Классическая версия в одном файле">Классическая версия</a>
          {/* версия приложения: клик открывает «Что нового» (патчноут переехал из шапки) */}
          <button
            type="button"
            className="st-ver"
            title={'Версия ' + APP_VERSION + ' — что нового'}
            aria-label={'Версия приложения ' + APP_VERSION + ' — открыть список обновлений'}
            onClick={() => store.openModal('patch')}
          >
            v{APP_VERSION}
          </button>
        </div>
        <div className="spacer" />
        <div className="st-right">
          <span id="stCounts">
            узлов: {store.doc.nodes.length} · связей: {store.doc.edges.length} · групп: {store.doc.groups.length}
          </span>
          <EditTipHost store={store} />
        </div>
      </footer>

      <NoteModals store={store} />
      <DialogModal store={store} />
      <ModalHost store={store} />
      <ConfirmHost store={store} />
      {store.modal === 'player' && <Player store={store} />}
      {!!store.dstState.ids && <DstWin store={store} />}
      <CtxMenuHost store={store} />
      <ToastHost store={store} />
      <CollabPopover store={store} />
      {store.attachTask && <AttachBar store={store} />}
      <LockTipHost store={store} />
      <LockScreen store={store} />
      {/* подсказки сочетаний на кнопках обновляет hkText при рендере */}
      <span hidden data-hk-play={hkText('play')} />
    </main>
  );
}

/* ── баннер режима привязки нод к задаче менеджера задач ──
   Задача нажала «+ привязать ноды из „Ветвей"» → «Ветви» открылись с
   #attach=<taskId>: здесь пользователь выделяет ноды (клик/рамка) и
   подтверждает — сервер дописывает связи, возврат в менеджер задач
   открывает ту же задачу (#service=task-manager&ot=…). */

function AttachBar({ store }: { store: VetviStore }) {
  void store.revision;
  const at = store.attachTask;
  if (!at) return null;
  const n = store.sel.size;
  return (
    <div className="tm-attachbar" role="toolbar" aria-label="Привязка нод к задаче">
      <span className="tm-attachbar-cap">
        <VetviMarkInline />
        Привязка нод к задаче{at.title ? <> «{at.title.slice(0, 44)}»</> : ''}
      </span>
      <span className="tm-attachbar-n">{n ? 'выделено: ' + n : 'выделите ноды кликом или рамкой'}</span>
      <span className="spacer" />
      <button
        type="button"
        className="btn"
        onClick={() => store.cancelAttach()}
        disabled={store.attachBusy}
      >
        Отмена
      </button>
      <button
        type="button"
        className="btn primary"
        onClick={() => void store.confirmAttach()}
        disabled={!n || store.attachBusy}
        title="Привязать выделенные ноды к задаче"
      >
        {store.attachBusy ? 'Привязываю…' : n ? 'Привязать (' + n + ')' : 'Привязать'}
      </button>
    </div>
  );
}

function VetviMarkInline() {
  return (
    <svg viewBox="0 0 24 24" width={13} height={13} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M7.5 12h3c3.2 0 2.4-6.5 6-6.5M10.5 12c3.2 0 2.4 6.5 6 6.5" />
      <circle cx="5.5" cy="12" r="1.6" fill="currentColor" stroke="none" />
    </svg>
  );
}
