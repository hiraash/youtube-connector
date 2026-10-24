// YouTube MCP connector — Cloudflare Worker entry.
// OAuth 2.1 for MCP clients (Claude) with Google as the upstream sign-in.
import OAuthProvider, {
  AuthorizationError,
  CimdFetchError,
  OAuthError,
  authorizationErrorRedirect,
  type AuthRequest,
  type ConsentDescription,
} from '@cloudflare/workers-oauth-provider';
import {
  exchangeCode,
  googleAuthorizeUrl,
  GoogleRefreshError,
  isAllowed,
  ownedChannels,
  refreshGoogle,
  s256Challenge,
  setupStatus,
  consentSecret,
  userInfo,
  type Env,
  type Props,
} from './google';
import { handleMcp } from './mcp';

// One provider per public origin (workers.dev URL or custom domain) — no URL config needed.
const providers = new Map<string, OAuthProvider<Env>>();

function getProvider(env: Env, base: string): OAuthProvider<Env> {
  const existing = providers.get(base);
  if (existing) return existing;
  const provider = new OAuthProvider<Env>({
    apiRoute: '/mcp',
    apiHandler: {
      fetch: (request: Request, env: Env, ctx: any) => handleMcp(request, env, ctx.props as Props),
    },
    defaultHandler: { fetch: (request: Request, env: Env) => app(request, env, base) } as ExportedHandler<Env>,
    authorizeEndpoint: '/authorize',
    tokenEndpoint: '/token',
    clientRegistrationEndpoint: '/register',
    clientIdMetadataDocumentEnabled: true,
    scopesSupported: ['youtube:read', 'offline_access'],
    resourceMetadata: { resource: base + '/mcp', authorization_servers: [base] },
    refreshTokenTTL: 365 * 24 * 3600,     // grant can live up to a year…
    refreshTokenIdleTTL: 90 * 24 * 3600,  // …as long as it's used at least every 90 days
    tokenExchangeCallback: async ({ grantType, props }) => {
      const p = props as Props;
      if (grantType === 'authorization_code') {
        return { accessTokenTTL: ttlSeconds(p.googleExpiresAt) };
      }
      if (grantType === 'refresh_token') {
        try {
          const t = await refreshGoogle(env, p.googleRefreshToken);
          const next: Props = {
            ...p,
            googleAccessToken: t.access_token,
            googleExpiresAt: Date.now() + t.expires_in * 1000,
            googleRefreshToken: t.refresh_token ?? p.googleRefreshToken,
          };
          return { newProps: next, accessTokenTTL: ttlSeconds(next.googleExpiresAt) };
        } catch (e) {
          if (e instanceof GoogleRefreshError && e.revoked) {
            throw new OAuthError('invalid_grant', { description: 'Google access was revoked — reconnect the connector.' });
          }
          throw new OAuthError('temporarily_unavailable', { description: 'Google is unavailable', statusCode: 503 });
        }
      }
    },
  });
  providers.set(base, provider);
  return provider;
}

