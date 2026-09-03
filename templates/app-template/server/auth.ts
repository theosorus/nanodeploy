import type { Context } from "hono";

export type User = { id: string; email: string; name: string; groups: string[] };

// Identity is injected by the gateway after forward-auth. The app never handles
// login. Caddy strips any inbound Remote-* header, and the container publishes
// no port, so these headers can only come from the gateway.
export function tryGetUser(c: Context): User | null {
  const id = c.req.header("Remote-Sub");
  if (!id) return null;
  return {
    id,
    email: c.req.header("Remote-Email") ?? "",
    name: c.req.header("Remote-Name") ?? "",
    groups: (c.req.header("Remote-Groups") ?? "").split(",").filter(Boolean),
  };
}

// For apps that are always private. Public apps have no identity and every
// route that needs a user must answer 401 instead (see tryGetUser).
export function getUser(c: Context): User {
  const user = tryGetUser(c);
  if (!user) throw new Error("no identity header, this app must run behind the gateway");
  return user;
}
