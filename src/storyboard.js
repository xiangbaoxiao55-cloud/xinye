// ── Storyboard.js — 无限画布故事板 ──────────────────────────────

// ── DB ───────────────────────────────────────────────────────────
class SBDatabase {
  constructor(){this.db=null}
  open(){
    return new Promise((res,rej)=>{
      const r=indexedDB.open('StoryboardDB',1);
      r.onupgradeneeded=e=>{
        const db=e.target.result;
        if(!db.objectStoreNames.contains('projects')) db.createObjectStore('projects',{keyPath:'id'});
        if(!db.objectStoreNames.contains('cards')) {
          const s=db.createObjectStore('cards',{keyPath:'id'});
          s.createIndex('byProject','projectId',{unique:false});
        }
        if(!db.objectStoreNames.contains('settings')) db.createObjectStore('settings',{keyPath:'key'});
      };
      r.onsuccess=e=>{this.db=e.target.result;res()};
      r.onerror=e=>rej(e.target.error);
    });
  }
  _tx(s,m='readonly'){return this.db.transaction(s,m).objectStore(s)}
  _p(r){return new Promise((res,rej)=>{r.onsuccess=e=>res(e.target.result);r.onerror=e=>rej(e.target.error)})}
  all(s){return this._p(this._tx(s).getAll())}
  get(s,k){return this._p(this._tx(s).get(k))}
  put(s,o){return this._p(this._tx(s,'readwrite').put(o))}
  del(s,k){return this._p(this._tx(s,'readwrite').delete(k))}
  async byIndex(store,idx,val){
    return this._p(this._tx(store).index(idx).getAll(val));
  }
}

// ── State ────────────────────────────────────────────────────────
const db = new SBDatabase();
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2);
const ts = () => new Date().toTimeString().slice(0,8);

let _lastDragEnd = 0;

let S = {
  projectId: null,
  projectName: '未命名项目',
  cards: [],
  drawPresets: [],
  curDrawId: null,
  localServer: '',
  defaultSize: '1024x1024',
  // canvas state
  panX: 0, panY: 0, zoom: 1,
  isPanning: false, panStartX: 0, panStartY: 0,
  isDragging: false, dragCard: null, dragOffX: 0, dragOffY: 0,
  selectedIds: [],
  ctxCardId: null,
  spaceHeld: false,
  isBoxSelecting: false, boxStartX: 0, boxStartY: 0,
};

const SB_SIZES = [
  {v:'512x512',l:'512×512'},{v:'768x768',l:'768×768'},{v:'1024x1024',l:'1024×1024'},
  {v:'1024x1536',l:'1024×1536 竖'},{v:'1536x1024',l:'1536×1024 横'},
  {v:'720x1280',l:'720×1280 竖16:9'},{v:'1280x720',l:'1280×720 横16:9'},
  {v:'1024x1792',l:'1024×1792 竖长'},{v:'1792x1024',l:'1792×1024 横长'},
  {v:'1152x2048',l:'1152×2048 竖2K'},{v:'1536x2048',l:'1536×2048 竖2K'},
  {v:'2048x1152',l:'2048×1152 横2K'},{v:'2048x1536',l:'2048×1536 横2K'},
  {v:'2048x2048',l:'2048×2048'},
];

// ── Init ─────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  await db.open();
  loadDrawConfig();
  await loadOrCreateProject();
  initCanvas();
  initTopbar();
  initFAB();
  initContextMenus();
  initLightbox();
  initKeyboard();
  renderAllCards();
  updateZoomLabel();
});

function loadDrawConfig() {
  S.drawPresets = JSON.parse(localStorage.getItem('draw_drawPresets') || '[]');
  S.curDrawId = localStorage.getItem('draw_curDrawId') || S.drawPresets[0]?.id || null;
  S.localServer = localStorage.getItem('draw_localServer') || '';
  S.defaultSize = localStorage.getItem('sb_defaultSize') || '1024x1024';
}

async function loadOrCreateProject() {
  const lastId = localStorage.getItem('sb_lastProjectId');
  if (lastId) {
    const proj = await db.get('projects', lastId);
    if (proj) {
      S.projectId = proj.id;
      S.projectName = proj.name;
      S.panX = proj.panX || 0;
      S.panY = proj.panY || 0;
      S.zoom = proj.zoom || 1;
      S.cards = await db.byIndex('cards', 'byProject', proj.id);
      document.getElementById('project-name').value = proj.name;
      return;
    }
  }
  S.projectId = uid();
  S.projectName = '未命名项目';
  S.panX = window.innerWidth / 2;
  S.panY = window.innerHeight / 2;
  S.zoom = 1;
  S.cards = [];
  await db.put('projects', { id: S.projectId, name: S.projectName, panX: S.panX, panY: S.panY, zoom: 1, createdAt: Date.now(), updatedAt: Date.now() });
  localStorage.setItem('sb_lastProjectId', S.projectId);
}

// ── Canvas Engine ────────────────────────────────────────────────
const $wrap = () => document.getElementById('canvas-wrap');
const $canvas = () => document.getElementById('canvas');

