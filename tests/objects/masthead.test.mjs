import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDb } from './d1-shim.mjs';
import {
  ensureWorkspace, createObject, createRevision, addAsset, setActiveMasthead, artifactState,
  submitFeedback, listRevisions, recordPublication, publicationView,
} from '../../worker/objects/service.ts';
import { queueForBridge } from '../../worker/objects/migrate.ts';
import { KINDS, workflowResultKind } from '../../worker/objects/types.ts';

const principal = { kind: 'agent', id: 'openclaw', workspaceId: 'ws_ken', scopes: ['agent', 'artifacts'] };
const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);

async function seeded() {
  const db = makeDb();
  await ensureWorkspace(db);
  const obj = await createObject(db, principal, {
    kind: KINDS.artifact, externalId: 'art_m', title: 'Art', data: { canonical_path: 'a.md' },
  });
  await createRevision(db, principal, obj.id, { content: '---\ntitle: T\n---\n\n# H\n\nBody.', source: 'seed', id: 'rev_1' });
  return { db, objectId: obj.id };
}

test('a masthead asset is active and distinct from inline images', async () => {
  const { db } = await seeded();
  const mh = await addAsset(db, principal, 'art_m', {
    filename: 'masthead.png', mime: 'image/png', bytes: png, role: 'masthead', provider: 'grok',
  });
  const inline = await addAsset(db, principal, 'art_m', { filename: 'chart.png', mime: 'image/png', bytes: png });
  assert.equal(mh.role, 'masthead');
  assert.equal(mh.state, 'active');
  assert.equal(inline.role, 'auto');
  const state = await artifactState(db, principal, 'art_m');
  assert.equal(state.masthead.id, mh.id);
  assert.equal(state.masthead.provider, 'grok');
  assert.equal(state.mastheadCandidates.length, 1);
  assert.ok(state.images.every((i) => i.id !== mh.id), 'masthead must not appear as an inline image');
});

test('at most one active masthead; replacing supersedes but keeps history', async () => {
  const { db } = await seeded();
  const a = await addAsset(db, principal, 'art_m', { filename: 'a.png', mime: 'image/png', bytes: png, role: 'masthead' });
  const b = await addAsset(db, principal, 'art_m', { filename: 'b.png', mime: 'image/png', bytes: png, role: 'masthead' });
  const state = await artifactState(db, principal, 'art_m');
  assert.equal(state.masthead.id, b.id, 'newest generation becomes active');
  assert.equal(state.mastheadCandidates.length, 2, 'previous masthead stays as history');
  const historical = state.mastheadCandidates.find((x) => x.id === a.id);
  assert.equal(historical.state, 'historical');

  const active = await db.prepare(
    "SELECT COUNT(*) AS n FROM obj_assets WHERE object_id = ? AND asset_state = 'active'",
  ).bind(state.masthead.id ? (await db.prepare('SELECT object_id FROM obj_assets WHERE id = ?').bind(b.id).first()).object_id : '').first();
  assert.equal(active.n, 1);

  // Re-selecting an older candidate swaps the active one without deleting anything.
  const swap = await setActiveMasthead(db, principal, 'art_m', a.id);
  assert.equal(swap.ok, true);
  assert.equal(swap.masthead.id, a.id);
  const after = await artifactState(db, principal, 'art_m');
  assert.equal(after.mastheadCandidates.filter((x) => x.state === 'active').length, 1);
  assert.equal(after.mastheadCandidates.length, 2);
});

test('masthead changes never create a document revision', async () => {
  const { db, objectId } = await seeded();
  const before = (await listRevisions(db, principal, objectId)).length;
  await addAsset(db, principal, 'art_m', { filename: 'a.png', mime: 'image/png', bytes: png, role: 'masthead' });
  await addAsset(db, principal, 'art_m', { filename: 'b.png', mime: 'image/png', bytes: png, role: 'masthead' });
  const after = (await listRevisions(db, principal, objectId)).length;
  assert.equal(after, before);
});

test('a non-masthead asset cannot become the active masthead', async () => {
  const { db } = await seeded();
  const inline = await addAsset(db, principal, 'art_m', { filename: 'x.png', mime: 'image/png', bytes: png });
  const res = await setActiveMasthead(db, principal, 'art_m', inline.id);
  assert.equal(res.error, 'not_a_masthead');
});

test('workflow result kinds include asset and publication', () => {
  assert.equal(workflowResultKind('generate-masthead'), 'asset');
  assert.equal(workflowResultKind('publish-post'), 'publication');
  assert.equal(workflowResultKind('blog-author'), 'revision');
  assert.equal(workflowResultKind('blog-critic'), 'review');
});

test('queue maps masthead and publish workflows to their own handlers', async () => {
  const { db } = await seeded();
  const mh = await addAsset(db, principal, 'art_m', { filename: 'a.png', mime: 'image/png', bytes: png, role: 'masthead' });
  const m = await submitFeedback(db, principal, 'art_m', {
    kind: 'workflow', workflow: 'generate-masthead', idempotencyKey: 'k-mh',
    options: { approach: 'reference', provider: 'grok', referenceAssetId: mh.id },
  });
  const p = await submitFeedback(db, principal, 'art_m', {
    kind: 'workflow', workflow: 'publish-post', idempotencyKey: 'k-pub',
    options: { destination: 'notes-from-the-loop' },
  });
  const queue = await queueForBridge(db, principal, 5);
  const mine = queue.find((q) => q.id === m.requestId);
  const pub = queue.find((q) => q.id === p.requestId);
  assert.equal(mine.action, 'artifact.masthead');
  assert.equal(mine.options.approach, 'reference');
  assert.equal(mine.masthead.id, mh.id);
  assert.equal(pub.action, 'artifact.publish');
});

test('publication records upsert per artifact and keep the URL', async () => {
  const { db } = await seeded();
  const first = await recordPublication(db, principal, 'art_m', {
    status: 'published', url: 'https://example.com/a', revisionId: 'rev_1',
  });
  assert.equal(first.ok, true);
  assert.equal(first.publication.url, 'https://example.com/a');
  const second = await recordPublication(db, principal, 'art_m', {
    status: 'updated', url: 'https://example.com/a', revisionId: 'rev_1',
  });
  assert.equal(second.publication.id, first.publication.id, 'one record per artifact');
  const rows = await db.prepare(
    "SELECT COUNT(*) AS n FROM obj_objects WHERE kind = 'orbit.publication'",
  ).first();
  assert.equal(rows.n, 1);
  const state = await artifactState(db, principal, 'art_m');
  assert.equal(state.publication.url, 'https://example.com/a');
  assert.equal(state.publication.status, 'updated');
});
