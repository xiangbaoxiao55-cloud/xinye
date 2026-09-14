/**
 * 炘也图标集生成器
 * 源：下面的 ICONS 定义（24×24 网格，描边式）
 * 产物：src/styles/icons.css（CSS mask，颜色跟随 currentColor）
 *
 * 用法：node tools/build-icons.mjs
 * 加图标：往 ICONS 里加一条，重跑，然后在 HTML 里写 <i class="ic ic-名字"></i>
 */
import fs from 'fs';

const SW = 1.8; // 描边粗细

const ICONS = {
  // ── 通信 / API ──────────────────────────────
  message:  "<path d='M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z'/>",
  wrench:   "<path d='M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z'/>",
  vector:   "<circle cx='12' cy='9.5' r='6.5'/><path d='M8.5 19h7'/><path d='M10 22h4'/>",
  eye:      "<path d='M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z'/><circle cx='12' cy='12' r='3'/>",
  palette:  "<path d='M12 3a9 9 0 1 0 0 18h1.5a2 2 0 0 0 1.6-3.2 2 2 0 0 1 1.6-3.2H18a3.6 3.6 0 0 0 3.6-3.6A9 9 0 0 0 12 3z'/><circle cx='7.8' cy='11.5' r='.9'/><circle cx='10.2' cy='7.6' r='.9'/><circle cx='15' cy='8.2' r='.9'/>",
  search:   "<circle cx='11' cy='11' r='7.5'/><path d='M20.5 20.5 16.2 16.2'/>",
  signal:   "<path d='M4.5 12.3a10.6 10.6 0 0 1 15 0'/><path d='M8.2 15.8a5.7 5.7 0 0 1 7.6 0'/><circle cx='12' cy='19.2' r='1.1'/>",
  link:     "<path d='M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7'/><path d='M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7'/>",

  // ── 记忆 / 数据 ─────────────────────────────
  book:     "<path d='M4 19.5A2.5 2.5 0 0 1 6.5 17H20'/><path d='M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z'/>",
  'book-open': "<path d='M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z'/><path d='M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z'/>",
  note:     "<path d='M12 20h9'/><path d='M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z'/>",
  notebook: "<rect x='4' y='2' width='16' height='20' rx='2'/><path d='M8 2v20'/><path d='M12 7h5'/><path d='M12 11h5'/>",
  layers:   "<path d='M12 2 2 7l10 5 10-5-10-5z'/><path d='M2 12l10 5 10-5'/><path d='M2 17l10 5 10-5'/>",
  database: "<ellipse cx='12' cy='5' rx='8.5' ry='3'/><path d='M20.5 12c0 1.66-3.8 3-8.5 3s-8.5-1.34-8.5-3'/><path d='M3.5 5v14c0 1.66 3.8 3 8.5 3s8.5-1.34 8.5-3V5'/>",
  brain:    "<path d='M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z'/><path d='M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z'/><path d='M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4'/><path d='M17.6 6.5a3 3 0 0 0 .4-1.375'/><path d='M6 5.125A3 3 0 0 0 6.4 6.5'/><path d='M3.5 10.9a4 4 0 0 1 .6-.4'/><path d='M19.94 10.5a4 4 0 0 1 .58.4'/><path d='M6 18a4 4 0 0 1-1.97-.52'/><path d='M19.97 17.48A4 4 0 0 1 18 18'/>",
  bot:      "<rect x='3.5' y='8' width='17' height='12' rx='3'/><circle cx='9' cy='14' r='1.1'/><circle cx='15' cy='14' r='1.1'/><path d='M12 8V4.5'/><circle cx='12' cy='3.4' r='1.1'/>",
  folder:   "<path d='M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z'/>",
  tag:      "<path d='M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L2 12V2h10l8.6 8.6a2 2 0 0 1 0 2.8z'/><path d='M7 7h.01'/>",
  pin:      "<path d='M12 17.5V22'/><path d='M9 11a2 2 0 0 1-1.1 1.8l-1.8.9A2 2 0 0 0 5 15.5V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.5a2 2 0 0 0-1.1-1.8l-1.8-.9A2 2 0 0 1 15 11V6.5h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1z'/>",
  storage:  "<path d='M3 7.5 12 3l9 4.5v9L12 21l-9-4.5z'/><path d='M3 7.5 12 12l9-4.5'/><path d='M12 12v9'/>",

  // ── 操作 ────────────────────────────────────
  refresh:  "<path d='M20.5 4.5v5h-5'/><path d='M3.5 19.5v-5h5'/><path d='M4.6 9.2a8 8 0 0 1 13.2-3.2l2.7 2.5'/><path d='M19.4 14.8a8 8 0 0 1-13.2 3.2L3.5 15.5'/>",
  'rotate-ccw': "<path d='M2 5v5h5'/><path d='M4.6 15a8 8 0 1 0 1.9-8.3L2 10'/>",
  zap:      "<path d='M13 2 3.5 13.5H11l-1 8.5 9.5-11.5H12l1-8.5z'/>",
  sparkles: "<path d='M12 3.5 13.7 8.3 18.5 10 13.7 11.7 12 16.5 10.3 11.7 5.5 10 10.3 8.3z'/><path d='M18.5 15.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z'/>",
  plus:     "<path d='M12 5v14'/><path d='M5 12h14'/>",
  x:        "<path d='M18 6 6 18'/><path d='M6 6l12 12'/>",
  send:     "<path d='M21.5 2.5 10.5 13.5'/><path d='M21.5 2.5 14.5 21.5l-4-8-8-4z'/>",
  download: "<path d='M20.5 15.5v3a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2v-3'/><path d='M7 10.5 12 15.5l5-5'/><path d='M12 15.5V3'/>",
  upload:   "<path d='M20.5 15.5v3a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2v-3'/><path d='M17 8 12 3 7 8'/><path d='M12 3v12.5'/>",
  save:     "<path d='M19.5 21h-15a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l6 6v10a2 2 0 0 1-2 2z'/><path d='M17 21v-8H7v8'/><path d='M7 3v5h8'/>",
  trash:    "<path d='M3.5 6h17'/><path d='M8.5 6V4.5a1.5 1.5 0 0 1 1.5-1.5h4a1.5 1.5 0 0 1 1.5 1.5V6'/><path d='M18.5 6v13.5a1.5 1.5 0 0 1-1.5 1.5H7a1.5 1.5 0 0 1-1.5-1.5V6'/><path d='M10 11v6'/><path d='M14 11v6'/>",
  list:     "<path d='M8.5 6h12'/><path d='M8.5 12h12'/><path d='M8.5 18h12'/><path d='M3.6 6h.01'/><path d='M3.6 12h.01'/><path d='M3.6 18h.01'/>",
  filter:   "<path d='M21 4H3l7.2 8.5V19l3.6 2v-8.5z'/>",
  settings: "<circle cx='12' cy='12' r='3.2'/><path d='M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6h.09A1.65 1.65 0 0 0 10 3.09V3a2 2 0 1 1 4 0v.09A1.65 1.65 0 0 0 15 4.6h.09a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9v.09a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z'/>",
  smile:    "<circle cx='12' cy='12' r='9'/><path d='M8.5 14.5s1.3 2 3.5 2 3.5-2 3.5-2'/><path d='M9 9.5h.01'/><path d='M15 9.5h.01'/>",
  alert:    "<path d='M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z'/><path d='M12 9v4'/><path d='M12 17h.01'/>",

  // ── 状态 ────────────────────────────────────
  'check-circle': "<circle cx='12' cy='12' r='9'/><path d='m8.5 12.5 2.5 2.5 5-5.5'/>",
  'x-circle':     "<circle cx='12' cy='12' r='9'/><path d='m15 9-6 6'/><path d='m9 9 6 6'/>",
  'clock-dash':   "<circle cx='12' cy='12' r='9'/><path d='M12 7v5l3.5 2'/>",

  // ── 媒体 / 生活 ─────────────────────────────
  heart:    "<path d='M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 1 0-7.8 7.8l1.1 1.1L12 21.2l7.8-7.8 1.1-1.1a5.5 5.5 0 0 0 0-7.8z'/>",
  activity: "<path d='M22 12h-4l-3 9-6-18-3 9H2'/>",
  volume:   "<path d='M11 5 6 9H2v6h4l5 4V5z'/><path d='M19.1 4.9a10 10 0 0 1 0 14.2'/><path d='M15.5 8.5a5 5 0 0 1 0 7'/>",
  bell:     "<path d='M18 8.5a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9'/><path d='M13.7 21a2 2 0 0 1-3.4 0'/>",
  clock:    "<circle cx='12' cy='12' r='9'/><path d='M12 6.5V12l3.5 2'/>",
  phone:    "<rect x='6' y='2' width='12' height='20' rx='2.5'/><path d='M12 18.2h.01'/>",
  laptop:   "<path d='M4 5.5h16v11H4z'/><path d='M2 19.5h20'/>",
  image:    "<rect x='3' y='3' width='18' height='18' rx='2.5'/><circle cx='8.5' cy='8.5' r='1.6'/><path d='M21 15.5 16 10.5 5 21'/>",
  gift:     "<path d='M20 12v9H4v-9'/><rect x='2' y='7' width='20' height='5' rx='1'/><path d='M12 21V7'/><path d='M12 7H7.5a2.5 2.5 0 1 1 0-5C11 2 12 7 12 7z'/><path d='M12 7h4.5a2.5 2.5 0 0 0 0-5C13 2 12 7 12 7z'/>",
  dice:     "<rect x='3' y='3' width='18' height='18' rx='3.5'/><path d='M8.2 8.2h.01'/><path d='M15.8 8.2h.01'/><path d='M12 12h.01'/><path d='M8.2 15.8h.01'/><path d='M15.8 15.8h.01'/>",
  mail:     "<rect x='2' y='4' width='20' height='16' rx='2'/><path d='m2.5 6.5 9.5 7 9.5-7'/>",
  users:    "<path d='M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2'/><circle cx='9' cy='7' r='4'/><path d='M23 21v-2a4 4 0 0 0-3-3.9'/><path d='M16 3.1a4 4 0 0 1 0 7.8'/>",
  moon:     "<path d='M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z'/>",
  sun:      "<circle cx='12' cy='12' r='4.5'/><path d='M12 1.5v2.5'/><path d='M12 20v2.5'/><path d='M4.2 4.2l1.8 1.8'/><path d='M18 18l1.8 1.8'/><path d='M1.5 12H4'/><path d='M20 12h2.5'/><path d='M4.2 19.8 6 18'/><path d='M18 6l1.8-1.8'/>",
  cloud:    "<path d='M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z'/>",
  mic:      "<path d='M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z'/><path d='M19 11v1a7 7 0 0 1-14 0v-1'/><path d='M12 19v3'/><path d='M8.5 22h7'/>",
  'skip-forward': "<path d='M5 4.5 15 12 5 19.5z'/><path d='M19 5v14'/>",
  play:     "<path d='M6 3.5 20 12 6 20.5z'/>",
  thought:  "<circle cx='12' cy='8.8' r='6.3'/><circle cx='7.6' cy='17.8' r='1.6'/><circle cx='12.2' cy='20.6' r='1.05'/>",
  camera:   "<path d='M22 8.5v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2h3l1.5-2.5h7L17 6.5h3a2 2 0 0 1 2 2z'/><circle cx='12' cy='13' r='3.5'/>",
  globe:    "<circle cx='12' cy='12' r='9'/><path d='M3 12h18'/><path d='M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18z'/>",
  music:    "<path d='M9 18V5.5l11-2v12'/><circle cx='6.5' cy='18' r='2.5'/><circle cx='17.5' cy='15.5' r='2.5'/>",
  flower:   "<circle cx='12' cy='12' r='2.3'/><circle cx='12' cy='6.6' r='2.6'/><circle cx='17.4' cy='9.9' r='2.6'/><circle cx='15.3' cy='16.2' r='2.6'/><circle cx='8.7' cy='16.2' r='2.6'/><circle cx='6.6' cy='9.9' r='2.6'/>",
  'arrow-left': "<path d='M19 12H5'/><path d='m11 6-6 6 6 6'/>",
  'check-square': "<rect x='3.5' y='3.5' width='17' height='17' rx='3'/><path d='m8 12.3 2.7 2.7L16.5 9'/>",
  check:    "<path d='m4.5 12.5 5 5 10-11'/>",
  star:     "<path d='M12 2.8 15 9l6.8.9-4.9 4.8 1.2 6.8L12 18.3 5.9 21.5l1.2-6.8L2.2 9.9 9 9z'/>",

  // ── 文档 / 编辑 ─────────────────────────────
  pen:      "<path d='M16.5 3.5a2.12 2.12 0 0 1 3 3L8 18l-4.5 1 1-4.5z'/>",
  bookmark: "<path d='M19 21 12 16.5 5 21V4.5A1.5 1.5 0 0 1 6.5 3h11A1.5 1.5 0 0 1 19 4.5z'/>",
  calendar: "<rect x='3.5' y='5' width='17' height='16' rx='2.5'/><path d='M3.5 10h17'/><path d='M8 3v4'/><path d='M16 3v4'/>",
  'file-text': "<path d='M14 2.5H7a2 2 0 0 0-2 2v15a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7.5z'/><path d='M14 2.5v5h5'/><path d='M9 13h6'/><path d='M9 17h4'/>",
  clipboard: "<rect x='5.5' y='4.5' width='13' height='17' rx='2.5'/><path d='M9 4.5V3.5A1.5 1.5 0 0 1 10.5 2h3A1.5 1.5 0 0 1 15 3.5v1'/>",
  paperclip: "<path d='M20.5 11.5 12 20a5.5 5.5 0 0 1-7.8-7.8l9-9a3.7 3.7 0 0 1 5.2 5.2l-9 9a1.8 1.8 0 0 1-2.6-2.6l8.3-8.3'/>",
  'bar-chart': "<path d='M4 20h16'/><path d='M7 20V11'/><path d='M12 20V4.5'/><path d='M17 20v-6'/>",
  ruler:    "<path d='M15.5 2.5 21.5 8.5 8.5 21.5 2.5 15.5z'/><path d='M6.5 11.5 8 13'/><path d='M9.5 8.5 11 10'/><path d='M12.5 5.5 14 7'/>",
  history:  "<path d='M3 12a9 9 0 1 0 3-6.7L3 8'/><path d='M3 3v5h5'/><path d='M12 7.5V12l3.2 2'/>",
  user:     "<path d='M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2'/><circle cx='12' cy='7' r='4'/>",
  masks:    "<path d='M5 4h14v5.5a7 7 0 0 1-14 0z'/><path d='M9.3 8h.01'/><path d='M14.7 8h.01'/><path d='M9.4 11.2s1 1.3 2.6 1.3 2.6-1.3 2.6-1.3'/>",
  maximize: "<path d='M8 3H5a2 2 0 0 0-2 2v3'/><path d='M16 3h3a2 2 0 0 1 2 2v3'/><path d='M21 16v3a2 2 0 0 1-2 2h-3'/><path d='M3 16v3a2 2 0 0 0 2 2h3'/>",
  lock:     "<rect x='4.5' y='10.5' width='15' height='10' rx='2.5'/><path d='M8 10.5V7a4 4 0 0 1 8 0v3.5'/>",
  unlock:   "<rect x='4.5' y='10.5' width='15' height='10' rx='2.5'/><path d='M8 10.5V7a4 4 0 0 1 7.4-2.1'/>",
  'rotate-cw': "<path d='M22 5v5h-5'/><path d='M19.4 15a8 8 0 1 1-1.9-8.3L22 10'/>",
};

