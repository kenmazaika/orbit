// Application services — all object-model behavior lives here.
// HTTP handlers and the agent bridge call these; nothing else writes obj_* tables.

import { first, all, run, batch, stmt, type Db } from './repo.ts';
import {
  DEFAULT_WORKSPACE, KINDS, LEGACY_ACTION_STATUS, ACTION_TO_LEGACY,
  clampText, nowIso, uuid, sha256, json, LEASE_MS, WORKFLOWS, workflowResultKind,
  MAX_ATTEMPTS, BACKOFF_BASE_MS, BACKOFF_MAX_MS,
} from './types.ts';
import { anchorFindings, splitBlocks } from './markdown-blocks.ts';

export type Principal = { kind: 'user' | 'agent'; id: string; workspaceId: string; scopes: string[] };

export function userPrincipal(workspaceId = DEFAULT_WORKSPACE.id): Principal {
  return { kind: 'user', id: 'ken', workspaceId, scopes: ['*'] };
}

export async function ensureWorkspace(db: Db, ws = DEFAULT_WORKSPACE) {
  await run(db,
    `INSERT INTO obj_workspaces (id, slug, name, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO NOTHING`,
    ws.id, ws.slug, ws.name, nowIso());
  return ws.id;
}

// ---------------------------------------------------------------- objects ---

export async function createObject(db: Db, principal: Principal, input: {
  kind: string; title: string; externalId?: string | null; slug?: string | null;
  status?: string; data?: any; createdBy?: string; legacyTable?: string | null;
}) {
  const id = input.externalId && input.kind === KINDS.artifact ? input.externalId : uuid();
  const at = nowIso();
  await run(db,
    `INSERT INTO obj_objects
      (id, workspace_id, kind, external_id, slug, title, status, data_json, created_at, updated_at, created_by, legacy_table)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO NOTHING`,
    id, principal.workspaceId, input.kind, input.externalId ?? null, input.slug ?? null,
    input.title, input.status || 'active', JSON.stringify(input.data || {}), at, at,
    input.createdBy || principal.id, input.legacyTable ?? null);
  return getObject(db, principal, id);
}

export async function getObject(db: Db, principal: Principal, id: string) {
  const row = await first(db,
    'SELECT * FROM obj_objects WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL',
    id, principal.workspaceId);
  return row ? hydrate(row) : null;
}

export async function getObjectByExternal(db: Db, principal: Principal, kind: string, externalId: string) {
  const row = await first(db,
    'SELECT * FROM obj_objects WHERE workspace_id = ? AND kind = ? AND external_id = ? AND deleted_at IS NULL',
    principal.workspaceId, kind, externalId);
  return row ? hydrate(row) : null;
}

export async function getObjectBySlug(db: Db, principal: Principal, kind: string, slug: string) {
  const row = await first(db,
    'SELECT * FROM obj_objects WHERE workspace_id = ? AND kind = ? AND slug = ? AND deleted_at IS NULL',
    principal.workspaceId, kind, slug);
  return row ? hydrate(row) : null;
}

export async function listObjects(db: Db, principal: Principal, opts: {
  kind?: string; status?: string; limit?: number; offset?: number; order?: 'asc' | 'desc';
} = {}) {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 100);
  const offset = Math.max(opts.offset ?? 0, 0);
  const where = ['workspace_id = ?', 'deleted_at IS NULL'];
  const args: any[] = [principal.workspaceId];
  if (opts.kind) { where.push('kind = ?'); args.push(opts.kind); }
  if (opts.status) { where.push('status = ?'); args.push(opts.status); }
  const dir = opts.order === 'asc' ? 'ASC' : 'DESC';
  const rows = await all(db,
    `SELECT * FROM obj_objects WHERE ${where.join(' AND ')}
     ORDER BY created_at ${dir}, id ASC LIMIT ? OFFSET ?`, ...args, limit, offset);
  return { objects: rows.map(hydrate), limit, offset };
}

export async function updateObject(db: Db, principal: Principal, id: string, patch: {
  title?: string; status?: string; data?: any;
}) {
  const current = await getObject(db, principal, id);
  if (!current) return null;
  const data = patch.data === undefined ? current.data : { ...current.data, ...patch.data };
  await run(db,
    `UPDATE obj_objects SET title = ?, status = ?, data_json = ?, updated_at = ?
     WHERE id = ? AND workspace_id = ?`,
    patch.title ?? current.title, patch.status ?? current.status,
    JSON.stringify(data), nowIso(), id, principal.workspaceId);
  return getObject(db, principal, id);
}

function hydrate(row: any) {
  return {
    id: row.id, workspaceId: row.workspace_id, kind: row.kind,
    externalId: row.external_id, slug: row.slug, title: row.title, status: row.status,
    data: json(row.data_json), createdAt: row.created_at, updatedAt: row.updated_at,
    createdBy: row.created_by, currentRevisionId: row.current_revision_id,
    revisionCount: row.revision_count, legacyTable: row.legacy_table,
  };
}

// ---------------------------------------------------------- dispatch views ---

function dispatchMetadata(input: any = {}) {
  return {
    slug: String(input.slug || '').trim(),
    summary: clampText(input.summary, 2000),
    tags: Array.isArray(input.tags)
      ? [...new Set(input.tags.map((x: any) => String(x).trim()).filter(Boolean))].slice(0, 50) : [],
    source_urls: Array.isArray(input.source_urls || input.sourceUrls)
      ? [...new Set((input.source_urls || input.sourceUrls).map((x: any) => String(x).trim()).filter(Boolean))].slice(0, 100) : [],
    author: clampText(input.author || 'Ken', 200) || 'Ken',
    published_at: input.published_at || input.publishedAt || null,
    archived_at: input.archived_at || input.archivedAt || null,
    legacy_path: input.legacy_path || input.legacyPath || null,
    idempotency_key: input.idempotency_key || input.idempotencyKey || null,
  };
}

async function dispatchRevision(db: Db, objectId: string, revisionId: string | null) {
  if (!revisionId) return null;
  return first(db,
    `SELECT id, number, content, content_hash, source, actor, created_at, status
       FROM obj_revisions WHERE id = ? AND object_id = ?`, revisionId, objectId);
}

export async function dispatchView(db: Db, principal: Principal, object: any, includeContent = true) {
  const d = object.data || {};
  const revision: any = includeContent
    ? await dispatchRevision(db, object.id, object.currentRevisionId || null) : null;
  const content = String(revision?.content || '');
  const body = content.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '');
  const minutes = Math.max(1, Math.round(body.trim().split(/\s+/).filter(Boolean).length / 210));
  return {
    id: object.id, slug: object.slug || d.slug || object.externalId, title: object.title,
    summary: d.summary || plainSummary(d.body), tags: Array.isArray(d.tags) ? d.tags : [],
    source_urls: Array.isArray(d.source_urls) ? d.source_urls : [], author: d.author || 'Ken',
    published_at: d.published_at || null, archived_at: d.archived_at || null,
    legacy_path: d.legacy_path || null, status: object.status,
    currentRevisionId: object.currentRevisionId || null,
    revisionCount: Number(object.revisionCount || 0),
    content: revision?.content ?? undefined,
    content_hash: revision?.content_hash || null,
    minutes,
    created_at: object.createdAt, updated_at: object.updatedAt,
  };
}

async function getDispatchObject(db: Db, principal: Principal, idOrSlug: string) {
  const row = await first(db,
    `SELECT * FROM obj_objects WHERE workspace_id = ? AND kind = ? AND deleted_at IS NULL
       AND (id = ? OR slug = ? OR external_id = ?) LIMIT 1`,
    principal.workspaceId, KINDS.dispatch, idOrSlug, idOrSlug, idOrSlug);
  return row ? hydrate(row) : null;
}

export async function getDispatch(db: Db, principal: Principal, idOrSlug: string) {
  const object = await getDispatchObject(db, principal, idOrSlug);
  return object ? dispatchView(db, principal, object, true) : null;
}

export async function listDispatches(db: Db, principal: Principal, opts: {
  status?: 'draft' | 'published' | 'archived'; limit?: number; offset?: number;
} = {}) {
  const status = opts.status || 'published';
  const limit = Math.min(Math.max(Number(opts.limit || 20), 1), 100);
  const offset = Math.max(Number(opts.offset || 0), 0);
  const rows = await all(db,
    `SELECT * FROM obj_objects
      WHERE workspace_id = ? AND kind = ? AND status = ? AND deleted_at IS NULL
      ORDER BY COALESCE(json_extract(data_json, '$.published_at'), created_at) DESC, id ASC
      LIMIT ? OFFSET ?`, principal.workspaceId, KINDS.dispatch, status, limit, offset);
  const total: any = await first(db,
    `SELECT COUNT(*) AS n FROM obj_objects
      WHERE workspace_id = ? AND kind = ? AND status = ? AND deleted_at IS NULL`,
    principal.workspaceId, KINDS.dispatch, status);
  const dispatches = [];
  for (const row of rows) {
    const item: any = await dispatchView(db, principal, hydrate(row), true);
    delete item.content;
    dispatches.push(item);
  }
  return { dispatches, limit, offset, total: Number(total?.n || 0), nextOffset: offset + dispatches.length < Number(total?.n || 0) ? offset + dispatches.length : null };
}

