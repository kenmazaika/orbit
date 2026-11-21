// Minimal D1-compatible shim over node:sqlite, for service tests only.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

const MIGRATIONS = [
  '0001_objects_core.sql', '0002_artifacts.sql', '0003_inbox.sql', '0004_dispatches.sql',
  '0005_image_roles.sql', '0006_action_lifecycle.sql', '0007_masthead_publication.sql',
];

export function makeDb() {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = OFF');
  for (const file of ['schema.sql', 'poc/artifact-review/schema.sql']) {
    raw.exec(readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8'));
  }
  for (const file of MIGRATIONS) {
    raw.exec(readFileSync(new URL(`../../migrations/objects/${file}`, import.meta.url), 'utf8'));
  }
  const wrap = (sql, args = []) => ({
    async first() { return raw.prepare(sql).get(...normalize(args)) ?? null; },
    async all() { return { results: raw.prepare(sql).all(...normalize(args)) }; },
    async run() {
      const info = raw.prepare(sql).run(...normalize(args));
      return { meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) } };
    },
    bind(...more) { return wrap(sql, more); },
  });
  return {
    prepare(sql) { return wrap(sql); },
    async batch(statements) {
      const out = [];
      for (const s of statements) out.push(await s.run());
      return out;
    },
    raw,
  };
}

function normalize(args) {
  return args.map((a) => (a === undefined ? null : a instanceof Uint8Array ? a : a));
}

export function seedLegacy(db) {
  const raw = db.raw;
  raw.exec(`INSERT INTO poc_articles (id, title, canonical_path, created_at)
            VALUES ('obsidian-value', 'Obsidian value', 'drafts/v2.md', '2026-11-13T16:00:00.000Z')`);
  raw.exec(`INSERT INTO poc_revisions (id, article_id, number, markdown, sha256, source, created_at)
            VALUES ('rev_1', 'obsidian-value', 1, '# V1', 'hash_v1', 'seed', '2026-11-13T16:01:00.000Z')`);
  raw.exec(`INSERT INTO poc_revisions (id, article_id, number, markdown, sha256, source, created_at)
            VALUES ('rev_2', 'obsidian-value', 2, '# V2', 'hash_v2', 'feedback', '2026-11-13T17:00:00.000Z')`);
  raw.exec(`INSERT INTO poc_events (id, article_id, request_id, role, text, created_at)
            VALUES ('ev_1', 'obsidian-value', NULL, 'user', 'First feedback', '2026-11-13T16:30:00.000Z')`);
  raw.exec(`INSERT INTO poc_requests (id, article_id, base_revision_id, kind, workflow, text, idempotency_key, status, reply, worker, created_at)
            VALUES ('req_1', 'obsidian-value', 'rev_1', 'feedback', NULL, 'Tighten the intro', 'idem_1', 'completed', 'Done', 'felix-local', '2026-11-13T16:31:00.000Z')`);
}
