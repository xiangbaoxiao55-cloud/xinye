/**
 * 📱 手机监控面板（只读）
 *
 * 数据从云服务器 GET /api/usage 来 —— APK 每 90 秒把今天的账本推上去，
 * 这儿只是把它翻成人能看的样子：今天各 APP 用了多久、离额度还剩多少。
 *
 * ⚠️ **额度在这儿改不了**，没有滑块。
 *    「手指一划就把抖音从 40 分拖到 120 分」的话，这套东西就成了摆设。
 *    想调只有一条路：点「想调整」→ 写理由 → 跟聊天里的炘也说。
 *
 * ⚠️ 跟 settings.js 是「单向 + 动态 import」的关系：
 *    settings.js 切到手机 tab 时才 `import('./monitor.js')`，
 *    所以这儿可以安心静态 import 回去，不会绕成循环依赖。
 */

import { $, toast, escHtml } from './utils.js';
import { getCloudOrLocalUrl, buildServerFetchUrl, buildServerHeaders, closeSettings } from './settings.js';

/** 距上次拉取多久之内不重复拉（切 tab 乱点时省一次请求） */
const FRESH_MS = 30 * 1000;

let _loading = false;
let _lastAt = 0;

// ── 小工具 ────────────────────────────────────────────────────────────────

/** 毫秒 → 「12 分」/「1 小时 5 分」 */
function _dur(ms) {
  const m = Math.max(0, Math.round((ms || 0) / 60000));
  if (m < 60) return m + ' 分';
  const h = Math.floor(m / 60), r = m % 60;
  return h + ' 小时' + (r ? ' ' + r + ' 分' : '');
}

