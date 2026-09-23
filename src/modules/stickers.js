import { dbPut, dbGet, dbDelete, dbGetAll } from './db.js';
import { $, toast, escHtml, readFileAsBase64 } from './utils.js';
import { settings, messages } from './state.js';

// ── 装饰贴纸（画面上可拖拽/缩放/旋转的图片） ───────────────────────────────
const _decoStickers = [];

export function getDecoStickers() { return _decoStickers; }

export function setDecoStickers(arr) {
  _decoStickers.length = 0;
  _decoStickers.push(...arr);
}

function createStickerDOM(s) {
  if (s.rot === undefined) s.rot = 0;
  const stickerLayer = document.getElementById('stickerLayer');
  const el = document.createElement('div');
  el.className = 'sticker';
  el.dataset.id = s.id;
  el.style.left = s.x + 'px';
  el.style.top  = s.y + 'px';
  el.style.width  = s.w + 'px';
  el.style.height = s.h + 'px';
  el.style.transform = `rotate(${s.rot}deg)`;
  el.innerHTML = `
    <img src="${s.data}" alt="sticker">
    <button class="sticker-del"><i class="ic ic-x"></i></button>
    <div class="sticker-resize"></div>
    <div class="sticker-rotate-line"></div>
    <div class="sticker-rotate"><i class="ic ic-rotate-cw"></i></div>`;
  stickerLayer.appendChild(el);

  el.querySelector('.sticker-del').addEventListener('click', async (e) => {
    e.stopPropagation();
    await dbDelete('stickers', s.id);
    const idx = _decoStickers.findIndex(x => x.id === s.id);
    if (idx >= 0) _decoStickers.splice(idx, 1);
    el.remove();
    toast('贴纸已删除');
  });

  let dragging = false, startX, startY, origX, origY;
  el.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.sticker-resize') || e.target.closest('.sticker-del') || e.target.closest('.sticker-rotate')) return;
    dragging = true;
    el.style.cursor = 'grabbing';
    startX = e.clientX; startY = e.clientY;
    origX = parseFloat(el.style.left); origY = parseFloat(el.style.top);
    el.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  el.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    el.style.left = (origX + e.clientX - startX) + 'px';
    el.style.top  = (origY + e.clientY - startY) + 'px';
  });
  el.addEventListener('pointerup', async () => {
    if (!dragging) return;
    dragging = false;
    el.style.cursor = 'grab';
    const obj = _decoStickers.find(x => x.id === s.id);
    if (obj) {
      obj.x = parseFloat(el.style.left);
      obj.y = parseFloat(el.style.top);
      await dbPut('stickers', null, obj);
    }
  });

  const resizer = el.querySelector('.sticker-resize');
  let resizing = false, rStartX, rStartY, rOrigW, rOrigH;
  resizer.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    resizing = true;
    rStartX = e.clientX; rStartY = e.clientY;
    rOrigW = parseFloat(el.style.width); rOrigH = parseFloat(el.style.height);
    resizer.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  resizer.addEventListener('pointermove', (e) => {
    if (!resizing) return;
    const dx = e.clientX - rStartX, dy = e.clientY - rStartY;
    const delta = Math.max(dx, dy);
    el.style.width  = Math.max(40, rOrigW + delta) + 'px';
    el.style.height = Math.max(40, rOrigH + delta) + 'px';
  });
  resizer.addEventListener('pointerup', async () => {
    if (!resizing) return;
    resizing = false;
    const obj = _decoStickers.find(x => x.id === s.id);
    if (obj) {
      obj.w = parseFloat(el.style.width);
      obj.h = parseFloat(el.style.height);
      await dbPut('stickers', null, obj);
    }
  });

  const rotator = el.querySelector('.sticker-rotate');
  let rotating = false, rotStartAngle, rotOrigDeg;
  rotator.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    e.preventDefault();
    rotating = true;
    rotator.setPointerCapture(e.pointerId);
    const rect = el.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top  + rect.height / 2;
    rotStartAngle = Math.atan2(e.clientY - cy, e.clientX - cx) * (180 / Math.PI);
    const obj = _decoStickers.find(x => x.id === s.id);
    rotOrigDeg = obj ? obj.rot : 0;
  });
  rotator.addEventListener('pointermove', (e) => {
    if (!rotating) return;
    const rect = el.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top  + rect.height / 2;
    const curAngle = Math.atan2(e.clientY - cy, e.clientX - cx) * (180 / Math.PI);
    const delta = curAngle - rotStartAngle;
    el.style.transform = `rotate(${rotOrigDeg + delta}deg)`;
  });
  rotator.addEventListener('pointerup', async () => {
    if (!rotating) return;
    rotating = false;
    const match = el.style.transform.match(/rotate\(([-\d.]+)deg\)/);
    const finalDeg = match ? parseFloat(match[1]) : 0;
    const obj = _decoStickers.find(x => x.id === s.id);
    if (obj) {
      obj.rot = Math.round(finalDeg * 10) / 10;
      await dbPut('stickers', null, obj);
    }
  });
}

