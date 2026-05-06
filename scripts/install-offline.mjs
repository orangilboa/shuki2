#!/usr/bin/env node

/**
 * Install deps on a closed network using the local npm registry.
 *
 * Packages are fetched from the registry as usual. The only special handling
 * is for better-sqlite3: its install script normally downloads a prebuilt
 * native binary from GitHub, which fails without internet. We set
 * build-from-source=true to skip that and compile from the bundled SQLite
 * source via node-gyp, pointing nodedir at the vendored Node.js headers.
 *
 * Usage:
 *   pnpm run install:offline
 */

import { execSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const nodedir = resolve(ROOT, "vendor", "node-headers");

execSync("pnpm install", {
  cwd: ROOT,
  stdio: "inherit",
  env: {
    ...process.env,
    npm_config_build_from_source: "true",
    npm_config_nodedir: nodedir,
  },
});
