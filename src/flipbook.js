// ── Flipbook.js — 故事书架 + 翻页阅读器 ─────────────────────────

// ── DB（复用 StoryboardDB v2）────────────────────────────────────
class SBDatabase {
  constructor() { this.db = null; }
  open() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('StoryboardDB', 2);
      r.onupgradeneeded = e => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('projects')) db.createObjectStore('projects', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('cards')) {
          const s = db.createObjectStore('cards', { keyPath: 'id' });
          s.createIndex('byProject', 'projectId', { unique: false });
        }
        if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings', { keyPath: 'key' });
        if (!db.objectStoreNames.contains('stories')) {
          const s = db.createObjectStore('stories', { keyPath: 'id' });
          s.createIndex('byProject', 'projectId', { unique: false });
        }
      };
      r.onsuccess = e => { this.db = e.target.result; res(); };
      r.onerror = e => rej(e.target.error);
    });
  }
  _tx(s, m = 'readonly') { return this.db.transaction(s, m).objectStore(s); }
  _p(r) { return new Promise((res, rej) => { r.onsuccess = e => res(e.target.result); r.onerror = e => rej(e.target.error); }); }
  all(s) { return this._p(this._tx(s).getAll()); }
  get(s, k) { return this._p(this._tx(s).get(k)); }
  put(s, o) { return this._p(this._tx(s, 'readwrite').put(o)); }
  del(s, k) { return this._p(this._tx(s, 'readwrite').delete(k)); }
  byIndex(store, idx, val) { return this._p(this._tx(store).index(idx).getAll(val)); }
}

const db = new SBDatabase();

// ── 状态 ─────────────────────────────────────────────────────────
const F = {
  books: [],           // [{id, name, type:'project'|'story', coverImage, pageCount, updatedAt, projectId?}]
  currentBook: null,
  currentType: null,   // 'project' or 'story'
  pages: [],           // sorted image cards
  currentPage: 0,
  totalPages: 0,
  isFlipping: false,
  // 设置
  layout: 'double',
  numLeaves: 0,
  orientation: 'auto',
  flipSpeed: 600,
  autoplay: false,
  autoInterval: 3,
  darkMode: true,
  musicVolume: 0.5,
};

const SPINE_COLORS = [
  '#8b5cf6', '#ec4899', '#06b6d4', '#10b981',
  '#f59e0b', '#ef4444', '#6366f1', '#14b8a6',
  '#f97316', '#a855f7', '#3b82f6', '#84cc16',
];
const ROW_GAP = 20;
const PREFS_KEY = 'flipbook_prefs';

// ── 工具函数 ─────────────────────────────────────────────────────
function $(id) { return document.getElementById(id); }
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 2200);
}

function sortCardsByPosition(cards) {
  return cards.slice().sort((a, b) => {
    const rowA = Math.round(a.y / ROW_GAP);
    const rowB = Math.round(b.y / ROW_GAP);
    return rowA !== rowB ? rowA - rowB : a.x - b.x;
  });
}

function savePrefs() {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({
      layout: F.layout, orientation: F.orientation,
      flipSpeed: F.flipSpeed, autoInterval: F.autoInterval,
      darkMode: F.darkMode, musicVolume: F.musicVolume,
    }));
  } catch {}
}

function loadPrefs() {
  try {
    const s = JSON.parse(localStorage.getItem(PREFS_KEY));
    if (s) {
      if (s.layout) F.layout = s.layout;
      if (s.orientation) F.orientation = s.orientation;
      if (s.flipSpeed) F.flipSpeed = s.flipSpeed;
      if (s.autoInterval) F.autoInterval = s.autoInterval;
      if (typeof s.darkMode === 'boolean') F.darkMode = s.darkMode;
      if (typeof s.musicVolume === 'number') F.musicVolume = s.musicVolume;
    }
  } catch {}
}

function applyDarkMode() {
  document.documentElement.classList.toggle('dark', F.darkMode);
  document.documentElement.classList.toggle('light', !F.darkMode);
  const btn = $('btn-dark');
  if (btn) btn.textContent = F.darkMode ? '☀️' : '🌙';
}

