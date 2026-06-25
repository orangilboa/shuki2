#!/usr/bin/env node
// Seed the vendored Electron + electron-builder binaries into the OS-default
// cache locations so an OFFLINE `pnpm install` / `pnpm build:desktop` finds
// them locally instead of downloading from GitHub.
//
// Why this exists: the `electron` package's postinstall and `electron-builder`
// both fetch prebuilt binaries from GitHub releases (NOT the npm registry). On
// an air-gapped network those fetches fail. We vendor the binaries under
// `desktop/vendor/` (committed to git) and copy them into the default caches
// here, before install.
//
// The Electron runtime zip exceeds GitHub's 100 MB per-file limit, so it is
// committed as split `*.part-*` chunks. This script reassembles them at the
// destination and verifies the result against the committed `.sha256` sidecar.
//
// Usage (run once after cloning, BEFORE `pnpm install`):
//   node scripts/seed-electron-cache.mjs
//
// Idempotent: re-running just refreshes the cache. Safe to run on any OS,
// though the vendored binaries target win32-x64 (see desktop/vendor/README.md).

import { homedir, platform } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  existsSync,
  cpSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { createHash as cryptoHash } from "node:crypto";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const vendorDir = join(repoRoot, "desktop", "vendor");

// Resolve the default cache roots used by @electron/get and electron-builder.
// These mirror the `env-paths` layout each tool uses when no override is set.
function cacheDirs() {
  const home = homedir();
  if (platform() === "win32") {
    const localAppData =
      process.env.LOCALAPPDATA || join(home, "AppData", "Local");
    return {
      electron: join(localAppData, "electron", "Cache"),
      builder: join(localAppData, "electron-builder", "Cache"),
    };
  }
  if (platform() === "darwin") {
    return {
      electron: join(home, "Library", "Caches", "electron"),
      builder: join(home, "Library", "Caches", "electron-builder"),
    };
  }
  // linux / other
  const xdg = process.env.XDG_CACHE_HOME || join(home, ".cache");
  return {
    electron: join(xdg, "electron"),
    builder: join(xdg, "electron-builder"),
  };
}

function seed(label, from, to) {
  if (!existsSync(from)) {
    console.warn(`! ${label}: nothing vendored at ${from} — skipping`);
    return false;
  }
  mkdirSync(to, { recursive: true });
  cpSync(from, to, { recursive: true });
  console.log(`✓ ${label}: copied -> ${to}`);
  return true;
}

function sha256(path) {
  const h = cryptoHash("sha256");
  h.update(readFileSync(path));
  return h.digest("hex");
}

// Walk a tree and reassemble any `<name>.part-aa`, `<name>.part-ab`, ...
// groups into `<name>`, verifying against a `<name>.sha256` sidecar if present.
// The committed `.part-*` and `.sha256` files are then removed from the
// destination copy (they remain in the repo).
function reassembleParts(root) {
  if (!existsSync(root)) return;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      if (e.isDirectory()) stack.push(join(dir, e.name));
    }
    // group part files in this dir by their base name
    const bases = new Set();
    for (const e of entries) {
      const m = e.isFile() && e.name.match(/^(.*)\.part-[a-z]{2}$/);
      if (m) bases.add(m[1]);
    }
    for (const base of bases) {
      const parts = entries
        .filter((e) => e.name.startsWith(`${base}.part-`))
        .map((e) => e.name)
        .sort();
      const target = join(dir, base);
      const buf = Buffer.concat(parts.map((p) => readFileSync(join(dir, p))));
      writeFileSync(target, buf);
      // verify against sidecar if present
      const sidecar = join(dir, `${base}.sha256`);
      if (existsSync(sidecar)) {
        const expected = readFileSync(sidecar, "utf8").trim().split(/\s+/)[0];
        const actual = sha256(target);
        if (expected !== actual) {
          rmSync(target, { force: true });
          throw new Error(
            `checksum mismatch for ${base}\n  expected ${expected}\n  actual   ${actual}`
          );
        }
        console.log(`✓ reassembled + verified ${base} (${parts.length} parts)`);
        rmSync(sidecar, { force: true });
      } else {
        console.log(`✓ reassembled ${base} (${parts.length} parts, no checksum)`);
      }
      for (const p of parts) rmSync(join(dir, p), { force: true });
    }
  }
}

const { electron, builder } = cacheDirs();
console.log(`Seeding caches for ${platform()}...`);

if (seed("electron binary", join(vendorDir, "electron-cache"), electron)) {
  reassembleParts(electron);
}
seed("electron-builder tools", join(vendorDir, "electron-builder-cache"), builder);

console.log("\nDone. Now run `pnpm install` (offline), then `pnpm build:desktop`.");
