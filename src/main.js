import { toast, fallbackCopy, escHtml, isDarkMode, fmtTime, fmtFull, readFileAsBase64 } from './modules/utils.js';
import { toggleDeco, applyTheme, initTheme, applyBgImage, applyBgVideo, applyBg, initBgHandlers } from './modules/ui.js';
import { resetIdleTimer, setupReminders, isQuietHours, scheduleBackgroundNotifications, cancelBackgroundNotifications, generateDream, proactiveMsg } from './modules/notifications.js';
import { db, openDB, dbPut, dbGet, lsBackup, lsRemoveBackup, dbGetAll, dbGetRecent, dbGetRecentFiltered, dbDelete, dbClear, dbGetAllKeys } from './modules/db.js';
import { settings, saveSettings, ensureMemoryState, ensureMemoryBank, normalizeMemoryEntry, createMemoryId, initSaveHook, messages } from './modules/state.js';
import { stripForTTS, _hasTTSMarkers, generateTTSBlob, markCached, playAudioBlob, playTTS, enqueueTTS, showVoiceBar, downloadTTS } from './modules/tts.js';
import { getApiPresets, setApiPresets, getVisionPresets, setVisionPresets, getImagePresets, setImagePresets, getSubApiCfg, mainApiFetch, subApiFetch } from './modules/api.js';
import { stripThinkingTags, getEmbedding, getMemoryContextBlocks, parseAndSaveSelfMemories, updateMoodState, autoDigestMemory, digestMemory, cleanupMemoryBank, saveOneMemoryToBank, rebuildArchiveIndex, renderMemoryBankPreview, renderMemoryEntryChip, renderMemoryViewer, openMemoryViewer, setMemViewerFilter, toggleMemoryPin, toggleMemoryResolved, deleteMemoryEntry, editMemoryEntry, saveMemoryEdit, skipMemoryCursorToEnd, resetMemoryCursor, manualExtractBatch, rememberLatestExchange, testEmbeddingApi, archiveMemoryBank, autoSyncArchiveToLocal, initMemoryDeps, cosineSimilarity } from './modules/memory.js';
import { toggleBookmark, updateBookmarkBadge, openBookmarksPanel, renderBookmarksPanel, toggleBmExpand, removeBookmark, getAiAvatar, getUserAvatar, activeStore, addMessage, updateMessage, renderMessages, appendMsgDOM, scrollBottom, deleteMessage, renderMdHtml, linkifyEl, saveTokenLog, renderTokenLog, sendMessage } from './modules/chat.js';
import { getDecoStickers, setDecoStickers, renderStickers, getChatStickers, saveChatStickers, renderStickerMgr, initStickers } from './modules/stickers.js';
import { switchTab, openDiaryGen, initDiary } from './modules/diary.js';
import { saveToLocal, loadFromLocal, autoBackupToServer } from './modules/backup.js';
import { openSettings, closeSettings, renderApiPresets, renderVisionPresets, renderImagePresets, renderTtsPresets, updateTtsTypeUI, activateTtsPreset, deleteTtsPreset, checkerActivate, applyUI, updateHeaderStatus, checkLocalServer, notifySwLocalServer, updateLocalServerDot, isLocalServerOnline, initSettings } from './modules/settings.js';
// ── 立即暴露inline handler函数到window（函数声明已提升，放这里保证任何后续错误都不影响）──
Object.assign(window, {
  switchTab, openBookmarksPanel,
  openMemoryViewer, renderMemoryViewer, renderMemoryBankPreview,
  setMemViewerFilter, resetMemoryCursor, skipMemoryCursorToEnd,
  rebuildArchiveIndex, manualExtractBatch,
  toggleMemoryPin, toggleMemoryResolved, deleteMemoryEntry, editMemoryEntry, saveMemoryEdit,
  quickNoteOpen, quickNoteClose, quickNoteSave,
  removeBookmark, toggleBmExpand,
  fetchModelList, testEmbeddingApi, testVisionApi,
  updateTtsTypeUI, triggerDrawImage, sendKiss,
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
  setDecoStickers(await dbGetAll('stickers'));
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
