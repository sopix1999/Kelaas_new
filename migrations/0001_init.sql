-- ============================================================
-- KELAAS — Migrasi D1 0001: skema inti (port setup/index.php)
-- SQLite (D1). AUTOINCREMENT + index untuk kesetaraan performa.
-- ============================================================

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password TEXT NOT NULL,
  role TEXT NOT NULL,
  kelas TEXT,
  nama_lengkap TEXT,
  nip TEXT
);

CREATE TABLE IF NOT EXISTS siswa (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nis TEXT NOT NULL,
  nama_siswa TEXT NOT NULL,
  kelas TEXT,
  jk TEXT,
  ttl TEXT DEFAULT '',
  alamat TEXT DEFAULT '',
  no_wa TEXT DEFAULT '',
  ekstra TEXT DEFAULT '',
  nama_ayah TEXT DEFAULT '',
  nama_ibu TEXT DEFAULT '',
  kerja_ayah TEXT DEFAULT '',
  kerja_ibu TEXT DEFAULT '',
  penghasilan_ortu TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_siswa_kelas ON siswa(kelas);
CREATE INDEX IF NOT EXISTS idx_siswa_nis ON siswa(nis);

CREATE TABLE IF NOT EXISTS guru (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nip TEXT NOT NULL,
  nama_guru TEXT,
  mapel TEXT,
  kelas_diampu TEXT
);

CREATE TABLE IF NOT EXISTS kehadiran (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tanggal TEXT,
  nis TEXT,
  kelas TEXT,
  status TEXT,
  keterangan TEXT
);
CREATE INDEX IF NOT EXISTS idx_kehadiran_kelas_tgl ON kehadiran(kelas, tanggal);

CREATE TABLE IF NOT EXISTS tatatertib (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tanggal TEXT,
  nis TEXT,
  pelanggaran TEXT,
  poin INTEGER,
  kelas TEXT
);
CREATE INDEX IF NOT EXISTS idx_tatatertib_kelas ON tatatertib(kelas);

CREATE TABLE IF NOT EXISTS kaskelas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tanggal TEXT,
  kelas TEXT,
  jenis TEXT,
  jumlah REAL,
  keterangan TEXT
);
CREATE INDEX IF NOT EXISTS idx_kaskelas_kelas ON kaskelas(kelas);

CREATE TABLE IF NOT EXISTS struktur_kelas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kelas TEXT,
  jabatan TEXT,
  nis TEXT,
  nama_siswa TEXT
);
CREATE INDEX IF NOT EXISTS idx_struktur_kelas ON struktur_kelas(kelas);

CREATE TABLE IF NOT EXISTS inventaris (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kelas TEXT,
  nama_barang TEXT,
  jumlah INTEGER,
  kondisi TEXT,
  keterangan TEXT,
  tanggal TEXT
);
CREATE INDEX IF NOT EXISTS idx_inventaris_kelas ON inventaris(kelas);

CREATE TABLE IF NOT EXISTS pengumuman (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kelas TEXT,
  judul TEXT,
  isi TEXT,
  tanggal TEXT,
  penulis TEXT
);
CREATE INDEX IF NOT EXISTS idx_pengumuman_kelas ON pengumuman(kelas);

CREATE TABLE IF NOT EXISTS jadwal_pelajaran (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kelas TEXT,
  hari TEXT,
  jam_ke INTEGER,
  mata_pelajaran TEXT,
  nip TEXT
);
CREATE INDEX IF NOT EXISTS idx_jadwal_kelas ON jadwal_pelajaran(kelas);
CREATE INDEX IF NOT EXISTS idx_jadwal_nip ON jadwal_pelajaran(nip);

CREATE TABLE IF NOT EXISTS jadwal_piket (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kelas TEXT,
  hari TEXT,
  nis TEXT,
  nama_siswa TEXT
);
CREATE INDEX IF NOT EXISTS idx_piket_kelas ON jadwal_piket(kelas);

CREATE TABLE IF NOT EXISTS jurnal_bimbingan (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tanggal TEXT,
  kelas TEXT,
  kategori TEXT,
  isi TEXT,
  tindak_lanjut TEXT
);
CREATE INDEX IF NOT EXISTS idx_bimbingan_kelas ON jurnal_bimbingan(kelas);

CREATE TABLE IF NOT EXISTS jurnal_mengajar (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tanggal TEXT,
  kelas TEXT,
  nip TEXT,
  mapel TEXT,
  jam_ke INTEGER,
  materi TEXT,
  kegiatan TEXT
);
CREATE INDEX IF NOT EXISTS idx_jurnal_nip ON jurnal_mengajar(nip);

CREATE TABLE IF NOT EXISTS presensi_mapel (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tanggal TEXT,
  kelas TEXT,
  nis TEXT,
  nip TEXT,
  mapel TEXT,
  status TEXT,
  jam_ke INTEGER,
  created_at TEXT,
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_presmapel_nip_kelas ON presensi_mapel(nip, kelas);

CREATE TABLE IF NOT EXISTS nilai (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nis TEXT,
  kelas TEXT,
  nip TEXT,
  mapel TEXT,
  jenis TEXT,
  nilai REAL,
  tanggal TEXT
);
CREATE INDEX IF NOT EXISTS idx_nilai_nip_kelas ON nilai(nip, kelas);

CREATE TABLE IF NOT EXISTS katalog_alat (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kode TEXT,
  nama_barang TEXT,
  spesifikasi TEXT,
  jumlah INTEGER,
  kondisi TEXT,
  lokasi TEXT
);

CREATE TABLE IF NOT EXISTS bahan_praktik (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kode TEXT,
  nama_bahan TEXT,
  satuan TEXT,
  stok REAL,
  stok_min REAL,
  kategori TEXT
);

CREATE TABLE IF NOT EXISTS peminjaman (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  id_pinjam TEXT,
  kode_barang TEXT,
  nama_barang TEXT,
  peminjam TEXT,
  jenis_peminjam TEXT,
  tgl_pinjam TEXT,
  batas_waktu TEXT,
  status TEXT,
  tgl_kembali TEXT
);

CREATE TABLE IF NOT EXISTS laporan_kerusakan (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tanggal TEXT,
  kode_barang TEXT,
  nama_barang TEXT,
  kerusakan TEXT,
  pelapor TEXT,
  status TEXT,
  jadwal_maintenance TEXT
);

CREATE TABLE IF NOT EXISTS kunjungan_rumah (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tanggal TEXT,
  nis TEXT,
  kelas TEXT,
  nama_siswa TEXT,
  alamat TEXT,
  hasil TEXT,
  tindak_lanjut TEXT,
  petugas TEXT
);
CREATE INDEX IF NOT EXISTS idx_kunjungan_kelas ON kunjungan_rumah(kelas);

CREATE TABLE IF NOT EXISTS settings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  setting_key TEXT NOT NULL UNIQUE,
  setting_value TEXT
);

CREATE TABLE IF NOT EXISTS log_aktivitas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  waktu TEXT,
  username TEXT,
  role TEXT,
  aksi TEXT,
  detail TEXT
);
