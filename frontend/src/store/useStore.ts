import { create } from "zustand";
import { api } from "../api/client";
import type { AgentCreateInput, AgentPatchInput } from "../api/client";
import type {
  Agent,
  ArtifactEventPayload,
  ArtifactSummary,
  CenterView,
  ChatMessage,
  Conversation,
  ConversationSummary,
  EndpointSummary,
  LeftTab,
  ModelsResponse,
  RunEventEnvelope,
  RunningTask,
  ScheduledTask
} from "../types";

type State = {
  // layout
  leftCollapsed: boolean;
  rightCollapsed: boolean;
  leftTab: LeftTab;
  centerView: CenterView;

  // data
  conversations: ConversationSummary[];
  scheduled: ScheduledTask[];
  agents: Agent[];
  running: RunningTask[];
  conversationCache: Record<string, Conversation>;

  // streaming
  events: Record<string, RunEventEnvelope[]>; // runId -> events buffer
  latestEventByRun: Record<string, RunEventEnvelope | undefined>;
  firehoseConnected: boolean;
  _firehose: EventSource | null;

  // artifacts
  artifactsByRun: Record<string, ArtifactSummary[]>;
  artifactsLoading: Record<string, boolean>;

  // endpoints / models
  endpoints: EndpointSummary[];
  models: ModelsResponse;
  modelsLoading: boolean;
  modelsError: string | null;

  // actions
  toggleLeft: () => void;
  toggleRight: () => void;
  setLeftTab: (t: LeftTab) => void;
  setCenterView: (v: CenterView) => void;

  loadConversations: () => Promise<void>;
  loadScheduled: () => Promise<void>;
  loadAgents: () => Promise<void>;
  loadRunning: () => Promise<void>;
  loadConversation: (id: string) => Promise<void>;
  sendMessage: (id: string, content: string, model?: string | null) => Promise<void>;
  startNewChat: () => void;
  runAgent: (
    agentId: string,
    inputs?: Record<string, unknown>,
    model?: string | null
  ) => Promise<void>;

  createAgent: (input: AgentCreateInput) => Promise<void>;
  updateAgent: (id: string, patch: AgentPatchInput) => Promise<void>;
  deleteAgent: (id: string) => Promise<void>;

  loadEndpoints: () => Promise<void>;
  loadModels: (opts?: { refresh?: boolean }) => Promise<void>;
  createEndpoint: (input: {
    displayName: string;
    baseUrl: string;
    apiKey?: string | null;
  }) => Promise<void>;
  updateEndpoint: (
    id: string,
    patch: { displayName?: string; baseUrl?: string; apiKey?: string | null }
  ) => Promise<void>;
  deleteEndpoint: (id: string) => Promise<void>;

  connectFirehose: () => void;
  disconnectFirehose: () => void;
  ingestEvent: (ev: RunEventEnvelope) => void;

  loadArtifacts: (runId: string) => Promise<void>;
};

