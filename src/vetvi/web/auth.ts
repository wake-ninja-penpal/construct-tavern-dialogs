'use client';

/**
 * Ветви — клиентская авторизация и доступы (обёртка над /api/*).
 *
 * Аккаунт обязателен: /api/auth/state при старте отвечает, кто залогинен —
 * из ответа берутся публичные данные аккаунта (имя/цвет для личности) и
 * токен сессии. Токен держится в памяти модуля — SyncClient кладёт его в
 * vetvi:join, сервер vetvi-sync проверяет сессию по общей БД и берёт
 * имя/цвет из записи AuthUser (в комнате их менять нельзя).
 */

import { getMe, setAccountIdentity } from '@/vetvi/core/identity';

export interface VetviAccount {
  id: string;
  login: string;
  displayName: string;
  color: string;
}

let meAcc: VetviAccount | null = null;
let meToken: string | null = null;

/** Аккаунт текущей сессии (null до входа). */
export function getAccount(): VetviAccount | null {
  return meAcc;
}

/** Токен сессии для vetvi:join (null до первого /api/auth/state). */
export function getAccountToken(): string | null {
  return meToken;
}

/** Разобрать ответ /api/auth/state: подставить аккаунт+токен, вернуть user. */
export function authApplyState(st: { user?: { id?: string; login?: string; displayName?: string; color?: string; token?: string | null } | null } | null): VetviAccount | null {
  const u = st && st.user;
  if (u && u.id && u.login) {
    meAcc = {
      id: u.id,
      login: u.login,
      displayName: u.displayName || u.login,
      color: u.color || '#8b929c',
    };
    meToken = typeof u.token === 'string' && u.token ? u.token : null;
    /* личность редактора = личность аккаунта (имя/цвет в комнате менять нельзя) */
    setAccountIdentity({ id: meAcc.id, name: meAcc.displayName, color: meAcc.color });
    return meAcc;
  }
  meAcc = null;
  meToken = null;
  return null;
}

/** Выход: гасим сессию на сервере и перезагружаем страницу. */
export async function authLogout(): Promise<void> {
  try { await fetch('/api/auth/logout', { method: 'POST' }); } catch { /* уже вышли */ }
  meAcc = null;
  meToken = null;
}

/** Редактирование аккаунта: имя (ник/логин неизменяем) и/или пароль. */
export async function accountUpdate(p: { displayName?: string; currentPassword?: string; newPassword?: string }): Promise<{ ok: boolean; error?: string; nameChanged?: boolean; passwordChanged?: boolean }> {
  const { status, data } = await postJson('/api/auth/account', p);
  if (status !== 200) return { ok: false, error: String(data.error || 'Не удалось сохранить') };
  return { ok: true, nameChanged: !!data.nameChanged, passwordChanged: !!data.passwordChanged };
}

/** Освежить аккаунт из /api/auth/state: после смены имени/цвета на сервере
 *  обновляем кэш и личность редактора (аватар, имя в тулбаре). Токен не меняется. */
export async function authRefreshAccount(): Promise<void> {
  try {
    const r = await fetch('/api/auth/state', { cache: 'no-store' });
    if (!r.ok) return;
    const st = (await r.json()) as { user?: { id?: string; login?: string; displayName?: string; color?: string; token?: string | null } | null };
    authApplyState(st);
  } catch { /* сервер недоступен — оставляем как есть */ }
}

/* ═══ доступы (ProjectAccess) и уведомления — общие хелперы ═══ */

export interface AccessListItem {
  userId: string;
  login: string;
  displayName: string;
  color: string;
  role: 'owner' | 'editor' | 'reader';
  createdAt?: string;
}

export interface AccessMineItem {
  roomId: string;
  projectId?: string | null;
  projectName?: string | null;
  role: 'owner' | 'editor' | 'reader';
  ownerName?: string | null;
  /** комната жива на realtime-сервере? false — владелец выключил сетевой
   *  режим (проект офлайн: пометка в списке, открытие блокируется);
   *  null/undefined — статус неизвестен (sync недоступен) */
  online?: boolean | null;
}

export interface NotificationItem {
  id: string;
  type: string;
  payload: {
    roomId?: string;
    projectId?: string | null;
    projectName?: string | null;
    role?: string;
    granterName?: string;
    ownerName?: string;
    [k: string]: unknown;
  };
  read: boolean;
  createdAt: string;
}

