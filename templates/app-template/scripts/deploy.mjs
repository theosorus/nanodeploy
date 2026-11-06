#!/usr/bin/env node
// Packs dist/, server.js, app.yaml and migrations/ then posts them to nanodeploy.
// Runs on the dev machine: the server never builds anything heavy.
//   npm run deploy -- -m "what changed"
// The message and, in a git checkout, the commit go into the app's version
// history, which is what you read when choosing a version to go back to.
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { readFile, rm } from "node:fs/promises";

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
  const res = await fetch(`${url}/api/deploy`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: form,
  });

  let data;
  try {
    data = await res.json();
  } catch {
    // e.g. tinyauth's login page when the token does not match the gateway
    const text = await res.text().catch(() => "");
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
