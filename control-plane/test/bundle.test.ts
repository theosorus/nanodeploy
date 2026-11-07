import assert from "node:assert/strict";
import { test } from "node:test";
import AdmZip from "adm-zip";
import { readBundle } from "../src/releases.ts";

function bundle(manifest: string, files: Record<string, string> = {}) {
  const zip = new AdmZip();
  zip.addFile("app.yaml", Buffer.from(manifest));
  for (const [name, content] of Object.entries(files)) zip.addFile(name, Buffer.from(content));
  return zip;
}

test("an incomplete bundle is refused before any live files can change", () => {
  assert.throws(() => readBundle(bundle("slug: notes").toBuffer()), /dist\/index.html/);
  assert.throws(() => readBundle(bundle("slug: notes\nfrontend: false\nbackend: {entry: server.js}").toBuffer()), /server.js/);
  assert.equal(readBundle(bundle("slug: notes", { "dist/index.html": "Hello" }).toBuffer()).slug, "notes");
  assert.equal(readBundle(bundle("slug: notes\nfrontend: false\nbackend: {entry: build/server.js}", { "build/server.js": "" }).toBuffer()).backend?.entry, "build/server.js");
});

test("archive aliases cannot overwrite the checked manifest or escape extraction", () => {
  for (const name of ["../app.yaml", "/app.yaml", "dist/../app.yaml", "dist\\index.html", "dist//index.html"]) {
    const zip = bundle("slug: notes\nfrontend: false");
    // Mutate after addFile: its convenience API normalises input paths.
    zip.addFile("unsafe.txt", Buffer.from("slug: another"));
    zip.getEntry("unsafe.txt")!.entryName = name;
    assert.throws(() => readBundle(zip.toBuffer()), /unsafe|exactly one/, name);
  }
});

test("a symlink in an upload is not treated as an ordinary file", () => {
  const zip = bundle("slug: notes", { "dist/index.html": "/etc/passwd" });
  zip.getEntry("dist/index.html")!.attr = (0o120777 << 16) >>> 0;
  assert.throws(() => readBundle(zip.toBuffer()), /symbolic links/);
});
