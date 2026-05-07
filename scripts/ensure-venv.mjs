import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const VENV = resolve("agents/.venv");

if (existsSync(VENV)) {
  console.log(`agents/.venv exists — skipping`);
  process.exit(0);
}

const candidates = process.platform === "win32" ? ["py", "python", "python3"] : ["python3", "python"];
for (const cmd of candidates) {
  const args = cmd === "py" ? ["-3", "-m", "venv", VENV] : ["-m", "venv", VENV];
  const result = spawnSync(cmd, args, { stdio: "inherit", shell: false });
  if (result.error?.code === "ENOENT") continue;
  if (result.status === 0) {
    console.log(`created ${VENV} via ${cmd}`);
    process.exit(0);
  }
  process.exit(result.status ?? 1);
}

console.error("could not find a Python interpreter (tried: " + candidates.join(", ") + ")");
process.exit(1);
