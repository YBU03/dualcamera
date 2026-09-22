/**
 * Penemuan & pembukaan kamera.
 *
 * Tujuannya satu: dapatkan dua MediaStream hidup sekaligus — satu belakang,
 * satu depan. Kenyataannya tidak semua HP mengizinkan itu: sebagian Android
 * membiarkannya, sebagian menolak permintaan kedua, dan sebagian lagi diam-diam
 * mematikan stream pertama begitu yang kedua dibuka. iOS/Safari hanya mengizinkan
 * satu kamera aktif pada satu waktu.
 *
 * Karena itu modul ini selalu melaporkan `mode`:
 *   'dual' — dua feed hidup, layout dual-cam penuh
 *   'solo' — hanya satu feed; UI turun ke satu kamera dan menjelaskan kenapa
 */

const VIDEO_IDEAL = { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } };

const FRONT_HINTS = ['front', 'user', 'facetime', 'depan', 'selfie'];
const BACK_HINTS  = ['back', 'rear', 'environment', 'belakang', 'world'];

function labelFacing(label = '') {
  const l = label.toLowerCase();
  if (FRONT_HINTS.some((h) => l.includes(h))) return 'user';
  if (BACK_HINTS.some((h) => l.includes(h))) return 'environment';
  return null;
}

function trackFacing(track) {
  if (!track) return null;
  const s = track.getSettings?.() ?? {};
  if (s.facingMode === 'user' || s.facingMode === 'environment') return s.facingMode;
  const caps = track.getCapabilities?.() ?? {};
  if (Array.isArray(caps.facingMode) && caps.facingMode.length === 1) {
    const f = caps.facingMode[0];
    if (f === 'user' || f === 'environment') return f;
  }
  return labelFacing(track.label);
}

function stopStream(stream) {
  stream?.getTracks().forEach((t) => { try { t.stop(); } catch { /* sudah mati */ } });
}

async function openById(deviceId) {
  return navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { deviceId: { exact: deviceId }, ...VIDEO_IDEAL },
  });
}

async function openByFacing(facingMode, exact = false) {
  return navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { facingMode: exact ? { exact: facingMode } : { ideal: facingMode }, ...VIDEO_IDEAL },
  });
}

export class CameraRig extends EventTarget {
  constructor() {
    super();
    this.back = null;        // MediaStream kamera belakang
    this.front = null;       // MediaStream kamera depan
    this.audio = null;       // MediaStream audio (untuk rekaman)
    this.mode = 'idle';      // 'idle' | 'dual' | 'solo'
    this.reason = '';        // penjelasan kalau turun ke solo
    this.devices = [];
  }

