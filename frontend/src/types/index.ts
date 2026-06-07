// Shared API types live once in openshuki-shared and are re-exported here so
// the frontend can't drift from the backend's REST surface. Only UI-only
// shapes (view routing, frontend-rendered event payloads) are defined locally.

export * from "openshuki-shared";

import type { ArtifactKind } from "openshuki-shared";

// ---------- UI-only view routing -----------------------------------------

export type LeftTab = "chats" | "scheduled" | "agents";

export type CenterView =
  | { kind: "new-chat" }
  | { kind: "conversation"; conversationId: string }
  | { kind: "agent"; agentId: string }
  | { kind: "scheduled"; taskId: string }
  | { kind: "run"; runId: string }
  | { kind: "settings" };

// ---------- frontend-rendered event payloads -----------------------------

export type ArtifactEventPayload = {
  artifactId: string;
  name: string;
  kind: ArtifactKind;
  mime: string;
  bytes: number;
  hasInlineContent: boolean;
};

/**
 * Emitted by an agent when it begins a blocking LLM call. The frontend
 * renders a live elapsed-seconds counter between this event and the matching
 * `done_waiting`. Pair by `waitId` if present; otherwise the FE pairs by
 * `node` (most-recent unpaired wait on the same node wins).
 */
export type WaitingForLLMEventPayload = {
  waitId?: string;
  label?: string;
  model?: string;
};

export type DoneWaitingEventPayload = {
  waitId?: string;
  durationMs?: number;
  ok?: boolean;
};
