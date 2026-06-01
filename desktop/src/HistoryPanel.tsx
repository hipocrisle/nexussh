// HistoryPanel — список всех записанных сессий + viewer на основе xterm.js.
// Killer-фича: можно листать вверх и видеть всё что было в Claude Code /
// vim / htop сессии даже после выхода из alt-screen-buffer.
//
// Архитектура viewer-а:
//   1. Создаём скрытый xterm.js Terminal с огромным scrollback (1M).
//   2. Из cast-файла читаем event'ы: { t: float, d: utf8-chunk }.
//   3. Перед записью в term фильтруем alt-buffer toggles (ESC[?1049h/l,
//      ESC[?47h/l, ESC[?1047h/l) — так все redraw'ы Claude Code et al.
//      аккумулируются в main buffer как нормальная скроллируемая история,
//      а не теряются в alt-screen.
//   4. После replay показываем терминал read-only, с поиском по буферу.

import { useState, useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { save } from "@tauri-apps/plugin-dialog";
import {
  Trash2,
  Download,
  Search,
  X,
  RefreshCw,
  Maximize2,
  Minimize2,
} from "lucide-react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import "@xterm/xterm/css/xterm.css";
import {
  HistoryEntry,
  SearchHit,
  historyList,
  historyReadEvents,
  historyDelete,
  historySearch,
  historyExport,
  fmtTs,
  fmtBytes,
  filterAltBuffer,
  isTmuxStatusLine,
  stripAnsiString,
  CastEvent,
} from "./history";
import { useSettings } from "./settings/settings-store";
import { useIsMobile } from "./useIsMobile";
import { THEMES, xtermThemeOf, ThemePalette } from "./settings/themes";
import { fontStackOf } from "./settings/fonts";
import { useBackdropClose } from "./useBackdropClose";
import { ContextMenu, MenuItem } from "./ContextMenu";
import { Button, IconButton } from "./components/primitives";

interface Props {
  onClose: () => void;
}

// xterm.js needs literal colors — CSS vars don't resolve in its theme spec.
// Build search-decoration colors from the active theme palette.
function searchDecorations(t: ThemePalette) {
  return {
    matchBackground: t.border,
    matchBorder: t.accent,
    matchOverviewRuler: t.accent,
    activeMatchBackground: t.accent,
    activeMatchBorder: t.accent,
    activeMatchColorOverviewRuler: t.accent2,
  };
}

const FULLSCREEN_LS_KEY = "nexussh.historyFullscreen";
// Same key as TranscriptOverlay — one Plain toggle for both replay surfaces.
const PLAIN_LS_KEY = "nexussh.transcriptPlainText";

export function HistoryPanel({ onClose }: Props) {
  const { t } = useTranslation();
  const [settings] = useSettings();
  const palette = THEMES[settings.theme];
  // Used implicitly via max-md: Tailwind classes; no JS branch needed yet.
  useIsMobile();
  const [fullscreen, setFullscreen] = useState<boolean>(
    () => localStorage.getItem(FULLSCREEN_LS_KEY) === "1",
  );
  function toggleFullscreen() {
    setFullscreen((v) => {
      const next = !v;
      localStorage.setItem(FULLSCREEN_LS_KEY, next ? "1" : "0");
      return next;
    });
  }
  const [plainText, setPlainText] = useState<boolean>(() => {
    const v = localStorage.getItem(PLAIN_LS_KEY);
    return v === null ? true : v === "1";
  });
  function togglePlain() {
    setPlainText((v) => {
      const next = !v;
      localStorage.setItem(PLAIN_LS_KEY, next ? "1" : "0");
      return next;
    });
  }
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [events, setEvents] = useState<CastEvent[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [inSessionQuery, setInSessionQuery] = useState("");
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
  const { backdropProps, contentProps } = useBackdropClose(onClose);

  const termContainerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const searchRef = useRef<SearchAddon | null>(null);

  const refresh = async () => {
    try {
      const list = await historyList();
      setEntries(list);
    } catch (e) {
      setError(String(e));
    }
  };

  useEffect(() => {
    refresh();
  }, []);

  // Load selected session events
  useEffect(() => {
    if (!selectedId) {
      setEvents(null);
      return;
    }
    setLoading(true);
    setError(null);
    historyReadEvents(selectedId)
      .then(setEvents)
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [selectedId]);

  // Init xterm once
  useEffect(() => {
    if (!termContainerRef.current) return;
    const term = new Terminal({
      theme: xtermThemeOf(palette),
      fontFamily: fontStackOf(settings.font),
      fontSize: 13,
      cursorBlink: false,
      scrollback: 1_000_000,
      disableStdin: true,
      allowProposedApi: true,
      convertEol: false,
    });
    const fit = new FitAddon();
    const search = new SearchAddon();
    term.loadAddon(fit);
    term.loadAddon(search);
    term.open(termContainerRef.current);
    fit.fit();
    termRef.current = term;
    fitRef.current = fit;
    searchRef.current = search;

    // Direct DOM viewport scroll for reliability
    const viewport = termContainerRef.current.querySelector(
      ".xterm-viewport",
    ) as HTMLElement | null;
    const wheelHandler = (ev: WheelEvent) => {
      if (!viewport) return;
      viewport.scrollTop += ev.deltaY;
      ev.preventDefault();
    };
    termContainerRef.current.addEventListener("wheel", wheelHandler, {
      passive: false,
    });

    const onWinResize = () => fit.fit();
    window.addEventListener("resize", onWinResize);
    return () => {
      window.removeEventListener("resize", onWinResize);
      termContainerRef.current?.removeEventListener("wheel", wheelHandler);
      term.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Live theme/font updates — xterm needs explicit refresh after options swap
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.theme = xtermThemeOf(palette);
    term.options.fontFamily = fontStackOf(settings.font);
    type WithClear = { clearTextureAtlas?: () => void };
    (term as unknown as WithClear).clearTextureAtlas?.();
    term.refresh(0, term.rows - 1);
  }, [settings.theme, settings.font, palette]);

  // Re-fit when fullscreen toggle changes the container size, otherwise the
  // xterm canvas stays at its prior cols/rows in the giant new modal.
  useEffect(() => {
    if (!fitRef.current) return;
    // Two frames: one for the layout to settle, one for fit to take effect.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => fitRef.current?.fit());
    });
  }, [fullscreen]);

  // Replay events into xterm.
  //
  // Two modes — same as TranscriptOverlay:
  //   • Plain (default): stripAnsiString + dedup adjacent identical lines.
  //     Best for TUI sessions (Claude Code / vim / htop), which redraw
  //     via cursor positioning and produce a wall of overlapping moves
  //     in colored replay.
  //   • Color: drop the whole alt-screen window, let xterm render the
  //     rest with SGR colors intact. Good for sessions that mostly stayed
  //     in the main buffer.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.reset();
    if (!events) return;
    fitRef.current?.fit();

    const full = events.map((e) => e.d).join("");
    let cleaned = plainText ? stripAnsiString(full) : filterAltBuffer(full);
    if (plainText) {
      // Sliding-window dedup — see TranscriptOverlay for full rationale.
      const WINDOW = 200;
      const recentSet = new Set<string>();
      const recentList: string[] = [];
      const lines = cleaned.split(/\r\n|\n/);
      const dedup: string[] = [];
      for (const ln of lines) {
        if (ln.trim() === "") {
          if (dedup.length === 0 || dedup[dedup.length - 1] !== "") dedup.push("");
          continue;
        }
        if (recentSet.has(ln)) continue;
        dedup.push(ln);
        recentSet.add(ln);
        recentList.push(ln);
        if (recentList.length > WINDOW) {
          const evict = recentList.shift()!;
          recentSet.delete(evict);
        }
      }
      cleaned = dedup.join("\r\n");
    }
    const parts = cleaned.split(/(\r\n|\n)/);
    for (let i = 0; i < parts.length; i += 2) {
      const line = parts[i];
      const sep = parts[i + 1] ?? "";
      if (line && sep && isTmuxStatusLine(line)) continue;
      term.write(line + sep);
    }

    term.scrollToTop();
    requestAnimationFrame(() => fitRef.current?.fit());
  }, [events, plainText]);

  // In-session search: highlight current match on submit
  useEffect(() => {
    const search = searchRef.current;
    if (!search) return;
    if (!inSessionQuery.trim()) return;
    search.findNext(inSessionQuery, {
      caseSensitive: false,
      decorations: searchDecorations(palette),
    });
  }, [inSessionQuery]);

  async function runSearch() {
    setError(null);
    if (!query.trim()) {
      setHits(null);
      return;
    }
    try {
      const h = await historySearch(query);
      setHits(h);
    } catch (e) {
      setError(String(e));
    }
  }

  async function onDelete(id: string) {
    if (!confirm(t("history.delete_confirm"))) return;
    try {
      await historyDelete(id);
      if (selectedId === id) setSelectedId(null);
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  }

  async function onExport(id: string, strip: boolean) {
    try {
      const p = await save({
        title: t("history.export_title"),
        defaultPath: `nexussh-${id.slice(0, 8)}.${strip ? "txt" : "cast"}`,
      });
      if (typeof p === "string") {
        await historyExport(id, p, strip);
      }
    } catch (e) {
      setError(String(e));
    }
  }

  const filteredEntries = useMemo(() => {
    if (hits === null) return entries;
    const allowed = new Set(hits.map((h) => h.session_id));
    return entries.filter((e) => allowed.has(e.session_id));
  }, [entries, hits]);

  const selectedMeta = entries.find((e) => e.session_id === selectedId);
  const durationLabel = useMemo(() => {
    if (!events || events.length === 0) return null;
    const lastT = events[events.length - 1].t;
    if (lastT < 60) return `${lastT.toFixed(1)}s`;
    if (lastT < 3600) return `${(lastT / 60).toFixed(1)}m`;
    return `${(lastT / 3600).toFixed(1)}h`;
  }, [events]);

  // Match counts per session from the cross-session search hits (real data).
  const matchCounts = useMemo(() => {
    const m = new Map<string, number>();
    if (hits) for (const h of hits) m.set(h.session_id, (m.get(h.session_id) ?? 0) + 1);
    return m;
  }, [hits]);
  const matchingSessions = matchCounts.size;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm"
      {...backdropProps}
    >
      <div
        {...contentProps}
        className={
          fullscreen
            ? "nx-modal-enter w-screen h-screen bg-nx-bg flex flex-col overflow-hidden"
            : "nx-modal-enter w-full max-w-7xl h-[90vh] bg-nx-bg border border-nx-border rounded-nx shadow-glow-md flex flex-col overflow-hidden"
        }
      >
        {/* Header */}
        <div className="nx-safe-top flex items-center px-4 py-3 border-b border-nx-divider shrink-0">
          <span className="text-h3 font-mono text-nx-accent">&gt;</span>
          <span className="ml-2 text-body font-mono text-nx-text">{t("history.title")}</span>
          <span className="ml-3 text-meta font-mono italic text-nx-muted">
            — {t("history.subtitle")}
          </span>
          <div className="ml-auto flex items-center gap-1.5">
            <button
              onClick={togglePlain}
              title={t("history.plain_text_hint")}
              className={
                "h-7 px-2 rounded text-meta font-mono border " +
                (plainText
                  ? "border-nx-accent text-nx-accent bg-nx-accent/10"
                  : "border-nx-divider text-nx-muted hover:text-nx-text")
              }
            >
              {plainText ? t("history.plain_on") : t("history.plain_off")}
            </button>
            <IconButton icon={<RefreshCw size={13} />} onClick={refresh} title={t("history.refresh")} />
            <IconButton
              icon={fullscreen ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
              onClick={toggleFullscreen}
              title={fullscreen ? t("history.exit_fullscreen") : t("history.fullscreen")}
            />
            <IconButton icon={<X size={13} />} onClick={onClose} />
          </div>
        </div>

        {/* Cross-session search */}
        <div className="flex items-center gap-3 px-3.5 py-2.5 border-b border-nx-divider shrink-0">
          <div className="relative flex-1 max-w-[540px]">
            <Search
              size={12}
              className="absolute left-2.5 top-1/2 -translate-y-1/2 text-nx-accent pointer-events-none"
            />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && runSearch()}
              placeholder={t("history.search_all_ph")}
              className="nx-focus w-full pl-7 pr-2 py-1.5 bg-nx-panel border border-nx-border rounded-nx text-body text-nx-text placeholder-nx-muted font-mono"
            />
          </div>
          <Button variant="secondary" size="sm" onClick={runSearch}>
            {t("history.search_btn")}
          </Button>
          {hits !== null && (
            <>
              <span className="text-meta text-nx-muted tabular-nums">
                <span className="text-nx-accent">{hits.length}</span> {t("history.matches")}{" "}
                {t("history.matches_in")}{" "}
                <span className="text-nx-text">{matchingSessions}</span> {t("history.sessions")}
              </span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setHits(null);
                  setQuery("");
                }}
              >
                {t("history.clear_search")}
              </Button>
            </>
          )}
        </div>

        {error && (
          <div className="px-4 py-2 text-nx-error text-meta font-mono border-b border-nx-divider shrink-0 break-all">
            ✗ {error}
          </div>
        )}

        {/* Two-pane. Mobile: stack vertically — sessions list on top with
         *  capped height, content below. The 288px-wide rail only leaves
         *  ~120px for content on a phone. */}
        <div className="flex-1 min-h-0 flex max-md:flex-col">
          {/* Sessions list */}
          <div className="w-72 shrink-0 border-r border-nx-border overflow-y-auto max-md:w-full max-md:border-r-0 max-md:border-b max-md:max-h-[40vh]">
            {filteredEntries.length === 0 ? (
              <div className="p-4 text-meta text-nx-muted font-mono">
                {hits !== null ? t("history.no_hits") : t("history.empty")}
              </div>
            ) : (
              filteredEntries.map((e) => {
                const isActive = selectedId === e.session_id;
                const mc = matchCounts.get(e.session_id) ?? 0;
                return (
                  <div
                    key={e.session_id}
                    data-active={isActive || undefined}
                    onClick={() => setSelectedId(e.session_id)}
                    className="nx-row group grid grid-cols-[1fr_auto] gap-1 px-3.5 py-2.5 cursor-pointer"
                  >
                    <div className="min-w-0">
                      <div
                        className={
                          "font-mono text-lead truncate " +
                          (isActive ? "text-nx-accent" : "text-nx-text")
                        }
                      >
                        {e.user}@{e.host}
                        {e.port !== 22 && `:${e.port}`}
                      </div>
                      <div className="font-mono text-meta text-nx-muted mt-0.5 flex items-center gap-2">
                        <span>{fmtTs(e.started_at)}</span>
                        <span>·</span>
                        <span className="tabular-nums">{fmtBytes(e.byte_count)}</span>
                        {e.still_active && <span className="text-nx-accent">● live</span>}
                      </div>
                    </div>
                    <div className="flex flex-col items-end justify-between">
                      <button
                        onClick={(ev) => {
                          ev.stopPropagation();
                          onDelete(e.session_id);
                        }}
                        title={t("history.delete")}
                        className="opacity-0 group-hover:opacity-100 p-1 rounded-nx-sm hover:bg-nx-elevated text-nx-error"
                      >
                        <Trash2 size={12} />
                      </button>
                      {mc > 0 && (
                        <span className="text-micro text-nx-accent tabular-nums whitespace-nowrap">
                          {mc} {t("history.matches")}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>

          {/* Viewer */}
          <div className="flex-1 min-w-0 flex flex-col relative">
            {selectedId && (
              <>
                <div className="flex items-center gap-2 px-3.5 py-2 border-b border-nx-divider shrink-0 text-meta font-mono">
                  {selectedMeta && (
                    <span className="text-nx-muted">
                      {selectedMeta.user}@{selectedMeta.host} ·{" "}
                      <span className="text-nx-soft">{fmtTs(selectedMeta.started_at)}</span>
                      {durationLabel && (
                        <>
                          {" · "}
                          <span className="text-nx-soft">{durationLabel}</span>
                        </>
                      )}
                      {" · "}
                      <span>
                        {events?.length ?? 0} {t("history.chunks")}
                      </span>
                    </span>
                  )}
                  <div className="ml-auto relative w-64">
                    <Search
                      size={12}
                      className="absolute left-2.5 top-1/2 -translate-y-1/2 text-nx-muted pointer-events-none"
                    />
                    <input
                      value={inSessionQuery}
                      onChange={(e) => setInSessionQuery(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          searchRef.current?.findNext(inSessionQuery, {
                            caseSensitive: false,
                            decorations: searchDecorations(palette),
                          });
                        }
                      }}
                      placeholder={t("history.filter_in_session_ph")}
                      className="nx-focus w-full pl-7 pr-2 py-1.5 bg-nx-panel border border-nx-border rounded-nx text-body text-nx-text placeholder-nx-muted font-mono"
                    />
                  </div>
                  <IconButton
                    icon={<span className="text-xs leading-none">↑</span>}
                    title={t("history.find_prev")}
                    onClick={() =>
                      searchRef.current?.findPrevious(inSessionQuery, {
                        caseSensitive: false,
                        decorations: searchDecorations(palette),
                      })
                    }
                  />
                  <IconButton
                    icon={<span className="text-xs leading-none">↓</span>}
                    title={t("history.find_next")}
                    onClick={() =>
                      searchRef.current?.findNext(inSessionQuery, {
                        caseSensitive: false,
                        decorations: searchDecorations(palette),
                      })
                    }
                  />
                  <Button
                    variant="secondary"
                    size="sm"
                    leadingIcon={<Download size={12} />}
                    onClick={() => onExport(selectedId, true)}
                    title={t("history.export_stripped")}
                  >
                    .txt
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    leadingIcon={<Download size={12} />}
                    onClick={() => onExport(selectedId, false)}
                    title={t("history.export_raw")}
                  >
                    .cast
                  </Button>
                </div>
                {loading && (
                  <div className="px-3 py-1 text-nx-soft font-mono text-meta">
                    {t("history.loading")}
                  </div>
                )}
              </>
            )}
            {!selectedId && (
              <div className="absolute inset-0 grid place-items-center text-nx-muted font-mono text-meta z-10 pointer-events-none">
                {t("history.select_session")}
              </div>
            )}
            {/* xterm container always mounted so termRef stays valid */}
            <div
              ref={termContainerRef}
              onContextMenu={(e) => {
                // xterm's helper-textarea swallows right-clicks, so the
                // app-wide native context menu never fires here. Wire a
                // dedicated one with Copy-selection (history is read-only,
                // so paste/cut don't apply).
                e.preventDefault();
                e.stopPropagation();
                setCtxMenu({ x: e.clientX, y: e.clientY });
              }}
              className="flex-1 min-h-0 bg-nx-bg p-1"
            />
            {ctxMenu && (() => {
              const term = termRef.current;
              const sel = term?.getSelection() ?? "";
              const items: MenuItem[] = [
                {
                  label: t("ctx.copy"),
                  disabled: !sel,
                  onClick: () => {
                    if (sel) navigator.clipboard.writeText(sel).catch(() => {});
                  },
                },
                {
                  label: t("ctx.select_all"),
                  onClick: () => term?.selectAll(),
                },
              ];
              return (
                <ContextMenu
                  x={ctxMenu.x}
                  y={ctxMenu.y}
                  items={items}
                  onClose={() => setCtxMenu(null)}
                />
              );
            })()}
          </div>
        </div>
      </div>
    </div>
  );
}
