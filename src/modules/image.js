import { toast } from './utils.js';
import { settings, messages } from './state.js';
import { dbPut, dbGet } from './db.js';
import { addMessage, appendMsgDOM, scrollBottom, activeStore } from './chat.js';
import { resetIdleTimer } from './notifications.js';
import { getImagePresets, getImageCurPresetIdx } from './api.js';

export async function autoSaveGenImage(dataUrl, msgId) {
  const _imgLabel = window.__APP_ID__ === 'choubao' ? '臭宝画的图' : '炘也画的图';
  const filename = `${_imgLabel}_${msgId}.png`;
  try {
    let b64, blob;
    if (dataUrl.startsWith('data:')) {
      b64 = dataUrl.split(',')[1];
      const mime = dataUrl.match(/:(.*?);/)?.[1] || 'image/png';
      const u8 = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
      blob = new Blob([u8], { type: mime });
    } else {
      try {
        const resp = await fetch(dataUrl);
        blob = await resp.blob();
        b64 = await new Promise(r => {
          const fr = new FileReader();
          fr.onload = () => r(fr.result.split(',')[1]);
          fr.readAsDataURL(blob);
        });
      } catch {
        toast('🎨 图片已生成，长按图片可保存');
        return;
      }
    }

    if (window.AndroidDownload) {
      window.AndroidDownload.downloadFile(filename, blob.type || 'image/png', b64);
      toast('🎨 图片已保存到手机 Download');
    } else {
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

export function triggerDrawImage() {
  const userInput = document.getElementById('userInput');
  const desc = userInput ? userInput.value.trim() : '';
  if (!desc) { toast('在输入框写想画什么，再点🎨~'); return; }
  generateImage(desc);
}

export function base64ToFile(dataUrl, filename) {
  const arr = dataUrl.split(',');
  const mime = arr[0].match(/:(.*?);/)[1] || 'image/png';
  const bstr = atob(arr[1]);
  const u8arr = new Uint8Array(bstr.length);
  for (let i = 0; i < bstr.length; i++) u8arr[i] = bstr.charCodeAt(i);
  return new File([u8arr], filename, { type: mime });
}

export async function compositeRefImages(dataUrls) {
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

export async function generateImage(userDesc, opts = {}) {
  if (!settings.apiKey) { toast('请先设置 API Key'); return; }
  if (window.isRequesting) return;

  const userInput = document.getElementById('userInput');
  const btnSend = document.getElementById('btnSend');
  const typing = document.getElementById('typingIndicator');
  const imgPreview = document.getElementById('imgPreview');

  const refImgs = [...window.pendingImages];
  if (opts.refChars && opts.refChars !== 'none') {
    const _aiRef = await dbGet('images', 'aiRef').catch(() => null);
    const _userRef = await dbGet('images', 'userRef').catch(() => null);
    if ((opts.refChars === 'ai' || opts.refChars === 'both') && _aiRef) refImgs.push(_aiRef);
    if ((opts.refChars === 'user' || opts.refChars === 'both') && _userRef) refImgs.push(_userRef);
  }
  if (opts.styleRef) {
    const _srMeta = (await dbGet('settings', 'styleRefs').catch(() => null)) || [];
    const _srEntry = _srMeta.find(s => s.name === opts.styleRef);
    if (_srEntry) {
      const _srImg = await dbGet('images', _srEntry.imgKey).catch(() => null);
      if (_srImg) refImgs.push(_srImg);
    }
  }
  if (userInput) userInput.value = '';
  if (typeof window.autoResize === 'function') window.autoResize();
  window.pendingImages = [];
  if (imgPreview) imgPreview.classList.remove('show');
  resetIdleTimer();

  const userMsg = await addMessage('user', userDesc, refImgs.length ? refImgs : null);
  await appendMsgDOM(userMsg);

  window.isRequesting = true;
  if (btnSend) btnSend.disabled = true;
  if (typing) typing.classList.add('show');
  scrollBottom();

  const hasRef = refImgs.length > 0;
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), 600000);

  try {
    const prompt = userDesc;
    console.log('[画图] 模式:', hasRef ? '垫图/改图' : '生成', 'prompt:', prompt);

    const _aiN = settings.aiName || '炘也';
    toast(hasRef ? `${_aiN}正在改图...` : `${_aiN}正在画...`);

    // 构建预设列表，失败时自动轮询
    const _rawPresets = getImagePresets();
    const _activeIdx = getImageCurPresetIdx();
    let _cfgs;
    if (_rawPresets.length > 0) {
      _cfgs = [];
      for (let _i = 0; _i < _rawPresets.length; _i++) {
        const _p = _rawPresets[(_activeIdx + _i) % _rawPresets.length];
        if (!_p.skip) _cfgs.push(_p);
      }
      if (_cfgs.length === 0) throw new Error('所有画图预设都标为跳过，请在设置里取消至少一个');
    } else {
      _cfgs = [null]; // 无预设时用 settings 全局配置
    }

    let dataUrl = null;
    let _lastErr;

    const _ts = () => new Date().toTimeString().slice(0,8);

    presetLoop: for (let _pi = 0; _pi < _cfgs.length; _pi++) {
      const _preset = _cfgs[_pi];
      const _presetName = _preset?.name || '默认配置';
      const imgKey = _preset?.apiKey || settings.imageApiKey || settings.apiKey;
      const raw = (_preset?.baseUrl || settings.imageBaseUrl || settings.baseUrl || 'https://api.openai.com').replace(/\/+$/, '');
      const imgModel = _preset?.model || settings.imageModel || 'gpt-image-1';
      const imgFmt = _preset?.apiFormat || settings.imageApiFormat || 'images';

      try {
        let imgRes;
        const genEndpoint = /\/v\d+$/.test(raw) ? `${raw}/images/generations` : `${raw}/v1/images/generations`;
        const _mode = hasRef ? 'edits' : (imgFmt === 'chat' ? 'chat' : 'generations');
        console.log(`[${_ts()}] → ${_mode} | ${_presetName} | ${settings.imageSize||'1024x1024'} | ${raw}\n         prompt: ${prompt.slice(0,80)}`);
        const localUrl = (settings.imageProxyUrl || settings.solitudeServerUrl || '').trim();
        if (hasRef) {
          const baseRaw = /\/v\d+$/.test(raw) ? raw : `${raw}/v1`;
          const editsEndpoint = `${baseRaw}/images/edits`;
          const _makeEditsForm = () => {
            const f = new FormData();
            f.append('model', imgModel); f.append('prompt', prompt);
            f.append('n', '1'); f.append('size', settings.imageSize || '1024x1024');
            f.append('response_format', 'url');
            refImgs.forEach((img, i) => f.append('image[]', base64ToFile(img, `ref${i}.png`)));
            return f;
          };
          if (localUrl) {
            const _editsH = { 'X-Api-Url': editsEndpoint, 'X-Api-Key': imgKey };
            if (settings.imageProxyToken) _editsH['Authorization'] = `Bearer ${settings.imageProxyToken}`;
            let _proxyHttpErr = false;
            try {
              const _pR = await fetch(`${localUrl}/api/proxy-image-edits`, {
                method: 'POST', headers: _editsH, body: _makeEditsForm(), signal: ctrl.signal
              });
              if (!_pR.ok) { _proxyHttpErr = true; throw new Error(`proxy ${_pR.status}`); }
              imgRes = _pR;
            } catch(proxyErr) {
              if (proxyErr.name === 'AbortError') throw proxyErr;
              if (_proxyHttpErr) throw proxyErr;
              const _isCloudProxy = !!(settings.imageProxyUrl || '').trim();
              if (!_isCloudProxy) throw new Error('代理连不上（手机不在家庭网络）\n手机垫图请在设置→画图代理地址填 cpolar 地址');
              imgRes = await fetch(editsEndpoint, {
                method: 'POST', headers: { 'Authorization': `Bearer ${imgKey}` },
                body: _makeEditsForm(), signal: ctrl.signal
              });
            }
          } else {
            const form = new FormData();
            form.append('model', imgModel);
            form.append('prompt', prompt);
            form.append('n', '1');
            form.append('size', settings.imageSize || '1024x1024');
            refImgs.forEach((img, i) => form.append('image[]', base64ToFile(img, `ref${i}.png`)));
            imgRes = await fetch(editsEndpoint, {
              method: 'POST',
              headers: { 'Authorization': `Bearer ${imgKey}` },
              body: form,
              signal: ctrl.signal
            });
          }
          if (imgRes.status === 404 || imgRes.status === 502 || imgRes.status >= 500) {
            throw new Error(`当前画图API不支持垫图改图功能（/images/edits ${imgRes.status}）\n可在设置→画图API中配置支持edits的接口（如直连OpenAI），或去掉垫图直接生成`);
          }
        } else {
          if (localUrl) {
            const _genH = { 'Content-Type': 'application/json' };
            if (settings.imageProxyToken) _genH['Authorization'] = `Bearer ${settings.imageProxyToken}`;
            try {
              imgRes = await fetch(`${localUrl}/api/proxy-image-generations`, {
                method: 'POST', headers: _genH,
                body: JSON.stringify({ apiUrl: genEndpoint, apiKey: imgKey, model: imgModel, prompt, size: settings.imageSize || '1024x1024', response_format: 'url', api_format: imgFmt }),
                signal: ctrl.signal
              });
            } catch(proxyErr) {
              imgRes = await fetch(genEndpoint, {
                method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${imgKey}` },
                body: JSON.stringify({ model: imgModel, prompt, n: 1, size: settings.imageSize || '1024x1024', response_format: 'url' }),
                signal: ctrl.signal
              });
            }
          } else {
            imgRes = await fetch(genEndpoint, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${imgKey}` },
              body: JSON.stringify({ model: imgModel, prompt, n: 1, size: settings.imageSize || '1024x1024', response_format: 'url' }),
              signal: ctrl.signal
            });
          }
        }

        if (!imgRes.ok) {
          const errData = await imgRes.json().catch(() => ({}));
          const errMsg = errData.error?.message || '';
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
        console.log('[画图v2] API返回类型:', typeof imgData, '键:', typeof imgData==='object'?Object.keys(imgData||{}).join(','):'(string)', '长度:', JSON.stringify(imgData).length);
        const _b64 = (s) => { s = s.replace(/[\s\r\n]/g,''); return s.startsWith('data:') ? s : `data:image/png;base64,${s}`; };
        const _parseImg = (d) => {
          const item = d.data?.[0] || d.images?.[0];
          if (item?.b64_json) return _b64(item.b64_json);
          if (item?.url) return item.url;
          if (d.b64_json) return _b64(d.b64_json);
          if (d.url && typeof d.url === 'string') return d.url;
          if (d.image) { const v = d.image; return /^(data:|https?:)/.test(v) ? v : _b64(v); }
          if (d.artifacts?.[0]?.base64) return _b64(d.artifacts[0].base64);
          if (typeof d.data === 'string' && d.data.length > 100) { return /^(data:|https?:)/.test(d.data) ? d.data : _b64(d.data); }
          if (typeof d === 'string' && d.length > 100) { return /^(data:|https?:)/.test(d) ? d : _b64(d); }
          return null;
        };
        let _parsedUrl = _parseImg(imgData);
        console.log('[画图v2] 解析结果:', _parsedUrl ? _parsedUrl.slice(0,60)+'...' : 'null');
        if (_parsedUrl && _parsedUrl.startsWith('http')) {
          const _urlToB64 = async (fetchUrl) => {
            const _ur = await fetch(fetchUrl);
            if (!_ur.ok) throw new Error(`HTTP ${_ur.status}`);
            const _ub = await _ur.blob();
            return new Promise(r => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(_ub); });
          };
          try {
            _parsedUrl = await _urlToB64(_parsedUrl);
            console.log('[画图v2] URL已转base64存储');
          } catch(_ue) {
            console.warn('[画图v2] 直接fetch失败，尝试代理下载:', _ue.message);
            const _lUrl = (settings.imageProxyUrl || settings.solitudeServerUrl || '').trim();
            let _proxyOk = false;
            if (_lUrl) {
              try {
                const _proxyUrl = `${_lUrl}/api/proxy-fetch?url=${encodeURIComponent(_parsedUrl)}`;
                _parsedUrl = await _urlToB64(_proxyUrl);
                console.log('[画图v2] 代理URL已转base64存储');
                _proxyOk = true;
              } catch(_pe) { console.warn('[画图v2] 本地代理失败，尝试Vercel代理:', _pe.message); }
            }
            if (!_proxyOk) {
              try {
                const _vercelProxy = `/api/img-proxy?url=${encodeURIComponent(_parsedUrl)}`;
                _parsedUrl = await _urlToB64(_vercelProxy);
                console.log('[画图v2] Vercel代理已转base64存储');
              } catch(_ve) {
                console.warn('[画图v2] 所有代理均失败，改存origUrl供手动打开:', _ve.message);
                toast('图片无法内嵌显示，气泡里有链接可点击打开');
                _parsedUrl = '__HTTP_URL__:' + _parsedUrl;
              }
            }
          }
        }
        if (!_parsedUrl) {
          console.log('[画图v2] 完整返回:', JSON.stringify(imgData).slice(0, 500));
          throw new Error('画图API没返回图片，vConsole查看完整返回');
        }
        dataUrl = _parsedUrl;
        console.log(`[${_ts()}] ✓ 出图 | ${_presetName} | ${dataUrl.slice(0,40)}...`);
        break presetLoop;

      } catch(e) {
        if (e.name === 'AbortError') throw e;
        _lastErr = e;
        console.warn(`[${_ts()}] ✗ 失败 | ${_presetName} | ${e.message}`);
        if (_pi < _cfgs.length - 1) {
          const _nextName = _cfgs[_pi + 1]?.name;
          toast(`${_presetName}失败，切换${_nextName ? '「' + _nextName + '」' : '下一个'}...`);
          console.log(`[${_ts()}] → 切换到 ${_nextName || '下一个预设'}`);
        }
      }
    } // end presetLoop

    if (!dataUrl) throw _lastErr || new Error('所有画图预设均失败');

    const ctxDesc = `[🎨 ${settings.aiName||'炘也'}${hasRef ? '根据垫图' : ''}给你画了一张图]\n你说：${userDesc}\n提示词：${prompt}`;
    const aiMsg = await addMessage('assistant', ctxDesc);
    aiMsg.isGenImage = true;
    aiMsg.genImageData = dataUrl;
    if (opts.refChars) aiMsg.genRefChars = opts.refChars;
    if (opts.styleRef) aiMsg.genStyleRef = opts.styleRef;
    await dbPut(activeStore(), null, aiMsg);
    const _idx = messages.findIndex(m => m.id === aiMsg.id);
    if (_idx >= 0) messages[_idx] = aiMsg;

    await appendMsgDOM(aiMsg);
    autoSaveGenImage(dataUrl, aiMsg.id);

  } catch(e) {
    if (e.name === 'AbortError') {
      toast('画图超时了...');
    } else {
      toast('画图失败：' + e.message);
      console.error('[画图] 失败', e);
    }
  } finally {
    clearTimeout(tid);
    if (typing) typing.classList.remove('show');
    window.isRequesting = false;
    if (btnSend && userInput) btnSend.disabled = userInput.value.trim() === '';
  }
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

function renderImgPreviews() {
  const preview = document.getElementById('imgPreview');
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

export function initImageUpload() {
  window.pendingImages = [];
  document.getElementById('btnImg').onclick = () => document.getElementById('fileInputChatImg').click();
  document.getElementById('fileInputChatImg').onchange = async function() {
    if (!this.files.length) return;
    for (const file of this.files) { window.pendingImages.push(await compressImageToBase64(file)); }
    renderImgPreviews();
    this.value = '';
  };
}
