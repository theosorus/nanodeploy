import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import type { Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";
import { randomUUID } from "node:crypto";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type { AuthenticatorTransportFuture } from "@simplewebauthn/server";
import {
  AUTH_HOST,
  AUTH_ORIGIN,
  CONSOLE,
  CONSOLE_FRESH,
  HOST_COOKIE,
  PUBLIC_PORT,
  ROOT_COOKIE,
  ROOT_TTL,
  RP_ID,
  RP_NAME,
  SCHEME,
  SECURE_COOKIES,
  WEBAUTHN_COOKIE,
  hostOfSlug,
  originOf,
  slugOfHost,
} from "./config.js";
import { burnTime, hashPassword, PasswordBusyError, passwordNeedsRehash, passwordProblem, sha256, verifyPassword } from "./crypto.js";
import * as db from "./db.js";
import { ago, pickLang, translator } from "./i18n.js";
import type { Lang } from "./i18n.js";
import { accountPage, forbiddenPage, loginPage, messagePage, tokenPage } from "./pages.js";
import { canOpen, decide, effectiveRoles } from "./policy.js";
import type { Identity } from "./policy.js";
import * as limit from "./ratelimit.js";
import { recentlyAuthenticated, safeRedirectPath, sameRequestOrigin } from "./request-security.js";

await db.waitForSchema();

const app = new Hono();
app.onError((err, c) => {
  if (err instanceof PasswordBusyError) {
    c.header("Retry-After", "5");
    return c.json({ error: "password service busy; try again shortly" }, 429);
  }
  if (err instanceof HTTPException) return err.getResponse();
  if (err instanceof SyntaxError) return c.json({ error: "invalid request body" }, 400);
  console.error("gate request failed", err);
  return c.json({ error: "internal error" }, 500);
});
app.use("*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  c.header("X-Content-Type-Options", "nosniff");
  c.header("X-Frame-Options", "DENY");
  c.header("Referrer-Policy", "no-referrer");
  c.header("Content-Security-Policy", `default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' ${AUTH_ORIGIN}; font-src 'self' ${AUTH_ORIGIN}; script-src 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'`);
  await next();
});
app.use("*", bodyLimit({ maxSize: 64 * 1024, onError: (c) => c.json({ error: "payload too large" }, 413) }));

/* ---------- small helpers ---------- */

const hostOf = (c: Context) => (c.req.header("host") ?? "").toLowerCase().replace(/:\d+$/, "");
const langOf = (c: Context): Lang => pickLang(c.req.header("accept-language"));
const tOf = (c: Context) => translator(langOf(c));
// caddy sets X-Forwarded-For from the client address it trusts
const ipOf = (c: Context) => c.req.header("x-nanodeploy-client-ip") ?? "unknown";
app.use("*", async (c, next) => {
  if (c.req.method === "POST") {
    const wait = limit.take(`post:${ipOf(c)}`, 60, 60_000);
    if (wait) {
      c.header("Retry-After", String(wait));
      return c.json({ error: "too many requests" }, 429);
    }
  }
  await next();
});
const wantsHtml = (c: Context, method: string) =>
  method === "GET" && (c.req.header("accept") ?? "").includes("text/html");

// Header values travel as bytes. Node only takes latin1 strings, so a name with
// any other character is sent as its UTF-8 bytes, which is what the gateway
// sent before gate existed: apps decode Remote-Name as UTF-8.
const headerSafe = (s: string) => Buffer.from(s.replace(/[\r\n]/g, " "), "utf8").toString("latin1");

// Every state-changing request on the auth host must come from one of its own
// pages. Browsers send Origin on POST, form or fetch alike.
function sameOrigin(c: Context) {
  return sameRequestOrigin(c.req.header("origin"), c.req.header("sec-fetch-site"), AUTH_ORIGIN);
}

const cookieBase = { path: "/", httpOnly: true, secure: SECURE_COOKIES, sameSite: "Lax" as const };

