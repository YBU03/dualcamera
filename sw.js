/**
 * Service worker — membuat aplikasi jalan penuh tanpa internet.
 *
 * Strategi cache-first untuk seluruh app shell. Kamera, compositor, perekam,
 * dan galeri semuanya berjalan lokal, jadi begitu shell ini ter-cache tidak ada
 * lagi permintaan jaringan yang dibutuhkan untuk memakai aplikasi.
 */

const CACHE = 'dualcam-v1';

const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/fonts.css',
  './css/tokens.css',
  './css/app.css',
  './js/app.js',
  './js/cameras.js',
  './js/compositor.js',
  './js/layouts.js',
  './js/recorder.js',
  './js/save.js',
  './js/storage.js',
  './assets/fonts/inter-400.woff2',
  './assets/fonts/inter-500.woff2',
  './assets/fonts/inter-600.woff2',
  './assets/fonts/inter-700.woff2',
  './assets/icon-192.png',
  './assets/icon-512.png',
  './assets/icon-maskable-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      // addAll gagal total kalau satu berkas meleset, jadi tiap berkas diambil sendiri.
      .then((cache) => Promise.allSettled(SHELL.map((url) => cache.add(url))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;   // pihak ketiga (tidak ada) biarkan lewat

  event.respondWith(
    caches.match(request).then((hit) => {
      if (hit) return hit;
      return fetch(request)
        .then((response) => {
          if (response.ok && response.type === 'basic') {
            const copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => caches.match('./index.html'));   // navigasi offline tetap dapat shell
    })
  );
});
