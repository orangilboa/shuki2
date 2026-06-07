import { defineConfig, devices } from "@playwright/test";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

// The e2e suite runs its own backend + frontend on dedicated ports so it never
// collides with a developer's running `pnpm dev` (default :4000 / :5173) and
// always exercises *this* worktree's code. The Vite dev server proxies `/api`
// to the e2e backend.
const BACKEND_PORT = 4100;
const FRONTEND_PORT = 5273;
export const FRONTEND_URL = `http://localhost:${FRONTEND_PORT}`;
export const API_BASE = `http://localhost:${BACKEND_PORT}`;

export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  // Agent subprocesses (Python/tsx) make some flows slow to settle; keep the
  // run serial so the shared Postgres state stays predictable.
  workers: 1,
  reporter: [["list"], ["html", { open: "never" }]],
  timeout: 60_000,
  expect: { timeout: 15_000 },

  use: {
    baseURL: FRONTEND_URL,
    trace: "on-first-retry",
    screenshot: "only-on-failure"
  },

  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] }
    }
  ],

  webServer: [
    {
      command: "pnpm --filter openshuki-backend dev",
      cwd: repoRoot,
      url: `${API_BASE}/api/health`,
      env: { PORT: String(BACKEND_PORT) },
      reuseExistingServer: true,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 120_000
    },
    {
      command: "pnpm --filter openshuki-frontend dev",
      cwd: repoRoot,
      url: FRONTEND_URL,
      env: {
        VITE_PORT: String(FRONTEND_PORT),
        VITE_API_TARGET: API_BASE
      },
      reuseExistingServer: true,
      stdout: "pipe",
      stderr: "pipe",
      timeout: 120_000
    }
  ]
});
