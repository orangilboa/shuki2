import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const TARGETS = new Set(["node_modules", "__pycache__", ".venv", "venv"]);
const SKIP = new Set([".git", ".claude", "zeroclaw"]);

let removed = 0;

function walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const full = join(dir, entry.name);
    if (TARGETS.has(entry.name)) {
      rmSync(full, { recursive: true, force: true });
      console.log(`removed ${full}`);
      removed++;
      continue;
    }
    if (SKIP.has(entry.name)) continue;
    walk(full);
  }
}

walk(process.cwd());
console.log(`done — ${removed} folder(s) removed`);
