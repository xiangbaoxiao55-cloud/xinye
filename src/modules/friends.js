import { db, dbGetAll, dbPut, dbDelete } from './db.js';
import { toast, fallbackCopy, escHtml } from './utils.js';
import { getApiPresets } from './api.js';

const isMobile = /Android|iPhone|iPad|iPod|HarmonyOS/i.test(navigator.userAgent)
  || ('ontouchstart' in window && screen.width < 768);

let _friends = [];
let _editingFriendId = null;
let _currentFriend = null;
let _friendMessages = [];
let _friendSending = false;

// ---- IDB helpers (direct transactions for friendMessages store) ----

function idbGetFriendMsgs(friendId) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('friendMessages', 'readonly');
    const idx = tx.objectStore('friendMessages').index('byFriend');
    const req = idx.getAll(friendId);
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = e => reject(e.target.error);
  });
}
function idbAddFriendMsg(msg) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('friendMessages', 'readwrite');
    const req = tx.objectStore('friendMessages').add(msg);
    req.onsuccess = () => { msg.id = req.result; resolve(msg); };
    req.onerror = e => reject(e.target.error);
  });
}
function idbDeleteFriendMsgs(friendId) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('friendMessages', 'readwrite');
    const idx = tx.objectStore('friendMessages').index('byFriend');
    const req = idx.openCursor(IDBKeyRange.only(friendId));
    req.onsuccess = e => {
      const cursor = e.target.result;
      if (cursor) { cursor.delete(); cursor.continue(); } else resolve();
    };
    req.onerror = e => reject(e.target.error);
  });
}

// ---- Internal helpers ----

async function loadFriends() {
  _friends = await dbGetAll('friends');
  _friends.sort((a, b) => (a.createdAt||0) - (b.createdAt||0));
}

function renderFriendsList() {
  const list = document.getElementById('friendsList');
  if (!list) return;
  if (_friends.length === 0) {
    list.innerHTML = '<div class="friends-empty"><div style="font-size:36px">🤝</div><div>还没有AI朋友</div><div style="font-size:12px;opacity:.7">点右上角 + 添加</div></div>';
    return;
  }
  list.innerHTML = _friends.map(f => `
    <div class="friend-card" onclick="openFriendChat('${f.id}')">
      <div class="friend-card-avatar" style="background:${f.bgColor||'rgba(128,128,128,.12)'}">${f.emoji||'🤖'}</div>
      <div class="friend-card-info">
        <div class="friend-card-name">${escHtml(f.name)}</div>
        <div class="friend-card-model">${escHtml(f.model||'')}</div>
      </div>
      <button class="friend-card-edit" onclick="event.stopPropagation();openFriendModal('${f.id}')" title="编辑">✏️</button>
    </div>
  `).join('');
}

function formatFriendTime(ts) {
  if (!ts) return '';
  const d = new Date(ts), now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const msgDay = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const hh = String(d.getHours()).padStart(2,'0'), mm = String(d.getMinutes()).padStart(2,'0');
  return msgDay.getTime() === today.getTime() ? hh+':'+mm : (d.getMonth()+1)+'/'+(d.getDate())+' '+hh+':'+mm;
}

function finalizeFriendMsgRow(row, meta, msg) {
  if (!row || !meta || !msg.id) return;
  row.dataset.msgId = msg.id;
  let timeEl = meta.querySelector('.friend-msg-time');
  if (timeEl) timeEl.textContent = formatFriendTime(msg.ts);
  if (!meta.querySelector('.friend-msg-copy')) {
    const copyBtn = document.createElement('button');
    copyBtn.className = 'friend-msg-copy';
    copyBtn.title = '复制';
    copyBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none"><rect x="9" y="9" width="13" height="13" rx="2" fill="currentColor" opacity="0.2" stroke="currentColor" stroke-width="1.8"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
    copyBtn.onclick = () => {
      const bubble = row.querySelector('.friend-msg-bubble');
      const text = bubble ? bubble.textContent : '';
      navigator.clipboard.writeText(text).then(() => toast('已复制')).catch(() => fallbackCopy(text));
    };
    const delBtn2 = meta.querySelector('.friend-msg-del');
    delBtn2 ? meta.insertBefore(copyBtn, delBtn2) : meta.appendChild(copyBtn);
  }
  if (!meta.querySelector('.friend-msg-del')) {
    const delBtn = document.createElement('button');
    delBtn.className = 'friend-msg-del'; delBtn.textContent = '×';
    delBtn.onclick = () => deleteFriendMsg(msg.id, row);
    meta.appendChild(delBtn);
  }
}