function initCanvas() {
  const wrap = $wrap();

  wrap.addEventListener('pointerdown', onCanvasPointerDown);
  wrap.addEventListener('pointermove', onCanvasPointerMove);
  wrap.addEventListener('pointerup', onCanvasPointerUp);
  wrap.addEventListener('wheel', onCanvasWheel, { passive: false });
  wrap.addEventListener('dblclick', onCanvasDblClick);
  wrap.addEventListener('contextmenu', onCanvasContextMenu);

  wrap.addEventListener('dragover', e => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
  wrap.addEventListener('dragenter', e => { e.preventDefault(); wrap.classList.add('drop-active'); });
  wrap.addEventListener('dragleave', e => { if (e.relatedTarget && wrap.contains(e.relatedTarget)) return; wrap.classList.remove('drop-active'); });
  wrap.addEventListener('drop', onCanvasDrop);

  applyTransform();
}

function applyTransform() {
  const c = $canvas();
  c.style.transform = `translate(${S.panX}px, ${S.panY}px) scale(${S.zoom})`;
  $wrap().style.backgroundPosition = `${S.panX}px ${S.panY}px`;
  $wrap().style.backgroundSize = `${S.zoom * 40}px ${S.zoom * 40}px`;
}

function updateZoomLabel() {
  document.getElementById('zoom-label').textContent = Math.round(S.zoom * 100) + '%';
}

function screenToCanvas(sx, sy) {
  const rect = $wrap().getBoundingClientRect();
  return {
    x: (sx - rect.left - S.panX) / S.zoom,
    y: (sy - rect.top - S.panY) / S.zoom
  };
}

function onCanvasPointerDown(e) {
  hideAllMenus();
  if (e.button === 1 || (e.button === 0 && S.spaceHeld)) {
    S.isPanning = true;
    S.panStartX = e.clientX - S.panX;
    S.panStartY = e.clientY - S.panY;
    $wrap().classList.add('grabbing');
    e.preventDefault();
    return;
  }
  if (e.button === 0 && !e.target.closest('.sb-card')) {
    S.isBoxSelecting = true;
    const pos = screenToCanvas(e.clientX, e.clientY);
    S.boxStartX = pos.x; S.boxStartY = pos.y;
    if (!e.shiftKey) {
      S.selectedIds = [];
      document.querySelectorAll('.sb-card.selected').forEach(el => el.classList.remove('selected'));
    }
    const box = document.getElementById('selection-box');
    box.style.left = pos.x + 'px'; box.style.top = pos.y + 'px';
    box.style.width = '0'; box.style.height = '0';
    box.classList.remove('hidden');
    e.preventDefault();
  }
}

function onCanvasPointerMove(e) {
  if (S.isPanning) {
    S.panX = e.clientX - S.panStartX;
    S.panY = e.clientY - S.panStartY;
    applyTransform();
    return;
  }
  if (S.isBoxSelecting) {
    const pos = screenToCanvas(e.clientX, e.clientY);
    const bx = Math.min(S.boxStartX, pos.x), by = Math.min(S.boxStartY, pos.y);
    const bw = Math.abs(pos.x - S.boxStartX), bh = Math.abs(pos.y - S.boxStartY);
    const box = document.getElementById('selection-box');
    box.style.left = bx + 'px'; box.style.top = by + 'px';
    box.style.width = bw + 'px'; box.style.height = bh + 'px';
    const sel = [];
    for (const card of S.cards) {
      if (!card.imageData) continue;
      const el = document.querySelector(`.sb-card[data-id="${card.id}"]`);
      if (!el) continue;
      const cw = el.offsetWidth, ch = el.offsetHeight;
      const hit = !(card.x + cw < bx || card.x > bx + bw || card.y + ch < by || card.y > by + bh);
      if (hit) { sel.push(card.id); el.classList.add('selected'); }
      else el.classList.remove('selected');
    }
    S.selectedIds = sel;
    return;
  }
}

function onCanvasPointerUp(e) {
  if (S.isPanning) {
    S.isPanning = false;
    $wrap().classList.remove('grabbing');
    scheduleSave();
    return;
  }
  if (S.isBoxSelecting) {
    S.isBoxSelecting = false;
    document.getElementById('selection-box').classList.add('hidden');
    if (S.selectedIds.length) toast(`选中 ${S.selectedIds.length} 张图片，右键可「以此生图」`);
    return;
  }
  if (S.isDragging) {
    S.isDragging = false;
    const el = document.querySelector(`.sb-card[data-id="${S.dragCard}"]`);
    if (el) el.classList.remove('dragging');
    S.dragCard = null;
    scheduleSave();
  }
}

function onCanvasWheel(e) {
  e.preventDefault();
  const rect = $wrap().getBoundingClientRect();
  const mx = e.clientX - rect.left;
  const my = e.clientY - rect.top;

  const oldZoom = S.zoom;
  const delta = e.deltaY > 0 ? 0.9 : 1.1;
  S.zoom = Math.min(5, Math.max(0.1, S.zoom * delta));

  S.panX = mx - (mx - S.panX) * (S.zoom / oldZoom);
  S.panY = my - (my - S.panY) * (S.zoom / oldZoom);

  applyTransform();
  updateZoomLabel();
  scheduleSave();
}

function onCanvasDblClick(e) {
  if (e.target.closest('.sb-card')) return;
  const pos = screenToCanvas(e.clientX, e.clientY);
  addGenerateCard(pos.x, pos.y);
}

function onCanvasContextMenu(e) {
  e.preventDefault();
  const cardEl = e.target.closest('.sb-card');
  if (cardEl) {
    showCardContextMenu(e.clientX, e.clientY, cardEl.dataset.id);
  } else {
    showCanvasContextMenu(e.clientX, e.clientY, e);
  }
}

async function onCanvasDrop(e) {
  e.preventDefault();
  $wrap().classList.remove('drop-active');
  const files = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith('image/'));
  if (!files.length) return;
  const pos = screenToCanvas(e.clientX, e.clientY);
  for (let i = 0; i < files.length; i++) {
    const data = await f2b(files[i]);
    addImageCard(pos.x + i * 300, pos.y, data, files[i].name);
  }
  toast(`拖入了 ${files.length} 张图片`);
}

