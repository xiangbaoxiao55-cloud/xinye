// src/game/main.js —— 游戏页的控制器：大厅 / 对局 / 结算三态、回合调度、落子渲染。
//
// 🔑 这个文件**不感知具体是哪个游戏**：它只认规则模块那五个函数
//    （createGame / applyMove / isLegal / winner / toPromptText）。
//    加飞行棋的时候，在下面 GAMES 里加一行、写一个规则文件就完了。
//
// 回合调度照说明书 §7：
//   · 全局同时只允许一个在途的 AI 请求（busy 锁）
//   · 轮到他：立刻发请求，等待期间她照样能打字（话进桌边，随下一次请求带上）
//   · 轮到她、她只是在说话：停止输入 1.5 秒后合并发一次「只说话」请求（move:null）
//   · 他回包：先落子（带动画），再按 \n 拆开一条条出气泡（间隔 600ms）

import * as gomoku from './gomoku.js';
import * as store from './store.js';
import * as ai from './ai.js';

/** 游戏注册表。加新游戏 = 在这儿加一行 + 写一个规则文件 */
const GAMES = {
  gomoku: { mod: gomoku, name: '五子棋', sub: '两个人 · 一盘十来分钟' },
};

/**
 * 谁执黑 —— **每局随机**（2026-10-05 兔宝定的：原来写死他执黑先走）。
 * 所以这不能是模块常量，得跟着 `G` 走：`G.aiColor` / `G.meColor`。
 * ⚠️ 落进库里，续局才认得出谁是谁；旧存档没有这两个字段，`_colorsOf()` 兜底成他执黑。
 */
const otherColor = c => (c === 'black' ? 'white' : 'black');
const COLOR_CN = { black: '黑', white: '白' };

/** 从一条对局记录里读出双方的颜色（旧存档兜底：他执黑） */
function _colorsOf(g) {
  const ai = (g && (g.aiColor === 'white' || g.aiColor === 'black')) ? g.aiColor : 'black';
  return { aiColor: ai, meColor: otherColor(ai) };
}

const $ = id => document.getElementById(id);
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── 运行时状态 ──────────────────────────────────────────────────────────
let G = null;            // 当前对局对象（也是落库的那个对象）
let rule = null;         // 当前规则模块
let note = '';           // 他上一手留给自己的备忘
let busy = false;        // 有在途的 AI 请求
let talkTimer = null;    // 她说完话后的 1.5 秒合并窗口
let gameNo = 1;          // 「第 N 局」
let destroyed = false;
/**
 * 「局次」——每离开一次对局屏就 +1。
 * 🔴 在途的 AI 请求回来时先对一下：这一趟是不是还属于当前这一局？
 *    没有它的话，她在「他正在想」的时候点返回，请求回来后 G 已经是 null
 *    （或者已经换成了她新开的一局），那一手会写错地方。踩过。
 */
let gameSeq = 0;
/**
 * 请求在途时她又做了动作（落子 / 说话）—— 记下来，等这一趟收尾了再补发。
 * 🔴 没有它的话：他在说话的那一两秒里她点了棋盘，那一下会被 busy 吞掉，
 *    界面明明已经显示「轮到你」了，点下去却没反应。踩过。
 */
let _afterBusy = null;   // 'move' | 'talk' | null

// ── 启动 ────────────────────────────────────────────────────────────────

(async function init() {
  if (ai.MOCK) $('mockFlag').style.display = '';

  syncTheme();
  watchParentTheme();
  wireEvents();
  await renderLobby();

  window.addEventListener('beforeunload', () => { destroyed = true; });
})();

/**
 * 主题跟主 APP 走。照 phone.html 那段：
 * 嵌在 iframe 里就只认父页面的 data-theme，独立打开才退回 localStorage 的开关。
 */
