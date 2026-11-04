// Recent captures live in IndexedDB so the preview page and the toast's
// Download button can reach them after the service worker has gone to sleep.
const DB_NAME = "framegrab";
const DB_VERSION = 2;
const CAPTURES = "captures";
// Separate from the captures so a saved "before" can't be pruned while you work.
const BEFORE = "before";
const BEFORE_SLOT = "current";
const KEEP = 5;

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(CAPTURES)) db.createObjectStore(CAPTURES, { keyPath: "id" });
      if (!db.objectStoreNames.contains(BEFORE)) db.createObjectStore(BEFORE, { keyPath: "slot" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function done(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = tx.onabort = () => reject(tx.error);
  });
}

async function read(storeName, key) {
  const db = await open();
  const req = db.transaction(storeName).objectStore(storeName).get(key);
  const value = await new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return value;
}

export async function saveCapture(capture) {
  const db = await open();
  const tx = db.transaction(CAPTURES, "readwrite");
  const store = tx.objectStore(CAPTURES);
  store.put(capture);
  const keys = store.getAllKeys();
  keys.onsuccess = () => {
    const stale = keys.result.slice(0, Math.max(0, keys.result.length - KEEP));
    for (const key of stale) store.delete(key);
  };
  await done(tx);
  db.close();
}

export function loadCapture(id) {
  return read(CAPTURES, id);
}

// Capture ids are timestamps, so the highest key is the newest capture.
export async function loadLatestCapture() {
  const db = await open();
  const req = db.transaction(CAPTURES).objectStore(CAPTURES).openCursor(null, "prev");
  const value = await new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result?.value);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return value;
}

export async function saveBefore(capture) {
  const db = await open();
  const tx = db.transaction(BEFORE, "readwrite");
  tx.objectStore(BEFORE).put({ ...capture, slot: BEFORE_SLOT });
  await done(tx);
  db.close();
}

export function loadBefore() {
  return read(BEFORE, BEFORE_SLOT);
}

export async function clearBefore() {
  const db = await open();
  const tx = db.transaction(BEFORE, "readwrite");
  tx.objectStore(BEFORE).delete(BEFORE_SLOT);
  await done(tx);
  db.close();
}
