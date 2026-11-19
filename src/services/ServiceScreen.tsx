'use client';

/**
 * Хаб сервисов — экран стороннего сервиса (вместо редактора «Ветвей»).
 *
 * Пока остальные приложения (редактор спрайтов, аниматор, менеджер задач)
 * не перенесены, строка реестра ведёт сюда: аккуратная заглушка с шапкой,
 * переключателем сервисов и кнопкой возврата в «Ветви».
 *
 * Двух состояний:
 *  - «в разработке» — сервис разрешён, но прототип ещё не подключён;
 *  - «нет доступа» — админ запретил сервис пользователю или выключил его
 *    в реестре (по прямой ссылке #service=… тоже не пустить).
 *
 * Проверка доступа — по списку /api/services (перечитывается при монтировании):
 * запрет виден сразу после переключения/перезагрузки страницы.
 */

import { useEffect, useState } from 'react';

import {
  fetchServices,
  serviceMeta,
  setServiceHash,
  VETVI_SERVICE_KEY,
  type ServiceDTO,
} from './hub';
import { ServiceIcon } from './ServiceIcon';
import { ServiceSwitcher } from './ServiceSwitcher';
import { authLogout, avatarInitial, getAccount } from '@/vetvi/web/auth';

export function ServiceScreen({ svcKey }: { svcKey: string }) {
  /* результат проверки: { key, svc } — ключ в записи защищает от устаревших
     данных при переключении сервиса (смена svcKey перезапускает запрос,
     а данные прошлого запроса не показываются) */
  const [data, setData] = useState<{ key: string; svc: ServiceDTO | null; err: boolean } | null>(null);
  const current = data && data.key === svcKey ? data : null;

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

function AccountChip() {
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
