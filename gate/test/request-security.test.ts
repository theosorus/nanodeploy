import assert from "node:assert/strict";
import { test } from "node:test";
import { recentlyAuthenticated, safeRedirectPath, sameRequestOrigin } from "../src/request-security.ts";
import { take } from "../src/ratelimit.ts";
import { decide } from "../src/policy.ts";
import { hashPassword, passwordNeedsRehash, PasswordBusyError, verifyPassword } from "../src/crypto.ts";

test("redirect paths cannot become another origin after browser normalization", () => {
  for (const path of ["//evil.invalid", "/\\evil.invalid", "/\t/evil.invalid", "/\n/evil.invalid", "https://evil.invalid", "\u0000//evil.invalid"]) {
    assert.equal(safeRedirectPath(path), "/", JSON.stringify(path));
  }
  assert.equal(safeRedirectPath("/api/notes?sort=recent"), "/api/notes?sort=recent");
});

test("same-site sibling origins cannot use an application's session to mutate it", () => {
  const expected = "https://notes.apps.audit.invalid";
  assert.equal(sameRequestOrigin("https://compromised.apps.audit.invalid", "same-site", expected), false);
  assert.equal(sameRequestOrigin(undefined, undefined, expected), false);
  assert.equal(sameRequestOrigin("https://notes.apps.audit.invalid", "same-origin", expected), true);
  assert.equal(sameRequestOrigin("http://notes.apps.audit.invalid", "same-origin", expected), false);
});

test("a long-lived root session needs fresh proof before managing credentials", () => {
  assert.equal(recentlyAuthenticated(new Date(Date.now() - 60_000)), true);
  assert.equal(recentlyAuthenticated(new Date(Date.now() - 16 * 60_000)), false);
  assert.equal(recentlyAuthenticated(new Date(Date.now() + 60_000)), false);
});

test("attempt budgets are consumed before asynchronous verification begins", () => {
  const key = `test-${Date.now()}`;
  assert.equal(take(key, 2, 60_000), 0);
  assert.equal(take(key, 2, 60_000), 0);
  assert.ok(take(key, 2, 60_000) > 0);
  assert.equal(take(`${key}-another`, 2, 60_000), 0);
});

test("overlapping protection rules and multiply encoded paths fail closed", () => {
  const policy = {
    slug: "notes", name: "notes", access: "public" as const, groups: [], roles: ["reader", "moderator"],
    protect: [{ path: "/api/*", role: "reader" }, { path: "/api/admin/*", role: "moderator" }],
  };
  const id = { user: { id: "u1", username: "user", email: "", display_name: "User", role: "member" as const, status: "active" }, groups: [], via: "session" as const };
  for (const uri of ["/api/admin", "/api/admin/", "/api/%2561dmin/x", "/api%252fadmin%252fx"]) {
    assert.equal(decide(policy, id, ["reader"], uri).ok, false, uri);
    assert.equal(decide(policy, id, ["reader", "moderator"], uri).ok, true, uri);
  }
});

test("password work is bounded under a concurrent login flood and upgrades old hashes", async () => {
  const results = await Promise.allSettled(Array.from({ length: 12 }, () => hashPassword("a-long-test-password")));
  assert.ok(results.some((r) => r.status === "rejected" && r.reason instanceof PasswordBusyError));
  const good = results.find((r) => r.status === "fulfilled");
  assert.ok(good?.status === "fulfilled");
  assert.equal(passwordNeedsRehash(good.value), false);
  assert.equal(passwordNeedsRehash(good.value.replace("$3$", "$1$")), true);
  assert.equal(await verifyPassword("x".repeat(5000), good.value), false);
});