// ── Topbar ───────────────────────────────────────────────────────
function initTopbar() {
  document.getElementById('project-name').addEventListener('change', e => {
    S.projectName = e.target.value || '未命名项目';
    scheduleSave();
  });
  document.getElementById('btn-zoom-in').addEventListener('click', () => {
    zoomTo(S.zoom * 1.2);
  });
  document.getElementById('btn-zoom-out').addEventListener('click', () => {
    zoomTo(S.zoom / 1.2);
  });
  document.getElementById('btn-fit').addEventListener('click', fitAllCards);
  document.getElementById('btn-settings').addEventListener('click', openSettings);
}

function zoomTo(z) {
  const rect = $wrap().getBoundingClientRect();
  const cx = rect.width / 2;
  const cy = rect.height / 2;
  const oldZoom = S.zoom;
  S.zoom = Math.min(5, Math.max(0.1, z));
  S.panX = cx - (cx - S.panX) * (S.zoom / oldZoom);
  S.panY = cy - (cy - S.panY) * (S.zoom / oldZoom);
  applyTransform();
  updateZoomLabel();
  scheduleSave();
}

function fitAllCards() {
  if (!S.cards.length) {
    S.panX = $wrap().offsetWidth / 2;
    S.panY = $wrap().offsetHeight / 2;
    S.zoom = 1;
    applyTransform();
    updateZoomLabel();
    return;
  }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const c of S.cards) {
    minX = Math.min(minX, c.x);
    minY = Math.min(minY, c.y);
    maxX = Math.max(maxX, c.x + (c.width || 260));
    maxY = Math.max(maxY, c.y + (c.height || 240));
  }
  const w = maxX - minX + 80;
  const h = maxY - minY + 80;
  const ww = $wrap().offsetWidth;
  const wh = $wrap().offsetHeight;
  S.zoom = Math.min(2, Math.min(ww / w, wh / h));
  S.panX = (ww - w * S.zoom) / 2 - minX * S.zoom + 40 * S.zoom;
  S.panY = (wh - h * S.zoom) / 2 - minY * S.zoom + 40 * S.zoom;
  applyTransform();
  updateZoomLabel();
  scheduleSave();
}

// ── FAB ──────────────────────────────────────────────────────────
function initFAB() {
  document.getElementById('fab-add').addEventListener('click', () => {
    const rect = $wrap().getBoundingClientRect();
    const pos = screenToCanvas(rect.left + rect.width / 2, rect.top + rect.height / 2);
    addGenerateCard(pos.x - 120, pos.y - 100);
  });
  document.getElementById('fab-upload').addEventListener('click', () => {
    const fileInput = document.getElementById('file-upload');
    fileInput._mode = 'canvas';
    fileInput.click();
  });
  document.getElementById('fab-text').addEventListener('click', () => {
    const rect = $wrap().getBoundingClientRect();
    const pos = screenToCanvas(rect.left + rect.width / 2, rect.top + rect.height / 2);
    addTextCard(pos.x - 120, pos.y - 60);
  });
  document.getElementById('file-upload').addEventListener('change', onFileUpload);
}

// ── Cards ────────────────────────────────────────────────────────
function addGenerateCard(x, y) {
  const card = {
    id: uid(),
    projectId: S.projectId,
    type: 'generate',
    x, y,
    width: 280,
    prompt: '',
    negPrompt: '',
    size: S.defaultSize,
    imageData: null,
    status: 'idle',
    createdAt: Date.now(),
  };
  S.cards.push(card);
  renderCard(card);
  scheduleSave();
  setTimeout(() => {
    const ta = document.querySelector(`.sb-card[data-id="${card.id}"] textarea`);
    if (ta) ta.focus();
  }, 100);
}

function addTextCard(x, y) {
  const card = {
    id: uid(),
    projectId: S.projectId,
    type: 'text',
    x, y,
    width: 240,
    text: '',
    createdAt: Date.now(),
  };
  S.cards.push(card);
  renderCard(card);
  scheduleSave();
}

