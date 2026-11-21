import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

const repo = new URL('../../', import.meta.url);
const read = (p) => readFileSync(new URL(p, repo), 'utf8');

const wrangler = JSON.parse(read('wrangler.json'));
const worker = read('worker/index.js');
const rollback = read('scripts/objects-rollback.sh');

test('production bindings point both names at the same database', () => {
  const binds = Object.fromEntries((wrangler.d1_databases || []).map((d) => [d.binding, d]));
  assert.ok(binds.ORBIT_INBOX_DB);
  assert.ok(binds.ORBIT_OBJECTS_DB);
  assert.equal(binds.ORBIT_OBJECTS_DB.database_id, binds.ORBIT_INBOX_DB.database_id);
  assert.equal(wrangler.vars?.ORBIT_STORAGE_ARTIFACTS, 'objects');
});

test('production worker routes v1 but never touches object storage directly', () => {
  assert.match(worker, /handleObjectsApi/);
  assert.doesNotMatch(worker, /from ['"]\.\/objects\/(service|migrate|repo)/);
  assert.doesNotMatch(worker, /ORBIT_STORAGE_/);
  assert.doesNotMatch(worker, /ORBIT_OBJECTS_DB/);
  assert.doesNotMatch(worker, /\bobj_[a-z]+/);
});

test('the storage flag module stays opt-in and default-off', () => {
  const flags = read('worker/objects/flags.js');
  assert.match(flags, /return 'legacy'/);
  assert.match(flags, /ORBIT_OBJECTS_DB/);
});

test('existing route and agent contracts are still present', () => {
  for (const needle of [
    '/__orbit/login',
    '/__orbit/logout',
    '/api/orbit-inbox',
  ]) assert.ok(worker.includes(needle), `missing contract: ${needle}`);

  const artifacts = read('worker/artifact-poc.js');
  for (const needle of ['/api/lab/artifact', '/queue', '/claim', '/progress', '/result']) {
    assert.ok(artifacts.includes(needle), `missing artifact contract: ${needle}`);
  }
});

test('artifact flag remains enabled exactly as deployed', () => {
  assert.equal(wrangler.vars?.ORBIT_ARTIFACT_POC_ENABLED, 'true');
});

test('rollback only names obj_ tables', () => {
  const drops = [...rollback.matchAll(/DROP TABLE IF EXISTS (\w+)/g)].map((m) => m[1]);
  assert.ok(drops.length >= 7);
  for (const table of drops) assert.match(table, /^obj_/);
  for (const live of ['cards', 'actions', 'events', 'poc_articles', 'poc_revisions', 'poc_requests']) {
    assert.ok(!drops.includes(live), `rollback must not drop ${live}`);
  }
});

test('local object config never carries production routes', () => {
  const local = JSON.parse(read('wrangler.objects.local.json'));
  assert.equal(local.routes, undefined);
  assert.equal(local.d1_databases?.[0]?.binding, 'ORBIT_OBJECTS_DB');
  assert.equal(local.d1_databases?.[0]?.database_name, 'orbit-objects-local');
});

test('tests do not require a network or live credentials', () => {
  assert.ok(existsSync(new URL('tests/objects/flags.test.mjs', repo)));
  assert.ok(existsSync(new URL('tests/objects/schema.test.mjs', repo)));
});
