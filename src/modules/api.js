import { settings } from './state.js';
import { toast } from './utils.js';
import { lsBackup } from './db.js';
import { convertRequestBody, buildEndpointUrl, buildAnthropicHeaders, anthropicToOpenAIResponse } from './anthropic.js';
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
export function getImageCurPresetIdx() {
  return parseInt(localStorage.getItem(_PFX + 'xinye_image_cur_preset') || '0') || 0;
}
export function setImageCurPresetIdx(idx) {
  localStorage.setItem(_PFX + 'xinye_image_cur_preset', String(idx));
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
      const fmt = preset.apiFormat || 'openai';
      const pUrl = fmt === 'anthropic' ? buildEndpointUrl(raw) : (/\/v\d+$/.test(raw) ? `${raw}/chat/completions` : `${raw}/v1/chat/completions`);
      return { url: pUrl, apiKey: preset.apiKey || settings.apiKey, model: preset.model || settings.model, useLocalProxy: !!preset.useLocalProxy, apiFormat: fmt };
    }
    const raw = (settings.baseUrl || 'https://api.openai.com').replace(/\/+$/, '');
    const fmt = settings.apiFormat || 'openai';
    const pUrl = fmt === 'anthropic' ? buildEndpointUrl(raw) : (/\/v\d+$/.test(raw) ? `${raw}/chat/completions` : `${raw}/v1/chat/completions`);
    return { url: pUrl, apiKey: settings.apiKey, model: settings.model, useLocalProxy: !!settings.useLocalProxy, apiFormat: fmt };
  }
  function _buildFetchArgs(cfg) {
    if (cfg.useLocalProxy && settings.solitudeServerUrl) {
      const proxyBase = settings.solitudeServerUrl.replace(/\/+$/, '');
      return { url: `${proxyBase}/api/llm-proxy`, headers: { 'Content-Type': 'application/json', 'X-Real-Target': cfg.url, 'X-Real-Key': cfg.apiKey } };
    }
    if (cfg.apiFormat === 'anthropic') {
      return { url: cfg.url, headers: buildAnthropicHeaders(cfg.apiKey) };
    }
    return { url: cfg.url, headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${cfg.apiKey}` } };
  }
  let _res;
  mainLoop: for (let pi = 0; pi < _allCfgs.length; pi++) {
    const cfg = _buildCfg(_allCfgs[pi]);
    let bodyStr;
    if (cfg.apiFormat === 'anthropic') {
      bodyStr = JSON.stringify(convertRequestBody({ ...bodyWithoutModel, model: cfg.model }));
    } else {
      bodyStr = JSON.stringify({ ...bodyWithoutModel, model: cfg.model });
    }
    for (let _a = 0; _a < 2; _a++) {
      if (_a > 0) await new Promise(r => setTimeout(r, 4000));
      try {
        const ctrl = new AbortController();
        const tid = setTimeout(() => ctrl.abort(), 120000);
        const _fa = _buildFetchArgs(cfg);
        _res = await fetch(_fa.url, { method: 'POST', headers: _fa.headers, body: bodyStr, signal: ctrl.signal });
        clearTimeout(tid);
        if (_res.ok) {
          if (_res.body) {
            const [_es1, _es2] = _res.body.tee();
            const _er = _es1.getReader();
            const { value: _ev } = await _er.read();
            _er.cancel();
            if (/\[Backend Error\]/i.test(new TextDecoder().decode(_ev || new Uint8Array()))) {
              _es2.cancel().catch(() => {});
              if (pi + 1 < _allCfgs.length) toast(`主API返回错误，尝试备用${pi+1}「${_fbPresets[pi].name}」…`);
              _res = null; continue mainLoop;
            }
            _res = new Response(_es2, { status: _res.status, statusText: _res.statusText, headers: _res.headers });
          }
          if (pi > 0) toast(`🔄 主API已切换到备用${pi}「${_fbPresets[pi-1].name}」`);
          _res.__apiFormat = cfg.apiFormat;
          if (cfg.apiFormat === 'anthropic' && bodyWithoutModel.stream === false) {
            const _origJson = await _res.json();
            const _converted = anthropicToOpenAIResponse(_origJson);
            _res = { ok: true, status: 200, json: async () => _converted, __apiFormat: 'anthropic' };
          }
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
      const fmt = preset.apiFormat || 'openai';
      const pUrl = fmt === 'anthropic' ? buildEndpointUrl(raw) : (/\/v\d+$/.test(raw) ? `${raw}/chat/completions` : `${raw}/v1/chat/completions`);
      return { url: pUrl, apiKey: preset.apiKey || sub.apiKey, model: preset.model || sub.model || defaultModel, apiFormat: fmt };
    }
    const raw = (sub.baseUrl || 'https://api.openai.com').replace(/\/+$/, '');
    return { url: /\/v\d+$/.test(raw) ? `${raw}/chat/completions` : `${raw}/v1/chat/completions`, apiKey: sub.apiKey, model: sub.model || defaultModel, apiFormat: 'openai' };
  }
  let _res;
  subLoop: for (let pi = 0; pi < _subAllCfgs.length; pi++) {
    const cfg = _buildSubCfg(_subAllCfgs[pi]);
    let bodyStr;
    if (cfg.apiFormat === 'anthropic') {
      bodyStr = JSON.stringify(convertRequestBody({ ...bodyWithoutModel, model: cfg.model }));
    } else {
      bodyStr = JSON.stringify({ ...bodyWithoutModel, model: cfg.model });
    }
    const headers = cfg.apiFormat === 'anthropic'
      ? buildAnthropicHeaders(cfg.apiKey)
      : { 'Content-Type': 'application/json', 'Authorization': `Bearer ${cfg.apiKey}` };
    for (let _a = 0; _a < 2; _a++) {
      if (_a > 0) await new Promise(r => setTimeout(r, 4000));
      try {
        const ctrl = new AbortController();
        const tid = setTimeout(() => ctrl.abort(), 60000);
        _res = await fetch(cfg.url, { method: 'POST', headers, body: bodyStr, signal: ctrl.signal });
        clearTimeout(tid);
        if (_res.ok) {
          if (_res.body) {
            const [_ss1, _ss2] = _res.body.tee();
            const _sr = _ss1.getReader();
            const { value: _sv } = await _sr.read();
            _sr.cancel();
            if (/\[Backend Error\]/i.test(new TextDecoder().decode(_sv || new Uint8Array()))) {
              _ss2.cancel().catch(() => {});
              if (pi + 1 < _subAllCfgs.length) toast(`副API返回错误，尝试备用${pi+1}「${_subFbPresets[pi].name}」…`);
              _res = null; continue subLoop;
            }
            _res = new Response(_ss2, { status: _res.status, statusText: _res.statusText, headers: _res.headers });
          }
          if (pi > 0) toast(`🔄 副API已切换到备用${pi}「${_subFbPresets[pi-1].name}」`);
          _res.__apiFormat = cfg.apiFormat;
          if (cfg.apiFormat === 'anthropic' && bodyWithoutModel.stream === false) {
            const _origJson = await _res.json();
            const _converted = anthropicToOpenAIResponse(_origJson);
            _res = { ok: true, status: 200, json: async () => _converted, __apiFormat: 'anthropic' };
          }
          return _res;
        }
      } catch(e) { _res = null; }
    }
    if (pi + 1 < _subAllCfgs.length) toast(`副API无响应，尝试备用${pi+1}「${_subFbPresets[pi].name}」…`);
  }
  return _res;
}
