// Artifact backfill, reconciliation, and reverse export.
// Idempotent by construction: every write upserts on a preserved legacy id.

import { first, all, run, batch, stmt, type Db } from './repo.ts';
import {
  KINDS, LEGACY_ACTION_STATUS, ACTION_TO_LEGACY, nowIso, json, sha256, workflowResultKind,
} from './types.ts';
import type { Principal } from './service.ts';
import {
  ensureWorkspace, createDispatchDraft, publishDispatch, getDispatch, listDispatches,
  latestReviewFor, getReview,
} from './service.ts';

const WS = 'ws_ken';
const INBOX_KINDS = [KINDS.inbox, KINDS.decision];
const KNOWN_INBOX_STATES = new Set(['pending', 'submitted', 'processing', 'blocked']);

function cardData(c: any, actions: any[]) {
  return {
    kind: c.kind || 'handoff', folder: c.folder || 'active', body: c.body || '', actions,
    instruction: c.instruction || null, selections: [], selected_instruction: '',
    created_at: c.created_at || c.synced_at, created_precision: c.created_precision || 'datetime',
    updated_at: c.updated_at || null, submitted_at: c.submitted_at || null,
    processed_at: c.processed_at || null, completed_at: c.completed_at || null,
    disposition: c.disposition || null, source_path: c.source_path || '',
    source_hash: c.content_hash || '', source: 'cards', outbox: false,
  };
}

export async function backfillInbox(db: Db, principal: Principal, opts: { dryRun?: boolean } = {}) {
  await ensureWorkspace(db);
  const sourceCards = await all(db, `SELECT * FROM cards
    WHERE excluded = 0 AND deleted = 0 ORDER BY created_at ASC, orbit_id ASC`);
  const cards = sourceCards.filter((c) => !c.outbox && !['completed', 'outbox'].includes(c.status));
  const terminal = sourceCards.filter((c) => c.outbox || ['completed', 'outbox'].includes(c.status));
  const report: any = {
    generated_at: nowIso(), counts: { eligible: cards.length, decisions: 0, messages: 0 },
    written: { objects: 0, events: 0, actions: 0, terminal_updates: 0 },
    skipped: [], unchanged: 0, managed: 0, unmapped_states: [], dry_run: Boolean(opts.dryRun),
  };
  for (const c of cards) {
    if (!c.orbit_id) { report.skipped.push('card without orbit_id'); continue; }
    let actions: any[];
    try { actions = JSON.parse(c.actions_json || '[]'); } catch { actions = []; report.skipped.push(`${c.orbit_id}: bad actions_json`); }
    actions = Array.isArray(actions) ? actions : [];
    const kind = actions.length || c.instruction ? KINDS.decision : KINDS.inbox;
    if (kind === KINDS.decision) report.counts.decisions += 1; else report.counts.messages += 1;
    const status = KNOWN_INBOX_STATES.has(c.status) ? c.status : 'pending';
    if (!KNOWN_INBOX_STATES.has(c.status)) report.unmapped_states.push({ orbit_id: c.orbit_id, state: c.status });
    const existing = await first(db, `SELECT id, kind, title, status, data_json FROM obj_objects
      WHERE workspace_id = ? AND kind IN (?, ?) AND external_id = ? LIMIT 1`,
      WS, KINDS.inbox, KINDS.decision, c.orbit_id);
    const id = existing?.id || `inbox_${c.orbit_id}`;
    if (existing) {
      const managed = await first(db, `SELECT COUNT(*) AS n FROM obj_agent_actions
        WHERE object_id = ? AND action = 'inbox.decision'`, id);
      if (Number(managed?.n || 0) > 0) { report.managed += 1; continue; }
      const current = json(existing.data_json);
      if (existing.kind === kind && existing.title === (c.title || '(untitled)')
          && existing.status === status && current.source_hash === (c.content_hash || '')) {
        report.unchanged += 1; continue;
      }
    }
    if (!opts.dryRun) {
      await run(db, `INSERT INTO obj_objects
        (id, workspace_id, kind, external_id, title, status, data_json, created_at, updated_at, created_by, legacy_table)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'cards-backfill', 'cards')
        ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, title = excluded.title,
          status = excluded.status, data_json = excluded.data_json, updated_at = excluded.updated_at`,
        id, WS, kind, c.orbit_id, c.title || '(untitled)', status,
        JSON.stringify(cardData(c, actions)), c.created_at || c.synced_at, c.updated_at || c.synced_at);
      if (!existing) {
        await run(db, `INSERT INTO obj_events
          (id, workspace_id, object_id, type, actor, payload_json, created_at)
          VALUES (?, ?, ?, 'inbox.imported', 'cards-backfill', ?, ?) ON CONFLICT(id) DO NOTHING`,
          `event_import_${c.orbit_id}`, WS, id, JSON.stringify({ orbit_id: c.orbit_id, source_hash: c.content_hash || '' }), nowIso());
      }
    }
    report.written.objects += 1;
    if (!existing) report.written.events += 1;
  }
  for (const c of terminal) {
    const existing = await first(db, `SELECT id, status, data_json FROM obj_objects
      WHERE workspace_id = ? AND legacy_table = 'cards' AND external_id = ? LIMIT 1`, WS, c.orbit_id);
    if (!existing) continue; // Never import outbox history as a new object.
    const current = json(existing.data_json);
    if (current.outbox || ['completed', 'closed', 'dismissed', 'outboxed'].includes(existing.status)) continue;
    if (!opts.dryRun) {
      await run(db, `UPDATE obj_objects SET status = 'completed', data_json = ?, updated_at = ?
        WHERE id = ? AND workspace_id = ?`,
        JSON.stringify({ ...current, outbox: true, folder: c.folder || 'outbox',
          completed_at: c.completed_at || c.updated_at || nowIso(), disposition: c.disposition || current.disposition || null,
          source_hash: c.content_hash || current.source_hash || '' }),
        c.updated_at || nowIso(), existing.id, WS);
    }
    report.written.terminal_updates += 1;
  }
  return report;
}

