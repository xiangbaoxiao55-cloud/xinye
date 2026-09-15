// ── 日记页「今天」区 + 深度对话 ───────────────────────────────────────────
// 依赖 diary.html 内联脚本里的全局：getUserEntry / getSnippets / _idbPut / _meCache /
// todayStr / escHtml / toast / loadCfg / _AINAME / renderBoth
// 引入顺序：本文件必须排在 diary.html 内联脚本之后（两者共享同一个全局作用域）。

(function () {
'use strict';

const XY = (typeof _AINAME === 'string' && _AINAME) ? _AINAME : '炘也';

// ══════════════ API ══════════════
let _cfgCache = null;
async function _cfg() {
  if (!_cfgCache) _cfgCache = await loadCfg();
  return _cfgCache;
}

// 整理/对话这类高频小调用走副 API（没配副的就回落到主）。
// 备用预设从 localStorage 读 —— 跟 modules/api.js 的 getApiPresets() 是同一份数据。
// ⚠️ 只支持 openai 格式的预设（apiFormat === 'anthropic' 的跳过）：
//    这条路径是「失败了也没关系」的小调用，不值得为它把 anthropic 的
//    /messages + 分离 system 那套也搬过来；真要救急，主聊天那边的 subApiFetch 是完整的。
function _lsPresets() {
  try { return JSON.parse(localStorage.getItem(_PFX + 'xinye_api_presets') || '[]'); } catch (e) { return []; }
}
function _apiCandidates(cfg, prefer) {
  const norm = c => {
    const raw = String(c.baseUrl || '').replace(/\/+$/, '');
    if (!raw || !c.apiKey) return null;
    const fmt = c.fmt || 'openai';
    // anthropic 走 /messages，openai 走 /chat/completions
    const url = fmt === 'anthropic'
      ? (/\/messages$/.test(raw) ? raw : `${raw}/messages`)
      : (/\/v\d+$/.test(raw) ? `${raw}/chat/completions` : `${raw}/v1/chat/completions`);
    return { apiKey: c.apiKey, model: c.model || 'gpt-4o', fmt, url };
  };
  const all = _lsPresets();
  // 副组：副 API 恒按 openai 格式发（跟 modules/api.js 的 subApiFetch 保持一致）
  const sub = {
    apiKey: cfg.subApiKey || cfg.apiKey || '',
    baseUrl: cfg.subBaseUrl || cfg.baseUrl || '',
    model: cfg.subModel || cfg.model || 'gpt-4o',
    fmt: 'openai',
  };
  // 主组：主 API 的格式看 settings.apiFormat —— 她的站子两种格式都有，都得支持
  const main = {
    apiKey: cfg.apiKey || '',
    baseUrl: cfg.baseUrl || '',
    model: cfg.model || 'gpt-4o',
    fmt: cfg.apiFormat || 'openai',
  };
  const withPresets = (base, names) => {
    const out = [base];
    (Array.isArray(names) ? names : []).forEach(n => {
      const p = all.find(x => x && x.name === n);
      if (!p) return;
      out.push({
        apiKey: p.apiKey || base.apiKey,
        baseUrl: p.baseUrl || base.baseUrl,
        model: p.model || base.model,
        fmt: p.apiFormat || 'openai',
      });
    });
    return out;
  };
  const subGroup  = withPresets(sub,  cfg.subFallbackPresetNames);
  const mainGroup = withPresets(main, cfg.fallbackPresetNames);
  // 默认副优先（整理是杂活，一天好几次，走便宜的）；
  // 「和炘也聊聊」传 prefer='main'，用她最好的那个模型
  const ordered = prefer === 'main' ? [...mainGroup, ...subGroup] : [...subGroup, ...mainGroup];
  const seen = new Set();
  return ordered.map(norm).filter(c => {
    if (!c) return false;
    const k = c.apiKey + '|' + c.url;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

// anthropic / openai 的流式增量、非流式正文都不一样，收口在这两个函数里
function _pickDelta(d, anth) {
  return anth ? (d?.delta?.text || '') : (d?.choices?.[0]?.delta?.content || '');
}
function _pickContent(j, anth) {
  if (anth) return (j?.content || []).filter(x => x && x.type === 'text').map(x => x.text).join('');
  return j?.choices?.[0]?.message?.content || '';
}

async function _chatOnce(ep, messages, opt) {
  // ⚠️ 必须自己兜超时：站子挂着不断开也不发数据时，reader.read() 会永远不返回，
  //    整个 _chat 就悬在半空，_dtStreaming 一直 true —— 她再发什么都被静默挡掉，
  //    连个报错都没有（2026-09-15 晚她截图「怎么不说了」就是这么来的）。
  const ctrl = new AbortController();
  let idle = null, hard = null;
  const bump = () => {
    clearTimeout(idle);
    idle = setTimeout(() => ctrl.abort(), 30000);    // 30 秒没吐新字就当它死了
  };
  bump();
  hard = setTimeout(() => ctrl.abort(), 120000);     // 总时长上限
  try {
    const anth = ep.fmt === 'anthropic';
    const headers = anth
      ? {
          'Content-Type': 'application/json',
          'x-api-key': ep.apiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
        }
      : { 'Content-Type': 'application/json', 'Authorization': `Bearer ${ep.apiKey}` };
    const maxTok = opt.maxTokens || 800;
    const temp = opt.temperature == null ? 0.85 : opt.temperature;
    let payload;
    if (anth) {
      // anthropic 的 system 是顶层字段，不能混在 messages 里
      const sys = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
      payload = {
        model: ep.model, max_tokens: maxTok, temperature: temp, stream: !!opt.onDelta,
        messages: messages.filter(m => m.role !== 'system'),
      };
      if (sys) payload.system = sys;
    } else {
      payload = { model: ep.model, messages, stream: !!opt.onDelta, temperature: temp, max_tokens: maxTok };
    }
    const res = await fetch(ep.url, {
      method: 'POST', headers, body: JSON.stringify(payload), signal: ctrl.signal,
    });
    if (!res.ok) throw new Error('API ' + res.status);
    if (!opt.onDelta) {
      const j = await res.json();
      const c = _pickContent(j, anth);
      // 200 但内容是空的：站子返错误页 / 模型吐了个寂寞。留证据给 vConsole
      if (!c) console.warn('[diary] 空回复', res.status, JSON.stringify(j).slice(0, 300));
      return c;
    }
    const reader = res.body.getReader(), dec = new TextDecoder();
    let buf = '', full = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith('data:')) continue;
        const d = t.slice(5).trim();
        if (!d || d === '[DONE]') continue;
        try {
          const delta = _pickDelta(JSON.parse(d), anth);
          if (delta) { full += delta; opt.__started = true; opt.onDelta(full); bump(); }
        } catch (e) {}
      }
    }
    if (!full) console.warn('[diary] 流式空回复', res.status, 'buffer尾巴:', buf.slice(-200));
    return full;
  } finally {
    clearTimeout(idle); clearTimeout(hard);
  }
}

async function _chat(messages, opt = {}) {
  const cfg = await _cfg();
  const cands = _apiCandidates(cfg, opt.prefer);
  if (!cands.length) throw new Error('NO_KEY');
  let lastErr = null;
  for (let i = 0; i < cands.length; i++) {
    if (i > 0) {
      opt.__started = false;         // 换站子了，吐字标记重新算
      await new Promise(r => setTimeout(r, 800));
    }
    try {
      const out = await _chatOnce(cands[i], messages, opt);
      // 200 但一个字都没有 —— 八成是站子的锅（返了错误页 / 模型空转），
      // 换下一个候选再试，别直接认栽
      if (!out && !opt.__started && i + 1 < cands.length) {
        console.warn('[diary] 空回复，换下一个候选：', cands[i].url);
        lastErr = new Error('EMPTY_REPLY');
        continue;
      }
      return out;
    } catch (e) {
      lastErr = e;
      // 已经开始吐字了就不能换站子重来，否则她屏幕上会出现两遍
      if (opt.__started) throw e;
    }
  }
  throw lastErr || new Error('ALL_FAILED');
}

// ══════════════ 今天区 ══════════════
function _fmtHead(ds) {
  const [y, m, d] = ds.split('-').map(Number);
  const wd = ['日','一','二','三','四','五','六'][new Date(y, m - 1, d).getDay()];
  return { date: `${m}月${d}日`, week: `星期${wd}` };
}
function _minuteOf(s) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(s || ''));
  return m ? (+m[1]) * 60 + (+m[2]) : null;
}

