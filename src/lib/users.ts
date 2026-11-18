import { db } from '@/lib/db';

/** Поиск пользователя по логину БЕЗ учёта регистра.
 *
 *  findUnique в SQLite регистрозависим, а логины хранятся в оригинальном
 *  регистре («Basya»): грант/ревок по «basya» падал с «Пользователь не
 *  найден», хотя клиент сравнивает ники без регистра. Сначала точное
 *  совпадение (быстрый путь по индексу), затем — сверка в нижнем регистре
 *  по списку логинов (таблица аккаунтов маленькая — создаётся по инвайтам). */
export async function findUserByLogin(login: string) {
  const exact = await db.authUser.findUnique({ where: { login } });
  if (exact) return exact;
  const lower = login.trim().toLowerCase();
  if (!lower) return null;
  const all = await db.authUser.findMany({ select: { id: true, login: true } });
  const hit = all.find((u) => u.login.toLowerCase() === lower);
  if (!hit) return null;
  return db.authUser.findUnique({ where: { id: hit.id } });
}
