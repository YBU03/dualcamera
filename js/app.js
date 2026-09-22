/**
 * DualCam Studio — perekat seluruh aplikasi.
 *
 * Alur: CameraRig membuka dua stream → dua <video> tersembunyi jadi sumber →
 * Compositor menggambar keduanya ke satu kanvas sesuai tuning → kanvas itulah
 * yang difoto (toBlob) atau direkam (captureStream). Hasilnya masuk IndexedDB
 * dan, kalau auto-simpan aktif, langsung diunduh ke penyimpanan HP.
 */

import { CameraRig } from './cameras.js';
import { Compositor } from './compositor.js';
import { LAYOUTS, LAYOUT_BY_ID, DEFAULT_TUNING, computeSlots, outputSize } from './layouts.js';
import { CanvasRecorder, formatDuration } from './recorder.js';
import * as store from './storage.js';
import { downloadBlob, shareBlob, canShareFiles, filenameFor } from './save.js';

const $  = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

/* ═══════════════ State ═══════════════ */

const TUNING_KEY = 'dualcam.tuning.v1';

function loadTuning() {
  try {
    const saved = JSON.parse(localStorage.getItem(TUNING_KEY) || '{}');
    return { ...DEFAULT_TUNING, ...saved };
  } catch { return { ...DEFAULT_TUNING }; }
}

function saveTuning() {
  try { localStorage.setItem(TUNING_KEY, JSON.stringify(tuning)); } catch { /* mode privat */ }
}

const tuning = loadTuning();

const state = {
  mode: 'photo',       // 'photo' | 'video'
  timer: 0,            // 0 | 3 | 5 | 10
  view: 'camera',      // 'camera' | 'layouts' | 'gallery'
  filter: 'all',
  busy: false,
  torch: false,
  dragging: null,
  viewerId: null,
  viewerUrl: null,
};

const rig = new CameraRig();
const canvas = $('#viewfinder');
const comp = new Compositor(canvas, tuning);
const recorder = new CanvasRecorder(canvas, 30);

const videoA = document.createElement('video');
const videoB = document.createElement('video');
for (const v of [videoA, videoB]) {
  v.playsInline = true; v.muted = true; v.autoplay = true;
}

/**
 * Pasang stream ke elemen video lalu mainkan.
 *
 * play() pada elemen tanpa sumber mengembalikan promise yang menggantung
 * selamanya — bukan menolak — jadi elemen kosong tidak boleh ikut ditunggu.
 * Untuk yang punya sumber pun promise-nya dibatasi waktu: satu feed yang lambat
 * bangun tidak boleh menahan seluruh aplikasi di layar pembuka.
 */
async function attach(video, stream) {
  video.srcObject = stream ?? null;
  if (!stream) return;
  try {
    await Promise.race([
      video.play(),
      new Promise((resolve) => setTimeout(resolve, 3000)),
    ]);
  } catch { /* autoplay ditolak; frame tetap mengalir lewat compositor */ }
}

/* ═══════════════ Toast ═══════════════ */

function toast(message, actionLabel, onAction, ms = 3200) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.append(Object.assign(document.createElement('span'), { textContent: message }));
  if (actionLabel) {
    const btn = document.createElement('b');
    btn.textContent = actionLabel;
    btn.style.cursor = 'pointer';
    btn.addEventListener('click', () => { onAction?.(); dismiss(); });
    el.append(btn);
  }
  $('#toaster').append(el);
  const dismiss = () => {
    el.classList.add('is-out');
    setTimeout(() => el.remove(), 250);
  };
  setTimeout(dismiss, ms);
  return dismiss;
}

function setStatus(text, tone = '') {
  $('#statusText').textContent = text;
  const line = $('#statusline');
  line.classList.toggle('is-warn', tone === 'warn');
  line.classList.toggle('is-error', tone === 'error');
}

/* ═══════════════ Views ═══════════════ */

function showView(name) {
  if (name === 'photobox') return;
  state.view = name;
  $$('.view').forEach((v) => v.classList.toggle('is-active', v.id === `view-${name}`));
  $$('.tab').forEach((t) => t.classList.toggle('is-active', t.dataset.view === name));
  if (name === 'gallery') renderGallery();
}

