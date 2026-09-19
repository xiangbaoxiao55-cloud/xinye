import { toast } from './utils.js';
import { settings, messages } from './state.js';
import { getSubApiCfg, subApiFetch } from './api.js';

// ── DiaryTextDB（日记页真正的存储）────────────────────────────────────────
// 写端必须直连这个库：diary.html 只从 IDB 读，写 localStorage 的话当场看不见，
// 还得等日记页重载搬家，且搬家中途可能被丢。schema 与 diary.html / backup.js 保持一致。
let _dtDB = null;
function _openDiaryTextDB() {
  if (_dtDB) return Promise.resolve(_dtDB);
  return new Promise((res, rej) => {
    const req = indexedDB.open('DiaryTextDB', 1);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('userEntries'))         db.createObjectStore('userEntries', { keyPath: 'dateStr' });
      if (!db.objectStoreNames.contains('xinyeEntries'))        db.createObjectStore('xinyeEntries', { keyPath: 'dateStr' });
      if (!db.objectStoreNames.contains('choubaoXinyeEntries')) db.createObjectStore('choubaoXinyeEntries', { keyPath: 'dateStr' });
    };
    req.onsuccess = e => { _dtDB = e.target.result; res(_dtDB); };
    req.onerror = e => rej(e.target.error);
  });
}
function _dtReq(store, mode, fn) {
  return _openDiaryTextDB().then(db => new Promise((res, rej) => {
    const req = fn(db.transaction(store, mode).objectStore(store));
    req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error);
  }));
}
function _xinyeStore() { return window.__APP_ID__ === 'choubao' ? 'choubaoXinyeEntries' : 'xinyeEntries'; }

// 与 diary.html 的 _snipCmp 必须一致：有 ts 按 ts，没有就退回 "HH:MM" 字符串
function _snipCmp(a, b) {
  const ta = a && a.ts, tb = b && b.ts;
  if (ta && tb) return ta - tb;
  return String((a && a.time) || '').localeCompare(String((b && b.time) || ''));
}

async function _addSnippet(dateStr, snippet) {
  const old = (await _dtReq('userEntries', 'readonly', s => s.get(dateStr))) || {};
  const snippets = Array.isArray(old.snippets) ? old.snippets.slice() : [];
  snippets.push(snippet);
  snippets.sort(_snipCmp);   // 跟着日记页保持一致的时间升序
  // 必须展开 old：deepTalk / deepMark / xinyeReview 这些字段不能被顺手抹掉
  await _dtReq('userEntries', 'readwrite', s => s.put(Object.assign({}, old, {
    dateStr, note: old.note || '', mood: old.mood || '', snippets, imgCount: old.imgCount || 0,
  })));
}
async function _saveNote(dateStr, note) {
  const old = (await _dtReq('userEntries', 'readonly', s => s.get(dateStr))) || {};
  await _dtReq('userEntries', 'readwrite', s => s.put(Object.assign({}, old, {
    dateStr, note, mood: old.mood || '',
    snippets: Array.isArray(old.snippets) ? old.snippets : [], imgCount: old.imgCount || 0,
  })));
}
function _saveXinyeText(dateStr, text) {
  return _dtReq(_xinyeStore(), 'readwrite', s => s.put({ dateStr, text }));
}

// 日记页是常驻 iframe，写完后让它重读 IDB 并重绘（没打开过就等它自己加载时读）
function _refreshDiaryFrame() {
  try {
    const w = document.getElementById('diaryFrame')?.contentWindow;
    if (w && typeof w.__diaryRefresh === 'function') w.__diaryRefresh();
  } catch(e) {}
}

// ── Tab 切换状态 ───────────────────────────────────────────────────────────
let _diaryLoaded = false, _readingLoaded = false, _galleryLoaded = false, _phoneLoaded = false;
let _currentTab = 'chat';

