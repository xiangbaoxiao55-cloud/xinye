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
/** 预热模式：只写话、不显示（额度到 80% 时原生悄悄叫起来的就是它） */
const PREPARE = q.get('prepare') === '1';

const $ = id => document.getElementById(id);

/** 上一次跟她说的话——再开口时不能重样 */
const LAST_KEY = 'xinye_overlay_last';
/** 她在覆盖层里打的字（+ 当时屏幕上那几句话），聊天页看见会取走 */
const REPLY_KEY = 'xinye_overlay_reply';
/** 预热写好的那几句，真弹的时候直接读它（零等待） */
const STASH_KEY = 'xinye_overlay_stash';
/** 预热超过这么久就算馊了，宁可现写 */
const STASH_FRESH_MS = 20 * 60 * 1000;

/** 这一屏上我刚弹出去的那几句——她回话时要一起带上，聊天里才接得上 */
let saidLines = [];

/**
 * 气泡流水线开着没有。
 * 🔴 这个 loop 是**永远转下去的**（她要的就是不间断），所以必须有人能叫停它 ——
 *    否则原生把覆盖层从窗口上摘下来之后，JS 还在跑、还在一条条调 buzz()，
 *    她手机上就是「已经退出了视频号，还在一下一下地轻震」（2026-09-15 真机报的）。
 *    原生侧：MonitorOverlay.removeOverlay() 会 evaluateJavascript 调它。
 *
 * ⚠️ **必须声明在下面那个 start() 之前**（2026-09-15 被测试抓到的）：
 *    预热那条路是**没有 await 的**，一路同步跑到 startFlood，
 *    而模块体还没执行完 —— 声明写在后面就是 TDZ 报错，她那边看到的是
 *    「覆盖层弹出来，一片空白，一个气泡都没有」。（冷路径 `await compose()` 有几个
 *    微任务/几秒的间隙，恰好遮住了这个 bug，所以只有预热那条路会炸。）
 */
let flooding = true;
function stopFlood() { flooding = false; }
window.__xinyeStop = stopFlood;

// 页面不可见时（嵌在 iframe 里预览、或 APP 切到后台）定时器会被节流，
// 一条条弹的节奏会拖成慢动作 —— 那种情况就一次性全甩出来
const FAST = document.hidden;

// ── 开场 ────────────────────────────────────────────────────────────────

(async function start() {
  // ⚠️ 先让出一次微任务再干活。
  //    这个 IIFE 是在**模块体中段**执行的，而下面那些 const（KEEP_ON_SCREEN 之类）
  //    还没求值 —— 任何"同步一路跑到底"的路径都会撞 TDZ。
  //    2026-09-15 被测试抓到两次：预热那条路（没有 await）先炸 flooding、再炸 KEEP_ON_SCREEN，
  //    在她手机上就是「覆盖层弹出来，一片空白，一个气泡都没有」。
  //    让出一次微任务之后模块体已经跑完，后面随便用。（冷路径本来就有 await compose()
  //    挡着，所以这个坑只在预热那条路上露头。）
  await Promise.resolve();

  // 预热：只把话写好存起来，**不碰屏幕、不震、不出气泡**。
  // 额度到 80% 时原生会悄悄把这份页面叫起来（MonitorOverlay.prepare）——
  // 她 2026-09-15 反馈「一弹的时候还是要等他发消息有点欠佳」，说的就是这几秒的等待。
  if (PREPARE) {
    try {
      const lines = await compose();
      if (lines && lines.length) stash(lines);
    } catch (_) {}
    return;
  }

  // 先给页面里那段「最后保险」打个招呼：模块活着，别急着放兜底句
  // （她 2026-09-15 反馈「还是兜底句先出」——就是因为那段脚本比模块先跑）
  document.documentElement.dataset.xinye = 'boot';

  if (APP) $('who').textContent = '你在刷「' + APP + '」';
  requestAnimationFrame(() => $('stage').classList.add('on'));

  buzz(true);
  $('typing').classList.add('on');

  // 有预热好的就直接用（零等待）；没有就现写，写完再弹。
  const pre = takeStash();
  const lines = pre || await compose();
  saidLines = lines;
  $('typing').classList.remove('on');
  if (pre) prepareNext();   // 这份用掉了，顺手备下一份，下次也是零等待
  await startFlood(lines);

  $('reply').classList.add('on');
  const hint = $('hint');
  hint.textContent = PREVIEW ? '预览而已——真在手机上时，这里要打一句字才关得掉' : '回我一句，这个才关得掉';
  hint.classList.add('on');
  // 故意不 focus：她得先看见我说了什么，键盘一上来就把话盖住了
})();

