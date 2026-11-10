/**
 * TXT-экспорт «Ветвей» — точный порт функций vetvi33.html:
 *   wrapText, indent, dlgExportText, exportTXT
 *
 * Формат вывода совпадает с прототипом байт-в-байт:
 *   - строки-элементы массива L в конце соединяются '\r\n';
 *   - переносы ВНУТРИ перенесённого описания остаются '\n' (как в прототипе,
 *     где wrapText/indent возвращали многострочную строку одним элементом);
 *   - подчёркивания: '=' → clamp(длина имени,24,64) символов,
 *     '-' у заголовков секций → new Array(min(64, head.length+3)).join('-')
 *     (то есть на 1 дефис меньше аргумента), 'ГРУППЫ'/'КАРТА СВЯЗЕЙ' → 40 дефисов;
 *   - разделители метаданных '  ·  ' (два пробела), но в шапке ' · ' (один).
 *
 * Скачивание файла здесь не выполняется — стор делает Blob/download сам.
 */

import type {
  BaseTypeKey,
  CustomTypeRecord,
  DialogData,
  DialogReply,
  VetviEdge,
  VetviGroup,
  VetviNode,
} from './types'
import { KINDS_RU, STATUS_RU, FOLD_NAMES } from './types'

/** Максимальная глубина дерева реплик при экспорте диалога (порт MAX_DLG_DEPTH). */
export const MAX_DLG_DEPTH = 10

/** Ширина переноса описаний (порт вызова wrapText(...,62)). */
const WRAP_WIDTH = 62

/** Порядок базовых типов = порядок ключей объекта TYPES в прототипе. */
const BASE_TYPE_KEYS: readonly BaseTypeKey[] = [
  'scene',
  'char',
  'quest',
  'dialog',
  'skill',
  'branch',
  'event',
  'note',
]

/* ═══════════ Входные данные ═══════════ */

export interface TxtProject {
  metaName: string
  nodes: VetviNode[]
  edges: VetviEdge[]
  groups: VetviGroup[]
  customTypes: CustomTypeRecord[]
}

export interface TxtHelpers {
  /** Имя типа по ключу (базовые + кастомные). */
  typeName: (typeKey: string) => string
  /** Это базовый тип (не кастомный)? */
  isBaseType: (typeKey: string) => boolean
  /** Имя персонажа по id узла. */
  charName: (id: string | null) => string
  /** Группа узла (прямая). */
  groupOfNode: (n: VetviNode) => VetviGroup | null
  /** Прямые члены группы. */
  membersOf: (gid: string) => VetviNode[]
  /** Все узлы группы включая вложенные. */
  allDescNodes: (gid: string) => VetviNode[]
  /** Поиск реплики в дереве. */
  findReply: (replies: DialogReply[], id: string) => DialogReply | null
}

/* ═══════════ Внутренние утилиты (порт вспомогательных функций прототипа) ═══════════ */

/**
 * Порт wrapText(s,w): перенос по словам шириной w.
 * Абзацы разделяются '\n'; пустые абзацы сохраняются как пустые строки.
 */
function wrapText(s: string, w: number): string {
  const out: string[] = []
  String(s)
    .split('\n')
    .forEach((par) => {
      const words = par.split(/\s+/)
      let line = ''
      words.forEach((word) => {
        if (!word) return
        if ((line ? line + ' ' + word : word).length > w) {
          if (line) out.push(line)
          line = word
        } else {
          line = line ? line + ' ' + word : word
        }
      })
      out.push(line)
    })
  return out.join('\n')
}

/** Порт indent(s,pre): префикс для каждой строки. */
function indent(s: string, pre: string): string {
  return s
    .split('\n')
    .map((l) => pre + l)
    .join('\n')
}

/** Порт new Array(n).join('-') — даёт n-1 дефисов (так в прототипе). */
function dashes(n: number): string {
  return new Array<number>(n).join('-')
}

