import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import type { Context, Next } from "hono";
import AdmZip from "adm-zip";
import { readFile, rm, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseManifest } from "./manifest.js";
import * as store from "./db.js";
import * as dk from "./docker.js";
import { writeSite, removeSite } from "./caddy.js";
import * as people from "./people.js";

const APPS_DIR = process.env.APPS_DIR ?? "/srv/apps";
const TOKEN = process.env.DEPLOY_TOKEN!;
const app = new Hono();

await store.initState();
await store.migrateState();

// Two callers: the CLI with a bearer token, the browser with a tinyauth session.
// Remote-Sub can only come from caddy (it strips inbound copies at the edge), but
// caddy cannot tell a real token from a fake one, so every /api route re-checks
// here. One missing check used to let anyone bypass tinyauth with a bogus header.
const allowed = (c: Context) =>
  c.req.header("authorization") === `Bearer ${TOKEN}` || Boolean(c.req.header("remote-sub"));

app.use("/api/*", async (c: Context, next: Next) => {
  if (!allowed(c)) return c.json({ error: "unauthorized" }, 401);
  await next();
});

app.post("/api/deploy", async (c) => {

  const body = await c.req.parseBody();
  const bundle = body["bundle"];
  if (!(bundle instanceof File)) return c.json({ error: "missing bundle" }, 400);

  const zip = new AdmZip(Buffer.from(await bundle.arrayBuffer()));
  const manifestEntry = zip.getEntry("app.yaml");
  if (!manifestEntry) return c.json({ error: "app.yaml missing from bundle" }, 400);
  const manifest = parseManifest(zip.readAsText(manifestEntry));

  const dir = join(APPS_DIR, manifest.slug);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  zip.extractAllTo(dir, true);

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
    // the manifest chooses the folder, but it must stay inside the bundle
    const base = resolve(dir);
    const migrationsDir = resolve(dir, manifest.database.migrations);
    if (!migrationsDir.startsWith(base + "/")) {
      throw new Error("database.migrations must stay inside the bundle");
    }
    const applied = await store.runMigrations(migrationsDir, env.DATABASE_URL);
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
  };
  await store.upsertApp(row as any);
  await store.touchDeploy(manifest.slug);
  await writeSite((await store.getApp(manifest.slug))!);
  await dk.reloadCaddy();
  const images = await store.listApps();
  await dk
    .pruneImages(new Set(images.map((a) => a.image).filter(Boolean) as string[]))
    .catch((err) => console.error("image prune failed", err));

  return c.json({
    ok: true,
    url: `https://${manifest.slug}.${process.env.APPS_DOMAIN}`,
    log,
  });
});

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
    try {
      await writeSite(a);
      if (!a.image || !a.port) continue;
      const status = await dk.appStatus(a.slug);
      const needsRecreate = status === "missing" || (a.warm && status === "sleeping");
      if (!needsRecreate) continue;

      let image = a.image;
      if (!(await dk.imageExists(image))) {
        image = await rebuildImage(a);
        await store.upsertApp({ slug: a.slug, image } as any);
        console.log(`reconcile: rebuilt image for ${a.slug}`);
      }
      await dk.runContainer({
        slug: a.slug,
        image,
        port: a.port,
        idleTimeout: a.idle_timeout,
        warm: a.warm,
        env: a.env,
      });
      // a cold app that lost its container was asleep: put it back to sleep
      // instead of leaving it awake with no sablier session to stop it
      if (!a.warm) await dk.stopContainer(a.slug);
      console.log(`reconcile: recreated ${a.slug}`);
    } catch (err) {
      console.error(`reconcile: ${a.slug} failed`, err);
    }
  }
  if (apps.length) {
    await dk.reloadCaddy().catch(() => {});
    await dk
      .pruneImages(new Set(apps.map((a) => a.image).filter(Boolean) as string[]))
      .catch(() => {});
  }
  return apps.length;
}

app.post("/api/reconcile", async (c) => {
  return c.json({ ok: true, apps: await reconcile() });
});

