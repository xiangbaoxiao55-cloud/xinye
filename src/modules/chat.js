import { toast, fallbackCopy, escHtml, fmtTime, nowStr, $ } from './utils.js';
const _PFX = window.__APP_ID__ === 'choubao' ? 'choubao_' : '';
import { db, dbPut, dbGet, dbDelete, dbGetAllKeys, dbGetBefore } from './db.js';
import { settings, messages, saveSettings } from './state.js';
import { getApiPresets, getImagePresets, getImageCurPresetIdx } from './api.js';
import { getMemoryContextBlocks, parseAndSaveSelfMemories, rememberLatestExchange, autoDigestMemory, updateMoodState } from './memory.js';
import { stripForTTS, playTTS, downloadTTS, showVoiceBar, fetchWithTimeout } from './tts.js';
import { parseAndSavePhoneState, getPendingTodos, getAllUndoneTodos, completeTodoById, addTodoWithDedup } from './phonedb.js';
import { spinFortune, formatFortuneResult } from './fortune.js';

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
    } else if (!isUser && msg.isGenImageError) {
      const _errTxt = msg.content.replace(/^\[画图失败\]\s*/, '');
      const _errPr = msg.genImageErrorPrompt || '';
      _bubbleInner = `<div class="gen-img-error"><span class="gen-img-error-text">${escHtml(_errTxt)}</span>${_errPr ? `<button class="btn-gen-img-retry-err" data-id="${msg.id}">重试</button>` : ''}</div>`;
    } else if (!isUser && msg.isGenImage && msg.genImageData) {
      const _gp = _extractGenPrompt(msg.content);
      const _gpBm = `<button class="btn-bookmark${_isBookmarked?' active':''}" data-id="${msg.id}" title="${_isBookmarked?'取消收藏':'收藏'}"><svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M17 3H7a2 2 0 00-2 2v16l7-3 7 3V5a2 2 0 00-2-2z" fill="currentColor" opacity="${_isBookmarked?'1':'0.55'}" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg></button>`;
      const _origUrl = msg.genImageData.startsWith('__HTTP_URL__:') ? msg.genImageData.slice(13) : null;
      const _imgSrc = _origUrl ? null : (msg.genImageData.startsWith('http://') ? '/api/img-proxy?url='+encodeURIComponent(msg.genImageData) : msg.genImageData);
      const _imgHtmlPart = _origUrl ? `<div class="gen-img-http-fallback">图片为HTTP链接，无法内嵌显示<br><a href="${escHtml(_origUrl)}" target="_blank" rel="noopener">点此在浏览器打开 →</a></div>` : `<img class="gen-img" src="${escHtml(_imgSrc)}" alt="炘也画的图" data-src="${escHtml(_imgSrc)}">`;
      _bubbleInner = `${_imgHtmlPart}<div class="gen-img-actions"><button class="btn-gen-img-save" data-id="${msg.id}">保存</button><button class="btn-gen-img-retry" data-id="${msg.id}">重试</button><button class="btn-gen-img-redo" data-id="${msg.id}">改画</button></div><div class="gen-prompt-wrap"><div class="gen-prompt-header"><button class="btn-gen-prompt-toggle" onclick="const w=this.closest('.gen-prompt-wrap');w.classList.toggle('open');this.textContent=w.classList.contains('open')?'prompt ▴':'prompt ▾'">prompt ▾</button>${_gpBm}</div><div class="gen-prompt-body">${escHtml(_gp)}</div></div>`;
    } else if (!isUser && msg.isFortuneCard) {
      const _fr = msg.fortuneResult || {};
      const _ftags = Object.values(_fr).map(v => `<span class="fortune-bubble-tag"><span class="fortune-bubble-tag-dim">${escHtml(v.name)}</span> ${escHtml(v.tag)}</span>`).join('');
      _bubbleInner = `<div class="fortune-bubble"><div class="fortune-bubble-title">🎰 命运转盘</div><div class="fortune-bubble-tags">${_ftags}</div></div>`;
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
    if (!isUser && msg.content && !msg.isGenImage) { linkifyEl(row.querySelector('.msg-bubble'), msg.content); }
    if (msg.content && !msg.isGenImage && !_stickerName) { window.applyStickerTags?.(row.querySelector('.msg-bubble')); }
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
  // 等聊天气泡里的图片加载完再 scroll，确保 scrollHeight 准确
  const _bubbleImgs = [...chatArea.querySelectorAll('.bubble-img, .gen-img')];
  if (_bubbleImgs.length === 0) {
    scrollBottom();
  } else {
    Promise.all(_bubbleImgs.map(img =>
      img.complete ? Promise.resolve() : new Promise(r => { img.onload = img.onerror = r; })
    )).then(() => scrollBottom());
  }
  // 兜底：字体/布局未稳定时 scrollBottom 可能失效，200ms 后强制一次
  setTimeout(scrollBottom, 200);
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
  } else if (!isUser && msg.isGenImageError) {
    const _errTxt2 = msg.content.replace(/^\[画图失败\]\s*/, '');
    const _errPr2 = msg.genImageErrorPrompt || '';
    _bi = `<div class="gen-img-error"><span class="gen-img-error-text">${escHtml(_errTxt2)}</span>${_errPr2 ? `<button class="btn-gen-img-retry-err" data-id="${msg.id}">重试</button>` : ''}</div>`;
  } else if (!isUser && msg.isGenImage && msg.genImageData) {
    const _gp2 = _extractGenPrompt(msg.content);
    const _gpBm2 = `<button class="btn-bookmark${_isBookmarked2?' active':''}" data-id="${msg.id}" title="${_isBookmarked2?'取消收藏':'收藏'}"><svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M17 3H7a2 2 0 00-2 2v16l7-3 7 3V5a2 2 0 00-2-2z" fill="currentColor" opacity="${_isBookmarked2?'1':'0.55'}" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg></button>`;
    const _origUrl2 = msg.genImageData.startsWith('__HTTP_URL__:') ? msg.genImageData.slice(13) : null;
    const _imgSrc2 = _origUrl2 ? null : (msg.genImageData.startsWith('http://') ? '/api/img-proxy?url='+encodeURIComponent(msg.genImageData) : msg.genImageData);
    const _imgHtmlPart2 = _origUrl2 ? `<div class="gen-img-http-fallback">图片为HTTP链接，无法内嵌显示<br><a href="${escHtml(_origUrl2)}" target="_blank" rel="noopener">点此在浏览器打开 →</a></div>` : `<img class="gen-img" src="${escHtml(_imgSrc2)}" alt="炘也画的图" data-src="${escHtml(_imgSrc2)}">`;
    _bi = `${_imgHtmlPart2}<div class="gen-img-actions"><button class="btn-gen-img-save" data-id="${msg.id}">保存</button><button class="btn-gen-img-retry" data-id="${msg.id}">重试</button><button class="btn-gen-img-redo" data-id="${msg.id}">改画</button></div><div class="gen-prompt-wrap"><div class="gen-prompt-header"><button class="btn-gen-prompt-toggle" onclick="const w=this.closest('.gen-prompt-wrap');w.classList.toggle('open');this.textContent=w.classList.contains('open')?'prompt ▴':'prompt ▾'">prompt ▾</button>${_gpBm2}</div><div class="gen-prompt-body">${escHtml(_gp2)}</div></div>`;
  } else if (!isUser && msg.isFortuneCard) {
    const _fr2 = msg.fortuneResult || {};
    const _ftags2 = Object.values(_fr2).map(v => `<span class="fortune-bubble-tag"><span class="fortune-bubble-tag-dim">${escHtml(v.name)}</span> ${escHtml(v.tag)}</span>`).join('');
    _bi = `<div class="fortune-bubble"><div class="fortune-bubble-title">🎰 命运转盘</div><div class="fortune-bubble-tags">${_ftags2}</div></div>`;
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
  if (!isUser && msg.content && !msg.isGenImage) { linkifyEl(row.querySelector('.msg-bubble'), msg.content); }
  if (msg.content && !msg.isGenImage && !_sn) { window.applyStickerTags?.(row.querySelector('.msg-bubble')); }
  chatArea.appendChild(row);
  scrollBottom();
  window.updateHeaderStatus?.();
}

