import { createHash, randomBytes, randomUUID } from "node:crypto";
import { sql } from "./db.js";
import * as pocketid from "./people.js";

// Accounts, groups and app roles live in the gate schema of the platform
// database. The control plane manages them directly (it is the administrator's
// side); gate only reads them to decide, and owns passwords and sessions.

const DOMAIN = process.env.APPS_DOMAIN!;
const SCHEME = process.env.PUBLIC_SCHEME === "http" ? "http" : "https";
const PORT = process.env.PUBLIC_PORT ? `:${process.env.PUBLIC_PORT}` : "";
export const AUTH_ORIGIN = `${SCHEME}://auth.${DOMAIN}${PORT}`;

export const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{1,31}$/;

export type Person = {
  id: string;
  username: string;
  email: string;
  displayName: string;
  isAdmin: boolean;
  suspended: boolean;
  groups: string[];
  hasPassword: boolean;
  passkeys: number;
  lastLogin: string | null;
};

export async function listPeople(): Promise<Person[]> {
  const rows = await sql<any[]>`
    select u.id, u.username, u.email, u.display_name, u.role, u.status, u.last_login_at,
      coalesce(array_agg(distinct g.name) filter (where g.name is not null), '{}') as groups,
      bool_or(c.kind = 'password') as has_password,
      count(distinct c.id) filter (where c.kind = 'passkey')::int as passkeys
    from gate.users u
    left join gate.group_members m on m.user_id = u.id
    left join gate.groups g on g.id = m.group_id
    left join gate.credentials c on c.user_id = u.id
    group by u.id
    order by u.role = 'admin' desc, lower(u.display_name)`;
  return rows.map((r) => ({
    id: r.id,
    username: r.username,
    email: r.email,
    displayName: r.display_name,
    isAdmin: r.role === "admin",
    suspended: r.status !== "active",
    groups: r.groups,
    hasPassword: Boolean(r.has_password),
    passkeys: r.passkeys,
    lastLogin: r.last_login_at,
  }));
}

export const listGroups = () =>
  sql<{ id: string; name: string }[]>`select id, name from gate.groups order by lower(name)`;

// The signed-in person, by the identity gate injected. Read on every console
// request: a demotion takes effect on the next click, not at the next login.
export async function findById(id: string) {
  if (!id) return null;
  const [u] = await sql<{ id: string; role: string; status: string }[]>`
    select id, role, status from gate.users where id = ${id}`;
  return u ? { id: u.id, isAdmin: u.role === "admin" && u.status === "active" } : null;
}

export const adminCount = () =>
  sql<{ n: number }[]>`
    select count(*)::int as n from gate.users where role = 'admin' and status = 'active'`.then((r) => r[0].n);

/* ---------- links: welcome, reset, setup ---------- */

async function makeToken(userId: string | null, purpose: "welcome" | "reset" | "setup", days: number) {
  const raw = randomBytes(32).toString("base64url");
  // a fresh link replaces the unused ones: only the last link sent works
  if (userId) {
    await sql`delete from gate.tokens where user_id = ${userId} and used_at is null`;
  } else {
    await sql`delete from gate.tokens where purpose = 'setup' and used_at is null`;
  }
  await sql`
    insert into gate.tokens (token_hash, user_id, purpose, expires_at)
    values (${createHash("sha256").update(raw).digest()}, ${userId}, ${purpose},
            ${new Date(Date.now() + days * 86_400_000)})`;
  return `${AUTH_ORIGIN}/welcome/${raw}`;
}

export async function invite(input: { username: string; email: string; firstName?: string }) {
  const username = input.username.trim().toLowerCase();
  if (!USERNAME_RE.test(username)) {
    throw new Error("username: lowercase letters, digits, dots, dashes and underscores, 2 to 32 characters");
  }
  const id = randomUUID();
  try {
    await sql`
      insert into gate.users (id, username, email, display_name, role)
      values (${id}, ${username}, ${input.email.trim()}, ${(input.firstName ?? "").trim() || username}, 'member')`;
  } catch (err: any) {
    if (err?.code === "23505") throw new Error("this username is already taken");
    throw err;
  }
  await audit(null, "invited", id);
  return { user: { id, username }, link: await makeToken(id, "welcome", 7) };
}

