import AdmZip from "adm-zip";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import { parseManifest } from "./manifest.js";

export const MAX_BUNDLE_BYTES = 100 * 1024 * 1024;
export const MAX_BUNDLE_UNPACKED = 512 * 1024 * 1024;
export const MAX_BUNDLE_ENTRIES = 5000;
export const MAX_FILE_BYTES = 64 * 1024 * 1024;
export const MAX_MANIFEST_BYTES = 64 * 1024;

// Validation and extraction must agree on exactly one spelling of each path.
export function archivePath(name: string): string {
  const path = name.replace(/\/$/, "");
  if (!path || path.length > 512 || /[\\:\u0000-\u001f\u007f]/.test(path) || path.startsWith("/")) {
    throw new Error("unsafe archive path");
  }
  const parts = path.split("/");
  if (parts.length > 32 || parts.some((p) => !p || p === "." || p === "..")) {
    throw new Error("unsafe archive path escapes or ambiguously names a file");
  }
  return path;
}

function checkedZip(bytes: Buffer) {
  if (bytes.length > MAX_BUNDLE_BYTES) throw new Error("bundle too large");
  const zip = new AdmZip(bytes);
  const entries = zip.getEntries();
  if (!entries.length || entries.length > MAX_BUNDLE_ENTRIES) throw new Error("invalid number of files in bundle");
  const names = new Set<string>();
  let size = 0;
  const files = entries.map((entry) => {
    const path = archivePath(entry.entryName);
    if (names.has(path)) throw new Error("duplicate path in bundle");
    names.add(path);
    const kind = (entry.attr >>> 16) & 0o170000;
    if (kind && kind !== (entry.isDirectory ? 0o040000 : 0o100000)) {
      throw new Error("symbolic links and special files are forbidden in bundles");
    }
    if (entry.header.flags & 1) throw new Error("encrypted bundles are not supported");
    const limit = path === "app.yaml" ? MAX_MANIFEST_BYTES : MAX_FILE_BYTES;
    if (!Number.isSafeInteger(entry.header.size) || entry.header.size < 0 || entry.header.size > limit) {
      throw new Error("file too large in bundle");
    }
    size += entry.header.size;
    if (size > MAX_BUNDLE_UNPACKED) throw new Error("bundle too large when unpacked");
    return { entry, path };
  });
  const manifests = files.filter(({ entry, path }) => !entry.isDirectory && path === "app.yaml");
  if (manifests.length !== 1) throw new Error("bundle must contain exactly one top-level app.yaml");
  const manifest = parseManifest(dataOf(manifests[0].entry).toString("utf8"));
  const fileNames = new Set(files.filter(({ entry }) => !entry.isDirectory).map(({ path }) => path));
  if (manifest.frontend && !fileNames.has("dist/index.html")) throw new Error("bundle is missing dist/index.html");
  if (manifest.backend && !fileNames.has(posix.normalize(manifest.backend.entry))) {
    throw new Error(`bundle is missing ${manifest.backend.entry}`);
  }
  return { files, manifest };
}

function dataOf(entry: AdmZip.IZipEntry) {
  // adm-zip >= 0.6.1 caps inflation even when a forged header declares zero.
  const data = entry.getData();
  if (data.length !== entry.header.size) throw new Error("bundle file size does not match its header");
  return data;
}

export const readBundle = (bytes: Buffer) => checkedZip(bytes).manifest;

// The destination is a new private staging directory. Ignore archive modes
// and never create links, overwrite files, or sanitize paths after validation.
export async function extractBundle(bytes: Buffer, destination: string) {
  const { files, manifest } = checkedZip(bytes);
  for (const { entry, path } of files) {
    const target = join(destination, path);
    if (entry.isDirectory) await mkdir(target, { recursive: true, mode: 0o755 });
    else {
      const data = dataOf(entry);
      await mkdir(dirname(target), { recursive: true, mode: 0o755 });
      await writeFile(target, data, { flag: "wx", mode: 0o644 });
    }
  }
  return manifest;
}