export async function reconcileInbox(db: Db, principal: Principal) {
  const cards = await all(db, `SELECT orbit_id, title, content_hash, status FROM cards
    WHERE excluded = 0 AND deleted = 0 AND outbox = 0
      AND status NOT IN ('completed', 'outbox') ORDER BY orbit_id ASC`);
  const objects = await all(db, `SELECT external_id, title, status, data_json FROM obj_objects
    WHERE workspace_id = ? AND legacy_table = 'cards' AND kind IN (?, ?) AND deleted_at IS NULL`,
    WS, KINDS.inbox, KINDS.decision);
  const byId = new Map(objects.map((o) => [o.external_id, o]));
  const missing: string[] = [];
  const mismatches: any[] = [];
  const unmappedStates: any[] = [];
  for (const c of cards) {
    const o: any = byId.get(c.orbit_id);
    if (!o) { missing.push(c.orbit_id); continue; }
    const data = json(o.data_json);
    if (o.title !== c.title || data.source_hash !== (c.content_hash || '')) {
      mismatches.push({ orbit_id: c.orbit_id, title: o.title !== c.title, source_hash: data.source_hash !== (c.content_hash || '') });
    }
    if (!KNOWN_INBOX_STATES.has(c.status)) unmappedStates.push({ orbit_id: c.orbit_id, state: c.status });
  }
  const eligible = new Set(cards.map((c) => c.orbit_id));
  const extras = objects.filter((o) => {
    if (eligible.has(o.external_id)) return false;
    const data = json(o.data_json);
    return !data.outbox && !['completed', 'closed', 'dismissed', 'outboxed'].includes(o.status);
  }).map((o) => o.external_id);
  const historicalActions = await first(db, `SELECT COUNT(*) AS n FROM obj_agent_actions a
    JOIN obj_objects o ON o.id = a.object_id
    WHERE o.legacy_table = 'cards' AND a.action = 'inbox.decision'`);
  return {
    generated_at: nowIso(), counts: { cards: cards.length, objects: objects.length },
    missing, mismatches, extras, unmapped_states: unmappedStates,
    imported_actions: Number(historicalActions?.n || 0),
    ok: !missing.length && !mismatches.length && !extras.length && !unmappedStates.length && Number(historicalActions?.n || 0) === 0,
  };
}