// A sign-in link for an existing account: the first password if it never had
// one, a new one otherwise. Nobody needs to remember anything to get back in.
export async function signInLink(userId: string) {
  const [u] = await sql<{ id: string; n: number }[]>`
    select u.id, count(c.id)::int as n from gate.users u
    left join gate.credentials c on c.user_id = u.id
    where u.id = ${userId} group by u.id`;
  if (!u) throw new Error("no such account");
  await audit(null, "link_created", userId);
  return makeToken(userId, u.n > 0 ? "reset" : "welcome", 7);
}

/* ---------- groups and admin flag ---------- */

export async function setGroups(userId: string, groupIds: string[]) {
  await sql.begin(async (tx) => {
    await tx`delete from gate.group_members where user_id = ${userId}`;
    for (const g of groupIds) {
      await tx`insert into gate.group_members (group_id, user_id) values (${g}, ${userId}) on conflict do nothing`;
    }
  });
}

export async function setAdmin(userId: string, isAdmin: boolean) {
  await sql.begin(async (tx) => {
    // Removal and demotion share a database lock: simultaneous requests must
    // not both observe two administrators and then remove the last two.
    await tx`select pg_advisory_xact_lock(18472, 1)`;
    const [user] = await tx`select role, status from gate.users where id = ${userId}`;
    if (!user) throw new Error("no such account");
    if (!isAdmin && user.role === "admin" && user.status === "active") {
      const [{ n }] = await tx`select count(*)::int as n from gate.users where role = 'admin' and status = 'active'`;
      if (n <= 1) throw new Error("this is the last administrator");
    }
    await tx`update gate.users set role = ${isAdmin ? "admin" : "member"} where id = ${userId}`;
  });
  await audit(null, isAdmin ? "admin_granted" : "admin_revoked", userId);
}

export async function createGroup(name: string) {
  const id = randomUUID();
  try {
    await sql`insert into gate.groups (id, name) values (${id}, ${name})`;
  } catch (err: any) {
    if (err?.code === "23505") throw new Error("a group with this name already exists");
    throw err;
  }
  return { id, name };
}

export async function renameGroup(groupId: string, name: string) {
  await sql`update gate.groups set name = ${name} where id = ${groupId}`;
}

export async function deleteGroup(groupId: string) {
  await sql`delete from gate.role_grants where subject_kind = 'group' and subject_id = ${groupId}`;
  await sql`delete from gate.groups where id = ${groupId}`;
}

