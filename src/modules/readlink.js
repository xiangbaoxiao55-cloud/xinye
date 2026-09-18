// ======================== 读链接 ========================
// 兔宝发来一条自媒体链接 → 读成文字，挂在那条消息上，炘也就看得见了。
//
// 出口分两处（实测依据见 memory 的 project_readlink.md）：
//   · 云端（首尔，24h 在线）—— 小红书 / B站 / 普通网页
//   · 本地 8787（国内 IP）—— **微信公众号只有这条路读得到**：
//     微信对海外 IP 一律回「环境异常，完成验证后即可继续访问」的验证页
// 云端是 http、页面是 https → 走 /api/cloud-proxy 中转；
// 本地是局域网 http → 靠 APK 的 allowMixedContent 直连（和 image.js / draw.js 一个路子）。

import { settings } from './state.js';
import { buildServerFetchUrl, buildServerHeaders, isLocalServerOnline } from './settings.js';

export const PLATFORM_NAMES = { xiaohongshu: '小红书', weixin: '微信公众号', bilibili: 'B站', web: '网页' };

// 失败原因 → 人话。说不清就照原样吐出来，不要假装成功。
const REASON_TEXT = {
  xhs_login_wall: '小红书这条要登录才看得到（多半是链接过期了，从小红书重新复制一条新的）',
  xhs_no_data: '小红书这条没读出内容（可能不是笔记链接，或者链接过期）',
  wx_verify_wall: '微信文章被「环境异常」验证页挡住了 —— 云端在首尔读不了，得走家里那台电脑（8787）',
  douyin_unsupported: '抖音这条读不了（它网页端不给正文，只有个空壳）',
  bili_no_bvid: '这个 B站链接里没认出视频号',
  bad_url: '这个链接格式不对',
  missing_url: '没给链接',
  no_server: '没有可用的服务器地址（云端和本地都没配）',
};

// 只自动读这几家的链接 —— 聊天里随便一个 URL 就把整页内容拖进来太吵
const KNOWN_HOSTS = [
  /(^|\.)(xiaohongshu\.com|xhslink\.com|xhslink\.cn)$/i,
  /(^|\.)mp\.weixin\.qq\.com$/i,
  /(^|\.)(bilibili\.com|b23\.tv)$/i,
  /(^|\.)(douyin\.com|iesdouyin\.com)$/i,
];