function renderFriendChatMessages() {
  const area = document.getElementById('friendChatArea');
  if (!area || !_currentFriend) return;
  area.innerHTML = '';
  if (_friendMessages.length === 0) {
    area.innerHTML = '<div style="text-align:center;opacity:.4;font-size:13px;padding:40px 20px">和'+escHtml(_currentFriend.name)+'打个招呼吧</div>';
    return;
  }
  _friendMessages.forEach(m => appendFriendMsgDOM(m, false));
}

function appendFriendMsgDOM(msg, scroll) {
  const area = document.getElementById('friendChatArea');
  if (!area || !_currentFriend) return { bubble: null, row: null, meta: null };
  const isUser = msg.role === 'user';
  const row = document.createElement('div');
  row.className = 'friend-msg-row ' + (isUser ? 'user' : 'ai');
  if (msg.id) row.dataset.msgId = msg.id;

  const avatarEl = document.createElement('div');
  avatarEl.className = 'friend-msg-avatar';
  if (isUser) { avatarEl.textContent = '🐰'; avatarEl.style.background = 'rgba(255,182,193,.2)'; }
  else { avatarEl.textContent = _currentFriend.emoji||'🤖'; avatarEl.style.background = _currentFriend.bgColor||'rgba(128,128,128,.12)'; }

  const body = document.createElement('div');
  body.className = 'friend-msg-body';

  const bubble = document.createElement('div');
  bubble.className = 'friend-msg-bubble';
  bubble.textContent = msg.content;
  body.appendChild(bubble);

  const meta = document.createElement('div');
  meta.className = 'friend-msg-meta';
  const timeEl = document.createElement('span');
  timeEl.className = 'friend-msg-time';
  timeEl.textContent = formatFriendTime(msg.ts);
  meta.appendChild(timeEl);
  if (msg.id) {
    const copyBtn = document.createElement('button');
    copyBtn.className = 'friend-msg-copy';
    copyBtn.title = '复制';
    copyBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none"><rect x="9" y="9" width="13" height="13" rx="2" fill="currentColor" opacity="0.2" stroke="currentColor" stroke-width="1.8"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
    copyBtn.onclick = () => {
      const text = bubble.textContent;
      navigator.clipboard.writeText(text).then(() => toast('已复制')).catch(() => fallbackCopy(text));
    };
    meta.appendChild(copyBtn);
    const delBtn = document.createElement('button');
    delBtn.className = 'friend-msg-del'; delBtn.textContent = '×';
    delBtn.onclick = () => deleteFriendMsg(msg.id, row);
    meta.appendChild(delBtn);
  }
  body.appendChild(meta);

  row.appendChild(avatarEl);
  row.appendChild(body);
  area.appendChild(row);
  if (scroll) area.scrollTop = area.scrollHeight;
  return { bubble, row, meta };
}

// ---- Visual Viewport (mobile keyboard) ----

let _friendVVListener = null;
function _attachFriendVV() {
  if (!window.visualViewport) return;
  _friendVVListener = function() {
    const vv = window.visualViewport;
    const overlay = document.getElementById('friendChatOverlay');
    if (!overlay) return;
    overlay.style.top = vv.offsetTop + 'px';
    overlay.style.height = vv.height + 'px';
    overlay.style.bottom = 'auto';
  };
  window.visualViewport.addEventListener('resize', _friendVVListener);
  window.visualViewport.addEventListener('scroll', _friendVVListener);
  _friendVVListener();
}
function _detachFriendVV() {
  if (!_friendVVListener || !window.visualViewport) return;
  window.visualViewport.removeEventListener('resize', _friendVVListener);
  window.visualViewport.removeEventListener('scroll', _friendVVListener);
  _friendVVListener = null;
  const overlay = document.getElementById('friendChatOverlay');
  if (overlay) { overlay.style.top = ''; overlay.style.height = ''; overlay.style.bottom = ''; }
}

// ---- Window-exposed functions ----

