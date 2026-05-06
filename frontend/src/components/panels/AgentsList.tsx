import { useStore } from "../../store/useStore";

export default function AgentsList() {
  const { agents, setCenterView, centerView } = useStore();

  return (
    <div className="section">
      <div className="section-header">
        <span className="section-title">Agents</span>
      </div>
      <ul className="list">
        {agents.map(a => {
          const active = centerView.kind === "agent" && centerView.agentId === a.id;
          return (
            <li
              key={a.id}
              className={`list-item clickable ${active ? "active" : ""}`}
              onClick={() => setCenterView({ kind: "agent", agentId: a.id })}
            >
              <div className="list-item-title">{a.name}</div>
              <div className="list-item-preview">{a.description}</div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
