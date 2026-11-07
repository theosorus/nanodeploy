import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Hono } from "hono";
import { consoleCsp, sameConsoleOrigin } from "../src/http-security.ts";

process.env.APPS_DOMAIN = "apps.audit.invalid";
process.env.PUBLIC_SCHEME = "https";
process.env.PUBLIC_PORT = "";
const app = new Hono();
app.post("/api/change", (c) => c.text("checked", sameConsoleOrigin(c) ? 200 : 403));

test("cookie mutations require positive same-origin evidence", async () => {
  for (const headers of [
    {}, { origin: "https://evil.invalid" }, { origin: "http://deploy.apps.audit.invalid" },
    { "sec-fetch-site": "same-site" }, { "sec-fetch-site": "none" },
    { origin: "https://evil.invalid", "sec-fetch-site": "same-origin" },
    { origin: "https://evil.invalid", host: "evil.invalid" },
  ]) assert.equal((await app.request("/api/change", { method: "POST", headers })).status, 403, JSON.stringify(headers));
  for (const headers of [{ origin: "https://deploy.apps.audit.invalid" }, { "sec-fetch-site": "same-origin" }]) {
    assert.equal((await app.request("/api/change", { method: "POST", headers })).status, 200);
  }
});

test("the console CSP permits only the actual inline script and trusted form targets", async () => {
  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  const csp = consoleCsp(html, "https://github.com");
  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)].filter((m) => m[1].trim());
  assert.ok(scripts.length > 0);
  for (const script of scripts) assert.ok(csp.includes(`'sha256-${createHash("sha256").update(script[1]).digest("base64")}'`));
  assert.doesNotMatch(csp, /script-src[^;]*unsafe/);
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /form-action 'self' https:\/\/github.com/);
});
