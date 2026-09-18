// 没画完的活 —— 一个极小的账本
//
// 为什么要有它（2026-09-18 兔宝撞上的）：画图是「在内存里跑、最后一步才落库」——
// 一张图要画十几秒到一分钟，这中间**刷新 / 闪退 / 被系统杀后台**，图就白丢了，
// 而且一声不响：钱花了、提示词没了、聊天里连个气泡都没有。
// 她那天就是这么丢了一张（09:24:55 开始画，09:25:24 拿到链接，09:25:29 刷新）。
//
// 规矩：**开工前先记账，拿到链接补记，画完销账**。APP 启动时把还挂在账上的接着做完 ——
// 有链接就只重新下载（不重复花钱），没链接才重画。
//
// 🔴 「失败」分两种，别搞混：
//    · **她看得见的失败**（聊天里画图，有 toast）→ 销账。别下次开机又偷偷给她画一张、再收一次钱。
//    · **悄悄失败**（主动消息配图 / 碎碎念配图，本来就不弹东西）→ 记一次，下次开机再试，试够就销账。
//    只有"被硬中断"（刷新 / 闪退 / 杀后台）才会**原样留在账上**，而且带链接的那种只需重新下载。
//
// ⚠️ 三种画图都走这本账：聊天里画（kind=chat）、主动消息配图（proactive）、碎碎念配图（post）。
//    它们各自的"收尾"不一样（落气泡 / 落手机相册），所以续账由各自的模块负责，这里只管记账。
//
// ⚠️ 用 localStorage 而不是 IDB —— 它要能在 IDB 打不开、模块还没初始化完的时候也写得进去。
const KEY = 'draw_pending';
const MAX_AGE_MS = 2 * 3600 * 1000;   // 超过两小时还没画完就算了，别哪天开机把昨天的图重画一遍
const MAX_TRIES  = 2;                 // 悄悄失败的那种最多再试一次，免得 API 坏了每次开机都烧钱
const MAX_JOBS   = 5;

function _read() {
  try {
    const list = JSON.parse(localStorage.getItem(KEY) || '[]');
    return Array.isArray(list) ? list : [];
  } catch { return []; }
}

function _write(list) {
  try { localStorage.setItem(KEY, JSON.stringify(list.slice(-MAX_JOBS))); } catch {}
}

/** 开工前记一笔。返回账本 id，之后拿它补链接 / 销账。 */
export function pendAdd(job) {
  try {
    const now = Date.now();
    const id = 'pd_' + now + '_' + Math.random().toString(36).slice(2, 6);
    const list = _read().filter(j => j && j.id && now - (j.ts || 0) < MAX_AGE_MS);
    list.push(Object.assign({}, job, { id, ts: now, tries: 0, url: '' }));
    _write(list);
    return id;
  } catch { return ''; }
}

/** 拿到图片链接的那一刻补记 —— 这是整本账最值钱的一行：
 *  有了它，中断之后只需重新下载，不用再花一次画图的钱。 */
export function pendSetUrl(id, url) {
  if (!id || !url) return;
  const list = _read();
  const j = list.find(x => x.id === id);
  if (!j) return;
  j.url = String(url);
  _write(list);
}

/** 画完了、也落库了 —— 销账。 */
export function pendDone(id) {
  if (!id) return;
  _write(_read().filter(j => j.id !== id));
}

/** 悄悄失败了（她看不见的那种）—— 记一次，还留着就是下次再试，试够了就销账。 */
export function pendBump(id) {
  if (!id) return;
  const list = _read();
  const j = list.find(x => x.id === id);
  if (!j) return;
  j.tries = (j.tries || 0) + 1;
  _write(j.tries >= MAX_TRIES ? list.filter(x => x.id !== id) : list);
}

/** 启动时取还挂在账上、也没过期的活。顺手清掉过期的和试够了的。 */
export function pendFreshJobs() {
  const now = Date.now();
  const all = _read();
  const fresh = all.filter(j => j && j.id && j.prompt
    && now - (j.ts || 0) < MAX_AGE_MS && (j.tries || 0) < MAX_TRIES);
  if (fresh.length !== all.length) _write(fresh);
  return fresh;
}
