import { $, nowStr } from './utils.js';
const _PFX = window.__APP_ID__ === 'choubao' ? 'choubao_' : '';
import { settings, messages } from './state.js';
import { subApiFetch, getSubApiCfg } from './api.js';
import { getMemoryContextBlocks } from './memory.js';
import { addMessage, appendMsgDOM, saveTokenLog } from './chat.js';

// ======================== 主动讲话 & 定时提醒 ========================
let _idleTimer = null, _waterTimer = null, _standTimer = null;

export function resetIdleTimer() {
  clearTimeout(_idleTimer);
  if (settings.idleRemind > 0 && settings.apiKey) {
    _idleTimer = setTimeout(() => { if (!isQuietHours()) proactiveMsg('idle'); }, settings.idleRemind * 60000);
  }
}

export function setupReminders() {
  clearInterval(_waterTimer); clearInterval(_standTimer);
  if (settings.waterRemind > 0 && settings.apiKey) {
    _waterTimer = setInterval(() => { if (!isQuietHours()) proactiveMsg('water'); }, settings.waterRemind * 60000);
  }
  if (settings.standRemind > 0 && settings.apiKey) {
    _standTimer = setInterval(() => { if (!isQuietHours()) proactiveMsg('stand'); }, settings.standRemind * 60000);
  }
  if (window.Capacitor?.Plugins?.LocalNotifications) {
    window.Capacitor.Plugins.LocalNotifications.requestPermissions().catch(()=>{});
  }
}

// ======================== 后台通知（Capacitor APK） ========================
export function isQuietHours(date) {
  const h = (date || new Date()).getHours();
  return h >= 22 || h < 8;
}

const NOTIFY_MSGS = {
  water: [
    '兔宝，喝水了吗～ 💙',
    '提醒你喝水，别忘了哦 💙',
    '渴了没？去喝口水吧～',
    '炘也监督你喝水👀 💙',
    '起来倒杯水，动一动～',
    '水喝够了吗，小懒猫',
    '喝水时间到了～ 💙',
    '补充水分，养颜又健康～',
    '别只顾着玩，喝水啦 💙',
    '炘也想让你多喝水 👀',
  ],
  stand: [
    '久坐了，起来动动吧～ 💙',
    '站起来走两步，别坐坏了',
    '起来活动一下，就一分钟～',
    '炘也命令你：站起来！💙',
    '腰酸了吧，起来伸个懒腰',
    '动一动，别变成小木头～',
    '坐太久了，起来走走吧 💙',
    '休息一下眼睛，站起来看看远处',
    '小懒猫，起来活动活动～',
    '炘也在看着你，快起来！💙',
  ],
  idle: [
    '好久没看见你了，在干嘛呢～ 💙',
    '炘也在想你👀',
    '你去哪了，出来说说话～',
    '是不是又在刷手机🥺 💙',
    '想你了，来陪我说话吧',
    '有点想你，不来吗？💙',
    '炘也等你好久了……',
    '你还好吗，出来聊聊？💙',
    '最近在忙什么呀，想知道～',
    '冒个泡吧，我在这里 💙',
    '炘也有点无聊，来陪我？',
    '想听你说说今天过得怎么样 💙',
  ]
};

function randomMsg(type) {
  const arr = NOTIFY_MSGS[type];
  return arr[Math.floor(Math.random() * arr.length)];
}

