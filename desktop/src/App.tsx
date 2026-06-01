import { useState, useEffect, useRef, Fragment, Suspense, lazy } from "react";
import { useTranslation } from "react-i18next";
import {
  Lock,
  Unlock,
  KeyRound,
  RefreshCw,
  History,
  Settings as SettingsIcon,
  HelpCircle,
} from "lucide-react";
import { Sidebar } from "./Sidebar";
import { TabBar } from "./TabBar";
import { TerminalView } from "./Terminal";
import { DialogHost } from "./DialogHost";
import { askConfirm, askPrompt } from "./dialogs";
import { LanguageSwitcher } from "./LanguageSwitcher";
// Heavy panels are conditionally rendered — code-split them so the initial
// bundle drops from ~775KB to ~500KB. React.lazy + Suspense unloads them
// until first use.
const VaultPanel = lazy(() =>
  import("./VaultPanel").then((m) => ({ default: m.VaultPanel })),
);
const SyncPanel = lazy(() =>
  import("./SyncPanel").then((m) => ({ default: m.SyncPanel })),
);
const HistoryPanel = lazy(() =>
  import("./HistoryPanel").then((m) => ({ default: m.HistoryPanel })),
);
const SFTPPanel = lazy(() =>
  import("./SFTPPanel").then((m) => ({ default: m.SFTPPanel })),
);
import { StatusLine } from "./StatusLine";
import type { ConnectArgs } from "./ssh";
import { TabPicker } from "./TabPicker";
const UpdatePanel = lazy(() =>
  import("./UpdatePanel").then((m) => ({ default: m.UpdatePanel })),
);
import { ContextMenu, MenuItem } from "./ContextMenu";
import { buildAppContextMenu } from "./contextMenuItems";
import { HostInfoCard } from "./HostInfoCard";
import { HostDialog } from "./HostDialog";
import { PasswordPrompt } from "./PasswordPrompt";
const SettingsScreen = lazy(() =>
  import("./SettingsScreen").then((m) => ({ default: m.SettingsScreen })),
);
import { TranscriptOverlay } from "./TranscriptOverlay";
import { PaneHeader } from "./PaneHeader";
import { useSettings } from "./settings/settings-store";
import { THEMES, applyTheme } from "./settings/themes";
import { fontStackOf } from "./settings/fonts";
import { MatrixRain } from "./settings/MatrixRain";
import { UpdateInfo, startupCheck } from "./updater";
import { sshConnect, sshDisconnect, sshSend } from "./ssh";
import { useIsMobile } from "./useIsMobile";
import { SmartKeyBar } from "./SmartKeyBar";
import { ShortcutsOverlay } from "./ShortcutsOverlay";
import { MobileTopBar } from "./MobileTopBar";
import type { VpnNode } from "./vpn";
import { getProfile, resolveExit } from "./vpn";
import { HostRecord, bumpLastUsed } from "./hosts";
import { VaultStatus, vaultStatus, vaultLock } from "./vault";
import { SyncStatus, syncStatus } from "./sync";
import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

// `getCurrentWindow()` and the window plugin only exist inside a Tauri webview;
// in a plain dev browser they throw and unmount the whole React tree. Gate any
// caller behind this flag and degrade gracefully (no titlebar controls, no
// "intercept close" listener — the browser doesn't have those concepts).
const HAS_TAURI =
  typeof window !== "undefined" &&
  // @ts-expect-error — Tauri marker, not in DOM lib types
  typeof window.__TAURI_INTERNALS__ !== "undefined";
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

// Height of the per-pane mini-toolbar (PaneHeader.tsx). Rendered only when the
// active workspace has ≥2 panes; the terminal layer is offset by this amount
// in that case so the header sits ABOVE the terminal rather than over it.
const PANE_HEADER_PX = 24;

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

// --- Workspace model (v0.7.0) ----------------------------------------------
// Single tab strip at the top — each tab is a Workspace = layout of Panes;
// each Pane holds one Session. New hosts open as their own Workspace (single
// pane, full screen). Splits add panes to the active workspace's layout. The
// LayoutNode tree references paneIds; it's general so nested grids work.
interface Session {
  id: string; // pending-xxx or backend sid
  host: HostRecord;
  status: "connecting" | "connected" | "closed";
  /** Set when a connect/reconnect attempt fails — shown in the pane with a
   *  Retry button instead of the tab silently vanishing. */
  error?: string;
}
interface Pane {
  id: string;
  session: Session;
}
interface Workspace {
  id: string;
  /** User-renamed title; if absent, derive from the focused pane's host. */
  title?: string;
  panes: Pane[];
  layout: LayoutNode;
  focusedPaneId: string;
}
type LayoutNode =
  | { kind: "leaf"; paneId: string }
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

// Replace the leaf for `paneId` with `replacement` — turns a pane into a split.
function replaceLeaf(
  node: LayoutNode,
  paneId: string,
  replacement: LayoutNode,
): LayoutNode {
  if (node.kind === "leaf")
    return node.paneId === paneId ? replacement : node;
  return {
    ...node,
    a: replaceLeaf(node.a, paneId, replacement),
    b: replaceLeaf(node.b, paneId, replacement),
  };
}