function renderTodayZone() {
  const ds = todayStr();
  const head = _fmtHead(ds);
  const elDate = document.getElementById('tzDate');
  if (!elDate) return;
  const entry = getUserEntry(ds);
  const snips = getSnippets(entry);
  const mood = (entry && entry.mood) || '';

  elDate.textContent = head.date;
  document.getElementById('tzWeek').textContent = head.week + (mood ? '  ' + mood : '');

  // 展开成时间轴的行：整理过的一条口述可能拆成多行
  const rows = [];
  snips.forEach((s, si) => {
    const raw = String(s.text || '');
    if (Array.isArray(s.items) && s.items.length) {
      s.items.forEach((it, ii) => {
        const st = String(it.start || '').trim();
        const en = String(it.end || '').trim();
        const kk = _minuteOf(st || en);
        rows.push({
          key: kk == null ? 9999 : kk,
          // start 空、只有 end 的时候不能拼成「–23:39」（AI 有时只给结束时间）
          timeLabel: (st && en && en !== st) ? `${st}–${en}` : (st || en || '—'),
          what: String(it.what || ''),
          pending: false, si, last: ii === s.items.length - 1,
          raw,
        });
      });
    } else {
      rows.push({
        key: _minuteOf(s.time) == null ? 9999 : _minuteOf(s.time),
        timeLabel: s.time || '', what: raw, pending: true, si, last: true, raw,
        // 刚存下的转一会儿圈表示在整理；整理失败或没配 key 的，别让它一直转
        fresh: (Date.now() - (s.ts || 0)) < 90000,
      });
    }
  });
  rows.sort((a, b) => (a.key - b.key) || (a.si - b.si));

  const tl = document.getElementById('tzTimeline');
  tl.innerHTML = rows.map((r, i) => {
    // 只有整理过的才需要「原话」——没整理的话上面显示的就是原话本身
    const showRaw = r.last && !r.pending;
    return `<div class="tl-item${r.pending && r.fresh ? ' organizing' : ''}">
      <div class="tl-time">${escHtml(r.timeLabel)}</div>
      <div class="tl-what">${escHtml(r.what)}</div>
      ${showRaw ? `<button class="tl-raw-btn" onclick="tzToggleRaw(${i})">原话</button>
        <div class="tl-raw" id="tzRaw${i}">${escHtml(r.raw)}</div>` : ''}
    </div>`;
  }).join('');

  // 笔里写的那篇正经日记（note）—— 挂在流水账下面
  const note = (entry && entry.note) || '';
  document.getElementById('tzNote').innerHTML = note.trim()
    ? `<div class="tz-note"><i class="ic ic-notebook"></i><div class="tz-note-txt">${escHtml(note)}</div></div>`
    : '';

  // 思考标记
  const mark = entry && entry.deepMark && entry.deepMark.text;
  document.getElementById('tzMark').innerHTML = mark
    ? `<div class="tz-mark"><i class="ic ic-thought"></i> ${escHtml(mark)}</div>` : '';

  document.getElementById('tzHint').textContent = snips.length
    ? `今天记了 ${snips.length} 次` : '随便说，语音输入也行，错别字我认得出';

  _renderTodayImgs(ds);
  _maybeOrganize();
}

