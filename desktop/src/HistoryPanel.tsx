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
import { Trash2, Download, Search, X, RefreshCw } from "lucide-react";
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

interface Props {
  onClose: () => void;
}

const SEARCH_DECORATIONS = {
  matchBackground: "#1f3a3a",
  matchBorder: "#00ff95",
  matchOverviewRuler: "#00ff95",
  activeMatchBackground: "#00ff95",
  activeMatchBorder: "#00ff95",
  activeMatchColorOverviewRuler: "#00d4ff",
} as const;

const MATRIX_THEME = {
  background: "#0a0e0e",
  foreground: "#c9d1d9",
  cursor: "#00ff95",
  cursorAccent: "#0a0e0e",
  selectionBackground: "#1f3a3a",
  black: "#0a0e0e",
  red: "#ff6b6b",
  green: "#00ff95",
  yellow: "#f5d76e",
  blue: "#5cc8ff",
  magenta: "#d391ff",
  cyan: "#00d4ff",
  white: "#c9d1d9",
  brightBlack: "#4a5560",
  brightRed: "#ff8e8e",
  brightGreen: "#5fffb4",
  brightYellow: "#ffe28a",
  brightBlue: "#7fd7ff",
  brightMagenta: "#e1b3ff",
  brightCyan: "#5feaff",
  brightWhite: "#ffffff",
};

