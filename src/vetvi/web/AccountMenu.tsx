'use client';

/**
 * Ветви — меню аккаунта и уведомления (кнопки в правом краю тулбара).
 *
 * Аватар (круг с первой буквой имени) заменяет старую кнопку «Настройки»:
 * клик открывает попап с данными аккаунта, кнопкой «Настройки» и «Выйти».
 * Колокольчик — уведомления сервера (открыли доступ к проекту и т.п.):
 * мгновенный push (vetvi:ntf через vetvi-sync) + опрос /api/notifications
 * раз в 15 секунд как страховка; клик по уведомлению открывает
 * полученный проект/комнату (store.openShared).
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { getMe } from '@/vetvi/core/identity';
import {
  avatarInitial,
  getAccount,
  notificationsClear,
  notificationsFetch,
  notificationsRead,
  type NotificationItem,
} from './auth';
import { authLogout } from './auth';
import { getStore, type VetviStore } from './store';
import { NotificationsPopover, ntfText } from '@/services/notifications';
import { goServiceByKey, goTaskOpen } from '@/services/hub';

/* ── попап аккаунта ── */

export function AccountPopover({ store, onClose }: { store: VetviStore; onClose: () => void }) {
  void store.revision;
  const me = getMe();
  const acc = getAccount();
  const [busy, setBusy] = useState(false);
  if (!store.accPop) return null;
  const logout = async () => {
    if (busy) return;
    setBusy(true);
    store.flushSave();
    try { await authLogout(); } catch { /* не критично */ }
    window.location.reload();
  };
  return (
    <div
      id="accPop"
      className="collab-pop show acc-pop"
      style={popUnder('#accBtn')}
      role="dialog"
      aria-label="Аккаунт"
    >
      <div className="acc-head">
        <span className="avatar-circle big" style={{ background: me.color }}>{avatarInitial(me.name)}</span>
        <div className="acc-head-txt">
          <b>{me.name}</b>
          <i>{acc ? '@' + acc.login : ''}</i>
        </div>
      </div>
      <div className="cp-acts" style={{ borderTop: '1px solid var(--line)' }}>
        <button type="button" className="cp-act" onClick={() => { store.setAccPop(false); store.openModal('account'); }}>
          <IcEdit /> Редактировать аккаунт
        </button>
        <button type="button" className="cp-act" onClick={() => { store.setAccPop(false); store.openModal('settings'); }}>
          <IcGear /> Настройки
        </button>
        <button type="button" className="cp-act acc-logout" disabled={busy} onClick={() => void logout()}>
          <IcExit />{busy ? 'Выходим…' : 'Выйти'}
        </button>
      </div>
    </div>
  );
}

/* ── уведомления ── */

interface NtfState {
  items: NotificationItem[];
  unread: number;
}

/** Хук: опрос уведомлений + push (vetvi:ntf) + состояние попапа. Используется в TopBar.
 *
 *  Доставка — два канала: мгновенный push от сервера (grant/revoke пушит
 *  уведомление через vetvi-sync во все вкладки аккаунта) и опрос раз в 15 с
 *  как страховка (sync перезапустили, сокет умер — уведомление всё равно
 *  появится). Сбой одного опроса (сеть/сервер) прежнее состояние НЕ стирает —
 *  точка непрочитанного не «мигает» и не пропадает. Новое непрочитанное —
 *  короткий тост (и от push, и от опроса, без дублирования). */