export function renderStickers() {
  const stickerLayer = document.getElementById('stickerLayer');
  stickerLayer.innerHTML = '';
  _decoStickers.forEach(s => createStickerDOM(s));
}

// ══ 聊天贴纸 v2 ═══════════════════════════════════════════════════════════
//
// 存储（都在 settings store 里，⚠️ 别改成 dbGetAll('settings') 全量拉）：
//   'cstk_index'      → [{id, name, emoji, hasImg, desc, ts}]   元数据，永远很小
//   'cstk_img_<id>'   → 'data:image/...'                        图片，按需单独读
//   'cstk_migrated'   → 1                                       老数据迁移标记
//   'cstk_inited'     → 1                                       默认贴纸已播种
//
// 为什么不复用 `stickers` 表：main.js:262 把那张表整个当成**装饰贴纸**加载
// （setDecoStickers(await dbGetAll('stickers'))），聊天贴纸进去会铺满屏幕；
// backup.js 恢复时还会 dbClear('stickers') 把聊天贴纸一起清掉。
//
// 为什么不新建一张表：那要升 DB_VER，而 DB_VER 升版本期间所有页面会 onblocked，
// 对手机端是不能赌的风险。settings store 本来就是个按 key 读的杂货铺，够用。
//
// 图片为什么能缩：聊天里最大显示 130px（.sticker-img）、面板里 48px，
// 所以静态图一律压到最长边 256px 存；GIF 是动图，原样保留。

const _IDX_KEY  = 'cstk_index';
const _IMG_PFX  = 'cstk_img_';
const _MIGRATED = 'cstk_migrated';
const _INITED   = 'cstk_inited';
// 1×1 透明 gif —— 图还没从 IDB 读出来时的占位，避免 img 空 src 触发一次页面请求
const _PH = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
const _MAX_SIDE = 256;
const _SMALL_ENOUGH = 60000;   // dataURL 短于这个长度就不折腾了

const _DEFAULT_STICKERS = [
  {id:'hug',  name:'抱抱', emoji:'🤗'}, {id:'kiss', name:'亲亲', emoji:'💋'},
  {id:'love', name:'爱你', emoji:'💙'}, {id:'shy',  name:'害羞', emoji:'☺️'},
  {id:'cute', name:'卖萌', emoji:'🥺'}, {id:'poor', name:'装可怜',emoji:'😢'},
  {id:'plead',name:'求求', emoji:'🙏'}, {id:'peek', name:'偷看', emoji:'👀'},
  {id:'sad',  name:'委屈', emoji:'😞'}, {id:'cry',  name:'哭哭', emoji:'😭'},
  {id:'angry',name:'生气', emoji:'😠'}, {id:'smirk',name:'坏笑', emoji:'😏'},
  {id:'meh',  name:'无语', emoji:'🙄'}, {id:'punch',name:'锤你', emoji:'🔨'},
  {id:'kick', name:'踢你', emoji:'🦵'}, {id:'slap', name:'抽你', emoji:'💢'},
];

const _chatStickers = [];        // 元数据（不含图片）
const _imgLoading = new Set();   // 正在读的 id，防重复请求

// 图片内存缓存，**按字节数做 LRU 淘汰**。
// ⚠️ GIF 走不了 canvas（会只剩第一帧），所以原样存 —— 单张能到 2MB+，
// 一个 80 张的表情包图包就是 50MB 上下。全留在内存里手机会 OOM，
// 所以这里设上限，超了就把最久没用过的挤出去（DOM 里已渲染的图不受影响，
// 浏览器自己拿着解码结果；只是下次重新渲染时要再读一次 IDB）。
const _imgCache = new Map();     // id → dataURL（Map 的迭代顺序即 LRU 顺序）
let _imgCacheBytes = 0;
const _IMG_CACHE_MAX = 24 * 1024 * 1024;

function _cacheGet(id) {
  const v = _imgCache.get(id);
  if (v === undefined) return undefined;
  _imgCache.delete(id); _imgCache.set(id, v);   // 挪到队尾 = 最近用过
  return v;
}
function _cacheSet(id, data) {
  if (typeof data !== 'string') return;
  const old = _imgCache.get(id);
  if (old !== undefined) { _imgCacheBytes -= old.length; _imgCache.delete(id); }
  _imgCache.set(id, data);
  _imgCacheBytes += data.length;
  while (_imgCacheBytes > _IMG_CACHE_MAX && _imgCache.size > 1) {
    const oldest = _imgCache.keys().next().value;
    _imgCacheBytes -= _imgCache.get(oldest).length;
    _imgCache.delete(oldest);
  }
}
function _cacheDrop(id) {
  const v = _imgCache.get(id);
  if (v === undefined) return;
  _imgCacheBytes -= v.length;
  _imgCache.delete(id);
}

