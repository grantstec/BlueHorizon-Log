/* =========================================================================
   BlueHorizon Portal Server — Cloudflare Worker
   Gives the static portal real accounts, roles, and a server-side proxy.

   Endpoints (all JSON, CORS-enabled):
     POST /api/signup        {username, password, name}     -> pending account (first user = admin)
     POST /api/login         {username, password}           -> {token, role, name}
     GET  /api/me                                           -> {username, role, name}
     GET  /api/users         (admin)                        -> [{username, name, role, created}]
     POST /api/users/role    (admin) {username, role}       -> approve / change / 'remove'
     ANY  /api/gh/<path>     (member+ for writes)           -> proxied to GitHub repo API
     GET  /api/fetch?url=    (any signed-in user)           -> server-side page fetch (PO autofill)
     GET  /api/889?q=        (any signed-in user)           -> GSA 889 SmartPay entity search

   Bindings / secrets (see SETUP.md):
     DB              D1 database
     GH_TOKEN        fine-grained PAT, Contents R/W on the repo   (secret)
     SESSION_SECRET  long random string                            (secret)
     GH_REPO         e.g. "grantstec/BlueHorizon-Log"              (var)
     ALLOWED_ORIGIN  e.g. "https://grantstec.github.io"            (var)
   ========================================================================= */

'use strict';

const ROLES = ['pending', 'member', 'lead', 'admin'];
const enc = new TextEncoder();

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    const cors = corsHeaders(env, origin);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    try {
      const p = url.pathname;
      let res;
      if (p === '/api/signup' && request.method === 'POST') res = await signup(request, env);
      else if (p === '/api/login' && request.method === 'POST') res = await login(request, env);
      else if (p === '/api/me') res = await me(request, env);
      else if (p === '/api/users' && request.method === 'GET') res = await listUsers(request, env);
      else if (p === '/api/users/role' && request.method === 'POST') res = await setRole(request, env);
      else if (p === '/api/profile' && request.method === 'POST') res = await updateProfile(request, env);
      else if (p === '/api/emails' && request.method === 'GET') res = await exportEmails(request, env);
      else if (p === '/api/repos' && request.method === 'POST') res = await createRepo(request, env);
      else if (p.startsWith('/api/gh/')) res = await ghProxy(request, env, p.slice('/api/gh/'.length) + url.search);
      else if (p === '/api/fetch') res = await pageFetch(request, env, url);
      else if (p === '/api/889') res = await gsa889(request, env, url);
      else res = json({ error: 'not found' }, 404);
      // merge CORS headers
      const h = new Headers(res.headers);
      for (const [k, v] of Object.entries(cors)) h.set(k, v);
      return new Response(res.body, { status: res.status, headers: h });
    } catch (e) {
      return new Response(JSON.stringify({ error: String(e.message || e) }),
        { status: 500, headers: { 'Content-Type': 'application/json', ...cors } });
    }
  },
};

function corsHeaders(env, origin) {
  const allowed = (env.ALLOWED_ORIGIN || '*').split(',').map((s) => s.trim());
  const ok = allowed.includes('*') || allowed.includes(origin);
  return {
    'Access-Control-Allow-Origin': ok ? (origin || '*') : allowed[0],
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization,Accept',
    'Access-Control-Max-Age': '86400',
  };
}

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });

/* ---------------- crypto: PBKDF2 password hashing + HMAC sessions ---------------- */

async function hashPassword(password, saltHex = null) {
  const salt = saltHex ? hexToBytes(saltHex) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' }, key, 256);
  return { hash: bytesToHex(new Uint8Array(bits)), salt: bytesToHex(salt) };
}

async function hmac(env, data) {
  const key = await crypto.subtle.importKey('raw', enc.encode(env.SESSION_SECRET),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(data));
  return bytesToHex(new Uint8Array(sig));
}

