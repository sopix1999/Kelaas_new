<?php
// ============================================================
//  KELAAS - API (index.php) - FINAL SECURE VERSION
//  Auto-hash password + Dual-mode login + CBT Token System
// ============================================================
require_once 'config.php';
date_default_timezone_set('Asia/Jakarta');

// ===== ERROR HANDLING =====
register_shutdown_function(function () {
    $e = error_get_last();
    if ($e && in_array($e['type'], [E_ERROR, E_PARSE, E_CORE_ERROR, E_COMPILE_ERROR, E_USER_ERROR])) {
        if (!headers_sent()) { header('Content-Type: application/json; charset=utf-8'); http_response_code(500); }
        echo json_encode(['success'=>false,'message'=>'PHP fatal: '.$e['message'].' ('.basename($e['file']).':'.$e['line'].')'], JSON_UNESCAPED_UNICODE);
    }
});

$action = getParam('action') ?? '';
$method = $_SERVER['REQUEST_METHOD'];

// ===== HELPER CBT FINALISASI =====
// $recalc=true dipakai saat guru mengoreksi essay: hitung ulang skor TANPA
// menimpa nilai essay yang sudah dikoreksi dan TANPA kunci `selesai`.
function _cbt_finalisasi($db, $sid, $recalc = false) {
    $st = $db->prepare('SELECT selesai, ujian_id, deadline FROM cbt_sesi WHERE id=?');
    $st->execute([$sid]);
    $s = $st->fetch();
    if (!$s) return;
    // Finalisasi PG hanya dilakukan SEKALI (kecuali mode recalc koreksi essay)
    if (!$recalc && (int)$s['selesai'] === 1) return;

    $uid = (int)$s['ujian_id'];
    $st = $db->prepare('SELECT id, jenis, kunci, bobot FROM cbt_soal WHERE ujian_id=?'); $st->execute([$uid]);
    $soal = []; foreach ($st->fetchAll() as $r) $soal[(int)$r['id']] = $r;
    // ✅ FIX BUG 3: Ambil juga kolom `benar` agar nilai essay yang sudah dikoreksi
    // guru TIDAK ditimpa NULL oleh finalisasi ulang.
    $st = $db->prepare('SELECT soal_id, jawaban, benar FROM cbt_jawaban WHERE sesi_id=?'); $st->execute([$sid]);
    $jw = []; $jbenar = [];
    foreach ($st->fetchAll() as $x) { $jw[(int)$x['soal_id']] = $x['jawaban']; $jbenar[(int)$x['soal_id']] = $x['benar']; }

    $pgPoin = 0; $pgTotal = 0; $esPoin = 0; $esTotal = 0; $esMenunggu = 0;
    $upJ = $db->prepare('UPDATE cbt_jawaban SET benar=? WHERE sesi_id=? AND soal_id=?');
    foreach ($soal as $sidSoal => $meta) {
        $jenis = (int)$meta['jenis']; $bobot = (int)$meta['bobot'] ?: 1;
        $jawab = $jw[$sidSoal] ?? null;
        if ($jenis == 5) {
            $esTotal += $bobot;
            if (isset($jbenar[$sidSoal]) && $jbenar[$sidSoal] !== null) {
                $esPoin += (int)$jbenar[$sidSoal];          // sudah dinilai guru → masukkan skor
            } elseif ($jawab !== null && $jawab !== '') {
                $esMenunggu++;                              // belum dinilai → menunggu koreksi
            }
            continue;                                       // jangan SET benar=NULL (tidak timpa)
        }
        $pgTotal += $bobot; $ok = 0;
        $kunci = $meta['kunci'] ?? '';
        if ($jenis == 1) {
            $ok = (strtoupper(trim((string)$jawab)) === strtoupper(trim((string)$kunci))) ? 1 : 0;
        } elseif ($jenis == 2) {
            $ka = array_values(array_filter(array_map('trim', explode(',', $kunci)))); sort($ka);
            $va = is_array($jawab) ? $jawab : json_decode((string)$jawab, true); if (!is_array($va)) $va = [];
            $va = array_values($va); sort($va); $ok = ($ka == $va) ? 1 : 0;
        } elseif ($jenis == 3) {
            $ka = json_decode((string)$kunci, true) ?: []; $va = is_array($jawab) ? $jawab : json_decode((string)$jawab, true); if (!is_array($va)) $va = [];
            $norm = function($a){ $o=[]; foreach($a as $p){ if(is_array($p)&&isset($p['b'],$p['k'])) $o[$p['b']]=$p['k']; } ksort($o); return $o; };
            $ok = ($norm($ka) == $norm($va)) ? 1 : 0;
        } elseif ($jenis == 4) {
            $a = mb_strtolower(trim((string)$jawab)); $k = mb_strtolower(trim((string)$kunci));
            $ok = ($a !== '' && $k !== '' && ($a === $k || mb_strpos($a, $k) !== false || mb_strpos($k, $a) !== false)) ? 1 : 0;
        }
        if ($ok) $pgPoin += $bobot;
        $upJ->execute([$ok, $sid, $sidSoal]);
    }
    // skor = nilai PG selama masih ada essay menunggu; setelah SEMUA essay dinilai,
    // skor menjadi nilai GABUNGAN (PG + essay) → nilai akhir sesi.
    if ($pgTotal > 0 && $esMenunggu === 0 && $esPoin > 0) {
        $totalBobot = $pgTotal + $esTotal;
        $skor = $totalBobot > 0 ? round(($pgPoin + $esPoin) / $totalBobot * 100, 2) : null;
    } else {
        $skor = $pgTotal > 0 ? round($pgPoin / $pgTotal * 100, 2) : null;
    }
    // total_benar / total_soal tetap berisi statistik PG saja (dipakai layar hasil siswa
    // untuk hitungan BENAR / SALAH pilihan ganda).
    $db->prepare('UPDATE cbt_sesi SET selesai=1, skor=?, total_benar=?, total_soal=?, uraian_menunggu=? WHERE id=?')
       ->execute([$skor, $pgPoin, $pgTotal, $esMenunggu, $sid]);
}

// Normalisasi field profil/ortu siswa (dipakai POST/PUT/import agar satu definisi)
function _siswaFields($src) {
    $f = [];
    $keys = ['ttl','alamat','noWa'=>'no_wa','ekstra','namaAyah'=>'nama_ayah','namaIbu'=>'nama_ibu','kerjaAyah'=>'kerja_ayah','kerjaIbu'=>'kerja_ibu','penghasilanOrtu'=>'penghasilan_ortu'];
    foreach ($keys as $k => $col) {
        $in = is_numeric($k) ? $col : $k;   // kunci input (camelCase)
        $f[$col] = trim((string)($src[$in] ?? ''));
    }
    return $f;
}

