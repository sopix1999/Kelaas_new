// ============================================================
// KELAAS Bridge — emulasi `google.script.run` / fungsi GAS
// (code.gs) dengan HTTP fetch ke worker ini sendiri.
// Frontend lama memanggil call('fn', args...); bridge mengirim
// {fn, args} ke /__gas. Server menjalankan handler yang setara
// dan mengembalikan hasil persis seperti fungsi GAS.
// ============================================================
import type { Context } from 'hono';
import type { D1Database } from '@cloudflare/workers-types';
import { all, one, run, num, s } from './lib/db';
import type { GeminiCtx } from './lib/gemini';
import { aiGuru, aiTextToSoal, aiBuatSoalBank, generateSummary, parseSearchQuery, extractDataEntry, aiCallGrade, extractJson } from './lib/gemini';
import {
  generateRekapNilaiPDF, generateRekapanKelasPDF, generateRekapanPDF, generateRekapMapelPDF,
  generateLaporanAdminPDF, generateRekapLengkapPDF, generateModulPDF,
} from './pdf';

type Env = Record<string, any>;

// ===================== HTTP call helper (server-side, in-memory) =====================
// Workers tidak bisa fetch ke origin sendiri via HTTP → panggil app Hono
// langsung in-memory lewat binding `__app` (di-set di src/app.ts middleware).
async function callAction(c: Context, method: string, action: string, params: Record<string, any> = {}, payload?: Record<string, any>): Promise<Record<string, any>> {
  const env = c.env as Record<string, any>;
  if (!env.__app || typeof env.__app.fetch !== 'function') {
    return { success: false, message: 'Internal bridge tidak tersedia (__app)' };
  }
  const url = new URL('/api', c.req.url);
  url.searchParams.set('action', action);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  const init: RequestInit = { method, headers: { 'Content-Type': 'application/json' } };
  if (payload !== undefined) init.body = JSON.stringify(payload);
  // Catatan: Hono `app.fetch(request, env, executionCtx)` — urutan argumen
  // (request, env, executionCtx). Request harus sudah berupa Request object
  // (bukan string/URL), karena Hono tidak membungkus string sendiri.
  const request = new Request(url.toString(), init);
  const fetchFn = env.__app.fetch as (req: Request, env: unknown, executionCtx: unknown) => Promise<Response>;
  const res = await fetchFn(request, c.env, c.executionCtx);
  try {
    return (await res.json()) as Record<string, any>;
  } catch {
    return { success: false, message: 'Gagal parse response' };
  }
}

// ===================== Response helpers (GAS-style) =====================
function gasOk(data: unknown, message?: string): Record<string, any> {
  return { success: true, data, message };
}

// ===================== HANDLER REGISTRY =====================
// Map nama fungsi GAS → {method, action, build}
type FnSpec = {
  method: string;
  action: string;
  // argNames: urutan argumen fungsi GAS
  args: string[];
  // queryKeys: argumen mana yang jadi query param
  q?: string[];
  // bodyKeys: argumen mana yang jadi body; object untuk pemetaan kustom
  body?: string[] | ((a: any[]) => Record<string, any>);
};

