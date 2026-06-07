// Shared channel types used by both the backend (REST surface) and the
// frontend (typed API client + UI). Keep this file dependency-free so it can
// be imported by either runtime without pulling in node- or DOM-specific code.

export type ChannelDirection = "in_out" | "out_only" | "in_only";

export type ChannelSource = "config" | "user";

// Categories collapse the long RunEventType list into bucket-level filtering
// so users configure intent ("notify me on errors"), not raw event types.
export type ChannelEventCategory =
  | "run.lifecycle" // run_started, done
  | "run.progress" // node_start, node_end
  | "run.logs" // token, custom
  | "run.tools" // tool_call, tool_result
  | "run.artifacts" // artifact
  | "run.interactions" // ask_user, user_response
  | "run.errors" // error
  | "run.llm_wait"; // waiting_for_llm, done_waiting

export const CHANNEL_EVENT_CATEGORIES: ChannelEventCategory[] = [
  "run.lifecycle",
  "run.progress",
  "run.logs",
  "run.tools",
  "run.artifacts",
  "run.interactions",
  "run.errors",
  "run.llm_wait"
];

export type ChannelFilter = {
  eventCategories: ChannelEventCategory[];
  includeTypes?: string[];
  excludeTypes?: string[];
  agentIds?: string[];
};

export type ChannelInboundPolicy = {
  allowCommands: boolean;
  // ["*"] to allow every registered command.
  allowedCommandIds: string[];
};

export type ChannelSummary = {
  id: string;
  name: string;
  kind: string;
  direction: ChannelDirection;
  enabled: boolean;
  filter: ChannelFilter;
  inbound: ChannelInboundPolicy;
  adapterConfig: Record<string, unknown>;
  source: ChannelSource;
  createdAt: string;
  updatedAt: string;
};

// Wire-facing descriptor for the GET /api/channels/kinds endpoint. The
// backend's internal registry type (with adapter factories) is a different,
// richer shape and stays in backend/src/channels/types.ts.
export type ChannelKindDescriptor = {
  kind: string;
  defaultDirection: ChannelDirection;
};

export type ChannelMessageDirection = "in" | "out";
export type ChannelMessageKind = "command" | "event" | "chat" | "notification";

export type ChannelMessageSummary = {
  id: string;
  channelId: string;
  direction: ChannelMessageDirection;
  kind: ChannelMessageKind;
  payload: unknown;
  correlationId: string | null;
  createdAt: string;
};
