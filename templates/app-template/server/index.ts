import { serve } from "@hono/node-server";
import { Hono } from "hono";
import type { Context } from "hono";
import { desc, eq } from "drizzle-orm";
import { db } from "./db.js";
import { notes } from "./schema.js";
import { tryGetUser } from "./auth.js";

const app = new Hono();

// an app can be switched to public from the dashboard, which removes the
// identity headers: answer 401 instead of crashing on a missing user
const currentUser = (c: Context) => tryGetUser(c);

// Every route lives under /api, the gateway serves the frontend itself.
app.get("/api/notes", async (c) => {
  const u = currentUser(c);
  if (!u) return c.json({ error: "sign in first" }, 401);
  // the ownerId filter is the whole authorisation model: never query a
  // user-owned table without it, or one account reads another's rows
  const rows = await db
    .select()
    .from(notes)
    .where(eq(notes.ownerId, u.id))
    .orderBy(desc(notes.createdAt))
    .limit(200);
  return c.json(rows);
});

app.post("/api/notes", async (c) => {
  const u = currentUser(c);
  if (!u) return c.json({ error: "sign in first" }, 401);

  // Validate at the edge, always. The body is whatever the network sent, not
  // whatever the frontend meant to send: a bound on every string keeps a shared
  // 4 GB machine from being filled by one request.
  const payload = await c.req.json<{ body?: unknown }>().catch(() => null);
  const body = typeof payload?.body === "string" ? payload.body.trim() : "";
  if (!body) return c.json({ error: "the note is empty" }, 400);
  if (body.length > 2000) return c.json({ error: "the note is longer than 2000 characters" }, 400);

  const [row] = await db.insert(notes).values({ ownerId: u.id, body }).returning();
  return c.json(row, 201);
});

app.get("/api/me", (c) => {
  const u = currentUser(c);
  return c.json(u ? u : { anonymous: true });
});

serve({ fetch: app.fetch, port: Number(process.env.PORT ?? 3000) });
