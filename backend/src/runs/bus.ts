// In-process event bus for run streaming.
//
// Responsibilities:
//   - assign monotonic `seq` per run (synchronous in-memory counter)
//   - persist every published event into `run_events` (async, serialised)
//   - fan out to live subscribers (SSE handlers)
//   - replay missed events from DB for late subscribers
//
// Concurrency model:
//   `publish()` is synchronous from the caller's perspective: it stamps `seq`
//   from an in-memory counter, builds the envelope, and returns it. The
//   actual DB insert and listener fan-out are chained on a per-run promise
//   (`writeQueue`), so events land in seq order even though pg writes are
//   async. Callers that need to know all events have been persisted (the
//   subprocess runner before emitting terminal `done`) call `await flush(id)`.
//
// Restart-mid-run is unsupported: if the process dies while a run is active,
// the in-memory `nextSeq` counter resets to 1 on the next process and would
// collide with already-persisted rows. In practice runs are launched and
// observed within one process lifetime; the engine never resumes a run from
// the DB. If you need restart-resilience, swap this for a Postgres SEQUENCE.

import { desc, eq } from "drizzle-orm";
import { db } from "../db/client.js";
import { runEvents } from "../db/schema.js";
import type { RunEventEnvelope, RunEventType } from "./events.js";

type Listener = (ev: RunEventEnvelope) => void;

type RunState = {
  nextSeq: number;
  listeners: Set<Listener>;
  writeQueue: Promise<void>;
};

// Listeners that want to see EVERY event across every run (firehose).
const firehose = new Set<Listener>();

const runs = new Map<string, RunState>();

function getOrInitState(runId: string): RunState {
  let s = runs.get(runId);
  if (s) return s;
  s = { nextSeq: 1, listeners: new Set(), writeQueue: Promise.resolve() };
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
  const type = partial.type;

  const env: RunEventEnvelope = { runId, seq, ts, type, node, payload };

  // Chain persist + fan-out on the per-run write queue. This serialises
  // inserts and ensures listeners see events in seq order. If a write fails
  // we still fan out so SSE consumers don't stall — DB and live stream may
  // briefly disagree, which is acceptable for our scaffold.
  state.writeQueue = state.writeQueue.then(async () => {
    try {
      await db.insert(runEvents).values({
        runId,
        seq,
        ts,
        type,
        node,
        payloadJson: JSON.stringify(payload)
      });
    } catch (err) {
      console.error(
        `[bus] failed to persist run_event seq=${seq} run=${runId}:`,
        err instanceof Error ? err.message : err
      );
    }
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
  });

  return env;
}

/**
 * Wait until every event published for `runId` so far has been persisted and
 * fanned out. Used by the subprocess runner before emitting terminal events.
 */
export async function flush(runId: string): Promise<void> {
  const s = runs.get(runId);
  if (!s) return;
  await s.writeQueue;
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
  const rows = await db
    .select()
    .from(runEvents)
    .where(eq(runEvents.runId, runId))
    .orderBy(runEvents.seq);

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
export async function lastEvent(runId: string): Promise<RunEventEnvelope | null> {
  const rows = await db
    .select()
    .from(runEvents)
    .where(eq(runEvents.runId, runId))
    .orderBy(desc(runEvents.seq))
    .limit(1);
  const r = rows[0];
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
