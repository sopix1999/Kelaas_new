// Helper crypto: token acak, tanggal WIB (UTC+7), format tanggal Indonesia.
export function randomToken(len = 6): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // tanpa 0/O/I biar mudah dibaca
  const buf = crypto.getRandomValues(new Uint8Array(len));
  let out = '';
  for (let i = 0; i < len; i++) out += chars[buf[i] % chars.length];
  return out;
}

// Tanggal sekarang dalam zona Asia/Jakarta (UTC+7), tanpa library tz.
export function todayWIB(): string {
  const now = Date.now() + 7 * 3600 * 1000;
  const d = new Date(now);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

export function nowWIB(): string {
  const now = Date.now() + 7 * 3600 * 1000;
  const d = new Date(now);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

export function hariWIB(): string {
  const now = Date.now() + 7 * 3600 * 1000;
  const days = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];
  return days[new Date(now).getUTCDay()];
}

const BULAN_ID = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
export function fmtDateID(d: string): string {
  if (!d) return '-';
  const p = String(d).split('-');
  if (p.length !== 3) return d;
  const m = parseInt(p[1], 10);
  return `${parseInt(p[2], 10)} ${BULAN_ID[m - 1]} ${p[0]}`;
}

export function base64FromBytes(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
