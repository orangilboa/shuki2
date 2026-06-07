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

CREATE TABLE IF NOT EXISTS agent_config (
  agent_id     text PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
  config_json  text NOT NULL DEFAULT '{}',
  created_at   bigint NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint,
  updated_at   bigint NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint
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

CREATE TABLE IF NOT EXISTS agent_interactions (
  id            text PRIMARY KEY,
  run_id        text NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  prompt        text NOT NULL,
  choices_json  text,
  status        text NOT NULL,
  answer        text,
  created_at    bigint NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint,
  answered_at   bigint
);
CREATE INDEX IF NOT EXISTS agent_interactions_run_id_idx        ON agent_interactions (run_id);
CREATE INDEX IF NOT EXISTS agent_interactions_run_id_status_idx ON agent_interactions (run_id, status);

CREATE TABLE IF NOT EXISTS channels (
  id                  text PRIMARY KEY,
  name                text NOT NULL,
  kind                text NOT NULL,
  direction           text NOT NULL,
  enabled             text NOT NULL DEFAULT 'false',
  filter_json         text NOT NULL DEFAULT '{}',
  inbound_json        text NOT NULL DEFAULT '{}',
  adapter_config_json text NOT NULL DEFAULT '{}',
  created_at          bigint NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint,
  updated_at          bigint NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint
);

CREATE TABLE IF NOT EXISTS channel_messages (
  id              text PRIMARY KEY,
  channel_id      text NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  direction       text NOT NULL,
  kind            text NOT NULL,
  payload_json    text NOT NULL DEFAULT '{}',
  correlation_id  text,
  created_at      bigint NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::bigint
);
CREATE INDEX IF NOT EXISTS channel_messages_channel_id_idx            ON channel_messages (channel_id);
CREATE INDEX IF NOT EXISTS channel_messages_channel_id_created_at_idx ON channel_messages (channel_id, created_at);
`;

const TABLE_NAMES = [
  "conversations",
  "messages",
  "scheduled_tasks",
  "agents",
  "agent_config",
  "runs",
  "run_events",
  "endpoints",
  "artifacts",
  "agent_interactions",
  "channels",
  "channel_messages"
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
