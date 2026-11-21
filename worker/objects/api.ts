// Orbit API v1 — the stable HTTP surface for the browser, OpenClaw, and future clients.
// Auth at the boundary; workspace comes from the principal, never from the client.

import { resolveStorageMode } from './flags.js';
import { handleArtifactPoc } from '../artifact-poc.js';
import {
  userPrincipal, ensureWorkspace, getObject, getObjectByExternal, listObjects, createObject,
  updateObject, createRevision, listRevisions, getRevision, addRelation, listRelations,
  recordEvent, claimAction, heartbeatAction, progressAction, completeAction, failAction,
  updateInboxItem, artifactState, artifactList, artifactRevisionMarkdown, submitFeedback, closeArtifact,
  addAsset, getAsset, viewAction, setActiveMasthead, recordPublication, setAssetsIncluded, deleteAsset, type Principal,
  publishReview, listReviews, getReview, setFindingNote, setReviewNote, critiqueContext,
  completeActionWithResult,
  createInboxItem, listInbox, getInboxItem, patchInboxSelections,
  submitInboxDecision, closeInboxItem,
  createDispatchDraft, listDispatches, getDispatch, publishDispatch, reviseDispatch,
  patchDispatch, archiveDispatch,
  assetBytes,
} from './service.ts';
import {
  backfillArtifacts, reconcileArtifacts, exportLegacy, queueForBridge,
  backfillInbox, reconcileInbox,
  backfillDispatches, reconcileDispatches, exportDispatches,
} from './migrate.ts';
import { KINDS, IMAGE_MIMES, MAX_IMAGE_BYTES, LEASE_MS, clampText } from './types.ts';
import { handleWorkApi } from './work.ts';

const API = '/api/v1';

function json(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}
const err = (code: string, status = 400, extra: any = {}) => json({ error: code, ...extra }, status);

function same(a: string, b: string) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