const FUNCS: Record<string, FnSpec> = {
  // ===== AUTH =====
  validateLogin: { method: 'POST', action: 'login', args: ['username', 'password'], body: ['username', 'password'] },
  logActivity: { method: 'POST', action: 'log-aktivitas', args: ['username', 'role', 'aksi', 'detail'], body: ['username', 'role', 'aksi', 'detail'] },
  getTAInfo: { method: 'GET', action: 'settings', args: [] },
  setTA: { method: 'POST', action: 'settings', args: ['ta', 'semester'], body: ['ta', 'semester'] },

  // ===== DASHBOARD =====
  getDashboardData: { method: 'GET', action: 'dashboard', args: ['kelas', 'role', 'nip'], q: ['kelas', 'role', 'nip'] },
  getDashboardRekap: { method: 'GET', action: 'dashboard-rekap', args: ['kelas', 'role', 'nip'], q: ['kelas', 'role', 'nip'] },
  getEarlyWarning: { method: 'GET', action: 'early-warning', args: ['kelas'], q: ['kelas'] },
  getMyData: { method: 'GET', action: 'my-data', args: ['kelas', 'nis'], q: ['kelas', 'nis'] },
  getOrtuData: { method: 'GET', action: 'ortu-data', args: ['nis'], q: ['nis'] },
  getGuruDashboard: { method: 'GET', action: 'guru-dashboard', args: ['nip'], q: ['nip'] },
  getGuruInfo: { method: 'GET', action: 'guru-info', args: ['nip'], q: ['nip'] },
  getMapelGuruDiKelas: { method: 'GET', action: 'mapel-guru-kelas', args: ['nip', 'kelas'], q: ['nip', 'kelas'] },
  addKelasDiampu: { method: 'POST', action: 'guru-add-kelas', args: ['nip', 'kelas'], body: ['nip', 'kelas'] },

  // ===== SISWA =====
  getSiswaList: { method: 'GET', action: 'siswa', args: ['kelas'], q: ['kelas'] },
  getSiswaOptions: { method: 'GET', action: 'siswa-options', args: ['kelas'], q: ['kelas'] },
  addSiswa: { method: 'POST', action: 'siswa', args: ['kelas', 'nis', 'nama', 'jk', 'extra'], body: (a: any[]) => ({ kelas: a[0], nis: a[1], nama: a[2], jk: a[3], ...(a[4] || {}) }) },
  updateSiswa: { method: 'PUT', action: 'siswa', args: ['kelas', 'oldNis', 'nis', 'nama', 'jk', 'extra'], body: (a: any[]) => ({ kelas: a[0], oldNis: a[1], nis: a[2], nama: a[3], jk: a[4], ...(a[5] || {}) }) },
  deleteSiswa: { method: 'DELETE', action: 'siswa', args: ['kelas', 'nis'], q: ['kelas', 'nis'] },
  importDataSiswa: { method: 'POST', action: 'siswa-import', args: ['arr', 'kelas'], body: (a: any[]) => ({ data: a[0], kelas: a[1] }) },

  // ===== KEHADIRAN =====
  getKehadiranByDate: { method: 'GET', action: 'kehadiran', args: ['kelas', 'tanggal'], q: ['kelas', 'tanggal'] },
  submitBulkKehadiran: { method: 'POST', action: 'kehadiran', args: ['kelas', 'tanggal', 'records'], body: ['kelas', 'tanggal', 'records'] },

  // ===== TATIB / KAS / STRUKTUR / INVENTARIS / PENGUMUMAN =====
  getTataTertibList: { method: 'GET', action: 'tatatertib', args: ['kelas'], q: ['kelas'] },
  addTataTertib: { method: 'POST', action: 'tatatertib', args: ['kelas', 'tanggal', 'nis', 'pelanggaran', 'poin'], body: ['kelas', 'tanggal', 'nis', 'pelanggaran', 'poin'] },
  deleteTataTertib: { method: 'DELETE', action: 'tatatertib', args: ['id'], q: ['id'] },
  getKasList: { method: 'GET', action: 'kas', args: ['kelas'], q: ['kelas'] },
  getKasSummary: { method: 'GET', action: 'kas-summary', args: ['kelas'], q: ['kelas'] },
  addKas: { method: 'POST', action: 'kas', args: ['kelas', 'tanggal', 'jenis', 'jumlah', 'keterangan'], body: ['kelas', 'tanggal', 'jenis', 'jumlah', 'keterangan'] },
  deleteKas: { method: 'DELETE', action: 'kas', args: ['id'], q: ['id'] },
  getStrukturKelas: { method: 'GET', action: 'struktur', args: ['kelas'], q: ['kelas'] },
  saveStrukturKelas: { method: 'POST', action: 'struktur', args: ['kelas', 'data'], body: (a: any[]) => ({ kelas: a[0], data: a[1] }) },
  getInventarisList: { method: 'GET', action: 'inventaris', args: ['kelas'], q: ['kelas'] },
  addInventaris: { method: 'POST', action: 'inventaris', args: ['kelas', 'nama', 'jumlah', 'kondisi', 'keterangan'], body: ['kelas', 'nama', 'jumlah', 'kondisi', 'keterangan'] },
  deleteInventaris: { method: 'DELETE', action: 'inventaris', args: ['id'], q: ['id'] },
  getPengumumanList: { method: 'GET', action: 'pengumuman', args: ['kelas'], q: ['kelas'] },
  addPengumuman: { method: 'POST', action: 'pengumuman', args: ['kelas', 'judul', 'isi', 'penulis'], body: ['kelas', 'judul', 'isi', 'penulis'] },
  deletePengumuman: { method: 'DELETE', action: 'pengumuman', args: ['id'], q: ['id'] },

  // ===== JADWAL / PIKET =====
  getJadwalPelajaran: { method: 'GET', action: 'jadwal', args: ['kelas'], q: ['kelas'] },
  addJadwalPelajaran: { method: 'POST', action: 'jadwal', args: ['kelas', 'hari', 'jam', 'mapel', 'nip'], body: ['kelas', 'hari', 'jam', 'mapel', 'nip'] },
  updateJadwalPelajaran: { method: 'PUT', action: 'jadwal', args: ['id', 'kelas', 'hari', 'jam', 'mapel', 'nip'], body: ['id', 'kelas', 'hari', 'jam', 'mapel', 'nip'] },
  deleteJadwalPelajaran: { method: 'DELETE', action: 'jadwal', args: ['id'], q: ['id'] },
  getJadwalMengajar: { method: 'GET', action: 'jadwal-mengajar', args: ['nip'], q: ['nip'] },
  getJadwalByGuru: { method: 'GET', action: 'jadwal-by-guru', args: ['nip'], q: ['nip'] },
  getJadwalPiket: { method: 'GET', action: 'jadwal-piket', args: ['kelas'], q: ['kelas'] },
  savePiketForDay: { method: 'POST', action: 'jadwal-piket', args: ['kelas', 'hari', 'students'], body: ['kelas', 'hari', 'students'] },

  // ===== BIMBINGAN / KUNJUNGAN =====
  getJurnalBimbingan: { method: 'GET', action: 'jurnal-bimbingan', args: ['kelas'], q: ['kelas'] },
  addJurnalBimbingan: { method: 'POST', action: 'jurnal-bimbingan', args: ['kelas', 'tanggal', 'kategori', 'isi', 'tindakLanjut'], body: ['kelas', 'tanggal', 'kategori', 'isi', 'tindakLanjut'] },
  deleteJurnalBimbingan: { method: 'DELETE', action: 'jurnal-bimbingan', args: ['id'], q: ['id'] },
  getKunjunganRumah: { method: 'GET', action: 'kunjungan-rumah', args: ['kelas'], q: ['kelas'] },
  addKunjunganRumah: { method: 'POST', action: 'kunjungan-rumah', args: ['kelas', 'tanggal', 'nisNama', 'alamat', 'hasil', 'tindakLanjut', 'petugas'], body: ['kelas', 'tanggal', 'nisNama', 'alamat', 'hasil', 'tindakLanjut', 'petugas'] },
  deleteKunjunganRumah: { method: 'DELETE', action: 'kunjungan-rumah', args: ['id'], q: ['id'] },

  // ===== JURNAL MENGAJAR =====
  getJurnalMengajar: { method: 'GET', action: 'jurnal-mengajar', args: ['nip'], q: ['nip'] },
  addJurnalMengajar: { method: 'POST', action: 'jurnal-mengajar', args: ['nip', 'tanggal', 'kelas', 'mapel', 'jam', 'materi', 'kegiatan', 'extra'], body: (a: any[]) => ({ nip: a[0], tanggal: a[1], kelas: a[2], mapel: a[3], jam: a[4], materi: a[5], kegiatan: a[6], ...(a[7] || {}) }) },
  updateJurnalMengajarFull: { method: 'PUT', action: 'jurnal-mengajar', args: ['id', 'p'], body: (a: any[]) => ({ id: a[0], ...(a[1] || {}) }) },
  deleteJurnalMengajar: { method: 'DELETE', action: 'jurnal-mengajar', args: ['id', 'nip'], q: ['id', 'nip'] },
  getPresensiMapelByDate: { method: 'GET', action: 'presensi-mapel', args: ['nip', 'kelas', 'tanggal'], q: ['nip', 'kelas', 'tanggal'] },
  submitPresensiMapel: { method: 'POST', action: 'presensi-mapel', args: ['nip', 'kelas', 'mapel', 'tanggal', 'records'], body: ['nip', 'kelas', 'mapel', 'tanggal', 'records'] },
  submitPresensiMapelV2: { method: 'POST', action: 'presensi-mapel', args: ['nip', 'kelas', 'mapel', 'tanggal', 'jamKe', 'records'], body: ['nip', 'kelas', 'mapel', 'tanggal', 'jamKe', 'records'] },
  getPresensiRiwayat: { method: 'GET', action: 'presensi-riwayat', args: ['nip', 'tanggal', 'kelas'], q: ['nip', 'tanggal', 'kelas'] },
  updatePresensiBulk: { method: 'PUT', action: 'presensi-mapel', args: ['updates'], body: ['updates'] },

  // ===== NILAI =====
  getRekapNilai: { method: 'GET', action: 'nilai-rekap', args: ['nip', 'kelas', 'mapel'], q: ['nip', 'kelas', 'mapel'] },
  getPeringkatKelas: { method: 'GET', action: 'nilai-peringkat', args: ['nip', 'kelas', 'mapel'], q: ['nip', 'kelas', 'mapel'] },
  saveNilaiBulk: { method: 'POST', action: 'nilai-bulk', args: ['nip', 'kelas', 'mapel', 'entries'], body: ['nip', 'kelas', 'mapel', 'entries'] },
  getAnalisisNilai: { method: 'GET', action: 'analisis-nilai', args: ['nip', 'kelas', 'mapel'], q: ['nip', 'kelas', 'mapel'] },

  // ===== USERS / LOG =====
  getAllUsers: { method: 'GET', action: 'users', args: [] },
  addUser: { method: 'POST', action: 'users', args: ['username', 'password', 'role', 'kelas', 'nama', 'kodeGuru'], body: ['username', 'password', 'role', 'kelas', 'nama', 'kodeGuru'] },
  updateUser: { method: 'PUT', action: 'users', args: ['id', 'username', 'password', 'role', 'kelas', 'nama', 'kodeGuru'], body: ['id', 'username', 'password', 'role', 'kelas', 'nama', 'kodeGuru'] },
  deleteUser: { method: 'DELETE', action: 'users', args: ['id'], q: ['id'] },
  getLogAktivitas: { method: 'GET', action: 'log-aktivitas', args: [] },

  // ===== GURU PROFILE / MATERI / MODUL =====
  getGuruProfil: { method: 'GET', action: 'guru-profil', args: ['nip'], q: ['nip'] },
  saveGuruProfil: { method: 'POST', action: 'guru-profil', args: ['p'], body: (a: any[]) => (a[0] || {}) },
  getMateri: { method: 'GET', action: 'materi', args: ['nip'], q: ['nip'] },
  addMateri: { method: 'POST', action: 'materi', args: ['o'], body: (a: any[]) => (a[0] || {}) },
  deleteMateri: { method: 'DELETE', action: 'materi', args: ['id'], q: ['id'] },
  getModulAjar: { method: 'GET', action: 'modul-ajar', args: ['nip'], q: ['nip'] },
  addModulAjar: { method: 'POST', action: 'modul-ajar', args: ['o'], body: (a: any[]) => (a[0] || {}) },
  deleteModulAjar: { method: 'DELETE', action: 'modul-ajar', args: ['id'], q: ['id'] },

  // ===== TUGAS / PENGUMPULAN =====
  getTugas: { method: 'GET', action: 'tugas', args: ['nip'], q: ['nip'] },
  addTugas: { method: 'POST', action: 'tugas', args: ['o'], body: (a: any[]) => (a[0] || {}) },
  deleteTugas: { method: 'DELETE', action: 'tugas', args: ['id'], q: ['id'] },
  getPengumpulan: { method: 'GET', action: 'pengumpulan', args: ['tugasId'], q: ['tugasId'] },
  nilaiPengumpulan: { method: 'PUT', action: 'pengumpulan', args: ['id', 'nilai', 'feedback'], body: ['id', 'nilai', 'feedback'] },

  // ===== CATATAN PERILAKU / PORTOFOLIO =====
  getCatatanPerilaku: { method: 'GET', action: 'catatan-perilaku', args: ['nip', 'kelas'], q: ['nip', 'kelas'] },
  addCatatanPerilaku: { method: 'POST', action: 'catatan-perilaku', args: ['o'], body: (a: any[]) => (a[0] || {}) },
  deleteCatatanPerilaku: { method: 'DELETE', action: 'catatan-perilaku', args: ['id'], q: ['id'] },
  getPortofolio: { method: 'GET', action: 'portofolio', args: ['nip', 'nis'], q: ['nip', 'nis'] },
  addPortofolio: { method: 'POST', action: 'portofolio', args: ['o'], body: (a: any[]) => (a[0] || {}) },
  deletePortofolio: { method: 'DELETE', action: 'portofolio', args: ['id'], q: ['id'] },

  // ===== RUBRIK / AGENDA =====
  getRubrik: { method: 'GET', action: 'rubrik', args: ['nip'], q: ['nip'] },
  addRubrik: { method: 'POST', action: 'rubrik', args: ['nip', 'nama', 'komponen'], body: ['nip', 'nama', 'komponen'] },
  deleteRubrik: { method: 'DELETE', action: 'rubrik', args: ['id'], q: ['id'] },
  getAgenda: { method: 'GET', action: 'agenda', args: ['nip'], q: ['nip'] },
  addAgenda: { method: 'POST', action: 'agenda', args: ['o'], body: (a: any[]) => (a[0] || {}) },
  deleteAgenda: { method: 'DELETE', action: 'agenda', args: ['id'], q: ['id'] },

  // ===== PRESENSI GURU =====
  getPresensiGuru: { method: 'GET', action: 'presensi-guru', args: ['nip'], q: ['nip'] },
  addPresensiGuru: { method: 'POST', action: 'presensi-guru', args: ['o'], body: (a: any[]) => (a[0] || {}) },

  // ===== TOOLMAN =====
  getKatalogAlat: { method: 'GET', action: 'katalog-alat', args: [] },
  addKatalogAlat: { method: 'POST', action: 'katalog-alat', args: ['kode', 'nama', 'spesifikasi', 'jumlah', 'kondisi', 'lokasi'], body: ['kode', 'nama', 'spesifikasi', 'jumlah', 'kondisi', 'lokasi'] },
  deleteKatalogAlat: { method: 'DELETE', action: 'katalog-alat', args: ['id'], q: ['id'] },
  getBahanPraktik: { method: 'GET', action: 'bahan-praktik', args: [] },
  addBahanPraktik: { method: 'POST', action: 'bahan-praktik', args: ['kode', 'nama', 'satuan', 'stok', 'stokMin', 'kategori'], body: ['kode', 'nama', 'satuan', 'stok', 'stokMin', 'kategori'] },
  updateStokBahan: { method: 'PUT', action: 'bahan-praktik', args: ['kode', 'delta'], body: ['kode', 'delta'] },
  deleteBahanPraktik: { method: 'DELETE', action: 'bahan-praktik', args: ['id'], q: ['id'] },
  getPeminjaman: { method: 'GET', action: 'peminjaman', args: [] },
  scanPeminjam: { method: 'GET', action: 'scan-peminjam', args: ['code'], q: ['code'] },
  addPeminjaman: { method: 'POST', action: 'peminjaman', args: ['kodeBarang', 'peminjam', 'jenis', 'batas'], body: ['kodeBarang', 'peminjam', 'jenis', 'batas'] },
  returnPeminjaman: { method: 'PUT', action: 'peminjaman', args: ['id'], body: ['id'] },
  getLaporanKerusakan: { method: 'GET', action: 'laporan-kerusakan', args: [] },
  addLaporanKerusakan: { method: 'POST', action: 'laporan-kerusakan', args: ['kode', 'nama', 'kerusakan', 'pelapor', 'jadwal'], body: ['kode', 'nama', 'kerusakan', 'pelapor', 'jadwal'] },
  updateStatusKerusakan: { method: 'PUT', action: 'laporan-kerusakan', args: ['id', 'status'], body: ['id', 'status'] },
  deleteLaporanKerusakan: { method: 'DELETE', action: 'laporan-kerusakan', args: ['id'], q: ['id'] },

  // ===== SETUP / TEST / BACKUP =====
  runSetup: { method: 'POST', action: 'setup', args: [] },
  runSetupGuruV2: { method: 'POST', action: 'setup-guru-v2', args: [] },
  runSetupCbt: { method: 'POST', action: 'setup-cbt', args: [] },
  runSetupBankSoal: { method: 'POST', action: 'setup-banksoal', args: [] },
  testKoneksi: { method: 'GET', action: 'test', args: [] },
  backupToDrive: { method: 'GET', action: 'backup-dump', args: [] },
  setupAutoBackup: { method: 'GET', action: 'backup-dump', args: [] }, // GAS-only; pasrahkan hasil dump
  setupCbtCleanupTrigger: { method: 'POST', action: 'cbt-cleanup-expired', args: [] },

  // ===== BANK SOAL / CBT =====
  getBankSoalCbt: { method: 'GET', action: 'bank-soal', args: ['nip', 'mapel', 'jenis', 'kelas'], q: ['nip', 'mapel', 'kelas'] },
  addBankSoalCbt: { method: 'POST', action: 'bank-soal', args: ['o'], body: (a: any[]) => (a[0] || {}) },
  deleteBankSoalCbt: { method: 'DELETE', action: 'bank-soal', args: ['id'], q: ['id'] },
  deleteBankSoalBulk: { method: 'DELETE', action: 'bank-soal', args: ['ids'], body: (a: any[]) => ({ ids: a[0] }) },
  addBankSoalBulk: { method: 'POST', action: 'bank-soal', args: ['nip', 'soal'], body: (a: any[]) => ({ nip: a[0], soal: a[1] || [] }) },
  addBankSoal: { method: 'POST', action: 'bank-soal', args: ['o'], body: (a: any[]) => ({ nip: a[0]?.nip, soal: [a[0]] }) },
  getBankSoal: { method: 'GET', action: 'bank-soal', args: ['nip', 'mapel'], q: ['nip', 'mapel'] },
  deleteBankSoal: { method: 'DELETE', action: 'bank-soal', args: ['id'], q: ['id'] },
  getCbtExams: { method: 'GET', action: 'cbt-exam', args: ['nip'], q: ['nip'] },
  createCbtExam: { method: 'POST', action: 'cbt-exam', args: ['o'], body: (a: any[]) => (a[0] || {}) },
  setCbtStatus: { method: 'PUT', action: 'cbt-exam', args: ['id', 'status'], body: ['id', 'status'] },
  deleteCbtExam: { method: 'DELETE', action: 'cbt-exam', args: ['id'], q: ['id'] },
  getCbtHasil: { method: 'GET', action: 'cbt-hasil', args: ['examId'], q: ['examId'] },
  getCbtEssay: { method: 'GET', action: 'cbt-essay', args: ['examId', 'soalId'], q: ['examId'] },
  nilaiEssayCbt: { method: 'PUT', action: 'cbt-essay', args: ['id', 'nilai'], body: ['id', 'nilai'] },
  cbtStart: { method: 'POST', action: 'cbt-mulai', args: ['token', 'nis', 'nama', 'kelas'], body: ['token', 'nis', 'nama', 'kelas'] },
  cbtAutosave: { method: 'POST', action: 'cbt-simpan-jawaban', args: ['sesiId', 'nis', 'soalId', 'jawaban'], body: (a: any[]) => ({ sesiId: a[0], soalId: a[2], jawaban: a[3] }) },
  cbtSubmit: { method: 'POST', action: 'cbt-kumpulkan', args: ['sesiId', 'nis', 'jawabanArr'], body: (a: any[]) => ({ sesiId: a[0], jawaban: a[2] }) },
  getCbtRiwayatSiswa: { method: 'GET', action: 'cbt-riwayat-siswa', args: ['nis'], q: ['nis'] },
  cbtCleanupExpired: { method: 'POST', action: 'cbt-cleanup-expired', args: [] },

  // ===== REKAP / LAPORAN (data) =====
  getLaporanAdminData: { method: 'GET', action: 'laporan-admin', args: ['nip', 'kelas', 'mapel', 'start', 'end'], q: ['nip', 'kelas', 'mapel', 'start', 'end'] },
  getPresensiMapelRekap: { method: 'GET', action: 'presensi-mapel-rekap', args: ['nip', 'kelas', 'mapel', 'start', 'end'], q: ['nip', 'kelas', 'mapel', 'start', 'end'] },
  getWaliKelasNama: { method: 'GET', action: 'wali-kelas', args: ['kelas'], q: ['kelas'] },
};

