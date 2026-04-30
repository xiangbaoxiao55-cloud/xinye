import { toast } from './utils.js';
import { db, dbPut, dbGet, dbGetAll, dbClear, dbDelete, lsBackup } from './db.js';
const _PFX = window.__APP_ID__ === 'choubao' ? 'choubao_' : '';
import { settings, messages, ensureMemoryBank } from './state.js';
import { getApiPresets, setApiPresets, getVisionPresets, setVisionPresets, getImagePresets, setImagePresets } from './api.js';
import { getDecoStickers, setDecoStickers, renderStickers, getChatStickers, saveChatStickers } from './stickers.js';
import { getFriendsBackupData } from './friends.js';
import { renderMessages } from './chat.js';

let _isLocalOnline = () => false;
let _closeSettings = () => {};

export function initBackupDeps({ isLocalOnline, closeSettings }) {
  _isLocalOnline = isLocalOnline;
  _closeSettings = closeSettings;
}

export async function downloadFile(content, filename, mime) {
  if (window.Capacitor?.Plugins?.Filesystem) {
    const { Filesystem } = window.Capacitor.Plugins;
    try {
      const base64 = btoa(unescape(encodeURIComponent(content)));
      try { await Filesystem.deleteFile({ path: 'Download/' + filename, directory: 'EXTERNAL_STORAGE' }); } catch(_) {}
      await Filesystem.writeFile({
        path: 'Download/' + filename,
        data: base64,
        directory: 'EXTERNAL_STORAGE',
        recursive: true,
      });
      toast('✅ 已保存到手机 Download 文件夹');
    } catch(e) { toast('保存失败：' + e.message); }
    return;
  }
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

// ======================== 自动存档 (localStorage) ========================

export async function saveToLocal() {
  try {
    const recentMsgs = messages.length > 2000 ? messages.slice(-2000) : messages;
    const settingsForLocal = JSON.parse(JSON.stringify(settings));
    const _bigFields = ['memoryArchive','memoryArchiveCore','memoryArchiveAlways','memoryArchiveExtended','memoryArchiveCoreMarkers','_digestRawOutput'];
    _bigFields.forEach(k => { delete settingsForLocal[k]; });
    if (settingsForLocal.memoryBank) {
      for (const list of ['pinned', 'recent', 'archived']) {
        (settingsForLocal.memoryBank[list] || []).forEach(m => { delete m.embedding; });
      }
    }
    const localData = {
      version: 3, type: 'auto-save', timestamp: Date.now(),
      settings: settingsForLocal,
      messages: recentMsgs.map(m => {
        const r = { role: m.role, content: m.content, time: m.time };
        if (m.image) r.image = m.image;
        return r;
      }),
    };
    localStorage.setItem(_PFX + 'fox_auto_save', JSON.stringify(localData));
  } catch (e) {
    if (e.name === 'QuotaExceededError') {
      try {
        const slim = {
          version: 3, type: 'auto-save', timestamp: Date.now(),
          settings,
          messages: [],
          images: {
            aiAvatar: await dbGet('images', 'aiAvatar') || null,
            userAvatar: await dbGet('images', 'userAvatar') || null,
          }
        };
        localStorage.setItem(_PFX + 'fox_auto_save', JSON.stringify(slim));
      } catch (_) { console.warn('[AutoSave] localStorage 写入彻底失败'); }
    } else {
      console.warn('[AutoSave] 写入失败', e);
    }
  }
}

export function loadFromLocal() {
  try {
    const raw = localStorage.getItem(_PFX + 'fox_auto_save');
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (e) {
    console.warn('[AutoLoad] localStorage 解析失败', e);
    return null;
  }
}

// ======================== 自动备份到本地服务器 ========================
let _lastAutoBackupTime = 0;

export async function autoBackupToServer() {
  const serverUrl = (settings.solitudeServerUrl || '').trim();
  if (!serverUrl || !_isLocalOnline()) return;
  if (Date.now() - _lastAutoBackupTime < 5 * 60 * 1000) return;
  _lastAutoBackupTime = Date.now();

  try {
    const allMsgs = await dbGetAll('messages');
    allMsgs.sort((a, b) => a.time - b.time);
    const allRpMsgs = await dbGetAll('rpMessages');
    allRpMsgs.sort((a, b) => a.time - b.time);

    const diaryData = {};
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && (k.startsWith('rbdiary_') || k.startsWith('xinye_diary_'))) {
        diaryData[k] = localStorage.getItem(k);
      }
    }

    let readingData = { books: [], chapters: [], annotations: [] };
    try {
      readingData = await new Promise((resolve) => {
        const req = indexedDB.open('ReadingDB', 2);
        req.onupgradeneeded = e => {
          const rdb = e.target.result;
          if (!rdb.objectStoreNames.contains('books'))       rdb.createObjectStore('books', { keyPath: 'id' });
          if (!rdb.objectStoreNames.contains('chapters'))    rdb.createObjectStore('chapters', { keyPath: 'bookId' });
          if (!rdb.objectStoreNames.contains('annotations')) rdb.createObjectStore('annotations', { keyPath: 'bookId' });
        };
        req.onerror = () => resolve({ books: [], chapters: [], annotations: [] });
        req.onsuccess = e => {
          const rdb = e.target.result;
          const result = { books: [], chapters: [], annotations: [] };
          const stores = ['books', 'chapters', 'annotations'];
          let done = 0;
          for (const store of stores) {
            try {
              const tx = rdb.transaction(store, 'readonly');
              const all = tx.objectStore(store).getAll();
              all.onsuccess = ev => { result[store] = ev.target.result || []; if (++done === stores.length) resolve(result); };
              all.onerror = () => { if (++done === stores.length) resolve(result); };
            } catch { if (++done === stores.length) resolve(result); }
          }
        };
      });
    } catch {}

    const payload = JSON.stringify({
      version: 3, type: 'auto',
      exportTime: new Date().toISOString(),
      settings,
      apiPresets: getApiPresets(),
      messages: allMsgs.map(m => { const r = { role: m.role, content: m.content, time: m.time }; if (m.image) r.image = m.image; if (m.images) r.images = m.images; return r; }),
      rpMessages: allRpMsgs.map(m => { const r = { role: m.role, content: m.content, time: m.time }; if (m.image) r.image = m.image; return r; }),
      rpData: { rp_prompt: localStorage.getItem(_PFX + 'rp_prompt') || '', rp_presets: localStorage.getItem(_PFX + 'rp_presets') || '[]', rp_char_name: localStorage.getItem(_PFX + 'rp_char_name') || '', rp_char_avatar: localStorage.getItem(_PFX + 'rp_char_avatar') || '', rp_active: localStorage.getItem(_PFX + 'rp_active') || '0' },
      stickers: getDecoStickers(), chatStickers: getChatStickers(),
      diary: diaryData,
      reading: readingData,
      friendsData: await getFriendsBackupData(),
    });

    await fetch(`${serverUrl}/api/backup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload });
    const backupTime = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
    console.log('[自动备份] 完成');
    localStorage.setItem(_PFX + 'lastAutoBackupTime', backupTime);
    toast('💾 已自动备份到电脑');
  } catch (e) {
    console.warn('[自动备份] 失败:', e.message);
  }
}

export async function backupToPhone() {
  const btn = document.querySelector('#btnBackupToPhone');
  if (btn) { btn.disabled = true; btn.textContent = '备份中…'; }
  try {
    const allMsgs = await dbGetAll('messages');
    allMsgs.sort((a, b) => a.time - b.time);
    const allRpMsgs = await dbGetAll('rpMessages');
    allRpMsgs.sort((a, b) => a.time - b.time);
    const diaryData = {};
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && (k.startsWith('rbdiary_') || k.startsWith('xinye_diary_'))) diaryData[k] = localStorage.getItem(k);
    }
    let readingData = { books: [], chapters: [], annotations: [] };
    try {
      readingData = await new Promise((resolve) => {
        const req = indexedDB.open('ReadingDB', 2);
        req.onerror = () => resolve({ books: [], chapters: [], annotations: [] });
        req.onsuccess = e => {
          const rdb = e.target.result;
          const result = { books: [], chapters: [], annotations: [] };
          const stores = ['books', 'chapters', 'annotations'];
          let done = 0;
          for (const store of stores) {
            try {
              const tx = rdb.transaction(store, 'readonly');
              const all = tx.objectStore(store).getAll();
              all.onsuccess = ev => { result[store] = ev.target.result || []; if (++done === stores.length) resolve(result); };
              all.onerror = () => { if (++done === stores.length) resolve(result); };
            } catch { if (++done === stores.length) resolve(result); }
          }
        };
      });
    } catch {}
    const payload = JSON.stringify({
      version: 3, type: 'auto',
      exportTime: new Date().toISOString(),
      settings, apiPresets: getApiPresets(), visionPresets: getVisionPresets(), imagePresets: getImagePresets(),
      messages: allMsgs.map(m => { const r = { role: m.role, content: m.content, time: m.time }; if (m.image) r.image = m.image; if (m.images) r.images = m.images; return r; }),
      rpMessages: allRpMsgs.map(m => { const r = { role: m.role, content: m.content, time: m.time }; if (m.image) r.image = m.image; return r; }),
      rpData: { rp_prompt: localStorage.getItem(_PFX + 'rp_prompt') || '', rp_presets: localStorage.getItem(_PFX + 'rp_presets') || '[]', rp_char_name: localStorage.getItem(_PFX + 'rp_char_name') || '', rp_char_avatar: localStorage.getItem(_PFX + 'rp_char_avatar') || '', rp_active: localStorage.getItem(_PFX + 'rp_active') || '0' },
      stickers: getDecoStickers(), chatStickers: getChatStickers(),
      diary: diaryData, reading: readingData,
      friendsData: await getFriendsBackupData(),
    });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16);
    const filename = `xinye_backup_${stamp}.json`;
    if (window.AndroidDownload) {
      const ok = window.AndroidDownload.saveToDownloads(filename, payload);
      if (ok) { toast('✅ 已备份到 Download/' + filename); _closeSettings(); return; }
    }
    const blob = new Blob([payload], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    document.body.removeChild(a); URL.revokeObjectURL(url);
    toast('✅ 备份已导出');
    _closeSettings();
  } catch(e) {
    toast('❌ 备份失败：' + e.message);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '💾 一键备份到手机'; }
  }
}

// ======================== 导出 ========================

export async function exportData(mode) {
  const isLite = mode === 'lite';
  const bgType = await dbGet('images', 'bgType');

  const allMsgs = await dbGetAll('messages');
  allMsgs.sort((a, b) => a.time - b.time);

  const allRpMsgs = await dbGetAll('rpMessages');
  allRpMsgs.sort((a, b) => a.time - b.time);

  const backup = {
    version: 3,
    type: isLite ? 'lite' : 'full',
    exportTime: new Date().toISOString(),
    settings,
    apiPresets: getApiPresets(),
    visionPresets: getVisionPresets(),
    imagePresets: getImagePresets(),
    messages: allMsgs.map(m => {
      const r = { role: m.role, content: m.content, time: m.time };
      if (m.image) r.image = m.image;
      if (m.images) r.images = m.images;
      return r;
    }),
    rpMessages: allRpMsgs.map(m => {
      const r = { role: m.role, content: m.content, time: m.time };
      if (m.image) r.image = m.image;
      if (m.images) r.images = m.images;
      return r;
    }),
    rpData: {
      rp_prompt:      localStorage.getItem('rp_prompt') || '',
      rp_presets:     localStorage.getItem('rp_presets') || '[]',
      rp_char_name:   localStorage.getItem('rp_char_name') || '',
      rp_char_avatar: localStorage.getItem(_PFX + 'rp_char_avatar') || '',
      rp_active:      localStorage.getItem('rp_active') || '0',
    },
    images: {
      aiAvatar:   await dbGet('images', 'aiAvatar')   || null,
      userAvatar: await dbGet('images', 'userAvatar') || null,
      bgImage:    isLite ? null : (bgType === 'image' ? (await dbGet('images', 'bgImage') || null) : null),
      bgType:     isLite ? null : (bgType || null),
    },
    stickers: isLite ? [] : getDecoStickers(),
    chatStickers: getChatStickers(),
    friendsData: await getFriendsBackupData(),
  };

  const label = isLite ? '轻量' : '完整';
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);
  const timeStr = now.toTimeString().slice(0, 8).replace(/:/g, '-');
  downloadFile(JSON.stringify(backup, null, 2), `炘也小窝${label}备份_${dateStr}_${timeStr}.json`, 'application/json;charset=utf-8');

  const aiN = settings.aiName || '奶牛猫';
  const usN = settings.userName || '小浣熊';
  const lines = [
    `═══ ${usN} 与 ${aiN} 的聊天记录 ═══`,
    `导出时间：${new Date().toLocaleString('zh-CN')}`,
    `备份类型：${label}`,
    `共 ${allMsgs.length} 条消息`,
    '═'.repeat(40), ''
  ];
  allMsgs.forEach(m => {
    lines.push(`[${new Date(m.time).toLocaleString('zh-CN')}] ${m.role === 'user' ? usN : aiN}：`);
    lines.push(m.content);
    lines.push('');
  });
  downloadFile(lines.join('\n'), `聊天记录_${dateStr}_${timeStr}.txt`, 'text/plain;charset=utf-8');

  if (isLite) toast('轻量备份已导出（不含背景/贴纸）');
  else if (bgType === 'video') toast('完整备份已导出（视频背景需重新上传）');
  else toast('完整备份已导出（JSON + TXT）');
}

// ======================== 导入 ========================

export async function doImportPresetsOnly(jsonText) {
  const data = JSON.parse(jsonText);
  if (data.apiPresets && Array.isArray(data.apiPresets))     setApiPresets(data.apiPresets);
  if (data.visionPresets && Array.isArray(data.visionPresets)) setVisionPresets(data.visionPresets);
  if (data.imagePresets && Array.isArray(data.imagePresets))  setImagePresets(data.imagePresets);
  if (data.chatStickers && Array.isArray(data.chatStickers)) {
    saveChatStickers(data.chatStickers);
  }
  if (data.stickers && Array.isArray(data.stickers)) {
    await dbClear('stickers');
    for (const s of data.stickers) await dbPut('stickers', null, s);
    setDecoStickers(await dbGetAll('stickers'));
    renderStickers();
  }
  if (data.rpData) {
    const rp = data.rpData;
    if (rp.rp_prompt)     { localStorage.setItem('rp_prompt', rp.rp_prompt); lsBackup('rp_prompt', rp.rp_prompt); }
    if (rp.rp_presets)    { localStorage.setItem('rp_presets', rp.rp_presets); lsBackup('rp_presets', rp.rp_presets); }
    if (rp.rp_char_name)  { localStorage.setItem('rp_char_name', rp.rp_char_name); lsBackup('rp_char_name', rp.rp_char_name); }
    if (rp.rp_char_avatar){ localStorage.setItem('rp_char_avatar', rp.rp_char_avatar); lsBackup('rp_char_avatar', rp.rp_char_avatar); }
  }
}

export async function doImport(jsonText) {
  const data = JSON.parse(jsonText);
  const isLite = data.type === 'lite' || data.type === 'auto-save';

  if (Array.isArray(data)) {
    await dbClear('messages');
    for (const m of data) {
      const rec = { role: m.role, content: m.content, time: m.time };
      if (m.image) rec.image = m.image;
      await dbPut('messages', null, rec);
    }
    { const _m = await dbGetAll('messages'); _m.sort((a,b) => a.time - b.time); messages.length = 0; messages.push(..._m); }
    await saveToLocal();
    return;
  }

  if (data.settings) {
    await dbPut('settings', 'main', { ...data.settings, memoryBank: ensureMemoryBank(data.settings.memoryBank) });
  } else if (data.cfg) {
    const c = data.cfg;
    const patch = {
      apiKey: c.apiKey, baseUrl: c.baseUrl, model: c.model,
      contextCount: c.ctx, shortReply: c.shortReply,
      systemPrompt: c.sysPrompt, memoryArchive: c.memory,
      ttsType: c.ttsType, ttsAutoPlay: c.ttsAutoPlay,
      ttsUrl: c.ttsUrl, ttsRefPath: c.ttsRef, ttsRefText: c.ttsText,
      ttsGptWeights: c.gptWeights, ttsSovitsWeights: c.sovitsWeights,
      doubaoAppId: c.doubaoAppId, doubaoToken: c.doubaoToken,
      doubaoVoice: c.doubaoVoice, doubaoCluster: c.doubaoCluster,
      idleRemind: c.idleRemind, waterRemind: c.waterRemind, standRemind: c.standRemind,
    };
    const merged = { ...settings };
    Object.keys(patch).forEach(k => { if (patch[k] !== undefined) merged[k] = patch[k]; });
    merged.memoryBank = ensureMemoryBank(merged.memoryBank);
    await dbPut('settings', 'main', merged);
  }

  if (data.apiPresets && Array.isArray(data.apiPresets)) {
    setApiPresets(data.apiPresets);
  }
  if (data.visionPresets && Array.isArray(data.visionPresets)) {
    setVisionPresets(data.visionPresets);
  }
  if (data.imagePresets && Array.isArray(data.imagePresets)) {
    setImagePresets(data.imagePresets);
  }

  const msgList = data.messages || data.history;
  if (msgList) {
    await dbClear('messages');
    for (const m of msgList) {
      const rec = { role: m.role, content: m.content, time: m.time || Date.now() };
      if (m.image) rec.image = m.image;
      if (m.images) rec.images = m.images;
      await dbPut('messages', null, rec);
    }
    const importedSettings = await dbGet('settings', 'main');
    if (importedSettings?.memoryBank) {
      importedSettings.memoryBank.lastProcessedIndex = msgList.length - 1;
      await dbPut('settings', 'main', importedSettings);
    }
  }

  if (data.images) {
    if (data.images.aiAvatar)   await dbPut('images', 'aiAvatar', data.images.aiAvatar);
    if (data.images.userAvatar) await dbPut('images', 'userAvatar', data.images.userAvatar);
    if (!isLite) {
      if (data.images.bgImage) {
        await dbPut('images', 'bgImage', data.images.bgImage);
        await dbPut('images', 'bgType', data.images.bgType || 'image');
      } else {
        await dbDelete('images', 'bgImage');
        await dbDelete('images', 'bgVideo');
        await dbDelete('images', 'bgType');
      }
    }
  }

  if (!isLite) {
    await dbClear('stickers');
    if (data.stickers) {
      for (const s of data.stickers) await dbPut('stickers', null, s);
    }
  }

  if (data.chatStickers && Array.isArray(data.chatStickers) && data.chatStickers.length > 0) {
    try { saveChatStickers(data.chatStickers); }
    catch(e) { toast('⚠️ 聊天贴纸图片过大，已跳过（其他数据正常恢复）'); console.warn('[import] chatStickers超出localStorage配额:', e); }
  }

  if (data.rpMessages && Array.isArray(data.rpMessages) && data.rpMessages.length > 0) {
    await dbClear('rpMessages');
    for (const m of data.rpMessages) {
      const rec = { role: m.role, content: m.content, time: m.time || Date.now() };
      if (m.image) rec.image = m.image;
      if (m.images) rec.images = m.images;
      await dbPut('rpMessages', null, rec);
    }
  }

  if (data.rpData) {
    const d = data.rpData;
    if (d.rp_prompt)      { localStorage.setItem('rp_prompt', d.rp_prompt); lsBackup('rp_prompt', d.rp_prompt); }
    if (d.rp_presets)     { localStorage.setItem('rp_presets', d.rp_presets); lsBackup('rp_presets', d.rp_presets); }
    if (d.rp_char_name)   { localStorage.setItem('rp_char_name', d.rp_char_name); lsBackup('rp_char_name', d.rp_char_name); }
    if (d.rp_char_avatar) { localStorage.setItem('rp_char_avatar', d.rp_char_avatar); lsBackup('rp_char_avatar', d.rp_char_avatar); }
  }

  if (data.diary && typeof data.diary === 'object') {
    for (const [k, v] of Object.entries(data.diary)) {
      if (k.startsWith('rbdiary_') || k.startsWith('xinye_diary_')) localStorage.setItem(k, v);
    }
  }

  if (data.reading && (data.reading.books?.length || data.reading.chapters?.length || data.reading.annotations?.length)) {
    try {
      await new Promise((resolve, reject) => {
        const req = indexedDB.open('ReadingDB', 2);
        req.onerror = reject;
        req.onupgradeneeded = e => {
          const rdb = e.target.result;
          if (!rdb.objectStoreNames.contains('books'))       rdb.createObjectStore('books', { keyPath: 'id' });
          if (!rdb.objectStoreNames.contains('chapters'))    rdb.createObjectStore('chapters', { keyPath: 'bookId' });
          if (!rdb.objectStoreNames.contains('annotations')) rdb.createObjectStore('annotations', { keyPath: 'bookId' });
        };
        req.onsuccess = e => {
          const rdb = e.target.result;
          const stores = ['books', 'chapters', 'annotations'];
          let done = 0;
          for (const store of stores) {
            const tx = rdb.transaction(store, 'readwrite');
            const os = tx.objectStore(store);
            os.clear();
            const items = data.reading[store] || [];
            for (const item of items) os.put(item);
            tx.oncomplete = () => { if (++done === stores.length) resolve(); };
            tx.onerror = reject;
          }
        };
      });
    } catch(e) { console.warn('[导入] 共读数据恢复失败：', e.message); }
  }

  if (data.friendsData?.friends && Array.isArray(data.friendsData.friends)) {
    await dbClear('friends');
    await dbClear('friendMessages');
    for (const f of data.friendsData.friends) await dbPut('friends', null, f);
    if (data.friendsData.chats && typeof data.friendsData.chats === 'object') {
      for (const msgs of Object.values(data.friendsData.chats)) {
        if (Array.isArray(msgs)) {
          for (const m of msgs) {
            const rec = { role: m.role, content: m.content, friendId: m.friendId, ts: m.ts || m.id || Date.now() };
            await dbPut('friendMessages', null, rec);
          }
        }
      }
    }
  }

  const s = await dbGet('settings', 'main');
  if (s) Object.assign(settings, s);
  { const _m = await dbGetAll('messages'); _m.sort((a,b) => a.time - b.time); messages.length = 0; messages.push(..._m); }
  setDecoStickers(await dbGetAll('stickers'));
  await saveToLocal();
}

// ======================== 合并导入 ========================

export async function doMergeImport(jsonText) {
  const data = JSON.parse(jsonText);
  const msgList = data.messages || data.history;
  if (!msgList || msgList.length === 0) { toast('备份中没有消息记录'); return; }

  const existing = await dbGetAll('messages');
  const existingTimes = new Set(existing.map(m => m.time));

  let added = 0;
  for (const m of msgList) {
    if (!existingTimes.has(m.time)) {
      const rec = { role: m.role, content: m.content, time: m.time };
      if (m.image) rec.image = m.image;
      await dbPut('messages', null, rec);
      added++;
    }
  }

  { const _m = await dbGetAll('messages'); _m.sort((a,b) => a.time - b.time); messages.length = 0; messages.push(..._m); }
  await saveToLocal();
  await renderMessages();
  toast(`合并完成，新增 ${added} 条，共 ${messages.length} 条`);
}