window.openFriendModal = function(fid) {
  _editingFriendId = fid || null;
  const f = fid ? _friends.find(x => x.id === fid) : null;
  document.getElementById('friendModalTitle').textContent = f ? '编辑朋友' : '添加朋友';
  document.getElementById('fmName').value = f ? f.name : '';
  document.getElementById('fmApiKey').value = f ? f.apiKey : '';
  document.getElementById('fmBaseUrl').value = f ? f.baseUrl : '';
  document.getElementById('fmModel').value = f ? f.model : '';
  document.getElementById('fmSysPrompt').value = f ? (f.sysPrompt||'') : '';
  document.getElementById('fmMemory').value = f ? (f.memory||'') : '';
  document.getElementById('fmHistoryCount').value = f ? (f.historyCount||20) : 20;
  const psel = document.getElementById('fmPresetSelect');
  psel.innerHTML = '<option value="">— 手动填写 —</option>';
  getApiPresets().forEach((p, i) => {
    const opt = document.createElement('option');
    opt.value = i; opt.textContent = p.name || p.model || ('预设'+(i+1));
    psel.appendChild(opt);
  });
  psel.value = '';
  document.getElementById('fmDelBtn').style.display = f ? '' : 'none';
  const selectedEmoji = f ? (f.emoji||'🤖') : '🤖';
  document.querySelectorAll('.friend-modal-emoji-btn').forEach(btn => {
    btn.classList.toggle('selected', btn.dataset.emoji === selectedEmoji);
  });
  document.getElementById('friendModalOverlay').classList.add('open');
};

window.closeFriendModal = function() {
  document.getElementById('friendModalOverlay').classList.remove('open');
  _editingFriendId = null;
};

window.selectFriendEmoji = function(btn) {
  document.querySelectorAll('.friend-modal-emoji-btn').forEach(b => b.classList.remove('selected'));
  btn.classList.add('selected');
};

window.saveFriend = async function() {
  const name = document.getElementById('fmName').value.trim();
  if (!name) { alert('请填写名字'); return; }
  const apiKey = document.getElementById('fmApiKey').value.trim();
  const baseUrl = document.getElementById('fmBaseUrl').value.trim();
  const model = document.getElementById('fmModel').value.trim();
  const sysPrompt = document.getElementById('fmSysPrompt').value.trim();
  const memory = document.getElementById('fmMemory').value.trim();
  const historyCount = parseInt(document.getElementById('fmHistoryCount').value) || 20;
  const selectedBtn = document.querySelector('.friend-modal-emoji-btn.selected');
  const emoji = selectedBtn ? selectedBtn.dataset.emoji : '🤖';
  const bgColors = {'🤖':'rgba(16,163,127,.15)','🦋':'rgba(156,39,176,.12)','🐳':'rgba(30,136,229,.12)','🐬':'rgba(0,172,193,.12)','🦊':'rgba(230,81,0,.12)','🐼':'rgba(100,100,100,.1)','🌟':'rgba(251,192,45,.12)','🌊':'rgba(41,182,246,.12)','💎':'rgba(0,150,136,.12)','🔮':'rgba(94,53,177,.12)'};
  const bgColor = bgColors[emoji] || 'rgba(128,128,128,.1)';
  const fObj = _editingFriendId
    ? { ...(_friends.find(x=>x.id===_editingFriendId)||{}), name, apiKey, baseUrl, model, sysPrompt, memory, historyCount, emoji, bgColor }
    : { id: 'f_'+Date.now(), name, apiKey, baseUrl, model, sysPrompt, memory, historyCount, emoji, bgColor, createdAt: Date.now() };
  await dbPut('friends', null, fObj);
  await loadFriends();
  renderFriendsList();
  closeFriendModal();
};

window.deleteFriend = async function() {
  if (!_editingFriendId) return;
  if (!confirm('确定删除这个朋友？聊天记录也会一起清掉。')) return;
  await idbDeleteFriendMsgs(_editingFriendId);
  await dbDelete('friends', _editingFriendId);
  await loadFriends();
  renderFriendsList();
  closeFriendModal();
};

window.openFriendChat = async function(fid) {
  const f = _friends.find(x => x.id === fid);
  if (!f) return;
  _currentFriend = f;
  _friendMessages = await idbGetFriendMsgs(fid);
  _friendMessages.sort((a,b) => (a.ts||0)-(b.ts||0));
  document.getElementById('friendChatAvatar').textContent = f.emoji || '🤖';
  document.getElementById('friendChatAvatar').style.background = f.bgColor || 'rgba(128,128,128,.12)';
  document.getElementById('friendChatTitle').textContent = f.name;
  document.getElementById('friendChatOverlay').classList.add('open');
  _attachFriendVV();
  renderFriendChatMessages();
  setTimeout(() => {
    const area = document.getElementById('friendChatArea');
    if (area) area.scrollTop = area.scrollHeight;
  }, 50);
  document.getElementById('friendChatInput').focus();
};

window.closeFriendChat = function() {
  _detachFriendVV();
  document.getElementById('friendChatOverlay').classList.remove('open');
  _currentFriend = null;
  _friendMessages = [];
};

window.clearFriendChat = async function() {
  if (!_currentFriend) return;
  if (!confirm('清空和TA的聊天记录？')) return;
  await idbDeleteFriendMsgs(_currentFriend.id);
  _friendMessages = [];
  renderFriendChatMessages();
};