$('#tabbar').addEventListener('click', (e) => {
  const tab = e.target.closest('.tab');
  if (tab && !tab.disabled) showView(tab.dataset.view);
});
$('#btnSettings').addEventListener('click', () => showView('layouts'));
$('#btnLayoutQuick').addEventListener('click', () => showView('layouts'));
$('#btnUseLayout').addEventListener('click', () => { showView('camera'); toast('Layout diterapkan'); });

/* ═══════════════ Kartu layout ═══════════════ */

/** Gambar diagram kecil sebuah layout — bukan feed asli, cuma geometrinya. */
function drawLayoutThumb(cvs, layoutId) {
  const W = cvs.width, H = cvs.height;
  const ctx = cvs.getContext('2d');
  const slots = computeSlots(layoutId, W, H, { ...tuning, layout: layoutId });
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#11151f';
  ctx.fillRect(0, 0, W, H);

  const paint = (slot, fill, label) => {
    ctx.save();
    ctx.beginPath();
    if (slot.shape === 'circle') ctx.arc(slot.cx, slot.cy, slot.r, 0, Math.PI * 2);
    else if (slot.shape === 'poly') {
      slot.pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.closePath();
    } else if (slot.rounded && ctx.roundRect) ctx.roundRect(slot.x, slot.y, slot.w, slot.h, 6);
    else ctx.rect(slot.x, slot.y, slot.w, slot.h);
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.strokeStyle = 'rgba(125,211,252,.5)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.clip();
    ctx.fillStyle = 'rgba(224,236,248,.75)';
    ctx.font = '600 11px Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const cx = slot.shape === 'circle' ? slot.cx : slot.shape === 'poly' ? W / 2 : slot.x + slot.w / 2;
    const cy = slot.shape === 'circle' ? slot.cy : slot.shape === 'poly'
      ? (slot.pts.reduce((a, p) => a + p[1], 0) / slot.pts.length)
      : slot.y + slot.h / 2;
    ctx.fillText(label, cx, cy);
    ctx.restore();
  };

  const labelFor = (slotName) => {
    const isFront = tuning.swapped ? slotName === 'A' : slotName === 'B';
    return isFront ? 'DEPAN' : 'BELAKANG';
  };

  for (const slot of slots) {
    if (slot.divider) continue;
    const isFront = tuning.swapped ? slot.slot === 'A' : slot.slot === 'B';
    paint(slot, isFront ? 'rgba(56,189,248,.28)' : 'rgba(148,163,184,.18)', labelFor(slot.slot));
  }
}

function buildLayoutCards() {
  const grid = $('#layoutGrid');
  grid.innerHTML = '';
  for (const layout of LAYOUTS) {
    const card = document.createElement('button');
    card.className = 'layoutcard';
    card.dataset.layout = layout.id;
    card.innerHTML = `
      <canvas class="layoutcard__art" width="220" height="165"></canvas>
      <div class="layoutcard__name"><span>${layout.name}</span><i class="layoutcard__pip"></i></div>
      <div class="layoutcard__sub">${layout.sub}</div>`;
    card.addEventListener('click', () => setLayout(layout.id));
    grid.append(card);
  }
  refreshLayoutCards();
}

function refreshLayoutCards() {
  $$('.layoutcard').forEach((card) => {
    card.classList.toggle('is-active', card.dataset.layout === tuning.layout);
    drawLayoutThumb(card.querySelector('canvas'), card.dataset.layout);
  });
}

function setLayout(id) {
  tuning.layout = id;
  saveTuning();
  refreshLayoutCards();
  syncTuningUI();
}

/* ═══════════════ Panel tuning ═══════════════ */

