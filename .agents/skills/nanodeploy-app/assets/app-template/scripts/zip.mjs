#!/usr/bin/env node
// Packs this app for Nanodeploy. No dependency and no `zip` binary, so it gives
// the same archive on Linux, macOS, Windows and inside agent sandboxes.
//
//   npm run zip                      check, build, then write both archives
//   npm run zip -- --out-dir <dir>   write them somewhere else
//   npm run zip -- --deploy-only     skip the source archive
//
// <slug>-deploy.zip is what the platform runs: app.yaml, dist/, server.js and
// migrations/ at the top level of the archive, never inside a folder. Drop it
// on the dashboard (New application > ZIP archive) or let `npm run deploy`
// upload it.
// <slug>-source.zip is the project itself, inside a <slug>/ folder, to change
// the app later or push it to a Git repository. The platform refuses it.
//
// The checks below mirror the server's own (control-plane/src/bundle.ts and
// manifest.ts), so a mistake shows up here, with a fix, instead of after an
// upload. The server stays the authority.
import * as zlib from "node:zlib";
import { builtinModules } from "node:module";
import { existsSync } from "node:fs";
import { lstat, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, posix, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Server limits, from control-plane/src/bundle.ts.
const MAX_ZIP_BYTES = 100 * 1024 * 1024;
const MAX_UNPACKED_BYTES = 512 * 1024 * 1024;
const MAX_ENTRIES = 5000;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 64 * 1024;

const RESERVED_SLUGS = new Set(["deploy", "auth", "id", "www"]);
const PLATFORM_ENV = new Set(["DATABASE_URL", "PORT", "HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy", "NO_PROXY", "no_proxy", "NODE_USE_ENV_PROXY"]);
// Never copied into the source archive: build output, dependencies, secrets.
const SOURCE_SKIP_DIRS = new Set(["node_modules", ".git", "dist", ".vite", "coverage", ".turbo"]);
const SOURCE_SKIP_FILE = (name) => name.endsWith(".zip") || name === ".DS_Store" || name.endsWith(".log") ||
  ((name === ".env" || name.startsWith(".env.")) && name !== ".env.example");

export class ZipProblems extends Error {
  constructor(problems) {
    super(problems.join("\n"));
    this.problems = problems;
  }
}

/* ---------- app.yaml: the small subset of YAML the template uses ---------- */

// A full YAML parser would be a dependency. app.yaml stays in the plain
// `key: value` form of the template; anything fancier is reported with its line.
function stripComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "#" && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i);
  }
  return line;
}

function splitFlow(inner, at) {
  const parts = [];
  let depth = 0, quote = null, start = 0;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (quote) { if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "[" || ch === "{") depth++;
    else if (ch === "]" || ch === "}") depth--;
    else if (ch === "," && depth === 0) { parts.push(inner.slice(start, i)); start = i + 1; }
  }
  if (quote || depth !== 0) throw new Error(`app.yaml line ${at}: unbalanced quotes or brackets`);
  parts.push(inner.slice(start));
  return parts.map((p) => p.trim()).filter(Boolean);
}

