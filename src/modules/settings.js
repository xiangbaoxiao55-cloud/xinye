import { $, toast, escHtml, isDarkMode, readFileAsBase64 } from './utils.js';
import { settings, saveSettings, ensureMemoryState, messages } from './state.js';
import { dbPut, dbGet, dbClear } from './db.js';
import { getApiPresets, setApiPresets, getVisionPresets, setVisionPresets, getImagePresets, setImagePresets, getImageCurPresetIdx, setImageCurPresetIdx } from './api.js';
import { digestMemory, renderMemoryBankPreview, archiveMemoryBank, autoSyncArchiveToLocal } from './memory.js';
import { applyBg, toggleDeco } from './ui.js';
import { getAiAvatar, getUserAvatar, renderMessages, updateBookmarkBadge, resetStickyPreset } from './chat.js';
import { setupReminders, resetIdleTimer } from './notifications.js';
import { saveToLocal, exportData, doImport, doImportPresetsOnly, backupToPhone, autoBackupToServer, initBackupDeps, fetchServerBackupList, restoreFromServer } from './backup.js';
import { renderStickers, renderStickerMgr } from './stickers.js';

// ── 画图尺寸映射 ──────────────────────────────────────────────────────────────
const _IMAGE_SIZE_MAP = {
  '1K': [
    { value: '1024x1024', label: '1024×1024（1:1 方形）' },
    { value: '1024x768',  label: '1024×768（4:3 横版）'  },
    { value: '768x1024',  label: '768×1024（3:4 竖版）'  },
    { value: '1536x1024', label: '1536×1024（3:2 横版）' },
    { value: '1024x1536', label: '1024×1536（2:3 竖版）' },
  ],
  '2K': [
    { value: '2048x2048', label: '2048×2048（1:1 方形）'  },
    { value: '2048x1536', label: '2048×1536（4:3 横版）'  },
    { value: '1536x2048', label: '1536×2048（3:4 竖版）'  },
    { value: '2048x1152', label: '2048×1152（16:9 横版）' },
    { value: '1152x2048', label: '1152×2048（9:16 竖版）' },
  ],
  '4K': [
    { value: '4096x3072', label: '4096×3072（4:3 横版）'  },
    { value: '3072x4096', label: '3072×4096（3:4 竖版）'  },
    { value: '3840x2160', label: '3840×2160（16:9 横版）' },
    { value: '2160x3840', label: '2160×3840（9:16 竖版）' },
  ],
};

window._updateImageRatioOpts = function(res, currentValue) {
  const sel = document.getElementById('setImageRatio');
  if (!sel) return;
  const opts = _IMAGE_SIZE_MAP[res] || _IMAGE_SIZE_MAP['1K'];
  sel.innerHTML = opts.map(o =>
    `<option value="${o.value}"${o.value === currentValue ? ' selected' : ''}>${o.label}</option>`
  ).join('');
};

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
  if ($('#apiPresetUseProxy')) $('#apiPresetUseProxy').checked = !!settings.useLocalProxy;
  if ($('#apiPresetApiFormat')) $('#apiPresetApiFormat').value = settings.apiFormat || 'openai';
  $('#setBraveKey').value = settings.braveKey || '';
  const _mwEl = $('#setMorningWalkEnabled');
  if (_mwEl) _mwEl.checked = !!settings.morningWalkEnabled;
  const _mcdEl = $('#setMemoryAutoConflictDetect');
  if (_mcdEl) _mcdEl.checked = !!settings.memoryAutoConflictDetect;
  $('#setSearchDays').value = settings.searchDays || 3;
  $('#setSearchCount').value = settings.searchCount || 5;
  if ($('#setWereadApiKey')) $('#setWereadApiKey').value = settings.wereadApiKey || '';
  const _ssEl = $('#setSolitudeServerUrl');
  if (_ssEl) _ssEl.value = settings.solitudeServerUrl || '';
  const _ipEl = $('#setImageProxyUrl');
  if (_ipEl) _ipEl.value = settings.imageProxyUrl || '';
  const _itEl = $('#setImageProxyToken');
  if (_itEl) _itEl.value = settings.imageProxyToken || '';
  renderImageProxyPresets();
  renderServerUrlPresets();
  const _bkHint = $('#lastBackupHint');
  if (_bkHint) { const t = localStorage.getItem('lastAutoBackupTime'); _bkHint.textContent = t ? `上次自动备份：${t}` : '（还没有自动备份记录）'; }
  $('#setBaseUrl').value = settings.baseUrl;
  renderApiPresets();
  const _allPresets = getApiPresets();
  const _matchIdx = _allPresets.findIndex(p => p.apiKey === settings.apiKey && p.baseUrl === settings.baseUrl && p.model === settings.model);
  if (_matchIdx >= 0) {
    $('#apiPresetName').value = _allPresets[_matchIdx].name;
    $('#presetSelect').value = _matchIdx;
  } else {
    $('#apiPresetName').value = '';
  }
  renderVisionPresets();
  renderImagePresets();
  // 兼容旧的单备用字段
  if (!settings.fallbackPresetNames?.length && settings.fallbackPresetName) settings.fallbackPresetNames = [settings.fallbackPresetName];
  if (!settings.subFallbackPresetNames?.length && settings.subFallbackPresetName) settings.subFallbackPresetNames = [settings.subFallbackPresetName];
  [0,1,2,3,4,5,6,7,8,9].forEach(i => {
    const el = $(`#setFallbackPreset${i}`); if (el) el.value = (settings.fallbackPresetNames||[])[i] || '';
  });
  [0,1,2,3,4].forEach(i => {
    const sub = $(`#setSubFallbackPreset${i}`); if (sub) sub.value = (settings.subFallbackPresetNames||[])[i] || '';
  });
  const _dp = $('#setDigestPreset'); if (_dp) _dp.value = settings.digestPresetName || '';
  [0,1,2].forEach(i => { const el = $(`#setDigestFallback${i}`); if (el) el.value = (settings.digestFallbackPresetNames||[])[i] || ''; });
  $('#setModel').value = settings.model;
  const _mtEl = $('#setMaxTokens'); if (_mtEl) _mtEl.value = settings.maxTokens || '';
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
  $('#setImageApiFormat').value = settings.imageApiFormat || 'images';
  const _imgSize = settings.imageSize || '1024x1024';
  let _imgRes = '1K';
  for (const [res, opts] of Object.entries(_IMAGE_SIZE_MAP)) {
    if (opts.some(o => o.value === _imgSize)) { _imgRes = res; break; }
  }
  $('#setImageRes').value = _imgRes;
  window._updateImageRatioOpts(_imgRes, _imgSize);
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
  $('#setMimoKey').value = settings.mimoKey || '';
  $('#setMimoStylePrompt').value = settings.mimoStylePrompt || '';
  _updateMimoRefStatus();
  $('#setMinimaxKey').value = settings.minimaxKey || '';
  $('#setMinimaxGroupId').value = settings.minimaxGroupId || '';
  $('#setMinimaxVoiceId').value = settings.minimaxVoiceId || '';
  $('#setMinimaxModel').value = settings.minimaxModel || '';
  $('#setMinimaxProxy').value = settings.minimaxProxy || '';
  $('#setMinimaxTimbreWeights').value = settings.minimaxTimbreWeights || '';
  $('#setMinimaxSpeed').value = settings.minimaxSpeed ?? '';
  $('#setMinimaxVol').value = settings.minimaxVol ?? '';
  $('#setMinimaxModifyPitch').value = settings.minimaxModifyPitch ?? '';
  $('#setMinimaxModifyIntensity').value = settings.minimaxModifyIntensity ?? '';
  $('#setMinimaxModifyTimbre').value = settings.minimaxModifyTimbre ?? '';
  $('#setDisplayLimit').value = settings.displayLimit || 0;
  $('#setIdleRemind').value = settings.idleRemind || 0;
  $('#setWaterRemind').value = settings.waterRemind || 0;
  $('#setStandRemind').value = settings.standRemind || 0;
  $('#setDreamEnabled').checked = !!settings.dreamEnabled;
  $('#setDreamSleepHours').value = settings.dreamSleepHours || 6;
  if ($('#setHealthWorkerUrl')) $('#setHealthWorkerUrl').value = settings.healthWorkerUrl || '';
  if ($('#setHealthWorkerToken')) $('#setHealthWorkerToken').value = settings.healthWorkerToken || '';
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