function syncTuningUI() {
  const layout = LAYOUT_BY_ID[tuning.layout] ?? LAYOUT_BY_ID['split-v'];

  $('#fieldRatio').hidden = !layout.usesRatio;
  $('#fieldPip').hidden = !layout.usesPip;

  $('#rngRatio').value  = Math.round(tuning.ratio * 100);
  $('#rngPip').value    = Math.round(tuning.pipScale * 100);
  $('#rngBorder').value = tuning.border;
  $('#rngRadius').value = tuning.radius;

  const r = Math.round(tuning.ratio * 100);
  $('#valRatio').textContent  = `${r} : ${100 - r}`;
  $('#valPip').textContent    = `${Math.round(tuning.pipScale * 100)}%`;
  $('#valBorder').textContent = `${tuning.border} px`;
  $('#valRadius').textContent = `${tuning.radius} px`;

  setSwitch($('#swGlow'), tuning.glow);
  setSwitch($('#swMirror'), tuning.mirrorFront);

  $('#layoutTag').textContent = layout.name;
  $('#layoutQuickLabel').textContent = layout.name + (tuning.swapped ? ' · Tertukar' : '');
  $('#telLayout').textContent = layout.name.toUpperCase();

  const { w, h } = outputSize(tuning.aspect, tuning.quality);
  $('#telRes').textContent = `${w} × ${h}`;

  // Bingkai di layar mengikuti rasio keluaran, jadi tidak ada bilah hitam dan
  // apa yang terlihat persis seukuran hasilnya.
  document.documentElement.style.setProperty('--frame-aspect', tuning.aspect.replace(':', ' / '));

  $$('#segAspect button').forEach((b) => b.classList.toggle('is-active', b.dataset.aspect === tuning.aspect));
  $$('#segQuality button').forEach((b) => b.classList.toggle('is-active', Number(b.dataset.q) === tuning.quality));

  $('#layoutFootnote').textContent = rig.mode === 'dual'
    ? `SIAP MEREKAM DUAL SENSOR · ${w}×${h}`
    : 'MODE SOLO — SATU KAMERA AKTIF';
}

function setSwitch(el, on) {
  el.classList.toggle('is-on', !!on);
  el.setAttribute('aria-checked', String(!!on));
}

function bindRange(id, key, transform, format) {
  $(id).addEventListener('input', (e) => {
    tuning[key] = transform(Number(e.target.value));
    saveTuning();
    format();
    refreshLayoutCards();
  });
}

bindRange('#rngRatio', 'ratio', (v) => v / 100, () => {
  const r = Math.round(tuning.ratio * 100);
  $('#valRatio').textContent = `${r} : ${100 - r}`;
});
bindRange('#rngPip', 'pipScale', (v) => v / 100, () => {
  $('#valPip').textContent = `${Math.round(tuning.pipScale * 100)}%`;
});
bindRange('#rngBorder', 'border', (v) => v, () => { $('#valBorder').textContent = `${tuning.border} px`; });
bindRange('#rngRadius', 'radius', (v) => v, () => { $('#valRadius').textContent = `${tuning.radius} px`; });

$('#swGlow').addEventListener('click', () => {
  tuning.glow = !tuning.glow; saveTuning(); setSwitch($('#swGlow'), tuning.glow);
});
$('#swMirror').addEventListener('click', () => {
  tuning.mirrorFront = !tuning.mirrorFront; saveTuning(); setSwitch($('#swMirror'), tuning.mirrorFront);
});
$('#swAutoSave').addEventListener('click', () => {
  tuning.autoSave = !(tuning.autoSave ?? true);
  saveTuning();
  setSwitch($('#swAutoSave'), tuning.autoSave);
  toast(tuning.autoSave ? 'Auto-simpan ke HP aktif' : 'Auto-simpan dimatikan — hasil tetap masuk Galeri app');
});

$('#btnResetTuning').addEventListener('click', () => {
  Object.assign(tuning, DEFAULT_TUNING, { layout: tuning.layout });
  saveTuning();
  syncTuningUI();
  refreshLayoutCards();
  toast('Fine-tuning dikembalikan ke bawaan');
});

$('#segAspect').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  tuning.aspect = btn.dataset.aspect;
  saveTuning();
  syncTuningUI();
  refreshLayoutCards();
});

$('#segQuality').addEventListener('click', (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  if (recorder.isRecording) { toast('Hentikan rekaman dulu sebelum ganti kualitas'); return; }
  tuning.quality = Number(btn.dataset.q);
  saveTuning();
  syncTuningUI();
});

