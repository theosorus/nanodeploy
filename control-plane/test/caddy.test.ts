import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { get, request as httpRequest } from "node:http";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { build } from "esbuild";

const exec = promisify(execFile);
const image = process.env.NANODEPLOY_TEST_CADDY_IMAGE;
const app = (slug: string, protect: object[] = []) => ({ slug, name: "Audit", access: "public", port: null,
  groups: [], warm: false, idle_timeout: "10m", env: {}, roles: ["moderator"], protect });

test("Caddy config is restored when reloading throws, on update and removal", async () => {
  const work = await mkdtemp(join(tmpdir(), "nanodeploy-caddy-config-"));
  process.env.CADDY_CONF_DIR = work;
  process.env.APPS_DOMAIN = "apps.audit.invalid";
  const outfile = join(work, "caddy.mjs");
  await build({ entryPoints: [fileURLToPath(new URL("../src/caddy.ts", import.meta.url))],
    outfile, bundle: true, format: "esm", platform: "node",
    plugins: [{ name: "broken-reload", setup(b) {
      b.onResolve({ filter: /^\.\/docker\.js$/ }, () => ({ path: "docker", namespace: "audit" }));
      b.onLoad({ filter: /.*/, namespace: "audit" }, () => ({ contents: "export async function reloadCaddy() { throw new Error('Docker disconnected'); }" }));
    } }],
  });
  try {
    const caddy = await import(pathToFileURL(outfile).href);
    const file = join(work, "audit.caddy");
    await writeFile(file, "previous working configuration");
    assert.equal(await caddy.applySite(app("audit")), false);
    assert.equal(await readFile(file, "utf8"), "previous working configuration");
    assert.equal(await caddy.dropSite("audit"), false);
    assert.equal(await readFile(file, "utf8"), "previous working configuration");
  } finally { await rm(work, { recursive: true, force: true }); }
});

test("always-on backends bypass Sablier and keep their authentication route", async () => {
  process.env.APPS_DOMAIN = "apps.audit.invalid";
  const { renderSite } = await import("../src/caddy.ts");
  const backend = { ...app("availability"), port: 3000 };
  const cold = renderSite(backend as any);
  const warm = renderSite({ ...backend, warm: true } as any);
  assert.match(cold, /sablier http:\/\/sablier:10000/);
  assert.match(cold, /session_duration 10m/);
  assert.doesNotMatch(warm, /sablier/);
  for (const route of [cold, warm]) {
    assert.match(route, /import nanodeploy_gate availability/);
    assert.match(route, /reverse_proxy app-availability:3000/);
  }
});

test("a real Caddy routes alternate protected paths through authentication", { skip: !image, timeout: 30000 }, async () => {
  const work = await mkdtemp(join(tmpdir(), "nanodeploy-caddy-routing-"));
  const name = `nanodeploy-audit-caddy-${process.pid}`;
  process.env.APPS_DOMAIN = "apps.audit.invalid";
  const { renderSite } = await import("../src/caddy.ts");
  let started = false;
  try {
    for (const slug of ["protected", "public"]) {
      await mkdir(join(work, "apps", slug, "current", "dist"), { recursive: true });
      await writeFile(join(work, "apps", slug, "current", "dist", "index.html"), "public frontend");
    }
    const config = `{
      auto_https off
      admin off
      order request_header before forward_auth
    }
    (nanodeploy_strip) {
      request_header -Remote-Sub
    }
    (nanodeploy_gate) {
      forward_auth 127.0.0.1:4000 {
        uri /verify
      }
    }
    :4000 {
      respond "authentication required" 401
    }
    ` + renderSite(app("protected", [{ path: "/admin*", role: "moderator" }]) as any)
      + renderSite(app("public") as any);
    await writeFile(join(work, "Caddyfile"), config);
    await exec("docker", ["run", "--detach", "--rm", "--name", name, "--memory", "128m", "--publish", "127.0.0.1::80",
      "--volume", `${work}/Caddyfile:/etc/caddy/Caddyfile:ro`, "--volume", `${work}/apps:/srv/apps:ro`, image!]);
    started = true;
    const { stdout } = await exec("docker", ["port", name, "80/tcp"]);
    const port = stdout.trim().split(":").at(-1);
    const request = (path: string, slug = "protected"): Promise<Response> => new Promise((resolve, reject) => {
      get({ hostname: "127.0.0.1", port, path, headers: { Host: `${slug}.apps.audit.invalid` } }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.once("error", reject);
        res.once("end", () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode })));
      }).once("error", reject);
    });
    let ready = false;
    for (let i = 0; i < 50; i++) {
      try { const res = await request("/", "public"); if (res.status === 200 && await res.text() === "public frontend") { ready = true; break; } } catch {}
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(ready, true, "Caddy must serve the public control app");
    for (const path of ["/admin/x", "/ADMIN/x", "/%61dmin/x", "//admin/x", "/admin%2Fx"]) {
      const res = await request(path);
      assert.equal(res.status, 401, path);
      assert.equal(await res.text(), "authentication required", path);
    }
    assert.equal(await (await request("/", "public")).text(), "public frontend");
    assert.equal((await request("/api/test", "public")).status, 401);
  } finally {
    if (started) await exec("docker", ["rm", "--force", name]);
    await rm(work, { recursive: true, force: true });
  }
});