export async function backfillArtifacts(db: Db, principal: Principal, opts: { dryRun?: boolean } = {}) {
  await ensureWorkspace(db);
  const articles = await all(db, 'SELECT * FROM poc_articles ORDER BY created_at ASC');
  const revisions = await all(db, 'SELECT * FROM poc_revisions ORDER BY article_id ASC, number ASC');
  const events = await all(db, 'SELECT * FROM poc_events ORDER BY created_at ASC');
  const requests = await all(db, 'SELECT * FROM poc_requests ORDER BY created_at ASC');
  const images = await all(db, 'SELECT * FROM poc_images ORDER BY created_at ASC');

  const report: any = {
    generated_at: nowIso(),
    counts: {
      articles: articles.length, revisions: revisions.length, events: events.length,
      requests: requests.length, images: images.length,
    },
    written: { objects: 0, revisions: 0, actions: 0, messages: 0, assets: 0 },
    skipped: [] as string[],
    errors: [] as string[],
  };

  for (const a of articles) {
    if (!a?.id) { report.skipped.push('article without id'); continue; }
    const revs = revisions.filter((r) => r.article_id === a.id);
    const current = revs[revs.length - 1] || null;
    const stmts = [
      stmt(db, `INSERT INTO obj_objects
          (id, workspace_id, kind, external_id, slug, title, status, data_json, created_at, updated_at,
           created_by, current_revision_id, revision_count, legacy_table)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ken', ?, ?, 'poc_articles')
        ON CONFLICT(id) DO UPDATE SET
          title = excluded.title, data_json = excluded.data_json,
          current_revision_id = excluded.current_revision_id, revision_count = excluded.revision_count,
          updated_at = excluded.updated_at`,
        a.id, WS, KINDS.artifact, a.id, a.id, a.title,
        a.closed_at ? 'closed' : 'active',
        JSON.stringify({ canonical_path: a.canonical_path || '', closed_at: a.closed_at || null }),
        a.created_at, current?.created_at || a.created_at, current?.id || null, revs.length),
    ];
    for (const r of revs) {
      stmts.push(stmt(db, `INSERT INTO obj_revisions
          (id, object_id, number, content, content_hash, source, actor, created_at,
           legacy_id, base_revision_id, status)
        VALUES (?, ?, ?, ?, ?, ?, 'ken', ?, ?, ?, 'published')
        ON CONFLICT(id) DO UPDATE SET content = excluded.content, content_hash = excluded.content_hash`,
        r.id, a.id, r.number, r.markdown, r.sha256 || await sha256(r.markdown || ''),
        r.source || 'seed', r.created_at, r.id, null));
    }
    if (!opts.dryRun) await batch(db, stmts);
    report.written.objects += 1;
    report.written.revisions += revs.length;
  }

  for (const e of events) {
    if (!e?.id || !e.article_id) { report.skipped.push('event without article'); continue; }
    if (!opts.dryRun) {
      await run(db, `INSERT INTO obj_objects
          (id, workspace_id, kind, external_id, title, status, data_json, created_at, updated_at, created_by)
        VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, 'system')
        ON CONFLICT(id) DO NOTHING`,
        e.id, WS, KINDS.message, e.id, (e.text || '').slice(0, 90),
        JSON.stringify({ role: e.role, text: e.text, artifact_id: e.article_id, request_id: e.request_id || null, meta: e.meta || null }),
        e.created_at, e.created_at);
      await run(db, `INSERT INTO obj_relationships
          (id, workspace_id, from_object_id, to_object_id, relation, metadata_json, created_at)
        VALUES (?, ?, ?, ?, 'in', '{}', ?) ON CONFLICT(from_object_id, to_object_id, relation) DO NOTHING`,
        `rel_msg_${e.id}`, WS, e.id, e.article_id, e.created_at);
    }
    report.written.messages += 1;
  }

  for (const r of requests) {
    if (!r?.id || !r.article_id) { report.skipped.push('request without article'); continue; }
    const status = LEGACY_ACTION_STATUS[r.status] || 'pending';
    const payload = { text: r.text || '', workflow: r.workflow || null, kind: r.kind, base_revision_id: r.base_revision_id };
    if (!opts.dryRun) {
      await run(db, `INSERT INTO obj_agent_actions
          (id, workspace_id, object_id, agent, action, status, idempotency_key, input_json,
           output_json, error, reply, workflow, request_kind, legacy_id, created_at, started_at, completed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          status = excluded.status, reply = excluded.reply, error = excluded.error`,
        r.id, WS, r.article_id, r.worker || 'openclaw', r.kind, status, r.idempotency_key,
        JSON.stringify(payload), JSON.stringify({ reply: r.reply || null }),
        r.error || null, r.reply || null, r.workflow || null, r.kind, r.id,
        r.created_at, r.claimed_at || null, r.completed_at || null);
      await run(db, `INSERT INTO obj_objects
          (id, workspace_id, kind, external_id, title, status, data_json, created_at, updated_at, created_by)
        VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, 'ken') ON CONFLICT(id) DO NOTHING`,
        r.id, WS, KINDS.feedback, r.id,
        r.kind === 'workflow' ? `Run workflow: ${r.workflow}` : (r.text || '').slice(0, 120),
        JSON.stringify({ text: r.text, workflow: r.workflow, kind: r.kind, action_id: r.id }),
        r.created_at, r.created_at);
      await run(db, `INSERT INTO obj_relationships
          (id, workspace_id, from_object_id, to_object_id, relation, metadata_json, created_at)
        VALUES (?, ?, ?, ?, 'targets', '{}', ?) ON CONFLICT(from_object_id, to_object_id, relation) DO NOTHING`,
        `rel_fb_${r.id}`, WS, r.id, r.article_id, r.created_at);
      if (r.base_revision_id) {
        await run(db, `INSERT INTO obj_relationships
            (id, workspace_id, from_object_id, to_object_id, relation, metadata_json, created_at)
          VALUES (?, ?, ?, ?, 'references', '{}', ?) ON CONFLICT(from_object_id, to_object_id, relation) DO NOTHING`,
          `rel_ref_${r.id}`, WS, r.id, r.base_revision_id, r.created_at);
      }
    }
    report.written.actions += 1;
  }

  for (const img of images) {
    if (!img?.id || !img.article_id) { report.skipped.push('image without article'); continue; }
    if (!opts.dryRun) {
      await run(db, `INSERT INTO obj_assets
          (id, workspace_id, object_id, request_id, filename, mime, size, data, include_flag, instruction, legacy_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`,
        img.id, WS, img.article_id, img.request_id || null, img.filename, img.mime, img.size,
        img.data, img.include_flag ? 1 : 0, img.instruction || null, img.id, img.created_at);
    }
    report.written.assets += 1;
  }

  return report;
}

