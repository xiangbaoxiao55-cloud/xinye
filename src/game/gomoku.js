// src/game/gomoku.js —— 五子棋规则。
//
// 🔴 这个文件是**纯函数**：不碰 DOM、不碰 IndexedDB、不读 localStorage、不 import 任何东西。
//    好处是 `node -e "import('./src/game/gomoku.js')"` 能直接跑单测（说明书 §11.1）。
//
// 约定（说明书 §4）：以后每个游戏一个规则文件，接口保持一致 ——
//   createGame / applyMove / isLegal / winner / toPromptText
// `main.js` 和 `ai.js` 只认这五个函数，不感知当前是哪个游戏。
//
// 坐标：列 A~O（15 列），行 1~15。`H8` = 第 8 列第 8 行。
// 棋盘内部用一维数组，0=空 1=黑 2=白。

export const SIZE = 15;
export const COLS = 'ABCDEFGHIJKLMNO';
export const BLACK = 'black';
export const WHITE = 'white';

const _idx = (c, r) => r * SIZE + c;
const _val = (color) => (color === BLACK ? 1 : 2);

/**
 * 开一局新的。**黑先**（规则如此）。
 * `first` 指定谁先走 —— 不传就是黑先（保持老行为，纯函数测试直接调它）。
 * 🔴 2026-10-05 兔宝要「随机先手」，所以这一页得能指定先手方：
 *    `main.js` 随机决定谁执黑，再把他俩里**先手的那一方**传进来。
 */
export function createGame(first = BLACK) {
  return {
    type: 'gomoku',
    size: SIZE,
    board: new Array(SIZE * SIZE).fill(0),
    moves: [],
    turn: first === WHITE ? WHITE : BLACK,
    status: 'playing',      // playing | done
    winner: null,           // black | white | draw | null
  };
}

/**
 * `'h8'` / `'H8'` / `'H 8'` / `'H-8'` / `'"H8"'` / `'Ｈ８'` / `'8H'` → `{ c: 7, r: 7 }`；
 * 看不懂就返回 null。
 * ⚠️ 别在这里抛异常 —— 模型吐什么都有可能，调用方要靠 null 判断"它写歪了"。
 * 🔴 2026-10-05 加固：原来只认**严格的** `^[A-O][1-9]$`（大小写和中间一个空格除外），
 *    全角、加引号、写成 `8H`、结尾带句号都会判成"看不懂" → 走重问 → 还是看不懂 → 「他卡住了」。
 *    现在先把全角转半角、再抹掉所有非字母数字，然后正反两种写法都认。
 *    **不猜**：抹完还不是一个干净的坐标就返回 null，宁可问他也不替他走。
 */
export function parseMove(move) {
  if (typeof move !== 'string' && typeof move !== 'number') return null;
  let s = String(move).trim()
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
  if (!s) return null;
  let m = s.match(/^([A-O])([1-9]|1[0-5])$/);
  if (m) return { c: COLS.indexOf(m[1]), r: Number(m[2]) - 1 };
  m = s.match(/^([1-9]|1[0-5])([A-O])$/);      // 行在前列在后
  if (m) return { c: COLS.indexOf(m[2]), r: Number(m[1]) - 1 };
  return null;
}

/** `{c:7,r:7}` → `'H8'` */
export function formatMove(c, r) {
  return COLS[c] + (r + 1);
}

/** 这一步能不能走：局没结束、坐标能看懂、那格是空的 */
export function isLegal(state, move) {
  if (!state || state.status !== 'playing') return false;
  const p = parseMove(move);
  if (!p) return false;
  return state.board[_idx(p.c, p.r)] === 0;
}

/**
 * 走一步，**返回新的 state**（不改入参 —— 纯函数）。
 * 走不了就抛，错误信息是给模型看的（说明书 §5.4：带着原因重新问它一次）。
 */
export function applyMove(state, move) {
  if (state.status !== 'playing') throw new Error('这局已经结束了');
  const p = parseMove(move);
  if (!p) throw new Error(`"${move}" 不是合法坐标，要写成 A1~O15 这样（比如 H8）`);
  const i = _idx(p.c, p.r);
  if (state.board[i] !== 0) throw new Error(`${formatMove(p.c, p.r)} 已经有子了，换一个空位`);

  const color = state.turn;
  const board = state.board.slice();
  board[i] = _val(color);
  const moves = state.moves.concat([{ c: p.c, r: p.r, color }]);

  let status = 'playing';
  let winner = null;
  if (checkWin(board, p.c, p.r, color)) { status = 'done'; winner = color; }
  else if (moves.length >= SIZE * SIZE) { status = 'done'; winner = 'draw'; }

  return { ...state, board, moves, turn: color === BLACK ? WHITE : BLACK, status, winner };
}

/** 谁赢了（没结束就是 null） */
export function winner(state) {
  return state ? state.winner : null;
}

