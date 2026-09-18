/**
 * 聊天记录搜索 —— 像 QQ 那样在全部历史里捞一句话。
 *
 * 🔴 改这个文件之前先读这三条，全是踩过的地方：
 *
 *  1. **绝不 dbGetAll('messages')**。三万条消息里混着 base64 的图和语音，
 *     一把读进内存必 OOM。这里全程游标逐条扫，命中的只留
 *     「id + 谁说的 + 时间 + 一百来字片段」，整条记录用完即弃。
 *
 *  2. **不能在一个事务里「扫一批 → setTimeout → 接着扫」**。IDB 事务过了
 *     当前这个微任务就作废，跨 setTimeout 再 continue() 会抛 TransactionInactiveError。
 *     做法是**每轮开一个新事务**，带着上一轮的 key 用 upperBound 接着往前，
 *     轮与轮之间才 setTimeout 让主线程喘气 —— 见 _scanChunk / runChatSearch。
 *     （鸿蒙 WebView 上一条长任务跑到底就是卡死闪退，分批让出不是可选项。）
 *
 *  3. **换关键词 / 关面板要能掐断扫描**：_token 递增，每轮开头比对一次；
 *     命中的数组是**闭包里的局部变量**，否则旧扫描会把结果 push 进新一轮的列表。
 */
import { escHtml, fmtTime, setStatus } from './utils.js';
import { db } from './db.js';
import { settings } from './state.js';

const MAX_HITS = 300;   // 结果上限：再多也没人往下翻，DOM 还要拖垮手机
const CHUNK    = 400;   // 每轮扫多少条
const DEBOUNCE = 450;   // 打字停顿多久自动搜
const CTX_BEFORE = 5;   // 展开上下文时往前带几条（含命中那条）
const CTX_AFTER  = 3;

let _token = 0;         // 扫描代数
let _hits  = [];        // 当前结果（轻量对象）
let _drawn = 0;         // 已经铺进 DOM 的条数
let _terms = [];        // 当前关键词，高亮用
let _who   = 'all';     // all / user / ai
let _debT  = null;
let _raf   = false;
let _bound = false;

const _THINK_RE = /<\s*(?:think|thinking|reasoning)\s*>[\s\S]*?<\s*\/\s*(?:think|thinking|reasoning)\s*>/gi;
const _RATE_RE  = /[<＜〈《]#[\d.]+#[>＞〉》]/g;            // TTS 语速标记
const _STICK_RE = /\[sticker:([^\]]{1,20})\]/g;

function _store() { return window._rpActive ? 'rpMessages' : 'messages'; }

/**
 * 这一页该怎么称呼他。臭宝页的 settings.aiName 出厂值同样是「炘也」
 * （state.js 的默认值不分 app），直接读它会把臭宝页的结果写成「炘也说的」——
 * 所以「没被改过」时按页面自己的默认名来。
 */
function _aiName() {
  const n = (settings.aiName || '').trim();
  const fallback = window.__APP_ID__ === 'choubao' ? '臭宝' : '炘也';
  return (n && n !== '炘也') ? n : fallback;
}

/** 拿一条消息用来搜的正文：多版本的全部候选都算，顺手把内部标记洗成人看得懂的 */
function _plainText(v) {
  if (!v) return '';
  const parts = [];
  if (typeof v.content === 'string' && v.content) parts.push(v.content);
  if (Array.isArray(v.versions)) {
    for (const x of v.versions) if (x && typeof x.content === 'string' && x.content) parts.push(x.content);
  }
  let s = parts.join('\n')
    .replace(_THINK_RE, '')
    .replace(_RATE_RE, '')
    .replace(_STICK_RE, '[贴纸·$1]');
  if (v.isGenImage) s = '[画的图] ' + s;
  return s.replace(/[ \t]{2,}/g, ' ').trim();
}

