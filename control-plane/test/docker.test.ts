import assert from "node:assert/strict";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const container = process.env.NANODEPLOY_TEST_POSTGRES_CONTAINER;
const exec = promisify(execFile);

test("database restore also removes tables introduced after the snapshot", { skip: !container, timeout: 30000 }, async () => {
  assert.match(container!, /^nanodeploy-audit-/);
  process.env.POSTGRES_CONTAINER = container;
  const docker = await import("../src/docker.ts");
  const db = `app_restore_${process.pid}_audit`;
  const password = "audit-snapshot-local-only";
  const work = await mkdtemp(join(tmpdir(), "nanodeploy-snapshot-test-"));
  const admin = (...args: string[]) => exec("docker", ["exec", container!, ...args]);
  const psql = (...args: string[]) => exec("docker", ["exec", "--env", `PGPASSWORD=${password}`, container!, "psql", "-h", "127.0.0.1", "-U", db, "-d", db, "-v", "ON_ERROR_STOP=1", ...args]);
  await admin("psql", "-U", "postgres", "-d", "postgres", "-c", `create role "${db}" login password '${password}'`);
  await admin("createdb", "-U", "postgres", "-O", db, db);
  try {
    await psql("-c", "create table original (id int); insert into original values (1)");
    const file = join(work, "before.dump");
    await docker.dumpDatabase(db, file, password);
    await psql("-c", "create table introduced_by_bad_migration (id int); insert into original values (2)");
    await docker.restoreDatabase(db, file, password);
    const { stdout } = await psql("-Atc", "select (select count(*) from original), to_regclass('introduced_by_bad_migration')");
    assert.equal(stdout.trim(), "1|");
    const broken = join(work, "broken.dump");
    await writeFile(broken, "invalid dump");
    await assert.rejects(docker.restoreDatabase(db, broken, password), /pg_restore/);
    assert.equal((await psql("-Atc", "select count(*) from original")).stdout.trim(), "1", "a failed restore must preserve the original database");
    await assert.rejects(docker.dumpDatabase(db, join(work, "missing-directory", "bad.dump"), password), /ENOENT/);
  } finally {
    await admin("dropdb", "-U", "postgres", "--force", db);
    await admin("dropuser", "-U", "postgres", db);
    await rm(work, { recursive: true, force: true });
  }
});
