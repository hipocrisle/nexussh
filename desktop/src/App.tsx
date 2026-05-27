import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Lock, Unlock, KeyRound, RefreshCw, History, Settings } from "lucide-react";
import { Sidebar } from "./Sidebar";
import { TabBar, TabInfo } from "./TabBar";
import { TerminalView } from "./Terminal";
import { LanguageSwitcher } from "./LanguageSwitcher";
import { VaultPanel } from "./VaultPanel";
import { SyncPanel } from "./SyncPanel";
import { HistoryPanel } from "./HistoryPanel";
import { TabPicker } from "./TabPicker";
import { UpdatePanel } from "./UpdatePanel";
import {
  UpdateInfo,
  maybeAutoCheck,
  isAutoCheckEnabled,
  setAutoCheckEnabled,
} from "./updater";
import { sshConnect, sshDisconnect } from "./ssh";
import { HostRecord, bumpLastUsed } from "./hosts";
import { VaultStatus, vaultStatus } from "./vault";
import { SyncStatus, syncStatus } from "./sync";
import "./App.css";

const ADVANCED_LS_KEY = "nexussh.advanced";
const SIDEBAR_COLLAPSED_LS_KEY = "nexussh.sidebarCollapsed";

function readAdvanced(): boolean {
  return localStorage.getItem(ADVANCED_LS_KEY) === "1";
}

function writeAdvanced(v: boolean) {
  localStorage.setItem(ADVANCED_LS_KEY, v ? "1" : "0");
}

function readSidebarCollapsed(): boolean {
  return localStorage.getItem(SIDEBAR_COLLAPSED_LS_KEY) === "1";
}

function writeSidebarCollapsed(v: boolean) {
  localStorage.setItem(SIDEBAR_COLLAPSED_LS_KEY, v ? "1" : "0");
}

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
  const [historyPanelOpen, setHistoryPanelOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [advanced, setAdvanced] = useState<boolean>(readAdvanced());
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(
    readSidebarCollapsed(),
  );
  const [updatePanel, setUpdatePanel] = useState<
    null | { initial?: UpdateInfo | null }
  >(null);
  const [autoUpdate, setAutoUpdate] = useState<boolean>(isAutoCheckEnabled());

  function toggleSidebar() {
    const next = !sidebarCollapsed;
    setSidebarCollapsed(next);
    writeSidebarCollapsed(next);
  }

  function toggleAutoUpdate() {
    const next = !autoUpdate;
    setAutoUpdate(next);
    setAutoCheckEnabled(next);
  }

  // Auto-update check on mount (once per 24h, silent on failure).
  useEffect(() => {
    maybeAutoCheck()
      .then((info) => {
        if (info) setUpdatePanel({ initial: info });
      })
      .catch(() => {});
  }, []);

  // Ctrl/Cmd+T to open the new-tab picker.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "t") {
        e.preventDefault();
        setPickerOpen(true);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  function toggleAdvanced() {
    const next = !advanced;
    setAdvanced(next);
    writeAdvanced(next);
  }

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
          onClick={() => setHistoryPanelOpen(true)}
          title={t("history.open_panel")}
          className="ml-auto flex items-center gap-1.5 px-2 py-0.5 rounded hover:bg-[#0e1414] font-mono text-xs text-[#7fd7ff]"
        >
          <History size={12} />
          <span>{t("history.button")}</span>
        </button>
        <button
          onClick={() => setSyncPanelOpen(true)}
          title={t("sync.open_panel")}
          className="ml-3 flex items-center gap-1.5 px-2 py-0.5 rounded hover:bg-[#0e1414] font-mono text-xs"
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
        {advanced && (
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
        )}
        <button
          onClick={() => setSettingsOpen((v) => !v)}
          title={t("settings.open")}
          className="relative ml-3 flex items-center gap-1.5 px-2 py-0.5 rounded hover:bg-[#0e1414] font-mono text-xs text-[#4a5560] hover:text-[#7fd7ff]"
        >
          <Settings size={12} />
        </button>
        <div className="ml-3">
          <LanguageSwitcher />
        </div>
      </header>

      {settingsOpen && (
        <div
          className="fixed inset-0 z-40"
          onClick={() => setSettingsOpen(false)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="absolute top-9 right-32 w-72 bg-[#0a0e0e] border border-[#1f3a3a] rounded-lg shadow-2xl p-3"
          >
            <div className="text-xs uppercase tracking-wider text-[#7fd7ff] font-mono mb-2">
              {t("settings.title")}
            </div>
            <label className="flex items-start gap-2 text-xs font-mono text-[#c9d1d9] cursor-pointer p-1 rounded hover:bg-[#0e1414]">
              <input
                type="checkbox"
                checked={advanced}
                onChange={toggleAdvanced}
                className="mt-0.5 accent-[#00ff95]"
              />
              <div>
                <div>{t("settings.show_advanced")}</div>
                <div className="text-[10px] text-[#4a5560]">
                  {t("settings.show_advanced_hint")}
                </div>
              </div>
            </label>
            <label className="flex items-start gap-2 text-xs font-mono text-[#c9d1d9] cursor-pointer p-1 rounded hover:bg-[#0e1414]">
              <input
                type="checkbox"
                checked={autoUpdate}
                onChange={toggleAutoUpdate}
                className="mt-0.5 accent-[#00ff95]"
              />
              <div>
                <div>{t("settings.auto_update")}</div>
                <div className="text-[10px] text-[#4a5560]">
                  {t("settings.auto_update_hint")}
                </div>
              </div>
            </label>
            <button
              onClick={() => {
                setSettingsOpen(false);
                setUpdatePanel({});
              }}
              className="w-full mt-1 px-2 py-1.5 bg-[#0e1414] hover:bg-[#1f3a3a] text-[#7fd7ff] font-mono text-xs rounded border border-[#1f3a3a]"
            >
              {t("settings.check_for_updates")}
            </button>
          </div>
        </div>
      )}

      <div className="flex-1 min-h-0 flex">
        <Sidebar
          onConnect={openHost}
          collapsed={sidebarCollapsed}
          onToggleCollapsed={toggleSidebar}
        />
        <div className="flex-1 min-w-0 flex flex-col">
          <TabBar
            tabs={tabs}
            activeId={activeId}
            onSelect={setActiveId}
            onClose={closeTab}
            onNewTab={() => setPickerOpen(true)}
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
      {historyPanelOpen && (
        <HistoryPanel onClose={() => setHistoryPanelOpen(false)} />
      )}
      {pickerOpen && (
        <TabPicker
          onPick={openHost}
          onClose={() => setPickerOpen(false)}
        />
      )}
      {updatePanel !== null && (
        <UpdatePanel
          initial={updatePanel.initial}
          onClose={() => setUpdatePanel(null)}
        />
      )}
    </main>
  );
}

export default App;