export function HistoryPanel({ onClose }: Props) {
  const { t } = useTranslation();
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
      theme: MATRIX_THEME,
      fontFamily: '"JetBrains Mono", "Fira Code", monospace',
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

    term.attachCustomWheelEventHandler((ev: WheelEvent) => {
      const lines = Math.max(1, Math.round(Math.abs(ev.deltaY) / 24));
      term.scrollLines(ev.deltaY > 0 ? lines : -lines);
      ev.preventDefault();
      return false;
    });

    const onWinResize = () => fit.fit();
    window.addEventListener("resize", onWinResize);
    return () => {
      window.removeEventListener("resize", onWinResize);
      term.dispose();
    };
  }, []);

  // Replay events into xterm
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.reset();
    if (!events) return;

    // Match the original session's terminal width so wrapped lines render
    // where they were wrapped originally. Without this, the viewer's default
    // 80-col grid cuts long lines that the recorded shell rendered at 120+.
    const meta = entries.find((e) => e.session_id === selectedId);
    const cols = meta?.cols && meta.cols > 0 ? meta.cols : 120;
    const rows = meta?.rows && meta.rows > 0 ? meta.rows : 30;
    try {
      term.resize(cols, rows);
    } catch {
      /* xterm may throw if dims invalid — fallback to default */
    }

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
        // Dedup: if non-empty line equals previous and is followed by newline,
        // collapse it. Keep cursor-positioning lines as-is (they don't end
        // with \n so won't match the dedup branch).
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
    // Do NOT call fit() here — we want to preserve the session's cols/rows.
  }, [events, entries, selectedId]);

  // In-session search: highlight current match on submit
  useEffect(() => {
    const search = searchRef.current;
    if (!search) return;
    if (!inSessionQuery.trim()) return;
    search.findNext(inSessionQuery, {
      caseSensitive: false,
      decorations: SEARCH_DECORATIONS,
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
        className="w-full max-w-7xl h-[90vh] bg-[#0a0e0e] border border-[#1f3a3a] rounded-lg shadow-2xl flex flex-col overflow-hidden"
      >
        {/* Header */}
        <div className="flex items-center px-4 py-3 border-b border-[#1f3a3a] shrink-0">
          <h2 className="text-lg font-mono text-[#00ff95]">
            &gt; {t("history.title")}
          </h2>
          <p className="ml-3 text-xs text-[#4a5560] font-mono italic">
            {t("history.subtitle")}
          </p>
          <button
            onClick={refresh}
            title={t("history.refresh")}
            className="ml-auto p-1.5 rounded hover:bg-[#1f3a3a] text-[#7fd7ff]"
          >
            <RefreshCw size={14} />
          </button>
          <button
            onClick={onClose}
            className="ml-2 p-1.5 rounded hover:bg-[#1f3a3a] text-[#7fd7ff]"
          >
            <X size={14} />
          </button>
        </div>

        {/* Cross-session search */}
        <div className="flex items-center gap-2 px-4 py-2 border-b border-[#1f3a3a] shrink-0">
          <Search size={14} className="text-[#7fd7ff]" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && runSearch()}
            placeholder={t("history.search_all_ph")}
            className="flex-1 bg-[#0e1414] border border-[#1f3a3a] rounded px-2 py-1 text-[#c9d1d9] focus:outline-none focus:border-[#00ff95] placeholder-[#4a5560] font-mono text-xs"
          />
          <button
            onClick={runSearch}
            className="px-3 py-1 bg-[#0e1414] hover:bg-[#1f3a3a] text-[#7fd7ff] font-mono text-xs rounded border border-[#1f3a3a]"
          >
            {t("history.search_btn")}
          </button>
          {hits !== null && (
            <button
              onClick={() => {
                setHits(null);
                setQuery("");
              }}
              className="px-3 py-1 bg-[#0e1414] hover:bg-[#1f3a3a] text-[#f5d76e] font-mono text-xs rounded border border-[#1f3a3a]"
            >
              {t("history.clear_search")} ({hits.length})
            </button>
          )}
        </div>

        {error && (
          <div className="px-4 py-2 text-[#ff6b6b] text-xs font-mono border-b border-[#1f3a3a] shrink-0 break-all">
            ✗ {error}
          </div>
        )}

        {/* Two-pane */}
        <div className="flex-1 min-h-0 flex">
          {/* Sessions list */}
          <div className="w-72 shrink-0 border-r border-[#1f3a3a] overflow-y-auto">
            {filteredEntries.length === 0 ? (
              <div className="p-4 text-xs text-[#4a5560] font-mono">
                {hits !== null ? t("history.no_hits") : t("history.empty")}
              </div>
            ) : (
              filteredEntries.map((e) => (
                <button
                  key={e.session_id}
                  onClick={() => setSelectedId(e.session_id)}
                  className={`w-full text-left px-3 py-2 border-b border-[#1f3a3a] hover:bg-[#0e1414] group ${
                    selectedId === e.session_id ? "bg-[#0e1414]" : ""
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <div className="flex-1 min-w-0">
                      <div className="font-mono text-sm text-[#c9d1d9] truncate">
                        {e.user}@{e.host}
                        {e.port !== 22 && `:${e.port}`}
                      </div>
                      <div className="font-mono text-[10px] text-[#4a5560] flex gap-2">
                        <span>{fmtTs(e.started_at)}</span>
                        <span>·</span>
                        <span>{fmtBytes(e.byte_count)}</span>
                        {e.still_active && (
                          <span className="text-[#00ff95]">● live</span>
                        )}
                      </div>
                    </div>
                    <button
                      onClick={(ev) => {
                        ev.stopPropagation();
                        onDelete(e.session_id);
                      }}
                      title={t("history.delete")}
                      className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-[#1f3a3a] text-[#ff8e8e]"
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
                <div className="flex items-center gap-2 px-3 py-2 border-b border-[#1f3a3a] shrink-0 text-xs font-mono">
                  {selectedMeta && (
                    <span className="text-[#4a5560]">
                      {selectedMeta.user}@{selectedMeta.host} ·{" "}
                      <span className="text-[#7fd7ff]">
                        {fmtTs(selectedMeta.started_at)}
                      </span>
                      {durationLabel && (
                        <>
                          {" · "}
                          <span className="text-[#7fd7ff]">{durationLabel}</span>
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
                          decorations: SEARCH_DECORATIONS,
                        });
                      }
                    }}
                    placeholder={t("history.filter_in_session_ph")}
                    className="ml-auto w-64 bg-[#0e1414] border border-[#1f3a3a] rounded px-2 py-1 text-[#c9d1d9] focus:outline-none focus:border-[#00ff95] placeholder-[#4a5560] font-mono text-xs"
                  />
                  <button
                    onClick={() =>
                      searchRef.current?.findPrevious(inSessionQuery, {
                        caseSensitive: false,
                        decorations: SEARCH_DECORATIONS,
                      })
                    }
                    title={t("history.find_prev")}
                    className="px-2 py-1 bg-[#0e1414] hover:bg-[#1f3a3a] text-[#7fd7ff] font-mono text-xs rounded border border-[#1f3a3a]"
                  >
                    ↑
                  </button>
                  <button
                    onClick={() =>
                      searchRef.current?.findNext(inSessionQuery, {
                        caseSensitive: false,
                        decorations: SEARCH_DECORATIONS,
                      })
                    }
                    title={t("history.find_next")}
                    className="px-2 py-1 bg-[#0e1414] hover:bg-[#1f3a3a] text-[#7fd7ff] font-mono text-xs rounded border border-[#1f3a3a]"
                  >
                    ↓
                  </button>
                  <button
                    onClick={() => onExport(selectedId, true)}
                    title={t("history.export_stripped")}
                    className="px-2 py-1 bg-[#0e1414] hover:bg-[#1f3a3a] text-[#7fd7ff] font-mono text-xs rounded border border-[#1f3a3a] flex items-center gap-1"
                  >
                    <Download size={12} /> .txt
                  </button>
                  <button
                    onClick={() => onExport(selectedId, false)}
                    title={t("history.export_raw")}
                    className="px-2 py-1 bg-[#0e1414] hover:bg-[#1f3a3a] text-[#7fd7ff] font-mono text-xs rounded border border-[#1f3a3a] flex items-center gap-1"
                  >
                    <Download size={12} /> .cast
                  </button>
                </div>
                {loading && (
                  <div className="px-3 py-1 text-[#7fd7ff] font-mono text-xs">
                    {t("history.loading")}
                  </div>
                )}
              </>
            )}
            {!selectedId && (
              <div className="absolute inset-0 flex items-center justify-center text-[#4a5560] font-mono text-sm z-10 pointer-events-none">
                {t("history.select_session")}
              </div>
            )}
            {/* xterm container always mounted so termRef stays valid */}
            <div
              ref={termContainerRef}
              className="flex-1 min-h-0 bg-[#0a0e0e] p-1"
            />
          </div>
        </div>
      </div>
    </div>
  );
}