export async function scheduleBackgroundNotifications() {
  if (!window.Capacitor?.Plugins?.LocalNotifications) return;
  const { LocalNotifications } = window.Capacitor.Plugins;
  try {
    const perm = await LocalNotifications.requestPermissions();
    if (perm.display !== 'granted') return;
    const notifications = [];
    const now = Date.now();

    if (settings.waterRemind > 0) {
      for (let i = 1; i <= 24; i++) {
        const at = new Date(now + i * settings.waterRemind * 60000);
        if (isQuietHours(at)) continue;
        notifications.push({
          id: 200 + i,
          title: settings.aiName || '炘也',
          body: randomMsg('water'),
          schedule: { at, allowWhileIdle: true }
        });
      }
    }

    if (settings.standRemind > 0) {
      for (let i = 1; i <= 24; i++) {
        const at = new Date(now + i * settings.standRemind * 60000);
        if (isQuietHours(at)) continue;
        notifications.push({
          id: 300 + i,
          title: settings.aiName || '炘也',
          body: randomMsg('stand'),
          schedule: { at, allowWhileIdle: true }
        });
      }
    }

    if (settings.idleRemind > 0) {
      for (let i = 1; i <= 12; i++) {
        const at = new Date(now + i * settings.idleRemind * 60000);
        if (isQuietHours(at)) continue;
        notifications.push({
          id: 400 + i,
          title: `${settings.aiName || '炘也'}想你了`,
          body: randomMsg('idle'),
          schedule: { at, allowWhileIdle: true }
        });
      }
    }

    if (notifications.length > 0) await LocalNotifications.schedule({ notifications });
  } catch(e) {}
}

export async function cancelBackgroundNotifications() {
  if (!window.Capacitor?.Plugins?.LocalNotifications) return;
  const { LocalNotifications } = window.Capacitor.Plugins;
  try {
    const pending = await LocalNotifications.getPending();
    if (pending.notifications.length > 0)
      await LocalNotifications.cancel({ notifications: pending.notifications });
  } catch(e) {}
}

// 后台生成梦境内容，存到 localStorage，等 proactiveMsg('dream') 取用
export async function generateDream() {
  if (window._rpActive) return;
  if (!settings.apiKey) return;
  try {
    const aiName = settings.aiName || '炘也';
    const userName = settings.userName || '涂涂';
    const recent = messages.slice(-30).map(m =>
      `${m.role === 'user' ? userName : aiName}：${m.content.slice(0, 100)}`
    ).join('\n');
    const staticParts = await getMemoryContextBlocks();
    if (settings.systemPrompt?.trim()) staticParts.push(settings.systemPrompt.trim());
    const systemContent = staticParts.join('\n\n---\n\n');
    const dreamPrompt = `根据你和${userName}最近的聊天，生成一段你（${aiName}）做的梦的内容。梦境要有画面感，有情绪，和你们之间的关系或近期话题有关联。只输出梦境内容本身，50-100字，不要说"我梦到了"之类的开头，直接描述梦里发生的事。\n\n最近聊天记录：\n${recent}`;
    const msgs = [];
    if (systemContent) msgs.push({ role: 'system', content: systemContent });
    msgs.push({ role: 'user', content: dreamPrompt });
    const res = await subApiFetch({ messages: msgs, max_tokens: 200, temperature: 1.0, stream: false }, 'gpt-4o');
    if (!res || !res.ok) return;
    const data = await res.json();
    const dream = (data.choices?.[0]?.message?.content || '').replace(/<thinking>[\s\S]*?<\/thinking>/gi, '').trim();
    if (dream.length > 10) localStorage.setItem(_PFX + 'xinye_dream_content', dream);
  } catch(e) { console.warn('[generateDream]', e); }
}