function syncTheme() {
  let dark;
  if (window.self === window.top) {
    const s = localStorage.getItem('fox_dark');
    dark = s !== null ? s === '1' : window.matchMedia('(prefers-color-scheme:dark)').matches;
  } else {
    try { dark = window.parent.document.documentElement.dataset.theme === 'dark'; }
    catch (_) { dark = window.matchMedia('(prefers-color-scheme:dark)').matches; }
  }
  document.documentElement.classList.toggle('dark', dark);
}

/** 她在主 APP 里切明暗时，iframe 不会自动收到通知 —— 盯着父页面的 data-theme */
function watchParentTheme() {
  try {
    new MutationObserver(syncTheme).observe(window.parent.document.documentElement, {
      attributes: true, attributeFilter: ['data-theme'],
    });
  } catch (_) { /* 跨域或独立打开，无所谓 */ }
}

function wireEvents() {
  $('sayInput').addEventListener('input', () => { $('btnSay').disabled = !$('sayInput').value.trim(); });
  $('sayInput').addEventListener('keydown', e => { if (e.key === 'Enter') sendSay(); });
  $('btnSay').addEventListener('click', sendSay);
  $('board').addEventListener('click', onBoardClick);
  $('selModel').addEventListener('change', e => ai.setGameModelChoice(e.target.value));
}

// ── 大厅 ────────────────────────────────────────────────────────────────

async function renderLobby() {
  $('swAdvisor').classList.toggle('on', ai.getAdvisor());

  const sel = $('selModel');
  sel.innerHTML = '<option value="">跟聊天一样</option>'
    + ai.listPresets().map(p => `<option value="${escAttr(p.name)}">${escAttr(p.name)}</option>`).join('');
  sel.value = ai.getGameModelChoice();

  // 🔑 只查一次库，后面全在本地算。
  //    之前这儿连着查了三次（本函数 + stats() + findUnfinished()），
  //    后果是「有一局没下完」那条比副标题晚几百毫秒才冒出来 —— 验证脚本正好卡在这个缝里。
  const games = await store.listGames();
  const done = games.filter(g => g && g.status === 'done');
  const playing = games.find(g => g && g.status === 'playing') || null;

  // 五子棋卡片的角标
  const gm = done.filter(g => g.type === 'gomoku');
  const gmW = gm.filter(g => g.result === 'me').length;
  const gmL = gm.filter(g => g.result === 'ai').length;
  const tag = $('tagGomoku');
  if (gmW + gmL > 0) { tag.style.display = ''; tag.textContent = `${gmW} 胜 ${gmL} 负`; }
  else { tag.style.display = 'none'; }

  // 战绩：只算下完的局（中途退出的不算，不然输一半跑了也算输，她会不服）
  let win = 0, lose = 0, draw = 0;
  for (const g of done) {
    if (g.result === 'me') win++;
    else if (g.result === 'ai') lose++;
    else if (g.result === 'draw') draw++;
  }

  const last = done[0];
  const bits = [];
  if (last) {
    const who = last.result === 'me' ? '你赢了' : last.result === 'ai' ? '他赢了' : '和棋';
    bits.push(`上一盘${GAMES[last.type]?.name || '棋'}，${who}。`);
  }
  bits.push((win + lose + draw) ? `总战绩 <b>你 ${win} : ${lose} 他</b>` : '还没下过 —— 点开五子棋，他来开局。');
  $('lobbySub').innerHTML = bits.join('<br>');

  $('resumeBar').style.display = playing ? '' : 'none';
  $('resumeBar')._id = playing ? playing.id : null;
}