/** Порт nodeById: узел по id или null. */
function nodeById(project: TxtProject, id: string): VetviNode | null {
  for (const n of project.nodes) {
    if (n.id === id) return n
  }
  return null
}

/**
 * Порт countReplies: общее число реплик в дереве (с учётом детей).
 */
function countReplies(replies: DialogReply[]): number {
  let c = 0
  replies.forEach((r) => {
    c++
    if (r.children) c += countReplies(r.children)
  })
  return c
}

/**
 * Порт ensureDialog(n) без мутации: гарантированные данные диалога.
 */
function dialogOf(n: VetviNode): DialogData {
  const d = n.dialog
  return {
    participants: d && Array.isArray(d.participants) ? d.participants : [],
    description: d && typeof d.description === 'string' ? d.description : '',
    replies: d && Array.isArray(d.replies) ? d.replies : [],
  }
}

/* ═══════════ Порт dlgExportText ═══════════ */

/**
 * Блок строк одного диалогового узла (порт dlgExportText).
 * '◆ Диалог: …', метаданные, дерево реплик '▸' с исходами связей и
 * 'Исход (после диалога):' для основных исходящих связей.
 */
function dlgExportLines(n: VetviNode, project: TxtProject, helpers: TxtHelpers): string[] {
  const d = dialogOf(n)
  const L: string[] = []
  L.push('◆ Диалог: ' + n.title)
  let meta = 'Статус: ' + (STATUS_RU[n.status] || n.status)
  if (d.participants.length) meta += '  ·  Участники: ' + d.participants.map(helpers.charName).join(', ')
  meta += '  ·  Реплик: ' + countReplies(d.replies)
  L.push('  ' + meta)
  if (d.description) {
    L.push(
      '  ' +
        wrapText(d.description.trim(), WRAP_WIDTH)
          .split('\n')
          .map((l) => '  ' + l)
          .join('\n')
          .trim(),
    )
  }
  const printReplies = (replies: DialogReply[], depth: number): void => {
    if (depth >= MAX_DLG_DEPTH) return
    replies.forEach((r) => {
      let pad = '    '
      for (let i = 0; i < depth; i++) pad += '  '
      const name = helpers.charName(r.speaker)
      L.push(pad + '▸ ' + name + ': ' + (r.text || '(пусто)'))
      const outs = project.edges.filter((e) => e.from === n.id && e.fromReply === r.id)
      outs.forEach((e) => {
        const t = nodeById(project, e.to)
        L.push(pad + '     ' + (t ? t.title : '?') + (e.label ? ' [' + e.label + ']' : ''))
      })
      if (r.children && r.children.length) printReplies(r.children, depth + 1)
    })
  }
  printReplies(d.replies, 0)
  const mainOuts = project.edges.filter((e) => e.from === n.id && !e.fromReply)
  if (mainOuts.length) {
    L.push('  Исход (после диалога):')
    mainOuts.forEach((e) => {
      const t = nodeById(project, e.to)
      L.push('    → ' + (t ? t.title : '?') + (e.label ? ' [' + e.label + ']' : ''))
    })
  }
  return L
}

/* ═══════════ Порт exportTXT ═══════════ */

