#!/usr/bin/env node

/**
 * Download Node.js headers for offline native-module compilation.
 *
 * better-sqlite3 compiles a native addon via node-gyp, which needs Node.js
 * C headers. On a closed network node-gyp can't download them, so we vendor
 * them into vendor/node-headers/.
 *
 * Run on a connected machine whenever the Node.js major version changes:
 *   pnpm run vendor
 *
 * Then commit vendor/node-headers/.
 */

import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const NODE_HEADERS_DIR = join(ROOT, "vendor", "node-headers");

const nodeVersion = process.version; // e.g. "v22.17.0"

async function run() {
  console.log(`[vendor] Node ${nodeVersion}\n`);

  // ── Download & extract Node.js headers ──
  const tarballUrl = `https://nodejs.org/dist/${nodeVersion}/node-${nodeVersion}-headers.tar.gz`;
  console.log(`[vendor] Downloading headers: ${tarballUrl}`);

  mkdirSync(NODE_HEADERS_DIR, { recursive: true });

  const tarball = join(tmpdir(), `node-${nodeVersion}-headers.tar.gz`);
  const res = await fetch(tarballUrl);
  if (!res.ok) {
    throw new Error(`Failed to download headers: ${res.status} ${res.statusText}`);
  }
  await pipeline(res.body, createWriteStream(tarball));

  // The tarball has a top-level node-v22.17.0/ directory; strip it so
  // include/node/*.h lands directly inside NODE_HEADERS_DIR.
  execSync(`tar xzf "${tarball}" --strip-components=1 -C "${NODE_HEADERS_DIR}"`, {
    stdio: "inherit",
  });

  console.log(`[vendor] Extracted to ${NODE_HEADERS_DIR}\n`);

  // ── Write installVersion marker ──
  // node-gyp skips re-downloading headers when this file exists.
  writeFileSync(join(NODE_HEADERS_DIR, "installVersion"), "9", "utf-8");
  console.log("[vendor] Wrote installVersion marker");

  console.log("\n[vendor] Done. Commit vendor/node-headers/.");
}

run().catch((err) => {
  console.error("[vendor] Fatal:", err);
  process.exit(1);
});
