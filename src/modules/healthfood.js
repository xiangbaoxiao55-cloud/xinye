// 食物库加载 / 搜索 / 营养计算 / 减脂目标
// 数据来自《中国食物成分表 标准版 第6版》→ data/food_library.json（构建脚本在 d:/tmp，不进仓库）

const LIB_URL = './data/food_library.json';
const NUTRIENTS = ['kcal', 'p', 'f', 'c', 'fib', 'chol', 'na', 'ca', 'fe', 'zn', 'va', 'vc', 've', 'k', 'mg'];

export const MEALS = [
  { key: 'breakfast', label: '早餐' },
  { key: 'lunch',     label: '午餐' },
  { key: 'dinner',    label: '晚餐' },
  { key: 'snack',     label: '加餐' },
];

export const ACTIVITY = [
  { v: 1.2,   label: '久坐',   hint: '全天坐着，几乎不运动' },
  { v: 1.375, label: '轻度',   hint: '每周运动 1–3 次' },
  { v: 1.55,  label: '中度',   hint: '每周运动 3–5 次' },
  { v: 1.725, label: '高度',   hint: '每周运动 6–7 次' },
];

let _lib = null, _loading = null;
let FI = {};          // 字段名 → 列下标
let _commonSet = null;

// 只在进入饮食页后调用；iframe 常驻，一个会话只加载一次
export function loadFoodLib() {
  if (_lib) return Promise.resolve(_lib);
  if (_loading) return _loading;
  _loading = fetch(LIB_URL)
    .then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(j => {
      _lib = j;
      FI = {};
      j.fields.forEach((f, i) => { FI[f] = i; });
      _commonSet = new Set(j.common || []);
      return j;
    })
    .catch(e => { _loading = null; throw e; });   // 失败允许重试
  return _loading;
}

export function libReady() { return !!_lib; }
export function libMeta()  { return _lib ? { v: _lib.v, src: _lib.src, n: _lib.rows.length } : null; }

// ── 搜索 ─────────────────────────────────────────────────────────────────
function norm(s) {
  return String(s || '')
    .replace(/[\uFF01-\uFF5E]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))  // 全角→半角
    .trim()
    .toLowerCase();
}

// 子序列匹配：jxr 能命中 jxfr（鸡胸脯肉）——大家打缩写会跳字母
function isSubseq(q, s) {
  let i = 0;
  for (const c of s) { if (c === q[i]) i++; if (i === q.length) return true; }
  return i === q.length;
}

// 返回 row 数组（紧凑格式，按 FI 取列）
export function searchFoods(rawQuery, { limit = 60 } = {}) {
  if (!_lib) return [];
  let q = norm(rawQuery);
  if (!q) return [];
  const aliased = _lib.aliases?.[q];       // 西红柿 → 番茄
  const q2 = aliased ? norm(aliased) : null;
  const isAscii = /^[a-z0-9]+$/.test(q);
  const out = [];

  for (const row of _lib.rows) {
    const name = row[FI.name];
    const lname = name.toLowerCase();
    const aka = row[FI.aka] || '';
    let score = -1;

    const matches = (qq) => {
      if (lname === qq) return 10000;
      if (lname.startsWith(qq)) return 7000 - name.length;
      const at = lname.indexOf(qq);
      if (at >= 0) return 5000 - at * 20 - name.length;
      if (aka && aka.split('|').some(a => a.toLowerCase().includes(qq))) return 4500 - name.length;
      if (isAscii) {
        const vs = (row[FI.pyi] || '').split('|');
        if (vs.includes(qq)) return 3500;
        if (vs.some(p => p.startsWith(qq))) return 2000;
        if (qq.length >= 2 && vs.some(p => isSubseq(qq, p))) return 1200;
      }
      if ((row[FI.cat] || '').includes(qq)) return 900;
      return -1;
    };

    score = Math.max(matches(q), q2 ? matches(q2) : -1);
    if (score < 0) continue;
    // 同名条目排先后：正牌（无 note）> 代表值（通用值）> 具体变体（整个，罐头 / 脱水 / 土鸡 / 美国牛）
    if (row[FI.note]) score -= row[FI.note].startsWith('代表值') ? 30 : 60;
    if (_commonSet.has(name)) score += 600;                 // 常吃置顶
    out.push({ row, score });
  }
  out.sort((a, b) => b.score - a.score || a.row[FI.name].length - b.row[FI.name].length);
  return out.slice(0, limit).map(x => x.row);
}

export function foodName(row)  { return row[FI.name]; }
export function foodNote(row)  { return row[FI.note] || ''; }
export function foodAka(row)   { return row[FI.aka] || ''; }
export function foodCat(row)   { return row[FI.cat] || ''; }
export function foodEdible(row){ const v = row[FI.edible]; return v == null ? 100 : v; }
export function foodKey(row)   { return 'g:' + row[FI.code]; }
export function foodKcal(row)  { return row[FI.kcal]; }