async function hashToken(token: string) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function agentPrincipal(request: Request, env: any): Promise<Principal | null> {
  const header = request.headers.get('Authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) return null;
  if (env.ORBIT_ARTIFACT_BRIDGE_TOKEN && same(token, env.ORBIT_ARTIFACT_BRIDGE_TOKEN)) {
    return { kind: 'agent', id: 'openclaw', workspaceId: 'ws_ken', scopes: ['agent', 'artifacts'] };
  }
  if (env.ORBIT_INBOX_TOKEN && same(token, env.ORBIT_INBOX_TOKEN)) {
    return { kind: 'agent', id: 'inbox-sync', workspaceId: 'ws_ken', scopes: ['agent', 'inbox'] };
  }
  if (env.ORBIT_OBJECTS_DB) {
    const hash = await hashToken(token);
    const row = await env.ORBIT_OBJECTS_DB.prepare(
      'SELECT id, workspace_id, scopes FROM obj_api_tokens WHERE token_hash = ? AND revoked_at IS NULL',
    ).bind(hash).first();
    if (row) return { kind: 'agent', id: row.id, workspaceId: row.workspace_id, scopes: String(row.scopes).split(',') };
  }
  return null;
}

function b64ToBytes(b64: string) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function legacyUrl(url: URL, path: string) {
  const target = new URL(url.origin + '/api/lab/artifact' + path);
  return target;
}

export async function handleObjectsApi(request: Request, env: any, url: URL, ctx: { authed: boolean; principal?: any }) {
  if (!url.pathname.startsWith(API)) return null;

  const agent = await agentPrincipal(request, env);
  const authed = ctx.authed || Boolean(agent);
  if (!authed) return err('unauthorized', 401);

  // Hosted installs supply the authenticated workspace principal; self-hosted falls back.
  const principal = agent || ctx.principal || userPrincipal('ws_ken');
  const db = env.ORBIT_OBJECTS_DB;
  const route = url.pathname.slice(API.length).replace(/\/+$/, '') || '/';

  // CSRF: cookie-authenticated writes must come from the same origin.
  if (!agent && request.method !== 'GET') {
    const origin = request.headers.get('Origin');
    if (origin && origin !== url.origin) return err('bad_origin', 403);
  }

  // Work has its own additive domain; all other routes fall through unchanged.
  const work = await handleWorkApi(request, { db, principal, agent, url, route, env });
  if (work) return work;

  // Migration tooling is agent-only and idempotent.
  if (route === '/migrate/artifacts' && request.method === 'POST') {
    if (!agent) return err('forbidden', 403);
    if (!db) return err('db_not_configured', 503);
    await ensureWorkspace(db);
    return json(await backfillArtifacts(db, principal, { dryRun: url.searchParams.get('dryRun') === '1' }));
  }
  if (route === '/migrate/reconcile' && request.method === 'GET') {
    if (!agent) return err('forbidden', 403);
    return json(await reconcileArtifacts(db, principal));
  }
  if (route === '/migrate/export-legacy' && request.method === 'POST') {
    if (!agent) return err('forbidden', 403);
    return json(await exportLegacy(db, principal));
  }
  if (route === '/migrate/inbox' && request.method === 'POST') {
    if (!agent) return err('forbidden', 403);
    if (!db) return err('db_not_configured', 503);
    return json(await backfillInbox(db, principal, { dryRun: url.searchParams.get('dryRun') === '1' }));
  }
  if (route === '/migrate/inbox/reconcile' && request.method === 'GET') {
    if (!agent) return err('forbidden', 403);
    if (!db) return err('db_not_configured', 503);
    return json(await reconcileInbox(db, principal));
  }
  if (route === '/migrate/dispatches' && request.method === 'POST') {
    if (!agent) return err('forbidden', 403);
    if (!db) return err('db_not_configured', 503);
    let body: any; try { body = await request.json(); } catch { return err('bad_json'); }
    const entries = Array.isArray(body?.dispatches) ? body.dispatches : [];
    return json(await backfillDispatches(db, principal, entries, { dryRun: url.searchParams.get('dryRun') === '1' }));
  }
  if (route === '/migrate/dispatches/reconcile' && request.method === 'POST') {
    if (!agent) return err('forbidden', 403);
    if (!db) return err('db_not_configured', 503);
    let body: any; try { body = await request.json(); } catch { return err('bad_json'); }
    return json(await reconcileDispatches(db, principal, Array.isArray(body?.dispatches) ? body.dispatches : []));
  }
  if (route === '/migrate/dispatches/export' && request.method === 'GET') {
    if (!agent) return err('forbidden', 403);
    if (!db) return err('db_not_configured', 503);
    const result = await exportDispatches(db, principal);
    const slug = url.searchParams.get('slug');
    return json(slug ? { ...result, dispatches: result.dispatches.filter((x: any) => x.slug === slug), count: result.dispatches.filter((x: any) => x.slug === slug).length } : result);
  }

  if (!db) return err('db_not_configured', 503);
  await ensureWorkspace(db);

  // ---- dispatches --------------------------------------------------------
  if (route === '/dispatches' && request.method === 'GET') {
    const status = String(url.searchParams.get('status') || 'published');
    if (!['draft', 'published', 'archived'].includes(status)) return err('bad_status');
    return json(await listDispatches(db, principal, {
      status: status as any,
      limit: Number(url.searchParams.get('limit') || 20),
      offset: Number(url.searchParams.get('offset') || 0),
    }));
  }
  if (route === '/dispatches' && request.method === 'POST') {
    let body: any; try { body = await request.json(); } catch { return err('bad_json'); }
    const result: any = await createDispatchDraft(db, principal, {
      slug: body.slug, title: body.title, content: String(body.content || body.markdown || ''),
      summary: body.summary, tags: body.tags, sourceUrls: body.source_urls || body.sourceUrls,
      author: body.author, publishedAt: body.published_at || body.publishedAt,
      legacyPath: body.legacy_path || body.legacyPath,
      idempotencyKey: String(body.idempotencyKey || request.headers.get('Idempotency-Key') || '') || null,
      source: body.source || 'api',
    });
    if (result.error) return err(result.error, result.error === 'slug_collision' ? 409 : 400, result);
    return json(result, result.duplicate ? 200 : 201);
  }
  const dispatchOne = route.match(/^\/dispatches\/([^/]+)$/);
  if (dispatchOne && request.method === 'GET') {
    const dispatch = await getDispatch(db, principal, decodeURIComponent(dispatchOne[1]));
    return dispatch ? json({ dispatch }) : err('not_found', 404);
  }
  if (dispatchOne && request.method === 'PATCH') {
    let body: any; try { body = await request.json(); } catch { return err('bad_json'); }
    const result: any = await patchDispatch(db, principal, decodeURIComponent(dispatchOne[1]), body);
    return result.error ? err(result.error, 404) : json(result);
  }
  const dispatchPublish = route.match(/^\/dispatches\/([^/]+)\/publish$/);
  if (dispatchPublish && request.method === 'POST') {
    let body: any; try { body = await request.json(); } catch { body = {}; }
    const result: any = await publishDispatch(db, principal, decodeURIComponent(dispatchPublish[1]), {
      publishedAt: body.published_at || body.publishedAt, publishedFromId: body.published_from || body.publishedFromId,
    });
    if (result.error) return err(result.error, result.error === 'not_found' ? 404 : 409);
    return json(result);
  }
  const dispatchRevisions = route.match(/^\/dispatches\/([^/]+)\/revisions$/);
  if (dispatchRevisions && request.method === 'POST') {
    let body: any; try { body = await request.json(); } catch { return err('bad_json'); }
    const result: any = await reviseDispatch(db, principal, decodeURIComponent(dispatchRevisions[1]), {
      content: String(body.content || body.markdown || ''),
      expectedRevisionId: body.expectedRevisionId, source: body.source || 'api',
    });
    if (result.error) {
      const status = result.error === 'not_found' ? 404 : result.error === 'expected_revision_required' ? 400 : 409;
      return err(result.error, status, result.currentRevisionId ? { currentRevisionId: result.currentRevisionId } : {});
    }
    return json(result, 201);
  }
  // ---- dispatch feedback (reader reactions on a published note) -----------
  const dispatchFeedback = route.match(/^\/dispatches\/([^/]+)\/feedback$/);
  if (dispatchFeedback) {
    const dispatch = await getDispatch(db, principal, decodeURIComponent(dispatchFeedback[1]));
    if (!dispatch) return err('not_found', 404);
    const slug = (dispatch as any).slug || decodeURIComponent(dispatchFeedback[1]);

    if (request.method === 'GET') {
      const listed: any = await listObjects(db, principal, { kind: KINDS.dispatchFeedback, limit: 200, offset: 0 });
      const rows = (listed.objects || listed || []).filter((o: any) => (o.data || {}).slug === slug);
      return json({ feedback: rows, count: rows.length });
    }

    if (request.method === 'POST') {
      let body: any; try { body = await request.json(); } catch { return err('bad_json'); }
      const TYPES = ['useful', 'already_knew', 'not_relevant', 'acted_on'];
      const type = String(body.type || '');
      if (!TYPES.includes(type)) return err('bad_type');
      const eventId = String(body.event_id || '').trim();
      if (!eventId) return err('event_id_required');
      const externalId = `feedback:${slug}:${eventId}`;
      const existing = await getObjectByExternal(db, principal, KINDS.dispatchFeedback, externalId);
      if (existing) return json({ object: existing, duplicate: true }, 200);
      const object = await createObject(db, principal, {
        kind: KINDS.dispatchFeedback,
        externalId,
        slug: externalId,
        title: `Feedback · ${type} · ${slug}`,
        status: 'active',
        data: {
          dispatch_id: (dispatch as any).id,
          slug,
          type,
          comment: body.comment ? String(body.comment).slice(0, 2000) : null,
          project: body.project ? String(body.project).slice(0, 120) : null,
          source: body.source ? String(body.source).slice(0, 40) : 'orbit-web',
          event_id: eventId,
          created_at: new Date().toISOString(),
        },
      });
      await addRelation(db, principal, object!.id, { toObjectId: (dispatch as any).id, relation: 'targets' });
      return json({ object }, 201);
    }
  }

  const dispatchArchive = route.match(/^\/dispatches\/([^/]+)\/archive$/);
  if (dispatchArchive && request.method === 'POST') {
    const result: any = await archiveDispatch(db, principal, decodeURIComponent(dispatchArchive[1]));
    if (result.error) return err(result.error, result.error === 'not_found' ? 404 : 409);
    return json(result);
  }

  // ---- inbox -------------------------------------------------------------
  if (route === '/inbox' && request.method === 'GET') {
    const scope = url.searchParams.get('scope') || 'all';
    if (!['all', 'active', 'outbox', 'outboxed'].includes(scope)) return err('bad_scope');
    return json(await listInbox(db, principal, scope));
  }
  if (route === '/inbox' && request.method === 'POST') {
    let body: any; try { body = await request.json(); } catch { return err('bad_json'); }
    const type = body.type === 'decision' ? 'decision' : body.type === 'message' ? 'message' : null;
    if (!type) return err('bad_type');
    const title = String(body.title || '').trim();
    if (!title) return err('missing_title');
    const result = await createInboxItem(db, principal, {
      type, title, body: String(body.body || body.message || ''), summary: String(body.summary || ''),
      choices: Array.isArray(body.choices) ? body.choices : Array.isArray(body.actions) ? body.actions : [],
      instruction: body.instruction == null ? null : String(body.instruction),
      externalId: body.externalId == null ? null : String(body.externalId), source: body.source,
    });
    return 'error' in result ? err(result.error) : json(result, 201);
  }
  const inboxOne = route.match(/^\/inbox\/([^/]+)$/);
  if (inboxOne && request.method === 'GET') {
    const item = await getInboxItem(db, principal, decodeURIComponent(inboxOne[1]));
    return item ? json({ item }) : err('not_found', 404);
  }
  const inboxPatch = route.match(/^\/inbox\/([^/]+)$/);
  if (inboxPatch && request.method === 'PATCH') {
    let body: any; try { body = await request.json(); } catch { return err('bad_json'); }
    const result = await updateInboxItem(db, principal, decodeURIComponent(inboxPatch[1]), {
      title: body.title === undefined ? undefined : String(body.title),
      summary: body.summary === undefined ? undefined : String(body.summary),
      body: body.body === undefined ? undefined : String(body.body),
    });
    if ('error' in result) return err(result.error, result.error === 'not_found' ? 404 : 409);
    return json(result);
  }
  const inboxSelections = route.match(/^\/inbox\/([^/]+)\/selections$/);
  if (inboxSelections && request.method === 'PATCH') {
    let body: any; try { body = await request.json(); } catch { return err('bad_json'); }
    const result = await patchInboxSelections(db, principal, decodeURIComponent(inboxSelections[1]), {
      choices: Array.isArray(body.choices) ? body.choices : Array.isArray(body.actions) ? body.actions : undefined,
      instruction: body.instruction === undefined ? undefined : String(body.instruction),
    });
    if ('error' in result) return err(result.error, result.error === 'not_found' ? 404 : 409);
    return json(result);
  }
  const inboxSubmit = route.match(/^\/inbox\/([^/]+)\/submit$/);
  if (inboxSubmit && request.method === 'POST') {
    // Human-only: approving a decision is never an agent operation, even though an
    // agent may have *created* the decision it is asking a human to resolve.
    if (agent) return err('human_only', 403);
    let body: any; try { body = await request.json(); } catch { return err('bad_json'); }
    const result = await submitInboxDecision(db, principal, decodeURIComponent(inboxSubmit[1]), {
      choices: Array.isArray(body.choices) ? body.choices : Array.isArray(body.actions) ? body.actions : undefined,
      instruction: body.instruction === undefined ? undefined : String(body.instruction),
      idempotencyKey: String(body.idempotencyKey || request.headers.get('Idempotency-Key') || ''),
    });
    if ('error' in result) {
      const status = result.error === 'not_found' ? 404 : result.error === 'empty_decision' ? 400 : 409;
      return err(result.error, status);
    }
    return json(result);
  }
  const inboxTransition = route.match(/^\/inbox\/([^/]+)\/(dismiss|close)$/);
  if (inboxTransition && request.method === 'POST') {
    // Dismissing/closing resolves a decision without approving it — also human-only.
    if (agent) return err('human_only', 403);
    const result = await closeInboxItem(db, principal, decodeURIComponent(inboxTransition[1]),
      inboxTransition[2] === 'dismiss' ? 'dismissed' : 'closed');
    return result ? json(result) : err('not_found', 404);
  }

  // Artifact surface: legacy until the flag flips; objects afterwards. Same URLs either way.
  const artifactRoute = route.startsWith('/artifacts') || route.startsWith('/revisions')
    || route.startsWith('/images') || route === '/reviews' || route.startsWith('/reviews/')
    || route.startsWith('/critique-context');
  const mode = resolveStorageMode(env, 'artifacts');
  if (artifactRoute && mode !== 'objects') return legacy(request, env, url, route, ctx.authed);

  // ---- artifacts ---------------------------------------------------------
  if (route === '/artifacts' && request.method === 'GET') {
    return json({ artifacts: await artifactList(db, principal) });
  }
  const artState = route.match(/^\/artifacts\/([^/]+)$/);
  if (artState && request.method === 'GET') {
    const state = await artifactState(db, principal, decodeURIComponent(artState[1]));
    return state ? json(state) : err('unknown_article', 404);
  }
  const artRevs = route.match(/^\/artifacts\/([^/]+)\/revisions$/);
  if (artRevs && request.method === 'GET') {
    const object = await getObjectByExternal(db, principal, KINDS.artifact, decodeURIComponent(artRevs[1]));
    if (!object) return err('unknown_article', 404);
    return json({ revisions: await listRevisions(db, principal, object.id) });
  }
  if (artRevs && request.method === 'POST') {
    const object = await getObjectByExternal(db, principal, KINDS.artifact, decodeURIComponent(artRevs[1]));
    if (!object) return err('unknown_article', 404);
    let body: any; try { body = await request.json(); } catch { return err('bad_json'); }
    const result = await createRevision(db, principal, object.id, {
      content: String(body.markdown || body.content || ''),
      source: body.source || 'agent', actor: principal.id,
      expectedRevisionId: body.expectedRevisionId === undefined ? object.currentRevisionId : body.expectedRevisionId,
      id: agent && body.id ? String(body.id) : undefined,
    });
    if ('error' in result) return err(result.error, 409, { currentRevisionId: (result as any).currentRevisionId });
    await recordEvent(db, principal, { objectId: object.id, type: 'revision.published', payload: result.revision });
    return json({ ok: true, revision: result.revision }, 201);
  }
  const revOne = route.match(/^\/revisions\/([^/]+)$/);
  if (revOne && request.method === 'GET') {
    const row: any = await artifactRevisionMarkdown(db, principal, decodeURIComponent(revOne[1]));
    return row ? json(row) : err('not_found', 404);
  }
  const artFeedback = route.match(/^\/artifacts\/([^/]+)\/feedback$/);
  if (artFeedback && request.method === 'POST') {
    let body: any; try { body = await request.json(); } catch { return err('bad_json'); }
    const articleId = decodeURIComponent(artFeedback[1]);
    const result = await submitFeedback(db, principal, articleId, {
      baseRevisionId: body.baseRevisionId, kind: body.kind, workflow: body.workflow,
      text: body.text, idempotencyKey: String(body.idempotencyKey || ''),
      imageIds: Array.isArray(body.imageIds) ? body.imageIds : [],
      reviewId: body.reviewId ? String(body.reviewId) : undefined,
      options: body.options && typeof body.options === 'object' ? body.options : undefined,
    });
    if ('error' in result) {
      const status = result.error === 'stale_base' ? 409 : result.error === 'unknown_article' ? 404 : 400;
      return err(result.error, status, (result as any).currentRevisionId ? { currentRevisionId: (result as any).currentRevisionId } : {});
    }
    return json(result);
  }
  const artClose = route.match(/^\/artifacts\/([^/]+)\/close$/);
  if (artClose && request.method === 'POST') {
    let body: any; try { body = await request.json(); } catch { return err('bad_json'); }
    const result = await closeArtifact(db, principal, decodeURIComponent(artClose[1]), body.closed !== false);
    return result ? json(result) : err('unknown_article', 404);
  }
  const artImages = route.match(/^\/artifacts\/([^/]+)\/images$/);
  if (artImages && request.method === 'POST') {
    let body: any; try { body = await request.json(); } catch { return err('bad_json'); }
    const mime = String(body.mime || '');
    if (!IMAGE_MIMES.includes(mime)) return err('unsupported_type', 415);
    let bytes: Uint8Array;
    try { bytes = b64ToBytes(String(body.dataBase64 || '')); } catch { return err('bad_base64'); }
    if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) return err('bad_size', 413, { max: MAX_IMAGE_BYTES });
    const filename = String(body.filename || 'image').replace(/[^a-zA-Z0-9._ -]/g, '_').slice(0, 120);
    const result = await addAsset(db, principal, decodeURIComponent(artImages[1]), {
      filename, mime, bytes, instruction: clampText(body.instruction, 500),
      role: body.role === 'masthead' ? 'masthead' : undefined,
      provider: body.provider ? String(body.provider).slice(0, 40) : undefined,
      referenceAssetId: body.referenceAssetId ? String(body.referenceAssetId) : undefined,
      assetState: body.assetState === 'candidate' ? 'candidate' : undefined,
      revisionId: body.revisionId ? String(body.revisionId) : undefined,
      meta: body.meta && typeof body.meta === 'object' ? body.meta : undefined,
    });
    return 'error' in result ? err(result.error, 404) : json(result);
  }
  if (artImages && request.method === 'PATCH') {
    let body: any; try { body = await request.json(); } catch { return err('bad_json'); }
    const result = await setAssetsIncluded(db, principal, decodeURIComponent(artImages[1]),
      Array.isArray(body.ids) ? body.ids : [], body.include !== false);
    return result.error ? err(result.error, 404) : json(result);
  }
  const imageOne = route.match(/^\/images\/([^/]+)$/);
  if (imageOne && request.method === 'DELETE') {
    const result: any = await deleteAsset(db, principal, decodeURIComponent(imageOne[1]));
    return result.error ? err(result.error, 404) : json(result);
  }
  if (imageOne && request.method === 'GET') {
    const row: any = await getAsset(db, principal, decodeURIComponent(imageOne[1]));
    const bytes = row ? assetBytes(row.data) : null;
    if (!row || !bytes || !bytes.length) return new Response('Not found', { status: 404 });
    return new Response(bytes, {
      headers: {
        'content-type': row.mime,
        'content-length': String(bytes.length),
        'cache-control': 'private, max-age=300',
        'x-content-type-options': 'nosniff',
      },
    });
  }

  // ---- reviews -----------------------------------------------------------
  const artMasthead = route.match(/^\/artifacts\/([^/]+)\/masthead$/);
  if (artMasthead && request.method === 'POST') {
    if (!agent && !authed) return err('forbidden', 403);
    let body: any; try { body = await request.json(); } catch { return err('bad_json'); }
    const result: any = await setActiveMasthead(db, principal, decodeURIComponent(artMasthead[1]), String(body.assetId || ''));
    if (result.error) return err(result.error, result.error === 'unknown_article' ? 404 : 409);
    return json(result);
  }
  const artPublication = route.match(/^\/artifacts\/([^/]+)\/publication$/);
  if (artPublication && request.method === 'POST') {
    if (!agent) return err('forbidden', 403);
    let body: any; try { body = await request.json(); } catch { return err('bad_json'); }
    const result: any = await recordPublication(db, principal, decodeURIComponent(artPublication[1]), {
      revisionId: body.revisionId ? String(body.revisionId) : null,
      url: body.url ? String(body.url) : null,
      status: String(body.status || 'unknown'),
      destination: body.destination ? String(body.destination) : null,
      detail: body.detail || null,
    });
    if (result.error) return err(result.error, 404);
    return json(result);
  }
  const artReviews = route.match(/^\/artifacts\/([^/]+)\/reviews$/);
  if (artReviews && request.method === 'GET') {
    const list = await listReviews(db, principal, decodeURIComponent(artReviews[1]), {
      revisionId: url.searchParams.get('revisionId') || null,
      limit: Number(url.searchParams.get('limit') || 50),
    });
    return list ? json(list) : err('unknown_article', 404);
  }
  if (artReviews && request.method === 'POST') {
    if (!agent) return err('forbidden', 403);
    let body: any; try { body = await request.json(); } catch { return err('bad_json'); }
    const result: any = await publishReview(db, principal, decodeURIComponent(artReviews[1]), {
      revisionId: String(body.revisionId || ''),
      workflow: String(body.workflow || 'blog-critic'),
      actionId: body.actionId ? String(body.actionId) : null,
      agent: agent.id, summary: body.summary, findings: body.findings,
    });
    if (result.error) {
      const status = result.error === 'unknown_article' ? 404 : result.error === 'unknown_revision' ? 409 : 400;
      return err(result.error, status);
    }
    return json(result, result.duplicate ? 200 : 201);
  }
  const critiqueCtx = route.match(/^\/artifacts\/([^/]+)\/critique-context$/);
  if (critiqueCtx && request.method === 'GET') {
    const ctx = await critiqueContext(db, principal, decodeURIComponent(critiqueCtx[1]), {
      revisionId: url.searchParams.get('revisionId') || null,
    });
    return ctx ? json(ctx) : err('unknown_article', 404);
  }
  const reviewOne = route.match(/^\/reviews\/([^/]+)$/);
  if (reviewOne && request.method === 'GET') {
    const review = await getReview(db, principal, decodeURIComponent(reviewOne[1]));
    return review ? json({ review }) : err('not_found', 404);
  }
  const reviewFindingNote = route.match(/^\/reviews\/([^/]+)\/findings\/([^/]+)\/note$/);
  if (reviewFindingNote) {
    const reviewId = decodeURIComponent(reviewFindingNote[1]);
    const findingId = decodeURIComponent(reviewFindingNote[2]);
    if (request.method === 'PUT' || request.method === 'POST') {
      let body: any = {}; try { body = await request.json(); } catch { body = {}; }
      const result: any = await setFindingNote(db, principal, reviewId, findingId, body.note ?? '');
      if (result.error) return err(result.error, result.error === 'not_found' ? 404 : 400);
      return json(result);
    }
    if (request.method === 'DELETE') {
      const result: any = await setFindingNote(db, principal, reviewId, findingId, null);
      if (result.error) return err(result.error, result.error === 'not_found' ? 404 : 400);
      return json(result);
    }
  }
  const reviewNote = route.match(/^\/reviews\/([^/]+)\/note$/);
  if (reviewNote) {
    const reviewId = decodeURIComponent(reviewNote[1]);
    if (request.method === 'PUT' || request.method === 'POST') {
      let body: any = {}; try { body = await request.json(); } catch { body = {}; }
      const result: any = await setReviewNote(db, principal, reviewId, body.note ?? '');
      if (result.error) return err(result.error, 404);
      return json(result);
    }
    if (request.method === 'DELETE') {
      const result: any = await setReviewNote(db, principal, reviewId, null);
      if (result.error) return err(result.error, 404);
      return json(result);
    }
  }

  // ---- agent -------------------------------------------------------------
  if (route === '/agent/actions' && request.method === 'GET') {
    if (!agent) return err('forbidden', 403);
    const cursor = url.searchParams.get('after');
    const requests = await queueForBridge(db, principal, Number(url.searchParams.get('limit') || 5));
    return json({ requests, cursor: requests.at(-1)?.id || cursor || null });
  }
  // Lightweight status read — one action, no revisions/messages/reviews.
  const agentOne = route.match(/^\/agent\/actions\/([^/]+)$/);
  if (agentOne && request.method === 'GET') {
    const row: any = await db.prepare(
      'SELECT * FROM obj_agent_actions WHERE id = ? AND workspace_id = ?',
    ).bind(decodeURIComponent(agentOne[1]), principal.workspaceId).first();
    if (!row) return err('not_found', 404);
    return json({ action: viewAction(row) });
  }
  const agentAct = route.match(/^\/agent\/actions\/([^/]+)\/(claim|heartbeat|progress|complete|fail)$/);
  if (agentAct && request.method === 'POST') {
    if (!agent) return err('forbidden', 403);
    const id = decodeURIComponent(agentAct[1]);
    let body: any; try { body = await request.json(); } catch { body = {}; }
    const token = typeof body.token === 'string' ? body.token : undefined;
    if (agentAct[2] === 'claim') return json(await claimAction(db, principal, id, String(body.worker || 'openclaw')));
    if (agentAct[2] === 'heartbeat') {
      const beat: any = await heartbeatAction(db, principal, id, String(token || ''));
      return beat.ok ? json(beat) : err(beat.reason || 'claim_lost', 409, beat);
    }
    if (agentAct[2] === 'progress') {
      const result: any = await progressAction(db, principal, id, {
        status: body.status === 'needs_input' ? 'needs_input' : 'working',
        reply: body.reply, error: body.error, token,
      });
      return result.ok ? json(result) : err(result.reason || 'claim_lost', 409, result);
    }
    if (agentAct[2] === 'fail') {
      const result: any = await failAction(db, principal, id, String(body.error || 'failed'), body.retryable !== false, token);
      return result.ok ? json(result) : err(result.reason || 'fail_rejected', 409, result);
    }
    if (agentAct[2] === 'complete') {
      const result: any = await completeActionWithResult(db, principal, id, {
        reply: body.reply, markdown: body.markdown, review: body.review || null, token,
      });
      if (result.error === 'claim_lost' || result.error === 'invalid_transition') return err(result.error, 409, result);
      if (result.error) return err(result.error, result.error === 'conflict' ? 409 : 400, result);
      return json(result);
    }
    const done: any = await completeAction(db, principal, id, { reply: body.reply, revisionId: body.revisionId, token });
    if (!done.ok) return err(done.reason || 'complete_rejected', done.reason === 'not_found' ? 404 : 409, done);
    return json(done);
  }

  // ---- generic objects ---------------------------------------------------
  if (route === '/objects' && request.method === 'GET') {
    return json(await listObjects(db, principal, {
      kind: url.searchParams.get('kind') || undefined,
      status: url.searchParams.get('status') || undefined,
      limit: Number(url.searchParams.get('limit') || 50),
      offset: Number(url.searchParams.get('offset') || 0),
    }));
  }
  if (route === '/objects' && request.method === 'POST') {
    let body: any; try { body = await request.json(); } catch { return err('bad_json'); }
    if (!body.kind || !body.title) return err('invalid_input');
    const object = await createObject(db, principal, {
      kind: String(body.kind), title: String(body.title), externalId: body.externalId ?? null,
      slug: body.slug ?? null, status: body.status, data: body.data,
    });
    await recordEvent(db, principal, { objectId: object!.id, type: 'object.created', payload: { kind: object!.kind } });
    return json({ object }, 201);
  }
  const objOne = route.match(/^\/objects\/([^/]+)$/);
  if (objOne && request.method === 'GET') {
    const object = await getObject(db, principal, decodeURIComponent(objOne[1]));
    return object ? json({ object }) : err('not_found', 404);
  }
  if (objOne && request.method === 'PATCH') {
    let body: any; try { body = await request.json(); } catch { return err('bad_json'); }
    const object = await updateObject(db, principal, decodeURIComponent(objOne[1]), body);
    if (!object) return err('not_found', 404);
    await recordEvent(db, principal, { objectId: object.id, type: 'object.updated', payload: body });
    return json({ object });
  }
  const objRevs = route.match(/^\/objects\/([^/]+)\/revisions$/);
  if (objRevs && request.method === 'GET') {
    const revs = await listRevisions(db, principal, decodeURIComponent(objRevs[1]));
    return revs ? json({ revisions: revs }) : err('not_found', 404);
  }
  if (objRevs && request.method === 'POST') {
    let body: any; try { body = await request.json(); } catch { return err('bad_json'); }
    const result = await createRevision(db, principal, decodeURIComponent(objRevs[1]), {
      content: String(body.content || ''), source: body.source, actor: principal.id,
      expectedRevisionId: body.expectedRevisionId,
    });
    if ('error' in result) return err(result.error, 409, { currentRevisionId: (result as any).currentRevisionId });
    return json({ revision: result.revision }, 201);
  }
  const objRels = route.match(/^\/objects\/([^/]+)\/relations$/);
  if (objRels && request.method === 'GET') {
    const rels = await listRelations(db, principal, decodeURIComponent(objRels[1]));
    return rels ? json({ relations: rels }) : err('not_found', 404);
  }
  if (objRels && request.method === 'POST') {
    let body: any; try { body = await request.json(); } catch { return err('bad_json'); }
    const result = await addRelation(db, principal, decodeURIComponent(objRels[1]), {
      toObjectId: String(body.toObjectId || ''), relation: String(body.relation || ''), metadata: body.metadata,
    });
    return 'error' in result ? err(result.error, 404) : json(result, 201);
  }

  return err('not_found', 404);
}

