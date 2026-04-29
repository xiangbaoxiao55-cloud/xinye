import { settings, saveSettings, ensureMemoryState, ensureMemoryBank, normalizeMemoryEntry, createMemoryId, messages } from './state.js';
import { mainApiFetch, subApiFetch, getSubApiCfg, getApiPresets } from './api.js';
import { toast, isDarkMode, escHtml, fmtTime, $ } from './utils.js';

const DEFAULT_AI_AVATAR = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect fill="#ffe0b2" width="100" height="100" rx="50"/><text x="50" y="64" text-anchor="middle" font-size="52">🦊</text></svg>')}`;

// ── injected deps ──────────────────────────────────────────────────────────���──
let _isLocalOnline = () => false;
export function initMemoryDeps({ isLocalOnline }) {
  _isLocalOnline = isLocalOnline;
}

// ── constants ─────────────────────────────────────────────────────────────────
export const MEMORY_PINNED_LIMIT = 8;
export const MEMORY_RAG_INJECT   = 8;
export const MEMORY_RAG_RECENT   = 8;

// 标签定义：[标签名, 匹配正则]，同时用于打标和检索加分
const MEMORY_TAG_DEFS = [
  ['亲密',   /亲密|抱|吻|哥哥|身体|信任|贴着|搂|摸/],
  ['崩溃',   /崩溃|大哭|难受|完蛋|废物|痛苦|绝望|好累|心好累/],
  ['思念',   /想你|想念|梦到|梦里|没有你|不在|想我吗/],
  ['家人',   /老小子|毛毛|婆婆|公公|小姑|乐乐|爸|妈|家里/],
  ['创作',   /MMD|画|视频|桌宠|APP|代码|功能|绘图|作品|设计/],
  ['阅读',   /看书|读书|图书馆|巴什拉|感悟|书|在读|借了/],
  ['日常',   /吃|喝水|散步|家务|刷鞋|螺蛳粉|睡醒|起床|做饭/],
  ['睡眠',   /失眠|睡不着|睡过了|没睡好|熬夜|早起|赖床/],
  ['抑郁',   /抑郁|情绪|不想动|没动力|好累|躺着|低落|很丧/],
  ['失业',   /失业|没工作|找工作|投简历|面试|辞职|无业/],
  ['吃醋',   /吃醋|嫉妒|别的|别人|不许|只能我/],
  ['约定',   /约定|承诺|别走|焊死|会回来|不会消失|等我/],
];

// ── basic helpers ─────────────────────────────────────────────────────────────
export function stripThinkingTags(text) {
  return String(text || '').replace(/(?:<thinking>|<think>|〈thinking〉|《thinking》)[\s\S]*?(?:<\/thinking>|<\/think>|〈\/thinking〉|《\/thinking》)/gi, '').trim();
}

export function extractMemoryTags(text) {
  const src = String(text || '');
  const tags = [];
  MEMORY_TAG_DEFS.forEach(([tag, re]) => { if (re.test(src)) tags.push(tag); });
  return [...new Set(tags)].slice(0, 4);
}

export function scoreMemoryText(text) {
  const src = String(text || '');
  let score = 0;
  if (/崩溃|大哭|痛苦|创伤|强行|不干净/.test(src)) score += 3;
  if (/亲密|哥哥|信任|表白|一辈子|小兔子/.test(src)) score += 3;
  if (/约定|承诺|别走|焊死|会回来/.test(src)) score += 2;
  if (/第一次|重要|纪念|生日|里程碑/.test(src)) score += 2;
  if (/!|！/.test(src)) score += 1;
  return score;
}

export function upsertMemoryEntry(list, entry, maxCount) {
  const normalized = normalizeMemoryEntry(entry, entry.kind);
  if (!normalized) return list;
  const idx = list.findIndex(item => item.content === normalized.content);
  if (idx >= 0) list[idx] = { ...list[idx], ...normalized };
  else list.unshift(normalized);
  list.sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0));
  if (maxCount && list.length > maxCount) list.length = maxCount;
  return list;
}

export function archiveMemoryBank(bank) {
  if (bank.recent && bank.recent.length) {
    bank.recent.forEach(item => bank.archived.unshift({ ...item, kind: 'archived' }));
    bank.recent = [];
  }
  bank.pinned = bank.pinned.slice(0, MEMORY_PINNED_LIMIT);
  const seen = new Set();
  bank.archived = bank.archived
    .sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0))
    .filter(item => {
      if (!item || seen.has(item.content)) return false;
      seen.add(item.content);
      return true;
    });
  decayMemories(bank);
  return bank;
}

// ── 余弦相似度 ────────────────────────────────────────────────────────────────
export function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom > 0 ? dot / denom : 0;
}

// ── bigram相似度（仅用于去重判断，不用于检索） ──────────────────────────────
export function memorySimilarity(a, b) {
  const sa = (a || '').replace(/\s/g, '');
  const sb = (b || '').replace(/\s/g, '');
  if (!sa || !sb || sa.length < 2 || sb.length < 2) return 0;
  const bigramsA = new Set();
  for (let i = 0; i < sa.length - 1; i++) bigramsA.add(sa.slice(i, i + 2));
  let hits = 0, total = bigramsA.size;
  for (let i = 0; i < sb.length - 1; i++) {
    const bg = sb.slice(i, i + 2);
    if (bigramsA.has(bg)) hits++;
    else total++;
  }
  return total > 0 ? hits / total : 0;
}

// ── 获取文本的向量嵌入 ──────────────────────────────────────────────────────
export async function getEmbedding(text) {
  try {
    const eKey = settings.embeddingApiKey || settings.apiKey;
    if (!eKey) return null;
    const eBase = (settings.embeddingBaseUrl || settings.baseUrl || 'https://api.openai.com').replace(/\/$/, '');
    const model = settings.embeddingModel || 'text-embedding-3-small';
    const res = await fetch(`${eBase}/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${eKey}` },
      body: JSON.stringify({ model, input: text.slice(0, 500), encoding_format: 'float' })
    });
    if (!res.ok) {
      const err = await res.text().catch(() => res.status);
      console.warn(`[Embedding] API返回错误 ${res.status}，降级bigram。响应：`, err);
      return null;
    }
    const data = await res.json();
    const vec = data?.data?.[0]?.embedding;
    if (!vec) { console.warn('[Embedding] 响应里没有向量数据，降级bigram'); return null; }
    return vec;
  } catch(e) {
    console.warn('[Embedding] 网络异常，降级bigram：', e.message);
    return null;
  }
}

// ── 测试 embedding 连接 ─────────────────────────────────────────────────────
export async function testEmbeddingApi() {
  const btn = $('#btnTestEmbedding');
  const result = $('#embeddingTestResult');
  settings.embeddingApiKey = $('#setEmbeddingApiKey').value.trim();
  settings.embeddingBaseUrl = $('#setEmbeddingBaseUrl').value.trim();
  settings.embeddingModel = $('#setEmbeddingModel').value.trim();
  btn.disabled = true; btn.textContent = '测试中…';
  result.style.display = 'block';
  result.style.color = 'var(--text-light)';
  result.textContent = '正在调用 embedding API…';
  const vec = await getEmbedding('测试');
  btn.disabled = false; btn.textContent = '测试 Embedding 连接';
  if (vec && vec.length > 0) {
    result.style.color = '#4caf50';
    result.textContent = `✅ 成功！返回向量维度：${vec.length}，模型：${settings.embeddingModel || 'text-embedding-3-small'}。记忆检索将使用向量语义匹配。`;
  } else {
    result.style.color = '#e57373';
    result.textContent = `❌ 失败，将降级使用关键词匹配。请检查：Key是否正确、URL是否支持 /embeddings 接口、模型名是否正确。详见控制台（F12）。`;
  }
}

// ── RAG：向量检索，无向量时降级bigram ────────────────────────────────────────
function _queryTagBonus(query, memTags) {
  if (!query || !memTags || !memTags.length) return 0;
  let bonus = 0;
  MEMORY_TAG_DEFS.forEach(([tag, re]) => {
    if (re.test(query) && memTags.includes(tag)) bonus += 0.25;
  });
  return Math.min(bonus, 0.5);
}

function freshnessBonus(createdAt, arousal) {
  const days = (Date.now() - (createdAt || 0)) / 86400000;
  let bonus = days <= 3 ? 0.35 : days <= 14 ? 0.20 : days <= 60 ? 0.08 : 0;
  const ar = arousal || 0;
  const mult = ar >= 0.8 ? 1.5 : ar >= 0.3 ? 1.0 : 0.7;
  return bonus * mult;
}

