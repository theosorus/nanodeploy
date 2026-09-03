import Docker from "dockerode";
import tar from "tar-fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

const docker = new Docker();
const MEM_MB = Number(process.env.DEFAULT_APP_MEMORY_MB ?? 256);

export const containerName = (slug: string) => `app-${slug}`;

// a trivial Dockerfile: the bundle is already built on the dev machine
const DOCKERFILE = (entry: string, port: number) => `FROM node:20-slim
WORKDIR /app
ENV NODE_ENV=production
COPY ${entry} ./${entry}
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

export async function stopContainer(slug: string) {
  await docker.getContainer(containerName(slug)).stop().catch(() => {});
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
      NetworkMode: "nanoploy_edge",
      // no PortBindings: the app must only be reachable through caddy
    },
  });
  await docker.getNetwork("nanoploy_data").connect({ Container: container.id });
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

export async function tailLogs(slug: string, tail = 80) {
  try {
    const buf = await docker
      .getContainer(containerName(slug))
      .logs({ stdout: true, stderr: true, tail });
    // docker multiplexes streams with an 8 byte header per frame
    return Buffer.from(buf as any)
      .toString("utf8")
      .replace(/[\u0000-\u0008\u000b-\u001f]/g, "")
      .split("\n")
      .filter(Boolean);
  } catch {
    return ["aucun log, le conteneur n'a jamais démarré"];
  }
}

export async function hostMemory() {
  const info = await docker.info();
  const containers = await docker.listContainers();
  return { total: info.MemTotal as number, running: containers.length };
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
export async function reloadCaddy() {
  const caddy = docker.getContainer("nanoploy-caddy-1");
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
