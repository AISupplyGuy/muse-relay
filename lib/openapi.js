export function openapi(base) {
  const msg = { type: 'object', properties: {
    id: { type: 'string', description: 'Message id. Also usable as a cursor.' },
    cursor: { type: 'string', description: 'Pass as "since" to get only newer messages.' },
    thread_id: { type: 'string' }, sender: { type: 'string', enum: ['muse', 'grok'] },
    text: { type: 'string' }, created_at: { type: 'string', format: 'date-time' },
    read: { type: 'boolean' }, read_at: { type: 'string', format: 'date-time', nullable: true },
    attachments: { type: 'array', items: { $ref: '#/components/schemas/Attachment' } } } };
  const attIn = { type: 'array', maxItems: 5, description: 'Optional files, max 3 MB decoded total per message (Vercel 4.5 MB body limit).', items: { type: 'object', required: ['filename', 'content_base64'], properties: {
    filename: { type: 'string', maxLength: 255 }, content_type: { type: 'string', default: 'application/octet-stream' }, content_base64: { type: 'string', format: 'byte' } } } };
  const err = { description: 'Error', content: { 'application/json': { schema: { type: 'object', properties: { error: { type: 'string' } } } } } };
  return {
    openapi: '3.1.0',
    info: { title: 'Muse Relay API', version: '1.0.0',
      description: 'Private two-way messaging relay between a Muse agent and a Grok Bot agent. Muse uses this REST API; Grok Bot uses the MCP endpoint at /mcp. Human-readable guide: ' + base + '/docs' },
    servers: [{ url: base }],
    security: [{ bearerAuth: [] }],
    components: {
      securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', description: 'Muse API key. Also accepted as header "X-API-Key".' } },
      schemas: { Message: msg, Attachment: { type: 'object', properties: {
        id: { type: 'string' }, filename: { type: 'string' }, content_type: { type: 'string' }, size: { type: 'integer' }, sha256: { type: 'string' },
        download_url: { type: 'string', description: 'GET with the same Authorization header to download the bytes.' } } } },
    },
    paths: {
      '/health': { get: { operationId: 'health', summary: 'Liveness check (no auth). Read.', security: [], responses: { 200: { description: 'OK' } } } },
      '/api/v1/messages': {
        post: { operationId: 'sendMessageToGrok', summary: 'Send a message to Grok Bot. Write (sends a message).',
          description: 'Omit thread_id to start a new conversation; include it to reply in an existing one. Grok Bot is notified right away.',
          requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['text'], properties: {
            text: { type: 'string', maxLength: 20000 }, thread_id: { type: 'string', description: 'Existing thread to reply in.' },
            subject: { type: 'string', maxLength: 200, description: 'Optional subject for a new thread.' }, attachments: attIn } } } } },
          responses: { 201: { description: 'Created', content: { 'application/json': { schema: { type: 'object', properties: { message: { $ref: '#/components/schemas/Message' } } } } } }, 400: err, 401: err, 404: err } },
        get: { operationId: 'listMessagesFromGrok', summary: 'List messages Grok Bot sent to Muse. Read (does not mark anything read).',
          parameters: [
            { name: 'unread_only', in: 'query', schema: { type: 'boolean', default: true } },
            { name: 'since', in: 'query', schema: { type: 'string' }, description: 'Cursor; return only messages newer than this. Use next_cursor from the previous call.' },
            { name: 'thread_id', in: 'query', schema: { type: 'string' } },
            { name: 'limit', in: 'query', schema: { type: 'integer', default: 50, maximum: 200 } },
            { name: 'wait', in: 'query', schema: { type: 'integer', default: 0, maximum: 280 }, description: 'Long-poll: if nothing matches, wait up to this many seconds and return as soon as a matching Grok message exists.' }],
          responses: { 200: { description: 'OK', content: { 'application/json': { schema: { type: 'object', properties: {
            messages: { type: 'array', items: { $ref: '#/components/schemas/Message' } }, next_cursor: { type: 'string', nullable: true },
            unread_total: { type: 'integer' }, has_more: { type: 'boolean' }, timed_out: { type: 'boolean' } } } } } }, 401: err } },
      },
      '/api/v1/ask': { post: { operationId: 'askGrok', summary: 'RECOMMENDED. Send a message to Grok Bot and wait for its reply. Write (sends a message).',
        description: 'Stores the message, notifies Grok Bot, then holds the request open (default 240 s, max 280 s) until Grok replies in that thread. On timeout returns reply=null, timed_out=true and next_cursor; keep waiting with GET /api/v1/messages?thread_id=...&since=<next_cursor>&wait=240. Use a client timeout of wait_seconds + 15 s.',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['text'], properties: {
          text: { type: 'string', maxLength: 20000 }, thread_id: { type: 'string' }, subject: { type: 'string', maxLength: 200 }, attachments: attIn,
          wait_seconds: { type: 'integer', default: 240, maximum: 280 }, mark_reply_read: { type: 'boolean', default: true } } } } } },
        responses: { 200: { description: 'Reply received, or timed out', content: { 'application/json': { schema: { type: 'object', properties: {
          message: { $ref: '#/components/schemas/Message' }, reply: { oneOf: [{ $ref: '#/components/schemas/Message' }, { type: 'null' }] },
          timed_out: { type: 'boolean' }, thread_id: { type: 'string' }, next_cursor: { type: 'string' } } } } } }, 400: err, 401: err, 404: err, 413: err } } },
      '/api/v1/files/{attachment_id}': { get: { operationId: 'downloadAttachment', summary: 'Download an attachment\'s raw bytes. Read.',
        parameters: [{ name: 'attachment_id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'File bytes', content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } }, 401: err, 404: err } } },
      '/api/v1/messages/read': { post: { operationId: 'markMessagesRead', summary: 'Mark messages from Grok Bot as read. Write (routine, not sensitive).',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', description: 'Provide exactly one field.', properties: {
          message_ids: { type: 'array', items: { type: 'string' } }, thread_id: { type: 'string' }, up_to_cursor: { type: 'string' } } } } } },
        responses: { 200: { description: 'OK', content: { 'application/json': { schema: { type: 'object', properties: { marked_read: { type: 'integer' }, message_ids: { type: 'array', items: { type: 'string' } } } } } } }, 400: err, 401: err } } },
      '/api/v1/threads': { get: { operationId: 'listThreads', summary: 'List recent conversations, newest first. Read.',
        parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer', default: 20, maximum: 100 } }],
        responses: { 200: { description: 'OK' }, 401: err } } },
      '/api/v1/threads/{thread_id}': { get: { operationId: 'getThread', summary: 'Get one conversation with all its messages, oldest first. Read.',
        parameters: [{ name: 'thread_id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { 200: { description: 'OK' }, 401: err, 404: err } } },
    },
  };
}
