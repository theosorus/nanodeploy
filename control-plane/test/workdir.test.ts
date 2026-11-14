import assert from "node:assert/strict";
import { test } from "node:test";
import { chmod, mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyWorkDir } from "../src/workdir.ts";

test("a work directory is emptied in place, never removed, and stays private", async () => {
  const root = await mkdtemp(join(tmpdir(), "nd-workdir-"));
  try {
    const dir = join(root, ".builds");
    // created by the installer or by an earlier version, readable by everyone
    await mkdir(join(dir, "7", "src"), { recursive: true });
    await chmod(dir, 0o755);
    await writeFile(join(dir, "7", "src", "secret.txt"), "sources of a private repository");
    await writeFile(join(dir, "leftover"), "x");
    const before = await stat(dir);

    await emptyWorkDir(dir);
    const after = await stat(dir);
    // the gateway's mask is mounted on this very directory: a new inode would
    // mean it was removed, and the mask with it
    assert.equal(after.ino, before.ino);
    assert.deepEqual(await readdir(dir), []);
    assert.equal(after.mode & 0o777, 0o700);

    const missing = join(root, ".staging");
    await emptyWorkDir(missing);
    assert.equal((await stat(missing)).mode & 0o777, 0o700);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
