# openshuki — Playwright e2e

End-to-end and API tests for the cases in [`../docs/test-plan.md`](../docs/test-plan.md)
that can be exercised without Electron. Covers the backend REST surface, the
SSE-driven web UI, and a couple of pure-function units.

## Running

From the repo root:

```bash
pnpm test:e2e            # run the suite (boots its own backend + frontend)
pnpm test:e2e:install    # one-time: download the Chromium browser
```

Or from this folder: `pnpm test`, `pnpm test:ui` (watch mode), `pnpm report`.

### How it boots

`playwright.config.ts` starts an **isolated** backend + frontend on dedicated
ports so the suite never collides with a developer's running `pnpm dev`:

- backend → `http://localhost:4100` (`PORT=4100`)
- frontend → `http://localhost:5273` (Vite, proxying `/api` → `:4100`)

Requirements: Postgres reachable at `DB_URL` (the same default the app uses —
`postgresql://openshuki:openshuki@localhost:5432/openshuki`) and Python on PATH
(the `ask-demo` / `weather` agents are real subprocesses). The suite uses the
default database and cleans up everything it creates; point `DB_URL` at a throwaway
database if you'd rather keep dev data untouched.

## What's covered (mapped to the test plan)

| Spec | Test-plan items |
|------|-----------------|
| `api-health.spec.ts` | health (used by §8.2) |
| `api-channels.spec.ts` | #5.1–5.6, #9.8, #9.9 |
| `api-commands.spec.ts` | #6.1–6.9 |
| `api-stop-run.spec.ts` | #4.4, #4.5 |
| `api-chat-channel.spec.ts` | #7.1, #7.6, #7.7 (live adapter + HTTP stub) |
| `unit-chat-parser.spec.ts` | #7.6, #7.7, #7.10 (parser unit) |
| `ui-smoke.spec.ts` | shell loads, Settings, agents list |
| `ui-stop-run.spec.ts` | #4.1, #4.2 |
| `ui-channels.spec.ts` | #5.9 |

## Deliberately not automated here

- **#8 Tray mode** and **#9 notification delivery (toasts)** — require the
  Electron host (`pnpm dev:desktop`) and native Windows toasts; out of scope for
  a headless browser run. The notification channel's *guards* (#9.8/#9.9) are
  covered via REST.
- Cross-cutting tray scenarios (§2 X.3/X.4) and OS-level cases (monitor
  disconnect, SIGTERM) from the plan's "NOT covered" section.