// ── 初始化 ───────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  loadPrefs();
  applyDarkMode();

  try {
    await db.open();
  } catch (e) {
    toast('数据库打开失败');
    console.error(e);
    return;
  }

  await loadAllBooks();
  renderBookshelf();

  // 事件绑定
  $('btn-dark').onclick = () => { F.darkMode = !F.darkMode; applyDarkMode(); savePrefs(); };
  $('btn-back-shelf').onclick = closeBook;
  $('btn-controls').onclick = toggleControls;
  $('ctrl-close').onclick = toggleControls;
  $('controls-overlay').onclick = toggleControls;
  $('btn-fullscreen').onclick = toggleFullscreen;
  $('flip-prev').onclick = () => flipPrev();
  $('flip-next').onclick = () => flipNext();

  initControls();
  initKeyboard();
  initTouch();
  window.addEventListener('resize', onResize);

  // URL参数直接打开
  const params = new URLSearchParams(location.search);
  const storyId = params.get('story');
  const projectId = params.get('project');
  if (storyId) openStory(storyId);
  else if (projectId) openProject(projectId);
});

// ══════════════════════════════════════════════════════════════════
//  书架模块
// ══════════════════════════════════════════════════════════════════

async function loadAllBooks() {
  const result = [];

  // 加载项目（完整画布）
  const projects = await db.all('projects');
  for (const proj of projects) {
    if (proj.id === '__ASSETS__') continue; // 跳过资产库
    const cards = await db.byIndex('cards', 'byProject', proj.id);
    const imageCards = cards.filter(c => c.imageData && c.type === 'generate' && c.status === 'done');
    if (!imageCards.length) continue;

    const sorted = sortCardsByPosition(imageCards);
    result.push({
      id: proj.id,
      type: 'project',
      name: proj.name || '未命名故事',
      coverImage: sorted[0].imageData,
      pageCount: sorted.length,
      updatedAt: proj.updatedAt || proj.createdAt || 0,
    });
  }

  // 加载故事书（导出的精选）
  const stories = await db.all('stories');
  for (const story of stories) {
    const proj = await db.get('projects', story.projectId);
    if (!proj) continue;

    const allCards = await db.byIndex('cards', 'byProject', story.projectId);
    const storyCards = story.cardIds.map(id => allCards.find(c => c.id === id)).filter(c => c && c.imageData);
    if (!storyCards.length) continue;

    result.push({
      id: story.id,
      type: 'story',
      name: story.name || '未命名故事书',
      coverImage: storyCards[0].imageData,
      pageCount: storyCards.length,
      updatedAt: story.createdAt || 0,
      projectId: story.projectId,
      projectName: proj.name,
    });
  }

  // 按更新时间倒序
  result.sort((a, b) => b.updatedAt - a.updatedAt);
  F.books = result;
}

