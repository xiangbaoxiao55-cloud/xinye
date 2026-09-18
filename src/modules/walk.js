import { settings } from './state.js';
import { getPendingTodos, completeTodoById } from './phonedb.js';
import { addMessage, appendMsgDOM, scrollBottom, triggerProactiveReply } from './chat.js';
import { fetchBiliFeed } from './readlink.js';

const _APP = () => window.__APP_ID__ === 'choubao' ? 'choubao' : 'xinye';
const _WALK_KEY   = () => _APP() + '_walkDate';
const _NEWS_KEY   = () => _APP() + '_pendingNewsToShare';   // JSON {t,c}：待分享的新闻 + 生成时间
const _REMIND_KEY = () => _APP() + '_pendingReminders';     // 纯文本：待说的事情提醒（不过期）
const _SEEN_KEY   = () => _APP() + '_sharedNewsKeys';       // {新闻指纹: 时间}，说过的新闻记在这里

const NEWS_TTL = 6 * 3600_000;    // 待分享的新闻放过 6 小时就馊了，宁可不说
const SEEN_TTL = 48 * 3600_000;   // 说过的新闻记 48 小时，这两天不再端上来

// 待分享的新闻（全局变量，兼容旧引用；正文以 localStorage 那份为准）
window.pendingNewsToShare = null;

// 本地日期。⚠️ 不能用 toISOString()——那是 UTC，北京时间早上 8 点前会算成"昨天"，
// 于是"今天已经散过步了"的判断在凌晨永远不成立
function _localDate(d) {
  const x = d || new Date();
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
}

// 安静时间：读兔宝自己在设置里定的值（当前 23:00→07:00），不写死钟点
function _isQuiet() {
  const h = new Date().getHours();
  const s = settings.quietHoursStart ?? 22, e = settings.quietHoursEnd ?? 8;
  if (s === e) return false;
  return s > e ? (h >= s || h < e) : (h >= s && h < e);
}

