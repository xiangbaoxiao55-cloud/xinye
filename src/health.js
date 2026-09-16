// 健康 / 饮食 —— 页面逻辑
import {
  openHealthDB, localDateStr, shiftDate,
  listProfiles, getProfile, saveProfile, archiveProfile,
  listEntries, listEntriesRange, addEntry, deleteEntry, updateEntry,
  listUsage, listWeights, saveWeight,
  listCustomFoods, saveCustomFood,
} from './modules/healthdb.js';
import {
  loadFoodLib, libMeta, searchFoods, MEALS, ACTIVITY,
  calcTargets, calcNutrients, sumNutrients, rowToPer100, emptyPer100, scaleNutrients,
  foodName, foodNote, foodAka, foodCat, foodEdible, foodKey, foodNutrient,
  findFoodByKey, cookedTip, listCommon, NUTRIENT_LABEL,
  loadServings, searchServings, findServing, servingsReady,
} from './modules/healthfood.js';

const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let profile = null;
let curDate = localDateStr();
let curMeal = 'breakfast';
let targets = null;
let curWeight = null;
let picked = null;        // { mode:'lib'|'unit', per100|unit, name, note, edible, foodKey }
let recentUsage = [];
let customFoods = [];     // 她自己建的食物 —— 按「份」记，不用称重

async function loadCustomFoods() {
  try { customFoods = await listCustomFoods(profile.id); }
  catch (e) { customFoods = []; }
}

// 一次性回填：常见表最初只有热量、没有三大营养素，那阵子按「份」记的条目
// 三条进度条会一直显示 0。名字能对上的就补上，她不用把记过的删掉重记。
const BF_KEY = 'health_macro_backfill_v1';
async function backfillUnitMacros() {
  try {
    if (localStorage.getItem(BF_KEY)) return;
    const all = await listEntriesRange(profile.id, '0000-00-00', '9999-99-99');
    let n = 0;
    for (const e of all) {
      if (!e.unitName) continue;
      const cur = e.nutrients || {};
      if (cur.p != null || cur.f != null || cur.c != null) continue;
      const m = findServing(e.name);
      if (!m || m.p == null) continue;
      const base = { ...(e.unitNutrients || {}), kcal: (e.unitNutrients?.kcal ?? m.k) || 0, p: m.p, f: m.f, c: m.c };
      await updateEntry({ ...e, unitNutrients: base, nutrients: scaleNutrients(base, e.grams) });
      n++;
    }
    localStorage.setItem(BF_KEY, '1');
    if (n) console.info('[health] 回填了', n, '条历史记录的营养素');
  } catch (err) { console.warn('[health] 回填失败:', err.message); }
}

// ════════════════ 主题同步 ════════════════
function syncTheme() {
  try {
    const dark = window.parent !== window &&
      window.parent.document.documentElement.dataset.theme === 'dark';
    document.documentElement.dataset.theme = dark ? 'dark' : '';
    const meta = $('metaThemeColor');
    if (meta) meta.content = dark ? '#16121e' : '#fff8f0';
  } catch (e) { /* 跨域/无父页，保持亮色 */ }
}

// ════════════════ 档案 ════════════════
async function ensureProfile() {
  const list = await listProfiles();
  if (list.length) return list[0];
  const id = await saveProfile({
    name: '兔宝', sex: 'female', birthYear: 1987, height: 0,
    activityLevel: 1.375, targetWeight: 0, createdAt: Date.now(),
  });
  return getProfile(id);
}

async function loadTargets() {
  const ws = await listWeights(profile.id);
  curWeight = ws.length ? ws[ws.length - 1].kg : null;
  targets = (curWeight && profile.height)
    ? calcTargets(profile, curWeight)
    : null;
}

// ════════════════ 今日 ════════════════
function dateLabel(d) {
  const today = localDateStr();
  if (d === today) return '今天';
  if (d === shiftDate(today, -1)) return '昨天';
  const [y, m, dd] = d.split('-').map(Number);
  const w = '日一二三四五六'[new Date(y, m - 1, dd).getDay()];
  return `${m}月${dd}日 周${w}`;
}

function fmtGrams(e) {
  const g = e.grams % 1 ? e.grams.toFixed(1) : e.grams;
  return e.unitName ? `${g}${e.unitName}` : `${g}g`;
}