test("a backend starting after the first request receives its POST exactly once", { skip: !image, timeout: 30000 }, async () => {
  const work = await mkdtemp(join(tmpdir(), "nanodeploy-caddy-startup-"));
  const prefix = `nanodeploy-audit-startup-${process.pid}`;
  const network = `${prefix}-network`;
  const started: string[] = [];
  let networkCreated = false;
  process.env.APPS_DOMAIN = "apps.audit.invalid";
  const { renderSite } = await import("../src/caddy.ts");
  try {
    const frontend = join(work, "apps", "startup", "current", "dist");
    await mkdir(frontend, { recursive: true });
    await writeFile(join(frontend, "index.html"), "frontend ready");
    const config = `{
      auto_https off
      admin off
      order request_header before forward_auth
    }
    (nanodeploy_strip) {
      request_header -Remote-Sub
    }
    (nanodeploy_hide_session) {
      request_header -Cookie
    }
    (nanodeploy_gate) {
      forward_auth 127.0.0.1:4000 {
        uri /verify
      }
    }
    :4000 {
      respond 204
    }
    ` + renderSite({ ...app("startup"), port: 3000, warm: true } as any);
    await writeFile(join(work, "Caddyfile"), config);
    await exec("docker", ["network", "create", network]);
    networkCreated = true;
    const backend = `${prefix}-backend`;
    const server = `const http=require('node:http'); let count=0;
      const server=http.createServer(async(req,res)=>{
        const chunks=[]; for await(const chunk of req)chunks.push(chunk);
        res.end(JSON.stringify({method:req.method,body:Buffer.concat(chunks).toString(),count:++count}));
      });
      process.on('SIGUSR2',()=>server.listen(3000,'0.0.0.0'));
      setInterval(()=>{},1000); console.log('waiting');`;
    await exec("docker", ["run", "--detach", "--rm", "--name", backend, "--network", network, "--network-alias", "app-startup",
      "--read-only", "--user", "1000:1000", "--cap-drop", "ALL", "--memory", "96m", "node:24-bookworm-slim", "node", "-e", server]);
    started.push(backend);
    let waiting = false;
    for (let i = 0; i < 50; i++) {
      if ((await exec("docker", ["logs", backend])).stdout.includes("waiting")) { waiting = true; break; }
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(waiting, true, "backend must wait for its startup signal");
    const gateway = `${prefix}-gateway`;
    await exec("docker", ["run", "--detach", "--rm", "--name", gateway, "--network", network, "--memory", "128m",
      "--publish", "127.0.0.1::80", "--volume", `${work}/Caddyfile:/etc/caddy/Caddyfile:ro`, "--volume", `${work}/apps:/srv/apps:ro`, image!]);
    started.push(gateway);
    const port = (await exec("docker", ["port", gateway, "80/tcp"])).stdout.trim().split(":").at(-1);
    const request = (path: string, method = "GET", body?: string): Promise<{ status: number; body: string }> => new Promise((resolve, reject) => {
      const req = httpRequest({ hostname: "127.0.0.1", port, path, method, headers: { Host: "startup.apps.audit.invalid" } }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.once("error", reject);
        res.once("end", () => resolve({ status: res.statusCode!, body: Buffer.concat(chunks).toString() }));
      });
      req.once("error", reject);
      req.setTimeout(10000, () => req.destroy(new Error("fixture request timed out")));
      req.end(body);
    });
    let ready = false;
    for (let i = 0; i < 50; i++) {
      try { const res = await request("/"); if (res.status === 200 && res.body === "frontend ready") { ready = true; break; } } catch {}
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(ready, true, "Caddy must serve the frontend before the backend starts");
    let completed = false;
    const pending = request("/api/startup", "POST", "first request").then((result) => { completed = true; return result; });
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(completed, false, "Caddy must wait while the backend port is still closed");
    await exec("docker", ["kill", "--signal", "USR2", backend]);
    const result = await pending;
    assert.equal(result.status, 200);
    assert.deepEqual(JSON.parse(result.body), { method: "POST", body: "first request", count: 1 });
  } finally {
    for (const container of started.reverse()) await exec("docker", ["rm", "--force", container]).catch(() => {});
    if (networkCreated) await exec("docker", ["network", "rm", network]).catch(() => {});
    await rm(work, { recursive: true, force: true });
  }
});
