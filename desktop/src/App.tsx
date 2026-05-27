import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Lock, Unlock, KeyRound, RefreshCw } from "lucide-react";
import { Sidebar } from "./Sidebar";
import { TabBar, TabInfo } from "./TabBar";
import { TerminalView } from "./Terminal";
import { LanguageSwitcher } from "./LanguageSwitcher";
import { VaultPanel } from "./VaultPanel";
import { SyncPanel } from "./SyncPanel";
import { sshConnect, sshDisconnect } from "./ssh";
import { HostRecord, bumpLastUsed } from "./hosts";
import { VaultStatus, vaultStatus } from "./vault";
import { SyncStatus, syncStatus } from "./sync";
import "./App.css";

interface Tab extends TabInfo {
  host: HostRecord;
}

function App() {
  const { t } = useTranslation();
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [vault, setVault] = useState<VaultStatus | null>(null);
  const [vaultPanelOpen, setVaultPanelOpen] = useState(false);
  const [sync, setSync] = useState<SyncStatus | null>(null);
  const [syncPanelOpen, setSyncPanelOpen] = useState(false);

  // Poll vault + sync status on mount
  useEffect(() => {
    vaultStatus().then(setVault).catch(() => {});
    syncStatus().then(setSync).catch(() => {});
  }, []);

  async function openHost(h: HostRecord) {
    setError(null);
    const pending: Tab = {
      id: "pending-" + crypto.randomUUID(),
      title: h.name,
      status: "connecting",
      host: h,
    };
    setTabs((tabs) => [...tabs, pending]);
    setActiveId(pending.id);
    try {
      const sid = await sshConnect({
        host: h.host,
        port: h.port,
        user: h.user,
        auth: h.auth,
      });
      bumpLastUsed(h.id).catch(() => {});
      setTabs((tabs) =>
        tabs.map((x) =>
          x.id === pending.id ? { ...x, id: sid, status: "connected" } : x,
        ),
      );
      setActiveId(sid);
    } catch (e) {
      setTabs((tabs) => tabs.filter((x) => x.id !== pending.id));
      setError(String(e));
    }
  }

  async function closeTab(id: string) {
    const target = tabs.find((x) => x.id === id);
    if (target && target.status === "connected") {
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
      <header className="h-9 border-b border-[#1f3a3a] flex items-center px-4 select-none shrink-0">
        <span className="text-[#00ff95] font-mono text-sm tracking-wider">
          NexuSSH
        </span>
        <span className="ml-2 text-[#4a5560] font-mono text-xs">
          {t("app.version_label")}0.0.1
        </span>
        <span className="ml-3 text-[#4a5560] font-mono text-xs italic">
          {t("app.tagline")}
        </span>
        <button
          onClick={() => setSyncPanelOpen(true)}
          title={t("sync.open_panel")}
          className="ml-auto flex items-center gap-1.5 px-2 py-0.5 rounded hover:bg-[#0e1414] font-mono text-xs"
        >
          <RefreshCw
            size={12}
            className={
              sync?.unlocked
                ? "text-[#00ff95]"
                : sync?.configured
                  ? "text-[#f5d76e]"
                  : "text-[#4a5560]"
            }
          />
          <span
            className={
              sync?.unlocked
                ? "text-[#00ff95]"
                : sync?.configured
                  ? "text-[#f5d76e]"
                  : "text-[#4a5560]"
            }
          >
            sync
          </span>
        </button>
        <button
          onClick={() => setVaultPanelOpen(true)}
          title={t("vault.open_panel")}
          className="ml-3 flex items-center gap-1.5 px-2 py-0.5 rounded hover:bg-[#0e1414] font-mono text-xs"
        >
          {vault?.unlocked ? (
            <Unlock size={12} className="text-[#00ff95]" />
          ) : vault?.configured ? (
            <Lock size={12} className="text-[#f5d76e]" />
          ) : (
            <KeyRound size={12} className="text-[#4a5560]" />
          )}
          <span
            className={
              vault?.unlocked
                ? "text-[#00ff95]"
                : vault?.configured
                  ? "text-[#f5d76e]"
                  : "text-[#4a5560]"
            }
          >
            vault
          </span>
        </button>
        <div className="ml-3">
          <LanguageSwitcher />
        </div>
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
                  <span>&gt; {t("terminal.select_host")}</span>
                )}
              </div>
            )}
            {tabs.map((t_) =>
              t_.status === "connecting" ? (
                t_.id === activeId ? (
                  <div
                    key={t_.id}
                    className="absolute inset-0 flex items-center justify-center text-[#f5d76e] font-mono text-sm"
                  >
                    {t("terminal.connecting_to", {
                      user: t_.host.user,
                      host: t_.host.host,
                      port: t_.host.port,
                    })}
                  </div>
                ) : null
              ) : (
                <TerminalView
                  key={t_.id}
                  sessionId={t_.id}
                  visible={t_.id === activeId}
                  onSessionClosed={() => markClosed(t_.id)}
                />
              ),
            )}
          </div>
        </div>
      </div>

      {vaultPanelOpen && (
        <VaultPanel
          onClose={() => setVaultPanelOpen(false)}
          onChange={setVault}
        />
      )}
      {syncPanelOpen && (
        <SyncPanel
          onClose={() => setSyncPanelOpen(false)}
          onChange={setSync}
        />
      )}
    </main>
  );
}

export default App;
