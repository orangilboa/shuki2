import { useStore } from "../../store/useStore";

export default function ScheduledList() {
  const { scheduled, setCenterView, centerView } = useStore();

  return (
    <div className="section">
      <div className="section-header">
        <span className="section-title">Scheduled tasks</span>
      </div>
      <ul className="list">
        {scheduled.map(s => {
          const active = centerView.kind === "scheduled" && centerView.taskId === s.id;
          return (
            <li
              key={s.id}
              className={`list-item clickable ${active ? "active" : ""}`}
              onClick={() => setCenterView({ kind: "scheduled", taskId: s.id })}
            >
              <div className="list-item-title">{s.name}</div>
              <div className="list-item-preview">{s.description}</div>
              <div className="list-item-meta">
                <code>{s.cron}</code> · next {new Date(s.nextRun).toLocaleString()}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
