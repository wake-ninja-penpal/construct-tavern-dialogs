/**
 * «Ветви» — заготовка авторизации: серверные помощники (только backend!).
 *
 * Пароли: scrypt со случайной солью (без внешних зависимостей).
 * Сессии: случайный токен в httpOnly-cookie, запись в БД (AuthSession).
 * Админ: отдельный пароль (при первом входе — bootstrap-установка),
 *        отдельный cookie-токен (AppSetting: adminToken/adminTokenExp).
 * Глобальные настройки (вкл/выкл авторизации и регистрации) — AppSetting.
 */
import 'server-only';

import { randomBytes, scryptSync, timingSafeEqual } from 'crypto';
import { cookies } from 'next/headers';
import { db } from '@/lib/db';
import type { AuthUser } from '@prisma/client';

export const USER_COOKIE = 'vv_sess';
export const ADMIN_COOKIE = 'vv_root';
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 дней
export const ADMIN_TTL_MS = 12 * 60 * 60 * 1000; // 12 часов

/* палитра цвета участника: цвет выдаётся при регистрации и больше не меняется
   произвольно — имя и цвет аккаунта использует вся коллаборация */
export const USER_PALETTE = [
  '#e5484d', '#e5763c', '#f0b429', '#7cb342', '#2f9e77', '#12a594',
  '#00a2c7', '#646bd0', '#8661c9', '#c951a2', '#d04a7a',
];

export function pickUserColor(): string {
  return USER_PALETTE[Math.floor(Math.random() * USER_PALETTE.length)];
}

/** Публичные данные аккаунта (то, что видит клиент и sync-сервер). */
export interface PublicUser {
  id: string;
  login: string;
  displayName: string;
  color: string;
}

export function publicUser(u: AuthUser): PublicUser {
  return { id: u.id, login: u.login, displayName: u.displayName || u.login, color: u.color };
}

/* ── пароли ── */

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  return salt + ':' + hash;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = String(stored || '').split(':');
  if (!salt || !hash) return false;
  const probe = scryptSync(password, salt, 64);
  const ref = Buffer.from(hash, 'hex');
  return probe.length === ref.length && timingSafeEqual(probe, ref);
}

/* ── настройки приложения (AppSetting key-value) ── */

export async function getSetting(key: string): Promise<string | null> {
  const row = await db.appSetting.findUnique({ where: { key } });
  return row ? row.value : null;
}

export async function setSetting(key: string, value: string): Promise<void> {
  await db.appSetting.upsert({ where: { key }, create: { key, value }, update: { value } });
}

export async function authEnabled(): Promise<boolean> {
  return (await getSetting('authEnabled')) !== '0'; // по умолчанию ВКЛЮЧЕНА
}

export async function registrationEnabled(): Promise<boolean> {
  return (await getSetting('registrationEnabled')) !== '0';
}

/* ── пользовательские сессии ── */

export function newToken(): string {
  return randomBytes(32).toString('hex');
}

export async function createSession(userId: string): Promise<{ token: string; expiresAt: Date }> {
  const token = newToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db.authSession.create({ data: { token, userId, expiresAt } });
  return { token, expiresAt };
}

/** Текущий пользователь по cookie (или null). Отключённый аккаунт и протухшая
 *  сессия считаются «не залогинен», протухшие записи подчищаются на лету. */
export async function currentUser(): Promise<AuthUser | null> {
  const jar = await cookies();
  const token = jar.get(USER_COOKIE)?.value;
  if (!token) return null;
  const sess = await db.authSession.findUnique({ where: { token }, include: { user: true } });
  if (!sess) return null;
  if (sess.expiresAt.getTime() < Date.now() || sess.user.disabled) {
    await db.authSession.delete({ where: { token } }).catch(() => undefined);
    return null;
  }
  return sess.user;
}

export async function dropSession(token: string): Promise<void> {
  await db.authSession.deleteMany({ where: { token } });
}

/* ── админ: пароль при первом входе задаётся самим админом (bootstrap) ── */

export async function adminConfigured(): Promise<boolean> {
  return !!(await getSetting('adminHash'));
}

/** Установить/сменить пароль админки. */
export async function setAdminPassword(password: string): Promise<void> {
  await setSetting('adminHash', hashPassword(password));
  await clearAdminToken();
}

export async function verifyAdminPassword(password: string): Promise<boolean> {
  const stored = await getSetting('adminHash');
  if (!stored) return false;
  return verifyPassword(password, stored);
}

export async function issueAdminToken(): Promise<string> {
  const token = newToken();
  await setSetting('adminToken', token);
  await setSetting('adminTokenExp', String(Date.now() + ADMIN_TTL_MS));
  return token;
}

export async function clearAdminToken(): Promise<void> {
  await setSetting('adminToken', '');
  await setSetting('adminTokenExp', '0');
}

export async function isAdmin(): Promise<boolean> {
  const jar = await cookies();
  const token = jar.get(ADMIN_COOKIE)?.value;
  if (!token) return false;
  const ref = await getSetting('adminToken');
  const exp = Number(await getSetting('adminTokenExp')) || 0;
  if (!ref || token !== ref || Date.now() > exp) return false;
  return true;
}

/* ── ссылки-инвайты ── */

export function inviteCode(): string {
  // 20 символов base32-подобных — достаточно длинный, чтобы не подобрать
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const bytes = randomBytes(20);
  let out = '';
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}

/** Проверка инвайта для регистрации: существует, включён, лимит не исчерпан. */
export async function checkInvite(code: string): Promise<{ ok: boolean; reason?: string }> {
  const inv = await db.inviteLink.findUnique({ where: { code } });
  if (!inv) return { ok: false, reason: 'Ссылка не найдена' };
  if (inv.disabled) return { ok: false, reason: 'Ссылка отключена администратором' };
  if (inv.maxUses > 0 && inv.uses >= inv.maxUses) return { ok: false, reason: 'Лимит регистраций по ссылке исчерпан' };
  return { ok: true };
}
