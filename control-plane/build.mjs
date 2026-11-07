import { build } from "esbuild";
import { execFileSync } from "node:child_process";

// dockerode pulls in ssh2, which loads two optional native bindings
// (cpu-features and sshcrypto). esbuild cannot pack a .node binary, and which
// bindings get compiled depends on the platform, so a bundle that works on one
// machine breaks on another. We never open an ssh connection — the control
// plane only speaks tcp to the socket proxy — and ssh2 wraps every native
// require in a try/catch, falling back to pure JS. So mark all native bindings
// external: at runtime the require throws, is swallowed, and the JS path runs.
const nativeExternal = {
  name: "native-external",
  setup(b) {
    b.onResolve({ filter: /\.node$/ }, () => ({ external: true }));
    b.onResolve({ filter: /^cpu-features$/ }, () => ({ external: true }));
  },
};

await build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  outfile: "dist/index.js",
  banner: {
    // esm has no require/__dirname; ssh2 uses both, so provide them
    js: [
      "import{createRequire as __ndCreateRequire}from'node:module';",
      "import{fileURLToPath as __ndFileURLToPath}from'node:url';",
      "import{dirname as __ndDirname}from'node:path';",
      "const require=__ndCreateRequire(import.meta.url);",
      "const __filename=__ndFileURLToPath(import.meta.url);",
      "const __dirname=__ndDirname(__filename);",
    ].join(""),
  },
  plugins: [nativeExternal],
}).catch(() => process.exit(1));

// The banner is appended after bundling: parse the emitted module too, where
// a banner binding could otherwise collide with an entry point import.
execFileSync(process.execPath, ["--check", "dist/index.js"], { stdio: "inherit" });
