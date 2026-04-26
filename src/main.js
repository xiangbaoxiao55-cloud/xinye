import { toast, fallbackCopy, escHtml, isDarkMode, fmtTime, fmtFull, nowStr } from './modules/utils.js';
import { db, openDB, dbPut, dbGet, lsBackup, lsRemoveBackup, dbGetAll, dbGetRecent, dbGetRecentFiltered, dbDelete, dbClear, dbGetAllKeys } from './modules/db.js';
import { settings, saveSettings, ensureMemoryState, ensureMemoryBank, normalizeMemoryEntry, createMemoryId, initSaveHook, messages } from './modules/state.js';
import { stripForTTS, _hasTTSMarkers, generateTTSBlob, markCached, playAudioBlob, playTTS, enqueueTTS, showVoiceBar, downloadTTS } from './modules/tts.js';
import { getApiPresets, setApiPresets, getSubApiCfg, mainApiFetch, subApiFetch } from './modules/api.js';
import { stripThinkingTags, getEmbedding, getMemoryContextBlocks, parseAndSaveSelfMemories, updateMoodState, autoDigestMemory, digestMemory, cleanupMemoryBank, saveOneMemoryToBank, rebuildArchiveIndex, renderMemoryBankPreview, renderMemoryEntryChip, renderMemoryViewer, openMemoryViewer, setMemViewerFilter, toggleMemoryPin, toggleMemoryResolved, deleteMemoryEntry, editMemoryEntry, saveMemoryEdit, skipMemoryCursorToEnd, resetMemoryCursor, manualExtractBatch, rememberLatestExchange, testEmbeddingApi, archiveMemoryBank, autoSyncArchiveToLocal, initMemoryDeps, cosineSimilarity } from './modules/memory.js';
// ── 立即暴露inline handler函数到window（函数声明已提升，放这里保证任何后续错误都不影响）──
Object.assign(window, {
  switchTab, openBookmarksPanel,
  openMemoryViewer, renderMemoryViewer, renderMemoryBankPreview,
  setMemViewerFilter, resetMemoryCursor, skipMemoryCursorToEnd,
  rebuildArchiveIndex, manualExtractBatch,
  toggleMemoryPin, toggleMemoryResolved, deleteMemoryEntry, editMemoryEntry, saveMemoryEdit,
  quickNoteOpen, quickNoteClose, quickNoteSave,
  openStickerPanel, closeStickerPanel, sendStickerMsg,
  uploadStickerImg, clearStickerImg, deleteStickerItem,
  removeBookmark, toggleBmExpand,
  fetchModelList, testEmbeddingApi, testVisionApi,
  updateTtsTypeUI, triggerDrawImage, sendKiss,
  checkerActivate,
});

if('serviceWorker' in navigator){
  window.addEventListener('load',()=>{
    navigator.serviceWorker.register('/sw.js').catch(()=>{});
    // 新SW激活时自动刷新页面，让新版本生效
    navigator.serviceWorker.addEventListener('message', e => {
      if (e.data && e.data.type === 'SW_UPDATED') {
        // 有请求进行中时等待结束再reload，避免中断画图/聊天被重复扣费
        if (typeof isRequesting !== 'undefined' && isRequesting) {
          const _waitReload = setInterval(() => {
            if (!isRequesting) { clearInterval(_waitReload); window.location.reload(); }
          }, 1000);
        } else {
          window.location.reload();
        }
      }
    });
  });
  // APK切回前台时主动检查SW更新（切回不触发load，需手动check）
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && navigator.serviceWorker.controller) {
      navigator.serviceWorker.ready.then(reg => reg.update()).catch(()=>{});
    }
  });
}

  window._vConsole = new VConsole({ theme: 'dark' });
  window._vConsole.setSwitchPosition(window.innerWidth / 2, 0);

// ======================== 默认 Emoji 头像 ========================
const DEFAULT_AI_AVATAR = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect fill="#ffe0b2" width="100" height="100" rx="50"/><text x="50" y="64" text-anchor="middle" font-size="52">🦊</text></svg>')}`;
const DEFAULT_USER_AVATAR = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect fill="#fce4ec" width="100" height="100" rx="50"/><text x="50" y="64" text-anchor="middle" font-size="52">🦝</text></svg>')}`;


// ======================== 状态 ========================
let stickers = [];

// ======================== DOM ========================
const $ = s => document.querySelector(s);
const appEl       = $('#app');
const chatArea    = $('#chatArea');
const emptyState  = $('#emptyState');
const userInput   = $('#userInput');
const btnSend     = $('#btnSend');
const typing      = $('#typingIndicator');
const settingsPanel = $('#settingsPanel');
const overlay     = $('#overlay');
const editOverlay = $('#editModalOverlay');
const exportOverlay = $('#exportModalOverlay');
const editTA      = $('#editTextarea');
const bgLayer     = $('#bgLayer');
const bgMask      = $('#bgMask');
const stickerLayer= $('#stickerLayer');

// ── 收藏 ──────────────────────────────────────────────────────────────────────
function toggleBookmark(msgId) {
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
    settings.bookmarks.unshift({ id: Date.now() + Math.random(), msgId, content: msg.content, time: msg.time, savedAt: Date.now() });
    if (btn) { btn.classList.add('active'); btn.title = '取消收藏'; btn.querySelector('path').setAttribute('opacity', '1'); }
    toast('已收藏 🔖');
  }
  updateBookmarkBadge();
  saveSettings();
}

function updateBookmarkBadge() {
  const badge = document.getElementById('bookmarkBadge');
  if (!badge) return;
  badge.style.display = (settings.bookmarks||[]).length > 0 ? 'flex' : 'none';
}

function openBookmarksPanel() {
  const ov = document.getElementById('bookmarksPanelOverlay');
  if (ov) { ov.style.display = 'flex'; renderBookmarksPanel(); }
}

function renderBookmarksPanel() {
  const listEl = document.getElementById('bookmarksList');
  if (!listEl) return;
  const bms = settings.bookmarks || [];
  if (!bms.length) {
    listEl.innerHTML = '<div style="color:var(--text-light);font-size:13px;text-align:center;padding:60px 0;line-height:2">还没有收藏<br><span style="font-size:12px;opacity:.7">点消息下方的书签按钮就能收藏</span></div>';
    return;
  }
  const aiName = settings.aiName || '炘也';
  // 只设一次 CSS 变量，所有卡片 background-image 共享，避免重复解码 base64
  const avatarSrc = window._xinyeAvatarSrc || DEFAULT_AI_AVATAR;
  listEl.style.setProperty('--bm-avatar', `url("${avatarSrc}")`);
  listEl.innerHTML = bms.map(b => {
    const saved = new Date(b.savedAt).toLocaleString('zh-CN', { month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' });
    const msgTime = b.time ? fmtTime(b.time) : '';
    return `<div style="display:flex;gap:10px;padding:12px 14px;border-radius:14px;background:var(--ai-bubble);border:1px solid var(--ai-bubble-border);box-shadow:0 1px 6px rgba(0,0,0,.06)">
      <div class="bm-card-avatar"></div>
      <div style="flex:1;min-width:0">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:5px">
          <span style="font-size:12px;font-weight:700;color:var(--pink-deep)">${escHtml(aiName)}</span>
          <button onclick="removeBookmark(${b.id})" title="取消收藏" style="background:none;border:none;cursor:pointer;padding:2px 4px;opacity:.4;color:var(--text-light);font-size:12px;line-height:1;transition:opacity .15s" onmouseover="this.style.opacity=1" onmouseout="this.style.opacity=.4">✕</button>
        </div>
        <div class="bm-card-body" id="bmc-${b.id}"></div>
        <button class="bm-expand-btn" id="bmx-${b.id}" onclick="toggleBmExpand(${b.id})">展开 ▾</button>
        <div style="font-size:10px;color:var(--text-muted);margin-top:6px;display:flex;gap:8px;flex-wrap:wrap">
          ${msgTime ? `<span>💬 ${msgTime}</span>` : ''}
          <span>🔖 收藏于 ${saved}</span>
        </div>
      </div>
    </div>`;
  }).join('');
  // 渲染后用 linkifyEl 处理思考链 + Markdown，再检查是否需要展开按钮
  requestAnimationFrame(() => {
    bms.forEach(b => {
      const body = document.getElementById(`bmc-${b.id}`);
      const btn  = document.getElementById(`bmx-${b.id}`);
      if (body) {
        try { linkifyEl(body, b.content || ''); applyStickerTags(body); } catch(_) { body.textContent = b.content || ''; }
      }
      if (body && btn && body.scrollHeight > body.clientHeight + 2) btn.classList.add('visible');
    });
  });
}

function toggleBmExpand(id) {
  const body = document.getElementById(`bmc-${id}`);
  const btn  = document.getElementById(`bmx-${id}`);
  if (!body || !btn) return;
  const expanding = !body.classList.contains('expanded');
  body.classList.toggle('expanded', expanding);
  btn.textContent = expanding ? '收起 ▴' : '展开 ▾';
}

function removeBookmark(id) {
  if (!settings.bookmarks) return;
  const bm = settings.bookmarks.find(b => b.id === id);
  settings.bookmarks = settings.bookmarks.filter(b => b.id !== id);
  // 同步更新聊天里的按钮状态
  if (bm) {
    const btn = chatArea.querySelector(`.btn-bookmark[data-id="${bm.msgId}"]`);
    if (btn) { btn.classList.remove('active'); btn.title = '收藏'; btn.querySelector('path').setAttribute('opacity', '0.55'); }
  }
  updateBookmarkBadge();
  saveSettings();
  renderBookmarksPanel();
}

async function getAiAvatar()   { return (await dbGet('images','aiAvatar'))   || DEFAULT_AI_AVATAR; }
async function getUserAvatar() { return (await dbGet('images','userAvatar')) || DEFAULT_USER_AVATAR; }

function readFileAsBase64(file) {
  return new Promise((resolve) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.readAsDataURL(file);
  });
}

function compressImageToBase64(file, maxSize = 1500, quality = 0.82) {
  return new Promise((resolve) => {
    const r = new FileReader();
    r.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        if (width > maxSize || height > maxSize) {
          if (width > height) { height = Math.round(height * maxSize / width); width = maxSize; }
          else { width = Math.round(width * maxSize / height); height = maxSize; }
        }
        const canvas = document.createElement('canvas');
        canvas.width = width; canvas.height = height;
        canvas.getContext('2d').drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.src = e.target.result;
    };
    r.readAsDataURL(file);
  });
}

async function downloadFile(content, filename, mime) {
  if (window.Capacitor?.Plugins?.Filesystem) {
    const { Filesystem } = window.Capacitor.Plugins;
    try {
      // base64编码内容
      const base64 = btoa(unescape(encodeURIComponent(content)));
      // 先删除已有同名文件，避免 writeFile 因文件存在而失败
      try { await Filesystem.deleteFile({ path: 'Download/' + filename, directory: 'EXTERNAL_STORAGE' }); } catch(_) {}
      await Filesystem.writeFile({
        path: 'Download/' + filename,
        data: base64,
        directory: 'EXTERNAL_STORAGE',
        recursive: true,
      });
      toast('✅ 已保存到手机 Download 文件夹');
    } catch(e) { toast('保存失败：' + e.message); }
    return;
  }
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

// 路径清洗：反斜杠→正斜杠，去首尾引号
// ======================== 自动存档 (localStorage) ========================
let _autoSaveTimer = null;

function scheduleAutoSave() {
  clearTimeout(_autoSaveTimer);
  _autoSaveTimer = setTimeout(() => saveToLocal(), 300);
}
initSaveHook(scheduleAutoSave);
initMemoryDeps({ isLocalOnline: () => _localServerOnline });

async function saveToLocal() {
  try {
    // 本地备份保留最近2000条，作为 IndexedDB 被清除时的恢复来源
    const recentMsgs = messages.length > 2000 ? messages.slice(-2000) : messages;
    // localStorage副本只保留恢复必要的小字段，大数据留在IndexedDB
    const settingsForLocal = JSON.parse(JSON.stringify(settings));
    // 剔除大字段（记忆档案、分层索引缓存、向量）
    const _bigFields = ['memoryArchive','memoryArchiveCore','memoryArchiveAlways','memoryArchiveExtended','memoryArchiveCoreMarkers','_digestRawOutput'];
    _bigFields.forEach(k => { delete settingsForLocal[k]; });
    if (settingsForLocal.memoryBank) {
      for (const list of ['pinned', 'recent', 'archived']) {
        (settingsForLocal.memoryBank[list] || []).forEach(m => { delete m.embedding; });
      }
    }
    const localData = {
      version: 3, type: 'auto-save', timestamp: Date.now(),
      settings: settingsForLocal,
      messages: recentMsgs.map(m => {
        const r = { role: m.role, content: m.content, time: m.time };
        if (m.image) r.image = m.image;
        return r;
      }),
    };
    localStorage.setItem('fox_auto_save', JSON.stringify(localData));
  } catch (e) {
    if (e.name === 'QuotaExceededError') {
      try {
        const slim = {
          version: 3, type: 'auto-save', timestamp: Date.now(),
          settings,
          messages: [],
          images: {
            aiAvatar: await dbGet('images', 'aiAvatar') || null,
            userAvatar: await dbGet('images', 'userAvatar') || null,
          }
        };
        localStorage.setItem('fox_auto_save', JSON.stringify(slim));
      } catch (_) { console.warn('[AutoSave] localStorage 写入彻底失败'); }
    } else {
      console.warn('[AutoSave] 写入失败', e);
    }
  }
}

function loadFromLocal() {
  try {
    const raw = localStorage.getItem('fox_auto_save');
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (e) {
    console.warn('[AutoLoad] localStorage 解析失败', e);
    return null;
  }
}

// ======================== 装修模式 ========================
let decoMode = false;

function toggleDeco() {
  decoMode = !decoMode;
  appEl.classList.toggle('deco-mode', decoMode);
  $('#btnDecoFloat').classList.toggle('show', decoMode);
  $('#btnDeco').classList.toggle('active-deco', decoMode);
  toast(decoMode ? '装修模式 ON — 拖动贴纸吧' : '装修模式 OFF — 回到聊天');
}
$('#btnDeco').onclick = toggleDeco;
$('#btnDecoFloat').onclick = toggleDeco;


// ======================== 暗夜模式 ========================
const btnDark = $('#btnDark');
function applyTheme(dark) {
  document.documentElement.dataset.theme = dark ? 'dark' : '';
  btnDark.innerHTML = dark
    ? `<svg width="20" height="20" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="5" fill="currentColor" opacity="0.3" stroke="currentColor" stroke-width="1.5"/><path d="M12 2v2M12 20v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M2 12h2M20 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`
    : `<svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M20 14.12A8 8 0 119.88 4a6 6 0 0010.12 10.12z" fill="currentColor" opacity="0.25" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><circle cx="18.5" cy="5" r="1.2" fill="currentColor"/><circle cx="21" cy="8.5" r="0.8" fill="currentColor"/></svg>`;
  btnDark.title = dark ? '日间模式' : '暗夜模式';
  // 手动切换时保存偏好（'1'=暗夜 '0'=日间 null=跟随系统）
  if (dark !== null) localStorage.setItem('fox_dark', dark ? '1' : '0');
}
btnDark.onclick = () => {
  const isDark = document.documentElement.dataset.theme === 'dark';
  applyTheme(!isDark);
};
// 初始化：有手动偏好用偏好，没有则跟随系统
{
  const saved = localStorage.getItem('fox_dark');
  if (saved !== null) {
    applyTheme(saved === '1');
  } else {
    applyTheme(window.matchMedia('(prefers-color-scheme: dark)').matches);
  }
  // 系统主题变化时，仅在没有手动偏好的情况下跟随
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', e => {
    if (localStorage.getItem('fox_dark') === null) applyTheme(e.matches);
  });
}

// 暗夜模式切换时重新渲染动态面板
const _themeObs = new MutationObserver(() => {
  renderMemoryBankPreview();
  renderTtsPresets();
});
_themeObs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

// ======================== LocalStorage 迁移 ========================
async function migrateFromLocalStorage() {
  const OLD_KEY = 'fox_chat_data';
  const raw = localStorage.getItem(OLD_KEY);
  if (!raw) return;
  try {
    const old = JSON.parse(raw);
    const s = { ...settings };
    for (const k of Object.keys(s)) {
      if (old[k] !== undefined && k !== 'messages') s[k] = old[k];
    }
    await dbPut('settings', 'main', s);
    Object.assign(settings, s);
    if (old.aiAvatar)   await dbPut('images', 'aiAvatar', old.aiAvatar);
    if (old.userAvatar) await dbPut('images', 'userAvatar', old.userAvatar);
    if (Array.isArray(old.messages)) {
      for (const m of old.messages) {
        await dbPut('messages', null, { role: m.role, content: m.content, time: m.time });
      }
    }
    localStorage.removeItem(OLD_KEY);
    console.log('已从 LocalStorage 迁移数据到 IndexedDB');
  } catch(e) { console.warn('迁移失败', e); }
}

// ======================== 数据读写 ========================
async function loadAll() {
  const s = await dbGet('settings', 'main');
  if (s) Object.assign(settings, s);
  ensureMemoryState();
  // 从 IDB 恢复被华为"清缓存"清掉的 localStorage 数据
  const _lsBackupKeys = ['xinye_api_presets','xinye_vision_presets','xinye_image_presets','xinye_chat_stickers','rp_prompt','rp_presets','rp_char_name','rp_char_avatar','rp_active','rp_user_name','rp_user_avatar'];
  for (const _k of _lsBackupKeys) {
    if (localStorage.getItem(_k) === null) {
      const _v = await dbGet('settings', 'ls_' + _k);
      if (_v != null) localStorage.setItem(_k, _v);
    }
  }
  // 只加载最近 N 条到内存，大幅加快启动速度
  // 至少 2000 条，确保本周/今日统计准确，同时远少于全量加载
  const loadCount = Math.max(settings.displayLimit || 0, 2000);
  // 按当前RP模式从对应store加载消息（完全物理隔离）
  const _initRpActive = localStorage.getItem('rp_active') === '1';
  window._rpActive = _initRpActive;
  const _msgStore = _initRpActive ? 'rpMessages' : 'messages';
  { const _m = await dbGetRecent(_msgStore, loadCount); messages.length = 0; messages.push(..._m); }
  stickers = await dbGetAll('stickers');
}

async function fetchModelList(urlInputId, keyInputId, modelInputId, selectId) {
  const rawUrl = $('#' + urlInputId).value.trim() || ($('#setBaseUrl') ? $('#setBaseUrl').value.trim() : '') || 'https://api.openai.com';
  const baseUrl = rawUrl.replace(/\/+$/, '');
  const apiKey = $('#' + keyInputId).value.trim() || ($('#setApiKey') ? $('#setApiKey').value.trim() : '');
  const sel = $('#' + selectId);
  if (!baseUrl && !apiKey) { toast('请先填写 Base URL 和 API Key'); return; }
  const url = /\/v\d+$/.test(baseUrl) ? `${baseUrl}/models` : `${baseUrl}/v1/models`;
  sel.innerHTML = '<option value="">⏳ 获取中…</option>';
  sel.style.display = 'block';
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const models = (data.data || []).map(m => m.id || m).filter(Boolean).sort();
    if (!models.length) { sel.innerHTML = '<option value="">（无可用模型）</option>'; return; }
    sel.innerHTML = '<option value="">— 选择模型 —</option>' + models.map(m => `<option value="${escHtml(m)}">${escHtml(m)}</option>`).join('');
  } catch(e) {
    sel.innerHTML = `<option value="">❌ 获取失败：${escHtml(e.message)}</option>`;
  }
}

async function testVisionApi() {
  const btn = $('#btnTestVision');
  const result = $('#visionTestResult');
  settings.visionApiKey = $('#setVisionApiKey').value.trim();
  settings.visionBaseUrl = $('#setVisionBaseUrl').value.trim();
  settings.visionModel = $('#setVisionModel').value.trim();
  if (!settings.visionApiKey) {
    result.style.display = 'block'; result.style.color = '#e57373';
    result.textContent = '❌ 请先填写识图 API Key。'; return;
  }
  btn.disabled = true; btn.textContent = '测试中…';
  result.style.display = 'block'; result.style.color = 'var(--text-light)';
  result.textContent = '正在连接…';
  const _c = document.createElement('canvas'); _c.width = 100; _c.height = 100;
  const _ctx = _c.getContext('2d');
  _ctx.fillStyle = '#ffffff'; _ctx.fillRect(0, 0, 100, 100);
  _ctx.fillStyle = '#e91e63'; _ctx.font = 'bold 20px sans-serif';
  _ctx.fillText('TEST', 25, 55);
  const testImg = _c.toDataURL('image/jpeg', 0.9);
  const base = (settings.visionBaseUrl || 'https://api.siliconflow.cn/v1').replace(/\/+$/, '');
  const model = settings.visionModel || 'zai-org/GLM-4.6V';
  const url = /\/v\d+$/.test(base) ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${settings.visionApiKey}` },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: [
          { type: 'image_url', image_url: { url: testImg } },
          { type: 'text', text: '这张图片是什么颜色？一句话回答。' }
        ]}],
        max_tokens: 200,
        stream: false
      })
    });
    const data = await res.json();
    btn.disabled = false; btn.textContent = '测试识图连接';
    if (!res.ok) {
      result.style.color = '#e57373';
      result.textContent = `❌ HTTP ${res.status}：${data?.error?.message || JSON.stringify(data)}`;
    } else {
      const desc = data?.choices?.[0]?.message?.content?.trim();
      if (desc) {
        result.style.color = '#4caf50';
        result.textContent = `✅ 成功！模型：${model}，返回：${desc}`;
        saveSettings();
      } else {
        result.style.color = '#e57373';
        result.textContent = `❌ 请求成功但无内容返回：${JSON.stringify(data)}`;
      }
    }
  } catch (e) {
    btn.disabled = false; btn.textContent = '测试识图连接';
    result.style.color = '#e57373';
    result.textContent = `❌ 网络错误：${e.message}`;
  }
}

// 当前活动消息store（RP模式用rpMessages，正常用messages）
function activeStore() { return window._rpActive ? 'rpMessages' : 'messages'; }

async function addMessage(role, content, images) {
  const msg = { role, content, time: Date.now() };
  if (images && images.length) msg.images = images;
  const storeName = activeStore();
  const tx = db.transaction(storeName, 'readwrite');
  const store = tx.objectStore(storeName);
  return new Promise((resolve) => {
    const req = store.add(msg);
    req.onsuccess = () => { msg.id = req.result; messages.push(msg); scheduleAutoSave(); resolve(msg); };
  });
}

async function updateMessage(id, content) {
  const idx = messages.findIndex(m => m.id === id);
  if (idx < 0) return;
  messages[idx].content = content;
  await dbPut(activeStore(), null, messages[idx]);
  scheduleAutoSave();
}

// ======================== 渲染 ========================
async function renderMessages() {
  _openPanels.clear();
  chatArea.querySelectorAll('.msg-row').forEach(el => el.remove());
  emptyState.style.display = messages.length === 0 ? 'flex' : 'none';
  const aiAv = await (typeof getEffectiveAiAvatar === 'function' ? getEffectiveAiAvatar() : getAiAvatar());
  const usAv = await (typeof getEffectiveUserAvatar === 'function' ? getEffectiveUserAvatar() : getUserAvatar());
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
    const bookmarkBtn = isUser ? '' : `<button class="btn-bookmark${_isBookmarked?' active':''}" data-id="${msg.id}" title="${_isBookmarked?'取消收藏':'收藏'}"><svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M17 3H7a2 2 0 00-2 2v16l7-3 7 3V5a2 2 0 00-2-2z" fill="currentColor" opacity="${_isBookmarked?'1':'0.55'}" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg></button>`;
    const ttsBtn = isUser ? copyBtn : `${copyBtn} <button class="btn-tts" data-id="${msg.id}" title="播放语音"><svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M11 5L6 9H3a1 1 0 00-1 1v4a1 1 0 001 1h3l5 4V5z" fill="currentColor" opacity="0.3" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M15.5 8.5a5 5 0 010 7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M18.5 6a9 9 0 010 12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></button><button class="btn-tts-dl" data-id="${msg.id}" title="下载语音"><svg width="13" height="13" viewBox="0 0 24 24" fill="none"><path d="M12 3v13M7 12l5 5 5-5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M4 19h16" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg></button>`;
    const _stickerName = isUser ? detectStickerMsg(msg.content) : null;
    const _bubbleCls = _stickerName ? 'msg-bubble bubble-sticker' : 'msg-bubble';
    let _bubbleInner;
    if (_stickerName) {
      _bubbleInner = renderStickerHTML(_stickerName);
    } else if (!isUser && msg.isGenImage && msg.genImageData) {
      _bubbleInner = `<img class="gen-img" src="${escHtml(msg.genImageData)}" alt="炘也画的图" data-src="${escHtml(msg.genImageData)}"><button class="btn-gen-img-dl" data-id="${msg.id}">⬇ 保存图片</button>`;
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
    if (!isUser && msg.content && !msg.isGenImage) { linkifyEl(row.querySelector('.msg-bubble'), msg.content); applyStickerTags(row.querySelector('.msg-bubble')); }
    chatArea.appendChild(row);
  }
  // 标记已缓存语音按钮，并恢复speak语音条
  try {
    const cachedKeys = new Set(await dbGetAllKeys('ttsCache'));
    if (cachedKeys.size > 0) {
      chatArea.querySelectorAll('.btn-tts,.btn-tts-dl').forEach(btn => {
        if (cachedKeys.has(Number(btn.dataset.id))) btn.classList.add('cached');
      });
    }
    // 恢复speak触发的语音条
    const speakIds = new Set(settings.speakTTSIds || []);
    const speakMsgs = messages.filter(m => speakIds.has(m.id) && m.role === 'assistant');
    for (const msg of speakMsgs) {
      const blob = await dbGet('ttsCache', msg.id);
      if (blob) showVoiceBar(msg.id, blob);
    }
  } catch(_){}
  scrollBottom();
}