async function startGame(type) {
  const g = GAMES[type];
  if (!g) return;
  rule = g.mod;
  gameNo = (await store.countByType(type)) + 1;
  note = '';
  // 🎲 谁执黑每局随机 —— 她 2026-10-05 定的（原来写死他执黑先走）
  const aiFirst = Math.random() < 0.5;
  const aiColor = aiFirst ? 'black' : 'white';
  const meColor = otherColor(aiColor);
  G = {
    id: store.newGameId(),
    type,
    startedAt: Date.now(),
    endedAt: null,
    status: 'playing',
    // 先手方开局 —— 他先手就是他的色，她先手就是她的色
    state: rule.createGame(aiFirst ? aiColor : meColor),
    talk: [],
    notes: [],
    result: null,
    summary: '',
    aiColor,
    meColor,
    // 🔴 结算卡一局只写一次。finish() 和 backToChat() 都会调 writeResult()，
    //    中间隔着她看结算页的那段时间 —— 主 APP 的轮询会先把第一份取走，
    //    她一点「回聊天」又写一份 → 聊天里两张重复的卡。踩过。
    resultWritten: false,
  };
  await persist();
  enterPlay();
  if (isAiTurn()) aiTurn(true);   // 她先手的话就等她点，别抢
}

async function resumeGame() {
  const id = $('resumeBar')._id;
  if (!id) return;
  const g = await store.getGame(id);
  if (!g || g.status !== 'playing' || !GAMES[g.type]) {
    toast('那局找不到了');
    return renderLobby();
  }
  rule = GAMES[g.type].mod;
  G = g;
  G.talk = G.talk || [];
  G.notes = G.notes || [];
  // 颜色是每局随机的，得从存档里读回来；旧存档没这个字段 → 兜底成他执黑
  const c = _colorsOf(G);
  G.aiColor = c.aiColor;
  G.meColor = c.meColor;
  note = (G.notes[G.notes.length - 1] || {}).text || '';
  gameNo = (await store.countByType(g.type)) + 1;
  enterPlay();
  if (isAiTurn()) aiTurn(true);   // 上次正好卡在他的回合
}

// ── 对局屏 ──────────────────────────────────────────────────────────────

function enterPlay() {
  show('scr-play');
  // ⚠️ 别用 playTitle.innerHTML 重写 —— 那会把里面的 #playSub 元素整个换掉，
  //    之后 $('playSub') 就是 null（updateTurnUI 直接炸）。踩过一次。
  $('playName').textContent = GAMES[G.type].name;
  drawBoardBase();
  G.state.moves.forEach(m => addStone(m, false));
  renderTalk();
  updateTurnUI();
  updateScore();
  $('sheet').classList.remove('on');
}

async function updateScore() {
  const st = await store.stats();
  $('score').innerHTML = `<b>${st.win}</b>:<b>${st.lose}</b>`;
}

function updateTurnUI() {
  const my = isMyTurn() && G.status === 'playing';
  $('plAi').classList.toggle('active', !my && G.status === 'playing');
  $('plMe').classList.toggle('active', my);
  // 黑白是每局随机的，这两行小字和那两个小圆点都得跟着走
  $('stAi').textContent = `执${COLOR_CN[G.aiColor]}`
    + (G.status === 'playing' && isAiTurn() ? ' · 在想' : '');
  $('stMe').textContent = `执${COLOR_CN[G.meColor]}`;
  $('dotAi').className = 'dot ' + (G.aiColor === 'black' ? 'b' : 'w');
  $('dotMe').className = 'dot ' + (G.meColor === 'black' ? 'b' : 'w');
  $('playSub').textContent = `第 ${gameNo} 局 · 第 ${G.state.moves.length} 手`;
  $('btnResign').style.visibility = G.status === 'playing' ? '' : 'hidden';
}

const isAiTurn = () => !!G && G.state.turn === G.aiColor;
const isMyTurn = () => !!G && G.state.turn === G.meColor;

