// React production-data worker — same API modules and React app, bound to the
// EXISTING production D1. Separate URL, password, and assets; Astro production
// (orbit-kenmazaika-com) is not touched.
//
// This is a parallel client of production data, not a cutover.

import ASSETS from './react-prod-assets.generated.js';
import { handleArtifactPoc } from './artifact-poc.js';
import { handleObjectsApi } from './objects/api.ts';
import { handleLegacyArtifacts } from './objects/legacy-compat.ts';
import { resolveStorageMode } from './objects/flags.js';

const COOKIE = 'orbit_session';
const SALT = 'orbit-v1';
const MAX_AGE = 60 * 60 * 24 * 30;

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
  .card{width:100%;max-width:400px}
  .brand{display:flex;align-items:center;gap:10px;margin-bottom:34px}
  .word{font-family:'IBM Plex Mono',ui-monospace,monospace;font-size:.95rem;letter-spacing:.34em;text-transform:uppercase}
  .chip{font-family:'IBM Plex Mono',monospace;font-size:.6rem;letter-spacing:.16em;text-transform:uppercase;
    color:var(--amber);border:1px solid rgba(255,184,107,.35);background:rgba(255,184,107,.08);padding:5px 9px;border-radius:999px}
  h1{font-size:clamp(1.9rem,8vw,2.5rem);line-height:1.1;letter-spacing:-.025em;margin:0 0 10px}
  p.sub{color:var(--dim);margin:0 0 26px;font-size:.98rem;line-height:1.6}
  label{display:block;font-family:'IBM Plex Mono',monospace;font-size:.62rem;letter-spacing:.16em;
    text-transform:uppercase;color:#6f7d99;margin-bottom:8px}
  input{width:100%;padding:15px 16px;font-size:1rem;font-family:inherit;color:var(--text);
    background:var(--panel);border:1px solid var(--line);border-radius:12px;outline:none}
  input:focus{border-color:rgba(87,240,194,.5);box-shadow:0 0 0 3px rgba(87,240,194,.10)}
  button{width:100%;margin-top:14px;padding:15px 16px;font-family:inherit;font-size:.98rem;font-weight:600;
    color:#04120d;background:linear-gradient(96deg,var(--mint),#7ef0d4);border:0;border-radius:12px;cursor:pointer}
  .err{margin-top:14px;padding:11px 13px;border-radius:10px;font-size:.88rem;
    color:#ffd9c2;background:rgba(255,184,107,.10);border:1px solid rgba(255,184,107,.30)}
  .foot{margin-top:26px;font-family:'IBM Plex Mono',monospace;font-size:.6rem;letter-spacing:.14em;
    text-transform:uppercase;color:#4e5a73}
</style></head>
<body><div class="card">
  <div class="brand"><span class="word">Orbit</span><span class="chip">Production</span></div>
  <h1>This space is private.</h1>
  <p class="sub">Enter the password to open Orbit.</p>
  <form method="post" action="/__orbit/login">
    <input type="hidden" name="next" value="${safeNext}">
    <label for="p">Password</label>
    <input id="p" name="password" type="password" autocomplete="current-password" autofocus required>
    <button type="submit">Unlock Orbit</button>
  </form>
  ${error ? `<div class="err">${error}</div>` : ''}
  <div class="foot">orbit-react-prod</div>
</div></body></html>`;
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
  if (!hit && !/\.[a-z0-9]+$/i.test(key)) hit = ASSETS[key + '/index.html'] || ASSETS['/index.html'];
  if (!hit) hit = ASSETS['/index.html'];
  if (!hit) return new Response('Not found', { status: 404 });
  return new Response(fromBase64(hit[1]), {
    status: 200,
    headers: {
      'content-type': hit[0],
      'cache-control': /\.[a-z0-9]+$/i.test(key) ? 'private, max-age=300' : 'private, no-store',
      'x-robots-tag': 'noindex, nofollow',
      'x-orbit-env': 'production-react',
    },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const password = env.ORBIT_PASSWORD;
    if (!password) {
      return new Response('Orbit React is not configured: ORBIT_PASSWORD secret is missing.', {
        status: 503, headers: { 'content-type': 'text/plain', 'cache-control': 'no-store' },
      });
    }

    const expected = await sessionToken(password);
    const authed = safeEqual(readCookie(request, COOKIE) || '', expected);

    const v1 = await handleObjectsApi(request, env, url, { authed });
    if (v1) return v1;

    if (url.pathname.startsWith('/api/lab/artifact')
        && resolveStorageMode(env, 'artifacts') === 'objects') {
      const compat = await handleLegacyArtifacts(request, env, url, authed);
      if (compat) return compat;
    }

    const poc = await handleArtifactPoc(request, env, url, authed);
    if (poc) return poc;

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
        status: 401, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
      });
    }

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

    if (!authed) {
      // Public, non-private asset: lets the browser favicon work on the login page.
      if (url.pathname === '/favicon.svg' || url.pathname === '/favicon.ico') {
        const icon = ASSETS['/favicon.svg'];
        if (icon) return new Response(fromBase64(icon[1]), {
          status: 200,
          headers: { 'content-type': icon[0], 'cache-control': 'private, max-age=300', 'x-robots-tag': 'noindex, nofollow' },
        });
      }
      if (url.pathname.startsWith('/api/')) {
        return new Response(JSON.stringify({ error: 'unauthorized' }), {
          status: 401, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
        });
      }
      return new Response(loginPage({ next: url.pathname + url.search }), {
        status: 401,
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'x-robots-tag': 'noindex, nofollow',
        },
      });
    }

    return serveAsset(url.pathname);
  },
};
