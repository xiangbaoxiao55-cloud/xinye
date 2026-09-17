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
import { buildServerFetchUrl, buildServerHeaders } from './settings.js';

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
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 30000);
  try {
    const r = await fetch(fetchUrl, { method: 'POST', headers, body: JSON.stringify({ url: linkUrl }), signal: ac.signal });
    if (!r.ok) return { ok: false, reason: 'http_' + r.status };
    return await r.json();
  } finally { clearTimeout(timer); }
}

// 小红书正文常常很短、内容全在图里，所以顺带让识图看一眼（最多 3 张，尽力而为）
async function _describeImages(urls) {
  if (!settings.visionApiKey || !window.describeImagesWithVision || !urls || !urls.length) return null;
  try {
    const descs = await window.describeImagesWithVision(urls.slice(0, 3));
    return descs && descs.some(Boolean) ? descs : null;
  } catch (e) { console.warn('[读链接] 识图失败（不影响正文）', e); return null; }
}

// 拿到链接的原始数据（不排版）。微信优先走本地，其余优先走云端。
export async function readLink(url) {
  const isWx = /mp\.weixin\.qq\.com/i.test(url);
  const kinds = isWx ? ['local', 'cloud'] : ['cloud', 'local'];
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
export function formatLinkContext(data, imagesDesc) {
  const who = settings.userName || '兔宝';
  if (!data || !data.ok) {
    const why = REASON_TEXT[(data && data.reason) || ''] || ('读取失败（' + ((data && data.reason) || '未知') + '）');
    return `【${who}发来了一条链接，但我没读到内容：${why}】`;
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
  if (imagesDesc) {
    L.push('图上的内容（AI 识图，共 ' + (data.images || []).length + ' 张，看了前 ' + imagesDesc.length + ' 张）：');
    imagesDesc.forEach((d, i) => { if (d) L.push(`  图${i + 1}：${d}`); });
  } else if (data.images && data.images.length) {
    L.push(`（这条带 ${data.images.length} 张图，但没有识图结果，我不知道图里画了什么）`);
  }
  if (data.comments && data.comments.length) {
    L.push(`评论（共 ${data.commentTotal || data.comments.length} 条，这是前 ${data.comments.length} 条）：`);
    data.comments.slice(0, 8).forEach(c => L.push(`  · ${c.user ? c.user + '：' : ''}${c.text}${c.ip ? '（' + c.ip + '）' : ''}`));
  }
  return L.join('\n');
}

// 一步到位：读 + 识图 + 排版。失败也返回一段说明文字。
export async function readLinkAsContext(url) {
  const data = await readLink(url);
  let desc = null;
  if (data && data.ok && data.platform === 'xiaohongshu' && data.images && data.images.length) {
    desc = await _describeImages(data.images);
  }
  return formatLinkContext(data, desc);
}

// 给炘也的 fetch_page 工具用：拿到一段尽量完整的网页文字
export async function fetchPageAsText(url) {
  const data = await readLink(url);
  if (!data || !data.ok) {
    const why = REASON_TEXT[(data && data.reason) || ''] || ((data && data.reason) || 'unknown');
    return 'Fetch failed: ' + why;
  }
  return formatLinkContext(data, null);
}
