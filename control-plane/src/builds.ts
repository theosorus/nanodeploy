import AdmZip from "adm-zip";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { chown, lstat, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { join, posix, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import tar from "tar-fs";
import { parseDocument } from "yaml";
import * as store from "./db.js";
import * as dk from "./docker.js";
import * as forges from "./forges.js";
import type { GitEvent, ProviderRow } from "./forges.js";
import { parseManifest } from "./manifest.js";
import type { Manifest } from "./manifest.js";
import * as releases from "./releases.js";
import * as secrets from "./secrets.js";

// Deploys from GitHub and GitLab. A push to the connected branch, or a pull
// request against it, queues a build. One build runs at a time on the whole
// machine: the archive of the commit is downloaded by the control plane (the
// forge token never enters the build), built in a throwaway container on its
// own network, and the result goes through the same release pipeline as a
// dropped zip.

const sql = store.sql;
const APPS_DIR = process.env.APPS_DIR ?? "/srv/apps";
// the same directory as seen by the docker daemon, for the build's bind mount
const HOST_APPS_DIR = process.env.HOST_APPS_DIR || APPS_DIR;
const BUILD_DIR = join(APPS_DIR, ".builds");
const BUILD_TIMEOUT = Number(process.env.BUILD_TIMEOUT_MINUTES ?? 10) * 60_000;
const PREVIEW_TTL_DAYS = 14;

const DOMAIN = process.env.APPS_DOMAIN!;
const SCHEME = process.env.PUBLIC_SCHEME === "http" ? "http" : "https";
const PORT = process.env.PUBLIC_PORT ? `:${process.env.PUBLIC_PORT}` : "";
export const CONSOLE_ORIGIN = `${SCHEME}://deploy.${DOMAIN}${PORT}`;
const appUrl = (slug: string) => `${SCHEME}://${slug}.${DOMAIN}${PORT}/`;
export const previewSlug = (slug: string, pr: number) => `${slug}--pr-${pr}`;

type Hooks = {
  lock: <T>(slug: string, fn: () => Promise<T>) => Promise<T>;
  removeApp: (slug: string, dropDatabase: boolean) => Promise<void>;
};
let hooks: Hooks;

export async function init(h: Hooks) {
  hooks = h;
  await sql`
    create table if not exists git_providers (
      id bigserial primary key,
      kind text not null check (kind in ('github', 'gitlab')),
      name text not null,
      config jsonb not null default '{}',
      secret_enc text not null,
      webhook_secret_enc text not null,
      created_at timestamptz not null default now()
    )`;
  await sql`
    create table if not exists git_connections (
      id bigserial primary key,
      provider_id bigint not null references git_providers(id),
      repo text not null,
      repo_id text not null,
      branch text not null,
      root_dir text not null default '.',
      slug text not null unique,
      previews boolean not null default true,
      created_at timestamptz not null default now()
    )`;
  await sql`
    create table if not exists builds (
      id bigserial primary key,
      connection_id bigint not null,
      kind text not null check (kind in ('production', 'preview')),
      target_slug text not null,
      ref text not null,
      sha text not null,
      pr int,
      message text not null default '',
      author text not null default '',
      status text not null,
      release int,
      log text not null default '',
      created_at timestamptz not null default now(),
      started_at timestamptz,
      finished_at timestamptz
    )`;
  await sql`create index if not exists builds_recent on builds (id desc)`;
  await sql`
    create table if not exists webhook_deliveries (
      id text primary key,
      received_at timestamptz not null default now()
    )`;
  await sql`alter table apps add column if not exists preview_of text`;
  await sql`alter table apps add column if not exists preview_pr int`;
  await sql`alter table apps add column if not exists preview_comment text`;
  // a build cut short by a restart cannot resume: say so, and keep the queue
  await sql`update builds set status = 'failed', finished_at = now(),
    log = log || ${"\ninterrupted: the control plane restarted during this build"} where status = 'running'`;
  await rm(BUILD_DIR, { recursive: true, force: true });
  await mkdir(BUILD_DIR, { recursive: true });
  setInterval(() => sweep().catch((err) => console.error("preview sweep failed", err)), 6 * 3_600_000).unref();
  setTimeout(() => void kick(), 3000);
}

/* ---------- providers ---------- */

const providerCols = sql`id, kind, name, config, secret_enc, webhook_secret_enc`;

export const listProviders = () => sql<ProviderRow[]>`select ${providerCols} from git_providers order by id`;
export const getProvider = (id: string) =>
  sql<ProviderRow[]>`select ${providerCols} from git_providers where id = ${id}`.then((r) => r[0] ?? null);

export async function addGithub(app: { id: string; slug: string; htmlUrl: string; pem: string; webhookSecret: string }) {
  const [row] = await sql<{ id: string }[]>`
    insert into git_providers (kind, name, config, secret_enc, webhook_secret_enc)
    values ('github', ${app.slug}, ${sql.json({ appId: app.id, htmlUrl: app.htmlUrl })},
            ${secrets.seal(app.pem)}, ${secrets.seal(app.webhookSecret)})
    returning id`;
  return row.id;
}

export async function addGitlab(project: string, token: string) {
  const hookSecret = randomBytes(24).toString("hex");
  const [row] = await sql<{ id: string }[]>`
    insert into git_providers (kind, name, config, secret_enc, webhook_secret_enc)
    values ('gitlab', ${project}, '{}', ${secrets.seal(token)}, ${secrets.seal(hookSecret)}) returning id`;
  try {
    const info = await forges.gitlabConnect(project, token, `${CONSOLE_ORIGIN}/hooks/gitlab/${row.id}`, hookSecret);
    await sql`update git_providers set name = ${info.path}, config = ${sql.json(info)} where id = ${row.id}`;
    return row.id;
  } catch (err) {
    await sql`delete from git_providers where id = ${row.id}`;
    throw err;
  }
}

export async function removeProvider(id: string) {
  const p = await getProvider(id);
  if (!p) throw new Error("unknown provider");
  const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from git_connections where provider_id = ${id}`;
  if (n > 0) throw new Error("disconnect its repositories first");
  if (p.kind === "gitlab") await forges.gitlabDisconnect(p).catch(() => {});
  await sql`delete from git_providers where id = ${id}`;
}

/* ---------- connections ---------- */

export type Connection = {
  id: string;
  provider_id: string;
  repo: string;
  repo_id: string;
  branch: string;
  root_dir: string;
  slug: string;
  previews: boolean;
};

export const listConnections = () => sql<Connection[]>`select * from git_connections order by slug`;
export const getConnection = (id: string) =>
  sql<Connection[]>`select * from git_connections where id = ${id}`.then((r) => r[0] ?? null);

const ROOT_RE = /^(\.|[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*)$/;
const BRANCH_RE = /^[A-Za-z0-9._\/-]{1,200}$/;

// Ties a repository branch to one app, named by the app.yaml found there. A
// later push that changes the slug in app.yaml fails its build instead of
// landing on another app.
export async function connect(input: { providerId: string; repoId: string; branch: string; rootDir: string; previews: boolean }) {
  const p = await getProvider(input.providerId);
  if (!p) throw new Error("unknown provider");
  if (!BRANCH_RE.test(input.branch) || input.branch.includes("..")) throw new Error("invalid branch name");
  const rootDir = input.rootDir.replace(/^\.\/|\/$/g, "") || ".";
  if (!ROOT_RE.test(rootDir) || rootDir.split("/").includes("..")) throw new Error("invalid root directory");
  const forge = forges.forgeOf(p);
  const repo = (await forge.repos()).find((r) => r.id === input.repoId);
  if (!repo) throw new Error("this repository is not available to the connection");
  const raw = await forge.file(repo.fullName, input.branch, rootDir === "." ? "app.yaml" : `${rootDir}/app.yaml`);
  if (!raw) throw new Error(`no app.yaml in ${rootDir === "." ? "the repository root" : rootDir} on ${input.branch}`);
  const manifest = parseManifest(raw);
  const [row] = await sql<Connection[]>`
    insert into git_connections (provider_id, repo, repo_id, branch, root_dir, slug, previews)
    values (${p.id}, ${repo.fullName}, ${repo.id}, ${input.branch}, ${rootDir}, ${manifest.slug}, ${input.previews})
    on conflict (slug) do nothing returning *`;
  if (!row) throw new Error(`the app ${manifest.slug} is already deployed from a repository`);
  await buildHead(row.id);
  return row;
}

export async function updateConnection(id: string, patch: { previews?: boolean; branch?: string }) {
  if (patch.branch !== undefined && (!BRANCH_RE.test(patch.branch) || patch.branch.includes(".."))) throw new Error("invalid branch name");
  await sql`update git_connections set
    previews = coalesce(${patch.previews ?? null}, previews),
    branch = coalesce(${patch.branch ?? null}, branch) where id = ${id}`;
}

// The app stays; its previews go, and nothing will rebuild it any more.
export async function disconnect(id: string) {
  const c = await getConnection(id);
  if (!c) return;
  for (const p of await sql<{ slug: string }[]>`select slug from apps where preview_of = ${c.slug}`) {
    await hooks.removeApp(p.slug, true);
  }
  await sql`update builds set status = 'skipped', finished_at = now() where connection_id = ${id} and status = 'queued'`;
  await sql`delete from git_connections where id = ${id}`;
}

// "Build now": the head of the connected branch, as if it had just been pushed.
export async function buildHead(id: string) {
  const c = await getConnection(id);
  if (!c) throw new Error("unknown connection");
  const p = (await getProvider(c.provider_id))!;
  const head = await forges.forgeOf(p).head(c.repo, c.branch);
  return enqueue(c, { kind: "production", ref: c.branch, sha: head.sha, pr: null, message: head.message, author: head.author });
}

/* ---------- queue ---------- */

export type Build = {
  id: string;
  connection_id: string;
  kind: "production" | "preview";
  target_slug: string;
  ref: string;
  sha: string;
  pr: number | null;
  message: string;
  author: string;
  status: "queued" | "running" | "succeeded" | "failed" | "skipped";
  release: number | null;
  log: string;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
};

export const listBuilds = (limit = 30) =>
  sql<Build[]>`select id, connection_id, kind, target_slug, ref, sha, pr, message, author, status, release,
    created_at, started_at, finished_at, '' as log from builds order by id desc limit ${limit}`;
export const getBuild = (id: string) => sql<Build[]>`select * from builds where id = ${id}`.then((r) => r[0] ?? null);

async function enqueue(c: Connection, b: { kind: Build["kind"]; ref: string; sha: string; pr: number | null; message: string; author: string }) {
  if (!/^[0-9a-f]{7,64}$/i.test(b.sha)) throw new Error("invalid commit id");
  const target = b.kind === "preview" ? previewSlug(c.slug, b.pr!) : c.slug;
  // the same commit twice (a re-delivered webhook, a double click)
  const same = await sql`select 1 from builds where target_slug = ${target} and sha = ${b.sha} and status in ('queued', 'running')`;
  if (same.length) return null;
  // only the newest commit of a target is worth building
  await sql`update builds set status = 'skipped', finished_at = now(), log = 'a newer commit was pushed before this one started'
    where target_slug = ${target} and status = 'queued'`;
  const [row] = await sql<Build[]>`
    insert into builds (connection_id, kind, target_slug, ref, sha, pr, message, author, status)
    values (${c.id}, ${b.kind}, ${target}, ${b.ref}, ${b.sha}, ${b.pr}, ${b.message.slice(0, 500)}, ${b.author.slice(0, 120)}, 'queued')
    returning *`;
  const p = (await getProvider(c.provider_id))!;
  await forges.forgeOf(p).status(c.repo, b.sha, "pending", CONSOLE_ORIGIN + "/", "queued on nanodeploy").catch(() => {});
  void kick();
  return row;
}

let busy = false;
async function kick() {
  if (busy) return;
  busy = true;
  try {
    for (;;) {
      const [next] = await sql<Build[]>`select * from builds where status = 'queued' order by id limit 1`;
      if (!next) break;
      await run(next);
    }
  } catch (err) {
    console.error("build queue failed", err);
  } finally {
    busy = false;
  }
}

/* ---------- one build ---------- */

async function chownTree(dir: string) {
  await chown(dir, 1000, 1000);
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) await chownTree(p);
    else await chown(p, 1000, 1000).catch(() => {});
  }
}

// a 4 GB machine serving apps: wait for some room rather than push them into swap
async function waitForMemory(say: (s: string) => void) {
  for (let i = 0; i < 30; i++) {
    const { available } = await dk.hostMemory();
    if (!available || available > 1.2e9) return;
    if (i === 0) say(`waiting for memory: ${Math.round(available / 1e6)} MB available, 1200 MB wanted`);
    await new Promise((r) => setTimeout(r, 10_000));
  }
}

let cacheReady = false;

async function run(b: Build) {
  const lines: string[] = [];
  const say = (s: string) => lines.push(`[${new Date().toISOString().slice(11, 19)}] ${s}`);
  const save = (status: Build["status"], extra: { release?: number } = {}) =>
    sql`update builds set status = ${status}, log = ${lines.join("\n").slice(-200_000)},
      release = coalesce(${extra.release ?? null}, release),
      finished_at = ${status === "running" ? null : new Date()} where id = ${b.id}`;
  await sql`update builds set status = 'running', started_at = now() where id = ${b.id}`;
  const c = await getConnection(b.connection_id);
  const p = c ? await getProvider(c.provider_id) : null;
  if (!c || !p) {
    say("the repository was disconnected");
    await save("skipped");
    return;
  }
  const forge = forges.forgeOf(p);
  const work = join(BUILD_DIR, String(b.id));
  const src = join(work, "src");
  try {
    say(`${c.repo}@${b.sha.slice(0, 7)} ${b.kind === "preview" ? `(pull request #${b.pr})` : `(${b.ref})`} for ${b.target_slug}`);
    const archive = await forge.archive(c.repo, b.sha);
    say(`archive downloaded, ${Math.round(archive.length / 1024)} KB`);
    await mkdir(src, { recursive: true });
    await pipeline(
      Readable.from(archive),
      createGunzip(),
      // forges wrap the tree in one top directory; links are left out, paths
      // are kept inside the workspace by tar-fs, owners are not taken from it
      tar.extract(src, { strip: 1, chown: false, ignore: (_name: string, h: any) => h.type !== "file" && h.type !== "directory" } as any),
    );
    const root = resolve(src, c.root_dir);
    if (root !== src && !root.startsWith(src + "/")) throw new Error("root directory escapes the repository");
    const rawManifest = await readFile(join(root, "app.yaml"), "utf8").catch(() => null);
    if (rawManifest === null) throw new Error(`no app.yaml in ${c.root_dir}`);
    let manifest = parseManifest(rawManifest);
    if (manifest.slug !== c.slug) {
      throw new Error(`app.yaml says "${manifest.slug}", this repository deploys "${c.slug}": change it back or connect the repository again`);
    }

    const hasPkg = existsSync(join(root, "package.json"));
    const install = manifest.build.install ?? (existsSync(join(root, "package-lock.json")) ? "npm ci --no-audit --no-fund" : hasPkg ? "npm install --no-audit --no-fund" : "");
    const command = hasPkg || manifest.build.command !== "npm run build" ? manifest.build.command : "";
    if (install || command) {
      await waitForMemory(say);
      await dk.ensureImage(manifest.build.image, say);
      if (!cacheReady) {
        await dk.prepareBuildCache(manifest.build.image);
        cacheReady = true;
      }
      await chownTree(src);
      const script = ["set -e", install && `echo "$ ${install.replace(/"/g, '\\"')}"`, install, command && `echo "$ ${command.replace(/"/g, '\\"')}"`, command]
        .filter(Boolean)
        .join("\n");
      say(`building in ${manifest.build.image}`);
      const out = await dk.runBuilder({
        name: `nanodeploy-build-${b.id}`,
        image: manifest.build.image,
        hostWork: join(HOST_APPS_DIR, ".builds", String(b.id), "src"),
        workdir: posix.join("/work", c.root_dir),
        command: script,
        timeoutMs: BUILD_TIMEOUT,
      });
      for (const l of out.logs.split("\n")) if (l) lines.push(l);
      if (out.timedOut) throw new Error(`the build took more than ${BUILD_TIMEOUT / 60_000} minutes`);
      if (out.exitCode !== 0) throw new Error(`the build exited with code ${out.exitCode}`);
    } else {
      say("nothing to build: no package.json, the files are deployed as they are");
    }

    // the same files a local "npm run deploy" puts in its zip
    let yamlText = rawManifest;
    if (b.kind === "preview") {
      const doc = parseDocument(rawManifest);
      doc.set("slug", b.target_slug);
      doc.set("name", `${manifest.name} · #${b.pr}`.slice(0, 60));
      doc.set("access", "private");
      yamlText = doc.toString();
      manifest = parseManifest(yamlText);
    }
    const zip = new AdmZip();
    zip.addFile("app.yaml", Buffer.from(yamlText));
    if (manifest.frontend) {
      if (!existsSync(join(root, "dist"))) throw new Error("no dist/ after the build: the frontend must be built into dist/");
      zip.addLocalFolder(join(root, "dist"), "dist");
    }
    if (manifest.backend) {
      const entry = join(root, manifest.backend.entry);
      if (!(await lstat(entry).then((s) => s.isFile(), () => false))) throw new Error(`no ${manifest.backend.entry} after the build`);
      zip.addLocalFile(entry, posix.dirname(manifest.backend.entry) === "." ? "" : posix.dirname(manifest.backend.entry));
    }
    if (manifest.database.enabled && existsSync(join(root, manifest.database.migrations))) {
      zip.addLocalFolder(join(root, manifest.database.migrations), posix.normalize(manifest.database.migrations));
    }
    const bytes = zip.toBuffer();
    if (b.kind === "preview") await preparePreview(c, b, manifest);

    const outcome = await hooks.lock(b.target_slug, async () => {
      const staged = await releases.stage(manifest, bytes, {
        source: "git",
        message: b.kind === "preview" ? `pull request #${b.pr}` : "",
        commitSha: b.sha,
        commitMessage: b.message.split("\n")[0],
        createdBy: b.author || "git",
      });
      return releases.promote(staged.id);
    });
    for (const l of outcome.log) say(l);
    await save("succeeded", { release: outcome.release });
    await forge.status(c.repo, b.sha, "success", appUrl(b.target_slug), `live as release ${outcome.release}`).catch(() => {});
    if (b.kind === "preview") await commentPreview(c, b, forge);
  } catch (err: any) {
    for (const l of err?.log ?? []) say(l);
    say(`FAILED: ${err?.message ?? err}`);
    await save("failed");
    await forge.status(c.repo, b.sha, "failure", CONSOLE_ORIGIN + "/", String(err?.message ?? "build failed")).catch(() => {});
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}

/* ---------- previews ---------- */

// A preview is an app of its own (<slug>--pr-<n>): its own container, its own
// empty database, the production app's variables, and access limited to
// accounts of this server, whatever the production app allows.
async function preparePreview(c: Connection, b: Build, m: Manifest) {
  if (await store.getApp(b.target_slug)) {
    await sql`update apps set preview_of = ${c.slug}, preview_pr = ${b.pr} where slug = ${b.target_slug}`;
    return;
  }
  const parent = await store.getApp(c.slug);
  const env: Record<string, string> = {};
  for (const k of m.env) if (parent?.env?.[k]) env[k] = parent.env[k];
  await store.upsertApp({ slug: b.target_slug, name: m.name, access: "private", groups: [], env, declared_env: m.env } as any);
  await sql`update apps set preview_of = ${c.slug}, preview_pr = ${b.pr} where slug = ${b.target_slug}`;
}

async function commentPreview(c: Connection, b: Build, forge: forges.Forge) {
  const app = await store.getApp(b.target_slug);
  const body =
    `**Preview** of this pull request: ${appUrl(b.target_slug)}\n\n` +
    `Commit ${b.sha.slice(0, 7)}, deployed by nanodeploy. Only accounts of the server can open it; ` +
    `it has its own empty database and goes away when the pull request is closed.`;
  const id = await forge.comment(c.repo, b.pr!, body, (app as any)?.preview_comment ?? null).catch(() => null);
  if (id) await sql`update apps set preview_comment = ${id} where slug = ${b.target_slug}`;
}

async function removePreview(c: Connection, pr: number) {
  const slug = previewSlug(c.slug, pr);
  await sql`update builds set status = 'skipped', finished_at = now() where target_slug = ${slug} and status = 'queued'`;
  if (await store.getApp(slug)) await hooks.removeApp(slug, true);
}

// previews whose pull request went quiet: closed events can be missed
async function sweep() {
  const stale = await sql<{ slug: string }[]>`
    select a.slug from apps a where a.preview_of is not null and not exists (
      select 1 from builds b where b.target_slug = a.slug and b.created_at > now() - make_interval(days => ${PREVIEW_TTL_DAYS}))`;
  for (const s of stale) await hooks.removeApp(s.slug, true);
  await sql`delete from webhook_deliveries where received_at < now() - interval '7 days'`;
}

/* ---------- webhooks ---------- */

export async function webhook(kind: "github" | "gitlab", providerId: string | null, headers: Headers, body: Buffer) {
  let p: ProviderRow | null = null;
  if (kind === "github") {
    const appId = headers.get("x-github-hook-installation-target-id");
    [p] = await sql<ProviderRow[]>`select ${providerCols} from git_providers where kind = 'github' and config->>'appId' = ${appId ?? ""}`;
  } else if (providerId && /^\d{1,18}$/.test(providerId)) {
    p = await getProvider(providerId);
    if (p?.kind !== "gitlab") p = null;
  }
  if (!p) return { status: 404, message: "unknown hook" };
  const forge = forges.forgeOf(p);
  if (!forge.verify(headers, body)) return { status: 401, message: "bad signature" };
  if (kind === "github" && headers.get("x-github-event") === "ping") return { status: 200, message: "pong" };

  const delivery = forge.deliveryId(headers);
  if (delivery) {
    const fresh = await sql`insert into webhook_deliveries (id) values (${`${p.id}:${delivery}`}) on conflict do nothing returning id`;
    if (!fresh.length) return { status: 200, message: "already received" };
  }
  let payload: any;
  try {
    payload = JSON.parse(body.toString("utf8"));
  } catch {
    return { status: 400, message: "invalid json" };
  }
  const event = forge.parse(headers, payload);
  if (!event) return { status: 202, message: "ignored" };
  return handle(p, event);
}

async function handle(p: ProviderRow, e: GitEvent) {
  const conns = await sql<Connection[]>`select * from git_connections where provider_id = ${p.id} and repo_id = ${e.repoId}`;
  let queued = 0;
  if (e.kind === "push") {
    for (const c of conns.filter((x) => x.branch === e.branch)) {
      if (await enqueue(c, { kind: "production", ref: e.branch, sha: e.sha, pr: null, message: e.message, author: e.author })) queued++;
    }
    return { status: 202, message: queued ? `queued ${queued} build(s)` : "no app deploys this branch" };
  }
  for (const c of conns.filter((x) => x.branch === e.base)) {
    if (e.action === "close") {
      await removePreview(c, e.number);
      continue;
    }
    if (!c.previews) continue;
    // a fork's pull request is a stranger's code: never built on its own
    if (e.fromFork) continue;
    if (await enqueue(c, { kind: "preview", ref: e.head, sha: e.sha, pr: e.number, message: e.message, author: e.author })) queued++;
  }
  return { status: 202, message: queued ? `queued ${queued} preview build(s)` : "nothing to build" };
}
