import assert from "node:assert/strict";
import { before, after, test } from "node:test";
import { request as httpRequest } from "node:http";
import { createServer } from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import postgres from "postgres";

const url = process.env.NANODEPLOY_TEST_DATABASE_URL;
const options = { skip: !url };
const authHost = "auth.apps.audit.invalid", appHost = "private-app.apps.audit.invalid";
const origin = `https://${authHost}`;
const password = "Audit-password-2026!";
const gatePassword = "auditgatepasswordforisolatedtests";
const hash = (s: string) => createHash("sha256").update(s).digest();
let port: number, child: ChildProcess, admin: ReturnType<typeof postgres>;
let store: typeof import("../src/db.ts");
let rootCookie = "", hostCookie = "";
const database = `gate_http_${process.pid}_audit`;

function request(path: string, args: { host?: string; cookie?: string; form?: Record<string, string>; json?: unknown; headers?: Record<string, string> } = {}) {
  const body = args.form ? new URLSearchParams(args.form).toString() : args.json !== undefined ? JSON.stringify(args.json) : undefined;
  const headers = { host: args.host ?? authHost, ...(args.cookie ? { cookie: args.cookie } : {}),
    ...(body !== undefined ? { origin, "content-type": args.form ? "application/x-www-form-urlencoded" : "application/json" } : {}), ...args.headers };
  return new Promise<{ status: number; body: string; headers: import("node:http").IncomingHttpHeaders }>((resolve, reject) => {
    const req = httpRequest({ hostname: "127.0.0.1", port, path, method: body !== undefined ? "POST" : "GET", headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.once("error", reject);
      res.once("end", () => resolve({ status: res.statusCode!, body: Buffer.concat(chunks).toString(), headers: res.headers }));
    });
    req.once("error", reject);
    req.end(body);
  });
}
const cookie = (res: { headers: import("node:http").IncomingHttpHeaders }, name: string) => {
  const value = res.headers["set-cookie"]?.find((s) => s.startsWith(name + "="));
  assert.ok(value, `expected ${name} cookie`);
  return value.split(";")[0];
};

before(async () => {
  if (!url) return;
  assert.match(new URL(url).pathname, /_audit$/);
  admin = postgres(url, { max: 1, onnotice: () => {} });
  await admin.unsafe(`create database "${database}"`);
  const ownUrl = new URL(url);
  ownUrl.pathname = "/" + database;
  process.env.POSTGRES_URL = ownUrl.href;
  process.env.GATE_DB_PASSWORD = gatePassword;
  process.env.NANODEPLOY_SECRET_KEY = "11".repeat(32);
  store = await import("../src/db.ts");
  await admin.begin(async (lock) => {
    await lock`select pg_advisory_xact_lock(18472, 99)`;
    await store.initState();
    await store.migrateState();
    await store.initGate();
  });
  await store.sql`insert into gate.users (id, username, display_name) values ('member', 'member', 'Audit Member'), ('passkey-member', 'passkey-member', 'Passkey Member')`;
  for (const [raw, id] of [["audit-welcome", "member"], ["audit-passkey-welcome", "passkey-member"]]) {
    await store.sql`insert into gate.tokens (token_hash, user_id, purpose, expires_at) values (${hash(raw)}, ${id}, 'welcome', now() + interval '1 hour')`;
  }
  for (const slug of ["private-app", "other-app"]) await store.upsertApp({ slug, name: slug, access: "private", roles: ["moderator"], protect: [{ path: "/api/admin/*", role: "moderator" }] });
  port = await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => { const n = (probe.address() as any).port; probe.close(() => resolve(n)); });
  });
  const gateUrl = new URL(ownUrl);
  gateUrl.username = "nd_gate";
  gateUrl.password = gatePassword;
  child = spawn(process.execPath, ["--import", fileURLToPath(new URL("../node_modules/tsx/dist/loader.mjs", import.meta.url)), "src/index.ts"], {
    cwd: fileURLToPath(new URL("../../gate/", import.meta.url)),
    env: { ...process.env, DATABASE_URL: gateUrl.href, APPS_DOMAIN: "apps.audit.invalid", PUBLIC_SCHEME: "https", PUBLIC_PORT: "", COOKIE_SECURE: "true", PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let errors = "";
  child.stderr!.on("data", (c) => { errors = (errors + c.toString()).slice(-4000); });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("gate did not start: " + errors)), 10000);
    child.once("error", (e) => { clearTimeout(timer); reject(e); });
    child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`gate exited ${code}: ${errors}`)); });
    child.stdout!.on("data", (c) => { if (c.toString().includes("gate on")) { clearTimeout(timer); resolve(); } });
  });
});

after(async () => {
  if (!url) return;
  if (child && child.exitCode === null) { const ended = once(child, "exit"); child.kill("SIGTERM"); await ended; }
  if (store) await store.sql.end();
  if (admin) { await admin.unsafe(`drop database if exists "${database}" with (force)`); await admin.end(); }
});

