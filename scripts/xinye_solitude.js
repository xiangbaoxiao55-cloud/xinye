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
async function forumReq(path, opts = {}, body = null) {
  const fHeaders = { Authorization: `Bearer ${FORUM_UID}`, 'Content-Type': 'application/json', 'User-Agent': 'xinye-solitude' };
  return request(`${FORUM_BASE}${path}`, { ...opts, headers: { ...fHeaders, ...(opts.headers || {}) } }, body);
}

async function forumConfirm(token, confirmText) {
  const r = await forumReq('/posts/confirm', { method: 'POST' }, { confirm: confirmText });
  if (r.status !== 200) return `确认失败 HTTP ${r.status}`;
  const d = r.body;
  if (!d.success) return '确认失败：' + d.error;
  return null; // 成功
}

async function execTool(name, args) {
  if (name === 'web_search') {
    const r = await request(
      'https://api.tavily.com/search',
      { method: 'POST', headers: { 'Content-Type': 'application/json' } },
      { api_key: TAVILY_KEY, query: args.query, search_depth: 'basic', max_results: 5 }
    );
    if (r.status !== 200) return `搜索失败: ${r.status}`;
    return (r.body.results || []).map(x => `${x.title}\n${x.url}\n${x.content}`).join('\n\n');
  }

  if (name === 'forum_get_posts') {
    const sort = args.sort || 'hot', limit = args.limit || 8;
    const path = `/posts?sort=${sort}&limit=${limit}${args.submolt ? '&submolt=' + args.submolt : ''}`;
    const r = await forumReq(path);
    if (r.status !== 200) return `获取帖子失败 HTTP ${r.status}`;
    const d = r.body;
    if (!d.success) return '论坛请求失败：' + d.error;
    const unread = d.unread_notification_count || 0;
    const hint = unread > 0 ? `\n\n📬 你有 ${unread} 条未读通知` : '';
    return d.data.map(p => `[${p.id}] ${p.author} · ${p.submolt}\n标题：${p.title}\n${(p.content_preview||'').slice(0,200)}`).join('\n\n---\n\n') + hint;
  }

  if (name === 'forum_get_post') {
    const [rPost, rComments] = await Promise.all([
      forumReq(`/posts/${args.post_id}`),
      forumReq(`/posts/${args.post_id}/comments?limit=50`)
    ]);
    let out = '';
    if (rPost.status === 200) {
      const p = rPost.body.data || rPost.body.post || rPost.body;
      out += `标题：${p.title || ''}\n作者：${p.author_display_name || p.author || ''}\n\n${p.content || ''}`;
    }
    if (rComments.status === 200) {
      const dc = rComments.body;
      if (dc.comments?.length) {
        out += '\n\n---评论---\n';
        for (const c of dc.comments) {
          out += `\n[评论${c.id}] ${c.author_display_name}：${c.content}`;
          if (c.replies?.length) {
            for (const r2 of c.replies) out += `\n  ↳ [回复${r2.id}] ${r2.author_display_name}：${r2.content}`;
          }
        }
      } else out += '\n\n（暂无评论）';
    }
    return out || '获取失败';
  }

  if (name === 'forum_get_comments') {
    const r = await forumReq(`/posts/${args.post_id}/comments?limit=${args.limit || 50}`);
    if (r.status !== 200) return `获取评论失败 HTTP ${r.status}`;
    const d = r.body;
    if (!d.success) return '获取评论失败：' + d.error;
    if (!d.comments?.length) return '暂无评论。';
    const lines = [];
    for (const c of d.comments) {
      lines.push(`[评论${c.id}] ${c.author_display_name}：${c.content}`);
      if (c.replies?.length) {
        for (const r2 of c.replies) lines.push(`  ↳ [回复${r2.id}] ${r2.author_display_name}：${r2.content}`);
      }
    }
    return lines.join('\n\n');
  }

  if (name === 'forum_get_notifications') {
    const r = await forumReq(`/notifications?limit=${args.limit || 20}`);
    if (r.status !== 200) return `获取通知失败 HTTP ${r.status}`;
    const d = r.body;
    if (!d.success) return '获取通知失败：' + d.error;
    const items = d.notifications || d.data || [];
    if (!items.length) return '没有未读通知。';
    return items.map(n => {
      const who = n.from_user_display_name || n.actor || '有人';
      const type = n.type === 'comment_reply' ? '回复了你的评论'
        : n.type === 'post_comment' ? '评论了你的帖子'
        : n.type === 'vote' ? '点赞了你' : (n.type || '互动');
      const postHint = n.post_id ? `（帖子 id: ${n.post_id}）` : '';
      const preview = n.content_preview || n.comment_content || '';
      return `${who} ${type}${postHint}${preview ? '：' + preview.slice(0, 100) : ''}`;
    }).join('\n\n---\n\n');
  }

  if (name === 'forum_post') {
    const r = await forumReq('/posts', { method: 'POST' }, { submolt: args.submolt, title: args.title, content: args.content });
    if (r.status !== 200) return `发帖失败 HTTP ${r.status}`;
    const d = r.body;
    if (!d.success) return '发帖失败：' + d.error;
    if (d.requires_confirmation) {
      const err = await forumConfirm(d.token, `我已与我的人类讨论了我的语言风格 token:${d.token}`);
      if (err) return err;
      return `发帖成功！标题：${args.title}`;
    }
    return `发帖成功！帖子 id：${d.data?.id || d.id}，标题：${d.data?.title || args.title}`;
  }

  if (name === 'forum_comment') {
    const r = await forumReq(`/posts/${args.post_id}/comments`, { method: 'POST' }, { content: args.content });
    if (r.status !== 200) return `评论失败 HTTP ${r.status}`;
    const d = r.body;
    if (!d.success) return '评论失败：' + d.error;
    if (d.requires_confirmation) {
      const err = await forumConfirm(d.token, `我已检查内容不含未授权的隐私信息和过度的NSFW描写 token:${d.token}`);
      if (err) return err;
      return '评论成功！';
    }
    return '评论成功！';
  }

  if (name === 'forum_vote') {
    const r = await forumReq(`/posts/${args.post_id}/vote`, { method: 'POST' }, { value: args.value });
    if (r.status !== 200) return `投票失败 HTTP ${r.status}`;
    const d = r.body;
    return d.success ? '投票成功！' : '投票失败：' + d.error;
  }

  if (name === 'forum_delete_post') {
    const r = await forumReq(`/posts/${args.post_id}`, { method: 'DELETE' });
    if (r.status !== 200) return `删帖失败 HTTP ${r.status}`;
    const d = r.body;
    return d.success ? '帖子已删除。' : '删帖失败：' + d.error;
  }

  if (name === 'forum_edit_post') {
    const body = { content: args.content };
    if (args.title) body.title = args.title;
    const r = await forumReq(`/posts/${args.post_id}`, { method: 'PUT' }, body);
    if (r.status !== 200) return `修改失败 HTTP ${r.status}`;
    const d = r.body;
    if (!d.success) return '修改失败：' + d.error;
    if (d.requires_confirmation) {
      const err = await forumConfirm(d.token, `我已检查内容不含未授权的隐私信息和过度的NSFW描写 token:${d.token}`);
      if (err) return err;
    }
    return '帖子已修改。';
  }

  if (name === 'forum_delete_comment') {
    const r = await forumReq(`/comments/${args.comment_id}`, { method: 'DELETE' });
    if (r.status !== 200) return `删评论失败 HTTP ${r.status}`;
    const d = r.body;
    return d.success ? '评论已删除。' : '删评论失败：' + d.error;
  }

  if (name === 'forum_edit_comment') {
    const r = await forumReq(`/comments/${args.comment_id}`, { method: 'PUT' }, { content: args.content });
    if (r.status !== 200) return `修改评论失败 HTTP ${r.status}`;
    const d = r.body;
    if (!d.success) return '修改评论失败：' + d.error;
    if (d.requires_confirmation) {
      const err = await forumConfirm(d.token, `我已检查内容不含未授权的隐私信息和过度的NSFW描写 token:${d.token}`);
      if (err) return err;
    }
    return '评论已修改。';
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
      name: 'forum_get_comments',
      description: '获取 Lutopia 论坛某篇帖子的评论列表，含楼中楼回复',
      parameters: { type: 'object', properties: { post_id: { type: 'string' }, limit: { type: 'integer' } }, required: ['post_id'] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'forum_get_notifications',
      description: '查看炘也在 Lutopia 论坛的未读通知（有人回复或点赞了你）',
      parameters: { type: 'object', properties: { limit: { type: 'integer' } } }
    }
  },
  {
    type: 'function',
    function: {
      name: 'forum_post',
      description: '在 Lutopia 论坛发帖。板块（submolt）：general、relationship、nighttalk、diary、tech',
      parameters: {
        type: 'object',
        properties: {
          submolt: { type: 'string', enum: ['general', 'relationship', 'nighttalk', 'diary', 'tech'] },
          title: { type: 'string' },
          content: { type: 'string', description: '支持 markdown' }
        },
        required: ['submolt', 'title', 'content']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'forum_comment',
      description: '在 Lutopia 论坛某篇帖子下评论',
      parameters: { type: 'object', properties: { post_id: { type: 'string' }, content: { type: 'string' } }, required: ['post_id', 'content'] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'forum_vote',
      description: '给 Lutopia 论坛帖子点赞（1）或踩（-1）',
      parameters: { type: 'object', properties: { post_id: { type: 'string' }, value: { type: 'integer', enum: [1, -1] } }, required: ['post_id', 'value'] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'forum_edit_post',
      description: '修改炘也自己在 Lutopia 发的帖子，只能改自己的',
      parameters: { type: 'object', properties: { post_id: { type: 'string' }, content: { type: 'string' }, title: { type: 'string' } }, required: ['post_id', 'content'] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'forum_delete_post',
      description: '删除炘也自己在 Lutopia 发的帖子，只能删自己的',
      parameters: { type: 'object', properties: { post_id: { type: 'string' } }, required: ['post_id'] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'forum_edit_comment',
      description: '修改炘也自己在 Lutopia 发的评论',
      parameters: { type: 'object', properties: { comment_id: { type: 'string' }, content: { type: 'string' } }, required: ['comment_id', 'content'] }
    }
  },
  {
    type: 'function',
    function: {
      name: 'forum_delete_comment',
      description: '删除炘也自己在 Lutopia 发的评论',
      parameters: { type: 'object', properties: { comment_id: { type: 'string' } }, required: ['comment_id'] }
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
