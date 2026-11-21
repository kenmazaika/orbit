import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDb, seedLegacy } from './d1-shim.mjs';
import {
  userPrincipal, artifactState, artifactList, submitFeedback, claimAction,
  createRevision, completeAction, getObjectByExternal, listActions,
} from '../../worker/objects/service.ts';
import { backfillArtifacts, reconcileArtifacts, exportLegacy, queueForBridge } from '../../worker/objects/migrate.ts';
import { ensureWorkspace } from '../../worker/objects/service.ts';

const principal = userPrincipal();

async function seeded() {
  const db = makeDb();
  seedLegacy(db);
  await ensureWorkspace(db);
  const report = await backfillArtifacts(db, principal);
  return { db, report };
}

test('backfill maps every artifact, revision, event, and request', async () => {
  const { db, report } = await seeded();
  assert.equal(report.counts.articles, 1);
  assert.equal(report.counts.revisions, 2);
  assert.equal(report.counts.requests, 1);
  assert.equal(report.written.messages, 1);
  const state = await artifactState(db, principal, 'obsidian-value');
  assert.equal(state.article.id, 'obsidian-value');
  assert.equal(state.currentNumber, 2);
  assert.equal(state.revisions.length, 2);
  assert.deepEqual(state.revisions.map((r) => r.number), [1, 2]);
  assert.equal(state.events[0].text, 'First feedback');
});

test('backfill is idempotent', async () => {
  const { db, report } = await seeded();
  const second = await backfillArtifacts(db, principal);
  assert.equal(second.written.objects, report.written.objects);
  const rows = db.raw.prepare('SELECT COUNT(*) c FROM obj_revisions').get().c;
  assert.equal(rows, 2);
  const recon = await reconcileArtifacts(db, principal);
  assert.equal(recon.ok, true);
});

test('artifact list keeps legacy ids and closed state', async () => {
  const { db } = await seeded();
  const list = await artifactList(db, principal);
  assert.equal(list.length, 1);
  assert.equal(list[0].id, 'obsidian-value');
  assert.equal(list[0].current_number, 2);
  assert.equal(list[0].closed_at, null);
});

test('feedback produces a pending action, relations, and is idempotent', async () => {
  const { db } = await seeded();
  const first = await submitFeedback(db, principal, 'obsidian-value', {
    text: 'Cut the second section', idempotencyKey: 'k1', baseRevisionId: 'rev_2',
  });
  assert.equal(first.duplicate, false);
  const again = await submitFeedback(db, principal, 'obsidian-value', {
    text: 'Cut the second section', idempotencyKey: 'k1', baseRevisionId: 'rev_2',
  });
  assert.equal(again.duplicate, true);
  assert.equal(again.requestId, first.requestId);
  const rels = db.raw.prepare('SELECT relation FROM obj_relationships WHERE from_object_id = ?').all(first.requestId);
  assert.ok(rels.some((r) => r.relation === 'targets'));
  assert.ok(rels.some((r) => r.relation === 'references'));
});

test('stale base revision is rejected', async () => {
  const { db } = await seeded();
  const res = await submitFeedback(db, principal, 'obsidian-value', {
    text: 'stale', idempotencyKey: 'k2', baseRevisionId: 'rev_1',
  });
  assert.equal(res.error, 'stale_base');
});

test('agent workflow: claim, publish V3, complete', async () => {
  const { db } = await seeded();
  const f = await submitFeedback(db, principal, 'obsidian-value', {
    text: 'Add a closing line', idempotencyKey: 'k3', baseRevisionId: 'rev_2',
  });
  const queue = await queueForBridge(db, principal);
  assert.equal(queue.length, 1);
  assert.equal(queue[0].base.id, 'rev_2');
  // One seeded message plus the feedback just submitted — user turns are written to the conversation.
  assert.equal(queue[0].history.length, 2);

  const claimed = await claimAction(db, principal, f.requestId, 'felix-local');
  assert.equal(claimed.ok, true);
  const second = await claimAction(db, principal, f.requestId, 'other');
  assert.equal(second.ok, false);

  const object = await getObjectByExternal(db, principal, 'orbit.artifact', 'obsidian-value');
  const rev = await createRevision(db, principal, object.id, {
    content: '# V3', source: 'feedback', expectedRevisionId: 'rev_2',
  });
  assert.equal(rev.revision.number, 3);

  const conflict = await createRevision(db, principal, object.id, {
    content: '# V4', expectedRevisionId: 'rev_2',
  });
  assert.equal(conflict.error, 'conflict');

  await completeAction(db, principal, f.requestId, { reply: 'Added', revisionId: rev.revision.id, token: claimed.token });
  const after = await artifactState(db, principal, 'obsidian-value');
  assert.equal(after.currentNumber, 3);
  assert.equal(after.activeRequest, null);
});

test('agent revision id makes bridge retries idempotent after a restart', async () => {
  const { db } = await seeded();
  const object = await getObjectByExternal(db, principal, 'orbit.artifact', 'obsidian-value');
  const first = await createRevision(db, principal, object.id, {
    id: 'revision_action_req_retry', content: '# V3 retry-safe', source: 'feedback', expectedRevisionId: 'rev_2',
  });
  const retry = await createRevision(db, principal, object.id, {
    id: 'revision_action_req_retry', content: '# V3 retry-safe', source: 'feedback', expectedRevisionId: 'rev_2',
  });
  assert.equal(first.duplicate, false);
  assert.equal(retry.duplicate, true);
  assert.equal(retry.revision.id, first.revision.id);
  assert.equal(db.raw.prepare("SELECT COUNT(*) n FROM obj_revisions WHERE id = 'revision_action_req_retry'").get().n, 1);
});

test('workspace isolation: another workspace sees nothing', async () => {
  const { db } = await seeded();
  const other = { kind: 'user', id: 'other', workspaceId: 'ws_other', scopes: ['*'] };
  await ensureWorkspace(db, { id: 'ws_other', slug: 'other', name: 'Other' });
  assert.equal(await artifactState(db, other, 'obsidian-value'), null);
  assert.deepEqual(await artifactList(db, other), []);
  assert.deepEqual(await listActions(db, other), []);
});

test('export back to legacy preserves object-model revisions and actions', async () => {
  const { db } = await seeded();
  const object = await getObjectByExternal(db, principal, 'orbit.artifact', 'obsidian-value');
  await createRevision(db, principal, object.id, { content: '# V3 object', source: 'agent' });
  const out = await exportLegacy(db, principal);
  assert.equal(out.exported.artifacts, 1);
  assert.equal(out.exported.revisions, 3);
  const row = db.raw.prepare('SELECT markdown FROM poc_revisions WHERE number = 3').get();
  assert.equal(row.markdown, '# V3 object');
});