// ===================== AI (server-side, butuh DB) =====================
async function aiNilaiEssayServer(c: Context, jawabanId: string, sesiId: string, soalId: string): Promise<Record<string, any>> {
  const r = await callAction(c, 'GET', 'cbt-essay-detail', { id: jawabanId, sesiId, soalId });
  const jw = r.data;
  if (!jw) return { success: false, message: 'Jawaban tidak ditemukan.' };
  if (!jw.jawaban || !String(jw.jawaban).trim()) {
    await callAction(c, 'PUT', 'cbt-essay', {}, { id: jawabanId, nilai: 0 });
    return { success: true, skor: 0, feedback: 'Tidak dijawab — skor 0.', kosong: true };
  }
  const ai = await aiCallGrade(c as GeminiCtx, jw.jawaban, jw.pertanyaan, jw.kunci, num(jw.bobot));
  if (!ai.success) return ai;
  await callAction(c, 'PUT', 'cbt-essay', {}, { id: jawabanId, nilai: ai.skor, feedback: ai.feedback, sumber: 'ai' });
  return { success: true, skor: ai.skor, feedback: ai.feedback };
}

async function autoNilaiEssayCbtServer(c: Context, examId: string): Promise<Record<string, any>> {
  const rowsR = await callAction(c, 'GET', 'cbt-essay', { examId });
  const rows = rowsR.data || [];
  if (!rows.length) return { success: false, message: 'Belum ada jawaban essay.' };
  const pending = rows.filter((r: any) => r.status !== 'dinilai');
  const hasil: Record<string, any>[] = [];
  let totalSkor = 0;
  let totalBobot = 0;
  for (const p of pending) {
    const r = await aiNilaiEssayServer(c, String(p.id), String(p.sesiId), String(p.soalId));
    hasil.push({ id: p.id, nama: p.nama, ok: !!(r && r.success), skor: r && r.skor != null ? r.skor : null, feedback: (r && r.feedback) || (r && r.message) || '' });
    if (r && r.success && r.skor != null) {
      totalSkor += Number(r.skor);
      totalBobot += Number(p.bobot) || 1;
    }
  }
  const rata = totalBobot > 0 ? Math.round((totalSkor / totalBobot) * 100 * 10) / 10 : null;
  return { success: true, total: rows.length, dinilai: hasil.length, hasil, rataEssay: rata };
}

