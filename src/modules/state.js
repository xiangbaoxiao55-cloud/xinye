import { dbPut } from './db.js';

export const settings = {
  apiKey: '', baseUrl: 'https://api.openai.com', fallbackPresetNames: [], model: 'gpt-4o', apiFormat: 'openai',
  subApiKey: '', subBaseUrl: '', subFallbackPresetNames: [], subModel: '',
  embeddingApiKey: '', embeddingBaseUrl: '', embeddingModel: '',
  visionApiKey: '', visionBaseUrl: '', visionModel: '',
  imageApiKey: '', imageBaseUrl: '', imageModel: 'gpt-image-1', imageSize: '1024x1024',
  contextCount: 20, systemPrompt: '', shortReply: false,
  aiName: '炘也', userName: '兔宝', togetherSince: '2026-02-13',
  bgOpacity: 0.3, bgBlur: 0, bubbleOpacity: 0.85,
  streamMode: false,
  ttsType: 'local',
  ttsUrl: 'http://127.0.0.1:9880',
  ttsRefPath: '', ttsRefText: '',
  ttsRefLang: 'zh', ttsTargetLang: 'zh',
  ttsGptWeights: '', ttsSovitsWeights: '',
  ttsPresets: [], ttsAutoPlay: false,
  doubaoAppId: '', doubaoToken: '', doubaoVoice: '', doubaoCluster: 'volcano_tts',
  doubaoProxy: '',
  mosiKey: '', mosiVoiceId: '',
  minimaxKey: '', minimaxGroupId: '', minimaxVoiceId: '', minimaxModel: '', minimaxProxy: '',
  idleRemind: 0, waterRemind: 0, standRemind: 0, dreamEnabled: false, dreamSleepHours: 6,
  heartbeatEnabled: false, quietHoursStart: 0, quietHoursEnd: 8,
  memoryArchive: '',
  memoryArchiveCoreMarkers: '',
  memoryArchiveCore: '',
  memoryArchiveAlways: '',
  memoryArchiveExtended: [],
  displayLimit: 0,
  braveKey: '',
  searchDays: 3,
  searchCount: 5,
  forumProxy: '',
  solitudeServerUrl: '',
  cloudServerUrl: '', cloudServerToken: '',
  healthWorkerUrl: '', healthWorkerToken: '',
  moodState: null,
  memoryBank: null,
  bookmarks: [],
  emailContacts: [],
};

export const messages = [];

// ── saveSettings 回调注入（scheduleAutoSave 在 main.js 里，避免循环依赖） ──────
let _scheduleAutoSave = () => {};
export function initSaveHook(fn) { _scheduleAutoSave = fn; }