export async function reconcileArtifacts(db: Db, principal: Principal) {
  const articles = await all(db, 'SELECT id FROM poc_articles');
  const objArtifacts = await all(db,
    'SELECT id FROM obj_objects WHERE workspace_id = ? AND kind = ?', WS, KINDS.artifact);
  const legacyRev = await all(db, 'SELECT id FROM poc_revisions');
  const objRev = await all(db, 'SELECT legacy_id FROM obj_revisions WHERE legacy_id IS NOT NULL');
  const legacyReq = await all(db, 'SELECT id FROM poc_requests');
  const objAct = await all(db, 'SELECT legacy_id FROM obj_agent_actions WHERE legacy_id IS NOT NULL');

  const objArtIds = new Set(objArtifacts.map((r) => r.id));
  const objRevIds = new Set(objRev.map((r) => r.legacy_id));
  const objActIds = new Set(objAct.map((r) => r.legacy_id));

  const missing = {
    articles: articles.filter((a) => !objArtIds.has(a.id)).map((a) => a.id),
    revisions: legacyRev.filter((r) => !objRevIds.has(r.id)).map((r) => r.id),
    requests: legacyReq.filter((r) => !objActIds.has(r.id)).map((r) => r.id),
  };

  const hashMismatch: any[] = [];
  for (const row of await all(db, 'SELECT id, number, markdown, sha256 FROM poc_revisions')) {
    const obj = await first(db, 'SELECT content_hash FROM obj_revisions WHERE legacy_id = ?', row.id);
    if (!obj) continue;
    const expected = row.sha256 || await sha256(row.markdown || '');
    if (obj.content_hash !== expected) hashMismatch.push({ id: row.id, number: row.number });
  }

  return {
    generated_at: nowIso(),
    counts: {
      legacy: { articles: articles.length, revisions: legacyRev.length, requests: legacyReq.length },
      objects: { articles: objArtifacts.length, revisions: objRev.length, requests: objAct.length },
    },
    missing,
    hashMismatch,
    orphanObjects: await all(db,
      `SELECT id FROM obj_objects WHERE workspace_id = ? AND kind = ? AND id NOT IN (SELECT object_id FROM obj_revisions)`,
      WS, KINDS.artifact).then((r) => r.map((x) => x.id)),
    ok: !missing.articles.length && !missing.revisions.length && !missing.requests.length && !hashMismatch.length,
  };
}

