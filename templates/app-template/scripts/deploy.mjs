#!/usr/bin/env node
// Packs dist/, server.js, app.yaml and migrations/ then posts them to nanodeploy.
// ZIP deployments build on the development machine; Git deployments build on
// the server in a disposable container.
//   npm run deploy -- -m "what changed"
// The message and, in a git checkout, the commit go into the app's version
// history, which is what you read when choosing a version to go back to.
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { Readable } from "node:stream";

const url = process.env.NANODEPLOY_URL;
const token = process.env.NANODEPLOY_TOKEN;
// NANODEPLOY_TOKEN is normally a deploy key (ndd_...) for this app, made in the
// dashboard: it can deploy this app and nothing else.
if (!url || !token) {
  console.error("set NANODEPLOY_URL and NANODEPLOY_TOKEN in your shell first");
  console.error("(a deploy key for this app: dashboard > the app > Deploy keys)");
  process.exit(1);
}

const parts = ["app.yaml"];
for (const p of ["dist", "server.js", "migrations"]) if (existsSync(p)) parts.push(p);

await rm("bundle.zip", { force: true });
execFileSync("zip", ["-qr", "bundle.zip", ...parts]);

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

const form = new FormData();
form.append("bundle", new Blob([await readFile("bundle.zip")]), "bundle.zip");
if (message) form.append("message", message);
if (commitSha) {
  form.append("commit_sha", commitSha);
  form.append("commit_message", commitMessage + dirty);
}

try {
  const endpoint = new URL("/api/deploy", url);
  const headers = { authorization: `Bearer ${token}` };
  // Browsers resolve *.localhost themselves. Node may use ::1 first or ask a
  // DNS resolver that does not know the reserved suffix. The local gateway
  // binds IPv4 loopback, so connect there while preserving its virtual host.
  const request = new Request(endpoint, { method: "POST", headers, body: form });
  const res = endpoint.protocol === "http:" && endpoint.hostname.endsWith(".localhost")
    ? await new Promise((resolve, reject) => {
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
      })
    : await fetch(request);

  let data;
  const text = await res.text();
  try {
    data = JSON.parse(text);
  } catch {
    // A proxy can return an HTML sign-in or error page instead of API JSON.
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
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
} finally {
  await rm("bundle.zip", { force: true });
}
