import assert from "node:assert/strict";
import { test } from "node:test";
import { stringify } from "yaml";
import { isAppSlug, parseManifest } from "../src/manifest.ts";

test("slugs are DNS labels and reserve platform and preview separators", () => {
  for (const slug of ["ab", "notes-2", "a".repeat(31), "notes--pr-123"]) assert.equal(isAppSlug(slug), true, slug);
  for (const slug of ["a", "ab-", "ab--cd", "a".repeat(32), "auth", "deploy--pr-1", ["notes"], null]) {
    assert.equal(isAppSlug(slug), false, JSON.stringify(slug));
    assert.throws(() => parseManifest(stringify({ slug })));
  }
});

test("manifest types cannot silently enable databases or ignore access lists", () => {
  for (const patch of [
    { database: { enabled: "false" } }, { backend: "server.js" }, { backend: { port: true } },
    { frontend: "false" }, { idle: { warm: "true" } }, { env: "API_KEY" },
    { roles: "moderator" }, { protect: {} }, { groups: "family" },
  ]) assert.throws(() => parseManifest(stringify({ slug: "notes", ...patch })), JSON.stringify(patch));
  assert.throws(() => parseManifest("[]"));
  assert.equal(parseManifest("slug: notes\nbackend: false\nfrontend: false").backend, undefined);
});

test("bundle paths and generated Dockerfile values reject special characters", () => {
  for (const entry of ["../server.js", "/server.js", "server.js\nRUN id", 'server".js', "server\\app.js", "Dockerfile", "server.js/"]) {
    assert.throws(() => parseManifest(stringify({ slug: "notes", backend: { entry } })), entry);
  }
  assert.equal(parseManifest("slug: notes\nbackend: { entry: build/server.js }").backend?.entry, "build/server.js");
  assert.throws(() => parseManifest("slug: notes\ndatabase: { migrations: '' }"));
  assert.throws(() => parseManifest("slug: notes\nidle: { timeout: 0m }"));
});

test("platform variables and ambiguous protection rules are refused", () => {
  for (const key of ["DATABASE_URL", "PORT"]) assert.throws(() => parseManifest(`slug: notes\nenv: [${key}]`));
  for (const path of ["/api//admin/*", "/api/./admin/*", "/api/x/../admin/*"]) {
    assert.throws(() => parseManifest(stringify({ slug: "notes", roles: ["moderator"], protect: [{ path, role: "moderator" }] })));
  }
});
