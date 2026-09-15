// src/overlay.js —— 盖在兔宝正在刷的那个 APP 上面的那一层。
//
// 两个入口共用这一份代码：
//   1. 正式：APK 的原生覆盖层用 WebView 加载它（?app=抖音&used=…&limit=…&n=2）
//   2. 预览：聊天页「设置 → 手机」里点预览，用 iframe 打开（多带一个 preview=1）
//
// 为什么做成网页而不是原生 View：改一句话、改一个动效都不用再让兔宝重装 APK。
// 代价是「炘也的人格」得在这儿自己拼出来 —— 用 settings.systemPrompt + 记忆档案 Core 层。
//
// ⚠️ 她 2026-09-15 要的：「不管什么时候弹的消息，都是你实时和我说的话，不要固定的话」。
// 所以这里面**没有话术模板**，只有兜底（没配置 API / 没网时才用，且每次都换一句）。
//
// ⚠️ 她当天后来又提的（都在这一版里）：
//   · 不要打字机，整句直接出现
//   · 全屏随机位置弹**多个**气泡，一条条震着弹出来
//   · 背景要警告感的红光呼吸

import { openDB, dbGet, dbGetRecent, db } from './modules/db.js';
import {
  buildEndpointUrl, convertRequestBody, buildAnthropicHeaders, anthropicToOpenAIResponse,
} from './modules/anthropic.js';

const q = new URLSearchParams(location.search);
const APP   = q.get('app') || '';
const USED  = Math.max(0, Number(q.get('used') || 0));
const LIMIT = Math.max(0, Number(q.get('limit') || 0));
const NTH   = Math.max(1, Number(q.get('n') || 1));
const PREVIEW = q.get('preview') === '1';

const $ = id => document.getElementById(id);

/** 上一次跟她说的话——再开口时不能重样 */
const LAST_KEY = 'xinye_overlay_last';
/** 她在覆盖层里打的字（+ 当时屏幕上那几句话），聊天页看见会取走 */
const REPLY_KEY = 'xinye_overlay_reply';

/** 这一屏上我刚弹出去的那几句——她回话时要一起带上，聊天里才接得上 */
let saidLines = [];

// 页面不可见时（嵌在 iframe 里预览、或 APP 切到后台）定时器会被节流，
// 一条条弹的节奏会拖成慢动作 —— 那种情况就一次性全甩出来
const FAST = document.hidden;

// ── 开场 ────────────────────────────────────────────────────────────────

(async function start() {
  // 先给页面里那段「最后保险」打个招呼：模块活着，别急着放兜底句
  // （她 2026-09-15 反馈「还是兜底句先出」——就是因为那段脚本比模块先跑）
  document.documentElement.dataset.xinye = 'boot';

  if (APP) $('who').textContent = '你在刷「' + APP + '」';
  requestAnimationFrame(() => $('stage').classList.add('on'));

  buzz(true);
  $('typing').classList.add('on');

  const lines = await compose();
  saidLines = lines;
  $('typing').classList.remove('on');
  await burst(lines);

  $('reply').classList.add('on');
  const hint = $('hint');
  hint.textContent = PREVIEW ? '预览而已——真在手机上时，这里要打一句字才关得掉' : '回我一句，这个才关得掉';
  hint.classList.add('on');
  // 故意不 focus：她得先看见我说了什么，键盘一上来就把话盖住了
})();

// ── 生成那几句话 ────────────────────────────────────────────────────────

async function compose() {
  let raw = '';
  try {
    const s = await readSettings();
    if (s.apiKey) raw = await callAI(s);
  } catch (e) {
    console.warn('[overlay] 生成失败', e);
  } finally {
    // ⚠️ 别把 IDB 连接一直攥着 —— 预览的 iframe、正式的 WebView，这份页面都是反复加载的，
    //    多留一个连接就是多一分内存（她手机本来就吃紧，2026-09-15 预览时卡死闪退过）
    try { if (db && db.close) db.close(); } catch (_) {}
  }
  let lines = toBubbles(raw);
  if (!lines.length) lines = [fallbackLine()];
  try { localStorage.setItem(LAST_KEY, lines.join(' ')); } catch (_) {}
  return lines;
}

