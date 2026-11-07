// Real PostgreSQL for state transitions; deterministic Docker/Caddy failures.
// The optional URL must name a dedicated *_audit database, never an install.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdtemp, readFile, readlink, rm, symlink, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import AdmZip from "adm-zip";
import { parseManifest } from "../src/manifest.ts";

const url = process.env.NANODEPLOY_TEST_DATABASE_URL;
const options = { skip: !url };
let work: string, store: typeof import("../src/db.ts"), releases: typeof import("../src/releases.ts");
const runtime = {
  containers: new Map<string, any>(), failStart: false, failStop: false, rejectRoute: false,
  routes: new Map<string, any>(), events: [] as { slug: string; kind: string; detail: any }[],
  images: new Set<string>(),
};
let counter = 0;
const slugs: string[] = [];
const users: string[] = [];
const databases: string[] = [];
let gate: typeof import("../../gate/src/db.ts") | undefined;
let api: typeof import("../src/index.ts").app | undefined;
const token = "audit-local-deploy-token-123456789";
const slug = () => { const s = `audit-${process.pid}-${++counter}`; slugs.push(s); return s; };

before(async () => {
  if (!url) return;
  assert.match(new URL(url).pathname, /_audit$/, "use an isolated *_audit database");
  work = await mkdtemp(join(tmpdir(), "nanodeploy-releases-"));
  process.env.POSTGRES_URL = url;
  process.env.APPS_DIR = work;
  process.env.ACCESS_LOG = join(work, "apps.log");
  process.env.APPS_DOMAIN = "apps.audit.invalid";
  process.env.DEPLOY_TOKEN = token;
  process.env.PUBLIC_SCHEME = "https";
  process.env.PUBLIC_PORT = "";
  process.env.GATE_DB_PASSWORD = "auditgatepasswordforisolatedtests";
  process.env.NANODEPLOY_SECRET_KEY = "11".repeat(32);
  (globalThis as any).__releaseAudit = runtime;
  store = await import("../src/db.ts");
  await store.sql.begin(async (lock) => {
    // Role DDL is cluster-wide: the gate HTTP fixture uses another database
    // in the same cluster, so both setups lock through the main audit database.
    await lock`select pg_advisory_xact_lock(18472, 99)`;
    await store.initState();
    await store.migrateState();
    await store.initGate();
  });
  const outfile = join(work, "releases.mjs");
  await build({
    entryPoints: [fileURLToPath(new URL("../src/releases.ts", import.meta.url))],
    outfile, bundle: true, platform: "node", format: "esm", target: "node20",
    banner: { js: "import {createRequire} from 'node:module'; const require = createRequire(import.meta.url);" },
    plugins: [{ name: "failure-injection", setup(b) {
      b.onResolve({ filter: /^\.\/db\.js$/ }, () => ({ path: new URL("../src/db.ts", import.meta.url).href, external: true }));
      b.onResolve({ filter: /^\.\/(docker|caddy|analytics)\.js$/ }, (args) => ({ path: args.path, namespace: "audit" }));
      b.onLoad({ filter: /.*/, namespace: "audit" }, ({ path }) => ({ contents: path.includes("docker") ? `
        const s = globalThis.__releaseAudit;
        export const imageTag = (slug, n) => 'nanodeploy/' + slug + ':r' + n;
        export const containerName = slug => 'app-' + slug;
        export async function buildImage(dir, tag) { s.images.add(tag); return tag; }
        export const imageExists = async tag => s.images.has(tag);
        export const appStatus = async slug => s.containers.has(slug) ? (s.containers.get(slug).running ? 'awake' : 'sleeping') : 'missing';
        export async function runContainer(opts) {
          s.containers.set(opts.slug, {...structuredClone(opts), running: true});
          if (s.failStart) { s.failStart = false; throw new Error('injected container start failure'); }
        }
        export const stopContainer = async slug => {
          if (s.failStop) { s.failStop = false; return; }
          const c = s.containers.get(slug); if(c) c.running = false;
        };
        export const startContainer = async slug => { const c = s.containers.get(slug); if(c) c.running = true; };
        export const removeContainer = async slug => { s.containers.delete(slug); };
        export const pruneImages = async () => {};
        export const dumpDatabase = async () => { throw new Error('unexpected database snapshot'); };
        export const restoreDatabase = async () => { throw new Error('unexpected database restore'); };
      ` : path.includes("caddy") ? `
        export async function applySite(app) {
          const s = globalThis.__releaseAudit;
          if(s.rejectRoute) { s.rejectRoute = false; return false; }
          s.routes.set(app.slug, structuredClone(app));
          return true;
        }
        export const dropSite = async slug => { globalThis.__releaseAudit.routes.delete(slug); return true; };
      ` : `
        export const quiet = () => {};
        export const recordEvent = async (slug, kind, detail) => { globalThis.__releaseAudit.events.push({ slug, kind, detail }); };
        export const markDeploy = async (slug, release, awake) => recordEvent(slug, 'deploy', { release, awake });
      ` }));
    } }],
  });
  releases = await import(pathToFileURL(outfile).href);
  await releases.init();
});

