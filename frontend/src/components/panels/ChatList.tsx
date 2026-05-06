import { useStore } from "../../store/useStore";

export default function ChatList() {
  const { conversations, setCenterView, startNewChat, centerView } = useStore();

  return (
    <div className="section">
      <div className="section-header">
        <span className="section-title">Conversations</span>
        <button className="link-btn" onClick={startNewChat}>+ New</button>
      </div>
      <ul className="list">
        {conversations.map(c => {
          const active = centerView.kind === "conversation" && centerView.conversationId === c.id;
          return (
            <li
              key={c.id}
              className={`list-item clickable ${active ? "active" : ""}`}
              onClick={() => setCenterView({ kind: "conversation", conversationId: c.id })}
            >
              <div className="list-item-title">{c.title}</div>
              <div className="list-item-preview">{c.preview}</div>
              <div className="list-item-meta">{new Date(c.updatedAt).toLocaleDateString()}</div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
