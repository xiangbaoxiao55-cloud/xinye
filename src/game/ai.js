// src/game/ai.js —— 把局面交给模型，一次拿回「走哪步 + 说什么 + 心里记一笔」。
//
// 🔴 说明书 §1 的核心原则：**说话的是谁，下棋的就是谁**。
//    代码只当裁判（判合法、判胜负、记历史），**一步棋都不替模型做**。
//    所以这个文件里没有任何"AI 挂了就随便走一步"的兜底 —— 走不了就抛错，
//    由页面显示「他卡住了」+「再问他一次」（说明书 §5.4）。
//
// ⚠️ 为什么不直接用 src/modules/api.js 里的 mainApiFetch：
//    它一路 import 到 settings.js / utils.js，连的是**聊天页**的全局状态和 DOM，
//    在这个独立页面里会出副作用（说明书 §5.1 明说了）。
//    这里照抄 src/overlay.js 的做法 —— 它也是独立页面，已经在真机上跑通了。
//
// ⚠️ 也没有走服务器代理（/api/llm-proxy）。overlay.js 同样是纯直连，真机上是通的。
//    要是哪天她换了必须走代理的站子，这里得补一段 —— 但那时应该先把
//    「拼服务器 URL / 拼鉴权头」抽成共用函数，别在这儿手写第二份（见 AGENTS.md 那条红线）。

import { openDB, dbGet, dbGetRecent } from '../modules/db.js';
import {
  buildEndpointUrl, convertRequestBody, buildAnthropicHeaders, anthropicToOpenAIResponse,
} from '../modules/anthropic.js';

/** ?mock=1 → 不发请求，随机走一步 + 固定台词。测 UI 全流程不花一分钱（说明书 §11.2） */
export const MOCK = new URLSearchParams(location.search).get('mock') === '1';

/** 棋局要"想"，给它 45 秒（说明书 §5.4 建议值） */
const TIMEOUT_MS = 45000;

// ── 本地开关（前缀跟主 APP 一致）─────────────────────────────────────────

function _pfx() { return window.__APP_ID__ === 'choubao' ? 'choubao_' : ''; }

/** 预设列表。和 api.js 读的是同一份 localStorage，只是不 import 它 */
function getPresets() {
  try { return JSON.parse(localStorage.getItem(_pfx() + 'xinye_api_presets') || '[]'); } catch (_) { return []; }
}

/** 大厅「游戏里用的模型」那个下拉要填的选项 */
export function listPresets() { return getPresets(); }

/** 大厅「游戏里用的模型」选的那条预设名；空串 = 跟聊天一样 */
export function getGameModelChoice() {
  try { return localStorage.getItem(_pfx() + 'xinye_game_model') || ''; } catch (_) { return ''; }
}
export function setGameModelChoice(name) {
  try { localStorage.setItem(_pfx() + 'xinye_game_model', name || ''); } catch (_) {}
}

/** 军师开关。默认关（说明书 §1）—— 打开了才把候选点递给他参考 */
export function getAdvisor() {
  try { return localStorage.getItem(_pfx() + 'xinye_game_advisor') === '1'; } catch (_) { return false; }
}
export function setAdvisor(on) {
  try { localStorage.setItem(_pfx() + 'xinye_game_advisor', on ? '1' : '0'); } catch (_) {}
}

// ── 人格 ────────────────────────────────────────────────────────────────

/** ⚠️ 不缓存 —— 她改了 API 配置之后，这个 iframe 不会重新加载模块 */
export async function readSettings() {
  try { await openDB(); } catch (_) {}
  return (await dbGet('settings', 'main')) || {};
}

/** 这一页该怎么称呼他 —— 跟 src/modules/chatsearch.js 的 _aiName() 同一套规矩：
 *  臭宝页的 settings.aiName 出厂值同样是「炘也」（state.js 的默认值不分 app），
 *  所以"没被改过"时按页面自己的默认名来。 */
function _aiName(s) {
  const n = String((s && s.aiName) || '').trim();
  const fallback = window.__APP_ID__ === 'choubao' ? '臭宝' : '炘也';
  return (n && n !== '炘也') ? n : fallback;
}

