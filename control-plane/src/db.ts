import postgres from "postgres";
import { randomBytes } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

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
};

// added after the first release, existing installs need the column too
export async function migrateState() {
  try {
    await admin`alter table apps add column if not exists warm boolean not null default false`;
  } catch (err: any) {
    // postgres.js surfaces the "already exists" notice as an error, harmless
    if (String(err?.code) !== "42701") throw err;
  }
}

export const listApps = () =>
  admin<AppRow[]>`select * from apps order by slug`;

export const getApp = (slug: string) =>
  admin<AppRow[]>`select * from apps where slug = ${slug}`.then((r) => r[0]);

// Partial rows are common (env-only changes, image refresh after a rebuild).
// INSERT ... ON CONFLICT would null the NOT NULL columns a partial row omits,
// and a bare update must not touch deployed_at: only a real deploy bumps it.
export async function upsertApp(row: Partial<AppRow> & { slug: string }) {
  const existing = await getApp(row.slug);
  if (existing) {
    const merged = { ...existing, ...row, deployed_at: existing.deployed_at };
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
