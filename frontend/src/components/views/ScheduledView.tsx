import { useStore } from "../../store/useStore";

export default function ScheduledView({ taskId }: { taskId: string }) {
  const task = useStore(s => s.scheduled.find(t => t.id === taskId));
  if (!task) return <div className="view"><p className="muted">Scheduled task not found.</p></div>;

  return (
    <div className="view scheduled">
      <div className="view-header">
        <h2>{task.name}</h2>
        <p className="muted">{task.description}</p>
      </div>
      <dl className="kv">
        <dt>Cron</dt>
        <dd><code>{task.cron}</code></dd>
        <dt>Next run</dt>
        <dd>{new Date(task.nextRun).toLocaleString()}</dd>
      </dl>
      <div className="form-actions">
        <button className="btn">Run now</button>
        <button className="btn ghost">Edit</button>
      </div>
    </div>
  );
}
