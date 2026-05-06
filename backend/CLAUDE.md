# Backend — agent guide

Node + Express + Drizzle + better-sqlite3, all TypeScript ESM with NodeNext modules. Hot reload via `tsx watch`.

## Layout

```
src/
  server.ts                    Composition root: dotenv, migrate, mount routers, listen.
  db/
    client.ts                  Driver-selecting client. `db` (drizzle) and `rawConn` (better-sqlite3).
    config.ts                  DB_DRIVER + DB_URL env loader.
    schema.ts                  All Drizzle table definitions + inferred Select/Insert types.
    migrate.ts                 Additive-only schema sync run on startup.
  endpoints/                   LLM-endpoint catalog (config/endpoints.json + endpoints DB table).
    config.ts                  Loads + validates config/endpoints.json.
    store.ts                   DB CRUD + merged listing.
    models.ts                  Cached aggregator over `/v1/models` from every endpoint.
  agents/                      Agent catalog (config/agents.json + agents DB table).
    config.ts                  Loads + validates config/agents.json.
    store.ts                   DB CRUD + merged listing + ensureConfigAgentShadow().
    spec.ts                    AgentInput/AgentExec validators + lenient/strict parsers.
  runs/
    events.ts                  RunEventType vocabulary + RunEventEnvelope shape.
    bus.ts                     In-process pub/sub keyed by runId, persists every event to run_events.
    engine.ts                  startRun(): publishes run_started, routes by exec.kind.
    artifacts.ts               persistArtifact(): name sanitisation, file copy, mime defaults, DB insert.
    runners/
      subprocess.ts            Spawns child, line-buffers stdout/stderr, translates JSONL → bus.
  routes/
    conversations.ts           /api/conversations CRUD + /:id/messages.
    agents.ts                  /api/agents CRUD + /:id/run dispatch + /api/scheduled, /api/running.
    runs.ts                    /api/runs list + /:id + /:id/events SSE + /:id/cancel + /api/events firehose.
    endpoints.ts               /api/endpoints CRUD + /api/models aggregator.
    artifacts.ts               /api/runs/:runId/artifacts list + /api/artifacts/:id + /:id/content.
  types/
    index.ts                   Shared API response/request types. Mirror these in frontend/src/types/.
config/
  endpoints.json               Built-in LLM endpoints, read-only via API. Keys via apiKeyEnv.
  agents.json                  Built-in agents, read-only via API. Currently weather + traffic.
data/                          Created at runtime. Holds openshuki.db and artifacts/<runId>/<file>.
```

## API surface (current)

- `GET/POST /api/conversations`, `GET/POST /api/conversations/:id`, `POST /api/conversations/:id/messages`
- `GET /api/scheduled`
- `GET/POST/PATCH/DELETE /api/agents[/:id]`, `POST /api/agents/:id/run`
- `GET /api/running`
- `GET /api/runs[?status=…]`, `GET /api/runs/:id`, `GET /api/runs/:id/events` (SSE), `POST /api/runs/:id/cancel`
- `GET /api/events` (SSE firehose across all runs)
- `GET/POST/PATCH/DELETE /api/endpoints[/:id]`
- `GET /api/models[?refresh=1]` (cached 60s aggregator)
- `GET /api/runs/:runId/artifacts`, `GET /api/artifacts/:id`, `GET /api/artifacts/:id/content`
- `GET /api/health`

## Patterns to follow

### Two-source catalogs (config file + DB)

`endpoints/` and `agents/` are the two existing instances. A new catalog should:

1. Define a JSON file at `backend/config/<thing>.json` with built-in entries.
2. Add a SQLite table for user entries with the same logical shape.
3. Write a `config.ts` to load/validate the JSON (cache it; allow `_resetCache()` for tests).
4. Write a `store.ts` exposing `listAll()` (config first, then user, sorted), `findById()`, `createUser…`, `updateUser…`, `deleteUser…`. `isConfig…(id)` returns true for config entries; the route layer returns **403 `<thing>_are_read_only`** when those are mutated.
5. Conflict policy: same id in config and DB → config wins (the route returns the config row).