async function makeToken(env, username) {
  const exp = Date.now() + 90 * 24 * 3600 * 1000; // 90 days
  const body = btoa(JSON.stringify({ u: username, e: exp }));
  return `${body}.${await hmac(env, body)}`;
}

async function verifyToken(env, token) {
  if (!token) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  if ((await hmac(env, body)) !== sig) return null;
  try {
    const { u, e } = JSON.parse(atob(body));
    if (Date.now() > e) return null;
    return u;
  } catch { return null; }
}

async function auth(request, env, minRole = 'pending') {
  const token = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  const username = await verifyToken(env, token);
  if (!username) throw Object.assign(new Error('not signed in'), { status: 401 });
  const user = await env.DB.prepare('SELECT username, name, role FROM users WHERE username = ?')
    .bind(username).first();
  if (!user) throw Object.assign(new Error('account not found'), { status: 401 });
  if (ROLES.indexOf(user.role) < ROLES.indexOf(minRole)) {
    throw Object.assign(new Error(user.role === 'pending'
      ? 'account awaiting admin approval' : `requires ${minRole} role`), { status: 403 });
  }
  return user;
}

const bytesToHex = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
const hexToBytes = (h) => new Uint8Array(h.match(/../g).map((x) => parseInt(x, 16)));

/* ---------------- accounts ---------------- */

async function signup(request, env) {
  const { username, password, name, email } = await request.json();
  const u = String(username || '').trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,24}$/.test(u)) return json({ error: 'username: 3–24 chars, letters/numbers/._-' }, 400);
  if (!password || password.length < 8) return json({ error: 'password must be at least 8 characters' }, 400);
  if (!name || !name.trim()) return json({ error: 'name required' }, 400);
  const count = (await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first()).n;
  const role = count === 0 ? 'admin' : 'pending'; // first account bootstraps as admin
  const { hash, salt } = await hashPassword(password);
  try {
    await env.DB.prepare(
      'INSERT INTO users (username, name, pass_hash, salt, role, created, email) VALUES (?,?,?,?,?,?,?)')
      .bind(u, name.trim().slice(0, 60), hash, salt, role, new Date().toISOString(),
        (email || '').trim().slice(0, 120) || null).run();
  } catch {
    return json({ error: 'username already taken' }, 409);
  }
  const token = await makeToken(env, u);
  return json({ token, role, name: name.trim(), username: u,
    message: role === 'admin' ? 'You are the first user — admin rights granted.' : 'Account created — an admin needs to approve you before you can post.' });
}

async function login(request, env) {
  const { username, password } = await request.json();
  const u = String(username || '').trim().toLowerCase();
  const user = await env.DB.prepare('SELECT * FROM users WHERE username = ?').bind(u).first();
  if (!user) return json({ error: 'wrong username or password' }, 401);
  const { hash } = await hashPassword(password || '', user.salt);
  if (hash !== user.pass_hash) return json({ error: 'wrong username or password' }, 401);
  return json({ token: await makeToken(env, u), role: user.role, name: user.name, username: u });
}

async function me(request, env) {
  const user = await auth(request, env);
  return json({ username: user.username, name: user.name, role: user.role });
}

async function listUsers(request, env) {
  await auth(request, env, 'admin');
  const { results } = await env.DB.prepare(
    'SELECT username, name, role, created FROM users ORDER BY created DESC').all();
  return json(results);
}

async function setRole(request, env) {
  const admin = await auth(request, env, 'admin');
  const { username, role } = await request.json();
  if (username === admin.username && role !== 'admin') return json({ error: 'cannot demote yourself' }, 400);
  if (role === 'remove') {
    await env.DB.prepare('DELETE FROM users WHERE username = ?').bind(username).run();
    return json({ ok: true });
  }
  if (!ROLES.includes(role)) return json({ error: 'bad role' }, 400);
  await env.DB.prepare('UPDATE users SET role = ? WHERE username = ?').bind(role, username).run();
  return json({ ok: true });
}

