/**
 * 崩溃日志存档（2026-09-29）
 *
 * 为什么要有这个东西：
 * vConsole 的日志落在 localStorage 的 `vconsole_logs`，**只留最后 200 条**（约 20 分钟）。
 * 她那边一崩、重开 APP，新日志接着往同一个键写，写满 200 条就把上一次崩溃的记录挤掉 ——
 * 而「崩了几次、每次崩之前最后一屏是什么」正是定位闪退最要紧的证据。
 * 所以每次启动时，只要发现上一轮还留着日志，就整批抄一份到这里，攒着别被顶掉。
 *
 * 为什么另开一个库、而不是塞进 XinyeChatDB：
 * ① 主库的 DB_VER **只能升不能降**，要加 store 就得升版本；她手机上万一还开着别的页面，
 *    旧版本会 onblocked 把页面锁死 —— 为了一个诊断功能冒这个险不值；
 * ② 项目里本来就有一堆独立小库（DrawDB / StoryboardDB / GalleryDB / ReadingDB / DiaryTextDB）。
 *
 * ⚠️ 这个库**只存诊断数据**，不进任何备份（导出备份 / 自动备份都不带它）。
 */

import { saveFile, toast } from './utils.js';

const DB_NAME = 'XinyeDiagDB';
const DB_VER = 1;
const STORE = 'crashLogs';
const KEEP = 10;              // 只留最近 10 份，更早的删掉

function _openDB(depth = 0) {
  return new Promise((resolve, reject) => {
    let req;
    try { req = indexedDB.open(DB_NAME, DB_VER); }
    catch (e) { reject(e); return; }
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = e => {
      const db = e.target.result;
      if (db.objectStoreNames.contains(STORE)) { resolve(db); return; }
      // ⚠️ 实测会撞上「库在、store 不在」（2026-09-29 无头验证抓到）：
      //    `open(name, 1)` 拿到的库版本**已经是 1**，于是**不触发 upgradeneeded**，
      //    可这个库里一个 store 都没有 —— 之后每次 transaction 都抛
      //    `One of the specified object stores was not found`。
      //    症状是「存档时有时无」：页面刚加载那一下最容易撞上（跟别的 open 抢库）。
      //    自愈：把这个空库删掉重建 —— 里面本来就没有数据，删了不心疼。
      db.close();
      if (depth >= 3) { reject(new Error('store missing')); return; }
      const again = () => _openDB(depth + 1).then(resolve, reject);
      let del;
      try { del = indexedDB.deleteDatabase(DB_NAME); }
      catch (err) { reject(err); return; }
      del.onsuccess = again;
      del.onerror = again;
      del.onblocked = () => setTimeout(again, 300);
    };
    req.onerror = () => reject(req.error || new Error('open failed'));
    req.onblocked = () => reject(new Error('blocked'));
  });
}

function _tx(db, mode, fn) {
  return new Promise((resolve, reject) => {
    let tx;
    try { tx = db.transaction(STORE, mode); }
    catch (e) { reject(e); return; }
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error || new Error('tx error'));
    tx.onabort = () => reject(tx.error || new Error('tx abort'));
    try { fn(tx.objectStore(STORE), tx); } catch (e) { reject(e); }
  });
}

function _getAll(db) {
  return new Promise((resolve, reject) => {
    let tx;
    try { tx = db.transaction(STORE, 'readonly'); }
    catch (e) { reject(e); return; }
    const r = tx.objectStore(STORE).getAll();
    r.onsuccess = () => resolve(r.result || []);
    r.onerror = () => reject(r.error || new Error('getAll failed'));
  });
}

const _p2 = n => String(n).padStart(2, '0');

function _fmtTime(ts) {
  const d = new Date(ts || 0);
  return `${_p2(d.getHours())}:${_p2(d.getMinutes())}:${_p2(d.getSeconds())}`;
}

function _fmtFull(ts) {
  const d = new Date(ts || 0);
  return `${d.getFullYear()}-${_p2(d.getMonth() + 1)}-${_p2(d.getDate())} ` +
    `${_p2(d.getHours())}:${_p2(d.getMinutes())}:${_p2(d.getSeconds())}`;
}

