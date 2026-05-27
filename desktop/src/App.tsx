import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import {
  Lock,
  Unlock,
  KeyRound,
  RefreshCw,
  History,
  Settings as SettingsIcon,
} from "lucide-react";
import { Sidebar } from "./Sidebar";
import { TabBar, TabInfo } from "./TabBar";
import { TerminalView } from "./Terminal";
import { LanguageSwitcher } from "./LanguageSwitcher";
import { VaultPanel } from "./VaultPanel";
import { SyncPanel } from "./SyncPanel";
import { HistoryPanel } from "./HistoryPanel";
import { TabPicker } from "./TabPicker";
import { UpdatePanel } from "./UpdatePanel";
import { ContextMenu, MenuItem } from "./ContextMenu";
import { HostInfoCard } from "./HostInfoCard";
import { HostDialog } from "./HostDialog";
import { SettingsScreen } from "./SettingsScreen";
import { useSettings } from "./settings/settings-store";
import { THEMES } from "./settings/themes";
import { fontStackOf } from "./settings/fonts";
import { MatrixRain } from "./settings/MatrixRain";
import { UpdateInfo, maybeAutoCheck } from "./updater";
import { sshConnect, sshDisconnect } from "./ssh";
import { HostRecord, bumpLastUsed } from "./hosts";
import { VaultStatus, vaultStatus } from "./vault";
import { SyncStatus, syncStatus } from "./sync";
import { getVersion } from "@tauri-apps/api/app";
import "./App.css";

