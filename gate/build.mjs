// Two bundles: the server (node, ESM) and the passkey script for the sign-in
// pages (browser). Nothing is fetched from a CDN at runtime.
import { build } from "esbuild";

await build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  outfile: "dist/index.js",
  banner: { js: "import{createRequire}from'module';const require=createRequire(import.meta.url);" },
  logLevel: "warning",
});

await build({
  entryPoints: ["src/client.ts"],
  bundle: true,
  platform: "browser",
  target: "es2020",
  format: "iife",
  minify: true,
  outfile: "public/gate.js",
  logLevel: "warning",
});