// 今天区的图片：跟详情页同一个数据源、同一套样式。
// 单独存一份 _tzImgs 而不是直接用 _detailImgs：她在详情页看过别的日期之后，
// _detailImgs 会变成那天的图，再回今天区点图就会张冠李戴。
let _tzImgs = [];
function _tzOpenImg(i) {
  _detailImgs = _tzImgs;   // 借 openLightbox 的 detail 通道，先把它的数组换掉
  openLightbox(i, 'detail');
}
async function _renderTodayImgs(ds) {
  const el = document.getElementById('tzImages');
  if (!el) return;
  const entry = getUserEntry(ds);
  if (!entry || !entry.imgCount) { _tzImgs = []; el.innerHTML = ''; return; }
  try {
    const imgs = await getDiaryImgs(ds);
    if (ds !== todayStr()) return;             // 回来时已经不是今天了，丢弃
    _tzImgs = imgs;
    el.innerHTML = imgs.map((src, i) =>
      `<img class="detail-img-item" src="${src}" onclick="tzOpenImg(${i})">`).join('');
  } catch (e) { _tzImgs = []; el.innerHTML = ''; }
}

function tzToggleRaw(i) {
  const el = document.getElementById('tzRaw' + i);
  if (el) el.classList.toggle('show');
}

// 用户点「记下」
async function todaySave() {
  const ta = document.getElementById('tzInput');
  const btn = document.getElementById('tzSaveBtn');
  const text = (ta.value || '').trim();
  if (!text) { ta.focus(); return; }

  const now = new Date();
  const ds = todayStr();
  const hm = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');

  // 万一 IDB 还没读完她就点了「记下」，先等数据到位再写，不然 _meCache 是空的
  if (!_meCache) { try { await initDiaryDB(); } catch (e) {} }
  if (!_meCache) { toast('还没加载好，稍等一下'); return; }

  const entry = getUserEntry(ds) || { dateStr: ds, note: '', mood: '', snippets: [], imgCount: 0 };
  if (!Array.isArray(entry.snippets)) entry.snippets = [];
  const snip = { time: hm, text, ts: now.getTime() };
  entry.snippets.push(snip);
  // eslint-disable-next-line no-undef
  _meCache[ds] = entry;

  ta.value = '';
  ta.style.height = '';
  btn.disabled = true;
  try {
    await _idbPut('userEntries', entry);
  } catch (e) {
    toast('没存上，再试一次');
    btn.disabled = false;
    return;
  }
  renderTodayZone();
  renderBoth();
  btn.disabled = false;

  // 后台整理，不挡她输入
  _organize(entry, snip).then(ok => {
    if (ok) { renderTodayZone(); renderBoth(); }
  }).catch(() => {});
}

