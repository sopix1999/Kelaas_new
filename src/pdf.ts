// ============================================================
// Generator PDF — port dari code.gs (DocumentApp + DriveApp)
// Pendekatan: bangun dokumen sebagai HTML ringkas, konversi
// client-side ke PDF (html2pdf.js di browser), atau simpan
// sebagai file .html yang bisa dikonversi pengguna.
// Struktur (headers/tables/wali kelas) dipertahankan 1:1.
// ============================================================
import { all } from './lib/db';
import type { D1Database } from '@cloudflare/workers-types';
import { fmtDateID, todayWIB } from './lib/crypto';

function esc(v: unknown): string {
  return String(v === null || v === undefined ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function fmtN(v: unknown): string {
  return v === '' || v === null || v === undefined ? '-' : String(v);
}

async function waliKelasNama(db: D1Database, kelas: string): Promise<string> {
  try {
    const r = await all(db, "SELECT nama_lengkap AS nama FROM users WHERE role='Walikelas' AND kelas=? LIMIT 1", [kelas]);
    return r[0]?.nama ? String(r[0].nama) : '-';
  } catch {
    return '-';
  }
}

async function getTA(db: D1Database): Promise<{ ta: string; sem: string }> {
  try {
    const ta = await all(db, "SELECT setting_value FROM settings WHERE setting_key='TA_AKTIF'");
    const sm = await all(db, "SELECT setting_value FROM settings WHERE setting_key='SEMESTER'");
    return { ta: ta[0]?.setting_value ? String(ta[0].setting_value) : '2025/2026', sem: sm[0]?.setting_value ? String(sm[0].setting_value) : '1' };
  } catch {
    return { ta: '2025/2026', sem: '1' };
  }
}

interface PdfOpts {
  title: string;
  subtitle?: string;
  kelas?: string;
  sections?: { heading?: string; table?: { headers: string[]; rows: any[][] }; note?: string }[];
  notes?: string[];
}

async function buildHtml(db: D1Database, opts: PdfOpts): Promise<string> {
  const ta = await getTA(db);
  const widthClamp = (w: number) => Math.max(24, Math.min(w, 500));
  let html = `<!DOCTYPE html><html lang="id"><head><meta charset="utf-8"><title>${esc(opts.title)}</title>`;
  html += `<style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:Arial,sans-serif;color:#111;font-size:10pt;padding:28px 30px}
    .kop{text-align:center;margin-bottom:14px}
    .kop .sekolah{font-weight:bold;font-size:11pt}
    .kop .sub{font-size:8pt;color:#555;margin-top:2px}
    h1{font-size:15pt;text-align:center;margin:14px 0 2px}
    .cls{text-align:center;font-size:10pt;margin:2px 0}
    .subtitle{text-align:center;font-size:10pt;font-style:italic;color:#333;margin-bottom:10px}
    h2{font-size:11pt;margin:14px 0 6px}
    table{border-collapse:collapse;width:100%;margin:6px 0}
    th,td{border:1px solid #bbb;padding:3px 5px;font-size:8pt;text-align:left}
    th{background:#eee;font-weight:bold}
    tr:nth-child(even) td{background:#fafafa}
    .note{font-size:8pt;font-style:italic;color:#555;margin-top:8px}
    .space{height:10px}
  </style></head><body>`;
  html += `<div class="kop"><div class="sekolah">SEKOLAH MENENGAH — KELAAS</div><div class="sub">Laporan Akademik Siswa • Tahun Ajaran ${esc(ta.ta)} • Semester ${esc(ta.sem)}</div></div>`;
  html += `<h1>${esc(opts.title)}</h1>`;
  if (opts.kelas) html += `<div class="cls">Kelas: ${esc(opts.kelas)}</div>`;
  if (opts.subtitle) html += `<div class="subtitle">${esc(opts.subtitle)}</div>`;
  html += `<div class="space"></div>`;
  for (const sec of opts.sections ?? []) {
    html += `<h2>${esc(sec.heading)}</h2>`;
    if (sec.note) {
      html += `<div>${esc(sec.note)}</div><div class="space"></div>`;
    }
    if (sec.table) {
      const headers = sec.table.headers;
      const rows = sec.table.rows;
      if (rows.length) {
        html += `<table><thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>`;
        for (const row of rows) {
          html += `<tr>${headers.map((_, c) => `<td>${esc(fmtN(row[c]))}</td>`).join('')}</tr>`;
        }
        html += `</tbody></table>`;
      } else {
        html += `<div>Belum ada data.</div>`;
      }
    }
  }
  for (const n of opts.notes ?? []) {
    html += `<div class="note">${esc(n)}</div>`;
  }
  html += `</body></html>`;
  return html;
}

// Bungkus hasil HTML menjadi payload siap-download.
function pdfPayload(html: string, filename: string): { success: boolean; base64: string; filename: string; mimeType: string; html: string } {
  // base64 UTF-8-safe
  const b64 = btoa(unescape(encodeURIComponent(html)));
  return { success: true, base64: b64, filename: filename.replace(/\s+/g, '_') + '.html', mimeType: 'text/html', html };
}

// ---------- 1) REKAP NILAI ----------
export async function generateRekapNilaiPDF(db: D1Database, nip: string, kelas: string, mapel: string): Promise<any> {
  const rekap = await getRekapNilai(db, nip, kelas, mapel);
  const students = (rekap && rekap.students) || [];
  const headers = ['No', 'NIS', 'Nama'];
  const jenis = ['NH1', 'NH2', 'NH3', 'NH4', 'NH5', 'NH6', 'NH7', 'NH8', 'PSTS', 'PSAS'];
  for (const j of jenis) headers.push(j);
  headers.push('Akhir');
  const rows = students.map((x: any, i: number) => {
    const row = [i + 1, x.nis, x.nama];
    for (const j of jenis) row.push(x[j] == null ? '-' : x[j]);
    row.push(x.akhir == null ? '-' : x.akhir);
    return row;
  });
  const html = await buildHtml(db, {
    title: 'REKAP NILAI SISWA',
    subtitle: 'Mata Pelajaran: ' + (rekap?.mapel || mapel || '-'),
    kelas,
    sections: [{ heading: '', table: { headers, rows } }],
    notes: [
      'Keterangan: NH = Nilai Harian, PSTS = Penilaian Sumatif Tengah Semester, PSAS = Penilaian Sumatif Akhir Semester.',
      'Wali Kelas: ' + (await waliKelasNama(db, kelas)),
    ],
  });
  return pdfPayload(html, 'Rekap_Nilai_' + kelas);
}

async function getRekapNilai(db: D1Database, nip: string, kelas: string, mapel: string): Promise<Record<string, any>> {
  const siswa = await all(db, 'SELECT nis, nama_siswa AS nama FROM siswa WHERE kelas=? ORDER BY nama_siswa', [kelas]);
  let sql = 'SELECT nis, jenis, nilai FROM nilai WHERE nip=? AND kelas=?';
  const p: unknown[] = [nip, kelas];
  if (mapel) { sql += ' AND mapel=?'; p.push(mapel); }
  const rows = await all(db, sql, p);
  const map: Record<string, Record<string, number>> = {};
  for (const n of rows) {
    const key = String(n.nis);
    if (!map[key]) map[key] = {};
    map[key][String(n.jenis)] = Number(n.nilai) || 0;
  }
  const jenisList = ['NH1', 'NH2', 'NH3', 'NH4', 'NH5', 'NH6', 'NH7', 'NH8', 'PSTS', 'PSAS'];
  const students: Record<string, any>[] = [];
  for (const s of siswa) {
    const row: Record<string, any> = { nis: s.nis, nama: s.nama };
    const vals: number[] = [];
    for (const j of jenisList) {
      const v = map[String(s.nis)]?.[j] ?? null;
      row[j] = v;
      if (v !== null) vals.push(v);
    }
    row.akhir = vals.length ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10 : null;
    students.push(row);
  }
  return { students, mapel: mapel || '-', kelas };
}

// ---------- 2) REKAP KEHADIRAN KELAS ----------
export async function generateRekapanKelasPDF(db: D1Database, kelas: string, start: string, end: string, label: string): Promise<any> {
  const data = await getRekapData(db, kelas, '', start, end);
  const students = data.students || [];
  const dates = data.dates || [];
  const headers = ['No', 'NIS', 'Nama'];
  for (const d of dates) headers.push(fmtDateID(String(d)).substring(0, 5));
  headers.push('H', 'S', 'I', 'A', 'Total');
  const rows = students.map((x: any, i: number) => {
    const rec = x.records || {};
    const sum = x.summary || {};
    const row = [i + 1, x.nis, x.nama];
    for (const d of dates) row.push(rec[d] || '-');
    row.push(sum.Hadir || 0, sum.Sakit || 0, sum.Izin || 0, sum.Alfa || 0, x.total || 0);
    return row;
  });
  const html = await buildHtml(db, {
    title: 'REKAP KEHADIRAN KELAS',
    subtitle: label || 'Periode: ' + start + ' s/d ' + end,
    kelas,
    sections: [{ heading: '', table: { headers, rows } }],
    notes: [
      'Keterangan: H = Hadir, S = Sakit, I = Izin, A = Alfa (tanpa keterangan).',
      'Wali Kelas: ' + (await waliKelasNama(db, kelas)),
    ],
  });
  return pdfPayload(html, 'Rekap_Kehadiran_' + kelas);
}

// ---------- 3) REKAP KEHADIRAN PER SISWA ----------
export async function generateRekapanPDF(db: D1Database, kelas: string, nis: string, start: string, end: string, label: string): Promise<any> {
  const data = await getRekapData(db, kelas, nis, start, end);
  const s = (data.students || [])[0] || { nis, nama: nis, records: {}, summary: {}, total: 0 };
  const rows = [
    ['Hadir', s.summary?.Hadir || 0],
    ['Sakit', s.summary?.Sakit || 0],
    ['Izin', s.summary?.Izin || 0],
    ['Alfa', s.summary?.Alfa || 0],
    ['Total', s.total || 0],
  ];
  const html = await buildHtml(db, {
    title: 'REKAP KEHADIRAN SISWA',
    subtitle: label || 'Periode: ' + start + ' s/d ' + end,
    kelas,
    sections: [
      { heading: 'Nama: ' + s.nama },
      { heading: 'NIS: ' + s.nis },
      { heading: '', table: { headers: ['Keterangan', 'Jumlah'], rows } },
    ],
    notes: ['Keterangan: H = Hadir, S = Sakit, I = Izin, A = Alfa.', 'Wali Kelas: ' + (await waliKelasNama(db, kelas))],
  });
  return pdfPayload(html, 'Rekapan_' + nis);
}

// ---------- 4) REKAP PRESENSI MAPEL PER GURU ----------
export async function generateRekapMapelPDF(db: D1Database, nip: string, kelas: string, mapel: string, start: string, end: string, label: string, guruNama?: string): Promise<any> {
  const data = await getPresensiMapelRekap(db, nip, kelas, mapel, start, end);
  const students = data.students || [];
  const dates = data.dates || [];
  const headers = ['No', 'NIS', 'Nama'];
  for (const d of dates) headers.push(fmtDateID(String(d)).substring(0, 5));
  headers.push('H', 'S', 'I', 'A', 'D', 'Total');
  const rows = students.map((x: any, i: number) => {
    const rec = x.records || {};
    const sm = x.summary || {};
    const row = [i + 1, x.nis, x.nama];
    for (const d of dates) row.push(rec[d] || '-');
    row.push(sm.Hadir || 0, sm.Sakit || 0, sm.Izin || 0, sm.Alfa || 0, sm.Dispensasi || 0, x.total || 0);
    return row;
  });
  const html = await buildHtml(db, {
    title: 'REKAP PRESENSI MAPEL',
    subtitle: label || 'Periode: ' + start + ' s/d ' + end,
    kelas,
    sections: [
      { heading: 'Mapel: ' + mapel },
      { heading: '', table: { headers, rows } },
    ],
    notes: ['Keterangan: H = Hadir, S = Sakit, I = Izin, A = Alfa, D = Dispensasi.', 'Guru Mapel: ' + (guruNama || '-')],
  });
  return pdfPayload(html, 'Rekap_Presensi_' + kelas + '_' + mapel);
}

// ---------- 5) LAPORAN ADMINISTRASI GURU ----------
export async function generateLaporanAdminPDF(db: D1Database, nip: string, kelas: string, mapel: string, start: string, end: string): Promise<any> {
  const d = await getLaporanAdminData(db, nip, kelas, mapel, start, end);
  const students = d.students || [];
  const jurnal = d.jurnal || [];
  const h1 = ['No', 'NIS', 'Nama', 'Hadir', 'Sakit', 'Izin', 'Alfa', 'Disp.', 'Total'];
  const rows1 = students.map((x: any, i: number) => {
    const sm = x.summary || {};
    return [i + 1, x.nis, x.nama, sm.Hadir || 0, sm.Sakit || 0, sm.Izin || 0, sm.Alfa || 0, sm.Dispensasi || 0, x.total || 0];
  });
  const jrows = jurnal.map((x: any, i: number) => [i + 1, fmtDateID(String(x.tanggal)), 'Jam ' + (x.jamKe || '-'), x.materi, x.kegiatan]);
  const html = await buildHtml(db, {
    title: 'LAPORAN ADMINISTRASI PEMBELAJARAN',
    subtitle: 'Periode: ' + start + ' s/d ' + end,
    kelas,
    sections: [
      { heading: 'Mapel: ' + mapel },
      { heading: 'A. REKAP PRESENSI SISWA', table: { headers: h1, rows: rows1 } },
      { heading: 'B. JURNAL MENGAJAR', table: { headers: ['No', 'Tanggal', 'Jam', 'Materi', 'Kegiatan'], rows: jrows } },
    ],
    notes: ['Jumlah baris direvisi: ' + (d.revisiCount || 0)],
  });
  return pdfPayload(html, 'Laporan_Administrasi_' + kelas + '_' + mapel);
}

// ---------- 6) REKAP LENGKAP ----------
export async function generateRekapLengkapPDF(db: D1Database, nip: string, kelas: string, mapel: string, start: string, end: string): Promise<any> {
  const rekap = await getRekapNilai(db, nip, kelas, mapel);
  const students = (rekap && rekap.students) || [];
  const pres = await getPresensiMapelRekap(db, nip, kelas, mapel, start, end);
  const pStudents = pres.students || [];
  const pDates = pres.dates || [];
  const admin = await getLaporanAdminData(db, nip, kelas, mapel, start, end);
  const jurnal = admin.jurnal || [];

  const h1 = ['No', 'NIS', 'Nama'];
  for (let j = 0; j < 8; j++) h1.push('NH' + (j + 1));
  h1.push('PSTS', 'PSAS', 'Akhir');
  const r1 = students.map((x: any, i: number) => {
    const row = [i + 1, x.nis, x.nama];
    for (let k = 0; k < 8; k++) row.push(x['NH' + (k + 1)] == null ? '-' : x['NH' + (k + 1)]);
    row.push(x.PSTS == null ? '-' : x.PSTS, x.PSAS == null ? '-' : x.PSAS, x.akhir == null ? '-' : x.akhir);
    return row;
  });

  const h2 = ['No', 'NIS', 'Nama'];
  for (const d of pDates) h2.push(fmtDateID(String(d)).substring(0, 5));
  h2.push('H', 'S', 'I', 'A', 'D', 'Total');
  const r2 = pStudents.map((x: any, i: number) => {
    const rec = x.records || {};
    const sm = x.summary || {};
    const row = [i + 1, x.nis, x.nama];
    for (const d of pDates) row.push(rec[d] || '-');
    row.push(sm.Hadir || 0, sm.Sakit || 0, sm.Izin || 0, sm.Alfa || 0, sm.Dispensasi || 0, x.total || 0);
    return row;
  });

  const r3 = jurnal.map((x: any, i: number) => [i + 1, fmtDateID(String(x.tanggal)), 'Jam ' + (x.jamKe || '-'), x.materi, x.kegiatan]);

  const html = await buildHtml(db, {
    title: 'REKAP LENGKAP PEMBELAJARAN',
    subtitle: 'Mapel: ' + mapel + ' • Periode: ' + start + ' s/d ' + end,
    kelas,
    sections: [
      { heading: 'A. NILAI SISWA', table: { headers: h1, rows: r1 } },
      { heading: 'B. REKAP PRESENSI MAPEL', table: { headers: h2, rows: r2 } },
      { heading: 'C. JURNAL MENGAJAR', table: { headers: ['No', 'Tanggal', 'Jam', 'Materi', 'Kegiatan'], rows: r3 } },
    ],
    notes: [
      'Keterangan: NH = Nilai Harian, PSTS = Penilaian Sumatif Tengah Semester, PSAS = Penilaian Sumatif Akhir Semester.',
      'Wali Kelas / Guru: ' + (await waliKelasNama(db, kelas)),
    ],
  });
  return pdfPayload(html, 'Rekap_Nilai_Kehadiran_' + kelas);
}

// ---------- 7) MODUL AJAR (hasil AI) ----------
export async function generateModulPDF(db: D1Database, text: string, judul: string): Promise<any> {
  const md = String(text || '').trim();
  const html = await buildHtml(db, { title: judul || 'Modul_Ajar', notes: [md] });
  return pdfPayload(html, judul || 'Modul_Ajar');
}

// ---------- helpers data ----------
async function getRekapData(db: D1Database, kelas: string, nis: string, start: string, end: string): Promise<Record<string, any>> {
  let sql = 'SELECT nis, nama_siswa AS nama, jk FROM siswa WHERE kelas=?';
  const p: unknown[] = [kelas];
  if (nis) { sql += ' AND nis=?'; p.push(nis); }
  const siswa = await all(db, sql, p);
  sql = 'SELECT tanggal, nis, status FROM kehadiran WHERE kelas=? AND tanggal>=? AND tanggal<=?';
  const p2: unknown[] = [kelas, start, end];
  if (nis) { sql += ' AND nis=?'; p2.push(nis); }
  const raw = await all(db, sql, p2);
  const dates = Array.from(new Set(raw.map((r) => String(r.tanggal)))).sort();
  const res: Record<string, any>[] = [];
  for (const s of siswa) {
    const recs: Record<string, string> = {};
    const sum = { Hadir: 0, Sakit: 0, Izin: 0, Alfa: 0 };
    for (const r of raw) {
      if (String(r.nis) === String(s.nis)) {
        recs[String(r.tanggal)] = String(r.status);
        const st = String(r.status);
        if (st in sum) sum[st as keyof typeof sum]++;
      }
    }
    res.push({ nis: s.nis, nama: s.nama, jk: s.jk, records: recs, summary: sum, total: sum.Hadir + sum.Sakit + sum.Izin + sum.Alfa });
  }
  return { students: res, dates };
}

async function getPresensiMapelRekap(db: D1Database, nip: string, kelas: string, mapel: string, start: string, end: string): Promise<Record<string, any>> {
  const siswa = await all(db, 'SELECT nis, nama_siswa AS nama FROM siswa WHERE kelas=? ORDER BY nama_siswa', [kelas]);
  let raw;
  if (start && end) {
    raw = await all(db, 'SELECT tanggal, nis, status FROM presensi_mapel WHERE nip=? AND kelas=? AND mapel=? AND tanggal>=? AND tanggal<=?', [nip, kelas, mapel, start, end]);
  } else {
    raw = await all(db, 'SELECT tanggal, nis, status FROM presensi_mapel WHERE nip=? AND kelas=? AND mapel=?', [nip, kelas, mapel]);
  }
  const dates = Array.from(new Set(raw.map((r) => String(r.tanggal)))).sort();
  const res: Record<string, any>[] = [];
  for (const s of siswa) {
    const recs: Record<string, string> = {};
    const sum = { Hadir: 0, Sakit: 0, Izin: 0, Alfa: 0, Dispensasi: 0 };
    for (const r of raw) {
      if (String(r.nis) === String(s.nis)) {
        recs[String(r.tanggal)] = String(r.status);
        const st = String(r.status);
        if (st in sum) sum[st as keyof typeof sum]++;
      }
    }
    res.push({ nis: s.nis, nama: s.nama, records: recs, summary: sum, total: sum.Hadir + sum.Sakit + sum.Izin + sum.Alfa + sum.Dispensasi });
  }
  return { students: res, dates };
}

async function getLaporanAdminData(db: D1Database, nip: string, kelas: string, mapel: string, start: string, end: string): Promise<Record<string, any>> {
  const siswa = await all(db, 'SELECT nis, nama_siswa AS nama FROM siswa WHERE kelas=? ORDER BY nama_siswa', [kelas]);
  const raw = await all(db, 'SELECT tanggal, nis, status, updated_at FROM presensi_mapel WHERE nip=? AND kelas=? AND mapel=? AND tanggal>=? AND tanggal<=?', [nip, kelas, mapel, start, end]);
  let revisi = 0;
  const byNis: Record<string, Record<string, number>> = {};
  for (const r of raw) {
    if (r.updated_at) revisi++;
    const key = String(r.nis);
    if (!byNis[key]) byNis[key] = {};
    byNis[key][String(r.status)] = (byNis[key][String(r.status)] || 0) + 1;
  }
  const students: Record<string, any>[] = [];
  for (const s of siswa) {
    const sm = { Hadir: 0, Sakit: 0, Izin: 0, Alfa: 0, Dispensasi: 0 };
    for (const [k, v] of Object.entries(byNis[String(s.nis)] || {})) if (k in sm) sm[k as keyof typeof sm] = v;
    const tot = sm.Hadir + sm.Sakit + sm.Izin + sm.Alfa + sm.Dispensasi;
    students.push({ nis: s.nis, nama: s.nama, summary: sm, total: tot, pct: tot ? Math.round((sm.Hadir / tot) * 100) : 0 });
  }
  const jurnal = await all(db, 'SELECT tanggal, jam_ke AS jamKe, materi, kegiatan, status FROM jurnal_mengajar WHERE nip=? AND kelas=? AND mapel=? AND tanggal>=? AND tanggal<=? ORDER BY tanggal, jam_ke', [nip, kelas, mapel, start, end]);
  return { students, dates: [], jurnal, revisiCount: revisi };
}

export const pdfDate = fmtDateID;
export { todayWIB };