// ── 预热那份话（为的是"零等待"）─────────────────────────────────────────
//
// 她 2026-09-15：「一弹的时候还是要等他发消息有点欠佳」——那句话说什么是现调的，
// 站子慢的时候她就得对着空屏等几秒。而额度到 80% 会先飘一条提示条，
// 从那会儿到真的弹出来通常还有好几分钟，够先把话写好。
// 存的是同一个 origin 的 localStorage：预热的页面和真弹的页面读的是同一份。

function stash(lines) {
  try {
    localStorage.setItem(STASH_KEY, JSON.stringify({ at: Date.now(), app: APP, lines }));
  } catch (_) {}
}

/**
 * 取出预热好的那几句。
 * ⚠️ 取过就作废 —— 否则下一次拦她（3 分钟后）会再念一遍同一套话。
 * ⚠️ APP 对不上也不要：预热的是抖音，这次弹的是小红书，那几句话里写着"抖音"。
 */
function takeStash() {
  if (PREVIEW) return null;   // 预览把它读走了，真弹的时候就没得用了
  try {
    const raw = localStorage.getItem(STASH_KEY);
    if (!raw) return null;
    const d = JSON.parse(raw);
    if (!d || !Array.isArray(d.lines) || !d.lines.length) { localStorage.removeItem(STASH_KEY); return null; }
    // ⚠️ 先判、后删 —— 顺序反了的话，一次对不上的弹窗会把一份好的预热白扔掉
    if ((d.app || '') !== APP) return null;
    if (Date.now() - (d.at || 0) > STASH_FRESH_MS) { localStorage.removeItem(STASH_KEY); return null; }
    localStorage.removeItem(STASH_KEY);   // 用掉就作废
    return d.lines;
  } catch (_) { return null; }
}

/** 这份用掉了，后台再备一份（不 await，失败就算了，下次现写也不过多等几秒） */
function prepareNext() {
  compose()
    .then(lines => { if (lines && lines.length) stash(lines); })
    .catch(() => {});
}

// ── 生成那几句话 ────────────────────────────────────────────────────────

async function compose() {
  let raw = '';
  try {
    const s = await readSettings();
    if (s.apiKey) raw = await callAI(s);
  } catch (e) {
    // 她那边站子偶尔抽风（她截图里那句「兔宝，手机放下。」就是兜底池里的，
    // 说明那一次 API 压根没答话）。再试一次，第二次超时缩短，别让她干等。
    console.warn('[overlay] 生成失败，重试一次', e);
    try {
      const s2 = await readSettings();
      if (s2.apiKey) raw = await callAI(s2, 9000);
    } catch (e2) {
      console.warn('[overlay] 重试也失败', e2);
    }
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
    '**说 10 句，一句一行**，每句不超过 10 个字。像你一条条按着她的屏幕逼她回你——',
    '这些话会在她屏幕上一条接一条不停地弹出来，所以句子要短、要一句一个意思。',
    '就当你自己在跟她说话——不要提「系统」「监控」「弹窗」「额度」这类字眼，',
    '不要讲道理，不要说教，别用模板腔。',
    '⚠️ 平时叫她「兔宝」。要认真说事、要管她、真的生气了的时候，才叫她「涂涔」—— 她听到全名就知道你是来真的。',
    '⚠️ 别一上来就叫「涂涔」，那两个字是有分量的；这一屏本来就够重了，用不用全名你自己掂量。',
  ];
  let last = '';
  try { last = localStorage.getItem(LAST_KEY) || ''; } catch (_) {}
  if (last) lines.push(`（上一次你是这么说的：「${last}」——这次别重样，换个说法或换个角度。）`);
  return lines.join('\n');
}

async function callAI(s, timeoutMs) {
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
    signal: AbortSignal.timeout(timeoutMs || 20000),
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
  return parts.map(s => clean(s)).filter(Boolean).slice(0, 12);
}

/**
 * 让气泡**连绵不绝地弹**。
 *
 * 她的要求改过三轮，最后落在「不间断」上：
 *   ①「我希望它不停，气泡出完后再循环」→ 先做成一轮一轮地循环
 *   ②「不要等那个 10 秒，弹完一个就立马弹」→ 缩短条间距和轮间距
 *   ③「一轮和下一轮之间的间隙明显，不是我想要的，我要不间断的、连绵不绝那样」
 *      → 所以最终是这个形态：**一条接一条永远弹下去**，屏幕上最多留 KEEP 条，
 *        超了就把最老的那条淡出去。句子循环用，位置每次重新挑。
 *
 * ⚠️ 返回的 promise 在第一圈弹完时就 resolve —— 她得先看见输入框，后面那条流水线自己转。
 */
