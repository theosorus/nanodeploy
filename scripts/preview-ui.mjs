// Local UI sandbox. All API responses are fixtures held in memory; no Docker,
// database, credentials or deployed applications are used.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve, extname, sep } from "node:path";

const root = resolve(fileURLToPath(new URL("../control-plane/public/", import.meta.url)));
const port = Number(process.env.UI_PREVIEW_PORT || 4173);
const at = (hours = 0) => new Date(Date.now() - hours * 36e5).toISOString();
const apps = [
  { slug: "finances", name: "Finances", status: "awake", access: "private", memory: 72e6, release: 12, deployedAt: at(2), hasDatabase: true, envKeys: ["OPENAI_API_KEY"], env: { OPENAI_API_KEY: "set" }, roles: ["moderator"], protect: [{ path: "/api/admin/*", role: "moderator" }] },
  { slug: "carnet", name: "Carnet", status: "sleeping", access: "groups", groups: ["Famille"], release: 4, deployedAt: at(24), hasDatabase: true },
  { slug: "recettes", name: "Recettes", status: "sleeping", access: "private", release: 8, deployedAt: at(48), hasDatabase: true },
  { slug: "portfolio", name: "Portfolio", status: "static", access: "public", release: 3, deployedAt: at(72), hasBackend: false },
  { slug: "pulse", name: "Pulse", status: "awake", access: "private", memory: 41e6, release: 6, deployedAt: at(96), warm: true },
  { slug: "atelier", name: "Atelier", status: "missing", access: "private", release: 2, deployedAt: at(120), envKeys: ["API_KEY"], env: { API_KEY: "unset" } },
].map((a) => ({ groups: [], hasBackend: true, hasDatabase: false, warm: false, idleTimeout: "10m", envKeys: [], env: {}, memory: null, roles: [], protect: [], ...a }));

const people = [
  { id: "u1", username: "alex", displayName: "Alex Martin", email: "alex@example.test", isAdmin: true, groups: ["Famille"], hasPassword: true, passkeys: 1, lastLogin: at(0) },
  { id: "u2", username: "camille", displayName: "Camille Dupont", email: "camille@example.test", isAdmin: false, groups: ["Famille"], hasPassword: true, passkeys: 1, lastLogin: at(3) },
  { id: "u3", username: "sam", displayName: "Sam Laurent", email: "sam@example.test", isAdmin: false, groups: [], hasPassword: false, passkeys: 0, lastLogin: null },
];
const groups = [{ id: "g1", name: "Famille" }, { id: "g2", name: "Amis" }];
const keys = {};
const grants = {};
const pending = new Map();
const releases = Object.fromEntries(apps.map((a) => [a.slug, [0, 1, 2].map((i) => ({
  id: String(a.release * 10 - i), number: a.release - i, source: i ? "upload" : "git",
  message: ["Une navigation plus simple", "Améliorations et correctifs", "Première version"][i],
  commitMessage: null, commitSha: i ? null : "7e9bc42d0f1623", status: i ? "superseded" : "live",
  createdAt: at(i * 24 + 2), createdBy: "Alex", rollback: { filesKept: true, migrationsAhead: [], snapshot: false },
}))]));
const git = {
  ready: true, consoleOrigin: `http://127.0.0.1:${port}`,
  providers: [{ id: "p1", name: "maison", kind: "github" }],
  connections: [{ id: "c1", slug: "finances", repo: "maison/finances", branch: "main", root_dir: ".", previews: true }],
  builds: [
    { id: "12", target_slug: "finances", kind: "production", ref: "main", sha: "7e9bc42d0f1623", message: "Une navigation plus simple", author: "Alex", status: "succeeded", release: 12, created_at: at(2) },
    { id: "11", target_slug: "finances", kind: "production", ref: "main", sha: "aa2bc42d0f1623", message: "Améliorations et correctifs", author: "Alex", status: "failed", release: null, created_at: at(26) },
  ],
};

