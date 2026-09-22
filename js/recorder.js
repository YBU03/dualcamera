/**
 * Perekam video dari kanvas compositor.
 *
 * captureStream() mengambil kanvas yang sudah tergabung, jadi rekaman persis
 * sama dengan viewfinder. Audio diambil dari mikrofon dan digabung ke stream
 * yang sama supaya MediaRecorder menghasilkan satu berkas bersuara.
 */

// Diurutkan dari yang paling kompatibel dengan galeri HP. MP4/H.264 bisa dibuka
// aplikasi galeri mana pun; WebM hanya jalan di sebagian pemutar Android.
const CANDIDATES = [
  'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
  'video/mp4;codecs=avc1',
  'video/mp4',
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
];

export function pickMimeType() {
  if (typeof MediaRecorder === 'undefined') return null;
  for (const type of CANDIDATES) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  return '';   // biarkan browser memilih sendiri
}

export class CanvasRecorder extends EventTarget {
  constructor(canvas, fps = 30) {
    super();
    this.canvas = canvas;
    this.fps = fps;
    this.recorder = null;
    this.chunks = [];
    this.startedAt = 0;
    this.stream = null;
    this._timer = 0;
  }

  get isRecording() { return this.recorder?.state === 'recording'; }
  get elapsed() { return this.startedAt ? Date.now() - this.startedAt : 0; }

  /**
   * @param {MediaStream|null} audioStream mikrofon, boleh null (rekam tanpa suara)
   */
  start(audioStream) {
    if (this.isRecording) return;
    if (typeof MediaRecorder === 'undefined') {
      throw new Error('Browser ini tidak mendukung perekaman video.');
    }

    const stream = this.canvas.captureStream(this.fps);
    const audioTrack = audioStream?.getAudioTracks?.()[0];
    if (audioTrack && audioTrack.readyState === 'live') stream.addTrack(audioTrack);
    this.stream = stream;

    const mimeType = pickMimeType();
    const opts = { videoBitsPerSecond: 8_000_000 };
    if (mimeType) opts.mimeType = mimeType;

    let recorder;
    try {
      recorder = new MediaRecorder(stream, opts);
    } catch {
      recorder = new MediaRecorder(stream);   // paksa default kalau opsi ditolak
    }

    this.chunks = [];
    recorder.ondataavailable = (e) => { if (e.data?.size) this.chunks.push(e.data); };
    recorder.onerror = (e) => this.dispatchEvent(new CustomEvent('error', { detail: e.error || e }));
    recorder.onstop = () => {
      const type = recorder.mimeType || mimeType || 'video/webm';
      const blob = new Blob(this.chunks, { type });
      this.chunks = [];
      // Track video dari captureStream milik kita sendiri; track audio dipinjam
      // dari rig dan tidak boleh dimatikan di sini.
      this.stream?.getVideoTracks().forEach((t) => t.stop());
      this.stream = null;
      const duration = this.elapsed;
      this.startedAt = 0;
      this.dispatchEvent(new CustomEvent('complete', { detail: { blob, duration, type } }));
    };

    // Potongan 1 detik: kalau tab mati mendadak, yang sudah masuk tidak hilang semua.
    recorder.start(1000);
    this.recorder = recorder;
    this.startedAt = Date.now();

    this._timer = setInterval(() => {
      this.dispatchEvent(new CustomEvent('tick', { detail: { elapsed: this.elapsed } }));
    }, 200);
  }

  stop() {
    clearInterval(this._timer);
    this._timer = 0;
    if (this.recorder?.state !== 'inactive') {
      try { this.recorder.stop(); } catch { /* sudah berhenti */ }
    }
  }
}

export function formatDuration(ms) {
  const total = Math.floor(ms / 1000);
  const m = String(Math.floor(total / 60)).padStart(2, '0');
  const s = String(total % 60).padStart(2, '0');
  return `${m}:${s}`;
}