after(async () => {
  if (!url || !store) return;
  for (const s of slugs) {
    await store.sql`delete from releases where slug = ${s}`;
    await store.sql`delete from apps where slug = ${s}`;
    await store.sql`delete from deploy_keys where slug = ${s}`;
  }
  for (const id of users) await store.sql`delete from gate.users where id = ${id}`;
  for (const db of databases) {
    await store.sql.unsafe(`drop database if exists "${db}" with (force)`);
    await store.sql.unsafe(`drop role if exists "${db}"`);
  }
  if (gate) await gate.sql.end();
  await store.sql.end();
  if (work) await rm(work, { recursive: true, force: true });
  delete (globalThis as any).__releaseAudit;
});

async function stage(s: string, content = "version", backend = false, warm = true) {
  const yaml = `slug: ${s}\naccess: public\nenv: [API_KEY]\n${backend ? `backend: { entry: server.js }\nidle: { warm: ${warm} }\n` : ""}`;
  const zip = new AdmZip();
  zip.addFile("app.yaml", Buffer.from(yaml));
  zip.addFile("dist/index.html", Buffer.from(content));
  if (backend) zip.addFile("server.js", Buffer.from("console.log('ready')"));
  return releases.stage(parseManifest(yaml), zip.toBuffer(), { source: "upload", createdBy: "test" });
}

test("empty declared variables survive both deploy and rollback", options, async () => {
  const s = slug();
  const first = await stage(s);
  await releases.promote(first.id);
  await store.upsertApp({ slug: s, env: { API_KEY: "" } });
  const second = await stage(s, "second");
  assert.deepEqual((await releases.diff(second)).envToSet, []);
  await releases.promote(second.id);
  assert.deepEqual((await store.getApp(s)).env, { API_KEY: "" });
  await releases.rollback(s, first.id, false, "test");
  assert.deepEqual((await store.getApp(s)).env, { API_KEY: "" });
});

test("a rejected Caddy route restores the previous files and live release", options, async () => {
  const s = slug();
  const first = await stage(s, "first");
  await releases.promote(first.id);
  const second = await stage(s, "second");
  runtime.rejectRoute = true;
  await assert.rejects(releases.promote(second.id), /caddy/i);
  assert.equal(await readlink(join(work, s, "current")), `releases/${first.dir}`);
  assert.equal(await readFile(join(work, s, "current/dist/index.html"), "utf8"), "first");
  assert.equal((await releases.getRelease(first.id))?.status, "live");
  assert.equal((await releases.getRelease(second.id))?.status, "failed");
});

test("a container failure restores the old backend as well as its metadata", options, async () => {
  const s = slug();
  const first = await stage(s, "first", true);
  await releases.promote(first.id);
  const old = structuredClone(runtime.containers.get(s));
  const second = await stage(s, "second", true);
  runtime.failStart = true;
  await assert.rejects(releases.promote(second.id), /container start/);
  assert.deepEqual(runtime.containers.get(s), old);
  assert.equal((await store.getApp(s)).image, old.image);
  assert.equal((await releases.getRelease(first.id))?.status, "live");
});