function doSwap() {
  tuning.swapped = !tuning.swapped;
  saveTuning();
  syncTuningUI();
  refreshLayoutCards();
  toast(tuning.swapped ? 'Kamera depan kini di posisi utama' : 'Kembali ke posisi awal');
}
$('#btnSwap').addEventListener('click', doSwap);
$('#btnSwap2').addEventListener('click', doSwap);

/* ═══════════════ HUD kamera ═══════════════ */

$('#btnGrid').addEventListener('click', (e) => {
  comp.showGrid = !comp.showGrid;
  e.currentTarget.setAttribute('aria-pressed', String(comp.showGrid));
});

$('#btnTimer').addEventListener('click', () => {
  const cycle = [0, 3, 5, 10];
  state.timer = cycle[(cycle.indexOf(state.timer) + 1) % cycle.length];
  $('#timerLabel').textContent = state.timer ? `${state.timer}s` : '';
  $('#btnTimer').setAttribute('aria-pressed', String(state.timer > 0));
});

$('#btnTorch').addEventListener('click', async (e) => {
  const next = !state.torch;
  const ok = await rig.setTorch(next);
  if (!ok) { toast('Senter tidak didukung di kamera ini'); return; }
  state.torch = next;
  e.currentTarget.setAttribute('aria-pressed', String(next));
});

$('#modeStrip').addEventListener('click', (e) => {
  const btn = e.target.closest('.modestrip__item');
  if (!btn || btn.disabled) return;
  if (recorder.isRecording) { toast('Rekaman sedang berjalan'); return; }
  state.mode = btn.dataset.mode;
  $$('.modestrip__item').forEach((b) => b.classList.toggle('is-active', b === btn));
  $('#btnShutter').classList.toggle('is-video', state.mode === 'video');
});

/* ── Geser PiP langsung di viewfinder ── */

canvas.addEventListener('pointerdown', (e) => {
  const hit = comp.hitPip(e.clientX, e.clientY);
  if (!hit) return;
  state.dragging = true;
  canvas.setPointerCapture(e.pointerId);
});

canvas.addEventListener('pointermove', (e) => {
  if (!state.dragging) return;
  const p = comp.toCanvasPoint(e.clientX, e.clientY);
  tuning.pipX = Math.min(1, Math.max(0, p.x / canvas.width));
  tuning.pipY = Math.min(1, Math.max(0, p.y / canvas.height));
});

for (const evt of ['pointerup', 'pointercancel']) {
  canvas.addEventListener(evt, () => {
    if (!state.dragging) return;
    state.dragging = null;
    saveTuning();
    refreshLayoutCards();
  });
}

/* ═══════════════ Zoom ═══════════════ */

function buildZoomRail() {
  const rail = $('#zoomRail');
  const caps = rig.capabilities();
  if (!caps.zoom) { rail.hidden = true; return; }
  rail.hidden = false;

  const { min, max } = caps.zoom;
  const stops = [...new Set([
    min < 1 ? Number(min.toFixed(1)) : null,
    1,
    max >= 2 ? 2 : null,
    max >= 5 ? 5 : (max > 2 ? Number(max.toFixed(1)) : null),
  ].filter((v) => v !== null && v >= min && v <= max))];

  rail.innerHTML = '';
  for (const z of stops) {
    const btn = document.createElement('button');
    btn.className = 'zoombtn' + (z === 1 ? ' is-active' : '');
    btn.textContent = `${z}x`;
    btn.addEventListener('click', async () => {
      const ok = await rig.setZoom(z);
      if (!ok) { toast('Zoom tidak didukung'); return; }
      $$('.zoombtn').forEach((b) => b.classList.toggle('is-active', b === btn));
    });
    rail.append(btn);
  }
}

/* ═══════════════ Pengambilan gambar ═══════════════ */

function flash() {
  const el = $('#shutterFlash');
  el.classList.remove('is-firing');
  void el.offsetWidth;   // paksa reflow agar animasi bisa diulang
  el.classList.add('is-firing');
}

