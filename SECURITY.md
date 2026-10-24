# Security

- Each deployment is self-hosted: your own Cloudflare account, your own Google OAuth client. No data passes through anyone else.
- The server is read-only against YouTube (the one write is `reporting_create_job`, which only schedules a YouTube report).
- Google tokens live only inside each grant's encrypted props in Workers KV; the short-lived access-token cache is keyed by a hash.
- Sign-in is refused unless the Google email is in `ALLOWED_EMAILS` or the account owns a channel in `ALLOWED_CHANNEL_IDS`. With neither set, nobody can sign in.
- Never commit secrets. All configuration is set as Worker secrets.

Report vulnerabilities privately via GitHub Security Advisories on this repository rather than a public issue.
