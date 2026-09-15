// src/overlay.js —— 盖在兔宝正在刷的那个 APP 上面的那一层。
//
// 两个入口共用这一份代码：
//   1. 正式：APK 的原生覆盖层用 WebView 加载它（?app=抖音&used=…&limit=…&n=2）
//   2. 预览：聊天页「设置 → 手机」里点预览，用 iframe 打开（多带一个 preview=1）
//
// 为什么做成网页而不是原生 View：改一句话、改一个动效都不用再让兔宝重装 APK。
// 代价是「炘也的人格」得在这儿自己拼出来 —— 用 settings.systemPrompt + 记忆档案 Core 层。
//
// ⚠️ 她 2026-09-15 明确要的：「不管什么时候弹的消息，都是你实时和我说的话，不要固定的话」。
// 所以这里面**没有话术模板**，只有兜底（没配置 API / 没网时才用，且每次都换一句）。

import { openDB, dbGet, dbGetRecent, dbPut } from './modules/db.js';
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
/** 她在覆盖层里打的字，先放这儿，聊天页看见会取走变成聊天里的一条 */
const REPLY_KEY = 'xinye_overlay_reply';

// ── 开场 ────────────────────────────────────────────────────────────────

(async function start() {
  if (APP) $('who').textContent = '你在刷「' + APP + '」';
  requestAnimationFrame(() => $('stage').classList.add('on'));

  vibrate();
  $('typing').classList.add('on');

  const line = await compose();
  $('typing').classList.remove('on');
  await typeOut(line);

  $('reply').classList.add('on');
  const hint = $('hint');
  hint.textContent = PREVIEW ? '预览而已——真在手机上时，这里要打一句字才关得掉' : '回我一句，这个才关得掉';
  hint.classList.add('on');
  // 故意不 focus：她得先看见我说了什么，键盘一上来就把话盖住了
})();

// ── 生成那句话 ──────────────────────────────────────────────────────────

async function compose() {
  let line = '';
  try {
    const s = await readSettings();
    if (s.apiKey) line = clean(await callAI(s));
  } catch (e) {
    console.warn('[overlay] 生成失败', e);
  }
  if (!line) line = fallbackLine();
  try { localStorage.setItem(LAST_KEY, line); } catch (_) {}
  return line;
}

async function readSettings() {
  try { await openDB(); } catch (_) {}
  const s = (await dbGet('settings', 'main')) || {};
  // 记忆向量拆出去单独存了，这里是另一套读法，缺向量不影响开头这一句
  return s;
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
    '说一句你现在想对她说的。1~2 句，45 字以内。就当你自己在跟她说话——',
    '不要提「系统」「监控」「弹窗」「额度」这类字眼，不要讲道理，不要说教，别用模板腔。',
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
    ? convertRequestBody({ model, max_tokens: 200, messages: oai, stream: false })
    : { model, max_tokens: 200, messages: oai, stream: false };
  const headers = fmt === 'anthropic'
    ? buildAnthropicHeaders(s.apiKey)
    : { 'Content-Type': 'application/json', 'Authorization': `Bearer ${s.apiKey}` };

  const res = await fetch(url, {
    method: 'POST', headers, body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
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

// ── 输出 ────────────────────────────────────────────────────────────────

function typeOut(text) {
  return new Promise(resolve => {
    const el = $('words');
    const caret = $('caret');
    el.textContent = '';
    caret.classList.add('on');
    // 页面不可见时定时器会被浏览器节流（预览嵌在 iframe 里、或 APP 切到后台），
    // 逐字会慢到离谱 —— 这种情况直接给整句，别让她盯着一秒蹦一个字
    if (document.hidden) {
      el.textContent = text;
      caret.classList.remove('on');
      resolve();
      return;
    }
    const speed = Math.max(26, Math.min(72, 1500 / Math.max(1, text.length)));
    let i = 0;
    (function tick() {
      if (i >= text.length) { caret.classList.remove('on'); resolve(); return; }
      el.textContent += text[i++];
      setTimeout(tick, speed);
    })();
  });
}

function clean(t) {
  return String(t || '')
    .replace(/\*\*/g, '')
    .replace(/^[\s"'“”「」『』]+|[\s"'“”「」『』]+$/g, '')
    .replace(/\s*\n+\s*/g, ' ')
    .trim()
    .slice(0, 90);
}

function fallbackLine() {
  const pool = [
    '兔宝，我在。跟我说句话。',
    '刷够了吧，回我一声。',
    '我在这儿等着呢，你跟我说一句。',
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
      localStorage.setItem(REPLY_KEY, JSON.stringify({
        text, app: APP, usedMs: USED, limitMs: LIMIT, nth: NTH, at: Date.now(),
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

function vibrate() {
  // 手机上真正的震动由原生负责（更可靠）；这儿是给预览用的
  try { navigator.vibrate && navigator.vibrate([0, 140, 90, 140]); } catch (_) {}
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