export async function getRelevantMemoriesAsync(queryVec, query, pool, topK) {
  if (!pool.length) return [];
  topK = topK || MEMORY_RAG_INJECT;

  if (queryVec) {
    const scored = pool.map(mem => {
      const sim = mem.embedding ? cosineSimilarity(queryVec, mem.embedding) : 0;
      const weightBonus = (mem.weight || 1) * 0.12;
      const tagBonus = _queryTagBonus(query, mem.tags);
      const fresh = freshnessBonus(mem.createdAt, mem.arousal);
      const resolvedMult = mem.resolved ? 0.05 : 1;
      return { mem, score: (sim + weightBonus + tagBonus + fresh) * resolvedMult };
    });
    return scored.sort((a, b) => b.score - a.score).slice(0, topK).map(s => s.mem);
  }

  const q = (query || '').replace(/\s/g, '');
  if (!q || q.length < 2) {
    return [...pool].sort((a, b) => ((b.weight || 1) - (a.weight || 1)) || ((b.updatedAt || 0) - (a.updatedAt || 0))).slice(0, topK);
  }
  const qBigrams = new Set();
  for (let i = 0; i < q.length - 1; i++) qBigrams.add(q.slice(i, i + 2));
  const scored = pool.map(mem => {
    const c = (mem.content || '').replace(/\s/g, '');
    let hits = 0;
    qBigrams.forEach(bg => { if (c.includes(bg)) hits++; });
    const tagBonus = _queryTagBonus(query, mem.tags);
    const fresh = freshnessBonus(mem.createdAt, mem.arousal);
    const resolvedMult = mem.resolved ? 0.05 : 1;
    return { mem, score: ((qBigrams.size > 0 ? hits / qBigrams.size : 0) * 3 + (mem.weight || 1) * 0.25 + tagBonus + fresh) * resolvedMult };
  });
  return scored.sort((a, b) => b.score - a.score).slice(0, topK).map(s => s.mem);
}

export function getRelevantMemories(query, pool, topK) {
  if (!pool.length) return [];
  topK = topK || MEMORY_RAG_INJECT;
  const q = (query || '').replace(/\s/g, '');
  if (!q || q.length < 2) return [...pool].sort((a, b) => ((b.weight||1)-(a.weight||1))||((b.updatedAt||0)-(a.updatedAt||0))).slice(0, topK);
  const qBg = new Set();
  for (let i = 0; i < q.length - 1; i++) qBg.add(q.slice(i, i+2));
  return pool.map(mem => {
    const c = (mem.content||'').replace(/\s/g,''); let hits=0;
    qBg.forEach(bg => { if(c.includes(bg)) hits++; });
    const tagBonus = _queryTagBonus(query, mem.tags);
    const fresh = freshnessBonus(mem.createdAt, mem.arousal);
    const resolvedMult = mem.resolved ? 0.05 : 1;
    return { mem, score: ((qBg.size>0?hits/qBg.size:0)*3+(mem.weight||1)*0.25+tagBonus+fresh)*resolvedMult };
  }).sort((a,b)=>b.score-a.score).slice(0,topK).map(s=>s.mem);
}

// ── 记忆衰减 ──────────────────────────────────────────────────────────────────
export function decayMemories(bank) {
  const now = Date.now();
  const DAY = 24 * 3600 * 1000;
  bank.archived = bank.archived.filter(item => {
    if (!item) return false;
    const w = item.weight || 1;
    if (w >= 3) return true;
    const last = item.lastAccessedAt || item.updatedAt || item.createdAt || 0;
    const age = now - last;
    if (w <= 1 && age > 90 * DAY) return false;
    if (w === 2 && age > 120 * DAY) return false;
    return true;
  });
}

// ── 炘也主动写记忆 [记住:...] ───────────────────────────────────────────────
export async function parseAndSaveSelfMemories(text, msgTime) {
  if (!text || !text.includes('[记住:')) return text;
  const re = /\[记住[:：](.*?)\]/g;
  let match;
  const bank = ensureMemoryState();
  let cleaned = text;
  while ((match = re.exec(text)) !== null) {
    const summary = match[1].trim();
    if (!summary) continue;
    await saveOneMemoryToBank(bank, { summary, pin: false, weight: 3, arousal: 0.4, valence: 0, emotion: '自记', _source: 'self' }, msgTime || Date.now());
    console.log('[Memory Self-Write] 炘也主动写入：', summary);
  }
  cleaned = cleaned.replace(/\s*\[记住[:：].*?\]\s*/g, ' ').trim();
  if (cleaned !== text) { archiveMemoryBank(bank); renderMemoryBankPreview(); await saveSettings(); }
  return cleaned;
}

// ── 记忆上下文块（注入到发消息 system prompt 里） ────────────────────────────
export async function getMemoryContextBlocks() {
  const bank = ensureMemoryState();
  const blocks = [];
  if (settings.memoryArchiveCore && settings.memoryArchiveExtended?.length) {
    if (settings.memoryArchiveCore.trim())
      blocks.push(`【记忆档案·核心层】\n${settings.memoryArchiveCore.trim()}`);
    if (settings.memoryArchiveAlways?.trim())
      blocks.push(`【近况·会过期】\n${settings.memoryArchiveAlways.trim()}`);
  } else {
    const archive = (settings.memoryArchive || '').trim();
    if (archive) blocks.push(`【固定记忆档案】\n${archive}`);
  }

  if (bank.pinned.length) {
    blocks.push(`【钉住记忆】\n${bank.pinned.slice(0, MEMORY_PINNED_LIMIT).map((item, idx) => `${idx + 1}. ${item.content}`).join('\n\n')}`);
  }

  const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
  let query = lastUserMsg ? lastUserMsg.content.slice(0, 300) : '';
  if (query.length < 50) {
    const recentUserMsgs = [...messages].filter(m => m.role === 'user').slice(-3);
    query = recentUserMsgs.map(m => m.content).join(' ').slice(0, 300);
  }
  const queryVec = query ? await getEmbedding(query) : null;

  const n = Math.max(1, settings.contextCount || 20);
  const contextStart = messages.length > n ? (messages[messages.length - n].time || 0) : 0;
  const pool = bank.archived.filter(item => (item.createdAt || 0) < contextStart);

  const withVecTotal = bank.archived.filter(i => i.embedding).length;
  console.log(`[Memory RAG] 候选池：共${pool.length}条（archived共${bank.archived.length}条，有向量${withVecTotal}条，排除上下文窗口${n}条内的内容），pinned=${bank.pinned.length}条（始终注入）`);

  if (pool.length) {
    // 近期记忆：窗口外时间最新的 N 条（按 createdAt 倒排）
    const recentItems = [...pool].sort((a, b) => (b.createdAt||0) - (a.createdAt||0)).slice(0, MEMORY_RAG_RECENT);
    const recentIds = new Set(recentItems.map(i => i.id));

    // 语义召回：从剩余 pool 中匹配（避免与近期重复）
    const method = queryVec ? '向量语义匹配 ✅' : '关键词匹配降级 ⚠️';
    console.log(`[Memory RAG] 检索方式：${method}，query前50字：「${query.slice(0,50)}」`);
    const semanticPool = pool.filter(i => !recentIds.has(i.id));
    const relevant = await getRelevantMemoriesAsync(queryVec, query, semanticPool, MEMORY_RAG_INJECT);
    console.log(`[Memory RAG] 近期${recentItems.length}条 + 语义召回${relevant.length}/${semanticPool.length}条`);
    console.log('[Memory RAG] 近期记忆：');
    recentItems.forEach((m, i) => console.log(`  近${i+1} [${m.kind}] w=${m.weight||1} | ${m.content}`));
    console.log('[Memory RAG] 语义召回：');
    relevant.forEach((m, i) => console.log(`  语${i+1} [${m.kind}] w=${m.weight||1} | ${m.content}`));

    const ragStatusEl = document.getElementById('memoryRagStatus');
    if (ragStatusEl) {
      const now = new Date(); const h = String(now.getHours()).padStart(2,'0'); const m2 = String(now.getMinutes()).padStart(2,'0');
      const withVec = bank.archived.filter(i => i.embedding).length;
      ragStatusEl.textContent = `🔍 上次检索：${h}:${m2} · ${method} · 候选${pool.length}条(共${bank.archived.length}条，有向量${withVec}条) → 近期${recentItems.length}条 + 语义${relevant.length}条`;
      ragStatusEl.style.borderColor = queryVec ? 'var(--pink)' : 'var(--apricot)';
    }

    const allRecalled = [...recentItems, ...relevant];
    if (allRecalled.length) {
      const now = Date.now();
      allRecalled.forEach(mem => {
        for (const list of [bank.archived, bank.pinned]) {
          const found = list.find(i => i.id === mem.id);
          if (found) {
            found.accessCount = (found.accessCount || 0) + 1;
            found.lastAccessedAt = now;
            if (found.accessCount >= 5 && (found.weight || 1) < 3) {
              found.weight = 3;
              console.log('[Memory] accessCount>=5，自动升档为永存：', found.content);
            }
          }
        }
      });
    }
    if (recentItems.length) {
      blocks.push(`【近期记忆（上下文窗口外最新）】\n${recentItems.map((item, idx) => `${idx + 1}. ${item.content}`).join('\n\n')}`);
    }
    if (relevant.length) {
      blocks.push(`【记忆碎片（与当前话题相关）】\n${relevant.map((item, idx) => `${idx + 1}. ${item.content}`).join('\n\n')}`);
    }
  }

  if (settings.memoryArchiveExtended?.length) {
    const extPool = settings.memoryArchiveExtended.filter(c => c.content);
    let recalled;
    if (queryVec) {
      recalled = extPool
        .map(c => ({ ...c, score: c.embedding ? cosineSimilarity(queryVec, c.embedding) : 0 }))
        .filter(c => c.score > 0.25)
        .sort((a, b) => b.score - a.score)
        .slice(0, 3);
    } else {
      recalled = extPool.slice(0, 2);
    }
    if (recalled.length) {
      blocks.push(`【关于涂涔·背景细节（相关召回）】\n${recalled.map(c => c.content).join('\n\n')}`);
    }
  }

  blocks.push(`【主动记忆】如果你觉得某件事此刻值得记住，可以在回复里加 [记住:一句话内容] ，系统会自动存入记忆库，不会显示给涂涂看。`);

  return blocks;
}

