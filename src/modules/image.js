import { toast } from './utils.js';
import { settings, messages } from './state.js';
import { dbPut } from './db.js';
import { addMessage, appendMsgDOM, scrollBottom, activeStore } from './chat.js';
import { resetIdleTimer } from './notifications.js';

async function autoSaveGenImage(dataUrl, msgId) {
  const filename = `炘也画的图_${msgId}.png`;
  try {
    let b64, blob;
    if (dataUrl.startsWith('data:')) {
      b64 = dataUrl.split(',')[1];
      const mime = dataUrl.match(/:(.*?);/)?.[1] || 'image/png';
      const u8 = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
      blob = new Blob([u8], { type: mime });
    } else {
      const resp = await fetch(dataUrl);
      blob = await resp.blob();
      b64 = await new Promise(r => {
        const fr = new FileReader();
        fr.onload = () => r(fr.result.split(',')[1]);
        fr.readAsDataURL(blob);
      });
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

function base64ToFile(dataUrl, filename) {
  const arr = dataUrl.split(',');
  const mime = arr[0].match(/:(.*?);/)[1] || 'image/png';
  const bstr = atob(arr[1]);
  const u8arr = new Uint8Array(bstr.length);
  for (let i = 0; i < bstr.length; i++) u8arr[i] = bstr.charCodeAt(i);
  return new File([u8arr], filename, { type: mime });
}

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

export async function generateImage(userDesc) {
  if (!settings.apiKey) { toast('请先设置 API Key'); return; }
  if (window.isRequesting) return;

  const userInput = document.getElementById('userInput');
  const btnSend = document.getElementById('btnSend');
  const typing = document.getElementById('typingIndicator');
  const imgPreview = document.getElementById('imgPreview');

  const refImgs = [...window.pendingImages];
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

  try {
    const prompt = userDesc;
    console.log('[画图] 模式:', hasRef ? '垫图/改图' : '生成', 'prompt:', prompt);

    toast(hasRef ? '炘也正在改图...' : '炘也正在画...');
    const imgKey = settings.imageApiKey || settings.apiKey;
    const raw = (settings.imageBaseUrl || settings.baseUrl || 'https://api.openai.com').replace(/\/+$/, '');
    const imgModel = settings.imageModel;
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), 360000);
    let imgRes;

    const genEndpoint = /\/v\d+$/.test(raw) ? `${raw}/images/generations` : `${raw}/v1/images/generations`;
    if (hasRef) {
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
      if (imgRes.status === 404 || imgRes.status === 502 || imgRes.status >= 500) {
        throw new Error(`当前画图API不支持垫图改图功能（/images/edits ${imgRes.status}）\n可在设置→画图API中配置支持edits的接口（如直连OpenAI），或去掉垫图直接生成`);
      }
    } else {
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

    const ctxDesc = `[🎨 炘也${hasRef ? '根据垫图' : ''}给你画了一张图]\n你说：${userDesc}\n提示词：${prompt}`;
    const aiMsg = await addMessage('assistant', ctxDesc);
    aiMsg.isGenImage = true;
    aiMsg.genImageData = dataUrl;
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
    if (typing) typing.classList.remove('show');
    window.isRequesting = false;
    if (btnSend && userInput) btnSend.disabled = userInput.value.trim() === '';
  }
}
