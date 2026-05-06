# Database — schema, migrations

The backend uses Drizzle ORM on top of `pg` (node-postgres). Postgres is the only supported driver; there is no SQLite fallback.

## Stack

- ORM: [`drizzle-orm`](https://orm.drizzle.team/) — schema-first, lightweight, types inferred from the schema (`pg-core` dialect).
- Driver: [`pg`](https://node-postgres.com/) — pure JS, async via `pg.Pool`. No native build step.
- Connection: configured via `DB_URL` (default `postgresql://openshuki:openshuki@localhost:5432/openshuki`).

## Tables

All tables defined in `backend/src/db/schema.ts`. Timestamps are `bigint` columns storing unix milliseconds, decoded as JS `number` via `bigint({ mode: "number" })`. JSON-shaped columns are stored as `text` and JSON.stringify/parse'd at the edges (kept this way to minimize call-site churn during the SQLite→Postgres swap; revisit `jsonb` later if it matters).

| Table | Purpose | Key columns |
|---|---|---|
| `conversations` | Chat threads. | `id`, `title`, `preview`, `model` (sticky), `created_at`, `updated_at` |
| `messages` | Messages in a conversation (FK cascade). | `id`, `conversation_id`, `role`, `content`, `created_at` |
| `scheduled_tasks` | Cron-like configured runs. | `id`, `name`, `cron`, `next_run_at`, `description`, `model` |
| `agents` | User-added agents (config agents live in JSON). | `id`, `name`, `description`, `inputs_json`, `model`, `exec_json` |
| `runs` | A single agent execution. | `id`, `agent_id`, `name`, `status`, `progress`, `started_at`, `finished_at`, `error`, `inputs_json`, `model` |
| `run_events` | Every event published to the bus. | `id`, `run_id` (FK cascade), `seq`, `ts`, `type`, `node`, `payload_json` |
| `endpoints` | User-added LLM endpoints (config endpoints live in JSON). | `id`, `display_name`, `base_url`, `api_key`, `created_at`, `updated_at` |
| `artifacts` | Artifacts emitted by runs (FK cascade). | `id`, `run_id`, `seq`, `name`, `kind`, `mime`, `bytes`, `content_text`, `content_path`, `created_at` |

Indexes:

- `messages.conversation_id`
- `runs.agent_id`
- `run_events.run_id`, composite `(run_id, seq)`
- `artifacts.run_id`, composite `(run_id, seq)`

## Migration policy — idempotent DDL only

`backend/src/db/migrate.ts` runs at startup. It contains a hand-written DDL script — `CREATE TABLE IF NOT EXISTS` and `CREATE INDEX IF NOT EXISTS` for every table — wrapped in a transaction. It does *not*:

- Drop tables, columns, or indexes.
- Change column types, nullability, or defaults.
- Reorder rows or rewrite data.

Why hand-written DDL instead of drizzle-kit migrations: this scaffold runs in closed-network environments where generating migration files at deploy time is friction. The DDL script is small (~60 lines), readable, and matches the schema 1:1. If you reach the point where production migrations matter, graduate to drizzle-kit.

To add a column or table:

1. Edit `backend/src/db/schema.ts` (drives the TypeScript types).
2. Edit `backend/src/db/migrate.ts` to add the matching DDL with `IF NOT EXISTS`.
3. Restart the backend — boot prints `[db] sync complete (postgres @ host:port/db, N tables)`.

For destructive changes (drop a column, change a type, rename), apply them in `psql` directly. Then update both files to reflect the new state.

## Inferred types

Each table exports `Conversation` / `NewConversation` etc. from the schema:

```ts
export type Conversation = typeof conversations.$inferSelect;
export type NewConversation = typeof conversations.$inferInsert;
```

Use these in `store.ts` and route handlers. The route layer maps DB rows to API response shapes (e.g. unix-ms → ISO strings) — don't expose raw DB shapes through the API.

## Async everywhere

Drizzle on `pg` is async. Every store function returns `Promise<...>`. Routes are `async` handlers. The bus `publish()` is a special case — it returns the envelope synchronously (so callers like `persistArtifact` can use the assigned `seq` immediately) but enqueues the actual `INSERT INTO run_events` plus listener fan-out on a per-run promise chain. See [../backend/src/runs/bus.ts](../backend/src/runs/bus.ts) for the queue model and `flush(runId)` helper.

## Common gotchas

- **`runs.agent_id` FK has no `ON DELETE`.** Postgres enforces this strictly — deleting an agent that has run history fails the FK. The user-agent delete path in `backend/src/agents/store.ts` removes dependent runs first; downstream `run_events` and `artifacts` cascade because their FKs declare it.
- **Config agents need a shadow DB row** to satisfy `runs.agent_id`. `ensureConfigAgentShadow(id)` is idempotent (uses `INSERT … ON CONFLICT DO NOTHING`) and inserts a minimal row with the same id. The merged listing API never serves the shadow (config wins by id).
- **`run_events.seq` and `artifacts.seq` share the same per-run counter.** Artifact rows reuse the seq from their corresponding `artifact` event. Don't introduce a separate counter.
- **Mid-run process restarts are not supported.** The bus's per-run `nextSeq` counter lives in memory; restarting while a run is active and continuing to publish would collide with already-persisted rows. In practice the engine never resumes a run from the DB, so this is theoretical — but if you change that, swap the in-memory counter for a Postgres `SEQUENCE`.
- **`crypto.randomUUID()` runs in the schema's `$defaultFn`.** Drizzle calls it at insert time. If you want server-side UUIDs, switch to `gen_random_uuid()` (requires the `pgcrypto` extension).
