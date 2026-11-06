import postgres from "postgres";
import { randomToken, sha256 } from "./crypto.js";

// nd_gate sees the gate schema and a few columns of the apps table, nothing
// else: the control plane created the role and the tables.
export const sql = postgres(process.env.DATABASE_URL!, { max: 4, idle_timeout: 20 });

export type User = {
  id: string;
  username: string;
  email: string;
  display_name: string;
  role: "admin" | "member";
  status: string;
};

export type Group = { id: string; name: string };

export type AppPolicy = {
  slug: string;
  name: string;
  access: "public" | "private" | "groups";
  groups: string[];
  roles: string[];
  protect: { path: string; role: string }[];
};

const USER_COLS = sql`u.id, u.username, u.email, u.display_name, u.role, u.status`;

// The control plane creates the schema on its first start. gate may come up
// first after a reboot: wait for it instead of crashing in a loop.
export async function waitForSchema() {
  for (let attempt = 1; ; attempt++) {
    try {
      await sql`select 1 from gate.users limit 1`;
      return;
    } catch (err: any) {
      if (attempt % 10 === 1) console.log(`waiting for the gate schema (${err?.message ?? err})`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

/* ---------- users ---------- */

export const getUser = (id: string) =>
  sql<User[]>`select ${USER_COLS} from gate.users u where u.id = ${id}`.then((r) => r[0] ?? null);

// sign in with the username or the email, whichever the person remembers
export const findLogin = (login: string) =>
  sql<User[]>`
    select ${USER_COLS} from gate.users u
    where (lower(u.username) = lower(${login}) or (u.email <> '' and lower(u.email) = lower(${login})))
    order by lower(u.username) = lower(${login}) desc
    limit 1`.then((r) => r[0] ?? null);

export const usernameTaken = (username: string) =>
  sql`select 1 from gate.users where lower(username) = lower(${username})`.then((r) => r.length > 0);

export async function createAdmin(input: { id: string; username: string; displayName: string; email: string }) {
  await sql`
    insert into gate.users (id, username, email, display_name, role)
    values (${input.id}, ${input.username}, ${input.email}, ${input.displayName}, 'admin')`;
}

export const touchLogin = (id: string) => sql`update gate.users set last_login_at = now() where id = ${id}`;

export const groupsOf = (userId: string) =>
  sql<Group[]>`
    select g.id, g.name from gate.groups g
    join gate.group_members m on m.group_id = g.id
    where m.user_id = ${userId} order by g.name`;

/* ---------- credentials ---------- */

export const passwordOf = (userId: string) =>
  sql<{ secret: string }[]>`
    select secret from gate.credentials where user_id = ${userId} and kind = 'password'`.then(
    (r) => r[0]?.secret ?? null,
  );

export async function setPassword(userId: string, hash: string) {
  await sql`
    insert into gate.credentials (user_id, kind, secret) values (${userId}, 'password', ${hash})
    on conflict (user_id) where kind = 'password'
    do update set secret = excluded.secret, created_at = now()`;
}

export const markPasswordUsed = (userId: string) =>
  sql`update gate.credentials set last_used_at = now() where user_id = ${userId} and kind = 'password'`;

export type Passkey = {
  id: string;
  webauthn_id: string;
  public_key: Buffer;
  counter: string;
  transports: string[];
  label: string;
  created_at: string;
  last_used_at: string | null;
};

export const passkeysOf = (userId: string) =>
  sql<Passkey[]>`
    select id, webauthn_id, public_key, counter, transports, label, created_at, last_used_at
    from gate.credentials where user_id = ${userId} and kind = 'passkey' order by created_at`;

export const passkeyById = (webauthnId: string) =>
  sql<(Passkey & { user_id: string })[]>`
    select id, user_id, webauthn_id, public_key, counter, transports, label, created_at, last_used_at
    from gate.credentials where webauthn_id = ${webauthnId} and kind = 'passkey'`.then((r) => r[0] ?? null);

export async function addPasskey(userId: string, p: { id: string; publicKey: Uint8Array; counter: number; transports: string[]; label: string }) {
  await sql`
    insert into gate.credentials (user_id, kind, webauthn_id, public_key, counter, transports, label)
    values (${userId}, 'passkey', ${p.id}, ${Buffer.from(p.publicKey)}, ${p.counter}, ${p.transports}, ${p.label})`;
}

export const bumpPasskey = (id: string, counter: number) =>
  sql`update gate.credentials set counter = ${counter}, last_used_at = now() where id = ${id}`;

export const credentialCount = (userId: string) =>
  sql<{ n: number }[]>`select count(*)::int as n from gate.credentials where user_id = ${userId}`.then((r) => r[0].n);

export const deletePasskey = (userId: string, id: string) =>
  sql`delete from gate.credentials where user_id = ${userId} and id = ${id} and kind = 'passkey' returning id`.then(
    (r) => r.length > 0,
  );

/* ---------- sessions ---------- */

export type Session = {
  id_hash: Buffer;
  host: string;
  parent: Buffer | null;
  authenticated_at: Date;
  expires_at: Date;
  last_seen_at: Date;
  user: User;
};

export async function createSession(input: {
  userId: string;
  host: string;
  parent: Buffer | null;
  authenticatedAt: Date;
  expiresAt: Date;
  userAgent: string;
}): Promise<string> {
  const raw = randomToken();
  await sql`
    insert into gate.sessions (id_hash, user_id, host, parent, authenticated_at, expires_at, user_agent)
    values (${sha256(raw)}, ${input.userId}, ${input.host}, ${input.parent}, ${input.authenticatedAt},
            ${input.expiresAt}, ${input.userAgent.slice(0, 200)})`;
  return raw;
}

// A host session is only as good as the root session it came from: signing out
// on the auth host, or an admin suspending the account, ends them all at once.
export async function findSession(raw: string | undefined, host: string): Promise<Session | null> {
  if (!raw || raw.length > 100) return null;
  const rows = await sql<any[]>`
    select s.id_hash, s.host, s.parent, s.authenticated_at, s.expires_at, s.last_seen_at, ${USER_COLS}
    from gate.sessions s
    join gate.users u on u.id = s.user_id
    left join gate.sessions p on p.id_hash = s.parent
    where s.id_hash = ${sha256(raw)} and s.host = ${host} and s.expires_at > now()
      and u.status = 'active'
      and (s.parent is null or (p.id_hash is not null and p.expires_at > now()))`;
  const r = rows[0];
  if (!r) return null;
  const { id, username, email, display_name, role, status, ...s } = r;
  return { ...s, user: { id, username, email, display_name, role, status } };
}

// at most once every five minutes per session: this runs on every request
export async function touchSession(s: Session, slide: number | null) {
  if (Date.now() - new Date(s.last_seen_at).getTime() < 300_000) return;
  if (slide) {
    await sql`update gate.sessions set last_seen_at = now(), expires_at = ${new Date(Date.now() + slide)}
      where id_hash = ${s.id_hash}`;
  } else {
    await sql`update gate.sessions set last_seen_at = now() where id_hash = ${s.id_hash}`;
  }
}

export const endFamily = (root: Buffer) =>
  sql`delete from gate.sessions where id_hash = ${root} or parent = ${root}`;

export const endUserSessions = (userId: string) => sql`delete from gate.sessions where user_id = ${userId}`;

/* ---------- handoffs: a root session lends itself to one host, once ---------- */

export async function createHandoff(root: Buffer, host: string) {
  const code = randomToken();
  await sql`
    insert into gate.handoffs (code_hash, root, host, expires_at)
    values (${sha256(code)}, ${root}, ${host}, ${new Date(Date.now() + 60_000)})`;
  return code;
}

export const consumeHandoff = (code: string, host: string) =>
  sql<{ root: Buffer }[]>`
    delete from gate.handoffs
    where code_hash = ${sha256(code)} and host = ${host} and expires_at > now()
    returning root`.then((r) => r[0]?.root ?? null);

export const getRoot = (root: Buffer) =>
  sql<{ user_id: string; authenticated_at: Date; expires_at: Date }[]>`
    select user_id, authenticated_at, expires_at from gate.sessions
    where id_hash = ${root} and parent is null and expires_at > now()`.then((r) => r[0] ?? null);

/* ---------- tokens: welcome, reset, setup ---------- */

export type TokenRow = { token_hash: Buffer; user_id: string | null; purpose: "welcome" | "reset" | "setup" };

export const findToken = (raw: string) =>
  sql<TokenRow[]>`
    select token_hash, user_id, purpose from gate.tokens
    where token_hash = ${sha256(raw)} and used_at is null and expires_at > now()`.then((r) => r[0] ?? null);

// single use: the update only succeeds once, even with two tabs racing
export const useToken = (hash: Buffer) =>
  sql`update gate.tokens set used_at = now() where token_hash = ${hash} and used_at is null returning 1`.then(
    (r) => r.length > 0,
  );

/* ---------- webauthn challenges ---------- */

export async function saveChallenge(challenge: string, userId: string | null) {
  const id = randomToken();
  await sql`
    insert into gate.challenges (id_hash, challenge, user_id, expires_at)
    values (${sha256(id)}, ${challenge}, ${userId}, ${new Date(Date.now() + 300_000)})`;
  return id;
}

export const takeChallenge = (id: string | undefined) =>
  id
    ? sql<{ challenge: string; user_id: string | null }[]>`
        delete from gate.challenges where id_hash = ${sha256(id)} and expires_at > now()
        returning challenge, user_id`.then((r) => r[0] ?? null)
    : Promise.resolve(null);

/* ---------- personal access keys ---------- */

export const ACCESS_KEY_RE = /^ndk_[A-Za-z0-9_-]{43}$/;

export async function verifyAccessKey(key: string) {
  if (!ACCESS_KEY_RE.test(key)) return null;
  const rows = await sql<any[]>`
    select k.id as key_id, k.apps, k.last_used_at as key_used, ${USER_COLS}
    from gate.access_keys k join gate.users u on u.id = k.user_id
    where k.key_hash = ${sha256(key)} and k.expires_at > now() and u.status = 'active'`;
  const r = rows[0];
  if (!r) return null;
  if (!r.key_used || Date.now() - new Date(r.key_used).getTime() > 60_000) {
    await sql`update gate.access_keys set last_used_at = now() where id = ${r.key_id}`;
  }
  const { key_id, apps, key_used, ...user } = r;
  return { user: user as User, apps: apps as string[] | null };
}

export type AccessKey = { id: string; hint: string; label: string; apps: string[] | null; expires_at: string; last_used_at: string | null };

export const accessKeysOf = (userId: string) =>
  sql<AccessKey[]>`
    select id, hint, label, apps, expires_at, last_used_at from gate.access_keys
    where user_id = ${userId} order by created_at`;

export async function createAccessKey(userId: string, label: string, apps: string[] | null, days: number) {
  const key = `ndk_${randomToken(32)}`;
  await sql`
    insert into gate.access_keys (user_id, key_hash, hint, label, apps, expires_at)
    values (${userId}, ${sha256(key)}, ${`ndk_…${key.slice(-4)}`}, ${label}, ${apps},
            ${new Date(Date.now() + days * 86_400_000)})`;
  return key;
}

export const deleteAccessKey = (userId: string, id: string) =>
  sql`delete from gate.access_keys where user_id = ${userId} and id = ${id}`;

/* ---------- apps and roles ---------- */

export const getApp = (slug: string) =>
  sql<AppPolicy[]>`select slug, name, access, groups, roles, protect from public.apps where slug = ${slug}`.then(
    (r) => r[0] ?? null,
  );

export const listApps = () =>
  sql<AppPolicy[]>`select slug, name, access, groups, roles, protect from public.apps order by name`;

export const grantedRoles = (slug: string, userId: string, groupIds: string[]) =>
  sql<{ role: string }[]>`
    select distinct role from gate.role_grants
    where slug = ${slug}
      and ((subject_kind = 'user' and subject_id = ${userId})
        or (subject_kind = 'group' and subject_id = any(${groupIds})))`.then((r) => r.map((x) => x.role));

// every app at once, for the "your apps" list of the account page
export const allGrants = (userId: string, groupIds: string[]) =>
  sql<{ slug: string; role: string }[]>`
    select distinct slug, role from gate.role_grants
    where (subject_kind = 'user' and subject_id = ${userId})
       or (subject_kind = 'group' and subject_id = any(${groupIds}))`;

/* ---------- audit and housekeeping ---------- */

export const audit = (actor: string | null, action: string, target: string | null, detail?: object) =>
  sql`insert into gate.audit (actor, action, target, detail) values (${actor}, ${action}, ${target}, ${detail ? sql.json(detail as any) : null})`.catch(
    (err) => console.error("audit write failed", err),
  );

export async function sweep() {
  await sql`delete from gate.sessions where expires_at < now()`;
  await sql`delete from gate.handoffs where expires_at < now()`;
  await sql`delete from gate.challenges where expires_at < now()`;
  await sql`delete from gate.tokens where expires_at < now() - interval '30 days'`;
  await sql`delete from gate.access_keys where expires_at < now() - interval '30 days'`;
  await sql`delete from gate.audit where at < now() - interval '400 days'`;
}
