import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDb } from './d1-shim.mjs';
import {
  ensureWorkspace, createObject, submitFeedback, claimAction, heartbeatAction,
  progressAction, completeAction, failAction, artifactState, listActions,
} from '../../worker/objects/service.ts';
import { queueForBridge } from '../../worker/objects/migrate.ts';
import { KINDS, LEASE_MS } from '../../worker/objects/types.ts';

const WS = 'ws_ken';
const principal = { kind: 'agent', id: 'openclaw', workspaceId: WS, scopes: ['agent', 'artifacts'] };

async function seeded() {
  const db = makeDb();
  await ensureWorkspace(db);
  const obj = await createObject(db, principal, {
    kind: KINDS.artifact, externalId: 'art-1', title: 'Art', data: { canonical_path: 'a.md' },
  });
  const rev = await db.prepare(
    `INSERT INTO obj_revisions (id, object_id, number, content, content_hash, source, actor, created_at)
     VALUES ('rev_1', ?, 1, '# V1', 'h', 'seed', 'ken', '2026-11-16T00:00:00.000Z')`,
  ).bind(obj.id).run();
  assert.ok(rev);
  await db.prepare('UPDATE obj_objects SET current_revision_id = ? WHERE id = ?').bind('rev_1', obj.id).run();
  return { db, objectId: obj.id };
}

async function queued(db) {
  const req = await submitFeedback(db, principal, 'art-1', {
    idempotencyKey: `idem-${Math.random()}`, text: 'tighten it', baseRevisionId: 'rev_1',
  });
  assert.equal(req.ok, true);
  return req.requestId;
}

test('claim returns a fencing token and a short lease', async () => {
  const { db } = await seeded();
  const id = await queued(db);
  const claim = await claimAction(db, principal, id, 'bridge-a');
  assert.equal(claim.ok, true);
  assert.ok(claim.token);
  const ttl = new Date(claim.leaseExpiresAt).valueOf() - Date.now();
  assert.ok(ttl > 0 && ttl <= LEASE_MS + 1000, `lease ${ttl}ms`);
  assert.equal(claim.attempt, 1);
  assert.equal(claim.maxAttempts, 3);
});

test('a competing worker cannot claim a live action', async () => {
  const { db } = await seeded();
  const id = await queued(db);
  assert.equal((await claimAction(db, principal, id, 'a')).ok, true);
  assert.equal((await claimAction(db, principal, id, 'b')).ok, false);
});

test('heartbeat renews the lease and is rejected for a foreign token', async () => {
  const { db } = await seeded();
  const id = await queued(db);
  const claim = await claimAction(db, principal, id, 'a');
  const beat = await heartbeatAction(db, principal, id, claim.token);
  assert.equal(beat.ok, true);
  assert.ok(new Date(beat.leaseExpiresAt).valueOf() >= new Date(claim.leaseExpiresAt).valueOf());
  assert.equal((await heartbeatAction(db, principal, id, 'not-the-token')).reason, 'claim_lost');
});

test('an expired lease is swept and re-queued with a cleared token', async () => {
  const { db } = await seeded();
  const id = await queued(db);
  await claimAction(db, principal, id, 'a');
  await db.prepare("UPDATE obj_agent_actions SET lease_expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").bind(id).run();
  const queue = await queueForBridge(db, principal, 5);
  assert.equal(queue.length, 1);
  assert.equal(queue[0].status, 'stale');
  const row = await db.prepare('SELECT claim_token, lease_expires_at FROM obj_agent_actions WHERE id = ?').bind(id).first();
  assert.equal(row.claim_token, null);
});

test('a worker that lost its claim cannot complete or publish', async () => {
  const { db } = await seeded();
  const id = await queued(db);
  const first = await claimAction(db, principal, id, 'a');
  await db.prepare("UPDATE obj_agent_actions SET lease_expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").bind(id).run();
  await queueForBridge(db, principal, 5);            // sweep
  const second = await claimAction(db, principal, id, 'b');
  assert.equal(second.ok, true);

  const staleComplete = await completeAction(db, principal, id, { reply: 'from a', token: first.token });
  assert.equal(staleComplete.ok, false);
  assert.equal(staleComplete.reason, 'claim_lost');
  const currentComplete = await completeAction(db, principal, id, { reply: 'from b', token: second.token });
  assert.equal(currentComplete.ok, true);
});