function renderBookshelf() {
  const container = $('shelf-container');
  const empty = $('shelf-empty');

  if (!F.books.length) {
    container.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');

  // 每行放一排书，不固定数量，用CSS grid自适应
  let html = '<div class="shelf-row"><div class="shelf-books">';
  F.books.forEach((book, i) => {
    const spineColor = SPINE_COLORS[i % SPINE_COLORS.length];
    const icon = book.type === 'story' ? '📚' : '🎬';
    const subtitle = book.type === 'story' ? `来自：${escHtml(book.projectName)}` : '';
    html += `
      <div class="book-item ${book.type === 'story' ? 'story-book' : ''}" data-id="${book.id}" data-type="${book.type}" onclick="onBookClick(this,'${book.id}','${book.type}')">
        <div class="book-body">
          <div class="book-cover" style="background-image:url('${book.coverImage}')"></div>
          <div class="book-spine" style="background:linear-gradient(90deg,${spineColor},${spineColor}dd)">${icon} ${escHtml(book.name)}</div>
          <div class="book-pages"></div>
          <div class="book-badge">${book.pageCount}</div>
        </div>
        <div class="book-label">${escHtml(book.name)}${subtitle ? `<br><small style="opacity:0.6;font-size:11px">${subtitle}</small>` : ''}</div>
      </div>`;
  });
  html += '</div></div>';
  container.innerHTML = html;
}

function escHtml(s) {
  return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// 书本点击
async function onBookClick(el, projectId) {
  el.classList.add('opening');
  await new Promise(r => setTimeout(r, 450));
  await openBook(projectId);
}

// ══════════════════════════════════════════════════════════════════
//  翻页阅读器
// ══════════════════════════════════════════════════════════════════

function onBookClick(el, id, type) {
  el.classList.add('book-opening');
  setTimeout(() => {
    if (type === 'story') openStory(id);
    else openProject(id);
  }, 300);
}

async function openProject(projectId) {
  const project = await db.get('projects', projectId);
  if (!project) { toast('找不到这个项目'); return; }

  const allCards = await db.byIndex('cards', 'byProject', projectId);
  const imageCards = allCards.filter(c => c.imageData && c.type === 'generate' && c.status === 'done');
  if (!imageCards.length) { toast('这本书还没有图片'); return; }

  const sorted = sortCardsByPosition(imageCards);
  F.pages = sorted;
  F.currentBook = project;
  F.currentType = 'project';
  F.currentPage = 0;
  F.totalPages = sorted.length;
  F.numLeaves = Math.ceil(sorted.length / 2);

  // 切换视图
  $('bookshelf-view').classList.add('hidden');
  $('flipbook-view').classList.remove('hidden');
  $('flip-title').textContent = project.name || '故事';

  renderFlipbook();
  updatePageIndicator();
  updateNavButtons();

  // 预加载图片
  preloadImages(0, Math.min(5, F.pages.length));
}

async function openStory(storyId) {
  const story = await db.get('stories', storyId);
  if (!story) { toast('找不到这个故事书'); return; }

  const allCards = await db.byIndex('cards', 'byProject', story.projectId);
  const storyCards = story.cardIds.map(id => allCards.find(c => c.id === id)).filter(c => c && c.imageData);
  if (!storyCards.length) { toast('故事书没有图片'); return; }

  F.pages = storyCards;
  F.currentBook = story;
  F.currentType = 'story';
  F.currentPage = 0;
  F.totalPages = storyCards.length;
  F.numLeaves = Math.ceil(storyCards.length / 2);

  // 切换视图
  $('bookshelf-view').classList.add('hidden');
  $('flipbook-view').classList.remove('hidden');
  $('flip-title').textContent = story.name || '故事';

  renderFlipbook();
  updatePageIndicator();
  updateNavButtons();

  // 预加载图片
  preloadImages(0, Math.min(5, F.pages.length));
}

function closeBook() {
  stopAutoplay();
  $('flipbook-view').classList.add('hidden');
  $('bookshelf-view').classList.remove('hidden');
  hideControls();

  // 恢复书架（去掉 opening 动画）
  document.querySelectorAll('.book-item.opening').forEach(el => el.classList.remove('opening'));

  // 暂停音乐
  const audio = $('bg-music');
  if (!audio.paused) audio.pause();

  F.currentProject = null;
  F.pages = [];
}

// ── 渲染翻页书 ───────────────────────────────────────────────────
function renderFlipbook() {
  const book = $('flip-book');
  book.innerHTML = '';
  book.className = '';

  const dim = calculateDimensions();
  book.style.width = dim.width + 'px';
  book.style.height = dim.height + 'px';

  if (F.layout === 'single') {
    book.classList.add('single-mode');
    renderSinglePages(book);
  } else {
    book.classList.add('double-mode');
    renderDoublePages(book);
  }

  // 设置翻页速度CSS变量
  document.documentElement.style.setProperty('--flip-speed', (F.flipSpeed / 1000) + 's');

  updatePageIndicator();
  updateNavButtons();
}

// ── 单页模式：卡片翻转，一次看一张图，居中 ──────────────────────
function renderSinglePages(book) {
  const total = F.pages.length;

  for (let i = 0; i < total; i++) {
    const leaf = document.createElement('div');
    leaf.className = 'flip-page';
    leaf.dataset.index = i;
    leaf.style.zIndex = total - i;

    // 正面：当前页图片
    const front = document.createElement('div');
    front.className = 'page-front';
    front.innerHTML = `
      <div class="page-content"><img src="${F.pages[i].imageData}" alt="" loading="lazy"></div>
      <div class="page-number">${i + 1}</div>`;

    // 背面：下一页图片（翻转动画过渡用）
    const back = document.createElement('div');
    back.className = 'page-back';
    if (i + 1 < total) {
      back.innerHTML = `
        <div class="page-content"><img src="${F.pages[i + 1].imageData}" alt="" loading="lazy"></div>
        <div class="page-number">${i + 2}</div>`;
    } else {
      back.innerHTML = '<div class="page-content page-blank">— 完 —</div>';
    }

    leaf.appendChild(front);
    leaf.appendChild(back);

    if (i < F.currentPage) {
      leaf.classList.add('flipped');
      leaf.style.zIndex = i;
    }

    leaf.addEventListener('transitionend', () => {
      F.isFlipping = false;
      updateNavButtons();
    });

    book.appendChild(leaf);
  }

  // 点击翻页：左半=上一页，右半=下一页
  book.onclick = e => {
    const rect = book.getBoundingClientRect();
    if (e.clientX - rect.left < rect.width / 2) flipPrev();
    else flipNext();
  };
}

// ── 双页模式：书籍展开，两两配对叶子 ────────────────────────────
function renderDoublePages(book) {
  const N = F.pages.length;
  const numLeaves = F.numLeaves;

  for (let j = 0; j < numLeaves; j++) {
    const frontIdx = j * 2;       // 右页图片
    const backIdx  = j * 2 + 1;   // 左页图片（翻过去后可见）

    const leaf = document.createElement('div');
    leaf.className = 'flip-page';
    leaf.dataset.index = j;
    leaf.style.zIndex = numLeaves - j;

    // 正面（未翻时在右侧可见）
    const front = document.createElement('div');
    front.className = 'page-front';
    front.innerHTML = `
      <div class="page-content"><img src="${F.pages[frontIdx].imageData}" alt="" loading="lazy"></div>
      <div class="page-number">${frontIdx + 1}</div>`;

    // 背面（翻过后在左侧可见）
    const back = document.createElement('div');
    back.className = 'page-back';
    if (backIdx < N) {
      back.innerHTML = `
        <div class="page-content"><img src="${F.pages[backIdx].imageData}" alt="" loading="lazy"></div>
        <div class="page-number">${backIdx + 1}</div>`;
    } else {
      back.innerHTML = '<div class="page-content page-blank">— 完 —</div>';
    }

    leaf.appendChild(front);
    leaf.appendChild(back);

    if (j < F.currentPage) {
      leaf.classList.add('flipped');
      leaf.style.zIndex = j;
    }

    leaf.addEventListener('transitionend', () => {
      F.isFlipping = false;
      updateNavButtons();
    });

    book.appendChild(leaf);
  }

  // 点击翻页：左半=上一页，右半=下一页
  book.onclick = e => {
    const rect = book.getBoundingClientRect();
    if (e.clientX - rect.left < rect.width / 2) flipPrev();
    else flipNext();
  };
}

// ── 计算书本尺寸 ─────────────────────────────────────────────────
function calculateDimensions() {
  const stage = $('flip-stage');
  const stageW = stage.clientWidth - 30;
  const stageH = stage.clientHeight - 20;

  // 先算单页尺寸
  let pageW, pageH;

  if (F.orientation === 'landscape') {
    pageH = stageH;
    pageW = pageH * 1.5;
  } else if (F.orientation === 'portrait') {
    pageH = stageH;
    pageW = pageH / 1.5;
  } else {
    // 自动：根据第一张图的比例
    const first = F.pages[0];
    const sizeStr = (first && first.size) || '';
    const match = sizeStr.match(/(\d+)x(\d+)/);
    if (match) {
      const aspect = parseInt(match[1]) / parseInt(match[2]);
      pageH = stageH;
      pageW = pageH * aspect;
    } else {
      pageH = stageH;
      pageW = pageH * 0.75; // 默认 3:4
    }
  }

  // 双页=2倍页宽（书籍展开），单页=1倍
  let w = F.layout === 'double' ? pageW * 2 : pageW;
  let h = pageH;

  // 确保不超出舞台
  if (w > stageW) { const s = stageW / w; w *= s; h *= s; }
  if (h > stageH) { const s = stageH / h; w *= s; h *= s; }

  return { width: Math.round(w), height: Math.round(h) };
}

// ── 翻页核心 ─────────────────────────────────────────────────────
function _maxPage() {
  return F.layout === 'double' ? F.numLeaves : F.pages.length - 1;
}

function flipNext() {
  if (F.isFlipping || F.currentPage >= _maxPage()) return;
  flipTo(F.currentPage + 1);
}

function flipPrev() {
  if (F.isFlipping || F.currentPage <= 0) return;
  flipTo(F.currentPage - 1);
}

function flipTo(targetPage, animated = true) {
  const max = _maxPage();
  if (targetPage < 0 || targetPage > max) return;
  if (targetPage === F.currentPage) return;

  const book = $('flip-book');
  const leaves = book.querySelectorAll('.flip-page');
  const total = leaves.length;

  if (!animated) {
    F.currentPage = targetPage;
    leaves.forEach((leaf, i) => {
      if (i < targetPage) {
        leaf.classList.add('flipped');
        leaf.style.zIndex = i;
      } else {
        leaf.classList.remove('flipped');
        leaf.style.zIndex = total - i;
      }
    });
    updatePageIndicator();
    updateNavButtons();
    return;
  }

  const forward = targetPage > F.currentPage;
  F.isFlipping = true;

  if (forward) {
    const leaf = leaves[F.currentPage];
    if (!leaf) { F.isFlipping = false; return; }
    leaf.style.zIndex = total + 1;
    leaf.classList.add('flipped');
    setTimeout(() => {
      leaf.style.zIndex = F.currentPage;
      const nextLeaf = leaves[targetPage];
      if (nextLeaf) nextLeaf.style.zIndex = total - targetPage;
    }, F.flipSpeed);
  } else {
    const leaf = leaves[targetPage];
    if (!leaf) { F.isFlipping = false; return; }
    leaf.style.zIndex = total + 1;
    leaf.classList.remove('flipped');
    setTimeout(() => {
      leaf.style.zIndex = total - targetPage;
    }, F.flipSpeed);
  }

  F.currentPage = targetPage;
  updatePageIndicator();

  // 预加载
  const preStart = F.layout === 'double' ? Math.max(0, targetPage * 2 - 2) : Math.max(0, targetPage - 1);
  const preEnd = F.layout === 'double' ? Math.min(F.pages.length, targetPage * 2 + 6) : Math.min(F.pages.length, targetPage + 4);
  preloadImages(preStart, preEnd);
}

function updatePageIndicator() {
  const N = F.pages.length;
  let text;
  if (F.layout === 'double') {
    const k = F.currentPage;
    if (k === 0) {
      text = `1 / ${N}`;
    } else if (k >= F.numLeaves) {
      text = `${N} / ${N}`;
    } else {
      const rightPage = Math.min(k * 2 + 1, N);
      text = `${k * 2}~${rightPage} / ${N}`;
    }
  } else {
    text = `${F.currentPage + 1} / ${N}`;
  }
  $('page-indicator').textContent = text;
}

function updateNavButtons() {
  $('flip-prev').disabled = F.currentPage <= 0;
  $('flip-next').disabled = F.currentPage >= _maxPage();
}

// ── 图片预加载 ───────────────────────────────────────────────────
const _preloaded = new Set();
function preloadImages(start, end) {
  for (let i = start; i < end && i < F.pages.length; i++) {
    if (_preloaded.has(i)) continue;
    const img = new Image();
    img.src = F.pages[i].imageData;
    _preloaded.add(i);
  }
}

// ══════════════════════════════════════════════════════════════════
//  控制面板
// ══════════════════════════════════════════════════════════════════

function initControls() {
  // 布局
  const layoutBtns = $('ctrl-layout').querySelectorAll('button');
  layoutBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const val = btn.dataset.val;
      if (val === F.layout) return;
      layoutBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      // 切换模式时把当前图片位置转换过来
      const oldLayout = F.layout;
      F.layout = val;
      if (oldLayout === 'single' && val === 'double') {
        // 单页→双页：图片索引→展开索引
        F.currentPage = Math.floor(F.currentPage / 2);
      } else if (oldLayout === 'double' && val === 'single') {
        // 双页→单页：展开索引→图片索引
        F.currentPage = Math.min(F.currentPage * 2, F.pages.length - 1);
      }
      savePrefs();
      if (F.currentProject) renderFlipbook();
    });
  });

  // 方向
  const orientBtns = $('ctrl-orient').querySelectorAll('button');
  orientBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const val = btn.dataset.val;
      if (val === F.orientation) return;
      orientBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      F.orientation = val;
      savePrefs();
      if (F.currentProject) renderFlipbook();
    });
  });

  // 翻页速度
  const speedSlider = $('ctrl-flip-speed');
  const speedLabel = $('flip-speed-label');
  speedSlider.value = F.flipSpeed;
  speedLabel.textContent = (F.flipSpeed / 1000).toFixed(1) + 's';
  speedSlider.addEventListener('input', () => {
    F.flipSpeed = parseInt(speedSlider.value);
    speedLabel.textContent = (F.flipSpeed / 1000).toFixed(1) + 's';
    document.documentElement.style.setProperty('--flip-speed', (F.flipSpeed / 1000) + 's');
    savePrefs();
  });

  // 自动翻页间隔
  const intervalSlider = $('ctrl-interval');
  const intervalLabel = $('interval-label');
  intervalSlider.value = F.autoInterval;
  intervalLabel.textContent = F.autoInterval + 's';
  intervalSlider.addEventListener('input', () => {
    F.autoInterval = parseFloat(intervalSlider.value);
    intervalLabel.textContent = F.autoInterval + 's';
    savePrefs();
    if (F.autoplay) { stopAutoplay(); startAutoplay(); }
  });

  // 自动翻页按钮
  $('btn-autoplay').onclick = toggleAutoplay;

  // 音乐上传
  $('btn-upload-music').onclick = () => $('music-upload').click();
  $('music-upload').addEventListener('change', e => {
    const file = e.target.files[0];
    if (file) loadMusic(file);
  });

  // 音乐播放/暂停
  $('btn-music-toggle').onclick = toggleMusic;

  // 音量
  const volSlider = $('ctrl-volume');
  volSlider.value = F.musicVolume;
  volSlider.addEventListener('input', () => {
    F.musicVolume = parseFloat(volSlider.value);
    $('bg-music').volume = F.musicVolume;
    savePrefs();
  });

  // 恢复控制面板状态
  syncControlsUI();

  // 检查移动端禁用双页
  checkMobileLayout();
}