// A redirect target after sign-in: an absolute URL on one of our hosts, with the
// scheme and port the browser actually uses. Anything else would make the login
// page an open redirect.
function safeTarget(to: string | undefined): URL | null {
  if (!to) return null;
  try {
    const u = new URL(to);
    if (u.protocol !== `${SCHEME}:`) return null;
    if ((u.port || "") !== PUBLIC_PORT) return null;
    if (u.username || u.password) return null;
    const host = u.hostname.toLowerCase();
    if (host !== AUTH_HOST && !slugOfHost(host)) return null;
    return u;
  } catch {
    return null;
  }
}

// a path on the current host, never "//evil.example" or "/\evil.example"
const safePath = safeRedirectPath;

/* ---------- identity ---------- */

async function groupsFor(userId: string) {
  return db.groupsOf(userId);
}

// Who is calling this host: a personal access key, or this host's own session.
async function identify(c: Context, host: string): Promise<{ id: Identity | null; session: db.Session | null }> {
  const auth = c.req.header("authorization") ?? "";
  if (auth.startsWith("Bearer ndk_")) {
    const key = await db.verifyAccessKey(auth.slice(7));
    if (!key) return { id: null, session: null };
    return { id: { user: key.user, groups: await groupsFor(key.user.id), via: "key", keyApps: key.apps }, session: null };
  }
  const session = await db.findSession(getCookie(c, HOST_COOKIE), host);
  if (!session) return { id: null, session: null };
  // console sessions do not slide: they end 12 hours after the person proved
  // who they are, whatever they did since
  await db.touchSession(session, slugOfHost(host) === CONSOLE ? null : ROOT_TTL);
  return { id: { user: session.user, groups: await groupsFor(session.user.id), via: "session" }, session };
}

async function rootSession(c: Context) {
  return db.findSession(getCookie(c, ROOT_COOKIE), AUTH_HOST);
}

const isFresh = (authenticatedAt: Date) => Date.now() - new Date(authenticatedAt).getTime() < CONSOLE_FRESH - 600_000;

/* ---------- host guard ---------- */

// caddy sends three kinds of traffic here: the whole auth host, /_nd/* of every
// app host and of the console, and forward-auth checks. Each route answers only
// on its own kind of host.
app.use("*", async (c, next) => {
  const host = hostOf(c);
  const path = c.req.path;
  if (path === "/verify") {
    if (host === AUTH_HOST) return c.notFound();
  } else if (path.startsWith("/_nd/")) {
    if (!slugOfHost(host)) return c.notFound();
  } else if (host !== AUTH_HOST) {
    return c.notFound();
  }
  await next();
  if (host === AUTH_HOST) {
    c.header("X-Frame-Options", "DENY");
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "no-referrer");
    c.header(
      "Content-Security-Policy",
      "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'; font-src 'self'; script-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'",
    );
    if (!path.startsWith("/static/")) c.header("Cache-Control", "no-store");
  }
});

/* ---------- forward-auth ---------- */

function allow(c: Context, id: Identity | null, roles: string[]) {
  if (id) {
    c.header("Remote-Sub", id.user.id);
    c.header("Remote-User", headerSafe(id.user.username));
    c.header("Remote-Name", headerSafe(id.user.display_name));
    c.header("Remote-Email", headerSafe(id.user.email));
    c.header("Remote-Groups", headerSafe(id.groups.map((g) => g.name).join(",")));
    c.header("Remote-Roles", roles.join(","));
    c.header("Remote-Via", id.via);
  }
  return c.body(null, 200);
}

function challenge(c: Context, host: string, uri: string, method: string, fresh = false) {
  if (wantsHtml(c, method)) {
    const to = encodeURIComponent(originOf(host) + safePath(uri));
    return c.redirect(`${AUTH_ORIGIN}/login?to=${to}${fresh ? "&fresh=1" : ""}`, 302);
  }
  return c.json({ error: "sign in first", login: "/_nd/login" }, 401);
}

function refuse(c: Context, method: string, id: Identity, reason: string) {
  if (wantsHtml(c, method)) {
    return c.html(forbiddenPage(tOf(c), langOf(c), id.user.display_name, reason, AUTH_ORIGIN), 403);
  }
  return c.json({ error: reason }, 403);
}