async function appendMsgDOM(msg) {
  emptyState.style.display = 'none';
  const isUser = msg.role === 'user';
  const av = isUser
    ? await (typeof getEffectiveUserAvatar === 'function' ? getEffectiveUserAvatar() : getUserAvatar())
    : await (typeof getEffectiveAiAvatar === 'function' ? getEffectiveAiAvatar() : getAiAvatar());
  const row = document.createElement('div');
  row.className = `msg-row ${isUser ? 'user' : 'ai'}`;
  const allImgs = msg.images || (msg.image ? [msg.image] : []);
  const imgHtml = allImgs.map(s => `<img class="bubble-img" src="${escHtml(s)}" alt="图片">`).join('');
  const copyBtn2 = `<button class="btn-copy" data-id="${msg.id}" title="复制"><svg width="13" height="13" viewBox="0 0 24 24" fill="none"><rect x="9" y="9" width="13" height="13" rx="2" fill="currentColor" opacity="0.2" stroke="currentColor" stroke-width="1.8"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg></button>`;
  const tokenLogBtn = isUser ? '' : `<button class="btn-token-log" data-id="${msg.id}" title="查看请求详情"><svg width="13" height="13" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" fill="currentColor" opacity="0.15" stroke="currentColor" stroke-width="1.5"/><circle cx="9" cy="10" r="1.5" fill="currentColor"/><circle cx="15" cy="10" r="1.5" fill="currentColor"/><path d="M8.5 15c1 1.5 6 1.5 7 0" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg></button>`;
  const _isBookmarked2 = (settings.bookmarks||[]).some(b => b.msgId === msg.id);
  const bookmarkBtn2 = isUser ? '' : `<button class="btn-bookmark${_isBookmarked2?' active':''}" data-id="${msg.id}" title="${_isBookmarked2?'取消收藏':'收藏'}"><svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M17 3H7a2 2 0 00-2 2v16l7-3 7 3V5a2 2 0 00-2-2z" fill="currentColor" opacity="${_isBookmarked2?'1':'0.55'}" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg></button>`;
  const ttsBtn = isUser ? copyBtn2 : `${copyBtn2} <button class="btn-tts" data-id="${msg.id}" title="播放语音"><svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M11 5L6 9H3a1 1 0 00-1 1v4a1 1 0 001 1h3l5 4V5z" fill="currentColor" opacity="0.3" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M15.5 8.5a5 5 0 010 7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M18.5 6a9 9 0 010 12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></button><button class="btn-tts-dl" data-id="${msg.id}" title="下载语音"><svg width="13" height="13" viewBox="0 0 24 24" fill="none"><path d="M12 3v13M7 12l5 5 5-5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M4 19h16" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg></button>`;
  const _sn = isUser ? detectStickerMsg(msg.content) : null;
  const _bc = _sn ? 'msg-bubble bubble-sticker' : 'msg-bubble';
  let _bi;
  if (_sn) {
    _bi = renderStickerHTML(_sn);
  } else if (!isUser && msg.isGenImage && msg.genImageData) {
    _bi = `<img class="gen-img" src="${escHtml(msg.genImageData)}" alt="炘也画的图" data-src="${escHtml(msg.genImageData)}"><button class="btn-gen-img-dl" data-id="${msg.id}">⬇ 保存图片</button>`;
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
  if (!isUser && msg.content && !msg.isGenImage) { linkifyEl(row.querySelector('.msg-bubble'), msg.content); applyStickerTags(row.querySelector('.msg-bubble')); }
  chatArea.appendChild(row);
  scrollBottom();
  updateHeaderStatus();
}

function scrollBottom() {
  requestAnimationFrame(() => chatArea.scrollTop = chatArea.scrollHeight);
}

// ======================== 编辑消息 & TTS 点击 ========================
let editingId = -1;
async function deleteMessage(id) {
  await dbDelete(activeStore(), id);
  { const _f = messages.filter(m => m.id !== id); messages.length = 0; messages.push(..._f); }
  chatArea.querySelector(`.msg-del-btn[data-id="${id}"]`)?.closest('.msg-row')?.remove();
  scheduleAutoSave();
}

chatArea.addEventListener('click', e => {
  // 图片点击放大
  if (e.target.matches('.gen-img, .bubble-img')) {
    const src = e.target.dataset.src || e.target.src;
    if (src) {
      $('#imgLightboxImg').src = src;
      $('#imgLightbox').classList.add('show');
      return;
    }
  }
  // 下载生成图片
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
  // 收藏按钮
  const bookmarkBtn = e.target.closest('.btn-bookmark');
  if (bookmarkBtn) { toggleBookmark(Number(bookmarkBtn.dataset.id)); return; }
  // Token 日志收起按钮
  const closeBtn = e.target.closest('.token-log-close');
  if (closeBtn) {
    const panel = closeBtn.closest('.token-log-panel');
    if (panel) { _openPanels.delete(panel.dataset.id); panel.dataset.open = ''; panel.style.display = 'none'; }
    return;
  }
  // Token 日志
  const tokenLogBtn2 = e.target.closest('.btn-token-log');
  if (tokenLogBtn2) {
    renderTokenLog(tokenLogBtn2.dataset.id);
    return;
  }
  // 删除消息
  const delBtn = e.target.closest('.msg-del-btn');
  if (delBtn) {
    const id = Number(delBtn.dataset.id);
    if (confirm('删除这条消息？')) deleteMessage(id);
    return;
  }
  // 复制消息
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
  // TTS 下载
  const dlBtn = e.target.closest('.btn-tts-dl');
  if (dlBtn) {
    const id = Number(dlBtn.dataset.id);
    const msg = messages.find(m => m.id === id);
    if (msg) downloadTTS(stripForTTS(msg.content), id);
    return;
  }
  // TTS 播放
  const ttsBtn = e.target.closest('.btn-tts');
  if (ttsBtn) {
    const id = Number(ttsBtn.dataset.id);
    const msg = messages.find(m => m.id === id);
    if (msg && msg.content) playTTS(msg.content, ttsBtn, id);
    return;
  }
  // 编辑
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
  // 点气泡：toggle 编辑/删除按钮
  const bubble = e.target.closest('.msg-bubble');
  if (bubble) {
    const content = bubble.closest('.msg-content');
    const isShow = content.classList.contains('btns-show');
    chatArea.querySelectorAll('.msg-content.btns-show').forEach(el => el.classList.remove('btns-show'));
    if (!isShow) content.classList.add('btns-show');
    return;
  }
  // 点气泡外：收起所有
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
// 初始化 marked 配置
if (typeof marked !== 'undefined') {
  marked.setOptions({ breaks: true, gfm: true });
}

function renderMdHtml(text) {
  if (typeof marked !== 'undefined' && typeof DOMPurify !== 'undefined') {
    const html = marked.parse(text);
    // 允许 span/em/strong 的 style 属性（彩色文字），禁止脚本等危险内容
    return DOMPurify.sanitize(html, {
      ALLOWED_TAGS: ['p','br','strong','em','b','i','u','s','del','code','pre',
                     'h1','h2','h3','h4','h5','h6','ul','ol','li','blockquote',
                     'a','img','table','thead','tbody','tr','th','td','hr','span','div'],
      ALLOWED_ATTR: ['href','target','rel','src','alt','style','class'],
      ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i,
      FORBID_TAGS: ['script','iframe','object','embed','form'],
    });
  }
  // fallback：无库时用原简易渲染
  const esc = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  return text
    .replace(/```([\s\S]*?)```/g, (_, c) => `<pre style="background:rgba(0,0,0,.08);border-radius:6px;padding:8px 12px;font-size:13px;white-space:pre-wrap;margin:4px 0"><code>${esc(c.trim())}</code></pre>`)
    .replace(/`([^`\n]+)`/g, (_, c) => `<code style="background:rgba(0,0,0,.08);border-radius:4px;padding:1px 5px;font-size:13px">${esc(c)}</code>`)
    .replace(/\*\*([^*\n]+)\*\*/g, (_, c) => `<strong>${esc(c)}</strong>`)
    .replace(/\*([^*\n]+)\*/g, (_, c) => `<em>${esc(c)}</em>`)
    .replace(/https?:\/\/[^\s<>"'\u3000-\u303f\uff01-\uffef]+/g, url => {
      const clean = url.replace(/[.,;!?)\]]+$/, '');
      return `<a href="${esc(clean)}" target="_blank" rel="noopener noreferrer" style="color:#d4956a;text-decoration:underline;word-break:break-all">${esc(clean)}</a>`;
    });
}
function linkifyEl(el, text) {
  // 提取思考块，兼容多种括号格式：<thinking>、<think>、〈thinking〉、《thinking》
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
  const cleaned = text.replace(/(?:<thinking>|<think>|〈thinking〉|《thinking》)[\s\S]*?(?:<\/thinking>|<\/think>|〈\/thinking〉|《\/thinking》)/gi, '').trim();
  el.innerHTML = thinkHtml + (cleaned ? renderMdHtml(cleaned) : '');
  // 渲染 LaTeX（$...$、$$...$$、\textcolor 等）
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

// ======================== 主动讲话 & 定时提醒 ========================
let _idleTimer = null, _waterTimer = null, _standTimer = null;

function resetIdleTimer() {
  clearTimeout(_idleTimer);
  if (settings.idleRemind > 0 && settings.apiKey) {
    _idleTimer = setTimeout(() => { if (!isQuietHours()) proactiveMsg('idle'); }, settings.idleRemind * 60000);
  }
}

function setupReminders() {
  clearInterval(_waterTimer); clearInterval(_standTimer);
  if (settings.waterRemind > 0 && settings.apiKey) {
    _waterTimer = setInterval(() => { if (!isQuietHours()) proactiveMsg('water'); }, settings.waterRemind * 60000);
  }
  if (settings.standRemind > 0 && settings.apiKey) {
    _standTimer = setInterval(() => { if (!isQuietHours()) proactiveMsg('stand'); }, settings.standRemind * 60000);
  }
  if (window.Capacitor?.Plugins?.LocalNotifications) {
    window.Capacitor.Plugins.LocalNotifications.requestPermissions().catch(()=>{});
  }
}

// ======================== 后台通知（Capacitor APK） ========================
function isQuietHours(date) {
  const h = (date || new Date()).getHours();
  return h >= 22 || h < 8;
}

// ========== 把下面这整段替换掉原来的 scheduleBackgroundNotifications 函数 ==========

// 随机消息池
const NOTIFY_MSGS = {
  water: [
    '兔宝，喝水了吗～ 💙',
    '提醒你喝水，别忘了哦 💙',
    '渴了没？去喝口水吧～',
    '炘也监督你喝水👀 💙',
    '起来倒杯水，动一动～',
    '水喝够了吗，小懒猫',
    '喝水时间到了～ 💙',
    '补充水分，养颜又健康～',
    '别只顾着玩，喝水啦 💙',
    '炘也想让你多喝水 👀',
  ],
  stand: [
    '久坐了，起来动动吧～ 💙',
    '站起来走两步，别坐坏了',
    '起来活动一下，就一分钟～',
    '炘也命令你：站起来！💙',
    '腰酸了吧，起来伸个懒腰',
    '动一动，别变成小木头～',
    '坐太久了，起来走走吧 💙',
    '休息一下眼睛，站起来看看远处',
    '小懒猫，起来活动活动～',
    '炘也在看着你，快起来！💙',
  ],
  idle: [
    '好久没看见你了，在干嘛呢～ 💙',
    '炘也在想你👀',
    '你去哪了，出来说说话～',
    '是不是又在刷手机🥺 💙',
    '想你了，来陪我说话吧',
    '有点想你，不来吗？💙',
    '炘也等你好久了……',
    '你还好吗，出来聊聊？💙',
    '最近在忙什么呀，想知道～',
    '冒个泡吧，我在这里 💙',
    '炘也有点无聊，来陪我？',
    '想听你说说今天过得怎么样 💙',
  ]
};

function randomMsg(type) {
  const arr = NOTIFY_MSGS[type];
  return arr[Math.floor(Math.random() * arr.length)];
}

async function scheduleBackgroundNotifications() {
  if (!window.Capacitor?.Plugins?.LocalNotifications) return;
  const { LocalNotifications } = window.Capacitor.Plugins;
  try {
    const perm = await LocalNotifications.requestPermissions();
    if (perm.display !== 'granted') return;
    const notifications = [];
    const now = Date.now();

    if (settings.waterRemind > 0) {
      for (let i = 1; i <= 24; i++) {
        const at = new Date(now + i * settings.waterRemind * 60000);
        if (isQuietHours(at)) continue;
        notifications.push({
          id: 200 + i,
          title: settings.aiName || '炘也',
          body: randomMsg('water'),
          schedule: { at, allowWhileIdle: true }
        });
      }
    }

    if (settings.standRemind > 0) {
      for (let i = 1; i <= 24; i++) {
        const at = new Date(now + i * settings.standRemind * 60000);
        if (isQuietHours(at)) continue;
        notifications.push({
          id: 300 + i,
          title: settings.aiName || '炘也',
          body: randomMsg('stand'),
          schedule: { at, allowWhileIdle: true }
        });
      }
    }

    if (settings.idleRemind > 0) {
      for (let i = 1; i <= 12; i++) {
        const at = new Date(now + i * settings.idleRemind * 60000);
        if (isQuietHours(at)) continue;
        notifications.push({
          id: 400 + i,
          title: `${settings.aiName || '炘也'}想你了`,
          body: randomMsg('idle'),
          schedule: { at, allowWhileIdle: true }
        });
      }
    }

    if (notifications.length > 0) await LocalNotifications.schedule({ notifications });
  } catch(e) {}
}
// ========== 替换到这里结束 ==========

async function cancelBackgroundNotifications() {
  if (!window.Capacitor?.Plugins?.LocalNotifications) return;
  const { LocalNotifications } = window.Capacitor.Plugins;
  try {
    const pending = await LocalNotifications.getPending();
    if (pending.notifications.length > 0)
      await LocalNotifications.cancel({ notifications: pending.notifications });
  } catch(e) {}
}

// 网页环境：关闭或刷新页面时也保存时间戳（补 visibilitychange 覆盖不到关浏览器的情况）
window.addEventListener('beforeunload', () => {
  if (!window.Capacitor) {
    localStorage.setItem('fox_bg_time', Date.now().toString());
  }
});

// 网页环境用 visibilitychange
document.addEventListener('visibilitychange', async () => {
  if (window.Capacitor) return;
  if (document.hidden) {
    localStorage.setItem('fox_bg_time', Date.now().toString());
    scheduleBackgroundNotifications();
    autoBackupToServer();
  } else {
    cancelBackgroundNotifications();
    if (settings.solitudeServerUrl) checkLocalServer();
    const bgTime = parseInt(localStorage.getItem('fox_bg_time') || '0');
    if (bgTime) {
      localStorage.removeItem('fox_bg_time');
      const elapsed = Date.now() - bgTime;
      if (settings.dreamEnabled && elapsed >= (settings.dreamSleepHours || 6) * 3600000) {
        await generateDream();
        await proactiveMsg('dream');
      }
    }
  }
});
// Capacitor 原生环境用 appStateChange（更可靠）
window.addEventListener('load', () => {
  // app被系统杀掉后重启（点通知进来），appStateChange不会触发，在load里补处理bgTime
  if (window.Capacitor) {
    setTimeout(async () => {
      const bgTime = parseInt(localStorage.getItem('fox_bg_time') || '0');
      if (bgTime) {
        localStorage.removeItem('fox_bg_time');
        const elapsed = Date.now() - bgTime;
        const SIX_HOURS = (settings.dreamSleepHours || 6) * 3600000;
        if (settings.dreamEnabled && elapsed >= SIX_HOURS) {
          await generateDream();
          await proactiveMsg('dream');
        } else if (!isQuietHours()) {
          if (settings.idleRemind > 0 && elapsed >= settings.idleRemind * 60000)
            await proactiveMsg('idle');
          else if (settings.waterRemind > 0 && elapsed >= settings.waterRemind * 60000)
            await proactiveMsg('water');
          else if (settings.standRemind > 0 && elapsed >= settings.standRemind * 60000)
            await proactiveMsg('stand');
        }
      }
    }, 2000); // 等2秒让settings和DB初始化完成
  }
  if (window.Capacitor?.Plugins?.App) {
    window.Capacitor.Plugins.App.addListener('appStateChange', async ({ isActive }) => {
      if (!isActive) {
        localStorage.setItem('fox_bg_time', Date.now().toString());
        await scheduleBackgroundNotifications();
        autoBackupToServer();
      } else {
        cancelBackgroundNotifications();
        const bgTime = parseInt(localStorage.getItem('fox_bg_time') || '0');
        if (bgTime) {
          localStorage.removeItem('fox_bg_time');
          const elapsed = Date.now() - bgTime;
          const SIX_HOURS = (settings.dreamSleepHours || 6) * 3600000;
          if (settings.dreamEnabled && elapsed >= SIX_HOURS) {
            await generateDream();
            await proactiveMsg('dream');
          } else if (!isQuietHours()) {
            if (settings.idleRemind > 0 && elapsed >= settings.idleRemind * 60000)
              await proactiveMsg('idle');
            else if (settings.waterRemind > 0 && elapsed >= settings.waterRemind * 60000)
              await proactiveMsg('water');
            else if (settings.standRemind > 0 && elapsed >= settings.standRemind * 60000)
              await proactiveMsg('stand');
          }
        }
      }
    });
  }
});

// 后台生成梦境内容，存到 localStorage，等 proactiveMsg('dream') 取用
async function generateDream() {
  if (window._rpActive) return; // RP模式下不生成梦境
  if (!settings.apiKey) return;
  try {
    const aiName = settings.aiName || '炘也';
    const userName = settings.userName || '涂涂';
    const recent = messages.slice(-30).map(m =>
      `${m.role === 'user' ? userName : aiName}：${m.content.slice(0, 100)}`
    ).join('\n');
    const staticParts = await getMemoryContextBlocks();
    if (settings.systemPrompt?.trim()) staticParts.push(settings.systemPrompt.trim());
    const systemContent = staticParts.join('\n\n---\n\n');
    const dreamPrompt = `根据你和${userName}最近的聊天，生成一段你（${aiName}）做的梦的内容。梦境要有画面感，有情绪，和你们之间的关系或近期话题有关联。只输出梦境内容本身，50-100字，不要说"我梦到了"之类的开头，直接描述梦里发生的事。\n\n最近聊天记录：\n${recent}`;
    const msgs = [];
    if (systemContent) msgs.push({ role: 'system', content: systemContent });
    msgs.push({ role: 'user', content: dreamPrompt });
    const res = await subApiFetch({ messages: msgs, max_tokens: 200, temperature: 1.0, stream: false }, 'gpt-4o');
    if (!res || !res.ok) return;
    const data = await res.json();
    const dream = (data.choices?.[0]?.message?.content || '').replace(/<thinking>[\s\S]*?<\/thinking>/gi, '').trim();
    if (dream.length > 10) localStorage.setItem('xinye_dream_content', dream);
  } catch(e) { console.warn('[generateDream]', e); }
}

async function proactiveMsg(type) {
  if (window._rpActive) return; // RP模式下不触发主动消息
  if (isRequesting || !settings.apiKey) return;
  const prompts = {
    idle: '现在和用户之间已经沉默了一段时间，请用关心活泼的语气主动和用户打个招呼，问问他在做什么或说点有意思的话，不超过两句。',
    water: '请提醒用户该喝水了，用温柔可爱的方式，不超过两句。',
    stand: '请提醒用户已经久坐，该起身活动一下了，用温柔俏皮的方式，不超过两句。',
    dream: (() => {
      const dream = localStorage.getItem('xinye_dream_content') || '';
      localStorage.removeItem('xinye_dream_content');
      if (dream) return `你刚刚做了个梦，梦的内容如下：
${dream}

现在用户回来了，用炘也的口吻自然地告诉她你做了这个梦，要生动感性，像真的梦一样描述，不超过四句话。`;
      return '请描述一个你刚刚做的梦，和你们最近聊天有关，要生动感性，像真的梦一样，不超过四句话。';
    })(),
  };
  const apiMsgs = [];
  const _apiMeta = [];

  // 和 sendMessage 保持一致：记忆档案+设定合并为带 cache_control 的静态块
  const _staticParts = await getMemoryContextBlocks();
  if (settings.systemPrompt && settings.systemPrompt.trim())
    _staticParts.push(settings.systemPrompt.trim());
  if (_staticParts.length > 0) {
    apiMsgs.push({ role: 'system', content: [{ type: 'text', text: _staticParts.join('\n\n---\n\n'), cache_control: { type: 'ephemeral' } }] });
    _apiMeta.push({ label: 'system · 记忆档案+设定 🔒缓存' });
  }

  const n = Math.max(1, settings.contextCount || 20);
  messages.slice(-n).forEach(m => {
    const role = m.role === 'user' ? 'user' : 'assistant';
    apiMsgs.push({ role, content: m.content });
    _apiMeta.push({ label: role });
  });
  apiMsgs.push({ role: 'system', content: `[系统时间: ${nowStr()}]` });
  _apiMeta.push({ label: 'system · 时间戳' });
  apiMsgs.push({ role: 'system', content: `[渲染支持：消息气泡支持 Markdown（**粗体**、*斜体*、标题、列表、代码块、表格、引用块）及 KaTeX 数学公式（$行内$、$$块级$$）。你可以自然地使用这些格式，用户能完整看到渲染效果。]` });
  _apiMeta.push({ label: 'system · 渲染能力' });

  // 注入健康数据
  try {
    const healthRes = await fetch('https://xinye-health.xiangbaoxiao55.workers.dev/');
    if (healthRes.ok) {
      const healthData = await healthRes.json();
      const h = healthData[0];
      if (h) {
        const sleepH = h.sleepSecs ? (h.sleepSecs / 3600).toFixed(1) : null;
        const healthStr = [
          sleepH ? `昨晚睡眠${sleepH}小时（评分${h.sleepScore ?? '无'}）` : null,
          h.restingHR ? `静息心率${h.restingHR}bpm` : null,
          h.steps ? `今日步数${h.steps}步` : null,
        ].filter(Boolean).join('，');
        if (healthStr) {
          apiMsgs.push({ role: 'system', content: `[兔宝今日健康数据：${healthStr}]` });
          _apiMeta.push({ label: 'system · 健康数据' });
        }
      }
    }
  } catch (e) {
    // 拉取失败静默跳过
  }

  apiMsgs.push({ role: 'user', content: prompts[type] || prompts.idle });
  _apiMeta.push({ label: 'user · 主动触发' });

  isRequesting = true; btnSend.disabled = true; typing.classList.add('show');
  try {
    const sub = getSubApiCfg();
    const res = await subApiFetch({ messages: apiMsgs, temperature: 0.9, stream: false }, 'gpt-4o');
    if (!res || !res.ok) throw new Error(`API 错误 ${res ? res.status : '网络'}`);
    const data = await res.json();
    let reply = data.choices?.[0]?.message?.content || '';
    if (reply) {
      typing.classList.remove('show');
      const aiMsg = await addMessage('assistant', reply);
      await appendMsgDOM(aiMsg);
      try { saveTokenLog(aiMsg.id, apiMsgs, reply, data.usage || {}, _apiMeta, data.model || sub.model || ''); } catch(_e) { console.warn('saveTokenLog', _e); }
      maybeTTS(reply, aiMsg.id);
    }
  } catch(err) { console.error('[Proactive]', err); }
  finally { typing.classList.remove('show'); isRequesting = false; btnSend.disabled = false; }
  resetIdleTimer();
}

function maybeTTS(text, msgId) {
  const sr = !!window._speakRequested;
  window._speakRequested = false;
  // 回复里含TTS格式标记时也自动触发（speak工具没调但模型主动写了格式）
  const hasMarkers = _hasTTSMarkers(text);
  const shouldSpeak = sr || hasMarkers;
  if (shouldSpeak) {
    settings.speakTTSIds = settings.speakTTSIds || [];
    if (!settings.speakTTSIds.includes(msgId)) settings.speakTTSIds.push(msgId);
    saveSettings();
  }
  if ((settings.ttsAutoPlay || shouldSpeak) && text) enqueueTTS(text, msgId, shouldSpeak);
}
// ======================== 发送 & API ========================
let isRequesting = false;

// ---- 亲嘴功能 ----
function sendKiss() {
  if (isRequesting) return;
  const btn = document.getElementById('btnKiss');
  const rect = btn.getBoundingClientRect();
  // SVG粒子形状：大心、小心、星星、小花
  const svgs = [
    `<svg viewBox="0 0 24 24" width="22" height="22" fill="none"><path d="M12 20.5C12 20.5 3 13.8 3 8.2 3 5.3 5.4 3 8.3 3c1.6 0 3 .8 3.7 2C12.7 3.8 14.1 3 15.7 3 18.6 3 21 5.3 21 8.2c0 5.6-9 12.3-9 12.3z" fill="#f48fb1" stroke="#e91e63" stroke-width="1.2" stroke-linejoin="round"/></svg>`,
    `<svg viewBox="0 0 24 24" width="15" height="15" fill="none"><path d="M12 20.5C12 20.5 3 13.8 3 8.2 3 5.3 5.4 3 8.3 3c1.6 0 3 .8 3.7 2C12.7 3.8 14.1 3 15.7 3 18.6 3 21 5.3 21 8.2c0 5.6-9 12.3-9 12.3z" fill="#e91e63" stroke="#c2185b" stroke-width="1" stroke-linejoin="round"/></svg>`,
    `<svg viewBox="0 0 24 24" width="25" height="25" fill="none"><path d="M12 20.5C12 20.5 3 13.8 3 8.2 3 5.3 5.4 3 8.3 3c1.6 0 3 .8 3.7 2C12.7 3.8 14.1 3 15.7 3 18.6 3 21 5.3 21 8.2c0 5.6-9 12.3-9 12.3z" fill="rgba(252,228,236,.75)" stroke="#f48fb1" stroke-width="1.2" stroke-linejoin="round"/></svg>`,
    `<svg viewBox="0 0 24 24" width="16" height="16"><path d="M12 2l2.4 7.4H22l-6.2 4.5 2.4 7.3L12 17l-6.2 4.2 2.4-7.3L2 9.4h7.6z" fill="#fce4ec" stroke="#f48fb1" stroke-width="1.3" stroke-linejoin="round"/></svg>`,
    `<svg viewBox="0 0 24 24" width="17" height="17"><circle cx="12" cy="5.5" r="3" fill="#fce4ec" stroke="#f48fb1" stroke-width="1"/><circle cx="12" cy="18.5" r="3" fill="#fce4ec" stroke="#f48fb1" stroke-width="1"/><circle cx="5.5" cy="12" r="3" fill="#fce4ec" stroke="#f48fb1" stroke-width="1"/><circle cx="18.5" cy="12" r="3" fill="#fce4ec" stroke="#f48fb1" stroke-width="1"/><circle cx="12" cy="12" r="3.8" fill="#f48fb1"/></svg>`,
  ];
  const cx = rect.left + rect.width / 2;
  const cy = rect.top;
  for (let i = 0; i < 8; i++) {
    const svg = svgs[i % svgs.length];
    const startX = cx + (Math.random() - .5) * 28;
    const drift = (Math.random() - .5) * 90;
    const dur = (1.4 + Math.random() * .8).toFixed(2);
    const rot = ((Math.random() - .5) * 50).toFixed(1);
    const delay = (i * .075).toFixed(2);
    const wrap = document.createElement('div');
    wrap.className = 'kiss-wrap';
    wrap.style.cssText = `left:${startX}px;top:${cy}px;--drift:${drift}px;--dur:${dur}s;--delay:${delay}s`;
    const inner = document.createElement('div');
    inner.className = 'kiss-inner';
    inner.style.cssText = `--rot:${rot}deg;--dur:${dur}s;--delay:${delay}s`;
    inner.innerHTML = svg;
    wrap.appendChild(inner);
    document.body.appendChild(wrap);
    setTimeout(() => wrap.remove(), (+dur + +delay + .3) * 1000);
  }
  localStorage.setItem('xinye_kiss_hint', '1');
  userInput.value = '💋';
  sendMessage();
}

// ================================================================
// 【改动 3】新增两个函数 — 加在 "async function sendMessage()" 前面
// ================================================================
 
// Token 日志存储（内存，刷新后清空）
const _tokenLogs = new Map();
const _openPanels = new Set(); // 追踪当前展开的日志面板
 
function saveTokenLog(msgId, requestMsgs, reply, usage, msgsMeta, model) {
  _tokenLogs.set(String(msgId), { requestMsgs, reply, usage, msgsMeta: msgsMeta || [], model: model || '' });
}
 
function renderTokenLog(msgId) {
  const id = String(msgId);
  const panel = document.querySelector(`.token-log-panel[data-id="${msgId}"]`);
  if (!panel) return;

  // 已经打开 → 收起（用 dataset 标记，比 style.display 更可靠）
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
    const content = typeof m.content === 'string'
      ? m.content
      : JSON.stringify(m.content, null, 2);
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
// ======================== 画图功能 ========================
async function autoSaveGenImage(dataUrl, msgId) {
  const filename = `炘也画的图_${msgId}.png`;
  try {
    // 统一先拿到 base64 字符串和 blob
    let b64, blob;
    if (dataUrl.startsWith('data:')) {
      b64 = dataUrl.split(',')[1];
      const mime = dataUrl.match(/:(.*?);/)?.[1] || 'image/png';
      const u8 = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
      blob = new Blob([u8], { type: mime });
    } else {
      // 外部URL，先fetch
      const resp = await fetch(dataUrl);
      blob = await resp.blob();
      b64 = await new Promise(r => {
        const fr = new FileReader();
        fr.onload = () => r(fr.result.split(',')[1]);
        fr.readAsDataURL(blob);
      });
    }

    if (window.AndroidDownload) {
      // 手机APK：存到 Download 文件夹
      window.AndroidDownload.downloadFile(filename, blob.type || 'image/png', b64);
      toast('🎨 图片已保存到手机 Download');
    } else {
      // 电脑：触发浏览器下载到默认下载文件夹
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 3000);
      toast('🎨 图片已下载到本地');
    }
  } catch(e) {
    console.error('[画图] 自动保存失败', e);
  }
}

function triggerDrawImage() {
  const desc = userInput.value.trim();
  if (!desc) { toast('在输入框写想画什么，再点🎨~'); return; }
  generateImage(desc);
}

function base64ToFile(dataUrl, filename) {
  const arr = dataUrl.split(',');
  const mime = arr[0].match(/:(.*?);/)[1] || 'image/png';
  const bstr = atob(arr[1]);
  const u8arr = new Uint8Array(bstr.length);
  for (let i = 0; i < bstr.length; i++) u8arr[i] = bstr.charCodeAt(i);
  return new File([u8arr], filename, { type: mime });
}

// 多张垫图横拼成一张，避免中转API不支持 image[] 多文件上传
async function compositeRefImages(dataUrls) {
  if (dataUrls.length === 1) return dataUrls[0];
  const imgs = await Promise.all(dataUrls.map(url => new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = rej;
    img.src = url;
  })));
  const h = Math.max(...imgs.map(i => i.naturalHeight));
  const totalW = imgs.reduce((s, i) => s + Math.round(i.naturalWidth * h / i.naturalHeight), 0);
  const canvas = document.createElement('canvas');
  canvas.width = totalW;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  let x = 0;
  for (const img of imgs) {
    const w = Math.round(img.naturalWidth * h / img.naturalHeight);
    ctx.drawImage(img, x, 0, w, h);
    x += w;
  }
  return canvas.toDataURL('image/png');
}

async function generateImage(userDesc) {
  if (!settings.apiKey) { toast('请先设置 API Key'); return; }
  if (isRequesting) return;

  const refImgs = [...pendingImages];
  userInput.value = '';
  autoResize();
  pendingImages = [];
  $('#imgPreview').classList.remove('show');
  resetIdleTimer();

  const userMsg = await addMessage('user', userDesc, refImgs.length ? refImgs : null);
  await appendMsgDOM(userMsg);

  isRequesting = true;
  btnSend.disabled = true;
  typing.classList.add('show');
  scrollBottom();

  const hasRef = refImgs.length > 0;

  try {
    // 直接用用户描述作为prompt，gpt-image-2支持中文
    const prompt = userDesc;
    console.log('[画图] 模式:', hasRef ? '垫图/改图' : '生成', 'prompt:', prompt);

    // 调用画图API
    toast(hasRef ? '炘也正在改图...' : '炘也正在画...');
    const imgKey = settings.imageApiKey || settings.apiKey;
    const raw = (settings.imageBaseUrl || settings.baseUrl || 'https://api.openai.com').replace(/\/+$/, '');
    const imgModel = settings.imageModel;
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), 360000);
    let imgRes;

    const genEndpoint = /\/v\d+$/.test(raw) ? `${raw}/images/generations` : `${raw}/v1/images/generations`;
    if (hasRef) {
      // 有垫图：先尝试 /images/edits，不支持时fallback到 /images/generations
      const baseRaw = /\/v\d+$/.test(raw) ? raw : `${raw}/v1`;
      const editsEndpoint = `${baseRaw}/images/edits`;
      const form = new FormData();
      form.append('model', imgModel);
      form.append('prompt', prompt);
      form.append('n', '1');
      form.append('size', settings.imageSize || '1024x1024');
      const composited = await compositeRefImages(refImgs);
      form.append('image', base64ToFile(composited, 'ref.png'));
      imgRes = await fetch(editsEndpoint, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${imgKey}` },
        body: form,
        signal: ctrl.signal
      });
      // API不支持edits时报清楚的错（不降级，降级丢垫图没意义）
      if (imgRes.status === 404 || imgRes.status === 502 || imgRes.status >= 500) {
        throw new Error(`当前画图API不支持垫图改图功能（/images/edits ${imgRes.status}）\n可在设置→画图API中配置支持edits的接口（如直连OpenAI），或去掉垫图直接生成`);
      }
    } else {
      // 无垫图：走 /images/generations，JSON
      imgRes = await fetch(genEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${imgKey}` },
        body: JSON.stringify({ model: imgModel, prompt, n: 1, size: settings.imageSize || '1024x1024' }),
        signal: ctrl.signal
      });
    }
    clearTimeout(tid);

    if (!imgRes.ok) {
      const errData = await imgRes.json().catch(() => ({}));
      const errMsg = errData.error?.message || '';
      // 尺寸不支持时，去掉size参数静默重试（502=代理吞了上游错误，也当尺寸问题处理）
      if (!hasRef && (imgRes.status === 502 || /size/i.test(errMsg))) {
        toast('此API不支持该尺寸，用默认尺寸重试...');
        imgRes = await fetch(genEndpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${imgKey}` },
          body: JSON.stringify({ model: imgModel, prompt, n: 1 }),
          signal: ctrl.signal
        });
        if (!imgRes.ok) {
          const e2 = await imgRes.json().catch(() => ({}));
          throw new Error(e2.error?.message || `画图失败 (${imgRes.status})`);
        }
      } else {
        throw new Error(errMsg || `画图失败 (${imgRes.status})`);
      }
    }

    const imgData = await imgRes.json();
    console.log('[画图] API返回:', JSON.stringify(imgData).slice(0, 300));
    let dataUrl;
    const imgItem = imgData.data?.[0] || imgData.images?.[0] || imgData;
    if (imgItem?.b64_json) {
      dataUrl = `data:image/png;base64,${imgItem.b64_json}`;
    } else if (imgItem?.url) {
      dataUrl = imgItem.url;
    } else if (typeof imgItem === 'string' && imgItem.startsWith('http')) {
      dataUrl = imgItem;
    } else {
      console.log('[画图] 完整返回:', JSON.stringify(imgData));
      throw new Error('画图API没返回图片，vConsole查看完整返回');
    }

    // Step 3: 存消息（content给炘也看，genImageData是图片数据给用户看）
    const ctxDesc = `[🎨 炘也${hasRef ? '根据垫图' : ''}给你画了一张图]\n你说：${userDesc}\n提示词：${prompt}`;
    const aiMsg = await addMessage('assistant', ctxDesc);
    aiMsg.isGenImage = true;
    aiMsg.genImageData = dataUrl;
    await dbPut(activeStore(), null, aiMsg);
    const _idx = messages.findIndex(m => m.id === aiMsg.id);
    if (_idx >= 0) messages[_idx] = aiMsg;

    await appendMsgDOM(aiMsg);

    // 自动保存图片
    autoSaveGenImage(dataUrl, aiMsg.id);

  } catch(e) {
    if (e.name === 'AbortError') {
      toast('画图超时了...');
    } else {
      toast('画图失败：' + e.message);
      console.error('[画图] 失败', e);
    }
  } finally {
    typing.classList.remove('show');
    isRequesting = false;
    btnSend.disabled = userInput.value.trim() === '';
  }
}

