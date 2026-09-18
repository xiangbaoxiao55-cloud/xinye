import { toast } from './utils.js';
import { settings, messages } from './state.js';
import { dbPut, dbGet } from './db.js';
import { addMessage, appendMsgDOM, scrollBottom, activeStore } from './chat.js';
import { resetIdleTimer } from './notifications.js';
import { getImagePresets, getImageCurPresetIdx } from './api.js';
import { pendAdd, pendSetUrl, pendDone, pendBump } from './pendingdraw.js';

/**
 * 把一个 http 图片链接下载成 base64 —— 三级兜底：直连 → 本地代理 → Vercel 代理。
 * 三个都失败就抛。
 *
 * 以前 generateImage / generateImageQuiet / 续账各抄一遍，2026-09-18 收成一份 ——
 * 收的时候才发现 generateImage 那份少了 `r.ok` 检查（404 也会被当成图片塞进 FileReader）。
 */
async function _httpToB64(fetchUrl) {
  const _lUrl = (settings.imageProxyUrl || settings.solitudeServerUrl || '').trim();
  const _toB64 = async (u) => {
    const r = await fetch(u);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const b = await r.blob();
    return new Promise(res => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(b); });
  };
  try { return await _toB64(fetchUrl); } catch (e1) { console.warn('[画图] 直连下载失败，试代理:', e1.message); }
  if (_lUrl) {
    try { return await _toB64(`${_lUrl}/api/proxy-fetch?url=${encodeURIComponent(fetchUrl)}`); }
    catch (e2) { console.warn('[画图] 本地代理下载失败，试中转:', e2.message); }
  }
  return await _toB64(`/api/img-proxy?url=${encodeURIComponent(fetchUrl)}`);
}

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

/**
 * 出图的收尾：落一条 AI 气泡、把图存进去。
 *
 * 正常画完、以及「续账时只把链接重新下载回来」两条路都走这一份 ——
 * 2026-09-18 从 generateImage 里抽出来的，为的是续账那条路不必重跑一遍画图逻辑。
 */
async function _saveGenBubble(dataUrl, { size, hasRef, prompt, userDesc, opts, jd }) {
  // opts.bubbleContent：让"后台自己画"那条路（主动消息配图）自己决定气泡上写什么。
  // 默认那句带「你说：…」，是给"她在聊天里点画图"用的 —— 别人用会变成她没说过的话。
  const ctxDesc = opts.bubbleContent
    || `[🎨 ${settings.aiName||'炘也'}${hasRef ? '根据垫图' : ''}给你画了一张图]\n你说：${userDesc}\n提示词：${prompt}`;
  const aiMsg = await addMessage('assistant', ctxDesc);
  aiMsg.isGenImage = true;
  aiMsg.genImageData = dataUrl;
  aiMsg.genSize = size;   // 记下来，气泡上的「重试」要按原尺寸重画
  if (opts.refChars) aiMsg.genRefChars = opts.refChars;
  if (opts.styleRef) aiMsg.genStyleRef = opts.styleRef;
  await dbPut(activeStore(), null, aiMsg);
  const _idx = messages.findIndex(m => m.id === aiMsg.id);
  if (_idx >= 0) messages[_idx] = aiMsg;
  await appendMsgDOM(aiMsg);
  // 后台自己画的（主动消息配图）不自动往她手机 Download 里塞 ——
  // 气泡上有「保存」，她想要自己点；不然 Downloads 会被动生成的图堆满
  if (!opts.skipAutoSave) autoSaveGenImage(dataUrl, aiMsg.id);
  pendDone(jd);   // 图真落进聊天了才算数
}

/**
 * 续账：启动时把上次没画完的「聊天里画图」接着做完。
 * 有链接就只重新下载（不再花画图的钱），没有才照原提示词重画一张。
 * ⚠️ _resume 让 generateImage 别再落一遍她说的话 —— 那句上次已经在聊天里了。
 */
export async function resumeChatDraw(job) {
  const _o = Object.assign({}, job.opts || {}, { _jd: job.id, _preUrl: job.url || '', _resume: true });
  await generateImage(job.prompt, _o);
}