export async function createDispatchDraft(db: Db, principal: Principal, input: {
  slug: string; title: string; content: string; summary?: string; tags?: string[];
  sourceUrls?: string[]; author?: string; publishedAt?: string | null; legacyPath?: string | null;
  idempotencyKey?: string | null; source?: string; createdAt?: string;
}) {
  const slug = String(input.slug || '').trim();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) return { error: 'bad_slug' as const };
  if (!String(input.title || '').trim()) return { error: 'missing_title' as const };
  const hash = await sha256(String(input.content || ''));
  const existing = await getDispatchObject(db, principal, slug);
  if (existing) {
    const current: any = await dispatchRevision(db, existing.id, existing.currentRevisionId || null);
    if (current?.content_hash === hash) {
      return { dispatch: await dispatchView(db, principal, existing, true), duplicate: true };
    }
    return { error: 'slug_collision' as const, existingId: existing.id, currentRevisionId: existing.currentRevisionId };
  }
  const at = input.createdAt || nowIso();
  const id = uuid();
  const revisionId = uuid();
  const data = dispatchMetadata({
    slug, summary: input.summary, tags: input.tags, source_urls: input.sourceUrls,
    author: input.author, published_at: input.publishedAt || null, archived_at: null,
    legacy_path: input.legacyPath, idempotency_key: input.idempotencyKey,
  });
  await batch(db, [
    stmt(db, `INSERT INTO obj_objects
      (id, workspace_id, kind, external_id, slug, title, status, data_json, created_at, updated_at,
       created_by, current_revision_id, revision_count, legacy_table)
      VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, 1, ?)`,
      id, principal.workspaceId, KINDS.dispatch, slug, slug, clampText(input.title, 500),
      JSON.stringify(data), at, at, principal.id, revisionId, input.legacyPath ? 'src/content/notes' : null),
    stmt(db, `INSERT INTO obj_revisions
      (id, object_id, number, content, content_hash, source, actor, created_at, status)
      VALUES (?, ?, 1, ?, ?, ?, ?, ?, 'draft')`,
      revisionId, id, String(input.content || ''), hash, input.source || 'api', principal.id, at),
    stmt(db, `INSERT INTO obj_events
      (id, workspace_id, object_id, type, actor, payload_json, created_at)
      VALUES (?, ?, ?, 'dispatch.created', ?, ?, ?)`,
      uuid(), principal.workspaceId, id, principal.id, JSON.stringify({ slug }), at),
  ]);
  return { dispatch: await getDispatch(db, principal, id), duplicate: false };
}

export async function publishDispatch(db: Db, principal: Principal, idOrSlug: string, input: {
  publishedAt?: string | null; publishedFromId?: string | null;
} = {}) {
  const object = await getDispatchObject(db, principal, idOrSlug);
  if (!object) return { error: 'not_found' as const };
  if (object.status === 'archived') return { error: 'archived' as const };
  const at = object.data.published_at || input.publishedAt || nowIso();
  const data = { ...object.data, published_at: at, archived_at: null };
  if (object.status !== 'published') {
    await batch(db, [
      stmt(db, `UPDATE obj_objects SET status = 'published', data_json = ?, updated_at = ?
        WHERE id = ? AND workspace_id = ?`, JSON.stringify(data), nowIso(), object.id, principal.workspaceId),
      stmt(db, `UPDATE obj_revisions SET status = 'published' WHERE id = ? AND object_id = ?`, object.currentRevisionId, object.id),
      stmt(db, `INSERT INTO obj_events
        (id, workspace_id, object_id, type, actor, payload_json, created_at)
        VALUES (?, ?, ?, 'dispatch.published', ?, ?, ?)`,
        uuid(), principal.workspaceId, object.id, principal.id, JSON.stringify({ published_at: at }), nowIso()),
    ]);
  }
  if (input.publishedFromId) {
    await addRelation(db, principal, object.id, {
      toObjectId: input.publishedFromId, relation: 'published_from', metadata: {},
    });
  }
  return { dispatch: await getDispatch(db, principal, object.id), duplicate: object.status === 'published' };
}

export async function reviseDispatch(db: Db, principal: Principal, idOrSlug: string, input: {
  content: string; expectedRevisionId?: string | null; source?: string;
}) {
  const object = await getDispatchObject(db, principal, idOrSlug);
  if (!object) return { error: 'not_found' as const };
  if (object.status === 'archived') return { error: 'archived' as const };
  if (input.expectedRevisionId === undefined) return { error: 'expected_revision_required' as const };
  const result = await createRevision(db, principal, object.id, {
    content: String(input.content || ''), source: input.source || 'cli', actor: principal.id,
    expectedRevisionId: input.expectedRevisionId, status: object.status === 'published' ? 'published' : 'draft',
  });
  if ('error' in result) return result;
  await recordEvent(db, principal, { objectId: object.id, type: 'dispatch.revised', payload: result.revision });
  return { dispatch: await getDispatch(db, principal, object.id), revision: result.revision };
}

export async function patchDispatch(db: Db, principal: Principal, idOrSlug: string, patch: any) {
  const object = await getDispatchObject(db, principal, idOrSlug);
  if (!object) return { error: 'not_found' as const };
  const data = { ...object.data };
  if (patch.summary !== undefined) data.summary = clampText(patch.summary, 2000);
  if (patch.tags !== undefined) data.tags = dispatchMetadata({ tags: patch.tags }).tags;
  if (patch.source_urls !== undefined || patch.sourceUrls !== undefined) {
    data.source_urls = dispatchMetadata({ source_urls: patch.source_urls || patch.sourceUrls }).source_urls;
  }
  if (patch.author !== undefined) data.author = clampText(patch.author, 200) || 'Ken';
  if (patch.legacy_path !== undefined || patch.legacyPath !== undefined) data.legacy_path = patch.legacy_path ?? patch.legacyPath;
  const updated = await updateObject(db, principal, object.id, {
    title: patch.title === undefined ? object.title : clampText(patch.title, 500), data,
  });
  await recordEvent(db, principal, { objectId: object.id, type: 'dispatch.metadata.updated' });
  return { dispatch: await dispatchView(db, principal, updated, true) };
}

export async function archiveDispatch(db: Db, principal: Principal, idOrSlug: string) {
  const object = await getDispatchObject(db, principal, idOrSlug);
  if (!object) return { error: 'not_found' as const };
  if (object.status === 'draft') return { error: 'not_published' as const };
  if (object.status === 'archived') return { dispatch: await getDispatch(db, principal, object.id), duplicate: true };
  const at = nowIso();
  await updateObject(db, principal, object.id, { status: 'archived', data: { archived_at: at } });
  await recordEvent(db, principal, { objectId: object.id, type: 'dispatch.archived', payload: { archived_at: at } });
  return { dispatch: await getDispatch(db, principal, object.id), duplicate: false };
}

// -------------------------------------------------------------- revisions ---

