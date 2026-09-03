import { writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { AppRow } from "./db.js";

const CONF_DIR = process.env.CADDY_CONF_DIR ?? "/etc/caddy/conf.d";
const DOMAIN = process.env.APPS_DOMAIN!;

// app.name lands inside an unquoted caddyfile value (sablier display_name):
// braces, $, quotes, backslash and newlines would break the whole config at
// reload. A single bad site file used to take every app down with it.
const cleanName = (s: string) => s.replace(/[\r\n"{}$\\]/g, "").slice(0, 60);
const cleanGroups = (groups: string[]) =>
  groups
    .map((g) => g.replace(/[\r\n"]/g, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&").slice(0, 64))
    .filter((g) => g.length > 0);

export function renderSite(app: AppRow) {
  const host = `${app.slug}.${DOMAIN}`;
  const name = cleanName(app.name);
  const groups = cleanGroups(app.groups);
  const lines: string[] = [`http://${host} {`, `\timport nanoploy_strip`];

  if (app.access !== "public") {
    lines.push(`\timport nanoploy_auth`);
  }
  if (app.access === "groups" && groups.length > 0) {
    // tinyauth already checked the session, this narrows it to the allowed groups
    lines.push(`\t@allowed header_regexp Remote-Groups (^|,)(${groups.join("|")})(,|$)`);
    lines.push(`\thandle @allowed {`);
  }

  const body: string[] = [];
  if (app.port) {
    body.push(`\t\thandle /api/* {`);
    if (!app.warm) {
      // sablier is an unordered directive: it must live inside a route block or
      // the whole site fails to parse (caddy then keeps its previous config and
      // the app silently never gets routed)
      body.push(`\t\t\troute {`);
      body.push(`\t\t\t\tsablier http://sablier:10000 {`);
      body.push(`\t\t\t\t\tgroup ${app.slug}`);
      body.push(`\t\t\t\t\tsession_duration ${app.idle_timeout}`);
      body.push(`\t\t\t\t\tdynamic {`);
      body.push(`\t\t\t\t\t\tdisplay_name ${name}`);
      body.push(`\t\t\t\t\t\ttheme ghost`);
      body.push(`\t\t\t\t\t}`);
      body.push(`\t\t\t\t}`);
      body.push(`\t\t\t\treverse_proxy app-${app.slug}:${app.port}`);
      body.push(`\t\t\t}`);
    } else {
      body.push(`\t\t\treverse_proxy app-${app.slug}:${app.port}`);
    }
    body.push(`\t\t}`);
  }
  body.push(`\t\thandle {`);
  body.push(`\t\t\troot * /srv/apps/${app.slug}/dist`);
  body.push(`\t\t\ttry_files {path} /index.html`);
  body.push(`\t\t\tfile_server`);
  body.push(`\t\t}`);
  lines.push(...body);

  if (app.access === "groups" && groups.length > 0) {
    lines.push(`\t}`);
    lines.push(`\trespond "not allowed for your groups" 403`);
  }
  lines.push(`}`);
  return lines.join("\n") + "\n";
}

export const writeSite = (app: AppRow) =>
  writeFile(join(CONF_DIR, `${app.slug}.caddy`), renderSite(app));

export const removeSite = (slug: string) =>
  unlink(join(CONF_DIR, `${slug}.caddy`)).catch(() => {});