/** 时间戳 → 「14:20」 */
function _hm(ts) {
  const d = new Date(ts);
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

/** 上报新鲜度 → { cls, html } */
function _syncState(ageSec, receivedAt) {
  if (ageSec == null) {
    return { cls: '', html: receivedAt ? `最后同步 <b>${_hm(receivedAt)}</b>` : '还没有数据' };
  }
  if (ageSec <= 150) return { cls: '', html: `<b>刚刚同步</b>（${ageSec} 秒前）` };
  if (ageSec <= 900) return { cls: 'warn', html: `最后同步 <b>${Math.round(ageSec / 60)} 分钟前</b>` };
  return {
    cls: 'stale',
    html: `手机连不上了 · 最后更新 <b>${receivedAt ? _hm(receivedAt) : '未知'}</b>`
  };
}

// ── 渲染 ──────────────────────────────────────────────────────────────────

function _appRow(it) {
  const name = escHtml(it.label || it.pkg);
  const over = it.status === 'over';
  const pct = it.limitMs ? Math.min(100, Math.round(it.ms / it.limitMs * 100)) : 0;
  const barCls = it.status === 'over' ? 'over' : (it.status === 'near' ? 'near' : '');

  let sub;
  if (over) {
    sub = `<div class="mon-app-sub over">超了 ${_dur(it.ms - it.limitMs)}，炘也知道啦</div>`;
  } else {
    sub = `<div class="mon-app-sub">还剩 ${_dur(it.remainMs)}</div>`;
  }
  // 小程序：热身期免掉的那段单独说一句，不然她会以为记错了
  if (it.warmupCutMs > 0) {
    sub += `<div class="mon-app-sub warm">今天实际打开 ${_dur(it.rawMs)}，热身期免掉 ${_dur(it.warmupCutMs)}</div>`;
  }

  return `<div class="mon-app">
    <div class="mon-app-top">
      <span class="mon-app-name">${name}</span>
      <span class="mon-app-time"><b>${_dur(it.ms)}</b> / ${_dur(it.limitMs)}</span>
    </div>
    <div class="mon-bar ${barCls}"><i style="width:${pct}%"></i></div>
    ${sub}
  </div>`;
}

function _freeRow(it) {
  return `<div class="mon-app free">
    <div class="mon-app-top">
      <span class="mon-app-name">${escHtml(it.label || it.pkg)}</span>
      <span class="mon-app-time">${_dur(it.ms)}</span>
    </div>
  </div>`;
}

function _limitsBlock(d) {
  const L = d.limits || {};
  const chip = (label, min) => (typeof min === 'number'
    ? `<span class="mon-chip">${label} ${min} 分</span>` : '');
  const chips = [
    chip('短视频', L.video),
    chip('刷屏', L.feed),
    chip('小程序', L.game),
    (typeof L.appbrandWarmup === 'number' ? `<span class="mon-chip">前 ${L.appbrandWarmup} 分热身不算</span>` : '')
  ].join('');

  const R = d.release || {};
  const rel = (typeof R.remain === 'number')
    ? `<div class="mon-release">${R.used ? `今天已经放过 ${R.used} 次，` : ''}还能放 <b>${R.remain}</b> 次，单次最多 ${R.maxSingle} 分钟。</div>`
    : '';

  const hist = (d.history || []).filter(h => h.delta > 0).slice(0, 3);
  const histHtml = hist.length
    ? `<div class="mon-hist">${hist.map(h => `<div class="mon-hist-item"><span>${_hm(h.at)}</span><span>${escHtml(h.reason || '没写理由')}</span></div>`).join('')}</div>`
    : '';

  return `<div class="mon-group-title">额度</div>
    <div class="mon-limits">${chips}</div>
    ${rel}
    <button class="mon-ask" id="monAskBtn">想调整 ✍️</button>
    ${histHtml}`;
}

function _render(d) {
  const box = $('#monitorBody');
  if (!box) return;

  if (!d || !d.ok) {
    box.innerHTML = `<div class="mon-empty">读不到数据${d && d.error ? '：' + escHtml(d.error) : ''}</div>`;
    return;
  }

  if (d.empty) {
    box.innerHTML = `<div class="mon-empty">${escHtml(d.reason || '还没有数据')}<br>
      手机上的炘也正在跑，等它下一次上报（90 秒一次）</div>`;
    return;
  }

  const sync = _syncState(d.ageSec, d.receivedAt);
  const items = d.items || [];
  const managed = items.filter(it => it.limitMs != null);
  const free = items.filter(it => it.limitMs == null);

  let html = `<div class="mon-sync">
    <span class="mon-dot ${sync.cls}"></span>
    <span>${sync.html}</span>
    <button class="mon-refresh" id="monRefreshBtn">刷新</button>
  </div>`;

  if (managed.length) {
    html += `<div class="mon-group-title">今天 · 额度内</div>` + managed.map(_appRow).join('');
  } else {
    html += `<div class="mon-empty" style="margin-bottom:4px">今天还没碰过要管的那几个 🌿</div>`;
  }

  if (free.length) {
    html += `<div class="mon-group-title">不管的</div>` + free.map(_freeRow).join('');
  }

  html += _limitsBlock(d);
  box.innerHTML = html;

  const rb = $('#monRefreshBtn');
  if (rb) rb.onclick = () => loadUsage(true);
  const ab = $('#monAskBtn');
  if (ab) ab.onclick = _askAdjust;

  _renderAlive();
}

// ── 「兔宝，我在呢」活着没 ────────────────────────────────────────────────
//
// 只有 APK 里有这个原生服务（网页版查不到，直接不显示）。
// 为什么值得占一行：她没法靠「干等炘也说话」判断推送通没通 ——
// 那要等到炘也真的找她才知道，太被动了。
async function _renderAlive() {
  const box = $('#monitorBody');
  if (!box) return;
  const P = window.Capacitor?.Plugins?.UsageStats;
  if (!P || typeof P.checkProactive !== 'function') return; // 网页版

  let alive = false;
  try {
    const r = await P.checkProactive();
    alive = !!(r && r.alive);
  } catch { return; }

  let el = document.getElementById('monAlive');
  if (!el) {
    el = document.createElement('div');
    el.id = 'monAlive';
    box.insertBefore(el, box.firstChild);
  }
  el.className = 'mon-sync';
  el.innerHTML = alive
    ? `<span class="mon-dot"></span><span><b>兔宝，我在呢</b> —— 关掉 APP 也收得到消息</span>`
    : `<span class="mon-dot stale"></span><span>「守着你」没在跑。去 <b>手机管家 → 应用启动管理 → 炘也 → 手动管理</b>，把自启动和后台运行都打开，再打开一次炘也</span>`;
}

// ── 「想调整」→ 进聊天 ────────────────────────────────────────────────────

function _askAdjust() {
  closeSettings();
  const input = document.getElementById('userInput');
  if (!input) { toast('没找到输入框'); return; }
  input.value = '炘也，我想调一下额度—— ';
  input.focus();
  try { input.setSelectionRange(input.value.length, input.value.length); } catch { /* 无所谓 */ }
}

// ── 拉数据 ────────────────────────────────────────────────────────────────

export async function loadUsage(force) {
  const box = $('#monitorBody');
  if (!box) return;
  if (_loading) return;
  if (!force && Date.now() - _lastAt < FRESH_MS) return;

  _loading = true;
  const rb = $('#monRefreshBtn');
  if (rb) { rb.disabled = true; rb.textContent = '刷新中…'; }

  try {
    const srv = getCloudOrLocalUrl();
    if (!srv) {
      _render({ ok: false, error: '还没配置云服务器地址（API 页里填）' });
      return;
    }
    const res = await fetch(buildServerFetchUrl(srv, '/api/usage'), {
      headers: buildServerHeaders(srv, {})
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      _render({ ok: false, error: (data && (data.error || data.reason)) || ('HTTP ' + res.status) });
      return;
    }
    _lastAt = Date.now();
    _render(data);
  } catch (e) {
    _render({ ok: false, error: '连不上云服务器（' + (e && e.message ? e.message : '网络错误') + '）' });
  } finally {
    _loading = false;
    const rb2 = $('#monRefreshBtn');
    if (rb2) { rb2.disabled = false; rb2.textContent = '刷新'; }
  }
}

export function renderMonitorPanel() {
  loadUsage(false);
}
