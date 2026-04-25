import { dbPut } from './db.js';

export const settings = {
  apiKey: '', baseUrl: 'https://api.openai.com', fallbackPresetNames: [], model: 'gpt-4o',
  subApiKey: '', subBaseUrl: '', subFallbackPresetNames: [], subModel: '',
  embeddingApiKey: '', embeddingBaseUrl: '', embeddingModel: '',
  visionApiKey: '', visionBaseUrl: '', visionModel: '',
  imageApiKey: '', imageBaseUrl: '', imageModel: 'gpt-image-1', imageSize: '1024x1024',
  contextCount: 20, systemPrompt: '', shortReply: false,
  aiName: '炘也', userName: '涂涂', togetherSince: '2026-02-13',
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
  moodState: null,
  memoryBank: null,
  bookmarks: [],
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
  const bank = raw && typeof raw === 'object' ? raw : {};
  return {
    version: 1,
    pinned: Array.isArray(bank.pinned) ? bank.pinned.map(item => normalizeMemoryEntry(item, 'pinned')).filter(Boolean) : [],
    recent: Array.isArray(bank.recent) ? bank.recent.map(item => normalizeMemoryEntry(item, 'recent')).filter(Boolean) : [],
    archived: Array.isArray(bank.archived) ? bank.archived.map(item => normalizeMemoryEntry(item, 'archived')).filter(Boolean) : [],
    lastDigestAt: bank.lastDigestAt || 0,
    lastProcessedIndex: typeof bank.lastProcessedIndex === 'number' ? bank.lastProcessedIndex : -1,
    lastAutoExtractAt: bank.lastAutoExtractAt || 0,
  };
}

export function ensureMemoryState() {
  settings.memoryBank = ensureMemoryBank(settings.memoryBank);
  return settings.memoryBank;
}

export async function saveSettings() {
  ensureMemoryState();
  await dbPut('settings', 'main', settings);
  _scheduleAutoSave();
}
