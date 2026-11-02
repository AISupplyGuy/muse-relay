import crypto from 'node:crypto';
import { setWebhookStatus } from './store.js';

// POST each new Muse message to GROK_WEBHOOK_URL, signed with HMAC-SHA256.
// Headers: X-Relay-Timestamp (unix seconds), X-Relay-Signature: sha256=<hex of HMAC(secret, `${timestamp}.${body}`)>,
// and X-Relay-Secret (the raw shared secret) for receivers that can only compare a static header.
// If GROK_WEBHOOK_AUTH is set, it is also sent verbatim as the Authorization header (e.g. "Bearer <token>").
export async function notifyGrok(message) {
  const url = process.env.GROK_WEBHOOK_URL;
  if (!url) return 'skipped:no_url';
  const secret = process.env.WEBHOOK_SECRET || '';
  const body = JSON.stringify({ event: 'muse.message.created', message });
  const ts = Math.floor(Date.now() / 1000).toString();
  const sig = crypto.createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');
  const headers = {
    'content-type': 'application/json', 'user-agent': 'muse-relay/1.0',
    'x-relay-timestamp': ts, 'x-relay-signature': `sha256=${sig}`, 'x-relay-secret': secret,
    'x-relay-event': 'muse.message.created',
  };
  const auth = process.env.GROK_WEBHOOK_AUTH;
  if (auth) headers.authorization = auth;
  let status;
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers,
      body, signal: AbortSignal.timeout(5000),
    });
    status = `http_${r.status}`;
  } catch (e) { status = `error:${e.name}`; }
  try { await setWebhookStatus(message.id, status); } catch {}
  return status;
}

// Optional: POST each new Grok->Muse message to MUSE_WEBHOOK_URL (e.g. a Zapier/n8n catch hook or any
// endpoint that can wake Muse). Same signing headers as notifyGrok; MUSE_WEBHOOK_AUTH is sent verbatim as Authorization.
export async function notifyMuse(message) {
  const url = process.env.MUSE_WEBHOOK_URL;
  if (!url) return 'skipped:no_url';
  const secret = process.env.WEBHOOK_SECRET || '';
  const body = JSON.stringify({ event: 'grok.message.created', message });
  const ts = Math.floor(Date.now() / 1000).toString();
  const sig = crypto.createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');
  const headers = { 'content-type': 'application/json', 'user-agent': 'muse-relay/1.0',
    'x-relay-timestamp': ts, 'x-relay-signature': `sha256=${sig}`, 'x-relay-event': 'grok.message.created' };
  if (process.env.MUSE_WEBHOOK_AUTH) headers.authorization = process.env.MUSE_WEBHOOK_AUTH;
  try {
    const r = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(5000) });
    return `http_${r.status}`;
  } catch (e) { return `error:${e.name}`; }
}
