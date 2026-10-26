// End-to-end OAuth flow against the real provider: two Claude connections that sign in as the
// same Google identity (e.g. a shared Brand Account) must both keep working.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker, { grantUserId } from '../.test-build/worker.mjs';

// --- in-memory KV with list/metadata/expiry, enough for the provider ---
function memoryKV() {
  const m = new Map();
  const live = (k) => { const e = m.get(k); if (e && e.exp && e.exp <= Date.now() / 1000) { m.delete(k); return undefined; } return e; };
  return {
    _m: m,
    async get(k, opt) { const e = live(k); if (!e) return null; const t = typeof opt === 'string' ? opt : opt?.type; return t === 'json' ? JSON.parse(e.v) : e.v; },
    async getWithMetadata(k, opt) { const e = live(k); return { value: e ? (opt === 'json' || opt?.type === 'json' ? JSON.parse(e.v) : e.v) : null, metadata: e?.meta ?? null }; },
    async put(k, v, o = {}) { m.set(k, { v, meta: o.metadata, exp: o.expiration ?? (o.expirationTtl ? Date.now() / 1000 + o.expirationTtl : undefined) }); },
    async delete(k) { m.delete(k); },
    async list({ prefix = '', limit = 1000, cursor } = {}) {
      const names = [...m.keys()].filter((k) => k.startsWith(prefix) && live(k)).sort();
      const start = cursor ? Number(cursor) : 0;
      const page = names.slice(start, start + limit);
      const done = start + limit >= names.length;
      return { keys: page.map((name) => ({ name, metadata: m.get(name).meta, expiration: m.get(name).exp })), list_complete: done, cursor: done ? undefined : String(start + limit) };
    },
  };
}

// --- Google stub: every sign-in is the same Brand Account identity ---
let googleRefreshes = 0;
globalThis.fetch = async (url, init) => {
  const u = String(url);
  if (u.startsWith('https://oauth2.googleapis.com/token')) {
    const body = new URLSearchParams(init.body);
    if (body.get('grant_type') === 'refresh_token') googleRefreshes++;
    return Response.json({ access_token: 'g-at-' + Math.random(), refresh_token: 'g-rt-' + Math.random(), expires_in: 3599 });
  }
  if (u.startsWith('https://openidconnect.googleapis.com')) return Response.json({ email: 'brand-123@pages.plusgoogle.com' });
  if (u.includes('/youtube/v3/channels')) return Response.json({ items: [{ id: 'UCaaaaaaaaaaaaaaaaaaaaaa', snippet: { title: 'Brand' } }] });
  throw new Error('unexpected fetch ' + u);
};

const BASE = 'https://conn.example';
const env = {
  OAUTH_KV: memoryKV(),
  GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'secret',
  ALLOWED_CHANNEL_IDS: 'UCaaaaaaaaaaaaaaaaaaaaaa',
};
const ctx = { waitUntil() {}, passThroughOnException() {} };
const req = (path, init = {}) => worker.fetch(new Request(BASE + path, init), env, ctx);

async function s256(v) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(v));
  return btoa(String.fromCharCode(...new Uint8Array(d))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const cookiesFrom = (res) => (res.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');

/** One full "Connect" in Claude: register, consent, Google, callback, code → tokens. */
async function connect() {
  const reg = await (await req('/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ redirect_uris: ['https://client.example/cb'], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], client_name: 'Claude' }) })).json();
  const verifier = 'v'.repeat(50) + Math.random().toString(36).slice(2);
  const q = new URLSearchParams({ response_type: 'code', client_id: reg.client_id, redirect_uri: 'https://client.example/cb', code_challenge: await s256(verifier), code_challenge_method: 'S256', state: 's', resource: BASE + '/mcp' });
  const consent = await req('/authorize?' + q);
  assert.equal(consent.status, 200, await consent.clone().text());
  const handle = (await consent.text()).match(/name="handle" value="([^"]+)"/)[1];
  const approved = await req('/authorize', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookiesFrom(consent) }, body: new URLSearchParams({ handle, decision: 'approve' }) });
  assert.equal(approved.status, 302);
  const state = new URL(approved.headers.get('Location')).searchParams.get('state');
  const cb = await req(`/callback?code=gcode&state=${encodeURIComponent(state)}`, { headers: { Cookie: [cookiesFrom(consent), cookiesFrom(approved)].filter(Boolean).join('; ') } });
  assert.equal(cb.status, 302, await cb.clone().text());
  const code = new URL(cb.headers.get('Location')).searchParams.get('code');
  const tok = await (await req('/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: 'https://client.example/cb', client_id: reg.client_id, code_verifier: verifier }) })).json();
  assert.ok(tok.refresh_token, JSON.stringify(tok));
  return { clientId: reg.client_id, refresh: tok.refresh_token, access: tok.access_token };
}
const refresh = (c) => req('/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: c.refresh, client_id: c.clientId }) });

test('a second sign-in as the same Google identity does not disconnect the first', async () => {
  // Same client id for both, like Claude's shared client-metadata URL.
  const a = await connect();
  const b = await connectSameClient(a.clientId);
  for (const c of [a, b]) {
    const r = await refresh(c);
    assert.equal(r.status, 200, await r.clone().text());
    const j = await r.json();
    c.refresh = j.refresh_token;
    const mcp = await req('/mcp', { method: 'POST', headers: { Authorization: 'Bearer ' + j.access_token, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    assert.equal(mcp.status, 200);
  }
  assert.equal(googleRefreshes, 2);
});

test('rotated refresh tokens keep working across many refreshes', async () => {
  const c = await connect();
  for (let i = 0; i < 30; i++) {
    const r = await refresh(c);
    assert.equal(r.status, 200);
    c.refresh = (await r.json()).refresh_token;
  }
});

test('grant user id never contains ":" (provider rejects it)', () => {
  assert.equal(grantUserId('', [{ id: 'UCx' }]), 'channel-UCx');
  assert.equal(grantUserId('a@b.c', []), 'a@b.c');
});

// Same client id, new authorization — mirrors two Claude users on one shared client id.
async function connectSameClient(clientId) {
  const verifier = 'w'.repeat(50) + Math.random().toString(36).slice(2);
  const q = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: 'https://client.example/cb', code_challenge: await s256(verifier), code_challenge_method: 'S256', state: 's2', resource: BASE + '/mcp' });
  const consent = await req('/authorize?' + q);
  const handle = (await consent.text()).match(/name="handle" value="([^"]+)"/)[1];
  const approved = await req('/authorize', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookiesFrom(consent) }, body: new URLSearchParams({ handle, decision: 'approve' }) });
  const state = new URL(approved.headers.get('Location')).searchParams.get('state');
  const cb = await req(`/callback?code=gcode2&state=${encodeURIComponent(state)}`, { headers: { Cookie: [cookiesFrom(consent), cookiesFrom(approved)].filter(Boolean).join('; ') } });
  assert.equal(cb.status, 302, await cb.clone().text());
  const code = new URL(cb.headers.get('Location')).searchParams.get('code');
  const tok = await (await req('/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: 'https://client.example/cb', client_id: clientId, code_verifier: verifier }) })).json();
  return { clientId, refresh: tok.refresh_token, access: tok.access_token };
}
