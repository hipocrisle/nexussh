import { useState, useEffect, useRef, Fragment } from "react";
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
import { StatusLine } from "./StatusLine";
import type { ConnectArgs } from "./ssh";
import { TabPicker } from "./TabPicker";
import { UpdatePanel } from "./UpdatePanel";
import { ContextMenu, MenuItem } from "./ContextMenu";
import { buildAppContextMenu } from "./contextMenuItems";
import { HostInfoCard } from "./HostInfoCard";
import { HostDialog } from "./HostDialog";
import { PasswordPrompt } from "./PasswordPrompt";
import { SettingsScreen } from "./SettingsScreen";
import { TranscriptOverlay } from "./TranscriptOverlay";
import { useSettings } from "./settings/settings-store";
import { THEMES, applyTheme } from "./settings/themes";
import { fontStackOf } from "./settings/fonts";
import { MatrixRain } from "./settings/MatrixRain";
import { UpdateInfo, maybeAutoCheck } from "./updater";
import { sshConnect, sshDisconnect } from "./ssh";
import type { VpnNode } from "./vpn";
import { getProfile, resolveExit } from "./vpn";
import { HostRecord, bumpLastUsed } from "./hosts";
import { VaultStatus, vaultStatus } from "./vault";
import { SyncStatus, syncStatus } from "./sync";
import { getVersion } from "@tauri-apps/api/app";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { ask } from "@tauri-apps/plugin-dialog";
import {
  Minus,
  Square,
  Copy as RestoreIcon,
  X as CloseIcon,
  Terminal as TerminalIcon,
  FolderOpen,
  Network,
  Monitor,
  AppWindow,
} from "lucide-react";
import "./App.css";

const SIDEBAR_COLLAPSED_LS_KEY = "nexussh.sidebarCollapsed";

function readSidebarCollapsed(): boolean {
  return localStorage.getItem(SIDEBAR_COLLAPSED_LS_KEY) === "1";
}
function writeSidebarCollapsed(v: boolean) {
  localStorage.setItem(SIDEBAR_COLLAPSED_LS_KEY, v ? "1" : "0");
}

const SIDEBAR_WIDTH_LS_KEY = "nexussh.sidebarWidth";
const SIDEBAR_MIN = 180;
const SIDEBAR_MAX = 560;
function readSidebarWidth(): number {
  const v = parseInt(localStorage.getItem(SIDEBAR_WIDTH_LS_KEY) ?? "", 10);
  return Number.isFinite(v) && v >= SIDEBAR_MIN && v <= SIDEBAR_MAX ? v : 256;
}

interface Tab extends TabInfo {
  host: HostRecord;
  /** Set when a connect/reconnect attempt fails — shown in the pane with a
   *  Retry button instead of the tab silently vanishing. */
  error?: string;
}

// --- Split-view model -------------------------------------------------------
// A PaneGroup is one tab-strip + its terminals (like a VS Code editor group).
// The LayoutNode tree describes how groups are arranged on screen. Stage A only
// ever builds depth-1 (a single split = two panes), but the tree + helpers are
// general so the grid (Stage C) drops in without another refactor.
interface PaneGroup {
  id: string;
  tabs: Tab[];
  activeId: string | null;
}
type LayoutNode =
  | { kind: "leaf"; groupId: string }
  | {
      kind: "split";
      id: string;
      dir: "row" | "col";
      ratio: number; // size fraction of child `a` (0..1)
      a: LayoutNode;
      b: LayoutNode;
    };

function uid(prefix: string): string {
  return prefix + "-" + crypto.randomUUID();
}

// Replace the leaf for `groupId` with `replacement` — turns a pane into a split.
function replaceLeaf(
  node: LayoutNode,
  groupId: string,
  replacement: LayoutNode,
): LayoutNode {
  if (node.kind === "leaf")
    return node.groupId === groupId ? replacement : node;
  return {
    ...node,
    a: replaceLeaf(node.a, groupId, replacement),
    b: replaceLeaf(node.b, groupId, replacement),
  };
}

// Drop the leaf for `groupId`, collapsing its parent split into the sibling.
// Returns null when the removed leaf was the entire tree.
function removeLeaf(node: LayoutNode, groupId: string): LayoutNode | null {
  if (node.kind === "leaf") return node.groupId === groupId ? null : node;
  const a = removeLeaf(node.a, groupId);
  const b = removeLeaf(node.b, groupId);
  if (a === null) return b;
  if (b === null) return a;
  return { ...node, a, b };
}