// 取某一列（营养素）的值
export function foodNutrient(row, key) {
  const i = FI[key];
  return i == null ? null : row[i];
}

// row → per100 对象（存进 entry 做快照，改克数时靠它重算）
export function rowToPer100(row) {
  const o = {};
  for (const n of NUTRIENTS) o[n] = foodNutrient(row, n);
  return o;
}

export function emptyPer100() {
  const o = {};
  for (const n of NUTRIENTS) o[n] = null;
  return o;
}

// ── 营养计算 ─────────────────────────────────────────────────────────────
// ediblePct < 100 表示用户称的是「整只/带骨」重量，先换算成可食部
export function calcNutrients(per100, grams, ediblePct = 100) {
  const ratio = (grams * (ediblePct / 100)) / 100;
  const out = {};
  for (const n of NUTRIENTS) {
    const v = per100?.[n];
    out[n] = v == null ? null : Math.round(v * ratio * 100) / 100;
  }
  return out;
}

// 合计（🔴 先加后舍：entries 里存全精度，只在这里 round）
export function sumNutrients(list) {
  const out = {};
  let unknown = 0;
  for (const n of NUTRIENTS) {
    let s = 0, has = false;
    for (const e of list) {
      const v = e.nutrients?.[n];
      if (v == null) { if (n === 'kcal') unknown++; continue; }   // 只数热量缺失的条数
      s += v; has = true;
    }
    out[n] = has ? Math.round(s * 10) / 10 : null;
  }
  out._unknown = unknown;    // 调用方据此在总量前加「≈」
  return out;
}

// 按 foodKey('g:<code>') 反查食物库里那一行
export function findFoodByKey(key) {
  if (!_lib || !key || !String(key).startsWith('g:')) return null;
  const code = String(key).slice(2);
  return _lib.rows.find(r => r[FI.code] === code) || null;
}

// 生熟换算提示（只给文字，不做自动换算）
export function cookedTip(name) {
  return _lib?.cooked?.[name] || null;
}

// 「常见食物」——还没记过任何东西时，给一排入口，别让搜索框空着
export function listCommon() {
  if (!_lib) return [];
  return (_lib.common || [])
    .map(n => _lib.rows.find(r => r[FI.name] === n))
    .filter(Boolean);
}

export const NUTRIENT_LABEL = {
  kcal: ['热量', 'kcal'], p: ['蛋白质', 'g'], f: ['脂肪', 'g'], c: ['碳水', 'g'],
  fib: ['膳食纤维', 'g'], chol: ['胆固醇', 'mg'], na: ['钠', 'mg'], ca: ['钙', 'mg'],
  fe: ['铁', 'mg'], zn: ['锌', 'mg'], va: ['维生素A', 'μgRAE'], vc: ['维生素C', 'mg'],
  ve: ['维生素E', 'mg'], k: ['钾', 'mg'], mg: ['镁', 'mg'],
};

// ── 减脂目标 ─────────────────────────────────────────────────────────────
// 三层安全下限，取最严：缺口≤20%且≤500 / 不低于 BMR / 绝对下限 女1200 男1500
export function calcTargets(profile, currentKg) {
  const kg = Number(currentKg) || 0;
  const cm = Number(profile.height) || 0;
  const age = new Date().getFullYear() - (Number(profile.birthYear) || 1990);
  if (!kg || !cm) return null;

  const male = profile.sex === 'male';
  const bmr = 10 * kg + 6.25 * cm - 5 * age + (male ? 5 : -161);
  const act = Number(profile.activityLevel) || 1.375;
  const tdee = bmr * act;
  const deficit = Math.min(0.20 * tdee, 500);
  const floor = Math.max(bmr, male ? 1500 : 1200);
  const target = Math.max(floor, tdee - deficit);

  const bmi = kg / Math.pow(cm / 100, 2);
  const refW = (bmi > 30 && profile.targetWeight) ? Number(profile.targetWeight) : kg;   // BMI>30 用目标体重算蛋白
  let p = 1.8 * refW;
  let f = Math.max(0.8 * refW, target * 0.25 / 9);
  let c = (target - p * 4 - f * 9) / 4;
  if (c < 0) { f = 0.6 * refW; c = (target - p * 4 - f * 9) / 4; }
  if (c < 0) { p = 1.6 * refW; c = (target - p * 4 - f * 9) / 4; }

  return {
    bmr: Math.round(bmr),
    tdee: Math.round(tdee),
    target: Math.round(target),
    protein: Math.round(p),
    fat: Math.round(f),
    carb: Math.round(Math.max(0, c)),
    fiber: 25,
    bmi: Math.round(bmi * 10) / 10,
    weeklyKg: Math.round(((tdee - target) * 7 / 7700) * 100) / 100,   // 预期周减重
    hitFloor: tdee - deficit < floor,                                  // 目标被下限顶住了
  };
}
