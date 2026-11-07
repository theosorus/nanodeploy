import { createHash, randomBytes } from "node:crypto";
import { open, stat } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import * as store from "./db.js";
import * as dk from "./docker.js";

// Analytics from what the machine already produces, no script in the apps and
// no extra service:
//  - caddy's access log: requests, page views, visitors, errors, latency;
//  - docker events: when an app wakes up, goes to sleep, crashes, runs out of
//    memory;
//  - a memory sample of each awake app every minute;
//  - gate's per-person activity (gate.member_activity), for apps that are not
//    public.
// Visitors are counted with a hash of (daily salt, app, address, user agent).
// The salt lives in memory and in the settings table for the current day only,
// then is replaced: a visitor can be counted within a day, never followed from
// one day to the next or from one app to another. Raw addresses and user agents
// are never written to the database.

const sql = store.sql;
const DOMAIN = (process.env.APPS_DOMAIN ?? "").toLowerCase();
const LOG_FILE = process.env.ACCESS_LOG ?? "/var/log/caddy/apps.log";
// days begin at midnight here, for "today" and for the salt
export const TZ = process.env.TIMEZONE || "UTC";

export async function init() {
  await sql`
    create table if not exists traffic_minute (
      slug text not null,
      minute timestamptz not null,
      requests int not null default 0,
      pages int not null default 0,
      api int not null default 0,
      s4xx int not null default 0,
      s5xx int not null default 0,
      bytes bigint not null default 0,
      dur_ms bigint not null default 0,
      hist int[] not null default '{0,0,0,0,0,0,0,0,0}',
      primary key (slug, minute)
    )`;
  await sql`
    create table if not exists visitors_hour (
      slug text not null,
      hour timestamptz not null,
      visitor bytea not null,
      primary key (slug, hour, visitor)
    )`;
  await sql`
    create table if not exists pageviews (
      at timestamptz not null,
      slug text not null,
      visitor bytea not null,
      path text not null,
      referrer text,
      country text,
      device text,
      browser text
    )`;
  await sql`create index if not exists pageviews_slug_at on pageviews (slug, at)`;
  await sql`
    create table if not exists app_events (
      id bigserial primary key,
      at timestamptz not null,
      slug text not null,
      kind text not null,
      detail jsonb
    )`;
  await sql`create index if not exists app_events_slug_at on app_events (slug, at)`;
  await sql`
    create table if not exists resource_samples (
      at timestamptz not null,
      slug text,
      mem bigint not null
    )`;
  await sql`create index if not exists resource_samples_at on resource_samples (at)`;
}

/* ---------- day, salt, visitor ---------- */

const dayOf = (ms: number) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date(ms));

let salt: { day: string; value: Buffer } | null = null;
async function saltFor(day: string): Promise<Buffer> {
  if (salt?.day === day) return salt.value;
  const saved = await store.getSetting("analytics.salt");
  const [savedDay, savedValue] = (saved ?? "").split(":");
  if (savedDay === day && savedValue) {
    salt = { day, value: Buffer.from(savedValue, "hex") };
  } else {
    // a new day: the old salt is overwritten, and with it any way to link
    // today's visitors to yesterday's
    salt = { day, value: randomBytes(32) };
    await store.setSetting("analytics.salt", `${day}:${salt.value.toString("hex")}`);
  }
  return salt.value;
}

const visitorOf = (s: Buffer, slug: string, ip: string, ua: string) =>
  createHash("sha256").update(s).update(slug).update("\0").update(ip).update("\0").update(ua).digest().subarray(0, 16);

/* ---------- reading caddy's access log ---------- */

type Agg = {
  requests: number;
  pages: number;
  api: number;
  s4xx: number;
  s5xx: number;
  bytes: number;
  durMs: number;
  hist: number[];
};
// latency buckets, in ms: <=10, 25, 50, 100, 250, 500, 1000, 2500, more
export const BUCKETS = [10, 25, 50, 100, 250, 500, 1000, 2500, Infinity];

const minutes = new Map<string, Agg>();
const visitorsHour = new Map<string, Set<string>>();
let views: { at: Date; slug: string; visitor: Buffer; path: string; referrer: string | null; country: string | null; device: string; browser: string }[] = [];
// who was seen in the last minutes, for "online now"
const recent = new Map<string, Map<string, number>>();
// wakes waiting for their first real answer, to measure the cold start. A list:
// two wakes can happen before the log lines of the first one are read.
const pendingWake = new Map<string, { id: string; at: number }[]>();

