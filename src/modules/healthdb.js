// HealthDB — 饮食记录 / 体重 / 健康档案
// 🔴 独立数据库，绝不并入 XinyeChatDB（那是聊天主库，动它的 DB_VER 有锁死风险）
// 骨架照 src/modules/phonedb.js
const DB_NAME = 'HealthDB';
const DB_VER  = 1;

let _db = null;

export function openHealthDB() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      // 幂等守卫：老库升级时已存在的 store 全部跳过，只补缺的
      if (!db.objectStoreNames.contains('profiles')) {
        const s = db.createObjectStore('profiles', { keyPath: 'id' });
        s.createIndex('archived', 'archived', { unique: false });
      }
      if (!db.objectStoreNames.contains('entries')) {
        const s = db.createObjectStore('entries', { keyPath: 'id', autoIncrement: true });
        // 复合索引：查「某档案某天」走这一条，别用两个独立索引再过滤
        s.createIndex('byProfileDate', ['profileId', 'dateStr'], { unique: false });
        s.createIndex('byDate', 'dateStr', { unique: false });
      }
      if (!db.objectStoreNames.contains('weights')) {
        const s = db.createObjectStore('weights', { keyPath: 'id', autoIncrement: true });
        s.createIndex('byProfileDate', ['profileId', 'dateStr'], { unique: false });
      }
      if (!db.objectStoreNames.contains('customFoods')) {
        const s = db.createObjectStore('customFoods', { keyPath: 'id' });
        s.createIndex('profileId', 'profileId', { unique: false });
      }
      if (!db.objectStoreNames.contains('usage')) {
        const s = db.createObjectStore('usage', { keyPath: 'key' });
        s.createIndex('byProfile', 'profileId', { unique: false });
      }
      if (!db.objectStoreNames.contains('photos')) {
        db.createObjectStore('photos', { keyPath: 'id', autoIncrement: true });
      }
    };
    req.onsuccess = e => {
      _db = e.target.result;
      _db.onversionchange = () => { _db.close(); _db = null; };
      resolve(_db);
    };
    req.onerror   = e => reject(e.target.error);
    req.onblocked = () => reject(new Error('HealthDB onblocked'));
  });
}

function store(name, mode = 'readonly') {
  return _db.transaction(name, mode).objectStore(name);
}

function wrap(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror   = e => reject(e.target.error);
  });
}

// ── 本地日期（🔴 不能用 toISOString：UTC+8 凌晨 0–8 点会算成前一天，早餐会落到昨天）──
export function localDateStr(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function shiftDate(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return localDateStr(new Date(y, m - 1, d + days));
}

// ── 档案 ─────────────────────────────────────────────────────────────────
export async function listProfiles(includeArchived = false) {
  const all = await wrap(store('profiles').getAll());
  return includeArchived ? all : all.filter(p => !p.archived);
}

export async function getProfile(id) {
  return wrap(store('profiles').get(id));
}

export async function saveProfile(p) {
  await openHealthDB();
  if (!p.id) p.id = 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  await wrap(store('profiles', 'readwrite').put(p));
  return p.id;
}

// 软删除：不级联删记录（家人共用一个库，误删档案不该毁掉历史）
export async function archiveProfile(id) {
  await openHealthDB();
  const p = await getProfile(id);
  if (p) await wrap(store('profiles', 'readwrite').put({ ...p, archived: true }));
}

// ── 饮食记录 ─────────────────────────────────────────────────────────────
export async function listEntries(profileId, dateStr) {
  await openHealthDB();
  const idx = store('entries').index('byProfileDate');
  const rows = await wrap(idx.getAll([profileId, dateStr]));
  return rows.sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
}

export async function listEntriesRange(profileId, fromDate, toDate) {
  await openHealthDB();
  const idx = store('entries').index('byProfileDate');
  const rows = await wrap(idx.getAll(IDBKeyRange.bound([profileId, fromDate], [profileId, toDate])));
  return rows;
}

// 写入记录 + 更新常吃表 —— 同一个事务，保证一致
export async function addEntry(profileId, entry) {
  await openHealthDB();
  const rec = {
    profileId,
    dateStr: entry.dateStr,
    meal: entry.meal,
    foodKey: entry.foodKey || null,     // 'g:<code>' 国标 / 'c:<id>' 自建 / null 手输
    name: entry.name,
    grams: entry.grams,
    ediblePct: entry.ediblePct ?? 100,
    per100: entry.per100 || null,       // 🔴 快照：改克数时靠它重算
    nutrients: entry.nutrients,
    note: entry.note || '',
    createdAt: Date.now(),
  };
  const tx = _db.transaction(['entries', 'usage'], 'readwrite');
  const addReq = tx.objectStore('entries').add(rec);
  const done = new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = e => rej(e.target.error); });

  if (entry.foodKey) {
    const us = tx.objectStore('usage');
    const cur = await new Promise(res => { const r = us.get(entry.foodKey); r.onsuccess = () => res(r.result); r.onerror = () => res(null); });
    const prev = cur && cur.profileId === profileId ? cur : null;   // 不同档案分开记
    us.put({
      key: entry.foodKey,
      profileId,
      name: entry.name,
      count: (prev?.count || 0) + 1,
      lastUsed: Date.now(),
      lastGrams: entry.grams,
      lastMeal: entry.meal,
    });
  }
  await done;
  return addReq.result;
}

