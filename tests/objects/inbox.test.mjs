import test from 'node:test';
import assert from 'node:assert/strict';
import { makeDb } from './d1-shim.mjs';
import {
  userPrincipal, ensureWorkspace, createInboxItem, listInbox, getInboxItem,
  patchInboxSelections, submitInboxDecision, claimAction, completeAction, closeInboxItem,
} from '../../worker/objects/service.ts';
import { backfillInbox, reconcileInbox, queueForBridge } from '../../worker/objects/migrate.ts';
import { handleObjectsApi } from '../../worker/objects/api.ts';

const principal = userPrincipal();

async function fresh() {
  const db = makeDb();
  await ensureWorkspace(db);
  return db;
}

test('message and decision use the inbox domain and preserve list ordering', async () => {
  const db = await fresh();
  const message = await createInboxItem(db, principal, { type: 'message', title: 'FYI', body: 'Read this' });
  const decision = await createInboxItem(db, principal, {
    type: 'decision', title: 'Choose', body: 'Pick one', choices: ['Ship', 'Wait'], instruction: '',
  });
  assert.equal(message.item.type, 'message');
  assert.equal(decision.item.type, 'decision');
  const list = await listInbox(db, principal);
  assert.equal(list.active.length, 2);
  assert.deepEqual(new Set(list.active.map((x) => x.type)), new Set(['message', 'decision']));
});

test('selections are drafts; submit creates exactly one idempotent agent action', async () => {
  const db = await fresh();
  const made = await createInboxItem(db, principal, {
    type: 'decision', title: 'Deploy?', body: 'Production is ready', choices: ['Deploy', 'Hold'], instruction: '',
  });
  const id = made.item.id;
  const draft = await patchInboxSelections(db, principal, id, { choices: ['Deploy'], instruction: 'Watch errors' });
  assert.deepEqual(draft.item.selections, ['Deploy']);
  assert.equal(db.raw.prepare('SELECT COUNT(*) n FROM obj_agent_actions').get().n, 0);

  const first = await submitInboxDecision(db, principal, id, { idempotencyKey: 'client-a' });
  const again = await submitInboxDecision(db, principal, id, { choices: ['Hold'], idempotencyKey: 'client-b' });
  assert.equal(first.duplicate, false);
  assert.equal(again.duplicate, true);
  assert.equal(again.actionId, first.actionId);
  assert.equal(db.raw.prepare("SELECT COUNT(*) n FROM obj_agent_actions WHERE action = 'inbox.decision'").get().n, 1);
  const input = JSON.parse(db.raw.prepare('SELECT input_json FROM obj_agent_actions').get().input_json);
  assert.deepEqual(input, { choices: ['Deploy'], instruction: 'Watch errors', object_id: id });
});

test('generic queue claims and completes an inbox decision into outbox', async () => {
  const db = await fresh();
  const made = await createInboxItem(db, principal, {
    type: 'decision', title: 'Deploy?', body: 'Production is ready', choices: ['Deploy'],
  });
  const sent = await submitInboxDecision(db, principal, made.item.id, { choices: ['Deploy'] });
  const queue = await queueForBridge(db, principal);
  assert.equal(queue.length, 1);
  assert.equal(queue[0].action, 'inbox.decision');
  assert.deepEqual(queue[0].choices, ['Deploy']);
  const sentClaim = await claimAction(db, principal, sent.actionId, 'test-bridge');
  assert.equal(sentClaim.ok, true);
  await completeAction(db, principal, sent.actionId, { reply: 'Deployed', token: sentClaim.token });
  const item = await getInboxItem(db, principal, made.item.id);
  assert.equal(item.status, 'completed');
  const list = await listInbox(db, principal);
  assert.equal(list.active.length, 0);
  assert.equal(list.outbox.length, 1);
});

test('dismiss moves an informational message to outbox without an action', async () => {
  const db = await fresh();
  const made = await createInboxItem(db, principal, { type: 'message', title: 'FYI', body: 'Done' });
  await closeInboxItem(db, principal, made.item.id, 'dismissed');
  const list = await listInbox(db, principal);
  assert.equal(list.active.length, 0);
  assert.equal(list.outbox[0].status, 'outbox');
  assert.equal(db.raw.prepare('SELECT COUNT(*) n FROM obj_agent_actions').get().n, 0);
});

test('backfill imports only open cards, is idempotent, and never executes checked boxes', async () => {
  const db = await fresh();
  const insert = db.raw.prepare(`INSERT INTO cards
    (orbit_id, kind, folder, title, body, actions_json, instruction, created_at, created_precision,
     status, source_path, content_hash, outbox, excluded, deleted, synced_at)
    VALUES (?, 'handoff', 'active', ?, ?, ?, NULL, ?, 'datetime', ?, ?, ?, ?, 0, 0, ?)`);
  const at = '2026-11-14T20:00:00.000Z';
  insert.run('open-card', 'Open', 'Choose', JSON.stringify([
    { label: 'Already checked', checked: true }, { label: 'Still open', checked: false },
  ]), at, 'pending', '00.01/open.md', 'hash-open', 0, at);
  insert.run('outbox-card', 'Old', 'History', '[]', at, 'outbox', '00.04/old.md', 'hash-old', 1, at);

  const first = await backfillInbox(db, principal);
  const second = await backfillInbox(db, principal);
  assert.equal(first.counts.eligible, 1);
  assert.equal(second.counts.eligible, 1);
  assert.equal(db.raw.prepare("SELECT COUNT(*) n FROM obj_objects WHERE legacy_table = 'cards'").get().n, 1);
  assert.equal(db.raw.prepare("SELECT COUNT(*) n FROM obj_agent_actions WHERE action = 'inbox.decision'").get().n, 0);
  const recon = await reconcileInbox(db, principal);
  assert.equal(recon.ok, true);
  assert.equal(recon.imported_actions, 0);
});

