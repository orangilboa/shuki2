// Typed event envelope for run streaming. Wire format used by the backend's
// in-process bus + SSE endpoints and by the frontend store. Defined once here
// and re-exported from backend/src/runs/events.ts and frontend/src/types so
// the vocabulary can't drift between the two surfaces.

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
  | "artifact"
  // Agent ↔ user Q&A. The agent emits `ask_user` to request input and the
  // backend emits `user_response` once the user has answered. The matching
  // identifier on both is `payload.interactionId`.
  | "ask_user"
  | "user_response"
  // LLM wait signal. The agent emits `waiting_for_llm` before a blocking LLM
  // call and `done_waiting` once the response arrives. The UI renders a live
  // elapsed-seconds counter between the two. Pure UI signals — no DB side
  // effect. Pair by `payload.waitId` when present; otherwise the FE pairs by
  // `node` (most-recent unpaired wait wins).
  | "waiting_for_llm"
  | "done_waiting";

export type RunEventEnvelope<P = unknown> = {
  runId: string;
  seq: number; // monotonic per run
  ts: number; // unix ms
  type: RunEventType;
  node: string | null;
  payload: P;
};
