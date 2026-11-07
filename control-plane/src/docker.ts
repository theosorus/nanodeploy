import Docker from "dockerode";
import tar from "tar-fs";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile, copyFile } from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, posix } from "node:path";
import { PassThrough, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { finished } from "node:stream/promises";
import { randomBytes } from "node:crypto";
import { extractTar } from "./artifacts.js";
import { isAppSlug } from "./manifest.js";

const docker = new Docker();
const MEM_MB = Number(process.env.DEFAULT_APP_MEMORY_MB ?? 256);
// app containers only share a network with caddy and postgres. The platform
// services (socket-proxy, sablier, tinyauth, control plane) live on
// nanodeploy_edge and must stay unreachable from an app: an app is arbitrary
// code, and socket-proxy:2375 is a root escape by design.
export const APPS_NETWORK = "nanodeploy_apps"; // legacy shared network, never used for new containers
const NETWORK_PREFIX = process.env.APP_NETWORK_PREFIX ?? "nanodeploy_app_";
const SECURITY_REVISION = "2026-11-isolation-egress-v1";
const EGRESS_CONTAINER = process.env.EGRESS_CONTAINER ?? "nanodeploy-egress-1";
const EGRESS_ENV = {
  HTTP_PROXY: "http://egress:3128", HTTPS_PROXY: "http://egress:3128",
  http_proxy: "http://egress:3128", https_proxy: "http://egress:3128",
  NO_PROXY: "localhost,127.0.0.1,::1,postgres,caddy", no_proxy: "localhost,127.0.0.1,::1,postgres,caddy",
  NODE_USE_ENV_PROXY: "1",
};
export const appNetwork = (slug: string) => `${NETWORK_PREFIX}${slug}`;
export const dataVolume = (slug: string) => `nanodeploy_data_${slug}`;

export const containerName = (slug: string) => `app-${slug}`;

// a trivial Dockerfile: the bundle is already built on the dev machine
const DOCKERFILE = (entry: string, port: number) => `FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY ${JSON.stringify([entry, `./${entry}`])}
# the app runs unprivileged and writes files only to /data. A named volume is
# created root-owned on first mount: pre-create the directory in the image so
# docker copies its ownership over to a fresh volume.
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE ${port}
CMD ${JSON.stringify(["node", entry])}
`;

// one tag per release (nanodeploy/<slug>:r<number>): rolling back to a release
// whose image is still there is a container swap, not a build
export const imageTag = (slug: string, release: number) => `nanodeploy/${slug}:r${release}`;

export async function buildImage(dir: string, tag: string, entry: string, port: number) {
  const work = await mkdtemp(join(tmpdir(), "nd-image-"));
  try {
    await mkdir(dirname(join(work, entry)), { recursive: true });
    await copyFile(join(dir, entry), join(work, entry));
    await writeFile(join(work, "Dockerfile"), DOCKERFILE(entry, port));
    const context = tar.pack(work, { entries: [entry, "Dockerfile"] });
    const stream = await docker.buildImage(context as any, { t: tag });
    await new Promise<void>((resolve, reject) => {
      docker.modem.followProgress(stream, (err, res: any[]) => {
        if (err) return reject(err);
        const failed = res.find((r) => r.error);
        failed ? reject(new Error(failed.error)) : resolve();
      });
    });
    return tag;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

// Every app gets its own bridge. Otherwise a compromised app can bypass Caddy
// and send forged Remote-* headers directly to any neighbouring backend.
export async function ensureAppNetwork(slug: string) {
  if (!isAppSlug(slug)) throw new Error("invalid app network slug");
  const name = appNetwork(slug);
  let network = await docker.getNetwork(name).inspect().catch((err) => {
    if (err.statusCode === 404) return null;
    throw err;
  });
  if (!network) {
    await docker.createNetwork({ Name: name, Driver: "bridge", Internal: true,
      Options: { "com.docker.network.bridge.inhibit_ipv4": "true" }, Labels: { "nanodeploy.app": slug } });
    network = await docker.getNetwork(name).inspect();
  }
  if (network.Labels?.["nanodeploy.app"] !== slug) throw new Error(`network ${name} is not owned by this app`);
  if (!network.Internal || network.Options?.["com.docker.network.bridge.inhibit_ipv4"] !== "true") throw new Error(`network ${name} is not isolated`);
  for (const [container, alias] of [[CADDY_CONTAINER, "caddy"], [PG_CONTAINER, "postgres"], [EGRESS_CONTAINER, "egress"]]) {
    const info = await docker.getContainer(container).inspect();
    if (!info.NetworkSettings.Networks[name]) {
      await docker.getNetwork(name).connect({ Container: container, EndpointConfig: { Aliases: [alias] } });
    }
  }
  return name;
}

export async function removeAppNetwork(slug: string) {
  const network = docker.getNetwork(appNetwork(slug));
  const info = await network.inspect().catch((err) => { if (err.statusCode === 404) return null; throw err; });
  if (!info) return;
  if (info.Labels?.["nanodeploy.app"] !== slug) throw new Error("refusing to remove an unrelated network");
  for (const container of [CADDY_CONTAINER, PG_CONTAINER, EGRESS_CONTAINER]) {
    if (Object.values(info.Containers ?? {}).some((c: any) => c.Name === container)) {
      await network.disconnect({ Container: container, Force: true });
    }
  }
  await network.remove();
}

export async function containerMatchesConfig(slug: string, warm: boolean) {
  try {
    const info = await docker.getContainer(containerName(slug)).inspect();
    return info.Config.Labels?.["nanodeploy.security"] === SECURITY_REVISION &&
      Object.keys(info.NetworkSettings.Networks).length === 1 &&
      Boolean(info.NetworkSettings.Networks[appNetwork(slug)]) &&
      info.Config.Labels?.["sablier.enable"] === (warm ? "false" : "true") &&
      info.Config.Labels?.["sablier.group"] === slug &&
      info.HostConfig.RestartPolicy?.Name === (warm ? "unless-stopped" : "no");
  } catch {
    return false;
  }
}

export async function imageExists(image: string) {
  try {
    await docker.getImage(image).inspect();
    return true;
  } catch {
    return false;
  }
}

export async function removeContainer(slug: string) {
  try {
    await docker.getContainer(containerName(slug)).remove({ force: true });
  } catch {
    // not there, nothing to do
  }
}

export async function removeDataVolume(slug: string) {
  try {
    await docker.getVolume(dataVolume(slug)).remove();
  } catch {
    // already gone
  }
}

export async function stopContainer(slug: string) {
  // 2s grace: a node app dies on SIGTERM anyway, and a long grace would stall
  // deploys whenever an app handles SIGTERM and takes its time
  await docker.getContainer(containerName(slug)).stop({ t: 2 }).catch(() => {});
}

export async function runContainer(opts: {
  slug: string;
  image: string;
  port: number;
  idleTimeout: string;
  warm?: boolean;
  env: Record<string, string>;
}) {
  const network = await ensureAppNetwork(opts.slug);
  await removeContainer(opts.slug);
  const container = await docker.createContainer({
    name: containerName(opts.slug),
    Image: opts.image,
    User: "1000:1000",
    Labels: {
      // a warm app is never managed by sablier, docker keeps it alive instead
      "sablier.enable": opts.warm ? "false" : "true",
      "sablier.group": opts.slug,
      "nanodeploy.slug": opts.slug,
      "nanodeploy.security": SECURITY_REVISION,
    },
    Env: Object.entries({ ...opts.env, ...EGRESS_ENV, PORT: String(opts.port) }).map(
      ([k, v]) => `${k}=${v}`,
    ),
    HostConfig: {
      // a sleeping container was stopped on purpose by sablier, so docker must
      // not resurrect it at boot. A warm one is the opposite case.
      RestartPolicy: { Name: opts.warm ? "unless-stopped" : "no" },
      Memory: MEM_MB * 1024 * 1024,
      MemorySwap: MEM_MB * 1024 * 1024,
      NanoCpus: 1e9,
      PidsLimit: 128,
      // hardening: an app runs arbitrary code, keep it unprivileged
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges:true"],
      // the image holds the whole app and nothing writes to it at runtime: the
      // only writable paths are the /data volume and a small noexec /tmp
      ReadonlyRootfs: true,
      Tmpfs: { "/tmp": "rw,noexec,nosuid,nodev,size=16m" },
      LogConfig: { Type: "local", Config: { "max-size": "5m", "max-file": "2" } },
      Binds: [`${dataVolume(opts.slug)}:/data`],
      // apps join only nanodeploy_apps, which carries caddy and postgres. They
      // used to also join nanodeploy_data to reach postgres, but the control
      // plane lives on that network too: an app could open a tcp connection to
      // control-plane:8000 and, by sending its own Remote-* headers (caddy is
      // the only thing that strips them, and it was bypassed), drive the whole
      // platform as an admin. Postgres is now reachable through nanodeploy_apps
      // instead, so an app and the control plane share no network at all.
      NetworkMode: network,
      Sysctls: { "net.ipv6.conf.all.disable_ipv6": "1" },
      // no PortBindings: the app must only be reachable through caddy
    },
  });
  await container.start();
  return container.id;
}

export async function appStatus(slug: string) {
  try {
    const info = await docker.getContainer(containerName(slug)).inspect();
    return info.State.Running ? "awake" : "sleeping";
  } catch {
    return "missing";
  }
}

export async function startContainer(slug: string) {
  // no catch here on purpose: the caller needs to know why a wake failed
  // (e.g. image deleted by hand, sablier cannot start this container)
  await docker.getContainer(containerName(slug)).start();
}

// Without a TTY, docker frames every chunk with an 8 byte header: 1 byte for
// the stream, 3 zero bytes, then a big endian payload length. Stripping control
// characters instead of demultiplexing leaves the printable bytes of those
// headers glued to the log lines ("A" is a perfectly valid length byte).
function demux(buf: Buffer): string {
  if (buf.length < 8 || buf[0] > 2 || buf[1] !== 0 || buf[2] !== 0 || buf[3] !== 0) {
    return buf.toString("utf8"); // tty mode: the stream is already plain text
  }
  const parts: string[] = [];
  let at = 0;
  while (at + 8 <= buf.length) {
    const size = buf.readUInt32BE(at + 4);
    parts.push(buf.subarray(at + 8, at + 8 + size).toString("utf8"));
    at += 8 + size;
  }
  return parts.join("");
}

// A backpressure-aware decoder for binary exec stdout. docker-modem's
// demuxStream ignores writable backpressure, which can buffer an entire dump
// or artifact export in memory when the destination is slower than Docker.
function binaryStdout(stderr: (text: string) => void) {
  let pending: Buffer = Buffer.alloc(0);
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      while (pending.length >= 8) {
        const size = pending.readUInt32BE(4);
        if (size > 16 * 1024 * 1024 || pending[0] > 2) { callback(new Error("invalid Docker stream frame")); return; }
        if (pending.length < 8 + size) break;
        const body = pending.subarray(8, 8 + size);
        if (pending[0] === 1) this.push(body);
        else if (pending[0] === 2) stderr(body.toString("utf8"));
        pending = pending.subarray(8 + size);
      }
      callback();
    },
    flush(callback) { callback(pending.length ? new Error("truncated Docker stream") : null); },
  });
}

