import { useStore } from "../store/useStore";
import ChatList from "./panels/ChatList";
import ScheduledList from "./panels/ScheduledList";
import AgentsList from "./panels/AgentsList";
import type { LeftTab } from "../types";
import chatsIcon from "../assets/chats.svg";
import clockIcon from "../assets/clock.svg";
import agentsIcon from "../assets/agents.svg";

const TABS: { id: LeftTab; label: string; icon: string; title: string }[] = [
  { id: "chats", label: "Chats", icon: chatsIcon, title: "Conversations" },
  { id: "scheduled", label: "Scheduled", icon: clockIcon, title: "Scheduled tasks" },
  { id: "agents", label: "Agents", icon: agentsIcon, title: "Agents" }
];

export default function LeftPanel() {
  const { leftCollapsed, toggleLeft, leftTab, setLeftTab } = useStore();

  return (
    <aside className={`panel left ${leftCollapsed ? "collapsed" : ""}`}>
      <div className="panel-header">
        {!leftCollapsed && (
          <div className="tabs">
            {TABS.map(t => (
              <button
                key={t.id}
                className={`tab-icon ${leftTab === t.id ? "active" : ""}`}
                title={t.title}
                onClick={() => setLeftTab(t.id)}
              >
                <img src={t.icon} alt={t.label} className="tab-icon-img" />
              </button>
            ))}
          </div>
        )}
        <button className="collapse-btn" onClick={toggleLeft} title={leftCollapsed ? "Expand" : "Collapse"}>
          {leftCollapsed ? "›" : "‹"}
        </button>
      </div>
      {!leftCollapsed && (
        <div className="panel-body">
          {leftTab === "chats" && <ChatList />}
          {leftTab === "scheduled" && <ScheduledList />}
          {leftTab === "agents" && <AgentsList />}
        </div>
      )}
    </aside>
  );
}