export function getChatStickers() { return _chatStickers; }

export function isStickerImgReady(id) { return _imgCache.has(id); }

/** 拿已经加载好的图；没加载过返回 null（调用方自己决定要不要 await ensureStickerImg） */
export function peekStickerImg(id) { return _cacheGet(id) || null; }

export async function ensureStickerImg(id) {
  const hit = _cacheGet(id);
  if (hit !== undefined) return hit;
  if (_imgLoading.has(id)) return null;
  _imgLoading.add(id);
  try {
    const data = await dbGet('settings', _IMG_PFX + id);
    if (data) {
      _cacheSet(id, data);
      // 自愈：把页面上还在占位的同 id 图换掉（聊天气泡和贴纸库里的都算）
      // ⚠️ data-sid 不能摘 —— 视口懒加载的 observer 靠它认人
      document.querySelectorAll(`img[data-sid="${id}"]`).forEach(el => {
        if (el.dataset.unmounted === '1') return;   // 离屏的别动，等它滚回来自己挂
        el.src = data;
        el.classList.remove('sticker-img-loading');
      });
      return data;
    }
  } catch (e) { console.warn('[Sticker] 读图失败', id, e); }
  finally { _imgLoading.delete(id); }
  return null;
}

// ── 视口懒加载：滚出屏幕的贴纸卸掉，别让几十个 GIF 一起播 ──────────────────
//
// ⚠️ 为什么非做不可：贴纸图一旦渲染进 DOM，浏览器就**解码一份位图攥着不放**，
// 而且 GIF 会**一直循环播放**。`_imgCache` 的 LRU 只管我这份 dataURL 缓存，
// 管不到已经上屏的 <img>。聊天区又没有虚拟滚动（displayLimit 默认不限），
// 攒到两三百条贴纸消息就是几十 MB 内存 + 几十个动画同时烧 CPU。
//
// 做法：滚出视口就换回 1×1 占位（位图释放、动画停止），滚回来再挂上。
// 卸载前把实际显示尺寸写进 inline style，否则图变 1px、整页会往上缩着跳。

const _PH_MAX = 130;   // 跟 .sticker-img 的 max-width/max-height 对齐

function _placeholderSize(w, h) {
  if (!w || !h) return null;
  const k = Math.min(1, _PH_MAX / Math.max(w, h));
  return [Math.round(w * k), Math.round(h * k)];
}

function _unmountStickerImg(el) {
  if (el.dataset.unmounted === '1') return;
  if (!el.src || el.src === _PH) return;
  const size = _placeholderSize(el.naturalWidth, el.naturalHeight);
  if (size) { el.style.width = size[0] + 'px'; el.style.height = size[1] + 'px'; }
  el.dataset.unmounted = '1';
  el.src = _PH;
}

async function _mountStickerImg(el) {
  if (el.dataset.unmounted !== '1') return;
  const sid = el.dataset.sid;
  if (!sid) return;
  const data = _cacheGet(sid) || await ensureStickerImg(sid);
  if (!data || !el.isConnected) return;
  delete el.dataset.unmounted;
  el.style.width = '';
  el.style.height = '';
  el.src = data;
}

// 长截图模式会把整页摊开，只有第一屏在视口里 —— 不暂停的话，下面的贴纸会在
// 她滚过去之前就被换成 1×1 占位，长图里全是空白。暂停期间"挂回"照常，只停"卸载"。
let _lazyPaused = false;

// 不支持 IntersectionObserver 的环境直接不注册 —— 那就退回"渲染完一直挂着"的老行为
const _stickerObserver = (typeof IntersectionObserver === 'function')
  ? new IntersectionObserver((entries) => {
      for (const e of entries) {
        const el = e.target;
        if (!el.dataset || !el.dataset.sid) continue;
        if (e.isIntersecting) _mountStickerImg(el);
        else if (!_lazyPaused) _unmountStickerImg(el);
      }
    }, { rootMargin: '400px 0px' })
  : null;

/** 长截图模式：进模式时 true（别把视口外的贴纸卸掉），退出时 false */
export function pauseStickerLazy(paused) {
  _lazyPaused = !!paused;
}

/** 长截图模式：把 root 里已经被卸载的贴纸当场全挂回来，返回全部完成的 promise */
export function mountAllStickerImgs(root) {
  const list = [...(root || document).querySelectorAll('img.sticker-img[data-unmounted="1"]')];
  return Promise.all(list.map(el => _mountStickerImg(el)));
}