/** 落在 (c,r) 的这手棋，连成五个了没有 */
export function checkWin(board, c, r, color) {
  const v = _val(color);
  const dirs = [[1, 0], [0, 1], [1, 1], [1, -1]];
  for (const [dc, dr] of dirs) {
    let n = 1;
    for (const s of [1, -1]) {
      let cc = c + dc * s, rr = r + dr * s;
      while (cc >= 0 && cc < SIZE && rr >= 0 && rr < SIZE && board[_idx(cc, rr)] === v) {
        n++; cc += dc * s; rr += dr * s;
      }
    }
    if (n >= 5) return true;
  }
  return false;
}

/** 所有还空着的点（mock 模式随机挑一个用；军师也算它） */
export function legalMoves(state) {
  const out = [];
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      if (state.board[_idx(c, r)] === 0) out.push(formatMove(c, r));
    }
  }
  return out;
}

// ── 军师（说明书 §1 那个开关）────────────────────────────────────────────
//
// 🔴 它只**提建议**，最终走哪步由模型决定 —— 这一点不许改。
// 做法很朴素：每个空位分别假设"我下这儿"和"对手下这儿"，按连子长度和两头
// 是否被堵打分，取最高的几个。够用就行，不是要造一个棋力引擎。

/** 附近两格内有没有子 —— 空盘和稀疏盘面靠它剪枝，不然 225 个点全算一遍 */
function _hasNeighbor(board, c, r, dist) {
  for (let dr = -dist; dr <= dist; dr++) {
    for (let dc = -dist; dc <= dist; dc++) {
      const cc = c + dc, rr = r + dr;
      if (cc < 0 || cc >= SIZE || rr < 0 || rr >= SIZE) continue;
      if (board[_idx(cc, rr)] !== 0) return true;
    }
  }
  return false;
}

/** 假设 v 落在 (c,r)，这一点的价值 */
function _evalPoint(board, c, r, v) {
  const dirs = [[1, 0], [0, 1], [1, 1], [1, -1]];
  let total = 0;
  for (const [dc, dr] of dirs) {
    let cnt = 1, open = 0;
    for (const s of [1, -1]) {
      let cc = c + dc * s, rr = r + dr * s;
      while (cc >= 0 && cc < SIZE && rr >= 0 && rr < SIZE && board[_idx(cc, rr)] === v) {
        cnt++; cc += dc * s; rr += dr * s;
      }
      if (cc >= 0 && cc < SIZE && rr >= 0 && rr < SIZE && board[_idx(cc, rr)] === 0) open++;
    }
    total += _shapeScore(cnt, open);
  }
  return total;
}

function _shapeScore(cnt, open) {
  if (cnt >= 5) return 100000;                       // 直接赢
  if (cnt === 4) return open >= 1 ? 10000 : 1000;    // 活四 / 冲四
  if (cnt === 3) return open === 2 ? 1000 : (open === 1 ? 120 : 0);
  if (cnt === 2) return open === 2 ? 120 : (open === 1 ? 12 : 0);
  return open === 2 ? 6 : 1;
}

/**
 * 给所有空位打分并排序。军师的两个版本共用这一段 —— 别写两份。
 * 返回 `{ me, opp, cands }`，`cands` 是 `[{ c, r, score }]` 降序。
 */
function _rankCandidates(state) {
  const me = _val(state.turn);
  const opp = me === 1 ? 2 : 1;
  const cands = [];
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      if (state.board[_idx(c, r)] !== 0) continue;
      if (!_hasNeighbor(state.board, c, r, 2)) continue;
      // 进攻稍微加权：能连自己的，也顺手堵对手的
      const s = _evalPoint(state.board, c, r, me) * 1.15 + _evalPoint(state.board, c, r, opp);
      cands.push({ c, r, score: s });
    }
  }
  cands.sort((a, b) => b.score - a.score);
  return { me, opp, cands };
}

/** 假设 v 落在 (c,r)，能不能连成五 */
function _winsAt(board, c, r, v) {
  const b = board.slice();
  b[_idx(c, r)] = v;
  return checkWin(b, c, r, v === 1 ? BLACK : WHITE);
}

/**
 * 这一手好在哪 —— 给模型看的一句话。
 * 🔑 2026-10-08：这是「军师」真正起作用的地方。光丢几个坐标他不听，
 *    说清"为什么值得走"他才会听。判断顺序 = 先看谁能赢，再看威胁大小。
 */
function _reason(board, c, r, me, opp) {
  if (_winsAt(board, c, r, me)) return '落这里你直接连成五，赢了';
  if (_winsAt(board, c, r, opp)) return '她要在这里连成五，不堵就输了';
  const mine = _evalPoint(board, c, r, me);
  const hers = _evalPoint(board, c, r, opp);
  if (mine >= 10000) return '你落这里能成四，她必须来堵';
  if (hers >= 10000) return '她落这里会成四 —— 成活四就基本挡不住了，优先堵';
  if (hers >= 1000) return '她在这里能做活三，早点封住';
  if (mine >= 1000) return '你在这里能做活三，先手在你';
  return '顺着自己的棋形往外长';
}