export async function removePerson(userId: string) {
  await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(18472, 1)`;
    const [user] = await tx`select role, status from gate.users where id = ${userId}`;
    if (!user) throw new Error("no such account");
    if (user.role === "admin" && user.status === "active") {
      const [{ n }] = await tx`select count(*)::int as n from gate.users where role = 'admin' and status = 'active'`;
      if (n <= 1) throw new Error("this is the last administrator");
    }
    await tx`delete from gate.role_grants where subject_kind = 'user' and subject_id = ${userId}`;
    await tx`delete from gate.users where id = ${userId}`;
  });
  await audit(null, "removed", userId);
}

/* ---------- app roles ---------- */

export type Grant = { role: string; kind: "user" | "group"; id: string };

export const grantsOf = (slug: string) =>
  sql<Grant[]>`
    select role, subject_kind as kind, subject_id as id from gate.role_grants
    where slug = ${slug} order by role`;

export async function setGrant(slug: string, g: Grant, granted: boolean) {
  if (granted) {
    await sql`
      insert into gate.role_grants (slug, role, subject_kind, subject_id)
      values (${slug}, ${g.role}, ${g.kind}, ${g.id}) on conflict do nothing`;
  } else {
    await sql`
      delete from gate.role_grants
      where slug = ${slug} and role = ${g.role} and subject_kind = ${g.kind} and subject_id = ${g.id}`;
  }
  await audit(null, granted ? "role_granted" : "role_revoked", slug, g);
}

export const subjectExists = (kind: "user" | "group", id: string) =>
  (kind === "user"
    ? sql`select 1 from gate.users where id = ${id}`
    : sql`select 1 from gate.groups where id = ${id}`
  ).then((r) => r.length > 0);

export const deleteAppGrants = (slug: string) => sql`delete from gate.role_grants where slug = ${slug}`;

const audit = (actor: string | null, action: string, target: string | null, detail?: object) =>
  sql`insert into gate.audit (actor, action, target, detail)
      values (${actor ?? "console"}, ${action}, ${target}, ${detail ? sql.json(detail as any) : null})`.catch(() => {});

/* ---------- first start ---------- */

// Accounts used to live in Pocket ID, and every app stores the id of the person
// who owns a row (ownerId = Remote-Sub = the Pocket ID user id). Import keeps
// those ids, so no app loses its data. Passkeys cannot move (they are bound to
// Pocket ID's own domain): each person gets a link to set a password or a new
// passkey. Runs once, on an empty gate schema, if Pocket ID is still reachable.
// Whether accounts still have to come over from Pocket ID: a key is configured
// and no import has succeeded yet. Until then, no "create the administrator"
// link is offered: an administrator made by hand would end the import, and
// every app would lose the link between its rows and their owners.
export async function importPending(): Promise<boolean> {
  if (!pocketid.configured()) return false;
  const [row] = await sql<{ value: string }[]>`select value from settings where key = 'gate.imported'`;
  return !row;
}

export async function importFromPocketId(): Promise<number> {
  if (!(await importPending())) return 0;
  const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from gate.users`;
  if (n > 0) {
    // accounts exist already (an install that never used Pocket ID): nothing to merge
    await sql`insert into settings (key, value) values ('gate.imported', 'skipped: accounts already existed') on conflict do nothing`;
    return 0;
  }
  let people: pocketid.Person[];
  let groups: { id: string; name: string }[];
  try {
    [people, groups] = await Promise.all([pocketid.listPeople(), pocketid.listGroups()]);
  } catch (err: any) {
    console.error(
      `pocket id import waiting: it did not answer (${err?.message ?? err}). ` +
        `Start it with "docker compose --profile legacy up -d pocket-id"; the import retries every minute.`,
    );
    return -1;
  }
  await sql.begin(async (tx) => {
    for (const g of groups) {
      await tx`insert into gate.groups (id, name) values (${g.id}, ${g.name}) on conflict do nothing`;
    }
    for (const p of people) {
      const username = p.username.toLowerCase();
      await tx`
        insert into gate.users (id, username, email, display_name, role)
        values (${p.id}, ${username}, ${p.email}, ${p.displayName || username}, ${p.isAdmin ? "admin" : "member"})
        on conflict do nothing`;
      for (const name of p.groups) {
        const g = groups.find((x) => x.name === name);
        if (g) await tx`insert into gate.group_members (group_id, user_id) values (${g.id}, ${p.id}) on conflict do nothing`;
      }
    }
  });
  await sql`insert into settings (key, value) values ('gate.imported', ${new Date().toISOString()}) on conflict (key) do update set value = excluded.value`;
  console.log(`imported ${people.length} account(s) and ${groups.length} group(s) from Pocket ID`);
  return people.length;
}

// Nobody can manage the server until an administrator can sign in. Until then,
// every start prints a fresh link in the logs (docker compose logs control-plane):
// the link to create the first administrator on a new install, or to give an
// imported administrator a password.
export async function bootstrapLinks() {
  if (await importPending()) {
    console.log("SETUP: waiting for the Pocket ID import before offering any sign-in link");
    return;
  }
  const admins = await sql<{ id: string; username: string; n: number }[]>`
    select u.id, u.username, count(c.id)::int as n from gate.users u
    left join gate.credentials c on c.user_id = u.id
    where u.role = 'admin' and u.status = 'active' group by u.id`;
  if (admins.some((a) => a.n > 0)) return;
  const line = "-".repeat(72);
  if (admins.length === 0) {
    const link = await makeToken(null, "setup", 1);
    console.log(`${line}\nSETUP: create the administrator account, within 24 hours, at\n  ${link}\n${line}`);
    return;
  }
  for (const a of admins) {
    const link = await makeToken(a.id, "welcome", 1);
    console.log(`${line}\nSETUP: ${a.username} is an administrator with no way to sign in yet. Set it up at\n  ${link}\n${line}`);
  }
}