/** 把 root 里还没登记的贴纸图挂上观察者（渲染完消息 / 追加新消息时调一次） */
export function observeStickerImgs(root) {
  if (!_stickerObserver || !root || !root.querySelectorAll) return;
  // ⚠️ 只认聊天气泡里的 .sticker-img。贴纸面板和贴纸库里的缩略图是固定小尺寸
  //    （48px / 网格等分），拿这里按 130px 算出来的占位尺寸会把它们的布局撑坏；
  //    而且那两个每次开都重建 innerHTML，旧的图自己就释放了，不需要额外管。
  root.querySelectorAll('img.sticker-img[data-sid]').forEach(el => {
    if (el.dataset.obs === '1') return;
    el.dataset.obs = '1';
    _stickerObserver.observe(el);
  });
}

// ── 索引读写 ──────────────────────────────────────────────────────────────

function _clean(item) {
  return {
    id: item.id,
    name: item.name || '贴纸',
    emoji: item.emoji || '🎭',
    hasImg: !!item.hasImg,
    desc: item.desc || '',
    ts: item.ts || 0,
  };
}

async function _saveIndex() {
  return dbPut('settings', _IDX_KEY, _chatStickers.map(_clean));
}

function _seedDefaults() {
  const now = Date.now();
  _chatStickers.length = 0;
  _chatStickers.push(..._DEFAULT_STICKERS.map((s, i) => ({...s, hasImg:false, desc:'', ts: now + i})));
}

// ── 迁移：老的 settings/chat_stickers（一个大 JSON，图是 base64 塞在里面）──
async function _migrateLegacy() {
  if (await dbGet('settings', _MIGRATED)) return;
  let legacy = null;
  try { legacy = await dbGet('settings', 'chat_stickers'); } catch(_) {}
  if (!legacy) {
    try { legacy = await dbGet('settings', 'ls_xinye_chat_stickers'); } catch(_) {}
  }
  let arr = null;
  try { arr = JSON.parse(typeof legacy === 'string' ? legacy : JSON.stringify(legacy)); } catch(_) {}
  if (!Array.isArray(arr) || !arr.length) {
    await dbPut('settings', _MIGRATED, 1);
    return;
  }
  const now = Date.now();
  const idx = [];
  for (let i = 0; i < arr.length; i++) {
    const s = arr[i] || {};
    const id = s.id || ('cst_' + now + '_' + i);
    const item = { id, name: s.name || '贴纸', emoji: s.emoji || '🎭', hasImg: !!s.image, desc:'', ts: now + i };
    if (s.image) {
      try {
        const small = await _shrink(s.image);
        await dbPut('settings', _IMG_PFX + id, small);
      } catch (e) {
        console.warn('[Sticker] 迁移图片失败，原样保留', s.name, e);
        try { await dbPut('settings', _IMG_PFX + id, s.image); } catch(_) {}
      }
    }
    idx.push(item);
  }
  await dbPut('settings', _IDX_KEY, idx);
  await dbPut('settings', _MIGRATED, 1);
  // ⚠️ 刻意不删老的 chat_stickers：留作回退。它只是个死数据，不占运行时内存。
  console.log('[Sticker] 老贴纸迁移完成：', idx.length, '张');
}

export async function loadChatStickers() {
  await _migrateLegacy();
  let idx = null;
  try { idx = await dbGet('settings', _IDX_KEY); } catch(_) {}
  if (!Array.isArray(idx)) {
    if (!(await dbGet('settings', _INITED))) {
      _seedDefaults();
      await dbPut('settings', _INITED, 1);
      await _saveIndex();
    } else {
      _chatStickers.length = 0;
    }
  } else {
    _chatStickers.length = 0;
    _chatStickers.push(...idx.map(_clean));
  }
  _warmImages();
}

/**
 * 后台把图读进内存。⚠️ 只预热够用的那点量：GIF 压不了，单张能到 2MB，
 * 全量预热 80 张就是 50MB，而且超上限的读完立刻被 LRU 淘汰 = 白读一遍 IDB。
 * 剩下的按需加载。
 */
async function _warmImages() {
  const ids = _chatStickers.filter(s => s.hasImg && !_imgCache.has(s.id)).map(s => s.id);
  const limit = Math.min(ids.length, 30);
  for (let i = 0; i < limit; i += 6) {
    await Promise.all(ids.slice(i, i + 6).map(id => ensureStickerImg(id)));
    await new Promise(r => setTimeout(r, 40));
  }
}

// ── 图片处理 ──────────────────────────────────────────────────────────────