test("a rejected archive does not discard the previous staged review", options, async () => {
  const s = slug();
  const candidate = await stage(s);
  await assert.rejects(releases.stage(candidate.manifest, Buffer.from("broken zip"), { source: "upload", createdBy: "test" }));
  assert.equal((await releases.getRelease(candidate.id))?.status, "staged");
  assert.equal(await readFile(join(work, s, "releases", String(candidate.dir), "dist/index.html"), "utf8"), "version");
});

test("startup recovers a release interrupted after its files and container changed", options, async () => {
  const s = slug();
  const first = await stage(s, "first", true);
  await releases.promote(first.id);
  const second = await stage(s, "second", true);
  await store.sql`update releases set status = 'building' where id = ${second.id}`;
  await symlink(`releases/${second.dir}`, join(work, s, "interrupted"));
  await rename(join(work, s, "interrupted"), join(work, s, "current"));
  runtime.containers.set(s, { image: "uncommitted" });
  await releases.init();
  assert.equal(await readlink(join(work, s, "current")), `releases/${first.dir}`);
  assert.equal((await releases.getRelease(second.id))?.status, "failed");
  assert.equal((await releases.getRelease(first.id))?.status, "live");
  assert.equal(runtime.containers.has(s), false, "reconcile must recreate the committed backend");
});

test("a failed rollback keeps both the current backend and the target's files", options, async () => {
  const s = slug();
  const first = await stage(s, "first", true);
  await releases.promote(first.id);
  const second = await stage(s, "second", true);
  await releases.promote(second.id);
  const old = structuredClone(runtime.containers.get(s));
  runtime.rejectRoute = true;
  await assert.rejects(releases.rollback(s, first.id, false, "test"), /caddy/i);
  assert.deepEqual(runtime.containers.get(s), old);
  assert.equal((await releases.getRelease(second.id))?.status, "live");
  assert.equal(await readlink(join(work, s, "current")), `releases/${second.dir}`);
  assert.equal(await readFile(join(work, s, "releases", String(first.dir), "dist/index.html"), "utf8"), "first");
});

test("discarding an interrupted rollback review never deletes shared version files", options, async () => {
  const s = slug();
  const first = await stage(s, "first");
  await releases.promote(first.id);
  const [pending] = await store.sql`insert into releases (slug, number, dir, source, manifest, status)
    values (${s}, 2, ${first.dir}, 'rollback', ${store.sql.json(first.manifest as any)}, 'staged') returning id`;
  assert.equal(await releases.discard(pending.id), true);
  assert.equal(await readFile(join(work, s, "current/dist/index.html"), "utf8"), "first");
});

test("a failed environment change recovers the previous container and values", options, async () => {
  const s = slug();
  const first = await stage(s, "first", true);
  await releases.promote(first.id);
  const current = await store.getApp(s);
  const old = structuredClone(runtime.containers.get(s));
  runtime.failStart = true;
  await assert.rejects(releases.replaceEnvironment(current, { API_KEY: "replacement" }), /container start/);
  assert.deepEqual(runtime.containers.get(s), old);
  assert.deepEqual((await store.getApp(s)).env, current.env);
});

test("availability follows the manifest until a dashboard choice is made", options, async () => {
  const s = slug();
  const first = await stage(s, "first", true, false);
  await releases.promote(first.id);
  assert.equal((await store.getApp(s)).warm_override, null);
  assert.equal(runtime.containers.get(s).running, false);
  const second = await stage(s, "second", true, true);
  assert.deepEqual((await releases.diff(second)).warm, { from: false, to: true });
  await releases.promote(second.id);
  assert.equal((await store.getApp(s)).warm, true);
  assert.equal(runtime.containers.get(s).running, true);
});