function ttlSeconds(expiresAt: number): number {
  return Math.max(60, Math.floor((expiresAt - Date.now()) / 1000) - 60);
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    return getProvider(env, new URL(request.url).origin).fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;

// ---------------------------------------------------------------------------
// Browser-facing routes: /authorize (consent → Google), /callback, /
// ---------------------------------------------------------------------------
async function app(req: Request, env: Env, base: string): Promise<Response> {
  const url = new URL(req.url);
  const oauth = env.OAUTH_PROVIDER;
  try {
    if (url.pathname.startsWith('/authorize') || url.pathname === '/callback') {
      const s = setupStatus(env);
      if (!s.googleClientId || !s.googleClientSecret || !s.allowlist) {
        return page(503, 'This connector is not configured yet. Open <a href="/">the setup page</a>.');
      }
    }

    if (url.pathname === '/authorize' && req.method === 'GET') {
      const authReq = await oauth.parseAuthRequest(req);
      if (await oauth.isConsentRemembered(req, authReq, { secret: await consentSecret(env) })) {
        return toGoogle(env, base, authReq, new Headers());
      }
      const details = await oauth.describeConsent(authReq);
      const consent = await oauth.beginConsent(authReq);
      consent.headers.set('Content-Type', 'text/html; charset=utf-8');
      return new Response(consentPage(details, consent.handle), { headers: consent.headers });
    }

    if (url.pathname === '/authorize' && req.method === 'POST') {
      const form = await req.formData();
      const handle = String(form.get('handle'));
      if (form.get('decision') !== 'approve') {
        const denied = await oauth.denyConsent(req, handle);
        denied.headers.set('Location', denied.redirectTo);
        return new Response(null, { status: 302, headers: denied.headers });
      }
      const approved = await oauth.approveConsent(req, handle, { remember: { secret: await consentSecret(env) } });
      return toGoogle(env, base, approved.request, approved.headers);
    }

    if (url.pathname === '/callback') {
      const { request: original, data, headers } = await oauth.finishUpstream<{ verifier: string }>(req);
      const code = url.searchParams.get('code');
      if (url.searchParams.get('error') || !code) {
        headers.set('Location', authorizationErrorRedirect(original, 'access_denied'));
        return new Response(null, { status: 302, headers });
      }
      const tokens = await exchangeCode(env, base, code, data.verifier);
      if (!tokens.refresh_token) {
        return page(400, 'Google did not return a refresh token. Remove the app at myaccount.google.com/permissions and connect again.');
      }
      const [{ email }, channels] = await Promise.all([userInfo(tokens.access_token), ownedChannels(tokens.access_token)]);
      if (!isAllowed(env, email, channels)) {
        return page(403, `This Google account (${esc(email || 'unknown email')}; channels: ${esc(channels.map((c) => c.title).join(', ') || 'none')}) is not allowed to use this connector.`);
      }
      const props: Props = {
        email,
        channels,
        googleAccessToken: tokens.access_token,
        googleRefreshToken: tokens.refresh_token,
        googleExpiresAt: Date.now() + tokens.expires_in * 1000,
      };
      const userId = email || 'channel:' + (channels[0]?.id ?? 'unknown');
      const { redirectTo } = await oauth.completeAuthorization({
        request: original,
        userId,
        metadata: { email, channels: channels.map((c) => c.id) },
        scope: original.scope,
        props,
      });
      headers.set('Location', redirectTo);
      return new Response(null, { status: 302, headers });
    }

    if (url.pathname === '/') {
      return setupPage(env, base);
    }
    return new Response('Not found', { status: 404 });
  } catch (error: any) {
    if (error instanceof AuthorizationError && (error as any).redirectTo) {
      return Response.redirect((error as any).redirectTo, 302);
    }
    if (error instanceof AuthorizationError || error instanceof CimdFetchError) {
      const msg = error instanceof AuthorizationError ? error.description : 'This app could not be verified.';
      return page(400, esc(msg ?? 'Authorization error'));
    }
    throw error;
  }
}

async function toGoogle(env: Env, base: string, authReq: AuthRequest, prev: Headers): Promise<Response> {
  const verifier = crypto.randomUUID() + crypto.randomUUID();
  const { state, headers } = await env.OAUTH_PROVIDER.beginUpstream(authReq, { data: { verifier }, headers: prev });
  headers.set('Location', googleAuthorizeUrl(env, base, state, await s256Challenge(verifier)));
  return new Response(null, { status: 302, headers });
}

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------
const esc = (v: string) => String(v).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const CSS = `body{font:16px/1.5 system-ui,sans-serif;max-width:520px;margin:40px auto;padding:0 16px;color:#1a1a1a;background:#fafafa}
h1{font-size:22px}.card{background:#fff;border:1px solid #e5e5e5;border-radius:12px;padding:20px}
button{font:inherit;padding:10px 18px;border-radius:8px;border:1px solid #ccc;background:#fff;cursor:pointer}
button.primary{background:#c00;color:#fff;border-color:#c00}.warn{color:#a40}code{background:#f0f0f0;padding:2px 4px;border-radius:4px}`;

function consentPage(d: ConsentDescription, handle: string): string {
  const origin = d.clientDomain
    ? `Published by <strong>${esc(d.clientDomain)}</strong>.`
    : 'This app registered itself; its name is not verified.';
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect ${esc(d.clientName)}</title><style>${CSS}</style>
<div class="card"><h1>Allow <strong>${esc(d.clientName)}</strong> to read your YouTube data?</h1>
<p>${origin} Access will be sent to <strong>${esc(d.redirectHost)}</strong>.</p>
${d.redirectIsLoopback ? '<p class="warn"><strong>This sends access to an app on your computer.</strong> Continue only if you just started connecting from it.</p>' : ''}
<p>Read-only: channel, videos, comments, analytics and revenue reports. Next you will sign in with Google — pick the account or Brand Account that owns the channel.</p>
<form method="post"><input type="hidden" name="handle" value="${esc(handle)}">
<button class="primary" name="decision" value="approve">Continue with Google</button> <button name="decision" value="deny">Cancel</button></form></div>`;
}

function setupPage(env: Env, base: string): Response {
  const s = setupStatus(env);
  const ready = s.googleClientId && s.googleClientSecret && s.allowlist;
  const row = (okay: boolean, label: string, fix: string) =>
    `<li>${okay ? '✅' : '❌'} ${label}${okay ? '' : ` — <span class="warn">${fix}</span>`}</li>`;
  const copy = (v: string) => `<code>${esc(v)}</code>`;
  return new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>YouTube connector — setup</title><style>${CSS} li{margin:6px 0} code{word-break:break-all}</style>
<div class="card"><h1>YouTube connector ${ready ? 'is ready' : 'setup'}</h1>
<p><strong>Google OAuth redirect URI</strong> (paste into your Google OAuth client):<br>${copy(base + '/callback')}</p>
<ul>
${row(s.googleClientId, 'GOOGLE_CLIENT_ID', 'add it as a Worker secret')}
${row(s.googleClientSecret, 'GOOGLE_CLIENT_SECRET', 'add it as a Worker secret')}
${row(s.allowlist, 'ALLOWED_EMAILS or ALLOWED_CHANNEL_IDS', 'add at least one, or nobody can sign in')}
</ul>
<p>Secrets: Cloudflare dashboard → Workers &amp; Pages → this Worker → Settings → Variables and Secrets. Changes apply immediately — refresh this page.</p>
<p><strong>Connector URL for Claude</strong> (Settings → Connectors → Add custom connector):<br>${copy(base + '/mcp')}</p>
<p>Claude Code: ${copy('claude mcp add --transport http youtube ' + base + '/mcp')}</p></div>`, {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'X-Frame-Options': 'DENY' },
  });
}

function page(status: number, html: string): Response {
  return new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>YouTube connector</title><style>${CSS}</style><div class="card"><p>${html}</p></div>`, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'X-Frame-Options': 'DENY' },
  });
}