  get backTrack()  { return this.back?.getVideoTracks()[0] ?? null; }
  get frontTrack() { return this.front?.getVideoTracks()[0] ?? null; }

  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }

  /** Apakah stream masih benar-benar hidup? (HP bisa mematikannya diam-diam) */
  static isLive(stream) {
    const t = stream?.getVideoTracks()[0];
    return !!t && t.readyState === 'live';
  }

  async start() {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Browser ini tidak mendukung akses kamera. Coba Chrome atau Safari versi terbaru.');
    }

    // Langkah 1 — kamera belakang dulu. Ini juga yang memicu prompt izin,
    // dan tanpa izin label perangkat masih kosong sehingga tidak bisa dipilah.
    let back;
    try {
      back = await openByFacing('environment');
    } catch (err) {
      if (err?.name === 'NotAllowedError') {
        throw new Error('Izin kamera ditolak. Aktifkan lewat ikon gembok di address bar, lalu muat ulang.');
      }
      if (err?.name === 'NotFoundError') {
        throw new Error('Tidak ada kamera yang terdeteksi di perangkat ini.');
      }
      throw new Error(`Kamera tidak bisa dibuka: ${err?.message || err}`);
    }
    this.back = back;

    // Langkah 2 — sekarang label sudah terbuka, petakan perangkatnya.
    const all = await navigator.mediaDevices.enumerateDevices();
    this.devices = all.filter((d) => d.kind === 'videoinput');
    const backTrack = this.backTrack;
    const backLabel = backTrack?.label || '';
    // Sebagian browser tidak melaporkan deviceId di getSettings(); label jadi
    // cadangan supaya kamera yang sama tidak terbuka dua kali dan salah dibaca
    // sebagai dua kamera berbeda.
    const backId = backTrack?.getSettings?.().deviceId
      || this.devices.find((d) => d.label && d.label === backLabel)?.deviceId
      || null;

    let front = null;

    // Langkah 3 — cari kandidat kamera depan. Satu perangkat berarti tidak ada
    // yang perlu dicari; mencoba tetap membuka hanya akan menduplikasi feed.
    if (this.devices.length >= 2) {
      const candidates = this.devices.filter((d) => d.deviceId && d.deviceId !== backId);
      const byLabel = candidates.filter((d) => labelFacing(d.label) === 'user');
      const ordered = [...byLabel, ...candidates.filter((d) => !byLabel.includes(d))];

      for (const dev of ordered) {
        let candidate = null;
        try { candidate = await openById(dev.deviceId); }
        catch { continue; }   // perangkat sibuk atau ditolak — coba berikutnya

        const track = candidate.getVideoTracks()[0];
        const sameCamera = track?.label && backLabel && track.label === backLabel;
        const wrongSide = trackFacing(track) === 'environment' && ordered.length > 1;

        if (sameCamera || wrongSide) { stopStream(candidate); continue; }
        front = candidate;
        break;
      }

      // Jalur terakhir: minta 'user' secara eksplisit tanpa deviceId.
      if (!front) {
        try {
          const candidate = await openByFacing('user', true);
          const label = candidate.getVideoTracks()[0]?.label;
          if (label && backLabel && label === backLabel) stopStream(candidate);
          else front = candidate;
        } catch { /* memang tidak bisa */ }
      }
    }

    // Langkah 4 — verifikasi kamera belakang selamat dari pembukaan kedua.
    if (front && !CameraRig.isLive(this.back)) {
      stopStream(this.back);
      this.back = front;
      this.front = null;
      this.mode = 'solo';
      this.reason = 'HP ini hanya mengizinkan satu kamera aktif pada satu waktu.';
    } else if (front) {
      this.front = front;
      this.mode = 'dual';
      this.reason = '';
    } else {
      this.front = null;
      this.mode = 'solo';
      this.reason = this.devices.length < 2
        ? 'Hanya satu kamera yang terdeteksi di perangkat ini.'
        : 'Kamera kedua tidak bisa dibuka bersamaan di HP ini.';
    }

    this.watchTracks();
    this.emit('change', { mode: this.mode, reason: this.reason });
    return this.mode;
  }

  /** Audio diminta terpisah supaya prompt kamera tidak ikut tertahan kalau mic ditolak. */
  async ensureAudio() {
    if (this.audio && this.audio.getAudioTracks()[0]?.readyState === 'live') return this.audio;
    try {
      this.audio = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
        video: false,
      });
    } catch {
      this.audio = null;
    }
    return this.audio;
  }

  releaseAudio() { stopStream(this.audio); this.audio = null; }

  watchTracks() {
    for (const [key, stream] of [['back', this.back], ['front', this.front]]) {
      const track = stream?.getVideoTracks()[0];
      if (!track) continue;
      track.addEventListener('ended', () => {
        if (key === 'front' && this.mode === 'dual') {
          this.front = null;
          this.mode = 'solo';
          this.reason = 'Kamera depan dilepas oleh sistem (mungkin dipakai aplikasi lain).';
          this.emit('change', { mode: this.mode, reason: this.reason });
        }
      }, { once: true });
    }
  }

  /** Kemampuan opsional: senter, zoom. Tidak semua HP punya. */
  capabilities() {
    const caps = this.backTrack?.getCapabilities?.() ?? {};
    return {
      torch: 'torch' in caps,
      zoom: 'zoom' in caps ? { min: caps.zoom.min, max: caps.zoom.max, step: caps.zoom.step || 0.1 } : null,
    };
  }

  async setTorch(on) {
    const track = this.backTrack;
    if (!track) return false;
    try { await track.applyConstraints({ advanced: [{ torch: on }] }); return true; }
    catch { return false; }
  }

  async setZoom(value) {
    const track = this.backTrack;
    if (!track) return false;
    try { await track.applyConstraints({ advanced: [{ zoom: value }] }); return true; }
    catch { return false; }
  }

  stop() {
    stopStream(this.back);
    stopStream(this.front);
    stopStream(this.audio);
    this.back = this.front = this.audio = null;
    this.mode = 'idle';
  }
}
