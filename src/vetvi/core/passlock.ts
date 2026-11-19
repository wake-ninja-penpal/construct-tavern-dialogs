/**
 * Ветви — пароль проекта (ядро, совместимо с классической версией).
 *
 * Чистый JS sha256 (как sha256hex в index.html): работает и по http, без
 * Web Crypto. Хранится только соль+хэш (meta.passSalt/meta.passHash),
 * сам пароль живёт в памяти сессии и sessionStorage ('vetvi-unlock-<pid>').
 */

function utf8str(s: string): string {
  try {
    return unescape(encodeURIComponent(String(s)));
  } catch {
    return String(s);
  }
}

const HEX = '0123456789abcdef';

export function sha256hex(asciiIn: string): string {
  const mathPow = Math.pow;
  const maxWord = mathPow(2, 32);
  let result = '';
  const words: number[] = [];
  let ascii = utf8str(asciiIn);
  const asciiBitLength = ascii.length * 8;

  /* k и hash — таблицы констант sha256 (кэшируются, как в оригинале). */
  const gSha = sha256hex as unknown as { h?: number[]; k?: number[] };
  let hash = gSha.h || (gSha.h = []);
  const k = gSha.k || (gSha.k = []);
  let primeCounter = k.length;
  const isComposite: Record<number, number> = {};
  for (let candidate = 2; primeCounter < 64; candidate++) {
    if (!isComposite[candidate]) {
      for (let i = 0; i < 313; i += candidate) isComposite[i] = candidate;
      hash[primeCounter] = (mathPow(candidate, 0.5) * maxWord) | 0;
      k[primeCounter++] = (mathPow(candidate, 1 / 3) * maxWord) | 0;
    }
  }

  ascii += '\x80';
  while (ascii.length % 64 - 56) ascii += '\x00';
  for (let i = 0; i < ascii.length; i++) {
    const j = ascii.charCodeAt(i) & 255;
    words[i >> 2] = (words[i >> 2] || 0) | (j << ((3 - i) % 4) * 8);
  }
  words[words.length] = (asciiBitLength / maxWord) | 0;
  words[words.length] = asciiBitLength;

  const rightRotate = (value: number, amount: number) => (value >>> amount) | (value << (32 - amount));

  for (let j0 = 0; j0 < words.length;) {
    const w = words.slice(j0, j0 += 16);
    hash = hash.slice(0, 8);
    for (let i = 16; i < 64; i++) {
      const w15 = w[i - 15] || 0, w2 = w[i - 2] || 0;
      const s0 = rightRotate(w15, 7) ^ rightRotate(w15, 18) ^ (w15 >>> 3);
      const s1 = rightRotate(w2, 17) ^ rightRotate(w2, 19) ^ (w2 >>> 10);
      w[i] = ((w[i - 16] || 0) + s0 + (w[i - 7] || 0) + s1) | 0;
    }
    let a = hash[0], b = hash[1], c = hash[2], d = hash[3], e = hash[4], f = hash[5], g2 = hash[6], h2 = hash[7];
    for (let i = 0; i < 64; i++) {
      const S1 = rightRotate(e, 6) ^ rightRotate(e, 11) ^ rightRotate(e, 25);
      const ch = (e & f) ^ (~e & g2);
      const temp1 = (h2 + S1 + ch + k[i] + (w[i] || 0)) | 0;
      const S0 = rightRotate(a, 2) ^ rightRotate(a, 13) ^ rightRotate(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) | 0;
      h2 = g2; g2 = f; f = e; e = (d + temp1) | 0; d = c; c = b; b = a; a = (temp1 + temp2) | 0;
    }
    hash[0] = (hash[0] + a) | 0; hash[1] = (hash[1] + b) | 0; hash[2] = (hash[2] + c) | 0; hash[3] = (hash[3] + d) | 0;
    hash[4] = (hash[4] + e) | 0; hash[5] = (hash[5] + f) | 0; hash[6] = (hash[6] + g2) | 0; hash[7] = (hash[7] + h2) | 0;
  }
  for (let i = 0; i < 8; i++) {
    for (let j = 3; j + 1; j--) {
      const b2 = (hash[i] >>> (j * 8)) & 255;
      result += HEX.charAt(b2 >> 4) + HEX.charAt(b2 & 15);
    }
  }
  return result;
}

/** Случайная соль 16 байт (hex), как passRandomSalt оригинала. */
export function passRandomSalt(): string {
  let out = '';
  const arr = new Uint8Array(16);
  try {
    (window.crypto || { getRandomValues: (a: Uint8Array) => { for (let i = 0; i < a.length; i++) a[i] = Math.floor(Math.random() * 256); return a; } }).getRandomValues(arr);
  } catch {
    for (let q = 0; q < 16; q++) arr[q] = Math.floor(Math.random() * 256);
  }
  for (let i = 0; i < arr.length; i++) out += ('0' + arr[i].toString(16)).slice(-2);
  return out;
}

/** Проверка пароля против meta.passSalt/passHash (проект без пароля — всегда true). */
export function passVerify(meta: { passSalt?: string; passHash?: string } | null | undefined, v: string): boolean {
  const m = meta || {};
  if (!m.passHash) return true;
  return sha256hex((m.passSalt || '') + ':' + v) === m.passHash;
}