app.get("/api/apps", async (c) => {
  const apps = await store.listApps();
  const withStatus = await Promise.all(
    apps.map(async (a) => ({
      slug: a.slug,
      name: a.name,
      access: a.access,
      groups: a.groups,
      hasBackend: a.port !== null,
      hasDatabase: a.db_user !== null,
      warm: a.warm,
      idleTimeout: a.idle_timeout,
      env: Object.fromEntries(Object.keys(a.env).map((k) => [k, "set"])),
      envKeys: Object.keys(a.env),
      status: a.port ? await dk.appStatus(a.slug) : "static",
      deployedAt: a.deployed_at,
    })),
  );
  return c.json({ apps: withStatus, host: await dk.hostMemory() });
});

app.post("/api/apps/:slug/access", async (c) => {
  const slug = c.req.param("slug");
  const { access, groups } = await c.req.json<{ access?: string; groups?: string[] }>();
  if (access !== "public" && access !== "private" && access !== "groups") {
    return c.json({ error: "invalid access mode" }, 400);
  }
  const cleanGroups = (groups ?? [])
    .filter((g) => typeof g === "string")
    .map((g) => g.replace(/[\r\n"\\]/g, "").trim().slice(0, 64))
    .filter((g) => g.length > 0)
    .slice(0, 32);
  if (access === "groups" && cleanGroups.length === 0) {
    return c.json({ error: "groups access requires at least one group" }, 400);
  }
  await store.setAccess(slug, access, cleanGroups);
  const updated = await store.getApp(slug);
  if (!updated) return c.json({ error: "unknown app" }, 404);
  await writeSite(updated);
  await dk.reloadCaddy();
  return c.json({ ok: true });
});

app.post("/api/apps/:slug/env", async (c) => {
  const slug = c.req.param("slug");
  const patch = await c.req.json<Record<string, string>>();
  const current = await store.getApp(slug);
  if (!current) return c.json({ error: "unknown app" }, 404);
  // keys become container env names: reject anything that could smuggle a new
  // KEY=VALUE line into the container
  const valid = Object.entries(patch).filter(
    ([k, v]) => /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(k) && typeof v === "string",
  );
  if (valid.length !== Object.keys(patch).length) {
    return c.json({ error: "invalid env key" }, 400);
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

app.delete("/api/apps/:slug", async (c) => {
  const slug = c.req.param("slug");
  await dk.removeContainer(slug);
  await removeSite(slug);
  await store.deleteApp(slug);
  await rm(join(APPS_DIR, slug), { recursive: true, force: true });
  await dk.reloadCaddy();
  const images = await store.listApps();
  await dk
    .pruneImages(new Set(images.map((a) => a.image).filter(Boolean) as string[]))
    .catch(() => {});
  // the database is kept on purpose, drop it by hand if you really mean it
  return c.json({ ok: true, note: "database kept, drop it manually if needed" });
});

app.get("/api/apps/:slug/logs", async (c) => {
  return c.json({ lines: await dk.tailLogs(c.req.param("slug")) });
});

app.post("/api/apps/:slug/wake", async (c) => {
  try {
    await dk.startContainer(c.req.param("slug"));
    return c.json({ ok: true });
  } catch (err: any) {
    return c.json({ error: err?.message ?? "failed to start container" }, 500);
  }
});

// people, proxied from Pocket ID so accounts live in one place only
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
  try {
    return c.json(await people.invite(await c.req.json()));
  } catch (err: any) {
    return c.json({ error: err.message }, 502);
  }
});

app.post("/api/people/:id/groups", async (c) => {
  const { groupIds } = await c.req.json<{ groupIds: string[] }>();
  await people.setGroups(c.req.param("id"), groupIds);
  return c.json({ ok: true });
});

app.delete("/api/people/:id", async (c) => {
  await people.removePerson(c.req.param("id"));
  return c.json({ ok: true });
});

app.post("/api/groups", async (c) => {
  const { name } = await c.req.json<{ name: string }>();
  return c.json(await people.createGroup(name));
});

app.get("/api/me", (c) =>
  c.json({
    name: c.req.header("Remote-Name") ?? c.req.header("Remote-User") ?? "",
    email: c.req.header("Remote-Email") ?? "",
    domain: process.env.APPS_DOMAIN,
  }));

app.get("/", async (c) => c.html(await readFile("./public/index.html", "utf8")));
app.use("/*", serveStatic({ root: "./public" }));

serve({ fetch: app.fetch, port: 8000 });
console.log("nanoploy control plane on :8000");

// wait for caddy and the docker socket proxy to settle before healing
setTimeout(() => {
  reconcile().then((n) => console.log(`reconcile: checked ${n} app(s)`));
}, 5000);
