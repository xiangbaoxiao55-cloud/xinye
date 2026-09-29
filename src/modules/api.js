import { settings } from './state.js';
import { getCloudOrLocalUrl, buildServerFetchUrl, buildServerHeaders } from './settings.js';
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

/**
 * 按「配置三要素」反查这条配置对应预设列表里的哪一条 —— 气泡底部那个预设名标签用。
 *
 * 2026-09-29：原来这段反查在 chat.js 里写了两份（`_apiFetch` 一份、
 * `regenerateLastAI` 一份），而后者干脆**不用它**、直接写死"当前主预设"，
 * 于是切到备用预设后气泡还挂着主预设名（她报的「实际走了 passion、气泡写 AIPM」）。
 * 抽出来一份，三处（主/副/重生成）共用。
 *
 * 找不到就退回模型名 —— 空标签比一个模型名更没用（她要的就是"这条是谁生成的"）。
 */
export function presetNameFor(cfg) {
  const { apiKey, baseUrl, model } = cfg || {};
  const hit = getApiPresets().find(p => p.apiKey === apiKey && p.baseUrl === baseUrl && p.model === model);
  return hit?.name || model || '';
}

export async function mainApiFetch(bodyWithoutModel) {
  const _fbPresets = (settings.fallbackPresetNames || [])
    .map(n => getApiPresets().find(p => p.name === n)).filter(Boolean);
  const _allCfgs = [null, ..._fbPresets];
  // 主配置（_allCfgs[0]）本身没有名字，反查它对应预设列表里的哪一条。
  // 2026-09-29：返回时挂在 res.__usedPresetName 上 —— 调用方要拿它写气泡底部那个标签，
  // 不能再自己猜"当前主预设"（那样切到备用后标签还是错的）。
  const _mainPresetName = presetNameFor({ apiKey: settings.apiKey, baseUrl: settings.baseUrl, model: settings.model });
  // ⚠️ 备用预设没填名字时退回它自己的 model —— 绝不能掉进主预设名（那正是这个 bug 的成因）
  const _usedName = (pi) => pi > 0 ? (_allCfgs[pi]?.name || _allCfgs[pi]?.model || '') : _mainPresetName;
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
    if (cfg.useLocalProxy) {
      const _srv = getCloudOrLocalUrl();
      if (_srv) {
        const h = { 'Content-Type': 'application/json', 'X-Real-Target': cfg.url, 'X-Real-Key': cfg.apiKey };
        return { url: buildServerFetchUrl(_srv, '/api/llm-proxy'), headers: buildServerHeaders(_srv, h) };
      }
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
        try {
          _res = await fetch(_fa.url, { method: 'POST', headers: _fa.headers, body: bodyStr, signal: ctrl.signal });
        } catch(_directErr) {
          if (_directErr.name !== 'AbortError' && !cfg.useLocalProxy) {
            const _srv = getCloudOrLocalUrl();
            if (_srv) {
              console.log(`[mainApiFetch] 直连失败(${_directErr.message})，走${_srv.token ? '云' : '本地'}代理重试`);
              const _proxyH = { 'Content-Type': 'application/json', 'X-Real-Target': _fa.url, 'X-Real-Key': cfg.apiKey };
              _res = await fetch(buildServerFetchUrl(_srv, '/api/llm-proxy'), { method: 'POST', headers: buildServerHeaders(_srv, _proxyH), body: bodyStr, signal: ctrl.signal });
            } else { throw _directErr; }
          } else { throw _directErr; }
        }
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
          _res.__usedPresetName = _usedName(pi);
          if (cfg.apiFormat === 'anthropic' && bodyWithoutModel.stream === false) {
            const _origJson = await _res.json();
            const _converted = anthropicToOpenAIResponse(_origJson);
            _res = { ok: true, status: 200, json: async () => _converted, __apiFormat: 'anthropic', __usedPresetName: _usedName(pi) };
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
  // 同 mainApiFetch：副 API 也有自己的主配置 + 备用列表，气泡标签要用**实际生效**那条。
  const _subMainName = presetNameFor({ apiKey: sub.apiKey, baseUrl: sub.baseUrl, model: sub.model || defaultModel });
  const _subUsedName = (pi) => pi > 0 ? (_subAllCfgs[pi]?.name || '') : _subMainName;
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
        try {
          _res = await fetch(cfg.url, { method: 'POST', headers, body: bodyStr, signal: ctrl.signal });
        } catch(_directErr) {
          if (_directErr.name !== 'AbortError') {
            const _srv = getCloudOrLocalUrl();
            if (_srv) {
              console.log(`[subApiFetch] 直连失败(${_directErr.message})，走${_srv.token ? '云' : '本地'}代理重试`);
              const _proxyH = { 'Content-Type': 'application/json', 'X-Real-Target': cfg.url, 'X-Real-Key': cfg.apiKey };
              _res = await fetch(buildServerFetchUrl(_srv, '/api/llm-proxy'), { method: 'POST', headers: buildServerHeaders(_srv, _proxyH), body: bodyStr, signal: ctrl.signal });
            } else { throw _directErr; }
          } else { throw _directErr; }
        }
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
          _res.__usedPresetName = _subUsedName(pi);
          if (cfg.apiFormat === 'anthropic' && bodyWithoutModel.stream === false) {
            const _origJson = await _res.json();
            const _converted = anthropicToOpenAIResponse(_origJson);
            _res = { ok: true, status: 200, json: async () => _converted, __apiFormat: 'anthropic', __usedPresetName: _subUsedName(pi) };
          }
          return _res;
        }
      } catch(e) { _res = null; }
    }
    if (pi + 1 < _subAllCfgs.length) toast(`副API无响应，尝试备用${pi+1}「${_subFbPresets[pi].name}」…`);
  }
  return _res;
}