function addImageCard(x, y, imageData, prompt) {
  const card = {
    id: uid(),
    projectId: S.projectId,
    type: 'generate',
    x, y,
    width: 280,
    prompt: prompt || '',
    negPrompt: '',
    size: S.defaultSize,
    imageData,
    status: 'done',
    createdAt: Date.now(),
  };
  S.cards.push(card);
  renderCard(card);
  scheduleSave();
}

function renderAllCards() {
  const c = $canvas();
  c.querySelectorAll('.sb-card').forEach(el => el.remove());
  for (const card of S.cards) renderCard(card);
}

function renderCard(card) {
  const el = document.createElement('div');
  el.className = 'sb-card';
  el.dataset.id = card.id;
  el.style.left = card.x + 'px';
  el.style.top = card.y + 'px';
  if (card.width) el.style.width = card.width + 'px';

  if (card.type === 'text') {
    el.innerHTML = `<div class="sb-card-text">
      <textarea placeholder="输入文本...">${card.text || ''}</textarea>
    </div>`;
    const ta = el.querySelector('textarea');
    ta.addEventListener('input', () => {
      card.text = ta.value;
      scheduleSave();
    });
  } else if (card.type === 'generate') {
    if (card.status === 'done' && card.imageData) {
      renderCardDone(el, card);
    } else if (card.status === 'generating') {
      renderCardLoading(el, card);
    } else {
      renderCardIdle(el, card);
    }
  }

  initCardDrag(el, card);
  $canvas().appendChild(el);
}

function normalizeRefs(card) {
  if (!card.refImageData) return [];
  return Array.isArray(card.refImageData) ? card.refImageData : [card.refImageData];
}

function renderCardIdle(el, card) {
  const presetOpts = S.drawPresets.map(p =>
    `<option value="${p.id}"${p.id === S.curDrawId ? ' selected' : ''}>${p.name}</option>`
  ).join('');

  const refs = normalizeRefs(card);
  let refHtml = '';
  if (refs.length === 1) {
    refHtml = `<div class="sb-ref-thumb"><img src="${refs[0]}" alt="参考"><button class="sb-ref-remove" title="移除参考">✕</button></div>`;
  } else if (refs.length > 1) {
    refHtml = `<div class="sb-ref-strip">${refs.map((r,i) => `<img src="${r}" alt="参考${i+1}">`).join('')}<button class="sb-ref-remove" title="移除全部参考">✕</button></div>`;
  }

  el.innerHTML = `
    <div class="sb-card-placeholder">
      ${refHtml || '<div class="icon">🖼</div>'}
      <span>${refs.length ? '参考图 ×' + refs.length : '双击或输入prompt'}</span>
    </div>
    <div class="sb-card-prompt">
      <textarea placeholder="描述你想要的画面...">${card.prompt || ''}</textarea>
      <div class="sb-card-params">
        <select class="p-size">
          ${SB_SIZES.map(s => `<option value="${s.v}"${card.size === s.v ? ' selected' : ''}>${s.l}</option>`).join('')}
        </select>
        <select class="p-preset">${presetOpts || '<option value="">无预设</option>'}</select>
        <button class="sb-card-gen">生成 ▶</button>
      </div>
    </div>`;

  const ta = el.querySelector('textarea');
  ta.addEventListener('input', () => { card.prompt = ta.value; scheduleSave(); });
  ta.addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      doGenerate(card, el);
    }
  });

  el.querySelector('.p-size').addEventListener('change', e => {
    card.size = e.target.value;
    scheduleSave();
  });

  el.querySelector('.sb-card-gen').addEventListener('click', () => doGenerate(card, el));
  const rmBtn = el.querySelector('.sb-ref-remove');
  if (rmBtn) rmBtn.addEventListener('click', e => {
    e.stopPropagation();
    delete card.refImageData;
    renderCardUpdate(card, el);
    scheduleSave();
  });
}

function renderCardLoading(el, card) {
  el.innerHTML = `
    <div class="sb-card-loading">
      <div class="sb-spinner"></div>
      <span>生成中...</span>
    </div>
    <div class="sb-card-info">
      <span class="sb-card-info-prompt" title="${(card.prompt || '').replace(/"/g, '&quot;')}">${truncate(card.prompt, 40)}</span>
      <span>${card.size || ''}</span>
    </div>`;
}

function renderCardDone(el, card) {
  el.innerHTML = `
    <div class="sb-card-image">
      <img src="${card.imageData}" alt="" draggable="false">
    </div>
    <div class="sb-card-info">
      <span class="sb-card-info-prompt" title="${(card.prompt || '').replace(/"/g, '&quot;')}">${truncate(card.prompt, 40)}</span>
      <span>${card.size || ''}</span>
    </div>`;

  el.querySelector('img').addEventListener('click', e => {
    if (Date.now() - _lastDragEnd < 300) return;
    openLightbox(card.imageData);
  });

  el.querySelector('.sb-card-info-prompt').addEventListener('click', () => {
    toast(card.prompt || '(无 prompt)');
  });
}

