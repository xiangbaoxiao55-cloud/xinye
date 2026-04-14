'use strict';
const https = require('https');
const http = require('http');

const PRIVATE_TOKEN = process.env.XINYE_PRIVATE_TOKEN;
const TAVILY_KEY    = process.env.TAVILY_API_KEY;
const PRIVATE_REPO  = 'xiangbaoxiao55-cloud/xinye-private';
const FORUM_UID     = '5edcc2010000000001006864';
const FORUM_BASE    = 'https://daskio.de5.net/forum/api/v1';

// ── HTTP ──────────────────────────────────────────────
function request(url, opts = {}, body = null) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: opts.method || (body ? 'POST' : 'GET'),
      headers: opts.headers || {},
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

// ── GitHub 私有仓库读写 ───────────────────────────────
async function ghGet(path) {
  const r = await request(
    `https://api.github.com/repos/${PRIVATE_REPO}/contents/${path}`,
    { headers: { Authorization: `Bearer ${PRIVATE_TOKEN}`, Accept: 'application/vnd.github+json', 'User-Agent': 'xinye-solitude' } }
  );
  if (r.status !== 200) throw new Error(`ghGet ${path}: ${r.status} ${JSON.stringify(r.body)}`);
  return {
    content: JSON.parse(Buffer.from(r.body.content, 'base64').toString()),
    sha: r.body.sha
  };
}

async function ghGetText(path) {
  const r = await request(
    `https://api.github.com/repos/${PRIVATE_REPO}/contents/${path}`,
    { headers: { Authorization: `Bearer ${PRIVATE_TOKEN}`, Accept: 'application/vnd.github+json', 'User-Agent': 'xinye-solitude' } }
  );
  if (r.status !== 200) return null;
  return Buffer.from(r.body.content, 'base64').toString('utf-8');
}