async function renderToday() {
  const entries = await listEntries(profile.id, curDate);
  const sum = sumNutrients(entries);
  const t = targets;

  const kcal = Math.round(sum.kcal || 0);
  $('kEat').textContent = kcal;
  $('kTarget').textContent = t ? t.target : '—';
  $('kEat').classList.toggle('over', !!t && kcal > t.target);

  if (t) {
    const left = t.target - kcal;
    $('kLeft').textContent = left >= 0
      ? `还能吃 ${left} 千卡`
      : `比今天的目标多了 ${-left} 千卡，明天接着来`;
    $('kBar').style.width = Math.min(100, kcal / t.target * 100) + '%';
    $('kBar').classList.toggle('over', kcal > t.target);
  } else {
    $('kLeft').textContent = '去「档案」填身高，再称一次体重，就能算出每天吃多少';
    $('kBar').style.width = '0%';
  }

  renderMacros(sum, t);
  renderMeals(entries, sum);

  $('dLabel').textContent = dateLabel(curDate);
  $('dToday').style.display = curDate === localDateStr() ? 'none' : '';
  $('dNext').style.visibility = curDate >= localDateStr() ? 'hidden' : 'visible';
}

function renderMacros(sum, t) {
  const rows = [['p', '蛋白质', t?.protein], ['f', '脂肪', t?.fat], ['c', '碳水', t?.carb]];
  $('macros').innerHTML = rows.map(([k, label, goal]) => {
    const v = sum[k] == null ? 0 : sum[k];
    const pct = goal ? Math.min(100, v / goal * 100) : 0;
    return `<div class="h-macro">
      <div class="row"><span class="name">${label}</span>
        <span class="val"><b>${Math.round(v)}</b><span>${goal ? ' / ' + goal : ''} g</span></span></div>
      <div class="bar"><i style="width:${pct}%"></i></div>
    </div>`;
  }).join('');
}

async function renderMeals(entries, sum) {
  // 昨天的同一餐，用于「照昨天来一份」
  let yEntries = [];
  try { yEntries = await listEntries(profile.id, shiftDate(curDate, -1)); } catch (e) {}

  $('meals').innerHTML = MEALS.map(m => {
    const list = entries.filter(e => e.meal === m.key);
    const kc = Math.round(list.reduce((s, e) => s + (e.nutrients?.kcal || 0), 0));
    const rows = list.map(e => `
      <div class="h-item">
        <span class="nm">${esc(e.name)}${e.ediblePct < 100 ? `<span class="h-badge">整只</span>` : ''}</span>
        <span class="gm">${fmtGrams(e)}</span>
        <span class="kc">${Math.round(e.nutrients?.kcal || 0)}</span>
        <button class="rm" data-del="${e.id}" title="删掉">✕</button>
      </div>`).join('');

    const ySame = yEntries.filter(e => e.meal === m.key);
    const copyBtn = (!list.length && ySame.length)
      ? `<div class="h-empty"><button class="h-chip" data-copy="${m.key}">照昨天来一份（${Math.round(ySame.reduce((s, e) => s + (e.nutrients?.kcal || 0), 0))} kcal）</button></div>`
      : '';

    return `<div class="h-meal">
      <div class="h-meal-head">
        <span>${m.label}</span>
        <span class="kc">${list.length ? kc + ' kcal' : ''}</span>
        <button class="add" data-add="${m.key}" title="加一样">＋</button>
      </div>
      ${rows}${copyBtn || (list.length ? '' : '<div class="h-empty">还没记</div>')}
    </div>`;
  }).join('');

  const total = sum._unknown;
  if (total > 8) {
    $('meals').insertAdjacentHTML('afterbegin',
      `<div class="h-tip">有些食物成分表里没测（${total} 项），合计是估算值</div>`);
  }
}

// ════════════════ 食物选择 ════════════════
let composing = false, searchTimer = null;

function openSheet(meal) {
  curMeal = meal || 'breakfast';
  $('sheetTitle').textContent = '记一笔 · ' + (MEALS.find(m => m.key === curMeal)?.label || '');
  $('mealSel').innerHTML = MEALS.map(m =>
    `<option value="${m.key}"${m.key === curMeal ? ' selected' : ''}>${m.label}</option>`).join('');
  resetSheet();
  $('sheet').classList.add('on');
  renderChips();
  $('results').innerHTML = libMeta() ? '' : '<div class="h-loading">加载食物库…</div>';
  setTimeout(() => $('searchInput').focus(), 260);
}

function closeSheet() {
  $('sheet').classList.remove('on');
  $('searchInput').blur();
}

function resetSheet() {
  picked = null;
  $('searchInput').value = '';
  $('gramsBox').style.display = 'none';
  $('newFoodBox').style.display = 'none';
  $('newFoodBtn').style.display = 'none';
  $('chips').style.display = '';
  $('results').style.display = '';
  $('results').innerHTML = '';
  $('warnBox').innerHTML = '';
}