// Drop the leaf for `paneId`, collapsing its parent split into the sibling.
// Returns null when the removed leaf was the entire tree.
function removeLeaf(node: LayoutNode, paneId: string): LayoutNode | null {
  if (node.kind === "leaf") return node.paneId === paneId ? null : node;
  const a = removeLeaf(node.a, paneId);
  const b = removeLeaf(node.b, paneId);
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

// --- Persistence shape (localStorage `nexussh.workspaces`) ----------------
// PTY sessions don't survive restarts, so only the layout skeleton + which
// hosts went into which panes is saved. `kickoffConnect` resurrects the
// sessions on restore.
interface PersistedPane {
  id: string;
  hostId: string;
}
interface PersistedWorkspace {
  id: string;
  title?: string;
  focusedPaneId: string;
  layout: LayoutNode;
  panes: PersistedPane[];
}
interface PersistedRoot {
  v: 1;
  activeWorkspaceId: string | null;
  workspaces: PersistedWorkspace[];
}
// Drop layout leaves whose pane id isn't in `live` (host deleted since save).
// Collapses parent splits whose children both vanished.
function pruneLayoutToPanes(
  node: LayoutNode,
  live: Set<string>,
): LayoutNode | null {
  if (node.kind === "leaf") return live.has(node.paneId) ? node : null;
  const a = pruneLayoutToPanes(node.a, live);
  const b = pruneLayoutToPanes(node.b, live);
  if (a === null) return b;
  if (b === null) return a;
  return { ...node, a, b };
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
    out.set(node.paneId, rect);
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
  /** Region the OWNING split node occupies — used to convert the cursor's
   *  pixel position into a sub-region ratio when nested splits exist. */
  region: Rect;
}
function collectDividers(node: LayoutNode, rect: Rect, out: DividerInfo[]) {
  if (node.kind === "leaf") return;
  if (node.dir === "row") {
    const aw = rect.width * node.ratio;
    out.push({
      id: node.id,
      isRow: true,
      at: rect.left + aw,
      cross: rect.top,
      len: rect.height,
      region: rect,
    });
    collectDividers(node.a, { ...rect, width: aw }, out);
    collectDividers(
      node.b,
      { left: rect.left + aw, top: rect.top, width: rect.width - aw, height: rect.height },
      out,
    );
  } else {
    const ah = rect.height * node.ratio;
    out.push({
      id: node.id,
      isRow: false,
      at: rect.top + ah,
      cross: rect.left,
      len: rect.width,
      region: rect,
    });
    collectDividers(node.a, { ...rect, height: ah }, out);
    collectDividers(
      node.b,
      { left: rect.left, top: rect.top + ah, width: rect.width, height: rect.height - ah },
      out,
    );
  }
}

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
  if (!HAS_TAURI) return null;
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

  // Workspace tab model: ONE top tab strip; each tab is a workspace = layout
  // of panes; each pane holds one session. New hosts open as their own
  // workspace (single pane). Splits add panes WITHIN a workspace's layout.
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string | null>(
    null,
  );
  const activeWorkspace =
    workspaces.find((w) => w.id === activeWorkspaceId) ?? null;
  const allSessions = workspaces.flatMap((w) => w.panes.map((p) => p.session));
  const focusedSession =
    activeWorkspace?.panes.find((p) => p.id === activeWorkspace.focusedPaneId)
      ?.session ?? null;
  // Back-compat name used by hotkeys / transcript / status header.
  const activeId = focusedSession?.id ?? null;
  const activeSession = focusedSession?.host ?? null;
  // Hosts that have an open pane → "live" badge in the sidebar; the focused
  // pane's host additionally gets the blinking caret.
  const openHostIds = new Set(allSessions.map((s) => s.host.id));

  // Walk all workspaces to find which workspace + pane owns a given session id.
  function findPane(
    sessionId: string,
  ): { ws: Workspace; pane: Pane } | undefined {
    for (const ws of workspaces) {
      const pane = ws.panes.find((p) => p.session.id === sessionId);
      if (pane) return { ws, pane };
    }
    return undefined;
  }

  // Functional update of a single session anywhere in the workspace tree.
  function updateSession(sessionId: string, fn: (s: Session) => Session) {
    setWorkspaces((ws_) =>
      ws_.map((w) => ({
        ...w,
        panes: w.panes.map((p) =>
          p.session.id === sessionId ? { ...p, session: fn(p.session) } : p,
        ),
      })),
    );
  }

  // Swap a session's id (pending → real sid), set status, clear error.
  function promoteSession(
    oldSessionId: string,
    newSessionId: string,
    status: Session["status"],
  ) {
    setWorkspaces((ws_) =>
      ws_.map((w) => ({
        ...w,
        panes: w.panes.map((p) =>
          p.session.id === oldSessionId
            ? {
                ...p,
                session: {
                  ...p.session,
                  id: newSessionId,
                  status,
                  error: undefined,
                },
              }
            : p,
        ),
      })),
    );
  }

  // Move focus to a specific pane inside a workspace and activate that workspace.
  function setFocusedPane(wsId: string, paneId: string) {
    setWorkspaces((ws_) =>
      ws_.map((w) => (w.id === wsId ? { ...w, focusedPaneId: paneId } : w)),
    );
    setActiveWorkspaceId(wsId);
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

  const mainAreaRef = useRef<HTMLDivElement>(null);

  // Pane-extract drag: pointer started on a pane's PaneHeader, user is now
  // dragging. The floating chip follows the cursor; on release outside the
  // main area we move the pane into its own brand-new workspace. `active` is
  // set after the cursor moves >24px outside the main area's bounding rect,
  // so a normal click on the header just focuses the pane.
  const [paneDragState, setPaneDragState] = useState<{
    wsId: string;
    paneId: string;
    hostLabel: string;
    x: number;
    y: number;
    active: boolean;
  } | null>(null);
  // Ref mirror — pointer handlers run outside React state propagation.
  const paneDragRef = useRef<typeof paneDragState>(null);
  paneDragRef.current = paneDragState;
  // During pane drag, when the cursor sits on a different pane's edge zone, we
  // preview where the dragged pane will land if released.
  type PaneEdge = "left" | "right" | "top" | "bottom";
  const [paneEdgeHint, setPaneEdgeHint] = useState<
    { paneId: string; edge: PaneEdge } | null
  >(null);
  const paneEdgeHintRef = useRef<typeof paneEdgeHint>(null);
  paneEdgeHintRef.current = paneEdgeHint;

  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerMode, setPickerMode] = useState<"ssh" | "sftp">("ssh");
  // When set, the next host picked completes a split inside this workspace
  // rather than opening a new workspace.
  const [pendingSplit, setPendingSplit] = useState<{
    wsId: string;
    paneId: string;
    dir: "row" | "col";
  } | null>(null);
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
  // Mobile shell: collapse sidebar into a drawer + adapt header + show
  // SmartKeyBar above the on-screen keyboard. Toggled via media query.
  const isMobile = useIsMobile();
  const [mobileDrawerOpen, setMobileDrawerOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  // Transient tab-switch flash (Ctrl+Tab): tab id to pulse on. Cleared by
  // CSS animation completion via this state being reset after the animation.
  const [switchPulseId, setSwitchPulseId] = useState<string | null>(null);
  useEffect(() => {
    if (!switchPulseId) return;
    const t = window.setTimeout(() => setSwitchPulseId(null), 400);
    return () => window.clearTimeout(t);
  }, [switchPulseId]);
  // When the viewport flips between mobile and desktop, make sure the drawer
  // doesn't get stuck open across the transition.
  useEffect(() => {
    if (!isMobile) setMobileDrawerOpen(false);
  }, [isMobile]);
  const [selectedHost, setSelectedHost] = useState<HostRecord | null>(null);
  const [editHost, setEditHost] = useState<HostRecord | null>(null);
  // Separate flag for "create new host" — picker's + button needs a
  // fresh HostDialog with no `initial` prop (passing an empty object
  // crashes the form's auth.kind probe). null editHost + this true =
  // create mode.
  const [createHostOpen, setCreateHostOpen] = useState(false);
  // Stack of recently-closed hosts. Ctrl+Shift+T pops one and re-opens it.
  // Bounded to last 20 entries by the push site in closePane.
  const closedStackRef = useRef<HostRecord[]>([]);

  // Per-session scrollback overlay state. When a session id is in this set,
  // the active TerminalView is hidden behind a TranscriptOverlay that lets the
  // user wheel-scroll through everything written so far (works even in
  // alt-screen mode like Claude Code).
  const [transcriptTabs, setTranscriptTabs] = useState<Set<string>>(
    () => new Set<string>(),
  );
  function toggleTranscript(sessionId: string) {
    setTranscriptTabs((prev) => {
      const next = new Set(prev);
      if (next.has(sessionId)) next.delete(sessionId);
      else next.add(sessionId);
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

  // Confirm-on-quit / back-button routing.
  //
  // On Android the hardware back-press fires window's onCloseRequested. We
  // pop the topmost overlay/drawer first so back actually navigates within
  // the app instead of dropping the user out of NexuSSH on every press.
  // Only when nothing is open AND there are no live sessions do we let the
  // event propagate (which closes the activity). With live sessions we still
  // show the confirm dialog as on desktop.
  const sessionsRef = useRef(allSessions);
  sessionsRef.current = allSessions;
  // Ref-stash everything that's "openable" so the close-requested handler
  // can read the latest snapshot without re-registering on every render.
  const backRef = useRef({
    isMobile,
    mobileDrawerOpen,
    pickerOpen,
    editHost,
    createHostOpen,
    settingsOpen,
    shortcutsOpen,
    syncPanelOpen: false as boolean,
    vaultPanelOpen: false as boolean,
    historyPanelOpen: false as boolean,
    sftpTarget: null as unknown,
    closers: {} as Record<string, () => void>,
  });
  // Keep refs current.
  backRef.current.isMobile = isMobile;
  backRef.current.mobileDrawerOpen = mobileDrawerOpen;
  backRef.current.pickerOpen = pickerOpen;
  backRef.current.editHost = editHost;
  backRef.current.createHostOpen = createHostOpen;
  backRef.current.settingsOpen = settingsOpen;
  backRef.current.shortcutsOpen = shortcutsOpen;
  // Mobile back-button: Tauri's onCloseRequested doesn't fire reliably for
  // the Android hardware back press, so use the standard popstate trick —
  // push a synthetic history entry whenever any overlay opens and pop it
  // when the user navigates back. The popstate handler closes the topmost
  // overlay; only when the in-app stack is empty does back actually
  // collapse/minimize the activity (as Android expects).
  useEffect(() => {
    if (!isMobile) return;
    const anyOpen =
      mobileDrawerOpen ||
      pickerOpen ||
      !!editHost ||
      createHostOpen ||
      settingsOpen ||
      shortcutsOpen;
    if (anyOpen) {
      // Push only once per "open" — subsequent renders shouldn't stack.
      if (history.state?.nxOverlay !== true) {
        history.pushState({ nxOverlay: true }, "");
      }
    }
  }, [
    isMobile,
    mobileDrawerOpen,
    pickerOpen,
    editHost,
    createHostOpen,
    settingsOpen,
    shortcutsOpen,
  ]);
  useEffect(() => {
    if (!isMobile) return;
    const onPop = () => {
      const b = backRef.current;
      if (b.settingsOpen) setSettingsOpen(false);
      else if (b.shortcutsOpen) setShortcutsOpen(false);
      else if (b.editHost) setEditHost(null);
      else if (b.createHostOpen) setCreateHostOpen(false);
      else if (b.pickerOpen) setPickerOpen(false);
      else if (b.mobileDrawerOpen) setMobileDrawerOpen(false);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [isMobile]);
  useEffect(() => {
    if (!HAS_TAURI) return;
    let unlisten: (() => void) | undefined;
    getCurrentWindow()
      .onCloseRequested(async (event) => {
        const live = sessionsRef.current.filter(
          (s) => s.status === "connected" || s.status === "connecting",
        );
        if (live.length === 0) return;
        event.preventDefault();
        const ok = await askConfirm(
          t("app.confirm_quit", { n: live.length }),
          { destructive: true },
        );
        if (ok) getCurrentWindow().destroy().catch(() => {});
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

  // restoreSession — on first mount, if enabled, rebuild last launch's
  // workspaces in full (panes, layout tree, focused pane, active workspace),
  // and kick off SSH for each pane. Falls back to the old host-id-only format
  // if that's all we have in localStorage. PTY sessions don't survive a
  // process exit, so only host references are persisted.
  const restoredRef = useRef(false);
  useEffect(() => {
    if (restoredRef.current) return;
    restoredRef.current = true;
    if (!settings.restoreSession) return;
    // Read localStorage SYNCHRONOUSLY before the persist effect (which fires
    // right after this one with workspaces=[]) wipes it.
    let rawV1: string | null = null;
    let rawV0: string | null = null;
    try {
      rawV1 = localStorage.getItem("nexussh.workspaces");
      rawV0 = localStorage.getItem("nexussh.lastTabs");
    } catch {
      /* private mode etc. */
    }
    if (!rawV1 && !rawV0) return;
    (async () => {
      try {
        const { listHosts } = await import("./hosts");
        const all = await listHosts();
        if (rawV1) {
          const data = JSON.parse(rawV1) as PersistedRoot | null;
          if (data && Array.isArray(data.workspaces) && data.workspaces.length > 0) {
            restoreFromPersistedV1(data, all);
            return;
          }
        }
        // Fallback: old "lastTabs" array of host ids → each becomes its own ws.
        if (!rawV0) return;
        const ids = JSON.parse(rawV0);
        if (!Array.isArray(ids) || ids.length === 0) return;
        for (const id of ids) {
          const h = all.find((x) => x.id === id);
          if (h) openHost(h);
        }
      } catch {
        /* best-effort */
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist the full workspace shape (layout tree + pane → host ids + focus +
  // active workspace). Survives across restarts.
  useEffect(() => {
    if (!settings.restoreSession) return;
    if (!restoredRef.current) return; // don't overwrite before restore ran
    const data: PersistedRoot = {
      v: 1,
      activeWorkspaceId,
      workspaces: workspaces.map((w) => ({
        id: w.id,
        title: w.title,
        focusedPaneId: w.focusedPaneId,
        layout: w.layout,
        panes: w.panes.map((p) => ({ id: p.id, hostId: p.session.host.id })),
      })),
    };
    if (data.workspaces.length === 0) {
      localStorage.removeItem("nexussh.workspaces");
    } else {
      localStorage.setItem("nexussh.workspaces", JSON.stringify(data));
    }
  }, [workspaces, activeWorkspaceId, settings.restoreSession]);

  function restoreFromPersistedV1(data: PersistedRoot, all: HostRecord[]) {
    const restored: Workspace[] = [];
    for (const pw of data.workspaces) {
      const panes: Pane[] = [];
      for (const pp of pw.panes) {
        const host = all.find((h) => h.id === pp.hostId);
        if (!host) continue; // host deleted since save
        const pendingId = "pending-" + crypto.randomUUID();
        panes.push({
          id: pp.id,
          session: { id: pendingId, host, status: "connecting" },
        });
      }
      if (panes.length === 0) continue;
      const livePaneIds = new Set(panes.map((p) => p.id));
      let layout = pruneLayoutToPanes(pw.layout, livePaneIds);
      if (!layout) layout = { kind: "leaf", paneId: panes[0].id };
      const focusedPaneId = panes.some((p) => p.id === pw.focusedPaneId)
        ? pw.focusedPaneId
        : panes[panes.length - 1].id;
      restored.push({
        id: pw.id,
        title: pw.title,
        panes,
        layout,
        focusedPaneId,
      });
    }
    if (restored.length === 0) return;
    setWorkspaces(restored);
    const activeId = data.activeWorkspaceId &&
      restored.some((w) => w.id === data.activeWorkspaceId)
      ? data.activeWorkspaceId
      : restored[0].id;
    setActiveWorkspaceId(activeId);
    // Kick off connections in parallel.
    for (const w of restored) {
      for (const p of w.panes) {
        kickoffConnect(p.session.id, p.session.host);
      }
    }
  }

  // Drive an SSH connection for an already-mounted pending pane (used by
  // restore). Mirrors openHost's success/error handling but doesn't add a
  // tab, since the pane is already there.
  async function kickoffConnect(pendingId: string, h: HostRecord) {
    let auth = h.auth;
    if (h.auth.kind === "password" && h.alwaysAskPassword) {
      const entered = await askPassword(h);
      if (entered === null) {
        updateSession(pendingId, (s) => ({
          ...s,
          status: "closed",
          error: t("app.password_required"),
        }));
        return;
      }
      auth = { kind: "password", password: entered };
    }
    try {
      const sid = await sshConnect({
        host: h.host,
        port: h.port,
        user: h.user,
        auth,
        vpn: resolveHostVpn(h),
      });
      bumpLastUsed(h.id).catch(() => {});
      promoteSession(pendingId, sid, "connected");
    } catch (e) {
      updateSession(pendingId, (s) => ({
        ...s,
        status: "closed",
        error: String(e),
      }));
    }
  }

  // Reorder workspaces in the top strip (analogous to old reorderTabs but
  // operating on whole workspaces, not individual sessions).
  function reorderWorkspaces(fromId: string, toId: string, before: boolean) {
    if (fromId === toId) return;
    setWorkspaces((ws_) => {
      const moved = ws_.find((w) => w.id === fromId);
      if (!moved) return ws_;
      const without = ws_.filter((w) => w.id !== fromId);
      const idx = without.findIndex((w) => w.id === toId);
      if (idx === -1) return ws_;
      without.splice(before ? idx : idx + 1, 0, moved);
      return without;
    });
  }

  // Auto-update check on every startup (silent on failure). Skipped if
  // user disabled auto-check in Settings, or chose "skip this version".
  useEffect(() => {
    startupCheck()
      .then((info) => {
        if (info) setUpdatePanel({ initial: info });
      })
      .catch(() => {});
  }, []);

  // Global hotkeys: Ctrl/Cmd+T (picker → new workspace), Ctrl/Cmd+, (settings),
  // Ctrl+Shift+Up (open transcript overlay for focused session).
  //
  // IMPORTANT: use CAPTURE phase. xterm.js attaches its own keydown listener
  // on the helper textarea and forwards keys to the PTY before bubble-phase
  // handlers run. Without capture, Ctrl+Shift+Up was being eaten by xterm.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const meta = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      // Helpers — both are workspace-scoped no-ops when no active workspace.
      const inActiveWs = (fn: (wsId: string) => void) => {
        if (activeWorkspaceId) {
          e.preventDefault();
          e.stopPropagation();
          fn(activeWorkspaceId);
        }
      };
      if (meta && !e.shiftKey && k === "t") {
        // Ctrl/Cmd+T — open host picker (new tab).
        e.preventDefault();
        e.stopPropagation();
        openSshPicker();
      } else if (meta && k === ",") {
        // Ctrl/Cmd+, — toggle Settings.
        e.preventDefault();
        e.stopPropagation();
        setSettingsOpen((v) => !v);
      } else if (
        e.ctrlKey &&
        e.shiftKey &&
        (e.key === "ArrowUp" || e.key === "Up")
      ) {
        // Ctrl+Shift+↑ — transcript overlay for focused session.
        if (activeId) {
          e.preventDefault();
          e.stopPropagation();
          toggleTranscript(activeId);
        }
      } else if (meta && !e.shiftKey && k === "w") {
        // Ctrl/Cmd+W — close focused tab (single pane = whole workspace).
        inActiveWs((wsId) => {
          const ws = workspaces.find((w) => w.id === wsId);
          if (ws && ws.focusedPaneId) closePane(wsId, ws.focusedPaneId);
        });
      } else if (meta && e.shiftKey && k === "d") {
        // Ctrl/Cmd+Shift+D — split focused pane right.
        inActiveWs((wsId) => splitFocusedPane(wsId, "row"));
      } else if (meta && e.shiftKey && k === "e") {
        // Ctrl/Cmd+Shift+E — split focused pane down.
        inActiveWs((wsId) => splitFocusedPane(wsId, "col"));
      } else if (e.ctrlKey && !e.altKey && !e.metaKey && e.key === "Tab") {
        // Ctrl+Tab / Ctrl+Shift+Tab — cycle workspaces.
        if (workspaces.length > 1 && activeWorkspaceId) {
          e.preventDefault();
          e.stopPropagation();
          const idx = workspaces.findIndex((w) => w.id === activeWorkspaceId);
          const next = e.shiftKey
            ? (idx - 1 + workspaces.length) % workspaces.length
            : (idx + 1) % workspaces.length;
          const nextId = workspaces[next].id;
          setActiveWorkspaceId(nextId);
          // Flash the newly-activated tab so the user can see WHICH tab the
          // shortcut took them to (regular active styling doesn't move).
          setSwitchPulseId(nextId);
        }
      } else if (
        !isMobile && !meta && !e.altKey && !e.shiftKey && e.key === "?"
      ) {
        // `?` — open keyboard-shortcuts cheat-sheet. Skip when typing in an
        // input/textarea/contenteditable so it doesn't fire while editing.
        // Mobile: there's no physical keyboard so the overlay is useless;
        // gated out.
        const t = e.target as HTMLElement | null;
        const tag = t?.tagName;
        if (
          tag !== "INPUT" &&
          tag !== "TEXTAREA" &&
          !t?.isContentEditable
        ) {
          e.preventDefault();
          e.stopPropagation();
          setShortcutsOpen((v) => !v);
        }
      } else if (!isMobile && meta && !e.shiftKey && !e.altKey && e.key === "/") {
        // Ctrl+/ — same cheat-sheet (works even while typing).
        e.preventDefault();
        e.stopPropagation();
        setShortcutsOpen((v) => !v);
      } else if (
        meta &&
        !e.shiftKey &&
        !e.altKey &&
        /^[1-9]$/.test(e.key)
      ) {
        // Ctrl/Cmd+1..9 — jump to workspace at that index.
        const n = parseInt(e.key, 10) - 1;
        if (workspaces[n]) {
          e.preventDefault();
          e.stopPropagation();
          setActiveWorkspaceId(workspaces[n].id);
        }
      } else if (meta && e.shiftKey && k === "t") {
        // Ctrl/Cmd+Shift+T — restore last closed tab (browser-style).
        const last = closedStackRef.current.pop();
        if (last) {
          e.preventDefault();
          e.stopPropagation();
          openHost(last);
        }
      } else if (
        e.ctrlKey &&
        e.shiftKey &&
        !e.altKey &&
        (e.key === "PageUp" || e.key === "PageDown")
      ) {
        // Ctrl+Shift+PgUp/PgDn — move the active workspace tab left/right
        // in the workspace list.
        if (activeWorkspaceId && workspaces.length > 1) {
          e.preventDefault();
          e.stopPropagation();
          const idx = workspaces.findIndex((w) => w.id === activeWorkspaceId);
          if (idx >= 0) {
            const delta = e.key === "PageUp" ? -1 : 1;
            const dst = idx + delta;
            if (dst >= 0 && dst < workspaces.length) {
              const next = [...workspaces];
              const [moved] = next.splice(idx, 1);
              next.splice(dst, 0, moved);
              setWorkspaces(next);
            }
          }
        }
      } else if (
        e.ctrlKey &&
        e.shiftKey &&
        !e.altKey &&
        !e.metaKey &&
        (k === "c" || k === "i" || e.key === "J")
      ) {
        // Block WebView's DevTools / Inspect shortcuts so Ctrl+Shift+C stays
        // ours for copy.
        e.preventDefault();
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [activeId, activeWorkspaceId, workspaces]);

  // Suppress the WebView's native context menu and replace it with our own.
  useEffect(() => {
    const onContextMenu = (e: MouseEvent) => {
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
  }, [t]);

  // Poll vault + sync status on mount; also kick off session-history GC.
  useEffect(() => {
    vaultStatus().then(setVault).catch(() => {});
    syncStatus().then(setSync).catch(() => {});
    // Auto-delete cast/log/meta triples older than 30 days. Active sessions
    // are never pruned (their meta mtime keeps moving).
    invoke<number>("history_prune", { maxAgeDays: 30 }).catch(() => {});
  }, []);

  // Vault auto-lock: after VAULT_IDLE_LOCK_MS of no user input (mouse/key),
  // call vault_lock so any cached master key is wiped from memory. Active
  // SSH sessions are NOT affected — only the vault.
  useEffect(() => {
    const IDLE_LOCK_MS = 15 * 60 * 1000;
    let timer: number | null = null;
    const reset = () => {
      if (timer != null) window.clearTimeout(timer);
      timer = window.setTimeout(async () => {
        try {
          const st = await vaultStatus();
          if (st.unlocked) {
            await vaultLock();
            vaultStatus().then(setVault).catch(() => {});
          }
        } catch {}
      }, IDLE_LOCK_MS);
    };
    const events: (keyof WindowEventMap)[] = [
      "mousemove",
      "mousedown",
      "keydown",
      "wheel",
      "touchstart",
    ];
    for (const ev of events) window.addEventListener(ev, reset, { passive: true });
    reset();
    return () => {
      if (timer != null) window.clearTimeout(timer);
      for (const ev of events) window.removeEventListener(ev, reset);
    };
  }, []);

  // ---------------------------------------------------------------------------
  // Session operations
  // ---------------------------------------------------------------------------

  async function openHost(h: HostRecord) {
    // If user opted to always ask for password, prompt before opening tab.
    let auth = h.auth;
    if (h.auth.kind === "password" && h.alwaysAskPassword) {
      const entered = await askPassword(h);
      if (entered === null) return; // cancelled
      auth = { kind: "password", password: entered };
    }
    const pendingId = "pending-" + crypto.randomUUID();
    const paneId = uid("p");
    const pane: Pane = {
      id: paneId,
      session: { id: pendingId, host: h, status: "connecting" },
    };
    const ws: Workspace = {
      id: uid("w"),
      panes: [pane],
      layout: { kind: "leaf", paneId },
      focusedPaneId: paneId,
    };
    setWorkspaces((ws_) => [...ws_, ws]);
    setActiveWorkspaceId(ws.id);
    try {
      const sid = await sshConnect({
        host: h.host,
        port: h.port,
        user: h.user,
        auth,
        vpn: resolveHostVpn(h),
      });
      bumpLastUsed(h.id).catch(() => {});
      promoteSession(pendingId, sid, "connected");
      triggerBurst();
    } catch (e) {
      // Keep the pane and show WHY it failed (with Retry), instead of vanishing.
      updateSession(pendingId, (s) => ({
        ...s,
        status: "closed",
        error: String(e),
      }));
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
      args: {
        host: h.host,
        port: h.port,
        user: h.user,
        auth,
        vpn: resolveHostVpn(h),
      },
      title: `${h.user}@${h.host}`,
    });
  }

  function openSshPicker() {
    setPickerMode("ssh");
    setPickerOpen(true);
  }

  // Caret next to "+" — choose what kind of session the new tab opens.
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

  async function restartSession(sessionId: string) {
    const found = findPane(sessionId);
    if (!found) return;
    const { pane } = found;
    const host = pane.session.host;
    // Same "ask each time" logic as initial connect — without it, restart
    // on a host that doesn't save its password retries with an empty string
    // and fails authentication forever.
    let auth = host.auth;
    if (host.auth.kind === "password" && host.alwaysAskPassword) {
      const entered = await askPassword(host);
      if (entered === null) return;
      auth = { kind: "password", password: entered };
    }
    if (pane.session.status === "connected") {
      sshDisconnect(sessionId).catch(() => {});
    }
    updateSession(sessionId, (s) => ({
      ...s,
      status: "connecting",
      error: undefined,
    }));
    try {
      const sid = await sshConnect({
        host: host.host,
        port: host.port,
        user: host.user,
        auth,
        vpn: resolveHostVpn(host),
      });
      bumpLastUsed(host.id).catch(() => {});
      // promoteSession keeps focus where it is (no focus-steal on auto-reconnect
      // of a background pane).
      promoteSession(sessionId, sid, "connected");
      // Move reconnect bookkeeping to the new session id and reset attempts.
      const prev = reconnectRef.current.get(sessionId);
      reconnectRef.current.delete(sessionId);
      if (prev?.timer != null) window.clearTimeout(prev.timer);
      reconnectRef.current.set(sid, { attempts: 0, timer: null });
    } catch (e) {
      updateSession(sessionId, (s) => ({
        ...s,
        status: "closed",
        error: String(e),
      }));
      if (settings.autoReconnect) {
        // schedule a retry; use the session as it now exists (still keyed
        // by the old id, since promoteSession never ran).
        scheduleReconnect(pane.session);
      }
    }
  }

  // Start a split flow: park the split intent and open the SSH picker. When
  // the user picks a host, completeSplit fires.
  function splitFocusedPane(wsId: string, dir: "row" | "col") {
    const ws = workspaces.find((w) => w.id === wsId);
    if (!ws) return;
    setPendingSplit({ wsId, paneId: ws.focusedPaneId, dir });
    setPickerMode("ssh");
    setPickerOpen(true);
  }

  // Finish a split: add a new pane next to the focused one, replace its leaf
  // with a split node, then connect.
  async function completeSplit(
    intent: { wsId: string; paneId: string; dir: "row" | "col" },
    h: HostRecord,
  ) {
    let auth = h.auth;
    if (h.auth.kind === "password" && h.alwaysAskPassword) {
      const entered = await askPassword(h);
      if (entered === null) return;
      auth = { kind: "password", password: entered };
    }
    const pendingId = "pending-" + crypto.randomUUID();
    const newPaneId = uid("p");
    const newPane: Pane = {
      id: newPaneId,
      session: { id: pendingId, host: h, status: "connecting" },
    };
    setWorkspaces((ws_) =>
      ws_.map((w) => {
        if (w.id !== intent.wsId) return w;
        return {
          ...w,
          panes: [...w.panes, newPane],
          layout: replaceLeaf(w.layout, intent.paneId, {
            kind: "split",
            id: uid("s"),
            dir: intent.dir,
            ratio: 0.5,
            a: { kind: "leaf", paneId: intent.paneId },
            b: { kind: "leaf", paneId: newPaneId },
          }),
          focusedPaneId: newPaneId,
        };
      }),
    );
    setActiveWorkspaceId(intent.wsId);
    try {
      const sid = await sshConnect({
        host: h.host,
        port: h.port,
        user: h.user,
        auth,
        vpn: resolveHostVpn(h),
      });
      bumpLastUsed(h.id).catch(() => {});
      promoteSession(pendingId, sid, "connected");
      triggerBurst();
    } catch (e) {
      updateSession(pendingId, (s) => ({
        ...s,
        status: "closed",
        error: String(e),
      }));
    }
  }

  // Right-click on a workspace tab → menu of actions on its focused pane.
  function onWorkspaceContextMenu(wsId: string, x: number, y: number) {
    const ws = workspaces.find((w) => w.id === wsId);
    if (!ws) return;
    const focused = ws.panes.find((p) => p.id === ws.focusedPaneId);
    const focusedSid = focused?.session.id ?? null;
    const focusedHost = focused?.session.host;
    const hasPanes = ws.panes.length > 0;
    const others = workspaces.filter((w) => w.id !== wsId);
    const items: MenuItem[] = [
      {
        label:
          focusedSid && transcriptTabs.has(focusedSid)
            ? t("tabmenu.exit_transcript")
            : t("tabmenu.open_transcript"),
        onClick: () => {
          if (focusedSid) toggleTranscript(focusedSid);
        },
        disabled: !focusedSid,
      },
      {
        label: t("tabmenu.restart"),
        onClick: () => {
          if (focusedSid) restartSession(focusedSid);
        },
        disabled: !focused || focused.session.status === "connecting",
      },
      // Splits aren't usable on phone-sized viewports (terminal becomes
      // unreadable), so the items are hidden there.
      ...(!isMobile
        ? [
            {
              label: t("tabmenu.split_right"),
              onClick: () => splitFocusedPane(wsId, "row"),
              disabled: !hasPanes,
            },
            {
              label: t("tabmenu.split_down"),
              onClick: () => splitFocusedPane(wsId, "col"),
              disabled: !hasPanes,
            },
          ]
        : []),
      {
        label: t("sidebar.menu_sftp"),
        onClick: () => {
          if (focusedHost) openSftp(focusedHost);
        },
        disabled: !focusedHost,
      },
      {
        label: t("tabmenu.rename_tab"),
        onClick: () => renameWorkspace(wsId),
      },
    ];
    // Merge section — flat list of other workspaces under a header. Clicking
    // one moves its panes into this workspace (next to the focused pane,
    // wrapping the layout in a row-split).
    if (others.length > 0) {
      items.push({ separator: true, label: "" });
      items.push({ sectionLabel: t("tabmenu.merge_with"), label: "" });
      for (const w of others) {
        const fp = w.panes.find((p) => p.id === w.focusedPaneId);
        const title = w.title ?? fp?.session.host.name ?? "?";
        const tag = w.panes.length > 1 ? ` · ${w.panes.length} ⊟` : "";
        items.push({
          label: title + tag,
          onClick: () => mergeWorkspace(wsId, w.id),
        });
      }
    }
    items.push({ separator: true, label: "" });
    items.push({
      label: t("tabmenu.close_current_tab"),
      onClick: () => {
        if (focused) closePane(wsId, focused.id);
      },
      disabled: !hasPanes,
      destructive: true,
    });
    items.push({
      label: t("tabmenu.close_others"),
      onClick: () => closeOtherWorkspaces(wsId),
      disabled: workspaces.length <= 1,
      destructive: true,
    });
    setMenu({ x, y, items });
  }

  // Prompt to rename the workspace tab title. Empty string clears it (back to
  // auto-derived from focused pane's host).
  async function renameWorkspace(wsId: string) {
    const ws = workspaces.find((w) => w.id === wsId);
    if (!ws) return;
    const fp = ws.panes.find((p) => p.id === ws.focusedPaneId);
    const current = ws.title ?? fp?.session.host.name ?? "";
    const next = await askPrompt(t("tabmenu.rename_tab_prompt"), {
      defaultValue: current,
    });
    if (next === null) return;
    const trimmed = next.trim();
    setWorkspaces((wss) =>
      wss.map((w) =>
        w.id === wsId ? { ...w, title: trimmed === "" ? undefined : trimmed } : w,
      ),
    );
  }

  // Merge `fromWsId` INTO `intoWsId`: panes are appended and the layout is
  // wrapped in a row-split with the existing layout on the left and the merged
  // workspace's layout on the right. The source workspace is removed.
  function mergeWorkspace(intoWsId: string, fromWsId: string) {
    if (intoWsId === fromWsId) return;
    setWorkspaces((wss) => {
      const intoWs = wss.find((w) => w.id === intoWsId);
      const fromWs = wss.find((w) => w.id === fromWsId);
      if (!intoWs || !fromWs) return wss;
      const mergedPanes = [...intoWs.panes, ...fromWs.panes];
      const mergedLayout: LayoutNode =
        intoWs.panes.length === 0
          ? fromWs.layout
          : fromWs.panes.length === 0
            ? intoWs.layout
            : {
                kind: "split",
                id: uid("s"),
                dir: "row",
                ratio: 0.5,
                a: intoWs.layout,
                b: fromWs.layout,
              };
      const newFocus = fromWs.focusedPaneId ?? intoWs.focusedPaneId;
      return wss
        .filter((w) => w.id !== fromWsId)
        .map((w) =>
          w.id === intoWsId
            ? {
                ...w,
                panes: mergedPanes,
                layout: mergedLayout,
                focusedPaneId: newFocus,
              }
            : w,
        );
    });
    setActiveWorkspaceId(intoWsId);
  }

  // "Close others" — confirm once with the total live-session count rather
  // than firing N modal dialogs.
  async function closeOtherWorkspaces(keepWsId: string) {
    const others = workspaces.filter((w) => w.id !== keepWsId);
    const liveTotal = others.reduce(
      (n, w) =>
        n +
        w.panes.filter(
          (p) =>
            p.session.status === "connected" ||
            p.session.status === "connecting",
        ).length,
      0,
    );
    if (settings.confirmClose && liveTotal > 0) {
      const ok = await askConfirm(
        t("app.confirm_close_workspace", { n: liveTotal }),
        { destructive: true },
      );
      if (!ok) return;
    }
    for (const w of others) {
      // Skip the per-workspace confirm — we already asked once above.
      await closeWorkspaceSilent(w.id);
    }
  }

  async function closeWorkspace(wsId: string) {
    const ws = workspaces.find((w) => w.id === wsId);
    if (!ws) return;
    const live = ws.panes.filter(
      (p) =>
        p.session.status === "connected" || p.session.status === "connecting",
    );
    // Confirm only when closing a multi-pane workspace (single tab closes
    // without nagging — that's just one session).
    if (settings.confirmClose && ws.panes.length > 1 && live.length > 0) {
      const ok = await askConfirm(
        t("app.confirm_close_workspace", { n: live.length }),
        { destructive: true },
      );
      if (!ok) return;
    }
    await closeWorkspaceSilent(wsId);
  }

  // Internal: closeWorkspace without the confirm prompt. Used by closeWorkspace
  // (after it asked) and by closeOtherWorkspaces (which asks once for the batch).
  async function closeWorkspaceSilent(wsId: string) {
    const ws = workspaces.find((w) => w.id === wsId);
    if (!ws) return;
    for (const p of ws.panes) {
      if (p.session.status === "connected") {
        sshDisconnect(p.session.id).catch(() => {});
      }
      clearReconnect(p.session.id);
      // Stash for Ctrl+Shift+T (restore last closed). closePane does this for
      // intra-workspace splits; here we cover whole-tab closes (TabBar X).
      closedStackRef.current.push(p.session.host);
      if (closedStackRef.current.length > 20) closedStackRef.current.shift();
    }
    // Pick a sensible successor before mutating state — same index, else last.
    const idx = workspaces.findIndex((w) => w.id === wsId);
    const remaining = workspaces.filter((w) => w.id !== wsId);
    const successor =
      remaining.length === 0
        ? null
        : remaining[Math.min(idx, remaining.length - 1)].id;
    setWorkspaces(remaining);
    if (activeWorkspaceId === wsId) setActiveWorkspaceId(successor);
  }

  async function closePane(wsId: string, paneId: string) {
    const ws = workspaces.find((w) => w.id === wsId);
    if (!ws) return;
    const pane = ws.panes.find((p) => p.id === paneId);
    if (!pane) return;
    // No confirm here — single pane = single tab, user closes it; for the
    // whole multi-pane workspace the confirm fires in closeWorkspace.
    if (pane.session.status === "connected") {
      sshDisconnect(pane.session.id).catch(() => {});
    }
    clearReconnect(pane.session.id);
    // Stash for Ctrl+Shift+T (restore last closed). Keep last 20 hosts only.
    closedStackRef.current.push(pane.session.host);
    if (closedStackRef.current.length > 20) closedStackRef.current.shift();
    // Last pane in the workspace → close the workspace too (no extra prompt,
    // user already confirmed).
    if (ws.panes.length <= 1) {
      const idx = workspaces.findIndex((w) => w.id === wsId);
      const remaining = workspaces.filter((w) => w.id !== wsId);
      const successor =
        remaining.length === 0
          ? null
          : remaining[Math.min(idx, remaining.length - 1)].id;
      setWorkspaces(remaining);
      if (activeWorkspaceId === wsId) setActiveWorkspaceId(successor);
      return;
    }
    // Otherwise, drop the pane and collapse its leaf out of the layout tree.
    setWorkspaces((ws_) =>
      ws_.map((w) => {
        if (w.id !== wsId) return w;
        const remainingPanes = w.panes.filter((p) => p.id !== paneId);
        const newLayout =
          removeLeaf(w.layout, paneId) ?? {
            kind: "leaf" as const,
            paneId: remainingPanes[0].id,
          };
        const newFocused =
          w.focusedPaneId === paneId
            ? remainingPanes[remainingPanes.length - 1].id
            : w.focusedPaneId;
        return {
          ...w,
          panes: remainingPanes,
          layout: newLayout,
          focusedPaneId: newFocused,
        };
      }),
    );
  }

  // Move a pane out of its source workspace into a brand-new workspace as a
  // single pane. The session is NOT touched — the TerminalView keeps running
  // because it lives in the flat layer keyed by session.id; only the
  // pane-tree / workspace bookkeeping changes around it.
  // Drag-insert: rearrange a pane inside its workspace by dropping it on
  // another pane's edge. The dragged leaf gets cut out of the current layout
  // and the target leaf is wrapped in a split with the dragged leaf at the
  // chosen edge. No new pane is created, no session touched — purely a layout
  // reshape, so the terminal (flat layer, keyed by session.id) survives.
  function insertPaneAtEdge(
    wsId: string,
    dragPaneId: string,
    targetPaneId: string,
    edge: PaneEdge,
  ) {
    if (dragPaneId === targetPaneId) return;
    setWorkspaces((wss) =>
      wss.map((w) => {
        if (w.id !== wsId) return w;
        const removed = removeLeaf(w.layout, dragPaneId);
        if (!removed) return w; // would mean drag pane was the whole layout
        const dragLeaf: LayoutNode = { kind: "leaf", paneId: dragPaneId };
        const targetLeaf: LayoutNode = { kind: "leaf", paneId: targetPaneId };
        const dir: "row" | "col" =
          edge === "left" || edge === "right" ? "row" : "col";
        const dragFirst = edge === "left" || edge === "top";
        const newSplit: LayoutNode = {
          kind: "split",
          id: uid("s"),
          dir,
          ratio: 0.5,
          a: dragFirst ? dragLeaf : targetLeaf,
          b: dragFirst ? targetLeaf : dragLeaf,
        };
        const layout = replaceLeaf(removed, targetPaneId, newSplit);
        return { ...w, layout, focusedPaneId: dragPaneId };
      }),
    );
  }

  // Compute which pane the cursor is hovering and which of its edges (within a
  // 35% zone) is closest. Returns null when not over any other pane's edge.
  function findPaneEdgeAt(
    ws: Workspace,
    cursorX: number,
    cursorY: number,
    mainRect: DOMRect,
    excludePaneId: string,
  ): { paneId: string; edge: PaneEdge } | null {
    const rects = new Map<string, Rect>();
    computeRects(ws.layout, { left: 0, top: 0, width: 100, height: 100 }, rects);
    const EDGE_FRAC = 0.35;
    for (const p of ws.panes) {
      if (p.id === excludePaneId) continue;
      const r = rects.get(p.id);
      if (!r) continue;
      const left = mainRect.left + (r.left / 100) * mainRect.width;
      const top = mainRect.top + (r.top / 100) * mainRect.height;
      const width = (r.width / 100) * mainRect.width;
      const height = (r.height / 100) * mainRect.height;
      if (
        cursorX < left ||
        cursorX > left + width ||
        cursorY < top ||
        cursorY > top + height
      )
        continue;
      const fx = (cursorX - left) / width; // 0..1
      const fy = (cursorY - top) / height;
      const distLeft = fx;
      const distRight = 1 - fx;
      const distTop = fy;
      const distBottom = 1 - fy;
      const min = Math.min(distLeft, distRight, distTop, distBottom);
      if (min > EDGE_FRAC) return null;
      let edge: PaneEdge = "left";
      if (min === distRight) edge = "right";
      else if (min === distTop) edge = "top";
      else if (min === distBottom) edge = "bottom";
      else edge = "left";
      return { paneId: p.id, edge };
    }
    return null;
  }

  function extractPaneToNewWorkspace(wsId: string, paneId: string) {
    setWorkspaces((ws_) => {
      const source = ws_.find((w) => w.id === wsId);
      if (!source) return ws_;
      // No-op when the source has only this pane — it would just be a rename.
      if (source.panes.length <= 1) return ws_;
      const moved = source.panes.find((p) => p.id === paneId);
      if (!moved) return ws_;
      const remainingPanes = source.panes.filter((p) => p.id !== paneId);
      const newSourceLayout =
        removeLeaf(source.layout, paneId) ?? {
          kind: "leaf" as const,
          paneId: remainingPanes[0].id,
        };
      const newSourceFocused =
        source.focusedPaneId === paneId
          ? remainingPanes[remainingPanes.length - 1].id
          : source.focusedPaneId;
      const newWs: Workspace = {
        id: uid("w"),
        panes: [moved],
        layout: { kind: "leaf", paneId: moved.id },
        focusedPaneId: moved.id,
      };
      const next = ws_.map((w) =>
        w.id === wsId
          ? {
              ...w,
              panes: remainingPanes,
              layout: newSourceLayout,
              focusedPaneId: newSourceFocused,
            }
          : w,
      );
      next.push(newWs);
      // Defer activeWorkspaceId switch — setState inside setState is unsafe.
      queueMicrotask(() => setActiveWorkspaceId(newWs.id));
      return next;
    });
  }

  // Start dragging a pane by its header. Tracks pointer movement; once the
  // cursor leaves the main-area bounding rect by >24px we mark the drag
  // "active" and the floating chip starts following. On release outside the
  // main area we extract the pane into a new workspace.
  function startPaneDrag(
    e: React.PointerEvent,
    wsId: string,
    paneId: string,
  ) {
    // Only left button — ignore right-click & touch-pan.
    if (e.button !== 0) return;
    const ws = workspaces.find((w) => w.id === wsId);
    if (!ws) return;
    const pane = ws.panes.find((p) => p.id === paneId);
    if (!pane) return;
    // Extraction only makes sense when the workspace has another pane to
    // leave behind. Single-pane workspaces just focus on click.
    if (ws.panes.length <= 1) return;
    const hostLabel = `${pane.session.host.user}@${pane.session.host.host}`;
    const startX = e.clientX;
    const startY = e.clientY;
    let armed = false; // becomes true once we've crossed the threshold
    const SLIP = 24;
    const onMove = (ev: PointerEvent) => {
      const main = mainAreaRef.current;
      const r = main?.getBoundingClientRect();
      const outside =
        !r ||
        ev.clientX < r.left - SLIP ||
        ev.clientX > r.right + SLIP ||
        ev.clientY < r.top - SLIP ||
        ev.clientY > r.bottom + SLIP;
      // Also arm if user moved a lot from the header even while still over
      // the workspace — covers the case where they then drag back out.
      const movedFar =
        Math.abs(ev.clientX - startX) > 12 ||
        Math.abs(ev.clientY - startY) > 12;
      if (!armed && (outside || movedFar)) armed = true;
      if (armed) {
        setPaneDragState({
          wsId,
          paneId,
          hostLabel,
          x: ev.clientX,
          y: ev.clientY,
          active: outside,
        });
        // Inside the main area, look for another pane the cursor is hovering
        // and compute an edge hint (insert here on release).
        if (!outside && r) {
          const ws2 = workspaces.find((w) => w.id === wsId);
          const hint = ws2
            ? findPaneEdgeAt(ws2, ev.clientX, ev.clientY, r, paneId)
            : null;
          if (
            hint?.paneId !== paneEdgeHintRef.current?.paneId ||
            hint?.edge !== paneEdgeHintRef.current?.edge
          ) {
            setPaneEdgeHint(hint);
          }
        } else if (paneEdgeHintRef.current) {
          setPaneEdgeHint(null);
        }
      }
    };
    const finish = (ev: PointerEvent | null) => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("blur", onCancel);
      const s = paneDragRef.current;
      const hint = paneEdgeHintRef.current;
      setPaneDragState(null);
      setPaneEdgeHint(null);
      if (!ev || !s) return;
      const main = mainAreaRef.current;
      const r = main?.getBoundingClientRect();
      const outside =
        !r ||
        ev.clientX < r.left ||
        ev.clientX > r.right ||
        ev.clientY < r.top ||
        ev.clientY > r.bottom;
      if (outside) {
        extractPaneToNewWorkspace(s.wsId, s.paneId);
      } else if (hint) {
        insertPaneAtEdge(s.wsId, s.paneId, hint.paneId, hint.edge);
      }
    };
    const onUp = (ev: PointerEvent) => finish(ev);
    const onCancel = () => finish(null);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("blur", onCancel);
  }

  // The ⋮ button on a PaneHeader opens this menu — actions targeting a SPECIFIC
  // pane (vs the workspace-tab right-click menu which always acts on the
  // workspace's focused pane).
  function openPaneMenu(wsId: string, paneId: string, x: number, y: number) {
    const ws = workspaces.find((w) => w.id === wsId);
    if (!ws) return;
    const pane = ws.panes.find((p) => p.id === paneId);
    if (!pane) return;
    const sid = pane.session.id;
    const host = pane.session.host;
    const canExtract = ws.panes.length > 1;
    setMenu({
      x,
      y,
      items: [
        {
          label: transcriptTabs.has(sid)
            ? t("tabmenu.exit_transcript")
            : t("tabmenu.open_transcript"),
          onClick: () => toggleTranscript(sid),
        },
        {
          label: t("tabmenu.restart"),
          onClick: () => restartSession(sid),
          disabled: pane.session.status === "connecting",
        },
        {
          label: t("tabmenu.split_right"),
          onClick: () => {
            // Re-focus this pane first so the split lands next to it.
            setFocusedPane(wsId, paneId);
            splitFocusedPane(wsId, "row");
          },
        },
        {
          label: t("tabmenu.split_down"),
          onClick: () => {
            setFocusedPane(wsId, paneId);
            splitFocusedPane(wsId, "col");
          },
        },
        {
          label: t("sidebar.menu_sftp"),
          onClick: () => openSftp(host),
        },
        { separator: true, label: "" },
        {
          label: t("tabmenu.move_to_new_tab"),
          onClick: () => extractPaneToNewWorkspace(wsId, paneId),
          disabled: !canExtract,
        },
        {
          label: t("tabmenu.close_current_tab"),
          onClick: () => closePane(wsId, paneId),
          destructive: true,
        },
      ],
    });
  }

  // Per-session auto-reconnect bookkeeping. Each entry tracks how many retry
  // attempts have been made + the pending setTimeout handle so we can cancel
  // when the user explicitly closes the pane.
  const reconnectRef = useRef(
    new Map<string, { attempts: number; timer: number | null }>(),
  );

  const RECONNECT_DELAYS = [2000, 4000, 8000, 16000, 30000];

  function clearReconnect(sessionId: string) {
    const r = reconnectRef.current.get(sessionId);
    if (r?.timer != null) window.clearTimeout(r.timer);
    reconnectRef.current.delete(sessionId);
  }

  function scheduleReconnect(session: Session) {
    if (!settings.autoReconnect) return;
    const prev = reconnectRef.current.get(session.id) ?? {
      attempts: 0,
      timer: null,
    };
    if (prev.attempts >= RECONNECT_DELAYS.length) {
      updateSession(session.id, (s) => ({
        ...s,
        status: "closed",
        error: t("app.autoreconnect_gave_up", { name: session.host.name }),
      }));
      clearReconnect(session.id);
      return;
    }
    const delay = RECONNECT_DELAYS[prev.attempts];
    const timer = window.setTimeout(() => {
      prev.attempts += 1;
      restartSession(session.id);
    }, delay);
    reconnectRef.current.set(session.id, {
      attempts: prev.attempts,
      timer,
    });
  }

  function markClosed(sessionId: string, reason: string) {
    updateSession(sessionId, (s) => ({ ...s, status: "closed" }));
    // Auto-reconnect only on UNEXPECTED close (network drop, server-side EOF
    // etc.). Don't retry when the user themselves closed the session.
    if (reason === "user disconnected") {
      clearReconnect(sessionId);
      return;
    }
    const found = findPane(sessionId);
    if (found) scheduleReconnect(found.pane.session);
  }

  // Propagate active theme as CSS variables on the root, so every Tailwind
  // arbitrary-value class (e.g. `bg-[var(--nx-bg-base)]`) re-themes for free
  // when the user picks a different palette.
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

  // Drag a split divider: adjust the owning node's ratio live. The split's
  // region (in %) lets us compute ratio against the correct sub-rectangle even
  // when this split is nested inside other splits.
  function startPaneResize(
    e: React.PointerEvent,
    nodeId: string,
    isRow: boolean,
    region: Rect,
  ) {
    e.preventDefault();
    const main = mainAreaRef.current;
    if (!main) return;
    const mr = main.getBoundingClientRect();
    const regionLeft = mr.left + (region.left / 100) * mr.width;
    const regionTop = mr.top + (region.top / 100) * mr.height;
    const regionW = (region.width / 100) * mr.width;
    const regionH = (region.height / 100) * mr.height;
    const onMove = (ev: PointerEvent) => {
      const frac = isRow
        ? (ev.clientX - regionLeft) / regionW
        : (ev.clientY - regionTop) / regionH;
      const ratio = Math.min(0.85, Math.max(0.15, frac));
      setWorkspaces((ws_) =>
        ws_.map((w) =>
          w.id === activeWorkspaceId
            ? { ...w, layout: setNodeRatio(w.layout, nodeId, ratio) }
            : w,
        ),
      );
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

  // Active workspace's layout area: rain + flat terminal layer + overlays +
  // dividers. The terminal layer renders ALL sessions across ALL workspaces
  // (keyed by session.id) and hides the non-active ones via display:none, so
  // a Terminal never remounts when the user switches workspaces.
  function renderActiveLayoutArea(): React.ReactNode {
    const ws = activeWorkspace;
    if (!ws) {
      return (
        <div
          ref={mainAreaRef}
          className="flex-1 min-w-0 relative overflow-hidden"
        >
          <div className="pointer-events-none absolute inset-0 z-30">
            <MatrixRain
              enabled={settings.rainOn}
              density={settings.rainDensity}
              opacity={settings.rainOpacity}
              accent={theme.accent}
              fade={theme.bgBase}
            />
          </div>
          {selectedHost ? (
            <HostInfoCard
              host={selectedHost}
              onConnect={() => openHost(selectedHost)}
              onEdit={() => setEditHost(selectedHost)}
            />
          ) : (
            <div
              className="absolute inset-0 flex items-center justify-center font-mono text-sm pointer-events-none"
              style={{ color: theme.textMuted }}
            >
              <span>
                &gt;{" "}
                {isMobile ? t("terminal.select_host_mobile") : t("terminal.select_host")}
              </span>
            </div>
          )}
        </div>
      );
    }
    const rects = new Map<string, Rect>();
    computeRects(
      ws.layout,
      { left: 0, top: 0, width: 100, height: 100 },
      rects,
    );
    const dividers: DividerInfo[] = [];
    collectDividers(
      ws.layout,
      { left: 0, top: 0, width: 100, height: 100 },
      dividers,
    );
    const multiPane = ws.panes.length > 1;
    const paneRectStyle = (r: Rect): React.CSSProperties => ({
      position: "absolute",
      left: `${r.left}%`,
      top: `${r.top}%`,
      width: `${r.width}%`,
      height: `${r.height}%`,
    });
    // When the workspace is split, the terminal + overlay rects are pushed
    // down by PANE_HEADER_PX to leave room for the PaneHeader chrome strip.
    // The strip itself is rendered in its own layer above (zIndex 22).
    const paneBodyStyle = (
      r: Rect,
      offsetForHeader: boolean,
    ): React.CSSProperties => {
      if (!offsetForHeader) return paneRectStyle(r);
      return {
        position: "absolute",
        left: `${r.left}%`,
        top: `calc(${r.top}% + ${PANE_HEADER_PX}px)`,
        width: `${r.width}%`,
        height: `calc(${r.height}% - ${PANE_HEADER_PX}px)`,
      };
    };
    return (
      <div
        ref={mainAreaRef}
        className="flex-1 min-w-0 relative overflow-hidden"
      >
        {/* Rain — full pane area (no per-pane tabbar offset in the new model). */}
        <div className="pointer-events-none absolute inset-0 z-30">
          <MatrixRain
            enabled={settings.rainOn}
            density={settings.rainDensity}
            opacity={settings.rainOpacity}
            accent={theme.accent}
            fade={theme.bgBase}
          />
        </div>

        {/* STABLE flat terminal layer for ALL workspaces' sessions (keyed by
         *  session.id so React never remounts a Terminal). Inactive workspace
         *  sessions are display:none. */}
        {workspaces.flatMap((w) =>
          w.panes.map((p) => {
            const isActiveWs = w.id === activeWorkspaceId;
            const r = isActiveWs ? rects.get(p.id) : undefined;
            const show =
              isActiveWs &&
              !!r &&
              p.session.status !== "connecting" &&
              !p.session.error;
            // Multi-pane workspaces draw the PaneHeader chrome strip at the
            // top of every pane; the terminal area sits beneath it.
            const offsetForHeader = w.panes.length > 1;
            const style: React.CSSProperties = r
              ? {
                  ...paneBodyStyle(r, offsetForHeader),
                  zIndex: 10,
                  display: show ? "block" : "none",
                }
              : { display: "none" };
            return (
              <div
                key={p.session.id}
                onMouseDownCapture={() => setFocusedPane(w.id, p.id)}
                style={style}
              >
                <TerminalView
                  sessionId={p.session.id}
                  visible={show}
                  onSessionClosed={(reason) =>
                    markClosed(p.session.id, reason)
                  }
                  onReconnect={() => restartSession(p.session.id)}
                  onContextMenu={(x, y, items) =>
                    setMenu({ x, y, items })
                  }
                />
              </div>
            );
          }),
        )}

        {/* Per-pane overlays of the active workspace. Drops the focus-ring
         *  overlay — in split mode the PaneHeader stripe + background already
         *  convey focus, and a single-pane workspace doesn't need one. */}
        {ws.panes.map((p) => {
          const r = rects.get(p.id);
          if (!r) return null;
          // Overlays sit on the terminal body (below the header strip when
          // multiPane), so they match what the user sees as the "pane".
          const cs: React.CSSProperties = paneBodyStyle(r, multiPane);
          return (
            <Fragment key={"ov-" + p.id}>
              {p.session.status === "connecting" && (
                <div
                  style={{ ...cs, zIndex: 15 }}
                  className="flex items-center justify-center font-mono text-sm"
                >
                  <span style={{ color: theme.warning }}>
                    {t("terminal.connecting_to", {
                      user: p.session.host.user,
                      host: p.session.host.host,
                      port: p.session.host.port,
                    })}
                  </span>
                </div>
              )}
              {p.session.error && (
                <div
                  style={{ ...cs, zIndex: 16 }}
                  className="flex items-center justify-center p-6"
                >
                  <div
                    className="max-w-md font-mono text-sm border rounded-nx p-4"
                    style={{
                      borderColor: theme.error,
                      background: theme.bgPanel,
                    }}
                  >
                    <div className="mb-2" style={{ color: theme.error }}>
                      ✗{" "}
                      {t("terminal.connect_failed", {
                        host: p.session.host.host,
                      })}
                    </div>
                    <div
                      className="mb-3 break-words"
                      style={{ color: theme.textSoft }}
                    >
                      {p.session.error}
                    </div>
                    <button
                      type="button"
                      onClick={() => restartSession(p.session.id)}
                      className="px-3 py-1 rounded-nx-sm border cursor-pointer hover:opacity-80"
                      style={{ borderColor: theme.border, color: theme.accent }}
                    >
                      {t("terminal.retry")}
                    </button>
                  </div>
                </div>
              )}
              {transcriptTabs.has(p.session.id) && (
                <div style={{ ...cs, zIndex: 20 }}>
                  <TranscriptOverlay
                    sessionId={p.session.id}
                    hostLabel={`${p.session.host.user}@${p.session.host.host}`}
                    onClose={() => toggleTranscript(p.session.id)}
                    onContextMenu={(x, y, items) =>
                      setMenu({ x, y, items })
                    }
                  />
                </div>
              )}
            </Fragment>
          );
        })}

        {/* PaneHeader chrome strip — only when the workspace has ≥2 panes.
         *  Sits above the terminal body (zIndex 22) and is the drag handle
         *  for pane extraction. */}
        {multiPane &&
          ws.panes.map((p) => {
            const r = rects.get(p.id);
            if (!r) return null;
            return (
              <div
                key={"hdr-" + p.id}
                style={{
                  position: "absolute",
                  left: `${r.left}%`,
                  top: `${r.top}%`,
                  width: `${r.width}%`,
                  height: PANE_HEADER_PX,
                  zIndex: 22,
                }}
              >
                <PaneHeader
                  hostLabel={`${p.session.host.user}@${p.session.host.host}`}
                  status={p.session.status}
                  focused={p.id === ws.focusedPaneId}
                  onClick={() => setFocusedPane(ws.id, p.id)}
                  onClose={() => closePane(ws.id, p.id)}
                  onMenu={(x, y) => openPaneMenu(ws.id, p.id, x, y)}
                  onDragStart={(e) => startPaneDrag(e, ws.id, p.id)}
                />
              </div>
            );
          })}

        {/* Drag-insert edge preview — the half of the hovered pane that the
         *  dragged pane would occupy on release. */}
        {paneEdgeHint &&
          (() => {
            const r = rects.get(paneEdgeHint.paneId);
            if (!r) return null;
            const e = paneEdgeHint.edge;
            const baseStyle: React.CSSProperties = {
              position: "absolute",
              zIndex: 45,
              background: "var(--nx-accent)",
              opacity: 0.18,
              border: "1px solid var(--nx-accent)",
              pointerEvents: "none",
            };
            // Half of the target pane on the chosen edge.
            const halfW = `${r.width / 2}%`;
            const halfH = `${r.height / 2}%`;
            const edgeStyle: React.CSSProperties =
              e === "right"
                ? {
                    left: `${r.left + r.width / 2}%`,
                    top: `${r.top}%`,
                    width: halfW,
                    height: `${r.height}%`,
                  }
                : e === "left"
                  ? {
                      left: `${r.left}%`,
                      top: `${r.top}%`,
                      width: halfW,
                      height: `${r.height}%`,
                    }
                  : e === "top"
                    ? {
                        left: `${r.left}%`,
                        top: `${r.top}%`,
                        width: `${r.width}%`,
                        height: halfH,
                      }
                    : {
                        left: `${r.left}%`,
                        top: `${r.top + r.height / 2}%`,
                        width: `${r.width}%`,
                        height: halfH,
                      };
            return <div style={{ ...baseStyle, ...edgeStyle }} />;
          })()}

        {/* Split dividers. */}
        {dividers.map((d) => (
          <div
            key={d.id}
            onPointerDown={(e) => startPaneResize(e, d.id, d.isRow, d.region)}
            className={
              (d.isRow ? "cursor-col-resize" : "cursor-row-resize") +
              " bg-transparent hover:bg-[var(--nx-accent)]/40 active:bg-[var(--nx-accent)]/60 transition-colors"
            }
            style={
              d.isRow
                ? {
                    position: "absolute",
                    left: `calc(${d.at}% - 2px)`,
                    top: `${d.cross}%`,
                    width: 4,
                    height: `${d.len}%`,
                    zIndex: 40,
                  }
                : {
                    position: "absolute",
                    top: `calc(${d.at}% - 2px)`,
                    left: `${d.cross}%`,
                    height: 4,
                    width: `${d.len}%`,
                    zIndex: 40,
                  }
            }
          />
        ))}
      </div>
    );
  }

  return (
    <main className="h-full w-full flex flex-col relative" style={themeStyle}>
      {/* Brief full-app matrix burst on connect (keyed so it replays). */}
      {rainBurst > 0 && <div key={rainBurst} className="nx-rain-burst" />}

      {isMobile ? (
        <MobileTopBar
          title={activeSession?.name ?? `NexuSSH v${version}`}
          subtitle={
            activeSession
              ? `${activeSession.user}@${activeSession.host}`
              : undefined
          }
          onDrawer={() => setMobileDrawerOpen((v) => !v)}
          items={[
            {
              label: t("history.button"),
              onClick: () => setHistoryPanelOpen(true),
            },
            {
              label: "sync",
              onClick: () => setSyncPanelOpen(true),
              warn: sync?.configured && !sync?.unlocked,
              active: sync?.unlocked,
            },
            ...(settings.advanced
              ? [
                  {
                    label: "vault",
                    onClick: () => setVaultPanelOpen(true),
                    warn: vault?.configured && !vault?.unlocked,
                    active: vault?.unlocked,
                  },
                ]
              : []),
            {
              label: t("settings.open"),
              onClick: () => setSettingsOpen(true),
            },
            {
              label: t("topbar.check_update"),
              onClick: () => {
                setUpdatePanel({ initial: undefined });
                startupCheck()
                  .then((info) => setUpdatePanel({ initial: info }))
                  .catch(() => {});
              },
            },
          ]}
        />
      ) : (
      <header
        data-tauri-drag-region
        className="nx-safe-top relative z-10 h-9 bg-nx-bg-2 border-b border-nx-border flex items-center px-3 gap-3 select-none shrink-0"
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

        {/* Prompt-style breadcrumb of the focused pane's session */}
        {activeSession && !isMobile && (
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
            icon={<HelpCircle size={12} />}
            onClick={() => setShortcutsOpen(true)}
            title={t("shortcuts.open_title") + " (?)"}
          />
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
      )}

      <div className="relative z-10 flex-1 min-h-0 flex">
        {/* Desktop: inline sidebar + drag-divider. Mobile: drawer overlay
         *  triggered by the hamburger; no inline space taken. */}
        {!isMobile && (
          <>
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
              onContextMenu={(x, y, items, title) =>
                setMenu({ x, y, items, title })
              }
              clickMode={settings.clickMode}
            />
            {!sidebarCollapsed && (
              <div
                onPointerDown={startSidebarResize}
                title={t("sidebar.resize")}
                className="shrink-0 w-1 cursor-col-resize bg-transparent hover:bg-[var(--nx-accent)]/40 active:bg-[var(--nx-accent)]/60 transition-colors"
              />
            )}
          </>
        )}
        {isMobile && mobileDrawerOpen && (
          <>
            <div
              className="fixed inset-0 z-30 bg-black/50"
              onClick={() => setMobileDrawerOpen(false)}
            />
            <aside
              className="fixed left-0 bottom-0 z-40 w-[82vw] max-w-[320px] bg-nx-bg shadow-2xl"
              style={{ top: "calc(56px + env(safe-area-inset-top))" }}
              onClick={(e) => e.stopPropagation()}
            >
              <Sidebar
                onConnect={(h) => {
                  setMobileDrawerOpen(false);
                  openHost(h);
                }}
                onSftp={(h) => {
                  setMobileDrawerOpen(false);
                  openSftp(h);
                }}
                onSelect={setSelectedHost}
                activeHostId={activeSession?.id ?? null}
                openHostIds={openHostIds}
                selectedId={selectedHost?.id ?? null}
                collapsed={false}
                onToggleCollapsed={() => setMobileDrawerOpen(false)}
                width={320}
                onContextMenu={(x, y, items, title) =>
                  setMenu({ x, y, items, title })
                }
                clickMode={settings.clickMode}
              />
            </aside>
          </>
        )}
        <div className="flex-1 min-w-0 flex flex-col">
          <TabBar
            pulseId={switchPulseId}
            tabs={workspaces.map((w) => {
              const fp = w.panes.find((p) => p.id === w.focusedPaneId);
              return {
                id: w.id,
                title: w.title ?? fp?.session.host.name ?? "?",
                status: fp?.session.status ?? "closed",
                paneCount: w.panes.length,
              };
            })}
            activeId={activeWorkspaceId}
            onSelect={(id) => setActiveWorkspaceId(id)}
            onClose={(id) => closeWorkspace(id)}
            onNewTab={openSshPicker}
            onNewTabDropdown={openNewTabMenu}
            onContextMenu={onWorkspaceContextMenu}
            onReorder={reorderWorkspaces}
            onDragCancel={() => {
              /* nothing to clear — no edge-band in the workspace model */
            }}
          />
          <div className="flex-1 min-h-0 flex flex-col">
            {renderActiveLayoutArea()}
          </div>
          {/* Soft-keyboard helper strip on mobile when a session is live. */}
          {isMobile && (
            <SmartKeyBar
              visible={!!focusedSession && focusedSession.status === "connected"}
              onSend={(s) => {
                if (!focusedSession) return;
                const bytes = new TextEncoder().encode(s);
                sshSend(focusedSession.id, bytes).catch(() => {});
              }}
            />
          )}
        </div>
      </div>

      {!isMobile && (
        <StatusLine
          sessionCount={allSessions.length}
          connectingCount={
            allSessions.filter((s) => s.status === "connecting").length
          }
          syncStatus={sync?.unlocked ? "ok" : sync?.configured ? "pending" : "off"}
        />
      )}

      {/* Lazy-loaded panels: rendered only when the user opens them. Bundle
       *  splitting keeps the initial JS chunk small. Suspense fallback is null
       *  — the brief load gap on first open is acceptable for a modal. */}
      <Suspense fallback={null}>
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
      </Suspense>
      {pickerOpen && (
        <TabPicker
          onPick={(h) => {
            if (pickerMode === "sftp") {
              openSftp(h);
            } else if (pendingSplit) {
              completeSplit(pendingSplit, h);
              setPendingSplit(null);
            } else {
              openHost(h);
            }
            setPickerOpen(false);
          }}
          onCreateNew={() => {
            // Open HostDialog in CREATE mode. TabPicker closes itself
            // after invoking the callback.
            setCreateHostOpen(true);
          }}
          onClose={() => {
            setPickerOpen(false);
            setPendingSplit(null);
          }}
        />
      )}
      <Suspense fallback={null}>
        {updatePanel !== null && (
          <UpdatePanel
            initial={updatePanel.initial}
            onClose={() => setUpdatePanel(null)}
          />
        )}
      </Suspense>
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
      {createHostOpen && (
        <HostDialog
          onClose={() => setCreateHostOpen(false)}
          onSaved={(saved) => {
            setSelectedHost(saved);
            setCreateHostOpen(false);
          }}
        />
      )}

      {shortcutsOpen && (
        <ShortcutsOverlay onClose={() => setShortcutsOpen(false)} />
      )}

      {/* Settings as an OVERLAY (not a return-replacement) so TerminalView
       *  stays mounted underneath — opening Settings no longer disconnects
       *  the active SSH session. */}
      {settingsOpen && (
        <div className="fixed inset-0 z-40">
          <Suspense fallback={null}>
            <SettingsScreen
              onClose={() => setSettingsOpen(false)}
              sessionCount={allSessions.length}
            />
          </Suspense>
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

      <DialogHost />

      {/* Pane-extract drag chip — follows the cursor while a header drag is
       *  active and the user has crossed out of the main area. Translucent
       *  accent bg + ↗ extract hint. zIndex 100 puts it above all panels. */}
      {paneDragState && paneDragState.active && (
        <div
          className="fixed pointer-events-none font-mono text-meta select-none"
          style={{
            left: paneDragState.x + 12,
            top: paneDragState.y + 12,
            zIndex: 100,
            background: "color-mix(in srgb, var(--nx-accent) 22%, var(--nx-bg-panel))",
            color: "var(--nx-text-primary)",
            border: "1px solid var(--nx-accent)",
            borderRadius: 4,
            padding: "4px 8px",
            boxShadow: "0 4px 16px rgba(0,0,0,0.35)",
            whiteSpace: "nowrap",
            display: "flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          <span style={{ color: "var(--nx-accent)" }}>↗</span>
          <span style={{ opacity: 0.75 }}>{t("tabmenu.move_to_new_tab")}</span>
          <span style={{ opacity: 0.5 }}>·</span>
          <span>{paneDragState.hostLabel}</span>
        </div>
      )}
    </main>
  );
}

export default App;