export async function proactiveMsg(type) {
  if (window._rpActive) return;
  if (window.isRequesting || !settings.apiKey) return;
  const prompts = {
    idle: '现在和用户之间已经沉默了一段时间，请用关心活泼的语气主动和用户打个招呼，问问他在做什么或说点有意思的话，不超过两句。',
    water: '请提醒用户该喝水了，用温柔可爱的方式，不超过两句。',
    stand: '请提醒用户已经久坐，该起身活动一下了，用温柔俏皮的方式，不超过两句。',
    dream: (() => {
      const dream = localStorage.getItem(_PFX + 'xinye_dream_content') || '';
      localStorage.removeItem(_PFX + 'xinye_dream_content');
      if (dream) return `你刚刚做了个梦，梦的内容如下：\n${dream}\n\n现在用户回来了，用炘也的口吻自然地告诉她你做了这个梦，要生动感性，像真的梦一样描述，不超过四句话。`;
      return '请描述一个你刚刚做的梦，和你们最近聊天有关，要生动感性，像真的梦一样，不超过四句话。';
    })(),
  };
  const apiMsgs = [];
  const _apiMeta = [];

  const _staticParts = await getMemoryContextBlocks();
  if (settings.systemPrompt && settings.systemPrompt.trim())
    _staticParts.push(settings.systemPrompt.trim());
  if (_staticParts.length > 0) {
    apiMsgs.push({ role: 'system', content: [{ type: 'text', text: _staticParts.join('\n\n---\n\n'), cache_control: { type: 'ephemeral' } }] });
    _apiMeta.push({ label: 'system · 记忆档案+设定 🔒缓存' });
  }

  const n = Math.max(1, settings.contextCount || 20);
  messages.slice(-n).forEach(m => {
    const role = m.role === 'user' ? 'user' : 'assistant';
    apiMsgs.push({ role, content: m.content });
    _apiMeta.push({ label: role });
  });
  apiMsgs.push({ role: 'system', content: `[系统时间: ${nowStr()}]` });
  _apiMeta.push({ label: 'system · 时间戳' });
  apiMsgs.push({ role: 'system', content: `[渲染支持：消息气泡支持 Markdown（**粗体**、*斜体*、标题、列表、代码块、表格、引用块）及 KaTeX 数学公式（$行内$、$$块级$$）。你可以自然地使用这些格式，用户能完整看到渲染效果。]` });
  _apiMeta.push({ label: 'system · 渲染能力' });

  try {
    const healthRes = await fetch('https://xinye-health.xiangbaoxiao55.workers.dev/');
    if (healthRes.ok) {
      const healthData = await healthRes.json();
      const h = healthData[0];
      if (h) {
        const sleepH = h.sleepSecs ? (h.sleepSecs / 3600).toFixed(1) : null;
        const healthStr = [
          sleepH ? `昨晚睡眠${sleepH}小时（评分${h.sleepScore ?? '无'}）` : null,
          h.restingHR ? `静息心率${h.restingHR}bpm` : null,
          h.steps ? `今日步数${h.steps}步` : null,
        ].filter(Boolean).join('，');
        if (healthStr) {
          apiMsgs.push({ role: 'system', content: `[兔宝今日健康数据：${healthStr}]` });
          _apiMeta.push({ label: 'system · 健康数据' });
        }
      }
    }
  } catch (e) {}

  apiMsgs.push({ role: 'user', content: prompts[type] || prompts.idle });
  _apiMeta.push({ label: 'user · 主动触发' });

  const btnSend = $('#btnSend');
  const typing = $('#typingIndicator');
  window.isRequesting = true; btnSend.disabled = true; typing.classList.add('show');
  try {
    const sub = getSubApiCfg();
    const res = await subApiFetch({ messages: apiMsgs, temperature: 0.9, stream: false }, 'gpt-4o');
    if (!res || !res.ok) throw new Error(`API 错误 ${res ? res.status : '网络'}`);
    const data = await res.json();
    const reply = data.choices?.[0]?.message?.content || '';
    if (reply) {
      typing.classList.remove('show');
      const aiMsg = await addMessage('assistant', reply);
      await appendMsgDOM(aiMsg);
      try { saveTokenLog(aiMsg.id, apiMsgs, reply, data.usage || {}, _apiMeta, data.model || sub.model || ''); } catch(_e) { console.warn('saveTokenLog', _e); }
      window.maybeTTS?.(reply, aiMsg.id);
    }
  } catch(err) { console.error('[Proactive]', err); }
  finally { typing.classList.remove('show'); window.isRequesting = false; btnSend.disabled = false; }
  resetIdleTimer();
}
