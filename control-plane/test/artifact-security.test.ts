import assert from "node:assert/strict";
import { test } from "node:test";
import { link, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import AdmZip from "adm-zip";
import tar from "tar-fs";
import { extractTar, packArtifacts } from "../src/artifacts.ts";
import { extractBundle, MAX_FILE_BYTES, readBundle } from "../src/bundle.ts";
import { parseManifest } from "../src/manifest.ts";

const yaml = "slug: audit-app\nfrontend: true\nbackend: {entry: server.js}\n";
async function fixture(fn: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "nd-artifact-security-"));
  try { await fn(root); } finally { await rm(root, { recursive: true, force: true }); }
}
function bundle() {
  const zip = new AdmZip();
  zip.addFile("app.yaml", Buffer.from(yaml));
  zip.addFile("dist/index.html", Buffer.from("<h1>safe</h1>"));
  zip.addFile("server.js", Buffer.from("console.log('ok')"));
  return zip;
}

test("bundle extraction ignores untrusted suid/sgid and executable permissions", () => fixture(async (root) => {
  const zip = bundle();
  zip.getEntry("server.js")!.attr = (0o106777 << 16) >>> 0;
  await extractBundle(zip.toBuffer(), root);
  assert.equal((await stat(join(root, "server.js"))).mode & 0o7777, 0o644);
  assert.equal(await readFile(join(root, "dist/index.html"), "utf8"), "<h1>safe</h1>");
}));

test("special files and oversized declarations are refused before extraction", () => {
  const special = bundle();
  special.getEntry("server.js")!.attr = (0o010644 << 16) >>> 0;
  assert.throws(() => readBundle(special.toBuffer()), /special files/);
  const big = bundle();
  const bytes = big.toBuffer();
  // Patch a central-directory size, without allocating that advertised file.
  for (let i = 0; i < bytes.length - 46; i++) {
    if (bytes.readUInt32LE(i) === 0x02014b50 && bytes.subarray(i + 46, i + 55).toString() === "server.js") {
      bytes.writeUInt32LE(MAX_FILE_BYTES + 1, i + 24);
    }
  }
  assert.throws(() => readBundle(bytes), /too large/);
});

test("a zero-size declaration does not disable the decompression cap", () => fixture(async (root) => {
  const zip = bundle();
  zip.addFile("bomb.txt", Buffer.alloc(1024 * 1024, 65));
  const bytes = zip.toBuffer();
  for (let i = 0; i < bytes.length - 46; i++) {
    const signature = bytes.readUInt32LE(i);
    if (signature === 0x02014b50 && bytes.subarray(i + 46, i + 54).toString() === "bomb.txt") bytes.writeUInt32LE(0, i + 24);
    if (signature === 0x04034b50 && bytes.subarray(i + 30, i + 38).toString() === "bomb.txt") bytes.writeUInt32LE(0, i + 22);
  }
  await assert.rejects(extractBundle(bytes, root));
}));

test("build output cannot exfiltrate a host file through a leaf or directory symlink", () => fixture(async (root) => {
  const output = join(root, "out");
  await mkdir(join(output, "dist"), { recursive: true });
  await writeFile(join(root, "fake-server-secret"), "must never enter the bundle");
  await writeFile(join(output, "server.js"), "console.log('ok')");
  await symlink(join(root, "fake-server-secret"), join(output, "dist/index.html"));
  await assert.rejects(packArtifacts(output, parseManifest(yaml), yaml), /without links/);
  await rm(join(output, "dist"), { recursive: true });
  await symlink(root, join(output, "dist"));
  await assert.rejects(packArtifacts(output, parseManifest(yaml), yaml), /without links/);
}));

test("build output rejects hard links and accepts an ordinary built app", () => fixture(async (root) => {
  await mkdir(join(root, "dist"));
  await writeFile(join(root, "dist/index.html"), "safe");
  await writeFile(join(root, "original"), "secret");
  await link(join(root, "original"), join(root, "server.js"));
  await assert.rejects(packArtifacts(root, parseManifest(yaml), yaml), /without links/);
  await rm(join(root, "server.js"));
  await writeFile(join(root, "server.js"), "console.log('ok')");
  assert.equal(readBundle(await packArtifacts(root, parseManifest(yaml), yaml)).slug, "audit-app");
}));

test("tar extraction rejects traversal and symbolic-link build artifacts as stream errors", () => fixture(async (root) => {
  const source = join(root, "source");
  const dest = join(root, "destination");
  await mkdir(source); await mkdir(dest);
  await writeFile(join(source, "file"), "payload");
  await assert.rejects(extractTar(tar.pack(source, { entries: ["file"], map: (h) => ({ ...h, name: "../../escape" }) }), dest), /unsafe/);
  await symlink("/etc/passwd", join(source, "link"));
  await assert.rejects(extractTar(tar.pack(source, { entries: ["link"] }), dest), /links/);
  await assert.rejects(stat(join(root, "escape")), { code: "ENOENT" });
}));
