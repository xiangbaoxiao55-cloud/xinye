import { $, toast, escHtml, setStatus } from './utils.js';
import {
  getChatStickers, importStickerFiles, deleteStickerById, deleteStickersByIds,
  renameStickerById, ensureStickerImg, peekStickerImg, renderStickerMgr,
  importStickerUrls, abortStickerUrlImport, parseStickerList,
} from './stickers.js';

// 贴纸库弹层：批量导入 / 搜索 / 多选删除 / 改名。
// 存储格式和图片懒加载都在 stickers.js，这里只管界面。
//
// 为什么要独立弹层：原来「设置 → 贴纸管理」是一张一行（名字输入框 + 上传 + 删除），
// 几十张就要往下划半天，几百张根本没法用。

const _PH = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

const _sel = new Set();
let _query = '';
let _importing = false;
let _bound = false;

function _el(id) { return document.getElementById(id); }

function _visible() {
  const all = getChatStickers();
  const q = _query.trim().toLowerCase();
  return q ? all.filter(s => s.name.toLowerCase().includes(q)) : all;
}

function _renderGrid() {
  const grid = _el('slGrid');
  if (!grid) return;
  const list = _visible();
  if (!list.length) {
    const total = getChatStickers().length;
    grid.innerHTML = `<div class="sl-empty">${total ? '没找到匹配的贴纸' : '还没有贴纸<br>点右上角「导入」挑一批图吧'}</div>`;
    _renderFoot();
    return;
  }
  grid.innerHTML = list.map(s => {
    const img = s.hasImg ? peekStickerImg(s.id) : null;
    if (s.hasImg && !img) ensureStickerImg(s.id);   // 读完会自己把占位换掉
    const vis = !s.hasImg
      ? `<div class="sl-img sl-emoji">${escHtml(s.emoji || '🎭')}</div>`
      : (img ? `<img class="sl-img" src="${img}" alt="">`
             : `<img class="sl-img sl-img-loading" data-sid="${escHtml(s.id)}" src="${_PH}" alt="">`);
    return `<div class="sl-cell${_sel.has(s.id) ? ' on' : ''}" data-id="${escHtml(s.id)}">
      ${vis}
      <div class="sl-name">${escHtml(s.name)}</div>
      <div class="sl-check"><i class="ic ic-check"></i></div>
    </div>`;
  }).join('');
  _renderFoot();
}

function _renderFoot() {
  const foot = _el('slFoot');
  const n = _sel.size;
  if (foot) foot.style.display = n ? 'flex' : 'none';
  const info = _el('slSelInfo');
  if (info) info.textContent = n ? `已选 ${n} 张` : '';
  const rn = _el('slRename');
  if (rn) rn.style.display = n === 1 ? '' : 'none';
  const cnt = _el('slCount');
  if (cnt) {
    const all = getChatStickers();
    const q = _query.trim();
    cnt.textContent = q ? `${_visible().length} / ${all.length}` : `${all.length} 张`;
  }
}

// ── 交互 ─────────────────────────────────────────────────────────────────

function _startRename(id) {
  const cell = document.querySelector(`.sl-cell[data-id="${id}"]`);
  if (!cell) return;
  const s = getChatStickers().find(x => x.id === id);
  const nameEl = cell.querySelector('.sl-name');
  if (!s || !nameEl || nameEl.querySelector('input')) return;
  nameEl.innerHTML = `<input class="sl-rename" value="${escHtml(s.name)}">`;
  const inp = nameEl.querySelector('input');
  inp.focus(); inp.select();
  let done = false;
  const commit = async () => {
    if (done) return;
    done = true;
    const v = inp.value.trim();
    if (v && v !== s.name) {
      const ok = await renameStickerById(id, v);
      if (!ok) toast('改名失败：名字重复或为空');
      else renderStickerMgr();
    }
    _renderGrid();
  };
  inp.addEventListener('blur', commit);
  inp.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); inp.blur(); }
    else if (e.key === 'Escape') { done = true; _renderGrid(); }
  });
}

async function _doImport(files) {
  if (_importing) return;
  if (!files || !files.length) return;
  _importing = true;
  const statusEl = _el('slStatus');
  setStatus(statusEl, 'clock-dash', `准备导入 ${files.length} 张…`);
  try {
    const n = await importStickerFiles(files, (done, total) => {
      setStatus(statusEl, 'clock-dash', `导入中 ${done}/${total}…`);
    });
    setStatus(statusEl, 'check', `导入完成：${n} 张`);
    toast(n ? `导入 ${n} 张贴纸 ✨` : '没有导入任何图片');
    renderStickerMgr();
    _renderGrid();
  } catch (e) {
    console.warn('[StickerLib] 导入异常', e);
    setStatus(statusEl, 'x-circle', '导入失败，看日志');
  } finally {
    _importing = false;
  }
}

