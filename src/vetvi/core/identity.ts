/**
 * Ветви — личность участника (syncMe оригинала).
 *
 * Теперь личность берётся из аккаунта (серверная запись AuthUser): имя и цвет
 * нельзя менять произвольно — они приходят из /api/auth/state при старте и
 * подставляются в presence/журналы/merge. Случайная «лесная» личность
 * осталась только как fallback до входа (или когда авторизация выключена).
 */

import { PALETTE_COLORS } from './constants';

export interface MeIdentity { id: string; name: string; color: string }

const LS_ME = 'vetvi-me-v1';
const NAMES = ['Лис', 'Филин', 'Барс', 'Выдра', 'Кречет', 'Рысь', 'Сурок', 'Куница', 'Тюлень', 'Сыч', 'Хорёк', 'Ласка'];

function uidLite(): string {
  return Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);
}

/** Личность из аккаунта (устанавливается после /api/auth/state при старте). */
let accountMe: MeIdentity | null = null;

/** Подставить личность аккаунта (вызывается авторизационным гейтом при старте). */
export function setAccountIdentity(a: { id: string; name: string; color: string }): void {
  accountMe = { id: a.id, name: a.name, color: a.color };
  try { window.localStorage.setItem(LS_ME, JSON.stringify(accountMe)); } catch { /* нет доступа */ }
}

/** Текущая личность: аккаунт приоритетнее; до входа — legacy-генерация. */
export function getMe(): MeIdentity {
  if (accountMe) return accountMe;
  try {
    const raw = window.localStorage.getItem(LS_ME) || 'null';
    const m = JSON.parse(raw) as MeIdentity | null;
    if (m && m.id) return m;
  } catch { /* нет доступа — сгенерируем новую */ }
  const m: MeIdentity = {
    id: uidLite() + uidLite(),
    name: NAMES[Math.floor(Math.random() * NAMES.length)] + '-' + Math.floor(100 + Math.random() * 900),
    color: PALETTE_COLORS[Math.floor(Math.random() * PALETTE_COLORS.length)],
  };
  try { window.localStorage.setItem(LS_ME, JSON.stringify(m)); } catch { /* нет доступа */ }
  return m;
}

/* Смена имени участника удалена: имя приходит из аккаунта и на сервере
   берётся из БД (клиентское переименование больше не поддерживается). */