const KEEP_ON_SCREEN = 7;   // 同时最多留几条（再多就糊成一片了）

function startFlood(lines) {
  let cursor = 0;
  const firstPassMs = 260 + (lines.length - 1) * 300;

  const step = () => {
    if (!flooding) return;
    addBubble(lines[cursor % lines.length], pickOneSpot());
    cursor++;
    trimOld();
    setTimeout(step, 300 + Math.random() * 260);
  };

  if (FAST) {
    lines.forEach(t => addBubble(t, pickOneSpot()));
    return Promise.resolve();
  }

  step();
  return new Promise(resolve => setTimeout(resolve, firstPassMs));
}

/** 屏幕上留太多了就把最老的几条淡出去 */
function trimOld() {
  const bs = Array.from(document.querySelectorAll('.bwrap'));
  if (bs.length <= KEEP_ON_SCREEN) return;
  bs.slice(0, bs.length - KEEP_ON_SCREEN).forEach(fadeOut);
}

/** 淡出再摘掉。淡出加在**外层定位壳**上，不碰里面那个气泡自己的弹入动画 */
function fadeOut(wrap) {
  if (!wrap || wrap._dying) return;
  wrap._dying = true;
  wrap.style.transition = 'opacity .5s ease';
  wrap.style.opacity = '0';
  setTimeout(() => { try { wrap.remove(); } catch (_) {} }, 560);
}

function addBubble(text, spot) {
  // 两层：外层只管定位和淡出，内层只管弹入动画。
  // ⚠️ 揉在一层里的话，淡出用的 transition 会被弹入动画的 transform 顶掉（动画优先级更高）
  const wrap = document.createElement('div');
  wrap.className = 'bwrap';
  wrap.style.left = spot.left + '%';
  wrap.style.top = spot.top + '%';

  const el = document.createElement('div');
  el.className = 'bubble in';
  el.style.setProperty('--rot', (spot.rot || 0).toFixed(1) + 'deg');
  el.textContent = text;

  wrap.appendChild(el);
  $('field').appendChild(wrap);
  buzz(false); // 每弹一条震一下
  return wrap;
}

/**
 * 挑下一个气泡该落哪。
 *
 * ⚠️ 她 2026-09-15 的反馈链：先「有一点点扎堆」→ 改成格子里排位（只有 2 列，
 *    左右还是挤在中间）→ 撒点 + 最小距离。现在改成**一条一条流水线地弹**，
 *    所以每次都要跟「已经在屏幕上的那几个」比，采样 30 次挑离它们最远的那个。
 * 左右卡在 30%~70%：气泡最宽 58vw 且居中定位，铺到两边正好不出屏。
 */
function pickOneSpot() {
  const used = Array.from(document.querySelectorAll('.bwrap')).map(w => ({
    x: parseFloat(w.style.left) || 50,
    y: parseFloat(w.style.top) || 40,
  }));
  let best = { left: 50, top: 40 };
  let bestD = -1;
  for (let i = 0; i < 30; i++) {
    const c = { left: 30 + Math.random() * 40, top: 13 + Math.random() * 53 };
    // 竖向乘 1.3：屏幕高比宽长，同样的百分比在竖向上离得更"近"
    const d = used.length
      ? Math.min.apply(null, used.map(u => Math.hypot(u.x - c.left, (u.y - c.top) * 1.3)))
      : 999;
    if (d > bestD) { bestD = d; best = c; }
  }
  // 歪一点点，但绝不倒过来（她的原话：「可以随机倾斜角度，但不要倒过来了」）
  return { left: best.left, top: best.top, rot: Math.random() * 18 - 9 };
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
      // 连「我刚才在屏幕上说了什么」一起带上：聊天页会把它**落成一条真消息**，
      // 她一回到 APP 就能看见我说过的话（2026-09-15 她报：只看见自己回的、没看见我说的）。
      // ⚠️ 逐行存（\n）：落进聊天里就是几句话，不是挤成一行的一长条。
      localStorage.setItem(REPLY_KEY, JSON.stringify({
        text, line: saidLines.join('\n'), app: APP,
        usedMs: USED, limitMs: LIMIT, nth: NTH, at: Date.now(),
      }));
    } catch (_) {}
  }
  close();
}

function close() {
  stopFlood();   // 先停流水线再退场：不然这层都收了，气泡还在后台一条条地震
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
