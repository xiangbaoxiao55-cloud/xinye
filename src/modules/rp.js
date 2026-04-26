import { lsBackup, lsRemoveBackup, dbGetRecent } from './db.js';
import { toast } from './utils.js';
import { settings, messages } from './state.js';
import { getAiAvatar, getUserAvatar, renderMessages } from './chat.js';

async function switchRpMode(active) {
  const loadCount = Math.max(settings ? (settings.displayLimit || 0) : 0, 2000);
  const storeName = active ? 'rpMessages' : 'messages';
  { const _m = await dbGetRecent(storeName, loadCount); messages.length = 0; messages.push(..._m); }
  await renderMessages();
  if (typeof window.updateHeaderStatus === 'function') window.updateHeaderStatus();
}

export function initRp() {
  let rpActive = localStorage.getItem('rp_active') === '1';
  let rpPresets = JSON.parse(localStorage.getItem('rp_presets') || '[]');

  function rpInit() {
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

  window.clearRpAvatar = function() {
    localStorage.removeItem('rp_char_avatar');
    lsRemoveBackup('rp_char_avatar');
    refreshRpCharAvatar();
    if (rpActive) applyRpHeader();
  };

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

  window.clearRpUserAvatar = function() {
    localStorage.removeItem('rp_user_avatar');
    lsRemoveBackup('rp_user_avatar');
    refreshRpUserAvatar();
  };

  window.saveRpCharInfo = function() {
    const name = document.getElementById('rpCharName')?.value || '';
    localStorage.setItem('rp_char_name', name);
    lsBackup('rp_char_name', name);
    const userName = document.getElementById('rpUserName')?.value || '';
    localStorage.setItem('rp_user_name', userName);
    lsBackup('rp_user_name', userName);
    if (rpActive) applyRpHeader();
  };

  function refreshRpCharAvatar() {
    const av = localStorage.getItem('rp_char_avatar');
    const img = document.getElementById('rpCharAvatar');
    const placeholder = document.getElementById('rpCharAvatarPlaceholder');
    if (!img || !placeholder) return;
    if (av) { img.src = av; img.style.display = 'block'; placeholder.style.display = 'none'; }
    else { img.style.display = 'none'; placeholder.style.display = 'flex'; }
  }

  function refreshRpUserAvatar() {
    const av = localStorage.getItem('rp_user_avatar');
    const img = document.getElementById('rpUserAvatar');
    const placeholder = document.getElementById('rpUserAvatarPlaceholder');
    if (!img || !placeholder) return;
    if (av) { img.src = av; img.style.display = 'block'; placeholder.style.display = 'none'; }
    else { img.style.display = 'none'; placeholder.style.display = 'flex'; }
  }

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
      if (statusEl) {
        statusEl.textContent = '🎭 RP进行中';
        if (badge) { statusEl.appendChild(badge); badge.classList.remove('show'); }
      }
    } else {
      getAiAvatar().then(av => {
        if (headerAv) headerAv.src = av;
        if (typingAv) typingAv.src = av;
      });
      if (headerNm) headerNm.textContent = (typeof settings !== 'undefined' && settings.aiName) || '炘也';
      if (typeof window.updateHeaderStatus === 'function') window.updateHeaderStatus();
    }
  }

  window.syncRpHeader = function() {
    if (rpActive) applyRpHeader();
  };

  window.getEffectiveAiAvatar = async function() {
    if (rpActive) {
      const av = localStorage.getItem('rp_char_avatar');
      if (av) return av;
    }
    return getAiAvatar();
  };

  window.getEffectiveUserAvatar = async function() {
    if (rpActive) {
      const av = localStorage.getItem('rp_user_avatar');
      if (av) return av;
    }
    return getUserAvatar();
  };

  window.getRpUserName = function() {
    return rpActive ? (localStorage.getItem('rp_user_name') || '') : '';
  };

  window.openRpPanel = function() {
    const panel = document.getElementById('rpPanel');
    panel.classList.add('show');
    document.getElementById('rpPromptInput').focus();
  };

  window.closeRpPanel = function() {
    document.getElementById('rpPanel').classList.remove('show');
  };

  window.toggleRpActive = async function() {
    rpActive = !rpActive;
    localStorage.setItem('rp_active', rpActive ? '1' : '0');
    lsBackup('rp_active', rpActive ? '1' : '0');
    window._rpActive = rpActive;
    applyRpUI();
    toast(rpActive ? '🎭 RP模式已开启，对话已隔离' : '🎭 RP模式已关闭，恢复正常聊天');
    await switchRpMode(rpActive);
  };

  window.saveRpPrompt = function() {
    const val = document.getElementById('rpPromptInput').value;
    localStorage.setItem('rp_prompt', val);
    lsBackup('rp_prompt', val);
  };

  window.saveRpPreset = function() {
    const text = document.getElementById('rpPromptInput').value.trim();
    if (!text) { toast('先写点RP设定再保存'); return; }
    const nameInput = document.getElementById('rpPresetNameInput');
    const name = (nameInput?.value || '').trim();
    if (!name) { toast('请先填写预设名称'); nameInput?.focus(); return; }
    const charName = document.getElementById('rpCharName')?.value || '';
    const userName = document.getElementById('rpUserName')?.value || '';
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

  window.loadRpPreset = function() {
    const sel = document.getElementById('rpPresetSelect');
    const idx = parseInt(sel.value);
    if (isNaN(idx) || idx < 0) return;
    const p = rpPresets[idx];
    if (!p) return;
    document.getElementById('rpPromptInput').value = p.text;
    localStorage.setItem('rp_prompt', p.text);
    lsBackup('rp_prompt', p.text);
    const nameInput = document.getElementById('rpCharName');
    if (nameInput) nameInput.value = p.charName || '';
    localStorage.setItem('rp_char_name', p.charName || '');
    lsBackup('rp_char_name', p.charName || '');
    const userNameInput2 = document.getElementById('rpUserName');
    if (userNameInput2) userNameInput2.value = p.userName || '';
    localStorage.setItem('rp_user_name', p.userName || '');
    lsBackup('rp_user_name', p.userName || '');
    refreshRpCharAvatar();
    refreshRpUserAvatar();
    if (rpActive) applyRpHeader();
  };

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

  function refreshRpPresetSelect() {
    const sel = document.getElementById('rpPresetSelect');
    if (!sel) return;
    sel.innerHTML = '<option value="">— 选择保存的预设 —</option>' +
      rpPresets.map((p, i) => `<option value="${i}">${p.name}</option>`).join('');
  }

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

  window.getRpInjection = function() {
    if (!rpActive) return null;
    const prompt = localStorage.getItem('rp_prompt') || '';
    return prompt.trim() || '【RP模式】';
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', rpInit);
  } else {
    rpInit();
  }
}