// CSI and OSC colour sequences survive a plain control-character filter as
// visible noise ("[32m"), so drop the whole escape sequence first.
const ANSI_RE = /\u001b\[[0-9;?]*[ -\/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;

export async function tailLogs(slug: string, tail = 200) {
  try {
    const buf = await docker
      .getContainer(containerName(slug))
      .logs({ stdout: true, stderr: true, tail });
    return demux(Buffer.from(buf as any))
      .replace(ANSI_RE, "")
      .replace(/[\u0000-\u0008\u000b-\u001f]/g, "")
      .split("\n")
      .filter(Boolean);
  } catch {
    // never started, or removed by hand: no logs is a state, not an error.
    // The dashboard words it, the API stays language neutral.
    return [];
  }
}

// Live memory of one running app, the number that answers "which app is heavy".
// Docker normally samples twice to be able to compute CPU, so ask for one shot:
// without it every poll blocks for a second per container. Never let a slow or
// hung stats call hold up the app list.
export async function appMemory(slug: string): Promise<number | null> {
  try {
    // the typings only know the callback overload for a non-empty options object
    const call = docker
      .getContainer(containerName(slug))
      .stats({ stream: false, "one-shot": true } as any) as unknown as Promise<any>;
    const raw: any = await withTimeout(call, 3000);
    const text = typeof raw?.on === "function" ? await readStream(raw) : raw;
    const s = typeof text === "string" || Buffer.isBuffer(text) ? JSON.parse(String(text)) : text;
    const usage = s?.memory_stats?.usage;
    if (!usage) return null;
    // usage counts the page cache, which is the machine's, not the app's
    const st = s.memory_stats.stats ?? {};
    const cache = st.inactive_file ?? st.total_inactive_file ?? st.cache ?? 0;
    return Math.max(0, usage - cache);
  } catch {
    return null;
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    p,
    new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error("timeout")), ms); }),
  ]).finally(() => clearTimeout(timer));
}

