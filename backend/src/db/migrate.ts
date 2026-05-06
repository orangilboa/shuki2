// Idempotent startup schema sync for Postgres.
//
// We use a hand-written DDL script (instead of drizzle-kit migrations or
// drizzle introspection) because it's small, readable, and doesn't require
// generating migration files in a closed-network environment. Every statement
// is `IF NOT EXISTS` so it's safe to run on every boot — it never drops or
// rewrites. To remove a column or change a type, do it manually with psql.

import { pool, config } from "./client.js";

const DDL = `
CREATE TABLE IF NOT EXISTS conversations (
  id          text PRIMARY KEY,
  title       text NOT NULL,
  preview     text NOT NULL DEFAULT '',
  model       text,
  created_at  bigint NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint,
  updated_at  bigint NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint
);

CREATE TABLE IF NOT EXISTS messages (
  id              text PRIMARY KEY,
  conversation_id text NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role            text NOT NULL,
  content         text NOT NULL,
  created_at      bigint NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint
);
CREATE INDEX IF NOT EXISTS messages_conversation_id_idx ON messages (conversation_id);

CREATE TABLE IF NOT EXISTS scheduled_tasks (
  id           text PRIMARY KEY,
  name         text NOT NULL,
  cron         text NOT NULL,
  next_run_at  bigint NOT NULL,
  description  text NOT NULL DEFAULT '',
  model        text,
  created_at   bigint NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint
);

CREATE TABLE IF NOT EXISTS agents (
  id           text PRIMARY KEY,
  name         text NOT NULL,
  description  text NOT NULL DEFAULT '',
  inputs_json  text NOT NULL DEFAULT '[]',
  model        text,
  exec_json    text,
  created_at   bigint NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint
);

CREATE TABLE IF NOT EXISTS runs (
  id           text PRIMARY KEY,
  agent_id     text NOT NULL REFERENCES agents(id),
  name         text NOT NULL,
  status       text NOT NULL,
  progress     double precision NOT NULL DEFAULT 0,
  started_at   bigint NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint,
  finished_at  bigint,
  error        text,
  inputs_json  text,
  model        text
);
CREATE INDEX IF NOT EXISTS runs_agent_id_idx ON runs (agent_id);

CREATE TABLE IF NOT EXISTS run_events (
  id            text PRIMARY KEY,
  run_id        text NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  seq           integer NOT NULL,
  ts            bigint NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint,
  type          text NOT NULL,
  node          text,
  payload_json  text NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS run_events_run_id_idx     ON run_events (run_id);
CREATE INDEX IF NOT EXISTS run_events_run_id_seq_idx ON run_events (run_id, seq);

CREATE TABLE IF NOT EXISTS endpoints (
  id            text PRIMARY KEY,
  display_name  text NOT NULL,
  base_url      text NOT NULL,
  api_key       text,
  created_at    bigint NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint,
  updated_at    bigint NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint
);

CREATE TABLE IF NOT EXISTS artifacts (
  id            text PRIMARY KEY,
  run_id        text NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  seq           integer NOT NULL,
  name          text NOT NULL,
  kind          text NOT NULL,
  mime          text NOT NULL,
  bytes         bigint NOT NULL DEFAULT 0,
  content_text  text,
  content_path  text,
  created_at    bigint NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint
);
CREATE INDEX IF NOT EXISTS artifacts_run_id_idx     ON artifacts (run_id);
CREATE INDEX IF NOT EXISTS artifacts_run_id_seq_idx ON artifacts (run_id, seq);
`;

const TABLE_NAMES = [
  "conversations",
  "messages",
  "scheduled_tasks",
  "agents",
  "runs",
  "run_events",
  "endpoints",
  "artifacts"
];

export async function migrate(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(DDL);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  // Print a redacted version of the connection target so secrets don't leak
  // into logs but the operator can confirm which DB they're hitting.
  const target = (() => {
    try {
      const u = new URL(config.url);
      return `${u.hostname}:${u.port || "5432"}${u.pathname}`;
    } catch {
      return "(unparseable)";
    }
  })();
  console.log(`[db] sync complete (postgres @ ${target}, ${TABLE_NAMES.length} tables)`);
}