function drawBoardBase() {
  const N = rule.SIZE, pad = 5, step = (100 - 2 * pad) / (N - 1);
  let s = '<svg viewBox="0 0 100 100" preserveAspectRatio="none">';
  for (let i = 0; i < N; i++) {
    const p = pad + i * step;
    const w = (i === 0 || i === N - 1) ? .35 : .18;
    s += `<line x1="${pad}" y1="${p}" x2="${100 - pad}" y2="${p}" stroke="var(--line)" stroke-width="${w}"/>`;
    s += `<line x1="${p}" y1="${pad}" x2="${p}" y2="${100 - pad}" stroke="var(--line)" stroke-width="${w}"/>`;
  }
  [[3, 3], [11, 3], [7, 7], [3, 11], [11, 11]].forEach(([x, y]) => {
    s += `<circle cx="${pad + x * step}" cy="${pad + y * step}" r=".7" fill="var(--line)"/>`;
  });
  s += '</svg>';
  $('board').innerHTML = s;
}

/** 棋子画成什么动物（2026-10-05 兔宝要的：不要圆点，要小动物）。
 *  换组合只改这一行 —— 形状在 game.html 的 <symbol> 里（icoRabbit / icoCat），
 *  颜色由 game.html 那段 <style> 的 .stone.b / .stone.w 决定。
 *  现在这版 = **黑兔（他）+ 白猫（她）** —— 她 2026-10-05 挑的。
 *  ⚠️ 注意这里是**按颜色**映射的，而颜色每局随机（见 `_colorsOf`）——
 *     所以"黑兔"永远跟黑棋走，不会跟着人走。这是对的：棋子的形状认的是颜色。 */
const STONE_ANIMAL = { black: 'rabbit', white: 'cat' };

function addStone(m, animate) {
  const board = $('board'), pad = 5, step = (100 - 2 * pad) / (rule.SIZE - 1);
  board.querySelectorAll('.stone.last').forEach(el => el.classList.remove('last'));
  const d = document.createElement('div');
  d.className = `stone ${m.color === 'black' ? 'b' : 'w'} last` + (animate ? ' new' : '');
  d.style.left = (pad + m.c * step) + '%';
  d.style.top = (pad + m.r * step) + '%';
  // 形状用 <use> 引用 game.html 里定义好的 <symbol>：满盘 225 颗也不会把 DOM 撑大
  d.innerHTML = `<svg class="ico" aria-hidden="true"><use href="#${
    STONE_ANIMAL[m.color] === 'cat' ? 'icoCat' : 'icoRabbit'}"/></svg>`;
  board.appendChild(d);
}

// ── 落子 ────────────────────────────────────────────────────────────────

function onBoardClick(e) {
  // ⚠️ 这里**不判 busy**：他在说话的那几秒里 turn 已经是她的了（界面也这么显示），
  //    再拿 busy 挡一下，她点了就是没反应。落子的合法性交给 humanMove 里的 isMyTurn。
  if (!G || G.status !== 'playing' || !isMyTurn()) return;
  const rect = $('board').getBoundingClientRect();
  const pad = 5, step = (100 - 2 * pad) / (rule.SIZE - 1);
  const x = (e.clientX - rect.left) / rect.width * 100;
  const y = (e.clientY - rect.top) / rect.height * 100;
  const c = Math.round((x - pad) / step);
  const r = Math.round((y - pad) / step);
  if (c < 0 || c >= rule.SIZE || r < 0 || r >= rule.SIZE) return;
  humanMove(rule.formatMove(c, r));
}

async function humanMove(move) {
  if (!G || G.status !== 'playing' || !isMyTurn()) return;
  if (!rule.isLegal(G.state, move)) { toast('那儿下不了'); return; }

  G.state = rule.applyMove(G.state, move);
  addStone(G.state.moves[G.state.moves.length - 1], true);
  addSys(`第 ${G.state.moves.length} 手 · 你落在 ${move}`);
  await persist();
  updateTurnUI();

  if (G.state.status === 'done') { await finish(); return; }
  // 她攒着的话不用特意带 —— 他的请求每次都读整份 G.talk
  if (busy) { _afterBusy = 'move'; return; }   // 他还在说话，等他收尾
  aiTurn(true);
}

// ── 他的回合 ────────────────────────────────────────────────────────────

