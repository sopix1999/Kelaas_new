/**
* KELAAS — Code.gs (REST Bridge + AI Guru + PDF)
* All data ops delegate to external PHP API.
* @OnlyCurrentDoc
*/
var API_BASE    = PropertiesService.getScriptProperties().getProperty('API_BASE') || 'https://kelaas.free.je/api/index.php';
var GEMINI_MODEL = 'gemini-flash-latest';

function doGet(){
  return HtmlService.createHtmlOutputFromFile('Index')
    .setTitle('KELAAS — Sistem Wali Kelas')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
    .addMetaTag('viewport','width=device-width, initial-scale=1');
}

// ===================== TRANSPORT (FIX ERROR HANDLING) =====================
function _req(method, action, params, payload){
  method = String(method||'GET').toUpperCase();
  var url = API_BASE + '?action=' + encodeURIComponent(action);
  if (params){
    var q=[];
    for (var k in params) {
      if (params.hasOwnProperty(k) && params[k] !== undefined && params[k] !== null && params[k] !== '')
        q.push(encodeURIComponent(k)+'='+encodeURIComponent(String(params[k])));
    }
    if (q.length) url += '&'+q.join('&');
  }
  
  // ✅ FIX 403 FORBIDDEN: Tambahkan header browser agar tidak diblokir WAF OpenResty
  var opt = { 
    method: method, 
    muteHttpExceptions: true, 
    contentType: 'application/json',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      'Accept': 'application/json, text/plain, */*',
      'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
      'Origin': 'https://kelaas.free.je',
      'Referer': 'https://kelaas.free.je/'
    }
  };
  
  if (payload !== undefined && payload !== null && method !== 'GET' && method !== 'DELETE')
    opt.payload = JSON.stringify(payload);
    
  try {
    var r = UrlFetchApp.fetch(url, opt);
    var txt = r.getContentText();
    var code = r.getResponseCode();
    
    // ✅ Deteksi halaman error HTML dari WAF/OpenResty
    if (code >= 400 || txt.indexOf('<html>') === 0 || txt.indexOf('<!doctype') === 0 || txt.indexOf('<center>') > -1) {
      return { success:false, message:'Server memblokir koneksi (HTTP '+code+'). Hubungi admin hosting untuk whitelist IP Google.' };
    }
    
    try { return JSON.parse(txt); }
    catch(e){ return { success:false, message:'Response bukan JSON: '+txt.substring(0,200)}; }
  } catch(e){ 
    return { success:false, message:'Gagal koneksi API: '+e.message }; 
  }
}

