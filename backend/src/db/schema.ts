// Drizzle schema (Postgres).
// Timestamps are unix-ms (`bigint`) so the wire shape matches the existing
// API contract; revisit `timestamptz` later if timezone semantics matter.
// JSON-shaped columns stay as `text` (we JSON.stringify/parse at the edges)
// to keep call-site churn minimal during the SQLite→Postgres swap.

import { sql } from "drizzle-orm";
import {
  pgTable,
  text,
  bigint,
  integer,
  doublePrecision,
  index
} from "drizzle-orm/pg-core";

// Postgres expression for "now in unix milliseconds".
const nowMs = sql`(EXTRACT(EPOCH FROM NOW()) * 1000)::bigint`;

// `bigint({ mode: "number" })` returns a JS `number` (not bigint). Safe for
// timestamps and seq counters until 2^53 ms ≈ year 287396.
const bigintN = (name: string) => bigint(name, { mode: "number" });

// ---------- conversations -------------------------------------------------

export const conversations = pgTable("conversations", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  title: text("title").notNull(),
  preview: text("preview").notNull().default(""),
  // Sticky last-used model for this conversation, format "<endpointId>::<modelId>".
  model: text("model"),
  createdAt: bigintN("created_at").notNull().default(nowMs),
  updatedAt: bigintN("updated_at").notNull().default(nowMs)
});

export type Conversation = typeof conversations.$inferSelect;
export type NewConversation = typeof conversations.$inferInsert;

// ---------- messages ------------------------------------------------------

export const messages = pgTable(
  "messages",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["user", "assistant", "system"] }).notNull(),
    content: text("content").notNull(),
    createdAt: bigintN("created_at").notNull().default(nowMs)
  },
  (t) => ({
    convIdx: index("messages_conversation_id_idx").on(t.conversationId)
  })
);

export type Message = typeof messages.$inferSelect;
export type NewMessage = typeof messages.$inferInsert;

// ---------- scheduled_tasks ----------------------------------------------

export const scheduledTasks = pgTable("scheduled_tasks", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  name: text("name").notNull(),
  cron: text("cron").notNull(),
  nextRunAt: bigintN("next_run_at").notNull(),
  description: text("description").notNull().default(""),
  // per-task model override (e.g. "claude-opus-4-7")
  model: text("model"),
  createdAt: bigintN("created_at").notNull().default(nowMs)
});

export type ScheduledTask = typeof scheduledTasks.$inferSelect;
export type NewScheduledTask = typeof scheduledTasks.$inferInsert;

// ---------- agents --------------------------------------------------------

export const agents = pgTable("agents", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  // JSON-encoded AgentInput[] (also accepts legacy string[] for backward compat).
  // Parsed/normalized at the API edge.
  inputsJson: text("inputs_json").notNull().default("[]"),
  // per-agent model override
  model: text("model"),
  // JSON-encoded AgentExec; null is treated as { kind: "mock" }.
  execJson: text("exec_json"),
  createdAt: bigintN("created_at").notNull().default(nowMs)
});

export type Agent = typeof agents.$inferSelect;
export type NewAgent = typeof agents.$inferInsert;

// ---------- runs ----------------------------------------------------------

export const runs = pgTable(
  "runs",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id),
    name: text("name").notNull(),
    status: text("status", {
      enum: ["queued", "running", "succeeded", "failed"]
    }).notNull(),
    progress: doublePrecision("progress").notNull().default(0),
    startedAt: bigintN("started_at").notNull().default(nowMs),
    finishedAt: bigintN("finished_at"),
    error: text("error"),
    inputsJson: text("inputs_json"),
    // Resolved model used for this run (format "<endpointId>::<modelId>").
    // Falls back to the agent's configured model when not provided per-run.
    model: text("model")
  },
  (t) => ({
    agentIdx: index("runs_agent_id_idx").on(t.agentId)
  })
);

export type Run = typeof runs.$inferSelect;
export type NewRun = typeof runs.$inferInsert;

