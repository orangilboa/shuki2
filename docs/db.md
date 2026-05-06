# Database — schema, migrations, driver-pluggable design

The backend uses Drizzle ORM with `better-sqlite3` today. Everything is shaped to be portable to Postgres later via a driver swap and a parallel `pg-core` schema file.

## Stack

- ORM: [`drizzle-orm`](https://orm.drizzle.team/) — schema-first, lightweight, types inferred from the schema.
- Driver: [`better-sqlite3`](https://github.com/WiseLibs/better-sqlite3) — sync API, fast, single-file. WAL is enabled.
- File: `backend/data/openshuki.db` (created at runtime, gitignored).

## Tables

All tables defined in `backend/src/db/schema.ts`. Timestamps are `integer` columns storing unix milliseconds (portable to Postgres `bigint` or `timestamptz` later — the conversion is a one-time backfill).

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

## Migration policy — additive only

`backend/src/db/migrate.ts` runs at startup. It:

- Creates missing tables (`CREATE TABLE IF NOT EXISTS` from Drizzle's `getTableConfig`).
- Adds missing columns (`PRAGMA table_info` diff → `ALTER TABLE … ADD COLUMN`).
- Creates missing indexes (`CREATE INDEX IF NOT EXISTS`).

It does *not*:

- Drop columns, indexes, or tables.
- Change column types, nullability, or defaults.
- Reorder rows, recompute generated values, or rewrite data.

Why additive only: SQLite's `ALTER COLUMN` story is poor (you'd need a full table rebuild), and the extra surface isn't worth the risk for a local-dev scaffold. If you really need a destructive change, do it manually (`sqlite3 data/openshuki.db ".dump" | …`) or delete the DB.

The boot log line `[db] sync complete (sqlite, N tables)` is the visible signal that migration ran. `N` should match the count in this doc — if it doesn't, something didn't load.

## Inferred types

Each table exports `Conversation` / `NewConversation` etc. from the schema:

```ts
export type Conversation = typeof conversations.$inferSelect;
export type NewConversation = typeof conversations.$inferInsert;
```

Use these in `store.ts` and route handlers. The route layer maps DB rows to API response shapes (e.g. unix-ms → ISO strings) — don't expose raw DB shapes through the API.

## Driver-pluggable design

The selection happens in `backend/src/db/client.ts`:

```ts
switch (config.driver) {
  case "sqlite":   return buildSqlite(cfg);
  case "postgres": throw new Error("not_implemented");
}
```

To add Postgres:

1. Install `drizzle-orm/node-postgres` + `pg`.
2. Add a parallel `schema.pg.ts` using `drizzle-orm/pg-core` (or unify via a shared schema-builder if the columns line up — they will, with `bigint` for unix-ms or a one-shot conversion to `timestamptz`).
3. Implement the `postgres` branch in `buildPostgres()` returning the same `{ db, rawConn }` shape.
4. Wire env: `DB_DRIVER=postgres`, `DB_URL=postgres://…`.
5. Port `migrate.ts` — Postgres has real ALTERs, so the additive-only constraint can relax (or graduate to drizzle-kit migrations).

The rest of the app code (`store.ts` files, runners, routes) doesn't change — they only see Drizzle's typed query builder.

For a step-by-step walkthrough see [postgres.md](postgres.md).

## Common gotchas

- **`runs.agent_id` FK has no `ON DELETE`.** Deleting an agent that has run history fails the FK. The user-agent delete path in `backend/src/agents/store.ts` removes dependent runs first; downstream `run_events` and `artifacts` cascade because their FKs declare it.
- **Config agents need a shadow DB row** to satisfy `runs.agent_id`. `ensureConfigAgentShadow(id)` is idempotent and inserts a minimal row with the same id. The merged listing API never serves the shadow (config wins by id).
- **`run_events.seq` and `artifacts.seq` share the same per-run counter.** Artifact rows reuse the seq from their corresponding `artifact` event. Don't introduce a separate counter.
- **WAL mode is on.** This means there are `openshuki.db-wal` and `openshuki.db-shm` files alongside the main DB. Don't `rm` only the `.db` and expect a clean state — wipe all three or run `rawConn.exec("PRAGMA wal_checkpoint(TRUNCATE)")` first.
- **`crypto.randomUUID()` runs in the schema's `$defaultFn`.** Drizzle calls it at insert time, not at migration time. Postgres can do this server-side with `gen_random_uuid()` once you switch.
