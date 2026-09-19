// XinyePhoneDB — 炘也手机数据库
const DB_NAME = 'XinyePhoneDB';
const DB_VER  = 3;
const STORES  = ['xinye_memo','xinye_lyrics','xinye_quotes','xinye_drafts','xinye_mood','xinye_browser','xinye_photos','xinye_wallpapers'];

let _db = null;

export function openPhoneDB() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('xinye_memo')) {
        const s = db.createObjectStore('xinye_memo', { autoIncrement: true, keyPath: 'id' });
        s.createIndex('type', 'type', { unique: false });
        s.createIndex('done', 'done', { unique: false });
      }
      for (const name of ['xinye_lyrics','xinye_quotes','xinye_browser','xinye_photos']) {
        if (!db.objectStoreNames.contains(name)) {
          const s = db.createObjectStore(name, { autoIncrement: true, keyPath: 'id' });
          s.createIndex('time', 'time', { unique: false });
        }
      }
      for (const name of ['xinye_drafts','xinye_mood','xinye_wallpapers']) {
        if (!db.objectStoreNames.contains(name)) {
          db.createObjectStore(name, { keyPath: 'key' });
        }
      }
    };
    req.onsuccess = e => {
      _db = e.target.result;
      _db.onversionchange = () => { _db.close(); _db = null; };
      resolve(_db);
    };
    req.onerror   = e => reject(e.target.error);
    req.onblocked = () => reject(new Error('XinyePhoneDB onblocked'));
  });
}

function tx(store, mode = 'readonly') {
  return _db.transaction(store, mode).objectStore(store);
}

export function addRecord(store, data) {
  return new Promise((resolve, reject) => {
    const req = tx(store, 'readwrite').add(data);
    req.onsuccess = () => resolve(req.result);
    req.onerror   = e => reject(e.target.error);
  });
}

export function putRecord(store, data) {
  return new Promise((resolve, reject) => {
    const req = tx(store, 'readwrite').put(data);
    req.onsuccess = () => resolve(req.result);
    req.onerror   = e => reject(e.target.error);
  });
}

export function getRecord(store, key) {
  return new Promise((resolve, reject) => {
    const req = tx(store).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror   = e => reject(e.target.error);
  });
}

export function deleteRecord(store, key) {
  return new Promise((resolve, reject) => {
    const req = tx(store, 'readwrite').delete(key);
    req.onsuccess = () => resolve();
    req.onerror   = e => reject(e.target.error);
  });
}

export function getAllFromStore(store) {
  return new Promise((resolve, reject) => {
    const req = tx(store).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror   = e => reject(e.target.error);
  });
}

// 取到期的未完成待办（有 trigger_at 且已到时间），用于注入系统提示词
export async function getPendingTodos() {
  await openPhoneDB();
  const all = await getAllFromStore('xinye_memo');
  const now = Date.now();
  return all.filter(m => m.type === 'todo' && !m.done && m.trigger_at && new Date(m.trigger_at).getTime() <= now);
}

// 取全部未完成待办，供炘也调用 set_reminder 前自行判断是否重复
export async function getAllUndoneTodos() {
  await openPhoneDB();
  const all = await getAllFromStore('xinye_memo');
  return all.filter(m => m.type === 'todo' && !m.done);
}

/**
 * 他最近记的笔记（不含待办、不含云端写的「说说」）—— 取出来拼进提示词。
 *
 * 🔴 2026-09-19 加：她那天一晚上在碎碎念里看到**四条「她今天吃了四顿饭…」**
 *    （00:12 / 00:28 / 01:26 / 01:28，同一个意思换了四种说法）。
 *    根因**不是**写入端漏查重 —— 是**模型看不见自己已经记过什么**：
 *    phone_state 的约定是"只输出本轮新增的"，可每一轮它都重新判断一次"今天发生了什么"，
 *    于是把当天最显眼的那件事又写一遍。把最近记过的摆到它眼前（跟云端碎碎念那条路
 *    的 recentPostStr 一个道理），它才有东西可比。
 *
 * ⚠️ 只取最近 `hours` 小时的：几天前记过「今天吃了四顿饭」，今天再记一条是**新的事**，
 *    不该被这条清单吓得不敢写。
 */
export async function getRecentNotes(limit = 8, hours = 48) {
  await openPhoneDB();
  const all = await getAllFromStore('xinye_memo');
  const cutoff = Date.now() - hours * 3600 * 1000;
  return all
    .filter(m => m && m.content && m.type !== 'todo' && m.type !== 'post')
    .filter(m => { const t = Date.parse(String(m.time || '').replace(/-/g, '/')); return !t || t >= cutoff; })
    .slice(-limit);
}