window.extractFriendMemory = async function() {
  if (!_currentFriend || _friendSending) return;
  if (_friendMessages.length < 2) { toast('聊天记录太少，先多聊几句吧～'); return; }
  const btn = document.getElementById('friendMemoryBtn');
  if (btn) { btn.textContent = '⏳'; btn.disabled = true; }
  try {
    const rawBase = (_currentFriend.baseUrl || 'https://api.openai.com').replace(/\/+$/, '');
    const apiUrl = /\/v\d+$/.test(rawBase) ? rawBase + '/chat/completions' : rawBase + '/v1/chat/completions';
    const model = _currentFriend.model || 'gpt-4o';
    const recent = _friendMessages.slice(-60).map(m => `${m.role === 'user' ? '我' : _currentFriend.name}：${m.content}`).join('\n');
    const existing = (_currentFriend.memory || '').trim();
    const sysMsg = '你是一个记忆整理助手。从对话记录中提取关键信息：对方的性格/习惯/偏好、重要事件、达成的共识等。用简洁的备忘录格式输出，每条一行，以"·"开头。不要废话，不要重复已有记忆里的内容。';
    const userMsg = (existing ? `已有记忆：\n${existing}\n\n` : '') + `最新对话：\n${recent}\n\n请补充/更新记忆：`;
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), 60000);
    const resp = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + _currentFriend.apiKey },
      body: JSON.stringify({ model, messages: [{ role: 'system', content: sysMsg }, { role: 'user', content: userMsg }], temperature: 0.3, stream: false }),
      signal: ctrl.signal
    });
    clearTimeout(tid);
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const data = await resp.json();
    const newMemory = data.choices?.[0]?.message?.content?.trim() || '';
    if (!newMemory) throw new Error('没有返回内容');
    const merged = existing ? existing + '\n' + newMemory : newMemory;
    const updated = { ..._currentFriend, memory: merged };
    await dbPut('friends', null, updated);
    _currentFriend = updated;
    const idx = _friends.findIndex(x => x.id === updated.id);
    if (idx >= 0) _friends[idx] = updated;
    toast('记忆已整理 🧠');
  } catch(e) {
    toast('整理失败：' + (e.message || '未知错误'));
  } finally {
    if (btn) { btn.textContent = '🧠'; btn.disabled = false; }
  }
};

window.deleteFriendMsg = async function(id, rowEl) {
  try {
    await dbDelete('friendMessages', id);
    _friendMessages = _friendMessages.filter(m => m.id !== id);
    rowEl?.remove();
  } catch(e) { toast('删除失败'); }
};

window.sendFriendMessage = async function() {
  if (_friendSending || !_currentFriend) return;
  const input = document.getElementById('friendChatInput');
  const text = input.value.trim();
  if (!text) return;
  if (!_currentFriend.apiKey && !_currentFriend.baseUrl) {
    alert('请先在编辑朋友页填写 API Key 和 Base URL'); return;
  }
  input.value = ''; input.style.height = 'auto';
  const area = document.getElementById('friendChatArea');
  area.querySelector('div[style*="打个招呼"]')?.remove();

  const userRec = { role: 'user', content: text, friendId: _currentFriend.id, ts: Date.now() };
  await idbAddFriendMsg(userRec);
  _friendMessages.push(userRec);
  const { row: userRow } = appendFriendMsgDOM(userRec, true);

  _friendSending = true;
  document.getElementById('friendChatSend').disabled = true;

  const historyCount = _currentFriend.historyCount || 20;
  const ctx = _friendMessages.slice(-historyCount).map(m => ({ role: m.role, content: m.content }));
  const sysPrompt = (_currentFriend.sysPrompt || '').trim();
  const memory = (_currentFriend.memory || '').trim();
  const now = new Date();
  const timeStr = now.toLocaleString('zh-CN', { year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', weekday:'short' });
  const sysParts = ['当前时间：' + timeStr];
  if (sysPrompt) sysParts.push(sysPrompt);
  if (memory) sysParts.push('【记忆】\n' + memory);
  const apiMsgs = [{ role: 'system', content: sysParts.join('\n\n') }, ...ctx];
  const rawBase = (_currentFriend.baseUrl || 'https://api.openai.com').replace(/\/+$/, '');
  const apiUrl = /\/v\d+$/.test(rawBase) ? rawBase + '/chat/completions' : rawBase + '/v1/chat/completions';
  const model = _currentFriend.model || 'gpt-4o';

  const placeholderRec = { role: 'assistant', content: '…', friendId: _currentFriend.id, ts: Date.now()+1 };
  const { bubble, row: aiRow, meta: aiMeta } = appendFriendMsgDOM(placeholderRec, true);

  try {
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), 120000);
    const resp = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + _currentFriend.apiKey },
      body: JSON.stringify({ model, messages: apiMsgs, temperature: 0.8, stream: true }),
      signal: ctrl.signal
    });
    clearTimeout(tid);
    if (!resp.ok) {
      const errText = await resp.text().catch(()=>'');
      throw new Error('HTTP ' + resp.status + ': ' + errText.slice(0,200));
    }
    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    let fullText = '', buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n'); buf = lines.pop();
      for (const line of lines) {
        const t = line.trim();
        if (!t || t === 'data: [DONE]' || !t.startsWith('data: ')) continue;
        try {
          const delta = JSON.parse(t.slice(6)).choices?.[0]?.delta?.content || '';
          if (delta) { fullText += delta; if (bubble) bubble.textContent = fullText; area.scrollTop = area.scrollHeight; }
        } catch(e) {}
      }
    }
    if (!fullText) fullText = '（无回复）';
    if (bubble) bubble.textContent = fullText;
    const aiRec = { role: 'assistant', content: fullText, friendId: _currentFriend.id, ts: Date.now()+2 };
    await idbAddFriendMsg(aiRec);
    _friendMessages.push(aiRec);
    finalizeFriendMsgRow(aiRow, aiMeta, aiRec);
  } catch(e) {
    const errMsg = e.name === 'AbortError' ? '请求超时' : (e.message || '请求失败');
    if (bubble) { bubble.textContent = '❌ ' + errMsg; bubble.style.color = '#e57373'; }
    if (userRec.id) { try { await dbDelete('friendMessages', userRec.id); } catch(e){} }
    _friendMessages.pop();
    userRow?.remove();
  } finally {
    _friendSending = false;
    document.getElementById('friendChatSend').disabled = false;
  }
};

