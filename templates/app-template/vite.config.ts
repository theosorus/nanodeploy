import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // in dev, /api goes to the local backend; in production caddy handles it
  server: { proxy: { "/api": "http://localhost:3000" } },
});