function legacy(request: Request, env: any, url: URL, route: string, authed: boolean) {
  const map: [RegExp, (m: RegExpMatchArray) => string][] = [
    [/^\/artifacts$/, () => '/list'],
    [/^\/artifacts\/([^/]+)\/revisions$/, (m) => '/revision?id=' + encodeURIComponent(m[1])],
    [/^\/artifacts\/([^/]+)\/feedback$/, () => '/feedback'],
    [/^\/artifacts\/([^/]+)\/close$/, () => '/close'],
    [/^\/artifacts\/([^/]+)\/images$/, () => '/upload'],
    [/^\/artifacts\/([^/]+)$/, (m) => '/state?article=' + encodeURIComponent(m[1])],
    [/^\/revisions\/([^/]+)$/, (m) => '/revision?id=' + encodeURIComponent(m[1])],
    [/^\/images\/([^/]+)$/, (m) => '/image?id=' + encodeURIComponent(m[1])],
    [/^\/agent\/actions$/, () => '/queue'],
    [/^\/agent\/actions\/([^/]+)\/claim$/, () => '/claim'],
    [/^\/agent\/actions\/([^/]+)\/progress$/, () => '/progress'],
    [/^\/agent\/actions\/([^/]+)\/complete$/, () => '/result'],
    [/^\/agent\/actions\/([^/]+)\/fail$/, () => '/progress'],
  ];
  for (const [re, to] of map) {
    const m = route.match(re);
    if (m) {
      const target = legacyUrl(url, to(m));
      return handleArtifactPoc(new Request(target.toString(), request), env, target, authed);
    }
  }
  return json({ error: 'not_found' }, 404);
}
