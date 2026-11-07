// Disposable containers, networks and database only. Never uses .env, an
// existing platform database, or a live application's data.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import Docker from "dockerode";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const enabled = process.env.NANODEPLOY_SECURITY_DOCKER === "1";
const options = { skip: !enabled, timeout: 60_000 };
const exec = promisify(execFile);
const prefix = `nanodeploy-audit-cyber-${process.pid}`;
const password = "disposable-cyber-test-password";
const image = "node:24-bookworm-slim";
let engine: Docker, work: string, pg: Docker.Container, gateway: Docker.Container;
let dk: typeof import("../src/docker.ts"), store: typeof import("../src/db.ts");
const containers: Docker.Container[] = [];
const networks: Docker.Network[] = [];
const apps: string[] = [];
const buildNetwork = `${prefix}-build`;
let builtImage: string | undefined;

async function command(container: Docker.Container, cmd: string[], env: string[] = []) {
  const operation = await container.exec({ Cmd: cmd, Env: env, AttachStdout: true, AttachStderr: true });
  const stream = await operation.start({ hijack: true, stdin: false });
  let output = "";
  const sink = new PassThrough();
  sink.on("data", (chunk) => { output += chunk.toString(); });
  engine.modem.demuxStream(stream, sink, sink);
  await new Promise<void>((resolve, reject) => { stream.once("end", resolve); stream.once("close", resolve); stream.once("error", reject); })
    .finally(() => stream.destroy());
  const result = await operation.inspect();
  if (result.ExitCode !== 0) throw new Error(`fixture command failed: ${output}`);
  return output.trim();
}

