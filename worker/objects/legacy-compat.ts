// Legacy /api/lab/artifact/* compatibility adapter.
// Active only when ORBIT_STORAGE_ARTIFACTS=objects. It preserves the exact
// request/response shapes the current Astro pages and bridge already use, while
// every read and write goes through the object services (obj_*).

import {
  userPrincipal, ensureWorkspace, artifactState, artifactList, artifactRevisionMarkdown, getAction,
  submitFeedback, closeArtifact, addAsset, getAsset, viewAction,
  claimAction, progressAction, failAction, completeAction, createRevision,
  getObjectByExternal, recordEvent, completeActionWithResult,
  publishReview, listReviews, getReview, setFindingNote, setReviewNote, critiqueContext,
  assetBytes, deleteAsset,
} from './service.ts';
import { queueForBridge } from './migrate.ts';
import { KINDS, IMAGE_MIMES, MAX_IMAGE_BYTES, clampText } from './types.ts';
import { run } from './repo.ts';

const path = '/api/lab/artifact';

function json(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function b64(b64str: string) {
  const bin = atob(b64str);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export async function handleLegacyArtifacts(request: Request, env: any, url: URL, authed: boolean) {
  if (!url.pathname.startsWith(path)) return null;
  const db = env.ORBIT_OBJECTS_DB;
  if (!db) return json({ error: 'db_not_configured' }, 503);
  const principal = userPrincipal('ws_ken');
  await ensureWorkspace(db);
  const route = url.pathname.slice(path.length).replace(/\/+$/, '');

  const agentAuth = request.headers.get('Authorization') === `Bearer ${env.ORBIT_ARTIFACT_BRIDGE_TOKEN}`;
  const bridgeRoutes = ['/queue', '/claim', '/progress', '/result', '/bridge-image'];
  if (bridgeRoutes.includes(route)) { if (!agentAuth) return json({ error: 'unauthorized' }, 401); }
  else if (!authed) return json({ error: 'unauthorized' }, 401);
  if (!agentAuth && request.method !== 'GET') {
    const origin = request.headers.get('Origin');
    if (origin && origin !== url.origin) return json({ error: 'bad_origin' }, 403);
  }

  if (route === '/list' && request.method === 'GET') return json({ artifacts: await artifactList(db, principal) });

  if (route === '/state' && request.method === 'GET') {
    const state = await artifactState(db, principal, url.searchParams.get('article') || 'obsidian-value');
    return state ? json(state) : json({ error: 'unknown_article' }, 404);
  }

  // One-row action status for the artifact page's live polling.
  if (route === '/action' && request.method === 'GET') {
    const action = await getAction(db, principal, url.searchParams.get('id') || '');
    return action ? json({ action }) : json({ error: 'not_found' }, 404);
  }

  if (route === '/revision' && request.method === 'GET') {
    const row: any = await artifactRevisionMarkdown(db, principal, url.searchParams.get('id') || '');
    if (!row) return json({ error: 'not_found' }, 404);
    return json({ ...row, markdown: row.content });
  }

  if ((route === '/feedback' || route === '/workflow') && request.method === 'POST') {
    let body: any; try { body = await request.json(); } catch { return json({ error: 'bad_json' }, 400); }
    const articleId = String(body.articleId || 'obsidian-value');
    const kind = route === '/workflow' ? 'workflow' : 'feedback';
    const res = await submitFeedback(db, principal, articleId, {
      baseRevisionId: String(body.baseRevisionId || ''),
      kind, workflow: body.workflow, text: body.text,
      idempotencyKey: String(body.idempotencyKey || ''), imageIds: body.imageIds,
      reviewId: body.reviewId ? String(body.reviewId) : undefined,
      options: body.options && typeof body.options === 'object' ? body.options : undefined,
    });
    if ('error' in res) {
      const status = res.error === 'stale_base' ? 409 : res.error === 'unknown_article' ? 404 : 400;
      return json({ error: res.error, currentRevisionId: (res as any).currentRevisionId }, status);
    }
    return json(res);
  }

  if (route === '/upload' && request.method === 'POST') {
    let body: any; try { body = await request.json(); } catch { return json({ error: 'bad_json' }, 400); }
    if (!IMAGE_MIMES.includes(String(body.mime || ''))) return json({ error: 'unsupported_type' }, 415);
    let bytes: Uint8Array;
    try { bytes = b64(String(body.dataBase64 || '')); } catch { return json({ error: 'bad_base64' }, 400); }
    if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) return json({ error: 'bad_size', max: MAX_IMAGE_BYTES }, 413);
    const filename = String(body.filename || 'image').replace(/[^a-zA-Z0-9._ -]/g, '_').slice(0, 120);
    const res = await addAsset(db, principal, String(body.articleId || 'obsidian-value'), {
      filename, mime: String(body.mime), bytes, instruction: clampText(body.instruction, 500),
    });
    return 'error' in res ? json({ error: res.error }, 404) : json(res);
  }

  if (route === '/image' && request.method === 'GET') {
    const row: any = await getAsset(db, principal, url.searchParams.get('id') || '');
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

  if (route === '/bridge-image' && request.method === 'GET') {
    const row: any = await getAsset(db, principal, url.searchParams.get('id') || '');
    const bytes = row ? assetBytes(row.data) : null;
    if (!row || !bytes || !bytes.length) return new Response('Not found', { status: 404 });
    return new Response(bytes, {
      headers: {
        'content-type': row.mime,
        'content-length': String(bytes.length),
        'content-disposition': `attachment; filename="${row.filename}"`,
      },
    });
  }

  if (route === '/asset-remove' && request.method === 'POST') {
    let body: any; try { body = await request.json(); } catch { return json({ error: 'bad_json' }, 400); }
    const id = String(body.id || '');
    if (!id) return json({ error: 'missing_id' }, 400);
    const res = await deleteAsset(db, principal, id);
    return 'error' in res ? json({ error: res.error }, 404) : json(res);
  }

  if (route === '/images' && request.method === 'POST') {
    let body: any; try { body = await request.json(); } catch { return json({ error: 'bad_json' }, 400); }
    const ids = Array.isArray(body.ids) ? body.ids.filter((x: any) => typeof x === 'string') : [];
    for (const id of ids) await run(db, 'UPDATE obj_assets SET include_flag = ? WHERE id = ?', body.include === true ? 1 : 0, id);
    return json({ ok: true, updated: ids.length });
  }

  if (route === '/close' && request.method === 'POST') {
    let body: any; try { body = await request.json(); } catch { return json({ error: 'bad_json' }, 400); }
    const res = await closeArtifact(db, principal, String(body.articleId || ''), body.closed !== false);
    return res ? json(res) : json({ error: 'unknown_article' }, 404);
  }

  // ---- reviews ----
  if (route === '/reviews' && request.method === 'GET') {
    const list = await listReviews(db, principal,
      url.searchParams.get('article') || 'obsidian-value', {
        revisionId: url.searchParams.get('revisionId') || null,
        limit: Number(url.searchParams.get('limit') || 50),
      });
    return list ? json(list) : json({ error: 'unknown_article' }, 404);
  }
  if (route === '/review' && request.method === 'GET') {
    const review = await getReview(db, principal, url.searchParams.get('id') || '');
    return review ? json({ review }) : json({ error: 'not_found' }, 404);
  }
  if (route === '/note' && (request.method === 'PUT' || request.method === 'POST' || request.method === 'DELETE')) {
    let body: any = {}; try { body = await request.json(); } catch { body = {}; }
    const reviewId = String(body.reviewId || url.searchParams.get('reviewId') || '');
    const findingId = body.findingId ? String(body.findingId) : (url.searchParams.get('findingId') || '');
    const note = request.method === 'DELETE' ? null : (body.note ?? '');
    const res: any = findingId
      ? await setFindingNote(db, principal, reviewId, findingId, note)
      : await setReviewNote(db, principal, reviewId, note);
    if (res.error) return json({ error: res.error }, res.error === 'not_found' ? 404 : 400);
    return json(res);
  }
  if (route === '/critique-context' && request.method === 'GET') {
    const ctx = await critiqueContext(db, principal, url.searchParams.get('article') || 'obsidian-value', {
      revisionId: url.searchParams.get('revisionId') || null,
    });
    return ctx ? json(ctx) : json({ error: 'unknown_article' }, 404);
  }
  if (route === '/reviews' && request.method === 'POST') {
    if (!agentAuth) return json({ error: 'forbidden' }, 403);
    let body: any; try { body = await request.json(); } catch { return json({ error: 'bad_json' }, 400); }
    const res: any = await publishReview(db, principal, String(body.articleId || url.searchParams.get('article') || ''), {
      revisionId: String(body.revisionId || ''),
      workflow: String(body.workflow || 'blog-critic'),
      actionId: body.actionId ? String(body.actionId) : null,
      agent: 'openclaw', summary: body.summary, findings: body.findings,
    });
    if (res.error) return json({ error: res.error }, res.error === 'unknown_article' ? 404 : 400);
    return json(res, res.duplicate ? 200 : 201);
  }

  // ---- bridge ----
  if (route === '/queue' && request.method === 'GET') {
    return json({ requests: await queueForBridge(db, principal, 5) });
  }
  if (route === '/claim' && request.method === 'POST') {
    let body: any; try { body = await request.json(); } catch { body = {}; }
    return json(await claimAction(db, principal, String(body.id || ''), String(body.worker || 'bridge')));
  }
  if (route === '/progress' && request.method === 'POST') {
    let body: any; try { body = await request.json(); } catch { body = {}; }
    const id = String(body.id || '');
    if (body.status === 'failed') return json(await failAction(db, principal, id, String(body.error || 'failed'), true));
    return json(await progressAction(db, principal, id, {
      status: body.status === 'needs_input' ? 'needs_input' : 'working', reply: body.reply, error: body.error,
    }));
  }
  if (route === '/result' && request.method === 'POST') {
    let body: any; try { body = await request.json(); } catch { body = {}; }
    const id = String(body.id || '');
    const res: any = await completeActionWithResult(db, principal, id, {
      reply: body.reply, markdown: body.markdown, review: body.review || null,
    });
    if (res.error) {
      const status = res.error === 'not_found' || res.error === 'unknown_object' ? 404
        : res.error === 'conflict' ? 409 : 400;
      return json({ error: res.error, currentRevisionId: res.currentRevisionId }, status);
    }
    return json({ ok: true, review: res.review || null, revision: res.revision || null });
  }

  return json({ error: 'not_found' }, 404);
}
