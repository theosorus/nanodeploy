import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, normalizePath, pathSpellings, canOpen } from "../src/policy.ts";
import type { Identity } from "../src/policy.ts";
import type { AppPolicy } from "../src/db.ts";

const app = (o: Partial<AppPolicy>): AppPolicy => ({
  slug: "guestbook", name: "Guestbook", access: "public", groups: [], roles: [], protect: [], ...o,
});
const person = (role: "admin" | "member" = "member", groups: string[] = [], via: "session" | "key" = "session"): Identity => ({
  user: { id: "u1", username: "sara", email: "", display_name: "Sara", role, status: "active" },
  groups: groups.map((name, i) => ({ id: `g${i}`, name })),
  via,
});

const guestbook = app({ roles: ["moderator"], protect: [{ path: "/api/admin/*", role: "moderator" }, { path: "/admin*", role: "moderator" }] });

test("public app: anonymous visitors pass, with no identity", () => {
  assert.deepEqual(decide(guestbook, null, [], "/api/messages"), { ok: true, roles: [] });
});

test("public app: a protected path asks an anonymous visitor to sign in", () => {
  const d = decide(guestbook, null, [], "/api/admin/messages/3");
  assert.equal(d.ok, false);
  assert.equal(!d.ok && d.status, 401);
});

test("public app: a member without the role is refused on protected paths only", () => {
  assert.equal(decide(guestbook, person(), [], "/api/messages").ok, true);
  const d = decide(guestbook, person(), [], "/api/admin/messages/3");
  assert.equal(!d.ok && d.status, 403);
});

test("public app: a moderator passes and the role is reported", () => {
  assert.deepEqual(decide(guestbook, person(), ["moderator"], "/api/admin/x"), { ok: true, roles: ["moderator"] });
  // identity is also reported on public paths: the app can show the delete button
  assert.deepEqual(decide(guestbook, person(), ["moderator"], "/api/messages"), { ok: true, roles: ["moderator"] });
});

test("admins hold every declared role", () => {
  assert.deepEqual(decide(guestbook, person("admin"), [], "/api/admin/x"), { ok: true, roles: ["moderator"] });
});

test("a grant for a role the app no longer declares is ignored", () => {
  const d = decide(app({ roles: [] , protect: [] }), person(), ["moderator"], "/");
  assert.deepEqual(d, { ok: true, roles: [] });
});

test("path tricks cannot dodge a protected prefix", () => {
  for (const uri of ["/API/Admin/x", "/api/x/../admin/x", "/api/%61dmin/x", "/api/./admin/x?y=1", "/ADMIN",
    "/api%2fadmin/x", "/api/admin%2Fx", "//api/admin/x", "/api//admin/x", "/api\\admin\\x", "/api/%61dmin/x%ZZ"]) {
    const d = decide(guestbook, null, [], uri);
    assert.equal(d.ok, false, uri);
  }
  assert.equal(normalizePath("/a/b/../c?q=1"), "/a/c");
  assert.equal(normalizePath("/api/%3F/admin"), "/api/?/admin");
});

test("a rule holds on every spelling of a path, not only on the most decoded one", () => {
  // Decoding "%2f" and then resolving ".." reads these as paths outside the
  // prefix, while a router that leaves "%2f" alone still dispatches them to a
  // handler under /api/admin/ or /admin.
  for (const uri of ["/api/admin/..%2f..%2fother", "/api/admin/users/..%2F..%2F..%2F..%2Fx", "/api/admin/a%2f..%2f..%2f..%2fpublic",
    "/api/admin/%252e%252e%252f%252e%252e%252fother", "/api/admin/..%5c..%5cother", "/admin%2f..%2fwelcome", "/ADMIN/..%2Fwelcome"]) {
    const anonymous = decide(guestbook, null, [], uri);
    assert.equal(!anonymous.ok && anonymous.status, 401, uri);
    const member = decide(guestbook, person(), [], uri);
    assert.equal(!member.ok && member.status, 403, uri);
    assert.equal(decide(guestbook, person(), ["moderator"], uri).ok, true, uri);
  }
  // what is not under a protected prefix in any spelling stays open
  for (const uri of ["/api/messages", "/api/administrators", "/api/x/../messages", "/api/messages/..%2fmessages", "/"]) {
    assert.equal(decide(guestbook, null, [], uri).ok, true, uri);
  }
  assert.deepEqual(pathSpellings("/api/admin/..%2f..%2fother"), ["/api/admin/..%2f..%2fother", "/api/admin/../../other", "/other"]);
});

test("an exact protected path does not cover its neighbours", () => {
  const a = app({ roles: ["editor"], protect: [{ path: "/api/publish", role: "editor" }] });
  assert.equal(decide(a, null, [], "/api/publish").ok, false);
  assert.equal(decide(a, null, [], "/api/publish-preview").ok, true);
});

test("private app: any account, never an anonymous visitor", () => {
  const a = app({ access: "private" });
  assert.equal(!decide(a, null, [], "/").ok && decide(a, null, [], "/").status, 401);
  assert.equal(decide(a, person(), [], "/").ok, true);
});

test("groups app: members of the groups, role holders and admins", () => {
  const a = app({ access: "groups", groups: ["family"], roles: ["moderator"] });
  assert.equal(decide(a, person("member", ["family"]), [], "/").ok, true);
  assert.equal(decide(a, person("member", ["work"]), [], "/").ok, false);
  assert.equal(decide(a, person("member", ["work"]), ["moderator"], "/").ok, true);
  assert.equal(decide(a, person("admin"), [], "/").ok, true);
  assert.equal(canOpen(a, person("member", ["work"]), []), false);
});

test("an access key limited to other apps is refused", () => {
  const id = { ...person(), via: "key" as const, keyApps: ["notes"] };
  const d = decide(guestbook, id, [], "/api/messages");
  assert.equal(!d.ok && d.status, 403);
  assert.equal(decide(guestbook, { ...id, keyApps: ["guestbook"] }, [], "/api/messages").ok, true);
  assert.equal(decide(guestbook, { ...id, keyApps: null }, [], "/api/messages").ok, true);
});
