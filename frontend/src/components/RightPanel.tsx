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
    setCenterView
  } = useStore();

  useEffect(() => {
    connectFirehose();
  }, [connectFirehose]);

  return (
    <aside className={`panel right ${rightCollapsed ? "collapsed" : ""}`}>
      <div className="panel-header">
        <button className="collapse-btn" onClick={toggleRight} title={rightCollapsed ? "Expand" : "Collapse"}>
          {rightCollapsed ? "‹" : "›"}
        </button>
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
              return (
                <li
                  key={r.id}
                  className="list-item"
                  onClick={() => setCenterView({ kind: "run", runId: r.id })}
                  style={{ cursor: "pointer" }}
                >
                  <div className="list-item-row">
                    <span className="list-item-title">{r.name}</span>
                    <span className={`status ${r.status}`}>{r.status}</span>
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