async function aiTurn(mustMove) {
  if (busy || !G || G.status !== 'playing') return;
  const seq = gameSeq;          // 记住这一趟属于哪一局
  busy = true;
  setThinking(true);
  clearTimeout(talkTimer);

  try {
    // 军师：**只在他要落子这一轮**才算（她说话那一轮他不用下棋，给了反而跟后面的指令打架）。
    // 优先用带理由的版本 —— 光丢几个坐标他不听，说清"为什么值得走"才会听（2026-10-08）。
    let hint = null;
    if (ai.getAdvisor() && mustMove) {
      if (rule.suggestMovesDetailed) hint = rule.suggestMovesDetailed(G.state, 3);
      else if (rule.suggestMoves) hint = rule.suggestMoves(G.state, 3);
    }
    const res = await ai.askAI({
      rule, state: G.state, talk: G.talk, note, mustMove, hint,
      // 边收边贴到「他在想」那条上（她已经离开这一局了就闭嘴）
      onDelta: d => { if (!destroyed && seq === gameSeq) setThinkingLive(d); },
    });
    // 她可能在这几秒里返回了大厅 / 开了新一局 —— 这一趟作废，什么都不许碰
    if (destroyed || seq !== gameSeq) return;

    note = res.note || '';
    if (res.note) G.notes.push({ at: Date.now(), text: res.note });

    // 先落子（带动画），再出气泡（说明书 §7 最后一条）
    if (mustMove) {
      if (res.move && rule.isLegal(G.state, res.move)) {
        G.state = rule.applyMove(G.state, res.move);
        addStone(G.state.moves[G.state.moves.length - 1], true);
        addSys(`第 ${G.state.moves.length} 手 · 他落在 ${res.move}`);
      } else {
        // 🔴 兜底：askAI 说合法、到这儿却落不下去。**绝不静默跳过** ——
        //    那会让棋局无声卡死（轮次还挂在他那边，页面上一点提示都没有，她只会觉得"玩不下去了"）。
        //    走 showStuck 那条路，至少她看得见、能再问一次。
        throw Object.assign(new Error('落子没通过校验'), { code: 'NOT_LEGAL' });
      }
    }
    await persist();
    updateTurnUI();

    await sayLines(res.say);

    if (G.state.status === 'done') { await finish(); return; }
  } catch (e) {
    if (seq !== gameSeq) return;   // 已经离开这一局了，别把上一局的错贴到新一局上
    if (e && e.code === 'NOT_LEGAL') showStuck('他想了半天没想出一个能下的位置', e);
    else showStuck('他那边连不上：' + ((e && e.message) || e), e);
  } finally {
    // 🔴 只在「还是同一局」时才碰这些共享状态。
    //    否则她返回大厅后立刻续局，这一趟收尾会把新一局的 busy 解锁 / 补发动作抢走。
    if (seq === gameSeq) {
      busy = false;
      setThinking(false);
      // 他在说话的那几秒里她可能落了子 / 说了话 —— 这一趟收尾了，补发
      const what = _afterBusy;
      _afterBusy = null;
      if (what) {
        if (isAiTurn()) aiTurn(true);
        else if (what === 'talk' && isMyTurn()) aiTurn(false);
      }
    }
  }
}

/** 他说的话按 \n 拆成一条条，间隔 600ms 出 */
async function sayLines(say) {
  const lines = String(say || '').split('\n').map(s => s.trim()).filter(Boolean);
  for (const t of lines) {
    addTalk('ai', t, true);
    await persist();
    await sleep(600);
  }
}

/**
 * 「他在想」那条。
 * 🔴 2026-10-05：加了**实时显示** —— 原来这儿只有三个点在跳，她要干等整段生成完
 *    （思考型模型可能几十秒）才看见任何东西，所以她说「每轮到炘也下都要等到睡着」。
 *    现在流式把「思考」喂过来，这条上会滚出他正在想的内容 —— 至少能看出他活着、在想什么。
 */