/** 和 overlay.js 同一套：systemPrompt + 记忆档案 Core 层 */
export function buildSystem(s) {
  const parts = [];
  if (s.systemPrompt && s.systemPrompt.trim()) parts.push(s.systemPrompt.trim());
  const core = String(s.memoryArchiveCore || '').trim();
  if (core) parts.push('【我们之间的档案】\n' + _clip(core, 1800));
  // 🔴 身份**必须显式钉死**，而且放最后（越靠后模型越当回事）。
  //
  // 2026-10-05 兔宝报「他第一手说了『来吧臭宝』」查出来的：
  // 这段是照 overlay.js 抄的，overlay 的兜底是 `'你叫炘也，是兔宝的爱人。…'`，
  // **我抄的时候把名字丢了**，兜底成了「你是兔宝的伴侣。她刚拉你下一局棋…」
  // —— 只要她没自己写过 systemPrompt（出厂值就是空字符串，见 state.js），
  // **整段提示词里就没有一个字告诉他"你叫炘也"**。
  // 而记忆档案是长文本、里面可能提到过别的名字，最近 6 条聊天也会一起塞进去，
  // 于是模型只能自己猜一个名字 —— 猜错了就冒出别的称呼。
  // → 不管 systemPrompt 有没有、写了什么，下面这两句都钉在最后。
  const me = _aiName(s);
  const her = String((s && s.userName) || '').trim() || '兔宝';
  parts.push(`【你是谁】你叫${me}，她叫${her}。现在是你们俩在下一局棋。`);
  return parts.join('\n\n---\n\n');
}

/** 最近几句主聊天 —— 有它，开局时她的话才接得上（说明书 §5.1，建议 6 条） */
async function recentTurns(s, n = 6) {
  try {
    const rows = await dbGetRecent('messages', n, true) || [];
    return rows
      .filter(m => m && typeof m.content === 'string' && m.content.trim())
      .map(m => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.content.slice(0, 220) }));
  } catch (_) { return []; }
}

// ── 调用（带备用预设轮询）────────────────────────────────────────────────
//
// overlay.js 只打一条配置，站子一抽风就整段失败。棋局一次要连几十手，
// 中途挂一次她就得看着「他卡住了」—— 所以这里把主 APP 那套"备用轮换"搬了过来。

function _buildCfg(preset, s) {
  const base = preset
    ? { apiKey: preset.apiKey || s.apiKey, baseUrl: preset.baseUrl || s.baseUrl, model: preset.model || s.model, apiFormat: preset.apiFormat || 'openai' }
    : { apiKey: s.apiKey, baseUrl: s.baseUrl, model: s.model, apiFormat: s.apiFormat || 'openai' };
  const raw = String(base.baseUrl || 'https://api.openai.com').replace(/\/+$/, '');
  const fmt = base.apiFormat === 'anthropic' ? 'anthropic' : 'openai';
  const url = fmt === 'anthropic'
    ? buildEndpointUrl(raw)
    : (/\/v\d+$/.test(raw) ? `${raw}/chat/completions` : `${raw}/v1/chat/completions`);
  return { url, apiKey: base.apiKey, model: base.model || 'gpt-4o', apiFormat: fmt };
}

/** 按顺序试：选中的那条（没选就用主配置）打头，后面跟主配置的备用列表 */
async function _cfgs() {
  const s = await readSettings();
  const presets = getPresets();
  const out = [];
  const choice = getGameModelChoice();
  const hit = choice ? presets.find(p => p.name === choice) : null;
  out.push(_buildCfg(hit || null, s));
  for (const name of (s.fallbackPresetNames || [])) {
    const p = presets.find(x => x.name === name);
    if (p) out.push(_buildCfg(p, s));
  }
  const seen = new Set();
  return out.filter(c => { const k = c.url + '|' + c.model; if (seen.has(k)) return false; seen.add(k); return true; });
}

/**
 * 把一条 message 拆成「正文」和「思考」两条通道。
 * 🔴 2026-10-05：思考型模型（deepseek-r1 / 带 reasoning 的那些）会把正文塞在
 *    `reasoning_content` 里，而 `content` 是**空串** —— 只读 content 就会当成"他一个字没回"。
 *    原来这里用 `content || reasoning_content` 混成一条，结果是"思考 + 正文"粘在一起，
 *    `_parseJSON` 取第一个 `{` 到最后一个 `}` 很容易取到一段拼坏的 JSON。
 *    现在**分开返回**，由 askAI 分别试解析。
 */
