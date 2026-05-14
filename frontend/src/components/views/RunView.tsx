import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../../store/useStore";
import type {
  AskUserEventPayload,
  DoneWaitingEventPayload,
  RunEventEnvelope,
  WaitingForLLMEventPayload
} from "../../types";
import Tabs from "../Tabs";
import ArtifactsTab from "../ArtifactsTab";
import WaitingForLLMRow from "../WaitingForLLMRow";

type TabId = "logs" | "artifacts";

export default function RunView({ runId }: { runId: string }) {
  const ingestEvent = useStore(s => s.ingestEvent);
  const eventsFromStore = useStore(s => s.events[runId]);
  const artifacts = useStore(s => s.artifactsByRun[runId]);
  const pendingInteractions = useStore(
    s => s.pendingInteractionsByRun[runId]
  );
  const answeredInteractions = useStore(s => s.answeredInteractions);
  const submitInteractionResponse = useStore(s => s.submitInteractionResponse);
  const loadInteractionsForRun = useStore(s => s.loadInteractionsForRun);
  const [localEvents, setLocalEvents] = useState<RunEventEnvelope[]>([]);
  const [connected, setConnected] = useState(false);
  const [activeTab, setActiveTab] = useState<TabId>("logs");
  const seenRef = useRef<Set<number>>(new Set());

  // Reset tab state when switching runs.
  useEffect(() => {
    setActiveTab("logs");
  }, [runId]);

  // Seed the store with the run's existing interactions (pending + answered)
  // so a refresh / late-mount shows resolved Q&A blocks immediately.
  useEffect(() => {
    void loadInteractionsForRun(runId);
  }, [runId, loadInteractionsForRun]);

  useEffect(() => {
    seenRef.current = new Set();
    setLocalEvents([]);
    const es = new EventSource(`/api/runs/${runId}/events`);
    es.addEventListener("run_event", (e: MessageEvent) => {
      try {
        const ev = JSON.parse(e.data) as RunEventEnvelope;
        if (seenRef.current.has(ev.seq)) return;
        seenRef.current.add(ev.seq);
        setLocalEvents(prev => [...prev, ev]);
        // Also push into the global store so the right-panel summary tracks it.
        ingestEvent(ev);
      } catch {
        // ignore
      }
    });
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    return () => {
      es.close();
    };
  }, [runId, ingestEvent]);

  // Prefer the dedicated stream; fall back to whatever the firehose left in store.
  const events = localEvents.length > 0 ? localEvents : eventsFromStore ?? [];
  const artifactCount = artifacts?.length ?? 0;

  // Pair `waiting_for_llm` events with their matching `done_waiting`. Built
  // once per event-list update so each row render is O(1). Pairing rule:
  //   • explicit waitId match wins;
  //   • otherwise nearest-unpaired-by-node (LIFO) on the same `node`.
  const waitPairings = useMemo(() => {
    const map = new Map<number, RunEventEnvelope<DoneWaitingEventPayload>>();
    const consumed = new Set<number>();
    // Stack of unpaired waiting events, keyed by node (null treated as "").
    const stackByNode = new Map<string, RunEventEnvelope<WaitingForLLMEventPayload>[]>();
    for (const ev of events) {
      if (ev.type === "waiting_for_llm") {
        const key = ev.node ?? "";
        const stack = stackByNode.get(key) ?? [];
        stack.push(ev as RunEventEnvelope<WaitingForLLMEventPayload>);
        stackByNode.set(key, stack);
        continue;
      }
      if (ev.type !== "done_waiting") continue;
      const doneEv = ev as RunEventEnvelope<DoneWaitingEventPayload>;
      const doneId = doneEv.payload?.waitId;
      // Explicit waitId — walk all stacks to find the match.
      if (typeof doneId === "string" && doneId.length > 0) {
        let matched: RunEventEnvelope<WaitingForLLMEventPayload> | undefined;
        for (const [, stack] of stackByNode) {
          const idx = stack.findIndex(
            w => w.payload?.waitId === doneId && !consumed.has(w.seq)
          );
          if (idx !== -1) {
            matched = stack.splice(idx, 1)[0];
            break;
          }
        }
        if (matched) {
          consumed.add(matched.seq);
          map.set(matched.seq, doneEv);
        }
        continue;
      }
      // Implicit: pop nearest unpaired on the same node.
      const key = doneEv.node ?? "";
      const stack = stackByNode.get(key);
      if (stack && stack.length > 0) {
        const matched = stack.pop()!;
        consumed.add(matched.seq);
        map.set(matched.seq, doneEv);
      }
    }
    return map;
  }, [events]);

  return (
    <div className="view">
      <div className="view-header">
        <h2>Run {runId.slice(0, 8)}…</h2>
        <p className="muted">
          {connected ? "live" : "disconnected"} · {events.length} event(s)
        </p>
      </div>

      <Tabs
        activeId={activeTab}
        onChange={id => setActiveTab(id as TabId)}
        items={[
          { id: "logs", label: "Logs" },
          {
            id: "artifacts",
            label:
              artifactCount > 0 ? `Artifacts (${artifactCount})` : "Artifacts"
          }
        ]}
      />

      {activeTab === "logs" ? (
        <div
          style={{
            fontFamily: "monospace",
            fontSize: "0.85em",
            padding: "0 16px 16px"
          }}
        >
          {events.map(ev => {
            if (ev.type === "ask_user") {
              const p = ev.payload as AskUserEventPayload;
              const stillPending =
                pendingInteractions?.some(i => i.id === p.interactionId) ?? false;
              const answer = answeredInteractions[p.interactionId];
              if (stillPending) {
                return (
                  <AskUserPrompt
                    key={ev.seq}
                    runId={runId}
                    interactionId={p.interactionId}
                    prompt={p.prompt}
                    choices={p.choices}
                    onSubmit={submitInteractionResponse}
                  />
                );
              }
              return (
                <div key={ev.seq} className="ask-user-answered">
                  <div className="ask-user-q">Q: {p.prompt}</div>
                  <div className="ask-user-a">
                    A: {answer ?? "(no answer)"}
                  </div>
                </div>
              );
            }
            if (ev.type === "user_response") {
              // The matching ask_user event renders the resolved Q&A above
              // (assuming both events are in `events`). Drop the bare
              // user_response from the log to avoid duplicate display.
              return null;
            }
            if (ev.type === "waiting_for_llm") {
              const done = waitPairings.get(ev.seq);
              return (
                <WaitingForLLMRow
                  key={ev.seq}
                  startTs={ev.ts}
                  waiting={ev.payload as WaitingForLLMEventPayload}
                  done={done && { payload: done.payload, ts: done.ts }}
                />
              );
            }
            if (ev.type === "done_waiting") {
              // Rendered inline by the matching `waiting_for_llm` row above
              // (or, for an orphaned done, simply hidden). Drop from the log.
              return null;
            }
            return (
              <div
                key={ev.seq}
                style={{
                  borderBottom: "1px solid #2a2a2a",
                  padding: "6px 0",
                  whiteSpace: "pre-wrap"
                }}
              >
                <div>
                  <span style={{ opacity: 0.6 }}>#{ev.seq}</span>{" "}
                  <span style={{ opacity: 0.6 }}>
                    {new Date(ev.ts).toLocaleTimeString()}
                  </span>{" "}
                  <strong>{ev.type}</strong>
                  {ev.node ? <span> · {ev.node}</span> : null}
                </div>
                <div style={{ opacity: 0.85, marginTop: 2 }}>
                  {JSON.stringify(ev.payload)}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <ArtifactsTab runId={runId} />
      )}
    </div>
  );
}

type AskUserPromptProps = {
  runId: string;
  interactionId: string;
  prompt: string;
  choices: string[] | undefined;
  onSubmit: (
    runId: string,
    interactionId: string,
    answer: string
  ) => Promise<void>;
};

function AskUserPrompt({
  runId,
  interactionId,
  prompt,
  choices,
  onSubmit
}: AskUserPromptProps) {
  const [value, setValue] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const send = async (answer: string) => {
    if (!answer.length || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit(runId, interactionId, answer);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSubmitting(false);
    }
  };

  return (
    <div className="ask-user">
      <div className="ask-user-prompt">
        <strong>?</strong> {prompt}
      </div>
      {choices && choices.length > 0 ? (
        <div className="ask-user-choices">
          {choices.map(c => (
            <button
              key={c}
              type="button"
              className="ask-user-choice"
              disabled={submitting}
              onClick={() => void send(c)}
            >
              {c}
            </button>
          ))}
        </div>
      ) : null}
      <form
        className="ask-user-form"
        onSubmit={e => {
          e.preventDefault();
          void send(value.trim());
        }}
      >
        <input
          type="text"
          value={value}
          onChange={e => setValue(e.target.value)}
          placeholder="Type your answer…"
          disabled={submitting}
          autoFocus
        />
        <button
          type="submit"
          className="btn primary"
          disabled={submitting || value.trim().length === 0}
        >
          Send
        </button>
      </form>
      {error ? <div className="error-text">{error}</div> : null}
    </div>
  );
}