/** Возвращает полный текст экспорта (строки соединены '\r\n'). */
export function buildTxtExport(project: TxtProject, helpers: TxtHelpers): string {
  const L: string[] = []
  const title = (project.metaName || 'Проект').toUpperCase()
  L.push(title)
  L.push('='.repeat(Math.min(64, Math.max(title.length, 24))))
  L.push('Экспорт из инструмента «Ветви» · ' + new Date().toLocaleString('ru-RU'))
  L.push(
    'Узлов: ' +
      project.nodes.length +
      ' · Связей: ' +
      project.edges.length +
      ' · Групп: ' +
      project.groups.length,
  )

  /* Секции по типам: базовые в порядке TYPES, затем кастомные; пустые пропускаются. */
  let secNum = 0
  const typeKeys: string[] = [...BASE_TYPE_KEYS, ...project.customTypes.map((c) => c.id)]
  typeKeys.forEach((key) => {
    const nodes = project.nodes.filter((n) => n.type === key)
    if (!nodes.length) return
    secNum++
    const head =
      '[' +
      secNum +
      '] ' +
      helpers.typeName(key).toUpperCase() +
      (helpers.isBaseType(key) ? '' : ' (СВОЙ ТИП)') +
      ' — ' +
      nodes.length
    L.push('')
    L.push('')
    L.push(head)
    L.push(dashes(Math.min(64, head.length + 3)))
    nodes.forEach((n) => {
      L.push('')
      if (n.type === 'dialog') {
        dlgExportLines(n, project, helpers).forEach((line) => L.push(line))
      } else {
        L.push('◆ ' + n.title)
        let meta = 'Статус: ' + (STATUS_RU[n.status] || n.status)
        if (n.tags && n.tags.length) meta += '  ·  Теги: ' + n.tags.join(', ')
        if (n.color)
          meta +=
            '  ·  Цвет фона: ' + n.color + (n.tint ? ' (' + (n.tint > 0 ? '+' : '') + n.tint + '%)' : '')
        const gg = helpers.groupOfNode(n)
        if (gg) meta += '  ·  Группа: ' + gg.name
        L.push('  ' + meta)
        if (n.text) L.push(indent(wrapText(n.text.trim(), WRAP_WIDTH), '  '))
        else L.push('  (без описания)')
        const outs = project.edges.filter((e) => e.from === n.id && !e.fromReply)
        const ins = project.edges.filter((e) => e.to === n.id)
        if (outs.length || ins.length) {
          L.push('  Связи:')
          outs.forEach((e) => {
            const t = nodeById(project, e.to)
            L.push(
              '    → ' +
                (t ? t.title : '?') +
                (e.label ? '  [' + e.label + ']' : '') +
                '  (' +
                (KINDS_RU[e.kind] || 'обычная') +
                ')',
            )
          })
          if (ins.length) L.push('    ← входов: ' + ins.length)
        }
      }
    })
  })

  /* Секция групп: корневые группы, затем дети с отступом 3 пробела на уровень. */
  if (project.groups.length) {
    L.push('')
    L.push('')
    L.push('ГРУППЫ')
    L.push(dashes(41))
    const txtGroup = (g: VetviGroup, depth: number): void => {
      let padStr = ''
      for (let i = 0; i < depth; i++) padStr += '   '
      L.push(
        padStr +
          '■ ' +
          g.name +
          '  [' +
          (FOLD_NAMES[g.fold] || '') +
          (g.auto ? ', авторазмер' : '') +
          '] — узлов: ' +
          helpers.allDescNodes(g.id).length,
      )
      helpers.membersOf(g.id).forEach((n) => {
        L.push(padStr + '    · ' + n.title)
      })
      project.groups.forEach((cg) => {
        if (cg.parent === g.id) txtGroup(cg, depth + 1)
      })
    }
    project.groups.forEach((g) => {
      if (!g.parent) txtGroup(g, 0)
    })
  }

  /* Карта связей: все рёбра; для рёбер из реплик — 'Диалог / «текст реплики ≤30»'. */
  L.push('')
  L.push('')
  L.push('КАРТА СВЯЗЕЙ')
  L.push(dashes(41))
  if (!project.edges.length) L.push('(связей нет)')
  project.edges.forEach((e) => {
    const a = nodeById(project, e.from)
    const b = nodeById(project, e.to)
    let fromLabel = a ? a.title : '?'
    if (a && a.type === 'dialog' && e.fromReply) {
      const r = helpers.findReply(dialogOf(a).replies, e.fromReply)
      if (r) fromLabel = a.title + ' / «' + (r.text || '').slice(0, 30) + '»'
    }
    L.push(
      fromLabel +
        ' → ' +
        (b ? b.title : '?') +
        (e.label ? '  [' + e.label + ']' : '') +
        (e.pts && e.pts.length ? '  (изломов: ' + e.pts.length + ')' : ''),
    )
  })

  return L.join('\r\n')
}
