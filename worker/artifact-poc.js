// Orbit artifact review POC — isolated API. Feature-flagged by ORBIT_ARTIFACT_POC_ENABLED.
// Storage: D1 tables prefixed poc_*. No new bindings.

const PREFIX = '/api/lab/artifact';
const IMAGE_MIMES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const MAX_IMAGE_BYTES = 2_500_000;
const WORKFLOWS = new Set(['blog-critic', 'seo-retrofit', 'signup-retrofit']);

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function enabled(env) {
  return String(env.ORBIT_ARTIFACT_POC_ENABLED || 'true').toLowerCase() !== 'false';
}

function same(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

function bridgeOk(request, env) {
  const given = request.headers.get('Authorization') || '';
  return Boolean(env.ORBIT_ARTIFACT_BRIDGE_TOKEN) && same(given, 'Bearer ' + env.ORBIT_ARTIFACT_BRIDGE_TOKEN);
}

async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function b64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function currentRevision(env, articleId) {
  return env.ORBIT_INBOX_DB.prepare(
    'SELECT id, number, markdown, sha256, created_at FROM poc_revisions WHERE article_id = ? ORDER BY number DESC LIMIT 1',
  ).bind(articleId).first();
}

export async function handleArtifactPoc(request, env, url, authed) {
  if (!url.pathname.startsWith(PREFIX)) return null;
  if (!enabled(env)) return json({ error: 'poc_disabled' }, 404);
  if (!env.ORBIT_INBOX_DB) return json({ error: 'db_not_configured' }, 503);

  const route = url.pathname.slice(PREFIX.length);
  const bridge = route.startsWith('/queue') || route.startsWith('/claim') || route.startsWith('/progress')
    || route.startsWith('/result') || route.startsWith('/seed') || route.startsWith('/bridge-image');

  if (bridge) {
    if (!bridgeOk(request, env)) return json({ error: 'unauthorized' }, 401);
  } else if (!authed) {
    return json({ error: 'unauthorized' }, 401);
  }

  // ---- user: state -------------------------------------------------------
  if (route === '/state' && request.method === 'GET') {
    const articleId = url.searchParams.get('article') || 'obsidian-value';
    const article = await env.ORBIT_INBOX_DB.prepare('SELECT * FROM poc_articles WHERE id = ?').bind(articleId).first();
    if (!article) return json({ error: 'unknown_article' }, 404);
    const revs = await env.ORBIT_INBOX_DB.prepare(
      'SELECT id, number, sha256, source, workflow, created_at FROM poc_revisions WHERE article_id = ? ORDER BY number DESC',
    ).bind(articleId).all();
    const events = await env.ORBIT_INBOX_DB.prepare(
      'SELECT id, role, text, request_id, created_at FROM poc_events WHERE article_id = ? ORDER BY created_at DESC LIMIT 60',
    ).bind(articleId).all();
    const active = await env.ORBIT_INBOX_DB.prepare(
      "SELECT id, status, kind, workflow, created_at, claimed_at, base_revision_id FROM poc_requests WHERE article_id = ? AND status IN ('submitted','working','needs_input') ORDER BY created_at DESC LIMIT 1",
    ).bind(articleId).first();
    const images = await env.ORBIT_INBOX_DB.prepare(
      'SELECT id, filename, mime, size, include_flag, instruction, request_id, created_at FROM poc_images WHERE article_id = ? ORDER BY created_at DESC LIMIT 40',
    ).bind(articleId).all();
    const current = (revs.results || [])[0] || null;
    return json({
      article, currentRevisionId: current?.id || null, currentNumber: current?.number || 0,
      revisions: (revs.results || []).reverse(), events: (events.results || []).reverse(),
      activeRequest: active || null, images: images.results || [],
    });
  }

  if (route === '/revision' && request.method === 'GET') {
    const id = url.searchParams.get('id') || '';
    const row = await env.ORBIT_INBOX_DB.prepare('SELECT * FROM poc_revisions WHERE id = ?').bind(id).first();
    if (!row) return json({ error: 'not_found' }, 404);
    return json(row);
  }

  // ---- user: feedback / workflow ----------------------------------------
  if ((route === '/feedback' || route === '/workflow') && request.method === 'POST') {
    const origin = request.headers.get('Origin');
    if (origin && origin !== url.origin) return json({ error: 'bad_origin' }, 403);
    let body;
    try { body = await request.json(); } catch { return json({ error: 'bad_json' }, 400); }

    const articleId = String(body.articleId || 'obsidian-value');
    const baseId = String(body.baseRevisionId || '');
    const kind = route === '/feedback' ? 'feedback' : 'workflow';
    const workflow = kind === 'workflow' ? String(body.workflow || '') : null;
    const text = typeof body.text === 'string' ? body.text.trim().slice(0, 20000) : '';
    const idem = String(body.idempotencyKey || '').slice(0, 120);

    if (kind === 'workflow' && !WORKFLOWS.has(workflow)) return json({ error: 'unknown_workflow' }, 400);
    if (kind === 'feedback' && !text) return json({ error: 'empty_feedback' }, 400);
    if (!idem) return json({ error: 'missing_idempotency_key' }, 400);

    const art = await env.ORBIT_INBOX_DB.prepare('SELECT id FROM poc_articles WHERE id = ?').bind(articleId).first();
    if (!art) return json({ error: 'unknown_article' }, 404);
    const cur = await currentRevision(env, articleId);
    if (!cur) return json({ error: 'no_revision' }, 409);
    if (baseId && baseId !== cur.id) return json({ error: 'stale_base', currentRevisionId: cur.id, currentNumber: cur.number }, 409);

    const existing = await env.ORBIT_INBOX_DB.prepare(
      'SELECT id, status FROM poc_requests WHERE article_id = ? AND idempotency_key = ?',
    ).bind(articleId, idem).first();
    if (existing) return json({ ok: true, requestId: existing.id, duplicate: true, status: existing.status });

    const id = crypto.randomUUID();
    const at = new Date().toISOString();
    try {
      await env.ORBIT_INBOX_DB.prepare(
        'INSERT INTO poc_requests (id, article_id, base_revision_id, kind, workflow, text, idempotency_key, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).bind(id, articleId, cur.id, kind, workflow, text, idem, 'submitted', at).run();
    } catch (e) {
      const again = await env.ORBIT_INBOX_DB.prepare(
        'SELECT id, status FROM poc_requests WHERE article_id = ? AND idempotency_key = ?',
      ).bind(articleId, idem).first();
      if (again) return json({ ok: true, requestId: again.id, duplicate: true, status: again.status });
      return json({ error: 'insert_failed' }, 500);
    }

    const label = kind === 'workflow' ? `Run workflow: ${workflow}` : text;
    await env.ORBIT_INBOX_DB.prepare(
      'INSERT INTO poc_events (id, article_id, request_id, role, text, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).bind(crypto.randomUUID(), articleId, id, 'user', label, at).run();

    const ids = Array.isArray(body.imageIds) ? body.imageIds.filter((x) => typeof x === 'string').slice(0, 8) : [];
    for (const imgId of ids) {
      await env.ORBIT_INBOX_DB.prepare(
        'UPDATE poc_images SET request_id = ?, include_flag = 1 WHERE id = ? AND article_id = ?',
      ).bind(id, imgId, articleId).run();
    }
    return json({ ok: true, requestId: id, duplicate: false, status: 'submitted' });
  }

  // ---- user: images ------------------------------------------------------
  if (route === '/upload' && request.method === 'POST') {
    const origin = request.headers.get('Origin');
    if (origin && origin !== url.origin) return json({ error: 'bad_origin' }, 403);
    let body;
    try { body = await request.json(); } catch { return json({ error: 'bad_json' }, 400); }
    const articleId = String(body.articleId || 'obsidian-value');
    const mime = String(body.mime || '');
    const filename = String(body.filename || 'image').replace(/[^a-zA-Z0-9._ -]/g, '_').slice(0, 120);
    const instruction = typeof body.instruction === 'string' ? body.instruction.slice(0, 500) : '';
    if (!IMAGE_MIMES.has(mime)) return json({ error: 'unsupported_type' }, 415);
    let bytes;
    try { bytes = b64ToBytes(String(body.dataBase64 || '')); } catch { return json({ error: 'bad_base64' }, 400); }
    if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) return json({ error: 'bad_size', max: MAX_IMAGE_BYTES }, 413);

    const id = crypto.randomUUID();
    await env.ORBIT_INBOX_DB.prepare(
      'INSERT INTO poc_images (id, article_id, filename, mime, size, data, include_flag, instruction, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)',
    ).bind(id, articleId, filename, mime, bytes.length, bytes, instruction, new Date().toISOString()).run();
    return json({ ok: true, id, filename, mime, size: bytes.length });
  }

  if (route === '/image' && request.method === 'GET') {
    const id = url.searchParams.get('id') || '';
    const row = await env.ORBIT_INBOX_DB.prepare('SELECT mime, data FROM poc_images WHERE id = ?').bind(id).first();
    if (!row) return new Response('Not found', { status: 404 });
    return new Response(row.data, { headers: { 'content-type': row.mime, 'cache-control': 'private, max-age=60' } });
  }

  if (route === '/images' && request.method === 'POST') {
    let body;
    try { body = await request.json(); } catch { return json({ error: 'bad_json' }, 400); }
    const include = body.include === true;
    const ids = Array.isArray(body.ids) ? body.ids.filter((x) => typeof x === 'string') : [];
    for (const id of ids) {
      await env.ORBIT_INBOX_DB.prepare('UPDATE poc_images SET include_flag = ? WHERE id = ?').bind(include ? 1 : 0, id).run();
    }
    return json({ ok: true, updated: ids.length });
  }

  // ---- bridge ------------------------------------------------------------
  if (route === '/queue' && request.method === 'GET') {
    const { results } = await env.ORBIT_INBOX_DB.prepare(
      "SELECT r.*, a.title FROM poc_requests r JOIN poc_articles a ON a.id = r.article_id WHERE r.status = 'submitted' ORDER BY r.created_at ASC LIMIT 5",
    ).all();
    const out = [];
    for (const r of results || []) {
      const base = await env.ORBIT_INBOX_DB.prepare('SELECT id, number, markdown FROM poc_revisions WHERE id = ?').bind(r.base_revision_id).first();
      const imgs = await env.ORBIT_INBOX_DB.prepare(
        'SELECT id, filename, mime, size, instruction FROM poc_images WHERE request_id = ? AND include_flag = 1 ORDER BY created_at ASC',
      ).bind(r.id).all();
      const hist = await env.ORBIT_INBOX_DB.prepare(
        "SELECT text, created_at FROM poc_events WHERE article_id = ? AND role = 'user' ORDER BY created_at ASC",
      ).bind(r.article_id).all();
      out.push({ ...r, base, images: imgs.results || [], history: hist.results || [] });
    }
    return json({ requests: out });
  }

  if (route === '/claim' && request.method === 'POST') {
    let body; try { body = await request.json(); } catch { return json({ error: 'bad_json' }, 400); }
    const id = String(body.id || '');
    const worker = String(body.worker || 'bridge').slice(0, 80);
    const at = new Date().toISOString();
    const res = await env.ORBIT_INBOX_DB.prepare(
      "UPDATE poc_requests SET status = 'working', claimed_at = ?, worker = ? WHERE id = ? AND status = 'submitted'",
    ).bind(at, worker, id).run();
    if (!res.meta?.changes) return json({ ok: false, reason: 'not_claimable' }, 409);
    return json({ ok: true, id, claimedAt: at });
  }

  if (route === '/progress' && request.method === 'POST') {
    let body; try { body = await request.json(); } catch { return json({ error: 'bad_json' }, 400); }
    const id = String(body.id || '');
    const status = String(body.status || '');
    if (!['working', 'needs_input', 'failed'].includes(status)) return json({ error: 'bad_status' }, 400);
    const reply = typeof body.reply === 'string' ? body.reply.slice(0, 8000) : '';
    await env.ORBIT_INBOX_DB.prepare(
      'UPDATE poc_requests SET status = ?, reply = COALESCE(NULLIF(?, \'\'), reply), error = ? WHERE id = ?',
    ).bind(status, reply, body.error ? String(body.error).slice(0, 800) : null, id).run();
    return json({ ok: true });
  }

  if (route === '/result' && request.method === 'POST') {
    let body; try { body = await request.json(); } catch { return json({ error: 'bad_json' }, 400); }
    const id = String(body.id || '');
    const reply = typeof body.reply === 'string' ? body.reply.slice(0, 8000) : '';
    const markdown = typeof body.markdown === 'string' ? body.markdown : '';
    const req = await env.ORBIT_INBOX_DB.prepare('SELECT * FROM poc_requests WHERE id = ?').bind(id).first();
    if (!req) return json({ error: 'unknown_request' }, 404);
    if (req.status === 'completed') return json({ ok: true, duplicate: true });

    const cur = await currentRevision(env, req.article_id);
    if (!cur || cur.id !== req.base_revision_id) {
      await env.ORBIT_INBOX_DB.prepare(
        "UPDATE poc_requests SET status = 'stale', error = ?, completed_at = ? WHERE id = ?",
      ).bind(`base ${req.base_revision_id} is no longer current`, new Date().toISOString(), id).run();
      return json({ error: 'stale_base', currentRevisionId: cur?.id, currentNumber: cur?.number }, 409);
    }

    const at = new Date().toISOString();
    let revision = null;
    if (markdown.trim()) {
      const revId = crypto.randomUUID();
      const digest = await sha256(markdown);
      const next = cur.number + 1;
      await env.ORBIT_INBOX_DB.prepare(
        'INSERT INTO poc_revisions (id, article_id, number, markdown, sha256, source, workflow, request_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).bind(revId, req.article_id, next, markdown, digest, req.kind, req.workflow, id, at).run();
      revision = { id: revId, number: next, sha256: digest };
      await env.ORBIT_INBOX_DB.prepare(
        'INSERT INTO poc_events (id, article_id, request_id, role, text, meta, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).bind(crypto.randomUUID(), req.article_id, id, 'system', `V${next} ready`, JSON.stringify({ revisionId: revId, number: next }), at).run();
    }
    if (reply) {
      await env.ORBIT_INBOX_DB.prepare(
        'INSERT INTO poc_events (id, article_id, request_id, role, text, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).bind(crypto.randomUUID(), req.article_id, id, 'agent', reply, at).run();
    }
    await env.ORBIT_INBOX_DB.prepare(
      "UPDATE poc_requests SET status = 'completed', reply = ?, completed_at = ? WHERE id = ?",
    ).bind(reply || req.reply || '', at, id).run();
    return json({ ok: true, revision });
  }

  if (route === '/bridge-image' && request.method === 'GET') {
    const id = url.searchParams.get('id') || '';
    const row = await env.ORBIT_INBOX_DB.prepare('SELECT mime, filename, data FROM poc_images WHERE id = ?').bind(id).first();
    if (!row) return new Response('Not found', { status: 404 });
    return new Response(row.data, { headers: { 'content-type': row.mime, 'content-disposition': `attachment; filename="${row.filename}"` } });
  }

  if (route === '/seed' && request.method === 'POST') {
    let body; try { body = await request.json(); } catch { return json({ error: 'bad_json' }, 400); }
    const id = String(body.articleId || 'obsidian-value');
    const title = String(body.title || 'Untitled');
    const canonical = String(body.canonicalPath || '');
    const markdown = String(body.markdown || '');
    if (!markdown.trim()) return json({ error: 'empty_markdown' }, 400);
    const at = new Date().toISOString();
    await env.ORBIT_INBOX_DB.prepare(
      'INSERT OR IGNORE INTO poc_articles (id, title, canonical_path, created_at) VALUES (?, ?, ?, ?)',
    ).bind(id, title, canonical, at).run();
    const existing = await currentRevision(env, id);
    if (existing) return json({ ok: true, seeded: false, revisionId: existing.id, number: existing.number });
    const revId = crypto.randomUUID();
    const digest = await sha256(markdown);
    await env.ORBIT_INBOX_DB.prepare(
      'INSERT INTO poc_revisions (id, article_id, number, markdown, sha256, source, created_at) VALUES (?, ?, 1, ?, ?, ?, ?)',
    ).bind(revId, id, markdown, digest, 'seed', at).run();
    return json({ ok: true, seeded: true, revisionId: revId, number: 1, sha256: digest });
  }

  if (route === '/list' && request.method === 'GET') {
    const { results } = await env.ORBIT_INBOX_DB.prepare(
      `SELECT a.id, a.title, a.created_at, a.closed_at,
              (SELECT number FROM poc_revisions r WHERE r.article_id = a.id ORDER BY number DESC LIMIT 1) AS current_number,
              (SELECT created_at FROM poc_revisions r WHERE r.article_id = a.id ORDER BY number DESC LIMIT 1) AS updated_at
         FROM poc_articles a ORDER BY COALESCE(a.closed_at, '') ASC, a.created_at DESC`,
    ).all();
    return json({ artifacts: results || [] });
  }

  if (route === '/close' && request.method === 'POST') {
    const origin = request.headers.get('Origin');
    if (origin && origin !== url.origin) return json({ error: 'bad_origin' }, 403);
    let body; try { body = await request.json(); } catch { return json({ error: 'bad_json' }, 400); }
    const id = String(body.articleId || '');
    const closed = body.closed !== false;
    await env.ORBIT_INBOX_DB.prepare('UPDATE poc_articles SET closed_at = ? WHERE id = ?')
      .bind(closed ? new Date().toISOString() : null, id).run();
    return json({ ok: true, id, closed });
  }

  return json({ error: 'not_found' }, 404);
}
