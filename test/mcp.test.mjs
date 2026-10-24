import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleMcp, isAllowed, setupStatus } from '../.test-build/entry.mjs';

const calls = [];
globalThis.fetch = async (url) => {
  const u = String(url);
  calls.push(u);
  if (u.includes('oauth2.googleapis.com/token')) return new Response(JSON.stringify({ access_token: 'NEW', expires_in: 3600 }));
  if (u.includes('youtubeanalytics')) return new Response(JSON.stringify({ columnHeaders: [{ name: 'day' }, { name: 'views' }], rows: [['2026-10-01', 10]] }));
  if (u.includes('/videos?')) return new Response(JSON.stringify({ error: { message: 'quota exceeded' } }), { status: 403 });
  if (u.includes('/reports/r1')) return new Response('date,video_id,views\n20261001,a,5\n20261001,b,7\n');
  return new Response('{}');
};

const kv = new Map();
const env = { OAUTH_KV: { get: async (k) => kv.get(k) ?? null, put: async (k, v) => kv.set(k, v) } };
const fresh = { email: 'a@b.c', channels: [], googleAccessToken: 'OLD', googleRefreshToken: 'R', googleExpiresAt: Date.now() + 3600e3 };
const expired = { ...fresh, googleExpiresAt: Date.now() - 1 };

async function rpc(body, props = fresh) {
  const r = await handleMcp(new Request('https://x/mcp', { method: 'POST', body: JSON.stringify(body) }), env, props);
  return r.status === 202 ? 202 : r.json();
}
const call = (name, args, props) => rpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, props);
const text = (res) => res.result.content[0].text;

test('initialize echoes protocol version', async () => {
  const r = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  assert.equal(r.result.protocolVersion, '2025-06-18');
  assert.ok(r.result.capabilities.tools);
});

test('notifications get 202', async () => {
  assert.equal(await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' }), 202);
});

test('tools/list exposes all tools', async () => {
  const names = (await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).result.tools.map((t) => t.name);
  for (const n of ['whoami', 'analytics_query', 'data_api_get', 'reporting_download', 'api_get']) assert.ok(names.includes(n), n);
});

test('expired Google token is refreshed once, then cached', async () => {
  calls.length = 0;
  const r = await call('analytics_query', { startDate: '2026-10-01', endDate: '2026-10-02', metrics: 'views', dimensions: 'day' }, expired);
  assert.equal(r.result.isError, false);
  assert.deepEqual(JSON.parse(text(r)).rows, [['2026-10-01', 10]]);
  await call('analytics_query', { startDate: '2026-10-01', endDate: '2026-10-02', metrics: 'views' }, expired);
  assert.equal(calls.filter((c) => c.includes('oauth2')).length, 1);
  assert.ok(calls.some((c) => c.includes('ids=channel%3D%3DMINE')));
});

test('API errors are surfaced as tool errors; arrays are comma-joined', async () => {
  const r = await call('data_api_get', { resource: 'videos', params: { part: ['snippet', 'statistics'], id: 'a' } });
  assert.equal(r.result.isError, true);
  assert.match(text(r), /403: quota exceeded/);
  assert.ok(calls.some((c) => c.includes('part=snippet%2Cstatistics')));
});

test('reporting_download filters rows and columns', async () => {
  const r = await call('reporting_download', { downloadUrl: 'https://youtubereporting.googleapis.com/v1/media/reports/r1', columns: ['video_id', 'views'], contains: 'b' });
  assert.deepEqual(JSON.parse(text(r)), { totalRows: 1, header: ['video_id', 'views'], rows: ['b,7'] });
});

test('api_get refuses non-YouTube hosts', async () => {
  const r = await call('api_get', { url: 'https://evil.example/x' });
  assert.equal(r.result.isError, true);
});

test('unknown method returns JSON-RPC error', async () => {
  const r = await rpc({ jsonrpc: '2.0', id: 9, method: 'nope' });
  assert.equal(r.error.code, -32601);
});

test('allowlist fails closed and matches email or channel', () => {
  assert.equal(isAllowed({}, 'a@b.c', []), false);
  assert.equal(isAllowed({ ALLOWED_EMAILS: 'A@B.C' }, 'a@b.c', []), true);
  assert.equal(isAllowed({ ALLOWED_CHANNEL_IDS: 'UC1, UC2' }, '', [{ id: 'UC2' }]), true);
  assert.equal(isAllowed({ ALLOWED_EMAILS: 'x@y.z', ALLOWED_CHANNEL_IDS: 'UC1' }, 'a@b.c', [{ id: 'UC9' }]), false);
});

test('setup status reports booleans and ignores placeholder channel ids', () => {
  assert.deepEqual(setupStatus({}), { googleClientId: false, googleClientSecret: false, allowlist: false });
  assert.equal(setupStatus({ ALLOWED_CHANNEL_IDS: 'none' }).allowlist, false);
  assert.equal(setupStatus({ ALLOWED_CHANNEL_IDS: 'UCN0aaaaaaaaaaaaaaaaaaaa' }).allowlist, true);
  assert.equal(setupStatus({ GOOGLE_CLIENT_ID: 'x', GOOGLE_CLIENT_SECRET: 'y', ALLOWED_EMAILS: 'a@b.c' }).allowlist, true);
});

// ---- opt-in video edits ----
const editEnv = { ...env, ENABLE_VIDEO_EDITS: 'true' };
const owned = { ...fresh, channels: [{ id: 'UCmine', title: 'Mine' }] };
async function rpcE(body, props = owned) {
  const r = await handleMcp(new Request('https://x/mcp', { method: 'POST', body: JSON.stringify(body) }), editEnv, props);
  return r.json();
}
const callE = (args, props) => rpcE({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'video_update', arguments: args } }, props);

