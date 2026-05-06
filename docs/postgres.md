# Switching openshuki to Postgres

The backend is built driver-pluggable. SQLite is the default; Postgres is supported as a config + driver swap, with no app-code changes outside `backend/src/db/`. This doc walks the whole migration.

> **Status today**: the SQLite path is fully implemented; the Postgres branch in `backend/src/db/client.ts` throws `not_implemented`. This doc is the recipe for filling that branch in.

## What changes vs. SQLite

| Concern | SQLite (today) | Postgres (after) |
|---|---|---|
| Driver | `better-sqlite3` (sync) | `pg` (async pool) |
| Drizzle import | `drizzle-orm/better-sqlite3` | `drizzle-orm/node-postgres` |
| Schema dialect | `drizzle-orm/sqlite-core` | `drizzle-orm/pg-core` |
| Timestamp columns | `integer` (unix ms) | `bigint` (unix ms) or `timestamptz` |
| UUID generation | JS `$defaultFn(crypto.randomUUID)` | DB-side `gen_random_uuid()` (or keep JS) |
| Booleans | none (use `integer`) | `boolean` |
| JSON columns | `text` (we JSON.stringify) | `jsonb` (native) |
| Migrations | additive runtime syncer | drizzle-kit migrations or stay additive |
| Query builder calls | `.all()`, `.get()`, `.run()` | `await` everywhere |

The async-vs-sync change is the most invasive — every call site that uses `.all() / .get() / .run()` becomes `await db.select().…`. Plan the work in two passes: first introduce Postgres alongside SQLite, then flip all call sites to async.

## Step-by-step

### 1. Install Postgres deps

```bash
cd backend
npm i pg
npm i -D @types/pg
```

`drizzle-orm` is already installed.

### 2. Add a Postgres schema file

Create `backend/src/db/schema.pg.ts`. Mirror every table from `schema.ts` using `drizzle-orm/pg-core`. Type translations:

| sqlite-core | pg-core |
|---|---|
| `text("col")` | `text("col")` |
| `integer("col")` (timestamps) | `bigint("col", { mode: "number" })` — keep unix-ms semantics for now |
| `integer("col")` (counters) | `integer("col")` |
| `real("col")` | `doublePrecision("col")` |
| `text("col", { enum: [...] })` | `text("col", { enum: [...] })` (or a real `pgEnum`) |
| `index("...").on(...)` | same |

Decisions to make:

- **Stick with unix-ms or move to `timestamptz`?** Stick with unix-ms for the swap; revisit timezone semantics later. Same column types end-to-end means the Postgres `Run` row is byte-identical to the SQLite one.
- **`jsonb` for `*_json` columns?** Yes — declare them `jsonb()` and remove the JSON.stringify/parse at the route layer. Or leave as text initially to keep the swap minimal.

Export the same `Conversation` / `NewConversation` / etc. type aliases from this file.

### 3. Implement the Postgres branch in `client.ts`

Replace the `not_implemented` stub with:

```ts
import { Pool } from "pg";
import { drizzle as drizzlePg, type NodePgDatabase } from "drizzle-orm/node-postgres";
import * as pgSchema from "./schema.pg.js";

function buildPostgres(cfg: DbConfig): { db: PgDb; rawConn: Pool } {
  const pool = new Pool({ connectionString: cfg.url });
  const db = drizzlePg(pool, { schema: pgSchema });
  return { db, rawConn: pool };
}
```

Add a `PgDb` type alias (`NodePgDatabase<typeof pgSchema>`). The `Db` type union becomes `BetterSQLite3Database<typeof schema> | NodePgDatabase<typeof pgSchema>`. Most call sites won't notice — Drizzle's query builder API is identical between drivers.

### 4. Switch `migrate.ts` to Postgres-aware

The current `migrate.ts` uses sqlite-core's `getTableConfig` and `PRAGMA table_info`. For Postgres:

