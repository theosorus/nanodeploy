import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import AdmZip from "adm-zip";
import { timingSafeEqual } from "node:crypto";
import { readFile, rm, mkdir, readdir, stat } from "node:fs/promises";
import { lookup } from "node:dns/promises";
import { join } from "node:path";
import { parseManifest } from "./manifest.js";
import * as store from "./db.js";
import * as dk from "./docker.js";
import { writeSite, applySite, dropSite } from "./caddy.js";
import * as people from "./people.js";

const APPS_DIR = process.env.APPS_DIR ?? "/srv/apps";
const TOKEN = process.env.DEPLOY_TOKEN ?? "";
// An empty token would make the caddy CLI bypass match "Bearer " and every
// bearer check succeed on an empty string. Refuse to run rather than come up
// wide open because someone hand-edited .env.
if (TOKEN.length < 24) {
  console.error(
    "DEPLOY_TOKEN is missing or shorter than 24 characters. " +
      "Run ./install.sh, or set a long random value in .env, then restart.",
  );
  process.exit(1);
}

const app = new Hono();

// upload sanity: disk and ram are constrained on the target machine
const MAX_BUNDLE_BYTES = 100 * 1024 * 1024;
const MAX_BUNDLE_UNPACKED = 512 * 1024 * 1024;
const MAX_BUNDLE_ENTRIES = 5000;

const SLUG_RE = /^[a-z][a-z0-9-]{1,30}$/;
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
// env keys owned by the platform: not user-settable, not listed in the UI
const PLATFORM_ENV = new Set(["DATABASE_URL"]);

