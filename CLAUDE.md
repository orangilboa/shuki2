# openshuki — agent guide

A personal-assistant scaffold: an Express/Postgres backend, a React/Zustand frontend, and a folder of subprocess agents (LangGraph flows, mostly). The backend streams typed run events over SSE; the frontend renders chats, agent runs, and artifacts.

## Top-level layout

```
backend/        Node + Express + Drizzle + Postgres (`pg`). API + run engine + SSE.
frontend/       Vite + React + TypeScript + Zustand. Three-panel UI.
agents/         User-runnable agents (Python or TS). Each exits with structured JSONL on stdout.
docs/           Reference docs that don't auto-load — read on demand. See "Where to look", below.
data/           (Inside backend/) Copied artifact files. Created at runtime.
```

## How docs are organised

Claude Code auto-loads any file named exactly `CLAUDE.md` in the cwd and parent directories, and additionally loads nested `CLAUDE.md` files in subdirectories the agent enters during a session. This repo uses that:

- **This file** — top-level orientation. Always loaded.
- [backend/CLAUDE.md](backend/CLAUDE.md) — backend stack, layout, conventions, where each thing lives.
- [frontend/CLAUDE.md](frontend/CLAUDE.md) — frontend stack, layout, store + view conventions.
- [agents/CLAUDE.md](agents/CLAUDE.md) — how to author a new agent. The most useful doc for "add a feature that runs an agent".

Other markdown files are *not* auto-loaded. The doc set under `docs/` is referenced from the CLAUDE.md files where relevant — read them on demand:

**References** (read when changing the related layer):

- [docs/protocol.md](docs/protocol.md) — the run-event vocabulary and artifact protocol. Critical for any change that touches the streaming layer or agent authoring.
- [docs/db.md](docs/db.md) — schema overview, idempotent-DDL migration policy.

**How-tos** (read when doing a specific task):

- [docs/connect-llms.md](docs/connect-llms.md) — wire a new LLM provider (built-in or user-added) and how models flow through chats and agent runs.
- [docs/postgres.md](docs/postgres.md) — Postgres deployment quickstart (DB + role provisioning).
- [docs/agent-python.md](docs/agent-python.md) — author a new Python agent (LangGraph + JSONL protocol).
- [docs/agent-typescript.md](docs/agent-typescript.md) — author a new TypeScript agent (`@langchain/langgraph` + JSONL protocol).

> **If you want a future Claude session to find a doc**: either rename it to `CLAUDE.md` in the relevant directory (auto-loaded) or link to it from one of the existing CLAUDE.md files. There is no other naming convention that triggers auto-discovery.

## Running it

Three terminals, one per layer:

The repo is a pnpm workspace. Install once at the root:

```bash
pnpm install
```

Then either run everything together or each layer in its own terminal:

```bash
# both backend (4000) and frontend (5173)
pnpm dev

# or individually
pnpm dev:backend
pnpm dev:frontend

# agents — Python deps only (TS deps come from the workspace install above)
pnpm --filter agents exec pip install -r requirements.txt
```

Backend needs Postgres reachable at `DB_URL` (defaults to `postgresql://openshuki:openshuki@localhost:5432/openshuki`). See [docs/postgres.md](docs/postgres.md) for one-time DB + role provisioning. The backend runs an idempotent DDL script on every boot — adding a new table is a `CREATE TABLE IF NOT EXISTS` in `backend/src/db/migrate.ts` plus the matching Drizzle definition in `schema.ts`.

## What the system does, end-to-end

1. User picks an agent in the left panel → `AgentView` renders a form from the agent's `inputs` spec, plus a model picker.
2. Submit → `POST /api/agents/:id/run`. The engine inserts a `runs` row, then routes by `agent.exec.kind`:
   - `mock` → in-process simulated graph.
   - `subprocess` → spawn a child process with templated args, line-buffer stdout/stderr, translate JSONL events into the run-event bus.
3. Events flow into the bus, which persists every event to `run_events` and broadcasts to SSE subscribers (per-run `/api/runs/:id/events` and global `/api/events`).
4. The frontend store ingests the firehose and updates the right panel (live progress) and the central run view (logs + artifacts tabs).
5. Agents can emit `artifact` events; the runner persists them (text inline or file copy) and serves their content via `/api/artifacts/:id/content`.

The protocol details for steps 2–5 live in [docs/protocol.md](docs/protocol.md).

## Cross-cutting conventions

- **Two-source pattern for catalog data** (LLM endpoints, agents): a JSON config file under `backend/config/` provides built-in entries that are read-only via the API; a DB table holds user-added entries with full CRUD. The merged listing tags each entry with `source: "config" | "user"`. See `backend/src/endpoints/` and `backend/src/agents/` for the two existing instances.
- **Event sourcing for runs**: every UI-visible state change for a run is persisted as a `run_events` row with monotonic `seq`. SSE replay reads from this table first, then live-tails. This means a frontend can resume a run mid-flight without losing events.
- **Postgres-only DB**: schema is `drizzle-orm/pg-core`; runtime uses `pg.Pool` + `drizzle-orm/node-postgres`. App code only depends on the Drizzle abstraction (no raw SQL outside `backend/src/db/migrate.ts`). See [docs/db.md](docs/db.md).
- **TypeScript strict everywhere**, no `any` in public API surfaces. ESM, NodeNext modules. agents/ uses `tsx` to run TS directly without a build step.
- **No CSS framework**. Tokens live in `frontend/src/styles.css`; reuse `--bg`, `--bg-2`, `--bg-3`, `--border`, `--text`, `--text-dim`, `--accent`, `--danger`.

## When making changes

- New endpoint? Add a route file under `backend/src/routes/`, mount in `server.ts`, add typed methods to `frontend/src/api/client.ts`. Don't put domain logic in the route handler — extract to `backend/src/<domain>/store.ts` like the existing `endpoints/` and `agents/` modules.
- New agent? Read [agents/CLAUDE.md](agents/CLAUDE.md). Don't add ad-hoc protocols; emit our JSONL events.
- New event type? Update `RunEventType` in *both* `backend/src/runs/events.ts` and `frontend/src/types/index.ts`, plus the agent-side helper unions in `agents/agent_util.py` / `agents/agent_util.ts`. Document the payload shape in `docs/protocol.md`.
- Schema change? Edit `backend/src/db/schema.ts` AND mirror the change in the hand-written DDL in `backend/src/db/migrate.ts` (the schema file is the type source; the DDL is what actually runs). Use `IF NOT EXISTS` everywhere so the script stays idempotent. Destructive changes (drop column, change type) — apply them by hand with `psql`.
