import { toast, fallbackCopy, escHtml, isDarkMode, fmtTime, fmtFull, readFileAsBase64 } from './modules/utils.js';
import { toggleDeco, applyTheme, initTheme, applyBgImage, applyBgVideo, applyBg, initBgHandlers } from './modules/ui.js';
import { resetIdleTimer, setupReminders, isQuietHours, scheduleBackgroundNotifications, cancelBackgroundNotifications, generateDream, proactiveMsg } from './modules/notifications.js';
import { db, openDB, dbPut, dbGet, lsBackup, lsRemoveBackup, dbGetAll, dbGetRecent, dbGetRecentFiltered, dbDelete, dbClear, dbGetAllKeys } from './modules/db.js';
import { settings, saveSettings, ensureMemoryState, ensureMemoryBank, normalizeMemoryEntry, createMemoryId, initSaveHook, messages } from './modules/state.js';
import { stripForTTS, _hasTTSMarkers, generateTTSBlob, markCached, playAudioBlob, playTTS, enqueueTTS, showVoiceBar, downloadTTS, exportTTSCache } from './modules/tts.js';
import { getApiPresets, setApiPresets, getVisionPresets, setVisionPresets, getImagePresets, setImagePresets, getSubApiCfg, mainApiFetch, subApiFetch } from './modules/api.js';
import { stripThinkingTags, getEmbedding, getMemoryContextBlocks, parseAndSaveSelfMemories, updateMoodState, autoDigestMemory, digestMemory, cleanupMemoryBank, saveOneMemoryToBank, rebuildArchiveIndex, renderMemoryBankPreview, renderMemoryEntryChip, renderMemoryViewer, openMemoryViewer, setMemViewerFilter, toggleMemoryPin, toggleMemoryResolved, deleteMemoryEntry, editMemoryEntry, saveMemoryEdit, skipMemoryCursorToEnd, resetMemoryCursor, manualExtractBatch, rememberLatestExchange, testEmbeddingApi, archiveMemoryBank, autoSyncArchiveToLocal, initMemoryDeps, cosineSimilarity, dedupMemoryBank, detectMemoryConflicts } from './modules/memory.js';
import { toggleBookmark, updateBookmarkBadge, openBookmarksPanel, renderBookmarksPanel, toggleBmExpand, removeBookmark, getAiAvatar, getUserAvatar, activeStore, addMessage, updateMessage, renderMessages, appendMsgDOM, scrollBottom, deleteMessage, renderMdHtml, linkifyEl, saveTokenLog, renderTokenLog, sendMessage } from './modules/chat.js';
import { getDecoStickers, setDecoStickers, renderStickers, getChatStickers, saveChatStickers, loadChatStickers, renderStickerMgr, initStickers } from './modules/stickers.js';
import { switchTab, openDiaryGen, initDiary, quickNoteOpen, quickNoteClose, quickNoteSave } from './modules/diary.js';
import { saveToLocal, loadFromLocal, autoBackupToServer } from './modules/backup.js';
import { openSettings, closeSettings, renderApiPresets, renderVisionPresets, renderImagePresets, renderTtsPresets, updateTtsTypeUI, activateTtsPreset, deleteTtsPreset, checkerActivate, applyUI, updateHeaderStatus, checkLocalServer, notifySwLocalServer, updateLocalServerDot, isLocalServerOnline, initSettings, fetchModelList, testVisionApi, getCloudOrLocalUrl, buildServerFetchUrl, buildServerHeaders } from './modules/settings.js';
import { triggerDrawImage, initImageUpload, compositeRefImages, base64ToFile, autoSaveGenImage, generateImage } from './modules/image.js';
import { checkMorningWalk, startReminderPoller } from './modules/walk.js';
import { checkGift } from './modules/gift.js';
import { showFortuneWheel, spinFortune, formatFortuneResult } from './modules/fortune.js';
import { initRp } from './modules/rp.js';
// ── 立即暴露inline handler函数到window（函数声明已提升，放这里保证任何后续错误都不影响）──
Object.assign(window, {
  switchTab, openBookmarksPanel,
  openMemoryViewer, renderMemoryViewer, renderMemoryBankPreview,
  setMemViewerFilter, resetMemoryCursor, skipMemoryCursorToEnd,
  rebuildArchiveIndex, manualExtractBatch, dedupMemoryBank, detectMemoryConflicts,
  toggleMemoryPin, toggleMemoryResolved, deleteMemoryEntry, editMemoryEntry, saveMemoryEdit,
  quickNoteOpen, quickNoteClose, quickNoteSave,
  removeBookmark, toggleBmExpand,
  fetchModelList, testEmbeddingApi, testVisionApi, describeImagesWithVision,
  updateTtsTypeUI, triggerDrawImage, generateImage, sendKiss, compositeRefImages, base64ToFile, autoSaveGenImage,
  checkerActivate, openFortune,
  maybeTTS, autoResize, resetIdleTimer, updateSendBtn,
  scheduleAutoSave, updateHeaderStatus, sendMessage,
  exportTTSCache,
});

