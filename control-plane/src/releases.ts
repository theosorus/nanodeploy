import AdmZip from "adm-zip";
import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { existsSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readdir, readFile, readlink, rename, rm, stat, symlink } from "node:fs/promises";
import { join, relative } from "node:path";
import { parseManifest } from "./manifest.js";
import type { Manifest } from "./manifest.js";
import * as store from "./db.js";
import * as dk from "./docker.js";
import { applySite } from "./caddy.js";
import * as analytics from "./analytics.js";

// Layout of an app on disk:
//   <APPS_DIR>/<slug>/releases/<n>/   app.yaml, dist/, server.js, migrations/
//   <APPS_DIR>/<slug>/current         -> releases/<n>, swapped with one rename
// Caddy serves <slug>/current/dist. A release directory never changes once
// written, so going back to one is safe.

const APPS_DIR = process.env.APPS_DIR ?? "/srv/apps";
const STAGING_DIR = join(APPS_DIR, ".staging");
// app data in clear: outside every slug directory, so caddy never serves it
const SNAPSHOT_DIR = join(APPS_DIR, ".snapshots");

const KEEP_DIRS = 10; // releases whose files stay on disk
const KEEP_IMAGES = 3; // releases whose image stays built: instant rollback
const KEEP_SNAPSHOTS = 3; // database snapshots per app

export const MAX_BUNDLE_BYTES = 100 * 1024 * 1024;
export const MAX_BUNDLE_UNPACKED = 512 * 1024 * 1024;
export const MAX_BUNDLE_ENTRIES = 5000;

const appDir = (slug: string) => join(APPS_DIR, slug);
const releasesDir = (slug: string) => join(appDir(slug), "releases");
export const releaseDir = (slug: string, dir: number) => join(releasesDir(slug), String(dir));
const currentLink = (slug: string) => join(appDir(slug), "current");

export type Release = {
  id: string;
  slug: string;
  number: number;
  dir: number;
  source: string;
  message: string;
  commit_sha: string | null;
  commit_message: string | null;
  bundle_sha256: string;
  manifest: Manifest;
  image: string | null;
  migrations_applied: string[];
  db_snapshot: string | null;
  rollback_of: string | null;
  status: "staged" | "building" | "live" | "superseded" | "failed";
  log: string;
  created_by: string;
  created_at: string;
  finished_at: string | null;
};

export type Meta = {
  source: "upload" | "cli" | "rollback" | "legacy" | "git";
  message?: string;
  commitSha?: string;
  commitMessage?: string;
  createdBy: string;
};

const sql = store.sql;

export async function init() {
  await rm(STAGING_DIR, { recursive: true, force: true });
  await mkdir(STAGING_DIR, { recursive: true });
  await mkdir(SNAPSHOT_DIR, { recursive: true, mode: 0o700 });
}

/* ---------- rows ---------- */

export const getRelease = (id: string) =>
  sql<Release[]>`select * from releases where id = ${id}`.then((r) => r[0] ?? null);

export const listReleases = (slug: string, limit = 20) =>
  sql<Release[]>`select * from releases where slug = ${slug} order by id desc limit ${limit}`;

const liveRelease = (slug: string) =>
  sql<Release[]>`select * from releases where slug = ${slug} and status = 'live' order by id desc limit 1`.then(
    (r) => r[0] ?? null,
  );

const nextNumber = (slug: string) =>
  sql<{ n: number }[]>`select coalesce(max(number), 0) + 1 as n from releases where slug = ${slug}`.then((r) => r[0].n);

async function finish(id: string, status: Release["status"], log: string[], extra: Partial<Release> = {}) {
  await sql`
    update releases set status = ${status}, log = ${log.join("\n")}, finished_at = now(),
      image = coalesce(${extra.image ?? null}, image),
      migrations_applied = coalesce(${extra.migrations_applied ?? null}, migrations_applied),
      db_snapshot = coalesce(${extra.db_snapshot ?? null}, db_snapshot)
    where id = ${id}`;
}

/* ---------- bundle checks ---------- */