// ======================== 代理快捷预设 ========================
function renderImageProxyPresets() {
  const row = document.getElementById('imageProxyPresetRow');
  if (!row) return;
  const _defaults = () => [
    { name: '局域网', url: '', token: '' },
    { name: '外网',   url: '', token: '' },
  ];
  const presets = (settings.imageProxyPresets?.length === 2)
    ? settings.imageProxyPresets : _defaults();

  row.innerHTML = presets.map((p, i) => {
    const active = settings.imageProxyUrl === p.url && settings.imageProxyToken === p.token;
    return `
    <div style="display:flex;align-items:center;gap:4px;">
      <input class="pp-name" data-i="${i}" value="${escHtml(p.name)}">
      <button class="pp-apply pp-btn${active ? ' pp-active' : ''}" data-i="${i}">${active ? '✓ 使用中' : '应用'}</button>
      <button class="pp-save pp-btn" data-i="${i}">存入</button>
    </div>`;
  }).join('');

  row.querySelectorAll('.pp-apply').forEach(btn => {
    btn.onclick = async () => {
      const i = +btn.dataset.i;
      const p = (settings.imageProxyPresets || _defaults())[i];
      const urlEl = document.getElementById('setImageProxyUrl');
      const tokEl = document.getElementById('setImageProxyToken');
      if (urlEl) urlEl.value = p.url;
      if (tokEl) tokEl.value = p.token;
      settings.imageProxyUrl = p.url;
      settings.imageProxyToken = p.token;
      await saveSettings();
      renderImageProxyPresets();
      toast(`已切换：${p.name}`);
    };
  });

  row.querySelectorAll('.pp-save').forEach(btn => {
    btn.onclick = async () => {
      const i = +btn.dataset.i;
      const url   = (document.getElementById('setImageProxyUrl')?.value || '').trim().replace(/\/$/, '');
      const token = (document.getElementById('setImageProxyToken')?.value || '').trim();
      const name  = row.querySelector(`.pp-name[data-i="${i}"]`)?.value || `预设${i + 1}`;
      if (!settings.imageProxyPresets) settings.imageProxyPresets = _defaults();
      settings.imageProxyPresets[i] = { name, url, token };
      await saveSettings();
      renderImageProxyPresets();
      toast(`已存入"${name}"`);
    };
  });
}

// ======================== 本地服务器快捷预设 ========================
function renderServerUrlPresets() {
  const row = document.getElementById('serverUrlPresetRow');
  if (!row) return;
  const _defaults = () => [
    { name: 'PC',   url: 'http://localhost:8787' },
    { name: '局域网', url: '' },
  ];
  const presets = (settings.serverUrlPresets?.length === 2) ? settings.serverUrlPresets : _defaults();
  const cur = (settings.solitudeServerUrl || '').trim();
  row.innerHTML = presets.map((p, i) => {
    const active = p.url && p.url === cur;
    return `<div style="display:flex;align-items:center;gap:4px;margin-bottom:4px;">
      <input class="sup-name" data-i="${i}" value="${escHtml(p.name)}" style="width:60px;padding:4px 6px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--input-bg);color:var(--text);font-size:12px">
      <button class="sup-apply pp-btn${active ? ' pp-active' : ''}" data-i="${i}">${active ? '✓ 使用中' : '应用'}</button>
      <button class="sup-save pp-btn" data-i="${i}">存入</button>
    </div>`;
  }).join('');
  row.querySelectorAll('.sup-apply').forEach(btn => {
    btn.onclick = async () => {
      const i = +btn.dataset.i;
      const p = (settings.serverUrlPresets?.length === 2 ? settings.serverUrlPresets : _defaults())[i];
      const el = document.getElementById('setSolitudeServerUrl');
      if (el) el.value = p.url;
      settings.solitudeServerUrl = p.url;
      await saveSettings();
      renderServerUrlPresets();
      toast(`已切换：${p.name}`);
    };
  });
  row.querySelectorAll('.sup-save').forEach(btn => {
    btn.onclick = async () => {
      const i = +btn.dataset.i;
      const url  = (document.getElementById('setSolitudeServerUrl')?.value || '').trim().replace(/\/$/, '');
      const name = row.querySelector(`.sup-name[data-i="${i}"]`)?.value || `预设${i + 1}`;
      if (!settings.serverUrlPresets) settings.serverUrlPresets = _defaults();
      settings.serverUrlPresets[i] = { name, url };
      await saveSettings();
      renderServerUrlPresets();
      toast(`已存入"${name}"`);
    };
  });
}

// ======================== 画图预设 ========================
export function renderImagePresets() {
  const list = $('#imagePresetList');
  if (!list) return;
  const presets = getImagePresets();
  const activeIdx = getImageCurPresetIdx();
  const dark = isDarkMode();
  const cardBg = dark ? 'rgba(46,28,58,.7)' : 'rgba(255,255,255,.6)';
  const cardBorder = dark ? 'rgba(80,60,100,.9)' : 'var(--pink-light)';
  list.innerHTML = '';
  if (presets.length === 0) {
    list.innerHTML = '<div style="font-size:12px;color:var(--sub,#999);text-align:center;padding:6px 0">还没有预设，点下方按钮添加（最多5个）</div>';
  }
  presets.forEach((p, i) => list.appendChild(_buildImagePresetCard(p, i, i === activeIdx, cardBg, cardBorder)));
  const addBtn = $('#btnAddImagePreset');
  if (addBtn) addBtn.style.display = presets.length >= 10 ? 'none' : '';
}

