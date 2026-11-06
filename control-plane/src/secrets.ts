import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// Forge credentials (a GitHub App's private key, a GitLab token, webhook
// secrets) are encrypted at rest with AES-256-GCM. The key lives in .env
// (NANODEPLOY_SECRET_KEY, 64 hex characters, made by install.sh), never in the
// database: a stolen database dump or backup does not give access to your
// repositories.
const raw = process.env.NANODEPLOY_SECRET_KEY ?? "";
const key = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, "hex") : null;

export const ready = () => key !== null;

export function seal(plain: string): string {
  if (!key) throw new Error("NANODEPLOY_SECRET_KEY is not set: run ./install.sh, then restart the control plane");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return `v1.${iv.toString("base64")}.${cipher.getAuthTag().toString("base64")}.${body.toString("base64")}`;
}

export function open(sealed: string): string {
  if (!key) throw new Error("NANODEPLOY_SECRET_KEY is not set");
  const [v, iv, tag, body] = sealed.split(".");
  if (v !== "v1") throw new Error("unknown secret format");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(body, "base64")), decipher.final()]).toString("utf8");
}