function analytics(a, range) {
  const now = Date.now();
  const hours = range === "24h" ? 24 : range === "7d" ? 168 : 720;
  return {
    name: a.name, slug: a.slug, range, unit: range === "30d" ? "day" : "hour", timezone: "Europe/Paris", online: 2,
    totals: { visitors: 128, pages: 346, requests: 1098, errors: 2, p95: 84, wakes: 8, coldStartMedian: 740 },
    series: Array.from({ length: range === "30d" ? 30 : hours }, (_, i) => ({ t: new Date(now - (hours - i - 1) * 36e5).toISOString(), visitors: 4 + (i * 7 % 19), pages: 8 + (i * 11 % 32), requests: 25 + i % 18, errors: 0 })),
    timeline: { from: now - hours * 36e5, to: now, awake: [{ from: now - hours * 24e5, to: now - hours * 6e5 }], markers: [{ at: at(2), kind: "deploy", detail: { release: a.release } }] },
    memory: Array.from({ length: 16 }, (_, i) => ({ t: new Date(now - (15 - i) * 36e5).toISOString(), mem: 42e6 + (i * 7 % 29) * 1e6 })),
    limit: 256 * 1048576,
    top: { pages: [{ key: "/", n: 180 }, { key: "/dashboard", n: 96 }, { key: "/settings", n: 70 }], referrers: [{ key: "Direct", n: 110 }, { key: "google.com", n: 18 }], countries: [{ key: "France", n: 104 }, { key: "Belgique", n: 24 }], devices: [{ key: "Desktop", n: 85 }, { key: "Mobile", n: 43 }], browsers: [{ key: "Chrome", n: 76 }, { key: "Safari", n: 52 }] },
    people: null,
  };
}

async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks);
  return req.headers["content-type"]?.includes("application/json") ? JSON.parse(raw.toString() || "{}") : raw;
}