function truncate(s, n) {
  if (!s) return '';
  return s.length > n ? s.slice(0, n) + '…' : s;
}

// ── Card Drag ────────────────────────────────────────────────────
function initCardDrag(el, card) {
  el.addEventListener('dragstart', e => e.preventDefault());
  let startX, startY, moved;

  el.addEventListener('pointerdown', e => {
    if (e.target.closest('textarea, select, button, input, a')) return;
    if (e.button !== 0) return;
    if (S.spaceHeld) return;

    if (!S.selectedIds.includes(card.id)) {
      S.selectedIds = [card.id];
      document.querySelectorAll('.sb-card.selected').forEach(x => x.classList.remove('selected'));
      el.classList.add('selected');
    }

    const pos = screenToCanvas(e.clientX, e.clientY);
    S.dragOffX = pos.x - card.x;
    S.dragOffY = pos.y - card.y;
    startX = e.clientX;
    startY = e.clientY;
    moved = false;

    const onMove = me => {
      if (!moved && (Math.abs(me.clientX - startX) > 4 || Math.abs(me.clientY - startY) > 4)) {
        moved = true;
        S.isDragging = true;
        S.dragCard = card.id;
        el.classList.add('dragging');
      }
      if (moved) {
        const p = screenToCanvas(me.clientX, me.clientY);
        card.x = p.x - S.dragOffX;
        card.y = p.y - S.dragOffY;
        el.style.left = card.x + 'px';
        el.style.top = card.y + 'px';
      }
    };

    const onUp = () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      if (moved) {
        _lastDragEnd = Date.now();
        S.isDragging = false;
        S.dragCard = null;
        el.classList.remove('dragging');
        scheduleSave();
      }
    };

    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    e.stopPropagation();
  });
}

// ── Generate Image ───────────────────────────────────────────────
async function doGenerate(card, el) {
  if (!card.prompt?.trim()) {
    toast('先输入 prompt 描述画面', 'warn');
    return;
  }
  if (!S.drawPresets.length) {
    toast('先在设置或画图台配置画图API预设', 'warn');
    return;
  }

  const presetId = el.querySelector('.p-preset')?.value || S.curDrawId;
  card.status = 'generating';
  el = renderCardUpdate(card, el);

  try {
    const refs = normalizeRefs(card);
    const imageData = await drawWithFallback(card.prompt, card.negPrompt, card.size, presetId, refs);
    card.imageData = imageData;
    card.status = 'done';
    renderCardUpdate(card, el);
    toast('生成完成 ✨');
    scheduleSave();
  } catch (err) {
    card.status = 'idle';
    renderCardUpdate(card, el);
    toast(err.message, 'error');
  }
}

function renderCardUpdate(card, el) {
  const newEl = document.createElement('div');
  newEl.className = el.className;
  newEl.dataset.id = card.id;
  newEl.style.cssText = el.style.cssText;

  if (card.type === 'text') {
    newEl.innerHTML = `<div class="sb-card-text"><textarea placeholder="输入文本...">${card.text || ''}</textarea></div>`;
    newEl.querySelector('textarea').addEventListener('input', e => {
      card.text = e.target.value;
      scheduleSave();
    });
  } else if (card.status === 'done' && card.imageData) {
    renderCardDone(newEl, card);
  } else if (card.status === 'generating') {
    renderCardLoading(newEl, card);
  } else {
    renderCardIdle(newEl, card);
  }

  initCardDrag(newEl, card);
  el.replaceWith(newEl);
  return newEl;
}

async function drawWithFallback(prompt, negPrompt, size, presetId, refs) {
  const presets = S.drawPresets;
  let startIdx = presets.findIndex(p => p.id === presetId);
  if (startIdx < 0) startIdx = 0;
  let lastErr;

  for (let i = 0; i < presets.length; i++) {
    const preset = presets[(startIdx + i) % presets.length];
    if (i > 0 && preset.skipFallback) continue;
    try {
      if (i > 0) toast(`切备用"${preset.name}"...`, 'warn');
      let images;
      if (refs && refs.length) images = await callEdits(preset, prompt, negPrompt, size, refs, 1);
      else if (preset.format === 'nvidia') images = await callNvidia(preset, prompt, size, 1);
      else if (preset.format === 'chat') images = await callChat(preset, prompt, 1);
      else images = await callGenerations(preset, prompt, negPrompt, size, 1);
      console.log(`[${ts()}] ✅ "${preset.name}" 出图`);
      return images[0];
    } catch (err) {
      lastErr = err;
      if (presets.length > 1) console.warn(`[${ts()}] 预设"${preset.name}"失败:`, err.message);
    }
  }
  throw lastErr || new Error('所有预设均失败');
}

// ── Draw API (from draw.js) ──────────────────────────────────────
const f2b = f => new Promise((res, rej) => {
  const r = new FileReader(); r.onload = e => res(e.target.result); r.onerror = rej; r.readAsDataURL(f);
});

