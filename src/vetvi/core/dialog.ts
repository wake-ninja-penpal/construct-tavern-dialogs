/**
 * Ветви — дерево реплик диалога (порт ensureDialog/findReply/… оригинала, строки 1639–1712).
 */

import type { VetviReply } from './types';

export function findReply(replies: VetviReply[], id: string): VetviReply | null {
  for (const r of replies) {
    if (r.id === id) return r;
    if (r.children && r.children.length) {
      const f = findReply(r.children, id);
      if (f) return f;
    }
  }
  return null;
}

export function findReplyParent(replies: VetviReply[], id: string, parent: VetviReply | null): VetviReply | null {
  for (const r of replies) {
    if (r.id === id) return parent;
    if (r.children && r.children.length) {
      const f = findReplyParent(r.children, id, r);
      if (f !== null || r.children.some((c) => c.id === id)) return (f !== null ? f : r);
    }
  }
  return null;
}

export function lastReplyDeep(replies: VetviReply[]): VetviReply | null {
  if (!replies.length) return null;
  const last = replies[replies.length - 1];
  if (last.children && last.children.length) return lastReplyDeep(last.children);
  return last;
}

/** Автоспикер новой реплики: второй участник, не тот, кто говорил последним. */
export function nextReplySpeaker(reply: VetviReply | null, participants: string[]): string | null {
  const ps = participants.filter(Boolean);
  if (!ps.length) return null;
  if (ps.length === 1) return ps[0];
  const prev = reply ? reply.speaker : null;
  const others = ps.filter((p) => p !== prev);
  if (others.length) return others[0];
  return ps[(ps.indexOf(prev || '') + 1) % ps.length];
}

export function countReplies(replies: VetviReply[]): number {
  let n = 0;
  for (const r of replies) {
    n++;
    if (r.children && r.children.length) n += countReplies(r.children);
  }
  return n;
}

export function dlgMaxDepth(replies: VetviReply[], d: number): number {
  let m = d;
  for (const r of replies) {
    if (r.children && r.children.length) {
      const t = dlgMaxDepth(r.children, d + 1);
      if (t > m) m = t;
    }
  }
  return m;
}

/** Все id реплик (включая вложенные). */
export function allReplyIds(replies: VetviReply[], out?: string[]): string[] {
  const o = out || [];
  for (const r of replies) {
    o.push(r.id);
    if (r.children && r.children.length) allReplyIds(r.children, o);
  }
  return o;
}

/** Мутационное удаление реплики по дереву. Возвращает true, если нашли. */
export function removeReplyDeep(replies: VetviReply[], id: string): boolean {
  const i = replies.findIndex((r) => r.id === id);
  if (i >= 0) {
    replies.splice(i, 1);
    return true;
  }
  for (const r of replies) {
    if (r.children && r.children.length && removeReplyDeep(r.children, id)) return true;
  }
  return false;
}

/** Плоский DFS-порядок реплик — «проигрывать подряд» (plLinearIds). */
export function linearIds(replies: VetviReply[], out?: string[]): string[] {
  const o = out || [];
  for (const r of replies) {
    o.push(r.id);
    if (r.children && r.children.length) linearIds(r.children, o);
  }
  return o;
}