// Reads the manifest out of an uploaded zip without extracting anything.
export function readBundle(bytes: Buffer): Manifest {
  const zip = new AdmZip(bytes);
  const entries = zip.getEntries();
  if (entries.length === 0) throw new Error("empty bundle");
  if (entries.length > MAX_BUNDLE_ENTRIES) throw new Error("too many files in bundle");
  const unpacked = entries.reduce((sum, e) => sum + (e.header.size ?? 0), 0);
  if (unpacked > MAX_BUNDLE_UNPACKED) throw new Error("bundle too large");
  const manifests = entries.filter((e) => !e.isDirectory && e.entryName === "app.yaml");
  if (manifests.length !== 1) throw new Error("bundle must contain exactly one top-level app.yaml");
  return parseManifest(zip.readAsText(manifests[0]));
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

/* ---------- stage: files on disk, nothing live changes ---------- */

// A bundle becomes release <n> in its own directory, next to the live one.
// Nothing about the running app changes until promote(). One staged release per
// app at a time: a new upload replaces one that was never confirmed.
export async function stage(manifest: Manifest, bytes: Buffer, meta: Meta): Promise<Release> {
  const slug = manifest.slug;
  for (const old of await sql<{ id: string }[]>`select id from releases where slug = ${slug} and status = 'staged'`) {
    await discard(old.id);
  }
  // an old flat layout left without its database row (deleted by hand): the
  // directory is not a release tree and would be mistaken for one
  if (existsSync(appDir(slug)) && !existsSync(releasesDir(slug)) && !(await store.getApp(slug))) {
    await rm(appDir(slug), { recursive: true, force: true });
  }
  const number = await nextNumber(slug);
  const tmp = await mkdtemp(join(STAGING_DIR, `${slug}-`));
  try {
    new AdmZip(bytes).extractAllTo(tmp, true);
    // zip headers can lie about sizes: measure the extracted bundle for real
    const { bytes: size, files } = await dirStats(tmp);
    if (files > MAX_BUNDLE_ENTRIES || size > MAX_BUNDLE_UNPACKED) {
      throw new Error("bundle exceeds the unpacked size limits");
    }
    await mkdir(releasesDir(slug), { recursive: true });
    const dir = releaseDir(slug, number);
    await rm(dir, { recursive: true, force: true }); // a number freed by a discarded upload
    await rename(tmp, dir);
  } catch (err) {
    await rm(tmp, { recursive: true, force: true });
    throw err;
  }
  const [row] = await sql<Release[]>`
    insert into releases (slug, number, dir, source, message, commit_sha, commit_message,
                          bundle_sha256, manifest, status, created_by)
    values (${slug}, ${number}, ${number}, ${meta.source}, ${(meta.message ?? "").slice(0, 500)},
            ${meta.commitSha?.slice(0, 64) ?? null}, ${meta.commitMessage?.slice(0, 500) ?? null},
            ${createHash("sha256").update(bytes).digest("hex")}, ${sql.json(manifest as any)},
            'staged', ${meta.createdBy.slice(0, 120)})
    returning *`;
  return row;
}

export async function discard(id: string) {
  const r = await getRelease(id);
  if (!r || r.status !== "staged") return false;
  await sql`delete from releases where id = ${id}`;
  await rm(releaseDir(r.slug, r.dir), { recursive: true, force: true });
  return true;
}

/* ---------- what a staged release would change ---------- */

async function fileHashes(root: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!existsSync(root)) return out;
  const stack = [root];
  while (stack.length) {
    const current = stack.pop()!;
    for (const e of await readdir(current, { withFileTypes: true })) {
      const p = join(current, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) out.set(relative(root, p), createHash("sha1").update(await readFile(p)).digest("hex"));
    }
  }
  return out;
}

const sizeOf = (p: string) => stat(p).then((s) => s.size, () => null);

export type Diff = {
  slug: string;
  name: string;
  from: number | null;
  to: number;
  isNew: boolean;
  files: { added: number; removed: number; changed: number; total: number };
  server: { from: number | null; to: number | null };
  migrations: string[];
  envToSet: string[];
  envDropped: string[];
  access: { manifest: string; kept: string } | null;
  rolesAdded: string[];
  rolesRemoved: string[];
  protectChanged: boolean;
  databaseCreated: boolean;
  backend: "added" | "removed" | null;
  warm: { from: boolean; to: boolean } | null;
};

