import { toast } from './utils.js';
import { settings, messages } from './state.js';
import { getSubApiCfg } from './api.js';

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

async function _addSnippet(dateStr, snippet) {
  const old = (await _dtReq('userEntries', 'readonly', s => s.get(dateStr))) || {};
  const snippets = Array.isArray(old.snippets) ? old.snippets.slice() : [];
  snippets.push(snippet);
  await _dtReq('userEntries', 'readwrite', s => s.put({
    dateStr, note: old.note || '', mood: old.mood || '', snippets, imgCount: old.imgCount || 0,
  }));
}
async function _saveNote(dateStr, note) {
  const old = (await _dtReq('userEntries', 'readonly', s => s.get(dateStr))) || {};
  await _dtReq('userEntries', 'readwrite', s => s.put({
    dateStr, note, mood: old.mood || '',
    snippets: Array.isArray(old.snippets) ? old.snippets : [], imgCount: old.imgCount || 0,
  }));
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
let _diaryLoaded = false, _readingLoaded = false, _galleryLoaded = false;
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

  // choubao.html 没有画廊 Tab，取不到就跳过（否则每次切 Tab 都会在这里抛异常）
  [['diaryOverlayFrame','diary'], ['readingOverlayFrame','reading'], ['galleryOverlayFrame','gallery']].forEach(([id, t]) => {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('open', tab === t);
  });
  const fp = document.getElementById('friendsPanel');
  if (fp) fp.classList.toggle('open', tab === 'friends');

  ['chat','diary','reading','gallery','friends'].forEach(t => {
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