async function api(req, url) {
  const path = url.pathname;
  const data = req.method === "GET" ? {} : await body(req);
  if (path === "/api/me") return { name: "Alex Martin", email: "alex@example.test", sub: "u1", domain: "apps.maison.test", admin: true };
  if (path === "/api/apps") return { apps, host: { total: 4e9, used: 1.4e9 } };
  if (path === "/api/people") {
    if (req.method === "POST") {
      people.push({ id: `u${Date.now()}`, username: data.username, displayName: data.username, email: data.email, groups: [], isAdmin: false, hasPassword: false, passkeys: 0 });
      return { link: `http://127.0.0.1:${port}/preview-invitation`, ok: true };
    }
    return { configured: true, people, groups };
  }
  if (path === "/api/groups" && req.method === "POST") { groups.push({ id: `g${Date.now()}`, name: data.name }); return { ok: true }; }
  const person = path.match(/^\/api\/people\/([^/]+)(?:\/(.*))?$/);
  if (person) {
    const p = people.find((p) => p.id === person[1]);
    if (person[2] === "admin") p.isAdmin = data.admin;
    if (person[2] === "groups") p.groups = groups.filter((g) => data.groupIds.includes(g.id)).map((g) => g.name);
    if (person[2] === "link") return { link: `http://127.0.0.1:${port}/preview-invitation` };
    if (req.method === "DELETE") people.splice(people.indexOf(p), 1);
    return { ok: true };
  }
  const group = path.match(/^\/api\/groups\/([^/]+)$/);
  if (group) {
    const g = groups.find((g) => g.id === group[1]);
    if (req.method === "DELETE") groups.splice(groups.indexOf(g), 1);
    else g.name = data.name;
    return { ok: true };
  }
  if (path === "/api/git") return git;
  if (path.startsWith("/api/git/builds/")) return { log: ["Installing dependencies…", "Build completed."] };
  if (path.endsWith("/repos")) return { repos: [{ id: "r1", fullName: "maison/finances", defaultBranch: "main" }] };
  if (path === "/api/git/connections" && req.method === "POST") {
    git.connections.push({ id: `c${Date.now()}`, slug: "finances", repo: "maison/finances", branch: data.branch, root_dir: data.rootDir, previews: data.previews });
    return { ok: true };
  }
  const connection = path.match(/^\/api\/git\/connections\/([^/]+)$/);
  if (connection) {
    const c = git.connections.find((c) => c.id === connection[1]);
    if (req.method === "DELETE") git.connections.splice(git.connections.indexOf(c), 1);
    if (req.method === "PATCH") c.previews = data.previews;
    return { ok: true };
  }
  if (path.startsWith("/api/git/")) return { ok: true, lines: ["Installing dependencies…", "Build completed."] };
  if (path === "/api/analytics") return { timezone: "Europe/Paris", apps: apps.map((a, i) => ({ slug: a.slug, name: a.name, online: i ? 0 : 2, visitorsToday: 128 - i * 18, pagesToday: 346 - i * 43, week: [12, 28, 19, 41, 24, 38, 34], wakesToday: 8, awakeShare: 0.23, errorsToday: i ? 0 : 2 })) };
  if (path === "/api/releases" && req.method === "POST") {
    const slug = url.searchParams.get("expect") || "finances";
    const a = apps.find((a) => a.slug === slug);
    const id = String(Date.now());
    pending.set(id, a);
    return { release: { id, slug }, diff: { isNew: false, name: a.name, from: a.release, to: a.release + 1, files: { total: 31, added: 2, changed: 4, removed: 0 }, server: { from: 12000, to: 14000 }, migrations: [], databaseCreated: false, backend: null, warm: null, envToSet: [], envDropped: [], access: null, rolesAdded: [], rolesRemoved: [], protectChanged: false } };
  }
  const promotion = path.match(/^\/api\/releases\/([^/]+)\/(promote|discard)$/);
  if (promotion) {
    const a = pending.get(promotion[1]);
    pending.delete(promotion[1]);
    if (promotion[2] === "discard") return { ok: true };
    a.release++;
    a.deployedAt = at();
    releases[a.slug].forEach((r) => { r.status = "superseded"; });
    releases[a.slug].unshift({ ...releases[a.slug][0], id: promotion[1], number: a.release, status: "live", source: "upload", createdAt: at(), message: "Nouvelle version" });
    return { ok: true, release: a.release, url: `https://${a.slug}.apps.maison.test`, log: ["Version prête."] };
  }
  const app = path.match(/^\/api\/apps\/([^/]+)(?:\/(.*))?$/);
  if (app) {
    const slug = app[1], action = app[2];
    const a = apps.find((a) => a.slug === slug);
    if (action === "keys") {
      if (req.method === "POST") {
        const key = `ndd_preview_${Date.now()}`;
        (keys[slug] ||= []).push({ id: String(Date.now()), hint: "ndd_preview…", label: data.label || "Preview", last_used_at: null });
        return { key };
      }
      return { keys: keys[slug] || [] };
    }
    if (!a) throw new Error("Unknown preview app");
    if (action === "logs") return { lines: ["[server] Listening on port 3000", "[database] Connected", "[request] GET /api/health 200 12ms", "[request] GET /api/items 200 24ms", "[request] POST /api/items 201 18ms"] };
    if (action === "releases") return { releases: releases[slug] || [] };
    if (action?.startsWith("releases/")) return { log: ["Archive received.", "Image built.", "Migrations applied.", "Version is live."], ok: true };
    if (action === "roles") {
      if (req.method === "POST") {
        const other = (grants[slug] || []).filter((g) => !(g.role === data.role && g.kind === data.kind && g.id === data.id));
        grants[slug] = data.granted ? [...other, { role: data.role, kind: data.kind, id: data.id }] : other;
      }
      return { grants: grants[slug] || [] };
    }
    if (action === "analytics") return analytics(a, url.searchParams.get("range") || "24h");
    if (action === "access") { a.access = data.access; a.groups = data.groups; }
    if (action === "env") for (const k of Object.keys(data)) a.env[k] = "set";
    if (action === "wake") { a.status = "awake"; a.memory = 41e6; }
    if (action?.startsWith("keys/") && req.method === "DELETE") keys[slug] = (keys[slug] || []).filter((k) => k.id !== action.split("/")[1]);
    if (!action && req.method === "DELETE") apps.splice(apps.indexOf(a), 1);
    return { ok: true };
  }
  throw new Error(`No preview fixture for ${req.method} ${path}`);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  res.setHeader("Cache-Control", "no-store");
  try {
    if (url.pathname.startsWith("/api/")) {
      const result = await api(req, url);
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(result));
      return;
    }
    const filename = resolve(root, `.${url.pathname === "/" ? "/index.html" : url.pathname}`);
    if (!filename.startsWith(root + sep) && filename !== resolve(root, "index.html")) { res.writeHead(403).end(); return; }
    const file = await readFile(filename);
    res.setHeader("Content-Type", ({ ".html": "text/html; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".webmanifest": "application/manifest+json" })[extname(filename)] || "application/octet-stream");
    res.end(file);
  } catch (err) {
    res.writeHead(url.pathname.startsWith("/api/") ? 400 : 404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: err.message }));
  }
});
server.listen(port, "127.0.0.1", () => console.log(`UI preview: http://127.0.0.1:${port} (fixtures only)`));
