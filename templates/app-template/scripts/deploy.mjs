#!/usr/bin/env node
// Packs dist/, server.js, app.yaml and migrations/ (scripts/zip.mjs) then
// posts them to Nanodeploy. ZIP deployments build on the development machine;
// Git deployments build on the server in a disposable container and never use
// this script.
//   npm run deploy -- -m "what changed"
// The message and, in a git checkout, the commit go into the app's version
// history, which is what you read when choosing a version to go back to.
import { execFileSync } from "node:child_process";
import { request as httpRequest } from "node:http";
import { Readable } from "node:stream";
import { buildDeployZip, ZipProblems } from "./zip.mjs";

const url = process.env.NANODEPLOY_URL;
const token = process.env.NANODEPLOY_TOKEN;
// NANODEPLOY_TOKEN is normally a deploy key (ndd_...) for this app, made in the
// dashboard: it can deploy this app and nothing else.
if (!url || !token) {
  console.error("set NANODEPLOY_URL and NANODEPLOY_TOKEN in your shell first");
  console.error("  NANODEPLOY_URL:   the console, https://deploy.<your domain> (not the app's own address)");
  console.error("  NANODEPLOY_TOKEN: a deploy key ndd_... for this slug: the app's Settings > Deploy keys,");
  console.error("                    or New application > Terminal & agents for an app that does not exist yet");
  console.error("No key? Run npm run zip instead and drop the -deploy.zip on the dashboard.");
  process.exit(1);
}

let bundle;
try {
  bundle = await buildDeployZip(process.cwd());
} catch (err) {
  if (!(err instanceof ZipProblems)) throw err;
  console.error("deploy stopped before uploading anything:");
  for (const p of err.problems) console.error(`  - ${p}`);
  process.exit(1);
}
for (const w of bundle.warnings) console.warn(`warning: ${w}`);

const args = process.argv.slice(2);
const at = args.findIndex((a) => a === "-m" || a === "--message");
const message = at >= 0 ? (args[at + 1] ?? "") : "";

// best effort: not a git checkout, or git not installed, means no commit info
const git = (...a) => {
  try {
    return execFileSync("git", a, { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return "";
  }
};
const commitSha = git("rev-parse", "HEAD");
const commitMessage = commitSha ? git("log", "-1", "--pretty=%s") : "";
const dirty = commitSha && git("status", "--porcelain") ? " (with uncommitted changes)" : "";

function form() {
  const f = new FormData();
  f.append("bundle", new Blob([bundle.bytes]), "bundle.zip");
  if (message) f.append("message", message);
  if (commitSha) {
    f.append("commit_sha", commitSha);
    f.append("commit_message", commitMessage + dirty);
  }
  return f;
}

async function send(endpoint) {
  const headers = { authorization: `Bearer ${token}` };
  // Browsers resolve *.localhost themselves. Node may use ::1 first or ask a
  // DNS resolver that does not know the reserved suffix. The local gateway
  // binds IPv4 loopback, so connect there while preserving its virtual host.
  const request = new Request(endpoint, { method: "POST", headers, body: form() });
  if (!(endpoint.protocol === "http:" && endpoint.hostname.endsWith(".localhost"))) return fetch(request);
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest({ hostname: "127.0.0.1", port: endpoint.port || 80,
      path: endpoint.pathname + endpoint.search, method: "POST", timeout: 600_000,
      headers: { ...Object.fromEntries(request.headers), Host: endpoint.host },
    }, (incoming) => resolve(new Response(Readable.toWeb(incoming), {
      status: incoming.statusCode,
      headers: Object.fromEntries(Object.entries(incoming.headers)
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => [key, Array.isArray(value) ? value.join(", ") : value])),
    })));
    outgoing.once("error", reject);
    outgoing.once("timeout", () => outgoing.destroy(new Error("deployment timed out")));
    Readable.fromWeb(request.body).once("error", reject).pipe(outgoing);
  });
}

try {
  const endpoint = new URL("/api/deploy", url);
  let res;
  // the server takes one bundle at a time and says so with a 429: wait, retry
  for (let attempt = 1; ; attempt++) {
    res = await send(endpoint);
    if (res.status !== 429 || attempt === 12) break;
    await res.text().catch(() => "");
    console.error("another deployment is in progress on the server, retrying in 5 s");
    await new Promise((r) => setTimeout(r, 5000));
  }

  let data;
  const text = await res.text();
  try {
    data = JSON.parse(text);
  } catch {
    // A proxy can return an HTML sign-in or error page instead of API JSON.
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}\n` +
      `  NANODEPLOY_URL must be the console (https://deploy.<domain>), reachable without a browser sign-in page in front of /api/`);
  }
  if (!res.ok) {
    for (const line of data.log ?? []) console.error(" ", line);
    if (data.note) console.error(" ", data.note);
    throw new Error(data.error);
  }

  console.log(data.url);
  for (const line of data.log ?? []) console.log(" ", line);
} catch (err) {
  console.error("deploy failed:", err.message);
  process.exitCode = 1;
}
