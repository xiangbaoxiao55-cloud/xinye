const https = require('https');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'method not allowed' }); return; }

  const { apiKey, body: wrBody } = req.body || {};
  if (!apiKey) { res.status(400).json({ error: 'missing apiKey' }); return; }

  const payload = JSON.stringify(wrBody);
  console.log('[weread-proxy] api_name:', wrBody?.api_name);

  return new Promise(resolve => {
    const proxyReq = https.request({
      hostname: 'i.weread.qq.com', port: 443, path: '/api/agent/gateway', method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, proxyRes => {
      const chunks = [];
      proxyRes.on('data', c => chunks.push(c));
      proxyRes.on('end', () => {
        const data = Buffer.concat(chunks).toString('utf-8');
        res.status(proxyRes.statusCode).setHeader('Content-Type', 'application/json').end(data);
        resolve();
      });
      proxyRes.on('error', e => { res.status(502).json({ error: e.message }); resolve(); });
    });
    proxyReq.on('error', e => { res.status(502).json({ error: e.message }); resolve(); });
    proxyReq.write(payload);
    proxyReq.end();
  });
};