const GROUP_NAME_RE = /^[\p{L}\p{N}._'-]+$/u;

await store.initState();
await store.migrateState();

/* ---------- auth ---------- */

// Two callers: the CLI with the exact bearer token, the browser with a
// tinyauth session. caddy strips inbound Remote-* headers and its CLI bypass
// only matches the exact token, but the control plane re-checks both anyway:
// one missing check used to let anyone bypass tinyauth with a bogus header.
const tokenOk = (c: Context) => {
  const given = c.req.header("authorization");
  if (!given?.startsWith("Bearer ")) return false;
  const a = Buffer.from(given.slice(7));
  const b = Buffer.from(TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
};

const sessionOk = (c: Context) => Boolean(c.req.header("remote-sub"));

const sessionGroups = (c: Context) =>
  (c.req.header("remote-groups") ?? "")
    .split(",")
    .map((g) => g.trim())
    .filter(Boolean);

// Full platform access: the CLI token, or a signed-in account flagged as admin
// in the identity provider (the owner always is). Console access follows that
// one flag, never a named group, so no group edit can ever lock the owner out.
// Before an identity provider is wired up there is only the owner, so a bare
// session is allowed through to bootstrap the first setup.
const adminOk = async (c: Context) => {
  if (tokenOk(c)) return true;
  if (!sessionOk(c)) return false;
  if (!people.configured()) return true;
  const me = await people.findBySession(
    c.req.header("remote-sub") ?? "",
    c.req.header("remote-email") ?? "",
  );
  return Boolean(me?.isAdmin);
};

const isMe = (c: Context) => c.req.path === "/api/me";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

// A cookie-authenticated console needs a cross-origin guard. multipart/form-data
// is a CORS "simple request": any web page a logged-in admin visits could POST a
// bundle to /api/deploy with their session cookie and get arbitrary code running
// on the server, with no preflight to block it. Token callers carry no ambient
// authority and are exempt.
const sameOrigin = (c: Context) => {
  const site = c.req.header("sec-fetch-site");
  if (site) return site === "same-origin" || site === "none";
  const origin = c.req.header("origin");
  if (!origin) return true; // curl, the CLI, anything that is not a browser
  try {
    return new URL(origin).host === (c.req.header("host") ?? "");
  } catch {
    return false;
  }
};

app.use("/api/*", async (c: Context, next: Next) => {
  const viaToken = tokenOk(c);
  if (!viaToken && !SAFE_METHODS.has(c.req.method) && !sameOrigin(c)) {
    return c.json({ error: "cross-origin request refused" }, 403);
  }
  if (isMe(c) ? viaToken || sessionOk(c) : await adminOk(c)) return await next();
  // tell a signed-in non-admin apart from a stranger: the dashboard shows
  // "you are not an administrator" instead of "your session expired"
  if (sessionOk(c)) {
    return c.json({ error: "this account is not an administrator", admin: false }, 403);
  }
  return c.json({ error: "unauthorized" }, 401);
});

/* ---------- per-slug serialization ---------- */

// deploy / env / access / delete / wake and reconcile all rebuild containers
// and rows for the same slug; without a lock, two concurrent deploys can leave
// a container from one bundle and a row pointing at another.
const tails = new Map<string, Promise<void>>();
async function runLocked<T>(slug: string, fn: () => Promise<T>): Promise<T> {
  const prev = tails.get(slug) ?? Promise.resolve();
  let done!: () => void;
  const tail = new Promise<void>((r) => (done = r));
  tails.set(slug, tail);
  await prev;
  try {
    return await fn();
  } finally {
    done();
    if (tails.get(slug) === tail) tails.delete(slug);
  }
}

// A route caddy serves is useless if the name never reaches the machine. When
// the tunnel or the DNS zone has no wildcard, a freshly deployed app fails as a
// browser "server not found" with nothing anywhere to explain it, so say it at
// deploy time instead.
async function hostResolves(host: string): Promise<boolean> {
  try {
    await lookup(host);
    return true;
  } catch {
    return false;
  }
}

const slugParam = (c: Context): string | null => {
  const slug = c.req.param("slug") as string;
  return SLUG_RE.test(slug) ? slug : null;
};

// A malformed JSON body should be the caller's fault (400), not a 500 with a
// stack trace. c.req.json() throws on bad input; this turns that into null.
async function jsonBody<T>(c: Context): Promise<T | null> {
  try {
    return await c.req.json<T>();
  } catch {
    return null;
  }
}

/* ---------- deploy ---------- */

app.post("/api/deploy", async (c) => {
  const body = await c.req.parseBody();
  const bundle = body["bundle"];
  if (!(bundle instanceof File)) return c.json({ error: "missing bundle" }, 400);
  if (bundle.size > MAX_BUNDLE_BYTES) {
    return c.json({ error: "bundle too large" }, 413);
  }

  // read the upload once: on a 4 GB machine, holding two copies of a 100 MB
  // bundle while apps are running is the difference between a deploy and an OOM
  const bytes = Buffer.from(await bundle.arrayBuffer());

  let manifest;
  try {
    const zip = new AdmZip(bytes);
    const entries = zip.getEntries();
    if (entries.length === 0) return c.json({ error: "empty bundle" }, 400);
    if (entries.length > MAX_BUNDLE_ENTRIES) {
      return c.json({ error: "too many files in bundle" }, 400);
    }
    const unpacked = entries.reduce((sum, e) => sum + (e.header.size ?? 0), 0);
    if (unpacked > MAX_BUNDLE_UNPACKED) return c.json({ error: "bundle too large" }, 413);
    const manifests = entries.filter((e) => !e.isDirectory && e.entryName === "app.yaml");
    if (manifests.length !== 1) {
      return c.json({ error: "bundle must contain exactly one top-level app.yaml" }, 400);
    }
    manifest = parseManifest(zip.readAsText(manifests[0]));
  } catch (err: any) {
    return c.json({ error: err?.message ?? "invalid bundle" }, 400);
  }

  const { slug } = manifest;
  return runLocked(slug, async () => {
    try {
      return await c.json(await doDeploy(manifest, bytes));
    } catch (err: any) {
      return c.json({ error: err?.message ?? "deploy failed" }, 500);
    }
  });
});

async function doDeploy(manifest: ReturnType<typeof parseManifest>, zip: Buffer) {
  const dir = join(APPS_DIR, manifest.slug);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  new AdmZip(zip).extractAllTo(dir, true);
  // zip headers can lie about sizes: measure the extracted bundle for real
  const { bytes, files } = await dirStats(dir);
  if (files > MAX_BUNDLE_ENTRIES || bytes > MAX_BUNDLE_UNPACKED) {
    await rm(dir, { recursive: true, force: true });
    throw new Error("bundle exceeds the unpacked size limits");
  }

  const log: string[] = [];
  const env: Record<string, string> = {};

  const previous = await store.getApp(manifest.slug);
  for (const key of manifest.env) {
    const value = previous?.env?.[key];
    if (value) env[key] = value;
    else log.push(`env ${key} is declared but not set yet, set it in the dashboard`);
  }

  let dbUser: string | null = previous?.db_user ?? null;
  let dbPassword: string | null = previous?.db_password ?? null;

  if (manifest.database.enabled) {
    const creds = await store.provisionDatabase(manifest.slug);
    dbUser = creds.user;
    dbPassword = creds.password;
    env.DATABASE_URL = store.databaseUrl(creds.user, creds.password);
    // parseManifest already jailed the migrations path inside the bundle
    const applied = await store.runMigrations(join(dir, manifest.database.migrations), env.DATABASE_URL);
    log.push(applied.length ? `applied ${applied.length} migration(s)` : "no new migrations");
  }

  let image: string | null = previous?.image ?? null;
  if (manifest.backend) {
    image = await dk.buildImage(dir, manifest.slug, manifest.backend.entry, manifest.backend.port);
    await dk.runContainer({
      slug: manifest.slug,
      image,
      port: manifest.backend.port,
      idleTimeout: manifest.idle.timeout,
      warm: manifest.idle.warm,
      env,
    });
    // a cold app goes straight back to sleep: a running container sablier did
    // not start would have no session and never scale back down on its own.
    if (!manifest.idle.warm) await dk.stopContainer(manifest.slug);
    log.push(`backend container ${dk.containerName(manifest.slug)} created`);
  }

  const row = {
    slug: manifest.slug,
    name: manifest.name,
    access: manifest.access,
    groups: manifest.groups,
    port: manifest.backend?.port ?? null,
    idle_timeout: manifest.idle.timeout,
    warm: manifest.idle.warm,
    db_user: dbUser,
    db_password: dbPassword,
    env,
    image,
    declared_env: manifest.env,
  };
  await store.upsertApp(row as any);
  await store.touchDeploy(manifest.slug);
  const routed = await applySite((await store.getApp(manifest.slug))!);
  log.push(
    routed
      ? "caddy route is live"
      : "WARNING: caddy refused the new route and the previous config was restored, the app is not reachable",
  );
  await pruneAll();

  const host = `${manifest.slug}.${process.env.APPS_DOMAIN}`;
  if (!(await hostResolves(host))) {
    log.push(
      `WARNING: ${host} does not resolve. The app is running but nothing on the ` +
        `internet can reach it: add a wildcard *.${process.env.APPS_DOMAIN} ` +
        `hostname to your tunnel or DNS zone.`,
    );
  }

  return {
    ok: true,
    url: `https://${host}`,
    log,
  };
}

async function dirStats(dir: string): Promise<{ bytes: number; files: number }> {
  let bytes = 0;
  let files = 0;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop()!;
    for (const e of await readdir(current, { withFileTypes: true })) {
      const p = join(current, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) {
        bytes += (await stat(p)).size;
        files++;
      }
    }
  }
  return { bytes, files };
}

async function pruneAll() {
  const images = await store.listApps();
  await dk
    .pruneImages(new Set(images.map((a) => a.image).filter(Boolean) as string[]))
    .catch((err) => console.error("image prune failed", err));
}

/* ---------- reconcile ---------- */

// Runs at every start of the control plane, so a reboot, a wiped docker
// data-root or a container deleted by hand all heal themselves. Postgres holds
// the truth about what should exist; docker and caddy are rebuilt from it.
// Images are rebuilt from the stored bundle when a wiped data-root took them
// with it: dist/ and server.js live on disk in APPS_DIR, docker only had copies.
async function rebuildImage(a: store.AppRow): Promise<string> {
  const raw = await readFile(join(APPS_DIR, a.slug, "app.yaml"), "utf8");
  const manifest = parseManifest(raw);
  if (!manifest.backend) throw new Error("stored bundle has no backend to rebuild");
  return dk.buildImage(
    join(APPS_DIR, a.slug),
    a.slug,
    manifest.backend.entry,
    manifest.backend.port,
  );
}

async function reconcile() {
  const apps = await store.listApps();
  for (const a of apps) {
    await runLocked(a.slug, async () => {
      try {
        // re-read under the lock: a deploy that ran while we waited changed the
        // row, and acting on the stale snapshot would roll it back
        const fresh = await store.getApp(a.slug);
        if (!fresh) return;
        await writeSite(fresh);
        if (!fresh.image || !fresh.port) return;
        const status = await dk.appStatus(fresh.slug);

        let image = fresh.image;
        let rebuilt = false;
        // an image removed by hand while its cold app was asleep would never
        // be healed: no container recreate is needed, but sablier cannot start
        // a container whose image is gone either.
        if (!(await dk.imageExists(image))) {
          image = await rebuildImage(fresh);
          await store.upsertApp({ slug: fresh.slug, image } as any);
          rebuilt = true;
          console.log(`reconcile: rebuilt image for ${fresh.slug}`);
        }
        const needsRecreate =
          rebuilt || status === "missing" || (fresh.warm && status === "sleeping");
        if (!needsRecreate) return;

        await dk.runContainer({
          slug: fresh.slug,
          image,
          port: fresh.port,
          idleTimeout: fresh.idle_timeout,
          warm: fresh.warm,
          env: fresh.env,
        });
        // a cold app that lost its container was asleep: put it back to sleep
        // instead of leaving it awake with no sablier session to stop it
        if (!fresh.warm) await dk.stopContainer(fresh.slug);
        console.log(`reconcile: recreated ${fresh.slug}`);
      } catch (err) {
        console.error(`reconcile: ${a.slug} failed`, err);
      }
    });
  }
  if (apps.length) {
    const reloaded = await dk.reloadCaddy().catch(() => false);
    if (!reloaded) console.error("reconcile: caddy reload failed, routes may be stale");
    // re-list: a rebuild above changed an image tag, the keep set must be fresh
    const current = await store.listApps();
    await dk
      .pruneImages(new Set(current.map((a) => a.image).filter(Boolean) as string[]))
      .catch(() => {});
  }
  return apps.length;
}

app.post("/api/reconcile", async (c) => c.json({ ok: true, apps: await reconcile() }));

/* ---------- apps ---------- */

app.get("/api/apps", async (c) => {
  const apps = await store.listApps();
  const withStatus = await Promise.all(
    apps.map(async (a) => {
      // platform-managed keys (DATABASE_URL) are not user-settable nor listed
      const envKeys = [...new Set([...Object.keys(a.env), ...(a.declared_env ?? [])])].filter(
        (k) => !PLATFORM_ENV.has(k),
      );
      const status = a.port ? await dk.appStatus(a.slug) : "static";
      return {
        slug: a.slug,
        name: a.name,
        access: a.access,
        groups: a.groups,
        hasBackend: a.port !== null,
        hasDatabase: a.db_user !== null,
        warm: a.warm,
        idleTimeout: a.idle_timeout,
        env: Object.fromEntries(envKeys.map((k) => [k, k in a.env ? "set" : "unset"])),
        envKeys,
        status,
        // only a running container has stats, and only then is the call worth
        // making: on this platform most apps are asleep most of the time
        memory: status === "awake" ? await dk.appMemory(a.slug) : null,
        deployedAt: a.deployed_at,
      };
    }),
  );
  return c.json({ apps: withStatus, host: await dk.hostMemory() });
});

app.post("/api/apps/:slug/access", async (c) => {
  const slug = slugParam(c);
  if (!slug) return c.json({ error: "unknown app" }, 404);
  return runLocked(slug, async () => {
    const current = await store.getApp(slug);
    if (!current) return c.json({ error: "unknown app" }, 404);
    const { access, groups } = (await jsonBody<{ access?: string; groups?: string[] }>(c)) ?? {};
    if (access !== "public" && access !== "private" && access !== "groups") {
      return c.json({ error: "invalid access mode" }, 400);
    }
    // group names become tokens of a generated Caddyfile, keep them tame
    const cleanGroups = (groups ?? [])
      .filter((g) => typeof g === "string")
      .map((g) => g.replace(/[\r\n"\\]/g, "").trim().slice(0, 64))
      .filter((g) => g.length > 0)
      .slice(0, 32);
    if (access === "groups") {
      if (cleanGroups.length === 0) {
        return c.json({ error: "groups access requires at least one group" }, 400);
      }
      const bad = cleanGroups.find((g) => !GROUP_NAME_RE.test(g));
      if (bad) {
        return c.json({ error: `group name not allowed in caddy config: ${bad}` }, 400);
      }
    }
    const rollback = { access: current.access, groups: current.groups };
    await store.setAccess(slug, access, cleanGroups);
    if (!(await applySite((await store.getApp(slug))!))) {
      // caddy kept its previous config, so must the database: an app shown as
      // public while the gateway still asks for a login is worse than an error
      await store.setAccess(slug, rollback.access, rollback.groups);
      return c.json({ error: "caddy refused the new access rule, nothing changed" }, 502);
    }
    return c.json({ ok: true });
  });
});

app.post("/api/apps/:slug/env", async (c) => {
  const slug = slugParam(c);
  if (!slug) return c.json({ error: "unknown app" }, 404);
  return runLocked(slug, async () => {
    const current = await store.getApp(slug);
    if (!current) return c.json({ error: "unknown app" }, 404);
    const patch = await jsonBody<Record<string, string>>(c);
    if (!patch || typeof patch !== "object") return c.json({ error: "invalid body" }, 400);
    const valid = Object.entries(patch).every(
      ([k, v]) => ENV_KEY_RE.test(k) && typeof v === "string" && v.length <= 16_384,
    );
    if (!valid) return c.json({ error: "invalid env key or value" }, 400);
    // only manifest-declared variables can be written (a key is writable even
    // before its first value exists). Platform-managed keys like DATABASE_URL
    // are never declared, so they cannot be replaced.
    const allowed = new Set(current.declared_env ?? []);
    if (!Object.keys(patch).every((k) => allowed.has(k))) {
      return c.json({ error: "env key is not declared in the manifest" }, 400);
    }
    const env = { ...current.env, ...patch };
    await store.upsertApp({ slug, env } as any);
    if (current.image && current.port) {
      await dk.runContainer({
        slug,
        image: current.image,
        port: current.port,
        idleTimeout: current.idle_timeout,
        // before the fix, warm was dropped here and a warm app silently became
        // scale-to-zero after any env change
        warm: current.warm,
        env,
      });
      // same rule as deploy: only a warm app stays awake after a recreate
      if (!current.warm) await dk.stopContainer(slug);
    }
    return c.json({ ok: true });
  });
});

app.delete("/api/apps/:slug", async (c) => {
  const slug = slugParam(c);
  if (!slug) return c.json({ error: "unknown app" }, 404);
  return runLocked(slug, async () => {
    // re-validate the slug against the database: the rm below must never run
    // against a path that is not a real app directory
    const appRow = await store.getApp(slug);
    if (!appRow) return c.json({ error: "unknown app" }, 404);
    await dk.removeContainer(slug);
    await dk.removeDataVolume(slug);
    await store.deleteApp(slug);
    await rm(join(APPS_DIR, slug), { recursive: true, force: true });
    const dropped = await dropSite(slug);
    await pruneAll();
    // the postgres database survives on purpose, the /data volume does not:
    // the dashboard says both out loud before asking for confirmation
    if (!dropped) {
      // dropping the file broke the whole config, so it was put back: the route
      // survives the app and has to be removed by hand
      return c.json(
        {
          ok: true,
          note: `app removed, but caddy refused the config without its route: delete ${slug}.caddy by hand`,
        },
        502,
      );
    }
    return c.json({ ok: true, note: "postgres database kept, drop it manually if needed" });
  });
});

app.get("/api/apps/:slug/logs", async (c) => {
  const slug = slugParam(c);
  if (!slug) return c.json({ error: "unknown app" }, 404);
  return c.json({ lines: await dk.tailLogs(slug) });
});

app.post("/api/apps/:slug/wake", async (c) => {
  const slug = slugParam(c);
  if (!slug) return c.json({ error: "unknown app" }, 404);
  return runLocked(slug, async () => {
    const current = await store.getApp(slug);
    if (!current) return c.json({ error: "unknown app" }, 404);
    if (!current.warm) {
      // a cold app woken here would run forever: sablier only stops containers
      // it started itself on behalf of a request
      return c.json({ error: "cold apps wake on their first request" }, 400);
    }
    try {
      await dk.startContainer(slug);
      return c.json({ ok: true });
    } catch (err: any) {
      return c.json({ error: err?.message ?? "failed to start container" }, 500);
    }
  });
});

/* ---------- people, proxied from Pocket ID so accounts live in one place ---------- */

app.get("/api/people", async (c) => {
  if (!people.configured()) {
    return c.json({ configured: false, people: [], groups: [] });
  }
  try {
    const [list, groups] = await Promise.all([people.listPeople(), people.listGroups()]);
    return c.json({ configured: true, people: list, groups });
  } catch (err: any) {
    return c.json({ configured: true, error: err.message, people: [], groups: [] }, 502);
  }
});

app.post("/api/people", async (c) => {
  // An invited account is not an administrator: it can sign in and open the apps
  // it is allowed, but not reach this console. Granting console access is a
  // separate, explicit step (POST /api/people/:id/admin), so inviting someone is
  // safe and never hands out control of the machine.
  const { username, email, firstName } = (await jsonBody<Record<string, string>>(c)) ?? {};
  if (!username?.trim() || !email?.trim()) {
    return c.json({ error: "username and email are required" }, 400);
  }
  try {
    return c.json(await people.invite({ username: username.trim(), email: email.trim(), firstName }));
  } catch (err: any) {
    return c.json({ error: err.message }, 502);
  }
});

app.post("/api/people/:id/groups", async (c) => {
  const { groupIds } = (await jsonBody<{ groupIds: string[] }>(c)) ?? {};
  if (!Array.isArray(groupIds) || groupIds.some((g) => typeof g !== "string")) {
    return c.json({ error: "groupIds must be a list of strings" }, 400);
  }
  await people.setGroups(c.req.param("id"), groupIds);
  return c.json({ ok: true });
});

app.delete("/api/people/:id", async (c) => {
  await people.removePerson(c.req.param("id"));
  return c.json({ ok: true });
});

app.post("/api/groups", async (c) => {
  const { name } = (await jsonBody<{ name: string }>(c)) ?? {};
  const clean = String(name ?? "").replace(/[\r\n"\\]/g, "").trim().slice(0, 64);
  if (!GROUP_NAME_RE.test(clean)) {
    return c.json({ error: "group name not allowed in caddy config" }, 400);
  }
  return c.json(await people.createGroup(clean));
});

// Grant or revoke console access. It follows the identity provider's admin flag,
// never a group, so no group edit can lock the owner out.
app.post("/api/people/:id/admin", async (c) => {
  const body = await jsonBody<{ admin?: unknown }>(c);
  if (!body || typeof body.admin !== "boolean") {
    return c.json({ error: "expected { admin: true | false }" }, 400);
  }
  const id = c.req.param("id");
  if (!body.admin) {
    // never let an admin revoke their own access, and never leave the console
    // with nobody able to manage it
    const me = await people.findBySession(
      c.req.header("remote-sub") ?? "",
      c.req.header("remote-email") ?? "",
    );
    if (me && me.id === id) {
      return c.json({ error: "you cannot remove your own console access" }, 400);
    }
    if ((await people.adminCount()) <= 1) {
      return c.json({ error: "this is the last administrator" }, 400);
    }
  }
  try {
    await people.setAdmin(id, body.admin);
    return c.json({ ok: true });
  } catch (err: any) {
    return c.json({ error: err.message }, 502);
  }
});

// Groups only decide who may open an app set to "groups". A rename must follow
// through to every app that references the group by name and to the caddy site
// that enforces it, or that app would quietly allow the wrong people.
function appsUsingGroup(apps: store.AppRow[], name: string) {
  return apps.filter((a) => a.access === "groups" && a.groups.includes(name));
}

app.patch("/api/groups/:id", async (c) => {
  const { name } = (await jsonBody<{ name: string }>(c)) ?? {};
  const clean = String(name ?? "").replace(/[\r\n"\\]/g, "").trim().slice(0, 64);
  if (!GROUP_NAME_RE.test(clean)) {
    return c.json({ error: "group name not allowed in caddy config" }, 400);
  }
  const groups = await people.listGroups().catch(() => null);
  const old = groups?.find((g) => g.id === c.req.param("id"));
  if (!old) return c.json({ error: "no such group" }, 404);
  if (old.name === clean) return c.json({ ok: true });
  try {
    await people.renameGroup(c.req.param("id"), clean);
  } catch (err: any) {
    return c.json({ error: err.message }, 502);
  }
  for (const row of appsUsingGroup(await store.listApps(), old.name)) {
    await runLocked(row.slug, async () => {
      const next = row.groups.map((g) => (g === old.name ? clean : g));
      await store.setAccess(row.slug, row.access, next);
      await applySite((await store.getApp(row.slug))!);
    });
  }
  return c.json({ ok: true });
});

app.delete("/api/groups/:id", async (c) => {
  const groups = await people.listGroups().catch(() => null);
  const g = groups?.find((x) => x.id === c.req.param("id"));
  if (!g) return c.json({ error: "no such group" }, 404);
  const used = appsUsingGroup(await store.listApps(), g.name);
  if (used.length > 0) {
    return c.json(
      {
        error: `still used by ${used.map((a) => a.name).join(", ")}. Change those apps' access first.`,
      },
      409,
    );
  }
  try {
    await people.deleteGroup(c.req.param("id"));
    return c.json({ ok: true });
  } catch (err: any) {
    return c.json({ error: err.message }, 502);
  }
});

app.get("/api/me", async (c) =>
  c.json({
    name: c.req.header("Remote-Name") ?? c.req.header("Remote-User") ?? "",
    email: c.req.header("Remote-Email") ?? "",
    // the identity provider subject equals the Pocket ID user id, so the People
    // tab can tell which row is you and refuse to let you demote yourself
    sub: c.req.header("Remote-Sub") ?? null,
    domain: process.env.APPS_DOMAIN,
    admin: await adminOk(c),
    viaToken: tokenOk(c),
    groups: sessionGroups(c),
  }));

app.get("/", async (c) => c.html(await readFile("./public/index.html", "utf8")));
app.use("/*", serveStatic({ root: "./public" }));

serve({ fetch: app.fetch, port: 8000 });
console.log("nanodeploy control plane on :8000");

// wait for caddy and the docker socket proxy to settle before healing
setTimeout(() => {
  reconcile().then((n) => console.log(`reconcile: checked ${n} app(s)`));
}, 5000);