// ===================== MAIN HANDLER =====================
export async function handleBridge(c: Context): Promise<Response> {
  const db: D1Database = c.env.DB;
  const body = (await c.req.json().catch(() => ({}))) as Record<string, any>;
  const fn = String(body.fn || '');
  const args: any[] = Array.isArray(body.args) ? body.args : [];

  const json = (data: any, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });

  // ---- read-only Gemini key (dibaca dari env secret, bukan PropertiesService) ----
  if (fn === 'getGeminiKey') {
    return json({ success: true, data: (c.env.GEMINI_KEY || ''), message: 'OK' });
  }

  // ---- AI endpoints ----
  switch (fn) {
    case 'aiGuru':
      return json(await aiGuru(c as unknown as GeminiCtx, String(args[0] || ''), (args[1] || {}) as Record<string, any>));
    case 'aiTextToSoal':
      return json(await aiTextToSoal(c as unknown as GeminiCtx, String(args[0] || ''), (args[1] || {}) as Record<string, any>));
    case 'aiBuatSoalBank':
      return json(await aiBuatSoalBank(c as unknown as GeminiCtx, (args[0] || {}) as Record<string, any>));
    case 'setGeminiKey':
      return json({ success: true, message: 'Pada Cloudflare Workers, atur secret GEMINI_KEY via `npx wrangler secret put GEMINI_KEY`.', data: 'ok' });
    case 'generateSummary': {
      const kelas = String(args[0] || '');
      const type = String(args[1] || 'dashboard');
      const df = String(args[2] || '');
      const dt = String(args[3] || '');
      const raw = await callAction(c, 'GET', 'ai-data-summary', { kelas, type, date_from: df, date_to: dt });
      const res = await generateSummary(c as unknown as GeminiCtx, kelas, type, df, dt, raw.data);
      return json(res);
    }
    case 'parseSearchQuery': {
      const teks = String(args[0] || '');
      const kelas = String(args[1] || '');
      const parsed = await parseSearchQuery(c as unknown as GeminiCtx, teks, kelas);
      if (!parsed.success) return json(parsed);
      const r = await callAction(c, 'POST', 'ai-search-filter', {}, { kelas, table: parsed.parsed.table, filters: parsed.parsed.filters || [], limit: 100 });
      if (!r.success) return json({ success: false, message: r.message || 'Gagal menjalankan pencarian.' });
      return json({ success: true, table: parsed.parsed.table, total: r.data?.total, records: r.data?.records, query: parsed.parsed });
    }
    case 'extractDataEntry':
      return json(await extractDataEntry(c as unknown as GeminiCtx, String(args[0] || ''), (args[1] || {}) as Record<string, any>));
    case 'aiNilaiEssay':
      return json(await aiNilaiEssayServer(c, String(args[0] || ''), String(args[1] || ''), String(args[2] || '')));
    case 'autoNilaiEssayCbt':
      return json(await autoNilaiEssayCbtServer(c, String(args[0] || '')));
  }

  // ---- PDF endpoints (server-side, no Gemini) ----
  const pdfResult = await handlePdf(c, fn, args);
  if (pdfResult) return json(pdfResult);

  // ---- Fungsi GAS biasa ----
  const spec = FUNCS[fn];
  if (!spec) return json({ success: false, message: 'Fungsi tidak dikenal: ' + fn }, 400);

  const a = args;
  const params: Record<string, string> = {};
  const qKeys = spec.q || [];
  for (const k of qKeys) {
    const idx = spec.args.indexOf(k);
    const v = idx >= 0 ? a[idx] : undefined;
    if (v !== undefined && v !== null && v !== '') params[k] = String(v);
  }
  let payload: Record<string, any> | undefined;
  if (typeof spec.body === 'function') {
    payload = spec.body(a);
  } else if (spec.body) {
    payload = {};
    for (const k of spec.body) {
      const idx = spec.args.indexOf(k);
      const v = idx >= 0 ? a[idx] : undefined;
      if (v !== undefined) payload[k] = v;
    }
  }

  const r = await callAction(c, spec.method, spec.action, params, payload);
  // GAS `_d(r, fb)` semantics: kembalikan data bila success, null bila gagal
  if (spec.method === 'GET') return json(r.success ? r.data : null);
  return json({ success: r.success, message: r.message || (r.success ? 'OK' : 'Gagal'), data: r.data });
}

