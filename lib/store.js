import { neon } from '@neondatabase/serverless';
import crypto from 'node:crypto';

import { SCHEMA_SQL } from './schema.js';

let _sql;
const raw = () => {
  if (!process.env.DATABASE_URL) throw new HttpError(500, 'DATABASE_URL is not set');
  return (_sql ||= neon(process.env.DATABASE_URL));
};
// Auto-migration: create tables on first use (idempotent), once per instance.
let _ready;
export function ensureSchema() {
  _ready ||= (async () => {
    const db = raw();
    for (const stmt of SCHEMA_SQL.split(';').map((x) => x.trim()).filter(Boolean)) await db(stmt);
  })().catch((e) => { _ready = null; throw e; });
  return _ready;
}
const sql = async (...a) => { await ensureSchema(); return raw()(...a); };

export const MAX_TEXT = 20000;
// Vercel caps request/response bodies at 4.5 MB. Base64 inflates by 4/3, so 3 MB raw -> ~4 MB encoded.
export const MAX_FILE_BYTES = Number(process.env.MAX_FILE_BYTES) || 3 * 1024 * 1024;
export const MAX_FILES_PER_MESSAGE = 5;
export const MAX_TOTAL_STORAGE_BYTES = Number(process.env.MAX_TOTAL_STORAGE_BYTES) || 400 * 1024 * 1024;
export const MAX_WAIT_SECONDS = 280;
const POLL_MS = Number(process.env.POLL_INTERVAL_MS) || 1500;

const other = (s) => (s === 'muse' ? 'grok' : 'muse');
let _base = '';
export const setBaseUrl = (b) => { _base = b; };

export class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

function fmtAtt(a) {
  return { id: a.id, filename: a.filename, content_type: a.content_type, size: Number(a.size), sha256: a.sha256, download_url: `${_base}/api/v1/files/${a.id}` };
}
function fmt(m, atts = []) {
  return {
    id: String(m.id), cursor: String(m.id), thread_id: m.thread_id, sender: m.sender, text: m.text,
    created_at: new Date(m.created_at).toISOString(),
    read: !!m.read_at, read_at: m.read_at ? new Date(m.read_at).toISOString() : null,
    attachments: atts.map(fmtAtt),
  };
}
async function withAttachments(rows) {
  if (!rows.length) return [];
  const ids = rows.map((r) => Number(r.id));
  const atts = await sql`SELECT id, message_id, filename, content_type, size, sha256 FROM attachments WHERE message_id = ANY(${ids}::bigint[]) ORDER BY created_at, id`;
  const by = new Map();
  for (const a of atts) { const k = String(a.message_id); if (!by.has(k)) by.set(k, []); by.get(k).push(a); }
  return rows.map((r) => fmt(r, by.get(String(r.id)) || []));
}
function fmtThread(t) {
  return {
    id: t.id, subject: t.subject, started_by: t.started_by,
    created_at: new Date(t.created_at).toISOString(), updated_at: new Date(t.updated_at).toISOString(),
    message_count: t.message_count != null ? Number(t.message_count) : undefined,
    unread_count: t.unread_count != null ? Number(t.unread_count) : undefined,
  };
}

function validateAttachments(list) {
  if (list == null) return [];
  if (!Array.isArray(list)) throw new HttpError(400, '"attachments" must be an array');
  if (list.length > MAX_FILES_PER_MESSAGE) throw new HttpError(400, `at most ${MAX_FILES_PER_MESSAGE} attachments per message`);
  let total = 0;
  return list.map((a, i) => {
    if (!a || typeof a !== 'object') throw new HttpError(400, `attachments[${i}] must be an object`);
    const { filename, content_type, content_base64 } = a;
    if (typeof filename !== 'string' || !filename.trim() || filename.length > 255) throw new HttpError(400, `attachments[${i}].filename is required (max 255 chars)`);
    if (content_type != null && (typeof content_type !== 'string' || content_type.length > 255)) throw new HttpError(400, `attachments[${i}].content_type must be a string`);
    if (typeof content_base64 !== 'string' || !content_base64) throw new HttpError(400, `attachments[${i}].content_base64 is required`);
    const clean = content_base64.replace(/^data:[^;,]*;base64,/, '').replace(/\s+/g, '');
    if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(clean)) throw new HttpError(400, `attachments[${i}].content_base64 is not valid base64`);
    const buf = Buffer.from(clean.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    if (!buf.length) throw new HttpError(400, `attachments[${i}] is empty`);
    if (buf.length > MAX_FILE_BYTES) throw new HttpError(413, `attachments[${i}] is ${buf.length} bytes; the limit is ${MAX_FILE_BYTES} bytes per file`);
    total += buf.length;
    if (total > MAX_FILE_BYTES) throw new HttpError(413, `attachments total ${total} bytes; the limit is ${MAX_FILE_BYTES} bytes per message`);
    return { filename: filename.replace(/[\/\\\0\r\n]/g, '_').trim(), content_type: content_type || 'application/octet-stream', buf };
  });
}