function _buildImagePresetCard(p, idx, isActive, cardBg, cardBorder) {
  const card = document.createElement('div');
  card.style.cssText = `background:${cardBg};border:1.5px solid ${isActive ? 'var(--pink)' : cardBorder};border-radius:10px;overflow:hidden`;

  if (p.skip) card.style.opacity = '0.55';
  const hdr = document.createElement('div');
  hdr.style.cssText = 'display:flex;align-items:center;gap:6px;padding:8px 10px';
  hdr.innerHTML = `
    <span data-a="check" style="font-size:15px;min-width:18px;color:var(--pink-deep);cursor:pointer;user-select:none" title="切换为当前使用">${isActive ? '✓' : '○'}</span>
    <span style="flex:1;font-size:13px;font-weight:${isActive ? '600' : '400'};overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${p.name || '未命名'}</span>
    <button data-a="rename" style="padding:2px 6px;font-size:11px;background:none;border:1px solid var(--border,#ddd);border-radius:4px;cursor:pointer;color:var(--text)">✏</button>
    <button data-a="up" style="padding:2px 6px;font-size:11px;background:none;border:1px solid var(--border,#ddd);border-radius:4px;cursor:pointer;color:var(--text)">▲</button>
    <button data-a="dn" style="padding:2px 6px;font-size:11px;background:none;border:1px solid var(--border,#ddd);border-radius:4px;cursor:pointer;color:var(--text)">▼</button>
    <button data-a="toggle" style="padding:2px 8px;font-size:11px;background:none;border:1px solid var(--border,#ddd);border-radius:4px;cursor:pointer;color:var(--text)">展开</button>
    <button data-a="del" style="padding:2px 8px;font-size:11px;background:none;border:1px solid #ffcdd2;border-radius:4px;cursor:pointer;color:#e57373">删</button>
  `;

  const meta = document.createElement('div');
  meta.style.cssText = 'padding:0 10px 6px;font-size:11px;color:var(--sub,#999)';
  meta.textContent = `${(p.baseUrl || '未配置URL').replace(/^https?:\/\//, '').slice(0, 36)} · ${p.model || '未配置模型'}`;

  const body = document.createElement('div');
  body.style.cssText = 'padding:8px 10px 4px;border-top:1px solid var(--border,#eee);flex-direction:column;gap:6px;display:none';
  const _selFmt = (v) => (opt) => (v || 'images') === opt ? 'selected' : '';
  const _sf = _selFmt(p.apiFormat);
  body.innerHTML = `
    <div style="display:flex;align-items:center;gap:8px">
      <label style="min-width:40px;font-size:12px">Key</label>
      <input type="password" data-f="apiKey" value="${p.apiKey || ''}" placeholder="sk-... 留空复用主API Key" style="flex:1;font-size:12px;padding:5px 8px">
    </div>
    <div style="display:flex;align-items:center;gap:8px">
      <label style="min-width:40px;font-size:12px">URL</label>
      <input type="text" data-f="baseUrl" value="${p.baseUrl || ''}" placeholder="https://api.xxx.com/v1" style="flex:1;font-size:12px;padding:5px 8px">
    </div>
    <div style="display:flex;align-items:center;gap:8px">
      <label style="min-width:40px;font-size:12px">模型</label>
      <input type="text" data-f="model" value="${p.model || ''}" placeholder="gpt-image-1" style="flex:1;font-size:12px;padding:5px 8px">
    </div>
    <div style="display:flex;align-items:center;gap:8px">
      <label style="min-width:40px;font-size:12px">格式</label>
      <select data-f="apiFormat" style="flex:1;font-size:12px;padding:5px 8px">
        <option value="images" ${_sf('images')}>images（标准）</option>
        <option value="chat" ${_sf('chat')}>chat（部分站子）</option>
        <option value="nvidia" ${_sf('nvidia')}>nvidia（NVIDIA NIM）</option>
      </select>
    </div>
    <label style="display:flex;align-items:center;gap:6px;font-size:12px;cursor:pointer;padding:2px 0">
      <input type="checkbox" data-f="skip" ${p.skip ? 'checked' : ''} style="width:auto">
      跳过自动轮询（保留但失败时不尝试此预设）
    </label>
    <div style="display:flex;gap:8px;margin-top:4px;padding-bottom:4px">
      <button data-a="save" style="flex:1;padding:6px;background:var(--pink-deep);color:#fff;border:none;border-radius:var(--radius-sm,8px);cursor:pointer;font-size:12px">保存</button>
      <button data-a="use" style="flex:1;padding:6px;background:var(--apricot-deep);color:var(--text);border:none;border-radius:var(--radius-sm,8px);cursor:pointer;font-size:12px">保存并切换</button>
    </div>
  `;

  hdr.querySelector('[data-a="check"]').onclick = () => {
    setImageCurPresetIdx(idx);
    renderImagePresets();
    toast(`🎨 已切换到画图预设「${p.name}」`);
  };
  hdr.querySelector('[data-a="rename"]').onclick = () => {
    const presets = getImagePresets();
    const n = prompt('改名：', presets[idx]?.name || '');
    if (n?.trim()) { presets[idx].name = n.trim(); setImagePresets(presets); renderImagePresets(); }
  };
  hdr.querySelector('[data-a="up"]').onclick = () => {
    const presets = getImagePresets();
    if (idx === 0) return;
    [presets[idx - 1], presets[idx]] = [presets[idx], presets[idx - 1]];
    const cur = getImageCurPresetIdx();
    if (cur === idx) setImageCurPresetIdx(idx - 1);
    else if (cur === idx - 1) setImageCurPresetIdx(idx);
    setImagePresets(presets);
    renderImagePresets();
  };
  hdr.querySelector('[data-a="dn"]').onclick = () => {
    const presets = getImagePresets();
    if (idx === presets.length - 1) return;
    [presets[idx], presets[idx + 1]] = [presets[idx + 1], presets[idx]];
    const cur = getImageCurPresetIdx();
    if (cur === idx) setImageCurPresetIdx(idx + 1);
    else if (cur === idx + 1) setImageCurPresetIdx(idx);
    setImagePresets(presets);
    renderImagePresets();
  };
  hdr.querySelector('[data-a="toggle"]').onclick = (e) => {
    const isOpen = body.style.display === 'flex';
    body.style.display = isOpen ? 'none' : 'flex';
    e.target.textContent = isOpen ? '展开' : '收起';
  };
  hdr.querySelector('[data-a="del"]').onclick = () => {
    const presets = getImagePresets();
    presets.splice(idx, 1);
    const cur = getImageCurPresetIdx();
    if (cur >= presets.length) setImageCurPresetIdx(Math.max(0, presets.length - 1));
    setImagePresets(presets);
    renderImagePresets();
    toast(`已删除画图预设「${p.name}」`);
  };

  const doSave = () => {
    const presets = getImagePresets();
    body.querySelectorAll('[data-f]').forEach(el => {
      if (el.type === 'checkbox') presets[idx][el.dataset.f] = el.checked;
      else presets[idx][el.dataset.f] = el.value.trim();
    });
    setImagePresets(presets);
    renderImagePresets();
    toast('画图预设已保存 ✓');
  };
  body.querySelector('[data-a="save"]').onclick = doSave;
  body.querySelector('[data-a="use"]').onclick = () => {
    doSave();
    setImageCurPresetIdx(idx);
    renderImagePresets();
    toast(`🎨 已切换到画图预设「${p.name}」`);
  };

  card.append(hdr, meta, body);
  return card;
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
  // 渲染主备用预设下拉（10个槽）
  [0,1,2,3,4,5,6,7,8,9].forEach(i => {
    const fbSel = $(`#setFallbackPreset${i}`);
    if (!fbSel) return;
    const cur = fbSel.value;
    fbSel.innerHTML = `<option value="">— 备用${i+1}：不启用 —</option>`;
    presets.forEach(p => { const opt = document.createElement('option'); opt.value = p.name; opt.textContent = p.name; fbSel.appendChild(opt); });
    fbSel.value = cur;
  });
  // 渲染副备用预设下拉（5个槽）
  [0,1,2,3,4].forEach(i => {
    const fbSel = $(`#setSubFallbackPreset${i}`);
    if (!fbSel) return;
    const cur = fbSel.value;
    fbSel.innerHTML = `<option value="">— 备用${i+1}：不启用 —</option>`;
    presets.forEach(p => { const opt = document.createElement('option'); opt.value = p.name; opt.textContent = p.name; fbSel.appendChild(opt); });
    fbSel.value = cur;
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
  settings.useLocalProxy = !!p.useLocalProxy;
  settings.apiFormat = p.apiFormat || 'openai';
  saveSettings();
  $('#setApiKey').value = p.apiKey || '';
  $('#setBaseUrl').value = p.baseUrl || '';
  $('#setModel').value = p.model || '';
  if ($('#apiPresetName')) $('#apiPresetName').value = p.name;
  if ($('#apiPresetUseProxy')) $('#apiPresetUseProxy').checked = !!p.useLocalProxy;
  if ($('#apiPresetApiFormat')) $('#apiPresetApiFormat').value = p.apiFormat || 'openai';
  if ($('#presetSelect')) $('#presetSelect').value = i;
  document.getElementById('checkerOverlay').style.display = 'none';
  toast(`✅ 已切换到「${p.name}」`);
}

// ======================== TTS 类型切换 UI ========================
export function updateTtsTypeUI() {
  const type = (($('#setTtsType') || {}).value) || settings.ttsType || 'local';
  const doubao = $('#doubaoFields');
  const local = $('#localTtsFields');
  const mosi = $('#mosiFields');
  const minimax = $('#minimaxFields');
  const mimo = $('#mimoFields');
  if (doubao) doubao.style.display = type === 'doubao' ? '' : 'none';
  if (local) local.style.display = type === 'local' ? '' : 'none';
  if (mosi) mosi.style.display = type === 'mosi' ? '' : 'none';
  if (minimax) minimax.style.display = type === 'minimax' ? '' : 'none';
  if (mimo) mimo.style.display = type === 'mimo' ? '' : 'none';
}

// ======================== 音色预设管理 ========================
function _showActivePresetLabel() {
  const el = document.getElementById('ttsActivePresetLabel');
  if (!el) return;
  const name = settings.ttsActivePresetName;
  if (name) { el.textContent = `当前：${name}`; el.style.display = ''; }
  else { el.style.display = 'none'; }
}
function _mimoRefKey(suffix) {
  const id = settings.ttsActivePresetId;
  return id ? `${suffix}_${id}` : suffix;
}
function _updateMimoRefStatus() {
  dbGet('images', _mimoRefKey('mimoRefAudio')).then(b => {
    const el = document.getElementById('mimoRefAudioStatus');
    if (el) el.textContent = b ? '✓ 已上传' : '未上传';
  });
  dbGet('images', _mimoRefKey('mimoRefAudioEn')).then(b => {
    const el = document.getElementById('mimoRefAudioEnStatus');
    if (el) el.textContent = b ? '✓ 已上传' : '未上传';
  });
}
export function renderTtsPresets() {
  _showActivePresetLabel();
  const list = $('#ttsPresetList');
  if (!list) return;
  list.innerHTML = '';
  const presets = settings.ttsPresets || [];
  let needSave = false;
  presets.forEach(p => { if (!p.id) { p.id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8); needSave = true; } });
  if (needSave) saveSettings();
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
    div.innerHTML = `
      <span style="flex:1;font-size:14px;font-weight:600;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(p.name)}</span>
      <button class="btn-secondary" style="padding:4px 8px;font-size:12px;white-space:nowrap;flex-shrink:0">✏</button>
      <button class="btn-secondary" style="padding:4px 12px;font-size:12px;white-space:nowrap;flex-shrink:0">激活</button>
      <button class="btn-danger" style="padding:4px 8px;font-size:12px;flex-shrink:0">✕</button>`;
    list.appendChild(div);
    div.querySelectorAll('button')[0].onclick = () => {
      const n = prompt('改名：', p.name || '');
      if (n?.trim()) { (settings.ttsPresets || [])[i].name = n.trim(); saveSettings(); renderTtsPresets(); }
    };
    div.querySelectorAll('button')[1].onclick = () => activateTtsPreset(i);
    div.querySelectorAll('button')[2].onclick = () => deleteTtsPreset(i);
  });
}

