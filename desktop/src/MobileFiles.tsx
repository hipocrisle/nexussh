// Mobile Files — a single-pane SFTP browser for phones. Pick a host → browse its
// remote files → upload from / download to the device. Deliberately NOT the
// desktop dual-pane (local↔remote) SFTPPanel: on a phone there's no local file
// tree to browse, so transfers go through the system file picker / save dialog.
//
// Opens its OWN sftp connection per host (independent of any terminal session).
// Mounted only while the Files tab is active; disconnects on unmount.

import { useState, useEffect, useRef, type ChangeEvent } from "react";
import { useTranslation } from "react-i18next";
import {
  Folder,
  FileText,
  CornerLeftUp,
  Upload,
  FolderPlus,
  RefreshCw,
  Trash2,
  Download,
  Server,
  Loader2,
  X,
  ChevronLeft,
  CheckSquare,
  Square,
  ListChecks,
} from "lucide-react";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";
import type { ConnectArgs } from "./ssh";
import {
  sftpConnect,
  sftpList,
  sftpRealpath,
  sftpWriteBytes,
  sftpReadBytes,
  sftpMkdir,
  sftpRemove,
  sftpDisconnect,
  onSftpProgress,
  isCancelled,
  type SftpEntry,
} from "./sftp";
import { HostRecord, listHosts } from "./hosts";
import { askPrompt } from "./dialogs";

interface Props {
  /** Resolve a host to ConnectArgs (handles "always ask" auth). null = cancelled. */
  resolveArgs: (h: HostRecord) => Promise<ConnectArgs | null>;
}

function joinPath(dir: string, name: string): string {
  if (dir.endsWith("/")) return dir + name;
  return dir + "/" + name;
}