/**
 * 把 dataURL 压到最长边 256px。GIF 是动图，不能走 canvas（会只剩第一帧），原样返回。
 * 压完反而更大的话也返回原图。任何一步出错都退回原图 —— 宁可不压，不能弄丢。
 *
 * ⚠️ 判断"要不要压"看的是**像素尺寸**，不是 dataURL 长度：一张 900×900 的纯色 PNG
 * 只有十几 KB，光看体积会放它过去，然后渲染时按 900px 解码（比 256px 多占 12 倍内存）。
 */
export function _shrink(dataUrl) {
  return new Promise(resolve => {
    if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) return resolve(dataUrl);
    if (/^data:image\/gif/i.test(dataUrl)) return resolve(dataUrl);
    const img = new Image();
    img.onload = () => {
      try {
        const w = img.naturalWidth, h = img.naturalHeight;
        if (!w || !h) return resolve(dataUrl);
        // 尺寸和体积都够小才放过
        if (w <= _MAX_SIDE && h <= _MAX_SIDE && dataUrl.length < _SMALL_ENOUGH) return resolve(dataUrl);
        const scale = Math.min(1, _MAX_SIDE / Math.max(w, h));
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(w * scale));
        c.height = Math.max(1, Math.round(h * scale));
        const ctx = c.getContext('2d');
        ctx.drawImage(img, 0, 0, c.width, c.height);
        let out = c.toDataURL('image/webp', 0.86);
        if (!out.startsWith('data:image/webp')) out = c.toDataURL('image/png');   // 老 WebView 不支持 webp 导出
        resolve(out.length && out.length < dataUrl.length ? out : dataUrl);
      } catch (e) { resolve(dataUrl); }
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

// ── 导入 ──────────────────────────────────────────────────────────────────

const _MEANINGLESS = /^(img|image|photo|pic|screenshot|screencapture|微信图片|截屏|截图|无标题|untitled|微信截图)[\d_\-\s().]*$/i;

function _nameFromFile(filename, takenNames) {
  let n = String(filename || '').replace(/\.[^.]+$/, '').trim();
  if (!n || _MEANINGLESS.test(n) || /^[\d_\-\s]+$/.test(n)) {
    n = '贴纸' + (_chatStickers.length + takenNames.length + 1);
  }
  n = n.slice(0, 16);
  let base = n, k = 2;
  const has = (x) => _chatStickers.some(s => s.name === x) || takenNames.includes(x);
  while (has(n)) { n = base + (k++); }
  return n;
}

/**
 * 批量导入贴纸文件。逐张串行处理 —— 一次性把几十张图读进内存会 OOM。
 * @param {FileList|File[]} files
 * @param {(done:number,total:number,name:string)=>void} [onProgress]
 * @returns {Promise<number>} 成功导入的张数
 */
export async function importStickerFiles(files, onProgress) {
  const list = Array.from(files || []).filter(f => /^image\//i.test(f.type || '') || /\.(png|jpe?g|gif|webp|bmp|avif)$/i.test(f.name || ''));
  const added = [];
  for (let i = 0; i < list.length; i++) {
    const f = list[i];
    try { onProgress?.(i, list.length, f.name); } catch(_) {}
    try {
      const raw = await readFileAsBase64(f);
      const data = await _shrink(raw);
      const item = {
        id: 'cst_' + Date.now() + '_' + i,
        name: _nameFromFile(f.name, added.map(a => a.name)),
        emoji: '🎭', hasImg: true, desc: '', ts: Date.now() + i,
      };
      await dbPut('settings', _IMG_PFX + item.id, data);
      _cacheSet(item.id, data);
      added.push(item);
    } catch (e) {
      console.warn('[Sticker] 导入失败：', f.name, e);
    }
  }
  if (added.length) {
    _chatStickers.push(...added);
    await _saveIndex();
  }
  try { onProgress?.(list.length, list.length, ''); } catch(_) {}
  return added.length;
}

// ── 从链接批量导入（别人分享的图包：名字 + 图片地址）─────────────────────

const _URL_IN_LINE = /https?:\/\/[^\s"'<>]+/i;

/**
 * 解析粘贴的清单。每行一条「名字 + 链接」：
 *     生气了哄不好的那种 https://u2.fukit.cn/4uhF9bynr
 * 名字和链接之间用空格或 Tab 隔开；只有链接也行（名字自动生成）。
 */
export function parseStickerList(text) {
  const out = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(_URL_IN_LINE);
    if (!m) continue;
    const name = line.slice(0, m.index).replace(/[\t\-—–:|]+$/, '').trim();
    out.push({ name, url: m[0] });
  }
  return out;
}

function _blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = e => resolve(e.target.result);
    r.onerror = () => reject(new Error('读不出图'));
    r.readAsDataURL(blob);
  });
}

/**
 * 抓一张图转成 dataURL。先直连 —— 图床若给了 CORS 就不用绕路；
 * 被跨域拦住再退回本站的 /api/img-proxy。
 */
