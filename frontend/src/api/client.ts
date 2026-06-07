import type {
  Agent,
  AgentExec,
  AgentInput,
  AgentInteraction,
  ArtifactSummary,
  ChannelDirection,
  ChannelFilter,
  ChannelInboundPolicy,
  ChannelKindDescriptor,
  ChannelMessageSummary,
  ChannelSummary,
  Conversation,
  ConversationSummary,
  EndpointSummary,
  ModelsResponse,
  RunningTask,
  ScheduledTask
} from "../types";

async function j<T>(p: Promise<Response>): Promise<T> {
  const res = await p;
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as { error?: unknown };
      if (body && typeof body.error === "string" && body.error.length > 0) {
        message = body.error;
      }
    } catch {
      // ignore: not json
    }
    throw new Error(message);
  }
  return res.json() as Promise<T>;
}

async function jVoid(p: Promise<Response>): Promise<void> {
  const res = await p;
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as { error?: unknown };
      if (body && typeof body.error === "string" && body.error.length > 0) {
        message = body.error;
      }
    } catch {
      // ignore
    }
    throw new Error(message);
  }
}

export type EndpointCreateInput = {
  displayName: string;
  baseUrl: string;
  apiKey?: string | null;
};

export type EndpointPatchInput = {
  displayName?: string;
  baseUrl?: string;
  apiKey?: string | null;
};

export type AgentCreateInput = {
  name: string;
  description?: string;
  model?: string | null;
  inputs?: AgentInput[];
  exec?: AgentExec;
};

export type AgentPatchInput = Partial<{
  name: string;
  description: string;
  model: string | null;
  inputs: AgentInput[];
  exec: AgentExec;
}>;

export const api = {
  listConversations: () => j<ConversationSummary[]>(fetch("/api/conversations")),
  getConversation: (id: string) => j<Conversation>(fetch(`/api/conversations/${id}`)),
  createConversation: () =>
    j<Conversation>(
      fetch("/api/conversations", { method: "POST", headers: { "Content-Type": "application/json" } })
    ),
  sendMessage: (id: string, content: string, model?: string | null) =>
    j<{ messages: Conversation["messages"] }>(
      fetch(`/api/conversations/${id}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          model === undefined ? { content } : { content, model }
        )
      })
    ),
  listScheduled: () => j<ScheduledTask[]>(fetch("/api/scheduled")),
  listAgents: () => j<Agent[]>(fetch("/api/agents")),
  getAgent: (id: string) => j<Agent>(fetch(`/api/agents/${id}`)),
  createAgent: (input: AgentCreateInput) =>
    j<Agent>(
      fetch("/api/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input)
      })
    ),
  updateAgent: (id: string, patch: AgentPatchInput) =>
    j<Agent>(
      fetch(`/api/agents/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch)
      })
    ),
  deleteAgent: (id: string) =>
    jVoid(fetch(`/api/agents/${id}`, { method: "DELETE" })),
  listRunning: () => j<RunningTask[]>(fetch("/api/running")),
  runAgent: (
    id: string,
    inputs: Record<string, unknown>,
    model?: string | null
  ) =>
    j<RunningTask>(
      fetch(`/api/agents/${id}/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ inputs, model: model ?? null })
      })
    ),
  cancelRun: (runId: string) =>
    j<{ ok: boolean; mode: "signal" | "direct" | "noop" }>(
      fetch(`/api/runs/${runId}/cancel`, { method: "POST" })
    ),

  // endpoints
  listEndpoints: () => j<EndpointSummary[]>(fetch("/api/endpoints")),
  createEndpoint: (input: EndpointCreateInput) =>
    j<EndpointSummary>(
      fetch("/api/endpoints", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input)
      })
    ),
  updateEndpoint: (id: string, patch: EndpointPatchInput) =>
    j<EndpointSummary>(
      fetch(`/api/endpoints/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch)
      })
    ),
  deleteEndpoint: (id: string) =>
    jVoid(fetch(`/api/endpoints/${id}`, { method: "DELETE" })),

  // models
  listModels: (opts?: { refresh?: boolean }) =>
    j<ModelsResponse>(fetch(`/api/models${opts?.refresh ? "?refresh=1" : ""}`)),

  // artifacts
  listArtifacts: (runId: string) =>
    j<ArtifactSummary[]>(fetch(`/api/runs/${runId}/artifacts`)),
  getArtifact: (id: string) => j<ArtifactSummary>(fetch(`/api/artifacts/${id}`)),
  artifactContentUrl: (id: string) => `/api/artifacts/${id}/content`,

  // interactions (agent ↔ user Q&A)
  listInteractions: (runId: string) =>
    j<AgentInteraction[]>(fetch(`/api/runs/${runId}/interactions`)),
  listPendingInteractions: () =>
    j<AgentInteraction[]>(fetch("/api/interactions/pending")),
  respondToInteraction: (runId: string, interactionId: string, answer: string) =>
    j<{ interaction: AgentInteraction; delivered: boolean }>(
      fetch(`/api/runs/${runId}/interactions/${interactionId}/respond`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ answer })
      })
    ),

  // channels
  listChannels: () => j<ChannelSummary[]>(fetch("/api/channels")),
  listChannelKinds: () => j<ChannelKindDescriptor[]>(fetch("/api/channels/kinds")),
  listChannelMessages: (id: string, limit?: number) =>
    j<ChannelMessageSummary[]>(
      fetch(`/api/channels/${id}/messages${limit ? `?limit=${limit}` : ""}`)
    ),
  createChannel: (input: ChannelCreateInput) =>
    j<ChannelSummary>(
      fetch("/api/channels", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input)
      })
    ),
  updateChannel: (id: string, patch: ChannelPatchInput) =>
    j<ChannelSummary>(
      fetch(`/api/channels/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch)
      })
    ),
  enableChannel: (id: string) =>
    j<ChannelSummary>(
      fetch(`/api/channels/${id}/enable`, { method: "POST" })
    ),
  disableChannel: (id: string) =>
    j<ChannelSummary>(
      fetch(`/api/channels/${id}/disable`, { method: "POST" })
    ),
  deleteChannel: (id: string) =>
    jVoid(fetch(`/api/channels/${id}`, { method: "DELETE" }))
};

export type ChannelCreateInput = {
  name: string;
  kind: string;
  direction: ChannelDirection;
  enabled?: boolean;
  filter: ChannelFilter;
  inbound: ChannelInboundPolicy;
  adapterConfig?: Record<string, unknown>;
};

export type ChannelPatchInput = Partial<ChannelCreateInput>;
