// 收件箱 / Web Push / 主动消息拉取 / 碎碎念拉取 —— 2026-09-16 从 main.js 搬出来的
//
// 为什么单独一个文件：main.js 那九百行的启动流程里，光这一组网络件就占了三百多行，
// 每次往启动路径上加东西（比如碎碎念）都得先把它整个读一遍才敢动手 —— 那就是"债"的体感。
// 搬出来之后：main.js 只管「什么时候调」，这里只管「怎么取、怎么落」。
//
// 对外只有这几个口子：
//   _startEarlyInboxFetch()   启动早期发起的那一次拉取（跟本地数据加载并行，别让首屏干等网络）
//   _consumePushInbox()       消费（启动 / 切回前台 / 30 秒轮询 / SW 消息，四个触发源，自带防重入）
//   _consumeOverlayReply()    覆盖层里她回的那句话
//   _pullPosts()              碎碎念（他自己写的那些，见 posts.js）
//   _registerPush() / _registerPeriodicSync() / _reportOverlayErr()
//
// ⚠️ window._consumePushInbox / window._consumeOverlayReply 是在**这个文件**里挂上去的
//    （main.js 里 SW 的 message 监听要用它们），别再在 main.js 里挂一遍。

import { settings, messages } from './state.js';
import { getCloudOrLocalUrl, buildServerFetchUrl, buildServerHeaders } from './settings.js';
import { pullPosts, hasUnreadPosts, markPostsSeen } from './posts.js';
import { switchTab } from './diary.js';

// ======================== 碎碎念（他自己写的动态，2026-09-16） ========================
// 拉的是云端新开的 /api/posts。**不弹通知、不进聊天** —— 只落在碎碎念那一页。
// ⚠️ 只有炘也拉：臭宝没有「碎碎念」这个 Tab（她 9/16 定的），拉回来也没地方放。
function _updatePhoneDot() {
  const btn = document.getElementById('tab-phone');
  if (!btn) return;                       // 臭宝那边没这个 Tab
  let dot = btn.querySelector('.tab-dot');
  if (!hasUnreadPosts()) { if (dot) dot.remove(); return; }
  if (!dot) { dot = document.createElement('span'); dot.className = 'tab-dot'; btn.appendChild(dot); }
}

async function _pullPosts() {
  if ((window.__APP_ID__ || 'xinye') !== 'xinye') return;
  let n = 0;
  try { n = await pullPosts(); } catch (e) { console.log('[碎碎念] 拉取异常:', e.message); }
  // 她正开着碎碎念这一页 → 直接让它重画，不用等她切走再切回来
  const onPhoneTab = document.getElementById('tab-phone')?.classList.contains('active');
  if (n && onPhoneTab) {
    try { document.getElementById('phoneFrame')?.contentWindow?.__fcReload?.(); } catch (e) {}
    markPostsSeen();
  }
  _updatePhoneDot();
}

// 碎碎念那页每次露面时（含切标签）会调它 —— 走 diary.js 的 window.__fcOnShow
window.__fcPostsSeen = () => { markPostsSeen(); _updatePhoneDot(); };

// 「回他一句」：从碎碎念那页跳回聊天，并给**下一条**消息带上"你在回他哪一条"。
// ⚠️ 不把引文塞进输入框 —— 那样她还得手动删。走 localStorage 传一句上下文，
//    chat.js 在发送时注入成一条 system（跟「翻手机感知」同一个套路），用完即删。
window.__fcReplyToPost = (text) => {
  try { localStorage.setItem('xinye_reply_to_post', String(text || '').slice(0, 200)); } catch (e) {}
  switchTab('chat');
  const ui = document.getElementById('userInput');
  if (ui) setTimeout(() => ui.focus(), 150);
};
// ── Periodic Background Sync（后台定期拉消息，替代FCM）──────────────────────
async function _registerPeriodicSync() {
  try {
    const reg = await navigator.serviceWorker.ready;
    if (!('periodicSync' in reg)) { console.log('[Sync] 浏览器不支持 periodicSync'); return; }
    const status = await navigator.permissions.query({ name: 'periodic-background-sync' });
    if (status.state !== 'granted') { console.log('[Sync] periodicSync 权限未授予:', status.state); return; }
    await reg.periodicSync.register('pull-heartbeat', { minInterval: 15 * 60 * 1000 });
    console.log('[Sync] periodicSync 注册成功（15分钟）');
  } catch(e) { console.log('[Sync] periodicSync 注册失败:', e.message); }
}

