import { useState } from "react";
import { api } from "../../api/client";
import { useStore } from "../../store/useStore";
import ModelPicker from "../ModelPicker";

export default function NewChatView() {
  const [draft, setDraft] = useState("");
  const [model, setModel] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { setCenterView, loadConversations } = useStore();

  async function send() {
    if (!draft.trim() || busy) return;
    setBusy(true);
    try {
      const conv = await api.createConversation();
      await api.sendMessage(conv.id, draft, model);
      // refresh full conversation into cache via store
      const full = await api.getConversation(conv.id);
      useStore.setState(s => ({
        conversationCache: { ...s.conversationCache, [conv.id]: full }
      }));
      await loadConversations();
      setCenterView({ kind: "conversation", conversationId: conv.id });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="view new-chat">
      <div className="view-header">
        <h2>New chat</h2>
        <p className="muted">Ask me anything, or pick an agent from the left.</p>
      </div>
      <div className="composer">
        <textarea
          placeholder="Type your message…"
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) send();
          }}
        />
        <div className="composer-row">
          <span className="muted">⌘/Ctrl+Enter to send</span>
          <div className="composer-actions">
            <ModelPicker value={model} onChange={setModel} placeholder="Model…" />
            <button className="btn primary" onClick={send} disabled={busy}>
              {busy ? "Sending…" : "Send"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