app.get("/verify", async (c) => {
  const host = (c.req.header("x-forwarded-host") ?? hostOf(c)).toLowerCase().replace(/:\d+$/, "");
  const slug = slugOfHost(host);
  // the site file names its app: a mismatch is a broken config, not a visitor
  if (!slug || slug !== c.req.query("app")) return c.text("gate: host and app do not match", 403);
  const uri = c.req.header("x-forwarded-uri") ?? "/";
  const method = c.req.header("x-forwarded-method") ?? "GET";
  const { id, session } = await identify(c, host);

  // Sibling apps are same-site. SameSite cookies alone do not stop a
  // compromised app from submitting a form with another app's session.
  if (id?.via === "session" && !["GET", "HEAD", "OPTIONS"].includes(method) &&
      !sameRequestOrigin(c.req.header("origin"), c.req.header("sec-fetch-site"), originOf(host))) {
    return c.json({ error: "cross-origin request refused" }, 403);
  }

  if (slug === CONSOLE) {
    // the console is for administrators, signed in recently, in a browser:
    // scripts use the deploy token or a deploy key, which caddy routes apart
    if (!id || id.via !== "session") return challenge(c, host, uri, method, true);
    if (id.user.role !== "admin") return refuse(c, method, id, "console access is for administrators");
    if (!isFresh(session!.authenticated_at)) return challenge(c, host, uri, method, true);
    return allow(c, id, []);
  }

  const policy = await db.getApp(slug);
  if (!policy) return c.text("no such app", 404);
  const granted = id ? await db.grantedRoles(slug, id.user.id, id.groups.map((g) => g.id)) : [];
  const d = decide(policy, id, granted, uri);
  if (!d.ok) {
    if (d.status === 401) return challenge(c, host, uri, method);
    return refuse(c, method, id!, d.reason);
  }
  if (id) db.recordActivity(slug, id.user.id);
  return allow(c, id, d.roles);
});

/* ---------- helpers served on every app host ---------- */

app.get("/_nd/login", (c) => {
  const host = hostOf(c);
  const to = encodeURIComponent(originOf(host) + safePath(c.req.query("rd")));
  return c.redirect(`${AUTH_ORIGIN}/login?to=${to}`, 302);
});

// The auth host lent a root session to this host: turn the one-time code into
// a session that only this host accepts.
app.get("/_nd/callback", async (c) => {
  const host = hostOf(c);
  const code = c.req.query("code") ?? "";
  const path = safePath(c.req.query("path"));
  const rootHash = code ? await db.consumeHandoff(code, host) : null;
  const root = rootHash ? await db.getRoot(rootHash) : null;
  if (!rootHash || !root) {
    return c.redirect(`${AUTH_ORIGIN}/login?to=${encodeURIComponent(originOf(host) + path)}`, 302);
  }
  const isConsole = slugOfHost(host) === CONSOLE;
  const expires = isConsole
    ? new Date(Math.min(new Date(root.authenticated_at).getTime() + CONSOLE_FRESH, new Date(root.expires_at).getTime()))
    : new Date(root.expires_at);
  const raw = await db.createSession({
    userId: root.user_id,
    host,
    parent: rootHash,
    authenticatedAt: root.authenticated_at,
    expiresAt: expires,
    userAgent: c.req.header("user-agent") ?? "",
  });
  setCookie(c, HOST_COOKIE, raw, { ...cookieBase, maxAge: Math.max(60, Math.floor((expires.getTime() - Date.now()) / 1000)) });
  return c.redirect(path, 302);
});

// Signing out anywhere signs out everywhere: the root session and every host
// session made from it go together.
app.get("/_nd/logout", async (c) => {
  const host = hostOf(c);
  const session = await db.findSession(getCookie(c, HOST_COOKIE), host);
  if (session) {
    await db.endFamily(session.parent ?? session.id_hash);
    await db.audit(session.user.id, "logout", host);
  }
  deleteCookie(c, HOST_COOKIE, { path: "/", secure: SECURE_COOKIES });
  return c.redirect(slugOfHost(host) === CONSOLE ? `${AUTH_ORIGIN}/login` : "/", 302);
});

