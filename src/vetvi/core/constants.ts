/**
 * Ветви — константы ядра. Значения и палитра совпадают с классической версией,
 * чтобы React-редактор и /vetvi/index.html читали одни и те же документы.
 */

/** Ширина карточки ноды по умолчанию. */
export const NODE_W = 216;

/** Ширина карточки группы. */
export const GCARD_W = 200;

/** Ширина карточки цепочки (стек-карточки) — QCARD_W оригинала (строка 1365). */
export const QCARD_W = 300;

/** Шаг сетки и привязки. */
export const GRID = 26;

/** Ключ автосохранения в localStorage — общий с классической версией. */
export const LS_KEY = 'vetvi-autosave-v17';

/** Глубина истории undo/redo. */
export const HISTORY_LIMIT = 100;

/** Пауза автосохранения (мс) — как scheduleAutosave в классической версии. */
export const AUTOSAVE_MS = 700;

/** Пределы масштаба холста. */
export const ZOOM_MIN = 0.25;
export const ZOOM_MAX = 3;

/** Типы нод: ключ → название и базовый цвет (совпадает с TYPES оригинала). */
export const TYPES: Record<string, { name: string; color: string }> = {
  scene: { name: 'Сцена', color: '#e2a54e' },
  quest: { name: 'Квест', color: '#cf6d4f' },
  dialog: { name: 'Диалог', color: '#cbbd92' },
  skill: { name: 'Навык', color: '#7fb5a2' },
  action: { name: 'Действие', color: '#c9857a' },
  branch: { name: 'Развилка', color: '#d6c96a' },
  varnode: { name: 'Переменная', color: '#b7b26a' },
  event: { name: 'Событие', color: '#aab1bb' },
  note: { name: 'Заметка', color: '#8b929c' },
};

/** Статусы нод. */
export const STATUS_RU: Record<string, string> = {
  idea: 'идея',
  draft: 'в работе',
  done: 'готово',
};

/** Порядок статуса для цикла по клику. */
export const STATUS_CYCLE = ['idea', 'draft', 'done'];

/** Базовая палитра цветов (совпадает с PALETTE_COLORS оригинала). */
export const PALETTE_COLORS = [
  '#e2a54e', '#e0b46b', '#d0714e', '#cf6b5a', '#c9857a', '#d6c96a',
  '#b7b26a', '#9cb878', '#7fb5a2', '#cbbd92', '#aab1bb', '#8b929c',
];

/** Виды связей (подмножество; мост и условия — этап 2 порта). */
export const KIND_RU: Record<string, string> = {
  flow: 'обычная',
  choice: 'выбор',
  cond: 'условие',
  bridge: 'мост',
};

/** Типы нод, у которых главный выход — вниз правой грани. */
export const MAIN_BOTTOM_TYPES = ['dialog', 'action', 'branch'];
