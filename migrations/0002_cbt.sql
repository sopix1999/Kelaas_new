-- ============================================================
-- KELAAS — Migrasi D1 0002: CBT + Bank Soal (port setup-cbt)
-- ============================================================

CREATE TABLE IF NOT EXISTS bank_soal (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nip TEXT,
  mapel TEXT,
  kelas TEXT DEFAULT '',
  jenis INTEGER,
  soal TEXT,
  opsi TEXT,
  kunci TEXT,
  pembahasan TEXT,
  bobot INTEGER DEFAULT 1,
  tanggal TEXT
);
CREATE INDEX IF NOT EXISTS idx_bank_nip_mapel ON bank_soal(nip, mapel);

CREATE TABLE IF NOT EXISTS cbt_ujian (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nip TEXT,
  judul TEXT,
  kelas TEXT,
  mapel TEXT,
  durasi_menit INTEGER DEFAULT 60,
  token TEXT,
  aktif INTEGER DEFAULT 1,
  tanggal TEXT,
  ai_aktif INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_cbt_kelas_aktif ON cbt_ujian(kelas, aktif);
CREATE INDEX IF NOT EXISTS idx_cbt_token ON cbt_ujian(token);

CREATE TABLE IF NOT EXISTS cbt_soal (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ujian_id INTEGER,
  no_urut INTEGER,
  jenis INTEGER,
  soal TEXT,
  opsi TEXT,
  kunci TEXT,
  pembahasan TEXT,
  bobot INTEGER DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_cbtsoal_ujian ON cbt_soal(ujian_id);

CREATE TABLE IF NOT EXISTS cbt_sesi (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ujian_id INTEGER,
  nis TEXT,
  nama TEXT,
  mulai TEXT,
  deadline TEXT,
  selesai INTEGER DEFAULT 0,
  skor REAL,
  total_benar INTEGER DEFAULT 0,
  total_soal INTEGER DEFAULT 0,
  uraian_menunggu INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_cbtsesi_ujian_nis ON cbt_sesi(ujian_id, nis);

CREATE TABLE IF NOT EXISTS cbt_jawaban (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sesi_id INTEGER,
  soal_id INTEGER,
  jawaban TEXT,
  benar INTEGER,
  feedback TEXT,
  sumber TEXT DEFAULT 'manual',
  UNIQUE(sesi_id, soal_id)
);
