import { useEffect, useState } from "react";
import { useStore } from "../../store/useStore";
import ModelPicker from "../ModelPicker";

export default function ConversationView({ conversationId }: { conversationId: string }) {
  const conv = useStore(s => s.conversationCache[conversationId]);
  const { loadConversation, sendMessage } = useStore();
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  // Local model selection. Initialised from the conversation when it loads,
  // so the picker reflects the sticky last-used model.
  const [model, setModel] = useState<string | null>(null);
  const [modelInitialized, setModelInitialized] = useState(false);

  useEffect(() => {
    if (!conv) loadConversation(conversationId);
  }, [conversationId, conv, loadConversation]);

  useEffect(() => {
    if (conv && !modelInitialized) {
      setModel(conv.model ?? null);
      setModelInitialized(true);
    }
  }, [conv, modelInitialized]);

  async function onSend() {
    if (!draft.trim() || busy) return;
    setBusy(true);
    try {
      await sendMessage(conversationId, draft, model);
      setDraft("");
    } finally {
      setBusy(false);
    }
  }

  if (!conv) return <div className="view"><p className="muted">Loading…</p></div>;

  return (
    <div className="view conversation">
      <div className="view-header">
        <h2>{conv.title}</h2>
        <p className="muted">Updated {new Date(conv.updatedAt).toLocaleString()}</p>
      </div>
      <div className="messages">
        {conv.messages.map(m => (
          <div key={m.id} className={`message ${m.role}`}>
            <div className="message-role">{m.role}</div>
            <div className="message-content">{m.content}</div>
          </div>
        ))}
      </div>
      <div className="composer">
        <textarea
          placeholder="Reply…"
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) onSend();
          }}
        />
        <div className="composer-row">
          <span className="muted">⌘/Ctrl+Enter to send</span>
          <div className="composer-actions">
            <ModelPicker value={model} onChange={setModel} placeholder="Model…" />
            <button className="btn primary" onClick={onSend} disabled={busy}>
              {busy ? "Sending…" : "Send"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
