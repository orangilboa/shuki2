import { useEffect } from "react";
import Header from "./components/Header";
import Footer from "./components/Footer";
import LeftPanel from "./components/LeftPanel";
import RightPanel from "./components/RightPanel";
import CenterPanel from "./components/CenterPanel";
import { useStore } from "./store/useStore";

export default function App() {
  const {
    loadConversations,
    loadScheduled,
    loadAgents,
    loadRunning,
    loadEndpoints,
    loadModels,
    leftCollapsed,
    rightCollapsed
  } = useStore();

  useEffect(() => {
    loadConversations();
    loadScheduled();
    loadAgents();
    loadRunning();
    loadEndpoints();
    loadModels();
  }, [
    loadConversations,
    loadScheduled,
    loadAgents,
    loadRunning,
    loadEndpoints,
    loadModels
  ]);

  return (
    <div className="app">
      <Header />
      <div
        className="body"
        style={{
          gridTemplateColumns: `${leftCollapsed ? 44 : 280}px 1fr ${rightCollapsed ? 44 : 320}px`
        }}
      >
        <LeftPanel />
        <CenterPanel />
        <RightPanel />
      </div>
      <Footer />
    </div>
  );
}
