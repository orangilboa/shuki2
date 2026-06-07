// Shared API request/response types used by both the backend (REST surface)
// and the frontend (typed API client + UI). These were previously duplicated
// verbatim in backend/src/types/index.ts and frontend/src/types/index.ts;
// they now live here once and are re-exported from both. Keep this file
// dependency-free so it can be imported by either runtime without pulling in
// node- or DOM-specific code.

// ---------- conversations + chat ----------------------------------------

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

// ---------- scheduled tasks ----------------------------------------------

export type ScheduledTask = {
  id: string;
  name: string;
  cron: string;
  nextRun: string;
  description: string;
};

// ---------- agents -------------------------------------------------------

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

// ---------- agent onboarding spec ---------------------------------------

// An onboarding field is the input-spec shape plus a `"string_list"` type
// (for editable keyword lists like override rules) and an optional `section`
// grouping label. Agents declare these to collect persistent configuration
// before/independent of any run (see backend/src/agents/config-store.ts).
export type OnboardingFieldType = AgentInputType | "string_list";

export type OnboardingField = {
  name: string;
  label?: string;
  type: OnboardingFieldType;
  default?: string | number | boolean | string[];
  description?: string;
  section?: string;
};

export type Agent = {
  id: string;
  name: string;
  description: string;
  model: string | null;
  inputs: AgentInput[];
  exec: AgentExec;
  source: AgentSource;
  // Optional declarative onboarding/config spec. Empty/absent => no config UI.
  onboarding?: OnboardingField[];
};

// Response for GET /api/agents/:id/onboarding.
export type AgentOnboarding = {
  spec: OnboardingField[];
  config: Record<string, unknown>;
};

// ---------- runs ---------------------------------------------------------

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
