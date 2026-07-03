import { useState, useEffect, useRef, Fragment, Suspense, lazy } from "react";
import { useTranslation } from "react-i18next";
import {
  Lock,
  Unlock,
  KeyRound,
  Settings as SettingsIcon,
  HelpCircle,
  History as HistoryIcon,
  Network as NetworkIcon,
  Search,
  Server,
  Zap,
  RotateCcw,
  SplitSquareHorizontal,
  SplitSquareVertical,
  ArrowLeftRight,
  SquarePen,
  XSquare,
  FolderInput,
  Folder,
  X,
  Plus,
  Copy,
  FileCode2,
} from "lucide-react";
import { Sidebar } from "./Sidebar";
import { TabBar } from "./TabBar";
import { TerminalView } from "./Terminal";
import { DialogHost } from "./DialogHost";
import { askConfirm } from "./dialogs";
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
const MobileFiles = lazy(() =>
  import("./MobileFiles").then((m) => ({ default: m.MobileFiles })),
);
const SFTPPanel = lazy(() =>
  import("./SFTPPanel").then((m) => ({ default: m.SFTPPanel })),
);
const TunnelsPanel = lazy(() =>
  import("./TunnelsPanel").then((m) => ({ default: m.TunnelsPanel })),
);
import { StatusLine } from "./StatusLine";
import type { ConnectArgs, HostKeyPromptInfo } from "./ssh";
import { TabPicker } from "./TabPicker";
import { SnippetsModal } from "./SnippetsModal";
import AiPanel from "./AiPanel";
import AiIndicatorDot from "./AiIndicatorDot";
import CommandPalette, { type PaletteItem } from "./CommandPalette";
import { listSnippets, expandPlaceholders } from "./snippets";
import { useAiAssistant } from "./useAiAssistant";
import { readTerminalScreen, readTerminalPromptLine } from "./terminalBuffers";
import { redactSecrets } from "./redactSecrets";
import { detectPlatform, guessOs } from "./ai";
import { ConnectError } from "./ConnectError";
import { parseConnectError } from "./connect-error";
const UpdatePanel = lazy(() =>
  import("./UpdatePanel").then((m) => ({ default: m.UpdatePanel })),
);
import { ContextMenu, MenuItem } from "./ContextMenu";
import { buildAppContextMenu } from "./contextMenuItems";
import { HostInfoCard } from "./HostInfoCard";
import { HostDialog } from "./HostDialog";
import { ResizeHandles } from "./ResizeHandles";
import { historyPause } from "./history";
import { PasswordPrompt } from "./PasswordPrompt";
const SettingsScreen = lazy(() =>
  import("./SettingsScreen").then((m) => ({ default: m.SettingsScreen })),
);
const HistoryPanel = lazy(() =>
  import("./HistoryPanel").then((m) => ({ default: m.HistoryPanel })),
);
import { PaneHeader } from "./PaneHeader";
import { Button } from "./components/primitives";
import { useSettings } from "./settings/settings-store";
import { THEMES, applyTheme } from "./settings/themes";
import { fontStackOf } from "./settings/fonts";
import { MatrixRain } from "./settings/MatrixRain";
import { UpdateInfo, startupCheck } from "./updater";
import { sshConnect, sshDisconnect, sshSend, hostReachable, resolveAuth, setHostKeyPrompt } from "./ssh";
import { ConfirmDialog } from "./ConfirmDialog";
import type { AuthMethod } from "./ssh";
import { useIsMobile } from "./useIsMobile";
import { SmartKeyBar } from "./SmartKeyBar";
import { ShortcutsOverlay } from "./ShortcutsOverlay";
import { MobileTopBar } from "./MobileTopBar";
import { MobileTabBar, type MobileTab } from "./MobileTabBar";
import type { VpnNode } from "./vpn";
import { getProfile, resolveExit } from "./vpn";
import { HostRecord, bumpLastUsed, refreshHosts, reconcileHostEncryption, hostsEncrypted, newHostId, saveHost, listHosts, onHostsChanged } from "./hosts";
import { tunnelOpen, tunnelList, TunnelInfo, PortForward } from "./tunnel";
import {
  VaultStatus,
  vaultStatus,
  vaultLock,
  VAULT_LOCKED_EVENT,
  VAULT_UNLOCKED_EVENT,
} from "./vault";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { KbiPromptDialog, type KbiRequest } from "./KbiPromptDialog";
import {
  findPlaintextPasswordHosts,
  migratePlaintextToVault,
} from "./secretsMigration";
import { VaultLockScreen } from "./VaultLockScreen";
import { getVersion } from "@tauri-apps/api/app";
import { getCurrentWindow } from "@tauri-apps/api/window";

// `getCurrentWindow()` and the window plugin only exist inside a Tauri webview;
// in a plain dev browser they throw and unmount the whole React tree. Gate any
// caller behind this flag and degrade gracefully (no titlebar controls, no
// "intercept close" listener — the browser doesn't have those concepts).
const HAS_TAURI =
  typeof window !== "undefined" &&
  // @ts-expect-error — Tauri marker, not in DOM lib types
  typeof window.__TAURI_INTERNALS__ !== "undefined";

// The first/default window is labelled "main"; a second launch opens additional
// windows ("main-1", …) in the SAME process (see single-instance in lib.rs).
// Only the primary window restores and persists the saved tab/workspace layout,
// so secondary windows start empty instead of cloning the primary's sessions
// and fighting over the shared localStorage layout key.
const IS_PRIMARY_WINDOW = (() => {
  if (!HAS_TAURI) return true;
  try {
    return getCurrentWindow().label === "main";
  } catch {
    return true;
  }
})();
import {
  Minus,
  Square,
  Copy as RestoreIcon,
  X as CloseIcon,
  Terminal as TerminalIcon,
  FolderOpen,
  Cloud,
  CloudOff,
  Sparkles,
  Cable,
  ArrowUpCircle,
} from "lucide-react";
import { accountStatus, accountSyncNow } from "./account";
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