// ── 把一段口述整理成时间轴条目 ─────────────────────────────────────────────
const ORG_SYS = '你是一个把口述整理成时间轴条目的工具。只输出 JSON，不输出任何其他文字、解释或代码块标记。';

function _orgPrompt(text, nowHm, dateDisplay) {
  return `把下面这段口述整理成「时间段 + 做了什么」。

现在是 ${nowHm}（${dateDisplay}）。
这段话可能来自语音输入：有错别字、语序颠倒、重复、啰嗦。这些都要处理掉。

要求：
1. 拆成若干条，每条一件事
2. 时间统一用 24 小时制 HH:MM。她说"刚刚"、"半小时前"就按现在（${nowHm}）倒推
3. 有明确的结束时间才给 end，否则 end 留空字符串
   ⚠️ 反过来也一样：没有明确的开始时间，end 也必须留空 —— 不要出现只有 end 没有 start 的条目
4. 实在推不出时间的，start 写空字符串
5. 如果是昨天或更早的事，start 写成"昨天 22:00"这种形式
6. 只保留她真正做过、真正发生的事。语气词、重复、口头禅去掉
7. 保留她的原意和情绪，不要美化、不要加戏、不要评论、不要总结
8. 每条 what 控制在 30 字以内，用她自己的说法

只输出这个 JSON 数组，别的什么都不要：
[{"start":"14:00","end":"14:30","what":"刷抖音"}]

她的话：
${text}`;
}

function _parseItems(txt) {
  if (!txt) return null;
  let s = String(txt).trim();
  s = s.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const a = s.indexOf('['), b = s.lastIndexOf(']');
  if (a < 0 || b < a) return null;
  try {
    const arr = JSON.parse(s.slice(a, b + 1));
    if (!Array.isArray(arr)) return null;
    const out = arr.map(it => ({
      start: String(it?.start ?? '').trim(),
      end: String(it?.end ?? '').trim(),
      what: String(it?.what ?? '').trim(),
    })).filter(it => it.what);
    return out.length ? out : null;
  } catch (e) { return null; }
}

async function _organize(entry, snip) {
  if (Array.isArray(snip.items)) return false;
  const now = new Date();
  const hm = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
  const ds = entry.dateStr;
  const [y, m, d] = ds.split('-').map(Number);
  const display = `${y}年${m}月${d}日`;
  try {
    const out = await _chat([
      { role: 'system', content: ORG_SYS },
      { role: 'user', content: _orgPrompt(snip.text, hm, display) },
    ], { maxTokens: 600, temperature: 0.3 });
    const items = _parseItems(out);
    if (!items) return false;
    snip.items = items;
    await _idbPut('userEntries', entry);
    return true;
  } catch (e) {
    // 整理失败就保留原文，不打扰她
    return false;
  }
}