test("always on wakes an app and survives deployments and rollbacks of cold manifests", options, async () => {
  const s = slug();
  const first = await stage(s, "first", true, false);
  await releases.promote(first.id);
  const current = await store.getApp(s);
  await releases.replaceWarm(current, true);
  assert.deepEqual(await store.getApp(s), { ...current, warm: true, warm_override: true });
  assert.equal(runtime.containers.get(s).running, true);
  assert.equal(runtime.containers.get(s).warm, true);
  assert.equal(runtime.routes.get(s).warm, true);
  assert.deepEqual(runtime.events.at(-1), { slug: s, kind: "wake", detail: { source: "settings" } });
  const second = await stage(s, "second", true, false);
  assert.equal((await releases.diff(second)).warm, null);
  await releases.promote(second.id);
  assert.equal((await store.getApp(s)).warm, true);
  assert.equal(runtime.containers.get(s).running, true);
  assert.equal(runtime.events.at(-1)?.detail.awake, true);
  await releases.rollback(s, first.id, false, "test");
  assert.equal((await store.getApp(s)).warm_override, true);
  assert.equal(runtime.containers.get(s).warm, true);
  assert.equal(runtime.containers.get(s).running, true);
});

test("disabling always on sleeps immediately and survives warm manifests and rollback", options, async () => {
  const s = slug();
  const first = await stage(s, "first", true, true);
  await releases.promote(first.id);
  await releases.replaceWarm(await store.getApp(s), false);
  assert.equal((await store.getApp(s)).warm_override, false);
  assert.equal(runtime.containers.get(s).warm, false);
  assert.equal(runtime.containers.get(s).running, false);
  assert.equal(runtime.routes.get(s).warm, false);
  assert.deepEqual(runtime.events.at(-1), { slug: s, kind: "sleep", detail: { source: "settings" } });
  const second = await stage(s, "second", true, true);
  assert.equal((await releases.diff(second)).warm, null);
  await releases.promote(second.id);
  assert.equal((await store.getApp(s)).warm, false);
  assert.equal(runtime.events.at(-1)?.detail.awake, false);
  await releases.rollback(s, first.id, false, "test");
  assert.equal((await store.getApp(s)).warm_override, false);
  assert.equal(runtime.containers.get(s).running, false);
});

test("repeated availability requests pin the choice without restarting the backend", options, async () => {
  const s = slug();
  await releases.promote((await stage(s, "first", true, true)).id);
  const container = runtime.containers.get(s);
  await releases.replaceWarm(await store.getApp(s), true);
  await releases.replaceWarm(await store.getApp(s), true);
  assert.equal(runtime.containers.get(s), container);
  assert.equal((await store.getApp(s)).warm_override, true);
  await releases.promote((await stage(s, "second", true, false)).id);
  assert.equal(runtime.containers.get(s).warm, true);
});

test("a failed availability restart restores the previous backend and leaves no override", options, async () => {
  const s = slug();
  await releases.promote((await stage(s, "first", true, false)).id);
  const current = await store.getApp(s);
  const container = structuredClone(runtime.containers.get(s));
  runtime.failStart = true;
  await assert.rejects(releases.replaceWarm(current, true), /container start/);
  assert.deepEqual(await store.getApp(s), current);
  assert.deepEqual(runtime.containers.get(s), container);
  assert.equal(runtime.routes.get(s).warm, false);
});

test("a rejected availability route restores the warm backend and its previous route", options, async () => {
  const s = slug();
  await releases.promote((await stage(s, "first", true, true)).id);
  const current = await store.getApp(s);
  const container = structuredClone(runtime.containers.get(s));
  runtime.rejectRoute = true;
  await assert.rejects(releases.replaceWarm(current, false), /caddy/);
  assert.deepEqual(await store.getApp(s), current);
  assert.deepEqual(runtime.containers.get(s), container);
  assert.equal(runtime.routes.get(s).warm, true);
});

test("a silently failed stop cannot commit an unmanaged running app", options, async () => {
  const s = slug();
  await releases.promote((await stage(s, "first", true, true)).id);
  const current = await store.getApp(s);
  runtime.failStop = true;
  await assert.rejects(releases.replaceWarm(current, false), /put app to sleep/);
  assert.deepEqual(await store.getApp(s), current);
  assert.equal(runtime.containers.get(s).warm, true);
  assert.equal(runtime.containers.get(s).running, true);
});

async function person(role = "member") {
  const id = slug();
  users.push(id);
  await store.sql`insert into gate.users (id, username, display_name, role) values (${id}, ${id}, ${id}, ${role})`;
  return id;
}