async function postJson(url: string, body: unknown): Promise<{ status: number; data: Record<string, unknown> }> {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    let data: Record<string, unknown> = {};
    try { data = (await res.json()) as Record<string, unknown>; } catch { /* пустой ответ */ }
    return { status: res.status, data };
  } catch {
    return { status: 0, data: { error: 'Сервер недоступен' } };
  }
}

async function getJson(url: string): Promise<{ status: number; data: Record<string, unknown> }> {
  try {
    const res = await fetch(url, { cache: 'no-store' });
    let data: Record<string, unknown> = {};
    try { data = (await res.json()) as Record<string, unknown>; } catch { /* пустой ответ */ }
    return { status: res.status, data };
  } catch {
    return { status: 0, data: { error: 'Сервер недоступен' } };
  }
}

/** Заявить владение комнатой (создание комнаты / legacy-claim). */
export async function accessInit(roomId: string, projectId?: string | null, projectName?: string | null): Promise<{ ok: boolean; role?: string | null }> {
  const { status, data } = await postJson('/api/access/init', { roomId, projectId, projectName });
  return { ok: status === 200, role: (data.role as string | null) ?? undefined };
}

/** Список доступов комнаты (владелец/редактор). */
export async function accessList(roomId: string): Promise<{ ok: boolean; meRole?: string | null; items: AccessListItem[]; error?: string }> {
  const { status, data } = await getJson('/api/access/list?roomId=' + encodeURIComponent(roomId));
  if (status !== 200) return { ok: false, items: [], error: String(data.error || 'Не удалось загрузить доступы') };
  return { ok: true, meRole: (data.me as { role?: string } | undefined)?.role || null, items: (data.items as AccessListItem[]) || [] };
}

/** Открыть доступ пользователю по логину (+ уведомление ему). */
export async function accessGrant(roomId: string, login: string, role: 'editor' | 'reader', projectId?: string | null, projectName?: string | null): Promise<{ ok: boolean; error?: string }> {
  const { status, data } = await postJson('/api/access/grant', { roomId, projectId, projectName, login, role });
  return { ok: status === 200, error: status === 200 ? undefined : String(data.error || 'Не удалось открыть доступ') };
}

/** Отозвать доступ. */
export async function accessRevoke(roomId: string, login: string): Promise<{ ok: boolean; error?: string }> {
  const { status, data } = await postJson('/api/access/revoke', { roomId, login });
  return { ok: status === 200, error: status === 200 ? undefined : String(data.error || 'Не удалось отозвать доступ') };
}

/** Доступы текущего аккаунта (для списка «Вам открыли доступ»). */
export async function accessMine(): Promise<AccessMineItem[]> {
  const { status, data } = await getJson('/api/access/mine');
  if (status !== 200) return [];
  return (data.items as AccessMineItem[]) || [];
}

/** Актуальные названия проектов по комнатам (список «Мои проекты»): пока проект
 *  закрыт, соавтор мог переименовать его — сервер хранит свежее имя в ProjectAccess. */
export async function roomsNames(roomIds: string[]): Promise<Record<string, string>> {
  const { status, data } = await postJson('/api/rooms/names', { roomIds });
  if (status !== 200) return {};
  return (data.names as Record<string, string>) || {};
}

/** Уведомления аккаунта. ok=false — опрос не удался (сеть/сервер/сессия):
 *  хук колокольчика в этом случае сохраняет прежнее состояние (точка не
 *  «мигает» и не пропадает из-за сбоя одного опроса). */
export async function notificationsFetch(): Promise<{ items: NotificationItem[]; unread: number; ok: boolean }> {
  const { status, data } = await getJson('/api/notifications');
  if (status !== 200) return { items: [], unread: 0, ok: false };
  return {
    items: (data.items as NotificationItem[]) || [],
    unread: typeof data.unread === 'number' ? data.unread : 0,
    ok: true,
  };
}

/** Отметить уведомления прочитанными (все или по id). */
export async function notificationsRead(ids?: string[]): Promise<void> {
  try {
    await fetch('/api/notifications/read', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(ids && ids.length ? { ids } : { all: true }),
    });
  } catch { /* не критично */ }
}

/** Первая буква имени для аватара. */
export function avatarInitial(name: string): string {
  const n = (name || '').trim();
  return n ? n[0].toUpperCase() : '?';
}

/* getMe импортируется напрямую теми, кто пишет имя в комнату/журнал. */
export { getMe };
