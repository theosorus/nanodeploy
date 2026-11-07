import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // Safari 14.0 has a destructuring bug; esbuild 0.28 refuses that target.
  build: { target: ["es2020", "chrome87", "edge88", "firefox78", "safari14.1"] },
  // in dev, /api goes to the local backend; in production caddy handles it
  server: { proxy: { "/api": "http://localhost:3000" } },
});