async function fetchWithProxy(url) {
  if (S.localServer) {
    try {
      const r = await fetch(`${S.localServer}/api/proxy-fetch?url=${encodeURIComponent(url)}`);
      if (r.ok) return r;
    } catch (_) {}
  }
  return fetch(url);
}

async function callGenerations(preset, prompt, negPrompt, size, n) {
  const { key, url, model } = preset;
  if (!key || !url) throw new Error(`预设"${preset.name}"未配置 Key 或 URL`);
  const body = { model: model || 'dall-e-3', prompt, n, size, response_format: 'b64_json' };
  if (negPrompt) body.negative_prompt = negPrompt;
  const ac = new AbortController(); const at = setTimeout(() => ac.abort(), 1500000);
  const r = await fetch(`${url}/images/generations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
    body: JSON.stringify(body), signal: ac.signal
  }).finally(() => clearTimeout(at));
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`);
  const d = await r.json();
  if (d.data?.[0]?.b64_json) return d.data.map(i => `data:image/png;base64,${i.b64_json}`);
  if (d.data?.[0]?.url) {
    const results = [];
    for (const i of d.data) {
      const rb = await fetchWithProxy(i.url);
      results.push(await f2b(new File([await rb.blob()], 'img.png')));
    }
    return results;
  }
  throw new Error('generations API 返回格式异常');
}

async function callChat(preset, prompt, n) {
  const { key, url, model } = preset;
  if (!key || !url) throw new Error(`预设"${preset.name}"未配置 Key 或 URL`);
  const results = [];
  for (let i = 0; i < n; i++) {
    const ac = new AbortController(); const at = setTimeout(() => ac.abort(), 1500000);
    const r = await fetch(`${url}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
      body: JSON.stringify({ model: model || 'dall-e-3', messages: [{ role: 'user', content: `请画一张图：${prompt}` }], max_tokens: 2048 }),
      signal: ac.signal
    }).finally(() => clearTimeout(at));
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`);
    const d = await r.json();
    const content = d.choices?.[0]?.message?.content || '';
    const m = content.match(/data:image\/[^;]+;base64,[A-Za-z0-9+/=]+/);
    if (m) results.push(m[0]);
    else throw new Error('chat 格式未能提取图片数据');
  }
  return results;
}

async function callNvidia(preset, prompt, size, n) {
  const { key, url } = preset;
  if (!key || !url) throw new Error(`预设"${preset.name}"未配置 Key 或 URL`);
  const SF = [768,832,896,960,1024,1088,1152,1216,1280,1344];
  const SK = [672,688,720,752,800,832,880,944,1024,1104,1184,1248,1328,1392,1456,1504,1568];
  const isKtx = url.includes('kontext');
  const V = isKtx ? SK : SF;
  const clamp = v => V.reduce((a, b) => Math.abs(b - v) < Math.abs(a - v) ? b : a);
  const defSize = isKtx ? '1024x1568' : '1024x1344';
  const [sw, sh] = (size || defSize).split('x').map(Number);
  const w = clamp(sw || 1024), h = clamp(sh || (isKtx ? 1568 : 1344));
  const isSchnell = url.includes('schnell');
  const steps = isKtx ? 30 : (isSchnell ? 4 : 50);
  const results = [];
  for (let i = 0; i < n; i++) {
    const ac = new AbortController(); const at = setTimeout(() => ac.abort(), 300000);
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}`, 'Accept': 'application/json' },
      body: JSON.stringify({ prompt, width: w, height: h, steps, cfg_scale: 5, seed: 0 }),
      signal: ac.signal
    }).finally(() => clearTimeout(at));
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`);
    const d = await r.json();
    const b64 = d.artifacts?.[0]?.base64 || d.image?.replace(/^data:image\/[^;]+;base64,/, '');
    if (b64) results.push(`data:image/png;base64,${b64}`);
    else throw new Error('NVIDIA API 返回格式异常');
  }
  return results;
}

