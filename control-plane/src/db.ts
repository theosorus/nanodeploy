import postgres from "postgres";
import { createHash, randomBytes } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { initGateSchema } from "./gate-schema.js";

const admin = postgres(process.env.POSTGRES_URL!, { max: 2, idle_timeout: 20 });

export async function initState() {
  await admin`
    create table if not exists apps (
      slug text primary key,
      name text not null,
      access text not null default 'private',
      groups text[] not null default '{}',
      port int,
      idle_timeout text not null default '10m',
      warm boolean not null default false,
      db_user text,
      db_password text,
      env jsonb not null default '{}',
      image text,
      deployed_at timestamptz not null default now()
    )`;
  await admin`
    create table if not exists settings (
      key text primary key,
      value text not null
    )`;
  // app roles must not be able to reach the platform's own database at all,
  // nor the maintenance database, where they could at least enumerate every
  // other app through pg_database
  const dbName = new URL(process.env.POSTGRES_URL!).pathname.replace(/^\//, "");
  await admin.unsafe(`revoke connect on database "${dbName}" from public`);
  await admin.unsafe(`revoke connect on database "postgres" from public`).catch(() => {});
}

export const getSetting = (key: string) =>
  admin<{ value: string }[]>`select value from settings where key = ${key}`.then(
    (r) => r[0]?.value ?? null,
  );

export async function setSetting(key: string, value: string) {
  await admin`
    insert into settings (key, value) values (${key}, ${value})
    on conflict (key) do update set value = excluded.value`;
}

export type AppRow = {
  slug: string;
  name: string;
  access: string;
  groups: string[];
  port: number | null;
  idle_timeout: string;
  warm: boolean;
  db_user: string | null;
  db_password: string | null;
  env: Record<string, string>;
  image: string | null;
  deployed_at: string;
  declared_env: string[];
  // declared by the manifest on every deploy: the roles this app understands
  // and the paths that need one. Who holds a role is decided in the dashboard.
  roles: string[];
  protect: { path: string; role: string }[];
};

// added after the first release, existing installs need the column too
export async function migrateState() {
  try {
    await admin`alter table apps add column if not exists warm boolean not null default false`;
    await admin`alter table apps add column if not exists declared_env text[] not null default '{}'`;
    await admin`alter table apps add column if not exists roles text[] not null default '{}'`;
    await admin`alter table apps add column if not exists protect jsonb not null default '[]'`;
  } catch (err: any) {
    // postgres.js surfaces the "already exists" notice as an error, harmless
    if (String(err?.code) !== "42701") throw err;
  }
  // Deploy keys: a credential that can deploy one app and nothing else, so a CI
  // job or an AI agent never needs the root DEPLOY_TOKEN. Not tied to the apps
  // row on purpose: a key may be created before the first deploy of its slug.
  await admin`
    create table if not exists deploy_keys (
      id bigserial primary key,
      slug text not null,
      key_hash bytea not null unique,
      hint text not null,
      label text not null,
      created_at timestamptz not null default now(),
      last_used_at timestamptz
    )`;
}

// after migrateState: the gate role is granted columns added there
export const initGate = () =>
  initGateSchema(admin, new URL(process.env.POSTGRES_URL!).pathname.replace(/^\//, ""));

// the accounts module shares the connection: one small pool per process
export const sql = admin;

/* ---------- deploy keys ---------- */

// 32 random bytes, base64url: 43 characters after the prefix. The prefix makes a
// leaked key recognisable (and greppable) and lets caddy route it without a
// session; the length is fixed so the caddy matcher can be exact.
export const DEPLOY_KEY_RE = /^ndd_[A-Za-z0-9_-]{43}$/;

// a random 256-bit key does not need a slow hash: nobody brute forces 2^256
const hashKey = (key: string) => createHash("sha256").update(key).digest();

export type DeployKey = {
  id: string;
  slug: string;
  hint: string;
  label: string;
  created_at: string;
  last_used_at: string | null;
};

export async function createDeployKey(slug: string, label: string) {
  const key = `ndd_${randomBytes(32).toString("base64url")}`;
  const hint = `ndd_…${key.slice(-4)}`;
  const [row] = await admin<DeployKey[]>`
    insert into deploy_keys (slug, key_hash, hint, label)
    values (${slug}, ${hashKey(key)}, ${hint}, ${label})
    returning id, slug, hint, label, created_at, last_used_at`;
  // the only time the plain key exists outside the caller's hands
  return { ...row, key };
}

export const listDeployKeys = (slug: string) =>
  admin<DeployKey[]>`
    select id, slug, hint, label, created_at, last_used_at
    from deploy_keys where slug = ${slug} order by created_at`;

export async function deleteDeployKey(slug: string, id: string) {
  const rows = await admin`delete from deploy_keys where slug = ${slug} and id = ${id} returning id`;
  return rows.length > 0;
}

export const deleteDeployKeysOf = (slug: string) =>
  admin`delete from deploy_keys where slug = ${slug}`;

// Returns the slug the key may deploy, or null. last_used_at is refreshed at
// most once a minute: it is shown in the dashboard, not used for auth.
export async function verifyDeployKey(key: string): Promise<{ id: string; slug: string } | null> {
  if (!DEPLOY_KEY_RE.test(key)) return null;
  const [row] = await admin<{ id: string; slug: string }[]>`
    select id, slug from deploy_keys where key_hash = ${hashKey(key)}`;
  if (!row) return null;
  await admin`
    update deploy_keys set last_used_at = now()
    where id = ${row.id} and (last_used_at is null or last_used_at < now() - interval '1 minute')`;
  return row;
}

export const listApps = () =>
  admin<AppRow[]>`select * from apps order by slug`;

export const getApp = (slug: string) =>
  admin<AppRow[]>`select * from apps where slug = ${slug}`.then((r) => r[0]);

// Partial rows are common (env-only changes, image refresh after a rebuild).
// INSERT ... ON CONFLICT would null the NOT NULL columns a partial row omits,
// and a bare update must not touch deployed_at: only a real deploy bumps it.
export async function upsertApp(row: Partial<AppRow> & { slug: string }) {
  // postgres.js sends a JS array as a postgres array: protect is jsonb, say so
  if (Array.isArray(row.protect)) row = { ...row, protect: admin.json(row.protect) as any };
  const existing = await getApp(row.slug);
  if (existing) {
    const merged = { ...existing, ...row, deployed_at: existing.deployed_at };
    if (Array.isArray(merged.protect)) merged.protect = admin.json(merged.protect) as any;
    await admin`update apps set ${admin(merged)} where slug = ${row.slug}`;
  } else {
    await admin`insert into apps ${admin(row)}`;
  }
}

export const touchDeploy = (slug: string) =>
  admin`update apps set deployed_at = now() where slug = ${slug}`;

export async function setAccess(slug: string, access: string, groups: string[]) {
  await admin`update apps set access = ${access}, groups = ${groups} where slug = ${slug}`;
}

export async function deleteApp(slug: string) {
  await admin`delete from apps where slug = ${slug}`;
}

// one database and one role per app, no cross-app visibility
export async function provisionDatabase(slug: string) {
  const existing = await getApp(slug);
  if (existing?.db_user && existing.db_password) {
    return { user: existing.db_user, password: existing.db_password };
  }
  const user = `app_${slug.replace(/-/g, "_")}`;
  const password = randomBytes(18).toString("hex");

  await admin.unsafe(`create role "${user}" login password '${password}'`).catch(async (e) => {
    if (!String(e.message).includes("already exists")) throw e;
    await admin.unsafe(`alter role "${user}" with password '${password}'`);
  });
  await admin.unsafe(`create database "${user}" owner "${user}"`).catch((e) => {
    if (!String(e.message).includes("already exists")) throw e;
  });
  await admin.unsafe(`revoke connect on database "${user}" from public`);
  await admin.unsafe(`grant connect on database "${user}" to "${user}"`);
  return { user, password };
}

export function databaseUrl(user: string, password: string) {
  return `postgres://${user}:${password}@postgres:5432/${user}`;
}

// migrations run here, once per deploy, never at app boot
export async function runMigrations(dir: string, url: string) {
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  } catch {
    return [];
  }
  if (files.length === 0) return [];

  const sql = postgres(url, { max: 1 });
  const applied: string[] = [];
  try {
    await sql`create table if not exists _migrations (
      name text primary key, applied_at timestamptz not null default now())`;
    const done = new Set(
      (await sql<{ name: string }[]>`select name from _migrations`).map((r) => r.name),
    );
    for (const file of files) {
      if (done.has(file)) continue;
      const body = await readFile(join(dir, file), "utf8");
      await sql.begin(async (tx) => {
        await tx.unsafe(body);
        await tx`insert into _migrations (name) values (${file})`;
      });
      applied.push(file);
    }
  } finally {
    await sql.end();
  }
  return applied;
}