export function useNotifications(_store: VetviStore) {
  const [state, setState] = useState<NtfState>({ items: [], unread: 0 });
  const [open, setOpen] = useState(false);
  /* применяется только самый свежий ответ опроса (гонка interval/toggle) */
  const reqSeq = useRef(0);
  /* уже показанные в тосте уведомления — без дублей (push + poll) */
  const seenIds = useRef<Set<string>>(new Set());
  const firstLoad = useRef(true);

  const toastNtf = useCallback((n: { id?: string; type?: string; payload?: Record<string, unknown>; createdAt?: string }) => {
    const st = getStore();
    /* те же подписи, что в попапе (ntfText) — единые для всех сервисов:
       доступы, задачи, комментарии */
    if (n.type && n.createdAt !== undefined) {
      const t = ntfText({ id: n.id || '', type: n.type, payload: n.payload || {}, read: false, createdAt: n.createdAt });
      st.toast(t.b, ['access_revoked', 'service_denied', 'tm_service_denied'].includes(n.type) ? 'warn' : 'ok');
      return;
    }
    const p = (n.payload || {}) as { projectName?: string; serviceName?: string; taskTitle?: string };
    const nm = p.projectName ? ` «${p.projectName}»` : '';
    const sn = p.serviceName ? ` «${p.serviceName}»` : '';
    const tn = p.taskTitle ? ` «${p.taskTitle.slice(0, 46)}»` : '';
    if (n.type === 'access_granted') st.toast(`Вам открыли доступ к проекту${nm}`, 'ok');
    else if (n.type === 'access_revoked') st.toast(`Доступ к проекту${nm} отозван`, 'warn');
    else if (n.type === 'service_granted') st.toast(`Доступ к сервису${sn} открыт`, 'ok');
    else if (n.type === 'service_denied') st.toast(`Доступ к сервису${sn} закрыт`, 'warn');
    else if (n.type === 'task_assigned') st.toast(`Вам назначили задачу${tn}`, 'ok');
    else if (n.type === 'task_comment') st.toast(`Новый комментарий к задаче${tn}`, 'ok');
    else st.toast('Новое уведомление — откройте колокольчик', 'ok');
  }, []);

  const refresh = useCallback(async (markRead = false) => {
    const seq = ++reqSeq.current;
    const r = await notificationsFetch();
    if (seq !== reqSeq.current) return; /* устаревший ответ — есть более свежий */
    if (!r.ok) return; /* сбой опроса — прежнее состояние сохраняется */
    if (!firstLoad.current) {
      for (const n of r.items) {
        if (!n.read && !seenIds.current.has(n.id)) toastNtf(n);
      }
    }
    firstLoad.current = false;
    for (const n of r.items) seenIds.current.add(n.id);
    setState({ items: r.items, unread: r.unread });
    if (markRead && r.unread > 0) {
      void notificationsRead();
      setState({ items: r.items.map((x) => ({ ...x, read: true })), unread: 0 });
    }
  }, [toastNtf]);

  useEffect(() => {
    /* первый опрос — вне синхронного тела эффекта (async fetch + setState) */
    const t0 = setTimeout(() => { void refresh(); }, 0);
    const t = setInterval(() => { void refresh(); }, 15000);
    /* мгновенный канал: push после grant/revoke — тост + обновление точки.
       sync-клиент создаётся в эффекте VetviApp ПОСЛЕ эффектов детей (TopBar —
       ребёнок), поэтому при монтировании store.sync ещё null — пробуем
       зарегистрироваться, пока клиент не появится (короткий ретрай-цикл). */
    const listener = (n: { id?: string; type?: string; payload?: Record<string, unknown> }) => {
      if (n && n.id && seenIds.current.has(n.id)) { void refresh(); return; }
      if (n) {
        if (n.id) seenIds.current.add(n.id);
        toastNtf(n);
      }
      void refresh();
    };
    let regT: ReturnType<typeof setTimeout> | null = null;
    let registered = false;
    const tryRegister = (attempt: number) => {
      const st = getStore();
      if (st.sync) {
        st.sync.setNtfListener(listener);
        registered = true;
        return;
      }
      if (attempt < 60) regT = setTimeout(() => tryRegister(attempt + 1), 250);
    };
    tryRegister(0);
    return () => {
      clearTimeout(t0);
      clearInterval(t);
      if (regT) clearTimeout(regT);
      if (registered) getStore().sync?.setNtfListener(null);
    };
  }, [refresh, toastNtf]);

  const toggle = () => {
    const v = !open;
    setOpen(v);
    getStore().setAccPop(false);
    if (v) void refresh(true);
  };

  /** Полностью очистить список уведомлений (кнопка «Очистить список»). */
  const clearAll = useCallback(async () => {
    const ok = await notificationsClear();
    if (ok) {
      seenIds.current = new Set();
      setState({ items: [], unread: 0 });
      getStore().toast('Список уведомлений очищен', 'ok');
    } else {
      getStore().toast('Не удалось очистить уведомления', 'err');
    }
  }, []);

  /** Открыть сущность из уведомления (единый колокольчик): задача — переход
   *  в менеджер задач, комната — открыть здесь, сервис — перейти в него. */
  const openItem = (n: NotificationItem) => {
    setOpen(false);
    void notificationsRead([n.id]);
    const p = n.payload || {};
    if (p.taskId) {
      goTaskOpen(String(p.taskId));
      return;
    }
    if (n.type === 'service_granted' && p.serviceKey) {
      goServiceByKey(String(p.serviceKey));
      return;
    }
    const st = getStore();
    if (!p.roomId) { st.toast('В этом уведомлении нет комнаты', 'warn'); return; }
    if (!st.sync) return;
    st.openShared({
      roomId: String(p.roomId),
      projectId: p.projectId ? String(p.projectId) : null,
      projectName: p.projectName ? String(p.projectName) : null,
      role: (p.role as string) || 'editor',
    });
  };

  return { state, open, toggle, setOpen, refresh, openItem, clearAll };
}


/* позиционирование попапа под кнопкой-якорем */
function popUnder(selector: string): React.CSSProperties {
  if (typeof document !== 'undefined') {
    const anchor = document.querySelector(selector);
    if (anchor) {
      const r = anchor.getBoundingClientRect();
      return { position: 'fixed', top: r.bottom + 8, right: Math.max(8, window.innerWidth - r.right), left: 'auto' };
    }
  }
  return { position: 'fixed', top: 52, right: 8 };
}

/* маленькие контурные иконки (стиль SyncModals Ic) */
function IcGear() {
  return (
    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}
function IcExit() {
  return (
    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <path d="m16 17 5-5-5-5" />
      <path d="M21 12H9" />
    </svg>
  );
}
function IcEdit() {
  return (
    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m4 20 1-4L16.3 4.7a2.1 2.1 0 0 1 3 3L8 19z" />
      <path d="M14.5 6.5l3 3" />
    </svg>
  );
}