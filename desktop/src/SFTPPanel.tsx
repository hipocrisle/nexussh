// SFTPPanel — remote file browser over SFTP. Opened per-host from the
// sidebar context menu. Single remote pane by default; an optional dual-pane
// mode adds a read-only LOCAL filesystem pane on the left, with copy between
// the two (model A: separate SFTP connection, decoupled from the interactive
// shell session). Local side also reachable via OS file dialogs.
//
// Navigation & selection follow Midnight Commander / Total Commander:
//   • single click = move the cursor + select only that row
//   • double click / Enter = open a directory (file: no-op for now)
//   • Ctrl/Cmd+click = toggle a row in the multi-selection
//   • Shift+click / Shift+Arrow = range-select
//   • ArrowUp/Down move the cursor; Insert AND Space toggle + advance
//   • Home/End jump; Backspace goes up a level
//   • a real ".." row at the top navigates to the parent dir
// Operations (delete / chmod / dual-pane copy) act on the whole selection when
// non-empty, otherwise on the cursor row.

import { useState, useEffect, useCallback, useRef, Fragment } from "react";
import { useTranslation } from "react-i18next";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import {
  Folder,
  File as FileIcon,
  Upload,
  Download,
  FolderPlus,
  RefreshCw,
  ArrowUp,
  Loader2,
  Link2,
  KeyRound,
  X,
  Columns2,
  HardDrive,
  Server,
  ArrowRight,
  ArrowLeft,
  CornerLeftUp,
  HelpCircle,
  Minus,
  FolderOpen,
} from "lucide-react";
import type { ConnectArgs } from "./ssh";
import {
  SftpEntry,
  SftpProgress,
  sftpConnect,
  sftpRealpath,
  sftpList,
  sftpDownload,
  sftpUpload,
  sftpMkdir,
  sftpRename,
  sftpRemove,
  sftpChmod,
  sftpChmodRecursive,
  sftpDisconnect,
  sftpCancel,
  isCancelled,
  onSftpProgress,
} from "./sftp";
import {
  Transfer,
  useTransfers,
  addTransfer,
  updateTransfer,
  markCancelling,
  removeTransfer,
} from "./transfers";
import {
  LocalEntry,
  localHome,
  localList,
  localSize,
  localDrives,
  localMkdir,
  localRename,
  localDelete,
} from "./localfs";
import { openPath } from "@tauri-apps/plugin-opener";
import { FileViewer } from "./FileViewer";
import { ContextMenu, MenuItem } from "./ContextMenu";
import { useBackdropClose } from "./useBackdropClose";
import { Button, IconButton, Checkbox, Input } from "./components/primitives";
import { askPrompt, askConfirm, askChoice } from "./dialogs";

interface Props {
  connectArgs: ConnectArgs;
  title: string;
  onClose: () => void;
  /** When true the panel stays MOUNTED (cwd / selection / in-flight transfers
   *  all preserved) but is visually hidden and its backdrop stops capturing
   *  pointer events, so the terminal underneath is fully usable. */
  collapsed?: boolean;
  /** Minimise (non-destructive): hide the panel, keep it mounted. */
  onCollapse?: () => void;
  /** Seed the remote cwd / local dir on mount (per-session memory from App).
   *  When present and non-empty they take precedence over the home/root +
   *  localStorage defaults; if a seeded dir no longer lists, we fall back to the
   *  normal resolution rather than erroring. */
  initialRemotePath?: string;
  initialLocalPath?: string;
  /** Fired whenever the remote cwd OR the local dir changes, with the current
   *  pair. App persists it onto the session entry so a tab-switch remount can
   *  resume here via initial*Path. */
  onPathChange?: (remote: string, local: string) => void;
}