export async function diff(r: Release): Promise<Diff> {
  const m = r.manifest;
  const app = await store.getApp(r.slug);
  const live = await liveRelease(r.slug);
  const dir = releaseDir(r.slug, r.dir);
  const liveDir = live ? releaseDir(r.slug, live.dir) : null;
  const [next, prev] = await Promise.all([fileHashes(join(dir, "dist")), liveDir ? fileHashes(join(liveDir, "dist")) : new Map()]);
  let added = 0;
  let changed = 0;
  for (const [p, h] of next) {
    if (!prev.has(p)) added++;
    else if (prev.get(p) !== h) changed++;
  }
  const removed = [...prev.keys()].filter((p) => !next.has(p)).length;
  const lm = live?.manifest ?? null;
  const url = app?.db_user && app.db_password ? store.databaseUrl(app.db_user, app.db_password) : null;
  return {
    slug: r.slug,
    name: m.name,
    from: live?.number ?? null,
    to: r.number,
    isNew: !app,
    files: { added, removed, changed, total: next.size },
    server: {
      from: lm?.backend && liveDir ? await sizeOf(join(liveDir, lm.backend.entry)) : null,
      to: m.backend ? await sizeOf(join(dir, m.backend.entry)) : null,
    },
    migrations: m.database.enabled ? await store.pendingMigrations(join(dir, m.database.migrations), url).catch(() => []) : [],
    envToSet: m.env.filter((k) => !app?.env?.[k]),
    envDropped: (app?.declared_env ?? []).filter((k) => !m.env.includes(k)),
    access: app && app.access !== m.access ? { manifest: m.access, kept: app.access } : null,
    rolesAdded: m.roles.filter((x) => !(app?.roles ?? []).includes(x)),
    rolesRemoved: (app?.roles ?? []).filter((x) => !m.roles.includes(x)),
    protectChanged: Boolean(app) && JSON.stringify(app!.protect ?? []) !== JSON.stringify(m.protect),
    databaseCreated: m.database.enabled && !app?.db_user,
    backend: lm && !lm.backend && m.backend ? "added" : lm?.backend && !m.backend ? "removed" : null,
    warm: app && m.backend && app.warm !== (app.warm_override ?? m.idle.warm)
      ? { from: app.warm, to: app.warm_override ?? m.idle.warm } : null,
  };
}

/* ---------- going live ---------- */

// Points <slug>/current at a release directory with one rename: caddy never
// sees a missing or half-written tree.
async function pointCurrent(slug: string, dir: number) {
  const link = currentLink(slug);
  const tmp = `${link}.next-${process.pid}-${Date.now()}`;
  await symlink(join("releases", String(dir)), tmp);
  await rename(tmp, link);
}

async function hostResolves(host: string) {
  try {
    await lookup(host);
    return true;
  } catch {
    return false;
  }
}

async function snapshot(slug: string, db: string, release: number) {
  await mkdir(join(SNAPSHOT_DIR, slug), { recursive: true, mode: 0o700 });
  const file = join(SNAPSHOT_DIR, slug, `r${release}-${Date.now()}.dump`);
  await dk.dumpDatabase(db, file);
  return file;
}

// The running container is stopped for the restore: pg_restore --clean must
// drop the tables the app is using. A warm app is started again afterwards.
async function restore(slug: string, db: string, file: string, restart: boolean) {
  analytics.quiet(slug, 120_000);
  await dk.stopContainer(slug);
  await store.disconnectDatabase(db);
  await dk.restoreDatabase(db, file);
  if (restart) await dk.startContainer(slug).catch(() => {});
}

export type Outcome = { ok: true; url: string; log: string[]; release: number };

