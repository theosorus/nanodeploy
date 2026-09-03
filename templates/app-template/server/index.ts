import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { db } from "./db.js";
import { notes } from "./schema.js";
import { getUser } from "./auth.js";

const app = new Hono();

// Every route lives under /api, the gateway serves the frontend itself.
app.get("/api/notes", async (c) => {
  const user = getUser(c);
  const rows = await db.select().from(notes).where(eq(notes.ownerId, user.id));
  return c.json(rows);
});

app.post("/api/notes", async (c) => {
  const user = getUser(c);
  const { body } = await c.req.json<{ body: string }>();
  const [row] = await db.insert(notes).values({ ownerId: user.id, body }).returning();
  return c.json(row, 201);
});

app.get("/api/me", (c) => c.json(getUser(c)));

serve({ fetch: app.fetch, port: Number(process.env.PORT ?? 3000) });
