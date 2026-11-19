'use client';

/**
 * Хаб сервисов — экран стороннего сервиса (вместо редактора «Ветвей»).
 *
 * Приложение менеджера задач интегрировано: для task-manager со статусом
 * «ready» рендерится полноценный TaskManagerApp. Остальные строки реестра
 * (редактор спрайтов, аниматор) ведут на заглушку: «в разработке».
 *
 * Два состояния доступа:
 *  - «в разработке» — сервис разрешён, но прототип ещё не подключён;
 *  - «нет доступа» — админ запретил сервис пользователю или выключил его
 *    в реестре (по прямой ссылке #service=… тоже не пустить).
 *
 * Проверка доступа — по списку /api/services: при монтировании, по push
 * vetvi:services (см. live.ts — админ что-то изменил) и страховочным опросом.
 * Если пользователь находился в сервисе, который закрыли, — он ПРИНУДИТЕЛЬНО
 * выводится в любой доступный ему сервис (сначала «Ветви»), без перезагрузки;
 * сервер при этом ещё и не принимает его изменения (защита на API).
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import {
  fetchServices,
  invalidateServicesCache,
  onServicesChanged,
  serviceMeta,
  setServiceHash,
  VETVI_SERVICE_KEY,
  type ServiceDTO,
} from './hub';
import { ServiceIcon } from './ServiceIcon';
import { ServiceSwitcher } from './ServiceSwitcher';
import { TaskManagerApp } from './taskmanager/TaskManagerApp';
import { authLogout, avatarInitial, getAccount } from '@/vetvi/web/auth';

/** Куда выводить пользователя из закрытого сервиса: «Ветви» доступны — туда,
 *  иначе первый доступный сервис. null — доступного нет. */
function escapeTarget(list: ServiceDTO[]): ServiceDTO | null {
  const vetvi = list.find((s) => s.key === VETVI_SERVICE_KEY);
  if (vetvi) return vetvi;
  return list[0] || null;
}

