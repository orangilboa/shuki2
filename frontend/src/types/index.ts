export type ConversationSummary = {
  id: string;
  title: string;
  updatedAt: string;
  preview: string;
  model: string | null;
};

export type ChatMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: string;
};

export type Conversation = ConversationSummary & {
  messages: ChatMessage[];
};

export type ScheduledTask = {
  id: string;
  name: string;
  cron: string;
  nextRun: string;
  description: string;
};

export type AgentInputType = "string" | "number" | "boolean";

export type AgentInput = {
  name: string;
  label?: string;
  type: AgentInputType;
  required?: boolean;
  default?: string | number | boolean;
  description?: string;
};

export type AgentExec =
  | { kind: "mock" }
  | {
      kind: "subprocess";
      command: string;
      args: string[];
      cwd?: string;
      env?: Record<string, string>;
      protocol: "jsonl" | "raw";
    };

export type AgentSource = "config" | "user";

export type Agent = {
  id: string;
  name: string;
  description: string;
  model: string | null;
  inputs: AgentInput[];
  exec: AgentExec;
  source: AgentSource;
};

export type RunningTask = {
  id: string;
  agentId: string;
  name: string;
  status: "queued" | "running" | "succeeded" | "failed";
  progress: number;
  startedAt: string;
};

export type LeftTab = "chats" | "scheduled" | "agents";

export type CenterView =
  | { kind: "new-chat" }
  | { kind: "conversation"; conversationId: string }
  | { kind: "agent"; agentId: string }
  | { kind: "scheduled"; taskId: string }
  | { kind: "run"; runId: string }
  | { kind: "settings" };

// ---------- endpoints / models -------------------------------------------

export type EndpointSource = "config" | "user";

export type EndpointSummary = {
  id: string;
  displayName: string;
  baseUrl: string;
  source: EndpointSource;
  hasKey: boolean;
  apiKeyMasked: string | null;
};

export type ModelInfo = { id: string; ownedBy?: string };

export type EndpointModels = {
  endpointId: string;
  displayName: string;
  source: EndpointSource;
  ok: boolean;
  error: string | null;
  fetchedAt: string;
  models: ModelInfo[];
};

export type ModelsResponse = EndpointModels[];

// ---------- run streaming -------------------------------------------------

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
  | "ask_user"
  | "user_response"
  | "waiting_for_llm"
  | "done_waiting";

export type RunEventEnvelope<P = unknown> = {
  runId: string;
  seq: number;
  ts: number;
  type: RunEventType;
  node: string | null;
  payload: P;
};

// ---------- artifacts ----------------------------------------------------

export type ArtifactKind = "md" | "text" | "image" | "audio" | "video";

export type ArtifactSummary = {
  id: string;
  runId: string;
  seq: number;
  name: string;
  kind: ArtifactKind;
  mime: string;
  bytes: number;
  hasInlineContent: boolean;
  createdAt: string;
};

export type ArtifactEventPayload = {
  artifactId: string;
  name: string;
  kind: ArtifactKind;
  mime: string;
  bytes: number;
  hasInlineContent: boolean;
};

// ---------- agent ↔ user interactions -----------------------------------

export type AgentInteractionStatus = "pending" | "answered" | "cancelled";

export type AgentInteraction = {
  id: string;
  runId: string;
  prompt: string;
  choices: string[] | null;
  status: AgentInteractionStatus;
  answer: string | null;
  createdAt: string;
  answeredAt: string | null;
};

export type AskUserEventPayload = {
  interactionId: string;
  prompt: string;
  choices?: string[];
};

export type UserResponseEventPayload = {
  interactionId: string;
  answer: string;
};

// ---------- LLM wait events ----------------------------------------------

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

// ---------- channels -----------------------------------------------------

export type ChannelDirection = "in_out" | "out_only" | "in_only";

export type ChannelSource = "config" | "user";

export type ChannelEventCategory =
  | "run.lifecycle"
  | "run.progress"
  | "run.logs"
  | "run.tools"
  | "run.artifacts"
  | "run.interactions"
  | "run.errors"
  | "run.llm_wait";

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
