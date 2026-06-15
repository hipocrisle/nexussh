// SFTPPanel — remote file browser over SFTP. Opened per-host from the
// sidebar context menu. Single remote pane; local side via OS file dialogs
// for up/download (model A: separate SFTP connection, decoupled from the
// interactive shell session).

import { useState, useEffect, useCallback, useRef, Fragment } from "react";
import { useTranslation } from "react-i18next";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
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
  sftpDisconnect,
  onSftpProgress,
} from "./sftp";
import { ContextMenu, MenuItem } from "./ContextMenu";
import { useBackdropClose } from "./useBackdropClose";
import { Button, IconButton, Checkbox, Input } from "./components/primitives";
import { askPrompt, askConfirm } from "./dialogs";

interface Props {
  connectArgs: ConnectArgs;
  title: string;
  onClose: () => void;
}

/** A streaming transfer with live progress (total === 0 ⇒ unknown size). */
interface Transfer {
  id: string;
  name: string;
  phase: "download" | "upload";
  transferred: number;
  total: number;
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

function parentPath(p: string): string {
  if (p === "/" || p === "") return "/";
  const trimmed = p.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  return idx <= 0 ? "/" : trimmed.slice(0, idx);
}

function isKeyfile(name: string): boolean {
  return (
    /^(id_rsa|id_ed25519|id_ecdsa|id_dsa)(\.pub)?$/.test(name) ||
    name.endsWith(".pem")
  );
}

const CODE_EXT = ["YML", "YAML", "JSON", "TS", "JS", "SH", "PY", "MD", "CONF", "TOML"];

const GRID = "28px 22px 1fr 110px 160px 130px 110px";

function FileTypeIcon({ entry }: { entry: SftpEntry }) {
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

function FileTypeChip({ entry }: { entry: SftpEntry }) {
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

function Breadcrumb({
  path,
  onNavigate,
}: {
  path: string;
  onNavigate: (p: string) => void;
}) {
  const segments = path.split("/").filter(Boolean);
  return (
    <div className="flex items-center gap-1.5 px-3 py-1 rounded-nx border border-nx-border bg-nx-panel text-body min-w-0 overflow-x-auto">
      <button onClick={() => onNavigate("/")} className="text-nx-muted hover:text-nx-soft">
        /
      </button>
      {segments.map((seg, i) => {
        const isLast = i === segments.length - 1;
        const subPath = "/" + segments.slice(0, i + 1).join("/");
        return (
          <span key={i} className="flex items-center gap-1.5 shrink-0">
            <button
              onClick={() => onNavigate(subPath)}
              className={isLast ? "text-nx-text" : "text-nx-soft hover:underline"}
            >
              {seg}
            </button>
            {!isLast && <span className="text-nx-accent">/</span>}
          </span>
        );
      })}
    </div>
  );
}

export function SFTPPanel({ connectArgs, title, onClose }: Props) {
  const { t } = useTranslation();
  const [sftpId, setSftpId] = useState<string | null>(null);
  const [cwd, setCwd] = useState("/");
  const [entries, setEntries] = useState<SftpEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [ctx, setCtx] = useState<{ x: number; y: number; entry: SftpEntry } | null>(
    null,
  );
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Active transfers keyed by transferId → live progress for the bar.
  const [transfers, setTransfers] = useState<Record<string, Transfer>>({});
  const [chmodTarget, setChmodTarget] = useState<SftpEntry | null>(null);
  const { backdropProps, contentProps } = useBackdropClose(onClose);
  const idRef = useRef<string | null>(null);

  // Listen for streaming progress events; drop a transfer shortly after it
  // reaches 100% so the bar lingers briefly then clears.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    onSftpProgress((p: SftpProgress) => {
      setTransfers((prev) => ({
        ...prev,
        [p.id]: {
          ...(prev[p.id] ?? { name: prev[p.id]?.name ?? "" }),
          ...p,
        },
      }));
      if (p.total > 0 && p.transferred >= p.total) {
        setTimeout(() => {
          setTransfers((prev) => {
            const next = { ...prev };
            delete next[p.id];
            return next;
          });
        }, 800);
      }
    }).then((u) => {
      unlisten = u;
    });
    return () => {
      if (unlisten) unlisten();
    };
  }, []);

  // Register a transfer (so its name shows before the first progress event),
  // returning the generated id to hand to the backend.
  const startTransfer = useCallback((name: string, phase: Transfer["phase"]) => {
    const id = crypto.randomUUID();
    setTransfers((prev) => ({
      ...prev,
      [id]: { id, name, phase, transferred: 0, total: 0 },
    }));
    return id;
  }, []);

  const endTransfer = useCallback((id: string) => {
    setTransfers((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }, []);

  const load = useCallback(async (id: string, path: string) => {
    setLoading(true);
    setError(null);
    try {
      const list = await sftpList(id, path);
      setEntries(list);
      setCwd(path);
      setSelected(new Set());
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
        await load(id, home || "/");
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

  function navigate(path: string) {
    if (sftpId) load(sftpId, path);
  }

  async function onUpload() {
    if (!sftpId) return;
    const picked = await openDialog({ multiple: false, title: t("sftp.upload") });
    if (typeof picked !== "string") return;
    const base = picked.replace(/\\/g, "/").split("/").pop() || "upload";
    setError(null);
    const tid = startTransfer(base, "upload");
    try {
      await sftpUpload(sftpId, picked, joinPath(cwd, base), tid);
      refresh();
    } catch (e) {
      setError(String(e));
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
    const tid = startTransfer(entry.name, "download");
    try {
      await sftpDownload(sftpId, joinPath(cwd, entry.name), dest, tid);
    } catch (e) {
      setError(String(e));
    } finally {
      endTransfer(tid);
    }
  }

  function toggleSelect(name: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  // Toolbar download: 1 file → Save-As dialog; many → pick a folder, fan out.
  async function onDownloadSelected() {
    if (!sftpId || selected.size === 0) return;
    const names = entries
      .filter((e) => !e.is_dir && selected.has(e.name))
      .map((e) => e.name);
    if (names.length === 0) return;

    if (names.length === 1) {
      const e = entries.find((x) => x.name === names[0])!;
      await onDownload(e);
      return;
    }
    const dir = await openDialog({ directory: true, title: t("sftp.download") });
    if (typeof dir !== "string") return;
    setError(null);
    for (const name of names) {
      const tid = startTransfer(name, "download");
      try {
        await sftpDownload(sftpId, joinPath(cwd, name), `${dir}/${name}`, tid);
      } catch (e) {
        setError(`${name}: ${String(e)}`);
        endTransfer(tid);
        break;
      }
      endTransfer(tid);
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

  async function onDelete(entry: SftpEntry) {
    if (!sftpId) return;
    if (!(await askConfirm(t("sftp.delete_confirm", { name: entry.name }), { destructive: true }))) return;
    setError(null);
    try {
      await sftpRemove(sftpId, joinPath(cwd, entry.name), entry.is_dir);
      refresh();
    } catch (e) {
      setError(String(e));
    }
  }

  function rowMenu(entry: SftpEntry): MenuItem[] {
    const items: MenuItem[] = [];
    if (entry.is_dir) {
      items.push({
        label: t("sftp.open"),
        onClick: () => navigate(joinPath(cwd, entry.name)),
      });
    } else {
      items.push({ label: t("sftp.download"), onClick: () => onDownload(entry) });
    }
    items.push({ label: t("sftp.rename"), onClick: () => onRename(entry) });
    items.push({ label: t("sftp.chmod"), onClick: () => setChmodTarget(entry) });
    items.push({ separator: true, label: "" });
    items.push({
      label: t("sftp.delete"),
      onClick: () => onDelete(entry),
      destructive: true,
    });
    return items;
  }

  const selectedBytes = entries
    .filter((e) => !e.is_dir && selected.has(e.name))
    .reduce((sum, e) => sum + e.size, 0);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      {...backdropProps}
    >
      <div
        {...contentProps}
        className="nx-modal-enter w-full max-w-5xl h-[80vh] flex flex-col bg-nx-bg border border-nx-border rounded-nx shadow-glow-md overflow-hidden"
      >
        {/* Header */}
        <div className="flex items-center gap-2 px-4 py-3 border-b border-nx-divider shrink-0">
          <h2 className="text-lg font-mono text-nx-accent">&gt; sftp</h2>
          <span className="text-meta text-nx-muted font-mono truncate">{title}</span>
          <IconButton
            className="ml-auto"
            icon={<span className="text-base leading-none">×</span>}
            onClick={onClose}
            title={t("tabmenu.close")}
          />
        </div>

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
            disabled={!sftpId || selected.size === 0}
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
        <div className="flex-1 min-h-0 overflow-y-auto">
          {loading ? (
            <div className="flex items-center justify-center h-full text-nx-muted font-mono text-body gap-2">
              <Loader2 size={16} className="animate-spin" /> {t("sftp.loading")}
            </div>
          ) : entries.length === 0 ? (
            <div className="flex items-center justify-center h-full text-nx-muted font-mono text-body">
              {t("sftp.empty")}
            </div>
          ) : (
            entries.map((e) => {
              const isSelected = selected.has(e.name);
              return (
                <div
                  key={e.name}
                  data-active={isSelected || undefined}
                  onDoubleClick={() =>
                    e.is_dir ? navigate(joinPath(cwd, e.name)) : onDownload(e)
                  }
                  onContextMenu={(ev) => {
                    ev.preventDefault();
                    setCtx({ x: ev.clientX, y: ev.clientY, entry: e });
                  }}
                  className="nx-row grid items-center px-3.5 py-1.5 cursor-pointer text-body select-none"
                  style={{ gridTemplateColumns: GRID, columnGap: 16 }}
                >
                  <div onClick={(ev) => ev.stopPropagation()}>
                    {!e.is_dir && (
                      <Checkbox checked={isSelected} onChange={() => toggleSelect(e.name)} />
                    )}
                  </div>
                  <FileTypeIcon entry={e} />
                  <div
                    className="flex items-center gap-1.5 min-w-0"
                    onClick={() =>
                      e.is_dir ? navigate(joinPath(cwd, e.name)) : toggleSelect(e.name)
                    }
                  >
                    <span
                      className={
                        "truncate " +
                        (e.is_dir || e.is_symlink
                          ? "text-nx-accent2"
                          : isSelected
                            ? "text-nx-accent"
                            : "text-nx-text")
                      }
                    >
                      {e.name}
                    </span>
                    <FileTypeChip entry={e} />
                  </div>
                  <div className="text-right tabular-nums text-nx-dim">
                    {e.is_dir ? "—" : fmtSize(e.size)}
                  </div>
                  <div className="text-nx-dim tabular-nums">{fmtMtime(e.mtime)}</div>
                  <div className="tabular-nums text-nx-soft">{fmtPerms(e.permissions)}</div>
                  <div className="text-nx-muted truncate">
                    {e.owner || (e.uid ? String(e.uid) : "")}
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* Active transfers — one progress bar per in-flight transfer. */}
        {Object.values(transfers).length > 0 && (
          <div className="px-4 py-2 border-t border-nx-divider shrink-0 flex flex-col gap-2 max-h-32 overflow-y-auto">
            {Object.values(transfers).map((tr) => (
              <TransferBar key={tr.id} tr={tr} />
            ))}
          </div>
        )}

        {/* Footer status */}
        <div className="px-4 py-2 border-t border-nx-divider font-mono text-meta shrink-0 flex items-center gap-2">
          {error ? (
            <span className="text-nx-error truncate">✗ {error}</span>
          ) : (
            <span className="text-nx-muted">
              {entries.length} {t("sftp.items")}
            </span>
          )}
        </div>
      </div>

      {ctx && (
        <ContextMenu
          x={ctx.x}
          y={ctx.y}
          items={rowMenu(ctx.entry)}
          onClose={() => setCtx(null)}
        />
      )}

      {chmodTarget && sftpId && (
        <ChmodDialog
          entry={chmodTarget}
          onClose={() => setChmodTarget(null)}
          onApply={async (mode) => {
            setError(null);
            try {
              await sftpChmod(sftpId, joinPath(cwd, chmodTarget.name), mode);
              setChmodTarget(null);
              refresh();
            } catch (e) {
              setError(String(e));
            }
          }}
        />
      )}
    </div>
  );
}

/** A single transfer's progress bar (download/upload). */
function TransferBar({ tr }: { tr: Transfer }) {
  const pct = tr.total > 0 ? Math.min(100, (tr.transferred / tr.total) * 100) : 0;
  const indeterminate = tr.total === 0;
  return (
    <div className="font-mono text-meta">
      <div className="flex items-center gap-2 mb-1">
        {tr.phase === "upload" ? (
          <Upload size={11} className="text-nx-accent shrink-0" />
        ) : (
          <Download size={11} className="text-nx-accent shrink-0" />
        )}
        <span className="text-nx-soft truncate flex-1">{tr.name}</span>
        <span className="text-nx-muted tabular-nums shrink-0">
          {fmtSize(tr.transferred)}
          {tr.total > 0 ? ` / ${fmtSize(tr.total)}` : ""}
          {!indeterminate && (
            <span className="text-nx-accent ml-1.5">{Math.round(pct)}%</span>
          )}
        </span>
      </div>
      <div className="h-1.5 rounded-full bg-nx-elevated overflow-hidden">
        <div
          className={
            "h-full bg-nx-accent rounded-full transition-[width] duration-150 " +
            (indeterminate ? "animate-pulse w-1/3" : "")
          }
          style={indeterminate ? undefined : { width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

/** Octal-permission editor: 3×3 rwx grid kept in sync with an octal field. */
function ChmodDialog({
  entry,
  onClose,
  onApply,
}: {
  entry: SftpEntry;
  onClose: () => void;
  onApply: (mode: number) => void;
}) {
  const { t } = useTranslation();
  const { backdropProps, contentProps } = useBackdropClose(onClose);
  const [mode, setMode] = useState<number>(entry.permissions & 0o777);

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
          <span className="text-meta text-nx-muted font-mono truncate">{entry.name}</span>
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
        </div>

        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-nx-divider">
          <Button variant="secondary" size="sm" onClick={onClose}>
            {t("sftp.cancel")}
          </Button>
          <Button variant="primary" size="sm" onClick={() => onApply(mode)}>
            {t("sftp.apply")}
          </Button>
        </div>
      </div>
    </div>
  );
}
