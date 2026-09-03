import type { Context } from "hono";

export type User = { id: string; email: string; name: string; groups: string[] };

// Identity is injected by the gateway after forward-auth. The app never handles
// login. Caddy strips any inbound Remote-* header, and the container publishes
// no port, so these headers can only come from the gateway.
export function getUser(c: Context): User {
  const id = c.req.header("Remote-Sub");
  if (!id) throw new Error("no identity header, this app must run behind the gateway");
  return {
    id,
    email: c.req.header("Remote-Email") ?? "",
    name: c.req.header("Remote-Name") ?? "",
    groups: (c.req.header("Remote-Groups") ?? "").split(",").filter(Boolean),
  };
}
