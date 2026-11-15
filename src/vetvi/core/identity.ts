/**
 * Ветви — личность участника (syncMe оригинала).
 *
 * Одна на браузер (localStorage vetvi-me-v1): случайное имя из лесного
 * списка + случайный цвет палитры. Используется и журналом действий
 * (автор записей), и совместным редактированием (presence, локи, merge).
 */

import { PALETTE_COLORS } from './constants';

export interface MeIdentity { id: string; name: string; color: string }

const LS_ME = 'vetvi-me-v1';
const NAMES = ['Лис', 'Филин', 'Барс', 'Выдра', 'Кречет', 'Рысь', 'Сурок', 'Куница', 'Тюлень', 'Сыч', 'Хорёк', 'Ласка'];

function uidLite(): string {
  return Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);
}

/** Текущая личность (создаётся при первом обращении, хранится в localStorage). */
export function getMe(): MeIdentity {
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

/** Смена имени участника (окно «Сменить имя» в списке участников). */
export function setMeName(name: string): MeIdentity {
  const m = getMe();
  m.name = name;
  try { window.localStorage.setItem(LS_ME, JSON.stringify(m)); } catch { /* нет доступа */ }
  return m;
}