// 单条标记待办为已完成（供 complete_reminder 工具调用）
export async function completeTodoById(id) {
  await openPhoneDB();
  const item = await getRecord('xinye_memo', id);
  if (!item || item.done) return 'not_found';
  await putRecord('xinye_memo', { ...item, done: true });
  return 'ok';
}

// 添加待办（同一天相似内容去重：有≥5字公共子串即视为重复）
export async function addTodoWithDedup(content, triggerAt) {
  await openPhoneDB();
  const all = await getAllFromStore('xinye_memo');
  const triggerDay = triggerAt ? triggerAt.slice(0, 10) : null;
  function hasSimilarContent(a, b) {
    if (a === b) return true;
    const minLen = 5;
    for (let i = 0; i <= a.length - minLen; i++) {
      if (b.includes(a.slice(i, i + minLen))) return true;
    }
    return false;
  }
  const dup = all.find(m => {
    if (m.type !== 'todo' || m.done) return false;
    const mDay = m.trigger_at ? m.trigger_at.slice(0, 10) : null;
    if (triggerDay !== mDay) return false;
    return hasSimilarContent(content, m.content);
  });
  if (dup) return 'duplicate';
  const now = new Date().toLocaleString('zh-CN', { hour12: false }).replace(/\//g, '-');
  await addRecord('xinye_memo', { type: 'todo', content, done: false, trigger_at: triggerAt, time: now });
  return 'ok';
}

// dataUrl → Blob
export function dataUrlToBlob(dataUrl) {
  const [header, b64] = dataUrl.split(',');
  const mime = header.match(/:(.*?);/)[1];
  const bytes = atob(b64);
  const arr = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

// 解析 phone_state，写入IDB
// turnReceivedImgs: dataUrl[] | null，turnGeneratedDataUrl: string | null
export async function parseAndSavePhoneState(rawText, turnReceivedImgs, turnGeneratedDataUrl) {
  const match = rawText.match(/<!--phone_state\s*([\s\S]*?)-->/);
  if (!match) return rawText;

  let data;
  try { data = JSON.parse(match[1].trim()); }
  catch(e) { return rawText.replace(/<!--phone_state[\s\S]*?-->/, '').trimEnd(); }

  await openPhoneDB();
  const now = new Date().toLocaleString('zh-CN', { hour12: false }).replace(/\//g, '-');

  // memo（只处理笔记，待办由 set_reminder 工具统一管理）
  if (data.memo?.items) {
    for (const item of data.memo.items) {
      if (item.type !== 'todo') {
        await addRecord('xinye_memo', { type: item.type || 'note', content: item.content, done: false, time: now });
      }
    }
  }

  // quotes / browser（lyrics 2026-09-16 下线：提示词已去掉，这里不再收 —— 旧数据仍在 xinye_lyrics 里封存）
  const _appendMap = { quotes: 'xinye_quotes', browser: 'xinye_browser' };
  for (const [key, store] of Object.entries(_appendMap)) {
    if (data[key]?.items) {
      for (const item of data[key].items) {
        await addRecord(store, { ...item, time: now });
      }
    }
  }

  // drafts / mood（current → history → new current）
  // ⚠️ 2026-09-16 起提示词里已把这两类并进「备忘录」，所以他不会再往这儿写新东西。
  //    这段留着当**兼容**：万一模型还按老习惯吐 drafts/mood（或者导进来的旧备份里有），
  //    照样能落库、照样在碎碎念里显示。store 和 DB_VER 一律不动。
  for (const [key, store] of [['drafts','xinye_drafts'],['mood','xinye_mood']]) {
    if (data[key]?.content) {
      const cur  = await getRecord(store, 'current');
      const hist = (await getRecord(store, 'history')) || { key: 'history', items: [] };
      if (cur?.content) hist.items.unshift({ content: cur.content, time: cur.time });
      await putRecord(store, { key: 'current', content: data[key].content, time: now });
      await putRecord(store, hist);
    }
  }

  // photos
  if (data.photos?.items) {
    for (const item of data.photos.items) {
      try {
        if (item.type === 'memo') {
          await addRecord('xinye_photos', { type: 'memo', caption: item.caption, time: now });
        } else if (item.source === 'generated' && turnGeneratedDataUrl) {
          const blob = dataUrlToBlob(turnGeneratedDataUrl);
          await addRecord('xinye_photos', { type: 'image', source: 'generated', blob, caption: item.caption, time: now });
        } else if (item.source === 'received' && turnReceivedImgs?.[item.index]) {
          const blob = dataUrlToBlob(turnReceivedImgs[item.index]);
          await addRecord('xinye_photos', { type: 'image', source: 'received', blob, caption: item.caption, time: now });
        }
      } catch(e) { /* 静默跳过单张图的失败 */ }
    }
  }

  return rawText.replace(/<!--phone_state[\s\S]*?-->/, '').trimEnd();
}