function readStream(stream: any): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (c: Buffer) => chunks.push(c));
    stream.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    stream.once("error", reject);
  });
}

// The control plane runs with no memory limit of its own, so /proc/meminfo
// inside it is the host's. That is the only honest number to show: the docker
// API reports total memory but never what is actually in use.
export async function hostMemory() {
  const containers = await docker.listContainers().catch(() => []);
  let total = 0;
  let available = 0;
  try {
    const meminfo = await readFile("/proc/meminfo", "utf8");
    const kb = (key: string) =>
      Number(new RegExp(`^${key}:\\s+(\\d+) kB`, "m").exec(meminfo)?.[1] ?? 0) * 1024;
    total = kb("MemTotal");
    available = kb("MemAvailable");
  } catch {
    // not linux (a developer running the control plane on macOS)
    const info: any = await docker.info().catch(() => ({}));
    total = Number(info.MemTotal ?? 0);
  }
  return {
    total,
    available,
    used: total && available ? total - available : 0,
    running: containers.length,
  };
}

// Deploys tag images nanodeploy/<slug>:r<release>. The caller passes the tags
// worth keeping (the live one and the few most recent releases, for an instant
// rollback); every other nanodeploy image goes. Removing an image a container
// still uses fails, which just means we keep one extra image.
export async function pruneImages(keep: Set<string>) {
  const list = await docker.listImages();
  for (const img of list) {
    for (const tag of img.RepoTags ?? []) {
      if (!tag.startsWith("nanodeploy/") || keep.has(tag)) continue;
      try {
        await docker.getImage(tag).remove();
      } catch {
        // in use or already gone
      }
    }
  }
}