if('serviceWorker' in navigator){
  let _swRefreshing = false;
  const _swReload = () => {
    if (_swRefreshing) return;
    _swRefreshing = true;
    if (window.isRequesting) {
      const _t = setInterval(() => { if (!window.isRequesting) { clearInterval(_t); location.reload(); } }, 1000);
    } else location.reload();
  };
  // 最可靠的检测：新SW接管控制权时直接reload
  navigator.serviceWorker.addEventListener('controllerchange', () => _swReload());
  window.addEventListener('load',()=>{
    navigator.serviceWorker.register('/sw.js').then(reg => {
      reg.addEventListener('updatefound', () => {
        const nw = reg.installing;
        if (!nw) return;
        nw.addEventListener('statechange', () => {
          if (nw.state === 'activated' && navigator.serviceWorker.controller) _swReload();
        });
      });
    }).catch(()=>{});
    navigator.serviceWorker.addEventListener('message', e => {
      if (e.data?.type === 'SW_UPDATED') _swReload();
      if (e.data?.type === 'PUSH_MESSAGE') {
        const _targetApp = e.data.appId || 'xinye';
        if (_targetApp === (window.__APP_ID__ || 'xinye')) window._consumePushInbox?.();
      }
    });
  });
  // 切回前台时主动检查SW更新
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && navigator.serviceWorker.controller) {
      navigator.serviceWorker.ready.then(reg => reg.update()).catch(()=>{});
    }
  });
}

  window._vConsole = new VConsole({ theme: 'dark' });
  window._vConsole.setSwitchPosition(window.innerWidth / 2, 0);

// ======================== vConsole 日志持久化 ========================
// 页面被系统回收重载后，自动恢复之前的日志到 vConsole
{
  const _VC_KEY = 'vconsole_logs';
  const _VC_MAX = 200;
  const _origLog = console.log, _origWarn = console.warn, _origError = console.error;

  function _vcSave(level, args) {
    try {
      const logs = JSON.parse(sessionStorage.getItem(_VC_KEY) || '[]');
      const text = Array.from(args).map(a => {
        if (typeof a === 'string') return a.length > 300 ? a.slice(0, 300) + '…' : a;
        try { const s = JSON.stringify(a); return s && s.length > 300 ? s.slice(0, 300) + '…' : s; }
        catch { return String(a); }
      }).join(' ');
      logs.push({ l: level, t: text, ts: Date.now() });
      if (logs.length > _VC_MAX) logs.splice(0, logs.length - _VC_MAX);
      sessionStorage.setItem(_VC_KEY, JSON.stringify(logs));
    } catch {}
  }

  console.log = function(...a) { _vcSave('log', a); return _origLog.apply(console, a); };
  console.warn = function(...a) { _vcSave('warn', a); return _origWarn.apply(console, a); };
  console.error = function(...a) { _vcSave('error', a); return _origError.apply(console, a); };

  // 页面加载时恢复之前的日志
  try {
    const prev = JSON.parse(sessionStorage.getItem(_VC_KEY) || '[]');
    if (prev.length > 0) {
      const tag = `📦 恢复 ${prev.length} 条日志 (${new Date(prev[0].ts).toLocaleTimeString()}~${new Date(prev[prev.length-1].ts).toLocaleTimeString()})`;
      _origLog.call(console, tag);
      for (const e of prev) {
        const fn = e.l === 'error' ? _origError : e.l === 'warn' ? _origWarn : _origLog;
        fn.call(console, `[${new Date(e.ts).toLocaleTimeString()}]`, e.t);
      }
      _origLog.call(console, '📦 ── 恢复结束 ──');
    }
  } catch {}
}

// ======================== 默认 Emoji 头像 ========================

// ======================== DOM ========================
const $ = s => document.querySelector(s);
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



// 路径清洗：反斜杠→正斜杠，去首尾引号
// ======================== 自动存档 (localStorage) ========================
let _autoSaveTimer = null;

