import { settings } from './state.js';
import { toast, saveFile } from './utils.js';
import { dbGet, dbPut, dbDelete, dbGetAll, dbGetAllKeys } from './db.js';

let currentAudio = null;
let _ttsGenerating = new Map();
const _mimoRefCache = new Map();
export function clearMimoRefCache() { _mimoRefCache.clear(); }
export function clearMimoRefCacheEn() { _mimoRefCache.clear(); }
const _ttsQueue = [];
let _ttsQueueRunning = false;
let _ttsQueueGen = 0;      // 队列代数：卡死复位时旧的一代作废
let _ttsQueueTick = 0;     // 最近一次有进展的时间戳（看门狗用）
let _ttsPhase = 'idle';    // idle / gen / play —— 越靠后的阶段容忍越久才判卡死
let _ttsStallTimer = null;

// IDB 在 PWA 从后台恢复时整条事务可能挂住，读和写都不 resolve —— 直接 await 会永远等下去。
// TTS 队列里宁可拿不到缓存（重新生成一次）也不能卡死在这。
function _withTimeout(p, ms, fallback) {
  return Promise.race([p, new Promise(r => setTimeout(() => r(fallback), ms))]);
}

// 被浏览器自动播放策略拦下的语音，等下次用户手势再补播（无手势时 audio.play() 会被拒）
const _pendingAutoplay = [];
let _gestureArmed = false;
function _armGestureResume() {
  if (_gestureArmed) return;
  _gestureArmed = true;
  const handler = async () => {
    document.removeEventListener('pointerdown', handler);
    document.removeEventListener('touchstart', handler);
    _gestureArmed = false;
    const items = _pendingAutoplay.splice(0);
    for (const { blob } of items) {
      await new Promise(resolve => {
        let url;
        try { url = URL.createObjectURL(blob); } catch(e) {
          console.warn('[TTS] gestureResume blob不可读，跳过', e.name);
          resolve(); return;
        }
        const audio = new Audio(url);
        currentAudio = audio;
        let done = false;
        let _guard = null;
        const finish = () => {
          if (done) return;
          done = true;
          clearTimeout(_guard);
          if (currentAudio === audio) currentAudio = null;
          try { URL.revokeObjectURL(url); } catch(_) {}
          resolve();
        };
        // 补播同样可能等不到 ended/error，加硬超时免得后面的补播全被堵住
        _guard = setTimeout(finish, 180000);
        audio.onended = finish;
        audio.onerror = finish;
        audio.play().catch(finish);
      });
    }
  };
  document.addEventListener('pointerdown', handler);
  document.addEventListener('touchstart', handler);
  console.warn('[TTS] 已挂手势监听，下次点屏幕补播', _pendingAutoplay.length, '条');
}

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
    const voiceSetting = {
      speed: parseFloat(settings.minimaxSpeed) || 1.0,
      vol: parseFloat(settings.minimaxVol) || 1.0,
      pitch: 0,
      voice_id: '',
    };
    const timbreWeightsStr = (settings.minimaxTimbreWeights || '').trim();
    let parsedTimbreWeights = null;
    if (timbreWeightsStr) {
      try { parsedTimbreWeights = JSON.parse(timbreWeightsStr); }
      catch(e) {}
    }
    if (!parsedTimbreWeights) {
      voiceSetting.voice_id = settings.minimaxVoiceId || 'female-shaonv';
    }
    const mmBody = {
      model: settings.minimaxModel || 'speech-01-turbo',
      text, stream: false,
      voice_setting: voiceSetting,
      audio_setting: { audio_sample_rate: 32000, bitrate: 128000, format: 'mp3' },
    };
    if (parsedTimbreWeights) mmBody.timbre_weights = parsedTimbreWeights;
    const mp = settings.minimaxModifyPitch, mi = settings.minimaxModifyIntensity, mt = settings.minimaxModifyTimbre;
    if (mp !== '' || mi !== '' || mt !== '') {
      mmBody.voice_modify = {};
      if (mp !== '') mmBody.voice_modify.pitch = parseInt(mp);
      if (mi !== '') mmBody.voice_modify.intensity = parseInt(mi);
      if (mt !== '') mmBody.voice_modify.timbre = parseInt(mt);
    }
    const res = await fetchWithTimeout(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${settings.minimaxKey}` },
      body: JSON.stringify(mmBody)
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
  if (settings.ttsType === 'mimo') {
    if (!settings.mimoKey) { toast('请先填写 Mimo API Key'); return null; }
    const _langText = text.replace(/[（(][^)）]*[）)]/g, '').trim();
    const _enChars = (_langText.match(/[a-zA-Z]/g) || []).length;
    const _zhChars = (_langText.match(/[一-鿿]/g) || []).length;
    const isEn = _enChars > 0 && _enChars > _zhChars * 2;
    const pid = settings.ttsActivePresetId || '';
    const _refKey = pid ? `mimoRefAudio_${pid}` : 'mimoRefAudio';
    const _refEnKey = pid ? `mimoRefAudioEn_${pid}` : 'mimoRefAudioEn';
    const cacheKey = `${pid}_${isEn ? 'en' : 'zh'}`;
    let refBase64 = _mimoRefCache.get(cacheKey);
    if (!refBase64) {
      const useEn = isEn && await dbGet('images', _refEnKey);
      const refBlob = useEn ? await dbGet('images', _refEnKey) : await dbGet('images', _refKey);
      if (!refBlob) { toast('请先在设置中上传 Mimo 参考音频'); return null; }
      refBase64 = await new Promise(resolve => {
        const r = new FileReader();
        r.onload = e => resolve(e.target.result);
        r.readAsDataURL(refBlob);
      });
      _mimoRefCache.set(cacheKey, refBase64);
    }
    // 去掉 MiniMax 速度标签 <#1#> 等，Mimo 不识别会乱说
    text = text.replace(/<#[\d.]+#?>/g, '').replace(/\s{2,}/g, ' ').trim();
    console.log(`[TTS] Mimo 使用${isEn ? '英文' : '中文'}参考音频 (预设:${pid || '默认'})`);
    const res = await fetchWithTimeout('https://api.xiaomimimo.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'api-key': settings.mimoKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'mimo-v2.5-tts-voiceclone',
        messages: [
          { role: 'user', content: settings.mimoStylePrompt || '' },
          { role: 'assistant', content: text }
        ],
        audio: { format: 'wav', voice: refBase64 }
      })
    }, 60000);
    if (!res.ok) throw new Error(`Mimo TTS HTTP ${res.status}`);
    const j = await res.json();
    const audioData = j.choices?.[0]?.message?.audio?.data;
    if (!audioData) throw new Error('Mimo TTS 未返回音频，请检查 API Key 和参考音频');
    const bin = atob(audioData);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type: 'audio/wav' });
  }
  if (!settings.ttsUrl) { toast('请先在设置中配置 TTS API 地址'); return null; }
  // GPT-SoVITS 不支持 <#X#> 停顿标记和 (sighs) 等语气词，剥掉避免念出来
  text = text
    .replace(/<#[\d.]+#?>/g, '')
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
    text_split_method: settings.ttsSplitMethod || 'cut5',
    fragment_interval: settings.ttsFragmentInterval ?? 0.3,
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
  let audioUrl;
  try { audioUrl = URL.createObjectURL(blob); } catch(e) {
    btnEl.classList.remove('playing');
    console.warn('[TTS] playAudioBlob blob不可读', e.name);
    toast('语音缓存已损坏，请重新生成');
    return;
  }
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

// 播放一条语音并等它结束。鸿蒙上 ended/error 可能永远不来（切后台、音频焦点被抢、
// play() 挂起），没有兜底的话 _ttsQueueRunning 会一直卡在 true，之后所有自动语音都不再播。
function _playBlobAndWait(blob, msgId, barCtrl) {
  return new Promise(resolve => {
    let audioUrl;
    try { audioUrl = URL.createObjectURL(blob); } catch(e) {
      console.warn('[TTS Queue] blob不可读，跳过', msgId, e.name);
      resolve(); return;
    }
    const audio = new Audio(audioUrl);
    currentAudio = audio;
    _ttsPhase = 'play';
    _ttsQueueTick = Date.now();
    if (barCtrl) barCtrl.setPlaying(true);

    let finished = false, started = false;
    let hardTimer = null, startTimer = null, watchTimer = null;
    const finish = (why) => {
      if (finished) return;
      finished = true;
      clearTimeout(hardTimer); clearTimeout(startTimer); clearInterval(watchTimer);
      if (currentAudio === audio) currentAudio = null;
      try { URL.revokeObjectURL(audioUrl); } catch(_) {}
      if (barCtrl) barCtrl.setPlaying(false);
      _ttsPhase = 'idle';
      _ttsQueueTick = Date.now();
      if (why) console.warn('[TTS Queue] 播放提前结束：', why, msgId);
      resolve();
    };
    // 硬超时：拿到时长就按时长+20秒，拿不到用 180 秒兜底
    const armHard = () => {
      if (finished) return;
      const ms = (isFinite(audio.duration) && audio.duration > 0) ? audio.duration * 1000 + 20000 : 180000;
      clearTimeout(hardTimer);
      hardTimer = setTimeout(() => finish('硬超时'), ms);
    };
    armHard();
    audio.addEventListener('loadedmetadata', armHard);
    audio.addEventListener('playing', () => { started = true; });
    audio.addEventListener('timeupdate', () => {
      started = true;
      _ttsQueueTick = Date.now();   // 播放心跳：长音频播放期间队列也算「有进展」
      if (barCtrl && audio.duration) barCtrl.setProgress(audio.currentTime / audio.duration);
    });
    audio.onended = () => finish(null);
    audio.onerror = () => finish('audio error');
    // 播放中途被系统抢走音频焦点时 paused 变 true 但 ended 不会触发，靠巡检兜底。
    // 页面在后台时不判定（那是正常的暂停），交给硬超时。
    watchTimer = setInterval(() => {
      if (audio.ended) finish(null);
      else if (started && audio.paused && !document.hidden) finish('被打断');
    }, 1000);
    // play() 本身也可能挂起不 settle，15 秒还没开声就跳过，别堵住整个队列
    startTimer = setTimeout(() => { if (!started) finish('play 未开始'); }, 15000);
    audio.play().catch(e => {
      console.warn('[TTS] 自动播放被拒', e?.name, e?.message, msgId);
      // 自动播放策略拦截：留着，等用户手势补播；不要丢
      if (e && e.name === 'NotAllowedError') { _pendingAutoplay.push({ msgId, blob }); _armGestureResume(); }
      finish('play 被拒');
    });
  });
}

export function enqueueTTS(text, msgId, showBar = false) {
  const _raw = text;
  text = stripForTTS(text);
  if (!text) { console.warn('[TTS] stripForTTS 后为空，跳过生成', msgId, '原文前30字:', (_raw || '').slice(0, 30)); return; }
  _ttsQueue.push({ text, msgId, showBar });
  console.log('[TTS Queue] 入队', msgId, '待播', _ttsQueue.length, '条，running=', _ttsQueueRunning, '阶段=', _ttsPhase);
  // 看门狗：兜底都失效（超过 8 分钟没进展）就作废当前这一代重跑，别让队列死在那。
  // 积压太多时只留最近 2 条，免得一口气把几分钟前的旧语音全放出来。
  if (_ttsQueueRunning && Date.now() - _ttsQueueTick > 480000) {
    console.warn('[TTS Queue] 队列疑似卡死，强制复位，待播', _ttsQueue.length, '条');
    if (_ttsQueue.length > 2) _ttsQueue.splice(0, _ttsQueue.length - 2);
    _ttsQueueRunning = false;
    _ttsQueueGen++;
  }
  if (!_ttsQueueRunning) _drainTTSQueue();
}

// 巡检：队列卡住时「不生成语音」和「不播语音」是同一个症状 —— 语音的生成就发生在队列循环里，
// 生成完的下一步才是播放。卡在哪一步，后面的消息连生成都轮不到。
// 所以这里盯的是「队列有没有进展」，一旦长时间不动就作废该代重跑。
function _armStallWatch() {
  if (_ttsStallTimer) return;
  _ttsStallTimer = setInterval(() => {
    if (!_ttsQueueRunning) { clearInterval(_ttsStallTimer); _ttsStallTimer = null; return; }
    if (_ttsPhase === 'gen') return;   // 生成阶段有 fetch 超时兜底，别插手
    const tol = _ttsPhase === 'play' ? 240000 : 90000;   // 播放要等长音频，容忍久一点
    const idle = Date.now() - _ttsQueueTick;
    if (idle > tol) {
      console.warn('[TTS Queue] 队列已', Math.round(idle / 1000), '秒无进展（阶段:', _ttsPhase, '），判定卡死，复位重跑');
      _ttsQueueRunning = false;
      _ttsQueueGen++;
      clearInterval(_ttsStallTimer); _ttsStallTimer = null;
      _drainTTSQueue();
    }
  }, 15000);
}

async function _drainTTSQueue() {
  const gen = ++_ttsQueueGen;
  _ttsQueueRunning = true;
  _ttsPhase = 'idle';
  _ttsQueueTick = Date.now();
  _armStallWatch();
  while (_ttsQueue.length) {
    if (gen !== _ttsQueueGen) { console.warn('[TTS Queue] 本代已作废，退出'); return; }
    _ttsQueueTick = Date.now();
    const { text, msgId, showBar } = _ttsQueue.shift();
    try {
      let blob = await _withTimeout(dbGet('ttsCache', msgId), 8000, null);
      if (!blob) {
        _ttsPhase = 'gen';
        _ttsGenerating.set(msgId, Date.now());
        try { blob = await generateTTSBlob(text); }
        finally { _ttsGenerating.delete(msgId); _ttsPhase = 'idle'; _ttsQueueTick = Date.now(); }
        if (blob) {
          await _withTimeout(dbPut('ttsCache', msgId, blob), 8000, null);
          markCached(msgId);
          console.log('[TTS Queue] 语音已生成', msgId, blob.size + 'B');
        } else {
          console.warn('[TTS Queue] 这条没生成出语音，跳过', msgId);
        }
      } else {
        console.log('[TTS Queue] 命中语音缓存', msgId);
      }
      _ttsQueueTick = Date.now();
      const barCtrl = (blob && showBar) ? showVoiceBar(msgId, blob) : null;
      if (blob) await _playBlobAndWait(blob, msgId, barCtrl);
    } catch(e) { console.warn('[TTS Queue] 该条出错，继续下一条：', (e && e.message) || e, msgId); }
    _ttsQueueTick = Date.now();
  }
  if (gen === _ttsQueueGen) { _ttsQueueRunning = false; console.log('[TTS Queue] 队列已播完，清空'); }
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
  let tmpUrl;
  try { tmpUrl = URL.createObjectURL(blob); } catch(e) {
    console.warn('[TTS] showVoiceBar blob不可读，跳过', msgId, e.name);
    bar.remove();
    return null;
  }
  const tmpAudio = new Audio(tmpUrl);
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
    let url;
    try { url = URL.createObjectURL(blob); } catch(e) {
      toast('语音缓存已损坏，请重新生成后下载');
      return;
    }
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
    toast('语音已下载');
  } catch(err) {
    toast(`下载失败：${err.message}`);
    console.error('[TTS DL]', err);
  }
}

export async function regenTTS(text, btnEl, msgId) {
  text = stripForTTS(text);
  if (!text) return;
  const lockTime = _ttsGenerating.get(msgId);
  if (lockTime && Date.now() - lockTime < 120000) { toast('语音生成中，请稍候~'); return; }
  await dbDelete('ttsCache', msgId);
  document.querySelectorAll(`.btn-tts[data-id="${msgId}"],.btn-tts-dl[data-id="${msgId}"]`)
    .forEach(b => b.classList.remove('cached'));
  toast('正在重新生成语音…');
  _ttsGenerating.set(msgId, Date.now());
  try {
    const blob = await generateTTSBlob(text);
    if (!blob) return;
    await dbPut('ttsCache', msgId, blob);
    markCached(msgId);
    playAudioBlob(blob, document.querySelector(`.btn-tts[data-id="${msgId}"]`) || btnEl);
  } catch(err) {
    toast(`TTS 重新生成失败：${err.message}`);
    console.error('[TTS Regen]', err);
  } finally { _ttsGenerating.delete(msgId); }
}

export async function exportTTSCache() {
  try {
    toast('正在打包TTS缓存…');
    const allKeys = await dbGetAllKeys('ttsCache');
    if (!allKeys.length) { toast('TTS缓存是空的，先让炘也说点话～'); return; }

    const _PFX = window.__APP_ID__ === 'choubao' ? 'choubao_' : '';
    const lastExportedKey = Number(localStorage.getItem(_PFX + 'tts_lastExportKey') || '0');
    const newKeys = lastExportedKey ? allKeys.filter(k => k > lastExportedKey) : allKeys;
    if (!newKeys.length) { toast('没有新增语音，上次已全部导出～'); return; }

    const script = document.createElement('script');
    script.src = './lib/jszip.min.js';
    await new Promise((res, rej) => { script.onload = res; script.onerror = rej; document.head.appendChild(script); });

    const zip = new window.JSZip();
    const BATCH = 20;
    const MAX_ZIP_BYTES = 80 * 1024 * 1024; // 80MB上限防OOM
    let _skipped = 0, _totalBytes = 0, _capped = false;
    for (let i = 0; i < newKeys.length; i += BATCH) {
      const batchKeys = newKeys.slice(i, i + BATCH);
      for (const key of batchKeys) {
        try {
          const blob = await dbGet('ttsCache', key);
          if (!blob) { _skipped++; continue; }
          let ab;
          try { ab = await blob.arrayBuffer(); } catch(_e) { _skipped++; continue; }
          if (_totalBytes + ab.byteLength > MAX_ZIP_BYTES) { _capped = true; break; }
          const ext = blob.type?.includes('mp3') ? 'mp3' : 'wav';
          zip.file(`tts_${key}.${ext}`, ab);
          _totalBytes += ab.byteLength;
        } catch(e) {
          _skipped++;
        }
      }
      if (_capped) break;
    }
    if (_skipped) console.warn(`[TTS Export] ${_skipped} 条损坏/空条目已跳过`);

    if (!Object.keys(zip.files).length) { toast('所有语音缓存都已损坏，无法导出'); return; }
    const zipBlob = await zip.generateAsync({ type: 'blob', compression: 'STORE' });
    const _ttsPrefix = window.__APP_ID__ === 'choubao' ? 'choubao' : 'xinye';
    const _exported = Object.keys(zip.files).length;
    const label = lastExportedKey ? `新增${_exported}条` : `${_exported}条`;
    // ⚠️ APK 里 `<a download>` 是哑的（WebView 不处理 blob: 下载），走 saveFile 分流
    await saveFile(zipBlob, `${_ttsPrefix}_tts_cache_${label}.zip`);
    localStorage.setItem(_PFX + 'tts_lastExportKey', String(newKeys[newKeys.length - 1]));
    let msg = `✅ 已打包 ${_exported} 条语音，下载中～`;
    if (_skipped) msg = `✅ 已打包 ${_exported} 条语音（${_skipped}条损坏已跳过），下载中～`;
    if (_capped) msg = `✅ 已打包 ${_exported} 条语音（体积达上限，剩余下次导出），下载中～`;
    toast(msg);
  } catch(err) {
    toast(`导出失败：${err.message}`);
    console.error('[TTS Export]', err);
  }
}