// First-run nudge to set up the vault. Shown once (when no vault exists yet);
// "Later" or setting one up flips this flag so we never nag again.
const VAULT_PROMPT_SEEN_LS_KEY = "nexussh.vaultPromptSeen";
function vaultPromptSeen(): boolean {
  return localStorage.getItem(VAULT_PROMPT_SEEN_LS_KEY) === "1";
}
function markVaultPromptSeen() {
  localStorage.setItem(VAULT_PROMPT_SEEN_LS_KEY, "1");
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
  /** True while an AUTO-reconnect attempt is in flight: the ConnectError card
   *  stays visible (error kept) and shows a "reconnecting…" badge instead of
   *  flickering away on every retry. */
  reconnecting?: boolean;
  /** 1-based auto-reconnect attempt number, for the badge. */
  reconnectAttempt?: number;
  /** Lazy-connect on restore: a restored host that would trigger an interactive
   *  password prompt is left dormant (tab present, NO SSH connection, no prompt)
   *  unless it's the active tab. Activating the tab connects it then. Avoids a
   *  pile of simultaneous password prompts when many such tabs are restored. */
  dormant?: boolean;
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
  tint,
}: {
  icon: React.ReactNode;
  children?: React.ReactNode;
  onClick: () => void;
  title?: string;
  active?: boolean;
  warn?: boolean;
  /** Custom resting text colour (CSS value), e.g. the blue history accent. */
  tint?: string;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      style={tint && !active && !warn ? { color: tint } : undefined}
      className={
        "flex items-center gap-1.5 px-2 py-0.5 rounded-nx-sm font-mono transition-colors duration-[80ms] hover:bg-nx-elevated hover:text-nx-text " +
        (active
          ? "text-nx-accent"
          : warn
            ? "text-nx-warning"
            : tint
              ? ""
              : "text-nx-muted")
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
  // preventDefault on mousedown so a click NEVER moves keyboard focus onto the
  // window button (tabIndex -1 keeps them out of the Tab ring too). Otherwise,
  // after minimize→restore from the taskbar, focus stayed on the Minimize button
  // and the next Enter minimized the app instead of going to the terminal.
  const noFocus = (e: React.MouseEvent) => e.preventDefault();
  return (
    <div className="flex items-stretch h-9 -mr-3 ml-1">
      <button className={btn} tabIndex={-1} onMouseDown={noFocus} onClick={() => win.minimize()} title="Minimize">
        <Minus size={14} />
      </button>
      <button className={btn} tabIndex={-1} onMouseDown={noFocus} onClick={() => win.toggleMaximize()} title="Maximize">
        {maxed ? <RestoreIcon size={12} /> : <Square size={12} />}
      </button>
      <button
        className="inline-flex items-center justify-center w-11 h-9 text-nx-muted hover:bg-nx-error hover:text-white transition-colors duration-[80ms]"
        tabIndex={-1}
        onMouseDown={noFocus}
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
  const [settings, setSettings] = useSettings();
  const theme = THEMES[settings.theme];
  const fontStack = fontStackOf(settings.font);

  // Pump the full palette (incl. new depth/glow tokens) to :root + toggle the
  // theme-<id> class, so tokens.css @theme utilities and .theme-light overrides
  // resolve globally. Runs at mount and on every theme change.
  useEffect(() => {
    applyTheme(settings.theme);
  }, [settings.theme]);

  // Round the borderless Linux window corners — but ONLY when a compositor is
  // present. The window is created transparent (tauri.linux.conf.json); on a
  // machine WITHOUT a compositor that transparency renders as BLACK corners, so
  // there we keep a fully-opaque square background (no rounding, no transparent
  // layers). The Rust `window_composited` command answers compositor-presence
  // via gdk::Screen::is_composited(); only when it's true do we set
  // data-os="linux", which the CSS keys the radius + transparent background off.
  //
  // Android is also "Linux" in the UA, so exclude it the same way updater.ts
  // isAndroid() does. Fail-safe: never throws; on any failure we leave the
  // attribute unset → plain square opaque window (the safe default).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const ua = navigator.userAgent || "";
        const isAndroid = /Android/i.test(ua);
        const isLinux = !isAndroid && /Linux/i.test(ua);
        if (!isLinux || !HAS_TAURI) return;
        const composited = await invoke<boolean>("window_composited");
        if (!cancelled && composited) {
          document.documentElement.setAttribute("data-os", "linux");
          // WebKitGTK paints the transparent corners OPAQUE until a real GTK
          // size-allocate — so rounding only appears after a manual resize. A
          // programmatic Tauri set_size doesn't reliably force one, so the
          // backend nudge_repaint does a native gtk_window.resize (+4px, revert
          // after a tick), the same path a manual edge-drag takes. Run it AFTER
          // the first opaque composite (an early nudge gets overwritten), with a
          // fallback. Once transparency kicks in it persists.
          const fire = () => {
            invoke("nudge_repaint").catch(() => {});
          };
          setTimeout(fire, 350);
          setTimeout(fire, 1100);
        }
      } catch {
        /* no-op: cosmetic only — leave square/opaque on any failure */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Square the window corners while maximised/fullscreen — rounded corners
  // there cut holes that show the desktop at the screen edge. Maximise and
  // fullscreen both change the window size, so onResized covers both; we also
  // check once on mount in case the app launched maximised.
  useEffect(() => {
    if (!HAS_TAURI) return;
    const win = getCurrentWindow();
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    let prevSquared = false;
    const apply = async () => {
      try {
        const squared =
          (await win.isMaximized()) || (await win.isFullscreen());
        if (cancelled) return;
        document.documentElement.toggleAttribute("data-squared", squared);
        // Transition square→rounded (un-maximise / exit fullscreen): WebKitGTK
        // won't repaint the now-transparent corners until a real size-allocate,
        // so they'd stay square until a manual resize. Nudge to force it. Only
        // on this transition — the nudge itself fires onResized, but with
        // squared still false, so prevSquared guards against a loop.
        if (prevSquared && !squared) {
          invoke("nudge_repaint").catch(() => {});
        }
        prevSquared = squared;
      } catch {
        /* ignore */
      }
    };
    apply();
    win
      .onResized(() => apply())
      .then((u) => {
        if (cancelled) u();
        else unlisten = u;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

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
  // AI-ассистент: состояние на уровне App — запрос продолжается при свёрнутой панели.
  // Контекст экрана читаем из активного терминала и РЕДАКТИРУЕМ секреты перед
  // отдачей в хук (тот отправит его в AI только при включённом тумблере + праве).
  const ai = useAiAssistant(
    activeSession?.name ?? activeSession?.host ?? null,
    () => {
      const raw = readTerminalScreen(activeId, 40);
      return raw ? redactSecrets(raw) : null;
    },
    // Платформа: по выводу терминала (Cisco/Mikrotik/…) + строке-приглашению под
    // курсором (ловит Cisco даже в чистой сессии, когда приглашение вверху и низ
    // экрана пуст), затем по имени хоста. Приватно — наружу только ярлык.
    () => {
      const screen = readTerminalScreen(activeId, 40);
      const prompt = readTerminalPromptLine(activeId);
      // Приглашение кладём ПОСЛЕДНЕЙ строкой — детект по «hostname#/>» смотрит хвост.
      const combined = `${screen}\n${prompt}`;
      return (
        detectPlatform(combined) ?? guessOs(activeSession?.name ?? activeSession?.host ?? null)
      );
    },
  );
  // Hosts that have an open pane → "live" badge in the sidebar; the focused
  // pane's host additionally gets the blinking caret.
  const openHostIds = new Set(allSessions.map((s) => s.host.id));

  // Any live session? Drives the Android keep-alive foreground service so the
  // connection survives backgrounding / screen lock (no-op on desktop).
  const hasLiveSession = allSessions.some(
    (s) => s.status === "connected" || s.status === "connecting",
  );

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
                  reconnecting: false,
                  reconnectAttempt: undefined,
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
  // App-lock: when the vault exists but is locked, a full-screen overlay
  // gates the UI (live SSH sessions keep running). Used at launch (unlock
  // first, THEN reconnect) and on manual/idle lock.
  const [appLocked, setAppLocked] = useState(false);
  // Whether vault state is known yet — session restore waits for it so it
  // never reconnects saved-password hosts before the vault unlocks.
  const [vaultChecked, setVaultChecked] = useState(false);
  const [vaultPanelOpen, setVaultPanelOpen] = useState(false);
  const [syncPanelOpen, setSyncPanelOpen] = useState(false);
  const [aiPanelOpen, setAiPanelOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  // Хосты для палитры: грузим при открытии (listHosts async) + рефреш по событию.
  const [paletteHosts, setPaletteHosts] = useState<HostRecord[]>([]);
  useEffect(() => {
    if (!paletteOpen) return;
    let alive = true;
    const load = () =>
      listHosts()
        .then((h) => alive && setPaletteHosts(h))
        .catch(() => {});
    load();
    const off = onHostsChanged(load);
    return () => {
      alive = false;
      off();
    };
  }, [paletteOpen]);
  // Which settings section to deep-link to on open (sync modal → "account").
  const [settingsSection, setSettingsSection] = useState<string | undefined>(undefined);
  // First-run vault nudge — a one-time, dismissible banner offering to set up
  // the vault. Shown only once no vault exists yet (decided after vaultStatus).
  const [vaultPromptOpen, setVaultPromptOpen] = useState(false);
  // SFTP browser state is PER-TAB: keyed by the focused session id, so a
  // collapsed/open browser belongs to one tab's session and never bleeds onto
  // other tabs. `collapsed` keeps the panel MOUNTED (cwd / selection / in-flight
  // transfers preserved) but hidden so the terminal underneath is usable; a
  // floating chip restores it.
  const [sftpBySession, setSftpBySession] = useState<
    Record<
      string,
      {
        args: ConnectArgs;
        title: string;
        collapsed: boolean;
        // Last-visited remote / local dirs for THIS session's browser. Persisted
        // here (not just in the panel) so they survive the panel being unmounted
        // when the user switches to another tab and back — the keyed render
        // remounts the panel, and these seed its initial cwd / local dir.
        remotePath?: string;
        localPath?: string;
      }
    >
  >({});
  // The SFTP entry belonging to the currently-focused session (the only one we
  // ever render). Null when the active session has no SFTP browser open.
  const sftpEntry = activeId ? sftpBySession[activeId] ?? null : null;
  // Mirror of "is the active SFTP panel open?" for the global keydown handler, so
  // it can early-return for the function keys the panel owns (F1/F5–F8) without
  // re-subscribing the listener on every change. Gated on NOT collapsed — while
  // collapsed the panel is hidden and the terminal owns those keys.
  const sftpOpenRef = useRef(false);
  sftpOpenRef.current = !!sftpEntry && !sftpEntry.collapsed;
  // Focus the FOCUSED pane's terminal (its hidden xterm helper textarea) so
  // keystrokes go straight to the PTY after the SFTP panel collapses.
  //
  // Two things made the old version unreliable: (1) it ran inside the collapse
  // setState updater, BEFORE React re-rendered the panel to display:none — the
  // still-visible panel/backdrop held focus, so a single rAF fired too early and
  // the focus was immediately stolen back; (2) it queried `.xterm-helper-textarea`
  // globally, grabbing whichever pane's textarea came first in the DOM rather
  // than the focused pane's (wrong target in split view).
  //
  // Fix: call this AFTER collapsed flips to true, and defer past the DOM settle
  // with a double rAF plus a setTimeout(0) fallback (covers the frame where the
  // panel's own restore-focus effect / display:none haven't applied yet). Scope
  // the lookup to the focused pane via its data-session-id wrapper.
  function focusActiveTerminal() {
    const doFocus = () => {
      const sid = focusedSession?.id;
      const root = sid
        ? document.querySelector<HTMLElement>(`[data-session-id="${sid}"]`)
        : null;
      const ta =
        root?.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea") ??
        document.querySelector<HTMLTextAreaElement>(".xterm-helper-textarea");
      ta?.focus({ preventScroll: true });
    };
    requestAnimationFrame(() => requestAnimationFrame(doFocus));
    // Fallback for the case where the panel's display:none / blur lands a tick
    // later than the rAF pair — re-assert focus once the macrotask queue drains.
    setTimeout(doFocus, 0);
  }
  // Persist the active session's SFTP browser paths whenever the panel reports a
  // navigation. Stored on the per-session entry so a tab-switch remount restarts
  // where the user left off (see initialRemotePath / initialLocalPath below).
  function onSftpPathChange(remotePath: string, localPath: string) {
    if (!activeId) return;
    setSftpBySession((m) =>
      m[activeId]
        ? { ...m, [activeId]: { ...m[activeId], remotePath, localPath } }
        : m,
    );
  }
  // Collapse / restore helpers used by both the panel button and the hotkeys.
  // They act on the ACTIVE session's SFTP entry only.
  function restoreSftp() {
    if (!activeId) return;
    setSftpBySession((m) =>
      m[activeId] ? { ...m, [activeId]: { ...m[activeId], collapsed: false } } : m,
    );
  }
  // Toggle collapse/restore for the active session's SFTP entry. When this
  // collapses the panel we hand keyboard focus back to the terminal — but only
  // AFTER the state commit (the focus helper is deferred), so the panel is
  // actually display:none by the time we focus and won't steal it back.
  function toggleSftpCollapse() {
    if (!activeId) return;
    let collapsing = false;
    setSftpBySession((m) => {
      const e = m[activeId];
      if (!e) return m;
      const next = !e.collapsed;
      collapsing = next;
      return { ...m, [activeId]: { ...e, collapsed: next } };
    });
    if (collapsing) focusActiveTerminal();
  }
  // Close (full unmount) the active session's SFTP entry.
  function closeSftp() {
    if (!activeId) return;
    setSftpBySession((m) => {
      if (!m[activeId]) return m;
      const n = { ...m };
      delete n[activeId];
      return n;
    });
  }
  // Tunnels panel. `open` toggles visibility; `newTunnel` (when set) wires the
  // panel's "+ New tunnel" button to an ad-hoc forward against that host.
  const [tunnelsPanel, setTunnelsPanel] = useState<{
    open: boolean;
    newTunnel: {
      connectArgs: ConnectArgs;
      label: string;
      host?: HostRecord;
    } | null;
  } | null>(null);
  // Transient toast (e.g. "tunnel started"). Auto-dismisses after a few sec.
  const [toast, setToast] = useState<{ msg: string; kind?: "error" } | null>(null);
  const toastTimerRef = useRef<number | null>(null);
  function showToast(msg: string, kind?: "error") {
    setToast({ msg, kind });
    if (toastTimerRef.current != null) window.clearTimeout(toastTimerRef.current);
    // errors linger longer (9s) so they're not missed; info stays 4s.
    toastTimerRef.current = window.setTimeout(() => setToast(null), kind === "error" ? 9000 : 4000);
  }

  // "Always ask password" prompt — promise-based so openHost/openSftp can await
  // a masked, themed dialog instead of the plaintext native window.prompt().
  // A QUEUE, not a single slot. On session restore several "always ask" hosts
  // call askPassword concurrently; a single slot meant each setState clobbered
  // the previous prompt — only the last dialog showed, its password resolved
  // the wrong session, and every other session sat orphaned on "connecting"
  // forever (restart disabled). Queuing shows one dialog at a time, each
  // resolving its OWN session in order.
  const [pwQueue, setPwQueue] = useState<
    {
      id: string;
      user: string;
      host: string;
      resolve: (v: { user: string; password: string } | null) => void;
    }[]
  >([]);
  // Resolves to the (possibly just-entered) login + password, or null if
  // cancelled. For hosts WITH a login it just asks the password; for login-less
  // hosts (imported address-only) it asks both.
  async function askPassword(
    h: HostRecord,
  ): Promise<{ user: string; password: string } | null> {
    // Reachability check BEFORE the password prompt (PuTTY-style) — covers EVERY
    // path that asks for a password (quick-connect, always-ask, reconnect). An
    // offline host says "unreachable" instead of being mistaken for a wrong
    // password. Skip VPN hosts (SOCKS path); fail-open if the probe errors.
    if (!resolveHostVpn(h)) {
      const reachable = await hostReachable(h.host, h.port, 5).catch(() => true);
      if (!reachable) {
        showToast(t("host.unreachable", { host: `${h.host}:${h.port}` }), "error");
        return null;
      }
    }
    return new Promise((resolve) =>
      setPwQueue((q) => [
        ...q,
        { id: crypto.randomUUID(), user: h.user, host: h.host, resolve },
      ]),
    );
  }
  // Same predicate openHost/openSftp/kickoffConnect use to decide a host needs
  // an INTERACTIVE password prompt on connect. Restore makes such hosts dormant
  // (lazy-connect on activation) instead of prompting all at once on startup.
  function needsInteractivePrompt(h: HostRecord): boolean {
    return h.auth.kind === "password" && !!h.alwaysAskPassword;
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
  // Prefilled new-host dialog (e.g. "Save host" from a quick-connect session).
  const [prefillHost, setPrefillHost] = useState<HostRecord | null>(null);
  // When set, the next host picked completes a split inside this workspace
  // rather than opening a new workspace.
  const [pendingSplit, setPendingSplit] = useState<{
    wsId: string;
    paneId: string;
    dir: "row" | "col";
  } | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Header sync indicator: "on" = signed in, "off" = account configured but
  // signed out, "none" = no account (hide). Re-checked on login/logout (those
  // emit hosts-changed).
  const [syncState, setSyncState] = useState<"on" | "off" | "none">("none");
  useEffect(() => {
    const check = () =>
      accountStatus()
        .then((s) => setSyncState(s.logged_in ? "on" : s.configured ? "off" : "none"))
        .catch(() => setSyncState("none"));
    check();
    return onHostsChanged(check);
  }, []);
  const [historyPanelOpen, setHistoryPanelOpen] = useState(false);
  // Active tunnel count → drives the header "tunnels" button highlight.
  // Polled (cheap in-process call) so it reflects tunnels closed from the panel.
  const [activeTunnels, setActiveTunnels] = useState(0);
  useEffect(() => {
    let alive = true;
    const tick = () =>
      tunnelList()
        .then((l) => alive && setActiveTunnels(l.length))
        .catch(() => {});
    tick();
    const id = setInterval(tick, 5000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);
  // Sessions currently being recorded → paused?. Drives the ● REC chip.
  const [recSids, setRecSids] = useState<Record<string, boolean>>({});

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
    title?: { kicker?: string; main?: string; sub?: string };
  } | null>(null);
  // Mobile shell: collapse sidebar into a drawer + adapt header + show
  // SmartKeyBar above the on-screen keyboard. Toggled via media query.
  const isMobile = useIsMobile();
  const [mobileDrawerOpen, setMobileDrawerOpen] = useState(false);
  // Mobile bottom-nav: which of the four destinations is showing. "hosts" is the
  // home. "settings" isn't stored here — tapping it opens the SettingsScreen
  // overlay; "files" (SFTP) lands in a later beta (kept out of the bar until it
  // works). Hosts ⇄ Sessions are the two persistent content views.
  const [mobileTab, setMobileTab] = useState<MobileTab>("hosts");
  const FILES_TAB_ENABLED = true;
  // Host to auto-open in the mobile Files tab (set by openSftp on mobile).
  const [mobileFilesHostId, setMobileFilesHostId] = useState<string | null>(null);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [snippetsOpen, setSnippetsOpen] = useState(false);
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
    if (!isMobile) {
      setMobileDrawerOpen(false);
      setMobileTab("hosts");
    }
  }, [isMobile]);
  const [selectedHost, setSelectedHost] = useState<HostRecord | null>(null);
  const [editHost, setEditHost] = useState<HostRecord | null>(null);
  // Separate flag for "create new host" — picker's + button needs a
  // fresh HostDialog with no `initial` prop (passing an empty object
  // crashes the form's auth.kind probe). null editHost + this true =
  // create mode.
  const [createHostOpen, setCreateHostOpen] = useState(false);
  // Host-key accept prompt (PuTTY-style). sshConnect calls the registered prompt
  // when a server key isn't pinned; we show a ConfirmDialog and resolve its gate.
  const [hostKeyReq, setHostKeyReq] = useState<{
    info: HostKeyPromptInfo;
    resolve: (ok: boolean) => void;
  } | null>(null);
  useEffect(() => {
    setHostKeyPrompt(
      (info) => new Promise<boolean>((resolve) => setHostKeyReq({ info, resolve })),
    );
  }, []);
  // Keyboard-interactive (MFA/2FA) prompt: backend emits `ssh-kbi` mid-handshake
  // with the server's prompts; show the dialog and send answers back.
  const [kbiReq, setKbiReq] = useState<KbiRequest | null>(null);
  useEffect(() => {
    const un = listen<KbiRequest>("ssh-kbi", (e) => setKbiReq(e.payload));
    return () => {
      un.then((f) => f()).catch(() => {});
    };
  }, []);
  // Stack of recently-closed hosts. Ctrl+Shift+T pops one and re-opens it.
  // Bounded to last 20 entries by the push site in closePane.
  const closedStackRef = useRef<HostRecord[]>([]);

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
    vaultPanelOpen: false as boolean,
    sftpOpen: false as boolean,
    mobileTab: "hosts" as MobileTab,
    closers: {} as Record<string, () => void>,
  });
  // Keep refs current.
  backRef.current.isMobile = isMobile;
  backRef.current.mobileTab = mobileTab;
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
      shortcutsOpen ||
      vaultPanelOpen ||
      !!updatePanel ||
      !!sftpEntry ||
      syncPanelOpen ||
      !!tunnelsPanel?.open ||
      historyPanelOpen ||
      !!selectedHost ||
      snippetsOpen ||
      mobileTab !== "hosts";
    if (anyOpen) {
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
    vaultPanelOpen,
    updatePanel,
    sftpEntry,
    syncPanelOpen,
    tunnelsPanel,
    historyPanelOpen,
    selectedHost,
    snippetsOpen,
    mobileTab,
  ]);
  // Keep refs current so the popstate handler always sees the latest snapshot.
  backRef.current.vaultPanelOpen = vaultPanelOpen;
  (backRef.current as { updatePanelOpen?: boolean }).updatePanelOpen =
    !!updatePanel;
  (backRef.current as { sftpOpen?: boolean }).sftpOpen = !!sftpEntry;
  (backRef.current as { syncPanelOpen?: boolean }).syncPanelOpen = syncPanelOpen;
  (backRef.current as { tunnelsPanelOpen?: boolean }).tunnelsPanelOpen =
    !!tunnelsPanel?.open;
  (backRef.current as { historyPanelOpen?: boolean }).historyPanelOpen =
    historyPanelOpen;
  (backRef.current as { selectedHostOpen?: boolean }).selectedHostOpen =
    !!selectedHost;
  (backRef.current as { snippetsOpen?: boolean }).snippetsOpen = snippetsOpen;
  useEffect(() => {
    if (!isMobile) return;
    const onPop = () => {
      const b = backRef.current as typeof backRef.current & {
        updatePanelOpen?: boolean;
        sftpOpen?: boolean;
        syncPanelOpen?: boolean;
        tunnelsPanelOpen?: boolean;
        historyPanelOpen?: boolean;
        selectedHostOpen?: boolean;
        snippetsOpen?: boolean;
      };
      // Drill-down order: deepest/newest first. The snippets manager is a
      // full-screen modal over the Sessions tab → close it before anything else.
      if (b.snippetsOpen) setSnippetsOpen(false);
      else if (b.sftpOpen) closeSftp();
      else if (b.updatePanelOpen) setUpdatePanel(null);
      else if (b.syncPanelOpen) setSyncPanelOpen(false);
      else if (b.tunnelsPanelOpen) setTunnelsPanel(null);
      else if (b.historyPanelOpen) setHistoryPanelOpen(false);
      else if (b.selectedHostOpen) setSelectedHost(null);
      else if (b.settingsOpen) setSettingsOpen(false);
      else if (b.shortcutsOpen) setShortcutsOpen(false);
      else if (b.editHost) setEditHost(null);
      else if (b.createHostOpen) setCreateHostOpen(false);
      else if (b.pickerOpen) setPickerOpen(false);
      else if (b.vaultPanelOpen) setVaultPanelOpen(false);
      else if (b.mobileDrawerOpen) setMobileDrawerOpen(false);
      // Bottom-nav: back from any non-home tab returns to Hosts before the
      // press is allowed to collapse the activity.
      else if (b.mobileTab !== "hosts") setMobileTab("hosts");
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
  // Snapshot the saved workspaces synchronously at first render — the persist
  // effect fires on mount with workspaces=[] and would wipe localStorage
  // before a vault-gated restore gets to read it.
  const restoreSnapshotRef = useRef<{ rawV1: string | null; rawV0: string | null } | null>(null);
  if (restoreSnapshotRef.current === null) {
    try {
      restoreSnapshotRef.current = {
        rawV1: localStorage.getItem("nexussh.workspaces"),
        rawV0: localStorage.getItem("nexussh.lastTabs"),
      };
    } catch {
      restoreSnapshotRef.current = { rawV1: null, rawV0: null };
    }
  }
  useEffect(() => {
    if (restoredRef.current) return;
    // Wait until the vault state is known and (if locked) unlocked, so we
    // never reconnect saved-password hosts before the master password.
    if (!vaultChecked || appLocked) return;
    restoredRef.current = true;
    if (!settings.restoreSession) return;
    // Secondary windows start empty — only the primary restores the layout.
    if (!IS_PRIMARY_WINDOW) return;
    const { rawV1, rawV0 } = restoreSnapshotRef.current!;
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
  }, [vaultChecked, appLocked]);

  // Force every terminal to re-fit after a layout change (split created/closed,
  // divider dragged, pane moved, workspace switched). In the flat-layer split
  // model a pane's per-terminal ResizeObserver did NOT reliably fire on the
  // initial split, so the pane kept its pre-split (full-height) row count — the
  // remote then drew rows below the now-shorter pane and the bottom (e.g. a
  // shell/TUI input line) was clipped, worse the smaller the pane. A window
  // 'resize' runs every visible term's fit path (debounced so a divider drag
  // doesn't spam it). Double rAF lets the new geometry settle before measuring.
  useEffect(() => {
    const id = window.setTimeout(() => {
      requestAnimationFrame(() =>
        requestAnimationFrame(() => window.dispatchEvent(new Event("resize"))),
      );
    }, 60);
    return () => window.clearTimeout(id);
  }, [workspaces, activeWorkspaceId]);

  // Persist the full workspace shape (layout tree + pane → host ids + focus +
  // active workspace). Survives across restarts.
  useEffect(() => {
    if (!settings.restoreSession) return;
    if (!IS_PRIMARY_WINDOW) return; // only the primary owns the saved layout
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
    const activeId = data.activeWorkspaceId &&
      restored.some((w) => w.id === data.activeWorkspaceId)
      ? data.activeWorkspaceId
      : restored[0].id;
    // Lazy password prompt: a restored host that would trigger an interactive
    // prompt is left DORMANT (no connection, click-to-connect placeholder)
    // unless it lives in the active workspace — so at most one prompt fires on
    // startup. Key-auth / vault-password / stored-password hosts always connect.
    for (const w of restored) {
      const isActiveWs = w.id === activeId;
      for (const p of w.panes) {
        if (!isActiveWs && needsInteractivePrompt(p.session.host)) {
          p.session = { ...p.session, status: "closed", dormant: true };
        }
      }
    }
    setWorkspaces(restored);
    setActiveWorkspaceId(activeId);
    // Kick off connections in parallel — but skip dormant panes; they connect
    // when their tab is activated (see wakeWorkspace).
    for (const w of restored) {
      for (const p of w.panes) {
        if (p.session.dormant) continue;
        kickoffConnect(p.session.id, p.session.host);
      }
    }
  }

  // Drive an SSH connection for an already-mounted pending pane (used by
  // restore). Mirrors openHost's success/error handling but doesn't add a
  // tab, since the pane is already there.
  async function kickoffConnect(pendingId: string, h: HostRecord) {
    let auth: AuthMethod = await resolveAuth(h.auth, h.id);
    if (h.auth.kind === "password" && h.alwaysAskPassword) {
      const creds = await askPassword(h);
      if (!creds) {
        updateSession(pendingId, (s) => ({
          ...s,
          status: "closed",
          error: t("app.password_required"),
        }));
        return;
      }
      h = { ...h, user: creds.user };
      auth = { kind: "password", password: creds.password };
    }
    try {
      const hist = historyArgsFor(h);
      const doRec = hist.record && !!vault?.configured;
      const { sessionId: sid, recording } = await sshConnect({
        host: h.host,
        port: h.port,
        user: h.user,
        auth,
        vpn: resolveHostVpn(h),
        allow_legacy: h.allowLegacy,
        encrypt_known_hosts: hostsEncrypted(),
        timeout: settings.timeout,
        keepalive: settings.keepalive,
        record_history: doRec,
        history_mode: hist.mode,
        history_host_id: h.id,
        history_label: h.name || h.host,
      });
      bumpLastUsed(h.id).catch(() => {});
      promoteSession(pendingId, sid, "connected");
      if (recording) setRecSids((r) => ({ ...r, [sid]: false }));
    } catch (e) {
      updateSession(pendingId, (s) => ({
        ...s,
        status: "closed",
        error: String(e),
      }));
    }
  }

  // Wake any dormant panes in a workspace: connect them now (running the normal
  // connect path, prompting for the password at this moment). Called when a tab
  // is activated. Guards against double-connect — only "closed && dormant" panes
  // are woken, and they're flipped to "connecting" (clearing dormant) before the
  // async connect runs, so a repeated activation is a no-op.
  function wakeWorkspace(wsId: string) {
    const ws = workspaces.find((w) => w.id === wsId);
    if (!ws) return;
    const toWake = ws.panes.filter((p) => p.session.dormant);
    if (toWake.length === 0) return;
    setWorkspaces((ws_) =>
      ws_.map((w) =>
        w.id !== wsId
          ? w
          : {
              ...w,
              panes: w.panes.map((p) =>
                p.session.dormant
                  ? {
                      ...p,
                      session: {
                        ...p.session,
                        status: "connecting",
                        dormant: false,
                        error: undefined,
                      },
                    }
                  : p,
              ),
            },
      ),
    );
    for (const p of toWake) {
      kickoffConnect(p.session.id, p.session.host);
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
  // Kill the WebView's built-in Ctrl+F find (the white box that searches the
  // whole DOM incl. the sidebar). We have our own terminal/history find, so we
  // suppress the browser one. CAPTURE + preventDefault only — NOT stopPropagation
  // — so the focused terminal / history panel still opens its own find bar.
  useEffect(() => {
    const killNativeFind = (e: KeyboardEvent) => {
      if (
        (e.ctrlKey || e.metaKey) &&
        !e.shiftKey &&
        !e.altKey &&
        e.code === "KeyF"
      ) {
        e.preventDefault();
      }
    };
    window.addEventListener("keydown", killNativeFind, true);
    return () => window.removeEventListener("keydown", killNativeFind, true);
  }, []);

  // Ctrl+Shift+Up (open transcript overlay for focused session).
  //
  // IMPORTANT: use CAPTURE phase. xterm.js attaches its own keydown listener
  // on the helper textarea and forwards keys to the PTY before bubble-phase
  // handlers run. Without capture, Ctrl+Shift+Up was being eaten by xterm.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const meta = e.ctrlKey || e.metaKey;
      const code = e.code;
      // AI-панель: Ctrl/Cmd+Shift+A — открыть/закрыть подсказку команд.
      // e.code (физическая клавиша), НЕ e.key — иначе не сработает на не-латинской
      // раскладке (на русской "A" = "Ф").
      // Command palette: Ctrl/Cmd+Shift+Z (e.code — раскладко-независимо).
      if (meta && e.shiftKey && e.code === "KeyZ") {
        e.preventDefault();
        setPaletteOpen((v) => {
          const next = !v;
          if (!next && !isMobile) setTimeout(() => focusActiveTerminal(), 0);
          return next;
        });
        return;
      }
      if (meta && e.shiftKey && e.code === "KeyA") {
        e.preventDefault();
        setAiPanelOpen((v) => {
          const next = !v;
          // При закрытии хоткеем — вернуть фокус в терминал (как и кнопка/Esc),
          // иначе курсор оставался вне сессии. На мобиле хоткея нет.
          if (!next && !isMobile) setTimeout(() => focusActiveTerminal(), 0);
          return next;
        });
        return;
      }
      // When the SFTP browser is open it OWNS the function keys (F1/F5–F8) —
      // the panel binds them on its own capture-phase listener. Bail out here so
      // they never reach the app (notably F5, the WebView's page-reload, which
      // would tear down and restart every terminal session behind the panel).
      if (sftpOpenRef.current && /^F[1-9]$|^F1[0-2]$/.test(e.key)) {
        return;
      }
      // Helpers — both are workspace-scoped no-ops when no active workspace.
      const inActiveWs = (fn: (wsId: string) => void) => {
        if (activeWorkspaceId) {
          e.preventDefault();
          e.stopPropagation();
          fn(activeWorkspaceId);
        }
      };
      if (meta && !e.shiftKey && !e.altKey && code === "KeyS") {
        // Ctrl/Cmd+S — open the SFTP browser for the active host. If it's
        // already open but collapsed, ensure it's VISIBLE (un-collapse).
        e.preventDefault();
        e.stopPropagation();
        if (sftpEntry) {
          restoreSftp();
        } else if (activeSession) {
          openSftp(activeSession);
        }
      } else if (meta && e.shiftKey && !e.altKey && code === "KeyS") {
        // Ctrl/Cmd+Shift+S — toggle collapse/restore of the SFTP panel. If it
        // isn't open yet, open it for the active host (then it's visible).
        e.preventDefault();
        e.stopPropagation();
        if (sftpEntry) {
          toggleSftpCollapse();
        } else if (activeSession) {
          openSftp(activeSession);
        }
      } else if (meta && e.shiftKey && !e.altKey && code === "KeyX") {
        // Ctrl/Cmd+Shift+X — toggle snippets modal (single Ctrl+X is reserved
        // for the terminal, so the binding is Shift-gated).
        e.preventDefault();
        e.stopPropagation();
        setSnippetsOpen((v) => !v);
      } else if (meta && !e.shiftKey && code === "KeyT") {
        // Ctrl/Cmd+T — open host picker (new tab).
        e.preventDefault();
        e.stopPropagation();
        openSshPicker();
      } else if (meta && code === "Comma") {
        // Ctrl/Cmd+, — toggle Settings.
        e.preventDefault();
        e.stopPropagation();
        setSettingsOpen((v) => !v);
      } else if (meta && e.shiftKey && code === "KeyL") {
        // Ctrl/Cmd+Shift+L — lock the app (vault). SSH sessions keep running.
        e.preventDefault();
        e.stopPropagation();
        if (vault?.configured) lockApp();
      } else if (meta && !e.shiftKey && code === "KeyW") {
        // Ctrl/Cmd+W — close focused tab (single pane = whole workspace).
        inActiveWs((wsId) => {
          const ws = workspaces.find((w) => w.id === wsId);
          if (ws && ws.focusedPaneId) closePane(wsId, ws.focusedPaneId);
        });
      } else if (meta && e.shiftKey && code === "KeyD") {
        // Ctrl/Cmd+Shift+D — split focused pane right.
        inActiveWs((wsId) => splitFocusedPane(wsId, "row"));
      } else if (meta && e.shiftKey && code === "KeyE") {
        // Ctrl/Cmd+Shift+E — split focused pane down.
        inActiveWs((wsId) => splitFocusedPane(wsId, "col"));
      } else if (meta && !e.shiftKey && !e.altKey && code === "KeyH") {
        // Ctrl/Cmd+H — open the session History panel (same as the header button).
        e.preventDefault();
        e.stopPropagation();
        setHistoryPanelOpen(true);
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
          wakeWorkspace(nextId);
          // Flash the newly-activated tab so the user can see WHICH tab the
          // shortcut took them to (regular active styling doesn't move).
          setSwitchPulseId(nextId);
        }
      } else if (
        !isMobile && !meta && !e.altKey && e.shiftKey && code === "Slash"
      ) {
        // `?` (Shift+/) — open keyboard-shortcuts cheat-sheet. Skip when typing in an
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
      } else if (!isMobile && meta && !e.shiftKey && !e.altKey && code === "Slash") {
        // Ctrl+/ — same cheat-sheet (works even while typing).
        e.preventDefault();
        e.stopPropagation();
        setShortcutsOpen((v) => !v);
      } else if (
        meta &&
        !e.shiftKey &&
        !e.altKey &&
        /^(Digit|Numpad)[1-9]$/.test(code)
      ) {
        // Ctrl/Cmd+1..9 — jump to workspace at that index. Use the physical
        // key (e.code Digit1..9 / Numpad1..9) so it's layout-independent.
        const n = parseInt(code.slice(-1), 10) - 1;
        if (workspaces[n]) {
          e.preventDefault();
          e.stopPropagation();
          setActiveWorkspaceId(workspaces[n].id);
          wakeWorkspace(workspaces[n].id);
        }
      } else if (meta && e.shiftKey && code === "KeyT") {
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
        (code === "KeyC" || code === "KeyI" || code === "KeyJ")
      ) {
        // Block WebView's DevTools / Inspect shortcuts so Ctrl+Shift+C stays
        // ours for copy.
        e.preventDefault();
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [activeId, activeWorkspaceId, workspaces, activeSession, sftpBySession]);

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

  function lockApp() {
    vaultLock()
      .catch(() => {})
      .finally(() => {
        setAppLocked(true);
        vaultStatus().then(setVault).catch(() => {});
      });
  }

  // Start/stop the Android keep-alive foreground service as sessions come and
  // go, so the connection isn't killed when the app is backgrounded or the
  // screen locks. Harmless no-op on desktop (the command returns Ok there).
  useEffect(() => {
    if (!HAS_TAURI) return;
    invoke("android_keepalive", { on: hasLiveSession }).catch(() => {});
  }, [hasLiveSession]);

  // Vault lock/unlock is global in Rust, but each window keeps its own
  // appLocked flag + cached host list. Mirror BOTH directions across windows:
  // locking one re-gates the others (so host contents aren't left browsable);
  // unlocking one drops the others' lock screens (so you don't re-type the same
  // master password per window).
  useEffect(() => {
    if (!HAS_TAURI) return;
    const uns: Array<() => void> = [];
    let disposed = false;
    const track = (u: () => void) => (disposed ? u() : uns.push(u));
    import("@tauri-apps/api/event")
      .then(({ listen }) => {
        listen(VAULT_LOCKED_EVENT, () => {
          setAppLocked(true);
          vaultStatus().then(setVault).catch(() => {});
          refreshHosts(); // drop the now-locked (empty) host list
        }).then(track);
        listen(VAULT_UNLOCKED_EVENT, () => {
          setAppLocked(false);
          vaultStatus().then(setVault).catch(() => {});
          refreshHosts(); // re-read hosts now that the vault is open
        }).then(track);
      })
      .catch(() => {});
    return () => {
      disposed = true;
      uns.forEach((u) => u());
    };
  }, []);

  // Poll vault + sync status on mount; run one-time legacy cleanup +
  // detect plaintext passwords that need migrating into the vault.
  const [migrationPending, setMigrationPending] = useState(false);
  useEffect(() => {
    // Delete leftover session recordings (plaintext SSH output) from old
    // versions — silent, one-shot, no-op once gone.
    invoke<number>("purge_legacy_sessions").catch(() => {});
    (async () => {
      let st;
      try {
        st = await vaultStatus();
        setVault(st);
      } catch {
        setVaultChecked(true);
        return;
      }
      // Configured + locked → show the lock screen FIRST; session restore
      // is gated on vaultChecked && !appLocked so it waits for the unlock.
      if (st.configured && !st.unlocked) setAppLocked(true);
      setVaultChecked(true);
      // First run: no vault yet and we've never offered → gently suggest it.
      // Non-blocking banner; never shown again once seen/dismissed.
      if (!st.configured && !vaultPromptSeen()) setVaultPromptOpen(true);
      // Leftover plaintext passwords → force vault open to migrate them.
      try {
        const plain = await findPlaintextPasswordHosts();
        if (plain.length > 0) {
          setMigrationPending(true);
          if (!st.configured) setVaultPanelOpen(true);
        }
      } catch {
        /* ignore */
      }
    })();
  }, []);

  // Once the vault is unlocked and a migration is pending, move every
  // plaintext password into the vault and wipe it from hosts.json.
  useEffect(() => {
    if (!migrationPending || !vault?.unlocked) return;
    // saveHost() inside the migration emits hosts-changed, so the sidebar
    // refreshes on its own; we just clear the pending flag.
    migratePlaintextToVault()
      .then(() => setMigrationPending(false))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [migrationPending, vault?.unlocked]);

  // Scrub any leftover plaintext host list if encryption was enabled but a
  // crash left a copy in hosts.json (see hosts.ts::reconcileHostEncryption).
  useEffect(() => {
    reconcileHostEncryption().catch(() => {});
  }, []);

  // Idle auto-lock: after `vaultAutoLockMin` minutes of no input, lock the
  // app (master-password screen) while keeping live SSH sessions running.
  // Default is 0 = never; the user opts in via Settings.
  useEffect(() => {
    const mins = settings.vaultAutoLockMin;
    if (!mins || mins <= 0 || appLocked) return;
    const IDLE_MS = mins * 60 * 1000;
    let timer: number | null = null;
    const reset = () => {
      if (timer != null) window.clearTimeout(timer);
      timer = window.setTimeout(async () => {
        try {
          const st = await vaultStatus();
          if (st.unlocked) lockApp();
        } catch {}
      }, IDLE_MS);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.vaultAutoLockMin, appLocked]);

  // ---------------------------------------------------------------------------
  // Session operations
  // ---------------------------------------------------------------------------

  // Resolve a host's effective recording decision: the per-host recordHistory
  // override wins over the global on/off + mode. undefined = inherit global.
  function historyArgsFor(h: HostRecord): { record: boolean; mode: string } {
    // Recording is always "light" now (alt-screen / TUI redraws skipped). The
    // "full" mode was removed — it filled history with htop/vim redraw garbage,
    // truncated the real session via the size ring, and bloated files.
    const rh = h.recordHistory;
    if (rh === undefined) return { record: settings.historyEnabled, mode: "light" };
    if (rh === "off" || rh === false) return { record: false, mode: "light" };
    return { record: true, mode: "light" };
  }

  async function openHost(h: HostRecord) {
    // Reachability check BEFORE asking for a password (PuTTY-style): an offline
    // host should say "unreachable", not be mistaken for a wrong password after
    // a long hang. Skip for VPN hosts (they go through SOCKS — a direct TCP
    // probe would falsely fail). Fail-open if the probe itself errors.
    if (!resolveHostVpn(h)) {
      const reachable = await hostReachable(h.host, h.port, 5).catch(() => true);
      if (!reachable) {
        showToast(t("host.unreachable", { host: `${h.host}:${h.port}` }), "error");
        return;
      }
    }
    // If user opted to always ask for password, prompt before opening tab.
    let auth: AuthMethod = await resolveAuth(h.auth, h.id);
    if (h.auth.kind === "password" && h.alwaysAskPassword) {
      const creds = await askPassword(h);
      if (!creds) return; // cancelled
      h = { ...h, user: creds.user };
      auth = { kind: "password", password: creds.password };
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
      // History recording is started in the BACKEND before the output loop, so
      // the banner/prompt isn't missed (the old frontend start raced it → empty
      // recordings). Gated on vault unlock (recordings live behind the master
      // password). recordHistory per-host overrides the global on/off + mode.
      const hist = historyArgsFor(h);
      const doRec = hist.record && !!vault?.configured;
      const { sessionId: sid, recording } = await sshConnect({
        host: h.host,
        port: h.port,
        user: h.user,
        auth,
        vpn: resolveHostVpn(h),
        allow_legacy: h.allowLegacy,
        encrypt_known_hosts: hostsEncrypted(),
        timeout: settings.timeout,
        keepalive: settings.keepalive,
        record_history: doRec,
        history_mode: hist.mode,
        history_host_id: h.id,
        history_label: h.name || h.host,
      });
      bumpLastUsed(h.id).catch(() => {});
      promoteSession(pendingId, sid, "connected");
      triggerBurst();
      if (recording) setRecSids((r) => ({ ...r, [sid]: false }));
      // Auto-start saved port forwards (ssh -L). Fire-and-forget: opening the
      // shell must not wait on (or fail because of) a tunnel. Each forward opens
      // its OWN SSH connection in the backend, so it needs the resolved auth.
      const autoForwards = (h.forwards ?? []).filter((f) => f.autoStart);
      if (autoForwards.length > 0) {
        const fwdArgs = buildConnectArgs(h, auth);
        const fwdLabel = h.name || `${h.user}@${h.host}`;
        for (const f of autoForwards) {
          tunnelOpen(fwdArgs, {
            localPort: f.localPort || 0,
            remoteHost: f.remoteHost || "127.0.0.1",
            remotePort: f.remotePort,
            label: fwdLabel,
          })
            .then((info) =>
              showToast(t("tunnel.started", { port: info.local_port })),
            )
            .catch((e) => {
              // A "busy" port usually means this forward is already live — keep
              // quiet. Surface other failures to the console only.
              const msg = String(e);
              if (!/busy/i.test(msg)) console.warn("tunnel auto-start:", msg);
            });
        }
      }
    } catch (e) {
      // Keep the pane and show WHY it failed (with Retry), instead of vanishing.
      updateSession(pendingId, (s) => ({
        ...s,
        status: "closed",
        error: String(e),
      }));
    }
  }

  // Build the base ConnectArgs for a host with a resolved auth (handles the
  // shared shape used by SFTP and tunnels). The caller resolves "always ask"
  // first and passes the effective auth/user via the host it hands in.
  function buildConnectArgs(h: HostRecord, auth: AuthMethod): ConnectArgs {
    return {
      host: h.host,
      port: h.port,
      user: h.user,
      auth,
      vpn: resolveHostVpn(h),
      allow_legacy: h.allowLegacy,
      encrypt_known_hosts: hostsEncrypted(),
      timeout: settings.timeout,
      keepalive: settings.keepalive,
    };
  }

  // Resolve a host to ConnectArgs for an SFTP session, handling "always ask"
  // password prompts. Returns null if the user cancelled the prompt. Used by the
  // mobile Files (SFTP) tab, which opens its own connection per host.
  async function resolveSftpArgs(h: HostRecord): Promise<ConnectArgs | null> {
    let auth: AuthMethod = await resolveAuth(h.auth, h.id);
    if (h.auth.kind === "password" && h.alwaysAskPassword) {
      const creds = await askPassword(h);
      if (!creds) return null;
      h = { ...h, user: creds.user };
      auth = { kind: "password", password: creds.password };
    }
    return buildConnectArgs(h, auth);
  }

  async function openSftp(h: HostRecord) {
    // Mobile: SFTP lives in the bottom Files tab (MobileFiles owns its own
    // connection + auth flow). Route there instead of the desktop dual-pane.
    if (isMobile) {
      setMobileFilesHostId(h.id);
      setMobileTab("files");
      return;
    }
    let auth: AuthMethod = await resolveAuth(h.auth, h.id);
    if (h.auth.kind === "password" && h.alwaysAskPassword) {
      const creds = await askPassword(h);
      if (!creds) return;
      h = { ...h, user: creds.user };
      auth = { kind: "password", password: creds.password };
    }
    // SFTP belongs to the active tab's session. Without one there's no terminal
    // to sit behind, so no-op (prior fallback behaviour).
    if (!activeId) return;
    const entry = {
      args: buildConnectArgs(h, auth),
      title: `${h.user}@${h.host}`,
      collapsed: false, // a fresh open is always visible
    };
    setSftpBySession((m) => ({ ...m, [activeId]: entry }));
  }

  // Open the Tunnels panel listing all active tunnels (header entry point).
  function openTunnelsPanel() {
    setTunnelsPanel({ open: true, newTunnel: null });
  }

  // Mobile bottom-nav dispatch. Settings opens the full SettingsScreen overlay
  // (not a persistent content view); Files is gated until its SFTP browser
  // ships. Switching away from Settings closes it first.
  function selectMobileTab(tab: MobileTab) {
    if (tab === "settings") {
      setSettingsSection(undefined);
      setSettingsOpen(true);
      return;
    }
    if (settingsOpen) setSettingsOpen(false);
    setMobileTab(tab);
  }

  // Open the Tunnels panel with a host as context (context-menu entry). Resolves
  // "always ask" auth, then shows the unified list (this host's saved forwards
  // plus all others) with the "+ New tunnel" button wired to this host.
  async function openTunnelFor(h: HostRecord) {
    let auth: AuthMethod = await resolveAuth(h.auth, h.id);
    let host = h;
    if (h.auth.kind === "password" && h.alwaysAskPassword) {
      const creds = await askPassword(h);
      if (!creds) return;
      host = { ...h, user: creds.user };
      auth = { kind: "password", password: creds.password };
    }
    setTunnelsPanel({
      open: true,
      newTunnel: {
        connectArgs: buildConnectArgs(host, auth),
        label: host.name || `${host.user}@${host.host}`,
        host: h,
      },
    });
  }

  // Start a saved per-host forward (from the Tunnels panel's "Saved" section).
  // Resolves "always ask" auth like openTunnelFor, builds the host's ConnectArgs,
  // and opens the tunnel. Returns the live TunnelInfo, or null if cancelled.
  async function startSavedForward(
    hostId: string,
    fwd: PortForward,
  ): Promise<TunnelInfo | null> {
    const all = await listHosts();
    const h = all.find((x) => x.id === hostId);
    if (!h) return null;
    let auth: AuthMethod = await resolveAuth(h.auth, h.id);
    let host = h;
    if (h.auth.kind === "password" && h.alwaysAskPassword) {
      const creds = await askPassword(h);
      if (!creds) return null;
      host = { ...h, user: creds.user };
      auth = { kind: "password", password: creds.password };
    }
    return await tunnelOpen(buildConnectArgs(host, auth), {
      localPort: fwd.localPort,
      remoteHost: fwd.remoteHost,
      remotePort: fwd.remotePort,
      label: host.name || `${host.user}@${host.host}`,
    });
  }

  function openSshPicker() {
    setPickerMode("ssh");
    setPickerOpen(true);
  }

  // Собрать записи Command palette из хостов / сниппетов / вкладок / действий /
  // настроек. Вызывается при рендере палитры (см. paletteOpen).
  function buildPaletteItems(): PaletteItem[] {
    const out: PaletteItem[] = [];
    const close = () => setPaletteOpen(false);
    // Хосты → подключиться.
    for (const h of paletteHosts) {
      out.push({
        id: `host:${h.id}`,
        section: "Хосты",
        icon: <Server size={14} />,
        label: h.name || `${h.user}@${h.host}`,
        hint: "подключиться",
        keywords: `${h.user}@${h.host} ${h.group ?? ""}`,
        run: () => {
          close();
          openHost(h);
        },
      });
    }
    // Сниппеты → отправить в активную сессию.
    const ctx = focusedSession
      ? { host: focusedSession.host.host, user: focusedSession.host.user, port: focusedSession.host.port }
      : null;
    for (const s of listSnippets()) {
      out.push({
        id: `snip:${s.id}`,
        section: "Сниппеты",
        icon: <Zap size={14} />,
        label: s.name,
        hint: activeId ? "→ в терминал" : "нет активной сессии",
        keywords: s.command + " " + (s.category ?? ""),
        run: () => {
          close();
          if (!activeId) {
            showToast("Нет активной сессии — команду некуда отправить");
            return;
          }
          const cmd = expandPlaceholders(s.command, ctx);
          sshSend(activeId, new TextEncoder().encode(cmd + (s.autoRun ? "\r" : "")));
          if (!isMobile) focusActiveTerminal();
        },
      });
    }
    // Открытые вкладки → переключиться.
    for (const w of workspaces) {
      for (const p of w.panes) {
        const s = p.session;
        out.push({
          id: `tab:${s.id}`,
          section: "Вкладки",
          icon: <TerminalIcon size={14} />,
          label: s.host.name || `${s.host.user}@${s.host.host}`,
          hint: s.id === activeId ? "текущая" : "переключиться",
          keywords: `${s.host.user}@${s.host.host}`,
          run: () => {
            close();
            setFocusedPane(w.id, p.id);
          },
        });
      }
    }
    // Действия.
    const actions: PaletteItem[] = [
      { id: "act:newtab", icon: <Plus size={14} />, label: "Новая вкладка (SSH)", run: openSshPicker },
      { id: "act:sftp", icon: <FolderOpen size={14} />, label: "Открыть SFTP активного хоста", hint: activeSession ? undefined : "нет сессии", run: () => activeSession && openSftp(activeSession) },
      { id: "act:ai", icon: <Sparkles size={14} className="text-nx-accent2" />, label: "AI-подсказка команд", run: () => setAiPanelOpen(true) },
      { id: "act:snippets", icon: <Zap size={14} />, label: "Управление сниппетами", run: () => setSnippetsOpen(true) },
      { id: "act:tunnels", icon: <Cable size={14} />, label: "Туннели (проброс портов)", run: () => openTunnelsPanel() },
      { id: "act:vault", icon: <Lock size={14} />, label: "Vault", run: () => setVaultPanelOpen(true) },
      { id: "act:sync", icon: <Cloud size={14} />, label: "Облачный синк", run: () => setSyncPanelOpen(true) },
      { id: "act:history", icon: <HistoryIcon size={14} />, label: "История сессий", run: () => setHistoryPanelOpen(true) },
      {
        id: "act:update",
        icon: <ArrowUpCircle size={14} />,
        label: "Проверить обновление",
        run: () => {
          setUpdatePanel({ initial: undefined });
          startupCheck()
            .then((info) => setUpdatePanel({ initial: info }))
            .catch(() => {});
        },
      },
    ].map((a) => ({ ...a, section: "Действия", run: () => { close(); a.run(); } }));
    out.push(...actions);
    // Настройки (deep-link).
    const settings: Array<[string, string]> = [
      ["appearance", "Внешний вид"],
      ["behavior", "Поведение"],
      ["vpn", "VPN-профили"],
      ["account", "Аккаунт / синк"],
      ["updates", "Обновления"],
      ["about", "О программе"],
    ];
    for (const [sec, label] of settings) {
      out.push({
        id: `set:${sec}`,
        section: "Настройки",
        icon: <SettingsIcon size={14} />,
        label,
        hint: "настройки",
        run: () => {
          close();
          setSettingsSection(sec);
          setSettingsOpen(true);
        },
      });
    }
    return out;
  }

  // Caret next to "+" — choose what kind of session the new tab opens.
  function openNewTabMenu(x: number, y: number) {
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
      ],
    });
  }

  async function restartSession(sessionId: string, silent = false) {
    const found = findPane(sessionId);
    if (!found) return;
    const { pane } = found;
    const host = pane.session.host;
    // Re-prompt for the password on every restart of a password-auth host whose
    // password isn't securely saved. Saved passwords live in the vault (auth
    // kind "vault"); a plain "password" kind means it's either ask-each-time or
    // a quick-connect session holding the typed password in memory — in both
    // cases reusing it would just retry the same (possibly wrong) password
    // forever, so ask again.
    let auth: AuthMethod = await resolveAuth(host.auth, host.id);
    let user = host.user;
    if (host.auth.kind === "password") {
      if (silent) {
        // Auto-reconnect can't prompt; an ask-each-time password host has nothing
        // to reuse → stop retrying and leave the error card up (manual Retry asks).
        clearReconnect(sessionId);
        updateSession(sessionId, (s) => ({ ...s, reconnecting: false }));
        return;
      }
      const creds = await askPassword(host);
      if (!creds) return;
      user = creds.user;
      auth = { kind: "password", password: creds.password };
    }
    if (pane.session.status === "connected") {
      sshDisconnect(sessionId).catch(() => {});
    }
    updateSession(sessionId, (s) => ({
      ...s,
      status: "connecting",
      // Manual retry clears the error (fresh start); auto-reconnect KEEPS the
      // error so the ConnectError card stays visible with a "reconnecting" badge.
      error: silent ? s.error : undefined,
      reconnecting: silent,
    }));
    try {
      const hist = historyArgsFor(host);
      const doRec = hist.record && !!vault?.configured;
      const { sessionId: sid, recording } = await sshConnect({
        host: host.host,
        port: host.port,
        user,
        auth,
        vpn: resolveHostVpn(host),
        allow_legacy: host.allowLegacy,
        encrypt_known_hosts: hostsEncrypted(),
        record_history: doRec,
        history_mode: hist.mode,
        history_host_id: host.id,
        history_label: host.name || host.host,
      });
      bumpLastUsed(host.id).catch(() => {});
      // promoteSession keeps focus where it is (no focus-steal on auto-reconnect
      // of a background pane).
      promoteSession(sessionId, sid, "connected");
      if (recording) setRecSids((r) => ({ ...r, [sid]: false }));
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
        reconnecting: false,
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
    let auth: AuthMethod = await resolveAuth(h.auth, h.id);
    if (h.auth.kind === "password" && h.alwaysAskPassword) {
      const creds = await askPassword(h);
      if (!creds) return;
      h = { ...h, user: creds.user };
      auth = { kind: "password", password: creds.password };
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
      const hist = historyArgsFor(h);
      const doRec = hist.record && !!vault?.configured;
      const { sessionId: sid, recording } = await sshConnect({
        host: h.host,
        port: h.port,
        user: h.user,
        auth,
        vpn: resolveHostVpn(h),
        allow_legacy: h.allowLegacy,
        encrypt_known_hosts: hostsEncrypted(),
        timeout: settings.timeout,
        keepalive: settings.keepalive,
        record_history: doRec,
        history_mode: hist.mode,
        history_host_id: h.id,
        history_label: h.name || h.host,
      });
      bumpLastUsed(h.id).catch(() => {});
      promoteSession(pendingId, sid, "connected");
      triggerBurst();
      if (recording) setRecSids((r) => ({ ...r, [sid]: false }));
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
        label: t("tabmenu.restart"),
        icon: <RotateCcw size={13} />,
        onClick: () => {
          if (focusedSid) restartSession(focusedSid);
        },
        disabled: !focused || focused.session.status === "connecting",
      },
      // Duplicate tab — open a fresh tab connected to the same host as the
      // focused pane (reuses its auth snapshot, so saved/quick-connect hosts
      // don't re-prompt; alwaysAsk hosts prompt as usual).
      {
        label: t("tabmenu.duplicate"),
        icon: <Copy size={13} />,
        onClick: () => {
          if (focusedHost) openHost(focusedHost);
        },
        disabled: !focusedHost,
      },
      // Splits aren't usable on phone-sized viewports (terminal becomes
      // unreadable), so the items are hidden there.
      ...(!isMobile
        ? [
            {
              label: t("tabmenu.split_right"),
              icon: <SplitSquareHorizontal size={13} />,
              onClick: () => splitFocusedPane(wsId, "row"),
              disabled: !hasPanes,
            },
            {
              label: t("tabmenu.split_down"),
              icon: <SplitSquareVertical size={13} />,
              onClick: () => splitFocusedPane(wsId, "col"),
              disabled: !hasPanes,
            },
          ]
        : []),
      {
        label: t("sidebar.menu_sftp"),
        icon: <Folder size={13} />,
        onClick: () => {
          if (focusedHost) openSftp(focusedHost);
        },
        disabled: !focusedHost,
      },
      {
        label: t("sidebar.menu_tunnel"),
        icon: <ArrowLeftRight size={13} />,
        onClick: () => {
          if (focusedHost) openTunnelFor(focusedHost);
        },
        disabled: !focusedHost,
      },
      // Edit the underlying host (handy when the sidebar is collapsed). A
      // one-off quick-connect session has no saved host yet → offer "Save host"
      // instead. (No "rename tab" — the title is transient and reverts to the
      // real host name on reconnect anyway.)
      ...(focusedHost
        ? focusedHost.id.startsWith("quick-")
          ? [
              {
                label: t("tabmenu.save_host"),
                icon: <Plus size={13} />,
                onClick: () =>
                  setPrefillHost({
                    id: newHostId(),
                    name: focusedHost.host,
                    host: focusedHost.host,
                    port: focusedHost.port,
                    user: focusedHost.user,
                    auth: { kind: "password", password: "" },
                    alwaysAskPassword: true,
                  }),
              },
            ]
          : [
              {
                label: t("tabmenu.edit_host"),
                icon: <SquarePen size={13} />,
                onClick: () => {
                  // Edit the live saved record (the session holds a snapshot
                  // that may be stale after edits elsewhere).
                  const id = focusedHost.id;
                  listHosts()
                    .then((all) =>
                      setEditHost(all.find((h) => h.id === id) ?? focusedHost),
                    )
                    .catch(() => setEditHost(focusedHost));
                },
              },
            ]
        : []),
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
          icon: <Server size={13} />,
          onClick: () => mergeWorkspace(wsId, w.id),
        });
      }
    }
    items.push({ separator: true, label: "" });
    items.push({
      label: t("tabmenu.close_current_tab"),
      icon: <X size={13} />,
      onClick: () => {
        if (focused) closePane(wsId, focused.id);
      },
      disabled: !hasPanes,
      destructive: true,
    });
    items.push({
      label: t("tabmenu.close_others"),
      icon: <XSquare size={13} />,
      onClick: () => closeOtherWorkspaces(wsId),
      disabled: workspaces.length <= 1,
      destructive: true,
    });
    setMenu({
      x,
      y,
      items,
      title: focusedHost
        ? { main: focusedHost.name, sub: `${focusedHost.user}@${focusedHost.host}` }
        : undefined,
    });
  }

  // Prompt to rename the workspace tab title. Empty string clears it (back to
  // auto-derived from focused pane's host).
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
    // Drop any per-session SFTP browser bound to this closing session so it can
    // never linger as a stale entry.
    setSftpBySession((m) => {
      if (!m[pane.session.id]) return m;
      const n = { ...m };
      delete n[pane.session.id];
      return n;
    });
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

  // Middle-click close of a split pane. Unlike the × button (silent), closing a
  // pane via middle-click warns first when the session is live — a split pane is
  // easy to hit by accident and you'd lose a running session.
  async function closePaneConfirmed(wsId: string, paneId: string) {
    const ws = workspaces.find((w) => w.id === wsId);
    if (!ws) return;
    const pane = ws.panes.find((p) => p.id === paneId);
    if (!pane) return;
    const live =
      pane.session.status === "connected" ||
      pane.session.status === "connecting";
    if (settings.confirmClose && ws.panes.length > 1 && live) {
      const ok = await askConfirm(t("app.confirm_close_pane"), {
        destructive: true,
      });
      if (!ok) return;
    }
    closePane(wsId, paneId);
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
          label: t("tabmenu.restart"),
          icon: <RotateCcw size={13} />,
          onClick: () => restartSession(sid),
          disabled: pane.session.status === "connecting",
        },
        // Splits are desktop-only (no split panes on phones).
        ...(!isMobile
          ? [
              {
                label: t("tabmenu.split_right"),
                icon: <SplitSquareHorizontal size={13} />,
                onClick: () => {
                  // Re-focus this pane first so the split lands next to it.
                  setFocusedPane(wsId, paneId);
                  splitFocusedPane(wsId, "row");
                },
              },
              {
                label: t("tabmenu.split_down"),
                icon: <SplitSquareVertical size={13} />,
                onClick: () => {
                  setFocusedPane(wsId, paneId);
                  splitFocusedPane(wsId, "col");
                },
              },
            ]
          : []),
        {
          label: t("sidebar.menu_sftp"),
          icon: <Folder size={13} />,
          onClick: () => openSftp(host),
        },
        {
          label: t("sidebar.menu_tunnel"),
          icon: <ArrowLeftRight size={13} />,
          onClick: () => openTunnelFor(host),
        },
        { separator: true, label: "" },
        {
          label: t("tabmenu.move_to_new_tab"),
          icon: <FolderInput size={13} />,
          onClick: () => extractPaneToNewWorkspace(wsId, paneId),
          disabled: !canExtract,
        },
        {
          label: t("tabmenu.close_current_tab"),
          icon: <X size={13} />,
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
      updateSession(session.id, (s) => ({ ...s, reconnectAttempt: prev.attempts }));
      restartSession(session.id, true); // silent — keep the ConnectError card up
    }, delay);
    reconnectRef.current.set(session.id, {
      attempts: prev.attempts,
      timer,
    });
  }

  // Toggle pause/resume of a live recording (the ● REC chip click).
  function toggleRecPause(sessionId: string) {
    setRecSids((r) => {
      if (!(sessionId in r)) return r;
      const paused = !r[sessionId];
      historyPause(sessionId, paused).catch(() => {});
      return { ...r, [sessionId]: paused };
    });
  }

  function markClosed(sessionId: string, reason: string) {
    updateSession(sessionId, (s) => ({ ...s, status: "closed" }));
    // Drop the recording chip — the backend finalises the recording itself.
    setRecSids((r) => {
      if (!(sessionId in r)) return r;
      const n = { ...r };
      delete n[sessionId];
      return n;
    });
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
      // Mobile Sessions tab with nothing open: an empty state pointing back to
      // the Hosts tab (the host list now lives in its own bottom-nav tab, not
      // here behind the old ☰ drawer).
      if (isMobile) {
        return (
          <div className="flex-1 min-w-0 relative overflow-hidden flex flex-col items-center justify-center gap-4 px-8 text-center">
            <div className="font-mono text-nx-muted text-sm">
              {t("mobile.no_sessions")}
            </div>
            <div className="font-mono text-nx-soft text-meta">
              {t("mobile.no_sessions_hint")}
            </div>
            <button
              type="button"
              onClick={() => setMobileTab("hosts")}
              className="mt-1 font-mono text-sm px-5 py-2.5 rounded border border-nx-accent text-nx-accent active:bg-nx-elevated"
            >
              {t("mobile.go_hosts")}
            </button>
          </div>
        );
      }
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
          <div
            className="absolute inset-0 flex items-center justify-center font-mono text-sm pointer-events-none"
            style={{ color: theme.textMuted }}
          >
            <span>
              &gt;{" "}
              {isMobile ? t("terminal.select_host_mobile") : t("terminal.select_host")}
            </span>
          </div>
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
                data-session-id={p.session.id}
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
              {p.session.dormant && (
                <div
                  style={{ ...cs, zIndex: 15 }}
                  className="flex flex-col items-center justify-center gap-3 p-6 cursor-pointer"
                  onClick={() => wakeWorkspace(ws.id)}
                >
                  <span
                    className="font-mono text-sm text-center"
                    style={{ color: theme.textSoft }}
                  >
                    {t("terminal.dormant_hint")}
                  </span>
                  <Button
                    variant="primary"
                    size="sm"
                    leadingIcon={<TerminalIcon size={13} />}
                    onClick={(e) => {
                      e.stopPropagation();
                      wakeWorkspace(ws.id);
                    }}
                  >
                    {t("terminal.dormant_connect")}
                  </Button>
                </div>
              )}
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
                <div style={{ ...cs, zIndex: 16 }}>
                  <ConnectError
                    host={p.session.host.host}
                    parsed={parseConnectError(p.session.error)}
                    reconnecting={!!p.session.reconnecting}
                    attempt={p.session.reconnectAttempt}
                    onRetry={() => restartSession(p.session.id)}
                    onEditHost={() => {
                      const id = p.session.host.id;
                      listHosts()
                        .then((all) =>
                          setEditHost(all.find((h) => h.id === id) ?? p.session.host),
                        )
                        .catch(() => setEditHost(p.session.host));
                    }}
                    onClose={() => {
                      clearReconnect(p.session.id); // stop background retries
                      closePane(ws.id, p.id);
                    }}
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
                  onMiddleClose={() => closePaneConfirmed(ws.id, p.id)}
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
          title={
            mobileTab === "sessions" && activeSession
              ? activeSession.name
              : mobileTab === "files"
                ? t("mobile.tab.files")
                : `NexuSSH v${version}`
          }
          subtitle={
            mobileTab === "sessions" && activeSession
              ? `${activeSession.user}@${activeSession.host}`
              : undefined
          }
          onDrawer={() => setMobileTab("hosts")}
          actions={
            mobileTab === "hosts" ? (
              <button
                type="button"
                onClick={() => setSyncPanelOpen(true)}
                aria-label={t(
                  syncState === "on" ? "header.sync_on" : "header.sync_off",
                )}
                className="shrink-0 inline-flex items-center justify-center w-10 h-10 rounded-full active:bg-nx-elevated"
              >
                {syncState === "on" ? (
                  <Cloud size={20} className="text-nx-accent" />
                ) : (
                  <CloudOff size={20} className="text-nx-muted" />
                )}
              </button>
            ) : mobileTab === "sessions" ? (
              <div className="flex items-center gap-0.5 shrink-0">
                {/* AI-ассистент — как на десктопе (слева от прочих), с индикатором.
                    Виден при настроенном аккаунте (syncState). */}
                {syncState !== "none" && (
                  <span className="relative inline-flex">
                    <button
                      type="button"
                      onClick={() => setAiPanelOpen(true)}
                      aria-label="AI-подсказка команд"
                      className={`shrink-0 inline-flex items-center justify-center w-10 h-10 rounded-full active:bg-nx-elevated ${
                        ai.granted ? "text-nx-accent" : "text-nx-soft"
                      }`}
                    >
                      <Sparkles size={19} />
                    </button>
                    <AiIndicatorDot ai={ai} panelOpen={aiPanelOpen} />
                  </span>
                )}
                {/* Snippets MANAGER (CRUD + sync) — always available, even with no
                    active connection. Quick-run lives in the SmartKeyBar ⚡. */}
                <button
                  type="button"
                  onClick={() => setSnippetsOpen(true)}
                  aria-label={t("snippets.btn")}
                  className="shrink-0 inline-flex items-center justify-center w-10 h-10 rounded-full active:bg-nx-elevated"
                >
                  <FileCode2 size={19} className="text-nx-soft" />
                </button>
                {activeSession && activeId && (
                  <button
                    type="button"
                    onClick={() =>
                      window.dispatchEvent(
                        new CustomEvent("nx:find", { detail: { sessionId: activeId } }),
                      )
                    }
                    aria-label={t("terminal.find_title")}
                    className="shrink-0 inline-flex items-center justify-center w-10 h-10 rounded-full active:bg-nx-elevated"
                  >
                    <Search size={19} className="text-nx-soft" />
                  </button>
                )}
              </div>
            ) : undefined
          }
          items={[
            {
              label: vault?.configured ? "vault" : t("vault.header_enable"),
              onClick: () => {
                if (!vault?.configured) markVaultPromptSeen();
                setVaultPanelOpen(true);
              },
              warn: vault?.configured && !vault?.unlocked,
              active: vault?.unlocked,
            },
            {
              label: t("tunnel.header"),
              onClick: () => openTunnelsPanel(),
            },
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

        {/* Live recording indicator for the focused session — a SOLID dot
         *  (always visible on any theme, incl. the light one) plus a pinging
         *  ring while recording; grey static dot when paused. Click to
         *  pause/resume. (Opacity-pulse faded to invisible on light bg.) */}
        {focusedSession && recSids[focusedSession.id] !== undefined && !isMobile && (
          <button
            type="button"
            onClick={() => toggleRecPause(focusedSession.id)}
            title={t(
              recSids[focusedSession.id]
                ? "history.rec_resume"
                : "history.rec_pause",
            )}
            className="no-drag relative flex items-center justify-center w-5 h-5 rounded"
          >
            {!recSids[focusedSession.id] && (
              <span
                className="absolute w-1.5 h-1.5 rounded-full animate-ping"
                style={{ background: "var(--nx-error)", opacity: 0.3 }}
              />
            )}
            <span
              className="relative w-1.5 h-1.5 rounded-full"
              style={{
                background: recSids[focusedSession.id]
                  ? "var(--nx-text-muted)"
                  : "var(--nx-error)",
                boxShadow: recSids[focusedSession.id]
                  ? "none"
                  : "0 0 3px var(--nx-error)",
              }}
            />
          </button>
        )}

        <div className="ml-auto flex items-center gap-1 text-meta">
          {syncState !== "none" && (
            <span className="relative inline-flex">
              <HeaderButton
                icon={<Sparkles size={12} />}
                onClick={() => setAiPanelOpen(true)}
                title="AI-подсказка команд (Ctrl+Shift+A)"
                active={ai.granted || aiPanelOpen}
              >
                AI
              </HeaderButton>
              {/* Индикатор на кнопке (общий компонент, тот же на мобиле). */}
              <AiIndicatorDot ai={ai} panelOpen={aiPanelOpen} />
            </span>
          )}
          {syncState !== "none" && (
            <HeaderButton
              icon={syncState === "on" ? <Cloud size={12} /> : <CloudOff size={12} />}
              onClick={() => setSyncPanelOpen(true)}
              title={t(syncState === "on" ? "header.sync_on" : "header.sync_off")}
              active={syncState === "on"}
            >
              {t("sync.header")}
            </HeaderButton>
          )}
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
            onClick={() => {
              // Vault is a headline feature, not buried in settings: clicking
              // always opens the panel, which itself routes to create / unlock
              // / manage based on the current status.
              if (!vault?.configured) markVaultPromptSeen();
              setVaultPanelOpen(true);
            }}
            title={
              vault?.unlocked
                ? t("vault.open_panel")
                : vault?.configured
                  ? t("vault.header_unlock")
                  : t("vault.header_setup")
            }
            active={vault?.unlocked}
            warn={vault?.configured && !vault?.unlocked}
          >
            {vault?.configured ? "vault" : t("vault.header_enable")}
          </HeaderButton>
          <HeaderButton
            icon={<NetworkIcon size={12} />}
            onClick={() => openTunnelsPanel()}
            title={t("tunnel.title")}
            active={activeTunnels > 0}
          >
            {t("tunnel.header")}
          </HeaderButton>
          <HeaderButton
            icon={<HistoryIcon size={12} />}
            onClick={async () => {
              // History on → open the panel. History off → ask to enable it via a
              // themed modal (not a jerky scroll into Settings) that ALSO lets the
              // user pick the recording mode up front (light vs full) instead of
              // silently defaulting. On choice we flip the toggle + set the mode
              // and open the now-active panel.
              if (settings.historyEnabled) {
                setHistoryPanelOpen(true);
                return;
              }
              const ok = await askConfirm(t("history.enable_prompt"), {
                title: t("history.enable_title"),
              });
              if (ok) {
                setSettings({ historyEnabled: true, historyMode: "light" });
                setHistoryPanelOpen(true);
              }
            }}
            title={
              settings.historyEnabled
                ? t("history.open_panel")
                : t("history.enable_hint")
            }
            active={settings.historyEnabled}
          >
            {t("history.button")}
          </HeaderButton>
          {activeId && (
            <HeaderButton
              icon={<Search size={12} />}
              onClick={() =>
                window.dispatchEvent(
                  new CustomEvent("nx:find", { detail: { sessionId: activeId } }),
                )
              }
              title={t("terminal.find_title")}
            />
          )}
          <HeaderButton
            icon={<Zap size={12} />}
            onClick={() => setSnippetsOpen(true)}
            title={t("snippets.btn") + " (Ctrl+Shift+X)"}
            active={snippetsOpen}
          />
          <HeaderButton
            icon={<HelpCircle size={12} />}
            onClick={() => setShortcutsOpen(true)}
            title={t("shortcuts.open_title") + " (?)"}
          />
          <HeaderButton
            icon={<SettingsIcon size={12} />}
            onClick={() => {
              setSettingsSection(undefined);
              setSettingsOpen(true);
            }}
            title={t("settings.open") + " (Ctrl ,)"}
          />
          <div className="ml-1">
            <LanguageSwitcher />
          </div>
          <WindowControls />
        </div>
      </header>
      )}

      {/* First-run nudge: offer to set up the vault. Non-blocking bar under the
       *  header; dismissing or setting up marks it seen so it never returns. */}
      {vaultPromptOpen && !vault?.configured && (
        <div className="relative z-20 flex items-center gap-3 px-4 py-2 border-b border-nx-border bg-nx-panel text-meta font-mono">
          <KeyRound size={14} className="shrink-0 text-nx-accent" />
          <span className="text-nx-soft min-w-0">{t("vault.prompt_body")}</span>
          <div className="ml-auto flex items-center gap-2 shrink-0">
            <button
              onClick={() => {
                markVaultPromptSeen();
                setVaultPromptOpen(false);
                setVaultPanelOpen(true);
              }}
              className="px-2.5 py-0.5 rounded-nx-sm bg-nx-accent text-nx-bg font-bold hover:opacity-90 transition-opacity"
            >
              {t("vault.prompt_setup")}
            </button>
            <button
              onClick={() => {
                markVaultPromptSeen();
                setVaultPromptOpen(false);
              }}
              className="px-2.5 py-0.5 rounded-nx-sm text-nx-muted hover:text-nx-text hover:bg-nx-elevated transition-colors"
            >
              {t("vault.prompt_later")}
            </button>
          </div>
        </div>
      )}

      <div className="relative z-10 flex-1 min-h-0 flex">
        {/* Desktop: inline sidebar + drag-divider. Mobile: drawer overlay
         *  triggered by the hamburger; no inline space taken. */}
        {!isMobile && (
          <>
            <Sidebar
              onConnect={openHost}
              onSftp={openSftp}
              onTunnel={openTunnelFor}
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
              onAddHost={() => setCreateHostOpen(true)}
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
        <div className="flex-1 min-w-0 flex flex-col relative">
          {/* Mobile Hosts tab: the host list as a full-screen overlay ON TOP of
           *  the (still-mounted) terminal layer — so switching to Hosts and back
           *  never remounts an xterm. z-40 covers the workspace TabBar + rain. */}
          {isMobile && mobileTab === "hosts" && (
            <div className="absolute inset-0 z-40 flex flex-col bg-nx-bg">
              <Sidebar
                fill
                onConnect={(h) => {
                  openHost(h);
                  setMobileTab("sessions");
                }}
                onSftp={openSftp}
                onTunnel={openTunnelFor}
                onSelect={setSelectedHost}
                activeHostId={activeSession?.id ?? null}
                openHostIds={openHostIds}
                selectedId={selectedHost?.id ?? null}
                collapsed={false}
                onToggleCollapsed={() => {}}
                onContextMenu={(x, y, items, title) =>
                  setMenu({ x, y, items, title })
                }
                clickMode={settings.clickMode}
                onAddHost={() => setCreateHostOpen(true)}
              />
            </div>
          )}
          {/* Mobile Files tab: single-pane SFTP browser, same overlay slot as
           *  Hosts (lazy — pulls in the dialog plugin only when first opened). */}
          {isMobile && mobileTab === "files" && (
            <div className="absolute inset-0 z-40 bg-nx-bg">
              <Suspense fallback={null}>
                <MobileFiles
                  resolveArgs={resolveSftpArgs}
                  openHostId={mobileFilesHostId ?? undefined}
                  onOpened={() => setMobileFilesHostId(null)}
                />
              </Suspense>
            </div>
          )}
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
            onSelect={(id) => {
              setActiveWorkspaceId(id);
              wakeWorkspace(id);
            }}
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
                // Sending input clears any lingering mobile text selection.
                window.dispatchEvent(
                  new CustomEvent("nx:input", {
                    detail: { sessionId: focusedSession.id },
                  }),
                );
              }}
            />
          )}
        </div>
      </div>

      {/* Mobile bottom navigation. Hidden while a live terminal is full-screen
       *  (Sessions tab + a connected, focused session) so the terminal and
       *  SmartKeyBar own the viewport; ☰ / the Sessions tab bring it back. */}
      {isMobile &&
        !(
          mobileTab === "sessions" &&
          !!focusedSession &&
          focusedSession.status === "connected"
        ) && (
          <MobileTabBar
            active={settingsOpen ? "settings" : mobileTab}
            onSelect={selectMobileTab}
            sessionCount={allSessions.length}
            filesEnabled={FILES_TAB_ENABLED}
          />
        )}

      {!isMobile && (
        <StatusLine
          sessionCount={allSessions.length}
          connectingCount={
            allSessions.filter((s) => s.status === "connecting").length
          }
          activeHost={
            focusedSession
              ? `${focusedSession.host.user}@${focusedSession.host.host}`
              : null
          }
          activeStatus={focusedSession?.status ?? null}
          activeVpn={!!focusedSession?.host.useVpn}
          activeVpnExit={focusedSession?.host.vpnExit ?? null}
        />
      )}

      {/* Lazy-loaded panels: rendered only when the user opens them. Bundle
       *  splitting keeps the initial JS chunk small. Suspense fallback is null
       *  — the brief load gap on first open is acceptable for a modal. */}
      {appLocked && (
        <VaultLockScreen
          onUnlocked={() => {
            setAppLocked(false);
            vaultStatus().then(setVault).catch(() => {});
            // If the host list is encrypted it read empty while locked —
            // nudge subscribers to re-read now that the vault is open.
            refreshHosts();
          }}
        />
      )}
      <Suspense fallback={null}>
        {vaultPanelOpen && (
          <VaultPanel
            onClose={() => setVaultPanelOpen(false)}
            onChange={setVault}
            onLock={() => {
              setVaultPanelOpen(false);
              lockApp();
            }}
          />
        )}
        {syncPanelOpen && (
          <SyncPanel
            onClose={() => setSyncPanelOpen(false)}
            onOpenSettings={() => {
              setSyncPanelOpen(false);
              setSettingsSection("account");
              setSettingsOpen(true);
            }}
          />
        )}
        <CommandPalette
          open={paletteOpen}
          items={paletteOpen ? buildPaletteItems() : []}
          onClose={() => {
            setPaletteOpen(false);
            if (!isMobile) focusActiveTerminal();
          }}
          onAskAi={(q) => {
            ai.setQuery(q);
            setAiPanelOpen(true);
          }}
        />
        <AiPanel
          open={aiPanelOpen}
          onClose={() => {
            setAiPanelOpen(false);
            // Вернуть фокус в терминал, чтобы после сворачивания панели курсор
            // сразу был в сессии (без клика по окну). На мобиле не трогаем —
            // focus всплывает клавиатуру.
            if (!isMobile) focusActiveTerminal();
          }}
          hasSession={!!activeId}
          ai={ai}
          onInsert={(cmd) => {
            if (activeId) sshSend(activeId, new TextEncoder().encode(cmd));
            // Вернуть фокус в терминал, чтобы Enter сработал сразу (без клика).
            focusActiveTerminal();
          }}
        />
        {sftpEntry && activeId && !isMobile && (
          <SFTPPanel
            // Desktop only — on mobile the Files tab (MobileFiles) owns SFTP, so
            // the dual-pane desktop panel must NOT also render (was doubling up).
            // Key on the session id so switching tabs remounts the panel for the
            // newly-focused session. Per-session remote/local paths are seeded
            // back via initial*Path so the remount resumes where it left off.
            key={activeId}
            connectArgs={sftpEntry.args}
            title={sftpEntry.title}
            collapsed={sftpEntry.collapsed}
            initialRemotePath={sftpEntry.remotePath}
            initialLocalPath={sftpEntry.localPath}
            onPathChange={onSftpPathChange}
            onCollapse={toggleSftpCollapse}
            onClose={closeSftp}
          />
        )}
        {tunnelsPanel?.open && (
          <TunnelsPanel
            newTunnel={tunnelsPanel.newTunnel}
            onStartSaved={startSavedForward}
            onClose={() => setTunnelsPanel(null)}
          />
        )}
        {historyPanelOpen && (
          <HistoryPanel onClose={() => setHistoryPanelOpen(false)} />
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
          onQuickConnect={(host, port, save, user, password) => {
            setPickerOpen(false);
            setPendingSplit(null);
            // Reachability + creds уже собраны в quick-connect карточке TabPicker
            // (step 11). Здесь только открываем сессию (+ сохраняем хост, если save).
            // Legacy-алгоритмы включены, чтобы "просто работало" со старым железом.
            // При save — под id СОХРАНЁННОГО хоста (живой бейдж/каретка в сайдбаре),
            // иначе одноразовый "quick-" id.
            const id = save ? newHostId() : "quick-" + crypto.randomUUID();
            if (save) {
              saveHost({
                id,
                name: host,
                host,
                port,
                user,
                auth: { kind: "password", password: "" }, // никогда не храним пароль
                alwaysAskPassword: true,
                allowLegacy: true,
              }).catch(() => {});
            }
            openHost({
              id,
              name: host,
              host,
              port,
              user,
              auth: { kind: "password", password },
              alwaysAskPassword: false,
              allowLegacy: true,
            });
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
      {hostKeyReq && (
        <ConfirmDialog
          title={hostKeyReq.info.changed ? "⚠ Ключ сервера ИЗМЕНИЛСЯ" : "Новый ключ сервера"}
          message={
            (hostKeyReq.info.changed
              ? "Ключ хоста отличается от сохранённого. Это может быть переустановка сервера — или подмена (MITM). Принимайте только если вы знаете причину.\n\n"
              : "Это первое подключение к хосту. Примите ключ, чтобы продолжить.\n\n") +
            `${hostKeyReq.info.host}:${hostKeyReq.info.port}\nSHA256: ${hostKeyReq.info.fingerprint}`
          }
          confirmLabel="Принять ключ"
          cancelLabel="Отмена"
          destructive={hostKeyReq.info.changed}
          onConfirm={() => {
            hostKeyReq.resolve(true);
            setHostKeyReq(null);
          }}
          onCancel={() => {
            hostKeyReq.resolve(false);
            setHostKeyReq(null);
          }}
        />
      )}
      {kbiReq && (
        <KbiPromptDialog
          req={kbiReq}
          onSubmit={(answers) => {
            invoke("ssh_kbi_respond", { sessionId: kbiReq.session_id, answers });
            setKbiReq(null);
          }}
          onCancel={() => {
            // Empty answers → server rejects → auth fails fast (no 180s hang).
            invoke("ssh_kbi_respond", { sessionId: kbiReq.session_id, answers: [] });
            setKbiReq(null);
          }}
        />
      )}
      {prefillHost && (
        <HostDialog
          initial={prefillHost}
          onClose={() => setPrefillHost(null)}
          onSaved={(saved) => {
            setSelectedHost(saved);
            setPrefillHost(null);
          }}
        />
      )}

      {shortcutsOpen && (
        <ShortcutsOverlay onClose={() => setShortcutsOpen(false)} />
      )}

      {snippetsOpen && (
        <SnippetsModal
          onClose={() => setSnippetsOpen(false)}
          onRun={(data) => {
            if (activeId) {
              sshSend(activeId, new TextEncoder().encode(data));
              // Nudge the terminal to clear selection + take focus (so the user
              // can type right after a snippet, no mouse click needed).
              window.dispatchEvent(
                new CustomEvent("nx:input", { detail: { sessionId: activeId } }),
              );
            }
          }}
          activeCtx={
            focusedSession
              ? {
                  host: focusedSession.host.host,
                  user: focusedSession.host.user,
                  port: focusedSession.host.port,
                  name: focusedSession.host.name,
                }
              : null
          }
          onToast={showToast}
          // On mobile this modal is the MANAGER only (CRUD + sync); running into
          // the terminal is the SmartKeyBar ⚡. So a tap edits, never sends.
          manageOnly={isMobile}
          onSync={async () => {
            try {
              const r = await accountSyncNow();
              showToast(t("snippets.sync_done", { pulled: r.pulled, pushed: r.pushed }));
            } catch {
              showToast(t("snippets.sync_failed"), "error");
            }
          }}
        />
      )}

      {selectedHost && !editHost && !createHostOpen && (
        <HostInfoCard
          host={selectedHost}
          onConnect={() => {
            const h = selectedHost;
            setSelectedHost(null);
            if (isMobile) setMobileTab("sessions"); // jump to the terminal
            openHost(h);
          }}
          onEdit={() => {
            setEditHost(selectedHost);
            setSelectedHost(null);
          }}
          onClose={() => setSelectedHost(null)}
        />
      )}

      {/* Settings as an OVERLAY (not a return-replacement) so TerminalView
       *  stays mounted underneath — opening Settings no longer disconnects
       *  the active SSH session. */}
      {settingsOpen && (
        <div className="fixed inset-0 z-40">
          <Suspense fallback={null}>
            <SettingsScreen
              onClose={() => {
                setSettingsOpen(false);
                setSettingsSection(undefined);
              }}
              sessionCount={allSessions.length}
              initialSection={settingsSection}
            />
          </Suspense>
        </div>
      )}

      {pwQueue[0] && (
        <PasswordPrompt
          key={pwQueue[0].id}
          user={pwQueue[0].user}
          host={pwQueue[0].host}
          onSubmit={(creds) => {
            pwQueue[0].resolve(creds);
            setPwQueue((q) => q.slice(1));
          }}
          onCancel={() => {
            pwQueue[0].resolve(null);
            setPwQueue((q) => q.slice(1));
          }}
        />
      )}

      <DialogHost />

      {/* Transient toast (tunnel started, …). */}
      {toast && (
        <div
          className={
            "fixed bottom-4 left-1/2 -translate-x-1/2 z-[120] px-4 py-2 rounded-nx bg-nx-panel shadow-glow-md font-mono text-meta " +
            (toast.kind === "error"
              ? "border-2 border-nx-error text-nx-error"
              : "border border-nx-accent text-nx-text")
          }
        >
          {toast.msg}
        </div>
      )}

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

      {/* Window-edge resize zones (decorations:false has no native resize
       *  border/cursors). Desktop only — mobile windows aren't resized. */}
      {HAS_TAURI && !isMobile && <ResizeHandles />}
    </main>
  );
}

export default App;
