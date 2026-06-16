// FileViewer — built-in remote text file viewer (F3, read-only) and editor
// (F4, modify + save back over SFTP). Opened as a modal over the SFTP panel.
//
// MC/TC conventions:
//   • F3 = view (read-only, monospace, scrollable)
//   • F4 = edit (textarea, monospace)
//   • F2 = save (edit mode only)
//   • Esc / F10 / button = close (confirms when there are unsaved edits)
//
// A binary file (NUL bytes in the read window) is never shown as text and can't
// be edited. A file larger than the size guard can't be edited either — only a
// truncated VIEW is offered for it. The component keeps no SFTP state of its own;
// it reads/writes via the sftp.ts bridges using the sftpId handed in by the panel.

import { useState, useEffect, useRef, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Eye, Pencil, Save, Loader2, X, AlertTriangle } from "lucide-react";
import { sftpReadText, sftpWriteText, type SftpTextRead } from "./sftp";
import { useBackdropClose } from "./useBackdropClose";
import { Button, IconButton } from "./components/primitives";
import { askConfirm } from "./dialogs";

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

export interface FileViewerProps {
  sftpId: string;
  /** Full remote path of the file to open. */
  path: string;
  /** Base name shown in the header. */
  name: string;
  /** Initial mode; F3 → "view", F4 → "edit". */
  mode: "view" | "edit";
  /** Read guard in bytes (the panel passes ~2 MiB). */
  maxBytes: number;
  onClose: () => void;
  /** Called after a successful save so the panel can refresh the listing. */
  onSaved?: () => void;
}