async function _grabImage(url) {
  try {
    const res = await fetch(url, { mode: 'cors', credentials: 'omit' });
    if (res.ok) {
      const blob = await res.blob();
      if (blob && blob.size) return await _blobToDataUrl(blob);
    }
  } catch (_) { /* 跨域被拦，落到下面走代理 */ }
  const res2 = await fetch(`/api/img-proxy?url=${encodeURIComponent(url)}`);
  // 代理不跟随重定向。短链（302 到真实图床）走到这里就抓不到图 ——
  // 直连之所以失败，正是因为那一跳没有 CORS 头，代理也补不了这个缺口。
  if (res2.status === 301 || res2.status === 302) {
    throw new Error('这是个短链，需要先解析成直链');
  }
  if (!res2.ok) throw new Error('HTTP ' + res2.status);
  const blob2 = await res2.blob();
  if (!blob2 || !blob2.size) throw new Error('空响应');
  return await _blobToDataUrl(blob2);
}

let _urlImportAborted = false;
export function abortStickerUrlImport() { _urlImportAborted = true; }

/**
 * 从「名字+链接」清单批量导入。
 *
 * ⚠️ 逐条串行、每条之间歇 150ms —— 实测那个图床并发请求会被 429。
 * ⚠️ 清单里的图多数是 GIF，压不了（canvas 只能留第一帧），所以是**原样进库**：
 *    单张能到 2MB。80 张就是 50MB，内存侧靠 _imgCache 的 LRU 兜着。
 * 单条失败不中断整批，失败的回报给调用方。
 *
 * @param {string} text  清单正文，或**一个清单文件的链接**（整段只有一行链接时自动拉取）
 * @returns {Promise<{added:number, failed:Array, total:number, aborted:boolean}>}
 */
export async function importStickerUrls(text, onProgress) {
  _urlImportAborted = false;
  let content = String(text || '');

  // 整段就是个链接 → 当成清单文件拉下来
  const probe = content.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  if (probe.length === 1 && /^https?:\/\/\S+$/i.test(probe[0])) {
    try {
      const res = await fetch(probe[0]);
      if (res.ok) content = await res.text();
    } catch (e) { console.warn('[Sticker] 清单拉取失败', e); }
  }

  const items = parseStickerList(content);
  const added = [], failed = [], takenNames = [];
  let cursor = 0, done = 0;

  const worker = async () => {
    while (cursor < items.length && !_urlImportAborted) {
      const i = cursor++;
      const { name, url } = items[i];
      try {
        const raw = await _grabImage(url);
        const data = await _shrink(raw);
        // 名字在这里同步分配 —— 三个 worker 并发时靠 takenNames 占位，不然会撞名
        const nm = _nameFromFile(name || '', takenNames);
        takenNames.push(nm);
        const item = {
          id: 'cst_' + Date.now() + '_' + i,
          name: nm, emoji: '🎭', hasImg: true, desc: '', ts: Date.now() + i,
        };
        await dbPut('settings', _IMG_PFX + item.id, data);
        _cacheSet(item.id, data);
        added.push(item);
      } catch (e) {
        console.warn('[Sticker] 链接导入失败：', name, url, e);
        failed.push({ name: name || url, url });
      }
      done++;
      try { onProgress?.(done, items.length, name || url); } catch(_) {}
      await new Promise(r => setTimeout(r, 100));
    }
  };
  // 小并发。实测十几条并发会被图床 429，纯串行 80 张要跑七分钟 —— 三条刚好。
  await Promise.all(Array.from({ length: Math.min(3, items.length) }, worker));
  if (added.length) {
    _chatStickers.push(...added);
    await _saveIndex();
  }
  try { onProgress?.(items.length, items.length, ''); } catch(_) {}
  return { added: added.length, failed, total: items.length, aborted: _urlImportAborted };
}

// ── 增删改 ────────────────────────────────────────────────────────────────

export async function deleteStickerById(id) {
  const i = _chatStickers.findIndex(s => s.id === id);
  if (i < 0) return;
  _chatStickers.splice(i, 1);
  _cacheDrop(id);
  try { await dbDelete('settings', _IMG_PFX + id); } catch(_) {}
  await _saveIndex();
}

export async function deleteStickersByIds(ids) {
  const set = new Set(ids);
  const keep = _chatStickers.filter(s => !set.has(s.id));
  if (keep.length === _chatStickers.length) return 0;
  const removed = _chatStickers.length - keep.length;
  _chatStickers.length = 0;
  _chatStickers.push(...keep);
  for (const id of set) {
    _cacheDrop(id);
    try { await dbDelete('settings', _IMG_PFX + id); } catch(_) {}
  }
  await _saveIndex();
  return removed;
}