// ── Web Push 注册 ─────────────────────────────────────────────────────────
function _urlB64ToU8(b64) {
  const pad = '='.repeat((4 - b64.length % 4) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}

async function _registerPush() {
  if (!('PushManager' in window)) { console.log('[Push] 浏览器不支持 PushManager'); return; }
  if (!('serviceWorker' in navigator)) { console.log('[Push] 浏览器不支持 ServiceWorker'); return; }
  const srv = getCloudOrLocalUrl();
  if (!srv) { console.log('[Push] 无可用服务器，跳过注册'); return; }
  try {
    const res = await fetch(buildServerFetchUrl(srv, '/api/push-vapid-public-key'), { headers: buildServerHeaders(srv), signal: AbortSignal.timeout(4000) });
    if (!res.ok) { console.log('[Push] VAPID key 获取失败:', res.status); return; }
    const { publicKey } = await res.json();
    if (!publicKey) { console.log('[Push] VAPID key 为空'); return; }
    const perm = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
    if (perm !== 'granted') { console.log('[Push] 通知权限未授予:', perm); return; }
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    console.log(`[Push] 当前订阅: ${sub ? '有' : '无'}`);
    if (!sub) {
      // FCM连接不稳定，重试最多4次（间隔3s/6s/12s/20s）
      const delays = [0, 3000, 6000, 12000, 20000];
      for (let i = 0; i < delays.length; i++) {
        if (i > 0) { console.log(`[Push] 第${i}次重试，等待${delays[i]/1000}秒...`); await new Promise(r => setTimeout(r, delays[i])); }
        try {
          sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: _urlB64ToU8(publicKey) });
          console.log(`[Push] 新建订阅成功${i > 0 ? '（第'+i+'次重试）' : ''}`);
          break;
        } catch(e2) {
          console.log(`[Push] 订阅尝试${i+1}失败: ${e2.message}`);
          if (i === delays.length - 1) {
            console.error('[Push] 全部重试失败，等下次启动再试');
            // 失败了也启动后台重试（每60秒试一次，成功就停）
            _retrySubscribeInBackground(reg, publicKey, srv);
            return;
          }
        }
      }
    }
    if (!sub) return;
    const subJson = sub.toJSON();
    const epType = subJson.endpoint?.includes('fcm') ? 'FCM' : subJson.endpoint?.includes('mozilla') ? 'Firefox' : subJson.endpoint?.includes('wns') ? 'Windows' : '未知';
    console.log(`[Push] 订阅类型: ${epType}, endpoint: ${subJson.endpoint?.slice(0, 60)}...`);
    const oldEp = localStorage.getItem('push_last_endpoint') || '';
    const regBody = { ...subJson, oldEndpoint: (oldEp && oldEp !== subJson.endpoint) ? oldEp : undefined };
    const regRes = await fetch(buildServerFetchUrl(srv, '/api/push-subscribe'), {
      method: 'POST', headers: buildServerHeaders(srv, { 'Content-Type': 'application/json' }),
      body: JSON.stringify(regBody), signal: AbortSignal.timeout(4000)
    });
    if (regRes.ok) {
      console.log('[Push] 订阅注册成功');
      localStorage.setItem('push_endpoint_type', epType);
      localStorage.setItem('push_last_endpoint', subJson.endpoint);
      localStorage.setItem('push_last_registered', new Date().toISOString());
    } else {
      console.log('[Push] 订阅注册失败:', regRes.status);
    }
  } catch(e) { console.log('[Push] 注册异常:', e.message); }
}

