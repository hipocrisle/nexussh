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
  CastEvent,
} from "./history";
import { useSettings } from "./settings/settings-store";
import { THEMES, xtermThemeOf, ThemePalette } from "./settings/themes";
import { fontStackOf } from "./settings/fonts";

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

export function HistoryPanel({ onClose }: Props) {
  const { t } = useTranslation();
  const [settings] = useSettings();
  const palette = THEMES[settings.theme];
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
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [events, setEvents] = useState<CastEvent[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [inSessionQuery, setInSessionQuery] = useState("");

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

  // Replay events into xterm
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.reset();
    if (!events) return;

    // Fit terminal to container BEFORE writing so wrap math is correct.
    fitRef.current?.fit();

    // Replay with a simple consecutive-line dedup: Claude Code's streaming
    // responses often emit the same paragraph multiple times as the model
    // re-flows text. We accumulate output into a buffer and skip lines that
    // are byte-identical to the immediately preceding one.
    let prevLine = "";
    const writeChunk = (s: string) => {
      const parts = s.split(/(\r\n|\n)/);
      for (let i = 0; i < parts.length; i += 2) {
        const line = parts[i];
        const sep = parts[i + 1] ?? "";
        if (line && sep && line === prevLine) {
          // skip the duplicate line + its newline
          continue;
        }
        term.write(line + sep);
        if (sep) prevLine = line;
      }
    };
    for (const ev of events) {
      writeChunk(filterAltBuffer(ev.d));
    }

    term.scrollToTop();
    requestAnimationFrame(() => fitRef.current?.fit());
  }, [events]);

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

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className={
          fullscreen
            ? "w-screen h-screen bg-[var(--nx-bg-base)] flex flex-col overflow-hidden"
            : "w-full max-w-7xl h-[90vh] bg-[var(--nx-bg-base)] border border-[var(--nx-border)] rounded-lg shadow-2xl flex flex-col overflow-hidden"
        }
      >
        {/* Header */}
        <div className="flex items-center px-4 py-3 border-b border-[var(--nx-border)] shrink-0">
          <h2 className="text-lg font-mono text-[var(--nx-accent)]">
            &gt; {t("history.title")}
          </h2>
          <p className="ml-3 text-xs text-[var(--nx-text-muted)] font-mono italic">
            {t("history.subtitle")}
          </p>
          <button
            onClick={refresh}
            title={t("history.refresh")}
            className="ml-auto p-1.5 rounded hover:bg-[var(--nx-border)] text-[var(--nx-text-soft)]"
          >
            <RefreshCw size={14} />
          </button>
          <button
            onClick={toggleFullscreen}
            title={
              fullscreen
                ? t("history.exit_fullscreen")
                : t("history.fullscreen")
            }
            className="ml-2 p-1.5 rounded hover:bg-[var(--nx-border)] text-[var(--nx-text-soft)]"
          >
            {fullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          </button>
          <button
            onClick={onClose}
            className="ml-2 p-1.5 rounded hover:bg-[var(--nx-border)] text-[var(--nx-text-soft)]"
          >
            <X size={14} />
          </button>
        </div>

        {/* Cross-session search */}
        <div className="flex items-center gap-2 px-4 py-2 border-b border-[var(--nx-border)] shrink-0">
          <Search size={14} className="text-[var(--nx-text-soft)]" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && runSearch()}
            placeholder={t("history.search_all_ph")}
            className="flex-1 bg-[var(--nx-bg-panel)] border border-[var(--nx-border)] rounded px-2 py-1 text-[var(--nx-text-primary)] focus:outline-none focus:border-[var(--nx-accent)] placeholder-[var(--nx-text-muted)] font-mono text-xs"
          />
          <button
            onClick={runSearch}
            className="px-3 py-1 bg-[var(--nx-bg-panel)] hover:bg-[var(--nx-border)] text-[var(--nx-text-soft)] font-mono text-xs rounded border border-[var(--nx-border)]"
          >
            {t("history.search_btn")}
          </button>
          {hits !== null && (
            <button
              onClick={() => {
                setHits(null);
                setQuery("");
              }}
              className="px-3 py-1 bg-[var(--nx-bg-panel)] hover:bg-[var(--nx-border)] text-[var(--nx-warning)] font-mono text-xs rounded border border-[var(--nx-border)]"
            >
              {t("history.clear_search")} ({hits.length})
            </button>
          )}
        </div>

        {error && (
          <div className="px-4 py-2 text-[var(--nx-error)] text-xs font-mono border-b border-[var(--nx-border)] shrink-0 break-all">
            ✗ {error}
          </div>
        )}

        {/* Two-pane */}
        <div className="flex-1 min-h-0 flex">
          {/* Sessions list */}
          <div className="w-72 shrink-0 border-r border-[var(--nx-border)] overflow-y-auto">
            {filteredEntries.length === 0 ? (
              <div className="p-4 text-xs text-[var(--nx-text-muted)] font-mono">
                {hits !== null ? t("history.no_hits") : t("history.empty")}
              </div>
            ) : (
              filteredEntries.map((e) => (
                <button
                  key={e.session_id}
                  onClick={() => setSelectedId(e.session_id)}
                  className={`w-full text-left px-3 py-2 border-b border-[var(--nx-border)] hover:bg-[var(--nx-bg-panel)] group ${
                    selectedId === e.session_id ? "bg-[var(--nx-bg-panel)]" : ""
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <div className="flex-1 min-w-0">
                      <div className="font-mono text-sm text-[var(--nx-text-primary)] truncate">
                        {e.user}@{e.host}
                        {e.port !== 22 && `:${e.port}`}
                      </div>
                      <div className="font-mono text-[10px] text-[var(--nx-text-muted)] flex gap-2">
                        <span>{fmtTs(e.started_at)}</span>
                        <span>·</span>
                        <span>{fmtBytes(e.byte_count)}</span>
                        {e.still_active && (
                          <span className="text-[var(--nx-accent)]">● live</span>
                        )}
                      </div>
                    </div>
                    <button
                      onClick={(ev) => {
                        ev.stopPropagation();
                        onDelete(e.session_id);
                      }}
                      title={t("history.delete")}
                      className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-[var(--nx-border)] text-[var(--nx-error)]"
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                </button>
              ))
            )}
          </div>

          {/* Viewer */}
          <div className="flex-1 min-w-0 flex flex-col relative">
            {selectedId && (
              <>
                <div className="flex items-center gap-2 px-3 py-2 border-b border-[var(--nx-border)] shrink-0 text-xs font-mono">
                  {selectedMeta && (
                    <span className="text-[var(--nx-text-muted)]">
                      {selectedMeta.user}@{selectedMeta.host} ·{" "}
                      <span className="text-[var(--nx-text-soft)]">
                        {fmtTs(selectedMeta.started_at)}
                      </span>
                      {durationLabel && (
                        <>
                          {" · "}
                          <span className="text-[var(--nx-text-soft)]">{durationLabel}</span>
                        </>
                      )}
                      {" · "}
                      <span>
                        {events?.length ?? 0} {t("history.chunks")}
                      </span>
                    </span>
                  )}
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
                    className="ml-auto w-64 bg-[var(--nx-bg-panel)] border border-[var(--nx-border)] rounded px-2 py-1 text-[var(--nx-text-primary)] focus:outline-none focus:border-[var(--nx-accent)] placeholder-[var(--nx-text-muted)] font-mono text-xs"
                  />
                  <button
                    onClick={() =>
                      searchRef.current?.findPrevious(inSessionQuery, {
                        caseSensitive: false,
                        decorations: searchDecorations(palette),
                      })
                    }
                    title={t("history.find_prev")}
                    className="px-2 py-1 bg-[var(--nx-bg-panel)] hover:bg-[var(--nx-border)] text-[var(--nx-text-soft)] font-mono text-xs rounded border border-[var(--nx-border)]"
                  >
                    ↑
                  </button>
                  <button
                    onClick={() =>
                      searchRef.current?.findNext(inSessionQuery, {
                        caseSensitive: false,
                        decorations: searchDecorations(palette),
                      })
                    }
                    title={t("history.find_next")}
                    className="px-2 py-1 bg-[var(--nx-bg-panel)] hover:bg-[var(--nx-border)] text-[var(--nx-text-soft)] font-mono text-xs rounded border border-[var(--nx-border)]"
                  >
                    ↓
                  </button>
                  <button
                    onClick={() => onExport(selectedId, true)}
                    title={t("history.export_stripped")}
                    className="px-2 py-1 bg-[var(--nx-bg-panel)] hover:bg-[var(--nx-border)] text-[var(--nx-text-soft)] font-mono text-xs rounded border border-[var(--nx-border)] flex items-center gap-1"
                  >
                    <Download size={12} /> .txt
                  </button>
                  <button
                    onClick={() => onExport(selectedId, false)}
                    title={t("history.export_raw")}
                    className="px-2 py-1 bg-[var(--nx-bg-panel)] hover:bg-[var(--nx-border)] text-[var(--nx-text-soft)] font-mono text-xs rounded border border-[var(--nx-border)] flex items-center gap-1"
                  >
                    <Download size={12} /> .cast
                  </button>
                </div>
                {loading && (
                  <div className="px-3 py-1 text-[var(--nx-text-soft)] font-mono text-xs">
                    {t("history.loading")}
                  </div>
                )}
              </>
            )}
            {!selectedId && (
              <div className="absolute inset-0 flex items-center justify-center text-[var(--nx-text-muted)] font-mono text-sm z-10 pointer-events-none">
                {t("history.select_session")}
              </div>
            )}
            {/* xterm container always mounted so termRef stays valid */}
            <div
              ref={termContainerRef}
              className="flex-1 min-h-0 bg-[var(--nx-bg-base)] p-1"
            />
          </div>
        </div>
      </div>
    </div>
  );
}
