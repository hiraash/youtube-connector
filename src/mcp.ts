// Minimal stateless MCP server over Streamable HTTP (JSON responses, no sessions).
import { callTool, TOOLS } from './tools';
import type { Env, Props } from './google';

const SERVER_INFO = { name: 'youtube-connector', version: '1.0.0' };
const DEFAULT_PROTOCOL = '2025-06-18';

const INSTRUCTIONS = [
  'Read-only access to the signed-in YouTube channel via the YouTube Data, Analytics and Reporting APIs. Call whoami to see which channel.',
  'Prefer analytics_query for metrics (any metric/dimension/filter, full history). Use data_api_get for video lists, metadata and comments.',
  'Money is USD by default and is an estimate until paid. Analytics days are US Pacific time; data lags ~2–3 days.',
  'Thumbnail impressions and impression CTR are only in the Reporting API (reporting_* tools).',
].join(' ');

export async function handleMcp(request: Request, env: Env, props: Props): Promise<Response> {
  if (request.method === 'GET') return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'POST' } });
  if (request.method === 'DELETE') return new Response(null, { status: 204 });
  if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'POST' } });

  let msg: any;
  try {
    msg = await request.json();
  } catch {
    return json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, 400);
  }

  if (Array.isArray(msg)) {
    const out = (await Promise.all(msg.map((m) => handleOne(m, env, props)))).filter(Boolean);
    return out.length ? json(out) : new Response(null, { status: 202 });
  }
  const res = await handleOne(msg, env, props);
  return res ? json(res) : new Response(null, { status: 202 });
}

async function handleOne(m: any, env: Env, props: Props): Promise<any | null> {
  const isNotification = m?.id === undefined || m?.id === null;
  if (!m || m.jsonrpc !== '2.0' || typeof m.method !== 'string') {
    return isNotification ? null : rpcErr(m?.id ?? null, -32600, 'Invalid Request');
  }
  if (isNotification) return null; // notifications/initialized, cancelled, etc.

  switch (m.method) {
    case 'initialize':
      return ok(m.id, {
        protocolVersion: m.params?.protocolVersion ?? DEFAULT_PROTOCOL,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      });
    case 'ping':
      return ok(m.id, {});
    case 'tools/list':
      return ok(m.id, {
        tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, annotations: t.annotations })),
      });
    case 'tools/call':
      return ok(m.id, await callTool(m.params?.name, m.params?.arguments ?? {}, env, props));
    case 'resources/list':
      return ok(m.id, { resources: [] });
    case 'prompts/list':
      return ok(m.id, { prompts: [] });
    default:
      return rpcErr(m.id, -32601, `Method not found: ${m.method}`);
  }
}

const ok = (id: any, result: any) => ({ jsonrpc: '2.0', id, result });
const rpcErr = (id: any, code: number, message: string) => ({ jsonrpc: '2.0', id, error: { code, message } });
const json = (body: any, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
