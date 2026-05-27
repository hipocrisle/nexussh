// TabBar — horizontal list of open terminal tabs + `+` to open a new tab.

import { X, Loader2, Wifi, WifiOff, Plus } from "lucide-react";

export interface TabInfo {
  id: string; // session_id from backend
  title: string;
  status: "connecting" | "connected" | "closed";
}

interface Props {
  tabs: TabInfo[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onNewTab: () => void;
}

export function TabBar({ tabs, activeId, onSelect, onClose, onNewTab }: Props) {
  return (
    <div className="h-9 flex items-center bg-[#080b0b] border-b border-[#1f3a3a]">
      <div className="flex-1 min-w-0 overflow-x-auto flex items-center h-full">
        {tabs.map((t) => {
          const active = t.id === activeId;
          return (
            <div
              key={t.id}
              onClick={() => onSelect(t.id)}
              className={
                "h-full px-3 flex items-center gap-2 cursor-pointer border-r border-[#1f3a3a] min-w-0 shrink-0 " +
                (active
                  ? "bg-[#0a0e0e] text-[#00ff95]"
                  : "text-[#c9d1d9] hover:bg-[#0e1414]")
              }
            >
              {t.status === "connecting" && (
                <Loader2 size={12} className="animate-spin text-[#f5d76e]" />
              )}
              {t.status === "connected" && (
                <Wifi size={12} className="text-[#00ff95]" />
              )}
              {t.status === "closed" && (
                <WifiOff size={12} className="text-[#ff6b6b]/70" />
              )}
              <span className="font-mono text-sm truncate max-w-[180px]">
                {t.title}
              </span>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onClose(t.id);
                }}
                className="opacity-50 hover:opacity-100 hover:text-[#ff6b6b]"
              >
                <X size={12} />
              </button>
            </div>
          );
        })}
      </div>
      <button
        onClick={onNewTab}
        title="New tab — Ctrl+T"
        className="h-full shrink-0 px-3 flex items-center text-[#7fd7ff] hover:bg-[#0e1414] hover:text-[#00ff95] border-l border-[#1f3a3a]"
      >
        <Plus size={14} />
      </button>
    </div>
  );
}