async function _doUrlImport() {
  if (_importing) return;
  const ta = _el('slUrlText');
  const text = (ta?.value || '').trim();
  if (!text) { toast('先把清单粘进来'); return; }

  const preview = parseStickerList(text);
  const lines = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const isListUrl = preview.length === 0 && lines.length === 1 && /^https?:\/\/\S+$/i.test(lines[0]);
  if (!preview.length && !isListUrl) { toast('没解析出链接，看看格式对不对'); return; }
  if (preview.length && !confirm(`解析出 ${preview.length} 条，开始下载？\n每张几十 KB 到 2MB，会走流量。`)) return;

  _importing = true;
  const runBtn = _el('slUrlRun'), stopBtn = _el('slUrlStop');
  if (runBtn) runBtn.style.display = 'none';
  if (stopBtn) stopBtn.style.display = '';
  const statusEl = _el('slStatus');
  try {
    const r = await importStickerUrls(text, (done, total, name) => {
      setStatus(statusEl, 'clock-dash', `下载中 ${done}/${total} · ${String(name || '').slice(0, 14)}`);
    });
    const msg = (r.aborted ? `已停下，导入了 ${r.added} 张` : `导入完成：${r.added} 张`)
              + (r.failed.length ? `，${r.failed.length} 张失败` : '');
    setStatus(statusEl, r.failed.length ? 'x-circle' : 'check', msg);
    toast(msg);
    if (r.failed.length) console.warn('[StickerLib] 失败的：', r.failed);
    renderStickerMgr();
    _renderGrid();
    if (!r.failed.length && ta) ta.value = '';
  } catch (e) {
    console.warn('[StickerLib] 链接导入异常', e);
    setStatus(statusEl, 'x-circle', '导入失败，看 vConsole');
  } finally {
    _importing = false;
    if (runBtn) runBtn.style.display = '';
    if (stopBtn) stopBtn.style.display = 'none';
  }
}

function _bind() {
  if (_bound) return;
  _bound = true;

  _el('slUrlToggle')?.addEventListener('click', () => {
    const p = _el('slUrlPanel');
    if (!p) return;
    const show = p.style.display === 'none';
    p.style.display = show ? 'block' : 'none';
    if (show) _el('slUrlText')?.focus();
  });
  _el('slUrlClose')?.addEventListener('click', () => {
    const p = _el('slUrlPanel');
    if (p) p.style.display = 'none';
  });
  _el('slUrlRun')?.addEventListener('click', _doUrlImport);
  _el('slUrlStop')?.addEventListener('click', () => { abortStickerUrlImport(); toast('正在停下…'); });

  _el('slClose')?.addEventListener('click', closeStickerLib);
  _el('stickerLib')?.addEventListener('click', (e) => {
    if (e.target.id === 'stickerLib') closeStickerLib();   // 点遮罩关掉
  });

  _el('slSearch')?.addEventListener('input', (e) => {
    _query = e.target.value;
    _renderGrid();
  });

  _el('slImport')?.addEventListener('click', () => _el('slFile')?.click());
  _el('slFile')?.addEventListener('change', function () {
    const files = Array.from(this.files || []);
    this.value = '';   // 先清空，同一批图还能再选一次
    _doImport(files);
  });

  // 点格子选中 / 取消
  _el('slGrid')?.addEventListener('click', (e) => {
    const cell = e.target.closest('.sl-cell');
    if (!cell) return;
    const id = cell.dataset.id;
    if (_sel.has(id)) _sel.delete(id); else _sel.add(id);
    cell.classList.toggle('on', _sel.has(id));
    _renderFoot();
  });

  // 长按 / 双击名字 → 改名
  let _pressT = null, _pressId = null, _longFired = false;
  _el('slGrid')?.addEventListener('pointerdown', (e) => {
    const cell = e.target.closest('.sl-cell');
    if (!cell) return;
    _longFired = false;
    _pressId = cell.dataset.id;
    _pressT = setTimeout(() => { _longFired = true; _startRename(_pressId); }, 600);
  });
  const _cancelPress = () => { clearTimeout(_pressT); _pressT = null; };
  _el('slGrid')?.addEventListener('pointerup', _cancelPress);
  _el('slGrid')?.addEventListener('pointercancel', _cancelPress);
  _el('slGrid')?.addEventListener('pointermove', _cancelPress);
  _el('slGrid')?.addEventListener('dblclick', (e) => {
    const cell = e.target.closest('.sl-cell');
    if (cell) _startRename(cell.dataset.id);
  });
  // 长按已经触发改名时，别再当成一次选中
  _el('slGrid')?.addEventListener('click', (e) => {
    if (_longFired) { _longFired = false; e.stopPropagation(); e.preventDefault(); }
  }, true);

  _el('slSelClear')?.addEventListener('click', () => {
    _sel.clear();
    _renderGrid();
  });

  _el('slRename')?.addEventListener('click', () => {
    const id = [..._sel][0];
    if (id) _startRename(id);
  });

  _el('slDelSel')?.addEventListener('click', async () => {
    const ids = [..._sel];
    if (!ids.length) return;
    if (!confirm(`删除这 ${ids.length} 张贴纸？删了就找不回来了。`)) return;
    const n = await deleteStickersByIds(ids);
    _sel.clear();
    renderStickerMgr();
    _renderGrid();
    toast(`已删除 ${n} 张`);
  });
}

// ── 对外 ─────────────────────────────────────────────────────────────────

export function openStickerLib() {
  _bind();
  _query = '';
  _sel.clear();
  const s = _el('slSearch');
  if (s) s.value = '';
  // 清状态行用直接赋值，不走 setStatus —— 空图标会让 .status-ico::before
  // 显示成一个没有 mask 的空方块，白占一格
  const st = _el('slStatus');
  if (st) { st.className = ''; st.textContent = ''; }
  _renderGrid();
  _el('stickerLib')?.classList.add('show');
  // 打开时把没加载的图补上（启动时的预热可能还没轮完）
  getChatStickers().filter(x => x.hasImg).forEach(x => ensureStickerImg(x.id));
}

export function closeStickerLib() {
  _el('stickerLib')?.classList.remove('show');
}

export function initStickerLib() {
  _bind();
  _el('btnOpenStickerLib')?.addEventListener('click', openStickerLib);
  Object.assign(window, { openStickerLib, closeStickerLib });
}
