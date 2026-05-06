// Typed event envelope for run streaming.
// Wire format used by both the in-process bus and the SSE endpoints.

export type RunEventType =
  | "run_started"
  | "node_start"
  | "node_end"
  | "token"
  | "tool_call"
  | "tool_result"
  | "custom"
  | "error"
  | "done"
  | "artifact";

export type RunEventEnvelope<P = unknown> = {
  runId: string;
  seq: number; // monotonic per run
  ts: number; // unix ms
  type: RunEventType;
  node: string | null;
  payload: P;
};
