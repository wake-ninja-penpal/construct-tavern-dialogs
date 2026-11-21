'use client';

/**
 * ЕДИНАЯ система уведомлений всех сервисов (хаб).
 *
 * Один и тот же попап (collab-pop ntf-pop, дизайн «Ветвей») рисуется и в
 * «Ветвях», и в менеджере задач — тот же список, те же подписи всех типов
 * (доступы к проектам/сервисам, задачи, комментарии), те же иконки, даты,
 * подсветка непрочитанных и футер «Очистить список / Закрыть».
 *
 * Кнопка «Открыть» у пунктов, к которым есть переход:
 *  - payload.taskId — задача менеджера задач (в «Ветвях» — переход в сервис);
 *  - payload.roomId — комната «Ветвей» (в менеджере задач — переход в сервис);
 *  - payload.serviceKey (service_granted) — переход в открывшийся сервис.
 *
 * Навигация — через адресный хеш (см. hub.ts): #service=task-manager&ot=<id>
 * откроет дровер задачи, #openroom=<rid> — комнату «Ветвей» (VetviApp).
 */

/* ── типы ── */

export interface NtfItem {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  read: boolean;
  createdAt: string;
}

/** типы уведомлений «плохих» новостей — красная иконка и тост-предупреждение */
export const NTF_NEG_TYPES = ['access_revoked', 'service_denied', 'tm_service_denied'];

/* ── подписи ролей и типов (общие для всех сервисов) ── */

const ROLE_NTF: Record<string, string> = {
  owner: 'владелец',
  admin: 'администратор',
  editor: 'редактор',
  reader: 'только чтение',
  viewer: 'наблюдатель',
};

/** Подпись для ЛЮБОГО типа уведомления — общий колокольчик всех сервисов:
    доступы к проектам «Ветвей», доступы к сервисам и проектам ТМ, задачи,
    комментарии. Используется и попапом, и тостами менеджера задач. */
export function ntfText(n: NtfItem): { b: string; i: string } {
  const p = n.payload || {};
  const pn = p.projectName ? ' «' + String(p.projectName) + '»' : '';
  const sn = p.serviceName ? ' «' + String(p.serviceName) + '»' : '';
  const tn = p.taskTitle ? ' «' + String(p.taskTitle).slice(0, 46) + '»' : '';
  const by = p.byName ? String(p.byName) : p.granterName ? String(p.granterName) : '';
  const when = fmtNtfDate(n.createdAt);
  switch (n.type) {
    case 'task_assigned': return { b: 'Вам назначили задачу' + tn, i: (by ? by + ' · ' : '') + when };
    case 'task_comment': return { b: 'Комментарий к задаче' + tn, i: ((p.preview ? String(p.preview).slice(0, 70) + ' · ' : '') + (by ? by + ' · ' : '') + when) };
    case 'access_granted': return { b: 'Вам открыли доступ к проекту' + pn, i: (by ? by + ' · ' : '') + (ROLE_NTF[p.role as string] || 'доступ') + ' · ' + when };
    case 'access_revoked': return { b: 'Доступ к проекту' + pn + ' отозван', i: (by ? by + ' · ' : '') + when };
    case 'service_granted': return { b: 'Доступ к сервису' + sn + ' открыт', i: 'Администратор · сервис появится в меню «Сервисы» · ' + when };
    case 'service_denied': return { b: 'Доступ к сервису' + sn + ' закрыт', i: 'Администратор · сервис пропал из меню «Сервисы» · ' + when };
    case 'tm_service_denied': return { b: 'Доступ к менеджеру задач закрыт', i: (by ? by + ' · ' : '') + when };
    case 'tm_access_granted': return { b: 'Вам открыли доступ к проекту' + pn + ' в менеджере задач', i: (by ? by + ' · ' : '') + (ROLE_NTF[p.role as string] || 'доступ') + ' · ' + when };
    default: {
      const human = String(n.type || '')
        .replace(/[_.]/g, ' ')
        .replace(/^tm\s/, '')
        .trim();
      return { b: human ? human.charAt(0).toUpperCase() + human.slice(1) : 'Уведомление', i: when };
    }
  }
}