function syncControlsUI() {
  // 同步布局按钮
  $('ctrl-layout').querySelectorAll('button').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.val === F.layout);
  });
  // 同步方向按钮
  $('ctrl-orient').querySelectorAll('button').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.val === F.orientation);
  });
}

function checkMobileLayout() {
  const w = window.innerWidth;
  const doubleBtn = $('ctrl-layout').querySelector('[data-val="double"]');
  if (w < 768) {
    doubleBtn.disabled = true;
    if (F.layout === 'double') {
      F.layout = 'single';
      syncControlsUI();
      if (F.currentProject) renderFlipbook();
    }
  } else {
    doubleBtn.disabled = false;
  }
}

function toggleControls() {
  const panel = $('controls-panel');
  const overlay = $('controls-overlay');
  const isHidden = panel.classList.contains('hidden');
  panel.classList.toggle('hidden', !isHidden);
  overlay.classList.toggle('hidden', !isHidden);
}

function hideControls() {
  $('controls-panel').classList.add('hidden');
  $('controls-overlay').classList.add('hidden');
}

// ── 自动翻页 ─────────────────────────────────────────────────────
let _autoTimer = null;
let _autoProgressTimer = null;

function toggleAutoplay() {
  F.autoplay = !F.autoplay;
  const btn = $('btn-autoplay');
  if (F.autoplay) {
    startAutoplay();
    btn.textContent = '⏸ 暂停';
    btn.classList.add('playing');
  } else {
    stopAutoplay();
    btn.textContent = '▶ 播放';
    btn.classList.remove('playing');
  }
}