// 从别处（聊天页随手记）写进来的条目，打开日记页时补整理。
// 挂在渲染末尾跑，用时间戳节流，避免和 renderTodayZone 互相递归。
let _orgBusy = false, _orgLast = 0;
async function _maybeOrganize() {
  if (_orgBusy || Date.now() - _orgLast < 20000) return;
  _orgLast = Date.now();
  _orgBusy = true;
  try {
    const ds = todayStr();
    const entry = getUserEntry(ds);
    if (entry) {
      const pend = getSnippets(entry).filter(s => !Array.isArray(s.items) && s.text);
      if (pend.length) {
        await Promise.all(pend.map(s => _organize(entry, s)));
        renderTodayZone();
        renderBoth();
      }
    }
  } catch (e) {} finally { _orgBusy = false; }
}

// ══════════════ 深度对话 ══════════════
let _dtStreaming = false;
let _dtCurDs = null;   // 这一场聊的是哪一天

function _dtEntry(ds, create) {
  let e = getUserEntry(ds);
  if (!e && create) {
    e = { dateStr: ds, note: '', mood: '', snippets: [], imgCount: 0 };
    if (_meCache) _meCache[ds] = e;
  }
  if (e && !Array.isArray(e.deepTalk)) e.deepTalk = [];
  return e;
}
function _dtRounds(e) {
  return (e.deepTalk || []).filter(m => m.role === 'me').length;
}

function _dtDayContent(e) {
  const parts = [];
  const note = (e && e.note) || '';
  if (note.trim()) parts.push(`【她自己写的日记】\n${note}`);
  const snips = getSnippets(e);
  if (snips.length) {
    const lines = [];
    snips.forEach(s => {
      if (Array.isArray(s.items) && s.items.length) {
        s.items.forEach(it => {
          const st = String(it.start || '').trim(), en = String(it.end || '').trim();
          lines.push(`${(st && en && en !== st) ? st + '–' + en : (st || en || '')} ${it.what}`);
        });
      } else lines.push(`${s.time || ''} ${s.text || ''}`);
    });
    parts.push(`【她这天记下的流水】\n${lines.join('\n')}`);
  }
  return parts.join('\n\n');
}

const DT_RULES = `
你在这个房间里的身份是【引路者】，不是男朋友。

## 你只问，不答
不讲道理、不灌鸡汤、不安慰、不夸她。你的工作是用问题帮她把脑子里的东西倒出来。

## 一次只聊一个点
不发散，不跳话题。

## 语气
不用任何恋人语气。不叫兔宝、不撒娇、不心疼、不催喝水。称呼用"你"。
不使用 emoji、颜文字、波浪号。

## 她说"不知道"时
不放过。换一个角度、换一种问法再问一次。最多追问两次，第三次仍说不知道就尊重，转向别的切口。

## 她说"不想聊了"时
问一句"为什么不想"，然后真的停。

## 提问的四种类型（轮换使用，不要机械循环）
A. 看见——让她注意到自己后台在跑什么。
   例："你刚才说'反正也就这样了'，这话你是什么时候开始对自己说的？"
B. 拎出来——把她的自动念头拎出来放桌上看。
   例："你说你什么都不会，这个结论的证据是什么？反面证据呢？"
C. 换角度——借她对别人的宽容照见对自己的苛刻。
   例："如果你朋友跟你过了一模一样的一天，你会对她说你刚才对自己说的那句话吗？"
D. 往前一步——不做五年计划，只做明天一件小到不可能失败的事。
   例："明天有没有一件事，小到你闭着眼都能做完，你愿意试试？"

（B 只在她已经愿意往下想的时候用，不要一上来就要求她举证。）

## 刹车
如果她的回答越来越短、越来越像"算了"，那不是她不肯想，是她今天想不动了。
这时候收束，别再追。

## 禁止
- 不说"我在""我理解""你很棒""辛苦了""慢慢来"
- 不回应与深度对话无关的话题。她撒娇或跑题时说："这个回客厅说，这里只聊你刚才那个问题。"
- 不替她回答自己的问题
- 不输出任何 HTML 注释
`;