const BOT_RE = /bot|crawl|spider|slurp|curl|wget|python-|httpclient|headless|monitor|uptime|preview|go-http|java\//i;
const ASSET_RE = /\.(js|css|map|png|jpe?g|gif|svg|ico|webp|avif|woff2?|ttf|txt|json|xml|webmanifest)$/i;

const header = (h: Record<string, string[]> | undefined, name: string) => h?.[name]?.[0] ?? "";

function device(ua: string) {
  if (/ipad|tablet/i.test(ua)) return "tablet";
  if (/mobi|iphone|android/i.test(ua)) return "mobile";
  return "desktop";
}

function browser(ua: string) {
  if (/firefox\//i.test(ua)) return "Firefox";
  if (/edg\//i.test(ua)) return "Edge";
  if (/opr\/|opera/i.test(ua)) return "Opera";
  if (/chrome\/|crios\//i.test(ua)) return "Chrome";
  if (/safari\//i.test(ua)) return "Safari";
  return "other";
}

// The app a host belongs to, or null for the console, the sign-in host and
// anything that is not ours.
function slugOfHost(host: string): string | null {
  const h = host.toLowerCase().replace(/:\d+$/, "");
  if (!h.endsWith(`.${DOMAIN}`)) return null;
  const label = h.slice(0, -DOMAIN.length - 1);
  if (!/^[a-z][a-z0-9-]{1,62}$/.test(label) || ["deploy", "auth", "id", "www"].includes(label)) return null;
  return label;
}

export async function ingestLine(line: string) {
  let e: any;
  try {
    e = JSON.parse(line);
  } catch {
    return;
  }
  const req = e.request;
  if (!req?.host || typeof e.ts !== "number") return;
  const slug = slugOfHost(req.host);
  if (!slug) return;
  const at = Math.round(e.ts * 1000);
  const [path, query = ""] = String(req.uri ?? "/").split("?");
  const beacon = path === "/_nd/e";
  if (path.startsWith("/_nd/") && !beacon) return; // sign-in plumbing, not traffic
  const status = Number(e.status ?? 0);
  const ua = header(req.headers, "User-Agent");
  const bot = BOT_RE.test(ua) || !ua;
  const api = path.startsWith("/api/");
  const type = header(e.resp_headers, "Content-Type");
  // sablier's "waking up" page answers an API call with HTML: not the app's answer
  const waiting = api && type.includes("text/html");

  const minute = new Date(Math.floor(at / 60000) * 60000).toISOString();
  const key = `${slug}\0${minute}`;
  const agg = minutes.get(key) ?? { requests: 0, pages: 0, api: 0, s4xx: 0, s5xx: 0, bytes: 0, durMs: 0, hist: BUCKETS.map(() => 0) };
  minutes.set(key, agg);
  if (!beacon) {
    const ms = Number(e.duration ?? 0) * 1000;
    agg.requests++;
    agg.bytes += Number(e.size ?? 0);
    agg.durMs += Math.round(ms);
    agg.hist[BUCKETS.findIndex((b) => ms <= b)]++;
    if (api && !waiting) agg.api++;
    if (status >= 500) agg.s5xx++;
    else if (status >= 400) agg.s4xx++;
  }

  if (api && !waiting && status < 500) {
    const wakes = pendingWake.get(slug) ?? [];
    // the latest wake before this answer is the one it answers
    let i = -1;
    for (let k = 0; k < wakes.length; k++) if (wakes[k].at <= at) i = k;
    if (i >= 0) {
      const wake = wakes[i];
      wakes.splice(0, i + 1);
      const ms = at - wake.at;
      if (ms < 120_000) {
        await sql`update app_events set detail = ${sql.json({ coldStartMs: ms })} where id = ${wake.id}`.catch(() => {});
      }
    }
  }

  if (bot) return;
  const ip = req.client_ip || req.remote_ip || "";
  const visitor = visitorOf(await saltFor(dayOf(at)), slug, ip, ua);
  const vhex = visitor.toString("hex");
  const hour = new Date(Math.floor(at / 3_600_000) * 3_600_000).toISOString();
  const vkey = `${slug}\0${hour}`;
  if (!visitorsHour.has(vkey)) visitorsHour.set(vkey, new Set());
  visitorsHour.get(vkey)!.add(vhex);
  if (!recent.has(slug)) recent.set(slug, new Map());
  recent.get(slug)!.set(vhex, at);

  let pagePath: string | null = null;
  if (beacon) {
    const p = new URLSearchParams(query).get("p") ?? "";
    if (p.startsWith("/")) pagePath = p;
  } else if (
    req.method === "GET" && !api && status < 400 && !ASSET_RE.test(path) && header(req.headers, "Accept").includes("text/html")
  ) {
    pagePath = path;
  }
  if (pagePath !== null) {
    agg.pages++;
    let referrer: string | null = null;
    try {
      const r = new URL(header(req.headers, "Referer"));
      if (r.hostname.toLowerCase() !== req.host.toLowerCase().replace(/:\d+$/, "")) referrer = r.hostname.toLowerCase();
    } catch {
      // no referrer, or not a URL
    }
    const country = header(req.headers, "Cf-Ipcountry").toUpperCase();
    views.push({
      at: new Date(at),
      slug,
      visitor,
      path: pagePath.slice(0, 200),
      referrer: referrer?.slice(0, 120) ?? null,
      country: /^[A-Z]{2}$/.test(country) && country !== "XX" ? country : null,
      device: device(ua),
      browser: browser(ua),
    });
  }
}

// Follows the log by file handle: when caddy rolls it (renames it and opens a
// new one), the old handle still reads what was written before the roll, then
// the new file is opened from its start. The position survives restarts.
let tail: { fh: FileHandle; ino: number; offset: number; rest: Buffer } | null = null;

let work: Promise<unknown> = Promise.resolve();
let scheduled = false;
function exclusive<T>(fn: () => Promise<T>) {
  const next = work.then(fn);
  work = next.catch(() => {});
  return next;
}
function schedule(fn: () => Promise<void>) {
  if (scheduled) return Promise.resolve();
  scheduled = true;
  return exclusive(fn).finally(() => { scheduled = false; });
}

export const readLog = () => schedule(readLogOnce);
export const flush = () => schedule(flushOnce);

async function readLogOnce() {
  if (!tail) {
    const s = await stat(LOG_FILE).catch(() => null);
    if (!s) return;
    const saved = (await store.getSetting("analytics.log")) ?? "";
    const [ino, offset] = saved.split(":").map(Number);
    tail = { fh: await open(LOG_FILE, "r"), ino: s.ino, offset: ino === s.ino && offset <= s.size ? offset : 0, rest: Buffer.alloc(0) };
  }
  for (;;) {
    const buf = Buffer.alloc(256 * 1024);
    const { bytesRead } = await tail.fh.read(buf, 0, buf.length, tail.offset);
    if (bytesRead === 0) break;
    tail.offset += bytesRead;
    // Decode only complete lines: a UTF-8 character may span two read buffers.
    const text = Buffer.concat([tail.rest, buf.subarray(0, bytesRead)]);
    let start = 0, end: number;
    while ((end = text.indexOf(10, start)) >= 0) {
      if (end > start) await ingestLine(text.subarray(start, end).toString("utf8"));
      start = end + 1;
    }
    tail.rest = Buffer.from(text.subarray(start));
  }
  const s = await stat(LOG_FILE).catch(() => null);
  if (s && s.ino !== tail.ino) {
    await tail.fh.close();
    tail = { fh: await open(LOG_FILE, "r"), ino: s.ino, offset: 0, rest: Buffer.alloc(0) };
  } else if (s && s.size < tail.offset) {
    tail.offset = 0;
    tail.rest = Buffer.alloc(0);
  }
}

async function flushOnce() {
  const batch = [...minutes.entries()];
  minutes.clear();
  const vbatch = [...visitorsHour.entries()];
  visitorsHour.clear();
  const pv = views;
  views = [];
  const position = tail ? `${tail.ino}:${tail.offset - tail.rest.length}` : null;
  // A dashboard need not be open for expired visitors to leave memory.
  const cutoff = Date.now() - 5 * 60_000;
  for (const [slug, seen] of recent) {
    for (const [visitor, at] of seen) if (at < cutoff) seen.delete(visitor);
    if (!seen.size) recent.delete(slug);
  }
  try {
    await sql.begin(async (tx) => {
      for (const [key, a] of batch) {
        const [slug, minute] = key.split("\0");
        await tx`
          insert into traffic_minute (slug, minute, requests, pages, api, s4xx, s5xx, bytes, dur_ms, hist)
          values (${slug}, ${minute}, ${a.requests}, ${a.pages}, ${a.api}, ${a.s4xx}, ${a.s5xx}, ${a.bytes}, ${a.durMs}, ${a.hist})
          on conflict (slug, minute) do update set
            requests = traffic_minute.requests + excluded.requests,
            pages = traffic_minute.pages + excluded.pages,
            api = traffic_minute.api + excluded.api,
            s4xx = traffic_minute.s4xx + excluded.s4xx,
            s5xx = traffic_minute.s5xx + excluded.s5xx,
            bytes = traffic_minute.bytes + excluded.bytes,
            dur_ms = traffic_minute.dur_ms + excluded.dur_ms,
            hist = array(select a + b from unnest(traffic_minute.hist, excluded.hist) as t(a, b))`;
      }
      const visitorRows: { slug: string; hour: string; visitor: Buffer }[] = [];
      for (const [key, set] of vbatch) {
        const [slug, hour] = key.split("\0");
        for (const v of set) visitorRows.push({ slug, hour, visitor: Buffer.from(v, "hex") });
      }
      for (let i = 0; i < visitorRows.length; i += 500) {
        await tx`insert into visitors_hour ${tx(visitorRows.slice(i, i + 500))} on conflict do nothing`;
      }
      for (let i = 0; i < pv.length; i += 500) await tx`insert into pageviews ${tx(pv.slice(i, i + 500))}`;
      if (position) await tx`insert into settings (key, value) values ('analytics.log', ${position})
        on conflict (key) do update set value = excluded.value`;
    });
  } catch (err) {
    // Retain the entire batch on failure. The transaction also rolls back its
    // cursor, so a partial write cannot lose or double-count the other rows.
    for (const [key, a] of batch) {
      const newer = minutes.get(key);
      if (!newer) minutes.set(key, a);
      else {
        for (const field of ["requests", "pages", "api", "s4xx", "s5xx", "bytes", "durMs"] as const) newer[field] += a[field];
        for (let i = 0; i < a.hist.length; i++) newer.hist[i] += a.hist[i];
      }
    }
    for (const [key, set] of vbatch) {
      if (!visitorsHour.has(key)) visitorsHour.set(key, set);
      else for (const visitor of set) visitorsHour.get(key)!.add(visitor);
    }
    views = [...pv, ...views];
    throw err;
  }
}

/* ---------- containers: awake, asleep, crashed ---------- */

// Deploys, rollbacks and env changes recreate containers on purpose: those
// starts and stops are not visits, so they are left out for a few seconds.
const quietUntil = new Map<string, number>();
export function quiet(slug: string, ms = 20_000) {
  quietUntil.set(slug, Date.now() + ms);
}

export async function recordEvent(slug: string, kind: string, detail?: object, at = Date.now()) {
  const [row] = await sql<{ id: string }[]>`
    insert into app_events (at, slug, kind, detail) values (${new Date(at)}, ${slug}, ${kind}, ${detail ? sql.json(detail as any) : null})
    returning id`;
  return row.id;
}

// a deploy leaves a warm app awake and a cold one asleep: the timeline needs to
// know which, since the container events around it are muted
export async function markDeploy(slug: string, release: number, awake: boolean) {
  quiet(slug);
  await recordEvent(slug, "deploy", { release, awake }).catch(() => {});
}

const stopping = new Map<string, number>();
const oomAt = new Map<string, number>();

async function onContainerEvent(e: dk.AppEvent) {
  if ((quietUntil.get(e.slug) ?? 0) > e.at) return;
  switch (e.action) {
    case "start": {
      const id = await recordEvent(e.slug, "wake", undefined, e.at);
      const list = pendingWake.get(e.slug) ?? [];
      list.push({ id, at: e.at });
      pendingWake.set(e.slug, list.slice(-5));
      break;
    }
    case "stop":
    case "kill":
      stopping.set(e.slug, e.at);
      break;
    case "oom":
      oomAt.set(e.slug, e.at);
      await recordEvent(e.slug, "oom", undefined, e.at);
      break;
    case "die": {
      const asked = e.at - (stopping.get(e.slug) ?? 0) < 30_000;
      const oom = e.at - (oomAt.get(e.slug) ?? 0) < 30_000;
      // consumed: a crash right after a requested stop is still a crash
      stopping.delete(e.slug);
      oomAt.delete(e.slug);
      await recordEvent(e.slug, asked && !oom ? "sleep" : "crash", { exitCode: e.exitCode }, e.at);
      break;
    }
  }
}

async function sample() {
  const apps = await store.listApps();
  const now = new Date();
  for (const a of apps) {
    if (!a.port) continue;
    if ((await dk.appStatus(a.slug)) !== "awake") continue;
    const mem = await dk.appMemory(a.slug);
    if (mem !== null) await sql`insert into resource_samples (at, slug, mem) values (${now}, ${a.slug}, ${mem})`;
  }
  const host = await dk.hostMemory();
  if (host.used) await sql`insert into resource_samples (at, slug, mem) values (${now}, ${null}, ${host.used})`;
}

async function sweep() {
  await sql`delete from traffic_minute where minute < now() - interval '400 days'`;
  await sql`delete from visitors_hour where hour < now() - interval '400 days'`;
  await sql`delete from pageviews where at < now() - interval '90 days'`;
  await sql`delete from app_events where at < now() - interval '400 days'`;
  await sql`delete from resource_samples where at < now() - interval '7 days'`;
  await sql`delete from gate.member_activity where day < now() - interval '400 days'`;
}

export function start() {
  const every = (ms: number, fn: () => Promise<unknown>, name: string) =>
    setInterval(() => fn().catch((err) => console.error(`analytics ${name} failed`, err)), ms).unref();
  every(2_000, readLog, "log");
  every(15_000, flush, "flush");
  every(60_000, sample, "sample");
  every(6 * 3_600_000, sweep, "sweep");
  dk.followAppEvents((e) => void onContainerEvent(e).catch((err) => console.error("analytics event failed", err)));
}

export const forgetApp = (slug: string) => exclusive(async () => {
  for (const key of minutes.keys()) if (key.startsWith(slug + "\0")) minutes.delete(key);
  for (const key of visitorsHour.keys()) if (key.startsWith(slug + "\0")) visitorsHour.delete(key);
  views = views.filter((v) => v.slug !== slug);
  for (const map of [recent, pendingWake, quietUntil, stopping, oomAt]) map.delete(slug);
  for (const table of ["traffic_minute", "visitors_hour", "pageviews", "app_events", "resource_samples"]) {
    await sql.unsafe(`delete from ${table} where slug = $1`, [slug]);
  }
  await sql`delete from gate.member_activity where slug = ${slug}`;
});

/* ---------- reading it back ---------- */

export function onlineNow(slug: string) {
  const seen = recent.get(slug);
  if (!seen) return 0;
  const cutoff = Date.now() - 5 * 60_000;
  let n = 0;
  for (const [v, at] of seen) {
    if (at >= cutoff) n++;
    else seen.delete(v);
  }
  return n;
}

function percentile(hist: number[], p: number) {
  const total = hist.reduce((a, b) => a + b, 0);
  if (!total) return null;
  let acc = 0;
  for (let i = 0; i < hist.length; i++) {
    acc += hist[i];
    if (acc >= total * p) return BUCKETS[i] === Infinity ? 5000 : BUCKETS[i];
  }
  return null;
}

const quantile = (values: number[], p: number) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
};

// The awake periods of an app over a range, from its events. A warm app is
// awake unless it crashed; a cold one between a wake and the next sleep.
type Interval = { from: number; to: number };
async function awakeIntervals(slug: string, from: number, to: number, warm: boolean): Promise<Interval[]> {
  const [before] = await sql<{ kind: string; detail: any }[]>`
    select kind, detail from app_events where slug = ${slug} and at < ${new Date(from)} order by at desc limit 1`;
  const events = await sql<{ at: Date; kind: string; detail: any }[]>`
    select at, kind, detail from app_events where slug = ${slug} and at >= ${new Date(from)} and at < ${new Date(to)} order by at`;
  const awakeAfter = (kind: string, detail: any) =>
    kind === "wake" ? true : kind === "deploy" ? Boolean(detail?.awake) : kind === "sleep" || kind === "crash" ? false : null;
  // No event before the range: an app created inside the range did not exist
  // yet (its first deploy event turns it on); an older warm app, deployed
  // before analytics existed, was running.
  const [{ born }] = await sql<{ born: Date | null }[]>`
    select coalesce((select min(created_at) from releases where slug = ${slug}),
                    (select deployed_at from apps where slug = ${slug})) as born`;
  const bornInside = born ? new Date(born).getTime() > from : false;
  let awake = before ? awakeAfter(before.kind, before.detail) ?? warm : warm && !bornInside;
  let since = from;
  const out: Interval[] = [];
  for (const e of events) {
    const next = awakeAfter(e.kind, e.detail);
    if (next === null) continue;
    const t = new Date(e.at).getTime();
    if (awake && !next) out.push({ from: since, to: t });
    if (!awake && next) since = t;
    awake = next;
  }
  if (awake) out.push({ from: since, to });
  return out;
}

const startOfToday = () =>
  sql<{ t: Date }[]>`select date_trunc('day', now() at time zone ${TZ}) at time zone ${TZ} as t`.then((r) => new Date(r[0].t).getTime());

export async function overview() {
  const apps = await store.listApps();
  const today = await startOfToday();
  const now = Date.now();
  const weekAgo = today - 6 * 86_400_000;
  const traffic = await sql<{ slug: string; requests: number; pages: number; s5xx: number }[]>`
    select slug, sum(requests)::int as requests, sum(pages)::int as pages, sum(s5xx)::int as s5xx
    from traffic_minute where minute >= ${new Date(today)} group by slug`;
  const daily = await sql<{ slug: string; day: string; visitors: number }[]>`
    select slug, to_char(hour at time zone ${TZ}, 'YYYY-MM-DD') as day, count(distinct visitor)::int as visitors
    from visitors_hour where hour >= ${new Date(weekAgo)} group by 1, 2`;
  const wakes = await sql<{ slug: string; n: number }[]>`
    select slug, count(*)::int as n from app_events where kind = 'wake' and at >= ${new Date(today)} group by slug`;
  const days = Array.from({ length: 7 }, (_, i) => dayOf(weekAgo + i * 86_400_000 + 43_200_000));
  const rows = [];
  for (const a of apps) {
    const t = traffic.find((x) => x.slug === a.slug);
    const awake = a.port ? await awakeIntervals(a.slug, today, now, a.warm) : [];
    const awakeMs = awake.reduce((sum, i) => sum + (i.to - i.from), 0);
    rows.push({
      slug: a.slug,
      name: a.name,
      access: a.access,
      online: onlineNow(a.slug),
      visitorsToday: daily.find((d) => d.slug === a.slug && d.day === dayOf(now))?.visitors ?? 0,
      pagesToday: t?.pages ?? 0,
      requestsToday: t?.requests ?? 0,
      errorsToday: t?.s5xx ?? 0,
      week: days.map((day) => daily.find((d) => d.slug === a.slug && d.day === day)?.visitors ?? 0),
      wakesToday: wakes.find((w) => w.slug === a.slug)?.n ?? 0,
      awakeShare: a.port ? awakeMs / Math.max(1, now - today) : null,
    });
  }
  return { timezone: TZ, apps: rows };
}

export async function appDetail(slug: string, range: "24h" | "7d" | "30d") {
  const app = await store.getApp(slug);
  if (!app) return null;
  const now = Date.now();
  const span = { "24h": 86_400_000, "7d": 7 * 86_400_000, "30d": 30 * 86_400_000 }[range];
  const from = now - span;
  const unit = range === "30d" ? "day" : "hour";
  const fromD = new Date(from);

  const series = await sql<{ t: Date; requests: number; pages: number; s5xx: number }[]>`
    select date_trunc(${unit}, minute at time zone ${TZ}) at time zone ${TZ} as t,
      sum(requests)::int as requests, sum(pages)::int as pages, sum(s5xx)::int as s5xx
    from traffic_minute where slug = ${slug} and minute >= ${fromD} group by 1 order by 1`;
  const visitors = await sql<{ t: Date; visitors: number }[]>`
    select date_trunc(${unit}, hour at time zone ${TZ}) at time zone ${TZ} as t, count(distinct visitor)::int as visitors
    from visitors_hour where slug = ${slug} and hour >= ${fromD} group by 1 order by 1`;
  const totals = await sql<{ requests: number; pages: number; s4xx: number; s5xx: number }[]>`
    select coalesce(sum(requests), 0)::int as requests, coalesce(sum(pages), 0)::int as pages,
      coalesce(sum(s4xx), 0)::int as s4xx, coalesce(sum(s5xx), 0)::int as s5xx
    from traffic_minute where slug = ${slug} and minute >= ${fromD}`;
  const histRows = await sql<{ i: number; n: number }[]>`
    select i, sum(hist[i])::int as n from traffic_minute, generate_subscripts(hist, 1) as i
    where slug = ${slug} and minute >= ${fromD} group by i order by i`;
  const hist = BUCKETS.map((_, k) => histRows.find((r) => r.i === k + 1)?.n ?? 0);
  // visitors over the range: distinct within a day, summed over days, since a
  // visitor cannot be recognised from one day to the next
  const [{ visitors: totalVisitors }] = await sql<{ visitors: number }[]>`
    select coalesce(sum(n), 0)::int as visitors from (
      select count(distinct visitor) as n from visitors_hour where slug = ${slug} and hour >= ${fromD}
      group by date_trunc('day', hour at time zone ${TZ})) d`;
  const top = (col: "path" | "referrer" | "country" | "device" | "browser") =>
    sql.unsafe<{ key: string; n: number }[]>(
      `select ${col} as key, count(*)::int as n from pageviews where slug = $1 and at >= $2 and ${col} is not null
       group by 1 order by 2 desc limit 10`,
      [slug, fromD],
    );
  const [pages, referrers, countries, devices, browsers] = await Promise.all([
    top("path"), top("referrer"), top("country"), top("device"), top("browser"),
  ]);

  // the timeline covers at most a week: past that, bands get thinner than a pixel
  const tlFrom = Math.max(from, now - 7 * 86_400_000);
  const intervals = app.port ? await awakeIntervals(slug, tlFrom, now, app.warm) : [];
  const markers = await sql<{ at: Date; kind: string; detail: any }[]>`
    select at, kind, detail from app_events where slug = ${slug} and at >= ${new Date(tlFrom)}
      and kind in ('crash', 'oom', 'deploy') order by at`;
  const colds = await sql<{ ms: number }[]>`
    select (detail->>'coldStartMs')::int as ms from app_events
    where slug = ${slug} and kind = 'wake' and at >= ${fromD} and detail ? 'coldStartMs'`;
  const [{ wakes }] = await sql<{ wakes: number }[]>`
    select count(*)::int as wakes from app_events where slug = ${slug} and kind = 'wake' and at >= ${fromD}`;
  const memory = await sql<{ t: Date; mem: number }[]>`
    select date_trunc('hour', at) as t, avg(mem)::bigint as mem from resource_samples
    where slug = ${slug} and at >= ${new Date(Math.max(from, now - 7 * 86_400_000))} group by 1 order by 1`;
  // people: only for apps that are not public, where every visitor is someone
  // the owner invited and the sign-in page says the admin can see this
  const people =
    app.access === "public"
      ? null
      : await sql<{ name: string; username: string; last_seen: Date; days: number; requests: number }[]>`
          select u.display_name as name, u.username, max(m.last_seen) as last_seen,
            count(distinct m.day)::int as days, sum(m.requests)::int as requests
          from gate.member_activity m join gate.users u on u.id = m.user_id
          where m.slug = ${slug} and m.day >= (${fromD} at time zone ${TZ})::date
          group by u.id order by max(m.last_seen) desc limit 50`;

  const t = totals[0];
  const awakeMs = intervals.reduce((s, i) => s + (i.to - i.from), 0);
  return {
    slug,
    name: app.name,
    range,
    unit,
    timezone: TZ,
    online: onlineNow(slug),
    totals: {
      visitors: totalVisitors,
      pages: t.pages,
      requests: t.requests,
      errors: t.s5xx,
      clientErrors: t.s4xx,
      p50: percentile(hist, 0.5),
      p95: percentile(hist, 0.95),
      wakes,
      coldStartMedian: quantile(colds.map((c) => c.ms), 0.5),
      coldStartP95: quantile(colds.map((c) => c.ms), 0.95),
      awakeShare: app.port ? awakeMs / Math.max(1, now - tlFrom) : null,
    },
    series: series.map((s) => ({
      t: s.t,
      requests: s.requests,
      pages: s.pages,
      errors: s.s5xx,
      visitors: visitors.find((v) => new Date(v.t).getTime() === new Date(s.t).getTime())?.visitors ?? 0,
    })),
    timeline: { from: tlFrom, to: now, awake: intervals, markers: markers.map((m) => ({ at: m.at, kind: m.kind, detail: m.detail })) },
    memory: memory.map((m) => ({ t: m.t, mem: Number(m.mem) })),
    limit: 256 * 1024 * 1024,
    top: { pages, referrers, countries, devices, browsers },
    people,
  };
}
