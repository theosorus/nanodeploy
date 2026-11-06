import { writeFile, unlink, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AppRow } from "./db.js";
import { reloadCaddy } from "./docker.js";

const CONF_DIR = process.env.CADDY_CONF_DIR ?? "/etc/caddy/conf.d";
const DOMAIN = process.env.APPS_DOMAIN!;

// app.name lands inside an unquoted caddyfile value (sablier display_name):
// braces, $, quotes, backslash and newlines would break the whole config at
// reload. A single bad site file used to take every app down with it.
const cleanName = (s: string) => s.replace(/[\r\n"{}$\\]/g, "").slice(0, 60);
// protected paths were validated by the manifest parser; keep the same shape
// here so a hand-edited row can never inject caddyfile syntax
const cleanPaths = (paths: string[]) => paths.filter((p) => /^\/[A-Za-z0-9._~\/-]*\*?$/.test(p));

// The routes of an app once access is settled: its API through sablier to the
// container, everything else from dist/.
function appRoutes(app: AppRow, indent: string): string[] {
  const name = cleanName(app.name);
  const out: string[] = [];
  if (app.port) {
    out.push(`handle /api/* {`);
    // An app never sees the platform's session cookie or a personal access key:
    // gate has read them already, and with them the app could act as its
    // visitor anywhere else. gate's cookies are host-bound since phase 1; the
    // tinyauth ones are kept in the list for installs that still run it.
    out.push(`\timport nanodeploy_hide_session`);
    if (!app.warm) {
      // sablier is an unordered directive: it must live inside a route block or
      // the whole site fails to parse (caddy then keeps its previous config and
      // the app silently never gets routed)
      out.push(`\troute {`);
      out.push(`\t\tsablier http://sablier:10000 {`);
      out.push(`\t\t\tgroup ${app.slug}`);
      out.push(`\t\t\tsession_duration ${app.idle_timeout}`);
      out.push(`\t\t\tdynamic {`);
      out.push(`\t\t\t\tdisplay_name ${name}`);
      out.push(`\t\t\t\ttheme ghost`);
      out.push(`\t\t\t}`);
      out.push(`\t\t}`);
      out.push(`\t\treverse_proxy app-${app.slug}:${app.port}`);
      out.push(`\t}`);
    } else {
      out.push(`\treverse_proxy app-${app.slug}:${app.port}`);
    }
    out.push(`}`);
  }
  out.push(`handle {`);
  // current -> releases/<n>: a deploy or a rollback moves that link in one rename
  out.push(`\troot * /srv/apps/${app.slug}/current/dist`);
  out.push(`\ttry_files {path} /index.html`);
  out.push(`\tfile_server`);
  out.push(`}`);
  return out.map((l) => indent + l);
}

// Who may see what is decided by gate, from the database, on every request:
// changing an app's access or a role grant never rewrites this file. The file
// only says which requests gate must look at.
//  - private and groups apps: every request.
//  - public apps: the API (so the app learns who is signed in, if anyone) and
//    the protected paths. Static files of a public app skip gate entirely.
export function renderSite(app: AppRow) {
  const host = `${app.slug}.${DOMAIN}`;
  const lines: string[] = [`http://${host} {`, `\timport nanodeploy_strip`];
  // sign-in callback, /_nd/me, /_nd/login, /_nd/logout: served by gate on
  // every app host, before any access check
  lines.push(`\thandle /_nd/* {`, `\t\treverse_proxy gate:4000`, `\t}`);

  if (app.access === "public") {
    const gated = ["/api/*", ...cleanPaths((app.protect ?? []).map((r) => r.path))];
    lines.push(`\t@gated path ${[...new Set(gated)].join(" ")}`);
    lines.push(`\thandle @gated {`);
    lines.push(`\t\timport nanodeploy_gate ${app.slug}`);
    lines.push(...appRoutes(app, "\t\t"));
    lines.push(`\t}`);
    lines.push(`\thandle {`);
    lines.push(...appRoutes(app, "\t\t"));
    lines.push(`\t}`);
  } else {
    lines.push(`\thandle {`);
    lines.push(`\t\timport nanodeploy_gate ${app.slug}`);
    lines.push(...appRoutes(app, "\t\t"));
    lines.push(`\t}`);
  }
  lines.push(`}`);
  return lines.join("\n") + "\n";
}

const sitePath = (slug: string) => join(CONF_DIR, `${slug}.caddy`);

export const writeSite = (app: AppRow) => writeFile(sitePath(app.slug), renderSite(app));

export const removeSite = (slug: string) =>
  unlink(sitePath(slug)).catch(() => {});

// Caddy validates the whole config at reload: one unparseable site file makes
// every other site keep its old config, and the bad file stays on disk, so the
// next reload fails too and the gateway is frozen until someone ssh's in.
// Always be able to go back to the config caddy is actually running.
export async function applySite(app: AppRow): Promise<boolean> {
  const path = sitePath(app.slug);
  const previous = await readFile(path, "utf8").catch(() => null);
  await writeFile(path, renderSite(app));
  if (await reloadCaddy()) return true;

  console.error(`caddy refused the new site for ${app.slug}, rolling back`);
  if (previous === null) await unlink(path).catch(() => {});
  else await writeFile(path, previous);
  await reloadCaddy().catch(() => {});
  return false;
}

// Same story on removal: if dropping the file somehow breaks the reload, the
// route must come back rather than leave the gateway stuck.
export async function dropSite(slug: string): Promise<boolean> {
  const path = sitePath(slug);
  const previous = await readFile(path, "utf8").catch(() => null);
  await unlink(path).catch(() => {});
  if (await reloadCaddy()) return true;

  if (previous !== null) await writeFile(path, previous);
  await reloadCaddy().catch(() => {});
  return false;
}
