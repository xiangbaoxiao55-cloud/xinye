import { settings } from './state.js';
import { toast } from './utils.js';
import { lsBackup } from './db.js';
const _PFX = window.__APP_ID__ === 'choubao' ? 'choubao_' : '';

export function getApiPresets() {
  try { return JSON.parse(localStorage.getItem(_PFX + 'xinye_api_presets') || '[]'); } catch(e) { return []; }
}
export function setApiPresets(arr) {
  const _v = JSON.stringify(arr);
  localStorage.setItem(_PFX + 'xinye_api_presets', _v);
  lsBackup(_PFX + 'xinye_api_presets', _v);
}

export function getVisionPresets() {
  try { return JSON.parse(localStorage.getItem(_PFX + 'xinye_vision_presets') || '[]'); } catch(e) { return []; }
}
export function setVisionPresets(arr) {
  const _v = JSON.stringify(arr);
  localStorage.setItem(_PFX + 'xinye_vision_presets', _v);
  lsBackup(_PFX + 'xinye_vision_presets', _v);
}
export function getImagePresets() {
  try { return JSON.parse(localStorage.getItem(_PFX + 'xinye_image_presets') || '[]'); } catch(e) { return []; }
}
export function setImagePresets(arr) {
  const _v = JSON.stringify(arr);
  localStorage.setItem(_PFX + 'xinye_image_presets', _v);
  lsBackup(_PFX + 'xinye_image_presets', _v);
}

export function getSubApiCfg() {
  return {
    apiKey:  settings.subApiKey  || settings.apiKey,
    baseUrl: settings.subBaseUrl || settings.baseUrl,
    model:   settings.subModel   || settings.model,
  };
}

export async function mainApiFetch(bodyWithoutModel) {
  const _fbPresets = (settings.fallbackPresetNames || [])
    .map(n => getApiPresets().find(p => p.name === n)).filter(Boolean);
  const _allCfgs = [null, ..._fbPresets];
  function _buildCfg(preset) {
    if (preset) {
      const raw = (preset.baseUrl || 'https://api.openai.com').replace(/\/+$/, '');
      return { url: /\/v\d+$/.test(raw) ? `${raw}/chat/completions` : `${raw}/v1/chat/completions`, apiKey: preset.apiKey || settings.apiKey, model: preset.model || settings.model };
    }
    const raw = (settings.baseUrl || 'https://api.openai.com').replace(/\/+$/, '');
    return { url: /\/v\d+$/.test(raw) ? `${raw}/chat/completions` : `${raw}/v1/chat/completions`, apiKey: settings.apiKey, model: settings.model };
  }
  let _res;
  for (let pi = 0; pi < _allCfgs.length; pi++) {
    const cfg = _buildCfg(_allCfgs[pi]);
    const bodyStr = JSON.stringify({ ...bodyWithoutModel, model: cfg.model });
    for (let _a = 0; _a < 2; _a++) {
      if (_a > 0) await new Promise(r => setTimeout(r, 4000));
      try {
        const ctrl = new AbortController();
        const tid = setTimeout(() => ctrl.abort(), 120000);
        _res = await fetch(cfg.url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${cfg.apiKey}` }, body: bodyStr, signal: ctrl.signal });
        clearTimeout(tid);
        if (_res.ok) {
          if (pi > 0) toast(`🔄 主API已切换到备用${pi}「${_fbPresets[pi-1].name}」`);
          return _res;
        }
      } catch(e) { _res = null; }
    }
    if (pi + 1 < _allCfgs.length) toast(`主API无响应，尝试备用${pi+1}「${_fbPresets[pi].name}」…`);
  }
  return _res;
}

export async function subApiFetch(bodyWithoutModel, defaultModel = 'gpt-4o') {
  const sub = getSubApiCfg();
  const _subFbPresets = (settings.subFallbackPresetNames || [])
    .map(n => getApiPresets().find(p => p.name === n)).filter(Boolean);
  const _subAllCfgs = [null, ..._subFbPresets];
  function _buildSubCfg(preset) {
    if (preset) {
      const raw = (preset.baseUrl || 'https://api.openai.com').replace(/\/+$/, '');
      return { url: /\/v\d+$/.test(raw) ? `${raw}/chat/completions` : `${raw}/v1/chat/completions`, apiKey: preset.apiKey || sub.apiKey, model: preset.model || sub.model || defaultModel };
    }
    const raw = (sub.baseUrl || 'https://api.openai.com').replace(/\/+$/, '');
    return { url: /\/v\d+$/.test(raw) ? `${raw}/chat/completions` : `${raw}/v1/chat/completions`, apiKey: sub.apiKey, model: sub.model || defaultModel };
  }
  let _res;
  for (let pi = 0; pi < _subAllCfgs.length; pi++) {
    const cfg = _buildSubCfg(_subAllCfgs[pi]);
    const bodyStr = JSON.stringify({ ...bodyWithoutModel, model: cfg.model });
    for (let _a = 0; _a < 2; _a++) {
      if (_a > 0) await new Promise(r => setTimeout(r, 4000));
      try {
        const ctrl = new AbortController();
        const tid = setTimeout(() => ctrl.abort(), 60000);
        _res = await fetch(cfg.url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${cfg.apiKey}` }, body: bodyStr, signal: ctrl.signal });
        clearTimeout(tid);
        if (_res.ok) {
          if (pi > 0) toast(`🔄 副API已切换到备用${pi}「${_subFbPresets[pi-1].name}」`);
          return _res;
        }
      } catch(e) { _res = null; }
    }
    if (pi + 1 < _subAllCfgs.length) toast(`副API无响应，尝试备用${pi+1}「${_subFbPresets[pi].name}」…`);
  }
  return _res;
}