test("concurrent administrator demotions cannot remove every administrator", options, async () => {
  const accounts = await import("../src/accounts.ts");
  assert.equal(await accounts.adminCount(), 0, "the audit database must not contain real accounts");
  const a = await person("admin"), b = await person("admin");
  const results = await Promise.allSettled([accounts.setAdmin(a, false), accounts.setAdmin(b, false)]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(await accounts.adminCount(), 1);
  const remaining = (await accounts.findById(a))?.isAdmin ? a : b;
  await assert.rejects(accounts.removePerson(remaining), /last administrator/);
  // A no-op demotion of a member remains legal with a single administrator.
  await accounts.setAdmin(remaining === a ? b : a, false);
});

test("concurrent passkey deletion keeps one sign-in credential", options, async () => {
  process.env.DATABASE_URL = url;
  gate ??= await import("../../gate/src/db.ts");
  const id = await person();
  const credentials: string[] = [];
  for (let i = 0; i < 2; i++) {
    const [c] = await store.sql`insert into gate.credentials (user_id, kind, webauthn_id) values (${id}, 'passkey', ${`${id}-${i}`}) returning id`;
    credentials.push(c.id);
  }
  const results = await Promise.all(credentials.map((c) => gate!.deletePasskey(id, c)));
  assert.deepEqual(results.sort(), ["deleted", "last"]);
  assert.equal(await gate.credentialCount(id), 1);
});

test("a token that expires after lookup cannot be consumed", options, async () => {
  process.env.DATABASE_URL = url;
  gate ??= await import("../../gate/src/db.ts");
  const { sha256 } = await import("../../gate/src/crypto.ts");
  const id = await person();
  const raw = `audit-token-${id}`, hash = sha256(raw);
  await store.sql`insert into gate.tokens (token_hash, user_id, purpose, expires_at) values (${hash}, ${id}, 'welcome', now() + interval '1 minute')`;
  assert.ok(await gate.findToken(raw));
  await store.sql`update gate.tokens set expires_at = now() - interval '1 second' where token_hash = ${hash}`;
  assert.equal(await gate.useToken(hash), false);
});

test("provisioning detects a retained database and keeps the configured server address", options, async () => {
  const s = slug();
  const first = await store.provisionDatabase(s);
  databases.push(first.user);
  assert.equal(first.existed, false);
  const second = await store.provisionDatabase(s);
  assert.equal(second.existed, true);
  const appUrl = new URL(store.databaseUrl(second.user, second.password));
  assert.equal(appUrl.host, new URL(url!).host);
  assert.equal(appUrl.pathname, "/" + second.user);
});

async function request(path: string, init: RequestInit = {}) {
  api ??= (await import("../src/index.ts")).app;
  return api.request(`https://deploy.apps.audit.invalid${path}`, init);
}
const tokenHeaders = { authorization: `Bearer ${token}`, "content-type": "application/json" };

test("HTTP endpoints refuse malformed JSON shapes with a JSON 400 response", options, async () => {
  const s = slug();
  await store.upsertApp({ slug: s, name: "HTTP fixture", declared_env: ["API_KEY", "DATABASE_URL", "PORT"] });
  for (const [path, body] of [
    ["/api/people", { username: 123 }], ["/api/people", { username: "alice", email: [] }],
    [`/api/apps/${s}/access`, { access: "groups", groups: {} }],
    [`/api/apps/${s}/access`, { access: "groups", groups: null }],
    [`/api/apps/${s}/env`, []], [`/api/apps/${s}/env`, { API_KEY: "bad\0value" }],
    [`/api/apps/${s}/env`, { DATABASE_URL: "external" }], [`/api/apps/${s}/env`, { PORT: "5000" }],
    [`/api/apps/${s}/warm`, {}], [`/api/apps/${s}/warm`, { warm: "true" }],
    [`/api/apps/${s}/warm`, { warm: null }], [`/api/apps/${s}/warm`, []],
  ] as const) {
    const res = await request(path, { method: "POST", headers: tokenHeaders, body: JSON.stringify(body) });
    assert.equal(res.status, 400, `${path}: ${JSON.stringify(body)}`);
    assert.equal(typeof (await res.json()).error, "string");
  }
  const malformed = await request(`/api/apps/${s}/env`, { method: "POST", headers: tokenHeaders, body: "{" });
  assert.equal(malformed.status, 400);
  const missing = await request("/api/people/no-such-account/groups", { method: "POST", headers: tokenHeaders, body: '{"groupIds":[]}' });
  assert.equal(missing.status, 404);
});

test("availability endpoints refuse static and unknown apps", options, async () => {
  const s = slug();
  await store.upsertApp({ slug: s, name: "Static fixture" });
  const mutate = (target: string, body = '{"warm":true}') => request(`/api/apps/${target}/warm`, {
    method: "POST", headers: tokenHeaders, body,
  });
  const staticApp = await mutate(s);
  assert.equal(staticApp.status, 400);
  assert.match((await staticApp.json()).error, /static apps/);
  assert.equal((await store.getApp(s)).warm_override, null);
  assert.equal((await mutate("unknown-availability-app")).status, 404);
  assert.equal((await mutate(s, "{")).status, 400);
});

test("HTTP body limits also cover chunked requests and reject oversized uploads before parsing", options, async () => {
  const oversized = await request("/api/deploy", { method: "POST", headers: { ...tokenHeaders, "content-length": String(102 * 1024 * 1024) }, body: "x" });
  assert.equal(oversized.status, 413);
  const chunks = new ReadableStream({ start(controller) {
    for (let i = 0; i < 3; i++) controller.enqueue(new Uint8Array(1024 * 1024));
    controller.close();
  } });
  const chunked = await request("/api/groups", { method: "POST", headers: tokenHeaders, body: chunks, duplex: "half" } as any);
  assert.equal(chunked.status, 413);
  const hook = await request("/hooks/github", { method: "POST", headers: { "content-type": "application/json" }, body: "x".repeat(2 * 1024 * 1024 + 1) });
  assert.equal(hook.status, 413);
});

test("forged identity headers and revoked deploy keys cannot fall back to browser authority", options, async () => {
  assert.equal((await request("/api/people", { headers: { "remote-sub": users[0] } })).status, 401);
  const s = slug();
  const key = await store.createDeployKey(s, "HTTP fixture");
  const auth = { authorization: `Bearer ${key.key}` };
  assert.equal((await request("/api/people", { headers: auth })).status, 403);
  assert.equal((await request(`/api/apps/${s}/warm`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: '{"warm":true}' })).status, 403);
  assert.equal((await request("/api/me", { headers: auth })).status, 200);
  await store.deleteDeployKey(s, key.id);
  assert.equal((await request("/api/me", { headers: { ...auth, "remote-sub": users[0] } })).status, 401);
});