export async function generateImage(userDesc, opts = {}) {
  if (!settings.apiKey) { toast('请先设置 API Key'); return; }
  // opts.background：气泡上的「重试」走这条 —— 图在后台跑，不锁输入框、不动她正在打的东西
  const _bg = !!opts.background;
  // opts._resume：续账来的（上次画到一半被刷新/闪退打断）——
  // 她说的话那一步上次已经落过聊天了，这里不能再落一遍
  if (!_bg && !opts._resume && window.isRequesting) return;

  const userInput = document.getElementById('userInput');
  const btnSend = document.getElementById('btnSend');
  const typing = document.getElementById('typingIndicator');
  const imgPreview = document.getElementById('imgPreview');

  const _size = opts.size || settings.imageSize || '1024x1024';
  // 记账：开工前先把「要画什么」落进账本 —— 中途被刷新 / 闪退 / 杀后台，启动时还找得回来。
  // 调用方自己记了账就沿用它的 id（比如主动消息配图，kind=proactive）
  const _jd = opts._jd || pendAdd({
    kind: 'chat', prompt: userDesc,
    opts: { size: _size, refChars: opts.refChars, styleRef: opts.styleRef,
            bubbleContent: opts.bubbleContent, background: _bg, skipAutoSave: opts.skipAutoSave },
  });
  // 后台重试不能用她此刻挂在输入框里的待发图，只用 opts 指定的参考图
  const refImgs = _bg ? [] : [...window.pendingImages];
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
  if (!_bg && !opts._resume) {
    // 只有「她主动要画」才动输入框、才把她的话落进聊天；后台重试不碰她在打的东西、也不伪造她说的话
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
  }

  const hasRef = refImgs.length > 0;
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), 600000);

  try {
    const prompt = userDesc;
    console.log('[画图] 模式:', hasRef ? '垫图/改图' : '生成', 'prompt:', prompt);

    const _aiN = settings.aiName || '炘也';
    toast(hasRef ? `${_aiN}正在改图...` : `${_aiN}正在画...`);

    // 续账：上次已经拿到图片链接、只是没下载完就被打断了 →
    // 只把链接重新下载一次，不重画（不重复花一次画图的钱）。下不回来才往下走重画。
    if (opts._preUrl) {
      try {
        const _d = await _httpToB64(opts._preUrl);
        await _saveGenBubble(_d, { size: _size, hasRef, prompt, userDesc, opts, jd: _jd });
        return;
      } catch (e) { console.warn('[画图] 上次存的链接已经下不回来了，重画一张:', e.message); }
    }

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
        console.log(`[${_ts()}] → ${_mode} | ${_presetName} | ${_size} | ${raw}\n         prompt: ${prompt.slice(0,80)}`);
        const localUrl = (settings.imageProxyUrl || settings.solitudeServerUrl || '').trim();
        if (hasRef) {
          const baseRaw = /\/v\d+$/.test(raw) ? raw : `${raw}/v1`;
          const editsEndpoint = `${baseRaw}/images/edits`;
          const _makeEditsForm = async () => {
            const f = new FormData();
            f.append('model', imgModel); f.append('prompt', prompt);
            f.append('n', '1'); f.append('size', _size);
            if (_preset?.singleImage && refImgs.length > 1) {
              const _imgs = await Promise.all(refImgs.map(b => new Promise((res, rej) => {
                const _i = new Image(); _i.onload = () => res(_i); _i.onerror = rej; _i.src = b;
              })));
              const _h = 512, _cv = document.createElement('canvas');
              let _x = 0;
              const _widths = _imgs.map(_i => Math.round(_i.width * _h / _i.height));
              _cv.width = _widths.reduce((a, b) => a + b, 0); _cv.height = _h;
              const _ctx = _cv.getContext('2d');
              _imgs.forEach((_i, _idx) => { _ctx.drawImage(_i, _x, 0, _widths[_idx], _h); _x += _widths[_idx]; });
              const _blob = await new Promise(res => _cv.toBlob(res, 'image/png'));
              f.append('image', _blob, 'ref.png');
            } else if (_preset?.singleImage) {
              const _blob = await fetch(refImgs[0]).then(r => r.blob());
              f.append('image', _blob, 'ref0.png');
            } else {
              refImgs.forEach((img, i) => f.append('image[]', base64ToFile(img, `ref${i}.png`)));
            }
            return f;
          };
          if (localUrl) {
            const _editsH = { 'X-Api-Url': editsEndpoint, 'X-Api-Key': imgKey };
            if (settings.imageProxyToken) _editsH['Authorization'] = `Bearer ${settings.imageProxyToken}`;
            let _proxyHttpErr = false;
            try {
              const _pR = await fetch(`${localUrl}/api/proxy-image-edits`, {
                method: 'POST', headers: _editsH, body: await _makeEditsForm(), signal: ctrl.signal
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
                body: await _makeEditsForm(), signal: ctrl.signal
              });
            }
          } else {
            imgRes = await fetch(editsEndpoint, {
              method: 'POST',
              headers: { 'Authorization': `Bearer ${imgKey}` },
              body: await _makeEditsForm(),
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
                body: JSON.stringify({ apiUrl: genEndpoint, apiKey: imgKey, model: imgModel, prompt, size: _size, response_format: 'url', api_format: imgFmt }),
                signal: ctrl.signal
              });
            } catch(proxyErr) {
              imgRes = await fetch(genEndpoint, {
                method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${imgKey}` },
                body: JSON.stringify({ model: imgModel, prompt, n: 1, size: _size, response_format: 'url' }),
                signal: ctrl.signal
              });
            }
          } else {
            imgRes = await fetch(genEndpoint, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${imgKey}` },
              body: JSON.stringify({ model: imgModel, prompt, n: 1, size: _size, response_format: 'url' }),
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
          // 🔴 全流程最值钱的一行：此刻图已经在服务端画好了、钱已经花了，
          //    但把它下载回来的活儿才刚开始 —— 这几秒里刷新/闪退，图就没了。
          //    先把链接记进账本，下次启动只需重新下载，不用再画一遍。
          pendSetUrl(_jd, _parsedUrl);
          try {
            _parsedUrl = await _httpToB64(_parsedUrl);
            console.log('[画图v2] URL已转base64存储');
          } catch(_ue) {
            console.warn('[画图v2] 三个代理都没下来，改存origUrl供手动打开:', _ue.message);
            toast('图片无法内嵌显示，气泡里有链接可点击打开');
            _parsedUrl = '__HTTP_URL__:' + _parsedUrl;
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

    await _saveGenBubble(dataUrl, { size: _size, hasRef, prompt, userDesc, opts, jd: _jd });

  } catch(e) {
    // 她看得见的那种失败（有 toast）→ 销账，别下次开机又偷偷画一张、再收一次钱。
    // 悄悄失败的那种（主动消息/碎碎念配图，本来就不弹东西）→ 记一次，下次开机再试。
    if (opts.quiet) pendBump(_jd); else pendDone(_jd);
    if (e.name === 'AbortError') {
      if (!opts.quiet) toast('画图超时了...');
    } else {
      if (!opts.quiet) toast('画图失败：' + e.message);
      console.error('[画图] 失败', e);
    }
  } finally {
    clearTimeout(tid);
    if (!_bg && !opts._resume) {
      if (typing) typing.classList.remove('show');
      window.isRequesting = false;
      if (btnSend && userInput) btnSend.disabled = userInput.value.trim() === '';
    }
  }
}

/**
 * 后台出图 —— 给碎碎念用的，**没有任何界面副作用**。
 *
 * ⚠️ 不能拿 generateImage() 在后台直接调：那是「她在聊天里点了画图」那条路 ——
 *    它会把 prompt 当成**她说的话**写进聊天、清空输入框、锁住发送键，画完再落一条 AI 气泡。
 *    后台悄悄出图用那个，聊天里会凭空多出一堆她没说过的话，还会卡住她打字。
 *    （2026-09-17 起 generateImage 支持 `opts.background`，气泡上的「重试」走的就是那条 ——
 *     它同样不落用户气泡、不锁输入框；但这里仍然只用这个函数，因为它不落**任何**气泡。）
 *
 * 这里只做最朴素的一件事：按画图预设依次试 → 出一张图返回 dataUrl；全失败返回 null。
 * 🔴 请求体刻意跟 generateImage 无参考图那条分支**保持一致**（含 `api_format`）——
 *    **异步出图、绕 CF 那些全是服务端代理在管**（xinye_server.js 的
 *    /api/proxy-image-generations），客户端只管把同样的东西发出去就行。
 *    ⚠️ 以后改那条分支的请求体，这里要一起改（两份，属于已知重复，见记忆）。
 */
/**
 * 取参考图（炘也 / 兔宝 / 画风）并压成能发给画图接口的 jpeg dataURL。
 * 返回 [] = 没有参考图，调用方走"纯提示词"那条路。
 *
 * 2026-09-17 加，为了「说说配图」和「主动消息配图」也能垫参考图 ——
 * 在那之前它们只能出一张跟炘也/兔宝一点关系都没有的图。
 * ⚠️ chat.js 里那条「我在聊天里画图」另有一套参考图逻辑（多一路"她这条消息带的图"），
 *    暂时没合并 —— 动那条路风险大，等哪天改到它再说。
 */
export async function collectRefImages(refChars, styleRef) {
  const raw = [];
  if (refChars && refChars !== 'none') {
    const _aiRef = await dbGet('images', 'aiRef').catch(() => null);
    const _userRef = await dbGet('images', 'userRef').catch(() => null);
    if ((refChars === 'ai' || refChars === 'both') && _aiRef) raw.push(_aiRef);
    if ((refChars === 'user' || refChars === 'both') && _userRef) raw.push(_userRef);
  }
  if (styleRef) {
    const _srMeta = (await dbGet('settings', 'styleRefs').catch(() => null)) || [];
    const _e = Array.isArray(_srMeta) ? _srMeta.find(s => s.name === styleRef) : null;
    if (_e) { const _img = await dbGet('images', _e.imgKey).catch(() => null); if (_img) raw.push(_img); }
  }
  const out = [];
  for (const b64 of raw) {
    const c = await new Promise(r => {
      const im = new Image();
      im.onload = () => {
        const sc = Math.min(1, 1500 / Math.max(im.width || 1, im.height || 1));
        const cw = Math.round(im.width * sc), ch = Math.round(im.height * sc);
        const cv = document.createElement('canvas'); cv.width = cw; cv.height = ch;
        cv.getContext('2d').drawImage(im, 0, 0, cw, ch);
        try { r(cv.toDataURL('image/jpeg', 0.82)); } catch (e) { r(null); }
      };
      im.onerror = () => r(null);
      const s = String(b64);
      if (s.startsWith('http')) { im.crossOrigin = 'anonymous'; im.src = s; }
      else { im.src = s.startsWith('data:') ? s : `data:image/png;base64,${s}`; }
    });
    if (c) out.push(c);
  }
  return out;
}

/**
 * 把参考图合成一个 Blob —— 给那些只认单个 `image` 字段的站子（预设上的 `singleImage`）。
 * 多于一张就横排拼成一张，跟 chat.js 里画图那段做法一致。
 */
async function _oneRefBlob(refs) {
  if (refs.length === 1) { try { return await (await fetch(refs[0])).blob(); } catch (e) { return null; } }
  const imgs = await Promise.all(refs.map(b => new Promise((res, rej) => {
    const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = b;
  })));
  const h = 512, cv = document.createElement('canvas');
  let x = 0;
  const ws = imgs.map(i => Math.round(i.width * h / (i.height || 1)));
  cv.width = ws.reduce((a, b) => a + b, 0) || 1; cv.height = h;
  const ctx = cv.getContext('2d');
  imgs.forEach((i, idx) => { ctx.drawImage(i, x, 0, ws[idx], h); x += ws[idx]; });
  return await new Promise(res => cv.toBlob(res, 'image/png'));
}

export async function generateImageQuiet(prompt, opts = {}) {
  if (!settings.apiKey || !prompt) return null;
  const _jd = opts._jd || '';
  // 续账：上次已经拿到链接、只是没下载完就被打断了 → 只重新下载，不重画
  if (_jd && opts._preUrl) {
    try { const _d = await _httpToB64(opts._preUrl); console.log('[碎碎念·画图] 上次存的链接下回来了'); return _d; }
    catch (e) { console.warn('[碎碎念·画图] 上次的链接下不回来了，重画:', e.message); }
  }

  // 参考图（2026-09-17 加）：垫炘也 / 垫兔宝 / 垫两人 + 画风
  const _refs = await collectRefImages(opts.refChars, opts.styleRef);

  const _rawPresets = getImagePresets();
  const _activeIdx = getImageCurPresetIdx();
  let _cfgs;
  if (_rawPresets.length > 0) {
    _cfgs = [];
    for (let i = 0; i < _rawPresets.length; i++) {
      const _p = _rawPresets[(_activeIdx + i) % _rawPresets.length];
      if (!_p.skip) _cfgs.push(_p);
    }
  } else {
    _cfgs = [null];
  }
  if (!_cfgs.length) return null;

  const _b64 = (s) => { s = String(s).replace(/[\s\r\n]/g, ''); return s.startsWith('data:') ? s : `data:image/png;base64,${s}`; };
  const _parseImg = (d) => {
    const item = d?.data?.[0] || d?.images?.[0];
    if (item?.b64_json) return _b64(item.b64_json);
    if (item?.url) return item.url;
    if (d?.b64_json) return _b64(d.b64_json);
    if (d?.url && typeof d.url === 'string') return d.url;
    if (d?.image) { const v = d.image; return /^(data:|https?:)/.test(v) ? v : _b64(v); }
    if (d?.artifacts?.[0]?.base64) return _b64(d.artifacts[0].base64);
    if (typeof d?.data === 'string' && d.data.length > 100) return /^(data:|https?:)/.test(d.data) ? d.data : _b64(d.data);
    if (typeof d === 'string' && d.length > 100) return /^(data:|https?:)/.test(d) ? d : _b64(d);
    return null;
  };

  for (const _preset of _cfgs) {
    const _name = _preset?.name || '默认配置';
    const imgKey = _preset?.apiKey || settings.imageApiKey || settings.apiKey;
    const raw = (_preset?.baseUrl || settings.imageBaseUrl || settings.baseUrl || 'https://api.openai.com').replace(/\/+$/, '');
    const imgModel = _preset?.model || settings.imageModel || 'gpt-image-1';
    const imgFmt = _preset?.apiFormat || settings.imageApiFormat || 'images';
    const genEndpoint = /\/v\d+$/.test(raw) ? `${raw}/images/generations` : `${raw}/v1/images/generations`;
    const localUrl = (settings.imageProxyUrl || settings.solitudeServerUrl || '').trim();
    const _direct = () => fetch(genEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${imgKey}` },
      body: JSON.stringify({ model: imgModel, prompt, n: 1, size: settings.imageSize || '1024x1024', response_format: 'url' }),
      signal: AbortSignal.timeout(300000),
    });
    // 有参考图时走 /images/edits（multipart）。
    // ⚠️ 只能**直连**：本地和 Vercel 那两个代理都只转发 JSON，塞不进去图片
    const _withRefs = async () => {
      const _b = /\/v\d+$/.test(raw) ? raw : `${raw}/v1`;
      const _form = new FormData();
      _form.append('model', imgModel);
      _form.append('prompt', prompt + (opts.styleRef
        ? '\n\nArt style reference: match the artistic style of the style reference image provided.' : ''));
      _form.append('n', '1');
      _form.append('size', settings.imageSize || '1024x1024');
      if (_preset?.singleImage) {
        _form.append('image', await _oneRefBlob(_refs), 'ref.png');
      } else {
        _refs.forEach((img, i) => _form.append('image[]', base64ToFile(img, `ref${i}.jpg`)));
      }
      return fetch(`${_b}/images/edits`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${imgKey}` },
        body: _form,
        signal: AbortSignal.timeout(300000),
      });
    };
    try {
      let imgRes;
      if (_refs.length) {
        imgRes = await _withRefs();
      } else if (localUrl) {
        const _genH = { 'Content-Type': 'application/json' };
        if (settings.imageProxyToken) _genH['Authorization'] = `Bearer ${settings.imageProxyToken}`;
        try {
          imgRes = await fetch(`${localUrl}/api/proxy-image-generations`, {
            method: 'POST', headers: _genH,
            body: JSON.stringify({ apiUrl: genEndpoint, apiKey: imgKey, model: imgModel, prompt, size: settings.imageSize || '1024x1024', response_format: 'url', api_format: imgFmt }),
            signal: AbortSignal.timeout(300000),
          });
        } catch (_pe) {
          imgRes = await _direct();
        }
      } else {
        imgRes = await _direct();
      }
      if (!imgRes.ok) throw new Error(`HTTP ${imgRes.status}`);
      let url = _parseImg(await imgRes.json());
      if (!url) throw new Error('没从返回里解析出图片');
      if (url.startsWith('http')) {
        if (_jd) pendSetUrl(_jd, url);   // 链接先记账：中断了只需重新下载，不用重画
        url = await _httpToB64(url);     // 三级兜底（直连 → 本地代理 → Vercel 代理）都在里面
      }
      console.log(`[碎碎念·画图] ✓ ${_name}`);
      return url;
    } catch (e) {
      console.warn(`[碎碎念·画图] ✗ ${_name}: ${e.message}`);
    }
  }
  return null;
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
    const btn = document.createElement('button'); btn.className = 'img-remove'; btn.innerHTML = '<i class="ic ic-x"></i>';
    btn.onclick = () => { window.pendingImages.splice(i, 1); renderImgPreviews(); };
    wrap.appendChild(img); wrap.appendChild(btn); preview.appendChild(wrap);
  });
  preview.classList.add('show');
}

