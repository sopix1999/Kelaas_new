// ============================================================
// KELAAS API — port index.php (PHP/MySQL) → Hono + Cloudflare D1
// Setiap "action" lama (index.php?action=...) menjadi handler di
// /api?action=... atau /api/{action} (metode HTTP sesuai kebutuhan).
// ============================================================
import type { Context } from 'hono';
import type { D1Database } from '@cloudflare/workers-types';
import { all, one, run, insertId, num, s } from '../lib/db';
import { hashPassword, verifyPassword } from '../lib/passwords';
import { hariWIB, nowWIB, randomToken, todayWIB } from '../lib/crypto';

// ---------- helpers HTTP ----------
function ok(data: unknown, message = 'OK') {
  return { success: true, data, message };
}
function err(message: string, status = 400) {
  return { success: false, message, _status: status };
}
function json(v: unknown, status = 200) {
  return new Response(JSON.stringify(v), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}
function fail(message: string, status = 400) {
  return json(err(message, status), status);
}

async function getBody(c: Context): Promise<Record<string, any>> {
  const ct = c.req.header('content-type') || '';
  if (ct.includes('json')) {
    try {
      return (await c.req.json()) as Record<string, any>;
    } catch {
      return {};
    }
  }
  try {
    return await c.req.parseBody();
  } catch {
    return {};
  }
}

function getParam(c: Context, key: string): string {
  const q = c.req.query(key);
  if (q !== undefined && q !== null && q !== '') return q;
  const p = (c.get('_body') as Record<string, any>) || {};
  const v = p[key];
  return v === undefined || v === null ? '' : String(v);
}

// ---------- waktu ----------
function wibToEpoch(ts: string): number {
  return new Date(ts.replace(' ', 'T') + 'Z').getTime() - 7 * 3600 * 1000;
}
function addMinutesWib(ts: string, mins: number): string {
  const ms = wibToEpoch(ts) + mins * 60 * 1000 + 7 * 3600 * 1000;
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

// ---------- normalisasi field siswa (profil & ortu) ----------
function siswaFields(src: Record<string, any>): Record<string, string> {
  const map: [string, string][] = [
    ['ttl', 'ttl'],
    ['alamat', 'alamat'],
    ['noWa', 'no_wa'],
    ['ekstra', 'ekstra'],
    ['namaAyah', 'nama_ayah'],
    ['namaIbu', 'nama_ibu'],
    ['kerjaAyah', 'kerja_ayah'],
    ['kerjaIbu', 'kerja_ibu'],
    ['penghasilanOrtu', 'penghasilan_ortu'],
  ];
  const out: Record<string, string> = {};
  for (const [k, col] of map) out[col] = s(src[k]);
  return out;
}

// ---------- registrasi ----------
export async function registerRoutes(app: any): Promise<void> {
  const handle = async (c: Context) => {
    const db: D1Database = c.env.DB;
    const action = getParam(c, 'action') || c.req.param('action') || '';
    const method = c.req.method.toUpperCase();
    if (method === 'POST' || method === 'PUT' || method === 'DELETE') {
      const b = await getBody(c);
      if ((c.env as any).DEBUG) console.error('[body]', JSON.stringify(b));
      c.set('_body', b);
    }
    try {
      return await dispatch(c, db, action, method);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      if (c.env && (c.env as any).DEBUG) console.error('[routes]', action, method, e);
      return fail('Database error: ' + msg, 500);
    }
  };

  app.get('/api', handle);
  app.post('/api', handle);
  app.put('/api', handle);
  app.delete('/api', handle);
  app.all('/api/:action', async (c: Context) => {
    // Untuk akses API prefix lain tanpa param action
    if (!getParam(c, 'action')) {
      return fail('Parameter action wajib diisi', 400);
    }
    return handle(c);
  });
}

// ============================================================
// DISPATCH — port dari `switch ($action)` di index.php
// ============================================================
async function dispatch(c: Context, db: D1Database, action: string, method: string) {
  const body: Record<string, any> = (c.get('_body') as Record<string, any>) || {};
  const P = (k: string) => getParam(c, k);

  switch (action) {
    // ===================== AUTH =====================
    case 'login': {
      if (method !== 'POST') return fail('Method not allowed', 405);
      const u = s(body.username);
      const p = s(body.password);
      if (!u || !p) return fail('Username dan password wajib diisi');
      const user = await one(db, 'SELECT id, username, password, role, kelas, nama_lengkap AS namaLengkap, nip FROM users WHERE username=?', [u]);
      if (!user) return fail('Username atau password salah', 401);
      const stored = s(user.password);
      let valid = await verifyPassword(p, stored);
      if (!valid && !stored.startsWith('$2')) {
        // dual-mode: plain text fallback sudah diurus verifyPassword
      }
      if (!valid) return fail('Username atau password salah', 401);
      // auto-upgrade plain → hash
      if (!stored.startsWith('$2') && !stored.startsWith('$pbkdf2$')) {
        try {
          const h = await hashPassword(p);
          await run(db, 'UPDATE users SET password=? WHERE id=?', [h, user.id]);
        } catch { /* abaikan */ }
      }
      const { password: _pw, ...rest } = user;
      const roles = [rest.role];
      if (rest.nip && rest.role === 'Walikelas') roles.push('Guru');
      return json(ok({ ...rest, roles }, 'Login berhasil'));
    }

    case 'test': {
      const r = await one(db, 'SELECT COUNT(*) AS c FROM users');
      return json(ok({ db: 'ok', users: num(r?.c) }, 'Koneksi berhasil'));
    }

    // ===================== SETUP =====================
    case 'setup': {
      if (method !== 'POST') return fail('Method not allowed', 405);
      const ddl = [
        `CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE, password TEXT NOT NULL, role TEXT NOT NULL, kelas TEXT, nama_lengkap TEXT, nip TEXT)`,
        `CREATE TABLE IF NOT EXISTS siswa (id INTEGER PRIMARY KEY AUTOINCREMENT, nis TEXT NOT NULL, nama_siswa TEXT NOT NULL, kelas TEXT, jk TEXT, ttl TEXT DEFAULT '', alamat TEXT DEFAULT '', no_wa TEXT DEFAULT '', ekstra TEXT DEFAULT '', nama_ayah TEXT DEFAULT '', nama_ibu TEXT DEFAULT '', kerja_ayah TEXT DEFAULT '', kerja_ibu TEXT DEFAULT '', penghasilan_ortu TEXT DEFAULT '')`,
        `CREATE TABLE IF NOT EXISTS guru (id INTEGER PRIMARY KEY AUTOINCREMENT, nip TEXT NOT NULL, nama_guru TEXT, mapel TEXT, kelas_diampu TEXT)`,
        `CREATE TABLE IF NOT EXISTS kehadiran (id INTEGER PRIMARY KEY AUTOINCREMENT, tanggal TEXT, nis TEXT, kelas TEXT, status TEXT, keterangan TEXT)`,
        `CREATE TABLE IF NOT EXISTS tatatertib (id INTEGER PRIMARY KEY AUTOINCREMENT, tanggal TEXT, nis TEXT, pelanggaran TEXT, poin INTEGER, kelas TEXT)`,
        `CREATE TABLE IF NOT EXISTS kaskelas (id INTEGER PRIMARY KEY AUTOINCREMENT, tanggal TEXT, kelas TEXT, jenis TEXT, jumlah REAL, keterangan TEXT)`,
        `CREATE TABLE IF NOT EXISTS struktur_kelas (id INTEGER PRIMARY KEY AUTOINCREMENT, kelas TEXT, jabatan TEXT, nis TEXT, nama_siswa TEXT)`,
        `CREATE TABLE IF NOT EXISTS inventaris (id INTEGER PRIMARY KEY AUTOINCREMENT, kelas TEXT, nama_barang TEXT, jumlah INTEGER, kondisi TEXT, keterangan TEXT, tanggal TEXT)`,
        `CREATE TABLE IF NOT EXISTS pengumuman (id INTEGER PRIMARY KEY AUTOINCREMENT, kelas TEXT, judul TEXT, isi TEXT, tanggal TEXT, penulis TEXT)`,
        `CREATE TABLE IF NOT EXISTS jadwal_pelajaran (id INTEGER PRIMARY KEY AUTOINCREMENT, kelas TEXT, hari TEXT, jam_ke INTEGER, mata_pelajaran TEXT, nip TEXT)`,
        `CREATE TABLE IF NOT EXISTS jadwal_piket (id INTEGER PRIMARY KEY AUTOINCREMENT, kelas TEXT, hari TEXT, nis TEXT, nama_siswa TEXT)`,
        `CREATE TABLE IF NOT EXISTS jurnal_bimbingan (id INTEGER PRIMARY KEY AUTOINCREMENT, tanggal TEXT, kelas TEXT, kategori TEXT, isi TEXT, tindak_lanjut TEXT)`,
        `CREATE TABLE IF NOT EXISTS jurnal_mengajar (id INTEGER PRIMARY KEY AUTOINCREMENT, tanggal TEXT, kelas TEXT, nip TEXT, mapel TEXT, jam_ke INTEGER, materi TEXT, kegiatan TEXT)`,
        `CREATE TABLE IF NOT EXISTS presensi_mapel (id INTEGER PRIMARY KEY AUTOINCREMENT, tanggal TEXT, kelas TEXT, nis TEXT, nip TEXT, mapel TEXT, status TEXT, jam_ke INTEGER, created_at TEXT, updated_at TEXT)`,
        `CREATE TABLE IF NOT EXISTS nilai (id INTEGER PRIMARY KEY AUTOINCREMENT, nis TEXT, kelas TEXT, nip TEXT, mapel TEXT, jenis TEXT, nilai REAL, tanggal TEXT)`,
        `CREATE TABLE IF NOT EXISTS katalog_alat (id INTEGER PRIMARY KEY AUTOINCREMENT, kode TEXT, nama_barang TEXT, spesifikasi TEXT, jumlah INTEGER, kondisi TEXT, lokasi TEXT)`,
        `CREATE TABLE IF NOT EXISTS bahan_praktik (id INTEGER PRIMARY KEY AUTOINCREMENT, kode TEXT, nama_bahan TEXT, satuan TEXT, stok REAL, stok_min REAL, kategori TEXT)`,
        `CREATE TABLE IF NOT EXISTS peminjaman (id INTEGER PRIMARY KEY AUTOINCREMENT, id_pinjam TEXT, kode_barang TEXT, nama_barang TEXT, peminjam TEXT, jenis_peminjam TEXT, tgl_pinjam TEXT, batas_waktu TEXT, status TEXT, tgl_kembali TEXT)`,
        `CREATE TABLE IF NOT EXISTS laporan_kerusakan (id INTEGER PRIMARY KEY AUTOINCREMENT, tanggal TEXT, kode_barang TEXT, nama_barang TEXT, kerusakan TEXT, pelapor TEXT, status TEXT, jadwal_maintenance TEXT)`,
        `CREATE TABLE IF NOT EXISTS kunjungan_rumah (id INTEGER PRIMARY KEY AUTOINCREMENT, tanggal TEXT, nis TEXT, kelas TEXT, nama_siswa TEXT, alamat TEXT, hasil TEXT, tindak_lanjut TEXT, petugas TEXT)`,
        `CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY AUTOINCREMENT, setting_key TEXT NOT NULL UNIQUE, setting_value TEXT)`,
        `CREATE TABLE IF NOT EXISTS log_aktivitas (id INTEGER PRIMARY KEY AUTOINCREMENT, waktu TEXT, username TEXT, role TEXT, aksi TEXT, detail TEXT)`,
      ];
      let okCount = 0;
      const errs: string[] = [];
      for (const sql of ddl) {
        try {
          await run(db, sql);
          okCount++;
        } catch (e: unknown) {
          errs.push(String(e instanceof Error ? e.message : e));
        }
      }
      // seed
      try {
        const u = await one(db, 'SELECT COUNT(*) AS c FROM users');
        if (num(u?.c) === 0) {
          const seed = [
            ['admin', await hashPassword('admin123'), 'SuperAdmin', 'ALL', 'Administrator', ''],
            ['walas7a', await hashPassword('guru123'), 'Walikelas', '7A', 'Siti Aminah, S.Pd', '19850101'],
            ['19850101', await hashPassword('guru123'), 'Guru', 'GURU', 'Siti Aminah, S.T', '19850101'],
            ['toolman', await hashPassword('tool123'), 'Toolman', 'TKJ', 'Andi Prasetyo', ''],
            ['sekret7a', await hashPassword('sekret123'), 'Sekretaris', '7A', 'Dewi Lestari', ''],
            ['benda7a', await hashPassword('benda123'), 'Bendahara', '7A', 'Ahmad Fauzi', ''],
            ['ketua7a', await hashPassword('ketua123'), 'Ketua', '7A', 'Budi Santoso', ''],
            ['001', await hashPassword('siswa123'), 'Siswa', '7A', 'Ahmad Rizki', ''],
            ['002', await hashPassword('siswa123'), 'Siswa', '7A', 'Siti Nurhaliza', ''],
          ];
          for (const r of seed) await run(db, 'INSERT INTO users (username,password,role,kelas,nama_lengkap,nip) VALUES (?,?,?,?,?,?)', r);
        }
        const st = await one(db, 'SELECT COUNT(*) AS c FROM settings');
        if (num(st?.c) === 0) {
          await run(db, "INSERT INTO settings (setting_key,setting_value) VALUES ('TA_AKTIF','2025/2026'),('SEMESTER','1')");
        }
        const g = await one(db, 'SELECT COUNT(*) AS c FROM guru');
        if (num(g?.c) === 0) {
          await run(db, "INSERT INTO guru (nip,nama_guru,mapel) VALUES ('19850101','Siti Aminah, S.T','Produktif TKJ')");
        }
      } catch (e: unknown) {
        errs.push('seed: ' + String(e instanceof Error ? e.message : e));
      }
      return json(ok({ tabel_ok: okCount, tabel_gagal: ddl.length - okCount, errors: errs }, 'Setup selesai'));
    }

    case 'setup-guru-v2': {
      if (method !== 'POST') return fail('Method not allowed', 405);
      const done: string[] = [];
      const errs: string[] = [];
      const cols = [
        ['presensi_mapel', 'jam_ke', 'INTEGER'],
        ['presensi_mapel', 'created_at', 'TEXT'],
        ['presensi_mapel', 'updated_at', 'TEXT'],
      ];
      for (const [t, col, typ] of cols) {
        try {
          await run(db, `ALTER TABLE ${t} ADD COLUMN ${col} ${typ}`);
          done.push(`${t}.${col}`);
        } catch (e: unknown) {
          const m = String(e instanceof Error ? e.message : e).toLowerCase();
          if (m.includes('duplicate column') || m.includes('already exists')) done.push(`${col} (sudah ada)`);
          else errs.push(`${col}: ${m}`);
        }
      }
      return json(ok({ ditambahkan: done, errors: errs }, 'Setup Guru V2 selesai'));
    }

    case 'setup-siswa-v2': {
      if (method !== 'POST') return fail('Method not allowed', 405);
      const done: string[] = [];
      const errs: string[] = [];
      const cols: [string, string][] = [
        ['ttl', 'TEXT DEFAULT \'\''], ['alamat', 'TEXT DEFAULT \'\''], ['no_wa', 'TEXT DEFAULT \'\''],
        ['ekstra', 'TEXT DEFAULT \'\''], ['nama_ayah', 'TEXT DEFAULT \'\''], ['nama_ibu', 'TEXT DEFAULT \'\''],
        ['kerja_ayah', 'TEXT DEFAULT \'\''], ['kerja_ibu', 'TEXT DEFAULT \'\''], ['penghasilan_ortu', 'TEXT DEFAULT \'\''],
      ];
      for (const [col, typ] of cols) {
        try {
          await run(db, `ALTER TABLE siswa ADD COLUMN ${col} ${typ}`);
          done.push(`siswa.${col}`);
        } catch (e: unknown) {
          const m = String(e instanceof Error ? e.message : e).toLowerCase();
          if (m.includes('duplicate column') || m.includes('already exists')) done.push(`${col} (sudah ada)`);
          else errs.push(`${col}: ${m}`);
        }
      }
      return json(ok({ ditambahkan: done, errors: errs }, 'Setup Siswa V2 selesai'));
    }

    // ===================== DASHBOARD =====================
    case 'dashboard': {
      if (method !== 'GET') return fail('Method not allowed', 405);
      const kelas = P('kelas');
      const role = P('role');
      const nip = P('nip');
      if (!kelas) return fail('Parameter kelas wajib diisi');
      const today = todayWIB();
      const dayName = hariWIB();

      const totalSiswa = num((await one(db, 'SELECT COUNT(*) AS c FROM siswa WHERE kelas=?', [kelas]))?.c);
      const kRows = await all(db, 'SELECT status, COUNT(*) AS c FROM kehadiran WHERE kelas=? AND tanggal=? GROUP BY status', [kelas, today]);
      const kh = { Hadir: 0, Sakit: 0, Izin: 0, Alfa: 0 };
      for (const r of kRows) { const st = s(r.status); if (st in kh) kh[st as keyof typeof kh] = num(r.c); }

      const absent = await all(
        db,
        `SELECT s.nis, s.nama_siswa AS nama, COALESCE(k.status, 'Belum Absen') AS status
         FROM siswa s LEFT JOIN kehadiran k ON s.nis = k.nis AND k.tanggal = ?
         WHERE s.kelas = ? AND (k.status IS NULL OR k.status <> 'Hadir')`,
        [today, kelas],
      );

      const chartRows = await all(
        db, 'SELECT tanggal, status, COUNT(*) AS c FROM kehadiran WHERE kelas=? GROUP BY tanggal,status ORDER BY tanggal DESC LIMIT 70', [kelas],
      );
      const byDate: Record<string, Record<string, number>> = {};
      for (const r of chartRows) {
        const d = s(r.tanggal);
        if (!byDate[d]) byDate[d] = { Hadir: 0, Sakit: 0, Izin: 0, Alfa: 0 };
        const st = s(r.status);
        if (byDate[d][st] !== undefined) byDate[d][st] = num(r.c);
      }
      let dates = Object.keys(byDate).sort().slice(-7);
      const chart = { labels: [] as string[], hadir: [] as number[], absent: [] as number[] };
      for (const d of dates) {
        const p = d.split('-');
        chart.labels.push(`${parseInt(p[2], 10)} ${['', 'Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'][parseInt(p[1], 10)]}`);
        chart.hadir.push(byDate[d].Hadir);
        chart.absent.push(byDate[d].Sakit + byDate[d].Izin + byDate[d].Alfa);
      }

      const pengumuman = await all(db, 'SELECT id AS row, judul, isi, tanggal, penulis FROM pengumuman WHERE kelas=? ORDER BY tanggal DESC, id DESC LIMIT 3', [kelas]);
      const piket = await all(db, 'SELECT nis, nama_siswa AS nama FROM jadwal_piket WHERE kelas=? AND hari=?', [kelas, dayName]);

      const result: Record<string, any> = {
        today, totalSiswa,
        hadir: kh.Hadir, sakit: kh.Sakit, izin: kh.Izin, alfa: kh.Alfa,
        absentStudents: absent, chart, pengumuman, hariIni: dayName,
        todayPiket: piket, todaySchedule: [],
      };
      if (role === 'Guru' && nip) {
        result.todaySchedule = await all(
          db, 'SELECT kelas, jam_ke AS jamKe, mata_pelajaran AS mapel FROM jadwal_pelajaran WHERE nip=? AND hari=? ORDER BY jam_ke', [nip, dayName],
        );
      } else {
        result.todaySchedule = await all(
          db, 'SELECT jam_ke AS jamKe, mata_pelajaran AS mapel, nip AS guru FROM jadwal_pelajaran WHERE kelas=? AND hari=? ORDER BY jam_ke', [kelas, dayName],
        );
      }
      return json(ok(result));
    }

    case 'dashboard-rekap': {
      if (method !== 'GET') return fail('Method not allowed', 405);
      const kelas = P('kelas');
      const role = P('role');
      const nip = P('nip');
      if (!kelas) return fail('Parameter kelas wajib diisi');
      const r: Record<string, any> = {};
      r.totalSiswa = num((await one(db, 'SELECT COUNT(*) AS c FROM siswa WHERE kelas=?', [kelas]))?.c);
      r.totalPelanggaran = num((await one(db, 'SELECT COUNT(*) AS c FROM tatatertib WHERE kelas=?', [kelas]))?.c);
      const kas = await one(db, 'SELECT COALESCE(SUM(CASE WHEN jenis=\'Masuk\' THEN jumlah ELSE 0 END),0) AS m, COALESCE(SUM(CASE WHEN jenis=\'Keluar\' THEN jumlah ELSE 0 END),0) AS k FROM kaskelas WHERE kelas=?', [kelas]);
      r.saldoKas = num(kas?.m) - num(kas?.k);
      r.totalPengumuman = num((await one(db, 'SELECT COUNT(*) AS c FROM pengumuman WHERE kelas=?', [kelas]))?.c);
      r.totalInventaris = num((await one(db, 'SELECT COUNT(*) AS c FROM inventaris WHERE kelas=?', [kelas]))?.c);
      r.totalBimbingan = num((await one(db, 'SELECT COUNT(*) AS c FROM jurnal_bimbingan WHERE kelas=?', [kelas]))?.c);
      if (role === 'Guru' && nip) {
        r.totalJurnalMengajar = num((await one(db, 'SELECT COUNT(*) AS c FROM jurnal_mengajar WHERE nip=?', [nip]))?.c);
        r.kelasDiampu = num((await one(db, 'SELECT COUNT(DISTINCT kelas) AS c FROM jadwal_pelajaran WHERE nip=?', [nip]))?.c);
      }
      if (role === 'Toolman') {
        r.totalAlat = num((await one(db, 'SELECT COUNT(*) AS c FROM katalog_alat'))?.c);
        r.totalBahan = num((await one(db, 'SELECT COUNT(*) AS c FROM bahan_praktik'))?.c);
        r.lowStock = num((await one(db, 'SELECT COUNT(*) AS c FROM bahan_praktik WHERE stok <= stok_min'))?.c);
        r.pinjamAktif = num((await one(db, 'SELECT COUNT(*) AS c FROM peminjaman WHERE status=\'Dipinjam\''))?.c);
      }
      return json(ok(r));
    }

    case 'early-warning': {
      if (method !== 'GET') return fail('Method not allowed', 405);
      const kelas = P('kelas');
      if (!kelas) return fail('Parameter kelas wajib diisi');
      const alfaRows = await all(db, 'SELECT nis, COUNT(*) AS c FROM kehadiran WHERE kelas=? AND status=\'Alfa\' GROUP BY nis', [kelas]);
      const alfa: Record<string, number> = {};
      for (const x of alfaRows) alfa[s(x.nis)] = num(x.c);
      const avgRows = await all(db, 'SELECT nis, AVG(nilai) AS a FROM nilai WHERE kelas=? GROUP BY nis', [kelas]);
      const avg: Record<string, number> = {};
      for (const x of avgRows) avg[s(x.nis)] = Math.round(num(x.a) * 10) / 10;
      const siswa = await all(db, 'SELECT nis, nama_siswa AS nama FROM siswa WHERE kelas=?', [kelas]);
      const res: Record<string, any>[] = [];
      for (const sis of siswa) {
        const a = alfa[s(sis.nis)] ?? 0;
        const v = avg[s(sis.nis)] ?? null;
        const m: string[] = [];
        if (a > 3) m.push('Alfa ' + a + 'x');
        if (v !== null && v < 70) m.push('Rata-rata ' + v);
        if (m.length) res.push({ nis: sis.nis, nama: sis.nama, alfa: a, avg: v, masalah: m.join(' | ') });
      }
      return json(ok(res));
    }

    // ===================== GURU INFO =====================
    case 'guru-info': {
      if (method !== 'GET') return fail('Method not allowed', 405);
      const nip = P('nip');
      if (!nip) return fail('Parameter nip wajib diisi');
      let info = await one(db, 'SELECT nip, nama_guru, nama_guru AS nama, mapel, kelas_diampu FROM guru WHERE nip=?', [nip]);
      if (!info) {
        const u = await one(db, 'SELECT nama_lengkap FROM users WHERE username=?', [nip]);
        if (u) info = { nip, nama_guru: u.nama_lengkap, nama: u.nama_lengkap, mapel: '', kelas_diampu: '' };
      }
      const set = new Set<string>();
      if (info && info.kelas_diampu) {
        for (const k of String(info.kelas_diampu).split(',')) {
          const t = k.trim();
          if (t !== '') set.add(t);
        }
      }
      const jRows = await all(db, 'SELECT DISTINCT kelas FROM jadwal_pelajaran WHERE nip=?', [nip]);
      for (const x of jRows) if (x.kelas) set.add(s(x.kelas));
      return json(ok({ info, kelasDiampu: Array.from(set) }));
    }

    case 'guru-add-kelas': {
      if (method !== 'POST') return fail('Method not allowed', 405);
      const nip = body.nip ?? P('nip');
      const kelas = body.kelas ?? P('kelas');
      if (!nip || !kelas) return fail('nip dan kelas wajib diisi');
      const g = await one(db, 'SELECT id, kelas_diampu FROM guru WHERE nip=?', [nip]);
      if (g) {
        const ex = String(g.kelas_diampu || '').split(',').map((x) => x.trim()).filter(Boolean);
        if (!ex.includes(kelas)) {
          ex.push(kelas);
          await run(db, 'UPDATE guru SET kelas_diampu=? WHERE nip=?', [ex.join(','), nip]);
        }
      } else {
        await run(db, 'INSERT INTO guru (nip,nama_guru,mapel,kelas_diampu) VALUES (?,?,?,?)', [nip, '', '', kelas]);
      }
      return json(ok(null, 'Kelas ' + kelas + ' ditambahkan'));
    }

    case 'mapel-guru-kelas': {
      if (method !== 'GET') return fail('Method not allowed', 405);
      const nip = P('nip');
      const kelas = P('kelas');
      if (!nip || !kelas) return fail('nip dan kelas wajib diisi');
      const rows = await all(db, 'SELECT DISTINCT mata_pelajaran AS mapel FROM jadwal_pelajaran WHERE nip=? AND kelas=?', [nip, kelas]);
      return json(ok(rows.map((r) => r.mapel)));
    }

    case 'wali-kelas': {
      if (method !== 'GET') return fail('Method not allowed', 405);
      const kelas = P('kelas');
      if (!kelas) return fail('Parameter kelas wajib diisi');
      const r = await one(db, 'SELECT nama_lengkap AS nama FROM users WHERE role=\'Walikelas\' AND kelas=? LIMIT 1', [kelas]);
      return json(ok({ nama: r ? r.nama : '-' }));
    }

    case 'wali-kelas-all': {
      if (method !== 'GET') return fail('Method not allowed', 405);
      const rows = await all(db, 'SELECT kelas, nama_lengkap AS nama FROM users WHERE role=\'Walikelas\' AND kelas IS NOT NULL AND kelas<>\'\'');
      return json(ok(rows));
    }

    // ===================== SISWA =====================
    case 'siswa-options': {
      if (method !== 'GET') return fail('Method not allowed', 405);
      const kelas = P('kelas');
      if (!kelas) return fail('Parameter kelas wajib diisi');
      const rows = await all(db, 'SELECT nis, nama_siswa AS nama FROM siswa WHERE kelas=? ORDER BY nama_siswa', [kelas]);
      return json(ok(rows));
    }

    case 'siswa': {
      const kelas = P('kelas') || s(body.kelas);
      if (!kelas && (method === 'GET' || method === 'POST')) return fail('Parameter kelas wajib diisi');

      if (method === 'GET') {
        const rows = await all(
          db,
          `SELECT id AS row, nis, nama_siswa AS nama, kelas, jk, ttl, alamat, no_wa AS noWa, ekstra,
                  nama_ayah AS namaAyah, nama_ibu AS namaIbu, kerja_ayah AS kerjaAyah, kerja_ibu AS kerjaIbu,
                  penghasilan_ortu AS penghasilanOrtu
           FROM siswa WHERE kelas=? ORDER BY nama_siswa`, [kelas],
        );
        return json(ok(rows));
      }
      if (method === 'POST') {
        const nis = s(body.nis);
        const nama = s(body.nama);
        const jk = s(body.jk) || 'L';
        if (!nis || !nama) return fail('NIS dan Nama wajib diisi');
        const sf = siswaFields(body);
        await run(
          db,
          'INSERT INTO siswa (nis,nama_siswa,kelas,jk,ttl,alamat,no_wa,ekstra,nama_ayah,nama_ibu,kerja_ayah,kerja_ibu,penghasilan_ortu) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
          [nis, nama, kelas, jk, sf.ttl, sf.alamat, sf.no_wa, sf.ekstra, sf.nama_ayah, sf.nama_ibu, sf.kerja_ayah, sf.kerja_ibu, sf.penghasilan_ortu],
        );
        const ck = await one(db, 'SELECT id FROM users WHERE username=?', [nis]);
        if (!ck) {
          const h = await hashPassword('siswa123');
          await run(db, "INSERT INTO users (username,password,role,kelas,nama_lengkap,nip) VALUES (?,?,?,?,?,?)", [nis, h, 'Siswa', kelas, nama, '']);
        }
        return json(ok(null, 'Siswa ditambahkan (+akun login: ' + nis + ' / siswa123)'));
      }
      if (method === 'PUT') {
        const old = s(body.oldNis);
        const nis = s(body.nis);
        const nama = s(body.nama);
        const jk = s(body.jk) || 'L';
        const k = kelas || s(body.kelas);
        const sf = siswaFields(body);
        await run(
          db,
          'UPDATE siswa SET nis=?,nama_siswa=?,jk=?,ttl=?,alamat=?,no_wa=?,ekstra=?,nama_ayah=?,nama_ibu=?,kerja_ayah=?,kerja_ibu=?,penghasilan_ortu=? WHERE nis=? AND kelas=?',
          [nis, nama, jk, sf.ttl, sf.alamat, sf.no_wa, sf.ekstra, sf.nama_ayah, sf.nama_ibu, sf.kerja_ayah, sf.kerja_ibu, sf.penghasilan_ortu, old, k],
        );
        if (old !== nis) {
          await run(db, "UPDATE users SET username=?,nama_lengkap=?,kelas=? WHERE username=? AND role='Siswa'", [nis, nama, k, old]);
        } else {
          await run(db, "UPDATE users SET nama_lengkap=?,kelas=? WHERE username=? AND role='Siswa'", [nama, k, nis]);
        }
        return json(ok(null, 'Siswa diperbarui (+akun ikut terupdate)'));
      }
      if (method === 'DELETE') {
        const nis = P('nis') || s(body.nis);
        const k = kelas || s(body.kelas);
        if (k) await run(db, 'DELETE FROM siswa WHERE nis=? AND kelas=?', [nis, k]);
        else await run(db, 'DELETE FROM siswa WHERE nis=?', [nis]);
        await run(db, "DELETE FROM users WHERE username=? AND role='Siswa'", [nis]);
        return json(ok(null, 'Siswa & akun login dihapus'));
      }
      return fail('Method not allowed', 405);
    }

    case 'siswa-import': {
      if (method !== 'POST') return fail('Method not allowed', 405);
      const kelas = s(body.kelas) || P('kelas');
      if (!kelas) return fail('Parameter kelas wajib diisi');
      const data: Record<string, any>[] = Array.isArray(body.data) ? body.data : [];
      const exN = new Set((await all(db, 'SELECT nis FROM siswa')).map((r) => s(r.nis)));
      const exU = new Set((await all(db, 'SELECT username FROM users')).map((r) => s(r.username)));
      const hashSiswa = await hashPassword('siswa123');
      let ins = 0;
      let skip = 0;
      for (const r of data) {
        const nis = s(r.nis).trim();
        const nama = s(r.nama).trim();
        let jk = s(r.jk).trim().toUpperCase();
        if (jk !== 'L' && jk !== 'P') jk = 'L';
        const sf = siswaFields(r);
        if (!nis || !nama || exN.has(nis)) { skip++; continue; }
        await run(
          db,
          'INSERT INTO siswa (nis,nama_siswa,kelas,jk,ttl,alamat,no_wa,ekstra,nama_ayah,nama_ibu,kerja_ayah,kerja_ibu,penghasilan_ortu) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
          [nis, nama, kelas, jk, sf.ttl, sf.alamat, sf.no_wa, sf.ekstra, sf.nama_ayah, sf.nama_ibu, sf.kerja_ayah, sf.kerja_ibu, sf.penghasilan_ortu],
        );
        exN.add(nis);
        ins++;
        if (!exU.has(nis)) {
          await run(db, "INSERT INTO users (username,password,role,kelas,nama_lengkap,nip) VALUES (?,?,?,?,?,?)", [nis, hashSiswa, 'Siswa', kelas, nama, '']);
          exU.add(nis);
        }
      }
      return json(ok({ inserted: ins, skipped: skip }, 'Import ' + ins + ' siswa (+akun login otomatis: NIS/siswa123)' + (skip ? ' (' + skip + ' dilewati)' : '')));
    }

    // ===================== KEHADIRAN =====================
    case 'kehadiran': {
      const kelas = P('kelas') || s(body.kelas);
      const tgl = P('tanggal') || s(body.tanggal);
      if (!kelas && (method === 'GET' || method === 'POST')) return fail('Parameter kelas wajib diisi');
      if (method === 'GET') {
        if (!tgl) return fail('Parameter tanggal wajib diisi');
        const rows = await all(db, 'SELECT id AS row, tanggal, nis, status, keterangan FROM kehadiran WHERE kelas=? AND tanggal=? ORDER BY nis', [kelas, tgl]);
        return json(ok(rows));
      }
      if (method === 'POST') {
        if (!tgl) return fail('Parameter tanggal wajib diisi');
        const recs: Record<string, any>[] = Array.isArray(body.records) ? body.records : [];
        await run(db, 'DELETE FROM kehadiran WHERE tanggal=? AND kelas=?', [tgl, kelas]);
        for (const r of recs) {
          await run(db, 'INSERT INTO kehadiran (tanggal,nis,kelas,status,keterangan) VALUES (?,?,?,?,?)', [tgl, s(r.nis), kelas, s(r.status), s(r.keterangan)]);
        }
        return json(ok(null, 'Kehadiran disimpan (' + recs.length + ')'));
      }
      return fail('Method not allowed', 405);
    }

    // ===================== TATIB / KAS / STRUKTUR / INVENTARIS / PENGUMUMAN =====================
    case 'tatatertib': {
      const kelas = P('kelas') || s(body.kelas);
      if (!kelas && (method === 'GET' || method === 'POST')) return fail('Parameter kelas wajib diisi');
      if (method === 'GET') {
        const rows = await all(db, 'SELECT id AS row, tanggal, nis, pelanggaran, poin, kelas FROM tatatertib WHERE kelas=? ORDER BY tanggal DESC, id DESC', [kelas]);
        return json(ok(rows));
      }
      if (method === 'POST') {
        await run(db, 'INSERT INTO tatatertib (tanggal,nis,pelanggaran,poin,kelas) VALUES (?,?,?,?,?)', [body.tanggal, s(body.nis), s(body.pelanggaran), num(body.poin), kelas]);
        return json(ok(null, 'Ditambahkan'));
      }
      if (method === 'DELETE') {
        const id = P('id') || s(body.id);
        await run(db, 'DELETE FROM tatatertib WHERE id=?', [id]);
        return json(ok(null, 'Dihapus'));
      }
      return fail('Method not allowed', 405);
    }

    case 'kas': {
      const kelas = P('kelas') || s(body.kelas);
      if (!kelas && (method === 'GET' || method === 'POST')) return fail('Parameter kelas wajib diisi');
      if (method === 'GET') {
        const rows = await all(db, 'SELECT id AS row, tanggal, jenis, jumlah, keterangan FROM kaskelas WHERE kelas=? ORDER BY tanggal DESC, id DESC', [kelas]);
        return json(ok(rows));
      }
      if (method === 'POST') {
        await run(db, 'INSERT INTO kaskelas (tanggal,kelas,jenis,jumlah,keterangan) VALUES (?,?,?,?,?)', [body.tanggal, kelas, s(body.jenis), num(body.jumlah), s(body.keterangan)]);
        return json(ok(null, 'Transaksi ditambahkan'));
      }
      if (method === 'DELETE') {
        const id = P('id') || s(body.id);
        await run(db, 'DELETE FROM kaskelas WHERE id=?', [id]);
        return json(ok(null, 'Dihapus'));
      }
      return fail('Method not allowed', 405);
    }

    case 'kas-summary': {
      if (method !== 'GET') return fail('Method not allowed', 405);
      const kelas = P('kelas');
      if (!kelas) return fail('Parameter kelas wajib diisi');
      const r = await one(db, 'SELECT COALESCE(SUM(CASE WHEN jenis=\'Masuk\' THEN jumlah ELSE 0 END),0) AS m, COALESCE(SUM(CASE WHEN jenis=\'Keluar\' THEN jumlah ELSE 0 END),0) AS k FROM kaskelas WHERE kelas=?', [kelas]);
      const m = num(r?.m);
      const k = num(r?.k);
      return json(ok({ totalMasuk: m, totalKeluar: k, saldo: m - k }));
    }

    case 'struktur': {
      const kelas = P('kelas') || s(body.kelas);
      if (!kelas && (method === 'GET' || method === 'POST')) return fail('Parameter kelas wajib diisi');
      if (method === 'GET') {
        const rows = await all(db, 'SELECT jabatan, nis, nama_siswa AS nama FROM struktur_kelas WHERE kelas=?', [kelas]);
        return json(ok(rows));
      }
      if (method === 'POST') {
        const arr: Record<string, any>[] = Array.isArray(body.data) ? body.data : [];
        await run(db, 'DELETE FROM struktur_kelas WHERE kelas=?', [kelas]);
        for (const r of arr) {
          if (r.jabatan && r.nama) {
            await run(db, 'INSERT INTO struktur_kelas (kelas,jabatan,nis,nama_siswa) VALUES (?,?,?,?)', [kelas, s(r.jabatan), s(r.nis), s(r.nama)]);
          }
        }
        return json(ok(null, 'Struktur disimpan'));
      }
      return fail('Method not allowed', 405);
    }

    case 'inventaris': {
      const kelas = P('kelas') || s(body.kelas);
      if (!kelas && (method === 'GET' || method === 'POST')) return fail('Parameter kelas wajib diisi');
      if (method === 'GET') {
        const rows = await all(db, 'SELECT id AS row, nama_barang AS namaBarang, jumlah, kondisi, keterangan FROM inventaris WHERE kelas=?', [kelas]);
        return json(ok(rows));
      }
      if (method === 'POST') {
        await run(db, 'INSERT INTO inventaris (kelas,nama_barang,jumlah,kondisi,keterangan,tanggal) VALUES (?,?,?,?,?,?)', [kelas, s(body.nama), num(body.jumlah), s(body.kondisi), s(body.keterangan), todayWIB()]);
        return json(ok(null, 'Ditambahkan'));
      }
      if (method === 'DELETE') {
        const id = P('id') || s(body.id);
        await run(db, 'DELETE FROM inventaris WHERE id=?', [id]);
        return json(ok(null, 'Dihapus'));
      }
      return fail('Method not allowed', 405);
    }

    case 'pengumuman': {
      const kelas = P('kelas') || s(body.kelas);
      if (!kelas && (method === 'GET' || method === 'POST')) return fail('Parameter kelas wajib diisi');
      if (method === 'GET') {
        const rows = await all(db, 'SELECT id AS row, judul, isi, tanggal, penulis FROM pengumuman WHERE kelas=? ORDER BY tanggal DESC, id DESC', [kelas]);
        return json(ok(rows));
      }
      if (method === 'POST') {
        await run(db, 'INSERT INTO pengumuman (kelas,judul,isi,tanggal,penulis) VALUES (?,?,?,?,?)', [kelas, s(body.judul), s(body.isi), todayWIB(), s(body.penulis)]);
        return json(ok(null, 'Pengumuman dipublikasikan'));
      }
      if (method === 'DELETE') {
        const id = P('id') || s(body.id);
        await run(db, 'DELETE FROM pengumuman WHERE id=?', [id]);
        return json(ok(null, 'Dihapus'));
      }
      return fail('Method not allowed', 405);
    }

    // ===================== JADWAL =====================
    case 'jadwal': {
      const kelas = P('kelas') || s(body.kelas);
      if (!kelas && (method === 'GET' || method === 'POST')) return fail('Parameter kelas wajib diisi');
      if (method === 'GET') {
        const rows = await all(
          db,
          `SELECT id AS row, hari, jam_ke AS jamKe, mata_pelajaran AS mapel, nip AS kg FROM jadwal_pelajaran
           WHERE kelas=? ORDER BY CASE hari WHEN 'Senin' THEN 1 WHEN 'Selasa' THEN 2 WHEN 'Rabu' THEN 3 WHEN 'Kamis' THEN 4 WHEN 'Jumat' THEN 5 WHEN 'Sabtu' THEN 6 ELSE 7 END, jam_ke`, [kelas],
        );
        return json(ok(rows));
      }
      if (method === 'POST') {
        await run(db, 'INSERT INTO jadwal_pelajaran (kelas,hari,jam_ke,mata_pelajaran,nip) VALUES (?,?,?,?,?)', [kelas, s(body.hari), num(body.jam), s(body.mapel), s(body.nip)]);
        return json(ok(null, 'Jadwal ditambahkan'));
      }
      if (method === 'PUT') {
        const id = s(body.id) || P('id');
        await run(db, 'UPDATE jadwal_pelajaran SET kelas=?, hari=?, jam_ke=?, mata_pelajaran=?, nip=? WHERE id=?', [s(body.kelas), s(body.hari), num(body.jam), s(body.mapel), s(body.nip), id]);
        return json(ok(null, 'Jadwal diperbarui'));
      }
      if (method === 'DELETE') {
        const id = P('id') || s(body.id);
        await run(db, 'DELETE FROM jadwal_pelajaran WHERE id=?', [id]);
        return json(ok(null, 'Dihapus'));
      }
      return fail('Method not allowed', 405);
    }

    case 'jadwal-mengajar': {
      if (method !== 'GET') return fail('Method not allowed', 405);
      const nip = P('nip');
      if (!nip) return fail('Parameter nip wajib diisi');
      const rows = await all(db, 'SELECT kelas, jam_ke AS jamKe, mata_pelajaran AS mapel FROM jadwal_pelajaran WHERE nip=? AND hari=? ORDER BY jam_ke', [nip, hariWIB()]);
      return json(ok(rows));
    }

    case 'jadwal-by-guru': {
      if (method !== 'GET') return fail('Method not allowed', 405);
      const nip = P('nip');
      if (!nip) return fail('Parameter nip wajib diisi');
      const rows = await all(
        db,
        `SELECT id AS row, kelas, hari, jam_ke AS jamKe, mata_pelajaran AS mapel FROM jadwal_pelajaran
         WHERE nip=? ORDER BY CASE hari WHEN 'Senin' THEN 1 WHEN 'Selasa' THEN 2 WHEN 'Rabu' THEN 3 WHEN 'Kamis' THEN 4 WHEN 'Jumat' THEN 5 WHEN 'Sabtu' THEN 6 ELSE 7 END, jam_ke`, [nip],
      );
      return json(ok(rows));
    }

    case 'jadwal-piket': {
      const kelas = P('kelas') || s(body.kelas);
      if (!kelas && (method === 'GET' || method === 'POST')) return fail('Parameter kelas wajib diisi');
      if (method === 'GET') {
        const rows = await all(db, 'SELECT id AS row, hari, nis, nama_siswa AS nama FROM jadwal_piket WHERE kelas=?', [kelas]);
        return json(ok(rows));
      }
      if (method === 'POST') {
        const hari = s(body.hari) || P('hari');
        if (!hari) return fail('Parameter hari wajib diisi');
        const students: Record<string, any>[] = Array.isArray(body.students) ? body.students : [];
        await run(db, 'DELETE FROM jadwal_piket WHERE kelas=? AND hari=?', [kelas, hari]);
        for (const st of students) {
          if (st.nama) await run(db, 'INSERT INTO jadwal_piket (kelas,hari,nis,nama_siswa) VALUES (?,?,?,?)', [kelas, hari, s(st.nis), s(st.nama)]);
        }
        return json(ok(null, 'Piket ' + hari + ' disimpan'));
      }
      return fail('Method not allowed', 405);
    }

    // ===================== BIMBINGAN / KUNJUNGAN =====================
    case 'jurnal-bimbingan': {
      const kelas = P('kelas') || s(body.kelas);
      if (!kelas && (method === 'GET' || method === 'POST')) return fail('Parameter kelas wajib diisi');
      if (method === 'GET') {
        const rows = await all(db, 'SELECT id AS row, tanggal, kategori, isi, tindak_lanjut AS tindakLanjut FROM jurnal_bimbingan WHERE kelas=? ORDER BY tanggal DESC, id DESC', [kelas]);
        return json(ok(rows));
      }
      if (method === 'POST') {
        await run(db, 'INSERT INTO jurnal_bimbingan (tanggal,kelas,kategori,isi,tindak_lanjut) VALUES (?,?,?,?,?)', [body.tanggal, kelas, s(body.kategori), s(body.isi), s(body.tindakLanjut)]);
        return json(ok(null, 'Bimbingan dicatat'));
      }
      if (method === 'DELETE') {
        const id = P('id') || s(body.id);
        await run(db, 'DELETE FROM jurnal_bimbingan WHERE id=?', [id]);
        return json(ok(null, 'Dihapus'));
      }
      return fail('Method not allowed', 405);
    }

    case 'kunjungan-rumah': {
      const kelas = P('kelas') || s(body.kelas);
      if (!kelas && (method === 'GET' || method === 'POST')) return fail('Parameter kelas wajib diisi');
      if (method === 'GET') {
        const rows = await all(db, 'SELECT id AS row, tanggal, nis, nama_siswa AS nama, alamat, hasil, tindak_lanjut AS tl, petugas FROM kunjungan_rumah WHERE kelas=? ORDER BY tanggal DESC, id DESC', [kelas]);
        return json(ok(rows));
      }
      if (method === 'POST') {
        const nv = s(body.nisNama).split('|');
        await run(db, 'INSERT INTO kunjungan_rumah (tanggal,nis,kelas,nama_siswa,alamat,hasil,tindak_lanjut,petugas) VALUES (?,?,?,?,?,?,?,?)', [body.tanggal, nv[0] ?? '', kelas, nv[1] ?? '', s(body.alamat), s(body.hasil), s(body.tindakLanjut), s(body.petugas)]);
        return json(ok(null, 'Kunjungan dicatat'));
      }
      if (method === 'DELETE') {
        const id = P('id') || s(body.id);
        await run(db, 'DELETE FROM kunjungan_rumah WHERE id=?', [id]);
        return json(ok(null, 'Dihapus'));
      }
      return fail('Method not allowed', 405);
    }

    // ===================== JURNAL MENGAJAR =====================
    case 'jurnal-mengajar': {
      if (method === 'GET') {
        const nip = P('nip');
        if (!nip) return fail('Parameter nip wajib diisi');
        let sql = 'SELECT id AS row, tanggal, kelas, mapel, jam_ke AS jamKe, materi, kegiatan FROM jurnal_mengajar WHERE nip=?';
        const p: unknown[] = [nip];
        const tgl = P('tanggal');
        if (tgl) { sql += ' AND tanggal=?'; p.push(tgl); }
        sql += ' ORDER BY tanggal DESC, id DESC';
        const rows = await all(db, sql, p);
        return json(ok(rows));
      }
      if (method === 'POST') {
        const nip = s(body.nip) || P('nip');
        if (!nip) return fail('Parameter nip wajib diisi');
        await run(db, 'INSERT INTO jurnal_mengajar (tanggal,kelas,nip,mapel,jam_ke,materi,kegiatan) VALUES (?,?,?,?,?,?,?)', [body.tanggal, s(body.kelas), nip, s(body.mapel), num(body.jam), s(body.materi), s(body.kegiatan)]);
        return json(ok(null, 'Jurnal disimpan'));
      }
      if (method === 'DELETE') {
        const nip = s(body.nip) || P('nip');
        const id = P('id') || s(body.id);
        await run(db, 'DELETE FROM jurnal_mengajar WHERE id=? AND nip=?', [id, nip]);
        return json(ok(null, 'Dihapus'));
      }
      return fail('Method not allowed', 405);
    }

    // ===================== PRESENSI MAPEL =====================
    case 'presensi-mapel': {
      if (method === 'GET') {
        const nip = P('nip');
        const kelas = P('kelas');
        const tgl = P('tanggal');
        if (!nip || !kelas || !tgl) return fail('nip, kelas, tanggal wajib diisi');
        const rows = await all(db, 'SELECT nis, status, mapel FROM presensi_mapel WHERE nip=? AND kelas=? AND tanggal=?', [nip, kelas, tgl]);
        return json(ok(rows));
      }
      if (method === 'POST') {
        const nip = s(body.nip);
        const kelas = s(body.kelas);
        const mapel = s(body.mapel);
        const tgl = s(body.tanggal);
        const recs: Record<string, any>[] = Array.isArray(body.records) ? body.records : [];
        const jamKe = body.jamKe !== undefined && body.jamKe !== '' ? num(body.jamKe) : null;
        if (!nip || !kelas || !mapel || !tgl) return fail('nip, kelas, mapel, tanggal wajib diisi');
        await run(db, 'DELETE FROM presensi_mapel WHERE nip=? AND kelas=? AND tanggal=? AND mapel=?', [nip, kelas, tgl, mapel]);
        for (const r of recs) {
          await run(db, 'INSERT INTO presensi_mapel (tanggal,kelas,nis,nip,mapel,status,jam_ke,created_at) VALUES (?,?,?,?,?,?,?,?)', [tgl, kelas, s(r.nis), nip, mapel, s(r.status), jamKe, nowWIB()]);
        }
        return json(ok(null, 'Presensi ' + recs.length + ' siswa tersimpan pukul ' + nowWIB().split(' ')[1] + ' WIB'));
      }
      if (method === 'PUT') {
        const updates: Record<string, any>[] = Array.isArray(body.updates) ? body.updates : [];
        if (!updates.length) return fail('Tidak ada baris untuk diperbarui');
        let n = 0;
        for (const u of updates) {
          if (!u.id || !u.status) continue;
          await run(db, 'UPDATE presensi_mapel SET status=?, updated_at=? WHERE id=?', [s(u.status), nowWIB(), num(u.id)]);
          n++;
        }
        return json(ok(null, n + ' baris presensi diperbarui (' + nowWIB().split(' ')[1] + ' WIB)'));
      }
      return fail('Method not allowed', 405);
    }

    case 'presensi-riwayat': {
      if (method !== 'GET') return fail('Method not allowed', 405);
      const nip = P('nip');
      if (!nip) return fail('Parameter nip wajib diisi');
      const tanggal = P('tanggal');
      const kelasF = P('kelas');
      let base = ' FROM presensi_mapel p LEFT JOIN siswa s ON s.nis=p.nis LEFT JOIN jurnal_mengajar j ON j.nip=p.nip AND j.tanggal=p.tanggal AND j.kelas=p.kelas AND j.mapel=p.mapel WHERE p.nip=?';
      const p: unknown[] = [nip];
      if (tanggal) { base += ' AND p.tanggal=?'; p.push(tanggal); }
      if (kelasF) { base += ' AND p.kelas=?'; p.push(kelasF); }
      const tail = ' ORDER BY p.tanggal DESC, p.kelas, j.jam_ke, s.nama_siswa';
      const sel = 'SELECT p.id, p.tanggal, p.kelas, p.mapel, p.nis, p.status, s.nama_siswa AS nama, j.jam_ke AS jamKe, p.created_at AS createdAt, p.updated_at AS updatedAt';
      let rows = await all(db, sel + base + tail, p);
      if (!rows.length) {
        rows = await all(db, sel.replace(', p.created_at AS createdAt, p.updated_at AS updatedAt', ', NULL AS createdAt, NULL AS updatedAt') + base + tail, p);
      }
      const sessions: Record<string, any> = {};
      const order: string[] = [];
      for (const r of rows) {
        const key = s(r.tanggal) + '|' + s(r.kelas) + '|' + s(r.mapel);
        if (!sessions[key]) {
          sessions[key] = {
            tanggal: r.tanggal, kelas: r.kelas, mapel: r.mapel, jamKe: r.jamKe,
            createdAt: r.createdAt, updatedAt: null,
            summary: { Hadir: 0, Sakit: 0, Izin: 0, Alfa: 0, Dispensasi: 0 },
            students: [],
          };
          order.push(key);
        }
        const st = s(r.status);
        if (sessions[key].summary[st] !== undefined) sessions[key].summary[st]++;
        if (r.updatedAt && (!sessions[key].updatedAt || String(r.updatedAt) > String(sessions[key].updatedAt))) sessions[key].updatedAt = r.updatedAt;
        sessions[key].students.push({ id: r.id, nis: r.nis, nama: r.nama || r.nis, status: st, updatedAt: r.updatedAt });
      }
      let out = order.map((k) => sessions[k]);
      if (!tanggal && !kelasF) out = out.slice(0, 30);
      return json(ok(out));
    }

    // ===================== NILAI =====================
    case 'nilai': {
      if (method === 'GET') {
        const nip = P('nip');
        if (!nip) return fail('Parameter nip wajib diisi');
        const kelas = P('kelas');
        let rows;
        if (kelas) rows = await all(db, 'SELECT id AS row, nis, kelas, mapel, jenis, nilai, tanggal FROM nilai WHERE nip=? AND kelas=?', [nip, kelas]);
        else rows = await all(db, 'SELECT id AS row, nis, kelas, mapel, jenis, nilai, tanggal FROM nilai WHERE nip=?', [nip]);
        return json(ok(rows));
      }
      if (method === 'POST') {
        const nip = s(body.nip);
        if (!nip) return fail('Parameter nip wajib diisi');
        await run(db, 'INSERT INTO nilai (nis,kelas,nip,mapel,jenis,nilai,tanggal) VALUES (?,?,?,?,?,?,?)', [s(body.nis), s(body.kelas), nip, s(body.mapel), s(body.jenis), num(body.nilai), todayWIB()]);
        return json(ok(null, 'Nilai disimpan'));
      }
      if (method === 'DELETE') {
        const nip = s(body.nip) || P('nip');
        const id = P('id') || s(body.id);
        if (nip) await run(db, 'DELETE FROM nilai WHERE id=? AND nip=?', [id, nip]);
        else await run(db, 'DELETE FROM nilai WHERE id=?', [id]);
        return json(ok(null, 'Dihapus'));
      }
      return fail('Method not allowed', 405);
    }

    case 'nilai-bulk': {
      if (method !== 'POST') return fail('Method not allowed', 405);
      const nip = s(body.nip);
      const kelas = s(body.kelas);
      const mapel = s(body.mapel);
      const entries: Record<string, any>[] = Array.isArray(body.entries) ? body.entries : [];
      if (!nip || !kelas || !mapel) return fail('nip, kelas, mapel wajib diisi');
      const seen = new Set(entries.map((e) => s(e.nis)));
      for (const n of seen) {
        await run(db, 'DELETE FROM nilai WHERE nip=? AND kelas=? AND mapel=? AND nis=?', [nip, kelas, mapel, n]);
      }
      for (const e of entries) {
        if (e.nilai !== '' && e.nilai !== null && e.nilai !== undefined) {
          await run(db, 'INSERT INTO nilai (nis,kelas,nip,mapel,jenis,nilai,tanggal) VALUES (?,?,?,?,?,?,?)', [s(e.nis), kelas, nip, mapel, s(e.jenis), num(e.nilai), todayWIB()]);
        }
      }
      return json(ok(null, 'Nilai tersimpan'));
    }

    case 'nilai-rekap': {
      if (method !== 'GET') return fail('Method not allowed', 405);
      const nip = P('nip');
      const kelas = P('kelas');
      const mapel = P('mapel');
      if (!nip || !kelas) return fail('nip dan kelas wajib diisi');
      const siswa = await all(db, 'SELECT nis, nama_siswa AS nama FROM siswa WHERE kelas=? ORDER BY nama_siswa', [kelas]);
      let sql = 'SELECT nis, jenis, nilai FROM nilai WHERE nip=? AND kelas=?';
      const p: unknown[] = [nip, kelas];
      if (mapel) { sql += ' AND mapel=?'; p.push(mapel); }
      const rows = await all(db, sql, p);
      const map: Record<string, Record<string, number>> = {};
      for (const n of rows) {
        const key = s(n.nis);
        if (!map[key]) map[key] = {};
        map[key][s(n.jenis)] = num(n.nilai);
      }
      const jenisList = ['NH1', 'NH2', 'NH3', 'NH4', 'NH5', 'NH6', 'NH7', 'NH8', 'PSTS', 'PSAS'];
      const res: Record<string, any>[] = [];
      for (const sis of siswa) {
        const row: Record<string, any> = { nis: sis.nis, nama: sis.nama };
        const vals: number[] = [];
        for (const j of jenisList) {
          const v = map[s(sis.nis)]?.[j] ?? null;
          row[j] = v;
          if (v !== null) vals.push(v);
        }
        row.akhir = vals.length ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10 : null;
        res.push(row);
      }
      return json(ok({ students: res, mapel: mapel || '-', kelas }));
    }

    case 'nilai-peringkat': {
      if (method !== 'GET') return fail('Method not allowed', 405);
      const nip = P('nip');
      const kelas = P('kelas');
      const mapel = P('mapel');
      if (!nip || !kelas) return fail('nip dan kelas wajib diisi');
      const siswa = await all(db, 'SELECT nis, nama_siswa AS nama FROM siswa WHERE kelas=?', [kelas]);
      let sql = 'SELECT nis, nilai FROM nilai WHERE nip=? AND kelas=?';
      const p: unknown[] = [nip, kelas];
      if (mapel) { sql += ' AND mapel=?'; p.push(mapel); }
      const rows = await all(db, sql, p);
      const map: Record<string, number[]> = {};
      for (const n of rows) {
        const key = s(n.nis);
        if (!map[key]) map[key] = [];
        map[key].push(num(n.nilai));
      }
      const res: Record<string, any>[] = [];
      for (const sis of siswa) {
        const vals = map[s(sis.nis)] ?? [];
        const avg = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
        if (avg > 0) res.push({ nis: sis.nis, nama: sis.nama, avg: Math.round(avg * 10) / 10 });
      }
      res.sort((a, b) => num(b.avg) - num(a.avg));
      res.forEach((r, i) => (r.rank = i + 1));
      return json(ok(res));
    }

    case 'analisis-nilai': {
      if (method !== 'GET') return fail('Method not allowed', 405);
      const nip = P('nip');
      const kelas = P('kelas');
      const mapel = P('mapel');
      const kkm = num(P('kkm')) || 75;
      if (!nip || !kelas) return fail('nip dan kelas wajib diisi');
      const siswa = await all(db, 'SELECT nis, nama_siswa AS nama FROM siswa WHERE kelas=? ORDER BY nama_siswa', [kelas]);
      let sql = 'SELECT nis, nilai FROM nilai WHERE nip=? AND kelas=?';
      const p: unknown[] = [nip, kelas];
      if (mapel) { sql += ' AND mapel=?'; p.push(mapel); }
      const rows = await all(db, sql, p);
      const sums: Record<string, number> = {};
      const cnts: Record<string, number> = {};
      for (const n of rows) {
        const key = s(n.nis);
        sums[key] = (sums[key] ?? 0) + num(n.nilai);
        cnts[key] = (cnts[key] ?? 0) + 1;
      }
      const students: Record<string, any>[] = [];
      for (const sis of siswa) {
        const key = s(sis.nis);
        if (cnts[key] && cnts[key] > 0) students.push({ nis: sis.nis, nama: sis.nama, avg: Math.round((sums[key] / cnts[key]) * 10) / 10 });
      }
      if (!students.length) {
        return json(ok({ rataRata: null, tertinggi: null, terendah: null, ketuntasan: 0, kkm, remedial: [], ranking: [], distribusi: [0, 0, 0, 0, 0], labels: ['<60', '60-69', '70-79', '80-89', '90-100'], total: 0 }));
      }
      const avgs = students.map((x) => num(x.avg));
      const rata = Math.round((avgs.reduce((a, b) => a + b, 0) / avgs.length) * 10) / 10;
      const tuntas = avgs.filter((a) => a >= kkm).length;
      const remedial = students.filter((x) => num(x.avg) < kkm);
      const ranking = [...students].sort((a, b) => num(b.avg) - num(a.avg));
      ranking.forEach((r, i) => (r.rank = i + 1));
      const dist = [0, 0, 0, 0, 0];
      for (const a of avgs) {
        if (a < 60) dist[0]++;
        else if (a < 70) dist[1]++;
        else if (a < 80) dist[2]++;
        else if (a < 90) dist[3]++;
        else dist[4]++;
      }
      return json(ok({ rataRata: rata, tertinggi: Math.max(...avgs), terendah: Math.min(...avgs), ketuntasan: Math.round((tuntas / avgs.length) * 100), kkm, remedial, ranking, distribusi: dist, labels: ['<60', '60-69', '70-79', '80-89', '90-100'], total: students.length }));
    }

    // ===================== MY DATA / ORTU =====================
    case 'my-data': {
      if (method !== 'GET') return fail('Method not allowed', 405);
      const kelas = P('kelas');
      const nis = P('nis');
      if (!kelas || !nis) return fail('kelas dan nis wajib diisi');
      const dayName = hariWIB();
      const info = await one(db, 'SELECT nis, nama_siswa AS nama, kelas, jk FROM siswa WHERE nis=?', [nis]);
      const keh = await all(db, 'SELECT tanggal, status, keterangan FROM kehadiran WHERE nis=? ORDER BY tanggal DESC', [nis]);
      const sum = { Hadir: 0, Sakit: 0, Izin: 0, Alfa: 0 };
      for (const k of keh) if (sum[s(k.status) as keyof typeof sum] !== undefined) sum[s(k.status) as keyof typeof sum]++;
      const ts = await all(db, 'SELECT jam_ke AS jamKe, mata_pelajaran AS mapel, nip AS guru FROM jadwal_pelajaran WHERE kelas=? AND hari=? ORDER BY jam_ke', [kelas, dayName]);
      const tp = await all(db, 'SELECT nis, nama_siswa AS nama FROM jadwal_piket WHERE kelas=? AND hari=?', [kelas, dayName]);
      const pg = await all(db, 'SELECT id AS row, judul, isi, tanggal, penulis FROM pengumuman WHERE kelas=? ORDER BY tanggal DESC, id DESC LIMIT 3', [kelas]);
      return json(ok({ info, kehadiran: keh, summary: sum, todaySchedule: ts, todayPiket: tp, pengumuman: pg, hariIni: dayName }));
    }

    case 'ortu-data': {
      if (method !== 'GET') return fail('Method not allowed', 405);
      const nis = P('nis');
      if (!nis) return fail('Parameter nis wajib diisi');
      const info = await one(db, 'SELECT nis, nama_siswa AS nama, kelas, jk FROM siswa WHERE nis=?', [nis]);
      const keh = await all(db, 'SELECT tanggal, status, keterangan FROM kehadiran WHERE nis=? ORDER BY tanggal DESC', [nis]);
      const sum = { Hadir: 0, Sakit: 0, Izin: 0, Alfa: 0 };
      for (const k of keh) if (sum[s(k.status) as keyof typeof sum] !== undefined) sum[s(k.status) as keyof typeof sum]++;
      const nilai = await all(db, 'SELECT mapel, jenis, nilai FROM nilai WHERE nis=?', [nis]);
      return json(ok({ info, kehadiran: keh, summary: sum, nilai }));
    }

    // ===================== TOOLMAN =====================
    case 'katalog-alat': {
      if (method === 'GET') {
        const rows = await all(db, 'SELECT id AS row, kode, nama_barang AS nama, spesifikasi, jumlah, kondisi, lokasi FROM katalog_alat');
        return json(ok(rows));
      }
      if (method === 'POST') {
        await run(db, 'INSERT INTO katalog_alat (kode,nama_barang,spesifikasi,jumlah,kondisi,lokasi) VALUES (?,?,?,?,?,?)', [s(body.kode), s(body.nama), s(body.spesifikasi), num(body.jumlah), s(body.kondisi), s(body.lokasi)]);
        return json(ok(null, 'Alat ditambahkan'));
      }
      if (method === 'DELETE') {
        const id = P('id') || s(body.id);
        await run(db, 'DELETE FROM katalog_alat WHERE id=?', [id]);
        return json(ok(null, 'Dihapus'));
      }
      return fail('Method not allowed', 405);
    }

    case 'bahan-praktik': {
      if (method === 'GET') {
        const rows = await all(db, 'SELECT id AS row, kode, nama_bahan AS nama, satuan, stok, stok_min AS stokMin, kategori FROM bahan_praktik');
        for (const r of rows) {
          r.stok = num(r.stok);
          r.stokMin = num(r.stokMin);
          r.lowStock = num(r.stok) <= num(r.stokMin);
        }
        return json(ok(rows));
      }
      if (method === 'POST') {
        await run(db, 'INSERT INTO bahan_praktik (kode,nama_bahan,satuan,stok,stok_min,kategori) VALUES (?,?,?,?,?,?)', [s(body.kode), s(body.nama), s(body.satuan), num(body.stok), num(body.stokMin), s(body.kategori)]);
        return json(ok(null, 'Bahan ditambahkan'));
      }
      if (method === 'PUT') {
        await run(db, 'UPDATE bahan_praktik SET stok=MAX(0, stok+?) WHERE kode=?', [num(body.delta), s(body.kode)]);
        const r = await one(db, 'SELECT stok FROM bahan_praktik WHERE kode=?', [s(body.kode)]);
        return json(ok('Stok: ' + (r ? r.stok : '?'), 'Stok diperbarui'));
      }
      if (method === 'DELETE') {
        const id = P('id') || s(body.id);
        await run(db, 'DELETE FROM bahan_praktik WHERE id=?', [id]);
        return json(ok(null, 'Dihapus'));
      }
      return fail('Method not allowed', 405);
    }

    case 'peminjaman': {
      const today = todayWIB();
      if (method === 'GET') {
        const rows = await all(
          db,
          `SELECT id AS row, id_pinjam AS id, kode_barang AS kodeBarang, nama_barang AS namaBarang, peminjam,
                  jenis_peminjam AS jenisPeminjam, tgl_pinjam AS tglPinjam, batas_waktu AS batasWaktu, status, tgl_kembali AS tglKembali
           FROM peminjaman ORDER BY tgl_pinjam DESC, id DESC`,
        );
        for (const r of rows) r.telat = r.status === 'Dipinjam' && s(r.batasWaktu) < today;
        return json(ok(rows));
      }
      if (method === 'POST') {
        const kb = s(body.kodeBarang);
        const a = await one(db, 'SELECT nama_barang FROM katalog_alat WHERE kode=?', [kb]);
        if (!a) return fail('Kode alat tidak ditemukan');
        const id = 'PJM' + Date.now();
        await run(db, 'INSERT INTO peminjaman (id_pinjam,kode_barang,nama_barang,peminjam,jenis_peminjam,tgl_pinjam,batas_waktu,status,tgl_kembali) VALUES (?,?,?,?,?,?,?,?,?)', [id, kb, s(a.nama_barang), s(body.peminjam), s(body.jenis), today, s(body.batas), 'Dipinjam', '']);
        return json(ok({ id }, '"' + a.nama_barang + '" dipinjamkan ke ' + s(body.peminjam)));
      }
      if (method === 'PUT') {
        const id = s(body.id) || P('id');
        await run(db, 'UPDATE peminjaman SET status=\'Dikembalikan\', tgl_kembali=? WHERE id=?', [today, id]);
        return json(ok(null, 'Alat dikembalikan'));
      }
      return fail('Method not allowed', 405);
    }

    case 'scan-peminjam': {
      if (method !== 'GET') return fail('Method not allowed', 405);
      const code = P('code');
      if (!code) return fail('Parameter code wajib diisi');
      const sRow = await one(db, 'SELECT nama_siswa AS nama, kelas FROM siswa WHERE nis=?', [code]);
      if (sRow) return json(ok({ found: true, nama: sRow.nama, jenis: 'Siswa', kelas: sRow.kelas }));
      const gRow = await one(db, 'SELECT nama_guru AS nama FROM guru WHERE nip=?', [code]);
      if (gRow) return json(ok({ found: true, nama: gRow.nama, jenis: 'Guru', kelas: '' }));
      const uRow = await one(db, 'SELECT nama_lengkap AS nama, role, kelas FROM users WHERE username=?', [code]);
      if (uRow) return json(ok({ found: true, nama: uRow.nama, jenis: uRow.role, kelas: uRow.kelas }));
      return json(ok({ found: false, nama: '', jenis: '', kelas: '' }));
    }

    case 'laporan-kerusakan': {
      if (method === 'GET') {
        const rows = await all(db, 'SELECT id AS row, tanggal, kode_barang AS kodeBarang, nama_barang AS namaBarang, kerusakan, pelapor, status, jadwal_maintenance AS jadwal FROM laporan_kerusakan ORDER BY tanggal DESC, id DESC');
        return json(ok(rows));
      }
      if (method === 'POST') {
        await run(db, 'INSERT INTO laporan_kerusakan (tanggal,kode_barang,nama_barang,kerusakan,pelapor,status,jadwal_maintenance) VALUES (?,?,?,?,?,?,?)', [todayWIB(), s(body.kode), s(body.nama), s(body.kerusakan), s(body.pelapor), 'Menunggu', s(body.jadwal)]);
        return json(ok(null, 'Laporan dicatat'));
      }
      if (method === 'PUT') {
        const id = s(body.id) || P('id');
        await run(db, 'UPDATE laporan_kerusakan SET status=? WHERE id=?', [s(body.status), id]);
        return json(ok(null, 'Status diperbarui'));
      }
      if (method === 'DELETE') {
        const id = P('id') || s(body.id);
        await run(db, 'DELETE FROM laporan_kerusakan WHERE id=?', [id]);
        return json(ok(null, 'Dihapus'));
      }
      return fail('Method not allowed', 405);
    }

    // ===================== USERS =====================
    case 'users': {
      if (method === 'GET') {
        const rows = await all(db, 'SELECT id AS row, username, role, kelas, nama_lengkap AS nama, nip AS kodeGuru FROM users ORDER BY id');
        return json(ok(rows));
      }
      if (method === 'POST') {
        const ck = await one(db, 'SELECT id FROM users WHERE username=?', [s(body.username)]);
        if (ck) return fail('Username sudah dipakai');
        const hash = await hashPassword(s(body.password));
        await run(db, 'INSERT INTO users (username,password,role,kelas,nama_lengkap,nip) VALUES (?,?,?,?,?,?)', [s(body.username), hash, s(body.role), s(body.kelas), s(body.nama), s(body.kodeGuru)]);
        return json(ok(null, 'User ' + s(body.username) + ' ditambahkan (password aman)'));
      }
      if (method === 'PUT') {
        const id = s(body.id) || P('id');
        if (body.password) {
          const hash = await hashPassword(s(body.password));
          await run(db, 'UPDATE users SET username=?,password=?,role=?,kelas=?,nama_lengkap=?,nip=? WHERE id=?', [s(body.username), hash, s(body.role), s(body.kelas), s(body.nama), s(body.kodeGuru), id]);
        } else {
          await run(db, 'UPDATE users SET username=?,role=?,kelas=?,nama_lengkap=?,nip=? WHERE id=?', [s(body.username), s(body.role), s(body.kelas), s(body.nama), s(body.kodeGuru), id]);
        }
        return json(ok(null, 'User diperbarui'));
      }
      if (method === 'DELETE') {
        const id = P('id') || s(body.id);
        await run(db, 'DELETE FROM users WHERE id=?', [id]);
        return json(ok(null, 'User dihapus'));
      }
      return fail('Method not allowed', 405);
    }

    case 'settings': {
      if (method === 'GET') {
        const ta = await one(db, "SELECT setting_value FROM settings WHERE setting_key='TA_AKTIF'");
        const sm = await one(db, "SELECT setting_value FROM settings WHERE setting_key='SEMESTER'");
        return json(ok({ ta: ta ? ta.setting_value : '2025/2026', semester: sm ? sm.setting_value : '1' }));
      }
      if (method === 'POST') {
        await run(db, "UPDATE settings SET setting_value=? WHERE setting_key='TA_AKTIF'", [s(body.ta)]);
        await run(db, "UPDATE settings SET setting_value=? WHERE setting_key='SEMESTER'", [s(body.semester)]);
        return json(ok(null, 'TA aktif: ' + s(body.ta) + ' Semester ' + s(body.semester)));
      }
      return fail('Method not allowed', 405);
    }

    case 'log-aktivitas': {
      if (method === 'GET') {
        const rows = await all(db, 'SELECT substr(waktu,6,5) AS ts, username AS user, role, aksi, detail FROM log_aktivitas ORDER BY id DESC LIMIT 100');
        return json(ok(rows));
      }
      if (method === 'POST') {
        await run(db, 'INSERT INTO log_aktivitas (waktu,username,role,aksi,detail) VALUES (?,?,?,?,?)', [nowWIB(), s(body.username), s(body.role), s(body.aksi), s(body.detail)]);
        return json(ok(null, 'Log dicatat'));
      }
      return fail('Method not allowed', 405);
    }

    case 'backup-dump': {
      if (method !== 'GET') return fail('Method not allowed', 405);
      const tables = ['users', 'siswa', 'guru', 'kehadiran', 'tatatertib', 'kaskelas', 'struktur_kelas', 'inventaris', 'pengumuman', 'jadwal_pelajaran', 'jadwal_piket', 'jurnal_bimbingan', 'jurnal_mengajar', 'presensi_mapel', 'nilai', 'katalog_alat', 'bahan_praktik', 'peminjaman', 'laporan_kerusakan', 'settings', 'log_aktivitas', 'kunjungan_rumah', 'bank_soal', 'cbt_ujian', 'cbt_soal', 'cbt_sesi', 'cbt_jawaban'];
      const dump: Record<string, any> = {};
      for (const t of tables) {
        try {
          dump[t] = await all(db, 'SELECT * FROM ' + t);
        } catch {
          dump[t] = [];
        }
      }
      return json(ok(dump));
    }

    case 'rekap-data': {
      if (method !== 'GET') return fail('Method not allowed', 405);
      const kelas = P('kelas');
      const nis = P('nis');
      const start = P('start');
      const end = P('end');
      if (!kelas) return fail('Parameter kelas wajib diisi');
      let sql = 'SELECT nis, nama_siswa AS nama, jk FROM siswa WHERE kelas=?';
      const p: unknown[] = [kelas];
      if (nis) { sql += ' AND nis=?'; p.push(nis); }
      const siswa = await all(db, sql, p);
      sql = 'SELECT tanggal, nis, status FROM kehadiran WHERE kelas=? AND tanggal>=? AND tanggal<=?';
      const p2: unknown[] = [kelas, start, end];
      if (nis) { sql += ' AND nis=?'; p2.push(nis); }
      const raw = await all(db, sql, p2);
      const dates = Array.from(new Set(raw.map((r) => s(r.tanggal)))).sort();
      const res: Record<string, any>[] = [];
      for (const sis of siswa) {
        const recs: Record<string, string> = {};
        const sum = { Hadir: 0, Sakit: 0, Izin: 0, Alfa: 0 };
        for (const r of raw) {
          if (s(r.nis) === s(sis.nis)) {
            recs[s(r.tanggal)] = s(r.status);
            const st = s(r.status);
            if (sum[st as keyof typeof sum] !== undefined) sum[st as keyof typeof sum]++;
          }
        }
        res.push({ nis: sis.nis, nama: sis.nama, jk: sis.jk, records: recs, summary: sum, total: sum.Hadir + sum.Sakit + sum.Izin + sum.Alfa });
      }
      return json(ok({ students: res, dates }));
    }

    case 'laporan-admin': {
      if (method !== 'GET') return fail('Method not allowed', 405);
      const nip = P('nip');
      const kelas = P('kelas');
      const mapel = P('mapel');
      const start = P('start');
      const end = P('end');
      if (!nip || !kelas || !mapel || !start || !end) return fail('nip, kelas, mapel, start, end wajib diisi');
      const siswa = await all(db, 'SELECT nis, nama_siswa AS nama FROM siswa WHERE kelas=? ORDER BY nama_siswa', [kelas]);
      const raw = await all(db, 'SELECT tanggal, nis, status, updated_at FROM presensi_mapel WHERE nip=? AND kelas=? AND mapel=? AND tanggal>=? AND tanggal<=?', [nip, kelas, mapel, start, end]);
      let revisi = 0;
      const dates: Record<string, boolean> = {};
      const byNis: Record<string, Record<string, number>> = {};
      for (const r of raw) {
        dates[s(r.tanggal)] = true;
        if (r.updated_at) revisi++;
        const key = s(r.nis);
        if (!byNis[key]) byNis[key] = {};
        byNis[key][s(r.status)] = (byNis[key][s(r.status)] ?? 0) + 1;
      }
      const students: Record<string, any>[] = [];
      for (const sis of siswa) {
        const sm = { Hadir: 0, Sakit: 0, Izin: 0, Alfa: 0, Dispensasi: 0 };
        for (const [k, v] of Object.entries(byNis[s(sis.nis)] ?? {})) if (k in sm) sm[k as keyof typeof sm] = v;
        const tot = sm.Hadir + sm.Sakit + sm.Izin + sm.Alfa + sm.Dispensasi;
        students.push({ nis: sis.nis, nama: sis.nama, summary: sm, total: tot, pct: tot ? Math.round((sm.Hadir / tot) * 100) : 0 });
      }
      const jurnal = await all(db, 'SELECT tanggal, jam_ke AS jamKe, materi, kegiatan, status FROM jurnal_mengajar WHERE nip=? AND kelas=? AND mapel=? AND tanggal>=? AND tanggal<=? ORDER BY tanggal, jam_ke', [nip, kelas, mapel, start, end]);
      const dts = Object.keys(dates).sort();
      return json(ok({ students, dates: dts, jurnal, revisiCount: revisi }));
    }

    case 'presensi-mapel-rekap': {
      if (method !== 'GET') return fail('Method not allowed', 405);
      const nip = P('nip');
      const kelas = P('kelas');
      const mapel = P('mapel');
      const start = P('start');
      const end = P('end');
      if (!nip || !kelas || !mapel) return fail('nip, kelas, mapel wajib');
      const siswa = await all(db, 'SELECT nis, nama_siswa AS nama FROM siswa WHERE kelas=? ORDER BY nama_siswa', [kelas]);
      let raw;
      if (start && end) {
        raw = await all(db, 'SELECT tanggal, nis, status FROM presensi_mapel WHERE nip=? AND kelas=? AND mapel=? AND tanggal>=? AND tanggal<=?', [nip, kelas, mapel, start, end]);
      } else {
        raw = await all(db, 'SELECT tanggal, nis, status FROM presensi_mapel WHERE nip=? AND kelas=? AND mapel=?', [nip, kelas, mapel]);
      }
      const dates = Array.from(new Set(raw.map((r) => s(r.tanggal)))).sort();
      const res: Record<string, any>[] = [];
      for (const sis of siswa) {
        const recs: Record<string, string> = {};
        const sum = { Hadir: 0, Sakit: 0, Izin: 0, Alfa: 0, Dispensasi: 0 };
        for (const r of raw) {
          if (s(r.nis) === s(sis.nis)) {
            recs[s(r.tanggal)] = s(r.status);
            const st = s(r.status);
            if (sum[st as keyof typeof sum] !== undefined) sum[st as keyof typeof sum]++;
          }
        }
        const tot = sum.Hadir + sum.Sakit + sum.Izin + sum.Alfa + sum.Dispensasi;
        res.push({ nis: sis.nis, nama: sis.nama, records: recs, summary: sum, total: tot });
      }
      return json(ok({ students: res, dates }));
    }

    // ===================== EXTRA: GURU DASHBOARD & FITUR GURU V2 =====================
    case 'guru-dashboard': {
      if (method !== 'GET') return fail('Method not allowed', 405);
      const nip = P('nip');
      if (!nip) return fail('Parameter nip wajib diisi');
      const r: Record<string, any> = {};
      r.jurnalCount = num((await one(db, 'SELECT COUNT(*) AS c FROM jurnal_mengajar WHERE nip=?', [nip]))?.c);
      r.kelasDiampu = await all(db, 'SELECT DISTINCT kelas FROM jadwal_pelajaran WHERE nip=?', [nip]);
      r.mapelList = await all(db, 'SELECT DISTINCT mapel FROM presensi_mapel WHERE nip=?', [nip]);
      return json(ok(r));
    }

    case 'guru-profil': {
      if (method === 'GET') {
        const nip = P('nip');
        if (!nip) return fail('Parameter nip wajib diisi');
        const g = await one(db, 'SELECT nip, nama_guru AS nama, mapel, kelas_diampu AS kelasDiampu FROM guru WHERE nip=?', [nip]);
        return json(ok(g ?? {}));
      }
      if (method === 'POST') {
        const g = await one(db, 'SELECT id FROM guru WHERE nip=?', [s(body.nip)]);
        if (g) await run(db, 'UPDATE guru SET nama_guru=?, mapel=?, kelas_diampu=? WHERE nip=?', [s(body.nama), s(body.mapel), s(body.kelasDiampu), s(body.nip)]);
        else await run(db, 'INSERT INTO guru (nip,nama_guru,mapel,kelas_diampu) VALUES (?,?,?,?)', [s(body.nip), s(body.nama), s(body.mapel), s(body.kelasDiampu)]);
        return json(ok(null, 'Profil guru disimpan'));
      }
      return fail('Method not allowed', 405);
    }

    case 'materi': {
      if (method === 'GET') {
        const nip = P('nip');
        const rows = await all(db, 'SELECT id AS row, nip, judul, isi, tanggal, kelas, mapel FROM materi WHERE (?=\'\' OR nip=?) ORDER BY id DESC', [nip, nip]);
        return json(ok(rows));
      }
      if (method === 'POST') {
        await run(db, 'INSERT INTO materi (nip,judul,isi,tanggal,kelas,mapel) VALUES (?,?,?,?,?,?)', [s(body.nip), s(body.judul), s(body.isi), todayWIB(), s(body.kelas), s(body.mapel)]);
        return json(ok(null, 'Materi disimpan'));
      }
      if (method === 'DELETE') {
        const id = P('id') || s(body.id);
        await run(db, 'DELETE FROM materi WHERE id=?', [id]);
        return json(ok(null, 'Dihapus'));
      }
      return fail('Method not allowed', 405);
    }

    case 'modul-ajar': {
      if (method === 'GET') {
        const nip = P('nip');
        const rows = await all(db, 'SELECT id AS row, nip, judul, isi, tanggal FROM modul_ajar WHERE nip=? ORDER BY id DESC', [nip]);
        return json(ok(rows));
      }
      if (method === 'POST') {
        await run(db, 'INSERT INTO modul_ajar (nip,judul,isi,tanggal) VALUES (?,?,?,?)', [s(body.nip), s(body.judul), s(body.isi), todayWIB()]);
        return json(ok(null, 'Modul Ajar disimpan'));
      }
      if (method === 'DELETE') {
        const id = P('id') || s(body.id);
        await run(db, 'DELETE FROM modul_ajar WHERE id=?', [id]);
        return json(ok(null, 'Dihapus'));
      }
      return fail('Method not allowed', 405);
    }

    case 'tugas': {
      if (method === 'GET') {
        const nip = P('nip');
        const rows = await all(db, 'SELECT id AS row, mapel, judul, deskripsi, tenggat, status, kelas FROM tugas WHERE nip=? ORDER BY id DESC', [nip]);
        return json(ok(rows));
      }
      if (method === 'POST') {
        await run(db, 'INSERT INTO tugas (nip,mapel,judul,deskripsi,tenggat,status,kelas) VALUES (?,?,?,?,?,?,?)', [s(body.nip), s(body.mapel), s(body.judul), s(body.deskripsi), s(body.tenggat), s(body.status) || 'Belum', s(body.kelas)]);
        return json(ok(null, 'Tugas disimpan'));
      }
      if (method === 'DELETE') {
        const id = P('id') || s(body.id);
        await run(db, 'DELETE FROM tugas WHERE id=?', [id]);
        return json(ok(null, 'Dihapus'));
      }
      return fail('Method not allowed', 405);
    }

    case 'pengumpulan': {
      if (method === 'GET') {
        const tugasId = P('tugasId');
        const rows = await all(db, 'SELECT id AS row, tugas_id AS tugasId, nis, nama_siswa AS nama, jawaban, file_url AS fileUrl, nilai, feedback, tanggal FROM pengumpulan WHERE tugas_id=?', [tugasId]);
        return json(ok(rows));
      }
      if (method === 'PUT') {
        const id = s(body.id);
        await run(db, 'UPDATE pengumpulan SET nilai=?, feedback=? WHERE id=?', [num(body.nilai), s(body.feedback), id]);
        return json(ok(null, 'Nilai pengumpulan disimpan'));
      }
      return fail('Method not allowed', 405);
    }

    case 'catatan-perilaku': {
      if (method === 'GET') {
        const nip = P('nip');
        const kelas = P('kelas');
        let rows;
        if (kelas) rows = await all(db, 'SELECT id AS row, nis, nama_siswa AS nama, tanggal, kategori, catatan, tindak_lanjut AS tindakLanjut FROM catatan_perilaku WHERE nip=? AND kelas=? ORDER BY id DESC', [nip, kelas]);
        else rows = await all(db, 'SELECT id AS row, nis, nama_siswa AS nama, tanggal, kategori, catatan, tindak_lanjut AS tindakLanjut FROM catatan_perilaku WHERE nip=? ORDER BY id DESC', [nip]);
        return json(ok(rows));
      }
      if (method === 'POST') {
        await run(db, 'INSERT INTO catatan_perilaku (nip,nis,nama_siswa,kelas,tanggal,kategori,catatan,tindak_lanjut) VALUES (?,?,?,?,?,?,?,?)', [s(body.nip), s(body.nis), s(body.nama), s(body.kelas), todayWIB(), s(body.kategori), s(body.catatan), s(body.tindakLanjut)]);
        return json(ok(null, 'Catatan perilaku disimpan'));
      }
      if (method === 'DELETE') {
        const id = P('id') || s(body.id);
        await run(db, 'DELETE FROM catatan_perilaku WHERE id=?', [id]);
        return json(ok(null, 'Dihapus'));
      }
      return fail('Method not allowed', 405);
    }

    case 'portofolio': {
      if (method === 'GET') {
        const nip = P('nip');
        const nis = P('nis');
        let rows;
        if (nis) rows = await all(db, 'SELECT id AS row, nis, judul, deskripsi, tanggal FROM portofolio WHERE nip=? AND nis=? ORDER BY id DESC', [nip, nis]);
        else rows = await all(db, 'SELECT id AS row, nis, judul, deskripsi, tanggal FROM portofolio WHERE nip=? ORDER BY id DESC', [nip]);
        return json(ok(rows));
      }
      if (method === 'POST') {
        await run(db, 'INSERT INTO portofolio (nip,nis,judul,deskripsi,tanggal) VALUES (?,?,?,?,?)', [s(body.nip), s(body.nis), s(body.judul), s(body.deskripsi), todayWIB()]);
        return json(ok(null, 'Portofolio disimpan'));
      }
      if (method === 'DELETE') {
        const id = P('id') || s(body.id);
        await run(db, 'DELETE FROM portofolio WHERE id=?', [id]);
        return json(ok(null, 'Dihapus'));
      }
      return fail('Method not allowed', 405);
    }

    case 'rubrik': {
      if (method === 'GET') {
        const nip = P('nip');
        const rows = await all(db, 'SELECT id AS row, nip, nama, komponen, tanggal FROM rubrik WHERE (?=\'\' OR nip=?) ORDER BY id DESC', [nip, nip]);
        return json(ok(rows));
      }
      if (method === 'POST') {
        await run(db, 'INSERT INTO rubrik (nip,nama,komponen,tanggal) VALUES (?,?,?,?)', [s(body.nip), s(body.nama), s(body.komponen), todayWIB()]);
        return json(ok(null, 'Rubrik disimpan'));
      }
      if (method === 'DELETE') {
        const id = P('id') || s(body.id);
        await run(db, 'DELETE FROM rubrik WHERE id=?', [id]);
        return json(ok(null, 'Dihapus'));
      }
      return fail('Method not allowed', 405);
    }

    case 'agenda': {
      if (method === 'GET') {
        const nip = P('nip');
        const rows = await all(db, 'SELECT id AS row, nip, judul, tanggal, jam, catatan FROM agenda WHERE (?=\'\' OR nip=?) ORDER BY tanggal DESC, id DESC', [nip, nip]);
        return json(ok(rows));
      }
      if (method === 'POST') {
        await run(db, 'INSERT INTO agenda (nip,judul,tanggal,jam,catatan) VALUES (?,?,?,?,?)', [s(body.nip), s(body.judul), s(body.tanggal), s(body.jam), s(body.catatan)]);
        return json(ok(null, 'Agenda disimpan'));
      }
      if (method === 'DELETE') {
        const id = P('id') || s(body.id);
        await run(db, 'DELETE FROM agenda WHERE id=?', [id]);
        return json(ok(null, 'Dihapus'));
      }
      return fail('Method not allowed', 405);
    }

    case 'presensi-guru': {
      if (method === 'GET') {
        const nip = P('nip');
        const rows = await all(db, 'SELECT id AS row, nip, tanggal, status, keterangan FROM presensi_guru WHERE (?=\'\' OR nip=?) ORDER BY tanggal DESC, id DESC', [nip, nip]);
        return json(ok(rows));
      }
      if (method === 'POST') {
        await run(db, 'INSERT INTO presensi_guru (nip,tanggal,status,keterangan) VALUES (?,?,?,?)', [s(body.nip), s(body.tanggal) || todayWIB(), s(body.status), s(body.keterangan)]);
        return json(ok(null, 'Presensi guru disimpan'));
      }
      return fail('Method not allowed', 405);
    }

    // ===================== CBT SETUP =====================
    case 'setup-cbt': {
      if (method !== 'POST') return fail('Method not allowed', 405);
      const ddl = [
        `CREATE TABLE IF NOT EXISTS bank_soal (id INTEGER PRIMARY KEY AUTOINCREMENT, nip TEXT, mapel TEXT, kelas TEXT DEFAULT '', jenis INTEGER, soal TEXT, opsi TEXT, kunci TEXT, pembahasan TEXT, bobot INTEGER DEFAULT 1, tanggal TEXT)`,
        `CREATE TABLE IF NOT EXISTS cbt_ujian (id INTEGER PRIMARY KEY AUTOINCREMENT, nip TEXT, judul TEXT, kelas TEXT, mapel TEXT, durasi_menit INTEGER DEFAULT 60, token TEXT, aktif INTEGER DEFAULT 1, tanggal TEXT, ai_aktif INTEGER DEFAULT 0)`,
        `CREATE TABLE IF NOT EXISTS cbt_soal (id INTEGER PRIMARY KEY AUTOINCREMENT, ujian_id INTEGER, no_urut INTEGER, jenis INTEGER, soal TEXT, opsi TEXT, kunci TEXT, pembahasan TEXT, bobot INTEGER DEFAULT 1)`,
        `CREATE TABLE IF NOT EXISTS cbt_sesi (id INTEGER PRIMARY KEY AUTOINCREMENT, ujian_id INTEGER, nis TEXT, nama TEXT, mulai TEXT, deadline TEXT, selesai INTEGER DEFAULT 0, skor REAL, total_benar INTEGER DEFAULT 0, total_soal INTEGER DEFAULT 0, uraian_menunggu INTEGER DEFAULT 0)`,
        `CREATE TABLE IF NOT EXISTS cbt_jawaban (id INTEGER PRIMARY KEY AUTOINCREMENT, sesi_id INTEGER, soal_id INTEGER, jawaban TEXT, benar INTEGER, feedback TEXT, sumber TEXT DEFAULT 'manual', UNIQUE(sesi_id,soal_id))`,
      ];
      let okCount = 0;
      const errs: string[] = [];
      for (const sql of ddl) {
        try {
          await run(db, sql);
          okCount++;
        } catch (e: unknown) {
          errs.push(String(e instanceof Error ? e.message : e));
        }
      }
      return json(ok({ ok: okCount, errors: errs }, 'Setup CBT selesai'));
    }

    case 'setup-banksoal': {
      const okCount: number[] = [];
      const errs: string[] = [];
      try {
        await run(db, 'DROP TABLE IF EXISTS bank_soal');
        await run(db, "CREATE TABLE bank_soal (id INTEGER PRIMARY KEY AUTOINCREMENT, nip TEXT NOT NULL, mapel TEXT, kelas TEXT DEFAULT '', jenis INTEGER DEFAULT 1, soal TEXT, opsi TEXT, kunci TEXT, pembahasan TEXT, bobot INTEGER DEFAULT 1, tanggal TEXT)");
        okCount.push(1);
      } catch (e: unknown) {
        errs.push(String(e instanceof Error ? e.message : e));
      }
      return json(ok({ ok: okCount.length, errors: errs }, 'Bank Soal siap'));
    }

    // ===================== BANK SOAL =====================
    case 'bank-soal':
    case 'bank-soal-cbt': {
      if (method === 'GET') {
        const nip = P('nip');
        if (!nip) return fail('nip wajib');
        const mapel = P('mapel');
        const kelas = P('kelas');
        const rows = await all(db, 'SELECT id AS row, nip, mapel, kelas, jenis, soal, opsi, kunci, pembahasan, bobot, tanggal FROM bank_soal WHERE nip=? AND (mapel=? OR ?=\'\') AND (kelas=? OR ?=\'\') ORDER BY id DESC', [nip, mapel, mapel, kelas, kelas]);
        for (const r of rows) {
          r.opsiArr = JSON.parse(s(r.opsi) || '[]') as string[] || [];
          r.kunciArr = num(r.jenis) === 3 ? JSON.parse(s(r.kunci) || '[]') || [] : null;
        }
        return json(ok(rows));
      }
      if (method === 'POST') {
        const nip = s(body.nip);
        const mapel = s(body.mapel);
        const kelas = s(body.kelas);
        if (!nip) return fail('nip wajib');
        let soal: Record<string, any>[] = Array.isArray(body.soal) ? body.soal : [];
        if (!soal.length) {
          if (body.pertanyaan !== undefined || body.soal_text !== undefined) soal = [body];
          else return fail('Tidak ada soal untuk disimpan');
        }
        let n = 0;
        for (const sItem of soal) {
          let jenis = num(sItem.jenis ?? 1);
          if (typeof sItem.jenis === 'string') {
            const jenisMap: Record<string, number> = { 'PG': 1, 'Essay': 5, 'Benar/Salah': 1, 'Isian': 4 };
            jenis = jenisMap[sItem.jenis] ?? 1;
          }
          const opsi = Array.isArray(sItem.opsi) ? sItem.opsi : [];
          let kunci = sItem.kunci ?? '';
          if (Array.isArray(kunci)) kunci = JSON.stringify(kunci);
          const teksSoal = sItem.soal ?? sItem.pertanyaan ?? sItem.soal_text ?? '';
          const mapelItem = sItem.mapel ?? mapel;
          const kelasItem = sItem.kelas ?? kelas;
          await run(db, 'INSERT INTO bank_soal (nip,mapel,kelas,jenis,soal,opsi,kunci,pembahasan,bobot,tanggal) VALUES (?,?,?,?,?,?,?,?,?,?)', [nip, mapelItem, kelasItem, jenis, teksSoal, JSON.stringify(opsi), String(kunci), s(sItem.pembahasan), num(sItem.bobot) || 1, todayWIB()]);
          n++;
        }
        return json(ok({ inserted: n }, n + ' soal tersimpan ke bank'));
      }
      if (method === 'DELETE') {
        let ids = body.ids;
        if ((ids === null || ids === '') && P('ids')) ids = P('ids').split(',');
        if (Array.isArray(ids) && ids.length) {
          const idsArr = ids.map((x: any) => num(x));
          for (const id of idsArr) await run(db, 'DELETE FROM bank_soal WHERE id=?', [id]);
          return json(ok(null, idsArr.length + ' soal dihapus dari bank'));
        }
        const id = P('id') || s(body.id);
        await run(db, 'DELETE FROM bank_soal WHERE id=?', [id]);
        return json(ok(null, 'Soal dihapus dari bank'));
      }
      return fail('Method not allowed', 405);
    }

    // ===================== CBT: GURU =====================
    case 'cbt-exam': {
      if (method === 'GET') {
        const nip = P('nip');
        if (!nip) return fail('nip wajib');
        const rows = await all(
          db,
          `SELECT u.id AS row, u.judul, u.kelas, u.mapel, u.durasi_menit AS durasi, u.token, u.aktif, COALESCE(u.ai_aktif,0) AS ai_aktif, u.tanggal,
                  (SELECT COUNT(*) FROM cbt_soal WHERE ujian_id=u.id) AS jmlSoal,
                  (SELECT COUNT(*) FROM cbt_soal WHERE ujian_id=u.id AND jenis=1) AS jmlPG,
                  (SELECT COUNT(*) FROM cbt_soal WHERE ujian_id=u.id AND jenis=5) AS jmlEssay,
                  (SELECT COUNT(DISTINCT nis) FROM cbt_sesi WHERE ujian_id=u.id) AS peserta,
                  (SELECT AVG(skor) FROM cbt_sesi WHERE ujian_id=u.id AND selesai=1) AS rata
           FROM cbt_ujian u WHERE u.nip=? ORDER BY u.id DESC`, [nip],
        );
        for (const r of rows) {
          r.status = num(r.aktif) ? 'Aktif' : 'Selesai';
          if (r.rata !== null && r.rata !== undefined) r.rata = Math.round(num(r.rata) * 10) / 10;
        }
        return json(ok(rows));
      }
      if (method === 'POST') {
        const nip = s(body.nip);
        const kelas = s(body.kelas);
        const mapel = s(body.mapel);
        const judul = s(body.judul) || 'Ulangan';
        let dur = num(body.durasi) || 30;
        if (dur < 1) dur = 30;
        const ai = body.ai ? 1 : 0;
        const token = randomToken(6);
        const uid = await insertId(db, 'INSERT INTO cbt_ujian (nip,judul,kelas,mapel,durasi_menit,token,aktif,ai_aktif,tanggal) VALUES (?,?,?,?,?,?,1,?,?)', [nip, judul, kelas, mapel, dur, token, ai, todayWIB()]);
        if (Array.isArray(body.soalIds) && body.soalIds.length) {
          for (const sid of body.soalIds) {
            const sRow = await one(db, 'SELECT jenis, soal, opsi, kunci, pembahasan, bobot FROM bank_soal WHERE id=?', [sid]);
            if (sRow) {
              const maxNo = await one(db, 'SELECT COALESCE(MAX(no_urut),0) AS m FROM cbt_soal WHERE ujian_id=?', [uid]);
              await run(db, 'INSERT INTO cbt_soal (ujian_id,no_urut,jenis,soal,opsi,kunci,pembahasan,bobot) VALUES (?,?,?,?,?,?,?,?)', [uid, num(maxNo?.m) + 1, num(sRow.jenis), sRow.soal, sRow.opsi, sRow.kunci, sRow.pembahasan, num(sRow.bobot) || 1]);
            }
          }
        }
        return json(ok({ id: uid, token }, 'Ujian dibuat. Token: ' + token));
      }
      if (method === 'PUT') {
        const id = num(body.id);
        const status = s(body.status) || 'Aktif';
        const aktif = status === 'Aktif' ? 1 : 0;
        await run(db, 'UPDATE cbt_ujian SET aktif=? WHERE id=?', [aktif, id]);
        return json(ok(null, 'Status ujian diperbarui'));
      }
      if (method === 'DELETE') {
        const id = P('id') || s(body.id);
        await run(db, 'DELETE FROM cbt_jawaban WHERE sesi_id IN (SELECT id FROM cbt_sesi WHERE ujian_id=?)', [id]);
        await run(db, 'DELETE FROM cbt_sesi WHERE ujian_id=?', [id]);
        await run(db, 'DELETE FROM cbt_soal WHERE ujian_id=?', [id]);
        await run(db, 'DELETE FROM cbt_ujian WHERE id=?', [id]);
        return json(ok(null, 'Ujian dihapus'));
      }
      return fail('Method not allowed', 405);
    }

    case 'cbt-get-ujian': {
      if (method !== 'GET') return fail('Method not allowed', 405);
      const id = P('id');
      if (!id) return fail('id wajib');
      const u = await one(db, 'SELECT * FROM cbt_ujian WHERE id=?', [id]);
      if (!u) return fail('Ujian tidak ditemukan');
      u.soal = await all(db, 'SELECT * FROM cbt_soal WHERE ujian_id=? ORDER BY no_urut', [id]);
      return json(ok(u));
    }

    case 'cbt-hasil-guru': {
      if (method !== 'GET') return fail('Method not allowed', 405);
      const id = P('id');
      if (!id) return fail('id wajib');
      const rows = await all(db, 'SELECT s.id AS sesiId, s.nis, s.nama, s.skor, s.total_benar AS benar, s.total_soal AS total, s.uraian_menunggu AS uraian, s.selesai, s.mulai FROM cbt_sesi s WHERE s.ujian_id=? ORDER BY s.selesai DESC, s.skor DESC', [id]);
      return json(ok(rows));
    }

    // ===================== CBT: SISWA =====================
    case 'cbt-mulai': {
      if (method !== 'POST') return fail('Method not allowed', 405);
      const token = s(body.token).trim().toUpperCase();
      const nis = s(body.nis);
      const nama = s(body.nama);
      const kelas = s(body.kelas);
      if (!token || !nis) return fail('Token dan NIS wajib');
      const u = await one(db, 'SELECT id, judul, mapel, durasi_menit AS durasi, kelas, COALESCE(ai_aktif,0) AS ai_aktif FROM cbt_ujian WHERE token=? AND aktif=1', [token]);
      if (!u) return fail('Token tidak valid atau ujian sudah ditutup');
      if (kelas && u.kelas && u.kelas !== kelas) return fail('Ujian ini untuk kelas ' + u.kelas);
      const uid = num(u.id);
      const dur = num(u.durasi);
      const sesi = await one(db, 'SELECT id, deadline, selesai, skor FROM cbt_sesi WHERE ujian_id=? AND nis=? LIMIT 1', [uid, nis]);
      if (sesi && num(sesi.selesai) === 1) {
        return json(ok({ sudah: true, total: sesi.skor }));
      }
      let sid: number;
      let sisaDetik: number;
      if (!sesi) {
        sid = await insertId(db, 'INSERT INTO cbt_sesi (ujian_id,nis,nama,mulai,deadline,selesai) VALUES (?,?,?,?,?,0)', [uid, nis, nama, nowWIB(), addMinutesWib(nowWIB(), dur)]);
        sisaDetik = dur * 60;
      } else {
        sid = num(sesi.id);
        sisaDetik = Math.max(0, Math.floor((wibToEpoch(s(sesi.deadline)) - Date.now()) / 1000));
      }
      const soal = await all(db, 'SELECT id, id AS soalId, no_urut AS no, jenis, soal AS pertanyaan, opsi, pembahasan, bobot FROM cbt_soal WHERE ujian_id=? ORDER BY no_urut', [uid]);
      for (const r of soal) {
        r.opsiArr = JSON.parse(s(r.opsi) || '[]') as string[] || [];
        delete r.opsi;
        r.jenis = num(r.jenis) === 5 ? 'Essay' : 'PG';
      }
      const savedRows = await all(db, 'SELECT soal_id, jawaban FROM cbt_jawaban WHERE sesi_id=?', [sid]);
      const saved: Record<string, string> = {};
      for (const x of savedRows) saved[s(x.soal_id)] = s(x.jawaban);
      return json(ok({ sesiId: sid, sisaDetik, judul: u.judul, mapel: u.mapel, ai: num(u.ai_aktif), soal, saved }));
    }

    case 'cbt-simpan-jawaban': {
      if (method !== 'POST') return fail('Method not allowed', 405);
      const sesiId = num(body.sesiId);
      const soalId = num(body.soalId);
      const jw = body.jawaban ?? '';
      if (!sesiId || !soalId) return fail('sesiId & soalId wajib');
      const ex = await one(db, 'SELECT id FROM cbt_jawaban WHERE sesi_id=? AND soal_id=?', [sesiId, soalId]);
      if (ex) await run(db, 'UPDATE cbt_jawaban SET jawaban=? WHERE sesi_id=? AND soal_id=?', [jw, sesiId, soalId]);
      else await run(db, 'INSERT INTO cbt_jawaban (sesi_id,soal_id,jawaban) VALUES (?,?,?)', [sesiId, soalId, jw]);
      return json(ok(null, 'ok'));
    }

    case 'cbt-simpan-batch': {
      if (method !== 'POST') return fail('Method not allowed', 405);
      const sesiId = num(body.sesiId);
      const arr: Record<string, any>[] = Array.isArray(body.jawaban) ? body.jawaban : [];
      if (!sesiId) return fail('sesiId wajib');
      for (const x of arr) {
        const soalId = num(x.soalId);
        if (!soalId) continue;
        const jw = x.jawaban ?? '';
        const ex = await one(db, 'SELECT id FROM cbt_jawaban WHERE sesi_id=? AND soal_id=?', [sesiId, soalId]);
        if (ex) await run(db, 'UPDATE cbt_jawaban SET jawaban=? WHERE sesi_id=? AND soal_id=?', [jw, sesiId, soalId]);
        else await run(db, 'INSERT INTO cbt_jawaban (sesi_id,soal_id,jawaban) VALUES (?,?,?)', [sesiId, soalId, jw]);
      }
      return json(ok(null, 'batch tersimpan'));
    }

    case 'cbt-kumpulkan': {
      if (method !== 'POST') return fail('Method not allowed', 405);
      const sesiId = num(body.sesiId);
      if (!sesiId) return fail('sesiId wajib');
      const result = await finalizeSesi(db, sesiId, false);
      return json(ok(result, 'Kumpulkan selesai'));
    }

    case 'cbt-cleanup-expired': {
      if (method !== 'POST') return fail('Method not allowed', 405);
      const expired = await all(db, "SELECT id FROM cbt_sesi WHERE selesai=0 AND deadline < datetime('now','+7 hours')");
      let count = 0;
      for (const row of expired) {
        await finalizeSesi(db, num(row.id), false);
        count++;
      }
      return json(ok({ finalized: count }, count + ' sesi difinalisasi otomatis'));
    }

    case 'cbt-hasil': {
      if (method !== 'GET') return fail('Method not allowed', 405);
      const examId = P('examId');
      if (!examId) return fail('examId wajib');
      const rows = await all(
        db,
        `SELECT s.nis, s.nama, s.skor AS total, s.selesai, s.uraian_menunggu,
                (SELECT COALESCE(SUM(j.benar),0) FROM cbt_jawaban j JOIN cbt_soal q ON q.id=j.soal_id WHERE j.sesi_id=s.id AND q.jenis!=5) AS pgPoin,
                (SELECT COALESCE(SUM(q.bobot),0) FROM cbt_soal q WHERE q.ujian_id=s.ujian_id AND q.jenis!=5) AS pgTotal,
                (SELECT COALESCE(SUM(j.benar),0) FROM cbt_jawaban j JOIN cbt_soal q ON q.id=j.soal_id WHERE j.sesi_id=s.id AND q.jenis=5) AS esPoin,
                (SELECT COALESCE(SUM(q.bobot),0) FROM cbt_soal q WHERE q.ujian_id=s.ujian_id AND q.jenis=5) AS esTotal
         FROM cbt_sesi s WHERE s.ujian_id=? ORDER BY s.selesai DESC, s.skor DESC`, [examId],
      );
      for (const r of rows) {
        r.status = num(r.selesai) ? 'Selesai' : 'Berlangsung';
        const pgPoin = num(r.pgPoin);
        const pgTotal = num(r.pgTotal);
        const esPoin = num(r.esPoin);
        const esTotal = num(r.esTotal);
        r.nilaiPg = pgTotal > 0 ? Math.round((pgPoin / pgTotal) * 100 * 100) / 100 : null;
        if (num(r.selesai) === 1 && esTotal > 0 && num(r.uraian_menunggu) === 0) {
          r.nilaiEssay = Math.round((esPoin / esTotal) * 100 * 100) / 100;
          r.total = (pgTotal + esTotal) > 0 ? Math.round(((pgPoin + esPoin) / (pgTotal + esTotal)) * 100 * 100) / 100 : r.total;
        } else {
          r.nilaiEssay = null;
          r.total = r.nilaiPg;
        }
      }
      return json(ok(rows));
    }

    case 'cbt-essay': {
      if (method === 'GET') {
        const examId = P('examId');
        if (!examId) return fail('examId wajib');
        const rows = await all(
          db,
          `SELECT j.id, j.jawaban, j.benar AS nilai, j.feedback, j.sumber, j.sesi_id AS sesiId, j.soal_id AS soalId,
                  s.nis, s.nama, q.soal AS pertanyaan, q.kunci, q.bobot
           FROM cbt_jawaban j JOIN cbt_sesi s ON s.id=j.sesi_id JOIN cbt_soal q ON q.id=j.soal_id
           WHERE s.ujian_id=? AND q.jenis=5 ORDER BY s.nama`, [examId],
        );
        for (const r of rows) r.status = r.nilai !== null && r.nilai !== undefined ? 'dinilai' : 'pending';
        return json(ok(rows));
      }
      if (method === 'PUT') {
        const id = num(body.id);
        const nilai = num(body.nilai);
        const feedback = body.feedback ?? null;
        const sumber = s(body.sumber) || 'manual';
        if (feedback !== null) await run(db, 'UPDATE cbt_jawaban SET benar=?, feedback=?, sumber=? WHERE id=?', [nilai, feedback, sumber, id]);
        else await run(db, 'UPDATE cbt_jawaban SET benar=?, sumber=? WHERE id=?', [nilai, sumber, id]);
        const row = await one(db, 'SELECT sesi_id FROM cbt_jawaban WHERE id=?', [id]);
        if (row) await finalizeSesi(db, num(row.sesi_id), true);
        return json(ok(null, 'Nilai essay disimpan'));
      }
      return fail('Method not allowed', 405);
    }

    case 'cbt-essay-detail': {
      if (method !== 'GET') return fail('Method not allowed', 405);
      const id = P('id');
      if (!id) return fail('id wajib');
      const row = await one(
        db,
        `SELECT j.jawaban, j.benar AS nilai, j.feedback, j.sumber, j.sesi_id AS sesiId, j.soal_id AS soalId,
                q.soal AS pertanyaan, q.kunci, q.bobot
         FROM cbt_jawaban j JOIN cbt_soal q ON q.id=j.soal_id WHERE j.id=?`, [id],
      );
      if (!row) return fail('Jawaban tidak ditemukan');
      row.status = row.nilai !== null && row.nilai !== undefined ? 'dinilai' : 'pending';
      return json(ok(row));
    }

    case 'cbt-ai-toggle': {
      if (method !== 'POST') return fail('Method not allowed', 405);
      const id = num(body.id);
      const ai = body.ai ? 1 : 0;
      if (!id) return fail('id wajib');
      await run(db, 'UPDATE cbt_ujian SET ai_aktif=? WHERE id=?', [ai, id]);
      return json(ok(null, 'Koreksi AI ' + (ai ? 'diaktifkan' : 'dinonaktifkan')));
    }

    case 'cbt-riwayat-siswa': {
      if (method !== 'GET') return fail('Method not allowed', 405);
      const nis = P('nis');
      if (!nis) return fail('nis wajib');
      const rows = await all(db, 'SELECT u.judul, u.mapel, u.kelas, s.skor AS total, u.tanggal FROM cbt_sesi s JOIN cbt_ujian u ON u.id=s.ujian_id WHERE s.nis=? AND s.selesai=1 ORDER BY s.id DESC', [nis]);
      return json(ok(rows));
    }

    // ===================== AI FEATURES =====================
    case 'ai-data-summary': {
      if (method !== 'GET') return fail('Method not allowed', 405);
      const kelas = P('kelas');
      const type = P('type') || 'dashboard';
      const from = P('date_from');
      const to = P('date_to');
      if (!kelas) return fail('Parameter kelas wajib diisi');
      const data: Record<string, any> = { type, kelas, periode: (from || 'semua') + ' s/d ' + (to || 'sekarang') };
      switch (type) {
        case 'tugas': {
          let where = 'kelas = ?';
          const params: unknown[] = [kelas];
          if (from) { where += ' AND tanggal >= ?'; params.push(from); }
          if (to) { where += ' AND tanggal <= ?'; params.push(to); }
          data.records = await all(db, 'SELECT id, mapel, judul, deskripsi, tenggat, status FROM tugas WHERE ' + where + ' ORDER BY tenggat DESC LIMIT 50', params);
          break;
        }
        case 'presensi':
          data.records = await all(db, 'SELECT tanggal, status, COUNT(*) AS c FROM kehadiran WHERE kelas=? GROUP BY tanggal, status ORDER BY tanggal DESC LIMIT 50', [kelas]);
          break;
        case 'nilai':
          data.records = await all(db, 'SELECT nis, nama_siswa AS nama, mapel, AVG(nilai) AS rata, COUNT(*) AS total FROM nilai WHERE kelas=? GROUP BY nis, mapel ORDER BY mapel LIMIT 50', [kelas]);
          break;
        case 'jurnal':
          data.records = await all(db, 'SELECT tanggal, mapel, materi, kegiatan FROM jurnal_mengajar WHERE kelas=? ORDER BY tanggal DESC LIMIT 50', [kelas]);
          break;
        case 'pengumuman':
          data.records = await all(db, 'SELECT judul, isi, tanggal, penulis FROM pengumuman WHERE kelas=? ORDER BY tanggal DESC LIMIT 50', [kelas]);
          break;
        default: {
          const today = todayWIB();
          data.total_siswa = num((await one(db, 'SELECT COUNT(*) AS c FROM siswa WHERE kelas=?', [kelas]))?.c);
          const pres = await all(db, 'SELECT status, COUNT(*) AS c FROM kehadiran WHERE kelas=? AND tanggal=? GROUP BY status', [kelas, today]);
          const p = { Hadir: 0, Sakit: 0, Izin: 0, Alfa: 0 };
          for (const r of pres) { const st = s(r.status); if (st in p) p[st as keyof typeof p] = num(r.c); }
          data.presensi_hari_ini = p;
          data.total_pelanggaran = num((await one(db, 'SELECT COUNT(*) AS c FROM tatatertib WHERE kelas=?', [kelas]))?.c);
          const kas = await one(db, 'SELECT COALESCE(SUM(CASE WHEN jenis=\'Masuk\' THEN jumlah ELSE 0 END),0) AS m, COALESCE(SUM(CASE WHEN jenis=\'Keluar\' THEN jumlah ELSE 0 END),0) AS k FROM kaskelas WHERE kelas=?', [kelas]);
          data.kas_saldo = num(kas?.m) - num(kas?.k);
          break;
        }
      }
      return json(ok(data));
    }

    case 'ai-search-filter': {
      if (method !== 'POST') return fail('Method not allowed', 405);
      const kelas = s(body.kelas) || P('kelas');
      const table = s(body.table);
      const filters: Record<string, any>[] = Array.isArray(body.filters) ? body.filters : [];
      let limit = num(body.limit) || 100;
      let offset = num(body.offset) || 0;
      if (!kelas) return fail('Parameter kelas wajib diisi');
      if (!table) return fail('Parameter table wajib diisi');
      const allowedTables = ['kehadiran', 'nilai', 'tatatertib', 'jurnal_mengajar', 'jurnal_bimbingan', 'siswa', 'katalog_alat', 'bahan_praktik', 'peminjaman', 'kaskelas', 'pengumuman', 'kunjungan_rumah', 'presensi_mapel', 'tugas'];
      if (!allowedTables.includes(table)) return fail('Table tidak diizinkan: ' + table, 400);
      const allowedFields: Record<string, string[]> = {
        kehadiran: ['tanggal', 'nis', 'status', 'keterangan'],
        nilai: ['nis', 'mapel', 'jenis', 'nilai', 'tanggal'],
        tatatertib: ['tanggal', 'nis', 'pelanggaran', 'poin'],
        jurnal_mengajar: ['tanggal', 'nip', 'mapel', 'jam_ke', 'materi', 'kegiatan'],
        jurnal_bimbingan: ['tanggal', 'nis', 'kategori', 'isi', 'tindak_lanjut'],
        siswa: ['nis', 'nama_siswa', 'jk', 'ttl', 'alamat', 'no_wa', 'ekstra'],
        katalog_alat: ['kode', 'nama_barang', 'spesifikasi', 'jumlah', 'kondisi', 'lokasi'],
        bahan_praktik: ['kode', 'nama_bahan', 'satuan', 'stok', 'stok_min', 'kategori'],
        peminjaman: ['id_pinjam', 'kode_barang', 'nama_barang', 'peminjam', 'jenis_peminjam', 'tgl_pinjam', 'batas_waktu', 'status', 'tgl_kembali'],
        kaskelas: ['tanggal', 'jenis', 'jumlah', 'keterangan'],
        pengumuman: ['judul', 'isi', 'tanggal', 'penulis'],
        kunjungan_rumah: ['tanggal', 'nis', 'nama_siswa', 'alamat', 'hasil', 'tindak_lanjut', 'petugas'],
        presensi_mapel: ['tanggal', 'nis', 'nip', 'mapel', 'status', 'jam_ke'],
        tugas: ['id', 'mapel', 'judul', 'deskripsi', 'tenggat', 'status'],
      };
      const tableFields = allowedFields[table] ?? [];
      const opMap: Record<string, string> = { eq: '=', neq: '!=', gt: '>', gte: '>=', lt: '<', lte: '<=', like: 'LIKE', not_like: 'NOT LIKE', in: 'IN', not_in: 'NOT IN', between: 'BETWEEN' };
      const whereParts = ['kelas = ?'];
      const params: unknown[] = [kelas];
      for (const f of filters) {
        const field = s(f.field);
        const op = s(f.operator) || 'eq';
        const val = f.value;
        if (!field || !tableFields.includes(field)) continue;
        const sqlOp = opMap[op] ?? '=';
        if (op === 'between' && Array.isArray(val) && val.length === 2) {
          whereParts.push(`${field} ${sqlOp} ? AND ?`);
          params.push(val[0], val[1]);
        } else if ((op === 'in' || op === 'not_in') && Array.isArray(val)) {
          whereParts.push(`${field} ${sqlOp} (${val.map(() => '?').join(',')})`);
          params.push(...val);
        } else if (op === 'like' || op === 'not_like') {
          whereParts.push(`${field} ${sqlOp} ?`);
          params.push('%' + s(val) + '%');
        } else {
          whereParts.push(`${field} ${sqlOp} ?`);
          params.push(val ?? '');
        }
      }
      const whereSql = whereParts.join(' AND ');
      const total = num((await one(db, `SELECT COUNT(*) AS c FROM ${table} WHERE ${whereSql}`, params))?.c);
      params.push(limit, offset);
      const records = await all(db, `SELECT * FROM ${table} WHERE ${whereSql} ORDER BY id DESC LIMIT ? OFFSET ?`, params);
      return json(ok({ records, total, limit, offset, table }));
    }

    default:
      return fail('Action tidak valid: ' + action, 400);
  }
}

// ============================================================
// CBT FINALISASI — port `_cbt_finalisasi` (PHP)
// ============================================================
async function finalizeSesi(db: D1Database, sid: number, recalc: boolean) {
  const sSesi = await one(db, 'SELECT selesai, ujian_id, deadline FROM cbt_sesi WHERE id=?', [sid]);
  if (!sSesi) return { skor: null, benar: 0, total: 0, uraian: 0 };
  if (!recalc && num(sSesi.selesai) === 1) {
    const f = await one(db, 'SELECT skor, total_benar, total_soal, uraian_menunggu FROM cbt_sesi WHERE id=?', [sid]);
    return { skor: f?.skor ?? null, benar: num(f?.total_benar), total: num(f?.total_soal), uraian: num(f?.uraian_menunggu) };
  }
  const uid = num(sSesi.ujian_id);
  const soalRows = await all(db, 'SELECT id, jenis, kunci, bobot FROM cbt_soal WHERE ujian_id=?', [uid]);
  const soal: Record<number, Record<string, any>> = {};
  for (const r of soalRows) soal[num(r.id)] = r;
  const jwRows = await all(db, 'SELECT soal_id, jawaban, benar FROM cbt_jawaban WHERE sesi_id=?', [sid]);
  const jw: Record<number, string> = {};
  const jbenar: Record<number, number | null> = {};
  for (const x of jwRows) {
    jw[num(x.soal_id)] = s(x.jawaban);
    jbenar[num(x.soal_id)] = x.benar !== null && x.benar !== undefined ? num(x.benar) : null;
  }

  let pgPoin = 0, pgTotal = 0, esPoin = 0, esTotal = 0, esMenunggu = 0;
  for (const [sidKey, meta] of Object.entries(soal)) {
    const so = num(sidKey);
    const jenis = num(meta.jenis);
    const bobot = num(meta.bobot) || 1;
    const jawab = jw[so] ?? null;
    if (jenis === 5) {
      esTotal += bobot;
      if (jbenar[so] !== undefined && jbenar[so] !== null) esPoin += jbenar[so]!;
      else if (jawab !== null && jawab !== '') esMenunggu++;
      continue;
    }
    pgTotal += bobot;
    let okVal = 0;
    const kunci = s(meta.kunci);
    if (jenis === 1) {
      okVal = jawab?.trim().toUpperCase() === kunci.trim().toUpperCase() ? 1 : 0;
    } else if (jenis === 2) {
      const ka = (kunci.split(',')).map((x) => x.trim()).filter(Boolean).sort();
      const va = (Array.isArray(jawab) ? jawab : safeJson(jawab)).sort();
      okVal = JSON.stringify(ka) === JSON.stringify(va) ? 1 : 0;
    } else if (jenis === 3) {
      const ka = safeJson(kunci) as Record<string, any>;
      const va = (Array.isArray(jawab) ? jawab : safeJson(jawab)) as Record<string, any>;
      const norm = (a: any) => {
        const o: Record<string, any> = {};
        if (Array.isArray(a)) for (const p of a) if (p && p.b !== undefined && p.k !== undefined) o[p.b] = p.k;
        else for (const k of Object.keys(a ?? {})) o[k] = (a as Record<string, any>)[k];
        return Object.keys(o).sort().map((k) => [k, o[k]]);
      };
      okVal = JSON.stringify(norm(ka)) === JSON.stringify(norm(va)) ? 1 : 0;
    } else if (jenis === 4) {
      const a = (jawab || '').toLowerCase().trim();
      const k = kunci.toLowerCase().trim();
      okVal = a !== '' && k !== '' && (a === k || a.includes(k) || k.includes(a)) ? 1 : 0;
    }
    if (okVal) pgPoin += bobot;
    await run(db, 'UPDATE cbt_jawaban SET benar=? WHERE sesi_id=? AND soal_id=?', [okVal, sid, so]);
  }
  let skor: number | null;
  if (pgTotal > 0 && esMenunggu === 0 && esPoin > 0) {
    const totalBobot = pgTotal + esTotal;
    skor = totalBobot > 0 ? Math.round(((pgPoin + esPoin) / totalBobot) * 10000) / 100 : null;
  } else {
    skor = pgTotal > 0 ? Math.round((pgPoin / pgTotal) * 10000) / 100 : null;
  }
  await run(db, 'UPDATE cbt_sesi SET selesai=1, skor=?, total_benar=?, total_soal=?, uraian_menunggu=? WHERE id=?', [skor, pgPoin, pgTotal, esMenunggu, sid]);
  return { skor, benar: pgPoin, total: pgTotal, uraian: esMenunggu };
}

function safeJson(v: unknown): any {
  try {
    return JSON.parse(s(v));
  } catch {
    return [];
  }
}

// ============================================================
// Export agar diakses modul lain (mis. bridge CBT)
// ============================================================
export const cbtFinalize = finalizeSesi;