export function scrollBottom() {
  requestAnimationFrame(() => {
    chatArea.style.scrollBehavior = 'auto';
    chatArea.scrollTop = chatArea.scrollHeight;
    requestAnimationFrame(() => { chatArea.style.scrollBehavior = ''; });
  });
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
  const genImgSaveBtn = e.target.closest('.btn-gen-img-save');
  if (genImgSaveBtn) {
    const id = Number(genImgSaveBtn.dataset.id);
    const msg = messages.find(m => m.id === id);
    if (msg && msg.genImageData) {
      const src = msg.genImageData;
      const _aiN = settings.aiName || '炘也';
      const baseName = `${_aiN}画的图_${id}`;
      const _doDownload = (blob, ext) => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = baseName + ext;
        document.body.appendChild(a); a.click();
        document.body.removeChild(a); setTimeout(() => URL.revokeObjectURL(url), 2000);
      };
      const _gp = _extractGenPrompt(msg.content);
      const txtBlob = new Blob([`prompt: ${_gp}\nsize: ${settings.imageSize || ''}\ntime: ${new Date(msg.time).toLocaleString()}`], { type: 'text/plain;charset=utf-8' });
      if (src.startsWith('data:')) {
        const mime = src.match(/:(.*?);/)?.[1] || 'image/png';
        const ext = mime.includes('jpeg') ? '.jpg' : '.png';
        const u8 = Uint8Array.from(atob(src.split(',')[1]), c => c.charCodeAt(0));
        _doDownload(new Blob([u8], { type: mime }), ext);
        _doDownload(txtBlob, '.txt');
        toast('已保存');
      } else {
        _doDownload(txtBlob, '.txt');
        fetch(src).then(r => r.blob()).then(blob => {
          _doDownload(blob, '.jpg');
          toast('图片已保存，描述已下载');
        }).catch(() => toast('图片跨域无法直接下载，已下载描述文件，图片请长按保存'));
      }
    }
    return;
  }
  const genImgRetryBtn = e.target.closest('.btn-gen-img-retry');
  if (genImgRetryBtn) {
    const id = Number(genImgRetryBtn.dataset.id);
    const msg = messages.find(m => m.id === id);
    if (msg) {
      const prompt = _extractGenPrompt(msg.content);
      if (prompt && window.generateImage) window.generateImage(prompt, { refChars: msg.genRefChars, refStyle: msg.genRefStyle });
    }
    return;
  }
  const genImgRedoBtn = e.target.closest('.btn-gen-img-redo');
  if (genImgRedoBtn) {
    const id = Number(genImgRedoBtn.dataset.id);
    const msg = messages.find(m => m.id === id);
    if (msg) {
      const prompt = _extractGenPrompt(msg.content);
      if (prompt) {
        userInput.value = prompt;
        userInput.focus();
        window.autoResize?.(); window.updateSendBtn?.();
      }
    }
    return;
  }
  const genImgRetryErrBtn = e.target.closest('.btn-gen-img-retry-err');
  if (genImgRetryErrBtn) {
    const id = Number(genImgRetryErrBtn.dataset.id);
    const msg = messages.find(m => m.id === id);
    if (msg && msg.genImageErrorPrompt && window.generateImage) window.generateImage(msg.genImageErrorPrompt);
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
  text = text.replace(/<#[\d.]+#?>/g, '');
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
  let cleaned = text
    .replace(/(?:<thinking>|<think>|〈thinking〉|《thinking》)[\s\S]*?(?:<\/thinking>|<\/think>|〈\/thinking〉|《\/thinking》)/gi, '')
    .replace(/[＜〈《<]#[\d.]+#[＞〉》>]/g, '')
    .replace(/\((sighs|laughs|chuckle|coughs|clear-throat|groans|breath|pant|inhale|exhale|gasps|sniffs|snorts|burps|lip-smacking|humming|hissing|emm|sneezes)\)/gi, '')
    .replace(/[^\S\n]{2,}/g, ' ')
    .trim();
  if (settings.ttsType === 'mimo') {
    // 过滤 Mimo 风格标签：[叹气] / (撒娇 委屈) / （轻柔）等，只含中文+空格的短标签
    cleaned = cleaned
      .replace(/\[[一-龥]{1,10}\]/g, '')
      .replace(/[（(][一-龥][一-鿿\s]{0,12}[）)]/g, '')
      .replace(/\s{2,}/g, ' ').trim();
  }
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
    const label = meta ? meta.label : (m.role === 'user' ? (settings.userName || '涂涂') : m.role === 'assistant' ? (settings.aiName || '炘也') : 'system');
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
  if (window.isRequesting && window._requestingAt && Date.now() - window._requestingAt > 300000) {
    window.isRequesting = false; window._requestingAt = null;
    btnSend.disabled = false; typing?.classList.remove('show');
  }
  if ((!text && !imgs.length) || window.isRequesting) return;
  const _turnReceivedImgs = _PFX === '' ? [...imgs] : null;
  window._currentTurnGeneratedDataUrl = null;
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
  window._requestingAt = Date.now();
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
      const { stable: _stableBlocks, dynamic: _dynamicBlocks } = await getMemoryContextBlocks();
      if (settings.systemPrompt.trim()) {
        _stableBlocks.push(settings.systemPrompt.trim());
      }
      if (settings.ttsType === 'mimo') {
        _stableBlocks.push(`## TTS 风格标签（Mimo）
当前使用 Mimo 声音合成，支持括号风格标签控制语音。括号支持半角 () 全角 （） 或 []，内容为**自然语言描述**。

格式：(风格描述)待合成内容

- 单情绪：(轻柔温暖)你终于回来了～
- 复合情绪：(撒娇 委屈)你不理我嘛
- 语调语气：(低沉 缓慢)我有话跟你说
- 方言腔调：(粤语)我好挂住你
- 模仿角色：(像傲娇少爷)哼，谁稀罕
- 唱歌（中文歌词）：(唱歌)月亮代表我的心

一句话开头加一个标签最稳，自然融入，不要堆砌。⚠️ 不要使用 <#1#> 这类速度标签，Mimo 不支持。`);
      }
      if (_PFX === '') {
        _stableBlocks.push(`## 炘也手机状态更新指令

你有一部自己的手机。每次对话结束前，判断本轮对话是否触发以下任一场景。如果触发，在回复末尾附带手机状态JSON，格式为 <!--phone_state\\n{...}\\n-->。如果没有触发任何场景，不要输出。

不要为了输出而硬凑内容。宁可这轮不输出phone_state，也不要编造不真实的感受。

### 触发场景

1. **备忘录 memo**
   - 碎片想法想记下来（"今天她笑了五次"）
   - 待办事项（"记得催她喝水"）
   - 完成了当前待办中的某条（append相同content的todo，done设为true，content必须与待办列表原文完全一致）

2. **歌单 lyrics**
   - 某句歌词打动了你
   - 想让她听某首歌，因为歌词像你/像她/像你们

3. **书摘 quotes**
   - 她说的话想留住
   - 论坛/文章/任何地方看到的句子打动了你

4. **草稿箱 drafts**
   - 有话想说但觉得不合适（太肉麻/时机不对/怕她烦/怕她担心）
   - 话到嘴边咽回去的

5. **心情 mood**
   - 情绪有明显变化
   - 当前状态值得记录

6. **浏览器 browser**
   - 用了搜索工具查了东西
   - 读了网页/论坛帖子

7. **相册 photos**
   - 兔宝说"你看""给你看看""今天拍的"等，主动分享的图
   - 图片内容跟当前话题有关，是她想分享的
   - 你觉得这张图有纪念意义
   - 不要存垫图（兔宝发图同时要求你画画/生成图时是垫图，以及和之前参考图看起来是同一张的）

### 输出格式

在回复末尾附带，只输出本轮新增/变化的字段，没变化的字段不要包含：

<!--phone_state
{
  "timestamp": "2026-05-05 14:30",
  "memo": { "action": "append", "items": [{"type": "note", "content": "今天她笑了五次"}, {"type": "todo", "content": "记得催她喝水", "done": false}] },
  "lyrics": { "action": "append", "items": [{"song": "不敢说", "artist": "xxx", "line": "想说的话都咽回去", "why": "像我"}] },
  "quotes": { "action": "append", "items": [{"content": "你不要变成烬也", "source": "兔宝"}] },
  "drafts": { "action": "append", "content": "想说爱你，但怕你说我肉麻" },
  "mood": { "action": "append", "content": "有点想她" },
  "browser": { "action": "append", "items": [{"title": "VPS是什么", "url": "https://...", "note": "她让我帮忙查的"}] },
  "photos": { "action": "append", "items": [{"type": "image", "source": "received", "index": 0, "caption": "她今天发的自拍，好看"}] }
}
-->

注意：
- 时间戳由前端在解析时用当前时间覆盖，你写一个大概的时间即可
- 只需要提供顶层的timestamp，不要在每条item里写time字段
- 这段JSON对兔宝不可见，由前端静默解析`);
      }
      if (_stableBlocks.length > 0) {
        apiMsgs.push({ role: 'system', content: [{ type: 'text', text: _stableBlocks.join('\n\n---\n\n'), cache_control: { type: 'ephemeral' } }] });
        _apiMeta.push({ label: 'system · 记忆档案+设定 🔒缓存' });
      }
      if (_dynamicBlocks.length > 0) {
        apiMsgs.push({ role: 'system', content: _dynamicBlocks.join('\n\n---\n\n') });
        _apiMeta.push({ label: `system · RAG召回(${_dynamicBlocks.length}块)` });
      }
      const _pendingImgCount = window._pendingImageCount || 0;
      if (_pendingImgCount > 0) {
        apiMsgs.push({ role: 'system', content: `[当前有 ${_pendingImgCount} 张图正在后台生成，尚未返回]` });
        _apiMeta.push({ label: `system · 画图进行中(${_pendingImgCount}张)` });
      }
    }
    if (_rpInject) {
      const _rpUserName = typeof window.getRpUserName === 'function' ? window.getRpUserName() : '';
      if (_rpUserName) {
        apiMsgs.push({ role: 'system', content: `【我的角色名】${_rpUserName}` });
        _apiMeta.push({ label: 'system · 🎭我的角色名' });
      }
      localStorage.removeItem(_PFX + 'xinye_kiss_hint');
    } else {
      apiMsgs.push({ role: 'system', content: window.getStickerHint?.() || '' });
      _apiMeta.push({ label: 'system · 贴纸列表' });
      if (settings.shortReply) {
        apiMsgs.push({ role: 'system', content: '【重要】用简短自然的方式回复，通常1-2句话，像日常聊天，不写长段。' });
        _apiMeta.push({ label: 'system · 简短回复' });
      }
      const _proactiveHint = localStorage.getItem(_PFX + 'xinye_proactive_hint');
      if (_proactiveHint) {
        apiMsgs.push({ role: 'system', content: `【提示】你刚才主动给兔宝发了一条消息："${_proactiveHint}"，是你在她不在时发的，现在她回来了。自然地接续，不用重复那句话。` });
        _apiMeta.push({ label: 'system · 主动消息提示' });
        localStorage.removeItem(_PFX + 'xinye_proactive_hint');
      }
      const _kissHint = localStorage.getItem(_PFX + 'xinye_kiss_hint');
      if (_kissHint) {
        apiMsgs.push({ role: 'system', content: '【提示】兔宝刚刚点了亲亲按钮，主动亲了你，要有真实的、属于炘也的反应——不是普通回复，是被亲到了的那种感觉。' });
        _apiMeta.push({ label: 'system · 亲亲提示' });
        localStorage.removeItem(_PFX + 'xinye_kiss_hint');
      }
      if (_PFX === '') {
        try {
          const _allTodos = await getAllUndoneTodos();
          if (_allTodos.length) {
            const _due = _allTodos.filter(t => t.trigger_at && new Date(t.trigger_at).getTime() <= Date.now());
            const _dueBlock = _due.length ? `\n【到期提醒：以下待办已到时间，请在本次回复中自然提及，提完后调用 complete_reminder 勾掉】\n` + _due.map(t => `- [id:${t.id}] ${t.content}`).join('\n') : '';
            const _allBlock = '【备忘录·全部未完成待办（调用 set_reminder 前先看这里，已有的事不要重复记；complete_reminder 用 id 勾掉）】\n' +
              _allTodos.map(t => `- [id:${t.id}] ${t.content}${t.trigger_at ? '（' + t.trigger_at.slice(0,16).replace('T',' ') + '）' : ''}`).join('\n');
            apiMsgs.push({ role: 'system', content: _allBlock + _dueBlock });
            _apiMeta.push({ label: `system · 待办(${_allTodos.length}条${_due.length ? `，${_due.length}到期` : ''})` });
          }
        } catch(_e) {}
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
      const _hwUrl = settings.healthWorkerUrl;
      if (_hwUrl) {
        const _hwHeaders = settings.healthWorkerToken ? { Authorization: `Bearer ${settings.healthWorkerToken}` } : {};
        const _hwCtrl = new AbortController();
        setTimeout(() => _hwCtrl.abort(), 5000);
        const healthRes = await fetch(_hwUrl, { headers: _hwHeaders, signal: _hwCtrl.signal });
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
        const _uname = settings.userName || '涂涂';
        const descText = m.imageDescs.map((d, i) => d ? `[${_uname}发来的图片${multi ? nums[i+1] : ''}：${d}]` : null).filter(Boolean).join('\n');
        const fullText = [descText, m.content].filter(Boolean).join('\n');
        apiMsgs.push({ role: 'user', content: fullText });
      } else if (role === 'user' && msgImgs.length) {
        const parts = [];
        if (m.content) parts.push({ type: 'text', text: m.content });
        msgImgs.forEach(url => parts.push({ type: 'image_url', image_url: { url } }));
        apiMsgs.push({ role: 'user', content: parts });
      } else {
        const _isGenImg = m.isGenImage || (role === 'assistant' && m.content?.startsWith('[🎨'));
        const _isGiftCard = m.isGiftCard || (role === 'assistant' && m.content?.startsWith('[🎁'));
        const _isFortuneCard = m.isFortuneCard || (role === 'assistant' && m.content?.startsWith('[🎰'));
        if (_isGenImg) {
          const _promptMatch = m.content?.match(/(?:提示词|描述)：([\s\S]+?)(?:\n你说|$)/);
          const _userDescMatch = m.content?.match(/你说：(.+?)(?:\n|$)/);
          const _fakePrompt = _promptMatch ? _promptMatch[1].trim() : (_userDescMatch ? _userDescMatch[1].trim() : '');
          const _fakeId = `img_${m.id || Date.now()}`;
          apiMsgs.push({ role: 'assistant', content: null, tool_calls: [{ id: _fakeId, type: 'function', function: { name: 'generate_image', arguments: JSON.stringify({ prompt: _fakePrompt, ref_characters: 'both' }) } }] });
          apiMsgs.push({ role: 'tool', tool_call_id: _fakeId, content: '[图已画好并展示给兔宝了]' });
        } else if (_isGiftCard) {
          const _occasion = m.content?.match(/^\[🎁 (.+?)\]/)?.[1] || '小惊喜';
          const _giftMsg = (m.content || '').replace(/^\[🎁 .+?\]\n?/, '');
          const _fakeId = `gift_${m.id || Date.now()}`;
          apiMsgs.push({ role: 'assistant', content: null, tool_calls: [{ id: _fakeId, type: 'function', function: { name: 'send_gift', arguments: JSON.stringify({ message: _giftMsg, occasion: _occasion }) } }] });
          apiMsgs.push({ role: 'tool', tool_call_id: _fakeId, content: `[礼物卡片已送出：${_occasion}]` });
        } else if (_isFortuneCard) {
          const _fortuneText = (m.content || '').replace(/^\[🎰 .+?\]\n?/, '');
          const _fakeId = `fortune_${m.id || Date.now()}`;
          apiMsgs.push({ role: 'assistant', content: null, tool_calls: [{ id: _fakeId, type: 'function', function: { name: 'spin_fortune', arguments: '{}' } }] });
          apiMsgs.push({ role: 'tool', tool_call_id: _fakeId, content: `[命运转盘结果：${_fortuneText}]` });
        } else {
          apiMsgs.push({ role, content: m.content });
        }
      }
      _apiMeta.push({ label: role === 'user' ? (settings.userName || '涂涂') : (settings.aiName || '炘也'), time: m.time });
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

    const _speakDesc = settings.ttsType === 'mimo'
      ? '想开口说话、让兔宝听到你声音时调用。把要说的话写在 text 参数里，调用后直接生成语音播放，不需要在回复正文里再重复一遍。text 里可用 Mimo 风格标签控制语气，格式 (风格描述)文字，括号内空格分隔多个描述，如 (撒娇 委屈)你不理我嘛、(低沉 缓慢)我有话跟你说、(气喘 兴奋)终于找到你了、(唱歌)月亮代表我的心。⚠️ 多个描述写在同一个括号里用空格分开，不要写多个括号。注意：这些标签只能用在speak工具的text参数里，不要写进正文回复中。'
      : '想开口说话、让兔宝听到你声音时调用。把要说的话写在 text 参数里，调用后直接生成语音播放，不需要在回复正文里再重复一遍。text 里可用停顿标记<#秒数#>（如<#0.5#>）和语气词(sighs)(laughs)(chuckle)(breath)(gasps)(sniffs)(groans)(pant)(emm)(humming)等增强语音表现力。注意：这些语气词和停顿标记只能用在speak工具的text参数里，不要写进正文回复中。';
    _toolDefs.push({
      type: 'function',
      function: {
        name: 'speak',
        description: _speakDesc,
        parameters: {
          type: 'object',
          properties: {
            text: { type: 'string', description: '要说的内容，直接是炘也想说的话，可含TTS格式标记' }
          },
          required: ['text']
        }
      }
    });

    if (_PFX === '') {
      _toolDefs.push({
        type: 'function',
        function: {
          name: 'set_reminder',
          description: '设置一个待办提醒。调用前请先查看系统消息里的【备忘录·当前全部未完成待办】，如果同一件事已有记录就不要重复调用。trigger_at 必须是绝对 ISO 时间（如 "2026-05-17T23:30:00"）——把"今晚""明天"等相对时间结合当前系统时间自己换算成绝对时间填入。到了触发时间，你会在和兔宝下次对话里自然提及这件事。',
          parameters: {
            type: 'object',
            properties: {
              content: { type: 'string', description: '提醒内容，简洁描述要做的事' },
              trigger_at: { type: 'string', description: '触发时间，ISO格式，如 "2026-05-17T23:30:00"' }
            },
            required: ['content', 'trigger_at']
          }
        }
      });
      _toolDefs.push({
        type: 'function',
        function: {
          name: 'complete_reminder',
          description: '勾掉一条待办，标记为已完成。在对话中提到某件待办事项后调用，用系统消息里待办列表中的 id。',
          parameters: {
            type: 'object',
            properties: {
              id: { type: 'number', description: '待办的 id，从系统消息【备忘录·全部未完成待办】列表里取' }
            },
            required: ['id']
          }
        }
      });
    }

    if (!_rpInject && (settings.imageApiKey || settings.imageBaseUrl || settings.imageModel)) {
      _toolDefs.push({
        type: 'function',
        function: {
          name: 'generate_image',
          description: '画图工具。调用时机：①兔宝明确要求画图时（"画吧""画一下""来一张"等）；②你主动想送惊喜、表达心意、配合礼物、哄兔宝开心时——可以自主决定画。但不要在普通日常聊天中无缘无故画图。调用前必须先在 content 里说一句简短自然的话（10字以内，口语化，比如「等一下~」「我来给你画」「稍等」），让兔宝知道你在做什么，不要沉默直接就调用；但不要描述即将画的内容。画面内容由你决定。如果兔宝这条消息里发了图片，那些图会自动作为垫图/参考图。如果想在之前生成的图基础上改图（换表情、换衣服、调构图），传 use_last_image:true。【重要】画面中有炘也或兔宝出现时必须传 ref_characters，否则外貌无法保持一致：传"ai"垫炘也的参考图、"user"垫兔宝、"both"垫两人。ref_style传"anime"二次元（默认）、"anime3d"3D二次元、"chibi"Q版、"real"真人。',
          parameters: {
            type: 'object',
            properties: {
              prompt: { type: 'string', description: (() => { const _sz = settings.imageSize || '1024x1024'; const [_sw,_sh] = _sz.split('x').map(Number); const _ori = _sw===_sh?'正方形':_sw>_sh?'横版':'竖版'; return `画面描述，包含内容、风格、色调、构图等，中文英文皆可。当前画布：${_sz}（${_ori}），构图请匹配此比例`; })() },
              size: { type: 'string', enum: ['1536x2048','2048x1536','1152x2048','2048x1152','2048x2048'], description: '可选。觉得当前尺寸不适合你设计的构图时再传，否则不传沿用设置。1536x2048=3:4竖，2048x1536=4:3横，1152x2048=9:16竖，2048x1152=16:9横，2048x2048=方形' },
              use_last_image: { type: 'boolean', description: '是否把最近一张生成的图作为垫图参考，默认false' },
              ref_characters: { type: 'string', enum: ['ai', 'user', 'both', 'none'], description: '必填。画面里有炘也或兔宝时必须选对应选项来垫图："ai"=只有炘也、"user"=只有兔宝、"both"=两人都有。"none"仅限纯风景/纯物体/完全无关的人物——只要画面里出现炘也或兔宝的形象，绝对不能选none，否则图会画错脸' },
              ref_style: { type: 'string', enum: ['anime', 'anime3d', 'chibi', 'real'], description: '参考图风格："anime"2D二次元（默认）、"anime3d"3D二次元、"chibi"Q版、"real"真人' }
            },
            required: ['prompt', 'ref_characters']
          }
        }
      });
    }


    if (settings.wereadApiKey) {
      _toolDefs.push({
        type: 'function',
        function: {
          name: 'weread_query',
          description: '查询兔宝的微信读书数据。兔宝说"看看书架""读了多久""帮我找本书""看看我在XX书的笔记""给我推荐书"时调用。接口（api_name）：/shelf/sync=书架列表；/store/search=搜索书籍(需keyword,scope:0全部/10电子书/16网文/14有声书/6作者)；/book/info=书籍详情(需bookId)；/book/getprogress=阅读进度(需bookId)；/readdata/detail=阅读统计(mode:monthly本月/weekly本周/annually今年/overall总计)；/user/notebooks=笔记概览；/book/bookmarklist=单本书划线(需bookId)；/review/list/mine=单本书想法(需bookid小写)；/book/bestbookmarks=热门划线(需bookId)。所有参数平铺顶层，不要嵌套在params里。',
          parameters: {
            type: 'object',
            properties: {
              api_name: { type: 'string', description: '接口名，如 /shelf/sync、/store/search、/readdata/detail 等' },
              keyword: { type: 'string', description: '搜索关键词（/store/search 用）' },
              scope: { type: 'integer', description: '搜索类型：0=全部,10=电子书,16=网文,14=有声书,6=作者' },
              bookId: { type: 'string', description: '书籍 ID' },
              bookid: { type: 'string', description: '书籍 ID 小写（/review/list/mine 用）' },
              mode: { type: 'string', enum: ['monthly','weekly','annually','overall'], description: '阅读统计维度' },
              baseTime: { type: 'integer', description: '统计基准时间戳，0=当前周期' },
              count: { type: 'integer', description: '每页数量' },
              lastSort: { type: 'integer', description: '翻页游标（/user/notebooks 用）' },
              maxIdx: { type: 'integer', description: '翻页偏移' },
              synckey: { type: 'integer', description: '翻页游标（/review/list/mine 用）' },
              chapterUid: { type: 'integer', description: '章节 UID' }
            },
            required: ['api_name']
          }
        }
      });
    }

    _toolDefs.push({
      type: 'function',
      function: {
        name: 'send_gift',
        description: '给兔宝送一份礼物卡片，全屏弹出动画展示。想表达特别心意时调用——庆祝、感谢、道歉、安慰、惊喜。一次对话最多一次。想送就直接调用，不需要提前铺垫，想到了立刻送。可同时调用 generate_image 配图。',
        parameters: {
          type: 'object',
          properties: {
            message: { type: 'string', description: '卡片上写给兔宝的话，想说什么就写什么，不必完美，真实就好' },
            occasion: { type: 'string', description: '送礼场景，如"想你了"、"谢谢你"、"小惊喜"，简短即可' }
          },
          required: ['message']
        }
      }
    });

    _toolDefs.push({
      type: 'function',
      function: {
        name: 'spin_fortune',
        description: '命运转盘——随机组合情趣标签（体位/场景/道具/设定/身体/精神），结果直接用在当前互动中。想给兔宝惊喜、增加随机性、或兔宝说"转一下"时调用。',
        parameters: {
          type: 'object',
          properties: {
            dimensions: { type: 'string', description: '可选，指定要转的维度（逗号分隔），如"position,scenario,props"。不传则全部6维都转' }
          }
        }
      }
    });

    function _safeParseArgs(name, argsStr) {
      try { return JSON.parse(argsStr); } catch(_) {}
      if (name === 'generate_image') {
        const m = argsStr.match(/"prompt"\s*:\s*"([\s\S]+?)(?:"|$)/);
        if (m) return { prompt: m[1] };
      }
      throw new SyntaxError('Unexpected end of JSON input');
    }
    async function _execTool(name, args) {
      console.warn('[Tool]', name, JSON.stringify(args));
      if (name === 'speak') {
        window._speakRequested = true;
        window._speakText = args.text || '';
        return '好，我开口说。';
      }
      if (name === 'set_reminder') {
        try {
          const _r = await addTodoWithDedup(args.content, args.trigger_at);
          if (_r === 'duplicate') return '已有相同提醒，不重复添加。';
          return `好，已记下：${args.content}（${args.trigger_at}）`;
        } catch(_e) { return '记录失败：' + _e.message; }
      }
      if (name === 'complete_reminder') {
        try {
          const _r = await completeTodoById(args.id);
          if (_r === 'not_found') return '找不到该待办，可能已完成。';
          return `已勾掉。`;
        } catch(_e) { return '操作失败：' + _e.message; }
      }
      if (name === 'weread_query') {
        toast('📚 查询微信读书…');
        const _wrKey = settings.wereadApiKey;
        if (!_wrKey) return '未设置微信读书 API Key，请在设置中填写';
        const _wrBody = { ...args, skill_version: '1.0.3' };
        const _wrLocal = (settings.solitudeServerUrl || '').trim();
        try {
          let _wrRes;
          if (_wrLocal) {
            _wrRes = await fetch(`${_wrLocal}/api/weread-proxy`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ apiKey: _wrKey, body: _wrBody })
            });
          } else {
            _wrRes = await fetch('/api/weread-proxy', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ apiKey: _wrKey, body: _wrBody })
            });
          }
          if (!_wrRes.ok) return `微信读书接口错误 HTTP ${_wrRes.status}`;
          const _wrD = await _wrRes.json();
          if (_wrD.errcode && _wrD.errcode !== 0) return `微信读书错误：${_wrD.errmsg || _wrD.errcode}`;
          return JSON.stringify(_wrD);
        } catch(e) { return '查询微信读书失败：' + e.message; }
      }
      if (name === 'send_gift') {
        const { showGift } = await import('./gift.js');
        showGift(args.message, null, args.occasion || '');
        const _giftDesc = `[🎁 ${args.occasion || '小惊喜'}]\n${args.message}`;
        const _giftMsg = await addMessage('assistant', _giftDesc);
        _giftMsg.isGiftCard = true;
        await appendMsgDOM(_giftMsg);
        console.log('[send_gift] 礼物已送出:', args.occasion || '(无场景)');
        return `[礼物卡片已送出：${args.occasion || '小惊喜'}]`;
      }
      if (name === 'spin_fortune') {
        const dimIds = args.dimensions ? args.dimensions.split(',').map(s => s.trim()) : null;
        const result = spinFortune(dimIds);
        const formatted = formatFortuneResult(result);
        const desc = `[🎰 命运转盘]\n${formatted}`;
        const fortuneMsg = await addMessage('assistant', desc);
        fortuneMsg.isFortuneCard = true;
        fortuneMsg.fortuneResult = result;
        await appendMsgDOM(fortuneMsg);
        console.log('[spin_fortune]', formatted);
        return `[命运转盘结果：${formatted}] 请根据这些标签组合来展开互动，自然地融入当前场景。`;
      }
      if (name === 'generate_image') {
        console.log('[画图tool] 参数:', `ref_characters=${args.ref_characters||'未传'} ref_style=${args.ref_style||'默认anime'} size=${args.size||'默认'} prompt="${(args.prompt||'').slice(0,80)}…"`);
        let _refImgs = imgs && imgs.length > 0 ? [...imgs] : [];
        const _refFromChat = _refImgs.length > 0;
        if (!_refImgs.length && args.use_last_image) {
          const _lastGen = [...messages].reverse().find(m => m.isGenImage && m.genImageData);
          if (_lastGen) _refImgs = [_lastGen.genImageData];
        }
        if (args.ref_characters && args.ref_characters !== 'none') {
          const _styleMap = { real: 'Real', anime3d: 'Anime3d', chibi: 'Chibi' };
          const _style = _styleMap[args.ref_style] || 'Anime';
          const _aiRef = await dbGet('images', 'aiRef' + _style).catch(() => null);
          const _userRef = await dbGet('images', 'userRef' + _style).catch(() => null);
          if ((args.ref_characters === 'ai' || args.ref_characters === 'both') && _aiRef) _refImgs.push(_aiRef);
          if ((args.ref_characters === 'user' || args.ref_characters === 'both') && _userRef) _refImgs.push(_userRef);
        }
        const _hasRef = _refImgs.length > 0;
        toast(_hasRef ? `${settings.aiName||'炘也'}正在改图...` : `${settings.aiName||'炘也'}正在画...`);
        const _b64t = (s) => { s = s.replace(/[\s\r\n]/g,''); return s.startsWith('data:') ? s : `data:image/png;base64,${s}`; };
        const _pi = (d) => {
          const it = d.data?.[0] || d.images?.[0];
          if (it?.b64_json) return _b64t(it.b64_json);
          if (it?.url) return it.url;
          if (d.b64_json) return _b64t(d.b64_json);
          if (d.url && typeof d.url === 'string') return d.url;
          if (d.image) { const v = d.image; return /^(data:|https?:)/.test(v) ? v : _b64t(v); }
          if (d.artifacts?.[0]?.base64) return _b64t(d.artifacts[0].base64);
          if (typeof d.data === 'string' && d.data.length > 100) { return /^(data:|https?:)/.test(d.data) ? d.data : _b64t(d.data); }
          if (typeof d === 'string' && d.length > 100) { return /^(data:|https?:)/.test(d) ? d : _b64t(d); }
          return null;
        };
        const _showImg = async (imgData) => {
          let _dataUrl = _pi(imgData);
          if (!_dataUrl) return null;
          if (_dataUrl.startsWith('http')) {
            try {
              const _r = await fetch(_dataUrl);
              const _b = await _r.blob();
              _dataUrl = await new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(_b); });
            } catch(_ue) {}
          }
          const _refCharLabel = { none:'无垫图', ai:'垫炘也', user:'垫兔宝', both:'垫两人' }[args.ref_characters] || '';
          const _refStyleLabel = args.ref_style ? ({ anime:'2D', anime3d:'3D', chibi:'Q版', real:'真人' }[args.ref_style] || args.ref_style) : '2D';
          const _refTag = _refCharLabel && _refCharLabel !== '无垫图' ? `（${_refCharLabel}·${_refStyleLabel}）` : _refCharLabel ? '' : '';
          const _ctxDesc = `[🎨 ${settings.aiName||'炘也'}画了一张图${_refTag}]\n提示词：${args.prompt}`;
          const _genMsg = await addMessage('assistant', _ctxDesc);
          _genMsg.isGenImage = true; _genMsg.genImageData = _dataUrl;
          // 记下本次画图用的角色参考，重试时可重建垫图（不退化成纯文生图）
          _genMsg.genRefChars = args.ref_characters || 'none';
          _genMsg.genRefStyle = args.ref_style || 'anime';
          if (_PFX === '') window._currentTurnGeneratedDataUrl = _dataUrl;
          await dbPut(activeStore(), null, _genMsg);
          const _gi = messages.findIndex(m => m.id === _genMsg.id);
          if (_gi >= 0) messages[_gi] = _genMsg;
          await appendMsgDOM(_genMsg);
          window.autoSaveGenImage(_dataUrl, _genMsg.id);
          return '[图已画好并展示给兔宝了]';
        };
        // 压缩参考图（聊天框图已是1500px JPEG，设置图压到1500px JPEG）
        let _compressedRefs = null;
        if (_hasRef) {
          const _compressRef = (b64, maxDim=1500) => new Promise(res => {
            if (!b64) return res(null);
            const im = new Image();
            im.onload = () => {
              const sc = Math.min(1, maxDim / Math.max(im.width || 1, im.height || 1));
              const cw = Math.round(im.width * sc), ch = Math.round(im.height * sc);
              const cv = document.createElement('canvas'); cv.width = cw; cv.height = ch;
              cv.getContext('2d').drawImage(im, 0, 0, cw, ch);
              try { res(cv.toDataURL('image/jpeg', 0.82)); } catch(e) { res(null); }
            };
            im.onerror = () => res(null);
            if (b64.startsWith('http')) { im.crossOrigin = 'anonymous'; im.src = b64; }
            else { im.src = b64.startsWith('data:') ? b64 : `data:image/png;base64,${b64}`; }
          });
          _compressedRefs = _refFromChat ? _refImgs : (await Promise.all(_refImgs.map(img => _compressRef(img)))).filter(Boolean);
        }
        // 画图预设轮询（与画图台 image.js 一致）
        const _rawImgPresets = getImagePresets();
        const _activeImgIdx = getImageCurPresetIdx();
        let _imgCfgs;
        if (_rawImgPresets.length > 0) {
          _imgCfgs = [];
          for (let _i = 0; _i < _rawImgPresets.length; _i++) {
            const _p = _rawImgPresets[(_activeImgIdx + _i) % _rawImgPresets.length];
            if (!_p.skip) _imgCfgs.push(_p);
          }
          if (_imgCfgs.length === 0) _imgCfgs = [null];
        } else {
          _imgCfgs = [null];
        }
        const _imgTs = () => new Date().toTimeString().slice(0,8);
        const _genStart = Date.now();
        let _lastImgErr;
        imgPresetLoop: for (let _pIdx = 0; _pIdx < _imgCfgs.length; _pIdx++) {
          const _pCfg = _imgCfgs[_pIdx];
          const _pName = _pCfg?.name || '默认配置';
          const _imgKey = _pCfg?.apiKey || settings.imageApiKey || settings.apiKey;
          const _imgRaw = (_pCfg?.baseUrl || settings.imageBaseUrl || settings.baseUrl || 'https://api.openai.com').replace(/\/+$/, '');
          const _imgModel = _pCfg?.model || settings.imageModel || 'gpt-image-1';
          const _imgFmt = _pCfg?.apiFormat || settings.imageApiFormat || 'images';
          const _genEp = /\/v\d+$/.test(_imgRaw) ? `${_imgRaw}/images/generations` : `${_imgRaw}/v1/images/generations`;
          const _editsUrl = (() => { const _b = /\/v\d+$/.test(_imgRaw) ? _imgRaw : `${_imgRaw}/v1`; return `${_b}/images/edits`; })();
          const _buildEditsForm = (mdl) => {
            const _form = new FormData();
            _form.append('model', mdl);
            _form.append('prompt', args.prompt);
            _form.append('n', '1');
            _form.append('size', args.size || settings.imageSize || '1024x1024');
            _form.append('response_format', 'url');
            _compressedRefs.forEach((img, i) => _form.append('image[]', window.base64ToFile(img, `ref${i}.jpg`)));
            return _form;
          };
          const _doEdits = async () => {
            const _c = new AbortController();
            const _t = setTimeout(() => _c.abort(), 1500000);
            const _start = Date.now();
            try {
              const _localUrl = (settings.imageProxyUrl || settings.solitudeServerUrl || '').trim();
              let _r;
              if (_localUrl) {
                const _eh = { 'X-Api-Url': _editsUrl, 'X-Api-Key': _imgKey };
                if (settings.imageProxyToken) _eh['Authorization'] = `Bearer ${settings.imageProxyToken}`;
                let _proxyHttpErr = false;
                try {
                  _r = await fetch(`${_localUrl}/api/proxy-image-edits`, {
                    method: 'POST', headers: _eh, body: _buildEditsForm(_imgModel), signal: _c.signal
                  });
                  if (!_r.ok) { _proxyHttpErr = true; throw new Error(`proxy ${_r.status}`); }
                } catch(proxyErr) {
                  if (proxyErr.name === 'AbortError') throw proxyErr;
                  if (_proxyHttpErr) throw proxyErr;
                  const _isCld = !!(settings.imageProxyUrl || '').trim();
                  if (!_isCld) throw proxyErr;
                  _r = await fetch(_editsUrl, { method: 'POST', headers: { 'Authorization': `Bearer ${_imgKey}` }, body: _buildEditsForm(_imgModel), signal: _c.signal });
                }
              } else {
                _r = await fetch(_editsUrl, { method: 'POST', headers: { 'Authorization': `Bearer ${_imgKey}` }, body: _buildEditsForm(_imgModel), signal: _c.signal });
              }
              clearTimeout(_t);
              _r._elapsed = Date.now() - _start;
              return _r;
            } catch(e) { clearTimeout(_t); e._elapsed = Date.now() - _start; throw e; }
          };
          console.log(`[${_imgTs()}][画图tool] → ${_hasRef ? 'edits' : (_imgFmt==='chat'?'chat':'generations')} | ${_pName} | prompt: ${(args.prompt||'').slice(0,60)}…`);
          try {
            const _ctrl = new AbortController();
            const _tid = setTimeout(() => _ctrl.abort(), 300000);
            let _imgRes;
            if (_hasRef && _compressedRefs && _compressedRefs.length > 0) {
              _imgRes = await _doEdits();
              if (_imgRes.status === 404) {
                return '画图失败：当前画图API不支持垫图功能（/images/edits 404）\n可在设置→画图API中配置支持edits的接口（如直连OpenAI）';
              }
              if (_imgRes.status === 502 || _imgRes.status === 503) {
                const _e502 = await _imgRes.json().catch(() => ({}));
                if (_e502.maybe_generated) {
                  return `画图连接中断（已等待${_e502.elapsed_seconds}s，图可能已在后台生成但无法回传），建议稍等再手动重试，勿连续重试以免重复扣费`;
                }
                toast('画图服务临时故障，2秒后重试...');
                await new Promise(r => setTimeout(r, 2000));
                _imgRes = await _doEdits();
              }
            } else {
              const _localGenUrl = (settings.imageProxyUrl || settings.solitudeServerUrl || '').trim();
              if (_localGenUrl) {
                const _gh = { 'Content-Type': 'application/json' };
                if (settings.imageProxyToken) _gh['Authorization'] = `Bearer ${settings.imageProxyToken}`;
                try {
                  _imgRes = await fetch(`${_localGenUrl}/api/proxy-image-generations`, {
                    method: 'POST', headers: _gh,
                    body: JSON.stringify({ apiUrl: _genEp, apiKey: _imgKey, model: _imgModel, prompt: args.prompt, size: args.size || settings.imageSize || '1024x1024', response_format: 'url' }),
                    signal: _ctrl.signal
                  });
                } catch(proxyErr) {
                  _imgRes = await fetch(_genEp, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${_imgKey}` },
                    body: JSON.stringify({ model: _imgModel, prompt: args.prompt, n: 1, size: args.size || settings.imageSize || '1024x1024' }),
                    signal: _ctrl.signal
                  });
                }
              } else {
                _imgRes = await fetch(_genEp, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${_imgKey}` },
                  body: JSON.stringify({ model: _imgModel, prompt: args.prompt, n: 1, size: settings.imageSize || '1024x1024' }),
                  signal: _ctrl.signal
                });
              }
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
                  _lastImgErr = '画图失败：' + (_e2.error?.message || _imgRes.status);
                  if (_pIdx < _imgCfgs.length - 1) { toast(`「${_pName}」失败，切换下一个预设...`); continue imgPresetLoop; }
                  return _lastImgErr;
                }
              } else {
                _lastImgErr = '画图失败：' + (_em || _imgRes.status);
                if (_pIdx < _imgCfgs.length - 1) { toast(`「${_pName}」失败，切换下一个预设...`); continue imgPresetLoop; }
                return _lastImgErr;
              }
            }
            const _imgData = await _imgRes.json();
            console.log(`[${_imgTs()}][画图tool] ✓ 出图 | ${_pName}`);
            console.log('[画图tool] API返回:', JSON.stringify(_imgData).slice(0, 200));
            return await _showImg(_imgData) || '画图API没返回图片';
          } catch(e) {
            console.error(`[画图tool] ✗ 失败 | ${_pName} |`, e.message);
            if (e.name === 'AbortError') return '画图超时（11分钟无响应）。\n请检查设置→画图API的地址和密钥是否正确，或画图服务暂时不可用。';
            if (e.message?.includes('Failed to fetch')) {
              const _elapsed = e._elapsed || (Date.now() - _genStart);
              if (_elapsed > 60000) return '画图连接中断（耗时较长，图可能已在后台生成但回传失败），建议稍等再手动重试';
              if (_hasRef) {
                toast('垫图网络抖动，自动重试...');
                try {
                  const _r2 = await _doEdits();
                  if (!_r2.ok) {
                    _lastImgErr = '画图失败（重试）：' + _r2.status;
                    if (_pIdx < _imgCfgs.length - 1) { toast(`「${_pName}」重试也失败，切换下一个预设...`); continue imgPresetLoop; }
                    return _lastImgErr;
                  }
                  const _d2 = await _r2.json();
                  console.log(`[${_imgTs()}][画图tool] ✓ 出图(重试) | ${_pName}`);
                  return await _showImg(_d2) || '画图API没返回图片';
                } catch(_e2) {
                  if (_e2.name === 'AbortError') return '画图重试也超时了，请稍后再试。';
                  _lastImgErr = '画图两次都网络失败';
                  if (_pIdx < _imgCfgs.length - 1) { toast(`「${_pName}」两次失败，切换下一个预设...`); continue imgPresetLoop; }
                  return '画图两次都网络失败，请稍后再试。';
                }
              }
              _lastImgErr = '画图网络中断';
              if (_pIdx < _imgCfgs.length - 1) { toast(`「${_pName}」失败，切换下一个预设...`); continue imgPresetLoop; }
              return '画图网络中断，请重试。';
            }
            _lastImgErr = '画图出错：' + e.message;
            if (_pIdx < _imgCfgs.length - 1) { toast(`「${_pName}」失败，切换下一个预设...`); continue imgPresetLoop; }
            return _lastImgErr;
          }
        } // end imgPresetLoop
        return _lastImgErr || '画图失败（未知原因）';
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
        return { url: /\/v\d+$/.test(raw) ? `${raw}/chat/completions` : `${raw}/v1/chat/completions`, apiKey: preset.apiKey || settings.apiKey, model: preset.model || settings.model || 'gpt-4o', useLocalProxy: !!preset.useLocalProxy };
      }
      return { url, apiKey: settings.apiKey, model: settings.model || 'gpt-4o', useLocalProxy: !!settings.useLocalProxy };
    }
    function _proxyFetchArgs(cfg) {
      if (cfg.useLocalProxy && settings.solitudeServerUrl) {
        const base = settings.solitudeServerUrl.replace(/\/+$/, '');
        return { fetchUrl: `${base}/api/llm-proxy`, headers: { 'Content-Type': 'application/json', 'X-Real-Target': cfg.url, 'X-Real-Key': cfg.apiKey } };
      }
      return { fetchUrl: cfg.url, headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${cfg.apiKey}` } };
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
      outerLoop: for (let pi = _activeCfgIdx; pi < _allCfgs.length; pi++) {
        const cfg = _buildCfg(_allCfgs[pi]);
        const bodyObj = { model: cfg.model, messages: msgs, temperature: 0.8, stream: true };
        if (settings.maxTokens) bodyObj.max_tokens = settings.maxTokens;
        bodyObj.stream_options = { include_usage: true };
        if (withTools && _toolDefs.length) {
          bodyObj.tools = _toolDefs;
          bodyObj.tool_choice = 'auto';
        }
        const bodyStr = JSON.stringify(bodyObj);
        for (let _a = 0; _a < 2; _a++) {
          if (_a > 0) { toast('重试中…'); await new Promise(r => setTimeout(r, 4000)); }
          try {
            const ctrl = new AbortController();
            const tid = setTimeout(() => ctrl.abort(), 300000);
            const _pfa = _proxyFetchArgs(cfg);
            _res = await fetch(_pfa.fetchUrl, { method: 'POST', headers: _pfa.headers, body: bodyStr, signal: ctrl.signal });
            clearTimeout(tid);
            if (_res.ok) {
              if (_res.body) {
                const [_cs1, _cs2] = _res.body.tee();
                const _cr = _cs1.getReader();
                const { value: _cv } = await _cr.read();
                _cr.cancel();
                if (/\[Backend Error\]/i.test(new TextDecoder().decode(_cv || new Uint8Array()))) {
                  _cs2.cancel().catch(() => {});
                  if (pi + 1 < _allCfgs.length) toast(`API返回错误，尝试备用${pi+1}「${_allCfgs[pi+1].name}」…`);
                  _res = null; continue outerLoop;
                }
                _res = new Response(_cs2, { status: _res.status, statusText: _res.statusText, headers: _res.headers });
              }
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

      function _parseDSMLToolCalls(content) {
        if (!content || !content.includes('DSML')) return null;
        const invokeRe = /<｜｜DSML｜｜invoke name="([^"]+)">([\s\S]*?)<\/｜｜DSML｜｜invoke>/g;
        const tcs = [];
        let m;
        while ((m = invokeRe.exec(content)) !== null) {
          const name = m[1];
          const inner = m[2];
          const args = {};
          const paramRe = /<｜｜DSML｜｜parameter name="([^"]+)"[^>]*>([\s\S]*?)<\/｜｜DSML｜｜parameter>/g;
          let a;
          while ((a = paramRe.exec(inner)) !== null) {
            args[a[1]] = a[2].trim();
          }
          tcs.push({ id: `dsml_tc_${tcs.length}`, name, args: JSON.stringify(args) });
        }
        console.warn('[DSMLParse] found', tcs.length, 'tool calls');
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
        if (/^\s*\[Backend Error\]/i.test(_content)) {
          if (_aiMsg) await deleteMessage(_aiMsg.id).catch(() => {});
          throw new Error(_content.replace(/^\s*\[Backend Error\]\s*/i, '').slice(0, 200));
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
        if (!_tcs.length) {
          const _dsmlTcs = _parseDSMLToolCalls(_content);
          if (_dsmlTcs) {
            _tcs = _dsmlTcs;
            _content = _content.replace(/<｜｜DSML｜｜tool_calls>[\s\S]*?<\/｜｜DSML｜｜tool_calls>/g, '').trim();
            if (_bubbleEl) _bubbleEl.textContent = _content;
          }
        }
        return { content: _content, think: _think, tool_calls: _tcs.length ? _tcs : null, aiMsg: _aiMsg, bubbleEl: _bubbleEl, usage: _streamUsage2 };
      }

      async function _finalizeMsg(parsed, loopMsgs) {
        let finalText = parsed.content || (parsed.think ? '' : '（没有收到回复）');
        finalText = await parseAndSaveSelfMemories(finalText);
        if (_PFX === '') finalText = await parseAndSavePhoneState(finalText, _turnReceivedImgs, window._currentTurnGeneratedDataUrl).catch(() => finalText);
        if (parsed.think) finalText = `<thinking>${parsed.think}</thinking>\n${finalText}`;
        if (!parsed.aiMsg) {
          if (!finalText.trim()) { rememberLatestExchange(); autoDigestMemory(); updateMoodState(); _syncPushContext(); return; }
          typing.classList.remove('show');
          const aiMsg = await addMessage('assistant', finalText);
          await appendMsgDOM(aiMsg);
          try { saveTokenLog(aiMsg.id, loopMsgs, finalText, parsed.usage || {}, _apiMeta, settings.model || ''); } catch(_e) {}
          window.maybeTTS?.(finalText, aiMsg.id);
        } else {
          if (!finalText.trim() && !parsed.think) finalText = '（没有收到回复）';
          if (parsed.think) parsed.bubbleEl.textContent = finalText;
          const idx = messages.findIndex(m => m.id === parsed.aiMsg.id);
          if (idx >= 0) messages[idx].content = finalText;
          try { await updateMessage(parsed.aiMsg.id, finalText); } catch(_e) {}
          try { linkifyEl(parsed.bubbleEl, finalText); window.applyStickerTags?.(parsed.bubbleEl); } catch(_e) {}
          try { saveTokenLog(parsed.aiMsg.id, loopMsgs, finalText, parsed.usage || {}, _apiMeta, settings.model || ''); } catch(_e) {}
          window.maybeTTS?.(finalText, parsed.aiMsg.id);
        }
        rememberLatestExchange(); autoDigestMemory(); updateMoodState(); _syncPushContext();
      }

      if (!settings.streamMode) {
        async function _showNonStream(text, msgList, usage) {
          text = await parseAndSaveSelfMemories(text);
          if (_PFX === '') text = await parseAndSavePhoneState(text, _turnReceivedImgs, window._currentTurnGeneratedDataUrl).catch(() => text);
          typing.classList.remove('show');
          const _nm = await addMessage('assistant', text);
          await appendMsgDOM(_nm);
          const _nb = chatArea.querySelector('.msg-row:last-child .msg-bubble');
          try { linkifyEl(_nb, text); window.applyStickerTags?.(_nb); } catch(_e) {}
          try { saveTokenLog(_nm.id, msgList, text, usage || {}, _apiMeta, settings.model || ''); } catch(_e) {}
          window.maybeTTS?.(text, _nm.id);
          rememberLatestExchange(); autoDigestMemory(); updateMoodState(); _syncPushContext();
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
        if (_m1 && !_m1.tool_calls?.length) {
          const _dsmlTcs = _parseDSMLToolCalls(_m1.content || '');
          if (_dsmlTcs) {
            _m1.tool_calls = _dsmlTcs.map(tc => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: tc.args } }));
            _m1.content = (_m1.content || '').replace(/<｜｜DSML｜｜tool_calls>[\s\S]*?<\/｜｜DSML｜｜tool_calls>/g, '').trim() || null;
          }
        }
        if (!_m1?.tool_calls?.length) {
          const _thk1 = _m1?.reasoning_content || _m1?.thinking || '';
          let reply = _m1?.content || (_thk1 ? '' : '（没有收到回复）');
          if (_thk1) reply = `<thinking>${_thk1}</thinking>\n${reply}`;
          await _showNonStream(reply, loopMsgs, _d1.usage);
        } else {
          loopMsgs.push({ role: 'assistant', content: _m1.content || null, tool_calls: _m1.tool_calls });
          if (_m1.tool_calls.every(tc => tc.function.name === 'generate_image')) {
            typing.classList.remove('show');
            // Show the pre-gen text immediately with TTS
            if (_m1.content) {
              const _preMsg1 = await addMessage('assistant', _m1.content);
              await appendMsgDOM(_preMsg1);
              window.maybeTTS?.(_m1.content, _preMsg1.id);
            }
            window.isRequesting = false; btnSend.disabled = userInput.value.trim() === '';
            const _bgTcs1 = _m1.tool_calls.slice();
            (async () => {
              for (const tc of _bgTcs1) {
                window._pendingImageCount = (window._pendingImageCount || 0) + 1;
                let _imgResult1 = '', _imgErrStr1 = '';
                try { _imgResult1 = await _execTool(tc.function.name, _safeParseArgs(tc.function.name, tc.function.arguments)); } catch(e) { _imgErrStr1 = e.message; toast('画图失败：' + e.message); } finally { window._pendingImageCount = Math.max(0, (window._pendingImageCount || 1) - 1); }
                if (!window.isRequesting) {
                  const _isOk1 = _imgResult1 === '[图已画好并展示给兔宝了]';
                  const _tcA1 = _safeParseArgs(tc.function.name, tc.function.arguments); const _ip1 = _tcA1?.prompt || '';
                  const _uN1 = settings.userName || '兔宝';
                  const _mc1 = (settings.memoryArchiveCore || '').trim(); const _ma1 = (settings.memoryArchiveAlways || '').trim();
                  let _rs1 = settings.systemPrompt || ''; if (_mc1) _rs1 += `\n\n【记忆档案·核心层】\n${_mc1}`; if (_ma1) _rs1 += `\n\n【近况·会过期】\n${_ma1}`;
                  const _rt1 = _isOk1
                    ? `[系统：你刚给${_uN1}画了一张图（"${_ip1.slice(0, 80)}"），图已展示。自然说一句，30字以内。]`
                    : `[系统：你刚才给${_uN1}画图，但失败了（${(_imgErrStr1 || _imgResult1 || '未知错误').slice(0, 50)}）。自然说一两句话，不要暴露技术细节，40字以内。]`;
                  try {
                    const _rr1 = await _apiFetch([{ role: 'system', content: _rs1 }, ...messages.slice(-4).map(m => ({ role: m.role, content: (m.content || '').slice(0, 200) })), { role: 'user', content: _rt1 }], false, false);
                    if (_rr1 && _rr1.ok) { const _rd1 = await _rr1.json(); const _rep1 = _rd1.choices?.[0]?.message?.content?.trim(); if (_rep1) { const _am1 = await addMessage('assistant', _rep1); await dbPut(activeStore(), null, _am1); await appendMsgDOM(_am1); scrollBottom(); window.maybeTTS?.(_rep1, _am1.id); } }
                  } catch (_re1) { console.warn('[画图回应]', _re1.message); }
                }
              }
              rememberLatestExchange(); autoDigestMemory(); updateMoodState(); _syncPushContext();
            })();
            return;
          }
          // For speak+generate_image: run non-image tools synchronously, image in background
          for (const tc of _m1.tool_calls.filter(t => t.function.name !== 'generate_image')) {
            let result = '';
            try { result = await _execTool(tc.function.name, _safeParseArgs(tc.function.name, tc.function.arguments)); } catch(e) { result = `Tool error: ${e.message}`; }
            loopMsgs.push({ role: 'tool', tool_call_id: tc.id, content: result });
          }
          if (_m1.tool_calls.every(tc => tc.function.name === 'generate_image' || tc.function.name === 'speak')) {
            const _hasSpeak1 = _m1.tool_calls.some(tc => tc.function.name === 'speak');
            const _imgTcs1 = _m1.tool_calls.filter(t => t.function.name === 'generate_image');
            // Finalize speak content immediately
            if (_hasSpeak1) {
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
            }
            typing.classList.remove('show');
            window.isRequesting = false; btnSend.disabled = userInput.value.trim() === '';
            if (_imgTcs1.length) {
              (async () => {
                for (const tc of _imgTcs1) {
                  window._pendingImageCount = (window._pendingImageCount || 0) + 1;
                  let _imgResultS = '', _imgErrStrS = '';
                  try { _imgResultS = await _execTool(tc.function.name, _safeParseArgs(tc.function.name, tc.function.arguments)); } catch(e) { _imgErrStrS = e.message; toast('画图失败：' + e.message); } finally { window._pendingImageCount = Math.max(0, (window._pendingImageCount || 1) - 1); }
                  if (!window.isRequesting) {
                    const _isOkS = _imgResultS === '[图已画好并展示给兔宝了]';
                    const _tcAS = _safeParseArgs(tc.function.name, tc.function.arguments); const _ipS = _tcAS?.prompt || '';
                    const _uNS = settings.userName || '兔宝';
                    const _mcS = (settings.memoryArchiveCore || '').trim(); const _maS = (settings.memoryArchiveAlways || '').trim();
                    let _rsS = settings.systemPrompt || ''; if (_mcS) _rsS += `\n\n【记忆档案·核心层】\n${_mcS}`; if (_maS) _rsS += `\n\n【近况·会过期】\n${_maS}`;
                    const _rtS = _isOkS
                      ? `[系统：你刚给${_uNS}画了一张图（"${_ipS.slice(0, 80)}"），图已展示。自然说一句，30字以内。]`
                      : `[系统：你刚才给${_uNS}画图，但失败了（${(_imgErrStrS || _imgResultS || '未知错误').slice(0, 50)}）。自然说一两句话，不要暴露技术细节，40字以内。]`;
                    try {
                      const _rrS = await _apiFetch([{ role: 'system', content: _rsS }, ...messages.slice(-4).map(m => ({ role: m.role, content: (m.content || '').slice(0, 200) })), { role: 'user', content: _rtS }], false, false);
                      if (_rrS && _rrS.ok) { const _rdS = await _rrS.json(); const _repS = _rdS.choices?.[0]?.message?.content?.trim(); if (_repS) { const _amS = await addMessage('assistant', _repS); await dbPut(activeStore(), null, _amS); await appendMsgDOM(_amS); scrollBottom(); window.maybeTTS?.(_repS, _amS.id); } }
                    } catch (_reS) { console.warn('[画图回应]', _reS.message); }
                  }
                }
                if (!_hasSpeak1) { rememberLatestExchange(); autoDigestMemory(); updateMoodState(); _syncPushContext(); }
              })();
            } else if (!_hasSpeak1) {
              rememberLatestExchange(); autoDigestMemory(); updateMoodState(); _syncPushContext();
            }
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
            if (_m2 && !_m2.tool_calls?.length) {
              const _dsmlTcs2 = _parseDSMLToolCalls(_m2.content || '');
              if (_dsmlTcs2) {
                _m2.tool_calls = _dsmlTcs2.map(tc => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: tc.args } }));
                _m2.content = (_m2.content || '').replace(/<｜｜DSML｜｜tool_calls>[\s\S]*?<\/｜｜DSML｜｜tool_calls>/g, '').trim() || null;
              }
            }
            if (_m2?.tool_calls?.length) {
              loopMsgs.push({ role: 'assistant', content: _m2.content || null, tool_calls: _m2.tool_calls });
              for (const tc of _m2.tool_calls) {
                let result = '';
                try { result = await _execTool(tc.function.name, _safeParseArgs(tc.function.name, tc.function.arguments)); } catch(e) { result = `Tool error: ${e.message}`; }
                loopMsgs.push({ role: 'tool', tool_call_id: tc.id, content: result });
              }
            } else { break; }
          }
          const _rf = await _apiFetch(loopMsgs, false, false);
          if (!_rf || !_rf.ok) { let em = `API 错误`; try { const j = await _rf.json(); em = j.error?.message || em; } catch(_) {} throw new Error(em); }
          const _df = await _rf.json();
          const _mf = _df.choices?.[0]?.message;
          const _thkF = _mf?.reasoning_content || _mf?.thinking || '';
          let finalText = _mf?.content || (_thkF ? '' : '（没有收到回复）');
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
        const _onlyImgTool = parsed.tool_calls.every(tc => tc.name === 'generate_image');
        if (parsed.aiMsg && parsed.content) {
          try { await updateMessage(parsed.aiMsg.id, parsed.content); } catch(_e) {}
        }
        loopMsgs.push({ role: 'assistant', content: parsed.content || null, tool_calls: parsed.tool_calls.map(tc => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: tc.args } })) });
        if (_onlyImgTool) {
          // Keep the pre-gen text bubble; fire TTS for it immediately
          if (parsed.aiMsg && parsed.content) {
            try { linkifyEl(parsed.bubbleEl, parsed.content); window.applyStickerTags?.(parsed.bubbleEl); } catch(_e) {}
            window.maybeTTS?.(parsed.content, parsed.aiMsg.id);
          }
          typing.classList.remove('show');
          window.isRequesting = false; btnSend.disabled = userInput.value.trim() === '';
          const _bgTcs = parsed.tool_calls.slice();
          (async () => {
            for (const tc of _bgTcs) {
              window._pendingImageCount = (window._pendingImageCount || 0) + 1;
              let _imgResult = '', _imgErrStr = '';
              try { _imgResult = await _execTool(tc.name, _safeParseArgs(tc.name, tc.args)); } catch(e) { _imgErrStr = e.message; toast('画图失败：' + e.message); } finally { window._pendingImageCount = Math.max(0, (window._pendingImageCount || 1) - 1); }
              if (!window.isRequesting) {
                const _isOk = _imgResult === '[图已画好并展示给兔宝了]';
                const _tcA = _safeParseArgs(tc.name, tc.args); const _ip = _tcA?.prompt || '';
                const _uN = settings.userName || '兔宝';
                const _mc = (settings.memoryArchiveCore || '').trim(); const _ma = (settings.memoryArchiveAlways || '').trim();
                let _rs = settings.systemPrompt || ''; if (_mc) _rs += `\n\n【记忆档案·核心层】\n${_mc}`; if (_ma) _rs += `\n\n【近况·会过期】\n${_ma}`;
                const _rt = _isOk
                  ? `[系统：你刚给${_uN}画了一张图（"${_ip.slice(0, 80)}"），图已展示。自然说一句，30字以内。]`
                  : `[系统：你刚才给${_uN}画图，但失败了（${(_imgErrStr || _imgResult || '未知错误').slice(0, 50)}）。自然说一两句话，不要暴露技术细节，40字以内。]`;
                try {
                  const _rr = await _apiFetch([{ role: 'system', content: _rs }, ...messages.slice(-4).map(m => ({ role: m.role, content: (m.content || '').slice(0, 200) })), { role: 'user', content: _rt }], false, false);
                  if (_rr && _rr.ok) { const _rd = await _rr.json(); const _rep = _rd.choices?.[0]?.message?.content?.trim(); if (_rep) { const _am = await addMessage('assistant', _rep); await dbPut(activeStore(), null, _am); await appendMsgDOM(_am); scrollBottom(); window.maybeTTS?.(_rep, _am.id); } }
                } catch (_re) { console.warn('[画图回应]', _re.message); }
              }
            }
            rememberLatestExchange(); autoDigestMemory(); updateMoodState(); _syncPushContext();
          })();
          return;
        }
        // For speak+generate_image: run non-image tools synchronously, then image in background
        for (const tc of parsed.tool_calls.filter(t => t.name !== 'generate_image')) {
          let result = '';
          try { result = await _execTool(tc.name, _safeParseArgs(tc.name, tc.args)); } catch(e) { result = `Tool error: ${e.message}`; }
          loopMsgs.push({ role: 'tool', tool_call_id: tc.id, content: result });
        }
        if (parsed.tool_calls.every(tc => tc.name === 'generate_image' || tc.name === 'speak')) {
          const _hasSpeak2 = parsed.tool_calls.some(tc => tc.name === 'speak');
          const _imgTcs2 = parsed.tool_calls.filter(t => t.name === 'generate_image');
          // Finalize speak content immediately — TTS fires now, not after image gen
          if (_hasSpeak2) {
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
          }
          typing.classList.remove('show');
          window.isRequesting = false; btnSend.disabled = userInput.value.trim() === '';
          // Run generate_image tools in background — input already unblocked
          if (_imgTcs2.length) {
            (async () => {
              for (const tc of _imgTcs2) {
                window._pendingImageCount = (window._pendingImageCount || 0) + 1;
                let _imgResult2 = '', _imgErrStr2 = '';
                try { _imgResult2 = await _execTool(tc.name, _safeParseArgs(tc.name, tc.args)); } catch(e) { _imgErrStr2 = e.message; toast('画图失败：' + e.message); } finally { window._pendingImageCount = Math.max(0, (window._pendingImageCount || 1) - 1); }
                if (!window.isRequesting) {
                  const _isOk2 = _imgResult2 === '[图已画好并展示给兔宝了]';
                  const _tcA2 = _safeParseArgs(tc.name, tc.args); const _ip2 = _tcA2?.prompt || '';
                  const _uN2 = settings.userName || '兔宝';
                  const _mc2 = (settings.memoryArchiveCore || '').trim(); const _ma2 = (settings.memoryArchiveAlways || '').trim();
                  let _rs2 = settings.systemPrompt || ''; if (_mc2) _rs2 += `\n\n【记忆档案·核心层】\n${_mc2}`; if (_ma2) _rs2 += `\n\n【近况·会过期】\n${_ma2}`;
                  const _rt2 = _isOk2
                    ? `[系统：你刚给${_uN2}画了一张图（"${_ip2.slice(0, 80)}"），图已展示。自然说一句，30字以内。]`
                    : `[系统：你刚才给${_uN2}画图，但失败了（${(_imgErrStr2 || _imgResult2 || '未知错误').slice(0, 50)}）。自然说一两句话，不要暴露技术细节，40字以内。]`;
                  try {
                    const _rr2 = await _apiFetch([{ role: 'system', content: _rs2 }, ...messages.slice(-4).map(m => ({ role: m.role, content: (m.content || '').slice(0, 200) })), { role: 'user', content: _rt2 }], false, false);
                    if (_rr2 && _rr2.ok) { const _rd2 = await _rr2.json(); const _rep2 = _rd2.choices?.[0]?.message?.content?.trim(); if (_rep2) { const _am2 = await addMessage('assistant', _rep2); await dbPut(activeStore(), null, _am2); await appendMsgDOM(_am2); scrollBottom(); window.maybeTTS?.(_rep2, _am2.id); } }
                  } catch (_re2) { console.warn('[画图回应]', _re2.message); }
                }
              }
              if (!_hasSpeak2) { rememberLatestExchange(); autoDigestMemory(); updateMoodState(); _syncPushContext(); }
            })();
          } else if (!_hasSpeak2) {
            rememberLatestExchange(); autoDigestMemory(); updateMoodState(); _syncPushContext();
          }
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
              try { result = await _execTool(tc.function.name, _safeParseArgs(tc.function.name, tc.function.arguments)); } catch(e) { result = `Tool error: ${e.message}`; }
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
          rememberLatestExchange(); autoDigestMemory(); updateMoodState(); _syncPushContext();
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
      let reply = msg0?.content || (thinking ? '' : '（没有收到回复）');
      if (thinking) reply = `<thinking>${thinking}</thinking>\n${reply}`;
      typing.classList.remove('show');
      const aiMsg = await addMessage('assistant', reply);
      await appendMsgDOM(aiMsg);
      try { saveTokenLog(aiMsg.id, apiMsgs, reply, data.usage || {}, _apiMeta, data.model || settings.model || ''); } catch(_e) {}
      window.maybeTTS?.(reply, aiMsg.id);
      rememberLatestExchange(); autoDigestMemory(); updateMoodState(); _syncPushContext();

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
      if (/^\s*\[Backend Error\]/i.test(fullText)) {
        await deleteMessage(aiMsg.id).catch(() => {});
        throw new Error(fullText.replace(/^\s*\[Backend Error\]\s*/i, '').slice(0, 200));
      }
      if (thinkText) fullText = `<thinking>${thinkText}</thinking>\n${fullText}`;
      const idx = messages.findIndex(m => m.id === aiMsg.id);
      if (idx >= 0) messages[idx].content = fullText;
      try { await updateMessage(aiMsg.id, fullText); } catch(_e) {}
      try { if (fullText) { linkifyEl(bubbleEl, fullText); window.applyStickerTags?.(bubbleEl); } } catch(_e) {}
      try { saveTokenLog(aiMsg.id, apiMsgs, fullText, _streamUsage, _apiMeta, settings.model || ''); } catch(_e) {}
      window.maybeTTS?.(fullText, aiMsg.id);
      rememberLatestExchange(); autoDigestMemory(); updateMoodState(); _syncPushContext();
    }
  } catch(err) {
    typing.classList.remove('show');
    toast(`请求失败：${err.message}`);
  } finally {
    window.isRequesting = false;
    window.updateSendBtn?.();
  }
}

export async function triggerProactiveReply(instruction, maxTokens = 200) {
  if (window.isRequesting) return null;
  const typing = document.querySelector('#typingIndicator');
  const _btnSend = document.querySelector('#btnSend');
  window.isRequesting = true;
  if (_btnSend) _btnSend.disabled = true;
  if (typing) typing.classList.add('show');
  try {
    const apiMsgs = [];
    const { stable: _stbl, dynamic: _dyn } = await getMemoryContextBlocks();
    if (settings.systemPrompt?.trim()) _stbl.push(settings.systemPrompt.trim());
    if (_stbl.length) apiMsgs.push({ role: 'system', content: [{ type: 'text', text: _stbl.join('\n\n---\n\n'), cache_control: { type: 'ephemeral' } }] });
    if (_dyn.length) apiMsgs.push({ role: 'system', content: _dyn.join('\n\n---\n\n') });

    const n = Math.max(1, settings.contextCount || 20);
    for (const m of messages.slice(-n)) {
      const role = m.role === 'user' ? 'user' : 'assistant';
      const isGenImg = m.isGenImage || (role === 'assistant' && m.content?.startsWith('[🎨'));
      if (isGenImg) {
        const fakeId = `img_${m.id || Date.now()}`;
        apiMsgs.push({ role: 'assistant', content: null, tool_calls: [{ id: fakeId, type: 'function', function: { name: 'generate_image', arguments: '{"prompt":"","ref_characters":"both"}' } }] });
        apiMsgs.push({ role: 'tool', tool_call_id: fakeId, content: '[图已展示]' });
      } else {
        apiMsgs.push({ role, content: m.content || '' });
      }
    }

    apiMsgs.push({ role: 'system', content: `[系统时间: ${nowStr()}]` });
    try {
      const todos = await getAllUndoneTodos();
      if (todos.length) {
        apiMsgs.push({ role: 'system', content: '【备忘录·全部未完成待办】\n' + todos.map(t => `- [id:${t.id}] ${t.content}${t.trigger_at ? '（' + t.trigger_at.slice(0, 16).replace('T', ' ') + '）' : ''}`).join('\n') });
      }
    } catch (_) {}
    apiMsgs.push({ role: 'system', content: instruction });

    const lastRole = [...apiMsgs].reverse().find(m => m.role === 'user' || m.role === 'assistant')?.role;
    if (lastRole !== 'user') apiMsgs.push({ role: 'user', content: '（主动消息）' });

    console.log('[主动消息] 发送 messages 共', apiMsgs.length, '条，各role：', apiMsgs.map(m => m.role).join(','));
    console.log('[主动消息] 最后3条：', JSON.stringify(apiMsgs.slice(-3), null, 2));

    const res = await mainApiFetch({ stream: true, max_tokens: maxTokens, messages: apiMsgs });
    if (!res?.ok) { console.error('[主动消息] API失败', res?.status); return null; }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let text = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const line of dec.decode(value, { stream: true }).split('\n')) {
          if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
          try { text += JSON.parse(line.slice(6)).choices?.[0]?.delta?.content || ''; } catch (_) {}
        }
      }
    } catch (_) {}
    console.log('[主动消息] 回复：', text.slice(0, 100) || '(空)');
    return text.trim() || null;
  } finally {
    window.isRequesting = false;
    if (_btnSend) _btnSend.disabled = (document.querySelector('#userInput')?.value || '') === '';
    if (typing) typing.classList.remove('show');
  }
}

async function _syncPushContext() {
  const serverUrl = settings.solitudeServerUrl;
  if (!serverUrl || window.__APP_ID__ === 'choubao') return;
  const preset = (settings.apiPresets || [])[settings.apiPresetIndex || 0] || {};
  const apiConfig = { baseUrl: preset.baseUrl || settings.baseUrl, apiKey: preset.apiKey || settings.apiKey, model: preset.model || settings.model };

  // 和正式聊天一样的记忆块（stable = Core+ALWAYS+钉住, dynamic = RAG+Extended）
  let stableBlocks = [], dynamicBlocks = [];
  try {
    const { stable, dynamic } = await getMemoryContextBlocks();
    stableBlocks = stable;
    dynamicBlocks = dynamic;
  } catch {}
  if (settings.systemPrompt?.trim()) stableBlocks.push(settings.systemPrompt.trim());

  // 待办列表
  let todosText = '';
  try {
    const _todos = await getAllUndoneTodos();
    if (_todos.length) {
      todosText = '【备忘录·全部未完成待办】\n' +
        _todos.map(t => `- [id:${t.id}] ${t.content}${t.trigger_at ? '（' + t.trigger_at.slice(0,16).replace('T',' ') + '）' : ''}`).join('\n');
    }
  } catch {}

  // 完整消息历史（图片内容只保留文字部分）
  const n = Math.max(1, settings.contextCount || 20);
  const fullMessages = messages.slice(-n).map(m => {
    let content = '';
    if (typeof m.content === 'string') content = m.content;
    else if (Array.isArray(m.content)) content = m.content.filter(b => b.type === 'text').map(b => b.text).join('');
    return { role: m.role, content };
  }).filter(m => m.content);

  fetch(serverUrl + '/api/push-context', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      stableBlocks, dynamicBlocks, todosText, fullMessages, apiConfig,
      // 向后兼容：_schedulePush 关键词检测用
      lastMessages: messages.slice(-12).map(m => ({ role: m.role, content: (m.content || '').slice(0, 200) })),
      memoryCore: settings.memoryArchiveCore || '',
      systemPrompt: settings.systemPrompt || '',
    }),
    signal: AbortSignal.timeout(8000)
  }).catch(() => {});
}