function scheduleAutoSave() {
  clearTimeout(_autoSaveTimer);
  _autoSaveTimer = setTimeout(() => saveToLocal(), 300);
}
initSaveHook(scheduleAutoSave);
initMemoryDeps({ isLocalOnline: isLocalServerOnline });

// 暗夜/装修模式初始化（函数在 ui.js）
initTheme();
initBgHandlers();

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
  console.log('[loadAll] ttsAutoPlay =', settings.ttsAutoPlay, '(from IDB:', s?.ttsAutoPlay, ')');
  ensureMemoryState();
  // 从 IDB 恢复被华为"清缓存"清掉的 localStorage 数据
  const _PFX = window.__APP_ID__ === 'choubao' ? 'choubao_' : '';
  const _lsBackupKeys = [_PFX+'xinye_api_presets',_PFX+'xinye_vision_presets',_PFX+'xinye_image_presets',_PFX+'rp_prompt',_PFX+'rp_presets',_PFX+'rp_char_name',_PFX+'rp_char_avatar',_PFX+'rp_active',_PFX+'rp_user_name',_PFX+'rp_user_avatar'];
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
  { const _m = await dbGetRecent(_msgStore, loadCount, true); messages.length = 0; messages.push(..._m); }
  setDecoStickers(await dbGetAll('stickers'));
  await loadChatStickers();
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

function maybeTTS(text, msgId) {
  const sr = !!window._speakRequested;
  window._speakRequested = false;
  const shouldSpeak = sr;
  if (shouldSpeak) {
    settings.speakTTSIds = settings.speakTTSIds || [];
    if (!settings.speakTTSIds.includes(msgId)) settings.speakTTSIds.push(msgId);
    saveSettings();
  }
  const autoPlay = settings.ttsAutoPlay;
  const hasText = !!text;
  const willCall = (autoPlay || shouldSpeak) && hasText;
  console.log('[maybeTTS] 调用：autoPlay=', autoPlay, 'shouldSpeak=', shouldSpeak, 'hasText=', hasText, 'textLen=', (text||'').length, 'msgId=', msgId, 'willCall=', willCall);
  if (willCall) enqueueTTS(text, msgId, shouldSpeak);
}
// ======================== 发送 & API ========================
window.isRequesting = false;

// ======================== 识图描述（Vision → imageDescs） ========================
async function describeImagesWithVision(imgs) {
  const key = settings.visionApiKey;
  const base = (settings.visionBaseUrl || 'https://api.siliconflow.cn/v1').replace(/\/+$/, '');
  const model = settings.visionModel || 'zai-org/GLM-4.6V';
  const url = /\/v\d+$/.test(base) ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
  console.log('[识图] 开始', { model, url, imgs: imgs.map(s => s.slice(0,40)) });
  return Promise.all(imgs.map(async (imgUrl, i) => {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: [
            { type: 'image_url', image_url: { url: imgUrl } },
            { type: 'text', text: '请详细描述这张图片的内容，用中文回答。包括：人物外貌/表情/动作/穿着、物体、场景环境、色调氛围、图中如有文字请原文转述。尽量完整，不省略细节。' }
          ]}],
          max_tokens: 1000,
          stream: false
        })
      });
      if (!res.ok) { const t = await res.text(); console.warn(`[识图] 图${i+1} HTTP ${res.status}`, t.slice(0,200)); return null; }
      const data = await res.json();
      const desc = data?.choices?.[0]?.message?.content?.trim() || null;
      console.log(`[识图] 图${i+1} 结果:`, desc || '(空)');
      return desc;
    } catch(e) { console.error(`[识图] 图${i+1} 异常`, e); return null; }
  }));
}

// ---- 亲嘴功能 ----
function openFortune() {
  showFortuneWheel(async (result) => {
    const text = `[🎰 命运转盘] ${formatFortuneResult(result)}`;
    const userInput = document.getElementById('userInput');
    if (userInput) { userInput.value = text; window.sendMessage?.(); }
  });
}

