-- ============================================================
-- KELAAS — Migrasi D1 0003: fitur guru V2 + tugas/materi/modul
-- (setup-guru-v2, setup-siswa-v2 + tabel fitur guru di kode.gs)
-- ============================================================

-- Fitur guru: materi, modul ajar, tugas, pengumpulan, catatan perilaku,
-- portofolio, rubrik, agenda, presensi guru.
CREATE TABLE IF NOT EXISTS materi (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nip TEXT,
  judul TEXT,
  isi TEXT,
  tanggal TEXT,
  kelas TEXT,
  mapel TEXT
);

CREATE TABLE IF NOT EXISTS modul_ajar (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nip TEXT,
  judul TEXT,
  isi TEXT,
  tanggal TEXT
);

CREATE TABLE IF NOT EXISTS tugas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nip TEXT,
  kelas TEXT,
  mapel TEXT,
  judul TEXT,
  deskripsi TEXT,
  tenggat TEXT,
  status TEXT DEFAULT 'Belum'
);

CREATE TABLE IF NOT EXISTS pengumpulan (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tugas_id INTEGER,
  nis TEXT,
  nama_siswa TEXT,
  jawaban TEXT,
  file_url TEXT,
  nilai REAL,
  feedback TEXT,
  tanggal TEXT
);

CREATE TABLE IF NOT EXISTS catatan_perilaku (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nip TEXT,
  nis TEXT,
  nama_siswa TEXT,
  kelas TEXT,
  tanggal TEXT,
  kategori TEXT,
  catatan TEXT,
  tindak_lanjut TEXT
);

CREATE TABLE IF NOT EXISTS portofolio (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nip TEXT,
  nis TEXT,
  judul TEXT,
  deskripsi TEXT,
  tanggal TEXT
);

CREATE TABLE IF NOT EXISTS rubrik (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nip TEXT,
  nama TEXT,
  komponen TEXT,
  tanggal TEXT
);

CREATE TABLE IF NOT EXISTS agenda (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nip TEXT,
  judul TEXT,
  tanggal TEXT,
  jam TEXT,
  catatan TEXT
);

CREATE TABLE IF NOT EXISTS presensi_guru (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nip TEXT,
  tanggal TEXT,
  status TEXT,
  keterangan TEXT
);