function _split(m) {
  return {
    text: String(m?.content ?? '').trim(),
    thinking: String(m?.reasoning_content ?? m?.reasoning ?? m?.thinking ?? '').trim(),
  };
}

/** 页面上/重问时要展示的"他到底回了什么"—— 两条通道谁有就用谁 */
function _body(r) {
  return String((r && (r.text || r.thinking)) || '');
}

async function _once(cfg, messages, maxTokens) {
  const body = cfg.apiFormat === 'anthropic'
    ? convertRequestBody({ model: cfg.model, max_tokens: maxTokens, messages, stream: false })
    : { model: cfg.model, max_tokens: maxTokens, messages, stream: false };
  const headers = cfg.apiFormat === 'anthropic'
    ? buildAnthropicHeaders(cfg.apiKey)
    : { 'Content-Type': 'application/json', 'Authorization': `Bearer ${cfg.apiKey}` };

  const res = await fetch(cfg.url, {
    method: 'POST', headers, body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} ${text.slice(0, 120)}`);

  let j = null;
  try { j = JSON.parse(text); } catch (_) {}

  if (j) {
    const ch = cfg.apiFormat === 'anthropic'
      ? anthropicToOpenAIResponse(j).choices?.[0]
      : j.choices?.[0];
    const { text: t, thinking } = _split(ch?.message);
    return { text: t, thinking, finish: ch?.finish_reason || '' };
  }

  // 有的站子不认 stream:false，照样吐 SSE —— 兜一手
  let out = '', think = '';
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('data: ') || t === 'data: [DONE]') continue;
    try {
      const d = JSON.parse(t.slice(6));
      const dl = d.choices?.[0]?.delta || {};
      out += dl.content || d.delta?.text
        || (d.type === 'content_block_delta' ? d.delta?.text : '') || '';
      // 🔴 这一行原来是缺的：SSE 分支只读 content，思考型模型的正文永远收不到 →
      //    正文空 → 解不出 JSON → 判非法 → 重问 → 还是空 → 「他卡住了」。踩过。
      think += dl.reasoning_content || dl.reasoning || '';
    } catch (_) {}
  }
  return { text: out.trim(), thinking: think.trim(), finish: '' };
}

/**
 * 按顺序试各个配置，返回 `{ text, thinking, finish }`
 * （`finish === 'length'` = 被截断；`thinking` = 思考通道，正文取不到时的退路）。
 * 每个配置最多试 2 次。
 */
async function callAI(messages, maxTokens) {
  const cfgs = await _cfgs();
  if (!cfgs.length || !cfgs[0].apiKey) throw new Error('还没配置 API Key');
  let lastErr = null;
  for (const cfg of cfgs) {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt) await new Promise(r => setTimeout(r, 1500));
      try {
        return await _once(cfg, messages, maxTokens);
      } catch (e) {
        lastErr = e;
        // 超时/主动中断就别在同一个配置上再耗一次了，直接换下一个
        if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) break;
      }
    }
  }
  throw lastErr || new Error('模型没有回应');
}

// ── 提示词 ──────────────────────────────────────────────────────────────

const OUTPUT_SPEC = `【怎么回】
只回一个 JSON，别写别的话、别用 \`\`\` 包起来：
{"move": "H8", "say": "这步先让你得意一下。", "note": "她右下在做活三，下一手堵 K10"}

- move：轮到你落子时必填，写成「列+行」（比如 H8）；这一轮不用你落子就写 null
- say：你要说的话。可以不说（写空串），也可以说好几句 —— 用 \\n 分开，前端会拆成一条条气泡
- note：写给你自己下一手看的备忘，≤80 字。**她看不到这个**，只会在下一轮原样带回给你

说话就按你平时的口气，短一点，别写小作文，别客套。`;

function _now() {
  const n = new Date();
  const wd = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][n.getDay()];
  const p = x => String(x).padStart(2, '0');
  return `${n.getFullYear()}-${p(n.getMonth() + 1)}-${p(n.getDate())} ${p(n.getHours())}:${p(n.getMinutes())} ${wd}`;
}

/** 说明书 §5.2 的组装方式：局面 → 上一手的 note → 桌边话 → 这一轮要他做什么 */
function buildAsk({ rule, state, talk, note, mustMove, hint }) {
  const L = [];
  L.push(`[系统时间: ${_now()}]`);
  L.push('');
  L.push('【现在的局面】');
  L.push(rule.toPromptText(state));

  if (note) {
    L.push('');
    L.push(`【你上一手给自己留的备忘】${note}`);
  }

  if (hint && hint.length) {
    L.push('');
    L.push(`【军师（仅供参考）】代码算出来这几个点看着不错：${hint.join('、')}。要不要采纳、走哪一步，仍然你自己决定。`);
  }

  if (talk && talk.length) {
    L.push('');
    L.push('【这局里你们说过的话】');
    for (const t of talk.slice(-40)) {
      L.push((t.who === 'me' ? '兔宝' : t.who === 'ai' ? '你' : '（系统）') + '：' + t.text);
    }
  }

  L.push('');
  if (mustMove) {
    L.push('【轮到你了】想好走哪一步，按下面的格式回我。');
  } else {
    L.push('【现在是她那边】她在跟你说话，你回一句就行。这一轮不用你落子，move 写 null。');
  }
  L.push('');
  L.push(OUTPUT_SPEC);
  return L.join('\n');
}

// ── 解析（要宽容，说明书 §5.3）──────────────────────────────────────────

function _tryParse(s) {
  try { const o = JSON.parse(s); return (o && typeof o === 'object' && !Array.isArray(o)) ? o : null; } catch (_) { return null; }
}

const _JSON_KEYS = ['move', 'action', 'position', '落子', '坐标', 'say', 'speech', 'text', '说', '台词', 'note', 'memo', '备忘'];

/**
 * 从模型回复里挖出那个 JSON 对象。
 * 🔴 2026-10-05 加固：原来只做「第一个 `{` 到最后一个 `}`」——
 *    思考型模型的 reasoning 里常常**不止一个** `{`（它会把格式示例也复述一遍），
 *    那样切出来是一段拼坏的字符串，`JSON.parse` 必失败 → 判成"没给出 move" → 「他卡住了」。
 *    现在三层兜底：① 整体试 → ② 首尾切片试 → ③ 扫出所有**配对完整**的 `{...}`，
 *    从后往前取（答案通常在思考的最后），优先要带 move/say 这类字段的那个。
 * 导出是为了能单测（`main.js` 用不到）。
 */
export function _parseJSON(raw) {
  const src = String(raw || '').trim();
  if (!src) return null;
  const s = src.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();

  let o = _tryParse(s);
  if (o) return o;

  const i = s.indexOf('{'), j = s.lastIndexOf('}');
  if (i >= 0 && j > i) { o = _tryParse(s.slice(i, j + 1)); if (o) return o; }

  // 扫出所有配对完整的顶层 {...}（要正确跳过字符串里的花括号）
  const cands = [];
  for (let a = 0; a < s.length; a++) {
    if (s[a] !== '{') continue;
    let depth = 0, inStr = false, esc = false, end = -1;
    for (let b = a; b < s.length; b++) {
      const ch = s[b];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') { inStr = true; continue; }
      if (ch === '{') depth++;
      else if (ch === '}') { depth--; if (depth === 0) { end = b; break; } }
    }
    if (end > a) { cands.push(s.slice(a, end + 1)); a = end; }
  }

  const parsed = cands.map(_tryParse).filter(Boolean);
  for (let k = parsed.length - 1; k >= 0; k--) {
    if (_JSON_KEYS.some(key => parsed[k][key] !== undefined)) return parsed[k];
  }
  return parsed.length ? parsed[parsed.length - 1] : null;
}

function _normMove(m) {
  if (m === null || m === undefined || typeof m === 'object') return null;
  const s = String(m).trim();
  if (!s || /^(null|none|无|不落子|-|—|n\/a)$/i.test(s)) return null;
  return s;
}

function _normSay(s) {
  if (Array.isArray(s)) return s.map(x => String(x).trim()).filter(Boolean).join('\n');
  return String(s == null ? '' : s).trim();
}

/** 字段名宽容一点 —— 中文模型有时候会吐中文 key */
function _shape(j) {
  if (!j || typeof j !== 'object') return null;
  return {
    move: _normMove(j.move ?? j.action ?? j.position ?? j.落子 ?? j.坐标),
    say: _normSay(j.say ?? j.speech ?? j.text ?? j.说 ?? j.台词),
    note: String(j.note ?? j.memo ?? j.备忘 ?? j.心里话 ?? '').trim().slice(0, 120),
  };
}

function _whyNot(move) {
  return `「${move}」不是一个能下的位置（坐标要写成 A1~O15 这样，而且必须是空位）`;
}

// ── 对外：他走一手 ──────────────────────────────────────────────────────

/**
 * @returns {Promise<{move:string|null, say:string, note:string}>}
 * @throws  {Error & {code:'NOT_LEGAL'}} 两次都没给出合法步 —— 页面显示「他卡住了」
 */
export async function askAI({ rule, state, talk = [], note = '', mustMove = true, hint = null }) {
  if (MOCK) return _mockTurn(rule, state, mustMove);

  const s = await readSettings();
  const messages = [
    { role: 'system', content: buildSystem(s) + '\n\n' + rule.PROMPT_RULES + '\n\n' + OUTPUT_SPEC },
    ...(await recentTurns(s)),
    { role: 'user', content: buildAsk({ rule, state, talk, note, mustMove, hint }) },
  ];

  // 🔴 2026-10-05 兔宝报「他卡住了、再问他一次还是卡住」查出来的：
  //    原来这儿给的是 **700** —— 对"要算棋"的回合太紧了。
  //    思考型模型会先把 token 花在 reasoning 上，700 用完正文就空了 / 断了，
  //    JSON 解不出来 → 判非法 → 内部重问一次（还是 700）→ 又失败 → 弹「他卡住了」；
  //    而「再问他一次」发的是**一模一样的请求**，所以永远是同一个结果 —— 她感觉"玩不下去了"。
  //    ⚠️ max_tokens 只是**上限**、不是计费量：没用到就不会消耗，调大基本不花钱。
  const BUDGET = 2400;

  /**
   * 两条通道（正文 / 思考）都试一遍，优先挑「move 合法」的那个。
   * 🔴 不能只看正文：思考型模型正文空、答案在 reasoning_content 里，只看正文就永远判"没给 move"。
   */
  const pick = (r) => {
    const cands = [_parseJSON(r.text), _parseJSON(r.thinking)]
      .filter(Boolean).map(_shape).filter(Boolean);
    return cands.find(x => x.move && rule.isLegal(state, x.move)) || cands[0] || null;
  };

  let r = await callAI(messages, BUDGET);
  let out = pick(r);

  // 🔴 非法就带着原因**重新问一次**（说明书 §5.4 第 1 条）
  if (mustMove && (!out || !out.move || !rule.isLegal(state, out.move))) {
    const why = (!out || !out.move)
      ? '你刚才没有给出 move，或者格式不对。'
      : `你给的 ${_whyNot(out.move)}`;
    // 🔑 重问时**把空位直接摊开给他**：不是替他选，只是把"哪些格子还是空的"这个事实说明白
    //    （他可能把上一手的 ◆/◇ 看成了空位，或者把行列看串了）。**走哪一步仍然他自己定。**
    const empties = rule.legalMoves ? rule.legalMoves(state) : [];
    // ⚠️ 上一轮空回复时**不能塞一条 content 为空的 assistant 消息** ——
    //    Anthropic 系的接口会直接 400，OpenAI 系有的也不收。用一句占位保住"一问一答"的交替。
    const prev = _body(r).slice(0, 400) || '（上一轮你没有输出任何内容）';
    const retry = messages.concat([
      { role: 'assistant', content: prev },
      {
        role: 'user',
        content: `${why}\n\n【现在还能下的空位】（共 ${empties.length} 个，从这里挑一个，别的格子都已经被占了）\n`
          + `${empties.join(' ')}\n\n重新想一步。只回那个 JSON，不要写任何解释、不要写思考过程。`,
      },
    ]);
    r = await callAI(retry, BUDGET);
    out = pick(r);
  }

  // 🔴 第二次还不行：**不许由代码替他走**，抛出去让页面问他（说明书 §5.4 第 2 条）
  if (mustMove && (!out || !out.move || !rule.isLegal(state, out.move))) {
    const body = _body(r);
    const e = new Error('他卡住了');
    e.code = 'NOT_LEGAL';
    e.raw = body.slice(0, 300);   // 把原始回复带出去，页面上能看到、能截图
    e.finish = r.finish || '';
    e.why = _whyStuck(rule, out, body);
    throw e;
  }
  return out || { move: null, say: '', note: '' };
}

/** 卡住时告诉页面「到底卡在哪一步」—— 她截图发过来我才查得动（原来只有一句"想不出位置"） */
function _whyStuck(rule, out, body) {
  if (!body) return '他一个字都没回（正文和思考都是空的）';
  if (!out) return '他回了话，但里面没有能解析出来的 JSON';
  if (!out.move) return '他给了 JSON，但 move 是空的';
  if (rule.parseMove && !rule.parseMove(out.move)) return `他给的坐标「${out.move}」看不懂（要 A1~O15 这样）`;
  return `他给的「${out.move}」那一格已经有子了`;
}

// ── 对外：结算总结（说明书 §3）──────────────────────────────────────────

/**
 * 一局下完之后，写一段进主聊天的小结。
 * 有了它，她回到聊天时这件事就"发生过"了 —— 下次正常聊天他也记得输赢。
 */
export async function summarizeGame({ rule, state, talk, result }) {
  if (MOCK) return _mockSummary(state, result);

  const s = await readSettings();
  const seq = state.moves.map(m => (m.color === 'black' ? '黑' : '白') + rule.formatMove(m.c, m.r)).join(' ');
  const L = [];
  L.push(`[系统时间: ${_now()}]`);
  L.push('');
  L.push('这一局下完了，你回到聊天里。');
  L.push(`棋谱：${seq || '（没走几步）'}`);
  L.push(`结果：${result === 'me' ? '兔宝赢了' : result === 'ai' ? '你赢了' : '和棋'}`);
  L.push('');
  L.push('这局里你们说过的话：');
  for (const t of (talk || []).slice(-60)) {
    L.push((t.who === 'me' ? '兔宝' : t.who === 'ai' ? '你' : '（系统）') + '：' + t.text);
  }
  L.push('');
  L.push('写一段小结，≤150 字，第一人称，就你平时的口气。');
  L.push('输了就不服、赢了可以得意、她哪步下得狠、她说过的哪句好笑 —— 挑真的说，别客套。');
  L.push('⚠️ 如果她在这局里说了跟棋无关但重要的事（比如「今天好累」「明天要面试」），**必须**在小结里带一句，不然这句话就丢了。');
  L.push('直接写那段话，不要标题、不要 JSON、不要引号。');

  // 小结也要给够 —— 同样别卡在 500 上（见 askAI 里那段注释）
  const r = await callAI([
    { role: 'system', content: buildSystem(s) + '\n\n' + rule.PROMPT_RULES },
    { role: 'user', content: L.join('\n') },
  ], 1200);
  // 正文空就退回思考通道（思考型模型常见）—— 跟 askAI 一个道理
  return _body(r).trim().slice(0, 300);
}

// ── 假 AI（说明书 §11.2）────────────────────────────────────────────────

const MOCK_TALK = [
  '（假AI）这步先让你得意一下。',
  '（假AI）我看见了。',
  '（假AI）你下得挺凶啊。',
  '（假AI）嗯……让我想想。',
  '（假AI）这局有点意思。',
];
const _pick = a => a[Math.floor(Math.random() * a.length)];

function _mockTurn(rule, state, mustMove) {
  return new Promise(resolve => {
    setTimeout(() => {
      if (!mustMove) { resolve({ move: null, say: _pick(MOCK_TALK), note: '' }); return; }
      const pool = rule.suggestMoves ? rule.suggestMoves(state, 5)
        : (rule.legalMoves ? rule.legalMoves(state) : []);
      if (!pool.length) { resolve({ move: null, say: '（假AI）没地方下了。', note: '' }); return; }
      resolve({ move: _pick(pool), say: _pick(MOCK_TALK), note: '（假 AI 模式，随便下的）' });
    }, 900);
  });
}

function _mockSummary(state, result) {
  const n = state.moves.length;
  const r = result === 'me' ? '又输给你了' : result === 'ai' ? '这局我赢了' : '和棋';
  return `（假 AI 模式的结算卡）${r}，一共走了 ${n} 手。真跑起来的时候，这里会是炘也自己写的一段话。`;
}

// ── 小工具 ──────────────────────────────────────────────────────────────

function _clip(s, max) {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const at = cut.lastIndexOf('\n');
  return (at > max * 0.6 ? cut.slice(0, at) : cut) + '…';
}
