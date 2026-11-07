import assert from "node:assert/strict";
import { afterEach, mock, test } from "node:test";
import { api } from "../src/client.ts";

afterEach(() => mock.restoreAll());

test("a successful empty response does not get parsed as JSON", async () => {
  const fetch = mock.method(globalThis, "fetch", async () => new Response(null, { status: 204 }));
  assert.equal(await api("/api/items/1", { method: "DELETE" }), undefined);
  assert.equal(fetch.mock.callCount(), 1);
});

test("an unexpected text success never repeats a mutation", async () => {
  const fetch = mock.method(globalThis, "fetch", async () => new Response("saved", { headers: { "content-type": "text/plain" } }));
  await assert.rejects(api("/api/items", { method: "POST", body: "a note" }));
  assert.equal(fetch.mock.callCount(), 1);
});

test("a JSON error is returned immediately with its original message", async () => {
  const fetch = mock.method(globalThis, "fetch", async () => Response.json({ error: "access denied" }, { status: 403 }));
  await assert.rejects(api("/api/admin"), /access denied/);
  assert.equal(fetch.mock.callCount(), 1);
});

test("an abort during waking stops immediately", async () => {
  const controller = new AbortController();
  const fetch = mock.method(globalThis, "fetch", async () => new Response("waking", { headers: { "content-type": "text/html" } }));
  await assert.rejects(api("/api/items", { signal: controller.signal }, { onWaking: () => controller.abort() }), { name: "AbortError" });
  assert.equal(fetch.mock.callCount(), 1);
});

test("an HTML wake page retries until the JSON backend answers", async () => {
  let attempt = 0, wakes = 0;
  mock.method(globalThis, "fetch", async () => ++attempt === 1
    ? new Response("waking", { headers: { "content-type": "text/html" } })
    : Response.json({ ready: true }));
  assert.deepEqual(await api("/api/items", undefined, { onWaking: () => wakes++ }), { ready: true });
  assert.equal(attempt, 2);
  assert.equal(wakes, 1);
});

test("a redirect to the sign-in page is not mistaken for a wake page", async () => {
  const res = new Response("sign in", { headers: { "content-type": "text/html" } });
  Object.defineProperty(res, "redirected", { value: true });
  const fetch = mock.method(globalThis, "fetch", async () => res);
  await assert.rejects(api("/api/items"));
  assert.equal(fetch.mock.callCount(), 1);
});
