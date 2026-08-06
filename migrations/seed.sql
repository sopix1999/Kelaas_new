-- ============================================================
-- KELAAS — Seed data awal (opsional; bisa juga lewat route /api setup)
-- Jalankan: npm run db:seed  (hanya jika tabel masih kosong)
-- Password di-hash dengan bcrypt (PHP format) — seed user asli dibuat
-- otomatis oleh route setup bila tabel kosong.
-- ============================================================

INSERT INTO settings (setting_key, setting_value) VALUES ('TA_AKTIF', '2025/2026');
INSERT INTO settings (setting_key, setting_value) VALUES ('SEMESTER', '1');
