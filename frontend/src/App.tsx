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
    rightCollapsed,
    setCenterView
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

  // Desktop tray-mode notifications dispatch this event when a toast is
  // clicked; navigate the center panel to the relevant run.
  useEffect(() => {
    const handler = (e: Event): void => {
      const ce = e as CustomEvent<{ runId?: string }>;
      const runId = ce.detail?.runId;
      if (typeof runId === "string" && runId.length > 0) {
        setCenterView({ kind: "run", runId });
      }
    };
    window.addEventListener("openshuki:open-run", handler);
    return () => window.removeEventListener("openshuki:open-run", handler);
  }, [setCenterView]);

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
