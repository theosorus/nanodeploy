#!/usr/bin/env node
// Checks the code against what breaks on Nanodeploy: an app that sleeps, runs
// from one bundled file, reaches the internet only through an HTTP/S proxy and
// gets its users from the gateway. Each finding says why and how to fix it.
//
//   npm run doctor     (also part of npm run check and npm run zip)
//
// ERROR: the app will break or be refused. Fix it.
// WARN:  often a mistake, sometimes deliberate. Read it, then decide.
// It reads files with patterns, so it can be fooled; it never replaces reading
// the code. A clean run is a floor, not a proof.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { join, posix, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { readManifest, ZipProblems } from "./zip.mjs";

const PLATFORM_ENV = new Set(["DATABASE_URL", "PORT", "NODE_ENV", "HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "NO_PROXY", "no_proxy", "NODE_USE_ENV_PROXY"]);

// Packages that cannot work here, with the reason and the replacement.
const BLOCKED_DEPS = {
  bcrypt: "native addon, and passwords are the gateway's job",
  argon2: "native addon, and passwords are the gateway's job",
  sharp: "native addon: no image processing on the server, resize in the browser instead",
  canvas: "native addon: draw in the browser instead",
  "better-sqlite3": "native addon, and the database is the shared Postgres (postgres + drizzle-orm)",
  sqlite3: "native addon, and the database is the shared Postgres (postgres + drizzle-orm)",
  prisma: "needs a native query engine the image does not have: use drizzle-orm",
  "@prisma/client": "needs a native query engine the image does not have: use drizzle-orm",
  "pg-native": "native addon: use the postgres package",
  puppeteer: "downloads a browser: impossible in a 256 MB read-only container",
  playwright: "downloads a browser: impossible in a 256 MB read-only container",
  mongodb: "there is no MongoDB on the platform: use Postgres",
  mongoose: "there is no MongoDB on the platform: use Postgres",
  redis: "there is no Redis on the platform: keep state in Postgres",
  ioredis: "there is no Redis on the platform: keep state in Postgres",
  bullmq: "needs Redis and a process that never sleeps",
  "socket.io": "websockets break every time the app sleeps: poll, or use SSE with reconnection",
  ws: "websockets break every time the app sleeps: poll, or use SSE with reconnection",
  next: "server rendering outside /api/* never reaches the app: use Vite + React (static) and Hono under /api",
  nuxt: "server rendering outside /api/* never reaches the app: use Vite + React (static) and Hono under /api",
  "@sveltejs/kit": "server rendering outside /api/* never reaches the app: use Vite + React (static) and Hono under /api",
  "next-auth": "sign-in is done by the gateway: read the user with tryGetUser(c) from server/auth.ts",
  "@auth/core": "sign-in is done by the gateway: read the user with tryGetUser(c) from server/auth.ts",
  passport: "sign-in is done by the gateway: read the user with tryGetUser(c) from server/auth.ts",
  "express-session": "sign-in is done by the gateway, and memory sessions die with every sleep",
  "node-cron": "a sleeping app runs nothing: no scheduler inside the app",
  cron: "a sleeping app runs nothing: no scheduler inside the app",
  agenda: "a sleeping app runs nothing: no scheduler inside the app",
  nodemailer: "SMTP ports are blocked (only HTTP 80 and HTTPS 443 go out): send email through an HTTPS email API with fetch",
};
const SUSPECT_DEPS = {
  express: "works once bundled, but new apps use Hono like the template: do not add a second framework",
  jsonwebtoken: "only to call an external API; never to sign users in (the gateway does that)",
  bcryptjs: "only if you really store a non-login secret; user passwords are the gateway's job",
  dotenv: "does nothing in production: values are typed in the dashboard and arrive as environment variables",
  axios: "make sure it goes through the egress proxy (Node's fetch does it automatically); prefer fetch",
  "@tailwindcss/vite": "the template's design system is styles.css (shared) + theme.css (per app), not Tailwind",
  tailwindcss: "the template's design system is styles.css (shared) + theme.css (per app), not Tailwind",
};
const CDN = /(fonts\.googleapis\.com|fonts\.gstatic\.com|cdn\.jsdelivr\.net|unpkg\.com|cdnjs\.cloudflare\.com|use\.typekit\.net|cdn\.tailwindcss\.com|kit\.fontawesome\.com)/;

const findings = [];
const add = (level, file, line, message) => findings.push({ level, file, line, message });

// Blank out comments but keep line numbers, so commented-out code and prose
// about setInterval do not count. Strings are kept: routes live in them.
function stripComments(code) {
  let out = "";
  let i = 0;
  let quote = null;
  while (i < code.length) {
    const ch = code[i], next = code[i + 1];
    if (quote) {
      out += ch;
      if (ch === "\\") { out += code[i + 1] ?? ""; i += 2; continue; }
      if (ch === quote) quote = null;
      i++;
    } else if (ch === "/" && next === "/") {
      while (i < code.length && code[i] !== "\n") { out += " "; i++; }
    } else if (ch === "/" && next === "*") {
      while (i < code.length && !(code[i] === "*" && code[i + 1] === "/")) { out += code[i] === "\n" ? "\n" : " "; i++; }
      out += "  "; i += 2;
    } else {
      if (ch === '"' || ch === "'" || ch === "`") quote = ch;
      out += ch; i++;
    }
  }
  return out;
}

const lineOf = (text, index) => text.slice(0, index).split("\n").length;
function each(text, re, fn) {
  const global = re.global ? re : new RegExp(re.source, re.flags + "g");
  for (const m of text.matchAll(global)) fn(m, lineOf(text, m.index));
}

async function files(root, dir, exts) {
  const out = [];
  const full = join(root, dir);
  if (!existsSync(full)) return out;
  for (const entry of await readdir(full, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const rel = posix.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await files(root, rel, exts));
    else if (exts.some((e) => entry.name.endsWith(e))) out.push(rel);
  }
  return out;
}

export async function doctor(root = process.cwd()) {
  findings.length = 0;
  let manifest;
  try {
    ({ manifest } = await readManifest(root));
  } catch (err) {
    if (!(err instanceof ZipProblems)) throw err;
    for (const p of err.problems) add("ERROR", "app.yaml", 0, p);
    return findings;
  }
  const raw = await readFile(join(root, "app.yaml"), "utf8");
  if (/^slug:\s*mon-app\b/m.test(raw)) add("ERROR", "app.yaml", 0, `slug is still the template's "mon-app": choose this app's own slug (it becomes <slug>.<domain>)`);
  if (/^name:\s*Mon app\s*$/m.test(raw)) add("ERROR", "app.yaml", 0, `name is still the template's "Mon app": write this app's name`);

  // dependencies end up in server.js; devDependencies only run at build time
  const pkgPath = join(root, "package.json");
  if (existsSync(pkgPath)) {
    // Windows PowerShell 5.1 writes UTF-8 with a byte-order mark; npm accepts it
    const pkg = JSON.parse((await readFile(pkgPath, "utf8")).replace(/^﻿/, ""));
    for (const dep of Object.keys(pkg.dependencies ?? {})) {
      if (BLOCKED_DEPS[dep]) add("ERROR", "package.json", 0, `dependency ${dep}: ${BLOCKED_DEPS[dep]}`);
      else if (SUSPECT_DEPS[dep]) add("WARN", "package.json", 0, `dependency ${dep}: ${SUSPECT_DEPS[dep]}`);
    }
    for (const dep of Object.keys(pkg.devDependencies ?? {})) {
      if (SUSPECT_DEPS[dep] && dep.includes("tailwind")) add("WARN", "package.json", 0, `devDependency ${dep}: ${SUSPECT_DEPS[dep]}`);
    }
    if (manifest.backend && !/esbuild[^"]*--bundle/.test(pkg.scripts?.build ?? "")) {
      add("WARN", "package.json", 0, `the build script does not bundle the server with esbuild --bundle: the image only holds ${manifest.backend.entry}, without node_modules`);
    }
  }

  const declared = new Set(manifest.env);
  const serverFiles = await files(root, "server", [".ts", ".js", ".mjs", ".mts"]);
  const usesRouteApi = [];
  for (const rel of serverFiles) {
    const code = stripComments(await readFile(join(root, rel), "utf8"));

    each(code, /\bsetInterval\s*\(|\bcron\.schedule\s*\(/g, (_m, line) => add(manifest.warm ? "WARN" : "ERROR", rel, line,
      manifest.warm
        ? "periodic timer: allowed because idle.warm is true, but it restarts with the container and must tolerate missed runs"
        : "periodic timer: the app is stopped when idle, so this never runs reliably. Do the work when a request arrives, or set idle.warm: true and tell the user it then runs permanently (~40 MB)"));
    each(code, /\bsetTimeout\s*\([^;]*?,\s*(\d{5,})\s*\)/g, (m, line) => add("WARN", rel, line,
      `setTimeout of ${m[1]} ms: the container may be stopped before it fires. Store the due date in the database instead`));
    each(code, /\bupgradeWebSocket\b|\bWebSocketServer\b|\bnew\s+WebSocket\s*\(/g, (_m, line) => add("ERROR", rel, line,
      "websocket: every sleep cuts it, and Caddy only proxies plain HTTP to /api/*. Poll, or use SSE with reconnection"));
    each(code, /\bpostgres\s*\(([^)]*)\)/g, (m, line) => {
      if (!/\bmax\s*:\s*[123]\b/.test(m[1])) add("ERROR", rel, line, "Postgres pool without max: 3. The database is shared by every app; set { max: 3, idle_timeout: 20 }");
    });
    each(code, /\bnew\s+Pool\s*\(([^)]*)\)/g, (m, line) => {
      if (!/\bmax\s*:\s*[123]\b/.test(m[1])) add("ERROR", rel, line, "Postgres pool without max: 3. The database is shared by every app");
    });
    each(code, /process\.env\.([A-Za-z_][A-Za-z0-9_]*)/g, (m, line) => {
      const key = m[1];
      if (key === "DATABASE_URL" && !manifest.database.enabled) add("ERROR", rel, line, "DATABASE_URL is only set when app.yaml has database: { enabled: true }");
      else if (!PLATFORM_ENV.has(key) && !declared.has(key)) add("ERROR", rel, line,
        `process.env.${key} is never set: add ${key} to env in app.yaml, then the user types its value in the dashboard (the app's Settings)`);
    });
    each(code, /\b(?:writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream|mkdir|mkdirSync)\s*\(\s*["'`]([^"'`]+)["'`]/g, (m, line) => {
      if (!m[1].startsWith("/data") && !m[1].startsWith("/tmp")) add("WARN", rel, line,
        `writes to ${m[1]}: the container is read-only except /data (kept) and /tmp (16 MB, wiped on every wake)`);
    });
    each(code, /\b(?:readFile|readFileSync|createReadStream)\s*\(\s*(?:["'`]\.{1,2}\/|path\.join\(\s*__dirname|new URL\()/g, (_m, line) => add("WARN", rel, line,
      "reads a file next to the code: the image holds only the bundled server file. Import the data instead (esbuild inlines JSON), or read it from /data"));
    each(code, /pgTable\(\s*["'](users|accounts|sessions)["']/g, (m, line) => add("WARN", rel, line,
      `table "${m[1]}": accounts and sign-in belong to the gateway. Keep only app data keyed by ownerId (a "profiles" table keyed by ownerId is fine)`));
    each(code, /\.(get|post|put|patch|delete|all)\(\s*["'`](\/[^"'`]*)["'`]/g, (m, line) => {
      if (!m[2].startsWith("/api/") && m[2] !== "/api") usesRouteApi.push({ rel, line, path: m[2], code });
    });
    each(code, /^(?:let|var)\s+[A-Za-z_$][\w$]*\s*(?:=|;)|^(?:const|let)\s+[A-Za-z_$][\w$]*\s*=\s*new\s+(?:Map|Set|Array)\b/gm, (_m, line) => add("WARN", rel, line,
      "module-level mutable state: lost at every sleep and wrong as soon as it should be shared. Keep state in Postgres"));
    if (/\bserve\s*\(/.test(code) && !/process\.env\.PORT/.test(code)) add("WARN", rel, 0, "the server should listen on Number(process.env.PORT ?? 3000)");
  }
  const mounted = serverFiles.length && (await Promise.all(serverFiles.map((f) => readFile(join(root, f), "utf8"))))
    .some((c) => /\.route\(\s*["'`]\/api|basePath\(\s*["'`]\/api/.test(c));
  if (!mounted) for (const r of usesRouteApi) add("WARN", r.rel, r.line,
    `route ${r.path} is outside /api/*: Caddy only sends /api/* to the backend, everything else is served from dist/`);

  const schemaPath = join(root, "server", "schema.ts");
  if (existsSync(schemaPath)) {
    const schema = stripComments(await readFile(schemaPath, "utf8"));
    each(schema, /export\s+const\s+(\w+)\s*=\s*pgTable\(\s*["'](\w+)["']\s*,\s*\{([\s\S]*?)\}\s*[,)]/g, (m, line) => {
      if (!/owner_?id/i.test(m[3])) add("WARN", "server/schema.ts", line,
        `table ${m[2]} has no ownerId column. If its rows belong to a person, add ownerId: text("owner_id").notNull() and filter every read and write on it`);
    });
  }

  const webFiles = [...await files(root, "src", [".ts", ".tsx", ".js", ".jsx", ".css"]), ...(existsSync(join(root, "index.html")) ? ["index.html"] : [])];
  const allowedFetch = new Set(["src/client.ts", "src/identity.ts", "src/analytics.ts"]);
  for (const rel of webFiles) {
    const original = await readFile(join(root, rel), "utf8");
    const code = rel.endsWith(".css") || rel.endsWith(".html") ? original : stripComments(original);
    each(code, CDN, (m, line) => add("ERROR", rel, line,
      `loads from ${m[1]}: self-host the file next to the app (fonts: a .woff2 + @font-face in theme.css). Apps must work offline from third parties and must not leak visitors`));
    if (rel.endsWith(".css") || rel.endsWith(".html")) continue;
    each(code, /dangerouslySetInnerHTML|\.innerHTML\s*=/g, (_m, line) => add("ERROR", rel, line,
      "raw HTML from data is an injection. Render text with React; it escapes for you"));
    each(code, /\bfetch\s*\(\s*["'`]\/api/g, (_m, line) => add("ERROR", rel, line,
      "bare fetch to /api: the first call after a sleep gets an HTML waiting page and this breaks. Use api() from src/client.ts"));
    if (!allowedFetch.has(rel)) each(code, /\bfetch\s*\((?!\s*["'`]\/api)/g, (_m, line) => add("WARN", rel, line,
      "fetch outside src/client.ts: calls to this app's /api must go through api() so the wake-up page is retried"));
    each(code, /new\s+WebSocket\s*\(/g, (_m, line) => add("ERROR", rel, line, "websocket: it is cut every time the app sleeps. Poll, or use EventSource with reconnection"));
    each(code, /import\.meta\.env\.(\w+)/g, (m, line) => {
      if (!["MODE", "DEV", "PROD", "BASE_URL", "SSR"].includes(m[1])) add("WARN", rel, line,
        `import.meta.env.${m[1]} is frozen into the public bundle at build time and the dashboard values never reach it. Never put a secret there; read config through an /api route`);
    });
    each(code, /localStorage\.setItem\(\s*["'`][^"'`]*(token|password|secret)/gi, (_m, line) => add("WARN", rel, line,
      "a credential in localStorage: the gateway already signs people in, the app needs no token"));
  }

  const theme = join(root, "src", "theme.css");
  if (existsSync(theme) && /"instrument panel"/.test(await readFile(theme, "utf8"))) {
    add("WARN", "src/theme.css", 0, "still the template's art direction: rewrite theme.css for this app (colours, faces, shape, one signature)");
  }
  const index = join(root, "index.html");
  if (existsSync(index) && /<title>Notes<\/title>/.test(await readFile(index, "utf8"))) {
    add("WARN", "index.html", 0, "the page title is still the template's \"Notes\"");
  }
  if (manifest.backend) await bootCheck(root, manifest);
  return findings;
}

const canConnect = (port) => new Promise((done) => {
  const socket = createConnection({ host: "127.0.0.1", port });
  socket.once("connect", () => { socket.destroy(); done(true); });
  socket.once("error", () => done(false));
});

// A deploy never starts the server, so a crash at boot only shows on the first
// visit. Start the built file the way the platform will: production mode, the
// PORT it is given, and none of the env values the user has not typed yet.
async function bootCheck(root, manifest) {
  const entry = manifest.backend.entry;
  if (!existsSync(join(root, entry))) return; // not built yet: npm run check builds first
  const port = 20000 + Math.floor(Math.random() * 30000);
  const env = { PATH: process.env.PATH ?? "", NODE_ENV: "production", PORT: String(port) };
  if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot; // Windows needs it to start node
  // nothing listens on port 9: a query fails fast, a lazy client never notices
  if (manifest.database.enabled) env.DATABASE_URL = "postgres://doctor:doctor@127.0.0.1:9/doctor";
  const child = spawn(process.execPath, [entry], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (d) => { output += d; });
  child.stderr.on("data", (d) => { output += d; });
  const exited = new Promise((done) => child.once("exit", (code) => done({ code })));
  let listening = false;
  let exit = null;
  for (const deadline = Date.now() + 8000; Date.now() < deadline && !listening;) {
    exit = await Promise.race([exited, new Promise((done) => setTimeout(() => done(null), 250))]);
    if (exit) break;
    listening = await canConnect(port);
  }
  child.kill();
  // the thrown message, not just the stack: "Error: STRIPE_KEY missing"
  const lines = output.trim().split(/\r?\n/);
  const at = lines.findIndex((l) => /^\w*(Error|Exception)\b/.test(l.trim()));
  const tail = (at >= 0 ? lines.slice(at, at + 3) : lines.slice(-4)).join("\n    ");
  if (exit) {
    add("ERROR", entry, 0, `crashed at start (exit code ${exit.code}) with no env values set. On the platform it would fail on its first visit. ` +
      `Do no work at import time: read env values and call external services inside the routes.${tail ? `\n    ${tail}` : ""}`);
  } else if (!listening) {
    add("WARN", entry, 0, `did not listen on PORT within 8 seconds. It must call serve({ fetch: app.fetch, port: Number(process.env.PORT ?? 3000) }) quickly, with no warm-up`);
  }
}

async function main() {
  const root = resolve(process.cwd());
  const found = await doctor(root);
  const errors = found.filter((f) => f.level === "ERROR");
  const warns = found.filter((f) => f.level === "WARN");
  for (const f of [...errors, ...warns]) {
    console.log(`${f.level.padEnd(5)} ${f.file}${f.line ? `:${f.line}` : ""}  ${f.message}`);
  }
  console.log(`doctor: ${errors.length} error(s), ${warns.length} warning(s)${errors.length ? ". Fix every ERROR, then run it again." : "."}`);
  if (errors.length) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