// Reverse sync for rollback: write object-model state back into poc_* before flipping the flag.
export async function exportLegacy(db: Db, principal: Principal) {
  const objects = await all(db,
    `SELECT * FROM obj_objects WHERE workspace_id = ? AND kind = ? AND deleted_at IS NULL`, WS, KINDS.artifact);
  let revisions = 0, actions = 0;
  const cols = new Set((await all(db, 'PRAGMA table_info(poc_articles)')).map((c: any) => c.name));
  const hasClosed = cols.has('closed_at');
  for (const o of objects) {
    const data = json(o.data_json);
    if (hasClosed) {
      await run(db, `INSERT INTO poc_articles (id, title, canonical_path, created_at, closed_at)
          VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET title = excluded.title, canonical_path = excluded.canonical_path,
          closed_at = excluded.closed_at`,
        o.id, o.title, data.canonical_path || '', o.created_at, data.closed_at || null);
    } else {
      await run(db, `INSERT INTO poc_articles (id, title, canonical_path, created_at)
          VALUES (?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET title = excluded.title, canonical_path = excluded.canonical_path`,
        o.id, o.title, data.canonical_path || '', o.created_at);
    }

    for (const r of await all(db, 'SELECT * FROM obj_revisions WHERE object_id = ? ORDER BY number ASC', o.id)) {
      await run(db, `INSERT INTO poc_revisions
          (id, article_id, number, markdown, sha256, source, workflow, request_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?)
        ON CONFLICT(id) DO UPDATE SET markdown = excluded.markdown, sha256 = excluded.sha256`,
        r.id, o.id, r.number, r.content, r.content_hash, r.source, r.created_at);
      revisions += 1;
    }

    for (const a of await all(db, 'SELECT * FROM obj_agent_actions WHERE object_id = ?', o.id)) {
      const input = json(a.input_json);
      await run(db, `INSERT INTO poc_requests
          (id, article_id, base_revision_id, kind, workflow, text, idempotency_key, status,
           reply, error, worker, created_at, claimed_at, completed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET status = excluded.status, reply = excluded.reply, error = excluded.error`,
        a.id, o.id, input.base_revision_id || a.object_id, a.request_kind || a.action,
        a.workflow || null, input.text || '', a.idempotency_key || a.id,
        ACTION_TO_LEGACY[a.status] || 'submitted', a.reply || '', a.error || null,
        a.agent || 'openclaw', a.created_at, a.started_at || null, a.completed_at || null);
      actions += 1;
    }
  }
  return { exported: { artifacts: objects.length, revisions, actions } };
}