// Labels cannot be changed on a Docker container. Replace it and the route
// together, then commit the override; reconcile heals an interrupted change
// from the database, including mismatched labels and restart policies.
export async function replaceWarm(current: store.AppRow, warm: boolean) {
  if (!current.image || !current.port) throw new Error("static apps are already always available");
  if (current.warm === warm) {
    await store.upsertApp({ slug: current.slug, warm_override: warm });
    return;
  }
  const next = { ...current, warm, warm_override: warm };
  const run = async (app: store.AppRow) => {
    await dk.runContainer({ slug: app.slug, image: app.image!, port: app.port!,
      idleTimeout: app.idle_timeout, warm: app.warm, env: app.env });
    if (!app.warm) {
      // Sablier only stops containers it woke itself: a replacement must sleep
      // until the next request creates a new session.
      await dk.stopContainer(app.slug);
      if (await dk.appStatus(app.slug) !== "sleeping") throw new Error("failed to put app to sleep");
    }
  };
  let routeTouched = false;
  analytics.quiet(current.slug);
  try {
    await run(next);
    routeTouched = true;
    if (!(await applySite(next))) throw new Error("caddy refused the new availability setting");
    await store.upsertApp({ slug: current.slug, warm, warm_override: warm });
  } catch (err) {
    try { await run(current); }
    catch (recoveryError) { console.error(`availability backend recovery failed for ${current.slug}`, recoveryError); }
    if (routeTouched) {
      try {
        if (!(await applySite(current))) throw new Error("caddy refused recovery");
      } catch (recoveryError) { console.error(`availability route recovery failed for ${current.slug}`, recoveryError); }
    }
    throw err;
  }
  // The intentional restart was muted above; keep the awake timeline correct.
  await analytics.recordEvent(current.slug, warm ? "wake" : "sleep", { source: "settings" })
    .catch((err) => console.error("availability event failed", err));
}

