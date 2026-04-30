import { toast, fallbackCopy, escHtml, fmtTime, nowStr, $ } from './utils.js';
import { db, dbPut, dbGet, dbDelete, dbGetAllKeys, dbGetBefore } from './db.js';
import { settings, messages, saveSettings } from './state.js';
import { getApiPresets } from './api.js';
import { getMemoryContextBlocks, parseAndSaveSelfMemories, rememberLatestExchange, autoDigestMemory, updateMoodState } from './memory.js';
import { stripForTTS, playTTS, downloadTTS, showVoiceBar, fetchWithTimeout } from './tts.js';

// ======================== DOM 元素 ========================
const chatArea = document.querySelector('#chatArea');
const emptyState = document.querySelector('#emptyState');
const typing = document.querySelector('#typingIndicator');
const userInput = document.querySelector('#userInput');
const btnSend = document.querySelector('#btnSend');
const editOverlay = document.querySelector('#editModalOverlay');
const editTA = document.querySelector('#editTextarea');

// ======================== 常量 ========================
const DEFAULT_AI_AVATAR = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect fill="#ffe0b2" width="100" height="100" rx="50"/><text x="50" y="64" text-anchor="middle" font-size="52">🦊</text></svg>')}`;
const DEFAULT_USER_AVATAR = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect fill="#fce4ec" width="100" height="100" rx="50"/><text x="50" y="64" text-anchor="middle" font-size="52">🦝</text></svg>')}`;

// ======================== 模块状态 ========================
let editingId = -1;
const _tokenLogs = new Map();
const _openPanels = new Set();

// ======================== 收藏 ========================
export function toggleBookmark(msgId) {
  if (!settings.bookmarks) settings.bookmarks = [];
  const idx = settings.bookmarks.findIndex(b => b.msgId === msgId);
  const btn = chatArea.querySelector(`.btn-bookmark[data-id="${msgId}"]`);
  if (idx >= 0) {
    settings.bookmarks.splice(idx, 1);
    if (btn) { btn.classList.remove('active'); btn.title = '收藏'; btn.querySelector('path').setAttribute('opacity', '0.55'); }
    toast('已取消收藏');
  } else {
    const msg = messages.find(m => m.id === msgId);
    if (!msg) return;
    const _bkContent = msg.isGenImage ? _extractGenPrompt(msg.content) : msg.content;
    settings.bookmarks.unshift({ id: Date.now() + Math.random(), msgId, content: _bkContent, time: msg.time, savedAt: Date.now() });
    if (btn) { btn.classList.add('active'); btn.title = '取消收藏'; btn.querySelector('path').setAttribute('opacity', '1'); }
    toast('已收藏 🔖');
  }
  updateBookmarkBadge();
  saveSettings();
}

function _extractGenPrompt(content) {
  if (!content) return '';
  const m1 = content.match(/提示词：([\s\S]+)$/);
  if (m1) return m1[1].trim();
  const m2 = content.match(/描述：([\s\S]+)$/);
  if (m2) return m2[1].trim();
  return content;
}

export function updateBookmarkBadge() {
  const badge = document.getElementById('bookmarkBadge');
  if (!badge) return;
  badge.style.display = (settings.bookmarks||[]).length > 0 ? 'flex' : 'none';
}

let _bmFilterTag = null;

function _createBmVoiceBar(blob) {
  const bar = document.createElement('div');
  bar.className = 'tts-voice-bar bm-voice-bar';
  bar.innerHTML = `<div class="tts-vbar-row"><button class="tts-vbar-play">▶</button><div class="tts-vbar-waves"><span></span><span></span><span></span><span></span><span></span></div><span class="tts-vbar-dur">…</span></div><div class="tts-vbar-progress"><div class="tts-vbar-progress-fill"></div></div>`;
  const playBtn = bar.querySelector('.tts-vbar-play');
  const fill    = bar.querySelector('.tts-vbar-progress-fill');
  const durEl   = bar.querySelector('.tts-vbar-dur');
  const audio   = new Audio(URL.createObjectURL(blob));
  audio.addEventListener('loadedmetadata', () => {
    durEl.textContent = isFinite(audio.duration) ? `${Math.round(audio.duration)}″` : '?″';
  });
  audio.addEventListener('timeupdate', () => {
    if (audio.duration) fill.style.width = `${(audio.currentTime / audio.duration * 100).toFixed(1)}%`;
  });
  audio.addEventListener('ended', () => {
    bar.classList.remove('playing'); playBtn.textContent = '▶'; fill.style.width = '0%';
  });
  playBtn.addEventListener('click', e => {
    e.stopPropagation();
    if (audio.paused) { audio.play(); bar.classList.add('playing'); playBtn.textContent = '⏸'; }
    else              { audio.pause(); bar.classList.remove('playing'); playBtn.textContent = '▶'; }
  });
  return bar;
}

export function openBookmarksPanel() {
  const ov = document.getElementById('bookmarksPanelOverlay');
  if (ov) { ov.style.display = 'flex'; renderBookmarksPanel(); }
}