function _stamp() {
  const d = new Date();
  return `${d.getFullYear()}${_p2(d.getMonth() + 1)}${_p2(d.getDate())}-` +
    `${_p2(d.getHours())}${_p2(d.getMinutes())}`;
}

/**
 * 判「上一轮到底是怎么结束的」。**抽出来是为了能单测** —— 这段逻辑原来埋在 main.js 里，
 * 只分「被掐 / 正常退出」两种，于是**「切后台之后被系统回收」被一律标成「正常退出」**，
 * 2026-09-30 下午那次真崩就是这么从眼皮底下溜过去的。
 *
 * @param {number}  lastTs     上一轮最后一根日志的时间戳（0 = 没有）
 * @param {number}  exitAt     上一轮最后一次「收摊」标记的时间戳（0 = 没有）
 * @param {boolean} exitHidden 收摊那一刻页面是不是在后台
 * @returns {'crashed'|'background'|'closed'}
 *   crashed    = 日志**晚于**收摊标记 → 它连收摊都没来得及 → 前台被掐（真崩）
 *   background = 收摊标记晚于日志、且收摊时在后台 → 切后台之后结束的
 *                ⚠️ 「系统回收」和「她自己划掉」长得一模一样，只能记事实，别断言是哪一个
 *   closed     = 收摊标记晚于日志、且收摊时在前台 → 关页面 / 刷新，正常退出
 */
export function classifyRunEnd(lastTs, exitAt, exitHidden) {
  const t = lastTs || 0, e = exitAt || 0;
  if (t > e) return 'crashed';
  return exitHidden ? 'background' : 'closed';
}

/** 给导出文本用的人话标签 */
export function endLabel(kind) {
  return kind === 'crashed' ? '疑似崩溃（前台被掐）'
    : kind === 'background' ? '切后台后结束（可能被系统回收）'
    : '正常退出';
}

/**
 * 把一批日志存进存档区。`entries` 就是 `vconsole_logs` 那个数组，
 * 每条形如 `{ l: 'log'|'warn'|'error', t: '正文', ts: 时间戳 }`。
 *
 * @param {Array}  entries
 * @param {Object} opts
 * @param {boolean} opts.crashed 上一轮是不是被系统掐掉的（判据在 main.js，见那里的注释）
 * @returns {Promise<{kept:number,dropped:number,from:number,to:number}|null>}
 */
export async function archiveCrashLogs(entries, opts = {}) {
  const list = Array.isArray(entries)
    ? entries.filter(e => e && typeof e.t === 'string')
    : [];
  if (!list.length) return null;
  const first = await _archiveOnce(list, opts);
  if (first) return first;
  // 偶发失败（页面刚加载那一下跟别的 open 抢库）→ 等一下再试一次
  await new Promise(r => setTimeout(r, 800));
  return await _archiveOnce(list, opts);
}

async function _archiveOnce(list, opts) {
  let db;
  try {
    db = await _openDB();
    const rec = {
      id: 'crash_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
      ts: Date.now(),
      from: list[0].ts || 0,
      to: list[list.length - 1].ts || 0,
      count: list.length,
      crashed: !!opts.crashed,
      // 🔴 2026-09-30 加：光有 crashed 分不清「切后台之后被回收」（以前一律算正常退出）。
      //    exitAt / exitHidden 是**当时**收摊的凭据，一起存下来，导出时摆出来自己看。
      endKind: opts.endKind || (opts.crashed ? 'crashed' : 'closed'),
      exitAt: opts.exitAt || 0,
      exitHidden: !!opts.exitHidden,
      lines: list,
    };
    await _tx(db, 'readwrite', os => os.put(rec));

    const all = await _getAll(db);
    all.sort((a, b) => a.ts - b.ts);
    const drop = all.slice(0, Math.max(0, all.length - KEEP));
    if (drop.length) {
      await _tx(db, 'readwrite', os => { drop.forEach(d => os.delete(d.id)); });
    }
    return { kept: all.length - drop.length, dropped: drop.length, from: rec.from, to: rec.to };
  } catch (e) {
    console.warn('[崩溃日志] 存档失败:', (e && e.message) || e);
    return null;
  } finally {
    try { db && db.close(); } catch (_) {}
  }
}

