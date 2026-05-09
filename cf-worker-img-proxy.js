/**
 * xinye-img-proxy Cloudflare Worker
 *
 * 部署步骤：
 * 1. CF Dashboard → Workers & Pages → KV → Create namespace → 名字填 "IMAGE_JOBS"
 * 2. 进 Worker 设置 → Variables → KV Namespace Bindings → 添加:
 *    Variable name: IMAGE_JOBS  KV namespace: 选刚建的那个
 * 3. 把这整个文件内容粘贴到 Worker 编辑器，Save & Deploy
 *
 * 端点：
 *   POST /api/proxy-image-edits     - 提交垫图任务，立刻返回 {jobId}
 *   GET  /api/image-job/:jobId      - 轮询任务状态
 *   POST /api/proxy-image-generations - 文生图同步代理（~78s，直接透传）
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Api-Url, X-Api-Key, Authorization',
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    // 轮询任务结果
    if (request.method === 'GET' && url.pathname.startsWith('/api/image-job/')) {
      const jobId = url.pathname.slice('/api/image-job/'.length);
      if (!jobId) return Response.json({ status: 'not_found' }, { status: 404, headers: CORS });
      const raw = await env.IMAGE_JOBS.get(jobId);
      if (!raw) return Response.json({ status: 'not_found' }, { status: 404, headers: CORS });
      return new Response(raw, { headers: { ...CORS, 'Content-Type': 'application/json' } });
    }

    // 垫图异步任务
    if (request.method === 'POST' && url.pathname === '/api/proxy-image-edits') {
      const apiUrl = request.headers.get('X-Api-Url');
      const apiKey = request.headers.get('X-Api-Key');
      if (!apiUrl || !apiKey) {
        return Response.json({ error: 'Missing X-Api-Url or X-Api-Key' }, { status: 400, headers: CORS });
      }

      const jobId = crypto.randomUUID();
      const bodyBuf = await request.arrayBuffer();
      const cType = request.headers.get('Content-Type');

      // 先写 pending，再返回 jobId，再后台跑
      await env.IMAGE_JOBS.put(jobId, JSON.stringify({ status: 'pending' }), { expirationTtl: 3600 });

      ctx.waitUntil((async () => {
        try {
          const resp = await fetch(apiUrl, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': cType },
            body: bodyBuf,
          });
          if (!resp.ok) {
            const txt = await resp.text();
            await env.IMAGE_JOBS.put(jobId,
              JSON.stringify({ status: 'error', message: `API ${resp.status}: ${txt.slice(0, 300)}` }),
              { expirationTtl: 3600 });
            return;
          }
          const data = await resp.json();
          await env.IMAGE_JOBS.put(jobId, JSON.stringify({ status: 'done', data }), { expirationTtl: 3600 });
        } catch (e) {
          await env.IMAGE_JOBS.put(jobId,
            JSON.stringify({ status: 'error', message: e.message }),
            { expirationTtl: 3600 });
        }
      })());

      return Response.json({ jobId }, { headers: CORS });
    }

    // 文生图同步代理（约 78s，CF Worker 能撑住）
    if (request.method === 'POST' && url.pathname === '/api/proxy-image-generations') {
      const body = await request.json();
      const { apiUrl, apiKey, ...rest } = body;
      if (!apiUrl || !apiKey) {
        return Response.json({ error: 'Missing apiUrl or apiKey' }, { status: 400, headers: CORS });
      }
      const resp = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(rest),
      });
      const buf = await resp.arrayBuffer();
      return new Response(buf, {
        status: resp.status,
        headers: { ...CORS, 'Content-Type': resp.headers.get('Content-Type') || 'application/json' },
      });
    }

    return new Response('Not found', { status: 404, headers: CORS });
  },
};