test('video_update is hidden and refused unless ENABLE_VIDEO_EDITS=true', async () => {
  const names = (await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).result.tools.map((t) => t.name);
  assert.ok(!names.includes('video_update'));
  const r = await call('video_update', { videoId: 'abcdefghijk' });
  assert.equal(r.result.isError, true);
  const on = (await rpcE({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).result.tools.map((t) => t.name);
  assert.ok(on.includes('video_update'));
});

test('video_update previews by default, keeps omitted fields, and applies with apply:true', async () => {
  const sent = [];
  const prev = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (init?.method === 'PUT') { sent.push(JSON.parse(init.body)); return new Response('{}'); }
    if (u.includes('/videos?part=snippet&id=')) return new Response(JSON.stringify({ items: [{ id: 'abcdefghijk', snippet: { channelId: 'UCmine', title: 'Old', description: 'Desc', tags: ['a'], categoryId: '27', defaultLanguage: 'en' } }] }));
    return prev(url, init);
  };
  try {
    let r = await callE({ videoId: 'abcdefghijk', description: 'New desc' });
    let j = JSON.parse(r.result.content[0].text);
    assert.equal(j.applied, false);
    assert.deepEqual(j.changed, ['description']);
    assert.equal(sent.length, 0);
    r = await callE({ videoId: 'abcdefghijk', description: 'New desc', apply: true });
    j = JSON.parse(r.result.content[0].text);
    assert.equal(j.applied, true);
    assert.deepEqual(sent[0].snippet, { title: 'Old', description: 'New desc', tags: ['a'], categoryId: '27', defaultLanguage: 'en' });
    r = await callE({ videoId: 'abcdefghijk', title: 'Bad <b>' , apply: true });
    assert.equal(r.result.isError, true);
    r = await callE({ videoId: 'abcdefghijk', title: 'X', apply: true }, { ...owned, channels: [{ id: 'UCother', title: 'x' }] });
    assert.match(r.result.content[0].text, /not on the signed-in channel/);
    assert.equal(sent.length, 1);
  } finally {
    globalThis.fetch = prev;
  }
});