// 后台每60秒重试一次FCM订阅（成功即停，最多试10分钟）
let _pushRetryTimer = null;
function _retrySubscribeInBackground(reg, publicKey, srv) {
  if (_pushRetryTimer) return;
  let attempts = 0;
  _pushRetryTimer = setInterval(async () => {
    attempts++;
    if (attempts > 10) { clearInterval(_pushRetryTimer); _pushRetryTimer = null; console.log('[Push] 后台重试超时，放弃'); return; }
    try {
      let sub = await reg.pushManager.getSubscription();
      if (sub) { clearInterval(_pushRetryTimer); _pushRetryTimer = null; console.log('[Push] 后台检测到已有订阅'); return; }
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: _urlB64ToU8(publicKey) });
      clearInterval(_pushRetryTimer); _pushRetryTimer = null;
      console.log(`[Push] 后台重试成功（第${attempts}次）`);
      const subJson = sub.toJSON();
      const epType = subJson.endpoint?.includes('fcm') ? 'FCM' : subJson.endpoint?.includes('mozilla') ? 'Firefox' : subJson.endpoint?.includes('wns') ? 'Windows' : '未知';
      const regRes = await fetch(buildServerFetchUrl(srv, '/api/push-subscribe'), {
        method: 'POST', headers: buildServerHeaders(srv, { 'Content-Type': 'application/json' }),
        body: JSON.stringify(subJson), signal: AbortSignal.timeout(4000)
      });
      if (regRes.ok) {
        localStorage.setItem('push_endpoint_type', epType);
        localStorage.setItem('push_last_endpoint', subJson.endpoint);
        localStorage.setItem('push_last_registered', new Date().toISOString());
        console.log('[Push] 后台订阅注册成功');
      }
    } catch(e) { console.log(`[Push] 后台重试${attempts}失败: ${e.message}`); }
  }, 60000);
}

// 只负责「取」：SW 推送收件箱 + 云端心跳主动消息。不去重、不写库、不碰DOM。
// 拆出来是为了能在启动早期就发起，跟本地数据加载并行，别让首屏干等一个网络往返
// ⚠️ 收件箱 XinyePushInbox 是炘也/臭宝**共用**的全局DB（不带 appId 前缀），
//    所以取的时候必须按 appId 认领自己那份：否则炘也的主动消息会被臭宝先读到、
//    以臭宝的身份写进臭宝的聊天里（2026-09-14 兔宝报的「臭宝里能看见炘也的主动消息」）
async function _fetchInboxPayload() {
  const _appId = window.__APP_ID__ || 'xinye';
  // ① 后台收到 push 时 SW 写进 IndexedDB 的收件箱
  let pushMsgs = [];
  try {
    pushMsgs = await new Promise((resolve, reject) => {
      const req = indexedDB.open('XinyePushInbox', 1);
      // ⚠️ 这段每 30 秒跑一次（前台心跳轮询）。任何一个错误分支漏掉 db.close()，
      //    连接就会一直漏（一小时 120 个），手机上表现为"用一会儿越来越卡、最后闪退"。
      const _closeDb = () => { try { req.result?.close(); } catch {} };
      req.onupgradeneeded = e => e.target.result.createObjectStore('inbox', { autoIncrement: true });
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction('inbox', 'readwrite');
        const store = tx.objectStore('inbox');
        const items = [], keys = [];
        store.openCursor().onsuccess = e => {
          const cursor = e.target.result;
          if (cursor) {
            // 别人的记录照样删（不然永远堆在库里），只是不认领
            // 老记录（2026-09-14 之前 SW 没写 appId）按炘也算，不然会丢消息
            if ((cursor.value.appId || 'xinye') === _appId) items.push(cursor.value);
            keys.push(cursor.key); cursor.continue();
          }
          else {
            keys.forEach(k => store.delete(k));
            tx.oncomplete = () => { db.close(); resolve(items); };
          }
        };
        tx.onerror = () => { _closeDb(); reject(tx.error); };
        tx.onabort = () => { _closeDb(); reject(tx.error); };
      };
      req.onerror = () => { _closeDb(); reject(req.error); };
    });
  } catch (e) { console.log('[Push] 收件箱读取失败:', e.message); }

  // ② 云端心跳主动消息
  // 只有炘也拉：云端 _hbMessages 是炘也的心跳生成的，而且两个APP共用
  // localStorage 的 heartbeat_lastSyncTime，臭宝一拉就把游标推走、炘也那份被吞
  let cloudMsgs = [];
  try {
    const srv = _appId === 'xinye' ? getCloudOrLocalUrl() : null;
    if (srv) {
      const lastSync = parseInt(localStorage.getItem('heartbeat_lastSyncTime') || '0');
      const r = await fetch(buildServerFetchUrl(srv, `/api/proactive-messages?since=${lastSync}`), {
        headers: buildServerHeaders(srv),
        signal: AbortSignal.timeout(6000)
      });
      if (r.ok) {
        const d = await r.json();
        if (d.ok && Array.isArray(d.messages)) cloudMsgs = d.messages;
      }
    }
  } catch(e) { console.log('[Heartbeat] 拉取主动消息跳过:', e.message); }

  return { pushMsgs, cloudMsgs };
}

