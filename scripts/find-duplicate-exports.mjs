#!/usr/bin/env node
// Tool: find duplicated exports across the workspace.
//
// Scans all .ts/.tsx files (excluding node_modules, dist, build) for lines
// matching `export type`, `export function`, and `export async function`.
// Extracts the exported identifier, groups occurrences, and reports any
// identifier that appears in more than one file (likely duplicated code that
// should move to the shared/common package).
//
// Usage: node scripts/find-duplicate-exports.mjs [--json]

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const IGNORE_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  ".git",
  ".claude",
  "data",
  "__pycache__"
]);

const EXPORT_RE =
  /^\s*export\s+(?:async\s+)?(type|interface|function)\s+([A-Za-z0-9_$]+)/;

/** Recursively collect .ts/.tsx files. */
function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (IGNORE_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

const files = walk(ROOT);

// identifier -> [{ kind, file, line, text }]
const byName = new Map();

for (const file of files) {
  const rel = relative(ROOT, file).replace(/\\/g, "/");
  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  lines.forEach((text, i) => {
    const m = EXPORT_RE.exec(text);
    if (!m) return;
    const [, rawKind, name] = m;
    const kind = /export\s+async/.test(text) ? "async function" : rawKind;
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name).push({ kind, file: rel, line: i + 1, text: text.trim() });
  });
}

// A "duplicate" = same exported identifier declared in more than one distinct file.
const duplicates = [];
for (const [name, occ] of byName) {
  const files = new Set(occ.map((o) => o.file));
  if (files.size > 1) duplicates.push({ name, occurrences: occ });
}

duplicates.sort((a, b) => b.occurrences.length - a.occurrences.length);

if (process.argv.includes("--json")) {
  console.log(JSON.stringify(duplicates, null, 2));
} else {
  console.log(
    `Scanned ${files.length} files. Found ${duplicates.length} exported identifiers declared in >1 file:\n`
  );
  for (const d of duplicates) {
    console.log(`■ ${d.name}  (${d.occurrences.length} occurrences)`);
    for (const o of d.occurrences) {
      console.log(`    [${o.kind}] ${o.file}:${o.line}`);
      console.log(`        ${o.text}`);
    }
    console.log("");
  }
}