function setThinking(on) {
  const log = $('talkLog');
  let el = log.querySelector('.think');
  if (on) {
    if (!el) {
      el = document.createElement('div');
      el.className = 'think';
      el.innerHTML = '<i><b></b><b></b><b></b></i><span class="tt">他在想，你可以接着说</span>'
        + '<small class="live"></small>';
      log.appendChild(el);
    }
    startTicker(el);
    el.scrollIntoView({ block: 'end' });
  } else if (el) {
    stopTicker();
    el.remove();
  }
}

// 等了多少秒 —— 有它她才分得清「他在想」和「页面死了」
let _tickTimer = null;
let _tickAt = 0;
function startTicker(el) {
  stopTicker();
  _tickAt = Date.now();
  _tickTimer = setInterval(() => {
    const t = el.querySelector('.tt');
    if (!t) return;
    const s = Math.round((Date.now() - _tickAt) / 1000);
    t.textContent = `他在想，你可以接着说 · ${s} 秒`;
  }, 1000);
}
function stopTicker() { if (_tickTimer) { clearInterval(_tickTimer); _tickTimer = null; } }

/**
 * 流式进度：把「他正在写的东西」贴到那条小字上。
 * ⚠️ **只显示思考通道，不显示正文** —— 正文是那段 JSON（`{"move":"H8"...}`），
 *    原样滚出来既难看又剧透。思考通道才是"他正在想什么"，也正是耗时的部分。
 */
function setThinkingLive({ text, thinking }) {
  const el = $('talkLog').querySelector('.think');
  if (!el) return;
  const live = el.querySelector('.live');
  if (!live) return;
  const think = String(thinking || '').replace(/\s+/g, ' ').trim();
  const tail = think.slice(-46);
  if (tail) {
    live.textContent = tail;
    live.classList.add('on');
  } else if (text) {
    // 没有思考通道（普通模型）—— 只能说个大概进度，别把 JSON 露出来
    live.textContent = `正在写下这一步…（${String(text).length} 字）`;
    live.classList.add('on');
  }
  el.scrollIntoView({ block: 'end' });
}

function showStuck(msg, err) {
  const log = $('talkLog');
  const el = document.createElement('div');
  el.className = 'stuck';
  // 🔴 把「卡在哪一步」+「他到底回了什么」都带出来。
  //    只写一句「想不出来」的话，她截图给我也查不出原因 —— 2026-10-05 就是这么卡住的。
  const raw = err && err.raw ? String(err.raw).replace(/\s+/g, ' ').trim().slice(0, 90) : '';
  const lines = [];
  if (err && err.why) lines.push(err.why);
  if (err && err.finish === 'length') lines.push('他这次话说了一半就断了（输出长度不够）');
  if (err && err.finish === 'cut') lines.push('他还在写就被掐断了（等太久了）');
  if (raw) lines.push(`他回的是：${raw}`);
  el.innerHTML = escHtml(msg)
    + lines.map(x => `<small class="why">${escHtml(x)}</small>`).join('')
    + '<button>再问他一次</button>';
  el.querySelector('button').onclick = () => { el.remove(); aiTurn(isAiTurn()); };
  log.appendChild(el);
  el.scrollIntoView({ block: 'end' });
  console.warn('[game] 卡住了', msg, err);   // vConsole 里能看到完整对象
  // ⚠️ 这里**故意不弹 toast**：toast 是 `position:absolute; bottom:76px`，
  //    正好压在卡住条上，把「他回的是：…」那行小字挡掉（截图时撞见的）。
  //    卡住条本身已经写着同样的话、也已经滚到眼前了，再弹一下纯属挡路。
}

// ── 桌边话 ──────────────────────────────────────────────────────────────

function addTalk(who, text, animate) {
  if (!G) return;
  G.talk.push({ who, text, at: Date.now() });
  appendTalkDOM({ who, text }, animate);
}

