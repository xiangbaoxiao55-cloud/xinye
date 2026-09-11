export const $ = s => document.querySelector(s);

let toastT = null;
export function toast(msg) {
  const toastEl = document.getElementById('toast');
  if (!toastEl) return;
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastT);
  toastT = setTimeout(() => toastEl.classList.remove('show'), 2400);
  const t = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  console.log(`[Toast ${t}] ${msg}`);
}

export function fallbackCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
  document.body.appendChild(ta);
  ta.focus(); ta.select();
  try { document.execCommand('copy'); toast('已复制'); }
  catch(e) { toast('复制失败'); }
  document.body.removeChild(ta);
}

export function escHtml(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

export function isDarkMode() {
  return document.documentElement.dataset.theme === 'dark';
}

export function fmtTime(ts) {
  const d = new Date(ts), p = n => String(n).padStart(2,'0');
  return `${d.getFullYear()}年${d.getMonth()+1}月${d.getDate()}日${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function fmtFull(ts) {
  const d = new Date(ts), p = n => String(n).padStart(2,'0');
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function nowStr() {
  const d = new Date();
  const p = n => String(n).padStart(2,'0');
  const h = d.getHours();
  const period = h < 6 ? '凌晨' : h < 12 ? '上午' : h < 18 ? '下午' : '晚上';
  const weekDays = ['周日','周一','周二','周三','周四','周五','周六'];
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} ${p(h)}:${p(d.getMinutes())}（${period}${h <= 12 ? h : h - 12}点${d.getMinutes() > 0 ? d.getMinutes()+'分' : ''}，${weekDays[d.getDay()]}）`;
}

export function readFileAsBase64(file) {
  return new Promise(resolve => {
    const r = new FileReader();
    r.onload = e => resolve(e.target.result);
    r.readAsDataURL(file);
  });
}

/**
 * 把文件存到手机 / 下载到电脑。
 *
 * ⚠️ APK 里 `<a download>` 是**哑的**：壳用的是系统 WebView，它不处理 blob: 链接的
 * 下载，点了什么都没有，也不报错（浏览器里一切正常）。所以在 APK 里改走原生接口，
 * 浏览器里保持老办法。
 *
 * 原生那条接口是 MainActivity 里的 `AndroidDownload.downloadFile` ——
 * ⚠️ 2026-09-11 之前它**根本不存在**，画图保存图片一直是静默失败的。
 *
 * @param {Blob|string} data  Blob，或 dataURL 字符串（storyboard 那种传的就是 dataURL）
 * @returns {Promise<boolean>}
 */
export async function saveFile(data, filename) {
  let blob = data;
  if (typeof data === 'string') {
    try { blob = await (await fetch(data)).blob(); } catch(e) { blob = null; }
  }

  if (window.AndroidDownload && blob) {
    try {
      const b64 = await new Promise((res, rej) => {
        const r = new FileReader();
        r.onload = e => res(String(e.target.result).split(',')[1]);
        r.onerror = rej;
        r.readAsDataURL(blob);
      });
      const ok = window.AndroidDownload.downloadFile(
        filename, blob.type || 'application/octet-stream', b64);
      if (ok) return true;
    } catch(e) {
      console.warn('[saveFile] 原生保存失败，回退浏览器方式：', e.message);
    }
  }

  const url = typeof data === 'string' ? data : URL.createObjectURL(blob || new Blob([]));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  if (typeof data !== 'string') setTimeout(() => URL.revokeObjectURL(url), 3000);
  return true;
}