// caddy reads its config from a file, so reload it in place after a route
// change. A failed reload silently keeps the previous config: surface it, or a
// bad site file would disable every new app with no trace anywhere.
// compose names it <project>-caddy-1 and the project name is pinned in
// docker-compose.yml, but a fork that renames the project needs a way out
const CADDY_CONTAINER = process.env.CADDY_CONTAINER ?? "nanodeploy-caddy-1";

export async function reloadCaddy() {
  const caddy = docker.getContainer(CADDY_CONTAINER);
  const exec = await caddy.exec({
    Cmd: ["caddy", "reload", "--config", "/etc/caddy/Caddyfile"],
    AttachStdout: true,
    AttachStderr: true,
  });
  const stream = await exec.start({ hijack: true, stdin: false });
  const chunks: string[] = [];
  (stream as any).on("data", (c: Buffer) => chunks.push(c.toString("utf8")));
  await new Promise<void>((resolve, reject) => {
    (stream as any).once("close", resolve);
    (stream as any).once("end", resolve);
    (stream as any).once("error", reject);
  }).finally(() => stream.destroy());
  const result = await exec.inspect();
  if (result.ExitCode !== 0) {
    console.error(`caddy reload failed:\n${chunks.join("").slice(-1000)}`);
  }
  return result.ExitCode === 0;
}

/* ---------- database snapshots, run inside the postgres container ---------- */

// pg_dump and pg_restore come from the postgres image itself, so their version
// always matches the server. The control plane reaches them through its socket
// proxy (exec), the same way it reloads caddy.
const PG_CONTAINER = process.env.POSTGRES_CONTAINER ?? "nanodeploy-postgres-1";

async function execIn(container: string, cmd: string[], stdout?: NodeJS.WritableStream, env?: string[]) {
  const exec = await docker.getContainer(container).exec({ Cmd: cmd, Env: env, AttachStdout: true, AttachStderr: true });
  const stream = await exec.start({ hijack: true, stdin: false });
  let errors = "";
  const out = stdout ?? new PassThrough().resume();
  try {
    await pipeline(stream, binaryStdout((text) => { errors = (errors + text).slice(-8192); }), out, { end: false });
  } finally {
    stream.destroy();
  }
  const { ExitCode } = await exec.inspect();
  if (ExitCode !== 0) {
    throw new Error(`${cmd[0]} failed: ${errors.trim().slice(-500)}`);
  }
}