- Use `pg-core`'s `getTableConfig` to get the desired schema.
- Use `information_schema.columns` instead of `PRAGMA table_info` for the diff.
- DDL strings switch to standard SQL (`ALTER TABLE … ADD COLUMN`, `CREATE INDEX IF NOT EXISTS`).

Or graduate to **drizzle-kit migrations**: write `drizzle.config.ts`, run `drizzle-kit generate` to produce SQL files in `backend/migrations/`, and apply them with `drizzle-kit migrate` on startup. drizzle-kit handles cross-driver. This is the recommended long-term path; the additive runtime syncer made sense for the SQLite scaffold but won't scale to multi-environment Postgres.

### 5. Convert sync call sites to async

Find every `.all()`, `.get()`, `.run()` and `await` it. Tools:

```bash
# from backend/
grep -rEn "\\.(all|get|run)\\(\\)" src
```

You'll touch every `routes/*.ts` and `*/store.ts`. For each:

- Route handler → mark `async (req, res) =>`, `await` every Drizzle call.
- Store function → `async`, `await`s, return type is `Promise<X>`.
- Engine code → `runs/engine.ts`, `runs/runners/subprocess.ts`, `runs/bus.ts`, `runs/artifacts.ts` — these already mix async; just await the Drizzle calls.

`bus.publish` currently writes synchronously; with Postgres it becomes async. The publish flow already returns the envelope, so wrapping in `await` works; just update callers.

### 6. Configure env

`backend/.env`:

```env
DB_DRIVER=postgres
DB_URL=postgresql://openshuki:openshuki@localhost:5432/openshuki
```

`backend/src/db/config.ts` already reads these — no change needed.

### 7. Boot, migrate, smoke test

```bash
# create db
createdb openshuki
psql openshuki -c "CREATE EXTENSION IF NOT EXISTS pgcrypto;"  # if you want gen_random_uuid()

# start backend
cd backend && npm run dev
# expect: [db] sync complete (postgres, 8 tables)

# health
curl localhost:4000/api/health

# end-to-end
curl -X POST localhost:4000/api/agents/weather/run \
  -H 'content-type: application/json' \
  -d '{"inputs":{"location":"Paris","days":2}}'
```

## Data migration from SQLite

If you've accumulated data in SQLite and want to bring it across:

1. Stop the backend.
2. Dump SQLite as SQL: `sqlite3 backend/data/openshuki.db .dump > dump.sql`. Edit by hand (SQLite dialect → Postgres) — or use `pgloader`:

   ```bash
   pgloader backend/data/openshuki.db postgresql://localhost/openshuki
   ```

   pgloader handles type coercion automatically. Run it, then verify counts match.
3. Reset all sequences if pgloader didn't (it usually does for `serial`-style columns; we use UUID PKs so this is mostly moot).
4. Boot the backend with `DB_DRIVER=postgres` and confirm the UI works.

## Things to validate post-swap

- **`runs.agent_id` FK with no `ON DELETE`** — Postgres enforces this strictly; make sure `agents/store.ts:deleteUserAgent` still pre-deletes runs.
- **`config agent` shadow rows** — `ensureConfigAgentShadow` uses `INSERT … ON CONFLICT DO NOTHING` shape; in Postgres that's `INSERT … ON CONFLICT (id) DO NOTHING`. Update the Drizzle call accordingly.
- **`run_events` write throughput** — every published event is a row insert. With Postgres, batch where possible; the bus is one publish per event today which is fine for tens of events per run but not thousands per second. If you push real LangGraph token streams, consider buffering writes or using a separate event store.
- **Concurrent connections** — better-sqlite3 is single-process; Postgres is happy with a connection pool. The default `pg.Pool` size of 10 is plenty for this app.

## Rolling back

`DB_DRIVER=sqlite` puts you back on SQLite. Both schema files keep working in parallel — schema.ts and schema.pg.ts. There's no destructive change to either DB.

## When to actually do this

Don't switch unless you're shipping past local dev. SQLite is faster, simpler, and sufficient for a single-user assistant. The right trigger is: deploying behind a server with multi-user state, or wanting durable backups, or scaling beyond a single machine.
