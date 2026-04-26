import { $, toast, escHtml, isDarkMode, readFileAsBase64 } from './utils.js';
import { settings, saveSettings, ensureMemoryState, messages } from './state.js';
import { dbPut, dbClear } from './db.js';
import { getApiPresets, setApiPresets, getVisionPresets, setVisionPresets, getImagePresets, setImagePresets } from './api.js';
import { digestMemory, renderMemoryBankPreview, archiveMemoryBank } from './memory.js';
import { applyBg, toggleDeco } from './ui.js';
import { getAiAvatar, getUserAvatar, renderMessages, updateBookmarkBadge } from './chat.js';
import { setupReminders, resetIdleTimer } from './notifications.js';
import { saveToLocal, exportData, doImport, doImportPresetsOnly, backupToPhone, autoBackupToServer, initBackupDeps } from './backup.js';
import { renderStickers, renderStickerMgr } from './stickers.js';

// ── DOM refs ──────────────────────────────────────────────────────────────────
const settingsPanel = document.querySelector('#settingsPanel');
const overlay       = document.querySelector('#overlay');
const exportOverlay = document.querySelector('#exportModalOverlay');
const btnSearch     = document.querySelector('#btnSearch');

// ── 本地服务器连通状态 ────────────────────────────────────────────────────────
let _localServerOnline = false;
export function isLocalServerOnline() { return _localServerOnline; }

// ======================== 设置面板 打开/关闭 ========================
export async function openSettings() {
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

export function closeSettings() {
  settingsPanel.classList.remove('show');
  overlay.classList.remove('show');
}

// ======================== 识图预设 ========================
export function renderVisionPresets() {
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

// ======================== 画图预设 ========================
export function renderImagePresets() {
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

// ======================== API 预设 ========================
export function renderApiPresets() {
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

export function checkerActivate(i) {
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

// ======================== TTS 类型切换 UI ========================
export function updateTtsTypeUI() {
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
export function renderTtsPresets() {
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

export async function activateTtsPreset(i) {
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
  updateTtsTypeUI();
  toast(`✅ 已激活音色预设「${p.name}」`);
}

export async function deleteTtsPreset(i) {
  const name = (settings.ttsPresets || [])[i]?.name || '';
  if (!confirm(`确定删除预设「${name}」？`)) return;
  settings.ttsPresets.splice(i, 1);
  await saveSettings();
  renderTtsPresets();
  toast('预设已删除');
}

// ======================== 应用 UI ========================
export async function applyUI(skipRender = false) {
  const aiAv = await getAiAvatar();
  window._xinyeAvatarSrc = aiAv;
  $('#headerAvatar').src = aiAv;
  $('#headerName').textContent = settings.aiName || '炘也';
  $('#typingAvatar').src = aiAv;
  document.title = `${settings.aiName || '炘也'}的小窝`;
  document.documentElement.style.setProperty('--bubble-opacity', settings.bubbleOpacity);
  if (btnSearch) btnSearch.classList.toggle('hidden', !settings.braveKey);
  await applyBg();
  if (!skipRender) {
    await renderMessages();
    renderStickers();
  }
  updateBookmarkBadge();
}

// ======================== 顶栏状态 ========================
export function updateHeaderStatus() {
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

// ======================== 本地服务器连通检测 ========================
export function updateLocalServerDot() {
  const dot = document.getElementById('localServerDot');
  if (!dot) return;
  if (!settings.solitudeServerUrl) { dot.textContent = ''; return; }
  dot.textContent = _localServerOnline ? ' 🟢' : ' ⚪';
  dot.title = _localServerOnline ? 'Tailscale 已连接' : '未连接（离线将跳过同步）';
}

export async function checkLocalServer() {
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

export function notifySwLocalServer(url) {
  try {
    if (navigator.serviceWorker?.controller)
      navigator.serviceWorker.controller.postMessage({ type: 'SET_LOCAL_SERVER', url: url || null });
  } catch {}
}

// ======================== 事件绑定初始化 ========================
export function initSettings() {
  initBackupDeps({ isLocalOnline: () => _localServerOnline, closeSettings });

  $('#btnSettings').onclick = openSettings;
  $('#btnCloseSettings').onclick = closeSettings;
  overlay.onclick = closeSettings;

  // 设置面板 TAB 切换
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
          statusEl.textContent = `✅ ${ms}ms`; statusEl.style.color = '#4caf50';
          if (useBtn) useBtn.style.display = 'block';
        } else {
          statusEl.textContent = `❌ ${res.status}`; statusEl.style.color = '#e57373';
        }
      } catch(e) {
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

  // ======================== 识图预设按钮 ========================
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

  // ======================== 画图预设按钮 ========================
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

  // ======================== API 预设按钮 ========================
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

  // ======================== 保存设置 ========================
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
    await applyUI(true);
    setupReminders();
    resetIdleTimer();
    checkLocalServer();
    closeSettings();
    if (btnSearch) btnSearch.classList.toggle('hidden', !settings.braveKey);
    toast('设置已保存');
  };

  // ======================== TTS 预设按钮 ========================
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
    document.querySelector('#chatArea')?.querySelectorAll('.btn-tts,.btn-tts-dl').forEach(b => b.classList.remove('cached'));
    toast('语音缓存已清除');
  };

  // ======================== 头像上传 ========================
  $('#btnUploadAiAvatar').onclick = () => $('#fileInputAiAvatar').click();
  $('#btnUploadUserAvatar').onclick = () => $('#fileInputUserAvatar').click();
  $('#fileInputAiAvatar').onchange = async function() {
    if (!this.files[0]) return;
    const b64 = await readFileAsBase64(this.files[0]);
    await dbPut('images', 'aiAvatar', b64);
    $('#previewAiAvatar').src = b64;
    saveToLocal();
    toast('AI 头像已更新');
    this.value = '';
  };
  $('#fileInputUserAvatar').onchange = async function() {
    if (!this.files[0]) return;
    const b64 = await readFileAsBase64(this.files[0]);
    await dbPut('images', 'userAvatar', b64);
    $('#previewUserAvatar').src = b64;
    saveToLocal();
    toast('我的头像已更新');
    this.value = '';
  };

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

  // ======================== 备份/导出/导入按钮 ========================
  $('#btnBackupToPhone').onclick = backupToPhone;

  $('#btnExport').onclick = () => exportOverlay.classList.add('show');
  $('#btnExportS').onclick = () => { closeSettings(); exportOverlay.classList.add('show'); };
  $('#btnCloseExport').onclick = () => exportOverlay.classList.remove('show');
  $('#btnExportLite').onclick = () => { exportOverlay.classList.remove('show'); exportData('lite'); };
  $('#btnExportFull').onclick = () => { exportOverlay.classList.remove('show'); exportData('full'); };

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
}

// ======================== 模型列表获取 ========================
export async function fetchModelList(urlInputId, keyInputId, modelInputId, selectId) {
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

// ======================== 识图 API 测试 ========================
export async function testVisionApi() {
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