export async function queueForBridge(db: Db, principal: Principal, limit = 5) {
  await run(db, `UPDATE obj_agent_actions SET status = 'stale', lease_expires_at = NULL, claim_token = NULL
    WHERE workspace_id = ? AND status IN ('claimed', 'working', 'needs_input')
      AND lease_expires_at IS NOT NULL AND lease_expires_at < ?`, principal.workspaceId, nowIso());
  const rows = await all(db, `SELECT * FROM obj_agent_actions
    WHERE workspace_id = ? AND status IN ('pending', 'stale')
      AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
    ORDER BY created_at ASC LIMIT ?`, principal.workspaceId, nowIso(), Math.min(Math.max(limit, 1), 20));
  const out = [];
  for (const a of rows) {
    const input = json(a.input_json);
    if (a.action === 'inbox.decision') {
      const object = await first(db, `SELECT title, data_json FROM obj_objects
        WHERE id = ? AND workspace_id = ? AND kind = ?`, a.object_id, principal.workspaceId, KINDS.decision);
      if (!object) continue;
      const data = json(object.data_json);
      out.push({
        id: a.id, action: 'inbox.decision', kind: 'inbox.decision', object_id: a.object_id,
        title: object.title, body: data.body || '', choices: input.choices || [],
        instruction: input.instruction || '', status: a.status, attempts: a.attempts || 0,
      });
      continue;
    }
    // Work sessions carry their own context; the bridge fetches it from /work/:id.
    if (a.action === 'work.plan' || a.action === 'work.execute' || a.action === 'work.explore') {
      const object: any = await first(db,
        `SELECT external_id, slug FROM obj_objects
          WHERE id = ? AND workspace_id = ? AND kind = 'orbit.work' AND deleted_at IS NULL`,
        a.object_id, principal.workspaceId);
      if (!object) continue;
      out.push({
        id: a.id, action: a.action, kind: 'work', object_id: a.object_id,
        work_id: object.external_id || object.slug,
        mode: a.action === 'work.plan' ? 'plan' : (a.action === 'work.explore' ? 'explore' : 'execute'),
        reason: input.reason || null, status: a.status, attempts: a.attempts || 0,
      });
      continue;
    }

    const base = input.base_revision_id
      ? await first(db, 'SELECT id, number, content AS markdown FROM obj_revisions WHERE id = ?', input.base_revision_id)
      : null;
    const images = await all(db,
      `SELECT id, filename, mime, size, instruction, role, asset_state FROM obj_assets
        WHERE object_id = ? AND (include_flag = 1 OR role = 'masthead') ORDER BY created_at ASC`, a.object_id);
    const history = await all(db,
      `SELECT data_json, created_at FROM obj_objects
        WHERE workspace_id = ? AND kind = ? AND data_json LIKE ?
        ORDER BY created_at ASC`, principal.workspaceId, KINDS.message, `%\"artifact_id\":\"${a.object_id}\"%`);
    const artifactAction = String(a.request_kind || a.action || 'feedback');
    // Prefer the review the user explicitly linked. The base revision can move
    // between submit and pickup, which would silently drop the critique otherwise.
    let review = null;
    if (input.review_id) {
      const linked: any = await getReview(db, principal, String(input.review_id));
      if (linked && !linked.error) review = linked;
    }
    if (!review && base) review = await latestReviewFor(db, principal, a.object_id, base.id);
    // Masthead and publication workflows have their own handlers; everything else
    // stays on the generic artifact handler.
    const actionName = a.workflow === 'generate-masthead' ? 'artifact.masthead'
      : a.workflow === 'publish-post' ? 'artifact.publish'
      : (artifactAction.startsWith('artifact.') ? artifactAction : `artifact.${artifactAction}`);
    const mastheadRow: any = await first(db,
      `SELECT * FROM obj_assets WHERE object_id = ? AND workspace_id = ? AND role = 'masthead' AND asset_state = 'active' LIMIT 1`,
      a.object_id, principal.workspaceId);
    const publicationRow: any = await first(db,
      `SELECT * FROM obj_objects WHERE workspace_id = ? AND kind = ? AND deleted_at IS NULL
         AND json_extract(data_json, '$.artifact_id') = ? ORDER BY created_at DESC LIMIT 1`,
      principal.workspaceId, KINDS.publication, a.object_id);
    out.push({
      id: a.id, action: actionName, article_id: a.object_id,
      object_id: a.object_id, kind: a.request_kind || a.action,
      workflow: a.workflow, text: input.text || '', status: a.status, attempts: a.attempts || 0,
      options: input.options && typeof input.options === 'object' ? input.options : {},
      masthead: mastheadRow ? {
        id: mastheadRow.id, filename: mastheadRow.filename, mime: mastheadRow.mime,
        provider: mastheadRow.provider || null, reference_asset_id: mastheadRow.reference_asset_id || null,
      } : null,
      publication: publicationRow ? { id: publicationRow.id, data: json(publicationRow.data_json) } : null,
      result_kind: a.workflow ? workflowResultKind(a.workflow) : 'revision',
      review_id: input.review_id || null,
      critique: review ? {
        id: review.id, workflow: review.workflow, targetRevisionId: review.targetRevisionId,
        summary: review.summary, findings: review.findings, notes: review.notes,
        overallNote: review.overallNote,
      } : null,
      base: base ? { id: base.id, number: base.number, markdown: base.markdown } : null,
      images: images.filter((i: any) => i.role !== 'masthead').map((i: any) => ({ id: i.id, filename: i.filename, mime: i.mime, size: i.size, instruction: i.instruction })),
      history: history.map((h) => ({ role: json(h.data_json).role || 'system', text: json(h.data_json).text || '', created_at: h.created_at })),
    });
  }
  return out;
}