function sendKiss() {
  if (window.isRequesting) return;
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

const btnSearch = $('#btnSearch');
if (!settings.braveKey) btnSearch.classList.add('hidden');
btnSend.onclick = sendMessage;
// 🔍按钮：强制炘也先用 web_search 工具搜索再回答
window._forceSearch = false;
btnSearch.onclick = () => {
  if (settings.braveKey) { window._forceSearch = true; sendMessage(); }
};
// 发送按钮：空时变灰
function updateSendBtn() {
  btnSend.disabled = window.isRequesting || userInput.value.trim() === '';
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
    if (window.visualViewport.offsetTop > 0) window.scrollTo(0, 0);
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
initImageUpload();


// ======================== 炘也主动消息 ========================
async function checkPendingMessage() {
  // xinye-push worker 已删除，跳过
}

// ======================== 启动 ========================
(async () => {
  // 显示版本号
  const _verEl = document.getElementById('appVersion');
  if (_verEl) _verEl.textContent = 'v2026.09.11-1619';

  await openDB();
  await migrateFromLocalStorage();
  await loadAll();
  window.chatLastUserImage = (await dbGet('images', 'chatLastUserImage').catch(() => null)) || null;
  initStickers();
  initDiary();
  initSettings();

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
  checkMorningWalk();
  checkGift();
  startReminderPoller();

  if (!isMobile) userInput.focus(); // 移动端不自动弹键盘
  saveToLocal(); // 启动时同步 localStorage，后台进行，不阻塞
  _registerPush();
  _consumePushInbox();

  // 页面从后台恢复时自动拉取心跳消息
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') _consumePushInbox();
  });

  // 前台定时轮询心跳消息（30秒），鸿蒙无FCM靠轮询兜底
  setInterval(() => {
    if (document.visibilityState === 'visible') _consumePushInbox();
  }, 30_000);

  // 注册 Periodic Background Sync（让SW在后台也能定期拉消息）
  _registerPeriodicSync();
})();

// ── Periodic Background Sync（后台定期拉消息，替代FCM）──────────────────────
async function _registerPeriodicSync() {
  try {
    const reg = await navigator.serviceWorker.ready;
    if (!('periodicSync' in reg)) { console.log('[Sync] 浏览器不支持 periodicSync'); return; }
    const status = await navigator.permissions.query({ name: 'periodic-background-sync' });
    if (status.state !== 'granted') { console.log('[Sync] periodicSync 权限未授予:', status.state); return; }
    await reg.periodicSync.register('pull-heartbeat', { minInterval: 15 * 60 * 1000 });
    console.log('[Sync] periodicSync 注册成功（15分钟）');
  } catch(e) { console.log('[Sync] periodicSync 注册失败:', e.message); }
}

// ── Web Push 注册 ─────────────────────────────────────────────────────────
function _urlB64ToU8(b64) {
  const pad = '='.repeat((4 - b64.length % 4) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}

async function _registerPush() {
  if (!('PushManager' in window)) { console.log('[Push] 浏览器不支持 PushManager'); return; }
  if (!('serviceWorker' in navigator)) { console.log('[Push] 浏览器不支持 ServiceWorker'); return; }
  const srv = getCloudOrLocalUrl();
  if (!srv) { console.log('[Push] 无可用服务器，跳过注册'); return; }
  try {
    const res = await fetch(buildServerFetchUrl(srv, '/api/push-vapid-public-key'), { headers: buildServerHeaders(srv), signal: AbortSignal.timeout(4000) });
    if (!res.ok) { console.log('[Push] VAPID key 获取失败:', res.status); return; }
    const { publicKey } = await res.json();
    if (!publicKey) { console.log('[Push] VAPID key 为空'); return; }
    const perm = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
    if (perm !== 'granted') { console.log('[Push] 通知权限未授予:', perm); return; }
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    console.log(`[Push] 当前订阅: ${sub ? '有' : '无'}`);
    if (!sub) {
      // FCM连接不稳定，重试最多4次（间隔3s/6s/12s/20s）
      const delays = [0, 3000, 6000, 12000, 20000];
      for (let i = 0; i < delays.length; i++) {
        if (i > 0) { console.log(`[Push] 第${i}次重试，等待${delays[i]/1000}秒...`); await new Promise(r => setTimeout(r, delays[i])); }
        try {
          sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: _urlB64ToU8(publicKey) });
          console.log(`[Push] 新建订阅成功${i > 0 ? '（第'+i+'次重试）' : ''}`);
          break;
        } catch(e2) {
          console.log(`[Push] 订阅尝试${i+1}失败: ${e2.message}`);
          if (i === delays.length - 1) {
            console.error('[Push] 全部重试失败，等下次启动再试');
            // 失败了也启动后台重试（每60秒试一次，成功就停）
            _retrySubscribeInBackground(reg, publicKey, srv);
            return;
          }
        }
      }
    }
    if (!sub) return;
    const subJson = sub.toJSON();
    const epType = subJson.endpoint?.includes('fcm') ? 'FCM' : subJson.endpoint?.includes('mozilla') ? 'Firefox' : subJson.endpoint?.includes('wns') ? 'Windows' : '未知';
    console.log(`[Push] 订阅类型: ${epType}, endpoint: ${subJson.endpoint?.slice(0, 60)}...`);
    const oldEp = localStorage.getItem('push_last_endpoint') || '';
    const regBody = { ...subJson, oldEndpoint: (oldEp && oldEp !== subJson.endpoint) ? oldEp : undefined };
    const regRes = await fetch(buildServerFetchUrl(srv, '/api/push-subscribe'), {
      method: 'POST', headers: buildServerHeaders(srv, { 'Content-Type': 'application/json' }),
      body: JSON.stringify(regBody), signal: AbortSignal.timeout(4000)
    });
    if (regRes.ok) {
      console.log('[Push] 订阅注册成功');
      localStorage.setItem('push_endpoint_type', epType);
      localStorage.setItem('push_last_endpoint', subJson.endpoint);
      localStorage.setItem('push_last_registered', new Date().toISOString());
    } else {
      console.log('[Push] 订阅注册失败:', regRes.status);
    }
  } catch(e) { console.log('[Push] 注册异常:', e.message); }
}