/** Есть ли у уведомления переход («Открыть»): задача, комната или сервис. */
export function ntfOpenable(n: NtfItem): boolean {
  const p = n.payload || {};
  return !!(p.taskId || p.roomId || (n.type === 'service_granted' && p.serviceKey));
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

/* ── попап уведомлений ── */

export function NotificationsPopover(props: {
  items: NtfItem[];
  onOpenItem: (n: NtfItem) => void;
  onClose: () => void;
  onClear?: () => void;
}) {
  const { items, onOpenItem, onClose, onClear } = props;
  /* позиция — под колокольчиком (якорь ищется в DOM по id).
     Узкие экраны (мобильная версия): попап НЕ вылезает за левый край —
     правый край держится под колокольчиком, но левый край не левее 8px,
     а ширина не больше «экран − 16px» (колокольчик мог встать не у края). */
  let popStyle: React.CSSProperties = { position: 'fixed', top: 52, right: 8, maxWidth: 'calc(100vw - 16px)' };
  if (typeof document !== 'undefined') {
    const anchor = document.querySelector('#bellBtn');
    if (anchor) {
      const r = anchor.getBoundingClientRect();
      const W = window.innerWidth;
      let right = Math.max(8, W - r.right);
      /* левый край попапа = W − right − ширина(≤340): держим его ≥ 8px */
      if (right > W - 348) right = Math.max(8, W - 348);
      popStyle = { position: 'fixed', top: r.bottom + 8, right, left: 'auto', maxWidth: Math.min(340, W - 16) };
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
        <div className="ntf-empty">Пока пусто — здесь появляются уведомления всех сервисов: доступы, задачи и комментарии</div>
      )}
      <div className="ntf-list">
        {items.map((n) => {
          const t = ntfText(n);
          const neg = NTF_NEG_TYPES.includes(n.type);
          return (
            <div key={n.id} className={'ntf-item' + (n.read ? '' : ' unread')}>
              <span className={'ntf-ico' + (neg ? ' rev' : '')}>
                {n.type === 'access_revoked' || n.type === 'tm_service_denied' ? <IcExit /> : n.type === 'service_granted' || n.type === 'service_denied' ? <IcGrid /> : n.type === 'task_assigned' || n.type === 'task_comment' ? <IcTask /> : <IcShare />}
              </span>
              <div className="ntf-txt">
                <b>{t.b}</b>
                <i>{t.i}</i>
              </div>
              {ntfOpenable(n) && (
                <button type="button" className="btn" onClick={() => onOpenItem(n)}>Открыть</button>
              )}
            </div>
          );
        })}
      </div>
      <div className="cp-acts">
        {onClear && items.length > 0 && (
          <button type="button" className="cp-act ntf-clear" title="Удалить все уведомления" onClick={onClear}>
            <IcTrash />Очистить список
          </button>
        )}
        <button type="button" className="cp-act" onClick={onClose}><IcX />Закрыть</button>
      </div>
    </div>
  );
}

/* маленькие контурные иконки попапа (стиль SyncModals) */

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
function IcExit() {
  return (
    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <path d="m16 17 5-5-5-5" />
      <path d="M21 12H9" />
    </svg>
  );
}
function IcGrid() {
  return (
    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="4" y="4" width="6.6" height="6.6" rx="1.6" />
      <rect x="13.4" y="4" width="6.6" height="6.6" rx="1.6" />
      <rect x="4" y="13.4" width="6.6" height="6.6" rx="1.6" />
      <rect x="13.4" y="13.4" width="6.6" height="6.6" rx="1.6" />
    </svg>
  );
}
function IcTask() {
  return (
    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3.5" y="3.5" width="17" height="17" rx="4" />
      <path d="m8 12.2 2.7 2.7L16 9.5" />
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
function IcTrash() {
  return (
    <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 7h16M9 7V4h6v3M6.5 7l1 13h9l1-13M10 11v5M14 11v5" />
    </svg>
  );
}
