import { dbPut, dbGet, dbDelete, dbGetAll } from './db.js';
import { $, toast, escHtml, readFileAsBase64 } from './utils.js';
import { settings } from './state.js';

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
    <button class="sticker-del">✕</button>
    <div class="sticker-resize"></div>
    <div class="sticker-rotate-line"></div>
    <div class="sticker-rotate">↻</div>`;
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

// ── 聊天贴纸（消息气泡里的表情贴纸面板） ─────────────────────────────────────
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

const _chatStickers = [];

export function getChatStickers() { return _chatStickers; }

export async function loadChatStickers() {
  // 优先从 IDB 读
  const raw = await dbGet('settings', 'chat_stickers');
  if (raw) {
    try { _chatStickers.length = 0; _chatStickers.push(...JSON.parse(raw)); return; } catch(_) {}
  }
  // 迁移：从 LS 读（老数据）
  try {
    const ls = localStorage.getItem('xinye_chat_stickers');
    if (ls) {
      const arr = JSON.parse(ls);
      _chatStickers.length = 0; _chatStickers.push(...arr);
      await dbPut('settings', 'chat_stickers', ls);
      localStorage.removeItem('xinye_chat_stickers');
      return;
    }
  } catch(_) {}
  // 默认
  _chatStickers.length = 0;
  _chatStickers.push(..._DEFAULT_STICKERS.map(s => ({...s})));
}

export function saveChatStickers(arr) {
  _chatStickers.length = 0; _chatStickers.push(...arr);
  dbPut('settings', 'chat_stickers', JSON.stringify(arr)).catch(() => {});
}
function getStickerByName(name) { return getChatStickers().find(s => s.name === name); }
export function renderStickerHTML(name) {
  const s = getStickerByName(name);
  if (s?.image) return `<img class="sticker-img" src="${escHtml(s.image)}" alt="${escHtml(name)}">`;
  return `<span class="sticker-pill">${escHtml(s?.emoji||'🎭')} ${escHtml(name)}</span>`;
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
export function getStickerHint() {
  const names = getChatStickers().map(s => s.name).join('、');
  return `【贴纸】你可以在回复中自然发贴纸，格式：[sticker:名字]，只在情感真实时使用，不要强行插入。可用：${names}`;
}
export function openStickerPanel() {
  const stickers = getChatStickers();
  document.getElementById('stickerGrid').innerHTML = stickers.map(s => {
    const inner = s.image
      ? `<img class="sticker-pick-img" src="${escHtml(s.image)}" alt="">`
      : `<div class="sticker-pick-placeholder">${s.emoji||'🎭'}</div>`;
    return `<button class="sticker-pick-btn" onclick="sendStickerMsg('${escHtml(s.name)}')">${inner}<span>${escHtml(s.name)}</span></button>`;
  }).join('');
  document.getElementById('stickerPanel').classList.add('show');
}
export function closeStickerPanel() { document.getElementById('stickerPanel').classList.remove('show'); }
export async function sendStickerMsg(name) {
  closeStickerPanel();
  const userName = settings.userName || '涂涂';
  const stickerText = `（${userName}发了一个「${name}」贴纸）`;
  const userInput = document.getElementById('userInput');
  const existing = userInput.value.trim();
  userInput.value = existing ? existing + ' ' + stickerText : stickerText;
  await window.sendMessage();
  const chatArea = document.getElementById('chatArea');
  const userBubbles = chatArea.querySelectorAll('.msg-row.user .msg-bubble');
  const lastBubble = userBubbles[userBubbles.length - 1];
  if (!lastBubble) return;
  if (existing) {
    lastBubble.innerHTML = lastBubble.innerHTML.replace(
      escHtml(stickerText),
      `<span class="sticker-inline">${renderStickerHTML(name)}</span>`
    );
  } else if (!lastBubble.classList.contains('bubble-sticker')) {
    lastBubble.classList.add('bubble-sticker');
    lastBubble.innerHTML = renderStickerHTML(name);
  }
}
export function renderStickerMgr() {
  const stickers = getChatStickers();
  const el = document.getElementById('stickerMgrList');
  if (!el) return;
  el.innerHTML = stickers.map((s, i) => {
    const preview = s.image
      ? `<img class="sticker-mgr-preview" src="${escHtml(s.image)}" alt="" style="width:36px;height:36px;object-fit:contain;border-radius:8px">`
      : `<div class="sticker-mgr-preview">${s.emoji||'🎭'}</div>`;
    return `<div class="sticker-mgr-item">
      ${preview}
      <span class="sticker-mgr-name">${escHtml(s.name)}</span>
      <label class="sticker-mgr-upload">上传图<input type="file" accept="image/*" style="display:none" onchange="uploadStickerImg(${i},this)"></label>
      ${s.image ? `<span class="sticker-mgr-upload" onclick="clearStickerImg(${i})" style="color:#e57373">删图</span>` : ''}
      <button class="sticker-mgr-del" onclick="deleteStickerItem(${i})" title="删除">✕</button>
    </div>`;
  }).join('');
}
export function addStickerItem() {
  const input = document.getElementById('newStickerName');
  const name = input.value.trim();
  if (!name) return;
  const stickers = getChatStickers();
  if (stickers.find(s => s.name === name)) { toast('已有同名贴纸'); return; }
  stickers.push({ id: 'custom_' + Date.now(), name, emoji: '🎭' });
  saveChatStickers(stickers);
  input.value = '';
  renderStickerMgr();
  toast('贴纸已添加 🎭');
}
export function deleteStickerItem(idx) {
  const stickers = getChatStickers();
  stickers.splice(idx, 1);
  saveChatStickers(stickers);
  renderStickerMgr();
}
export function uploadStickerImg(idx, input) {
  const file = input.files[0]; if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    const stickers = getChatStickers();
    stickers[idx].image = e.target.result;
    saveChatStickers(stickers);
    renderStickerMgr();
    toast('图片已更新 ✨');
  };
  reader.readAsDataURL(file);
}
export function clearStickerImg(idx) {
  const stickers = getChatStickers();
  delete stickers[idx].image;
  saveChatStickers(stickers);
  renderStickerMgr();
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

  // 聊天贴纸管理
  document.getElementById('btnAddSticker')?.addEventListener('click', addStickerItem);

  // window 暴露（供 HTML onclick 和 chat.js 的 window.xxx?.() 调用）
  Object.assign(window, {
    openStickerPanel, closeStickerPanel, sendStickerMsg,
    uploadStickerImg, clearStickerImg, deleteStickerItem,
    getStickerHint, applyStickerTags, detectStickerMsg, renderStickerHTML,
  });
}
