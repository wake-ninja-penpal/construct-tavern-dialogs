'use client';

/**
 * Хаб сервисов — иконки сервисов (контурный стиль иконок «Ветвей»).
 * Ключ иконки хранится в реестре (ServiceApp.icon), незнакомый ключ → сетка.
 */

export function ServiceIcon({ icon, size = 16 }: { icon: string; size?: number }) {
  const p = { width: size, height: size, fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
  switch (icon) {
    case 'vetvi':
      return (
        <svg viewBox="0 0 24 24" {...p} aria-hidden="true">
          <path d="M7.5 12h3c3.2 0 2.4-6.5 6-6.5M10.5 12c3.2 0 2.4 6.5 6 6.5" />
          <circle cx="5.5" cy="12" r="2.6" fill="currentColor" fillOpacity=".25" />
          <circle cx="18.5" cy="5.5" r="2.1" />
          <circle cx="18.5" cy="18.5" r="2.1" />
        </svg>
      );
    case 'sprite':
      return (
        <svg viewBox="0 0 24 24" {...p} aria-hidden="true">
          <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
          <circle cx="9" cy="10" r="1.8" />
          <path d="M4.5 17.5 9.8 13l3.4 3 2.6-2.4 3.7 3.4" />
        </svg>
      );
    case 'anim':
      return (
        <svg viewBox="0 0 24 24" {...p} aria-hidden="true">
          <rect x="3.5" y="5.5" width="17" height="13" rx="2.5" />
          <path d="M3.5 9.5h17M8 5.5v4M13 5.5v4M18 5.5v4" />
          <path d="M10.5 12.4v4.2l3.8-2.1z" fill="currentColor" stroke="none" />
        </svg>
      );
    case 'tasks':
      return (
        <svg viewBox="0 0 24 24" {...p} aria-hidden="true">
          <path d="M4.5 6.5 6 8l2.5-2.8" />
          <path d="M4.5 12.5 6 14l2.5-2.8" />
          <path d="M4.5 18.5 6 20l2.5-2.8" />
          <path d="M11.5 7h8M11.5 13h8M11.5 19h8" />
        </svg>
      );
    case 'lock':
      return (
        <svg viewBox="0 0 24 24" {...p} aria-hidden="true">
          <rect x="5" y="10.5" width="14" height="9.5" rx="2.5" />
          <path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" />
          <path d="M12 14.5v2" />
        </svg>
      );
    default:
      return (
        <svg viewBox="0 0 24 24" {...p} aria-hidden="true">
          <rect x="4" y="4" width="6.6" height="6.6" rx="1.6" />
          <rect x="13.4" y="4" width="6.6" height="6.6" rx="1.6" />
          <rect x="4" y="13.4" width="6.6" height="6.6" rx="1.6" />
          <rect x="13.4" y="13.4" width="6.6" height="6.6" rx="1.6" />
        </svg>
      );
  }
}

/** Иконка кнопки-переключателя сервисов (сетка + маленький курсор-уголок). */
export function ServicesGridIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3.5" y="3.5" width="7" height="7" rx="1.8" />
      <rect x="13.5" y="3.5" width="7" height="7" rx="1.8" />
      <rect x="3.5" y="13.5" width="7" height="7" rx="1.8" />
      <path d="M14 17.2h6M17 14.2v6" />
    </svg>
  );
}