// custom format: compressed, and pg_restore can clean and recreate from it
export async function dumpDatabase(db: string, file: string, password: string) {
  if (!/^app_[a-z0-9_]+$/.test(db)) throw new Error("invalid app database");
  const out = createWriteStream(file, { mode: 0o600 });
  const written = finished(out);
  try {
    await Promise.race([
      new Promise<void>((resolve) => out.once("open", () => resolve())),
      written,
    ]);
    // Do not start Docker until the destination opened successfully. Otherwise
    // an early file error leaves an exec streaming into a destroyed writable.
    await execIn(PG_CONTAINER, ["pg_dump", "-h", "127.0.0.1", "-U", db, "--lock-wait-timeout=10s", "-Fc", "-d", db], out, [`PGPASSWORD=${password}`]);
    out.end();
    await written;
  } catch (err) {
    out.destroy();
    await written.catch(() => {});
    await rm(file, { force: true }).catch(() => {});
    throw err;
  }
}

// The dump is copied into the container as a file rather than streamed to
// pg_restore's stdin: half-closing a hijacked stream through the socket proxy is
// not something to rely on when a database is at stake.
export async function restoreDatabase(db: string, file: string, password: string) {
  if (!/^app_[a-z0-9_]+$/.test(db)) throw new Error("invalid app database");
  const tmp = await mkdtemp(join(tmpdir(), "nd-restore-"));
  const name = `nd-restore-${basename(file)}`;
  const suffix = randomBytes(8).toString("hex");
  const replacement = `nd_restore_${suffix}`;
  const backup = `nd_before_restore_${suffix}`;
  let created = false;
  let swapped = false;
  try {
    await copyFile(file, join(tmp, name));
    await docker.getContainer(PG_CONTAINER).putArchive(tar.pack(tmp, { entries: [name] }) as any, { path: "/tmp" });
    // --clean only drops objects named in the dump: it leaves tables created
    // by the failed migration behind. Restore into an empty database first,
    // keeping the original intact until the whole restore has succeeded.
    await execIn(PG_CONTAINER, ["createdb", "-U", "postgres", "--owner", db, replacement]);
    created = true;
    await execIn(PG_CONTAINER, ["psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-c",
      `revoke connect on database "${replacement}" from public`]);
    // Dump SQL runs as the app, including any app-controlled functions or
    // expression indexes. The privileged commands below only rename databases.
    await execIn(PG_CONTAINER, [
      "pg_restore", "-h", "127.0.0.1", "-U", db, "--no-owner", "--no-privileges",
      "--single-transaction", "-d", replacement, `/tmp/${name}`,
    ], undefined, [`PGPASSWORD=${password}`]);
    await execIn(PG_CONTAINER, ["psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-c", `
      begin;
      select pg_terminate_backend(pid) from pg_stat_activity
        where datname in ('${db}', '${replacement}') and pid <> pg_backend_pid();
      alter database "${db}" rename to "${backup}";
      alter database "${replacement}" rename to "${db}";
      commit;`]);
    swapped = true;
  } finally {
    if (created) {
      const obsolete = swapped ? backup : replacement;
      await execIn(PG_CONTAINER, ["dropdb", "-U", "postgres", "--if-exists", "--force", obsolete])
        .catch((err) => console.error("restore database cleanup failed", err));
    }
    await execIn(PG_CONTAINER, ["rm", "-f", `/tmp/${name}`]).catch(() => {});
    await rm(tmp, { recursive: true, force: true });
  }
}

/* ---------- container events, for analytics ---------- */

export type AppEvent = { slug: string; action: string; exitCode: number | null; at: number };

// Follows start, stop, kill, die and oom of app containers, and reconnects if
// the stream drops (a restart of the socket proxy, a docker upgrade).
export function followAppEvents(onEvent: (e: AppEvent) => void) {
  const connect = async () => {
    try {
      const stream: any = await docker.getEvents({
        filters: JSON.stringify({
          type: ["container"],
          label: ["nanodeploy.slug"],
          event: ["start", "stop", "kill", "die", "oom"],
        }) as any,
      });
      let buffer = "";
      stream.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf8");
        let nl: number;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line) continue;
          try {
            const e = JSON.parse(line);
            const attrs = e.Actor?.Attributes ?? {};
            const slug = attrs["nanodeploy.slug"];
            if (!slug) continue;
            const exit = attrs.exitCode === undefined ? null : Number(attrs.exitCode);
            onEvent({ slug, action: e.Action ?? e.status, exitCode: exit, at: Math.floor((e.timeNano ?? e.time * 1e9) / 1e6) });
          } catch {
            // a partial or foreign line: skip it
          }
        }
      });
      let retried = false;
      const retry = () => {
        if (retried) return;
        retried = true;
        setTimeout(connect, 5000);
      };
      stream.once("end", retry);
      stream.once("error", retry);
    } catch {
      setTimeout(connect, 5000);
    }
  };
  connect();
}

