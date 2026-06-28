// Per-agent Python virtualenvs.
//
// Each Python agent (a subdirectory of `agents/` containing a `main.py`) gets
// its own `.venv`. This keeps an agent's dependency set isolated from every
// other agent so version conflicts can't leak across agents.
//
// For each Python agent this script:
//   1. Creates `agents/<name>/.venv` if it doesn't already exist.
//   2. Installs the shared `agents/requirements.txt` (langgraph, langchain-core)
//      plus the agent's own `agents/<name>/requirements.txt`, if present, into
//      that venv.
//
// The agents.json `exec.command` for Python agents is `{VENV_PYTHON}`, which the
// subprocess runner resolves to `<cwd>/.venv/(bin|Scripts)/python` — i.e. this
// exact venv. Re-runnable and idempotent: existing venvs are reused, deps are
// re-installed (pip no-ops when already satisfied).

import { existsSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";

// Resolve `agents/` relative to this script (scripts/ → ../agents), not the
// cwd, so the script works whether invoked from the repo root or from agents/.
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const AGENTS_DIR = resolve(SCRIPT_DIR, "..", "agents");
const SHARED_REQUIREMENTS = join(AGENTS_DIR, "requirements.txt");

/** Locate a base Python interpreter usable for `-m venv`. */
function findPython() {
  const candidates =
    process.platform === "win32" ? ["py", "python", "python3"] : ["python3", "python"];
  for (const cmd of candidates) {
    const probeArgs = cmd === "py" ? ["-3", "--version"] : ["--version"];
    const result = spawnSync(cmd, probeArgs, { stdio: "ignore", shell: false });
    if (result.error?.code === "ENOENT") continue;
    if (result.status === 0) return cmd;
  }
  return null;
}

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

const py = findPython();
if (!py) {
  console.error(
    "could not find a Python interpreter (tried: py/python/python3). " +
      "Install Python 3 and re-run."
  );
  process.exit(1);
}

const baseVenvArgs = (target) =>
  py === "py" ? ["-3", "-m", "venv", target] : ["-m", "venv", target];

for (const dir of agentDirs) {
  const name = dir.slice(AGENTS_DIR.length + 1);
  const venvDir = join(dir, ".venv");
  const vpy = venvPython(venvDir);

  if (existsSync(vpy)) {
    console.log(`[${name}] .venv exists — reusing`);
  } else {
    console.log(`[${name}] creating .venv …`);
    run(py, baseVenvArgs(venvDir));
  }

  // Collect requirements: the shared set first, then the agent's own (if any).
  const reqFiles = [];
  if (existsSync(SHARED_REQUIREMENTS)) reqFiles.push(SHARED_REQUIREMENTS);
  const ownReq = join(dir, "requirements.txt");
  if (existsSync(ownReq)) reqFiles.push(ownReq);

  if (reqFiles.length === 0) {
    console.log(`[${name}] no requirements to install`);
    continue;
  }

  const pipArgs = ["-m", "pip", "install", "--disable-pip-version-check"];
  for (const f of reqFiles) pipArgs.push("-r", f);
  console.log(`[${name}] installing deps (${reqFiles.length} requirements file(s)) …`);
  run(vpy, pipArgs);
}

console.log(`done — ${agentDirs.length} agent venv(s) ready`);