function addSys(text) {
  if (!G) return;
  G.talk.push({ who: 'sys', text, at: Date.now() });
  appendTalkDOM({ who: 'sys', text }, false);
}

function appendTalkDOM(t, animate) {
  const log = $('talkLog');
  const think = log.querySelector('.think');
  const el = document.createElement('div');
  if (t.who === 'sys') {
    el.className = 'sys';
    el.textContent = '— ' + t.text + ' —';
  } else {
    el.className = 'ln' + (t.who === 'me' ? ' me' : '') + (animate ? ' pop' : '');
    el.innerHTML = t.who === 'ai'
      ? `<span class="av">${escHtml(aiAvatarChar())}</span><p></p>`
      : '<p></p>';
    el.querySelector('p').textContent = t.text;
  }
  if (think) log.insertBefore(el, think);
  else log.appendChild(el);
  el.scrollIntoView({ block: 'end' });
}

function renderTalk() {
  $('talkLog').innerHTML = '';
  for (const t of G.talk) appendTalkDOM(t, false);
}

function sendSay() {
  const t = $('sayInput').value.trim();
  if (!t || !G || G.status !== 'playing') return;
  $('sayInput').value = '';
  $('btnSay').disabled = true;
  addTalk('me', t, true);
  persist();

  // 轮到她、她只是在说话 → 1.5 秒后合并发一次「只说话」（说明书 §7）
  clearTimeout(talkTimer);
  if (!isMyTurn() || G.status !== 'playing') return;
  if (busy) { _afterBusy = 'talk'; return; }   // 他还在说话，等他收尾再接
  talkTimer = setTimeout(() => { if (isMyTurn() && !busy) aiTurn(false); }, 1500);
}

// ── 收尾 ────────────────────────────────────────────────────────────────

async function finish(forced) {
  if (!G || G.status === 'done') return;
  G.status = 'done';
  G.endedAt = Date.now();
  G.result = forced || (G.state.winner === 'draw' ? 'draw'
    : (G.state.winner === G.meColor ? 'me' : 'ai'));
  G.state = { ...G.state, status: 'done' };
  await persist();
  updateTurnUI();
  showSheet();
  updateScore();

  try {
    const sum = await ai.summarizeGame({
      rule, state: G.state, talk: G.talk, result: G.result,
      // 小结也流式贴出来 —— 原来「他在想怎么跟你说…」也是干等的
      onDelta: d => {
        const t = String(d.text || d.thinking || '').replace(/\s+/g, ' ').trim();
        if (t) $('doneSum').textContent = t;
      },
    });
    if (sum) { G.summary = sum; $('doneSum').textContent = sum; await persist(); }
    else $('doneSum').textContent = '（他没说什么。）';
  } catch (e) {
    $('doneSum').textContent = '（小结没写出来：' + ((e && e.message) || e) + '）';
  }
  writeResult();
}

function showSheet() {
  const n = G.state.moves.length;
  const mins = Math.max(1, Math.round((G.endedAt - G.startedAt) / 60000));
  const who = G.result === 'me' ? '你赢了' : G.result === 'ai' ? '他赢了' : '和棋';
  $('doneWho').innerHTML = `${who}<small>${GAMES[G.type].name} · 第 ${gameNo} 局 · ${n} 手 · ${mins} 分钟</small>`;
  $('doneSum').textContent = '他在想怎么跟你说…';
  $('sheet').classList.add('on');
}

