import { create } from "zustand";
import { api } from "../api/client";
import type { AgentCreateInput, AgentPatchInput } from "../api/client";
import type {
  Agent,
  AgentInteraction,
  ArtifactEventPayload,
  ArtifactSummary,
  AskUserEventPayload,
  CenterView,
  ChatMessage,
  Conversation,
  ConversationSummary,
  EndpointSummary,
  LeftTab,
  ModelsResponse,
  RunEventEnvelope,
  RunningTask,
  ScheduledTask,
  UserResponseEventPayload
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

  // interactions (agent ↔ user Q&A)
  pendingInteractionsByRun: Record<string, AgentInteraction[]>;
  // interactionId → answer string. Lets RunView render resolved Q&A inline
  // for events received over SSE without an extra fetch.
  answeredInteractions: Record<string, string>;
  // tracks which runs we've already seeded from /api/runs/:id/interactions
  // so RunView doesn't re-fetch on every mount.
  interactionsLoadedForRun: Record<string, boolean>;

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
  cancelRun: (runId: string) => Promise<void>;

  // Per-run UI flag set while a cancel request is in flight. The canonical
  // `failed` status arrives later via the SSE `done`/`error` event.
  cancelling: Record<string, boolean>;

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

  loadPendingInteractions: () => Promise<void>;
  loadInteractionsForRun: (runId: string) => Promise<void>;
  submitInteractionResponse: (
    runId: string,
    interactionId: string,
    answer: string
  ) => Promise<void>;
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

  pendingInteractionsByRun: {},
  answeredInteractions: {},
  interactionsLoadedForRun: {},

  endpoints: [],
  models: [],
  modelsLoading: false,
  modelsError: null,

  cancelling: {},

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

  cancelRun: async runId => {
    if (get().cancelling[runId]) return;
    set(s => ({ cancelling: { ...s.cancelling, [runId]: true } }));
    try {
      await api.cancelRun(runId);
    } catch (err) {
      set(s => {
        const next = { ...s.cancelling };
        delete next[runId];
        return { cancelling: next };
      });
      throw err;
    }
    // Leave the cancelling flag true; the SSE `done`/`error` ingest will move
    // the run out of `running`, so the per-row button unmounts on its own.
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

      // Synthesize pending interactions from ask_user events; clear on
      // user_response. Both arms keep answeredInteractions in sync so the
      // event log can show resolved Q&A without an extra fetch.
      let nextPending = s.pendingInteractionsByRun;
      let nextAnswers = s.answeredInteractions;
      if (ev.type === "ask_user" && ev.payload && typeof ev.payload === "object") {
        const p = ev.payload as AskUserEventPayload;
        if (typeof p.interactionId === "string" && p.interactionId.length > 0) {
          const existing = s.pendingInteractionsByRun[ev.runId] ?? [];
          if (!existing.some(i => i.id === p.interactionId)) {
            const synth: AgentInteraction = {
              id: p.interactionId,
              runId: ev.runId,
              prompt: p.prompt,
              choices: p.choices ?? null,
              status: "pending",
              answer: null,
              createdAt: new Date(ev.ts).toISOString(),
              answeredAt: null
            };
            nextPending = {
              ...s.pendingInteractionsByRun,
              [ev.runId]: [...existing, synth]
            };
          }
        }
      } else if (
        ev.type === "user_response" &&
        ev.payload &&
        typeof ev.payload === "object"
      ) {
        const p = ev.payload as UserResponseEventPayload;
        if (typeof p.interactionId === "string" && typeof p.answer === "string") {
          const existing = s.pendingInteractionsByRun[ev.runId] ?? [];
          const filtered = existing.filter(i => i.id !== p.interactionId);
          if (filtered.length !== existing.length) {
            nextPending = {
              ...s.pendingInteractionsByRun,
              [ev.runId]: filtered
            };
          }
          nextAnswers = { ...s.answeredInteractions, [p.interactionId]: p.answer };
        }
      }

      // Terminal events clear the cancelling flag so a stale flag never
      // outlives the run.
      let nextCancelling = s.cancelling;
      if ((ev.type === "done" || ev.type === "error") && s.cancelling[ev.runId]) {
        nextCancelling = { ...s.cancelling };
        delete nextCancelling[ev.runId];
      }

      return {
        events: { ...s.events, [ev.runId]: nextBuf },
        latestEventByRun: { ...s.latestEventByRun, [ev.runId]: ev },
        running,
        artifactsByRun: nextArtifactsByRun,
        pendingInteractionsByRun: nextPending,
        answeredInteractions: nextAnswers,
        cancelling: nextCancelling
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
  },

  loadPendingInteractions: async () => {
    const list = await api.listPendingInteractions();
    set(s => {
      // Group by run; keep any in-memory entries already synthesised from SSE
      // events that aren't represented in the fetched list (rare but possible
      // if the event arrived after the fetch was initiated).
      const grouped: Record<string, AgentInteraction[]> = {
        ...s.pendingInteractionsByRun
      };
      const seen = new Set<string>();
      for (const i of list) {
        seen.add(`${i.runId}:${i.id}`);
      }
      // For each run touched by the fetch, replace the pending list with the
      // server's view (it's authoritative for status='pending').
      const runIds = new Set(list.map(i => i.runId));
      for (const runId of runIds) {
        grouped[runId] = list.filter(i => i.runId === runId);
      }
      return { pendingInteractionsByRun: grouped };
    });
  },

  loadInteractionsForRun: async runId => {
    if (get().interactionsLoadedForRun[runId]) return;
    const list = await api.listInteractions(runId);
    set(s => {
      const pending = list.filter(i => i.status === "pending");
      const answers: Record<string, string> = { ...s.answeredInteractions };
      for (const i of list) {
        if (i.status === "answered" && typeof i.answer === "string") {
          answers[i.id] = i.answer;
        }
      }
      return {
        pendingInteractionsByRun: {
          ...s.pendingInteractionsByRun,
          [runId]: pending
        },
        answeredInteractions: answers,
        interactionsLoadedForRun: {
          ...s.interactionsLoadedForRun,
          [runId]: true
        }
      };
    });
  },

  submitInteractionResponse: async (runId, interactionId, answer) => {
    // Optimistically remove from pending so the inline form disappears
    // immediately. The user_response SSE event will follow and write the
    // answer into answeredInteractions.
    set(s => {
      const existing = s.pendingInteractionsByRun[runId] ?? [];
      return {
        pendingInteractionsByRun: {
          ...s.pendingInteractionsByRun,
          [runId]: existing.filter(i => i.id !== interactionId)
        },
        answeredInteractions: {
          ...s.answeredInteractions,
          [interactionId]: answer
        }
      };
    });
    try {
      await api.respondToInteraction(runId, interactionId, answer);
    } catch (err) {
      // On failure, refetch the run's interactions so the UI reflects truth.
      set(s => ({
        interactionsLoadedForRun: {
          ...s.interactionsLoadedForRun,
          [runId]: false
        }
      }));
      try {
        await get().loadInteractionsForRun(runId);
      } catch {
        // best-effort
      }
      throw err;
    }
  }
}));
