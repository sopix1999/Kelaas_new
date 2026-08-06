// ============================================================
// Gemini client — port dari code.gs (aiGuru, aiTextToSoal,
// aiBuatSoalBank, generateSummary, parseSearchQuery,
// extractDataEntry, auto-grading essay, dsb).
// Dipanggil dari routes /__gas (bridge) atau route AI.
// ============================================================

const GEMINI_MODEL_DEFAULT = 'gemini-1.5-flash-latest';

export interface GeminiCtx {
  env: { GEMINI_KEY?: string; GEMINI_MODEL?: string };
}

export function geminiKey(c: GeminiCtx): string {
  return (c.env.GEMINI_KEY || '').trim();
}

export function geminiModel(c: GeminiCtx): string {
  return (c.env.GEMINI_MODEL || GEMINI_MODEL_DEFAULT).trim();
}

const SAFETY = [
  { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
  { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
];

async function callGemini(
  c: GeminiCtx,
  prompt: string,
  temperature = 0.3,
  maxOutputTokens = 2000,
): Promise<{ ok: boolean; text?: string; error?: string }> {
  const key = geminiKey(c);
  if (!key) return { ok: false, error: 'Kunci Gemini belum diset. Atur secret GEMINI_KEY (npx wrangler secret put GEMINI_KEY).' };
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel(c)}:generateContent?key=${key}`;
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { temperature, maxOutputTokens },
        safetySettings: SAFETY,
      }),
    });
    if (!r.ok) {
      const txt = await r.text();
      return { ok: false, error: 'Gemini HTTP ' + r.status + ': ' + txt.substring(0, 300) };
    }
    const j = (await r.json()) as any;
    const out = j?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    if (!out) return { ok: false, error: 'Gemini tidak mengembalikan teks.' };
    return { ok: true, text: out };
  } catch (e: unknown) {
    return { ok: false, error: 'Gagal AI: ' + (e instanceof Error ? e.message : String(e)) };
  }
}

// Ambil blok JSON pertama di dalam { } — tahan terhadap backtick/markdown.
export function extractJson(txt: string): any {
  const t = String(txt).replace(/```json|```/g, '').trim();
  const a = t.indexOf('{');
  const b = t.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try {
    return JSON.parse(t.substring(a, b + 1));
  } catch {
    return null;
  }
}

async function geminiJSON(c: GeminiCtx, prompt: string, temp: number, maxTokens: number): Promise<{ success: boolean; text?: string; parsed?: any; message?: string }> {
  const r = await callGemini(c, prompt, temp, maxTokens);
  if (!r.ok || !r.text) return { success: false, message: r.error };
  const parsed = extractJson(r.text);
  if (parsed === null && prompt.indexOf('KELUARKAN HANYA SATU OBJEK JSON') > -1) {
    return { success: false, message: 'AI tidak mengembalikan JSON valid: ' + r.text.substring(0, 300) };
  }
  return { success: true, text: r.text, parsed };
}

// ===================== AI GURU (perangkat ajar) =====================
function aiSystem(): string {
  return 'Anda adalah Ahli Kurikulum, Pakar Pendidikan, dan Guru Profesional yang sangat berpengalaman menyusun Perangkat Pembelajaran Kurikulum Merdeka berbasis Deep Learning dan Problem Based Learning (PBL). ' +
    'Gaya: praktis, siap pakai di kelas, bahasa Indonesia hangat dan jelas. Output TERSTRUKTUR dengan heading markdown (#, ##, ###), poin, dan tabel markdown yang rapi.';
}

function aiBuild(jenis: string, c: Record<string, any>): string {
  const mp = c.mapel || '[Mapel]';
  const kl = c.kelas || '[Kelas]';
  const top = c.topik || c.materi || '[Topik]';
  const kkm = c.kkm || 75;
  const tahun = new Date().getFullYear();
  const penyusun = (c.guruNama && c.guruNama !== '-' ? c.guruNama : '[Nama Penyusun]') + ' / ' + tahun;
  const base = `Konteks: Mapel=${mp}; Kelas=${kl}; ` + (top ? `Topik=${top}; ` : '') + `KKM=${kkm}.`;

  switch (String(jenis || '').toLowerCase()) {
    case 'modul':
      return `Bertindaklah sebagai Ahli Kurikulum. Buatkan Modul Ajar lengkap untuk Topik: "${top}" | Mapel: "${mp}" | Kelas: "${kl}".\n` +
        'FORMAT STRUKTUR:\n## A. Identitas Modul\n## B. Dimensi Profil Pelajar Pancasila\n## C. Model (PBL) & Pendekatan (Deep Learning)\n## D. Tujuan Pembelajaran\n## E. Langkah-Langkah Pembelajaran (Sintaks PBL dalam Tabel)\n## F. Asesmen & Lampiran (LKPD, Rubrik).\nGunakan format markdown yang rapi.';
    case 'atp': return base + ' Buat ATP: urutan TP per elemen, indikator, dan estimasi JP dalam tabel.';
    case 'soal': return base + ' Buat 10 SOAL: 5 PG, 3 Essay, 2 B/S. Sertakan kunci & pembahasan.';
    case 'lkpd': return base + ' Buat LKPD: judul, tujuan, petunjuk, 3-4 aktivitas bertahap, kolom jawaban, refleksi.';
    case 'rubrik': return base + ' Buat RUBRIK 4 kriteria x 4 skor dalam tabel dg deskriptor per skor.';
    case 'icebreaking': return base + ' Berikan 5 ICE BREAKING 3-5 menit relevan materi, tanpa alat khusus.';
    case 'pemantik': return base + ' Buat 8 PERTANYAAN PEMANTIK HOTS dari konkret ke abstrak.';
    case 'refleksi': return base + ' Buat panduan REFLEKSI: 3 soal siswa, 3 catatan guru, 1 tindak lanjut.';
    case 'analisisnilai': return base + ' Analisis data: rata-rata, sebaran, siswa di bawah KKM, rekomendasi. Data: ' + (c.data || '(umum)');
    case 'remedial': return base + ' Buat REMEDIAL & PENGAYAAN: kelompok siswa, materi ringkas, 3 soal remedial, 1 tugas pengayaan. KKM=' + kkm;
    case 'rapor': return base + ' Buat deskripsi rapor (2 paragraf) untuk ' + (c.nama || 'Ananda') + ', rata=' + (c.rata || '-') + ', catatan=' + (c.catatan || '-');
    default: return base + ' Bantu guru: ' + (c.prompt || jenis || 'perangkat ajar');
  }
}

export async function aiGuru(c: GeminiCtx, jenis: string, ctx: Record<string, any>): Promise<Record<string, any>> {
  const key = geminiKey(c);
  if (!key) return { success: false, message: 'Kunci Gemini belum diset. Jalankan setGeminiKey("...") di editor.' };
  const prompt = aiSystem() + '\n' + aiBuild(jenis, ctx || {});
  const r = await callGemini(c, prompt, 0.7, 4000);
  if (!r.ok || !r.text) return { success: false, message: r.error };
  return { success: true, text: r.text };
}

// ===================== TEXT TO SOAL =====================
export async function aiTextToSoal(c: GeminiCtx, teks: string, ctx: Record<string, any>): Promise<Record<string, any>> {
  const key = geminiKey(c);
  if (!key) return { success: false, message: 'Kunci Gemini belum diset. Jalankan setGeminiKey("...") di editor.' };
  teks = String(teks || '').trim();
  if (teks.length < 20) return { success: false, message: 'Teks terlalu pendek. Tempel materi/soal yang cukup.' };
  ctx = ctx || {};
  const jumlah = Math.max(1, Math.min(30, parseInt(String(ctx.jumlah), 10) || 10));
  const mapel = ctx.mapel || '[Mapel]';
  const jenis = String(ctx.jenis || 'PG').toLowerCase().indexOf('essay') > -1 ? 'Essay' : 'PG';

  const jenisInstr = (jenis === 'Essay')
    ? 'soal berjenis ESSAY (uraian singkat). Setiap soal terdiri dari: pertanyaan, pedoman/kunci jawaban (ringkasan jawaban yang benar), dan pembahasan singkat.'
    : 'soal PILIHAN GANDA berkualitas. Setiap soal terdiri dari: pertanyaan, 5 opsi jawaban (A, B, C, D, E), kunci jawaban (huruf A-E saja), dan pembahasan singkat.';

  const schema = (jenis === 'Essay')
    ? '{"mapel":"' + mapel + '","soal":[{"pertanyaan":"...","kunci":"<pedoman jawaban>","pembahasan":"..."}]}'
    : '{"mapel":"' + mapel + '","soal":[{"pertanyaan":"...","opsiA":"...","opsiB":"...","opsiC":"...","opsiD":"...","opsiE":"...","kunci":"A","pembahasan":"..."}]}';

  const prompt =
    'Kamu adalah pembuat soal ujian sekolah yang berpengalaman. ' +
    'Di bawah ini adalah teks mentah (materi, rangkuman, atau kumpulan soal) dari guru.\n\n' +
    'TUGAS: Pilah teks tsb menjadi ' + jumlah + ' ' + jenisInstr + '\n' +
    'Jangan buat soal dari luar isi teks. Jika teks hanya memuat sedikit konsep, jangan memaksakan jumlah; buat sebanyak yang bisa didukung teks. ' +
    'Bahasa Indonesia.\n\n' +
    'TEKS MENTAH:\n' + teks + '\n\n' +
    'KELUARKAN HANYA SATU OBJEK JSON (tanpa markdown, tanpa teks lain) dalam format persis:\n' +
    schema;

  const r = await callGemini(c, prompt, 0.4, 8000);
  if (!r.ok || !r.text) return { success: false, message: r.error };
  const parsed = extractJson(r.text);
  const list = parsed && parsed.soal;
  if (!list || !list.length) return { success: false, message: 'AI tidak mengembalikan soal yang valid. Coba lagi.' };
  const norm: Record<string, any>[] = [];
  for (const sItem of list) {
    if (!sItem || !String(sItem.pertanyaan || '').trim()) continue;
    if (jenis === 'Essay') {
      norm.push({ jenis: 'Essay', pertanyaan: String(sItem.pertanyaan).trim(), opsi: [], kunci: String(sItem.kunci || '').trim(), pembahasan: String(sItem.pembahasan || '').trim() });
      continue;
    }
    const opsi: string[] = [];
    for (const L of ['A', 'B', 'C', 'D', 'E']) {
      const v = String(sItem['opsi' + L] || '').trim();
      if (v) opsi.push(L + '. ' + v);
    }
    if (opsi.length < 2) continue;
    norm.push({ jenis: 'PG', pertanyaan: String(sItem.pertanyaan).trim(), opsi, kunci: String(sItem.kunci || '').trim().toUpperCase(), pembahasan: String(sItem.pembahasan || '').trim() });
  }
  if (!norm.length) return { success: false, message: 'Tidak ada soal valid hasil AI.' };
  return { success: true, mapel: parsed.mapel || mapel, jenis, soal: norm };
}

// ===================== BUAT SOAL BANK (dari topik) =====================
export async function aiBuatSoalBank(c: GeminiCtx, ctx: Record<string, any>): Promise<Record<string, any>> {
  const key = geminiKey(c);
  if (!key) return { success: false, message: 'Kunci Gemini belum diset. Jalankan setGeminiKey("...") di editor.' };
  ctx = ctx || {};
  const mapel = ctx.mapel || '[Mapel]';
  const topik = ctx.topik || ctx.materi || '[Topik]';
  const jumlah = Math.max(1, Math.min(30, parseInt(String(ctx.jumlah), 10) || 10));
  const jenis = ctx.jenis || 'PG';
  const jenisInstr = jenis === 'Essay'
    ? 'semua soal berjenis ESSAY (uraian singkat). Setiap soal: pertanyaan, pedoman jawaban (kunci), pembahasan.'
    : jenis === 'Campuran'
      ? 'sebagian PG (pilihan ganda A–E + kunci) dan sebagian Essay (uraian + pedoman). Tandai jenis="PG" atau "Essay".'
      : 'semua soal PILIHAN GANDA A–E. Setiap soal: pertanyaan, 5 opsi (A–E), kunci (huruf A–E), pembahasan singkat.';

  const prompt =
    'Kamu adalah pembuat soal ujian sekolah yang berpengalaman untuk Mapel: ' + mapel + ' (Kelas: ' + (ctx.kelas || '-') + ').\n\n' +
    'TUGAS: Buat ' + jumlah + ' soal berkualitas bertema "' + topik + '". Jenis yang diminta: ' + jenisInstr + '\n' +
    'Soal harus HOTS, sesuai kurikulum, bahasa Indonesia, dan tidak boleh mengada-ada fakta.\n\n' +
    'KELUARKAN HANYA SATU OBJEK JSON (tanpa markdown, tanpa teks lain) format persis:\n' +
    '{"soal":[{"jenis":"PG","pertanyaan":"...","opsi":["A. ...","B. ...","C. ...","D. ...","E. ..."],"kunci":"A","pembahasan":"...","bobot":1}]}\n' +
    'Untuk jenis "Essay", gunakan: {"jenis":"Essay","pertanyaan":"...","kunci":"<pedoman jawaban>","pembahasan":"...","bobot":5} (tanpa opsi).';

  const r = await callGemini(c, prompt, 0.6, 8000);
  if (!r.ok || !r.text) return { success: false, message: r.error };
  const parsed = extractJson(r.text);
  const list = parsed && parsed.soal;
  if (!list || !list.length) return { success: false, message: 'AI tidak mengembalikan soal yang valid. Coba lagi.' };
  const norm: Record<string, any>[] = [];
  for (const sItem of list) {
    if (!sItem || !String(sItem.pertanyaan || '').trim()) continue;
    const tipe = String(sItem.jenis || ctx.jenis || 'PG').toLowerCase();
    const jn = tipe.indexOf('essay') > -1 ? 'Essay' : 'PG';
    if (jn === 'PG') {
      let opsi: string[] = [];
      if (Array.isArray(sItem.opsi) && sItem.opsi.length) opsi = sItem.opsi;
      else {
        for (const L of ['A', 'B', 'C', 'D', 'E']) {
          const v = String(sItem['opsi' + L] || '').trim();
          if (v) opsi.push(L + '. ' + v);
        }
      }
      if (opsi.length < 2) continue;
      norm.push({ jenis: 'PG', pertanyaan: String(sItem.pertanyaan).trim(), opsi, kunci: String(sItem.kunci || '').trim().toUpperCase(), pembahasan: String(sItem.pembahasan || '').trim(), bobot: Number(sItem.bobot) || 1 });
    } else {
      norm.push({ jenis: 'Essay', pertanyaan: String(sItem.pertanyaan).trim(), opsi: [], kunci: String(sItem.kunci || '').trim(), pembahasan: String(sItem.pembahasan || '').trim(), bobot: Number(sItem.bobot) || 5 });
    }
  }
  if (!norm.length) return { success: false, message: 'Tidak ada soal valid hasil AI.' };
  return { success: true, mapel, kelas: ctx.kelas || '', soal: norm };
}

// ===================== RINGKASAN & ANALISIS DATA =====================
export async function generateSummary(c: GeminiCtx, kelas: string, type: string, dateFrom: string, dateTo: string, rawData: unknown): Promise<Record<string, any>> {
  let json = JSON.stringify(rawData);
  if (json.length > 6000) json = json.substring(0, 6000) + '…(terpotong)';
  const prompt =
    'Kamu adalah analis data sekolah yang andal dan ringkas. Di bawah ini adalah data mentah (JSON) dari ' +
    'sistem wali kelas untuk kelas ' + String(kelas || '-') + ', tipe "' + String(type || 'dashboard') + '".\n\n' +
    'TUGAS: Buatkan NARASI untuk dashboard yang berisi:\n' +
    '1) Ringkasan 3 paragraf (apa yang terjadi, tren, angka penting).\n' +
    '2) Bagian "Insight" berupa 3-5 poin bullet yang BERANI dan TINDAKAN LANJUT (bukan sekadar mengulang angka).\n' +
    '3) Bagian "Peringatan" bila ada hal yang perlu perhatian wali kelas (kehadiran rendah, siswa di bawah KKM, stok menipis, dst).\n' +
    'Bahasa Indonesia, hangat, profesional, tanpa mengada-ada fakta. Output markdown rapi.\n\n' +
    'DATA MENTAH:\n' + json;
  const r = await geminiJSON(c, prompt, 0.5, 2000);
  if (!r.success || !r.text) return { success: false, message: r.message };
  return { success: true, text: r.text };
}

// ===================== NL SEARCH =====================
const SEARCH_SCHEMA = {
  table: '<salah satu: kehadiran|nilai|tatatertib|jurnal_mengajar|jurnal_bimbingan|siswa|katalog_alat|bahan_praktik|peminjaman|kaskelas|pengumuman|kunjungan_rumah|presensi_mapel|tugas>',
};

export async function parseSearchQuery(c: GeminiCtx, teks: string, kelas: string): Promise<Record<string, any>> {
  const key = geminiKey(c);
  if (!key) return { success: false, message: 'Kunci Gemini belum diset. Jalankan setGeminiKey("...") di editor.' };
  teks = String(teks || '').trim();
  if (teks.length < 3) return { success: false, message: 'Ketik kalimat pencarian terlebih dahulu.' };
  const schema = '{"table":"' + SEARCH_SCHEMA.table + '","filters":[{"field":"<kolom yang diizinkan>","operator":"<eq|neq|gt|gte|lt|lte|like|not_like|in|not_in|between>","value":"<nilai; untuk between gunakan array [dari,ke], untuk in gunakan array berisi banyak nilai>"}]}';
  const prompt =
    'Kamu adalah Natural Language to SQL helper untuk aplikasi sekolah. Terjemahkan kalimat pengguna ' +
    'di bawah menjadi JSON PALING MIRING yang siap dipakai query. \n' +
    'PANDUAN KOLOM PER TABEL:\n' +
    '- kehadiran: tanggal, nis, status(Hadir/Sakit/Izin/Alfa), keterangan\n' +
    '- nilai: nis, mapel, jenis, nilai, tanggal\n' +
    '- tatatertib: tanggal, nis, pelanggaran, poin\n' +
    '- jurnal_mengajar: tanggal, nip, mapel, jam_ke, materi, kegiatan\n' +
    '- jurnal_bimbingan: tanggal, nis, kategori, isi, tindak_lanjut\n' +
    '- siswa: nis, nama_siswa, jk, ttl, alamat, no_wa, ekstra\n' +
    '- katalog_alat: kode, nama_barang, spesifikasi, jumlah, kondisi, lokasi\n' +
    '- bahan_praktik: kode, nama_bahan, satuan, stok, stok_min, kategori\n' +
    '- peminjaman: id_pinjam, kode_barang, nama_barang, peminjam, jenis_peminjam, tgl_pinjam, batas_waktu, status, tgl_kembali\n' +
    '- kaskelas: tanggal, jenis, jumlah, keterangan\n' +
    '- pengumuman: judul, isi, tanggal, penulis\n' +
    '- kunjungan_rumah: tanggal, nis, nama_siswa, alamat, hasil, tindak_lanjut, petugas\n' +
    '- presensi_mapel: tanggal, nis, nip, mapel, status, jam_ke\n' +
    '- tugas: id, mapel, judul, deskripsi, tenggat, status\n' +
    'ATURAN:\n' +
    '1. Tetapkan "table" yang paling sesuai dengan maksud pengguna.\n' +
    '2. "bulan lalu"/"bulan ini"/"tahun" → gunakan operator between dengan dua tanggal [dari, ke] (format YYYY-MM-DD).\n' +
    '3. Kata status tak selesai/kurang → gunakan operator like dengan nilai parsial (mis. "belum" atau "kurang").\n' +
    '4. Nama siswa → field nama_siswa dengan operator like (nilai tanpa %% di sini).\n' +
    '5. Hanya gunakan kolom yang terdaftar di atas; abaikan kolom lain.\n' +
    '6. Kelas disetel otomatis oleh sistem, TIDAK perlu dianggap dari kalimat.\n' +
    'KELUARKAN HANYA SATU OBJEK JSON (tanpa markdown, tanpa teks lain) format persis:\n' + schema + '\n\n' +
    'KALIMAT PENGGUNA: "' + teks + '"';
  const ai = await geminiJSON(c, prompt, 0.2, 1000);
  if (!ai.success) return ai;
  const parsed = ai.parsed;
  if (!parsed || !parsed.table) return { success: false, message: 'AI tidak dapat mengartikan pencarian. Coba lebih spesifik.' };
  return { success: true, parsed };
}

// ===================== EKSTRAK DATA ENTRY =====================
export async function extractDataEntry(c: GeminiCtx, teks: string, konteks: Record<string, any>): Promise<Record<string, any>> {
  const key = geminiKey(c);
  if (!key) return { success: false, message: 'Kunci Gemini belum diset. Jalankan setGeminiKey("...") di editor.' };
  teks = String(teks || '').trim();
  if (teks.length < 10) return { success: false, message: 'Teks terlalu pendek. Tempel catatan mentah yang cukup.' };
  konteks = konteks || {};
  const prompt =
    'Kamu adalah asisten input data. Ekstrak informasi dari catatan mentah guru di bawah menjadi ' +
    'JSON terstruktur untuk form entri tugas/aktivitas.\n\n' +
    'TUGAS: Isi sebanyak mungkin bidang berikut berdasarkan teks (kosongkan bila tak ada):\n' +
    '{"nama":"<nama tugas/aktivitas>","tanggal":"<YYYY-MM-DD>","tenggat":"<YYYY-MM-DD>","deskripsi":"<rangkuman singkat>"}\n\n' +
    'PANDUAN:\n' +
    '1. "nama" = tema/topik utama (mis. "Ekstraksi DNA", "Praktikum Titrasi").\n' +
    '2. "tanggal" = tanggal pelaksanaan/kegiatan; "tenggat" = batas waktu pengumpulan/' +
    'deadline. Jika teks menyebut "dikumpulkan"/"deadline"/"terakhir" → tenggat.\n' +
    '3. Tanggal ubah ke format YYYY-MM-DD; jika hanya disebutkan relatif (mis. "Senin", "besok") dan ' +
    'konteks hari ini = ' + String(konteks.tanggal || '') + ', hitung perkiraan tanggalnya.\n' +
    '4. "deskripsi" = rangkuman 1-2 kalimat dari isi catatan.\n' +
    '5. Jangan menambah informasi yang tidak ada di teks.\n' +
    'KELUARKAN HANYA SATU OBJEK JSON (tanpa markdown, tanpa teks lain).\n\n' +
    'CATATAN MENTAH:\n' + teks;
  const ai = await geminiJSON(c, prompt, 0.2, 800);
  if (!ai.success) return ai;
  const d = ai.parsed || {};
  return { success: true, nama: String(d.nama || '').trim(), tanggal: String(d.tanggal || '').trim(), tenggat: String(d.tenggat || '').trim(), deskripsi: String(d.deskripsi || '').trim(), raw: d };
}

// ===================== AUTO-GRADING ESSAY =====================
function aiGradePrompt(jawaban: string, pertanyaan: string, kunci: string, bobot: number): string {
  const b = Math.max(1, parseInt(String(bobot), 10) || 5);
  return 'Kamu adalah guru penilai ulangan (CBT) yang teliti dan adil. ' +
    'Nilailah jawaban ESSAY siswa berdasarkan PEDOMAN/RUBRIK yang diberikan. ' +
    'Berikan skor dalam rentang 0 sampai ' + b + ' (' + b + ' = sempurna) dan umpan balik singkat (1-2 kalimat, bahasa Indonesia).\n\n' +
    'PERTANYAAN:\n' + (pertanyaan || '(tidak ada)') + '\n\n' +
    'PEDOMAN / KUNCI JAWABAN:\n' + (kunci || '(tidak ada pedoman — gunakan penilaian profesional)') + '\n\n' +
    'JAWABAN SISWA:\n' + (jawaban || '(kosong)') + '\n\n' +
    'JAWABAN KOSONG → skor 0.\n' +
    'KELUARKAN HANYA SATU OBJEK JSON (tanpa markdown, tanpa teks lain) persis format:\n' +
    '{"skor": <angka 0..' + b + '>, "feedback": "<umpan balik singkat>"}';
}

export async function aiCallGrade(c: GeminiCtx, jawaban: string, pertanyaan: string, kunci: string, bobot: number): Promise<Record<string, any>> {
  const key = geminiKey(c);
  if (!key) return { success: false, message: 'Kunci Gemini belum diset.' };
  const prompt = aiGradePrompt(jawaban, pertanyaan, kunci, bobot);
  const r = await callGemini(c, prompt, 0.2, 600);
  if (!r.ok || !r.text) return { success: false, message: r.error };
  const parsed = extractJson(r.text);
  if (!parsed || parsed.skor === undefined) return { success: false, message: 'AI tidak mengembalikan skor valid.' };
  let skor = parseFloat(parsed.skor);
  if (isNaN(skor)) skor = 0;
  skor = Math.max(0, Math.min(Number(bobot), skor));
  return { success: true, skor, feedback: String(parsed.feedback || '').trim() };
}