export async function activateTtsPreset(i) {
  const p = (settings.ttsPresets || [])[i];
  if (!p) return;
  settings.ttsActivePresetId = p.id || '';
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
  settings.minimaxVoiceId       = p.minimaxVoiceId       || '';
  settings.minimaxModel         = p.minimaxModel         || '';
  settings.minimaxProxy         = p.minimaxProxy         || '';
  settings.minimaxTimbreWeights = p.minimaxTimbreWeights || '';
  settings.minimaxSpeed         = p.minimaxSpeed         ?? '';
  settings.minimaxVol           = p.minimaxVol           ?? '';
  settings.minimaxModifyPitch     = p.minimaxModifyPitch     ?? '';
  settings.minimaxModifyIntensity = p.minimaxModifyIntensity ?? '';
  settings.minimaxModifyTimbre    = p.minimaxModifyTimbre    ?? '';
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
  $('#setMinimaxTimbreWeights').value     = settings.minimaxTimbreWeights || '';
  $('#setMinimaxSpeed').value             = settings.minimaxSpeed ?? '';
  $('#setMinimaxVol').value               = settings.minimaxVol ?? '';
  $('#setMinimaxModifyPitch').value       = settings.minimaxModifyPitch ?? '';
  $('#setMinimaxModifyIntensity').value   = settings.minimaxModifyIntensity ?? '';
  $('#setMinimaxModifyTimbre').value      = settings.minimaxModifyTimbre ?? '';
  updateTtsTypeUI();
  settings.ttsActivePresetName = p.name;
  await saveSettings();
  const { clearMimoRefCache, clearMimoRefCacheEn } = await import('./tts.js');
  clearMimoRefCache(); clearMimoRefCacheEn();
  _updateMimoRefStatus();
  _showActivePresetLabel();
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

// ======================== 画风参考图渲染 ========================
let _styleRefTargetIdx = -1;
async function renderStyleRefSlots() {
  const container = $('#styleRefContainer');
  if (!container) return;
  container.innerHTML = '';
  const meta = (await dbGet('settings', 'styleRefs').catch(() => null)) || [];

  for (let i = 0; i < meta.length; i++) {
    const entry = meta[i];
    const idx = parseInt(entry.imgKey.replace('styleRef_', ''));
    const imgB64 = await dbGet('images', entry.imgKey).catch(() => null);

    const slot = document.createElement('div');
    slot.className = 'style-ref-slot';
    slot.innerHTML = `
      <img src="${imgB64 || ''}" alt="${entry.name || '画风'}" style="object-fit:contain;background:#f0f0f0">
      <div class="style-ref-inputs">
        <input type="text" placeholder="画风名称" value="${entry.name || ''}" maxlength="20" data-field="name" data-i="${i}">
        <textarea placeholder="描述（可选，帮助AI选择画风）" maxlength="100" data-field="desc" data-i="${i}">${entry.desc || ''}</textarea>
        <div class="style-ref-actions">
          <button class="btn-upload" data-action="upload" data-idx="${idx}">上传图</button>
          <button class="btn-upload" data-action="clear" data-idx="${idx}" style="font-size:11px;opacity:0.7">清除图</button>
          <button class="btn-upload" data-action="delete" data-i="${i}" style="font-size:11px;opacity:0.7;color:#e55">删除</button>
        </div>
      </div>`;
    container.appendChild(slot);
  }

  if (meta.length < 5) {
    const addBtn = document.createElement('button');
    addBtn.className = 'btn-add-style-ref';
    addBtn.textContent = '＋ 添加画风';
    addBtn.addEventListener('click', async () => {
      const curMeta = (await dbGet('settings', 'styleRefs').catch(() => null)) || [];
      if (curMeta.length >= 5) { toast('最多5个画风'); return; }
      const usedIdxs = new Set(curMeta.map(s => parseInt(s.imgKey.replace('styleRef_', ''))));
      let newIdx = 0;
      while (usedIdxs.has(newIdx) && newIdx < 5) newIdx++;
      curMeta.push({ name: '', desc: '', imgKey: 'styleRef_' + newIdx });
      await dbPut('settings', 'styleRefs', curMeta);
      await renderStyleRefSlots();
    });
    container.appendChild(addBtn);
  }

  if (!container.dataset.bound) {
    container.dataset.bound = '1';
    container.addEventListener('click', async (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      const action = btn.dataset.action;

      if (action === 'upload') {
        _styleRefTargetIdx = parseInt(btn.dataset.idx);
        $('#fileInputStyleRef')?.click();
      } else if (action === 'clear') {
        const imgKey = 'styleRef_' + btn.dataset.idx;
        await dbPut('images', imgKey, null);
        toast('画风参考图已清除');
        await renderStyleRefSlots();
      } else if (action === 'delete') {
        const curMeta = (await dbGet('settings', 'styleRefs').catch(() => null)) || [];
        const di = parseInt(btn.dataset.i);
        if (di >= 0 && di < curMeta.length) {
          await dbPut('images', curMeta[di].imgKey, null);
          curMeta.splice(di, 1);
          await dbPut('settings', 'styleRefs', curMeta);
          toast('画风已删除');
          await renderStyleRefSlots();
        }
      }
    });

    container.addEventListener('change', async (e) => {
      const input = e.target;
      if (!input.dataset.field) return;
      const curMeta = (await dbGet('settings', 'styleRefs').catch(() => null)) || [];
      const mi = parseInt(input.dataset.i);
      if (mi >= 0 && mi < curMeta.length) {
        curMeta[mi][input.dataset.field] = input.value.trim();
        await dbPut('settings', 'styleRefs', curMeta);
      }
    });
  }
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
  // 迁移旧参考图 → 新key（首次运行一次）
  if (!await dbGet('images', 'aiRef').catch(() => null)) {
    const old = await dbGet('images', 'aiRefAnime').catch(() => null);
    if (old) await dbPut('images', 'aiRef', old);
  }
  if (!await dbGet('images', 'userRef').catch(() => null)) {
    const old = await dbGet('images', 'userRefAnime').catch(() => null);
    if (old) await dbPut('images', 'userRef', old);
  }
  // 加载形象参考图预览
  for (const key of ['aiRef', 'userRef']) {
    const val = await dbGet('images', key);
    const el = $('#preview' + key.charAt(0).toUpperCase() + key.slice(1));
    if (el) el.src = val || '';
  }
  // 加载画风参考图
  await renderStyleRefSlots();
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
    const _mtVal = parseInt($('#setMaxTokens')?.value || '');
    settings.maxTokens = _mtVal > 0 ? _mtVal : 0;
    settings.memoryArchive = $('#setMemoryArchive').value;
    ensureMemoryState();
    renderMemoryBankPreview();
    await digestMemory();
  };

  if ($('#btnSyncMemoryLocal')) $('#btnSyncMemoryLocal').onclick = async () => {
    const content = (settings.memoryArchive || $('#setMemoryArchive').value || '').trim();
    if (!content) { toast('记忆档案为空'); return; }
    if (!settings.solitudeServerUrl) { toast('请先配置本地服务器地址'); return; }
    const statusEl = $('#syncMemoryStatus');
    const btn = $('#btnSyncMemoryLocal');
    btn.disabled = true;
    btn.textContent = '⏳ 同步中…';
    try {
      const res = await fetch(`${settings.solitudeServerUrl.replace(/\/+$/, '')}/api/memory`, {
        method: 'POST', headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        body: content, signal: AbortSignal.timeout(15000)
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const charCount = content.length;
      const vMatch = content.match(/^# .+?v(\d+)/m);
      const ver = vMatch ? `v${vMatch[1]}` : '';
      statusEl.textContent = `✅ 已同步 ${charCount} 字${ver ? '（' + ver + '）' : ''} → 电脑`;
      toast(`✅ 记忆档案已同步到电脑（${charCount}字）`);
    } catch(e) {
      statusEl.textContent = `❌ 同步失败：${e.message}`;
      toast(`❌ 同步失败：${e.message}`);
    } finally {
      btn.disabled = false;
      btn.textContent = '💾 同步记忆档案到电脑';
    }
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
  const _addImgPresetBtn = $('#btnAddImagePreset');
  if (_addImgPresetBtn) {
    _addImgPresetBtn.onclick = () => {
      const presets = getImagePresets();
      if (presets.length >= 10) { toast('最多10个画图预设'); return; }
      presets.push({ name: `画图预设${presets.length + 1}`, apiKey: '', baseUrl: '', model: 'gpt-image-1', apiFormat: 'images', skip: false });
      setImagePresets(presets);
      renderImagePresets();
      // 自动展开最后一张卡片（children: hdr/meta/body）
      const list = $('#imagePresetList');
      if (list && list.children.length > 0) {
        const lastCard = list.children[list.children.length - 1];
        const body = lastCard.children[2];
        const toggleBtn = lastCard.querySelector('[data-a="toggle"]');
        if (body && toggleBtn) { body.style.display = 'flex'; toggleBtn.textContent = '收起'; }
      }
    };
  }

  // ======================== API 预设按钮 ========================
  $('#btnLoadPreset').onclick = () => {
    const i = parseInt($('#presetSelect').value);
    if (isNaN(i)) { toast('请先选择一个预设'); return; }
    const p = getApiPresets()[i];
    if (!p) return;
    $('#apiPresetName').value = p.name;
    $('#setApiKey').value  = p.apiKey  || '';
    $('#setBaseUrl').value = p.baseUrl || '';
    if ($('#setBackupBaseUrl')) $('#setBackupBaseUrl').value = p.backupBaseUrl || '';
    $('#setModel').value   = p.model   || '';
    if ($('#apiPresetUseProxy')) $('#apiPresetUseProxy').checked = !!p.useLocalProxy;
    if ($('#apiPresetApiFormat')) $('#apiPresetApiFormat').value = p.apiFormat || 'openai';
    settings.useLocalProxy = !!p.useLocalProxy;
    settings.apiFormat = p.apiFormat || 'openai';
    saveSettings();
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
    const useLocalProxy = !!$('#apiPresetUseProxy')?.checked;
    const apiFormat = $('#apiPresetApiFormat')?.value || 'openai';
    if (!apiKey) { toast('API Key 不能为空'); return; }
    const presets = getApiPresets();
    const existing = presets.findIndex(p => p.name === name);
    if (existing >= 0) presets[existing] = { name, apiKey, baseUrl, backupBaseUrl, model, useLocalProxy, apiFormat };
    else presets.push({ name, apiKey, baseUrl, backupBaseUrl, model, useLocalProxy, apiFormat });
    setApiPresets(presets);
    renderApiPresets();
    $('#apiPresetName').value = '';
    toast(`💙 预设「${name}」已保存`);
  };
  $('#btnRenamePreset').onclick = () => {
    const i = parseInt($('#presetSelect').value);
    if (isNaN(i)) { toast('请先选择一个预设'); return; }
    const presets = getApiPresets();
    const oldName = presets[i]?.name;
    const newName = prompt(`重命名预设「${oldName}」`, oldName)?.trim();
    if (!newName || newName === oldName) return;
    if (presets.some((p, idx) => idx !== i && p.name === newName)) { toast('已有同名预设'); return; }
    presets[i].name = newName;
    setApiPresets(presets);
    renderApiPresets();
    toast(`✅ 已改名为「${newName}」`);
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
  function renderPresetSortList() {
    const presets = getApiPresets();
    const list = document.getElementById('presetSortList');
    if (!list) return;
    const btnStyle = 'padding:6px 10px;border:1.5px solid var(--border);border-radius:8px;background:var(--surface);color:var(--text);cursor:pointer;font-size:14px;flex-shrink:0';
    list.innerHTML = presets.map((p, i) => `
      <div style="display:flex;align-items:center;gap:8px;padding:10px 12px;background:var(--bg);border-radius:12px;border:1.5px solid var(--border);cursor:pointer" onclick="window._selectPresetFromSort(${i})">
        <div style="flex:1;min-width:0;font-size:14px;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(p.name)}</div>
        <button style="${btnStyle}" onclick="event.stopPropagation();window._movePresetInSort(${i},-1)">▲</button>
        <button style="${btnStyle}" onclick="event.stopPropagation();window._movePresetInSort(${i},1)">▼</button>
      </div>`).join('');
  }
  window._selectPresetFromSort = (i) => {
    const p = getApiPresets()[i];
    if (!p) return;
    $('#presetSelect').value = i;
    $('#apiPresetName').value = p.name;
    document.getElementById('presetSortOverlay').style.display = 'none';
    toast(`✅ 已选中「${p.name}」，改完字段后点激活主或保存设置`);
  };
  window._movePresetInSort = (i, dir) => {
    const presets = getApiPresets();
    const j = i + dir;
    if (j < 0 || j >= presets.length) return;
    [presets[i], presets[j]] = [presets[j], presets[i]];
    setApiPresets(presets);
    renderApiPresets();
    renderPresetSortList();
  };
  $('#btnOpenPresetSort').onclick = () => {
    const presets = getApiPresets();
    if (!presets.length) { toast('还没有保存任何预设'); return; }
    renderPresetSortList();
    document.getElementById('presetSortOverlay').style.display = 'flex';
  };
  $('#btnClosePresetSort').onclick = () => { document.getElementById('presetSortOverlay').style.display = 'none'; };

  // ======================== 保存设置 ========================
  $('#btnSaveSettingsTop').onclick = () => $('#btnSaveSettings').click();
  $('#btnSaveSettings').onclick = async () => {
    settings.apiKey = $('#setApiKey').value.trim();
    settings.useLocalProxy = !!($('#apiPresetUseProxy')?.checked);
    settings.apiFormat = $('#apiPresetApiFormat')?.value || 'openai';
    resetStickyPreset();
    settings.braveKey = $('#setBraveKey').value.trim();
    settings.morningWalkEnabled = !!($('#setMorningWalkEnabled')?.checked);
    settings.memoryAutoConflictDetect = !!($('#setMemoryAutoConflictDetect')?.checked);
    settings.searchDays = parseInt($('#setSearchDays').value) || 3;
    settings.searchCount = parseInt($('#setSearchCount').value) || 5;
    settings.wereadApiKey = ($('#setWereadApiKey') ? $('#setWereadApiKey').value.trim() : '');
    settings.solitudeServerUrl = ($('#setSolitudeServerUrl') ? $('#setSolitudeServerUrl').value.trim() : '').replace(/\/$/, '');
    settings.baseUrl = $('#setBaseUrl').value.trim() || 'https://api.openai.com';
    settings.fallbackPresetNames = [0,1,2,3,4,5,6,7,8,9].map(i => ($(`#setFallbackPreset${i}`)?.value || '')).filter(v=>v);
    settings.model = $('#setModel').value.trim() || 'gpt-4o';
    settings.subApiKey = $('#setSubApiKey').value.trim();
    settings.subBaseUrl = $('#setSubBaseUrl').value.trim();
    settings.subFallbackPresetNames = [0,1,2,3,4].map(i => ($(`#setSubFallbackPreset${i}`)?.value || '')).filter(v=>v);
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
    settings.imageApiFormat = $('#setImageApiFormat').value || 'images';
    settings.imageProxyUrl = ($('#setImageProxyUrl')?.value || '').trim().replace(/\/$/, '');
    settings.imageProxyToken = ($('#setImageProxyToken')?.value || '').trim();
    settings.imageSize = $('#setImageRatio').value || '1024x1024';
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
    settings.mimoKey = $('#setMimoKey').value.trim();
    settings.mimoStylePrompt = $('#setMimoStylePrompt').value.trim();
    settings.minimaxKey = $('#setMinimaxKey').value.trim();
    settings.minimaxGroupId = $('#setMinimaxGroupId').value.trim();
    settings.minimaxVoiceId         = $('#setMinimaxVoiceId').value.trim();
    settings.minimaxModel           = $('#setMinimaxModel').value.trim();
    settings.minimaxProxy           = $('#setMinimaxProxy').value.trim();
    settings.minimaxTimbreWeights   = $('#setMinimaxTimbreWeights').value.trim();
    settings.minimaxSpeed           = $('#setMinimaxSpeed').value.trim();
    settings.minimaxVol             = $('#setMinimaxVol').value.trim();
    settings.minimaxModifyPitch     = $('#setMinimaxModifyPitch').value.trim();
    settings.minimaxModifyIntensity = $('#setMinimaxModifyIntensity').value.trim();
    settings.minimaxModifyTimbre    = $('#setMinimaxModifyTimbre').value.trim();
    settings.idleRemind = parseInt($('#setIdleRemind').value) || 0;
    settings.waterRemind = parseInt($('#setWaterRemind').value) || 0;
    settings.standRemind = parseInt($('#setStandRemind').value) || 0;
    settings.dreamEnabled = $('#setDreamEnabled').checked;
    settings.dreamSleepHours = parseFloat($('#setDreamSleepHours').value) || 6;
    if ($('#setHealthWorkerUrl')) settings.healthWorkerUrl = $('#setHealthWorkerUrl').value.trim();
    if ($('#setHealthWorkerToken')) settings.healthWorkerToken = $('#setHealthWorkerToken').value.trim();
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
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
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
      minimaxVoiceId:         $('#setMinimaxVoiceId').value.trim(),
      minimaxModel:           $('#setMinimaxModel').value.trim(),
      minimaxProxy:           $('#setMinimaxProxy').value.trim(),
      minimaxTimbreWeights:   $('#setMinimaxTimbreWeights').value.trim(),
      minimaxSpeed:           $('#setMinimaxSpeed').value.trim(),
      minimaxVol:             $('#setMinimaxVol').value.trim(),
      minimaxModifyPitch:     $('#setMinimaxModifyPitch').value.trim(),
      minimaxModifyIntensity: $('#setMinimaxModifyIntensity').value.trim(),
      minimaxModifyTimbre:    $('#setMinimaxModifyTimbre').value.trim(),
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

  // ======================== 画图参考图上传 ========================
  const _refSlots = [
    { btn: 'btnUploadAiRef',   file: 'fileInputAiRef',   prev: 'previewAiRef',   key: 'aiRef',   label: '炘也形象参考图' },
    { btn: 'btnUploadUserRef', file: 'fileInputUserRef', prev: 'previewUserRef', key: 'userRef', label: '涂涂形象参考图' },
  ];
  const _clearSlots = [
    { btn: 'btnClearAiRef',   prev: 'previewAiRef',   key: 'aiRef',   label: '炘也形象参考图' },
    { btn: 'btnClearUserRef', prev: 'previewUserRef', key: 'userRef', label: '涂涂形象参考图' },
  ];
  for (const s of _refSlots) {
    $('#' + s.btn)?.addEventListener('click', () => $('#' + s.file).click());
    $('#' + s.file)?.addEventListener('change', async function() {
      if (!this.files[0]) return;
      const b64 = await readFileAsBase64(this.files[0]);
      await dbPut('images', s.key, b64);
      const prev = $('#' + s.prev);
      if (prev) prev.src = b64;
      toast(s.label + '已保存');
      this.value = '';
    });
  }
  for (const s of _clearSlots) {
    $('#' + s.btn)?.addEventListener('click', async () => {
      await dbPut('images', s.key, null);
      const prev = $('#' + s.prev);
      if (prev) prev.src = '';
      toast(s.label + '已清除');
    });
  }

  // ======================== 画风参考图 ========================
  $('#fileInputStyleRef')?.addEventListener('change', async function() {
    if (!this.files[0] || _styleRefTargetIdx < 0) return;
    const b64 = await readFileAsBase64(this.files[0]);
    const meta = (await dbGet('settings', 'styleRefs').catch(() => null)) || [];
    const entry = meta.find(s => s.imgKey === 'styleRef_' + _styleRefTargetIdx);
    if (!entry) { this.value = ''; return; }
    await dbPut('images', entry.imgKey, b64);
    this.value = '';
    toast('画风参考图已保存');
    await renderStyleRefSlots();
  });

  // Mimo 参考音频上传
  document.getElementById('mimoRefAudioInput')?.addEventListener('change', async function() {
    const file = this.files[0];
    if (!file) return;
    await dbPut('images', _mimoRefKey('mimoRefAudio'), file);
    const { clearMimoRefCache } = await import('./tts.js');
    clearMimoRefCache();
    const el = document.getElementById('mimoRefAudioStatus');
    if (el) el.textContent = `✓ ${file.name} (${(file.size/1024).toFixed(0)}KB)`;
    toast('Mimo 参考音频已保存');
    this.value = '';
  });

  // Mimo 英文参考音频上传
  document.getElementById('mimoRefAudioEnInput')?.addEventListener('change', async function() {
    const file = this.files[0];
    if (!file) return;
    await dbPut('images', _mimoRefKey('mimoRefAudioEn'), file);
    const { clearMimoRefCacheEn } = await import('./tts.js');
    clearMimoRefCacheEn();
    const el = document.getElementById('mimoRefAudioEnStatus');
    if (el) el.textContent = `✓ ${file.name} (${(file.size/1024).toFixed(0)}KB)`;
    toast('Mimo 英文参考音频已保存');
    this.value = '';
  });

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

  // 立即发推送测试
  const _btnSendPushTest = $('#btnSendPushTest');
  if (_btnSendPushTest) {
    _btnSendPushTest.onclick = async () => {
      const solUrl = ($('#setSolitudeServerUrl')?.value.trim() || window.settings?.solitudeServerUrl || '').replace(/\/+$/, '');
      if (!solUrl) { alert('请先填写本地服务器地址'); return; }
      _btnSendPushTest.textContent = '发送中…';
      try {
        const r = await fetch(`${solUrl}/api/push-test`, { method: 'POST' });
        const d = await r.json();
        _btnSendPushTest.textContent = '📨 立即发一条推送（测试）';
        if (d.ok) alert(`推送已发送（${d.sent}个订阅，代理：${d.proxyUsed ? '✅' : '❌'}）`);
        else alert('发送失败：' + (d.reason || '未知'));
      } catch(e) {
        _btnSendPushTest.textContent = '📨 立即发一条推送（测试）';
        alert('请求失败：' + e.message);
      }
    };
  }

  // 推送代理配置
  const _inputPushProxy = $('#inputPushProxy');
  const _btnSavePushProxy = $('#btnSavePushProxy');
  if (_inputPushProxy && _btnSavePushProxy) {
    const solUrl = () => ($('#setSolitudeServerUrl')?.value.trim() || window.settings?.solitudeServerUrl || '').replace(/\/+$/, '');
    // 加载当前代理地址
    const _loadProxy = async () => {
      const url = solUrl(); if (!url) return;
      try {
        const r = await fetch(`${url}/api/push-proxy`);
        const d = await r.json();
        _inputPushProxy.value = d.proxyUrl || '';
        _inputPushProxy.placeholder = d.hasAgent ? '推送代理地址（如 http://127.0.0.1:7890）' : '代理模块未就绪';
      } catch {}
    };
    _loadProxy();
    _btnSavePushProxy.onclick = async () => {
      const url = solUrl(); if (!url) { alert('请先填写本地服务器地址'); return; }
      _btnSavePushProxy.textContent = '保存中…';
      try {
        await fetch(`${url}/api/push-proxy`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ proxyUrl: _inputPushProxy.value.trim() }) });
        _btnSavePushProxy.textContent = '✓';
        setTimeout(() => { _btnSavePushProxy.textContent = '保存'; }, 2000);
      } catch(e) {
        _btnSavePushProxy.textContent = '保存';
        alert('保存失败：' + e.message);
      }
    };
  }

  // 推送支持测试
  const _btnTestPush = $('#btnTestPush');
  if (_btnTestPush) {
    _btnTestPush.onclick = async () => {
      const lines = [];
      lines.push('ServiceWorker: ' + ('serviceWorker' in navigator ? '✅' : '❌'));
      lines.push('PushManager: ' + ('PushManager' in window ? '✅' : '❌'));
      lines.push('Notification API: ' + ('Notification' in window ? '✅' : '❌'));
      if ('Notification' in window) {
        const perm = Notification.permission;
        lines.push(`当前通知权限: ${perm}`);
        if (perm === 'default') {
          const req = await Notification.requestPermission();
          lines.push(`申请后权限: ${req}`);
        }
      }
      if ('PushManager' in window && 'serviceWorker' in navigator) {
        try {
          const reg = await navigator.serviceWorker.ready;
          const sub = await reg.pushManager.getSubscription();
          lines.push('现有订阅: ' + (sub ? '✅ 已有\n' + sub.endpoint.slice(0, 60) + '…' : '❌ 无'));
        } catch(e) {
          lines.push('订阅检查出错: ' + e.message);
        }
      }
      alert(lines.join('\n'));
    };
  }

  // 从电脑恢复
  const _restoreToggle = $('#btnServerRestoreToggle');
  const _restorePanel  = $('#serverRestorePanel');
  const _restoreList   = $('#serverRestoreList');
  if (_restoreToggle) {
    _restoreToggle.onclick = async () => {
      const isOpen = _restorePanel.style.display !== 'none';
      if (isOpen) { _restorePanel.style.display = 'none'; return; }
      _restorePanel.style.display = 'block';
      _restoreList.textContent = '加载中…';
      try {
        const files = await fetchServerBackupList();
        if (!files.length) { _restoreList.textContent = '暂无备份文件'; return; }
        _restoreList.innerHTML = '';
        files.forEach(({ name, size }) => {
          // xinye_pc_backup_2026-05-25_14-30.json → "2026-05-25 14:30 [PC]"
          const m = name.match(/_(pc|mobile)_backup_(\d{4}-\d{2}-\d{2})_(\d{2}-\d{2})/);
          const label = m ? `${m[2]} ${m[3].replace('-', ':')} [${m[1] === 'mobile' ? '手机' : 'PC'}]` : name;
          const kb = Math.round(size / 1024);
          const row = document.createElement('div');
          row.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border-color,#e0d6f0)';
          row.innerHTML = `<span style="font-size:13px">${label} <span style="opacity:.5">${kb}KB</span></span>
            <button style="font-size:12px;padding:3px 10px;border-radius:6px;border:1px solid var(--primary,#8b5cf6);color:var(--primary,#8b5cf6);background:none;cursor:pointer">恢复</button>`;
          row.querySelector('button').onclick = async () => {
            if (!confirm(`恢复"${label}"？当前数据会被覆盖。`)) return;
            try {
              row.querySelector('button').textContent = '恢复中…';
              await restoreFromServer(name);
            } catch (e) { toast('恢复失败：' + e.message); row.querySelector('button').textContent = '恢复'; }
          };
          _restoreList.appendChild(row);
        });
      } catch (e) {
        _restoreList.textContent = '加载失败：' + e.message;
      }
    };
  }

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
function _openModelPicker(title, items, targetInputId) {
  const overlay = $('#modelPickerOverlay');
  const list = $('#modelPickerList');
  const search = $('#modelPickerSearch');
  const titleEl = $('#modelPickerTitle');
  if (!overlay || !list) return;
  titleEl.textContent = title;
  search.value = '';
  const render = (filter) => {
    const q = (filter || '').toLowerCase();
    const filtered = q ? items.filter(it => it.label.toLowerCase().includes(q) || (it.value + '').toLowerCase().includes(q)) : items;
    list.innerHTML = filtered.length
      ? filtered.map(it => `<div class="model-pick-item" data-val="${escHtml(it.value)}" style="padding:8px 10px;border-radius:var(--radius-sm);cursor:pointer;font-size:13px;color:var(--text);border:1px solid var(--border);background:var(--bg)">${escHtml(it.label)}</div>`).join('')
      : '<div style="padding:12px;color:var(--text-muted);font-size:13px;text-align:center">无匹配结果</div>';
  };
  render('');
  search.oninput = () => render(search.value);
  list.onclick = (e) => {
    const item = e.target.closest('.model-pick-item');
    if (!item) return;
    const input = $('#' + targetInputId);
    if (input) input.value = item.dataset.val;
    overlay.style.display = 'none';
  };
  overlay.style.display = 'flex';
  setTimeout(() => search.focus(), 100);
}

export async function fetchModelList(urlInputId, keyInputId, modelInputId) {
  const rawUrl = $('#' + urlInputId).value.trim() || ($('#setBaseUrl') ? $('#setBaseUrl').value.trim() : '') || 'https://api.openai.com';
  const baseUrl = rawUrl.replace(/\/+$/, '');
  const apiKey = $('#' + keyInputId).value.trim() || ($('#setApiKey') ? $('#setApiKey').value.trim() : '');
  if (!baseUrl && !apiKey) { toast('请先填写 Base URL 和 API Key'); return; }
  const url = /\/v\d+$/.test(baseUrl) ? `${baseUrl}/models` : `${baseUrl}/v1/models`;
  toast('⏳ 获取模型列表…');
  try {
    const _useProxy = $('#apiPresetUseProxy')?.checked && settings.solitudeServerUrl;
    const _fmt = $('#apiPresetApiFormat')?.value || 'openai';
    const _fetchUrl = _useProxy ? `${settings.solitudeServerUrl.replace(/\/+$/,'')}/api/llm-proxy-get?target=${encodeURIComponent(url)}&key=${encodeURIComponent(apiKey)}` : url;
    const _fetchOpts = _useProxy ? {} : _fmt === 'anthropic'
      ? { headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' } }
      : { headers: { Authorization: `Bearer ${apiKey}` } };
    const res = await fetch(_fetchUrl, _fetchOpts);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const models = (data.data || []).map(m => m.id || m).filter(Boolean).sort();
    if (!models.length) { toast('（无可用模型）'); return; }
    _openModelPicker('📋 选择模型', models.map(m => ({ label: m, value: m })), modelInputId);
  } catch(e) {
    toast(`❌ 获取失败：${e.message}`);
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