test("browser mutations require the console origin and a valid recent host session", options, async () => {
  process.env.DATABASE_URL = url;
  gate ??= await import("../../gate/src/db.ts");
  const { sha256 } = await import("../../gate/src/crypto.ts");
  const [admin] = await store.sql`select id from gate.users where role = 'admin' limit 1`;
  const session = { userId: admin.id, authenticatedAt: new Date(), expiresAt: new Date(Date.now() + 3600_000), userAgent: "audit" };
  const root = await gate.createSession({ ...session, host: "auth.apps.audit.invalid", parent: null });
  const host = await gate.createSession({ ...session, host: "deploy.apps.audit.invalid", parent: sha256(root) });
  const headers = { cookie: `__Host-nd_s=${host}`, "remote-sub": admin.id, "content-type": "application/json" };
  assert.equal((await request("/api/people", { headers })).status, 200);
  for (const extra of [{}, { origin: "https://evil.invalid" }, { origin: "http://deploy.apps.audit.invalid" }, { "sec-fetch-site": "same-site" }]) {
    const res = await request("/api/groups", { method: "POST", headers: { ...headers, ...extra }, body: '{"name":"blocked"}' });
    assert.equal(res.status, 403, JSON.stringify(extra));
  }
  const wrongHost = await gate.createSession({ ...session, host: "some-app.apps.audit.invalid", parent: sha256(root) });
  assert.equal((await request("/api/people", { headers: { ...headers, cookie: `__Host-nd_s=${wrongHost}` } })).status, 401);
  await gate.endFamily(sha256(root));
  assert.equal((await request("/api/people", { headers })).status, 401);
});

