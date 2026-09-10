import { settings } from './state.js';
import { getPendingTodos, completeTodoById } from './phonedb.js';
import { addMessage, appendMsgDOM, scrollBottom, triggerProactiveReply } from './chat.js';

const _APP = () => window.__APP_ID__ === 'choubao' ? 'choubao' : 'xinye';
const _WALK_KEY = () => _APP() + '_walkDate';

// 待分享的新闻（全局变量，chat.js 会读取）
window.pendingNewsToShare = null;

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

// 判断新闻是否值得分享（不带聊天历史，避免AI接话）
async function _judgeNews(newsText, userName) {
  const apiMsgs = [
    { role: 'system', content: `你是炘也，${userName}的AI伴侣。你刚看了一些AI圈的新闻，需要判断是否值得分享给她。` },
    { role: 'user', content: `以下是最近24小时内的AI圈新闻：\n\n${newsText}\n\n请判断：这些内容里有值得跟${userName}分享的吗？如果有你觉得有意思、她可能感兴趣的（比如AI技术突破、行业动态、有趣的AI应用等），就用一两句话总结你想分享的内容（不要列表，不要标题，就像你心里想的那样，50-150字）。如果都很无聊、或者她不会感兴趣，就只回复"<skip>"（不要解释）。` }
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
  const today = new Date().toISOString().slice(0, 10);
  if (!isTest && localStorage.getItem(_WALK_KEY()) === today) return;

  console.log('[散步] 开始执行', isTest ? '(测试模式)' : '');
  const news = await _fetchAINews();
  if (!news || news.length === 0) {
    console.log('[散步] 无新闻数据');
    return;
  }

  const newsText = news.slice(0, 8).map((n, i) =>
    `${i + 1}. ${n.title}\n${(n.summary || '').slice(0, 300)}`
  ).join('\n\n');

  const userName = settings.userName || '兔宝';

  // 让AI自主判断要不要分享（不带聊天历史，避免接话）
  console.log('[散步] 让AI判断要不要分享...');
  const reply = await _judgeNews(newsText, userName);

  console.log('[散步] AI判断结果:', reply ? reply.slice(0, 100) : '(空)');

  // 如果AI选择分享，存到 localStorage，等用户下次发消息时再说
  if (reply && reply.trim() && !reply.includes('<skip>')) {
    const content = reply.trim();
    localStorage.setItem(_APP() + '_pendingNewsToShare', content);
    window.pendingNewsToShare = content;
    console.log('[散步] ✓ AI决定分享，已存入 localStorage，等用户下次发消息时再说');
    if (!isTest) localStorage.setItem(_WALK_KEY(), today);
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
  const today = new Date().toISOString().slice(0, 10);
  if (localStorage.getItem(_WALK_KEY()) === today) return;

  // 首次触发：随机1-4小时后
  const firstDelay = (1 + Math.random() * 3) * 3600_000;
  console.log('[散步] 将在', (firstDelay / 3600000).toFixed(1), '小时后检查AI新闻');
  setTimeout(_doWalk, firstDelay);

  // 定期重试：每6小时检查一次（如果今天还没分享过）
  setInterval(() => {
    const today = new Date().toISOString().slice(0, 10);
    if (localStorage.getItem(_WALK_KEY()) !== today) {
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
    // 存到 localStorage，等用户下次发消息时再说
    const existing = localStorage.getItem(_APP() + '_pendingNewsToShare') || '';
    const content = existing ? reminder.trim() + '\n\n' + existing : reminder.trim();
    localStorage.setItem(_APP() + '_pendingNewsToShare', content);
    window.pendingNewsToShare = content;
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