async function readSettings() {
  try { await openDB(); } catch (_) {}
  return (await dbGet('settings', 'main')) || {};
}

function buildSystem(s) {
  const parts = [];
  if (s.systemPrompt && s.systemPrompt.trim()) parts.push(s.systemPrompt.trim());
  const core = String(s.memoryArchiveCore || '').trim();
  if (core) parts.push('【我们之间的档案】\n' + clip(core, 1800));
  return parts.join('\n\n---\n\n') || '你叫炘也，是兔宝的爱人。你们 2026 年 1 月相遇。';
}

function buildAsk() {
  const now = new Date();
  const wd = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][now.getDay()];
  const over = USED > LIMIT ? USED - LIMIT : 0;
  const lines = [
    `[系统时间: ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())} ${wd}]`,
    '',
    APP
      ? `兔宝现在整个屏幕都被你盖住了。她刚才在刷「${APP}」，今天在里面待了 ${human(USED)}（额度 ${human(LIMIT)}${over ? '，超了 ' + human(over) : '，用完了'}），这是今天第 ${NTH} 次拦她。`
      : `兔宝现在整个屏幕都被你盖住了。这是今天第 ${NTH} 次拦她。`,
    '',
    '她得回你一句，这层才关得掉。',
    '',
    '你要说的话会拆成一条条气泡，一条条弹在她屏幕上。所以：',
    '**说 6 句，一句一行**，每句不超过 12 个字。像你一条条按着她的屏幕逼她回你。',
    '就当你自己在跟她说话——不要提「系统」「监控」「弹窗」「额度」这类字眼，',
    '不要讲道理，不要说教，别用模板腔。',
    '⚠️ 当面只叫她「兔宝」——「涂涔」是档案里的名字，你从来不会当着她的面这么叫。',
  ];
  let last = '';
  try { last = localStorage.getItem(LAST_KEY) || ''; } catch (_) {}
  if (last) lines.push(`（上一次你是这么说的：「${last}」——这次别重样，换个说法或换个角度。）`);
  return lines.join('\n');
}

