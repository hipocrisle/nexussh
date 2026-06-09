// HistoryPanel — fullscreen overlay for browsing & replaying recorded sessions.
//
// Left column: list of recordings (newest first, straight from the backend).
// Main area: a HEADLESS xterm.js instance that replays the selected recording
// by writing every recorded byte verbatim — NO ANSI filtering, NO dedup. That
// honesty is deliberate: any cleverness on replay corrupts cursor/redraw state.
//
// Recordings are stored encrypted under the vault key, so list/read throw a
// "vault locked"-ish error when the vault is locked; we surface that as a hint.

import { useState, useEffect, useRef, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, Trash2, Lock, Search, X } from "lucide-react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import "@xterm/xterm/css/xterm.css";
import {
  SessionMeta,
  historyList,
  historyRead,
  historyDelete,
  historyClear,
  historyStats,
} from "./history";
import { useBackdropClose } from "./useBackdropClose";
import { writeClipboard } from "./clipboard";
import { IconButton, Button } from "./components/primitives";
import { askConfirm } from "./dialogs";
import { useSettings } from "./settings/settings-store";
import { THEMES, xtermThemeOf } from "./settings/themes";
import { fontStackOf } from "./settings/fonts";

interface Props {
  onClose: () => void;
}

/** Human-readable byte size, same conventions as SFTPPanel.fmtSize. */
function fmtBytes(n: number): string {
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

/** m:ss duration from a start/end pair (unix seconds), or "—" if open. */
function fmtDuration(start: number, end: number | null): string {
  if (end == null) return "—";
  const secs = Math.max(0, Math.round(end - start));
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function fmtDate(start: number): string {
  return new Date(start * 1000).toLocaleString();
}

/** base64 of RAW bytes → Uint8Array. atob yields a latin1 string where each
 *  char code is one byte; we never go through TextDecoder (would mangle bytes). */
function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function HistoryPanel({ onClose }: Props) {
  const { t } = useTranslation();
  const [settings] = useSettings();
  const { backdropProps, contentProps } = useBackdropClose(onClose);

  const [sessions, setSessions] = useState<SessionMeta[]>([]);
  const [stats, setStats] = useState<{ sessions: number; bytes: number }>({
    sessions: 0,
    bytes: 0,
  });
  const [loading, setLoading] = useState(true);
  const [locked, setLocked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [replayLoading, setReplayLoading] = useState(false);

  const termContainerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const searchAddonRef = useRef<SearchAddon | null>(null);

  // In-replay find bar — only meaningful while a recording is selected.
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);
  // Keep latest setter in a ref so the mount-once term effect's key handler
  // (registered when the replay term is built) always opens the live bar.
  const openSearchRef = useRef<() => void>(() => {});
  openSearchRef.current = () => {
    setSearchOpen(true);
    // Focus after the input has actually rendered.
    requestAnimationFrame(() => searchInputRef.current?.focus());
  };

  // Load list + stats on mount.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [list, st] = await Promise.all([historyList(), historyStats()]);
        if (!alive) return;
        setSessions(list);
        setStats(st);
      } catch (e) {
        if (!alive) return;
        const msg = String(e).toLowerCase();
        if (msg.includes("locked")) {
          setLocked(true);
        } else {
          setError(String(e));
        }
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // Dispose the replay terminal when the selection changes / on unmount.
  const disposeTerm = useCallback(() => {
    if (termRef.current) {
      termRef.current.dispose();
      termRef.current = null;
    }
    fitRef.current = null;
    searchAddonRef.current = null;
  }, []);

  // Build a fresh headless xterm and replay the selected recording.
  useEffect(() => {
    if (!selected) {
      disposeTerm();
      return;
    }
    const container = termContainerRef.current;
    if (!container) return;

    let alive = true;
    setReplayLoading(true);
    setError(null);
    // New recording → drop any stale find query/bar.
    setSearchOpen(false);
    setSearchQuery("");

    // Re-create the terminal for this recording (clean buffer + fresh parser).
    disposeTerm();
    const palette = THEMES[settings.theme];
    const term = new Terminal({
      theme: xtermThemeOf(palette),
      fontFamily: fontStackOf(settings.font),
      fontSize: settings.fontSize,
      scrollback: 100_000,
      cursorBlink: false,
      disableStdin: true,
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    const searchAddon = new SearchAddon();
    term.loadAddon(searchAddon);
    term.open(container);
    termRef.current = term;
    fitRef.current = fit;
    searchAddonRef.current = searchAddon;

    // Replay has disableStdin:true (no PTY), but attachCustomKeyEventHandler
    // still fires — we use it for copy + opening the find bar. Returning false
    // suppresses xterm's default handling of that key.
    term.attachCustomKeyEventHandler((ev) => {
      if (ev.type !== "keydown") return true;
      const ctrl = ev.ctrlKey && !ev.altKey && !ev.metaKey;
      // Copy: Ctrl+Shift+C, or Ctrl+C when there's a selection (Ctrl+C alone
      // has no SIGINT meaning here — there's no live shell).
      if (ctrl && ev.key.toLowerCase() === "c") {
        const sel = term.getSelection();
        if (ev.shiftKey || sel) {
          if (sel) writeClipboard(sel);
          return false;
        }
      }
      // Open the in-replay find bar.
      if (ctrl && !ev.shiftKey && ev.key.toLowerCase() === "f") {
        openSearchRef.current();
        return false;
      }
      return true;
    });
    try {
      fit.fit();
    } catch {
      /* container may not be measurable yet — harmless */
    }

    (async () => {
      try {
        const ndjson = await historyRead(selected);
        if (!alive || termRef.current !== term) return;
        // Parse line-by-line: each non-empty line is `[t, b64]`. Write the
        // decoded bytes sequentially, in file order, with zero filtering.
        for (const line of ndjson.split("\n")) {
          if (!line) continue;
          let evt: unknown;
          try {
            evt = JSON.parse(line);
          } catch {
            continue; // skip a malformed line rather than abort the replay
          }
          if (!Array.isArray(evt) || evt.length < 2) continue;
          const b64 = evt[1];
          if (typeof b64 !== "string") continue;
          term.write(b64ToBytes(b64));
        }
        if (alive && termRef.current === term) {
          try {
            fit.fit();
          } catch {
            /* ignore */
          }
        }
      } catch (e) {
        if (alive) setError(String(e));
      } finally {
        if (alive) setReplayLoading(false);
      }
    })();

    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  // Dispose on unmount.
  useEffect(() => {
    return () => disposeTerm();
  }, [disposeTerm]);

  async function onDelete(id: string) {
    try {
      await historyDelete(id);
    } catch (e) {
      setError(String(e));
      return;
    }
    setSessions((prev) => prev.filter((s) => s.id !== id));
    if (selected === id) setSelected(null);
    setStats((prev) => {
      const meta = sessions.find((s) => s.id === id);
      return {
        sessions: Math.max(0, prev.sessions - 1),
        bytes: Math.max(0, prev.bytes - (meta?.bytes ?? 0)),
      };
    });
  }

  async function onClearAll() {
    if (sessions.length === 0) return;
    const ok = await askConfirm(t("history.panel.clear"), { destructive: true });
    if (!ok) return;
    try {
      await historyClear();
    } catch (e) {
      setError(String(e));
      return;
    }
    setSessions([]);
    setSelected(null);
    setStats({ sessions: 0, bytes: 0 });
  }

  function runFind(forward: boolean) {
    const addon = searchAddonRef.current;
    if (!addon || !searchQuery) return;
    if (forward) addon.findNext(searchQuery);
    else addon.findPrevious(searchQuery);
  }

  function closeSearch() {
    setSearchOpen(false);
    setSearchQuery("");
    searchAddonRef.current?.clearDecorations?.();
    // Return focus to the replay terminal so wheel/Ctrl+F keep working.
    termRef.current?.focus();
  }

  function modeLabel(mode: string): string {
    if (mode === "light") return t("history.panel.mode_light");
    if (mode === "full") return t("history.panel.mode_full");
    return mode;
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      {...backdropProps}
    >
      <div
        {...contentProps}
        className="nx-modal-enter w-full max-w-6xl h-[85vh] flex flex-col bg-nx-bg border border-nx-border rounded-nx shadow-glow-md overflow-hidden"
      >
        {/* Header */}
        <div className="flex items-center gap-2 px-4 py-3 border-b border-nx-divider shrink-0">
          <h2 className="text-lg font-mono text-nx-accent">&gt; history</h2>
          <span className="text-meta text-nx-muted font-mono truncate">
            {t("history.panel.title")}
          </span>
          {!locked && (
            <span className="text-meta text-nx-muted font-mono">
              {t("history.panel.usage", {
                count: stats.sessions,
                size: fmtBytes(stats.bytes),
              })}
            </span>
          )}
          <Button
            variant="secondary"
            size="sm"
            leadingIcon={<Trash2 size={12} />}
            onClick={onClearAll}
            disabled={locked || sessions.length === 0}
          >
            {t("history.panel.clear")}
          </Button>
          {selected && (
            <IconButton
              className="ml-auto"
              icon={<Search size={14} />}
              onClick={() => openSearchRef.current()}
              title={t("history.panel.search_placeholder")}
            />
          )}
          <IconButton
            className={selected ? undefined : "ml-auto"}
            icon={<span className="text-base leading-none">×</span>}
            onClick={onClose}
            title={t("tabmenu.close")}
          />
        </div>

        {/* Body */}
        <div className="flex-1 min-h-0 flex">
          {locked ? (
            <div className="flex-1 flex items-center justify-center text-nx-muted font-mono text-body gap-2">
              <Lock size={16} /> {t("history.panel.locked")}
            </div>
          ) : loading ? (
            <div className="flex-1 flex items-center justify-center text-nx-muted font-mono text-body gap-2">
              <Loader2 size={16} className="animate-spin" />
            </div>
          ) : sessions.length === 0 ? (
            <div className="flex-1 flex items-center justify-center text-nx-muted font-mono text-body">
              {t("history.panel.empty")}
            </div>
          ) : (
            <>
              {/* Left: recording list */}
              <div className="w-80 shrink-0 border-r border-nx-divider overflow-y-auto">
                {sessions.map((s) => {
                  const isSel = s.id === selected;
                  return (
                    <div
                      key={s.id}
                      data-active={isSel || undefined}
                      onClick={() => setSelected(s.id)}
                      className="nx-row px-3.5 py-2.5 cursor-pointer text-body select-none border-b border-nx-divider"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <span
                          className={
                            "truncate font-mono " +
                            (isSel ? "text-nx-accent" : "text-nx-text")
                          }
                        >
                          {s.label}
                        </span>
                        <span className="ml-auto shrink-0 inline-flex items-center px-1.5 text-[9px] uppercase tracking-wider rounded-sm border border-nx-border bg-nx-elevated text-nx-soft">
                          {modeLabel(s.mode)}
                        </span>
                        {s.truncated && (
                          <span className="shrink-0 inline-flex items-center px-1.5 text-[9px] uppercase tracking-wider rounded-sm border border-[rgba(245,215,110,0.35)] bg-nx-elevated text-nx-warning">
                            {t("history.panel.truncated")}
                          </span>
                        )}
                      </div>
                      <div className="mt-1 flex items-center gap-2 text-meta text-nx-muted tabular-nums">
                        <span className="truncate">{fmtDate(s.start)}</span>
                        <span className="ml-auto shrink-0">
                          {fmtDuration(s.start, s.end)}
                        </span>
                        <span className="shrink-0 text-nx-dim">
                          {fmtBytes(s.bytes)}
                        </span>
                        <button
                          onClick={(ev) => {
                            ev.stopPropagation();
                            onDelete(s.id);
                          }}
                          className="shrink-0 text-nx-muted hover:text-nx-error"
                          title={t("history.panel.delete")}
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Right: replay */}
              <div className="flex-1 min-w-0 relative">
                {!selected ? (
                  <div className="absolute inset-0 flex items-center justify-center text-nx-muted font-mono text-body">
                    {t("history.panel.select")}
                  </div>
                ) : (
                  <>
                    {replayLoading && (
                      <div className="absolute top-2 right-3 z-10 text-nx-accent">
                        <Loader2 size={14} className="animate-spin" />
                      </div>
                    )}
                    {searchOpen && (
                      <div className="absolute top-2 left-3 z-10 flex items-center gap-1 px-1.5 py-1 bg-nx-panel border border-nx-border rounded-nx shadow-glow-md font-mono">
                        <Search size={12} className="text-nx-muted shrink-0" />
                        <input
                          ref={searchInputRef}
                          value={searchQuery}
                          onChange={(e) => {
                            setSearchQuery(e.target.value);
                            const addon = searchAddonRef.current;
                            if (addon && e.target.value)
                              addon.findNext(e.target.value);
                          }}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              e.preventDefault();
                              runFind(!e.shiftKey);
                            } else if (e.key === "Escape") {
                              e.preventDefault();
                              closeSearch();
                            }
                          }}
                          placeholder={t("history.panel.search_placeholder")}
                          className="w-44 bg-transparent text-meta text-nx-text placeholder:text-nx-muted outline-none"
                        />
                        <button
                          onClick={() => runFind(false)}
                          className="shrink-0 text-nx-muted hover:text-nx-text px-0.5"
                          title={t("history.panel.find_prev")}
                        >
                          ‹
                        </button>
                        <button
                          onClick={() => runFind(true)}
                          className="shrink-0 text-nx-muted hover:text-nx-text px-0.5"
                          title={t("history.panel.find_next")}
                        >
                          ›
                        </button>
                        <button
                          onClick={closeSearch}
                          className="shrink-0 text-nx-muted hover:text-nx-error"
                          title={t("history.panel.clear_search")}
                        >
                          <X size={12} />
                        </button>
                      </div>
                    )}
                    <div
                      ref={termContainerRef}
                      className="w-full h-full"
                      onWheel={(e) => {
                        // WebKitGTK/WebView2 don't reliably forward wheel to the
                        // xterm viewport, so drive scrollback ourselves (same as
                        // the live terminal). ~3 lines per notch.
                        const term = termRef.current;
                        if (term)
                          term.scrollLines(e.deltaY > 0 ? 3 : -3);
                      }}
                      style={{ background: THEMES[settings.theme].bgBase }}
                    />
                  </>
                )}
              </div>
            </>
          )}
        </div>

        {/* Footer status */}
        <div className="px-4 py-2 border-t border-nx-divider font-mono text-meta shrink-0 flex items-center gap-2">
          {error ? (
            <span className="text-nx-error truncate">✗ {error}</span>
          ) : (
            <span className="text-nx-muted">
              {t("history.panel.usage", {
                count: stats.sessions,
                size: fmtBytes(stats.bytes),
              })}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
