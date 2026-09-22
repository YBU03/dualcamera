/**
 * Compositor: menggambar kedua feed ke satu kanvas sesuai layout.
 *
 * Kanvas ini sekaligus jadi viewfinder DAN sumber rekaman, jadi apa yang
 * dilihat pengguna persis sama dengan yang tersimpan — tidak ada jalur render
 * kedua yang bisa melenceng.
 */

import { computeSlots, outputSize, hitTestDraggable } from './layouts.js';

/** Gambar video ke kotak tujuan dengan perilaku object-fit: cover. */
function drawCover(ctx, src, dx, dy, dw, dh, mirror) {
  const sw = src.videoWidth, sh = src.videoHeight;
  if (!sw || !sh || dw <= 0 || dh <= 0) return;

  const scale = Math.max(dw / sw, dh / sh);
  const cw = dw / scale, ch = dh / scale;          // ukuran potongan di sumber
  const sx = (sw - cw) / 2, sy = (sh - ch) / 2;    // dipusatkan

  if (mirror) {
    ctx.save();
    ctx.translate(dx + dw, dy);
    ctx.scale(-1, 1);
    ctx.drawImage(src, sx, sy, cw, ch, 0, 0, dw, dh);
    ctx.restore();
  } else {
    ctx.drawImage(src, sx, sy, cw, ch, dx, dy, dw, dh);
  }
}

function pathFor(ctx, slot, radius) {
  ctx.beginPath();
  if (slot.shape === 'circle') {
    ctx.arc(slot.cx, slot.cy, slot.r, 0, Math.PI * 2);
  } else if (slot.shape === 'poly') {
    slot.pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
  } else if (slot.rounded && radius > 0) {
    const r = Math.min(radius, slot.w / 2, slot.h / 2);
    if (ctx.roundRect) ctx.roundRect(slot.x, slot.y, slot.w, slot.h, r);
    else {
      const { x, y, w, h } = slot;
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + w, y, x + w, y + h, r);
      ctx.arcTo(x + w, y + h, x, y + h, r);
      ctx.arcTo(x, y + h, x, y, r);
      ctx.arcTo(x, y, x + w, y, r);
      ctx.closePath();
    }
  } else {
    ctx.rect(slot.x, slot.y, slot.w, slot.h);
  }
}

const PLACEHOLDER = '#0d1220';

