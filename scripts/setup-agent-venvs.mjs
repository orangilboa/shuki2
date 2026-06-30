// Per-agent Python virtualenvs, provisioned with uv.
//
// Each Python agent (a subdirectory of `agents/` containing a `main.py`) gets
// its own `.venv`. This keeps an agent's dependency set isolated from every
// other agent so version conflicts can't leak across agents.
//
// Dependencies are installed with `uv`, which links packages from a single
// global content-addressed cache (clone/hardlink) instead of copying a fresh
// copy into every venv. So identical versions across agents (e.g. langgraph in
// both `weather` and `meeting-planner`) are stored once on disk and resolved/
// built once — full isolation, no duplication. uv is auto-installed if missing
// (see ensure-uv.mjs).
//
// For each Python agent this script:
//   1. Creates `agents/<name>/.venv` (via `uv venv`) if it doesn't exist.
//   2. Installs that agent's own declared dependencies into the venv:
//        - `agents/<name>/pyproject.toml`  -> `uv pip install <dir>` (preferred), or
//        - `agents/<name>/requirements.txt` -> `uv pip install -r <file>` (fallback).
//      Each agent declares exactly what it imports; nothing is shared, so e.g.
//      the stdlib-only agents pull in no third-party packages.
//
// The agents.json `exec.command` for Python agents is `{VENV_PYTHON}`, which the
// subprocess runner resolves to `<cwd>/.venv/(bin|Scripts)/python` — i.e. this
// exact venv. Re-runnable and idempotent: existing venvs are reused, deps are
// re-installed (uv no-ops when already satisfied).

import { existsSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { findUv, ensureUv } from "./ensure-uv.mjs";

// Resolve `agents/` relative to this script (scripts/ → ../agents), not the
// cwd, so the script works whether invoked from the repo root or from agents/.
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const AGENTS_DIR = resolve(SCRIPT_DIR, "..", "agents");

/** Path to the venv's python, cross-platform. Mirrors the runner's resolution. */
function venvPython(venvDir) {
  return process.platform === "win32"
    ? join(venvDir, "Scripts", "python.exe")
    : join(venvDir, "bin", "python");
}

function run(cmd, args) {
  const result = spawnSync(cmd, args, { stdio: "inherit", shell: false });
  if (result.error) {
    console.error(`failed to run ${cmd}: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}

/** Subdirectories of `agents/` that hold a Python agent (have a `main.py`). */
function pythonAgentDirs() {
  return readdirSync(AGENTS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name !== "node_modules" && !e.name.startsWith("."))
    .map((e) => join(AGENTS_DIR, e.name))
    .filter((dir) => existsSync(join(dir, "main.py")));
}

const agentDirs = pythonAgentDirs();
if (agentDirs.length === 0) {
  console.log("no Python agents found — nothing to do");
  process.exit(0);
}

// `agents:install` runs `node scripts/ensure-uv.mjs` first, so uv is normally
// already present (findUv). Fall back to ensureUv() so this script also works
// when run standalone.
const uv = findUv() ?? ensureUv();

for (const dir of agentDirs) {
  const name = dir.slice(AGENTS_DIR.length + 1);
  const venvDir = join(dir, ".venv");
  const vpy = venvPython(venvDir);

  if (existsSync(vpy)) {
    console.log(`[${name}] .venv exists — reusing`);
  } else {
    console.log(`[${name}] creating .venv …`);
    run(uv, ["venv", venvDir]);
  }

  // Install the agent's own declared dependencies into its venv. uv links from
  // its global cache, so identical versions across agents aren't re-stored.
  // Prefer pyproject.toml; fall back to a requirements.txt. An agent with
  // neither declares no third-party deps.
  const pyproject = join(dir, "pyproject.toml");
  const ownReq = join(dir, "requirements.txt");
  const pipBase = ["pip", "install", "--python", vpy];

  if (existsSync(pyproject)) {
    console.log(`[${name}] installing deps from pyproject.toml …`);
    run(uv, [...pipBase, dir]);
  } else if (existsSync(ownReq)) {
    console.log(`[${name}] installing deps from requirements.txt …`);
    run(uv, [...pipBase, "-r", ownReq]);
  } else {
    console.log(`[${name}] no dependency file — nothing to install`);
  }
}

console.log(`done — ${agentDirs.length} agent venv(s) ready`);
