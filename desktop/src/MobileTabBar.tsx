// Mobile bottom navigation — the primary one-handed nav on phones.
// Four destinations: Хосты (saved hosts) · Сессии (live terminals) ·
// Файлы (SFTP) · Настройки. Replaces the top hamburger/⋮ as the main way to
// move around. Hidden while a live terminal is full-screen (see App.tsx) so the
// terminal + SmartKeyBar own the whole viewport.
//
// Fixed to the bottom, honours safe-area-inset-bottom so the gesture bar /
// rounded corners don't clip the labels. 56dp-ish tall, big tap targets.

import { Server, SquareTerminal, FolderOpen, Settings as SettingsIcon } from "lucide-react";
import { useTranslation } from "react-i18next";

export type MobileTab = "hosts" | "sessions" | "files" | "settings";

interface Props {
  active: MobileTab;
  onSelect: (tab: MobileTab) => void;
  /** Open live terminal count — shown as a badge on the Сессии tab. */
  sessionCount: number;
  /** Is the Files (SFTP) tab wired to a working browser yet? When false the tab
   *  is omitted entirely rather than shown dead (no-stub rule). */
  filesEnabled?: boolean;
}

interface TabDef {
  id: MobileTab;
  label: string;
  Icon: typeof Server;
}

export function MobileTabBar({ active, onSelect, sessionCount, filesEnabled = true }: Props) {
  const { t } = useTranslation();

  const tabs: TabDef[] = [
    { id: "hosts", label: t("mobile.tab.hosts"), Icon: Server },
    { id: "sessions", label: t("mobile.tab.sessions"), Icon: SquareTerminal },
    ...(filesEnabled
      ? [{ id: "files" as const, label: t("mobile.tab.files"), Icon: FolderOpen }]
      : []),
    { id: "settings", label: t("mobile.tab.settings"), Icon: SettingsIcon },
  ];

  return (
    <nav
      className="nx-safe-bottom shrink-0 z-20 bg-nx-bg-2 border-t border-nx-border select-none"
      role="tablist"
    >
      <div className="flex items-stretch h-14">
        {tabs.map(({ id, label, Icon }) => {
          const isActive = active === id;
          const badge = id === "sessions" && sessionCount > 0 ? sessionCount : null;
          return (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={isActive}
              onClick={() => onSelect(id)}
              className={
                "relative flex-1 min-w-0 flex flex-col items-center justify-center gap-0.5 " +
                "active:bg-nx-elevated transition-colors " +
                (isActive ? "text-nx-accent" : "text-nx-muted")
              }
            >
              {/* Active indicator bar along the top edge of the cell. */}
              {isActive && (
                <span
                  className="absolute top-0 left-1/2 -translate-x-1/2 h-0.5 w-8 rounded-full"
                  style={{ background: "var(--nx-accent)" }}
                />
              )}
              <span className="relative">
                <Icon size={20} strokeWidth={isActive ? 2.25 : 1.75} />
                {badge !== null && (
                  <span
                    className="absolute -top-1.5 -right-2 min-w-[15px] h-[15px] px-1 rounded-full text-[9px] font-mono font-bold flex items-center justify-center"
                    style={{ background: "var(--nx-accent)", color: "var(--nx-bg-base)" }}
                  >
                    {badge > 9 ? "9+" : badge}
                  </span>
                )}
              </span>
              <span className="text-[10px] font-mono leading-none truncate max-w-full px-0.5">
                {label}
              </span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}
