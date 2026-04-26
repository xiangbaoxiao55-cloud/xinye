import { $, toast, readFileAsBase64 } from './utils.js';
import { settings } from './state.js';
import { dbPut, dbGet, dbDelete } from './db.js';

// ======================== 装修模式 ========================
let decoMode = false;

export function toggleDeco() {
  decoMode = !decoMode;
  $('#app').classList.toggle('deco-mode', decoMode);
  $('#btnDecoFloat').classList.toggle('show', decoMode);
  $('#btnDeco').classList.toggle('active-deco', decoMode);
  toast(decoMode ? '装修模式 ON — 拖动贴纸吧' : '装修模式 OFF — 回到聊天');
}

// ======================== 暗夜模式 ========================
export function applyTheme(dark) {
  document.documentElement.dataset.theme = dark ? 'dark' : '';
  const btnDark = $('#btnDark');
  btnDark.innerHTML = dark
    ? `<svg width="20" height="20" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="5" fill="currentColor" opacity="0.3" stroke="currentColor" stroke-width="1.5"/><path d="M12 2v2M12 20v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M2 12h2M20 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`
    : `<svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M20 14.12A8 8 0 119.88 4a6 6 0 0010.12 10.12z" fill="currentColor" opacity="0.25" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><circle cx="18.5" cy="5" r="1.2" fill="currentColor"/><circle cx="21" cy="8.5" r="0.8" fill="currentColor"/></svg>`;
  btnDark.title = dark ? '日间模式' : '暗夜模式';
  if (dark !== null) localStorage.setItem('fox_dark', dark ? '1' : '0');
}

export function initTheme() {
  $('#btnDark').onclick = () => {
    applyTheme(document.documentElement.dataset.theme !== 'dark');
  };
  const saved = localStorage.getItem('fox_dark');
  if (saved !== null) {
    applyTheme(saved === '1');
  } else {
    applyTheme(window.matchMedia('(prefers-color-scheme: dark)').matches);
  }
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', e => {
    if (localStorage.getItem('fox_dark') === null) applyTheme(e.matches);
  });
}

// ======================== 背景（图片 + 视频） ========================
let bgVideoUrl = null;

export function applyBgImage(b64) {
  const bgLayer = $('#bgLayer');
  const bgMask = $('#bgMask');
  if (bgVideoUrl) { URL.revokeObjectURL(bgVideoUrl); bgVideoUrl = null; }
  bgLayer.innerHTML = '';
  bgLayer.style.backgroundImage = `url(${b64})`;
  bgLayer.style.opacity = settings.bgOpacity;
  bgLayer.style.filter = `blur(${settings.bgBlur}px)`;
  bgLayer.classList.add('active');
  bgMask.classList.remove('active');
}

export function applyBgVideo(blob) {
  const bgLayer = $('#bgLayer');
  const bgMask = $('#bgMask');
  if (bgVideoUrl) URL.revokeObjectURL(bgVideoUrl);
  bgVideoUrl = URL.createObjectURL(blob);
  bgLayer.style.backgroundImage = '';
  bgLayer.innerHTML = '';
  const v = document.createElement('video');
  v.src = bgVideoUrl;
  v.autoplay = true; v.loop = true; v.muted = true; v.playsInline = true;
  bgLayer.appendChild(v);
  bgLayer.style.opacity = settings.bgOpacity;
  bgLayer.style.filter = `blur(${settings.bgBlur}px)`;
  bgLayer.classList.add('active');
  bgMask.classList.add('active');
}

export async function applyBg() {
  const bgLayer = $('#bgLayer');
  const bgMask = $('#bgMask');
  const bgType = await dbGet('images', 'bgType');
  if (bgType === 'video') {
    const blob = await dbGet('images', 'bgVideo');
    if (blob) { applyBgVideo(blob); return; }
  }
  const b64 = await dbGet('images', 'bgImage');
  if (b64) { applyBgImage(b64); return; }
  bgLayer.innerHTML = '';
  bgLayer.style.backgroundImage = '';
  bgLayer.classList.remove('active');
  bgMask.classList.remove('active');
}

export function initBgHandlers() {
  $('#btnDeco').onclick = toggleDeco;
  $('#btnDecoFloat').onclick = toggleDeco;

  $('#btnUploadBg').onclick = () => $('#fileInputBg').click();
  $('#fileInputBg').onchange = async function() {
    if (!this.files[0]) return;
    const file = this.files[0];
    if (file.type.startsWith('video/')) {
      const blob = new Blob([await file.arrayBuffer()], { type: file.type });
      await dbPut('images', 'bgVideo', blob);
      await dbDelete('images', 'bgImage');
      await dbPut('images', 'bgType', 'video');
      applyBgVideo(blob);
      toast('视频背景已设置');
    } else {
      const b64 = await readFileAsBase64(file);
      await dbPut('images', 'bgImage', b64);
      await dbDelete('images', 'bgVideo');
      await dbPut('images', 'bgType', 'image');
      applyBgImage(b64);
      toast('背景图已更新');
    }
    this.value = '';
  };

  $('#btnClearBg').onclick = async () => {
    const bgLayer = $('#bgLayer');
    const bgMask = $('#bgMask');
    await dbDelete('images', 'bgImage');
    await dbDelete('images', 'bgVideo');
    await dbDelete('images', 'bgType');
    if (bgVideoUrl) { URL.revokeObjectURL(bgVideoUrl); bgVideoUrl = null; }
    bgLayer.innerHTML = '';
    bgLayer.style.backgroundImage = '';
    bgLayer.classList.remove('active');
    bgMask.classList.remove('active');
    toast('背景已清除');
  };
}
