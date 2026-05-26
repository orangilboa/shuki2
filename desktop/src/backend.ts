// Spawns the openshuki backend as a child process. The backend listens on
// the port reported by env PORT (or 4000 by default), and we wait until
// /api/health returns ok before resolving so the renderer never sees the
// loading state.

import { spawn, type ChildProcess } from "node:child_process";
import http from "node:http";
import path from "node:path";

export type BackendHandle = {
  port: number;
  process: ChildProcess;
  stop: () => void;
};

function waitForHealth(port: number, timeoutMs: number): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = (): void => {
      const req = http.get({ host: "127.0.0.1", port, path: "/api/health", timeout: 1000 }, (res) => {
        if (res.statusCode === 200) {
          res.resume();
          resolve();
          return;
        }
        res.resume();
        retry();
      });
      req.on("error", retry);
      req.on("timeout", () => {
        req.destroy();
        retry();
      });
    };
    const retry = (): void => {
      if (Date.now() - start > timeoutMs) {
        reject(new Error(`backend did not respond on :${port} within ${timeoutMs}ms`));
        return;
      }
      setTimeout(attempt, 250);
    };
    attempt();
  });
}

function backendCwd(): string {
  // In dev (running from desktop/) the backend lives at ../backend.
  // In a packaged build (electron-builder), users will need to ship the
  // backend as resources/backend — this placeholder works for both as
  // long as the relative layout is preserved.
  const fromCwd = path.resolve(process.cwd(), "..", "backend");
  return fromCwd;
}

export async function startBackend(port: number): Promise<BackendHandle> {
  const cwd = backendCwd();
  // Use pnpm dev (tsx watch) in development. For a packaged build this
  // should be `node dist/server.js` against a built backend — out of scope
  // for the first version of this plan.
  const isWindows = process.platform === "win32";
  const cmd = isWindows ? "pnpm.cmd" : "pnpm";
  const child = spawn(cmd, ["dev"], {
    cwd,
    env: { ...process.env, PORT: String(port), OPENSHUKI_DESKTOP: "1" },
    stdio: ["ignore", "inherit", "inherit"],
    shell: false
  });

  child.on("exit", (code, signal) => {
    console.log(`[desktop] backend exited code=${code} signal=${signal ?? ""}`);
  });

  await waitForHealth(port, 30_000);

  return {
    port,
    process: child,
    stop: () => {
      if (!child.killed) child.kill();
    }
  };
}