before(async () => {
  if (!enabled) return;
  const context = await exec("docker", ["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"]);
  process.env.DOCKER_HOST = context.stdout.trim();
  process.env.BUILD_NETWORK = buildNetwork;
  process.env.CADDY_CONTAINER = `${prefix}-gateway`;
  process.env.POSTGRES_CONTAINER = `${prefix}-postgres`;
  process.env.EGRESS_CONTAINER = `${prefix}-egress`;
  process.env.APP_NETWORK_PREFIX = `${prefix}-app-`;
  process.env.APPS_DOMAIN = "apps.cyber.invalid";
  process.env.NANODEPLOY_SECRET_KEY = "22".repeat(32);
  process.env.GATE_DB_PASSWORD = "disposablegatepasswordforsecuritytests";
  engine = new Docker();
  work = await mkdtemp(join(tmpdir(), "nanodeploy-cyber-"));
  for (const name of [buildNetwork, `${prefix}-control`]) networks.push(await engine.createNetwork({ Name: name,
    ...(name === buildNetwork ? { Internal: true, Options: { "com.docker.network.bridge.inhibit_ipv4": "true" } } : {}) }));
  pg = await engine.createContainer({
    name: process.env.POSTGRES_CONTAINER, Image: "postgres:16-alpine",
    Env: [`POSTGRES_PASSWORD=${password}`, "POSTGRES_DB=nanodeploy_cyber_audit"],
    ExposedPorts: { "5432/tcp": {} },
    HostConfig: { NetworkMode: `${prefix}-control`, Memory: 256 * 1024 * 1024,
      PortBindings: { "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: "" }] } },
  });
  containers.push(pg); await pg.start();
  gateway = await engine.createContainer({
    name: process.env.CADDY_CONTAINER, Image: image, User: "1000:1000",
    Cmd: ["node", "-e", "require('http').createServer((q,s)=>s.end('gateway')).listen(3000,'0.0.0.0')"],
    HostConfig: { NetworkMode: `${prefix}-control`, ReadonlyRootfs: true, CapDrop: ["ALL"], Memory: 64 * 1024 * 1024 },
  });
  containers.push(gateway); await gateway.start();
  const egressDirectory = new URL("../../egress/", import.meta.url).pathname;
  const egress = await engine.createContainer({ name: process.env.EGRESS_CONTAINER, Image: image, User: "1000:1000",
    Cmd: ["node", "/opt/egress/proxy.mjs"],
    HostConfig: { NetworkMode: `${prefix}-control`, ReadonlyRootfs: true, CapDrop: ["ALL"], Memory: 128 * 1024 * 1024,
      Binds: [`${egressDirectory}:/opt/egress:ro`] },
  });
  containers.push(egress); await egress.start();
  await engine.getNetwork(buildNetwork).connect({ Container: process.env.EGRESS_CONTAINER, EndpointConfig: { Aliases: ["egress"] } });
  let ready = false;
  for (let n = 0; n < 100; n++) {
    try {
      await command(pg, ["psql", "-h", "127.0.0.1", "-U", "postgres", "-d", "nanodeploy_cyber_audit", "-Atc", "select 1"], [`PGPASSWORD=${password}`]);
      ready = true; break;
    }
    catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  assert.ok(ready, "disposable postgres did not start");
  const inspect = await pg.inspect();
  const port = inspect.NetworkSettings.Ports["5432/tcp"]![0].HostPort;
  process.env.POSTGRES_URL = `postgres://postgres:${password}@127.0.0.1:${port}/nanodeploy_cyber_audit`;
  store = await import("../src/db.ts");
  await store.initState(); await store.migrateState(); await store.initGate();
  dk = await import("../src/docker.ts");
}, { timeout: 60_000 });

after(async () => {
  if (!enabled || !engine) return;
  await store?.sql.end();
  for (const slug of apps) {
    await dk.removeContainer(slug);
    await dk.removeDataVolume(slug);
    await dk.removeAppNetwork(slug).catch(() => {});
  }
  for (const container of containers.reverse()) await container.remove({ force: true, v: true }).catch(() => {});
  for (const network of networks.reverse()) await network.remove().catch(() => {});
  if (builtImage) await engine.getImage(builtImage).remove().catch(() => {});
  if (work) await rm(work, { recursive: true, force: true });
});

let build = 0;
async function builder(commandText: string, outputs = true) {
  const root = join(work, `build-${++build}`);
  const source = join(root, "source");
  const destination = join(root, "result");
  await mkdir(source, { recursive: true });
  await writeFile(join(source, "input.txt"), "source");
  const result = await dk.runBuilder({ name: `${prefix}-build-${build}`, image, source, workdir: "/work",
    command: commandText, timeoutMs: 20_000,
    outputs: outputs ? [{ path: "dist", destination }, { path: "migrations", destination, optional: true }] : [] });
  return { result, destination };
}

test("Git builds run non-root on bounded tmpfs, without host mounts or server secrets", options, async () => {
  const { result, destination } = await builder(`node -e 'const fs=require("fs");
    if(process.getuid()!==1000)throw Error("root");
    if(process.env.NANODEPLOY_SECRET_KEY)throw Error("secret leaked");
    if(!/CapEff:\\s+0+\\n/.test(fs.readFileSync("/proc/self/status","utf8")))throw Error("capabilities");
    try{fs.writeFileSync("/etc/escape","bad");throw Error("writable root")}catch(e){if(e.code!=="EROFS")throw e}
    fs.writeFileSync("input.txt","editable");fs.mkdirSync("dist");fs.writeFileSync("dist/index.html","sandboxed");
    console.log("sandbox verified")'`);
  assert.equal(result.exitCode, 0, result.logs);
  assert.match(result.logs, /sandbox verified/);
  assert.equal(await readFile(join(destination, "dist/index.html"), "utf8"), "sandboxed");
});

test("a build cannot export symlinks or share a poisoned npm cache with the next build", options, async () => {
  await assert.rejects(builder("mkdir dist; ln -s /proc/self/environ dist/index.html"), /links/);
  assert.equal((await builder("touch /cache/poison", false)).result.exitCode, 0);
  assert.equal((await builder("test ! -e /cache/poison", false)).result.exitCode, 0);
});

test("isolated builds retain public HTTPS access through the filtered egress proxy", options, async () => {
  const { result } = await builder("node -e 'fetch(\"https://registry.npmjs.org/-/ping\").then(r=>{console.log(r.status);if(!r.ok)process.exit(1)}).catch(e=>{console.error(e.message);process.exit(1)})'", false);
  assert.equal(result.exitCode, 0, result.logs);
  assert.match(result.logs, /200/);
});

test("independent app bridges block direct backend access and preserve gateway/database access", options, async () => {
  const source = join(work, "app-source");
  await mkdir(source);
  await writeFile(join(source, "server.js"), "require('http').createServer((q,s)=>s.end('app')).listen(3000,'0.0.0.0')");
  builtImage = `${prefix}:app`;
  await dk.buildImage(source, builtImage, "server.js", 3000);
  assert.equal(await dk.imageExists(image), false, "an existing image without the current runtime baseline must be rebuilt");
  assert.equal(await dk.imageExists(builtImage), true);
  const slugs = [`cyber-${process.pid}-a`, `cyber-${process.pid}-b`];
  for (const slug of slugs) {
    apps.push(slug);
    await dk.runContainer({ slug, image: builtImage, port: 3000, idleTimeout: "10m", warm: true, env: {} });
  }
  const first = engine.getContainer(dk.containerName(slugs[0]));
  assert.equal(await dk.containerIsIsolated(slugs[0]), true);
  const second = await engine.getContainer(dk.containerName(slugs[1])).inspect();
  const target = second.NetworkSettings.Networks[dk.appNetwork(slugs[1])].IPAddress;
  const blocked = await command(first, ["node", "-e", `fetch('http://${target}:3000',{signal:AbortSignal.timeout(1000)}).then(()=>{console.log('REACHABLE')}).catch(()=>console.log('BLOCKED'))`]);
  assert.equal(blocked, "BLOCKED");
  assert.equal(await command(first, ["node", "-e", "fetch('http://caddy:3000').then(r=>r.text()).then(console.log)"]), "gateway");
  assert.equal(await command(first, ["node", "-e", "const s=require('net').connect(5432,'postgres',()=>{console.log('database');s.end()});s.on('error',()=>process.exit(1))"]), "database");
  assert.equal(await dk.containerMatchesConfig(slugs[0], true), true);
  assert.equal(await dk.containerMatchesConfig(slugs[0], false), false);
  assert.deepEqual(Object.keys((await first.inspect()).NetworkSettings.Networks), [dk.appNetwork(slugs[0])]);
  await dk.runContainer({ slug: slugs[1], image: builtImage, port: 3000, idleTimeout: "10m", warm: false, env: {} });
  await dk.stopContainer(slugs[1]);
  assert.equal(await dk.containerMatchesConfig(slugs[1], false), true);
  assert.equal(await dk.containerMatchesConfig(slugs[1], true), false);
  await engine.getContainer(dk.containerName(slugs[1])).update({ RestartPolicy: { Name: "unless-stopped" } });
  assert.equal(await dk.containerMatchesConfig(slugs[1], false), false, "reconcile must repair an interrupted availability change");
});

test("the Sablier ACL refuses create, exec, archive reads and delete without exposing a Docker socket", options, async () => {
  const config = new URL("../../docker-proxy/sablier.cfg", import.meta.url).pathname;
  const proxy = await engine.createContainer({ name: `${prefix}-acl`, Image: "tecnativa/docker-socket-proxy:0.3.0",
    Entrypoint: ["haproxy", "-W", "-db", "-f", "/etc/nanodeploy/sablier.cfg"], Cmd: [],
    ExposedPorts: { "2375/tcp": {} },
    HostConfig: { NetworkMode: `${prefix}-control`, ReadonlyRootfs: true, CapDrop: ["ALL"],
      Binds: [`${config}:/etc/nanodeploy/sablier.cfg:ro`],
      PortBindings: { "2375/tcp": [{ HostIp: "127.0.0.1", HostPort: "" }] } },
  });
  containers.push(proxy); await proxy.start();
  const port = (await proxy.inspect()).NetworkSettings.Ports["2375/tcp"]![0].HostPort;
  const base = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 50; attempt++) {
    try { await fetch(base + "/_ping"); break; }
    catch (err) { if (attempt === 49) throw err; await new Promise((r) => setTimeout(r, 50)); }
  }
  for (const [method, path] of [["POST", "/v1.47/containers/create"], ["POST", "/containers/app-demo/exec"],
    ["GET", "/containers/app-demo/archive?path=/"], ["DELETE", "/containers/app-demo"], ["POST", "/containers/app-demo/start/extra"]]) {
    assert.equal((await fetch(base + path, { method })).status, 403, `${method} ${path}`);
  }
  for (const path of ["/containers/nanodeploy-control-plane-1/json", `/containers/${"a".repeat(64)}/json`]) {
    assert.equal((await fetch(base + path)).status, 403, "platform credentials must not be inspectable");
  }
  assert.equal((await fetch(base + "/containers/json")).status, 503, "reads pass the ACL but there is deliberately no socket");
});

test("Sablier can wake and stop a managed app without inspecting platform containers", options, async (t) => {
  const slug = `cyber-${process.pid}-cold`;
  apps.push(slug);
  await dk.runContainer({ slug, image: builtImage!, port: 3000, idleTimeout: "10s", warm: false, env: {} });
  await dk.stopContainer(slug);
  // A real Sablier stops managed containers at startup. Restrict its view to
  // this fixture so the test can never touch an existing installation.
  const source = new URL("../../docker-proxy/sablier.cfg", import.meta.url);
  const config = join(work, "sablier-scoped.cfg");
  const policy = await readFile(source, "utf8");
  assert.equal(policy.split('"nanodeploy.slug"').length - 1, 2);
  await writeFile(config, policy.replaceAll('"nanodeploy.slug"', `"nanodeploy.slug=${slug}"`));
  const proxyName = `${prefix}-live-guard`;
  const proxy = await engine.createContainer({ name: proxyName, Image: "tecnativa/docker-socket-proxy:0.3.0",
    Entrypoint: ["haproxy", "-W", "-db", "-f", "/etc/nanodeploy/sablier.cfg"], Cmd: [],
    HostConfig: { NetworkMode: `${prefix}-control`, ReadonlyRootfs: true, CapDrop: ["ALL"],
      Binds: [`${config}:/etc/nanodeploy/sablier.cfg:ro`, "/var/run/docker.sock:/var/run/docker.sock:ro"] },
  });
  containers.push(proxy); await proxy.start();
  const sablier = await engine.createContainer({ name: `${prefix}-sablier`, Image: "sablierapp/sablier:1.17.0",
    Cmd: ["start", "--provider.name=docker", "--sessions.expiration-interval=500ms"],
    Env: [`DOCKER_HOST=tcp://${proxyName}:2375`], ExposedPorts: { "10000/tcp": {} },
    HostConfig: { NetworkMode: `${prefix}-control`, ReadonlyRootfs: true, CapDrop: ["ALL"],
      Tmpfs: { "/tmp": "rw,noexec,nosuid,nodev,size=16m" },
      PortBindings: { "10000/tcp": [{ HostIp: "127.0.0.1", HostPort: "" }] } },
  });
  containers.push(sablier); await sablier.start();
  const port = (await sablier.inspect()).NetworkSettings.Ports["10000/tcp"]![0].HostPort;
  let response: Response | undefined;
  for (let attempt = 0; attempt < 30; attempt++) {
    try { response = await fetch(`http://127.0.0.1:${port}/api/strategies/blocking?group=${slug}&session_duration=10s`, { signal: AbortSignal.any([t.signal, AbortSignal.timeout(10_000)]) }); break; }
    catch (err) { if (t.signal.aborted || attempt === 29) throw err; await new Promise((r) => setTimeout(r, 100)); }
  }
  assert.equal(response?.status, 200, await response?.text());
  assert.equal(await dk.appStatus(slug), "awake");
  for (let attempt = 0; attempt < 300 && await dk.appStatus(slug) !== "sleeping"; attempt++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(await dk.appStatus(slug), "sleeping");
});

test("application secrets are encrypted, migrated idempotently and bound to their app", options, async () => {
  const slug = `cipher-${process.pid}`;
  await store.sql`insert into apps (slug,name,env,db_password) values (${slug}, 'test', ${store.sql.json({ API_KEY: "fake-sensitive-value" })}, 'old-password')`;
  await store.migrateState();
  const [raw] = await store.sql`select env, db_password from apps where slug=${slug}`;
  assert.equal(typeof raw.env, "string");
  assert.doesNotMatch(JSON.stringify(raw), /fake-sensitive-value|old-password/);
  assert.equal((await store.getApp(slug)).env.API_KEY, "fake-sensitive-value");
  await store.upsertApp({ slug, name: "updated" });
  await store.migrateState();
  assert.equal((await store.getApp(slug)).db_password, "old-password");
  const { openAppSecrets } = await import("../src/app-secrets.ts");
  const decoded = await store.getApp(slug);
  assert.throws(() => openAppSecrets({ ...decoded, ...raw, slug: "different-app" }));
});

test("forged identity headers cannot replace a fresh administrator host session", options, async () => {
  const { verifyConsoleSession } = await import("../src/console-auth.ts");
  const user = `admin-${process.pid}`;
  const root = randomBytes(32).toString("base64url"), host = randomBytes(32).toString("base64url");
  const hash = (raw: string) => createHash("sha256").update(raw).digest();
  await store.sql`insert into gate.users(id,username,display_name,role) values(${user},${user},'Admin','admin')`;
  for (const [raw, hostname, parent] of [[root, "auth.apps.cyber.invalid", null], [host, "deploy.apps.cyber.invalid", hash(root)]] as const) {
    await store.sql`insert into gate.sessions(id_hash,user_id,host,parent,authenticated_at,expires_at)
      values(${hash(raw)},${user},${hostname},${parent},now(),now()+interval '1 hour')`;
  }
  assert.equal(await verifyConsoleSession(undefined, user), false);
  assert.equal(await verifyConsoleSession("forged", user), false);
  assert.equal(await verifyConsoleSession(host, "another-admin"), false);
  assert.equal(await verifyConsoleSession(host, user), true);
  await store.sql`update gate.sessions set authenticated_at=now()-interval '13 hours' where id_hash=${hash(host)}`;
  assert.equal(await verifyConsoleSession(host, user), false);
  await store.sql`update gate.sessions set authenticated_at=now() where id_hash=${hash(host)}`;
  await store.sql`delete from gate.sessions where id_hash=${hash(root)}`;
  assert.equal(await verifyConsoleSession(host, user), false);
});

test("a signed webhook cannot be replayed by changing or removing its unsigned delivery ID", options, async () => {
  await store.sql`create table git_providers(id bigserial primary key, kind text, name text, config jsonb, secret_enc text, webhook_secret_enc text)`;
  await store.sql`create table git_connections(id bigserial primary key, provider_id bigint, repo_id text)`;
  await store.sql`create table webhook_deliveries(id text primary key, received_at timestamptz default now())`;
  const builds = await import("../src/builds.ts");
  const secret = "disposable-webhook-secret";
  await builds.addGithub({ id: "123456", slug: "fixture", htmlUrl: "https://github.com/apps/fixture", pem: "not-used", webhookSecret: secret });
  const body = Buffer.from(JSON.stringify({ ref: "refs/heads/main", after: "a".repeat(40), repository: { id: 123 } }));
  const headers = new Headers({ "x-github-hook-installation-target-id": "123456", "x-github-event": "push",
    "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`, "x-github-delivery": "first" });
  assert.equal((await builds.webhook("github", null, headers, body)).status, 202);
  headers.set("x-github-delivery", "changed-by-attacker");
  assert.equal((await builds.webhook("github", null, headers, body)).message, "already received");
  headers.delete("x-github-delivery");
  assert.equal((await builds.webhook("github", null, headers, body)).message, "already received");
  assert.equal((await builds.webhook("github", null, headers, Buffer.from(body.toString().replace("main", "evil")))).status, 401);
});

test("restoring an app-controlled expression index never runs its SQL as postgres", options, async () => {
  const db = `app_cyber_${process.pid}`;
  await command(pg, ["psql", "-U", "postgres", "-c", `create role ${db} login password '${password}'`]);
  await command(pg, ["createdb", "-U", "postgres", "-O", db, db]);
  const sql = `create table evidence(i int); insert into evidence values(1);
    create function elevate_on_restore(i int) returns int immutable language plpgsql as $$
    begin if current_user = 'postgres' then execute 'alter role ${db} superuser'; end if; return i; end $$;
    create index malicious_index on evidence(elevate_on_restore(i));`;
  await command(pg, ["psql", "-h", "127.0.0.1", "-U", db, "-d", db, "-v", "ON_ERROR_STOP=1", "-c", sql], [`PGPASSWORD=${password}`]);
  const file = join(work, "controlled.dump");
  await dk.dumpDatabase(db, file, password);
  await dk.restoreDatabase(db, file, password);
  assert.equal(await command(pg, ["psql", "-U", "postgres", "-Atc", `select rolsuper from pg_roles where rolname='${db}'`]), "f");
});