export async function sendMessage(sender, { text, thread_id, subject, attachments }) {
  const atts = validateAttachments(attachments);
  if (text == null && atts.length) text = '';
  if (typeof text !== 'string' || (!text.trim() && !atts.length)) throw new HttpError(400, '"text" is required (it may be empty only when attachments are included)');
  if (text.length > MAX_TEXT) throw new HttpError(400, `"text" is longer than ${MAX_TEXT} characters`);
  if (subject != null && (typeof subject !== 'string' || subject.length > 200)) throw new HttpError(400, '"subject" must be a string of at most 200 characters');
  if (atts.length) {
    const [{ used }] = await sql`SELECT coalesce(sum(size),0)::bigint AS used FROM attachments`;
    const add = atts.reduce((s, a) => s + a.buf.length, 0);
    if (Number(used) + add > MAX_TOTAL_STORAGE_BYTES) throw new HttpError(507, 'relay attachment storage is full; ask the operator to clean up old files');
  }
  let tid = thread_id;
  if (tid != null) {
    if (typeof tid !== 'string') throw new HttpError(400, '"thread_id" must be a string');
    const t = await sql`UPDATE threads SET updated_at = now() WHERE id = ${tid} RETURNING id`;
    if (!t.length) throw new HttpError(404, `thread ${tid} not found`);
  } else {
    tid = 'thr_' + crypto.randomBytes(8).toString('hex');
    const subj = subject || text.slice(0, 80) || atts[0]?.filename || 'attachment';
    await sql`INSERT INTO threads (id, subject, started_by) VALUES (${tid}, ${subj}, ${sender})`;
  }
  const [m] = await sql`INSERT INTO messages (thread_id, sender, text) VALUES (${tid}, ${sender}, ${text}) RETURNING *`;
  const saved = [];
  for (const a of atts) {
    const id = 'att_' + crypto.randomBytes(10).toString('hex');
    const sha = crypto.createHash('sha256').update(a.buf).digest('hex');
    const [row] = await sql`INSERT INTO attachments (id, message_id, filename, content_type, size, sha256, data)
      VALUES (${id}, ${m.id}, ${a.filename}, ${a.content_type}, ${a.buf.length}, ${sha}, decode(${a.buf.toString('base64')}, 'base64'))
      RETURNING id, message_id, filename, content_type, size, sha256`;
    saved.push(row);
  }
  return fmt(m, saved);
}

function parseWait(w) {
  if (w == null || w === '') return 0;
  const n = Number(w);
  if (!Number.isFinite(n) || n < 0) throw new HttpError(400, '"wait" must be a number of seconds');
  return Math.min(n, MAX_WAIT_SECONDS);
}
const sleep = (ms, signal) => new Promise((r) => { const t = setTimeout(r, ms); signal?.addEventListener?.('abort', () => { clearTimeout(t); r(); }, { once: true }); });

// Messages addressed TO `reader` (i.e. sent by the other side). With wait>0, long-polls until at least one matches.
export async function listIncoming(reader, { since, unread_only = true, limit = 50, thread_id, wait } = {}, signal) {
  const from = other(reader);
  const after = since != null && since !== '' ? Number(since) : 0;
  if (!Number.isFinite(after) || after < 0) throw new HttpError(400, '"since" must be a cursor value returned by this API');
  const lim = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const uo = !(unread_only === false || unread_only === 'false' || unread_only === '0');
  const tid = thread_id || null;
  const waitS = parseWait(wait);
  const deadline = Date.now() + waitS * 1000;
  let rows;
  for (;;) {
    rows = await sql`
      SELECT * FROM messages
      WHERE sender = ${from} AND id > ${after}
        AND (${uo}::boolean = false OR read_at IS NULL)
        AND (${tid}::text IS NULL OR thread_id = ${tid})
      ORDER BY id ASC LIMIT ${lim}`;
    if (rows.length || Date.now() + POLL_MS > deadline || signal?.aborted) break;
    await sleep(POLL_MS, signal);
  }
  const msgs = await withAttachments(rows);
  const [{ n }] = await sql`SELECT count(*)::int AS n FROM messages WHERE sender = ${from} AND read_at IS NULL`;
  const out = { messages: msgs, next_cursor: msgs.length ? msgs[msgs.length - 1].cursor : (after ? String(after) : null), unread_total: n, has_more: msgs.length === lim };
  if (waitS > 0) out.timed_out = msgs.length === 0;
  return out;
}

