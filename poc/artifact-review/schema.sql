-- Orbit artifact review POC — isolated tables. Prefix poc_ keeps them separable from inbox data.
CREATE TABLE IF NOT EXISTS poc_articles (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  canonical_path TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS poc_revisions (
  id TEXT PRIMARY KEY,
  article_id TEXT NOT NULL,
  number INTEGER NOT NULL,
  markdown TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  source TEXT NOT NULL,          -- seed | feedback | workflow
  workflow TEXT,
  request_id TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (article_id, number)
);
CREATE INDEX IF NOT EXISTS idx_poc_rev_article ON poc_revisions(article_id, number DESC);

CREATE TABLE IF NOT EXISTS poc_events (
  id TEXT PRIMARY KEY,
  article_id TEXT NOT NULL,
  request_id TEXT,
  role TEXT NOT NULL,            -- user | agent | system
  text TEXT NOT NULL,
  meta TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_poc_events_article ON poc_events(article_id, created_at);

CREATE TABLE IF NOT EXISTS poc_requests (
  id TEXT PRIMARY KEY,
  article_id TEXT NOT NULL,
  base_revision_id TEXT NOT NULL,
  kind TEXT NOT NULL,            -- feedback | workflow
  workflow TEXT,
  text TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL,          -- submitted | working | needs_input | completed | failed | stale
  reply TEXT,
  error TEXT,
  worker TEXT,
  created_at TEXT NOT NULL,
  claimed_at TEXT,
  completed_at TEXT,
  UNIQUE (article_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_poc_requests_status ON poc_requests(status, created_at);

CREATE TABLE IF NOT EXISTS poc_images (
  id TEXT PRIMARY KEY,
  article_id TEXT NOT NULL,
  request_id TEXT,
  filename TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  data BLOB NOT NULL,
  include_flag INTEGER NOT NULL DEFAULT 1,
  instruction TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_poc_images_article ON poc_images(article_id, created_at);

CREATE TABLE IF NOT EXISTS poc_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