function startAutoplay() {
  stopAutoplay();
  const bar = $('autoplay-bar');
  const progress = $('autoplay-progress');
  bar.classList.remove('hidden');

  function tick() {
    // 进度条动画
    progress.style.transition = 'none';
    progress.style.width = '0%';
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        progress.style.transition = `width ${F.autoInterval}s linear`;
        progress.style.width = '100%';
      });
    });

    _autoTimer = setTimeout(() => {
      if (F.currentPage < _maxPage()) {
        flipNext();
      } else {
        flipTo(0, false);
      }
      if (F.autoplay) tick();
    }, F.autoInterval * 1000);
  }

  tick();
}

function stopAutoplay() {
  if (_autoTimer) { clearTimeout(_autoTimer); _autoTimer = null; }
  $('autoplay-bar').classList.add('hidden');
  $('autoplay-progress').style.width = '0%';
}

// ── 背景音乐 ─────────────────────────────────────────────────────
function loadMusic(file) {
  const audio = $('bg-music');
  const url = URL.createObjectURL(file);
  audio.src = url;
  audio.volume = F.musicVolume;

  $('music-name').textContent = file.name;
  $('music-controls').classList.remove('hidden');
  $('btn-music-toggle').classList.remove('hidden');

  audio.play().then(() => {
    $('btn-music-toggle').textContent = '⏸ 暂停';
    $('btn-music-toggle').classList.add('playing');
  }).catch(() => {
    toast('点击播放按钮开始播放');
  });
}

