import AdmZip from "adm-zip";
import { constants, createWriteStream } from "node:fs";
import { lstat, mkdir, open, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { Transform } from "node:stream";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { extract } from "tar-stream";
import type { Manifest } from "./manifest.js";
import { archivePath, MAX_BUNDLE_BYTES, MAX_BUNDLE_ENTRIES, MAX_BUNDLE_UNPACKED, MAX_FILE_BYTES } from "./bundle.js";

export type ArchiveBudget = { bytes: number; entries: number };

// Limit streamed tar data before extraction can fill the host's disk. Forge
// archives may contain links (skipped); build artifacts must be regular files.
export async function extractTar(stream: Readable, destination: string, options: {
  strip?: number; repository?: boolean; budget?: ArchiveBudget;
} = {}) {
  const budget = options.budget ?? { bytes: 0, entries: 0 };
  const maxEntries = options.repository ? 50_000 : MAX_BUNDLE_ENTRIES;
  let streamed = 0;
  const cap = new Transform({
    transform(chunk, _encoding, callback) {
      streamed += chunk.length;
      callback(streamed > MAX_BUNDLE_UNPACKED + maxEntries * 2048 ? new Error("archive too large when unpacked") : null, chunk);
    },
  });
  const extractor = extract();
  extractor.on("entry", (header, file, next) => {
    void (async () => {
      const name = archivePath(header.name);
      if (++budget.entries > maxEntries) throw new Error("too many archive entries");
      const size = header.size ?? 0;
      if (!Number.isSafeInteger(size) || size < 0 || size > MAX_FILE_BYTES) throw new Error("archive file too large");
      budget.bytes += size;
      if (budget.bytes > MAX_BUNDLE_UNPACKED) throw new Error("archive too large when unpacked");
      if (header.type !== "file" && header.type !== "directory") {
        if (!options.repository) throw new Error("build artifacts must not contain links or special files");
        file.resume(); next(); return;
      }
      const path = name.split("/").slice(options.strip ?? 0).join("/");
      if (!path) {
        if (header.type !== "directory") throw new Error("archive file has no path");
        file.resume(); next(); return;
      }
      const target = join(destination, path);
      if (header.type === "directory") {
        if (size) throw new Error("archive directory contains data");
        await mkdir(target, { recursive: true, mode: 0o755 });
        file.resume();
      } else {
        await mkdir(dirname(target), { recursive: true, mode: 0o755 });
        await pipeline(file, createWriteStream(target, { flags: "wx", mode: 0o644 }));
      }
      next();
    })().catch((err) => {
      // Reject via the stream, never throw out of an event handler.
      file.on("error", () => {});
      file.resume();
      extractor.destroy(err);
    });
  });
  await pipeline(stream, cap, extractor);
}

// Check every ancestor: lstat("dist/file") alone misses a symlink named dist.
async function checkedPath(root: string, path: string) {
  const normalized = archivePath(path.replace(/^\.\//, ""));
  let current = resolve(root);
  if (!(await lstat(current)).isDirectory()) throw new Error("artifact root is not a directory");
  for (const part of normalized.split("/")) {
    current = join(current, part);
    const s = await lstat(current);
    if (s.isSymbolicLink() || (!s.isDirectory() && !s.isFile()) || (s.isFile() && s.nlink !== 1)) {
      throw new Error("build artifacts must be regular files without links");
    }
  }
  return current;
}

export async function packArtifacts(root: string, manifest: Manifest, yaml: string) {
  const zip = new AdmZip();
  zip.addFile("app.yaml", Buffer.from(yaml));
  let bytes = Buffer.byteLength(yaml);
  let entries = 1;
  async function add(path: string) {
    const full = await checkedPath(root, path);
    const s = await lstat(full);
    if (++entries > MAX_BUNDLE_ENTRIES) throw new Error("too many build artifacts");
    if (s.isDirectory()) {
      for (const name of await readdir(full)) await add(relative(root, join(full, name)));
    } else {
      if (s.size > MAX_FILE_BYTES || (bytes += s.size) > MAX_BUNDLE_UNPACKED) throw new Error("build artifacts too large");
      const file = await open(full, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        if (!(await file.stat()).isFile()) throw new Error("artifact is not a regular file");
        const data = await file.readFile();
        if (data.length !== s.size) throw new Error("artifact changed while being read");
        zip.addFile(archivePath(path.replace(/^\.\//, "")), data);
      } finally {
        await file.close();
      }
    }
  }
  if (manifest.frontend) await add("dist");
  if (manifest.backend) await add(manifest.backend.entry);
  if (manifest.database.enabled) {
    const path = manifest.database.migrations.replace(/^\.\//, "");
    if (await lstat(join(root, path)).then(() => true, (e) => { if (e.code === "ENOENT") return false; throw e; })) await add(path);
  }
  const result = zip.toBuffer();
  if (result.length > MAX_BUNDLE_BYTES) throw new Error("built bundle too large");
  return result;
}