/* ---------- the build sandbox, for Git deploys ---------- */

// Builds run code from the repository (npm scripts of every dependency). They
// get their own network, with the internet for the package registry and
// nothing of the platform: not the apps, not postgres, not the socket proxies.
export const BUILD_NETWORK = process.env.BUILD_NETWORK ?? "nanodeploy_build_secure";
const BUILD_MEMORY_MB = Number(process.env.BUILD_MEMORY_MB ?? 1536);

export async function removeOrphanBuilders() {
  const list = await docker.listContainers({ all: true, filters: JSON.stringify({ label: ["nanodeploy.build=1"] }) });
  for (const container of list) {
    if (container.Labels?.["nanodeploy.owner"] === CADDY_CONTAINER ||
        container.Names.some((name) => /^\/nanodeploy-build-\d+$/.test(name))) {
      await docker.getContainer(container.Id).remove({ force: true, v: true });
    }
  }
}

export async function ensureImage(image: string, log: (line: string) => void) {
  try {
    await docker.getImage(image).inspect();
    return;
  } catch {
    log(`pulling ${image}`);
  }
  const stream = await docker.pull(image);
  await new Promise<void>((resolve, reject) =>
    docker.modem.followProgress(stream, (err: any) => (err ? reject(err) : resolve())),
  );
}