export function FileViewer({
  sftpId,
  path,
  name,
  mode: initialMode,
  maxBytes,
  onClose,
  onSaved,
}: FileViewerProps) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<"view" | "edit">(initialMode);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [meta, setMeta] = useState<SftpTextRead | null>(null);
  // The current (possibly edited) text. `original` is the last-loaded/saved
  // content used to compute the dirty flag.
  const [text, setText] = useState("");
  const [original, setOriginal] = useState("");
  const [saving, setSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const dirty = mode === "edit" && text !== original;

  // Whether the loaded file can be edited at all (not binary / too-large /
  // truncated). Used to refuse switching into edit mode.
  const editable =
    !!meta && !meta.binary && !meta.too_large && !meta.truncated;

  // Load the file once on mount. If F4 (edit) was requested but the file turns
  // out to be uneditable, fall back to view mode and surface a banner.
  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await sftpReadText(sftpId, path, maxBytes);
        if (!alive) return;
        setMeta(res);
        setText(res.content);
        setOriginal(res.content);
        const canEdit = !res.binary && !res.too_large && !res.truncated;
        if (initialMode === "edit" && !canEdit) {
          setMode("view");
        }
      } catch (e) {
        if (alive) setError(String(e));
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Focus the textarea when entering edit mode.
  useEffect(() => {
    if (mode === "edit" && !loading && editable) {
      textareaRef.current?.focus();
    }
  }, [mode, loading, editable]);

  const requestClose = useCallback(async () => {
    if (dirty) {
      const ok = await askConfirm(t("viewer.discard_confirm"), {
        title: t("viewer.discard_title"),
        destructive: true,
      });
      if (!ok) return;
    }
    onClose();
  }, [dirty, onClose, t]);

  const doSave = useCallback(async () => {
    if (mode !== "edit" || !editable || saving) return;
    setSaving(true);
    setError(null);
    try {
      await sftpWriteText(sftpId, path, text);
      setOriginal(text);
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 1500);
      onSaved?.();
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }, [mode, editable, saving, sftpId, path, text, onSaved]);

  // Modal-local capture-phase hotkeys. Owns F2/F3/F4/F10/Esc and Ctrl/Cmd+S so
  // they never leak to the SFTP panel's window handler (or the global app keys)
  // while the viewer is open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const consume = () => {
        e.preventDefault();
        e.stopPropagation();
      };
      if (e.key === "Escape" || e.key === "F10") {
        consume();
        requestClose();
        return;
      }
      if (e.key === "F3") {
        consume();
        // F3 toggles back to view (and is also the natural "close from view").
        if (mode === "edit" && !dirty) setMode("view");
        else if (mode === "view") requestClose();
        return;
      }
      if (e.key === "F4") {
        consume();
        if (mode === "view" && editable) setMode("edit");
        return;
      }
      if (e.key === "F2" || ((e.ctrlKey || e.metaKey) && e.code === "KeyS")) {
        consume();
        doSave();
        return;
      }
      // Swallow other function keys so they don't act on the panel behind us.
      if (/^F[1-9]$|^F1[0-2]$/.test(e.key)) consume();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [mode, dirty, editable, requestClose, doSave]);

  const { backdropProps, contentProps } = useBackdropClose(requestClose);

  // Tab inserts a real tab into the textarea instead of moving focus.
  function onTextareaKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Tab") {
      e.preventDefault();
      const ta = e.currentTarget;
      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      const next = text.slice(0, start) + "\t" + text.slice(end);
      setText(next);
      // Restore caret just after the inserted tab on the next tick.
      requestAnimationFrame(() => {
        ta.selectionStart = ta.selectionEnd = start + 1;
      });
    }
  }

  const sizeLabel = meta ? fmtSize(meta.size) : "";

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-sm"
      {...backdropProps}
    >
      <div
        {...contentProps}
        className="nx-modal-enter relative w-full max-w-4xl h-[80vh] flex flex-col bg-nx-bg border border-nx-border rounded-nx shadow-glow-md overflow-hidden"
      >
        {/* Header */}
        <div className="flex items-center gap-2 px-4 py-3 border-b border-nx-divider shrink-0">
          {mode === "edit" ? (
            <Pencil size={15} className="text-nx-accent" />
          ) : (
            <Eye size={15} className="text-nx-accent" />
          )}
          <h2 className="text-base font-mono text-nx-accent">
            {mode === "edit" ? t("viewer.edit") : t("viewer.view")}
          </h2>
          <span className="text-meta text-nx-muted font-mono truncate">{name}</span>
          {sizeLabel && (
            <span className="text-meta text-nx-dim font-mono tabular-nums shrink-0">
              {sizeLabel}
            </span>
          )}
          {dirty && (
            <span className="text-micro text-nx-warning font-mono shrink-0">
              ● {t("viewer.unsaved")}
            </span>
          )}
          {savedFlash && (
            <span className="text-micro text-nx-accent2 font-mono shrink-0">
              ✓ {t("viewer.saved")}
            </span>
          )}

          <span className="ml-auto flex items-center gap-1.5 shrink-0">
            {mode === "view" && editable && (
              <Button
                variant="secondary"
                size="sm"
                leadingIcon={<Pencil size={12} />}
                onClick={() => setMode("edit")}
              >
                {t("viewer.edit")} <span className="text-nx-dim ml-1">F4</span>
              </Button>
            )}
            {mode === "edit" && (
              <Button
                variant="primary"
                size="sm"
                leadingIcon={
                  saving ? (
                    <Loader2 size={12} className="animate-spin" />
                  ) : (
                    <Save size={12} />
                  )
                }
                onClick={doSave}
                disabled={saving || !editable || !dirty}
              >
                {saving ? t("viewer.saving") : t("viewer.save")}
                <span className="text-nx-dim ml-1">F2</span>
              </Button>
            )}
            <IconButton
              icon={<X size={14} />}
              onClick={requestClose}
              title={t("viewer.close")}
            />
          </span>
        </div>

        {/* Banners */}
        {meta?.binary && (
          <div className="flex items-center gap-2 px-4 py-2 border-b border-nx-divider bg-nx-warning/10 text-meta font-mono text-nx-warning shrink-0">
            <AlertTriangle size={13} className="shrink-0" />
            {t("viewer.binary")}
          </div>
        )}
        {meta?.too_large && (
          <div className="flex items-center gap-2 px-4 py-2 border-b border-nx-divider bg-nx-warning/10 text-meta font-mono text-nx-warning shrink-0">
            <AlertTriangle size={13} className="shrink-0" />
            {t("viewer.too_large", { size: fmtSize(maxBytes) })}
          </div>
        )}
        {meta?.truncated && (
          <div className="flex items-center gap-2 px-4 py-2 border-b border-nx-divider bg-nx-warning/10 text-meta font-mono text-nx-warning shrink-0">
            <AlertTriangle size={13} className="shrink-0" />
            {t("viewer.truncated", { size: fmtSize(maxBytes) })}
          </div>
        )}
        {/* Edit was requested but the file can't be edited. */}
        {initialMode === "edit" && meta && !editable && !meta.too_large && (
          <div className="flex items-center gap-2 px-4 py-2 border-b border-nx-divider bg-nx-warning/10 text-meta font-mono text-nx-warning shrink-0">
            <AlertTriangle size={13} className="shrink-0" />
            {t("viewer.cannot_edit")}
          </div>
        )}

        {/* Body */}
        <div className="flex-1 min-h-0 flex flex-col">
          {loading ? (
            <div className="flex items-center justify-center h-full text-nx-muted font-mono text-body gap-2">
              <Loader2 size={16} className="animate-spin" /> {t("viewer.loading")}
            </div>
          ) : error ? (
            <div className="flex items-center justify-center h-full px-6 text-center text-nx-error font-mono text-body break-all">
              ✗ {error}
            </div>
          ) : meta?.binary || meta?.too_large ? (
            <div className="flex items-center justify-center h-full px-6 text-center text-nx-muted font-mono text-body">
              {meta.binary ? t("viewer.binary") : t("viewer.too_large", { size: fmtSize(maxBytes) })}
            </div>
          ) : mode === "edit" ? (
            <textarea
              ref={textareaRef}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={onTextareaKeyDown}
              spellCheck={false}
              wrap="off"
              className="flex-1 min-h-0 w-full resize-none bg-nx-bg text-nx-text font-mono text-body leading-relaxed px-4 py-3 outline-none whitespace-pre overflow-auto"
            />
          ) : (
            <pre className="flex-1 min-h-0 w-full overflow-auto bg-nx-bg text-nx-text font-mono text-body leading-relaxed px-4 py-3 whitespace-pre">
              {text}
            </pre>
          )}
        </div>

        {/* Footer */}
        <div className="px-4 py-2 border-t border-nx-divider font-mono text-meta shrink-0 flex items-center gap-3 text-nx-muted">
          <span>{mode === "edit" ? t("viewer.mode_edit") : t("viewer.mode_view")}</span>
          {error && <span className="text-nx-error truncate ml-auto">✗ {error}</span>}
        </div>
      </div>
    </div>
  );
}
