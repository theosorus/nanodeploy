import type { Sql } from "postgres";

// The gate service owns sign-in, sessions and app access checks. Its tables
// live in a "gate" schema of the platform database, created here because the
// control plane is the only component with the rights to create roles and
// schemas. gate connects as nd_gate, which sees its own schema and, from the
// apps table, only the columns an access decision needs: never env values or
// database passwords. gate answers strangers on the internet, the control
// plane drives docker: they share data, not privileges.
export async function initGateSchema(admin: Sql, dbName: string) {
  const password = process.env.GATE_DB_PASSWORD ?? "";
  if (password.length < 24) {
    throw new Error(
      "GATE_DB_PASSWORD is missing or shorter than 24 characters. Run ./install.sh " +
        "(it adds the secret to an existing .env), then restart.",
    );
  }
  // a password from .env lands in DDL, which cannot take a bind parameter
  if (!/^[A-Za-z0-9]+$/.test(password)) {
    throw new Error("GATE_DB_PASSWORD must be letters and digits only");
  }

  await admin.unsafe(`
    do $$ begin
      if not exists (select from pg_roles where rolname = 'nd_gate') then
        create role nd_gate login;
      end if;
    end $$`);
  // kept in step with .env on every start, so rotating it is a restart
  await admin.unsafe(`alter role nd_gate with login password '${password}'`);
  await admin.unsafe(`grant connect on database "${dbName}" to nd_gate`);

  await admin.unsafe(`create schema if not exists gate`);
  await admin.unsafe(`
    create table if not exists gate.users (
      id text primary key,
      username text not null,
      email text not null default '',
      display_name text not null,
      role text not null default 'member' check (role in ('admin', 'member')),
      status text not null default 'active' check (status in ('active', 'suspended')),
      created_at timestamptz not null default now(),
      last_login_at timestamptz
    );
    create unique index if not exists users_username on gate.users (lower(username));

    create table if not exists gate.credentials (
      id bigserial primary key,
      user_id text not null references gate.users(id) on delete cascade,
      kind text not null check (kind in ('password', 'passkey')),
      secret text,
      webauthn_id text unique,
      public_key bytea,
      counter bigint not null default 0,
      transports text[] not null default '{}',
      label text not null default '',
      created_at timestamptz not null default now(),
      last_used_at timestamptz
    );
    create unique index if not exists credentials_one_password
      on gate.credentials (user_id) where kind = 'password';

    create table if not exists gate.groups (
      id text primary key,
      name text not null unique
    );
    create table if not exists gate.group_members (
      group_id text not null references gate.groups(id) on delete cascade,
      user_id text not null references gate.users(id) on delete cascade,
      primary key (group_id, user_id)
    );

    -- A root session lives on the auth host. Every other host gets its own
    -- session, derived from a root one through a one-time code: a cookie stolen
    -- by an app only ever works on that app.
    create table if not exists gate.sessions (
      id_hash bytea primary key,
      user_id text not null references gate.users(id) on delete cascade,
      host text not null,
      parent bytea,
      authenticated_at timestamptz not null,
      created_at timestamptz not null default now(),
      last_seen_at timestamptz not null default now(),
      expires_at timestamptz not null,
      user_agent text not null default ''
    );
    create index if not exists sessions_parent on gate.sessions (parent);
    create index if not exists sessions_user on gate.sessions (user_id);

    create table if not exists gate.handoffs (
      code_hash bytea primary key,
      root bytea not null,
      host text not null,
      expires_at timestamptz not null
    );

    -- welcome (first password of an invited account), reset (a new one),
    -- setup (the very first administrator, link printed in the logs)
    create table if not exists gate.tokens (
      token_hash bytea primary key,
      user_id text references gate.users(id) on delete cascade,
      purpose text not null check (purpose in ('welcome', 'reset', 'setup')),
      expires_at timestamptz not null,
      used_at timestamptz,
      created_at timestamptz not null default now()
    );

    create table if not exists gate.challenges (
      id_hash bytea primary key,
      challenge text not null,
      user_id text,
      expires_at timestamptz not null
    );

    -- personal access keys (ndk_...): act as their owner on the apps listed
    create table if not exists gate.access_keys (
      id bigserial primary key,
      user_id text not null references gate.users(id) on delete cascade,
      key_hash bytea not null unique,
      hint text not null,
      label text not null,
      apps text[],
      expires_at timestamptz not null,
      created_at timestamptz not null default now(),
      last_used_at timestamptz
    );

    -- who holds which role of which app, directly or through a group
    create table if not exists gate.role_grants (
      slug text not null,
      role text not null,
      subject_kind text not null check (subject_kind in ('user', 'group')),
      subject_id text not null,
      primary key (slug, role, subject_kind, subject_id)
    );

    -- who used which app, one row per person, app and day: what the analytics
    -- page shows for apps that are not public. Never a log of each click.
    create table if not exists gate.member_activity (
      slug text not null,
      user_id text not null references gate.users(id) on delete cascade,
      day date not null,
      first_seen timestamptz not null,
      last_seen timestamptz not null,
      requests int not null default 0,
      primary key (slug, user_id, day)
    );

    create table if not exists gate.audit (
      id bigserial primary key,
      at timestamptz not null default now(),
      actor text,
      action text not null,
      target text,
      detail jsonb
    );
  `);

  await admin.unsafe(`
    grant usage on schema gate to nd_gate;
    grant select, insert, update, delete on all tables in schema gate to nd_gate;
    grant usage, select on all sequences in schema gate to nd_gate;
    grant select (slug, name, access, groups, roles, protect) on public.apps to nd_gate;
  `);
}
