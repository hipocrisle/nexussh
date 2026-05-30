// TabPicker — compact host quick-picker shown when user clicks `+` in TabBar
// or hits Ctrl+N. Keyboard-driven: type to filter, Up/Down to move, Enter to open.
// Shares its visual surface with ContextMenu via Popover.tsx.

import { useState, useEffect, useRef, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Server } from "lucide-react";
import { HostRecord, listHosts } from "./hosts";
import { useBackdropClose } from "./useBackdropClose";
import { POPOVER_SURFACE, PopoverDivider } from "./Popover";

interface Props {
  onPick: (h: HostRecord) => void;
  onClose: () => void;
}

function Highlighted({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>;
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, idx)}
      <mark className="bg-[rgba(0,255,149,0.18)] text-nx-accent px-0.5">
        {text.slice(idx, idx + query.length)}
      </mark>
      {text.slice(idx + query.length)}
    </>
  );
}

export function TabPicker({ onPick, onClose }: Props) {
  const { t } = useTranslation();
  const [hosts, setHosts] = useState<HostRecord[]>([]);
  const [q, setQ] = useState("");
  const [idx, setIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const { backdropProps, contentProps } = useBackdropClose(onClose);

  useEffect(() => {
    listHosts().then((list) => {
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
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 backdrop-blur-sm pt-[15vh]"
      {...backdropProps}
    >
      <div
        {...contentProps}
        className={"nx-modal-enter w-full max-w-xl overflow-hidden " + POPOVER_SURFACE}
      >
        {/* Search header */}
        <div className="flex items-center gap-2.5 px-3.5 py-2.5 border-b border-nx-divider">
          <span className="text-nx-accent">&gt;</span>
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setIdx(0);
            }}
            onKeyDown={onKey}
            placeholder={t("picker.placeholder")}
            className="flex-1 bg-transparent border-none text-nx-text font-mono text-lead outline-none placeholder-nx-muted"
          />
          <span className="text-micro uppercase tracking-wider px-1.5 rounded-nx-sm border border-nx-border text-nx-muted whitespace-nowrap">
            {filtered.length} {t("picker.results")}
          </span>
        </div>

        {/* Results */}
        <div className="max-h-[50vh] overflow-y-auto py-1">
          {filtered.length === 0 ? (
            <div className="px-4 py-6 text-center font-mono text-meta text-nx-muted">
              {hosts.length === 0 ? t("picker.no_hosts") : t("picker.no_match")}
            </div>
          ) : (
            filtered.map((h, i) => {
              const active = i === idx;
              return (
                <div
                  key={h.id}
                  data-active={active || undefined}
                  onMouseEnter={() => setIdx(i)}
                  onClick={() => {
                    onPick(h);
                    onClose();
                  }}
                  className="nx-row grid grid-cols-[16px_1fr_auto] gap-2.5 items-center px-3.5 py-2 cursor-pointer"
                >
                  <Server size={12} className="text-nx-muted shrink-0" />
                  <div className="min-w-0">
                    <div
                      className={
                        "truncate text-lead " + (active ? "text-nx-accent" : "text-nx-text")
                      }
                    >
                      <Highlighted text={h.name} query={q} />
                    </div>
                    <div className="text-meta text-nx-muted truncate">
                      {h.user}@{h.host}
                      {h.port !== 22 && `:${h.port}`}
                    </div>
                  </div>
                  {h.group && (
                    <span className="text-micro uppercase tracking-wider px-1.5 rounded-nx-sm border border-nx-border text-nx-muted whitespace-nowrap">
                      <Highlighted text={h.group} query={q} />
                    </span>
                  )}
                </div>
              );
            })
          )}
        </div>

        <PopoverDivider />
        {/* Footer hints */}
        <div className="px-3.5 py-2 flex gap-4 text-micro uppercase tracking-[0.12em] text-nx-muted">
          <span>
            <kbd className="text-nx-accent">↑ ↓</kbd> {t("picker.hint_move")}
          </span>
          <span>
            <kbd className="text-nx-accent">↵</kbd> {t("picker.hint_open")}
          </span>
          <span className="ml-auto">
            <kbd className="text-nx-accent">esc</kbd> {t("picker.hint_close")}
          </span>
        </div>
      </div>
    </div>
  );
}