export async function runBuilder(opts: {
  name: string;
  image: string;
  source: string;
  workdir: string;
  command: string;
  timeoutMs: number;
  outputs: { path: string; destination: string; optional?: boolean }[];
}): Promise<{ exitCode: number | null; logs: string; timedOut: boolean }> {
  const c = await docker.createContainer({
    name: opts.name,
    Image: opts.image,
    // Keep the sandbox alive while collecting results: tmpfs disappears when
    // a container stops. Run the build through exec, then destroy everything.
    Entrypoint: [],
    Cmd: ["sh", "-c", "while :; do sleep 3600; done"],
    WorkingDir: "/work",
    User: "1000:1000",
    // no credential of any kind: the archive was downloaded before this ran
    Env: ["HOME=/tmp", "npm_config_cache=/cache", "npm_config_update_notifier=false", "CI=true",
      ...Object.entries(EGRESS_ENV).map(([key, value]) => `${key}=${value}`)],
    Labels: { "nanodeploy.build": "1", "nanodeploy.owner": CADDY_CONTAINER },
    HostConfig: {
      // No host directory or shared writable cache. An untrusted build cannot
      // fill the server disk, poison another build, or plant host symlinks.
      ReadonlyRootfs: true,
      Tmpfs: {
        "/work": "rw,nosuid,nodev,size=1g,uid=1000,gid=1000",
        "/tmp": "rw,nosuid,nodev,size=64m,uid=1000,gid=1000",
        "/cache": "rw,nosuid,nodev,size=128m,uid=1000,gid=1000",
      },
      Memory: BUILD_MEMORY_MB * 1024 * 1024,
      MemorySwap: BUILD_MEMORY_MB * 1024 * 1024,
      NanoCpus: 1e9,
      PidsLimit: 512,
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges:true"],
      NetworkMode: BUILD_NETWORK,
      Sysctls: { "net.ipv6.conf.all.disable_ipv6": "1" },
      LogConfig: { Type: "local", Config: { "max-size": "1m", "max-file": "2" } },
    },
  });
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inputDir: string | undefined;
  try {
    await c.start();
    timer = setTimeout(() => {
      timedOut = true;
      c.kill().catch(() => {});
    }, opts.timeoutMs);
    // Docker refuses putArchive on a read-only rootfs, even for a tmpfs path.
    // Extract as the sandbox user through exec instead. A length-bounded pipe
    // avoids depending on half-close/EOF propagation through socket proxies.
    inputDir = await mkdtemp(join(tmpdir(), "nd-builder-input-"));
    const inputFile = join(inputDir, "source.tar");
    await pipeline(tar.pack(opts.source), createWriteStream(inputFile, { mode: 0o600 }));
    const length = (await stat(inputFile)).size;
    const unpack = await c.exec({ Cmd: ["sh", "-c", `head -c ${length} | tar -x --no-same-owner -C /work`],
      User: "1000:1000", AttachStdin: true, AttachStdout: true, AttachStderr: true });
    const unpackStream = await unpack.start({ hijack: true, stdin: true });
    const input = createReadStream(inputFile);
    let unpackLog = "";
    const unpackOut = new PassThrough();
    unpackOut.on("data", (chunk: Buffer) => { unpackLog = (unpackLog + chunk.toString()).slice(-8192); });
    docker.modem.demuxStream(unpackStream, unpackOut, unpackOut);
    const unpacked = new Promise<void>((resolve, reject) => {
      unpackStream.once("end", resolve); unpackStream.once("close", resolve); unpackStream.once("error", reject);
    });
    input.on("error", (err) => unpackStream.destroy(err));
    input.pipe(unpackStream, { end: false });
    try { await unpacked; } finally { input.destroy(); unpackStream.destroy(); }
    if ((await unpack.inspect()).ExitCode !== 0) throw new Error(`sandbox source transfer failed: ${unpackLog}`);
    await rm(inputDir, { recursive: true, force: true });
    inputDir = undefined;
    const exec = await c.exec({
      Cmd: ["sh", "-c", opts.command], WorkingDir: opts.workdir,
      User: "1000:1000", AttachStdout: true, AttachStderr: true,
    });
    const stream = await exec.start({ hijack: true, stdin: false });
    let logs = "";
    const out = new PassThrough();
    out.on("data", (chunk: Buffer) => { logs = (logs + chunk.toString("utf8")).slice(-200_000); });
    docker.modem.demuxStream(stream, out, out);
    try {
      await new Promise<void>((resolve, reject) => {
        stream.once("end", resolve);
        stream.once("close", resolve);
        stream.once("error", reject);
      });
    } finally { stream.destroy(); }
    const result = await exec.inspect();
    if (!timedOut && result.ExitCode === 0) {
      const budget = { bytes: 0, entries: 0 };
      for (const output of opts.outputs) {
        const path = posix.normalize(output.path);
        if (output.optional) {
          const check = await c.exec({ Cmd: ["sh", "-c", 'test -e "$1" || test -L "$1"', "nd-artifact", posix.join(opts.workdir, path)],
            AttachStdout: true, AttachStderr: true });
          const checked = await check.start({ hijack: true, stdin: false });
          try {
            await new Promise<void>((resolve, reject) => {
              checked.once("end", resolve); checked.once("close", resolve); checked.once("error", reject);
              checked.resume();
            });
          } finally { checked.destroy(); }
          const state = await check.inspect();
          if (state.ExitCode === 1) continue;
          if (state.ExitCode !== 0) throw new Error("cannot check optional build artifacts");
        }
        // Docker's archive endpoint does not see a container's tmpfs mounts.
        // Export from inside the live sandbox as its unprivileged user instead.
        const exportExec = await c.exec({ Cmd: ["tar", "-c", "-C", opts.workdir, "--", path],
          User: "1000:1000", AttachStdout: true, AttachStderr: true });
        const raw = await exportExec.start({ hijack: true, stdin: false });
        let errors = "";
        const archive = binaryStdout((text) => { errors = (errors + text).slice(-8192); });
        raw.on("error", (err) => archive.destroy(err));
        archive.on("error", () => raw.destroy());
        raw.pipe(archive);
        await mkdir(output.destination, { recursive: true });
        try { await extractTar(archive, output.destination, { budget }); }
        finally { raw.destroy(); }
        if ((await exportExec.inspect()).ExitCode !== 0) throw new Error(`artifact export failed: ${errors}`);
      }
    }
    return { exitCode: result.ExitCode, logs: logs.replace(ANSI_RE, ""), timedOut };
  } finally {
    clearTimeout(timer);
    await c.remove({ force: true, v: true }).catch(() => {});
    if (inputDir) await rm(inputDir, { recursive: true, force: true });
  }
}
