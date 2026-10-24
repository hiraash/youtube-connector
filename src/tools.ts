// Read-only YouTube tools exposed over MCP.
import { accessToken, googleGet, googleSend, type Env, type Props } from './google';

const DATA = 'https://www.googleapis.com/youtube/v3/';
const ANALYTICS = 'https://youtubeanalytics.googleapis.com/v2/';
const REPORTING = 'https://youtubereporting.googleapis.com/v1/';
const ALLOWED_PREFIXES = [DATA, ANALYTICS, REPORTING];
const MAX_TEXT = 200_000; // chars returned to the model per call

type Json = Record<string, any>;
interface ToolDef {
  name: string;
  description: string;
  inputSchema: Json;
  annotations?: Json;
  run: (args: Json, ctx: { env: Env; props: Props; token: () => Promise<string> }) => Promise<string>;
}

const RO = { readOnlyHint: true, openWorldHint: true };

const DATA_RESOURCES = [
  'activities', 'captions', 'channels', 'channelSections', 'comments', 'commentThreads', 'i18nLanguages',
  'i18nRegions', 'playlistItems', 'playlists', 'search', 'subscriptions', 'videoAbuseReportReasons',
  'videoCategories', 'videos', 'members', 'membershipsLevels',
];

export const TOOLS: ToolDef[] = [
  {
    name: 'whoami',
    description: 'Show which Google account this connector is signed in as and which YouTube channels it owns/manages. Call first if access errors appear.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: RO,
    run: async (_a, { props, token }) => {
      const r = await googleGet(await token(), DATA + 'channels?part=snippet,statistics&mine=true&maxResults=50');
      return JSON.stringify({ email: props.email, grantedChannels: props.channels, liveChannels: safeJson(r.text) }, null, 1);
    },
  },
  {
    name: 'analytics_query',
    description: [
      'Run any YouTube Analytics API v2 report (reports.query) — full passthrough, full history.',
      'Revenue metrics (estimatedRevenue, estimatedAdRevenue, grossRevenue, cpm, playbackBasedCpm, monetizedPlaybacks, adImpressions) need the channel owner/manager sign-in.',
      'Rules: days are US Pacific time; `video` dimension needs `sort` and maxResults ≤ 200; retention uses dimension `elapsedVideoTimeRatio` with filter `video==ID`;',
      'search terms: dimensions=insightTrafficSourceDetail&filters=insightTrafficSourceType==YT_SEARCH. Metric/dimension reference: https://developers.google.com/youtube/analytics/metrics and /dimensions.',
      'Returns {columns, rows}.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        startDate: { type: 'string', description: 'YYYY-MM-DD' },
        endDate: { type: 'string', description: 'YYYY-MM-DD' },
        metrics: { type: 'string', description: 'Comma-separated, e.g. views,estimatedMinutesWatched,estimatedRevenue' },
        dimensions: { type: 'string', description: 'Comma-separated, e.g. day | video | country | insightTrafficSourceType' },
        filters: { type: 'string', description: 'e.g. video==abc123;country==IN' },
        sort: { type: 'string', description: 'e.g. -views' },
        maxResults: { type: 'integer' },
        startIndex: { type: 'integer', description: '1-based' },
        currency: { type: 'string', description: 'ISO 4217, default USD' },
        ids: { type: 'string', description: 'Default channel==MINE. Or channel==UC...' },
        includeHistoricalChannelData: { type: 'boolean' },
      },
      required: ['startDate', 'endDate', 'metrics'],
      additionalProperties: false,
    },
    annotations: RO,
    run: async (a, { token }) => {
      const p: Json = { ids: 'channel==MINE', ...a };
      const r = await googleGet(await token(), ANALYTICS + 'reports?' + qs(p));
      if (r.status !== 200) return err(r);
      const j = JSON.parse(r.text);
      return cap(JSON.stringify({
        columns: (j.columnHeaders ?? []).map((h: any) => h.name),
        rowCount: (j.rows ?? []).length,
        rows: j.rows ?? [],
      }));
    },
  },
  {
    name: 'data_api_get',
    description: [
      'GET any YouTube Data API v3 list endpoint (read-only). `params` are passed as query params; arrays are comma-joined.',
      'Always pass `part`. Use `mine: true` on channels/playlists for the signed-in channel; `fields` to trim output.',
      'Examples: videos {part:"snippet,contentDetails,statistics", id:"a,b"} · playlistItems {part:"contentDetails", playlistId, maxResults:50} ·',
      'commentThreads {part:"snippet", allThreadsRelatedToChannelId:"UC…", maxResults:100} · search {part:"snippet", q:"igcse biology", type:"video"} (search costs 100 quota units).',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        resource: { type: 'string', enum: DATA_RESOURCES },
        params: { type: 'object', additionalProperties: true },
      },
      required: ['resource', 'params'],
      additionalProperties: false,
    },
    annotations: RO,
    run: async (a, { token }) => {
      if (!DATA_RESOURCES.includes(a.resource)) return 'ERROR Unknown resource';
      const r = await googleGet(await token(), DATA + a.resource + '?' + qs(a.params ?? {}));
      return r.status === 200 ? cap(r.text) : err(r);
    },
  },
  {
    name: 'reporting_list_report_types',
    description: 'YouTube Reporting API: list bulk report types available to this channel (e.g. channel_basic_a2, reach / thumbnail-impression reports, demographics, traffic sources).',
    inputSchema: { type: 'object', properties: { includeSystemManaged: { type: 'boolean' } }, additionalProperties: false },
    annotations: RO,
    run: async (a, { token }) => {
      const r = await googleGet(await token(), REPORTING + 'reportTypes?' + qs({ pageSize: 100, ...a }));
      return r.status === 200 ? cap(r.text) : err(r);
    },
  },
  {
    name: 'reporting_list_jobs',
    description: 'YouTube Reporting API: list existing reporting jobs (each job produces one daily report of a type).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: RO,
    run: async (_a, { token }) => {
      const r = await googleGet(await token(), REPORTING + 'jobs?pageSize=100');
      return r.status === 200 ? cap(r.text) : err(r);
    },
  },
  {
    name: 'reporting_create_job',
    description: 'YouTube Reporting API: create a job so YouTube starts generating a daily bulk report of the given type. First reports appear after ~1–2 days. Check reporting_list_jobs first to avoid duplicates. Only side effect of this connector; it changes nothing on the channel.',
    inputSchema: {
      type: 'object',
      properties: { reportTypeId: { type: 'string' }, name: { type: 'string' } },
      required: ['reportTypeId', 'name'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    run: async (a, { token }) => {
      const r = await googleSend(await token(), REPORTING + 'jobs', 'POST', { reportTypeId: a.reportTypeId, name: a.name });
      return r.status === 200 ? r.text : err(r);
    },
  },
  {
    name: 'reporting_list_reports',
    description: 'YouTube Reporting API: list generated reports for a job (each has a downloadUrl and the day it covers).',
    inputSchema: {
      type: 'object',
      properties: {
        jobId: { type: 'string' },
        createdAfter: { type: 'string', description: 'RFC3339' },
        startTimeAtOrAfter: { type: 'string', description: 'RFC3339' },
        startTimeBefore: { type: 'string', description: 'RFC3339' },
        pageToken: { type: 'string' },
      },
      required: ['jobId'],
      additionalProperties: false,
    },
    annotations: RO,
    run: async (a, { token }) => {
      const { jobId, ...rest } = a;
      const r = await googleGet(await token(), REPORTING + 'jobs/' + encodeURIComponent(jobId) + '/reports?' + qs({ pageSize: 100, ...rest }));
      return r.status === 200 ? cap(r.text) : err(r);
    },
  },
  {
    name: 'reporting_download',
    description: 'Download a Reporting API CSV by its downloadUrl. Returns header + selected rows. Use columns/contains/offset/limit to keep output small; totalRows tells you how much there is.',
    inputSchema: {
      type: 'object',
      properties: {
        downloadUrl: { type: 'string' },
        columns: { type: 'array', items: { type: 'string' }, description: 'Keep only these columns' },
        contains: { type: 'string', description: 'Keep only rows containing this text' },
        offset: { type: 'integer', default: 0 },
        limit: { type: 'integer', default: 500 },
      },
      required: ['downloadUrl'],
      additionalProperties: false,
    },
    annotations: RO,
    run: async (a, { token }) => {
      if (!String(a.downloadUrl).startsWith(REPORTING)) return 'ERROR downloadUrl must be a youtubereporting.googleapis.com URL';
      const r = await googleGet(await token(), a.downloadUrl);
      if (r.status !== 200) return err(r);
      const lines = r.text.split(/\r?\n/).filter(Boolean);
      const header = (lines.shift() ?? '').split(',');
      let rows = a.contains ? lines.filter((l) => l.includes(a.contains)) : lines;
      const total = rows.length;
      rows = rows.slice(a.offset ?? 0, (a.offset ?? 0) + (a.limit ?? 500));
      let cols = header;
      if (Array.isArray(a.columns) && a.columns.length) {
        const idx = a.columns.map((c: string) => header.indexOf(c)).filter((i: number) => i >= 0);
        cols = idx.map((i: number) => header[i]);
        rows = rows.map((l) => { const f = l.split(','); return idx.map((i: number) => f[i]).join(','); });
      }
      return cap(JSON.stringify({ totalRows: total, header: cols, rows }));
    },
  },
  {
    name: 'api_get',
    description: 'Escape hatch: GET any URL under https://www.googleapis.com/youtube/v3/, https://youtubeanalytics.googleapis.com/v2/ (incl. groups, groupItems) or https://youtubereporting.googleapis.com/v1/.',
    inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'], additionalProperties: false },
    annotations: RO,
    run: async (a, { token }) => {
      const url = String(a.url);
      if (!ALLOWED_PREFIXES.some((p) => url.startsWith(p))) return 'ERROR URL not allowed. Allowed prefixes: ' + ALLOWED_PREFIXES.join(', ');
      const r = await googleGet(await token(), url);
      return r.status === 200 ? cap(r.text) : err(r);
    },
  },
];

export async function callTool(name: string, args: Json, env: Env, props: Props) {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return { isError: true, content: [{ type: 'text', text: `Unknown tool: ${name}` }] };
  try {
    const text = await tool.run(args ?? {}, { env, props, token: () => accessToken(env, props) });
    const isError = text.startsWith('ERROR ');
    return { isError, content: [{ type: 'text', text }] };
  } catch (e: any) {
    return { isError: true, content: [{ type: 'text', text: 'ERROR ' + (e?.message ?? String(e)) }] };
  }
}

function qs(p: Json): string {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(p)) {
    if (v === undefined || v === null || v === '') continue;
    u.set(k, Array.isArray(v) ? v.join(',') : String(v));
  }
  return u.toString();
}

function err(r: { status: number; text: string }): string {
  let msg = r.text;
  try {
    const j = JSON.parse(r.text);
    msg = j.error?.message ?? msg;
  } catch {}
  return `ERROR ${r.status}: ${msg.slice(0, 2000)}`;
}

function cap(s: string): string {
  return s.length > MAX_TEXT ? s.slice(0, MAX_TEXT) + `\n…[truncated ${s.length - MAX_TEXT} chars — narrow the query]` : s;
}

function safeJson(s: string) {
  try { return JSON.parse(s); } catch { return s; }
}
