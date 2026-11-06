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
  roles: string[];
  protect: { path: string; role: string }[];
  // how a repository is built on the server (Git deploys only); a zip upload
  // arrives already built and ignores it
  build: { image: string; install: string | null; command: string };
};

// "--pr-<n>" is the suffix of a pull request preview, made by the platform
const SLUG_RE = /^[a-z][a-z0-9-]{1,30}(--pr-\d{1,6})?$/;
export const isPreviewSlug = (slug: string) => /--pr-\d{1,6}$/.test(slug);
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const IDLE_RE = /^\d+(ms|s|m|h)$/;
// role names travel in a header as a comma separated list
const ROLE_RE = /^[a-z][a-z0-9_-]{0,31}$/;
// a protected path lands in a caddy path matcher and in gate's own matcher:
// plain characters, and "*" only as a trailing wildcard, the one form both
// read the same way
const PROTECT_RE = /^\/[A-Za-z0-9._~\/-]*\*?$/;
const NAME_MAX = 60;
const ENV_MAX = 64;
// These subdomains belong to the platform. An app that claimed one would emit a
// site file with an address caddy already serves: the config becomes invalid,
// every reload fails from then on, and the gateway can no longer be updated.
export const RESERVED_SLUGS = new Set(["deploy", "auth", "id", "www"]);

const bad = (msg: string): never => {
  throw new Error(msg);
};

export function parseManifest(raw: string): Manifest {
  const m = parse(raw) as Record<string, any>;
  if (!m || typeof m !== "object") bad("manifest must be a yaml object");
  if (!m.slug || !SLUG_RE.test(m.slug)) {
    bad("slug must match [a-z][a-z0-9-]{1,30}");
  }
  if (String(m.slug).replace(/--pr-\d{1,6}$/, "").includes("--")) {
    bad(`slug must not contain "--": that separator is reserved for previews`);
  }
  if (RESERVED_SLUGS.has(m.slug)) {
    bad(`slug "${m.slug}" is reserved by the platform, pick another one`);
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
  if (env.length > ENV_MAX) bad(`at most ${ENV_MAX} env names, got ${env.length}`);
  for (const key of env) {
    if (typeof key !== "string" || !ENV_KEY_RE.test(key)) {
      bad(`env names must match [A-Za-z_][A-Za-z0-9_]* , got: ${String(key).slice(0, 40)}`);
    }
  }

  const roles = [...new Set(Array.isArray(m.roles) ? m.roles : [])];
  if (roles.length > 16) bad(`at most 16 roles, got ${roles.length}`);
  for (const r of roles) {
    if (typeof r !== "string" || !ROLE_RE.test(r)) {
      bad(`role names must match [a-z][a-z0-9_-]*, got: ${String(r).slice(0, 40)}`);
    }
  }
  const protect = (Array.isArray(m.protect) ? m.protect : []).map((p: any) => {
    const path = String(p?.path ?? "");
    const role = String(p?.role ?? "");
    if (!PROTECT_RE.test(path) || path.length > 128) {
      bad(`protect path must start with / and may only end with *, got: ${path.slice(0, 60)}`);
    }
    if (!roles.includes(role)) bad(`protect ${path} needs role "${role}", which is not in roles`);
    return { path, role };
  });
  if (protect.length > 32) bad(`at most 32 protected paths, got ${protect.length}`);

  // build commands run in a sandboxed container; still, one line each, no
  // control characters, and an image name that is only an image name
  const line = (v: unknown, what: string, fallback: string | null) => {
    if (v === undefined || v === null) return fallback;
    const s = String(v);
    if (/[\r\n\0]/.test(s) || s.length > 500) bad(`build.${what} must be a single line of at most 500 characters`);
    return s.trim() || fallback;
  };
  const image = line(m.build?.image, "image", "node:20-bookworm-slim")!;
  if (!/^[a-z0-9][a-z0-9._\/:@-]{0,199}$/.test(image)) bad(`build.image is not an image name: ${image.slice(0, 60)}`);
  const build = {
    image,
    // null: npm ci when a lockfile exists, npm install otherwise
    install: m.build?.install === "" ? "" : line(m.build?.install, "install", null),
    command: line(m.build?.command, "command", "npm run build")!,
  };

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
    roles,
    protect,
    build,
  };
}
