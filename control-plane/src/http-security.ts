import { createHash } from "node:crypto";
import type { Context } from "hono";

export function requestBudget(maximum: number, windowMs: number) {
  const buckets = new Map<string, { count: number; until: number }>();
  return (key: string) => {
    const now = Date.now();
    const bucket = buckets.get(key);
    if (!bucket || bucket.until <= now) {
      if (!buckets.has(key) && buckets.size >= 10_000) buckets.delete(buckets.keys().next().value!);
      buckets.set(key, { count: 1, until: now + windowMs });
      return 0;
    }
    if (bucket.count >= maximum) return Math.max(1, Math.ceil((bucket.until - now) / 1000));
    bucket.count++;
    return 0;
  };
}

export function sameConsoleOrigin(c: Context) {
  const site = c.req.header("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return false;
  const origin = c.req.header("origin");
  const scheme = process.env.PUBLIC_SCHEME === "http" ? "http" : "https";
  const port = process.env.PUBLIC_PORT ? `:${process.env.PUBLIC_PORT}` : "";
  const expected = `${scheme}://deploy.${process.env.APPS_DOMAIN}${port}`;
  // Cookie callers must prove the origin even when Fetch Metadata is absent.
  // Token callers are exempt in the authentication middleware.
  return origin ? origin === new URL(expected).origin : site === "same-origin";
}

export function consoleCsp(html: string, forgeOrigin: string) {
  const hashes = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
    .filter((m) => m[1].trim())
    .map((m) => `'sha256-${createHash("sha256").update(m[1]).digest("base64")}'`);
  return `default-src 'self'; script-src 'self' ${hashes.join(" ")}; style-src 'self' 'unsafe-inline'; ` +
    `img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; ` +
    `frame-ancestors 'none'; form-action 'self' ${new URL(forgeOrigin).origin}`;
}
