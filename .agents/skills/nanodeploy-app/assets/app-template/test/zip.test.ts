import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { inflateRawSync } from "node:zlib";
// @ts-expect-error plain JavaScript module without type declarations
import { checkManifest, parseYaml, writeZip } from "../scripts/zip.mjs";

// Reads the central directory back: what the platform's unzip will see.
function readZip(buf: Buffer) {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(end + 10);
  let at = buf.readUInt32LE(end + 16);
  const out: Record<string, { data: Buffer; mode: number }> = {};
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(at + 10);
    const size = buf.readUInt32LE(at + 20);
    const nameLength = buf.readUInt16LE(at + 28);
    const mode = buf.readUInt32LE(at + 38) >>> 16;
    const local = buf.readUInt32LE(at + 42);
    const name = buf.subarray(at + 46, at + 46 + nameLength).toString("utf8");
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const body = buf.subarray(start, start + size);
    out[name] = { data: method === 8 ? inflateRawSync(body) : Buffer.from(body), mode };
    at += 46 + nameLength;
  }
  return out;
}

// This file travels with every app made from the template: the tests below
// must hold whatever name, slug or settings the app's own app.yaml has.
test("this app's app.yaml is readable by the zip tool", () => {
  const m = parseYaml(readFileSync(new URL("../app.yaml", import.meta.url), "utf8"));
  assert.equal(typeof m.slug, "string");
});

test("the template's manifest shape parses with every field", () => {
  const m = parseYaml([
    "name: Notes", "slug: notes   # a comment", "access: private", "groups: []", "roles: []", "protect: []",
    "frontend: true", "backend:", "  entry: server.js", "  port: 3000", "database:", "  enabled: true",
    "  migrations: ./migrations", "idle:", "  timeout: 10m", "  warm: false", "env: [OPENAI_API_KEY]",
  ].join("\n"));
  assert.equal(m.slug, "notes");
  assert.deepEqual(m.backend, { entry: "server.js", port: 3000 });
  assert.deepEqual(m.database, { enabled: true, migrations: "./migrations" });
  assert.deepEqual(m.env, ["OPENAI_API_KEY"]);
  assert.equal(m.idle.warm, false);
  assert.deepEqual(checkManifest(m).problems, []);
});

test("flow maps, list items and a byte-order mark are read", () => {
  const m = parseYaml("﻿slug: guestbook\nroles: [moderator]\nprotect:\n  - { path: /api/admin/*, role: moderator }\nbackend: { entry: server.js, port: 3000 }\n");
  assert.deepEqual(m.protect, [{ path: "/api/admin/*", role: "moderator" }]);
  assert.equal(checkManifest(m).problems.length, 0);
});

test("the server's manifest rules are enforced before any upload", () => {
  const problems = (yaml: string) => checkManifest(parseYaml(yaml)).problems.join("\n");
  assert.match(problems("slug: My_App\n"), /slug "My_App" is invalid/);
  assert.match(problems("slug: deploy\n"), /reserved/);
  assert.match(problems("slug: ok-app\nenv: [DATABASE_URL]\n"), /set by the platform/);
  assert.match(problems("slug: ok-app\nprotect:\n  - { path: /api/admin/*, role: moderator }\n"), /missing from roles/);
  assert.equal(checkManifest(parseYaml("slug: static-site\nfrontend: true\n")).manifest.backend, null);
});

test("an archive round-trips with forward slashes and regular-file modes", () => {
  const big = Buffer.from("x".repeat(10_000));
  const zip = writeZip([
    { name: "app.yaml", data: Buffer.from("slug: a-b\n") },
    { name: "dist/assets/app.js", data: big },
  ]);
  const files = readZip(zip);
  assert.deepEqual(Object.keys(files), ["app.yaml", "dist/assets/app.js"]);
  assert.equal(files["dist/assets/app.js"].data.toString(), big.toString());
  assert.equal(files["app.yaml"].mode & 0o170000, 0o100000);
  assert.throws(() => writeZip([{ name: "dist\\index.html", data: Buffer.alloc(0) }]), /unsafe/);
});