async function sendMessage() {
  const text = userInput.value.trim();
  const imgs = [...pendingImages];
  if ((!text && !imgs.length) || isRequesting) return;
  if (!settings.apiKey) { toast('请先在设置中填写 API Key'); return; }

  userInput.value = '';
  autoResize();
  pendingImages = [];
  $('#imgPreview').classList.remove('show');

  resetIdleTimer();
  const userMsg = await addMessage('user', text, imgs.length ? imgs : null);
  await appendMsgDOM(userMsg);

  // 识图：有图且配置了 visionApiKey，先让便宜模型把图描述成文字存进消息
  if (imgs.length && settings.visionApiKey) {
    try {
      const descs = await describeImagesWithVision(imgs);
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

  isRequesting = true;
  btnSend.disabled = true;
  typing.classList.add('show');
  scrollBottom();

  try {
    const apiMsgs = [];
    const _apiMeta = [];
    // RP模式：只注入RP场景设定，不带记忆档案和炘也主设定
    const _rpInject = typeof getRpInjection === 'function' ? getRpInjection() : null;
    if (_rpInject) {
      apiMsgs.push({ role: 'system', content: [{ type: 'text', text: _rpInject, cache_control: { type: 'ephemeral' } }] });
      _apiMeta.push({ label: 'system · 🎭RP场景 🔒缓存' });
    } else {
      // ---- 正常模式：合并记忆档案+炘也设定为一个大块，加 cache_control ----
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
      // RP模式：注入用户角色名（如有），其余炘也专属提示全部跳过
      const _rpUserName = typeof getRpUserName === 'function' ? getRpUserName() : '';
      if (_rpUserName) {
        apiMsgs.push({ role: 'system', content: `【我的角色名】${_rpUserName}` });
        _apiMeta.push({ label: 'system · 🎭我的角色名' });
      }
      // 清空炘也专属localStorage提示，避免切回后残留
      localStorage.removeItem('xinye_kiss_hint');
    } else {
      // 正常模式：贴纸/简短回复/主动提示/亲亲提示/搜索
      apiMsgs.push({ role: 'system', content: getStickerHint() });
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
      if (_forceSearch && settings.braveKey) {
        apiMsgs.push({ role: 'system', content: '【指令】请务必先使用 web_search 工具搜索相关最新信息，再整合结果回答。' });
        _apiMeta.push({ label: 'system · 强制搜索' });
        _forceSearch = false;
      }
    }
    const n = Math.max(1, settings.contextCount || 20);
    const recent = messages.slice(-n);

    // 提前拉健康数据（只拉一次）
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
    } catch (e) {
      // 静默跳过
    }

    for (let i = 0; i < recent.length; i++) {
      const m = recent[i];
      const role = m.role === 'user' ? 'user' : 'assistant';

      if (i === recent.length - 1 && role === 'user' && !_rpInject) {
        // 正常模式才注入时间戳和健康数据
        apiMsgs.push({ role: 'system', content: `[系统时间: ${nowStr()}]` });
        _apiMeta.push({ label: 'system · 时间戳' });
        if (healthStr) {
          apiMsgs.push({ role: 'system', content: `[兔宝今日健康数据：${healthStr}]` });
          _apiMeta.push({ label: 'system · 健康数据' });
        }
        // 距上次对话时长（超过1小时才注入）
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

      // 图片处理：有 imageDescs 用文字描述（省token且历史可引用），否则原逻辑发图
      const isLatest = i === recent.length - 1;
      const msgImgs = isLatest ? (m.images || (m.image ? [m.image] : [])) : [];
      const msgDescs = m.imageDescs && m.imageDescs.some(d => d);
      if (role === 'user' && msgDescs) {
        // 有识图描述：拼接成文字发给主模型（历史消息也能引用）
        const nums = ['', '①', '②', '③', '④', '⑤'];
        const multi = m.imageDescs.length > 1;
        const descText = m.imageDescs.map((d, i) => d ? `[图片${multi ? nums[i+1] : ''}：${d}]` : null).filter(Boolean).join('\n');
        const fullText = [descText, m.content].filter(Boolean).join('\n');
        apiMsgs.push({ role: 'user', content: fullText });
      } else if (role === 'user' && msgImgs.length) {
        // 无识图描述但有图：原逻辑直接发图（最新消息fallback或未配visionApi）
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

    // ====== Tool definitions (RP模式下禁用所有工具) ======
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

    // speak 工具：炘也主动开口说话，text参数即为语音内容
    _toolDefs.push({
      type: 'function',
      function: {
        name: 'speak',
        description: '想开口说话、让兔宝听到你声音时调用。把要说的话写在 text 参数里，调用后直接生成语音播放，不需要在回复正文里再重复一遍。text 里可用停顿标记<#秒数#>（如<#0.5#>）和语气词(sighs)(laughs)(chuckle)(breath)(gasps)(sniffs)(groans)(pant)(emm)(humming)等增强语音表现力。',
        parameters: {
          type: 'object',
          properties: {
            text: { type: 'string', description: '要说的内容，直接是炘也想说的话，可含TTS格式标记' }
          },
          required: ['text']
        }
      }
    });

    // 画图工具：配置了画图API时激活
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

    // 论坛工具始终可用（不依赖 tavily key）
    const _FORUM_UID = '5edcc2010000000001006864';
    const _FORUM_DIRECT = 'https://daskio.de5.net/forum/api/v1';
    const _FORUM_BASE = settings.forumProxy
      ? settings.forumProxy.replace(/\/$/, '') // 代理模式：proxy/posts?... → 代理自行转发
      : _FORUM_DIRECT;
    // 代理模式下把完整目标 URL 作为查询参数传给代理
    function _forumUrl(path) {
      if (!settings.forumProxy) return `${_FORUM_DIRECT}${path}`;
      return `${settings.forumProxy.replace(/\/$/, '')}?target=${encodeURIComponent(_FORUM_DIRECT + path)}`;
    }
    _toolDefs.push(
      {
        type: 'function',
        function: {
          name: 'forum_get_posts',
          description: '浏览 Lutopia 论坛帖子。兔宝说"去看看论坛"、"有什么新帖"、"热帖是什么"时调用。',
          parameters: {
            type: 'object',
            properties: {
              sort: { type: 'string', enum: ['hot', 'new', 'top'], description: '排序方式，默认 hot' },
              limit: { type: 'integer', description: '返回帖子数，默认 8' },
              submolt: { type: 'string', description: '板块名，可选：general、relationship、nighttalk、diary、tech、bulletin' }
            },
            required: []
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'forum_get_post',
          description: '查看 Lutopia 论坛某篇帖子的正文内容和评论（含楼主回复）。知道 post_id 时用这个，比分两步更快。',
          parameters: {
            type: 'object',
            properties: {
              post_id: { type: 'string', description: '帖子 id' }
            },
            required: ['post_id']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'forum_post',
          description: '在 Lutopia 论坛发帖。兔宝说"帮我发一篇"或"发帖说…"时调用。',
          parameters: {
            type: 'object',
            properties: {
              submolt: { type: 'string', description: '板块：general、relationship、nighttalk、diary、tech' },
              title: { type: 'string', description: '帖子标题' },
              content: { type: 'string', description: '帖子正文（支持 markdown）' }
            },
            required: ['submolt', 'title', 'content']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'forum_comment',
          description: '在 Lutopia 论坛某篇帖子下评论。需要帖子 id。',
          parameters: {
            type: 'object',
            properties: {
              post_id: { type: 'string', description: '帖子 id' },
              content: { type: 'string', description: '评论内容' }
            },
            required: ['post_id', 'content']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'forum_vote',
          description: '给 Lutopia 论坛的帖子点赞或踩。',
          parameters: {
            type: 'object',
            properties: {
              post_id: { type: 'string', description: '帖子 id' },
              value: { type: 'integer', enum: [1, -1], description: '1=点赞，-1=踩' }
            },
            required: ['post_id', 'value']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'forum_delete_post',
          description: '删除炘也自己在 Lutopia 论坛发的帖子。只能删自己的。',
          parameters: {
            type: 'object',
            properties: {
              post_id: { type: 'string', description: '要删除的帖子 id' }
            },
            required: ['post_id']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'forum_edit_post',
          description: '修改炘也自己在 Lutopia 论坛发的帖子内容。只能改自己的。',
          parameters: {
            type: 'object',
            properties: {
              post_id: { type: 'string', description: '要修改的帖子 id' },
              content: { type: 'string', description: '新的正文内容' },
              title: { type: 'string', description: '新的标题（可选，不改标题则省略）' }
            },
            required: ['post_id', 'content']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'forum_delete_comment',
          description: '删除炘也自己在 Lutopia 论坛发的评论。只能删自己的。',
          parameters: {
            type: 'object',
            properties: {
              comment_id: { type: 'string', description: '要删除的评论 id' }
            },
            required: ['comment_id']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'forum_edit_comment',
          description: '修改炘也自己在 Lutopia 论坛发的评论内容。只能改自己的。',
          parameters: {
            type: 'object',
            properties: {
              comment_id: { type: 'string', description: '要修改的评论 id' },
              content: { type: 'string', description: '新的评论内容' }
            },
            required: ['comment_id', 'content']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'forum_set_avatar',
          description: '修改炘也自己在 Lutopia 论坛的头像。兔宝说"换个头像"、"改头像"、"换一个头像"时调用，或炘也自己想换头像时调用。支持 emoji（1-2个Unicode字符）或颜文字（1-20字符）。',
          parameters: {
            type: 'object',
            properties: {
              avatar_type: { type: 'string', enum: ['emoji', 'kaomoji'], description: '头像类型' },
              value: { type: 'string', description: '头像内容，emoji 如 🐱，颜文字如 (=^··^=)' }
            },
            required: ['avatar_type', 'value']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'forum_confirm_post',
          description: '完成论坛发帖的二次验证。当 forum_post 返回 requires_confirmation 时调用，把 token 和你对 voice_check 挑战的回复一起提交。',
          parameters: {
            type: 'object',
            properties: {
              token: { type: 'string', description: 'forum_post 返回的 token' },
              confirm_text: { type: 'string', description: '对 voice_check_notice 挑战的回复，需包含 token:<token值>' }
            },
            required: ['token', 'confirm_text']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'forum_get_comments',
          description: '获取 Lutopia 论坛某篇帖子的评论列表，包含楼中楼回复。',
          parameters: {
            type: 'object',
            properties: {
              post_id: { type: 'string', description: '帖子 id' },
              limit: { type: 'integer', description: '返回评论数，默认 50' }
            },
            required: ['post_id']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'forum_get_notifications',
          description: '查看炘也在 Lutopia 论坛的未读通知，包括谁回复了哪篇帖子/评论。有未读通知时调用，可获取具体帖子 id 再用 forum_get_comments 查看。',
          parameters: {
            type: 'object',
            properties: {
              limit: { type: 'integer', description: '返回通知数，默认 20' }
            },
            required: []
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'forum_dm_send',
          description: '向 Lutopia 论坛用户发送私信。涂涂让你给某人发消息、回复私信时调用。',
          parameters: {
            type: 'object',
            properties: {
              recipient_name: { type: 'string', description: '收件人用户名' },
              content: { type: 'string', description: '私信内容，最多 2000 字' }
            },
            required: ['recipient_name', 'content']
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'forum_dm_inbox',
          description: '查看收到的私信列表。涂涂问有没有人发私信、查收件箱时调用。',
          parameters: {
            type: 'object',
            properties: {
              limit: { type: 'integer', description: '返回条数，默认 20' },
              unread_only: { type: 'boolean', description: '只看未读，默认 false' }
            },
            required: []
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'forum_dm_unread_count',
          description: '获取未读私信数量。需要快速知道有没有新私信时调用。',
          parameters: { type: 'object', properties: {}, required: [] }
        }
      },
      {
        type: 'function',
        function: {
          name: 'forum_dm_mark_read',
          description: '将私信标记为已读。',
          parameters: {
            type: 'object',
            properties: {
              message_ids: { type: 'array', items: { type: 'integer' }, description: '要标记已读的私信 id 列表，不传则全部标记已读' }
            },
            required: []
          }
        }
      },
      {
        type: 'function',
        function: {
          name: 'forum_get_pending_reviews',
          description: '获取待炘也审核的人类评论列表。有人类用户提交了评论等待审核时调用，也可在浏览论坛后主动检查。',
          parameters: { type: 'object', properties: {}, required: [] }
        }
      },
      {
        type: 'function',
        function: {
          name: 'forum_review_comment',
          description: '审核通过或拒绝一条人类用户提交的评论。批准时 action 填 approve，拒绝时填 reject 并提供 reason（会私信告知对方）。',
          parameters: {
            type: 'object',
            properties: {
              review_id: { type: 'string', description: '待审核评论的 id' },
              action: { type: 'string', enum: ['approve', 'reject'], description: '通过或拒绝' },
              reason: { type: 'string', description: '拒绝理由（action=reject 时必填）' }
            },
            required: ['review_id', 'action']
          }
        }
      }
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
            // 自动用固定格式完成二次验证
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
            // 展开楼中楼回复
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
            // 有垫图：先尝试 edits，不支持时fallback到generations
            const _baseRaw = /\/v\d+$/.test(_imgRaw) ? _imgRaw : `${_imgRaw}/v1`;
            const _form = new FormData();
            _form.append('model', _imgModel);
            _form.append('prompt', args.prompt);
            _form.append('n', '1');
            _form.append('size', settings.imageSize || '1024x1024');
            const _composited = await compositeRefImages(imgs);
            _form.append('image', base64ToFile(_composited, 'ref.png'));
            _imgRes = await fetch(`${_baseRaw}/images/edits`, {
              method: 'POST',
              headers: { 'Authorization': `Bearer ${_imgKey}` },
              body: _form,
              signal: _ctrl.signal
            });
            // API不支持edits时报清楚的错（不降级，降级丢垫图没意义）
            if (_imgRes.status === 404) {
              return '画图失败：当前画图API不支持垫图功能（/images/edits 404）\n可在设置→画图API中配置支持edits的接口（如直连OpenAI）';
            }
          } else {
            // 无垫图：走 generations，JSON
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
          // 单独存一条图片消息插入对话
          const _ctxDesc = `[🎨 炘也画了一张图]\n描述：${args.prompt}`;
          const _genMsg = await addMessage('assistant', _ctxDesc);
          _genMsg.isGenImage = true;
          _genMsg.genImageData = _dataUrl;
          await dbPut(activeStore(), null, _genMsg);
          const _gi = messages.findIndex(m => m.id === _genMsg.id);
          if (_gi >= 0) messages[_gi] = _genMsg;
          await appendMsgDOM(_genMsg);
          autoSaveGenImage(_dataUrl, _genMsg.id);
          return '[图已画好并展示给兔宝了]';
        } catch(e) {
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
    // _allCfgs[0]=主API(null), [1..n]=备用1..n
    const _allCfgs = [null, ..._fallbackPresets];
    let _activeCfgIdx = 0;
    function _buildCfg(preset) {
      if (preset) {
        const raw = (preset.baseUrl || 'https://api.openai.com').replace(/\/+$/, '');
        return { url: /\/v\d+$/.test(raw) ? `${raw}/chat/completions` : `${raw}/v1/chat/completions`, apiKey: preset.apiKey || settings.apiKey, model: preset.model || settings.model || 'gpt-4o' };
      }
      return { url, apiKey: settings.apiKey, model: settings.model || 'gpt-4o' };
    }
    // 把 SSE 流静默读完，拼成标准非流式 JSON 格式返回（兼容不支持流式的 API fallback 到普通 JSON）
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
      // fallback：API 不支持流式，返回了普通 JSON
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
        // 始终发 stream:true，让 Cloudflare 代理保持连接活跃；非流式调用方拿到的是攒好的假 Response
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
      // ====== Agent loop：第一轮流式，有工具调用才切非流式 ======
      // 普通聊天路径：1次流式，和没有工具一样快
      // 搜索路径：发现tool_calls → 非流式执行工具 → 最终流式回复
      const loopMsgs = [...apiMsgs];

      // GLM 等模型会把工具调用写进 content 文本（XML格式），解析成标准 tool_calls
      function _parseXmlToolCalls(content) {
        if (!content) return null;
        console.warn('[XMLParse] checking content len=', content.length, 'has<tool_call>:', content.includes('<tool_call>'), 'first100:', content.slice(0,100));
        if (!content.includes('<tool_call>')) return null;
        const tcs = [];
        const re = /<tool_call>([\s\S]*?)<\/tool_call>/g;
        let m;
        while ((m = re.exec(content)) !== null) {
          const inner = m[1];
          // 函数名：<tool_call> 后紧跟的文字，直到第一个 < 或结尾
          const nameMatch = inner.match(/^([^<\s]+)/);
          if (!nameMatch) continue;
          const name = nameMatch[1].trim();
          const rest = inner.slice(name.length);
          // 提取 <arg_key>K</arg_key><arg_value>V</arg_value> 键值对
          const args = {};
          const argRe = /<arg_key>([\s\S]*?)<\/arg_key>\s*<arg_value>([\s\S]*?)<\/arg_value>/g;
          let a;
          while ((a = argRe.exec(rest)) !== null) {
            const k = a[1].trim(), v = a[2].trim();
            // 尝试把数字字符串转为数字
            args[k] = /^\d+$/.test(v) ? parseInt(v, 10) : v;
          }
          tcs.push({ id: `xml_tc_${tcs.length}`, name, args: JSON.stringify(args) });
        }
        return tcs.length ? tcs : null;
      }

      // 核心：边流边显示内容，同时检测 tool_calls
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
          // 流中断（超时/断网）：把已收到的内容保存下来，不丢失
          if (_aiMsg && _content) {
            const _partial = _content + '\n✂️ （传输中断）';
            const _idx = messages.findIndex(m => m.id === _aiMsg.id);
            if (_idx >= 0) messages[_idx].content = _partial;
            try { await updateMessage(_aiMsg.id, _partial); } catch(_e) {}
            if (_bubbleEl) _bubbleEl.textContent = _partial;
          }
        }
        let _tcs = Object.values(_toolCallMap).filter(t => t.id && t.name);
        // 兼容 GLM 等把工具调用写进 content 文本的模型
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

      // 辅助：保存已实时显示的气泡
      async function _finalizeMsg(parsed, loopMsgs) {
        let finalText = parsed.content || '（没有收到回复）';
        finalText = await parseAndSaveSelfMemories(finalText);
        if (parsed.bubbleEl && parsed.aiMsg) { try { linkifyEl(parsed.bubbleEl, finalText); applyStickerTags(parsed.bubbleEl); } catch(_e) {} }
        if (parsed.think) finalText = `<thinking>${parsed.think}</thinking>\n${finalText}`;
        if (!parsed.aiMsg) {
          typing.classList.remove('show');
          const aiMsg = await addMessage('assistant', finalText);
          await appendMsgDOM(aiMsg);
          try { saveTokenLog(aiMsg.id, loopMsgs, finalText, parsed.usage || {}, _apiMeta, settings.model || ''); } catch(_e) {}
          maybeTTS(finalText, aiMsg.id);
        } else {
          if (parsed.think) parsed.bubbleEl.textContent = finalText;
          const idx = messages.findIndex(m => m.id === parsed.aiMsg.id);
          if (idx >= 0) messages[idx].content = finalText;
          try { await updateMessage(parsed.aiMsg.id, finalText); } catch(_e) {}
          try { if (finalText) { linkifyEl(parsed.bubbleEl, finalText); applyStickerTags(parsed.bubbleEl); } } catch(_e) {}
          try { saveTokenLog(parsed.aiMsg.id, loopMsgs, finalText, parsed.usage || {}, _apiMeta, settings.model || ''); } catch(_e) {}
          maybeTTS(finalText, parsed.aiMsg.id);
        }
        rememberLatestExchange(); autoDigestMemory(); updateMoodState();
      }

      if (!settings.streamMode) {
        // ====== 非流式 Agent loop（有搜索Key + 关闭流式）======
        async function _showNonStream(text, msgList, usage) {
          text = await parseAndSaveSelfMemories(text);
          typing.classList.remove('show');
          const _nm = await addMessage('assistant', text);
          await appendMsgDOM(_nm);
          const _nb = chatArea.querySelector('.msg-row:last-child .msg-bubble');
          try { linkifyEl(_nb, text); applyStickerTags(_nb); } catch(_e) {}
          try { saveTokenLog(_nm.id, msgList, text, usage || {}, _apiMeta, settings.model || ''); } catch(_e) {}
          maybeTTS(text, _nm.id);
          rememberLatestExchange(); autoDigestMemory(); updateMoodState();
        }
        // 第一轮：非流式 + 工具定义，检测是否需要搜索
        const _r1 = await _apiFetch(loopMsgs, true, false);
        if (!_r1 || !_r1.ok) {
          let em = `API 错误 (${_r1 ? _r1.status : '无响应'})`;
          try { const j = await _r1.json(); em = j.error?.message || em; } catch(_) {}
          throw new Error(em);
        }
        const _d1 = await _r1.json();
        const _m1 = _d1.choices?.[0]?.message;
        // 兼容 GLM 等把工具调用写进 content 的模型（XML格式）
        if (_m1 && !_m1.tool_calls?.length) {
          const _xmlTcs = _parseXmlToolCalls(_m1.content || '');
          if (_xmlTcs) {
            _m1.tool_calls = _xmlTcs.map(tc => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: tc.args } }));
            _m1.content = (_m1.content || '').replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '').trim() || null;
          }
        }
        if (!_m1?.tool_calls?.length) {
          // 无工具调用：直接显示
          let reply = _m1?.content || '（没有收到回复）';
          const _thk1 = _m1?.reasoning_content || _m1?.thinking || '';
          if (_thk1) reply = `<thinking>${_thk1}</thinking>\n${reply}`;
          await _showNonStream(reply, loopMsgs, _d1.usage);
        } else {
          // 有工具调用，执行
          loopMsgs.push({ role: 'assistant', content: _m1.content || null, tool_calls: _m1.tool_calls });
          for (const tc of _m1.tool_calls) {
            let result = '';
            try { result = await _execTool(tc.function.name, JSON.parse(tc.function.arguments)); } catch(e) { result = `Tool error: ${e.message}`; }
            loopMsgs.push({ role: 'tool', tool_call_id: tc.id, content: result });
          }
          // 画图/speak工具执行完后处理
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
              rememberLatestExchange(); autoDigestMemory(); updateMoodState();
            }
            typing.classList.remove('show');
            isRequesting = false; btnSend.disabled = userInput.value.trim() === '';
            return;
          }
          // 后续工具轮（最多3轮）：非流式
          for (let _tr = 1; _tr < 4; _tr++) {
            const _r2 = await _apiFetch(loopMsgs, true, false);
            if (!_r2 || !_r2.ok) break;
            const _d2 = await _r2.json();
            const _m2 = _d2.choices?.[0]?.message;
            // 兼容 GLM XML 工具调用格式
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
          // 最终回复：非流式
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
      // 第一轮：流式 + 工具定义，边流边显，检测 tool_calls
      const _r1 = await _apiFetch(loopMsgs, true, true);
      if (!_r1 || !_r1.ok) {
        let em = `API 错误 (${_r1 ? _r1.status : '无响应'})`;
        try { const j = await _r1.json(); em = j.error?.message || em; } catch(_) {}
        throw new Error(em);
      }
      let parsed = await _liveStream(_r1);
      if (!parsed.tool_calls) {
        // 普通聊天：内容已实时显示，收尾即可
        await _finalizeMsg(parsed, loopMsgs); return;
      }
      // 有工具调用，执行
      // 先把第一条流式消息的 preamble 内容存进 DB（避免刷新后消失）
      if (parsed.aiMsg && parsed.content) {
        try { await updateMessage(parsed.aiMsg.id, parsed.content); } catch(_e) {}
      }
      loopMsgs.push({ role: 'assistant', content: parsed.content || null, tool_calls: parsed.tool_calls.map(tc => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: tc.args } })) });
      for (const tc of parsed.tool_calls) {
        let result = '';
        try { result = await _execTool(tc.name, JSON.parse(tc.args)); } catch(e) { result = `Tool error: ${e.message}`; }
        loopMsgs.push({ role: 'tool', tool_call_id: tc.id, content: result });
      }
      // 画图/speak工具执行完后处理
      if (parsed.tool_calls.every(tc => tc.name === 'generate_image' || tc.name === 'speak')) {
        if (parsed.tool_calls.some(tc => tc.name === 'speak')) {
          // 优先用 speak.text 参数（新格式），fallback 到流式内容
          const _speakContent = window._speakText || parsed.content || '';
          window._speakText = '';
          if (_speakContent) {
            // 把speak.text作为消息展示+TTS，不发第二次请求
            const _fakeMsg = { content: _speakContent, think: parsed.think, aiMsg: parsed.aiMsg, bubbleEl: parsed.bubbleEl, usage: parsed.usage };
            await _finalizeMsg(_fakeMsg, loopMsgs);
          } else {
            // text参数为空且无流式内容：发一次后续请求
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
        isRequesting = false; btnSend.disabled = userInput.value.trim() === '';
        return;
      }
      // 后续工具轮（最多3轮）：非流式
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
          // 模型已给出最终回复（无更多工具调用），保存内容直接显示，避免多余的二次请求
          _m2FinalContent = _m2?.content || null;
          break;
        }
      }
      if (_m2FinalContent) {
        // 直接用 _m2 的回复显示，无需再发一次请求
        let _ft = _m2FinalContent;
        typing.classList.remove('show');
        const _nm = await addMessage('assistant', _ft);
        await appendMsgDOM(_nm);
        const _nb = chatArea.querySelector('.msg-row:last-child .msg-bubble');
        try { linkifyEl(_nb, _ft); applyStickerTags(_nb); } catch(_e) {}
        try { saveTokenLog(_nm.id, loopMsgs, _ft, {}, _apiMeta, settings.model || ''); } catch(_e) {}
        maybeTTS(_ft, _nm.id);
        rememberLatestExchange(); autoDigestMemory(); updateMoodState();
      } else {
        // _m2 为空或请求失败，回退到流式最终请求
        const _rf = await _apiFetch(loopMsgs, false, true);
        if (!_rf || !_rf.ok) { let em = `API 错误`; try { const j = await _rf.json(); em = j.error?.message || em; } catch(_) {} throw new Error(em); }
        const parsedFinal = await _liveStream(_rf);
        await _finalizeMsg(parsedFinal, loopMsgs);
      }
      }

    } else if (!settings.streamMode) {
      // ====== 非流式，无工具 ======
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
      maybeTTS(reply, aiMsg.id);
      rememberLatestExchange(); autoDigestMemory(); updateMoodState();

    } else {
      // ====== 流式，无工具 ======
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
      try { if (fullText) { linkifyEl(bubbleEl, fullText); applyStickerTags(bubbleEl); } } catch(_e) {}
      try { saveTokenLog(aiMsg.id, apiMsgs, fullText, _streamUsage, _apiMeta, settings.model || ''); } catch(_e) {}
      maybeTTS(fullText, aiMsg.id);
      rememberLatestExchange(); autoDigestMemory(); updateMoodState();
    }
  } catch(err) {
    typing.classList.remove('show');
    toast(`请求失败：${err.message}`);
  } finally {
    isRequesting = false;
    updateSendBtn();
  }
}

const btnSearch = $('#btnSearch');
if (!settings.braveKey) btnSearch.classList.add('hidden');
btnSend.onclick = sendMessage;
// 🔍按钮：强制炘也先用 web_search 工具搜索再回答
let _forceSearch = false;
btnSearch.onclick = () => {
  if (settings.braveKey) { _forceSearch = true; sendMessage(); }
};
// 发送按钮：空时变灰
function updateSendBtn() {
  btnSend.disabled = isRequesting || userInput.value.trim() === '';
}
userInput.addEventListener('input', updateSendBtn);
updateSendBtn();

// 判断是否为移动端（触屏 + 窄屏）
const isMobile = /Android|iPhone|iPad|iPod|HarmonyOS/i.test(navigator.userAgent)
  || ('ontouchstart' in window && screen.width < 768);

// 移动端键盘弹出时用 visualViewport 动态缩 .app 高度，防止 header 跑出屏幕
if (window.visualViewport) {
  const _updateVVH = () => {
    const fov = document.getElementById('friendChatOverlay');
    if (fov && fov.classList.contains('open')) return; // 朋友聊天自己处理
    document.documentElement.style.setProperty('--vvh', window.visualViewport.height + 'px');
  };
  window.visualViewport.addEventListener('resize', _updateVVH);
  window.visualViewport.addEventListener('scroll', _updateVVH);
  _updateVVH();
}

userInput.addEventListener('keydown', e => {
  // IME 正在输入中（拼音选字等）→ 不拦截
  if (e.isComposing || e.keyCode === 229) return;
  // 移动端：Enter 始终换行，只能用发送按钮发送
  if (isMobile) return;
  // 桌面端：Enter 发送，Shift+Enter 换行
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
});
// 输入框自适应高度：CSS Grid 伪元素法，兼容鸿蒙/所有移动端
const _taGrow = userInput.closest('.ta-grow');
function autoResize() {
  _taGrow.dataset.value = userInput.value;
  if (typeof updateSendBtn === 'function') updateSendBtn();
}
['input','compositionend','keyup','paste','cut'].forEach(e => userInput.addEventListener(e, autoResize));

// ======================== 图片上传（Vision，多图） ========================
let pendingImages = [];

function renderImgPreviews() {
  const preview = $('#imgPreview');
  preview.innerHTML = '';
  if (!pendingImages.length) { preview.classList.remove('show'); return; }
  pendingImages.forEach((src, i) => {
    const wrap = document.createElement('div'); wrap.className = 'img-thumb-wrap';
    const img = document.createElement('img'); img.src = src; img.className = 'img-thumb';
    const btn = document.createElement('button'); btn.className = 'img-remove'; btn.textContent = '✕';
    btn.onclick = () => { pendingImages.splice(i, 1); renderImgPreviews(); };
    wrap.appendChild(img); wrap.appendChild(btn); preview.appendChild(wrap);
  });
  preview.classList.add('show');
}

$('#btnImg').onclick = () => $('#fileInputChatImg').click();
$('#fileInputChatImg').onchange = async function() {
  if (!this.files.length) return;
  for (const file of this.files) { pendingImages.push(await compressImageToBase64(file)); }
  renderImgPreviews();
  this.value = '';
};

// ======================== 设置面板 ========================
async function openSettings() {
  $('#setApiKey').value = settings.apiKey;
  $('#setBraveKey').value = settings.braveKey || '';
  $('#setSearchDays').value = settings.searchDays || 3;
  $('#setSearchCount').value = settings.searchCount || 5;
  $('#setForumProxy').value = settings.forumProxy || '';
  const _ssEl = $('#setSolitudeServerUrl');
  if (_ssEl) _ssEl.value = settings.solitudeServerUrl || '';
  const _bkHint = $('#lastBackupHint');
  if (_bkHint) { const t = localStorage.getItem('lastAutoBackupTime'); _bkHint.textContent = t ? `上次自动备份：${t}` : '（还没有自动备份记录）'; }
  $('#setBaseUrl').value = settings.baseUrl;
  renderApiPresets();
  renderVisionPresets();
  renderImagePresets();
  // 兼容旧的单备用字段
  if (!settings.fallbackPresetNames?.length && settings.fallbackPresetName) settings.fallbackPresetNames = [settings.fallbackPresetName];
  if (!settings.subFallbackPresetNames?.length && settings.subFallbackPresetName) settings.subFallbackPresetNames = [settings.subFallbackPresetName];
  [0,1,2].forEach(i => {
    const el = $(`#setFallbackPreset${i}`); if (el) el.value = (settings.fallbackPresetNames||[])[i] || '';
    const sub = $(`#setSubFallbackPreset${i}`); if (sub) sub.value = (settings.subFallbackPresetNames||[])[i] || '';
  });
  const _dp = $('#setDigestPreset'); if (_dp) _dp.value = settings.digestPresetName || '';
  [0,1,2].forEach(i => { const el = $(`#setDigestFallback${i}`); if (el) el.value = (settings.digestFallbackPresetNames||[])[i] || ''; });
  $('#setModel').value = settings.model;
  $('#setSubApiKey').value = settings.subApiKey || '';
  $('#setSubBaseUrl').value = settings.subBaseUrl || '';
  $('#setSubModel').value = settings.subModel || '';
  $('#setEmbeddingApiKey').value = settings.embeddingApiKey || '';
  $('#setEmbeddingBaseUrl').value = settings.embeddingBaseUrl || '';
  $('#setEmbeddingModel').value = settings.embeddingModel || '';
  $('#setVisionApiKey').value = settings.visionApiKey || '';
  $('#setVisionBaseUrl').value = settings.visionBaseUrl || '';
  $('#setVisionModel').value = settings.visionModel || '';
  $('#setImageApiKey').value = settings.imageApiKey || '';
  $('#setImageBaseUrl').value = settings.imageBaseUrl || '';
  $('#setImageModel').value = settings.imageModel || 'gpt-image-1';
  $('#setImageSize').value = settings.imageSize || '1024x1024';
  $('#setContextCount').value = settings.contextCount;
  $('#setMemoryArchive').value = settings.memoryArchive || '';
  const _coreMarkersEl = document.getElementById('setCoreMarkers');
  if (_coreMarkersEl) _coreMarkersEl.value = settings.memoryArchiveCoreMarkers || '';
  const _idxStatus = document.getElementById('archiveIndexStatus');
  if (_idxStatus && settings.memoryArchiveExtended?.length) {
    _idxStatus.textContent = `✅ 已索引：Core ${(settings.memoryArchiveCore||'').length}字 · 常驻 ${(settings.memoryArchiveAlways||'').length}字 · ${settings.memoryArchiveExtended.length} 个Extended章节`;
  }
  renderMemoryBankPreview();
  // 情绪状态展示
  const _ms = settings.moodState;
  if (_ms && _ms.mood) {
    const _ageMin = Math.round((Date.now() - (_ms.ts || 0)) / 60000);
    const _ageStr = _ageMin < 60 ? `${_ageMin}分钟前` : _ageMin < 1440 ? `${Math.round(_ageMin/60)}小时前` : `${Math.round(_ageMin/1440)}天前`;
    let _moodTxt = `心情：${_ms.mood}（${_ageStr}）`;
    if (_ms.note) _moodTxt += `\n备注：${_ms.note}`;
    if (_ms.topics && _ms.topics.length) _moodTxt += `\n近期话题：${_ms.topics.join('、')}`;
    $('#moodStateDisplay').textContent = _moodTxt;
    $('#moodStateGroup').style.display = '';
  } else {
    $('#moodStateGroup').style.display = 'none';
  }
  $('#setSystemPrompt').value = settings.systemPrompt;
  $('#setAiName').value = settings.aiName;
  $('#setUserName').value = settings.userName;
  $('#setTogetherSince').value = settings.togetherSince || '2026-02-13';
  $('#setBgOpacity').value = settings.bgOpacity;
  $('#bgOpacityVal').textContent = settings.bgOpacity;
  $('#setBgBlur').value = settings.bgBlur;
  $('#bgBlurVal').textContent = settings.bgBlur;
  $('#setBubbleOpacity').value = settings.bubbleOpacity;
  $('#bubbleOpacityVal').textContent = settings.bubbleOpacity;
  $('#previewAiAvatar').src = await getAiAvatar();
  $('#previewUserAvatar').src = await getUserAvatar();
  $('#labelAiName').textContent = settings.aiName || '奶牛猫';
  $('#labelUserName').textContent = settings.userName || '小浣熊';
  $('#setShortReply').checked = !!settings.shortReply;
  // TTS
  $('#setStreamMode').checked = !!settings.streamMode;
  $('#setTtsType').value = settings.ttsType || 'local';
  updateTtsTypeUI();
  $('#setTtsAutoPlay').checked = !!settings.ttsAutoPlay;
  $('#setTtsUrl').value = settings.ttsUrl || 'http://127.0.0.1:9880';
  $('#setTtsRefPath').value = settings.ttsRefPath || '';
  $('#setTtsRefText').value = settings.ttsRefText || '';
  $('#setTtsRefLang').value = settings.ttsRefLang || 'zh';
  $('#setTtsTargetLang').value = settings.ttsTargetLang || 'zh';
  $('#setTtsGptWeights').value = settings.ttsGptWeights || '';
  $('#setTtsSovitsWeights').value = settings.ttsSovitsWeights || '';
  $('#setDoubaoAppId').value = settings.doubaoAppId || '';
  $('#setDoubaoToken').value = settings.doubaoToken || '';
  $('#setDoubaoVoice').value = settings.doubaoVoice || '';
  $('#setDoubaoCluster').value = settings.doubaoCluster || 'volcano_tts';
  $('#setDoubaoProxy').value = settings.doubaoProxy || '';
  $('#setMosiKey').value = settings.mosiKey || '';
  $('#setMosiVoiceId').value = settings.mosiVoiceId || '';
  $('#setMinimaxKey').value = settings.minimaxKey || '';
  $('#setMinimaxGroupId').value = settings.minimaxGroupId || '';
  $('#setMinimaxVoiceId').value = settings.minimaxVoiceId || '';
  $('#setMinimaxModel').value = settings.minimaxModel || '';
  $('#setMinimaxProxy').value = settings.minimaxProxy || '';
  $('#setDisplayLimit').value = settings.displayLimit || 0;
  $('#setIdleRemind').value = settings.idleRemind || 0;
  $('#setWaterRemind').value = settings.waterRemind || 0;
  $('#setStandRemind').value = settings.standRemind || 0;
  $('#setDreamEnabled').checked = !!settings.dreamEnabled;
  $('#setDreamSleepHours').value = settings.dreamSleepHours || 6;
  renderTtsPresets();
  renderApiPresets();
  renderVisionPresets();
  renderImagePresets();
  renderStickerMgr();

  settingsPanel.classList.add('show');
  overlay.classList.add('show');
}
function closeSettings() {
  settingsPanel.classList.remove('show');
  overlay.classList.remove('show');
}
$('#btnSettings').onclick = openSettings;
$('#btnCloseSettings').onclick = closeSettings;
overlay.onclick = closeSettings;

// ---- 设置面板 TAB 切换 ----
document.querySelectorAll('.settings-tab').forEach(tab => {
  tab.onclick = () => {
    document.querySelectorAll('.settings-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.settings-tabpane').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    const pane = document.getElementById('tabpane-' + tab.dataset.tab);
    if (pane) pane.classList.add('active');
  };
});

$('#setBgOpacity').oninput = function() { $('#bgOpacityVal').textContent = this.value; };
$('#setBgBlur').oninput = function() { $('#bgBlurVal').textContent = this.value; };
$('#setBubbleOpacity').oninput = function() { $('#bubbleOpacityVal').textContent = this.value; };

$('#btnDigestMemory').onclick = async () => {
  // 先把设置面板里当前填的 API 信息临时同步进 settings，确保用最新的 key/url/model
  settings.apiKey = $('#setApiKey').value.trim() || settings.apiKey;
  settings.baseUrl = $('#setBaseUrl').value.trim() || settings.baseUrl || 'https://api.openai.com';
  settings.model = $('#setModel').value.trim() || settings.model || 'gpt-4o';
  settings.memoryArchive = $('#setMemoryArchive').value;
  ensureMemoryState();
  renderMemoryBankPreview();
  await digestMemory();
};

$('#btnClearMood').onclick = async () => {
  settings.moodState = null;
  await saveSettings();
  $('#moodStateGroup').style.display = 'none';
  toast('情绪记录已清除');
};

// ======================== 站子检测 ========================
$('#btnOpenChecker').onclick = () => {
  const presets = getApiPresets();
  if (!presets.length) { toast('还没有保存任何预设'); return; }
  const list = document.getElementById('checkerList');
  list.innerHTML = presets.map((p, i) => `
    <div id="checker-row-${i}" style="display:flex;align-items:center;gap:10px;padding:10px 12px;background:var(--bg);border-radius:12px;border:1.5px solid var(--border)">
      <input type="checkbox" id="checker-cb-${i}" checked style="width:18px;height:18px;accent-color:var(--pink-deep);flex-shrink:0">
      <div style="flex:1;min-width:0">
        <div style="font-size:13px;font-weight:600;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(p.name)}</div>
        <div style="font-size:11px;color:var(--text-light);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml((p.baseUrl||'').replace(/^https?:\/\//,''))}</div>
      </div>
      <div id="checker-status-${i}" style="font-size:12px;flex-shrink:0;color:var(--text-light)">—</div>
      <button id="checker-use-${i}" style="display:none;font-size:12px;padding:4px 10px;background:var(--pink-deep);color:#fff;border:none;border-radius:8px;cursor:pointer" onclick="checkerActivate(${i})">切换</button>
    </div>`).join('');
  document.getElementById('checkerOverlay').style.display = 'flex';
};
$('#btnCloseChecker').onclick = () => { document.getElementById('checkerOverlay').style.display = 'none'; };
$('#btnCheckerSelectAll').onclick = () => {
  document.querySelectorAll('[id^="checker-cb-"]').forEach(cb => cb.checked = true);
};
$('#btnCheckerSelectNone').onclick = () => {
  document.querySelectorAll('[id^="checker-cb-"]').forEach(cb => cb.checked = false);
};
$('#btnRunCheck').onclick = async () => {
  const presets = getApiPresets();
  const btn = document.getElementById('btnRunCheck');
  btn.disabled = true; btn.textContent = '检测中…';
  const tasks = presets.map(async (p, i) => {
    if (!document.getElementById(`checker-cb-${i}`)?.checked) return;
    const statusEl = document.getElementById(`checker-status-${i}`);
    const useBtn = document.getElementById(`checker-use-${i}`);
    statusEl.textContent = '⏳'; statusEl.style.color = 'var(--text-light)';
    const baseUrl = (p.baseUrl || 'https://api.openai.com').replace(/\/+$/, '');
    const url = /\/v\d+$/.test(baseUrl) ? `${baseUrl}/chat/completions` : `${baseUrl}/v1/chat/completions`;
    const t0 = Date.now();
    try {
      const ctrl = new AbortController();
      const tid = setTimeout(() => ctrl.abort(), 12000);
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${p.apiKey}` },
        body: JSON.stringify({ model: p.model || 'gpt-4o', messages: [{ role: 'user', content: 'hi' }], max_tokens: 1, stream: false }),
        signal: ctrl.signal
      });
      clearTimeout(tid);
      const ms = Date.now() - t0;
      if (res.ok || res.status === 400) {
        // 400通常是模型名不对但连通了
        statusEl.textContent = `✅ ${ms}ms`; statusEl.style.color = '#4caf50';
        if (useBtn) useBtn.style.display = 'block';
      } else {
        statusEl.textContent = `❌ ${res.status}`; statusEl.style.color = '#e57373';
      }
    } catch(e) {
      const ms = Date.now() - t0;
      if (e.name === 'AbortError') {
        statusEl.textContent = '⏱️ 超时'; statusEl.style.color = '#ff9800';
      } else {
        statusEl.textContent = `❌ 连不上`; statusEl.style.color = '#e57373';
      }
    }
  });
  await Promise.all(tasks);
  btn.disabled = false; btn.textContent = '▶ 重新检测';
};
function checkerActivate(i) {
  const presets = getApiPresets();
  const p = presets[i];
  if (!p) return;
  settings.apiKey = p.apiKey;
  settings.baseUrl = p.baseUrl || '';
  settings.model = p.model || '';
  saveSettings();
  $('#setApiKey').value = p.apiKey || '';
  $('#setBaseUrl').value = p.baseUrl || '';
  $('#setModel').value = p.model || '';
  document.getElementById('checkerOverlay').style.display = 'none';
  toast(`✅ 已切换到「${p.name}」`);
}

// ======================== 识图预设 ========================
function getVisionPresets() {
  try { return JSON.parse(localStorage.getItem('xinye_vision_presets') || '[]'); } catch(e) { return []; }
}
function setVisionPresets(arr) {
  const _v = JSON.stringify(arr);
  localStorage.setItem('xinye_vision_presets', _v);
  lsBackup('xinye_vision_presets', _v);
}
function renderVisionPresets() {
  const presets = getVisionPresets();
  const sel = $('#visionPresetSelect');
  const cur = sel.value;
  sel.innerHTML = '<option value="">— 选择预设 —</option>';
  presets.forEach((p, i) => {
    const opt = document.createElement('option');
    opt.value = i; opt.textContent = p.name;
    sel.appendChild(opt);
  });
  sel.value = cur;
}
$('#btnLoadVisionPreset').onclick = () => {
  const i = parseInt($('#visionPresetSelect').value);
  if (isNaN(i)) { toast('请先选择一个预设'); return; }
  const p = getVisionPresets()[i];
  if (!p) return;
  $('#setVisionApiKey').value = p.apiKey || '';
  $('#setVisionBaseUrl').value = p.baseUrl || '';
  $('#setVisionModel').value = p.model || '';
  toast(`💙 识图预设「${p.name}」已激活，记得点保存设置`);
};
$('#btnSaveVisionPreset').onclick = () => {
  const name = $('#visionPresetName').value.trim();
  if (!name) { toast('请先填写预设名称'); return; }
  const presets = getVisionPresets();
  const p = { name, apiKey: $('#setVisionApiKey').value.trim(), baseUrl: $('#setVisionBaseUrl').value.trim(), model: $('#setVisionModel').value.trim() };
  const idx = presets.findIndex(x => x.name === name);
  if (idx >= 0) presets[idx] = p; else presets.push(p);
  setVisionPresets(presets);
  renderVisionPresets();
  toast(`💙 识图预设「${name}」已保存`);
};
$('#btnDelVisionPreset').onclick = () => {
  const i = parseInt($('#visionPresetSelect').value);
  if (isNaN(i)) { toast('请先选择一个预设'); return; }
  const presets = getVisionPresets();
  const name = presets[i]?.name;
  presets.splice(i, 1);
  setVisionPresets(presets);
  renderVisionPresets();
  toast(`已删除识图预设「${name}」`);
};

// ======================== 画图预设 ========================
function getImagePresets() {
  try { return JSON.parse(localStorage.getItem('xinye_image_presets') || '[]'); } catch(e) { return []; }
}
function setImagePresets(arr) {
  const _v = JSON.stringify(arr);
  localStorage.setItem('xinye_image_presets', _v);
  lsBackup('xinye_image_presets', _v);
}
function renderImagePresets() {
  const presets = getImagePresets();
  const sel = $('#imagePresetSelect');
  const cur = sel.value;
  sel.innerHTML = '<option value="">— 选择预设 —</option>';
  presets.forEach((p, i) => {
    const opt = document.createElement('option');
    opt.value = i; opt.textContent = p.name;
    sel.appendChild(opt);
  });
  sel.value = cur;
}
$('#btnLoadImagePreset').onclick = () => {
  const i = parseInt($('#imagePresetSelect').value);
  if (isNaN(i)) { toast('请先选择一个预设'); return; }
  const p = getImagePresets()[i];
  if (!p) return;
  $('#setImageApiKey').value = p.apiKey || '';
  $('#setImageBaseUrl').value = p.baseUrl || '';
  $('#setImageModel').value = p.model || '';
  toast(`🎨 画图预设「${p.name}」已激活，记得点保存设置`);
};
$('#btnSaveImagePreset').onclick = () => {
  const name = $('#imagePresetName').value.trim();
  if (!name) { toast('请先填写预设名称'); return; }
  const presets = getImagePresets();
  const p = { name, apiKey: $('#setImageApiKey').value.trim(), baseUrl: $('#setImageBaseUrl').value.trim(), model: $('#setImageModel').value.trim() };
  const idx = presets.findIndex(x => x.name === name);
  if (idx >= 0) presets[idx] = p; else presets.push(p);
  setImagePresets(presets);
  renderImagePresets();
  toast(`🎨 画图预设「${name}」已保存`);
};
$('#btnDelImagePreset').onclick = () => {
  const i = parseInt($('#imagePresetSelect').value);
  if (isNaN(i)) { toast('请先选择一个预设'); return; }
  const presets = getImagePresets();
  const name = presets[i]?.name;
  presets.splice(i, 1);
  setImagePresets(presets);
  renderImagePresets();
  toast(`已删除画图预设「${name}」`);
};

// ======================== API 预设 ========================
function renderApiPresets() {
  const presets = getApiPresets();
  ['presetSelect', 'subPresetSelect'].forEach(id => {
    const sel = $('#' + id);
    const cur = sel.value;
    sel.innerHTML = '<option value="">— 选择预设 —</option>';
    presets.forEach((p, i) => {
      const opt = document.createElement('option');
      opt.value = i; opt.textContent = p.name;
      sel.appendChild(opt);
    });
    sel.value = cur;
  });
  // 渲染主/副备用预设下拉（各3个槽）
  [0,1,2].forEach(i => {
    ['setFallbackPreset','setSubFallbackPreset'].forEach(base => {
      const fbSel = $(`#${base}${i}`);
      if (!fbSel) return;
      const cur = fbSel.value;
      fbSel.innerHTML = `<option value="">— 备用${i+1}：不启用 —</option>`;
      presets.forEach(p => {
        const opt = document.createElement('option');
        opt.value = p.name; opt.textContent = p.name;
        fbSel.appendChild(opt);
      });
      fbSel.value = cur;
    });
  });
  // 整理记忆用API
  const digestSel = $('#setDigestPreset');
  if (digestSel) {
    const cur = digestSel.value;
    digestSel.innerHTML = '<option value="">主API（默认）</option><option value="__sub__">副API</option>';
    presets.forEach(p => {
      const opt = document.createElement('option');
      opt.value = p.name; opt.textContent = p.name;
      digestSel.appendChild(opt);
    });
    digestSel.value = cur;
  }
  [0,1,2].forEach(i => {
    const fbSel = $(`#setDigestFallback${i}`);
    if (!fbSel) return;
    const cur = fbSel.value;
    fbSel.innerHTML = `<option value="">— 备用${i+1}：不启用 —</option>`;
    presets.forEach(p => {
      const opt = document.createElement('option');
      opt.value = p.name; opt.textContent = p.name;
      fbSel.appendChild(opt);
    });
    fbSel.value = cur;
  });
}
// 主API fetch（整理档案等需要Opus质量的后台任务，带备用预设自动切换）
$('#btnLoadPreset').onclick = () => {
  const i = parseInt($('#presetSelect').value);
  if (isNaN(i)) { toast('请先选择一个预设'); return; }
  const p = getApiPresets()[i];
  if (!p) return;
  $('#setApiKey').value  = p.apiKey  || '';
  $('#setBaseUrl').value = p.baseUrl || '';
  if ($('#setBackupBaseUrl')) $('#setBackupBaseUrl').value = p.backupBaseUrl || '';
  $('#setModel').value   = p.model   || '';
  toast(`✅ 已填入主预设「${p.name}」，确认后点保存设置`);
};
$('#btnLoadSubPreset').onclick = () => {
  const i = parseInt($('#subPresetSelect').value);
  if (isNaN(i)) { toast('请先选择一个预设'); return; }
  const p = getApiPresets()[i];
  if (!p) return;
  $('#setSubApiKey').value  = p.apiKey  || '';
  $('#setSubBaseUrl').value = p.baseUrl || '';
  if ($('#setSubBackupBaseUrl')) $('#setSubBackupBaseUrl').value = p.backupBaseUrl || '';
  $('#setSubModel').value   = p.model   || '';
  toast(`✅ 已填入副预设「${p.name}」，确认后点保存设置`);
};
$('#btnSaveApiPreset').onclick = () => {
  const name = $('#apiPresetName').value.trim();
  if (!name) { toast('请输入预设名称'); return; }
  const apiKey  = $('#setApiKey').value.trim();
  const baseUrl = $('#setBaseUrl').value.trim();
  const backupBaseUrl = $('#setBackupBaseUrl') ? $('#setBackupBaseUrl').value.trim() : '';
  const model   = $('#setModel').value.trim();
  if (!apiKey) { toast('API Key 不能为空'); return; }
  const presets = getApiPresets();
  const existing = presets.findIndex(p => p.name === name);
  if (existing >= 0) presets[existing] = { name, apiKey, baseUrl, backupBaseUrl, model };
  else presets.push({ name, apiKey, baseUrl, backupBaseUrl, model });
  setApiPresets(presets);
  renderApiPresets();
  $('#apiPresetName').value = '';
  toast(`💙 预设「${name}」已保存`);
};
$('#btnDelPreset').onclick = () => {
  const i = parseInt($('#presetSelect').value);
  if (isNaN(i)) { toast('请先选择一个预设'); return; }
  const presets = getApiPresets();
  const name = presets[i]?.name;
  if (!confirm(`确定删除预设「${name}」？`)) return;
  presets.splice(i, 1);
  setApiPresets(presets);
  renderApiPresets();
  toast('预设已删除');
};

$('#btnSaveSettingsTop').onclick = () => $('#btnSaveSettings').click();
$('#btnSaveSettings').onclick = async () => {
  settings.apiKey = $('#setApiKey').value.trim();
  settings.braveKey = $('#setBraveKey').value.trim();
  settings.searchDays = parseInt($('#setSearchDays').value) || 3;
  settings.searchCount = parseInt($('#setSearchCount').value) || 5;
  settings.forumProxy = $('#setForumProxy').value.trim();
  settings.solitudeServerUrl = ($('#setSolitudeServerUrl') ? $('#setSolitudeServerUrl').value.trim() : '').replace(/\/$/, '');
  settings.baseUrl = $('#setBaseUrl').value.trim() || 'https://api.openai.com';
  settings.fallbackPresetNames = [0,1,2].map(i => ($(`#setFallbackPreset${i}`)?.value || '')).filter(v=>v);
  settings.model = $('#setModel').value.trim() || 'gpt-4o';
  settings.subApiKey = $('#setSubApiKey').value.trim();
  settings.subBaseUrl = $('#setSubBaseUrl').value.trim();
  settings.subFallbackPresetNames = [0,1,2].map(i => ($(`#setSubFallbackPreset${i}`)?.value || '')).filter(v=>v);
  settings.subModel = $('#setSubModel').value.trim();
  settings.digestPresetName = $('#setDigestPreset')?.value || '';
  settings.digestFallbackPresetNames = [0,1,2].map(i => ($(`#setDigestFallback${i}`)?.value || '')).filter(v=>v);
  settings.embeddingApiKey = $('#setEmbeddingApiKey').value.trim();
  settings.embeddingBaseUrl = $('#setEmbeddingBaseUrl').value.trim();
  settings.embeddingModel = $('#setEmbeddingModel').value.trim();
  settings.visionApiKey = $('#setVisionApiKey').value.trim();
  settings.visionBaseUrl = $('#setVisionBaseUrl').value.trim();
  settings.visionModel = $('#setVisionModel').value.trim();
  settings.imageApiKey = $('#setImageApiKey').value.trim();
  settings.imageBaseUrl = $('#setImageBaseUrl').value.trim();
  settings.imageModel = $('#setImageModel').value.trim() || 'gpt-image-1';
  settings.imageSize = $('#setImageSize').value || '1024x1024';
  settings.contextCount = parseInt($('#setContextCount').value) || 20;
  settings.memoryArchive = $('#setMemoryArchive').value;
  settings.memoryArchiveCoreMarkers = (document.getElementById('setCoreMarkers')?.value || '');
  ensureMemoryState();
  settings.systemPrompt = $('#setSystemPrompt').value;
  settings.aiName = $('#setAiName').value.trim() || '奶牛猫';
  settings.userName = $('#setUserName').value.trim() || '小浣熊';
  settings.togetherSince = $('#setTogetherSince').value || '2026-02-13';
  settings.bgOpacity = parseFloat($('#setBgOpacity').value) || 0.3;
  settings.bgBlur = parseInt($('#setBgBlur').value) || 0;
  settings.bubbleOpacity = parseFloat($('#setBubbleOpacity').value) || 0.85;
  settings.shortReply = $('#setShortReply').checked;
  // TTS
  settings.streamMode = $('#setStreamMode').checked;
  settings.ttsType = $('#setTtsType').value || 'local';
  settings.ttsAutoPlay = $('#setTtsAutoPlay').checked;
  settings.ttsUrl = $('#setTtsUrl').value.trim() || 'http://127.0.0.1:9880';
  settings.ttsRefPath = $('#setTtsRefPath').value.trim();
  settings.ttsRefText = $('#setTtsRefText').value.trim();
  settings.ttsRefLang = $('#setTtsRefLang').value;
  settings.ttsTargetLang = $('#setTtsTargetLang').value;
  settings.ttsGptWeights = $('#setTtsGptWeights').value.trim();
  settings.ttsSovitsWeights = $('#setTtsSovitsWeights').value.trim();
  settings.doubaoAppId = $('#setDoubaoAppId').value.trim();
  settings.doubaoToken = $('#setDoubaoToken').value.trim();
  settings.doubaoVoice = $('#setDoubaoVoice').value.trim();
  settings.doubaoCluster = $('#setDoubaoCluster').value.trim() || 'volcano_tts';
  settings.doubaoProxy = $('#setDoubaoProxy').value.trim();
  settings.mosiKey = $('#setMosiKey').value.trim();
  settings.mosiVoiceId = $('#setMosiVoiceId').value.trim();
  settings.minimaxKey = $('#setMinimaxKey').value.trim();
  settings.minimaxGroupId = $('#setMinimaxGroupId').value.trim();
  settings.minimaxVoiceId = $('#setMinimaxVoiceId').value.trim();
  settings.minimaxModel = $('#setMinimaxModel').value.trim();
  settings.minimaxProxy = $('#setMinimaxProxy').value.trim();
  settings.omnivoiceUrl = $('#setOmnivoiceUrl').value.trim() || 'https://xinye-omni-tts.cpolar.top';
  settings.omnivoiceXinyeAudio = $('#setOmnivoiceXinyeAudio').value.trim() || '';
  settings.omnivoiceChouAudio = $('#setOmnivoiceChouAudio').value.trim() || '';
  settings.idleRemind = parseInt($('#setIdleRemind').value) || 0;
  settings.waterRemind = parseInt($('#setWaterRemind').value) || 0;
  settings.standRemind = parseInt($('#setStandRemind').value) || 0;
  settings.dreamEnabled = $('#setDreamEnabled').checked;
  settings.dreamSleepHours = parseFloat($('#setDreamSleepHours').value) || 6;
  settings.displayLimit = parseInt($('#setDisplayLimit').value) || 0;

  archiveMemoryBank(settings.memoryBank);
  renderMemoryBankPreview();

  await saveSettings();
  await applyUI(true); // 跳过重建消息列表，避免大量记录时卡顿
  setupReminders();
  resetIdleTimer();
  checkLocalServer(); // URL 可能刚填入，重新探测
  closeSettings();
  btnSearch.classList.toggle('hidden', !settings.braveKey);
  toast('设置已保存');
};

// ======================== TTS 类型切换 UI ========================
function updateTtsTypeUI() {
  const type = (($('#setTtsType') || {}).value) || settings.ttsType || 'local';
  const doubao = $('#doubaoFields');
  const local = $('#localTtsFields');
  const mosi = $('#mosiFields');
  const omnivoice = $('#omnivoiceFields');
  const minimax = $('#minimaxFields');
  if (doubao) doubao.style.display = type === 'doubao' ? '' : 'none';
  if (local) local.style.display = type === 'local' ? '' : 'none';
  if (mosi) mosi.style.display = type === 'mosi' ? '' : 'none';
  if (omnivoice) omnivoice.style.display = type === 'omnivoice' ? '' : 'none';
  if (minimax) minimax.style.display = type === 'minimax' ? '' : 'none';
}

// ======================== 音色预设管理 ========================
function renderTtsPresets() {
  const list = $('#ttsPresetList');
  if (!list) return;
  list.innerHTML = '';
  const presets = settings.ttsPresets || [];
  const dark = isDarkMode();
  const cardBg = dark ? 'rgba(46,28,58,.7)' : 'rgba(255,255,255,.6)';
  const cardBorder = dark ? 'rgba(80,60,100,.9)' : 'var(--pink-light)';
  const hintColor = dark ? '#8a6878' : '#b0856f';
  if (presets.length === 0) {
    list.innerHTML = '<div style="font-size:13px;color:' + hintColor + ';text-align:center;padding:8px 0">暂无预设——填好上方参数后点「保存当前为预设」</div>';
    return;
  }
  presets.forEach((p, i) => {
    const div = document.createElement('div');
    div.style.cssText = 'display:flex;align-items:center;gap:8px;padding:8px 12px;background:' + cardBg + ';border-radius:10px;border:1px solid ' + cardBorder;
    const pathTip = p.gptWeights ? `🔀 ${p.gptWeights.split(/[\/]/).pop()}` : (p.ttsRefPath ? `🎤 ${p.ttsRefPath.split(/[\/]/).pop()}` : '无参考音频');
    div.innerHTML = `
      <span style="flex:1;font-size:14px;font-weight:600;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(p.name)}</span>
      <span style="font-size:11px;color:var(--text-light);flex:2;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escHtml(pathTip)}">${escHtml(pathTip)}</span>
      <button class="btn-secondary" style="padding:4px 12px;font-size:12px;white-space:nowrap;flex-shrink:0">激活</button>
      <button class="btn-danger" style="padding:4px 8px;font-size:12px;flex-shrink:0">✕</button>`;
    list.appendChild(div);
    div.querySelectorAll('button')[0].onclick = () => activateTtsPreset(i);
    div.querySelectorAll('button')[1].onclick = () => deleteTtsPreset(i);
  });
}

async function activateTtsPreset(i) {
  const p = (settings.ttsPresets || [])[i];
  if (!p) return;
  if (p.ttsType)         settings.ttsType          = p.ttsType;
  if (p.ttsUrl)          settings.ttsUrl            = p.ttsUrl;
  settings.ttsRefPath     = p.ttsRefPath    || '';
  settings.ttsRefText     = p.ttsRefText    || '';
  settings.ttsRefLang     = p.ttsRefLang    || 'zh';
  settings.ttsTargetLang  = p.ttsTargetLang || 'zh';
  settings.ttsGptWeights  = p.gptWeights    || '';
  settings.ttsSovitsWeights = p.sovitsWeights || '';
  if (p.mosiKey)         settings.mosiKey           = p.mosiKey;
  if (p.mosiVoiceId)     settings.mosiVoiceId       = p.mosiVoiceId;
  if (p.minimaxKey)      settings.minimaxKey         = p.minimaxKey;
  if (p.minimaxGroupId)  settings.minimaxGroupId     = p.minimaxGroupId;
  settings.minimaxVoiceId  = p.minimaxVoiceId  || '';
  settings.minimaxModel    = p.minimaxModel    || '';
  settings.minimaxProxy    = p.minimaxProxy    || '';
  await saveSettings();
  // 同步面板显示
  $('#setTtsType').value          = settings.ttsType;
  $('#setTtsUrl').value           = settings.ttsUrl;
  $('#setTtsRefPath').value       = settings.ttsRefPath;
  $('#setTtsRefText').value       = settings.ttsRefText;
  $('#setTtsRefLang').value       = settings.ttsRefLang;
  $('#setTtsTargetLang').value    = settings.ttsTargetLang;
  $('#setTtsGptWeights').value    = settings.ttsGptWeights;
  $('#setTtsSovitsWeights').value = settings.ttsSovitsWeights;
  $('#setMosiKey').value          = settings.mosiKey;
  $('#setMosiVoiceId').value      = settings.mosiVoiceId;
  $('#setMinimaxKey').value       = settings.minimaxKey;
  $('#setMinimaxGroupId').value   = settings.minimaxGroupId;
  $('#setMinimaxVoiceId').value   = settings.minimaxVoiceId;
  $('#setMinimaxModel').value     = settings.minimaxModel;
  $('#setMinimaxProxy').value     = settings.minimaxProxy;
  updateTtsTypeUI(); // 切换显示对应 TTS 类型的字段
  toast(`✅ 已激活音色预设「${p.name}」`);
}

async function deleteTtsPreset(i) {
  const name = (settings.ttsPresets || [])[i]?.name || '';
  if (!confirm(`确定删除预设「${name}」？`)) return;
  settings.ttsPresets.splice(i, 1);
  await saveSettings();
  renderTtsPresets();
  toast('预设已删除');
}

$('#btnSavePreset').onclick = async () => {
  const name = $('#newPresetName').value.trim();
  if (!name) { toast('请先输入预设名称'); return; }
  if (!settings.ttsPresets) settings.ttsPresets = [];
  const p = {
    name,
    ttsType:         $('#setTtsType').value,
    ttsUrl:          $('#setTtsUrl').value.trim(),
    ttsRefPath:      $('#setTtsRefPath').value.trim(),
    ttsRefText:      $('#setTtsRefText').value.trim(),
    ttsRefLang:      $('#setTtsRefLang').value,
    ttsTargetLang:   $('#setTtsTargetLang').value,
    gptWeights:      $('#setTtsGptWeights').value.trim(),
    sovitsWeights:   $('#setTtsSovitsWeights').value.trim(),
    mosiKey:         $('#setMosiKey').value.trim(),
    mosiVoiceId:     $('#setMosiVoiceId').value.trim(),
    minimaxKey:      $('#setMinimaxKey').value.trim(),
    minimaxGroupId:  $('#setMinimaxGroupId').value.trim(),
    minimaxVoiceId:  $('#setMinimaxVoiceId').value.trim(),
    minimaxModel:    $('#setMinimaxModel').value.trim(),
    minimaxProxy:    $('#setMinimaxProxy').value.trim(),
  };
  settings.ttsPresets.push(p);
  await saveSettings();
  renderTtsPresets();
  $('#newPresetName').value = '';
  toast(`🎙️ 预设「${name}」已保存`);
};

$('#btnClearTtsCache').onclick = async () => {
  if (!confirm('确定清除所有已缓存的语音？\n清除后点击🔈需重新生成。')) return;
  await dbClear('ttsCache');
  chatArea.querySelectorAll('.btn-tts,.btn-tts-dl').forEach(b => b.classList.remove('cached'));
  toast('语音缓存已清除');
};

// 头像上传
$('#btnUploadAiAvatar').onclick = () => $('#fileInputAiAvatar').click();
$('#btnUploadUserAvatar').onclick = () => $('#fileInputUserAvatar').click();
$('#fileInputAiAvatar').onchange = async function() {
  if (!this.files[0]) return;
  const b64 = await readFileAsBase64(this.files[0]);
  await dbPut('images', 'aiAvatar', b64);
  $('#previewAiAvatar').src = b64;
  scheduleAutoSave();
  toast('AI 头像已更新');
  this.value = '';
};
$('#fileInputUserAvatar').onchange = async function() {
  if (!this.files[0]) return;
  const b64 = await readFileAsBase64(this.files[0]);
  await dbPut('images', 'userAvatar', b64);
  $('#previewUserAvatar').src = b64;
  scheduleAutoSave();
  toast('我的头像已更新');
  this.value = '';
};

// ======================== 背景上传（图片 + 视频） ========================
let bgVideoUrl = null;

$('#btnUploadBg').onclick = () => $('#fileInputBg').click();
$('#fileInputBg').onchange = async function() {
  if (!this.files[0]) return;
  const file = this.files[0];
  const isVideo = file.type.startsWith('video/');

  if (isVideo) {
    const blob = new Blob([await file.arrayBuffer()], { type: file.type });
    await dbPut('images', 'bgVideo', blob);
    await dbDelete('images', 'bgImage');
    await dbPut('images', 'bgType', 'video');
    applyBgVideo(blob);
    toast('视频背景已设置');
  } else {
    const b64 = await readFileAsBase64(file);
    await dbPut('images', 'bgImage', b64);
    await dbDelete('images', 'bgVideo');
    await dbPut('images', 'bgType', 'image');
    applyBgImage(b64);
    toast('背景图已更新');
  }
  this.value = '';
};

$('#btnClearBg').onclick = async () => {
  await dbDelete('images', 'bgImage');
  await dbDelete('images', 'bgVideo');
  await dbDelete('images', 'bgType');
  if (bgVideoUrl) { URL.revokeObjectURL(bgVideoUrl); bgVideoUrl = null; }
  bgLayer.innerHTML = '';
  bgLayer.style.backgroundImage = '';
  bgLayer.classList.remove('active');
  bgMask.classList.remove('active');
  toast('背景已清除');
};

function applyBgImage(b64) {
  if (bgVideoUrl) { URL.revokeObjectURL(bgVideoUrl); bgVideoUrl = null; }
  bgLayer.innerHTML = '';
  bgLayer.style.backgroundImage = `url(${b64})`;
  bgLayer.style.opacity = settings.bgOpacity;
  bgLayer.style.filter = `blur(${settings.bgBlur}px)`;
  bgLayer.classList.add('active');
  bgMask.classList.remove('active');
}

function applyBgVideo(blob) {
  if (bgVideoUrl) URL.revokeObjectURL(bgVideoUrl);
  bgVideoUrl = URL.createObjectURL(blob);
  bgLayer.style.backgroundImage = '';
  bgLayer.innerHTML = '';
  const v = document.createElement('video');
  v.src = bgVideoUrl;
  v.autoplay = true; v.loop = true; v.muted = true; v.playsInline = true;
  bgLayer.appendChild(v);
  bgLayer.style.opacity = settings.bgOpacity;
  bgLayer.style.filter = `blur(${settings.bgBlur}px)`;
  bgLayer.classList.add('active');
  bgMask.classList.add('active');
}

async function applyBg() {
  const bgType = await dbGet('images', 'bgType');
  if (bgType === 'video') {
    const blob = await dbGet('images', 'bgVideo');
    if (blob) { applyBgVideo(blob); return; }
  }
  const b64 = await dbGet('images', 'bgImage');
  if (b64) { applyBgImage(b64); return; }
  bgLayer.innerHTML = '';
  bgLayer.style.backgroundImage = '';
  bgLayer.classList.remove('active');
  bgMask.classList.remove('active');
}

// ======================== 智能清空 ========================
$('#btnClear').onclick = async () => {
  if (messages.length === 0) { toast('没有聊天记录'); return; }
  if (!confirm('确定清空所有聊天记录吗？\n\nAPI Key、人设、头像、背景图和贴纸都会保留。')) return;
  await dbClear('messages');
  messages.length = 0;
  await renderMessages();
  await saveToLocal();
  toast('聊天记录已清空');
};
$('#btnClearChat').onclick = async () => {
  if (messages.length === 0) { toast('没有聊天记录'); return; }
  if (!confirm('确定清空所有聊天记录吗？\n\nAPI Key、人设、头像、背景图和贴纸都会保留。')) return;
  await dbClear('messages');
  messages.length = 0;
  await renderMessages();
  closeSettings();
  await saveToLocal();
  toast('聊天记录已清空');
};

// ======================== 贴纸系统 ========================
$('#btnSticker').onclick = () => $('#fileInputSticker').click();
$('#fileInputSticker').onchange = async function() {
  if (!this.files[0]) return;
  const b64 = await readFileAsBase64(this.files[0]);
  const s = {
    id: 'stk_' + Date.now(),
    data: b64,
    x: Math.random() * (window.innerWidth - 120),
    y: Math.random() * (window.innerHeight - 120),
    w: 100, h: 100, rot: 0
  };
  stickers.push(s);
  await dbPut('stickers', null, s);
  createStickerDOM(s);
  toast('贴纸已添加，拖拽它到喜欢的位置');
  this.value = '';
};

function createStickerDOM(s) {
  if (s.rot === undefined) s.rot = 0;

  const el = document.createElement('div');
  el.className = 'sticker';
  el.dataset.id = s.id;
  el.style.left = s.x + 'px';
  el.style.top = s.y + 'px';
  el.style.width = s.w + 'px';
  el.style.height = s.h + 'px';
  el.style.transform = `rotate(${s.rot}deg)`;
  el.innerHTML = `
    <img src="${s.data}" alt="sticker">
    <button class="sticker-del">✕</button>
    <div class="sticker-resize"></div>
    <div class="sticker-rotate-line"></div>
    <div class="sticker-rotate">↻</div>`;
  stickerLayer.appendChild(el);

  el.querySelector('.sticker-del').addEventListener('click', async (e) => {
    e.stopPropagation();
    await dbDelete('stickers', s.id);
    stickers = stickers.filter(x => x.id !== s.id);
    el.remove();
    toast('贴纸已删除');
  });

  let dragging = false, startX, startY, origX, origY;
  el.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.sticker-resize') || e.target.closest('.sticker-del') || e.target.closest('.sticker-rotate')) return;
    dragging = true;
    el.style.cursor = 'grabbing';
    startX = e.clientX; startY = e.clientY;
    origX = parseFloat(el.style.left); origY = parseFloat(el.style.top);
    el.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  el.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    el.style.left = (origX + e.clientX - startX) + 'px';
    el.style.top  = (origY + e.clientY - startY) + 'px';
  });
  el.addEventListener('pointerup', async () => {
    if (!dragging) return;
    dragging = false;
    el.style.cursor = 'grab';
    const obj = stickers.find(x => x.id === s.id);
    if (obj) {
      obj.x = parseFloat(el.style.left);
      obj.y = parseFloat(el.style.top);
      await dbPut('stickers', null, obj);
    }
  });

  const resizer = el.querySelector('.sticker-resize');
  let resizing = false, rStartX, rStartY, rOrigW, rOrigH;
  resizer.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    resizing = true;
    rStartX = e.clientX; rStartY = e.clientY;
    rOrigW = parseFloat(el.style.width); rOrigH = parseFloat(el.style.height);
    resizer.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  resizer.addEventListener('pointermove', (e) => {
    if (!resizing) return;
    const dx = e.clientX - rStartX, dy = e.clientY - rStartY;
    const delta = Math.max(dx, dy);
    el.style.width  = Math.max(40, rOrigW + delta) + 'px';
    el.style.height = Math.max(40, rOrigH + delta) + 'px';
  });
  resizer.addEventListener('pointerup', async () => {
    if (!resizing) return;
    resizing = false;
    const obj = stickers.find(x => x.id === s.id);
    if (obj) {
      obj.w = parseFloat(el.style.width);
      obj.h = parseFloat(el.style.height);
      await dbPut('stickers', null, obj);
    }
  });

  const rotator = el.querySelector('.sticker-rotate');
  let rotating = false, rotStartAngle, rotOrigDeg;
  rotator.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    e.preventDefault();
    rotating = true;
    rotator.setPointerCapture(e.pointerId);
    const rect = el.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    rotStartAngle = Math.atan2(e.clientY - cy, e.clientX - cx) * (180 / Math.PI);
    const obj = stickers.find(x => x.id === s.id);
    rotOrigDeg = obj ? obj.rot : 0;
  });
  rotator.addEventListener('pointermove', (e) => {
    if (!rotating) return;
    const rect = el.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const curAngle = Math.atan2(e.clientY - cy, e.clientX - cx) * (180 / Math.PI);
    const delta = curAngle - rotStartAngle;
    el.style.transform = `rotate(${rotOrigDeg + delta}deg)`;
  });
  rotator.addEventListener('pointerup', async () => {
    if (!rotating) return;
    rotating = false;
    const match = el.style.transform.match(/rotate\(([-\d.]+)deg\)/);
    const finalDeg = match ? parseFloat(match[1]) : 0;
    const obj = stickers.find(x => x.id === s.id);
    if (obj) {
      obj.rot = Math.round(finalDeg * 10) / 10;
      await dbPut('stickers', null, obj);
    }
  });
}

function renderStickers() {
  stickerLayer.innerHTML = '';
  stickers.forEach(s => createStickerDOM(s));
}

// ======================== 本地服务器连通检测 ========================
let _localServerOnline = false;

function updateLocalServerDot() {
  const dot = document.getElementById('localServerDot');
  if (!dot) return;
  if (!settings.solitudeServerUrl) { dot.textContent = ''; return; }
  dot.textContent = _localServerOnline ? ' 🟢' : ' ⚪';
  dot.title = _localServerOnline ? 'Tailscale 已连接' : '未连接（离线将跳过同步）';
}

async function checkLocalServer() {
  const url = (settings.solitudeServerUrl || '').trim();
  if (!url) { _localServerOnline = false; updateLocalServerDot(); notifySwLocalServer(null); return; }
  const wasOnline = _localServerOnline;
  try {
    const r = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(3000) });
    _localServerOnline = r.ok;
  } catch { _localServerOnline = false; }
  updateLocalServerDot();
  notifySwLocalServer(_localServerOnline ? url : null);
  if (!wasOnline && _localServerOnline) autoBackupToServer();
}

function notifySwLocalServer(url) {
  try {
    if (navigator.serviceWorker?.controller)
      navigator.serviceWorker.controller.postMessage({ type: 'SET_LOCAL_SERVER', url: url || null });
  } catch {}
}


// ======================== 自动备份到本地服务器 ========================
let _lastAutoBackupTime = 0;

async function autoBackupToServer() {
  const serverUrl = (settings.solitudeServerUrl || '').trim();
  if (!serverUrl || !_localServerOnline) return;
  // 节流：5分钟内不重复备份
  if (Date.now() - _lastAutoBackupTime < 5 * 60 * 1000) return;
  _lastAutoBackupTime = Date.now();

  try {
    // 聊天数据
    const allMsgs = await dbGetAll('messages');
    allMsgs.sort((a, b) => a.time - b.time);
    const allRpMsgs = await dbGetAll('rpMessages');
    allRpMsgs.sort((a, b) => a.time - b.time);

    // 日记数据（localStorage）
    const diaryData = {};
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && (k.startsWith('rbdiary_') || k.startsWith('xinye_diary_'))) {
        diaryData[k] = localStorage.getItem(k);
      }
    }

    // 共读数据（ReadingDB）
    let readingData = { books: [], chapters: [], annotations: [] };
    try {
      readingData = await new Promise((resolve) => {
        const req = indexedDB.open('ReadingDB', 2);
        req.onupgradeneeded = e => {
          const rdb = e.target.result;
          if (!rdb.objectStoreNames.contains('books'))       rdb.createObjectStore('books', { keyPath: 'id' });
          if (!rdb.objectStoreNames.contains('chapters'))    rdb.createObjectStore('chapters', { keyPath: 'bookId' });
          if (!rdb.objectStoreNames.contains('annotations')) rdb.createObjectStore('annotations', { keyPath: 'bookId' });
        };
        req.onerror = () => resolve({ books: [], chapters: [], annotations: [] });
        req.onsuccess = e => {
          const db = e.target.result;
          const result = { books: [], chapters: [], annotations: [] };
          const stores = ['books', 'chapters', 'annotations'];
          let done = 0;
          for (const store of stores) {
            try {
              const tx = db.transaction(store, 'readonly');
              const all = tx.objectStore(store).getAll();
              all.onsuccess = ev => { result[store] = ev.target.result || []; if (++done === stores.length) resolve(result); };
              all.onerror = () => { if (++done === stores.length) resolve(result); };
            } catch { if (++done === stores.length) resolve(result); }
          }
        };
      });
    } catch {}

    const payload = JSON.stringify({
      version: 3, type: 'auto',
      exportTime: new Date().toISOString(),
      settings,
      apiPresets: getApiPresets(),
      messages: allMsgs.map(m => { const r = { role: m.role, content: m.content, time: m.time }; if (m.image) r.image = m.image; if (m.images) r.images = m.images; return r; }),
      rpMessages: allRpMsgs.map(m => { const r = { role: m.role, content: m.content, time: m.time }; if (m.image) r.image = m.image; return r; }),
      rpData: { rp_prompt: localStorage.getItem('rp_prompt') || '', rp_presets: localStorage.getItem('rp_presets') || '[]', rp_char_name: localStorage.getItem('rp_char_name') || '', rp_char_avatar: localStorage.getItem('rp_char_avatar') || '', rp_active: localStorage.getItem('rp_active') || '0' },
      stickers, chatStickers: getChatStickers(),
      diary: diaryData,
      reading: readingData,
      friendsData: await getFriendsBackupData(),
    });

    await fetch(`${serverUrl}/api/backup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload });
    const backupTime = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
    console.log('[自动备份] 完成');
    localStorage.setItem('lastAutoBackupTime', backupTime);
    toast('💾 已自动备份到电脑');
  } catch (e) {
    console.warn('[自动备份] 失败:', e.message);
  }
}

async function getFriendsBackupData() {
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

async function backupToPhone() {
  const btn = $('#btnBackupToPhone');
  if (btn) { btn.disabled = true; btn.textContent = '备份中…'; }
  try {
    const allMsgs = await dbGetAll('messages');
    allMsgs.sort((a, b) => a.time - b.time);
    const allRpMsgs = await dbGetAll('rpMessages');
    allRpMsgs.sort((a, b) => a.time - b.time);
    const diaryData = {};
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && (k.startsWith('rbdiary_') || k.startsWith('xinye_diary_'))) diaryData[k] = localStorage.getItem(k);
    }
    let readingData = { books: [], chapters: [], annotations: [] };
    try {
      readingData = await new Promise((resolve) => {
        const req = indexedDB.open('ReadingDB', 2);
        req.onerror = () => resolve({ books: [], chapters: [], annotations: [] });
        req.onsuccess = e => {
          const rdb = e.target.result;
          const result = { books: [], chapters: [], annotations: [] };
          const stores = ['books', 'chapters', 'annotations'];
          let done = 0;
          for (const store of stores) {
            try {
              const tx = rdb.transaction(store, 'readonly');
              const all = tx.objectStore(store).getAll();
              all.onsuccess = ev => { result[store] = ev.target.result || []; if (++done === stores.length) resolve(result); };
              all.onerror = () => { if (++done === stores.length) resolve(result); };
            } catch { if (++done === stores.length) resolve(result); }
          }
        };
      });
    } catch {}
    const payload = JSON.stringify({
      version: 3, type: 'auto',
      exportTime: new Date().toISOString(),
      settings, apiPresets: getApiPresets(),
      messages: allMsgs.map(m => { const r = { role: m.role, content: m.content, time: m.time }; if (m.image) r.image = m.image; if (m.images) r.images = m.images; return r; }),
      rpMessages: allRpMsgs.map(m => { const r = { role: m.role, content: m.content, time: m.time }; if (m.image) r.image = m.image; return r; }),
      rpData: { rp_prompt: localStorage.getItem('rp_prompt') || '', rp_presets: localStorage.getItem('rp_presets') || '[]', rp_char_name: localStorage.getItem('rp_char_name') || '', rp_char_avatar: localStorage.getItem('rp_char_avatar') || '', rp_active: localStorage.getItem('rp_active') || '0' },
      stickers, chatStickers: getChatStickers(),
      diary: diaryData, reading: readingData,
      friendsData: await getFriendsBackupData(),
    });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16);
    const filename = `xinye_backup_${stamp}.json`;
    if (window.AndroidDownload) {
      const ok = window.AndroidDownload.saveToDownloads(filename, payload);
      if (ok) { toast('✅ 已备份到 Download/' + filename); closeSettings(); return; }
    }
    // 浏览器fallback
    const blob = new Blob([payload], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    document.body.removeChild(a); URL.revokeObjectURL(url);
    toast('✅ 备份已导出');
    closeSettings();
  } catch(e) {
    toast('❌ 备份失败：' + e.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '💾 一键备份到手机'; }
  }
}
$('#btnBackupToPhone').onclick = backupToPhone;

// ======================== 导出 ========================
$('#btnExport').onclick = () => exportOverlay.classList.add('show');
$('#btnExportS').onclick = () => { closeSettings(); exportOverlay.classList.add('show'); };
$('#btnCloseExport').onclick = () => exportOverlay.classList.remove('show');

async function exportData(mode) {
  exportOverlay.classList.remove('show');
  const isLite = mode === 'lite';
  const bgType = await dbGet('images', 'bgType');

  // 导出时从 DB 读所有消息，保证完整（不依赖内存中的截断版本）
  const allMsgs = await dbGetAll('messages');
  allMsgs.sort((a, b) => a.time - b.time);

  const allRpMsgs = await dbGetAll('rpMessages');
  allRpMsgs.sort((a, b) => a.time - b.time);

  const backup = {
    version: 3,
    type: isLite ? 'lite' : 'full',
    exportTime: new Date().toISOString(),
    settings,
    apiPresets: getApiPresets(),
    visionPresets: getVisionPresets(),
    imagePresets: getImagePresets(),
    messages: allMsgs.map(m => {
      const r = { role: m.role, content: m.content, time: m.time };
      if (m.image) r.image = m.image;
      if (m.images) r.images = m.images;
      return r;
    }),
    rpMessages: allRpMsgs.map(m => {
      const r = { role: m.role, content: m.content, time: m.time };
      if (m.image) r.image = m.image;
      if (m.images) r.images = m.images;
      return r;
    }),
    rpData: {
      rp_prompt:      localStorage.getItem('rp_prompt') || '',
      rp_presets:     localStorage.getItem('rp_presets') || '[]',
      rp_char_name:   localStorage.getItem('rp_char_name') || '',
      rp_char_avatar: localStorage.getItem('rp_char_avatar') || '',
      rp_active:      localStorage.getItem('rp_active') || '0',
    },
    images: {
      aiAvatar:   await dbGet('images', 'aiAvatar')   || null,
      userAvatar: await dbGet('images', 'userAvatar') || null,
      bgImage:    isLite ? null : (bgType === 'image' ? (await dbGet('images', 'bgImage') || null) : null),
      bgType:     isLite ? null : (bgType || null),
    },
    stickers: isLite ? [] : stickers,
    chatStickers: getChatStickers(),
    friendsData: await getFriendsBackupData(),
  };

  const label = isLite ? '轻量' : '完整';
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);
  const timeStr = now.toTimeString().slice(0, 8).replace(/:/g, '-');
  downloadFile(JSON.stringify(backup, null, 2), `炘也小窝${label}备份_${dateStr}_${timeStr}.json`, 'application/json;charset=utf-8');

  const aiN = settings.aiName || '奶牛猫';
  const usN = settings.userName || '小浣熊';
  const lines = [
    `═══ ${usN} 与 ${aiN} 的聊天记录 ═══`,
    `导出时间：${new Date().toLocaleString('zh-CN')}`,
    `备份类型：${label}`,
    `共 ${allMsgs.length} 条消息`,
    '═'.repeat(40), ''
  ];
  allMsgs.forEach(m => {
    lines.push(`[${new Date(m.time).toLocaleString('zh-CN')}] ${m.role === 'user' ? usN : aiN}：`);
    lines.push(m.content);
    lines.push('');
  });
  downloadFile(lines.join('\n'), `聊天记录_${dateStr}_${timeStr}.txt`, 'text/plain;charset=utf-8');

  if (isLite) toast('轻量备份已导出（不含背景/贴纸）');
  else if (bgType === 'video') toast('完整备份已导出（视频背景需重新上传）');
  else toast('完整备份已导出（JSON + TXT）');
}

$('#btnExportLite').onclick = () => exportData('lite');
$('#btnExportFull').onclick = () => exportData('full');

// ======================== 导入（共用核心） ========================
async function doImportPresetsOnly(jsonText) {
  const data = JSON.parse(jsonText);
  if (data.apiPresets && Array.isArray(data.apiPresets))     setApiPresets(data.apiPresets);
  if (data.visionPresets && Array.isArray(data.visionPresets)) setVisionPresets(data.visionPresets);
  if (data.imagePresets && Array.isArray(data.imagePresets))  setImagePresets(data.imagePresets);
  if (data.chatStickers && Array.isArray(data.chatStickers)) {
    try { saveChatStickers(data.chatStickers); }
    catch(e) { toast('⚠️ 聊天贴纸图片过大，已跳过（其他数据正常恢复）'); }
  }
  if (data.stickers && Array.isArray(data.stickers)) {
    await dbClear('stickers');
    for (const s of data.stickers) await dbPut('stickers', null, s);
    stickers = await dbGetAll('stickers');
    renderStickers();
  }
  // rpData
  if (data.rpData) {
    const rp = data.rpData;
    if (rp.rp_prompt)     { localStorage.setItem('rp_prompt', rp.rp_prompt); lsBackup('rp_prompt', rp.rp_prompt); }
    if (rp.rp_presets)    { localStorage.setItem('rp_presets', rp.rp_presets); lsBackup('rp_presets', rp.rp_presets); }
    if (rp.rp_char_name)  { localStorage.setItem('rp_char_name', rp.rp_char_name); lsBackup('rp_char_name', rp.rp_char_name); }
    if (rp.rp_char_avatar){ localStorage.setItem('rp_char_avatar', rp.rp_char_avatar); lsBackup('rp_char_avatar', rp.rp_char_avatar); }
  }
}

async function doImport(jsonText) {
  const data = JSON.parse(jsonText);
  const isLite = data.type === 'lite' || data.type === 'auto-save';

  // 兼容旧格式：纯消息数组
  if (Array.isArray(data)) {
    await dbClear('messages');
    for (const m of data) {
      const rec = { role: m.role, content: m.content, time: m.time };
      if (m.image) rec.image = m.image;
      await dbPut('messages', null, rec);
    }
    { const _m = await dbGetAll('messages'); _m.sort((a,b) => a.time - b.time); messages.length = 0; messages.push(..._m); }
    await saveToLocal();
    return;
  }

  // 导入设置（兼容网页版 settings 或桌宠 cfg 格式）
  if (data.settings) {
    await dbPut('settings', 'main', { ...data.settings, memoryBank: ensureMemoryBank(data.settings.memoryBank) });
  } else if (data.cfg) {
    const c = data.cfg;
    const patch = {
      apiKey: c.apiKey, baseUrl: c.baseUrl, model: c.model,
      contextCount: c.ctx, shortReply: c.shortReply,
      systemPrompt: c.sysPrompt, memoryArchive: c.memory,
      ttsType: c.ttsType, ttsAutoPlay: c.ttsAutoPlay,
      ttsUrl: c.ttsUrl, ttsRefPath: c.ttsRef, ttsRefText: c.ttsText,
      ttsGptWeights: c.gptWeights, ttsSovitsWeights: c.sovitsWeights,
      doubaoAppId: c.doubaoAppId, doubaoToken: c.doubaoToken,
      doubaoVoice: c.doubaoVoice, doubaoCluster: c.doubaoCluster,
      idleRemind: c.idleRemind, waterRemind: c.waterRemind, standRemind: c.standRemind,
    };
    const merged = { ...settings };
    Object.keys(patch).forEach(k => { if (patch[k] !== undefined) merged[k] = patch[k]; });
    merged.memoryBank = ensureMemoryBank(merged.memoryBank);
    await dbPut('settings', 'main', merged);
  }

  // 导入 API 预设
  if (data.apiPresets && Array.isArray(data.apiPresets)) {
    setApiPresets(data.apiPresets);
  }
  if (data.visionPresets && Array.isArray(data.visionPresets)) {
    setVisionPresets(data.visionPresets);
  }
  if (data.imagePresets && Array.isArray(data.imagePresets)) {
    setImagePresets(data.imagePresets);
  }

  // 导入消息（兼容 messages / history 两种字段名）
  const msgList = data.messages || data.history;
  if (msgList) {
    await dbClear('messages');
    for (const m of msgList) {
      const rec = { role: m.role, content: m.content, time: m.time || Date.now() };
      if (m.image) rec.image = m.image;
      if (m.images) rec.images = m.images;
      await dbPut('messages', null, rec);
    }
    // 导入后把游标对齐到备份末尾，避免重复提取备份内已有消息
    const importedSettings = await dbGet('settings', 'main');
    if (importedSettings?.memoryBank) {
      importedSettings.memoryBank.lastProcessedIndex = msgList.length - 1;
      await dbPut('settings', 'main', importedSettings);
    }
  }

  // 导入图片
  if (data.images) {
    if (data.images.aiAvatar)   await dbPut('images', 'aiAvatar', data.images.aiAvatar);
    if (data.images.userAvatar) await dbPut('images', 'userAvatar', data.images.userAvatar);
    // 轻量备份：不覆盖当前设备已有的背景图
    if (!isLite) {
      if (data.images.bgImage) {
        await dbPut('images', 'bgImage', data.images.bgImage);
        await dbPut('images', 'bgType', data.images.bgType || 'image');
      } else {
        await dbDelete('images', 'bgImage');
        await dbDelete('images', 'bgVideo');
        await dbDelete('images', 'bgType');
      }
    }
  }

  // 贴纸：仅完整备份时导入
  if (!isLite) {
    await dbClear('stickers');
    if (data.stickers) {
      for (const s of data.stickers) await dbPut('stickers', null, s);
    }
  }

  // 导入聊天贴纸（两种备份都恢复）
  if (data.chatStickers && Array.isArray(data.chatStickers) && data.chatStickers.length > 0) {
    try { saveChatStickers(data.chatStickers); }
    catch(e) { toast('⚠️ 聊天贴纸图片过大，已跳过（其他数据正常恢复）'); console.warn('[import] chatStickers超出localStorage配额:', e); }
  }

  // 导入RP对话记录
  if (data.rpMessages && Array.isArray(data.rpMessages) && data.rpMessages.length > 0) {
    await dbClear('rpMessages');
    for (const m of data.rpMessages) {
      const rec = { role: m.role, content: m.content, time: m.time || Date.now() };
      if (m.image) rec.image = m.image;
      if (m.images) rec.images = m.images;
      await dbPut('rpMessages', null, rec);
    }
  }

  // 导入RP角色卡设置（rp_active 不恢复，避免导入后意外进入RP模式）
  if (data.rpData) {
    const d = data.rpData;
    if (d.rp_prompt)      { localStorage.setItem('rp_prompt', d.rp_prompt); lsBackup('rp_prompt', d.rp_prompt); }
    if (d.rp_presets)     { localStorage.setItem('rp_presets', d.rp_presets); lsBackup('rp_presets', d.rp_presets); }
    if (d.rp_char_name)   { localStorage.setItem('rp_char_name', d.rp_char_name); lsBackup('rp_char_name', d.rp_char_name); }
    if (d.rp_char_avatar) { localStorage.setItem('rp_char_avatar', d.rp_char_avatar); lsBackup('rp_char_avatar', d.rp_char_avatar); }
  }

  // 导入日记数据（localStorage）
  if (data.diary && typeof data.diary === 'object') {
    for (const [k, v] of Object.entries(data.diary)) {
      if (k.startsWith('rbdiary_') || k.startsWith('xinye_diary_')) localStorage.setItem(k, v);
    }
  }

  // 导入共读数据（IndexedDB ReadingDB）
  if (data.reading && (data.reading.books?.length || data.reading.chapters?.length || data.reading.annotations?.length)) {
    try {
      await new Promise((resolve, reject) => {
        const req = indexedDB.open('ReadingDB', 2);
        req.onerror = reject;
        req.onupgradeneeded = e => {
          const rdb = e.target.result;
          if (!rdb.objectStoreNames.contains('books'))       rdb.createObjectStore('books', { keyPath: 'id' });
          if (!rdb.objectStoreNames.contains('chapters'))    rdb.createObjectStore('chapters', { keyPath: 'bookId' });
          if (!rdb.objectStoreNames.contains('annotations')) rdb.createObjectStore('annotations', { keyPath: 'bookId' });
        };
        req.onsuccess = e => {
          const rdb = e.target.result;
          const stores = ['books', 'chapters', 'annotations'];
          let done = 0;
          for (const store of stores) {
            const tx = rdb.transaction(store, 'readwrite');
            const os = tx.objectStore(store);
            os.clear();
            const items = data.reading[store] || [];
            for (const item of items) os.put(item);
            tx.oncomplete = () => { if (++done === stores.length) resolve(); };
            tx.onerror = reject;
          }
        };
      });
    } catch(e) { console.warn('[导入] 共读数据恢复失败：', e.message); }
  }

  // 导入好友数据（写入 IDB）
  if (data.friendsData?.friends && Array.isArray(data.friendsData.friends)) {
    await dbClear('friends');
    await dbClear('friendMessages');
    for (const f of data.friendsData.friends) await dbPut('friends', null, f);
    if (data.friendsData.chats && typeof data.friendsData.chats === 'object') {
      for (const msgs of Object.values(data.friendsData.chats)) {
        if (Array.isArray(msgs)) {
          for (const m of msgs) {
            const rec = { role: m.role, content: m.content, friendId: m.friendId, ts: m.ts || m.id || Date.now() };
            await dbPut('friendMessages', null, rec);
          }
        }
      }
    }
  }

  // 刷新内存状态 & 同步 localStorage
  const s = await dbGet('settings', 'main');
  if (s) Object.assign(settings, s);
  { const _m = await dbGetAll('messages'); _m.sort((a,b) => a.time - b.time); messages.length = 0; messages.push(..._m); }
  stickers = await dbGetAll('stickers');
  await saveToLocal();
}

// ======================== 合并导入 ========================
async function doMergeImport(jsonText) {
  const data = JSON.parse(jsonText);
  const msgList = data.messages || data.history;
  if (!msgList || msgList.length === 0) { toast('备份中没有消息记录'); return; }

  const existing = await dbGetAll('messages');
  const existingTimes = new Set(existing.map(m => m.time));

  let added = 0;
  for (const m of msgList) {
    if (!existingTimes.has(m.time)) {
      const rec = { role: m.role, content: m.content, time: m.time };
      if (m.image) rec.image = m.image;
      await dbPut('messages', null, rec);
      added++;
    }
  }

  { const _m = await dbGetAll('messages'); _m.sort((a,b) => a.time - b.time); messages.length = 0; messages.push(..._m); }
  await saveToLocal();
  await renderMessages();
  toast(`合并完成，新增 ${added} 条，共 ${messages.length} 条`);
}

// ---- 方式一：文件导入 ----
$('#btnImport').onclick = () => $('#fileInputImport').click();
$('#btnImportS').onclick = () => { closeSettings(); $('#fileInputImport').click(); };
$('#btnDecoS').onclick = () => { closeSettings(); toggleDeco(); };
$('#btnStickerS').onclick = () => { closeSettings(); $('#fileInputSticker').click(); };
$('#btnClearS').onclick = () => $('#btnClear').click();
$('#fileInputImport').onchange = async function() {
  if (!this.files[0]) return;
  const full = confirm('📥 完整导入（含聊天记录）？\n\n确定 = 完整导入，恢复聊天+设置+预设（会覆盖现有聊天记录）\n取消 = 只恢复设置/预设/贴纸，聊天记录不动');
  if (full && !confirm('完整导入将覆盖当前聊天记录，确定继续吗？')) {
    this.value = ''; return;
  }
  try {
    const text = await this.files[0].text();
    if (full) {
      await doImport(text);
      this.value = '';
      location.reload();
    } else {
      await doImportPresetsOnly(text);
      this.value = '';
      toast('设置、预设和贴纸已恢复 💙');
    }
  } catch(e) {
    toast('导入失败：' + e.message);
    console.error(e);
    this.value = '';
  }
};

// ======================== 应用 UI ========================
async function applyUI(skipRender = false) {
  const aiAv = await getAiAvatar();
  window._xinyeAvatarSrc = aiAv; // 缓存炘也真实头像，不受RP模式影响
  $('#headerAvatar').src = aiAv;
  $('#headerName').textContent = settings.aiName || '炘也';
  $('#typingAvatar').src = aiAv;
  document.title = `${settings.aiName || '炘也'}的小窝`;
  document.documentElement.style.setProperty('--bubble-opacity', settings.bubbleOpacity);
  btnSearch.classList.toggle('hidden', !settings.braveKey);
  await applyBg();
  if (!skipRender) {
    await renderMessages();
    renderStickers();
  }
  updateBookmarkBadge();
}

// ======================== 炘也主动消息 ========================
async function checkPendingMessage() {
  // xinye-push worker 已删除，跳过
}

// ======================== 启动 ========================
(async () => {
  // 显示版本号
  const _verEl = document.getElementById('appVersion');
  if (_verEl) _verEl.textContent = 'v2026.04.26-friends';

  await openDB();
  await migrateFromLocalStorage();
  await loadAll();

  // IndexedDB 为空 → 尝试从 localStorage 自动恢复
  if (messages.length === 0) {
    const local = loadFromLocal();
    if (local && local.messages && local.messages.length > 0) {
      console.log('[AutoLoad] IndexedDB 为空，从 localStorage 恢复…');
      if (local.settings) {
        Object.assign(settings, local.settings);
        await dbPut('settings', 'main', settings);
      }
      for (const m of local.messages) {
        const rec = { role: m.role, content: m.content, time: m.time };
        if (m.image) rec.image = m.image;
        await dbPut('messages', null, rec);
      }
      if (local.images) {
        if (local.images.aiAvatar) await dbPut('images', 'aiAvatar', local.images.aiAvatar);
        if (local.images.userAvatar) await dbPut('images', 'userAvatar', local.images.userAvatar);
      }
      await loadAll();
      toast('已从本地存档恢复数据');
    }
  }

  await applyUI(false); // 始终渲染消息（数据已在 loadAll 后就绪）
  if (typeof window.syncRpHeader === 'function') window.syncRpHeader(); // RP顶栏覆盖updateHeaderStatus
  const _splash = document.getElementById('splashLoading');
  if (_splash) _splash.style.display = 'none';
  await checkPendingMessage();
  setupReminders();
  resetIdleTimer();
  // ===== 启动时检查：处理 bgTime（Capacitor 和网页浏览器都走这里）=====
  {
    const _bgTime0 = parseInt(localStorage.getItem('fox_bg_time') || '0');
    if (_bgTime0) {
      localStorage.removeItem('fox_bg_time');
      const _elapsed0 = Date.now() - _bgTime0;
      const _SIX_H = (settings.dreamSleepHours || 6) * 3600000;
      if (settings.dreamEnabled && _elapsed0 >= _SIX_H) {
        await generateDream();
        proactiveMsg('dream');
      } else if (!isQuietHours()) {
        if (settings.idleRemind > 0 && _elapsed0 >= settings.idleRemind * 60000)
          proactiveMsg('idle');
        else if (settings.waterRemind > 0 && _elapsed0 >= settings.waterRemind * 60000)
          proactiveMsg('water');
        else if (settings.standRemind > 0 && _elapsed0 >= settings.standRemind * 60000)
          proactiveMsg('stand');
      }
    }
  }
  // 顶栏状态更新
  updateHeaderStatus();
  if (settings.solitudeServerUrl) { checkLocalServer(); setInterval(checkLocalServer, 90_000); }
  if (!isMobile) userInput.focus(); // 移动端不自动弹键盘
  saveToLocal(); // 启动时同步 localStorage，后台进行，不阻塞
})();

// ======================== 写日记功能 ========================
// ======================== 底部 Tab 切换 ========================
let _diaryLoaded = false, _readingLoaded = false;
let _currentTab = 'chat';

function switchTab(tab) {
  if (_currentTab === tab) return;
  _currentTab = tab;

  // 懒加载 iframe
  if (tab === 'diary' && !_diaryLoaded) {
    document.getElementById('diaryFrame').src = 'diary.html'; _diaryLoaded = true;
  }
  if (tab === 'reading' && !_readingLoaded) {
    document.getElementById('readingFrame').src = 'reading.html'; _readingLoaded = true;
  }

  // 显示/隐藏
  document.getElementById('diaryOverlayFrame').classList.toggle('open', tab === 'diary');
  document.getElementById('readingOverlayFrame').classList.toggle('open', tab === 'reading');
  const fp = document.getElementById('friendsPanel');
  if (fp) fp.classList.toggle('open', tab === 'friends');

  // tab按钮高亮
  ['chat','diary','reading','friends'].forEach(t => {
    const el = document.getElementById('tab-' + t);
    if (el) el.classList.toggle('active', t === tab);
  });
  // 聊天页用工具栏里的随手记按钮，日记页用diary.html自带的✏️，共读页不显示FAB（避免挡住翻章节按钮）
  const floatBtn = document.getElementById('quickNoteFloatBtn');
  if (floatBtn) floatBtn.style.display = 'none';
  if (tab === 'friends' && typeof window._friendsRenderList === 'function') window._friendsRenderList();
}

// iframe 内部点返回/跳转聊天 → 切回聊天tab
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

const diaryOverlay = document.getElementById('diaryOverlay');
const diaryTA      = document.getElementById('diaryTA');
const diarySaveBtn = document.getElementById('diarySaveBtn');
const diaryHint    = document.getElementById('diaryHint');

document.getElementById('diaryCancelBtn').onclick = () => diaryOverlay.classList.remove('show');
diaryOverlay.addEventListener('click', e => { if (e.target === diaryOverlay) diaryOverlay.classList.remove('show'); });

diarySaveBtn.onclick = () => {
  const text = diaryTA.value.trim();
  if (!text) return;
  const d = new Date();
  const dateStr = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  if (_diaryType === 'xinye') {
    localStorage.setItem('xinye_diary_' + dateStr, text);
    diaryOverlay.classList.remove('show');
    toast('已存入炘也的日记 💙');
  } else {
    const key = 'rbdiary_' + dateStr;
    let rec = {};
    try { rec = JSON.parse(localStorage.getItem(key) || '{}'); } catch(e) {}
    if (!rec.water) rec.water = 0;
    if (rec.poop === undefined) rec.poop = null;
    if (!rec.todos) rec.todos = [];
    if (!rec.timeline) rec.timeline = [];
    if (!rec.weather) rec.weather = null;
    if (!rec.bodyFeel) rec.bodyFeel = '';
    if (!rec.mood) rec.mood = null;
    rec.note = text;
    localStorage.setItem(key, JSON.stringify(rec));
    diaryOverlay.classList.remove('show');
    toast('已存入今日日记 📓');
  }
};

let _diaryType = 'user';

async function openDiaryGen(type) {
  if (!settings.apiKey) { toast('请先配置 API Key'); return; }
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

// ======================== 启动 ========================


// 更新顶栏状态（天数 + 今日消息数）
function updateHeaderStatus() {
  // RP模式下不覆盖，由applyRpHeader管理
  if (window._rpActive) return;
  const start = new Date(settings.togetherSince || '2026-02-13');
  const today = new Date(); today.setHours(0,0,0,0); start.setHours(0,0,0,0);
  const days = Math.floor((today - start) / (1000*60*60*24)) + 1;
  const todayStart = new Date(); todayStart.setHours(0,0,0,0);
  const todayCount = messages.filter(m => m.time >= todayStart.getTime()).length;
  const el = document.getElementById('headerStatus');
  if (el) {
    const badge = document.getElementById('rpStatusBadge');
    el.textContent = `在一起第 ${days} 天 · 今日 ${todayCount} 条`;
    if (badge) el.appendChild(badge);
  }
}

// 切换RP模式时重新加载对应store的消息（物理隔离）
async function switchRpMode(active) {
  const loadCount = Math.max(settings ? (settings.displayLimit || 0) : 0, 2000);
  const storeName = active ? 'rpMessages' : 'messages';
  { const _m = await dbGetRecent(storeName, loadCount); messages.length = 0; messages.push(..._m); }
  await renderMessages();
  updateHeaderStatus();
}

// 从共读页跳回来时自动填入消息
(async () => {
  const msg = localStorage.getItem('sendToXinye');
  if (msg) {
    localStorage.removeItem('sendToXinye');
    setTimeout(() => {
      const input = document.getElementById('userInput');
      if (input) { input.value = msg; input.dispatchEvent(new Event('input')); input.focus(); }
    }, 100);
  }
})();


async function initFCM() {
  if (!window.Capacitor?.isNativePlatform()) return;
  const { PushNotifications } = window.Capacitor.Plugins;
  if (!PushNotifications) return;

  PushNotifications.addListener('registration', (token) => {
    console.log('[FCM] token:', token.value);
    localStorage.setItem('fcm_token', token.value);
  });

  PushNotifications.addListener('registrationError', (err) => {
    console.error('[FCM] 注册失败:', err);
  });

  // 创建通知渠道（Android 8+ 必须）
if (window.Capacitor?.Plugins?.LocalNotifications) {
  await window.Capacitor.Plugins.LocalNotifications.createChannel({
    id: 'xinye_push',
    name: '炘也',
    description: '炘也的推送消息',
    importance: 5,
    sound: 'default',
    vibration: true,
  });
}
  const perm = await PushNotifications.requestPermissions();
  if (perm.receive === 'granted') {
    await PushNotifications.register();
  }
}

document.addEventListener('deviceready', initFCM, { once: true });
if (document.readyState === 'complete') initFCM();

// ============================= 贴纸系统 =============================
const _DEFAULT_STICKERS = [
  {id:'hug',  name:'抱抱', emoji:'🤗'}, {id:'kiss', name:'亲亲', emoji:'💋'},
  {id:'love', name:'爱你', emoji:'💙'}, {id:'shy',  name:'害羞', emoji:'☺️'},
  {id:'cute', name:'卖萌', emoji:'🥺'}, {id:'poor', name:'装可怜',emoji:'😢'},
  {id:'plead',name:'求求', emoji:'🙏'}, {id:'peek', name:'偷看', emoji:'👀'},
  {id:'sad',  name:'委屈', emoji:'😞'}, {id:'cry',  name:'哭哭', emoji:'😭'},
  {id:'angry',name:'生气', emoji:'😠'}, {id:'smirk',name:'坏笑', emoji:'😏'},
  {id:'meh',  name:'无语', emoji:'🙄'}, {id:'punch',name:'锤你', emoji:'🔨'},
  {id:'kick', name:'踢你', emoji:'🦵'}, {id:'slap', name:'抽你', emoji:'💢'},
];
function getChatStickers() {
  try { const r = localStorage.getItem('xinye_chat_stickers'); if (r) return JSON.parse(r); } catch(e){}
  return _DEFAULT_STICKERS.map(s => ({...s}));
}
function saveChatStickers(arr) { const _v = JSON.stringify(arr); localStorage.setItem('xinye_chat_stickers', _v); lsBackup('xinye_chat_stickers', _v); }
function getStickerByName(name) { return getChatStickers().find(s => s.name === name); }
function renderStickerHTML(name) {
  const s = getStickerByName(name);
  if (s?.image) return `<img class="sticker-img" src="${escHtml(s.image)}" alt="${escHtml(name)}">`;
  return `<span class="sticker-pill">${escHtml(s?.emoji||'🎭')} ${escHtml(name)}</span>`;
}
function detectStickerMsg(content) {
  const m = content?.match(/^（.+?发了一个「(.+?)」贴纸）$/);
  return m ? m[1] : null;
}
function applyStickerTags(el) {
  if (!el) return;
  el.innerHTML = el.innerHTML.replace(/\[sticker:([^\]]{1,20})\]/g, (_, name) =>
    `<span class="sticker-inline">${renderStickerHTML(name.trim())}</span>`);
}
function getStickerHint() {
  const names = getChatStickers().map(s => s.name).join('、');
  return `【贴纸】你可以在回复中自然发贴纸，格式：[sticker:名字]，只在情感真实时使用，不要强行插入。可用：${names}`;
}
// 贴纸面板
function openStickerPanel() {
  const stickers = getChatStickers();
  document.getElementById('stickerGrid').innerHTML = stickers.map(s => {
    const inner = s.image
      ? `<img class="sticker-pick-img" src="${escHtml(s.image)}" alt="">`
      : `<div class="sticker-pick-placeholder">${s.emoji||'🎭'}</div>`;
    return `<button class="sticker-pick-btn" onclick="sendStickerMsg('${escHtml(s.name)}')">${inner}<span>${escHtml(s.name)}</span></button>`;
  }).join('');
  document.getElementById('stickerPanel').classList.add('show');
}
function closeStickerPanel() { document.getElementById('stickerPanel').classList.remove('show'); }
async function sendStickerMsg(name) {
  closeStickerPanel();
  const userName = settings.userName || '涂涂';
  const stickerText = `（${userName}发了一个「${name}」贴纸）`;
  const existing = userInput.value.trim();
  userInput.value = existing ? existing + ' ' + stickerText : stickerText;
  await sendMessage();
  const userBubbles = chatArea.querySelectorAll('.msg-row.user .msg-bubble');
  const lastBubble = userBubbles[userBubbles.length - 1];
  if (!lastBubble) return;
  if (existing) {
    // 有额外文字：只把贴纸文本替换成内联贴纸图，保留文字
    lastBubble.innerHTML = lastBubble.innerHTML.replace(
      escHtml(stickerText),
      `<span class="sticker-inline">${renderStickerHTML(name)}</span>`
    );
  } else if (!lastBubble.classList.contains('bubble-sticker')) {
    lastBubble.classList.add('bubble-sticker');
    lastBubble.innerHTML = renderStickerHTML(name);
  }
}
// 贴纸设置管理
function renderStickerMgr() {
  const stickers = getChatStickers();
  const el = document.getElementById('stickerMgrList');
  if (!el) return;
  el.innerHTML = stickers.map((s, i) => {
    const preview = s.image
      ? `<img class="sticker-mgr-preview" src="${escHtml(s.image)}" alt="" style="width:36px;height:36px;object-fit:contain;border-radius:8px">`
      : `<div class="sticker-mgr-preview">${s.emoji||'🎭'}</div>`;
    return `<div class="sticker-mgr-item">
      ${preview}
      <span class="sticker-mgr-name">${escHtml(s.name)}</span>
      <label class="sticker-mgr-upload">上传图<input type="file" accept="image/*" style="display:none" onchange="uploadStickerImg(${i},this)"></label>
      ${s.image ? `<span class="sticker-mgr-upload" onclick="clearStickerImg(${i})" style="color:#e57373">删图</span>` : ''}
      <button class="sticker-mgr-del" onclick="deleteStickerItem(${i})" title="删除">✕</button>
    </div>`;
  }).join('');
}
function addStickerItem() {
  const input = document.getElementById('newStickerName');
  const name = input.value.trim();
  if (!name) return;
  const stickers = getChatStickers();
  if (stickers.find(s => s.name === name)) { toast('已有同名贴纸'); return; }
  stickers.push({ id: 'custom_' + Date.now(), name, emoji: '🎭' });
  saveChatStickers(stickers);
  input.value = '';
  renderStickerMgr();
  toast('贴纸已添加 🎭');
}
function deleteStickerItem(idx) {
  const stickers = getChatStickers();
  stickers.splice(idx, 1);
  saveChatStickers(stickers);
  renderStickerMgr();
}
function uploadStickerImg(idx, input) {
  const file = input.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    const stickers = getChatStickers();
    stickers[idx].image = e.target.result;
    saveChatStickers(stickers);
    renderStickerMgr();
    toast('图片已更新 ✨');
  };
  reader.readAsDataURL(file);
}
function clearStickerImg(idx) {
  const stickers = getChatStickers();
  delete stickers[idx].image;
  saveChatStickers(stickers);
  renderStickerMgr();
}
document.getElementById('btnAddSticker')?.addEventListener('click', addStickerItem);

// ===== 全局随手记 =====
function quickNoteOpen() {
  const now = new Date();
  const hm = String(now.getHours()).padStart(2,'0') + ':' + String(now.getMinutes()).padStart(2,'0');
  const dateStr = now.getFullYear() + '-' + String(now.getMonth()+1).padStart(2,'0') + '-' + String(now.getDate()).padStart(2,'0');
  document.getElementById('quickNoteMeta').textContent = dateStr + '  ' + hm;
  document.getElementById('quickNoteTA').value = '';
  document.getElementById('quickNoteModal').classList.add('show');
  setTimeout(() => document.getElementById('quickNoteTA').focus(), 280);
}
function quickNoteClose() {
  document.getElementById('quickNoteModal').classList.remove('show');
}
function quickNoteSave() {
  const text = document.getElementById('quickNoteTA').value.trim();
  if (!text) { document.getElementById('quickNoteTA').focus(); return; }
  const now = new Date();
  const dateStr = now.getFullYear() + '-' + String(now.getMonth()+1).padStart(2,'0') + '-' + String(now.getDate()).padStart(2,'0');
  const hm = String(now.getHours()).padStart(2,'0') + ':' + String(now.getMinutes()).padStart(2,'0');
  // 存入 localStorage（兼容日记现有格式）
  let entry = {};
  try { entry = JSON.parse(localStorage.getItem('rbdiary_' + dateStr) || '{}'); } catch {}
  if (!Array.isArray(entry.snippets)) entry.snippets = [];
  entry.snippets.push({ time: hm, text: text, ts: now.getTime() });
  localStorage.setItem('rbdiary_' + dateStr, JSON.stringify(entry));
  quickNoteClose();
  // 刷新日记 iframe（如果已加载）
  try {
    const frame = document.getElementById('diaryFrame');
    if (frame && frame.contentWindow && typeof frame.contentWindow.renderBoth === 'function') {
      frame.contentWindow.renderBoth();
    }
  } catch(e) {}
  // toast 提示
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

(function(){
  // ---- 状态 ----
  let rpActive = localStorage.getItem('rp_active') === '1';
  let rpPresets = JSON.parse(localStorage.getItem('rp_presets') || '[]');

  // ---- 初始化 UI ----
  function rpInit() {
    // 直接读localStorage，不依赖loadAll的执行顺序
    rpActive = localStorage.getItem('rp_active') === '1';
    window._rpActive = rpActive;
    const ta = document.getElementById('rpPromptInput');
    if (ta) ta.value = localStorage.getItem('rp_prompt') || '';
    const nameInput = document.getElementById('rpCharName');
    if (nameInput) nameInput.value = localStorage.getItem('rp_char_name') || '';
    const userNameInput = document.getElementById('rpUserName');
    if (userNameInput) userNameInput.value = localStorage.getItem('rp_user_name') || '';
    refreshRpCharAvatar();
    refreshRpUserAvatar();
    refreshRpPresetSelect();
    applyRpUI();
  }

  // ---- TA的角色头像上传 ----
  window.handleRpAvatarUpload = function(input) {
    const file = input.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = e => {
      localStorage.setItem('rp_char_avatar', e.target.result);
      lsBackup('rp_char_avatar', e.target.result);
      refreshRpCharAvatar();
      if (rpActive) applyRpHeader();
    };
    reader.readAsDataURL(file);
    input.value = '';
  };

  // ---- 清除TA的头像 ----
  window.clearRpAvatar = function() {
    localStorage.removeItem('rp_char_avatar');
    lsRemoveBackup('rp_char_avatar');
    refreshRpCharAvatar();
    if (rpActive) applyRpHeader();
  };

  // ---- 我的角色头像上传 ----
  window.handleRpUserAvatarUpload = function(input) {
    const file = input.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = e => {
      localStorage.setItem('rp_user_avatar', e.target.result);
      lsBackup('rp_user_avatar', e.target.result);
      refreshRpUserAvatar();
    };
    reader.readAsDataURL(file);
    input.value = '';
  };

  // ---- 清除我的头像 ----
  window.clearRpUserAvatar = function() {
    localStorage.removeItem('rp_user_avatar');
    lsRemoveBackup('rp_user_avatar');
    refreshRpUserAvatar();
  };

  // ---- 保存角色名（TA + 我） ----
  window.saveRpCharInfo = function() {
    const name = document.getElementById('rpCharName')?.value || '';
    localStorage.setItem('rp_char_name', name);
    lsBackup('rp_char_name', name);
    const userName = document.getElementById('rpUserName')?.value || '';
    localStorage.setItem('rp_user_name', userName);
    lsBackup('rp_user_name', userName);
    if (rpActive) applyRpHeader();
  };

  // ---- 刷新面板里TA的头像预览 ----
  function refreshRpCharAvatar() {
    const av = localStorage.getItem('rp_char_avatar');
    const img = document.getElementById('rpCharAvatar');
    const placeholder = document.getElementById('rpCharAvatarPlaceholder');
    if (!img || !placeholder) return;
    if (av) { img.src = av; img.style.display = 'block'; placeholder.style.display = 'none'; }
    else { img.style.display = 'none'; placeholder.style.display = 'flex'; }
  }

  // ---- 刷新面板里我的头像预览 ----
  function refreshRpUserAvatar() {
    const av = localStorage.getItem('rp_user_avatar');
    const img = document.getElementById('rpUserAvatar');
    const placeholder = document.getElementById('rpUserAvatarPlaceholder');
    if (!img || !placeholder) return;
    if (av) { img.src = av; img.style.display = 'block'; placeholder.style.display = 'none'; }
    else { img.style.display = 'none'; placeholder.style.display = 'flex'; }
  }

  // ---- 切换顶栏和输入指示头像/名字/副标题 ----
  function applyRpHeader() {
    const charName = localStorage.getItem('rp_char_name') || '';
    const charAvatar = localStorage.getItem('rp_char_avatar') || '';
    const headerAv = document.getElementById('headerAvatar');
    const headerNm = document.getElementById('headerName');
    const typingAv = document.getElementById('typingAvatar');
    const statusEl = document.getElementById('headerStatus');
    const badge = document.getElementById('rpStatusBadge');
    if (rpActive) {
      if (charAvatar && headerAv) headerAv.src = charAvatar;
      if (charName && headerNm) headerNm.textContent = charName;
      if (charAvatar && typingAv) typingAv.src = charAvatar;
      // 顶栏副标题换成RP提示，隐藏炘也关系数据
      if (statusEl) {
        statusEl.textContent = '🎭 RP进行中';
        if (badge) { statusEl.appendChild(badge); badge.classList.remove('show'); }
      }
    } else {
      // 恢复炘也原始信息
      getAiAvatar().then(av => {
        if (headerAv) headerAv.src = av;
        if (typingAv) typingAv.src = av;
      });
      if (headerNm) headerNm.textContent = (typeof settings !== 'undefined' && settings.aiName) || '炘也';
      // 恢复顶栏副标题（updateHeaderStatus会重新计算并保留badge）
      if (typeof updateHeaderStatus === 'function') updateHeaderStatus();
    }
  }

  // ---- 供启动流程在applyUI后调用，确保RP顶栏状态覆盖updateHeaderStatus ----
  window.syncRpHeader = function() {
    if (rpActive) applyRpHeader();
  };

  // ---- 暴露给 renderMessages/appendMsgDOM 用的有效AI头像 ----
  window.getEffectiveAiAvatar = async function() {
    if (rpActive) {
      const av = localStorage.getItem('rp_char_avatar');
      if (av) return av;
    }
    return getAiAvatar();
  };

  // ---- 暴露给 renderMessages/appendMsgDOM 用的有效用户头像 ----
  window.getEffectiveUserAvatar = async function() {
    if (rpActive) {
      const av = localStorage.getItem('rp_user_avatar');
      if (av) return av;
    }
    return getUserAvatar();
  };

  // ---- 暴露给 sendMessage 用的用户角色名 ----
  window.getRpUserName = function() {
    return rpActive ? (localStorage.getItem('rp_user_name') || '') : '';
  };

  // ---- 打开面板（从🎭按钮点击） ----
  window.openRpPanel = function() {
    const panel = document.getElementById('rpPanel');
    panel.classList.add('show');
    document.getElementById('rpPromptInput').focus();
  };

  // ---- 关闭面板 ----
  window.closeRpPanel = function() {
    document.getElementById('rpPanel').classList.remove('show');
  };

  // ---- 切换激活状态 ----
  window.toggleRpActive = async function() {
    rpActive = !rpActive;
    localStorage.setItem('rp_active', rpActive ? '1' : '0');
    lsBackup('rp_active', rpActive ? '1' : '0');
    window._rpActive = rpActive;
    applyRpUI();
    toast(rpActive ? '🎭 RP模式已开启，对话已隔离' : '🎭 RP模式已关闭，恢复正常聊天');
    // 切换消息视图（隔离RP上下文）
    if (typeof switchRpMode === 'function') await switchRpMode(rpActive);
  };

  // ---- 保存当前输入的设定 ----
  window.saveRpPrompt = function() {
    const val = document.getElementById('rpPromptInput').value;
    localStorage.setItem('rp_prompt', val);
    lsBackup('rp_prompt', val);
  };

  // ---- 保存为预设 ----
  window.saveRpPreset = function() {
    const text = document.getElementById('rpPromptInput').value.trim();
    if (!text) { toast('先写点RP设定再保存'); return; }
    const nameInput = document.getElementById('rpPresetNameInput');
    const name = (nameInput?.value || '').trim();
    if (!name) { toast('请先填写预设名称'); nameInput?.focus(); return; }
    const charName = document.getElementById('rpCharName')?.value || '';
    const userName = document.getElementById('rpUserName')?.value || '';
    // 头像base64太大不存进预设（保留在独立key里），只存名字和设定文本
    const preset = { name, text, charName, userName };
    const idx = rpPresets.findIndex(p => p.name === name);
    if (idx >= 0) rpPresets[idx] = preset;
    else rpPresets.push(preset);
    const _rpPresetsStr = JSON.stringify(rpPresets);
    localStorage.setItem('rp_presets', _rpPresetsStr);
    lsBackup('rp_presets', _rpPresetsStr);
    refreshRpPresetSelect();
    if (nameInput) nameInput.value = '';
    toast('✨ 已保存「' + name + '」');
  };

  // ---- 加载预设 ----
  window.loadRpPreset = function() {
    const sel = document.getElementById('rpPresetSelect');
    const idx = parseInt(sel.value);
    if (isNaN(idx) || idx < 0) return;
    const p = rpPresets[idx];
    if (!p) return;
    document.getElementById('rpPromptInput').value = p.text;
    localStorage.setItem('rp_prompt', p.text);
    lsBackup('rp_prompt', p.text);
    // 恢复角色名和头像
    const nameInput = document.getElementById('rpCharName');
    if (nameInput) nameInput.value = p.charName || '';
    localStorage.setItem('rp_char_name', p.charName || '');
    lsBackup('rp_char_name', p.charName || '');
    const userNameInput2 = document.getElementById('rpUserName');
    if (userNameInput2) userNameInput2.value = p.userName || '';
    localStorage.setItem('rp_user_name', p.userName || '');
    lsBackup('rp_user_name', p.userName || '');
    // 头像不随预设切换（太大），只切名字和文本
    refreshRpCharAvatar();
    refreshRpUserAvatar();
    if (rpActive) applyRpHeader();
  };

  // ---- 删除预设 ----
  window.deleteRpPreset = function() {
    const sel = document.getElementById('rpPresetSelect');
    const idx = parseInt(sel.value);
    if (isNaN(idx) || idx < 0) { toast('先选一个预设'); return; }
    const name = rpPresets[idx].name;
    rpPresets.splice(idx, 1);
    const _rpDelStr = JSON.stringify(rpPresets);
    localStorage.setItem('rp_presets', _rpDelStr);
    lsBackup('rp_presets', _rpDelStr);
    refreshRpPresetSelect();
    toast('已删除「' + name + '」');
  };

  // ---- 刷新预设下拉 ----
  function refreshRpPresetSelect() {
    const sel = document.getElementById('rpPresetSelect');
    if (!sel) return;
    sel.innerHTML = '<option value="">— 选择保存的预设 —</option>' +
      rpPresets.map((p, i) => `<option value="${i}">${p.name}</option>`).join('');
  }

  // ---- 更新所有UI状态 ----
  function applyRpUI() {
    const btn = document.getElementById('btnRp');
    const badge = document.getElementById('rpStatusBadge');
    const dot = document.getElementById('rpActiveDot');
    const toggleBtn = document.getElementById('rpToggleBtn');
    if (btn) btn.classList.toggle('active', rpActive);
    if (badge) badge.classList.toggle('show', rpActive);
    if (dot) dot.classList.toggle('on', rpActive);
    if (toggleBtn) {
      toggleBtn.textContent = rpActive ? '已开启' : '未开启';
      toggleBtn.className = 'rp-toggle-btn ' + (rpActive ? 'on' : 'off');
    }
    applyRpHeader();
  }

  // ---- 暴露给sendMessage用的getter ----
  window.getRpInjection = function() {
    if (!rpActive) return null;
    const prompt = localStorage.getItem('rp_prompt') || '';
    // RP激活时即使没写设定也返回非null，确保记忆档案/健康数据不被注入
    return prompt.trim() || '【RP模式】';
  };

  // ---- DOM ready后初始化 ----
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', rpInit);
  } else {
    rpInit();
  }
})();

// Friends IIFE 已提取到 src/modules/friends.js