// Orbit Work — agent-led sessions that start from an observation and end in a result.
// Additive domain on the existing object model: sessions/messages/plans/interactions are
// obj_objects rows, execution is obj_agent_actions, and the bridge is the only consumer.

import { first, all, run, stmt, batch, type Db } from './repo.ts';
import { nowIso, uuid, json, clampText } from './types.ts';
import { completeAction } from './service.ts';
import type { Principal } from './service.ts';

export const WORK_KINDS = Object.freeze({
  session: 'orbit.work',
  message: 'orbit.work_message',
  plan: 'orbit.work_plan',
  interaction: 'orbit.work_interaction',
  brief: 'orbit.work_brief',
});

export const WORK_STATES = Object.freeze([
  'preparing', 'awaiting_direction', 'working', 'exploring', 'awaiting_feedback',
  'awaiting_authorization', 'awaiting_manual', 'blocked', 'completed', 'cancelled',
]);

const ACTIVE_ACTION = ['pending', 'claimed', 'working', 'needs_input'];
const TERMINAL_ACTION = ['completed', 'failed', 'stale', 'cancelled'];

const ok = (data: any, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
});
const bad = (code: string, status = 400, extra: any = {}) => ok({ error: code, ...extra }, status);

function parse(value: any, fallback: any = {}) {
  try { return typeof value === 'string' ? JSON.parse(value) : (value || fallback); } catch { return fallback; }
}

function clean(value: any, max = 20000) {
  return clampText(String(value ?? ''), max);
}

function workId() {
  return `work_${uuid().replace(/-/g, '').slice(0, 12)}`;
}

async function sessionRow(db: Db, principal: Principal, idOrExternal: string) {
  return first(db,
    `SELECT * FROM obj_objects
      WHERE workspace_id = ? AND kind = ? AND deleted_at IS NULL
        AND (id = ? OR external_id = ? OR slug = ?) LIMIT 1`,
    principal.workspaceId, WORK_KINDS.session, idOrExternal, idOrExternal, idOrExternal);
}

