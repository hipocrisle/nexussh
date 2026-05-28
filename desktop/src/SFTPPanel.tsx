// SFTPPanel — remote file browser over SFTP. Opened per-host from the
// sidebar context menu. Single remote pane; local side via OS file dialogs
// for up/download (model A: separate SFTP connection, decoupled from the
// interactive shell session).

import { useState, useEffect, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import {
  Folder,
  File as FileIcon,
  Upload,
  FolderPlus,
  RefreshCw,
  ArrowUp,
  Loader2,
  Link2,
} from "lucide-react";
import type { ConnectArgs } from "./ssh";
import {
  SftpEntry,
  sftpConnect,
  sftpRealpath,
  sftpList,
  sftpDownload,
  sftpUpload,
  sftpMkdir,
  sftpRename,
  sftpRemove,
  sftpDisconnect,
} from "./sftp";
import { ContextMenu, MenuItem } from "./ContextMenu";
import { useBackdropClose } from "./useBackdropClose";

interface Props {
  connectArgs: ConnectArgs;
  title: string;
  onClose: () => void;
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

export function SFTPPanel({ connectArgs, title, onClose }: Props) {
  const { t } = useTranslation();
  const [sftpId, setSftpId] = useState<string | null>(null);
  const [cwd, setCwd] = useState("/");
  const [entries, setEntries] = useState<SftpEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ctx, setCtx] = useState<{ x: number; y: number; entry: SftpEntry } | null>(
    null,
  );
  const { backdropProps, contentProps } = useBackdropClose(onClose);
  const idRef = useRef<string | null>(null);

  const load = useCallback(
    async (id: string, path: string) => {
      setLoading(true);
      setError(null);
      try {
        const list = await sftpList(id, path);
        setEntries(list);
        setCwd(path);
      } catch (e) {
        setError(String(e));
      } finally {
        setLoading(false);
      }
    },
    [],
  );

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
    setBusy(t("sftp.uploading", { name: base }));
    setError(null);
    try {
      await sftpUpload(sftpId, picked, joinPath(cwd, base));
      refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }

  async function onMkdir() {
    if (!sftpId) return;
    const name = window.prompt(t("sftp.new_folder_prompt"));
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
    setBusy(t("sftp.downloading", { name: entry.name }));
    setError(null);
    try {
      await sftpDownload(sftpId, joinPath(cwd, entry.name), dest);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }

  async function onRename(entry: SftpEntry) {
    if (!sftpId) return;
    const next = window.prompt(t("sftp.rename_prompt"), entry.name);
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
    if (!window.confirm(t("sftp.delete_confirm", { name: entry.name }))) return;
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
    items.push({ separator: true, label: "" });
    items.push({
      label: t("sftp.delete"),
      onClick: () => onDelete(entry),
      destructive: true,
    });
    return items;
  }

  const crumbs = cwd === "/" ? [""] : cwd.split("/");

  const btn =
    "p-1.5 rounded hover:bg-[var(--nx-border)] text-[var(--nx-text-soft)] disabled:opacity-30";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      {...backdropProps}
    >
      <div
        {...contentProps}
        className="w-full max-w-3xl h-[80vh] flex flex-col bg-[var(--nx-bg-base)] border border-[var(--nx-border)] rounded-lg shadow-2xl overflow-hidden"
      >
        {/* Header */}
        <div className="flex items-center gap-2 px-4 py-3 border-b border-[var(--nx-border)] shrink-0">
          <h2 className="text-lg font-mono text-[var(--nx-accent)]">&gt; sftp</h2>
          <span className="text-xs text-[var(--nx-text-muted)] font-mono truncate">
            {title}
          </span>
          <div className="ml-auto flex items-center gap-1">
            <button className={btn} title={t("sftp.up")} onClick={() => navigate(parentPath(cwd))} disabled={!sftpId || cwd === "/"}>
              <ArrowUp size={15} />
            </button>
            <button className={btn} title={t("sftp.upload")} onClick={onUpload} disabled={!sftpId}>
              <Upload size={15} />
            </button>
            <button className={btn} title={t("sftp.new_folder")} onClick={onMkdir} disabled={!sftpId}>
              <FolderPlus size={15} />
            </button>
            <button className={btn} title={t("sftp.refresh")} onClick={refresh} disabled={!sftpId}>
              <RefreshCw size={15} />
            </button>
          </div>
        </div>

        {/* Breadcrumb */}
        <div className="flex items-center flex-wrap gap-0.5 px-4 py-2 border-b border-[var(--nx-border)] font-mono text-xs shrink-0">
          {crumbs.map((seg, i) => {
            const path = i === 0 ? "/" : "/" + crumbs.slice(1, i + 1).join("/");
            return (
              <span key={i} className="flex items-center">
                {i > 0 && <span className="text-[var(--nx-text-muted)] mx-0.5">/</span>}
                <button
                  className="hover:text-[var(--nx-accent)] text-[var(--nx-text-soft)]"
                  onClick={() => navigate(path)}
                >
                  {i === 0 ? "/" : seg}
                </button>
              </span>
            );
          })}
        </div>

        {/* Body */}
        <div className="flex-1 min-h-0 overflow-y-auto">
          {loading ? (
            <div className="flex items-center justify-center h-full text-[var(--nx-text-muted)] font-mono text-sm gap-2">
              <Loader2 size={16} className="animate-spin" /> {t("sftp.loading")}
            </div>
          ) : entries.length === 0 ? (
            <div className="flex items-center justify-center h-full text-[var(--nx-text-muted)] font-mono text-sm">
              {t("sftp.empty")}
            </div>
          ) : (
            <table className="w-full font-mono text-xs">
              <tbody>
                {entries.map((e) => (
                  <tr
                    key={e.name}
                    onDoubleClick={() =>
                      e.is_dir ? navigate(joinPath(cwd, e.name)) : onDownload(e)
                    }
                    onContextMenu={(ev) => {
                      ev.preventDefault();
                      setCtx({ x: ev.clientX, y: ev.clientY, entry: e });
                    }}
                    className="border-b border-[var(--nx-border)]/40 hover:bg-[var(--nx-bg-panel)] cursor-default select-none"
                  >
                    <td className="px-4 py-1.5 w-6">
                      {e.is_symlink ? (
                        <Link2 size={14} className="text-[var(--nx-accent2)]" />
                      ) : e.is_dir ? (
                        <Folder size={14} className="text-[var(--nx-accent)]" />
                      ) : (
                        <FileIcon size={14} className="text-[var(--nx-text-muted)]" />
                      )}
                    </td>
                    <td
                      className="py-1.5 text-[var(--nx-text-primary)] truncate max-w-0 w-full"
                      onClick={() => e.is_dir && navigate(joinPath(cwd, e.name))}
                    >
                      {e.name}
                    </td>
                    <td className="px-3 py-1.5 text-right text-[var(--nx-text-muted)] whitespace-nowrap">
                      {e.is_dir ? "" : fmtSize(e.size)}
                    </td>
                    <td className="px-3 py-1.5 text-[var(--nx-text-muted)] whitespace-nowrap hidden sm:table-cell">
                      {fmtMtime(e.mtime)}
                    </td>
                    <td className="px-4 py-1.5 text-[var(--nx-text-soft)] whitespace-nowrap hidden md:table-cell">
                      {fmtPerms(e.permissions)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Footer status */}
        <div className="px-4 py-2 border-t border-[var(--nx-border)] font-mono text-[11px] shrink-0 flex items-center gap-2">
          {busy ? (
            <span className="text-[var(--nx-accent)] flex items-center gap-1">
              <Loader2 size={12} className="animate-spin" /> {busy}
            </span>
          ) : error ? (
            <span className="text-[var(--nx-error)] truncate">✗ {error}</span>
          ) : (
            <span className="text-[var(--nx-text-muted)]">
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
    </div>
  );
}