const SIDEBAR_COLLAPSED_LS_KEY = "nexussh.sidebarCollapsed";

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
  const [settings] = useSettings();
  const theme = THEMES[settings.theme];
  const fontStack = fontStackOf(settings.font);

  const [version, setVersion] = useState<string>("");
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [vault, setVault] = useState<VaultStatus | null>(null);
  const [vaultPanelOpen, setVaultPanelOpen] = useState(false);
  const [sync, setSync] = useState<SyncStatus | null>(null);
  const [syncPanelOpen, setSyncPanelOpen] = useState(false);
  const [historyPanelOpen, setHistoryPanelOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(
    readSidebarCollapsed(),
  );
  const [updatePanel, setUpdatePanel] = useState<
    null | { initial?: UpdateInfo | null }
  >(null);
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    items: MenuItem[];
  } | null>(null);
  const [selectedHost, setSelectedHost] = useState<HostRecord | null>(null);
  const [editHost, setEditHost] = useState<HostRecord | null>(null);

  function toggleSidebar() {
    const next = !sidebarCollapsed;
    setSidebarCollapsed(next);
    writeSidebarCollapsed(next);
  }

  // Read app version once
  useEffect(() => {
    getVersion().then(setVersion).catch(() => setVersion("0.0.0"));
  }, []);

  // Auto-update check on mount (once per 24h, silent on failure).
  useEffect(() => {
    maybeAutoCheck()
      .then((info) => {
        if (info) setUpdatePanel({ initial: info });
      })
      .catch(() => {});
  }, []);

  // Global hotkeys: Ctrl/Cmd+T (picker), Ctrl/Cmd+, (settings).
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const meta = e.ctrlKey || e.metaKey;
      if (meta && e.key.toLowerCase() === "t") {
        e.preventDefault();
        setPickerOpen(true);
      } else if (meta && e.key === ",") {
        e.preventDefault();
        setSettingsOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  // Suppress default WebView context menu everywhere except input/textarea/
  // contenteditable. Use closest() so we still allow native menu when the
  // click target is a wrapping span inside the input (some browser engines
  // bubble the contextmenu to the visible element).
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        target.closest("input, textarea, [contenteditable='true']")
      ) {
        return;
      }
      e.preventDefault();
    };
    // Capture phase so we run before any other listener might re-fire.
    window.addEventListener("contextmenu", handler, true);
    return () => window.removeEventListener("contextmenu", handler, true);
  }, []);

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

  async function restartSession(tabId: string) {
    const tab = tabs.find((x) => x.id === tabId);
    if (!tab) return;
    if (tab.status === "connected") {
      sshDisconnect(tabId).catch(() => {});
    }
    setTabs((all) =>
      all.map((x) =>
        x.id === tabId ? { ...x, status: "connecting" as const } : x,
      ),
    );
    try {
      const sid = await sshConnect({
        host: tab.host.host,
        port: tab.host.port,
        user: tab.host.user,
        auth: tab.host.auth,
      });
      bumpLastUsed(tab.host.id).catch(() => {});
      setTabs((all) =>
        all.map((x) =>
          x.id === tabId ? { ...x, id: sid, status: "connected" as const } : x,
        ),
      );
      setActiveId(sid);
    } catch (e) {
      setError(String(e));
      setTabs((all) =>
        all.map((x) =>
          x.id === tabId ? { ...x, status: "closed" as const } : x,
        ),
      );
    }
  }

  function onTabContextMenu(tabId: string, x: number, y: number) {
    const tab = tabs.find((x) => x.id === tabId);
    if (!tab) return;
    setMenu({
      x,
      y,
      items: [
        {
          label: t("tabmenu.restart"),
          onClick: () => restartSession(tabId),
          disabled: tab.status === "connecting",
        },
        {
          label: t("tabmenu.duplicate"),
          onClick: () => openHost(tab.host),
        },
        { separator: true, label: "" },
        {
          label: t("tabmenu.close"),
          onClick: () => closeTab(tabId),
          destructive: true,
        },
        {
          label: t("tabmenu.close_others"),
          onClick: () => {
            tabs.filter((x) => x.id !== tabId).forEach((x) => closeTab(x.id));
          },
          disabled: tabs.length <= 1,
          destructive: true,
        },
      ],
    });
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

  // Full-screen Settings replaces the main layout when open.
  if (settingsOpen) {
    return (
      <SettingsScreen
        onClose={() => setSettingsOpen(false)}
        sessionCount={tabs.length}
      />
    );
  }

  return (
    <main
      className="h-full w-full flex flex-col relative"
      style={{
        background: theme.bgBase,
        color: theme.textPrimary,
        fontFamily: fontStack,
      }}
    >
      {/* Optional Matrix Rain background */}
      <div className="absolute inset-0 pointer-events-none">
        <MatrixRain
          enabled={settings.rainOn}
          density={settings.rainDensity}
          opacity={settings.rainOpacity}
          accent={theme.accent}
          fade={theme.bgBase}
        />
      </div>

      <header
        className="relative z-10 h-9 border-b flex items-center px-4 select-none shrink-0"
        style={{ background: theme.bgSecondary, borderColor: theme.border }}
      >
        <span
          className="font-mono text-sm tracking-wider"
          style={{ color: theme.accent }}
        >
          NexuSSH
        </span>
        <span
          className="ml-2 font-mono text-xs"
          style={{ color: theme.textMuted }}
        >
          v{version}
        </span>
        <span
          className="ml-3 font-mono text-xs italic"
          style={{ color: theme.textMuted }}
        >
          {t("app.tagline")}
        </span>
        <button
          onClick={() => setHistoryPanelOpen(true)}
          title={t("history.open_panel")}
          className="ml-auto flex items-center gap-1.5 px-2 py-0.5 rounded hover:bg-opacity-50 font-mono text-xs"
          style={{ color: theme.textSoft }}
        >
          <History size={12} />
          <span>{t("history.button")}</span>
        </button>
        <button
          onClick={() => setSyncPanelOpen(true)}
          title={t("sync.open_panel")}
          className="ml-3 flex items-center gap-1.5 px-2 py-0.5 rounded hover:bg-opacity-50 font-mono text-xs"
          style={{
            color: sync?.unlocked
              ? theme.accent
              : sync?.configured
                ? theme.warning
                : theme.textMuted,
          }}
        >
          <RefreshCw size={12} />
          <span>sync</span>
        </button>
        {settings.advanced && (
          <button
            onClick={() => setVaultPanelOpen(true)}
            title={t("vault.open_panel")}
            className="ml-3 flex items-center gap-1.5 px-2 py-0.5 rounded hover:bg-opacity-50 font-mono text-xs"
            style={{
              color: vault?.unlocked
                ? theme.accent
                : vault?.configured
                  ? theme.warning
                  : theme.textMuted,
            }}
          >
            {vault?.unlocked ? (
              <Unlock size={12} />
            ) : vault?.configured ? (
              <Lock size={12} />
            ) : (
              <KeyRound size={12} />
            )}
            <span>vault</span>
          </button>
        )}
        <button
          onClick={() => setSettingsOpen(true)}
          title={t("settings.open") + " (Ctrl ,)"}
          className="ml-3 flex items-center gap-1.5 px-2 py-0.5 rounded hover:bg-opacity-50 font-mono text-xs"
          style={{ color: theme.textMuted }}
        >
          <SettingsIcon size={12} />
        </button>
        <div className="ml-3">
          <LanguageSwitcher />
        </div>
      </header>

      <div className="relative z-10 flex-1 min-h-0 flex">
        <Sidebar
          onConnect={openHost}
          onSelect={setSelectedHost}
          selectedId={selectedHost?.id ?? null}
          collapsed={sidebarCollapsed}
          onToggleCollapsed={toggleSidebar}
          onContextMenu={(x, y, items) => setMenu({ x, y, items })}
          clickMode={settings.clickMode}
        />
        <div className="flex-1 min-w-0 flex flex-col">
          <TabBar
            tabs={tabs}
            activeId={activeId}
            onSelect={setActiveId}
            onClose={closeTab}
            onNewTab={() => setPickerOpen(true)}
            onContextMenu={onTabContextMenu}
          />
          <div className="flex-1 min-h-0 relative">
            {tabs.length === 0 && !selectedHost && (
              <div
                className="absolute inset-0 flex items-center justify-center font-mono text-sm pointer-events-none"
                style={{ color: theme.textMuted }}
              >
                {error ? (
                  <div
                    className="max-w-md text-center"
                    style={{ color: theme.error }}
                  >
                    ✗ {error}
                  </div>
                ) : (
                  <span>&gt; {t("terminal.select_host")}</span>
                )}
              </div>
            )}
            {tabs.length === 0 && selectedHost && (
              <HostInfoCard
                host={selectedHost}
                onConnect={() => openHost(selectedHost)}
                onEdit={() => setEditHost(selectedHost)}
              />
            )}
            {tabs.map((t_) =>
              t_.status === "connecting" ? (
                t_.id === activeId ? (
                  <div
                    key={t_.id}
                    className="absolute inset-0 flex items-center justify-center font-mono text-sm"
                    style={{ color: theme.warning }}
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
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={menu.items}
          onClose={() => setMenu(null)}
        />
      )}
      {editHost && (
        <HostDialog
          initial={editHost}
          onClose={() => setEditHost(null)}
          onSaved={(saved) => {
            setSelectedHost(saved);
            setEditHost(null);
          }}
        />
      )}
    </main>
  );
}

export default App;
