import type { AppRow } from "./db.js";
import { open, seal } from "./secrets.js";

export const sealEnvironment = (slug: string, env: Record<string, string>) =>
  seal(JSON.stringify(env), `apps:${slug}:environment`);
export const sealDatabasePassword = (slug: string, password: string) =>
  seal(password, `apps:${slug}:database-password`);

// Legacy rows are decoded during the startup migration too. All writes use
// authenticated ciphertext, bound to both the app slug and the kind of secret.
export function openAppSecrets(row: AppRow): AppRow {
  const stored: unknown = row.env;
  const env = typeof stored === "string" ? JSON.parse(open(stored, `apps:${row.slug}:environment`)) : stored;
  if (!env || typeof env !== "object" || Array.isArray(env) || Object.values(env).some((v) => typeof v !== "string")) {
    throw new Error(`invalid stored environment for ${row.slug}`);
  }
  return {
    ...row,
    env,
    db_password: row.db_password?.startsWith("v1.")
      ? open(row.db_password, `apps:${row.slug}:database-password`) : row.db_password,
  };
}
