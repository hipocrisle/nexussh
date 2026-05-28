import { useState, useEffect, useRef } from "react";
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
import { SFTPPanel } from "./SFTPPanel";
import type { ConnectArgs } from "./ssh";
import { TabPicker } from "./TabPicker";
import { UpdatePanel } from "./UpdatePanel";
import { ContextMenu, MenuItem } from "./ContextMenu";
import { buildAppContextMenu } from "./contextMenuItems";
import { HostInfoCard } from "./HostInfoCard";
import { HostDialog } from "./HostDialog";
import { SettingsScreen } from "./SettingsScreen";
import { TranscriptOverlay } from "./TranscriptOverlay";
import { useSettings } from "./settings/settings-store";
import { THEMES, applyTheme } from "./settings/themes";
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

  // Pump the full palette (incl. new depth/glow tokens) to :root + toggle the
  // theme-<id> class, so tokens.css @theme utilities and .theme-light overrides
  // resolve globally. Runs at mount and on every theme change.
  useEffect(() => {
    applyTheme(settings.theme);
  }, [settings.theme]);

  const [version, setVersion] = useState<string>("");
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [vault, setVault] = useState<VaultStatus | null>(null);
  const [vaultPanelOpen, setVaultPanelOpen] = useState(false);
  const [sync, setSync] = useState<SyncStatus | null>(null);
  const [syncPanelOpen, setSyncPanelOpen] = useState(false);
  const [historyPanelOpen, setHistoryPanelOpen] = useState(false);
  const [sftpTarget, setSftpTarget] = useState<{
    args: ConnectArgs;
    title: string;
  } | null>(null);
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
  // Per-tab scrollback overlay state. When a tab id is in this set, the
  // active TerminalView is hidden behind a TranscriptOverlay that lets the
  // user wheel-scroll through everything written so far (works even in
  // alt-screen mode like Claude Code).
  const [transcriptTabs, setTranscriptTabs] = useState<Set<string>>(
    () => new Set<string>(),
  );
  function toggleTranscript(tabId: string) {
    setTranscriptTabs((prev) => {
      const next = new Set(prev);
      if (next.has(tabId)) next.delete(tabId);
      else next.add(tabId);
      return next;
    });
  }

  function toggleSidebar() {
    const next = !sidebarCollapsed;
    setSidebarCollapsed(next);
    writeSidebarCollapsed(next);
  }

  // Read app version once
  useEffect(() => {
    getVersion().then(setVersion).catch(() => setVersion("0.0.0"));
  }, []);

  // restoreSession — on first mount, if enabled, reopen the hosts that were
  // open last time. We persist host IDs (not session IDs, since the live
  // PTY dies with the process).
  const restoredRef = useRef(false);
  useEffect(() => {
    if (restoredRef.current) return;
    restoredRef.current = true;
    if (!settings.restoreSession) return;
    try {
      const raw = localStorage.getItem("nexussh.lastTabs");
      if (!raw) return;
      const ids: string[] = JSON.parse(raw);
      if (!Array.isArray(ids) || ids.length === 0) return;
      // Fire dialed reconnects sequentially so the order matches what the
      // user had. Use async IIFE so we await listHosts once.
      (async () => {
        const { listHosts } = await import("./hosts");
        const all = await listHosts();
        for (const id of ids) {
          const h = all.find((x) => x.id === id);
          if (h) {
            // openHost is async but we don't await — let them connect in
            // parallel after we've kicked them all off
            openHost(h);
          }
        }
      })();
    } catch {
      /* ignore — restoreSession is best-effort */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep localStorage in sync with the current open-tab host ids so the
  // next launch can restore them.
  useEffect(() => {
    if (!settings.restoreSession) return;
    const ids = tabs.map((t_) => t_.host.id);
    localStorage.setItem("nexussh.lastTabs", JSON.stringify(ids));
  }, [tabs, settings.restoreSession]);

  // Auto-update check on mount (once per 24h, silent on failure).
  useEffect(() => {
    maybeAutoCheck()
      .then((info) => {
        if (info) setUpdatePanel({ initial: info });
      })
      .catch(() => {});
  }, []);

  // Global hotkeys: Ctrl/Cmd+T (picker), Ctrl/Cmd+, (settings),
  // Ctrl+Shift+Up (open transcript overlay for active tab).
  //
  // IMPORTANT: use CAPTURE phase. xterm.js attaches its own keydown listener
  // on the helper textarea and forwards keys to the PTY before bubble-phase
  // handlers run. Without capture, Ctrl+Shift+Up was being eaten by xterm
  // and never reached our toggle.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const meta = e.ctrlKey || e.metaKey;
      if (meta && e.key.toLowerCase() === "t") {
        e.preventDefault();
        e.stopPropagation();
        setPickerOpen(true);
      } else if (meta && e.key === ",") {
        e.preventDefault();
        e.stopPropagation();
        setSettingsOpen((v) => !v);
      } else if (
        e.ctrlKey &&
        e.shiftKey &&
        (e.key === "ArrowUp" || e.key === "Up")
      ) {
        if (activeId) {
          e.preventDefault();
          e.stopPropagation();
          toggleTranscript(activeId);
        }
      } else if (
        e.ctrlKey &&
        e.shiftKey &&
        !e.altKey &&
        !e.metaKey &&
        (e.key.toLowerCase() === "c" || e.key.toLowerCase() === "i" || e.key === "J")
      ) {
        // Block WebView's "Inspect Element" / DevTools shortcuts so they
        // don't shadow our Ctrl+Shift+C copy. preventDefault only — we DON'T
        // stopPropagation, so the event still bubbles to xterm whose own
        // attachCustomKeyEventHandler does the actual term.getSelection() →
        // clipboard write. (DOM window.getSelection() returns empty for
        // xterm canvases; only xterm knows the selection.)
        e.preventDefault();
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [activeId]);

  // Suppress the WebView's native context menu everywhere and replace it
  // with our own. The native one ships "Print", "Share", "Copy link to
  // highlight" (Tauri URL garbage), "Other tools" (empty) etc. — none of
  // which make sense in a terminal client. Terminal area has its own custom
  // menu already (built in Terminal.tsx); for the rest of the app we show
  // contextual Copy / Cut / Paste / Select All based on selection + target.
  useEffect(() => {
    const onContextMenu = (e: MouseEvent) => {
      // Terminal.tsx attaches a contextmenu listener on its container and
      // calls preventDefault + opens its own menu — by the time the event
      // bubbles up to us, defaultPrevented is true.
      if (e.defaultPrevented) return;
      const target = e.target as HTMLElement | null;
      if (target?.closest(".xterm, .xterm-helper-textarea")) {
        e.preventDefault();
        return;
      }
      e.preventDefault();
      const items = buildAppContextMenu(target, t);
      if (items.length > 0) {
        setMenu({ x: e.clientX, y: e.clientY, items });
      }
    };
    window.addEventListener("contextmenu", onContextMenu);
    return () => window.removeEventListener("contextmenu", onContextMenu);
    // t comes from useTranslation; it is stable across renders for the
    // same language, so re-binding on language change is desirable.
  }, [t]);

  // Poll vault + sync status on mount
  useEffect(() => {
    vaultStatus().then(setVault).catch(() => {});
    syncStatus().then(setSync).catch(() => {});
  }, []);

  async function openHost(h: HostRecord) {
    setError(null);
    // If user opted to always ask for password, prompt before opening tab.
    let auth = h.auth;
    if (h.auth.kind === "password" && h.alwaysAskPassword) {
      const entered = window.prompt(
        t("app.password_prompt", { user: h.user, host: h.host }),
      );
      if (entered === null) return; // cancelled
      auth = { kind: "password", password: entered };
    }
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
        auth,
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

  function openSftp(h: HostRecord) {
    setError(null);
    let auth = h.auth;
    if (h.auth.kind === "password" && h.alwaysAskPassword) {
      const entered = window.prompt(
        t("app.password_prompt", { user: h.user, host: h.host }),
      );
      if (entered === null) return;
      auth = { kind: "password", password: entered };
    }
    setSftpTarget({
      args: { host: h.host, port: h.port, user: h.user, auth },
      title: `${h.user}@${h.host}`,
    });
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
      // Move reconnect bookkeeping to the new session id and reset attempts.
      const prev = reconnectRef.current.get(tabId);
      reconnectRef.current.delete(tabId);
      if (prev?.timer != null) window.clearTimeout(prev.timer);
      reconnectRef.current.set(sid, { attempts: 0, timer: null });
      setActiveId(sid);
    } catch (e) {
      setError(String(e));
      setTabs((all) =>
        all.map((x) =>
          x.id === tabId ? { ...x, status: "closed" as const } : x,
        ),
      );
      // restartSession failure also triggers another backoff if eligible.
      const failedTab = tabs.find((x) => x.id === tabId);
      if (failedTab && settings.autoReconnect) scheduleReconnect(failedTab);
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
          label: transcriptTabs.has(tabId)
            ? t("tabmenu.exit_transcript")
            : t("tabmenu.open_transcript"),
          onClick: () => toggleTranscript(tabId),
        },
        {
          label: t("tabmenu.restart"),
          onClick: () => restartSession(tabId),
          disabled: tab.status === "connecting",
        },
        {
          label: t("tabmenu.duplicate"),
          onClick: () => openHost(tab.host),
        },
        {
          label: t("sidebar.menu_sftp"),
          onClick: () => openSftp(tab.host),
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
    if (
      settings.confirmClose &&
      target &&
      (target.status === "connected" || target.status === "connecting")
    ) {
      if (
        !window.confirm(
          t("app.confirm_close_tab", { name: target.host.name }),
        )
      ) {
        return;
      }
    }
    if (target && target.status === "connected") {
      sshDisconnect(id).catch(() => {});
    }
    clearReconnect(id);
    setTabs((all) => all.filter((x) => x.id !== id));
    if (activeId === id) {
      const remaining = tabs.filter((x) => x.id !== id);
      setActiveId(remaining.length ? remaining[remaining.length - 1].id : null);
    }
  }

  // Per-tab auto-reconnect bookkeeping. Each entry tracks how many retry
  // attempts have been made + the pending setTimeout handle so we can cancel
  // when the user explicitly closes the tab.
  const reconnectRef = useRef(
    new Map<string, { attempts: number; timer: number | null }>(),
  );

  const RECONNECT_DELAYS = [2000, 4000, 8000, 16000, 30000];

  function clearReconnect(id: string) {
    const r = reconnectRef.current.get(id);
    if (r?.timer != null) window.clearTimeout(r.timer);
    reconnectRef.current.delete(id);
  }

  function scheduleReconnect(tab: Tab) {
    if (!settings.autoReconnect) return;
    const prev = reconnectRef.current.get(tab.id) ?? { attempts: 0, timer: null };
    if (prev.attempts >= RECONNECT_DELAYS.length) {
      setError(t("app.autoreconnect_gave_up", { name: tab.host.name }));
      clearReconnect(tab.id);
      return;
    }
    const delay = RECONNECT_DELAYS[prev.attempts];
    const timer = window.setTimeout(() => {
      prev.attempts += 1;
      restartSession(tab.id);
    }, delay);
    reconnectRef.current.set(tab.id, { attempts: prev.attempts, timer });
  }

  function markClosed(id: string, reason: string) {
    setTabs((all) =>
      all.map((x) => (x.id === id ? { ...x, status: "closed" } : x)),
    );
    // Auto-reconnect only on UNEXPECTED close (network drop, server-side EOF
    // etc.). Don't retry when the user themselves closed the session.
    const userInitiated = reason === "user disconnected";
    if (userInitiated) {
      clearReconnect(id);
      return;
    }
    const tab = tabs.find((x) => x.id === id);
    if (tab) scheduleReconnect(tab);
  }

  // Propagate active theme as CSS variables on the root, so every Tailwind
  // arbitrary-value class anywhere in the tree (e.g. `bg-[var(--nx-bg-base)]`)
  // re-themes for free when the user picks a different palette.
  const themeStyle = {
    "--nx-bg-base": theme.bgBase,
    "--nx-bg-secondary": theme.bgSecondary,
    "--nx-bg-panel": theme.bgPanel,
    "--nx-bg-elevated": theme.bgElevated,
    "--nx-border": theme.border,
    "--nx-text-primary": theme.textPrimary,
    "--nx-text-muted": theme.textMuted,
    "--nx-text-soft": theme.textSoft,
    "--nx-accent": theme.accent,
    "--nx-accent2": theme.accent2,
    "--nx-warning": theme.warning,
    "--nx-error": theme.error,
    background: theme.bgBase,
    color: theme.textPrimary,
    fontFamily: fontStack,
  } as React.CSSProperties;

  return (
    <main className="h-full w-full flex flex-col relative" style={themeStyle}>
      {/* Matrix Rain — rendered inside the terminal-area container below so
       *  the cascade only appears there. Header, sidebar, modals stay clean. */}

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
          onSftp={openSftp}
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
            {/* Matrix Rain ONLY in the terminal area, never over header/
             *  sidebar/inputs. mix-blend-mode: screen + pointer-events-none
             *  means clicks/wheel pass through and content stays readable. */}
            <div className="pointer-events-none absolute inset-0 z-30">
              <MatrixRain
                enabled={settings.rainOn}
                density={settings.rainDensity}
                opacity={settings.rainOpacity}
                accent={theme.accent}
                fade={theme.bgBase}
              />
            </div>
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
                  onSessionClosed={(reason) => markClosed(t_.id, reason)}
                  onContextMenu={(x, y, items) => setMenu({ x, y, items })}
                />
              ),
            )}
            {/* Transcript overlay for the active tab when toggled */}
            {activeId &&
              transcriptTabs.has(activeId) &&
              (() => {
                const t_ = tabs.find((x) => x.id === activeId);
                if (!t_) return null;
                return (
                  <TranscriptOverlay
                    sessionId={activeId}
                    hostLabel={`${t_.host.user}@${t_.host.host}`}
                    onClose={() => toggleTranscript(activeId)}
                    onContextMenu={(x, y, items) => setMenu({ x, y, items })}
                  />
                );
              })()}
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
      {sftpTarget && (
        <SFTPPanel
          connectArgs={sftpTarget.args}
          title={sftpTarget.title}
          onClose={() => setSftpTarget(null)}
        />
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

      {/* Settings as an OVERLAY (not a return-replacement) so TerminalView
       *  stays mounted underneath — opening Settings no longer disconnects
       *  the active SSH session. */}
      {settingsOpen && (
        <div className="fixed inset-0 z-40">
          <SettingsScreen
            onClose={() => setSettingsOpen(false)}
            sessionCount={tabs.length}
          />
        </div>
      )}
    </main>
  );
}

export default App;