/** 写进 localStorage，等主 APP 取（说明书 §8）—— 和覆盖层回话走的是同一条路 */
function writeResult() {
  if (!G || !G.summary) return;
  if (G.resultWritten) return;   // 这一局已经交出去了，别再来一张
  const pfx = window.__APP_ID__ === 'choubao' ? 'choubao_' : '';
  try {
    localStorage.setItem(pfx + 'xinye_game_result', JSON.stringify({
      gameId: G.id,
      type: G.type,
      result: G.result,
      moves: G.state.moves.length,
      durationMs: (G.endedAt || Date.now()) - G.startedAt,
      summary: G.summary,
      presetName: ai.getGameModelChoice() || '',
      at: Date.now(),
    }));
    // ⚠️ 只在真的写进去之后才立旗 —— 写失败（配额满之类）时留个重试的机会
    G.resultWritten = true;
  } catch (_) {}
}

function backToChat() {
  writeResult();
  if (window.parent !== window) {
    // 主 APP 收到就切回聊天、并把结算卡接进去（和 closeOverlay 并列的一条）
    window.parent.postMessage({ type: 'gameDone' }, '*');
    return;
  }
  location.href = 'index.html';
}

async function backToLobby() {
  $('sheet').classList.remove('on');
  // 🔴 先作废在途的那一趟 AI 请求，再清 G。
  //    顺序反了的话，请求回来时正好撞上一个半清空的状态。
  gameSeq++;
  busy = false;
  _afterBusy = null;
  setThinking(false);
  G = null;
  note = '';
  show('scr-lobby');
  await renderLobby();
}

function leaveGame() {
  // 中途走人不算弃局 —— status 保持 playing，大厅会显示「有一局没下完」
  if (window.parent !== window) { window.parent.postMessage('closeOverlay', '*'); return; }
  if (history.length > 1) history.back();
  else location.href = 'index.html';
}

function resign() {
  if (!G || G.status !== 'playing') return;
  if (!confirm('认输？这一局就算他赢了。')) return;
  G.state = { ...G.state, status: 'done', winner: G.aiColor };
  finish('ai');
}

function goBack() { leaveGame(); }

function toggleAdvisor() {
  const on = !ai.getAdvisor();
  ai.setAdvisor(on);
  $('swAdvisor').classList.toggle('on', on);
  toast(on ? '军师开了：他会看到几个候选点，但走哪步还是他挑' : '军师关了');
}

// ── 小工具 ──────────────────────────────────────────────────────────────

function show(id) {
  document.querySelectorAll('.screen').forEach(el => el.classList.toggle('on', el.id === id));
}

async function persist() {
  if (!G) return;
  try { await store.saveGame(G); } catch (e) { console.warn('[game] 落库失败', e); }
}

function aiAvatarChar() {
  return window.__APP_ID__ === 'choubao' ? '臭' : '炘';
}

function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
/**
 * 🔴 必须是**函数声明**，不能写成 `const escAttr = escHtml`。
 *
 * 2026-10-05 踩的：`renderLobby()` 由文件开头的 IIFE（`init()`）同步调用，
 * 那时候模块才求值到第 52 行 —— 而 `const` 定义在 516 行，还在暂时性死区。
 * 结果：**只要她配了命名预设**，第 97 行那个 `.map(p => escAttr(p.name))`
 * 一执行就抛 `ReferenceError: Cannot access 'escAttr' before initialization`，
 * `sel.innerHTML` 整个赋值被跳过 → **下拉框是空的**；
 * 而且 `renderLobby()` 整个中断 → 副标题永远卡在「加载中…」、战绩角标和续局条都不出来。
 *
 * ⚠️ **为什么测试没抓到**：测试环境里 `xinye_api_presets` 是空的，
 * `.map()` 一次都不执行，所以永远碰不到这一行。**空数组把 bug 藏起来了。**
 * （AGENTS.md 那条「测试素材比真机宽松，等于没验」的又一例。）
 * → 函数声明会提升，写它就与调用顺序无关。
 */
function escAttr(s) { return escHtml(s); }

let _toastTimer = null;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('on');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => t.classList.remove('on'), 2600);
}

// HTML 里的 onclick 要能找到它们
Object.assign(window, {
  goBack, startGame, resumeGame, leaveGame, resign, backToLobby, backToChat, toggleAdvisor,
});
