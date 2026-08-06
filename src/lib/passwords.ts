// ============================================================
// Password hashing — kompatibel dengan hash bcrypt PHP lama.
// Cloudflare Workers tidak punya bcrypt asli; pakai bcryptjs
// (pure-JS, jalan di Workers) sebagai provider utama dengan
// fallback PBKDF2-SHA256 (format $pbkdf2$...$... yang bisa
// diverifikasi di sisi lain).
// ============================================================
import bcrypt from 'bcryptjs';

const PBKDF2_ITERATIONS = 100_000;

function b64encode(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function b64decode(s: string): Uint8Array {
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export async function hashPassword(plain: string): Promise<string> {
  try {
    // bcryptjs hashSync bersifat sinkron; bungkus Promise agar API tetap async.
    const hash = await new Promise<string>((res, rej) => {
      bcrypt.hash(plain, 10, (e: Error | null, h: string) => (e ? rej(e) : res(h)));
    });
    if (typeof hash === 'string' && hash.startsWith('$2')) return hash;
  } catch { /* fall through ke PBKDF2 */ }
  return hashPasswordPbkdf2(plain);
}

export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  if (!stored) return false;
  if (stored.startsWith('$2a$') || stored.startsWith('$2b$') || stored.startsWith('$2y$')) {
    try {
      return await new Promise<boolean>((res, rej) => {
        bcrypt.compare(plain, stored, (e: Error | null, ok: boolean) => (e ? rej(e) : res(ok)));
      });
    } catch { return false; }
  }
  if (stored.startsWith('$pbkdf2$')) return verifyPasswordPbkdf2(plain, stored);
  // Mode dual-mode lama: password plain text
  return stored === plain;
}

// ---------- Fallback PBKDF2 ----------
export async function hashPasswordPbkdf2(plain: string): Promise<string> {
  const te = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', iterations: PBKDF2_ITERATIONS, salt },
    await crypto.subtle.importKey('raw', te.encode(plain), 'PBKDF2', false, ['deriveBits']),
    256,
  );
  return `$pbkdf2$0$${PBKDF2_ITERATIONS}$${b64encode(salt)}$${b64encode(bits)}`;
}

export async function verifyPasswordPbkdf2(plain: string, stored: string): Promise<boolean> {
  try {
    const parts = stored.split('$');
    // ["", "pbkdf2", "0", "", "iter", "salt", "hash"]
    const iter = parseInt(parts[4] ?? String(PBKDF2_ITERATIONS), 10);
    const salt = b64decode(parts[5] ?? '');
    const want = parts[6] ?? '';
    const te = new TextEncoder();
    const bits = await crypto.subtle.deriveBits(
      { name: 'PBKDF2', hash: 'SHA-256', iterations: iter, salt },
      await crypto.subtle.importKey('raw', te.encode(plain), 'PBKDF2', false, ['deriveBits']),
      256,
    );
    return b64encode(bits) === want;
  } catch { return false; }
}