async function renderChips() {
  const box = $('chips');
  if (!libMeta()) { box.innerHTML = ''; return; }
  const usage = await listUsage(profile.id);
  recentUsage = usage.sort((a, b) => b.score - a.score);
  const head = t => `<span class="h-chip" style="border:none;padding-left:0;color:var(--text-light)">${t}</span>`;

  if (recentUsage.length) {
    box.innerHTML = head('常吃') + recentUsage.slice(0, 8).map(u =>
      `<button class="h-chip" data-recent="${esc(u.key)}"><b>${esc(u.name)}</b>${u.lastGrams ? ' ' + u.lastGrams + (u.unitName || 'g') : ''}</button>`).join('');
  } else {
    box.innerHTML = head('常见') + listCommon().slice(0, 10).map(r =>
      `<button class="h-chip" data-common="${esc(foodKey(r))}"><b>${esc(foodName(r))}</b></button>`).join('');
  }
}

function doSearch() {
  const q = $('searchInput').value.trim();
  if (picked) return;
  $('chips').style.display = q ? 'none' : '';
  $('newFoodBtn').style.display = q ? '' : 'none';
  $('results').style.display = q ? '' : 'none';
  if (!q) { $('results').innerHTML = ''; return; }
  if (!libMeta()) { $('results').innerHTML = '<div class="h-loading">食物库还没加载好…</div>'; return; }

  const ql = q.toLowerCase();
  const mine = customFoods.filter(c => String(c.name).toLowerCase().includes(ql));
  const srv = searchServings(q);
  const rows = searchFoods(q);

  if (!mine.length && !srv.length && !rows.length) {
    $('results').innerHTML =
      `<div class="h-loading">没有「${esc(q)}」<br>点上面的「自己加一个」，填一次以后就能直接用</div>`;
    $('results')._rows = []; $('results')._mine = []; $('results')._srv = [];
    return;
  }

  let html = '';
  if (srv.length) {
    html += '<div class="h-r-head">常见一份 · 估算</div>' + srv.map((it, i) =>
      `<button class="h-r" data-sidx="${i}">
        <span class="nm">${esc(it.n)}<span class="sub">1${esc(it.u || '份')}${it.g ? ' · ' + esc(it.g) : ''}</span></span>
        <span class="kc">${Math.round(it.k)} kcal</span>
      </button>`).join('');
  }
  if (mine.length) {
    html += '<div class="h-r-head">我自己加的</div>' + mine.map((c, i) =>
      `<button class="h-r" data-cidx="${i}">
        <span class="nm">${esc(c.name)}<span class="sub">1${esc(c.unitName || '份')} = ${Math.round(c.unit?.kcal || 0)} kcal</span></span>
      </button>`).join('');
  }
  if (rows.length) {
    if (mine.length || srv.length) html += '<div class="h-r-head">食物成分表 · 每100克</div>';
    html += rows.map((r, i) => {
      const kc = foodNutrient(r, 'kcal');
      const sub = foodNote(r) || foodAka(r);
      return `<button class="h-r" data-idx="${i}">
        <span class="nm">${esc(foodName(r))}${sub ? `<span class="sub">${esc(sub)}</span>` : ''}</span>
        <span class="kc">${kc == null ? '—' : Math.round(kc) + ' kcal/100g'}</span>
      </button>`;
    }).join('');
  }
  $('results').innerHTML = html;
  $('results')._rows = rows;
  $('results')._mine = mine;
  $('results')._srv = srv;
}

function pickRow(row) {
  const e = foodEdible(row);
  picked = {
    mode: 'lib',
    name: foodName(row), note: foodNote(row), edible: e,
    foodKey: foodKey(row), per100: rowToPer100(row),
  };
  afterPick();
}

// 自建食物：按「份」记，不称重
function pickCustomFood(cf) {
  picked = {
    mode: 'unit',
    name: cf.name, note: '',
    unitName: cf.unitName || '份',
    unit: cf.unit || emptyPer100(),
    foodKey: 'c:' + cf.id,
  };
  afterPick();
}

// 常见一份（估算值）—— 她不知道数字的那种，直接给现成的
function pickServing(it) {
  const unit = emptyPer100();
  unit.kcal = Number(it.k) || 0;
  if (it.p != null) unit.p = Number(it.p);
  if (it.f != null) unit.f = Number(it.f);
  if (it.c != null) unit.c = Number(it.c);
  picked = {
    mode: 'unit',
    name: it.n, note: '估算',
    unitName: it.u || '份',
    unit,
    foodKey: 's:' + it.n,
    estimate: it.g || '',
  };
  afterPick();
}