// Builds, migrates and switches to a staged release. Must run under the app's
// lock. Until the "current" link moves, the live version is untouched: a build
// that fails or a migration that fails leaves the app as it was, and a failed
// migration puts the database back from the snapshot taken just before.
export async function promote(id: string): Promise<Outcome> {
  const r = await getRelease(id);
  if (!r || r.status !== "staged") throw new Error("this release is not waiting to go live");
  const m = r.manifest;
  const slug = r.slug;
  const dir = releaseDir(slug, r.dir);
  const log: string[] = [];
  await sql`update releases set status = 'building' where id = ${id}`;
  const previous = await store.getApp(slug);
  const warm = previous?.warm_override ?? m.idle.warm;
  let swapped = false;
  let snapshotFile: string | null = null;
  let applied: string[] = [];

  try {
    const env: Record<string, string> = {};
    for (const key of m.env) {
      const value = previous?.env?.[key];
      if (value) env[key] = value;
      else log.push(`env ${key} is declared but not set yet, set it in the dashboard`);
    }

    // The manifest only sets the access mode of a new app; after that the
    // dashboard owns it.
    let access = m.access;
    let groups = m.groups;
    if (previous) {
      access = previous.access as typeof access;
      groups = previous.groups;
      const sameGroups =
        previous.groups.length === m.groups.length && previous.groups.every((g) => m.groups.includes(g));
      if (previous.access !== m.access || (m.access === "groups" && !sameGroups)) {
        log.push(
          `access kept as "${previous.access}" (set in the dashboard), app.yaml says ` +
            `"${m.access}": change it in the dashboard if you meant it`,
        );
      }
    }

    // the image first: a build that fails must not leave the database migrated
    // for code that never shipped
    let image: string | null = previous?.image ?? null;
    if (m.backend) {
      image = await dk.buildImage(dir, dk.imageTag(slug, r.dir), m.backend.entry, m.backend.port);
      log.push(`image ${image} built`);
    }

    let dbUser = previous?.db_user ?? null;
    let dbPassword = previous?.db_password ?? null;
    if (m.database.enabled) {
      const existed = Boolean(previous?.db_user);
      const creds = await store.provisionDatabase(slug);
      dbUser = creds.user;
      dbPassword = creds.password;
      env.DATABASE_URL = store.databaseUrl(creds.user, creds.password);
      const migrationsDir = join(dir, m.database.migrations);
      const pending = await store.pendingMigrations(migrationsDir, env.DATABASE_URL);
      if (pending.length && existed) {
        snapshotFile = await snapshot(slug, creds.user, r.number);
        log.push(`database snapshot taken before migrating`);
      }
      try {
        applied = await store.runMigrations(migrationsDir, env.DATABASE_URL);
      } catch (err: any) {
        if (snapshotFile) {
          await restore(slug, creds.user, snapshotFile, Boolean(previous?.warm));
          throw new Error(`migration failed (${err?.message ?? err}); the database was restored from the snapshot taken just before`);
        }
        throw new Error(`migration failed: ${err?.message ?? err}`);
      }
      log.push(applied.length ? `applied ${applied.length} migration(s): ${applied.join(", ")}` : "no new migrations");
    }

    if (m.backend && image) {
      analytics.quiet(slug);
      await dk.runContainer({ slug, image, port: m.backend.port, idleTimeout: m.idle.timeout, warm, env });
      // a cold app goes straight back to sleep: a running container sablier did
      // not start would have no session and never scale back down on its own
      if (!warm) await dk.stopContainer(slug);
      log.push(`backend container ${dk.containerName(slug)} created`);
    } else if (previous?.port) {
      // the backend was dropped from the manifest
      await dk.removeContainer(slug);
    }

    await pointCurrent(slug, r.dir);
    swapped = true;

    await store.upsertApp({
      slug,
      name: m.name,
      access,
      groups,
      port: m.backend?.port ?? null,
      idle_timeout: m.idle.timeout,
      warm,
      db_user: dbUser,
      db_password: dbPassword,
      env,
      image: m.backend ? image : null,
      declared_env: m.env,
      roles: m.roles,
      protect: m.protect,
    } as any);
    await sql`update apps set current_release = ${id}, deployed_at = now() where slug = ${slug}`;
    await sql`update releases set status = 'superseded' where slug = ${slug} and status = 'live'`;

    const routed = await applySite((await store.getApp(slug))!);
    log.push(routed ? "caddy route is live" : "WARNING: caddy refused the new route and the previous config was restored, the app is not reachable");
    const host = `${slug}.${process.env.APPS_DOMAIN}`;
    if (!(await hostResolves(host))) {
      log.push(
        `WARNING: ${host} does not resolve. The app is running but nothing on the internet can reach it: ` +
          `add a wildcard *.${process.env.APPS_DOMAIN} hostname to your tunnel or DNS zone.`,
      );
    }
    log.push(`release ${r.number} is live`);
    await finish(id, "live", log, { image, migrations_applied: applied, db_snapshot: snapshotFile });
    await analytics.markDeploy(slug, r.number, Boolean(m.backend && warm));
    await prune(slug);
    return { ok: true, url: `https://${host}`, log, release: r.number };
  } catch (err: any) {
    log.push(`FAILED: ${err?.message ?? err}`);
    log.push(swapped ? "the new files were already live when this failed" : "the running version was left untouched");
    await finish(id, "failed", log, { migrations_applied: applied, db_snapshot: snapshotFile });
    if (!swapped) await rm(dir, { recursive: true, force: true });
    await prune(slug).catch(() => {});
    const e = new Error(err?.message ?? String(err)) as Error & { log: string[]; untouched: boolean };
    e.log = log;
    e.untouched = !swapped;
    throw e;
  }
}

/* ---------- rollback ---------- */

export type RollbackInfo = {
  // releases after the target applied these migrations: the old code will meet
  // a database ahead of it
  migrationsAhead: string[];
  // the snapshot to restore for "code and database", if one is still kept
  snapshot: string | null;
  // files still on disk: a rollback is possible at all
  filesKept: boolean;
};

export async function rollbackInfo(target: Release, history: Release[]): Promise<RollbackInfo> {
  // oldest first, so the migrations read in the order they were applied
  const later = history
    .filter((h) => Number(h.id) > Number(target.id) && h.status !== "failed" && h.status !== "staged")
    .sort((a, b) => Number(a.id) - Number(b.id));
  const migrationsAhead = [...new Set(later.flatMap((h) => h.migrations_applied))];
  // the earliest later release that migrated: its snapshot is the database as
  // the target release left it (plus whatever was written in between)
  const first = later.find((h) => h.migrations_applied.length > 0);
  const snapshot = first?.db_snapshot && existsSync(first.db_snapshot) ? first.db_snapshot : null;
  return { migrationsAhead, snapshot, filesKept: existsSync(join(releaseDir(target.slug, target.dir), "app.yaml")) };
}

