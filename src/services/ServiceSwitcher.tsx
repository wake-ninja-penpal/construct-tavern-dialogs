'use client';

/**
 * Хаб сервисов — переключатель приложений.
 *
 * Компактная кнопка с иконкой сетки: раскрывает попап со списком доступных
 * пользователю сервисов (разрешённые ему, включённые админом). Клик по строке
 * переключает приложение через адресный хеш (#service=<path>) — вход общий,
 * страница не перезагружается, «Ветви» возвращаются очисткой хеша.
 *
 * Список перечитывается при каждом открытии попапа: админ открыл/закрыл
 * доступ — переключатель покажет это без перезагрузки страницы.
 */

import { useCallback, useEffect, useState } from 'react';

import {
  fetchServices,
  setServiceHash,
  VETVI_SERVICE_KEY,
  type ServiceDTO,
} from './hub';
import { ServiceIcon, ServicesGridIcon } from './ServiceIcon';

interface Props {
  /** Ключ текущего сервиса (подсвечивается в списке). */
  current: string;
  /** id кнопки-якоря (позиция попапа считается по нему из DOM). */
  id?: string;
}

export function ServiceSwitcher({ current, id }: Props) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<ServiceDTO[] | null>(null);
  const [err, setErr] = useState(false);

  const load = useCallback(() => {
    setErr(false);
    void fetchServices(true)
      .then((list) => setItems(list))
      .catch(() => { setErr(true); setItems([]); });
  }, []);

  const toggle = useCallback(() => {
    setOpen((v) => {
      const next = !v;
      if (next) load();
      return next;
    });
  }, [load]);

  /* клик мимо закрывает попап (как у участников/уведомлений) */
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: Event) => {
      const t = e.target as Element | null;
      if (!t) return;
      if (t.closest('.svc-pop')) return;
      if (t.closest('#svcBtn')) return;
      setOpen(false);
    };
    document.addEventListener('pointerdown', onDoc, true);
    return () => document.removeEventListener('pointerdown', onDoc, true);
  }, [open]);

  /* Esc закрывает */
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open]);

  const go = (s: ServiceDTO) => {
    setOpen(false);
    if (s.key === current) return;
    setServiceHash(s);
  };

  /* позиция попапа — под кнопкой (fixed, как попапы аккаунта/уведомлений);
     якорь ищется в DOM по id — как в NotificationsPopover, без ref'ов в рендере */
  const anchorId = id || 'svcBtn';
  let popStyle: React.CSSProperties = { position: 'fixed', top: 52, left: 12, right: 'auto' };
  if (open && typeof document !== 'undefined') {
    const anchor = document.getElementById(anchorId);
    if (anchor) {
      const r = anchor.getBoundingClientRect();
      popStyle = { position: 'fixed', top: r.bottom + 8, left: Math.max(8, r.left), right: 'auto' };
    }
  }

  return (
    <>
      <button
        type="button"
        id={anchorId}
        className={'btn ibtn svc-btn' + (open ? ' on' : '')}
        title="Сервисы — переход между приложениями"
        aria-label="Сервисы"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={toggle}
      >
        <ServicesGridIcon />
      </button>

      <div
        className={'svc-pop' + (open ? ' show' : '')}
        style={open ? popStyle : undefined}
        role="menu"
        aria-label="Сервисы"
        aria-hidden={!open}
      >
        <div className="cp-cap">Сервисы</div>
        {!items && !err && (
          <div className="svc-empty">Загрузка списка…</div>
        )}
        {err && (
          <div className="svc-empty">Список недоступен — попробуйте ещё раз</div>
        )}
        {items && items.length === 0 && !err && (
          <div className="svc-empty">Доступных сервисов нет</div>
        )}
        {items && items.length > 0 && (
          <div className="svc-list" role="presentation">
            {items.map((s) => (
              <button
                key={s.key}
                type="button"
                role="menuitem"
                className={'svc-row' + (s.key === current ? ' cur' : '')}
                onClick={() => go(s)}
                title={s.key === current ? 'Открытый сейчас сервис' : s.description || s.name}
              >
                <span className="svc-ico"><ServiceIcon icon={s.icon} size={17} /></span>
                <span className="svc-txt">
                  <b>{s.name}</b>
                  <i>{s.key === current ? 'открыт сейчас' : (s.description || '')}</i>
                </span>
                {s.status !== 'ready' && <span className="svc-badge">скоро</span>}
                {s.key === current && <span className="svc-here">вы здесь</span>}
              </button>
            ))}
          </div>
        )}
        <div className="svc-foot">
          Одна учётная запись для всех сервисов
          {current !== VETVI_SERVICE_KEY && items?.some((s) => s.key === VETVI_SERVICE_KEY) && (
            <button type="button" className="svc-back" onClick={() => {
              const v = items!.find((x) => x.key === VETVI_SERVICE_KEY);
              if (v) go(v);
            }}>
              ← Ветви
            </button>
          )}
        </div>
      </div>
    </>
  );
}
