// Ensure `uv` (Astral's Python package manager) is available, installing it if
// it's missing.
//
// Why uv: each Python agent has its own venv (isolated), but uv links packages
// from a single global content-addressed cache (clone/hardlink) instead of
// copying a fresh copy into every venv. Identical dependency versions across
// agents are therefore stored once on disk and resolved/built once — the Python
// equivalent of what pnpm does for node_modules.
//
// Exports findUv()/ensureUv() for setup-agent-venvs.mjs. When run directly
// (a step in `pnpm agents:install`) it runs ensureUv().

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { homedir } from "node:os";

const onWindows = process.platform === "win32";
const uvBin = onWindows ? "uv.exe" : "uv";

/** Default locations the uv installer drops the binary into. */
function uvCandidates() {
  const home = homedir();
  return [
    join(home, ".local", "bin", uvBin),
    join(home, ".cargo", "bin", uvBin)
  ];
}

function works(cmd) {
  const r = spawnSync(cmd, ["--version"], { stdio: "ignore", shell: false });
  return !r.error && r.status === 0;
}

/**
 * Return an invocable uv path: "uv" if it's on PATH, else an absolute path in
 * one of the installer's default locations, else null. (The installer updates
 * shell rc files, not the current process PATH, so after a fresh install uv may
 * only be findable by absolute path until the shell is restarted.)
 */
export function findUv() {
  if (works(uvBin)) return uvBin;
  for (const p of uvCandidates()) {
    if (existsSync(p) && works(p)) return p;
  }
  return null;
}

function install() {
  console.log("[uv] not found — installing via the official installer…");
  let res;
  if (onWindows) {
    res = spawnSync(
      "powershell",
      ["-ExecutionPolicy", "ByPass", "-NoProfile", "-Command", "irm https://astral.sh/uv/install.ps1 | iex"],
      { stdio: "inherit" }
    );
  } else {
    const haveCurl = spawnSync("curl", ["--version"], { stdio: "ignore" }).status === 0;
    const pipeline = haveCurl
      ? "curl -LsSf https://astral.sh/uv/install.sh | sh"
      : "wget -qO- https://astral.sh/uv/install.sh | sh";
    res = spawnSync("sh", ["-c", pipeline], { stdio: "inherit" });
  }
  if (res.error || res.status !== 0) {
    console.error(
      "[uv] automatic install failed. Install it manually — " +
        "https://docs.astral.sh/uv/getting-started/installation/ — and re-run."
    );
    process.exit(res.status ?? 1);
  }
}

/** Find uv, installing it if missing. Returns an invocable uv path. */
export function ensureUv() {
  let uv = findUv();
  if (uv) {
    console.log(`[uv] present (${uv})`);
    return uv;
  }
  install();
  uv = findUv();
  if (!uv) {
    console.error(
      "[uv] installed but not found on PATH or in ~/.local/bin. Add it to your " +
        "PATH (you may need to restart your shell) and re-run."
    );
    process.exit(1);
  }
  console.log(`[uv] installed (${uv})`);
  return uv;
}

// Run ensureUv() when invoked directly (not when imported).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  ensureUv();
}