/**
 * 挑 n 个看起来不错的点。
 * ⚠️ 返回的是**坐标字符串数组**，不是"这一步最好"的结论 —— 决策权在模型手上。
 */
export function suggestMoves(state, n = 3) {
  const { cands } = _rankCandidates(state);
  if (!cands.length) return [formatMove(7, 7)];   // 空盘 → 天元
  return cands.slice(0, n).map(x => formatMove(x.c, x.r));
}

/**
 * 军师用：跟 `suggestMoves` 同一套打分，但每个点**附一句"为什么"**。
 * 返回 `[{ move: 'H7', why: '她要在这里连成五，不堵就输了' }]`。
 * 🔴 仍然只是**建议** —— 走哪步由模型定（说明书 §1：代码一步都不替他走）。
 */
export function suggestMovesDetailed(state, n = 3) {
  const { me, opp, cands } = _rankCandidates(state);
  if (!cands.length) return [{ move: formatMove(7, 7), why: '开局，先占天元' }];
  return cands.slice(0, n).map(x => ({
    move: formatMove(x.c, x.r),
    why: _reason(state.board, x.c, x.r, me, opp),
  }));
}

// ── 给模型看的局面文字（说明书 §5.2）────────────────────────────────────

/**
 * 棋盘图 + 完整落子序列。
 * ● 黑 ○ 白 · 空；最后一手用 ◆ / ◇ 标出来（说明里会讲）。
 */
export function toPromptText(state) {
  const last = state.moves[state.moves.length - 1];
  const lines = [];

  lines.push('    ' + COLS.split('').join(' '));
  for (let r = 0; r < SIZE; r++) {
    let row = String(r + 1).padStart(2, ' ') + '  ';
    for (let c = 0; c < SIZE; c++) {
      const v = state.board[_idx(c, r)];
      let ch = v === 0 ? '·' : (v === 1 ? '●' : '○');
      if (last && last.c === c && last.r === r) ch = v === 1 ? '◆' : '◇';
      row += ch + ' ';
    }
    lines.push(row.trimEnd());
  }

  lines.push('');
  if (!state.moves.length) {
    lines.push('棋盘是空的，这一手是开局。');
  } else {
    const seq = state.moves.map(m => (m.color === BLACK ? '黑' : '白') + formatMove(m.c, m.r));
    lines.push(`落子顺序（共 ${state.moves.length} 手）：` + seq.join(' → '));
    lines.push(`◆ 或 ◇ 就是刚才那一手：${(last.color === BLACK ? '黑' : '白') + formatMove(last.c, last.r)}`);
  }
  return lines.join('\n');
}

/** 这局一共走了几手（结算卡上要写） */
export function moveCount(state) {
  return state.moves.length;
}

// ── 讲给模型听的规则（说明书 §5.2：每个游戏一段，跟着规则文件走）────────
// 🔑 放在这儿而不是 ai.js 里，是为了让 ai.js 真的**不感知**当前是哪个游戏。
//    加飞行棋的时候，只要它的规则文件也导出一个 PROMPT_RULES，ai.js 一个字都不用改。
export const PROMPT_RULES = `【这一局：五子棋】
15×15 的棋盘，列 A~O、行 1~15。坐标写成「列+行」，比如 H8 是正中间那一格，A1 是左上角。
轮流落子，谁先连成五个（横、竖、两条斜线都算）谁赢。
没有禁手、没有三三禁手这些讲究，就是最简单的五子棋。
⚠️ 落子只能落在**空位**上，被占的格子不能再下。
🔴 谁执黑**每局随机**（黑先手）—— 你执什么颜色、棋盘上哪个符号是你的，**每次都会在局面里现说**。
   别按老印象认颜色：认反了就会把自己的子当成她的子，等于在帮她下。`;

/**
 * 轮到他落子时额外给的战术常识。
 * 🔑 跟 PROMPT_RULES 一样放规则文件里 —— `ai.js` 不感知具体是哪个游戏
 *    （见 ai.js 文件头：加飞行棋的时候 ai.js 一个字都不用改）。
 * 📌 这里只说"**怎么判断**"，一个坐标都不给 —— 选点由军师提供、由他自己定（说明书 §1）。
 */
export const PROMPT_TIPS = `【下棋的常识，落子前过一遍】
- 她连了三个、两头都空着（活三）→ 下一手就是活四、再下一手就赢了，**必须马上堵**，堵住一头就行
- 你自己能连成四个 → 优先去做，先手在你这边
- 能直接连成五就**直接赢**，别绕弯子
- 别只算自己这一手 —— 想一想：你下完，她最可能落在哪、你下一步再怎么接`;