function uri(inner) {
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='${SW}' stroke-linecap='round' stroke-linejoin='round'>${inner}</svg>`;
  return 'url("data:image/svg+xml,' + encodeURIComponent(svg) + '")';
}

let css = `/* ==========================================================
   炘也图标集（CSS mask 版）
   由 tools/build-icons.mjs 生成 —— 不要手改，改源脚本再重跑
   用法：<i class="ic ic-message"></i>
   颜色自动跟随 currentColor（主题/hover/禁用态全自适应）
   ========================================================== */
.ic{
  display:inline-block;flex:0 0 auto;
  width:1em;height:1em;
  background-color:currentColor;
  vertical-align:-.14em;
  -webkit-mask-repeat:no-repeat;mask-repeat:no-repeat;
  -webkit-mask-position:center;mask-position:center;
  -webkit-mask-size:contain;mask-size:contain;
  -webkit-mask-image:var(--i);mask-image:var(--i);
}
.ic-sm{width:.9em;height:.9em}
.ic-lg{width:1.25em;height:1.25em}
/* 给「文字会被 JS 反复重写」的元素用：图标挂在 ::before 上，改 textContent 冲不掉 */
.status-ico::before{
  content:'';display:inline-block;flex:0 0 auto;
  width:1em;height:1em;
  background-color:currentColor;
  vertical-align:-.14em;margin-right:.34em;
  -webkit-mask-repeat:no-repeat;mask-repeat:no-repeat;
  -webkit-mask-position:center;mask-position:center;
  -webkit-mask-size:contain;mask-size:contain;
  -webkit-mask-image:var(--i);mask-image:var(--i);
}
/* 在线状态圆点（🟢 / ⚪ 的替代，纯 CSS 画，可上色） */
.dot{display:inline-block;width:7px;height:7px;border-radius:50%;
  background:var(--text-light);opacity:.35;vertical-align:middle;margin-right:2px}
.dot.on{background:#5cb87a;opacity:1;box-shadow:0 0 0 2.5px rgba(92,184,122,.18)}

`;
const names = Object.keys(ICONS);
for (const k of names) css += `.ic-${k}{--i:${uri(ICONS[k])}}\n`;

fs.writeFileSync('D:/Download/Claude code/src/styles/icons.css', css);
console.log(`✓ 生成 ${names.length} 个图标 → src/styles/icons.css  (${(css.length / 1024).toFixed(1)} KB)`);
console.log(names.join(' '));