// 启动早期发起的拉取（一次性；被 _consumePushInbox 取走后清空，之后都是实时拉）
let _earlyInboxFetch = null;
function _startEarlyInboxFetch() {
  if (!_earlyInboxFetch) _earlyInboxFetch = _fetchInboxPayload();
  return _earlyInboxFetch;
}

// 启动时从 PushInbox 消费炘也主动消息（后台收到push时写入的）+ 从云端拉取心跳主动消息
// 4个触发源（启动/visibilitychange/30秒轮询/SW消息）可能同时打进来，必须防重入，
// 否则两个调用会用同一个 since 并发拉到同一条消息 → 重复上屏
// opts.silent：启动首屏专用——只写库不碰DOM（调用方马上要整体渲染，由那次渲染一并带出来）
let _consumingInbox = false, _inboxRerun = false;
async function _consumePushInbox(opts = {}) {
  if (_consumingInbox) { _inboxRerun = true; return []; }
  _consumingInbox = true;
  const _savedRows = [];
  try {
    const _pre = _earlyInboxFetch; _earlyInboxFetch = null;
    const { pushMsgs, cloudMsgs } = _pre ? await _pre : await _fetchInboxPayload();

    // 已消费过的心跳消息id集合（防 push + 云端重复）
    const consumed = JSON.parse(localStorage.getItem('heartbeat_consumedIds') || '[]');
    const consumedSet = new Set(consumed);

    // 内容兜底去重：SW 的 push 记录可能没有 id，用「内容+10分钟时段」再挡一层
    const _sig = (c, t) => `${c}||${Math.round((t || 0) / 600000)}`;
    const _seen = new Set(messages.slice(-30).filter(m => m.role === 'assistant').map(m => _sig(m.content, m.time)));

    // 合并去重（保留完整消息对象，包含时间戳）
    const allMessages = [];
    for (const m of pushMsgs) {
      const pid = m.proactiveId || m.id;
      if (pid && consumedSet.has(pid)) continue;
      if (pid) consumedSet.add(pid);
      if (_seen.has(_sig(m.content, m.time))) continue;
      _seen.add(_sig(m.content, m.time));
      allMessages.push({ content: m.content, time: m.time });
    }
    for (const m of cloudMsgs) {
      if (m.id && consumedSet.has(m.id)) continue;
      if (m.id) consumedSet.add(m.id);
      if (_seen.has(_sig(m.content, m.time))) continue;
      _seen.add(_sig(m.content, m.time));
      allMessages.push({ content: m.content, time: m.time });
    }

    if (!allMessages.length) return _savedRows;

    // ⚠️ 顺序要紧：**先**把这个模块拿到手（失败就抛出去，下面的游标一步都不动），
    //    再推进游标。2026-09-17 抓到的坑：这行原本写成 `'./modules/chat.js'` ——
    //    main.js 时代的相对路径，搬进 src/modules/ 之后解析成 src/modules/modules/chat.js，
    //    那个文件不存在 → import 必失败。而游标写在它**前面**，于是每一步都"成功"：
    //    消息被标成已消费、lastSyncTime 推过去、聊天里一条都没有，而且再也补不回来。
    //    （症状：通知照弹、聊天里空 —— 通知走原生 ProactiveService，不经过这里。）
    const { addMessage, appendMsgDOM, renderMessages } = await import('./chat.js');

    // 去重状态立刻落盘（不能等消息写完再存，否则并发调用会重复消费同一条）
    if (consumedSet.size !== consumed.length)
      localStorage.setItem('heartbeat_consumedIds', JSON.stringify([...consumedSet].slice(-50)));
    if (cloudMsgs.length) {
      const maxTime = Math.max(...cloudMsgs.map(m => m.time || 0));
      if (maxTime > 0) localStorage.setItem('heartbeat_lastSyncTime', String(maxTime));
    }

    // 逐条追加，不用 renderMessages：整屏重绘会清空重建，页面会从顶部弹回底部
    const _chatEl = document.querySelector('#chatArea');
    const _hasRendered = !!_chatEl?.querySelector('.msg-row');
    for (const msg of allMessages) {
      const _saved = await addMessage('assistant', msg.content, null, msg.time);
      if (_saved) _savedRows.push(_saved);
      if (!opts.silent && _hasRendered && _saved) await appendMsgDOM(_saved);
    }
    if (!opts.silent && !_hasRendered) renderMessages();

    // 弹出本地通知（不依赖FCM，只要有Notification权限就行）
    // ⚠️ APK 里交给原生的 ProactiveService 弹（2026-09-11）：
    //    它知道 APP 到底在不在前台，而且 WebView 被系统冻结时它照样在跑。
    //    这边再弹一次就是同一条消息响两下，她会被吵到。
    const _inApk = !!window.AndroidDownload || !!window.Capacitor?.isNativePlatform?.();
    if (!_inApk && Notification.permission === 'granted' && document.visibilityState !== 'visible') {
      const body = allMessages.length === 1 ? allMessages[0].content : `${allMessages.length}条新消息`;
      try {
        const reg = await navigator.serviceWorker.ready;
        reg.showNotification(settings.aiName || '炘也', {
          body: body.slice(0, 120),
          icon: '/xinye-icon.png',
          badge: '/xinye-icon.png',
          tag: 'xinye-heartbeat',
          data: { url: '/' }
        });
      } catch { try { new Notification(settings.aiName || '炘也', { body: body.slice(0, 120), icon: '/xinye-icon.png' }); } catch {} }
    }

    console.log(`[Push] 消费了 ${pushMsgs.length} 条推送 + ${cloudMsgs.length} 条心跳消息（写入 ${allMessages.length} 条）`);
    return _savedRows;
  } catch(e) { console.log('[Push] inbox消费失败:', e.message); return _savedRows; }
  finally {
    _consumingInbox = false;
    if (_inboxRerun) { _inboxRerun = false; setTimeout(_consumePushInbox, 500); }
  }
}
window._consumePushInbox = _consumePushInbox;