window.applyFriendPreset = function(sel) {
  const idx = parseInt(sel.value);
  if (isNaN(idx)) return;
  const p = getApiPresets()[idx];
  if (!p) return;
  document.getElementById('fmApiKey').value = p.apiKey || '';
  document.getElementById('fmBaseUrl').value = p.baseUrl || '';
  document.getElementById('fmModel').value = p.model || '';
};

// ---- Export for backup ----

export async function getFriendsBackupData() {
  try {
    const friends = await dbGetAll('friends');
    const chats = {};
    for (const f of friends) {
      const msgs = await new Promise((resolve) => {
        try {
          const tx = db.transaction('friendMessages', 'readonly');
          const idx = tx.objectStore('friendMessages').index('byFriend');
          const req = idx.getAll(f.id);
          req.onsuccess = () => resolve(req.result || []);
          req.onerror = () => resolve([]);
        } catch(e) { resolve([]); }
      });
      if (msgs.length) chats[f.id] = msgs;
    }
    return { friends, chats };
  } catch(e) { return { friends: [], chats: {} }; }
}

// ---- Init ----

function _friendInputInit() {
  const inp = document.getElementById('friendChatInput');
  if (inp) {
    inp.addEventListener('input', function() { this.style.height='auto'; this.style.height=Math.min(this.scrollHeight,120)+'px'; });
    inp.addEventListener('keydown', function(e) {
      if (e.isComposing || e.keyCode === 229) return;
      if (isMobile) return;
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendFriendMessage(); }
    });
  }
}

async function friendsInit() {
  const lsFriends = localStorage.getItem('xinye_friends');
  if (lsFriends) {
    try {
      const old = JSON.parse(lsFriends);
      for (const f of old) {
        await dbPut('friends', null, f);
        const oldMsgs = localStorage.getItem('friend_chat_' + f.id);
        if (oldMsgs) {
          const msgs = JSON.parse(oldMsgs);
          for (const m of msgs) {
            await idbAddFriendMsg({ role: m.role, content: m.content, friendId: f.id, ts: m.id || Date.now() });
          }
          localStorage.removeItem('friend_chat_' + f.id);
        }
      }
      localStorage.removeItem('xinye_friends');
    } catch(e) { console.warn('[Friends] 迁移失败', e); }
  }
  await loadFriends();
  renderFriendsList();
}

function waitDbAndInit() {
  if (db !== null) {
    friendsInit().catch(e => console.warn('[Friends] init失败', e));
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', _friendInputInit);
    } else {
      _friendInputInit();
    }
  } else {
    setTimeout(waitDbAndInit, 50);
  }
}
waitDbAndInit();

window._friendsRenderList = async function() { await loadFriends(); renderFriendsList(); };