function setNodeRatio(
  node: LayoutNode,
  nodeId: string,
  ratio: number,
): LayoutNode {
  if (node.kind === "leaf") return node;
  if (node.id === nodeId) return { ...node, ratio };
  return {
    ...node,
    a: setNodeRatio(node.a, nodeId, ratio),
    b: setNodeRatio(node.b, nodeId, ratio),
  };
}

// Pane geometry, in percentages of the main area. Computed from the layout so
// terminals can live in ONE flat, never-reparented layer (positioned absolutely
// per pane) — restructuring the tree must not unmount/remount any TerminalView,
// or the xterm loses all its content. This is the core of the split-view fix.
interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}
function computeRects(node: LayoutNode, rect: Rect, out: Map<string, Rect>) {
  if (node.kind === "leaf") {
    out.set(node.groupId, rect);
    return;
  }
  if (node.dir === "row") {
    const aw = rect.width * node.ratio;
    computeRects(node.a, { ...rect, width: aw }, out);
    computeRects(
      node.b,
      { left: rect.left + aw, top: rect.top, width: rect.width - aw, height: rect.height },
      out,
    );
  } else {
    const ah = rect.height * node.ratio;
    computeRects(node.a, { ...rect, height: ah }, out);
    computeRects(
      node.b,
      { left: rect.left, top: rect.top + ah, width: rect.width, height: rect.height - ah },
      out,
    );
  }
}
interface DividerInfo {
  id: string;
  isRow: boolean;
  at: number; // % position of the split line along the split axis
  cross: number; // % start along the cross axis
  len: number; // % length along the cross axis
}
function collectDividers(node: LayoutNode, rect: Rect, out: DividerInfo[]) {
  if (node.kind === "leaf") return;
  if (node.dir === "row") {
    const aw = rect.width * node.ratio;
    out.push({ id: node.id, isRow: true, at: rect.left + aw, cross: rect.top, len: rect.height });
    collectDividers(node.a, { ...rect, width: aw }, out);
    collectDividers(
      node.b,
      { left: rect.left + aw, top: rect.top, width: rect.width - aw, height: rect.height },
      out,
    );
  } else {
    const ah = rect.height * node.ratio;
    out.push({ id: node.id, isRow: false, at: rect.top + ah, cross: rect.left, len: rect.width });
    collectDividers(node.a, { ...rect, height: ah }, out);
    collectDividers(
      node.b,
      { left: rect.left, top: rect.top + ah, width: rect.width, height: rect.height - ah },
      out,
    );
  }
}

const TABBAR_PX = 36; // h-9

function HeaderButton({
  icon,
  children,
  onClick,
  title,
  active,
  warn,
}: {
  icon: React.ReactNode;
  children?: React.ReactNode;
  onClick: () => void;
  title?: string;
  active?: boolean;
  warn?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      className={
        "flex items-center gap-1.5 px-2 py-0.5 rounded-nx-sm font-mono transition-colors duration-[80ms] hover:bg-nx-elevated hover:text-nx-text " +
        (active ? "text-nx-accent" : warn ? "text-nx-warning" : "text-nx-muted")
      }
    >
      {icon}
      {children}
    </button>
  );
}

// Custom window controls (native decorations are off — see tauri.conf.json).
// Lives flush in the top-right of the header titlebar.
function WindowControls() {
  const win = getCurrentWindow();
  const [maxed, setMaxed] = useState(false);
  useEffect(() => {
    win.isMaximized().then(setMaxed).catch(() => {});
    const unlisten = win.onResized(() => {
      win.isMaximized().then(setMaxed).catch(() => {});
    });
    return () => {
      unlisten.then((f) => f()).catch(() => {});
    };
  }, [win]);
  const btn =
    "inline-flex items-center justify-center w-11 h-9 text-nx-muted hover:bg-nx-elevated hover:text-nx-text transition-colors duration-[80ms]";
  return (
    <div className="flex items-stretch h-9 -mr-3 ml-1">
      <button className={btn} onClick={() => win.minimize()} title="Minimize">
        <Minus size={14} />
      </button>
      <button className={btn} onClick={() => win.toggleMaximize()} title="Maximize">
        {maxed ? <RestoreIcon size={12} /> : <Square size={12} />}
      </button>
      <button
        className="inline-flex items-center justify-center w-11 h-9 text-nx-muted hover:bg-nx-error hover:text-white transition-colors duration-[80ms]"
        onClick={() => win.close()}
        title="Close"
      >
        <CloseIcon size={15} />
      </button>
    </div>
  );
}

