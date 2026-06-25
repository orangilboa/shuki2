# desktop/vendor — offline Electron build assets

These directories hold the GitHub-release binaries that `electron` and
`electron-builder` normally download at install/build time. They are committed
so the desktop app can be installed **and packaged on an air-gapped network**
with only the npm registry reachable.

## Why this is needed

Two dependencies pull binaries from GitHub releases, **not** the npm registry:

| Tool              | What it fetches                          | From |
| ----------------- | ---------------------------------------- | ---- |
| `electron`        | the prebuilt Electron runtime zip        | `github.com/electron/electron/releases` |
| `electron-builder`| `winCodeSign`, `nsis`, `nsis-resources`  | `github.com/electron-userland/electron-builder-binaries/releases` |

On an internal network those fetches fail. Vendoring them here + seeding the OS
cache makes `pnpm install` and `pnpm build:desktop` work offline.

## What's here

```
electron-cache/<sha>/       @electron/get cache for electron-v33.4.11-win32-x64.zip:
  *.zip.part-aa/-ab/-ac        the zip, SPLIT into <100 MB chunks (see below)
  *.zip.sha256                 expected checksum of the reassembled zip
  SHASUMS256.txt               @electron/get integrity file
electron-builder-cache/
  winCodeSign/winCodeSign-2.6.0/
  nsis/nsis-3.0.4.1/
  nsis/nsis-resources-3.4.1/
```

Targets **Windows x64** (matches `desktop/electron-builder.yml`). Versions are
pinned to the lockfile: electron `33.4.11`, electron-builder `25.1.8`.

> The cache layouts are produced by the real tools (`@electron/get` and
> `app-builder`), so the hashed folder names match exactly what they look up at
> install time. Don't hand-edit the folder structure.

### Why the zip is split

The Electron runtime zip is ~110 MB — over GitHub's 100 MB per-file hard limit.
It is committed as `*.part-*` chunks (45 MB each). `seed-electron-cache.mjs`
concatenates them in order and verifies the result against the `.sha256`
sidecar before placing it in the cache. The full zip is git-ignored
(`desktop/vendor/.gitignore`) so it can never be committed by accident.

## Offline workflow (on the internal network)

```bash
git clone <repo> && cd openshuki
node scripts/seed-electron-cache.mjs   # copies vendor/ into the OS cache
pnpm install                            # electron postinstall hits the cache
pnpm build:desktop                      # electron-builder hits the cache
```

`pnpm-workspace.yaml` already allows electron's build script to run
(`allowBuilds.electron`), which is required for the postinstall to place the
binary even when the cache is present.

## Refreshing (when bumping electron / electron-builder)

Re-download with internet, then re-commit. From a machine **with** internet,
after `pnpm install` in `desktop/`:

- Electron binary:
  ```bash
  VENDOR=desktop/vendor/electron-cache
  node -e "require('@electron/get').downloadArtifact({version:'<VER>',platform:'win32',arch:'x64',artifactName:'electron',cacheRoot:'$VENDOR'})"
  ```
- electron-builder tools: run `app-builder download-artifact` for each
  (`winCodeSign`, `nsis-<ver>`, `nsis-resources-<ver>`) with
  `ELECTRON_BUILDER_CACHE=desktop/vendor/electron-builder-cache`, or simply run
  a packaging build once with that env var set and copy the populated cache.

The exact pinned tool versions live in `app-builder-lib`'s source
(`out/targets/nsis/nsisUtil.js`, `NsisTarget.js`) and the `app-builder` binary
default (winCodeSign).