async function callEdits(preset, prompt, negPrompt, size, refB64s, n) {
  const { key, url, model } = preset;
  if (!key || !url) throw new Error(`预设"${preset.name}"未配置 Key 或 URL`);
  const fd = new FormData();
  for (let i = 0; i < refB64s.length; i++) {
    const raw = refB64s[i].replace(/^data:image\/\w+;base64,/, '');
    const bin = atob(raw); const bytes = new Uint8Array(bin.length);
    for (let j = 0; j < bin.length; j++) bytes[j] = bin.charCodeAt(j);
    fd.append('image[]', new Blob([bytes], { type: 'image/png' }), `ref${i}.png`);
  }
  fd.append('model', model || 'dall-e-3');
  fd.append('prompt', prompt); fd.append('n', n); fd.append('size', size);
  if (negPrompt) fd.append('negative_prompt', negPrompt);
  const ac = new AbortController(); const at = setTimeout(() => ac.abort(), 1500000);
  const r = await fetch(`${url}/images/edits`, {
    method: 'POST', headers: { 'Authorization': `Bearer ${key}` }, body: fd, signal: ac.signal
  }).finally(() => clearTimeout(at));
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`);
  const d = await r.json();
  if (d.data?.[0]?.b64_json) return d.data.map(i => `data:image/png;base64,${i.b64_json}`);
  if (d.data?.[0]?.url) {
    const results = [];
    for (const i of d.data) {
      const rb = await fetchWithProxy(i.url);
      results.push(await f2b(new File([await rb.blob()], 'img.png')));
    }
    return results;
  }
  throw new Error('edits API 返回格式异常');
}

// ── Context Menus ────────────────────────────────────────────────
let _ctxPos = { x: 0, y: 0 };

function initContextMenus() {
  document.addEventListener('click', e => {
    if (!e.target.closest('#ctx-menu, #card-ctx-menu')) hideAllMenus();
  });

  document.querySelectorAll('#ctx-menu button').forEach(btn => {
    btn.addEventListener('click', () => {
      const action = btn.dataset.action;
      const pos = screenToCanvas(_ctxPos.x, _ctxPos.y);
      if (action === 'generate') addGenerateCard(pos.x, pos.y);
      else if (action === 'upload') {
        const fi = document.getElementById('file-upload');
        fi._mode = 'ctx';
        fi._pos = pos;
        fi.click();
      }
      else if (action === 'text') addTextCard(pos.x, pos.y);
      hideAllMenus();
    });
  });

  document.querySelectorAll('#card-ctx-menu button').forEach(btn => {
    btn.addEventListener('click', () => {
      const action = btn.dataset.action;
      const card = S.cards.find(c => c.id === S.ctxCardId);
      if (!card) { hideAllMenus(); return; }
      const el = document.querySelector(`.sb-card[data-id="${card.id}"]`);

      if (action === 'regenerate') {
        if (card.type === 'generate') {
          card.status = 'idle';
          renderCardUpdate(card, el);
        }
      } else if (action === 'edit-prompt') {
        if (card.type === 'generate') {
          card.status = 'idle';
          renderCardUpdate(card, el);
        }
      } else if (action === 'gen-from') {
        const selWithImg = S.cards.filter(c => S.selectedIds.includes(c.id) && c.imageData);
        const refSources = selWithImg.length > 0 ? selWithImg : (card.imageData ? [card] : []);
        if (refSources.length) {
          const refImages = refSources.map(c => c.imageData);
          const last = refSources[refSources.length - 1];
          const newCard = {
            id: uid(), projectId: S.projectId, type: 'generate',
            x: last.x + 30, y: last.y + (last.height || 280) + 20,
            width: 280, prompt: '', negPrompt: '',
            size: card.size || S.defaultSize, imageData: null, status: 'idle',
            refImageData: refImages, createdAt: Date.now(),
          };
          S.cards.push(newCard);
          renderCard(newCard);
          scheduleSave();
          toast(`已加载 ${refImages.length} 张参考图`);
        }
      } else if (action === 'duplicate') {
        const dup = { ...card, id: uid(), x: card.x + 30, y: card.y + 30 };
        S.cards.push(dup);
        renderCard(dup);
        scheduleSave();
      } else if (action === 'download') {
        if (card.imageData) dlImg(card.imageData);
      } else if (action === 'delete') {
        deleteCard(card.id);
      }
      hideAllMenus();
    });
  });
}

function showCanvasContextMenu(x, y, e) {
  _ctxPos = { x, y };
  const menu = document.getElementById('ctx-menu');
  menu.classList.remove('hidden');
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';
  clampMenuPosition(menu);
}

function showCardContextMenu(x, y, cardId) {
  S.ctxCardId = cardId;
  const menu = document.getElementById('card-ctx-menu');
  menu.classList.remove('hidden');
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';
  clampMenuPosition(menu);

  const card = S.cards.find(c => c.id === cardId);
  menu.querySelector('[data-action="download"]').style.display = card?.imageData ? '' : 'none';
  menu.querySelector('[data-action="regenerate"]').style.display = card?.type === 'generate' ? '' : 'none';
  const selCount = S.cards.filter(c => S.selectedIds.includes(c.id) && c.imageData).length;
  const genBtn = menu.querySelector('[data-action="gen-from"]');
  genBtn.style.display = (card?.imageData || selCount > 0) ? '' : 'none';
  genBtn.textContent = selCount > 1 ? `🎨 以 ${selCount} 张图生图` : '🎨 以此生图';
}

function clampMenuPosition(menu) {
  const r = menu.getBoundingClientRect();
  if (r.right > window.innerWidth) menu.style.left = (window.innerWidth - r.width - 8) + 'px';
  if (r.bottom > window.innerHeight) menu.style.top = (window.innerHeight - r.height - 8) + 'px';
}

function hideAllMenus() {
  document.getElementById('ctx-menu').classList.add('hidden');
  document.getElementById('card-ctx-menu').classList.add('hidden');
}

// ── File Upload ──────────────────────────────────────────────────
async function onFileUpload(e) {
  const files = Array.from(e.target.files || []);
  if (!files.length) return;

  const fi = document.getElementById('file-upload');
  let baseX, baseY;
  if (fi._mode === 'ctx' && fi._pos) {
    baseX = fi._pos.x;
    baseY = fi._pos.y;
  } else {
    const rect = $wrap().getBoundingClientRect();
    const pos = screenToCanvas(rect.left + rect.width / 2, rect.top + rect.height / 2);
    baseX = pos.x - 120;
    baseY = pos.y - 100;
  }

  for (let i = 0; i < files.length; i++) {
    const data = await f2b(files[i]);
    addImageCard(baseX + i * 300, baseY, data, files[i].name);
  }
  fi.value = '';
  toast(`上传了 ${files.length} 张图片`);
}

// ── Lightbox ─────────────────────────────────────────────────────
function initLightbox() {
  document.getElementById('lb-close').addEventListener('click', closeLightbox);
  document.getElementById('lightbox').addEventListener('click', e => {
    if (e.target === document.getElementById('lightbox')) closeLightbox();
  });
}

function openLightbox(src) {
  document.getElementById('lb-img').src = src;
  document.getElementById('lightbox').classList.remove('hidden');
}

function closeLightbox() {
  document.getElementById('lightbox').classList.add('hidden');
  document.getElementById('lb-img').src = '';
}

// ── Keyboard ─────────────────────────────────────────────────────
function initKeyboard() {
  document.addEventListener('keydown', e => {
    if (e.key === ' ' && !e.target.closest('textarea, input')) {
      e.preventDefault();
      S.spaceHeld = true;
      $wrap().style.cursor = 'grab';
    }
    if (e.key === 'Escape') {
      closeLightbox();
      hideAllMenus();
      document.getElementById('modal-settings').classList.add('hidden');
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && S.selectedIds.length && !e.target.closest('textarea, input')) {
      [...S.selectedIds].forEach(id => deleteCard(id));
      S.selectedIds = [];
    }
  });

  document.addEventListener('keyup', e => {
    if (e.key === ' ') {
      S.spaceHeld = false;
      $wrap().style.cursor = '';
    }
  });
}

function deleteCard(id) {
  S.cards = S.cards.filter(c => c.id !== id);
  const el = document.querySelector(`.sb-card[data-id="${id}"]`);
  if (el) el.remove();
  S.selectedIds = S.selectedIds.filter(x => x !== id);
  db.del('cards', id);
  scheduleSave();
}

// ── Download ─────────────────────────────────────────────────────
function dlImg(dataUrl) {
  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = `storyboard_${Date.now()}.png`;
  a.click();
}

// ── Settings ─────────────────────────────────────────────────────
function openSettings() {
  const modal = document.getElementById('modal-settings');
  modal.classList.remove('hidden');

  const info = document.getElementById('settings-presets-info');
  if (S.drawPresets.length) {
    info.innerHTML = S.drawPresets.map(p =>
      `<div style="padding:2px 0">• ${p.name} <span style="color:var(--dim)">(${p.format || 'images'})</span></div>`
    ).join('');
  } else {
    info.textContent = '未配置。请在画图台 ⚙ 设置中添加预设。';
  }

  document.getElementById('settings-local-server').value = S.localServer;
  document.getElementById('settings-default-size').value = S.defaultSize;
}

function saveSettings() {
  S.localServer = document.getElementById('settings-local-server').value.trim();
  S.defaultSize = document.getElementById('settings-default-size').value;
  localStorage.setItem('draw_localServer', S.localServer);
  localStorage.setItem('sb_defaultSize', S.defaultSize);
  document.getElementById('modal-settings').classList.add('hidden');
  toast('设置已保存');
}

// ── Toast ────────────────────────────────────────────────────────
function toast(msg, type = 'info') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = `show${type === 'error' ? ' toast-error' : type === 'warn' ? ' toast-warn' : ''}`;
  clearTimeout(el._t);
  el._t = setTimeout(() => el.className = '', 3000);
}

// ── Persistence ──────────────────────────────────────────────────
let _saveTimer = null;
function scheduleSave() {
  document.getElementById('save-status').textContent = '保存中...';
  document.getElementById('save-status').className = 'save-pending';
  clearTimeout(_saveTimer);
  _saveTimer = setTimeout(doSave, 800);
}

async function doSave() {
  try {
    await db.put('projects', {
      id: S.projectId,
      name: S.projectName,
      panX: S.panX, panY: S.panY, zoom: S.zoom,
      updatedAt: Date.now(),
    });

    for (const card of S.cards) {
      await db.put('cards', { ...card });
    }

    const existingIds = (await db.byIndex('cards', 'byProject', S.projectId)).map(c => c.id);
    const currentIds = new Set(S.cards.map(c => c.id));
    for (const eid of existingIds) {
      if (!currentIds.has(eid)) await db.del('cards', eid);
    }

    localStorage.setItem('sb_lastProjectId', S.projectId);
    document.getElementById('save-status').textContent = '已保存';
    document.getElementById('save-status').className = 'save-ok';
  } catch (err) {
    console.error('Save failed:', err);
    document.getElementById('save-status').textContent = '保存失败';
    document.getElementById('save-status').className = 'save-pending';
  }
}
