# KELAAS — Sistem Wali Kelas (Cloudflare Workers / Hono / D1)

Migrasi dari **Google Apps Script (`code.gs`) + PHP (`index.php`) + MySQL** ke
**Cloudflare Workers** dengan:

- **Hono** — router HTTP (worker entry `src/index.ts`)
- **Cloudflare D1** (SQLite) — pengganti MySQL; skema di `migrations/`
- **Bridge `google.script.run`** — frontend `index.html` lama tetap jalan tanpa
  perubahan besar: `call('namaFungsi', args...)` → `POST /__gas` → handler
  server setara fungsi GAS
- **AI Gemini** — `GEMINI_KEY` sebagai secret (bukan Script Properties)

## Struktur

```
├─ src/
│  ├─ index.ts            # Hono entry: API + bridge + static assets
│  ├─ api/
│  │  └─ routes.ts        # port index.php → handler /api (60+ action)
│  ├─ api-bridge.ts       # port code.gs → emulasi google.script.run
│  ├─ lib/
│  │  ├─ db.ts            # helper D1 (prepared statements)
│  │  ├─ crypto.ts        # token, tanggal WIB
│  │  ├─ passwords.ts     # bcryptjs (+ fallback PBKDF2) — kompat hash PHP
│  │  └─ gemini.ts        # AI Guru, text-to-soal, grading essay, dst.
│  └─ pdf.ts              # generator dokumen (Rekap Nilai/Kehadiran/Laporan)
├─ public/
│  └─ index.html          # frontend lama + patch fetch (/__gas)
├─ migrations/            # skema D1: 0001_init, 0002_cbt, 0003_guru_v2, seed
├─ wrangler.jsonc         # config worker + D1 binding
├─ package.json
└─ tsconfig.json
```

## 1) Setup lokal

```bash
npm install

# (a) buat DB D1 & isi database_id di wrangler.jsonc
npx wrangler d1 create kelaas-db
#    → salin database_id dari output ke wrangler.jsonc (d1_databases[0].database_id)

# (b) jalankan migrasi + seed lokal
npm run db:migrate:local
npm run db:seed

# (c) secret Gemini untuk fitur AI
#    lokal: isi .dev.vars (GEMINI_KEY=...)
#    prod : npx wrangler secret put GEMINI_KEY
```

## 2) Jalankan lokal

```bash
npm run dev
```

Buka `http://localhost:8787`.

> Login pertama: **admin / admin123** (akun seed dibuat otomatis oleh route
> `/api?action=setup` bila tabel users kosong — atau panggil endpoint setup
> dari menu, atau jalankan `npm run db:seed` lalu tambahkan user via admin).

## 3) Deploy

```bash
npm run build        # dry-run bundle (validasi kode)
npx wrangler d1 migrations apply kelaas-db --remote   # migrasi prod
npx wrangler secret put GEMINI_KEY                     # secret AI prod
npm run deploy       # npx wrangler deploy
```

Setelah deploy: buka `<your-worker>.workers.dev`, login, lalu dari menu
**Manajemen → Setup** jalankan `runSetup`/`runSetupCbt` bila ada tabel yang
belum dibuat (setup ini juga meng-seed user default jika tabel users kosong).

## Migrasi data dari MySQL lama

1. Export tabel dari MySQL (mis. via `mysqldump --compatible=no_field_options --skip-add-locks`).
2. Ubah tipe: `INT AUTO_INCREMENT` → `INTEGER PRIMARY KEY AUTOINCREMENT`, `DATE`/`DATETIME` → `TEXT`, `DECIMAL` → `REAL`, `NOW()` → teks tanggal ISO.
3. Import ke D1: `npx wrangler d1 execute kelaas-db --remote --file=migrasi.sql`.
4. Pastikan password pengguna tetap hash bcrypt (`$2y$...`) — `passwords.ts` bisa verifikasi; password plain text lama otomatis di-hash ulang saat login.

## Catatan migrasi teknis

| Sumber (PHP/GAS)          | Target (Workers)                                   |
|---------------------------|----------------------------------------------------|
| `index.php?action=X`      | `GET/POST/PUT/DELETE /api?action=X`                |
| `google.script.run.fn()`  | `POST /__gas {fn, args}` (bridge)                  |
| MySQL `users/siswa/...`   | D1 SQLite, `migrations/*.sql`                      |
| `password_hash()` bcrypt  | `bcryptjs` + fallback PBKDF2 (`passwords.ts`)      |
| PropertiesService GEMINI  | secret `GEMINI_KEY` (`.dev.vars` / `wrangler secret`) |
| DocumentApp + Drive (PDF) | dokumen HTML base64 — browser **Print → Save as PDF** |
| Cron `cbtCleanupExpired`  | jadwalkan via Cron Triggers Cloudflare (`src/index.ts` sudah export handler, atau panggil `/api?action=cbt-cleanup-expired`) |

### PDF
`generate*PDF` lama memakai Google Docs. Di Workers tanpa server-side PDF,
file dihasilkan sebagai dokumen **HTML** (base64). `dlPdf()` di frontend
membukanya di tab baru → gunakan **Ctrl+P → Save as PDF**. Data (headers,
tabel, wali kelas) dipertahankan 1:1 dari logika `code.gs`.

### Cron CBT cleanup
Untuk meniru trigger `cbtCleanupExpired` 5 menit:
- Buka dashboard Cloudflare → Worker → **Triggers → Cron Triggers** → `*/5 * * * *`.
- `src/index.ts` sudah mengekspor handler `scheduled` yang memanggil
  `POST /api?action=cbt-cleanup-expired` ke worker sendiri.
