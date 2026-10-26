# Security

- Each deployment is self-hosted: your own Cloudflare account, your own Google OAuth client. No data passes through anyone else.
- The server is read-only against YouTube by default (the one write is `reporting_create_job`, which only schedules a YouTube report).
- Optional `ENABLE_VIDEO_EDITS=true` adds `video_update`, which can change only the title, description and tags of videos on the signed-in channel, previews by default, and returns the previous values for rollback. Off unless the operator sets it.
- Google tokens live only inside each grant's encrypted props in Workers KV; the short-lived access-token cache is keyed by a hash.
- Sign-in is refused unless the Google email is in `ALLOWED_EMAILS` or the account owns a channel in `ALLOWED_CHANNEL_IDS`. With neither set, nobody can sign in.
- Each Claude connection has its own grant; a new sign-in never revokes someone else's. A grant unused for 90 days expires; revoking at Google ends all of them.
- Never commit secrets. All configuration is set as Worker secrets.

Report vulnerabilities privately via GitHub Security Advisories on this repository rather than a public issue.