// What the app's frontend needs to adapt itself: who, and with which roles.
app.get("/_nd/me", async (c) => {
  const host = hostOf(c);
  const slug = slugOfHost(host)!;
  const { id } = await identify(c, host);
  c.header("Cache-Control", "no-store");
  if (!id) return c.json({ anonymous: true, login: "/_nd/login", logout: "/_nd/logout" });
  if (id.via === "key" && id.keyApps && !id.keyApps.includes(slug)) {
    return c.json({ error: "this access key is not valid for this app" }, 403);
  }
  let roles: string[] = [];
  if (slug !== CONSOLE) {
    const policy = await db.getApp(slug);
    if (policy) {
      const granted = await db.grantedRoles(slug, id.user.id, id.groups.map((g) => g.id));
      roles = effectiveRoles(policy, id, granted);
    }
  }
  return c.json({
    anonymous: false,
    id: id.user.id,
    username: id.user.username,
    name: id.user.display_name,
    email: id.user.email,
    groups: id.groups.map((g) => g.name),
    roles,
    admin: id.user.role === "admin",
    login: "/_nd/login",
    logout: "/_nd/logout",
    account: `${AUTH_ORIGIN}/account`,
  });
});

/* ---------- sign-in on the auth host ---------- */

async function startRoot(c: Context, user: db.User) {
  const previous = await rootSession(c);
  if (previous) await db.endFamily(previous.id_hash);
  const raw = await db.createSession({
    userId: user.id,
    host: AUTH_HOST,
    parent: null,
    authenticatedAt: new Date(),
    expiresAt: new Date(Date.now() + ROOT_TTL),
    userAgent: c.req.header("user-agent") ?? "",
  });
  setCookie(c, ROOT_COOKIE, raw, { ...cookieBase, maxAge: ROOT_TTL / 1000 });
  await db.touchLogin(user.id);
  return sha256(raw);
}

// Where to send a signed-in browser: the auth host itself, or another host
// through a one-time code that host exchanges for its own session.
async function destination(rootHash: Buffer, target: URL | null): Promise<string> {
  if (!target) return "/account";
  const host = target.hostname.toLowerCase();
  if (host === AUTH_HOST) return target.pathname + target.search;
  const code = await db.createHandoff(rootHash, host);
  const path = encodeURIComponent(target.pathname + target.search);
  return `${originOf(host)}/_nd/callback?code=${code}&path=${path}`;
}

async function appNameFor(target: URL | null) {
  const slug = target ? slugOfHost(target.hostname) : null;
  if (!slug) return null;
  if (slug === CONSOLE) return "Nanodeploy";
  return (await db.getApp(slug))?.name ?? null;
}

const needsFresh = (target: URL | null) => Boolean(target && slugOfHost(target.hostname) === CONSOLE);

app.get("/login", async (c) => {
  const target = safeTarget(c.req.query("to"));
  const root = await rootSession(c);
  if (root && c.req.query("fresh") !== "1" && (!needsFresh(target) || isFresh(root.authenticated_at))) {
    return c.redirect(await destination(root.id_hash, target), 302);
  }
  return c.html(
    loginPage(tOf(c), langOf(c), {
      to: target?.href ?? "",
      appName: await appNameFor(target),
      consoleConfirm: Boolean(root) && needsFresh(target),
      login: root?.user.username,
    }),
  );
});

app.post("/login", async (c) => {
  const t = tOf(c);
  const lang = langOf(c);
  if (!sameOrigin(c)) return c.text("cross-origin request refused", 403);
  const form = await c.req.parseBody();
  const login = String(form.login ?? "").trim().slice(0, 200);
  const password = String(form.password ?? "");
  const target = safeTarget(String(form.to ?? ""));
  const keys = [`ip:${ipOf(c)}`, `login:${login.toLowerCase()}`];
  const render = async (error: string, status: 401 | 429) =>
    c.html(loginPage(t, lang, { to: target?.href ?? "", appName: await appNameFor(target), error, login }), status);

  const wait = limit.waitSeconds(keys);
  if (wait > 0) return render(t("tooMany", { s: wait }), 429);

  const user = login ? await db.findLogin(login) : null;
  const hash = user && user.status === "active" ? await db.passwordOf(user.id) : null;
  const ok = hash ? await verifyPassword(password, hash) : (await burnTime(password), false);
  if (!user || !ok) {
    limit.failed(keys);
    await db.audit(user?.id ?? null, "login_failed", login, { ip: ipOf(c) });
    return render(t("wrongCredentials"), 401);
  }
  limit.succeeded(keys);
  if (hash && passwordNeedsRehash(hash)) await db.setPassword(user.id, await hashPassword(password));
  await db.markPasswordUsed(user.id);
  await db.audit(user.id, "login", "password", { ip: ipOf(c) });
  const rootHash = await startRoot(c, user);
  return c.redirect(await destination(rootHash, target), 303);
});

