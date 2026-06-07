import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Port and API proxy target are env-overridable so the e2e harness can run an
// isolated frontend/backend pair on alternate ports without colliding with a
// developer's running `pnpm dev`. Defaults are unchanged for normal use.
const port = Number(process.env.VITE_PORT ?? 5173);
const apiTarget = process.env.VITE_API_TARGET ?? "http://localhost:4000";

export default defineConfig({
  plugins: [react()],
  server: {
    port,
    proxy: {
      "/api": apiTarget
    }
  }
});
