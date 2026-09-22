import { toast, fallbackCopy, escHtml, isDarkMode, fmtTime, fmtFull, readFileAsBase64 } from './modules/utils.js';
import { toggleDeco, applyTheme, initTheme, applyBgImage, applyBgVideo, applyBg, initBgHandlers } from './modules/ui.js';
import { resetIdleTimer, setupReminders, isQuietHours, scheduleBackgroundNotifications, cancelBackgroundNotifications, generateDream, proactiveMsg } from './modules/notifications.js';
import { db, openDB, dbPut, dbGet, lsBackup, lsRemoveBackup, dbGetAll, dbGetRecent, dbGetRecentFiltered, dbDelete, dbClear, dbGetAllKeys } from './modules/db.js';
import { settings, saveSettings, ensureMemoryState, ensureMemoryBank, normalizeMemoryEntry, createMemoryId, initSaveHook, messages, mergeVectors, markVectorsDirty } from './modules/state.js';
import { stripForTTS, _hasTTSMarkers, generateTTSBlob, markCached, playAudioBlob, playTTS, enqueueTTS, showVoiceBar, downloadTTS, exportTTSCache } from './modules/tts.js';
import { getApiPresets, setApiPresets, getVisionPresets, setVisionPresets, getImagePresets, setImagePresets, getSubApiCfg, mainApiFetch, subApiFetch } from './modules/api.js';
import { stripThinkingTags, getEmbedding, getMemoryContextBlocks, parseAndSaveSelfMemories, updateMoodState, autoDigestMemory, digestMemory, cleanupMemoryBank, saveOneMemoryToBank, rebuildArchiveIndex, renderMemoryBankPreview, renderMemoryEntryChip, renderMemoryViewer, openMemoryViewer, setMemViewerFilter, toggleMemoryPin, toggleMemoryResolved, deleteMemoryEntry, editMemoryEntry, saveMemoryEdit, skipMemoryCursorToEnd, resetMemoryCursor, manualExtractBatch, rememberLatestExchange, testEmbeddingApi, archiveMemoryBank, autoSyncArchiveToLocal, initMemoryDeps, cosineSimilarity, dedupMemoryBank, detectMemoryConflicts } from './modules/memory.js';
import { toggleBookmark, updateBookmarkBadge, openBookmarksPanel, renderBookmarksPanel, toggleBmExpand, removeBookmark, getAiAvatar, getUserAvatar, activeStore, addMessage, updateMessage, renderMessages, appendMsgDOM, scrollBottom, deleteMessage, renderMdHtml, linkifyEl, saveTokenLog, renderTokenLog, sendMessage } from './modules/chat.js';
import { getDecoStickers, setDecoStickers, renderStickers, getChatStickers, saveChatStickers, loadChatStickers, renderStickerMgr, initStickers } from './modules/stickers.js';
import { initStickerLib } from './modules/stickerlib.js';
import { switchTab, openDiaryGen, initDiary, quickNoteOpen, quickNoteClose, quickNoteSave, autoWriteXinyeDiary } from './modules/diary.js';
import { saveToLocal, loadFromLocal, autoBackupToServer } from './modules/backup.js';
import { openSettings, closeSettings, renderApiPresets, renderVisionPresets, renderImagePresets, renderTtsPresets, updateTtsTypeUI, activateTtsPreset, deleteTtsPreset, checkerActivate, applyUI, updateHeaderStatus, checkLocalServer, notifySwLocalServer, updateLocalServerDot, isLocalServerOnline, initSettings, fetchModelList, testVisionApi, getCloudOrLocalUrl, buildServerFetchUrl, buildServerHeaders } from './modules/settings.js';
import { triggerDrawImage, initImageUpload, compositeRefImages, base64ToFile, autoSaveGenImage, generateImage } from './modules/image.js';
import { checkMorningWalk, startReminderPoller } from './modules/walk.js';
import { checkGift } from './modules/gift.js';
import { _startEarlyInboxFetch, _consumePushInbox, _consumeOverlayReply, _pullPosts, _registerPush, _registerPeriodicSync, _reportOverlayErr } from './modules/inbox.js';
import { initRp } from './modules/rp.js';
import { openChatSearch, closeChatSearch, runChatSearch, setChatSearchWho, toggleCsCtx } from './modules/chatsearch.js';
import { initInputDraft } from './modules/draft.js';
// ── 立即暴露inline handler函数到window（函数声明已提升，放这里保证任何后续错误都不影响）──
Object.assign(window, {
  switchTab, openBookmarksPanel,
  openChatSearch, closeChatSearch, runChatSearch, setChatSearchWho, toggleCsCtx,
  openMemoryViewer, renderMemoryViewer, renderMemoryBankPreview,
  setMemViewerFilter, resetMemoryCursor, skipMemoryCursorToEnd,
  rebuildArchiveIndex, manualExtractBatch, dedupMemoryBank, detectMemoryConflicts,
  toggleMemoryPin, toggleMemoryResolved, deleteMemoryEntry, editMemoryEntry, saveMemoryEdit,
  quickNoteOpen, quickNoteClose, quickNoteSave,
  removeBookmark, toggleBmExpand,
  fetchModelList, testEmbeddingApi, testVisionApi, describeImagesWithVision,
  updateTtsTypeUI, triggerDrawImage, generateImage, sendKiss, compositeRefImages, base64ToFile, autoSaveGenImage,
  checkerActivate,
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

// ======================== 内存监控（诊断用，2026-09-15） ========================
// 兔宝手机上"用一会儿就卡、最后闪退"，得看到 JS 堆的走势才能分清是「泄漏」（一直涨）
// 还是「峰值」（某个操作一下顶上去）。60 秒一条，不刷屏。
if (performance.memory) {
  console.log('[内存] 监控启动，堆', Math.round(performance.memory.usedJSHeapSize / 1048576) + 'MB',
    '| 上限', Math.round(performance.memory.jsHeapSizeLimit / 1048576) + 'MB');
  setInterval(() => {
    const m = performance.memory;
    // ⚠️ 她那边 used 一直显示 10MB 纹丝不动（开了 1 分半预览也不动），八成是这个数字本身
    //    在 WebView 里不准 —— 把 total 一起打出来对照，两个都不动才是真的不动
    console.log('[内存]', Math.round(m.usedJSHeapSize / 1048576) + '/' + Math.round(m.totalJSHeapSize / 1048576) + 'MB',
      '| 聊天区 DOM', document.querySelectorAll('#chatArea *').length, '个元素');
  }, 60000);
}

// ======================== vConsole 日志持久化 ========================
// 页面被系统回收重载后，自动恢复之前的日志到 vConsole
{
  const _VC_KEY = 'vconsole_logs';
  const _VC_MAX = 200;
  const _origLog = console.log, _origWarn = console.warn, _origError = console.error;
  let _vcBuf = null;      // 日志先攒在内存里
  let _vcTimer = 0;

  const _vcFlush = () => {
    _vcTimer = 0;
    if (!_vcBuf) return;
    try { localStorage.setItem(_VC_KEY, JSON.stringify(_vcBuf)); } catch {}
  };
  // 切后台 / 关页面时立刻落盘，别等那一秒的定时器
  window.addEventListener('pagehide', _vcFlush);
  document.addEventListener('visibilitychange', () => { if (document.hidden) _vcFlush(); });

  function _vcSave(level, args) {
    try {
      if (!_vcBuf) {
        // ⚠️ 2026-09-15 从 sessionStorage 搬到 localStorage：她那边「点开设置卡死闪退」，
        //    重开之后 vConsole 里只剩启动日志 —— sessionStorage 在进程被杀时留不住，
        //    崩溃前那段最要紧的证据每次都没了。localStorage 能留住。
        try { _vcBuf = JSON.parse(localStorage.getItem(_VC_KEY) || '[]'); } catch { _vcBuf = []; }
        _vcBuf.push({ l: 'log', t: '—— 启动 ' + new Date().toLocaleString() + ' ——', ts: Date.now() });
      }
      const text = Array.from(args).map(a => {
        if (typeof a === 'string') return a.length > 300 ? a.slice(0, 300) + '…' : a;
        try { const s = JSON.stringify(a); return s && s.length > 300 ? s.slice(0, 300) + '…' : s; }
        catch { return String(a); }
      }).join(' ');
      _vcBuf.push({ l: level, t: text, ts: Date.now() });
      if (_vcBuf.length > _VC_MAX) _vcBuf.splice(0, _vcBuf.length - _VC_MAX);
      // ⚠️ 不能每条日志都写 sessionStorage：这个函数 hook 了 console.log/warn/error，
      //    而 sessionStorage 是**同步**的——每打一条就要 JSON.parse + stringify +
      //    重写整个 200 条数组。TTS 队列 / 心跳轮询一密集打日志，主线程就被吃满，
      //    表现就是「用一会儿就一动一卡」。攒着、每秒最多落盘一次即可。
      // ⚠️ 这几类日志**立刻落盘**，不等那一秒的定时器：
      //    error 前后通常就是崩溃现场；[设置面板]/[内存]/[自动备份]/[覆盖层预览] 是她崩的时候
      //    我们最想看的那几行（尤其「开始」有、「出来了」没有 —— 那一对就是铁证）。
      //    频率都很低（打开面板两条、内存一分钟一条），立即落盘不构成负担。
      if (level === 'error' || /^\[(设置面板|内存|自动备份|覆盖层预览)\]/.test(text)) { _vcFlush(); return; }
      if (!_vcTimer) _vcTimer = setTimeout(_vcFlush, 1000);
    } catch {}
  }

  console.log = function(...a) { _vcSave('log', a); return _origLog.apply(console, a); };
  console.warn = function(...a) { _vcSave('warn', a); return _origWarn.apply(console, a); };
  console.error = function(...a) { _vcSave('error', a); return _origError.apply(console, a); };

  // 页面加载时恢复之前的日志
  try {
    // ⚠️ 必须跟写入用同一个地方 —— 上一版只把「写」改成了 localStorage，这儿还读
    //    sessionStorage（空的），等于上一轮崩溃前的日志一条都没恢复出来，白存了。
    const prev = JSON.parse(localStorage.getItem(_VC_KEY) || '[]');
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
  if (s) {
    // 记忆向量是拆开单独存的（settings 实测 28MB 几乎全是它），读回来先贴回 memoryBank
    const _vec = await dbGet('settings', 'vectors').catch(() => null);
    if (_vec) mergeVectors(s.memoryBank, _vec);
    Object.assign(settings, s);
    ensureMemoryState();
    // 旧格式：向量还在 settings 本体里、vectors key 是空的 → 标记一次，
    // 让下一次保存把它们迁到新位置（不迁的话以后就只有 settings 里那份，白占 28MB）
    if (!_vec && ['pinned', 'recent', 'archived'].some(l =>
      (settings.memoryBank?.[l] || []).some(m => m && m.embedding))) {
      markVectorsDirty();
      console.log('[loadAll] 检测到向量还在 settings 本体里，下次保存会迁到 settings/vectors');
    }
  }
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
    clearTimeout(window._autoBackupTimer);   // 理由同上（见下面 Capacitor 那段）
    window._autoBackupTimer = 0;
  } else {
    cancelBackgroundNotifications();
    clearTimeout(window._autoBackupTimer);
    window._autoBackupTimer = setTimeout(() => { autoBackupToServer(); }, 25000);
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
        // ⚠️ 别在「切后台」这一刻备份（2026-09-15 改）：那正是系统开始回收内存的时候，
        //    而备份要 stringify 十几兆再 POST 上去。她的备份文件列表跟她崩溃的时间点
        //    几乎是一条线（16:31 传完、16:31 崩，17:21 传完、17:22 崩）—— 就是这一下顶的。
        //    取消待跑的那次，等回到前台再说。
        clearTimeout(window._autoBackupTimer);
        window._autoBackupTimer = 0;
      } else {
        cancelBackgroundNotifications();
        // 回到前台、等内存稳下来（25 秒）再备份；backup.js 里还有 20 分钟节流兜着
        clearTimeout(window._autoBackupTimer);
        window._autoBackupTimer = setTimeout(() => { autoBackupToServer(); }, 25000);
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

btnSend.onclick = sendMessage;
// 发送按钮：空时变灰
function updateSendBtn() {
  btnSend.disabled = window.isRequesting || userInput.value.trim() === '';
}
userInput.addEventListener('input', updateSendBtn);
updateSendBtn();

// 输入区工具行（随手记/贴纸/传图/画图）默认收起，点输入框里的 ⊕ 才展开；点了任一工具后自动收起
{
  const _ia = document.getElementById('inputArea');
  const _tt = document.getElementById('btnToolsToggle');
  const _tr = document.querySelector('.input-tools-row');
  if (_ia && _tt) {
    _tt.addEventListener('click', () => _ia.classList.toggle('tools-open'));
    _tr?.addEventListener('click', e => { if (e.target.closest('button')) _ia.classList.remove('tools-open'); });
  }
}

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

// 输入框草稿：刷新 / 被系统回收 / 手滑关掉 APP，打了一半的字都还在。
// ⚠️ 恢复是程序性赋 value，不触发 input 事件，所以要手动补一次 autoResize（它顺带点亮发送键）。
initInputDraft(userInput);
autoResize();

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
  if (_verEl) _verEl.textContent = 'v2026.09.22-2353';

  await openDB();
  await migrateFromLocalStorage();
  await loadAll();
  // 设置已就绪，马上把主动消息的请求发出去，跟下面这段初始化并行跑
  _startEarlyInboxFetch();
  window.chatLastUserImage = (await dbGet('images', 'chatLastUserImage').catch(() => null)) || null;
  initStickers();
  initStickerLib();
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
      // ⚠️ 上面那次早拉是在这之前发起的，那时 settings 里还没有云服务器地址
      //（IDB 是空的，配置是从 localStorage 恢复的）→ 作废重发一次
      _earlyInboxFetch = null;
      _startEarlyInboxFetch();
    }
  }

  // 主动消息要在首屏就看得见：先把它写进消息列表，再渲染。
  // 以前是渲染完才去拉，所以"点通知进来"会先看到聊天记录、过一会儿才补一条进来
  const _inboxDone = _consumePushInbox({ silent: true });
  const _inboxInTime = await Promise.race([
    _inboxDone.then(() => true),
    new Promise(r => setTimeout(() => r(false), 1500))
  ]);
  await applyUI(false); // 始终渲染消息（数据已在 loadAll 后就绪）
  // 没赶上的（云服务器慢/不可达）等它落地再补上屏，别让那条消息只进了库不露脸
  if (!_inboxInTime) _inboxDone.then(rows => { (rows || []).forEach(r => appendMsgDOM(r)); }).catch(() => {});
  if (typeof window.syncRpHeader === 'function') window.syncRpHeader(); // RP顶栏覆盖updateHeaderStatus
  const _splash = document.getElementById('splashLoading');
  if (_splash) {
    // 淡出而不是硬切；期间设 pointer-events:none，别让透明遮罩继续吃点击
    _splash.style.pointerEvents = 'none';
    _splash.style.transition = 'opacity .45s ease';
    _splash.style.opacity = '0';
    setTimeout(() => { _splash.style.display = 'none'; }, 470);
  }
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
  _consumeOverlayReply(); // 覆盖层里她回的话，回到聊天页就把它接进来
  _reportOverlayErr();    // 覆盖层上次生成失败的原因，翻出来打进 vConsole

  if (!isMobile) userInput.focus(); // 移动端不自动弹键盘
  // 主动消息已经在上面（首屏渲染前）拉过一轮了，这里不再重复请求：
  // 万一那次被防重入挡掉了，_inboxRerun 会自己补跑一次
  saveToLocal(); // 启动时同步 localStorage，后台进行，不阻塞
  _registerPush();

  // 页面从后台恢复时自动拉取心跳消息
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') { _consumePushInbox(); _consumeOverlayReply(); autoWriteXinyeDiary(); _pullPosts(); }
  });

  // 前台定时轮询心跳消息（30秒），鸿蒙无FCM靠轮询兜底
  setInterval(() => {
    if (document.visibilityState === 'visible') { _consumePushInbox(); autoWriteXinyeDiary(); _pullPosts(); }
  }, 30_000);

  // 碎碎念：启动时拉一轮（不跟上面那条挤在一起 —— 补配图可能要好几分钟）
  setTimeout(() => _pullPosts(), 2500);

  // 每晚那篇「炘也的日记」：过点了就补，写过了就跳过（判据在模块里，很便宜）
  setTimeout(() => autoWriteXinyeDiary(), 5000);

  // 上次没画完的图，接着画完（2026-09-18）—— 排在最后：首屏、消息、碎碎念都发出去之后。
  // 账本平时是空的，这一下只是读一次 localStorage；真有活也是丢到后台画，不挡启动。
  setTimeout(() => _resumePendingDraws(), 6000);

  // 注册 Periodic Background Sync（让SW在后台也能定期拉消息）
  _registerPeriodicSync();
})();


