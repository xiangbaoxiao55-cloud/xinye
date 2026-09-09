const CACHE_NAME = 'xinye-20260909-2312';
const LOCAL_CFG  = 'xinye-local-cfg';
const STATIC_ASSETS = [
  '/', '/index.html', '/choubao.html', '/choubao.webmanifest', '/diary.html', '/reading.html', '/lib/jszip.min.js',
  '/xinye-icon.png', '/choubao-icon.png',
  '/src/main.js',
  '/src/modules/utils.js',
  '/src/modules/db.js',
  '/src/modules/state.js',
  '/src/modules/tts.js',
  '/src/modules/api.js',
  '/src/modules/anthropic.js',
  '/src/modules/memory.js',
  '/src/modules/friends.js',
  '/src/modules/chat.js',
  '/src/modules/ui.js',
  '/src/modules/notifications.js',
  '/src/modules/stickers.js',
  '/src/modules/diary.js',
  '/src/modules/backup.js',
  '/src/modules/settings.js',
  '/src/modules/image.js',
  '/src/modules/walk.js',
  '/src/modules/gift.js',
  '/src/modules/fortune.js',
  '/src/modules/rp.js',
  '/src/modules/phonedb.js',
  '/phone.html', '/phone.webmanifest', '/phone-icon.svg',
  '/src/styles/variables.css', '/src/styles/layout.css', '/src/styles/stickers.css',
  '/src/styles/bubbles.css', '/src/styles/panels.css', '/src/styles/components.css',
  '/src/styles/gift.css', '/src/styles/fortune.css',
  '/src/styles/themes.css', '/src/styles/markdown.css', '/src/styles/friends.css',
  '/draw.html', '/src/draw.js', '/src/styles/draw.css',
  '/flipbook.html', '/src/flipbook.js', '/src/styles/flipbook.css',
  '/data/style_library.json'
];

// ── 接收 app 传来的本地服务器 URL，持久存进 Cache ────────────────────────
self.addEventListener('message', async e => {
  if (!e.data || e.data.type !== 'SET_LOCAL_SERVER') return;
  const cache = await caches.open(LOCAL_CFG);
  if (e.data.url) {
    await cache.put('url', new Response(e.data.url));
  } else {
    await cache.delete('url');
  }
});

async function getLocalUrl() {
  try {
    const r = await (await caches.open(LOCAL_CFG)).match('url');
    return r ? await r.text() : null;
  } catch { return null; }
}

// ── 安装：预缓存静态资源 ─────────────────────────────────────────────────
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

// ── 激活：清理旧缓存（保留 LOCAL_CFG），通知页面刷新 ─────────────────────
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME && k !== LOCAL_CFG).map(k => caches.delete(k)))
    ).then(() =>
      self.clients.matchAll({ type: 'window' }).then(clients =>
        clients.forEach(c => c.postMessage({ type: 'SW_UPDATED' }))
      )
    )
  );
  self.clients.claim();
});

// ── fetch：本地优先，2s 内无响应就 fallback Vercel 缓存 ──────────────────
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.hostname !== self.location.hostname) return;
  e.respondWith(handleFetch(e.request, url.pathname));
});

async function handleFetch(request, pathname) {
  const localUrl = await getLocalUrl();

  if (localUrl) {
    try {
      const path = pathname === '/' ? '/index.html' : pathname;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 2000);
      const r = await fetch(localUrl + path, { signal: ctrl.signal });
      clearTimeout(timer);
      if (r.ok) return r;
    } catch {}
    // 本地服务器无响应 → 清掉 URL，让 app 重新探测后再设
    (async () => { try { await (await caches.open(LOCAL_CFG)).delete('url'); } catch {} })();
  }

  // Vercel stale-while-revalidate
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  const fresh = fetch(request).then(r => { if (r.ok) cache.put(request, r.clone()); return r; }).catch(() => null);
  return cached || fresh;
}

// ── Web Push：收到服务器主动消息 ─────────────────────────────────────────
self.addEventListener('push', e => {
  if (!e.data) return;
  e.waitUntil(_handlePush(e.data.json()));
});

