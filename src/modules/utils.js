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
