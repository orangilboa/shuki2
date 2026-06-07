import { useEffect } from "react";
import { useStore } from "../store/useStore";

function eventLine(ev: ReturnType<typeof useStore.getState>["latestEventByRun"][string]): string {
  if (!ev) return "";
  const node = ev.node ? `[${ev.node}] ` : "";
  switch (ev.type) {
    case "token": {
      const text = (ev.payload as { text?: string } | null)?.text ?? "";
      return `${node}token: ${text}`;
    }
    case "tool_call": {
      const name = (ev.payload as { name?: string } | null)?.name ?? "";
      return `${node}tool_call ${name}`;
    }
    case "tool_result": {
      const name = (ev.payload as { name?: string } | null)?.name ?? "";
      return `${node}tool_result ${name}`;
    }
    case "custom": {
      const msg = (ev.payload as { message?: string } | null)?.message ?? "custom";
      return `${node}${msg}`;
    }
    case "ask_user": {
      const prompt = (ev.payload as { prompt?: string } | null)?.prompt ?? "";
      const truncated = prompt.length > 60 ? `${prompt.slice(0, 57)}…` : prompt;
      return `${node}❓ asking: ${truncated}`;
    }
    case "user_response":
      return `${node}✓ answered`;
    case "waiting_for_llm": {
      const label =
        (ev.payload as { label?: string } | null)?.label ?? "waiting for LLM";
      return `${node}⏳ ${label}`;
    }
    case "done_waiting":
      return `${node}✓ LLM done`;
    case "config_patch":
      return `${node}🧠 learned a rule`;
    default:
      return `${node}${ev.type}`;
  }
}

export default function RightPanel() {
  const {
    rightCollapsed,
    toggleRight,
    running,
    latestEventByRun,
    firehoseConnected,
    connectFirehose,
    setCenterView,
    pendingInteractionsByRun,
    loadPendingInteractions,
    cancelling,
    cancelRun
  } = useStore();

  useEffect(() => {
    connectFirehose();
    void loadPendingInteractions();
  }, [connectFirehose, loadPendingInteractions]);

  const totalPendingRuns = Object.values(pendingInteractionsByRun).filter(
    list => list.length > 0
  ).length;

  return (
    <aside className={`panel right ${rightCollapsed ? "collapsed" : ""}`}>
      <div className="panel-header">
        <span className="collapse-btn-wrap">
          <button
            className="collapse-btn"
            onClick={toggleRight}
            title={rightCollapsed ? "Expand" : "Collapse"}
          >
            {rightCollapsed ? "‹" : "›"}
          </button>
          {rightCollapsed && totalPendingRuns > 0 && (
            <span
              className="badge collapsed-badge"
              title={`${totalPendingRuns} run(s) waiting for your input`}
            >
              {totalPendingRuns}
            </span>
          )}
        </span>
        {!rightCollapsed && (
          <div className="panel-title">
            Running tasks{" "}
            <span
              className="muted"
              title={firehoseConnected ? "live" : "disconnected"}
              style={{ fontSize: "0.7em" }}
            >
              {firehoseConnected ? "● live" : "○"}
            </span>
          </div>
        )}
      </div>
      {!rightCollapsed && (
        <div className="panel-body">
          {running.length === 0 && <div className="empty">No tasks running.</div>}
          <ul className="list">
            {running.map(r => {
              const latest = latestEventByRun[r.id];
              const pendingCount = pendingInteractionsByRun[r.id]?.length ?? 0;
              const isStoppable = r.status === "running" || r.status === "queued";
              const isCancelling = cancelling[r.id] ?? false;
              return (
                <li
                  key={r.id}
                  className="list-item with-hover-action"
                  onClick={() => setCenterView({ kind: "run", runId: r.id })}
                  style={{ cursor: "pointer" }}
                >
                  <div className="list-item-row">
                    <span
                      className="list-item-title"
                      style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
                    >
                      {r.name}
                      {pendingCount > 0 && (
                        <span
                          className="badge"
                          title={`${pendingCount} pending question(s)`}
                        >
                          {pendingCount}
                        </span>
                      )}
                    </span>
                    <span
                      className="list-item-row-tail"
                      style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
                    >
                      {isStoppable && (
                        <button
                          type="button"
                          className="btn-stop-mini"
                          disabled={isCancelling}
                          title="Stop this run"
                          onClick={e => {
                            e.stopPropagation();
                            cancelRun(r.id).catch(() => {
                              // Error is surfaced via cancelling-flag reset; silent here.
                            });
                          }}
                        >
                          {isCancelling ? "…" : "■"}
                        </button>
                      )}
                      <span className={`status ${r.status}`}>{r.status}</span>
                    </span>
                  </div>
                  <div className="progress">
                    <div className="progress-bar" style={{ width: `${Math.round(r.progress * 100)}%` }} />
                  </div>
                  {latest && (
                    <div className="list-item-meta" style={{ fontFamily: "monospace", fontSize: "0.8em" }}>
                      {eventLine(latest)}
                    </div>
                  )}
                  <div className="list-item-meta">started {new Date(r.startedAt).toLocaleTimeString()}</div>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </aside>
  );
}