// 后台每60秒重试一次FCM订阅（成功即停，最多试10分钟）
let _pushRetryTimer = null;
function _retrySubscribeInBackground(reg, publicKey, srv) {
  if (_pushRetryTimer) return;
  let attempts = 0;
  _pushRetryTimer = setInterval(async () => {
    attempts++;
    if (attempts > 10) { clearInterval(_pushRetryTimer); _pushRetryTimer = null; console.log('[Push] 后台重试超时，放弃'); return; }
    try {
      let sub = await reg.pushManager.getSubscription();
      if (sub) { clearInterval(_pushRetryTimer); _pushRetryTimer = null; console.log('[Push] 后台检测到已有订阅'); return; }
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: _urlB64ToU8(publicKey) });
      clearInterval(_pushRetryTimer); _pushRetryTimer = null;
      console.log(`[Push] 后台重试成功（第${attempts}次）`);
      const subJson = sub.toJSON();
      const epType = subJson.endpoint?.includes('fcm') ? 'FCM' : subJson.endpoint?.includes('mozilla') ? 'Firefox' : subJson.endpoint?.includes('wns') ? 'Windows' : '未知';
      const regRes = await fetch(buildServerFetchUrl(srv, '/api/push-subscribe'), {
        method: 'POST', headers: buildServerHeaders(srv, { 'Content-Type': 'application/json' }),
        body: JSON.stringify(subJson), signal: AbortSignal.timeout(4000)
      });
      if (regRes.ok) {
        localStorage.setItem('push_endpoint_type', epType);
        localStorage.setItem('push_last_endpoint', subJson.endpoint);
        localStorage.setItem('push_last_registered', new Date().toISOString());
        console.log('[Push] 后台订阅注册成功');
      }
    } catch(e) { console.log(`[Push] 后台重试${attempts}失败: ${e.message}`); }
  }, 60000);
}