function runCountdown(seconds) {
  return new Promise((resolve) => {
    if (!seconds) return resolve();
    const el = $('#countdown');
    let left = seconds;
    el.hidden = false;
    el.textContent = String(left);
    const tick = setInterval(() => {
      left -= 1;
      if (left <= 0) {
        clearInterval(tick);
        el.hidden = true;
        resolve();
        return;
      }
      el.textContent = String(left);
      el.style.animation = 'none';
      void el.offsetWidth;
      el.style.animation = '';
    }, 1000);
  });
}

async function persistShot({ blob, type, duration = 0 }) {
  const { w, h } = outputSize(tuning.aspect, tuning.quality);
  const filename = filenameFor(type, blob.type);

  const record = await store.addShot({
    type,
    blob,
    mime: blob.type,
    size: blob.size,
    width: w,
    height: h,
    duration,
    filename,
    layout: LAYOUT_BY_ID[tuning.layout]?.name ?? tuning.layout,
    dual: rig.mode === 'dual',
    thumb: comp.thumbnail(),
  });

  $('#lastShotImg').src = record.thumb;
  $('#btnLastShot').classList.add('has-shot');

  if (tuning.autoSave ?? true) {
    downloadBlob(blob, filename);
    toast(`${type === 'video' ? 'Video' : 'Foto'} tersimpan ke HP`, 'Lihat', () => showView('gallery'));
  } else {
    toast(`${type === 'video' ? 'Video' : 'Foto'} masuk Galeri app`, 'Buka', () => showView('gallery'));
  }

  if (state.view === 'gallery') renderGallery();
  return record;
}

async function takePhoto() {
  await runCountdown(state.timer);
  flash();
  const blob = await comp.snapshot('image/jpeg', 0.95);
  if (!blob) { toast('Gagal mengambil foto'); return; }
  await persistShot({ blob, type: 'photo' });
}

async function startRecording() {
  await runCountdown(state.timer);
  const audio = await rig.ensureAudio();
  if (!audio) toast('Mikrofon tidak tersedia — merekam tanpa suara');
  try {
    recorder.start(audio);
  } catch (err) {
    toast(err.message || 'Perekaman gagal dimulai');
    return;
  }
  $('#btnShutter').classList.add('is-recording');
  $('#recBadge').hidden = false;
  $('#recTime').textContent = '00:00';
}

recorder.addEventListener('tick', (e) => {
  $('#recTime').textContent = formatDuration(e.detail.elapsed);
});

recorder.addEventListener('error', (e) => {
  toast(`Perekaman bermasalah: ${e.detail?.name || 'tidak diketahui'}`);
});

recorder.addEventListener('complete', async (e) => {
  $('#btnShutter').classList.remove('is-recording');
  $('#recBadge').hidden = true;
  rig.releaseAudio();
  const { blob, duration } = e.detail;
  if (!blob.size) { toast('Rekaman kosong — coba lagi'); return; }
  await persistShot({ blob, type: 'video', duration });
});

$('#btnShutter').addEventListener('click', async () => {
  if (state.busy) return;
  if (rig.mode === 'idle') { toast('Kamera belum siap'); return; }

  if (state.mode === 'video') {
    if (recorder.isRecording) { recorder.stop(); return; }
    state.busy = true;
    try { await startRecording(); } finally { state.busy = false; }
    return;
  }

  state.busy = true;
  $('#btnShutter').disabled = true;
  try { await takePhoto(); }
  catch (err) { toast(`Gagal: ${err.message || err}`); }
  finally { state.busy = false; $('#btnShutter').disabled = false; }
});

$('#btnLastShot').addEventListener('click', () => showView('gallery'));

/* ═══════════════ Galeri ═══════════════ */

function relativeTime(ts) {
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60_000);
  if (min < 1) return 'Baru saja';
  if (min < 60) return `${min} mnt lalu`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} jam lalu`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day} hr lalu`;
  return new Date(ts).toLocaleDateString('id-ID', { day: 'numeric', month: 'short' });
}

