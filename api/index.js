import crypto from 'node:crypto';
import * as store from '../lib/store.js';
import { HttpError } from '../lib/store.js';
import { notifyGrok } from '../lib/webhook.js';
import { handleMcp } from '../lib/mcp.js';
import { openapi } from '../lib/openapi.js';
import { docsText } from '../lib/docs.js';

const keyEq = (a, b) => {
  if (!a || !b) return false;
  const x = crypto.createHash('sha256').update(a).digest(), y = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(x, y);
};
function presentedKey(req) {
  const h = req.headers.authorization || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  return (m ? m[1] : req.headers['x-api-key'] || '').trim();
}
function baseUrl(req) {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/$/, '');
  return `https://${req.headers['x-forwarded-host'] || req.headers.host}`;
}
function send(res, status, obj, headers = {}) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.end(obj === null ? '' : JSON.stringify(obj));
}
async function readBody(req) {
  if (req.body !== undefined && typeof req.body !== 'string' && !Buffer.isBuffer(req.body)) return req.body;
  let raw = typeof req.body === 'string' ? req.body : Buffer.isBuffer(req.body) ? req.body.toString() : '';
  if (!raw) { const chunks = []; for await (const c of req) chunks.push(c); raw = Buffer.concat(chunks).toString(); }
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { throw new HttpError(400, 'Body must be valid JSON'); }
}

export default async function handler(req, res) {
  const url = new URL(req.url, 'http://x');
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const q = Object.fromEntries(url.searchParams);
  store.setBaseUrl(baseUrl(req));
  const ac = new AbortController();
  res.on('close', () => { if (!res.writableEnded) ac.abort(); });
  try {
    if (path === '/health') return send(res, 200, { status: 'ok' });
    if (path === '/openapi.json') return send(res, 200, openapi(baseUrl(req)));
    if (path === '/docs' || path === '/' || path === '/llms.txt' || path === '/docs.md') {
      res.statusCode = 200; res.setHeader('content-type', 'text/plain; charset=utf-8');
      return res.end(docsText(baseUrl(req)));
    }

    // --- MCP for Grok Bot ---
    if (path === '/mcp') {
      if (!keyEq(presentedKey(req), process.env.GROK_KEY)) return send(res, 401, { error: 'unauthorized' }, { 'www-authenticate': 'Bearer' });
      if (req.method === 'GET') return send(res, 405, { error: 'SSE stream not supported; POST JSON-RPC requests' }, { allow: 'POST, DELETE' });
      if (req.method === 'DELETE') return send(res, 200, {});
      if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });
      let body;
      try { body = await readBody(req); } catch { return send(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); }
      const out = await handleMcp(body);
      if (out === null) { res.statusCode = 202; return res.end(); }
      return send(res, 200, out);
    }

    // --- Files: either key may download ---
    const fm = path.match(/^\/api\/v1\/files\/([^/]+)$/);
    if (fm) {
      const k = presentedKey(req);
      if (!keyEq(k, process.env.MUSE_KEY) && !keyEq(k, process.env.GROK_KEY)) return send(res, 401, { error: 'unauthorized' }, { 'www-authenticate': 'Bearer' });
      if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' });
      const a = await store.getAttachment(decodeURIComponent(fm[1]));
      const buf = Buffer.from(a.content_base64, 'base64');
      res.statusCode = 200;
      res.setHeader('content-type', a.content_type);
      res.setHeader('content-length', String(buf.length));
      res.setHeader('content-disposition', `attachment; filename="${a.filename.replace(/["\\]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(a.filename)}`);
      res.setHeader('x-content-sha256', a.sha256);
      res.setHeader('x-content-type-options', 'nosniff');
      res.setHeader('cache-control', 'private, no-store');
      return res.end(buf);
    }

    // --- REST for Muse ---
    if (path.startsWith('/api/v1/')) {
      if (!keyEq(presentedKey(req), process.env.MUSE_KEY)) return send(res, 401, { error: 'unauthorized: send the Muse API key as "Authorization: Bearer <key>"' }, { 'www-authenticate': 'Bearer' });
      if (path === '/api/v1/ask') {
        if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });
        const b = await readBody(req);
        const w = b.wait_seconds == null ? 240 : Number(b.wait_seconds);
        if (!Number.isFinite(w) || w < 0) return send(res, 400, { error: '"wait_seconds" must be a number' });
        const waitS = Math.min(w, store.MAX_WAIT_SECONDS);
        const message = await store.sendMessage('muse', b);
        const webhook = await notifyGrok(message);
        const reply = await store.waitForReply('muse', message.thread_id, message.id, waitS, ac.signal);
        if (reply) {
          if (b.mark_reply_read !== false) { await store.markRead('muse', { message_ids: [reply.id] }); reply.read = true; reply.read_at = new Date().toISOString(); }
          return send(res, 200, { message, reply, timed_out: false, notified: webhook.startsWith('http_2') });
        }
        return send(res, 200, { message, reply: null, timed_out: true, thread_id: message.thread_id, next_cursor: message.cursor, notified: webhook.startsWith('http_2'),
          hint: `Keep waiting with GET /api/v1/messages?thread_id=${message.thread_id}&since=${message.cursor}&wait=240` });
      }
      if (path === '/api/v1/messages') {
        if (req.method === 'POST') {
          const message = await store.sendMessage('muse', await readBody(req));
          const webhook = await notifyGrok(message);
          return send(res, 201, { message, notified: webhook.startsWith('http_2') });
        }
        if (req.method === 'GET') return send(res, 200, await store.listIncoming('muse', q, ac.signal));
        return send(res, 405, { error: 'method not allowed' });
      }
      if (path === '/api/v1/messages/read') {
        if (req.method !== 'POST') return send(res, 405, { error: 'method not allowed' });
        return send(res, 200, await store.markRead('muse', await readBody(req)));
      }
      if (path === '/api/v1/threads' && req.method === 'GET') return send(res, 200, await store.listThreads('muse', q));
      const m = path.match(/^\/api\/v1\/threads\/([^/]+)$/);
      if (m && req.method === 'GET') return send(res, 200, await store.getThread(decodeURIComponent(m[1])));
    }
    return send(res, 404, { error: 'not found; see /docs' });
  } catch (e) {
    if (e instanceof HttpError) return send(res, e.status, { error: e.message });
    if (e?.status === 400 || e?.type === 'entity.too.large') return send(res, 413, { error: 'request body too large (Vercel limit 4.5 MB)' });
    console.error(e);
    return send(res, 500, { error: 'internal error' });
  }
}