export async function updateEntry(entry) {
  await openHealthDB();
  return wrap(store('entries', 'readwrite').put(entry));
}

// 删除时把常吃计数减回去（否则误记一次就永久污染榜）
export async function deleteEntry(id) {
  await openHealthDB();
  const rec = await wrap(store('entries').get(id));
  if (!rec) return;
  const tx = _db.transaction(['entries', 'usage'], 'readwrite');
  tx.objectStore('entries').delete(id);
  if (rec.foodKey) {
    const us = tx.objectStore('usage');
    us.get(rec.foodKey).onsuccess = e => {
      const u = e.target.result;
      if (u) us.put({ ...u, count: Math.max(0, (u.count || 1) - 1) });
    };
  }
  await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = e => rej(e.target.error); });
}

// ── 常吃 / 最近 ──────────────────────────────────────────────────────────
export async function listUsage(profileId) {
  await openHealthDB();
  const all = await wrap(store('usage').index('byProfile').getAll(profileId));
  const now = Date.now();
  return all
    .filter(u => u.count > 0)
    .map(u => {
      const days = (now - (u.lastUsed || 0)) / 86400000;
      return { ...u, score: Math.log2(1 + u.count) * Math.pow(0.5, days / 30) };  // 30 天半衰期
    });
}

// ── 体重 ─────────────────────────────────────────────────────────────────
export async function listWeights(profileId) {
  await openHealthDB();
  const rows = await wrap(store('weights').index('byProfileDate').getAll(IDBKeyRange.bound([profileId, '0000-00-00'], [profileId, '9999-99-99'])));
  return rows.sort((a, b) => a.dateStr.localeCompare(b.dateStr));
}

// 同一天只留一条（重复称重覆盖）
export async function saveWeight(profileId, dateStr, kg) {
  await openHealthDB();
  const idx = store('weights').index('byProfileDate');
  const exist = await wrap(idx.getAll([profileId, dateStr]));
  const s = store('weights', 'readwrite');
  if (exist.length) await wrap(s.put({ ...exist[0], kg }));
  else await wrap(s.add({ profileId, dateStr, kg, createdAt: Date.now() }));
}

// ── 自建食物 ─────────────────────────────────────────────────────────────
export async function listCustomFoods(profileId) {
  await openHealthDB();
  return wrap(store('customFoods').index('profileId').getAll(profileId));
}

export async function saveCustomFood(f) {
  await openHealthDB();
  if (!f.id) f.id = 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  await wrap(store('customFoods', 'readwrite').put(f));
  return f.id;
}

export async function deleteCustomFood(id) {
  await openHealthDB();
  return wrap(store('customFoods', 'readwrite').delete(id));
}