function _d(r, fb){ return (r && r.success) ? r.data : (fb === undefined ? null : fb); }
function _m(r){ return (r && r.success) ? (r.message || 'Tersimpan') : ('Error: '+((r&&r.message)||'gagal')); }
function getTodayStr(){ return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd'); }

// ===================== AUTH =====================
function validateLogin(u, p){
  var r = _req('POST', 'login', null, {username:u, password:p});
  if (r && r.success) {
    var user = r.data || {};
    user.roles = user.roles || [user.role];
    return {success:true, user:user};
  }
  return {success:false, message:(r&&r.message)||'Login gagal'};
}
function logActivity(username, role, aksi, detail){
  _req('POST', 'log-aktivitas', null, {username:username, role:role, aksi:aksi, detail:detail||''});
  return 'OK';
}
function getTAInfo(){ return _d(_req('GET', 'settings'), {ta:'2025/2026', semester:'1'}); }
function setTA(ta, sem){ return _m(_req('POST', 'settings', null, {ta:ta, semester:sem})); }

// ===================== DASHBOARD =====================
function getDashboardData(kelas, role, nip){ return _d(_req('GET', 'dashboard', {kelas:kelas, role:role, nip:nip}), {}); }
function getDashboardRekap(kelas, role, nip){ return _d(_req('GET', 'dashboard-rekap', {kelas:kelas, role:role, nip:nip}), {}); }
function getEarlyWarning(kelas){ return _d(_req('GET', 'early-warning', {kelas:kelas}), []); }
function getMyData(kelas, nis){ return _d(_req('GET', 'my-data', {kelas:kelas, nis:nis}), {}); }
function getOrtuData(nis){ return _d(_req('GET', 'ortu-data', {nis:nis}), {}); }
function getGuruDashboard(nip){ return _d(_req('GET', 'guru-dashboard', {nip:nip}), {}); }
function getGuruInfo(nip){ return _d(_req('GET', 'guru-info', {nip:nip}), {info:null, kelasDiampu:[]}); }
function getMapelGuruDiKelas(nip, kelas){ return _d(_req('GET', 'mapel-guru-kelas', {nip:nip, kelas:kelas}), []); }
function addKelasDiampu(nip, kelas){ return _m(_req('POST', 'guru-add-kelas', null, {nip:nip, kelas:kelas})); }

// ===================== SISWA =====================
function getSiswaList(kelas){ return _d(_req('GET', 'siswa', {kelas:kelas}), []); }
function getSiswaOptions(kelas){ return _d(_req('GET', 'siswa-options', {kelas:kelas}), []); }
// ✅ Profil & data ortu (TTL, Alamat, No WA, Ekstra, Ayah, Ibu, Pekerjaan, Penghasilan).
// extra dipakai opsional agar pemanggil lama tetap berfungsi.
function addSiswa(kelas, nis, nama, jk, extra){ extra = extra||{}; return _m(_req('POST', 'siswa', null, {kelas:kelas, nis:nis, nama:nama, jk:jk, ttl:extra.ttl, alamat:extra.alamat, noWa:extra.noWa, ekstra:extra.ekstra, namaAyah:extra.namaAyah, namaIbu:extra.namaIbu, kerjaAyah:extra.kerjaAyah, kerjaIbu:extra.kerjaIbu, penghasilanOrtu:extra.penghasilanOrtu})); }
function updateSiswa(kelas, oldNis, nis, nama, jk, extra){ extra = extra||{}; return _m(_req('PUT', 'siswa', null, {kelas:kelas, oldNis:oldNis, nis:nis, nama:nama, jk:jk, ttl:extra.ttl, alamat:extra.alamat, noWa:extra.noWa, ekstra:extra.ekstra, namaAyah:extra.namaAyah, namaIbu:extra.namaIbu, kerjaAyah:extra.kerjaAyah, kerjaIbu:extra.kerjaIbu, penghasilanOrtu:extra.penghasilanOrtu})); }
function deleteSiswa(kelas, nis){ return _m(_req('DELETE', 'siswa', {kelas:kelas, nis:nis})); }
function importDataSiswa(arr, kelas){ return _m(_req('POST', 'siswa-import', null, {kelas:kelas, data:arr})); }

// ===================== KEHADIRAN =====================
function getKehadiranByDate(kelas, tgl){ return _d(_req('GET', 'kehadiran', {kelas:kelas, tanggal:tgl}), []); }
function submitBulkKehadiran(kelas, tgl, recs){ return _m(_req('POST', 'kehadiran', null, {kelas:kelas, tanggal:tgl, records:recs})); }

// ===================== TATIB / KAS / STRUKTUR / INVENTARIS / PENGUMUMAN =====================
function getTataTertibList(kelas){ return _d(_req('GET','tatatertib',{kelas:kelas}),[]); }
function addTataTertib(kelas,t,nis,pelanggaran,poin){ return _m(_req('POST','tatatertib',null,{kelas:kelas,tanggal:t,nis:nis,pelanggaran:pelanggaran,poin:poin})); }
function deleteTataTertib(row){ return _m(_req('DELETE','tatatertib',{id:row})); }
function getKasList(kelas){ return _d(_req('GET','kas',{kelas:kelas}),[]); }
function getKasSummary(kelas){ return _d(_req('GET','kas-summary',{kelas:kelas}),{totalMasuk:0,totalKeluar:0,saldo:0}); }
function addKas(kelas,tanggal,jenis,jumlah,keterangan){ return _m(_req('POST','kas',null,{kelas:kelas,tanggal:tanggal,jenis:jenis,jumlah:jumlah,keterangan:keterangan})); }
function deleteKas(row){ return _m(_req('DELETE','kas',{id:row})); }
function getStrukturKelas(kelas){ return _d(_req('GET','struktur',{kelas:kelas}),[]); }
function saveStrukturKelas(kelas,data){ return _m(_req('POST','struktur',null,{kelas:kelas,data:data})); }
function getInventarisList(kelas){ return _d(_req('GET','inventaris',{kelas:kelas}),[]); }
function addInventaris(kelas,nama,jumlah,kondisi,keterangan){ return _m(_req('POST','inventaris',null,{kelas:kelas,nama:nama,jumlah:jumlah,kondisi:kondisi,keterangan:keterangan})); }
function deleteInventaris(row){ return _m(_req('DELETE','inventaris',{id:row})); }
function getPengumumanList(kelas){ return _d(_req('GET','pengumuman',{kelas:kelas}),[]); }
function addPengumuman(kelas,judul,isi,penulis){ return _m(_req('POST','pengumuman',null,{kelas:kelas,judul:judul,isi:isi,penulis:penulis})); }
function deletePengumuman(row){ return _m(_req('DELETE','pengumuman',{id:row})); }

// ===================== JADWAL / PIKET =====================
function getJadwalPelajaran(kelas){ return _d(_req('GET','jadwal',{kelas:kelas}),[]); }
function addJadwalPelajaran(kelas,hari,jam,mapel,nip){ return _m(_req('POST','jadwal',null,{kelas:kelas,hari:hari,jam:jam,mapel:mapel,nip:nip})); }
function updateJadwalPelajaran(row,kelas,hari,jam,mapel,nip){ return _m(_req('PUT','jadwal',null,{id:row,kelas:kelas,hari:hari,jam:jam,mapel:mapel,nip:nip})); }
function deleteJadwalPelajaran(row){ return _m(_req('DELETE','jadwal',{id:row})); }
function getJadwalMengajar(nip){ return _d(_req('GET','jadwal-mengajar',{nip:nip}),[]); }
function getJadwalByGuru(nip){ return _d(_req('GET','jadwal-by-guru',{nip:nip}),[]); }
function getJadwalPiket(kelas){ return _d(_req('GET','jadwal-piket',{kelas:kelas}),[]); }
function savePiketForDay(kelas,hari,students){ return _m(_req('POST','jadwal-piket',null,{kelas:kelas,hari:hari,students:students})); }

// ===================== BIMBINGAN / KUNJUNGAN =====================
function getJurnalBimbingan(kelas){ return _d(_req('GET','jurnal-bimbingan',{kelas:kelas}),[]); }
function addJurnalBimbingan(kelas,tanggal,kategori,isi,tindakLanjut){ return _m(_req('POST','jurnal-bimbingan',null,{kelas:kelas,tanggal:tanggal,kategori:kategori,isi:isi,tindakLanjut:tindakLanjut})); }
function deleteJurnalBimbingan(row){ return _m(_req('DELETE','jurnal-bimbingan',{id:row})); }
function getKunjunganRumah(kelas){ return _d(_req('GET','kunjungan-rumah',{kelas:kelas}),[]); }
function addKunjunganRumah(kelas,tanggal,nisNama,alamat,hasil,tindakLanjut,petugas){ return _m(_req('POST','kunjungan-rumah',null,{kelas:kelas,tanggal:tanggal,nisNama:nisNama,alamat:alamat,hasil:hasil,tindakLanjut:tindakLanjut,petugas:petugas})); }
function deleteKunjunganRumah(row){ return _m(_req('DELETE','kunjungan-rumah',{id:row})); }

// ===================== JURNAL MENGAJAR =====================
function getJurnalMengajar(nip){ return _d(_req('GET','jurnal-mengajar',{nip:nip}),[]); }
function addJurnalMengajar(nip,tgl,kelas,mapel,jam,materi,keg,extra){
  extra = extra||{};
  return _m(_req('POST','jurnal-mengajar',null,{
    nip:nip, tanggal:tgl, kelas:kelas, mapel:mapel, jam:jam, materi:materi, kegiatan:keg,
    tujuan:extra.tujuan||'', model:extra.model||'', metode:extra.metode||'', media:extra.media||'',
    asesmen:extra.asesmen||'', refleksi:extra.refleksi||'', hambatan:extra.hambatan||'', solusi:extra.solusi||''
  }));
}
function updateJurnalMengajarFull(row, p){ return _m(_req('PUT','jurnal-mengajar',null, Object.assign({id:row}, p))); }
function deleteJurnalMengajar(row, nip){ return _m(_req('DELETE','jurnal-mengajar',{id:row, nip:nip})); }
function getPresensiMapelByDate(nip,kelas,tgl){ return _d(_req('GET','presensi-mapel',{nip:nip,kelas:kelas,tanggal:tgl}),[]); }
function submitPresensiMapel(nip,kelas,mapel,tgl,recs){ return _m(_req('POST','presensi-mapel',null,{nip:nip,kelas:kelas,mapel:mapel,tanggal:tgl,records:recs})); }

// ===================== NILAI =====================
function getRekapNilai(nip,kelas,mapel){ return _d(_req('GET','nilai-rekap',{nip:nip,kelas:kelas,mapel:mapel||''}),{students:[],mapel:'-',kelas:kelas}); }
function getPeringkatKelas(nip,kelas,mapel){ return _d(_req('GET','nilai-peringkat',{nip:nip,kelas:kelas,mapel:mapel||''}),[]); }
function saveNilaiBulk(nip,kelas,mapel,entries){ return _m(_req('POST','nilai-bulk',null,{nip:nip,kelas:kelas,mapel:mapel,entries:entries})); }
function getAnalisisNilai(nip,kelas,mapel){ return _d(_req('GET','analisis-nilai',{nip:nip,kelas:kelas,mapel:mapel||''}),{}); }

// ===================== USER / LOG =====================
function getAllUsers(){ return _d(_req('GET','users'),[]); }
function addUser(username,password,role,kelas,nama,kodeGuru){ return _m(_req('POST','users',null,{username:username,password:password,role:role,kelas:kelas,nama:nama,kodeGuru:kodeGuru})); }
function updateUser(row,username,password,role,kelas,nama,kodeGuru){ return _m(_req('PUT','users',null,{id:row,username:username,password:password,role:role,kelas:kelas,nama:nama,kodeGuru:kodeGuru})); }
function deleteUser(row){ return _m(_req('DELETE','users',{id:row})); }
function getLogAktivitas(){ return _d(_req('GET','log-aktivitas'),[]); }

// ===================== GURU PROFILE / MATERI / MODUL =====================
function getGuruProfil(nip){ return _d(_req('GET','guru-profil',{nip:nip}),{}); }
function saveGuruProfil(p){ return _m(_req('POST','guru-profil',null, p)); }
function getMateri(params){ var nip=typeof params==='string'?params:(params&&params.nip); return _d(_req('GET','materi',{nip:nip||''}),[]); }
function addMateri(o){ return _m(_req('POST','materi',null,o)); }
function deleteMateri(row){ return _m(_req('DELETE','materi',{id:row})); }
function getModulAjar(nip){ return _d(_req('GET','modul-ajar',{nip:nip}),[]); }
function addModulAjar(o){ return _m(_req('POST','modul-ajar',null,o)); }
function deleteModulAjar(row){ return _m(_req('DELETE','modul-ajar',{id:row})); }

// ===================== TUGAS / PENGUMPULAN =====================
function getTugas(nip){ return _d(_req('GET','tugas',{nip:nip}),[]); }
function addTugas(o){ return _m(_req('POST','tugas',null,o)); }
function deleteTugas(row){ return _m(_req('DELETE','tugas',{id:row})); }
function getPengumpulan(tugasId){ return _d(_req('GET','pengumpulan',{tugasId:tugasId}),[]); }
function nilaiPengumpulan(id,nilai,feedback){ return _m(_req('PUT','pengumpulan',null,{id:id,nilai:nilai,feedback:feedback})); }

// ===================== CATATAN PERILAKU / PORTOFOLIO =====================
function getCatatanPerilaku(nip,kelas){ return _d(_req('GET','catatan-perilaku',kelas?{nip:nip,kelas:kelas}:{nip:nip}),[]); }
function addCatatanPerilaku(o){ return _m(_req('POST','catatan-perilaku',null,o)); }
function deleteCatatanPerilaku(row){ return _m(_req('DELETE','catatan-perilaku',{id:row})); }
function getPortofolio(nip,nis){ return _d(_req('GET','portofolio',nis?{nip:nip,nis:nis}:{nip:nip}),[]); }
function addPortofolio(o){ return _m(_req('POST','portofolio',null,o)); }
function deletePortofolio(row){ return _m(_req('DELETE','portofolio',{id:row})); }

// ===================== RUBRIK / AGENDA =====================
function getRubrik(params){ var nip=typeof params==='string'?params:(params&&params.nip); return _d(_req('GET','rubrik',{nip:nip||''}),[]); }
function addRubrik(nip,nama,komponen){ return _m(_req('POST','rubrik',null,{nip:nip,nama:nama,komponen:komponen})); }
function deleteRubrik(row){ return _m(_req('DELETE','rubrik',{id:row})); }
function getAgenda(params){ var nip=typeof params==='string'?params:(params&&params.nip); return _d(_req('GET','agenda',{nip:nip||''}),[]); }
function addAgenda(o){ return _m(_req('POST','agenda',null,o)); }
function deleteAgenda(row){ return _m(_req('DELETE','agenda',{id:row})); }

// ===================== PRESENSI GURU =====================
function getPresensiGuru(params){ var nip=typeof params==='string'?params:(params&&params.nip); return _d(_req('GET','presensi-guru',{nip:nip||''}),[]); }
function addPresensiGuru(o){ return _m(_req('POST','presensi-guru',null,o)); }

// ===================== TOOLMAN =====================
function getKatalogAlat(){ return _d(_req('GET','katalog-alat'),[]); }
function addKatalogAlat(kode,nama,spesifikasi,jumlah,kondisi,lokasi){ return _m(_req('POST','katalog-alat',null,{kode:kode,nama:nama,spesifikasi:spesifikasi,jumlah:jumlah,kondisi:kondisi,lokasi:lokasi})); }
function deleteKatalogAlat(row){ return _m(_req('DELETE','katalog-alat',{id:row})); }
function getBahanPraktik(){ return _d(_req('GET','bahan-praktik'),[]); }
function addBahanPraktik(kode,nama,satuan,stok,stokMin,kategori){ return _m(_req('POST','bahan-praktik',null,{kode:kode,nama:nama,satuan:satuan,stok:stok,stokMin:stokMin,kategori:kategori})); }
function updateStokBahan(kode,delta){ return _m(_req('PUT','bahan-praktik',null,{kode:kode,delta:delta})); }
function deleteBahanPraktik(row){ return _m(_req('DELETE','bahan-praktik',{id:row})); }
function getPeminjaman(){ return _d(_req('GET','peminjaman'),[]); }
function scanPeminjam(code){ return _d(_req('GET','scan-peminjam',{code:code}),{found:false,nama:'',jenis:'',kelas:''}); }
function addPeminjaman(kb,peminjam,jenis,batas){
  var r=_req('POST','peminjaman',null,{kodeBarang:kb,peminjam:peminjam,jenis:jenis,batas:batas});
  return {success:!!(r&&r.success), message:(r&&r.message)||'Gagal'};
}
function returnPeminjaman(row){ return _m(_req('PUT','peminjaman',null,{id:row})); }
function getLaporanKerusakan(){ return _d(_req('GET','laporan-kerusakan'),[]); }
function addLaporanKerusakan(kode,nama,kerusakan,pelapor,jadwal){ return _m(_req('POST','laporan-kerusakan',null,{kode:kode,nama:nama,kerusakan:kerusakan,pelapor:pelapor,jadwal:jadwal})); }
function updateStatusKerusakan(row,status){ return _m(_req('PUT','laporan-kerusakan',null,{id:row,status:status})); }
function deleteLaporanKerusakan(row){ return _m(_req('DELETE','laporan-kerusakan',{id:row})); }

// ===================== BACKUP =====================
function backupToDrive(){
  try {
    var r=_req('GET','backup-dump');
    var data=(r&&r.success)?r.data:{};
    var date=Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyyMMdd_HHmm');
    var folders=DriveApp.getFoldersByName('KELAAS_Backup');
    var folder=folders.hasNext()?folders.next():DriveApp.createFolder('KELAAS_Backup');
    folder.createFile('KELAAS_Backup_'+date+'.json', JSON.stringify(data,null,2), MimeType.PLAIN_TEXT);
    return 'Backup berhasil: KELAAS_Backup_'+date+'.json';
  } catch(e){ return 'Error: '+e.message; }
}
function setupAutoBackup(){
  var tr=ScriptApp.getProjectTriggers();
  for (var i=0;i<tr.length;i++){
    if (tr[i].getHandlerFunction()==='backupToDrive') ScriptApp.deleteTrigger(tr[i]);
  }
  ScriptApp.newTrigger('backupToDrive').timeBased().everyDays(1).atHour(1).create();
  return 'Auto-backup harian jam 01:00 aktif.';
}

// ===================== AI GURU (Gemini) =====================
function setGeminiKey(k){
  PropertiesService.getScriptProperties().setProperty('GEMINI_KEY', String(k||'').trim());
  return 'Kunci Gemini tersimpan di Script Properties.';
}
function getGeminiKey(){ return PropertiesService.getScriptProperties().getProperty('GEMINI_KEY')||''; }

function _aiSystem(){
  return 'Anda adalah Ahli Kurikulum, Pakar Pendidikan, dan Guru Profesional yang sangat berpengalaman menyusun Perangkat Pembelajaran Kurikulum Merdeka berbasis Deep Learning dan Problem Based Learning (PBL). '+
  'Gaya: praktis, siap pakai di kelas, bahasa Indonesia hangat dan jelas. Output TERSTRUKTUR dengan heading markdown (#, ##, ###), poin, dan tabel markdown yang rapi.';
}

function _aiBuild(jenis, c){
  c=c||{}; var mp=c.mapel||'[Mapel]', kl=c.kelas||'[Kelas]', top=c.topik||c.materi||'[Topik]', kkm=c.kkm||75;
  var tahun=new Date().getFullYear();
  var penyusun=(c.guruNama&&c.guruNama!=='-'?c.guruNama:'[Nama Penyusun]')+' / '+tahun;
  var base='Konteks: Mapel='+mp+'; Kelas='+kl+'; '+(top?('Topik='+top+'; '):'')+'KKM='+kkm+'.';
  
  switch(String(jenis||'').toLowerCase()){
    case 'modul':
      return 'Bertindaklah sebagai Ahli Kurikulum. Buatkan Modul Ajar lengkap untuk Topik: "'+top+'" | Mapel: "'+mp+'" | Kelas: "'+kl+'".\n'+
      'FORMAT STRUKTUR:\n## A. Identitas Modul\n## B. Dimensi Profil Pelajar Pancasila\n## C. Model (PBL) & Pendekatan (Deep Learning)\n## D. Tujuan Pembelajaran\n## E. Langkah-Langkah Pembelajaran (Sintaks PBL dalam Tabel)\n## F. Asesmen & Lampiran (LKPD, Rubrik).\nGunakan format markdown yang rapi.';
    case 'atp': return base+' Buat ATP: urutan TP per elemen, indikator, dan estimasi JP dalam tabel.';
    case 'soal': return base+' Buat 10 SOAL: 5 PG, 3 Essay, 2 B/S. Sertakan kunci & pembahasan.';
    case 'lkpd': return base+' Buat LKPD: judul, tujuan, petunjuk, 3-4 aktivitas bertahap, kolom jawaban, refleksi.';
    case 'rubrik': return base+' Buat RUBRIK 4 kriteria x 4 skor dalam tabel dg deskriptor per skor.';
    case 'icebreaking': return base+' Berikan 5 ICE BREAKING 3-5 menit relevan materi, tanpa alat khusus.';
    case 'pemantik': return base+' Buat 8 PERTANYAAN PEMANTIK HOTS dari konkret ke abstrak.';
    case 'refleksi': return base+' Buat panduan REFLEKSI: 3 soal siswa, 3 catatan guru, 1 tindak lanjut.';
    case 'analisisnilai': return base+' Analisis data: rata-rata, sebaran, siswa di bawah KKM, rekomendasi. Data: '+(c.data||'(umum)');
    case 'remedial': return base+' Buat REMEDIAL & PENGAYAAN: kelompok siswa, materi ringkas, 3 soal remedial, 1 tugas pengayaan. KKM='+kkm;
    case 'rapor': return base+' Buat deskripsi rapor (2 paragraf) untuk '+(c.nama||'Ananda')+', rata='+(c.rata||'-')+', catatan='+(c.catatan||'-');
    default: return base+' Bantu guru: '+(c.prompt||jenis||'perangkat ajar');
  }
}

function aiGuru(jenis, ctx){
  var key = getGeminiKey();
  if (!key) return {success:false, message:'Kunci Gemini belum diset. Jalankan setGeminiKey("...") di editor.'};
  var prompt = _aiSystem() + '\n' + _aiBuild(jenis, ctx);
  var url = 'https://generativelanguage.googleapis.com/v1beta/models/' + GEMINI_MODEL + ':generateContent?key=' + key;
  var body = {
    contents:[{ role:'user', parts:[{ text: prompt }] }],
    generationConfig:{ temperature:0.7, maxOutputTokens:4000 },
    safetySettings:[
      {category:'HARM_CATEGORY_HARASSMENT',threshold:'BLOCK_NONE'},
      {category:'HARM_CATEGORY_HATE_SPEECH',threshold:'BLOCK_NONE'},
      {category:'HARM_CATEGORY_SEXUALLY_EXPLICIT',threshold:'BLOCK_NONE'},
      {category:'HARM_CATEGORY_DANGEROUS_CONTENT',threshold:'BLOCK_NONE'}
    ]
  };
  try {
    var r = UrlFetchApp.fetch(url, {method:'post', contentType:'application/json', muteHttpExceptions:true, payload:JSON.stringify(body)});
    var code = r.getResponseCode(); var txt = r.getContentText();
    if (code < 200 || code >= 300) return {success:false, message:'Gemini HTTP '+code+': '+txt.substring(0,300)};
    var j = JSON.parse(txt);
    var out = (j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts && j.candidates[0].content.parts[0]) ? j.candidates[0].content.parts[0].text : '';
    if (!out) return {success:false, message:'Gemini tidak mengembalikan teks.'};
    return {success:true, text:out};
  } catch(e){ return {success:false, message:'Gagal AI: '+e.message}; }
}

// ===================== AI: TEXT TO SOAL (Bank Soal) =====================
// Menerima teks mentah dari frontend, meminta Gemini memilahnya menjadi JSON
// berisi {soal:[{pertanyaan, opsiA..E, kunci, pembahasan}]}, lalu frontend
// otomatis mengisi form soal / menyimpan ke Bank Soal.
function aiTextToSoal(teks, ctx){
  var key = getGeminiKey();
  if (!key) return {success:false, message:'Kunci Gemini belum diset. Jalankan setGeminiKey("...") di editor.'};
  teks = String(teks||'').trim();
  if (teks.length < 20) return {success:false, message:'Teks terlalu pendek. Tempel materi/soal yang cukup.'};
  ctx = ctx||{};
  var jumlah = Math.max(1, Math.min(30, parseInt(ctx.jumlah,10)||10));
  var mapel = ctx.mapel||'[Mapel]';
  var jenis = String(ctx.jenis||'PG').toLowerCase().indexOf('essay')>-1 ? 'Essay' : 'PG';

  var jenisInstr = (jenis==='Essay')
    ? 'soal berjenis ESSAY (uraian singkat). Setiap soal terdiri dari: pertanyaan, pedoman/kunci jawaban (ringkasan jawaban yang benar), dan pembahasan singkat.'
    : 'soal PILIHAN GANDA berkualitas. Setiap soal terdiri dari: pertanyaan, 5 opsi jawaban (A, B, C, D, E), kunci jawaban (huruf A-E saja), dan pembahasan singkat.';

  var schema = (jenis==='Essay')
    ? '{"mapel":"'+mapel+'","soal":[{"pertanyaan":"...","kunci":"<pedoman jawaban>","pembahasan":"..."}]}'
    : '{"mapel":"'+mapel+'","soal":[{"pertanyaan":"...","opsiA":"...","opsiB":"...","opsiC":"...","opsiD":"...","opsiE":"...","kunci":"A","pembahasan":"..."}]}';

  var prompt =
    'Kamu adalah pembuat soal ujian sekolah yang berpengalaman. '+
    'Di bawah ini adalah teks mentah (materi, rangkuman, atau kumpulan soal) dari guru.\n\n'+
    'TUGAS: Pilah teks tsb menjadi '+(jumlah)+' '+jenisInstr+'\n'+
    'Jangan buat soal dari luar isi teks. Jika teks hanya memuat sedikit konsep, jangan memaksakan jumlah; buat sebanyak yang bisa didukung teks. '+
    'Bahasa Indonesia.\n\n'+
    'TEKS MENTAH:\n'+teks+'\n\n'+
    'KELUARKAN HANYA SATU OBJEK JSON (tanpa markdown, tanpa teks lain) dalam format persis:\n'+
    schema;

  var url = 'https://generativelanguage.googleapis.com/v1beta/models/' + GEMINI_MODEL + ':generateContent?key=' + key;
  var body = {
    contents:[{ role:'user', parts:[{ text: prompt }] }],
    generationConfig:{ temperature:0.4, maxOutputTokens:8000 },
    safetySettings:[
      {category:'HARM_CATEGORY_HARASSMENT',threshold:'BLOCK_NONE'},
      {category:'HARM_CATEGORY_HATE_SPEECH',threshold:'BLOCK_NONE'},
      {category:'HARM_CATEGORY_SEXUALLY_EXPLICIT',threshold:'BLOCK_NONE'},
      {category:'HARM_CATEGORY_DANGEROUS_CONTENT',threshold:'BLOCK_NONE'}
    ]
  };
  try {
    var r = UrlFetchApp.fetch(url, {method:'post', contentType:'application/json', muteHttpExceptions:true, payload:JSON.stringify(body)});
    var code = r.getResponseCode(); var txt = r.getContentText();
    if (code < 200 || code >= 300) return {success:false, message:'Gemini HTTP '+code+': '+txt.substring(0,300)};
    var j = JSON.parse(txt);
    var out = (j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts && j.candidates[0].content.parts[0]) ? j.candidates[0].content.parts[0].text : '';
    if (!out) return {success:false, message:'Gemini tidak mengembalikan teks.'};
    var parsed = _extractJson(out);
    var list = parsed && parsed.soal;
    if (!list || !list.length) return {success:false, message:'AI tidak mengembalikan soal yang valid. Coba lagi.'};
    // Normalisasi & filter baris kosong
    var norm = [];
    for (var i=0;i<list.length;i++){
      var s = list[i];
      if (!s || !String(s.pertanyaan||'').trim()) continue;
      if (jenis === 'Essay') {
        norm.push({
          jenis: 'Essay',
          pertanyaan: String(s.pertanyaan).trim(),
          opsi: [],
          kunci: String(s.kunci||'').trim(),
          pembahasan: String(s.pembahasan||'').trim()
        });
        continue;
      }
      var opsi=[];
      ['A','B','C','D','E'].forEach(function(L){ var v=String(s['opsi'+L]||'').trim(); if(v) opsi.push(L+'. '+v); });
      if (opsi.length < 2) continue;
      norm.push({
        jenis: 'PG',
        pertanyaan: String(s.pertanyaan).trim(),
        opsi: opsi,
        kunci: String(s.kunci||'').trim().toUpperCase(),
        pembahasan: String(s.pembahasan||'').trim()
      });
    }
    if (!norm.length) return {success:false, message:'Tidak ada soal valid hasil AI.'};
    return {success:true, mapel: parsed.mapel || mapel, jenis: jenis, soal: norm};
  } catch(e){
    return {success:false, message:'Gagal AI: '+e.message};
  }
}

function _extractJson(txt){
  // Ambil blok JSON pertama di dalam { } — tahan terhadap backtick/markdown dari Gemini
  txt = String(txt).replace(/```json|```/g,'').trim();
  var a = txt.indexOf('{'), b = txt.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  var candidate = txt.substring(a, b+1);
  try { return JSON.parse(candidate); } catch(e){ return null; }
}

// ===================== AI: BUAT SOAL BANK (modal "Buat Soal dengan AI") =====================
// Frontend runBsAi() memanggil aiBuatSoalBank(ctx) dengan {mapel,kelas,topik,jumlah,jenis}.
// Digenerate dari topik/materi (bukan teks mentah), lalu preview → saveBsAiAll.
function aiBuatSoalBank(ctx){
  ctx = ctx||{};
  var key = getGeminiKey();
  if (!key) return {success:false, message:'Kunci Gemini belum diset. Jalankan setGeminiKey("...") di editor.'};
  var mapel = ctx.mapel||'[Mapel]';
  var topik = ctx.topik||ctx.materi||'[Topik]';
  var jumlah = Math.max(1, Math.min(30, parseInt(ctx.jumlah,10)||10));
  var jenis = ctx.jenis||'PG';
  var jenisInstr = jenis==='Essay'
    ? 'semua soal berjenis ESSAY (uraian singkat). Setiap soal: pertanyaan, pedoman jawaban (kunci), pembahasan.'
    : jenis==='Campuran'
      ? 'sebagian PG (pilihan ganda A–E + kunci) dan sebagian Essay (uraian + pedoman). Tandai jenis="PG" atau "Essay".'
      : 'semua soal PILIHAN GANDA A–E. Setiap soal: pertanyaan, 5 opsi (A–E), kunci (huruf A–E), pembahasan singkat.';

  var prompt =
    'Kamu adalah pembuat soal ujian sekolah yang berpengalaman untuk Mapel: '+mapel+' (Kelas: '+(ctx.kelas||'-')+').\n\n'+
    'TUGAS: Buat '+jumlah+' soal berkualitas bertema "'+topik+'". Jenis yang diminta: '+jenisInstr+'\n'+
    'Soal harus HOTS, sesuai kurikulum, bahasa Indonesia, dan tidak boleh mengada-ada fakta.\n\n'+
    'KELUARKAN HANYA SATU OBJEK JSON (tanpa markdown, tanpa teks lain) format persis:\n'+
    '{"soal":[{"jenis":"PG","pertanyaan":"...","opsi":["A. ...","B. ...","C. ...","D. ...","E. ..."],"kunci":"A","pembahasan":"...","bobot":1}]}\n'+
    'Untuk jenis "Essay", gunakan: {"jenis":"Essay","pertanyaan":"...","kunci":"<pedoman jawaban>","pembahasan":"...","bobot":5} (tanpa opsi).';

  var url = 'https://generativelanguage.googleapis.com/v1beta/models/' + GEMINI_MODEL + ':generateContent?key=' + key;
  var body = {
    contents:[{ role:'user', parts:[{ text: prompt }] }],
    generationConfig:{ temperature:0.6, maxOutputTokens:8000 },
    safetySettings:[
      {category:'HARM_CATEGORY_HARASSMENT',threshold:'BLOCK_NONE'},
      {category:'HARM_CATEGORY_HATE_SPEECH',threshold:'BLOCK_NONE'},
      {category:'HARM_CATEGORY_SEXUALLY_EXPLICIT',threshold:'BLOCK_NONE'},
      {category:'HARM_CATEGORY_DANGEROUS_CONTENT',threshold:'BLOCK_NONE'}
    ]
  };
  try {
    var r = UrlFetchApp.fetch(url, {method:'post', contentType:'application/json', muteHttpExceptions:true, payload:JSON.stringify(body)});
    var code = r.getResponseCode(); var txt = r.getContentText();
    if (code < 200 || code >= 300) return {success:false, message:'Gemini HTTP '+code+': '+txt.substring(0,300)};
    var j = JSON.parse(txt);
    var out = (j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts && j.candidates[0].content.parts[0]) ? j.candidates[0].content.parts[0].text : '';
    if (!out) return {success:false, message:'Gemini tidak mengembalikan teks.'};
    var parsed = _extractJson(out);
    var list = parsed && parsed.soal;
    if (!list || !list.length) return {success:false, message:'AI tidak mengembalikan soal yang valid. Coba lagi.'};
    var norm = [];
    for (var i=0;i<list.length;i++){
      var s = list[i];
      if (!s || !String(s.pertanyaan||'').trim()) continue;
      var tipe = String(s.jenis||ctx.jenis||'PG').toLowerCase();
      var jn = (tipe.indexOf('essay')>-1) ? 'Essay' : 'PG';
      if (jn === 'PG'){
        var opsi = [];
        if (Array.isArray(s.opsi) && s.opsi.length){
          opsi = s.opsi;
        } else {
          ['A','B','C','D','E'].forEach(function(L){ var v=String(s['opsi'+L]||'').trim(); if(v) opsi.push(L+'. '+v); });
        }
        if (opsi.length < 2) continue;
        norm.push({jenis:'PG', pertanyaan:String(s.pertanyaan).trim(), opsi:opsi, kunci:String(s.kunci||'').trim().toUpperCase(), pembahasan:String(s.pembahasan||'').trim(), bobot:Number(s.bobot)||1});
      } else {
        norm.push({jenis:'Essay', pertanyaan:String(s.pertanyaan).trim(), opsi:[], kunci:String(s.kunci||'').trim(), pembahasan:String(s.pembahasan||'').trim(), bobot:Number(s.bobot)||5});
      }
    }
    if (!norm.length) return {success:false, message:'Tidak ada soal valid hasil AI.'};
    return {success:true, mapel:mapel, kelas:ctx.kelas||'', soal:norm};
  } catch(e){
    return {success:false, message:'Gagal AI: '+e.message};
  }
}

// ===================== PDF GENERATOR (FIX: PDF KOSONG) =====================
// SEBAB BUG: _buildPDF TIDAK pernah memanggil buildFn(body), dan seluruh fungsi
// generate*PDF hanyalah stub kosong ("/* ... */") sehingga dokumen selalu kosong.
// Solusi: panggil buildFn, lalu isi seluruh fungsi generate*PDF dengan builder nyata.
function fmtDateID(d){ if(!d)return'-'; var p=String(d).split('-'); if(p.length!==3)return d; var m=['Jan','Feb','Mar','Apr','Mei','Jun','Jul','Agu','Sep','Okt','Nov','Des']; return parseInt(p[2])+' '+m[parseInt(p[1])-1]+' '+p[0]; }
function getNamaHari(d){ return ['Minggu','Senin','Selasa','Rabu','Kamis','Jumat','Sabtu'][new Date(d).getDay()]; }
function fmtN(v){ return (v===''||v==null)?'-':String(v); }
// ✅ FIX ANTI-LAG: cache nama wali kelas agar pembuatan PDF TIDAK melakukan 1 request
// API per dokumen (N+1). Ambil semua nama sekali (batch), simpan 6 jam di CacheService.
function _waliKelasCache(){
  try {
    var cache = CacheService.getScriptCache();
    var c = cache.get('wali_kelas_all');
    if (c) { try { return JSON.parse(c) || {}; } catch(e){} }
    var all = _d(_req('GET','wali-kelas-all'), null);
    var map = {};
    if (all && Array.isArray(all)) {
      for (var i=0;i<all.length;i++) if (all[i] && all[i].kelas) map[String(all[i].kelas)] = all[i].nama || '-';
    }
    try { cache.put('wali_kelas_all', JSON.stringify(map), 21600); } catch(e){}
    return map;
  } catch(e){ return {}; }
}
function getWaliKelasNama(kelas){
  try {
    var map = _waliKelasCache();
    if (map[String(kelas)]) return map[String(kelas)];
  } catch(e){}
  // Fallback: panggil per-kelas bila endpoint batch tidak tersedia
  var r=_d(_req('GET','wali-kelas',{kelas:kelas}),{});
  return (r && r.nama)?r.nama:'-';
}

function _buildPDF(name, buildFn){
  try {
    if (typeof buildFn !== 'function') return {success:false, message:'buildFn tidak valid'};
    var doc = DocumentApp.create(name);
    var body = doc.getBody();
    body.setMarginTop(40).setMarginBottom(40).setMarginLeft(30).setMarginRight(30);
    buildFn(body);                                   // ✅ WAJIB: isi konten dokumen
    if (body.getParagraphs().length === 0) body.appendParagraph(' ');
    doc.saveAndClose();                              // ✅ Pastikan tersimpan sebelum export
    var pb = doc.getAs('application/pdf');
    var filename = name.replace(/\s+/g,'_')+'.pdf';
    pb.setName(filename);
    try { DriveApp.getFileById(doc.getId()).setTrashed(true); } catch(e){}
    return {success:true, base64:Utilities.base64Encode(pb.getBytes()), filename:filename, mimeType:'application/pdf'};
  } catch(e){ return {success:false, message:e.message}; }
}

function _fmtCell(row, col, text, opts){
  var cell = row.getCell(col);
  cell.setText(String(text==null?'':text));
  // ✅ editAsText() hanya boleh dipanggil pada objek TableCell (bukan hasil getText()).
  // Di sini `cell` adalah TableCell, sehingga aman.
  var t = cell.editAsText();
  t.setFontFamily('Arial').setFontSize((opts&&opts.size)||8);
  if (opts && opts.bold) t.setBold(true);
  if (opts && opts.color) t.setForegroundColor(opts.color);
  return cell;
}

function _pdfHeader(body, title, subtitle, kelas){
  // ✅ Gaya ramah orang tua: hitam pekat di atas kertas putih polos, tanpa warna menyala.
  var p = body.appendParagraph(title);
  p.setHeading(DocumentApp.ParagraphHeading.HEADING1);
  p.setAlignment(DocumentApp.HorizontalAlignment.CENTER);
  p.setFontSize(15).setBold(true).setFontFamily('Arial').setForegroundColor('#111111');
  p.setSpacingAfter(2);
  if (kelas) body.appendParagraph('Kelas: '+kelas).setAlignment(DocumentApp.HorizontalAlignment.CENTER).setFontSize(10).setFontFamily('Arial').setForegroundColor('#222222');
  if (subtitle) body.appendParagraph(subtitle).setAlignment(DocumentApp.HorizontalAlignment.CENTER).setFontSize(10).setFontFamily('Arial').setItalic(true).setForegroundColor('#333333');
  body.appendParagraph(' ');
}

// ✅ Header lembaga: nama sekolah + TA + penanda "dokumen resmi" — membantu orang tua
// langsung tahu ini dokumen apa, dari sekolah mana, untuk periode apa.
function _pdfKop(body, extra){
  try {
    if (!extra) { var ti = getTAInfo(); extra = {ta: (ti&&ti.ta), sem: (ti&&ti.semester)}; }
  } catch(e){}
  var kop = body.appendParagraph('SEKOLAH MENENGAH — KELAAS');
  kop.setAlignment(DocumentApp.HorizontalAlignment.CENTER);
  kop.setFontSize(10).setBold(true).setFontFamily('Arial').setForegroundColor('#111111');
  var sub = 'Laporan Akademik Siswa • Tahun Ajaran '+(extra&&extra.ta?extra.ta:'2025/2026')+' • Semester '+(extra&&extra.sem?extra.sem:'1');
  var sp = body.appendParagraph(sub);
  sp.setAlignment(DocumentApp.HorizontalAlignment.CENTER);
  sp.setFontSize(8).setFontFamily('Arial').setForegroundColor('#555555');
  body.appendParagraph(' ');
}

function _pdfTable(body, headers, rows, widths, opts){
  var t = body.appendTable();
  t.setBorderColor('#bbbbbb');   // border abu tipis (hitam-putih bersih)
  var fsz = (opts&&opts.size)||8;   // ukuran font sel (default 8; ringkas default)
  var padY = (opts&&opts.padY)!=null ? opts.padY : 3;  // padding vertikal baris
  var headRow = t.appendTableRow();
  for (var h=0; h<headers.length; h++){
    var hc = headRow.appendTableCell(headers[h]);
    hc.setBackgroundColor('#eeeeee');   // header abu muda, bukan biru menyala
    // ✅ FIX: TableCell.getText() mengembalikan STRING (tanpa method).
    // editAsText() harus dipanggil LANGSUNG pada TableCell.
    hc.editAsText().setBold(true).setFontFamily('Arial').setFontSize(fsz).setForegroundColor('#111111');
  }
  for (var r=0; r<rows.length; r++){
    var tr = t.appendTableRow();
    if (typeof tr.setPaddingTop === 'function') tr.setPaddingTop(padY);
    if (typeof tr.setPaddingBottom === 'function') tr.setPaddingBottom(padY);
    for (var c=0; c<headers.length; c++){
      var cell = tr.appendTableCell(fmtN(rows[r][c]));
      cell.editAsText().setFontFamily('Arial').setFontSize(fsz).setForegroundColor('#111111');
      if (r%2===1) cell.setBackgroundColor('#fafafa');
    }
  }
  if (widths){
    var wd = [];
    for (var w=0; w<widths.length; w++) wd.push(widths[w]);
    while (wd.length < headers.length) wd.push(60);
    _setColWidths(t, wd);   // ✅ FIX: aman terhadap error "setColumnWidths is not a function"
  }
  return t;
}

// ✅ FIX ERROR "t.setColumnWidths is not a function":
// set lebar kolom secara DEFENSIF. Coba API array (Table.setColumnWidths),
// fallback per-kolom (Table.setColumnWidth), lalu fallback terakhir diam saja.
// Semua dibungkus try/catch agar pembuatan PDF TIDAK pernah gagal di langkah ini,
// terlepas dari versi Apps Script yang sedang ter-deploy.
function _setColWidths(t, wd){
  try {
    if (typeof t.setColumnWidths === 'function') { t.setColumnWidths(wd); return; }
  } catch(e1){ /* lanjut ke fallback */ }
  try {
    if (typeof t.setColumnWidth === 'function') {
      for (var w=0; w<wd.length; w++){ t.setColumnWidth(w, wd[w]); }
    }
  } catch(e2){ /* biarkan lebar default bila semua gagal */ }
}

function _pdfFooterNote(body, note){
  body.appendParagraph(note||'Dibuat otomatis oleh sistem KELAAS — '+fmtDateID(getTodayStr()))
      .setFontSize(8).setItalic(true).setForegroundColor('#555555');
}

// ✅ Batasi lebar kolom agar total tidak melebihi lebar kertas (≈500pt A4 margin 30).
// Kolom berlebih dipadatkan (min. 20pt); total distempel ke 500 supaya tidak terpotong saat dicetak.
function _pdfWidths(headers, desired){
  var wd = [];
  for (var w=0; w<headers.length; w++) wd.push((desired&&desired[w])||70);
  // Kolom pertama ("No") jangan terlalu sempit
  if (wd[0]!=null && wd[0]<25) wd[0]=25;
  var total = 0;
  for (var x=0; x<wd.length; x++) total += wd[x];
  if (total > 500){
    var excess = total - 500;
    // kurangi kolom dari belakang (nilai/bobot), sisakan 20pt minimum
    for (var y=wd.length-1; y>=0 && excess>0; y--){
      var cut = Math.min(excess, wd[y]-20);
      if (cut>0){ wd[y]-=cut; excess-=cut; }
    }
    if (excess>0){ // masih kelebihan → skala proporsional
      var scale = 500/total;
      for (var z=0; z<wd.length; z++) wd[z]=Math.max(20, Math.round(wd[z]*scale));
    }
  }
  return wd;
}

// ---------- 1) REKAP NILAI (menu Penilaian Siswa → Export PDF) ----------
function generateRekapNilaiPDF(nip, kelas, mapel){
  var rekap = getRekapNilai(nip, kelas, mapel||'');
  var students = (rekap && rekap.students) || [];
  return _buildPDF('Rekap_Nilai_'+kelas, function(body){
    _pdfKop(body);
    _pdfHeader(body, 'REKAP NILAI SISWA', 'Mata Pelajaran: '+(rekap.mapel||mapel||'-'), kelas);
    if (!students.length){ body.appendParagraph('Belum ada data nilai.').setForegroundColor('#333333'); return; }
    var headers = ['No','NIS','Nama'];
    var jenis = ['NH1','NH2','NH3','NH4','NH5','NH6','NH7','NH8','PSTS','PSAS'];
    for (var j=0; j<jenis.length; j++) headers.push(jenis[j]);
    headers.push('Akhir');
    var rows = [];
    for (var i=0; i<students.length; i++){
      var s = students[i], row = [i+1, s.nis, s.nama];
      for (var k=0; k<jenis.length; k++) row.push(s[jenis[k]]==null?'-':s[jenis[k]]);
      row.push(s.akhir==null?'-':s.akhir);
      rows.push(row);
    }
    _pdfTable(body, headers, rows, _pdfWidths(headers, [30,60,120,36,36,36,36,36,36,36,36,36,36,44]));
    _pdfFooterNote(body, 'Keterangan: NH = Nilai Harian, PSTS = Penilaian Sumatif Tengah Semester, PSAS = Penilaian Sumatif Akhir Semester.');
    _pdfFooterNote(body, 'Wali Kelas: '+getWaliKelasNama(kelas));
  });
}

// ---------- 2) REKAP KEHADIRAN WALI KELAS (menu Kehadiran → Rekap PDF) ----------
function generateRekapanKelasPDF(kelas, start, end, label){
  var data = _d(_req('GET','rekap-data',{kelas:kelas, start:start, end:end}), {students:[],dates:[]});
  var students = data.students||[], dates = data.dates||[];
  return _buildPDF('Rekap_Kehadiran_'+kelas, function(body){
    _pdfKop(body);
    _pdfHeader(body, 'REKAP KEHADIRAN KELAS', (label||'Periode: '+start+' s/d '+end), kelas);
    if (!students.length){ body.appendParagraph('Tidak ada data pada periode ini.').setForegroundColor('#333333'); return; }
    var headers = ['No','NIS','Nama'];
    for (var d=0; d<dates.length; d++) headers.push(fmtDateID(dates[d]).substring(0,5));
    headers.push('H','S','I','A','Total');
    var rows = [];
    for (var i=0; i<students.length; i++){
      var s = students[i], rec = s.records||{}, sum = s.summary||{};
      var row = [i+1, s.nis, s.nama];
      for (var x=0; x<dates.length; x++) row.push(rec[dates[x]]||'-');
      row.push(sum.Hadir||0, sum.Sakit||0, sum.Izin||0, sum.Alfa||0, s.total||0);
      rows.push(row);
    }
    _pdfTable(body, headers, rows, _pdfWidths(headers, [30,52,105].concat(Array(dates.length).fill(24), [22,22,22,22,30])));
    _pdfFooterNote(body, 'Keterangan: H = Hadir, S = Sakit, I = Izin, A = Alfa (tanpa keterangan).');
    _pdfFooterNote(body, 'Wali Kelas: '+getWaliKelasNama(kelas));
  });
}

// ---------- 3) REKAP KEHADIRAN PER SISWA ----------
function generateRekapanPDF(kelas, nis, start, end, label, ud){
  var data = _d(_req('GET','rekap-data',{kelas:kelas, nis:nis, start:start, end:end}), {students:[],dates:[]});
  var s = (data.students||[])[0] || {nis:nis, nama:nis, records:{}, summary:{}, total:0};
  var dates = data.dates||[];
  return _buildPDF('Rekapan_'+nis, function(body){
    _pdfKop(body);
    _pdfHeader(body, 'REKAP KEHADIRAN SISWA', (label||'Periode: '+start+' s/d '+end), kelas);
    body.appendParagraph('Nama: '+s.nama).setFontSize(10).setFontFamily('Arial').setForegroundColor('#111111');
    body.appendParagraph('NIS: '+s.nis).setFontSize(10).setFontFamily('Arial').setForegroundColor('#111111');
    body.appendParagraph(' ');
    var rows = [ ['Hadir', s.summary.Hadir||0], ['Sakit', s.summary.Sakit||0], ['Izin', s.summary.Izin||0], ['Alfa', s.summary.Alfa||0], ['Total', s.total||0] ];
    _pdfTable(body, ['Keterangan','Jumlah'], rows, [180,90], {size:12, padY:6});
    _pdfFooterNote(body, 'Keterangan: H = Hadir, S = Sakit, I = Izin, A = Alfa.');
    _pdfFooterNote(body, 'Wali Kelas: '+getWaliKelasNama(kelas));
  });
}

// ---------- 4) REKAP PRESENSI MAPEL PER GURU ----------
function getPresensiMapelRekap(nip,kelas,mapel,start,end){ return _d(_req('GET','presensi-mapel-rekap',{nip:nip,kelas:kelas,mapel:mapel,start:start,end:end}),{students:[],dates:[]}); }
function generateRekapMapelPDF(nip,kelas,mapel,start,end,label){
  var data = getPresensiMapelRekap(nip,kelas,mapel,start,end);
  var students = data.students||[], dates = data.dates||[];
  return _buildPDF('Rekap_Presensi_'+kelas+'_'+mapel, function(body){
    _pdfKop(body);
    _pdfHeader(body, 'REKAP PRESENSI MAPEL', (label||'Periode: '+start+' s/d '+end), kelas);
    body.appendParagraph('Mapel: '+mapel).setFontSize(10).setFontFamily('Arial').setForegroundColor('#111111');
    body.appendParagraph(' ');
    var headers = ['No','NIS','Nama'];
    for (var d=0; d<dates.length; d++) headers.push(fmtDateID(dates[d]).substring(0,5));
    headers.push('H','S','I','A','D','Total');
    var rows = [];
    for (var i=0; i<students.length; i++){
      var st = students[i], sm = st.summary||{}, rec = st.records||{};
      var row = [i+1, st.nis, st.nama];
      for (var x=0; x<dates.length; x++) row.push(rec[dates[x]]||'-');
      row.push(sm.Hadir||0, sm.Sakit||0, sm.Izin||0, sm.Alfa||0, sm.Dispensasi||0, st.total||0);
      rows.push(row);
    }
    _pdfTable(body, headers, rows, _pdfWidths(headers, [30,52,100].concat(Array(dates.length).fill(24), [22,22,22,22,22,30])));
    _pdfFooterNote(body, 'Keterangan: H = Hadir, S = Sakit, I = Izin, A = Alfa, D = Dispensasi.');
    _pdfFooterNote(body, 'Guru Mapel: '+(ud&&ud.guruNama?ud.guruNama:'-'));
  });
}

// ---------- 5) LAPORAN ADMINISTRASI GURU ----------
function generateLaporanAdminPDF(nip,kelas,mapel,start,end){
  var d = getLaporanAdminData(nip,kelas,mapel,start,end);
  var students = d.students||[], jurnal = d.jurnal||[];
  return _buildPDF('Laporan_Administrasi_'+kelas+'_'+mapel, function(body){
    _pdfKop(body);
    _pdfHeader(body, 'LAPORAN ADMINISTRASI PEMBELAJARAN', 'Periode: '+start+' s/d '+end, kelas);
    body.appendParagraph('Mapel: '+mapel).setFontSize(10).setFontFamily('Arial').setForegroundColor('#111111');
    body.appendParagraph(' ');
    body.appendParagraph('A. REKAP PRESENSI SISWA').setBold(true).setFontSize(11).setFontFamily('Arial').setForegroundColor('#111111');
    var headers = ['No','NIS','Nama','Hadir','Sakit','Izin','Alfa','Disp.','Total'];
    var rows = [];
    for (var i=0; i<students.length; i++){
      var st = students[i], sm = st.summary||{};
      rows.push([i+1, st.nis, st.nama, sm.Hadir||0, sm.Sakit||0, sm.Izin||0, sm.Alfa||0, sm.Dispensasi||0, st.total||0]);
    }
    _pdfTable(body, headers, rows, _pdfWidths(headers, [30,55,110,42,42,42,42,42,50]));
    body.appendParagraph(' ');
    body.appendParagraph('B. JURNAL MENGAJAR').setBold(true).setFontSize(11).setFontFamily('Arial').setForegroundColor('#111111');
    if (jurnal.length){
      var jrows = jurnal.map(function(j,i){ return [i+1, fmtDateID(j.tanggal), 'Jam '+(j.jamKe||'-'), j.materi, j.kegiatan]; });
      _pdfTable(body, ['No','Tanggal','Jam','Materi','Kegiatan'], jrows, _pdfWidths(['No','Tanggal','Jam','Materi','Kegiatan'], [30,70,40,160,200]));
    } else body.appendParagraph('Belum ada jurnal pada periode ini.').setForegroundColor('#333333');
    _pdfFooterNote(body, 'Jumlah baris direvisi: '+(d.revisiCount||0));
  });
}

// ---------- 6) REKAP LENGKAP (Nilai + Kehadiran + Jurnal) ----------
function generateRekapLengkapPDF(nip,kelas,mapel,start,end){
  var rekap = getRekapNilai(nip, kelas, mapel);
  var students = (rekap && rekap.students) || [];
  var pres = getPresensiMapelRekap(nip,kelas,mapel,start,end);
  var pStudents = pres.students||[], pDates = pres.dates||[];
  var admin = getLaporanAdminData(nip,kelas,mapel,start,end);
  var jurnal = admin.jurnal||[];
  return _buildPDF('Rekap_Nilai_Kehadiran_'+kelas, function(body){
    _pdfKop(body);
    _pdfHeader(body, 'REKAP LENGKAP PEMBELAJARAN', 'Mapel: '+mapel+' • Periode: '+start+' s/d '+end, kelas);
    body.appendParagraph('A. NILAI SISWA').setBold(true).setFontSize(11).setFontFamily('Arial').setForegroundColor('#111111');
    if (students.length){
      var h1 = ['No','NIS','Nama']; for (var j=0;j<8;j++) h1.push('NH'+(j+1));
      h1.push('PSTS','PSAS','Akhir');
      var r1 = [];
      for (var i=0;i<students.length;i++){
        var s = students[i], row=[i+1,s.nis,s.nama];
        for (var k=0;k<8;k++) row.push(s['NH'+(k+1)]==null?'-':s['NH'+(k+1)]);
        row.push(s.PSTS==null?'-':s.PSTS, s.PSAS==null?'-':s.PSAS, s.akhir==null?'-':s.akhir);
        r1.push(row);
      }
      _pdfTable(body, h1, r1, _pdfWidths(h1, [30,55,110,34,34,34,34,34,34,34,34,34,34,42]));
    } else body.appendParagraph('Belum ada data nilai.').setForegroundColor('#333333');
    body.appendParagraph(' ');
    body.appendParagraph('B. REKAP PRESENSI MAPEL').setBold(true).setFontSize(11).setFontFamily('Arial').setForegroundColor('#111111');
    if (pStudents.length){
      var h2=['No','NIS','Nama']; for (var x=0;x<pDates.length;x++) h2.push(fmtDateID(pDates[x]).substring(0,5));
      h2.push('H','S','I','A','D','Total');
      var r2=[];
      for (var m=0;m<pStudents.length;m++){
        var ps=pStudents[m], sm=ps.summary||{}, rec=ps.records||{};
        var row2=[m+1,ps.nis,ps.nama];
        for (var y=0;y<pDates.length;y++) row2.push(rec[pDates[y]]||'-');
        row2.push(sm.Hadir||0,sm.Sakit||0,sm.Izin||0,sm.Alfa||0,sm.Dispensasi||0,ps.total||0);
        r2.push(row2);
      }
      _pdfTable(body, h2, r2, _pdfWidths(h2, [30,52,100].concat(Array(pDates.length).fill(24), [22,22,22,22,22,30])));
    } else body.appendParagraph('Belum ada data presensi.').setForegroundColor('#333333');
    body.appendParagraph(' ');
    body.appendParagraph('C. JURNAL MENGAJAR').setBold(true).setFontSize(11).setFontFamily('Arial').setForegroundColor('#111111');
    if (jurnal.length){
      var r3 = jurnal.map(function(j,i){ return [i+1, fmtDateID(j.tanggal), 'Jam '+(j.jamKe||'-'), j.materi, j.kegiatan]; });
      _pdfTable(body, ['No','Tanggal','Jam','Materi','Kegiatan'], r3, _pdfWidths(['No','Tanggal','Jam','Materi','Kegiatan'], [30,70,40,160,200]));
    } else body.appendParagraph('Belum ada jurnal pada periode ini.').setForegroundColor('#333333');
    _pdfFooterNote(body, 'Keterangan: NH = Nilai Harian, PSTS = Penilaian Sumatif Tengah Semester, PSAS = Penilaian Sumatif Akhir Semester.');
    _pdfFooterNote(body, 'Wali Kelas / Guru: '+getWaliKelasNama(kelas));
  });
}

// ---------- 7) MODUL AJAR (hasil AI → PDF) ----------
function generateModulPDF(text, judul){ return _buildPDF(judul||'Modul_Ajar', function(body){ _pdfKop(body); _mdToDoc(body, text||''); }); }

function _mdToDoc(body, md){
  if (!md) return;
  var lines = String(md).replace(/\r\n/g, '\n').split('\n');
  var inTbl = false, tblBuffer = [];
  function flushTable(){
    if (!tblBuffer.length) return;
    var t = body.appendTable(); t.setBorderColor('#bbbbbb');
    for (var i=0;i<tblBuffer.length;i++){
      var cells = tblBuffer[i].split('|').slice(1,-1);
      cells = cells.map(function(c){ return c.replace(/^\s+|\s+$/g,''); });
      if (i===1 && /^[-:\s|]+$/.test(tblBuffer[i].join ? tblBuffer[i].join('') : tblBuffer[i])) continue; // baris pemisah
      var row = t.appendTableRow();
      for (var j=0;j<cells.length;j++){
        var cell = row.appendTableCell(_inline(cells[j]));
        cell.editAsText().setFontFamily('Arial').setFontSize(8).setForegroundColor('#111111');
        if (i===0) cell.editAsText().setBold(true).setBackgroundColor('#eeeeee').setForegroundColor('#111111');
      }
    }
    tblBuffer = [];
  }
  function _inline(s){
    s = String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    return s;
  }
  function appendRich(text){
    // Terapkan bold (**...**) dan italic (*...*) sederhana
    var segs = String(text).split(/(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g);
    var p = body.appendParagraph('');
    for (var i=0;i<segs.length;i++){
      var seg = segs[i];
      if (!seg) continue;
      var run = p.appendText(seg);
      if (/^\*\*.*\*\*$/.test(seg)) run.setBold(true);
      else if (/^\*.*\*$/.test(seg)) run.setItalic(true);
      else if (/^`.*`$/.test(seg)) run.setFontFamily('Consolas');
      run.setForegroundColor('#111111');
    }
    p.setFontSize(10).setFontFamily('Arial').setForegroundColor('#111111');
    return p;
  }
  for (var i=0;i<lines.length;i++){
    var ln = lines[i];
    if (/^\s*\|.*\|\s*$/.test(ln)){ inTbl=true; tblBuffer.push(ln); continue; }
    else if (inTbl){ flushTable(); inTbl=false; }
    if (/^#{1,3}\s/.test(ln)){
      var level = ln.match(/^#+/)[0].length;
      var heading = ln.replace(/^#+\s*/, '');
      var h = body.appendParagraph(heading);
      if (level===1) h.setHeading(DocumentApp.ParagraphHeading.HEADING1);
      else if (level===2) h.setHeading(DocumentApp.ParagraphHeading.HEADING2);
      else h.setHeading(DocumentApp.ParagraphHeading.HEADING3);
      h.setFontFamily('Arial').setForegroundColor('#111111');
    }
    else if (/^[-*]\s+/.test(ln) || /^\d+\.\s+/.test(ln)){
      var item = ln.replace(/^[-*]\s+/, '').replace(/^\d+\.\s+/, '');
      appendRich(item);
    }
    else if (/^---+$/.test(ln)){ /* garis pemisah, lewati */ }
    else if (ln.trim()===''){ /* spasi kosong di-skip agar tidak menumpuk */ }
    else appendRich(ln);
  }
  if (inTbl) flushTable();
}

// ===================== SETUP =====================
function runSetup(){ return _m(_req('POST','setup')); }
function testKoneksi(){ var r=_req('GET','test'); return (r&&r.success)?('OK: '+JSON.stringify(r.data)):('GAGAL: '+(r&&r.message)); }

// ===================== GURU V2 FIX =====================
function submitPresensiMapelV2(nip,kelas,mapel,tgl,jam,recs){ return _m(_req('POST','presensi-mapel',null,{nip:nip,kelas:kelas,mapel:mapel,tanggal:tgl,jamKe:jam,records:recs})); }
function getPresensiRiwayat(nip,tanggal,kelas){ return _d(_req('GET','presensi-riwayat',{nip:nip,tanggal:tanggal||'',kelas:kelas||''}),[]); }
function updatePresensiBulk(updates){ return _m(_req('PUT','presensi-mapel',null,{updates:updates})); }
function getLaporanAdminData(nip,kelas,mapel,start,end){ return _d(_req('GET','laporan-admin',{nip:nip,kelas:kelas,mapel:mapel,start:start,end:end}),{}); }
function runSetupGuruV2(){ return _m(_req('POST','setup-guru-v2')); }

// ===================== CBT SYSTEM (100% SINKRON DENGAN INDEX.PHP) =====================

function runSetupCbt(){ return _m(_req('POST','setup-cbt')); }
function runSetupBankSoal(){ return _m(_req('POST','setup-banksoal')); }

function getBankSoalCbt(nip, mapel, jenis, kelas){
  var p = {nip: nip || ''};
  if (mapel) p.mapel = mapel;
  if (jenis) p.jenis = jenis;
  if (kelas) p.kelas = kelas;
  return _d(_req('GET','bank-soal', p), []);
}

function addBankSoalCbt(o){ return _m(_req('POST','bank-soal', null, o)); }
function deleteBankSoalCbt(row){ return _m(_req('DELETE','bank-soal', {id:row})); }
function deleteBankSoalBulk(ids){
  if (!ids || !ids.length) return {success:false, message:'Tidak ada soal dipilih.'};
  // ✅ Kirim ids via QUERY PARAM (URL), bukan payload body — _req TIDAK mengirim
  // body untuk metode DELETE (opt.payload hanya untuk POST/PUT). Cara ini sama
  // dengan deleteBankSoalCbt yang sudah terbukti bekerja di hosting.
  var r = _req('DELETE', 'bank-soal', {ids: ids.join(',')});
  return {success: !!(r && r.success), message: (r&&r.message)||'Gagal menghapus'};
}

// ✅ FIX BUG 1: Simpan banyak soal sekaligus (PHP bank-soal sudah mendukung format {soal:[...]}).
// Dipakai oleh "Text to Soal" (t2sSaveAll), "Buat Soal dengan AI" (saveBsAiAll), dan Import Excel.
// Sebelumnya fungsi ini TIDAK ADA di Kode.gs sehingga ketiganya gagal (function not found),
// dan t2sSaveAll mengirim payload tanpa nip → PHP menolak dengan "nip wajib".
function addBankSoalBulk(nip, arr){
  var r = _req('POST', 'bank-soal', null, {nip: nip || '', soal: arr || []});
  if (!r) return {success:false, message:'Gagal koneksi API'};
  if (r.success) return r.data || {inserted:(arr||[]).length};
  return {success:false, message:r.message || 'Gagal menyimpan soal'};
}

// ✅ Kompatibilitas: frontend lama memakai addBankSoal / getBankSoal / deleteBankSoal.
function addBankSoal(o){ return addBankSoalBulk(o&&o.nip, [o]); }
function getBankSoal(nip, mapel){ return getBankSoalCbt(nip, mapel||'', '', ''); }
function deleteBankSoal(row){ return deleteBankSoalCbt(row); }

// ===== CBT: GURU =====
function getCbtExams(nip){
  return _d(_req('GET','cbt-exam', {nip:nip}), []);
}

function createCbtExam(o){
  var result = _req('POST', 'cbt-exam', null, o);
  if (result && result.success && result.data) {
    return result.data; // {id, token}
  }
  return { error: (result && result.message) || 'Gagal membuat ulangan' };
}

function setCbtStatus(id, status){
  return _m(_req('PUT', 'cbt-exam', null, {id:id, status:status}));
}

function deleteCbtExam(row){
  return _m(_req('DELETE', 'cbt-exam', {id:row}));
}

function getCbtHasil(examId){
  var rows = _d(_req('GET', 'cbt-hasil', {examId:examId}), []);
  // Tambahkan field nilaiEssay jika ada
  return rows.map(function(r){
    return {
      nis: r.nis,
      nama: r.nama,
      nilaiPg: r.nilaiPg != null ? r.nilaiPg : r.total,
      nilaiEssay: r.nilaiEssay != null ? r.nilaiEssay : null,
      total: r.total,
      status: r.status,
      selesai: r.selesai
    };
  });
}

function getCbtEssay(examId, soalId){
  return _d(_req('GET', 'cbt-essay', {examId:examId, soalId:soalId||''}), []);
}

function nilaiEssayCbt(jawabanId, nilai){
  return _m(_req('PUT', 'cbt-essay', null, {id:jawabanId, nilai:nilai}));
}

// ===== AI AUTO-GRADING ESSAY (Gemini) =====
// Membaca soal + pedoman (kunci) + jawaban siswa, lalu Gemini memberi skor 0..bobot
// beserta umpan balik singkat. Hasil disimpan via endpoint cbt-essay (benar + feedback),
// kemudian sesi di-finalisasi ulang sehingga skor gabungan PG+essay langsung muncul.
function _aiGradePrompt(jawaban, pertanyaan, kunci, bobot){
  var b = Math.max(1, parseInt(bobot,10) || 5);
  return 'Kamu adalah guru penilai ulangan (CBT) yang teliti dan adil. '+
    'Nilailah jawaban ESSAY siswa berdasarkan PEDOMAN/RUBRIK yang diberikan. '+
    'Berikan skor dalam rentang 0 sampai '+b+' ('+b+' = sempurna) dan umpan balik singkat (1-2 kalimat, bahasa Indonesia).\n\n'+
    'PERTANYAAN:\n'+(pertanyaan||'(tidak ada)')+'\n\n'+
    'PEDOMAN / KUNCI JAWABAN:\n'+(kunci||'(tidak ada pedoman — gunakan penilaian profesional)')+'\n\n'+
    'JAWABAN SISWA:\n'+(jawaban||'(kosong)')+'\n\n'+
    'JAWABAN KOSONG → skor 0.\n'+
    'KELUARKAN HANYA SATU OBJEK JSON (tanpa markdown, tanpa teks lain) persis format:\n'+
    '{"skor": <angka 0..'+b+">, \"feedback\": \"<umpan balik singkat>\"}";
}
function _aiCallGrade(jawaban, pertanyaan, kunci, bobot){
  var key = getGeminiKey();
  if (!key) return {success:false, message:'Kunci Gemini belum diset.'};
  var prompt = _aiGradePrompt(jawaban, pertanyaan, kunci, bobot);
  var url = 'https://generativelanguage.googleapis.com/v1beta/models/' + GEMINI_MODEL + ':generateContent?key=' + key;
  var body = {
    contents:[{ role:'user', parts:[{ text: prompt }] }],
    generationConfig:{ temperature:0.2, maxOutputTokens:600 },
    safetySettings:[
      {category:'HARM_CATEGORY_HARASSMENT',threshold:'BLOCK_NONE'},
      {category:'HARM_CATEGORY_HATE_SPEECH',threshold:'BLOCK_NONE'},
      {category:'HARM_CATEGORY_SEXUALLY_EXPLICIT',threshold:'BLOCK_NONE'},
      {category:'HARM_CATEGORY_DANGEROUS_CONTENT',threshold:'BLOCK_NONE'}
    ]
  };
  try {
    var r = UrlFetchApp.fetch(url, {method:'post', contentType:'application/json', muteHttpExceptions:true, payload:JSON.stringify(body)});
    var code = r.getResponseCode(); var txt = r.getContentText();
    if (code < 200 || code >= 300) return {success:false, message:'Gemini HTTP '+code+': '+txt.substring(0,200)};
    var j = JSON.parse(txt);
    var out = (j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts && j.candidates[0].content.parts[0]) ? j.candidates[0].content.parts[0].text : '';
    if (!out) return {success:false, message:'Gemini tidak mengembalikan teks.'};
    var parsed = _extractJson(out);
    if (!parsed || parsed.skor === undefined) return {success:false, message:'AI tidak mengembalikan skor valid.'};
    var skor = parseFloat(parsed.skor);
    if (isNaN(skor)) skor = 0;
    skor = Math.max(0, Math.min(Number(bobot), skor));      // batasi 0..bobot
    return {success:true, skor:skor, feedback:String(parsed.feedback||'').trim()};
  } catch(e){ return {success:false, message:'Gagal AI: '+e.message}; }
}
// Menilai SATU jawaban essay (dipakai tombol "Koreksi dengan AI" per siswa).
// Jawabannya diambil ulang dari server agar selalu yang terbaru.
function aiNilaiEssay(jawabanId, sesiId, soalId){
  var jw = _d(_req('GET', 'cbt-essay-detail', {id:jawabanId, sesiId:sesiId, soalId:soalId}), null);
  if (!jw) return {success:false, message:'Jawaban tidak ditemukan.'};
  if (!jw.jawaban || !String(jw.jawaban).trim()) {
    nilaiEssayCbt(jawabanId, 0);
    return {success:true, skor:0, feedback:'Tidak dijawab — skor 0.', kosong:true};
  }
  var ai = _aiCallGrade(jw.jawaban, jw.pertanyaan, jw.kunci, jw.bobot);
  if (!ai.success) return ai;
  nilaiEssayCbt(jawabanId, ai.skor);
  return {success:true, skor:ai.skor, feedback:ai.feedback};
}
// Menilai SEMUA essay yang belum dinilai pada satu ujian (dipakai "Koreksi Semua dengan AI"
// dan auto-grading setelah siswa mengumpulkan). Mengembalikan rata-rata skor AI untuk ditampilkan.
function autoNilaiEssayCbt(examId){
  var rows = getCbtEssay(examId, '');
  if (!rows || !rows.length) return {success:false, message:'Belum ada jawaban essay.'};
  var pending = rows.filter(function(r){ return r.status !== 'dinilai'; });
  var hasil = []; var totalSkor = 0; var totalBobot = 0;
  for (var i=0;i<pending.length;i++){
    var p = pending[i];
    var r = aiNilaiEssay(p.id, p.sesiId, p.soalId);
    hasil.push({id:p.id, nama:p.nama, ok:!!(r && r.success), skor:(r&&r.skor)!=null?r.skor:null, feedback:(r&&r.feedback)||(r&&r.message)||''});
    if (r && r.success && r.skor != null) { totalSkor += Number(r.skor); totalBobot += Number(p.bobot)||1; }
  }
  var rata = totalBobot > 0 ? Math.round(totalSkor / totalBobot * 100 * 10) / 10 : null;
  return {success:true, total:rows.length, dinilai:hasil.length, hasil:hasil, rataEssay:rata};
}

// ===== CBT: SISWA (SINKRON PENUH) =====
function cbtStart(token, nis, nama, kelas) {
  var r = _req('POST', 'cbt-mulai', null, {token:token, nis:nis, nama:nama, kelas:kelas});
  if (r && r.success && r.data) {
    var d = r.data;
    if (d.sudahSelesai) {
      return { sudah: true, total: d.skor };
    }
    // ✅ FIX: Gunakan sisaDetik dari server sebagai sumber kebenaran
    var sisaDetik = d.sisaDetik || 0;
    // ✅ FIX BUG 3 & 4: Normalisasi soal agar SELALU punya `id` (frontend memakai q.id
    // untuk semua binding jawaban). PHP cbt-mulai mengembalikan `id` + `soalId`.
    var soal = (d.soal || []).map(function(q){
      if (q && (q.id === undefined || q.id === null) && q.soalId !== undefined) q.id = q.soalId;
      if (q && !q.opsiArr && q.opsi) q.opsiArr = q.opsi;   // normalisasi opsi → opsiArr
      return q;
    });
    return {
      sudah: false,
      sesiId: d.sesiId,
      sisaDetikAwal: sisaDetik,  // ← Simpan untuk perhitungan di client
      exam: {
        id: d.sesiId,
        judul: d.judul || 'Ulangan',
        mapel: d.mapel || 'Ulangan',
        durasi: Math.floor(sisaDetik / 60),  // ← Durasi dihitung dari sisaDetik
        ai: d.ai ? 1 : 0                     // ✅ koreksi essay otomatis oleh AI
      },
      soal: soal,
      saved: d.saved || {}   // ✅ FIX BUG 3: PHP cbt-mulai mengembalikan kunci 'saved' (bukan 'jawaban')
    };
  }
  return null;
}

function cbtAutosave(sesiId, nis, soalId, jawaban) {
  _req('POST', 'cbt-simpan-jawaban', null, {sesiId:sesiId, soalId:soalId, jawaban:jawaban});
  return 'OK';
}

function cbtSubmit(sesiId, nis, jawabanArr) {
  // Simpan batch dulu
  _req('POST', 'cbt-simpan-batch', null, {sesiId:sesiId, jawaban:jawabanArr});

  // Lalu finalisasi & kumpulkan (endpoint terpisah, tidak bentrok)
  var r = _req('POST', 'cbt-kumpulkan', null, {sesiId:sesiId});
  if (r && r.success && r.data) {
    var d = r.data;
    return {
      nilai_pg: d.skor != null ? d.skor : d.nilai_pg,
      benar: d.benar || d.total_benar || 0,
      salah: (d.total || d.total_soal || 0) - (d.benar || d.total_benar || 0),
      essayMenunggu: (d.uraian || d.uraian_menunggu || 0) > 0
    };
  }
  return {};
}

function getCbtRiwayatSiswa(nis) {
  // AKTIFKAN endpoint yang sudah ada di PHP
  return _d(_req('GET', 'cbt-riwayat-siswa', {nis:nis}), []);
}
// Tambahkan di Kode.gs
function cbtCleanupExpired() {
  var r = _req('POST', 'cbt-cleanup-expired', null, {});
  if (r && r.success) {
    Logger.log('CBT Cleanup: ' + r.message);
  }
  return r;
}

// ===================== AI: RINGKASAN & ANALISIS DATA (FITUR 1) =====================
// Alur: Index.html → generateSummary() → (1) tarik data mentah dari Index.php via _req,
//       (2) rangkai ke prompt Gemini, (3) kembalikan narasi ke Index.html untuk Dashboard.
function generateSummary(kelas, type, dateFrom, dateTo){
  // Reuse transport _req (sudah menangani header browser + parsing JSON)
  var raw = _req('GET', 'ai-data-summary', {kelas:kelas, type:type||'dashboard', date_from:dateFrom||'', date_to:dateTo||''});
  if (!raw || !raw.success) return {success:false, message:(raw&&raw.message)||'Gagal menarik data untuk diringkas.'};
  var data = raw.data || {};

  var json = JSON.stringify(data);
  if (json.length > 6000) json = json.substring(0, 6000) + '…(terpotong)';

  var prompt =
    'Kamu adalah analis data sekolah yang andal dan ringkas. Di bawah ini adalah data mentah (JSON) dari '+
    'sistem wali kelas untuk kelas '+String(kelas||'-')+', tipe "'+String(type||'dashboard')+'".\n\n'+
    'TUGAS: Buatkan NARASI untuk dashboard yang berisi:\n'+
    '1) Ringkasan 3 paragraf (apa yang terjadi, tren, angka penting).\n'+
    '2) Bagian "Insight" berupa 3-5 poin bullet yang BERANI dan TINDAKAN LANJUT (bukan sekadar mengulang angka).\n'+
    '3) Bagian "Peringatan" bila ada hal yang perlu perhatian wali kelas (kehadiran rendah, siswa di bawah KKM, stok menipis, dst).\n'+
    'Bahasa Indonesia, hangat, profesional, tanpa mengada-ada fakta. Output markdown rapi.\n\n'+
    'DATA MENTAH:\n'+json;

  var ai = _geminiJSON(prompt, 0.5, 2000);
  if (!ai.success) return ai;
  return {success:true, text:ai.text};
}

// ===================== AI: PENCARIAN PINTAR (FITUR 2) =====================
// Alur: Index.html → parseSearchQuery() → (1) Gemini mem-parsing kalimat → JSON murni
//       {table, filters:[{field,operator,value}]}, (2) kirim JSON ke Index.php
//       (ai-search-filter) yang mengeksekusi query aman, (3) kembalikan hasil search.
function parseSearchQuery(teks, kelas){
  var key = getGeminiKey();
  if (!key) return {success:false, message:'Kunci Gemini belum diset. Jalankan setGeminiKey("...") di editor.'};
  teks = String(teks||'').trim();
  if (teks.length < 3) return {success:false, message:'Ketik kalimat pencarian terlebih dahulu.'};

  var schema =
    '{"table":"<salah satu: kehadiran|nilai|tatatertib|jurnal_mengajar|jurnal_bimbingan|siswa|katalog_alat|bahan_praktik|peminjaman|kaskelas|pengumuman|kunjungan_rumah|presensi_mapel|tugas>",'+
    '"filters":[{"field":"<kolom yang diizinkan>","operator":"<eq|neq|gt|gte|lt|lte|like|not_like|in|not_in|between>","value":"<nilai; untuk between gunakan array [dari,ke], untuk in gunakan array berisi banyak nilai>"}]}';

  var prompt =
    'Kamu adalah Natural Language to SQL helper untuk aplikasi sekolah. Terjemahkan kalimat pengguna '+
    'di bawah menjadi JSON PALING MIRING yang siap dipakai query. \n'+
    'PANDUAN KOLOM PER TABEL:\n'+
    '- kehadiran: tanggal, nis, status(Hadir/Sakit/Izin/Alfa), keterangan\n'+
    '- nilai: nis, mapel, jenis, nilai, tanggal\n'+
    '- tatatertib: tanggal, nis, pelanggaran, poin\n'+
    '- jurnal_mengajar: tanggal, nip, mapel, jam_ke, materi, kegiatan\n'+
    '- jurnal_bimbingan: tanggal, nis, kategori, isi, tindak_lanjut\n'+
    '- siswa: nis, nama_siswa, jk, ttl, alamat, no_wa, ekstra\n'+
    '- katalog_alat: kode, nama_barang, spesifikasi, jumlah, kondisi, lokasi\n'+
    '- bahan_praktik: kode, nama_bahan, satuan, stok, stok_min, kategori\n'+
    '- peminjaman: id_pinjam, kode_barang, nama_barang, peminjam, jenis_peminjam, tgl_pinjam, batas_waktu, status, tgl_kembali\n'+
    '- kaskelas: tanggal, jenis, jumlah, keterangan\n'+
    '- pengumuman: judul, isi, tanggal, penulis\n'+
    '- kunjungan_rumah: tanggal, nis, nama_siswa, alamat, hasil, tindak_lanjut, petugas\n'+
    '- presensi_mapel: tanggal, nis, nip, mapel, status, jam_ke\n'+
    '- tugas: id, mapel, judul, deskripsi, tenggat, status\n'+
    'ATURAN:\n'+
    '1. Tetapkan "table" yang paling sesuai dengan maksud pengguna.\n'+
    '2. "bulan lalu"/"bulan ini"/"tahun" → gunakan operator between dengan dua tanggal [dari, ke] (format YYYY-MM-DD).\n'+
    '3. Kata status tak selesai/kurang → gunakan operator like dengan nilai parsial (mis. "belum" atau "kurang").\n'+
    '4. Nama siswa → field nama_siswa dengan operator like (nilai tanpa %% di sini).\n'+
    '5. Hanya gunakan kolom yang terdaftar di atas; abaikan kolom lain.\n'+
    '6. Kelas disetel otomatis oleh sistem, TIDAK perlu dianggap dari kalimat.\n'+
    'KELUARKAN HANYA SATU OBJEK JSON (tanpa markdown, tanpa teks lain) format persis:\n'+schema+'\n\n'+
    'KALIMAT PENGGUNA: "'+teks+'"';

  var ai = _geminiJSON(prompt, 0.2, 1000);
  if (!ai.success) return ai;
  var parsed = ai.parsed;
  if (!parsed || !parsed.table) return {success:false, message:'AI tidak dapat mengartikan pencarian. Coba lebih spesifik.'};

  // Kirim ke Index.php untuk dieksekusi (prepared statement + whitelist kolom)
  var r = _req('POST', 'ai-search-filter', null, {kelas:kelas, table:parsed.table, filters:parsed.filters||[], limit:100});
  if (!r || !r.success) return {success:false, message:(r&&r.message)||'Gagal menjalankan pencarian.'};
  return {success:true, table:parsed.table, total:r.data.total, records:r.data.records, query:parsed};
}

// ===================== AI: EKSTRAK & KLASIFIKASI OTOMATIS (FITUR 3) =====================
// Alur: Index.html → extractDataEntry() → (1) teks mentah → Gemini ekstrak entitas → JSON
//       terstruktur, (2) kembalikan JSON ke Index.html untuk autofill form entry.
function extractDataEntry(teks, konteks){
  var key = getGeminiKey();
  if (!key) return {success:false, message:'Kunci Gemini belum diset. Jalankan setGeminiKey("...") di editor.'};
  teks = String(teks||'').trim();
  if (teks.length < 10) return {success:false, message:'Teks terlalu pendek. Tempel catatan mentah yang cukup.'};
  konteks = konteks||{};

  var prompt =
    'Kamu adalah asisten input data. Ekstrak informasi dari catatan mentah guru di bawah menjadi '+
    'JSON terstruktur untuk form entri tugas/aktivitas.\n\n'+
    'TUGAS: Isi sebanyak mungkin bidang berikut berdasarkan teks (kosongkan bila tak ada):\n'+
    '{"nama":"<nama tugas/aktivitas>","tanggal":"<YYYY-MM-DD>","tenggat":"<YYYY-MM-DD>","deskripsi":"<rangkuman singkat>"}\n\n'+
    'PANDUAN:\n'+
    '1. "nama" = tema/topik utama (mis. "Ekstraksi DNA", "Praktikum Titrasi").\n'+
    '2. "tanggal" = tanggal pelaksanaan/kegiatan; "tenggat" = batas waktu pengumpulan/'+
    'deadline. Jika teks menyebut "dikumpulkan"/"deadline"/"terakhir" → tenggat.\n'+
    '3. Tanggal ubah ke format YYYY-MM-DD; jika hanya disebutkan relatif (mis. "Senin", "besok") dan '+
    'konteks hari ini = '+String(konteks.tanggal||'')+', hitung perkiraan tanggalnya.\n'+
    '4. "deskripsi" = rangkuman 1-2 kalimat dari isi catatan.\n'+
    '5. Jangan menambah informasi yang tidak ada di teks.\n'+
    'KELUARKAN HANYA SATU OBJEK JSON (tanpa markdown, tanpa teks lain).\n\n'+
    'CATATAN MENTAH:\n'+teks;

  var ai = _geminiJSON(prompt, 0.2, 800);
  if (!ai.success) return ai;
  var d = ai.parsed || {};
  return {success:true, nama:String(d.nama||'').trim(), tanggal:String(d.tanggal||'').trim(), tenggat:String(d.tenggat||'').trim(), deskripsi:String(d.deskripsi||'').trim(), raw:d};
}

// ===================== AI: HELPER PANGGILAN GEMINI (JSON murni) =====================
// Memanggil Gemini, lalu memaksa output menjadi objek JSON (menahan backtick/markdown).
function _geminiJSON(prompt, temp, maxTokens){
  var key = getGeminiKey();
  if (!key) return {success:false, message:'Kunci Gemini belum diset. Jalankan setGeminiKey("...") di editor.'};
  var url = 'https://generativelanguage.googleapis.com/v1beta/models/' + GEMINI_MODEL + ':generateContent?key=' + key;
  var body = {
    contents:[{ role:'user', parts:[{ text: prompt }] }],
    generationConfig:{ temperature:temp||0.3, maxOutputTokens:maxTokens||2000 },
    safetySettings:[
      {category:'HARM_CATEGORY_HARASSMENT',threshold:'BLOCK_NONE'},
      {category:'HARM_CATEGORY_HATE_SPEECH',threshold:'BLOCK_NONE'},
      {category:'HARM_CATEGORY_SEXUALLY_EXPLICIT',threshold:'BLOCK_NONE'},
      {category:'HARM_CATEGORY_DANGEROUS_CONTENT',threshold:'BLOCK_NONE'}
    ]
  };
  try {
    var r = UrlFetchApp.fetch(url, {method:'post', contentType:'application/json', muteHttpExceptions:true, payload:JSON.stringify(body)});
    var code = r.getResponseCode(); var txt = r.getContentText();
    if (code < 200 || code >= 300) return {success:false, message:'Gemini HTTP '+code+': '+txt.substring(0,300)};
    var j = JSON.parse(txt);
    var out = (j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts && j.candidates[0].content.parts[0]) ? j.candidates[0].content.parts[0].text : '';
    if (!out) return {success:false, message:'Gemini tidak mengembalikan teks.'};
    var parsed = _extractJson(out);

    // FITUR 2 & 3 butuh JSON murni → bila gagal parse, beri peringatan agar AI SDL (System Design Language) diperbaiki.
    if (parsed === null && (prompt.indexOf('KELUARKAN HANYA SATU OBJEK JSON') > -1)) {
      return {success:false, message:'AI tidak mengembalikan JSON valid: '+out.substring(0,300)};
    }
    return {success:true, text:out, parsed:parsed};
  } catch(e){ return {success:false, message:'Gagal AI: '+e.message}; }
}

// Setup trigger otomatis (jalankan sekali secara manual)
function setupCbtCleanupTrigger() {
  // Hapus trigger lama jika ada
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'cbtCleanupExpired') {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
  // Buat trigger baru: jalan setiap 5 menit
  ScriptApp.newTrigger('cbtCleanupExpired')
    .timeBased()
    .everyMinutes(5)
    .create();
  return 'Trigger cleanup CBT aktif (setiap 5 menit)';
}