function scalar(raw, at) {
  const s = raw.trim();
  if (s === "" || s === "~" || s === "null") return null;
  if (s.startsWith("[")) {
    if (!s.endsWith("]")) throw new Error(`app.yaml line ${at}: keep a [list] on one line`);
    return splitFlow(s.slice(1, -1), at).map((p) => scalar(p, at));
  }
  if (s.startsWith("{")) {
    if (!s.endsWith("}")) throw new Error(`app.yaml line ${at}: keep a { map } on one line`);
    const out = {};
    for (const part of splitFlow(s.slice(1, -1), at)) {
      const colon = part.indexOf(":");
      if (colon < 1) throw new Error(`app.yaml line ${at}: expected key: value inside { }`);
      out[part.slice(0, colon).trim()] = scalar(part.slice(colon + 1), at);
    }
    return out;
  }
  if (s.startsWith('"')) {
    try { return JSON.parse(s); } catch { throw new Error(`app.yaml line ${at}: bad double-quoted string`); }
  }
  if (s.startsWith("'")) {
    if (!s.endsWith("'") || s.length < 2) throw new Error(`app.yaml line ${at}: bad single-quoted string`);
    return s.slice(1, -1).replace(/''/g, "'");
  }
  if (s === "|" || s === ">" || s.startsWith("&") || s.startsWith("*")) {
    throw new Error(`app.yaml line ${at}: block scalars and anchors are not supported, use plain values`);
  }
  if (s === "true") return true;
  if (s === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  return s;
}

export function parseYaml(text) {
  text = text.replace(/^﻿/, ""); // byte-order mark from Windows editors
  if (text.includes("\t")) throw new Error("app.yaml contains a tab: indent with spaces only");
  const lines = text.split(/\r?\n/)
    .map((raw, i) => ({ at: i + 1, text: stripComment(raw).replace(/\s+$/, "") }))
    .filter((l) => l.text.trim() !== "" && l.text.trim() !== "---");
  let i = 0;
  const indent = (l) => l.text.length - l.text.trimStart().length;
  const isItem = (l) => /^-(\s|$)/.test(l.text.trimStart());

  function list(level) {
    const out = [];
    while (i < lines.length && indent(lines[i]) === level && isItem(lines[i])) {
      const { at, text: t } = lines[i++];
      const rest = t.trimStart().slice(1).trim();
      if (rest === "") throw new Error(`app.yaml line ${at}: write the item on the same line as its dash`);
      if (/^[A-Za-z_][\w.-]*\s*:(\s|$)/.test(rest)) {
        throw new Error(`app.yaml line ${at}: write a map item on one line, like - { path: /api/admin/*, role: moderator }`);
      }
      out.push(scalar(rest, at));
    }
    return out;
  }

  function map(level) {
    const out = {};
    while (i < lines.length && indent(lines[i]) === level) {
      const { at, text: t } = lines[i];
      if (isItem(lines[i])) throw new Error(`app.yaml line ${at}: unexpected list item`);
      const m = t.trim().match(/^([A-Za-z_][\w.-]*)\s*:(?:\s+(.*))?$/);
      if (!m) throw new Error(`app.yaml line ${at}: expected key: value`);
      i++;
      if (Object.hasOwn(out, m[1])) throw new Error(`app.yaml line ${at}: ${m[1]} is defined twice`);
      if (m[2] === undefined || m[2] === "") {
        const next = lines[i];
        if (next && indent(next) > level) out[m[1]] = isItem(next) ? list(indent(next)) : map(indent(next));
        else if (next && indent(next) === level && isItem(next)) out[m[1]] = list(level);
        else out[m[1]] = null;
      } else out[m[1]] = scalar(m[2], at);
    }
    if (i < lines.length && indent(lines[i]) > level) throw new Error(`app.yaml line ${lines[i].at}: unexpected indentation`);
    return out;
  }

  if (!lines.length) throw new Error("app.yaml is empty");
  const root = map(indent(lines[0]));
  if (i < lines.length) throw new Error(`app.yaml line ${lines[i].at}: unexpected indentation`);
  return root;
}

// The same rules as control-plane/src/manifest.ts, with a fix for each.
export function checkManifest(m) {
  const problems = [];
  const slugOk = typeof m.slug === "string" && /^[a-z][a-z0-9-]{0,29}[a-z0-9]$/.test(m.slug) && !m.slug.includes("--");
  if (!slugOk) problems.push(`slug "${m.slug ?? ""}" is invalid: 2 to 31 characters, lowercase letters, digits and single dashes, starting with a letter (example: expense-tracker)`);
  else if (RESERVED_SLUGS.has(m.slug)) problems.push(`slug "${m.slug}" is reserved by the platform (deploy, auth, id, www): pick another one`);
  const access = m.access ?? "private";
  if (!["public", "private", "groups"].includes(access)) problems.push(`access must be public, private or groups, not "${access}"`);
  if (access === "groups" && !(Array.isArray(m.groups) && m.groups.length)) problems.push("access: groups needs a non-empty groups list, e.g. groups: [family]");
  for (const key of ["groups", "env", "roles", "protect"]) {
    if (m[key] != null && !Array.isArray(m[key])) problems.push(`${key} must be a list, e.g. ${key}: []`);
  }
  for (const key of ["database", "idle", "build"]) {
    if (m[key] != null && (typeof m[key] !== "object" || Array.isArray(m[key]))) problems.push(`${key} must be a map of settings`);
  }
  if (m.backend != null && m.backend !== false && (typeof m.backend !== "object" || Array.isArray(m.backend))) problems.push("backend must be a map (entry, port) or false");
  if (m.frontend != null && typeof m.frontend !== "boolean") problems.push("frontend must be true or false");
  const entry = String(m.backend?.entry ?? "server.js");
  if (!/^[A-Za-z0-9_.\/-]+$/.test(entry) || entry.split("/").includes("..") || entry.startsWith("/") || entry.endsWith("/")) {
    problems.push(`backend.entry "${entry}" must be a plain relative file path, normally server.js`);
  }
  const port = m.backend?.port ?? 3000;
  if (!Number.isInteger(port) || port < 1 || port > 65535) problems.push(`backend.port must be a whole number, normally 3000, not "${port}"`);
  const timeout = String(m.idle?.timeout ?? "10m");
  if (!/^\d+(ms|s|m|h)$/.test(timeout) || /^0+(ms|s|m|h)$/.test(timeout)) problems.push(`idle.timeout "${timeout}" must look like 10m, 30s or 1h`);
  const migrations = String(m.database?.migrations ?? "./migrations");
  if (!/^[A-Za-z0-9_.\/-]+$/.test(migrations) || migrations.split("/").includes("..") || migrations.startsWith("/")) {
    problems.push(`database.migrations "${migrations}" must be a folder inside the project, normally ./migrations`);
  }
  for (const key of Array.isArray(m.env) ? m.env : []) {
    if (typeof key !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(key)) problems.push(`env name "${key}" must be like OPENAI_API_KEY (letters, digits, underscores)`);
    else if (PLATFORM_ENV.has(key)) problems.push(`env ${key} is set by the platform: remove it from env`);
  }
  const roles = Array.isArray(m.roles) ? m.roles : [];
  for (const r of roles) if (typeof r !== "string" || !/^[a-z][a-z0-9_-]{0,31}$/.test(r)) problems.push(`role "${r}" must be lowercase, like moderator`);
  for (const p of Array.isArray(m.protect) ? m.protect : []) {
    const path = String(p?.path ?? "");
    if (!/^\/[A-Za-z0-9._~\/-]*\*?$/.test(path) || path.includes("//")) problems.push(`protect path "${path}" must start with / and may only end with *, like /api/admin/*`);
    if (!roles.includes(p?.role)) problems.push(`protect ${path} needs role "${p?.role}", which is missing from roles: add it to roles`);
  }
  for (const key of ["image", "install", "command"]) {
    const v = m.build?.[key];
    if (v != null && (/[\r\n\0]/.test(String(v)) || String(v).length > 500)) problems.push(`build.${key} must be a single line`);
  }
  return {
    problems,
    manifest: {
      name: String(m.name ?? m.slug ?? ""),
      slug: m.slug,
      access,
      frontend: m.frontend !== false,
      // no backend key at all means a static site, exactly like the server
      backend: m.backend && typeof m.backend === "object" ? { entry: posix.normalize(entry), port } : null,
      database: { enabled: m.database?.enabled === true, migrations: migrations.replace(/^\.\//, "").replace(/\/$/, "") },
      env: Array.isArray(m.env) ? m.env : [],
      roles,
      warm: m.idle?.warm === true,
    },
  };
}

export async function readManifest(root = process.cwd()) {
  const path = join(root, "app.yaml");
  if (!existsSync(path)) {
    throw new ZipProblems([`no app.yaml in ${root}. Run this from the app folder (the one holding app.yaml and package.json).`]);
  }
  const text = await readFile(path, "utf8");
  if (Buffer.byteLength(text) > MAX_MANIFEST_BYTES) throw new ZipProblems(["app.yaml is larger than 64 KB"]);
  let raw;
  try { raw = parseYaml(text); } catch (err) { throw new ZipProblems([err.message]); }
  const { problems, manifest } = checkManifest(raw);
  if (problems.length) throw new ZipProblems(problems.map((p) => `app.yaml: ${p}`));
  return { manifest, text };
}

/* ---------- files ---------- */

async function walk(root, rel, out, problems, skip) {
  const full = join(root, rel);
  const s = await lstat(full);
  if (s.isSymbolicLink()) { problems.push(`${rel} is a symbolic link: the platform refuses links, copy the real file instead`); return; }
  if (s.isDirectory()) {
    for (const name of (await readdir(full)).sort()) {
      if (skip && skip(name, true, rel)) continue;
      await walk(root, rel ? posix.join(rel, name) : name, out, problems, skip);
    }
  } else if (s.isFile()) out.push({ rel, full, size: s.size, mtime: s.mtime });
}

const builtins = new Set(builtinModules.flatMap((m) => [m, m.split("/")[0]]));
const isBuiltin = (spec) => spec.startsWith("node:") || builtins.has(spec) || builtins.has(spec.split("/")[0]);

// The runtime image holds this one file and nothing else: no node_modules. A
// static import of a package left in it crashes the app on its first wake.
function checkServerBundle(code, entry, problems, warnings) {
  const staticImport = /(?:^|[;\n}])\s*import\s*(?:[\w$*{}\s,]+?\s*from\s*)?["']([^"'.\/][^"']*)["']/g;
  const missing = new Set();
  for (const m of code.matchAll(staticImport)) if (!isBuiltin(m[1])) missing.add(m[1]);
  if (missing.size) {
    problems.push(`${entry} imports ${[...missing].join(", ")} at runtime, but the server image has no node_modules. ` +
      `Bundle everything: use the template's "build" script (esbuild --bundle) and do not mark packages as external.`);
  }
  const dynamic = /\brequire\(\s*["']([^"'.\/][^"']*)["']\s*\)/g;
  const required = new Set();
  for (const m of code.matchAll(dynamic)) if (!isBuiltin(m[1])) required.add(m[1]);
  if (required.size) {
    warnings.push(`${entry} still calls require() for ${[...required].join(", ")}. Fine if it is an optional fallback inside try/catch; ` +
      `otherwise the app crashes when that line runs, because the image has no node_modules.`);
  }
  if (/\.node["']/.test(code) && /process\.dlopen|bindings\(/.test(code)) {
    problems.push(`${entry} loads a native addon (.node file). Native packages cannot run on the platform: use a pure JavaScript alternative.`);
  }
}

export async function collectDeploy(root = process.cwd()) {
  const { manifest, text } = await readManifest(root);
  const problems = [];
  const warnings = [];
  const files = [];

  if (manifest.frontend) {
    const index = join(root, "dist", "index.html");
    if (!existsSync(index)) {
      problems.push(`dist/index.html is missing. Run "npm run build" first (npm run zip does it for you). ` +
        `If this app has no web page at all, set frontend: false in app.yaml.`);
    } else {
      const html = await readFile(index, "utf8");
      if (/\/src\/main\.(t|j)sx?["']/.test(html)) {
        problems.push(`dist/index.html is the unbuilt source page (it still points at /src/main.tsx). Run "npm run build" instead of copying files into dist/.`);
      }
      await walk(root, "dist", files, problems);
    }
  } else if (existsSync(join(root, "dist"))) {
    warnings.push("frontend: false, so dist/ is left out of the archive");
  }

  if (manifest.backend) {
    const entry = manifest.backend.entry;
    const full = join(root, entry);
    if (!existsSync(full)) {
      problems.push(`${entry} is missing: app.yaml declares a backend. Run "npm run build" (it bundles server/index.ts into ${entry}). ` +
        `For a static site with no API, remove the whole backend: block from app.yaml.`);
    } else {
      const s = await lstat(full);
      if (s.isSymbolicLink() || !s.isFile()) problems.push(`${entry} must be a regular file, not a link or a folder`);
      else {
        checkServerBundle(await readFile(full, "utf8"), entry, problems, warnings);
        files.push({ rel: entry, full, size: s.size, mtime: s.mtime });
      }
    }
  }

  if (manifest.database.enabled) {
    const dir = manifest.database.migrations;
    const full = join(root, dir);
    const sql = existsSync(full) ? (await readdir(full)).filter((f) => f.endsWith(".sql")).sort() : [];
    const schema = join(root, "server", "schema.ts");
    const hasTables = existsSync(schema) && /\bpgTable\s*\(/.test(await readFile(schema, "utf8"));
    if (!sql.length && hasTables) {
      problems.push(`${dir}/ has no .sql file but server/schema.ts defines tables. Run "npm run db:generate" and keep the generated files.`);
    }
    if (existsSync(full)) await walk(root, dir, files, problems);
    if (sql.length) {
      const bad = sql.filter((f) => !/^\d{4}_/.test(f));
      if (bad.length) warnings.push(`migrations run in file-name order; ${bad.join(", ")} do not start with a 4-digit number`);
    }
  }

  if (files.length + 1 > MAX_ENTRIES) problems.push(`${files.length + 1} files: the platform accepts at most ${MAX_ENTRIES}`);
  let total = Buffer.byteLength(text);
  for (const f of files) {
    total += f.size;
    if (f.size > MAX_FILE_BYTES) problems.push(`${f.rel} is ${Math.round(f.size / 1048576)} MB: the platform accepts at most 64 MB per file`);
  }
  if (total > MAX_UNPACKED_BYTES) problems.push(`the app is ${Math.round(total / 1048576)} MB unpacked: the platform accepts at most 512 MB`);
  if (problems.length) throw new ZipProblems(problems);
  return { manifest, text, files, warnings };
}

/* ---------- the ZIP format, written by hand ---------- */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
// zlib.crc32 exists from Node 20.15 / 22.2; sandboxes sometimes run older ones
const crc32 = zlib.crc32 ?? ((buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
});

function dosDateTime(d) {
  const year = Math.min(Math.max(d.getFullYear(), 1980), 2107);
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

// Regular files only, forward slashes, no folder entries: exactly what the
// server's archivePath() accepts.
export function writeZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const { name, data, mtime } of entries) {
    if (name.includes("\\") || name.startsWith("/") || name.split("/").some((p) => !p || p === "." || p === "..")) {
      throw new Error(`refusing unsafe archive path ${name}`);
    }
    const nameBytes = Buffer.from(name, "utf8");
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    const stored = deflated.length >= data.length;
    const body = stored ? data : deflated;
    const crc = crc32(data) >>> 0;
    const { time, date } = dosDateTime(mtime ?? new Date());
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // file names are UTF-8
    local.writeUInt16LE(stored ? 0 : 8, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    chunks.push(local, nameBytes, body);
    const head = Buffer.alloc(46);
    head.writeUInt32LE(0x02014b50, 0);
    head.writeUInt16LE(0x031e, 4); // made by Unix, so the mode below is read
    head.writeUInt16LE(20, 6);
    head.writeUInt16LE(0x0800, 8);
    head.writeUInt16LE(stored ? 0 : 8, 10);
    head.writeUInt16LE(time, 12);
    head.writeUInt16LE(date, 14);
    head.writeUInt32LE(crc, 16);
    head.writeUInt32LE(body.length, 20);
    head.writeUInt32LE(data.length, 24);
    head.writeUInt16LE(nameBytes.length, 28);
    head.writeUInt32LE((0o100644 << 16) >>> 0, 38); // regular file, rw-r--r--
    head.writeUInt32LE(offset, 42);
    central.push(head, nameBytes);
    offset += 30 + nameBytes.length + body.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, directory, end]);
}

/* ---------- the two archives ---------- */

// The deploy archive, in memory. Throws ZipProblems with one fix per line.
export async function buildDeployZip(root = process.cwd()) {
  const { manifest, text, files, warnings } = await collectDeploy(root);
  const entries = [{ name: "app.yaml", data: Buffer.from(text), mtime: new Date() }];
  for (const f of files) entries.push({ name: f.rel, data: await readFile(f.full), mtime: f.mtime });
  const bytes = writeZip(entries);
  if (bytes.length > MAX_ZIP_BYTES) throw new ZipProblems([`the archive is ${Math.round(bytes.length / 1048576)} MB: the platform accepts at most 100 MB`]);
  return { manifest, bytes, count: entries.length, warnings };
}

export async function buildSourceZip(root, manifest) {
  const files = [];
  const problems = [];
  const hasPackage = existsSync(join(root, "package.json"));
  await walk(root, "", files, problems, (name, _dir, parent) => {
    if (SOURCE_SKIP_DIRS.has(name)) return !(name === "dist" && !hasPackage && parent === ""); // a static site's dist/ is its source
    if (SOURCE_SKIP_FILE(name)) return true;
    // the bundled backend is build output when a build script makes it
    return hasPackage && parent === "" && manifest.backend && name === manifest.backend.entry;
  });
  if (problems.length) throw new ZipProblems(problems);
  const entries = [];
  for (const f of files) entries.push({ name: `${manifest.slug}/${f.rel}`, data: await readFile(f.full), mtime: f.mtime });
  return { bytes: writeZip(entries), count: entries.length };
}

function parseArgs(argv) {
  const args = { outDir: null, deployOnly: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--out-dir") args.outDir = argv[++i];
    else if (argv[i] === "--deploy-only") args.deployOnly = true;
    else throw new ZipProblems([`unknown option ${argv[i]} (use --out-dir <dir> or --deploy-only)`]);
  }
  return args;
}

const kb = (n) => `${Math.max(1, Math.round(n / 1024))} KB`;

async function main() {
  const root = process.cwd();
  try {
    const args = parseArgs(process.argv.slice(2));
    const outDir = resolve(root, args.outDir ?? ".");
    await mkdir(outDir, { recursive: true });
    const deploy = await buildDeployZip(root);
    const slug = deploy.manifest.slug;
    const deployPath = join(outDir, `${slug}-deploy.zip`);
    await writeFile(deployPath, deploy.bytes);
    let source = null;
    let sourcePath = null;
    if (!args.deployOnly) {
      source = await buildSourceZip(root, deploy.manifest);
      sourcePath = join(outDir, `${slug}-source.zip`);
      await writeFile(sourcePath, source.bytes);
    }
    for (const w of deploy.warnings) console.warn(`warning: ${w}`);
    console.log(`Nanodeploy archives for "${slug}" are ready.`);
    console.log(`  deploy: ${deployPath} (${deploy.count} files, ${kb((await stat(deployPath)).size)})`);
    console.log(`          dashboard: New application > ZIP archive, or the app's panel for a new version`);
    if (sourcePath) {
      console.log(`  source: ${sourcePath} (${source.count} files, ${kb((await stat(sourcePath)).size)})`);
      console.log(`          the project, to change it later or push it to Git; the dashboard refuses it`);
    }
  } catch (err) {
    if (err instanceof ZipProblems) {
      console.error(`No archive written. Fix ${err.problems.length === 1 ? "this" : `these ${err.problems.length} problems`}, then run npm run zip again:`);
      for (const p of err.problems) console.error(`  - ${p}`);
    } else console.error(`zip failed: ${err?.stack ?? err}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