/* update your own email / roster link */
async function updateProfile(request, env) {
  const user = await auth(request, env);
  const { email, rid } = await request.json();
  if (email !== undefined) {
    await env.DB.prepare('UPDATE users SET email = ? WHERE username = ?')
      .bind((email || '').trim().slice(0, 120) || null, user.username).run();
  }
  if (rid !== undefined) {
    await env.DB.prepare('UPDATE users SET rid = ? WHERE username = ?')
      .bind(String(rid || '').slice(0, 60) || null, user.username).run();
  }
  return json({ ok: true });
}

/* email export for the reminder GitHub Action — guarded by ACTION_KEY secret */
async function exportEmails(request, env) {
  const key = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!env.ACTION_KEY || key !== env.ACTION_KEY) {
    return json({ error: 'forbidden' }, 403);
  }
  const { results } = await env.DB.prepare(
    'SELECT username, name, email, rid FROM users WHERE email IS NOT NULL AND role != ?')
    .bind('pending').all();
  return json(results);
}

/* create a repo in the club GitHub org (leads/admins) */
async function createRepo(request, env) {
  await auth(request, env, 'lead');
  const { name, description, isPrivate } = await request.json();
  const clean = String(name || '').trim().replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 90);
  if (!clean) return json({ error: 'repo name required' }, 400);
  const org = env.GH_ORG || 'USAFA-Blue-Horizon';
  const token = env.GH_ORG_TOKEN || env.GH_TOKEN;
  const r = await fetch(`https://api.github.com/orgs/${org}/repos`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'bluehorizon-portal-worker',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: clean,
      description: String(description || '').slice(0, 250),
      private: !!isPrivate,
      auto_init: true,
    }),
  });
  const j = await r.json();
  if (!r.ok) return json({ error: j.message || `GitHub ${r.status}` }, r.status);
  return json({ ok: true, url: j.html_url, fullName: j.full_name });
}

/* ---------------- GitHub proxy (the shared token lives HERE, server-side) ---------------- */

async function ghProxy(request, env, path) {
  const write = !['GET', 'HEAD'].includes(request.method);
  await auth(request, env, write ? 'member' : 'pending');
  if (!/^contents\//.test(path) && !/^commits/.test(path)) {
    return json({ error: 'path not allowed' }, 403);
  }
  const ghUrl = `https://api.github.com/repos/${env.GH_REPO}/${path}`;
  const headers = {
    Authorization: `Bearer ${env.GH_TOKEN}`,
    Accept: request.headers.get('Accept') || 'application/vnd.github+json',
    'User-Agent': 'bluehorizon-portal-worker',
  };
  const init = { method: request.method, headers };
  if (write) init.body = await request.text();
  const r = await fetch(ghUrl, init);
  const h = new Headers({ 'Content-Type': r.headers.get('Content-Type') || 'application/json' });
  return new Response(r.body, { status: r.status, headers: h });
}

/* ---------------- server-side fetches (PO autofill + 889) ---------------- */

async function pageFetch(request, env, url) {
  await auth(request, env); // any signed-in user; prevents open-proxy abuse
  const target = url.searchParams.get('url') || '';
  if (!/^https?:\/\//i.test(target)) return json({ error: 'bad url' }, 400);
  const r = await fetch(target, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36',
      'Accept-Language': 'en-US',
    },
    redirect: 'follow',
    cf: { cacheTtl: 300 },
  });
  let text = await r.text();
  if (text.length > 2_000_000) text = text.slice(0, 2_000_000);
  return new Response(text, { status: r.status, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}

async function gsa889(request, env, url) {
  await auth(request, env);
  const q = url.searchParams.get('q') || '';
  const r = await fetch(
    `https://889.smartpay.gsa.gov/api/entity-information/v3/entities?samToolsSearch=${encodeURIComponent(q)}&page=0`,
    { headers: { Accept: 'application/json', 'User-Agent': 'bluehorizon-portal-worker' } });
  return new Response(r.body, { status: r.status, headers: { 'Content-Type': 'application/json' } });
}
