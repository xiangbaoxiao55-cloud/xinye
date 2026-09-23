/**
 * 长截图模式
 *
 * 为什么非做不可：聊天界面是「整页锁死一屏高 + 内层 .chat-area 自己滚」的结构
 * （variables.css 的 `html,body{overflow:hidden}`）。WebView 自己一点可滚动内容都
 * 没有，手机系统的「滚动截屏」识别不到可滚动区域 —— 指关节画 S 只会截下当前一屏。
 *
 * 做法：进模式时把 html/body/.app/.chat-area 的高度和 overflow 全放开，让文档自然
 * 撑成一条长页，系统的滚动截屏就能滚了；同时把懒加载的图片和贴纸一次性全唤醒，
 * 否则长图里没滚到的位置全是空白占位（图片是占位 span、贴纸是 1×1 透明占位）。
 *
 * ⚠️ 屏幕上不能留任何 **可见的** position:fixed 元素：系统是「截一屏 → 滚动 → 再截
 *    → 拼接」，fixed 相对视口定位，会在拼出来的长图里**每一屏重复出现一次**。
 *    所以退出按钮做成完全透明的热区（#capHotspot），看不见就不会污染长图。
 *
 * ⚠️ 只唤醒"要截的那几条"，被 cap-hide 藏起来的老消息一律不碰 —— 几百条消息的图
 *    一次性全挂上来会直接 OOM（这项目有前科）。
 */
import { toast } from './utils.js';

const LIMITS = [5, 10, 20, 50];

let _active = false;
// 默认 10：她「一般就截最近几条」，给大了每次都得先改档位。手机系统的滚动截屏
// 还有长度上限，长图越长越容易截到一半失败或者文件巨大 —— 截短了可以再截
let _limit = 10;
let _hiddenRows = [];

// ======================== 选择面板 ========================

function _panel() {
  let el = document.querySelector('#capturePanel');
  if (el) return el;
  el = document.createElement('div');
  el.className = 'modal-overlay';
  el.id = 'capturePanel';
  el.style.zIndex = '11500';
  el.innerHTML = `
    <div class="modal" style="max-width:400px;width:90%">
      <div class="modal-header">
        <span><i class="ic ic-camera"></i> 截长图</span>
        <button class="btn-close" data-cap-close><i class="ic ic-x"></i></button>
      </div>
      <div class="modal-body" style="padding:16px 20px">
        <div class="cap-tip">
          截最近几条？<br>
          <span>进去之后聊天会整页摊开、图片和贴纸全部加载好，你再用<b>指关节画 S</b> 截长图。
          截完点最上面那条<b>「退出长截图模式」</b>就回来了。</span>
        </div>
        <div class="cap-limits">
          ${LIMITS.map(n => `<button class="cap-limit${n === _limit ? ' active' : ''}" data-limit="${n}">${n} 条</button>`).join('')}
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn-secondary" data-cap-close style="flex:1">取消</button>
        <button class="btn-primary" data-cap-go style="flex:2">开始</button>
      </div>
    </div>`;
  el.addEventListener('click', e => {
    if (e.target === el || e.target.closest('[data-cap-close]')) { openCapturePanel(false); return; }
    const lim = e.target.closest('.cap-limit');
    if (lim) {
      _limit = Number(lim.dataset.limit) || 50;
      el.querySelectorAll('.cap-limit').forEach(b => b.classList.toggle('active', b === lim));
      return;
    }
    if (e.target.closest('[data-cap-go]')) { openCapturePanel(false); enterCaptureMode(_limit); }
  });
  document.body.appendChild(el);
  return el;
}

/** 打开 / 关闭「截长图」选择面板（顶栏按钮 onclick 调的就是它） */
export function openCapturePanel(show = true) {
  _panel().classList.toggle('show', !!show);
}

// ======================== 进入 / 退出 ========================

async function _wakeImages(root) {
  // 先跑一遍懒加载回填（把占位 span 换成真 <img>），再等这些图真的解码完
  try { await window.flushLazyImgs?.(root); } catch (_) {}
  try { await window.mountAllStickers?.(root); } catch (_) {}
  const imgs = [...root.querySelectorAll('img')].filter(i => !i.complete);
  if (!imgs.length) return;
  await Promise.race([
    Promise.all(imgs.map(i => new Promise(r => { i.onload = i.onerror = r; }))),
    new Promise(r => setTimeout(r, 8000)),   // 网络图卡住也不能一直等，超时就让她先截
  ]);
}

