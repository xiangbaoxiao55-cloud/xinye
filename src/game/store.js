// src/game/store.js —— 游戏自己的库。
//
// 🔴 **独立的 IndexedDB**：`XinyeGameDB`（臭宝 `ChoubaoGameDB`），version 1。
//    **绝不给 `XinyeChatDB` 加 store** —— 那要升主库的 `DB_VER`，
//    而主库版本只能升不能降，牵一发动全身（说明书 §6 红线）。
//
// 为什么不复用主库：对局数据（棋盘、棋谱、桌边话）量不小、更新极频繁
// （每落一子、每说一句都要落库），跟聊天记录混在一起会把主库撑大、
// 也让主库的备份/迁移多背一份不该背的东西。
//
// ⚠️ 这个库**不进主备份**，这是有意的：结算小结已经写进主聊天了，
//    真正值得留的那句话在主库里。这个库只负责"中途被杀能接着下"。
//
// 每落一子、每说一句都**立刻落库**（说明书 §6）—— 她中途切走、APP 被杀，
// 回来大厅显示「有一局没下完」，点进去能续。

const DB_VER = 1;
let _db = null;

function _dbName() {
  return window.__APP_ID__ === 'choubao' ? 'ChoubaoGameDB' : 'XinyeGameDB';
}

export function openGameDB() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(_dbName(), DB_VER);
    req.onupgradeneeded = (e) => {
      const d = e.target.result;
      if (!d.objectStoreNames.contains('games')) {
        const s = d.createObjectStore('games', { keyPath: 'id' });
        s.createIndex('byStarted', 'startedAt', { unique: false });
      }
    };
    req.onsuccess = (e) => {
      _db = e.target.result;
      _db.onversionchange = () => { try { _db.close(); } catch (_) {} _db = null; };
      resolve(_db);
    };
    req.onerror = (e) => reject(e.target.error);
  });
}

function _tx(mode, fn) {
  return openGameDB().then(d => new Promise((resolve, reject) => {
    const tx = d.transaction('games', mode);
    const store = tx.objectStore('games');
    const req = fn(store);
    if (req) {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    } else {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    }
  }));
}

/** 新局的 id：时间戳 + 随机尾巴，够唯一了 */
export function newGameId() {
  return 'g' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

export function saveGame(game) {
  return _tx('readwrite', s => s.put(game));
}

export function getGame(id) {
  return _tx('readonly', s => s.get(id));
}

export function deleteGame(id) {
  return _tx('readwrite', s => s.delete(id));
}

/** 全部对局，新的在前 */
export async function listGames() {
  const all = (await _tx('readonly', s => s.getAll())) || [];
  return all.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
}

/**
 * 有没有没下完的。大厅拿它显示「有一局没下完，接着下？」。
 * 只认最近的一条 —— 同时开两局没意义。
 */
export async function findUnfinished() {
  const all = await listGames();
  return all.find(g => g && g.status === 'playing') || null;
}

/**
 * 战绩：「你 X : Y 他」。
 * 只统计**下完了**的局，中途退出的不算数（不然输一半跑了也算输，她会不服）。
 */
export async function stats() {
  const all = await listGames();
  let win = 0, lose = 0, draw = 0;
  for (const g of all) {
    if (!g || g.status !== 'done') continue;
    if (g.result === 'me') win++;
    else if (g.result === 'ai') lose++;
    else if (g.result === 'draw') draw++;
  }
  return { win, lose, draw, total: win + lose + draw };
}

/** 某一种游戏打了几局（大厅卡片角标用） */
export async function countByType(type) {
  const all = await listGames();
  return all.filter(g => g && g.type === type && g.status === 'done').length;
}
