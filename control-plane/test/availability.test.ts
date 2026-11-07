// Runtime settings use real PostgreSQL and deterministic Docker/Caddy failures.
// The optional URL must name an isolated *_audit database, never an install.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
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
const slug = () => { const s = `availability-${process.pid}-${++counter}`; slugs.push(s); return s; };

before(async () => {
  work = await mkdtemp(join(tmpdir(), "nanodeploy-availability-"));
  process.env.APPS_DOMAIN = "apps.audit.invalid";
  process.env.APPS_DIR = work;
  if (!url) return;
  assert.match(new URL(url).pathname, /_audit$/, "use an isolated *_audit database");
  process.env.POSTGRES_URL = url;
  process.env.NANODEPLOY_SECRET_KEY = "11".repeat(32);
  (globalThis as any).__availabilityAudit = runtime;
  store = await import("../src/db.ts");
  await store.sql.begin(async (lock) => {
    await lock`select pg_advisory_xact_lock(18472, 99)`;
    await store.initState();
    await store.migrateState();
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
        const s = globalThis.__availabilityAudit;
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
          const s = globalThis.__availabilityAudit;
          if(s.rejectRoute) { s.rejectRoute = false; return false; }
          s.routes.set(app.slug, structuredClone(app));
          return true;
        }
        export const dropSite = async slug => { globalThis.__availabilityAudit.routes.delete(slug); return true; };
      ` : `
        export const quiet = () => {};
        export const recordEvent = async (slug, kind, detail) => { globalThis.__availabilityAudit.events.push({ slug, kind, detail }); };
        export const markDeploy = async (slug, release, awake) => recordEvent(slug, 'deploy', { release, awake });
      ` }));
    } }],
  });
  releases = await import(pathToFileURL(outfile).href);
  await releases.init();
});

after(async () => {
  if (store) {
    for (const s of slugs) {
      await store.sql`delete from releases where slug = ${s}`;
      await store.sql`delete from apps where slug = ${s}`;
    }
    await store.sql.end();
  }
  if (work) await rm(work, { recursive: true, force: true });
  delete (globalThis as any).__availabilityAudit;
});

async function stage(s: string, content = "version", backend = false, warm = true) {
  const yaml = `slug: ${s}\naccess: public\nenv: [API_KEY]\n${backend ? `backend: { entry: server.js }\nidle: { warm: ${warm} }\n` : ""}`;
  const zip = new AdmZip();
  zip.addFile("app.yaml", Buffer.from(yaml));
  zip.addFile("dist/index.html", Buffer.from(content));
  if (backend) zip.addFile("server.js", Buffer.from("console.log('ready')"));
  return releases.stage(parseManifest(yaml), zip.toBuffer(), { source: "upload", createdBy: "test" });
}

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

test("always-on backends bypass Sablier and keep their authentication route", async () => {
  const { renderSite } = await import("../src/caddy.ts");
  const backend = { slug: "availability", name: "Availability", access: "private", port: 3000,
    groups: [], warm: false, idle_timeout: "10m", env: {}, roles: [], protect: [] };
  const cold = renderSite(backend as any);
  const warm = renderSite({ ...backend, warm: true } as any);
  assert.match(cold, /sablier http:\/\/sablier:10000/);
  assert.match(cold, /session_duration 10m/);
  assert.doesNotMatch(warm, /sablier/);
  for (const route of [cold, warm]) {
    assert.match(route, /import nanodeploy_gate availability/);
    assert.match(route, /reverse_proxy app-availability:3000/);
  }
});