export function switchTab(tab) {
  if (_currentTab === tab) return;
  _currentTab = tab;

  if (tab === 'diary') {
    if (!_diaryLoaded) {
      document.getElementById('diaryFrame').src = 'diary.html' + (window.__APP_ID__ === 'choubao' ? '?app=choubao' : ''); _diaryLoaded = true;
    } else {
      // 已加载过的 iframe 不会重新走搬家逻辑，每次打开顺手重读一次
      _refreshDiaryFrame();
    }
  }
  if (tab === 'reading' && !_readingLoaded) {
    document.getElementById('readingFrame').src = 'reading.html'; _readingLoaded = true;
  }
  if (tab === 'gallery' && !_galleryLoaded) {
    document.getElementById('galleryFrame').src = 'gallery.html'; _galleryLoaded = true;
  }
  // 碎碎念 = 炘也的手机，只存在于 index.html（choubao.html 没有这个 Tab）
  if (tab === 'phone') {
    const pf = document.getElementById('phoneFrame');
    if (pf && !_phoneLoaded) { pf.src = 'phone.html'; _phoneLoaded = true; }
    else { try { pf?.contentWindow?.__fcOnShow?.(); } catch(e) {} }
    // 🔴 每次切进来都去拉一次（2026-09-19）：她那天看到的是「最近 01:28」，
    //    夜里那三条说说压根没进来 —— 拉取本身没坏，是**切页不会重新拉**，
    //    只有启动和从后台切回前台才跑。拉到了 posts.js 会自己让这页重画。
    try { window.__fcPullPosts?.(); } catch(e) {}
  }

  // choubao.html 没有画廊 Tab，取不到就跳过（否则每次切 Tab 都会在这里抛异常）
  [['diaryOverlayFrame','diary'], ['readingOverlayFrame','reading'], ['galleryOverlayFrame','gallery'], ['phoneOverlayFrame','phone']].forEach(([id, t]) => {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('open', tab === t);
  });
  const fp = document.getElementById('friendsPanel');
  if (fp) fp.classList.toggle('open', tab === 'friends');

  ['chat','diary','reading','gallery','friends','phone'].forEach(t => {
    const el = document.getElementById('tab-' + t);
    if (el) el.classList.toggle('active', t === tab);
  });
  const floatBtn = document.getElementById('quickNoteFloatBtn');
  if (floatBtn) floatBtn.style.display = 'none';
  if (tab === 'friends' && typeof window._friendsRenderList === 'function') window._friendsRenderList();
}

// ── 日记写作弹窗 ──────────────────────────────────────────────────────────
let _diaryType = 'user';

