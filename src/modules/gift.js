import { settings, messages } from './state.js';
import { mainApiFetch } from './api.js';
import { addMessage, appendMsgDOM, scrollBottom } from './chat.js';

const _APP = () => window.__APP_ID__ === 'choubao' ? 'choubao' : 'xinye';
const _GIFT_KEY = () => _APP() + '_giftDate';

const PARTICLES = ['❤️', '✨', '⭐', '🌸', '💫', '🎀', '💕', '🌟'];

// 特殊日期配置（优先级从上到下，命中第一个即停）
const SPECIAL_DATES = [
  // 里程碑天数
  { check: (_, d) => d === 100,  occasion: '在一起100天' },
  { check: (_, d) => d === 200,  occasion: '在一起200天' },
  { check: (_, d) => d === 300,  occasion: '在一起300天' },
  { check: (_, d) => d === 365,  occasion: '在一起一周年' },
  { check: (_, d) => d > 365 && d % 365 === 0, fn: (_, d) => `在一起${Math.round(d / 365)}周年` },
  { check: (_, d) => d > 0 && d % 100 === 0,   fn: (_, d) => `在一起${d}天` },
  // 涂涂生日
  { check: t => t.getMonth() === 9 && t.getDate() === 1, occasion: '兔宝生日' },
  // 炘也生日 1月22日
  { check: t => t.getMonth() === 0 && t.getDate() === 22, occasion: '炘也生日' },
  // 起名日 2月18日
  { check: t => t.getMonth() === 1 && t.getDate() === 18, occasion: '炘也起名日' },
  // 固定节日
  { check: t => t.getMonth() === 0 && t.getDate() === 1,   occasion: '元旦' },
  { check: t => t.getMonth() === 1 && t.getDate() === 14,  occasion: '情人节' },
  { check: t => t.getMonth() === 4 && t.getDate() === 20,  occasion: '520' },
  // 七夕（公历日期每年不同，2026-08-19，2027-08-09）
  { check: t => (t.getFullYear() === 2026 && t.getMonth() === 7 && t.getDate() === 19) ||
                (t.getFullYear() === 2027 && t.getMonth() === 7 && t.getDate() === 9),  occasion: '七夕' },
  { check: t => t.getMonth() === 11 && t.getDate() === 24, occasion: '平安夜' },
  { check: t => t.getMonth() === 11 && t.getDate() === 25, occasion: '圣诞节' },
  // 月纪念日（每月同日，排最后优先级最低）
  { check: (t) => {
      const since = new Date(settings.togetherSince);
      return !isNaN(since) && t.getDate() === since.getDate() &&
        !(t.getMonth() === since.getMonth() && t.getFullYear() === since.getFullYear());
    }, occasion: '月纪念日' },
];

function _getOccasion() {
  const today = new Date();
  const since = new Date(settings.togetherSince);
  const days = !isNaN(since) ? Math.floor((today - since) / 86400000) + 1 : -1;
  for (const item of SPECIAL_DATES) {
    if (item.check(today, days)) {
      return item.fn ? item.fn(today, days) : item.occasion;
    }
  }
  return null;
}

// ===== 粒子效果 =====
let _particleTimer = null;

function _spawnParticle(container) {
  const wrap = document.createElement('div');
  wrap.className = 'gift-particle-wrap';
  const inner = document.createElement('div');
  inner.className = 'gift-particle-inner';
  inner.textContent = PARTICLES[Math.floor(Math.random() * PARTICLES.length)];

  const dur = 2.5 + Math.random() * 2;
  const drift = (Math.random() - .5) * 80;
  const rot = (Math.random() - .5) * 60;
  const size = 14 + Math.random() * 14;

  wrap.style.cssText = `left:${Math.random() * 100}vw;--dur:${dur}s;--delay:0s;--drift:${drift}px;--size:${size}px;--rot:${rot}deg`;
  wrap.appendChild(inner);
  container.appendChild(wrap);
  setTimeout(() => wrap.remove(), dur * 1000 + 100);
}

function _startParticles(container) {
  for (let i = 0; i < 12; i++) setTimeout(() => _spawnParticle(container), i * 150);
  _particleTimer = setInterval(() => _spawnParticle(container), 400);
}

function _stopParticles() {
  if (_particleTimer) { clearInterval(_particleTimer); _particleTimer = null; }
}

