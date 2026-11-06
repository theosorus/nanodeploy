import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";

export type User = { id: string; email: string; name: string; groups: string[]; roles: string[] };

// Header values arrive as bytes; node reads them as latin1. The gateway sends
// UTF-8, so a name like "Zoé" or "王" must be decoded back.
const utf8 = (v: string | undefined) => Buffer.from(v ?? "", "latin1").toString("utf8");
const list = (v: string | undefined) =>
  utf8(v)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

// Identity is injected by the gateway (gate) after its access check. The app
// never handles login. Caddy strips any inbound Remote-* header, and the
// container publishes no port, so these headers can only come from the gateway.
// On a public app, a visitor who is not signed in simply has none.
export function tryGetUser(c: Context): User | null {
  const id = c.req.header("Remote-Sub");
  if (!id) return null;
  return {
    id,
    email: utf8(c.req.header("Remote-Email")),
    name: utf8(c.req.header("Remote-Name")),
    groups: list(c.req.header("Remote-Groups")),
    // the roles this person holds in THIS app, as declared in app.yaml and given
    // in the dashboard (administrators hold them all)
    roles: list(c.req.header("Remote-Roles")),
  };
}

// For apps that are always private. Public apps have no identity and every
// route that needs a user must answer 401 instead (see tryGetUser).
export function getUser(c: Context): User {
  const user = tryGetUser(c);
  if (!user) throw new Error("no identity header, this app must run behind the gateway");
  return user;
}

export const hasRole = (c: Context, role: string) => tryGetUser(c)?.roles.includes(role) ?? false;

// The second lock on a route the manifest already protects (protect: in
// app.yaml): if that rule is ever mistyped, the route still refuses.
export function requireRole(c: Context, role: string): User {
  const user = tryGetUser(c);
  if (!user) throw new HTTPException(401, { message: "sign in first" });
  if (!user.roles.includes(role)) throw new HTTPException(403, { message: `this needs the ${role} role` });
  return user;
}