// ------------------------------------------------------- dispatch migration ---

export type LegacyDispatch = {
  slug: string; title?: string; summary?: string; tags?: string[]; source_urls?: string[];
  author?: string; published_at?: string; legacy_path?: string; content?: string; checksum?: string;
};

export async function backfillDispatches(db: Db, principal: Principal, entries: LegacyDispatch[], opts: { dryRun?: boolean } = {}) {
  await ensureWorkspace(db);
  const report: any = {
    generated_at: nowIso(), input: entries.length, created: 0, published: 0, duplicates: 0,
    slug_collisions: [], missing_metadata: [], failures: [], dry_run: Boolean(opts.dryRun),
  };
  for (const raw of entries) {
    const slug = String(raw?.slug || '').trim();
    const title = String(raw?.title || '').trim();
    const content = String(raw?.content || '');
    const missing = [];
    if (!slug) missing.push('slug');
    if (!title) missing.push('title');
    if (!raw?.published_at) missing.push('published_at');
    if (!content) missing.push('content');
    if (missing.length) {
      report.missing_metadata.push({ slug: slug || null, fields: missing });
      continue;
    }
    try {
      const computed = await sha256(content);
      if (raw.checksum && raw.checksum !== computed) {
        report.failures.push({ slug, error: 'checksum_mismatch', expected: raw.checksum, actual: computed });
        continue;
      }
      const existing = await getDispatch(db, principal, slug);
      if (existing) {
        if (existing.content_hash === computed) report.duplicates += 1;
        else report.slug_collisions.push({ slug, existing_id: existing.id, existing_hash: existing.content_hash, incoming_hash: computed });
        continue;
      }
      if (opts.dryRun) { report.created += 1; report.published += 1; continue; }
      const made: any = await createDispatchDraft(db, principal, {
        slug, title, content, summary: raw.summary || '', tags: raw.tags || [],
        sourceUrls: raw.source_urls || [], author: raw.author || 'Ken', publishedAt: raw.published_at,
        legacyPath: raw.legacy_path || `src/content/notes/${slug}.md`, source: 'import',
        createdAt: raw.published_at,
      });
      if (made.error) {
        if (made.error === 'slug_collision') report.slug_collisions.push({ slug, existing_id: made.existingId });
        else report.failures.push({ slug, error: made.error });
        continue;
      }
      if (made.duplicate) { report.duplicates += 1; continue; }
      report.created += 1;
      const published: any = await publishDispatch(db, principal, made.dispatch.id, { publishedAt: raw.published_at });
      if (published.error) report.failures.push({ slug, error: published.error });
      else report.published += 1;
    } catch (error: any) {
      report.failures.push({ slug, error: error?.message || String(error) });
    }
  }
  report.ok = report.slug_collisions.length === 0 && report.failures.length === 0 && report.missing_metadata.length === 0;
  return report;
}