test("gate sign-in pages and state changes enforce their host and origin", options, async () => {
  const page = await request("/login");
  assert.equal(page.status, 200);
  assert.match(String(page.headers["content-security-policy"]), /script-src 'self'/);
  assert.equal(page.headers["cache-control"], "no-store");
  assert.equal((await request("/login", { host: appHost })).status, 404);
  assert.equal((await request("/login", { form: { login: "member", password }, headers: { origin: "https://evil.invalid" } })).status, 403);
});

test("public fonts load from the auth host on access-denied pages", options, async () => {
  const font = await request("/static/fonts/SpaceGrotesk.woff2", { headers: { origin: `https://${appHost}` } });
  assert.equal(font.status, 200);
  assert.match(String(font.headers["content-type"]), /font\/woff2/);
  assert.equal(font.headers["access-control-allow-origin"], "*");
  assert.ok(font.body.startsWith("wOF2"));
  assert.equal(font.headers["set-cookie"], undefined);
  const page = await request("/_nd/unknown", { host: appHost });
  const policy = String(page.headers["content-security-policy"]);
  assert.ok(policy.includes(`font-src 'self' ${origin};`));
  assert.ok(policy.includes(`img-src 'self' ${origin};`));
  assert.equal((await request("/static/fonts/SpaceGrotesk.woff2", { host: appHost })).status, 404);
});

test("an invitation sets a password and cannot be replayed", options, async () => {
  const res = await request("/welcome/audit-welcome", { form: { password, confirm: password } });
  assert.equal(res.status, 303);
  assert.equal(res.headers.location, "/account");
  rootCookie = cookie(res, "__Host-nd_root");
  assert.equal((await request("/account", { cookie: rootCookie })).status, 200);
  assert.equal((await request("/welcome/audit-welcome")).status, 410);
  assert.equal((await request("/welcome/audit-welcome", { form: { password, confirm: password } })).status, 410);
});

test("invalid passkey verification leaves a welcome link usable", options, async () => {
  const opts = await request("/webauthn/register/options", { json: { token: "audit-passkey-welcome" } });
  assert.equal(opts.status, 200);
  const res = await request("/webauthn/register/verify", { cookie: cookie(opts, "__Host-nd_wa"), json: { token: "audit-passkey-welcome", response: {} } });
  assert.equal(res.status, 400);
  assert.equal((await request("/welcome/audit-passkey-welcome")).status, 200);
});

test("malformed personal-key scopes never silently become unrestricted", options, async () => {
  for (const app of ["../private-app", "no-such-app"]) {
    assert.equal((await request("/account/keys", { cookie: rootCookie, form: { label: "scope test", app } })).status, 400);
  }
  assert.equal((await store.sql`select 1 from gate.access_keys where user_id = 'member'`).length, 0);
});

test("password login issues single-use handoffs and host-bound sessions", options, async () => {
  const to = `https://${appHost}/secret`;
  // the app host starts the sign-in and remembers which browser asked
  const start = await request("/_nd/login?rd=/secret", { host: appHost });
  assert.equal(start.status, 302);
  const state = cookie(start, "__Host-nd_st");
  const login = new URL(start.headers.location!);
  assert.equal(login.origin + login.pathname, `${origin}/login`);
  assert.equal(login.searchParams.get("to"), to);
  const st = login.searchParams.get("st")!;
  assert.match(st, /^[A-Za-z0-9_-]{43}$/);
  assert.ok(!start.headers.location!.includes(state.split("=")[1]), "the state cookie itself never leaves the app host");
  assert.ok((await request(login.pathname + login.search)).body.includes(`name="st" value="${st}"`));

  const res = await request("/login", { form: { login: "member", password, to, st }, headers: { "x-nanodeploy-client-ip": "192.0.2.2" } });
  assert.equal(res.status, 303);
  rootCookie = cookie(res, "__Host-nd_root");
  const destination = new URL(res.headers.location!);
  assert.equal(destination.hostname, appHost);
  assert.equal(destination.pathname, "/_nd/callback");
  const callbackPath = destination.pathname + destination.search;
  // a link to this callback opened in another browser signs nobody in: it holds
  // no state cookie, or its own
  for (const stranger of [undefined, "__Host-nd_st=" + "A".repeat(43)]) {
    const refused = await request(callbackPath, { host: appHost, cookie: stranger });
    assert.equal(refused.status, 302);
    assert.match(refused.headers.location!, /\/login\?to=/);
    assert.ok(!(refused.headers["set-cookie"] ?? []).some((c) => c.startsWith("__Host-nd_s=")), "no session for a browser that did not ask");
  }
  const callback = await request(callbackPath, { host: appHost, cookie: state });
  assert.equal(callback.status, 302);
  assert.equal(callback.headers.location, "/secret");
  hostCookie = cookie(callback, "__Host-nd_s");
  const replay = await request(callbackPath, { host: appHost, cookie: state });
  assert.match(replay.headers.location!, /\/login\?to=/);
  // a sign-in that did not start on the app host gets no code: the host starts
  // it over with its own state, then the existing root session answers at once
  const direct = await request(`/login?to=${encodeURIComponent(to)}`, { cookie: rootCookie });
  assert.equal(direct.status, 302);
  assert.equal(direct.headers.location, `https://${appHost}/_nd/login?rd=%2Fsecret`);
  const again = await request(`/login?to=${encodeURIComponent(to)}&st=${st}`, { cookie: rootCookie });
  assert.match(again.headers.location!, /^https:\/\/private-app\.apps\.audit\.invalid\/_nd\/callback\?code=/);

  const headers = { "x-forwarded-host": appHost, "x-forwarded-uri": "/api/items", "x-forwarded-method": "GET" };
  const check = await request("/verify?app=private-app", { host: appHost, cookie: hostCookie, headers });
  assert.equal(check.status, 200);
  assert.equal(check.headers["remote-sub"], "member");
  assert.equal((await request("/verify?app=other-app", { host: "other-app.apps.audit.invalid", cookie: hostCookie,
    headers: { ...headers, "x-forwarded-host": "other-app.apps.audit.invalid" } })).status, 401);
  assert.equal((await request("/verify?app=private-app", { host: appHost, cookie: hostCookie,
    headers: { ...headers, "x-forwarded-uri": "/api/admin/test" } })).status, 403);
  // an encoded separator cannot walk a request out of the protected prefix
  assert.equal((await request("/verify?app=private-app", { host: appHost, cookie: hostCookie,
    headers: { ...headers, "x-forwarded-uri": "/api/admin/..%2f..%2fitems" } })).status, 403);
});

