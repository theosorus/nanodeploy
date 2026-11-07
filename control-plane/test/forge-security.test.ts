import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createServer, type Server } from "node:http";

const servers: Server[] = [];
let originAuth: string | undefined;
let redirectedAuth: string | undefined;
let redirectedPrivate: string | undefined;
let forge: ReturnType<typeof import("../src/forges.ts").forgeOf>;

async function listen(server: Server) {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

before(async () => {
  const destination = await listen(createServer((req, res) => {
    redirectedAuth = req.headers.authorization;
    redirectedPrivate = req.headers["private-token"] as string | undefined;
    res.end("disposable archive");
  }));
  const source = await listen(createServer((req, res) => {
    originAuth = req.headers.authorization;
    res.writeHead(302, { location: `${destination}/archive` }).end();
  }));
  process.env.GITLAB_URL = source;
  process.env.NANODEPLOY_SECRET_KEY = "33".repeat(32);
  const [{ forgeOf }, { seal }] = await Promise.all([import("../src/forges.ts"), import("../src/secrets.ts")]);
  forge = forgeOf({ id: "1", kind: "gitlab", name: "test", config: { projectId: "123" },
    secret_enc: seal("fake-project-access-token"), webhook_secret_enc: seal("fake-hook") });
});

after(async () => {
  for (const server of servers) await new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); });
});

test("GitLab archive redirects keep project credentials at the original origin", async () => {
  assert.equal((await forge.archive("unused", "a".repeat(40))).toString(), "disposable archive");
  assert.equal(originAuth, "Bearer fake-project-access-token");
  assert.equal(redirectedAuth, undefined);
  assert.equal(redirectedPrivate, undefined);
});