// Resolve a host's built-in-VPN choice into a concrete node (or null = direct).
function resolveHostVpn(h: HostRecord): VpnNode | null {
  if (!h.useVpn || !h.vpnProfileId) return null;
  const profile = getProfile(h.vpnProfileId);
  if (!profile) return null;
  return resolveExit(profile, h.vpnExit) ?? null;
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
  // Split-view state: a list of pane-groups + the layout tree arranging them +
  // which group currently has focus (receives new tabs / hotkeys / highlight).
  const initialGroupId = useRef(uid("g")).current;
  const [groups, setGroups] = useState<PaneGroup[]>(() => [
    { id: initialGroupId, tabs: [], activeId: null },
  ]);
  const [layout, setLayout] = useState<LayoutNode>(() => ({
    kind: "leaf",
    groupId: initialGroupId,
  }));
  const [focusedGroupId, setFocusedGroupId] = useState<string>(initialGroupId);

  // Derived views. `allTabs` flattens every group; `activeId` is the focused
  // group's active tab (the "current terminal" the rest of the app talks about).
  const allTabs = groups.flatMap((g) => g.tabs);
  const focusedGroup = groups.find((g) => g.id === focusedGroupId) ?? groups[0];
  const activeId = focusedGroup?.activeId ?? null;

  function groupOfTab(tabId: string): PaneGroup | undefined {
    return groups.find((g) => g.tabs.some((x) => x.id === tabId));
  }

  // Update one tab in place wherever it lives.
  function updateTab(tabId: string, fn: (t: Tab) => Tab) {
    setGroups((gs) =>
      gs.map((g) => ({
        ...g,
        tabs: g.tabs.map((x) => (x.id === tabId ? fn(x) : x)),
      })),
    );
  }

  // Swap a tab's id (pending → real session id) within its group, set status,
  // and make it the group's active tab.
  function promoteTab(oldId: string, newId: string, status: Tab["status"]) {
    setGroups((gs) =>
      gs.map((g) => {
        if (!g.tabs.some((x) => x.id === oldId)) return g;
        return {
          ...g,
          activeId: g.activeId === oldId ? newId : g.activeId,
          tabs: g.tabs.map((x) =>
            x.id === oldId ? { ...x, id: newId, status, error: undefined } : x,
          ),
        };
      }),
    );
  }

  // Select a tab inside `groupId` and focus that group.
  function selectTab(groupId: string, tabId: string) {
    setGroups((gs) =>
      gs.map((g) => (g.id === groupId ? { ...g, activeId: tabId } : g)),
    );
    setFocusedGroupId(groupId);
  }
  const [vault, setVault] = useState<VaultStatus | null>(null);
  const [vaultPanelOpen, setVaultPanelOpen] = useState(false);
  const [sync, setSync] = useState<SyncStatus | null>(null);
  const [syncPanelOpen, setSyncPanelOpen] = useState(false);
  const [historyPanelOpen, setHistoryPanelOpen] = useState(false);
  const [sftpTarget, setSftpTarget] = useState<{
    args: ConnectArgs;
    title: string;
  } | null>(null);
  // "Always ask password" prompt — promise-based so openHost/openSftp can await
  // a masked, themed dialog instead of the plaintext native window.prompt().
  const [pwPrompt, setPwPrompt] = useState<{
    user: string;
    host: string;
    resolve: (v: string | null) => void;
  } | null>(null);
  function askPassword(h: HostRecord): Promise<string | null> {
    return new Promise((resolve) =>
      setPwPrompt({ user: h.user, host: h.host, resolve }),
    );
  }
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerMode, setPickerMode] = useState<"ssh" | "sftp">("ssh");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(
    readSidebarCollapsed(),
  );
  const [sidebarWidth, setSidebarWidth] = useState<number>(readSidebarWidth());
  const [updatePanel, setUpdatePanel] = useState<
    null | { initial?: UpdateInfo | null }
  >(null);
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    items: MenuItem[];
    title?: { kicker?: string; main?: string };
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

  // Drag the divider between sidebar and main area. Track from pointer-down so
  // it stays accurate regardless of where the sidebar's left edge sits.
  function startSidebarResize(e: React.PointerEvent) {
    e.preventDefault();
    const startX = e.clientX;
    const startW = sidebarWidth;
    const onMove = (ev: PointerEvent) => {
      const w = Math.min(
        SIDEBAR_MAX,
        Math.max(SIDEBAR_MIN, startW + (ev.clientX - startX)),
      );
      setSidebarWidth(w);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      setSidebarWidth((w) => {
        localStorage.setItem(SIDEBAR_WIDTH_LS_KEY, String(w));
        return w;
      });
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  // Rain burst — brief full-app matrix wash on connect. Remount the overlay
  // each time (keyed) so the CSS animation replays; unmount after it ends.
  const [rainBurst, setRainBurst] = useState(0);
  const triggerBurst = () => setRainBurst((n) => n + 1);
  useEffect(() => {
    if (rainBurst === 0) return;
    const id = setTimeout(() => setRainBurst(0), 1200);
    return () => clearTimeout(id);
  }, [rainBurst]);

  // Confirm-on-quit: if any tab is live, intercept the window close and ask
  // first (user once closed everything by accident). Listener reads a ref so it
  // always sees the current tab list without re-registering.
  const tabsRef = useRef(allTabs);
  tabsRef.current = allTabs;
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    getCurrentWindow()
      .onCloseRequested(async (event) => {
        const live = tabsRef.current.filter(
          (x) => x.status === "connected" || x.status === "connecting",
        );
        if (live.length === 0) return;
        event.preventDefault();
        const ok = await ask(t("app.confirm_quit", { n: live.length }), {
          title: "NexuSSH",
          kind: "warning",
        });
        if (ok) getCurrentWindow().destroy();
      })
      .then((fn) => {
        unlisten = fn;
      });
    return () => unlisten?.();
  }, [t]);

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
    const ids = allTabs.map((t_) => t_.host.id);
    localStorage.setItem("nexussh.lastTabs", JSON.stringify(ids));
  }, [allTabs, settings.restoreSession]);

  // Drag-reorder of tabs within a single group. (Cross-group drag is Stage B.)
  function reorderTabs(fromId: string, toId: string, before: boolean) {
    if (fromId === toId) return;
    setGroups((gs) =>
      gs.map((g) => {
        if (!g.tabs.some((x) => x.id === fromId) || !g.tabs.some((x) => x.id === toId))
          return g;
        const arr = [...g.tabs];
        const from = arr.findIndex((x) => x.id === fromId);
        const [moved] = arr.splice(from, 1);
        const to = arr.findIndex((x) => x.id === toId);
        arr.splice(before ? to : to + 1, 0, moved);
        return { ...g, tabs: arr };
      }),
    );
  }

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
        setPickerMode("ssh");
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
    // If user opted to always ask for password, prompt before opening tab.
    let auth = h.auth;
    if (h.auth.kind === "password" && h.alwaysAskPassword) {
      const entered = await askPassword(h);
      if (entered === null) return; // cancelled
      auth = { kind: "password", password: entered };
    }
    const pending: Tab = {
      id: "pending-" + crypto.randomUUID(),
      title: h.name,
      status: "connecting",
      host: h,
    };
    const targetGroupId = focusedGroupId;
    setGroups((gs) =>
      gs.map((g) =>
        g.id === targetGroupId
          ? { ...g, tabs: [...g.tabs, pending], activeId: pending.id }
          : g,
      ),
    );
    try {
      const sid = await sshConnect({
        host: h.host,
        port: h.port,
        user: h.user,
        auth,
        vpn: resolveHostVpn(h),
      });
      bumpLastUsed(h.id).catch(() => {});
      promoteTab(pending.id, sid, "connected");
      triggerBurst();
    } catch (e) {
      // Keep the tab and show WHY it failed in its pane (with Retry), instead
      // of the tab silently vanishing.
      updateTab(pending.id, (x) => ({ ...x, status: "closed", error: String(e) }));
    }
  }

  async function openSftp(h: HostRecord) {
    let auth = h.auth;
    if (h.auth.kind === "password" && h.alwaysAskPassword) {
      const entered = await askPassword(h);
      if (entered === null) return;
      auth = { kind: "password", password: entered };
    }
    setSftpTarget({
      args: { host: h.host, port: h.port, user: h.user, auth },
      title: `${h.user}@${h.host}`,
    });
  }

  function openSshPicker() {
    setPickerMode("ssh");
    setPickerOpen(true);
  }

  // Caret next to "+" — choose what kind of session the new tab opens.
  // SSH / SFTP are wired; telnet / VNC / RDP are on the roadmap and shown
  // disabled with a "soon" tag so the menu reflects the plan.
  function openNewTabMenu(x: number, y: number) {
    const soon = t("tabnew.soon");
    setMenu({
      x,
      y,
      items: [
        {
          label: t("tabnew.ssh"),
          icon: <TerminalIcon size={13} />,
          onClick: openSshPicker,
        },
        {
          label: t("tabnew.sftp"),
          icon: <FolderOpen size={13} />,
          onClick: () => {
            setPickerMode("sftp");
            setPickerOpen(true);
          },
        },
        { separator: true, label: "" },
        { label: t("tabnew.telnet"), icon: <Network size={13} />, shortcut: soon, disabled: true },
        { label: t("tabnew.vnc"), icon: <Monitor size={13} />, shortcut: soon, disabled: true },
        { label: t("tabnew.rdp"), icon: <AppWindow size={13} />, shortcut: soon, disabled: true },
      ],
    });
  }

  async function restartSession(tabId: string) {
    const tab = allTabs.find((x) => x.id === tabId);
    if (!tab) return;
    if (tab.status === "connected") {
      sshDisconnect(tabId).catch(() => {});
    }
    updateTab(tabId, (x) => ({ ...x, status: "connecting", error: undefined }));
    try {
      const sid = await sshConnect({
        host: tab.host.host,
        port: tab.host.port,
        user: tab.host.user,
        auth: tab.host.auth,
        vpn: resolveHostVpn(tab.host),
      });
      bumpLastUsed(tab.host.id).catch(() => {});
      // promoteTab keeps focus where it is (no focus-steal on auto-reconnect of
      // a background pane) and only re-activates within the tab's own group.
      promoteTab(tabId, sid, "connected");
      // Move reconnect bookkeeping to the new session id and reset attempts.
      const prev = reconnectRef.current.get(tabId);
      reconnectRef.current.delete(tabId);
      if (prev?.timer != null) window.clearTimeout(prev.timer);
      reconnectRef.current.set(sid, { attempts: 0, timer: null });
    } catch (e) {
      updateTab(tabId, (x) => ({ ...x, status: "closed", error: String(e) }));
      // restartSession failure also triggers another backoff if eligible.
      const failedTab = allTabs.find((x) => x.id === tabId);
      if (failedTab && settings.autoReconnect) scheduleReconnect(failedTab);
    }
  }

  function onTabContextMenu(tabId: string, x: number, y: number) {
    const tab = allTabs.find((x) => x.id === tabId);
    if (!tab) return;
    const g = groupOfTab(tabId);
    const groupTabCount = g?.tabs.length ?? 0;
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
          // Stage A: only one split allowed → enabled when there's a single
          // group with ≥2 tabs (so both panes end up with content).
          label: t("tabmenu.split_right"),
          onClick: () => splitRight(tabId),
          disabled: groups.length > 1 || groupTabCount < 2,
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
            (g?.tabs ?? [])
              .filter((x) => x.id !== tabId)
              .forEach((x) => closeTab(x.id));
          },
          disabled: groupTabCount <= 1,
          destructive: true,
        },
      ],
    });
  }

  // Move a tab out into a new group on the right, turning its pane into a
  // vertical split. Stage A: only from a single, multi-tab group.
  function splitRight(tabId: string) {
    const g = groupOfTab(tabId);
    if (!g) return;
    const movedTab = g.tabs.find((x) => x.id === tabId);
    if (!movedTab) return;
    const newGroupId = uid("g");
    setGroups((gs) => {
      const updated = gs.map((x) => {
        if (x.id !== g.id) return x;
        const remaining = x.tabs.filter((t_) => t_.id !== tabId);
        return {
          ...x,
          tabs: remaining,
          activeId:
            x.activeId === tabId
              ? remaining.length
                ? remaining[remaining.length - 1].id
                : null
              : x.activeId,
        };
      });
      return [...updated, { id: newGroupId, tabs: [movedTab], activeId: tabId }];
    });
    setLayout((lay) =>
      replaceLeaf(lay, g.id, {
        kind: "split",
        id: uid("s"),
        dir: "row",
        ratio: 0.5,
        a: { kind: "leaf", groupId: g.id },
        b: { kind: "leaf", groupId: newGroupId },
      }),
    );
    setFocusedGroupId(newGroupId);
  }

  async function closeTab(id: string) {
    const target = allTabs.find((x) => x.id === id);
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
    const g = groupOfTab(id);
    if (!g) return;
    const remaining = g.tabs.filter((x) => x.id !== id);
    if (remaining.length === 0 && groups.length > 1) {
      // Last tab in a split pane → drop the pane and collapse the layout.
      setGroups((gs) => gs.filter((x) => x.id !== g.id));
      setLayout((lay) => removeLeaf(lay, g.id) ?? lay);
      if (focusedGroupId === g.id) {
        const sibling = groups.find((x) => x.id !== g.id);
        if (sibling) setFocusedGroupId(sibling.id);
      }
    } else {
      setGroups((gs) =>
        gs.map((x) =>
          x.id === g.id
            ? {
                ...x,
                tabs: remaining,
                activeId:
                  x.activeId === id
                    ? remaining.length
                      ? remaining[remaining.length - 1].id
                      : null
                    : x.activeId,
              }
            : x,
        ),
      );
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
      updateTab(tab.id, (x) => ({
        ...x,
        status: "closed",
        error: t("app.autoreconnect_gave_up", { name: tab.host.name }),
      }));
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
    updateTab(id, (x) => ({ ...x, status: "closed" }));
    // Auto-reconnect only on UNEXPECTED close (network drop, server-side EOF
    // etc.). Don't retry when the user themselves closed the session.
    const userInitiated = reason === "user disconnected";
    if (userInitiated) {
      clearReconnect(id);
      return;
    }
    const tab = allTabs.find((x) => x.id === id);
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

  const activeSession = allTabs.find((x) => x.id === activeId)?.host;
  // Hosts that have an open tab → "live" badge in the sidebar; the active tab's
  // host additionally gets the blinking caret.
  const openHostIds = new Set(allTabs.map((x) => x.host.id));

  // Drag a split divider: adjust the owning node's ratio live. rect is captured
  // at pointer-down (the split container doesn't move mid-drag).
  function startPaneResize(
    e: React.PointerEvent,
    nodeId: string,
    isRow: boolean,
  ) {
    e.preventDefault();
    const container = (e.currentTarget as HTMLElement).parentElement;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const onMove = (ev: PointerEvent) => {
      const frac = isRow
        ? (ev.clientX - rect.left) / rect.width
        : (ev.clientY - rect.top) / rect.height;
      const ratio = Math.min(0.85, Math.max(0.15, frac));
      setLayout((lay) => setNodeRatio(lay, nodeId, ratio));
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.body.style.cursor = isRow ? "col-resize" : "row-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  // One pane = a tab strip + its terminals. All panes render at once; a
  // terminal is `visible` when it's its group's active tab.
  function renderMainArea(): React.ReactNode {
    const rects = new Map<string, Rect>();
    const full: Rect = { left: 0, top: 0, width: 100, height: 100 };
    computeRects(layout, full, rects);
    const dividers: DividerInfo[] = [];
    collectDividers(layout, full, dividers);
    const multiPane = groups.length > 1;
    const focusGroup = (id: string) => {
      if (id !== focusedGroupId) setFocusedGroupId(id);
    };
    const contentRect = (r: Rect): React.CSSProperties => ({
      position: "absolute",
      left: `${r.left}%`,
      top: `calc(${r.top}% + ${TABBAR_PX}px)`,
      width: `${r.width}%`,
      height: `calc(${r.height}% - ${TABBAR_PX}px)`,
    });

    return (
      <div className="flex-1 min-w-0 relative overflow-hidden">
        {/* Matrix Rain — terminal area only (below the tab strips). */}
        <div
          className="pointer-events-none absolute z-30"
          style={{ left: 0, right: 0, top: TABBAR_PX, bottom: 0 }}
        >
          <MatrixRain
            enabled={settings.rainOn}
            density={settings.rainDensity}
            opacity={settings.rainOpacity}
            accent={theme.accent}
            fade={theme.bgBase}
          />
        </div>

        {/* Per-pane tab strips. */}
        {groups.map((g) => {
          const r = rects.get(g.id);
          if (!r) return null;
          return (
            <div
              key={"tb-" + g.id}
              onMouseDownCapture={() => focusGroup(g.id)}
              style={{
                position: "absolute",
                left: `${r.left}%`,
                top: `${r.top}%`,
                width: `${r.width}%`,
                zIndex: 20,
              }}
            >
              <TabBar
                tabs={g.tabs}
                activeId={g.activeId}
                onSelect={(id) => selectTab(g.id, id)}
                onClose={closeTab}
                onNewTab={() => {
                  focusGroup(g.id);
                  openSshPicker();
                }}
                onNewTabDropdown={(x, y) => {
                  focusGroup(g.id);
                  openNewTabMenu(x, y);
                }}
                onContextMenu={onTabContextMenu}
                onReorder={reorderTabs}
              />
            </div>
          );
        })}

        {/* STABLE flat terminal layer: every live terminal is a direct child of
         *  this container keyed by session id. Changing the split layout only
         *  repositions them — React never unmounts/remounts a TerminalView, so
         *  the xterm keeps its content (the v0.4.0 split bug). */}
        {groups.flatMap((g) => {
          const r = rects.get(g.id);
          if (!r) return [];
          return g.tabs
            .filter((tab) => tab.status !== "connecting" && !tab.error)
            .map((tab) => {
              const show = tab.id === g.activeId;
              return (
                <div
                  key={tab.id}
                  onMouseDownCapture={() => focusGroup(g.id)}
                  style={{ ...contentRect(r), zIndex: 10, display: show ? "block" : "none" }}
                >
                  <TerminalView
                    sessionId={tab.id}
                    visible={show}
                    onSessionClosed={(reason) => markClosed(tab.id, reason)}
                    onReconnect={() => restartSession(tab.id)}
                    onContextMenu={(x, y, items) => setMenu({ x, y, items })}
                  />
                </div>
              );
            });
        })}

        {/* Per-pane overlays above the terminal. */}
        {groups.map((g) => {
          const r = rects.get(g.id);
          if (!r) return null;
          const cs = contentRect(r);
          const active = g.tabs.find((x) => x.id === g.activeId);
          return (
            <Fragment key={"ov-" + g.id}>
              {multiPane && g.id === focusedGroupId && (
                <div
                  className="pointer-events-none"
                  style={{ ...cs, zIndex: 24, boxShadow: "inset 0 0 0 1px var(--nx-accent)" }}
                />
              )}
              {g.tabs.length === 0 && !selectedHost && (
                <div
                  style={{ ...cs, zIndex: 15 }}
                  className="flex items-center justify-center font-mono text-sm pointer-events-none"
                >
                  <span style={{ color: theme.textMuted }}>
                    &gt; {t("terminal.select_host")}
                  </span>
                </div>
              )}
              {g.tabs.length === 0 && selectedHost && (
                <div style={{ ...cs, zIndex: 15 }}>
                  <HostInfoCard
                    host={selectedHost}
                    onConnect={() => openHost(selectedHost)}
                    onEdit={() => setEditHost(selectedHost)}
                  />
                </div>
              )}
              {active?.status === "connecting" && (
                <div
                  style={{ ...cs, zIndex: 15 }}
                  className="flex items-center justify-center font-mono text-sm"
                >
                  <span style={{ color: theme.warning }}>
                    {t("terminal.connecting_to", {
                      user: active.host.user,
                      host: active.host.host,
                      port: active.host.port,
                    })}
                  </span>
                </div>
              )}
              {active?.error && (
                <div style={{ ...cs, zIndex: 16 }} className="flex items-center justify-center p-6">
                  <div
                    className="max-w-md font-mono text-sm border rounded-nx p-4"
                    style={{ borderColor: theme.error, background: theme.bgPanel }}
                  >
                    <div className="mb-2" style={{ color: theme.error }}>
                      ✗ {t("terminal.connect_failed", { host: active.host.host })}
                    </div>
                    <div className="mb-3 break-words" style={{ color: theme.textSoft }}>
                      {active.error}
                    </div>
                    <button
                      type="button"
                      onClick={() => restartSession(active.id)}
                      className="px-3 py-1 rounded-nx-sm border cursor-pointer hover:opacity-80"
                      style={{ borderColor: theme.border, color: theme.accent }}
                    >
                      {t("terminal.retry")}
                    </button>
                  </div>
                </div>
              )}
              {g.activeId && transcriptTabs.has(g.activeId) && active && (
                <div style={{ ...cs, zIndex: 20 }}>
                  <TranscriptOverlay
                    sessionId={g.activeId}
                    hostLabel={`${active.host.user}@${active.host.host}`}
                    onClose={() => toggleTranscript(g.activeId!)}
                    onContextMenu={(x, y, items) => setMenu({ x, y, items })}
                  />
                </div>
              )}
            </Fragment>
          );
        })}

        {/* Split dividers. */}
        {dividers.map((d) => (
          <div
            key={d.id}
            onPointerDown={(e) => startPaneResize(e, d.id, d.isRow)}
            className={
              (d.isRow ? "cursor-col-resize" : "cursor-row-resize") +
              " bg-transparent hover:bg-[var(--nx-accent)]/40 active:bg-[var(--nx-accent)]/60 transition-colors"
            }
            style={
              d.isRow
                ? { position: "absolute", left: `calc(${d.at}% - 2px)`, top: `${d.cross}%`, width: 4, height: `${d.len}%`, zIndex: 40 }
                : { position: "absolute", top: `calc(${d.at}% - 2px)`, left: `${d.cross}%`, height: 4, width: `${d.len}%`, zIndex: 40 }
            }
          />
        ))}
      </div>
    );
  }

  return (
    <main className="h-full w-full flex flex-col relative" style={themeStyle}>
      {/* Matrix Rain — rendered inside the terminal-area container below so
       *  the cascade only appears there. Header, sidebar, modals stay clean. */}

      {/* Brief full-app matrix burst on connect (keyed so it replays). */}
      {rainBurst > 0 && <div key={rainBurst} className="nx-rain-burst" />}

      <header
        data-tauri-drag-region
        className="relative z-10 h-9 bg-nx-bg-2 border-b border-nx-border flex items-center px-3 gap-3 select-none shrink-0"
      >
        {/* Brand mark — framed > glyph nodding to the app icon */}
        <div className="flex items-center gap-2" data-tauri-drag-region>
          <span className="inline-flex w-[18px] h-[18px] items-center justify-center border border-nx-accent rounded-nx-sm shadow-glow-sm">
            <span className="text-nx-accent text-[11px] font-bold leading-none">
              &gt;
            </span>
          </span>
          <span className="text-nx-accent text-lead tracking-wide font-mono">
            NexuSSH
          </span>
          <span className="text-micro text-nx-muted font-mono">v{version}</span>
        </div>

        <span
          data-tauri-drag-region
          className="text-meta italic text-nx-muted font-mono hidden md:inline"
        >
          — {t("app.tagline")}
        </span>

        {/* Prompt-style breadcrumb of the active session */}
        {activeSession && (
          <div className="ml-1 flex items-center gap-1.5 px-2.5 py-0.5 border border-nx-border rounded-nx bg-nx-panel text-meta font-mono min-w-0">
            <span className="text-nx-accent mr-0.5 shrink-0">&gt;</span>
            <span className="text-nx-soft truncate">
              {activeSession.group ?? t("sidebar.no_group")}
            </span>
            <span className="text-nx-muted shrink-0">/</span>
            <span className="text-nx-text truncate">{activeSession.name}</span>
            <span className="text-nx-muted shrink-0">@</span>
            <span className="text-nx-muted truncate">{activeSession.host}</span>
          </div>
        )}

        <div className="ml-auto flex items-center gap-1 text-meta">
          <HeaderButton
            icon={<History size={12} />}
            onClick={() => setHistoryPanelOpen(true)}
            title={t("history.open_panel")}
          >
            {t("history.button")}
          </HeaderButton>
          <HeaderButton
            icon={<RefreshCw size={12} />}
            onClick={() => setSyncPanelOpen(true)}
            title={t("sync.open_panel")}
            active={sync?.unlocked}
            warn={sync?.configured && !sync?.unlocked}
          >
            sync
          </HeaderButton>
          {settings.advanced && (
            <HeaderButton
              icon={
                vault?.unlocked ? (
                  <Unlock size={12} />
                ) : vault?.configured ? (
                  <Lock size={12} />
                ) : (
                  <KeyRound size={12} />
                )
              }
              onClick={() => setVaultPanelOpen(true)}
              title={t("vault.open_panel")}
              active={vault?.unlocked}
              warn={vault?.configured && !vault?.unlocked}
            >
              vault
            </HeaderButton>
          )}
          <HeaderButton
            icon={<SettingsIcon size={12} />}
            onClick={() => setSettingsOpen(true)}
            title={t("settings.open") + " (Ctrl ,)"}
          />
          <div className="ml-1">
            <LanguageSwitcher />
          </div>
          <WindowControls />
        </div>
      </header>

      <div className="relative z-10 flex-1 min-h-0 flex">
        <Sidebar
          onConnect={openHost}
          onSftp={openSftp}
          onSelect={setSelectedHost}
          activeHostId={activeSession?.id ?? null}
          openHostIds={openHostIds}
          selectedId={selectedHost?.id ?? null}
          collapsed={sidebarCollapsed}
          onToggleCollapsed={toggleSidebar}
          width={sidebarWidth}
          onContextMenu={(x, y, items, title) => setMenu({ x, y, items, title })}
          clickMode={settings.clickMode}
        />
        {!sidebarCollapsed && (
          <div
            onPointerDown={startSidebarResize}
            title={t("sidebar.resize")}
            className="shrink-0 w-1 cursor-col-resize bg-transparent hover:bg-[var(--nx-accent)]/40 active:bg-[var(--nx-accent)]/60 transition-colors"
          />
        )}
        {renderMainArea()}
      </div>

      <StatusLine
        sessionCount={allTabs.length}
        connectingCount={allTabs.filter((x) => x.status === "connecting").length}
        syncStatus={sync?.unlocked ? "ok" : sync?.configured ? "pending" : "off"}
      />

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
          onPick={(h) => (pickerMode === "sftp" ? openSftp(h) : openHost(h))}
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
          title={menu.title}
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
            sessionCount={allTabs.length}
          />
        </div>
      )}

      {pwPrompt && (
        <PasswordPrompt
          user={pwPrompt.user}
          host={pwPrompt.host}
          onSubmit={(password) => {
            pwPrompt.resolve(password);
            setPwPrompt(null);
          }}
          onCancel={() => {
            pwPrompt.resolve(null);
            setPwPrompt(null);
          }}
        />
      )}
    </main>
  );
}

export default App;