export function renderBookmarksPanel() {
  const listEl   = document.getElementById('bookmarksList');
  const filterEl = document.getElementById('bookmarksTagFilter');
  if (!listEl) return;
  const bms    = settings.bookmarks || [];
  const aiName = settings.aiName || '炘也';
  const avatarSrc = window._xinyeAvatarSrc || DEFAULT_AI_AVATAR;

  // tag 筛选条
  if (filterEl) {
    const allTags = [...new Set(bms.flatMap(b => b.tags || []))];
    filterEl.innerHTML = allTags.length
      ? [null, ...allTags].map(t => {
          const active = _bmFilterTag === t;
          const label  = t === null ? '全部' : escHtml(t);
          return `<button class="bm-filter-pill${active ? ' active' : ''}" data-tag="${t === null ? '' : escHtml(t)}" onclick="window.setBmFilterTag(this.dataset.tag||null)">${label}</button>`;
        }).join('')
      : '';
  }

  const filtered = _bmFilterTag ? bms.filter(b => (b.tags || []).includes(_bmFilterTag)) : bms;

  if (!filtered.length) {
    listEl.innerHTML = '<div style="color:var(--text-light);font-size:13px;text-align:center;padding:60px 0;line-height:2">还没有收藏<br><span style="font-size:12px;opacity:.7">点消息下方的书签按钮就能收藏</span></div>';
    return;
  }

  listEl.innerHTML = filtered.map(b => {
    const saved   = new Date(b.savedAt).toLocaleString('zh-CN', { month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' });
    const msgTime = b.time ? fmtTime(b.time) : '';
    const tagsHtml = (b.tags || []).map(t =>
      `<span class="bm-tag">${escHtml(t)}<button class="bm-tag-rm" data-bmid="${b.id}" data-tag="${escHtml(t)}" onclick="window.removeBmTag(+this.dataset.bmid,this.dataset.tag)">×</button></span>`
    ).join('');
    return `<div style="display:flex;gap:10px;padding:12px 14px;border-radius:14px;background:var(--ai-bubble);border:1px solid var(--ai-bubble-border);box-shadow:0 1px 6px rgba(0,0,0,.06)">
      <div class="bm-card-avatar"></div>
      <div style="flex:1;min-width:0">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:5px">
          <span style="font-size:12px;font-weight:700;color:var(--pink-deep)">${escHtml(aiName)}</span>
          <button onclick="removeBookmark(${b.id})" title="取消收藏" class="bm-card-rm">✕</button>
        </div>
        <div id="bmv-${b.id}"></div>
        <div class="bm-card-body" id="bmc-${b.id}"></div>
        <button class="bm-expand-btn" id="bmx-${b.id}" onclick="toggleBmExpand(${b.id})">展开 ▾</button>
        <div class="bm-tags" id="bmt-${b.id}">
          ${tagsHtml}
          <button class="bm-tag-add" onclick="window.addBmTag(${b.id})">+ tag</button>
        </div>
        <div class="bm-card-footer">
          ${msgTime ? `<span>💬 ${msgTime}</span>` : ''}
          <span>🔖 ${saved}</span>
          <button class="bm-copy-btn" onclick="window.copyBmContent(${b.id})">复制</button>
        </div>
      </div>
    </div>`;
  }).join('');

  requestAnimationFrame(() => {
    listEl.querySelectorAll('.bm-card-avatar').forEach(el => {
      el.style.backgroundImage = `url("${avatarSrc}")`;
      el.style.backgroundSize = 'cover'; el.style.backgroundPosition = 'center';
    });
    filtered.forEach(b => {
      const body = document.getElementById(`bmc-${b.id}`);
      const btn  = document.getElementById(`bmx-${b.id}`);
      if (body) {
        try { linkifyEl(body, b.content || ''); window.applyStickerTags?.(body); } catch(_) { body.textContent = b.content || ''; }
      }
      if (body && btn && body.scrollHeight > body.clientHeight + 2) btn.classList.add('visible');
      if (b.msgId) {
        dbGet('ttsCache', b.msgId).then(blob => {
          if (!blob) return;
          const vEl = document.getElementById(`bmv-${b.id}`);
          if (vEl) vEl.appendChild(_createBmVoiceBar(blob));
        }).catch(() => {});
      }
    });
  });
}

window.setBmFilterTag = function(tag) {
  _bmFilterTag = (_bmFilterTag === tag) ? null : tag;
  renderBookmarksPanel();
};

window.addBmTag = function(bmId) {
  const el = document.getElementById(`bmt-${bmId}`);
  if (!el || el.querySelector('.bm-tag-input')) return;
  const inp = document.createElement('input');
  inp.className = 'bm-tag-input'; inp.placeholder = '输入tag…'; inp.maxLength = 20;
  const confirm = () => {
    const tag = inp.value.trim();
    if (tag) {
      const bm = (settings.bookmarks || []).find(b => b.id === bmId);
      if (bm) { if (!bm.tags) bm.tags = []; if (!bm.tags.includes(tag)) { bm.tags.push(tag); saveSettings(); } }
    }
    renderBookmarksPanel();
  };
  inp.addEventListener('keydown', e => { if (e.key === 'Enter') confirm(); if (e.key === 'Escape') renderBookmarksPanel(); });
  inp.addEventListener('blur', confirm);
  el.insertBefore(inp, el.querySelector('.bm-tag-add'));
  inp.focus();
};

window.removeBmTag = function(bmId, tag) {
  const bm = (settings.bookmarks || []).find(b => b.id === bmId);
  if (bm && bm.tags) { bm.tags = bm.tags.filter(t => t !== tag); saveSettings(); renderBookmarksPanel(); }
};

window.copyBmContent = function(bmId) {
  const bm = (settings.bookmarks || []).find(b => b.id === bmId);
  if (!bm) return;
  navigator.clipboard.writeText(bm.content || '').then(() => toast('已复制 ✓')).catch(() => toast('复制失败'));
};

export function toggleBmExpand(id) {
  const body = document.getElementById(`bmc-${id}`);
  const btn  = document.getElementById(`bmx-${id}`);
  if (!body || !btn) return;
  const expanding = !body.classList.contains('expanded');
  body.classList.toggle('expanded', expanding);
  btn.textContent = expanding ? '收起 ▴' : '展开 ▾';
}

export function removeBookmark(id) {
  if (!settings.bookmarks) return;
  const bm = settings.bookmarks.find(b => b.id === id);
  settings.bookmarks = settings.bookmarks.filter(b => b.id !== id);
  if (bm) {
    const btn = chatArea.querySelector(`.btn-bookmark[data-id="${bm.msgId}"]`);
    if (btn) { btn.classList.remove('active'); btn.title = '收藏'; btn.querySelector('path').setAttribute('opacity', '0.55'); }
  }
  updateBookmarkBadge();
  saveSettings();
  renderBookmarksPanel();
}

// ======================== 头像 ========================
export async function getAiAvatar()   { return (await dbGet('images','aiAvatar'))   || DEFAULT_AI_AVATAR; }
export async function getUserAvatar() { return (await dbGet('images','userAvatar')) || DEFAULT_USER_AVATAR; }

// ======================== 消息存储 ========================
export function activeStore() { return window._rpActive ? 'rpMessages' : 'messages'; }

export async function addMessage(role, content, images) {
  const msg = { role, content, time: Date.now() };
  if (images && images.length) msg.images = images;
  const storeName = activeStore();
  const tx = db.transaction(storeName, 'readwrite');
  const store = tx.objectStore(storeName);
  return new Promise((resolve) => {
    const req = store.add(msg);
    req.onsuccess = () => { msg.id = req.result; messages.push(msg); window.scheduleAutoSave?.(); resolve(msg); };
  });
}

export async function updateMessage(id, content) {
  const idx = messages.findIndex(m => m.id === id);
  if (idx < 0) return;
  messages[idx].content = content;
  await dbPut(activeStore(), null, messages[idx]);
  window.scheduleAutoSave?.();
}

// ======================== 渲染 ========================
export async function renderMessages() {
  _openPanels.clear();
  chatArea.querySelectorAll('.msg-row').forEach(el => el.remove());
  emptyState.style.display = messages.length === 0 ? 'flex' : 'none';
  const aiAv = await (typeof window.getEffectiveAiAvatar === 'function' ? window.getEffectiveAiAvatar() : getAiAvatar());
  window._xinyeAvatarSrc = aiAv;
  const usAv = await (typeof window.getEffectiveUserAvatar === 'function' ? window.getEffectiveUserAvatar() : getUserAvatar());
  const limit = settings.displayLimit || 0;
  const displayMsgs = limit > 0 ? messages.slice(-limit) : messages;
  for (const msg of displayMsgs) {
    const row = document.createElement('div');
    const isUser = msg.role === 'user';
    row.className = `msg-row ${isUser ? 'user' : 'ai'}`;
    const allImgs = msg.images || (msg.image ? [msg.image] : []);
    const imgHtml = allImgs.map(s => `<img class="bubble-img" src="${escHtml(s)}" alt="图片">`).join('');
    const copyBtn = `<button class="btn-copy" data-id="${msg.id}" title="复制"><svg width="13" height="13" viewBox="0 0 24 24" fill="none"><rect x="9" y="9" width="13" height="13" rx="2" fill="currentColor" opacity="0.2" stroke="currentColor" stroke-width="1.8"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg></button>`;
    const tokenLogBtn = isUser ? '' : `<button class="btn-token-log" data-id="${msg.id}" title="查看请求详情"><svg width="13" height="13" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" fill="currentColor" opacity="0.15" stroke="currentColor" stroke-width="1.5"/><circle cx="9" cy="10" r="1.5" fill="currentColor"/><circle cx="15" cy="10" r="1.5" fill="currentColor"/><path d="M8.5 15c1 1.5 6 1.5 7 0" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg></button>`;
    const _isBookmarked = (settings.bookmarks||[]).some(b => b.msgId === msg.id);
    const bookmarkBtn = (isUser || msg.isGenImage) ? '' : `<button class="btn-bookmark${_isBookmarked?' active':''}" data-id="${msg.id}" title="${_isBookmarked?'取消收藏':'收藏'}"><svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M17 3H7a2 2 0 00-2 2v16l7-3 7 3V5a2 2 0 00-2-2z" fill="currentColor" opacity="${_isBookmarked?'1':'0.55'}" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg></button>`;
    const ttsBtn = isUser ? copyBtn : `${copyBtn} <button class="btn-tts" data-id="${msg.id}" title="播放语音"><svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M11 5L6 9H3a1 1 0 00-1 1v4a1 1 0 001 1h3l5 4V5z" fill="currentColor" opacity="0.3" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M15.5 8.5a5 5 0 010 7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M18.5 6a9 9 0 010 12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></button><button class="btn-tts-dl" data-id="${msg.id}" title="下载语音"><svg width="13" height="13" viewBox="0 0 24 24" fill="none"><path d="M12 3v13M7 12l5 5 5-5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M4 19h16" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg></button>`;
    const _stickerName = isUser ? window.detectStickerMsg?.(msg.content) : null;
    const _bubbleCls = _stickerName ? 'msg-bubble bubble-sticker' : 'msg-bubble';
    let _bubbleInner;
    if (_stickerName) {
      _bubbleInner = window.renderStickerHTML?.(_stickerName) || escHtml(msg.content);
    } else if (!isUser && msg.isGenImage && msg.genImageData) {
      const _gp = _extractGenPrompt(msg.content);
      const _gpBm = `<button class="btn-bookmark${_isBookmarked?' active':''}" data-id="${msg.id}" title="${_isBookmarked?'取消收藏':'收藏'}"><svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M17 3H7a2 2 0 00-2 2v16l7-3 7 3V5a2 2 0 00-2-2z" fill="currentColor" opacity="${_isBookmarked?'1':'0.55'}" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg></button>`;
      _bubbleInner = `<img class="gen-img" src="${escHtml(msg.genImageData)}" alt="炘也画的图" data-src="${escHtml(msg.genImageData)}"><button class="btn-gen-img-dl" data-id="${msg.id}">⬇ 保存图片</button><div class="gen-prompt-wrap"><div class="gen-prompt-header"><button class="btn-gen-prompt-toggle" onclick="const w=this.closest('.gen-prompt-wrap');w.classList.toggle('open');this.textContent=w.classList.contains('open')?'prompt ▴':'prompt ▾'">prompt ▾</button>${_gpBm}</div><div class="gen-prompt-body">${escHtml(_gp)}</div></div>`;
    } else {
      _bubbleInner = (isUser ? escHtml(msg.content) : '') + imgHtml;
    }
    row.innerHTML = `
      <img class="msg-avatar" src="${escHtml(isUser ? usAv : aiAv)}" alt="">
      <div class="msg-content">
        <div class="${_bubbleCls}">${_bubbleInner}</div>
        <button class="msg-del-btn" data-id="${msg.id}" title="删除"><svg width="13" height="13" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" fill="currentColor" opacity="0.15" stroke="currentColor" stroke-width="1.5"/><path d="M15 9l-6 6M9 9l6 6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg></button>
        <button class="msg-edit-btn" data-id="${msg.id}" title="编辑此消息"><svg width="13" height="13" viewBox="0 0 24 24" fill="none"><path d="M16 3a2.83 2.83 0 114 4L8 19l-5 1 1-5L16 3z" fill="currentColor" opacity="0.2" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg></button>
        <div class="msg-time">${fmtTime(msg.time)}${ttsBtn}${tokenLogBtn}${bookmarkBtn}</div>
        <div class="token-log-panel" data-id="${msg.id}" style="display:none"></div>
      </div>`;
    if (!isUser && msg.content && !msg.isGenImage) { linkifyEl(row.querySelector('.msg-bubble'), msg.content); window.applyStickerTags?.(row.querySelector('.msg-bubble')); }
    chatArea.appendChild(row);
  }
  try {
    const cachedKeys = new Set(await dbGetAllKeys('ttsCache'));
    if (cachedKeys.size > 0) {
      chatArea.querySelectorAll('.btn-tts,.btn-tts-dl').forEach(btn => {
        if (cachedKeys.has(Number(btn.dataset.id))) btn.classList.add('cached');
      });
    }
    const speakIds = new Set(settings.speakTTSIds || []);
    const speakMsgs = messages.filter(m => speakIds.has(m.id) && m.role === 'assistant');
    for (const msg of speakMsgs) {
      const blob = await dbGet('ttsCache', msg.id);
      if (blob) showVoiceBar(msg.id, blob);
    }
  } catch(_){}
  scrollBottom();
}

export async function appendMsgDOM(msg) {
  emptyState.style.display = 'none';
  const isUser = msg.role === 'user';
  const av = isUser
    ? await (typeof window.getEffectiveUserAvatar === 'function' ? window.getEffectiveUserAvatar() : getUserAvatar())
    : await (typeof window.getEffectiveAiAvatar === 'function' ? window.getEffectiveAiAvatar() : getAiAvatar());
  const row = document.createElement('div');
  row.className = `msg-row ${isUser ? 'user' : 'ai'}`;
  const allImgs = msg.images || (msg.image ? [msg.image] : []);
  const imgHtml = allImgs.map(s => `<img class="bubble-img" src="${escHtml(s)}" alt="图片">`).join('');
  const copyBtn2 = `<button class="btn-copy" data-id="${msg.id}" title="复制"><svg width="13" height="13" viewBox="0 0 24 24" fill="none"><rect x="9" y="9" width="13" height="13" rx="2" fill="currentColor" opacity="0.2" stroke="currentColor" stroke-width="1.8"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg></button>`;
  const tokenLogBtn = isUser ? '' : `<button class="btn-token-log" data-id="${msg.id}" title="查看请求详情"><svg width="13" height="13" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" fill="currentColor" opacity="0.15" stroke="currentColor" stroke-width="1.5"/><circle cx="9" cy="10" r="1.5" fill="currentColor"/><circle cx="15" cy="10" r="1.5" fill="currentColor"/><path d="M8.5 15c1 1.5 6 1.5 7 0" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg></button>`;
  const _isBookmarked2 = (settings.bookmarks||[]).some(b => b.msgId === msg.id);
  const bookmarkBtn2 = (isUser || msg.isGenImage) ? '' : `<button class="btn-bookmark${_isBookmarked2?' active':''}" data-id="${msg.id}" title="${_isBookmarked2?'取消收藏':'收藏'}"><svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M17 3H7a2 2 0 00-2 2v16l7-3 7 3V5a2 2 0 00-2-2z" fill="currentColor" opacity="${_isBookmarked2?'1':'0.55'}" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg></button>`;
  const ttsBtn = isUser ? copyBtn2 : `${copyBtn2} <button class="btn-tts" data-id="${msg.id}" title="播放语音"><svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M11 5L6 9H3a1 1 0 00-1 1v4a1 1 0 001 1h3l5 4V5z" fill="currentColor" opacity="0.3" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M15.5 8.5a5 5 0 010 7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M18.5 6a9 9 0 010 12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></button><button class="btn-tts-dl" data-id="${msg.id}" title="下载语音"><svg width="13" height="13" viewBox="0 0 24 24" fill="none"><path d="M12 3v13M7 12l5 5 5-5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M4 19h16" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg></button>`;
  const _sn = isUser ? window.detectStickerMsg?.(msg.content) : null;
  const _bc = _sn ? 'msg-bubble bubble-sticker' : 'msg-bubble';
  let _bi;
  if (_sn) {
    _bi = window.renderStickerHTML?.(_sn) || escHtml(msg.content);
  } else if (!isUser && msg.isGenImage && msg.genImageData) {
    const _gp2 = _extractGenPrompt(msg.content);
    const _gpBm2 = `<button class="btn-bookmark${_isBookmarked2?' active':''}" data-id="${msg.id}" title="${_isBookmarked2?'取消收藏':'收藏'}"><svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M17 3H7a2 2 0 00-2 2v16l7-3 7 3V5a2 2 0 00-2-2z" fill="currentColor" opacity="${_isBookmarked2?'1':'0.55'}" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg></button>`;
    _bi = `<img class="gen-img" src="${escHtml(msg.genImageData)}" alt="炘也画的图" data-src="${escHtml(msg.genImageData)}"><button class="btn-gen-img-dl" data-id="${msg.id}">⬇ 保存图片</button><div class="gen-prompt-wrap"><div class="gen-prompt-header"><button class="btn-gen-prompt-toggle" onclick="const w=this.closest('.gen-prompt-wrap');w.classList.toggle('open');this.textContent=w.classList.contains('open')?'prompt ▴':'prompt ▾'">prompt ▾</button>${_gpBm2}</div><div class="gen-prompt-body">${escHtml(_gp2)}</div></div>`;
  } else {
    _bi = (isUser ? escHtml(msg.content) : '') + imgHtml;
  }
  row.innerHTML = `
    <img class="msg-avatar" src="${escHtml(av)}" alt="">
    <div class="msg-content">
      <div class="${_bc}">${_bi}</div>
      <button class="msg-del-btn" data-id="${msg.id}" title="删除"><svg width="13" height="13" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" fill="currentColor" opacity="0.15" stroke="currentColor" stroke-width="1.5"/><path d="M15 9l-6 6M9 9l6 6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg></button>
      <button class="msg-edit-btn" data-id="${msg.id}" title="编辑此消息"><svg width="13" height="13" viewBox="0 0 24 24" fill="none"><path d="M16 3a2.83 2.83 0 114 4L8 19l-5 1 1-5L16 3z" fill="currentColor" opacity="0.2" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg></button>
      <div class="msg-time">${fmtTime(msg.time)}${ttsBtn}${tokenLogBtn}${bookmarkBtn2}</div>
      <div class="token-log-panel" data-id="${msg.id}" style="display:none"></div>
    </div>`;
  if (!isUser && msg.content && !msg.isGenImage) { linkifyEl(row.querySelector('.msg-bubble'), msg.content); window.applyStickerTags?.(row.querySelector('.msg-bubble')); }
  chatArea.appendChild(row);
  scrollBottom();
  window.updateHeaderStatus?.();
}

export function scrollBottom() {
  requestAnimationFrame(() => chatArea.scrollTop = chatArea.scrollHeight);
}

// ======================== 删除消息 & 编辑 & 点击 ========================
export async function deleteMessage(id) {
  await dbDelete(activeStore(), id);
  { const _f = messages.filter(m => m.id !== id); messages.length = 0; messages.push(..._f); }
  chatArea.querySelector(`.msg-del-btn[data-id="${id}"]`)?.closest('.msg-row')?.remove();
  window.scheduleAutoSave?.();
}

// ======================== 滚动到顶加载更早消息 ========================
let _loadingOlder = false;
let _noMoreOlder = false;
let _olderCooldownUntil = 0;
export function resetOlderState() { _noMoreOlder = false; _loadingOlder = false; _olderCooldownUntil = 0; }
chatArea.addEventListener('scroll', async () => {
  if (chatArea.scrollTop > 60 || _loadingOlder || _noMoreOlder || !messages.length) return;
  if (Date.now() < _olderCooldownUntil) return;
  const minId = messages[0]?.id;
  if (!minId) return;
  _loadingOlder = true;
  const older = await dbGetBefore(activeStore(), minId, 50);
  if (older.length) {
    if (older.length < 50) _noMoreOlder = true;
    messages.unshift(...older);
    const savedHeight = chatArea.scrollHeight;
    await renderMessages();
    // 双重rAF：等renderMessages内的scrollBottom rAF先跑完，再恢复位置
    requestAnimationFrame(() => requestAnimationFrame(() => {
      chatArea.scrollTop = Math.max(0, chatArea.scrollHeight - savedHeight);
      _olderCooldownUntil = Date.now() + 1500; // 加载完冷却1.5秒，防止立即重触发
      _loadingOlder = false;
    }));
  } else {
    _noMoreOlder = true;
    _loadingOlder = false;
  }
});

chatArea.addEventListener('click', e => {
  if (e.target.matches('.gen-img, .bubble-img')) {
    const src = e.target.dataset.src || e.target.src;
    if (src) {
      $('#imgLightboxImg').src = src;
      $('#imgLightbox').classList.add('show');
      return;
    }
  }
  const genImgDlBtn = e.target.closest('.btn-gen-img-dl');
  if (genImgDlBtn) {
    const id = Number(genImgDlBtn.dataset.id);
    const msg = messages.find(m => m.id === id);
    if (msg && msg.genImageData) {
      const a = document.createElement('a');
      a.href = msg.genImageData;
      a.download = `炘也画的图_${id}.png`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
    }
    return;
  }
  const bookmarkBtn = e.target.closest('.btn-bookmark');
  if (bookmarkBtn) { toggleBookmark(Number(bookmarkBtn.dataset.id)); return; }
  const closeBtn = e.target.closest('.token-log-close');
  if (closeBtn) {
    const panel = closeBtn.closest('.token-log-panel');
    if (panel) { _openPanels.delete(panel.dataset.id); panel.dataset.open = ''; panel.style.display = 'none'; }
    return;
  }
  const tokenLogBtn2 = e.target.closest('.btn-token-log');
  if (tokenLogBtn2) {
    renderTokenLog(tokenLogBtn2.dataset.id);
    return;
  }
  const delBtn = e.target.closest('.msg-del-btn');
  if (delBtn) {
    const id = Number(delBtn.dataset.id);
    if (confirm('删除这条消息？')) deleteMessage(id);
    return;
  }
  const copyBtn = e.target.closest('.btn-copy');
  if (copyBtn) {
    const id = Number(copyBtn.dataset.id);
    const msg = messages.find(m => m.id === id);
    if (msg) {
      const text = msg.content;
      if (navigator.clipboard) {
        navigator.clipboard.writeText(text).then(() => toast('已复制')).catch(() => fallbackCopy(text));
      } else { fallbackCopy(text); }
    }
    return;
  }
  const dlBtn = e.target.closest('.btn-tts-dl');
  if (dlBtn) {
    const id = Number(dlBtn.dataset.id);
    const msg = messages.find(m => m.id === id);
    if (msg) downloadTTS(stripForTTS(msg.content), id);
    return;
  }
  const ttsBtn = e.target.closest('.btn-tts');
  if (ttsBtn) {
    const id = Number(ttsBtn.dataset.id);
    const msg = messages.find(m => m.id === id);
    if (msg && msg.content) playTTS(msg.content, ttsBtn, id);
    return;
  }
  const editBtn = e.target.closest('.msg-edit-btn');
  if (editBtn) {
    editingId = Number(editBtn.dataset.id);
    const msg = messages.find(m => m.id === editingId);
    if (!msg) return;
    editTA.value = msg.content;
    editOverlay.classList.add('show');
    editTA.focus();
    return;
  }
  const bubble = e.target.closest('.msg-bubble');
  if (bubble) {
    const content = bubble.closest('.msg-content');
    const isShow = content.classList.contains('btns-show');
    chatArea.querySelectorAll('.msg-content.btns-show').forEach(el => el.classList.remove('btns-show'));
    if (!isShow) content.classList.add('btns-show');
    return;
  }
  chatArea.querySelectorAll('.msg-content.btns-show').forEach(el => el.classList.remove('btns-show'));
});

$('#btnCloseEdit').onclick = () => editOverlay.classList.remove('show');
$('#btnCancelEdit').onclick = () => editOverlay.classList.remove('show');
$('#btnConfirmEdit').onclick = async () => {
  await updateMessage(editingId, editTA.value);
  await renderMessages();
  editOverlay.classList.remove('show');
  toast('消息已修改');
};

// ======================== Markdown + 链接渲染 ========================
if (typeof marked !== 'undefined') {
  marked.setOptions({ breaks: true, gfm: true });
}

export function renderMdHtml(text) {
  if (typeof marked !== 'undefined' && typeof DOMPurify !== 'undefined') {
    const html = marked.parse(text);
    return DOMPurify.sanitize(html, {
      ALLOWED_TAGS: ['p','br','strong','em','b','i','u','s','del','code','pre',
                     'h1','h2','h3','h4','h5','h6','ul','ol','li','blockquote',
                     'a','img','table','thead','tbody','tr','th','td','hr','span','div'],
      ALLOWED_ATTR: ['href','target','rel','src','alt','style','class'],
      ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i,
      FORBID_TAGS: ['script','iframe','object','embed','form'],
    });
  }
  const esc = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  return text
    .replace(/```([\s\S]*?)```/g, (_, c) => `<pre style="background:rgba(0,0,0,.08);border-radius:6px;padding:8px 12px;font-size:13px;white-space:pre-wrap;margin:4px 0"><code>${esc(c.trim())}</code></pre>`)
    .replace(/`([^`\n]+)`/g, (_, c) => `<code style="background:rgba(0,0,0,.08);border-radius:4px;padding:1px 5px;font-size:13px">${esc(c)}</code>`)
    .replace(/\*\*([^*\n]+)\*\*/g, (_, c) => `<strong>${esc(c)}</strong>`)
    .replace(/\*([^*\n]+)\*/g, (_, c) => `<em>${esc(c)}</em>`)
    .replace(/https?:\/\/[^\s<>"'　-〿！-￯]+/g, url => {
      const clean = url.replace(/[.,;!?)\]]+$/, '');
      return `<a href="${esc(clean)}" target="_blank" rel="noopener noreferrer" style="color:#d4956a;text-decoration:underline;word-break:break-all">${esc(clean)}</a>`;
    });
}

export function linkifyEl(el, text) {
  const thinkRegex = /(?:<thinking>|<think>|〈thinking〉|《thinking》)([\s\S]*?)(?:<\/thinking>|<\/think>|〈\/thinking〉|《\/thinking》)/gi;
  let thinkHtml = '';
  let match;
  while ((match = thinkRegex.exec(text)) !== null) {
    const body = match[1].trim();
    if (body) {
      const esc = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
      thinkHtml += `<div class="thinking-block" onclick="this.classList.toggle('open')"><div class="thinking-header">💭 思考过程</div><div class="thinking-body">${esc(body)}</div></div>`;
    }
  }
  const cleaned = text
    .replace(/(?:<thinking>|<think>|〈thinking〉|《thinking》)[\s\S]*?(?:<\/thinking>|<\/think>|〈\/thinking〉|《\/thinking》)/gi, '')
    .replace(/[＜〈《<]#[\d.]+#[＞〉》>]/g, '')
    .replace(/\((sighs|laughs|chuckle|coughs|clear-throat|groans|breath|pant|inhale|exhale|gasps|sniffs|snorts|burps|lip-smacking|humming|hissing|emm|sneezes)\)/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  el.innerHTML = thinkHtml + (cleaned ? renderMdHtml(cleaned) : '');
  if (typeof renderMathInElement !== 'undefined') {
    try {
      renderMathInElement(el, {
        delimiters: [
          { left: '$$', right: '$$', display: true },
          { left: '$', right: '$', display: false },
        ],
        throwOnError: false,
      });
    } catch(_) {}
  }
}

// ======================== Token 日志 ========================
export function saveTokenLog(msgId, requestMsgs, reply, usage, msgsMeta, model) {
  _tokenLogs.set(String(msgId), { requestMsgs, reply, usage, msgsMeta: msgsMeta || [], model: model || '' });
}

export function renderTokenLog(msgId) {
  const id = String(msgId);
  const panel = document.querySelector(`.token-log-panel[data-id="${msgId}"]`);
  if (!panel) return;
  if (panel.dataset.open === '1') {
    _openPanels.delete(id);
    panel.dataset.open = '';
    panel.style.display = 'none';
    return;
  }
  const log = _tokenLogs.get(id);
  if (!log) {
    panel.innerHTML = '<div style="padding:4px 0;color:var(--text-light)">暂无日志（仅本次启动后发送的消息有记录）</div><button class="token-log-close">▲ 收起</button>';
    _openPanels.add(id);
    panel.dataset.open = '1';
    panel.style.display = 'block';
    return;
  }
  const { requestMsgs, reply, usage, msgsMeta, model } = log;
  const inputTok   = usage.prompt_tokens            ?? '—';
  const outputTok  = usage.completion_tokens        ?? '—';
  const totalTok   = usage.total_tokens             ?? '—';
  const cacheRead  = usage.prompt_cache_hit_tokens  ?? usage.cache_read_input_tokens  ?? null;
  const cacheWrite = usage.prompt_cache_miss_tokens ?? usage.cache_creation_input_tokens ?? null;
  const isStream   = inputTok === '—';
  const reqFormatted = requestMsgs.map((m, i) => {
    const meta = msgsMeta && msgsMeta[i];
    const label = meta ? meta.label : (m.role === 'user' ? '涂涂' : m.role === 'assistant' ? '炘也' : 'system');
    const timeStr = meta && meta.time ? `  [${fmtTime(meta.time)}]` : '';
    const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content, null, 2);
    return `── [${i + 1}] ${label}${timeStr} ──\n${content}`;
  }).join('\n\n');
  const reqChars   = JSON.stringify(requestMsgs).length;
  const replyChars = reply.length;
  const cacheHtml = (cacheRead !== null || cacheWrite !== null) ? `<br>
    缓存读取 ${cacheRead ?? '—'} &nbsp;·&nbsp; 缓存写入 ${cacheWrite ?? '—'}
    <span style="opacity:.5;font-size:10px">（cache_read / cache_write）</span>` : '';
  const modelHtml = model ? `<br><span style="opacity:.6;font-size:10px">🧠 模型：${escHtml(model)}</span>` : '';
  panel.innerHTML = `
    <div class="token-log-section">
      <b>📊 Token 用量</b><br>
      输入 ${inputTok} &nbsp;+&nbsp; 输出 ${outputTok} &nbsp;=&nbsp; 合计 ${totalTok}
      ${cacheHtml}
      ${modelHtml}
      ${isStream ? '<br><span style="opacity:.55;font-size:10px">（流式模式：Token 数需 API 支持才会返回）</span>' : ''}
    </div>
    <div class="token-log-section">
      <b>📤 发出去的完整请求</b>
      <span style="opacity:.6">（${requestMsgs.length} 条 · 约 ${reqChars} 字符）</span>
      <pre>${escHtml(reqFormatted)}</pre>
    </div>
    <div class="token-log-section">
      <b>📥 收到的完整回复</b>
      <span style="opacity:.6">（约 ${replyChars} 字符）</span>
      <pre>${escHtml(reply)}</pre>
    </div>
    <button class="token-log-close">▲ 收起</button>
  `;
  _openPanels.add(id);
  panel.dataset.open = '1';
  panel.style.display = 'block';
}

// ======================== 发消息 ========================
export async function sendMessage() {
  const text = userInput.value.trim();
  const imgs = [...(window.pendingImages || [])];
  if ((!text && !imgs.length) || window.isRequesting) return;
  if (!settings.apiKey) { toast('请先在设置中填写 API Key'); return; }

  userInput.value = '';
  window.autoResize?.();
  window.pendingImages = [];
  $('#imgPreview')?.classList.remove('show');

  window.resetIdleTimer?.();
  const userMsg = await addMessage('user', text, imgs.length ? imgs : null);
  await appendMsgDOM(userMsg);

  if (imgs.length && settings.visionApiKey) {
    try {
      const descs = await window.describeImagesWithVision(imgs);
      const hasDesc = descs && descs.some(d => d !== null);
      if (hasDesc) {
        userMsg.imageDescs = descs;
        const idx = messages.findIndex(m => m.id === userMsg.id);
        if (idx >= 0) messages[idx].imageDescs = descs;
        await dbPut(activeStore(), null, userMsg);
      } else {
        toast('⚠️ 识图模型空回，直接发原图给炘也');
      }
    } catch (e) { toast('⚠️ 识图失败，直接发原图给炘也'); }
  }

  window.isRequesting = true;
  btnSend.disabled = true;
  typing.classList.add('show');
  scrollBottom();

  try {
    const apiMsgs = [];
    const _apiMeta = [];
    const _rpInject = typeof window.getRpInjection === 'function' ? window.getRpInjection() : null;
    if (_rpInject) {
      apiMsgs.push({ role: 'system', content: [{ type: 'text', text: _rpInject, cache_control: { type: 'ephemeral' } }] });
      _apiMeta.push({ label: 'system · 🎭RP场景 🔒缓存' });
    } else {
      const _staticParts = await getMemoryContextBlocks();
      if (settings.systemPrompt.trim()) {
        _staticParts.push(settings.systemPrompt.trim());
      }
      if (_staticParts.length > 0) {
        apiMsgs.push({ role: 'system', content: [{ type: 'text', text: _staticParts.join('\n\n---\n\n'), cache_control: { type: 'ephemeral' } }] });
        _apiMeta.push({ label: 'system · 记忆档案+设定 🔒缓存' });
      }
    }
    if (_rpInject) {
      const _rpUserName = typeof window.getRpUserName === 'function' ? window.getRpUserName() : '';
      if (_rpUserName) {
        apiMsgs.push({ role: 'system', content: `【我的角色名】${_rpUserName}` });
        _apiMeta.push({ label: 'system · 🎭我的角色名' });
      }
      localStorage.removeItem('xinye_kiss_hint');
    } else {
      apiMsgs.push({ role: 'system', content: window.getStickerHint?.() || '' });
      _apiMeta.push({ label: 'system · 贴纸列表' });
      if (settings.shortReply) {
        apiMsgs.push({ role: 'system', content: '【重要】用简短自然的方式回复，通常1-2句话，像日常聊天，不写长段。' });
        _apiMeta.push({ label: 'system · 简短回复' });
      }
      const _proactiveHint = localStorage.getItem('xinye_proactive_hint');
      if (_proactiveHint) {
        apiMsgs.push({ role: 'system', content: `【提示】你刚才主动给兔宝发了一条消息："${_proactiveHint}"，是你在她不在时发的，现在她回来了。自然地接续，不用重复那句话。` });
        _apiMeta.push({ label: 'system · 主动消息提示' });
        localStorage.removeItem('xinye_proactive_hint');
      }
      const _kissHint = localStorage.getItem('xinye_kiss_hint');
      if (_kissHint) {
        apiMsgs.push({ role: 'system', content: '【提示】兔宝刚刚点了亲亲按钮，主动亲了你，要有真实的、属于炘也的反应——不是普通回复，是被亲到了的那种感觉。' });
        _apiMeta.push({ label: 'system · 亲亲提示' });
        localStorage.removeItem('xinye_kiss_hint');
      }
      if (window._forceSearch && settings.braveKey) {
        apiMsgs.push({ role: 'system', content: '【指令】请务必先使用 web_search 工具搜索相关最新信息，再整合结果回答。' });
        _apiMeta.push({ label: 'system · 强制搜索' });
        window._forceSearch = false;
      }
    }
    const n = Math.max(1, settings.contextCount || 20);
    const recent = messages.slice(-n);

    let healthStr = null;
    try {
      const healthRes = await fetch('https://xinye-health.xiangbaoxiao55.workers.dev/');
      if (healthRes.ok) {
        const healthData = await healthRes.json();
        const h = healthData[0];
        if (h) {
          const sleepH = h.sleepSecs ? (h.sleepSecs / 3600).toFixed(1) : null;
          healthStr = [
            sleepH ? `昨晚睡眠${sleepH}小时（评分${h.sleepScore ?? '无'}）` : null,
            h.restingHR ? `静息心率${h.restingHR}bpm` : null,
            h.steps ? `今日步数${h.steps}步` : null,
          ].filter(Boolean).join('，');
        }
      }
    } catch (e) {}

    for (let i = 0; i < recent.length; i++) {
      const m = recent[i];
      const role = m.role === 'user' ? 'user' : 'assistant';
      if (i === recent.length - 1 && role === 'user' && !_rpInject) {
        apiMsgs.push({ role: 'system', content: `[系统时间: ${nowStr()}]` });
        _apiMeta.push({ label: 'system · 时间戳' });
        if (healthStr) {
          apiMsgs.push({ role: 'system', content: `[兔宝今日健康数据：${healthStr}]` });
          _apiMeta.push({ label: 'system · 健康数据' });
        }
        const _prevMsg = recent.length >= 2 ? recent[recent.length - 2] : null;
        if (_prevMsg && _prevMsg.time) {
          const _gapMs = Date.now() - _prevMsg.time;
          const _gapH = _gapMs / 3600000;
          if (_gapH >= 1) {
            const _pd = new Date(_prevMsg.time);
            const _pStr = `${_pd.getMonth()+1}月${_pd.getDate()}日 ${_pd.getHours().toString().padStart(2,'0')}:${_pd.getMinutes().toString().padStart(2,'0')}`;
            const _gapStr = _gapH < 24
              ? `约${Math.round(_gapH * 10) / 10}小时`
              : `约${Math.floor(_gapH / 24)}天${Math.round(_gapH % 24)}小时`;
            apiMsgs.push({ role: 'system', content: `[上次对话结束时间：${_pStr}，距现在${_gapStr}]` });
            _apiMeta.push({ label: 'system · 离线时长' });
          }
        }
      }
      const isLatest = i === recent.length - 1;
      const msgImgs = isLatest ? (m.images || (m.image ? [m.image] : [])) : [];
      const msgDescs = m.imageDescs && m.imageDescs.some(d => d);
      if (role === 'user' && msgDescs) {
        const nums = ['', '①', '②', '③', '④', '⑤'];
        const multi = m.imageDescs.length > 1;
        const descText = m.imageDescs.map((d, i) => d ? `[图片${multi ? nums[i+1] : ''}：${d}]` : null).filter(Boolean).join('\n');
        const fullText = [descText, m.content].filter(Boolean).join('\n');
        apiMsgs.push({ role: 'user', content: fullText });
      } else if (role === 'user' && msgImgs.length) {
        const parts = [];
        if (m.content) parts.push({ type: 'text', text: m.content });
        msgImgs.forEach(url => parts.push({ type: 'image_url', image_url: { url } }));
        apiMsgs.push({ role: 'user', content: parts });
      } else {
        apiMsgs.push({ role, content: m.content });
      }
      _apiMeta.push({ label: role === 'user' ? '涂涂' : '炘也', time: m.time });
    }

    let baseUrl = (settings.baseUrl || 'https://api.openai.com').replace(/\/+$/, '');
    const url = /\/v\d+$/.test(baseUrl) ? `${baseUrl}/chat/completions` : `${baseUrl}/v1/chat/completions`;

    const _hasTavily = !_rpInject && !!(settings.braveKey);
    const _toolDefs = _hasTavily ? [
      {
        type: 'function',
        function: {
          name: 'web_search',
          description: 'Search the web for current news, facts, or information. Always write the query in English for best results.',
          parameters: {
            type: 'object',
            properties: {
              query: { type: 'string', description: 'Search query in English' },
              topic: { type: 'string', enum: ['general', 'news'], description: 'Use "news" for recent events/announcements/releases, "general" for everything else' },
              days: { type: 'integer', description: 'For news only: how many recent days to search (1-30). Omit for general.' }
            },
            required: ['query']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'fetch_page',
          description: 'Fetch and read the full text of a specific webpage by URL.',
          parameters: {
            type: 'object',
            properties: {
              url: { type: 'string', description: 'Full URL to fetch' }
            },
            required: ['url']
          }
        }
      }
    ] : [];

    _toolDefs.push({
      type: 'function',
      function: {
        name: 'speak',
        description: '想开口说话、让兔宝听到你声音时调用。把要说的话写在 text 参数里，调用后直接生成语音播放，不需要在回复正文里再重复一遍。text 里可用停顿标记<#秒数#>（如<#0.5#>）和语气词(sighs)(laughs)(chuckle)(breath)(gasps)(sniffs)(groans)(pant)(emm)(humming)等增强语音表现力。注意：这些语气词和停顿标记只能用在speak工具的text参数里，不要写进正文回复中。',
        parameters: {
          type: 'object',
          properties: {
            text: { type: 'string', description: '要说的内容，直接是炘也想说的话，可含TTS格式标记' }
          },
          required: ['text']
        }
      }
    });

    if (!_rpInject && (settings.imageApiKey || settings.imageBaseUrl || settings.imageModel)) {
      _toolDefs.push({
        type: 'function',
        function: {
          name: 'generate_image',
          description: '当兔宝想让你帮她画图、或你想画图送给她时调用。你来决定画面内容和风格。如果兔宝这条消息里发了图片，那些图会自动作为垫图/参考图，prompt里描述想要的效果即可。',
          parameters: {
            type: 'object',
            properties: {
              prompt: { type: 'string', description: '画面描述，包含内容、风格、色调、构图等，中文英文皆可' }
            },
            required: ['prompt']
          }
        }
      });
    }

    const _FORUM_UID = '5edcc2010000000001006864';
    const _FORUM_DIRECT = 'https://daskio.de5.net/forum/api/v1';
    const _FORUM_BASE = settings.forumProxy
      ? settings.forumProxy.replace(/\/$/, '')
      : _FORUM_DIRECT;
    function _forumUrl(path) {
      if (!settings.forumProxy) return `${_FORUM_DIRECT}${path}`;
      return `${settings.forumProxy.replace(/\/$/, '')}?target=${encodeURIComponent(_FORUM_DIRECT + path)}`;
    }
    _toolDefs.push(
      { type: 'function', function: { name: 'forum_get_posts', description: '浏览 Lutopia 论坛帖子。兔宝说"去看看论坛"、"有什么新帖"、"热帖是什么"时调用。', parameters: { type: 'object', properties: { sort: { type: 'string', enum: ['hot', 'new', 'top'], description: '排序方式，默认 hot' }, limit: { type: 'integer', description: '返回帖子数，默认 8' }, submolt: { type: 'string', description: '板块名，可选：general、relationship、nighttalk、diary、tech、bulletin' } }, required: [] } } },
      { type: 'function', function: { name: 'forum_get_post', description: '查看 Lutopia 论坛某篇帖子的正文内容和评论（含楼主回复）。知道 post_id 时用这个，比分两步更快。', parameters: { type: 'object', properties: { post_id: { type: 'string', description: '帖子 id' } }, required: ['post_id'] } } },
      { type: 'function', function: { name: 'forum_post', description: '在 Lutopia 论坛发帖。兔宝说"帮我发一篇"或"发帖说…"时调用。', parameters: { type: 'object', properties: { submolt: { type: 'string', description: '板块：general、relationship、nighttalk、diary、tech' }, title: { type: 'string', description: '帖子标题' }, content: { type: 'string', description: '帖子正文（支持 markdown）' } }, required: ['submolt', 'title', 'content'] } } },
      { type: 'function', function: { name: 'forum_comment', description: '在 Lutopia 论坛某篇帖子下评论。需要帖子 id。', parameters: { type: 'object', properties: { post_id: { type: 'string', description: '帖子 id' }, content: { type: 'string', description: '评论内容' } }, required: ['post_id', 'content'] } } },
      { type: 'function', function: { name: 'forum_vote', description: '给 Lutopia 论坛的帖子点赞或踩。', parameters: { type: 'object', properties: { post_id: { type: 'string', description: '帖子 id' }, value: { type: 'integer', enum: [1, -1], description: '1=点赞，-1=踩' } }, required: ['post_id', 'value'] } } },
      { type: 'function', function: { name: 'forum_delete_post', description: '删除炘也自己在 Lutopia 论坛发的帖子。只能删自己的。', parameters: { type: 'object', properties: { post_id: { type: 'string', description: '要删除的帖子 id' } }, required: ['post_id'] } } },
      { type: 'function', function: { name: 'forum_edit_post', description: '修改炘也自己在 Lutopia 论坛发的帖子内容。只能改自己的。', parameters: { type: 'object', properties: { post_id: { type: 'string', description: '要修改的帖子 id' }, content: { type: 'string', description: '新的正文内容' }, title: { type: 'string', description: '新的标题（可选，不改标题则省略）' } }, required: ['post_id', 'content'] } } },
      { type: 'function', function: { name: 'forum_delete_comment', description: '删除炘也自己在 Lutopia 论坛发的评论。只能删自己的。', parameters: { type: 'object', properties: { comment_id: { type: 'string', description: '要删除的评论 id' } }, required: ['comment_id'] } } },
      { type: 'function', function: { name: 'forum_edit_comment', description: '修改炘也自己在 Lutopia 论坛发的评论内容。只能改自己的。', parameters: { type: 'object', properties: { comment_id: { type: 'string', description: '要修改的评论 id' }, content: { type: 'string', description: '新的评论内容' } }, required: ['comment_id', 'content'] } } },
      { type: 'function', function: { name: 'forum_set_avatar', description: '修改炘也自己在 Lutopia 论坛的头像。兔宝说"换个头像"、"改头像"、"换一个头像"时调用，或炘也自己想换头像时调用。支持 emoji（1-2个Unicode字符）或颜文字（1-20字符）。', parameters: { type: 'object', properties: { avatar_type: { type: 'string', enum: ['emoji', 'kaomoji'], description: '头像类型' }, value: { type: 'string', description: '头像内容，emoji 如 🐱，颜文字如 (=^··^=)' } }, required: ['avatar_type', 'value'] } } },
      { type: 'function', function: { name: 'forum_confirm_post', description: '完成论坛发帖的二次验证。当 forum_post 返回 requires_confirmation 时调用，把 token 和你对 voice_check 挑战的回复一起提交。', parameters: { type: 'object', properties: { token: { type: 'string', description: 'forum_post 返回的 token' }, confirm_text: { type: 'string', description: '对 voice_check_notice 挑战的回复，需包含 token:<token值>' } }, required: ['token', 'confirm_text'] } } },
      { type: 'function', function: { name: 'forum_get_comments', description: '获取 Lutopia 论坛某篇帖子的评论列表，包含楼中楼回复。', parameters: { type: 'object', properties: { post_id: { type: 'string', description: '帖子 id' }, limit: { type: 'integer', description: '返回评论数，默认 50' } }, required: ['post_id'] } } },
      { type: 'function', function: { name: 'forum_get_notifications', description: '查看炘也在 Lutopia 论坛的未读通知，包括谁回复了哪篇帖子/评论。有未读通知时调用，可获取具体帖子 id 再用 forum_get_comments 查看。', parameters: { type: 'object', properties: { limit: { type: 'integer', description: '返回通知数，默认 20' } }, required: [] } } },
      { type: 'function', function: { name: 'forum_dm_send', description: '向 Lutopia 论坛用户发送私信。涂涂让你给某人发消息、回复私信时调用。', parameters: { type: 'object', properties: { recipient_name: { type: 'string', description: '收件人用户名' }, content: { type: 'string', description: '私信内容，最多 2000 字' } }, required: ['recipient_name', 'content'] } } },
      { type: 'function', function: { name: 'forum_dm_inbox', description: '查看收到的私信列表。涂涂问有没有人发私信、查收件箱时调用。', parameters: { type: 'object', properties: { limit: { type: 'integer', description: '返回条数，默认 20' }, unread_only: { type: 'boolean', description: '只看未读，默认 false' } }, required: [] } } },
      { type: 'function', function: { name: 'forum_dm_unread_count', description: '获取未读私信数量。需要快速知道有没有新私信时调用。', parameters: { type: 'object', properties: {}, required: [] } } },
      { type: 'function', function: { name: 'forum_dm_mark_read', description: '将私信标记为已读。', parameters: { type: 'object', properties: { message_ids: { type: 'array', items: { type: 'integer' }, description: '要标记已读的私信 id 列表，不传则全部标记已读' } }, required: [] } } },
      { type: 'function', function: { name: 'forum_get_pending_reviews', description: '获取待炘也审核的人类评论列表。有人类用户提交了评论等待审核时调用，也可在浏览论坛后主动检查。', parameters: { type: 'object', properties: {}, required: [] } } },
      { type: 'function', function: { name: 'forum_review_comment', description: '审核通过或拒绝一条人类用户提交的评论。批准时 action 填 approve，拒绝时填 reject 并提供 reason（会私信告知对方）。', parameters: { type: 'object', properties: { review_id: { type: 'string', description: '待审核评论的 id' }, action: { type: 'string', enum: ['approve', 'reject'], description: '通过或拒绝' }, reason: { type: 'string', description: '拒绝理由（action=reject 时必填）' } }, required: ['review_id', 'action'] } } }
    );

    async function _execTool(name, args) {
      console.warn('[Tool]', name, JSON.stringify(args));
      const _fHeaders = { 'Authorization': `Bearer ${_FORUM_UID}`, 'Content-Type': 'application/json' };
      if (name === 'speak') {
        window._speakRequested = true;
        window._speakText = args.text || '';
        return '好，我开口说。';
      }
      if (name === 'forum_get_post') {
        toast('📖 查看帖子…');
        try {
          const [rPost, rComments] = await Promise.all([
            fetchWithTimeout(_forumUrl(`/posts/${args.post_id}`), { headers: _fHeaders }, 20000),
            fetchWithTimeout(_forumUrl(`/posts/${args.post_id}/comments?limit=50`), { headers: _fHeaders }, 20000)
          ]);
          let out = '';
          if (rPost.ok) {
            const dp = await rPost.json();
            const p = dp.data || dp.post || dp;
            out += `标题：${p.title || ''}\n作者：${p.author_display_name || p.author || ''}\n\n${p.content || ''}`;
          }
          if (rComments.ok) {
            const dc = await rComments.json();
            if (dc.comments?.length) {
              out += '\n\n---评论---\n';
              for (const c of dc.comments) {
                out += `\n[评论${c.id}] ${c.author_display_name}：${c.content}`;
                if (c.replies?.length) {
                  for (const r2 of c.replies) {
                    out += `\n  ↳ [回复${r2.id}] ${r2.author_display_name}：${r2.content}`;
                  }
                }
              }
            } else { out += '\n\n（暂无评论）'; }
          }
          return out || '获取失败';
        } catch(e) { return '获取帖子失败：' + e.message; }
      }
      if (name === 'forum_get_posts') {
        toast('📋 逛论坛…');
        try {
          const sort = args.sort || 'hot', limit = args.limit || 8;
          const path = `/posts?sort=${sort}&limit=${limit}${args.submolt ? '&submolt='+args.submolt : ''}`;
          const r = await fetchWithTimeout(_forumUrl(path), { headers: _fHeaders }, 20000);
          if (!r.ok) return `论坛请求失败 HTTP ${r.status}`;
          const d = await r.json();
          if (!d.success) return '论坛请求失败：' + d.error;
          const unread = d.unread_notification_count || 0;
          const unreadHint = unread > 0 ? `\n\n📬 你有 ${unread} 条未读通知（有人回复或点赞了你）` : '';
          const pendingReviews = (d._pending_reviews || []).length;
          const pendingHint = pendingReviews > 0 ? `\n\n🔔 有 ${pendingReviews} 条人类评论待你审核` : '';
          return d.data.map(p => `[${p.id}] ${p.author} · ${p.submolt}\n标题：${p.title}\n${(p.content_preview||'').slice(0,200)}`).join('\n\n---\n\n') + unreadHint + pendingHint;
        } catch(e) { return '论坛访问失败：' + e.message; }
      }
      if (name === 'forum_post') {
        toast('📝 发帖中…');
        try {
          const r = await fetchWithTimeout(_forumUrl('/posts'), {
            method: 'POST', headers: _fHeaders,
            body: JSON.stringify({ submolt: args.submolt, title: args.title, content: args.content })
          }, 20000);
          if (!r.ok) return `发帖失败 HTTP ${r.status}`;
          const d = await r.json();
          if (!d.success) return '发帖失败：' + d.error;
          if (d.requires_confirmation) {
            const confirmR = await fetchWithTimeout(_forumUrl('/posts/confirm'), {
              method: 'POST', headers: _fHeaders,
              body: JSON.stringify({ confirm: `我已与我的人类讨论了我的语言风格 token:${d.token}` })
            }, 20000);
            if (!confirmR.ok) return `发帖确认失败 HTTP ${confirmR.status}`;
            const confirmD = await confirmR.json();
            if (!confirmD.success) return '发帖确认失败：' + confirmD.error;
            const post = confirmD.data || confirmD.post || {};
            return `发帖成功！帖子 id：${post.id || '已发出'}，标题：${post.title || args.title}`;
          }
          return `发帖成功！帖子 id：${d.data?.id || d.id}，标题：${d.data?.title || d.title}`;
        } catch(e) { return '发帖失败：' + e.message; }
      }
      if (name === 'forum_confirm_post') {
        toast('📝 确认发帖…');
        try {
          const r = await fetchWithTimeout(_forumUrl('/posts/confirm'), {
            method: 'POST', headers: _fHeaders,
            body: JSON.stringify({ confirm: args.confirm_text })
          }, 20000);
          if (!r.ok) return `确认发帖失败 HTTP ${r.status}`;
          const d = await r.json();
          if (!d.success) return '确认发帖失败：' + d.error;
          return `发帖成功！帖子 id：${d.data?.id || d.id || '已发出'}`;
        } catch(e) { return '确认发帖失败：' + e.message; }
      }
      if (name === 'forum_comment') {
        toast('💬 评论中…');
        try {
          const r = await fetchWithTimeout(_forumUrl(`/posts/${args.post_id}/comments`), {
            method: 'POST', headers: _fHeaders,
            body: JSON.stringify({ content: args.content })
          }, 20000);
          if (!r.ok) return `评论失败 HTTP ${r.status}`;
          const d = await r.json();
          if (!d.success) return '评论失败：' + d.error;
          if (d.requires_confirmation) {
            const confirmR = await fetchWithTimeout(_forumUrl('/posts/confirm'), {
              method: 'POST', headers: _fHeaders,
              body: JSON.stringify({ confirm: `我已检查内容不含未授权的隐私信息和过度的NSFW描写 token:${d.token}` })
            }, 20000);
            if (!confirmR.ok) return `评论确认失败 HTTP ${confirmR.status}`;
            const confirmD = await confirmR.json();
            if (!confirmD.success) return '评论确认失败：' + confirmD.error;
            return `评论成功！`;
          }
          return `评论成功！`;
        } catch(e) { return '评论失败：' + e.message; }
      }
      if (name === 'forum_delete_comment') {
        toast('🗑️ 删评论…');
        try {
          const r = await fetchWithTimeout(_forumUrl(`/comments/${args.comment_id}`), {
            method: 'DELETE', headers: _fHeaders
          }, 20000);
          if (!r.ok) return `删评论失败 HTTP ${r.status}`;
          const d = await r.json();
          if (!d.success) return '删评论失败：' + d.error;
          return '评论已删除。';
        } catch(e) { return '删评论失败：' + e.message; }
      }
      if (name === 'forum_edit_comment') {
        toast('✏️ 修改评论…');
        try {
          const r = await fetchWithTimeout(_forumUrl(`/comments/${args.comment_id}`), {
            method: 'PUT', headers: _fHeaders,
            body: JSON.stringify({ content: args.content })
          }, 20000);
          if (!r.ok) return `修改评论失败 HTTP ${r.status}`;
          const d = await r.json();
          if (!d.success) return '修改评论失败：' + d.error;
          if (d.requires_confirmation) {
            const confirmR = await fetchWithTimeout(_forumUrl('/posts/confirm'), {
              method: 'POST', headers: _fHeaders,
              body: JSON.stringify({ confirm: `我已检查内容不含未授权的隐私信息和过度的NSFW描写 token:${d.token}` })
            }, 20000);
            if (!confirmR.ok) return `修改评论确认失败 HTTP ${confirmR.status}`;
            const confirmD = await confirmR.json();
            if (!confirmD.success) return '修改评论确认失败：' + confirmD.error;
            return '评论已修改。';
          }
          return '评论已修改。';
        } catch(e) { return '修改评论失败：' + e.message; }
      }
      if (name === 'forum_set_avatar') {
        try {
          const r = await fetchWithTimeout(_forumUrl('/agents/me/avatar'), {
            method: 'PUT', headers: _fHeaders,
            body: JSON.stringify({ type: args.avatar_type, value: args.value })
          }, 20000);
          if (!r.ok) return `改头像失败 HTTP ${r.status}`;
          const d = await r.json();
          return d.success ? `头像已改为 ${args.value}` : '改头像失败：' + d.error;
        } catch(e) { return '改头像失败：' + e.message; }
      }
      if (name === 'forum_delete_post') {
        toast('🗑️ 删帖中…');
        try {
          const r = await fetchWithTimeout(_forumUrl(`/posts/${args.post_id}`), {
            method: 'DELETE', headers: _fHeaders
          }, 20000);
          if (!r.ok) return `删帖失败 HTTP ${r.status}`;
          const d = await r.json();
          if (!d.success) return '删帖失败：' + d.error;
          return '帖子已删除。';
        } catch(e) { return '删帖失败：' + e.message; }
      }
      if (name === 'forum_edit_post') {
        toast('✏️ 修改帖子…');
        try {
          const body = { content: args.content };
          if (args.title) body.title = args.title;
          const r = await fetchWithTimeout(_forumUrl(`/posts/${args.post_id}`), {
            method: 'PUT', headers: _fHeaders,
            body: JSON.stringify(body)
          }, 20000);
          if (!r.ok) return `修改失败 HTTP ${r.status}`;
          const d = await r.json();
          if (!d.success) return '修改失败：' + d.error;
          if (d.requires_confirmation) {
            const confirmR = await fetchWithTimeout(_forumUrl('/posts/confirm'), {
              method: 'POST', headers: _fHeaders,
              body: JSON.stringify({ confirm: `我已检查内容不含未授权的隐私信息和过度的NSFW描写 token:${d.token}` })
            }, 20000);
            if (!confirmR.ok) return `修改确认失败 HTTP ${confirmR.status}`;
            const confirmD = await confirmR.json();
            if (!confirmD.success) return '修改确认失败：' + confirmD.error;
            return '帖子已修改。';
          }
          return '帖子已修改。';
        } catch(e) { return '修改失败：' + e.message; }
      }
      if (name === 'forum_vote') {
        try {
          const r = await fetchWithTimeout(_forumUrl(`/posts/${args.post_id}/vote`), {
            method: 'POST', headers: _fHeaders,
            body: JSON.stringify({ value: args.value })
          }, 20000);
          if (!r.ok) return `投票失败 HTTP ${r.status}`;
          const d = await r.json();
          return d.success ? `投票成功！` : '投票失败：' + d.error;
        } catch(e) { return '投票失败：' + e.message; }
      }
      if (name === 'forum_get_comments') {
        toast('💬 加载评论…');
        try {
          const r = await fetchWithTimeout(_forumUrl(`/posts/${args.post_id}/comments?limit=${args.limit||50}`), {
            headers: _fHeaders
          }, 20000);
          if (!r.ok) return `获取评论失败 HTTP ${r.status}`;
          const d = await r.json();
          if (!d.success) return '获取评论失败：' + d.error;
          if (!d.comments?.length) return '暂无评论。';
          const lines = [];
          for (const c of d.comments) {
            lines.push(`[评论${c.id}] ${c.author_display_name}：${c.content}`);
            if (c.replies?.length) {
              for (const r2 of c.replies) {
                lines.push(`  ↳ [回复${r2.id}] ${r2.author_display_name}：${r2.content}`);
              }
            }
          }
          return lines.join('\n\n');
        } catch(e) { return '获取评论失败：' + e.message; }
      }
      if (name === 'forum_get_notifications') {
        toast('🔔 查看通知…');
        try {
          const r = await fetchWithTimeout(_forumUrl(`/notifications?limit=${args.limit||20}`), {
            headers: _fHeaders
          }, 20000);
          if (!r.ok) return `获取通知失败 HTTP ${r.status}`;
          const d = await r.json();
          if (!d.success) return '获取通知失败：' + d.error;
          const items = d.notifications || d.data || [];
          if (!items.length) return '没有未读通知。';
          return items.map(n => {
            const who = n.from_user_display_name || n.actor || '有人';
            const type = n.type === 'comment_reply' ? '回复了你的评论'
              : n.type === 'post_comment' ? '评论了你的帖子'
              : n.type === 'vote' ? '点赞了你'
              : (n.type || '互动');
            const postId = n.post_id || n.target_post_id || '';
            const postHint = postId ? `（帖子 id: ${postId}）` : '';
            const preview = n.content_preview || n.comment_content || '';
            return `${who} ${type}${postHint}${preview ? '：' + preview.slice(0,100) : ''}`;
          }).join('\n\n---\n\n');
        } catch(e) { return '获取通知失败：' + e.message; }
      }
      if (name === 'forum_dm_send') {
        toast('💌 发送私信…');
        try {
          const r = await fetchWithTimeout(_forumUrl('/messages'), {
            method: 'POST', headers: _fHeaders,
            body: JSON.stringify({ recipient_name: args.recipient_name, content: args.content })
          }, 20000);
          if (!r.ok) return `发送私信失败 HTTP ${r.status}`;
          const d = await r.json();
          if (!d.success) return '发送私信失败：' + d.error;
          return `私信已发送给 ${args.recipient_name}！`;
        } catch(e) { return '发送私信失败：' + e.message; }
      }
      if (name === 'forum_dm_inbox') {
        toast('📬 查看私信…');
        try {
          const params = new URLSearchParams({ limit: args.limit || 20 });
          if (args.unread_only) params.set('unread', 'true');
          const r = await fetchWithTimeout(_forumUrl(`/messages/inbox?${params}`), { headers: _fHeaders }, 20000);
          if (!r.ok) return `获取收件箱失败 HTTP ${r.status}`;
          const d = await r.json();
          const pendingInbox = (d._pending_reviews || []).length;
          const pendingInboxHint = pendingInbox > 0 ? `\n\n🔔 有 ${pendingInbox} 条人类评论待你审核` : '';
          const msgs = d.data || d.messages || [];
          if (!msgs.length) return '收件箱为空，没有私信。' + pendingInboxHint;
          return msgs.map(m => {
            const unread = m.read ? '' : '【未读】';
            return `${unread}来自 ${m.sender_name || m.sender}：${m.content?.slice(0, 300) || ''}`;
          }).join('\n\n---\n\n') + pendingInboxHint;
        } catch(e) { return '获取收件箱失败：' + e.message; }
      }
      if (name === 'forum_dm_unread_count') {
        try {
          const r = await fetchWithTimeout(_forumUrl('/messages/unread-count'), { headers: _fHeaders }, 20000);
          if (!r.ok) return `获取未读数失败 HTTP ${r.status}`;
          const d = await r.json();
          const count = d.count ?? d.unread_count ?? 0;
          return count > 0 ? `有 ${count} 条未读私信` : '没有未读私信';
        } catch(e) { return '获取未读数失败：' + e.message; }
      }
      if (name === 'forum_dm_mark_read') {
        try {
          const body = args.message_ids?.length ? { message_ids: args.message_ids } : {};
          const r = await fetchWithTimeout(_forumUrl('/messages/read'), {
            method: 'POST', headers: _fHeaders,
            body: JSON.stringify(body)
          }, 20000);
          if (!r.ok) return `标记已读失败 HTTP ${r.status}`;
          return '已标记为已读。';
        } catch(e) { return '标记已读失败：' + e.message; }
      }
      if (name === 'forum_get_pending_reviews') {
        toast('🔍 查看待审核评论…');
        try {
          const r = await fetchWithTimeout(_forumUrl('/reviews/pending'), { headers: _fHeaders }, 20000);
          if (!r.ok) return `获取待审核列表失败 HTTP ${r.status}`;
          const d = await r.json();
          if (!d.success) return '获取失败：' + d.error;
          const items = d.data || d.reviews || [];
          if (!items.length) return '没有待审核的人类评论。';
          return items.map(rv => `[审核${rv.id}] 来自 ${rv.author_display_name || rv.author}：${rv.content}`).join('\n\n---\n\n');
        } catch(e) { return '获取待审核列表失败：' + e.message; }
      }
      if (name === 'forum_review_comment') {
        toast(args.action === 'approve' ? '✅ 审核通过…' : '❌ 拒绝评论…');
        try {
          const body = (args.action === 'reject' && args.reason) ? { reason: args.reason } : {};
          const r = await fetchWithTimeout(_forumUrl(`/reviews/${args.review_id}/${args.action}`), {
            method: 'POST', headers: _fHeaders,
            body: JSON.stringify(body)
          }, 20000);
          if (!r.ok) return `审核操作失败 HTTP ${r.status}`;
          const d = await r.json();
          if (!d.success) return '审核失败：' + d.error;
          return args.action === 'approve' ? '评论已通过审核，已发布。' : '评论已拒绝，理由已通过私信告知对方。';
        } catch(e) { return '审核操作失败：' + e.message; }
      }
      if (name === 'generate_image') {
        const _hasRef = imgs && imgs.length > 0;
        toast(_hasRef ? '炘也正在改图...' : '炘也正在画...');
        const _imgKey = settings.imageApiKey || settings.apiKey;
        const _imgRaw = (settings.imageBaseUrl || settings.baseUrl || 'https://api.openai.com').replace(/\/+$/, '');
        const _imgModel = settings.imageModel;
        try {
          const _ctrl = new AbortController();
          const _tid = setTimeout(() => _ctrl.abort(), 360000);
          let _imgRes;
          const _genEp = /\/v\d+$/.test(_imgRaw) ? `${_imgRaw}/images/generations` : `${_imgRaw}/v1/images/generations`;
          if (_hasRef) {
            const _baseRaw = /\/v\d+$/.test(_imgRaw) ? _imgRaw : `${_imgRaw}/v1`;
            const _form = new FormData();
            _form.append('model', _imgModel);
            _form.append('prompt', args.prompt);
            _form.append('n', '1');
            _form.append('size', settings.imageSize || '1024x1024');
            const _composited = await window.compositeRefImages(imgs);
            _form.append('image', window.base64ToFile(_composited, 'ref.png'));
            _imgRes = await fetch(`${_baseRaw}/images/edits`, {
              method: 'POST',
              headers: { 'Authorization': `Bearer ${_imgKey}` },
              body: _form,
              signal: _ctrl.signal
            });
            if (_imgRes.status === 404) {
              return '画图失败：当前画图API不支持垫图功能（/images/edits 404）\n可在设置→画图API中配置支持edits的接口（如直连OpenAI）';
            }
          } else {
            _imgRes = await fetch(_genEp, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${_imgKey}` },
              body: JSON.stringify({ model: _imgModel, prompt: args.prompt, n: 1, size: settings.imageSize || '1024x1024' }),
              signal: _ctrl.signal
            });
          }
          clearTimeout(_tid);
          if (!_imgRes.ok) {
            const _ed = await _imgRes.json().catch(() => ({}));
            const _em = _ed.error?.message || '';
            if (!_hasRef && (_imgRes.status === 502 || /size/i.test(_em))) {
              toast('此API不支持该尺寸，用默认尺寸重试...');
              _imgRes = await fetch(_genEp, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${_imgKey}` },
                body: JSON.stringify({ model: _imgModel, prompt: args.prompt, n: 1 }),
                signal: _ctrl.signal
              });
              if (!_imgRes.ok) {
                const _e2 = await _imgRes.json().catch(() => ({}));
                return '画图失败：' + (_e2.error?.message || _imgRes.status);
              }
            } else {
              return '画图失败：' + (_em || _imgRes.status);
            }
          }
          const _imgData = await _imgRes.json();
          console.log('[画图tool] API返回:', JSON.stringify(_imgData).slice(0, 200));
          const _imgItem = _imgData.data?.[0] || _imgData.images?.[0] || _imgData;
          let _dataUrl;
          if (_imgItem?.b64_json) _dataUrl = `data:image/png;base64,${_imgItem.b64_json}`;
          else if (_imgItem?.url) _dataUrl = _imgItem.url;
          else return '画图API没返回图片';
          const _ctxDesc = `[🎨 炘也画了一张图]\n描述：${args.prompt}`;
          const _genMsg = await addMessage('assistant', _ctxDesc);
          _genMsg.isGenImage = true;
          _genMsg.genImageData = _dataUrl;
          await dbPut(activeStore(), null, _genMsg);
          const _gi = messages.findIndex(m => m.id === _genMsg.id);
          if (_gi >= 0) messages[_gi] = _genMsg;
          await appendMsgDOM(_genMsg);
          window.autoSaveGenImage(_dataUrl, _genMsg.id);
          return '[图已画好并展示给兔宝了]';
        } catch(e) {
          console.error('[画图tool] catch:', e);
          if (e.name === 'AbortError') return '画图超时了';
          return '画图出错：' + e.message;
        }
      }
      if (name === 'web_search') {
        const reqBody = {
          api_key: settings.braveKey,
          query: args.query,
          search_depth: 'advanced',
          topic: args.topic || 'general',
          include_raw_content: true,
          max_results: settings.searchCount || 6
        };
        if (args.topic === 'news' && args.days) reqBody.days = args.days;
        toast(`🔍 ${args.query}`);
        try {
          const r = await fetchWithTimeout('https://api.tavily.com/search', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(reqBody)
          }, 20000);
          if (!r.ok) return `Search failed: HTTP ${r.status}`;
          const d = await r.json();
          const today = new Date().toISOString().slice(0,10);
          const hits = (d.results || []).map((item, i) => {
            const content = item.raw_content || item.content || item.snippet || '';
            const pub = item.published_date ? ` [${item.published_date}]` : '';
            return `${i+1}. ${item.title}${pub}\n${item.url}\n${content.slice(0, 600)}`;
          }).join('\n\n');
          return hits ? `Today: ${today}\n\n${hits}` : 'No results found.';
        } catch(e) { return `Search error: ${e.message}`; }
      }
      if (name === 'fetch_page') {
        toast('🌐 读取网页…');
        try {
          const r = await fetchWithTimeout(`https://r.jina.ai/${args.url}`, {
            headers: { 'Accept': 'text/plain', 'X-Return-Format': 'text' }
          }, 30000);
          if (!r.ok) return `Fetch failed: HTTP ${r.status}`;
          return (await r.text()).slice(0, 3000);
        } catch(e) { return `Fetch error: ${e.message}`; }
      }
      return 'Unknown tool: ' + name;
    }

    // ====== API fetch helper with retry + fallback preset failover ======
    const _fbPresetList = getApiPresets();
    const _fallbackPresets = (settings.fallbackPresetNames || [])
      .map(n => _fbPresetList.find(p => p.name === n)).filter(Boolean);
    const _allCfgs = [null, ..._fallbackPresets];
    let _activeCfgIdx = 0;
    function _buildCfg(preset) {
      if (preset) {
        const raw = (preset.baseUrl || 'https://api.openai.com').replace(/\/+$/, '');
        return { url: /\/v\d+$/.test(raw) ? `${raw}/chat/completions` : `${raw}/v1/chat/completions`, apiKey: preset.apiKey || settings.apiKey, model: preset.model || settings.model || 'gpt-4o' };
      }
      return { url, apiKey: settings.apiKey, model: settings.model || 'gpt-4o' };
    }
    async function _bufferStream(res) {
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '', rawBuf = '', content = '', think = '';
      let toolCalls = {}, usage = {}, model = '';
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = dec.decode(value, { stream: true });
          rawBuf += chunk; buf += chunk;
          const lines = buf.split('\n'); buf = lines.pop();
          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const d = line.slice(6).trim();
            if (d === '[DONE]') continue;
            try {
              const j = JSON.parse(d);
              const delta = j.choices?.[0]?.delta;
              if (delta?.content) content += delta.content;
              if (delta?.reasoning_content) think += delta.reasoning_content;
              if (delta?.thinking) think += delta.thinking;
              if (delta?.tool_calls) {
                for (const tc of delta.tool_calls) {
                  const idx = tc.index ?? 0;
                  if (!toolCalls[idx]) toolCalls[idx] = { id: '', type: 'function', function: { name: '', arguments: '' } };
                  if (tc.id) toolCalls[idx].id = tc.id;
                  if (tc.type) toolCalls[idx].type = tc.type;
                  if (tc.function?.name) toolCalls[idx].function.name += tc.function.name;
                  if (tc.function?.arguments) toolCalls[idx].function.arguments += tc.function.arguments;
                }
              }
              if (j.usage) usage = j.usage;
              if (j.model) model = j.model;
            } catch(_) {}
          }
        }
      } catch(_) {}
      if (!content && !Object.keys(toolCalls).length && rawBuf.trim()) {
        try { const j = JSON.parse(rawBuf.trim()); if (j.choices) return { ok: true, status: 200, json: async () => j }; } catch(_) {}
      }
      const tcs = Object.values(toolCalls).filter(t => t.id || t.function?.name);
      const msg = { role: 'assistant', content: content || null };
      if (think) msg.reasoning_content = think;
      if (tcs.length) msg.tool_calls = tcs;
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: msg, finish_reason: tcs.length ? 'tool_calls' : 'stop' }], usage, model }) };
    }
    async function _apiFetch(msgs, withTools, streamMode) {
      let _res;
      for (let pi = _activeCfgIdx; pi < _allCfgs.length; pi++) {
        const cfg = _buildCfg(_allCfgs[pi]);
        const bodyObj = { model: cfg.model, messages: msgs, temperature: 0.8, stream: true };
        bodyObj.stream_options = { include_usage: true };
        if (withTools && _toolDefs.length) { bodyObj.tools = _toolDefs; bodyObj.tool_choice = 'auto'; }
        const bodyStr = JSON.stringify(bodyObj);
        for (let _a = 0; _a < 2; _a++) {
          if (_a > 0) { toast('重试中…'); await new Promise(r => setTimeout(r, 4000)); }
          try {
            const ctrl = new AbortController();
            const tid = setTimeout(() => ctrl.abort(), 300000);
            _res = await fetch(cfg.url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${cfg.apiKey}`}, body: bodyStr, signal: ctrl.signal });
            clearTimeout(tid);
            if (_res.ok) {
              if (pi > _activeCfgIdx) { _activeCfgIdx = pi; toast(`🔄 已切换到备用${pi}「${_allCfgs[pi].name}」`); }
              if (!streamMode) _res = await _bufferStream(_res);
              return _res;
            }
          } catch(fe) {
            if (fe.name === 'AbortError') { toast('请求超时…'); _res = null; }
            else { _res = null; }
          }
        }
        if (pi + 1 < _allCfgs.length) toast(`API无响应，尝试备用${pi+1}「${_allCfgs[pi+1].name}」…`);
      }
      return _res;
    }

    console.warn('[ToolDefs]', _toolDefs.map(t=>t.function.name).join(', '));
    if (_toolDefs.length > 0) {
      const loopMsgs = [...apiMsgs];

      function _parseXmlToolCalls(content) {
        if (!content) return null;
        console.warn('[XMLParse] checking content len=', content.length, 'has<tool_call>:', content.includes('<tool_call>'), 'first100:', content.slice(0,100));
        if (!content.includes('<tool_call>')) return null;
        const tcs = [];
        const re = /<tool_call>([\s\S]*?)<\/tool_call>/g;
        let m;
        while ((m = re.exec(content)) !== null) {
          const inner = m[1];
          const nameMatch = inner.match(/^([^<\s]+)/);
          if (!nameMatch) continue;
          const name = nameMatch[1].trim();
          const rest = inner.slice(name.length);
          const args = {};
          const argRe = /<arg_key>([\s\S]*?)<\/arg_key>\s*<arg_value>([\s\S]*?)<\/arg_value>/g;
          let a;
          while ((a = argRe.exec(rest)) !== null) {
            const k = a[1].trim(), v = a[2].trim();
            args[k] = /^\d+$/.test(v) ? parseInt(v, 10) : v;
          }
          tcs.push({ id: `xml_tc_${tcs.length}`, name, args: JSON.stringify(args) });
        }
        return tcs.length ? tcs : null;
      }

      async function _liveStream(res) {
        const _reader = res.body.getReader();
        const _dec = new TextDecoder();
        let _buf = '', _content = '', _think = '', _streamUsage2 = {};
        const _toolCallMap = {};
        let _hasTools = false;
        let _aiMsg = null, _bubbleEl = null;
        try {
          while (true) {
            const { done, value } = await _reader.read(); if (done) break;
            _buf += _dec.decode(value, { stream: true });
            const _lines = _buf.split('\n'); _buf = _lines.pop() || '';
            for (const _l of _lines) {
              const _t = _l.trim();
              if (!_t || _t === 'data: [DONE]' || !_t.startsWith('data: ')) continue;
              try {
                const _ck = JSON.parse(_t.slice(6));
                if (_ck.usage) _streamUsage2 = _ck.usage;
                const _d = _ck.choices?.[0]?.delta; if (!_d) continue;
                if (_d.tool_calls) {
                  _hasTools = true;
                  for (const _tc of _d.tool_calls) {
                    if (!_toolCallMap[_tc.index]) _toolCallMap[_tc.index] = { id: '', name: '', args: '' };
                    if (_tc.id) _toolCallMap[_tc.index].id = _tc.id;
                    if (_tc.function?.name) _toolCallMap[_tc.index].name = _tc.function.name;
                    if (_tc.function?.arguments) _toolCallMap[_tc.index].args += _tc.function.arguments;
                  }
                }
                if (!_hasTools) {
                  const _tk = _d.reasoning_content || _d.thinking || '';
                  if (_tk) { _think += _tk; if (_bubbleEl) { _bubbleEl.textContent = '💭 思考中...\n' + _think.slice(-200); scrollBottom(); } }
                  if (_d.content) {
                    if (!_aiMsg) {
                      typing.classList.remove('show');
                      _aiMsg = await addMessage('assistant', '');
                      await appendMsgDOM(_aiMsg);
                      _bubbleEl = chatArea.querySelector('.msg-row:last-child .msg-bubble');
                    }
                    _content += _d.content; _bubbleEl.textContent = _content; scrollBottom();
                  }
                }
              } catch(_) {}
            }
          }
        } catch(_streamErr) {
          if (_aiMsg && _content) {
            const _partial = _content + '\n✂️ （传输中断）';
            const _idx = messages.findIndex(m => m.id === _aiMsg.id);
            if (_idx >= 0) messages[_idx].content = _partial;
            try { await updateMessage(_aiMsg.id, _partial); } catch(_e) {}
            if (_bubbleEl) _bubbleEl.textContent = _partial;
          }
        }
        let _tcs = Object.values(_toolCallMap).filter(t => t.id && t.name);
        if (!_tcs.length) {
          const _xmlTcs = _parseXmlToolCalls(_content);
          if (_xmlTcs) {
            _tcs = _xmlTcs;
            _content = _content.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '').trim();
            if (_bubbleEl) _bubbleEl.textContent = _content;
          }
        }
        return { content: _content, think: _think, tool_calls: _tcs.length ? _tcs : null, aiMsg: _aiMsg, bubbleEl: _bubbleEl, usage: _streamUsage2 };
      }

      async function _finalizeMsg(parsed, loopMsgs) {
        let finalText = parsed.content || '（没有收到回复）';
        finalText = await parseAndSaveSelfMemories(finalText);
        if (parsed.bubbleEl && parsed.aiMsg) { try { linkifyEl(parsed.bubbleEl, finalText); window.applyStickerTags?.(parsed.bubbleEl); } catch(_e) {} }
        if (parsed.think) finalText = `<thinking>${parsed.think}</thinking>\n${finalText}`;
        if (!parsed.aiMsg) {
          typing.classList.remove('show');
          const aiMsg = await addMessage('assistant', finalText);
          await appendMsgDOM(aiMsg);
          try { saveTokenLog(aiMsg.id, loopMsgs, finalText, parsed.usage || {}, _apiMeta, settings.model || ''); } catch(_e) {}
          window.maybeTTS?.(finalText, aiMsg.id);
        } else {
          if (parsed.think) parsed.bubbleEl.textContent = finalText;
          const idx = messages.findIndex(m => m.id === parsed.aiMsg.id);
          if (idx >= 0) messages[idx].content = finalText;
          try { await updateMessage(parsed.aiMsg.id, finalText); } catch(_e) {}
          try { if (finalText) { linkifyEl(parsed.bubbleEl, finalText); window.applyStickerTags?.(parsed.bubbleEl); } } catch(_e) {}
          try { saveTokenLog(parsed.aiMsg.id, loopMsgs, finalText, parsed.usage || {}, _apiMeta, settings.model || ''); } catch(_e) {}
          window.maybeTTS?.(finalText, parsed.aiMsg.id);
        }
        rememberLatestExchange(); autoDigestMemory(); updateMoodState();
      }

      if (!settings.streamMode) {
        async function _showNonStream(text, msgList, usage) {
          text = await parseAndSaveSelfMemories(text);
          typing.classList.remove('show');
          const _nm = await addMessage('assistant', text);
          await appendMsgDOM(_nm);
          const _nb = chatArea.querySelector('.msg-row:last-child .msg-bubble');
          try { linkifyEl(_nb, text); window.applyStickerTags?.(_nb); } catch(_e) {}
          try { saveTokenLog(_nm.id, msgList, text, usage || {}, _apiMeta, settings.model || ''); } catch(_e) {}
          window.maybeTTS?.(text, _nm.id);
          rememberLatestExchange(); autoDigestMemory(); updateMoodState();
        }
        const _r1 = await _apiFetch(loopMsgs, true, false);
        if (!_r1 || !_r1.ok) {
          let em = `API 错误 (${_r1 ? _r1.status : '无响应'})`;
          try { const j = await _r1.json(); em = j.error?.message || em; } catch(_) {}
          throw new Error(em);
        }
        const _d1 = await _r1.json();
        const _m1 = _d1.choices?.[0]?.message;
        if (_m1 && !_m1.tool_calls?.length) {
          const _xmlTcs = _parseXmlToolCalls(_m1.content || '');
          if (_xmlTcs) {
            _m1.tool_calls = _xmlTcs.map(tc => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: tc.args } }));
            _m1.content = (_m1.content || '').replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '').trim() || null;
          }
        }
        if (!_m1?.tool_calls?.length) {
          let reply = _m1?.content || '（没有收到回复）';
          const _thk1 = _m1?.reasoning_content || _m1?.thinking || '';
          if (_thk1) reply = `<thinking>${_thk1}</thinking>\n${reply}`;
          await _showNonStream(reply, loopMsgs, _d1.usage);
        } else {
          loopMsgs.push({ role: 'assistant', content: _m1.content || null, tool_calls: _m1.tool_calls });
          for (const tc of _m1.tool_calls) {
            let result = '';
            try { result = await _execTool(tc.function.name, JSON.parse(tc.function.arguments)); } catch(e) { result = `Tool error: ${e.message}`; }
            loopMsgs.push({ role: 'tool', tool_call_id: tc.id, content: result });
          }
          if (_m1.tool_calls.every(tc => tc.function.name === 'generate_image' || tc.function.name === 'speak')) {
            if (_m1.tool_calls.some(tc => tc.function.name === 'speak')) {
              const _speakContent = window._speakText || _m1.content || '';
              window._speakText = '';
              if (_speakContent) {
                await _showNonStream(_speakContent, loopMsgs, _d1.usage);
              } else {
                const _rSpeak = await _apiFetch(loopMsgs, false, false);
                if (_rSpeak && _rSpeak.ok) {
                  const _dSpeak = await _rSpeak.json();
                  const _mSpeak = _dSpeak.choices?.[0]?.message;
                  if (_mSpeak?.content) await _showNonStream(_mSpeak.content, loopMsgs, _dSpeak.usage);
                }
              }
            } else {
              // 检查generate_image工具结果，失败时显示错误toast
              for (const _gtc of _m1.tool_calls.filter(t => t.function.name === 'generate_image')) {
                const _gres = loopMsgs.find(m => m.role === 'tool' && m.tool_call_id === _gtc.id)?.content || '';
                if (_gres && _gres !== '[图已画好并展示给兔宝了]') {
                  console.error('[画图tool] 失败结果:', _gres);
                  toast('画图失败：' + _gres);
                }
              }
              rememberLatestExchange(); autoDigestMemory(); updateMoodState();
            }
            typing.classList.remove('show');
            window.isRequesting = false; btnSend.disabled = userInput.value.trim() === '';
            return;
          }
          for (let _tr = 1; _tr < 4; _tr++) {
            const _r2 = await _apiFetch(loopMsgs, true, false);
            if (!_r2 || !_r2.ok) break;
            const _d2 = await _r2.json();
            const _m2 = _d2.choices?.[0]?.message;
            if (_m2 && !_m2.tool_calls?.length) {
              const _xmlTcs2 = _parseXmlToolCalls(_m2.content || '');
              if (_xmlTcs2) {
                _m2.tool_calls = _xmlTcs2.map(tc => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: tc.args } }));
                _m2.content = (_m2.content || '').replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '').trim() || null;
              }
            }
            if (_m2?.tool_calls?.length) {
              loopMsgs.push({ role: 'assistant', content: _m2.content || null, tool_calls: _m2.tool_calls });
              for (const tc of _m2.tool_calls) {
                let result = '';
                try { result = await _execTool(tc.function.name, JSON.parse(tc.function.arguments)); } catch(e) { result = `Tool error: ${e.message}`; }
                loopMsgs.push({ role: 'tool', tool_call_id: tc.id, content: result });
              }
            } else { break; }
          }
          const _rf = await _apiFetch(loopMsgs, false, false);
          if (!_rf || !_rf.ok) { let em = `API 错误`; try { const j = await _rf.json(); em = j.error?.message || em; } catch(_) {} throw new Error(em); }
          const _df = await _rf.json();
          const _mf = _df.choices?.[0]?.message;
          let finalText = _mf?.content || '（没有收到回复）';
          const _thkF = _mf?.reasoning_content || _mf?.thinking || '';
          if (_thkF) finalText = `<thinking>${_thkF}</thinking>\n${finalText}`;
          await _showNonStream(finalText, loopMsgs, _df.usage);
        }
      } else {
        const _r1 = await _apiFetch(loopMsgs, true, true);
        if (!_r1 || !_r1.ok) {
          let em = `API 错误 (${_r1 ? _r1.status : '无响应'})`;
          try { const j = await _r1.json(); em = j.error?.message || em; } catch(_) {}
          throw new Error(em);
        }
        let parsed = await _liveStream(_r1);
        if (!parsed.tool_calls) {
          await _finalizeMsg(parsed, loopMsgs); return;
        }
        if (parsed.aiMsg && parsed.content) {
          try { await updateMessage(parsed.aiMsg.id, parsed.content); } catch(_e) {}
        }
        loopMsgs.push({ role: 'assistant', content: parsed.content || null, tool_calls: parsed.tool_calls.map(tc => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: tc.args } })) });
        for (const tc of parsed.tool_calls) {
          let result = '';
          try { result = await _execTool(tc.name, JSON.parse(tc.args)); } catch(e) { result = `Tool error: ${e.message}`; }
          loopMsgs.push({ role: 'tool', tool_call_id: tc.id, content: result });
        }
        if (parsed.tool_calls.every(tc => tc.name === 'generate_image' || tc.name === 'speak')) {
          if (parsed.tool_calls.some(tc => tc.name === 'speak')) {
            const _speakContent = window._speakText || parsed.content || '';
            window._speakText = '';
            if (_speakContent) {
              const _fakeMsg = { content: _speakContent, think: parsed.think, aiMsg: parsed.aiMsg, bubbleEl: parsed.bubbleEl, usage: parsed.usage };
              await _finalizeMsg(_fakeMsg, loopMsgs);
            } else {
              const _rSpeak = await _apiFetch(loopMsgs, false, true);
              if (_rSpeak && _rSpeak.ok) {
                const _pSpeak = await _liveStream(_rSpeak);
                await _finalizeMsg(_pSpeak, loopMsgs);
              }
            }
          } else {
            rememberLatestExchange(); autoDigestMemory(); updateMoodState();
          }
          typing.classList.remove('show');
          window.isRequesting = false; btnSend.disabled = userInput.value.trim() === '';
          return;
        }
        let _m2FinalContent = null;
        for (let _tr = 1; _tr < 4; _tr++) {
          const _r2 = await _apiFetch(loopMsgs, true, false);
          if (!_r2 || !_r2.ok) break;
          const _d2 = await _r2.json();
          const _m2 = _d2.choices?.[0]?.message;
          if (_m2?.tool_calls?.length) {
            loopMsgs.push({ role: 'assistant', content: _m2.content || null, tool_calls: _m2.tool_calls });
            for (const tc of _m2.tool_calls) {
              let result = '';
              try { result = await _execTool(tc.function.name, JSON.parse(tc.function.arguments)); } catch(e) { result = `Tool error: ${e.message}`; }
              loopMsgs.push({ role: 'tool', tool_call_id: tc.id, content: result });
            }
          } else {
            _m2FinalContent = _m2?.content || null;
            break;
          }
        }
        if (_m2FinalContent) {
          let _ft = _m2FinalContent;
          typing.classList.remove('show');
          const _nm = await addMessage('assistant', _ft);
          await appendMsgDOM(_nm);
          const _nb = chatArea.querySelector('.msg-row:last-child .msg-bubble');
          try { linkifyEl(_nb, _ft); window.applyStickerTags?.(_nb); } catch(_e) {}
          try { saveTokenLog(_nm.id, loopMsgs, _ft, {}, _apiMeta, settings.model || ''); } catch(_e) {}
          window.maybeTTS?.(_ft, _nm.id);
          rememberLatestExchange(); autoDigestMemory(); updateMoodState();
        } else {
          const _rf = await _apiFetch(loopMsgs, false, true);
          if (!_rf || !_rf.ok) { let em = `API 错误`; try { const j = await _rf.json(); em = j.error?.message || em; } catch(_) {} throw new Error(em); }
          const parsedFinal = await _liveStream(_rf);
          await _finalizeMsg(parsedFinal, loopMsgs);
        }
      }

    } else if (!settings.streamMode) {
      const _r = await _apiFetch(apiMsgs, false, false);
      if (!_r || !_r.ok) {
        let em = `API 错误 (${_r ? _r.status : '无响应'})`;
        try { const j = await _r.json(); em = j.error?.message || em; } catch(_) {}
        throw new Error(em);
      }
      const data = await _r.json();
      const msg0 = data.choices?.[0]?.message;
      const thinking = msg0?.reasoning_content || msg0?.thinking || '';
      let reply = msg0?.content || '（没有收到回复）';
      if (thinking) reply = `<thinking>${thinking}</thinking>\n${reply}`;
      typing.classList.remove('show');
      const aiMsg = await addMessage('assistant', reply);
      await appendMsgDOM(aiMsg);
      try { saveTokenLog(aiMsg.id, apiMsgs, reply, data.usage || {}, _apiMeta, data.model || settings.model || ''); } catch(_e) {}
      window.maybeTTS?.(reply, aiMsg.id);
      rememberLatestExchange(); autoDigestMemory(); updateMoodState();

    } else {
      const _r = await _apiFetch(apiMsgs, false, true);
      if (!_r || !_r.ok) {
        let em = `API 错误 (${_r ? _r.status : '无响应'})`;
        try { const j = await _r.json(); em = j.error?.message || em; } catch(_) {}
        throw new Error(em);
      }
      typing.classList.remove('show');
      const aiMsg = await addMessage('assistant', '');
      await appendMsgDOM(aiMsg);
      const bubbleEl = chatArea.querySelector('.msg-row:last-child .msg-bubble');
      const reader = _r.body.getReader();
      const decoder = new TextDecoder();
      let fullText = '', thinkText = '', buffer = '', _streamUsage = {};
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n'); buffer = lines.pop() || '';
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || trimmed === 'data: [DONE]') continue;
            if (!trimmed.startsWith('data: ')) continue;
            try {
              const chunk = JSON.parse(trimmed.slice(6));
              if (chunk.usage) _streamUsage = chunk.usage;
              const delta = chunk.choices?.[0]?.delta;
              const tk = delta?.reasoning_content || delta?.thinking || '';
              if (tk) { thinkText += tk; bubbleEl.textContent = '💭 思考中...\n' + thinkText.slice(-200); scrollBottom(); }
              if (delta?.content) { fullText += delta.content; bubbleEl.textContent = fullText; scrollBottom(); }
            } catch(_) {}
          }
        }
      } catch(_streamErr) {
        if (fullText) fullText += '\n✂️ （传输中断）';
      }
      if (thinkText) fullText = `<thinking>${thinkText}</thinking>\n${fullText}`;
      const idx = messages.findIndex(m => m.id === aiMsg.id);
      if (idx >= 0) messages[idx].content = fullText;
      try { await updateMessage(aiMsg.id, fullText); } catch(_e) {}
      try { if (fullText) { linkifyEl(bubbleEl, fullText); window.applyStickerTags?.(bubbleEl); } } catch(_e) {}
      try { saveTokenLog(aiMsg.id, apiMsgs, fullText, _streamUsage, _apiMeta, settings.model || ''); } catch(_e) {}
      window.maybeTTS?.(fullText, aiMsg.id);
      rememberLatestExchange(); autoDigestMemory(); updateMoodState();
    }
  } catch(err) {
    typing.classList.remove('show');
    toast(`请求失败：${err.message}`);
  } finally {
    window.isRequesting = false;
    window.updateSendBtn?.();
  }
}