export const useStore = create<State>((set, get) => ({
  leftCollapsed: false,
  rightCollapsed: false,
  leftTab: "chats",
  centerView: { kind: "new-chat" },

  conversations: [],
  scheduled: [],
  agents: [],
  running: [],
  conversationCache: {},

  events: {},
  latestEventByRun: {},
  firehoseConnected: false,
  _firehose: null,

  artifactsByRun: {},
  artifactsLoading: {},

  endpoints: [],
  models: [],
  modelsLoading: false,
  modelsError: null,

  toggleLeft: () => set(s => ({ leftCollapsed: !s.leftCollapsed })),
  toggleRight: () => set(s => ({ rightCollapsed: !s.rightCollapsed })),
  setLeftTab: t => set({ leftTab: t }),
  setCenterView: v => set({ centerView: v }),

  loadConversations: async () => set({ conversations: await api.listConversations() }),
  loadScheduled: async () => set({ scheduled: await api.listScheduled() }),
  loadAgents: async () => set({ agents: await api.listAgents() }),
  loadRunning: async () => set({ running: await api.listRunning() }),

  loadConversation: async id => {
    const conv = await api.getConversation(id);
    set(s => ({ conversationCache: { ...s.conversationCache, [id]: conv } }));
  },

  sendMessage: async (id, content, model) => {
    const { messages } = await api.sendMessage(id, content, model);
    set(s => {
      const existing = s.conversationCache[id];
      if (!existing) return s;
      // Sticky model: remember the last-used selection on the conversation in
      // cache so a refresh isn't needed for the picker to reflect it.
      const nextModel = model === undefined ? existing.model : model;
      return {
        conversationCache: {
          ...s.conversationCache,
          [id]: {
            ...existing,
            model: nextModel,
            messages: [...existing.messages, ...messages] satisfies ChatMessage[]
          }
        }
      };
    });
  },

  startNewChat: () => set({ centerView: { kind: "new-chat" } }),

  runAgent: async (agentId, inputs, model) => {
    const task = await api.runAgent(agentId, inputs ?? {}, model);
    set(s => ({ running: [task, ...s.running] }));
  },

  createAgent: async input => {
    await api.createAgent(input);
    await get().loadAgents();
  },

  updateAgent: async (id, patch) => {
    await api.updateAgent(id, patch);
    await get().loadAgents();
  },

  deleteAgent: async id => {
    await api.deleteAgent(id);
    await get().loadAgents();
  },

  loadEndpoints: async () => {
    const endpoints = await api.listEndpoints();
    set({ endpoints });
  },

  loadModels: async opts => {
    set({ modelsLoading: true, modelsError: null });
    try {
      const models = await api.listModels(opts);
      set({ models, modelsLoading: false });
    } catch (err) {
      set({
        modelsLoading: false,
        modelsError: err instanceof Error ? err.message : String(err)
      });
    }
  },

  createEndpoint: async input => {
    await api.createEndpoint(input);
    await get().loadEndpoints();
    await get().loadModels({ refresh: true });
  },

  updateEndpoint: async (id, patch) => {
    await api.updateEndpoint(id, patch);
    await get().loadEndpoints();
    await get().loadModels({ refresh: true });
  },

  deleteEndpoint: async id => {
    await api.deleteEndpoint(id);
    await get().loadEndpoints();
    await get().loadModels({ refresh: true });
  },

  connectFirehose: () => {
    if (get()._firehose) return;
    const es = new EventSource("/api/events");
    es.addEventListener("run_event", (e: MessageEvent) => {
      try {
        const ev = JSON.parse(e.data) as RunEventEnvelope;
        get().ingestEvent(ev);
      } catch {
        // bad payload, ignore
      }
    });
    es.onopen = () => set({ firehoseConnected: true });
    es.onerror = () => set({ firehoseConnected: false });
    set({ _firehose: es });
  },

  disconnectFirehose: () => {
    const es = get()._firehose;
    if (es) es.close();
    set({ _firehose: null, firehoseConnected: false });
  },

  ingestEvent: ev => {
    set(s => {
      const buf = s.events[ev.runId] ?? [];
      const nextBuf = [...buf, ev];

      // Update the running task list in place: progress from node_end / done,
      // status from done / error.
      const running = s.running.map(r => {
        if (r.id !== ev.runId) return r;
        let progress = r.progress;
        let status = r.status;
        if (ev.type === "node_end") {
          const p = (ev.payload as { progress?: number } | null)?.progress;
          if (typeof p === "number") progress = p;
        } else if (ev.type === "done") {
          const ok = (ev.payload as { ok?: boolean } | null)?.ok;
          status = ok === false ? "failed" : "succeeded";
          progress = 1;
        } else if (ev.type === "error") {
          status = "failed";
        }
        return { ...r, progress, status };
      });

      // Synthesize an ArtifactSummary from the artifact event payload to avoid
      // a round-trip. Dedupe by id.
      let nextArtifactsByRun = s.artifactsByRun;
      if (ev.type === "artifact" && ev.payload && typeof ev.payload === "object") {
        const p = ev.payload as ArtifactEventPayload;
        if (typeof p.artifactId === "string" && p.artifactId.length > 0) {
          const existing = s.artifactsByRun[ev.runId] ?? [];
          if (!existing.some(a => a.id === p.artifactId)) {
            const summary: ArtifactSummary = {
              id: p.artifactId,
              runId: ev.runId,
              seq: ev.seq,
              name: p.name,
              kind: p.kind,
              mime: p.mime,
              bytes: p.bytes,
              hasInlineContent: p.hasInlineContent,
              createdAt: new Date(ev.ts).toISOString()
            };
            const merged = [...existing, summary].sort((a, b) => a.seq - b.seq);
            nextArtifactsByRun = { ...s.artifactsByRun, [ev.runId]: merged };
          }
        }
      }

      return {
        events: { ...s.events, [ev.runId]: nextBuf },
        latestEventByRun: { ...s.latestEventByRun, [ev.runId]: ev },
        running,
        artifactsByRun: nextArtifactsByRun
      };
    });
  },

  loadArtifacts: async runId => {
    set(s => ({ artifactsLoading: { ...s.artifactsLoading, [runId]: true } }));
    try {
      const list = await api.listArtifacts(runId);
      set(s => {
        // Merge with any artifacts that may have been synthesized via events
        // while this fetch was in-flight; dedupe by id, prefer fetched record.
        const existing = s.artifactsByRun[runId] ?? [];
        const byId = new Map<string, ArtifactSummary>();
        for (const a of existing) byId.set(a.id, a);
        for (const a of list) byId.set(a.id, a);
        const merged = Array.from(byId.values()).sort((a, b) => a.seq - b.seq);
        return {
          artifactsByRun: { ...s.artifactsByRun, [runId]: merged },
          artifactsLoading: { ...s.artifactsLoading, [runId]: false }
        };
      });
    } catch {
      set(s => ({ artifactsLoading: { ...s.artifactsLoading, [runId]: false } }));
    }
  }
}));
