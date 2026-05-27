// HistoryPanel — список всех записанных сессий + viewer.
// Killer-фича: можно скролить вверх и видеть всё что было в Claude Code /
// vim / htop сессии даже после выхода из alt-screen-buffer.

import { useState, useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { save } from "@tauri-apps/plugin-dialog";
import { Trash2, Download, Search, X, RefreshCw } from "lucide-react";
import {
  HistoryEntry,
  SearchHit,
  historyList,
  historyRead,
  historyDelete,
  historySearch,
  historyExport,
  stripAnsi,
  fmtTs,
  fmtBytes,
} from "./history";

interface Props {
  onClose: () => void;
}

export function HistoryPanel({ onClose }: Props) {
  const { t } = useTranslation();
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [bytes, setBytes] = useState<Uint8Array | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [filterText, setFilterText] = useState("");
  const viewerRef = useRef<HTMLPreElement>(null);

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

  // Load selected session bytes
  useEffect(() => {
    if (!selectedId) {
      setBytes(null);
      return;
    }
    setLoading(true);
    setError(null);
    historyRead(selectedId)
      .then(setBytes)
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [selectedId]);

  // Scroll viewer to bottom when new bytes load
  useEffect(() => {
    if (viewerRef.current && bytes) {
      viewerRef.current.scrollTop = viewerRef.current.scrollHeight;
    }
  }, [bytes]);

  const text = useMemo(() => (bytes ? stripAnsi(bytes) : ""), [bytes]);

  // In-session filter highlights
  const filteredText = useMemo(() => {
    if (!filterText.trim()) return text;
    const lines = text.split("\n");
    const q = filterText.toLowerCase();
    return lines.filter((l) => l.toLowerCase().includes(q)).join("\n");
  }, [text, filterText]);

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
        defaultPath: `nexussh-${id.slice(0, 8)}.${strip ? "txt" : "log"}`,
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

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-6xl h-[85vh] bg-[#0a0e0e] border border-[#1f3a3a] rounded-lg shadow-2xl flex flex-col overflow-hidden"
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
                {hits !== null
                  ? t("history.no_hits")
                  : t("history.empty")}
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
          <div className="flex-1 min-w-0 flex flex-col">
            {selectedId ? (
              <>
                <div className="flex items-center gap-2 px-3 py-2 border-b border-[#1f3a3a] shrink-0">
                  <input
                    value={filterText}
                    onChange={(e) => setFilterText(e.target.value)}
                    placeholder={t("history.filter_in_session_ph")}
                    className="flex-1 bg-[#0e1414] border border-[#1f3a3a] rounded px-2 py-1 text-[#c9d1d9] focus:outline-none focus:border-[#00ff95] placeholder-[#4a5560] font-mono text-xs"
                  />
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
                    <Download size={12} /> .log
                  </button>
                </div>
                {loading ? (
                  <div className="flex-1 flex items-center justify-center text-[#7fd7ff] font-mono text-sm">
                    {t("history.loading")}
                  </div>
                ) : (
                  <pre
                    ref={viewerRef}
                    className="flex-1 min-h-0 overflow-y-auto px-4 py-2 font-mono text-xs text-[#c9d1d9] whitespace-pre-wrap break-words bg-[#0a0e0e] selection:bg-[#1f3a3a]"
                  >
                    {filteredText}
                  </pre>
                )}
              </>
            ) : (
              <div className="flex-1 flex items-center justify-center text-[#4a5560] font-mono text-sm">
                {t("history.select_session")}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
