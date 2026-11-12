# Henkaramazov Panel (Ptero Android Multi-Server)

Panel web lokal untuk mengelola beberapa project Node.js (Termux/Android, Linux, macOS, Windows). Ini panel custom, bukan Pterodactyl/Wings resmi.

## Fitur

- **Daftar Server**: buat server baru, tambahkan folder yang sudah ada, pilih server, Start/Stop, status aktual dari proses nyata.
- **Console**: log real-time (Socket.IO, dengan fallback polling), warna berbeda untuk output/error/sistem/input, input ke stdin proses, auto-scroll, tombol bersihkan.
- **File Manager**: browse folder + breadcrumb, buat file/folder, editor kode (CodeMirror, syntax highlighting), rename, download (file, atau folder sebagai ZIP), upload multi-file dengan progres, hapus, pilih banyak (Pilih Semua/Batal Pilih), buat ZIP dari pilihan, upload ZIP lalu ekstrak, ukuran/tipe/waktu ubah.
- **Setting Server**: info server, rename, hapus server (pilih: konfigurasi saja, atau konfigurasi + data).
- Navbar atas (logo + Henkaramazov + Keluar) dan navbar bawah 4 menu, responsif HP/desktop, tema gelap hitam-hijau.

## Menjalankan di localhost

Butuh Node.js 18 atau lebih baru.

```bash
cd ptero-android-multi
npm install
cp .env.example .env        # Windows: copy .env.example .env
# edit .env: GANTI PANEL_PASSWORD dan SESSION_SECRET
npm start
```

Buka **http://127.0.0.1:3000** lalu login dengan `PANEL_PASSWORD`. File `.env` dibaca otomatis (tidak perlu `source`). Variabel yang sudah diset di terminal tetap diprioritaskan, mis. `PORT=4000 npm start`.

Untuk Termux: `pkg install nodejs-lts -y`, lalu langkah yang sama. Gunakan `termux-wake-lock` agar proses tidak dimatikan Android.

### Logo

Letakkan file logo Anda di **`public/assets/logo.jpg`**. Jika file belum ada, panel menampilkan huruf "H" sebagai pengganti sementara.

### Syntax highlighting offline (opsional)

Editor memuat CodeMirror 5.65.16 dari cdnjs. Jika perangkat tanpa internet, salin file CodeMirror ke `public/assets/vendor/codemirror/` dengan struktur yang sama seperti cdnjs (`codemirror.min.js`, `codemirror.min.css`, `mode/javascript/javascript.min.js`, dst.). Jika tidak tersedia sama sekali, editor otomatis memakai textarea biasa (tetap bisa mengedit dan menyimpan).

## Konfigurasi (`.env`)

| Variabel | Default | Keterangan |
|---|---|---|
| `PANEL_PASSWORD` | wajib | Password login |
| `SESSION_SECRET` | wajib | String acak panjang |
| `HOST` / `PORT` | `127.0.0.1` / `3000` | Alamat bind |
| `MAX_UPLOAD_MB` | `200` | Batas ukuran satu upload |
| `MAX_EXTRACT_MB` | `1024` | Batas total ukuran hasil ekstraksi ZIP |
| `MAX_ZIP_ENTRIES` | `20000` | Batas jumlah entri ZIP saat ekstraksi |

## Cara kerja penting

- **Console** terhubung ke proses `npm start` yang benar-benar berjalan di `servers/<id>`. Input dikirim ke **stdin** proses itu, bukan ke shell, sehingga tidak ada eksekusi perintah arbitrer dari browser. Instal dependency (`npm install`) lakukan lewat terminal.
- **Status** server berasal dari proses nyata; jika proses mati, status otomatis menjadi Offline. Stop mengirim SIGTERM ke seluruh grup proses (lalu SIGKILL setelah 5 detik).
- **Hapus server**: default hanya menghapus konfigurasi, folder `servers/<id>` tetap ada dan bisa ditambahkan lagi lewat *Tambah Server -> Tambahkan folder yang sudah ada*. Menghapus data butuh memilih opsi eksplisit dan mengetik ID server.
- **Rename server** hanya mengubah nama tampilan; ID dan folder tidak berubah.
- Data server tersimpan di `data/servers.json` (persisten); file project di `servers/<id>`.
- **Keluar** mengakhiri sesi login dan kembali ke halaman login. Server yang sedang berjalan tidak dihentikan.

## Keamanan

- Semua operasi file dibatasi ke folder server: path ".." dan absolut ditolak, symlink yang keluar dari folder ditolak.
- ZIP: tahan ZIP Slip (path berbahaya menolak seluruh arsip), symlink dalam arsip dilewati, batas ukuran/jumlah entri (anti zip bomb), CRC diverifikasi, ekstraksi lewat staging sehingga arsip rusak tidak meninggalkan hasil sebagian. File yang akan tertimpa butuh konfirmasi.
- Upload ditulis ke file sementara lalu di-rename (atomik); upload terputus tidak merusak file lama.
- Proses anak tidak mewarisi `PANEL_PASSWORD` dan `SESSION_SECRET`.
- Cookie sesi `httpOnly` + `sameSite=strict`, pengecekan Origin untuk request yang mengubah data, rate limit login (5 gagal/menit), header CSP.
- Panel tidak memakai HTTPS sendiri. Jangan ekspos langsung ke internet; jika `HOST=0.0.0.0`, gunakan hanya di jaringan tepercaya.

## Batasan

- ZIP64 (arsip/berkas > 4 GB atau > 65.535 entri) tidak didukung; ZIP terenkripsi password tidak didukung.
- Progres ekstraksi/pembuatan ZIP berupa indikator berjalan (bukan persentase); upload dan download file punya persentase.
- Editor membuka file teks UTF-8 hingga 1 MB. File biner/besar: gunakan Download.
- Panel mengelola proses Node.js, bukan container Docker.

## Tes

```bash
npm test
```

Menjalankan unit test untuk lapisan file aman dan ZIP (buat/ekstrak, ZIP Slip, symlink, zip bomb, CRC rusak, konflik). Beberapa tes memakai `unzip`, `zip`, dan `python3` bila tersedia untuk verifikasi silang.

## Struktur

```
app.js              server Express + Socket.IO + API
lib/files.js        operasi file aman (path, rename, upload, dll.)
lib/zip.js          pembuat & pengekstrak ZIP (tanpa dependensi tambahan)
lib/env.js          pemuat .env
public/index.html   kerangka halaman
public/assets/      style.css, core.js, files.js, app.js (+ logo.jpg milik Anda)
test/               unit test
```