// ── memory state helpers（被 saveSettings 和 memory.js 共用） ─────────────────
export function createMemoryId() {
  return `mem_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function normalizeMemoryEntry(entry, kind = 'archived') {
  if (!entry || !entry.content) return null;
  const content = String(entry.content).trim();
  if (!content) return null;
  return {
    id: entry.id || createMemoryId(),
    content,
    kind: entry.kind || kind,
    createdAt: entry.createdAt || Date.now(),
    updatedAt: entry.updatedAt || entry.createdAt || Date.now(),
    score: Number(entry.score || 0),
    tags: Array.isArray(entry.tags) ? entry.tags.slice(0, 6) : [],
    source: entry.source || 'auto',
    emotion: entry.emotion || '',
    weight: Number(entry.weight || 0),
    accessCount: Number(entry.accessCount || 0),
    lastAccessedAt: Number(entry.lastAccessedAt || 0),
    embedding: Array.isArray(entry.embedding) ? entry.embedding : null,
  };
}

export function ensureMemoryBank(raw) {
  if (raw && typeof raw === 'object' && raw._normalized) return raw;
  const bank = raw && typeof raw === 'object' ? raw : {};
  const result = {
    version: 1,
    _normalized: true,
    pinned: Array.isArray(bank.pinned) ? bank.pinned.map(item => normalizeMemoryEntry(item, 'pinned')).filter(Boolean) : [],
    recent: Array.isArray(bank.recent) ? bank.recent.map(item => normalizeMemoryEntry(item, 'recent')).filter(Boolean) : [],
    archived: Array.isArray(bank.archived) ? bank.archived.map(item => normalizeMemoryEntry(item, 'archived')).filter(Boolean) : [],
    lastDigestAt: bank.lastDigestAt || 0,
    lastProcessedIndex: typeof bank.lastProcessedIndex === 'number' ? bank.lastProcessedIndex : -1,
    lastProcessedTime: typeof bank.lastProcessedTime === 'number' ? bank.lastProcessedTime : 0,
    lastAutoExtractAt: bank.lastAutoExtractAt || 0,
  };
  return result;
}

export function ensureMemoryState() {
  if (!settings.memoryBank || !settings.memoryBank._normalized) {
    settings.memoryBank = ensureMemoryBank(settings.memoryBank);
  }
  return settings.memoryBank;
}

export async function saveSettings() {
  ensureMemoryState();
  const { light, vectors } = _splitVectors(settings);
  await dbPut('settings', 'main', light);
  // 兜底：每 20 次保存强制写一遍，防止哪处改了 embedding 却忘了 markVectorsDirty
  if (vectors && (_vectorsDirty || ++_saveCount % 20 === 0)) {
    _vectorsDirty = false;
    await dbPut('settings', 'vectors', vectors);
  }
  _scheduleAutoSave();
}

// ── 记忆向量拆出去单独存 ─────────────────────────────────────────────────────
// settings 实测 28MB —— 946 条记忆各挂一个 1536 维向量，几乎全是它。每次
// saveSettings 都要把这个对象结构化克隆一遍再写 IDB（克隆是在主线程同步做的），
// 别的 dbGet 只能排在那个大队列后面：设置面板读头像因此实测等过 8430ms。
// 所以把向量拆出来单独存一个 key —— settings 本体变轻、每次照写；
// 向量只在真的变了时才写。⚠️ 读写两端必须配对：main.js 的 loadAll() 里合并回来。
const _VEC_LISTS = ['pinned', 'recent', 'archived'];
let _vectorsDirty = false;
let _saveCount = 0;

/** 任何地方改了 memoryBank 里的 embedding 之后都要调这个，否则新向量不会落盘 */
export function markVectorsDirty() { _vectorsDirty = true; }

function _splitVectors(src) {
  const mb = src.memoryBank;
  if (!mb) return { light: src, vectors: null };
  const hasVec = _VEC_LISTS.some(l => (mb[l] || []).some(m => m && m.embedding));
  if (!hasVec) return { light: src, vectors: null };
  const lightMb = { ...mb };
  const vectors = {};
  for (const list of _VEC_LISTS) {
    const arr = mb[list] || [];
    const vecs = {};
    lightMb[list] = arr.map(m => {
      if (!m || !m.embedding) return m;
      // 没有 id 的条目认不回来，就留在原地别动，宁可 settings 大一点也不能丢
      if (!m.id) return m;
      vecs[m.id] = m.embedding;
      const { embedding, ...rest } = m;
      return rest;
    });
    if (Object.keys(vecs).length) vectors[list] = vecs;
  }
  return { light: { ...src, memoryBank: lightMb }, vectors };
}

/** 启动读回时按 id 把向量贴回 memoryBank（条目本身已经带 embedding 的不动） */
export function mergeVectors(bank, vectors) {
  if (!bank || !vectors) return bank;
  for (const list of _VEC_LISTS) {
    const vecs = vectors[list];
    if (!vecs) continue;
    for (const m of bank[list] || []) {
      if (m && !m.embedding && m.id && vecs[m.id]) m.embedding = vecs[m.id];
    }
  }
  return bank;
}
