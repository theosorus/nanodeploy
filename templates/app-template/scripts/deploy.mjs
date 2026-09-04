#!/usr/bin/env node
// Packs dist/, server.js, app.yaml and migrations/ then posts them to nanodeploy.
// Runs on the dev machine: the server never builds anything heavy.
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { readFile, rm } from "node:fs/promises";

const url = process.env.NANODEPLOY_URL;
const token = process.env.NANODEPLOY_TOKEN;
if (!url || !token) {
  console.error("set NANODEPLOY_URL and NANODEPLOY_TOKEN in your shell first");
  process.exit(1);
}

const parts = ["app.yaml"];
for (const p of ["dist", "server.js", "migrations"]) if (existsSync(p)) parts.push(p);

await rm("bundle.zip", { force: true });
execFileSync("zip", ["-qr", "bundle.zip", ...parts]);

const form = new FormData();
form.append("bundle", new Blob([await readFile("bundle.zip")]), "bundle.zip");

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
  if (!res.ok) throw new Error(data.error);

  console.log(data.url);
  for (const line of data.log ?? []) console.log(" ", line);
} catch (err) {
  console.error("deploy failed:", err.message);
  process.exitCode = 1;
} finally {
  await rm("bundle.zip", { force: true });
}
