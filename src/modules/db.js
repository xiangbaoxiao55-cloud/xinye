const DB_NAME = 'XinyeChatDB';
const DB_VER = 4;
export let db = null;

export function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = (e) => {
      const d = e.target.result;
      if (!d.objectStoreNames.contains('settings')) d.createObjectStore('settings');
      if (!d.objectStoreNames.contains('messages')) d.createObjectStore('messages', { keyPath: 'id', autoIncrement: true });
      if (!d.objectStoreNames.contains('images'))   d.createObjectStore('images');
      if (!d.objectStoreNames.contains('stickers'))  d.createObjectStore('stickers', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('ttsCache'))    d.createObjectStore('ttsCache');
      if (!d.objectStoreNames.contains('rpMessages'))  d.createObjectStore('rpMessages', { keyPath: 'id', autoIncrement: true });
      if (!d.objectStoreNames.contains('friends'))     d.createObjectStore('friends', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('friendMessages')) {
        const fms = d.createObjectStore('friendMessages', { keyPath: 'id', autoIncrement: true });
        fms.createIndex('byFriend', 'friendId', { unique: false });
      }
    };
    req.onsuccess = (e) => {
      db = e.target.result;
      db.onversionchange = () => { db.close(); db = null; };
      resolve(db);
    };
    req.onerror = (e) => reject(e.target.error);
    req.onblocked = () => {
      console.warn('[DB] onblocked: 旧DB连接残留，刷新页面');
      window.location.reload();
    };
  });
}

export function dbPut(store, key, value) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    if (key !== undefined && key !== null) tx.objectStore(store).put(value, key);
    else tx.objectStore(store).put(value);
    tx.oncomplete = () => resolve();
    tx.onerror = (e) => reject(e.target.error);
  });
}

export function dbGet(store, key) {
  if (!db) return Promise.resolve(undefined);
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = (e) => reject(e.target.error);
  });
}

export function lsBackup(key, value) {
  if (!db) return;
  dbPut('settings', 'ls_' + key, value).catch(() => {});
}

export function lsRemoveBackup(key) {
  if (!db) return;
  try { const tx = db.transaction('settings', 'readwrite'); tx.objectStore('settings').delete('ls_' + key); } catch(_) {}
}

export function dbGetAll(store) {
  if (!db) return Promise.resolve([]);
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = (e) => reject(e.target.error);
  });
}

export function dbGetRecent(store, count) {
  if (!db) return Promise.resolve([]);
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const results = [];
    const req = tx.objectStore(store).openCursor(null, 'prev');
    req.onsuccess = e => {
      const cursor = e.target.result;
      if (cursor && results.length < count) {
        results.unshift(cursor.value);
        cursor.continue();
      } else {
        resolve(results);
      }
    };
    req.onerror = (e) => reject(e.target.error);
  });
}

export function dbGetRecentFiltered(store, count, filterFn) {
  if (!db) return Promise.resolve([]);
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const results = [];
    const req = tx.objectStore(store).openCursor(null, 'prev');
    req.onsuccess = e => {
      const cursor = e.target.result;
      if (cursor) {
        if (filterFn(cursor.value)) {
          results.unshift(cursor.value);
          if (results.length >= count) { resolve(results); return; }
        }
        cursor.continue();
      } else {
        resolve(results);
      }
    };
    req.onerror = (e) => reject(e.target.error);
  });
}

export function dbDelete(store, key) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = (e) => reject(e.target.error);
  });
}

export function dbClear(store) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = (e) => reject(e.target.error);
  });
}

export function dbGetAllKeys(store) {
  if (!db) return Promise.resolve([]);
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).getAllKeys();
    req.onsuccess = () => resolve(req.result);
    req.onerror = (e) => reject(e.target.error);
  });
}
