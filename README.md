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

Membuka dua kamera sekaligus tidak dijamin oleh spesifikasi web, dan hasilnya
berbeda-beda per perangkat:

- **Android + Chrome** — umumnya berhasil; ini target utama aplikasi.
- **iPhone / Safari** — hanya satu kamera aktif pada satu waktu.
- Sebagian HP diam-diam mematikan stream pertama saat yang kedua dibuka.

Aplikasi menangani ketiganya: ia memverifikasi kamera pertama masih hidup
setelah yang kedua dibuka, dan kalau tidak, turun ke **mode solo** —
satu kamera, pemberitahuan yang menjelaskan sebabnya, dan foto serta video tetap
bisa diambil dan disimpan. Status di atas layar selalu menyebut mode yang aktif.

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
