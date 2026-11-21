// ORBIT — password gate in front of the static Astro build.
// Password lives in the ORBIT_PASSWORD worker secret; changing it invalidates every
// existing session automatically because the cookie signature is derived from it.

import ASSETS from './assets.generated.js';
import { handleArtifactPoc } from './artifact-poc.js';
import { handleObjectsApi } from './objects/api.ts';
import { handleLegacyArtifacts } from './objects/legacy-compat.ts';
import { resolveStorageMode } from './objects/flags.js';

const COOKIE = 'orbit_session';
const SALT = 'orbit-v1';
const MAX_AGE = 60 * 60 * 24 * 30; // 30 days

async function sessionToken(password) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(password + '|' + SALT),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(SALT));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 40);
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

function readCookie(request, name) {
  const raw = request.headers.get('Cookie') || '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return v.join('=');
  }
  return null;
}

function loginPage({ error = '', next = '/' } = {}) {
  const safeNext = next.replace(/[<>"']/g, '');
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex,nofollow,noarchive"><meta name="theme-color" content="#070a12">
<title>Orbit — access required</title>
<style>
  :root{--bg:#070a12;--panel:#0e1526;--line:#1e2940;--text:#e9eefb;--dim:#8fa0bd;--mint:#57f0c2;--violet:#8b7cff;--amber:#ffb86b}
  *{box-sizing:border-box}
  body{margin:0;min-height:100dvh;display:grid;place-items:center;padding:24px;
    background:radial-gradient(800px 400px at 80% -10%,rgba(139,124,255,.18),transparent 60%),
      radial-gradient(700px 380px at 10% 6%,rgba(87,240,194,.10),transparent 60%),var(--bg);
    color:var(--text);font-family:'Space Grotesk',system-ui,-apple-system,sans-serif;-webkit-font-smoothing:antialiased}
  .card{width:100%;max-width:400px;position:relative}
  .orbit{position:absolute;right:-70px;top:-90px;width:260px;height:260px;opacity:.5;animation:spin 64s linear infinite;pointer-events:none}
  @keyframes spin{to{transform:rotate(360deg)}}
  @media (prefers-reduced-motion:reduce){.orbit{animation:none}}
  .brand{display:flex;align-items:center;gap:10px;margin-bottom:34px}
  .word{font-family:'IBM Plex Mono',ui-monospace,monospace;font-size:.95rem;letter-spacing:.34em;text-transform:uppercase}
  .chip{font-family:'IBM Plex Mono',monospace;font-size:.6rem;letter-spacing:.16em;text-transform:uppercase;
    color:var(--mint);border:1px solid rgba(87,240,194,.35);background:rgba(87,240,194,.08);padding:5px 9px;border-radius:999px}
  h1{font-size:clamp(1.9rem,8vw,2.5rem);line-height:1.1;letter-spacing:-.025em;margin:0 0 10px}
  p.sub{color:var(--dim);margin:0 0 26px;font-size:.98rem;line-height:1.6}
  label{display:block;font-family:'IBM Plex Mono',monospace;font-size:.62rem;letter-spacing:.16em;
    text-transform:uppercase;color:#6f7d99;margin-bottom:8px}
  input{width:100%;padding:15px 16px;font-size:1rem;font-family:inherit;color:var(--text);
    background:var(--panel);border:1px solid var(--line);border-radius:12px;outline:none}
  input:focus{border-color:rgba(87,240,194,.5);box-shadow:0 0 0 3px rgba(87,240,194,.10)}
  button{width:100%;margin-top:14px;padding:15px 16px;font-family:inherit;font-size:.98rem;font-weight:600;
    color:#04120d;background:linear-gradient(96deg,var(--mint),#7ef0d4);border:0;border-radius:12px;cursor:pointer}
  button:active{opacity:.85}
  .err{margin-top:14px;padding:11px 13px;border-radius:10px;font-size:.88rem;
    color:#ffd9c2;background:rgba(255,184,107,.10);border:1px solid rgba(255,184,107,.30)}
  .foot{margin-top:26px;font-family:'IBM Plex Mono',monospace;font-size:.6rem;letter-spacing:.14em;
    text-transform:uppercase;color:#4e5a73}
</style></head>
<body>
  <div class="card">
    <svg class="orbit" viewBox="0 0 300 300" fill="none" aria-hidden="true">
      <circle cx="150" cy="150" r="118" stroke="#1e2940" stroke-dasharray="3 7"/>
      <ellipse cx="150" cy="150" rx="132" ry="52" stroke="#8b7cff" stroke-opacity=".45" transform="rotate(-26 150 150)"/>
      <circle cx="150" cy="150" r="7" fill="#57f0c2" fill-opacity=".22" stroke="#57f0c2" stroke-width="1.4"/>
      <circle cx="252" cy="86" r="4" fill="#ffb86b"/>
    </svg>
    <div class="brand">
      <svg width="26" height="26" viewBox="0 0 32 32" fill="none" aria-hidden="true">
        <circle cx="16" cy="16" r="5.2" fill="#57f0c2" fill-opacity=".18" stroke="#57f0c2" stroke-width="1.5"/>
        <ellipse cx="16" cy="16" rx="14" ry="6" stroke="#8b7cff" stroke-width="1.4" transform="rotate(-22 16 16)"/>
        <circle cx="27" cy="10" r="1.9" fill="#ffb86b"/>
      </svg>
      <span class="word">Orbit</span><span class="chip">Private</span>
    </div>
    <h1>This space is private.</h1>
    <p class="sub">Enter the password to open Orbit.</p>
    <form method="post" action="/__orbit/login">
      <input type="hidden" name="next" value="${safeNext}">
      <label for="p">Password</label>
      <input id="p" name="password" type="password" autocomplete="current-password" autofocus required>
      <button type="submit">Unlock Orbit</button>
    </form>
    ${error ? `<div class="err">${error}</div>` : ''}
    <div class="foot">Orbit</div>
  </div>
</body></html>`;
}



const INBOX_API = '/api/orbit-inbox';

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function hasServiceToken(request, env) {
  const given = request.headers.get('Authorization') || '';
  return Boolean(env.ORBIT_INBOX_TOKEN) && safeEqual(given, 'Bearer ' + env.ORBIT_INBOX_TOKEN);
}

function fromBase64(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function serveAsset(pathname) {
  let key = pathname;
  if (key.endsWith('/')) key += 'index.html';
  let hit = ASSETS[key];
  if (!hit && !/\.[a-z0-9]+$/i.test(key)) hit = ASSETS[key + '/index.html'];
  if (!hit && key === '/404.html') hit = ASSETS['/404.html'];
  if (!hit) {
    const nf = ASSETS['/404.html'];
    if (nf) {
      return new Response(fromBase64(nf[1]), {
        status: 404,
        headers: { 'content-type': nf[0], 'x-robots-tag': 'noindex, nofollow', 'cache-control': 'private, no-store' },
      });
    }
    return new Response('Not found', { status: 404 });
  }
  return new Response(fromBase64(hit[1]), {
    status: 200,
    headers: { 'content-type': hit[0], 'x-robots-tag': 'noindex, nofollow', 'cache-control': 'private, no-store' },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const password = env.ORBIT_PASSWORD;

    if (!password) {
      return new Response('Orbit is not configured: ORBIT_PASSWORD secret is missing.', {
        status: 503, headers: { 'content-type': 'text/plain', 'cache-control': 'no-store' },
      });
    }

    const expected = await sessionToken(password);
    const authed = safeEqual(readCookie(request, COOKIE) || '', expected);

    // Orbit API v1 — artifacts (legacy-backed until the storage flag flips).
    const v1 = await handleObjectsApi(request, env, url, { authed });
    if (v1) return v1;

    // Artifacts: object-backed compatibility routes once the flag flips.
    if (url.pathname.startsWith('/api/lab/artifact')
        && resolveStorageMode(env, 'artifacts') === 'objects') {
      const compat = await handleLegacyArtifacts(request, env, url, authed);
      if (compat) return compat;
    }

    // Artifact review POC — isolated, flag-gated inside the handler.
    const poc = await handleArtifactPoc(request, env, url, authed);
    if (poc) return poc;

    // login
    if (url.pathname === '/__orbit/login' && request.method === 'POST') {
      const form = await request.formData();
      const given = String(form.get('password') || '');
      const next = String(form.get('next') || '/');
      const dest = next.startsWith('/') && !next.startsWith('//') ? next : '/';
      if (safeEqual(given, password)) {
        return new Response(null, {
          status: 303,
          headers: {
            Location: dest,
            'Set-Cookie': `${COOKIE}=${expected}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${MAX_AGE}`,
            'Cache-Control': 'no-store',
          },
        });
      }
      return new Response(loginPage({ error: 'That password did not work. Try again.', next: dest }), {
        status: 401,
        headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
      });
    }

    // logout
    if (url.pathname === '/__orbit/logout') {
      return new Response(null, {
        status: 303,
        headers: {
          Location: '/',
          'Set-Cookie': `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
          'Cache-Control': 'no-store',
        },
      });
    }


    // --- Orbit inbox API: cards projection + decision queue ---
    if (url.pathname === INBOX_API + '/sync' && request.method === 'POST') {
      if (!hasServiceToken(request, env)) return jsonResponse({ error: 'unauthorized' }, 401);
      if (!env.ORBIT_INBOX_DB) return jsonResponse({ error: 'db_not_configured' }, 503);
      let body;
      try { body = await request.json(); } catch { return jsonResponse({ error: 'bad_json' }, 400); }
      const cards = Array.isArray(body?.cards) ? body.cards.slice(0, 40) : [];
      const deleted = Array.isArray(body?.deleted) ? body.deleted.filter((x) => typeof x === 'string').slice(0, 200) : [];
      const now = new Date().toISOString();
      let upserted = 0;
      for (const c of cards) {
        if (!c || typeof c.orbit_id !== 'string' || !c.orbit_id) continue;
        const latest = await env.ORBIT_INBOX_DB.prepare(
          'SELECT status, created_at, applied_at FROM actions WHERE orbit_id = ? ORDER BY created_at DESC LIMIT 1',
        ).bind(c.orbit_id).first();
        const outbox = c.outbox ? 1 : 0;
        let status = c.status || 'pending';
        let submittedAt = null;
        let processedAt = null;
        if (outbox || status === 'completed') {
          status = outbox ? 'outbox' : 'completed';
        } else if (latest && latest.status === 'submitted') {
          status = 'submitted'; submittedAt = latest.created_at;
        } else if (latest && latest.status === 'applied') {
          // A handoff whose every action is already ticked has no work left.
          // Tickets still belong to the sweep, so they stay in progress.
          const acts = Array.isArray(c.actions) ? c.actions : [];
          const allChecked = acts.length > 0 && acts.every((a) => a && a.checked);
          const isTicket = String(c.folder || '').includes('00.03 - tickets');
          status = allChecked && !isTicket ? 'completed' : 'processing';
          submittedAt = latest.created_at; processedAt = latest.applied_at;
        } else if (latest && latest.status === 'done') {
          status = 'completed'; submittedAt = latest.created_at; processedAt = latest.applied_at;
        } else if (latest && latest.status === 'conflict') {
          status = 'blocked'; submittedAt = latest.created_at;
        }
        await env.ORBIT_INBOX_DB.prepare(
          `INSERT INTO cards (orbit_id, kind, folder, title, body, actions_json, instruction,
             created_at, created_precision, updated_at, submitted_at, processed_at, completed_at,
             status, disposition, source_path, content_hash, outbox, excluded, deleted, synced_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?)
           ON CONFLICT(orbit_id) DO UPDATE SET
             kind=excluded.kind, folder=excluded.folder, title=excluded.title, body=excluded.body,
             actions_json=excluded.actions_json, instruction=excluded.instruction,
             created_at=excluded.created_at, created_precision=excluded.created_precision,
             updated_at=excluded.updated_at, submitted_at=COALESCE(excluded.submitted_at, cards.submitted_at),
             processed_at=COALESCE(excluded.processed_at, cards.processed_at),
             completed_at=excluded.completed_at, status=excluded.status, disposition=excluded.disposition,
             source_path=excluded.source_path, content_hash=excluded.content_hash, outbox=excluded.outbox,
             excluded=excluded.excluded, deleted=0, synced_at=excluded.synced_at`,
        ).bind(
          c.orbit_id, c.kind || 'handoff', c.folder || 'active', c.title || '(untitled)',
          c.body || '', JSON.stringify(Array.isArray(c.actions) ? c.actions : []),
          c.instruction || null, c.created_at || null, c.created_precision || 'datetime',
          c.updated_at || null, submittedAt, processedAt, c.completed_at || null,
          status, c.disposition || null, c.source_path || '', c.content_hash || '', outbox,
          c.excluded ? 1 : 0, now,
        ).run();
        upserted += 1;
      }
      if (deleted.length > 0) {
        const placeholders = deleted.map(() => '?').join(',');
        await env.ORBIT_INBOX_DB.prepare(
          `UPDATE cards SET deleted = 1, synced_at = ? WHERE orbit_id IN (${placeholders})`,
        ).bind(now, ...deleted).run();
      }
      return jsonResponse({ ok: true, upserted, deleted: deleted.length });
    }

    if (url.pathname === INBOX_API + '/cards' && request.method === 'GET') {
      if (!authed) return jsonResponse({ error: 'unauthorized' }, 401);
      if (!env.ORBIT_INBOX_DB) return jsonResponse({ active: [], outbox: [], counts: {} });
      const { results } = await env.ORBIT_INBOX_DB.prepare(
        `SELECT orbit_id, kind, folder, title, body, actions_json, instruction, created_at,
                created_precision, updated_at, submitted_at, processed_at, completed_at, status,
                disposition, outbox, source_path
           FROM cards WHERE excluded = 0 AND deleted = 0
           ORDER BY created_at DESC, orbit_id ASC`,
      ).all();
      const active = [];
      const outbox = [];
      for (const row of results || []) {
        const card = {
          orbit_id: row.orbit_id, kind: row.kind, folder: row.folder, title: row.title,
          body: row.body, actions: JSON.parse(row.actions_json || '[]'),
          instruction: row.instruction, created_at: row.created_at,
          created_precision: row.created_precision, updated_at: row.updated_at,
          submitted_at: row.submitted_at, processed_at: row.processed_at,
          completed_at: row.completed_at, status: row.status, disposition: row.disposition,
          source_path: row.source_path,
        };
        (row.outbox ? outbox : active).push(card);
      }
      return jsonResponse({ active, outbox, counts: { active: active.length, outbox: outbox.length } });
    }

    if (url.pathname === INBOX_API + '/actions' && request.method === 'POST') {
      if (!authed) return jsonResponse({ error: 'unauthorized' }, 401);
      const origin = request.headers.get('Origin');
      if (origin && origin !== url.origin) return jsonResponse({ error: 'bad_origin' }, 403);
      if (!env.ORBIT_INBOX_DB) return jsonResponse({ error: 'db_not_configured' }, 503);
      let body;
      try { body = await request.json(); } catch { return jsonResponse({ error: 'bad_json' }, 400); }

      // Legacy POC shape ({checkboxes, text}) remains for /test/inbox/; it is not
      // part of the Inbox product path.
      if (!body?.orbit_id) {
        const checkboxes = {};
        for (const key of ['a', 'b', 'c']) checkboxes[key] = body?.checkboxes?.[key] === true;
        const text = typeof body?.text === 'string' ? body.text.slice(0, 4000) : '';
        const id = crypto.randomUUID();
        const createdAt = new Date().toISOString();
        await env.ORBIT_INBOX_DB.prepare(
          'INSERT INTO events (id, created_at, payload, status) VALUES (?, ?, ?, ?)',
        ).bind(id, createdAt, JSON.stringify({ checkboxes, text }), 'pending').run();
        return jsonResponse({ ok: true, id, createdAt });
      }

      const orbitId = String(body.orbit_id);
      const card = await env.ORBIT_INBOX_DB.prepare('SELECT * FROM cards WHERE orbit_id = ?').bind(orbitId).first();
      if (!card) return jsonResponse({ error: 'unknown_card' }, 404);
      if (card.outbox || card.excluded || card.deleted) return jsonResponse({ error: 'card_not_actionable' }, 409);
      const allowed = new Set(JSON.parse(card.actions_json || '[]').map((a) => a.label));
      const selected = Array.isArray(body.actions)
        ? body.actions.filter((x) => typeof x === 'string' && allowed.has(x))
        : [];
      const instruction = typeof body.instruction === 'string' ? body.instruction.slice(0, 4000) : '';
      if (selected.length === 0 && !instruction.trim()) return jsonResponse({ error: 'empty_decision' }, 400);
      const payload = JSON.stringify({ actions: selected, instruction });
      const existing = await env.ORBIT_INBOX_DB.prepare(
        "SELECT id, created_at FROM actions WHERE orbit_id = ? AND payload = ? AND status = 'submitted' LIMIT 1",
      ).bind(orbitId, payload).first();
      if (existing) return jsonResponse({ ok: true, id: existing.id, submittedAt: existing.created_at, duplicate: true });
      const id = crypto.randomUUID();
      const createdAt = new Date().toISOString();
      await env.ORBIT_INBOX_DB.prepare(
        "INSERT INTO actions (id, orbit_id, payload, base_hash, status, created_at) VALUES (?, ?, ?, ?, 'submitted', ?)",
      ).bind(id, orbitId, payload, card.content_hash || '', createdAt).run();
      await env.ORBIT_INBOX_DB.prepare(
        "UPDATE cards SET status = 'submitted', submitted_at = ? WHERE orbit_id = ?",
      ).bind(createdAt, orbitId).run();
      return jsonResponse({ ok: true, id, submittedAt: createdAt });
    }

    if (url.pathname === INBOX_API + '/actions' && request.method === 'GET') {
      if (!hasServiceToken(request, env)) return jsonResponse({ error: 'unauthorized' }, 401);
      if (!env.ORBIT_INBOX_DB) return jsonResponse({ actions: [] });
      const { results } = await env.ORBIT_INBOX_DB.prepare(
        `SELECT a.id, a.orbit_id, a.payload, a.base_hash, a.created_at, c.source_path, c.title, c.outbox, c.deleted
           FROM actions a JOIN cards c ON c.orbit_id = a.orbit_id
          WHERE a.status = 'submitted' ORDER BY a.created_at ASC LIMIT 20`,
      ).all();
      return jsonResponse({ actions: results || [] });
    }

    if (url.pathname === INBOX_API + '/actions/ack' && request.method === 'POST') {
      if (!hasServiceToken(request, env)) return jsonResponse({ error: 'unauthorized' }, 401);
      if (!env.ORBIT_INBOX_DB) return jsonResponse({ error: 'db_not_configured' }, 503);
      let body;
      try { body = await request.json(); } catch { return jsonResponse({ error: 'bad_json' }, 400); }
      const id = String(body?.id || '');
      const status = String(body?.status || '');
      if (!id || !['applied', 'conflict', 'blocked', 'done'].includes(status)) {
        return jsonResponse({ error: 'bad_ack' }, 400);
      }
      const at = new Date().toISOString();
      const action = await env.ORBIT_INBOX_DB.prepare('SELECT orbit_id FROM actions WHERE id = ?').bind(id).first();
      if (!action) return jsonResponse({ error: 'unknown_action' }, 404);
      await env.ORBIT_INBOX_DB.prepare(
        'UPDATE actions SET status = ?, applied_at = ?, error = ? WHERE id = ?',
      ).bind(status, at, body?.error ? String(body.error).slice(0, 500) : null, id).run();
      const cardStatus = status === 'applied' ? 'processing' : status === 'done' ? 'completed' : 'blocked';
      await env.ORBIT_INBOX_DB.prepare(
        'UPDATE cards SET status = ?, processed_at = COALESCE(processed_at, ?) WHERE orbit_id = ?',
      ).bind(cardStatus, at, action.orbit_id).run();
      return jsonResponse({ ok: true, id, status });
    }

    if (!authed) {
      return new Response(loginPage({ next: url.pathname + url.search }), {
        status: 401,
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'x-robots-tag': 'noindex, nofollow',
        },
      });
    }

    // Legacy lab URL -> production artifacts.
    if (url.pathname.startsWith('/lab/artifacts')) {
      return Response.redirect(url.origin + url.pathname.replace('/lab/artifacts', '/artifacts') + url.search, 302);
    }

    // Legacy lab path gate only; /artifacts/ is production.
    if (url.pathname.startsWith('/lab/artifacts')
        && String(env.ORBIT_ARTIFACT_POC_ENABLED || 'true').toLowerCase() === 'false') {
      return new Response('Not found', {
        status: 404, headers: { 'content-type': 'text/plain', 'cache-control': 'no-store' },
      });
    }

    // Dispatch detail pages share one runtime shell. Never serve a stale
    // filename-built note page when the object-backed dispatch has changed.
    if (/^\/notes\/[^/]+\/?$/.test(url.pathname)) {
      return serveAsset('/notes/index.html');
    }

    // Artifact pages share one runtime shell too: the page reads its id from
    // location.pathname and loads everything else from the API. Building a page
    // per artifact meant any artifact created after a deploy 404'd.
    if (/^\/artifacts\/[^/]+\/?$/.test(url.pathname)) {
      return serveAsset('/artifacts/obsidian-value/index.html');
    }

    return serveAsset(url.pathname);
  },
};
