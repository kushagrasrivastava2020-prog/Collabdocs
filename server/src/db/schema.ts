/**
 * Database schema. Statements are idempotent so they can run on every boot
 * (a real deployment would use a migration tool; this keeps the project dependency-light).
 */
export const SCHEMA_SQL = /* sql */ `
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  color         TEXT NOT NULL,
  is_guest      BOOLEAN NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS documents (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL DEFAULT 'Untitled document',
  owner_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Monotonic per-document counter for the op log. Incrementing it takes a row lock,
  -- which serialises appends per document so committed seqs never have gaps.
  update_seq  BIGINT NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS documents_owner_idx ON documents(owner_id);

CREATE TABLE IF NOT EXISTS document_members (
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role        TEXT NOT NULL CHECK (role IN ('viewer', 'commenter', 'editor')),
  added_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (document_id, user_id)
);
CREATE INDEX IF NOT EXISTS document_members_user_idx ON document_members(user_id);

CREATE TABLE IF NOT EXISTS share_links (
  token       TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  role        TEXT NOT NULL CHECK (role IN ('viewer', 'commenter', 'editor')),
  created_by  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS share_links_doc_idx ON share_links(document_id);

-- Append-only operation log: every row is a (merged) binary Yjs update.
CREATE TABLE IF NOT EXISTS doc_updates (
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  seq         BIGINT NOT NULL,
  data        BYTEA NOT NULL,
  user_id     TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (document_id, seq)
);

-- Snapshots: full encoded Yjs state covering every op-log row with seq <= snapshot.seq.
-- They make loading O(snapshot + tail) and double as version-history checkpoints.
CREATE TABLE IF NOT EXISTS doc_snapshots (
  id          TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  seq         BIGINT NOT NULL,
  state       BYTEA NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('auto', 'manual', 'restore')),
  label       TEXT,
  created_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS doc_snapshots_doc_seq_idx ON doc_snapshots(document_id, seq DESC);

CREATE TABLE IF NOT EXISTS comments (
  id          TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  parent_id   TEXT REFERENCES comments(id) ON DELETE CASCADE,
  author_id   TEXT REFERENCES users(id) ON DELETE SET NULL,
  body        TEXT NOT NULL,
  -- { from, to: base64 Yjs RelativePosition, quote: string } for top-level comments
  anchor      JSONB,
  resolved    BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS comments_doc_idx ON comments(document_id);
`
