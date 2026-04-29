import { toast, fallbackCopy, escHtml, isDarkMode, fmtTime, fmtFull, readFileAsBase64 } from './modules/utils.js';
import { toggleDeco, applyTheme, initTheme, applyBgImage, applyBgVideo, applyBg, initBgHandlers } from './modules/ui.js';
import { resetIdleTimer, setupReminders, isQuietHours, scheduleBackgroundNotifications, cancelBackgroundNotifications, generateDream, proactiveMsg } from './modules/notifications.js';
import { db, openDB, dbPut, dbGet, lsBackup, lsRemoveBackup, dbGetAll, dbGetRecent, dbGetRecentFiltered, dbDelete, dbClear, dbGetAllKeys } from './modules/db.js';
import { settings, saveSettings, ensureMemoryState, ensureMemoryBank, normalizeMemoryEntry, createMemoryId, initSaveHook, messages } from './modules/state.js';
import { stripForTTS, _hasTTSMarkers, generateTTSBlob, markCached, playAudioBlob, playTTS, enqueueTTS, showVoiceBar, downloadTTS } from './modules/tts.js';
import { getApiPresets, setApiPresets, getVisionPresets, setVisionPresets, getImagePresets, setImagePresets, getSubApiCfg, mainApiFetch, subApiFetch } from './modules/api.js';
import { stripThinkingTags, getEmbedding, getMemoryContextBlocks, parseAndSaveSelfMemories, updateMoodState, autoDigestMemory, digestMemory, cleanupMemoryBank, saveOneMemoryToBank, rebuildArchiveIndex, renderMemoryBankPreview, renderMemoryEntryChip, renderMemoryViewer, openMemoryViewer, setMemViewerFilter, toggleMemoryPin, toggleMemoryResolved, deleteMemoryEntry, editMemoryEntry, saveMemoryEdit, skipMemoryCursorToEnd, resetMemoryCursor, manualExtractBatch, rememberLatestExchange, testEmbeddingApi, archiveMemoryBank, autoSyncArchiveToLocal, initMemoryDeps, cosineSimilarity } from './modules/memory.js';
import { toggleBookmark, updateBookmarkBadge, openBookmarksPanel, renderBookmarksPanel, toggleBmExpand, removeBookmark, getAiAvatar, getUserAvatar, activeStore, addMessage, updateMessage, renderMessages, appendMsgDOM, scrollBottom, deleteMessage, renderMdHtml, linkifyEl, saveTokenLog, renderTokenLog, sendMessage } from './modules/chat.js';
import { getDecoStickers, setDecoStickers, renderStickers, getChatStickers, saveChatStickers, loadChatStickers, renderStickerMgr, initStickers } from './modules/stickers.js';
import { switchTab, openDiaryGen, initDiary, quickNoteOpen, quickNoteClose, quickNoteSave } from './modules/diary.js';
import { saveToLocal, loadFromLocal, autoBackupToServer } from './modules/backup.js';
import { openSettings, closeSettings, renderApiPresets, renderVisionPresets, renderImagePresets, renderTtsPresets, updateTtsTypeUI, activateTtsPreset, deleteTtsPreset, checkerActivate, applyUI, updateHeaderStatus, checkLocalServer, notifySwLocalServer, updateLocalServerDot, isLocalServerOnline, initSettings, fetchModelList, testVisionApi } from './modules/settings.js';
import { triggerDrawImage, initImageUpload, compositeRefImages, base64ToFile, autoSaveGenImage } from './modules/image.js';
import { initRp } from './modules/rp.js';
// ── 立即暴露inline handler函数到window（函数声明已提升，放这里保证任何后续错误都不影响）──
Object.assign(window, {
  switchTab, openBookmarksPanel,
  openMemoryViewer, renderMemoryViewer, renderMemoryBankPreview,
  setMemViewerFilter, resetMemoryCursor, skipMemoryCursorToEnd,
  rebuildArchiveIndex, manualExtractBatch,
  toggleMemoryPin, toggleMemoryResolved, deleteMemoryEntry, editMemoryEntry, saveMemoryEdit,
  quickNoteOpen, quickNoteClose, quickNoteSave,
  removeBookmark, toggleBmExpand,
  fetchModelList, testEmbeddingApi, testVisionApi, describeImagesWithVision,
  updateTtsTypeUI, triggerDrawImage, sendKiss, compositeRefImages, base64ToFile, autoSaveGenImage,
  checkerActivate,
  maybeTTS, autoResize, resetIdleTimer, updateSendBtn,
  scheduleAutoSave, updateHeaderStatus, sendMessage,
});

if('serviceWorker' in navigator){
  window.addEventListener('load',()=>{
    navigator.serviceWorker.register('/sw.js').catch(()=>{});
    // 新SW激活时自动刷新页面，让新版本生效
    navigator.serviceWorker.addEventListener('message', e => {
      if (e.data && e.data.type === 'SW_UPDATED') {
        // 有请求进行中时等待结束再reload，避免中断画图/聊天被重复扣费
        if (window.isRequesting) {
          const _waitReload = setInterval(() => {
            if (!window.isRequesting) { clearInterval(_waitReload); window.location.reload(); }
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
  ensureMemoryState();
  // 从 IDB 恢复被华为"清缓存"清掉的 localStorage 数据
  const _lsBackupKeys = ['xinye_api_presets','xinye_vision_presets','xinye_image_presets','rp_prompt','rp_presets','rp_char_name','rp_char_avatar','rp_active','rp_user_name','rp_user_avatar'];
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
            { type: 'text', text: '请详细描述这张图片的内容，包括人物、物体、场景、颜色、动作等关键信息。用中文回答，不超过200字。' }
          ]}],
          max_tokens: 500,
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
  if (_verEl) _verEl.textContent = 'v2026.04.26-friends';

  await openDB();
  await migrateFromLocalStorage();
  await loadAll();
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
  if (!isMobile) userInput.focus(); // 移动端不自动弹键盘
  saveToLocal(); // 启动时同步 localStorage，后台进行，不阻塞
})();

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