export function ServiceScreen({ svcKey }: { svcKey: string }) {
  /* результат проверки: { key, svc } — ключ в записи защищает от устаревших
     данных при переключении сервиса (смена svcKey перезапускает запрос,
     а данные прошлого запроса не показываются) */
  const [data, setData] = useState<{ key: string; svc: ServiceDTO | null; err: boolean } | null>(null);
  const current = data && data.key === svcKey ? data : null;
  /* защита от повторного кика по тому же изменению */
  const kicking = useRef(false);

  const recheck = useCallback((kickFrom: string | null) => {
    return fetchServices(true)
      .then((list) => {
        setData({ key: kickFrom || svcKey, svc: list.find((s) => s.key === (kickFrom || svcKey)) || null, err: false });
        /* принудительный выход: мы в сервисе, которого больше нет в списке */
        if (kickFrom && !list.some((s) => s.key === kickFrom) && !kicking.current) {
          const target = escapeTarget(list);
          if (target) {
            kicking.current = true;
            setServiceHash(target);
            setTimeout(() => { kicking.current = false; }, 1500);
          }
        }
      })
      .catch(() => {
        if (!kickFrom) setData({ key: kickFrom || svcKey, svc: null, err: true });
      });
  }, [svcKey]);

  useEffect(() => {
    let alive = true;
    void fetchServices(true)
      .then((list) => {
        if (!alive) return;
        setData({ key: svcKey, svc: list.find((s) => s.key === svcKey) || null, err: false });
      })
      .catch(() => {
        if (!alive) return;
        /* сервер недоступен: fail-open как во всём приложении —
           показываем заглушку по статическим метаданным */
        setData({ key: svcKey, svc: null, err: true });
      });
    return () => { alive = false; };
  }, [svcKey]);

  /* realtime-сервисы: реестр/доступ изменились — перечитываем список.
     Если ТЕКУЩИЙ сервис исчез из разрешённых — кик в доступный сервис. */
  useEffect(() => {
    return onServicesChanged(() => {
      invalidateServicesCache();
      void recheck(svcKey);
    });
  }, [recheck, svcKey]);

  /* страховка: опрос раз в 30 с (push мог не дойти) — тоже с киком */
  useEffect(() => {
    const t = setInterval(() => { void recheck(svcKey); }, 30000);
    return () => clearInterval(t);
  }, [recheck, svcKey]);

  const meta = current && current.svc
    ? { name: current.svc.name, description: current.svc.description, icon: current.svc.icon }
    : serviceMeta(svcKey);
  const decided = !!current;
  const denied = decided && !current.err && !current.svc;
  const acc = getAccount();

  /* ── нет доступа ── */
  if (denied) {
    return (
      <main className="svc-screen" aria-label={'Нет доступа к сервису «' + meta.name + '»'}>
        <header className="svc-head">
          <div className="svc-head-brand">
            <ServiceSwitcher current={svcKey} />
            <span className="svc-head-name">{meta.name}</span>
          </div>
          <div className="svc-head-right">{acc && <AccountChip />}</div>
        </header>
        <div className="svc-hero">
          <span className="svc-ico-big lock"><ServiceIcon icon="lock" size={34} /></span>
          <h1 className="svc-title">Нет доступа к сервису «{meta.name}»</h1>
          <p className="svc-desc">
            Администратор закрыл вам доступ к этому сервису или выключил его.
            Если считаете, что это ошибка — обратитесь к администратору.
          </p>
          <div className="svc-actions">
            <button type="button" className="btn primary" onClick={() => setServiceHash({ key: VETVI_SERVICE_KEY, path: '' })}>
              ← Вернуться в «Ветви»
            </button>
          </div>
        </div>
      </main>
    );
  }

  /* ── менеджер задач: полноценное приложение (прототип интегрирован) ── */
  if (svcKey === 'task-manager' && current && !current.err && current.svc && current.svc.status === 'ready') {
    return <TaskManagerApp svcKey={svcKey} />;
  }

  /* ── заглушка сервиса ── */
  const isReady = current?.svc?.status === 'ready';
  const loadErr = !!current?.err;
  return (
    <main className="svc-screen" aria-label={'Сервис «' + meta.name + '»'}>
      <header className="svc-head">
        <div className="svc-head-brand">
          <ServiceSwitcher current={svcKey} />
          <span className="svc-head-ico"><ServiceIcon icon={meta.icon} size={18} /></span>
          <span className="svc-head-name">{meta.name}</span>
          {!isReady && <span className="svc-badge svc-badge-head">в разработке</span>}
        </div>
        <div className="svc-head-right">{acc && <AccountChip />}</div>
      </header>
      <div className="svc-body">
        <div className="svc-hero">
          <span className={'svc-ico-big' + (loadErr ? ' warn' : '')}><ServiceIcon icon={meta.icon} size={34} /></span>
          <h1 className="svc-title">{meta.name}</h1>
          {meta.description && <p className="svc-desc">{meta.description}</p>}
          <p className="svc-note">
            {loadErr
              ? 'Список сервисов сейчас недоступен, но сам сервис на месте — обновите страницу позже.'
              : isReady
                ? 'Сервис подключён — его интерфейс появится здесь после интеграции прототипа.'
                : 'Сервис подключён к вашей учётной записи, но пока находится в разработке. Прототип будет перенесён сюда позже — переключайтесь между приложениями через меню «Сервисы» в шапке.'}
          </p>
          <div className="svc-actions">
            <button type="button" className="btn primary" onClick={() => setServiceHash({ key: VETVI_SERVICE_KEY, path: '' })}>
              ← Ветви
            </button>
          </div>
        </div>
      </div>
      <footer className="svc-foot-line">
        <span>Единый аккаунт · хаб сервисов</span>
      </footer>
    </main>
  );
}

/* ── плашка аккаунта с выходом (для шапки сервисов) ── */

export function AccountChip() {
  const [busy, setBusy] = useState(false);
  const acc = getAccount();
  if (!acc) return null;
  const logout = async () => {
    if (busy) return;
    setBusy(true);
    try { await authLogout(); } catch { /* уже вышли */ }
    window.location.reload();
  };
  return (
    <div className="svc-acc" title={acc.displayName + ' (@' + acc.login + ')'}>
      <span className="avatar-circle" style={{ background: acc.color }}>{avatarInitial(acc.displayName)}</span>
      <span className="svc-acc-name">{acc.displayName}</span>
      <button type="button" className="svc-acc-out" disabled={busy} onClick={() => void logout()} title="Выйти из аккаунта (во всех сервисах)">
        {busy ? '…' : 'Выйти'}
      </button>
    </div>
  );
}