async function renderGallery() {
  const shots = await store.listShots();
  const visible = shots.filter((s) => state.filter === 'all' || s.type === state.filter);

  const grid = $('#galleryGrid');
  grid.innerHTML = '';

  for (const shot of visible) {
    const card = document.createElement('button');
    card.className = 'gcard';
    card.innerHTML = `
      <img src="${shot.thumb}" alt="" loading="lazy" />
      <span class="gcard__badge">
        <svg><use href="#ic-${shot.type === 'video' ? 'play' : 'layouts'}"/></svg>
        ${shot.type === 'video' ? formatDuration(shot.duration) : shot.layout}
      </span>
      <span class="gcard__foot">
        <span>${shot.dual ? 'Dual-Cam' : 'Solo'}</span>
        <span>${relativeTime(shot.createdAt)}</span>
      </span>`;
    card.addEventListener('click', () => openViewer(shot.id));
    grid.append(card);
  }

  $('#galleryEmpty').classList.toggle('is-visible', visible.length === 0);

  const total = shots.length;
  const bytes = shots.reduce((sum, s) => sum + (s.size || 0), 0);
  $('#storageText').textContent = total
    ? `${total} item tersimpan offline · ${store.formatBytes(bytes)}`
    : 'Belum ada item tersimpan';

  // Thumbnail terakhir di tombol shutter bar.
  if (shots[0]) {
    $('#lastShotImg').src = shots[0].thumb;
    $('#btnLastShot').classList.add('has-shot');
  } else {
    $('#btnLastShot').classList.remove('has-shot');
  }
}

$('#galleryFilters').addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (!chip) return;
  state.filter = chip.dataset.filter;
  $$('#galleryFilters .chip').forEach((c) => c.classList.toggle('is-active', c === chip));
  renderGallery();
});

$('#btnRefreshGallery').addEventListener('click', () => renderGallery());

/* ═══════════════ Viewer ═══════════════ */

function closeViewer() {
  $('#viewer').hidden = true;
  $('#viewerStage').innerHTML = '';
  if (state.viewerUrl) { URL.revokeObjectURL(state.viewerUrl); state.viewerUrl = null; }
  state.viewerId = null;
}

async function openViewer(id) {
  const shot = await store.getShot(id);
  if (!shot) return;

  state.viewerId = id;
  state.viewerUrl = URL.createObjectURL(shot.blob);

  const stage = $('#viewerStage');
  stage.innerHTML = '';
  if (shot.type === 'video') {
    const video = document.createElement('video');
    video.src = state.viewerUrl;
    video.controls = true;
    video.playsInline = true;
    video.autoplay = true;
    stage.append(video);
  } else {
    const img = document.createElement('img');
    img.src = state.viewerUrl;
    stage.append(img);
  }

  $('#viewerMeta').textContent =
    `${shot.layout} · ${shot.width}×${shot.height} · ${store.formatBytes(shot.size)}`;
  $('#viewerShare').hidden = !canShareFiles(shot.blob, shot.filename);
  $('#viewer').hidden = false;
}

$('#viewerClose').addEventListener('click', closeViewer);

$('#viewerSave').addEventListener('click', async () => {
  const shot = await store.getShot(state.viewerId);
  if (!shot) return;
  downloadBlob(shot.blob, shot.filename);
  toast('Diunduh ke penyimpanan HP');
});

$('#viewerShare').addEventListener('click', async () => {
  const shot = await store.getShot(state.viewerId);
  if (!shot) return;
  const result = await shareBlob(shot.blob, shot.filename);
  if (result === 'unsupported') toast('Share sheet tidak tersedia — pakai Simpan ke HP');
  else if (result === 'failed') toast('Gagal membuka share sheet');
});

$('#viewerDelete').addEventListener('click', async () => {
  const id = state.viewerId;
  if (!id) return;
  if (!confirm('Hapus tangkapan ini dari galeri app?')) return;
  await store.deleteShot(id);
  closeViewer();
  renderGallery();
  toast('Terhapus');
});

/* ═══════════════ Loop render ═══════════════ */

const previewMini = $('#previewMini');
const previewCtx = previewMini.getContext('2d');

