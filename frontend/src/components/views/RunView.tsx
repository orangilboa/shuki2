import { useEffect, useRef, useState } from "react";
import { useStore } from "../../store/useStore";
import type { RunEventEnvelope } from "../../types";
import Tabs from "../Tabs";
import ArtifactsTab from "../ArtifactsTab";

type TabId = "logs" | "artifacts";

export default function RunView({ runId }: { runId: string }) {
  const ingestEvent = useStore(s => s.ingestEvent);
  const eventsFromStore = useStore(s => s.events[runId]);
  const artifacts = useStore(s => s.artifactsByRun[runId]);
  const [localEvents, setLocalEvents] = useState<RunEventEnvelope[]>([]);
  const [connected, setConnected] = useState(false);
  const [activeTab, setActiveTab] = useState<TabId>("logs");
  const seenRef = useRef<Set<number>>(new Set());

  // Reset tab state when switching runs.
  useEffect(() => {
    setActiveTab("logs");
  }, [runId]);

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
          {events.map(ev => (
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
          ))}
        </div>
      ) : (
        <ArtifactsTab runId={runId} />
      )}
    </div>
  );
}
