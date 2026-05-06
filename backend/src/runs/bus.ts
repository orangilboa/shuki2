// In-process event bus for run streaming.
//
// Responsibilities:
//   - assign monotonic `seq` per run
//   - persist every published event into `run_events`
//   - fan out to live subscribers (SSE handlers)
//   - replay missed events from DB for late subscribers
//
// We do NOT keep the full history in memory — DB is the source of truth.
// Restart is safe: nextSeq is derived from `MAX(seq)+1` lazily per run.

import { desc, eq, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { runEvents } from "../db/schema.js";
import type { RunEventEnvelope, RunEventType } from "./events.js";

type Listener = (ev: RunEventEnvelope) => void;

type RunState = {
  nextSeq: number;
  listeners: Set<Listener>;
};

// Listeners that want to see EVERY event across every run (firehose).
const firehose = new Set<Listener>();

const runs = new Map<string, RunState>();

function getOrInitState(runId: string): RunState {
  let s = runs.get(runId);
  if (s) return s;
  // Derive nextSeq from DB so process restarts pick up cleanly.
  const row = db
    .select({ maxSeq: sql<number | null>`MAX(${runEvents.seq})` })
    .from(runEvents)
    .where(eq(runEvents.runId, runId))
    .get();
  const nextSeq = (row?.maxSeq ?? 0) + 1;
  s = { nextSeq, listeners: new Set() };
  runs.set(runId, s);
  return s;
}

export type PublishInput = {
  type: RunEventType;
  node?: string | null;
  payload?: unknown;
};

export function publish(runId: string, partial: PublishInput): RunEventEnvelope {
  const state = getOrInitState(runId);
  const seq = state.nextSeq++;
  const ts = Date.now();
  const node = partial.node ?? null;
  const payload = partial.payload ?? {};

  // Persist first so a crash mid-fanout still leaves a durable record.
  db.insert(runEvents)
    .values({
      runId,
      seq,
      ts,
      type: partial.type,
      node,
      payloadJson: JSON.stringify(payload)
    })
    .run();

  const env: RunEventEnvelope = {
    runId,
    seq,
    ts,
    type: partial.type,
    node,
    payload
  };

  for (const l of state.listeners) {
    try {
      l(env);
    } catch {
      // Listener errors are isolated.
    }
  }
  for (const l of firehose) {
    try {
      l(env);
    } catch {
      // ignored
    }
  }
  return env;
}

export function subscribe(runId: string, listener: Listener): () => void {
  const state = getOrInitState(runId);
  state.listeners.add(listener);
  return () => {
    state.listeners.delete(listener);
  };
}

export function subscribeAll(listener: Listener): () => void {
  firehose.add(listener);
  return () => {
    firehose.delete(listener);
  };
}

export async function replay(runId: string): Promise<RunEventEnvelope[]> {
  const rows = db
    .select()
    .from(runEvents)
    .where(eq(runEvents.runId, runId))
    .orderBy(runEvents.seq)
    .all();

  return rows.map((r) => {
    let payload: unknown = {};
    try {
      payload = JSON.parse(r.payloadJson);
    } catch {
      payload = {};
    }
    return {
      runId: r.runId,
      seq: r.seq,
      ts: r.ts,
      type: r.type as RunEventType,
      node: r.node,
      payload
    } satisfies RunEventEnvelope;
  });
}

// Test/inspection helper — most recent event for a run, if any.
export function lastEvent(runId: string): RunEventEnvelope | null {
  const r = db
    .select()
    .from(runEvents)
    .where(eq(runEvents.runId, runId))
    .orderBy(desc(runEvents.seq))
    .limit(1)
    .get();
  if (!r) return null;
  let payload: unknown = {};
  try {
    payload = JSON.parse(r.payloadJson);
  } catch {
    payload = {};
  }
  return {
    runId: r.runId,
    seq: r.seq,
    ts: r.ts,
    type: r.type as RunEventType,
    node: r.node,
    payload
  };
}
