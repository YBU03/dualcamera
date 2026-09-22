# DualCam Studio

Aplikasi kamera ganda: merekam **kamera depan dan belakang sekaligus** dalam satu
bingkai, dengan layout yang bisa diatur, lalu menyimpan hasilnya langsung ke HP.
Dibuat sebagai PWA — dipasang ke home screen, jalan penuh tanpa internet.

Desain mengikuti sistem **Atelier Titanium Ice**: obsidian gelap, frosted glass,
tombol pill, dan tipografi metrik Apple HIG.

---

## Cara pakai

1. Buka alamat aplikasi di **Chrome** (Android) atau **Safari** (iPhone).
2. Ketuk **Mulai Kamera**, izinkan akses kamera & mikrofon.
3. Menu browser → **Add to Home Screen** / **Tambahkan ke Layar Utama**.
   Setelah itu aplikasi punya ikon sendiri, layar penuh, dan jalan offline.

> Harus lewat **HTTPS** (atau `localhost`). Browser tidak mengizinkan akses
> kamera di `http://` biasa maupun dari berkas `file://`.

### Menjalankan secara lokal

```bash
npx serve .          # lalu buka http://localhost:3000
```

Untuk mencoba dari HP di jaringan yang sama, dibutuhkan HTTPS — cara tercepat
adalah menaruhnya di hosting statis (GitHub Pages, Netlify, Vercel, Cloudflare
Pages). Tidak ada proses build: seluruh isi repo ini langsung bisa disajikan.

---

## Fitur

**Kamera**
- Dua feed hidup digabung ke satu bingkai secara realtime.
- Foto (JPEG) dan video (MP4/H.264 bila didukung, jika tidak WebM) bersuara.
- Timer 3/5/10 detik, garis bantu sepertiga, senter, zoom optik
  (muncul hanya kalau kameranya memang mendukung).

**Layout** — enam komposisi, semuanya bisa disetel:

| Layout | Bentuk |
|---|---|
| Split Vertical | kiri-kanan, rasio digeser 20–80% |
| Split Horizontal | atas-bawah, rasio digeser |
| PiP Circle | bubble selfie bundar, posisi bebas |
| PiP Rounded | inset kotak membulat, posisi bebas |
| Diagonal Slash | potongan miring |
| Reaction Strip | adegan besar + strip reaksi ala streamer |

Pengaturan: **Tukar** posisi depan⇄belakang, ukuran PiP, tebal garis, radius
sudut, neon rim, cermin kamera depan, rasio bingkai (9:16 / 3:4 / 1:1), dan
kualitas (720 / 1080 / 1440). Kotak PiP bisa **digeser langsung dengan jari** di
layar kamera. Semua tersimpan otomatis untuk sesi berikutnya.

**Galeri** — semua hasil tersimpan lokal di HP (IndexedDB), bisa dibuka,
dibagikan lewat share sheet, diunduh ulang, atau dihapus. Tidak ada apa pun yang
diunggah ke mana pun.

---

## Menyimpan ke HP

Web tidak punya API untuk menulis langsung ke aplikasi Galeri, jadi dipakai dua
jalur yang benar-benar bekerja:

- **Auto-simpan** (aktif secara bawaan) — berkas diunduh ke folder *Download*.
  Di Android, foto & video di folder itu ikut terpindai dan muncul di Galeri.
- **Bagikan** di layar galeri — membuka share sheet bawaan HP, yang memuat
  opsi *Simpan ke Foto*. Tombol ini hanya muncul kalau browsernya mendukung,
  dan harus ditekan langsung (syarat gestur pengguna dari browser).

---

## Soal dukungan dual-camera

Membuka dua kamera sekaligus tidak dijamin oleh spesifikasi web. Yang membuatnya
sulit bukan izin, melainkan **anggaran**: lapisan kamera Android mengalokasikan
bandwidth sensor dan buffer ISP, dan banyak HP menolak dua stream 1080p sekaligus
padahal 1080p + 480p diterima tanpa masalah.

Karena itu kamera kedua tidak dicoba sekali lalu menyerah. Negosiasinya bertahap:

1. Kamera kedua dicoba menuruni tangga resolusi — 1080p → 720p → 480p → 240p →
   tanpa petunjuk ukuran sama sekali.