async function handleImageFiles(files) {
  let added = 0;
  for (const file of files) {
    if (!file.type.startsWith('image/')) continue;
    window.pendingImages.push(await compressImageToBase64(file));
    added++;
  }
  if (added) renderImgPreviews();
  return added;
}

export function initImageUpload() {
  window.pendingImages = [];
  document.getElementById('btnImg').onclick = () => document.getElementById('fileInputChatImg').click();
  document.getElementById('fileInputChatImg').onchange = async function() {
    if (!this.files.length) return;
    await handleImageFiles(this.files);
    this.value = '';
  };

  /* ── 粘贴图片 ── */
  const userInput = document.getElementById('userInput');
  userInput.addEventListener('paste', async (e) => {
    const items = [...(e.clipboardData?.items || [])];
    const imgFiles = items.filter(it => it.type.startsWith('image/')).map(it => it.getAsFile()).filter(Boolean);
    if (!imgFiles.length) return;          // 纯文本粘贴走默认逻辑
    e.preventDefault();                    // 阻止图片以乱码插入textarea
    await handleImageFiles(imgFiles);
  });

  /* ── 拖拽图片 ── */
  const inputArea = document.querySelector('.input-area');
  if (inputArea) {
    let dragCounter = 0;                   // 用计数器精确追踪拖入/拖出

    inputArea.addEventListener('dragenter', (e) => {
      e.preventDefault();
      if (++dragCounter === 1) inputArea.classList.add('drag-over');
    });
    inputArea.addEventListener('dragover', (e) => {
      e.preventDefault();                  // 必须，否则drop不触发
      e.dataTransfer.dropEffect = 'copy';
    });
    inputArea.addEventListener('dragleave', (e) => {
      e.preventDefault();
      if (--dragCounter <= 0) { dragCounter = 0; inputArea.classList.remove('drag-over'); }
    });
    inputArea.addEventListener('drop', async (e) => {
      e.preventDefault();
      dragCounter = 0;
      inputArea.classList.remove('drag-over');
      const files = e.dataTransfer?.files;
      if (files?.length) await handleImageFiles(files);
    });
  }
}