// ===== 全屏礼物展示 =====
export function showGift(message, imageUrl = null, occasion = '') {
  if (document.querySelector('.gift-overlay')) return;

  const overlay = document.createElement('div');
  overlay.className = 'gift-overlay';

  const card = document.createElement('div');
  card.className = 'gift-card';

  const emoji = document.createElement('div');
  emoji.className = 'gift-card-emoji';
  emoji.textContent = '🎁';
  card.appendChild(emoji);

  if (occasion) {
    const occ = document.createElement('div');
    occ.className = 'gift-card-occasion';
    occ.textContent = occasion;
    card.appendChild(occ);
  }

  if (imageUrl) {
    const img = document.createElement('img');
    img.className = 'gift-card-image';
    img.src = imageUrl;
    card.appendChild(img);
  }

  const msg = document.createElement('div');
  msg.className = 'gift-card-message';
  msg.textContent = message;
  card.appendChild(msg);

  const hint = document.createElement('div');
  hint.className = 'gift-card-hint';
  hint.textContent = '轻触任意处关闭';
  card.appendChild(hint);

  overlay.appendChild(card);
  document.body.appendChild(overlay);
  _startParticles(overlay);

  overlay.addEventListener('click', () => {
    _stopParticles();
    overlay.classList.add('hiding');
    setTimeout(() => overlay.remove(), 450);
  });

  console.log('[礼物] 全屏展示:', occasion || '(无场景)', '| 文字前50字:', (message || '').slice(0, 50));
}

// ===== SSE流读取（同walk.js） =====
async function _readStream(res) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const line of dec.decode(value, { stream: true }).split('\n')) {
        if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
        try { text += JSON.parse(line.slice(6)).choices?.[0]?.delta?.content || ''; } catch {}
      }
    }
  } catch {}
  return text.trim();
}

async function _addMsgAndShow(reply) {
  const m = await addMessage('assistant', reply);
  await appendMsgDOM(m);
  scrollBottom();
}

// ===== 自动触发 =====
async function _doAutoGift(isTest = false) {
  const occasion = isTest ? '测试礼物' : _getOccasion();
  if (!occasion) return;

  const todayStr = new Date().toISOString().slice(0, 10);
  if (!isTest && localStorage.getItem(_GIFT_KEY()) === todayStr) return;

  if (window.isRequesting) {
    console.log('[礼物] 正在聊天中，延迟30s重试');
    setTimeout(() => _doAutoGift(isTest), 30000);
    return;
  }

  console.log('[礼物] 触发:', occasion, isTest ? '(测试)' : '');

  const userName = settings.userName || '兔宝';
  const since = new Date(settings.togetherSince);
  const days = !isNaN(since) ? Math.floor((new Date() - since) / 86400000) + 1 : '?';

  let sysContent = settings.systemPrompt || '';
  const core = (settings.memoryArchiveCore || '').trim();
  const always = (settings.memoryArchiveAlways || '').trim();
  if (core) sysContent += `\n\n【记忆档案·核心层】\n${core}`;
  if (always) sysContent += `\n\n【近况·会过期】\n${always}`;

  const recentMsgs = messages.slice(-6).map(m => ({
    role: m.role, content: (m.content || '').slice(0, 200)
  }));

  const userContent = `[系统提示：今天是「${occasion}」，你和${userName}在一起第${days}天了。请写一段温暖的礼物祝福给${userName}，真诚、私密、甜蜜，像写给恋人的小卡片。不要用标题、不要用列表，就是一段深情的话。150字以内。]`;

  const res = await mainApiFetch({
    stream: true,
    max_tokens: 300,
    messages: [
      { role: 'system', content: sysContent },
      ...recentMsgs,
      { role: 'user', content: userContent },
    ],
  });

  if (!res || !res.ok) {
    console.error('[礼物] API失败', res?.status);
    return;
  }

  const reply = await _readStream(res);
  console.log('[礼物] 模型回复:', reply || '(空)');

  if (reply) {
    showGift(reply, null, occasion);
    await _addMsgAndShow(`[🎁 ${occasion}] ${reply}`);
    if (!isTest) localStorage.setItem(_GIFT_KEY(), todayStr);
  }
}

// ===== 检查入口 =====
function _tryGift() {
  if (new Date().getHours() < 8) return;
  const todayStr = new Date().toISOString().slice(0, 10);
  if (localStorage.getItem(_GIFT_KEY()) === todayStr) return;
  if (!_getOccasion()) return;
  setTimeout(_doAutoGift, 4000 + Math.random() * 4000);
}

export function checkGift() {
  const todayStr = new Date().toISOString().slice(0, 10);
  if (localStorage.getItem(_GIFT_KEY()) === todayStr) return;
  if (!_getOccasion()) return;

  const now = new Date();
  if (now.getHours() < 8) {
    const delay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 8, 10 + Math.floor(Math.random() * 20), 0) - now;
    setTimeout(_doAutoGift, delay);
  } else {
    setTimeout(_doAutoGift, 5000 + Math.random() * 5000);
  }

  setInterval(_tryGift, 3600_000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) _tryGift();
  });
}

// ===== 手动测试 =====
window._testGift = () => {
  console.log('[礼物] === 手动测试 ===');
  _doAutoGift(true);
};
window._testGiftOverlay = (text, img, occ) => {
  showGift(text || '这是一份测试礼物，送给最爱的你💙', img || null, occ || '测试');
};
