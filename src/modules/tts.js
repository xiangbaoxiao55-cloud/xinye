import { settings } from './state.js';
import { toast } from './utils.js';
import { dbGet, dbPut, dbGetAll, dbGetAllKeys } from './db.js';

let currentAudio = null;
let _ttsGenerating = new Map();
const _ttsQueue = [];
let _ttsQueueRunning = false;

const _THINK_RE = /(?:<thinking>|<think>|〈thinking〉|《thinking》)[\s\S]*?(?:<\/thinking>|<\/think>|〈\/thinking〉|《\/thinking》)\s*/gi;
export function stripThinking(t) {
  return t.replace(_THINK_RE, '').trim();
}
export function stripForTTS(t) {
  return t
    .replace(_THINK_RE, '')
    .replace(/\[sticker:[^\]]{1,20}\]/g, '')
    .replace(/（.+?发了一个「.+?」贴纸）/g, '')
    .replace(/[\u{1F300}-\u{1FFFF}]/gu, '')
    .replace(/[\u{2600}-\u{26FF}]/gu, '')
    .replace(/[\u{FE00}-\u{FE0F}]/gu, '')
    .replace(/[᐀-ᙿ]+/g, '')
    .replace(/[（(][^一-龥a-zA-Z\n]{1,20}[）)]/g, '')
    .replace(/[＜〈《]#([\d.]+)#[＞〉》]/g, '<#$1#>')
    .replace(/[（(](laughs|chuckle|coughs|clear-throat|groans|breath|pant|inhale|exhale|gasps|sniffs|sighs|snorts|burps|lip-smacking|humming|hissing|emm|sneezes)[）)]/g, '($1)')
    .replace(/\s{2,}/g, ' ')
    .trim();
}
const _TTS_TONE_RE = /[（(](laughs|chuckle|coughs|clear-throat|groans|breath|pant|inhale|exhale|gasps|sniffs|sighs|snorts|burps|lip-smacking|humming|hissing|emm|sneezes)[）)]/;
export function _hasTTSMarkers(t) {
  return /[<＜〈《]#[\d.]+#[>＞〉》]/.test(t) || _TTS_TONE_RE.test(t);
}

function blobExt(blob) {
  if (blob.type.includes('mpeg') || blob.type.includes('mp3')) return 'mp3';
  if (blob.type.includes('ogg')) return 'ogg';
  return 'wav';
}

export function fetchWithTimeout(url, opts, ms = 60000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(timer));
}

