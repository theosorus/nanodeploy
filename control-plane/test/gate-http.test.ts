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
  const res = await request("/login", { form: { login: "member", password, to }, headers: { "x-nanodeploy-client-ip": "192.0.2.2" } });
  assert.equal(res.status, 303);
  rootCookie = cookie(res, "__Host-nd_root");
  const destination = new URL(res.headers.location!);
  assert.equal(destination.hostname, appHost);
  const callback = await request(destination.pathname + destination.search, { host: appHost });
  assert.equal(callback.status, 302);
  assert.equal(callback.headers.location, "/secret");
  hostCookie = cookie(callback, "__Host-nd_s");
  const replay = await request(destination.pathname + destination.search, { host: appHost });
  assert.match(replay.headers.location!, /\/login\?to=/);
  const headers = { "x-forwarded-host": appHost, "x-forwarded-uri": "/api/items", "x-forwarded-method": "GET" };
  const check = await request("/verify?app=private-app", { host: appHost, cookie: hostCookie, headers });
  assert.equal(check.status, 200);
  assert.equal(check.headers["remote-sub"], "member");
  assert.equal((await request("/verify?app=other-app", { host: "other-app.apps.audit.invalid", cookie: hostCookie,
    headers: { ...headers, "x-forwarded-host": "other-app.apps.audit.invalid" } })).status, 401);
  assert.equal((await request("/verify?app=private-app", { host: appHost, cookie: hostCookie,
    headers: { ...headers, "x-forwarded-uri": "/api/admin/test" } })).status, 403);
});

test("signing out from an app invalidates both its host session and the root", options, async () => {
  assert.equal((await request("/_nd/logout", { host: appHost, cookie: hostCookie })).status, 302);
  assert.equal((await request("/_nd/me", { host: appHost, cookie: hostCookie })).body.includes('"anonymous":true'), true);
  assert.equal((await request("/account", { cookie: rootCookie })).status, 303);
});

test("repeated password failures are rate limited", options, async () => {
  for (let i = 0; i < 6; i++) assert.equal((await request("/login", { form: { login: "unknown", password: "wrong" }, headers: { "x-nanodeploy-client-ip": "192.0.2.99" } })).status, 401);
  assert.equal((await request("/login", { form: { login: "unknown", password: "wrong" }, headers: { "x-nanodeploy-client-ip": "192.0.2.99" } })).status, 429);
});
