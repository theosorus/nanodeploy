import Docker from "dockerode";
import tar from "tar-fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const docker = new Docker();
const MEM_MB = Number(process.env.DEFAULT_APP_MEMORY_MB ?? 256);
// app containers only share a network with caddy and postgres. The platform
// services (socket-proxy, sablier, tinyauth, control plane) live on
// nanoploy_edge and must stay unreachable from an app: an app is arbitrary
// code, and socket-proxy:2375 is a root escape by design.
export const APPS_NETWORK = "nanoploy_apps";
export const DATA_NETWORK = "nanoploy_data";
export const dataVolume = (slug: string) => `nanoploy_data_${slug}`;

export const containerName = (slug: string) => `app-${slug}`;

// a trivial Dockerfile: the bundle is already built on the dev machine
const DOCKERFILE = (entry: string, port: number) => `FROM node:20-slim
WORKDIR /app
ENV NODE_ENV=production
COPY ${entry} ./${entry}
# the app runs unprivileged and writes files only to /data. A named volume is
# created root-owned on first mount: pre-create the directory in the image so
# docker copies its ownership over to a fresh volume.
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE ${port}
CMD ["node", "${entry}"]
`;

export async function buildImage(dir: string, slug: string, entry: string, port: number) {
  await writeFile(join(dir, "Dockerfile"), DOCKERFILE(entry, port));
  const tag = `nanoploy/${slug}:${Date.now()}`;
  const context = tar.pack(dir, { entries: [entry, "Dockerfile"] });
  const stream = await docker.buildImage(context as any, { t: tag });
  await new Promise<void>((resolve, reject) => {
    docker.modem.followProgress(stream, (err, res: any[]) => {
      if (err) return reject(err);
      const failed = res.find((r) => r.error);
      failed ? reject(new Error(failed.error)) : resolve();
    });
  });
  return tag;
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
  await removeContainer(opts.slug);
  const container = await docker.createContainer({
    name: containerName(opts.slug),
    Image: opts.image,
    Labels: {
      // a warm app is never managed by sablier, docker keeps it alive instead
      "sablier.enable": opts.warm ? "false" : "true",
      "sablier.group": opts.slug,
      "nanoploy.slug": opts.slug,
    },
    Env: Object.entries({ ...opts.env, PORT: String(opts.port) }).map(
      ([k, v]) => `${k}=${v}`,
    ),
    HostConfig: {
      // a sleeping container was stopped on purpose by sablier, so docker must
      // not resurrect it at boot. A warm one is the opposite case.
      RestartPolicy: { Name: opts.warm ? "unless-stopped" : "no" },
      Memory: MEM_MB * 1024 * 1024,
      PidsLimit: 128,
      // hardening: an app runs arbitrary code, keep it unprivileged
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges:true"],
      // the image holds the whole app and nothing writes to it at runtime: the
      // only writable paths are the /data volume and a small noexec /tmp
      ReadonlyRootfs: true,
      Tmpfs: { "/tmp": "rw,noexec,nosuid,size=16m" },
      Binds: [`${dataVolume(opts.slug)}:/data`],
      NetworkMode: APPS_NETWORK,
      // no PortBindings: the app must only be reachable through caddy
    },
  });
  await docker.getNetwork(DATA_NETWORK).connect({ Container: container.id });
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
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error("timeout")), ms)),
  ]);
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

// Deploys tag images nanoploy/<slug>:<timestamp>, one per deploy. Old tags are
// unreachable once the container has been recreated from the new one, so drop
// every nanoploy image except those the database still references. Removing an
// image a container still uses fails, which just means we keep one extra image.
export async function pruneImages(keep: Set<string>) {
  const list = await docker.listImages();
  for (const img of list) {
    for (const tag of img.RepoTags ?? []) {
      if (!tag.startsWith("nanoploy/") || keep.has(tag)) continue;
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
const CADDY_CONTAINER = process.env.CADDY_CONTAINER ?? "nanoploy-caddy-1";

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
  await new Promise<void>((resolve) => {
    (stream as any).once("close", resolve);
    (stream as any).once("end", resolve);
  });
  const result = await exec.inspect();
  if (result.ExitCode !== 0) {
    console.error(`caddy reload failed:\n${chunks.join("").slice(-1000)}`);
  }
  return result.ExitCode === 0;
}
