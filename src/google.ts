// Google OAuth + API helpers.

export interface Env {
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: import('@cloudflare/workers-oauth-provider').OAuthHelpers;
  ALLOWED_EMAILS?: string;       // secret, comma-separated
  ALLOWED_CHANNEL_IDS?: string;  // secret, comma-separated
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  CONSENT_SECRET?: string; // optional; derived from GOOGLE_CLIENT_SECRET when unset
  ENABLE_VIDEO_EDITS?: string; // optional; "true" adds the video_update tool and the scope it needs
}

/** What we keep (encrypted) inside each MCP grant. */
export interface Props {
  email: string;
  channels: { id: string; title: string }[];
  googleAccessToken: string;
  googleRefreshToken: string;
  googleExpiresAt: number; // epoch ms
}

export const GOOGLE_SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/youtube.readonly',
  'https://www.googleapis.com/auth/yt-analytics.readonly',
  'https://www.googleapis.com/auth/yt-analytics-monetary.readonly',
];

/** Needed only by the opt-in video_update tool (YouTube's narrowest scope that allows videos.update). */
export const EDIT_SCOPE = 'https://www.googleapis.com/auth/youtube.force-ssl';

export function videoEditsEnabled(env: Env): boolean {
  return String(env.ENABLE_VIDEO_EDITS ?? '').trim().toLowerCase() === 'true';
}

export function googleScopes(env: Env): string[] {
  return videoEditsEnabled(env) ? [...GOOGLE_SCOPES, EDIT_SCOPE] : GOOGLE_SCOPES;
}

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';

export function redirectUri(origin: string): string {
  return origin + '/callback';
}

export function googleAuthorizeUrl(env: Env, origin: string, state: string, codeChallenge: string): string {
  const u = new URL(AUTH_URL);
  u.searchParams.set('client_id', env.GOOGLE_CLIENT_ID);
  u.searchParams.set('redirect_uri', redirectUri(origin));
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', googleScopes(env).join(' '));
  u.searchParams.set('access_type', 'offline');
  u.searchParams.set('prompt', 'consent select_account'); // always return a refresh token; allow Brand Account pick
  u.searchParams.set('include_granted_scopes', 'true');
  u.searchParams.set('state', state);
  u.searchParams.set('code_challenge', codeChallenge);
  u.searchParams.set('code_challenge_method', 'S256');
  return u.toString();
}

export interface GoogleTokens {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope?: string;
}

export async function exchangeCode(env: Env, origin: string, code: string, verifier: string): Promise<GoogleTokens> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri(origin),
      grant_type: 'authorization_code',
      code_verifier: verifier,
    }),
  });
  const body = (await res.json()) as any;
  if (!res.ok) throw new Error(`Google token exchange failed: ${body.error} ${body.error_description ?? ''}`);
  return body as GoogleTokens;
}

export class GoogleRefreshError extends Error {
  constructor(public revoked: boolean, message: string) {
    super(message);
  }
}

export async function refreshGoogle(env: Env, refreshToken: string): Promise<GoogleTokens> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  const body = (await res.json().catch(() => ({}))) as any;
  if (!res.ok) {
    throw new GoogleRefreshError(body.error === 'invalid_grant', `Google refresh failed: ${body.error ?? res.status}`);
  }
  return body as GoogleTokens;
}

/** A valid Google access token for this grant: from props, a short KV cache, or a fresh refresh. */
export async function accessToken(env: Env, props: Props): Promise<string> {
  if (props.googleExpiresAt - Date.now() > 60_000) return props.googleAccessToken;
  const key = 'gat:' + (await sha256(props.googleRefreshToken));
  const cached = await env.OAUTH_KV.get(key);
  if (cached) return cached;
  const t = await refreshGoogle(env, props.googleRefreshToken);
  const ttl = Math.max(60, t.expires_in - 120);
  await env.OAUTH_KV.put(key, t.access_token, { expirationTtl: ttl });
  return t.access_token;
}

export async function googleGet(token: string, url: string): Promise<{ status: number; text: string; contentType: string }> {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, 'Accept-Encoding': 'gzip' } });
  return { status: res.status, text: await res.text(), contentType: res.headers.get('content-type') ?? '' };
}

export async function googleSend(token: string, url: string, method: string, body: unknown) {
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, text: await res.text() };
}

export async function userInfo(token: string): Promise<{ email: string }> {
  const r = await googleGet(token, USERINFO_URL);
  if (r.status !== 200) return { email: '' };
  const j = JSON.parse(r.text);
  return { email: (j.email ?? '').toLowerCase() };
}

export async function ownedChannels(token: string): Promise<{ id: string; title: string }[]> {
  const r = await googleGet(token, 'https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true&maxResults=50');
  if (r.status !== 200) return [];
  const j = JSON.parse(r.text);
  return (j.items ?? []).map((c: any) => ({ id: c.id, title: c.snippet?.title ?? '' }));
}

export function isAllowed(env: Env, email: string, channels: { id: string }[]): boolean {
  const emails = list(env.ALLOWED_EMAILS).map((e) => e.toLowerCase());
  const chans = list(env.ALLOWED_CHANNEL_IDS);
  if (!emails.length && !chans.length) return false; // fail closed when not configured
  return (!!email && emails.includes(email.toLowerCase())) || channels.some((c) => chans.includes(c.id));
}

function list(s: string | undefined): string[] {
  return (s ?? '').split(',').map((x) => x.trim()).filter(Boolean);
}

export async function sha256(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function s256Challenge(verifier: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(d))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Key for the signed "remember consent" cookie. */
export async function consentSecret(env: Env): Promise<string> {
  if (env.CONSENT_SECRET && env.CONSENT_SECRET.length >= 32) return env.CONSENT_SECRET;
  return sha256('consent-cookie:' + env.GOOGLE_CLIENT_SECRET);
}

/** Which required settings are present (booleans only — never values). */
export function setupStatus(env: Env) {
  return {
    googleClientId: !!env.GOOGLE_CLIENT_ID,
    googleClientSecret: !!env.GOOGLE_CLIENT_SECRET,
    allowlist: list(env.ALLOWED_EMAILS).length + list(env.ALLOWED_CHANNEL_IDS).filter((c) => /^UC[\w-]{22}$/.test(c)).length > 0,
  };
}
