'use client';

/**
 * Иконки инструментов Markdown-редактора (панель + контекстное меню).
 * Вынесены в отдельный модуль, чтобы TmMenu (контекстное меню описания)
 * и TaskDrawer (панель) использовали ОДИН набор — без циклического импорта
 * (TaskDrawer импортирует TmMenu, поэтому TmMenu не может импортировать
 * иконки из TaskDrawer).
 */

export function MdToolIcon({ id }: { id: string }) {
  const common = { width: 13, height: 13, fill: 'none' as const, stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true };
  switch (id) {
    case 'bold': return <svg viewBox="0 0 24 24" {...common}><path d="M7 5h6a3.5 3.5 0 1 1 0 7H7zM7 12h7a3.5 3.5 0 1 1 0 7H7z" /></svg>;
    case 'italic': return <svg viewBox="0 0 24 24" {...common}><path d="M14 5h-4M14 5l-4 14M10 19H6" /></svg>;
    case 'strike': return <svg viewBox="0 0 24 24" {...common}><path d="M5 12h14M8 8a4 4 0 0 1 8-.5M16 16a4 4 0 0 1-8 .5" /></svg>;
    case 'heading': return <svg viewBox="0 0 24 24" {...common}><path d="M6 5v14M16 5v14M6 12h10" /></svg>;
    case 'quote': return <svg viewBox="0 0 24 24" {...common}><path d="M6 17c0-4 1-7 4-10M12 17c0-4 1-7 4-10M4 17h6M10 17h6" /></svg>;
    case 'list': return <svg viewBox="0 0 24 24" {...common}><path d="M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01" /></svg>;
    case 'list-ol': return <svg viewBox="0 0 24 24" {...common}><path d="M10 6h10M10 12h10M10 18h10M4 6l1-1v4" /></svg>;
    case 'check-square': return <svg viewBox="0 0 24 24" {...common}><rect x="4" y="4" width="16" height="16" rx="2" /><path d="m8.5 12 2.5 2.5 5-5" /></svg>;
    case 'code': return <svg viewBox="0 0 24 24" {...common}><path d="M8 8l-4 4 4 4M16 8l4 4-4 4" /></svg>;
    case 'note': return <svg viewBox="0 0 24 24" {...common}><rect x="4" y="4" width="16" height="16" rx="2" /><path d="M8 9h8M8 13h5" /></svg>;
    case 'link': return <svg viewBox="0 0 24 24" {...common}><path d="M10 14a4 4 0 0 0 6 0l3-3a4 4 0 0 0-6-6l-1.5 1.5M14 10a4 4 0 0 0-6 0l-3 3a4 4 0 0 0 6 6L12.5 17.5" /></svg>;
    case 'image': return <svg viewBox="0 0 24 24" {...common}><rect x="3" y="5" width="18" height="14" rx="2" /><circle cx="8.5" cy="10" r="1.5" /><path d="m21 15-5-5-9 9" /></svg>;
    case 'table': return <svg viewBox="0 0 24 24" {...common}><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3 10h18M9 10v9M15 10v9" /></svg>;
    case 'minus': return <svg viewBox="0 0 24 24" {...common}><path d="M5 12h14" /></svg>;
    default: return <svg viewBox="0 0 24 24" {...common}><circle cx="12" cy="12" r="3" /></svg>;
  }
}
