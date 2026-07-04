const http = require('http');
const https = require('https');
const { URL } = require('url');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  // 来源校验：只允许自己站点和本地开发环境
  const origin = req.headers['origin'] || '';
  const referer = req.headers['referer'] || '';
  const source = origin || referer;
  const allowed = source &&
    (source.includes('xinye-phi.vercel.app') ||
     source.includes('localhost') ||
     source.includes('192.168.1.'));
  if (!allowed) { res.status(403).json({ error: 'forbidden' }); return; }

  const { url } = req.query;
  if (!url) { res.status(400).json({ error: 'missing url' }); return; }

  let parsed;
  try { parsed = new URL(url); } catch { res.status(400).json({ error: 'invalid url' }); return; }

  const client = parsed.protocol === 'https:' ? https : http;

  return new Promise(resolve => {
    const proxyReq = client.get(url, { timeout: 15000 }, proxyRes => {
      const ct = proxyRes.headers['content-type'] || 'image/png';
      res.status(proxyRes.statusCode).setHeader('Content-Type', ct);
      res.setHeader('Cache-Control', 'public, max-age=86400');
      proxyRes.pipe(res);
      res.on('finish', resolve);
      proxyRes.on('error', e => { try { res.status(502).end(); } catch{} resolve(); });
    });
    proxyReq.on('error', e => { try { res.status(502).json({ error: e.message }); } catch{} resolve(); });
    proxyReq.on('timeout', () => { proxyReq.destroy(); try { res.status(504).end(); } catch{} resolve(); });
  });
};
