// Keep in sync with schema.sql (idempotent DDL).
export const SCHEMA_SQL = String.raw`CREATE TABLE IF NOT EXISTS threads (
  id text PRIMARY KEY,
  subject text,
  started_by text NOT NULL CHECK (started_by IN ('muse','grok')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS messages (
  id bigserial PRIMARY KEY,
  thread_id text NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  sender text NOT NULL CHECK (sender IN ('muse','grok')),
  text text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz,
  webhook_status text
);
CREATE INDEX IF NOT EXISTS messages_thread_idx ON messages(thread_id, id);
CREATE INDEX IF NOT EXISTS messages_unread_idx ON messages(sender, id) WHERE read_at IS NULL;
CREATE TABLE IF NOT EXISTS attachments (
  id text PRIMARY KEY,
  message_id bigint NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  filename text NOT NULL,
  content_type text NOT NULL,
  size integer NOT NULL,
  sha256 text NOT NULL,
  data bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS attachments_message_idx ON attachments(message_id);
CREATE INDEX IF NOT EXISTS messages_grok_thread_idx ON messages(thread_id, id) WHERE sender = 'grok';
`;
