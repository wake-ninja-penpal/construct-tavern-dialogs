/**
 * Ветви — модель данных (ядро).
 *
 * Фреймворко-независимое ядро: здесь нет ни DOM, ни React — только типы
 * документа формата «Ветвей» (совместимо с классической версией /vetvi/index.html,
 * формат автосохранения vetvi-autosave-v17, serialize-версия 18).
 * Этот же набор типов в дальнейшем используется React Native-оболочкой.
 *
 * Принцип инкрементального порта: документ хранится «как есть» (pass-through) —
 * ядро типизирует и правит только известные поля, все прочие поля сервера
 * и будущих версий доезжают в сохранение без потерь.
 */

/** Реплика диалога (вложения образуют дерево через children). */
export interface VetviReply {
  id: string;
  speaker: string | null;
  text: string;
  children?: VetviReply[];
  [k: string]: unknown;
}

/** Исход развилки/действия: подпись + необязательное условие по переменной. */
export interface VetviOutcome {
  id: string;
  label: string;
  cond?: { vid: string; op: string; val: number | string } | null;
  [k: string]: unknown;
}

/** Данные диалоговой ноды. */
export interface VetviDialog {
  participants: string[];
  description: string;
  replies: VetviReply[];
  [k: string]: unknown;
}

/** Универсальная нода холста. Известные поля типизированы, остальное — pass-through. */
export interface VetviNode {
  id: string;
  type: string;
  gid: string | null;
  x: number;
  y: number;
  title: string;
  text: string;
  status: string;
  tags: string[];
  expand: number;
  color: string | null;
  tint: number;
  dlgWidth: number | null;
  dialog?: VetviDialog;
  outcomes?: VetviOutcome[];
  notes?: unknown[];
  varMode?: string;
  varOp?: string;
  varVal?: unknown;
  vid?: string | null;
  linear?: boolean;
  actions?: unknown[];
  [k: string]: unknown;
}

/** Связь между нодами (или из реплики/исхода). */
export interface VetviEdge {
  id: string;
  from: string;
  to: string;
  label?: string | null;
  kind?: string;
  pts?: { x: number; y: number }[];
  fromReply?: string | null;
  fromOut?: string | null;
  lt?: number;
  lp?: number;
  bd?: { dl: number; dy: number; dr: number };
  tin?: string;
  [k: string]: unknown;
}

/** Рамка/группа/цепочка на холсте. */
export interface VetviGroup {
  id: string;
  name: string;
  x: number;
  y: number;
  color?: string | null;
  tint?: number;
  stack?: boolean;
  parent?: string | null;
  fold?: number;
  alpha?: number;
  badge?: string | null;
  fx?: number;
  fy?: number;
  fw?: number;
  fh?: number;
  order?: string[];
  [k: string]: unknown;
}

/** Переменная проекта. */
export interface VetviVar {
  id: string;
  name: string;
  [k: string]: unknown;
}

/** Персонаж проекта (участник диалогов). */
export interface VetviChar {
  id: string;
  name: string;
  color?: string;
  [k: string]: unknown;
}

/** Метаданные проекта. */
export interface VetviMeta {
  name: string;
  created?: number;
  modified?: number;
  actionLog?: unknown[];
  editLog?: unknown[];
  lastEditBy?: unknown;
  [k: string]: unknown;
}

/** Документ проекта. Неизвестные поля сохраняются как есть. */
export interface VetviDoc {
  meta: VetviMeta;
  nodes: VetviNode[];
  edges: VetviEdge[];
  groups: VetviGroup[];
  vars?: VetviVar[];
  chars?: VetviChar[];
  customTypes?: unknown[];
  palette?: string[];
  listHidden?: Record<string, unknown>;
  [k: string]: unknown;
}

/** Видовое состояние: смещение и масштаб холста. */
export interface VetviViewport {
  x: number;
  y: number;
  z: number;
}

/** Обёртка автосохранения — как в классической версии ({project, vp, bend}). */
export interface VetviAutosave {
  project: VetviDoc;
  vp: VetviViewport;
  bend: string;
}

/** Измеренный размер карточки в мировых координатах (для якорей связей). */
export interface NodeSize {
  w: number;
  h: number;
}

/** Геометрия связи для отрисовки. */
export interface EdgeGeom {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  pts?: { x: number; y: number }[] | null;
  corners?: { x: number; y: number }[] | null;
  bend?: string;
}