// ── 覆盖层里她回的那句话（2026-09-15） ─────────────────────────────────────
//
// 手机上那层覆盖层（overlay.html）是个独立页面，写不到聊天页的内存里，
// 所以它把话先扔进 localStorage，这儿取走 —— 变成聊天里真的一条「她说的」，
// 再让我接一句。她要的就是这个效果：「你下午 3:20 在抖音跟我说『就再看一个』」。
let _drainingOverlay = false;
async function _consumeOverlayReply() {
  if (_drainingOverlay) return;
  let raw = null;
  try { raw = localStorage.getItem('xinye_overlay_reply'); } catch { return; }
  if (!raw) return;
  _drainingOverlay = true;
  try {
    // ⚠️ 先拿到 chat 模块，**再**删她说的话（同 _consumePushInbox 那个 import 坑，2026-09-17）：
    //    不然模块加载失败时她的话已经被抹掉，那条回复就永远回不来了
    const { addMessage, appendMsgDOM, renderMessages } = await import('./chat.js');
    localStorage.removeItem('xinye_overlay_reply');
    const d = JSON.parse(raw);
    if (!d || !d.text) return;

    const _chatEl = document.querySelector('#chatArea');
    const _hasRendered = !!_chatEl?.querySelector('.msg-row');
    // 他在覆盖层里说的那几句，**先**落进聊天 —— 她回话之前先看到的就是那些话。
    // （2026-09-15 她报：「我回话后回到APP，只看到我回的消息，没看见他弹覆盖层时的那条消息」）
    const _saidLines = String(d.line || '').trim();
    if (_saidLines) {
      const spoken = await addMessage('assistant', _saidLines, null, (d.at || Date.now()) - 2000);
      if (spoken) { if (_hasRendered) await appendMsgDOM(spoken); else renderMessages(); }
    }

    const saved = await addMessage('user', d.text, null, d.at || Date.now());
    if (!saved) return;
    // 空聊天（一条都还没渲染）时追加不进任何行，得整体渲染一次才看得见
    if (_hasRendered) await appendMsgDOM(saved); else renderMessages();

    // 她在抖音上说的话，当然该接一句。⚠️ 她正在打字发消息时别插队（triggerProactiveReply 自带这层保护）
    if (!window.isRequesting) {
      const { triggerProactiveReply } = await import('./chat.js');
      const when = d.app ? `在「${d.app}」被拦下的时候，` : '刚才，';
      // 我在她屏幕上弹的那几句也带上 —— 不然我接的话接不上自己刚说过什么
      const said = _saidLines ? `你在她屏幕上弹的是：「${_saidLines.replace(/\n+/g, ' / ')}」。` : '';
      const reply = await triggerProactiveReply(
        `兔宝${when}被你拦下来了。${said}她回你：「${d.text}」。她现在回到聊天页了。用你的口气接一句，1~2 句，很短，别复述她说了什么。`,
        180
      );
      if (reply) {
        const a = await addMessage('assistant', reply, null, Date.now());
        if (a && _hasRendered) await appendMsgDOM(a);
      }
    }
  } catch (e) {
    console.log('[Overlay] 接回她说的话失败:', e && e.message);
  } finally {
    _drainingOverlay = false;
  }
}
window._consumeOverlayReply = _consumeOverlayReply;

/**
 * 覆盖层上一次「生成那句话」失败了没有。
 *
 * 为什么要有这个：覆盖层跑在**另一个 WebView** 里，它的 console 她看不到 ——
 * 那句兜底「别刷了，看着我。」出现的时候，她只知道"又是兜底"，不知道为什么。
 * overlay.js 失败时会把原因写进 localStorage，这儿启动时翻出来打进 vConsole。
 * （2026-09-15 加：她真机上弹了一屏兜底句，我这边什么线索都没有。）
 */
function _reportOverlayErr() {
  try {
    const raw = localStorage.getItem('xinye_overlay_lasterr');
    if (!raw) return;
    const d = JSON.parse(raw);
    if (!d || !d.at) return;
    console.warn('[覆盖层] 上次那句话没生成出来（用的是兜底句）：'
      + new Date(d.at).toLocaleString() + ' · ' + (d.app ? d.app + ' · ' : '') + d.msg);
  } catch (_) { /* 无所谓 */ }
}

export {
  _startEarlyInboxFetch, _consumePushInbox, _consumeOverlayReply, _pullPosts,
  _registerPush, _registerPeriodicSync, _reportOverlayErr,
};