/** 以第一个命中的词为中心截一段 —— 只留这么多字，长消息不能整条塞进结果列表 */
function _snippet(text, terms) {
  const low = text.toLowerCase();
  let at = -1;
  for (const t of terms) {
    const i = low.indexOf(t);
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  if (at < 0) return text.slice(0, 90).replace(/\s+/g, ' ');
  const a = Math.max(0, at - 30), b = Math.min(text.length, at + 80);
  return (a > 0 ? '…' : '') + text.slice(a, b).replace(/\s+/g, ' ') + (b < text.length ? '…' : '');
}

function _match(v, terms, who) {
  if (!v || typeof v.content !== 'string') return null;
  if (who === 'user' && v.role !== 'user') return null;
  if (who === 'ai'   && v.role !== 'assistant') return null;
  const text = _plainText(v);
  if (!text) return null;
  const low = text.toLowerCase();
  for (const t of terms) if (!low.includes(t)) return null;
  return { id: v.id, role: v.role, time: v.time || 0, snip: _snippet(text, terms) };
}

/**
 * 扫一轮。开一个新事务，从 upperKey（不含）往前取 CHUNK 条。
 * 返回 {n, lastKey}：n 是这轮实际看了几条，lastKey 是最后一条的 key（下一轮的起点）。
 * n < CHUNK 就说明已经到底了。
 * onRecord 返回 false 表示「够了，停下」—— 结果到上限时靠它提前收工，
 * 否则这一轮剩下的几百条会继续往里塞，条数就超过 MAX_HITS 了。
 */
function _scanChunk(store, upperKey, onRecord) {
  return new Promise((resolve, reject) => {
    let tx;
    try { tx = db.transaction(store, 'readonly'); }
    catch (e) { return reject(e); }
    const range = upperKey == null ? null : IDBKeyRange.upperBound(upperKey, true);
    let req;
    try { req = tx.objectStore(store).openCursor(range, 'prev'); }
    catch (e) { return reject(e); }
    let n = 0, lastKey = null, ended = false;
    const finish = () => { if (!ended) { ended = true; resolve({ n, lastKey }); } };
    req.onsuccess = e => {
      const c = e.target.result;
      if (!c) return finish();
      lastKey = c.primaryKey;
      n++;
      let keep = true;
      try { keep = onRecord(c.value) !== false; } catch (_) {}
      if (!keep || n >= CHUNK) return finish();
      c.continue();
    };
    req.onerror = e => reject(e.target.error);
  });
}

function _count(store) {
  return new Promise((resolve, reject) => {
    let tx;
    try { tx = db.transaction(store, 'readonly'); } catch (e) { return reject(e); }
    const req = tx.objectStore(store).count();
    req.onsuccess = () => resolve(req.result);
    req.onerror = e => reject(e.target.error);
  });
}

// ======================== 渲染 ========================

/** 高亮：先按关键词切区间再转义拼接 —— 不能「转义完再 replace」，
 *  那样第二个关键词会命中前一次插进去的 <mark> 标签本身，把 HTML 撕开。 */
function _highlight(snip) {
  const low = snip.toLowerCase();
  const ranges = [];
  for (const t of _terms) {
    let i = 0;
    while ((i = low.indexOf(t, i)) >= 0) { ranges.push([i, i + t.length]); i += t.length; }
  }
  if (!ranges.length) return escHtml(snip);
  ranges.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([r[0], r[1]]);
  }
  let out = '', pos = 0;
  for (const [s, e] of merged) {
    out += escHtml(snip.slice(pos, s)) + '<mark class="cs-mark">' + escHtml(snip.slice(s, e)) + '</mark>';
    pos = e;
  }
  return out + escHtml(snip.slice(pos));
}

function _hitHtml(h) {
  const isMe = h.role === 'user';
  return `<div class="cs-hit">
    <div class="cs-hit-head">
      <span class="cs-hit-who ${isMe ? 'me' : 'ai'}">${escHtml(isMe ? '我' : _aiName())}</span>
      <span class="cs-hit-time">${escHtml(fmtTime(h.time))}</span>
    </div>
    <div class="cs-hit-text">${_highlight(h.snip)}</div>
    <button class="cs-hit-more" onclick="toggleCsCtx(${h.id}, this)">看上下文 ▾</button>
    <div class="cs-hit-ctx" id="csCtx-${h.id}"></div>
  </div>`;
}

function _scheduleDraw() {
  if (_raf) return;
  _raf = true;
  requestAnimationFrame(() => { _raf = false; _flush(); });
}

function _flush() {
  const listEl = document.getElementById('chatSearchList');
  if (!listEl) return;
  let html = '';
  for (let i = _drawn; i < _hits.length; i++) html += _hitHtml(_hits[i]);
  _drawn = _hits.length;
  if (html) listEl.insertAdjacentHTML('beforeend', html);
}

// ======================== 主流程 ========================

function _ensureBind() {
  if (_bound) return;
  const inp = document.getElementById('chatSearchInput');
  if (!inp) return;
  _bound = true;
  inp.addEventListener('input', () => {
    clearTimeout(_debT);
    _debT = setTimeout(runChatSearch, DEBOUNCE);
  });
  inp.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); clearTimeout(_debT); runChatSearch(); }
    else if (e.key === 'Escape') closeChatSearch();
  });
}

export function openChatSearch() {
  const ov = document.getElementById('chatSearchOverlay');
  if (!ov) return;
  _ensureBind();
  ov.style.display = 'flex';
  const chip = document.querySelector('#chatSearchWho [data-who="ai"]');
  if (chip) chip.textContent = `${_aiName()}说的`;
  const inp = document.getElementById('chatSearchInput');
  try { inp.focus(); } catch (_) {}
  // 上次关掉时留着结果就接着看；上次什么都没搜出来才重来一遍
  if (inp && inp.value.trim() && !_hits.length) runChatSearch();
}