export class Compositor {
  /**
   * @param {HTMLCanvasElement} canvas  kanvas keluaran (resolusi penuh)
   * @param {object} tuning             objek tuning bersama (dibaca tiap frame)
   */
  constructor(canvas, tuning) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
    this.tuning = tuning;
    this.videoA = null;   // elemen <video> feed utama
    this.videoB = null;
    this.slots = [];
    this.running = false;
    this.showGrid = false;
    this.fps = 0;
    this._frames = 0;
    this._fpsAt = 0;
    this._raf = 0;
  }

  /** Pasang dua elemen video sumber. B boleh null (mode solo). */
  setSources(videoA, videoB) {
    this.videoA = videoA;
    this.videoB = videoB;
  }

  resize() {
    const { w, h } = outputSize(this.tuning.aspect, this.tuning.quality);
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    return { w, h };
  }

  start() {
    if (this.running) return;
    this.running = true;
    this._fpsAt = performance.now();
    const loop = () => {
      if (!this.running) return;
      this.drawFrame();
      this._raf = requestAnimationFrame(loop);
    };
    this._raf = requestAnimationFrame(loop);
  }

  stop() {
    this.running = false;
    cancelAnimationFrame(this._raf);
  }

  drawFrame() {
    const { ctx, tuning } = this;
    const { w: W, h: H } = this.resize();
    const solo = !this.videoB;

    // Mode solo: satu feed memenuhi bingkai, tidak ada geometri layout.
    const slots = solo
      ? [{ slot: 'A', shape: 'rect', x: 0, y: 0, w: W, h: H }]
      : computeSlots(tuning.layout, W, H, tuning);
    this.slots = slots;

    ctx.fillStyle = PLACEHOLDER;
    ctx.fillRect(0, 0, W, H);

    // Tuning dinyatakan pada lebar acuan 1080 supaya konsisten di semua kualitas.
    const k = W / 1080;
    const border = Math.round((tuning.border ?? 0) * k);
    const radius = Math.round((tuning.radius ?? 0) * k);

    for (const slot of slots) {
      if (slot.divider) continue;

      // 'swapped' hanya menukar kamera mana yang mengisi slot A dan B.
      // Di mode solo tidak ada yang bisa ditukar — satu feed mengisi bingkai.
      const feedsFront = !solo && (tuning.swapped ? slot.slot === 'A' : slot.slot === 'B');
      const src = solo
        ? this.videoA
        : (tuning.swapped ? (slot.slot === 'A' ? this.videoB : this.videoA)
                          : (slot.slot === 'A' ? this.videoA : this.videoB));
      const mirror = feedsFront && tuning.mirrorFront;

      ctx.save();
      pathFor(ctx, slot, radius);
      ctx.clip();
      if (src && src.readyState >= 2) {
        const box = slot.shape === 'circle'
          ? { x: slot.cx - slot.r, y: slot.cy - slot.r, w: slot.r * 2, h: slot.r * 2 }
          : slot.shape === 'poly'
            ? { x: 0, y: 0, w: W, h: H }
            : slot;
        drawCover(ctx, src, box.x, box.y, box.w, box.h, mirror);
      } else {
        ctx.fillStyle = PLACEHOLDER;
        ctx.fillRect(0, 0, W, H);
      }
      ctx.restore();
    }

    if (this.showGrid) this.drawGrid(W, H);
    if (border > 0 && !solo) this.drawSeams(slots, border, radius, W, H);
  }

  drawSeams(slots, border, radius, W, H) {
    const { ctx, tuning } = this;
    ctx.save();
    ctx.lineWidth = border;
    ctx.strokeStyle = tuning.glow ? 'rgba(125, 211, 252, 0.95)' : 'rgba(255, 255, 255, 0.55)';
    if (tuning.glow) {
      ctx.shadowColor = 'rgba(56, 189, 248, 0.85)';
      ctx.shadowBlur = border * 4;
    }
    for (const slot of slots) {
      if (slot.divider) {
        ctx.beginPath();
        ctx.moveTo(...slot.divider[0]);
        ctx.lineTo(...slot.divider[1]);
        ctx.stroke();
        continue;
      }
      // Kotak yang menempel tepi kanvas tidak perlu digarisi seluruh kelilingnya.
      const fullBleed = slot.shape === 'rect' && !slot.rounded &&
        slot.x <= 0 && slot.y <= 0 && slot.w >= W && slot.h >= H;
      if (fullBleed || slot.shape === 'poly') continue;
      pathFor(ctx, slot, radius);
      ctx.stroke();
    }
    ctx.restore();
  }

  drawGrid(W, H) {
    const { ctx } = this;
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.22)';
    ctx.lineWidth = Math.max(1, W / 1080);
    ctx.beginPath();
    for (let i = 1; i < 3; i++) {
      ctx.moveTo((W * i) / 3, 0); ctx.lineTo((W * i) / 3, H);
      ctx.moveTo(0, (H * i) / 3); ctx.lineTo(W, (H * i) / 3);
    }
    ctx.stroke();
    ctx.restore();
  }

  tickFps() {
    this._frames++;
    const now = performance.now();
    if (now - this._fpsAt >= 1000) {
      this.fps = Math.round((this._frames * 1000) / (now - this._fpsAt));
      this._frames = 0;
      this._fpsAt = now;
    }
    return this.fps;
  }

  /** Ubah koordinat pointer di layar jadi koordinat kanvas (kanvas dipasang object-fit: contain). */
  toCanvasPoint(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    const cw = this.canvas.width, ch = this.canvas.height;
    const scale = Math.min(rect.width / cw, rect.height / ch);
    const dw = cw * scale, dh = ch * scale;
    const ox = rect.left + (rect.width - dw) / 2;
    const oy = rect.top + (rect.height - dh) / 2;
    return { x: (clientX - ox) / scale, y: (clientY - oy) / scale, inside: true };
  }

  hitPip(clientX, clientY) {
    const p = this.toCanvasPoint(clientX, clientY);
    return hitTestDraggable(this.slots, p.x, p.y) ? p : null;
  }

  snapshot(type = 'image/jpeg', quality = 0.95) {
    return new Promise((resolve) => this.canvas.toBlob(resolve, type, quality));
  }

  thumbnail(maxW = 360) {
    const c = document.createElement('canvas');
    const scale = Math.min(1, maxW / this.canvas.width);
    c.width = Math.round(this.canvas.width * scale);
    c.height = Math.round(this.canvas.height * scale);
    c.getContext('2d').drawImage(this.canvas, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.7);
  }
}
