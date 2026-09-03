import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

// Keep the pool tiny: the Postgres instance is shared by every app and each
// connection is a forked backend process on the server.
const client = postgres(process.env.DATABASE_URL!, { max: 3, idle_timeout: 20 });

export const db = drizzle(client, { schema });