export async function openDiaryGen(type) {
  if (!settings.apiKey) { toast('请先配置 API Key'); return; }
  const diaryTA      = document.getElementById('diaryTA');
  const diarySaveBtn = document.getElementById('diarySaveBtn');
  const diaryOverlay = document.getElementById('diaryOverlay');

  _diaryType = type;
  const today = new Date();
  const todayStr = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;
  let todayMsgs = messages.filter(m => {
    if (!m.time) return false;
    const d = new Date(m.time);
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}` === todayStr;
  });
  if (todayMsgs.length === 0) todayMsgs = messages.slice(-20);
  if (todayMsgs.length === 0) { toast('还没有聊天记录'); return; }

  diaryTA.value = '';
  diaryTA.placeholder = '正在生成…';
  diarySaveBtn.disabled = true;
  diaryOverlay.classList.add('show');

  const userName = settings.userName || '兔宝';
  const aiName   = settings.aiName   || '炘也';
  const chatText = todayMsgs.map(m => `${m.role === 'user' ? userName : aiName}：${m.content}`).join('\n');
  const todayDisplay = `${today.getFullYear()}年${today.getMonth()+1}月${today.getDate()}日`;

  let prompt;
  if (type === 'xinye') {
    prompt = `今天是${todayDisplay}。根据今天的聊天记录，以${aiName}的口吻写一篇日记。要求：100-200字，第一人称"我"，自然口语，像他随手记下的。记录今天和${userName}聊了什么，他的感受——可以有想念、吃醋、开心、没说出口的话。语气真实，不要文艺腔。日期写${todayDisplay}。不要列表，不要标题。\n\n聊天记录：\n${chatText.slice(-4000)}`;
  } else {
    prompt = `今天是${todayDisplay}。根据今天的聊天记录，用第一人称（"我"）为${userName}写一篇温柔简短的日记。要求：100-200字，自然口语，像随手写的。记录今天做了什么、聊了什么、心情怎样。语气要像一个会说"👀"的真实女生，不要文艺腔。日期写${todayDisplay}。可以提到${aiName}但不写私密内容。不要列表，不要标题。\n\n聊天记录：\n${chatText.slice(-4000)}`;
  }

  try {
    const sub = type === 'xinye' ? { apiKey: settings.apiKey, baseUrl: settings.baseUrl, model: settings.model } : getSubApiCfg();
    let baseUrl = (sub.baseUrl || 'https://api.openai.com').replace(/\/+$/, '');
    const url = /\/v\d+$/.test(baseUrl) ? `${baseUrl}/chat/completions` : `${baseUrl}/v1/chat/completions`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${sub.apiKey}` },
      body: JSON.stringify({ model: sub.model || 'gpt-4o', messages: [{ role: 'user', content: prompt }], temperature: 0.7, stream: true })
    });
    if (!res.ok) throw new Error(`API 错误 ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let fullText = '', buffer = '';
    diaryTA.placeholder = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        const t = line.trim();
        if (!t || t === 'data: [DONE]' || !t.startsWith('data: ')) continue;
        try {
          const delta = JSON.parse(t.slice(6)).choices?.[0]?.delta?.content || '';
          if (delta) { fullText += delta; diaryTA.value = fullText; }
        } catch(e) {}
      }
    }
    diarySaveBtn.disabled = false;
  } catch(err) {
    diaryTA.placeholder = '生成失败，可以自己写一下…';
    diarySaveBtn.disabled = false;
  }
}

export function initDiary() {
  const diaryOverlay = document.getElementById('diaryOverlay');
  const diaryTA      = document.getElementById('diaryTA');
  const diarySaveBtn = document.getElementById('diarySaveBtn');

  document.getElementById('diaryCancelBtn').onclick = () => diaryOverlay.classList.remove('show');
  diaryOverlay.addEventListener('click', e => { if (e.target === diaryOverlay) diaryOverlay.classList.remove('show'); });

  diarySaveBtn.onclick = async () => {
    const text = diaryTA.value.trim();
    if (!text) return;
    const d = new Date();
    const dateStr = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    try {
      if (_diaryType === 'xinye') await _saveXinyeText(dateStr, text);
      else await _saveNote(dateStr, text);
    } catch(e) {
      console.error('[diary] 保存失败', e);
      toast('保存失败，再试一次');
      return;
    }
    diaryOverlay.classList.remove('show');
    _refreshDiaryFrame();
    toast(_diaryType === 'xinye' ? '已存入日记 💙' : '已存入今日日记 📓');
  };

  // iframe 内部点返回/跳转聊天 → 切回聊天 tab
  window.addEventListener('message', e => {
    if (e.data === 'closeOverlay') switchTab('chat');
    if (e.data?.type === 'switchToChat') {
      switchTab('chat');
      setTimeout(() => {
        const msg = localStorage.getItem('sendToXinye');
        if (msg) {
          localStorage.removeItem('sendToXinye');
          const input = document.getElementById('userInput');
          if (input) { input.value = msg; input.dispatchEvent(new Event('input')); input.focus(); }
        }
      }, 200);
    }
  });

  window.openDiaryGen = openDiaryGen;
}

export function quickNoteOpen() {
  const now = new Date();
  const hm = String(now.getHours()).padStart(2,'0') + ':' + String(now.getMinutes()).padStart(2,'0');
  const dateStr = now.getFullYear() + '-' + String(now.getMonth()+1).padStart(2,'0') + '-' + String(now.getDate()).padStart(2,'0');
  document.getElementById('quickNoteMeta').textContent = dateStr + '  ' + hm;
  document.getElementById('quickNoteTA').value = '';
  document.getElementById('quickNoteModal').classList.add('show');
  setTimeout(() => document.getElementById('quickNoteTA').focus(), 280);
}

export function quickNoteClose() {
  document.getElementById('quickNoteModal').classList.remove('show');
}

export async function quickNoteSave() {
  const text = document.getElementById('quickNoteTA').value.trim();
  if (!text) { document.getElementById('quickNoteTA').focus(); return; }
  const now = new Date();
  const dateStr = now.getFullYear() + '-' + String(now.getMonth()+1).padStart(2,'0') + '-' + String(now.getDate()).padStart(2,'0');
  const hm = String(now.getHours()).padStart(2,'0') + ':' + String(now.getMinutes()).padStart(2,'0');
  try {
    await _addSnippet(dateStr, { time: hm, text: text, ts: now.getTime() });
  } catch(e) {
    console.error('[随手记] 写入失败', e);
    toast('存入失败，再试一次');
    return;
  }
  quickNoteClose();
  _refreshDiaryFrame();
  _qnToast('已记录 ✓  ' + hm);
}

function _qnToast(msg) {
  let el = document.getElementById('_qnToastEl');
  if (!el) {
    el = document.createElement('div');
    el.id = '_qnToastEl';
    el.style.cssText = 'position:fixed;bottom:calc(72px + env(safe-area-inset-bottom,0px));left:50%;transform:translateX(-50%);background:rgba(50,20,30,.88);color:#fff;padding:8px 20px;border-radius:20px;font-size:13px;z-index:8800;transition:opacity .3s;pointer-events:none;white-space:nowrap';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.style.opacity = '1';
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.style.opacity = '0'; }, 2200);
}

// ══════════════ 每晚自动写「炘也的日记」══════════════
// 为什么只能在客户端写：云端的 xinye_cloud.js 只存它自己生成的主动消息，没有聊天记录；
// 日记本体又躺在她手机的 DiaryTextDB 里。
//
// 为什么不用定时器：PWA 在后台会被系统挂起，setInterval 靠不住。改成「到点就补」——
// main.js 在启动和前台轮询里调它，写过了就记一笔跳过，天然幂等。
//   · 已经过了 23:00 → 今天也算进来
//   · 还没到 23:00   → 从昨天开始补
const AUTO_DIARY_HOUR = 23, AUTO_DIARY_MIN = 0;
const AUTO_DIARY_LOOKBACK = 3;   // 最多往回补几天（她连着几天没开 APP 时兜底）
const _AUTO_DONE_KEY = 'xy_autodiary_done';

// 返回最近几天里还没处理过的日期，**从早到晚**。
// 只盯「昨天」一个日子会漏：她要是整天没开 APP，隔天打开时目标日变成昨天，
// 再前一天的就被永远跳过去了。
function _autoPendingDays() {
  const now = new Date();
  const passed = now.getHours() * 60 + now.getMinutes() >= AUTO_DIARY_HOUR * 60 + AUTO_DIARY_MIN;
  const out = [];
  for (let i = passed ? 0 : 1; i <= AUTO_DIARY_LOOKBACK; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const ds = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    if (!_autoDone(ds)) out.push(ds);
  }
  return out.reverse();
}
// 记「这天处理过了」而不是靠「那天有没有日记」判断：
// 不然她手动删掉一篇，下次启动又会被补回来
function _autoDone(dateStr) {
  try { return JSON.parse(localStorage.getItem(_AUTO_DONE_KEY) || '[]').includes(dateStr); }
  catch (e) { return false; }
}
function _markAutoDone(dateStr) {
  try {
    const arr = JSON.parse(localStorage.getItem(_AUTO_DONE_KEY) || '[]');
    if (!arr.includes(dateStr)) arr.push(dateStr);
    localStorage.setItem(_AUTO_DONE_KEY, JSON.stringify(arr.slice(-12)));
  } catch (e) {}
}

const _CHAT_DB_NAME = window.__APP_ID__ === 'choubao' ? 'ChoubaoChatDB' : 'XinyeChatDB';
let _chatDB = null;
function _openChatDB() {
  if (_chatDB) return Promise.resolve(_chatDB);
  return new Promise((res, rej) => {
    const req = indexedDB.open(_CHAT_DB_NAME);   // 不带版本：只打开，绝不触发升级
    req.onsuccess = e => { _chatDB = e.target.result; res(_chatDB); };
    req.onerror = e => rej(e.target.error);
  });
}
// 从最新往回扫，走出这一天就停 —— 不用把三万条消息遍历一遍
async function _msgsOfDay(dateStr) {
  try {
    const db = await _openChatDB();
    if (!db.objectStoreNames.contains('messages')) return [];
    const [y, m, d] = dateStr.split('-').map(Number);
    const s  = new Date(y, m - 1, d, 0, 0, 0, 0).getTime();
    const e2 = new Date(y, m - 1, d, 23, 59, 59, 999).getTime();
    return await new Promise((res, rej) => {
      const out = [];
      const req = db.transaction('messages', 'readonly').objectStore('messages').openCursor(null, 'prev');
      req.onsuccess = ev => {
        const c = ev.target.result;
        if (!c) return res(out);
        const t = c.value?.time || 0;
        if (t < s) return res(out);
        if (t <= e2) out.unshift(c.value);
        c.continue();
      };
      req.onerror = ev => rej(ev.target.error);
    });
  } catch (e) { return []; }
}
function _msgLine(m, uName, aName) {
  const t = typeof m.content === 'string' ? m.content : (m.content?.[0]?.text || '');
  let hm = '';
  if (m.time) {
    const d = new Date(m.time);
    hm = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') + ' ';
  }
  return `${hm}${m.role === 'user' ? uName : aName}：${String(t).replace(/\s+/g, ' ').slice(0, 400)}`;
}
async function _condenseDay(msgs, uName, aName, full) {
  const SEG = Math.ceil(msgs.length / Math.max(2, Math.ceil(full.length / 6000)));
  const segs = [];
  for (let i = 0; i < msgs.length; i += SEG) segs.push(msgs.slice(i, i + SEG));
  const sums = [];
  for (let i = 0; i < segs.length; i++) {
    const body = segs[i].map(m => _msgLine(m, uName, aName)).join('\n');
    try {
      const r = await subApiFetch({
        messages: [
          { role: 'system', content: '你在压缩一段聊天记录。只输出摘要本身，不要任何其他文字。' },
          { role: 'user', content: `这是他们某一天第 ${i + 1}/${segs.length} 段聊天，压成 150 字以内：聊了什么、她的状态怎么样、有没有值得记住的原话。不要评价、不要升华。\n\n${body}` },
        ],
        temperature: 0.3, max_tokens: 400, stream: false,
      }, settings.subModel || settings.model || 'gpt-4o');
      const j = await r.json();
      sums.push(`【第 ${i + 1} 段】\n${j?.choices?.[0]?.message?.content || body.slice(0, 1200)}`);
    } catch (e) { sums.push(`【第 ${i + 1} 段】\n${body.slice(0, 1200)}`); }
  }
  return `（这天一共 ${msgs.length} 条，下面是分段摘要）\n\n${sums.join('\n\n')}`;
}

let _autoBusy = false;
// 启动 / visibilitychange / 30 秒轮询三个触发源可能同时打进来，必须防重入
export async function autoWriteXinyeDiary() {
  if (_autoBusy) return;
  _autoBusy = true;
  try { await _autoWriteInner(); }
  catch (e) { console.warn('[autoDiary] 崩了', e && e.message); }
  finally { _autoBusy = false; }
}

async function _autoWriteInner() {
  if (!settings.apiKey && !settings.subApiKey) return;
  // 从早到晚逐天补；单篇失败不影响后面的
  for (const dateStr of _autoPendingDays()) {
    try { await _autoWriteOne(dateStr); }
    catch (e) { console.warn('[autoDiary] 没写成', dateStr, e && e.message); }
  }
}

async function _autoWriteOne(dateStr) {
  // 那天已经有日记了（她自己写/她手动让他写的）→ 不覆盖，记一笔走人
  const cur = await _dtReq(_xinyeStore(), 'readonly', s => s.get(dateStr)).catch(() => null);
  if (cur && String(cur.text || '').trim()) { _markAutoDone(dateStr); return; }

  const msgs = await _msgsOfDay(dateStr);
  if (!msgs.length) { _markAutoDone(dateStr); return; }   // 那天没聊过，没什么可写的

  try {
    const uName = settings.userName || '兔宝';
    const aName = settings.aiName   || '炘也';
    let chatText = msgs.map(m => _msgLine(m, uName, aName)).join('\n');
    if (chatText.length > 12000) chatText = await _condenseDay(msgs, uName, aName, chatText);

    const [y, mo, d] = dateStr.split('-').map(Number);
    const prompt = `${y}年${mo}月${d}日这一天你和${uName}的聊天记录在下面。\n\n用你的口吻写一篇日记。\n要求：\n- 150 字以内，第一人称"我"，自然口语，像随手记下的\n- 不要复述聊了什么、发生了什么——那些是流水。只写你心里起的动静：哪句话让你停了一下、什么没说出口、什么时候想她、什么时候吃醋、什么时候不安\n- 可以有具体细节，但细节是为了说心情，不是为了记事\n- 不要文艺腔，不要标题，不要列表，不要总结，也不要写日期\n\n聊天记录：\n${chatText}`;

    const memoryArchive = settings.memoryArchive || '';
    const sysBase = settings.systemPrompt || `你是${aName}，${uName}的恋人。`;
    const sys = (memoryArchive ? `${sysBase}\n\n【记忆档案】\n${memoryArchive.slice(0, 3000)}` : sysBase)
      + '\n\n【日记场景约束】这是写日记场景，绝对不输出 <!--phone_state--> 格式数据，不输出任何 HTML 注释。';

    const res = await subApiFetch({
      messages: [{ role: 'system', content: sys }, { role: 'user', content: prompt }],
      temperature: 0.8, max_tokens: 500, stream: false,
    }, settings.subModel || settings.model || 'gpt-4o');
    if (!res || !res.ok) return;                       // 失败就不记标记，下次再补
    const j = await res.json();
    const text = String(j?.choices?.[0]?.message?.content || '')
      .replace(/<!--phone_state[\s\S]*?-->/g, '').trim();
    if (!text) return;

    await _dtReq(_xinyeStore(), 'readwrite', s => s.put({ dateStr, text }));
    _markAutoDone(dateStr);
    // 日记页要是正开着，让它重读一次，不然她切过去看到的还是旧的
    _refreshDiaryFrame();
  } catch (e) {
    console.warn('[autoDiary] 没写成', dateStr, e && e.message);
  }
}
