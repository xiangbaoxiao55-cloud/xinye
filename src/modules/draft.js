/**
 * 输入框草稿 —— 打了一半的字别丢。
 *
 * 三个会咬人的场景（前两个是真发生过的）：
 *  ① SW 检测到新版本会 `location.reload()`（`main.js` 的 `_swReload`）——它只等
 *     `isRequesting`（她发出去到回复完那段），**正在打、还没发出去的字当场没**；
 *  ② 她切出去看别的，系统把 WebView 回收了，回来是重新加载的；
 *  ③ 手滑关掉 APP。
 *
 * key 按 app 分（炘也页/臭宝页各自的草稿互不串），存 localStorage 不存 IDB ——
 * 这么点字不值得开一次事务。（注意 `choubao.html` 与 `index.html` 同源，
 * 不分开的话两边会互相覆盖。）
 */
const KEY = (window.__APP_ID__ === 'choubao' ? 'choubao_' : 'xinye_') + 'input_draft';
const MAX = 5000;   // 超过就不存了，localStorage 是全站共用的那 5MB
const WAIT = 400;

let _t = null;

function _save(el) {
  try {
    const v = el.value;
    if (!v.trim()) localStorage.removeItem(KEY);
    else if (v.length <= MAX) localStorage.setItem(KEY, v);
  } catch (_) {}   // 存不下就算了，不能让写草稿把发消息带崩
}

/**
 * 恢复上次没发出去的字，并开始记录后续输入。
 * ⚠️ **恢复完要自己调一次 `autoResize()`**（调用方负责）——多行草稿得把输入框撑到该有的高度，
 * 顺带把发送键点亮。程序性赋值 `value` 不会触发 input 事件，这里没有别的机会补。
 */
export function initInputDraft(el) {
  if (!el) return;
  let saved = '';
  try { saved = localStorage.getItem(KEY) || ''; } catch (_) {}
  if (saved) el.value = saved;
  const _later = () => { clearTimeout(_t); _t = setTimeout(() => _save(el), WAIT); };
  el.addEventListener('input', _later);
  el.addEventListener('compositionend', _later);   // 拼音上屏那一下
  el.addEventListener('blur', () => { clearTimeout(_t); _save(el); });
}

/**
 * 发出去、或被别处取用之后调它。
 * 🔴 **必须显式调**：`userInput.value = ''` 是程序性赋值，**不会触发 input 事件**，
 * 光靠监听的话草稿会赖在那儿，下次打开又把已经发过的话倒回输入框。
 */
export function clearInputDraft() {
  clearTimeout(_t);
  try { localStorage.removeItem(KEY); } catch (_) {}
}
