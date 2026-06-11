// HistoryPanel — fullscreen overlay for browsing & replaying recorded sessions.
//
// Left column: list of recordings (newest first, straight from the backend).
// Main area: a HEADLESS xterm.js instance that replays the selected recording
// by writing every recorded byte verbatim — NO ANSI filtering, NO dedup. That
// honesty is deliberate: any cleverness on replay corrupts cursor/redraw state.
//
// Recordings are stored encrypted under the vault key, so list/read throw a
// "vault locked"-ish error when the vault is locked; we surface that as a hint.

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import {
  Loader2,
  Trash2,
  Lock,
  Search,
  X,
  ChevronRight,
  ChevronDown,
  ChevronsDownUp,
} from "lucide-react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon, ISearchOptions } from "@xterm/addon-search";
import "@xterm/xterm/css/xterm.css";
import {
  SessionMeta,
  SearchResult,
  historyList,
  historyRead,
  historySearch,
  historyDelete,
  historyClear,
  historyStats,
} from "./history";
import { useBackdropClose } from "./useBackdropClose";
import { writeClipboard } from "./clipboard";
import { ContextMenu, MenuItem } from "./ContextMenu";
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

/** Compact "last activity" label for a host node. Falls back to a plain date
 *  for anything older than ~a week. `t` is the i18next translator. */