// Wait for the first message from the other side in `thread_id` with id > afterId.
export async function waitForReply(reader, thread_id, afterId, waitS, signal) {
  const from = other(reader);
  const deadline = Date.now() + Math.min(waitS, MAX_WAIT_SECONDS) * 1000;
  for (;;) {
    const rows = await sql`SELECT * FROM messages WHERE thread_id = ${thread_id} AND sender = ${from} AND id > ${Number(afterId)} ORDER BY id ASC LIMIT 1`;
    if (rows.length) return (await withAttachments(rows))[0];
    if (Date.now() + POLL_MS > deadline || signal?.aborted) return null;
    await sleep(POLL_MS, signal);
  }
}

export async function getThread(id) {
  if (typeof id !== 'string' || !id) throw new HttpError(400, '"thread_id" is required');
  const t = await sql`SELECT * FROM threads WHERE id = ${id}`;
  if (!t.length) throw new HttpError(404, `thread ${id} not found`);
  const msgs = await sql`SELECT * FROM messages WHERE thread_id = ${id} ORDER BY id ASC LIMIT 500`;
  return { thread: fmtThread(t[0]), messages: await withAttachments(msgs) };
}

export async function getAttachment(id) {
  if (typeof id !== 'string' || !/^att_[0-9a-f]+$/.test(id)) throw new HttpError(400, '"attachment_id" must look like att_...');
  const r = await sql`SELECT id, message_id, filename, content_type, size, sha256, encode(data, 'base64') AS b64 FROM attachments WHERE id = ${id}`;
  if (!r.length) throw new HttpError(404, `attachment ${id} not found`);
  const a = r[0];
  return { ...fmtAtt(a), message_id: String(a.message_id), content_base64: a.b64.replace(/\s+/g, '') };
}

export async function listThreads(reader, { limit = 20 } = {}) {
  const lim = Math.min(Math.max(Number(limit) || 20, 1), 100);
  const from = other(reader);
  const rows = await sql`
    SELECT t.*, count(m.id) AS message_count,
           count(m.id) FILTER (WHERE m.sender = ${from} AND m.read_at IS NULL) AS unread_count
    FROM threads t LEFT JOIN messages m ON m.thread_id = t.id
    GROUP BY t.id ORDER BY t.updated_at DESC LIMIT ${lim}`;
  return { threads: rows.map(fmtThread) };
}

// Marks messages addressed TO `reader` as read.
export async function markRead(reader, { message_ids, thread_id, up_to_cursor } = {}) {
  const from = other(reader);
  let rows;
  if (Array.isArray(message_ids) && message_ids.length) {
    const ids = message_ids.map(Number).filter(Number.isFinite);
    if (!ids.length) throw new HttpError(400, '"message_ids" must contain message ids');
    rows = await sql`UPDATE messages SET read_at = now() WHERE sender = ${from} AND read_at IS NULL AND id = ANY(${ids}::bigint[]) RETURNING id`;
  } else if (thread_id) {
    rows = await sql`UPDATE messages SET read_at = now() WHERE sender = ${from} AND read_at IS NULL AND thread_id = ${thread_id} RETURNING id`;
  } else if (up_to_cursor != null && up_to_cursor !== '') {
    const c = Number(up_to_cursor);
    if (!Number.isFinite(c)) throw new HttpError(400, '"up_to_cursor" must be a cursor value');
    rows = await sql`UPDATE messages SET read_at = now() WHERE sender = ${from} AND read_at IS NULL AND id <= ${c} RETURNING id`;
  } else throw new HttpError(400, 'Provide one of "message_ids", "thread_id", or "up_to_cursor"');
  return { marked_read: rows.length, message_ids: rows.map((r) => String(r.id)) };
}

export async function setWebhookStatus(id, status) {
  await sql`UPDATE messages SET webhook_status = ${status} WHERE id = ${Number(id)}`;
}