// Makes an older release live again, as a new release (source "rollback") that
// reuses the old one's directory and image. With withDatabase, the database is
// put back as it was before the first migration that came after the target:
// everything written since is lost, which the dashboard says before asking.
export async function rollback(slug: string, targetId: string, withDatabase: boolean, createdBy: string): Promise<Outcome> {
  const target = await getRelease(targetId);
  if (!target || target.slug !== slug) throw new Error("unknown release");
  if (target.status === "failed" || target.status === "staged") throw new Error("only a release that went live can be restored");
  const live = await liveRelease(slug);
  if (live && live.dir === target.dir && !withDatabase) throw new Error("this release is already live");
  const history = await listReleases(slug, 500);
  const info = await rollbackInfo(target, history);
  if (!info.filesKept) throw new Error("the files of this release were cleaned up, it cannot be restored");
  if (withDatabase && !info.snapshot) throw new Error("no database snapshot is kept for this rollback");

  const m = target.manifest;
  const app = await store.getApp(slug);
  if (!app) throw new Error("unknown app");
  const warm = app.warm_override ?? m.idle.warm;
  const dir = releaseDir(slug, target.dir);
  const log: string[] = [`restoring release ${target.number}`];

  let image: string | null = null;
  if (m.backend) {
    image = target.image ?? dk.imageTag(slug, target.dir);
    if (!(await dk.imageExists(image))) {
      image = await dk.buildImage(dir, dk.imageTag(slug, target.dir), m.backend.entry, m.backend.port);
      log.push(`image ${image} rebuilt from the release files`);
    }
  }
  if (withDatabase && app.db_user) {
    await restore(slug, app.db_user, info.snapshot!, false);
    log.push("database restored from the snapshot taken before the next migration");
  } else if (info.migrationsAhead.length) {
    log.push(`database kept as is: it already has ${info.migrationsAhead.join(", ")}, which this code does not know`);
  }

  const env: Record<string, string> = {};
  for (const key of m.env) if (app.env?.[key]) env[key] = app.env[key];
  if (app.env?.DATABASE_URL) env.DATABASE_URL = app.env.DATABASE_URL;

  if (m.backend && image) {
    analytics.quiet(slug);
    await dk.runContainer({ slug, image, port: m.backend.port, idleTimeout: m.idle.timeout, warm, env });
    if (!warm) await dk.stopContainer(slug);
  } else {
    await dk.removeContainer(slug);
  }
  await pointCurrent(slug, target.dir);

  const number = await nextNumber(slug);
  const [row] = await sql<Release[]>`
    insert into releases (slug, number, dir, source, message, commit_sha, commit_message, bundle_sha256,
                          manifest, image, rollback_of, status, created_by, finished_at)
    values (${slug}, ${number}, ${target.dir}, 'rollback',
            ${`back to release ${target.number}` + (withDatabase ? ", with its database" : "")},
            ${target.commit_sha}, ${target.commit_message}, ${target.bundle_sha256}, ${sql.json(m as any)},
            ${image}, ${target.id}, 'building', ${createdBy.slice(0, 120)}, now())
    returning *`;
  await store.upsertApp({
    slug,
    name: m.name,
    port: m.backend?.port ?? null,
    idle_timeout: m.idle.timeout,
    warm,
    env,
    image,
    declared_env: m.env,
    roles: m.roles,
    protect: m.protect,
  } as any);
  await sql`update apps set current_release = ${row.id}, deployed_at = now() where slug = ${slug}`;
  await sql`update releases set status = 'superseded' where slug = ${slug} and status = 'live'`;
  const routed = await applySite((await store.getApp(slug))!);
  if (!routed) log.push("WARNING: caddy refused the route, the previous config was kept");
  log.push(`release ${number} is live (files of release ${target.number})`);
  await finish(row.id, "live", log, { image });
  await analytics.markDeploy(slug, number, Boolean(m.backend && warm));
  await prune(slug);
  return { ok: true, url: `https://${slug}.${process.env.APPS_DOMAIN}`, log, release: number };
}