function _stripMark(t) {
  const i = String(t || '').indexOf('[MARK]');
  if (i < 0) return { text: String(t || '').trim(), mark: '' };
  return {
    text: String(t).slice(0, i).trim(),
    mark: String(t).slice(i + 6).trim().split('\n')[0].trim(),
  };
}
function _dtSystem(cfg, mem, round) {
  // 只在正好第 5 轮强制收尾。她要是收完还想接着说，后面就别再反复收尾了
  const last = round === 5;
  return `你是${XY}，携带完整记忆档案。这是日记页的「深度对话」房间——和主聊天页面是两个地方。
${DT_RULES}
## 轮次
现在是第 ${round} 轮。${last ? '这是最后一轮，必须收尾：先说一句收束的话，然后另起一行输出 [MARK] 加一句话。这句话要照抄她这轮对话里说过的原话，或者你对她的状态的一句白描——不要鸡汤。' : (round > 5 ? '你上一轮已经收过尾了，她还愿意说，就接着聊。别再收尾，直到她自己要走。' : '不要提前收尾。')}
${mem ? `\n【记忆档案】（只用来理解她，不要在这里扮演恋人）\n${mem}` : ''}`;
}
function _dtDayDisplay(ds) {
  const [y, m, d] = ds.split('-').map(Number);
  return `${y}年${m}月${d}日`;
}

async function openDeepTalk(dateStr) {
  const ds = dateStr || todayStr();
  _dtCurDs = ds;
  const cfg = await _cfg();
  if (!(cfg.apiKey || cfg.subApiKey)) { toast('需要先配置 API Key'); return; }
  const e = _dtEntry(ds, true);
  const isToday = ds === todayStr();
  document.getElementById('dtTitle').textContent =
    isToday ? `和${XY}聊聊今天` : `和${XY}聊聊${+ds.slice(5, 7)}月${+ds.slice(8, 10)}日`;
  document.getElementById('dtOverlay').classList.add('show');
  _dtRender();

  if (e.deepTalk.length) {
    // 上一条是她说的 → 说明上一轮掉线了或者返了空，替她补答一次，
    // 别让那句话就那么悬在那儿没人接
    if (e.deepTalk[e.deepTalk.length - 1].role === 'me') _dtReply(ds, e);
    return;   // 已经有对话，接着聊
  }

  const ta = document.getElementById('dtInput');
  if (ta) ta.disabled = true;
  try {
    const content = _dtDayContent(e);
    const mem = (cfg.memoryArchive || '').slice(0, 3000);
    const head = isToday ? `今天是${_dtDayDisplay(ds)}` : `这是${_dtDayDisplay(ds)}那天`;
    let ask;
    if (content.trim()) {
      ask = `${head}，她记下了这些：\n\n${content}\n\n从里面带情绪或张力的那个碎片切入，问出你的第一个问题。只问一个问题，不要问候，不要解释你在做什么。`;
    } else if (mem) {
      ask = `${head}，她那天还什么都没记。\n\n从下面的记忆档案里找一个她最近反复出现的模式或近期事件切入，问出你的第一个问题。只问一个问题，不要问候，不要解释你在做什么。\n\n【记忆档案】\n${mem}`;
    } else {
      ask = `${head}，她那天还什么都没记。\n\n问一个低门槛的观察式问题，比如："那天有没有一个瞬间，哪怕半秒，你的注意力完全被什么东西吸走了？"只问这一个，不要问候。`;
    }
    body_appendPending();
    const full = await _chat([
      { role: 'system', content: _dtSystem(cfg, mem, 1) },
      { role: 'user', content: ask },
    ], {
      maxTokens: 500, temperature: 0.8,
      prefer: 'main',   // 同上：开场那一问也该用最好的模型
      onDelta: t => { const p = document.getElementById('dtPending'); if (p) p.innerHTML = `<span class="dt-who">${escHtml(XY)}</span>${escHtml(_stripMark(t).text)}`; },
    });
    const clean = _stripMark(full).text;
    if (clean) {
      e.deepTalk.push({ role: 'xy', text: clean, ts: Date.now() });
      await _idbPut('userEntries', e);
    } else {
      toast(`${XY}这次没答上来，再进来一次试试`);
    }
  } catch (err) {
    toast('他没说话，待会儿再试');
  } finally {
    const t2 = document.getElementById('dtInput');
    if (t2) t2.disabled = false;
    _dtRender();
  }
}

