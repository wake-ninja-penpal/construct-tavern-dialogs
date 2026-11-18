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
  notificationsFetch,
  notificationsRead,
  type NotificationItem,
} from './auth';
import { authLogout } from './auth';
import { getStore, type VetviStore } from './store';

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

const ROLE_LABEL: Record<string, string> = {
  owner: 'владелец',
  editor: 'редактор',
  reader: 'только чтение',
};

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

  const toastNtf = useCallback((n: { type?: string; payload?: Record<string, unknown> }) => {
    const st = getStore();
    const p = (n.payload || {}) as { projectName?: string };
    const nm = p.projectName ? ` «${p.projectName}»` : '';
    if (n.type === 'access_granted') st.toast(`Вам открыли доступ к проекту${nm}`, 'ok');
    else if (n.type === 'access_revoked') st.toast(`Доступ к проекту${nm} отозван`, 'warn');
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

  /** Открыть проект/комнату из уведомления. */
  const openItem = (n: NotificationItem) => {
    setOpen(false);
    void notificationsRead([n.id]);
    const p = n.payload || {};
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

  return { state, open, toggle, setOpen, refresh, openItem };
}

export function NotificationsPopover(props: {
  items: NotificationItem[];
  onOpenItem: (n: NotificationItem) => void;
  onClose: () => void;
}) {
  const { items, onOpenItem, onClose } = props;
  let popStyle: React.CSSProperties = { position: 'fixed', top: 52, right: 8 };
  if (typeof document !== 'undefined') {
    const anchor = document.querySelector('#bellBtn');
    if (anchor) {
      const r = anchor.getBoundingClientRect();
      popStyle = { position: 'fixed', top: r.bottom + 8, right: Math.max(8, window.innerWidth - r.right), left: 'auto' };
    }
  }
  return (
    <div
      id="ntfPop"
      className="collab-pop show ntf-pop"
      style={popStyle}
      role="dialog"
      aria-label="Уведомления"
    >
      <div className="cp-cap">Уведомления</div>
      {!items.length && (
        <div className="ntf-empty">Пока пусто — здесь появятся уведомления об открытых вам доступах</div>
      )}
      <div className="ntf-list">
        {items.map((n) => (
          <div key={n.id} className={'ntf-item' + (n.read ? '' : ' unread')}>
            <span className={'ntf-ico' + (n.type === 'access_revoked' ? ' rev' : '')}>
              {n.type === 'access_revoked' ? <IcExit /> : <IcShare />}
            </span>
            <div className="ntf-txt">
              {n.type === 'access_granted' && (
                <>
                  <b>
                    Вам открыли доступ к проекту
                    {n.payload.projectName ? <> «{n.payload.projectName}»</> : ''}
                  </b>
                  <i>{(n.payload.ownerName || n.payload.granterName || '') + ' · '}{ROLE_LABEL[n.payload.role || 'editor'] || 'доступ'} · {fmtNtfDate(n.createdAt)}</i>
                </>
              )}
              {n.type === 'access_revoked' && (
                <>
                  <b>
                    Доступ к проекту
                    {n.payload.projectName ? <> «{n.payload.projectName}»</> : ''} отозван
                  </b>
                  <i>{(n.payload.ownerName || '') + ' · '}{fmtNtfDate(n.createdAt)}</i>
                </>
              )}
              {!['access_granted', 'access_revoked'].includes(n.type) && (
                <>
                  <b>{String(n.type)}</b>
                  <i>{fmtNtfDate(n.createdAt)}</i>
                </>
              )}
            </div>
            {n.type === 'access_granted' && n.payload.roomId && (
              <button type="button" className="btn" onClick={() => onOpenItem(n)}>Открыть</button>
            )}
          </div>
        ))}
      </div>
      <div className="cp-acts">
        <button type="button" className="cp-act" onClick={onClose}><IcX />Закрыть</button>
      </div>
    </div>
  );
}

function fmtNtfDate(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString('ru-RU', { day: '2-digit', month: 'short' }) + ' ' +
      d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
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
function IcShare() {
  return (
    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="18" cy="5" r="2.6" />
      <circle cx="6" cy="12" r="2.6" />
      <circle cx="18" cy="19" r="2.6" />
      <path d="m8.4 13.4 7.2 4.2M15.6 6.4 8.4 10.6" />
    </svg>
  );
}
function IcX() {
  return (
    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true">
      <path d="M6 6l12 12M18 6 6 18" />
    </svg>
  );
}