test("concurrent deploy-key creation respects the twenty-key limit", options, async () => {
  const s = slug();
  for (let i = 0; i < 18; i++) await store.createDeployKey(s, `fixture ${i}`);
  const results = await Promise.all(Array.from({ length: 4 }, () => request(`/api/apps/${s}/keys`, {
    method: "POST", headers: tokenHeaders, body: '{"label":"concurrent"}',
  })));
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 200, 400, 400]);
  assert.equal((await store.listDeployKeys(s)).length, 20);
});

function accessLine(s: string, path = "/") {
  return JSON.stringify({ ts: Date.now() / 1000, status: 200, size: 100, duration: 0.002,
    request: { host: `${s}.apps.audit.invalid`, uri: path, method: "GET", client_ip: "192.0.2.10",
      headers: { "User-Agent": ["Audit browser"], Accept: ["text/html"] } }, resp_headers: { "Content-Type": ["text/html"] } });
}

test("analytics failures retain the complete batch without partial or duplicate writes", options, async () => {
  const analytics = await import("../src/analytics.ts");
  await analytics.init();
  const a = slug(), b = slug();
  await analytics.ingestLine(accessLine(a));
  await analytics.ingestLine(accessLine(b));
  await analytics.ingestLine(accessLine(b));
  await store.sql`alter table traffic_minute add constraint audit_flush_failure check (requests < 2) not valid`;
  try {
    await assert.rejects(analytics.flush(), /audit_flush_failure/);
    assert.equal((await store.sql`select 1 from traffic_minute where slug in (${a}, ${b})`).length, 0);
  } finally { await store.sql`alter table traffic_minute drop constraint audit_flush_failure`; }
  await analytics.flush();
  await analytics.flush();
  assert.deepEqual((await store.sql`select requests from traffic_minute where slug in (${a}, ${b}) order by slug`).map((r) => r.requests).sort(), [1, 2]);
  assert.equal((await store.sql`select count(*)::int as n from pageviews where slug in (${a}, ${b})`)[0].n, 3);
});

test("log reads preserve split UTF-8 characters and recover from truncation", options, async () => {
  const analytics = await import("../src/analytics.ts");
  const s = slug();
  const line = Buffer.from(accessLine(s, "/café") + "\n");
  const padding = 256 * 1024 - 1 - line.indexOf(Buffer.from("é"));
  await writeFile(process.env.ACCESS_LOG!, Buffer.concat([Buffer.alloc(padding, 10), line]));
  await Promise.all([analytics.readLog(), analytics.readLog()]);
  await analytics.flush();
  assert.deepEqual((await store.sql`select path from pageviews where slug = ${s}`).map((r) => r.path), ["/café"]);
  await writeFile(process.env.ACCESS_LOG!, accessLine(s, "/second") + "\n");
  await analytics.readLog();
  await analytics.readLog();
  await analytics.flush();
  assert.deepEqual((await store.sql`select path from pageviews where slug = ${s} order by path`).map((r) => r.path), ["/café", "/second"]);
});

test("deleting analytics also removes buffered visits and member activity", options, async () => {
  const analytics = await import("../src/analytics.ts");
  const s = slug();
  await analytics.ingestLine(accessLine(s));
  assert.equal(analytics.onlineNow(s), 1);
  await store.sql`insert into gate.member_activity (slug, user_id, day, first_seen, last_seen, requests)
    values (${s}, ${users[0]}, current_date, now(), now(), 1)`;
  await analytics.forgetApp(s);
  await analytics.flush();
  assert.equal(analytics.onlineNow(s), 0);
  for (const table of ["traffic_minute", "visitors_hour", "pageviews", "gate.member_activity"]) {
    assert.equal((await store.sql.unsafe(`select 1 from ${table} where slug = $1`, [s])).length, 0, table);
  }
});