export async function createRevision(db: Db, principal: Principal, objectId: string, input: {
  content: string; source?: string; actor?: string; expectedRevisionId?: string | null;
  id?: string; createdAt?: string; status?: string;
}) {
  const object = await getObject(db, principal, objectId);
  if (!object) return { error: 'not_found' as const };
  if (input.id) {
    const existing = await first(db,
      'SELECT id, number, content_hash, source, actor, created_at FROM obj_revisions WHERE id = ? AND object_id = ?',
      input.id, objectId);
    if (existing) return {
      revision: {
        id: existing.id, number: existing.number, sha256: existing.content_hash,
        source: existing.source, actor: existing.actor, createdAt: existing.created_at,
      }, duplicate: true,
    };
  }
  if (input.expectedRevisionId !== undefined && input.expectedRevisionId !== object.currentRevisionId) {
    return { error: 'conflict' as const, currentRevisionId: object.currentRevisionId };
  }
  const latest = await first(db,
    'SELECT number FROM obj_revisions WHERE object_id = ? ORDER BY number DESC LIMIT 1', objectId);
  const number = (latest?.number || 0) + 1;
  const id = input.id || uuid();
  const at = input.createdAt || nowIso();
  const hash = await sha256(input.content);
  const source = input.source || 'feedback';
  const actor = input.actor || principal.id;
  const status = input.status || 'published';
  const stmts = [
    stmt(db, `INSERT INTO obj_revisions
        (id, object_id, number, content, content_hash, source, actor, created_at, legacy_id, base_revision_id, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, objectId, number, input.content, hash, source, actor, at,
      input.id || null, object.currentRevisionId || null, status),
    stmt(db, `UPDATE obj_objects SET current_revision_id = ?, revision_count = ?, updated_at = ?
              WHERE id = ? AND workspace_id = ?`,
      id, number, at, objectId, principal.workspaceId),
  ];
  await batch(db, stmts);
  return { revision: { id, number, sha256: hash, source, actor, createdAt: at }, duplicate: false };
}

export async function listRevisions(db: Db, principal: Principal, objectId: string) {
  const object = await getObject(db, principal, objectId);
  if (!object) return null;
  return all(db,
    `SELECT id, number, content_hash, source, actor, created_at, status
       FROM obj_revisions WHERE object_id = ? ORDER BY number ASC`, objectId);
}

export async function getRevision(db: Db, principal: Principal, objectId: string, revisionId: string) {
  const object = await getObject(db, principal, objectId);
  if (!object) return null;
  return first(db, 'SELECT * FROM obj_revisions WHERE id = ? AND object_id = ?', revisionId, objectId);
}

// ------------------------------------------------------------ relations ---

export async function addRelation(db: Db, principal: Principal, fromId: string, input: {
  toObjectId: string; relation: string; metadata?: any;
}) {
  const from = await getObject(db, principal, fromId);
  const to = await getObject(db, principal, input.toObjectId);
  if (!from || !to) return { error: 'not_found' as const };
  const id = uuid();
  await run(db,
    `INSERT INTO obj_relationships (id, workspace_id, from_object_id, to_object_id, relation, metadata_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(from_object_id, to_object_id, relation) DO NOTHING`,
    id, principal.workspaceId, fromId, input.toObjectId, input.relation,
    JSON.stringify(input.metadata || {}), nowIso());
  return { relation: { id, fromId, toId: input.toObjectId, relation: input.relation } };
}

export async function listRelations(db: Db, principal: Principal, objectId: string) {
  const object = await getObject(db, principal, objectId);
  if (!object) return null;
  return all(db,
    `SELECT id, from_object_id, to_object_id, relation, metadata_json, created_at
       FROM obj_relationships WHERE workspace_id = ? AND (from_object_id = ? OR to_object_id = ?)
       ORDER BY created_at ASC`, principal.workspaceId, objectId, objectId);
}

// --------------------------------------------------------------- events ---

export async function recordEvent(db: Db, principal: Principal, input: {
  objectId?: string | null; type: string; actor?: string; payload?: any; id?: string; createdAt?: string;
}) {
  const id = input.id || uuid();
  await run(db,
    `INSERT INTO obj_events (id, workspace_id, object_id, type, actor, payload_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`,
    id, principal.workspaceId, input.objectId ?? null, input.type,
    input.actor || principal.id, JSON.stringify(input.payload || {}), input.createdAt || nowIso());
  return id;
}

// --------------------------------------------------------- agent actions ---

export async function createAction(db: Db, principal: Principal, input: {
  objectId: string; action: string; agent?: string; idempotencyKey?: string | null;
  payload?: any; id?: string; createdAt?: string; status?: string; kind?: string;
  workflow?: string | null; legacyId?: string | null;
}) {
  if (input.idempotencyKey) {
    const existing = await first(db,
      'SELECT * FROM obj_agent_actions WHERE workspace_id = ? AND idempotency_key = ?',
      principal.workspaceId, input.idempotencyKey);
    if (existing) return { action: existing, duplicate: true };
  }
  const id = input.id || uuid();
  await run(db,
    `INSERT INTO obj_agent_actions
      (id, workspace_id, object_id, agent, action, status, idempotency_key, input_json,
       created_at, request_kind, workflow, legacy_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`,
    id, principal.workspaceId, input.objectId, input.agent || 'openclaw', input.action,
    input.status || 'pending', input.idempotencyKey ?? null, JSON.stringify(input.payload || {}),
    input.createdAt || nowIso(), input.kind ?? null, input.workflow ?? null, input.legacyId ?? null);
  return { action: await first(db, 'SELECT * FROM obj_agent_actions WHERE id = ?', id), duplicate: false };
}

export async function getAction(db: Db, principal: Principal, id: string) {
  const row: any = await first(db,
    'SELECT * FROM obj_agent_actions WHERE id = ? AND workspace_id = ?', id, principal.workspaceId);
  return row ? viewAction(row) : null;
}

export async function listActions(db: Db, principal: Principal, opts: { status?: string; limit?: number } = {}) {
  const status = opts.status || 'pending';
  const limit = Math.min(Math.max(opts.limit ?? 5, 1), 20);
  return all(db,
    `SELECT * FROM obj_agent_actions WHERE workspace_id = ? AND status = ?
     ORDER BY created_at ASC LIMIT ?`, principal.workspaceId, status, limit);
}

export async function claimAction(db: Db, principal: Principal, id: string, worker = 'bridge') {
  const at = nowIso();
  const lease = new Date(Date.now() + LEASE_MS).toISOString();
  const token = uuid();
  const res = await run(db,
    `UPDATE obj_agent_actions
        SET status = 'claimed', started_at = COALESCE(started_at, ?), lease_expires_at = ?,
            attempts = attempts + 1, agent = ?, claim_token = ?
      WHERE id = ? AND workspace_id = ? AND status IN ('pending','stale')
        AND attempts < COALESCE(max_attempts, ?)
        AND (next_attempt_at IS NULL OR next_attempt_at <= ?)`,
    at, lease, worker, token, id, principal.workspaceId, MAX_ATTEMPTS, at);
  const changes = res?.meta?.changes ?? res?.changes ?? 0;
  if (!changes) return { ok: false, reason: 'not_claimable' };
  const action: any = await first(db,
    'SELECT action, object_id, attempts, max_attempts FROM obj_agent_actions WHERE id = ?', id);
  if (action?.action === 'inbox.decision' && action.object_id) {
    const object = await getObject(db, principal, action.object_id);
    if (object) await updateObject(db, principal, object.id, { status: 'processing', data: { processed_at: at } });
  }
  return {
    ok: true, id, token, claimedAt: at, leaseExpiresAt: lease,
    attempt: Number(action?.attempts || 1), maxAttempts: Number(action?.max_attempts || MAX_ATTEMPTS),
  };
}

/** Renew the lease for a live claim. Any claim/working status is renewable. */
export async function heartbeatAction(db: Db, principal: Principal, id: string, token: string) {
  if (!token) return { ok: false, reason: 'missing_token' as const };
  const lease = new Date(Date.now() + LEASE_MS).toISOString();
  const res = await run(db,
    `UPDATE obj_agent_actions SET lease_expires_at = ?
      WHERE id = ? AND workspace_id = ? AND claim_token = ?
        AND status IN ('claimed','working','needs_input')`,
    lease, id, principal.workspaceId, token);
  const changes = res?.meta?.changes ?? res?.changes ?? 0;
  if (!changes) return { ok: false, reason: 'claim_lost' as const };
  return { ok: true, leaseExpiresAt: lease };
}

export async function progressAction(db: Db, principal: Principal, id: string, input: {
  status: 'claimed' | 'working' | 'needs_input'; reply?: string; error?: string; token?: string;
}) {
  const lease = new Date(Date.now() + LEASE_MS).toISOString();
  const res = await run(db,
    `UPDATE obj_agent_actions SET status = ?, reply = COALESCE(NULLIF(?, ''), reply), error = ?, lease_expires_at = ?
      WHERE id = ? AND workspace_id = ? AND status IN ('claimed','working','needs_input')
        AND (claim_token = ? OR claim_token IS NULL)`,
    input.status, clampText(input.reply, 8000), input.error ? clampText(input.error, 800) : null,
    lease, id, principal.workspaceId, input.token || null);
  const changes = res?.meta?.changes ?? res?.changes ?? 0;
  if (!changes) return { ok: false, reason: 'claim_lost' as const };
  return { ok: true, leaseExpiresAt: lease };
}

export async function completeAction(db: Db, principal: Principal, id: string, input: {
  reply?: string; revisionId?: string; token?: string; dispositions?: unknown; assetId?: string;
}) {
  const action = await first(db,
    'SELECT action, object_id, status, claim_token FROM obj_agent_actions WHERE id = ? AND workspace_id = ?',
    id, principal.workspaceId);
  if (!action) return { ok: false, reason: 'not_found' };
  if (action.status === 'completed') return { ok: true, duplicate: true };
  // Fencing: a worker that lost its claim (lease swept + re-claimed) must not finish it.
  if (action.claim_token && action.claim_token !== input.token) {
    return { ok: false, reason: 'claim_lost' };
  }
  if (!['claimed', 'working', 'needs_input'].includes(String(action.status))) {
    return { ok: false, reason: 'invalid_transition', status: action.status };
  }
  const at = nowIso();
  const res = await run(db,
    `UPDATE obj_agent_actions SET status = 'completed', reply = COALESCE(NULLIF(?, ''), reply),
       output_json = ?, completed_at = ?, lease_expires_at = NULL, claim_token = NULL, next_attempt_at = NULL
     WHERE id = ? AND workspace_id = ? AND status IN ('claimed','working','needs_input')
       AND (claim_token = ? OR claim_token IS NULL)`,
    clampText(input.reply, 8000),
    JSON.stringify({
      revisionId: input.revisionId || null,
      assetId: input.assetId || null,
      dispositions: Array.isArray(input.dispositions) ? input.dispositions.slice(0, 50) : [],
    }),
    at, id, principal.workspaceId, input.token || null);
  const changes = res?.meta?.changes ?? res?.changes ?? 0;
  if (!changes) return { ok: false, reason: 'claim_lost' };
  if (action.action === 'inbox.decision' && action.object_id) {
    const object = await getObject(db, principal, action.object_id);
    if (object) {
      await updateObject(db, principal, object.id, {
        status: 'completed', data: { outbox: true, completed_at: at, disposition: clampText(input.reply, 8000) },
      });
      await recordEvent(db, principal, { objectId: object.id, type: 'inbox.completed', payload: { action_id: id } });
    }
  }
  if (action.action !== 'inbox.decision' && action.object_id && input.reply) {
    await appendMessage(db, principal, action.object_id, {
      role: 'agent', text: clampText(input.reply, 8000), requestId: id, createdAt: at,
    });
  }
  return { ok: true };
}

export async function failAction(db: Db, principal: Principal, id: string, error: string, retryable = true, token?: string) {
  const row: any = await first(db,
    'SELECT action, object_id, status, attempts, max_attempts, claim_token FROM obj_agent_actions WHERE id = ? AND workspace_id = ?',
    id, principal.workspaceId);
  if (!row) return { ok: false, reason: 'not_found' };
  if (row.claim_token && token !== undefined && row.claim_token !== token) {
    return { ok: false, reason: 'claim_lost' };
  }
  if (row.status === 'completed') return { ok: false, reason: 'invalid_transition', status: row.status };
  const attempts = Number(row.attempts || 0);
  const maxAttempts = Number(row.max_attempts || MAX_ATTEMPTS);
  const canRetry = Boolean(retryable) && attempts < maxAttempts;
  // Exponential backoff with jitter: 30s, 60s, 120s … capped. Never an instant re-run.
  let next = null;
  if (canRetry) {
    const base = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * Math.pow(2, Math.max(0, attempts - 1)));
    const jitter = Math.floor(base * 0.2 * Math.random());
    next = new Date(Date.now() + base + jitter).toISOString();
  }
  const at = nowIso();
  const res = await run(db,
    `UPDATE obj_agent_actions
        SET status = ?, error = ?, lease_expires_at = NULL, claim_token = NULL,
            next_attempt_at = ?, completed_at = ?
      WHERE id = ? AND workspace_id = ? AND status <> 'completed'
        AND (claim_token IS NULL OR claim_token = ?)`,
    canRetry ? 'stale' : 'failed', clampText(error, 800), next, canRetry ? null : at,
    id, principal.workspaceId, token || null);
  const changes = res?.meta?.changes ?? res?.changes ?? 0;
  if (!changes) return { ok: false, reason: 'claim_lost' };
  const action = row;
  if (action?.action === 'inbox.decision' && action.object_id) {
    const object = await getObject(db, principal, action.object_id);
    if (object) await updateObject(db, principal, object.id, {
      status: canRetry ? 'submitted' : 'blocked', data: { action_error: clampText(error, 800) },
    });
  }
  return { ok: true, status: canRetry ? 'stale' : 'failed', attempts, maxAttempts, nextAttemptAt: next };
}

// ------------------------------------------------------------ inbox views ---

function choiceRows(value: any) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 50).map((v) => typeof v === 'string'
    ? { label: clampText(v, 500), checked: false }
    : { label: clampText(v?.label, 500), checked: Boolean(v?.checked) })
    .filter((v) => v.label.trim());
}

async function getInboxObject(db: Db, principal: Principal, id: string) {
  const row = await first(db,
    `SELECT * FROM obj_objects WHERE workspace_id = ? AND deleted_at IS NULL
      AND kind IN (?, ?) AND (id = ? OR external_id = ?) LIMIT 1`,
    principal.workspaceId, KINDS.inbox, KINDS.decision, id, id);
  return row ? hydrate(row) : null;
}

function plainSummary(text: string): string {
  return String(text || '')
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, path, label) => label || String(path).split('/').pop() || path)
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_`#>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180);
}

export function inboxView(object: any) {
  const d = object.data || {};
  const outbox = Boolean(d.outbox) || ['completed', 'closed', 'dismissed', 'outboxed'].includes(object.status);
  const choices = choiceRows(d.actions || d.choices);
  const actionable = choices.length > 0 || Boolean(String(d.instruction || '').trim());
  return {
    id: object.id,
    orbit_id: object.externalId || object.id,
    object_id: object.id,
    type: actionable ? 'decision' : 'message',
    summary: d.summary || plainSummary(d.body),
    actionable,
    kind: d.kind || (object.kind === KINDS.decision ? 'decision' : 'message'),
    folder: d.folder || (outbox ? 'outbox' : 'active'),
    title: object.title,
    body: d.body || '',
    actions: choices,
    choices,
    instruction: d.instruction ?? null,
    selections: Array.isArray(d.selections) ? d.selections : [],
    selected_instruction: d.selected_instruction || '',
    created_at: d.created_at || object.createdAt,
    created_precision: d.created_precision || 'datetime',
    updated_at: d.updated_at || object.updatedAt,
    submitted_at: d.submitted_at || null,
    processed_at: d.processed_at || null,
    completed_at: d.completed_at || null,
    status: outbox && ['closed', 'dismissed', 'outboxed'].includes(object.status) ? 'outbox' : object.status,
    disposition: d.disposition || null,
    source_path: d.source_path || '',
    outbox,
  };
}

export async function createInboxItem(db: Db, principal: Principal, input: {
  type: 'message' | 'decision'; title: string; body?: string; summary?: string; choices?: any[];
  instruction?: string | null; externalId?: string | null; source?: string;
}) {
  const choices = choiceRows(input.choices);
  if (input.type === 'decision' && !choices.length && !String(input.instruction || '').trim()) {
    return { error: 'decision_requires_choices_or_instruction' as const };
  }
  const object = await createObject(db, principal, {
    kind: input.type === 'decision' ? KINDS.decision : KINDS.inbox,
    title: clampText(input.title, 500) || '(untitled)', externalId: input.externalId || null,
    status: 'pending', data: {
      body: clampText(input.body, 20000), summary: clampText(input.summary, 2000), actions: choices,
      instruction: input.instruction == null ? null : clampText(input.instruction, 4000),
      selections: [], selected_instruction: '', source: input.source || 'api', outbox: false,
    },
  });
  await recordEvent(db, principal, { objectId: object!.id, type: 'inbox.created', payload: { type: input.type } });
  return { item: inboxView(object) };
}

export async function updateInboxItem(db: Db, principal: Principal, id: string, patch: {
  title?: string; summary?: string; body?: string;
}) {
  const object = await getInboxObject(db, principal, id);
  if (!object) return { error: 'not_found' as const };
  const d = object.data || {};
  if (d.submitted_at) return { error: 'already_submitted' as const };
  const data = {
    ...d,
    ...(patch.summary === undefined ? {} : { summary: clampText(patch.summary, 4000) }),
    ...(patch.body === undefined ? {} : { body: clampText(patch.body, 20000) }),
  };
  await run(db, 'UPDATE obj_objects SET title = ?, data_json = ?, updated_at = ? WHERE id = ? AND workspace_id = ?',
    patch.title === undefined ? object.title : clampText(patch.title, 500),
    JSON.stringify(data), nowIso(), object.id, principal.workspaceId);
  await recordEvent(db, principal, { objectId: object.id, type: 'inbox.updated', payload: { fields: Object.keys(patch) } });
  return { item: inboxView({ ...object, title: patch.title ?? object.title, data }) };
}

export async function listInbox(db: Db, principal: Principal, scope = 'all') {
  const rows = await all(db,
    `SELECT * FROM obj_objects WHERE workspace_id = ? AND deleted_at IS NULL AND kind IN (?, ?)
      ORDER BY created_at DESC, id ASC LIMIT 500`, principal.workspaceId, KINDS.inbox, KINDS.decision);
  const items = rows.map((r) => inboxView(hydrate(r)));
  const active = items.filter((x) => !x.outbox && !['dismissed', 'closed'].includes(x.status));
  const outbox = items.filter((x) => x.outbox || ['dismissed', 'closed'].includes(x.status));
  if (scope === 'active') return { items: active, count: active.length };
  if (scope === 'outboxed' || scope === 'outbox') return { items: outbox, count: outbox.length };
  return { active, outbox, counts: { active: active.length, outbox: outbox.length } };
}

export async function getInboxItem(db: Db, principal: Principal, id: string) {
  const object = await getInboxObject(db, principal, id);
  return object ? inboxView(object) : null;
}

export async function patchInboxSelections(db: Db, principal: Principal, id: string, input: {
  choices?: string[]; instruction?: string;
}) {
  const object = await getInboxObject(db, principal, id);
  if (!object) return { error: 'not_found' as const };
  if (object.kind !== KINDS.decision) return { error: 'not_a_decision' as const };
  if (object.status !== 'pending') return { error: 'not_actionable' as const };
  const allowed = new Set(choiceRows(object.data.actions || object.data.choices).map((x) => x.label));
  const choices = Array.isArray(input.choices)
    ? [...new Set(input.choices.filter((x) => typeof x === 'string' && allowed.has(x)))].slice(0, 50)
    : (object.data.selections || []);
  const instruction = input.instruction === undefined
    ? (object.data.selected_instruction || '') : clampText(input.instruction, 4000);
  const updated = await updateObject(db, principal, object.id, {
    data: { selections: choices, selected_instruction: instruction },
  });
  await recordEvent(db, principal, { objectId: object.id, type: 'inbox.selections.updated', payload: { choices } });
  return { item: inboxView(updated) };
}

export async function submitInboxDecision(db: Db, principal: Principal, id: string, input: {
  choices?: string[]; instruction?: string; idempotencyKey?: string;
}) {
  const object = await getInboxObject(db, principal, id);
  if (!object) return { error: 'not_found' as const };
  if (object.kind !== KINDS.decision) return { error: 'not_a_decision' as const };
  const stableKey = `inbox:${object.id}:decision`;
  const existing: any = await first(db,
    'SELECT id, status, created_at FROM obj_agent_actions WHERE workspace_id = ? AND idempotency_key = ?',
    principal.workspaceId, stableKey);
  // A failed attempt never blocks a genuine resubmission; a live or completed one does.
  if (existing && existing.status !== 'failed') {
    return { ok: true, actionId: existing.id, submittedAt: existing.created_at, status: existing.status, duplicate: true };
  }
  const attempt = existing && existing.status === 'failed'
    ? `inbox:${object.id}:decision:${Date.now()}` : stableKey;
  if (!['pending', 'blocked'].includes(String(object.status))) return { error: 'not_actionable' as const };
  const allowed = new Set(choiceRows(object.data.actions || object.data.choices).map((x) => x.label));
  const choices = Array.isArray(input.choices)
    ? [...new Set(input.choices.filter((x) => typeof x === 'string' && allowed.has(x)))].slice(0, 50)
    : (object.data.selections || []);
  const instruction = input.instruction === undefined
    ? (object.data.selected_instruction || '') : clampText(input.instruction, 4000);
  if (!choices.length && !instruction.trim()) return { error: 'empty_decision' as const };
  const actionId = existing && existing.status === 'failed'
    ? `action_inbox_${object.id}_${Date.now()}` : `action_inbox_${object.id}`;
  const at = nowIso();
  const data = { ...object.data, selections: choices, selected_instruction: instruction, submitted_at: at };
  await batch(db, [
    stmt(db, `INSERT INTO obj_agent_actions
      (id, workspace_id, object_id, agent, action, status, idempotency_key, input_json,
       created_at, request_kind)
      VALUES (?, ?, ?, 'openclaw', 'inbox.decision', 'pending', ?, ?, ?, 'inbox.decision')
      ON CONFLICT(workspace_id, idempotency_key) DO NOTHING`,
      actionId, principal.workspaceId, object.id, attempt,
      JSON.stringify({ choices, instruction, object_id: object.id }), at),
    stmt(db, `UPDATE obj_objects SET status = 'submitted', data_json = ?, updated_at = ?
      WHERE id = ? AND workspace_id = ? AND status = 'pending'`,
      JSON.stringify(data), at, object.id, principal.workspaceId),
    stmt(db, `INSERT INTO obj_events (id, workspace_id, object_id, type, actor, payload_json, created_at)
      VALUES (?, ?, ?, 'inbox.submitted', ?, ?, ?) ON CONFLICT(id) DO NOTHING`,
      `event_submit_${object.id}`, principal.workspaceId, object.id, principal.id,
      JSON.stringify({ action_id: actionId }), at),
  ]);
  const created = await first(db,
    'SELECT id, status, created_at FROM obj_agent_actions WHERE workspace_id = ? AND idempotency_key = ?',
    principal.workspaceId, stableKey);
  return {
    ok: true, actionId: created?.id || actionId, submittedAt: created?.created_at || at,
    status: created?.status || 'pending', duplicate: created?.id !== actionId,
  };
}

export async function closeInboxItem(db: Db, principal: Principal, id: string, disposition: 'closed' | 'dismissed') {
  const object = await getInboxObject(db, principal, id);
  if (!object) return null;
  const at = nowIso();
  const updated = await updateObject(db, principal, object.id, {
    status: disposition, data: { outbox: true, completed_at: at, disposition },
  });
  await recordEvent(db, principal, { objectId: object.id, type: `inbox.${disposition}` });
  return { ok: true, item: inboxView(updated) };
}

// --------------------------------------------------------- artifact views ---

// --------------------------------------------------------------- messages ---

/** Append one conversation message to an artifact. Used by feedback and by results. */
export async function appendMessage(db: Db, principal: Principal, artifactObjectId: string, input: {
  role: 'user' | 'agent' | 'system'; text: string; requestId?: string | null; id?: string; createdAt?: string;
}) {
  const id = input.id || uuid();
  await run(db,
    `INSERT INTO obj_objects (id, workspace_id, kind, external_id, title, status, data_json, created_at, updated_at, created_by)
     VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`,
    id, principal.workspaceId, KINDS.message, id,
    String(input.text || '').slice(0, 90) || '(empty)',
    JSON.stringify({
      artifact_id: artifactObjectId, role: input.role, text: input.text,
      request_id: input.requestId || null,
    }),
    input.createdAt || nowIso(), input.createdAt || nowIso(), principal.id);
  return id;
}

// ---------------------------------------------------------------- reviews ---

async function loadReviewPayload(db: Db, object: any) {
  if (!object?.currentRevisionId) return { summary: '', findings: [] as any[] };
  const rev: any = await first(db, 'SELECT content FROM obj_revisions WHERE id = ? AND object_id = ?',
    object.currentRevisionId, object.id);
  const parsed = json(rev?.content, {});
  return {
    summary: typeof parsed.summary === 'string' ? parsed.summary : '',
    findings: Array.isArray(parsed.findings) ? parsed.findings : [],
  };
}

function reviewView(object: any, payload: { summary: string; findings: any[] }) {
  const d = object.data || {};
  return {
    id: object.id,
    externalId: object.externalId,
    workflow: d.workflow_id || null,
    resultKind: 'review',
    targetObjectId: d.target_object_id || null,
    targetRevisionId: d.target_revision_id || null,
    actionId: d.action_id || null,
    agent: d.agent || null,
    summary: d.summary || payload.summary || '',
    findingCount: payload.findings.length,
    findings: payload.findings,
    notes: d.notes && typeof d.notes === 'object' ? d.notes : {},
    overallNote: d.overall_note || '',
    createdAt: object.createdAt,
    completedAt: d.completed_at || object.createdAt,
  };
}

/**
 * Persist a structured review against one immutable revision. Creates a review
 * object plus one immutable revision holding the findings; never creates a
 * document revision. Idempotent per originating action.
 */
export async function publishReview(db: Db, principal: Principal, articleId: string, input: {
  revisionId: string; workflow: string; actionId?: string | null; agent?: string;
  summary?: string; findings?: unknown; id?: string; createdAt?: string;
}) {
  const artifact = await getObjectByExternal(db, principal, KINDS.artifact, articleId);
  if (!artifact) return { error: 'unknown_article' as const };
  const revision: any = await first(db,
    'SELECT id, number, content FROM obj_revisions WHERE id = ? AND object_id = ?',
    input.revisionId, artifact.id);
  if (!revision) return { error: 'unknown_revision' as const };

  const externalId = input.actionId ? `review:${input.actionId}` : `review:${input.id || uuid()}`;
  const existing = await getObjectByExternal(db, principal, KINDS.review, externalId);
  if (existing) {
    return { review: reviewView(existing, await loadReviewPayload(db, existing)), duplicate: true };
  }

  const findings = anchorFindings(revision.content, input.findings);
  const summary = clampText(input.summary, 4000);
  const at = input.createdAt || nowIso();
  const object = await createObject(db, principal, {
    kind: KINDS.review, title: `Critique · ${findings.length} ${findings.length === 1 ? 'finding' : 'findings'}`,
    externalId, data: {
      workflow_id: input.workflow || null,
      target_object_id: artifact.id,
      target_revision_id: revision.id,
      target_revision_number: revision.number,
      action_id: input.actionId || null,
      agent: input.agent || principal.id,
      summary,
      finding_count: findings.length,
      notes: {},
      overall_note: '',
      completed_at: at,
    },
  });
  const content = JSON.stringify({ summary, findings }, null, 0);
  const rev = await createRevision(db, principal, object!.id, {
    content, source: 'review', actor: input.agent || principal.id,
  });
  if ('error' in rev) return { error: rev.error } as any;
  await addRelation(db, principal, object!.id, { toObjectId: artifact.id, relation: 'reviews' });
  await recordEvent(db, principal, {
    objectId: object!.id, type: 'review.published',
    payload: {
      target_object_id: artifact.id, target_revision_id: revision.id,
      finding_count: findings.length, workflow: input.workflow || null,
    },
  });
  const fresh = await getObject(db, principal, object!.id);
  return { review: reviewView(fresh, { summary, findings }), duplicate: false };
}

/**
 * Finish an agent action with whatever result the workflow declared: a structured
 * review, a new revision, or prose only. Branching is on the persisted result and
 * the declared result kind — never on the wording of the reply.
 */
export async function completeActionWithResult(db: Db, principal: Principal, id: string, input: {
  reply?: string; markdown?: string; review?: { summary?: string; findings?: unknown } | null;
  token?: string; dispositions?: unknown;
}) {
  const action: any = await first(db,
    'SELECT * FROM obj_agent_actions WHERE id = ? AND workspace_id = ?', id, principal.workspaceId);
  if (!action) return { error: 'not_found' as const };
  if (action.status === 'completed') return { ok: true, duplicate: true } as any;
  // Fencing: only the current claim holder may publish a result.
  if (action.claim_token && action.claim_token !== input.token) return { error: 'claim_lost' as const } as any;
  if (!['claimed', 'working', 'needs_input'].includes(String(action.status))) {
    return { error: 'invalid_transition' as const } as any;
  }
  const inputJson = json(action.input_json);
  if (!action.object_id) return { error: 'unknown_object' as const };
  const object = await getObject(db, principal, action.object_id);
  if (!object) return { error: 'unknown_object' as const };

  const declared = action.workflow ? workflowResultKind(action.workflow) : 'revision';
  let review: any = null;
  let revision: any = null;

  if (input.review && Array.isArray(input.review.findings)) {
    const res = await publishReview(db, principal, object.externalId || object.id, {
      revisionId: String(inputJson.base_revision_id || object.currentRevisionId),
      workflow: action.workflow || 'blog-critic',
      actionId: id, agent: action.agent || 'openclaw',
      summary: input.review.summary, findings: input.review.findings,
    });
    if ('error' in res) return { error: (res as any).error } as any;
    review = res.review;
  } else if (String(input.markdown || '').trim()) {
    const res = await createRevision(db, principal, object.id, {
      content: String(input.markdown), source: action.request_kind || 'feedback',
      expectedRevisionId: inputJson.base_revision_id || null,
    });
    if ('error' in res) return { error: (res as any).error, currentRevisionId: (res as any).currentRevisionId } as any;
    revision = res.revision;
    await recordEvent(db, principal, { objectId: object.id, type: 'revision.published', payload: revision });
  } else if (declared === 'revision' && action.request_kind === 'workflow') {
    // A revision workflow can legitimately decide nothing needs to change. That is
    // not a failure: complete it and record that no revision was published, so the
    // UI shows the agent's reply instead of a stuck action.
    await recordEvent(db, principal, {
      objectId: object.id, type: 'revision.skipped', payload: { action_id: id, workflow: action.workflow },
    });
  }

  await completeAction(db, principal, id, {
    reply: input.reply, revisionId: revision?.id, token: input.token, dispositions: input.dispositions,
  });
  return { ok: true, review, revision } as any;
}

async function getReviewObject(db: Db, principal: Principal, idOrExternal: string) {
  const byId = await getObject(db, principal, idOrExternal);
  if (byId && byId.kind === KINDS.review) return byId;
  return getObjectByExternal(db, principal, KINDS.review, idOrExternal);
}

export async function getReview(db: Db, principal: Principal, idOrExternal: string) {
  const object = await getReviewObject(db, principal, idOrExternal);
  if (!object) return null;
  return reviewView(object, await loadReviewPayload(db, object));
}

export async function listReviews(db: Db, principal: Principal, articleId: string, opts: {
  revisionId?: string | null; limit?: number;
} = {}) {
  const artifact = await getObjectByExternal(db, principal, KINDS.artifact, articleId);
  if (!artifact) return null;
  const limit = Math.min(Math.max(Number(opts.limit || 50), 1), 100);
  const args: any[] = [principal.workspaceId, KINDS.review, artifact.id];
  let where = `workspace_id = ? AND kind = ? AND deleted_at IS NULL
    AND json_extract(data_json, '$.target_object_id') = ?`;
  if (opts.revisionId) {
    where += ` AND json_extract(data_json, '$.target_revision_id') = ?`;
    args.push(opts.revisionId);
  }
  const rows = await all(db,
    `SELECT * FROM obj_objects WHERE ${where} ORDER BY created_at DESC, id ASC LIMIT ?`, ...args, limit);
  const reviews = [];
  for (const row of rows) {
    const object = hydrate(row);
    const payload = await loadReviewPayload(db, object);
    const view = reviewView(object, payload);
    reviews.push({
      id: view.id, workflow: view.workflow, targetRevisionId: view.targetRevisionId,
      findingCount: view.findingCount, summary: view.summary, createdAt: view.createdAt,
      noteCount: Object.keys(view.notes).length, overallNote: view.overallNote,
    });
  }
  return { reviews };
}

/** Latest applicable review for one revision (optionally a specific artifact). */
export async function latestReviewFor(db: Db, principal: Principal, artifactObjectId: string, revisionId: string) {
  const row = await first(db,
    `SELECT * FROM obj_objects WHERE workspace_id = ? AND kind = ? AND deleted_at IS NULL
       AND json_extract(data_json, '$.target_object_id') = ?
       AND json_extract(data_json, '$.target_revision_id') = ?
     ORDER BY created_at DESC LIMIT 1`,
    principal.workspaceId, KINDS.review, artifactObjectId, revisionId);
  if (!row) return null;
  const object = hydrate(row);
  return reviewView(object, await loadReviewPayload(db, object));
}

export async function setFindingNote(db: Db, principal: Principal, reviewId: string, findingId: string, note: string | null) {
  const object = await getReviewObject(db, principal, reviewId);
  if (!object) return { error: 'not_found' as const };
  const payload = await loadReviewPayload(db, object);
  if (!payload.findings.some((f: any) => f && f.id === findingId)) return { error: 'unknown_finding' as const };
  const notes = { ...(object.data.notes || {}) };
  const text = note == null ? '' : clampText(note, 4000).trim();
  if (text) notes[findingId] = text;
  else delete notes[findingId];
  await updateObject(db, principal, object.id, { data: { notes } });
  await recordEvent(db, principal, {
    objectId: object.id, type: text ? 'review.note.saved' : 'review.note.removed',
    payload: { finding_id: findingId },
  });
  const fresh = await getObject(db, principal, object.id);
  return { review: reviewView(fresh!, payload) };
}

export async function setReviewNote(db: Db, principal: Principal, reviewId: string, note: string | null) {
  const object = await getReviewObject(db, principal, reviewId);
  if (!object) return { error: 'not_found' as const };
  const overall_note = note == null ? '' : clampText(note, 8000).trim();
  await updateObject(db, principal, object.id, { data: { overall_note } });
  await recordEvent(db, principal, { objectId: object.id, type: 'review.note.saved', payload: { overall: true } });
  const fresh = await getObject(db, principal, object.id);
  return { review: reviewView(fresh!, await loadReviewPayload(db, fresh!)) };
}

/** Everything an authoring workflow needs, fetched from the API — never from chat. */
export async function critiqueContext(db: Db, principal: Principal, articleId: string, opts: {
  revisionId?: string | null;
} = {}) {
  const artifact = await getObjectByExternal(db, principal, KINDS.artifact, articleId);
  if (!artifact) return null;
  const revisionId = opts.revisionId || artifact.currentRevisionId;
  const revision: any = revisionId
    ? await first(db, 'SELECT id, number, content, created_at FROM obj_revisions WHERE id = ? AND object_id = ?', revisionId, artifact.id)
    : null;
  const review = revision ? await latestReviewFor(db, principal, artifact.id, revision.id) : null;
  const messages = await all(db,
    `SELECT id, data_json, created_at FROM obj_objects
      WHERE workspace_id = ? AND kind = ? AND data_json LIKE ? ORDER BY created_at ASC`,
    principal.workspaceId, KINDS.message, `%\"artifact_id\":\"${artifact.id}\"%`);
  return {
    artifact: { id: articleId, title: artifact.title, objectId: artifact.id },
    revision: revision ? { id: revision.id, number: revision.number, markdown: revision.content } : null,
    review: review || null,
    notes: review?.notes || {},
    overallNote: review?.overallNote || '',
    conversation: messages.map((m) => {
      const d = json(m.data_json);
      return { id: m.id, role: d.role || 'system', text: d.text || '', created_at: m.created_at };
    }),
  };
}

export async function artifactState(db: Db, principal: Principal, articleId: string) {
  const object = await getObjectByExternal(db, principal, KINDS.artifact, articleId);
  if (!object) return null;
  const revisions = await all(db,
    `SELECT id, number, content_hash, source, actor, created_at, status
       FROM obj_revisions WHERE object_id = ? ORDER BY number ASC`, object.id);
  const messages = await all(db,
    `SELECT id, data_json, created_at FROM obj_objects
      WHERE workspace_id = ? AND kind = ? AND data_json LIKE ?
      ORDER BY created_at ASC`,
    principal.workspaceId, KINDS.message, `%\"artifact_id\":\"${object.id}\"%`);
  const actions = await all(db,
    `SELECT * FROM obj_agent_actions WHERE workspace_id = ? AND object_id = ?
      ORDER BY created_at DESC`, principal.workspaceId, object.id);
  const active = actions.find((a) => ['pending', 'claimed', 'working'].includes(a.status)) || null;
  const last = actions.find((a) => ['completed', 'failed', 'stale', 'cancelled'].includes(a.status)) || null;
  const images = await all(db,
    `SELECT id, filename, mime, size, include_flag, instruction, created_at, role, resolved_role,
            provider, reference_asset_id, asset_state, revision_id
       FROM obj_assets WHERE object_id = ? ORDER BY created_at ASC`, object.id);
  const publicationRow: any = await first(db,
    `SELECT * FROM obj_objects WHERE workspace_id = ? AND kind = ? AND deleted_at IS NULL
       AND json_extract(data_json, '$.artifact_id') = ? ORDER BY created_at DESC LIMIT 1`,
    principal.workspaceId, KINDS.publication, object.id).catch(() => null);
  return {
    article: {
      id: articleId, title: object.title,
      canonical_path: object.data.canonical_path || '', created_at: object.createdAt,
      closed_at: object.data.closed_at || null,
    },
    currentRevisionId: object.currentRevisionId || null,
    currentNumber: revisions.length ? revisions[revisions.length - 1].number : 0,
    revisions: revisions.map((r) => ({
      id: r.id, number: r.number, sha256: r.content_hash, source: r.source,
      workflow: null, created_at: r.created_at,
    })),
    events: messages.map((m) => {
      const d = json(m.data_json);
      return { id: m.id, role: d.role || 'system', text: d.text || '', request_id: d.request_id || null, created_at: m.created_at };
    }),
    activeRequest: active ? viewAction(active) : null,
    lastRequest: last ? viewAction(last) : null,
    reviews: await (async () => {
      const rows = await all(db,
        `SELECT id, data_json, current_revision_id, created_at FROM obj_objects
          WHERE workspace_id = ? AND kind = ? AND deleted_at IS NULL
            AND json_extract(data_json, '$.target_object_id') = ?
          ORDER BY created_at DESC LIMIT 50`, principal.workspaceId, KINDS.review, object.id);
      const out = [];
      for (const r of rows) {
        const d = json(r.data_json);
        out.push({
          id: r.id, workflow: d.workflow_id || null,
          targetRevisionId: d.target_revision_id || null,
          targetRevisionNumber: d.target_revision_number || null,
          findingCount: Number(d.finding_count || 0),
          summary: d.summary || '',
          notes: d.notes && typeof d.notes === 'object' ? d.notes : {},
          overallNote: d.overall_note || '',
          createdAt: r.created_at,
        });
      }
      return out;
    })(),
    workflowResultKinds: Object.fromEntries(WORKFLOWS.map((w) => [w, workflowResultKind(w)])),
    masthead: (() => {
      const a = images.find((i: any) => i.role === 'masthead' && i.asset_state === 'active');
      return a ? assetView(a) : null;
    })(),
    mastheadCandidates: images.filter((i: any) => i.role === 'masthead').map(assetView),
    publication: publicationRow ? publicationView(publicationRow) : null,
    images: images.filter((i: any) => i.role !== 'masthead').map((i) => ({
      ...assetView(i), request_id: null,
    })),
  };
}

export function publicationView(row: any) {
  const d = json(row?.data_json);
  return {
    id: row?.id || null, artifact_id: d.artifact_id || null, revision_id: d.revision_id || null,
    url: d.url || null, status: d.status || 'unknown', destination: d.destination || null,
    published_at: d.published_at || null, updated_at: row?.updated_at || null,
  };
}

/** One publication record per artifact. Re-publishing updates it rather than duplicating. */
export async function recordPublication(db: Db, principal: Principal, articleId: string, input: {
  revisionId?: string | null; url?: string | null; status: string; destination?: string | null;
  at?: string; detail?: any;
}) {
  const object = await getObjectByExternal(db, principal, KINDS.artifact, articleId);
  if (!object) return { error: 'unknown_article' as const };
  const at = input.at || nowIso();
  const data = {
    artifact_id: object.id, revision_id: input.revisionId || object.currentRevisionId,
    url: input.url || null, status: input.status,
    destination: input.destination || 'notes-from-the-loop',
    published_at: input.status === 'published' ? at : null,
    detail: input.detail || null,
  };
  const existing: any = await first(db,
    `SELECT * FROM obj_objects WHERE workspace_id = ? AND kind = ? AND deleted_at IS NULL
       AND json_extract(data_json, '$.artifact_id') = ? ORDER BY created_at DESC LIMIT 1`,
    principal.workspaceId, KINDS.publication, object.id);
  const id = existing?.id || uuid();
  if (existing) {
    await run(db,
      `UPDATE obj_objects SET data_json = ?, title = ?, updated_at = ? WHERE id = ? AND workspace_id = ?`,
      JSON.stringify(data), `Published · ${articleId}`, at, id, principal.workspaceId);
  } else {
    await run(db,
      `INSERT INTO obj_objects (id, workspace_id, kind, external_id, title, status, data_json, created_at, updated_at, created_by)
       VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
      id, principal.workspaceId, KINDS.publication, `publication_${object.id}`, `Published · ${articleId}`,
      JSON.stringify(data), at, at, principal.id);
  }
  await run(db,
    `INSERT INTO obj_relationships (id, workspace_id, from_object_id, to_object_id, relation, metadata_json, created_at)
     VALUES (?, ?, ?, ?, 'publishes', '{}', ?) ON CONFLICT(from_object_id, to_object_id, relation) DO NOTHING`,
    uuid(), principal.workspaceId, id, object.id, at);
  await recordEvent(db, principal, { objectId: object.id, type: `publication.${input.status}`, payload: { url: data.url } });
  return { ok: true, publication: { id, ...data } };
}

export async function artifactList(db: Db, principal: Principal) {
  const rows = await all(db,
    `SELECT o.id, o.title, o.created_at, o.data_json, o.updated_at,
            (SELECT number FROM obj_revisions r WHERE r.object_id = o.id ORDER BY number DESC LIMIT 1) AS current_number,
            (SELECT created_at FROM obj_revisions r WHERE r.object_id = o.id ORDER BY number DESC LIMIT 1) AS rev_updated
       FROM obj_objects o
      WHERE o.workspace_id = ? AND o.kind = ? AND o.deleted_at IS NULL
      ORDER BY o.created_at DESC`, principal.workspaceId, KINDS.artifact);
  return rows.map((r) => ({
    id: r.id, title: r.title, created_at: r.created_at,
    closed_at: json(r.data_json).closed_at || null,
    current_number: r.current_number || 1, updated_at: r.rev_updated || r.updated_at,
  }));
}

export async function artifactRevisionMarkdown(db: Db, principal: Principal, revisionId: string) {
  return first(db,
    `SELECT r.* FROM obj_revisions r JOIN obj_objects o ON o.id = r.object_id
      WHERE r.id = ? AND o.workspace_id = ?`, revisionId, principal.workspaceId);
}

export async function submitFeedback(db: Db, principal: Principal, articleId: string, input: {
  baseRevisionId?: string; kind?: string; workflow?: string; text?: string;
  idempotencyKey: string; imageIds?: string[]; reviewId?: string;
  options?: Record<string, unknown>;
}) {
  const object = await getObjectByExternal(db, principal, KINDS.artifact, articleId);
  if (!object) return { error: 'unknown_article' as const };
  if (!input.idempotencyKey) return { error: 'missing_idempotency_key' as const };
  const kind = input.kind === 'workflow' ? 'workflow' : 'feedback';
  const text = clampText(input.text, 20000);
  const workflow = kind === 'workflow' ? String(input.workflow || '') : null;
  if (kind === 'workflow' && !WORKFLOWS.includes(workflow!)) return { error: 'unknown_workflow' as const };
  if (kind === 'feedback' && !text.trim()) return { error: 'empty_feedback' as const };
  if (input.baseRevisionId && input.baseRevisionId !== object.currentRevisionId) {
    return { error: 'stale_base' as const, currentRevisionId: object.currentRevisionId };
  }
  const existing = await first(db,
    'SELECT id, status FROM obj_agent_actions WHERE workspace_id = ? AND idempotency_key = ?',
    principal.workspaceId, input.idempotencyKey);
  // A terminal failure does not consume the key: a manual retry must be able to run.
  const retryingFailed = Boolean(existing && ['failed'].includes(String((existing as any).status)));
  if (existing && !retryingFailed) {
    return { ok: true, requestId: existing.id, duplicate: true, status: existing.status };
  }
  const idemKey = retryingFailed ? `${input.idempotencyKey}:retry:${uuid()}` : input.idempotencyKey;

  const actionId = uuid();
  const at = nowIso();
  const payload = {
    text, workflow, kind, base_revision_id: input.baseRevisionId || object.currentRevisionId,
    image_ids: (input.imageIds || []).slice(0, 8),
    review_id: input.reviewId || null,
    options: input.options && typeof input.options === 'object' ? input.options : {},
  };
  const baseId = input.baseRevisionId || object.currentRevisionId;
  const stmts = [
    stmt(db, `INSERT INTO obj_agent_actions
        (id, workspace_id, object_id, agent, action, status, idempotency_key, input_json, created_at, request_kind, workflow)
       VALUES (?, ?, ?, 'openclaw', ?, 'pending', ?, ?, ?, ?, ?)`,
      actionId, principal.workspaceId, object.id, kind, idemKey,
      JSON.stringify(payload), at, kind, workflow),
    stmt(db, `INSERT INTO obj_objects
        (id, workspace_id, kind, external_id, title, status, data_json, created_at, updated_at, created_by)
       VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
      actionId, principal.workspaceId, KINDS.feedback, actionId,
      kind === 'workflow' ? `Run workflow: ${workflow}` : text.slice(0, 120),
      JSON.stringify({ text, workflow, kind, action_id: actionId }), at, at, principal.id),
    stmt(db, `INSERT INTO obj_relationships (id, workspace_id, from_object_id, to_object_id, relation, metadata_json, created_at)
       VALUES (?, ?, ?, ?, 'targets', '{}', ?)`, uuid(), principal.workspaceId, actionId, object.id, at),
  ];
  if (baseId) {
    stmts.push(stmt(db, `INSERT INTO obj_relationships (id, workspace_id, from_object_id, to_object_id, relation, metadata_json, created_at)
       VALUES (?, ?, ?, ?, 'references', '{}', ?)`,
      uuid(), principal.workspaceId, actionId, baseId, at));
  }
  if (input.reviewId) {
    stmts.push(stmt(db, `INSERT INTO obj_relationships (id, workspace_id, from_object_id, to_object_id, relation, metadata_json, created_at)
       VALUES (?, ?, ?, ?, 'informed_by', '{}', ?)`,
      uuid(), principal.workspaceId, actionId, String(input.reviewId), at));
  }
  await batch(db, stmts);
  for (const imgId of (input.imageIds || []).slice(0, 8)) {
    await run(db, 'UPDATE obj_assets SET include_flag = 1 WHERE id = ? AND object_id = ?', imgId, object.id);
  }
  await appendMessage(db, principal, object.id, {
    role: 'user', text: kind === 'workflow' ? `Run workflow: ${workflow}` : text,
    requestId: actionId, createdAt: at,
  });
  return { ok: true, requestId: actionId, duplicate: false, status: 'pending' };
}

export async function closeArtifact(db: Db, principal: Principal, articleId: string, closed: boolean) {
  const object = await getObjectByExternal(db, principal, KINDS.artifact, articleId);
  if (!object) return null;
  const at = closed ? nowIso() : null;
  await updateObject(db, principal, object.id, { data: { closed_at: at } });
  await recordEvent(db, principal, {
    objectId: object.id, type: closed ? 'artifact.closed' : 'artifact.reopened',
  });
  return { ok: true, id: articleId, closed };
}

export function assetView(a: any) {
  return {
    id: a.id, filename: a.filename, mime: a.mime, size: a.size,
    role: a.role || 'auto', resolved_role: a.resolved_role || null,
    state: a.asset_state || 'inline', provider: a.provider || null,
    reference_asset_id: a.reference_asset_id || null, revision_id: a.revision_id || null,
    include_flag: a.include_flag, instruction: a.instruction || null,
    created_at: a.created_at,
  };
}

/** Replace the active masthead atomically: one active row per artifact, enforced by index. */
export async function setActiveMasthead(db: Db, principal: Principal, articleId: string, assetId: string) {
  const object = await getObjectByExternal(db, principal, KINDS.artifact, articleId);
  if (!object) return { error: 'unknown_article' as const };
  const asset: any = await first(db,
    'SELECT * FROM obj_assets WHERE id = ? AND object_id = ? AND workspace_id = ?',
    assetId, object.id, principal.workspaceId);
  if (!asset) return { error: 'unknown_asset' as const };
  if (asset.role !== 'masthead') return { error: 'not_a_masthead' as const };
  const at = nowIso();
  await batch(db, [
    stmt(db, `UPDATE obj_assets SET asset_state = 'historical'
              WHERE object_id = ? AND workspace_id = ? AND asset_state = 'active'`, object.id, principal.workspaceId),
    stmt(db, `UPDATE obj_assets SET asset_state = 'active'
              WHERE id = ? AND object_id = ? AND workspace_id = ?`, assetId, object.id, principal.workspaceId),
  ]);
  const rows = await all(db, 'SELECT * FROM obj_assets WHERE object_id = ? ORDER BY created_at ASC', object.id);
  await recordEvent(db, principal, { objectId: object.id, type: 'masthead.selected', payload: { asset_id: assetId } });
  return {
    ok: true, at,
    masthead: assetView(rows.find((r: any) => r.id === assetId)),
    images: rows.map(assetView).filter((a: any) => a.role !== 'masthead' || a.state !== 'historical'),
  };
}

export async function addAsset(db: Db, principal: Principal, articleId: string, input: {
  filename: string; mime: string; bytes: Uint8Array; instruction?: string; id?: string; createdAt?: string;
  role?: string; provider?: string; referenceAssetId?: string; assetState?: string; revisionId?: string;
  meta?: Record<string, unknown>;
}) {
  const object = await getObjectByExternal(db, principal, KINDS.artifact, articleId);
  if (!object) return { error: 'unknown_article' as const };
  const id = input.id || uuid();
  const role = input.role === 'masthead' ? 'masthead' : 'auto';
  const state = role === 'masthead'
    ? (input.assetState === 'candidate' ? 'candidate' : 'active')
    : 'inline';
  const at = input.createdAt || nowIso();
  const inserts = [];
  // A new active masthead supersedes the old one; the previous image stays as history.
  if (role === 'masthead' && state === 'active') {
    inserts.push(stmt(db, `UPDATE obj_assets SET asset_state = 'historical'
      WHERE object_id = ? AND workspace_id = ? AND asset_state = 'active'`, object.id, principal.workspaceId));
  }
  inserts.push(stmt(db,
    `INSERT INTO obj_assets (id, workspace_id, object_id, filename, mime, size, data, include_flag,
                             instruction, created_at, role, provider, reference_asset_id, asset_state, revision_id, meta_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id, principal.workspaceId, object.id, input.filename, input.mime, input.bytes.length,
    input.bytes, input.instruction || null, at, role, input.provider || null,
    input.referenceAssetId || null, state, input.revisionId || null,
    input.meta ? JSON.stringify(input.meta) : null));
  await batch(db, inserts);
  if (role === 'masthead') {
    await recordEvent(db, principal, {
      objectId: object.id, type: state === 'active' ? 'masthead.generated' : 'masthead.candidate',
      payload: { asset_id: id, provider: input.provider || null },
    });
  }
  return { ok: true, id, filename: input.filename, mime: input.mime, size: input.bytes.length, role, state };
}


/** Toggle inline-image inclusion for an artifact (v1 parity with the legacy UI). */
export async function setAssetsIncluded(db: Db, principal: Principal, articleId: string, ids: string[], include: boolean) {
  const object = await getObjectByExternal(db, principal, KINDS.artifact, articleId);
  if (!object) return { error: 'unknown_article' as const };
  const clean = (Array.isArray(ids) ? ids : []).filter((x) => typeof x === 'string' && x.length <= 128).slice(0, 100);
  for (const id of clean) {
    await run(db, 'UPDATE obj_assets SET include_flag = ? WHERE id = ? AND object_id = ? AND workspace_id = ?',
      include ? 1 : 0, id, object.id, principal.workspaceId);
  }
  return { ok: true, updated: clean.length };
}

export async function deleteAsset(db: Db, principal: Principal, id: string) {
  const row: any = await first(db,
    'SELECT id FROM obj_assets WHERE id = ? AND workspace_id = ?', id, principal.workspaceId);
  if (!row) return { error: 'not_found' as const };
  await run(db, 'DELETE FROM obj_assets WHERE id = ? AND workspace_id = ?', id, principal.workspaceId);
  return { ok: true, id };
}

export async function getAsset(db: Db, principal: Principal, id: string) {
  return first(db,
    'SELECT mime, filename, data FROM obj_assets WHERE id = ? AND workspace_id = ?', id, principal.workspaceId);
}

// D1 hands BLOBs back in more than one shape depending on binding and runtime.
// Normalise before it reaches a Response, or the body silently ends up empty.
export function assetBytes(data: any): Uint8Array | null {
  if (data == null) return null;
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data as any)) {
    const view = data as ArrayBufferView;
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  }
  if (Array.isArray(data)) return Uint8Array.from(data as number[]);
  if (typeof data === 'string') {
    try { return Uint8Array.from(atob(data), (c) => c.charCodeAt(0)); }
    catch { return new TextEncoder().encode(data); }
  }
  if (typeof data === 'object') {
    if (Array.isArray((data as any).data)) return Uint8Array.from((data as any).data);
    if ((data as any).buffer instanceof ArrayBuffer) return new Uint8Array((data as any).buffer);
  }
  return null;
}

export function viewAction(a: any) {
  const input = json(a.input_json);
  const output = json(a.output_json);
  return {
    id: a.id, article_id: a.object_id, kind: a.request_kind || a.action, workflow: a.workflow,
    result_kind: a.workflow ? workflowResultKind(a.workflow) : 'revision',
    text: input.text || '', status: a.status, reply: a.reply || '', error: a.error,
    worker: a.agent, created_at: a.created_at, claimed_at: a.started_at, completed_at: a.completed_at,
    attempts: Number(a.attempts || 0), max_attempts: Number(a.max_attempts || 3),
    next_attempt_at: a.next_attempt_at || null, lease_expires_at: a.lease_expires_at || null,
    base_revision_id: input.base_revision_id || null, revision_id: output.revisionId || null,
    asset_id: output.assetId || null,
    dispositions: Array.isArray(output.dispositions) ? output.dispositions : [],
  };
}