export function closeChatSearch() {
  _token++;                          // 掐断还在跑的扫描
  clearTimeout(_debT);
  const ov = document.getElementById('chatSearchOverlay');
  if (ov) ov.style.display = 'none';
}

export function setChatSearchWho(who) {
  _who = who;
  document.querySelectorAll('#chatSearchWho .cs-chip').forEach(b => b.classList.toggle('active', b.dataset.who === who));
  const inp = document.getElementById('chatSearchInput');
  if (inp && inp.value.trim()) runChatSearch();
}

export async function runChatSearch() {
  const inp    = document.getElementById('chatSearchInput');
  const listEl = document.getElementById('chatSearchList');
  const st     = document.getElementById('chatSearchStatus');
  if (!inp || !listEl) return;

  clearTimeout(_debT);
  const kw    = inp.value.trim();
  const token = ++_token;

  const hits = [];                   // 🔴 闭包私有：旧扫描不能写进新列表
  _hits = hits; _drawn = 0; _terms = kw.toLowerCase().split(/\s+/).filter(Boolean);
  listEl.innerHTML = '';

  if (!kw) { setStatus(st, 'search', ''); return; }
  if (!db) { setStatus(st, 'search', '数据还没准备好，稍等一下再搜'); return; }

  const store = _store();
  let total = 0;
  try { total = await _count(store); } catch (_) {}
  if (token !== _token) return;
  setStatus(st, 'search', total ? `正在翻 ${total.toLocaleString()} 条聊天记录…` : '正在翻聊天记录…');

  let upper = null, scanned = 0, capped = false;
  try {
    while (token === _token) {
      const r = await _scanChunk(store, upper, v => {
        const h = _match(v, _terms, _who);
        if (h) { hits.push(h); _scheduleDraw(); }
        if (hits.length >= MAX_HITS) { capped = true; return false; }
      });
      if (token !== _token) return;
      scanned += r.n;
      upper = r.lastKey;
      if (capped || r.n < CHUNK) break;
      setStatus(st, 'search', `已看 ${scanned.toLocaleString()} 条，命中 ${hits.length} 处…`);
      await new Promise(res => setTimeout(res, 0));   // 让主线程喘一口再开下一个事务
    }
  } catch (e) {
    if (token === _token) setStatus(st, 'search', '搜索出错了：' + ((e && e.name) || e));
    return;
  }
  if (token !== _token) return;
  _flush();
  if (!hits.length)       setStatus(st, 'search', `没找到「${kw}」`);
  else if (capped)        setStatus(st, 'search', `命中很多，只显示最近 ${MAX_HITS} 处（换个更具体的词试试）`);
  else                    setStatus(st, 'search', `找到 ${hits.length} 处`);
}

// ======================== 展开上下文 ========================

function _row(v) {
  return { id: v.id, role: v.role, time: v.time || 0, text: _plainText(v) };
}

function _walk(store, range, dir, limit) {
  return new Promise((resolve, reject) => {
    const out = [];
    let tx;
    try { tx = db.transaction(store, 'readonly'); } catch (e) { return reject(e); }
    let req;
    try { req = tx.objectStore(store).openCursor(range, dir); } catch (e) { return reject(e); }
    req.onsuccess = e => {
      const c = e.target.result;
      if (!c) return resolve(out);
      out.push(_row(c.value));
      if (out.length >= limit) return resolve(out);
      c.continue();
    };
    req.onerror = e => reject(e.target.error);
  });
}

export async function toggleCsCtx(id, btn) {
  const box = document.getElementById('csCtx-' + id);
  if (!box) return;
  if (box.dataset.open === '1') {
    box.dataset.open = '0'; box.innerHTML = '';
    if (btn) btn.textContent = '看上下文 ▾';
    return;
  }
  box.dataset.open = '1';
  if (btn) btn.textContent = '看上下文 ▴';
  box.innerHTML = '<div class="cs-ctx-tip">读取中…</div>';

  const store = _store();
  let rows = [];
  try {
    const before = await _walk(store, IDBKeyRange.upperBound(id, false), 'prev', CTX_BEFORE);
    const after  = await _walk(store, IDBKeyRange.lowerBound(id, true),  'next', CTX_AFTER);
    rows = before.reverse().concat(after);
  } catch (_) {}
  if (box.dataset.open !== '1') return;          // 这中间又被收起来了
  if (!rows.length) { box.innerHTML = '<div class="cs-ctx-tip">这段没读出来</div>'; return; }

  box.innerHTML = rows.map(r => {
    const isMe = r.role === 'user';
    return `<div class="cs-ctx-row${isMe ? ' me' : ' ai'}${r.id === id ? ' cur' : ''}">
      <span class="cs-ctx-who">${escHtml(isMe ? '我' : _aiName())}</span>
      <span class="cs-ctx-text">${escHtml(r.text.slice(0, 400))}</span>
      <span class="cs-ctx-time">${escHtml(fmtTime(r.time))}</span>
    </div>`;
  }).join('');
}