// ---------- run_events ----------------------------------------------------

// Expected `type` values:
//   run_started | node_start | node_end | token | tool_call | tool_result
//   | custom    | error      | done      | artifact
export const runEvents = pgTable(
  "run_events",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    // monotonic per run; combined with run_id as a composite index for
    // ordered streaming reads.
    seq: integer("seq").notNull(),
    ts: bigintN("ts").notNull().default(nowMs),
    type: text("type").notNull(),
    node: text("node"),
    payloadJson: text("payload_json").notNull().default("{}")
  },
  (t) => ({
    runIdx: index("run_events_run_id_idx").on(t.runId),
    runSeqIdx: index("run_events_run_id_seq_idx").on(t.runId, t.seq)
  })
);

export type RunEvent = typeof runEvents.$inferSelect;
export type NewRunEvent = typeof runEvents.$inferInsert;

// ---------- endpoints -----------------------------------------------------

// User-added LLM endpoints. Built-in endpoints live in config/endpoints.json
// and are merged at the API edge (see src/endpoints/store.ts).
//
// SECURITY: api_key is stored plaintext for this local scaffold.
// Encrypt at rest before shipping a multi-user build.
export const endpoints = pgTable("endpoints", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  displayName: text("display_name").notNull(),
  baseUrl: text("base_url").notNull(),
  apiKey: text("api_key"),
  createdAt: bigintN("created_at").notNull().default(nowMs),
  updatedAt: bigintN("updated_at").notNull().default(nowMs)
});

export type Endpoint = typeof endpoints.$inferSelect;
export type NewEndpoint = typeof endpoints.$inferInsert;

// ---------- artifacts -----------------------------------------------------

// Agent-emitted artifacts attached to a run. Either inline (`content_text`)
// for text-ish kinds (md, text) or file-backed (`content_path`) for binaries
// (image, audio, video). `seq` shares the same monotonic counter used for
// run_events, so artifact and event ordering interleave deterministically.
export const artifacts = pgTable(
  "artifacts",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    name: text("name").notNull(),
    // 'md' | 'text' | 'image' | 'audio' | 'video'
    kind: text("kind").notNull(),
    mime: text("mime").notNull(),
    bytes: bigintN("bytes").notNull().default(0),
    contentText: text("content_text"),
    // path relative to <backend>/data/artifacts/
    contentPath: text("content_path"),
    createdAt: bigintN("created_at").notNull().default(nowMs)
  },
  (t) => ({
    runIdx: index("artifacts_run_id_idx").on(t.runId),
    runSeqIdx: index("artifacts_run_id_seq_idx").on(t.runId, t.seq)
  })
);

export type Artifact = typeof artifacts.$inferSelect;
export type NewArtifact = typeof artifacts.$inferInsert;

// ---------- agent_interactions ------------------------------------------

// A question the agent asked the user mid-run, plus the answer once given.
// Lifecycle: created with status='pending'; transitions to 'answered' when
// the user submits a response, or 'cancelled' if the run/process exits first.
// `choices_json` is the optional list of suggested answers (UI may render
// these as radios) — text-free-form answer is always allowed.
export const agentInteractions = pgTable(
  "agent_interactions",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    prompt: text("prompt").notNull(),
    choicesJson: text("choices_json"),
    status: text("status", {
      enum: ["pending", "answered", "cancelled"]
    }).notNull(),
    answer: text("answer"),
    createdAt: bigintN("created_at").notNull().default(nowMs),
    answeredAt: bigintN("answered_at")
  },
  (t) => ({
    runIdx: index("agent_interactions_run_id_idx").on(t.runId),
    runStatusIdx: index("agent_interactions_run_id_status_idx").on(
      t.runId,
      t.status
    )
  })
);

export type AgentInteractionRow = typeof agentInteractions.$inferSelect;
export type NewAgentInteractionRow = typeof agentInteractions.$inferInsert;