2. Kalau semuanya ditolak, kamera **pertama** ikut diturunkan lalu pasangannya
   dicoba ulang, untuk HP yang punya anggaran gabungan.
3. Setiap percobaan memverifikasi kamera pertama masih hidup — sebagian HP
   merebut sensor dan mematikan stream lama diam-diam. Begitu itu terbukti,
   percobaan dihentikan (menurunkan resolusi tidak menolong kalau masalahnya
   kepemilikan) dan kamera pertama dipulihkan.

Kalau semua jalur buntu tapi perangkatnya **punya** dua kamera, aplikasi tidak
menyerah ke mode solo — ia beralih ke **mode bergantian** (lihat di bawah).
Mode solo hanya dipakai kalau memang cuma ada satu kamera.

Perkiraan per platform:

- **Android + Chrome** — sering berhasil, kerap hanya setelah kamera kedua
  diturunkan resolusinya. Sebagian HP tetap menolak.
- **iPhone / Safari** — hanya satu kamera aktif pada satu waktu. Ini batasan
  Apple, bukan bug, dan tidak ada jalan memutarnya lewat web. Selalu bergantian.

## Mode bergantian

Untuk perangkat yang tidak bisa membuka dua kamera serentak, kedua kamera tetap
dipakai — hanya tidak pada saat yang sama. Karena hanya satu stream yang pernah
terbuka, tidak ada anggaran yang dilanggar dan tidak ada sensor yang direbut,
sehingga cara ini bekerja **di mana saja, termasuk iPhone**.

**Pratinjau.** Sisi yang aktif tampil hidup; sisi lain memakai frame terakhir
yang dibekukan. Chip `HIDUP: BELAKANG` menandai mana yang sedang hidup, dan
mengetuknya menukar sisi aktif.

**Saat rana ditekan**, aplikasi menjalankan urutan ini sendiri:

1. Bekukan frame sisi yang sedang hidup.
2. Pindah ke sisi lain.
3. Tunggu ±700 ms — kamera yang baru dibuka butuh waktu menyetel eksposur dan
   fokus; menjepret terlalu cepat menghasilkan frame gelap atau buram.
4. Bekukan frame sisi itu juga.
5. Gabungkan keduanya sesuai layout, simpan, lalu kembalikan pratinjau.

Hasilnya foto dual-cam sungguhan dengan kedua kamera segar — hanya saja keduanya
terpaut sekitar satu detik, bukan serentak. Setiap hasil menyimpan penanda
`capture: "bergantian"` atau `"serentak"` sehingga asal-usulnya jelas.

**Video** di mode ini merekam sisi yang hidup saja; sisi lain tetap sebagai foto
diam di dalam bingkai. Aplikasi mengatakannya sekali saat rekaman pertama
dimulai.

### Panel diagnostik

Layout → **Diagnostik Kamera** menampilkan laporan lengkap: daftar kamera yang
terdeteksi, setiap percobaan pembukaan beserta resolusi dan nama error-nya, serta
resolusi akhir kedua feed. Ada tombol **Salin Laporan** dan **Coba Buka Ulang**
(berguna kalau aplikasi lain sempat memegang kamera). Saat mode solo, tombol
**Kenapa?** di pemberitahuan membuka panel yang sama.

---

## Struktur

```
index.html              app shell — tiga view + tab bar
css/fonts.css           Inter di-host sendiri (offline)
css/tokens.css          token desain Atelier Titanium Ice
css/app.css             seluruh gaya komponen
js/app.js               perekat: state, UI, alur pengambilan gambar
js/cameras.js           penemuan perangkat, buka dua stream, deteksi mode solo
js/layouts.js           geometri enam layout (murni, tanpa DOM)
js/compositor.js        menggambar kedua feed ke kanvas keluaran
js/recorder.js          MediaRecorder di atas canvas.captureStream()
js/storage.js           galeri IndexedDB
js/save.js              unduh + share sheet
sw.js                   service worker, cache-first untuk offline
```

Kanvas compositor sekaligus menjadi viewfinder **dan** sumber rekaman, jadi hasil
yang tersimpan persis sama dengan yang terlihat di layar — tidak ada jalur render
kedua yang bisa melenceng.

---

## Belum ada

**Photobox** (sesi 4 jepretan beruntun, strip foto, frame & stiker, format cetak)
sudah punya tempat di tab bar tapi belum diaktifkan — direncanakan untuk tahap
berikutnya.
