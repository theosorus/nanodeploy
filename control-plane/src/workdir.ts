import { chmod, mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

// Empties a work directory (.staging, .builds) without ever removing it. Caddy
// masks these directories with an empty mount, and the kernel drops a mount
// whose directory is deleted from another container: remove and recreate the
// directory here, and everything written afterwards shows through in the
// gateway. Private to the control plane on the host too: a build holds the
// sources of a repository.
export async function emptyWorkDir(dir: string) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  for (const name of await readdir(dir)) await rm(join(dir, name), { recursive: true, force: true });
}
