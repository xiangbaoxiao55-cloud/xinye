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
  defaultSize: '1536x2048',
  // canvas state
  panX: 0, panY: 0, zoom: 1,
  isPanning: false, panStartX: 0, panStartY: 0,
  isDragging: false, dragCard: null, dragOffX: 0, dragOffY: 0,
  selectedIds: [],
  ctxCardId: null,
  spaceHeld: false,
  isBoxSelecting: false, boxStartX: 0, boxStartY: 0,
  // agent
  masterPresets: [],
  curMasterId: null,
  agentHistory: [],
  agentAttachedImages: [],
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
  initAgent();
  loadAgentChat();
});

function loadDrawConfig() {
  S.drawPresets = JSON.parse(localStorage.getItem('draw_drawPresets') || '[]');
  S.curDrawId = localStorage.getItem('draw_curDrawId') || S.drawPresets[0]?.id || null;
  S.localServer = localStorage.getItem('draw_localServer') || '';
  S.defaultSize = localStorage.getItem('sb_defaultSize') || '1536x2048';
  S.masterPresets = JSON.parse(localStorage.getItem('draw_masterPresets') || '[]');
  S.curMasterId = localStorage.getItem('draw_curMasterId') || S.masterPresets[0]?.id || null;
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
    S._boxPriorSel = [...S.selectedIds];
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
    const boxSel = new Set(S._boxPriorSel || []);
    for (const card of S.cards) {
      const el = document.querySelector(`.sb-card[data-id="${card.id}"]`);
      if (!el) continue;
      const cw = el.offsetWidth, ch = el.offsetHeight;
      const hit = !(card.x + cw < bx || card.x > bx + bw || card.y + ch < by || card.y > by + bh);
      if (hit) { boxSel.add(card.id); el.classList.add('selected'); }
      else if (!S._boxPriorSel?.includes(card.id)) { boxSel.delete(card.id); el.classList.remove('selected'); }
    }
    S.selectedIds = [...boxSel];
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
    if (S.selectedIds.length) toast(`选中 ${S.selectedIds.length} 张图片（Shift+框选可追加）`);
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
        ${card.imageData ? '<button class="sb-card-cancel">取消</button>' : ''}
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
  const cancelBtn = el.querySelector('.sb-card-cancel');
  if (cancelBtn) cancelBtn.addEventListener('click', () => {
    card.status = 'done';
    renderCardUpdate(card, el);
  });
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

    if (e.shiftKey) {
      if (S.selectedIds.includes(card.id)) {
        S.selectedIds = S.selectedIds.filter(id => id !== card.id);
        el.classList.remove('selected');
      } else {
        S.selectedIds.push(card.id);
        el.classList.add('selected');
      }
    } else if (!S.selectedIds.includes(card.id)) {
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

    const peers = S.selectedIds.includes(card.id)
      ? S.selectedIds.filter(id => id !== card.id).map(id => {
          const c = S.cards.find(x => x.id === id);
          const e = c && document.querySelector(`.sb-card[data-id="${id}"]`);
          return c && e ? { card: c, el: e, offX: c.x - card.x, offY: c.y - card.y } : null;
        }).filter(Boolean)
      : [];

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
        for (const pr of peers) {
          pr.card.x = card.x + pr.offX;
          pr.card.y = card.y + pr.offY;
          pr.el.style.left = pr.card.x + 'px';
          pr.el.style.top = pr.card.y + 'px';
        }
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
  const editedPrompt = card.prompt;
  const editedNeg = card.negPrompt;
  const editedSize = card.size;
  const editedRefs = normalizeRefs(card);

  if (card.imageData) {
    card.status = 'done';
    renderCardUpdate(card, el);

    const newCard = {
      id: uid(), projectId: S.projectId, type: 'generate',
      x: card.x + (card.width || 280) + 20, y: card.y,
      width: card.width || 280, prompt: editedPrompt, negPrompt: editedNeg || '',
      size: editedSize || S.defaultSize, imageData: null, status: 'generating',
      refImageData: editedRefs.length ? [...editedRefs] : undefined, createdAt: Date.now(),
    };
    S.cards.push(newCard);
    renderCard(newCard);
    scheduleSave();

    const newEl = document.querySelector(`.sb-card[data-id="${newCard.id}"]`);
    try {
      const imageData = await drawWithFallback(editedPrompt, editedNeg, editedSize, presetId, editedRefs);
      newCard.imageData = imageData;
      newCard.status = 'done';
      renderCardUpdate(newCard, newEl);
      dlImg(imageData);
      toast('生成完成 ✨');
      scheduleSave();
    } catch (err) {
      newCard.status = 'idle';
      renderCardUpdate(newCard, newEl);
      toast(err.message, 'error');
    }
    return;
  }

  card.status = 'generating';
  el = renderCardUpdate(card, el);

  try {
    const imageData = await drawWithFallback(card.prompt, card.negPrompt, card.size, presetId, editedRefs);
    card.imageData = imageData;
    card.status = 'done';
    renderCardUpdate(card, el);
    dlImg(imageData);
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
    const blob = await fetch(refB64s[i]).then(r => r.blob());
    fd.append('image[]', blob, `ref${i}.png`);
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
        if (card.type === 'generate' && card.prompt) {
          const refs = normalizeRefs(card);
          const newCard = {
            id: uid(), projectId: S.projectId, type: 'generate',
            x: card.x + (card.width || 280) + 20, y: card.y,
            width: card.width || 280, prompt: card.prompt, negPrompt: card.negPrompt || '',
            size: card.size || S.defaultSize, imageData: null, status: 'idle',
            refImageData: refs.length ? [...refs] : undefined, createdAt: Date.now(),
          };
          S.cards.push(newCard);
          renderCard(newCard);
          scheduleSave();
          const newEl = document.querySelector(`.sb-card[data-id="${newCard.id}"]`);
          doGenerate(newCard, newEl);
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
      } else if (action === 'add-refs') {
        const refs = S.cards.filter(c => S.selectedIds.includes(c.id) && c.imageData && c.id !== card.id)
          .map(c => c.imageData);
        if (refs.length && card.type === 'generate') {
          card.refImageData = refs;
          card.status = 'idle';
          renderCardUpdate(card, el);
          scheduleSave();
          toast(`已添加 ${refs.length} 张参考图`);
        }
      } else if (action === 'duplicate') {
        const dup = { ...card, id: uid(), x: card.x + 30, y: card.y + 30 };
        S.cards.push(dup);
        renderCard(dup);
        scheduleSave();
      } else if (action === 'download') {
        if (card.imageData) dlImg(card.imageData);
      } else if (action === 'export-pdf') {
        const selCards = S.selectedIds.length > 1
          ? S.cards.filter(c => S.selectedIds.includes(c.id) && c.imageData)
          : card.imageData ? [card] : [];
        if (selCards.length) showPdfPreview(selCards);
        else toast('没有可导出的图片');
      } else if (action === 'delete') {
        deleteCard(card.id);
      }
      hideAllMenus();
    });
  });

  document.getElementById('pdf-close').addEventListener('click', () => {
    document.getElementById('modal-pdf').classList.add('hidden');
  });
  document.getElementById('pdf-export').addEventListener('click', doExportPdf);
  document.getElementById('modal-pdf').addEventListener('click', e => {
    if (e.target.id === 'modal-pdf') e.target.classList.add('hidden');
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
  const selWithImg = S.cards.filter(c => S.selectedIds.includes(c.id) && c.imageData && c.id !== cardId);
  const selCount = selWithImg.length;
  const genBtn = menu.querySelector('[data-action="gen-from"]');
  genBtn.style.display = (card?.imageData || selCount > 0) ? '' : 'none';
  genBtn.textContent = selCount > 1 ? `🎨 以 ${selCount} 张图生图` : '🎨 以此生图';

  const addRefsBtn = menu.querySelector('[data-action="add-refs"]');
  const isTarget = card?.type === 'generate';
  addRefsBtn.style.display = (selCount > 0 && isTarget) ? '' : 'none';

  const pdfBtn = menu.querySelector('[data-action="export-pdf"]');
  const pdfCount = S.selectedIds.length > 1 ? S.cards.filter(c => S.selectedIds.includes(c.id) && c.imageData).length : (card?.imageData ? 1 : 0);
  pdfBtn.style.display = pdfCount > 0 ? '' : 'none';
  pdfBtn.textContent = pdfCount > 1 ? `📄 导出PDF (${pdfCount}张)` : '📄 导出PDF';
  if (selCount > 0) addRefsBtn.textContent = `📌 将 ${selCount} 张图设为参考图`;
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

// ── PDF Export ───────────────────────────────────────────────────
let _pdfCards = [];

function showPdfPreview(cards) {
  const ROW_GAP = 20;
  _pdfCards = cards.slice().sort((a, b) => {
    const rowA = Math.round(a.y / ROW_GAP);
    const rowB = Math.round(b.y / ROW_GAP);
    return rowA !== rowB ? rowA - rowB : a.x - b.x;
  });
  const modal = document.getElementById('modal-pdf');
  const container = document.getElementById('pdf-preview');
  modal.classList.remove('hidden');
  renderPdfThumbs(container);
  document.getElementById('pdf-count').textContent = `共 ${_pdfCards.length} 页`;
}

function renderPdfThumbs(container) {
  container.innerHTML = '';
  _pdfCards.forEach((card, i) => {
    const div = document.createElement('div');
    div.className = 'pdf-thumb';
    div.dataset.idx = i;
    div.draggable = true;
    div.innerHTML = `<span class="pdf-seq">${i + 1}</span><img src="${card.imageData}">`;

    div.addEventListener('dragstart', e => {
      div.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', String(i));
    });
    div.addEventListener('dragend', () => div.classList.remove('dragging'));
    div.addEventListener('dragover', e => { e.preventDefault(); div.classList.add('drag-over'); });
    div.addEventListener('dragleave', () => div.classList.remove('drag-over'));
    div.addEventListener('drop', e => {
      e.preventDefault();
      div.classList.remove('drag-over');
      const from = parseInt(e.dataTransfer.getData('text/plain'));
      const to = parseInt(div.dataset.idx);
      if (from !== to && !isNaN(from) && !isNaN(to)) {
        const [moved] = _pdfCards.splice(from, 1);
        _pdfCards.splice(to, 0, moved);
        renderPdfThumbs(container);
      }
    });
    container.appendChild(div);
  });
}

async function loadJsPdf() {
  if (window.jspdf) return true;
  const cdns = [
    'https://cdn.jsdelivr.net/npm/jspdf@2.5.2/dist/jspdf.umd.min.js',
    'https://unpkg.com/jspdf@2.5.2/dist/jspdf.umd.min.js',
    'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.2/jspdf.umd.min.js',
  ];
  for (const url of cdns) {
    try {
      await new Promise((ok, fail) => {
        const s = document.createElement('script');
        s.src = url;
        s.onload = ok;
        s.onerror = fail;
        document.head.appendChild(s);
      });
      if (window.jspdf) return true;
    } catch {}
  }
  return false;
}

async function doExportPdf() {
  if (!_pdfCards.length) return;
  const btn = document.getElementById('pdf-export');
  if (typeof window.jspdf === 'undefined') {
    btn.disabled = true;
    btn.textContent = '加载中…';
    const ok = await loadJsPdf();
    if (!ok) {
      toast('jsPDF 库加载失败，请检查网络');
      btn.disabled = false;
      btn.textContent = '导出';
      return;
    }
  }
  const { jsPDF } = window.jspdf;
  btn.disabled = true;
  btn.textContent = '生成中…';

  try {
    let doc = null;
    for (let i = 0; i < _pdfCards.length; i++) {
      btn.textContent = `生成中 ${i + 1}/${_pdfCards.length}`;
      const card = _pdfCards[i];
      const imgDim = await getImageDim(card.imageData);
      const isLandscape = imgDim.w > imgDim.h;
      const orient = isLandscape ? 'l' : 'p';

      if (i === 0) {
        doc = new jsPDF({ orientation: orient, unit: 'mm', format: 'a4' });
      } else {
        doc.addPage('a4', orient);
      }

      const pw = doc.internal.pageSize.getWidth();
      const ph = doc.internal.pageSize.getHeight();
      const margin = 5;
      const aw = pw - margin * 2;
      const ah = ph - margin * 2;
      const scale = Math.min(aw / imgDim.w, ah / imgDim.h);
      const dw = imgDim.w * scale;
      const dh = imgDim.h * scale;
      const dx = (pw - dw) / 2;
      const dy = (ph - dh) / 2;
      doc.addImage(card.imageData, 'PNG', dx, dy, dw, dh);
      if (i % 3 === 2) await new Promise(r => setTimeout(r, 0));
    }

    const projectName = document.getElementById('project-name').value || '故事板';
    doc.save(`${projectName}.pdf`);
    toast('PDF 导出成功');
    document.getElementById('modal-pdf').classList.add('hidden');
  } catch (e) {
    console.error('PDF export error:', e);
    toast('导出失败: ' + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '导出';
  }
}

function getImageDim(dataUrl) {
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = () => resolve({ w: 1024, h: 1024 });
    img.src = dataUrl;
  });
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

// ── Master API (创作助手 LLM) ────────────────────────────────────
async function callMaster(messages) {
  if (!S.masterPresets.length) throw new Error('请先在画图台设置里添加大师API预设');
  const presets = S.masterPresets;
  let startIdx = presets.findIndex(p => p.id === S.curMasterId);
  if (startIdx < 0) startIdx = 0;
  let lastErr;
  for (let i = 0; i < presets.length; i++) {
    const preset = presets[(startIdx + i) % presets.length];
    if (i > 0 && preset.skipFallback) continue;
    try {
      if (i > 0) toast(`助手切到"${preset.name}"...`, 'warn');
      return await _callMasterWithPreset(preset, messages);
    } catch (err) { lastErr = err; if (presets.length > 1) console.warn(`[${ts()}] 助手预设"${preset.name}"失败:`, err.message); }
  }
  throw lastErr || new Error('所有大师预设均失败');
}

async function _callMasterWithPreset(preset, messages) {
  const { key, url, model } = preset;
  if (!key) throw new Error(`预设"${preset.name}"未配置API Key`);
  const base = (url || 'https://api.anthropic.com/v1').replace(/\/$/, '');
  const isAnthropic = base.includes('anthropic.com');
  const _fetch = async (targetUrl, opts) => {
    try { return await fetch(targetUrl, opts); } catch (e) {
      if (!S.localServer) throw e;
      console.log(`[agent] 直连失败(${e.message})，走本地代理重试`);
      const h = { ...opts.headers, 'X-Real-Target': targetUrl, 'X-Real-Key': key };
      delete h['Authorization']; delete h['x-api-key'];
      return fetch(`${S.localServer}/api/llm-proxy`, { ...opts, headers: h });
    }
  };
  if (isAnthropic) {
    const sys = messages.find(m => m.role === 'system');
    const msgs = messages.filter(m => m.role !== 'system');
    const r = await _fetch(`${base}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: model || 'claude-opus-4-7', system: sys?.content || '', messages: msgs, max_tokens: 4096 })
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`);
    const d = await r.json(); return d.content?.[0]?.text || '';
  }
  const toOAI = content => {
    if (!Array.isArray(content)) return content;
    return content.map(b => b.type === 'image' && b.source?.type === 'base64'
      ? { type: 'image_url', image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` } }
      : b);
  };
  const oaiMsgs = messages.map(m => ({ ...m, content: toOAI(m.content) }));
  const r = await _fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
    body: JSON.stringify({ model: model || 'claude-opus-4-7', messages: oaiMsgs, stream: false })
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`);
  const d = await r.json(); return d.choices?.[0]?.message?.content || '';
}

// ── Agent Chat Persistence ──────────────────────────────────────
function stripImagesFromHistory(history) {
  return history.map(m => {
    if (Array.isArray(m.content)) {
      const textParts = m.content.filter(b => b.type === 'text');
      return { ...m, content: textParts.length === 1 ? textParts[0].text : textParts };
    }
    return m;
  });
}

async function saveAgentChat() {
  if (!S.projectId) return;
  const stripped = stripImagesFromHistory(S.agentHistory);
  await db.put('settings', { key: `agentChat_${S.projectId}`, value: stripped });
}

async function loadAgentChat() {
  if (!S.projectId) return;
  const rec = await db.get('settings', `agentChat_${S.projectId}`);
  if (!rec?.value?.length) return;
  S.agentHistory = rec.value;
  const msgBox = document.getElementById('agent-messages');
  const welcome = msgBox.querySelector('.agent-welcome');
  if (welcome) welcome.remove();
  for (const msg of S.agentHistory) {
    const el = document.createElement('div');
    el.className = `agent-msg ${msg.role === 'user' ? 'user' : 'assistant'}`;
    const text = typeof msg.content === 'string' ? msg.content
      : Array.isArray(msg.content)
        ? msg.content.filter(b => b.type === 'text').map(b => b.text).join('\n')
        : msg.content;
    if (msg.role === 'assistant') {
      const { cleanText } = parseCardsFromReply(text);
      el.textContent = cleanText;
    } else {
      el.textContent = text;
    }
    msgBox.appendChild(el);
  }
  msgBox.scrollTop = msgBox.scrollHeight;
}

// ── Creative Agent ──────────────────────────────────────────────
const AGENT_SYSTEM = () => `你是故事板创作助手。帮用户规划分镜、写画面描述、生成图片prompt。

规则：
1. 用中文交流，但 image prompt 必须用英文
2. 当你要创建卡片时，在回复末尾输出一个 JSON 块，格式如下（不要加 markdown 代码块标记）：
<<<CARDS
[{"prompt":"english image prompt","size":"1024x1024","neg":"optional negative prompt"}]
CARDS>>>
3. prompt 要具体详细：包含主体、动作、表情、构图、光影、氛围、风格关键词
4. 如果用户想要分镜，规划3-6个镜头，每个创建一张卡片
5. 如果用户发来图片，分析画面内容并给出建议或续写分镜
6. 不要解释 prompt 语法，直接给出可用的 prompt
7. 每张卡片的 prompt 是独立的完整描述，不要引用"同上"

可用尺寸：${SB_SIZES.map(s => s.v).join(', ')}
默认尺寸：${S.defaultSize}`;

function buildCanvasContext() {
  const cards = S.cards.filter(c => c.type !== 'text');
  if (!cards.length) return '';
  const lines = cards.map((c, i) => {
    const sel = S.selectedIds.includes(c.id) ? ' [选中]' : '';
    if (c.status === 'done') return `${i + 1}. [已生成] "${c.prompt || '无prompt'}" ${c.size || ''}${sel}`;
    return `${i + 1}. [待生成] "${c.prompt || '无prompt'}" ${c.size || ''}${sel}`;
  });
  const textCards = S.cards.filter(c => c.type === 'text' && c.text?.trim());
  if (textCards.length) lines.push('', '文本卡片：', ...textCards.map(c => `- "${c.text}"`));
  return '\n\n当前画布上的卡片：\n' + lines.join('\n');
}

function parseCardsFromReply(text) {
  const m = text.match(/<?<?<?CARDS\s*([\s\S]*?)\s*CARDS>?>?>?/);
  if (!m) return { cleanText: text, cards: [] };
  try {
    const cards = JSON.parse(m[1]);
    const cleanText = text.replace(/<?<?<?CARDS[\s\S]*?CARDS>?>?>?/, '').trim();
    return { cleanText, cards: Array.isArray(cards) ? cards : [] };
  } catch { return { cleanText: text, cards: [] }; }
}

function compressImage(dataUrl, maxPx = 1024) {
  return new Promise(res => {
    const img = new Image();
    img.onload = () => {
      let { width: w, height: h } = img;
      if (w > maxPx || h > maxPx) {
        const scale = maxPx / Math.max(w, h);
        w = Math.round(w * scale); h = Math.round(h * scale);
      }
      const cv = document.createElement('canvas');
      cv.width = w; cv.height = h;
      cv.getContext('2d').drawImage(img, 0, 0, w, h);
      res(cv.toDataURL('image/jpeg', 0.8));
    };
    img.src = dataUrl;
  });
}

async function agentSend() {
  const input = document.getElementById('agent-input');
  const text = input.value.trim();
  if (!text) return;
  input.value = '';

  const msgBox = document.getElementById('agent-messages');
  const welcome = msgBox.querySelector('.agent-welcome');
  if (welcome) welcome.remove();

  // user bubble
  const userEl = document.createElement('div');
  userEl.className = 'agent-msg user';
  userEl.textContent = text;
  msgBox.appendChild(userEl);

  // build user message content (with optional images)
  let userContent;
  if (S.agentAttachedImages.length) {
    const blocks = [];
    for (const dataUrl of S.agentAttachedImages) {
      const compressed = await compressImage(dataUrl);
      const [, mime, b64] = compressed.match(/^data:(.*?);base64,(.*)$/);
      blocks.push({ type: 'image', source: { type: 'base64', media_type: mime, data: b64 } });
    }
    blocks.push({ type: 'text', text: text });
    userContent = blocks;
    clearAgentRefs();
  } else {
    userContent = text;
  }

  S.agentHistory.push({ role: 'user', content: userContent });
  saveAgentChat();

  // typing indicator
  const typing = document.createElement('div');
  typing.className = 'agent-typing';
  typing.innerHTML = '<div class="agent-typing-dots"><span></span><span></span><span></span></div>';
  msgBox.appendChild(typing);
  msgBox.scrollTop = msgBox.scrollHeight;

  try {
    const canvasCtx = buildCanvasContext();
    const sysContent = AGENT_SYSTEM() + canvasCtx;
    const recent = S.agentHistory.slice(-20);
    const messages = [{ role: 'system', content: sysContent }, ...recent];
    const reply = await callMaster(messages);

    typing.remove();

    const { cleanText, cards } = parseCardsFromReply(reply);
    S.agentHistory.push({ role: 'assistant', content: reply });
    saveAgentChat();

    // assistant bubble
    const aiEl = document.createElement('div');
    aiEl.className = 'agent-msg assistant';
    aiEl.textContent = cleanText;

    // create cards on canvas
    if (cards.length) {
      const selRefs = S.cards.filter(c => S.selectedIds.includes(c.id) && c.imageData).map(c => c.imageData);
      const agentRefs = S.agentAttachedImages.length ? [...S.agentAttachedImages] : [];
      const autoRefs = selRefs.length ? selRefs : agentRefs.length ? agentRefs : null;

      const createdIds = [];
      const wrap = document.getElementById('canvas-wrap');
      const cx = (-S.panX + wrap.clientWidth / 2) / S.zoom;
      const cy = (-S.panY + wrap.clientHeight / 2) / S.zoom;
      const totalW = cards.length * 300;
      let startX = cx - totalW / 2;

      for (const c of cards) {
        const card = {
          id: uid(), projectId: S.projectId, type: 'generate',
          x: startX, y: cy + 60, width: 280,
          prompt: c.prompt || '', negPrompt: c.neg || '', size: c.size || S.defaultSize,
          imageData: null, status: 'idle', createdAt: Date.now(),
          ...(autoRefs ? { refImageData: autoRefs } : {}),
        };
        S.cards.push(card);
        const el = document.createElement('div');
        el.className = 'sb-card';
        el.dataset.id = card.id;
        el.style.cssText = `left:${card.x}px;top:${card.y}px;width:${card.width}px`;
        document.getElementById('canvas').appendChild(el);
        renderCardUpdate(card, el);
        createdIds.push(card.id);
        startX += 300;
      }
      scheduleSave();
      if (autoRefs) toast(`已自动附加 ${autoRefs.length} 张参考图`);

      const info = document.createElement('div');
      info.className = 'agent-cards-info';
      info.innerHTML = `已创建 ${cards.length} 张卡片：` +
        cards.map((c, i) => `<div class="card-preview">${i + 1}. ${c.prompt.slice(0, 50)}${c.prompt.length > 50 ? '…' : ''}</div>`).join('');
      const genBtn = document.createElement('button');
      genBtn.className = 'agent-auto-gen';
      genBtn.textContent = `🎨 一键生图（${cards.length}张）`;
      genBtn.onclick = () => {
        genBtn.disabled = true;
        genBtn.textContent = '生成中...';
        for (const cid of createdIds) {
          const card = S.cards.find(c => c.id === cid);
          const el = document.querySelector(`.sb-card[data-id="${cid}"]`);
          if (card && el && card.status === 'idle') doGenerate(card, el);
        }
      };
      info.appendChild(genBtn);
      aiEl.appendChild(info);
    }

    msgBox.appendChild(aiEl);
  } catch (err) {
    typing.remove();
    const errEl = document.createElement('div');
    errEl.className = 'agent-msg assistant';
    errEl.style.color = 'var(--err)';
    errEl.textContent = '出错了：' + err.message;
    msgBox.appendChild(errEl);
  }
  msgBox.scrollTop = msgBox.scrollHeight;
}

function toggleAgentPanel() {
  const panel = document.getElementById('agent-panel');
  const wrap = document.getElementById('canvas-wrap');
  const fab = document.getElementById('fab-agent');
  const isOpen = panel.classList.contains('visible');
  if (isOpen) {
    panel.classList.remove('visible');
    panel.classList.add('hidden');
    wrap.classList.remove('agent-open');
    fab.classList.remove('active');
  } else {
    panel.classList.remove('hidden');
    panel.classList.add('visible');
    wrap.classList.add('agent-open');
    fab.classList.add('active');
    document.getElementById('agent-input').focus();
  }
}

function attachAgentRefs() {
  const selected = S.cards.filter(c => S.selectedIds.includes(c.id) && c.imageData);
  if (!selected.length) { toast('先在画布上选中有图片的卡片', 'warn'); return; }
  S.agentAttachedImages = selected.map(c => c.imageData);
  const bar = document.getElementById('agent-ref-bar');
  bar.innerHTML = `<span class="ref-label">参考图 ×${selected.length}</span>`;
  selected.forEach((c, i) => {
    const item = document.createElement('span');
    item.className = 'ref-item';
    item.innerHTML = `<img src="${c.imageData}"><button class="ref-remove" data-idx="${i}">✕</button>`;
    bar.appendChild(item);
  });
  bar.classList.remove('hidden');
  document.getElementById('agent-attach').classList.add('has-refs');
  bar.querySelectorAll('.ref-remove').forEach(btn => {
    btn.onclick = () => {
      const idx = +btn.dataset.idx;
      S.agentAttachedImages.splice(idx, 1);
      if (!S.agentAttachedImages.length) clearAgentRefs();
      else attachAgentRefs();
    };
  });
}

function clearAgentRefs() {
  S.agentAttachedImages = [];
  const bar = document.getElementById('agent-ref-bar');
  bar.innerHTML = '';
  bar.classList.add('hidden');
  document.getElementById('agent-attach').classList.remove('has-refs');
}

function clearAgentChat() {
  S.agentHistory = [];
  clearAgentRefs();
  if (S.projectId) db.del('settings', `agentChat_${S.projectId}`);
  const msgBox = document.getElementById('agent-messages');
  msgBox.innerHTML = '<div class="agent-welcome">描述你的创作想法，我来帮你规划分镜、写prompt、生成图片 ✨</div>';
}

function initAgent() {
  document.getElementById('fab-agent').onclick = toggleAgentPanel;
  document.getElementById('agent-close').onclick = toggleAgentPanel;
  document.getElementById('agent-clear').onclick = clearAgentChat;
  document.getElementById('agent-attach').onclick = attachAgentRefs;
  document.getElementById('agent-send').onclick = agentSend;
  document.getElementById('agent-input').addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); agentSend(); }
  });
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
