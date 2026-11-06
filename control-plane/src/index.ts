import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import { timingSafeEqual } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { parseManifest, RESERVED_SLUGS, isPreviewSlug } from "./manifest.js";
import * as store from "./db.js";
import * as dk from "./docker.js";
import { writeSite, applySite, dropSite } from "./caddy.js";
import * as accounts from "./accounts.js";
import * as releases from "./releases.js";
import * as analytics from "./analytics.js";
import * as builds from "./builds.js";
import * as forges from "./forges.js";
import * as secrets from "./secrets.js";
import { randomBytes } from "node:crypto";

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

// set by the auth middleware when the caller is a deploy key: the only slug it
// may deploy
type Env = { Variables: { deployKeySlug?: string } };
const app = new Hono<Env>();


// an app slug, or a pull request preview of one (<slug>--pr-<n>)
const SLUG_RE = /^[a-z][a-z0-9-]{1,30}(--pr-\d{1,6})?$/;
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
// env keys owned by the platform: not user-settable, not listed in the UI
const PLATFORM_ENV = new Set(["DATABASE_URL"]);

const GROUP_NAME_RE = /^[\p{L}\p{N}._'-]+$/u;

await store.initState();
await store.migrateState();
await store.initGate();
await accounts.importFromPocketId();
await accounts.bootstrapLinks();

await releases.init();
await analytics.init();

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

// A deploy key (ndd_...) is bound to one slug. It may deploy that app and read
// its logs, nothing else: no env, no access mode, no other app, no accounts.
// That is the credential to hand to a CI job or an AI agent, never the token.
const deployKeyOf = async (c: Context): Promise<{ id: string; slug: string } | null> => {
  const given = c.req.header("authorization");
  if (!given?.startsWith("Bearer ndd_")) return null;
  return store.verifyDeployKey(given.slice(7));
};

const deployKeyRoutes = (c: Context, slug: string) => {
  const { method, path } = c.req;
  if (method === "POST" && path === "/api/deploy") return true; // slug checked there
  if (method === "GET" && path === `/api/apps/${slug}/logs`) return true;
  // a key can see its app's versions and go back to one: an agent that broke
  // the app can undo it without anyone's help
  if (method === "GET" && path === `/api/apps/${slug}/releases`) return true;
  if (method === "POST" && new RegExp(`^/api/apps/${slug}/releases/\\d+/rollback$`).test(path)) return true;
  if (method === "GET" && path === "/api/me") return true;
  return false;
};

const sessionOk = (c: Context) => Boolean(c.req.header("remote-sub"));

const sessionGroups = (c: Context) =>
  Buffer.from(c.req.header("remote-groups") ?? "", "latin1").toString("utf8")
    .split(",")
    .map((g) => g.trim())
    .filter(Boolean);

// Full platform access: the CLI token, or a signed-in account that is an
// administrator in gate. gate already refused anyone else on the console host;
// this is the second lock, read fresh from the database on every request so a
// demotion takes effect on the next click. There is no "no accounts yet, let
// everyone in" mode any more: the first administrator is made from a link the
// control plane prints in its logs.
const adminOk = async (c: Context) => {
  if (tokenOk(c)) return true;
  if (!sessionOk(c)) return false;
  return Boolean((await accounts.findById(c.req.header("remote-sub") ?? ""))?.isAdmin);
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

app.use("/api/*", async (c: Context<Env>, next: Next) => {
  const viaToken = tokenOk(c);
  if (!viaToken) {
    const key = await deployKeyOf(c);
    if (key) {
      // a key carries no ambient authority, so the cross-origin guard does not
      // apply, but it opens only its own short list of routes
      if (!deployKeyRoutes(c, key.slug)) {
        return c.json({ error: `this deploy key only deploys ${key.slug}` }, 403);
      }
      c.set("deployKeySlug", key.slug);
      return await next();
    }
    if (c.req.header("authorization")?.startsWith("Bearer ndd_")) {
      // revoked or mistyped key: never fall through to the session check
      return c.json({ error: "unknown or revoked deploy key" }, 401);
    }
  }
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

/* ---------- deploy: every bundle becomes a numbered release ---------- */

// Who did it, for the release history: a person, a deploy key, or the token.
function actor(c: Context<Env>): string {
  const key = c.get("deployKeySlug");
  if (key) return "deploy key";
  if (tokenOk(c)) return "deploy token";
  const user = c.req.header("remote-user");
  return user ? Buffer.from(user, "latin1").toString("utf8") : "console";
}

// The upload, read once and checked before anything touches the disk. On a 4 GB
// machine, holding two copies of a 100 MB bundle while apps are running is the
// difference between a deploy and an OOM.
async function readUpload(c: Context<Env>) {
  const body = await c.req.parseBody();
  const bundle = body["bundle"];
  if (!(bundle instanceof File)) return { error: "missing bundle", status: 400 as const };
  if (bundle.size > releases.MAX_BUNDLE_BYTES) return { error: "bundle too large", status: 413 as const };
  const bytes = Buffer.from(await bundle.arrayBuffer());
  let manifest;
  try {
    manifest = releases.readBundle(bytes);
  } catch (err: any) {
    return { error: err?.message ?? "invalid bundle", status: 400 as const };
  }
  if (isPreviewSlug(manifest.slug)) {
    return { error: `"--pr-" slugs are made by the platform for pull request previews`, status: 400 as const };
  }
  const keySlug = c.get("deployKeySlug");
  if (keySlug && keySlug !== manifest.slug) {
    return { error: `this deploy key is for ${keySlug}, the bundle's app.yaml says ${manifest.slug}`, status: 403 as const };
  }
  const text = (k: string) => (typeof body[k] === "string" ? String(body[k]) : undefined);
  return {
    bytes,
    manifest,
    meta: {
      message: text("message"),
      commitSha: text("commit_sha"),
      commitMessage: text("commit_message"),
      createdBy: actor(c),
    },
  };
}

function failure(c: Context, err: any) {
  return c.json(
    {
      error: err?.message ?? "deploy failed",
      note: err?.untouched ? "the running version was left untouched" : undefined,
      log: err?.log,
    },
    500,
  );
}

// One step, for the CLI, CI jobs and agents: stage and go live.
app.post("/api/deploy", async (c) => {
  const up = await readUpload(c);
  if ("error" in up) return c.json({ error: up.error }, up.status);
  const source = c.get("deployKeySlug") || tokenOk(c) ? "cli" : "upload";
  return runLocked(up.manifest.slug, async () => {
    let staged;
    try {
      staged = await releases.stage(up.manifest, up.bytes, { ...up.meta, source });
    } catch (err: any) {
      return c.json({ error: err?.message ?? "invalid bundle" }, 400);
    }
    try {
      return c.json(await releases.promote(staged.id));
    } catch (err) {
      return failure(c, err);
    }
  });
});

// Two steps, for the dashboard: put the files next to the live version and say
// what would change, then go live once someone has read it. ?expect=<slug>
// refuses a bundle for another app, so dropping the wrong zip on an app's panel
// cannot replace a different app.
app.post("/api/releases", async (c) => {
  const up = await readUpload(c);
  if ("error" in up) return c.json({ error: up.error }, up.status);
  const expect = c.req.query("expect");
  if (expect && expect !== up.manifest.slug) {
    return c.json({ error: `this bundle is for "${up.manifest.slug}", not "${expect}"` }, 400);
  }
  return runLocked(up.manifest.slug, async () => {
    try {
      const staged = await releases.stage(up.manifest, up.bytes, { ...up.meta, source: "upload" });
      return c.json({ release: { id: staged.id, number: staged.number, slug: staged.slug }, diff: await releases.diff(staged) });
    } catch (err: any) {
      return c.json({ error: err?.message ?? "invalid bundle" }, 400);
    }
  });
});

const releaseParam = async (c: Context) => {
  const id = c.req.param("id") as string;
  return /^\d{1,18}$/.test(id) ? releases.getRelease(id) : null;
};

app.post("/api/releases/:id/promote", async (c) => {
  const r = await releaseParam(c);
  if (!r) return c.json({ error: "unknown release" }, 404);
  return runLocked(r.slug, async () => {
    try {
      return c.json(await releases.promote(r.id));
    } catch (err) {
      return failure(c, err);
    }
  });
});

app.post("/api/releases/:id/discard", async (c) => {
  const r = await releaseParam(c);
  if (!r) return c.json({ error: "unknown release" }, 404);
  return runLocked(r.slug, async () => c.json({ ok: await releases.discard(r.id) }));
});

app.get("/api/apps/:slug/releases", async (c) => {
  const slug = slugParam(c);
  if (!slug) return c.json({ error: "unknown app" }, 404);
  const history = await releases.listReleases(slug, 500);
  const shown = history.filter((r) => r.status !== "staged").slice(0, 20);
  const rows = await Promise.all(
    shown.map(async (r) => ({
      id: r.id,
      number: r.number,
      dir: r.dir,
      source: r.source,
      message: r.message,
      commitSha: r.commit_sha,
      commitMessage: r.commit_message,
      status: r.status,
      createdBy: r.created_by,
      createdAt: r.created_at,
      migrations: r.migrations_applied,
      rollbackOf: r.rollback_of ? history.find((h) => h.id === r.rollback_of)?.number ?? null : null,
      rollback: r.status === "superseded" ? await releases.rollbackInfo(r, history) : null,
    })),
  );
  // a snapshot path says where app data sits on disk: the dashboard only needs
  // to know whether one exists
  return c.json({
    releases: rows.map((r) => ({ ...r, rollback: r.rollback && { ...r.rollback, snapshot: Boolean(r.rollback.snapshot) } })),
  });
});

app.get("/api/apps/:slug/releases/:id", async (c) => {
  const r = await releaseParam(c);
  if (!r || r.slug !== c.req.param("slug")) return c.json({ error: "unknown release" }, 404);
  return c.json({ number: r.number, status: r.status, log: r.log.split("\n").filter(Boolean) });
});

app.post("/api/apps/:slug/releases/:id/rollback", async (c) => {
  const slug = slugParam(c);
  const r = await releaseParam(c);
  if (!slug || !r || r.slug !== slug) return c.json({ error: "unknown release" }, 404);
  const body = (await jsonBody<{ database?: boolean }>(c)) ?? {};
  return runLocked(slug, async () => {
    try {
      return c.json(await releases.rollback(slug, r.id, body.database === true, actor(c)));
    } catch (err: any) {
      return c.json({ error: err?.message ?? "rollback failed" }, 400);
    }
  });
});

async function pruneAll() {
  await dk.pruneImages(await releases.imagesToKeep()).catch((err) => console.error("image prune failed", err));
}

/* ---------- reconcile ---------- */

// Runs at every start of the control plane, so a reboot, a wiped docker
// data-root or a container deleted by hand all heal themselves. Postgres holds
// the truth about what should exist; docker and caddy are rebuilt from it.
// Images are rebuilt from the stored bundle when a wiped data-root took them
// with it: dist/ and server.js live on disk in APPS_DIR, docker only had copies.
async function rebuildImage(a: store.AppRow): Promise<string> {
  const dir = await releases.liveDir(a.slug);
  const manifest = parseManifest(await readFile(join(dir, "app.yaml"), "utf8"));
  if (!manifest.backend) throw new Error("stored bundle has no backend to rebuild");
  // same tag as the one recorded: the release keeps its image name
  return dk.buildImage(dir, a.image ?? `nanodeploy/${a.slug}:rebuilt`, manifest.backend.entry, manifest.backend.port);
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
        // apps deployed before releases existed move to the new layout once
        await releases.adoptLegacy(fresh);
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

        analytics.quiet(fresh.slug);
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
    await pruneAll();
  }
  return apps.length;
}

app.post("/api/reconcile", async (c) => c.json({ ok: true, apps: await reconcile() }));

/* ---------- apps ---------- */

app.get("/api/apps", async (c) => {
  const apps = await store.listApps();
  const live = new Map(
    (await store.sql<{ slug: string; number: number }[]>`select slug, number from releases where status = 'live'`).map(
      (r) => [r.slug, r.number],
    ),
  );
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
        roles: a.roles ?? [],
        protect: a.protect ?? [],
        warm: a.warm,
        idleTimeout: a.idle_timeout,
        env: Object.fromEntries(envKeys.map((k) => [k, k in a.env ? "set" : "unset"])),
        envKeys,
        status,
        // only a running container has stats, and only then is the call worth
        // making: on this platform most apps are asleep most of the time
        memory: status === "awake" ? await dk.appMemory(a.slug) : null,
        deployedAt: a.deployed_at,
        release: live.get(a.slug) ?? null,
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
      analytics.quiet(slug);
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

// Removes an app with everything the platform made for it. The postgres
// database survives on purpose, the /data volume does not: the dashboard says
// both out loud before asking. A pull request preview loses its database too.
async function removeApp(slug: string, dropDatabase: boolean): Promise<{ routeDropped: boolean } | null> {
  // re-validate the slug against the database: the rm below must never run
  // against a path that is not a real app directory
  const appRow = await store.getApp(slug);
  if (!appRow) return null;
  await dk.removeContainer(slug);
  await dk.removeDataVolume(slug);
  if (dropDatabase) await store.dropAppDatabase(slug);
  await store.deleteApp(slug);
  // a forgotten key must not be able to bring a deleted app back
  await store.deleteDeployKeysOf(slug);
  await accounts.deleteAppGrants(slug);
  await releases.deleteAll(slug);
  await analytics.forgetApp(slug);
  await rm(join(APPS_DIR, slug), { recursive: true, force: true });
  const routeDropped = await dropSite(slug);
  await pruneAll();
  return { routeDropped };
}

app.delete("/api/apps/:slug", async (c) => {
  const slug = slugParam(c);
  if (!slug) return c.json({ error: "unknown app" }, 404);
  return runLocked(slug, async () => {
    const preview = Boolean((await store.getApp(slug)) && isPreviewSlug(slug));
    const out = await removeApp(slug, preview);
    if (!out) return c.json({ error: "unknown app" }, 404);
    if (!out.routeDropped) {
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
    return c.json({ ok: true, note: preview ? "preview removed with its database" : "postgres database kept, drop it manually if needed" });
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

/* ---------- deploy keys ---------- */

// Keyed by slug, not by app row: a key can be made before the first deploy, so
// an agent can ship a brand new app without ever seeing the root token.
const keySlug = (c: Context): string | null => {
  const slug = slugParam(c);
  return slug && !RESERVED_SLUGS.has(slug) ? slug : null;
};

app.get("/api/apps/:slug/keys", async (c) => {
  const slug = keySlug(c);
  if (!slug) return c.json({ error: "invalid app name" }, 400);
  return c.json({ keys: await store.listDeployKeys(slug) });
});

app.post("/api/apps/:slug/keys", async (c) => {
  const slug = keySlug(c);
  if (!slug) return c.json({ error: "invalid app name" }, 400);
  const body = await jsonBody<{ label?: unknown }>(c);
  const label = String(body?.label ?? "").replace(/[\r\n]/g, " ").trim().slice(0, 60) || "deploy key";
  if ((await store.listDeployKeys(slug)).length >= 20) {
    return c.json({ error: "20 keys at most per app, revoke an old one first" }, 400);
  }
  return c.json(await store.createDeployKey(slug, label));
});

app.delete("/api/apps/:slug/keys/:id", async (c) => {
  const slug = keySlug(c);
  const id = c.req.param("id");
  if (!slug || !/^\d{1,18}$/.test(id)) return c.json({ error: "unknown key" }, 404);
  return (await store.deleteDeployKey(slug, id))
    ? c.json({ ok: true })
    : c.json({ error: "unknown key" }, 404);
});

/* ---------- people: accounts and groups, stored in gate's schema ---------- */

const errorOf = (err: any) => String(err?.message ?? err).slice(0, 300);

app.get("/api/people", async (c) => {
  const [list, groups] = await Promise.all([accounts.listPeople(), accounts.listGroups()]);
  return c.json({ configured: true, people: list, groups, authOrigin: accounts.AUTH_ORIGIN });
});

app.post("/api/people", async (c) => {
  // An invited account is not an administrator: it can sign in and open the apps
  // it is allowed, but not reach this console. Granting console access is a
  // separate, explicit step (POST /api/people/:id/admin), so inviting someone is
  // safe and never hands out control of the machine.
  const { username, email, firstName } = (await jsonBody<Record<string, string>>(c)) ?? {};
  if (!username?.trim()) return c.json({ error: "username is required" }, 400);
  try {
    return c.json(await accounts.invite({ username, email: email ?? "", firstName }));
  } catch (err) {
    return c.json({ error: errorOf(err) }, 400);
  }
});

// a link to set a password or a passkey: for a forgotten password, a lost
// phone, or an invitation that expired
app.post("/api/people/:id/link", async (c) => {
  try {
    return c.json({ link: await accounts.signInLink(c.req.param("id")) });
  } catch (err) {
    return c.json({ error: errorOf(err) }, 404);
  }
});

app.post("/api/people/:id/groups", async (c) => {
  const { groupIds } = (await jsonBody<{ groupIds: string[] }>(c)) ?? {};
  if (!Array.isArray(groupIds) || groupIds.some((g) => typeof g !== "string")) {
    return c.json({ error: "groupIds must be a list of strings" }, 400);
  }
  const known = new Set((await accounts.listGroups()).map((g) => g.id));
  if (groupIds.some((g) => !known.has(g))) return c.json({ error: "unknown group" }, 400);
  await accounts.setGroups(c.req.param("id"), groupIds);
  return c.json({ ok: true });
});

app.delete("/api/people/:id", async (c) => {
  const id = c.req.param("id");
  if (id === c.req.header("remote-sub")) return c.json({ error: "you cannot remove your own account" }, 400);
  const target = await accounts.findById(id);
  if (target?.isAdmin && (await accounts.adminCount()) <= 1) {
    return c.json({ error: "this is the last administrator" }, 400);
  }
  await accounts.removePerson(id);
  return c.json({ ok: true });
});

app.post("/api/groups", async (c) => {
  const { name } = (await jsonBody<{ name: string }>(c)) ?? {};
  const clean = String(name ?? "").replace(/[\r\n"\\]/g, "").trim().slice(0, 64);
  if (!GROUP_NAME_RE.test(clean)) {
    return c.json({ error: "group name: letters, digits, dots, dashes, underscores" }, 400);
  }
  try {
    return c.json(await accounts.createGroup(clean));
  } catch (err) {
    return c.json({ error: errorOf(err) }, 400);
  }
});

// Grant or revoke console access. It follows the account's admin flag, never a
// group, so no group edit can lock the owner out.
app.post("/api/people/:id/admin", async (c) => {
  const body = await jsonBody<{ admin?: unknown }>(c);
  if (!body || typeof body.admin !== "boolean") {
    return c.json({ error: "expected { admin: true | false }" }, 400);
  }
  const id = c.req.param("id");
  if (!body.admin) {
    // never let an admin revoke their own access, and never leave the console
    // with nobody able to manage it
    if (id === c.req.header("remote-sub")) {
      return c.json({ error: "you cannot remove your own console access" }, 400);
    }
    if ((await accounts.adminCount()) <= 1) {
      return c.json({ error: "this is the last administrator" }, 400);
    }
  }
  try {
    await accounts.setAdmin(id, body.admin);
    return c.json({ ok: true });
  } catch (err) {
    return c.json({ error: errorOf(err) }, 404);
  }
});

// Groups decide who may open an app set to "groups", by name. A rename must
// follow through to every app that references the group.
function appsUsingGroup(apps: store.AppRow[], name: string) {
  return apps.filter((a) => a.access === "groups" && a.groups.includes(name));
}

app.patch("/api/groups/:id", async (c) => {
  const { name } = (await jsonBody<{ name: string }>(c)) ?? {};
  const clean = String(name ?? "").replace(/[\r\n"\\]/g, "").trim().slice(0, 64);
  if (!GROUP_NAME_RE.test(clean)) {
    return c.json({ error: "group name: letters, digits, dots, dashes, underscores" }, 400);
  }
  const old = (await accounts.listGroups()).find((g) => g.id === c.req.param("id"));
  if (!old) return c.json({ error: "no such group" }, 404);
  if (old.name === clean) return c.json({ ok: true });
  try {
    await accounts.renameGroup(old.id, clean);
  } catch (err) {
    return c.json({ error: errorOf(err) }, 400);
  }
  for (const row of appsUsingGroup(await store.listApps(), old.name)) {
    await runLocked(row.slug, async () => {
      const next = row.groups.map((g) => (g === old.name ? clean : g));
      await store.setAccess(row.slug, row.access, next);
    });
  }
  return c.json({ ok: true });
});

app.delete("/api/groups/:id", async (c) => {
  const g = (await accounts.listGroups()).find((x) => x.id === c.req.param("id"));
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
  await accounts.deleteGroup(g.id);
  return c.json({ ok: true });
});

/* ---------- app roles: declared by the manifest, granted here ---------- */

app.get("/api/apps/:slug/roles", async (c) => {
  const slug = slugParam(c);
  const row = slug ? await store.getApp(slug) : null;
  if (!row) return c.json({ error: "unknown app" }, 404);
  return c.json({ roles: row.roles, protect: row.protect, grants: await accounts.grantsOf(row.slug) });
});

app.post("/api/apps/:slug/roles", async (c) => {
  const slug = slugParam(c);
  const row = slug ? await store.getApp(slug) : null;
  if (!row) return c.json({ error: "unknown app" }, 404);
  const body = await jsonBody<{ role?: string; kind?: string; id?: string; granted?: boolean }>(c);
  if (!body || typeof body.granted !== "boolean" || !body.role || !body.id) {
    return c.json({ error: "expected { role, kind, id, granted }" }, 400);
  }
  if (!row.roles.includes(body.role)) return c.json({ error: "this app does not declare that role" }, 400);
  if (body.kind !== "user" && body.kind !== "group") return c.json({ error: "kind is user or group" }, 400);
  if (body.granted && !(await accounts.subjectExists(body.kind, body.id))) {
    return c.json({ error: `unknown ${body.kind}` }, 404);
  }
  await accounts.setGrant(row.slug, { role: body.role, kind: body.kind, id: body.id }, body.granted);
  return c.json({ ok: true });
});

// Identity headers carry UTF-8 bytes, which node reads as latin1: "Zoé" would
// show as "ZoÃ©" without this.
const utf8Header = (c: Context, name: string) => {
  const v = c.req.header(name);
  return v === undefined ? undefined : Buffer.from(v, "latin1").toString("utf8");
};

app.get("/api/me", async (c) =>
  c.json({
    name: utf8Header(c, "Remote-Name") ?? utf8Header(c, "Remote-User") ?? "",
    email: utf8Header(c, "Remote-Email") ?? "",
    // the identity provider subject equals the Pocket ID user id, so the People
    // tab can tell which row is you and refuse to let you demote yourself
    sub: c.req.header("Remote-Sub") ?? null,
    domain: process.env.APPS_DOMAIN,
    admin: await adminOk(c),
    viaToken: tokenOk(c),
    // set when the caller is a deploy key: the app it is allowed to deploy
    deployKeyFor: c.get("deployKeySlug") ?? null,
    groups: sessionGroups(c),
  }));

/* ---------- analytics ---------- */

app.get("/api/analytics", async (c) => c.json(await analytics.overview()));

app.get("/api/apps/:slug/analytics", async (c) => {
  const slug = slugParam(c);
  const range = c.req.query("range") ?? "24h";
  if (!slug || !["24h", "7d", "30d"].includes(range)) return c.json({ error: "unknown app or range" }, 404);
  const detail = await analytics.appDetail(slug, range as "24h" | "7d" | "30d");
  return detail ? c.json(detail) : c.json({ error: "unknown app" }, 404);
});

/* ---------- git: providers, connections, builds ---------- */

// Webhooks come from GitHub or GitLab, not from a browser: caddy lets them in
// without a session, and they prove themselves by signature (GitHub) or by the
// secret token set on the hook (GitLab).
async function hook(kind: "github" | "gitlab", id: string | null, c: Context) {
  const body = Buffer.from(await c.req.arrayBuffer());
  if (body.length > 2 * 1024 * 1024) return c.json({ error: "payload too large" }, 413);
  const out = await builds.webhook(kind, id, c.req.raw.headers, body);
  return c.json({ message: out.message }, out.status as any);
}
app.post("/hooks/github", (c) => hook("github", null, c));
app.post("/hooks/gitlab/:id", (c) => hook("gitlab", c.req.param("id"), c));

app.get("/api/git", async (c) => {
  const providers = await builds.listProviders();
  return c.json({
    ready: secrets.ready(),
    consoleOrigin: builds.CONSOLE_ORIGIN,
    providers: providers.map((p) => ({
      id: p.id,
      kind: p.kind,
      name: p.name,
      installUrl: p.kind === "github" ? `${p.config.htmlUrl}/installations/new` : null,
    })),
    connections: await builds.listConnections(),
    builds: await builds.listBuilds(30),
  });
});

const needSecrets = (c: Context) =>
  secrets.ready() ? null : c.json({ error: "NANODEPLOY_SECRET_KEY is not set: run ./install.sh, then restart the control plane" }, 400);

// Step one of GitHub's manifest flow: the dashboard posts this manifest to
// GitHub in a form. The state ties the answer to this request.
app.post("/api/git/github/manifest", async (c) => {
  const missing = needSecrets(c);
  if (missing) return missing;
  const { org } = (await jsonBody<{ org?: string }>(c)) ?? {};
  if (org && !/^[A-Za-z0-9-]{1,39}$/.test(org)) return c.json({ error: "invalid organization name" }, 400);
  const state = randomBytes(16).toString("hex");
  await store.setSetting("git.github.state", `${state}:${Date.now()}`);
  const name = `nanodeploy-${process.env.APPS_DOMAIN!.split(".")[0]}`.slice(0, 26) + `-${randomBytes(3).toString("hex")}`;
  const base = org ? `${forges.GITHUB_WEB}/organizations/${org}/settings/apps/new` : `${forges.GITHUB_WEB}/settings/apps/new`;
  return c.json({ action: `${base}?state=${state}`, manifest: JSON.stringify(forges.githubManifest(name, builds.CONSOLE_ORIGIN)) });
});

// Step two: GitHub sends the browser back with a one-hour code, traded here for
// the app's id, private key and webhook secret. Then on to installing it.
app.get("/api/git/github/callback", async (c) => {
  const missing = needSecrets(c);
  if (missing) return missing;
  const [state, at] = ((await store.getSetting("git.github.state")) ?? "").split(":");
  const given = c.req.query("state") ?? "";
  if (!state || given !== state || Date.now() - Number(at) > 3_600_000) {
    return c.text("This GitHub answer does not match a request from this dashboard, or it is more than an hour old.", 400);
  }
  await store.setSetting("git.github.state", "");
  try {
    const app = await forges.githubConvert(c.req.query("code") ?? "");
    await builds.addGithub(app);
    return c.redirect(`${app.htmlUrl}/installations/new`, 302);
  } catch (err: any) {
    return c.text(`GitHub refused the code: ${err?.message ?? err}`, 502);
  }
});

app.post("/api/git/gitlab", async (c) => {
  const missing = needSecrets(c);
  if (missing) return missing;
  const { project, token } = (await jsonBody<{ project?: string; token?: string }>(c)) ?? {};
  if (!project || !/^[A-Za-z0-9._\/-]{1,200}$/.test(project) || !token || token.length > 200) {
    return c.json({ error: "expected { project: \"group/name\", token }" }, 400);
  }
  try {
    return c.json({ id: await builds.addGitlab(project, token) });
  } catch (err: any) {
    return c.json({ error: err?.message ?? "gitlab refused" }, 502);
  }
});

const idParam = (c: Context) => (/^\d{1,18}$/.test(c.req.param("id") ?? "") ? c.req.param("id")! : null);

app.delete("/api/git/providers/:id", async (c) => {
  const id = idParam(c);
  if (!id) return c.json({ error: "unknown provider" }, 404);
  try {
    await builds.removeProvider(id);
    return c.json({ ok: true });
  } catch (err: any) {
    return c.json({ error: err?.message }, 400);
  }
});

app.get("/api/git/providers/:id/repos", async (c) => {
  const id = idParam(c);
  const p = id ? await builds.getProvider(id) : null;
  if (!p) return c.json({ error: "unknown provider" }, 404);
  try {
    return c.json({ repos: await forges.forgeOf(p).repos() });
  } catch (err: any) {
    return c.json({ error: err?.message }, 502);
  }
});

app.post("/api/git/connections", async (c) => {
  const b = (await jsonBody<{ providerId?: string; repoId?: string; branch?: string; rootDir?: string; previews?: boolean }>(c)) ?? {};
  if (!b.providerId || !b.repoId || !b.branch) return c.json({ error: "expected { providerId, repoId, branch }" }, 400);
  try {
    const conn = await builds.connect({
      providerId: String(b.providerId),
      repoId: String(b.repoId),
      branch: b.branch,
      rootDir: b.rootDir ?? ".",
      previews: b.previews !== false,
    });
    return c.json(conn);
  } catch (err: any) {
    return c.json({ error: err?.message ?? "could not connect" }, 400);
  }
});

app.patch("/api/git/connections/:id", async (c) => {
  const id = idParam(c);
  if (!id) return c.json({ error: "unknown connection" }, 404);
  const b = (await jsonBody<{ previews?: boolean; branch?: string }>(c)) ?? {};
  try {
    await builds.updateConnection(id, { previews: typeof b.previews === "boolean" ? b.previews : undefined, branch: b.branch });
    return c.json({ ok: true });
  } catch (err: any) {
    return c.json({ error: err?.message }, 400);
  }
});

app.delete("/api/git/connections/:id", async (c) => {
  const id = idParam(c);
  if (!id) return c.json({ error: "unknown connection" }, 404);
  await builds.disconnect(id);
  return c.json({ ok: true });
});

app.post("/api/git/connections/:id/build", async (c) => {
  const id = idParam(c);
  if (!id) return c.json({ error: "unknown connection" }, 404);
  try {
    const b = await builds.buildHead(id);
    return c.json({ ok: true, build: b?.id ?? null, note: b ? undefined : "this commit is already being built" });
  } catch (err: any) {
    return c.json({ error: err?.message }, 502);
  }
});

app.get("/api/git/builds/:id", async (c) => {
  const id = idParam(c);
  const b = id ? await builds.getBuild(id) : null;
  if (!b) return c.json({ error: "unknown build" }, 404);
  return c.json({ ...b, log: b.log.split("\n") });
});

app.get("/", async (c) => c.html(await readFile("./public/index.html", "utf8")));
app.use("/*", serveStatic({ root: "./public" }));

serve({ fetch: app.fetch, port: 8000 });
analytics.start();
await builds.init({
  lock: runLocked,
  removeApp: async (slug, dropDatabase) => {
    await runLocked(slug, () => removeApp(slug, dropDatabase));
  },
});
console.log("nanodeploy control plane on :8000");

// wait for caddy and the docker socket proxy to settle before healing
setTimeout(() => {
  reconcile().then((n) => console.log(`reconcile: checked ${n} app(s)`));
}, 5000);
