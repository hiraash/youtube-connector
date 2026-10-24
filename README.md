# YouTube Connector for Claude

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/hiraash/youtube-connector)

Give Claude **full, read-only access to your YouTube channel** — analytics, revenue, retention, traffic, audience, comments and bulk reports — so it can answer any question with whatever query it needs, not a fixed dashboard.

Self-hosted on your own **free** Cloudflare account. You sign in with Google; your data never passes through anyone else.

> "Which videos earned the most per 1,000 views last quarter, and what do they have in common?"
> "Where do viewers drop off in my last 5 videos?"
> "What search terms bring people to my channel, by country?"
> "Summarise what commenters asked for this month."

---

## Deploy in ~10 minutes

You need: a free [Cloudflare](https://dash.cloudflare.com/sign-up) account, a GitHub account, and the Google account that owns your channel.

### 1. Find your connector URL (30 sec)
Open [Cloudflare → Workers & Pages](https://dash.cloudflare.com/?to=/:account/workers-and-pages). Note your **workers.dev subdomain** (first visit asks you to pick one).

Your connector will live at:
```
https://youtube-connector.<your-subdomain>.workers.dev
```

### 2. Create a Google OAuth client (5 min)
1. [Create a Google Cloud project](https://console.cloud.google.com/projectcreate) (any name).
2. [Enable the three YouTube APIs](https://console.cloud.google.com/flows/enableapi?apiid=youtube.googleapis.com,youtubeanalytics.googleapis.com,youtubereporting.googleapis.com) → **Enable**.
3. [Google Auth Platform → Get started](https://console.cloud.google.com/auth/overview): app name `YouTube Connector`, your email, audience **External** → **Create**.
4. [Audience](https://console.cloud.google.com/auth/audience) → **Publish app** → confirm. *(Skip this and sign-ins expire every 7 days.)*
5. [Clients → Create client](https://console.cloud.google.com/auth/clients/create):
   - Type **Web application**
   - Authorized redirect URI: `https://youtube-connector.<your-subdomain>.workers.dev/callback`
   - **Create** → copy the **Client ID** and **Client secret**.

### 3. Deploy (2 min)
Click **Deploy to Cloudflare** above, connect GitHub, and fill in:

| Field | Value |
|---|---|
| `GOOGLE_CLIENT_ID` | from step 2 |
| `GOOGLE_CLIENT_SECRET` | from step 2 |
| `ALLOWED_EMAILS` | Google emails allowed to connect, comma-separated |
| `ALLOWED_CHANNEL_IDS` | `none` — or your channel ID (`UC…`) if the channel is a **Brand Account** |

Keep the project name `youtube-connector` (or use your own name in the URLs above). Click **Deploy**.

### 4. Check it (30 sec)
Open `https://youtube-connector.<your-subdomain>.workers.dev`. It should say **"Connector is running."** If anything is missing, it shows a checklist of what's missing plus the exact redirect URI and connector URL (once configured, the page reveals nothing else).

### 5. Connect Claude (1 min)
- **Claude (web, desktop, mobile):** Settings → **Connectors → Add custom connector** → URL `https://youtube-connector.<your-subdomain>.workers.dev/mcp`.
  On Team/Enterprise plans an owner adds it under organisation settings; each member then clicks **Connect**.
- **Claude Code:** `claude mcp add --transport http youtube https://youtube-connector.<your-subdomain>.workers.dev/mcp`
- Any MCP client that supports remote servers with OAuth works.

Click **Connect** → **Continue with Google** → pick the account **or Brand Account that owns the channel**. Google will say *"Google hasn't verified this app"* — that's your own app: **Advanced → Go to YouTube Connector → Continue**.

Done. Ask Claude something about your channel.

---

## What Claude gets

| Tool | Purpose |
|---|---|
| `whoami` | Which Google account / channel is connected |
| `analytics_query` | Any [YouTube Analytics](https://developers.google.com/youtube/analytics/metrics) report — any metric, dimension and filter, full history, incl. revenue, CPM, RPM, retention, demographics, traffic sources and search terms |
| `data_api_get` | Any [YouTube Data API](https://developers.google.com/youtube/v3/docs) list call — videos, playlists, comments, search, captions list |
| `reporting_*` | [Reporting API](https://developers.google.com/youtube/reporting/v1/reports) bulk reports — the only source of **thumbnail impressions and CTR** |
| `api_get` | Any other GET on the three YouTube API hosts |

Read-only. The one exception, `reporting_create_job`, just asks YouTube to start generating a daily report.

## Security & privacy
- Runs entirely in **your** Cloudflare account with **your** Google OAuth client.
- Only `ALLOWED_EMAILS` / owners of `ALLOWED_CHANNEL_IDS` can sign in. If neither is set, nobody can.
- Google tokens are stored only inside each grant's encrypted record; nothing else is kept.
- Revoke any time: disconnect in Claude, or [Google Account → Third-party access](https://myaccount.google.com/permissions).

See [SECURITY.md](SECURITY.md).

## Cost
Free for personal use. Typical use is a few hundred requests a day against Cloudflare's free 100,000/day (account-wide). If a free limit is ever hit, requests fail — nothing is billed. Very large bulk-report downloads can exceed the free plan's 10 ms CPU per request; narrow them with the tool's `contains` / `columns` options.

## Troubleshooting

| Problem | Fix |
|---|---|
| `redirect_uri_mismatch` | Copy the redirect URI from the setup page into the Google client exactly. |
| "not allowed to use this connector" | Add that email to `ALLOWED_EMAILS`, or the channel ID to `ALLOWED_CHANNEL_IDS` (Brand Accounts). |
| Revenue metrics error / empty | Sign in with the account that owns or manages the channel and has monetisation. |
| Have to reconnect every week | Google app is still in *Testing* — step 2.4, **Publish app**. |
| Setup page shows a checklist | Something is missing — Cloudflare → Workers & Pages → `youtube-connector` → Settings → Variables and Secrets. |

Change settings any time in **Variables and Secrets**; no redeploy needed.

## Good to know
- Analytics days are US Pacific time; data lags 2–3 days; revenue is an estimate until paid.
- Reporting jobs produce their first files 1–2 days after creation — ask Claude to create the ones you need early.
- YouTube Data API quota: 10,000 units/day (search costs 100).

---

## Development

```sh
npm install
cp .dev.vars.example .dev.vars   # fill in for local runs
npm run dev                      # http://localhost:8787
npm run typecheck && npm test
```

Manual deploy instead of the button: `npx wrangler deploy`, then `npx wrangler secret put <NAME>` for each setting. The `OAUTH_KV` namespace is created automatically (Wrangler ≥ 4.45).

Built with [`@cloudflare/workers-oauth-provider`](https://github.com/cloudflare/workers-oauth-provider) (OAuth 2.1, DCR + CIMD, PKCE) and a minimal stateless MCP server over Streamable HTTP. CI runs type-check and tests on every PR.

## License

MIT — see [LICENSE](LICENSE). Use of YouTube data is subject to the [YouTube API Services Terms](https://developers.google.com/youtube/terms/api-services-terms-of-service), which each deployer accepts for their own Google Cloud project.
