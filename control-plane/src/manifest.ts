import { parse } from "yaml";

export type Access = "public" | "private" | "groups";

export type Manifest = {
  name: string;
  slug: string;
  access: Access;
  groups: string[];
  frontend: boolean;
  backend?: { entry: string; port: number };
  database: { enabled: boolean; migrations: string };
  idle: { timeout: string; warm: boolean };
  env: string[];
};

const SLUG_RE = /^[a-z][a-z0-9-]{1,30}$/;
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const IDLE_RE = /^\d+(ms|s|m|h)$/;
const NAME_MAX = 60;

const bad = (msg: string): never => {
  throw new Error(msg);
};

export function parseManifest(raw: string): Manifest {
  const m = parse(raw) as Record<string, any>;
  if (!m || typeof m !== "object") bad("manifest must be a yaml object");
  if (!m.slug || !SLUG_RE.test(m.slug)) {
    bad("slug must match [a-z][a-z0-9-]{1,30}");
  }
  const access: Access = m.access ?? "private";
  if (!["public", "private", "groups"].includes(access)) {
    bad(`unknown access mode: ${access}`);
  }

  const name = String(m.name ?? m.slug).replace(/[\r\n"\\]/g, "").trim().slice(0, NAME_MAX);
  if (!name) bad("name must not be empty");

  // groups and name eventually land in a Caddyfile, strip the characters that
  // could break out of a line. Group names are further restricted: they become
  // regex alternation tokens and must not contain spaces or metacharacters.
  const GROUP_RE = /^[\p{L}\p{N}._'-]+$/u;
  const cleanGroup = (g: unknown) => {
    const clean = String(g).replace(/[\r\n"\\]/g, "").trim().slice(0, 64);
    if (clean && !GROUP_RE.test(clean)) {
      bad(`group name contains characters caddy cannot handle: ${clean}`);
    }
    return clean;
  };
  const groups = (Array.isArray(m.groups) ? m.groups : [])
    .map(cleanGroup)
    .filter((g) => g.length > 0)
    .slice(0, 32);
  if (access === "groups" && groups.length === 0) {
    bad("access: groups requires a non-empty groups list");
  }

  const entry = String(m.backend?.entry ?? "server.js").trim();
  if (!entry || entry.includes("..") || entry.startsWith("/") || entry.includes("\\")) {
    bad("backend.entry must be a plain relative path inside the bundle");
  }
  const port = Number(m.backend?.port ?? 3000);
  if (port < 1 || port > 65535 || !Number.isInteger(port)) {
    bad(`backend.port must be an integer in [1, 65535], got ${port}`);
  }

  const timeout = String(m.idle?.timeout ?? "10m");
  if (!IDLE_RE.test(timeout)) bad(`idle.timeout must match \\d+(ms|s|m|h), got ${timeout}`);

  const migrations = String(m.database?.migrations ?? "./migrations");
  if (migrations.includes("..") || migrations.startsWith("/")) {
    bad("database.migrations must stay inside the bundle");
  }

  // env keys become container env names: keep them strict so a manifest cannot
  // smuggle extra KEY=VALUE pairs into the container through a newline
  const env = [...new Set(Array.isArray(m.env) ? m.env : [])];
  for (const key of env) {
    if (typeof key !== "string" || !ENV_KEY_RE.test(key)) {
      bad(`env names must match [A-Za-z_][A-Za-z0-9_]* , got: ${String(key).slice(0, 40)}`);
    }
  }

  return {
    name,
    slug: m.slug,
    access,
    groups,
    frontend: m.frontend !== false,
    backend: m.backend ? { entry, port } : undefined,
    database: {
      enabled: Boolean(m.database?.enabled),
      migrations,
    },
    // warm apps opt out of scale-to-zero: they stay up and restart with docker
    idle: { timeout, warm: m.idle?.warm === true },
    env,
  };
}
