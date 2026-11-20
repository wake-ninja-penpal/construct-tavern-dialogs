'use client';

/**
 * Иконки колонок менеджера задач (как иконки команд в tmTypes/TeamIcon):
 * у дефолтных (системных) колонок иконка фиксированная — она задаёт статус
 * задач на нодах «Ветвей»; у обычных колонок иконку выбирают в меню колонки.
 */

export const TM_COLUMN_ICONS: { id: string; title: string }[] = [
  { id: 'columns', title: 'Колонки' },
  { id: 'inbox', title: 'Входящие' },
  { id: 'progress', title: 'В работе' },
  { id: 'done', title: 'Готово' },
  { id: 'circle', title: 'Круг' },
  { id: 'clock', title: 'Время' },
  { id: 'star', title: 'Звезда' },
  { id: 'flag', title: 'Флаг' },
  { id: 'flame', title: 'Срочно' },
  { id: 'bug', title: 'Баг' },
  { id: 'bulb', title: 'Идея' },
  { id: 'rocket', title: 'Спринт' },
  { id: 'wrench', title: 'Работы' },
  { id: 'archive', title: 'Архив' },
  { id: 'search', title: 'Поиск' },
  { id: 'palette', title: 'Творчество' },
];

const PATHS: Record<string, string> = {
  columns: 'M4 4h6.5v16H4zM13.5 4H20v10h-6.5z',
  inbox: 'M4 6h16v12H4zM4 13h5l2 3h2l2-3h5',
  progress: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  done: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM8.5 12.5l2.5 2.5 4.5-5',
  circle: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 7v5l3.5 2',
  star: 'M12 3l2.7 5.8 6.3.8-4.6 4.3 1.2 6.1L12 17l-5.6 3 1.2-6.1L3 9.6l6.3-.8z',
  flag: 'M6 21V4h11l-2.5 4L17 12H6',
  flame: 'M12 21c4 0 7-2.5 7-6.5C19 10 12 3 12 3S5 10 5 14.5C5 18.5 8 21 12 21zM12 17a2.5 2.5 0 0 0 2.5-2.5c0-1.5-2.5-4-2.5-4s-2.5 2.5-2.5 4A2.5 2.5 0 0 0 12 17z',
  bug: 'M12 20a6 6 0 0 0 6-6v-3H6v3a6 6 0 0 0 6 6zM9 8a3 3 0 0 1 6 0v3H9zM4 11h2M18 11h2M4 15h2M18 15h2M12 20v-6',
  bulb: 'M9.5 18h5M10 21h4M12 3a6.5 6.5 0 0 1 4 11.5c-.7.6-1 1.4-1 2.5h-6c0-1.1-.3-1.9-1-2.5A6.5 6.5 0 0 1 12 3z',
  rocket: 'M5 15c-1.5 1.5-2 5-2 5s3.5-.5 5-2M14 4c3 0 6 3 6 6l-8.5 8.5c-.5.5-8.5-7.5-8-8zM15 9h.01',
  wrench: 'M14.5 6.5a4 4 0 0 0-5.6 5L4 16.4V20h3.6l4.9-4.9a4 4 0 0 0 5-5.6L14.6 12l-2.6-2.6z',
  archive: 'M4 4h16v4H4zM6 8v12h12V8M10 12h4',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-3.5-3.5',
  palette: 'M12 21a9 9 0 1 1 9-9c0 2.5-2 4-4.5 4H15a2 2 0 0 0-1.5 3.3c.3.4.5.7.5 1.2 0 .3-.5.5-2 .5zM7.5 11a1 1 0 1 0 0-2 1 1 0 0 0 0 2zM11 8a1 1 0 1 0 0-2 1 1 0 0 0 0 2zM15.5 9a1 1 0 1 0 0-2 1 1 0 0 0 0 2z',
};

export function ColumnIcon({ id, size = 14 }: { id: string; size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={PATHS[id] || PATHS.columns} />
    </svg>
  );
}
