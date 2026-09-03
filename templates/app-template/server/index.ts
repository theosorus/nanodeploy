import { serve } from "@hono/node-server";
import { Hono } from "hono";
import type { Context } from "hono";
import { eq } from "drizzle-orm";
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
  if (!u) return c.json({ error: "identifiez-vous" }, 401);
  const rows = await db.select().from(notes).where(eq(notes.ownerId, u.id));
  return c.json(rows);
});

app.post("/api/notes", async (c) => {
  const u = currentUser(c);
  if (!u) return c.json({ error: "identifiez-vous" }, 401);
  const { body } = await c.req.json<{ body: string }>();
  const [row] = await db.insert(notes).values({ ownerId: u.id, body }).returning();
  return c.json(row, 201);
});

app.get("/api/me", (c) => {
  const u = currentUser(c);
  return c.json(u ? u : { anonymous: true });
});

serve({ fetch: app.fetch, port: Number(process.env.PORT ?? 3000) });
