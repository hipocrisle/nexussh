import { useState } from "react";
import { Sidebar } from "./Sidebar";
import { TabBar, TabInfo } from "./TabBar";
import { TerminalView } from "./Terminal";
import { sshConnect, sshDisconnect } from "./ssh";
import { HostRecord, bumpLastUsed } from "./hosts";
import "./App.css";

interface Tab extends TabInfo {
  host: HostRecord;
}

function App() {
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function openHost(h: HostRecord) {
    setError(null);
    // Placeholder tab while connecting — we'll swap its id once we have one
    const pending: Tab = {
      id: "pending-" + crypto.randomUUID(),
      title: h.name,
      status: "connecting",
      host: h,
    };
    setTabs((t) => [...t, pending]);
    setActiveId(pending.id);
    try {
      const sid = await sshConnect({
        host: h.host,
        port: h.port,
        user: h.user,
        auth: h.auth,
      });
      bumpLastUsed(h.id).catch(() => {});
      setTabs((t) =>
        t.map((x) =>
          x.id === pending.id ? { ...x, id: sid, status: "connected" } : x,
        ),
      );
      setActiveId(sid);
    } catch (e) {
      setTabs((t) => t.filter((x) => x.id !== pending.id));
      setError(String(e));
    }
  }

  async function closeTab(id: string) {
    const t = tabs.find((x) => x.id === id);
    if (t && t.status === "connected") {
      sshDisconnect(id).catch(() => {});
    }
    setTabs((all) => all.filter((x) => x.id !== id));
    if (activeId === id) {
      const remaining = tabs.filter((x) => x.id !== id);
      setActiveId(remaining.length ? remaining[remaining.length - 1].id : null);
    }
  }

  function markClosed(id: string) {
    setTabs((all) =>
      all.map((x) => (x.id === id ? { ...x, status: "closed" } : x)),
    );
  }

  return (
    <main className="h-full w-full flex flex-col bg-[#0a0e0e]">
      {/* Top bar */}
      <header className="h-9 border-b border-[#1f3a3a] flex items-center px-4 select-none shrink-0">
        <span className="text-[#00ff95] font-mono text-sm tracking-wider">
          NexuSSH
        </span>
        <span className="ml-2 text-[#4a5560] font-mono text-xs">v0.0.1</span>
      </header>

      <div className="flex-1 min-h-0 flex">
        <Sidebar onConnect={openHost} />
        <div className="flex-1 min-w-0 flex flex-col">
          <TabBar
            tabs={tabs}
            activeId={activeId}
            onSelect={setActiveId}
            onClose={closeTab}
          />
          <div className="flex-1 min-h-0 relative">
            {tabs.length === 0 && (
              <div className="absolute inset-0 flex items-center justify-center text-[#4a5560] font-mono text-sm pointer-events-none">
                {error ? (
                  <div className="text-[#ff6b6b] max-w-md text-center">
                    ✗ {error}
                  </div>
                ) : (
                  <span>&gt; select a host on the left to connect</span>
                )}
              </div>
            )}
            {tabs.map((t) =>
              t.status === "connecting" ? (
                t.id === activeId ? (
                  <div
                    key={t.id}
                    className="absolute inset-0 flex items-center justify-center text-[#f5d76e] font-mono text-sm"
                  >
                    connecting to {t.host.user}@{t.host.host}:{t.host.port}...
                  </div>
                ) : null
              ) : (
                <TerminalView
                  key={t.id}
                  sessionId={t.id}
                  visible={t.id === activeId}
                  onSessionClosed={() => markClosed(t.id)}
                />
              ),
            )}
          </div>
        </div>
      </div>
    </main>
  );
}

export default App;