app.post("/logout", async (c) => {
  if (!sameOrigin(c)) return c.text("cross-origin request refused", 403);
  const root = await rootSession(c);
  if (root) {
    await db.endFamily(root.id_hash);
    await db.audit(root.user.id, "logout", AUTH_HOST);
  }
  deleteCookie(c, ROOT_COOKIE, { path: "/", secure: SECURE_COOKIES });
  return c.redirect("/login", 303);
});

/* ---------- passkeys ---------- */

const passkeyCookie = (c: Context, id: string) =>
  setCookie(c, WEBAUTHN_COOKIE, id, { ...cookieBase, sameSite: "Strict", maxAge: 300 });

app.post("/webauthn/login/options", async (c) => {
  if (!sameOrigin(c)) return c.json({ error: "cross-origin request refused" }, 403);
  const options = await generateAuthenticationOptions({ rpID: RP_ID, userVerification: "required" });
  passkeyCookie(c, await db.saveChallenge(options.challenge, null));
  return c.json(options);
});

app.post("/webauthn/login/verify", async (c) => {
  if (!sameOrigin(c)) return c.json({ error: "cross-origin request refused" }, 403);
  const keys = [`ip:${ipOf(c)}`];
  if (limit.waitSeconds(keys) > 0) return c.json({ error: "too many attempts" }, 429);
  const body = await c.req.json().catch(() => null);
  const challenge = await db.takeChallenge(getCookie(c, WEBAUTHN_COOKIE));
  deleteCookie(c, WEBAUTHN_COOKIE, { path: "/", secure: SECURE_COOKIES });
  const response = body?.response;
  const passkey = typeof response?.id === "string" ? await db.passkeyById(response.id) : null;
  const user = passkey ? await db.getUser(passkey.user_id) : null;
  if (!challenge || !passkey || !user || user.status !== "active") {
    limit.failed(keys);
    return c.json({ error: "unknown passkey" }, 401);
  }
  try {
    const result = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge.challenge,
      expectedOrigin: AUTH_ORIGIN,
      expectedRPID: RP_ID,
      requireUserVerification: true,
      credential: {
        id: passkey.webauthn_id,
        publicKey: new Uint8Array(passkey.public_key),
        counter: Number(passkey.counter),
        transports: passkey.transports as AuthenticatorTransportFuture[],
      },
    });
    if (!result.verified) throw new Error("not verified");
    await db.bumpPasskey(passkey.id, result.authenticationInfo.newCounter);
  } catch (err) {
    limit.failed(keys);
    await db.audit(user.id, "login_failed", "passkey", { ip: ipOf(c) });
    return c.json({ error: "passkey refused" }, 401);
  }
  limit.succeeded(keys);
  await db.audit(user.id, "login", "passkey", { ip: ipOf(c) });
  const rootHash = await startRoot(c, user);
  return c.json({ redirect: await destination(rootHash, safeTarget(body?.to)) });
});

// Registering a passkey needs to know whose it is: the signed-in account, or the
// account a welcome or reset link was made for.
async function registrant(c: Context, token: unknown): Promise<{ user: db.User; tokenRow: db.TokenRow | null } | null> {
  if (typeof token === "string" && token) {
    const row = await db.findToken(token);
    if (!row || !row.user_id || row.purpose === "setup") return null;
    const user = await db.getUser(row.user_id);
    return user && user.status === "active" ? { user, tokenRow: row } : null;
  }
  const root = await rootSession(c);
  return root && recentlyAuthenticated(root.authenticated_at) ? { user: root.user, tokenRow: null } : null;
}