function afterPick() {
  $('chips').style.display = 'none';
  $('results').style.display = 'none';
  $('newFoodBtn').style.display = 'none';
  $('newFoodBox').style.display = 'none';
  $('gramsBox').style.display = '';
  $('pickedName').textContent = picked.name + (picked.note ? `（${picked.note}）` : '');

  const u = recentUsage.find(x => x.key === picked.foodKey);

  if (picked.mode === 'unit') {
    $('edibleLine').style.display = 'none';
    $('gramsUnit').textContent = picked.unitName;
    $('gramsInput').value = u?.lastGrams || 1;
    $('quickGrams').innerHTML = [1, 2, 3, 5, 10].map(n =>
      `<button class="h-chip" data-g="${n}">${n}${esc(picked.unitName)}</button>`).join('');
    updatePreview();
    return;
  }

  $('gramsUnit').textContent = '克';
  const needEdible = picked.edible != null && picked.edible < 100;
  $('edibleLine').style.display = needEdible ? '' : 'none';
  if (needEdible) $('edibleSel').value = 'whole';

  $('gramsInput').value = u?.lastGrams || 100;
  const quick = [50, 100, 150, 200];
  $('quickGrams').innerHTML =
    (u?.lastGrams ? `<button class="h-chip" data-g="${u.lastGrams}">上次 ${u.lastGrams}g</button>` : '') +
    quick.map(g => `<button class="h-chip" data-g="${g}">${g}g</button>`).join('');

  updatePreview();
}

function effectiveEdiblePct() {
  if (!picked || picked.mode === 'unit') return 100;
  const needEdible = picked.edible != null && picked.edible < 100;
  if (!needEdible) return 100;
  return $('edibleSel').value === 'whole' ? picked.edible : 100;
}

function updatePreview() {
  if (!picked) return;
  const qty = parseFloat($('gramsInput').value) || 0;

  // 自建食物：按份算
  if (picked.mode === 'unit') {
    const n = scaleNutrients(picked.unit, qty);
    $('gramsPreview').textContent = `${Math.round(n.kcal || 0)} kcal`;
    const per = Math.round(picked.unit?.kcal || 0);
    const onlyKcal = picked.unit?.p == null && picked.unit?.f == null && picked.unit?.c == null;
    if (!qty) { $('warnBox').innerHTML = ''; return; }
    const lines = [`· ${qty}${esc(picked.unitName)} × ${per} 千卡/份`];
    if (picked.estimate) lines.push(`· ${esc(picked.estimate)}（估算值）`);
    if (onlyKcal && !picked.estimate) lines.push('· 这条只填了热量，三大营养素没算进去');
    $('warnBox').innerHTML = lines.map(l => `<div>${l}</div>`).join('');
    return;
  }

  const pct = effectiveEdiblePct();
  const n = calcNutrients(picked.per100, qty, pct);
  const edibleG = Math.round(qty * pct / 100);
  $('gramsPreview').textContent = `${Math.round(n.kcal || 0)} kcal · 蛋白 ${Math.round(n.p || 0)}g`;

  const warns = [];
  if (pct < 100) warns.push(`整只 ${qty}g → 可食部约 ${edibleG}g，再按可食部算营养`);
  if (picked.edible == null || picked.edible < 100) {
    warns.push('成分表按「可食部」计，带骨/带壳的记得在上面选对');
  }
  const cooked = libMeta() && cookedTip(picked.name);
  if (cooked) warns.push(cooked.tip + ' —— 这里填生重');

  $('warnBox').innerHTML = warns.map(w => `<div>· ${esc(w)}</div>`).join('');
}

// ── 自己加食物（不用称重）──────────────────────────────────
function openNewFoodForm() {
  const prefill = $('searchInput').value.trim();
  $('chips').style.display = 'none';
  $('results').style.display = 'none';
  $('newFoodBtn').style.display = 'none';
  $('gramsBox').style.display = 'none';
  $('newFoodBox').style.display = '';
  $('nfName').value = prefill;
  $('nfUnit').value = '份';
  $('nfKcal').value = '';
  $('nfName').focus();
}

function closeNewFoodForm() {
  $('newFoodBox').style.display = 'none';
  doSearch();
}

async function saveNewFood() {
  const name = $('nfName').value.trim();
  const unitName = ($('nfUnit').value.trim() || '份').slice(0, 3);
  const kcal = parseFloat($('nfKcal').value);
  if (!name) { toast('给它起个名字'); $('nfName').focus(); return; }
  if (!kcal || kcal <= 0) { toast('填一下一份多少千卡'); $('nfKcal').focus(); return; }

  const unit = emptyPer100();
  unit.kcal = kcal;
  // 名字能对上常见表的话，把三大营养素一起带上 —— 否则那三条进度条永远是 0
  const m = findServing(name);
  if (m) { unit.p = m.p ?? null; unit.f = m.f ?? null; unit.c = m.c ?? null; }
  // 🔴 必须带 profileId —— listCustomFoods 走的是 profileId 索引，漏了就「存得进、读不出」
  const id = await saveCustomFood({ profileId: profile.id, name, unitName, unit, createdAt: Date.now() });
  await loadCustomFoods();
  toast('存好了，下次搜它就能直接记');
  const cf = customFoods.find(c => c.id === id) || { id, name, unitName, unit };
  pickCustomFood(cf);
}