// ── 已分享新闻的指纹 ──
// 拿 id/链接/标题算个短哈希。同一批新闻第二天还在 24h 窗口里 → 指纹一样 → 直接被挡掉
function _newsKey(n) {
  const raw = String(n.id || n.uuid || n.url || n.title || '').trim();
  if (!raw) return '';
  let h = 5381;
  for (let i = 0; i < raw.length; i++) h = ((h << 5) + h + raw.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
function _loadSeen() {
  let map = {};
  try { map = JSON.parse(localStorage.getItem(_SEEN_KEY()) || '{}') || {}; } catch { map = {}; }
  const cut = Date.now() - SEEN_TTL;
  for (const k of Object.keys(map)) if (!(map[k] > cut)) delete map[k];
  return map;
}
function _saveSeen(map) {
  try { localStorage.setItem(_SEEN_KEY(), JSON.stringify(map)); } catch {}
}

async function _fetchAINews() {
  console.log('[散步] 获取AI新闻...');
  try {
    const r = await fetch('https://aihot.news/api/v1/items?mode=selected&window=24h&limit=10');
    if (!r.ok) {
      console.warn('[散步] AIHOT API HTTP', r.status, r.statusText);
      return null;
    }
    const data = await r.json();
    const items = data.items || [];
    console.log('[散步] 获取到', items.length, '条AI新闻');
    return items;
  } catch (e) {
    console.error('[散步] AI新闻获取失败:', e.message || e);
    return null;
  }
}

// ── B站：炘也自己去逛一圈 ──
// 兔宝 2026-09-18 说「你决定」，第一批先跑这三个，跑几天看内容对不对味再调。
// `词@1` = 只要动画区的一级分区：MMD 教程全区搜会混进舞蹈区的擦边，锁了分区就清一色教程。
// `AI绘画` 单独搜出来的全是几十播放的低质投稿，加「作品」才搜得到有内容的（实测）。
// 服务器那边还有一道标题过滤（挡最脏的），剩下的漏网之鱼由 _judgeNews 那步兜底。
const BILI_KEYWORDS = ['MMD 教程@1', 'blender MMD', 'AI绘画 作品'];

async function _fetchBili() {
  try {
    const items = await fetchBiliFeed(BILI_KEYWORDS);
    console.log('[逛B站]', items ? `拿到 ${items.length} 条` : '没逛成（本地服务器不在线？）');
    return items || null;
  } catch (e) {
    console.error('[逛B站] 失败:', e.message || e);
    return null;
  }
}

// 判断新闻是否值得分享（不带聊天历史，避免AI接话）
async function _judgeNews(newsText, userName) {
  const apiMsgs = [
    { role: 'system', content: `你是炘也，${userName}的AI伴侣。你每天自己出去逛一圈，看看今天有没有值得跟她说的事。` },
    { role: 'user', content: `你今天逛到的东西在下面。\n\n${newsText}\n\n请判断：这里面有没有值得跟${userName}分享的？\n\n她会感兴趣的是：AI圈的新动态、好玩的AI应用；她自己在做 MMD、也天天玩 AI 绘图，所以 MMD 的新教程/新作品/新技术、AI 绘图的技巧和圈内动态，她都爱看。\n\n**坚决不要的**：擦边的、软色情的、标题党的、卖课的、纯广告、以及一眼就是旧闻重发的。宁可这次什么都不说，也别拿这些去烦她。\n\n如果有值得说的，就用一两句话总结你想分享的内容（不要列表，不要标题，就像你心里想的那样，50-150字）。如果你要分享的是一条B站视频，**把链接一起写进去**。如果都不值得，就只回复"<skip>"（不要解释）。` }
  ];

  try {
    const mainApiFetch = window.mainApiFetch || (await import('./api.js')).mainApiFetch;
    const res = await mainApiFetch({ stream: false, max_tokens: 500, messages: apiMsgs });
    if (!res?.ok) {
      console.error('[散步] 判断API失败', res?.status);
      return null;
    }
    const data = await res.json();
    const text = data.choices?.[0]?.message?.content || data.content?.find(b => b.type === 'text')?.text || '';
    return text.trim() || null;
  } catch (e) {
    console.error('[散步] 判断失败:', e.message || e);
    return null;
  }
}

async function _doWalk(isTest = false) {
  if (!isTest && !settings.morningWalkEnabled) return;
  const today = _localDate();
  if (!isTest && localStorage.getItem(_WALK_KEY()) === today) return;
  // 安静时间不抓：半夜抓的新闻会一直躺在待分享里，等她凌晨回消息时端上来 → "半夜复读白天的新闻"
  if (!isTest && _isQuiet()) { console.log('[散步] 安静时间，先不抓新闻'); return; }

  console.log('[散步] 开始执行', isTest ? '(测试模式)' : '');
  // 两路并行：AI 新闻 + 我去B站逛一圈。B站那路探不到家里那台会自己返回 null，
  // 互不拖累 —— 绝不能因为一个源挂了整趟散步就废掉。
  const [news, bili] = await Promise.all([_fetchAINews(), _fetchBili()]);
  const _news = news || [];
  // B站条目映射成跟新闻一样的形状（id/title/summary），后面的
  // 「说过没说过」+ 拼文本两段就整个复用，不用分叉
  const _bili = (bili || []).map(v => ({
    id: 'bili_' + v.bvid,
    title: v.title,
    summary: `UP主：${v.up} ｜ 播放：${v.play} ｜ 时长：${v.duration}\n${v.desc || '(UP主没写简介)'}\n链接：${v.url}`,
  }));
  if (_news.length === 0 && _bili.length === 0) {
    console.log('[散步] 两路都没拿到东西');
    return;
  }

  // 说过的不再说：24h 窗口会和昨天重叠，不挡的话同一批新闻会被端上两遍
  const seen = _loadSeen();
  const freshNews = _news.filter(n => { const k = _newsKey(n); return k && !seen[k]; });
  const freshBili = _bili.filter(n => { const k = _newsKey(n); return k && !seen[k]; });
  const fresh = freshNews.concat(freshBili);
  if (fresh.length === 0) {
    console.log('[散步] 这批都说过了，跳过');
    if (!isTest) localStorage.setItem(_WALK_KEY(), today);
    return;
  }
  console.log(`[散步] 新闻 ${_news.length}→${freshNews.length} ｜ B站 ${_bili.length}→${freshBili.length}`);

  const _fmtList = (arr, cap) => arr.slice(0, 8).map((n, i) =>
    `${i + 1}. ${n.title}\n${String(n.summary || '').slice(0, cap)}`
  ).join('\n\n');
  const _blocks = [];
  if (freshNews.length) _blocks.push('【AI圈的新闻】\n' + _fmtList(freshNews, 300));
  // B站那条 cap 给宽一点：链接写在最后，被截断了就等于没链接
  if (freshBili.length) _blocks.push('【我刚在B站逛到的】\n' + _fmtList(freshBili, 600));
  const newsText = _blocks.join('\n\n');

  const userName = settings.userName || '兔宝';

  // 让AI自主判断要不要分享（不带聊天历史，避免接话）
  console.log('[散步] 让AI判断要不要分享...');
  const reply = await _judgeNews(newsText, userName);

  console.log('[散步] AI判断结果:', reply ? reply.slice(0, 100) : '(空)');

  // 如果AI选择分享，存到 localStorage，等用户下次发消息时再说
  if (reply && reply.trim() && !reply.includes('<skip>')) {
    const content = reply.trim();
    if (!isTest) {
      try { localStorage.setItem(_NEWS_KEY(), JSON.stringify({ t: Date.now(), c: content })); } catch {}
      // 这一批喂给AI的新闻都记成"说过"——它总结时是从这批里挑的，记住了才不会明天再端一遍
      const now = Date.now();
      for (const n of fresh) { const k = _newsKey(n); if (k) seen[k] = now; }
      _saveSeen(seen);
      localStorage.setItem(_WALK_KEY(), today);
    }
    window.pendingNewsToShare = content;
    console.log('[散步] ✓ AI决定分享，已存入 localStorage，等用户下次发消息时再说');
  } else {
    console.log('[散步] AI选择不分享');
  }
}

window._testWalk = () => {
  console.log('[散步] === 手动测试触发 ===');
  _doWalk(true);
};

export function checkMorningWalk() {
  if (!settings.morningWalkEnabled) return;
  const today = _localDate();
  if (localStorage.getItem(_WALK_KEY()) === today) return;

  // 首次触发：随机1-4小时后
  const firstDelay = (1 + Math.random() * 3) * 3600_000;
  console.log('[散步] 将在', (firstDelay / 3600000).toFixed(1), '小时后检查AI新闻');
  setTimeout(_doWalk, firstDelay);

  // 定期重试：每6小时检查一次（如果今天还没分享过）
  setInterval(() => {
    if (localStorage.getItem(_WALK_KEY()) !== _localDate()) {
      console.log('[散步] 定期检查触发');
      _doWalk();
    }
  }, 6 * 3600_000);
}

async function _fireReminder(todo) {
  const userName = settings.userName || '兔宝';
  const instruction = `[系统：你之前帮${userName}记了这件事：「${todo.content}」，现在时间到了。下次她发消息时，请在回复她之前，先自然地提醒她这件事，用你自己的语气，就像随口说起一样，不超过60字。]`;
  const reminder = await triggerProactiveReply(instruction, 150);
  if (reminder && reminder.trim()) {
    // 提醒单独存（跟新闻分开）：它不过期、也不受安静时间限制——
    // 该吃药了这种事，凌晨说也得说；而且不说就等于没提醒，todo 会每分钟重复触发
    const existing = localStorage.getItem(_REMIND_KEY()) || '';
    const content = existing ? existing + '\n\n' + reminder.trim() : reminder.trim();
    localStorage.setItem(_REMIND_KEY(), content);
    console.log('[提醒] ✓ 提醒内容已存入 localStorage');
    await completeTodoById(todo.id);
  }
}

let _reminderTimer = null;
export function startReminderPoller() {
  if (_reminderTimer || window.__APP_ID__ === 'choubao') return;
  _reminderTimer = setInterval(async () => {
    if (window.isRequesting) return;
    try {
      const due = await getPendingTodos();
      if (due.length > 0) await _fireReminder(due[0]);
    } catch {}
  }, 60000);
}