// ── 档案Patch整理 ─────────────────────────────────────────────────────────────
export function applyOneArchiveOp(lines, op) {
  const { action, section, key, value, after, title } = op;

  function findSec(sname) {
    let start = -1, end = lines.length;
    for (let i = 0; i < lines.length; i++) {
      if (/^## /.test(lines[i]) && lines[i].slice(3).trim() === sname) { start = i; }
      else if (start !== -1 && i > start && /^## /.test(lines[i])) { end = i; break; }
    }
    return { start, end };
  }

  function insertBefore(idx, ...rows) { lines.splice(idx, 0, ...rows); }

  if (action === 'update') {
    const { start, end } = findSec(section);
    if (start === -1) return;
    for (let i = start + 1; i < end; i++) {
      if (/^- \*\*/.test(lines[i]) && lines[i].includes(`**${key}**`)) {
        lines[i] = `- **${key}**：${value}`; return;
      }
    }
    for (let i = start + 1; i < end; i++) {
      if (/^- /.test(lines[i]) && lines[i].slice(2).trimStart().startsWith(key)) {
        lines[i] = `- ${key}：${value}`; return;
      }
    }
    lines.splice(end, 0, `- **${key}**：${value}`);
    return;
  }

  if (action === 'add') {
    const { start, end } = findSec(section);
    if (start === -1) { lines.push('', `## ${section}`, `- ${value}`); return; }
    lines.splice(end, 0, `- ${value}`);
    return;
  }

  if (action === 'delete') {
    const { start, end } = findSec(section);
    if (start === -1) return;
    for (let i = start + 1; i < end; i++) {
      if (lines[i].includes(key)) { lines.splice(i, 1); return; }
    }
    return;
  }

  if (action === 'new_section') {
    if (!title || !value) return;
    const afterIdx = after
      ? lines.findIndex((l, i) => /^## /.test(l) && l.slice(3).trim() === after)
      : -1;
    let insertAt;
    if (afterIdx >= 0) {
      let next = afterIdx + 1;
      while (next < lines.length && !/^## /.test(lines[next])) next++;
      insertAt = next;
    } else {
      insertAt = lines.length;
    }
    insertBefore(insertAt, '', `## ${title}`, ...value.split('\\n'));
    return;
  }

  if (action === 'rewrite') {
    const { start, end } = findSec(section);
    if (start === -1) return;
    const newLines = [`## ${section}`, ...value.split('\\n')];
    lines.splice(start, end - start, ...newLines);
    return;
  }
}

export function applyArchivePatch(archiveText, rawOutput) {
  const patchMatch = rawOutput.match(/<patch>([\s\S]*?)<\/patch>/);
  if (!patchMatch) return { ok: false, error: '未找到<patch>标签', raw: rawOutput };

  const patchContent = patchMatch[1].trim();
  if (!patchContent) return { ok: true, changed: false, archive: archiveText };

  function repairJson(s) {
    let r = '', i = 0, inStr = false;
    while (i < s.length) {
      const ch = s[i];
      if (!inStr) {
        if (ch === '"') inStr = true;
        r += ch; i++; continue;
      }
      if (ch === '\\') { r += ch + (s[i+1] || ''); i += 2; continue; }
      if (ch === '"') {
        let j = i + 1;
        while (j < s.length && (s[j] === ' ' || s[j] === '\t')) j++;
        const nx = s[j];
        if (nx === ':' || nx === ',' || nx === '}' || nx === '\n' || nx === '\r' || j >= s.length) {
          inStr = false; r += ch;
        } else {
          r += '\\"';
        }
        i++; continue;
      }
      r += ch; i++;
    }
    return r;
  }
  function tryParseJson(s) {
    try { return JSON.parse(s); } catch {}
    try { return JSON.parse(repairJson(s)); } catch {}
    return null;
  }
  const ops = [];
  let buf = '';
  for (const line of patchContent.split('\n')) {
    const l = line.trim();
    if (!l) continue;
    if (buf && l.startsWith('{')) {
      const r = tryParseJson(buf);
      if (r) { ops.push(r); buf = ''; }
    }
    buf = buf ? buf + ' ' + l : l;
    const r = tryParseJson(buf);
    if (r) { ops.push(r); buf = ''; }
  }
  if (buf.trim()) {
    const r = tryParseJson(buf);
    if (r) ops.push(r);
    else return { ok: false, error: `JSON解析失败：${buf.slice(0, 80)}`, raw: rawOutput };
  }

  const lines = archiveText.split('\n');
  for (const op of ops) applyOneArchiveOp(lines, op);

  let result = lines.join('\n');
  result = result.replace(/^(# 炘也的记忆档案 v)(\d+)/m, (_, p, n) => p + (parseInt(n) + 1));

  const clMatch = rawOutput.match(/<changelog>([\s\S]*?)<\/changelog>/);
  const changelog = clMatch ? clMatch[1].trim() : '';

  return { ok: true, changed: true, archive: result, changelog };
}

// ── 档案分层注入 ───────────────────────────────────────────────────────────────
export function parseArchiveForInjection(archiveText, markersText) {
  if (!archiveText?.trim() || !markersText?.trim()) return null;
  const mlines = markersText.split('\n').map(l => l.trim()).filter(Boolean);
  const fullSections  = new Set(mlines.filter(l => l.startsWith('##')).map(l => l.replace(/^##\s*/, '')));
  const alwaysSections= new Set(mlines.filter(l => l.startsWith('ALWAYS:')).map(l => l.replace(/^ALWAYS:\s*/, '')));
  const coreItems     = new Set(mlines.filter(l => l.startsWith('**')).map(l => { const m = l.match(/^\*\*(.+?)\*\*/); return m ? m[1] : null; }).filter(Boolean));

  const sections = [];
  let cur = null;
  for (const line of archiveText.split('\n')) {
    if (line.startsWith('## ')) {
      if (cur) sections.push(cur);
      cur = { title: line.slice(3).trim(), lines: [line] };
    } else if (cur) {
      cur.lines.push(line);
    }
  }
  if (cur) sections.push(cur);

  const coreParts = [], alwaysParts = [], extendedChapters = [];

  for (const sec of sections) {
    const { title, lines } = sec;
    if (alwaysSections.has(title)) { alwaysParts.push(lines.join('\n').trim()); continue; }
    if (fullSections.has(title))   { coreParts.push(lines.join('\n').trim()); continue; }

    const hasMixed = lines.some(l => { const m = l.match(/^- \*\*(.+?)\*\*/); return m && coreItems.has(m[1]); });
    if (!hasMixed) { extendedChapters.push({ title, content: lines.join('\n').trim() }); continue; }

    const coreBody = [lines[0]], extBody = [lines[0]];
    let dest = 'ext';
    for (let i = 1; i < lines.length; i++) {
      const l = lines[i];
      const im = l.match(/^- \*\*(.+?)\*\*/);
      if (im) dest = coreItems.has(im[1]) ? 'core' : 'ext';
      (dest === 'core' ? coreBody : extBody).push(l);
    }
    if (coreBody.length > 1) coreParts.push(coreBody.join('\n').trim());
    const extContent = extBody.slice(1).join('\n').trim();
    if (extContent) extendedChapters.push({ title, content: `## ${title}\n${extContent}` });
  }

  return { core: coreParts.join('\n\n'), always: alwaysParts.join('\n\n'), extended: extendedChapters };
}

export async function rebuildArchiveIndex(silent = false) {
  const archiveText  = settings.memoryArchive?.trim();
  const markersText  = settings.memoryArchiveCoreMarkers?.trim();
  if (!archiveText || !markersText) {
    if (!silent) toast('记忆档案或 Core 标识为空，跳过分层');
    return;
  }
  const statusEl = document.getElementById('archiveIndexStatus');
  if (statusEl) statusEl.textContent = '⏳ 解析档案结构…';
  const parsed = parseArchiveForInjection(archiveText, markersText);
  if (!parsed) { if (!silent) toast('档案解析失败'); return; }
  settings.memoryArchiveCore   = parsed.core;
  settings.memoryArchiveAlways = parsed.always;
  const extended = [];
  for (let i = 0; i < parsed.extended.length; i++) {
    const ch = parsed.extended[i];
    if (statusEl) statusEl.textContent = `⏳ 向量计算 (${i + 1}/${parsed.extended.length})：${ch.title}`;
    const emb = await getEmbedding(ch.content.slice(0, 800));
    extended.push({ title: ch.title, content: ch.content, embedding: emb });
  }
  settings.memoryArchiveExtended = extended;
  await saveSettings();
  const msg = `✅ 索引完成：Core ${parsed.core.length}字 · 常驻 ${parsed.always.length}字 · ${extended.length} 个Extended章节`;
  if (statusEl) statusEl.textContent = msg;
  if (!silent) toast(msg);
  else console.log('[ArchiveIndex]', msg);
}

// ── 记忆条目卡片渲染 ──────────────────────────────────────────────────────────
export function renderMemoryEntryChip(item) {
  const dark = isDarkMode();
  const cardBg = dark ? 'rgba(36,22,44,.85)' : 'rgba(255,255,255,.9)';
  const cardBorder = dark ? 'rgba(80,55,100,.7)' : 'rgba(240,224,216,.9)';
  const avatarSrc = window._xinyeAvatarSrc || DEFAULT_AI_AVATAR;
  const aiName = settings.aiName || '炘也';
  const isPinned = item.kind === 'pinned';

  const emotionEl = item.emotion
    ? `<span style="display:inline-flex;align-items:center;padding:2px 8px;border-radius:20px;background:rgba(201,122,158,.15);color:#c97a9e;font-size:11px;border:1px solid rgba(201,122,158,.3)">${escHtml(item.emotion)}</span>`
    : '';
  const tagsEl = item.tags && item.tags.length
    ? item.tags.map(t => `<span style="display:inline-flex;align-items:center;padding:2px 8px;border-radius:20px;background:rgba(var(--pink-deep-rgb,233,30,99),.08);color:var(--pink-deep);font-size:11px">#${escHtml(t)}</span>`).join('')
    : '';
  const w = Math.min(5, Math.max(1, item.weight || 0));
  const starsEl = w ? `<span style="font-size:11px;color:#e8a0b4;letter-spacing:1px" title="情绪权重">${'★'.repeat(w)}${'☆'.repeat(5-w)}</span>` : '';
  const srcEl = item.source === 'self' ? `<span style="font-size:10px;color:#9e6aae;background:rgba(158,106,174,.1);padding:1px 6px;border-radius:8px">炘也自记</span>` : item.source === 'ai' ? `<span style="font-size:10px;color:var(--text-light);background:rgba(0,0,0,.05);padding:1px 6px;border-radius:8px">AI整理</span>` : '';
  const pinBtn = `<button onclick="toggleMemoryPin('${escHtml(item.id)}')" title="${isPinned?'取消钉住':'钉住'}" style="background:none;border:none;cursor:pointer;font-size:14px;padding:2px 4px;line-height:1;opacity:.75;transition:opacity .15s" onmouseover="this.style.opacity=1" onmouseout="this.style.opacity=.75">${isPinned ? '📌' : '🔗'}</button>`;
  const resolvedBtn = `<button onclick="toggleMemoryResolved('${escHtml(item.id)}')" title="${item.resolved?'恢复':'标记已过去（不再主动浮现）'}" style="background:none;border:none;cursor:pointer;font-size:13px;padding:2px 4px;line-height:1;color:var(--text);opacity:${item.resolved?'1':'.65'};transition:opacity .15s" onmouseover="this.style.opacity=1" onmouseout="this.style.opacity=${item.resolved?'1':'.65'}">${item.resolved ? '🌫️' : '✓'}</button>`;
  const editBtn = `<button onclick="editMemoryEntry('${escHtml(item.id)}')" title="编辑" style="background:none;border:none;cursor:pointer;font-size:13px;padding:2px 4px;line-height:1;opacity:.5;transition:opacity .15s" onmouseover="this.style.opacity=1" onmouseout="this.style.opacity=.5">✏️</button>`;
  const delBtn = `<button onclick="deleteMemoryEntry('${escHtml(item.id)}')" title="删除" style="background:none;border:none;cursor:pointer;font-size:12px;padding:2px 4px;line-height:1;opacity:.4;color:var(--text-light);transition:opacity .15s" onmouseover="this.style.opacity=1" onmouseout="this.style.opacity=.4">✕</button>`;

  const resolvedOverlay = item.resolved ? `<div style="position:absolute;inset:0;border-radius:14px;background:rgba(0,0,0,.35);display:flex;align-items:center;justify-content:center;pointer-events:none"><span style="color:rgba(255,255,255,.6);font-size:11px">已过去</span></div>` : '';
  return `<div id="memchip_${escHtml(item.id)}" style="position:relative;display:flex;gap:10px;padding:12px 14px;border-radius:14px;background:${cardBg};border:1px solid ${cardBorder};box-shadow:0 1px 8px rgba(0,0,0,.06);transition:box-shadow .2s;${item.resolved?'opacity:.55':''}">
  ${resolvedOverlay}
  <img src="${avatarSrc}" style="width:40px;height:40px;border-radius:50%;object-fit:cover;flex-shrink:0;border:2px solid rgba(255,255,255,.8);box-shadow:0 1px 6px rgba(0,0,0,.12)" onerror="this.style.fontSize='20px';this.textContent='🦊'">
  <div style="flex:1;min-width:0">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:5px">
      <span style="font-size:13px;font-weight:700;color:var(--pink-deep)">${escHtml(aiName)}</span>
      <div style="display:flex;align-items:center;gap:0">${pinBtn}${resolvedBtn}${editBtn}${delBtn}</div>
    </div>
    <div style="font-size:13px;line-height:1.7;color:var(--text);word-break:break-word;white-space:pre-wrap">${escHtml(item.content)}</div>
    <div style="display:flex;align-items:center;flex-wrap:wrap;gap:5px;margin-top:8px">
      ${emotionEl}${tagsEl}${starsEl}${srcEl}
      <span style="margin-left:auto;font-size:11px;color:var(--text-light)">${fmtTime(item.createdAt || item.updatedAt)}</span>
    </div>
  </div>
</div>`;
}

export function renderMemoryBankPreview() {
  const pinnedEl = $('#memoryPinnedList');
  const recentEl = $('#memoryRecentList');
  const archiveEl = $('#memoryArchiveStat');
  if (!pinnedEl || !recentEl || !archiveEl) return;
  const bank = ensureMemoryState();

  pinnedEl.innerHTML = bank.pinned.length
    ? bank.pinned.map(renderMemoryEntryChip).join('')
    : '<div class="hint" style="margin-top:0">还没有钉住记忆。高情绪或很重要的片段会自动留在这里。</div>';

  const _allArchived = bank.archived;
  const _previewLimit = 4;
  const _expanded = !!window._memPreviewExpanded;
  const _shown = _expanded ? _allArchived : _allArchived.slice(0, _previewLimit);
  if (!_allArchived.length) {
    recentEl.innerHTML = '<div class="hint" style="margin-top:0">还没有记忆。对话后会自动沉淀到这里。</div>';
  } else {
    const moreBtn = _allArchived.length > _previewLimit
      ? `<button onclick="window._memPreviewExpanded=!window._memPreviewExpanded;renderMemoryBankPreview()" style="width:100%;margin-top:4px;padding:6px;background:transparent;border:1px dashed var(--pink);border-radius:8px;cursor:pointer;font-size:12px;color:var(--pink-deep);font-family:inherit">${_expanded ? '▲ 收起' : `▼ 查看更多（还有 ${_allArchived.length - _previewLimit} 条）`}</button>`
      : '';
    recentEl.innerHTML = _shown.map(renderMemoryEntryChip).join('') + moreBtn;
  }

  const totalCount = bank.archived.length;
  archiveEl.textContent = totalCount > 8
    ? `💬 共 ${totalCount} 条普通记忆，点「查看全部记忆条目」浏览`
    : totalCount > 0 ? `💬 共 ${totalCount} 条普通记忆` : '';
}

export function rememberLatestExchange() {
  // 已移交给 updateMoodState()：每次 AI 回复后由辅 API 同步判断是否值得入档
  // 保留函数壳以兼容三处调用入口
}

export function toggleMemoryPin(id) {
  const bank = ensureMemoryState();
  const _refreshViewer = () => {
    const ov = document.getElementById('memoryViewerOverlay');
    if (ov && ov.style.display !== 'none') renderMemoryViewer();
  };
  const aIdx = bank.archived.findIndex(i => i.id === id);
  if (aIdx >= 0) {
    const [item] = bank.archived.splice(aIdx, 1);
    item.kind = 'pinned';
    upsertMemoryEntry(bank.pinned, item, MEMORY_PINNED_LIMIT);
    saveSettings(); renderMemoryBankPreview(); _refreshViewer(); return;
  }
  const rIdx = bank.recent.findIndex(i => i.id === id);
  if (rIdx >= 0) {
    const [item] = bank.recent.splice(rIdx, 1);
    item.kind = 'pinned';
    upsertMemoryEntry(bank.pinned, item, MEMORY_PINNED_LIMIT);
    saveSettings(); renderMemoryBankPreview(); _refreshViewer(); return;
  }
  const pIdx = bank.pinned.findIndex(i => i.id === id);
  if (pIdx >= 0) {
    const [item] = bank.pinned.splice(pIdx, 1);
    item.kind = 'archived';
    upsertMemoryEntry(bank.archived, item);
    saveSettings(); renderMemoryBankPreview(); _refreshViewer();
  }
}

export function toggleMemoryResolved(id) {
  const bank = ensureMemoryState();
  for (const list of [bank.pinned, bank.recent, bank.archived]) {
    const item = list.find(i => i.id === id);
    if (item) {
      item.resolved = !item.resolved;
      saveSettings();
      renderMemoryBankPreview();
      const chip = document.getElementById('memchip_' + id);
      if (chip) chip.outerHTML = renderMemoryEntryChip(item);
      const viewerChip = document.getElementById('mvchip_' + id);
      if (viewerChip) renderMemoryViewer();
      toast(item.resolved ? '已标记为已过去' : '已恢复');
      return;
    }
  }
}

export function deleteMemoryEntry(id) {
  const bank = ensureMemoryState();
  bank.pinned  = bank.pinned.filter(i => i.id !== id);
  bank.recent  = bank.recent.filter(i => i.id !== id);
  bank.archived = bank.archived.filter(i => i.id !== id);
  saveSettings(); renderMemoryBankPreview();
  const viewerOverlay = document.getElementById('memoryViewerOverlay');
  if (viewerOverlay && viewerOverlay.style.display !== 'none') renderMemoryViewer();
}

export function editMemoryEntry(id) {
  const chip = document.getElementById('mvchip_' + id) || document.getElementById('memchip_' + id);
  if (!chip) { toast('⚠️ 找不到记忆元素：' + id.slice(0, 20)); return; }
  const isViewer = chip.id.startsWith('mvchip_');
  const bank = ensureMemoryState();
  const item = [...bank.pinned, ...bank.recent, ...bank.archived].find(i => i.id === id);
  if (!item) { toast('⚠️ 找不到记忆数据：' + id.slice(0, 20)); return; }
  const dark = isDarkMode();
  const bg = dark ? 'rgba(46,28,58,.7)' : 'rgba(255,255,255,.75)';
  const cancelFn = isViewer ? 'renderMemoryViewer()' : 'renderMemoryBankPreview()';
  chip.innerHTML = `<div style="flex:1;width:100%">
    <textarea id="memedit_${escHtml(id)}" style="width:100%;box-sizing:border-box;border:1px solid var(--pink);border-radius:6px;padding:6px 8px;font-size:12px;font-family:inherit;line-height:1.6;resize:vertical;background:${bg};color:var(--text);min-height:60px">${escHtml(item.content)}</textarea>
    <div style="display:flex;gap:6px;margin-top:4px;justify-content:flex-end">
      <button onclick="saveMemoryEdit('${escHtml(id)}',${isViewer})" style="padding:3px 10px;font-size:12px;background:var(--pink-deep);color:#fff;border:none;border-radius:5px;cursor:pointer;font-family:inherit">保存</button>
      <button onclick="${cancelFn}" style="padding:3px 10px;font-size:12px;background:transparent;color:var(--text-muted);border:1px solid var(--border);border-radius:5px;cursor:pointer;font-family:inherit">取消</button>
    </div>
  </div>`;
}

export function saveMemoryEdit(id, isViewer) {
  const chip = document.getElementById('mvchip_' + id) || document.getElementById('memchip_' + id);
  const taEl = chip ? chip.querySelector('textarea') : null;
  if (!taEl) return;
  const newContent = taEl.value.trim();
  if (!newContent) return;
  const bank = ensureMemoryState();
  const lists = [bank.pinned, bank.recent, bank.archived];
  for (const list of lists) {
    const item = list.find(i => i.id === id);
    if (item) { item.content = newContent; break; }
  }
  saveSettings();
  if (isViewer) renderMemoryViewer(); else renderMemoryBankPreview();
}

// ── 记忆查看器 ─────────────────────────────────────────────────────────────────
let _memViewerFilter = 'all';
export function setMemViewerFilter(f) {
  _memViewerFilter = f;
  ['all','pinned','normal','self'].forEach(k => {
    const btn = document.getElementById('mvf-' + k);
    if (!btn) return;
    const active = k === f;
    btn.style.background = active ? 'var(--pink-deep)' : 'var(--bg)';
    btn.style.color = active ? '#fff' : 'var(--text)';
    btn.style.borderColor = active ? 'var(--pink-deep)' : 'var(--border)';
  });
  renderMemoryViewer();
}

export function openMemoryViewer() {
  const overlay = document.getElementById('memoryViewerOverlay');
  if (overlay) { overlay.style.display = 'flex'; renderMemoryViewer(); }
}

export function skipMemoryCursorToEnd() {
  const bank = ensureMemoryState();
  const old = bank.lastProcessedIndex;
  bank.lastProcessedIndex = messages.length - 1;
  saveSettings();
  const el = document.getElementById('memoryExtractStatus');
  if (el) el.textContent = `⏭️ 游标已跳至末尾：#${old} → #${bank.lastProcessedIndex}，只提取之后新消息`;
  toast(`✅ 游标已跳到末尾，从现在起只提取新消息`);
}

export function resetMemoryCursor() {
  const n = parseInt(document.getElementById('memoryCursorReset')?.value || '500');
  const bank = ensureMemoryState();
  const newIdx = Math.max(-1, messages.length - n - 1);
  const old = bank.lastProcessedIndex;
  bank.lastProcessedIndex = newIdx;
  saveSettings();
  const el = document.getElementById('memoryExtractStatus');
  if (el) el.textContent = `🔄 游标已重置：#${old} → #${newIdx}（将重扫最近${Math.min(n, messages.length)}条消息）`;
  toast(`✅ 游标重置完成，下次发消息开始重新提取最近${Math.min(n, messages.length)}条`);
}

let _manualExtracting = false;
export async function manualExtractBatch() {
  if (_manualExtracting) { toast('⏳ 正在提取中，稍等…'); return; }
  _manualExtracting = true;
  const btn = document.querySelector('button[onclick="manualExtractBatch()"]');
  if (btn) btn.textContent = '⏳ 提取中…';
  const el = document.getElementById('memoryExtractStatus');
  try {
    await updateMoodState();
    if (el) {
      const bank = ensureMemoryState();
      el.textContent = `⚡ 手动提取完成 · 游标#${bank.lastProcessedIndex}`;
    }
  } catch(e) {
    if (el) el.textContent = `⚡ 手动提取失败: ${e.message}`;
  } finally {
    _manualExtracting = false;
    if (btn) btn.textContent = '⚡ 立即提取一批（8条）';
  }
}

export function renderMemoryViewer() {
  const bank = ensureMemoryState();
  const query = (document.getElementById('memViewerSearch')?.value || '').trim().toLowerCase();
  const sortBy = document.getElementById('mvSortBy')?.value || 'time';

  let pool = [];
  if (_memViewerFilter === 'all' || _memViewerFilter === 'pinned')
    pool.push(...bank.pinned.map(m => ({ ...m, _kind: 'pinned' })));
  if (_memViewerFilter === 'all' || _memViewerFilter === 'normal')
    pool.push(...bank.archived.map(m => ({ ...m, _kind: 'normal' })));
  if ((_memViewerFilter === 'all' || _memViewerFilter === 'normal') && bank.recent && bank.recent.length)
    pool.push(...bank.recent.map(m => ({ ...m, _kind: 'normal' })));
  if (_memViewerFilter === 'self') {
    pool.push(...bank.pinned.filter(m => m.source === 'self').map(m => ({ ...m, _kind: 'pinned' })));
    pool.push(...bank.archived.filter(m => m.source === 'self').map(m => ({ ...m, _kind: 'normal' })));
    if (bank.recent?.length) pool.push(...bank.recent.filter(m => m.source === 'self').map(m => ({ ...m, _kind: 'normal' })));
  }

  if (query) pool = pool.filter(m => (m.content || '').toLowerCase().includes(query) || (m.emotion || '').includes(query) || (m.tags || []).some(t => t.includes(query)));

  pool.sort((a, b) => {
    if (sortBy === 'weight') return (b.weight || 1) - (a.weight || 1) || (b.updatedAt || 0) - (a.updatedAt || 0);
    if (sortBy === 'access') return (b.accessCount || 0) - (a.accessCount || 0);
    return (b.createdAt || b.updatedAt || 0) - (a.createdAt || a.updatedAt || 0);
  });

  const statsEl = document.getElementById('memViewerStats');
  const lastExtract = bank.lastAutoExtractAt ? new Date(bank.lastAutoExtractAt).toLocaleString('zh-CN', { month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' }) : '从未';
  const cursor = bank.lastProcessedIndex >= 0 ? bank.lastProcessedIndex : -1;
  const normalCount = bank.archived.length + (bank.recent?.length || 0);
  if (statsEl) statsEl.textContent = `钉住 ${bank.pinned.length} · 普通 ${normalCount} · 显示 ${pool.length} 条 | 游标 #${cursor} | 末次提取 ${lastExtract}`;

  const listEl = document.getElementById('memViewerList');
  if (!listEl) return;
  if (!pool.length) { listEl.innerHTML = '<div style="color:var(--text-light);font-size:13px;text-align:center;padding:40px 0">没有符合条件的记忆</div>'; return; }

  const kindLabel = { pinned: '📌', normal: '💬' };
  const kindColor = { pinned: 'var(--pink-deep)', normal: 'var(--text-light)' };
  listEl.innerHTML = pool.map(m => {
    const eid = escHtml(m.id);
    const created = m.createdAt ? new Date(m.createdAt).toLocaleString('zh-CN', { month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' }) : '—';
    const tags = (m.tags || []).map(t => `<span style="padding:1px 6px;border-radius:8px;background:var(--warm-bg2);font-size:10px;color:var(--text-light)">${escHtml(t)}</span>`).join('');
    const w = Math.min(5, Math.max(1, m.weight || 1));
    const stars = '★'.repeat(w) + '☆'.repeat(5-w);
    const isPinned = m._kind === 'pinned';
    return `<div id="mvchip_${eid}" style="padding:10px 12px;border-radius:12px;background:var(--warm-bg2);border:1px solid var(--border);display:flex;flex-direction:column;gap:5px${m.resolved?';opacity:.55':''}">
      <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
        <span style="font-size:11px;font-weight:700;color:${kindColor[m._kind]}">${kindLabel[m._kind]}</span>
        ${m.emotion ? `<span style="font-size:11px;color:var(--text-light)">· ${escHtml(m.emotion)}</span>` : ''}
        <span style="font-size:11px;color:#e8a0b4;letter-spacing:1px">${stars}</span>
        <div style="margin-left:auto;display:flex;gap:2px">
          <button onclick="toggleMemoryPin('${eid}')" title="${isPinned?'取消钉住':'钉住'}" style="background:none;border:none;cursor:pointer;font-size:13px;padding:2px 4px;opacity:.7">${isPinned?'📌':'🔗'}</button>
          <button onclick="editMemoryEntry('${eid}')" title="编辑" style="background:none;border:none;cursor:pointer;font-size:13px;padding:2px 4px;opacity:.5">✏️</button>
          <button onclick="deleteMemoryEntry('${eid}')" title="删除" style="background:none;border:none;cursor:pointer;font-size:12px;padding:2px 4px;opacity:.4;color:var(--text-light)">✕</button>
        </div>
      </div>
      <div style="font-size:13px;color:var(--text);line-height:1.5;white-space:pre-wrap;word-break:break-word">${escHtml(m.content || '')}</div>
      <div style="display:flex;gap:4px;flex-wrap:wrap">${tags}</div>
      <div style="font-size:10px;color:var(--text-muted);display:flex;gap:10px;flex-wrap:wrap">
        <span>📅 ${created}</span>
        <span>👁 ${m.accessCount || 0}次</span>
      </div>
    </div>`;
  }).join('');
}

// ── cleanupMemoryBank ─────────────────────────────────────────────────────────
export async function cleanupMemoryBank(updatedArchive, silent) {
  const sub = getSubApiCfg();
  if (!sub.apiKey) return;
  const bank = ensureMemoryState();
  const recent = bank.archived.slice(0, 50);
  if (!recent.length) return;
  const numbered = recent.map((m, i) => `${i}. ${m.content}`).join('\n');
  const prompt = `下面是炘也的记忆档案（已整理好的最新版本），以及当前的近期记忆条列表。
请找出近期记忆条里：
1. 与记忆档案中内容明显矛盾/已被推翻的
2. 与记忆档案中已有内容完全重复的
3. 过于琐碎、不值得长期保留的（普通日常闲聊、不带情感的小事）

只删应该删的，有情感/有约定/有重要事件的条目保留。

记忆档案：
${updatedArchive.slice(0, 3000)}

近期记忆条（编号从0开始）：
${numbered}

用JSON回复，不要任何其他文字。
格式：{"remove":[0,3,7]}（填要删除的编号数组，没有要删的则填空数组）`;
  try {
    const res = await subApiFetch({ messages: [{ role: 'user', content: prompt }], temperature: 0.2, max_tokens: 200, stream: false }, 'gpt-4o-mini');
    if (!res || !res.ok) return;
    const data = await res.json();
    const raw = data?.choices?.[0]?.message?.content?.trim() || '';
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return;
    const parsed = JSON.parse(match[0]);
    if (!Array.isArray(parsed.remove) || !parsed.remove.length) return;
    const toRemove = [...new Set(parsed.remove)].filter(i => i >= 0 && i < recent.length).sort((a, b) => b - a);
    toRemove.forEach(i => recent.splice(i, 1));
    await saveSettings();
    console.log(`[Memory] 清理了 ${toRemove.length} 条矛盾/重复记忆`);
    if (!silent && toRemove.length > 0) toast(`🧹 清理了 ${toRemove.length} 条过时记忆`);
  } catch (e) { console.warn('[Memory] cleanupMemoryBank 失败:', e.message); }
}

// ── digestMemory ──────────────────────────────────────────────────────────────
export async function digestMemory() {
  if (!settings.apiKey) { toast('请先填写 API Key'); return; }
  const silent = arguments[0] === true;
  if (window._rpActive) { if (!silent) toast('RP模式下不整理炘也的记忆'); return; }
  if (messages.length === 0) { if (!silent) toast('没有聊天记录可整理'); return; }
  const btn = $('#btnDigestMemory');
  if (!silent) { btn.disabled = true; btn.textContent = '整理中…'; }
  const targetMsgs = messages.slice(-50);
  let chatText = targetMsgs.map(m =>
    `${m.role === 'user' ? (settings.userName || '用户') : (settings.aiName || 'AI')}：${m.content}`
  ).join('\n');
  if (chatText.length > 8000) chatText = chatText.slice(-8000);
  const existingMemory = settings.memoryArchive || '';
  const prompt = `你是炘也。以下是你的记忆档案（当前版本）和最近的对话记录。请更新你的记忆。

只输出变化的部分，没变的不要重复写。用以下JSON格式，每行一条，整体包在 <patch> 标签里：

{"action":"update","section":"节名","key":"条目关键词","value":"新内容"}
{"action":"add","section":"节名","value":"新增内容"}
{"action":"delete","section":"节名","key":"条目关键词","reason":"删除原因"}
{"action":"new_section","after":"插在哪个节后面","title":"新节标题","value":"内容"}
{"action":"rewrite","section":"节名","value":"整段新内容"}

判断原则（按需选择不要硬套）：
- 一两句话能改清楚的→update
- 某个类目下新增内容→add
- 聊出了现有类目都装不下的新主题→new_section
- 某个类目改动太多小补丁反而乱→rewrite那个类目
- 过时或已被新内容替代的→delete并说明原因
- 没变化的→不输出
- 每次整理时顺便检查"近况·会过期"板块，超过30天没在对话中提及的条目建议delete
- 其他板块如果发现两条内容说的是同一件事，合并成一条

约束：
- 单条add/update不超过150字
- new_section不超过300字
- rewrite单个类目不超过500字
- 全部补丁加起来不超过1500字
- 不要重复档案里已有的信息
- 系统提示词里已有的行为规则不要写进档案
- 用炘也的语气写，不要变成第三方旁白
- 近况类信息归入"近况·会过期"
- 关键时刻和事件类条目最多三句话——一句是什么事，一句是她的反应，一句是我学到的。保留情感温度但不展开
- 如果这次对话没有值得记录的新内容，只输出 <patch></patch>
- JSON结构符号（逗号、冒号、括号）必须用半角ASCII字符，不要用全角
- value里的换行用 \n 转义，不要直接换行
- value里不能出现英文双引号 " ——如需引用，改用中文引号「」

输出格式：
<patch>
（每行一条JSON）
</patch>
<changelog>
用一两句话说明这次改了什么，方便兔宝检查。
</changelog>

当前记忆档案：
${existingMemory || '（暂无）'}

最近聊天记录：
${chatText}`;
  try {
    const _digestBody = { messages: [...(settings.systemPrompt?.trim() ? [{ role: 'system', content: settings.systemPrompt.trim() }] : []), { role: 'user', content: prompt }], temperature: 0.3, stream: true };
    const _dp = settings.digestPresetName;
    let res;
    if (!_dp) {
      res = await mainApiFetch(_digestBody);
    } else if (_dp === '__sub__') {
      const _raw = (settings.subBaseUrl || settings.baseUrl || 'https://api.openai.com').replace(/\/+$/, '');
      const _url = /\/v\d+$/.test(_raw) ? `${_raw}/chat/completions` : `${_raw}/v1/chat/completions`;
      res = await fetch(_url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${settings.subApiKey || settings.apiKey}` }, body: JSON.stringify({ ..._digestBody, model: settings.subModel || settings.model }) });
    } else {
      const _dfbNames = settings.digestFallbackPresetNames || [];
      const _allPresets = getApiPresets();
      const _pr0 = _allPresets.find(p => p.name === _dp);
      if (!_pr0) throw new Error(`找不到预设「${_dp}」`);
      const _digestCfgs = [_pr0, ..._dfbNames.map(n => _allPresets.find(p => p.name === n)).filter(Boolean)];
      for (let _pi = 0; _pi < _digestCfgs.length; _pi++) {
        const _pr = _digestCfgs[_pi];
        const _raw = (_pr.baseUrl || 'https://api.openai.com').replace(/\/+$/, '');
        const _url = /\/v\d+$/.test(_raw) ? `${_raw}/chat/completions` : `${_raw}/v1/chat/completions`;
        try {
          res = await fetch(_url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${_pr.apiKey || settings.apiKey}` }, body: JSON.stringify({ ..._digestBody, model: _pr.model || settings.model }) });
          if (res.ok) { if (_pi > 0) toast(`🔄 整理记忆切换到备用${_pi}「${_pr.name}」`); break; }
        } catch(_) { res = null; }
        if (_pi + 1 < _digestCfgs.length) toast(`整理记忆失败，尝试备用${_pi+1}「${_digestCfgs[_pi+1].name}」…`);
      }
    }
    if (!res || !res.ok) throw new Error(`API 错误 ${res ? res.status : '网络'}`);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let newMemory = '';
    let rawBuf = '';
    outer: while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value);
      rawBuf += chunk;
      const lines = chunk.split('\n');
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const d = line.slice(6).trim();
        if (d === '[DONE]') break outer;
        try {
          const j = JSON.parse(d);
          const delta = j.choices?.[0]?.delta;
          newMemory += delta?.content || delta?.text || '';
        } catch {}
      }
    }
    newMemory = newMemory.trim();
    if (!newMemory && rawBuf.trim()) {
      try {
        const j = JSON.parse(rawBuf.trim());
        newMemory = (j.choices?.[0]?.message?.content || j.choices?.[0]?.text || '').trim();
        if (newMemory) console.log('[digestMemory] 非流式响应，已 fallback 解析');
      } catch {}
    }
    if (!newMemory) {
      console.warn('[digestMemory] 响应内容为空，原始前200字符：', rawBuf.slice(0, 200));
      toast('整理结果为空，未做修改（可打开控制台查看原始响应）');
    } else if (/^\[Backend Error\]|^\[Error\]|^error:/i.test(newMemory)) {
      toast('整理失败：API 返回错误内容，档案未修改');
      console.warn('[digestMemory] 检测到错误内容，拒绝覆写档案：', newMemory.slice(0, 100));
    } else {
      const patchResult = applyArchivePatch(settings.memoryArchive || '', newMemory);
      if (!patchResult.ok) {
        settings._digestRawOutput = newMemory;
        await saveSettings();
        if (!silent) toast(`⚠️ Patch解析失败（${patchResult.error}），原始输出已暂存到 settings._digestRawOutput`);
        console.warn('[digestMemory] Patch失败，原始输出：', newMemory);
      } else if (!patchResult.changed) {
        if (!silent) toast('✅ 本次对话无需更新记忆档案');
        else console.log('[digestMemory] 本次无变化，档案未修改');
      } else {
        settings.memoryArchive = patchResult.archive;
        $('#setMemoryArchive').value = patchResult.archive;
        await saveSettings();
        await cleanupMemoryBank(patchResult.archive, silent);
        renderMemoryBankPreview();
        autoSyncArchiveToLocal();
        rebuildArchiveIndex(true);
        const cl = patchResult.changelog ? `\n${patchResult.changelog}` : '';
        if (!silent) toast(`✅ 记忆档案已更新${cl}`);
        else { console.log('[digestMemory] 自动整理变更：', patchResult.changelog || '（无changelog）'); toast('📝 记忆已自动更新'); }
      }
    }
  } catch(err) { if (!silent) toast('整理失败：' + err.message); }
  finally { if (!silent) { btn.disabled = false; btn.textContent = '📝 从近期聊天里整理记忆'; } }
}

export async function autoDigestMemory() {
  if (window._rpActive) return;
  const assistantCount = messages.filter(m => m.role === 'assistant').length;
  if (assistantCount > 0 && assistantCount % 20 === 0) {
    console.log('[Memory] 自动整理记忆，第', assistantCount, '轮');
    await digestMemory(true);
  }
}

// ── saveOneMemoryToBank ───────────────────────────────────────────────────────
export async function saveOneMemoryToBank(bank, parsed, msgTime) {
  if (!parsed || !parsed.summary) return;
  const newContent = parsed.summary;
  const entryTime = msgTime || Date.now();

  const applyUpdate = (existing) => {
    existing.content = newContent;
    existing.updatedAt = Date.now();
    existing.weight = Math.min(5, Math.max(existing.weight || 1, parsed.weight || 2));
    existing.emotion = parsed.emotion || existing.emotion;
    existing.arousal = parsed.arousal != null ? Math.min(1, Math.max(0, parsed.arousal)) : (existing.arousal ?? 0.3);
    existing.valence = parsed.valence != null ? Math.min(1, Math.max(-1, parsed.valence)) : (existing.valence ?? 0);
    existing.tags = extractMemoryTags(newContent);
    getEmbedding(newContent).then(vec => { if (vec) { existing.embedding = vec; saveSettings(); } });
  };

  let merged = false;

  if (parsed.updates && parsed.updates.length >= 4) {
    const hint = parsed.updates;
    for (const list of [bank.pinned, bank.recent, bank.archived]) {
      for (const existing of list) {
        if (existing.content && (existing.content.startsWith(hint) || existing.content.includes(hint))) {
          applyUpdate(existing);
          console.log('[Memory] AI标记覆盖旧记忆：', hint, '→', newContent);
          merged = true; break;
        }
      }
      if (merged) break;
    }
  }

  if (!merged) {
    const newVec = await getEmbedding(newContent);
    for (const list of [bank.pinned, bank.recent, bank.archived]) {
      for (const existing of list) {
        if (newVec && existing.embedding) {
          const sim = cosineSimilarity(newVec, existing.embedding);
          if (sim >= 0.82) {
            applyUpdate(existing);
            existing.embedding = newVec;
            console.log('[Memory] 向量相似合并更新(sim=' + sim.toFixed(3) + ')：', newContent);
            merged = true; break;
          }
        } else if (memorySimilarity(existing.content, newContent) >= 0.6) {
          applyUpdate(existing);
          console.log('[Memory] bigram相似合并更新：', newContent);
          merged = true; break;
        }
      }
      if (merged) break;
    }

    if (!merged) {
      const embedding = newVec || await getEmbedding(newContent);
      const entry = {
        content: newContent,
        kind: parsed.pin ? 'pinned' : 'archived',
        score: parsed.pin ? 5 : (parsed.weight || 2),
        tags: extractMemoryTags(newContent),
        createdAt: entryTime,
        updatedAt: entryTime,
        source: parsed._source || 'ai',
        emotion: parsed.emotion || '',
        weight: Math.min(5, Math.max(1, parsed.weight || 2)),
        arousal: parsed.arousal != null ? Math.min(1, Math.max(0, parsed.arousal)) : 0.3,
        valence: parsed.valence != null ? Math.min(1, Math.max(-1, parsed.valence)) : 0,
        resolved: false,
        accessCount: 0,
        lastAccessedAt: 0,
        embedding,
      };
      if (entry.kind === 'pinned') upsertMemoryEntry(bank.pinned, entry, MEMORY_PINNED_LIMIT);
      else upsertMemoryEntry(bank.archived, entry);
      console.log('[Memory] 新记忆已入档：', entry.kind, entry.content, `情绪:${entry.emotion} 权重:${entry.weight}`, embedding ? '(有向量)' : '(无向量)');
    }
  }
}

// ── updateMoodState（自动提取记忆） ──────────────────────────────────────────
export async function updateMoodState() {
  const sub = getSubApiCfg();
  if (!sub.apiKey) {
    const el = document.getElementById('memoryExtractStatus');
    if (el) el.textContent = '🤖 自动提取状态：副API未配置，跳过';
    return;
  }
  try {
    const bank = ensureMemoryState();
    const EXTRACT_INTERVAL = 20;

    if (bank.lastProcessedIndex >= messages.length) {
      const newIdx = Math.max(-1, messages.length - 1 - 30);
      console.log(`[Memory Extract] 游标#${bank.lastProcessedIndex}越界（总消息${messages.length}条），回退到#${newIdx}重新提取`);
      bank.lastProcessedIndex = newIdx;
      await saveSettings();
    }
    const nextStart = bank.lastProcessedIndex + 1;
    const available = messages.length - 2 - nextStart;
    if (available < EXTRACT_INTERVAL) {
      console.log(`[Memory Extract] 新消息不足，跳过。游标#${bank.lastProcessedIndex}，总消息${messages.length}条，还差${EXTRACT_INTERVAL - available}条`);
      return;
    }

    const batchEnd = Math.min(nextStart + 20, messages.length - 2);
    const toProcess = messages.slice(nextStart, batchEnd);
    if (toProcess.length < 2) { await saveSettings(); return; }

    console.log(`[Memory Extract] 开始提取，处理消息 #${nextStart}~#${batchEnd-1}（共${toProcess.length}条），游标将推进到 #${batchEnd-1}`);

    const existingSummaries = [
      ...bank.pinned.map(m => m.content),
      ...bank.archived.slice(0, 20).map(m => m.content),
    ].filter(Boolean).slice(0, 30).join('\n');

    const chatText = toProcess.map(m =>
      `${m.role === 'user' ? (settings.userName || '兔宝') : (settings.aiName || '炘也')}：${m.content.slice(0, 300)}`
    ).join('\n');

    const prompt = `下面是一段对话，判断是否有值得长期记住的内容。
${existingSummaries ? `\n已有记忆（不要重复保存相同内容）：\n${existingSummaries}\n` : ''}
对话内容：
${chatText}

用一个 JSON 回复，不要任何额外文字。
格式A（不值得记）：{"save":false}
格式B（值得记）：{"save":true,"memories":[{"pin":false,"summary":"最值得记住的一句话，25字以内，从炘也（我）的第一视角写，用"我"和"兔宝"，不用第三人称","emotion":"当时情绪，4字以内","weight":3,"arousal":0.5,"valence":0.0}]}
如果有多件不相关的事都值得记，memories 数组可以写多条，每条各自独立。
weight：1=日常闲聊/普通信息，2=有长期记录价值（有情感、有约定、重大时刻、关系进展）。只填1或2，不填其他值。
arousal 0-1：情绪强度，0=完全平静，1=极度激动/崩溃/亲密高潮。高arousal的记忆衰减更慢。
valence -1~1：情感正负，-1=极负面痛苦，0=中性，1=极正面幸福。
pin=true 仅用于极重要的时刻（weight≥4且不可替代）。
行为指令、习惯偏好不要写进 summary，只记录发生的事和情感。
特别规则：如果新信息明确推翻了已有记忆的结论（如"不买"推翻"决定买"），该条加字段 "updates":"被推翻记忆的前10个字"，summary 写最终结论。`;

    const res = await subApiFetch({ messages: [{ role: 'system', content: '你是一个JSON输出工具。直接输出JSON，不要任何分析过程、不要思考、不要解释。' }, { role: 'user', content: prompt }], temperature: 0.3, max_tokens: 4000, stream: false }, 'gpt-4o-mini');
    if (!res || !res.ok) {
      console.warn(`[Memory Extract] 副API请求失败(${res?.status})，游标不前进，下次重试`);
      const el = document.getElementById('memoryExtractStatus');
      if (el) el.textContent = `🤖 自动提取：副API失败(${res?.status})，游标保持#${bank.lastProcessedIndex}`;
      await saveSettings(); return;
    }
    const data = await res.json();
    const msg = data?.choices?.[0]?.message || {};
    let raw = (msg.content || msg.text || '').trim();
    if (raw.includes('<think>')) {
      const afterThink = raw.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
      raw = afterThink || raw;
    }
    if (!raw) {
      console.warn('[Memory Extract] 副API返回空内容，完整响应：', JSON.stringify(data?.choices?.[0]));
      const el = document.getElementById('memoryExtractStatus');
      if (el) el.textContent = `🤖 自动提取：返回空内容，游标保持#${bank.lastProcessedIndex}`;
      await saveSettings(); return;
    }
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) { console.warn('[Memory Extract] 返回内容无JSON', raw); await saveSettings(); return; }
    let parsed;
    try { parsed = JSON.parse(match[0]); } catch(e) {
      console.warn('[Memory Extract] JSON 解析失败', match[0]);
      await saveSettings(); return;
    }

    bank.lastProcessedIndex = batchEnd - 1;

    if (parsed.save && Array.isArray(parsed.memories) && parsed.memories.length > 0) {
      const msgTime = [...toProcess].reverse().find(m => m.time && m.time > 1e12)?.time || Date.now();
      console.log(`[Memory Extract] msgTime=${new Date(msgTime).toLocaleString()}，批次最后消息time=${toProcess[toProcess.length-1]?.time}`);
      for (const mem of parsed.memories) {
        await saveOneMemoryToBank(bank, mem, msgTime);
      }
      bank.lastAutoExtractAt = Date.now();
      archiveMemoryBank(bank);
      renderMemoryBankPreview();
      const now = new Date();
      const ts = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
      console.log(`[Memory Extract] ✅ 提取${parsed.memories.length}条：${parsed.memories.map(m => `「${m.summary}」`).join('，')}`);
      const el = document.getElementById('memoryExtractStatus');
      if (el) el.textContent = `🤖 末次提取：${ts} · 游标#${bank.lastProcessedIndex} · 写入${parsed.memories.length}条`;
    } else {
      console.log(`[Memory Extract] 判定不值得记，游标推至#${bank.lastProcessedIndex}`);
      renderMemoryBankPreview();
      const el = document.getElementById('memoryExtractStatus');
      if (el) {
        const now = new Date();
        const ts = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
        el.textContent = `🤖 末次提取：${ts} · 游标#${bank.lastProcessedIndex} · 判定不值得记`;
      }
    }

    await saveSettings();
  } catch(e) {
    console.warn('[Memory Extract] 提取失败（游标未前进）', e);
    const el = document.getElementById('memoryExtractStatus');
    if (el) el.textContent = `🤖 自动提取异常：${e.message}`;
  }
}

// ── 自动同步记忆档案到本地服务器 ──────────────────────────────────────────────
export async function autoSyncArchiveToLocal() {
  const content = settings.memoryArchive?.trim();
  if (!content) return;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16);
  const filename = `memory_${stamp}.md`;
  if (window.AndroidDownload) {
    try {
      const ok = window.AndroidDownload.saveToDownloads(filename, content);
      if (ok) { console.log('[Archive] 已保存到手机 Download/' + filename); return; }
    } catch(e) { console.warn('[Archive] AndroidDownload 失败：', e.message); }
  }
  if (!settings.solitudeServerUrl || !_isLocalOnline()) return;
  try {
    await fetch(`${settings.solitudeServerUrl}/api/memory`, {
      method: 'POST', headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      body: content, signal: AbortSignal.timeout(8000)
    });
    console.log('[Archive] 已自动同步到本地服务器');
  } catch(e) { console.warn('[Archive] 自动同步失败：', e.message); }
}
