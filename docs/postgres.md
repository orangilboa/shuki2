# Postgres — deployment quickstart

Postgres is the only supported database for openshuki. This doc covers the one-time provisioning and the env wiring; the schema lives in [db.md](db.md).

## Provision the DB and role

From a superuser psql session:

```sql
CREATE USER openshuki WITH PASSWORD 'openshuki';
CREATE DATABASE openshuki OWNER openshuki;
\connect openshuki
GRANT ALL PRIVILEGES ON SCHEMA public TO openshuki;

-- Optional: only needed if you switch to DB-side gen_random_uuid().
-- The app uses JS crypto.randomUUID() by default, so this is unnecessary today.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
```

Pick a real password before deploying anywhere shared. The default `openshuki:openshuki` is intended for local dev only.

## Env wiring

`backend/.env`:

```env
DB_URL=postgresql://openshuki:openshuki@localhost:5432/openshuki
PORT=4000
```

The backend boots, runs the idempotent DDL script (`backend/src/db/migrate.ts`), and prints `[db] sync complete (postgres @ host:port/db, 8 tables)`. If the connection fails, it exits with a stack trace — no fallback driver.

## Verify

```bash
curl http://localhost:4000/api/health
# {"ok":true}

# Run a mock agent end-to-end to exercise the run engine + run_events writes.
AGENT=$(curl -s -X POST -H 'content-type: application/json' \
  -d '{"name":"smoke","exec":{"kind":"mock"}}' \
  http://localhost:4000/api/agents)
AID=$(echo "$AGENT" | jq -r .id)
curl -s -X POST -H 'content-type: application/json' -d '{}' \
  http://localhost:4000/api/agents/$AID/run
```

## Closed-network notes

Why Postgres instead of SQLite for closed-net deploys: `better-sqlite3` requires node-gyp + node headers + a C++ toolchain. In environments with an internal-only npm registry that doesn't mirror the prebuild binaries (or where the target Node version doesn't have prebuilds), every install becomes a yak-shave. `pg` is pure JS — only one package needs to exist on the registry mirror.

If your registry doesn't carry `pg` or `@types/pg` yet, request them. They are small, dependency-light, and have stable APIs.

## Connection pool sizing

The app uses the default `pg.Pool` size (10 connections). For a single-user assistant this is overkill. If you start running many parallel agent runs that each emit thousands of events, watch for `idle in transaction` connections during heavy bursts and consider lowering the pool size to surface contention earlier.

## Backups

Standard `pg_dump` works. Artifacts are stored on disk under `backend/data/artifacts/<runId>/` — back those up alongside the DB if you care about preserving non-text artifact content.