export async function renameStickerById(id, newName) {
  newName = String(newName || '').trim().slice(0, 16);
  const s = _chatStickers.find(x => x.id === id);
  if (!s || !newName || s.name === newName) return false;
  if (_chatStickers.some(x => x.id !== id && x.name === newName)) return false;

  const oldName = s.name;
  s.name = newName;
  await _saveIndex();

  // 历史消息里的引用一起改 —— 「（炘也发了一个「X」贴纸）」和 [sticker:X] 两种写法
  const oldPill = `「${oldName}」`, newPill = `「${newName}」`;
  const oldTag  = `[sticker:${oldName}]`, newTag = `[sticker:${newName}]`;
  for (const msg of messages) {
    if (!msg.content) continue;
    if (!msg.content.includes(oldPill) && !msg.content.includes(oldTag)) continue;
    msg.content = msg.content.replaceAll(oldPill, newPill).replaceAll(oldTag, newTag);
    if (msg.id) { try { await dbPut('messages', null, msg); } catch(_) {} }
  }
  return true;
}

export async function setStickerDesc(id, desc) {
  const s = _chatStickers.find(x => x.id === id);
  if (!s) return;
  s.desc = String(desc || '').slice(0, 200);
  await _saveIndex();
}

/** 兼容旧调用：整体替换索引（只存元数据，图片按 id 单独管） */
export async function saveChatStickers(arr) {
  const snapshot = (arr || []).map(_clean);
  _chatStickers.length = 0;
  _chatStickers.push(...snapshot);
  await _saveIndex();
}

// ── 备份用：导出/恢复 ─────────────────────────────────────────────────────

/**
 * 导出贴纸（**带图片**）。
 * 图片一律现读 IDB，不依赖 _imgCache —— 懒加载可能还没轮完，少了哪张都会让她
 * 「导出备份再导回来」时静默丢图。
 */
export async function exportStickers() {
  const out = [];
  for (const s of _chatStickers) {
    const item = { id: s.id, name: s.name, emoji: s.emoji };
    if (s.hasImg) {
      let img = _cacheGet(s.id);
      if (!img) {
        try { img = await dbGet('settings', _IMG_PFX + s.id); } catch(_) {}
      }
      if (img) { _cacheSet(s.id, img); item.image = img; }
    }
    out.push(item);
  }
  return out;
}

/**
 * 从备份恢复贴纸库（整体替换）。
 * ⚠️ 末尾必须写 `cstk_migrated`：老库里的 settings/chat_stickers 我们刻意没删，
 * 不落这个标记的话，下次启动 _migrateLegacy 会把老数据又盖回来。
 */
export async function importStickersData(arr) {
  if (!Array.isArray(arr)) return 0;
  for (const s of _chatStickers) {
    _cacheDrop(s.id);
    try { await dbDelete('settings', _IMG_PFX + s.id); } catch(_) {}
  }
  _chatStickers.length = 0;

  const now = Date.now();
  const idx = [];
  for (let i = 0; i < arr.length; i++) {
    const s = arr[i] || {};
    const id = s.id || ('cst_' + now + '_' + i);
    const hasImg = !!s.image;
    const item = { id, name: s.name || '贴纸', emoji: s.emoji || '🎭', hasImg, desc: s.desc || '', ts: s.ts || (now + i) };
    if (hasImg) {
      let img = s.image;
      try { img = await _shrink(s.image); } catch(_) {}
      try {
        await dbPut('settings', _IMG_PFX + id, img);
        _cacheSet(id, img);
      } catch(e) { console.warn('[Sticker] 恢复图片失败', s.name, e); item.hasImg = false; }
    }
    idx.push(item);
  }
  await dbPut('settings', _IDX_KEY, idx);
  await dbPut('settings', _INITED, 1);
  await dbPut('settings', _MIGRATED, 1);
  _chatStickers.push(...idx);
  return idx.length;
}

function getStickerByName(name) { return getChatStickers().find(s => s.name === name); }

// ── 渲染 ──────────────────────────────────────────────────────────────────

export function renderStickerHTML(name) {
  const s = getStickerByName(name);
  if (!s) return `<span class="sticker-pill">🎭 ${escHtml(name)}</span>`;
  if (!s.hasImg) return `<span class="sticker-pill">${escHtml(s.emoji || '🎭')} ${escHtml(s.name)}</span>`;
  const sid = escHtml(s.id);
  const cached = _cacheGet(s.id);
  // dataURL 字符集是 base64，不含需要转义的字符，直接拼（escHtml 每帧跑几万字符的图太浪费）
  // ⚠️ 不管有没有图都带 data-sid：视口懒加载的 observer 靠它认人
  if (cached) return `<img class="sticker-img" data-sid="${sid}" src="${cached}" alt="${escHtml(s.name)}">`;
  ensureStickerImg(s.id);
  return `<img class="sticker-img sticker-img-loading" data-sid="${sid}" src="${_PH}" alt="${escHtml(s.name)}">`;
}