The `Agent` catalog adds an extra wrinkle (`ensureConfigAgentShadow` inserts a minimal DB row for config agents so `runs.agent_id` FK resolves). Reuse this only if you have a similar FK constraint.

### Run engine + streaming

`startRun(agentId, runId, inputs, opts)` always:

1. Looks up the agent via the merged catalog (so config agents work).
2. Publishes `run_started` with `{ agentId, name, model, inputs }` — model resolution: `opts.model ?? agent.model ?? null`.
3. Routes to the runner: `subprocess` → `runSubprocess(...)`; otherwise the mock loop.

The bus's `publish(runId, partial)` assigns a monotonic per-run `seq`, persists to `run_events`, and broadcasts. Frontends subscribe via SSE; replay reads from `run_events` first, then live-tails.

If you add a new event type, update **`runs/events.ts`** AND **`runs/runners/subprocess.ts`'s `KNOWN_EVENT_TYPES` set**, AND `frontend/src/types/index.ts`. See [../docs/protocol.md](../docs/protocol.md) for the full vocabulary.

### Subprocess runner

`runners/subprocess.ts` does:
- Template expansion: `{AGENTS_DIR}` → repo's `agents/`; `{<input>}` → form value (with input-spec defaults); `${VAR}` → env var (in `env` block only).
- Windows shell-mode + arg quoting so `npx.cmd`/`tsx.cmd` shims resolve.
- Line-buffered stdout/stderr; JSONL parsing; non-JSON → `token` event; stderr → `token` with `node: "_stderr"`.
- Special handling for `artifact` events: queued through a per-run promise chain, awaited before terminal `done`.
- Abort: SIGTERM, then SIGKILL after 1s grace.

When extending, never block the main loop — copy files / heavy I/O via the artifact queue or a similar serialised path so events stay ordered.

### Adding an endpoint

1. Route file at `src/routes/<thing>.ts` exporting an Express `Router` (and any handler you mount directly).
2. Mount in `server.ts`.
3. Domain logic goes in `src/<thing>/store.ts`, not the route handler.
4. Add to `frontend/src/api/client.ts` mirror.
5. If it returns errors as JSON, use `res.status(<code>).json({ error: "<machine_readable_code>" })`. The frontend's `j<T>()` surfaces the `error` string as the thrown `Error.message`.

### Migration policy

The startup syncer in `db/migrate.ts` is **additive only**: `CREATE TABLE IF NOT EXISTS`, `ADD COLUMN`, `CREATE INDEX IF NOT EXISTS`. It does *not* alter column types/nullability/defaults, and it doesn't drop anything. One small exception: a one-time pre-sync RENAME shim handles the `tools` table → `agents` and `runs.tool_id` → `runs.agent_id` rename for existing DBs. Rationale: SQLite's `ALTER COLUMN` story is bad, and we want zero-friction startup. If you need to change a column, do it manually or recreate the DB. See [../docs/db.md](../docs/db.md) for the planned postgres migration story.

## Constraints

- Strict TS, no `any` in public surfaces (route responses, exported functions).
- Native modules only (`better-sqlite3` is the heaviest dep). Don't add ORMs, query builders, or HTTP clients beyond what's there.
- Routes never `throw` — always respond with the right status code. The engine writes terminal state to `runs` itself; routes don't need to await.

## Common gotchas

- Backend cwd matters: `tsx watch src/server.ts` runs with `cwd=backend/`. The subprocess runner resolves `{AGENTS_DIR}` as `path.resolve(process.cwd(), "..", "agents")` — do not break this assumption.
- `run_events.seq` and `artifacts.seq` are tied: artifacts use the bus-assigned seq from the same per-run counter so artifact events and rows share the same ordinal.
- `runs.agent_id` is a FK to `agents.id` with no `ON DELETE`. Deleting a user agent that has run history requires deleting the runs first; that's what `deleteUserAgent` does. Don't add raw `DELETE FROM agents` calls.