function _hotspot() {
  let el = document.querySelector('#capHotspot');
  if (el) return el;
  el = document.createElement('div');
  el.id = 'capHotspot';
  el.title = '退出长截图模式';
  el.addEventListener('click', () => exitCaptureMode());
  document.body.appendChild(el);
  return el;
}

/**
 * 退出按钮**必须走文档流**（普通 in-flow 元素），不能做成悬浮按钮。
 *
 * 🔴 2026-09-23 她真机试完的第一句话就是「截完后怎么退出🥺」—— 我原本只做了一个
 * 完全透明的左上角热区（为的是不被截进长图），但看不见的东西等于不存在。
 * 现在补一个看得见的，代价是长图最前面会带上它一条 —— 比找不到退出强太多。
 * ⚠️ 也**不能**改成 position:fixed 的悬浮条：滚动截屏逐屏拼接，fixed 元素会在长图里
 * **每一屏**都重复出现一次（这正是它只能放文档流里的原因）。
 *
 * ⚠️ 首尾各放一个：进模式时她站在页首，看得到上面那个；但滚动截屏结束后视口可能
 * 停在页尾，那时只剩下面那个够得着。两个都带上 `data-cap-exit` 好一次清掉。
 */
function _exitBar() {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.dataset.capExit = '1';
  btn.innerHTML = '<i class="ic ic-arrow-left"></i> 退出长截图模式';
  btn.addEventListener('click', () => exitCaptureMode());
  return btn;
}

/** 进入长截图模式：摊平整页 + 只留最近 limit 条 + 唤醒图片贴纸 */
export async function enterCaptureMode(limit = 50) {
  if (_active) return;
  const chatArea = document.querySelector('#chatArea');
  if (!chatArea) return;
  const rows = [...chatArea.querySelectorAll('.msg-row')];
  if (!rows.length) { toast('还没有聊天记录'); return; }

  _active = true;
  _limit = limit;
  toast('正在准备图片…');

  // 只留最后 limit 条：用 class 隐藏而不是删 DOM —— 退出时零成本还原，
  // 而且被藏起来的那些图不会参与下面的唤醒（防 OOM）
  const keep = Math.max(1, limit);
  _hiddenRows = rows.slice(0, Math.max(0, rows.length - keep));
  _hiddenRows.forEach(r => r.classList.add('cap-hide'));

  // 摊平。两棵树都要挂 class：`html,body{overflow:hidden}` 是写在同一条规则里的，
  // 只放开 body 没用 —— 视口滚动是由 html 决定的
  document.documentElement.classList.add('capture-mode');
  document.body.classList.add('capture-mode');
  window.scrollTo(0, 0);

  // 暂停"滚出视口就卸载贴纸"：摊平后只有第一屏在视口里，不停掉的话
  // 下面的贴纸会在她滚过去之前就被换成 1×1 占位
  window.pauseStickerLazy?.(true);

  // 退出按钮插在消息列表首尾：进模式时她站在页首，一眼能看到上面那个
  chatArea.insertBefore(_exitBar(), chatArea.firstChild);
  chatArea.appendChild(_exitBar());

  await _wakeImages(chatArea);
  if (!_active) return;   // 唤醒过程中她可能已经点了退出
  _hotspot();
  toast('可以截了：指关节画 S｜截完点最上面那条「退出长截图模式」');
}

/** 退出长截图模式，恢复成原来的聊天界面 */
export function exitCaptureMode() {
  if (!_active) return;
  _active = false;

  document.documentElement.classList.remove('capture-mode');
  document.body.classList.remove('capture-mode');
  _hiddenRows.forEach(r => r.classList.remove('cap-hide'));
  _hiddenRows = [];
  document.querySelector('#capHotspot')?.remove();
  document.querySelectorAll('[data-cap-exit]').forEach(el => el.remove());
  window.pauseStickerLazy?.(false);

  const chatArea = document.querySelector('#chatArea');
  if (chatArea) chatArea.scrollTop = chatArea.scrollHeight;
  toast('已退出长截图模式');
}
