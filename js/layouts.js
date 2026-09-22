/**
 * Geometri layout dual-cam.
 *
 * Setiap layout mengembalikan daftar "slot": area di kanvas keluaran yang diisi
 * oleh salah satu feed. Slot A = feed utama, slot B = feed sekunder. Tombol
 * "Tukar" hanya menukar kamera mana yang memberi makan A dan B, jadi geometri
 * di sini tidak perlu tahu apa pun soal depan/belakang.
 *
 * Bentuk slot:
 *   { slot:'A'|'B', shape:'rect'|'circle'|'poly', ... , radius?, draggable? }
 */

export const LAYOUTS = [
  { id: 'split-v',     name: 'Split Vertical',   sub: 'Kiri-kanan, bisa digeser', usesRatio: true  },
  { id: 'split-h',     name: 'Split Horizontal', sub: 'Atas-bawah, bisa digeser', usesRatio: true  },
  { id: 'pip-circle',  name: 'PiP Circle',       sub: 'Bubble selfie di sudut',   usesPip: true    },
  { id: 'pip-rounded', name: 'PiP Rounded',      sub: 'Inset widget overlay',     usesPip: true    },
  { id: 'diagonal',    name: 'Diagonal Slash',   sub: 'Potongan miring dinamis',  usesRatio: true  },
  { id: 'reaction',    name: 'Reaction Strip',   sub: '70:30 ala streamer',       usesRatio: true  },
];

export const LAYOUT_BY_ID = Object.fromEntries(LAYOUTS.map((l) => [l.id, l]));

export const DEFAULT_TUNING = {
  layout: 'split-v',
  ratio: 0.5,        // pembagian A vs B (0.2 – 0.8)
  pipScale: 0.34,    // lebar PiP relatif terhadap lebar kanvas
  pipX: 0.76,        // titik tengah PiP, ternormalisasi 0..1
  pipY: 0.30,   // di bawah baris HUD, bukan tertimpa olehnya
  border: 2,         // px @ lebar 1080, diskalakan otomatis
  radius: 16,
  glow: true,
  mirrorFront: true,
  swapped: false,
  aspect: '9:16',
  quality: 1080,
};

export const ASPECTS = { '9:16': 9 / 16, '3:4': 3 / 4, '1:1': 1 };

/** Ukuran kanvas keluaran untuk rasio + kualitas tertentu (selalu genap — encoder video rewel). */
export function outputSize(aspect, quality) {
  const ratio = ASPECTS[aspect] ?? ASPECTS['9:16'];
  const h = quality;
  const w = Math.round(h * ratio);
  return { w: w - (w % 2), h: h - (h % 2) };
}

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

/**
 * Hitung slot untuk layout aktif.
 * @param {string} id  id layout
 * @param {number} W   lebar kanvas
 * @param {number} H   tinggi kanvas
 * @param {object} t   tuning
 * @returns {Array} slot, digambar berurutan (belakang → depan)
 */
export function computeSlots(id, W, H, t) {
  const ratio = clamp(t.ratio ?? 0.5, 0.2, 0.8);

  switch (id) {
    case 'split-h': {
      const cut = Math.round(H * ratio);
      return [
        { slot: 'A', shape: 'rect', x: 0, y: 0,   w: W, h: cut },
        { slot: 'B', shape: 'rect', x: 0, y: cut, w: W, h: H - cut },
      ];
    }

    case 'split-v': {
      const cut = Math.round(W * ratio);
      return [
        { slot: 'A', shape: 'rect', x: 0,   y: 0, w: cut,     h: H },
        { slot: 'B', shape: 'rect', x: cut, y: 0, w: W - cut, h: H },
      ];
    }

    case 'pip-circle': {
      const d = Math.round(W * clamp(t.pipScale ?? 0.34, 0.18, 0.6));
      const r = d / 2;
      const cx = clamp(t.pipX ?? 0.76, 0, 1) * W;
      const cy = clamp(t.pipY ?? 0.22, 0, 1) * H;
      return [
        { slot: 'A', shape: 'rect', x: 0, y: 0, w: W, h: H },
        {
          slot: 'B', shape: 'circle', draggable: true,
          cx: clamp(cx, r, W - r), cy: clamp(cy, r, H - r), r,
        },
      ];
    }

    case 'pip-rounded': {
      const w = Math.round(W * clamp(t.pipScale ?? 0.34, 0.18, 0.6));
      const h = Math.round(w * 4 / 3);
      const cx = clamp(t.pipX ?? 0.76, 0, 1) * W;
      const cy = clamp(t.pipY ?? 0.22, 0, 1) * H;
      return [
        { slot: 'A', shape: 'rect', x: 0, y: 0, w: W, h: H },
        {
          slot: 'B', shape: 'rect', draggable: true, rounded: true,
          x: Math.round(clamp(cx - w / 2, 0, W - w)),
          y: Math.round(clamp(cy - h / 2, 0, H - h)),
          w, h,
        },
      ];
    }

    case 'diagonal': {
      // Garis pemisah miring, memotong tepi kiri & kanan pada dua titik berbeda.
      const skew = W * 0.38;
      const mid = H * ratio;
      const yL = mid - skew / 2;
      const yR = mid + skew / 2;
      return [
        { slot: 'A', shape: 'poly', pts: [[0, 0], [W, 0], [W, yR], [0, yL]] },
        { slot: 'B', shape: 'poly', pts: [[0, yL], [W, yR], [W, H], [0, H]] },
        { divider: [[0, yL], [W, yR]] },
      ];
    }

    case 'reaction': {
      // Adegan besar + strip reaksi melayang di sisi kanan, ada jarak & sudut membulat.
      const gap = Math.round(W * 0.02);
      const cut = Math.round(W * clamp(ratio + 0.2, 0.45, 0.85));
      return [
        { slot: 'A', shape: 'rect', rounded: true, x: 0, y: 0, w: cut - gap / 2, h: H },
        { slot: 'B', shape: 'rect', rounded: true, x: cut + gap / 2, y: 0, w: W - cut - gap / 2, h: H },
      ];
    }

    default:
      return computeSlots('split-v', W, H, t);
  }
}

/** Apakah titik (x,y) pada kanvas berada di dalam slot PiP yang bisa digeser? */
export function hitTestDraggable(slots, x, y) {
  for (let i = slots.length - 1; i >= 0; i--) {
    const s = slots[i];
    if (!s.draggable) continue;
    if (s.shape === 'circle') {
      if ((x - s.cx) ** 2 + (y - s.cy) ** 2 <= s.r ** 2) return s;
    } else if (x >= s.x && x <= s.x + s.w && y >= s.y && y <= s.y + s.h) {
      return s;
    }
  }
  return null;
}