// ── Generic row entry (lowest common denominator of SftpEntry / LocalEntry) ──
// Panes are driven by this shape so the cursor / selection / keyboard logic is
// shared. The original typed entry is kept in `raw` for op-specific access.
interface Row {
  name: string;
  is_dir: boolean;
  is_symlink?: boolean;
  size: number;
}

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  const u = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${u[i]}`;
}

function fmtMtime(secs: number): string {
  if (!secs) return "";
  const d = new Date(secs * 1000);
  return d.toISOString().slice(0, 16).replace("T", " ");
}

function fmtPerms(mode: number): string {
  if (!mode) return "";
  const bits = mode & 0o777;
  const rwx = (b: number) =>
    `${b & 4 ? "r" : "-"}${b & 2 ? "w" : "-"}${b & 1 ? "x" : "-"}`;
  return rwx((bits >> 6) & 7) + rwx((bits >> 3) & 7) + rwx(bits & 7);
}

function joinPath(dir: string, name: string): string {
  return dir.endsWith("/") ? dir + name : dir + "/" + name;
}

// Build the panel `error` string for a finished upload/copy batch. Real transfer
// failures (permission denied, quota, missing dir) are listed first and
// prominently — never folded into / overwritten by the "skipped directory" note.
// Returns null when there's nothing to report.
function buildTransferError(
  t: (k: string, o?: Record<string, unknown>) => string,
  failed: { name: string; msg: string }[],
  skippedDirs: string[],
): string | null {
  const parts: string[] = [];
  if (failed.length > 0) {
    const list = failed.map((f) => `${f.name}: ${f.msg}`).join(" · ");
    parts.push(`${t("sftp.transfer_failed")}: ${list}`);
  }
  if (skippedDirs.length > 0) {
    parts.push(t("sftp.copy_skipped_dir", { name: skippedDirs.join(", ") }));
  }
  return parts.length > 0 ? parts.join("  —  ") : null;
}

function parentPath(p: string): string {
  if (p === "/" || p === "") return "/";
  const trimmed = p.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  return idx <= 0 ? "/" : trimmed.slice(0, idx);
}

// --- Local-filesystem path helpers (cross-platform) ---
// The local home dir arrives in native form, so Windows paths use "\". We keep
// the native separator when joining / going up so the OS-side commands get a
// valid path on every platform.

function localSep(p: string): string {
  return p.includes("\\") && !p.includes("/") ? "\\" : "/";
}

function localJoin(dir: string, name: string): string {
  const sep = localSep(dir);
  return dir.endsWith(sep) ? dir + name : dir + sep + name;
}

function localParent(p: string): string {
  const sep = localSep(p);
  // Windows drive root ("C:\") — already at top.
  if (/^[A-Za-z]:[\\/]?$/.test(p)) return p;
  if (p === "/" || p === "") return "/";
  const trimmed = p.replace(new RegExp(`\\${sep}+$`), "");
  const idx = trimmed.lastIndexOf(sep);
  if (idx < 0) return p;
  if (idx === 0) return sep; // POSIX root
  // Keep the trailing separator for a Windows drive root ("C:\").
  if (/^[A-Za-z]:$/.test(trimmed.slice(0, idx))) return trimmed.slice(0, idx) + sep;
  return trimmed.slice(0, idx);
}

function isKeyfile(name: string): boolean {
  return (
    /^(id_rsa|id_ed25519|id_ecdsa|id_dsa)(\.pub)?$/.test(name) ||
    name.endsWith(".pem")
  );
}

const CODE_EXT = ["YML", "YAML", "JSON", "TS", "JS", "SH", "PY", "MD", "CONF", "TOML"];

// Size guard for the built-in viewer/editor: a file larger than this is shown
// as "too large" (VIEW only / no edit) rather than slurped into the webview.
const VIEWER_MAX_BYTES = 2 * 1024 * 1024;

const GRID = "28px 22px 1fr 110px 160px 130px 110px";

// Compact grid used by both panes when the dual-pane manager is active — the
// columns are narrower so two lists fit side by side (checkbox · icon · name ·
// size).
const PANE_GRID = "26px 20px 1fr 78px";

// ── Persistence (localStorage) ──────────────────────────────────────────────
// The view mode (dual vs single) and the last-visited directories survive across
// panel closes / app restarts. Remote dirs are kept per-host (keyed by the
// host address); the local dir is a single shared value. All reads are guarded
// so a corrupt / unavailable localStorage degrades to the defaults.
const LS_DUAL = "nexussh.sftp.dualPane";
const LS_LOCAL_DIR = "nexussh.sftp.localDir";
const LS_REMOTE_DIR_PREFIX = "nexussh.sftp.remoteDir."; // + host

function readDualPane(): boolean {
  try {
    const v = localStorage.getItem(LS_DUAL);
    // Default = dual-pane (mono is opt-in): only an explicit "0" means single.
    return v !== "0";
  } catch {
    return true;
  }
}
function writeDualPane(v: boolean) {
  try {
    localStorage.setItem(LS_DUAL, v ? "1" : "0");
  } catch {
    /* ignore */
  }
}
function readLocalDir(): string | null {
  try {
    return localStorage.getItem(LS_LOCAL_DIR);
  } catch {
    return null;
  }
}
function writeLocalDir(p: string) {
  try {
    if (p) localStorage.setItem(LS_LOCAL_DIR, p);
  } catch {
    /* ignore */
  }
}
function readRemoteDir(host: string): string | null {
  try {
    return localStorage.getItem(LS_REMOTE_DIR_PREFIX + host);
  } catch {
    return null;
  }
}
function writeRemoteDir(host: string, p: string) {
  try {
    if (p) localStorage.setItem(LS_REMOTE_DIR_PREFIX + host, p);
  } catch {
    /* ignore */
  }
}

// ── Selection / cursor model ────────────────────────────────────────────────
// A pane owns:
//   • cursor   — the single focused row index (-1 when nothing/empty)
//   • selected — a Set of selected entry *names* (multi-selection)
//   • anchor   — the index a Shift-range extends from
// The ".." row is index -1 and is never selectable / cursorable as a target;
// it only ever fires "navigate up".

interface PaneSel {
  cursor: number;
  selected: Set<string>;
  anchor: number;
}

function emptySel(): PaneSel {
  return { cursor: -1, selected: new Set(), anchor: -1 };
}

/** Names in [a,b] (inclusive, order-independent) within `rows`. */
function rangeNames(rows: Row[], a: number, b: number): string[] {
  const lo = Math.max(0, Math.min(a, b));
  const hi = Math.min(rows.length - 1, Math.max(a, b));
  const out: string[] = [];
  for (let i = lo; i <= hi; i++) out.push(rows[i].name);
  return out;
}

function FileTypeIcon({ entry }: { entry: Row }) {
  if (entry.is_dir) {
    return (
      <Folder
        size={14}
        className="text-nx-accent2"
        style={{ fill: "var(--nx-accent2)", fillOpacity: 0.25, strokeWidth: 1.5 }}
      />
    );
  }
  if (entry.is_symlink) return <Link2 size={14} className="text-nx-soft" />;
  if (isKeyfile(entry.name)) return <KeyRound size={14} className="text-nx-warning" />;
  return <FileIcon size={14} className="text-nx-muted" />;
}

function FileTypeChip({ entry }: { entry: Row }) {
  let label: string | null = null;
  let cls = "";
  if (entry.is_dir) {
    label = "DIR";
    cls = "text-nx-muted border-nx-border";
  } else if (entry.is_symlink) {
    label = "LNK";
    cls = "text-nx-accent2 border-[rgba(0,212,255,0.35)]";
  } else if (isKeyfile(entry.name)) {
    label = "KEY";
    cls = "text-nx-warning border-[rgba(245,215,110,0.35)]";
  } else {
    const ext = entry.name.split(".").pop()?.toUpperCase();
    if (ext && CODE_EXT.includes(ext)) {
      label = ext;
      cls = "text-nx-soft border-[rgba(127,215,255,0.35)]";
    }
  }
  if (!label) return null;
  return (
    <span
      className={
        "inline-flex items-center px-1.5 text-[9px] uppercase tracking-wider rounded-sm border bg-nx-elevated shrink-0 " +
        cls
      }
    >
      {label}
    </span>
  );
}

// Is this a Windows-style path? (drive-letter prefix or any backslash present.)
function isWindowsPath(p: string): boolean {
  return /^[A-Za-z]:/.test(p) || p.includes("\\");
}

function Breadcrumb({
  path,
  onNavigate,
  compact,
  /** When set, the path is treated as a LOCAL filesystem path and rebuilt with
   *  the platform's own separator / root form (Windows: "C:\a\b", POSIX: "/a/b").
   *  The remote pane never sets this — it's always POSIX. */
  local,
}: {
  path: string;
  onNavigate: (p: string) => void;
  compact?: boolean;
  local?: boolean;
}) {
  const win = local && isWindowsPath(path);
  // Split on BOTH separators so a stray mix never produces empty / malformed
  // segments. For Windows the first segment is the drive ("C:").
  const segments = path.split(/[\\/]+/).filter(Boolean);

  // Root button: clicking it goes to the drive root ("C:\") on Windows, "/" on
  // POSIX. For Windows the drive lives in segments[0], so build it from there.
  const winDrive = win && segments.length > 0 ? segments[0] : "";
  const rootTarget = win ? (winDrive ? winDrive + "\\" : "\\") : "/";
  const rootLabel = win ? (winDrive || "\\") : "/";

  // For Windows we render the drive as the root button (segments[0]) and start
  // the clickable segment list after it; POSIX keeps the leading "/" root button
  // and lists every segment.
  const listSegs = win ? segments.slice(1) : segments;
  // Build the clickable target for the i-th item of listSegs.
  const targetFor = (i: number): string => {
    if (win) {
      // drive + backslash + joined sub-segments (no trailing slash)
      return winDrive + "\\" + segments.slice(1, i + 2).join("\\");
    }
    return "/" + segments.slice(0, i + 1).join("/");
  };
  const sepChar = win ? "\\" : "/";

  return (
    <div
      className={
        "flex items-center gap-1.5 rounded-nx border border-nx-border bg-nx-panel text-body min-w-0 overflow-x-auto " +
        (compact ? "px-2.5 py-1 text-meta font-mono" : "px-3 py-1")
      }
    >
      <button
        onClick={() => onNavigate(rootTarget)}
        className="text-nx-muted hover:text-nx-soft shrink-0"
      >
        {rootLabel}
      </button>
      {listSegs.map((seg, i) => {
        const isLast = i === listSegs.length - 1;
        const subPath = targetFor(i);
        return (
          <span key={i} className="flex items-center gap-1.5 shrink-0">
            <span className="text-nx-accent">{sepChar}</span>
            <button
              onClick={() => onNavigate(subPath)}
              className={isLast ? "text-nx-text" : "text-nx-soft hover:underline"}
            >
              {seg}
            </button>
          </span>
        );
      })}
    </div>
  );
}

export function SFTPPanel({
  connectArgs,
  title,
  onClose,
  collapsed,
  onCollapse,
  initialRemotePath,
  initialLocalPath,
  onPathChange,
}: Props) {
  const { t } = useTranslation();
  const [sftpId, setSftpId] = useState<string | null>(null);
  const [cwd, setCwd] = useState("/");
  const [entries, setEntries] = useState<SftpEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Context menu: the row that was right-clicked plus whether it falls inside
  // the active multi-selection (decides whether the action is batch or single).
  const [ctx, setCtx] = useState<{
    x: number;
    y: number;
    // The right-clicked row plus which pane it belongs to, so the menu renderer
    // picks the matching (local vs remote) action set.
    pane: "local" | "remote";
    entry: SftpEntry | LocalEntry;
  } | null>(null);
  const [remoteSel, setRemoteSel] = useState<PaneSel>(emptySel());
  const selected = remoteSel.selected;
  // Active transfers keyed by transferId → live progress for the bar. Kept in a
  // module-level store (transfers.ts), not component state, so the bars + their
  // labels survive the panel being closed and reopened mid-transfer.
  const transfers = useTransfers();
  // chmod can target a single entry OR a batch (selection) — store the list.
  const [chmodTargets, setChmodTargets] = useState<SftpEntry[] | null>(null);
  // Built-in file viewer/editor (F3 view / F4 edit). Null when closed; carries
  // the remote path/name + initial mode of the file being opened.
  const [viewer, setViewer] = useState<{
    path: string;
    name: string;
    mode: "view" | "edit";
  } | null>(null);
  // Backdrop (outside) click = COLLAPSE; Esc / ✗ = full close. Both act ONLY
  // while visible: when collapsed the panel is hidden and the terminal owns the
  // keyboard, so Esc must reach the terminal, not tear the panel down, and the
  // backdrop captures nothing.
  const collapsedRef = useRef(collapsed);
  collapsedRef.current = collapsed;
  const guardedClose = useCallback(() => {
    if (!collapsedRef.current) onClose();
  }, [onClose]);
  const guardedCollapse = useCallback(() => {
    // Fall back to a close if no collapse handler is wired (defensive).
    if (collapsedRef.current) return;
    if (onCollapse) onCollapse();
    else onClose();
  }, [onCollapse, onClose]);
  // backdrop click → collapse; Esc → close.
  const { backdropProps, contentProps } = useBackdropClose(
    guardedCollapse,
    guardedClose,
  );
  const idRef = useRef<string | null>(null);
  // On restore (collapsed → visible) move keyboard focus back into the panel's
  // active pane so Arrow/Space/Enter work immediately. The pane's FileList owns
  // a focusable scroll container (tabIndex=0); focus the active one.
  const contentRef = useRef<HTMLDivElement>(null);
  const wasCollapsedRef = useRef(collapsed);
  useEffect(() => {
    if (wasCollapsedRef.current && !collapsed) {
      requestAnimationFrame(() => {
        const lists = contentRef.current?.querySelectorAll<HTMLElement>(
          '[data-sftp-list][tabindex="0"]',
        );
        if (!lists || lists.length === 0) return;
        const target =
          Array.from(lists).find((el) => el.dataset.sftpActive === "1") ??
          lists[0];
        target.focus({ preventScroll: true });
      });
    }
    wasCollapsedRef.current = collapsed;
  }, [collapsed]);
  // True while OS files are being dragged over the panel (drop-zone overlay).
  const [dragOver, setDragOver] = useState(false);

  // --- Dual-pane (local ↔ remote) file manager ---
  // Default = dual-pane, persisted across opens (see readDualPane).
  const [dualPane, setDualPane] = useState<boolean>(readDualPane);
  // Which pane the keyboard / MC-TC hotkeys target. In single-pane mode it's
  // always "remote"; in dual-pane Tab flips it.
  const [activePane, setActivePane] = useState<"local" | "remote">("remote");
  // F1 cheat-sheet overlay.
  const [helpOpen, setHelpOpen] = useState(false);
  const [localCwd, setLocalCwd] = useState("");
  const [localEntries, setLocalEntries] = useState<LocalEntry[]>([]);
  const [localLoading, setLocalLoading] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [localSel, setLocalSel] = useState<PaneSel>(emptySel());
  const localSelected = localSel.selected;
  // Local drive roots (Windows: C:\, D:\, …; Linux/mac: just "/"). The picker is
  // shown only when more than one root exists, so it's effectively Windows-only.
  const [localDriveList, setLocalDriveList] = useState<string[]>([]);

  // Enumerate drive roots once when dual-pane first opens (cheap; static enough
  // that re-probing on every nav isn't worth it).
  useEffect(() => {
    if (!dualPane || localDriveList.length > 0) return;
    localDrives()
      .then(setLocalDriveList)
      .catch(() => setLocalDriveList([]));
  }, [dualPane, localDriveList.length]);

  // Which drive root the current local path lives under (for highlighting the
  // active drive button). Matches case-insensitively on the leading "X:".
  const currentDrive =
    localDriveList.find((d) =>
      localCwd.toLowerCase().startsWith(d.slice(0, 2).toLowerCase()),
    ) ?? null;

  const loadLocal = useCallback(async (path: string) => {
    setLocalLoading(true);
    setLocalError(null);
    try {
      const list = await localList(path);
      setLocalEntries(list);
      setLocalCwd(path);
      setLocalSel(emptySel());
    } catch (e) {
      setLocalError(String(e));
    } finally {
      setLocalLoading(false);
    }
  }, []);

  // Lazily initialise the local pane the first time dual-pane mode is enabled.
  // Restore the last-visited local dir if it still lists; else fall back to home.
  useEffect(() => {
    if (!dualPane || localCwd) return;
    (async () => {
      let home = "/";
      try {
        home = await localHome();
      } catch {
        home = "/";
      }
      // Try, in order: per-session seed (initialLocalPath), the shared
      // last-visited local dir, then home. First one that lists wins; a stale
      // path silently falls through to the next.
      const candidates = [initialLocalPath, readLocalDir()].filter(
        (p): p is string => !!p,
      );
      for (const cand of candidates) {
        try {
          const list = await localList(cand);
          setLocalEntries(list);
          setLocalCwd(cand);
          setLocalSel(emptySel());
          return;
        } catch {
          /* stored / seeded dir gone — try the next candidate */
        }
      }
      await loadLocal(home || "/");
    })();
  }, [dualPane, localCwd, loadLocal, initialLocalPath]);

  // Persist the view-mode choice. Single-pane has only the remote side, so
  // pin the active pane to remote whenever dual-pane is off.
  useEffect(() => {
    writeDualPane(dualPane);
    if (!dualPane) setActivePane("remote");
  }, [dualPane]);

  // Persist the last-visited dirs so the next open lands where we left off.
  useEffect(() => {
    if (localCwd) writeLocalDir(localCwd);
  }, [localCwd]);
  useEffect(() => {
    // cwd starts at "/" before connect resolves the real home — only persist a
    // real navigation (sftpId present) so we don't overwrite with the placeholder.
    if (sftpId && cwd) writeRemoteDir(connectArgs.host, cwd);
  }, [cwd, sftpId, connectArgs.host]);

  // Report the current (remote, local) path pair up to App so it can be stored
  // on the per-session SFTP entry and re-seeded after a tab-switch remount.
  // Gated on sftpId so the placeholder "/" before connect resolves never
  // clobbers a previously-saved path. Deduped via a ref so re-renders that don't
  // actually move either dir don't re-fire. onPathChange is read through a ref
  // so the effect doesn't re-run when App passes a fresh closure each render.
  const onPathChangeRef = useRef(onPathChange);
  onPathChangeRef.current = onPathChange;
  const lastReportedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!sftpId || !cwd) return;
    const key = cwd + " " + localCwd;
    if (lastReportedRef.current === key) return;
    lastReportedRef.current = key;
    onPathChangeRef.current?.(cwd, localCwd);
  }, [cwd, localCwd, sftpId]);

  function navigateLocal(path: string) {
    loadLocal(path);
  }
  function refreshLocal() {
    if (localCwd) loadLocal(localCwd);
  }

  // Listen for streaming progress events; drop a transfer shortly after it
  // reaches 100% so the bar lingers briefly then clears. The transfer record
  // (with its labels) lives in the module store and is created in startTransfer,
  // so here we only merge progress into an existing entry.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    onSftpProgress((p: SftpProgress) => {
      updateTransfer(p.id, {
        transferred: p.transferred,
        total: p.total,
        phase: p.phase,
      });
      if (p.total > 0 && p.transferred >= p.total) {
        setTimeout(() => removeTransfer(p.id), 800);
      }
    }).then((u) => {
      unlisten = u;
    });
    return () => {
      if (unlisten) unlisten();
    };
  }, []);

  // Register a transfer (so its label shows before the first progress event),
  // returning the generated id to hand to the backend. `dest` is the full
  // destination path (local for a download, remote for an upload) and is shown,
  // middle-truncated, on the bar.
  const startTransfer = useCallback(
    (name: string, phase: Transfer["phase"], dest: string) => {
      const id = crypto.randomUUID();
      addTransfer({ id, name, phase, dest });
      return id;
    },
    [],
  );

  const endTransfer = useCallback((id: string) => {
    removeTransfer(id);
  }, []);

  // Cancel a running transfer: ask the backend to stop, and reflect "cancelling"
  // on the bar until the download/upload promise rejects (handled by each caller
  // treating the CANCELLED sentinel as a normal user-cancel).
  const cancelTransfer = useCallback((id: string) => {
    markCancelling(id);
    sftpCancel(id).catch(() => {});
  }, []);

  // Decide what to do when a transfer target already exists. Returns:
  //   "overwrite" — start fresh (resume=false); the default for new / equal-or-
  //                 larger targets where there's nothing to resume.
  //   "resume"    — continue from the existing bytes (resume=true).
  //   "skip"      — already fully transferred; caller should report and skip.
  //   null        — user cancelled.
  // `targetSize` is the bytes already present at the destination, `sourceSize`
  // the full size of the file being transferred.
  const resolveResume = useCallback(
    async (
      name: string,
      targetSize: number,
      sourceSize: number,
    ): Promise<"overwrite" | "resume" | "skip" | null> => {
      // Nothing there yet, or unknown source size → plain overwrite (no prompt).
      if (targetSize <= 0 || sourceSize <= 0) return "overwrite";
      // Already complete (or stale-larger) — nothing to resume.
      if (targetSize >= sourceSize) return "skip";
      const choice = await askChoice(
        t("sftp.resume_prompt", {
          name,
          have: fmtSize(targetSize),
          total: fmtSize(sourceSize),
        }),
        {
          title: t("sftp.resume_title"),
          cancelLabel: t("sftp.cancel"),
          options: [
            { value: "resume", label: t("sftp.resume_action") },
            { value: "overwrite", label: t("sftp.resume_overwrite") },
          ],
        },
      );
      if (choice === "resume" || choice === "overwrite") return choice;
      return null; // cancelled
    },
    [t],
  );

  const load = useCallback(async (id: string, path: string) => {
    setLoading(true);
    setError(null);
    try {
      const list = await sftpList(id, path);
      setEntries(list);
      setCwd(path);
      setRemoteSel(emptySel());
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  // Connect on mount, disconnect on unmount.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const id = await sftpConnect(connectArgs);
        if (!alive) {
          sftpDisconnect(id).catch(() => {});
          return;
        }
        idRef.current = id;
        setSftpId(id);
        let home = "/";
        try {
          home = await sftpRealpath(id, ".");
        } catch {
          home = "/";
        }
        // Resolve the starting dir, most-specific first:
        //   1. initialRemotePath — per-session memory from App (survives a
        //      tab-switch remount); takes precedence when present.
        //   2. the last remote dir saved for this host in localStorage.
        //   3. the resolved home, else "/".
        // Each candidate is tried with a list() call; if it no longer lists we
        // fall through to the next rather than erroring.
        let start = home || "/";
        const candidates = [
          initialRemotePath,
          readRemoteDir(connectArgs.host),
        ].filter((p): p is string => !!p && p !== start);
        for (const cand of candidates) {
          try {
            await sftpList(id, cand);
            start = cand;
            break;
          } catch {
            /* stored / seeded dir gone — try the next candidate */
          }
        }
        await load(id, start);
      } catch (e) {
        if (alive) {
          setError(String(e));
          setLoading(false);
        }
      }
    })();
    return () => {
      alive = false;
      if (idRef.current) sftpDisconnect(idRef.current).catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function refresh() {
    if (sftpId) load(sftpId, cwd);
  }

  // Drag-and-drop upload: keep the current dir / connection in refs so the
  // single webview listener always sees the latest values without re-binding.
  const cwdRef = useRef(cwd);
  cwdRef.current = cwd;
  const dropBusyRef = useRef(false);

  const uploadPaths = useCallback(
    async (paths: string[]) => {
      const id = idRef.current;
      if (!id || paths.length === 0 || dropBusyRef.current) return;
      dropBusyRef.current = true;
      const dir = cwdRef.current;
      setError(null);
      // Real transfer errors (permission denied, no such dir, quota) are kept
      // SEPARATE from intentionally-skipped directories so a genuine failure is
      // surfaced prominently instead of being masked by a "directory skipped"
      // note. A path with no usable basename is treated as a skipped dir.
      const failed: { name: string; msg: string }[] = [];
      const skippedDirs: string[] = [];
      try {
        for (const p of paths) {
          const norm = p.replace(/\\/g, "/").replace(/\/+$/, "");
          const base = norm.split("/").pop();
          if (!base) {
            skippedDirs.push(p);
            continue;
          }
          const remoteDest = joinPath(dir, base);
          const tid = startTransfer(base, "upload", remoteDest);
          try {
            await sftpUpload(id, p, remoteDest, tid);
          } catch (e) {
            // User-cancelled drops are not errors — just stop this file silently.
            if (!isCancelled(e)) {
              failed.push({ name: base, msg: String(e) });
            }
          } finally {
            endTransfer(tid);
          }
        }
        setError(buildTransferError(t, failed, skippedDirs));
      } finally {
        dropBusyRef.current = false;
        if (idRef.current) load(idRef.current, cwdRef.current);
      }
    },
    [startTransfer, endTransfer, load, t],
  );

  // Register the OS drag-drop listener while the panel is mounted; the whole
  // webview receives the event, so we only act because this panel is open.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let active = true;
    getCurrentWebview()
      .onDragDropEvent((e) => {
        const payload = e.payload;
        if (payload.type === "enter" || payload.type === "over") {
          setDragOver(true);
        } else if (payload.type === "leave") {
          setDragOver(false);
        } else if (payload.type === "drop") {
          setDragOver(false);
          uploadPaths(payload.paths);
        }
      })
      .then((u) => {
        if (active) unlisten = u;
        else u();
      });
    return () => {
      active = false;
      if (unlisten) unlisten();
    };
  }, [uploadPaths]);

  function navigate(path: string) {
    if (sftpId) load(sftpId, path);
  }

  async function onUpload() {
    if (!sftpId) return;
    const picked = await openDialog({ multiple: false, title: t("sftp.upload") });
    if (typeof picked !== "string") return;
    const base = picked.replace(/\\/g, "/").split("/").pop() || "upload";
    setError(null);
    const srcSize = await localSize(picked);
    const remoteHave = entries.find((e) => !e.is_dir && e.name === base)?.size ?? 0;
    const mode = await resolveResume(base, remoteHave, srcSize);
    if (mode === null) return; // cancelled
    if (mode === "skip") {
      setError(t("sftp.resume_complete", { name: base }));
      return;
    }
    const remoteDest = joinPath(cwd, base);
    const tid = startTransfer(base, "upload", remoteDest);
    try {
      await sftpUpload(sftpId, picked, remoteDest, tid, mode === "resume");
      refresh();
    } catch (e) {
      if (!isCancelled(e)) setError(String(e));
    } finally {
      endTransfer(tid);
    }
  }

  async function onMkdir() {
    if (!sftpId) return;
    const name = await askPrompt(t("sftp.new_folder_prompt"));
    if (!name || !name.trim()) return;
    setError(null);
    try {
      await sftpMkdir(sftpId, joinPath(cwd, name.trim()));
      refresh();
    } catch (e) {
      setError(String(e));
    }
  }

  async function onDownload(entry: SftpEntry) {
    if (!sftpId) return;
    const dest = await saveDialog({ defaultPath: entry.name });
    if (typeof dest !== "string") return;
    setError(null);
    const have = await localSize(dest);
    const mode = await resolveResume(entry.name, have, entry.size);
    if (mode === null) return; // cancelled
    if (mode === "skip") {
      setError(t("sftp.resume_complete", { name: entry.name }));
      return;
    }
    const tid = startTransfer(entry.name, "download", dest);
    try {
      await sftpDownload(
        sftpId,
        joinPath(cwd, entry.name),
        dest,
        tid,
        mode === "resume",
      );
    } catch (e) {
      if (!isCancelled(e)) setError(String(e));
    } finally {
      endTransfer(tid);
    }
  }

  // The remote entries the toolbar/menu operations should act on: the whole
  // selection if non-empty, otherwise just the cursor row.
  function remoteOpTargets(): SftpEntry[] {
    if (remoteSel.selected.size > 0) {
      return entries.filter((e) => remoteSel.selected.has(e.name));
    }
    const c = entries[remoteSel.cursor];
    return c ? [c] : [];
  }

  // Open the built-in viewer/editor for the remote cursor row (F3 view / F4
  // edit). No-op for a directory, ".." (cursor -1), or when no cursor is set —
  // the viewer is text-files-only.
  function openViewer(mode: "view" | "edit") {
    const c = entries[remoteSel.cursor];
    if (!c || c.is_dir) return;
    setViewer({ path: joinPath(cwd, c.name), name: c.name, mode });
  }

  // Toolbar download: 1 file → Save-As dialog; many → pick a folder, fan out.
  // Directories in the selection are skipped (no recursive download backend).
  async function onDownloadSelected() {
    if (!sftpId) return;
    const files = remoteOpTargets().filter((e) => !e.is_dir);
    if (files.length === 0) return;

    if (files.length === 1) {
      await onDownload(files[0]);
      return;
    }
    const dir = await openDialog({ directory: true, title: t("sftp.download") });
    if (typeof dir !== "string") return;
    setError(null);
    for (const f of files) {
      const dest = `${dir}/${f.name}`;
      const have = await localSize(dest);
      const mode = await resolveResume(f.name, have, f.size);
      if (mode === null) continue; // cancelled this file
      if (mode === "skip") {
        setError(t("sftp.resume_complete", { name: f.name }));
        continue;
      }
      const tid = startTransfer(f.name, "download", dest);
      try {
        await sftpDownload(sftpId, joinPath(cwd, f.name), dest, tid, mode === "resume");
      } catch (e) {
        endTransfer(tid);
        // Cancelling one file just skips it; a real error stops the batch.
        if (isCancelled(e)) continue;
        setError(`${f.name}: ${String(e)}`);
        break;
      }
      endTransfer(tid);
    }
  }

  // --- Dual-pane copy actions (reuse the streaming upload/download + bars) ---

  // The local entries to copy: selection if non-empty, else the cursor row.
  function localOpTargets(): LocalEntry[] {
    if (localSel.selected.size > 0) {
      return localEntries.filter((e) => localSel.selected.has(e.name));
    }
    const c = localEntries[localSel.cursor];
    return c ? [c] : [];
  }

  // Local → Remote: upload selected local files into the remote cwd.
  async function onCopyToRemote(explicit?: LocalEntry[]) {
    if (!sftpId) return;
    const targets = explicit ?? localOpTargets();
    const files = targets.filter((e) => !e.is_dir);
    const skippedDirs = targets.filter((e) => e.is_dir).map((d) => d.name);
    const failed: { name: string; msg: string }[] = [];
    setError(null);
    for (const f of files) {
      const remoteHave = entries.find((e) => !e.is_dir && e.name === f.name)?.size ?? 0;
      const mode = await resolveResume(f.name, remoteHave, f.size);
      if (mode === null) continue; // cancelled this file
      if (mode === "skip") {
        setError(t("sftp.resume_complete", { name: f.name }));
        continue;
      }
      const remoteDest = joinPath(cwd, f.name);
      const tid = startTransfer(f.name, "upload", remoteDest);
      try {
        await sftpUpload(
          sftpId,
          localJoin(localCwd, f.name),
          remoteDest,
          tid,
          mode === "resume",
        );
      } catch (e) {
        endTransfer(tid);
        // Cancelling one file just skips it silently; a real error is collected
        // and surfaced (don't abort the rest of the batch).
        if (isCancelled(e)) continue;
        failed.push({ name: f.name, msg: String(e) });
        continue;
      }
      endTransfer(tid);
    }
    const msg = buildTransferError(t, failed, skippedDirs);
    if (msg) setError(msg);
    refresh(); // refresh destination (remote) pane
  }

  // Remote → Local: download selected remote files into the local cwd.
  async function onCopyToLocal() {
    if (!sftpId || !localCwd) return;
    const targets = remoteOpTargets();
    const files = targets.filter((e) => !e.is_dir);
    const skippedDirs = targets.filter((e) => e.is_dir).map((d) => d.name);
    const failed: { name: string; msg: string }[] = [];
    setLocalError(null);
    for (const f of files) {
      const localHave = localEntries.find((e) => !e.is_dir && e.name === f.name)?.size ?? 0;
      const mode = await resolveResume(f.name, localHave, f.size);
      if (mode === null) continue; // cancelled this file
      if (mode === "skip") {
        setLocalError(t("sftp.resume_complete", { name: f.name }));
        continue;
      }
      const localDest = localJoin(localCwd, f.name);
      const tid = startTransfer(f.name, "download", localDest);
      try {
        await sftpDownload(
          sftpId,
          joinPath(cwd, f.name),
          localDest,
          tid,
          mode === "resume",
        );
      } catch (e) {
        endTransfer(tid);
        // Cancelling one file just skips it silently; a real error is collected
        // and surfaced (don't abort the rest of the batch).
        if (isCancelled(e)) continue;
        failed.push({ name: f.name, msg: String(e) });
        continue;
      }
      endTransfer(tid);
    }
    const msg = buildTransferError(t, failed, skippedDirs);
    if (msg) setLocalError(msg);
    refreshLocal(); // refresh destination (local) pane
  }

  // --- LOCAL pane write ops (mirror the remote ones; act on the local fs,
  // surface failures via localError, and reload the LOCAL pane afterwards). ---

  async function onLocalMkdir() {
    if (!localCwd) return;
    const name = await askPrompt(t("sftp.new_folder_prompt"));
    if (!name || !name.trim()) return;
    setLocalError(null);
    try {
      await localMkdir(localJoin(localCwd, name.trim()));
      refreshLocal();
    } catch (e) {
      setLocalError(String(e));
    }
  }

  async function onLocalRename(entry: LocalEntry) {
    if (!localCwd) return;
    const next = await askPrompt(t("sftp.rename_prompt"), {
      defaultValue: entry.name,
    });
    if (!next || !next.trim() || next === entry.name) return;
    setLocalError(null);
    try {
      await localRename(
        localJoin(localCwd, entry.name),
        localJoin(localCwd, next.trim()),
      );
      refreshLocal();
    } catch (e) {
      setLocalError(String(e));
    }
  }

  async function onLocalDeleteTargets(targets: LocalEntry[]) {
    if (!localCwd || targets.length === 0) return;
    const msg =
      targets.length === 1
        ? t("sftp.delete_confirm", { name: targets[0].name })
        : t("sftp.delete_confirm_n", { count: targets.length });
    if (!(await askConfirm(msg, { destructive: true }))) return;
    setLocalError(null);
    try {
      for (const e of targets) {
        await localDelete(localJoin(localCwd, e.name));
      }
      refreshLocal();
    } catch (e) {
      setLocalError(String(e));
    }
  }

  // Open the LOCAL cursor file in the OS default app (F3/F4 when the local pane
  // is active, or the local context menu). No-op for a directory / empty cursor.
  async function onLocalOpenExternal(entry?: LocalEntry) {
    const target = entry ?? localEntries[localSel.cursor];
    if (!target || target.is_dir) return;
    setLocalError(null);
    try {
      await openPath(localJoin(localCwd, target.name));
    } catch (e) {
      setLocalError(String(e));
    }
  }

  async function onRename(entry: SftpEntry) {
    if (!sftpId) return;
    const next = await askPrompt(t("sftp.rename_prompt"), {
      defaultValue: entry.name,
    });
    if (!next || !next.trim() || next === entry.name) return;
    setError(null);
    try {
      await sftpRename(sftpId, joinPath(cwd, entry.name), joinPath(cwd, next.trim()));
      refresh();
    } catch (e) {
      setError(String(e));
    }
  }

  // Delete one or many remote entries (selection-aware via `targets`).
  async function onDeleteTargets(targets: SftpEntry[]) {
    if (!sftpId || targets.length === 0) return;
    const msg =
      targets.length === 1
        ? t("sftp.delete_confirm", { name: targets[0].name })
        : t("sftp.delete_confirm_n", { count: targets.length });
    if (!(await askConfirm(msg, { destructive: true }))) return;
    setError(null);
    try {
      for (const e of targets) {
        await sftpRemove(sftpId, joinPath(cwd, e.name), e.is_dir);
      }
      refresh();
    } catch (e) {
      setError(String(e));
    }
  }

  // ── MC / Total-Commander function keys ────────────────────────────────────
  // Bound on a CAPTURE-phase window listener while the panel is mounted, so the
  // panel OWNS Tab/F1/F5–F8/Delete: preventDefault + stopPropagation stop them
  // reaching the WebView (F5 = page reload → would restart every terminal) and
  // the global app keydown handler. Arrows / Space / Insert / Enter / Backspace
  // are left to the focused FileList's own handler (Batch-1 behaviour).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // While collapsed the panel is hidden and the terminal is in use — it must
      // NOT own F1-F8/Tab/Delete. Bail out so those keys reach the terminal /
      // global app handler (Ctrl+Shift+S restore is handled in App.tsx).
      if (collapsed) return;
      // Don't hijack Tab/Delete while the user is typing in a field (a prompt /
      // chmod octal box). Function keys are still ours everywhere.
      const tgt = e.target as HTMLElement | null;
      const typing =
        tgt?.tagName === "INPUT" ||
        tgt?.tagName === "TEXTAREA" ||
        !!tgt?.isContentEditable;

      const consume = () => {
        e.preventDefault();
        e.stopPropagation();
      };

      // While the viewer/editor is open it owns all the keys (its own
      // capture-phase handler runs first and stops propagation); do nothing here
      // so F-keys can't double-act on the panel behind it.
      if (viewer) return;

      if (e.key === "F1") {
        consume();
        setHelpOpen((v) => !v);
        return;
      }

      // While the help overlay is up, only Esc / F1 matter (Esc handled in the
      // overlay). Swallow other function keys so they don't act behind it.
      if (helpOpen) {
        if (/^F[1-9]$|^F1[0-2]$/.test(e.key)) consume();
        return;
      }

      // Whether the LOCAL pane currently owns the keyboard (dual-pane only).
      const localActive = dualPane && activePane === "local";

      // F3 = view, F4 = edit. Remote pane → built-in viewer/editor. LOCAL pane →
      // open the cursor file in the OS default app (NEVER touch the remote side).
      if (e.key === "F3") {
        consume();
        if (localActive) onLocalOpenExternal();
        else openViewer("view");
        return;
      }
      if (e.key === "F4") {
        consume();
        if (localActive) onLocalOpenExternal();
        else openViewer("edit");
        return;
      }
      // F2 only acts inside the editor (handled by the viewer's own handler);
      // swallow it here so a stray F2 with the viewer closed does nothing.
      if (e.key === "F2") {
        consume();
        return;
      }

      if (e.key === "Tab" && !e.ctrlKey && !e.metaKey && !e.altKey && !typing) {
        // Switch the active pane (dual-pane only).
        if (dualPane) {
          consume();
          setActivePane((p) => (p === "local" ? "remote" : "local"));
        }
        return;
      }

      if (e.key === "F5") {
        consume();
        if (dualPane) {
          if (activePane === "local") onCopyToRemote();
          else onCopyToLocal();
        } else {
          onDownloadSelected();
        }
        return;
      }

      if (e.key === "F6") {
        // Rename the cursor entry on whichever pane is active.
        consume();
        if (localActive) {
          const lc = localEntries[localSel.cursor];
          if (lc) onLocalRename(lc);
        } else {
          const c = entries[remoteSel.cursor];
          if (c) onRename(c);
        }
        return;
      }

      if (e.key === "F7") {
        // New folder in the active pane's cwd.
        consume();
        if (localActive) onLocalMkdir();
        else onMkdir();
        return;
      }

      if (e.key === "F8" || (e.key === "Delete" && !typing)) {
        consume();
        if (localActive) {
          const targets = localOpTargets();
          if (targets.length > 0) onLocalDeleteTargets(targets);
        } else {
          const targets = remoteOpTargets();
          if (targets.length > 0) onDeleteTargets(targets);
        }
        return;
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [
    dualPane,
    activePane,
    helpOpen,
    entries,
    remoteSel,
    localEntries,
    localSel,
    localCwd,
    viewer,
    cwd,
    collapsed,
  ]);

  // Build the right-click menu. If the clicked row is part of the active
  // multi-selection, operations apply to the WHOLE selection; otherwise they
  // apply only to the clicked row.
  function rowMenu(entry: SftpEntry): MenuItem[] {
    const inSelection = remoteSel.selected.size > 0 && remoteSel.selected.has(entry.name);
    const targets = inSelection
      ? entries.filter((e) => remoteSel.selected.has(e.name))
      : [entry];
    const n = targets.length;
    const items: MenuItem[] = [];
    if (n === 1) {
      if (entry.is_dir) {
        items.push({
          label: t("sftp.open"),
          onClick: () => navigate(joinPath(cwd, entry.name)),
        });
      } else {
        items.push({ label: t("sftp.download"), onClick: () => onDownload(entry) });
      }
      items.push({ label: t("sftp.rename"), onClick: () => onRename(entry) });
    } else {
      items.push({
        label: t("sftp.download_n", { count: targets.filter((x) => !x.is_dir).length }),
        onClick: () => onDownloadSelected(),
      });
    }
    items.push({
      label: n === 1 ? t("sftp.chmod") : t("sftp.chmod_n", { count: n }),
      onClick: () => setChmodTargets(targets),
    });
    items.push({ separator: true, label: "" });
    items.push({
      label: n === 1 ? t("sftp.delete") : t("sftp.delete_n", { count: n }),
      onClick: () => onDeleteTargets(targets),
      destructive: true,
    });
    return items;
  }

  // Right-click menu for the LOCAL pane — local-only actions, selection-aware
  // exactly like rowMenu (a click inside a multi-selection acts on the whole
  // selection; otherwise on that row). Never touches the remote side.
  function localRowMenu(entry: LocalEntry): MenuItem[] {
    const inSelection =
      localSel.selected.size > 0 && localSel.selected.has(entry.name);
    const targets = inSelection
      ? localEntries.filter((e) => localSel.selected.has(e.name))
      : [entry];
    const n = targets.length;
    const items: MenuItem[] = [];
    if (n === 1) {
      if (entry.is_dir) {
        items.push({
          label: t("sftp.open"),
          onClick: () => navigateLocal(localJoin(localCwd, entry.name)),
        });
      } else {
        items.push({
          label: t("sftp.open_external"),
          onClick: () => onLocalOpenExternal(entry),
        });
      }
    }
    items.push({
      label:
        n === 1
          ? t("sftp.copy_to_remote")
          : t("sftp.copy_to_remote") + ` (${targets.filter((x) => !x.is_dir).length})`,
      onClick: () => onCopyToRemote(targets),
    });
    items.push({ label: t("sftp.new_folder"), onClick: () => onLocalMkdir() });
    if (n === 1) {
      items.push({ label: t("sftp.rename"), onClick: () => onLocalRename(entry) });
    }
    items.push({ separator: true, label: "" });
    items.push({
      label: n === 1 ? t("sftp.delete") : t("sftp.delete_n", { count: n }),
      onClick: () => onLocalDeleteTargets(targets),
      destructive: true,
    });
    return items;
  }

  const selectedBytes = entries
    .filter((e) => !e.is_dir && selected.has(e.name))
    .reduce((sum, e) => sum + e.size, 0);

  return (
    <>
    {/* Restore chip — floating, unobtrusive; shown only while collapsed. Lives
        OUTSIDE the hidden backdrop so it stays clickable; restores the panel. */}
    {collapsed && (
      <button
        onClick={() => onCollapse?.()}
        title={t("sftp.restore_chip")}
        aria-label={t("sftp.restore_chip")}
        // Sit ABOVE the 22px bottom StatusLine (utf-8 · ssh-2.0 · clock) with a
        // small gap, instead of overlapping it. The StatusLine reserves the
        // mobile safe-area via nx-safe-bottom, so add that inset too to clear it
        // on devices with a home-indicator. 22px bar + ~10px gap = 32px base.
        style={{
          bottom: "calc(32px + env(safe-area-inset-bottom, 0px))",
        }}
        className="fixed right-4 z-50 inline-flex items-center gap-2 px-3 py-2 rounded-nx border border-nx-border bg-nx-panel/95 backdrop-blur-sm shadow-glow-sm text-meta font-mono text-nx-soft hover:text-nx-text hover:bg-nx-elevated transition-colors"
      >
        <FolderOpen size={14} className="text-nx-accent2 shrink-0" />
        <span className="text-nx-accent">sftp</span>
        <span className="text-nx-muted truncate max-w-[14rem]">{title}</span>
      </button>
    )}
    <div
      className={
        "fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm " +
        // Collapsed: keep MOUNTED (state intact) but display:none so it paints
        // nothing AND its backdrop can't capture pointer events — the terminal
        // underneath stays fully interactive.
        (collapsed ? "hidden" : "")
      }
      aria-hidden={collapsed}
      {...backdropProps}
    >
      <div
        {...contentProps}
        ref={contentRef}
        className={
          "nx-modal-enter relative w-full h-[80vh] flex flex-col bg-nx-bg border border-nx-border rounded-nx shadow-glow-md overflow-hidden transition-[max-width] duration-200 " +
          (dualPane ? "max-w-7xl" : "max-w-5xl")
        }
      >
        {/* Drop-zone overlay — shown while OS files are dragged over the panel. */}
        {dragOver && sftpId && (
          <div className="absolute inset-0 z-[55] flex items-center justify-center bg-nx-bg/80 backdrop-blur-sm border-2 border-dashed border-nx-accent rounded-nx pointer-events-none">
            <div className="flex flex-col items-center gap-3 px-6 text-center">
              <Upload size={32} className="text-nx-accent" />
              <span className="font-mono text-body text-nx-soft max-w-md break-all">
                {t("sftp.drop_hint", { path: cwd })}
              </span>
            </div>
          </div>
        )}

        {/* Header */}
        <div className="flex items-center gap-2 px-4 py-3 border-b border-nx-divider shrink-0">
          <h2 className="text-lg font-mono text-nx-accent">&gt; sftp</h2>
          <span className="text-meta text-nx-muted font-mono truncate">{title}</span>
          <button
            onClick={() => setHelpOpen(true)}
            title={t("sftp.help")}
            className="ml-auto flex items-center gap-1.5 px-2 py-1 rounded-nx text-meta font-mono text-nx-muted hover:text-nx-accent hover:bg-nx-elevated transition-colors"
          >
            <HelpCircle size={14} />
            <span>{t("sftp.help_hint")}</span>
          </button>
          <IconButton
            className={dualPane ? "!text-nx-accent !bg-nx-elevated" : ""}
            icon={<Columns2 size={15} />}
            onClick={() => setDualPane((v) => !v)}
            title={t("sftp.dual_pane")}
          />
          {onCollapse && (
            <IconButton
              icon={<Minus size={15} />}
              onClick={onCollapse}
              title={t("sftp.collapse")}
              aria-label={t("sftp.collapse")}
            />
          )}
          <IconButton
            icon={<span className="text-base leading-none">×</span>}
            onClick={onClose}
            title={t("tabmenu.close")}
          />
        </div>

        {/* ── Single-pane (default) remote browser ── */}
        {!dualPane && (
        <>
        {/* Toolbar */}
        <div className="flex items-center gap-2 px-3.5 py-2.5 border-b border-nx-divider shrink-0">
          <IconButton
            icon={<ArrowUp size={14} />}
            onClick={() => navigate(parentPath(cwd))}
            disabled={!sftpId || cwd === "/"}
            title={t("sftp.up")}
          />
          <IconButton
            icon={<RefreshCw size={13} />}
            onClick={refresh}
            disabled={!sftpId}
            title={t("sftp.refresh")}
          />
          <span className="w-px h-4 bg-nx-border mx-1" />
          <Button
            variant="secondary"
            size="sm"
            leadingIcon={<Download size={12} />}
            onClick={onDownloadSelected}
            disabled={!sftpId || remoteOpTargets().filter((e) => !e.is_dir).length === 0}
          >
            {t("sftp.download")}
            {selected.size > 0 && (
              <span className="ml-1 text-nx-accent">{selected.size}</span>
            )}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            leadingIcon={<Upload size={12} />}
            onClick={onUpload}
            disabled={!sftpId}
          >
            {t("sftp.upload")}
          </Button>
          <IconButton
            icon={<FolderPlus size={14} />}
            onClick={onMkdir}
            disabled={!sftpId}
            title={t("sftp.new_folder")}
          />
          <div className="ml-3 min-w-0 flex-1">
            <Breadcrumb path={cwd} onNavigate={navigate} />
          </div>
          <div className="shrink-0 flex items-center gap-3 text-meta text-nx-muted">
            <span>
              <span className="text-nx-accent">{entries.length}</span> {t("sftp.items")}
            </span>
            {selected.size > 0 && (
              <span>
                <span className="text-nx-text">{selected.size}</span> {t("sftp.selected")}
                {" · "}
                <span className="text-nx-accent">{fmtSize(selectedBytes)}</span>
              </span>
            )}
          </div>
        </div>

        {/* Column header */}
        <div
          className="grid items-center px-3.5 py-1.5 text-micro uppercase tracking-[0.12em] text-nx-muted border-b border-nx-divider shrink-0"
          style={{ gridTemplateColumns: GRID, columnGap: 16 }}
        >
          <div />
          <div />
          <div>{t("sftp.col_name")}</div>
          <div className="text-right">{t("sftp.col_size")}</div>
          <div>{t("sftp.col_modified")}</div>
          <div>{t("sftp.col_perms")}</div>
          <div>{t("sftp.col_owner")}</div>
        </div>

        {/* Body */}
        <FileList
          rows={entries}
          sel={remoteSel}
          setSel={setRemoteSel}
          loading={loading}
          variant="full"
          active={!dualPane}
          atRoot={cwd === "/"}
          onOpenDir={(name) => navigate(joinPath(cwd, name))}
          onUp={() => navigate(parentPath(cwd))}
          onContextMenu={(ev, entry) =>
            setCtx({
              x: ev.clientX,
              y: ev.clientY,
              pane: "remote",
              entry: entry as SftpEntry,
            })
          }
          renderRow={(e) => {
            const sf = e as SftpEntry;
            return (
              <>
                <FileTypeIcon entry={sf} />
                <div className="flex items-center gap-1.5 min-w-0">
                  <span
                    className={
                      "truncate " +
                      (sf.is_dir || sf.is_symlink ? "text-nx-accent2" : "text-nx-text")
                    }
                  >
                    {sf.name}
                  </span>
                  <FileTypeChip entry={sf} />
                </div>
                <div className="text-right tabular-nums text-nx-dim">
                  {sf.is_dir ? "—" : fmtSize(sf.size)}
                </div>
                <div className="text-nx-dim tabular-nums">{fmtMtime(sf.mtime)}</div>
                <div className="tabular-nums text-nx-soft">{fmtPerms(sf.permissions)}</div>
                <div className="text-nx-muted truncate">
                  {sf.owner || (sf.uid ? String(sf.uid) : "")}
                </div>
              </>
            );
          }}
        />
        </>
        )}

        {/* ── Dual-pane (local ↔ remote) file manager ── */}
        {dualPane && (
          <div className="flex-1 min-h-0 flex">
            {/* LOCAL pane (left) */}
            <Pane
              title={t("sftp.local")}
              local
              titleIcon={<HardDrive size={13} className="text-nx-accent2" />}
              path={localCwd}
              loading={localLoading}
              active={activePane === "local"}
              onActivate={() => setActivePane("local")}
              upDisabled={!localCwd || localParent(localCwd) === localCwd}
              onUp={() => navigateLocal(localParent(localCwd))}
              onNavigate={navigateLocal}
              onRefresh={refreshLocal}
              count={localEntries.length}
              selectedCount={localSelected.size}
              extraActions={
                <>
                  {localDriveList.length > 1 && (
                    <DrivePicker
                      drives={localDriveList}
                      current={currentDrive}
                      onSelect={(d) => navigateLocal(d)}
                    />
                  )}
                  <IconButton
                    icon={<FolderPlus size={13} />}
                    onClick={onLocalMkdir}
                    disabled={!localCwd}
                    title={t("sftp.new_folder")}
                  />
                </>
              }
            >
              {localError && (
                <div className="px-3 py-1.5 text-meta font-mono text-nx-error border-b border-nx-divider break-words max-h-20 overflow-y-auto shrink-0 flex items-start gap-2">
                  <span className="flex-1 min-w-0">✗ {localError}</span>
                  <IconButton
                    icon={<X size={12} />}
                    onClick={() => setLocalError(null)}
                    title={t("sftp.help_close")}
                    className="shrink-0 !p-0.5"
                  />
                </div>
              )}
              <FileList
                rows={localEntries}
                sel={localSel}
                setSel={setLocalSel}
                loading={localLoading}
                variant="compact"
                active={activePane === "local"}
                atRoot={!localCwd || localParent(localCwd) === localCwd}
                onOpenDir={(name) => navigateLocal(localJoin(localCwd, name))}
                onUp={() => navigateLocal(localParent(localCwd))}
                onContextMenu={(ev, entry) =>
                  setCtx({
                    x: ev.clientX,
                    y: ev.clientY,
                    pane: "local",
                    entry: entry as LocalEntry,
                  })
                }
                renderRow={(e) => <CompactCells row={e} />}
              />
            </Pane>

            {/* Center copy controls */}
            <div className="shrink-0 w-12 flex flex-col items-center justify-center gap-3 border-x border-nx-divider bg-nx-panel/40">
              <IconButton
                icon={<ArrowRight size={16} />}
                onClick={() => onCopyToRemote()}
                disabled={!sftpId || localOpTargets().filter((e) => !e.is_dir).length === 0}
                className="!p-2"
                title={t("sftp.copy_to_remote")}
              />
              <IconButton
                icon={<ArrowLeft size={16} />}
                onClick={onCopyToLocal}
                disabled={
                  !sftpId || !localCwd || remoteOpTargets().filter((e) => !e.is_dir).length === 0
                }
                className="!p-2"
                title={t("sftp.copy_to_local")}
              />
            </div>

            {/* REMOTE pane (right) */}
            <Pane
              title={t("sftp.remote")}
              titleIcon={<Server size={13} className="text-nx-accent2" />}
              path={cwd}
              loading={loading}
              active={activePane === "remote"}
              onActivate={() => setActivePane("remote")}
              upDisabled={!sftpId || cwd === "/"}
              onUp={() => navigate(parentPath(cwd))}
              onNavigate={navigate}
              onRefresh={refresh}
              count={entries.length}
              selectedCount={selected.size}
              extraActions={
                <IconButton
                  icon={<FolderPlus size={13} />}
                  onClick={onMkdir}
                  disabled={!sftpId}
                  title={t("sftp.new_folder")}
                />
              }
            >
              <FileList
                rows={entries}
                sel={remoteSel}
                setSel={setRemoteSel}
                loading={loading}
                variant="compact"
                active={activePane === "remote"}
                atRoot={cwd === "/"}
                onOpenDir={(name) => navigate(joinPath(cwd, name))}
                onUp={() => navigate(parentPath(cwd))}
                onContextMenu={(ev, entry) =>
                  setCtx({
                    x: ev.clientX,
                    y: ev.clientY,
                    pane: "remote",
                    entry: entry as SftpEntry,
                  })
                }
                renderRow={(e) => <CompactCells row={e} />}
              />
            </Pane>
          </div>
        )}

        {/* Active transfers — one progress bar per in-flight transfer. */}
        {Object.values(transfers).length > 0 && (
          <div className="px-4 py-2 border-t border-nx-divider shrink-0 flex flex-col gap-2 max-h-32 overflow-y-auto">
            {Object.values(transfers).map((tr) => (
              <TransferBar key={tr.id} tr={tr} onCancel={cancelTransfer} />
            ))}
          </div>
        )}

        {/* Footer status — errors are shown prominently (full text, wrapped, with
            a dismiss button) so a real transfer failure is never truncated away. */}
        <div className="px-4 py-2 border-t border-nx-divider font-mono text-meta shrink-0 flex items-start gap-2">
          {error ? (
            <>
              <span className="text-nx-error break-words flex-1 min-w-0 max-h-20 overflow-y-auto">
                ✗ {error}
              </span>
              <IconButton
                icon={<X size={12} />}
                onClick={() => setError(null)}
                title={t("sftp.help_close")}
                className="shrink-0 !p-0.5"
              />
            </>
          ) : (
            <span className="text-nx-muted">
              {entries.length} {t("sftp.items")}
            </span>
          )}
        </div>
      </div>

      {helpOpen && <SftpHelpOverlay onClose={() => setHelpOpen(false)} />}

      {viewer && sftpId && (
        <FileViewer
          sftpId={sftpId}
          path={viewer.path}
          name={viewer.name}
          mode={viewer.mode}
          maxBytes={VIEWER_MAX_BYTES}
          onClose={() => setViewer(null)}
          onSaved={refresh}
        />
      )}

      {ctx && (
        <ContextMenu
          x={ctx.x}
          y={ctx.y}
          items={
            ctx.pane === "local"
              ? localRowMenu(ctx.entry as LocalEntry)
              : rowMenu(ctx.entry as SftpEntry)
          }
          onClose={() => setCtx(null)}
        />
      )}

      {chmodTargets && chmodTargets.length > 0 && sftpId && (
        <ChmodDialog
          entries={chmodTargets}
          onClose={() => setChmodTargets(null)}
          onApply={async (mode, recursive) => {
            setError(null);
            try {
              for (const e of chmodTargets) {
                const target = joinPath(cwd, e.name);
                // Recursive only makes sense for directories; files always use
                // the plain single chmod regardless of the checkbox.
                if (recursive && e.is_dir) {
                  await sftpChmodRecursive(sftpId, target, mode);
                } else {
                  await sftpChmod(sftpId, target, mode);
                }
              }
              setChmodTargets(null);
              refresh();
            } catch (e) {
              setError(String(e));
            }
          }}
        />
      )}
    </div>
    </>
  );
}

/** Middle-truncate a long path so both head and tail stay visible. */
function truncMiddle(s: string, max = 48): string {
  if (s.length <= max) return s;
  const keep = max - 1; // room for the ellipsis
  const head = Math.ceil(keep / 2);
  const tail = Math.floor(keep / 2);
  return s.slice(0, head) + "…" + s.slice(s.length - tail);
}

/** A single transfer's progress bar (download/upload) with file/dest labels and
 *  a cancel button. */
function TransferBar({
  tr,
  onCancel,
}: {
  tr: Transfer;
  onCancel: (id: string) => void;
}) {
  const { t } = useTranslation();
  const pct = tr.total > 0 ? Math.min(100, (tr.transferred / tr.total) * 100) : 0;
  const indeterminate = tr.total === 0;
  const dirLabel =
    tr.phase === "upload" ? t("sftp.tr_uploading") : t("sftp.tr_downloading");
  return (
    <div className="font-mono text-meta">
      <div className="flex items-center gap-2 mb-1">
        {tr.phase === "upload" ? (
          <Upload size={11} className="text-nx-accent shrink-0" />
        ) : (
          <Download size={11} className="text-nx-accent shrink-0" />
        )}
        <span className="text-nx-soft truncate min-w-0">{tr.name}</span>
        {/* Direction + destination — survives panel close/reopen so the user
            can always tell what's transferring and where. */}
        <span
          className="text-nx-muted truncate min-w-0 flex-1"
          title={`${dirLabel} → ${tr.dest}`}
        >
          <span className="text-nx-dim">{dirLabel}</span>{" "}
          <span className="text-nx-accent2">{tr.phase === "upload" ? "↑" : "↓"}</span>{" "}
          {truncMiddle(tr.dest)}
        </span>
        <span className="text-nx-muted tabular-nums shrink-0">
          {fmtSize(tr.transferred)}
          {tr.total > 0 ? ` / ${fmtSize(tr.total)}` : ""}
          {!indeterminate && (
            <span className="text-nx-accent ml-1.5">{Math.round(pct)}%</span>
          )}
        </span>
        {tr.cancelling ? (
          <span className="text-nx-warning shrink-0 text-micro">
            {t("sftp.tr_cancelling")}
          </span>
        ) : (
          <IconButton
            icon={<X size={11} />}
            onClick={() => onCancel(tr.id)}
            title={t("sftp.tr_cancel")}
            className="shrink-0 !p-0.5"
          />
        )}
      </div>
      <div className="h-1.5 rounded-full bg-nx-elevated overflow-hidden">
        <div
          className={
            "h-full rounded-full transition-[width] duration-150 " +
            (tr.cancelling ? "bg-nx-warning " : "bg-nx-accent ") +
            (indeterminate ? "animate-pulse w-1/3" : "")
          }
          style={indeterminate ? undefined : { width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

// ── File list with MC/TC cursor + multi-selection + keyboard ────────────────
// Shared by the single remote pane (variant="full") and both dual-pane columns
// (variant="compact"). Owns no state of its own — the cursor/selection live in
// the parent (so operations can read them). The list is keyboard-focusable; its
// handlers preventDefault + stopPropagation so Arrow/Space/Insert/Enter never
// leak to the global app hotkeys, leaving room for a later F5/F6 batch.

function FileList({
  rows,
  sel,
  setSel,
  loading,
  variant,
  atRoot,
  onOpenDir,
  onUp,
  onContextMenu,
  renderRow,
  active,
}: {
  rows: Row[];
  sel: PaneSel;
  setSel: (updater: (prev: PaneSel) => PaneSel) => void;
  loading: boolean;
  variant: "full" | "compact";
  atRoot: boolean;
  onOpenDir: (name: string) => void;
  onUp: () => void;
  onContextMenu?: (ev: React.MouseEvent, entry: Row) => void;
  renderRow: (entry: Row) => React.ReactNode;
  /** When this pane becomes the active one (Tab / click), grab DOM focus so its
   *  own Arrow/Space/Enter/Backspace handler receives the keys. Undefined in
   *  single-pane mode (always-focusable; no Tab switching). */
  active?: boolean;
}) {
  const { t } = useTranslation();
  const grid = variant === "full" ? GRID : PANE_GRID;
  const gap = variant === "full" ? 16 : 12;
  const pad = variant === "full" ? "px-3.5" : "px-3";
  const scrollRef = useRef<HTMLDivElement>(null);
  // Keep keyboard focus on the active pane. Re-run not just when this pane
  // becomes active but whenever its listing changes (navigation incl. Backspace
  // / "..", mkdir, delete, rename, refresh, copy completion) — those re-render
  // the list and would otherwise drop DOM focus, freezing the arrow keys until
  // a Tab round-trip. `rows` identity changes on every reload, so it's the key.
  useEffect(() => {
    if (active && scrollRef.current && !scrollRef.current.contains(document.activeElement)) {
      scrollRef.current.focus({ preventScroll: true });
    }
  }, [active, rows, loading]);

  // Keep the cursor row visible: whenever the cursor moves (Arrow/Home/End/
  // PageUp-Down/Space-advance, or landing on ".."), scroll that row into view
  // within the scroll container. block:"nearest" only nudges when the row is
  // out of view, so it doesn't fight the user's own mouse-wheel scrolling and
  // stays jank-free. Gated on `active` so a background pane never grabs scroll.
  useEffect(() => {
    if (!active || loading) return;
    const container = scrollRef.current;
    if (!container) return;
    const el = container.querySelector<HTMLElement>("[data-cursor]");
    el?.scrollIntoView({ block: "nearest" });
  }, [active, loading, sel.cursor, rows]);

  // --- Mouse selection on a row ---
  function clickRow(idx: number, ev: React.MouseEvent) {
    if (ev.shiftKey) {
      // Range from anchor (or cursor) to here.
      setSel((prev) => {
        const from = prev.anchor >= 0 ? prev.anchor : prev.cursor >= 0 ? prev.cursor : idx;
        return { cursor: idx, selected: new Set(rangeNames(rows, from, idx)), anchor: from };
      });
    } else {
      // Plain click === checkbox click (and === Ctrl/Cmd+click): TOGGLE this row's
      // membership, MC-style — other selections are preserved. Cursor follows.
      setSel((prev) => {
        const next = new Set(prev.selected);
        const name = rows[idx].name;
        if (next.has(name)) next.delete(name);
        else next.add(name);
        return { cursor: idx, selected: next, anchor: idx };
      });
    }
  }

  function toggleRow(idx: number) {
    setSel((prev) => {
      const next = new Set(prev.selected);
      const name = rows[idx].name;
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return { ...prev, cursor: idx, selected: next, anchor: idx };
    });
  }

  function openRow(idx: number) {
    const e = rows[idx];
    if (!e) return;
    if (e.is_dir) onOpenDir(e.name);
    // Files: no-op for now (preview later).
  }

  // --- Keyboard (pane focused) ---
  function onKeyDown(ev: React.KeyboardEvent) {
    const k = ev.key;
    const len = rows.length;
    const cur = sel.cursor;

    const consume = () => {
      ev.preventDefault();
      ev.stopPropagation();
    };

    // The ".." parent row is cursor index -1 (only when not at root). It's
    // cursorable but never selectable: Space/Insert no-op on it, it never enters
    // `selected`, and Enter on it navigates up.
    const minCursor = atRoot ? 0 : -1;

    if (k === "ArrowDown" || k === "ArrowUp") {
      consume();
      if (len === 0 && atRoot) return;
      const dir = k === "ArrowDown" ? 1 : -1;
      const base = cur < minCursor ? minCursor : cur;
      const nextIdx = Math.max(minCursor, Math.min(len - 1, base + dir));
      if (ev.shiftKey) {
        // Range select can't include the non-selectable "..": clamp anchor/cursor
        // to real rows for the range computation.
        setSel((prev) => {
          const c = Math.max(0, nextIdx);
          const anchor = prev.anchor >= 0 ? prev.anchor : prev.cursor >= 0 ? prev.cursor : c;
          return {
            cursor: nextIdx,
            selected: nextIdx < 0 ? prev.selected : new Set(rangeNames(rows, anchor, c)),
            anchor,
          };
        });
      } else {
        setSel((prev) => ({ ...prev, cursor: nextIdx, anchor: nextIdx }));
      }
    } else if (k === "Home") {
      consume();
      setSel((prev) => ({ ...prev, cursor: minCursor, anchor: minCursor }));
    } else if (k === "End") {
      consume();
      if (len > 0) setSel((prev) => ({ ...prev, cursor: len - 1, anchor: len - 1 }));
    } else if (k === " " || k === "Insert") {
      // MC/TC: toggle the cursor row + advance the cursor down. No-op on "..".
      consume();
      if (cur >= 0 && cur < len) {
        const advance = Math.min(len - 1, cur + 1);
        setSel((prev) => {
          const next = new Set(prev.selected);
          const name = rows[cur].name;
          if (next.has(name)) next.delete(name);
          else next.add(name);
          return { cursor: advance, selected: next, anchor: advance };
        });
      }
    } else if (k === "Enter") {
      consume();
      // Enter on ".." (cursor -1) goes up; on a real row opens it.
      if (cur === -1 && !atRoot) onUp();
      else if (cur >= 0 && cur < len) openRow(cur);
    } else if (k === "Backspace") {
      consume();
      if (!atRoot) onUp();
    }
  }

  if (loading) {
    return (
      <div className="flex-1 min-h-0 overflow-y-auto">
        <div className="flex items-center justify-center h-full text-nx-muted font-mono text-body gap-2">
          <Loader2 size={16} className="animate-spin" /> {t("sftp.loading")}
        </div>
      </div>
    );
  }

  return (
    <div
      ref={scrollRef}
      className="flex-1 min-h-0 overflow-y-auto outline-none relative"
      tabIndex={0}
      data-sftp-list=""
      data-sftp-active={active ? "1" : "0"}
      onKeyDown={onKeyDown}
    >
      {/* ".." parent row — always first; cursorable (cursor index -1) but never
          selectable; navigates up on click / Enter. */}
      {!atRoot && (
        <div
          data-cursor={sel.cursor === -1 || undefined}
          onDoubleClick={onUp}
          onClick={() => setSel((prev) => ({ ...prev, cursor: -1, anchor: -1 }))}
          className={
            "nx-row grid items-center py-1.5 cursor-pointer text-body select-none text-nx-muted " +
            pad +
            (sel.cursor === -1 ? " ring-1 ring-inset ring-nx-accent/70 bg-nx-elevated/40" : "")
          }
          style={{ gridTemplateColumns: grid, columnGap: gap }}
        >
          <div />
          <CornerLeftUp size={14} className="text-nx-muted" />
          <div className="flex items-center gap-1.5 min-w-0">
            <span className="truncate text-nx-soft">..</span>
          </div>
        </div>
      )}

      {rows.length === 0 ? (
        <div className="flex items-center justify-center h-full text-nx-muted font-mono text-body">
          {t("sftp.empty")}
        </div>
      ) : (
        rows.map((e, idx) => {
          const isSelected = sel.selected.has(e.name);
          const isCursor = sel.cursor === idx;
          return (
            <div
              key={e.name}
              data-active={isSelected || undefined}
              data-cursor={isCursor || undefined}
              onClick={(ev) => clickRow(idx, ev)}
              onDoubleClick={() => openRow(idx)}
              onContextMenu={
                onContextMenu
                  ? (ev) => {
                      ev.preventDefault();
                      // Right-click outside the selection re-selects the row so
                      // the menu acts on it (selection-aware menus check this).
                      if (!sel.selected.has(e.name)) {
                        setSel(() => ({
                          cursor: idx,
                          selected: new Set([e.name]),
                          anchor: idx,
                        }));
                      } else {
                        setSel((prev) => ({ ...prev, cursor: idx }));
                      }
                      onContextMenu(ev, e);
                    }
                  : undefined
              }
              className={
                "nx-row grid items-center py-1.5 cursor-pointer text-body select-none " +
                pad +
                (isCursor ? " ring-1 ring-inset ring-nx-accent/70 bg-nx-elevated/40" : "")
              }
              style={{ gridTemplateColumns: grid, columnGap: gap }}
            >
              <div onClick={(ev) => ev.stopPropagation()}>
                <Checkbox checked={isSelected} onChange={() => toggleRow(idx)} />
              </div>
              {renderRow(e)}
            </div>
          );
        })
      )}
    </div>
  );
}

/** Compact pane cells (icon · name · size) — used by both dual-pane columns. */
function CompactCells({ row }: { row: Row }) {
  return (
    <>
      {row.is_dir ? (
        <Folder
          size={14}
          className="text-nx-accent2"
          style={{ fill: "var(--nx-accent2)", fillOpacity: 0.25, strokeWidth: 1.5 }}
        />
      ) : row.is_symlink ? (
        <Link2 size={14} className="text-nx-soft" />
      ) : isKeyfile(row.name) ? (
        <KeyRound size={14} className="text-nx-warning" />
      ) : (
        <FileIcon size={14} className="text-nx-muted" />
      )}
      <div className="flex items-center gap-1.5 min-w-0">
        <span
          className={
            "truncate " + (row.is_dir || row.is_symlink ? "text-nx-accent2" : "text-nx-text")
          }
        >
          {row.name}
        </span>
      </div>
      <div className="text-right tabular-nums text-nx-dim">
        {row.is_dir ? "—" : fmtSize(row.size)}
      </div>
    </>
  );
}

// ── Dual-pane primitives ─────────────────────────────────────────────────
// A pane is a self-contained column: header (icon + label + up/refresh +
// counts), a clickable breadcrumb path bar, a fixed column header, then the
// body (the FileList supplied by the caller). Local and remote panes share this
// chrome so the two sides look identical apart from their content.

function Pane({
  title,
  titleIcon,
  path,
  upDisabled,
  onUp,
  onNavigate,
  onRefresh,
  loading,
  count,
  selectedCount,
  active,
  onActivate,
  extraActions,
  local,
  children,
}: {
  title: string;
  titleIcon: React.ReactNode;
  path: string;
  upDisabled: boolean;
  onUp: () => void;
  onNavigate: (p: string) => void;
  onRefresh: () => void;
  loading: boolean;
  count: number;
  selectedCount: number;
  active?: boolean;
  onActivate?: () => void;
  extraActions?: React.ReactNode;
  /** This is the LOCAL pane → breadcrumb uses platform-aware path joining. */
  local?: boolean;
  children: React.ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <div
      className={
        "flex-1 min-w-0 flex flex-col transition-colors " +
        (active ? "bg-nx-elevated/15" : "")
      }
      onMouseDown={onActivate}
    >
      {/* Pane header */}
      <div
        className={
          "flex items-center gap-2 px-3 py-2 border-b shrink-0 " +
          (active ? "border-nx-accent/60 bg-nx-elevated/30" : "border-nx-divider")
        }
      >
        {titleIcon}
        <span
          className={
            "text-meta font-mono uppercase tracking-wider " +
            (active ? "text-nx-accent" : "text-nx-soft")
          }
        >
          {title}
        </span>
        <span className="ml-auto flex items-center gap-1">
          <IconButton
            icon={<ArrowUp size={13} />}
            onClick={onUp}
            disabled={upDisabled}
            title={t("sftp.up")}
          />
          <IconButton
            icon={<RefreshCw size={12} />}
            onClick={onRefresh}
            disabled={loading}
            title={t("sftp.refresh")}
          />
          {extraActions}
        </span>
      </div>

      {/* Path bar — clickable breadcrumb */}
      <div className="px-3 py-1.5 border-b border-nx-divider shrink-0 min-w-0">
        {path ? (
          <Breadcrumb path={path} onNavigate={onNavigate} compact local={local} />
        ) : (
          <div className="px-2.5 py-1 rounded-nx border border-nx-border bg-nx-panel text-meta font-mono text-nx-soft truncate">
            —
          </div>
        )}
      </div>

      {/* Column header */}
      <div
        className="grid items-center px-3 py-1 text-micro uppercase tracking-[0.12em] text-nx-muted border-b border-nx-divider shrink-0"
        style={{ gridTemplateColumns: PANE_GRID, columnGap: 12 }}
      >
        <div />
        <div />
        <div>{t("sftp.col_name")}</div>
        <div className="text-right">{t("sftp.col_size")}</div>
      </div>

      {/* Body (FileList) */}
      {children}

      {/* Pane footer */}
      <div className="px-3 py-1.5 border-t border-nx-divider shrink-0 flex items-center gap-3 text-meta font-mono text-nx-muted">
        <span>
          <span className="text-nx-accent">{count}</span> {t("sftp.items")}
        </span>
        {selectedCount > 0 && (
          <span>
            <span className="text-nx-text">{selectedCount}</span> {t("sftp.selected")}
          </span>
        )}
      </div>
    </div>
  );
}

/** Drive-root selector for the local pane (Windows). A compact row of buttons,
 *  one per drive root; the active drive is highlighted. Shown only when the
 *  backend reports more than one root, so Linux/mac never see it. */
function DrivePicker({
  drives,
  current,
  onSelect,
}: {
  drives: string[];
  current: string | null;
  onSelect: (drive: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <span className="flex items-center gap-1" title={t("sftp.drive")}>
      <HardDrive size={12} className="text-nx-muted shrink-0" />
      {drives.map((d) => {
        const label = d.slice(0, 2); // "C:" from "C:\"
        const isActive = current === d;
        return (
          <button
            key={d}
            onClick={() => onSelect(d)}
            className={
              "px-1.5 py-0.5 rounded-nx-sm border text-micro font-mono uppercase " +
              (isActive
                ? "border-nx-accent text-nx-accent bg-nx-elevated"
                : "border-nx-border text-nx-soft hover:text-nx-text hover:border-nx-soft")
            }
          >
            {label}
          </button>
        );
      })}
    </span>
  );
}

/** SFTP hotkey cheat-sheet (F1). Dismiss on Esc / backdrop click. */
function SftpHelpOverlay({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const { backdropProps, contentProps } = useBackdropClose(onClose);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" || e.key === "F1") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  const rows: { keys: string; desc: string }[] = [
    // Function keys — contiguous F1…F8.
    { keys: "F1", desc: t("sftp.hk_help") },
    { keys: "F2", desc: t("sftp.hk_save") },
    { keys: "F3", desc: t("sftp.hk_view") },
    { keys: "F4", desc: t("sftp.hk_edit") },
    { keys: "F5", desc: t("sftp.hk_copy") },
    { keys: "F6", desc: t("sftp.hk_rename") },
    { keys: "F7", desc: t("sftp.hk_mkdir") },
    { keys: "F8 / Del", desc: t("sftp.hk_delete") },
    // Navigation & other keys.
    { keys: "Tab", desc: t("sftp.hk_switch_pane") },
    { keys: "↑ ↓ Home End", desc: t("sftp.hk_arrows") },
    { keys: "Space / Ins", desc: t("sftp.hk_select") },
    { keys: "Enter", desc: t("sftp.hk_open") },
    { keys: "Backspace", desc: t("sftp.hk_up") },
    { keys: "2×Click", desc: t("sftp.hk_dblclick") },
  ];

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-sm"
      {...backdropProps}
    >
      <div
        {...contentProps}
        className="nx-modal-enter w-full max-w-sm flex flex-col bg-nx-bg border border-nx-border rounded-nx shadow-glow-md overflow-hidden"
      >
        <div className="flex items-center gap-2 px-4 py-3 border-b border-nx-divider">
          <span className="text-nx-accent font-mono">&gt;</span>
          <h2 className="text-base font-mono text-nx-text">{t("sftp.help_title")}</h2>
          <IconButton
            className="ml-auto"
            icon={<X size={14} />}
            onClick={onClose}
            title={t("sftp.help_close")}
          />
        </div>
        <ul className="px-4 py-3 space-y-1.5 font-mono">
          {rows.map((r, i) => (
            <li
              key={i}
              className="grid grid-cols-[120px_1fr] gap-3 items-center text-meta"
            >
              <span className="flex flex-wrap items-center gap-1">
                {r.keys.split(" ").map((k, j) => (
                  <kbd
                    key={j}
                    className="px-1.5 py-0.5 border border-nx-border rounded-nx-sm bg-nx-panel text-nx-accent text-micro"
                  >
                    {k}
                  </kbd>
                ))}
              </span>
              <span className="text-nx-text">{r.desc}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/** Octal-permission editor: 3×3 rwx grid kept in sync with an octal field. */
function ChmodDialog({
  entries,
  onClose,
  onApply,
}: {
  entries: SftpEntry[];
  onClose: () => void;
  onApply: (mode: number, recursive: boolean) => Promise<void> | void;
}) {
  const { t } = useTranslation();
  const { backdropProps, contentProps } = useBackdropClose(onClose);
  const single = entries.length === 1 ? entries[0] : null;
  const [mode, setMode] = useState<number>((single ? single.permissions : 0) & 0o777);
  // Recursive option is only meaningful when at least one target is a directory.
  const anyDir = entries.some((e) => e.is_dir);
  const [recursive, setRecursive] = useState(false);
  // Busy while a (possibly long) recursive chmod runs — disables the controls
  // and shows a working indicator.
  const [busy, setBusy] = useState(false);

  const octal = mode.toString(8).padStart(3, "0");
  const bit = (group: number, perm: number) => (mode >> (group * 3)) & perm;
  const toggle = (group: number, perm: number) => {
    setMode((m) => m ^ (perm << (group * 3)));
  };
  const onOctalChange = (v: string) => {
    const cleaned = v.replace(/[^0-7]/g, "").slice(0, 3);
    if (cleaned === "") {
      setMode(0);
      return;
    }
    setMode(parseInt(cleaned, 8) & 0o777);
  };

  // group index: 2 = owner, 1 = group, 0 = other (matches octal digit order)
  const groups: { idx: number; label: string }[] = [
    { idx: 2, label: t("sftp.chmod_owner") },
    { idx: 1, label: t("sftp.chmod_group") },
    { idx: 0, label: t("sftp.chmod_other") },
  ];
  const perms: { bit: number; label: string }[] = [
    { bit: 4, label: t("sftp.chmod_read") },
    { bit: 2, label: t("sftp.chmod_write") },
    { bit: 1, label: t("sftp.chmod_exec") },
  ];

  const subtitle = single ? single.name : t("sftp.chmod_n", { count: entries.length });

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-sm"
      {...backdropProps}
    >
      <div
        {...contentProps}
        className="nx-modal-enter w-full max-w-sm flex flex-col bg-nx-bg border border-nx-border rounded-nx shadow-glow-md overflow-hidden"
      >
        <div className="flex items-center gap-2 px-4 py-3 border-b border-nx-divider">
          <h2 className="text-base font-mono text-nx-accent">{t("sftp.chmod_title")}</h2>
          <span className="text-meta text-nx-muted font-mono truncate">{subtitle}</span>
          <IconButton
            className="ml-auto"
            icon={<X size={14} />}
            onClick={onClose}
            title={t("sftp.cancel")}
          />
        </div>

        <div className="px-4 py-4 flex flex-col gap-4">
          {/* rwx grid */}
          <div
            className="grid items-center gap-x-3 gap-y-2 text-meta font-mono"
            style={{ gridTemplateColumns: "70px 1fr 1fr 1fr" }}
          >
            <div />
            {perms.map((p) => (
              <div key={p.bit} className="text-center text-nx-muted uppercase tracking-wider text-micro">
                {p.label}
              </div>
            ))}
            {groups.map((g) => (
              <Fragment key={g.idx}>
                <div className="text-nx-soft">{g.label}</div>
                {perms.map((p) => (
                  <div key={p.bit} className="flex justify-center">
                    <Checkbox
                      checked={bit(g.idx, p.bit) !== 0}
                      onChange={() => toggle(g.idx, p.bit)}
                    />
                  </div>
                ))}
              </Fragment>
            ))}
          </div>

          {/* octal field */}
          <div className="flex items-center gap-2">
            <span className="text-meta font-mono text-nx-muted">{t("sftp.chmod_octal")}</span>
            <Input
              value={octal}
              onChange={(v) => onOctalChange(v)}
              className="w-20 tabular-nums text-center"
            />
          </div>

          {/* Recursive option — only when a directory is among the targets. */}
          {anyDir && (
            <label className="flex items-center gap-2 text-meta font-mono text-nx-soft cursor-pointer">
              <Checkbox checked={recursive} onChange={() => setRecursive((v) => !v)} />
              <span>{t("sftp.chmod_recursive")}</span>
            </label>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-nx-divider">
          {busy && (
            <span className="mr-auto flex items-center gap-1.5 text-meta font-mono text-nx-muted">
              <Loader2 size={13} className="animate-spin" /> {t("sftp.chmod_applying")}
            </span>
          )}
          <Button variant="secondary" size="sm" onClick={onClose} disabled={busy}>
            {t("sftp.cancel")}
          </Button>
          <Button
            variant="primary"
            size="sm"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onApply(mode, recursive && anyDir);
              } finally {
                setBusy(false);
              }
            }}
          >
            {t("sftp.apply")}
          </Button>
        </div>
      </div>
    </div>
  );
}