function cleanPath(p) {
  return (p || '').replace(/\\/g, '/').replace(/^["']+|["']+$/g, '').trim();
}

export async function generateTTSBlob(text) {
  if (settings.ttsType === 'minimax') {
    if (!settings.minimaxKey || !settings.minimaxGroupId) { toast('请先填写 MiniMax API Key 和 Group ID'); return null; }
    const _mmBase = (settings.minimaxProxy || '').trim()
      ? settings.minimaxProxy.trim().replace(/\/+$/, '')
      : 'https://api.minimax.chat/v1/t2a_v2';
    const endpoint = _mmBase.includes('GroupId') ? _mmBase : `${_mmBase}?GroupId=${settings.minimaxGroupId}`;
    const res = await fetchWithTimeout(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${settings.minimaxKey}` },
      body: JSON.stringify({
        model: settings.minimaxModel || 'speech-01-turbo',
        text,
        stream: false,
        voice_setting: { voice_id: settings.minimaxVoiceId || 'female-shaonv', speed: 1.0, vol: 1.0, pitch: 0 },
        audio_setting: { audio_sample_rate: 32000, bitrate: 128000, format: 'mp3' }
      })
    }, 60000);
    if (!res.ok) throw new Error(`MiniMax TTS HTTP ${res.status}`);
    const j = await res.json();
    const hex = j.data?.audio;
    if (!hex) throw new Error('MiniMax TTS 未返回音频，请检查 Key / Group ID / Voice ID');
    const arr = new Uint8Array(hex.length / 2);
    for (let i = 0; i < arr.length; i++) arr[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return new Blob([arr], { type: 'audio/mpeg' });
  }
  if (settings.ttsType === 'mosi') {
    if (!settings.mosiKey || !settings.mosiVoiceId) { toast('请先填写 MOSI API Key 和 Voice ID'); return null; }
    const cleaned = text
      .replace(/[\u{1F300}-\u{1FFFF}]/gu, '')
      .replace(/[☀-➿]/g, '')
      .replace(/[*_~`#>|\\—–\-]{2,}/g, '，')
      .replace(/[*_~`#>|\\]/g, '')
      .replace(/\n/g, '，')
      .replace(/[。，]{2,}/g, '，')
      .replace(/\s+/g, ' ').trim();
    const res = await fetchWithTimeout('https://studio.mosi.cn/api/v1/audio/speech', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${settings.mosiKey}` },
      body: JSON.stringify({
        model: 'moss-tts',
        text: cleaned,
        voice_id: settings.mosiVoiceId,
        sampling_params: { max_new_tokens: 32768 }
      })
    }, 120000);
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/json')) {
      const j = await res.json();
      if (!j.audio_data) throw new Error('MOSI TTS 未返回音频，请检查 Key 和 Voice ID');
      const bin = atob(j.audio_data); const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      return new Blob([arr], { type: 'audio/mpeg' });
    } else {
      const buf = await res.arrayBuffer();
      if (!buf.byteLength) throw new Error('MOSI TTS 返回空音频');
      return new Blob([buf], { type: ct || 'audio/mpeg' });
    }
  }
  if (settings.ttsType === 'omnivoice') {
    const base = (settings.omnivoiceUrl || 'https://xinye-omni-tts.cpolar.top').replace(/\/+$/, '');
    const isXinye = (settings.aiName || '').includes('炘') || (settings.aiName || '').includes('心');
    const role = isXinye ? 'xinye' : 'choubao';
    const url = `${base}/tts?text=${encodeURIComponent(text)}&role=${role}`;
    console.log('[TTS] OmniVoice', url);
    const res = await fetchWithTimeout(url, {}, 300000);
    if (!res.ok) {
      const err = await res.text().catch(() => '');
      throw new Error(`OmniVoice 错误 (${res.status}) ${err.slice(0, 100)}`);
    }
    return await res.blob();
  }
  if (settings.ttsType === 'doubao') {
    if (!settings.doubaoAppId || !settings.doubaoToken) { toast('请先填写豆包 TTS 的 AppID 和 Token'); return null; }
    const endpoint = (settings.doubaoProxy || '').trim()
      ? settings.doubaoProxy.trim().replace(/\/+$/, '')
      : 'https://openspeech.bytedance.com/api/v1/tts';
    const res = await fetchWithTimeout(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer;${settings.doubaoToken}`, 'Resource-Id': settings.doubaoCluster || 'volcano_tts' },
      body: JSON.stringify({
        app: { appid: settings.doubaoAppId, token: settings.doubaoToken, cluster: settings.doubaoCluster || 'volcano_tts' },
        user: { uid: 'xinye_user' },
        audio: { voice_type: settings.doubaoVoice || 'zh_female_cancan_mars_bigtts', encoding: 'mp3', speed_ratio: 1.0 },
        request: { reqid: Date.now().toString(), text, text_type: 'plain', operation: 'query' }
      })
    });
    const j = await res.json();
    const b64 = typeof j.data === 'string' ? j.data : j.data?.audio;
    if (!b64) throw new Error('豆包 TTS 未返回音频数据，请检查 AppID / Token / 音色');
    const bin = atob(b64); const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type: 'audio/mpeg' });
  }
  if (!settings.ttsUrl) { toast('请先在设置中配置 TTS API 地址'); return null; }
  // GPT-SoVITS 不支持 <#X#> 停顿标记和 (sighs) 等语气词，剥掉避免念出来
  text = text
    .replace(/<#[\d.]+#>/g, '')
    .replace(/\((sighs|laughs|chuckle|coughs|clear-throat|groans|breath|pant|inhale|exhale|gasps|sniffs|snorts|burps|lip-smacking|humming|hissing|emm|sneezes)\)/gi, '')
    .replace(/\s{2,}/g, ' ').trim();
  const refPath = cleanPath(settings.ttsRefPath);
  const base = settings.ttsUrl.replace(/\/+$/, '');
  if (settings.ttsGptWeights) {
    try {
      await fetch(`${base}/set_gpt_weights?weights_path=${encodeURIComponent(cleanPath(settings.ttsGptWeights))}`, { method: 'GET', headers: { 'ngrok-skip-browser-warning': 'true' } });
      console.log('[TTS] 已切换 GPT 模型:', settings.ttsGptWeights);
    } catch(_){}
  }
  if (settings.ttsSovitsWeights) {
    try {
      await fetch(`${base}/set_sovits_weights?weights_path=${encodeURIComponent(cleanPath(settings.ttsSovitsWeights))}`, { method: 'GET', headers: { 'ngrok-skip-browser-warning': 'true' } });
      console.log('[TTS] 已切换 SoVITS 模型:', settings.ttsSovitsWeights);
    } catch(_){}
  }
  const params = new URLSearchParams({
    text,
    text_lang: settings.ttsTargetLang || 'zh',
    ref_audio_path: refPath,
    prompt_text: settings.ttsRefText || '',
    prompt_lang: settings.ttsRefLang || 'zh',
  });
  const url = `${base}/tts?${params.toString()}`;
  console.log('[TTS] GET', url);
  const res = await fetchWithTimeout(url, { method: 'GET', headers: { 'ngrok-skip-browser-warning': 'true' } }, 300000);
  if (!res.ok) {
    let detail = `${res.status}`;
    try { const t = await res.text(); if (t) detail += ' ' + t.slice(0, 120); } catch(_){}
    throw new Error(`TTS 错误 (${detail})`);
  }
  return await res.blob();
}

export function markCached(msgId) {
  document.querySelectorAll(`.btn-tts[data-id="${msgId}"],.btn-tts-dl[data-id="${msgId}"]`)
    .forEach(b => b.classList.add('cached'));
}

export function playAudioBlob(blob, btnEl) {
  btnEl.classList.add('playing');
  const audioUrl = URL.createObjectURL(blob);
  currentAudio = new Audio(audioUrl);
  currentAudio.onended = () => {
    btnEl.classList.remove('playing');
    currentAudio = null;
    URL.revokeObjectURL(audioUrl);
  };
  currentAudio.onerror = () => {
    btnEl.classList.remove('playing');
    currentAudio = null;
    URL.revokeObjectURL(audioUrl);
    toast('音频播放失败');
  };
  currentAudio.play();
  toast('正在播放语音…');
}

export async function playTTS(text, btnEl, msgId) {
  text = stripForTTS(text);
  if (!text) return;
  if (settings.ttsType === 'browser') {
    document.querySelectorAll('.btn-tts.playing').forEach(b => b.classList.remove('playing'));
    btnEl.classList.add('playing');
    const doSpeak = () => {
      const voices = window.speechSynthesis.getVoices();
      const local = voices.filter(v => !v.name.includes('Online'));
      const v = local.find(v => v.name.includes('云希') || v.name.includes('Yunxi'))
             || local.find(v => v.name.includes('Kangkang') || v.name.includes('康康'))
             || local.find(v => v.lang && (v.lang.startsWith('zh') || v.lang.includes('cmn')))
             || voices.find(v => v.lang && v.lang.startsWith('zh'));
      console.log('[TTS] 使用声音:', v ? v.name : '默认，全部声音：' + voices.map(v=>v.name).join(' | '));
      const utter = new SpeechSynthesisUtterance(text);
      if (v) { utter.voice = v; utter.rate = 0.92; }
      utter.onend = () => btnEl.classList.remove('playing');
      utter.onerror = (e) => { btnEl.classList.remove('playing'); console.warn('[TTS error]', e.error); };
      window.speechSynthesis.speak(utter);
    };
    if (window.speechSynthesis.getVoices().length > 0) {
      doSpeak();
    } else {
      window.speechSynthesis.addEventListener('voiceschanged', doSpeak, { once: true });
    }
    return;
  }
  if (currentAudio) {
    currentAudio.pause(); currentAudio = null;
    document.querySelectorAll('.btn-tts.playing').forEach(b => b.classList.remove('playing'));
    return;
  }
  try {
    const lockTime = _ttsGenerating.get(msgId);
    if (lockTime && Date.now() - lockTime < 120000) { toast('语音生成中，请稍候~'); return; }
    if (lockTime) _ttsGenerating.delete(msgId);
    let blob = await dbGet('ttsCache', msgId);
    if (!blob) {
      toast('正在生成语音…');
      _ttsGenerating.set(msgId, Date.now());
      try {
        blob = await generateTTSBlob(text);
      } finally { _ttsGenerating.delete(msgId); }
      if (!blob) return;
      await dbPut('ttsCache', msgId, blob);
      markCached(msgId);
    }
    playAudioBlob(blob, btnEl);
  } catch(err) {
    _ttsGenerating.delete(msgId);
    btnEl.classList.remove('playing');
    currentAudio = null;
    toast(`TTS 失败：${err.message}`);
    console.error('[TTS Error]', err);
  }
}

export function enqueueTTS(text, msgId, showBar = false) {
  text = stripForTTS(text);
  if (!text) return;
  _ttsQueue.push({ text, msgId, showBar });
  if (!_ttsQueueRunning) _drainTTSQueue();
}

async function _drainTTSQueue() {
  _ttsQueueRunning = true;
  while (_ttsQueue.length) {
    const { text, msgId, showBar } = _ttsQueue.shift();
    try {
      let blob = await dbGet('ttsCache', msgId);
      if (!blob) {
        _ttsGenerating.set(msgId, Date.now());
        try { blob = await generateTTSBlob(text); } finally { _ttsGenerating.delete(msgId); }
        if (blob) { await dbPut('ttsCache', msgId, blob); markCached(msgId); }
      }
      const barCtrl = (blob && showBar) ? showVoiceBar(msgId, blob) : null;
      if (blob) await new Promise(resolve => {
        const audioUrl = URL.createObjectURL(blob);
        const audio = new Audio(audioUrl);
        currentAudio = audio;
        if (barCtrl) barCtrl.setPlaying(true);
        audio.addEventListener('timeupdate', () => {
          if (barCtrl && audio.duration) barCtrl.setProgress(audio.currentTime / audio.duration);
        });
        audio.onended = () => { currentAudio = null; URL.revokeObjectURL(audioUrl); if (barCtrl) barCtrl.setPlaying(false); resolve(); };
        audio.onerror = () => { currentAudio = null; URL.revokeObjectURL(audioUrl); if (barCtrl) barCtrl.setPlaying(false); resolve(); };
        audio.play().catch(resolve);
      });
    } catch(e) { console.warn('[TTS Queue]', e); }
  }
  _ttsQueueRunning = false;
}

export function showVoiceBar(msgId, blob) {
  const btnEl = document.querySelector(`.btn-tts[data-id="${msgId}"]`);
  if (!btnEl) return null;
  const content = btnEl.closest('.msg-content');
  if (!content || content.querySelector('.tts-voice-bar')) return null;
  const bubble = content.querySelector('.msg-bubble');
  const bar = document.createElement('div');
  bar.className = 'tts-voice-bar';
  bar.dataset.id = msgId;
  bar.innerHTML = `<div class="tts-vbar-row"><button class="tts-vbar-play">▶</button><div class="tts-vbar-waves"><span></span><span></span><span></span><span></span><span></span></div><span class="tts-vbar-dur">…</span></div><div class="tts-vbar-progress"><div class="tts-vbar-progress-fill"></div></div>`;
  const playBtn = bar.querySelector('.tts-vbar-play');
  const fill = bar.querySelector('.tts-vbar-progress-fill');
  const durEl = bar.querySelector('.tts-vbar-dur');
  const tmpAudio = new Audio(URL.createObjectURL(blob));
  tmpAudio.addEventListener('loadedmetadata', () => {
    const dur = isFinite(tmpAudio.duration) ? Math.round(tmpAudio.duration) : '?';
    durEl.textContent = `${dur}″`;
  });
  const ctrl = {
    setPlaying(playing) {
      bar.classList.toggle('playing', playing);
      playBtn.textContent = playing ? '⏸' : '▶';
      if (!playing) fill.style.width = '0%';
    },
    setProgress(ratio) {
      fill.style.width = `${Math.min(100, ratio * 100).toFixed(1)}%`;
    }
  };
  bar.addEventListener('click', () => btnEl.click());
  const observer = new MutationObserver(() => {
    const playing = btnEl.classList.contains('playing');
    bar.classList.toggle('playing', playing);
    playBtn.textContent = playing ? '⏸' : '▶';
    if (!playing) fill.style.width = '0%';
  });
  observer.observe(btnEl, { attributes: true, attributeFilter: ['class'] });
  if (bubble) bubble.style.display = 'none';
  const toggleBtn = document.createElement('span');
  toggleBtn.className = 'tts-vbar-toggle';
  toggleBtn.textContent = '展开文字';
  toggleBtn.onclick = (e) => {
    e.stopPropagation();
    const hidden = bubble.style.display === 'none';
    bubble.style.display = hidden ? '' : 'none';
    toggleBtn.textContent = hidden ? '收起' : '展开文字';
  };
  content.insertBefore(bar, bubble);
  content.insertBefore(toggleBtn, bubble);
  return ctrl;
}

export async function downloadTTS(text, msgId) {
  try {
    let blob = await dbGet('ttsCache', msgId);
    if (!blob) {
      toast('正在生成语音，请稍候…');
      blob = await generateTTSBlob(text);
      if (!blob) return;
      await dbPut('ttsCache', msgId, blob);
      markCached(msgId);
    }
    const ext = blobExt(blob);
    const filename = `语音_${msgId}.${ext}`;
    if (window.Capacitor?.Plugins?.Filesystem) {
      try {
        const perm = await window.Capacitor.Plugins.Filesystem.requestPermissions();
        if (perm.publicStorage !== 'granted') { toast('需要存储权限'); return; }
        const base64 = await new Promise(res => {
          const r = new FileReader(); r.onload = e => res(e.target.result.split(',')[1]); r.readAsDataURL(blob);
        });
        await window.Capacitor.Plugins.Filesystem.writeFile({
          path: 'Download/' + filename, data: base64, directory: 'EXTERNAL_STORAGE', recursive: true,
        });
        toast('语音已保存到 Download 文件夹 💙');
      } catch(e) { toast(`保存失败：${e.message}`); }
      return;
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
    toast('语音已下载');
  } catch(err) {
    toast(`下载失败：${err.message}`);
    console.error('[TTS DL]', err);
  }
}

export async function exportTTSCache() {
  try {
    toast('正在打包TTS缓存…');
    const [keys, blobs] = await Promise.all([dbGetAllKeys('ttsCache'), dbGetAll('ttsCache')]);
    if (!keys.length) { toast('TTS缓存是空的，先让炘也说点话～'); return; }

    const script = document.createElement('script');
    script.src = './lib/jszip.min.js';
    await new Promise((res, rej) => { script.onload = res; script.onerror = rej; document.head.appendChild(script); });

    const zip = new window.JSZip();
    blobs.forEach((blob, i) => {
      const ext = blob.type.includes('mp3') ? 'mp3' : 'wav';
      zip.file(`tts_${String(i + 1).padStart(3, '0')}.${ext}`, blob);
    });

    const zipBlob = await zip.generateAsync({ type: 'blob', compression: 'STORE' });
    const url = URL.createObjectURL(zipBlob);
    const a = document.createElement('a');
    a.href = url;
    const _ttsPrefix = window.__APP_ID__ === 'choubao' ? 'choubao' : 'xinye';
    a.download = `${_ttsPrefix}_tts_cache_${keys.length}条.zip`;
    a.click();
    URL.revokeObjectURL(url);
    toast(`✅ 已打包 ${keys.length} 条语音，下载中～`);
  } catch(err) {
    toast(`导出失败：${err.message}`);
    console.error('[TTS Export]', err);
  }
}