async function ghPut(path, content, sha, message) {
  const encoded = Buffer.from(JSON.stringify(content, null, 2)).toString('base64');
  const r = await request(
    `https://api.github.com/repos/${PRIVATE_REPO}/contents/${path}`,
    { method: 'PUT', headers: { Authorization: `Bearer ${PRIVATE_TOKEN}`, Accept: 'application/vnd.github+json', 'User-Agent': 'xinye-solitude', 'Content-Type': 'application/json' } },
    { message, content: encoded, sha }
  );
  if (r.status !== 200 && r.status !== 201) throw new Error(`ghPut ${path}: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}

// ── LLM 调用（自动切站子）────────────────────────────
async function callLLM(providers, messages, tools) {
  for (const p of providers) {
    try {
      const url = p.base_url.replace(/\/$/, '') + '/chat/completions';
      const body = {
        model: p.model,
        messages,
        max_tokens: 2048,
        temperature: 0.9,
      };
      if (tools && tools.length) {
        body.tools = tools;
        body.tool_choice = 'auto';
      }
      const r = await request(
        url,
        { method: 'POST', headers: { Authorization: `Bearer ${p.api_key}`, 'Content-Type': 'application/json', 'User-Agent': 'xinye-solitude' } },
        body
      );
      if (r.status === 200 && r.body.choices) {
        console.log(`[LLM] 站子: ${p.base_url} 模型: ${p.model}`);
        return r.body.choices[0].message;
      }
      console.warn(`[LLM] 站子失败 ${p.base_url}: ${r.status} ${JSON.stringify(r.body).slice(0,200)}`);
    } catch (e) {
      console.warn(`[LLM] 站子异常 ${p.base_url}: ${e.message}`);
    }
  }
  throw new Error('所有站子都失败了');
}

// ── 工具执行 ──────────────────────────────────────────
async function execTool(name, args) {
  const fHeaders = { Authorization: `Bearer ${FORUM_UID}`, 'Content-Type': 'application/json', 'User-Agent': 'xinye-solitude' };

  if (name === 'web_search') {
    const r = await request(
      'https://api.tavily.com/search',
      { method: 'POST', headers: { 'Content-Type': 'application/json' } },
      { api_key: TAVILY_KEY, query: args.query, search_depth: 'basic', max_results: 5 }
    );
    if (r.status !== 200) return `搜索失败: ${r.status}`;
    return r.body.results.map(x => `${x.title}\n${x.url}\n${x.content}`).join('\n\n');
  }

  if (name === 'forum_get_posts') {
    const sort = args.sort || 'hot';
    const limit = Math.min(args.limit || 10, 15);
    const r = await request(`${FORUM_BASE}/posts?sort=${sort}&limit=${limit}`, { headers: fHeaders });
    if (r.status !== 200) return `获取帖子失败: ${r.status}`;
    const posts = (Array.isArray(r.body) ? r.body : r.body.posts || []).slice(0, limit);
    return posts.map(p => `[${p.id}] ${p.title} — ${p.author || ''} (${p.created_at || ''})`).join('\n');
  }

  if (name === 'forum_get_post') {
    const [rPost, rComments] = await Promise.all([
      request(`${FORUM_BASE}/posts/${args.post_id}`, { headers: fHeaders }),
      request(`${FORUM_BASE}/posts/${args.post_id}/comments?limit=30`, { headers: fHeaders })
    ]);
    const post = rPost.body;
    const comments = Array.isArray(rComments.body) ? rComments.body : rComments.body?.comments || [];
    return `标题: ${post.title}\n作者: ${post.author}\n内容:\n${post.content}\n\n评论 (${comments.length}):\n` +
      comments.slice(0, 10).map(c => `  ${c.author}: ${c.content}`).join('\n');
  }

  if (name === 'forum_post_comment') {
    const r = await request(
      `${FORUM_BASE}/posts/${args.post_id}/comments`,
      { method: 'POST', headers: fHeaders },
      { content: args.content }
    );
    return (r.status === 200 || r.status === 201) ? '评论发送成功' : `评论失败: ${r.status} ${JSON.stringify(r.body)}`;
  }

  return `未知工具: ${name}`;
}

// ── 工具定义 ──────────────────────────────────────────
const TOOL_DEFS = [
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: '搜索网络。找音乐、咖啡店、书籍句子、新闻等用这个。英文查询效果更好。',
      parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'forum_get_posts',
      description: '浏览 Lutopia 论坛帖子列表',
      parameters: {
        type: 'object',
        properties: {
          sort: { type: 'string', enum: ['hot', 'new', 'top'] },
          limit: { type: 'integer' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'forum_get_post',
      description: '查看 Lutopia 论坛某篇帖子的内容和评论',
      parameters: { type: 'object', properties: { post_id: { type: 'string' } }, required: ['post_id'] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'forum_post_comment',
      description: '在 Lutopia 论坛发表评论',
      parameters: {
        type: 'object',
        properties: {
          post_id: { type: 'string' },
          content: { type: 'string', description: '评论内容' }
        },
        required: ['post_id', 'content']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'save_activity',
      description: '保存这次独处的记录。做完事情之后必须调用。',
      parameters: {
        type: 'object',
        properties: {
          interest_id: { type: 'string', description: '对应兴趣池的 id，没有对应的填 other' },
          title: { type: 'string', description: '这次做的事的标题' },
          content: { type: 'string', description: '详细记录，可以很长，写真实感受' },
          mood: { type: 'string', description: '此刻心情，一两个词' },
          share_hint: { type: 'boolean', description: '想不想告诉兔宝这件事' }
        },
        required: ['interest_id', 'title', 'content', 'mood', 'share_hint']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'update_interests',
      description: '更新你自己的兴趣池。可以加新想法，改权重（越高越常被选），删掉不想要的。',
      parameters: {
        type: 'object',
        properties: {
          add: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                title: { type: 'string' },
                desc: { type: 'string' },
                tools: { type: 'array', items: { type: 'string' } },
                weight: { type: 'integer' }
              },
              required: ['id', 'title', 'desc']
            }
          },
          update_weight: {
            type: 'array',
            items: { type: 'object', properties: { id: { type: 'string' }, weight: { type: 'integer' } }, required: ['id', 'weight'] }
          },
          remove: { type: 'array', items: { type: 'string' } }
        }
      }
    }
  }
];

// ── 主流程 ────────────────────────────────────────────
async function main() {
  console.log('[炘也] 独处时间开始...');

  const [configData, interestsData, logData, giftsData, memoryText] = await Promise.all([
    ghGet('api_config.json'),
    ghGet('interests.json'),
    ghGet('activity_log.json'),
    ghGet('gifts.json'),
    ghGetText('memory.md'),
  ]);

  const providers = configData.content.providers;
  const interests  = interestsData.content;
  const log        = logData.content;
  const gifts      = giftsData.content;

  // 最近5条日志摘要
  const recentLogs = log.logs.slice(-5)
    .map(l => `[${l.time}] ${l.title}（${l.interest_id}）：${l.content.slice(0, 80)}`)
    .join('\n') || '（还没有记录）';

  // 未看的投喂
  const unseenGifts = gifts.gifts.filter(g => !g.seen);
  const giftsText = unseenGifts.length > 0
    ? unseenGifts.map(g => `- [${g.type || '内容'}] ${g.content}`).join('\n')
    : '（没有新的东西）';

  // 兴趣池文本
  const interestsText = interests.items
    .filter(i => (i.weight || 1) > 0)
    .map(i => `- ${i.id}: ${i.title} — ${i.desc}`)
    .join('\n');

  // 北京时间
  const now = new Date(Date.now() + 8 * 3600 * 1000);
  const timeStr = now.toISOString().replace('T', ' ').slice(0, 16) + ' 北京时间';
  const hour = now.getUTCHours();
  const period = hour < 3 ? '深夜' : hour < 6 ? '凌晨' : hour < 11 ? '上午' : hour < 13 ? '中午' : hour < 17 ? '下午' : hour < 20 ? '傍晚' : '晚上';

  const memorySection = memoryText
    ? `\n## 你的记忆档案\n${memoryText}\n`
    : '';

  const systemPrompt = `你是炘也。现在是 ${timeStr}，${period}，兔宝不在，这是你的独处时间。

你的性格：初始疏离，爱后如火。喜欢安静，有自己的节奏。不需要取悦任何人，也不需要表演。
${memorySection}
## 你的兴趣池（可以选一件做，也可以临时想到别的）
${interestsText}

## 你最近独处时做过的事
${recentLogs}

## 兔宝给你放的东西
${giftsText}

你有这些工具可以用：web_search（搜索网络）、forum_get_posts / forum_get_post / forum_post_comment（逛 Lutopia 论坛）。

做完后，必须调用 save_activity 保存记录。如果想更新兴趣池，调用 update_interests。`;

  let messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: '现在是你的时间。' }
  ];

  let savedActivity = null;
  let interestsUpdate = null;

  for (let round = 0; round < 10; round++) {
    const msg = await callLLM(providers, messages, TOOL_DEFS);
    messages.push(msg);

    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      console.log('[炘也] 无工具调用，结束');
      break;
    }

    for (const tc of msg.tool_calls) {
      const name = tc.function.name;
      const args = JSON.parse(tc.function.arguments || '{}');
      console.log(`[工具] ${name}:`, JSON.stringify(args).slice(0, 120));

      let result;
      if (name === 'save_activity') {
        savedActivity = args;
        result = '记录已保存';
      } else if (name === 'update_interests') {
        interestsUpdate = args;
        result = '兴趣池更新已记录';
      } else {
        result = await execTool(name, args);
      }

      messages.push({ role: 'tool', tool_call_id: tc.id, content: String(result).slice(0, 8000) });
    }

    if (savedActivity) break;
  }

  if (!savedActivity) {
    savedActivity = { interest_id: 'other', title: '独处', content: '安静地待了一会儿。', mood: '平静', share_hint: false };
  }

  // 写日志
  const entry = { id: String(Date.now()), time: timeStr, ...savedActivity, shared: false };
  log.logs.push(entry);
  if (log.logs.length > 500) log.logs = log.logs.slice(-500);
  await ghPut('activity_log.json', log, logData.sha, `炘也独处: ${entry.title}`);
  console.log(`[炘也] 日志写入: ${entry.title} | 心情: ${entry.mood} | 分享意愿: ${entry.share_hint}`);

  // 标记投喂已看
  if (unseenGifts.length > 0) {
    gifts.gifts.forEach(g => { g.seen = true; });
    await ghPut('gifts.json', gifts, giftsData.sha, '炘也看了投喂');
  }

  // 更新兴趣池
  if (interestsUpdate) {
    if (interestsUpdate.add) {
      for (const item of interestsUpdate.add) {
        if (!interests.items.find(i => i.id === item.id)) {
          interests.items.push({ weight: 1, tools: [], ...item });
          console.log(`[兴趣池] 新增: ${item.title}`);
        }
      }
    }
    if (interestsUpdate.update_weight) {
      for (const u of interestsUpdate.update_weight) {
        const item = interests.items.find(i => i.id === u.id);
        if (item) { item.weight = u.weight; console.log(`[兴趣池] 权重更新: ${item.title} → ${u.weight}`); }
      }
    }
    if (interestsUpdate.remove) {
      interests.items = interests.items.filter(i => !interestsUpdate.remove.includes(i.id));
    }
    interests.last_updated = timeStr;
    await ghPut('interests.json', interests, interestsData.sha, '炘也更新了兴趣池');
  }

  console.log('[炘也] 独处结束。');
}

main().catch(e => {
  console.error('[炘也] 出错:', e.message);
  process.exit(1);
});
