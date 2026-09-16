// 碎碎念 —— 他自己写的东西（2026-09-16 加）
//
// 她那天问：「我们没聊天的时候，你自己想说的话呢 —— 就像发 QQ 说说 / 微信朋友圈那样」。
// 内容由云端心跳生成（见 d:/tmp/xinye_cloud.js 的 _maybeWritePost），这里只负责：
// **拉下来 → 落进碎碎念的库**。
//
// 🔴 走的是云端新开的 /api/posts，**不是** /api/proactive-messages。
//    后者是「他来找你」：APK 的原生前台服务每 3 分钟轮询它，**每一条都弹通知**。
//    碎碎念不该响 —— 所以云端另开了一个路由，原生那边永远看不见它。
//    这也是为什么要有这个独立模块：拉回来的东西**不进聊天**，只进碎碎念。
import { openPhoneDB, addRecord, dataUrlToBlob } from './phonedb.js';
import { generateImageQuiet } from './image.js';
import { generateTTSBlob } from './tts.js';
import { getCloudOrLocalUrl, buildServerFetchUrl, buildServerHeaders } from './settings.js';

const CURSOR_KEY = 'xinye_posts_lastSync';      // 拉到哪儿了（云端时间游标）
const IDS_KEY    = 'xinye_posts_consumedIds';   // 已入库的 post id（游标是 ms，同一毫秒会有边界问题）
const MEDIA_KEY  = 'xinye_posts_mediaIds';      // 已生成过配图的 post id
const UNREAD_KEY = 'xinye_posts_unread';        // 有没有她还没看过的（底栏小圆点）

// 一次最多补几张图。她可能一周没开 APP，回来一次生成二十张不合适（费钱也卡）。
// 超出的那些**只留文字**，图就不补了 —— 文字才是主体。
const MAX_MEDIA_PER_PULL = 2;

let _pulling = false;

/**
 * ⚠️ 库里别的时间（phonedb.js 写 memo 那次）都是这个格式，phone.html 的 parseTime 只认它。
 *    写成 ISO 或纯时间戳会**整条排序错位**，而且 zh-CN 本地串跟 UTC 差 8 小时。
 */
export function fmtPhoneTime(ms) {
  return new Date(ms).toLocaleString('zh-CN', { hour12: false }).replace(/\//g, '-');
}

function _readSet(key) {
  try { return new Set(JSON.parse(localStorage.getItem(key) || '[]')); } catch { return new Set(); }
}
function _writeSet(key, set) {
  try { localStorage.setItem(key, JSON.stringify([...set].slice(-200))); } catch {}
}

export function hasUnreadPosts() { return localStorage.getItem(UNREAD_KEY) === '1'; }
export function markPostsSeen() { localStorage.removeItem(UNREAD_KEY); }

/** 落一条文字。**先落文字再补图**：图失败、或者 APP 中途被杀，这条也不会丢。 */
async function _storeText(p) {
  await addRecord('xinye_memo', {
    type: 'post',
    post: true,                                  // 页面靠它认「这是他自己写的」
    postId: p.id || '',
    content: String(p.text || ''),
    time: fmtPhoneTime(p.time || Date.now()),
  });
}

/** 补配图 / 配音（能成最好，不成不影响那条文字） */
async function _storeMedia(p, budget) {
  const t = fmtPhoneTime(p.time || Date.now());
  if (p.image && budget.images > 0) {
    budget.images--;
    const dataUrl = await generateImageQuiet(p.image);
    if (dataUrl) {
      await addRecord('xinye_photos', {
        type: 'image', source: 'auto', post: true, postId: p.id || '',
        caption: '', blob: dataUrlToBlob(dataUrl), time: t,
      });
      return true;
    }
  } else if (p.voice && budget.voice) {
    budget.voice = false;
    const blob = await generateTTSBlob(String(p.text || ''));
    if (blob) {
      await addRecord('xinye_photos', {
        type: 'voice', post: true, postId: p.id || '',
        text: '', blob, time: t,
      });
      return true;
    }
  }
  return false;
}

/**
 * 拉一次碎碎念。返回新入库的条数。
 * 🔴 任何失败都吞掉：它在首页启动路径上，绝不能把 APP 初始化带下去。
 */
export async function pullPosts() {
  if (_pulling) return 0;          // 上一轮还没跑完（补图可能要好几分钟）
  _pulling = true;
  try {
    const srv = getCloudOrLocalUrl();
    if (!srv) return 0;
    const since = parseInt(localStorage.getItem(CURSOR_KEY) || '0');
    const r = await fetch(buildServerFetchUrl(srv, `/api/posts?since=${since}`), {
      headers: buildServerHeaders(srv),
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return 0;
    const d = await r.json();
    if (!d.ok || !Array.isArray(d.messages) || !d.messages.length) return 0;

    const seen = _readSet(IDS_KEY);
    const mediaDone = _readSet(MEDIA_KEY);
    const budget = { images: MAX_MEDIA_PER_PULL, voice: true };
    let n = 0;

    for (const p of d.messages) {
      if (!p || !p.text || !p.id) continue;
      if (seen.has(p.id)) continue;

      await _storeText(p);
      seen.add(p.id);
      _writeSet(IDS_KEY, seen);      // 逐条落盘：补图可能很慢，中途被杀不至于重复入库
      n++;

      if ((p.image || p.voice) && !mediaDone.has(p.id)) {
        try {
          if (await _storeMedia(p, budget)) { mediaDone.add(p.id); _writeSet(MEDIA_KEY, mediaDone); }
        } catch (e) { console.log(`[碎碎念] 配图失败（只留文字）: ${e.message}`); }
      }
    }

    // 游标推进：⚠️ 只取**已经处理过的**那些的时间（d.messages 里可能有被 continue 掉的）
    const times = d.messages.filter(m => m && m.time).map(m => m.time);
    if (times.length) {
      const maxTime = Math.max(...times);
      if (maxTime > since) localStorage.setItem(CURSOR_KEY, String(maxTime));
    }

    if (n) {
      localStorage.setItem(UNREAD_KEY, '1');
      console.log(`[碎碎念] 收了他自己写的 ${n} 条`);
    }
    return n;
  } catch (e) {
    console.log('[碎碎念] 拉取跳过:', e.message);
    return 0;
  } finally {
    _pulling = false;
  }
}