app.post("/webauthn/register/options", async (c) => {
  if (!sameOrigin(c)) return c.json({ error: "cross-origin request refused" }, 403);
  const body = await c.req.json().catch(() => ({}));
  const who = await registrant(c, body?.token);
  if (!who) return c.json({ error: "confirm sign in first", login: "/login?fresh=1" }, 401);
  const existing = await db.passkeysOf(who.user.id);
  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: RP_ID,
    userName: who.user.username,
    userDisplayName: who.user.display_name,
    userID: new TextEncoder().encode(who.user.id),
    attestationType: "none",
    excludeCredentials: existing.map((p) => ({ id: p.webauthn_id, transports: p.transports as AuthenticatorTransportFuture[] })),
    // discoverable: the login page asks for "a passkey", not for a username first
    authenticatorSelection: { residentKey: "required", userVerification: "required" },
  });
  passkeyCookie(c, await db.saveChallenge(options.challenge, who.user.id));
  return c.json(options);
});

app.post("/webauthn/register/verify", async (c) => {
  if (!sameOrigin(c)) return c.json({ error: "cross-origin request refused" }, 403);
  const body = await c.req.json().catch(() => null);
  const who = await registrant(c, body?.token);
  const challenge = await db.takeChallenge(getCookie(c, WEBAUTHN_COOKIE));
  deleteCookie(c, WEBAUTHN_COOKIE, { path: "/", secure: SECURE_COOKIES });
  if (!who || !challenge || challenge.user_id !== who.user.id) return c.json({ error: "start again" }, 400);
  let info;
  try {
    const result = await verifyRegistrationResponse({
      response: body.response,
      expectedChallenge: challenge.challenge,
      expectedOrigin: AUTH_ORIGIN,
      expectedRPID: RP_ID,
      requireUserVerification: true,
    });
    if (!result.verified || !result.registrationInfo) throw new Error("not verified");
    info = result.registrationInfo;
  } catch {
    return c.json({ error: "passkey refused" }, 400);
  }
  // a link is spent by the passkey just as by a password
  if (who.tokenRow && !(await db.useToken(who.tokenRow.token_hash))) {
    return c.json({ error: "this link was already used" }, 400);
  }
  await db.addPasskey(who.user.id, {
    id: info.credential.id,
    publicKey: info.credential.publicKey,
    counter: info.credential.counter,
    transports: info.credential.transports ?? [],
    label: String(body?.label ?? "").trim().slice(0, 60) || ago(langOf(c), new Date()),
  });
  await db.audit(who.user.id, "passkey_added", null);
  if (who.tokenRow) {
    if (who.tokenRow.purpose === "reset") await db.endUserSessions(who.user.id);
    await startRoot(c, who.user);
  }
  return c.json({ redirect: "/account" });
});

/* ---------- welcome, reset and setup links ---------- */

const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{1,31}$/;

app.get("/welcome/:token", async (c) => {
  const t = tOf(c);
  const lang = langOf(c);
  const token = c.req.param("token");
  const row = await db.findToken(token);
  if (!row) return c.html(messagePage(t, lang, t("signIn"), t("linkInvalid")), 410);
  const user = row.user_id ? await db.getUser(row.user_id) : null;
  if (row.purpose !== "setup" && !user) return c.html(messagePage(t, lang, t("signIn"), t("linkInvalid")), 410);
  return c.html(tokenPage(t, lang, { token, purpose: row.purpose, name: user?.display_name ?? "" }));
});