async function confirmAdd() {
  if (!picked) return;
  const qty = parseFloat($('gramsInput').value);
  const meal = $('mealSel').value;

  if (picked.mode === 'unit') {
    if (!qty || qty <= 0) { toast('先填个数'); return; }
    await addEntry(profile.id, {
      dateStr: curDate, meal,
      foodKey: picked.foodKey, name: picked.name,
      grams: qty, unitName: picked.unitName,
      ediblePct: 100, per100: null,
      unitNutrients: picked.unit,
      nutrients: scaleNutrients(picked.unit, qty),
      note: picked.note || '',
    });
  } else {
    if (!qty || qty <= 0) { toast('先填个克数'); return; }
    const pct = effectiveEdiblePct();
    await addEntry(profile.id, {
      dateStr: curDate, meal,
      foodKey: picked.foodKey, name: picked.name, grams: qty, ediblePct: pct,
      per100: picked.per100,
      nutrients: calcNutrients(picked.per100, qty, pct),
      note: picked.note,
    });
  }
  closeSheet();
  toast('记下了');
  await renderToday();
}

// 照昨天来一份
async function copyPrevMeal(meal) {
  const y = await listEntries(profile.id, shiftDate(curDate, -1));
  const list = y.filter(e => e.meal === meal);
  if (!list.length) return;
  for (const e of list) {
    await addEntry(profile.id, {
      dateStr: curDate, meal, foodKey: e.foodKey, name: e.name,
      grams: e.grams, ediblePct: e.ediblePct, per100: e.per100,
      nutrients: e.nutrients, note: e.note,
    });
  }
  toast(`照昨天记了 ${list.length} 样`);
  await renderToday();
}

