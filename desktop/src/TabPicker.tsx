// TabPicker — compact host quick-picker shown when user clicks `+` in TabBar
// or hits Ctrl+T. Keyboard-driven: type to filter, Up/Down to move, Enter to open.

import { useState, useEffect, useRef, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { HostRecord, listHosts } from "./hosts";

interface Props {
  onPick: (h: HostRecord) => void;
  onClose: () => void;
}

export function TabPicker({ onPick, onClose }: Props) {
  const { t } = useTranslation();
  const [hosts, setHosts] = useState<HostRecord[]>([]);
  const [q, setQ] = useState("");
  const [idx, setIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    listHosts().then((list) => {
      // Sort by lastUsedAt desc, then name
      list.sort((a, b) => {
        const la = a.lastUsedAt ?? "";
        const lb = b.lastUsedAt ?? "";
        if (la !== lb) return la < lb ? 1 : -1;
        return a.name.localeCompare(b.name);
      });
      setHosts(list);
    });
    setTimeout(() => inputRef.current?.focus(), 0);
  }, []);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return hosts;
    return hosts.filter(
      (h) =>
        h.name.toLowerCase().includes(needle) ||
        h.host.toLowerCase().includes(needle) ||
        h.user.toLowerCase().includes(needle) ||
        (h.group?.toLowerCase() ?? "").includes(needle),
    );
  }, [hosts, q]);

  useEffect(() => {
    if (idx >= filtered.length) setIdx(Math.max(0, filtered.length - 1));
  }, [filtered.length, idx]);

  function onKey(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      onClose();
      e.preventDefault();
    } else if (e.key === "ArrowDown") {
      setIdx((i) => Math.min(filtered.length - 1, i + 1));
      e.preventDefault();
    } else if (e.key === "ArrowUp") {
      setIdx((i) => Math.max(0, i - 1));
      e.preventDefault();
    } else if (e.key === "Enter") {
      if (filtered[idx]) {
        onPick(filtered[idx]);
        onClose();
      }
      e.preventDefault();
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 backdrop-blur-sm pt-24"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md bg-[#0a0e0e] border border-[#1f3a3a] rounded-lg shadow-2xl overflow-hidden"
      >
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={onKey}
          placeholder={t("picker.placeholder")}
          className="w-full bg-[#0e1414] border-b border-[#1f3a3a] px-4 py-3 text-[#c9d1d9] focus:outline-none placeholder-[#4a5560] font-mono text-sm"
        />
        <div className="max-h-80 overflow-y-auto">
          {filtered.length === 0 ? (
            <div className="px-4 py-6 text-center font-mono text-xs text-[#4a5560]">
              {hosts.length === 0
                ? t("picker.no_hosts")
                : t("picker.no_match")}
            </div>
          ) : (
            filtered.map((h, i) => (
              <button
                key={h.id}
                onClick={() => {
                  onPick(h);
                  onClose();
                }}
                onMouseEnter={() => setIdx(i)}
                className={
                  "w-full text-left px-4 py-2 font-mono text-sm border-b border-[#1f3a3a]/60 " +
                  (i === idx
                    ? "bg-[#1f3a3a] text-[#00ff95]"
                    : "text-[#c9d1d9] hover:bg-[#0e1414]")
                }
              >
                <div className="flex items-center gap-2">
                  <span className="truncate">{h.name}</span>
                  {h.group && (
                    <span className="text-[10px] text-[#7fd7ff] bg-[#0e1414] px-1 rounded">
                      {h.group}
                    </span>
                  )}
                  <span className="ml-auto text-[10px] text-[#4a5560] truncate">
                    {h.user}@{h.host}
                    {h.port !== 22 && `:${h.port}`}
                  </span>
                </div>
              </button>
            ))
          )}
        </div>
        <div className="px-4 py-2 border-t border-[#1f3a3a] font-mono text-[10px] text-[#4a5560] flex gap-3">
          <span>↑↓ {t("picker.hint_move")}</span>
          <span>↵ {t("picker.hint_open")}</span>
          <span>Esc {t("picker.hint_close")}</span>
        </div>
      </div>
    </div>
  );
}
