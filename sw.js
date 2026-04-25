const CACHE_NAME = 'xinye-20260426-0053';
const LOCAL_CFG  = 'xinye-local-cfg';
const STATIC_ASSETS = [
  '/', '/index.html', '/diary.html', '/reading.html', '/lib/jszip.min.js',
  '/src/main.js',
  '/src/modules/utils.js',
  '/src/modules/db.js',
  '/src/modules/state.js',
  '/src/modules/tts.js',
  '/src/modules/api.js',
  '/src/modules/memory.js',
  '/src/modules/friends.js',
  '/src/styles/variables.css', '/src/styles/layout.css', '/src/styles/stickers.css',
  '/src/styles/bubbles.css', '/src/styles/panels.css', '/src/styles/components.css',
  '/src/styles/themes.css', '/src/styles/markdown.css', '/src/styles/friends.css'
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