export async function reconcileDispatches(db: Db, principal: Principal, entries: LegacyDispatch[]) {
  const report: any = { generated_at: nowIso(), input: entries.length, matched: 0, missing: [], mismatches: [], extras: [] };
  const seen = new Set();
  for (const raw of entries) {
    const slug = String(raw?.slug || '').trim();
    if (!slug) continue;
    seen.add(slug);
    const object = await getDispatch(db, principal, slug);
    if (!object) { report.missing.push(slug); continue; }
    const expected = raw.checksum || await sha256(String(raw.content || ''));
    const fields: any = {};
    if (object.content_hash !== expected) fields.content_hash = { expected, actual: object.content_hash };
    if (raw.title && object.title !== raw.title) fields.title = { expected: raw.title, actual: object.title };
    if (raw.published_at && object.published_at !== raw.published_at) fields.published_at = { expected: raw.published_at, actual: object.published_at };
    if (Object.keys(fields).length) report.mismatches.push({ slug, fields }); else report.matched += 1;
  }
  for (const status of ['draft', 'published', 'archived'] as const) {
    let offset = 0;
    for (;;) {
      const page = await listDispatches(db, principal, { status, limit: 100, offset });
      for (const item of page.dispatches) if (!seen.has(item.slug)) report.extras.push({ slug: item.slug, status });
      if (page.nextOffset === null) break;
      offset = page.nextOffset;
    }
  }
  report.ok = report.missing.length === 0 && report.mismatches.length === 0;
  return report;
}

export async function exportDispatches(db: Db, principal: Principal, opts: { slug?: string; status?: 'draft' | 'published' | 'archived' } = {}) {
  const rows: any[] = [];
  if (opts.slug) {
    const one = await getDispatch(db, principal, opts.slug);
    if (one) rows.push(one);
  } else {
    const statuses = opts.status ? [opts.status] : ['draft', 'published', 'archived'] as const;
    for (const status of statuses) {
      let offset = 0;
      for (;;) {
        const page = await listDispatches(db, principal, { status, limit: 100, offset });
        for (const item of page.dispatches) {
          const full = await getDispatch(db, principal, item.id);
          if (full) rows.push(full);
        }
        if (page.nextOffset === null) break;
        offset = page.nextOffset;
      }
    }
  }
  return { dispatches: rows, count: rows.length, exported_at: nowIso() };
}
