import { useStore } from "../store/useStore";
import NewChatView from "./views/NewChatView";
import ConversationView from "./views/ConversationView";
import AgentView from "./views/AgentView";
import OnboardingView from "./views/OnboardingView";
import ScheduledView from "./views/ScheduledView";
import RunView from "./views/RunView";
import SettingsView from "./views/SettingsView";

export default function CenterPanel() {
  const view = useStore(s => s.centerView);

  return (
    <main className="center">
      {view.kind === "new-chat" && <NewChatView />}
      {view.kind === "conversation" && <ConversationView conversationId={view.conversationId} />}
      {view.kind === "agent" && <AgentView agentId={view.agentId} />}
      {view.kind === "onboarding" && <OnboardingView agentId={view.agentId} />}
      {view.kind === "scheduled" && <ScheduledView taskId={view.taskId} />}
      {view.kind === "run" && <RunView runId={view.runId} />}
      {view.kind === "settings" && <SettingsView />}
    </main>
  );
}