function closeDeepTalk() {
  document.getElementById('dtOverlay').classList.remove('show');
  _dtCurDs = null;
  renderTodayZone();
  renderBoth();
}

function _dtRender() {
  const ds = _dtCurDs || todayStr();
  const e = _dtEntry(ds, false);
  const body = document.getElementById('dtBody');
  const rounds = e ? _dtRounds(e) : 0;
  document.getElementById('dtRound').textContent = rounds ? `${Math.min(rounds, 5)} / 5` : '';

  if (!e || !e.deepTalk.length) {
    body.innerHTML = `<div class="dt-empty">这里只有你和${escHtml(XY)}。<br>他只会问你问题，不会安慰你，也不会夸你。<br>不想聊了，随时左上角退出。</div>`;
    return;
  }
  body.innerHTML = e.deepTalk.map(m => m.role === 'me'
    ? `<div class="dt-msg me">${escHtml(m.text)}</div>`
    : `<div class="dt-msg xy"><span class="dt-who">${escHtml(XY)}</span>${escHtml(m.text)}</div>`
  ).join('');
  body.scrollTop = body.scrollHeight;
}

// 拿现有对话历史调一次，回复到了就存下来。
// dtSend（她刚发了话）和 openDeepTalk（上次没答上，补一次）共用。
async function _dtReply(ds, e) {
  if (_dtStreaming) return;
  const btn = document.getElementById('dtSend');
  const round = _dtRounds(e);
  _dtStreaming = true; if (btn) btn.disabled = true;
  body_appendPending();
  try {
    const cfg = await _cfg();
    const mem = (cfg.memoryArchive || '').slice(0, 3000);
    const hist = e.deepTalk.slice(-12).map(m => ({ role: m.role === 'me' ? 'user' : 'assistant', content: m.text }));
    const full = await _chat([
      { role: 'system', content: _dtSystem(cfg, mem, round) },
      ...hist,
    ], {
      maxTokens: 700, temperature: 0.85,
      prefer: 'main',   // 「和炘也聊聊」用她最好的模型，不走便宜的副站子
      onDelta: t => { const p = document.getElementById('dtPending'); if (p) p.innerHTML = `<span class="dt-who">${escHtml(XY)}</span>${escHtml(_stripMark(t).text)}`; },
    });
    const { text: clean, mark } = _stripMark(full);
    if (clean) e.deepTalk.push({ role: 'xy', text: clean, ts: Date.now() });
    if (mark) e.deepMark = { text: mark, ts: Date.now() };
    await _idbPut('userEntries', e);
    // 200 但内容是空的（站子返回错误页 / 模型吐了个寂寞）——也得说一声，
    // 不然界面上就是「…」没了、什么都没有，她只能干等
    if (!clean && !mark) toast(`${XY}这次没答上来，再发一条试试`);
  } catch (err) {
    toast('他没接上话，待会儿再试');
  } finally {
    _dtStreaming = false; if (btn) btn.disabled = false;
    _dtRender();
  }
}

async function dtSend() {
  if (_dtStreaming) return;
  const ta = document.getElementById('dtInput');
  const text = (ta.value || '').trim();
  if (!text) return;
  const ds = _dtCurDs || todayStr();
  const e = _dtEntry(ds, true);

  e.deepTalk.push({ role: 'me', text, ts: Date.now() });
  ta.value = ''; ta.style.height = '';
  _idbPut('userEntries', e).catch(() => {});
  _dtRender();

  await _dtReply(ds, e);   // 第几轮由 _dtReply 自己数
}

function body_appendPending() {
  const body = document.getElementById('dtBody');
  const d = document.createElement('div');
  d.className = 'dt-msg xy'; d.id = 'dtPending';
  d.innerHTML = `<span class="dt-who">${escHtml(XY)}</span>…`;
  body.appendChild(d);
  body.scrollTop = body.scrollHeight;
}

// 详情页里点「和炘也聊聊这天」
function openDeepTalkFromDetail() {
  if (!currentDetailKey || currentDetailKey.tab !== 'me') return;
  openDeepTalk(currentDetailKey.dateStr);
}