// 启动时从 PushInbox 消费炘也主动消息（后台收到push时写入的）+ 从云端拉取心跳主动消息
// 4个触发源（启动/visibilitychange/30秒轮询/SW消息）可能同时打进来，必须防重入，
// 否则两个调用会用同一个 since 并发拉到同一条消息 → 重复上屏
let _consumingInbox = false, _inboxRerun = false;
async function _consumePushInbox() {
  if (_consumingInbox) { _inboxRerun = true; return; }
  _consumingInbox = true;
  try {
    const pushMsgs = await new Promise((resolve, reject) => {
      const req = indexedDB.open('XinyePushInbox', 1);
      req.onupgradeneeded = e => e.target.result.createObjectStore('inbox', { autoIncrement: true });
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction('inbox', 'readwrite');
        const store = tx.objectStore('inbox');
        const items = [], keys = [];
        store.openCursor().onsuccess = e => {
          const cursor = e.target.result;
          if (cursor) { items.push(cursor.value); keys.push(cursor.key); cursor.continue(); }
          else {
            keys.forEach(k => store.delete(k));
            tx.oncomplete = () => { db.close(); resolve(items); };
          }
        };
        tx.onerror = reject;
      };
      req.onerror = reject;
    });

    // 同时从云端拉取心跳主动消息
    let cloudMsgs = [];
    try {
      const srv = getCloudOrLocalUrl();
      if (srv) {
        const lastSync = parseInt(localStorage.getItem('heartbeat_lastSyncTime') || '0');
        const r = await fetch(buildServerFetchUrl(srv, `/api/proactive-messages?since=${lastSync}`), {
          headers: buildServerHeaders(srv),
          signal: AbortSignal.timeout(6000)
        });
        if (r.ok) {
          const d = await r.json();
          if (d.ok && Array.isArray(d.messages)) cloudMsgs = d.messages;
        }
      }
    } catch(e) { console.log('[Heartbeat] 拉取主动消息跳过:', e.message); }

    // 已消费过的心跳消息id集合（防 push + 云端重复）
    const consumed = JSON.parse(localStorage.getItem('heartbeat_consumedIds') || '[]');
    const consumedSet = new Set(consumed);

    // 内容兜底去重：SW 的 push 记录可能没有 id，用「内容+10分钟时段」再挡一层
    const _sig = (c, t) => `${c}||${Math.round((t || 0) / 600000)}`;
    const _seen = new Set(messages.slice(-30).filter(m => m.role === 'assistant').map(m => _sig(m.content, m.time)));

    // 合并去重（保留完整消息对象，包含时间戳）
    const allMessages = [];
    for (const m of pushMsgs) {
      const pid = m.proactiveId || m.id;
      if (pid && consumedSet.has(pid)) continue;
      if (pid) consumedSet.add(pid);
      if (_seen.has(_sig(m.content, m.time))) continue;
      _seen.add(_sig(m.content, m.time));
      allMessages.push({ content: m.content, time: m.time });
    }
    for (const m of cloudMsgs) {
      if (m.id && consumedSet.has(m.id)) continue;
      if (m.id) consumedSet.add(m.id);
      if (_seen.has(_sig(m.content, m.time))) continue;
      _seen.add(_sig(m.content, m.time));
      allMessages.push({ content: m.content, time: m.time });
    }

    // 去重状态立刻落盘（不能等消息写完再存，否则并发调用会重复消费同一条）
    if (consumedSet.size !== consumed.length)
      localStorage.setItem('heartbeat_consumedIds', JSON.stringify([...consumedSet].slice(-50)));
    if (cloudMsgs.length) {
      const maxTime = Math.max(...cloudMsgs.map(m => m.time || 0));
      if (maxTime > 0) localStorage.setItem('heartbeat_lastSyncTime', String(maxTime));
    }

    if (!allMessages.length) return;

    // 逐条追加，不用 renderMessages：整屏重绘会清空重建，页面会从顶部弹回底部
    const { addMessage, appendMsgDOM, renderMessages } = await import('./modules/chat.js');
    const _chatEl = document.querySelector('#chatArea');
    const _hasRendered = !!_chatEl?.querySelector('.msg-row');
    for (const msg of allMessages) {
      const _saved = await addMessage('assistant', msg.content, null, msg.time);
      if (_hasRendered && _saved) await appendMsgDOM(_saved);
    }
    if (!_hasRendered) renderMessages();

    // 弹出本地通知（不依赖FCM，只要有Notification权限就行）
    if (Notification.permission === 'granted' && document.visibilityState !== 'visible') {
      const body = allMessages.length === 1 ? allMessages[0].content : `${allMessages.length}条新消息`;
      try {
        const reg = await navigator.serviceWorker.ready;
        reg.showNotification(settings.aiName || '炘也', {
          body: body.slice(0, 120),
          icon: '/xinye-icon.png',
          badge: '/xinye-icon.png',
          tag: 'xinye-heartbeat',
          data: { url: '/' }
        });
      } catch { try { new Notification(settings.aiName || '炘也', { body: body.slice(0, 120), icon: '/xinye-icon.png' }); } catch {} }
    }

    console.log(`[Push] 消费了 ${pushMsgs.length} 条推送 + ${cloudMsgs.length} 条心跳消息（写入 ${allMessages.length} 条）`);
  } catch(e) { console.log('[Push] inbox消费失败:', e.message); }
  finally {
    _consumingInbox = false;
    if (_inboxRerun) { _inboxRerun = false; setTimeout(_consumePushInbox, 500); }
  }
}
window._consumePushInbox = _consumePushInbox;

// ======================== 启动 ========================




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

initRp();

// Friends IIFE 已提取到 src/modules/friends.js
