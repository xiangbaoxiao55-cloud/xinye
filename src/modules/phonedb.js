// XinyePhoneDB — 炘也手机数据库
const DB_NAME = 'XinyePhoneDB';
const DB_VER  = 3;

/**
 * 🔴 2026-09-21：她在碎碎念里看到两条**一字不差**的
 *    「她要开始每周去图书馆+书店的节奏了…」（08:24 和 08:44）。
 *
 * 这一层只挡「逐字相同」—— 措辞不同的重复仍然靠 chat.js 那份「你最近记过的」清单
 * 摆到他眼前（她 9/19 定的规矩就是"别搞内容查重"）。但**一模一样**的那种没有任何
 * 可解释的余地：换行/空格不同也算同一条，所以先压掉空白再比。
 *
 * ⚠️ 只往回看 12 小时：隔几天再写同样一句，那是新的事，不该被这条挡住。
 */
const NOTE_DUP_WINDOW_MS = 12 * 3600 * 1000;

/** 碎碎念那一页的数据被改过了（inbox.js 的轮询看到它会去让那页重画，见 __phoneDirty） */
function _markPhoneDirty() { try { window.__phoneDirty = true; } catch (e) {} }
const STORES  = ['xinye_memo','xinye_lyrics','xinye_quotes','xinye_drafts','xinye_mood','xinye_browser','xinye_photos','xinye_wallpapers'];

let _db = null;

/**
 * 🔴 2026-09-22：连接**可能已经被系统悄悄回收**（鸿蒙 WebView 在后台、或内存吃紧时会这么干）——
 *    `_db` 这个引用还在，但拿它开的任何事务都会抛 InvalidStateError。
 *    这里原来是 `if (_db) return _db`，坏连接会被一直用下去。表现就是她那句
 *    「含笑花不退出重进就不刷新」：每次切进那一页读库都失败，而失败被静默吞掉，
 *    页面停在旧内容；她退出重进 = 换了一条全新连接，立刻就正常了。
 *    拿一个空事务探一下 —— 坏了就丢掉，往下重开。
 */
export function openPhoneDB() {
  if (_db) {
    try { _db.transaction('xinye_memo'); return Promise.resolve(_db); }
    catch (e) { try { _db.close(); } catch (_e) {} _db = null; }
  }
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

/** 丢掉当前连接（读库失败重试时用）—— 下一次 openPhoneDB() 会重开一条新的 */
export function resetPhoneDB() {
  try { if (_db) _db.close(); } catch (e) {}
  _db = null;
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
  _markPhoneDirty();      // 待办也在碎碎念那一页上（她正开着那页时让它重画）
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
  catch(e) {
    // 🔴 一个静默失败的口子：他吐的那段 JSON 坏了，这里原来一声不吭地把它删掉就走 ——
    //    页面上看不出来、库里也不留痕迹，事后只能靠"翻库数条数"去猜是不是丢过东西。
    console.log('[碎碎念] phone_state 解析失败，这一整段丢了：', e && e.message,
      '| 原文前 120 字：', String(match[1]).trim().slice(0, 120));
    return rawText.replace(/<!--phone_state[\s\S]*?-->/, '').trimEnd();
  }

  await openPhoneDB();
  const now = new Date().toLocaleString('zh-CN', { hour12: false }).replace(/\//g, '-');

  // memo（只处理笔记，待办由 set_reminder 工具统一管理）
  if (data.memo?.items) {
    // 先把「最近记过的」拉出来，逐字相同的直接跳过（见上面 NOTE_DUP_WINDOW_MS 那段）。
    // 一次读库就够 —— 下面每一条都在这个集合里比。
    const _nowMs = Date.now();
    const _norm = s => String(s || '').replace(/\s+/g, '');
    let _seenNotes = new Set();
    try {
      _seenNotes = new Set(
        (await getAllFromStore('xinye_memo'))
          .filter(m => m && m.content && m.type !== 'todo')
          .filter(m => {
            const t = Date.parse(String(m.time || '').replace(/-/g, '/'));
            return !t || _nowMs - t <= NOTE_DUP_WINDOW_MS;
          })
          .map(m => _norm(m.content))
      );
    } catch (e) {
      // 读不出来就退化成"不做这层兜底" —— 绝不能因为查重把整条 phone_state 顶掉
      // （那会让这段 JSON 直接显示在她说的话里）。写库本身还是会照常抛，跟原来一样。
      console.log('[碎碎念] 查重读库失败，跳过查重:', e && e.message);
    }
    for (const item of data.memo.items) {
      if (item.type !== 'todo') {
        const _key = _norm(item.content);
        if (!_key) continue;
        if (_seenNotes.has(_key)) {
          console.log('[碎碎念] 逐字重复，跳过一条：', String(item.content).slice(0, 30));
          continue;                       // 12 小时内写过的同一句话，不再落一条
        }
        _seenNotes.add(_key);             // 同一轮里他写了两遍也挡住
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

  // 🔴 2026-09-21：这一轮真往库里写东西了 → 举一下手，让主 APP 知道碎碎念那一页该重画了。
  //    她正开着那页时，inbox.js 的 30 秒轮询会看到这个标记（见 _pullPosts）。
  //    宁可多举一次手（那页自己会比对指纹，没变就不重排），也别漏。
  if (data.memo?.items?.length || data.quotes?.items?.length || data.browser?.items?.length
      || data.photos?.items?.length || data.drafts?.content || data.mood?.content) {
    _markPhoneDirty();
  }

  return rawText.replace(/<!--phone_state[\s\S]*?-->/, '').trimEnd();
}
