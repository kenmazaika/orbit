import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveStorageMode, storageFlagName, storageSummary, STORAGE_MODES } from '../../worker/objects/flags.js';

test('missing env defaults to legacy', () => {
  assert.equal(resolveStorageMode(undefined, 'inbox'), 'legacy');
  assert.equal(resolveStorageMode(null, 'inbox'), 'legacy');
});

test('unset flag defaults to legacy', () => {
  assert.equal(resolveStorageMode({}, 'inbox'), 'legacy');
});

test('explicit legacy stays legacy', () => {
  assert.equal(resolveStorageMode({ ORBIT_STORAGE_INBOX: 'legacy' }, 'inbox'), 'legacy');
});

test('shadow without the D1 binding falls back to legacy', () => {
  assert.equal(resolveStorageMode({ ORBIT_STORAGE_INBOX: 'shadow' }, 'inbox'), 'legacy');
});

test('shadow with the D1 binding is honoured', () => {
  assert.equal(
    resolveStorageMode({ ORBIT_STORAGE_INBOX: 'shadow', ORBIT_OBJECTS_DB: {} }, 'inbox'),
    'shadow',
  );
});

test('objects with the D1 binding is honoured', () => {
  assert.equal(
    resolveStorageMode({ ORBIT_STORAGE_INBOX: 'objects', ORBIT_OBJECTS_DB: {} }, 'inbox'),
    'objects',
  );
});

test('unknown values fall back to legacy', () => {
  for (const value of ['', 'on', 'true', 'd1', 'OBJECTS_NOW', '  ']) {
    assert.equal(resolveStorageMode({ ORBIT_STORAGE_INBOX: value, ORBIT_OBJECTS_DB: {} }, 'inbox'), 'legacy');
  }
});

test('case and whitespace are tolerated', () => {
  assert.equal(
    resolveStorageMode({ ORBIT_STORAGE_INBOX: '  OBJECTS  ', ORBIT_OBJECTS_DB: {} }, 'inbox'),
    'objects',
  );
});

test('unknown feature shapes are legacy', () => {
  for (const feature of ['', ' ', '9lives', 'in box', null, undefined, 7]) {
    assert.equal(resolveStorageMode({ ORBIT_OBJECTS_DB: {} }, feature), 'legacy');
  }
});

test('flag names are derived deterministically', () => {
  assert.equal(storageFlagName('inbox'), 'ORBIT_STORAGE_INBOX');
  assert.equal(storageFlagName('artifact-review'), 'ORBIT_STORAGE_ARTIFACT_REVIEW');
  assert.equal(storageFlagName('  Reports '), 'ORBIT_STORAGE_REPORTS');
  assert.equal(storageFlagName(''), null);
});

test('a hostile env never throws', () => {
  const hostile = new Proxy({}, {
    get() { throw new Error('boom'); },
  });
  assert.equal(resolveStorageMode(hostile, 'inbox'), 'legacy');
});

test('summary covers each feature independently', () => {
  const env = { ORBIT_STORAGE_INBOX: 'shadow', ORBIT_OBJECTS_DB: {} };
  assert.deepEqual(storageSummary(env, ['inbox', 'artifacts']), {
    inbox: 'shadow',
    artifacts: 'legacy',
  });
});

test('mode list is the documented set', () => {
  assert.deepEqual([...STORAGE_MODES], ['legacy', 'shadow', 'objects']);
});