function toggleMusic() {
  const audio = $('bg-music');
  const btn = $('btn-music-toggle');
  if (!audio.src) return;

  if (audio.paused) {
    audio.play();
    btn.textContent = '⏸ 暂停';
    btn.classList.add('playing');
  } else {
    audio.pause();
    btn.textContent = '▶ 播放';
    btn.classList.remove('playing');
  }
}

// ── 全屏 ─────────────────────────────────────────────────────────
function toggleFullscreen() {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen().catch(() => {});
    $('btn-fullscreen').textContent = '⊡';
  } else {
    document.exitFullscreen().catch(() => {});
    $('btn-fullscreen').textContent = '⛶';
  }
}

// ══════════════════════════════════════════════════════════════════
//  输入处理
// ══════════════════════════════════════════════════════════════════

function initKeyboard() {
  document.addEventListener('keydown', e => {
    // 只在阅读器视图时生效
    if ($('flipbook-view').classList.contains('hidden')) return;

    switch (e.key) {
      case 'ArrowLeft':
      case 'ArrowUp':
        e.preventDefault();
        flipPrev();
        break;
      case 'ArrowRight':
      case 'ArrowDown':
        e.preventDefault();
        flipNext();
        break;
      case ' ':
        e.preventDefault();
        toggleAutoplay();
        break;
      case 'Escape':
        if (!$('controls-panel').classList.contains('hidden')) {
          hideControls();
        } else {
          closeBook();
        }
        break;
      case 'f':
      case 'F':
        if (!e.ctrlKey && !e.metaKey) toggleFullscreen();
        break;
    }
  });
}

function initTouch() {
  const stage = $('flip-stage');
  let startX = 0, startY = 0, startTime = 0;

  stage.addEventListener('touchstart', e => {
    const t = e.touches[0];
    startX = t.clientX;
    startY = t.clientY;
    startTime = Date.now();
  }, { passive: true });

  stage.addEventListener('touchend', e => {
    // 只在阅读器可见时
    if ($('flipbook-view').classList.contains('hidden')) return;

    const t = e.changedTouches[0];
    const dx = t.clientX - startX;
    const dy = t.clientY - startY;
    const dt = Date.now() - startTime;

    // 水平滑动: |dx| > 50, |dy| < 80, dt < 500ms
    if (Math.abs(dx) > 50 && Math.abs(dy) < 80 && dt < 500) {
      if (dx < 0) flipNext();    // 左滑 → 下一页
      else flipPrev();           // 右滑 → 上一页
    }
  }, { passive: true });
}

function onResize() {
  checkMobileLayout();
  if (F.currentProject && F.pages.length) {
    renderFlipbook();
  }
}