function uiLoop() {
  const fps = comp.tickFps();
  $('#telFps').textContent = `${fps || '--'} FPS`;

  // Pratinjau di tab Layout memantulkan kanvas utama — satu sumber kebenaran.
  if (state.view === 'layouts' && comp.running) {
    const { width: cw, height: ch } = canvas;
    if (previewMini.width !== previewMini.clientWidth * 2) {
      previewMini.width = Math.max(2, previewMini.clientWidth * 2);
      previewMini.height = Math.max(2, previewMini.clientHeight * 2);
    }
    const scale = Math.min(previewMini.width / cw, previewMini.height / ch);
    const dw = cw * scale, dh = ch * scale;
    previewCtx.fillStyle = '#05070d';
    previewCtx.fillRect(0, 0, previewMini.width, previewMini.height);
    previewCtx.drawImage(canvas, (previewMini.width - dw) / 2, (previewMini.height - dh) / 2, dw, dh);
  }
  requestAnimationFrame(uiLoop);
}

/* ═══════════════ Boot ═══════════════ */

function applyRigToUi() {
  const dual = rig.mode === 'dual';
  setStatus(dual ? 'DUAL LENS ACTIVE' : 'MODE SOLO', dual ? '' : 'warn');

  const notice = $('#stageNotice');
  if (dual) {
    notice.hidden = true;
  } else {
    notice.hidden = false;
    $('#stageNoticeText').textContent =
      `${rig.reason} Aplikasi jalan dengan satu kamera — foto & video tetap bisa disimpan.`;
    const action = $('#stageNoticeAction');
    action.hidden = false;
    action.textContent = 'Mengerti';
    action.onclick = () => { notice.hidden = true; };
  }

  $('#btnSwap').disabled = !dual;
  $('#btnSwap').style.opacity = dual ? '' : '.4';
  syncTuningUI();
}

async function boot() {
  $('#gateStart').disabled = true;
  $('#gateNote').textContent = 'Meminta izin kamera…';

  try {
    await rig.start();
  } catch (err) {
    $('#gateStart').disabled = false;
    $('#gateNote').textContent = err.message || String(err);
    setStatus('KAMERA TIDAK SIAP', 'error');
    return;
  }

  await Promise.all([attach(videoA, rig.back), attach(videoB, rig.front)]);

  comp.setSources(videoA, rig.front ? videoB : null);
  comp.start();

  buildZoomRail();
  applyRigToUi();
  store.requestPersistence();

  $('#gate').hidden = true;
  await renderGallery();

  if (typeof MediaRecorder === 'undefined') {
    $$('.modestrip__item[data-mode="video"]').forEach((b) => { b.disabled = true; b.classList.add('is-locked'); });
    toast('Browser ini tidak bisa merekam video — mode foto tetap jalan');
  }
}

rig.addEventListener('change', () => {
  // Kamera kedua bisa lepas di tengah jalan — lepaskan juga elemennya supaya
  // compositor tidak menggambar frame beku dari stream yang sudah mati.
  if (!rig.front) videoB.srcObject = null;
  comp.setSources(videoA, rig.front ? videoB : null);
  applyRigToUi();
});

$('#gateStart').addEventListener('click', boot);

/**
 * Kalau izin kamera sudah pernah diberikan, langsung nyalakan tanpa menunggu
 * ketukan — membuka aplikasi lalu harus menekan tombol yang sama setiap kali
 * itu gesekan yang tidak perlu. Kalau izinnya belum ada, gate tetap muncul:
 * prompt izin memang sebaiknya lahir dari tindakan pengguna, bukan mengagetkan.
 */
async function autoBootIfPermitted() {
  try {
    const status = await navigator.permissions?.query({ name: 'camera' });
    if (status?.state === 'granted') boot();
  } catch { /* Permissions API tidak mengenal 'camera' di sebagian browser */ }
}
autoBootIfPermitted();

// Lepas kamera saat tab disembunyikan — HP lain tidak bisa memakai kamera
// selama kita memeganginya, dan sebagian browser mematikannya sepihak.
document.addEventListener('visibilitychange', () => {
  if (document.hidden && !recorder.isRecording) comp.stop();
  else if (!document.hidden && rig.mode !== 'idle') comp.start();
});

buildLayoutCards();
syncTuningUI();
setSwitch($('#swAutoSave'), tuning.autoSave ?? true);
$('#btnShutter').classList.toggle('is-video', state.mode === 'video');
requestAnimationFrame(uiLoop);

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => { /* offline tidak wajib */ });
  });
}