// ===================== PDF =====================
async function handlePdf(c: Context, fn: string, args: any[]): Promise<Record<string, any> | null> {
  const db: D1Database = c.env.DB;
  switch (fn) {
    case 'generateRekapNilaiPDF':
      return await generateRekapNilaiPDF(db, String(args[0] || ''), String(args[1] || ''), String(args[2] || ''));
    case 'generateRekapanKelasPDF':
      return await generateRekapanKelasPDF(db, String(args[0] || ''), String(args[1] || ''), String(args[2] || ''), String(args[3] || ''));
    case 'generateRekapanPDF':
      return await generateRekapanPDF(db, String(args[0] || ''), String(args[1] || ''), String(args[2] || ''), String(args[3] || ''), String(args[4] || ''));
    case 'generateRekapMapelPDF':
      return await generateRekapMapelPDF(db, String(args[0] || ''), String(args[1] || ''), String(args[2] || ''), String(args[3] || ''), String(args[4] || ''), String(args[5] || ''), args[6]?.guruNama);
    case 'generateLaporanAdminPDF':
      return await generateLaporanAdminPDF(db, String(args[0] || ''), String(args[1] || ''), String(args[2] || ''), String(args[3] || ''), String(args[4] || ''));
    case 'generateRekapLengkapPDF':
      return await generateRekapLengkapPDF(db, String(args[0] || ''), String(args[1] || ''), String(args[2] || ''), String(args[3] || ''), String(args[4] || ''));
    case 'generateModulPDF':
      return await generateModulPDF(db, String(args[0] || ''), String(args[1] || ''));
    default:
      return null;
  }
}

export { callAction };