async function _handlePush(data) {
  // 存入独立的 PushInbox IDB，前端打开时消费（不直接写主IDB，避免版本耦合）
  try {
    await new Promise((resolve, reject) => {
      const req = indexedDB.open('XinyePushInbox', 1);
      req.onupgradeneeded = e => e.target.result.createObjectStore('inbox', { autoIncrement: true });
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction('inbox', 'readwrite');
        tx.objectStore('inbox').add({ role: 'assistant', content: data.content, time: data.time || Date.now() });
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = reject;
      };
      req.onerror = reject;
    });
  } catch(e) { console.error('[SW Push] inbox写入失败', e); }

  // 如果页面已打开，通知它立刻刷新
  const clients = await self.clients.matchAll({ type: 'window' });
  clients.forEach(c => c.postMessage({ type: 'PUSH_MESSAGE', content: data.content, appId: data.appId || 'xinye' }));

  return self.registration.showNotification('炘也', {
    body: data.content,
    icon: '/xinye-icon.png',
    badge: '/xinye-icon.png',
    tag: 'xinye-push',
    data: { url: '/' }
  });
}

// ── Periodic Background Sync：后台定期拉心跳消息（替代FCM）────────────────
self.addEventListener('periodicsync', e => {
  if (e.tag !== 'pull-heartbeat') return;
  e.waitUntil(_pullAndNotify());
});

async function _pullAndNotify() {
  try {
    // 读取云服务器URL（前端通过SET_LOCAL_SERVER设置的，或直接用云服务器）
    let srv = null;
    try {
      const r = await (await caches.open('xinye-local-cfg')).match('url');
      if (r) srv = await r.text();
    } catch {}
    // 优先云服务器
    const cloudUrl = 'http://43.155.214.85:3000';
    const lastSync = parseInt(await _swKV('get', 'hb_lastSync') || '0');
    const r = await fetch(`${cloudUrl}/api/proactive-messages?since=${lastSync}`, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return;
    const d = await r.json();
    if (!d.ok || !Array.isArray(d.messages) || !d.messages.length) return;
    // 记录最新时间
    const maxTime = Math.max(...d.messages.map(m => m.time || 0));
    if (maxTime > 0) await _swKV('set', 'hb_lastSync', String(maxTime));
    // 写入PushInbox让前端消费
    for (const m of d.messages) {
      try {
        await new Promise((resolve, reject) => {
          const req = indexedDB.open('XinyePushInbox', 1);
          req.onupgradeneeded = ev => ev.target.result.createObjectStore('inbox', { autoIncrement: true });
          req.onsuccess = () => {
            const db = req.result;
            const tx = db.transaction('inbox', 'readwrite');
            tx.objectStore('inbox').add({ role: 'assistant', content: m.content, time: m.time, id: m.id });
            tx.oncomplete = () => { db.close(); resolve(); };
            tx.onerror = reject;
          };
          req.onerror = reject;
        });
      } catch {}
    }
    // 弹通知
    const body = d.messages.length === 1 ? d.messages[0].content : `${d.messages.length}条新消息`;
    await self.registration.showNotification('炘也', {
      body: (body || '').slice(0, 120),
      icon: '/xinye-icon.png',
      badge: '/xinye-icon.png',
      tag: 'xinye-heartbeat',
      data: { url: '/' }
    });
    // 通知已打开的页面
    const clients = await self.clients.matchAll({ type: 'window' });
    clients.forEach(c => c.postMessage({ type: 'PUSH_MESSAGE', content: '有新的心跳消息', appId: 'xinye' }));
  } catch(e) { console.error('[SW Sync] 拉取失败', e); }
}

// SW内简易KV（用Cache API存取小值）
async function _swKV(op, key, val) {
  const cache = await caches.open('xinye-sw-kv');
  if (op === 'get') { const r = await cache.match(key); return r ? await r.text() : null; }
  if (op === 'set') await cache.put(key, new Response(val));
}

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
      const c = clients.find(cl => new URL(cl.url).origin === self.registration.scope.replace(/\/$/, ''));
      if (c) return c.focus();
      return self.clients.openWindow('/');
    })
  );
});
