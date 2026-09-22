/**
 * Galeri lokal di atas IndexedDB.
 *
 * Blob disimpan apa adanya — IndexedDB menyimpannya di disk, bukan di memori,
 * jadi video berukuran ratusan MB pun tidak menggelembungkan tab. Thumbnail
 * disimpan sebagai data URL kecil supaya grid bisa digambar tanpa membaca
 * blob besar satu per satu.
 */

const DB_NAME = 'dualcam-studio';
const DB_VERSION = 1;
const STORE = 'shots';

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id' });
        store.createIndex('createdAt', 'createdAt');
        store.createIndex('type', 'type');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(mode) {
  return openDb().then((db) => db.transaction(STORE, mode).objectStore(STORE));
}

function done(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function addShot(shot) {
  const record = { id: crypto.randomUUID(), createdAt: Date.now(), ...shot };
  const store = await tx('readwrite');
  await done(store.add(record));
  return record;
}

export async function listShots() {
  const store = await tx('readonly');
  const all = await done(store.getAll());
  return all.sort((a, b) => b.createdAt - a.createdAt);
}

export async function getShot(id) {
  const store = await tx('readonly');
  return done(store.get(id));
}

export async function deleteShot(id) {
  const store = await tx('readwrite');
  return done(store.delete(id));
}

export async function countShots() {
  const store = await tx('readonly');
  return done(store.count());
}

/** Minta penyimpanan persisten supaya browser tidak membuang galeri saat disk menipis. */
export async function requestPersistence() {
  try {
    if (navigator.storage?.persisted && navigator.storage?.persist) {
      return (await navigator.storage.persisted()) || (await navigator.storage.persist());
    }
  } catch { /* tidak didukung */ }
  return false;
}

export async function usage() {
  try {
    const est = await navigator.storage?.estimate?.();
    return est ? { used: est.usage || 0, quota: est.quota || 0 } : null;
  } catch { return null; }
}

export function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}