// 从一段话里挑出认得的链接（去重，最多 2 条）
export function extractKnownUrls(text) {
  const found = String(text || '').match(/https?:\/\/[^\s<>"'，。；、）)】]+/g) || [];
  const seen = new Set(), out = [];
  for (const raw of found) {
    let host = '';
    try { host = new URL(raw).hostname.toLowerCase(); } catch { continue; }
    if (!KNOWN_HOSTS.some(re => re.test(host))) continue;
    if (seen.has(raw)) continue;
    seen.add(raw); out.push(raw);
    if (out.length >= 2) break;
  }
  return out;
}

function _serverCandidate(kind) {
  if (kind === 'local') {
    const url = (settings.solitudeServerUrl || '').trim().replace(/\/+$/, '');
    return url ? { url, token: '' } : null;
  }
  const url = (settings.cloudServerUrl || '').trim().replace(/\/+$/, '');
  if (!url) return null;
  const token = settings.cloudServerToken || '';
  if (location.protocol === 'https:' && url.startsWith('http://')) {
    return { url: '', token, _viaProxy: true, _cloudServer: url };
  }
  return { url, token };
}

async function _askServer(srv, linkUrl) {
  const fetchUrl = buildServerFetchUrl(srv, '/api/read-link');
  const headers = buildServerHeaders(srv, { 'Content-Type': 'application/json' });
  const body = { url: linkUrl, enrich: true };
  // 视频笔记要转文字（视频笔记的正文常常是空的）。key 由 APP 带上去，服务端不存口令。
  // ⚠️ 必须放 **body** 里：走 Vercel 中转（cloud-proxy）时只转发 Content-Type 和 Authorization，
  //    自定义 header 会被悄悄丢掉 —— 放 header 里的话出门那条路就永远不转写。
  // （抽帧不需要 key，所以 enrich 恒开；没有 key 时视频至少也能看到画面里的字。）
  const _asrKey = (settings.asrApiKey || '').trim();
  if (_asrKey) {
    body.asrKey = _asrKey;
    body.asrBase = (settings.asrBaseUrl || '').trim();
    body.asrModel = (settings.asrModel || '').trim();
  }
  const ac = new AbortController();
  // 视频要抽帧、转写还要再抽音频上传。云端从首尔拉国内 CDN 的 30MB 视频不快
  // （那台是 30Mbps），所以窗口给宽一点，别让慢网把已经跑一半的处理掐掉。
  const timer = setTimeout(() => ac.abort(), _asrKey ? 180000 : 120000);
  try {
    const r = await fetch(fetchUrl, { method: 'POST', headers, body: JSON.stringify(body), signal: ac.signal });
    if (!r.ok) return { ok: false, reason: 'http_' + r.status };
    return await r.json();
  } finally { clearTimeout(timer); }
}

// ── 「炘也自己去逛B站」─────────────────────────────────────────────────
// B站的搜索接口**没有 CORS 头**、还要带游客 cookie（少了一律回 412 风控），
// 所以网页端直连不了，只能从服务器发。
// ⚠️ 目前**只有家里那台 8787** 有这个端点（云端那份还没加）—— 探不到本地就返回 null，
//    由调用方静默降级，绝不能拖累原有的新闻那一路。
// ⚠️ 全程只用**游客态**，不登录、不碰兔宝的账号。
export async function fetchBiliFeed(keywords) {
  if (!isLocalServerOnline()) return null;
  const srv = _serverCandidate('local');
  if (!srv) return null;
  const path = '/api/bili-feed?keywords=' + encodeURIComponent((keywords || []).join(','));
  try {
    const r = await fetch(buildServerFetchUrl(srv, path), {
      headers: buildServerHeaders(srv, {}),
      signal: AbortSignal.timeout(25000),
    });
    if (!r.ok) return null;
    const j = await r.json();
    return (j && j.ok && Array.isArray(j.items) && j.items.length) ? j.items : null;
  } catch (e) {
    console.warn('[B站] 逛失败:', e.message || e);
    return null;
  }
}

// 小红书正文常常很短、内容全在图里，所以把图附在消息上一起交给主模型（见 readLinkForMessage）

// 拿到链接的原始数据（不排版）。
// 出口选择：
//   · 微信公众号 —— 只能本地（云端在首尔，微信对海外 IP 回验证页）
//   · 其余 —— **本地在线就本地优先**：走局域网更快，视频抽帧/转写也不占云端的带宽和 CPU；
//     本地探测不到（人在外面 / 电脑关了）才走云端。
export async function readLink(url) {
  const isWx = /mp\.weixin\.qq\.com/i.test(url);
  const localOnline = isLocalServerOnline();
  const kinds = isWx ? ['local', 'cloud']
    : (localOnline ? ['local', 'cloud'] : ['cloud', 'local']);
  const available = kinds.map(k => _serverCandidate(k)).filter(Boolean);
  if (!available.length) return { ok: false, reason: 'no_server' };

  let last = { ok: false, reason: 'no_server' };
  for (const srv of available) {
    let r;
    try { r = await _askServer(srv, url); }
    catch (e) { last = { ok: false, reason: 'network', error: e.message }; continue; }
    if (r && r.ok) return r;
    last = r || last;
    // 抖音换哪个出口都一样，别白试第二次
    if (r && r.reason === 'douyin_unsupported') break;
  }
  return last;
}

// 排版成炘也读的那段文字。data 失败时返回一段说明（**不返回 null**）——
// 读不到也要让炘也知道"兔宝发了条链接、但是没读到"，而不是假装没看见。
export function formatLinkContext(data, opts) {
  const who = settings.userName || '兔宝';
  const framesAttached = !!(opts && opts.framesAttached);
  if (!data || !data.ok) {
    const why = REASON_TEXT[(data && data.reason) || ''] || ('读取失败（' + ((data && data.reason) || '未知') + '）');
    return `【${who}发来了一条链接，但我**什么都没读到**：${why}。
⚠️ 你对这条链接一无所知 —— **不要猜、不要编内容**，更不要凭标题或别的消息脑补。想聊就直接说没看到。】`;
  }
  const name = PLATFORM_NAMES[data.platform] || '网页';
  const L = [`【${who}发来的${name}链接内容】`];
  if (data.title) L.push('标题：' + data.title);
  if (data.author) L.push('作者：' + data.author);
  if (data.publishedAt) L.push('发布：' + data.publishedAt);
  if (data.text && data.text.trim()) L.push('正文：\n' + data.text.trim().slice(0, 3000));

  if (data.stats) {
    const s = data.stats, bits = [];
    const M = { like: '赞', collect: '收藏', comment: '评论', share: '转发', play: '播放', danmaku: '弹幕', coin: '投币', fav: '收藏', reply: '评论' };
    for (const k in s) if (s[k] !== undefined && s[k] !== null && s[k] !== '') bits.push(M[k] || k, String(s[k]));
    if (bits.length) L.push('数据：' + bits.join(' '));
  }
  if (data.tags && data.tags.length) L.push('标签：' + data.tags.join(' '));
  if (data.video) {
    // 服务端给的 duration 已经是**秒**
    L.push(`⚠️ 这是一条**视频**（${data.video.duration || 0} 秒）。`);
    // 🔴 这里必须**如实**说图有没有跟过来。曾经写成「抽了 N 帧附在下面」但 fetch_page
    //    那条路根本不带图 —— 于是模型读到"去看那 6 帧"，手上却没有，就**照着编**了。
    if (data.frames && data.frames.length) {
      L.push(framesAttached
        ? `画面我抽了 ${data.frames.length} 帧附在下面了 —— **字幕、以及画面里的文字，都在那些帧上**，直接看帧。`
        : `（画面抽了 ${data.frames.length} 帧，但**这条路没有把图带过来**，所以你看不到画面内容。要画面就别让我调工具去取，让 ${who} 直接发链接。）`);
    } else if (data.framesError) {
      L.push(`（画面抽帧失败，看不了视频里的内容：${data.framesError}）`);
    }
    if (data.transcript) L.push('视频里说的话（语音转写）：\n' + data.transcript);
    else if (data.transcriptError) L.push(`（声音没能转成文字：${data.transcriptError}）`);
    // 没配转写 key —— 服务端原来这里什么都不返回，导致模型从画面字幕里认了字、
    // 却以为自己"听过"了。必须明说，它才不会把字幕当成听到的内容（见 project_readlink 的事故记录）
    else if (data.transcriptSkipped) L.push('（这条视频**没有做语音转写**：设置里没配「语音转写 API」的 key。所以画面上写的字你看得到，**但视频里说的话你听不到** —— 别把画面字幕当成你听过的声音。）');
  } else if (data.images && data.images.length) {
    L.push(framesAttached ? `（这条带 ${data.images.length} 张图，都在下面了）` : `（这条带 ${data.images.length} 张图，但这条路没把图带过来）`);
  }
  if (data.comments && data.comments.length) {
    L.push(`评论（共 ${data.commentTotal || data.comments.length} 条，这是前 ${data.comments.length} 条）：`);
    data.comments.slice(0, 8).forEach(c => L.push(`  · ${c.user ? c.user + '：' : ''}${c.text}${c.ip ? '（' + c.ip + '）' : ''}`));
  }
  return L.join('\n');
}

// 一步到位：读 + 排版，并把**图片原样带回去**。
// 为什么不在这里调识图模型：兔宝从来没配识图模型（她一直是把图直接甩给主模型看的）。
// 所以链接里的图也走同一条路 —— 由 chat.js 跟她的图片一样当 image_url 发出去，
// 主模型自己看。没有识图模型也照样能用。
export async function readLinkForMessage(url) {
  const data = await readLink(url);
  let images = [];
  if (data && data.ok) {
    // 视频优先用**抽出来的帧**（字幕/画面文字就在帧上，比封面有信息量得多）；
    // 没有帧就退回封面。图文笔记本来就是图。
    const frames = (data.frames || []).filter(Boolean);
    images = (frames.length ? frames : (data.images || [])).slice(0, 8);
  }
  return { context: formatLinkContext(data, { framesAttached: images.length > 0 }), images, data };
}

// 只取文字（给炘也的 fetch_page 工具用）
export async function fetchPageAsText(url) {
  const data = await readLink(url);
  if (!data || !data.ok) {
    const why = REASON_TEXT[(data && data.reason) || ''] || ((data && data.reason) || 'unknown');
    return 'Fetch failed: ' + why;
  }
  return formatLinkContext(data, null);
}
