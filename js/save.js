/**
 * Menyimpan hasil ke penyimpanan HP.
 *
 * Di web tidak ada API "tulis ke Galeri". Dua jalur yang benar-benar bekerja:
 *
 *   1. Web Share (level 2) — membuka share sheet bawaan HP, di situ ada
 *      "Simpan ke Foto"/"Save to Photos". Ini jalur paling dekat dengan native,
 *      tapi WAJIB dipanggil langsung dari gestur pengguna.
 *   2. Unduh biasa — berkas mendarat di folder Download. Di Android, gambar &
 *      video di Download ikut terpindai media scanner dan muncul di Galeri.
 *
 * Auto-simpan memakai jalur 2, karena jalur 1 tidak boleh berjalan tanpa gestur.
 */

export function stamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

export function extFor(mime = '') {
  if (mime.includes('mp4')) return 'mp4';
  if (mime.includes('webm')) return 'webm';
  if (mime.includes('png')) return 'png';
  return 'jpg';
}

export function filenameFor(type, mime, date = new Date()) {
  return `DualCam_${type === 'video' ? 'VID' : 'IMG'}_${stamp(date)}.${extFor(mime)}`;
}

export function canShareFiles(blob, name) {
  try {
    const file = new File([blob], name, { type: blob.type });
    return !!(navigator.canShare && navigator.canShare({ files: [file] }));
  } catch { return false; }
}

/** Unduh ke penyimpanan HP. Selalu tersedia. */
export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Beri waktu browser memulai unduhan sebelum URL dicabut.
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/** Share sheet HP. Harus dipanggil dari dalam handler gestur pengguna. */
export async function shareBlob(blob, filename, title = 'DualCam Studio') {
  const file = new File([blob], filename, { type: blob.type });
  if (!canShareFiles(blob, filename)) return 'unsupported';
  try {
    await navigator.share({ files: [file], title });
    return 'shared';
  } catch (err) {
    return err?.name === 'AbortError' ? 'cancelled' : 'failed';
  }
}
