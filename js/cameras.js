/**
 * Penemuan & pembukaan kamera.
 *
 * Tujuannya satu: dapatkan dua MediaStream hidup sekaligus — satu belakang,
 * satu depan. Yang membuat ini sulit bukan izin, melainkan ANGGARAN: lapisan
 * kamera Android mengalokasikan bandwidth sensor dan buffer ISP, dan banyak HP
 * menolak dua stream 1080p sekaligus padahal 1080p + 480p diterima dengan
 * santai. Karena itu pembukaan kamera kedua tidak dicoba sekali lalu menyerah;
 * ia menuruni tangga resolusi, dan kalau masih gagal, kamera pertama ikut
 * diturunkan lalu pasangannya dicoba ulang.
 *
 * Setiap langkah dicatat ke `log` supaya kegagalan di HP nyata bisa dibaca,
 * bukan ditebak.
 *
 * Mode akhir yang dilaporkan:
 *   'dual' — dua feed hidup
 *   'solo' — hanya satu; UI turun ke satu kamera dan menjelaskan sebabnya
 */

// Dari paling tajam ke paling hemat. Rung terakhir sengaja tanpa petunjuk
// ukuran sama sekali: biarkan HP memilih apa pun yang masih sanggup.
const RES_LADDER = [
  { label: '1920×1080', video: { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } } },
  { label: '1280×720',  video: { width: { ideal: 1280 }, height: { ideal: 720 },  frameRate: { ideal: 30 } } },
  { label: '640×480',   video: { width: { ideal: 640 },  height: { ideal: 480 } } },
  { label: '320×240',   video: { width: { ideal: 320 },  height: { ideal: 240 } } },
  { label: 'bebas',     video: {} },
];

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

function shortLabel(label = '') {
  return label.length > 38 ? `${label.slice(0, 35)}…` : (label || '(tanpa label)');
}

function describeSize(stream) {
  const s = stream?.getVideoTracks()[0]?.getSettings?.() ?? {};
  return s.width && s.height ? `${s.width}×${s.height}` : 'ukuran tidak dilaporkan';
}

export class CameraRig extends EventTarget {
  constructor() {
    super();
    this.back = null;
    this.front = null;
    this.audio = null;
    this.mode = 'idle';
    this.reason = '';
    this.devices = [];
    this.log = [];
    this.exclusive = false;   // HP terbukti mematikan kamera pertama demi kedua

    // Dipakai mode bergantian: id perangkat per sisi, supaya tiap sisi bisa
    // dibuka ulang sendiri-sendiri tanpa menebak lagi.
    this.backIds = [];
    this.frontIds = [];
    this.activeSide = 'back';
  }

  /**
   * Dua kamera ada, tapi tidak bisa hidup bersamaan. Inilah kondisi yang
   * membuat mode bergantian masuk akal — dan yang membedakannya dari HP yang
   * memang cuma punya satu kamera.
   */
  get canAlternate() {
    return this.mode === 'solo' && this.frontIds.length > 0;
  }