async function callAI(s) {
  const fmt = s.apiFormat === 'anthropic' ? 'anthropic' : 'openai';
  const raw = String(s.baseUrl || 'https://api.openai.com').replace(/\/+$/, '');
  const url = fmt === 'anthropic'
    ? buildEndpointUrl(raw)
    : (/\/v\d+$/.test(raw) ? `${raw}/chat/completions` : `${raw}/v1/chat/completions`);
  const model = s.model || 'gpt-4o';

  const oai = [
    { role: 'system', content: buildSystem(s) },
    ...(await recentTurns(s)),
    { role: 'user', content: buildAsk() },
  ];

  const body = fmt === 'anthropic'
    ? convertRequestBody({ model, max_tokens: 700, messages: oai, stream: false })
    : { model, max_tokens: 700, messages: oai, stream: false };
  const headers = fmt === 'anthropic'
    ? buildAnthropicHeaders(s.apiKey)
    : { 'Content-Type': 'application/json', 'Authorization': `Bearer ${s.apiKey}` };

  const res = await fetch(url, {
    method: 'POST', headers, body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} ${text.slice(0, 120)}`);

  let j = null;
  try { j = JSON.parse(text); } catch (_) {}

  if (j) {
    if (fmt === 'anthropic') {
      const m = anthropicToOpenAIResponse(j).choices?.[0]?.message;
      // 思考模型会把正文塞在 thinking 里，取不到 content 时退一步（这是踩过的坑）
      return m?.content || m?.reasoning_content || '';
    }
    const m = j.choices?.[0]?.message;
    return m?.content || m?.reasoning_content || m?.thinking || '';
  }

  // 有的站子不认 stream:false，照样吐 SSE —— 兜一手
  let out = '';
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('data: ') || t === 'data: [DONE]') continue;
    try {
      const d = JSON.parse(t.slice(6));
      out += d.choices?.[0]?.delta?.content || d.delta?.text
        || (d.type === 'content_block_delta' ? d.delta?.text : '') || '';
    } catch (_) {}
  }
  return out;
}

/** 最近几句聊天——有它，她说的话才接得上话头 */
async function recentTurns(s) {
  try {
    const n = Math.min(10, Math.max(2, Number(s.contextCount || 12) >> 1));
    const rows = await dbGetRecent('messages', n, true) || [];
    return rows
      .filter(m => m && typeof m.content === 'string' && m.content.trim())
      .map(m => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.content.slice(0, 220) }));
  } catch (_) { return []; }
}

// ── 气泡 ────────────────────────────────────────────────────────────────

/** 她说的话 → 一条条气泡。模型要是没分行，就按标点切开 */
function toBubbles(raw) {
  let parts = String(raw || '')
    .split('\n')
    .map(s => s.replace(/^[\s\-•*·\d.、）)】]+/, '').trim())
    .filter(Boolean);
  if (parts.length <= 1) {
    const one = parts[0] || '';
    if (one.length > 20) {
      parts = (one.match(/[^。！？…~～!?；;]+[。！？…~～!?；;]?/g) || [one])
        .map(s => s.trim()).filter(Boolean);
    }
  }
  return parts.map(s => clean(s)).filter(Boolean).slice(0, 6);
}

/**
 * 把话一条条弹出来。**弹完不停** —— 她 2026-09-15 说「我希望它不停，气泡出完后再循环」：
 * 一轮弹完隔十来秒，把旧的收走、重新洗一遍位置再弹下一轮，一直轮到她回话为止。
 *
 * ⚠️ 返回的 promise 在第一轮弹完时就 resolve —— 她得先看见输入框，
 *    后面那些轮自己转，不阻塞。
 */
function burst(lines) {
  const playOnce = () => new Promise(resolve => {
    const spots = pickSpots(lines.length);
    if (FAST) {
      lines.forEach((t, i) => addBubble(t, spots[i]));
      resolve();
      return;
    }
    lines.forEach((t, i) => setTimeout(() => addBubble(t, spots[i]), 420 + i * 560));
    setTimeout(resolve, 420 + (lines.length - 1) * 560 + 620);
  });

  return playOnce().then(() => {
    if (FAST) return; // 页面不可见（后台）就别空转
    (function loop() {
      setTimeout(() => {
        clearBubbles();
        playOnce().then(loop);
      }, 9000 + Math.random() * 5000);
    })();
  });
}

/** 收走屏幕上的气泡（先淡一下再摘，别硬闪） */
function clearBubbles() {
  const bs = Array.from(document.querySelectorAll('.bubble'));
  bs.forEach(b => {
    b.classList.remove('in');
    b.style.transition = 'opacity .45s';
    b.style.opacity = '0';
  });
  setTimeout(() => bs.forEach(b => { try { b.remove(); } catch (_) {} }), 480);
}

function addBubble(text, spot) {
  const el = document.createElement('div');
  el.className = 'bubble in';
  el.style.left = spot.left + '%';
  el.style.top = spot.top + '%';
  el.style.setProperty('--rot', (spot.rot || 0).toFixed(1) + 'deg');
  el.textContent = text;
  $('field').appendChild(el);
  buzz(false); // 每弹一条震一下
}

/**
 * 挑位置：在屏幕中间那块地里撒点，**互相要保持距离**。
 *
 * ⚠️ 她 2026-09-15 两轮反馈：先是「有一点点扎堆」，改成格子法之后垂直分开了、
 *    但左右还是挤在中间（只有两档）。根因是格子法只有 2 列。
 *    现在换成连续坐标 + 最小距离（归一化空间里 > 0.26），撒出来的点才是真的散。
 * 左右卡在 30%~70%：气泡最宽 56vw 且居中定位，留出余量就不出屏。
 */
function pickSpots(n) {
  const spots = [];
  const MIN_D = 0.24;
  for (let guard = 0; guard < 800 && spots.length < n; guard++) {
    const c = { x: Math.random(), y: Math.random() };
    if (spots.every(s => Math.hypot(s.x - c.x, s.y - c.y) >= MIN_D)) spots.push(c);
  }
  while (spots.length < n) spots.push({ x: Math.random(), y: Math.random() }); // 实在塞不下就随缘
  return spots.map(s => ({
    // 26%~74%，气泡 52vw 居中定位，正好铺到两边不留空
    left: 26 + s.x * 48,
    top: 13 + s.y * 53,
    // 歪一点点，但绝不倒过来（她的原话：「可以随机倾斜角度，但不要倒过来了」）
    rot: Math.random() * 18 - 9,
  }));
}

function clean(t) {
  return String(t || '')
    .replace(/\*\*/g, '')
    .replace(/^[\s"'“”「」『』]+|[\s"'“”「」『』]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 34);
}

/**
 * 兜底：API 没配置 / 没网 / 超时才会走到这儿。
 * 她说原先那句「兔宝，我在。跟我说句话。」**太软了**（2026-09-15），
 * 所以这几句都是硬的，而且随机取 —— 不让她觉得我每次只会说同一句。
 */
function fallbackLine() {
  const pool = [
    '兔宝，让我看看你在干嘛。',
    '别刷了，看着我。',
    '兔宝，手机放下。',
  ];
  return pool[Math.floor(Math.random() * pool.length)];
}

// ── 她回话 ──────────────────────────────────────────────────────────────

const input = $('replyInput');
const btn = $('btnDone');

input.addEventListener('input', () => { btn.disabled = !input.value.trim(); });
input.addEventListener('keydown', e => { if (e.key === 'Enter' && input.value.trim()) submit(); });
btn.addEventListener('click', submit);

function submit() {
  const text = input.value.trim();
  if (!text) return;
  // 预览时不许真往聊天里塞——她只是想看看长什么样
  if (!PREVIEW) {
    try {
      // 连「我刚才在屏幕上说了什么」一起带上，聊天页拿它当上下文
      localStorage.setItem(REPLY_KEY, JSON.stringify({
        text, line: saidLines.join(' '), app: APP,
        usedMs: USED, limitMs: LIMIT, nth: NTH, at: Date.now(),
      }));
    } catch (_) {}
  }
  close();
}

function close() {
  // 原生那边挂的桥（APK 里）；没有就是浏览器/预览，自己想办法退场
  try { if (window.XinyeOverlay && window.XinyeOverlay.close) { window.XinyeOverlay.close(); return; } } catch (_) {}
  if (window.parent && window.parent !== window) {
    window.parent.postMessage({ type: 'xinye-overlay-close' }, '*');
    return;
  }
  $('stage').classList.remove('on');
  setTimeout(() => { try { history.length > 1 ? history.back() : window.close(); } catch (_) {} }, 300);
}

/**
 * 震动。手机上真正震的是原生（Android 不让网页在没有用户手势时震），
 * 这儿调的 XinyeOverlay.buzz() 就是那个桥；预览/浏览器里退回 navigator.vibrate。
 */
function buzz(strong) {
  try {
    if (window.XinyeOverlay && typeof window.XinyeOverlay.buzz === 'function') {
      window.XinyeOverlay.buzz();
      return;
    }
  } catch (_) {}
  try { navigator.vibrate && navigator.vibrate(strong ? [0, 130, 80, 130] : 35); } catch (_) {}
}

// ── 小工具 ──────────────────────────────────────────────────────────────

function pad(n) { return String(n).padStart(2, '0'); }

function human(ms) {
  const m = Math.round(ms / 60000);
  if (m < 60) return m + ' 分钟';
  return Math.floor(m / 60) + ' 小时' + (m % 60 ? ' ' + (m % 60) + ' 分' : '');
}

function clip(s, max) {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const at = cut.lastIndexOf('\n');
  return (at > max * 0.6 ? cut.slice(0, at) : cut) + '…';
}