/* ---------- retention ---------- */

// Keeps the files of the last KEEP_DIRS releases, the images of the last
// KEEP_IMAGES, the last KEEP_SNAPSHOTS database snapshots, and always whatever
// is live. Everything else goes: a 4 GB box does not keep history forever.
export async function prune(slug: string) {
  const rows = await listReleases(slug, 500);
  const usable = rows.filter((r) => r.status === "live" || r.status === "superseded");
  const live = rows.find((r) => r.status === "live");
  const staged = rows.filter((r) => r.status === "staged" || r.status === "building");

  const keepDirs = new Set([...usable.slice(0, KEEP_DIRS), ...staged, ...(live ? [live] : [])].map((r) => r.dir));
  if (existsSync(releasesDir(slug))) {
    for (const name of await readdir(releasesDir(slug))) {
      if (!keepDirs.has(Number(name))) await rm(join(releasesDir(slug), name), { recursive: true, force: true });
    }
  }

  const snaps = rows.filter((r) => r.db_snapshot).sort((a, b) => Number(b.id) - Number(a.id));
  for (const r of snaps.slice(KEEP_SNAPSHOTS)) {
    await rm(r.db_snapshot!, { force: true });
    await sql`update releases set db_snapshot = null where id = ${r.id}`;
  }

  await dk.pruneImages(await imagesToKeep()).catch((err) => console.error("image prune failed", err));
}

// across every app: pruneImages removes any nanodeploy image not listed
export async function imagesToKeep(): Promise<Set<string>> {
  const keep = new Set<string>();
  for (const a of await store.listApps()) if (a.image) keep.add(a.image);
  const rows = await sql<{ image: string; slug: string }[]>`
    select image, slug from (
      select image, slug, row_number() over (partition by slug order by id desc) as rank
      from releases where image is not null and status in ('live', 'superseded', 'building', 'staged')
    ) ranked where rank <= ${KEEP_IMAGES}`;
  for (const r of rows) keep.add(r.image);
  return keep;
}

export async function deleteAll(slug: string) {
  await sql`delete from releases where slug = ${slug}`;
  await rm(join(SNAPSHOT_DIR, slug), { recursive: true, force: true });
}

/* ---------- installs from before releases ---------- */

// An app deployed before releases existed lives flat in <slug>/. Move it into
// releases/1 and point "current" at it, once. A "dist" link is left at the old
// place so the route caddy runs right now keeps working until it reloads.
export async function adoptLegacy(app: store.AppRow) {
  const root = appDir(app.slug);
  const isLink = await lstat(currentLink(app.slug)).then((s) => s.isSymbolicLink(), () => false);
  if (isLink || !existsSync(join(root, "app.yaml"))) return false;
  const entries = (await readdir(root)).filter((e) => e !== "releases");
  await mkdir(join(root, "releases", "1"), { recursive: true });
  for (const e of entries) await rename(join(root, e), join(root, "releases", "1", e));
  await pointCurrent(app.slug, 1);
  await symlink(join("current", "dist"), join(root, "dist")).catch(() => {});
  const manifest = parseManifest(await readFile(join(root, "releases", "1", "app.yaml"), "utf8"));
  const exists = await sql`select 1 from releases where slug = ${app.slug}`;
  if (!exists.length) {
    const [row] = await sql<{ id: string }[]>`
      insert into releases (slug, number, dir, source, message, manifest, image, status, created_by, finished_at, created_at)
      values (${app.slug}, 1, 1, 'legacy', 'deployed before versions existed', ${sql.json(manifest as any)},
              ${app.image}, 'live', 'platform', now(), ${app.deployed_at})
      returning id`;
    await sql`update apps set current_release = ${row.id} where slug = ${app.slug}`;
  }
  console.log(`releases: ${app.slug} moved to the release layout as release 1`);
  return true;
}

// the directory the live version is served from, for a rebuild after a wiped
// docker data-root
export async function liveDir(slug: string): Promise<string> {
  const target = await readlink(currentLink(slug)).catch(() => null);
  return target ? join(appDir(slug), target) : appDir(slug);
}