/** 把所有存档拼成一段纯文本（导出用） */
export async function crashLogsAsText() {
  let db;
  try {
    db = await _openDB();
    const all = await _getAll(db);
    if (!all.length) return '';
    all.sort((a, b) => a.ts - b.ts);

    const out = [];
    out.push('炘也 · 崩溃日志存档');
    out.push('导出时间：' + _fmtFull(Date.now()));
    out.push('共 ' + all.length + ' 份（每份最多 200 行，对应约 20 分钟）');
    out.push('');
    all.forEach((r, i) => {
      // 旧存档没有 endKind，按老判据回退（那批数据的「正常退出」里可能混着后台被回收的）
      const kind = r.endKind || (r.crashed ? 'crashed' : 'closed');
      out.push('='.repeat(48));
      out.push(`【第 ${i + 1} 份】${_fmtFull(r.from)} ~ ${_fmtFull(r.to)} · ${r.count} 行 · ${endLabel(kind)}`);
      // 🔴 光有标签不够 —— 把「最后一根日志」和「收摊标记」的先后摆出来，
      //    判据成不成立一眼可查（谁先谁后、当时在不在后台）。
      //    ⚠️ 2026-09-30 之前存的 10 份没有这些字段，只能照实说「没有」，别硬编一个结论。
      if (!r.endKind) {
        out.push('   · 旧存档：当时还没记收摊标记，上面的判定只有「被掐 / 正常退出」两种，别全信');
      } else if (r.exitAt) {
        const _gap = Math.round(((r.exitAt || 0) - (r.to || 0)) / 1000);
        out.push(`   · 最后一根日志 ${_fmtTime(r.to)} → 收摊标记 ${_fmtTime(r.exitAt)}` +
          `（${r.exitHidden ? '当时在后台' : '当时在前台'}，相差 ${_gap >= 0 ? '+' : ''}${_gap} 秒）`);
        // 🔴 2026-09-30 补：**「收摊后马上又加载了」必须点出来**。
        //    SW 更新时 `clients.claim()` → `controllerchange` → `location.reload()`（main.js:55），
        //    那次 pagehide 一样会写「在后台」的收摊标记 —— 和「被系统回收」逐字相同。
        //    区别在 rec.ts（= 下一次加载的时刻）：自己重载是几秒后，她发现重开了是几分钟后。
        const _relaunch = r.ts && r.to ? Math.round((r.ts - r.to) / 1000) : -1;
        if (_relaunch >= 0 && _relaunch < 15) {
          out.push(`   · ⚠️ 收摊后 ${_relaunch} 秒就重新加载了 —— 更像页面自己重载` +
            `（SW 更新 / 手动刷新），不像被系统回收`);
        }
      } else {
        out.push('   · 没有收摊标记 → 上一轮连切后台都没记上（硬崩，或被系统直接掐掉）');
      }
      out.push('='.repeat(48));
      for (const e of (r.lines || [])) {
        const lv = e.l === 'error' ? ' ERR' : e.l === 'warn' ? ' WARN' : '';
        out.push(`[${_fmtTime(e.ts)}]${lv} ${e.t}`);
      }
      out.push('');
    });
    return out.join('\n');
  } catch (e) {
    console.warn('[崩溃日志] 拼文本失败:', (e && e.message) || e);
    return '';
  } finally {
    try { db && db.close(); } catch (_) {}
  }
}

/**
 * 把存档导出成 txt 文件（APK 里走 AndroidDownload，落到手机下载目录）。
 * 在 vConsole 命令行敲 `dumpCrashLogs()` 就能跑 —— 挂在 window 上（见 main.js）。
 */
export async function dumpCrashLogs() {
  try {
    const txt = await crashLogsAsText();
    if (!txt) { toast('还没有存档的崩溃日志'); return false; }
    const name = 'xinye-crashlog-' + _stamp() + '.txt';
    const ok = await saveFile(new Blob([txt], { type: 'text/plain;charset=utf-8' }), name);
    toast(ok ? '崩溃日志已导出：' + name : '导出失败');
    return !!ok;
  } catch (e) {
    console.warn('[崩溃日志] 导出失败:', (e && e.message) || e);
    toast('导出失败');
    return false;
  }
}