function hydrate(row: any) {
  if (!row) return null;
  return {
    id: row.id,
    externalId: row.external_id || row.slug || row.id,
    title: row.title,
    status: row.status,
    data: parse(row.data_json, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function sessionView(row: any) {
  const s = hydrate(row);
  if (!s) return null;
  const d = s.data;
  return {
    id: s.externalId,
    objectId: s.id,
    title: s.title,
    goal: d.goal || '',
    state: d.state || 'preparing',
    mode: d.mode === 'explore' ? 'explore' : 'guided',
    pendingMode: d.pending_mode === 'explore' ? 'explore' : (d.pending_mode === 'guided' ? 'guided' : null),
    briefId: d.brief_id || null,
    attention: Boolean(d.attention),
    lastActivity: d.last_activity || s.updatedAt,
    genesis: d.genesis || null,
    planId: d.plan_id || null,
    activeActionId: d.active_action_id || null,
    feedbackPending: Boolean(d.feedback_pending),
    result: d.result || null,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
}

async function touch(db: Db, session: any, patch: any) {
  const data = { ...(session.data || {}), ...patch, last_activity: nowIso() };
  await run(db,
    'UPDATE obj_objects SET data_json = ?, updated_at = ? WHERE id = ?',
    JSON.stringify(data), nowIso(), session.id);
  session.data = data;
  return data;
}

async function appendMessage(db: Db, principal: Principal, session: any, msg: {
  role: 'user' | 'agent' | 'system'; text: string; kind?: string;
  interactionId?: string | null; planId?: string | null; actionId?: string | null;
}) {
  const id = uuid();
  const at = nowIso();
  const text = clean(msg.text, 40000);
  const data = {
    session_id: session.id,
    role: msg.role,
    text,
    kind: msg.kind || 'message',
    interaction_id: msg.interactionId || null,
    plan_id: msg.planId || null,
    action_id: msg.actionId || null,
  };
  await run(db,
    `INSERT INTO obj_objects (id, workspace_id, kind, external_id, title, status, data_json, created_at, updated_at, created_by)
     VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
    id, principal.workspaceId, WORK_KINDS.message, id, text.slice(0, 120) || '(message)',
    JSON.stringify(data), at, at, principal.id);
  await run(db,
    `INSERT INTO obj_relationships (id, workspace_id, from_object_id, to_object_id, relation, metadata_json, created_at)
     VALUES (?, ?, ?, ?, 'belongs_to', '{}', ?)`, uuid(), principal.workspaceId, id, session.id, at);
  await run(db,
    `INSERT INTO obj_events (id, workspace_id, object_id, type, actor, payload_json, created_at)
     VALUES (?, ?, ?, 'work.message', ?, ?, ?)`,
    uuid(), principal.workspaceId, session.id, principal.id,
    JSON.stringify({ message_id: id, role: msg.role, kind: data.kind }), at);
  return { id, ...data, createdAt: at };
}

async function messageRows(db: Db, principal: Principal, sessionId: string) {
  return all(db,
    `SELECT m.* FROM obj_objects m
       JOIN obj_relationships r ON r.from_object_id = m.id AND r.relation = 'belongs_to'
      WHERE m.workspace_id = ? AND m.kind = ? AND m.deleted_at IS NULL AND r.to_object_id = ?
      ORDER BY m.created_at ASC, m.id ASC`,
    principal.workspaceId, WORK_KINDS.message, sessionId);
}

async function planRows(db: Db, principal: Principal, sessionId: string) {
  return all(db,
    `SELECT p.* FROM obj_objects p
       JOIN obj_relationships r ON r.from_object_id = p.id AND r.relation = 'belongs_to'
      WHERE p.workspace_id = ? AND p.kind = ? AND p.deleted_at IS NULL AND r.to_object_id = ?
      ORDER BY p.created_at ASC`,
    principal.workspaceId, WORK_KINDS.plan, sessionId);
}

async function interactionRows(db: Db, principal: Principal, sessionId: string) {
  return all(db,
    `SELECT i.* FROM obj_objects i
       JOIN obj_relationships r ON r.from_object_id = i.id AND r.relation = 'belongs_to'
      WHERE i.workspace_id = ? AND i.kind = ? AND i.deleted_at IS NULL AND r.to_object_id = ?
      ORDER BY i.created_at ASC`,
    principal.workspaceId, WORK_KINDS.interaction, sessionId);
}

function modeOf(session: any) {
  return session?.data?.mode === 'explore' ? 'explore' : 'guided';
}

async function briefRows(db: Db, principal: Principal, sessionId: string) {
  return all(db,
    `SELECT b.* FROM obj_objects b
       JOIN obj_relationships r ON r.from_object_id = b.id AND r.relation = 'belongs_to'
      WHERE b.workspace_id = ? AND b.kind = ? AND b.deleted_at IS NULL AND r.to_object_id = ?
      ORDER BY b.created_at ASC`,
    principal.workspaceId, WORK_KINDS.brief, sessionId);
}

function briefView(row: any) {
  const d = parse(row.data_json, {});
  return {
    id: row.external_id || row.id,
    objectId: row.id,
    revision: Number(d.revision || 1),
    content: d.content || {},
    createdAt: row.created_at,
  };
}

function listOf(value: any, maxItems = 20, maxLen = 500, objects = false) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value.slice(0, maxItems)) {
    if (item && typeof item === 'object') {
      const text = clean(item.text || item.value || item.label || '', maxLen);
      if (!text) continue;
      const status = ['established', 'tentative', 'rejected', 'hypothesis'].includes(item.status) ? item.status : 'established';
      out.push(objects ? { text, status } : text);
    } else {
      const text = clean(item, maxLen);
      if (text) out.push(text);
    }
  }
  return out;
}

function normalizeBrief(brief: any) {
  const b = brief && typeof brief === 'object' ? brief : {};
  return {
    working_thesis: clean(b.working_thesis || b.emerging_thesis || b.thesis || '', 2000),
    tension: clean(b.tension || '', 2000),
    angle: clean(b.angle || b.current_direction || b.direction || '', 2000),
    evidence: listOf(b.evidence || b.context, 8, 400),
    decisions: listOf(b.decisions, 12, 400, true),
    unresolved: listOf(b.unresolved || b.open_questions || b.questions, 8, 400),
    not_pursuing: listOf(b.not_pursuing, 8, 400),
    reader_takeaway: clean(b.reader_takeaway || '', 2000),
    boundaries: listOf(b.boundaries || b.constraints, 8, 400),
  };
}

async function saveBrief(db: Db, principal: Principal, session: any, brief: any) {
  const content = normalizeBrief(brief);
  const hash = await sha256Hex(JSON.stringify(content));
  const rows = await briefRows(db, principal, session.id);
  const latest = rows[rows.length - 1];
  if (latest) {
    const d = parse(latest.data_json, {});
    if (d.hash === hash) return briefView(latest);
  }
  const at = nowIso();
  const id = uuid();
  const revision = latest ? Number(parse(latest.data_json, {}).revision || rows.length) + 1 : 1;
  await run(db,
    `INSERT INTO obj_objects (id, workspace_id, kind, external_id, title, status, data_json, created_at, updated_at, created_by)
     VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
    id, principal.workspaceId, WORK_KINDS.brief, id,
    content.working_thesis || content.tension || 'Working brief',
    JSON.stringify({ session_id: session.id, revision, content, hash }), at, at, principal.id);
  await run(db, `INSERT INTO obj_relationships (id, workspace_id, from_object_id, to_object_id, relation, metadata_json, created_at)
    VALUES (?, ?, ?, ?, 'belongs_to', '{}', ?)`, uuid(), principal.workspaceId, id, session.id, at);
  if (latest) {
    await run(db, `INSERT INTO obj_relationships (id, workspace_id, from_object_id, to_object_id, relation, metadata_json, created_at)
      VALUES (?, ?, ?, ?, 'supersedes', '{}', ?)`, uuid(), principal.workspaceId, id, latest.id, at);
  }
  await touch(db, session, { brief_id: id, brief_updated_at: at });
  await run(db, `INSERT INTO obj_events (id, workspace_id, object_id, type, actor, payload_json, created_at)
    VALUES (?, ?, ?, 'work.brief', ?, ?, ?)`, uuid(), principal.workspaceId, session.id, principal.id,
    JSON.stringify({ brief_id: id, revision }), at);
  return { id, objectId: id, revision, content, createdAt: at };
}

function planView(row: any) {
  const d = parse(row.data_json, {});
  return {
    id: row.external_id || row.id,
    objectId: row.id,
    revision: Number(d.revision || 1),
    goal: d.goal || '',
    rationale: d.rationale || '',
    status: d.status || 'proposed',
    steps: Array.isArray(d.steps) ? d.steps : [],
    createdAt: row.created_at,
  };
}

function interactionView(row: any) {
  const d = parse(row.data_json, {});
  return {
    id: row.external_id || row.id,
    objectId: row.id,
    type: d.type || 'collaboration',
    prompt: d.prompt || '',
    context: d.context || '',
    options: Array.isArray(d.options) ? d.options : [],
    state: d.state || 'open',
    response: d.response || null,
    payload: d.payload || null,
    createdAt: row.created_at,
  };
}

function messageView(row: any) {
  const d = parse(row.data_json, {});
  return {
    id: row.external_id || row.id,
    role: d.role || 'system',
    text: d.text || '',
    kind: d.kind || 'message',
    interactionId: d.interaction_id || null,
    planId: d.plan_id || null,
    actionId: d.action_id || null,
    createdAt: row.created_at,
  };
}

function actionView(row: any) {
  if (!row) return null;
  const input = parse(row.input_json, {});
  return {
    id: row.id, status: row.status, action: row.action,
    mode: input.mode || null, reply: row.reply || '', error: row.error || null,
    createdAt: row.created_at, claimedAt: row.started_at || null, completedAt: row.completed_at || null,
    attempts: Number(row.attempts || 0), maxAttempts: Number(row.max_attempts || 3),
  };
}

async function actionsFor(db: Db, principal: Principal, sessionId: string) {
  return all(db,
    `SELECT * FROM obj_agent_actions WHERE workspace_id = ? AND object_id = ?
      ORDER BY created_at DESC`, principal.workspaceId, sessionId);
}

async function createAction(db: Db, principal: Principal, session: any, mode: 'plan' | 'execute' | 'explore', input: any, idem: string) {
  const actionId = uuid();
  const at = nowIso();
  try {
    await run(db,
      `INSERT INTO obj_agent_actions
        (id, workspace_id, object_id, agent, action, status, idempotency_key, input_json, created_at, request_kind, workflow)
       VALUES (?, ?, ?, 'openclaw', ?, 'pending', ?, ?, ?, 'work', NULL)`,
      actionId, principal.workspaceId, session.id, `work.${mode}`,
      `${session.externalId}:${mode}:${idem}`, JSON.stringify({ mode, ...input }), at);
  } catch (error: any) {
    if (/UNIQUE|constraint/i.test(String(error?.message))) {
      const existing: any = await first(db,
        'SELECT id FROM obj_agent_actions WHERE workspace_id = ? AND idempotency_key = ?',
        principal.workspaceId, `${session.externalId}:${mode}:${idem}`);
      return existing?.id || null;
    }
    throw error;
  }
  await touch(db, session, {
    active_action_id: actionId,
    state: mode === 'plan' ? 'preparing' : (mode === 'explore' ? 'exploring' : 'working'),
    attention: false,
  });
  await run(db,
    `INSERT INTO obj_events (id, workspace_id, object_id, type, actor, payload_json, created_at)
     VALUES (?, ?, ?, 'work.action', ?, ?, ?)`,
    uuid(), principal.workspaceId, session.id, principal.id,
    JSON.stringify({ action_id: actionId, mode }), at);
  return actionId;
}

// ---------------------------------------------------------------- services ---

export async function createWork(db: Db, principal: Principal, input: any) {
  const genesis = input?.genesis && typeof input.genesis === 'object' ? input.genesis : null;
  const message = clean(input?.message || '', 20000).trim();
  if (!genesis && !message) return { error: 'genesis_or_message_required' as const };

  const idem = String(input?.idempotencyKey || '').trim();
  if (idem) {
    const hit: any = await first(db, 'SELECT v FROM obj_meta WHERE k = ?', `work_create:${principal.workspaceId}:${idem}`);
    if (hit?.v) {
      const existing = await sessionRow(db, principal, String(hit.v));
      if (existing) return { work: sessionView(existing), duplicate: true };
    }
  }

  const externalId = workId();
  const title = clean(input?.title || genesis?.title || message.split('\n')[0] || 'Work session', 160).trim() || 'Work session';
  const at = nowIso();
  const snapshot = genesis ? clean(genesis.snapshot || genesis.content || '', 60000) : '';
  const mode = input?.mode === 'explore' ? 'explore' : 'guided';
  const data = {
    goal: clean(input?.goal || genesis?.summary || message, 4000),
    mode,
    state: mode === 'explore' ? 'exploring' : 'preparing',
    genesis: genesis ? {
      type: String(genesis.type || 'note'),
      ref: String(genesis.ref || genesis.slug || ''),
      title: String(genesis.title || title),
      url: String(genesis.url || ''),
      snapshot,
      snapshot_hash: await sha256Hex(snapshot),
      captured_at: at,
    } : { type: 'blank', ref: '', title, url: '', snapshot: message, snapshot_hash: await sha256Hex(message), captured_at: at },
    plan_id: null,
    active_action_id: null,
    feedback_pending: false,
    attention: true,
    result: null,
    last_activity: at,
  };

  await batch(db, [
    stmt(db,
      `INSERT INTO obj_objects (id, workspace_id, kind, external_id, slug, title, status, data_json, created_at, updated_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
      uuid(), principal.workspaceId, WORK_KINDS.session, externalId, externalId, title,
      JSON.stringify(data), at, at, principal.id),
  ]);

  const row = await sessionRow(db, principal, externalId);
  if (!row) return { error: 'create_failed' as const };
  const session = hydrate(row);
  // The genesis message is the first user turn.
  if (message || genesis) {
    await appendMessage(db, principal, session, {
      role: genesis && !message ? 'system' : 'user',
      text: message || `Started from: ${genesis?.title || genesis?.ref || 'source'}`,
      kind: 'genesis',
    });
  }
  if (mode === 'explore') await createAction(db, principal, session, 'explore', { reason: 'genesis' }, idem || uuid());
  else await createAction(db, principal, session, 'plan', { reason: 'genesis' }, idem || uuid());
  if (idem) await run(db, 'INSERT OR REPLACE INTO obj_meta (k, v) VALUES (?, ?)', `work_create:${principal.workspaceId}:${idem}`, externalId);
  const fresh = await sessionRow(db, principal, externalId);
  return { work: sessionView(fresh) };
}

async function sha256Hex(text: string) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function listWork(db: Db, principal: Principal) {
  const rows = await all(db,
    `SELECT * FROM obj_objects WHERE workspace_id = ? AND kind = ? AND deleted_at IS NULL
      ORDER BY updated_at DESC LIMIT 100`, principal.workspaceId, WORK_KINDS.session);
  const out = [];
  for (const row of rows) {
    const view: any = sessionView(row);
    const msgs = await messageRows(db, principal, row.id);
    const last = msgs.length ? messageView(msgs[msgs.length - 1]) : null;
    out.push({ ...view, lastLine: last ? String(last.text).replace(/\s+/g, ' ').slice(0, 180) : '' });
  }
  return { work: out };
}

export async function getWork(db: Db, principal: Principal, id: string) {
  const row = await sessionRow(db, principal, id);
  if (!row) return null;
  const session = hydrate(row);
  const messages = (await messageRows(db, principal, row.id)).map(messageView);
  const plans = (await planRows(db, principal, row.id)).map(planView);
  const interactions = (await interactionRows(db, principal, row.id)).map(interactionView);
  const actions = await actionsFor(db, principal, row.id);
  const active = actions.find((a) => ACTIVE_ACTION.includes(String(a.status))) || null;
  const last = actions.find((a) => TERMINAL_ACTION.includes(String(a.status))) || null;
  const events = await all(db,
    `SELECT id, type, actor, payload_json, created_at FROM obj_events
      WHERE workspace_id = ? AND object_id = ? ORDER BY created_at ASC LIMIT 500`,
    principal.workspaceId, row.id);
  const currentPlan = session.data.plan_id
    ? plans.find((p) => p.objectId === session.data.plan_id || p.id === session.data.plan_id) || plans[plans.length - 1] || null
    : plans[plans.length - 1] || null;
  const briefs = (await briefRows(db, principal, row.id)).map(briefView);
  const currentBrief = session.data.brief_id
    ? briefs.find((b) => b.objectId === session.data.brief_id || b.id === session.data.brief_id) || briefs[briefs.length - 1] || null
    : briefs[briefs.length - 1] || null;
  return {
    work: sessionView(row),
    messages,
    plans,
    currentPlan,
    brief: currentBrief,
    briefRevision: currentBrief ? currentBrief.revision : 0,
    interactions,
    activeAction: actionView(active),
    lastAction: actionView(last),
    events: events.map((e) => ({ id: e.id, type: e.type, actor: e.actor, payload: parse(e.payload_json, {}), createdAt: e.created_at })),
  };
}

export async function postWorkMessage(db: Db, principal: Principal, id: string, input: any) {
  const row = await sessionRow(db, principal, id);
  if (!row) return { error: 'not_found' as const };
  const session = hydrate(row);
  if (session.data.state === 'cancelled') return { error: 'cancelled' as const };
  const text = clean(input?.text || '', 20000).trim();
  if (!text) return { error: 'empty_message' as const };
  if (session.data.state === 'completed') return { error: 'work_completed' as const };
  const message = await appendMessage(db, principal, session, { role: 'user', text, kind: 'feedback' });

  const actions = await actionsFor(db, principal, row.id);
  const active = actions.find((a) => ACTIVE_ACTION.includes(String(a.status))) || null;
  if (active) {
    // Honest queueing: the running tool call is not interrupted; this applies at its boundary.
    await touch(db, session, { feedback_pending: true, attention: true });
    return { message, queued: true, appliedAfter: active.id };
  }
  if (modeOf(session) === 'explore') {
    const actionId = await createAction(db, principal, session, 'explore', { reason: 'message', feedback: text }, uuid());
    return { message, actionId, queued: false };
  }
  if (['awaiting_direction', 'awaiting_feedback', 'blocked', 'awaiting_authorization', 'awaiting_manual'].includes(session.data.state)) {
    const actionId = await createAction(db, principal, session, 'execute', { reason: 'feedback', feedback: text }, uuid());
    return { message, actionId, queued: false };
  }
  return { message, queued: false };
}

export async function acceptWorkPlan(db: Db, principal: Principal, id: string, input: any) {
  const row = await sessionRow(db, principal, id);
  if (!row) return { error: 'not_found' as const };
  const session = hydrate(row);
  if (session.data.state === 'cancelled') return { error: 'cancelled' as const };
  const plans = await planRows(db, principal, row.id);
  const plan = plans[plans.length - 1];
  if (!plan) return { error: 'no_plan' as const };
  const requested = String(input?.planId || '');
  if (requested && requested !== (plan.external_id || plan.id)) return { error: 'stale_plan' as const };
  const d = parse(plan.data_json, {});
  if (d.status === 'accepted') return { ok: true, duplicate: true };
  if (session.data.state !== 'awaiting_direction') return { error: 'invalid_state' as const, state: session.data.state };

  await run(db,
    'UPDATE obj_objects SET data_json = ?, updated_at = ? WHERE id = ?',
    JSON.stringify({ ...d, status: 'accepted', accepted_at: nowIso() }), nowIso(), plan.id);
  const actionId = await createAction(db, principal, session, 'execute', {
    reason: 'plan_accepted', planId: plan.external_id || plan.id,
  }, String(input?.idempotencyKey || `accept:${plan.id}`));
  await appendMessage(db, principal, session, {
    role: 'system', text: 'Plan accepted — work started.', kind: 'plan_accepted', planId: plan.external_id || plan.id,
  });
  return { ok: true, actionId };
}

export async function respondWorkInteraction(db: Db, principal: Principal, id: string, interactionId: string, input: any) {
  const row = await sessionRow(db, principal, id);
  if (!row) return { error: 'not_found' as const };
  const session = hydrate(row);
  const rows = await interactionRows(db, principal, row.id);
  const target = rows.find((r) => (r.external_id || r.id) === interactionId || r.id === interactionId);
  if (!target) return { error: 'interaction_not_found' as const };
  const d = parse(target.data_json, {});
  if (d.state !== 'open') return { ok: true, duplicate: true, response: d.response || null };
  const response = {
    option: input?.option ? String(input.option) : null,
    text: clean(input?.text || '', 20000).trim() || null,
    at: nowIso(),
  };
  await run(db, 'UPDATE obj_objects SET data_json = ?, updated_at = ? WHERE id = ?',
    JSON.stringify({ ...d, state: 'answered', response }), nowIso(), target.id);
  await appendMessage(db, principal, session, {
    role: 'user', kind: 'interaction_response',
    text: response.text || `Chose: ${response.option || '(none)'}`,
    interactionId: target.external_id || target.id,
  });
  await touch(db, session, { attention: false, feedback_pending: true });
  // Answering an interaction always resumes the agent at a safe boundary.
  const actions = await actionsFor(db, principal, row.id);
  const active = actions.find((a) => ACTIVE_ACTION.includes(String(a.status))) || null;
  if (active) return { ok: true, queued: true, appliedAfter: active.id };
  const actionId = await createAction(db, principal, session, 'execute', {
    reason: 'interaction_response', interactionId: target.external_id || target.id,
    response: response.text || response.option,
  }, uuid());
  return { ok: true, actionId };
}

export async function cancelWork(db: Db, principal: Principal, id: string) {
  const row = await sessionRow(db, principal, id);
  if (!row) return { error: 'not_found' as const };
  const session = hydrate(row);
  if (session.data.state === 'cancelled') return { ok: true, duplicate: true };
  await run(db,
    `UPDATE obj_agent_actions SET status = 'cancelled', completed_at = ?
      WHERE workspace_id = ? AND object_id = ? AND status IN ('pending','claimed','working','needs_input')`,
    nowIso(), principal.workspaceId, row.id);
  await touch(db, session, { state: 'cancelled', active_action_id: null, attention: false, cancelled_at: nowIso() });
  await appendMessage(db, principal, session, { role: 'system', text: 'Work stopped by Ken.', kind: 'cancelled' });
  return { ok: true };
}

export async function closeWork(db: Db, principal: Principal, id: string) {
  const row = await sessionRow(db, principal, id);
  if (!row) return { error: 'not_found' as const };
  const session = hydrate(row);
  if (session.data.state === 'completed') return { ok: true, duplicate: true };
  if (session.data.state === 'cancelled') return { error: 'cancelled' as const };
  await run(db,
    `UPDATE obj_agent_actions SET status = 'cancelled', completed_at = ?
      WHERE workspace_id = ? AND object_id = ? AND status IN ('pending','claimed','working','needs_input')`,
    nowIso(), principal.workspaceId, row.id);
  const result = session.data.result || {
    summary: 'Closed by Ken — the work is done; no further action is needed.',
    links: [], verified: [], remaining: '',
  };
  await touch(db, session, {
    state: 'completed', active_action_id: null, attention: false, feedback_pending: false,
    closed_at: nowIso(), result,
  });
  await appendMessage(db, principal, session, { role: 'system', text: 'Closed by Ken.', kind: 'closed' });
  await run(db, `INSERT INTO obj_events (id, workspace_id, object_id, type, actor, payload_json, created_at)
    VALUES (?, ?, ?, 'work.closed', ?, '{}', ?)`, uuid(), principal.workspaceId, row.id, principal.id, nowIso());
  return { ok: true };
}

// ------------------------------------------------------------- modes ------

async function cancelPendingWorkActions(db: Db, principal: Principal, sessionId: string) {
  await run(db,
    `UPDATE obj_agent_actions SET status = 'cancelled', completed_at = ?
      WHERE workspace_id = ? AND object_id = ? AND status = 'pending'`,
    nowIso(), principal.workspaceId, sessionId);
}

async function applyMode(db: Db, principal: Principal, session: any, target: 'guided' | 'explore', opts: any = {}) {
  const label = target === 'explore' ? 'Explore' : 'Guided';
  await touch(db, session, {
    mode: target, pending_mode: null, pending_mode_at: null, active_action_id: null,
    mode_updated_at: nowIso(), mode_idem: opts.idem || null, attention: false,
  });
  await appendMessage(db, principal, session, {
    role: 'system', text: `Switched to ${label}.`, kind: 'mode_changed',
  });
  await run(db, `INSERT INTO obj_events (id, workspace_id, object_id, type, actor, payload_json, created_at)
    VALUES (?, ?, ?, 'work.mode_changed', ?, ?, ?)`,
    uuid(), principal.workspaceId, session.id, principal.id,
    JSON.stringify({ mode: target, from: opts.from || null, reason: opts.reason || 'user_switch' }), nowIso());
  const actions = await actionsFor(db, principal, session.id);
  const active = actions.find((a) => ACTIVE_ACTION.includes(String(a.status))) || null;
  if (target === 'guided') {
    if (!active) await createAction(db, principal, session, 'plan', { reason: opts.reason || 'mode_switch', brief: true }, opts.idem ? `${opts.idem}:plan` : uuid());
  } else {
    await touch(db, session, { state: 'exploring', feedback_pending: false });
  }
}

async function resolvePendingMode(db: Db, principal: Principal, sessionId: string) {
  const row = await sessionRow(db, principal, sessionId);
  if (!row) return null;
  const session = hydrate(row);
  const pending = session.data.pending_mode;
  if (!pending) return null;
  if (pending === modeOf(session)) { await touch(db, session, { pending_mode: null }); return null; }
  const actions = await actionsFor(db, principal, sessionId);
  if (actions.some((a) => ACTIVE_ACTION.includes(String(a.status)))) return null;
  await applyMode(db, principal, session, pending, { reason: 'pending_switch' });
  return pending;
}

export async function switchWorkMode(db: Db, principal: Principal, id: string, input: any) {
  const target = input?.mode === 'explore' ? 'explore' : (input?.mode === 'guided' ? 'guided' : null);
  if (!target) return { error: 'invalid_mode' as const };
  const row = await sessionRow(db, principal, id);
  if (!row) return { error: 'not_found' as const };
  const session = hydrate(row);
  if (['completed', 'cancelled'].includes(String(session.data.state))) return { error: 'work_closed' as const };
  const current = modeOf(session);
  if (current === target) return { ok: true, mode: current, duplicate: true };
  const idem = String(input?.idempotencyKey || '');
  if (idem && session.data.mode_idem === idem) return { ok: true, mode: current, duplicate: true };

  const actions = await actionsFor(db, principal, row.id);
  const active = actions.find((a) => ACTIVE_ACTION.includes(String(a.status))) || null;
  if (active && String(active.status) !== 'pending') {
    await touch(db, session, {
      pending_mode: target, pending_mode_at: nowIso(), attention: true, mode_idem: idem || null,
    });
    await appendMessage(db, principal, session, {
      role: 'system',
      text: `Switch to ${target === 'explore' ? 'Explore' : 'Guided'} queued — applying after the current step.`,
      kind: 'mode_pending',
    });
    return { ok: true, mode: current, pendingMode: target, pending: true };
  }
  if (active) await cancelPendingWorkActions(db, principal, row.id);
  await applyMode(db, principal, session, target, { idem, from: current, reason: 'user_switch' });
  return { ok: true, mode: target };
}

// The bridge is the only caller. It has already parsed/validated the model output.
export async function applyAgentResult(db: Db, principal: Principal, id: string, input: any) {
  const row = await sessionRow(db, principal, id);
  if (!row) return { error: 'not_found' as const };
  const session = hydrate(row);
  const actionId = String(input?.actionId || '');
  const action: any = actionId
    ? await first(db, 'SELECT * FROM obj_agent_actions WHERE id = ? AND workspace_id = ?', actionId, principal.workspaceId)
    : null;
  if (action && action.object_id !== row.id) return { error: 'action_mismatch' as const };
  if (['cancelled', 'completed'].includes(String(session.data.state))) return { error: 'work_closed' as const };

  const actionInput = action ? parse(action.input_json, {}) : {};
  const actionMode = actionInput.mode === 'explore' ? 'explore' : 'guided';
  const reply = clean(input?.reply || '', 40000).trim();

  if (actionMode === 'explore') {
    const hadFeedback = Boolean(session.data.feedback_pending);
    if (reply) {
      await appendMessage(db, principal, session, {
        role: 'agent', text: reply, kind: 'explore', actionId: actionId || null,
      });
    }
    if (input?.brief && typeof input.brief === 'object') await saveBrief(db, principal, session, input.brief);
    await touch(db, session, {
      state: 'exploring', active_action_id: null, attention: false, feedback_pending: false,
    });
    if (actionId) {
      const done: any = await completeAction(db, principal, actionId, {
        reply, token: input?.token ? String(input.token) : undefined,
      });
      if (!done.ok && done.reason !== 'not_found') console.warn('work explore complete:', done.reason);
    }
    const switched = await resolvePendingMode(db, principal, row.id);
    if (!switched && hadFeedback) {
      const fresh = hydrate(await sessionRow(db, principal, row.id));
      if (modeOf(fresh) === 'explore') {
        await createAction(db, principal, fresh, 'explore', { reason: 'queued_feedback' }, uuid());
      }
    }
    const out = await getWork(db, principal, id);
    return { ok: true, work: out?.work };
  }

  const plan = input?.plan && typeof input.plan === 'object' ? input.plan : null;
  const interaction = input?.interaction && typeof input.interaction === 'object' ? input.interaction : null;
  const result = input?.result && typeof input.result === 'object' ? input.result : null;
  const nextState = WORK_STATES.includes(String(input?.state)) ? String(input.state) : null;

  if (reply) {
    await appendMessage(db, principal, session, {
      role: 'agent', text: reply, kind: plan ? 'plan' : (result ? 'result' : 'message'), actionId: actionId || null,
    });
  }

  let planId = session.data.plan_id || null;
  if (plan) {
    const revisions = await planRows(db, principal, row.id);
    const revision = revisions.length ? Number(parse(revisions[revisions.length - 1].data_json, {}).revision || revisions.length) + 1 : 1;
    if (revisions.length) {
      await run(db, 'UPDATE obj_objects SET data_json = ?, updated_at = ? WHERE id = ?',
        JSON.stringify({ ...parse(revisions[revisions.length - 1].data_json, {}), status: 'superseded' }),
        nowIso(), revisions[revisions.length - 1].id);
    }
    const pid = uuid();
    const at = nowIso();
    const steps = Array.isArray(plan.steps) ? plan.steps.slice(0, 20).map((s: any, i: number) => ({
      id: String(s.id || `s${i + 1}`),
      title: clean(s.title || s.step || '', 300),
      detail: clean(s.detail || s.description || '', 2000),
      status: ['pending', 'active', 'done', 'blocked'].includes(String(s.status)) ? String(s.status) : 'pending',
    })) : [];
    await batch(db, [
      stmt(db,
        `INSERT INTO obj_objects (id, workspace_id, kind, external_id, title, status, data_json, created_at, updated_at, created_by)
         VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
        pid, principal.workspaceId, WORK_KINDS.plan, pid,
        clean(plan.goal || session.title, 160),
        JSON.stringify({ session_id: row.id, revision, goal: clean(plan.goal || '', 2000), rationale: clean(plan.rationale || '', 4000), steps, status: 'proposed' }),
        at, at, principal.id),
      stmt(db, `INSERT INTO obj_relationships (id, workspace_id, from_object_id, to_object_id, relation, metadata_json, created_at)
        VALUES (?, ?, ?, ?, 'belongs_to', '{}', ?)`, uuid(), principal.workspaceId, pid, row.id, at),
    ]);
    if (revisions.length) {
      await run(db, `INSERT INTO obj_relationships (id, workspace_id, from_object_id, to_object_id, relation, metadata_json, created_at)
        VALUES (?, ?, ?, ?, 'supersedes', '{}', ?)`, uuid(), principal.workspaceId, pid, revisions[revisions.length - 1].id, at);
    }
    planId = pid;
  }

  let interactionId: string | null = null;
  if (interaction && interaction.prompt) {
    const iid = uuid();
    const at = nowIso();
    const type = ['collaboration', 'authorization', 'manual'].includes(String(interaction.type)) ? String(interaction.type) : 'collaboration';
    await batch(db, [
      stmt(db,
        `INSERT INTO obj_objects (id, workspace_id, kind, external_id, title, status, data_json, created_at, updated_at, created_by)
         VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
        iid, principal.workspaceId, WORK_KINDS.interaction, iid,
        clean(interaction.prompt, 160),
        JSON.stringify({
          session_id: row.id, type, prompt: clean(interaction.prompt, 4000),
          context: clean(interaction.context || '', 8000),
          options: Array.isArray(interaction.options) ? interaction.options.slice(0, 8) : [],
          payload: interaction.payload || null, state: 'open', response: null,
        }), at, at, principal.id),
      stmt(db, `INSERT INTO obj_relationships (id, workspace_id, from_object_id, to_object_id, relation, metadata_json, created_at)
        VALUES (?, ?, ?, ?, 'belongs_to', '{}', ?)`, uuid(), principal.workspaceId, iid, row.id, at),
    ]);
    interactionId = iid;
  }

  const patch: any = { plan_id: planId, active_action_id: actionId || null };
  if (interactionId) {
    patch.attention = true;
    patch.state = ({ authorization: 'awaiting_authorization', manual: 'awaiting_manual' } as any)[String(interaction.type)] || 'awaiting_feedback';
  } else if (nextState) {
    patch.state = nextState;
    patch.attention = !['working', 'completed', 'cancelled'].includes(nextState);
  } else if (plan) {
    patch.state = 'awaiting_direction';
    patch.attention = true;
  } else {
    patch.state = 'working';
    patch.attention = false;
  }
  if (['completed', 'cancelled'].includes(String(patch.state))) patch.feedback_pending = false;
  if (result) patch.result = {
    summary: clean(result.summary || '', 6000),
    links: Array.isArray(result.links) ? result.links.slice(0, 20) : [],
    artifactId: result.artifactId || null,
    commit: result.commit || null,
    verified: Array.isArray(result.verified) ? result.verified.slice(0, 20) : [],
    remaining: clean(result.remaining || '', 4000),
    at: nowIso(),
  };
  await touch(db, session, patch);

  // Apply queued feedback only at a safe boundary: after this run completes.
  const fresh = hydrate(await sessionRow(db, principal, row.id));
  if (!fresh.data.pending_mode && fresh.data.feedback_pending && ['working', 'awaiting_feedback', 'blocked'].includes(String(fresh.data.state)) && !interactionId) {
    await touch(db, fresh, { feedback_pending: false });
    await createAction(db, principal, fresh, 'execute', { reason: 'queued_feedback' }, uuid());
  }

  if (actionId) {
    // The bridge holds the claim token; completing validates it. A stale token leaves
    // the action to lease recovery instead of publishing a result against a new claim.
    const done: any = await completeAction(db, principal, actionId, {
      reply, token: input?.token ? String(input.token) : undefined,
    });
    if (!done.ok && done.reason !== 'not_found') {
      // Result rows are already persisted; surface the claim issue instead of hiding it.
      return { ok: true, warning: done.reason || 'complete_rejected', interactionId, planId };
    }
  }
  await resolvePendingMode(db, principal, row.id);
  const out = await getWork(db, principal, id);
  return { ok: true, work: out?.work, interactionId, planId };
}

// ------------------------------------------------------------------ routing ---

export async function handleWorkApi(
  request: Request,
  ctx: { db: Db; principal: Principal; agent: Principal | null; url: URL; route: string; env?: any },
) {
  const { db, principal, agent, url, route, env } = ctx;
  if (!db) return null;
  if (route !== '/work' && !route.startsWith('/work/')) return null;

  if (route === '/work' && request.method === 'GET') return ok(await listWork(db, principal));
  if (route === '/work' && request.method === 'POST') {
    let body: any; try { body = await request.json(); } catch { return bad('bad_json'); }
    if (body.mode === 'explore' && env?.ORBIT_WORK_EXPLORE === 'false') return bad('explore_disabled', 403);
    const result = await createWork(db, principal, body);
    if ('error' in result) return bad(String((result as any).error));
    return ok(result, 201);
  }

  const one = route.match(/^\/work\/([^/]+)$/);
  if (one && request.method === 'GET') {
    const state = await getWork(db, principal, decodeURIComponent(one[1]));
    return state ? ok(state) : bad('not_found', 404);
  }

  const messages = route.match(/^\/work\/([^/]+)\/messages$/);
  if (messages && request.method === 'POST') {
    let body: any; try { body = await request.json(); } catch { return bad('bad_json'); }
    const result = await postWorkMessage(db, principal, decodeURIComponent(messages[1]), body);
    if ('error' in result) return bad(String((result as any).error), (result as any).error === 'not_found' ? 404 : 400);
    return ok(result, 201);
  }

  const modeRoute = route.match(/^\/work\/([^/]+)\/mode$/);
  if (modeRoute && request.method === 'POST') {
    let body: any; try { body = await request.json(); } catch { body = {}; }
    if (body.mode === 'explore' && env?.ORBIT_WORK_EXPLORE === 'false') return bad('explore_disabled', 403);
    const result = await switchWorkMode(db, principal, decodeURIComponent(modeRoute[1]), body);
    if ('error' in result) return bad(String((result as any).error), (result as any).error === 'not_found' ? 404 : 409);
    return ok(result);
  }

  const accept = route.match(/^\/work\/([^/]+)\/plan\/accept$/);
  if (accept && request.method === 'POST') {
    let body: any; try { body = await request.json(); } catch { body = {}; }
    const result = await acceptWorkPlan(db, principal, decodeURIComponent(accept[1]), body);
    if ('error' in result) return bad(String((result as any).error), (result as any).error === 'not_found' ? 404 : 409);
    return ok(result);
  }

  const respond = route.match(/^\/work\/([^/]+)\/interactions\/([^/]+)\/respond$/);
  if (respond && request.method === 'POST') {
    let body: any; try { body = await request.json(); } catch { body = {}; }
    const result = await respondWorkInteraction(db, principal, decodeURIComponent(respond[1]), decodeURIComponent(respond[2]), body);
    if ('error' in result) return bad(String((result as any).error), (result as any).error === 'not_found' ? 404 : 409);
    return ok(result);
  }

  const close = route.match(/^\/work\/([^/]+)\/close$/);
  if (close && request.method === 'POST') {
    const result = await closeWork(db, principal, decodeURIComponent(close[1]));
    if ('error' in result) return bad(String((result as any).error), (result as any).error === 'not_found' ? 404 : 409);
    return ok(result);
  }

  const cancel = route.match(/^\/work\/([^/]+)\/cancel$/);
  if (cancel && request.method === 'POST') {
    const result = await cancelWork(db, principal, decodeURIComponent(cancel[1]));
    if ('error' in result) return bad(String((result as any).error), 404);
    return ok(result);
  }

  const resultRoute = route.match(/^\/work\/([^/]+)\/agent-result$/);
  if (resultRoute && request.method === 'POST') {
    if (!agent) return bad('forbidden', 403);
    let body: any; try { body = await request.json(); } catch { return bad('bad_json'); }
    const result = await applyAgentResult(db, principal, decodeURIComponent(resultRoute[1]), body);
    if ('error' in result) return bad(String((result as any).error), 409);
    return ok(result);
  }

  return null;
}
