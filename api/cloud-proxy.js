const http = require('http');
const https = require('https');
const { URL } = require('url');

/**
 * Vercel serverless 中转：解决 HTTPS 前端调 HTTP 云服务器的 Mixed Content 问题
 * 前端调 /api/cloud-proxy?path=/api/push-test，本函数转发到云服务器
 */
module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Cloud-Server, X-Cloud-Token');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  // 来源校验
  const origin = req.headers['origin'] || '';
  const referer = req.headers['referer'] || '';
  const source = origin || referer;
  const allowed = source &&
    (source.includes('xinye-phi.vercel.app') ||
     source.includes('localhost') ||
     source.includes('192.168.1.'));
  if (!allowed) { res.status(403).json({ error: 'forbidden' }); return; }

  // 云服务器地址和路径从请求头/query获取
  const cloudServer = (req.headers['x-cloud-server'] || '').replace(/\/+$/, '');
  const apiPath = req.query.path || '';
  if (!cloudServer || !apiPath) {
    res.status(400).json({ error: 'missing x-cloud-server header or path query' });
    return;
  }

  let targetUrl;
  try { targetUrl = new URL(apiPath, cloudServer); } catch {
    res.status(400).json({ error: 'invalid target url' });
    return;
  }

  // 构建转发请求头
  const fwdHeaders = { 'Content-Type': req.headers['content-type'] || 'application/json' };
  const cloudToken = req.headers['x-cloud-token'];
  if (cloudToken) fwdHeaders['Authorization'] = `Bearer ${cloudToken}`;

  const client = targetUrl.protocol === 'https:' ? https : http;
  const method = req.method;

  // 收集请求体
  let bodyStr = null;
  if (method === 'POST' || method === 'PUT') {
    bodyStr = typeof req.body === 'string' ? req.body : JSON.stringify(req.body || {});
    fwdHeaders['Content-Length'] = Buffer.byteLength(bodyStr);
  }

  return new Promise(resolve => {
    const proxyReq = client.request({
      hostname: targetUrl.hostname,
      port: targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80),
      path: targetUrl.pathname + targetUrl.search,
      method,
      headers: fwdHeaders,
      // ⚠️ 这个 timeout 是**中转函数自己**给上游的时间，跟 Vercel 的函数上限是两码事。
      // 原来是 30000 —— 2026-09-17 踩到：云端读一条小红书视频笔记（要下 29MB 再抽帧）
      // 跑了 59.9 秒，中转 30 秒就放弃了，APP 那边**什么都没收到**，
      // 表现成"读了但只有标题"甚至"没读到"，跟服务端日志对不上。
      // 收到 55 秒，贴着 Vercel 免费版 60 秒的函数上限。真要跑更久得让云端直连（配 HTTPS）。
      timeout: 55000
    }, proxyRes => {
      const ct = proxyRes.headers['content-type'] || 'application/json';
      res.status(proxyRes.statusCode).setHeader('Content-Type', ct);
      proxyRes.pipe(res);
      res.on('finish', resolve);
      proxyRes.on('error', e => { try { res.status(502).json({ error: e.message }); } catch {} resolve(); });
    });
    proxyReq.on('error', e => { try { res.status(502).json({ error: e.message }); } catch {} resolve(); });
    proxyReq.on('timeout', () => { proxyReq.destroy(); try { res.status(504).end(); } catch {} resolve(); });
    if (bodyStr) proxyReq.write(bodyStr);
    proxyReq.end();
  });
};