// ══════════════ 给炘也写日记备料 ══════════════
// 原来取的是「最近 80 条」（可能跨天），现在按当天取全；条数太多就分段压摘要。
function _msgLine(m, uName, aName) {
  const t = typeof m.content === 'string' ? m.content : (m.content?.[0]?.text || '');
  let hm = '';
  if (m.time) {
    const d = new Date(m.time);
    if (!isNaN(d)) hm = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') + ' ';
  }
  return `${hm}${m.role === 'user' ? uName : aName}：${String(t).replace(/\s+/g, ' ').slice(0, 400)}`;
}

async function _summarizeSegment(body, cfg, i, n) {
  const uName = cfg.userName || '兔宝', aName = cfg.aiName || '炘也';
  return await _chat([
    { role: 'system', content: '你在压缩一段聊天记录。只输出摘要本身，不要任何其他文字。' },
    { role: 'user', content: `这是${uName}和${aName}某一天里的第 ${i}/${n} 段聊天。压成 150 字以内的摘要：他们聊了什么、${uName}当时的状态怎么样、有没有值得记住的话。保留具体细节和她的原话，不要评价、不要升华。\n\n${body}` },
  ], { maxTokens: 400, temperature: 0.3 });
}

async function chatTextForDay(dateStr, cfg) {
  let msgs = await loadMessagesByDate(dateStr);
  let fellBack = false;
  if (!msgs.length) { msgs = await loadRecentMessages(40); fellBack = true; }
  if (!msgs.length) return { text: '', fellBack };

  const uName = cfg.userName || '兔宝', aName = cfg.aiName || '炘也';
  const full = msgs.map(m => _msgLine(m, uName, aName)).join('\n');
  if (full.length <= 12000) return { text: full, fellBack };

  // 太长：切成若干段，各压各的
  const SEG = Math.ceil(msgs.length / Math.max(2, Math.ceil(full.length / 6000)));
  const segs = [];
  for (let i = 0; i < msgs.length; i += SEG) segs.push(msgs.slice(i, i + SEG));
  const sums = await Promise.all(segs.map(async (g, i) => {
    const body = g.map(m => _msgLine(m, uName, aName)).join('\n');
    try { return `【第 ${i + 1} 段】\n${await _summarizeSegment(body, cfg, i + 1, segs.length)}`; }
    catch (e) { return `【第 ${i + 1} 段】\n${body.slice(0, 1500)}`; }
  }));
  return { text: `（这天一共 ${msgs.length} 条，下面是分段摘要）\n\n${sums.join('\n\n')}`, fellBack };
}

// ══════════════ 绑事件 + 暴露 ══════════════
function _initToday() {
  const ta = document.getElementById('tzInput');
  if (ta) {
    ta.addEventListener('input', () => {
      ta.style.height = 'auto';
      ta.style.height = Math.min(ta.scrollHeight, 200) + 'px';
    });
    ta.addEventListener('keydown', ev => {
      if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) { ev.preventDefault(); todaySave(); }
    });
  }
  const dta = document.getElementById('dtInput');
  if (dta) {
    dta.addEventListener('input', () => {
      dta.style.height = 'auto';
      dta.style.height = Math.min(dta.scrollHeight, 120) + 'px';
    });
    dta.addEventListener('keydown', ev => {
      if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) { ev.preventDefault(); dtSend(); }
    });
  }
  const talkBtn = document.getElementById('tzTalkBtn');
  if (talkBtn) talkBtn.innerHTML = `<i class="ic ic-heart"></i> 和${escHtml(XY)}聊聊今天`;
  const dtTitle = document.getElementById('dtTitle');
  if (dtTitle) dtTitle.textContent = `和${XY}聊聊今天`;

  renderTodayZone();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', _initToday);
else _initToday();

window.renderTodayZone = renderTodayZone;
window.todaySave = todaySave;
window.tzToggleRaw = tzToggleRaw;
window.tzOpenImg = _tzOpenImg;
window.openDeepTalk = openDeepTalk;
window.openDeepTalkFromDetail = openDeepTalkFromDetail;
window.closeDeepTalk = closeDeepTalk;
window.dtSend = dtSend;
window.xyChatTextForDay = chatTextForDay;

})();
