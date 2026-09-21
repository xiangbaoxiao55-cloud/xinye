const CACHE_NAME = 'xinye-20260921-1345';
const LOCAL_CFG  = 'xinye-local-cfg';
// ⚠️ 加了新模块 / 新页面，**记得同步这里**。
//    漏了不会立刻坏 —— handleFetch 兜底是 stale-while-revalidate，在线首次访问照样加载、加载完就进缓存；
//    真正坏的是「冷启动 + 没网」那一下（比如她在电梯里打开 APP）。
//    2026-09-17 补齐过一次：inbox.js、posts.js、storyboard 三件套、gallery.html 全漏了。
const STATIC_ASSETS = [
  '/', '/index.html', '/choubao.html', '/choubao.webmanifest', '/diary.html', '/src/diary-today.js', '/reading.html', '/gallery.html', '/lib/jszip.min.js',
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
  '/src/modules/chatsearch.js',
  '/src/modules/draft.js',
  '/src/modules/readlink.js',
  '/src/modules/ui.js',
  '/src/modules/notifications.js',
  '/src/modules/stickers.js',
  '/src/modules/diary.js',
  '/src/modules/backup.js',
  '/src/modules/settings.js',
  '/src/modules/image.js',
  '/src/modules/walk.js',
  '/src/modules/gift.js',
  '/src/modules/rp.js',
  '/src/modules/phonedb.js',
  '/src/modules/monitor.js',
  '/src/modules/inbox.js',
  '/src/modules/posts.js',
  '/src/modules/pendingdraw.js',
  '/overlay.html', '/src/overlay.js',
  '/phone.html',
  '/src/styles/variables.css', '/src/styles/layout.css', '/src/styles/stickers.css',
  '/src/styles/bubbles.css', '/src/styles/panels.css', '/src/styles/components.css',
  '/src/styles/gift.css',
  '/src/styles/themes.css', '/src/styles/markdown.css', '/src/styles/friends.css',
  '/src/styles/monitor.css', '/src/styles/icons.css',
  '/draw.html', '/src/draw.js', '/src/styles/draw.css',
  '/flipbook.html', '/src/flipbook.js', '/src/styles/flipbook.css',
  '/storyboard.html', '/src/storyboard.js', '/src/styles/storyboard.css',
  '/migrate.html',
  '/assets/style_library.json'
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
  // 逐个 add 而不是 addAll：addAll 是全有或全无，手机网络抖一下（36个请求里有一个超时）
  // 就会让整个新SW安装失败、浏览器继续用旧的，表现为"要刷新好几次版本才更新过来"
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache =>
      Promise.allSettled(STATIC_ASSETS.map(p => cache.add(p)))
    )
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

/**
 * 覆盖层那两个文件走**网络优先**（2026-09-15），搬家的页面也是（2026-09-18）。
 *
 * 它是改得最勤的一块 —— 她那边「明明推了新版，手机上还是老样子」就是这么来的：
 * 走缓存优先的话，返回的是上一版，兜底脚本还是老的（会抢在真话前面冒出来）。
 * 网络 2.5 秒不回来就退回缓存，别让覆盖层弹出来的时候干等。
 *
 * migrate.html 加进来的理由一样，而且更要命：它是**一次性**的，
 * 走缓存优先的话她导进去的是上一版逻辑 —— 2026-09-18 那天就是这么差点
 * 让她用没修好的版本重导一遍 418MB。这类"必须是最新"的页面都往这儿放。
 *
 * 🔴 **phone.html（2026-09-19 晚加）**：这一页在 iframe 里，而 `diary.js` 的
 *    `_phoneLoaded` 让它**一个会话只加载一次**；底下那条路又是 stale-while-revalidate
 *    （先返回缓存、后台再更新）。两件事一叠加就是：「她刷新了、主页面版本号也变了，
 *    可碎碎念那页还是老样子」—— 我连推三版她都没看到，全是这个原因。
 *    ⚠️ 以后再改 phone.html，记得它走的就是 NET_FIRST 这条路（网络 2.5s → 退回缓存）。
 */
const NET_FIRST = ['/overlay.html', '/src/overlay.js', '/migrate.html', '/phone.html'];

async function handleFetch(request, pathname) {
  if (NET_FIRST.indexOf(pathname) >= 0) {
    const nfCache = await caches.open(CACHE_NAME);
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 2500);
      const r = await fetch(request, { signal: ctrl.signal });
      clearTimeout(timer);
      if (r.ok) { nfCache.put(request, r.clone()); return r; }
    } catch {}
    // ⚠️ 先按原样找（比如 phone.html?v=xxx 那份），找不到再退回**不带参数的预缓存副本** ——
    //    phone.html 现在带着版本尾巴请求（见 diary.js），而离线时能救命的正是 STATIC_ASSETS
    //    里那份 `/phone.html`。少了这一步，她在电梯里打开 APP 会看到这一页白屏。
    const hit = (await nfCache.match(request)) || (await nfCache.match(pathname));
    if (hit) return hit;
    return fetch(request);
  }

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
        // 必须带上 proactiveId：前端靠它和云端拉取的同一消息去重，缺了就重复上屏
        // appId：收件箱是炘也/臭宝共用的全局DB，不带这个前端没法分辨该谁上屏
        tx.objectStore('inbox').add({ role: 'assistant', content: data.content, time: data.time || Date.now(), proactiveId: data.proactiveId, appId: data.appId || 'xinye' });
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
    const cloudUrl = 'https://xinyetb.cn';
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
            tx.objectStore('inbox').add({ role: 'assistant', content: m.content, time: m.time, id: m.id, appId: 'xinye' });
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
