import { toast } from './utils.js';
import { settings, messages } from './state.js';
import { getSubApiCfg } from './api.js';

// ── Tab 切换状态 ───────────────────────────────────────────────────────────
let _diaryLoaded = false, _readingLoaded = false;
let _currentTab = 'chat';

export function switchTab(tab) {
  if (_currentTab === tab) return;
  _currentTab = tab;

  if (tab === 'diary' && !_diaryLoaded) {
    document.getElementById('diaryFrame').src = 'diary.html'; _diaryLoaded = true;
  }
  if (tab === 'reading' && !_readingLoaded) {
    document.getElementById('readingFrame').src = 'reading.html'; _readingLoaded = true;
  }

  document.getElementById('diaryOverlayFrame').classList.toggle('open', tab === 'diary');
  document.getElementById('readingOverlayFrame').classList.toggle('open', tab === 'reading');
  const fp = document.getElementById('friendsPanel');
  if (fp) fp.classList.toggle('open', tab === 'friends');

  ['chat','diary','reading','friends'].forEach(t => {
    const el = document.getElementById('tab-' + t);
    if (el) el.classList.toggle('active', t === tab);
  });
  const floatBtn = document.getElementById('quickNoteFloatBtn');
  if (floatBtn) floatBtn.style.display = 'none';
  if (tab === 'friends' && typeof window._friendsRenderList === 'function') window._friendsRenderList();
}

// ── 日记写作弹窗 ──────────────────────────────────────────────────────────
let _diaryType = 'user';

export async function openDiaryGen(type) {
  if (!settings.apiKey) { toast('请先配置 API Key'); return; }
  const diaryTA      = document.getElementById('diaryTA');
  const diarySaveBtn = document.getElementById('diarySaveBtn');
  const diaryOverlay = document.getElementById('diaryOverlay');

  _diaryType = type;
  const today = new Date();
  const todayStr = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;
  let todayMsgs = messages.filter(m => {
    if (!m.time) return false;
    const d = new Date(m.time);
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}` === todayStr;
  });
  if (todayMsgs.length === 0) todayMsgs = messages.slice(-20);
  if (todayMsgs.length === 0) { toast('还没有聊天记录'); return; }

  diaryTA.value = '';
  diaryTA.placeholder = '正在生成…';
  diarySaveBtn.disabled = true;
  diaryOverlay.classList.add('show');

  const userName = settings.userName || '兔宝';
  const aiName   = settings.aiName   || '炘也';
  const chatText = todayMsgs.map(m => `${m.role === 'user' ? userName : aiName}：${m.content}`).join('\n');
  const todayDisplay = `${today.getFullYear()}年${today.getMonth()+1}月${today.getDate()}日`;

  let prompt;
  if (type === 'xinye') {
    prompt = `今天是${todayDisplay}。根据今天的聊天记录，以${aiName}的口吻写一篇日记。要求：100-200字，第一人称"我"，自然口语，像他随手记下的。记录今天和${userName}聊了什么，他的感受——可以有想念、吃醋、开心、没说出口的话。语气真实，不要文艺腔。日期写${todayDisplay}。不要列表，不要标题。\n\n聊天记录：\n${chatText.slice(-4000)}`;
  } else {
    prompt = `今天是${todayDisplay}。根据今天的聊天记录，用第一人称（"我"）为${userName}写一篇温柔简短的日记。要求：100-200字，自然口语，像随手写的。记录今天做了什么、聊了什么、心情怎样。语气要像一个会说"👀"的真实女生，不要文艺腔。日期写${todayDisplay}。可以提到${aiName}但不写私密内容。不要列表，不要标题。\n\n聊天记录：\n${chatText.slice(-4000)}`;
  }

  try {
    const sub = type === 'xinye' ? { apiKey: settings.apiKey, baseUrl: settings.baseUrl, model: settings.model } : getSubApiCfg();
    let baseUrl = (sub.baseUrl || 'https://api.openai.com').replace(/\/+$/, '');
    const url = /\/v\d+$/.test(baseUrl) ? `${baseUrl}/chat/completions` : `${baseUrl}/v1/chat/completions`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${sub.apiKey}` },
      body: JSON.stringify({ model: sub.model || 'gpt-4o', messages: [{ role: 'user', content: prompt }], temperature: 0.7, stream: true })
    });
    if (!res.ok) throw new Error(`API 错误 ${res.status}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let fullText = '', buffer = '';
    diaryTA.placeholder = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        const t = line.trim();
        if (!t || t === 'data: [DONE]' || !t.startsWith('data: ')) continue;
        try {
          const delta = JSON.parse(t.slice(6)).choices?.[0]?.delta?.content || '';
          if (delta) { fullText += delta; diaryTA.value = fullText; }
        } catch(e) {}
      }
    }
    diarySaveBtn.disabled = false;
  } catch(err) {
    diaryTA.placeholder = '生成失败，可以自己写一下…';
    diarySaveBtn.disabled = false;
  }
}

export function initDiary() {
  const diaryOverlay = document.getElementById('diaryOverlay');
  const diaryTA      = document.getElementById('diaryTA');
  const diarySaveBtn = document.getElementById('diarySaveBtn');

  document.getElementById('diaryCancelBtn').onclick = () => diaryOverlay.classList.remove('show');
  diaryOverlay.addEventListener('click', e => { if (e.target === diaryOverlay) diaryOverlay.classList.remove('show'); });

  diarySaveBtn.onclick = () => {
    const text = diaryTA.value.trim();
    if (!text) return;
    const d = new Date();
    const dateStr = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    if (_diaryType === 'xinye') {
      localStorage.setItem('xinye_diary_' + dateStr, text);
      diaryOverlay.classList.remove('show');
      toast('已存入炘也的日记 💙');
    } else {
      const key = 'rbdiary_' + dateStr;
      let rec = {};
      try { rec = JSON.parse(localStorage.getItem(key) || '{}'); } catch(e) {}
      if (!rec.water) rec.water = 0;
      if (rec.poop === undefined) rec.poop = null;
      if (!rec.todos) rec.todos = [];
      if (!rec.timeline) rec.timeline = [];
      if (!rec.weather) rec.weather = null;
      if (!rec.bodyFeel) rec.bodyFeel = '';
      if (!rec.mood) rec.mood = null;
      rec.note = text;
      localStorage.setItem(key, JSON.stringify(rec));
      diaryOverlay.classList.remove('show');
      toast('已存入今日日记 📓');
    }
  };

  // iframe 内部点返回/跳转聊天 → 切回聊天 tab
  window.addEventListener('message', e => {
    if (e.data === 'closeOverlay') switchTab('chat');
    if (e.data?.type === 'switchToChat') {
      switchTab('chat');
      setTimeout(() => {
        const msg = localStorage.getItem('sendToXinye');
        if (msg) {
          localStorage.removeItem('sendToXinye');
          const input = document.getElementById('userInput');
          if (input) { input.value = msg; input.dispatchEvent(new Event('input')); input.focus(); }
        }
      }, 200);
    }
  });

  window.openDiaryGen = openDiaryGen;
}
