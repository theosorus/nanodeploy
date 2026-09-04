import { build } from "esbuild";

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
  target: "node20",
  format: "esm",
  outfile: "dist/index.js",
  banner: {
    // esm has no require/__dirname; ssh2 uses both, so provide them
    js: [
      "import{createRequire}from'module';",
      "import{fileURLToPath}from'url';",
      "import{dirname}from'path';",
      "const require=createRequire(import.meta.url);",
      "const __filename=fileURLToPath(import.meta.url);",
      "const __dirname=dirname(__filename);",
    ].join(""),
  },
  plugins: [nativeExternal],
}).catch(() => process.exit(1));