// ════════════════ 趋势 ════════════════
function fitCanvas(cv) {
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth || 300, h = cv.clientHeight || 150;
  if (cv.width !== Math.round(w * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

function cssVar(n) {
  return getComputedStyle(document.documentElement).getPropertyValue(n).trim() || '#f48fb1';
}

function movingAvg(points, win = 7) {
  return points.map((p, i) => {
    const s = points.slice(Math.max(0, i - win + 1), i + 1);
    return { dateStr: p.dateStr, kg: s.reduce((a, b) => a + b.kg, 0) / s.length };
  });
}

async function renderWeightChart() {
  const cv = $('wChart');
  if (!cv.clientWidth) return;          // 面板还没显示时量不到宽度，等切过去再画
  const ws = await listWeights(profile.id);
  const tip = $('wTip');
  const today = localDateStr();

  $('wInput').value = '';
  const todayW = ws.find(w => w.dateStr === today);
  if (todayW) $('wInput').value = todayW.kg;

  if (ws.length < 2) {
    const { ctx, w, h } = fitCanvas(cv);
    ctx.fillStyle = cssVar('--text-light'); ctx.font = '13px sans-serif';
    ctx.fillText(ws.length ? '再称几次就能看到曲线了' : '还没记过体重', 12, h / 2);
    tip.textContent = '减脂唯一能验证效果的指标。建议固定时间称（早起空腹最准），但只看趋势，别盯单日。';
    return;
  }

  const pts = ws.slice(-60);
  const ma = movingAvg(pts);
  const { ctx, w, h } = fitCanvas(cv);
  const pad = { l: 34, r: 8, t: 10, b: 18 };
  const vals = pts.map(p => p.kg);
  let lo = Math.min(...vals), hi = Math.max(...vals);
  if (hi - lo < 1) { const m = (hi + lo) / 2; lo = m - .6; hi = m + .6; }
  const X = i => pad.l + (w - pad.l - pad.r) * (pts.length === 1 ? .5 : i / (pts.length - 1));
  const Y = v => pad.t + (h - pad.t - pad.b) * (1 - (v - lo) / (hi - lo));

  ctx.strokeStyle = cssVar('--h-hair'); ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(pad.l, Y(lo)); ctx.lineTo(w - pad.r, Y(lo)); ctx.stroke();

  // 每日点
  ctx.fillStyle = cssVar('--text-light');
  pts.forEach((p, i) => { ctx.beginPath(); ctx.arc(X(i), Y(p.kg), 1.8, 0, 7); ctx.fill(); });

  // 7 天移动平均线（重点看这条）
  ctx.strokeStyle = cssVar('--pink-deep'); ctx.lineWidth = 2; ctx.lineJoin = 'round';
  ctx.beginPath(); ma.forEach((p, i) => i ? ctx.lineTo(X(i), Y(p.kg)) : ctx.moveTo(X(i), Y(p.kg))); ctx.stroke();

  ctx.fillStyle = cssVar('--text-light'); ctx.font = '10px sans-serif';
  ctx.fillText(hi.toFixed(1), 4, pad.t + 8);
  ctx.fillText(lo.toFixed(1), 4, h - pad.b);

  const first = ma[0].kg, last = ma[ma.length - 1].kg;
  const diff = last - first;
  const days = pts.length;
  tip.textContent = days >= 7
    ? `这 ${days} 天平均${diff < 0 ? '降了' : diff > 0 ? '涨了' : '基本没变'} ${Math.abs(diff).toFixed(1)} kg（粉线是 7 天平均，看它就好）`
    : '粉线是 7 天移动平均——单日的上下波动多半是水分，别被它影响心情。';
}

async function renderKcalChart() {
  const cv = $('kChart');
  if (!cv.clientWidth) return;
  const today = localDateStr();
  const from = shiftDate(today, -6);
  const all = await listEntriesRange(profile.id, from, today);
  const { ctx, w, h } = fitCanvas(cv);
  const pad = { l: 34, r: 8, t: 10, b: 18 };

  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = shiftDate(today, -i);
    const kc = all.filter(e => e.dateStr === d).reduce((s, e) => s + (e.nutrients?.kcal || 0), 0);
    days.push({ d, kc: Math.round(kc) });
  }
  const goal = targets?.target || 0;
  const hi = Math.max(goal || 0, ...days.map(x => x.kc), 100) * 1.1;
  const bw = (w - pad.l - pad.r) / days.length;

  if (goal) {
    ctx.strokeStyle = cssVar('--pink-deep'); ctx.lineWidth = 1; ctx.setLineDash([4, 4]);
    const y = pad.t + (h - pad.t - pad.b) * (1 - goal / hi);
    ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(w - pad.r, y); ctx.stroke();
    ctx.setLineDash([]);
  }
  days.forEach((x, i) => {
    if (!x.kc) return;
    const bh = (h - pad.t - pad.b) * (x.kc / hi);
    const bx = pad.l + bw * i + bw * .22;
    ctx.fillStyle = (goal && x.kc > goal) ? cssVar('--h-warn') : cssVar('--pink');
    ctx.globalAlpha = .75;
    ctx.beginPath();
    const r = Math.min(3, bw * .2), bwd = bw * .56, by = h - pad.b - bh;
    ctx.moveTo(bx, h - pad.b); ctx.lineTo(bx, by + r);
    ctx.quadraticCurveTo(bx, by, bx + r, by);
    ctx.lineTo(bx + bwd - r, by); ctx.quadraticCurveTo(bx + bwd, by, bx + bwd, by + r);
    ctx.lineTo(bx + bwd, h - pad.b); ctx.closePath(); ctx.fill();
    ctx.globalAlpha = 1;
  });
  ctx.fillStyle = cssVar('--text-light'); ctx.font = '10px sans-serif';
  ctx.fillText(String(Math.round(hi)), 4, pad.t + 8);
  $('kTip').textContent = goal
    ? '虚线段是每天的目标。柱子超过它是正常的，一周里有几天在目标附近就够了。'
    : '还没设定目标热量。';
}

// ════════════════ 档案页 ════════════════
async function renderProfile() {
  $('fAct').innerHTML = ACTIVITY.map(a =>
    `<option value="${a.v}">${a.label} · ${a.hint}</option>`).join('');
  $('fName').value = profile.name || '';
  $('fSex').value = profile.sex || 'female';
  $('fYear').value = profile.birthYear || '';
  $('fHeight').value = profile.height || '';
  $('fTargetW').value = profile.targetWeight || '';
  $('fAct').value = profile.activityLevel || 1.375;

  if (targets) {
    $('targetTip').innerHTML =
      `基础代谢 <b>${targets.bmr}</b> kcal · 日常消耗 <b>${targets.tdee}</b> kcal<br>` +
      `每天目标 <b>${targets.target}</b> kcal（蛋白 ${targets.protein}g / 脂肪 ${targets.fat}g / 碳水 ${targets.carb}g）<br>` +
      `BMI ${targets.bmi} · 预期每周约 ${targets.weeklyKg} kg` +
      (targets.hitFloor ? '<br>已经贴着安全下限了，再少吃不会更快——靠增加活动量更稳。' : '');
  } else {
    $('targetTip').textContent = curWeight
      ? '还差身高没填。'
      : '填好身高、再去「趋势」里称一次体重，就能算出每天该吃多少。';
  }

  const list = await listProfiles();
  const usage = await listUsage(profile.id);
  $('profList').innerHTML = list.map(p =>
    `<div class="h-kv"><span class="k">${esc(p.name)}${p.id === profile.id ? ' · 当前' : ''}</span>
      <span class="v">${p.id === profile.id
        ? `<button class="h-chip" data-delprof="${p.id}">删掉这个档案</button>`
        : `<button class="h-chip" data-switch="${p.id}">切到这个</button>`}</span></div>`).join('');

  const meta = libMeta();
  $('libTip').textContent = meta
    ? `食物数据：《${meta.src}》共 ${meta.n} 条（${meta.v}）。记录存在这台手机上，只有备份时才离开。`
    : '食物库没加载成功，检查网络后重开这一页。';
}

// ════════════════ 汇总渲染 ════════════════
async function renderAll() {
  await loadTargets();
  await renderToday();
  await renderTrend();
  await renderProfile();
}
async function renderTrend() {
  await renderWeightChart();
  await renderKcalChart();
}

// ════════════════ 交互绑定 ════════════════
function toast(msg) {
  const t = $('toast');
  t.textContent = msg; t.classList.add('on');
  clearTimeout(t._tm); t._tm = setTimeout(() => t.classList.remove('on'), 1800);
}

function bind() {
  // 顶栏
  $('btnBack').onclick = () => {
    if (window.parent !== window) window.parent.postMessage('closeOverlay', '*');
    else location.href = 'index.html';
  };
  $('btnProfile').onclick = () => switchPane('profile');

  // 页内 tab
  document.querySelectorAll('.h-tab').forEach(b => b.onclick = () => switchPane(b.dataset.pane));

  // 日期
  $('dPrev').onclick = () => { curDate = shiftDate(curDate, -1); renderToday(); };
  $('dNext').onclick = () => {
    if (curDate >= localDateStr()) return;
    curDate = shiftDate(curDate, 1); renderToday();
  };
  $('dToday').onclick = () => { curDate = localDateStr(); renderToday(); };

  // 餐次：加 / 删 / 照昨天
  $('meals').addEventListener('click', async e => {
    const add = e.target.closest('[data-add]');
    if (add) return openSheet(add.dataset.add);
    const del = e.target.closest('[data-del]');
    if (del) {
      await deleteEntry(Number(del.dataset.del));
      await renderToday(); toast('删掉了');
      return;
    }
    const cp = e.target.closest('[data-copy]');
    if (cp) return copyPrevMeal(cp.dataset.copy);
  });

  $('btnAdd').onclick = () => openSheet(guessMeal());

  // 面板
  $('sheet').addEventListener('click', e => { if (e.target === $('sheet')) closeSheet(); });

  const si = $('searchInput');
  si.addEventListener('compositionstart', () => { composing = true; });
  si.addEventListener('compositionend', () => { composing = false; doSearch(); });
  si.addEventListener('input', () => {
    if (composing) return;
    clearTimeout(searchTimer); searchTimer = setTimeout(doSearch, 80);
  });

  $('results').addEventListener('click', e => {
    const s = e.target.closest('[data-sidx]');
    if (s) {
      const srv = $('results')._srv || [];
      const it = srv[Number(s.dataset.sidx)];
      if (it) pickServing(it);
      return;
    }
    const c = e.target.closest('[data-cidx]');
    if (c) {
      const mine = $('results')._mine || [];
      const cf = mine[Number(c.dataset.cidx)];
      if (cf) pickCustomFood(cf);
      return;
    }
    const b = e.target.closest('[data-idx]');
    if (!b) return;
    const rows = $('results')._rows || [];
    const row = rows[Number(b.dataset.idx)];
    if (row) pickRow(row);
  });

  $('chips').addEventListener('click', async e => {
    const b = e.target.closest('[data-recent]');
    if (b) {
      const key = String(b.dataset.recent);
      if (key.startsWith('c:')) {
        const cf = customFoods.find(c => 'c:' + c.id === key);
        if (cf) pickCustomFood(cf);
        else toast('这条自建食物被删了');
      } else if (key.startsWith('s:')) {
        const it = findServing(key.slice(2));
        if (it) pickServing(it);
        else toast('这条不在常见表里了');
      } else {
        const row = findFoodByKey(key);
        if (row) pickRow(row);
        else toast('这条在新版成分表里找不到了，重新搜一下吧');
      }
      return;
    }
    const c = e.target.closest('[data-common]');
    if (c) {
      const row = findFoodByKey(c.dataset.common);
      if (row) pickRow(row);
    }
  });

  $('btnUnpick').onclick = () => { picked = null; resetSheet(); renderChips(); $('searchInput').focus(); };
  $('quickGrams').addEventListener('click', e => {
    const b = e.target.closest('[data-g]');
    if (!b) return;
    $('gramsInput').value = b.dataset.g;
    updatePreview();
  });
  ['input', 'change'].forEach(ev => {
    $('gramsInput').addEventListener(ev, updatePreview);
    $('edibleSel').addEventListener(ev, updatePreview);
  });
  $('btnConfirm').onclick = confirmAdd;
  $('newFoodBtn').onclick = openNewFoodForm;
  $('btnSaveNewFood').onclick = saveNewFood;
  $('btnCancelNewFood').onclick = closeNewFoodForm;

  // 在「自己加」表单里打字时，能对上的话直接把参考值填好 —— 她不用先知道数字
  const NF_HINT = '不用称重。你平时怎么数就怎么填——一个饺子、一只鸡腿、一碗饭。';
  $('nfName').addEventListener('input', () => {
    const it = searchServings($('nfName').value.trim(), { limit: 1 })[0];
    const hint = $('nfHint');
    if (it) {
      $('nfKcal').value = it.k;
      $('nfUnit').value = it.u || '份';
      hint.textContent = `参考：${it.n} 约 ${it.k} 千卡/${it.u || '份'}${it.g ? '（' + it.g + '）' : ''}——已填上，可以改`;
    } else {
      hint.textContent = NF_HINT;
    }
  });

  // 趋势：记体重
  $('wInput').addEventListener('change', async () => {
    const kg = parseFloat($('wInput').value);
    if (!kg || kg < 20 || kg > 300) return;
    await saveWeight(profile.id, localDateStr(), kg);
    await loadTargets(); await renderWeightChart();
    toast('记下了');
  });

  // 档案：保存
  $('btnSaveProfile').onclick = async () => {
    profile.name = $('fName').value.trim() || '兔宝';
    profile.sex = $('fSex').value;
    profile.birthYear = Number($('fYear').value) || profile.birthYear;
    profile.height = Number($('fHeight').value) || 0;
    profile.targetWeight = Number($('fTargetW').value) || 0;
    profile.activityLevel = Number($('fAct').value) || 1.375;
    await saveProfile(profile);
    $('profName').textContent = profile.name;
    await renderAll();
    toast('存好了');
  };
  $('btnAddProfile').onclick = async () => {
    const name = prompt('给这个档案起个名字（比如妈妈）');
    if (!name) return;
    const id = await saveProfile({
      name: name.trim(), sex: 'female', birthYear: 1970, height: 0,
      activityLevel: 1.375, targetWeight: 0, createdAt: Date.now(),
    });
    profile = await getProfile(id);
    $('profName').textContent = profile.name;
    await renderAll();
    toast('新档案建好了，填一下身高');
  };
  $('profList').addEventListener('click', async e => {
    const sw = e.target.closest('[data-switch]');
    if (sw) {
      profile = await getProfile(sw.dataset.switch);
      $('profName').textContent = profile.name;
      curDate = localDateStr();
      await renderAll();
      return;
    }
    const dp = e.target.closest('[data-delprof]');
    if (dp) {
      if (!confirm('删掉这个档案？记录会留着，但这个档案不再显示。')) return;
      await archiveProfile(dp.dataset.delprof);
      const rest = await listProfiles();
      profile = rest[0] || await ensureProfile();
      $('profName').textContent = profile.name;
      await renderAll();
    }
  });

  window.addEventListener('resize', () => { renderTrend(); });
}

function switchPane(name) {
  document.querySelectorAll('.h-tab').forEach(b => b.classList.toggle('on', b.dataset.pane === name));
  document.querySelectorAll('.h-pane').forEach(p => p.classList.toggle('on', p.id === 'pane-' + name));
  if (name === 'trend') renderTrend();
  if (name === 'profile') renderProfile();
}

function guessMeal() {
  const h = new Date().getHours();
  if (h < 10) return 'breakfast';
  if (h < 15) return 'lunch';
  if (h < 21) return 'dinner';
  return 'snack';
}

// ════════════════ 启动 ════════════════
(async function init() {
  syncTheme();
  // 🔴 只在 iframe 里才盯父页主题：顶层打开时 parent === window，
  //    观察自己会变成「改 data-theme → 触发 observer → 再改」的死循环，把主线程卡死
  if (window.parent !== window) {
    try {
      new MutationObserver(syncTheme).observe(window.parent.document.documentElement,
        { attributes: true, attributeFilter: ['data-theme'] });
    } catch (e) {}
  }

  await openHealthDB();
  profile = await ensureProfile();
  $('profName').textContent = profile.name;
  await loadCustomFoods();

  bind();
  await renderAll();

  // 食物库晚点加载，不挡首屏
  loadFoodLib().then(() => { renderChips(); })
    .catch(e => console.warn('[health] 食物库加载失败:', e.message));
  // 常见「一份」的估算表（搜「饺子」时直接给数字用）
  loadServings()
    .then(async () => {
      renderChips();
      await backfillUnitMacros();   // 早先只记了热量的条目，这时候补上三大营养素
      await renderToday();
    })
    .catch(e => console.warn('[health] 常见份量表加载失败:', e.message));
})();

// 切回这个 Tab 时刷新（主 APP 的 switchTab 会调）
window.__hcOnShow = () => { renderToday(); renderTrend(); };