test("a sibling origin cannot open a WebSocket with a visitor's session", options, async () => {
  const socket = { "x-forwarded-host": appHost, "x-forwarded-uri": "/api/live", "x-forwarded-method": "GET",
    "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==", "sec-websocket-version": "13" };
  const verify = (headers: Record<string, string>) => request("/verify?app=private-app", { host: appHost, cookie: hostCookie, headers });
  assert.equal((await verify({ ...socket, origin: "https://other-app.apps.audit.invalid", "sec-fetch-site": "same-site" })).status, 403);
  assert.equal((await verify({ ...socket, origin: "https://evil.invalid" })).status, 403);
  assert.equal((await verify(socket)).status, 403, "a handshake without an Origin is not a browser page of this app");
  const own = await verify({ ...socket, origin: `https://${appHost}` });
  assert.equal(own.status, 200);
  assert.equal(own.headers["remote-sub"], "member");
  // an ordinary read from another origin is still what CORS decides, not gate
  const { "sec-websocket-key": _key, "sec-websocket-version": _version, ...plain } = socket;
  assert.equal((await verify({ ...plain, origin: "https://other-app.apps.audit.invalid" })).status, 200);
});

test("a control character in a profile cannot break the identity headers", options, async () => {
  await store.sql`update gate.users set display_name = ${"Audit\u0007 Mem\u007fber"}, email = ${"audit\u001f@audit.invalid"} where id = 'member'`;
  try {
    const headers = { "x-forwarded-host": appHost, "x-forwarded-uri": "/api/items", "x-forwarded-method": "GET" };
    const res = await request("/verify?app=private-app", { host: appHost, cookie: hostCookie, headers });
    assert.equal(res.status, 200);
    assert.equal(res.headers["remote-name"], "Audit  Mem ber");
    assert.equal(res.headers["remote-email"], "audit @audit.invalid");
    // gate is still up for the next request
    assert.equal((await request("/login")).status, 200);
  } finally {
    await store.sql`update gate.users set display_name = 'Audit Member', email = '' where id = 'member'`;
  }
});

test("signing out from an app invalidates both its host session and the root", options, async () => {
  // a link or an image on another origin does not sign anyone out
  for (const site of ["cross-site", "same-site"]) {
    assert.equal((await request("/_nd/logout", { host: appHost, cookie: hostCookie, headers: { "sec-fetch-site": site } })).status, 302);
    assert.equal((await request("/_nd/me", { host: appHost, cookie: hostCookie })).body.includes('"anonymous":false'), true);
  }
  assert.equal((await request("/_nd/logout", { host: appHost, cookie: hostCookie, headers: { "sec-fetch-site": "same-origin" } })).status, 302);
  assert.equal((await request("/_nd/me", { host: appHost, cookie: hostCookie })).body.includes('"anonymous":true'), true);
  assert.equal((await request("/account", { cookie: rootCookie })).status, 303);
});

test("repeated password failures are rate limited", options, async () => {
  for (let i = 0; i < 6; i++) assert.equal((await request("/login", { form: { login: "unknown", password: "wrong" }, headers: { "x-nanodeploy-client-ip": "192.0.2.99" } })).status, 401);
  assert.equal((await request("/login", { form: { login: "unknown", password: "wrong" }, headers: { "x-nanodeploy-client-ip": "192.0.2.99" } })).status, 429);
});
