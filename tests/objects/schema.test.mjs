import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const SQL = readFileSync(new URL('../../migrations/objects/0001_objects_core.sql', import.meta.url), 'utf8');

function fresh() {
  const db = new DatabaseSync(':memory:');
  db.exec(SQL);
  return db;
}

const now = new Date('2026-11-14T12:00:00.000Z').toISOString();

function seedWorkspace(db, id = 'ws_ken', slug = 'ken') {
  db.prepare('INSERT INTO obj_workspaces (id, slug, name, created_at) VALUES (?, ?, ?, ?)')
    .run(id, slug, 'Ken', now);
  return id;
}

function seedObject(db, overrides = {}) {
  const row = {
    id: 'obj_1',
    workspace_id: 'ws_ken',
    kind: 'artifact',
    external_id: 'obsidian-value',
    slug: 'obsidian-value',
    title: 'Obsidian value',
    status: 'active',
    data_json: '{}',
    created_at: now,
    updated_at: now,
    ...overrides,
  };
  db.prepare(`INSERT INTO obj_objects
      (id, workspace_id, kind, external_id, slug, title, status, data_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(row.id, row.workspace_id, row.kind, row.external_id, row.slug, row.title,
      row.status, row.data_json, row.created_at, row.updated_at);
  return row;
}

test('schema creates only obj_ tables', () => {
  const db = fresh();
  const tables = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  ).all().map((r) => r.name);
  assert.ok(tables.length >= 7, `expected the core tables, got ${tables.join(',')}`);
  for (const name of tables) assert.match(name, /^obj_/, `unexpected table ${name}`);
  assert.deepEqual(tables, [
    'obj_agent_actions', 'obj_events', 'obj_meta', 'obj_objects',
    'obj_relationships', 'obj_revisions', 'obj_workspaces',
  ]);
});

test('schema is idempotent', () => {
  const db = fresh();
  db.exec(SQL);
  db.exec(SQL);
  const version = db.prepare("SELECT v FROM obj_meta WHERE k='schema_version'").get().v;
  assert.equal(version, '0001');
});

test('workspace slugs are unique', () => {
  const db = fresh();
  seedWorkspace(db);
  assert.throws(() => seedWorkspace(db, 'ws_other', 'ken'), /UNIQUE|constraint/i);
});

test('object identity is unique per workspace and kind', () => {
  const db = fresh();
  seedWorkspace(db);
  seedObject(db);
  assert.throws(
    () => seedObject(db, { id: 'obj_2', slug: 'other-slug' }),
    /UNIQUE|constraint/i,
  );
  // The same external id in another workspace is a different object.
  seedWorkspace(db, 'ws_two', 'two');
  seedObject(db, { id: 'obj_3', workspace_id: 'ws_two' });
  const count = db.prepare('SELECT COUNT(*) c FROM obj_objects').get().c;
  assert.equal(count, 2);
});

test('objects without an external id do not collide', () => {
  const db = fresh();
  seedWorkspace(db);
  seedObject(db, { id: 'a', external_id: null, slug: 'a' });
  seedObject(db, { id: 'b', external_id: null, slug: 'b' });
  assert.equal(db.prepare('SELECT COUNT(*) c FROM obj_objects').get().c, 2);
});

test('revision numbers are unique per object', () => {
  const db = fresh();
  seedWorkspace(db);
  seedObject(db);
  const insert = db.prepare(
    'INSERT INTO obj_revisions (id, object_id, number, content, content_hash, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  insert.run('r1', 'obj_1', 1, 'v1', 'hash1', 'seed', now);
  assert.throws(() => insert.run('r2', 'obj_1', 1, 'v1b', 'hash2', 'feedback', now), /UNIQUE|constraint/i);
  insert.run('r3', 'obj_1', 2, 'v2', 'hash3', 'feedback', now);
  const latest = db.prepare(
    'SELECT number FROM obj_revisions WHERE object_id = ? ORDER BY number DESC LIMIT 1',
  ).get('obj_1').number;
  assert.equal(latest, 2);
});

test('relationships are unique per from/to/relation and indexed both ways', () => {
  const db = fresh();
  seedWorkspace(db);
  seedObject(db);
  seedObject(db, { id: 'obj_2', external_id: 'note-1', slug: 'note-1', kind: 'note' });
  const insert = db.prepare(
    'INSERT INTO obj_relationships (id, workspace_id, from_object_id, to_object_id, relation, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  );
  insert.run('rel1', 'ws_ken', 'obj_1', 'obj_2', 'cites', now);
  assert.throws(() => insert.run('rel2', 'ws_ken', 'obj_1', 'obj_2', 'cites', now), /UNIQUE|constraint/i);
  const backlinks = db.prepare(
    'SELECT COUNT(*) c FROM obj_relationships WHERE to_object_id = ?',
  ).get('obj_2').c;
  assert.equal(backlinks, 1);
});

test('agent actions are idempotent per workspace key', () => {
  const db = fresh();
  seedWorkspace(db);
  const insert = db.prepare(`INSERT INTO obj_agent_actions
      (id, workspace_id, agent, action, status, idempotency_key, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`);
  insert.run('a1', 'ws_ken', 'felix', 'revise', 'queued', 'key-1', now);
  assert.throws(
    () => insert.run('a2', 'ws_ken', 'felix', 'revise', 'queued', 'key-1', now),
    /UNIQUE|constraint/i,
  );
  insert.run('a3', 'ws_ken', 'felix', 'revise', 'queued', null, now);
  insert.run('a4', 'ws_ken', 'felix', 'revise', 'queued', null, now);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM obj_agent_actions').get().c, 3);
});

test('events are append-only and accept a null object', () => {
  const db = fresh();
  const insert = db.prepare(
    'INSERT INTO obj_events (id, workspace_id, object_id, type, actor, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  insert.run('e1', 'ws_ken', null, 'workspace.created', 'ken', '{}', now);
  insert.run('e2', 'ws_ken', 'obj_1', 'object.created', 'felix', '{"kind":"artifact"}', now);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM obj_events').get().c, 2);
});

test('deleting an object does not cascade or corrupt other tables', () => {
  const db = fresh();
  seedWorkspace(db);
  seedObject(db);
  db.prepare(
    'INSERT INTO obj_revisions (id, object_id, number, content, content_hash, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run('r1', 'obj_1', 1, 'v1', 'hash1', 'seed', now);
  db.prepare('DELETE FROM obj_objects WHERE id = ?').run('obj_1');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM obj_revisions').get().c, 1);
});

test('migration contains no destructive statement against live tables', () => {
  assert.doesNotMatch(SQL, /DROP\s+TABLE/i);
  assert.doesNotMatch(SQL, /DELETE\s+FROM/i);
  assert.doesNotMatch(SQL, /ALTER\s+TABLE\s+(cards|actions|events|poc_)/i);
});