try {
    switch ($action) {
        // ===================== AUTH (DUAL-MODE: HASH & PLAIN TEXT) =====================
        case 'login':
            if ($method !== 'POST') error('Method not allowed', 405);
            $body = getBody(); $db = getDB();
            $u = $body['username'] ?? ''; $p = $body['password'] ?? '';
            if (!$u || !$p) error('Username dan password wajib diisi');
            
            // Ambil user DULU tanpa cek password di WHERE
            $st = $db->prepare('SELECT id, username, password, role, kelas, nama_lengkap AS namaLengkap, nip FROM users WHERE username=?');
            $st->execute([$u]); 
            $user = $st->fetch();
            
            if (!$user) error('Username atau password salah', 401);
            
            $storedPass = $user['password'];
            $passwordValid = false;
            
            // DUAL-MODE: Support hash & plain text untuk backward compatibility
            if (strpos($storedPass, '$2y$') === 0 || strpos($storedPass, '$2b$') === 0 || strpos($storedPass, '$2a$') === 0) {
                // Password sudah hash → pakai password_verify
                $passwordValid = password_verify($p, $storedPass);
            } else {
                // Password masih plain text → bandingkan langsung
                $passwordValid = ($storedPass === $p);
                
                // AUTO-UPGRADE: Hash password setelah login berhasil
                if ($passwordValid) {
                    try {
                        $newHash = password_hash($p, PASSWORD_DEFAULT);
                        $db->prepare('UPDATE users SET password=? WHERE id=?')->execute([$newHash, $user['id']]);
                    } catch (Exception $e) { /* abaikan error upgrade */ }
                }
            }
            
            if (!$passwordValid) error('Username atau password salah', 401);
            
            unset($user['password']); // Hapus password dari response
            $roles = [$user['role']];
            if (!empty($user['nip']) && $user['role'] === 'Walikelas') $roles[] = 'Guru';
            $user['roles'] = $roles;
            success($user, 'Login berhasil');
            break;

        case 'test':
            $db = getDB();
            success(['version' => $db->query('SELECT VERSION()')->fetchColumn()], 'Koneksi berhasil');
            break;

        // ===================== SETUP =====================
        case 'setup':
            if ($method !== 'POST') error('Method not allowed', 405);
            $db = getDB();
            $ddl = [
                "CREATE TABLE IF NOT EXISTS users (id INT AUTO_INCREMENT PRIMARY KEY, username VARCHAR(100) NOT NULL UNIQUE, password VARCHAR(255) NOT NULL, role VARCHAR(50) NOT NULL, kelas VARCHAR(50), nama_lengkap VARCHAR(150), nip VARCHAR(100)) ENGINE=InnoDB",
                "CREATE TABLE IF NOT EXISTS siswa (id INT AUTO_INCREMENT PRIMARY KEY, nis VARCHAR(50) NOT NULL, nama_siswa VARCHAR(150) NOT NULL, kelas VARCHAR(50), jk VARCHAR(5), ttl VARCHAR(150) DEFAULT '', alamat VARCHAR(255) DEFAULT '', no_wa VARCHAR(30) DEFAULT '', ekstra VARCHAR(255) DEFAULT '', nama_ayah VARCHAR(150) DEFAULT '', nama_ibu VARCHAR(150) DEFAULT '', kerja_ayah VARCHAR(150) DEFAULT '', kerja_ibu VARCHAR(150) DEFAULT '', penghasilan_ortu VARCHAR(150) DEFAULT '', INDEX idx_kelas(kelas), INDEX idx_nis(nis)) ENGINE=InnoDB",
                "CREATE TABLE IF NOT EXISTS guru (id INT AUTO_INCREMENT PRIMARY KEY, nip VARCHAR(100) NOT NULL, nama_guru VARCHAR(150), mapel VARCHAR(150), kelas_diampu TEXT) ENGINE=InnoDB",
                "CREATE TABLE IF NOT EXISTS kehadiran (id INT AUTO_INCREMENT PRIMARY KEY, tanggal DATE, nis VARCHAR(50), kelas VARCHAR(50), status VARCHAR(20), keterangan VARCHAR(255), INDEX idx_kelas_tgl(kelas,tanggal)) ENGINE=InnoDB",
                "CREATE TABLE IF NOT EXISTS tatatertib (id INT AUTO_INCREMENT PRIMARY KEY, tanggal DATE, nis VARCHAR(50), pelanggaran VARCHAR(255), poin INT, kelas VARCHAR(50), INDEX idx_kelas(kelas)) ENGINE=InnoDB",
                "CREATE TABLE IF NOT EXISTS kaskelas (id INT AUTO_INCREMENT PRIMARY KEY, tanggal DATE, kelas VARCHAR(50), jenis VARCHAR(20), jumlah DECIMAL(15,2), keterangan VARCHAR(255), INDEX idx_kelas(kelas)) ENGINE=InnoDB",
                "CREATE TABLE IF NOT EXISTS struktur_kelas (id INT AUTO_INCREMENT PRIMARY KEY, kelas VARCHAR(50), jabatan VARCHAR(100), nis VARCHAR(50), nama_siswa VARCHAR(150), INDEX idx_kelas(kelas)) ENGINE=InnoDB",
                "CREATE TABLE IF NOT EXISTS inventaris (id INT AUTO_INCREMENT PRIMARY KEY, kelas VARCHAR(50), nama_barang VARCHAR(150), jumlah INT, kondisi VARCHAR(50), keterangan VARCHAR(255), tanggal DATE, INDEX idx_kelas(kelas)) ENGINE=InnoDB",
                "CREATE TABLE IF NOT EXISTS pengumuman (id INT AUTO_INCREMENT PRIMARY KEY, kelas VARCHAR(50), judul VARCHAR(255), isi TEXT, tanggal DATE, penulis VARCHAR(150), INDEX idx_kelas(kelas)) ENGINE=InnoDB",
                "CREATE TABLE IF NOT EXISTS jadwal_pelajaran (id INT AUTO_INCREMENT PRIMARY KEY, kelas VARCHAR(50), hari VARCHAR(20), jam_ke INT, mata_pelajaran VARCHAR(150), nip VARCHAR(100), INDEX idx_kelas(kelas), INDEX idx_nip(nip)) ENGINE=InnoDB",
                "CREATE TABLE IF NOT EXISTS jadwal_piket (id INT AUTO_INCREMENT PRIMARY KEY, kelas VARCHAR(50), hari VARCHAR(20), nis VARCHAR(50), nama_siswa VARCHAR(150), INDEX idx_kelas(kelas)) ENGINE=InnoDB",
                "CREATE TABLE IF NOT EXISTS jurnal_bimbingan (id INT AUTO_INCREMENT PRIMARY KEY, tanggal DATE, kelas VARCHAR(50), kategori VARCHAR(50), isi TEXT, tindak_lanjut VARCHAR(255), INDEX idx_kelas(kelas)) ENGINE=InnoDB",
                "CREATE TABLE IF NOT EXISTS jurnal_mengajar (id INT AUTO_INCREMENT PRIMARY KEY, tanggal DATE, kelas VARCHAR(50), nip VARCHAR(100), mapel VARCHAR(150), jam_ke INT, materi TEXT, kegiatan VARCHAR(255), INDEX idx_nip(nip)) ENGINE=InnoDB",
                "CREATE TABLE IF NOT EXISTS presensi_mapel (id INT AUTO_INCREMENT PRIMARY KEY, tanggal DATE, kelas VARCHAR(50), nis VARCHAR(50), nip VARCHAR(100), mapel VARCHAR(150), status VARCHAR(20), jam_ke INT NULL, created_at DATETIME NULL, updated_at DATETIME NULL, INDEX idx_nip_kelas(nip,kelas)) ENGINE=InnoDB",
                "CREATE TABLE IF NOT EXISTS nilai (id INT AUTO_INCREMENT PRIMARY KEY, nis VARCHAR(50), kelas VARCHAR(50), nip VARCHAR(100), mapel VARCHAR(150), jenis VARCHAR(20), nilai DECIMAL(5,2), tanggal DATE, INDEX idx_nip_kelas(nip,kelas)) ENGINE=InnoDB",
                "CREATE TABLE IF NOT EXISTS katalog_alat (id INT AUTO_INCREMENT PRIMARY KEY, kode VARCHAR(50), nama_barang VARCHAR(150), spesifikasi VARCHAR(255), jumlah INT, kondisi VARCHAR(50), lokasi VARCHAR(100)) ENGINE=InnoDB",
                "CREATE TABLE IF NOT EXISTS bahan_praktik (id INT AUTO_INCREMENT PRIMARY KEY, kode VARCHAR(50), nama_bahan VARCHAR(150), satuan VARCHAR(50), stok DECIMAL(10,2), stok_min DECIMAL(10,2), kategori VARCHAR(100)) ENGINE=InnoDB",
                "CREATE TABLE IF NOT EXISTS peminjaman (id INT AUTO_INCREMENT PRIMARY KEY, id_pinjam VARCHAR(50), kode_barang VARCHAR(50), nama_barang VARCHAR(150), peminjam VARCHAR(150), jenis_peminjam VARCHAR(50), tgl_pinjam DATE, batas_waktu DATE, status VARCHAR(20), tgl_kembali DATE) ENGINE=InnoDB",
                "CREATE TABLE IF NOT EXISTS laporan_kerusakan (id INT AUTO_INCREMENT PRIMARY KEY, tanggal DATE, kode_barang VARCHAR(50), nama_barang VARCHAR(150), kerusakan TEXT, pelapor VARCHAR(150), status VARCHAR(50), jadwal_maintenance DATE) ENGINE=InnoDB",
                "CREATE TABLE IF NOT EXISTS kunjungan_rumah (id INT AUTO_INCREMENT PRIMARY KEY, tanggal DATE, nis VARCHAR(50), kelas VARCHAR(50), nama_siswa VARCHAR(150), alamat VARCHAR(255), hasil TEXT, tindak_lanjut VARCHAR(255), petugas VARCHAR(150), INDEX idx_kelas(kelas)) ENGINE=InnoDB",
                "CREATE TABLE IF NOT EXISTS settings (id INT AUTO_INCREMENT PRIMARY KEY, setting_key VARCHAR(100) NOT NULL UNIQUE, setting_value VARCHAR(255)) ENGINE=InnoDB",
                "CREATE TABLE IF NOT EXISTS log_aktivitas (id INT AUTO_INCREMENT PRIMARY KEY, waktu DATETIME, username VARCHAR(100), role VARCHAR(50), aksi VARCHAR(100), detail VARCHAR(255)) ENGINE=InnoDB"
            ];
            $ok=0;$fail=0;$errs=[];
            foreach ($ddl as $sql){ try{$db->exec($sql);$ok++;}catch(Exception $e){$fail++;$errs[]=$e->getMessage();} }
            try {
                if ((int)$db->query('SELECT COUNT(*) FROM users')->fetchColumn() === 0) {
                    $in = $db->prepare('INSERT INTO users (username,password,role,kelas,nama_lengkap,nip) VALUES (?,?,?,?,?,?)');
                    // AUTO-HASH PASSWORD DEFAULT
                    $seedUsers = [
                        ['admin', password_hash('admin123', PASSWORD_DEFAULT), 'SuperAdmin', 'ALL', 'Administrator', ''],
                        ['walas7a', password_hash('guru123', PASSWORD_DEFAULT), 'Walikelas', '7A', 'Siti Aminah, S.Pd', '19850101'],
                        ['19850101', password_hash('guru123', PASSWORD_DEFAULT), 'Guru', 'GURU', 'Siti Aminah, S.T', '19850101'],
                        ['toolman', password_hash('tool123', PASSWORD_DEFAULT), 'Toolman', 'TKJ', 'Andi Prasetyo', ''],
                        ['sekret7a', password_hash('sekret123', PASSWORD_DEFAULT), 'Sekretaris', '7A', 'Dewi Lestari', ''],
                        ['benda7a', password_hash('benda123', PASSWORD_DEFAULT), 'Bendahara', '7A', 'Ahmad Fauzi', ''],
                        ['ketua7a', password_hash('ketua123', PASSWORD_DEFAULT), 'Ketua', '7A', 'Budi Santoso', ''],
                        ['001', password_hash('siswa123', PASSWORD_DEFAULT), 'Siswa', '7A', 'Ahmad Rizki', ''],
                        ['002', password_hash('siswa123', PASSWORD_DEFAULT), 'Siswa', '7A', 'Siti Nurhaliza', '']
                    ];
                    foreach ($seedUsers as $r) $in->execute($r);
                }
                if ((int)$db->query('SELECT COUNT(*) FROM settings')->fetchColumn() === 0) $db->exec("INSERT INTO settings (setting_key,setting_value) VALUES ('TA_AKTIF','2025/2026'),('SEMESTER','1')");
                if ((int)$db->query('SELECT COUNT(*) FROM guru')->fetchColumn() === 0) $db->exec("INSERT INTO guru (nip,nama_guru,mapel) VALUES ('19850101','Siti Aminah, S.T','Produktif TKJ')");
            } catch (Exception $e) { $errs[] = 'seed: '.$e->getMessage(); }
            success(['tabel_ok'=>$ok,'tabel_gagal'=>$fail,'errors'=>$errs], 'Setup selesai');
            break;

        case 'setup-guru-v2':
            if ($method !== 'POST') error('Method not allowed', 405);
            $db = getDB(); $done=[]; $errs=[];
            foreach ([['presensi_mapel','jam_ke','INT NULL'],['presensi_mapel','created_at','DATETIME NULL'],['presensi_mapel','updated_at','DATETIME NULL']] as $c) {
                try { $db->exec("ALTER TABLE {$c[0]} ADD COLUMN {$c[1]} {$c[2]}"); $done[]=$c[0].'.'.$c[1]; }
                catch (Exception $e) { if (stripos($e->getMessage(),'Duplicate column')!==false) $done[]=$c[1].' (sudah ada)'; else $errs[]=$c[1].': '.$e->getMessage(); }
            }
            success(['ditambahkan'=>$done,'errors'=>$errs], 'Setup Guru V2 selesai');
            break;

        case 'setup-siswa-v2':
            if ($method !== 'POST') error('Method not allowed', 405);
            $db = getDB(); $done=[]; $errs=[];
            foreach ([
                ['siswa','ttl','VARCHAR(150) DEFAULT \'\''],
                ['siswa','alamat','VARCHAR(255) DEFAULT \'\''],
                ['siswa','no_wa','VARCHAR(30) DEFAULT \'\''],
                ['siswa','ekstra','VARCHAR(255) DEFAULT \'\''],
                ['siswa','nama_ayah','VARCHAR(150) DEFAULT \'\''],
                ['siswa','nama_ibu','VARCHAR(150) DEFAULT \'\''],
                ['siswa','kerja_ayah','VARCHAR(150) DEFAULT \'\''],
                ['siswa','kerja_ibu','VARCHAR(150) DEFAULT \'\''],
                ['siswa','penghasilan_ortu','VARCHAR(150) DEFAULT \'\'']
            ] as $c) {
                try { $db->exec("ALTER TABLE {$c[0]} ADD COLUMN {$c[1]} {$c[2]}"); $done[]=$c[0].'.'.$c[1]; }
                catch (Exception $e) { if (stripos($e->getMessage(),'Duplicate column')!==false) $done[]=$c[1].' (sudah ada)'; else $errs[]=$c[1].': '.$e->getMessage(); }
            }
            success(['ditambahkan'=>$done,'errors'=>$errs], 'Setup Siswa V2 selesai');
            break;

        // ===================== DASHBOARD =====================
        case 'dashboard':
            if ($method !== 'GET') error('Method not allowed', 405);
            $kelas = getParam('kelas'); $role = getParam('role'); $nip = getParam('nip');
            if (!$kelas) error('Parameter kelas wajib diisi');
            $db = getDB(); $today = date('Y-m-d');
            $hari = ['Minggu','Senin','Selasa','Rabu','Kamis','Jumat','Sabtu'][date('w')];
            $st=$db->prepare('SELECT COUNT(*) AS c FROM siswa WHERE kelas=?');$st->execute([$kelas]);$totalSiswa=(int)$st->fetch()['c'];
            $st=$db->prepare('SELECT status, COUNT(*) AS c FROM kehadiran WHERE kelas=? AND tanggal=? GROUP BY status');$st->execute([$kelas,$today]);
            $h=0;$s=0;$iz=0;$al=0;
            foreach($st->fetchAll() as $kr){$cc=(int)$kr['c'];if($kr['status']==='Hadir')$h=$cc;elseif($kr['status']==='Sakit')$s=$cc;elseif($kr['status']==='Izin')$iz=$cc;elseif($kr['status']==='Alfa')$al=$cc;}
            $st=$db->prepare('SELECT s.nis, s.nama_siswa AS nama, COALESCE(k.status,"Belum Absen") AS status FROM siswa s LEFT JOIN kehadiran k ON s.nis=k.nis AND k.tanggal=? WHERE s.kelas=? AND (k.status IS NULL OR k.status<>"Hadir")');$st->execute([$today,$kelas]);$absent=$st->fetchAll();
            $st=$db->prepare('SELECT tanggal, status, COUNT(*) AS c FROM kehadiran WHERE kelas=? GROUP BY tanggal,status ORDER BY tanggal DESC LIMIT 70');$st->execute([$kelas]);$chartRows=$st->fetchAll();
            $st=$db->prepare('SELECT id AS row, judul, isi, tanggal, penulis FROM pengumuman WHERE kelas=? ORDER BY tanggal DESC, id DESC LIMIT 3');$st->execute([$kelas]);$pengumuman=$st->fetchAll();
            $st=$db->prepare('SELECT nis, nama_siswa AS nama FROM jadwal_piket WHERE kelas=? AND hari=?');$st->execute([$kelas,$hari]);$piket=$st->fetchAll();
            $byDate=[];foreach($chartRows as $r){$d=$r['tanggal'];if(!isset($byDate[$d]))$byDate[$d]=['Hadir'=>0,'Sakit'=>0,'Izin'=>0,'Alfa'=>0];if(isset($byDate[$d][$r['status']]))$byDate[$d][$r['status']]=(int)$r['c'];}
            $dates=array_keys($byDate);rsort($dates);$dates=array_slice($dates,0,7);sort($dates);
            $chart=['labels'=>[],'hadir'=>[],'absent'=>[]];
            foreach($dates as $d){$p=explode('-',$d);$chart['labels'][]=(int)$p[2].' '.['','Jan','Feb','Mar','Apr','Mei','Jun','Jul','Agu','Sep','Okt','Nov','Des'][(int)$p[1]];$chart['hadir'][]=$byDate[$d]['Hadir'];$chart['absent'][]=$byDate[$d]['Sakit']+$byDate[$d]['Izin']+$byDate[$d]['Alfa'];}
            $result=['today'=>$today,'totalSiswa'=>$totalSiswa,'hadir'=>$h,'sakit'=>$s,'izin'=>$iz,'alfa'=>$al,'absentStudents'=>$absent,'chart'=>$chart,'pengumuman'=>$pengumuman,'hariIni'=>$hari,'todayPiket'=>$piket,'todaySchedule'=>[]];
            if($role==='Guru'&&$nip){$st=$db->prepare('SELECT kelas, jam_ke AS jamKe, mata_pelajaran AS mapel FROM jadwal_pelajaran WHERE nip=? AND hari=? ORDER BY jam_ke');$st->execute([$nip,$hari]);$result['todaySchedule']=$st->fetchAll();}
            else{$st=$db->prepare('SELECT jam_ke AS jamKe, mata_pelajaran AS mapel, nip AS guru FROM jadwal_pelajaran WHERE kelas=? AND hari=? ORDER BY jam_ke');$st->execute([$kelas,$hari]);$result['todaySchedule']=$st->fetchAll();}
            success($result);
            break;

        case 'dashboard-rekap':
            if ($method !== 'GET') error('Method not allowed', 405);
            $kelas=getParam('kelas');$role=getParam('role');$nip=getParam('nip');
            if(!$kelas)error('Parameter kelas wajib diisi');
            $db=getDB();$r=[];
            $st=$db->prepare('SELECT COUNT(*) AS c FROM siswa WHERE kelas=?');$st->execute([$kelas]);$r['totalSiswa']=(int)$st->fetch()['c'];
            $st=$db->prepare('SELECT COUNT(*) AS c FROM tatatertib WHERE kelas=?');$st->execute([$kelas]);$r['totalPelanggaran']=(int)$st->fetch()['c'];
            $st=$db->prepare('SELECT COALESCE(SUM(CASE WHEN jenis="Masuk" THEN jumlah ELSE 0 END),0) AS m, COALESCE(SUM(CASE WHEN jenis="Keluar" THEN jumlah ELSE 0 END),0) AS k FROM kaskelas WHERE kelas=?');$st->execute([$kelas]);$row=$st->fetch();$r['saldoKas']=(float)$row['m']-(float)$row['k'];
            $st=$db->prepare('SELECT COUNT(*) AS c FROM pengumuman WHERE kelas=?');$st->execute([$kelas]);$r['totalPengumuman']=(int)$st->fetch()['c'];
            $st=$db->prepare('SELECT COUNT(*) AS c FROM inventaris WHERE kelas=?');$st->execute([$kelas]);$r['totalInventaris']=(int)$st->fetch()['c'];
            $st=$db->prepare('SELECT COUNT(*) AS c FROM jurnal_bimbingan WHERE kelas=?');$st->execute([$kelas]);$r['totalBimbingan']=(int)$st->fetch()['c'];
            if($role==='Guru'&&$nip){
                $st=$db->prepare('SELECT COUNT(*) AS c FROM jurnal_mengajar WHERE nip=?');$st->execute([$nip]);$r['totalJurnalMengajar']=(int)$st->fetch()['c'];
                $st=$db->prepare('SELECT COUNT(DISTINCT kelas) AS c FROM jadwal_pelajaran WHERE nip=?');$st->execute([$nip]);$r['kelasDiampu']=(int)$st->fetch()['c'];
            }
            if($role==='Toolman'){$r['totalAlat']=(int)$db->query('SELECT COUNT(*) AS c FROM katalog_alat')->fetch()['c'];$r['totalBahan']=(int)$db->query('SELECT COUNT(*) AS c FROM bahan_praktik')->fetch()['c'];$r['lowStock']=(int)$db->query('SELECT COUNT(*) AS c FROM bahan_praktik WHERE stok<=stok_min')->fetch()['c'];$r['pinjamAktif']=(int)$db->query('SELECT COUNT(*) AS c FROM peminjaman WHERE status="Dipinjam"')->fetch()['c'];}
            success($r);
            break;

        case 'early-warning':
            if ($method !== 'GET') error('Method not allowed', 405);
            $kelas=getParam('kelas');if(!$kelas)error('Parameter kelas wajib diisi');
            $db=getDB();
            $st=$db->prepare('SELECT nis, COUNT(*) AS c FROM kehadiran WHERE kelas=? AND status="Alfa" GROUP BY nis');$st->execute([$kelas]);
            $alfa=[];foreach($st->fetchAll() as $x)$alfa[$x['nis']]=(int)$x['c'];
            $st=$db->prepare('SELECT nis, AVG(nilai) AS a FROM nilai WHERE kelas=? GROUP BY nis');$st->execute([$kelas]);
            $avg=[];foreach($st->fetchAll() as $x)$avg[$x['nis']]=round((float)$x['a'],1);
            $st=$db->prepare('SELECT nis, nama_siswa AS nama FROM siswa WHERE kelas=?');$st->execute([$kelas]);
            $res=[];
            foreach($st->fetchAll() as $s){$a=$alfa[$s['nis']]??0;$v=$avg[$s['nis']]??null;$m=[];if($a>3)$m[]='Alfa '.$a.'x';if($v!==null&&$v<70)$m[]='Rata-rata '.$v;if($m)$res[]=['nis'=>$s['nis'],'nama'=>$s['nama'],'alfa'=>$a,'avg'=>$v,'masalah'=>implode(' | ',$m)];}
            success($res);
            break;

        // ===================== GURU INFO =====================
        case 'guru-info':
            if ($method !== 'GET') error('Method not allowed', 405);
            $nip=getParam('nip');if(!$nip)error('Parameter nip wajib diisi');
            $db=getDB();
            $st=$db->prepare('SELECT nip, nama_guru, nama_guru AS nama, mapel, kelas_diampu FROM guru WHERE nip=?');$st->execute([$nip]);$info=$st->fetch();
            if(!$info){$u=$db->prepare('SELECT nama_lengkap FROM users WHERE username=?');$u->execute([$nip]);$ur=$u->fetch();if($ur)$info=['nip'=>$nip,'nama_guru'=>$ur['nama_lengkap'],'nama'=>$ur['nama_lengkap'],'mapel'=>'','kelas_diampu'=>''];}
            $set=[];
            if(!empty($info['kelas_diampu']))foreach(explode(',',$info['kelas_diampu']) as $k){$k=trim($k);if($k!=='')$set[$k]=true;}
            $st=$db->prepare('SELECT DISTINCT kelas FROM jadwal_pelajaran WHERE nip=?');$st->execute([$nip]);
            foreach($st->fetchAll() as $x)$set[$x['kelas']]=true;
            success(['info'=>$info,'kelasDiampu'=>array_keys($set)]);
            break;

        case 'guru-add-kelas':
            if ($method !== 'POST') error('Method not allowed', 405);
            $body=getBody();$nip=$body['nip']??getParam('nip');$kelas=$body['kelas']??getParam('kelas');
            if(!$nip||!$kelas)error('nip dan kelas wajib diisi');
            $db=getDB();
            $st=$db->prepare('SELECT id, kelas_diampu FROM guru WHERE nip=?');$st->execute([$nip]);$g=$st->fetch();
            if($g){$ex=array_filter(array_map('trim',explode(',',$g['kelas_diampu']??'')));if(!in_array($kelas,$ex)){$ex[]=$kelas;$db->prepare('UPDATE guru SET kelas_diampu=? WHERE nip=?')->execute([implode(',',$ex),$nip]);}}
            else $db->prepare('INSERT INTO guru (nip,nama_guru,mapel,kelas_diampu) VALUES (?,?,?,?)')->execute([$nip,'','',$kelas]);
            success(null,'Kelas '.$kelas.' ditambahkan');
            break;

        case 'mapel-guru-kelas':
            if ($method !== 'GET') error('Method not allowed', 405);
            $nip=getParam('nip');$kelas=getParam('kelas');
            if(!$nip||!$kelas)error('nip dan kelas wajib diisi');
            $db=getDB();
            $st=$db->prepare('SELECT DISTINCT mata_pelajaran AS mapel FROM jadwal_pelajaran WHERE nip=? AND kelas=?');$st->execute([$nip,$kelas]);
            success(array_column($st->fetchAll(),'mapel'));
            break;

        case 'wali-kelas':
            if ($method !== 'GET') error('Method not allowed', 405);
            $kelas=getParam('kelas');if(!$kelas)error('Parameter kelas wajib diisi');
            $db=getDB();$st=$db->prepare("SELECT nama_lengkap AS nama FROM users WHERE role='Walikelas' AND kelas=? LIMIT 1");$st->execute([$kelas]);$r=$st->fetch();
            success(['nama'=>$r?$r['nama']:'-']);
            break;

        case 'wali-kelas-all':
            // ✅ FIX ANTI-LAG: batch semua wali kelas sekaligus (1 query) untuk cache PDF
            if ($method !== 'GET') error('Method not allowed', 405);
            $db=getDB();
            $st=$db->prepare("SELECT kelas, nama_lengkap AS nama FROM users WHERE role='Walikelas' AND kelas IS NOT NULL AND kelas<>''");
            $st->execute();
            success($st->fetchAll());
            break;

        case 'siswa-options':
            if ($method !== 'GET') error('Method not allowed', 405);
            $kelas=getParam('kelas');if(!$kelas)error('Parameter kelas wajib diisi');
            $db=getDB();$st=$db->prepare('SELECT nis, nama_siswa AS nama FROM siswa WHERE kelas=? ORDER BY nama_siswa');$st->execute([$kelas]);
            success($st->fetchAll());
            break;

        // ===================== SISWA (AUTO-CREATE USER DENGAN HASH) =====================
        case 'siswa':
            $body=getBody();$kelas=getParam('kelas')?:($body['kelas']??'');$db=getDB();
            if(!$kelas&&in_array($method,['GET','POST']))error('Parameter kelas wajib diisi');
            
            if($method==='GET'){
                $st=$db->prepare('SELECT id AS row, nis, nama_siswa AS nama, kelas, jk, ttl, alamat, no_wa AS noWa, ekstra, nama_ayah AS namaAyah, nama_ibu AS namaIbu, kerja_ayah AS kerjaAyah, kerja_ibu AS kerjaIbu, penghasilan_ortu AS penghasilanOrtu FROM siswa WHERE kelas=? ORDER BY nama_siswa');
                $st->execute([$kelas]);success($st->fetchAll());
            }
            elseif($method==='POST'){
                $nis=$body['nis']??'';$nama=$body['nama']??'';$jk=$body['jk']??'L';
                if(!$nis||!$nama)error('NIS dan Nama wajib diisi');
                $sf=_siswaFields($body);

                // Insert ke tabel siswa (termasuk profil & data ortu)
                $db->prepare('INSERT INTO siswa (nis,nama_siswa,kelas,jk,ttl,alamat,no_wa,ekstra,nama_ayah,nama_ibu,kerja_ayah,kerja_ibu,penghasilan_ortu) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)')
                   ->execute([$nis,$nama,$kelas,$jk,$sf['ttl'],$sf['alamat'],$sf['no_wa'],$sf['ekstra'],$sf['nama_ayah'],$sf['nama_ibu'],$sf['kerja_ayah'],$sf['kerja_ibu'],$sf['penghasilan_ortu']]);
                
                // ✅ AUTO-CREATE USER dengan password HASH
                $ck=$db->prepare('SELECT id FROM users WHERE username=?');
                $ck->execute([$nis]);
                if(!$ck->fetch()){
                    $hashSiswa = password_hash('siswa123', PASSWORD_DEFAULT);
                    $db->prepare("INSERT INTO users (username,password,role,kelas,nama_lengkap,nip) VALUES (?,?,?,?,?,?)")
                       ->execute([$nis, $hashSiswa, 'Siswa', $kelas, $nama, '']);
                }
                success(null,'Siswa ditambahkan (+akun login: '.$nis.' / siswa123)');
            }
            elseif($method==='PUT'){
                $old=$body['oldNis']??'';$nis=$body['nis']??'';$nama=$body['nama']??'';$jk=$body['jk']??'L';$k=$kelas?:($body['kelas']??'');
                $sf=_siswaFields($body);

                // Update tabel siswa (termasuk profil & data ortu)
                $db->prepare('UPDATE siswa SET nis=?,nama_siswa=?,jk=?,ttl=?,alamat=?,no_wa=?,ekstra=?,nama_ayah=?,nama_ibu=?,kerja_ayah=?,kerja_ibu=?,penghasilan_ortu=? WHERE nis=? AND kelas=?')
                   ->execute([$nis,$nama,$jk,$sf['ttl'],$sf['alamat'],$sf['no_wa'],$sf['ekstra'],$sf['nama_ayah'],$sf['nama_ibu'],$sf['kerja_ayah'],$sf['kerja_ibu'],$sf['penghasilan_ortu'],$old,$k]);
                
                // ✅ Update juga akun user
                if($old!==$nis){
                    $db->prepare("UPDATE users SET username=?,nama_lengkap=?,kelas=? WHERE username=? AND role='Siswa'")
                       ->execute([$nis,$nama,$k,$old]);
                } else {
                    $db->prepare("UPDATE users SET nama_lengkap=?,kelas=? WHERE username=? AND role='Siswa'")
                       ->execute([$nama,$k,$nis]);
                }
                success(null,'Siswa diperbarui (+akun ikut terupdate)');
            }
            elseif($method==='DELETE'){
                $nis=getParam('nis')?:($body['nis']??'');$k=$kelas?:($body['kelas']??'');
                
                // Hapus dari siswa
                if($k)$db->prepare('DELETE FROM siswa WHERE nis=? AND kelas=?')->execute([$nis,$k]);
                else $db->prepare('DELETE FROM siswa WHERE nis=?')->execute([$nis]);
                
                // ✅ Hapus juga akun user
                $db->prepare("DELETE FROM users WHERE username=? AND role='Siswa'")
                   ->execute([$nis]);
                success(null,'Siswa & akun login dihapus');
            } else error('Method not allowed',405);
            break;

        case 'siswa-import':
            if ($method !== 'POST') error('Method not allowed', 405);
            $body=getBody();$kelas=$body['kelas']??getParam('kelas');
            if(!$kelas)error('Parameter kelas wajib diisi');
            $data=$body['data']??[];$db=getDB();$ins=0;$skip=0;
            
            $exN=[];foreach($db->query('SELECT nis FROM siswa')->fetchAll() as $x)$exN[$x['nis']]=true;
            $exU=[];foreach($db->query('SELECT username FROM users')->fetchAll() as $x)$exU[$x['username']]=true;
            
            // ✅ HASH password default SEKALI di awal (efisien untuk bulk)
            $hashSiswa = password_hash('siswa123', PASSWORD_DEFAULT);
            
            $db->beginTransaction();
            try{
                $si=$db->prepare('INSERT INTO siswa (nis,nama_siswa,kelas,jk,ttl,alamat,no_wa,ekstra,nama_ayah,nama_ibu,kerja_ayah,kerja_ibu,penghasilan_ortu) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)');
                $ui=$db->prepare("INSERT INTO users (username,password,role,kelas,nama_lengkap,nip) VALUES (?,?,?,?,?,?)");
                
                foreach($data as $r){
                    $nis=trim((string)($r['nis']??''));
                    $nama=trim((string)($r['nama']??''));
                    $jk=strtoupper(trim((string)($r['jk']??'L')));
                    if($jk!=='L'&&$jk!=='P')$jk='L';
                    $sf=_siswaFields($r);

                    if(!$nis||!$nama||isset($exN[$nis])){$skip++;continue;}

                    // Insert ke siswa (termasuk profil & data ortu)
                    $si->execute([$nis,$nama,$kelas,$jk,$sf['ttl'],$sf['alamat'],$sf['no_wa'],$sf['ekstra'],$sf['nama_ayah'],$sf['nama_ibu'],$sf['kerja_ayah'],$sf['kerja_ibu'],$sf['penghasilan_ortu']]);
                    $exN[$nis]=true;$ins++;
                    
                    // ✅ Auto-create user dengan HASH password
                    if(!isset($exU[$nis])){
                        $ui->execute([$nis, $hashSiswa, 'Siswa', $kelas, $nama, '']);
                        $exU[$nis]=true;
                    }
                }
                $db->commit();
            }catch(Exception $e){$db->rollBack();error('Error: '.$e->getMessage());}
            
            success(['inserted'=>$ins,'skipped'=>$skip],
                'Import '.$ins.' siswa (+akun login otomatis: NIS/siswa123)'.($skip?' ('.$skip.' dilewati)':''));
            break;

        // ===================== KEHADIRAN =====================
        case 'kehadiran':
            $body=getBody();$kelas=getParam('kelas')?:($body['kelas']??'');$tgl=getParam('tanggal')?:($body['tanggal']??'');$db=getDB();
            if(!$kelas&&in_array($method,['GET','POST']))error('Parameter kelas wajib diisi');
            
            if($method==='GET'){
                if(!$tgl)error('Parameter tanggal wajib diisi');
                $st=$db->prepare('SELECT id AS row, tanggal, nis, status, keterangan FROM kehadiran WHERE kelas=? AND tanggal=? ORDER BY nis');
                $st->execute([$kelas,$tgl]);success($st->fetchAll());
            }
            elseif($method==='POST'){
                if(!$tgl)error('Parameter tanggal wajib diisi');
                $recs=$body['records']??[];
                $db->beginTransaction();
                try{
                    $db->prepare('DELETE FROM kehadiran WHERE tanggal=? AND kelas=?')->execute([$tgl,$kelas]);
                    $in=$db->prepare('INSERT INTO kehadiran (tanggal,nis,kelas,status,keterangan) VALUES (?,?,?,?,?)');
                    foreach($recs as $r)$in->execute([$tgl,$r['nis'],$kelas,$r['status'],$r['keterangan']??'']);
                    $db->commit();
                    success(null,'Kehadiran disimpan ('.count($recs).')');
                }catch(Exception $e){$db->rollBack();error('Error: '.$e->getMessage());}
            } else error('Method not allowed',405);
            break;

        // ===================== TATIB / KAS / STRUKTUR / INVENTARIS / PENGUMUMAN =====================
        case 'tatatertib':
            $body=getBody();$kelas=getParam('kelas')?:($body['kelas']??'');$db=getDB();
            if(!$kelas&&in_array($method,['GET','POST']))error('Parameter kelas wajib diisi');
            if($method==='GET'){$st=$db->prepare('SELECT id AS row, tanggal, nis, pelanggaran, poin, kelas FROM tatatertib WHERE kelas=? ORDER BY tanggal DESC, id DESC');$st->execute([$kelas]);success($st->fetchAll());}
            elseif($method==='POST'){$db->prepare('INSERT INTO tatatertib (tanggal,nis,pelanggaran,poin,kelas) VALUES (?,?,?,?,?)')->execute([$body['tanggal'],$body['nis'],$body['pelanggaran'],$body['poin'],$kelas]);success(null,'Ditambahkan');}
            elseif($method==='DELETE'){$id=getParam('id')?:($body['id']??'');$db->prepare('DELETE FROM tatatertib WHERE id=?')->execute([$id]);success(null,'Dihapus');}
            else error('Method not allowed',405);
            break;

        case 'kas':
            $body=getBody();$kelas=getParam('kelas')?:($body['kelas']??'');$db=getDB();
            if(!$kelas&&in_array($method,['GET','POST']))error('Parameter kelas wajib diisi');
            if($method==='GET'){$st=$db->prepare('SELECT id AS row, tanggal, jenis, jumlah, keterangan FROM kaskelas WHERE kelas=? ORDER BY tanggal DESC, id DESC');$st->execute([$kelas]);success($st->fetchAll());}
            elseif($method==='POST'){$db->prepare('INSERT INTO kaskelas (tanggal,kelas,jenis,jumlah,keterangan) VALUES (?,?,?,?,?)')->execute([$body['tanggal'],$kelas,$body['jenis'],$body['jumlah'],$body['keterangan']]);success(null,'Transaksi ditambahkan');}
            elseif($method==='DELETE'){$id=getParam('id')?:($body['id']??'');$db->prepare('DELETE FROM kaskelas WHERE id=?')->execute([$id]);success(null,'Dihapus');}
            else error('Method not allowed',405);
            break;

        case 'kas-summary':
            if ($method !== 'GET') error('Method not allowed', 405);
            $kelas=getParam('kelas');if(!$kelas)error('Parameter kelas wajib diisi');
            $db=getDB();$st=$db->prepare('SELECT COALESCE(SUM(CASE WHEN jenis="Masuk" THEN jumlah ELSE 0 END),0) AS m, COALESCE(SUM(CASE WHEN jenis="Keluar" THEN jumlah ELSE 0 END),0) AS k FROM kaskelas WHERE kelas=?');$st->execute([$kelas]);$r=$st->fetch();
            success(['totalMasuk'=>(float)$r['m'],'totalKeluar'=>(float)$r['k'],'saldo'=>(float)$r['m']-(float)$r['k']]);
            break;

        case 'struktur':
            $body=getBody();$kelas=getParam('kelas')?:($body['kelas']??'');$db=getDB();
            if(!$kelas&&in_array($method,['GET','POST']))error('Parameter kelas wajib diisi');
            if($method==='GET'){$st=$db->prepare('SELECT jabatan, nis, nama_siswa AS nama FROM struktur_kelas WHERE kelas=?');$st->execute([$kelas]);success($st->fetchAll());}
            elseif($method==='POST'){
                $arr=$body['data']??[];$db->beginTransaction();
                try{$db->prepare('DELETE FROM struktur_kelas WHERE kelas=?')->execute([$kelas]);$in=$db->prepare('INSERT INTO struktur_kelas (kelas,jabatan,nis,nama_siswa) VALUES (?,?,?,?)');foreach($arr as $r)if(!empty($r['jabatan'])&&!empty($r['nama']))$in->execute([$kelas,$r['jabatan'],$r['nis']??'',$r['nama']]);$db->commit();success(null,'Struktur disimpan');}
                catch(Exception $e){$db->rollBack();error('Error: '.$e->getMessage());}
            } else error('Method not allowed',405);
            break;

        case 'inventaris':
            $body=getBody();$kelas=getParam('kelas')?:($body['kelas']??'');$db=getDB();
            if(!$kelas&&in_array($method,['GET','POST']))error('Parameter kelas wajib diisi');
            if($method==='GET'){$st=$db->prepare('SELECT id AS row, nama_barang AS namaBarang, jumlah, kondisi, keterangan FROM inventaris WHERE kelas=?');$st->execute([$kelas]);success($st->fetchAll());}
            elseif($method==='POST'){$db->prepare('INSERT INTO inventaris (kelas,nama_barang,jumlah,kondisi,keterangan,tanggal) VALUES (?,?,?,?,?,?)')->execute([$kelas,$body['nama'],$body['jumlah'],$body['kondisi'],$body['keterangan'],date('Y-m-d')]);success(null,'Ditambahkan');}
            elseif($method==='DELETE'){$id=getParam('id')?:($body['id']??'');$db->prepare('DELETE FROM inventaris WHERE id=?')->execute([$id]);success(null,'Dihapus');}
            else error('Method not allowed',405);
            break;

        case 'pengumuman':
            $body=getBody();$kelas=getParam('kelas')?:($body['kelas']??'');$db=getDB();
            if(!$kelas&&in_array($method,['GET','POST']))error('Parameter kelas wajib diisi');
            if($method==='GET'){$st=$db->prepare('SELECT id AS row, judul, isi, tanggal, penulis FROM pengumuman WHERE kelas=? ORDER BY tanggal DESC, id DESC');$st->execute([$kelas]);success($st->fetchAll());}
            elseif($method==='POST'){$db->prepare('INSERT INTO pengumuman (kelas,judul,isi,tanggal,penulis) VALUES (?,?,?,?,?)')->execute([$kelas,$body['judul'],$body['isi'],date('Y-m-d'),$body['penulis']]);success(null,'Pengumuman dipublikasikan');}
            elseif($method==='DELETE'){$id=getParam('id')?:($body['id']??'');$db->prepare('DELETE FROM pengumuman WHERE id=?')->execute([$id]);success(null,'Dihapus');}
            else error('Method not allowed',405);
            break;

        // ===================== JADWAL =====================
        case 'jadwal':
            $body=getBody();$kelas=getParam('kelas')?:($body['kelas']??'');$db=getDB();
            if(!$kelas&&in_array($method,['GET','POST']))error('Parameter kelas wajib diisi');
            if($method==='GET'){$st=$db->prepare('SELECT id AS row, hari, jam_ke AS jamKe, mata_pelajaran AS mapel, nip AS kg FROM jadwal_pelajaran WHERE kelas=? ORDER BY FIELD(hari,"Senin","Selasa","Rabu","Kamis","Jumat","Sabtu","Minggu"), jam_ke');$st->execute([$kelas]);success($st->fetchAll());}
            elseif($method==='POST'){$db->prepare('INSERT INTO jadwal_pelajaran (kelas,hari,jam_ke,mata_pelajaran,nip) VALUES (?,?,?,?,?)')->execute([$kelas,$body['hari'],$body['jam'],$body['mapel'],$body['nip']??'']);success(null,'Jadwal ditambahkan');}
            elseif($method==='PUT'){$id=$body['id']??getParam('id');$db->prepare('UPDATE jadwal_pelajaran SET kelas=?, hari=?, jam_ke=?, mata_pelajaran=?, nip=? WHERE id=?')->execute([$body['kelas'],$body['hari'],$body['jam'],$body['mapel'],$body['nip']??'',$id]);success(null,'Jadwal diperbarui');}
            elseif($method==='DELETE'){$id=getParam('id')?:($body['id']??'');$db->prepare('DELETE FROM jadwal_pelajaran WHERE id=?')->execute([$id]);success(null,'Dihapus');}
            else error('Method not allowed',405);
            break;

        case 'jadwal-mengajar':
            if ($method !== 'GET') error('Method not allowed', 405);
            $nip=getParam('nip');if(!$nip)error('Parameter nip wajib diisi');
            $db=getDB();$hari=['Minggu','Senin','Selasa','Rabu','Kamis','Jumat','Sabtu'][date('w')];
            $st=$db->prepare('SELECT kelas, jam_ke AS jamKe, mata_pelajaran AS mapel FROM jadwal_pelajaran WHERE nip=? AND hari=? ORDER BY jam_ke');$st->execute([$nip,$hari]);
            success($st->fetchAll());
            break;

        case 'jadwal-by-guru':
            if ($method !== 'GET') error('Method not allowed', 405);
            $nip=getParam('nip');if(!$nip)error('Parameter nip wajib diisi');
            $db=getDB();
            $st=$db->prepare('SELECT id AS row, kelas, hari, jam_ke AS jamKe, mata_pelajaran AS mapel FROM jadwal_pelajaran WHERE nip=? ORDER BY FIELD(hari,"Senin","Selasa","Rabu","Kamis","Jumat","Sabtu","Minggu"), jam_ke');
            $st->execute([$nip]);
            success($st->fetchAll());
            break;

        case 'jadwal-piket':
            $body=getBody();$kelas=getParam('kelas')?:($body['kelas']??'');$db=getDB();
            if(!$kelas&&in_array($method,['GET','POST']))error('Parameter kelas wajib diisi');
            if($method==='GET'){$st=$db->prepare('SELECT id AS row, hari, nis, nama_siswa AS nama FROM jadwal_piket WHERE kelas=?');$st->execute([$kelas]);success($st->fetchAll());}
            elseif($method==='POST'){
                $hari=$body['hari']??getParam('hari');if(!$hari)error('Parameter hari wajib diisi');
                $students=$body['students']??[];$db->beginTransaction();
                try{$db->prepare('DELETE FROM jadwal_piket WHERE kelas=? AND hari=?')->execute([$kelas,$hari]);$in=$db->prepare('INSERT INTO jadwal_piket (kelas,hari,nis,nama_siswa) VALUES (?,?,?,?)');foreach($students as $s)if(!empty($s['nama']))$in->execute([$kelas,$hari,$s['nis']??'',$s['nama']]);$db->commit();success(null,'Piket '.$hari.' disimpan');}
                catch(Exception $e){$db->rollBack();error('Error: '.$e->getMessage());}
            } else error('Method not allowed',405);
            break;

        // ===================== BIMBINGAN / KUNJUNGAN =====================
        case 'jurnal-bimbingan':
            $body=getBody();$kelas=getParam('kelas')?:($body['kelas']??'');$db=getDB();
            if(!$kelas&&in_array($method,['GET','POST']))error('Parameter kelas wajib diisi');
            if($method==='GET'){$st=$db->prepare('SELECT id AS row, tanggal, kategori, isi, tindak_lanjut AS tindakLanjut FROM jurnal_bimbingan WHERE kelas=? ORDER BY tanggal DESC, id DESC');$st->execute([$kelas]);success($st->fetchAll());}
            elseif($method==='POST'){$db->prepare('INSERT INTO jurnal_bimbingan (tanggal,kelas,kategori,isi,tindak_lanjut) VALUES (?,?,?,?,?)')->execute([$body['tanggal'],$kelas,$body['kategori'],$body['isi'],$body['tindakLanjut']??'']);success(null,'Bimbingan dicatat');}
            elseif($method==='DELETE'){$id=getParam('id')?:($body['id']??'');$db->prepare('DELETE FROM jurnal_bimbingan WHERE id=?')->execute([$id]);success(null,'Dihapus');}
            else error('Method not allowed',405);
            break;

        case 'kunjungan-rumah':
            $body=getBody();$kelas=getParam('kelas')?:($body['kelas']??'');$db=getDB();
            if(!$kelas&&in_array($method,['GET','POST']))error('Parameter kelas wajib diisi');
            if($method==='GET'){$st=$db->prepare('SELECT id AS row, tanggal, nis, nama_siswa AS nama, alamat, hasil, tindak_lanjut AS tl, petugas FROM kunjungan_rumah WHERE kelas=? ORDER BY tanggal DESC, id DESC');$st->execute([$kelas]);success($st->fetchAll());}
            elseif($method==='POST'){$nv=explode('|',(string)($body['nisNama']??''));$db->prepare('INSERT INTO kunjungan_rumah (tanggal,nis,kelas,nama_siswa,alamat,hasil,tindak_lanjut,petugas) VALUES (?,?,?,?,?,?,?,?)')->execute([$body['tanggal'],$nv[0]??'',$kelas,$nv[1]??'',$body['alamat']??'',$body['hasil']??'',$body['tindakLanjut']??'',$body['petugas']??'']);success(null,'Kunjungan dicatat');}
            elseif($method==='DELETE'){$id=getParam('id')?:($body['id']??'');$db->prepare('DELETE FROM kunjungan_rumah WHERE id=?')->execute([$id]);success(null,'Dihapus');}
            else error('Method not allowed',405);
            break;

        // ===================== JURNAL MENGAJAR =====================
        case 'jurnal-mengajar':
            $body=getBody();$db=getDB();
            if($method==='GET'){
                $nip=getParam('nip');if(!$nip)error('Parameter nip wajib diisi');
                $sql='SELECT id AS row, tanggal, kelas, mapel, jam_ke AS jamKe, materi, kegiatan FROM jurnal_mengajar WHERE nip=?';$p=[$nip];
                if(getParam('tanggal')){$sql.=' AND tanggal=?';$p[]=getParam('tanggal');}
                $sql.=' ORDER BY tanggal DESC, id DESC';
                $st=$db->prepare($sql);$st->execute($p);success($st->fetchAll());
            }
            elseif($method==='POST'){
                $nip=$body['nip']??getParam('nip');if(!$nip)error('Parameter nip wajib diisi');
                $db->prepare('INSERT INTO jurnal_mengajar (tanggal,kelas,nip,mapel,jam_ke,materi,kegiatan) VALUES (?,?,?,?,?,?,?)')->execute([$body['tanggal'],$body['kelas'],$nip,$body['mapel'],$body['jam'],$body['materi'],$body['kegiatan']??'']);
                success(null,'Jurnal disimpan');
            }
            elseif($method==='DELETE'){$nip=$body['nip']??getParam('nip');$id=getParam('id')?:($body['id']??'');$db->prepare('DELETE FROM jurnal_mengajar WHERE id=? AND nip=?')->execute([$id,$nip]);success(null,'Dihapus');}
            else error('Method not allowed',405);
            break;

        // ===================== PRESENSI MAPEL =====================
        case 'presensi-mapel':
            $body=getBody();$db=getDB();
            if($method==='GET'){
                $nip=getParam('nip');$kelas=getParam('kelas');$tgl=getParam('tanggal');
                if(!$nip||!$kelas||!$tgl)error('nip, kelas, tanggal wajib diisi');
                $st=$db->prepare('SELECT nis, status, mapel FROM presensi_mapel WHERE nip=? AND kelas=? AND tanggal=?');$st->execute([$nip,$kelas,$tgl]);
                success($st->fetchAll());
            }
            elseif($method==='POST'){
                $nip=$body['nip']??'';$kelas=$body['kelas']??'';$mapel=$body['mapel']??'';$tgl=$body['tanggal']??'';$recs=$body['records']??[];
                $jamKe=isset($body['jamKe'])&&$body['jamKe']!==''?(int)$body['jamKe']:null;
                if(!$nip||!$kelas||!$mapel||!$tgl)error('nip, kelas, mapel, tanggal wajib diisi');
                $db->beginTransaction();
                try{
                    $db->prepare('DELETE FROM presensi_mapel WHERE nip=? AND kelas=? AND tanggal=? AND mapel=?')->execute([$nip,$kelas,$tgl,$mapel]);
                    try{
                        $in=$db->prepare('INSERT INTO presensi_mapel (tanggal,kelas,nis,nip,mapel,status,jam_ke,created_at) VALUES (?,?,?,?,?,?,?,NOW())');
                        foreach($recs as $r)$in->execute([$tgl,$kelas,$r['nis'],$nip,$mapel,$r['status'],$jamKe]);
                    }catch(PDOException $e){
                        $in=$db->prepare('INSERT INTO presensi_mapel (tanggal,kelas,nis,nip,mapel,status) VALUES (?,?,?,?,?,?)');
                        foreach($recs as $r)$in->execute([$tgl,$kelas,$r['nis'],$nip,$mapel,$r['status']]);
                    }
                    $db->commit();
                    success(null,'Presensi '.count($recs).' siswa tersimpan pukul '.date('H:i:s').' WIB');
                }catch(Exception $e){$db->rollBack();error('Error: '.$e->getMessage());}
            }
            elseif($method==='PUT'){
                $updates=$body['updates']??[];if(!$updates)error('Tidak ada baris untuk diperbarui');
                $n=0;
                foreach($updates as $u){
                    if(!isset($u['id'],$u['status']))continue;
                    try{$db->prepare('UPDATE presensi_mapel SET status=?, updated_at=NOW() WHERE id=?')->execute([$u['status'],$u['id']]);}
                    catch(PDOException $e){$db->prepare('UPDATE presensi_mapel SET status=? WHERE id=?')->execute([$u['status'],$u['id']]);}
                    $n++;
                }
                success(null,$n.' baris presensi diperbarui ('.date('H:i:s').' WIB)');
            }
            else error('Method not allowed',405);
            break;

        case 'presensi-riwayat':
            if ($method !== 'GET') error('Method not allowed', 405);
            $nip=getParam('nip');if(!$nip)error('Parameter nip wajib diisi');
            $tanggal=getParam('tanggal');$kelasF=getParam('kelas');
            $db=getDB();
            $base=' FROM presensi_mapel p LEFT JOIN siswa s ON s.nis=p.nis LEFT JOIN jurnal_mengajar j ON j.nip=p.nip AND j.tanggal=p.tanggal AND j.kelas=p.kelas AND j.mapel=p.mapel WHERE p.nip=?';
            $p=[$nip];
            if($tanggal){$base.=' AND p.tanggal=?';$p[]=$tanggal;}
            if($kelasF){$base.=' AND p.kelas=?';$p[]=$kelasF;}
            $tail=' ORDER BY p.tanggal DESC, p.kelas, j.jam_ke, s.nama_siswa';
            $selNew='SELECT p.id, p.tanggal, p.kelas, p.mapel, p.nis, p.status, s.nama_siswa AS nama, j.jam_ke AS jamKe, p.created_at AS createdAt, p.updated_at AS updatedAt';
            $selOld='SELECT p.id, p.tanggal, p.kelas, p.mapel, p.nis, p.status, s.nama_siswa AS nama, j.jam_ke AS jamKe, NULL AS createdAt, NULL AS updatedAt';
            try{$st=$db->prepare($selNew.$base.$tail);$st->execute($p);}
            catch(PDOException $e){$st=$db->prepare($selOld.$base.$tail);$st->execute($p);}
            $rows=$st->fetchAll();
            $sessions=[];$order=[];
            foreach($rows as $r){
                $key=$r['tanggal'].'|'.$r['kelas'].'|'.$r['mapel'];
                if(!isset($sessions[$key])){$sessions[$key]=['tanggal'=>$r['tanggal'],'kelas'=>$r['kelas'],'mapel'=>$r['mapel'],'jamKe'=>$r['jamKe'],'createdAt'=>$r['createdAt'],'updatedAt'=>null,'summary'=>['Hadir'=>0,'Sakit'=>0,'Izin'=>0,'Alfa'=>0,'Dispensasi'=>0],'students'=>[]];$order[]=$key;}
                if(isset($sessions[$key]['summary'][$r['status']]))$sessions[$key]['summary'][$r['status']]++;
                if(!empty($r['updatedAt'])&&(empty($sessions[$key]['updatedAt'])||$r['updatedAt']>$sessions[$key]['updatedAt']))$sessions[$key]['updatedAt']=$r['updatedAt'];
                $sessions[$key]['students'][]=['id'=>$r['id'],'nis'=>$r['nis'],'nama'=>$r['nama']??$r['nis'],'status'=>$r['status'],'updatedAt'=>$r['updatedAt']];
            }
            $out=array_map(function($k)use($sessions){return $sessions[$k];},$order);
            if(!$tanggal&&!$kelasF)$out=array_slice($out,0,30);
            success($out);
            break;

        // ===================== NILAI =====================
        case 'nilai':
            $body=getBody();$db=getDB();
            if($method==='GET'){
                $nip=getParam('nip');if(!$nip)error('Parameter nip wajib diisi');
                $kelas=getParam('kelas');
                if($kelas){$st=$db->prepare('SELECT id AS row, nis, kelas, mapel, jenis, nilai, tanggal FROM nilai WHERE nip=? AND kelas=?');$st->execute([$nip,$kelas]);}
                else{$st=$db->prepare('SELECT id AS row, nis, kelas, mapel, jenis, nilai, tanggal FROM nilai WHERE nip=?');$st->execute([$nip]);}
                success($st->fetchAll());
            }
            elseif($method==='POST'){$nip=$body['nip']??'';if(!$nip)error('Parameter nip wajib diisi');$db->prepare('INSERT INTO nilai (nis,kelas,nip,mapel,jenis,nilai,tanggal) VALUES (?,?,?,?,?,?,?)')->execute([$body['nis'],$body['kelas'],$nip,$body['mapel'],$body['jenis'],$body['nilai'],date('Y-m-d')]);success(null,'Nilai disimpan');}
            elseif($method==='DELETE'){$nip=$body['nip']??getParam('nip');$id=getParam('id')?:($body['id']??'');if($nip)$db->prepare('DELETE FROM nilai WHERE id=? AND nip=?')->execute([$id,$nip]);else $db->prepare('DELETE FROM nilai WHERE id=?')->execute([$id]);success(null,'Dihapus');}
            else error('Method not allowed',405);
            break;

        case 'nilai-bulk':
            if ($method !== 'POST') error('Method not allowed', 405);
            $body=getBody();$db=getDB();
            $nip=$body['nip']??'';$kelas=$body['kelas']??'';$mapel=$body['mapel']??'';$entries=$body['entries']??[];
            if(!$nip||!$kelas||!$mapel)error('nip, kelas, mapel wajib diisi');
            $db->beginTransaction();
            try{
                $seen=[];foreach($entries as $e)$seen[$e['nis']]=true;
                $del=$db->prepare('DELETE FROM nilai WHERE nip=? AND kelas=? AND mapel=? AND nis=?');
                foreach(array_keys($seen) as $n)$del->execute([$nip,$kelas,$mapel,$n]);
                $in=$db->prepare('INSERT INTO nilai (nis,kelas,nip,mapel,jenis,nilai,tanggal) VALUES (?,?,?,?,?,?,?)');
                foreach($entries as $e)if($e['nilai']!==''&&$e['nilai']!==null)$in->execute([$e['nis'],$kelas,$nip,$mapel,$e['jenis'],$e['nilai'],date('Y-m-d')]);
                $db->commit();success(null,'Nilai tersimpan');
            }catch(Exception $e){$db->rollBack();error('Error: '.$e->getMessage());}
            break;

        case 'nilai-rekap':
            if ($method !== 'GET') error('Method not allowed', 405);
            $nip=getParam('nip');$kelas=getParam('kelas');$mapel=getParam('mapel');
            if(!$nip||!$kelas)error('nip dan kelas wajib diisi');
            $db=getDB();
            $st=$db->prepare('SELECT nis, nama_siswa AS nama FROM siswa WHERE kelas=? ORDER BY nama_siswa');$st->execute([$kelas]);$siswa=$st->fetchAll();
            $sql='SELECT nis, jenis, nilai FROM nilai WHERE nip=? AND kelas=?';$p=[$nip,$kelas];
            if($mapel){$sql.=' AND mapel=?';$p[]=$mapel;}
            $st=$db->prepare($sql);$st->execute($p);
            $map=[];foreach($st->fetchAll() as $n)$map[$n['nis']][$n['jenis']]=(float)$n['nilai'];
            $jenisList=['NH1','NH2','NH3','NH4','NH5','NH6','NH7','NH8','PSTS','PSAS'];
            $res=[];
            foreach($siswa as $s){
                $row=['nis'=>$s['nis'],'nama'=>$s['nama']];$vals=[];
                foreach($jenisList as $j){$v=$map[$s['nis']][$j]??null;$row[$j]=$v;if($v!==null)$vals[]=$v;}
                $row['akhir']=$vals?round(array_sum($vals)/count($vals),1):null;
                $res[]=$row;
            }
            success(['students'=>$res,'mapel'=>$mapel,'kelas'=>$kelas]);
            break;

        case 'nilai-peringkat':
            if ($method !== 'GET') error('Method not allowed', 405);
            $nip=getParam('nip');$kelas=getParam('kelas');$mapel=getParam('mapel');
            if(!$nip||!$kelas)error('nip dan kelas wajib diisi');
            $db=getDB();
            $st=$db->prepare('SELECT nis, nama_siswa AS nama FROM siswa WHERE kelas=?');$st->execute([$kelas]);$siswa=$st->fetchAll();
            $sql='SELECT nis, nilai FROM nilai WHERE nip=? AND kelas=?';$p=[$nip,$kelas];
            if($mapel){$sql.=' AND mapel=?';$p[]=$mapel;}
            $st=$db->prepare($sql);$st->execute($p);
            $map=[];foreach($st->fetchAll() as $n)$map[$n['nis']][]=(float)$n['nilai'];
            $res=[];
            foreach($siswa as $s){$vals=$map[$s['nis']]??[];$avg=$vals?array_sum($vals)/count($vals):0;if($avg>0)$res[]=['nis'=>$s['nis'],'nama'=>$s['nama'],'avg'=>round($avg,1)];}
            usort($res,function($a,$b){return $b['avg']<=>$a['avg'];});
            foreach($res as $i=>&$r)$r['rank']=$i+1;
            success($res);
            break;

        case 'analisis-nilai':
            if ($method !== 'GET') error('Method not allowed', 405);
            $nip=getParam('nip');$kelas=getParam('kelas');$mapel=getParam('mapel');$kkm=(float)(getParam('kkm')?:75);
            if(!$nip||!$kelas)error('nip dan kelas wajib diisi');
            $db=getDB();
            $st=$db->prepare('SELECT nis, nama_siswa AS nama FROM siswa WHERE kelas=? ORDER BY nama_siswa');$st->execute([$kelas]);$siswa=$st->fetchAll();
            $sql='SELECT nis, nilai FROM nilai WHERE nip=? AND kelas=?';$p=[$nip,$kelas];
            if($mapel){$sql.=' AND mapel=?';$p[]=$mapel;}
            $st=$db->prepare($sql);$st->execute($p);
            $sums=[];$cnts=[];
            foreach($st->fetchAll() as $n){$sums[$n['nis']]=($sums[$n['nis']]??0)+(float)$n['nilai'];$cnts[$n['nis']]=($cnts[$n['nis']]??0)+1;}
            $students=[];
            foreach($siswa as $s)if(isset($cnts[$s['nis']])&&$cnts[$s['nis']]>0)$students[]=['nis'=>$s['nis'],'nama'=>$s['nama'],'avg'=>round($sums[$s['nis']]/$cnts[$s['nis']],1)];
            if(!count($students)){success(['rataRata'=>null,'tertinggi'=>null,'terendah'=>null,'ketuntasan'=>0,'kkm'=>$kkm,'remedial'=>[],'ranking'=>[],'distribusi'=>[0,0,0,0,0],'labels'=>['<60','60-69','70-79','80-89','90-100'],'total'=>0]);break;}
            $avgs=array_column($students,'avg');
            $rata=round(array_sum($avgs)/count($avgs),1);
            $tuntas=count(array_filter($avgs,function($a)use($kkm){return $a>=$kkm;}));
            $remedial=array_values(array_filter($students,function($s)use($kkm){return $s['avg']<$kkm;}));
            $ranking=$students;usort($ranking,function($a,$b){return $b['avg']<=>$a['avg'];});
            foreach($ranking as $i=>&$r)$r['rank']=$i+1;
            $dist=[0,0,0,0,0];
            foreach($avgs as $a){if($a<60)$dist[0]++;elseif($a<70)$dist[1]++;elseif($a<80)$dist[2]++;elseif($a<90)$dist[3]++;else $dist[4]++;}
            success(['rataRata'=>$rata,'tertinggi'=>max($avgs),'terendah'=>min($avgs),'ketuntasan'=>round($tuntas/count($avgs)*100),'kkm'=>$kkm,'remedial'=>$remedial,'ranking'=>$ranking,'distribusi'=>$dist,'labels'=>['<60','60-69','70-79','80-89','90-100'],'total'=>count($students)]);
            break;

        // ===================== MY DATA / ORTU =====================
        case 'my-data':
            if ($method !== 'GET') error('Method not allowed', 405);
            $kelas=getParam('kelas');$nis=getParam('nis');if(!$kelas||!$nis)error('kelas dan nis wajib diisi');
            $db=getDB();$hari=['Minggu','Senin','Selasa','Rabu','Kamis','Jumat','Sabtu'][date('w')];
            $st=$db->prepare('SELECT nis, nama_siswa AS nama, kelas, jk FROM siswa WHERE nis=?');$st->execute([$nis]);$info=$st->fetch();
            $st=$db->prepare('SELECT tanggal, status, keterangan FROM kehadiran WHERE nis=? ORDER BY tanggal DESC');$st->execute([$nis]);$keh=$st->fetchAll();
            $sum=['Hadir'=>0,'Sakit'=>0,'Izin'=>0,'Alfa'=>0];foreach($keh as $k)if(isset($sum[$k['status']]))$sum[$k['status']]++;
            $st=$db->prepare('SELECT jam_ke AS jamKe, mata_pelajaran AS mapel, nip AS guru FROM jadwal_pelajaran WHERE kelas=? AND hari=? ORDER BY jam_ke');$st->execute([$kelas,$hari]);$ts=$st->fetchAll();
            $st=$db->prepare('SELECT nis, nama_siswa AS nama FROM jadwal_piket WHERE kelas=? AND hari=?');$st->execute([$kelas,$hari]);$tp=$st->fetchAll();
            $st=$db->prepare('SELECT id AS row, judul, isi, tanggal, penulis FROM pengumuman WHERE kelas=? ORDER BY tanggal DESC, id DESC LIMIT 3');$st->execute([$kelas]);$pg=$st->fetchAll();
            success(['info'=>$info,'kehadiran'=>$keh,'summary'=>$sum,'todaySchedule'=>$ts,'todayPiket'=>$tp,'pengumuman'=>$pg,'hariIni'=>$hari]);
            break;

        case 'ortu-data':
            if ($method !== 'GET') error('Method not allowed', 405);
            $nis=getParam('nis');if(!$nis)error('Parameter nis wajib diisi');
            $db=getDB();
            $st=$db->prepare('SELECT nis, nama_siswa AS nama, kelas, jk FROM siswa WHERE nis=?');$st->execute([$nis]);$info=$st->fetch();
            $st=$db->prepare('SELECT tanggal, status, keterangan FROM kehadiran WHERE nis=? ORDER BY tanggal DESC');$st->execute([$nis]);$keh=$st->fetchAll();
            $sum=['Hadir'=>0,'Sakit'=>0,'Izin'=>0,'Alfa'=>0];foreach($keh as $k)if(isset($sum[$k['status']]))$sum[$k['status']]++;
            $st=$db->prepare('SELECT mapel, jenis, nilai FROM nilai WHERE nis=?');$st->execute([$nis]);$nilai=$st->fetchAll();
            success(['info'=>$info,'kehadiran'=>$keh,'summary'=>$sum,'nilai'=>$nilai]);
            break;

        // ===================== TOOLMAN =====================
        case 'katalog-alat':
            $body=getBody();$db=getDB();
            if($method==='GET')success($db->query('SELECT id AS row, kode, nama_barang AS nama, spesifikasi, jumlah, kondisi, lokasi FROM katalog_alat')->fetchAll());
            elseif($method==='POST'){$db->prepare('INSERT INTO katalog_alat (kode,nama_barang,spesifikasi,jumlah,kondisi,lokasi) VALUES (?,?,?,?,?,?)')->execute([$body['kode'],$body['nama'],$body['spesifikasi'],$body['jumlah'],$body['kondisi'],$body['lokasi']]);success(null,'Alat ditambahkan');}
            elseif($method==='DELETE'){$id=getParam('id')?:($body['id']??'');$db->prepare('DELETE FROM katalog_alat WHERE id=?')->execute([$id]);success(null,'Dihapus');}
            else error('Method not allowed',405);
            break;

        case 'bahan-praktik':
            $body=getBody();$db=getDB();
            if($method==='GET'){$rows=$db->query('SELECT id AS row, kode, nama_bahan AS nama, satuan, stok, stok_min AS stokMin, kategori FROM bahan_praktik')->fetchAll();foreach($rows as &$r){$r['stok']=(float)$r['stok'];$r['stokMin']=(float)$r['stokMin'];$r['lowStock']=$r['stok']<=$r['stokMin'];}success($rows);}
            elseif($method==='POST'){$db->prepare('INSERT INTO bahan_praktik (kode,nama_bahan,satuan,stok,stok_min,kategori) VALUES (?,?,?,?,?,?)')->execute([$body['kode'],$body['nama'],$body['satuan'],$body['stok'],$body['stokMin'],$body['kategori']]);success(null,'Bahan ditambahkan');}
            elseif($method==='PUT'){$db->prepare('UPDATE bahan_praktik SET stok=GREATEST(0, stok+?) WHERE kode=?')->execute([$body['delta'],$body['kode']]);$st=$db->prepare('SELECT stok FROM bahan_praktik WHERE kode=?');$st->execute([$body['kode']]);$r=$st->fetch();success('Stok: '.($r?$r['stok']:'?'));}
            elseif($method==='DELETE'){$id=getParam('id')?:($body['id']??'');$db->prepare('DELETE FROM bahan_praktik WHERE id=?')->execute([$id]);success(null,'Dihapus');}
            else error('Method not allowed',405);
            break;

        case 'peminjaman':
            $body=getBody();$db=getDB();$today=date('Y-m-d');
            if($method==='GET'){$rows=$db->query('SELECT id AS row, id_pinjam AS id, kode_barang AS kodeBarang, nama_barang AS namaBarang, peminjam, jenis_peminjam AS jenisPeminjam, tgl_pinjam AS tglPinjam, batas_waktu AS batasWaktu, status, tgl_kembali AS tglKembali FROM peminjaman ORDER BY tgl_pinjam DESC, id DESC')->fetchAll();foreach($rows as &$r)$r['telat']=($r['status']==='Dipinjam'&&$r['batasWaktu']<$today);success($rows);}
            elseif($method==='POST'){$kb=$body['kodeBarang']??'';$st=$db->prepare('SELECT nama_barang FROM katalog_alat WHERE kode=?');$st->execute([$kb]);$a=$st->fetch();if(!$a)error('Kode alat tidak ditemukan');$id='PJM'.time();$db->prepare('INSERT INTO peminjaman (id_pinjam,kode_barang,nama_barang,peminjam,jenis_peminjam,tgl_pinjam,batas_waktu,status,tgl_kembali) VALUES (?,?,?,?,?,?,?,?,?)')->execute([$id,$kb,$a['nama_barang'],$body['peminjam'],$body['jenis'],$today,$body['batas'],'Dipinjam','']);success(['id'=>$id],'"'.$a['nama_barang'].'" dipinjamkan ke '.$body['peminjam']);}
            elseif($method==='PUT'){$id=$body['id']??getParam('id');$db->prepare('UPDATE peminjaman SET status="Dikembalikan", tgl_kembali=? WHERE id=?')->execute([$today,$id]);success(null,'Alat dikembalikan');}
            else error('Method not allowed',405);
            break;

        case 'scan-peminjam':
            if ($method !== 'GET') error('Method not allowed', 405);
            $code=getParam('code');if(!$code)error('Parameter code wajib diisi');
            $db=getDB();
            $st=$db->prepare('SELECT nama_siswa AS nama, kelas FROM siswa WHERE nis=?');$st->execute([$code]);$s=$st->fetch();
            if($s)success(['found'=>true,'nama'=>$s['nama'],'jenis'=>'Siswa','kelas'=>$s['kelas']]);
            $st=$db->prepare('SELECT nama_guru AS nama FROM guru WHERE nip=?');$st->execute([$code]);$g=$st->fetch();
            if($g)success(['found'=>true,'nama'=>$g['nama'],'jenis'=>'Guru','kelas'=>'']);
            $st=$db->prepare('SELECT nama_lengkap AS nama, role, kelas FROM users WHERE username=?');$st->execute([$code]);$u=$st->fetch();
            if($u)success(['found'=>true,'nama'=>$u['nama'],'jenis'=>$u['role'],'kelas'=>$u['kelas']]);
            success(['found'=>false,'nama'=>'','jenis'=>'','kelas'=>'']);
            break;

        case 'laporan-kerusakan':
            $body=getBody();$db=getDB();
            if($method==='GET')success($db->query('SELECT id AS row, tanggal, kode_barang AS kodeBarang, nama_barang AS namaBarang, kerusakan, pelapor, status, jadwal_maintenance AS jadwal FROM laporan_kerusakan ORDER BY tanggal DESC, id DESC')->fetchAll());
            elseif($method==='POST'){$db->prepare('INSERT INTO laporan_kerusakan (tanggal,kode_barang,nama_barang,kerusakan,pelapor,status,jadwal_maintenance) VALUES (?,?,?,?,?,?,?)')->execute([date('Y-m-d'),$body['kode'],$body['nama'],$body['kerusakan'],$body['pelapor'],'Menunggu',$body['jadwal']]);success(null,'Laporan dicatat');}
            elseif($method==='PUT'){$id=$body['id']??getParam('id');$db->prepare('UPDATE laporan_kerusakan SET status=? WHERE id=?')->execute([$body['status'],$id]);success(null,'Status diperbarui');}
            elseif($method==='DELETE'){$id=getParam('id')?:($body['id']??'');$db->prepare('DELETE FROM laporan_kerusakan WHERE id=?')->execute([$id]);success(null,'Dihapus');}
            else error('Method not allowed',405);
            break;

        // ===================== USERS (AUTO-HASH PASSWORD) =====================
        case 'users':
            $body=getBody();$db=getDB();
            if($method==='GET')success($db->query('SELECT id AS row, username, role, kelas, nama_lengkap AS nama, nip AS kodeGuru FROM users ORDER BY id')->fetchAll());
            elseif($method==='POST'){
                $ck=$db->prepare('SELECT id FROM users WHERE username=?');
                $ck->execute([$body['username']]);
                if($ck->fetch())error('Username sudah dipakai');
                
                // ✅ AUTO-HASH PASSWORD
                $hash = password_hash($body['password'], PASSWORD_DEFAULT);
                $db->prepare('INSERT INTO users (username,password,role,kelas,nama_lengkap,nip) VALUES (?,?,?,?,?,?)')
                   ->execute([
                       $body['username'],
                       $hash,
                       $body['role'],
                       $body['kelas'],
                       $body['nama'],
                       $body['kodeGuru'] ?? ''
                   ]);
                success(null,'User '.$body['username'].' ditambahkan (password aman)');
            }
            elseif($method==='PUT'){
                $id = $body['id'] ?? getParam('id');
                
                // ✅ AUTO-HASH jika password diisi
                if(!empty($body['password'])){
                    $hash = password_hash($body['password'], PASSWORD_DEFAULT);
                    $db->prepare('UPDATE users SET username=?,password=?,role=?,kelas=?,nama_lengkap=?,nip=? WHERE id=?')
                       ->execute([
                           $body['username'],
                           $hash,
                           $body['role'],
                           $body['kelas'],
                           $body['nama'],
                           $body['kodeGuru'] ?? '',
                           $id
                       ]);
                } else {
                    // Password tidak diubah
                    $db->prepare('UPDATE users SET username=?,role=?,kelas=?,nama_lengkap=?,nip=? WHERE id=?')
                       ->execute([
                           $body['username'],
                           $body['role'],
                           $body['kelas'],
                           $body['nama'],
                           $body['kodeGuru'] ?? '',
                           $id
                       ]);
                }
                success(null,'User diperbarui');
            }
            elseif($method==='DELETE'){
                $id=getParam('id')?:($body['id']??'');
                $db->prepare('DELETE FROM users WHERE id=?')->execute([$id]);
                success(null,'User dihapus');
            }
            else error('Method not allowed',405);
            break;

        case 'settings':
            $body=getBody();$db=getDB();
            if($method==='GET'){$ta=$db->query("SELECT setting_value FROM settings WHERE setting_key='TA_AKTIF'")->fetch();$sm=$db->query("SELECT setting_value FROM settings WHERE setting_key='SEMESTER'")->fetch();success(['ta'=>$ta?$ta['setting_value']:'2025/2026','semester'=>$sm?$sm['setting_value']:'1']);}
            elseif($method==='POST'){$db->prepare("UPDATE settings SET setting_value=? WHERE setting_key='TA_AKTIF'")->execute([$body['ta']]);$db->prepare("UPDATE settings SET setting_value=? WHERE setting_key='SEMESTER'")->execute([$body['semester']]);success(null,'TA aktif: '.$body['ta'].' Semester '.$body['semester']);}
            else error('Method not allowed',405);
            break;

        case 'log-aktivitas':
            $body=getBody();$db=getDB();
            if($method==='GET')success($db->query('SELECT DATE_FORMAT(waktu,"%d/%m %H:%i") AS ts, username AS user, role, aksi, detail FROM log_aktivitas ORDER BY id DESC LIMIT 100')->fetchAll());
            elseif($method==='POST'){$db->prepare('INSERT INTO log_aktivitas (waktu,username,role,aksi,detail) VALUES (NOW(),?,?,?,?)')->execute([$body['username']??'',$body['role']??'',$body['aksi']??'',$body['detail']??'']);success(null,'Log dicatat');}
            else error('Method not allowed',405);
            break;

        case 'backup-dump':
            if ($method !== 'GET') error('Method not allowed', 405);
            $db=getDB();$dump=[];
            foreach(['users','siswa','guru','kehadiran','tatatertib','kaskelas','struktur_kelas','inventaris','pengumuman','jadwal_pelajaran','jadwal_piket','jurnal_bimbingan','jurnal_mengajar','presensi_mapel','nilai','katalog_alat','bahan_praktik','peminjaman','laporan_kerusakan','settings','log_aktivitas','kunjungan_rumah'] as $t){try{$dump[$t]=$db->query('SELECT * FROM '.$t)->fetchAll();}catch(Exception $e){$dump[$t]=[];}}
            success($dump);
            break;

        case 'rekap-data':
            if ($method !== 'GET') error('Method not allowed', 405);
            $kelas=getParam('kelas');$nis=getParam('nis');$start=getParam('start');$end=getParam('end');
            if(!$kelas)error('Parameter kelas wajib diisi');
            $db=getDB();
            $sql='SELECT nis, nama_siswa AS nama, jk FROM siswa WHERE kelas=?';$p=[$kelas];
            if($nis){$sql.=' AND nis=?';$p[]=$nis;}
            $st=$db->prepare($sql);$st->execute($p);$siswa=$st->fetchAll();
            $sql='SELECT tanggal, nis, status FROM kehadiran WHERE kelas=? AND tanggal>=? AND tanggal<=?';$p=[$kelas,$start,$end];
            if($nis){$sql.=' AND nis=?';$p[]=$nis;}
            $st=$db->prepare($sql);$st->execute($p);$raw=$st->fetchAll();
            $dates=array_unique(array_column($raw,'tanggal'));sort($dates);
            $res=[];
            foreach($siswa as $s){$recs=[];$sum=['Hadir'=>0,'Sakit'=>0,'Izin'=>0,'Alfa'=>0];foreach($raw as $r)if($r['nis']===$s['nis']){$recs[$r['tanggal']]=$r['status'];if(isset($sum[$r['status']]))$sum[$r['status']]++;}$res[]=['nis'=>$s['nis'],'nama'=>$s['nama'],'jk'=>$s['jk'],'records'=>$recs,'summary'=>$sum,'total'=>$sum['Hadir']+$sum['Sakit']+$sum['Izin']+$sum['Alfa']];}
            success(['students'=>$res,'dates'=>$dates]);
            break;

        case 'laporan-admin':
            if ($method !== 'GET') error('Method not allowed', 405);
            $nip=getParam('nip');$kelas=getParam('kelas');$mapel=getParam('mapel');$start=getParam('start');$end=getParam('end');
            if(!$nip||!$kelas||!$mapel||!$start||!$end)error('nip, kelas, mapel, start, end wajib diisi');
            $db=getDB();
            $st=$db->prepare('SELECT nis, nama_siswa AS nama FROM siswa WHERE kelas=? ORDER BY nama_siswa');$st->execute([$kelas]);$siswa=$st->fetchAll();
            try{$st=$db->prepare('SELECT tanggal, nis, status, updated_at FROM presensi_mapel WHERE nip=? AND kelas=? AND mapel=? AND tanggal>=? AND tanggal<=?');$st->execute([$nip,$kelas,$mapel,$start,$end]);}
            catch(PDOException $e){$st=$db->prepare('SELECT tanggal, nis, status, NULL AS updated_at FROM presensi_mapel WHERE nip=? AND kelas=? AND mapel=? AND tanggal>=? AND tanggal<=?');$st->execute([$nip,$kelas,$mapel,$start,$end]);}
            $raw=$st->fetchAll();
            $revisi=0;$dates=[];$byNis=[];
            foreach($raw as $r){$dates[$r['tanggal']]=true;if(!empty($r['updated_at']))$revisi++;$byNis[$r['nis']][$r['status']]=($byNis[$r['nis']][$r['status']]??0)+1;}
            $students=[];
            foreach($siswa as $s){
                $sm=['Hadir'=>0,'Sakit'=>0,'Izin'=>0,'Alfa'=>0,'Dispensasi'=>0];
                foreach($byNis[$s['nis']]??[] as $k=>$v)if(isset($sm[$k]))$sm[$k]=$v;
                $tot=array_sum($sm);
                $students[]=['nis'=>$s['nis'],'nama'=>$s['nama'],'summary'=>$sm,'total'=>$tot,'pct'=>$tot?(int)round($sm['Hadir']/$tot*100):0];
            }
            $st=$db->prepare('SELECT tanggal, jam_ke AS jamKe, materi, kegiatan, status FROM jurnal_mengajar WHERE nip=? AND kelas=? AND mapel=? AND tanggal>=? AND tanggal<=? ORDER BY tanggal, jam_ke');$st->execute([$nip,$kelas,$mapel,$start,$end]);
            $jurnal=$st->fetchAll();
            $dts=array_keys($dates);sort($dts);
            success(['students'=>$students,'dates'=>$dts,'jurnal'=>$jurnal,'revisiCount'=>$revisi]);
            break;

        // ===================== REKAP PRESENSI MAPEL (untuk PDF Guru) =====================
        case 'presensi-mapel-rekap':
            if ($method !== 'GET') error('Method not allowed', 405);
            $nip = getParam('nip'); $kelas = getParam('kelas'); $mapel = getParam('mapel');
            $start = getParam('start'); $end = getParam('end');
            if (!$nip || !$kelas || !$mapel) error('nip, kelas, mapel wajib');
            $db = getDB();
            $st = $db->prepare('SELECT nis, nama_siswa AS nama FROM siswa WHERE kelas=? ORDER BY nama_siswa');
            $st->execute([$kelas]); $siswa = $st->fetchAll();
            if ($start && $end) {
                $st = $db->prepare('SELECT tanggal, nis, status FROM presensi_mapel WHERE nip=? AND kelas=? AND mapel=? AND tanggal>=? AND tanggal<=?');
                $st->execute([$nip, $kelas, $mapel, $start, $end]);
            } else {
                $st = $db->prepare('SELECT tanggal, nis, status FROM presensi_mapel WHERE nip=? AND kelas=? AND mapel=?');
                $st->execute([$nip, $kelas, $mapel]);
            }
            $raw = $st->fetchAll();
            $dates = array_unique(array_column($raw, 'tanggal')); sort($dates);
            $res = [];
            foreach ($siswa as $s) {
                $recs = []; $sum = ['Hadir'=>0,'Sakit'=>0,'Izin'=>0,'Alfa'=>0,'Dispensasi'=>0];
                foreach ($raw as $r) if ($r['nis'] === $s['nis']) { $recs[$r['tanggal']] = $r['status']; if (isset($sum[$r['status']])) $sum[$r['status']]++; }
                $tot = array_sum($sum);
                $res[] = ['nis'=>$s['nis'], 'nama'=>$s['nama'], 'records'=>$recs, 'summary'=>$sum, 'total'=>$tot];
            }
            success(['students'=>$res, 'dates'=>$dates]);
            break;

        // ===================== CBT SETUP =====================
        case 'setup-cbt':
            if ($method !== 'POST') error('Method not allowed', 405);
            $db = getDB(); $ok = 0; $errs = [];
            $ddl = [
                "CREATE TABLE IF NOT EXISTS bank_soal (id INT AUTO_INCREMENT PRIMARY KEY, nip VARCHAR(100), mapel VARCHAR(150), kelas VARCHAR(50) DEFAULT '', jenis INT, soal TEXT, opsi TEXT, kunci TEXT, pembahasan TEXT, bobot INT DEFAULT 1, tanggal DATE, INDEX idx_nip_mapel(nip,mapel)) ENGINE=InnoDB",
                "CREATE TABLE IF NOT EXISTS cbt_ujian (id INT AUTO_INCREMENT PRIMARY KEY, nip VARCHAR(100), judul VARCHAR(255), kelas VARCHAR(50), mapel VARCHAR(150), durasi_menit INT DEFAULT 60, token VARCHAR(20), aktif TINYINT DEFAULT 1, tanggal DATE, ai_aktif TINYINT DEFAULT 0, INDEX idx_kelas_aktif(kelas,aktif), INDEX idx_token(token)) ENGINE=InnoDB",
                "CREATE TABLE IF NOT EXISTS cbt_soal (id INT AUTO_INCREMENT PRIMARY KEY, ujian_id INT, no_urut INT, jenis INT, soal TEXT, opsi TEXT, kunci TEXT, pembahasan TEXT, bobot INT DEFAULT 1, INDEX idx_ujian(ujian_id)) ENGINE=InnoDB",
                "CREATE TABLE IF NOT EXISTS cbt_sesi (id INT AUTO_INCREMENT PRIMARY KEY, ujian_id INT, nis VARCHAR(50), nama VARCHAR(150), mulai DATETIME, deadline DATETIME, selesai TINYINT DEFAULT 0, skor DECIMAL(5,2), total_benar INT DEFAULT 0, total_soal INT DEFAULT 0, uraian_menunggu INT DEFAULT 0, INDEX idx_ujian_nis(ujian_id,nis)) ENGINE=InnoDB",
                "CREATE TABLE IF NOT EXISTS cbt_jawaban (id INT AUTO_INCREMENT PRIMARY KEY, sesi_id INT, soal_id INT, jawaban TEXT, benar SMALLINT, feedback TEXT, sumber VARCHAR(10) DEFAULT 'manual', UNIQUE KEY uniq_sesi_soal(sesi_id,soal_id)) ENGINE=InnoDB"
            ];
            foreach ($ddl as $sql) { try { $db->exec($sql); $ok++; } catch (Exception $e) { $errs[] = $e->getMessage(); } }
            success(['ok' => $ok, 'errors' => $errs], 'Setup CBT selesai');
            break;

        // ===================== BANK SOAL =====================
        case 'bank-soal':
case 'bank-soal-cbt':
    $body = getBody(); $db = getDB();
    if ($method === 'GET') {
        $nip = getParam('nip'); if (!$nip) error('nip wajib');
        $mapel = getParam('mapel') ?? '';
        $kelas = getParam('kelas') ?? '';
        $st = $db->prepare('SELECT id AS row, nip, mapel, kelas, jenis, soal, opsi, kunci, pembahasan, bobot, tanggal FROM bank_soal WHERE nip=? AND (mapel=? OR ?="") AND (kelas=? OR ?="") ORDER BY id DESC');
        $st->execute([$nip, $mapel, $mapel, $kelas, $kelas]);
        $rows = $st->fetchAll();
        foreach ($rows as &$r) {
            $r['opsiArr'] = json_decode($r['opsi'] ?: '[]', true) ?: [];
            $r['kunciArr'] = ($r['jenis'] == 3) ? (json_decode($r['kunci'] ?: '[]', true) ?: []) : null;
        }
        success($rows);
    } elseif ($method === 'POST') {
        $nip = $body['nip'] ?? '';
        $mapel = $body['mapel'] ?? '';
        $kelas = $body['kelas'] ?? '';   // ✅ FIX BUG 1: kelas pendamping soal (Text to Soal / AI)
        if (!$nip) error('nip wajib');

        // ✅ DUAL-FORMAT: Support {soal: [...]} ATAU single {...}
        $soal = $body['soal'] ?? null;
        if (!is_array($soal) || !count($soal)) {
            // Payload tunggal (dari saveBsManual di Index.html)
            if (isset($body['pertanyaan']) || isset($body['soal']) || isset($body['soal_text'])) {
                $soal = [$body];
            } else {
                error('Tidak ada soal untuk disimpan');
            }
        }
        
        $db->beginTransaction();
        $n = 0;
        try {
            $in = $db->prepare('INSERT INTO bank_soal (nip,mapel,kelas,jenis,soal,opsi,kunci,pembahasan,bobot,tanggal) VALUES (?,?,?,?,?,?,?,?,?,?)');
            foreach ($soal as $s) {
                $jenis = (int)($s['jenis'] ?? 1);
                // Konversi jenis string 'PG'/'Essay' ke angka
                if (is_string($s['jenis'] ?? null)) {
                    $jenisMap = ['PG' => 1, 'Essay' => 5, 'Benar/Salah' => 1, 'Isian' => 4];
                    $jenis = $jenisMap[$s['jenis']] ?? 1;
                }

                $opsi = is_array($s['opsi'] ?? null) ? $s['opsi'] : [];
                $kunci = $s['kunci'] ?? '';
                if (is_array($kunci)) $kunci = json_encode($kunci, JSON_UNESCAPED_UNICODE);

                // ✅ DUAL-FIELD: Support 'soal' ATAU 'pertanyaan'
                $teksSoal = $s['soal'] ?? $s['pertanyaan'] ?? $s['soal_text'] ?? '';

                // ✅ Gunakan mapel dari item jika ada, fallback ke mapel parent
                $mapelItem = $s['mapel'] ?? $mapel;
                // ✅ Gunakan kelas dari item jika ada, fallback ke kelas parent
                $kelasItem = $s['kelas'] ?? $kelas;

                $in->execute([
                    $nip,
                    $mapelItem,
                    $kelasItem,
                    $jenis,
                    $teksSoal,
                    json_encode($opsi, JSON_UNESCAPED_UNICODE),
                    (string)$kunci,
                    $s['pembahasan'] ?? '',
                    (int)($s['bobot'] ?? 1),
                    date('Y-m-d')
                ]);
                $n++;
            }
            $db->commit();
        } catch (Exception $e) {
            $db->rollBack();
            error('Error menyimpan: ' . $e->getMessage(), 500);
        }
        success(['inserted' => $n], $n . ' soal tersimpan ke bank');
    } elseif ($method === 'DELETE') {
        // ✅ DUKUNG BULK: {ids: [...]} ATAU {id: n} tunggal (kompatibel dgn frontend lama)
        // GAS mengirim ids via query param (koma-pisah), jadi terima dari GET & body.
        $ids = $body['ids'] ?? null;
        if (($ids === null || $ids === '') && getParam('ids')) {
            $ids = explode(',', getParam('ids'));
        }
        if (is_array($ids) && count($ids)) {
            $idsArr = array_map('intval', $ids);
            $ph = implode(',', array_fill(0, count($idsArr), '?'));
            $db->prepare("DELETE FROM bank_soal WHERE id IN ($ph)")->execute($idsArr);
            success(null, count($idsArr) . ' soal dihapus dari bank');
        } else {
            $id = getParam('id') ?: ($body['id'] ?? '');
            $db->prepare('DELETE FROM bank_soal WHERE id=?')->execute([$id]);
            success(null, 'Soal dihapus dari bank');
        }
    } else {
        error('Method not allowed', 405);
    }
    break;

        case 'setup-banksoal':
            $db = getDB(); $ok = 0; $errs = [];
            $db->exec("DROP TABLE IF EXISTS bank_soal");
            $sql = "CREATE TABLE bank_soal (id INT AUTO_INCREMENT PRIMARY KEY, nip VARCHAR(100) NOT NULL, mapel VARCHAR(150), kelas VARCHAR(50) DEFAULT '', jenis INT DEFAULT 1, soal TEXT, opsi TEXT, kunci TEXT, pembahasan TEXT, bobot INT DEFAULT 1, tanggal DATE, INDEX idx_nip(nip), INDEX idx_nip_mapel(nip,mapel)) ENGINE=InnoDB";
            try { $db->exec($sql); $ok++; } catch (Exception $e) { $errs[] = $e->getMessage(); }
            success(['ok'=>$ok,'errors'=>$errs], 'Bank Soal siap');
            break;

        // ===================== CBT: GURU =====================
        case 'cbt-list-ujian-guru':
            if ($method !== 'GET') error('Method not allowed', 405);
            $nip = getParam('nip'); if (!$nip) error('nip wajib'); $db = getDB();
            $st = $db->prepare('SELECT u.id AS row, u.judul, u.kelas, u.mapel, u.durasi_menit AS durasi, u.token, u.aktif, u.tanggal,
                (SELECT COUNT(*) FROM cbt_soal s WHERE s.ujian_id=u.id) AS jmlSoal,
                (SELECT COUNT(*) FROM cbt_sesi s WHERE s.ujian_id=u.id AND s.selesai=1) AS peserta,
                (SELECT AVG(skor) FROM cbt_sesi WHERE ujian_id=u.id AND selesai=1) AS rata
                FROM cbt_ujian u WHERE u.nip=? ORDER BY u.id DESC');
            $st->execute([$nip]);
            $rows = $st->fetchAll();
            foreach ($rows as &$r) { if ($r['rata'] != null) $r['rata'] = round((float)$r['rata'], 1); }
            success($rows);
            break;

        case 'cbt-create-ujian':
            if ($method !== 'POST') error('Method not allowed', 405);
            $body = getBody(); $db = getDB();
            $nip = $body['nip'] ?? ''; $kelas = $body['kelas'] ?? ''; $mapel = $body['mapel'] ?? '';
            $judul = $body['judul'] ?? 'Ulangan'; $dur = (int)($body['durasi'] ?? 60);
            if (!$nip || !$kelas || !$judul) error('nip, kelas, dan judul wajib');
            if ($dur < 1) $dur = 60;
            $token = strtoupper(substr(md5(uniqid($judul, true)), 0, 6));
            $db->beginTransaction();
            try {
                $db->prepare('INSERT INTO cbt_ujian (nip,judul,kelas,mapel,durasi_menit,token,aktif,tanggal) VALUES (?,?,?,?,?,?,1,?)')
                   ->execute([$nip, $judul, $kelas, $mapel, $dur, $token, date('Y-m-d')]);
                $uid = (int)$db->lastInsertId();
                if (!empty($body['soalIds'])) {
                    $ids = $body['soalIds'];
                    $ph = implode(',', array_fill(0, count($ids), '?'));
                    $st = $db->prepare('SELECT jenis, soal, opsi, kunci, pembahasan, bobot FROM bank_soal WHERE id IN ('.$ph.')');
                    $st->execute($ids); $soal = $st->fetchAll();
                    $in = $db->prepare('INSERT INTO cbt_soal (ujian_id,no_urut,jenis,soal,opsi,kunci,pembahasan,bobot) VALUES (?,?,?,?,?,?,?,?)');
                    $no = 1; foreach ($soal as $s) { $in->execute([$uid, $no++, $s['jenis'], $s['soal'], $s['opsi'], $s['kunci'], $s['pembahasan'], $s['bobot']]); }
                }
                $db->commit();
            } catch (Exception $e) { $db->rollBack(); error('Error: '.$e->getMessage()); }
            success(['id' => $uid, 'token' => $token], 'Ujian dibuat. Token: '.$token);
            break;

        case 'cbt-get-ujian':
            if ($method !== 'GET') error('Method not allowed', 405);
            $id = getParam('id'); if (!$id) error('id wajib'); $db = getDB();
            $st = $db->prepare('SELECT * FROM cbt_ujian WHERE id=?'); $st->execute([$id]); $u = $st->fetch();
            if (!$u) error('Ujian tidak ditemukan');
            $st = $db->prepare('SELECT * FROM cbt_soal WHERE ujian_id=? ORDER BY no_urut'); $st->execute([$id]);
            $u['soal'] = $st->fetchAll();
            success($u);
            break;

        case 'cbt-toggle-ujian':
            if ($method !== 'POST') error('Method not allowed', 405);
            $body = getBody(); $db = getDB();
            $id = $body['id'] ?? 0; $aktif = $body['aktif'] ?? 0;
            $db->prepare('UPDATE cbt_ujian SET aktif=? WHERE id=?')->execute([$aktif ? 1 : 0, $id]);
            success(null, 'Status ujian diperbarui');
            break;

        case 'cbt-delete-ujian':
            $id = getParam('id') ?: ($body['id'] ?? ''); $db = getDB();
            $db->prepare('DELETE FROM cbt_jawaban WHERE sesi_id IN (SELECT id FROM cbt_sesi WHERE ujian_id=?)')->execute([$id]);
            $db->prepare('DELETE FROM cbt_sesi WHERE ujian_id=?')->execute([$id]);
            $db->prepare('DELETE FROM cbt_soal WHERE ujian_id=?')->execute([$id]);
            $db->prepare('DELETE FROM cbt_ujian WHERE id=?')->execute([$id]);
            success(null, 'Ujian dihapus');
            break;

        case 'cbt-hasil-guru':
            if ($method !== 'GET') error('Method not allowed', 405);
            $id = getParam('id'); if (!$id) error('id wajib'); $db = getDB();
            $st = $db->prepare('SELECT s.id AS sesiId, s.nis, s.nama, s.skor, s.total_benar AS benar, s.total_soal AS total, s.uraian_menunggu AS uraian, s.selesai, s.mulai FROM cbt_sesi s WHERE s.ujian_id=? ORDER BY s.selesai DESC, s.skor DESC');
            $st->execute([$id]); success($st->fetchAll());
            break;

        // ===================== CBT: SISWA =====================
        case 'cbt-list-ujian-siswa':
            if ($method !== 'GET') error('Method not allowed', 405);
            $kelas = getParam('kelas'); $nis = getParam('nis');
            if (!$kelas || !$nis) error('kelas dan nis wajib'); $db = getDB();
            $st = $db->prepare('SELECT u.id, u.judul, u.mapel, u.durasi_menit AS durasi,
                (SELECT COUNT(*) FROM cbt_soal s WHERE s.ujian_id=u.id) AS jmlSoal,
                (SELECT s2.selesai FROM cbt_sesi s2 WHERE s2.ujian_id=u.id AND s2.nis=? LIMIT 1) AS sudah
                FROM cbt_ujian u WHERE u.aktif=1 AND u.kelas=? ORDER BY u.id DESC');
            $st->execute([$nis, $kelas]); success($st->fetchAll());
            break;

        case 'cbt-start-sesi':
            if ($method !== 'POST') error('Method not allowed', 405);
            $body = getBody(); $db = getDB();
            $ujianId = (int)($body['ujianId'] ?? 0); $nis = $body['nis'] ?? ''; $nama = $body['nama'] ?? '';
            if (!$ujianId || !$nis) error('ujianId dan NIS wajib');
            
            $st = $db->prepare('SELECT id, judul, mapel, durasi_menit AS durasi, kelas FROM cbt_ujian WHERE id=? AND aktif=1');
            $st->execute([$ujianId]); $u = $st->fetch();
            if (!$u) error('Ujian tidak valid atau sudah ditutup');
            
            $uid = (int)$u['id']; $dur = (int)$u['durasi'];
            $st = $db->prepare('SELECT id, deadline, selesai, skor, total_benar, total_soal, uraian_menunggu FROM cbt_sesi WHERE ujian_id=? AND nis=? LIMIT 1');
            $st->execute([$uid, $nis]); $sesi = $st->fetch();
            
            if ($sesi) {
                $sid = (int)$sesi['id']; $sisa = strtotime($sesi['deadline']) - time();
                if ((int)$sesi['selesai'] === 1 || $sisa <= 0) {
                    if ((int)$sesi['selesai'] !== 1) _cbt_finalisasi($db, $sid);
                    $st = $db->prepare('SELECT skor, total_benar, total_soal, uraian_menunggu FROM cbt_sesi WHERE id=?'); $st->execute([$sid]); $f = $st->fetch();
                    success(['sudahSelesai' => true, 'skor' => $f['skor'], 'benar' => (int)$f['total_benar'], 'total' => (int)$f['total_soal'], 'uraian' => (int)$f['uraian_menunggu'], 'judul' => $u['judul']]);
                }
                $st = $db->prepare('SELECT id, id AS soalId, no_urut AS no, jenis, soal, opsi, pembahasan, bobot FROM cbt_soal WHERE ujian_id=? ORDER BY no_urut'); $st->execute([$uid]);
                $soal = $st->fetchAll(); foreach ($soal as &$r) $r['opsiArr'] = json_decode($r['opsi'] ?: '[]', true) ?: [];
                $st = $db->prepare('SELECT soal_id, jawaban FROM cbt_jawaban WHERE sesi_id=?'); $st->execute([$sid]);
                $jw = []; foreach ($st->fetchAll() as $x) $jw[$x['soal_id']] = $x['jawaban'];
                success(['sudahSelesai' => false, 'sesiId' => $sid, 'sisaDetik' => $sisa, 'judul' => $u['judul'], 'soal' => $soal, 'jawaban' => $jw]);
            }
            $now = date('Y-m-d H:i:s'); $deadline = date('Y-m-d H:i:s', time() + $dur * 60);
            $db->prepare('INSERT INTO cbt_sesi (ujian_id,nis,nama,mulai,deadline,selesai) VALUES (?,?,?,?,?,0)')->execute([$uid, $nis, $nama, $now, $deadline]);
            $sid = (int)$db->lastInsertId();
            $st = $db->prepare('SELECT id, id AS soalId, no_urut AS no, jenis, soal, opsi, pembahasan, bobot FROM cbt_soal WHERE ujian_id=? ORDER BY no_urut'); $st->execute([$uid]);
            $soal = $st->fetchAll(); foreach ($soal as &$r) $r['opsiArr'] = json_decode($r['opsi'] ?: '[]', true) ?: [];
            success(['sudahSelesai' => false, 'sesiId' => $sid, 'sisaDetik' => $dur * 60, 'judul' => $u['judul'], 'soal' => $soal, 'jawaban' => new stdClass()]);
            break;

        case 'cbt-save-jawaban':
            if ($method !== 'POST') error('Method not allowed', 405);
            $body = getBody(); $db = getDB();
            $sid = (int)($body['sesiId'] ?? 0); $soalId = (int)($body['soalId'] ?? 0); $jw = $body['jawaban'] ?? '';
            if (!$sid || !$soalId) error('sesiId & soalId wajib');
            $st = $db->prepare('SELECT id FROM cbt_jawaban WHERE sesi_id=? AND soal_id=?'); $st->execute([$sid, $soalId]);
            if ($st->fetch()) $db->prepare('UPDATE cbt_jawaban SET jawaban=? WHERE sesi_id=? AND soal_id=?')->execute([$jw, $sid, $soalId]);
            else $db->prepare('INSERT INTO cbt_jawaban (sesi_id,soal_id,jawaban) VALUES (?,?,?)')->execute([$sid, $soalId, $jw]);
            success(null, 'ok');
            break;

        case 'cbt-finish-sesi':
            if ($method !== 'POST') error('Method not allowed', 405);
            $body = getBody(); $db = getDB();
            $sid = (int)($body['sesiId'] ?? 0); if (!$sid) error('sesiId wajib');
            _cbt_finalisasi($db, $sid);
            $st = $db->prepare('SELECT skor, total_benar, total_soal, uraian_menunggu FROM cbt_sesi WHERE id=?'); $st->execute([$sid]); $f = $st->fetch();
            success(['skor' => $f['skor'], 'benar' => (int)$f['total_benar'], 'total' => (int)$f['total_soal'], 'uraian' => (int)$f['uraian_menunggu']]);
            break;
            
        case 'cbt-hasil-siswa':
            if ($method !== 'GET') error('Method not allowed', 405);
            $sid = getParam('sesiId'); $nis = getParam('nis');
            if (!$sid) error('sesiId wajib'); $db = getDB();
            $st = $db->prepare('SELECT skor, total_benar, total_soal, uraian_menunggu FROM cbt_sesi WHERE id=? AND nis=?');
            $st->execute([$sid, $nis]); $f = $st->fetch();
            if (!$f) error('Data tidak ditemukan');
            success($f);
            break;

        // ===================== CBT: TOKEN SYSTEM (FIX FRONTEND) =====================
                // ===================== CBT: TOKEN SYSTEM (ENDPOINT BARU) =====================
        case 'cbt-exam':
            $body = getBody(); $db = getDB();
            if ($method === 'GET') {
                $nip = getParam('nip'); if (!$nip) error('nip wajib');
                // ✅ Deteksi kolom ai_aktif (tabel lama mungkin belum di-ALTER).
                $hasAiCol = false;
                try { $chk = $db->prepare('SELECT ai_aktif FROM cbt_ujian LIMIT 1'); $chk->execute(); $hasAiCol = true; }
                catch (Exception $e) { $hasAiCol = false; }
                $select = $hasAiCol
                    ? 'SELECT u.id AS row, u.judul, u.kelas, u.mapel, u.durasi_menit AS durasi, u.token, u.aktif, u.ai_aktif, u.tanggal'
                    : 'SELECT u.id AS row, u.judul, u.kelas, u.mapel, u.durasi_menit AS durasi, u.token, u.aktif, 0 AS ai_aktif, u.tanggal';
                $st = $db->prepare($select . ',
                    (SELECT COUNT(*) FROM cbt_soal WHERE ujian_id=u.id) AS jmlSoal,
                    (SELECT COUNT(*) FROM cbt_soal WHERE ujian_id=u.id AND jenis=1) AS jmlPG,
                    (SELECT COUNT(*) FROM cbt_soal WHERE ujian_id=u.id AND jenis=5) AS jmlEssay,
                    (SELECT COUNT(DISTINCT nis) FROM cbt_sesi WHERE ujian_id=u.id) AS peserta,
                    (SELECT AVG(skor) FROM cbt_sesi WHERE ujian_id=u.id AND selesai=1) AS rata
                    FROM cbt_ujian u WHERE u.nip=? ORDER BY u.id DESC');
                $st->execute([$nip]);
                $rows = $st->fetchAll();
                foreach ($rows as &$r) {
                    $r['status'] = $r['aktif'] ? 'Aktif' : 'Selesai';
                    if ($r['rata'] != null) $r['rata'] = round((float)$r['rata'], 1);
                }
                success($rows);
            } elseif ($method === 'POST') {
                $nip = $body['nip'] ?? '';
                $kelas = $body['kelas'] ?? '';
                $mapel = $body['mapel'] ?? '';
                $judul = $body['judul'] ?? 'Ulangan';
                $dur = (int)($body['durasi'] ?? 30);
                if (!$nip || !$kelas || !$judul) error('nip, kelas, judul wajib');
                if ($dur < 1) $dur = 30;
                $ai = !empty($body['ai']) ? 1 : 0;   // ✅ koreksi essay otomatis oleh AI
                // ✅ Cek apakah kolom ai_aktif ada (tabel lama mungkin belum di-ALTER).
                // Jika tidak ada, buat ujian TANPA flag AI agar pembuatan tidak gagal.
                $hasAiCol = false;
                try {
                    $chk = $db->prepare('SELECT ai_aktif FROM cbt_ujian LIMIT 1');
                    $chk->execute(); $hasAiCol = true;
                } catch (Exception $e) { $hasAiCol = false; }
                $token = strtoupper(substr(md5(uniqid($judul . time(), true)), 0, 6));
                $db->beginTransaction();
                try {
                    if ($hasAiCol) {
                        $db->prepare('INSERT INTO cbt_ujian (nip,judul,kelas,mapel,durasi_menit,token,aktif,ai_aktif,tanggal) VALUES (?,?,?,?,?,?,1,?,?)')
                           ->execute([$nip, $judul, $kelas, $mapel, $dur, $token, $ai, date('Y-m-d')]);
                    } else {
                        $db->prepare('INSERT INTO cbt_ujian (nip,judul,kelas,mapel,durasi_menit,token,aktif,tanggal) VALUES (?,?,?,?,?,?,1,?)')
                           ->execute([$nip, $judul, $kelas, $mapel, $dur, $token, date('Y-m-d')]);
                    }
                    $uid = (int)$db->lastInsertId();
                    if (!empty($body['soalIds'])) {
                        $ids = $body['soalIds'];
                        $ph = implode(',', array_fill(0, count($ids), '?'));
                        $st = $db->prepare('SELECT jenis, soal, opsi, kunci, pembahasan, bobot FROM bank_soal WHERE id IN ('.$ph.')');
                        $st->execute($ids);
                        $soal = $st->fetchAll();
                        $in = $db->prepare('INSERT INTO cbt_soal (ujian_id,no_urut,jenis,soal,opsi,kunci,pembahasan,bobot) VALUES (?,?,?,?,?,?,?,?)');
                        $no = 1;
                        foreach ($soal as $s) {
                            $in->execute([$uid, $no++, $s['jenis'], $s['soal'], $s['opsi'], $s['kunci'], $s['pembahasan'], $s['bobot']]);
                        }
                    }
                    $db->commit();
                } catch (Exception $e) {
                    $db->rollBack();
                    error('Error: '.$e->getMessage());
                }
                success(['id' => $uid, 'token' => $token], 'Ujian dibuat. Token: '.$token);
            } elseif ($method === 'PUT') {
                $id = $body['id'] ?? 0;
                $status = $body['status'] ?? 'Aktif';
                $aktif = ($status === 'Aktif') ? 1 : 0;
                $db->prepare('UPDATE cbt_ujian SET aktif=? WHERE id=?')->execute([$aktif, $id]);
                success(null, 'Status ujian diperbarui');
            } elseif ($method === 'DELETE') {
                $id = getParam('id') ?: ($body['id'] ?? '');
                $db->prepare('DELETE FROM cbt_jawaban WHERE sesi_id IN (SELECT id FROM cbt_sesi WHERE ujian_id=?)')->execute([$id]);
                $db->prepare('DELETE FROM cbt_sesi WHERE ujian_id=?')->execute([$id]);
                $db->prepare('DELETE FROM cbt_soal WHERE ujian_id=?')->execute([$id]);
                $db->prepare('DELETE FROM cbt_ujian WHERE id=?')->execute([$id]);
                success(null, 'Ujian dihapus');
            }
            break;

                // ===================== CBT: SISWA (SINKRON DENGAN KODE.GS) =====================

        case 'cbt-mulai':
            if ($method !== 'POST') error('Method not allowed', 405);
            $body = getBody(); $db = getDB();
            $token = strtoupper(trim($body['token'] ?? ''));
            $nis = $body['nis'] ?? '';
            $nama = $body['nama'] ?? '';
            $kelas = $body['kelas'] ?? '';
            if (!$token || !$nis) error('Token dan NIS wajib');

            // ✅ Deteksi kolom ai_aktif (tabel lama mungkin belum di-ALTER).
            $hasAiCol = false;
            try { $chk = $db->prepare('SELECT ai_aktif FROM cbt_ujian LIMIT 1'); $chk->execute(); $hasAiCol = true; }
            catch (Exception $e) { $hasAiCol = false; }
            $st = $db->prepare($hasAiCol
                ? 'SELECT id, judul, mapel, durasi_menit AS durasi, kelas, ai_aktif FROM cbt_ujian WHERE token=? AND aktif=1'
                : 'SELECT id, judul, mapel, durasi_menit AS durasi, kelas, 0 AS ai_aktif FROM cbt_ujian WHERE token=? AND aktif=1');
            $st->execute([$token]); $u = $st->fetch();
            if (!$u) error('Token tidak valid atau ujian sudah ditutup');
            if ($kelas && $u['kelas'] && $u['kelas'] !== $kelas) error('Ujian ini untuk kelas '.$u['kelas']);

            $uid = (int)$u['id'];
            $dur = (int)$u['durasi'];

            $st = $db->prepare('SELECT id, deadline, selesai, skor FROM cbt_sesi WHERE ujian_id=? AND nis=? LIMIT 1');
            $st->execute([$uid, $nis]);
            $sesi = $st->fetch();

            // Jika sudah selesai
            if ($sesi && (int)$sesi['selesai'] === 1) {
                success(['sudah' => true, 'total' => $sesi['skor']]);
            }

            $now = date('Y-m-d H:i:s');
            $deadline = date('Y-m-d H:i:s', time() + $dur * 60);

            if (!$sesi) {
                $db->prepare('INSERT INTO cbt_sesi (ujian_id,nis,nama,mulai,deadline,selesai) VALUES (?,?,?,?,?,0)')
                   ->execute([$uid, $nis, $nama, $now, $deadline]);
                $sid = (int)$db->lastInsertId();
                $sisaDetik = $dur * 60;
            } else {
                $sid = (int)$sesi['id'];
                $sisaDetik = max(0, strtotime($sesi['deadline']) - time());
            }

            // Ambil soal
            // ✅ FIX BUG 3 & 4: frontend memakai `q.id` untuk semua binding jawaban
            // (jawaban[soalId], autosave, submit). Kembalikan BOTH id & soalId agar
            // konsisten — sebelumnya hanya ada `soalId` sehingga q.id = undefined,
            // jawaban siswa tertumpuk di satu slot & tidak pernah tersimpan.
            $st = $db->prepare('SELECT id, id AS soalId, no_urut AS no, jenis, soal AS pertanyaan, opsi, pembahasan, bobot FROM cbt_soal WHERE ujian_id=? ORDER BY no_urut');
            $st->execute([$uid]);
            $soal = $st->fetchAll();
            foreach ($soal as &$r) {
                $r['opsiArr'] = json_decode($r['opsi'] ?: '[]', true) ?: [];
                unset($r['opsi']); // buang field mentah
                $r['jenis'] = ($r['jenis'] == 5) ? 'Essay' : 'PG';
            }

            // Ambil jawaban tersimpan
            $st = $db->prepare('SELECT soal_id, jawaban FROM cbt_jawaban WHERE sesi_id=?');
            $st->execute([$sid]);
            $saved = [];
            foreach ($st->fetchAll() as $x) $saved[$x['soal_id']] = $x['jawaban'];

            // ✅ RESPONSE FORMAT (sinkron dengan Kode.gs cbtStart)
            success([
                'sesiId'   => $sid,
                'sisaDetik' => $sisaDetik,
                'judul'    => $u['judul'],
                'mapel'    => $u['mapel'],
                'ai'       => (int)($u['ai_aktif'] ?? 0),
                'soal'     => $soal,
                'saved'    => $saved
            ]);
            break;

        case 'cbt-simpan-jawaban':
            if ($method !== 'POST') error('Method not allowed', 405);
            $body = getBody(); $db = getDB();
            $sesiId = (int)($body['sesiId'] ?? 0);
            $soalId = (int)($body['soalId'] ?? 0);
            $jw = $body['jawaban'] ?? '';
            if (!$sesiId || !$soalId) error('sesiId & soalId wajib');

            $st = $db->prepare('SELECT id FROM cbt_jawaban WHERE sesi_id=? AND soal_id=?');
            $st->execute([$sesiId, $soalId]);
            if ($st->fetch()) {
                $db->prepare('UPDATE cbt_jawaban SET jawaban=? WHERE sesi_id=? AND soal_id=?')
                   ->execute([$jw, $sesiId, $soalId]);
            } else {
                $db->prepare('INSERT INTO cbt_jawaban (sesi_id,soal_id,jawaban) VALUES (?,?,?)')
                   ->execute([$sesiId, $soalId, $jw]);
            }
            success(null, 'ok');
            break;

        case 'cbt-simpan-batch':
            if ($method !== 'POST') error('Method not allowed', 405);
            $body = getBody(); $db = getDB();
            $sesiId = (int)($body['sesiId'] ?? 0);
            $arr = $body['jawaban'] ?? [];
            if (!$sesiId) error('sesiId wajib');

            $db->beginTransaction();
            try {
                $ck = $db->prepare('SELECT id FROM cbt_jawaban WHERE sesi_id=? AND soal_id=?');
                $up = $db->prepare('UPDATE cbt_jawaban SET jawaban=? WHERE sesi_id=? AND soal_id=?');
                $in = $db->prepare('INSERT INTO cbt_jawaban (sesi_id,soal_id,jawaban) VALUES (?,?,?)');
                foreach ($arr as $x) {
                    $soalId = (int)($x['soalId'] ?? 0);
                    if (!$soalId) continue;
                    $jw = $x['jawaban'] ?? '';
                    $ck->execute([$sesiId, $soalId]);
                    if ($ck->fetch()) {
                        $up->execute([$jw, $sesiId, $soalId]);
                    } else {
                        $in->execute([$sesiId, $soalId, $jw]);
                    }
                }
                $db->commit();
            } catch (Exception $e) {
                $db->rollBack();
                error('Error: '.$e->getMessage());
            }
            // ✅ HANYA simpan, TIDAK finalisasi (finalisasi di cbt-kumpulkan)
            success(null, 'batch tersimpan');
            break;

        case 'cbt-kumpulkan':
            if ($method !== 'POST') error('Method not allowed', 405);
            $body = getBody(); $db = getDB();
            $sesiId = (int)($body['sesiId'] ?? 0);
            if (!$sesiId) error('sesiId wajib');

            // Finalisasi (koreksi PG otomatis)
            _cbt_finalisasi($db, $sesiId);

            // Ambil hasil
            $st = $db->prepare('SELECT skor, total_benar, total_soal, uraian_menunggu FROM cbt_sesi WHERE id=?');
            $st->execute([$sesiId]);
            $f = $st->fetch();

            // ✅ RESPONSE FORMAT (sinkron dengan cbtSubmit di Kode.gs)
            success([
                'skor'           => $f['skor'],
                'benar'          => (int)$f['total_benar'],
                'total'          => (int)$f['total_soal'],
                'uraian'         => (int)$f['uraian_menunggu']
            ]);
            break;

        case 'cbt-hasil':
            if ($method !== 'GET') error('Method not allowed', 405);
            $examId = getParam('examId');
            if (!$examId) error('examId wajib');
            $db = getDB();

            // ✅ FIX BUG 3: Hitung nilaiPG / nilaiEssay / total secara eksplisit dari
            // poin & bobot (tidak lagi menebak dari skor), sehingga hasil essay yang
            // sudah dikoreksi benar-benar MUNCUL di monitor & koreksi guru.
            $st = $db->prepare('
                SELECT s.nis, s.nama, s.skor AS total, s.selesai, s.uraian_menunggu,
                       (SELECT COALESCE(SUM(j.benar),0) FROM cbt_jawaban j
                        JOIN cbt_soal q ON q.id=j.soal_id
                        WHERE j.sesi_id=s.id AND q.jenis!=5) AS pgPoin,
                       (SELECT COALESCE(SUM(q.bobot),0) FROM cbt_soal q
                        WHERE q.ujian_id=s.ujian_id AND q.jenis!=5) AS pgTotal,
                       (SELECT COALESCE(SUM(j.benar),0) FROM cbt_jawaban j
                        JOIN cbt_soal q ON q.id=j.soal_id
                        WHERE j.sesi_id=s.id AND q.jenis=5) AS esPoin,
                       (SELECT COALESCE(SUM(q.bobot),0) FROM cbt_soal q
                        WHERE q.ujian_id=s.ujian_id AND q.jenis=5) AS esTotal
                FROM cbt_sesi s WHERE s.ujian_id=?
                ORDER BY s.selesai DESC, s.skor DESC');
            $st->execute([$examId]);
            $rows = $st->fetchAll();
            foreach ($rows as &$r) {
                $r['status'] = $r['selesai'] ? 'Selesai' : 'Berlangsung';
                $pgPoin = (int)$r['pgPoin']; $pgTotal = (int)$r['pgTotal'];
                $esPoin = (int)$r['esPoin']; $esTotal = (int)$r['esTotal'];
                $r['nilaiPg'] = $pgTotal > 0 ? round($pgPoin / $pgTotal * 100, 2) : null;
                if ((int)$r['selesai'] === 1 && $esTotal > 0 && (int)$r['uraian_menunggu'] === 0) {
                    // Semua essay sudah dinilai (atau tidak ada yang dijawab) → tampilkan nilai essay
                    $r['nilaiEssay'] = round($esPoin / $esTotal * 100, 2);
                    $r['total'] = ($pgTotal + $esTotal) > 0
                        ? round(($pgPoin + $esPoin) / ($pgTotal + $esTotal) * 100, 2)
                        : $r['total'];
                } else {
                    // Masih berlangsung / essay menunggu koreksi → total = nilai PG
                    $r['nilaiEssay'] = null;
                    $r['total'] = $r['nilaiPg'];
                }
            }
            success($rows);
            break;

        case 'cbt-essay':
            $body = getBody(); $db = getDB();
            if ($method === 'GET') {
                $examId = getParam('examId');
                if (!$examId) error('examId wajib');
                // ✅ Deteksi kolom feedback & sumber (tabel lama mungkin belum di-ALTER).
                $hasFbCol = false;
                try { $chk = $db->prepare('SELECT feedback FROM cbt_jawaban LIMIT 1'); $chk->execute(); $hasFbCol = true; }
                catch (Exception $e) { $hasFbCol = false; }
                $fbSelect = $hasFbCol
                    ? 'j.feedback, j.sumber, '
                    : "'' AS feedback, 'manual' AS sumber, ";
                $st = $db->prepare('SELECT j.id, j.jawaban, j.benar AS nilai, ' . $fbSelect . 'j.sesi_id AS sesiId, j.soal_id AS soalId, s.nis, s.nama, q.soal AS pertanyaan, q.kunci, q.bobot
                    FROM cbt_jawaban j
                    JOIN cbt_sesi s ON s.id = j.sesi_id
                    JOIN cbt_soal q ON q.id = j.soal_id
                    WHERE s.ujian_id=? AND q.jenis=5
                    ORDER BY s.nama');
                $st->execute([$examId]);
                $rows = $st->fetchAll();
                foreach ($rows as &$r) {
                    $r['status'] = $r['nilai'] !== null ? 'dinilai' : 'pending';
                }
                success($rows);
            } elseif ($method === 'PUT') {
                $id = $body['id'] ?? 0;
                $nilai = $body['nilai'] ?? 0;
                // ✅ feedback + sumber opsional (dari AI auto-grading); sumber default 'manual'
                $feedback = $body['feedback'] ?? null;
                $sumber   = $body['sumber']   ?? 'manual';
                if ($feedback !== null) {
                    $db->prepare('UPDATE cbt_jawaban SET benar=?, feedback=?, sumber=? WHERE id=?')->execute([$nilai, $feedback, $sumber, $id]);
                } else {
                    $db->prepare('UPDATE cbt_jawaban SET benar=?, sumber=? WHERE id=?')->execute([$nilai, $sumber, $id]);
                }

                // ✅ FIX BUG 3: recalc=true agar hitung ulang berjalan meski sesi sudah selesai,
                // nilai essay masuk ke skor total & uraian_menunggu diperbarui.
                $st = $db->prepare('SELECT sesi_id FROM cbt_jawaban WHERE id=?');
                $st->execute([$id]);
                $row = $st->fetch();
                if ($row) _cbt_finalisasi($db, (int)$row['sesi_id'], true);

                success(null, 'Nilai essay disimpan');
            }
            break;

        // Detail SATU jawaban essay — dipakai GAS sebelum meminta AI menilai.
        case 'cbt-essay-detail':
            if ($method !== 'GET') error('Method not allowed', 405);
            $db = getDB();
            $id = getParam('id'); $sesiId = getParam('sesiId'); $soalId = getParam('soalId');
            if (!$id) error('id wajib');
            $st = $db->prepare('SELECT j.jawaban, j.benar AS nilai, j.feedback, j.sumber, j.sesi_id AS sesiId, j.soal_id AS soalId, q.soal AS pertanyaan, q.kunci, q.bobot
                FROM cbt_jawaban j JOIN cbt_soal q ON q.id = j.soal_id WHERE j.id=?');
            $st->execute([$id]);
            $row = $st->fetch();
            if (!$row) error('Jawaban tidak ditemukan');
            $row['status'] = $row['nilai'] !== null ? 'dinilai' : 'pending';
            success($row);
            break;

        // Aktif/nonaktifkan koreksi essay otomatis oleh AI untuk satu ujian.
        case 'cbt-ai-toggle':
            if ($method !== 'POST') error('Method not allowed', 405);
            $body = getBody(); $db = getDB();
            $id = (int)($body['id'] ?? 0); $ai = $body['ai'] ?? 0;
            if (!$id) error('id wajib');
            $db->prepare('UPDATE cbt_ujian SET ai_aktif=? WHERE id=?')->execute([$ai ? 1 : 0, $id]);
            success(null, 'Koreksi AI ' . ($ai ? 'diaktifkan' : 'dinonaktifkan'));
            break;

        case 'cbt-riwayat-siswa':
            if ($method !== 'GET') error('Method not allowed', 405);
            $nis = getParam('nis');
            if (!$nis) error('nis wajib');
            $db = getDB();
            $st = $db->prepare('SELECT u.judul, u.mapel, u.kelas, s.skor AS total, u.tanggal
                FROM cbt_sesi s
                JOIN cbt_ujian u ON u.id = s.ujian_id
                WHERE s.nis=? AND s.selesai=1
                ORDER BY s.id DESC');
            $st->execute([$nis]);
            success($st->fetchAll());
            break;
case 'cbt-cleanup-expired':
    // Endpoint ini dipanggil otomatis setiap 5 menit (atau via cron)
    if ($method !== 'POST') error('Method not allowed', 405);
    $db = getDB();
    
    // Cari semua sesi yang deadline-nya sudah lewat tapi belum selesai
    $st = $db->prepare('SELECT id FROM cbt_sesi WHERE selesai=0 AND deadline < NOW()');
    $st->execute();
    $expired = $st->fetchAll();
    
    $count = 0;
    foreach ($expired as $row) {
        _cbt_finalisasi($db, (int)$row['id']);
        $count++;
    }
    
    success(['finalized' => $count], $count . ' sesi difinalisasi otomatis');
    break;

        // ===================== AI FEATURES =====================
        // FITUR 1: AI Summarizer — ambil data mentah (laporan/tugas) untuk diringkas AI.
        case 'ai-data-summary':
            if ($method !== 'GET') error('Method not allowed', 405);
            $kelas = getParam('kelas');
            $type  = getParam('type') ?? 'dashboard'; // dashboard | tugas | presensi | nilai | jurnal | pengumuman
            $from  = getParam('date_from');
            $to    = getParam('date_to');
            if (!$kelas) error('Parameter kelas wajib diisi');
            $db = getDB();
            $data = ['type' => $type, 'kelas' => $kelas, 'periode' => ($from ?: 'semua') . ' s/d ' . ($to ?: 'sekarang')];
            try {
                switch ($type) {
                    case 'tugas':
                        $where = 'kelas = ?'; $params = [$kelas];
                        if ($from) { $where .= ' AND tanggal >= ?'; $params[] = $from; }
                        if ($to)   { $where .= ' AND tanggal <= ?'; $params[] = $to; }
                        $st = $db->prepare("SELECT id, mapel, judul, deskripsi, tenggat, status FROM tugas WHERE $where ORDER BY tenggat DESC LIMIT 50");
                        $st->execute($params);
                        $data['records'] = $st->fetchAll();
                        break;
                    case 'presensi':
                        $st = $db->prepare('SELECT tanggal, status, COUNT(*) AS c FROM kehadiran WHERE kelas=? GROUP BY tanggal, status ORDER BY tanggal DESC LIMIT 50');
                        $st->execute([$kelas]);
                        $data['records'] = $st->fetchAll();
                        break;
                    case 'nilai':
                        $st = $db->prepare('SELECT nis, nama_siswa AS nama, mapel, AVG(nilai) AS rata, COUNT(*) AS total FROM nilai WHERE kelas=? GROUP BY nis, mapel ORDER BY mapel LIMIT 50');
                        $st->execute([$kelas]);
                        $data['records'] = $st->fetchAll();
                        break;
                    case 'jurnal':
                        $st = $db->prepare('SELECT tanggal, mapel, materi, kegiatan FROM jurnal_mengajar WHERE kelas=? ORDER BY tanggal DESC LIMIT 50');
                        $st->execute([$kelas]);
                        $data['records'] = $st->fetchAll();
                        break;
                    case 'pengumuman':
                        $st = $db->prepare('SELECT judul, isi, tanggal, penulis FROM pengumuman WHERE kelas=? ORDER BY tanggal DESC LIMIT 50');
                        $st->execute([$kelas]);
                        $data['records'] = $st->fetchAll();
                        break;
                    default: // dashboard
                        $today = date('Y-m-d');
                        $st = $db->prepare('SELECT COUNT(*) AS c FROM siswa WHERE kelas=?'); $st->execute([$kelas]);
                        $data['total_siswa'] = (int)$st->fetch()['c'];
                        $st = $db->prepare('SELECT status, COUNT(*) AS c FROM kehadiran WHERE kelas=? AND tanggal=? GROUP BY status'); $st->execute([$kelas, $today]);
                        $pres = ['Hadir'=>0,'Sakit'=>0,'Izin'=>0,'Alfa'=>0];
                        foreach ($st->fetchAll() as $r) $pres[$r['status']] = (int)$r['c'];
                        $data['presensi_hari_ini'] = $pres;
                        $st = $db->prepare('SELECT COUNT(*) AS c FROM tatatertib WHERE kelas=?'); $st->execute([$kelas]);
                        $data['total_pelanggaran'] = (int)$st->fetch()['c'];
                        $st = $db->prepare('SELECT COALESCE(SUM(CASE WHEN jenis="Masuk" THEN jumlah ELSE 0 END),0) AS m, COALESCE(SUM(CASE WHEN jenis="Keluar" THEN jumlah ELSE 0 END),0) AS k FROM kaskelas WHERE kelas=?'); $st->execute([$kelas]);
                        $row = $st->fetch();
                        $data['kas_saldo'] = (float)$row['m'] - (float)$row['k'];
                        break;
                }
                success($data);
            } catch (PDOException $e) { error('Database error: '.$e->getMessage(), 500); }
            break;

        // FITUR 2: Natural Language Search — terima JSON dari GAS, bangun WHERE dinamis.
        // MITIGASI SQL-INJECTION: nama tabel & kolom di-whitelist, semua nilai via prepared stmt.
        case 'ai-search-filter':
            if ($method !== 'POST') error('Method not allowed', 405);
            $body = getBody();
            $kelas  = $body['kelas'] ?? getParam('kelas');
            $table  = $body['table'] ?? '';
            $filters = $body['filters'] ?? [];
            $limit  = isset($body['limit']) ? (int)$body['limit'] : 100;
            $offset = isset($body['offset']) ? (int)$body['offset'] : 0;
            if (!$kelas) error('Parameter kelas wajib diisi');
            if (!$table) error('Parameter table wajib diisi');

            $allowed_tables = ['kehadiran','nilai','tatatertib','jurnal_mengajar','jurnal_bimbingan','siswa','katalog_alat','bahan_praktik','peminjaman','kaskelas','pengumuman','kunjungan_rumah','presensi_mapel','tugas'];
            if (!in_array($table, $allowed_tables)) error('Table tidak diizinkan: '.$table, 400);

            $allowed_fields = [
                'kehadiran'        => ['tanggal','nis','status','keterangan'],
                'nilai'            => ['nis','mapel','jenis','nilai','tanggal'],
                'tatatertib'       => ['tanggal','nis','pelanggaran','poin'],
                'jurnal_mengajar'  => ['tanggal','nip','mapel','jam_ke','materi','kegiatan'],
                'jurnal_bimbingan' => ['tanggal','nis','kategori','isi','tindak_lanjut'],
                'siswa'            => ['nis','nama_siswa','jk','ttl','alamat','no_wa','ekstra'],
                'katalog_alat'     => ['kode','nama_barang','spesifikasi','jumlah','kondisi','lokasi'],
                'bahan_praktik'    => ['kode','nama_bahan','satuan','stok','stok_min','kategori'],
                'peminjaman'       => ['id_pinjam','kode_barang','nama_barang','peminjam','jenis_peminjam','tgl_pinjam','batas_waktu','status','tgl_kembali'],
                'kaskelas'         => ['tanggal','jenis','jumlah','keterangan'],
                'pengumuman'       => ['judul','isi','tanggal','penulis'],
                'kunjungan_rumah'  => ['tanggal','nis','nama_siswa','alamat','hasil','tindak_lanjut','petugas'],
                'presensi_mapel'   => ['tanggal','nis','nip','mapel','status','jam_ke'],
                'tugas'            => ['id','mapel','judul','deskripsi','tenggat','status']
            ];
            $table_fields = $allowed_fields[$table] ?? [];

            $op_map = ['eq'=>'=','neq'=>'!=','gt'=>'>','gte'=>'>=','lt'=>'<','lte'=>'<=','like'=>'LIKE','not_like'=>'NOT LIKE','in'=>'IN','not_in'=>'NOT IN','between'=>'BETWEEN'];

            $db = getDB();
            $where_parts = ['kelas = ?']; $params = [$kelas];
            foreach ($filters as $f) {
                $field = $f['field'] ?? ''; $op = $f['operator'] ?? 'eq'; $val = $f['value'] ?? '';
                if (!$field || !in_array($field, $table_fields)) continue;      // kolom tak dikenal → lewati
                $sql_op = $op_map[$op] ?? '=';
                if ($op === 'between' && is_array($val) && count($val) === 2) {
                    $where_parts[] = "$field $sql_op ? AND ?"; $params[] = $val[0]; $params[] = $val[1];
                } elseif (in_array($op, ['in','not_in']) && is_array($val)) {
                    $phs = implode(',', array_fill(0, count($val), '?'));
                    $where_parts[] = "$field $sql_op ($phs)"; foreach ($val as $v) $params[] = $v;
                } elseif ($op === 'like' || $op === 'not_like') {
                    $where_parts[] = "$field $sql_op ?"; $params[] = '%'.$val.'%';
                } else {
                    $where_parts[] = "$field $sql_op ?"; $params[] = $val;
                }
            }
            $where_sql = implode(' AND ', $where_parts);

            $st = $db->prepare("SELECT COUNT(*) FROM $table WHERE $where_sql");
            $st->execute($params);
            $total = (int)$st->fetchColumn();

            $params[] = $limit; $params[] = $offset;
            $st = $db->prepare("SELECT * FROM $table WHERE $where_sql ORDER BY id DESC LIMIT ? OFFSET ?");
            $st->execute($params);
            $records = $st->fetchAll();

            success(['records'=>$records, 'total'=>$total, 'limit'=>$limit, 'offset'=>$offset, 'table'=>$table]);
            break;

        // ===================== DEFAULT =====================
        default:
            error('Action tidak valid: '.$action, 400);
    }
} catch (PDOException $e) { error('Database error: '.$e->getMessage(), 500); }
catch (Exception $e) { error('Server error: '.$e->getMessage(), 500); }
catch (Error $e) { error('PHP error: '.$e->getMessage(), 500); }
?>