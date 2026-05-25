import { settings } from './state.js';
import { mainApiFetch } from './api.js';
import { getPendingTodos, completeTodoById } from './phonedb.js';
import { addMessage, appendMsgDOM, scrollBottom } from './chat.js';

const _APP = () => window.__APP_ID__ === 'choubao' ? 'choubao' : 'xinye';
const _WALK_KEY = () => _APP() + '_walkDate';

const TOPICS = [
  'interesting weird news today',
  'fascinating science discovery this week',
  'heartwarming viral story today',
  'unusual strange event happened today',
  'funny surprising news today',
  'amazing animal nature discovery recent',
  'incredible human achievement story today',
  'bizarre unexplained mystery recent news',
];

async function _search(key) {
  const query = TOPICS[Math.floor(Math.random() * TOPICS.length)];
  console.log('[散步] Tavily搜索 query:', query);
  try {
    const r = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: key, query, search_depth: 'basic', topic: 'news', days: 2, max_results: 5 }),
    });
    if (!r.ok) {
      console.warn('[散步] Tavily HTTP', r.status, r.statusText);
      return null;
    }
    const d = await r.json();
    console.log('[散步] Tavily返回', d.results?.length || 0, '条结果');
    const out = (d.results || []).slice(0, 4).map((item, i) => {
      const content = (item.content || item.snippet || '').slice(0, 400);
      return `${i + 1}. ${item.title}\n${content}`;
    }).join('\n\n') || null;
    if (out) console.log('[散步] 搜索素材(前200字):', out.slice(0, 200));
    else console.warn('[散步] 搜索结果为空');
    return out;
  } catch (e) {
    console.error('[散步] Tavily搜索失败:', e.message || e);
    return null;
  }
}

async function _readStream(res) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const line of dec.decode(value, { stream: true }).split('\n')) {
        if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
        try { text += JSON.parse(line.slice(6)).choices?.[0]?.delta?.content || ''; } catch {}
      }
    }
  } catch {}
  return text.trim();
}

async function _addMsgAndShow(reply) {
  const msg = await addMessage('assistant', reply);
  await appendMsgDOM(msg);
  scrollBottom();
}

async function _doWalk(isTest = false) {
  if (!isTest && !settings.morningWalkEnabled) return;
  const today = new Date().toISOString().slice(0, 10);
  if (!isTest && localStorage.getItem(_WALK_KEY()) === today) return;

  const goHour = 8 + Math.floor(Math.random() * 2);
  const goMin = String(Math.floor(Math.random() * 60)).padStart(2, '0');
  const userName = settings.userName || '兔宝';

  console.log('[散步] 开始执行, braveKey:', settings.braveKey ? '有值' : '空', isTest ? '(测试模式)' : '');
  const results = settings.braveKey ? await _search(settings.braveKey) : null;
  console.log('[散步] 搜索结果:', results ? '有内容' : '无(走fallback)');

  const userContent = results
    ? `[系统提示：你今天早上${goHour}:${goMin}独自出门溜达了一圈，在网络上刷到了一些有趣的新闻和见闻，现在回来了。下面是你在网上刷到的真实内容，请严格只基于这些内容讲述，禁止使用你自己的知识编造或补充任何信息：\n\n${results}\n\n请用你自己的语气，自然地把其中1-2件最有趣的事告诉${userName}，就像随口说起一样，不要用列表、不要加标题、不要解释这是搜索结果。必须是上面素材里有的事，不能编。字数控制在150字以内。]`
    : `[系统：你今天早上${goHour}:${goMin}出去溜达了一圈，刚回来。随口和${userName}说一句话，就像刚进门一样，轻松自然，50字以内。]`;

  console.log('[散步] 发送给模型的prompt(前150字):', userContent.slice(0, 150));
  const res = await mainApiFetch({
    stream: true,
    max_tokens: results ? 400 : 150,
    messages: [
      { role: 'system', content: settings.systemPrompt || '' },
      { role: 'user', content: userContent },
    ],
  });

  if (!res || !res.ok) {
    console.error('[散步] API请求失败', res?.status);
    return;
  }

  const reply = await _readStream(res);
  console.log('[散步] 模型回复:', reply || '(空)');
  if (reply) {
    await _addMsgAndShow(reply);
    if (!isTest) localStorage.setItem(_WALK_KEY(), today);
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

  const now = new Date();
  const h = now.getHours();
  if (h < 8) {
    const delay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 8, Math.floor(Math.random() * 30), 0) - now;
    setTimeout(_doWalk, delay);
  } else {
    setTimeout(_doWalk, 3000 + Math.random() * 5000);
  }
}

async function _fireReminder(todo) {
  if (window.isRequesting) return;
  const typing = document.querySelector('#typingIndicator');
  const btnSend = document.querySelector('#btnSend');
  window.isRequesting = true;
  if (btnSend) btnSend.disabled = true;
  if (typing) typing.classList.add('show');
  try {
    const userName = settings.userName || '兔宝';
    const res = await mainApiFetch({
      stream: true,
      max_tokens: 150,
      messages: [
        { role: 'system', content: settings.systemPrompt || '' },
        { role: 'user', content: `[系统：你之前帮${userName}记了这件事：「${todo.content}」，现在时间到了，请自然地提醒她，用你自己的语气，就像随口说起一样，不超过60字。]` },
      ],
    });
    if (!res || !res.ok) return;
    const reply = await _readStream(res);
    if (reply) {
      await _addMsgAndShow(reply);
      await completeTodoById(todo.id);
    }
  } finally {
    window.isRequesting = false;
    if (btnSend) btnSend.disabled = false;
    if (typing) typing.classList.remove('show');
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