test('ongoing cards projection never overwrites an object-managed decision', async () => {
  const db = await fresh();
  const at = '2026-11-14T20:00:00.000Z';
  db.raw.prepare(`INSERT INTO cards
    (orbit_id, kind, folder, title, body, actions_json, instruction, created_at, created_precision,
     status, source_path, content_hash, outbox, excluded, deleted, synced_at)
    VALUES ('managed-card', 'handoff', 'active', 'Managed', 'Choose', ?, NULL, ?, 'datetime',
      'pending', '00.01/managed.md', 'hash-managed', 0, 0, 0, ?)`)
    .run(JSON.stringify([{ label: 'Run', checked: false }]), at, at);
  await backfillInbox(db, principal);
  const item = await getInboxItem(db, principal, 'managed-card');
  const submitted = await submitInboxDecision(db, principal, item.id, { choices: ['Run'] });
  const sync = await backfillInbox(db, principal);
  assert.equal(sync.managed, 1);
  assert.equal((await getInboxItem(db, principal, item.id)).status, 'submitted');
  const submittedClaim = await claimAction(db, principal, submitted.actionId, 'test');
  await completeAction(db, principal, submitted.actionId, { reply: 'Ran', token: submittedClaim.token });
  await backfillInbox(db, principal);
  assert.equal((await getInboxItem(db, principal, item.id)).status, 'completed');
});

test('ongoing cards projection moves an imported item to outbox without importing outbox history', async () => {
  const db = await fresh();
  const at = '2026-11-14T20:00:00.000Z';
  db.raw.prepare(`INSERT INTO cards
    (orbit_id, kind, folder, title, body, actions_json, instruction, created_at, created_precision,
     status, source_path, content_hash, outbox, excluded, deleted, synced_at)
    VALUES ('moving-card', 'handoff', 'active', 'Moving', 'Body', '[]', NULL, ?, 'datetime',
      'pending', '00.01/moving.md', 'hash-moving', 0, 0, 0, ?)`).run(at, at);
  await backfillInbox(db, principal);
  db.raw.prepare(`UPDATE cards SET outbox = 1, status = 'outbox', folder = 'outbox', completed_at = ?
    WHERE orbit_id = 'moving-card'`).run(at);
  const sync = await backfillInbox(db, principal);
  assert.equal(sync.written.terminal_updates, 1);
  assert.equal((await getInboxItem(db, principal, 'moving-card')).outbox, true);
  const recon = await reconcileInbox(db, principal);
  assert.equal(recon.ok, true);
});

test('v1 inbox routes create, list, patch, submit idempotently, dismiss, and close', async () => {
  const db = await fresh();
  const env = { ORBIT_OBJECTS_DB: db };
  const call = async (method, path, body) => {
    const url = new URL('https://orbit.test/api/v1' + path);
    const request = new Request(url, {
      method, headers: body ? { 'content-type': 'application/json', origin: url.origin } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const response = await handleObjectsApi(request, env, url, { authed: true });
    return { status: response.status, body: await response.json() };
  };
  const made = await call('POST', '/inbox', {
    type: 'decision', title: 'Choose', body: 'Pick', choices: ['A', 'B'], instruction: '',
  });
  assert.equal(made.status, 201);
  const id = made.body.item.id;
  assert.equal((await call('GET', '/inbox')).body.active.length, 1);
  assert.equal((await call('PATCH', `/inbox/${id}/selections`, { choices: ['A'] })).status, 200);
  const submitted = await call('POST', `/inbox/${id}/submit`, { idempotencyKey: 'api-1' });
  const duplicate = await call('POST', `/inbox/${id}/submit`, { idempotencyKey: 'api-2' });
  assert.equal(submitted.status, 200);
  assert.equal(duplicate.body.duplicate, true);
  assert.equal(duplicate.body.actionId, submitted.body.actionId);

  const msg = await call('POST', '/inbox', { type: 'message', title: 'FYI', body: 'Info' });
  assert.equal((await call('POST', `/inbox/${msg.body.item.id}/dismiss`, {})).status, 200);
  const another = await call('POST', '/inbox', { type: 'message', title: 'Close', body: 'Info' });
  assert.equal((await call('POST', `/inbox/${another.body.item.id}/close`, {})).status, 200);
  assert.equal((await call('GET', '/inbox?scope=outboxed')).body.items.length, 2);
});