  get backTrack()  { return this.back?.getVideoTracks()[0] ?? null; }
  get frontTrack() { return this.front?.getVideoTracks()[0] ?? null; }

  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }

  static isLive(stream) {
    const t = stream?.getVideoTracks()[0];
    return !!t && t.readyState === 'live';
  }

  note(msg, ok = null) {
    this.log.push({ msg, ok });
    this.onProgress?.(msg);
  }

  /** Salinan diagnostik yang bisa dibaca manusia dan ditempel ke chat. */
  report() {
    const lines = [
      'DualCam Studio — diagnostik kamera',
      `Waktu    : ${new Date().toISOString()}`,
      `Browser  : ${navigator.userAgent}`,
      `Mode     : ${this.mode}${this.exclusive ? ' (eksklusif)' : ''}`,
      `Kamera   : ${this.devices.length} videoinput terdeteksi`,
      ...this.devices.map((d, i) => `  [${i}] ${shortLabel(d.label)}`),
      '',
      'Langkah:',
      ...this.log.map((l) => `  ${l.ok === true ? '[OK]  ' : l.ok === false ? '[GAGAL]' : '[ .. ] '} ${l.msg}`),
    ];
    if (this.back)  lines.push('', `Belakang aktif: ${describeSize(this.back)}`);
    if (this.front) lines.push(`Depan aktif   : ${describeSize(this.front)}`);
    return lines.join('\n');
  }

  open(constraints) {
    return navigator.mediaDevices.getUserMedia({ audio: false, video: constraints });
  }

  openFacing(facingMode, rung, exact = false) {
    return this.open({ facingMode: exact ? { exact: facingMode } : { ideal: facingMode }, ...rung.video });
  }

  openById(deviceId, rung) {
    return this.open({ deviceId: { exact: deviceId }, ...rung.video });
  }

  /**
   * @param {(msg: string) => void} onProgress dipanggil tiap langkah, untuk UI
   */
  async start(onProgress) {
    this.onProgress = onProgress;
    this.log = [];
    this.exclusive = false;

    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Browser ini tidak mendukung akses kamera. Coba Chrome atau Safari versi terbaru.');
    }

    // ── 1. Kamera belakang ──────────────────────────────────────────────
    let backRung = -1;
    for (let i = 0; i < RES_LADDER.length; i++) {
      try {
        this.back = await this.openFacing('environment', RES_LADDER[i]);
        backRung = i;
        this.note(`Kamera belakang terbuka @ ${RES_LADDER[i].label} → ${describeSize(this.back)}`, true);
        break;
      } catch (err) {
        if (err?.name === 'NotAllowedError') {
          throw new Error('Izin kamera ditolak. Aktifkan lewat ikon gembok di address bar, lalu muat ulang halaman.');
        }
        this.note(`Kamera belakang gagal @ ${RES_LADDER[i].label}: ${err?.name || err}`, false);
      }
    }
    if (!this.back) throw new Error('Tidak ada kamera yang bisa dibuka di perangkat ini.');

    // ── 2. Petakan perangkat (label baru terbuka setelah izin diberikan) ──
    const all = await navigator.mediaDevices.enumerateDevices();
    this.devices = all.filter((d) => d.kind === 'videoinput');
    this.note(`${this.devices.length} kamera terdeteksi`);

    if (this.devices.length < 2) {
      this.finish('solo', 'Hanya satu kamera yang terdeteksi di perangkat ini.');
      return this.mode;
    }

    // ── 3. Susun kandidat kamera depan ──────────────────────────────────
    const backTrack = this.backTrack;
    const backLabel = backTrack?.label || '';
    const backId = backTrack?.getSettings?.().deviceId
      || this.devices.find((d) => d.label && d.label === backLabel)?.deviceId
      || null;

    const candidates = this.devices.filter((d) => d.deviceId && d.deviceId !== backId);
    const byLabel = candidates.filter((d) => labelFacing(d.label) === 'user');
    const ordered = [...byLabel, ...candidates.filter((d) => !byLabel.includes(d))];

    this.backIds = backId ? [backId] : [];
    this.frontIds = ordered.map((d) => d.deviceId);

    // ── 4. Cari pasangan, turun tangga resolusi ─────────────────────────
    let outcome = await this.tryPair(ordered, backLabel, backRung);

    // ── 5. Anggaran gabungan: turunkan kamera belakang, coba lagi ───────
    // Inilah yang menyelamatkan HP yang menolak dua stream besar tapi
    // menerima dua stream kecil.
    // Kalau HP terbukti merebut sensor, menurunkan resolusi tidak akan menolong:
    // masalahnya kepemilikan, bukan anggaran. Berhenti daripada membuka-tutup
    // kamera berkali-kali tanpa guna.
    if (outcome !== 'ok' && !this.exclusive) {
      for (let rung = Math.max(backRung + 1, 1); rung < RES_LADDER.length; rung++) {
        this.note(`Menurunkan kamera belakang ke ${RES_LADDER[rung].label} lalu mencoba pasangan lagi`);
        stopStream(this.back);
        this.back = null;
        try {
          this.back = await this.openFacing('environment', RES_LADDER[rung]);
        } catch (err) {
          this.note(`Gagal membuka ulang kamera belakang @ ${RES_LADDER[rung].label}: ${err?.name || err}`, false);
          continue;
        }
        outcome = await this.tryPair(ordered, this.backTrack?.label || backLabel, rung);
        if (outcome === 'ok') break;
      }
    }

    // ── 6. Pastikan kamera belakang tetap hidup apa pun hasilnya ────────
    if (!CameraRig.isLive(this.back)) {
      this.note('Memulihkan kamera belakang setelah percobaan gagal');
      stopStream(this.back);
      this.back = null;
      for (let i = RES_LADDER.length - 1; i >= 0; i--) {
        try { this.back = await this.openFacing('environment', RES_LADDER[i]); break; }
        catch { /* turun terus sampai ada yang mau */ }
      }
      if (!this.back) throw new Error('Kamera tidak bisa dipulihkan. Tutup aplikasi kamera lain lalu muat ulang.');
    }

    if (outcome === 'ok') {
      this.finish('dual', '');
    } else if (this.exclusive) {
      this.finish('solo', 'HP ini hanya mengizinkan satu kamera aktif pada satu waktu.');
    } else {
      this.finish('solo', 'Kamera kedua menolak dibuka bersamaan, bahkan pada resolusi terendah.');
    }
    return this.mode;
  }

  /**
   * Coba buka satu kamera depan berdampingan dengan kamera belakang yang sudah
   * hidup. Menuruni tangga resolusi untuk tiap kandidat.
   * @returns {'ok'|'none'} 'none' juga dipakai saat HP terbukti eksklusif
   *                        (ditandai lewat this.exclusive)
   */
  async tryPair(ordered, backLabel, startRung) {
    for (const dev of ordered) {
      for (let i = startRung; i < RES_LADDER.length; i++) {
        const rung = RES_LADDER[i];
        let candidate;
        try {
          candidate = await this.openById(dev.deviceId, rung);
        } catch (err) {
          this.note(`Depan "${shortLabel(dev.label)}" gagal @ ${rung.label}: ${err?.name || err}`, false);
          continue;
        }

        const track = candidate.getVideoTracks()[0];

        // Perangkat yang sama terbuka dua kali bukan dual camera — sebagian
        // browser tidak melaporkan deviceId, jadi label jadi penjaga terakhir.
        if (track?.label && backLabel && track.label === backLabel) {
          stopStream(candidate);
          this.note(`"${shortLabel(dev.label)}" ternyata kamera yang sama — dilewati`, false);
          break;
        }

        if (trackFacing(track) === 'environment' && ordered.length > 1) {
          stopStream(candidate);
          this.note(`"${shortLabel(dev.label)}" ternyata lensa belakang lain — dilewati`, false);
          break;
        }

        // Momen penentu: sebagian HP membunuh kamera pertama diam-diam.
        if (!CameraRig.isLive(this.back)) {
          stopStream(candidate);
          this.exclusive = true;
          this.note(`Kamera belakang MATI saat depan dibuka @ ${rung.label} — HP ini eksklusif`, false);
          return 'none';
        }

        this.front = candidate;
        this.note(`Depan "${shortLabel(dev.label)}" terbuka @ ${rung.label} → ${describeSize(candidate)}`, true);
        this.note('DUA KAMERA HIDUP BERSAMAAN', true);
        return 'ok';
      }
    }
    return 'none';
  }

  finish(mode, reason) {
    this.mode = mode;
    this.reason = reason;
    if (mode === 'solo') { stopStream(this.front); this.front = null; }
    this.watchTracks();
    this.emit('change', { mode, reason });
  }

  /**
   * Mode bergantian: jadikan SATU sisi aktif, tutup yang lain.
   *
   * Ini jalur untuk HP yang menolak dua kamera sekaligus. Karena hanya satu
   * stream yang pernah terbuka, tidak ada anggaran yang dilanggar dan tidak ada
   * sensor yang direbut — jadi ia bekerja di mana saja, termasuk iOS.
   *
   * @param {'back'|'front'} side
   * @returns {Promise<boolean>} berhasil atau tidak
   */
  async openSide(side) {
    stopStream(this.back);
    stopStream(this.front);
    this.back = null;
    this.front = null;

    const ids = side === 'back' ? this.backIds : this.frontIds;
    const facing = side === 'back' ? 'environment' : 'user';

    for (const deviceId of ids) {
      for (const rung of RES_LADDER) {
        try {
          const stream = await this.openById(deviceId, rung);
          this.adopt(side, stream);
          return true;
        } catch { /* rung berikutnya */ }
      }
    }

    // Tanpa deviceId yang cocok, minta lewat facingMode.
    for (const exact of [true, false]) {
      for (const rung of RES_LADDER) {
        try {
          const stream = await this.openFacing(facing, rung, exact);
          this.adopt(side, stream);
          return true;
        } catch { /* terus turun */ }
      }
    }

    this.note(`Gagal membuka sisi "${side}" di mode bergantian`, false);
    return false;
  }

  adopt(side, stream) {
    if (side === 'back') this.back = stream; else this.front = stream;
    this.activeSide = side;
  }

  /** Sumber video yang sedang hidup, apa pun sisinya. */
  get liveStream() {
    return this.activeSide === 'back' ? this.back : this.front;
  }

  /** Audio terpisah supaya prompt kamera tidak tertahan kalau mic ditolak. */
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
      if (!track || track.__watched) continue;
      track.__watched = true;
      track.addEventListener('ended', () => {
        if (key === 'front' && this.mode === 'dual') {
          this.front = null;
          this.mode = 'solo';
          this.exclusive = true;
          this.reason = 'Kamera depan dilepas oleh sistem di tengah jalan.';
          this.note('Kamera depan berakhir sendiri setelah sempat hidup', false);
          this.emit('change', { mode: this.mode, reason: this.reason });
        }
      }, { once: true });
    }
  }

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