function fmtRelative(start: number, nowSec: number, t: TFunction): string {
  const diff = Math.max(0, nowSec - start);
  if (diff < 60) return t("history.panel.rel_now");
  if (diff < 3600) return t("history.panel.rel_min", { n: Math.floor(diff / 60) });
  if (diff < 86400) return t("history.panel.rel_hour", { n: Math.floor(diff / 3600) });
  const days = Math.floor(diff / 86400);
  if (days === 1) return t("history.panel.rel_yesterday");
  if (days < 7) return t("history.panel.rel_day", { n: days });
  return new Date(start * 1000).toLocaleDateString();
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

  // Recordings grouped under their host (#287). The flat list became a dump once
  // dozens of sessions piled up, so we collapse them under one node per host and
  // remember which nodes are open (in localStorage). Default: everything closed.
  const [expandedHosts, setExpandedHosts] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem("nx.history.expandedHosts");
      if (raw) return new Set<string>(JSON.parse(raw));
    } catch {
      /* ignore corrupt/absent state */
    }
    return new Set();
  });
  useEffect(() => {
    try {
      localStorage.setItem(
        "nx.history.expandedHosts",
        JSON.stringify([...expandedHosts]),
      );
    } catch {
      /* storage full / unavailable — non-fatal */
    }
  }, [expandedHosts]);

  const termContainerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const searchAddonRef = useRef<SearchAddon | null>(null);

  // Search decorations: OUTLINE ONLY — no background fill. A coloured fill over
  // the terminal's own coloured glyphs muddied the text to the point of being
  // unreadable, so we mark matches with a crisp border (active match = a much
  // fainter fill + brighter border so it still stands out) and leave the glyphs
  // completely untouched. Overview-ruler ticks (required fields) show positions.
  const palette = THEMES[settings.theme];
  const searchOpts: ISearchOptions = {
    decorations: {
      // Outline-only, dimmed. No background fill at all (a fill over coloured
      // terminal glyphs was unreadable). Each hit gets a soft ~60% border; the
      // active hit is distinguished by HUE (warning vs accent2), not brightness,
      // so nothing is harsh. Overview-ruler ticks (required) stay solid.
      matchBorder: `${palette.accent2}99`,
      matchOverviewRuler: palette.accent2,
      activeMatchBorder: `${palette.warning}aa`,
      activeMatchColorOverviewRuler: palette.warning,
    },
  };
  // Stash in a ref so the live find-bar onChange/onKeyDown handlers and the
  // term-effect closures always use the current theme's options.
  const searchOptsRef = useRef(searchOpts);
  searchOptsRef.current = searchOpts;

  // In-replay find bar — only meaningful while a recording is selected.
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  // Live match counter, driven by SearchAddon.onDidChangeResults.
  const [searchInfo, setSearchInfo] = useState<{ idx: number; count: number }>({
    idx: -1,
    count: 0,
  });
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Global search across ALL recordings (#284). Backed by `history_search`;
  // when the query is non-empty the left list shows matching recordings (with
  // hit counts + a snippet) instead of the full session list.
  const [globalQuery, setGlobalQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[] | null>(
    null,
  );
  const [searching, setSearching] = useState(false);
  // Query to jump to inside a replay once it has finished loading (set when a
  // global-search result is clicked, consumed by the auto-jump effect below).
  const pendingJumpRef = useRef<string | null>(null);

  // Right-click context menu over the replay terminal (mirrors Terminal.tsx's
  // ctxHandler, minus the dead-PTY actions: paste/clear/send).
  const [ctxMenu, setCtxMenu] = useState<{
    x: number;
    y: number;
    items: MenuItem[];
  } | null>(null);

  // Latest settings in a ref so the mount-once term effect's mouse handlers see
  // the current puttyMouse value without re-creating the terminal.
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  // Ctrl+F / right-click "Find" inside the replay focus the ONE search box (the
  // global one in the left column) — there is no separate in-replay search input.
  const openSearchRef = useRef<() => void>(() => {});
  openSearchRef.current = () => {
    requestAnimationFrame(() => searchInputRef.current?.focus());
  };
  // Esc handler for the replay terminal's key handler (which closes over stale
  // state). Re-assigned every render so it sees the live searchOpen value:
  // close the find bar if open, otherwise close the whole panel.
  const escapeRef = useRef<() => void>(() => {});
  escapeRef.current = () => {
    if (searchOpen) closeSearch();
    else onClose();
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
    setSearchInfo({ idx: -1, count: 0 });
    setCtxMenu(null);

    // Re-create the terminal for this recording (clean buffer + fresh parser).
    disposeTerm();
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
      // Esc while focus is inside the replay terminal: xterm normally swallows
      // it, so useBackdropClose never sees it. Handle it here — if the find bar
      // is open, close just the search; otherwise close the whole panel.
      if (ev.key === "Escape") {
        escapeRef.current();
        return false;
      }
      return true;
    });

    // Live match counter — fires whenever decorations recompute (findNext/Prev,
    // incremental typing). resultIndex is 0-based (or -1 when none/over limit),
    // resultCount the total. We mirror it into searchInfo for the find-bar.
    const resultsDisposable = searchAddon.onDidChangeResults(
      ({ resultIndex, resultCount }) => {
        setSearchInfo({ idx: resultIndex, count: resultCount });
      },
    );

    // PuTTY-style mouse: releasing a drag-selection auto-copies it (same as
    // Terminal.tsx's mouseupHandler). 0-ms timer lets xterm finalize selection.
    const mouseupHandler = () => {
      if (!settingsRef.current.puttyMouse) return;
      setTimeout(() => {
        const sel = term.getSelection();
        if (sel) writeClipboard(sel);
      }, 0);
    };
    container.addEventListener("mouseup", mouseupHandler);

    // Right-click context menu — mirrors Terminal.tsx's ctxHandler but for a
    // dead replay terminal: only Copy / Select all / Find (no paste/clear/send).
    // Unlike the live terminal, PuTTY-mode does NOT paste here (nothing to paste
    // into) — right-click always opens this menu.
    const ctxHandler = (ev: MouseEvent) => {
      ev.preventDefault();
      const selection = term.getSelection();
      const items: MenuItem[] = [
        {
          label: t("term_menu.copy"),
          disabled: !selection,
          onClick: () => {
            const sel = term.getSelection();
            if (sel) writeClipboard(sel);
          },
        },
        {
          label: t("term_menu.select_all"),
          onClick: () => term.selectAll(),
        },
        { separator: true, label: "" },
        {
          label: t("history.panel.find"),
          onClick: () => openSearchRef.current(),
        },
      ];
      setCtxMenu({ x: ev.clientX, y: ev.clientY, items });
    };
    container.addEventListener("contextmenu", ctxHandler);

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
        // xterm.write() is ASYNC (queued + parsed off-thread). Wait for the
        // queue to fully drain before marking the replay ready — otherwise the
        // search auto-jump runs against a half-filled buffer and finds 0 matches
        // even when the recording clearly has many (the "11 hits → 0/0" bug).
        await new Promise<void>((resolve) => term.write("", () => resolve()));
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
      resultsDisposable.dispose();
      container.removeEventListener("mouseup", mouseupHandler);
      container.removeEventListener("contextmenu", ctxHandler);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  // Dispose on unmount.
  useEffect(() => {
    return () => disposeTerm();
  }, [disposeTerm]);

  // Debounced global search: re-query the backend when the box changes. A null
  // result means "no active search" (show the full list); [] means "searched,
  // no matches".
  useEffect(() => {
    const q = globalQuery.trim();
    if (!q) {
      setSearchResults(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    let alive = true;
    const h = setTimeout(async () => {
      try {
        const res = await historySearch(q);
        if (alive) setSearchResults(res);
      } catch (e) {
        if (alive) {
          setSearchResults([]);
          setError(String(e));
        }
      } finally {
        if (alive) setSearching(false);
      }
    }, 250);
    return () => {
      alive = false;
      clearTimeout(h);
    };
  }, [globalQuery]);

  // After a clicked search result's replay finishes loading, open the in-replay
  // find bar seeded with the query and jump to the first match.
  useEffect(() => {
    if (replayLoading || !selected) return;
    const q = pendingJumpRef.current;
    if (!q) return;
    pendingJumpRef.current = null;
    setSearchOpen(true);
    setSearchQuery(q);
    requestAnimationFrame(() => {
      searchAddonRef.current?.findNext(q, searchOptsRef.current);
    });
  }, [replayLoading, selected]);

  function openResult(meta: SessionMeta, q: string) {
    pendingJumpRef.current = q || null;
    setSelected(meta.id);
  }

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

  // Group recordings by host_id, newest-active host first. Sessions inside each
  // group keep the backend's newest-first order. Label = the most recent
  // session's label (they're identical per host in practice).
  const hostGroups = useMemo(() => {
    const map = new Map<
      string,
      { hostId: string; label: string; lastStart: number; sessions: SessionMeta[] }
    >();
    for (const s of sessions) {
      const g = map.get(s.host_id);
      if (!g) {
        map.set(s.host_id, {
          hostId: s.host_id,
          label: s.label,
          lastStart: s.start,
          sessions: [s],
        });
      } else {
        g.sessions.push(s);
        if (s.start > g.lastStart) {
          g.lastStart = s.start;
          g.label = s.label;
        }
      }
    }
    return [...map.values()].sort((a, b) => b.lastStart - a.lastStart);
  }, [sessions]);

  // Recomputed once per render — fine for relative "x ago" labels.
  const nowSec = Math.floor(Date.now() / 1000);
  const allExpanded =
    hostGroups.length > 0 && hostGroups.every((g) => expandedHosts.has(g.hostId));

  function toggleHost(id: string) {
    setExpandedHosts((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function toggleAll() {
    if (allExpanded) setExpandedHosts(new Set());
    else setExpandedHosts(new Set(hostGroups.map((g) => g.hostId)));
  }

  async function onDeleteHost(g: { sessions: SessionMeta[] }) {
    const ok = await askConfirm(
      t("history.panel.delete_host", { count: g.sessions.length }),
      { destructive: true },
    );
    if (!ok) return;
    const ids = g.sessions.map((s) => s.id);
    try {
      for (const id of ids) await historyDelete(id);
    } catch (e) {
      setError(String(e));
      return;
    }
    const idSet = new Set(ids);
    setSessions((prev) => prev.filter((s) => !idSet.has(s.id)));
    if (selected && idSet.has(selected)) setSelected(null);
    const removedBytes = g.sessions.reduce((n, s) => n + s.bytes, 0);
    setStats((prev) => ({
      sessions: Math.max(0, prev.sessions - ids.length),
      bytes: Math.max(0, prev.bytes - removedBytes),
    }));
  }

  function runFind(forward: boolean) {
    const addon = searchAddonRef.current;
    if (!addon || !searchQuery) return;
    if (forward) addon.findNext(searchQuery, searchOptsRef.current);
    else addon.findPrevious(searchQuery, searchOptsRef.current);
  }

  function closeSearch() {
    setSearchOpen(false);
    setSearchQuery("");
    setSearchInfo({ idx: -1, count: 0 });
    searchAddonRef.current?.clearDecorations?.();
    // Return focus to the replay terminal so wheel/Ctrl+F keep working.
    termRef.current?.focus();
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
          {selected && searchOpen && searchQuery && (
            // Match navigator (read-only). There is ONE search box — the global
            // one in the left column. Here we only navigate the matches of that
            // query inside the open recording: query text + idx/count + ‹ › + ×.
            <div className="ml-auto flex items-center gap-1.5 px-2 py-1 bg-nx-panel border border-nx-border rounded-nx font-mono">
              <Search size={12} className="text-nx-muted shrink-0" />
              <span
                className="text-meta text-nx-accent2 max-w-[160px] truncate"
                title={searchQuery}
              >
                {searchQuery}
              </span>
              <span className="shrink-0 text-micro tabular-nums text-nx-muted min-w-[2.5rem] text-right">
                {searchInfo.count > 0
                  ? `${searchInfo.idx + 1}/${searchInfo.count}`
                  : "0/0"}
              </span>
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
          <IconButton
            className={selected && searchOpen && searchQuery ? undefined : "ml-auto"}
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
              {/* Left: global search + recording list */}
              <div className="w-80 shrink-0 border-r border-nx-divider flex flex-col">
                <div className="shrink-0 px-2 py-2 border-b border-nx-divider">
                  <div className="flex items-center gap-1.5 px-2 py-1 bg-nx-panel border border-nx-border rounded-nx font-mono">
                    <Search size={12} className="text-nx-muted shrink-0" />
                    <input
                      ref={searchInputRef}
                      value={globalQuery}
                      onChange={(e) => setGlobalQuery(e.target.value)}
                      placeholder={t("history.panel.search_all")}
                      className="flex-1 min-w-0 bg-transparent text-meta text-nx-text placeholder:text-nx-muted outline-none"
                    />
                    {searching ? (
                      <Loader2
                        size={12}
                        className="shrink-0 text-nx-muted animate-spin"
                      />
                    ) : (
                      globalQuery && (
                        <button
                          onClick={() => setGlobalQuery("")}
                          className="shrink-0 text-nx-muted hover:text-nx-error"
                          title={t("history.panel.clear_search")}
                        >
                          <X size={12} />
                        </button>
                      )
                    )}
                  </div>
                </div>
                {searchResults === null && hostGroups.length > 0 && (
                  <div className="shrink-0 px-2 py-1 border-b border-nx-divider flex items-center">
                    <button
                      onClick={toggleAll}
                      className="flex items-center gap-1 text-micro font-mono text-nx-muted hover:text-nx-text"
                    >
                      <ChevronsDownUp size={12} className="shrink-0" />
                      {allExpanded
                        ? t("history.panel.collapse_all")
                        : t("history.panel.expand_all")}
                    </button>
                  </div>
                )}
                <div className="flex-1 overflow-y-auto">
                  {searchResults !== null ? (
                    searchResults.length === 0 ? (
                      <div className="px-3.5 py-6 text-center text-meta text-nx-muted font-mono">
                        {searching
                          ? t("history.panel.searching")
                          : t("history.panel.no_matches")}
                      </div>
                    ) : (
                      searchResults.map((r) => {
                        const s = r.meta;
                        const isSel = s.id === selected;
                        return (
                          <div
                            key={s.id}
                            data-active={isSel || undefined}
                            onClick={() => openResult(s, globalQuery.trim())}
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
                              <span className="ml-auto shrink-0 inline-flex items-center px-1.5 text-[9px] uppercase tracking-wider rounded-sm border border-nx-border bg-nx-elevated text-nx-accent2 tabular-nums">
                                {t("history.panel.hits", { count: r.hits })}
                              </span>
                            </div>
                            <div className="mt-1 text-meta text-nx-muted tabular-nums truncate">
                              {fmtDate(s.start)}
                            </div>
                            {r.snippets[0] && (
                              <div className="mt-1 text-micro text-nx-dim font-mono truncate">
                                {r.snippets[0]}
                              </div>
                            )}
                          </div>
                        );
                      })
                    )
                  ) : (
                    hostGroups.map((g) => {
                      const open = expandedHosts.has(g.hostId);
                      return (
                        <div key={g.hostId}>
                          {/* Host node — collapses/expands its sessions */}
                          <div
                            onClick={() => toggleHost(g.hostId)}
                            className="nx-row px-2.5 py-2 cursor-pointer text-body select-none border-b border-nx-divider flex items-center gap-1.5"
                          >
                            {open ? (
                              <ChevronDown
                                size={14}
                                className="shrink-0 text-nx-muted"
                              />
                            ) : (
                              <ChevronRight
                                size={14}
                                className="shrink-0 text-nx-muted"
                              />
                            )}
                            <span className="truncate font-mono text-nx-text flex-1 min-w-0">
                              {g.label}
                            </span>
                            <span className="shrink-0 text-meta text-nx-muted tabular-nums">
                              {fmtRelative(g.lastStart, nowSec, t)}
                            </span>
                            <span className="shrink-0 inline-flex items-center px-1.5 text-[10px] rounded-sm border border-nx-border bg-nx-elevated text-nx-soft tabular-nums">
                              {g.sessions.length}
                            </span>
                            <button
                              onClick={(ev) => {
                                ev.stopPropagation();
                                onDeleteHost(g);
                              }}
                              className="shrink-0 text-nx-muted hover:text-nx-error"
                              title={t("history.panel.delete")}
                            >
                              <Trash2 size={13} />
                            </button>
                          </div>
                          {/* Sessions under this host (indented) */}
                          {open &&
                            g.sessions.map((s) => {
                              const isSel = s.id === selected;
                              return (
                                <div
                                  key={s.id}
                                  data-active={isSel || undefined}
                                  onClick={() => setSelected(s.id)}
                                  className="nx-row pl-7 pr-3 py-2 cursor-pointer text-body select-none border-b border-nx-divider"
                                >
                                  <div className="flex items-center gap-2 min-w-0">
                                    <span
                                      className={
                                        "truncate font-mono text-meta tabular-nums " +
                                        (isSel
                                          ? "text-nx-accent"
                                          : "text-nx-text")
                                      }
                                    >
                                      {fmtDate(s.start)}
                                    </span>
                                    {s.truncated && (
                                      <span className="ml-auto shrink-0 inline-flex items-center px-1.5 text-[9px] uppercase tracking-wider rounded-sm border border-[rgba(245,215,110,0.35)] bg-nx-elevated text-nx-warning">
                                        {t("history.panel.truncated")}
                                      </span>
                                    )}
                                  </div>
                                  <div className="mt-1 flex items-center gap-2 text-meta text-nx-muted tabular-nums">
                                    <span className="shrink-0">
                                      {fmtDuration(s.start, s.end)}
                                    </span>
                                    <span className="ml-auto shrink-0 text-nx-dim">
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
                      );
                    })
                  )}
                </div>
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
      {ctxMenu && (
        <ContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          items={ctxMenu.items}
          onClose={() => setCtxMenu(null)}
        />
      )}
    </div>
  );
}
