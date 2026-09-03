import type { Config } from "drizzle-kit";

// migrations are generated here on the dev machine, never on the server
export default {
  schema: "./server/schema.ts",
  out: "./migrations",
  dialect: "postgresql",
} satisfies Config;