/**
 * 续账：把上次没画完的图接着画完（账本见 src/modules/pendingdraw.js）。
 *
 * 为什么要这一手：画图是「在内存里跑、最后一步才落库」，一张要画十几秒到一分钟，
 * 这段里刷新 / 闪退 / 被系统杀后台，图就白丢了 —— 钱花了、气泡都没有。
 * 2026-09-18 兔宝就是这么丢了一张主动消息配图（09:25:24 拿到链接，09:25:29 刷新）。
 *
 * ⚠️ 只有**被硬中断**的活才会留在账上（她自己看见的那种失败当场销账），
 *    所以绝大多数时候这里读一次 localStorage 就返回了。
 * ⚠️ 用动态 import：posts.js / inbox.js 不在启动的静态依赖链上，别为这个把启动拉长。
 */
async function _resumePendingDraws() {
  try {
    const { pendFreshJobs } = await import('./modules/pendingdraw.js');
    const jobs = pendFreshJobs();
    if (!jobs.length) return;
    console.log(`[画图续账] 有 ${jobs.length} 张上次没画完的图，接着来`);
    for (const job of jobs) {
      try {
        if (job.kind === 'post') (await import('./modules/posts.js')).resumePostImage(job);
        else if (job.kind === 'proactive') (await import('./modules/inbox.js'))._resumeProactiveImage(job);
        else (await import('./modules/image.js')).resumeChatDraw(job);
      } catch (e) {
        // 接不上就算了 —— 账上的活有 2 小时保质期，过期自己会清
        console.log('[画图续账] 这一张接不上了:', e && e.message);
      }
    }
  } catch (e) { console.log('[画图续账] 跳过:', e && e.message); }
}


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
