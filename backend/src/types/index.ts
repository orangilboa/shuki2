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

export type RunStatus = "queued" | "running" | "succeeded" | "failed";

export type RunningTask = {
  id: string;
  agentId: string;
  name: string;
  status: RunStatus;
  progress: number;
  startedAt: string;
};

// ---------- LLM endpoints + models ---------------------------------------

export type EndpointSource = "config" | "user";

export type EndpointSummary = {
  id: string;
  displayName: string;
  baseUrl: string;
  source: EndpointSource;
  hasKey: boolean;
  apiKeyMasked: string | null;
};

export type ModelInfo = {
  id: string;
  ownedBy?: string;
};

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

// ---------- artifacts ----------------------------------------------------

export type ArtifactKind = "md" | "text" | "image" | "audio" | "video";

export type ArtifactSummary = {
  id: string;
  runId: string;
  seq: number; // monotonic per run, like run_events.seq
  name: string;
  kind: ArtifactKind;
  mime: string;
  bytes: number;
  hasInlineContent: boolean;
  createdAt: string; // ISO
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
  createdAt: string; // ISO
  answeredAt: string | null; // ISO
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