function parentOf(path: string): string {
  const p = path.replace(/\/+$/, "");
  const i = p.lastIndexOf("/");
  if (i <= 0) return "/";
  return p.slice(0, i);
}

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function MobileFiles({ resolveArgs }: Props) {
  const { t } = useTranslation();
  const [hosts, setHosts] = useState<HostRecord[]>([]);
  const [sftpId, setSftpId] = useState<string | null>(null);
  const [label, setLabel] = useState<string>("");
  const [cwd, setCwd] = useState("/");
  const [entries, setEntries] = useState<SftpEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [transfer, setTransfer] = useState<
    { name: string; dir: "up" | "down"; pct: number } | null
  >(null);
  // Multi-select (group download / delete). Selection is per-directory; changing
  // dir clears it.
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Keep the live sftp id in a ref so the unmount cleanup disconnects it, and
  // the resolved ConnectArgs so we can transparently RECONNECT a dropped session
  // without re-prompting (mobile freezes the process while the file picker / save
  // dialog is foregrounded, which kills the TCP connection — "sftp: session
  // closed"). withId() retries an op once against a fresh session on that error.
  const idRef = useRef<string | null>(null);
  idRef.current = sftpId;
  const argsRef = useRef<ConnectArgs | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    listHosts().then(setHosts).catch(() => {});
    return () => {
      if (idRef.current) sftpDisconnect(idRef.current).catch(() => {});
    };
  }, []);

  function isSessionClosed(e: unknown): boolean {
    return /session closed|not connected|channel|closed|eof|broken pipe|disconnect|reset/i.test(
      String(e),
    );
  }

  // Run an sftp op with the live session id; if the session died (mobile
  // backgrounding / lossy link), reconnect once from the stored args and retry.
  async function withId<T>(fn: (id: string) => Promise<T>): Promise<T> {
    let id = idRef.current;
    if (!id) throw new Error("not connected");
    try {
      return await fn(id);
    } catch (e) {
      if (!isSessionClosed(e) || !argsRef.current) throw e;
      id = await sftpConnect(argsRef.current);
      idRef.current = id;
      setSftpId(id);
      return await fn(id);
    }
  }

  async function loadDir(path: string) {
    setBusy(true);
    setError(null);
    setSelected(new Set()); // selection is per-directory
    try {
      const res = await withId(async (id) => {
        const real = await sftpRealpath(id, path).catch(() => path);
        return { real, list: await sftpList(id, real) };
      });
      setCwd(res.real);
      setEntries(res.list);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  function toggleSelect(name: string) {
    setSelected((prev) => {
      const n = new Set(prev);
      if (n.has(name)) n.delete(name);
      else n.add(name);
      return n;
    });
  }
  function exitSelect() {
    setSelectMode(false);
    setSelected(new Set());
  }

  async function connect(h: HostRecord) {
    setError(null);
    setBusy(true);
    try {
      const args = await resolveArgs(h);
      if (!args) {
        setBusy(false);
        return;
      }
      const id = await sftpConnect(args);
      argsRef.current = args;
      idRef.current = id;
      setSftpId(id);
      setLabel(h.name || `${h.user}@${h.host}`);
      await loadDir("."); // resolves & lists the home dir
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  function disconnect() {
    if (sftpId) sftpDisconnect(sftpId).catch(() => {});
    idRef.current = null;
    argsRef.current = null;
    setSftpId(null);
    setEntries([]);
    setCwd("/");
    setLabel("");
    setError(null);
    exitSelect();
  }

  async function runTransfer(
    name: string,
    dir: "up" | "down",
    fn: (transferId: string) => Promise<void>,
  ) {
    const tid = crypto.randomUUID();
    setTransfer({ name, dir, pct: 0 });
    const un = await onSftpProgress((p) => {
      if (p.id !== tid) return;
      const pct = p.total > 0 ? Math.round((p.transferred / p.total) * 100) : 0;
      setTransfer({ name, dir, pct });
    });
    try {
      await fn(tid);
    } catch (e) {
      if (!isCancelled(e)) setError(String(e));
    } finally {
      un();
      setTransfer(null);
    }
  }

  // Read a remote file's bytes and write them to a local destination via the fs
  // plugin (which can write a content:// URI from the save dialog on Android —
  // a plain Blob/<a download> doesn't actually save in the Android WebView).
  async function saveBytesTo(entry: SftpEntry, destPath: string, tid: string) {
    const bytes = await withId((id) =>
      sftpReadBytes(id, joinPath(cwd, entry.name), tid),
    );
    await writeFile(destPath, bytes);
  }

  // Download a single file: system save dialog → write bytes there.
  async function download(entry: SftpEntry) {
    if (!sftpId) return;
    const dest = await saveDialog({ defaultPath: entry.name }).catch(() => null);
    if (!dest) return;
    await runTransfer(entry.name, "down", (tid) => saveBytesTo(entry, dest, tid));
  }

  // Group download: a save dialog per file (one tap each). Writing into a picked
  // FOLDER would need SAF tree-URI document creation, which the Android WebView
  // doesn't do via a plain path — so we reuse the reliable single-file save.
  async function downloadSelected() {
    if (!sftpId || selected.size === 0) return;
    const items = entries.filter((e) => selected.has(e.name) && !e.is_dir);
    exitSelect();
    for (const e of items) {
      const dest = await saveDialog({ defaultPath: e.name }).catch(() => null);
      if (!dest) continue; // skipped this one
      await runTransfer(e.name, "down", (tid) => saveBytesTo(e, dest, tid));
    }
  }

  // Group delete: remove every selected entry (files and folders).
  async function deleteSelected() {
    if (!sftpId || selected.size === 0) return;
    if (!confirm(t("files.delete_confirm_n", { count: selected.size }))) return;
    const items = entries.filter((e) => selected.has(e.name));
    setBusy(true);
    try {
      for (const e of items) {
        await withId((id) => sftpRemove(id, joinPath(cwd, e.name), e.is_dir));
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
    exitSelect();
    await loadDir(cwd);
  }

  // Upload: use the standard <input type="file"> picker (pure web API) and read
  // the chosen file's bytes via the File API, then ship them to the backend.
  // This sidesteps the content:// URI that Android's native picker returns —
  // which the path-based sftp_upload can't open (os error 2).
  function pickUpload() {
    fileInputRef.current?.click();
  }
  async function onFilePicked(ev: ChangeEvent<HTMLInputElement>) {
    const file = ev.target.files?.[0];
    ev.target.value = ""; // allow re-picking the same file later
    if (!file || !sftpId) return;
    await runTransfer(file.name, "up", async (tid) => {
      const bytes = new Uint8Array(await file.arrayBuffer());
      await withId((id) => sftpWriteBytes(id, joinPath(cwd, file.name), bytes, tid));
    });
    await loadDir(cwd);
  }

  async function makeDir() {
    if (!sftpId) return;
    const name = await askPrompt(t("files.new_folder_prompt"));
    if (!name) return;
    try {
      await withId((id) => sftpMkdir(id, joinPath(cwd, name)));
      await loadDir(cwd);
    } catch (e) {
      setError(String(e));
    }
  }

  async function remove(entry: SftpEntry) {
    if (!sftpId) return;
    if (!confirm(t("files.delete_confirm", { name: entry.name }))) return;
    try {
      await withId((id) => sftpRemove(id, joinPath(cwd, entry.name), entry.is_dir));
      await loadDir(cwd);
    } catch (e) {
      setError(String(e));
    }
  }

  // ---- Host picker (no connection yet) ----
  if (!sftpId) {
    return (
      <div className="absolute inset-0 z-40 flex flex-col bg-nx-bg">
        <div className="flex items-center px-4 h-12 border-b border-nx-border shrink-0">
          <span className="font-mono text-nx-text text-base">
            {t("mobile.tab.files")}
          </span>
          {busy && (
            <Loader2 size={18} className="ml-auto animate-spin text-nx-muted" />
          )}
        </div>
        <div className="px-4 py-3 text-meta font-mono text-nx-muted shrink-0">
          {t("files.pick_host")}
        </div>
        <div className="flex-1 overflow-y-auto">
          {hosts.length === 0 && (
            <div className="px-4 py-6 text-sm font-mono text-nx-muted">
              {t("files.no_hosts")}
            </div>
          )}
          {hosts.map((h) => (
            <button
              key={h.id}
              type="button"
              onClick={() => connect(h)}
              disabled={busy}
              className="w-full flex items-center gap-3 px-4 py-3 text-left active:bg-nx-elevated disabled:opacity-50 border-b border-nx-divider/30"
            >
              <Server size={18} className="text-nx-muted shrink-0" />
              <span className="min-w-0">
                <span className="block font-mono text-base text-nx-text truncate">
                  {h.name}
                </span>
                <span className="block font-mono text-sm text-nx-muted truncate">
                  {h.user}@{h.host}:{h.port}
                </span>
              </span>
            </button>
          ))}
        </div>
        {error && (
          <div className="px-4 py-2 text-sm font-mono text-nx-error break-all border-t border-nx-border shrink-0">
            {error}
          </div>
        )}
      </div>
    );
  }

  // ---- Connected: remote browser ----
  return (
    <div className="absolute inset-0 z-40 flex flex-col bg-nx-bg">
      {/* Hidden file picker for uploads (kept mounted so the ref is stable). */}
      <input
        ref={fileInputRef}
        type="file"
        className="hidden"
        onChange={onFilePicked}
      />
      {/* Header: normal actions, or the multi-select action bar. */}
      {selectMode ? (
        <div className="flex items-center gap-1 px-2 h-12 border-b border-nx-border shrink-0">
          <button
            type="button"
            onClick={exitSelect}
            aria-label={t("files.cancel")}
            className="shrink-0 inline-flex items-center justify-center w-10 h-10 rounded-full active:bg-nx-elevated text-nx-text"
          >
            <X size={22} />
          </button>
          <span className="flex-1 min-w-0 font-mono text-base text-nx-text truncate">
            {t("files.selected_n", { count: selected.size })}
          </span>
          <button
            type="button"
            onClick={downloadSelected}
            aria-label={t("files.download")}
            disabled={selected.size === 0 || !!transfer}
            className="shrink-0 inline-flex items-center justify-center w-10 h-10 rounded-full active:bg-nx-elevated text-nx-accent disabled:opacity-40"
          >
            <Download size={20} />
          </button>
          <button
            type="button"
            onClick={deleteSelected}
            aria-label={t("files.delete")}
            disabled={selected.size === 0}
            className="shrink-0 inline-flex items-center justify-center w-10 h-10 rounded-full active:bg-nx-elevated text-nx-error disabled:opacity-40"
          >
            <Trash2 size={20} />
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-1 px-2 h-12 border-b border-nx-border shrink-0">
          <button
            type="button"
            onClick={disconnect}
            aria-label={t("files.disconnect")}
            className="shrink-0 inline-flex items-center justify-center w-10 h-10 rounded-full active:bg-nx-elevated text-nx-text"
          >
            <ChevronLeft size={22} />
          </button>
          <span className="flex-1 min-w-0 font-mono text-base text-nx-text truncate">
            {label}
          </span>
          <button
            type="button"
            onClick={pickUpload}
            aria-label={t("files.upload")}
            disabled={!!transfer}
            className="shrink-0 inline-flex items-center justify-center w-10 h-10 rounded-full active:bg-nx-elevated text-nx-accent disabled:opacity-40"
          >
            <Upload size={20} />
          </button>
          <button
            type="button"
            onClick={makeDir}
            aria-label={t("files.new_folder")}
            className="shrink-0 inline-flex items-center justify-center w-10 h-10 rounded-full active:bg-nx-elevated text-nx-muted"
          >
            <FolderPlus size={20} />
          </button>
          <button
            type="button"
            onClick={() => setSelectMode(true)}
            aria-label={t("files.select")}
            disabled={entries.length === 0}
            className="shrink-0 inline-flex items-center justify-center w-10 h-10 rounded-full active:bg-nx-elevated text-nx-muted disabled:opacity-40"
          >
            <ListChecks size={20} />
          </button>
          <button
            type="button"
            onClick={() => loadDir(cwd)}
            aria-label={t("files.refresh")}
            className="shrink-0 inline-flex items-center justify-center w-10 h-10 rounded-full active:bg-nx-elevated text-nx-muted"
          >
            <RefreshCw size={18} className={busy ? "animate-spin" : ""} />
          </button>
        </div>
      )}

      {/* Current path */}
      <div className="px-4 py-2 font-mono text-sm text-nx-muted truncate shrink-0 border-b border-nx-divider/30">
        {cwd}
      </div>

      {/* Transfer progress */}
      {transfer && (
        <div className="px-4 py-2 shrink-0 border-b border-nx-divider/30">
          <div className="flex items-center justify-between font-mono text-sm text-nx-text mb-1">
            <span className="truncate">
              {transfer.dir === "up" ? "↑ " : "↓ "}
              {transfer.name}
            </span>
            <span className="text-nx-muted ml-2">{transfer.pct}%</span>
          </div>
          <div className="h-1.5 rounded-full bg-nx-elevated overflow-hidden">
            <div
              className="h-full bg-nx-accent transition-[width] duration-150"
              style={{ width: `${transfer.pct}%` }}
            />
          </div>
        </div>
      )}

      {/* Entry list */}
      <div className="flex-1 overflow-y-auto">
        {cwd !== "/" && !selectMode && (
          <button
            type="button"
            onClick={() => loadDir(parentOf(cwd))}
            className="w-full flex items-center gap-3 px-4 py-3 text-left active:bg-nx-elevated border-b border-nx-divider/30"
          >
            <CornerLeftUp size={18} className="text-nx-muted shrink-0" />
            <span className="font-mono text-base text-nx-soft">..</span>
          </button>
        )}
        {entries.map((e) => {
          const isSel = selected.has(e.name);
          return (
            <div
              key={e.name}
              className={
                "w-full flex items-center gap-3 px-4 py-3 border-b border-nx-divider/30 " +
                (isSel ? "bg-nx-elevated" : "active:bg-nx-elevated")
              }
            >
              <button
                type="button"
                onClick={() => {
                  if (selectMode) {
                    toggleSelect(e.name);
                  } else if (e.is_dir) {
                    loadDir(joinPath(cwd, e.name));
                  } else {
                    download(e);
                  }
                }}
                onContextMenu={(ev) => {
                  // Long-press → enter selection and pick this item.
                  ev.preventDefault();
                  if (!selectMode) setSelectMode(true);
                  toggleSelect(e.name);
                }}
                className="flex items-center gap-3 flex-1 min-w-0 text-left"
              >
                {selectMode ? (
                  isSel ? (
                    <CheckSquare size={20} className="text-nx-accent shrink-0" />
                  ) : (
                    <Square size={20} className="text-nx-muted shrink-0" />
                  )
                ) : e.is_dir ? (
                  <Folder size={18} className="text-nx-accent shrink-0" />
                ) : (
                  <FileText size={18} className="text-nx-muted shrink-0" />
                )}
                <span className="min-w-0">
                  <span className="block font-mono text-base text-nx-text truncate">
                    {e.name}
                  </span>
                  <span className="block font-mono text-sm text-nx-muted">
                    {e.is_dir ? t("files.folder") : fmtSize(e.size)}
                  </span>
                </span>
              </button>
              {!selectMode && !e.is_dir && (
                <button
                  type="button"
                  onClick={() => download(e)}
                  aria-label={t("files.download")}
                  disabled={!!transfer}
                  className="shrink-0 inline-flex items-center justify-center w-9 h-9 rounded-full active:bg-nx-bg text-nx-muted disabled:opacity-40"
                >
                  <Download size={18} />
                </button>
              )}
              {!selectMode && (
                <button
                  type="button"
                  onClick={() => remove(e)}
                  aria-label={t("files.delete")}
                  className="shrink-0 inline-flex items-center justify-center w-9 h-9 rounded-full active:bg-nx-bg text-nx-muted"
                >
                  <Trash2 size={16} />
                </button>
              )}
            </div>
          );
        })}
        {!busy && entries.length === 0 && cwd === "/" && (
          <div className="px-4 py-6 text-sm font-mono text-nx-muted">
            {t("files.empty")}
          </div>
        )}
      </div>

      {error && (
        <div className="px-4 py-2 text-sm font-mono text-nx-error break-all border-t border-nx-border shrink-0 flex items-start gap-2">
          <span className="flex-1">{error}</span>
          <button onClick={() => setError(null)} aria-label="dismiss">
            <X size={16} />
          </button>
        </div>
      )}
    </div>
  );
}
