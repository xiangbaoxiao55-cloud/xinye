import { toast, fallbackCopy, escHtml, isDarkMode, fmtTime, fmtFull, nowStr } from './modules/utils.js';
import { db, openDB, dbPut, dbGet, lsBackup, lsRemoveBackup, dbGetAll, dbGetRecent, dbGetRecentFiltered, dbDelete, dbClear, dbGetAllKeys } from './modules/db.js';
import { settings, saveSettings, ensureMemoryState, ensureMemoryBank, normalizeMemoryEntry, createMemoryId, initSaveHook, messages } from './modules/state.js';
import { stripForTTS, _hasTTSMarkers, generateTTSBlob, markCached, playAudioBlob, playTTS, enqueueTTS, showVoiceBar, downloadTTS } from './modules/tts.js';
import { getApiPresets, setApiPresets, getSubApiCfg, mainApiFetch, subApiFetch } from './modules/api.js';
import { stripThinkingTags, getEmbedding, getMemoryContextBlocks, parseAndSaveSelfMemories, updateMoodState, autoDigestMemory, digestMemory, cleanupMemoryBank, saveOneMemoryToBank, rebuildArchiveIndex, renderMemoryBankPreview, renderMemoryEntryChip, renderMemoryViewer, openMemoryViewer, setMemViewerFilter, toggleMemoryPin, toggleMemoryResolved, deleteMemoryEntry, editMemoryEntry, saveMemoryEdit, skipMemoryCursorToEnd, resetMemoryCursor, manualExtractBatch, rememberLatestExchange, testEmbeddingApi, archiveMemoryBank, autoSyncArchiveToLocal, initMemoryDeps, cosineSimilarity } from './modules/memory.js';
import { toggleBookmark, updateBookmarkBadge, openBookmarksPanel, renderBookmarksPanel, toggleBmExpand, removeBookmark, getAiAvatar, getUserAvatar, activeStore, addMessage, updateMessage, renderMessages, appendMsgDOM, scrollBottom, deleteMessage, renderMdHtml, linkifyEl, saveTokenLog, renderTokenLog, sendMessage } from './modules/chat.js';
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
  maybeTTS, getStickerHint, autoResize, resetIdleTimer, updateSendBtn,
  scheduleAutoSave, applyStickerTags, updateHeaderStatus, sendMessage,
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
  if (window.isRequesting || !settings.apiKey) return;
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

  window.isRequesting = true; btnSend.disabled = true; typing.classList.add('show');
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
  finally { typing.classList.remove('show'); window.isRequesting = false; btnSend.disabled = false; }
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
window.isRequesting = false;

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
  if (window.isRequesting) return;

  const refImgs = [...window.pendingImages];
  userInput.value = '';
  autoResize();
  window.pendingImages = [];
  $('#imgPreview').classList.remove('show');
  resetIdleTimer();

  const userMsg = await addMessage('user', userDesc, refImgs.length ? refImgs : null);
  await appendMsgDOM(userMsg);

  window.isRequesting = true;
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
    window.isRequesting = false;
    btnSend.disabled = userInput.value.trim() === '';
  }
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
window.pendingImages = [];

function renderImgPreviews() {
  const preview = $('#imgPreview');
  preview.innerHTML = '';
  if (!window.pendingImages.length) { preview.classList.remove('show'); return; }
  window.pendingImages.forEach((src, i) => {
    const wrap = document.createElement('div'); wrap.className = 'img-thumb-wrap';
    const img = document.createElement('img'); img.src = src; img.className = 'img-thumb';
    const btn = document.createElement('button'); btn.className = 'img-remove'; btn.textContent = '✕';
    btn.onclick = () => { window.pendingImages.splice(i, 1); renderImgPreviews(); };
    wrap.appendChild(img); wrap.appendChild(btn); preview.appendChild(wrap);
  });
  preview.classList.add('show');
}

$('#btnImg').onclick = () => $('#fileInputChatImg').click();
$('#fileInputChatImg').onchange = async function() {
  if (!this.files.length) return;
  for (const file of this.files) { window.pendingImages.push(await compressImageToBase64(file)); }
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