export function detectStickerMsg(content) {
  const m = content?.match(/^（.+?发了一个「(.+?)」贴纸）$/);
  return m ? m[1] : null;
}

export function applyStickerTags(el) {
  if (!el) return;
  el.innerHTML = el.innerHTML.replace(/\[sticker:([^\]]{1,20})\]/g, (_, name) =>
    `<span class="sticker-inline">${renderStickerHTML(name.trim())}</span>`);
}

/**
 * 给 AI 的贴纸提示。
 * 🔴 这段是 push 在 cache_control 断点**之后**的（chat.js 里 _stableBlocks 之后才 push），
 * 它变或不变都不影响前面的 prompt cache 命中。但也因为它在断点外，
 * 每轮变就意味着这段**自身永远不命中缓存** —— 所以内容要尽量短。
 * 第二版会换成「按这轮聊天检索出的十来张候选 + 描述」，届时长度要盯住。
 */
export function getStickerHint() {
  const names = getChatStickers().map(s => s.name).join('、');
  return `【贴纸】你可以在回复中自然发贴纸，格式：[sticker:名字]，只在情感真实时使用，不要强行插入。可用：${names}`;
}

export function openStickerPanel() {
  const stickers = getChatStickers();
  document.getElementById('stickerGrid').innerHTML = stickers.map(s => {
    const img = s.hasImg ? peekStickerImg(s.id) : null;
    if (s.hasImg && !img) ensureStickerImg(s.id);
    const inner = s.hasImg
      ? (img ? `<img class="sticker-pick-img" src="${img}" alt="">`
             : `<img class="sticker-pick-img" data-sid="${escHtml(s.id)}" src="${_PH}" alt="">`)
      : `<div class="sticker-pick-placeholder">${escHtml(s.emoji || '🎭')}</div>`;
    return `<button class="sticker-pick-btn" data-sticker-name="${escHtml(s.name)}">${inner}<span>${escHtml(s.name)}</span></button>`;
  }).join('');
  // 用事件委托，避免把名字拼进 onclick 字符串（名字里可能有引号）
  const grid = document.getElementById('stickerGrid');
  if (grid && !grid._bound) {
    grid._bound = true;
    grid.addEventListener('click', (e) => {
      const btn = e.target.closest('.sticker-pick-btn');
      if (btn) sendStickerMsg(btn.dataset.stickerName);
    });
  }
  document.getElementById('stickerPanel').classList.add('show');
}

export function closeStickerPanel() { document.getElementById('stickerPanel').classList.remove('show'); }

export function sendStickerMsg(name) {
  closeStickerPanel();
  const userInput = document.getElementById('userInput');
  const tag = `[sticker:${name}]`;
  const start = userInput.selectionStart ?? userInput.value.length;
  const end = userInput.selectionEnd ?? start;
  userInput.value = userInput.value.slice(0, start) + tag + userInput.value.slice(end);
  userInput.selectionStart = userInput.selectionEnd = start + tag.length;
  userInput.focus();
}

// ── 设置面板里的入口卡片（真正的管理界面在 stickerlib.js 的贴纸库弹层）──────

export function renderStickerMgr() {
  const el = document.getElementById('stickerCount');
  if (!el) return;
  const all = getChatStickers();
  const withImg = all.filter(s => s.hasImg).length;
  el.textContent = all.length ? `共 ${all.length} 张${withImg ? `（${withImg} 张有图）` : ''}` : '还没有贴纸';
}

export function initStickers() {
  // 装饰贴纸上传
  const btnSticker = document.getElementById('btnSticker');
  const fileInputSticker = document.getElementById('fileInputSticker');
  if (btnSticker) btnSticker.onclick = () => fileInputSticker.click();
  if (fileInputSticker) {
    fileInputSticker.onchange = async function() {
      if (!this.files[0]) return;
      const b64 = await readFileAsBase64(this.files[0]);
      const s = {
        id: 'stk_' + Date.now(),
        data: b64,
        x: Math.random() * (window.innerWidth - 120),
        y: Math.random() * (window.innerHeight - 120),
        w: 100, h: 100, rot: 0,
      };
      _decoStickers.push(s);
      await dbPut('stickers', null, s);
      createStickerDOM(s);
      toast('贴纸已添加，拖拽它到喜欢的位置');
      this.value = '';
    };
  }

  // window 暴露（供 HTML onclick 和 chat.js 的 window.xxx?.() 调用）
  Object.assign(window, {
    openStickerPanel, closeStickerPanel, sendStickerMsg,
    getStickerHint, applyStickerTags, detectStickerMsg, renderStickerHTML,
    observeStickerImgs,
  });
}