app.post("/welcome/:token", async (c) => {
  const t = tOf(c);
  const lang = langOf(c);
  if (!sameOrigin(c)) return c.text("cross-origin request refused", 403);
  const token = c.req.param("token");
  const row = await db.findToken(token);
  if (!row) return c.html(messagePage(t, lang, t("signIn"), t("linkInvalid")), 410);
  const form = await c.req.parseBody();
  const values = {
    username: String(form.username ?? "").trim().toLowerCase(),
    display_name: String(form.display_name ?? "").trim().slice(0, 80),
    email: String(form.email ?? "").trim().slice(0, 200),
  };
  const password = String(form.password ?? "");
  let user = row.user_id ? await db.getUser(row.user_id) : null;
  const again = (key: Parameters<typeof t>[0]) =>
    c.html(tokenPage(t, lang, { token, purpose: row.purpose, name: user?.display_name ?? "", error: t(key), values }), 400);

  if (row.purpose === "setup") {
    if (!USERNAME_RE.test(values.username)) return again("usernameInvalid");
    if (!values.display_name) return again("nameRequired");
    if (await db.usernameTaken(values.username)) return again("usernameTaken");
  } else if (!user) {
    return c.html(messagePage(t, lang, t("signIn"), t("linkInvalid")), 410);
  }
  const problem = passwordProblem(password, user?.username ?? values.username);
  if (problem) return again(problem as Parameters<typeof t>[0]);
  if (password !== String(form.confirm ?? "")) return again("pwMismatch");

  if (!(await db.useToken(row.token_hash))) return c.html(messagePage(t, lang, t("signIn"), t("linkInvalid")), 410);
  if (row.purpose === "setup") {
    const id = randomUUID();
    await db.createAdmin({ id, username: values.username, displayName: values.display_name, email: values.email });
    user = (await db.getUser(id))!;
  }
  await db.setPassword(user!.id, await hashPassword(password));
  // a reset means the old password may be known to someone else
  if (row.purpose === "reset") await db.endUserSessions(user!.id);
  await db.audit(user!.id, `password_${row.purpose}`, null);
  await startRoot(c, user!);
  return c.redirect("/account", 303);
});

/* ---------- account ---------- */

async function accountView(c: Context, root: db.Session, extra: { newKey?: string; notice?: string; error?: string } = {}) {
  const id: Identity = { user: root.user, groups: await groupsFor(root.user.id), via: "session" };
  const [apps, grants, passkeys, keys, hasPassword] = await Promise.all([
    db.listApps(),
    db.allGrants(root.user.id, id.groups.map((g) => g.id)),
    db.passkeysOf(root.user.id),
    db.accessKeysOf(root.user.id),
    db.passwordOf(root.user.id).then(Boolean),
  ]);
  const open = apps
    .map((a) => {
      const roles = effectiveRoles(a, id, grants.filter((g) => g.slug === a.slug).map((g) => g.role));
      return { a, roles };
    })
    .filter(({ a, roles }) => canOpen(a, id, roles));
  return accountPage(tOf(c), langOf(c), {
    user: root.user,
    apps: open.map(({ a, roles }) => ({ name: a.name, url: `${originOf(hostOfSlug(a.slug))}/`, roles })),
    hasPassword,
    passkeys,
    keys,
    keyApps: open.map(({ a }) => ({ slug: a.slug, name: a.name })),
    ...extra,
  });
}

// every /account route needs the root session; without one, sign in and come back
async function requireRoot(c: Context, recent = false) {
  const root = await rootSession(c);
  if (!root) return { root: null, redirect: c.redirect(`/login?to=${encodeURIComponent(`${AUTH_ORIGIN}/account`)}`, 303) };
  if (recent && !recentlyAuthenticated(root.authenticated_at)) {
    return { root: null, redirect: c.redirect(`/login?fresh=1&to=${encodeURIComponent(`${AUTH_ORIGIN}/account`)}`, 303) };
  }
  return { root, redirect: null };
}

app.get("/", (c) => c.redirect("/account", 302));

app.get("/account", async (c) => {
  const { root, redirect } = await requireRoot(c);
  if (!root) return redirect;
  return c.html(await accountView(c, root));
});

app.post("/account/password", async (c) => {
  const t = tOf(c);
  if (!sameOrigin(c)) return c.text("cross-origin request refused", 403);
  const { root, redirect } = await requireRoot(c, true);
  if (!root) return redirect;
  const form = await c.req.parseBody();
  const current = await db.passwordOf(root.user.id);
  const keys = [`ip:${ipOf(c)}`, `login:${root.user.username}`];
  if (current) {
    const wait = limit.waitSeconds(keys);
    if (wait > 0) return c.html(await accountView(c, root, { error: t("tooMany", { s: wait }) }), 429);
    if (!(await verifyPassword(String(form.current ?? ""), current))) {
      limit.failed(keys);
      return c.html(await accountView(c, root, { error: t("wrongCurrent") }), 400);
    }
  }
  const password = String(form.password ?? "");
  const problem = passwordProblem(password, root.user.username);
  if (problem) return c.html(await accountView(c, root, { error: t(problem as Parameters<typeof t>[0]) }), 400);
  if (password !== String(form.confirm ?? "")) return c.html(await accountView(c, root, { error: t("pwMismatch") }), 400);
  await db.setPassword(root.user.id, await hashPassword(password));
  await db.endUserSessions(root.user.id);
  await startRoot(c, root.user);
  await db.audit(root.user.id, "password_changed", null);
  return c.html(await accountView(c, root, { notice: t("passwordSaved") }));
});

