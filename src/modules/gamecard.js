// src/modules/gamecard.js —— 主聊天里那张「下完一局」的结算卡。
//
// 传递方式照抄**覆盖层回话**那条路（src/overlay.js → src/modules/inbox.js 的 _consumeOverlayReply）：
//   游戏页把结果写进 localStorage → 主 APP 收到通知（或下次启动/回前台时）取走 →
//   落成一条带 `game` 字段的 assistant 消息。
//
// 🔴 顺序不能反：**先写库成功，才删 localStorage**。
//    先删后写的话，写失败那条小结就永久丢了（2026-09-23 在覆盖层那边踩过一模一样的坑）。
//
// 🔴 这里**不 import chat.js 到顶层**，用动态 import —— 和 inbox.js 一个道理：
//    模块加载失败时，那条小结还躺在 localStorage 里，下次还能再来一次。

const GAME_NAMES = { gomoku: '五子棋' };

const _key = () => (window.__APP_ID__ === 'choubao' ? 'choubao_' : '') + 'xinye_game_result';

let _draining = false;

/**
 * 把游戏页留下的结算结果接进聊天。
 * @returns {Promise<boolean>} 真的接进来了才 true
 */
export async function consumeGameResult() {
  if (_draining) return false;

  let raw = null;
  try { raw = localStorage.getItem(_key()); } catch (_) { return false; }
  if (!raw) return false;

  _draining = true;
  try {
    const d = JSON.parse(raw);
    if (!d || !d.summary) { localStorage.removeItem(_key()); return false; }

    // ⚠️ 先拿到 chat 模块，再动 localStorage
    const { addMessage, appendMsgDOM, renderMessages } = await import('./chat.js');

    const saved = await addMessage('assistant', String(d.summary), null, d.at || Date.now(), d.presetName || '', { game: d });
    if (!saved) return false;               // 没落库就不删，留着下次再试
    localStorage.removeItem(_key());

    const chatEl = document.querySelector('#chatArea');
    if (chatEl && chatEl.querySelector('.msg-row')) await appendMsgDOM(saved);
    else await renderMessages();
    return true;
  } catch (e) {
    console.warn('[gamecard] 结算卡接进聊天失败:', e && e.message);
    return false;
  } finally {
    _draining = false;
  }
}

/**
 * 结算卡的 DOM。chat.js 渲染气泡时通过 window.renderGameCardHTML 调它 ——
 * 走 window 而不是互相 import，是为了避免 chat.js ↔ gamecard.js 绕成环
 * （chat.js 里已有的 window.renderStickerHTML 就是这个模式）。
 */
export function renderGameCardHTML(game, content) {
  const g = game || {};
  const name = GAME_NAMES[g.type] || '一局';
  const who = g.result === 'me' ? '兔宝赢' : g.result === 'ai' ? '他赢' : '和棋';
  const mins = Math.max(1, Math.round((Number(g.durationMs) || 0) / 60000));
  return `<div class="gcard">`
    + `<div class="h"><b>${escHtml(name)}</b>${Number(g.moves) || 0} 手 · ${mins} 分钟<em>${escHtml(who)}</em></div>`
    + `<div class="b">${escHtml(content)}</div>`
    + `</div>`;
}

window.renderGameCardHTML = renderGameCardHTML;

function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