test('completion is idempotent and rejects an unclaimed action', async () => {
  const { db } = await seeded();
  const id = await queued(db);
  const unclaimed = await completeAction(db, principal, id, { reply: 'x' });
  assert.equal(unclaimed.ok, false);
  assert.equal(unclaimed.reason, 'invalid_transition');
  const claim = await claimAction(db, principal, id, 'a');
  assert.equal((await completeAction(db, principal, id, { reply: 'x', token: claim.token })).ok, true);
  const again = await completeAction(db, principal, id, { reply: 'x', token: claim.token });
  assert.equal(again.ok, true);
  assert.equal(again.duplicate, true);
});

test('progress is fenced to the live claim', async () => {
  const { db } = await seeded();
  const id = await queued(db);
  const claim = await claimAction(db, principal, id, 'a');
  const ok = await progressAction(db, principal, id, { status: 'working', token: claim.token });
  assert.equal(ok.ok, true);
  const foreign = await progressAction(db, principal, id, { status: 'working', token: 'other' });
  assert.equal(foreign.ok, false);
  assert.equal(foreign.reason, 'claim_lost');
});

test('retryable failure schedules a backoff instead of an instant re-run', async () => {
  const { db } = await seeded();
  const id = await queued(db);
  const claim = await claimAction(db, principal, id, 'a');
  const failed = await failAction(db, principal, id, 'boom', true, claim.token);
  assert.equal(failed.ok, true);
  assert.equal(failed.status, 'stale');
  const wait = new Date(failed.nextAttemptAt).valueOf() - Date.now();
  assert.ok(wait > 0, 'next attempt must be in the future');
  const queue = await queueForBridge(db, principal, 5);
  assert.equal(queue.length, 0, 'backed-off action must not be picked up immediately');
});

test('attempts are capped and the terminal failure stays queryable', async () => {
  const { db } = await seeded();
  const id = await queued(db);
  for (let i = 0; i < 3; i++) {
    await db.prepare("UPDATE obj_agent_actions SET next_attempt_at = NULL WHERE id = ?").bind(id).run();
    const claim = await claimAction(db, principal, id, 'a');
    if (!claim.ok) break;
    await failAction(db, principal, id, 'boom', true, claim.token);
  }
  const row = await db.prepare('SELECT status, attempts FROM obj_agent_actions WHERE id = ?').bind(id).first();
  assert.equal(row.status, 'failed');
  assert.equal(row.attempts, 3);
  await db.prepare("UPDATE obj_agent_actions SET next_attempt_at = NULL WHERE id = ?").bind(id).run();
  assert.equal((await claimAction(db, principal, id, 'a')).ok, false);
});

test('history is scoped to the authenticated principal workspace', async () => {
  const db = makeDb();
  await ensureWorkspace(db);
  const other = { kind: 'agent', id: 'other', workspaceId: 'ws_other', scopes: ['agent'] };
  await ensureWorkspace(db, { id: 'ws_other', slug: 'other', name: 'Other' });
  const obj = await createObject(db, principal, {
    kind: KINDS.artifact, externalId: 'art-1', title: 'Art', data: {},
  });
  await db.prepare(
    `INSERT INTO obj_objects (id, workspace_id, kind, external_id, title, status, data_json, created_at, updated_at)
     VALUES ('msg_other', ?, 'note.message', 'm1', 'x', 'active', ?, '2026-11-16T00:00:00.000Z', '2026-11-16T00:00:00.000Z')`,
  ).bind('ws_other', JSON.stringify({ artifact_id: obj.id, text: 'other workspace secret' })).run();
  const req = await submitFeedback(db, principal, 'art-1', { idempotencyKey: 'k1', text: 'go' });
  const queue = await queueForBridge(db, principal, 5);
  const entry = queue.find((q) => q.id === req.requestId);
  assert.ok(entry);
  assert.equal(entry.history.some((h) => /other workspace secret/.test(h.text)), false);
});
