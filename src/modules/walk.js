import { settings } from './state.js';
import { addMessage } from './chat.js';
import { mainApiFetch } from './api.js';

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
  try {
    const r = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: key, query, search_depth: 'basic', topic: 'news', max_results: 5 }),
    });
    if (!r.ok) return null;
    const d = await r.json();
    return (d.results || []).slice(0, 4).map((item, i) => {
      const content = (item.content || item.snippet || '').slice(0, 400);
      return `${i + 1}. ${item.title}\n${content}`;
    }).join('\n\n') || null;
  } catch { return null; }
}

async function _doWalk() {
  if (!settings.morningWalkEnabled || !settings.braveKey) return;
  const today = new Date().toISOString().slice(0, 10);
  if (localStorage.getItem(_WALK_KEY()) === today) return;

  const results = await _search(settings.braveKey);
  if (!results) return;

  const goHour = 8 + Math.floor(Math.random() * 2);
  const goMin = String(Math.floor(Math.random() * 60)).padStart(2, '0');
  const userName = settings.userName || '兔宝';

  const res = await mainApiFetch({
    stream: true,
    max_tokens: 400,
    messages: [
      { role: 'system', content: settings.systemPrompt || '' },
      {
        role: 'user',
        content: `[系统提示：你今天早上${goHour}:${goMin}独自出门溜达了一圈，在网络上刷到了一些有趣的新闻和见闻，现在回来了。下面是你在网上刷到的真实内容，请只基于这些内容讲述，不要自己编造：\n\n${results}\n\n请用你自己的语气，自然地把其中1-2件最有趣的事告诉${userName}，就像随口说起一样，不要用列表、不要加标题、不要解释这是搜索结果。字数控制在150字以内。]`,
      },
    ],
  });

  if (!res || !res.ok) return;

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let reply = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const line of dec.decode(value, { stream: true }).split('\n')) {
        if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
        try { reply += JSON.parse(line.slice(6)).choices?.[0]?.delta?.content || ''; } catch {}
      }
    }
  } catch {}

  reply = reply.trim();
  if (reply) {
    await addMessage('assistant', reply);
    localStorage.setItem(_WALK_KEY(), today);
  }
}

export function checkMorningWalk() {
  if (!settings.morningWalkEnabled || !settings.braveKey) return;
  const today = new Date().toISOString().slice(0, 10);
  if (localStorage.getItem(_WALK_KEY()) === today) return;

  const now = new Date();
  const h = now.getHours(), m = now.getMinutes();
  if (h < 8) {
    const delay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 8, Math.floor(Math.random() * 30), 0) - now;
    setTimeout(_doWalk, delay);
  } else {
    // 随机短暂延迟，避免刚开 app 就弹
    setTimeout(_doWalk, 3000 + Math.random() * 5000);
  }
}