app.post("/account/passkeys/:id/delete", async (c) => {
  const t = tOf(c);
  if (!sameOrigin(c)) return c.text("cross-origin request refused", 403);
  const { root, redirect } = await requireRoot(c, true);
  if (!root) return redirect;
  if (!/^\d{1,18}$/.test(c.req.param("id"))) return c.notFound();
  if ((await db.deletePasskey(root.user.id, c.req.param("id"))) === "last") {
    return c.html(await accountView(c, root, { error: t("lastCredential") }), 400);
  }
  await db.audit(root.user.id, "passkey_removed", c.req.param("id"));
  return c.redirect("/account", 303);
});

app.post("/account/keys", async (c) => {
  if (!sameOrigin(c)) return c.text("cross-origin request refused", 403);
  const { root, redirect } = await requireRoot(c, true);
  if (!root) return redirect;
  const form = await c.req.parseBody();
  const label = String(form.label ?? "").replace(/[\r\n]/g, " ").trim().slice(0, 60) || "key";
  const slug = String(form.app ?? "");
  if ((await db.accessKeysOf(root.user.id)).length >= 20) return c.redirect("/account", 303);
  if (slug) {
    if (!/^[a-z][a-z0-9-]{1,62}$/.test(slug)) return c.json({ error: "invalid app" }, 400);
    const policy = await db.getApp(slug);
    const groups = await groupsFor(root.user.id);
    const granted = policy ? await db.grantedRoles(slug, root.user.id, groups.map((g) => g.id)) : [];
    const identity: Identity = { user: root.user, groups, via: "session" };
    if (!policy || !canOpen(policy, identity, effectiveRoles(policy, identity, granted))) {
      return c.json({ error: "unknown or inaccessible app" }, 400);
    }
  }
  const apps = slug ? [slug] : null;
  const key = await db.createAccessKey(root.user.id, label, apps, 90);
  await db.audit(root.user.id, "access_key_created", label, { apps });
  // shown in this response only: there is no way to read it back
  return c.html(await accountView(c, root, { newKey: key }));
});

app.post("/account/keys/:id/delete", async (c) => {
  if (!sameOrigin(c)) return c.text("cross-origin request refused", 403);
  const { root, redirect } = await requireRoot(c, true);
  if (!root) return redirect;
  if (!/^\d{1,18}$/.test(c.req.param("id"))) return c.notFound();
  await db.deleteAccessKey(root.user.id, c.req.param("id"));
  await db.audit(root.user.id, "access_key_removed", c.req.param("id"));
  return c.redirect("/account", 303);
});

/* ---------- static files and startup ---------- */

// Access-denied pages are also rendered on app hosts; these public fonts
// must load from the auth host without sharing credentials.
app.use("/static/fonts/*", async (c, next) => {
  c.header("Access-Control-Allow-Origin", "*");
  await next();
});
app.use("/static/*", serveStatic({ root: "./public", rewriteRequestPath: (p) => p.replace(/^\/static/, "") }));

setInterval(() => db.sweep().catch((err) => console.error("sweep failed", err)), 3_600_000).unref();
setInterval(() => db.flushActivity().catch((err) => console.error("activity flush failed", err)), 60_000).unref();
// a restart (an upgrade, a reboot) keeps the last minute of activity
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => db.flushActivity().finally(() => process.exit(0)));
}

serve({ fetch: app.fetch, port: Number(process.env.PORT ?? 4000) });
console.log(`gate on :${process.env.PORT ?? 4000} for ${AUTH_ORIGIN}`);
