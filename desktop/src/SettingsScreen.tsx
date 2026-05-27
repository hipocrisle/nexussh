// SettingsScreen — full-window Settings replacement for the tiny popover that
// shipped through v0.0.3. Three sections (Appearance, Updates, Behavior) with a
// left nav rail, scroll-spy, smooth-scroll on nav click, Esc-to-close.

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Palette,
  Download,
  SlidersHorizontal,
  ArrowLeft,
  Terminal as TerminalIcon,
} from "lucide-react";
import { LanguageSwitcher } from "./LanguageSwitcher";
import { useSettings } from "./settings/settings-store";
import { THEMES } from "./settings/themes";
import { FONTS, fontStackOf } from "./settings/fonts";
import { MatrixRain } from "./settings/MatrixRain";
import { AppearanceSection } from "./settings/AppearanceSection";
import { UpdatesSection } from "./settings/UpdatesSection";
import { BehaviorSection } from "./settings/BehaviorSection";
import { getVersion } from "@tauri-apps/api/app";

interface Props {
  onClose: () => void;
  sessionCount?: number;
}

const SECTIONS = [
  { id: "appearance", key: "appearance", Icon: Palette },
  { id: "updates", key: "updates", Icon: Download },
  { id: "behavior", key: "behavior", Icon: SlidersHorizontal },
] as const;

export function SettingsScreen({ onClose, sessionCount = 0 }: Props) {
  const { t: tr } = useTranslation();
  const [settings, set] = useSettings();
  const [active, setActive] = useState<string>("appearance");
  const [version, setVersion] = useState<string>("");
  const scrollRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    getVersion().then(setVersion).catch(() => setVersion("0.0.0"));
  }, []);

  // Esc to close
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Scroll-spy: walk sections, find the topmost one whose top is near viewport top
  useEffect(() => {
    const root = scrollRef.current;
    if (!root) return;
    const handler = () => {
      const tops = SECTIONS.map(({ id }) => {
        const el = document.getElementById(id);
        return el ? { id, top: el.getBoundingClientRect().top } : null;
      }).filter(Boolean) as { id: string; top: number }[];
      const visible = tops.filter((x) => x.top < 200);
      const pick = visible.length ? visible[visible.length - 1] : tops[0];
      if (pick && pick.id !== active) setActive(pick.id);
    };
    root.addEventListener("scroll", handler);
    return () => root.removeEventListener("scroll", handler);
  }, [active]);

  function jump(id: string) {
    setActive(id);
    const el = document.getElementById(id);
    const root = scrollRef.current;
    if (el && root) {
      root.scrollTo({ top: el.offsetTop - 24, behavior: "smooth" });
    }
  }

  const t = THEMES[settings.theme];
  const fontStack = fontStackOf(settings.font);

  const themeLabel = useMemo(
    () => tr(`settings.appearance.themes.${settings.theme}`),
    [tr, settings.theme],
  );
  const fontLabel = useMemo(
    () => FONTS.find((f) => f.id === settings.font)?.label ?? "",
    [settings.font],
  );

  const themeStyle = {
    "--nx-bg-base": t.bgBase,
    "--nx-bg-secondary": t.bgSecondary,
    "--nx-bg-panel": t.bgPanel,
    "--nx-bg-elevated": t.bgElevated,
    "--nx-border": t.border,
    "--nx-text-primary": t.textPrimary,
    "--nx-text-muted": t.textMuted,
    "--nx-text-soft": t.textSoft,
    "--nx-accent": t.accent,
    "--nx-accent2": t.accent2,
    "--nx-warning": t.warning,
    "--nx-error": t.error,
    background: t.bgBase,
    fontFamily: fontStack,
    color: t.textPrimary,
  } as React.CSSProperties;

  return (
    <div
      className="h-full w-full flex flex-col relative overflow-hidden"
      style={themeStyle}
    >
      <div className="absolute inset-0 pointer-events-none">
        <MatrixRain
          enabled={settings.rainOn}
          density={settings.rainDensity}
          opacity={settings.rainOpacity}
          accent={t.accent}
          fade={t.bgBase}
        />
      </div>

      <div className="relative z-10 flex flex-col h-full">
        {/* Header */}
        <header
          className="h-9 border-b flex items-center px-4 select-none shrink-0 font-mono text-sm tracking-wider"
          style={{ background: t.bgSecondary, borderColor: t.border }}
        >
          <span style={{ color: t.accent }}>NexuSSH</span>
          <span className="ml-2 text-xs" style={{ color: t.textMuted }}>
            v{version}
          </span>
          <span
            className="ml-3 text-xs italic"
            style={{ color: t.textMuted }}
          >
            — {tr("settings.app.brand_tagline")}
          </span>
          <span className="ml-4 text-xs" style={{ color: t.textMuted }}>
            <span style={{ color: t.textSoft }}>/</span>{" "}
            {tr("settings.app.settings")}
          </span>
          <div
            className="ml-auto flex items-center gap-3 text-xs"
            style={{ color: t.textMuted }}
          >
            <span className="flex items-center gap-1.5">
              <TerminalIcon size={11} />{" "}
              {tr("settings.app.sessions", { n: sessionCount })}
            </span>
            <span style={{ color: t.border }}>|</span>
            <LanguageSwitcher />
          </div>
        </header>

        <div className="flex-1 min-h-0 flex">
          {/* Nav rail */}
          <aside
            className="shrink-0 flex flex-col border-r"
            style={{
              width: 264,
              background: t.bgSecondary,
              borderColor: t.border,
            }}
          >
            <div
              className="px-5 py-5 border-b"
              style={{ borderColor: t.border }}
            >
              <button
                type="button"
                onClick={onClose}
                className="flex items-center gap-2 font-mono text-xs uppercase tracking-wider mb-3 hover:opacity-80 cursor-pointer"
                style={{ color: t.textMuted }}
              >
                <ArrowLeft size={12} /> {tr("settings.app.back")}
              </button>
              <div className="font-mono">
                <div
                  className="text-[10px] uppercase tracking-[0.3em]"
                  style={{ color: t.accent }}
                >
                  // {tr("settings.app.configuration")}
                </div>
                <div
                  className="text-2xl mt-1"
                  style={{ color: t.textPrimary }}
                >
                  <span style={{ color: t.accent }}>&gt;</span>{" "}
                  {tr("settings.app.settings")}
                </div>
              </div>
            </div>

            <nav className="flex-1 overflow-y-auto py-3">
              {SECTIONS.map(({ id, key, Icon }) => {
                const isActive = active === id;
                return (
                  <button
                    key={id}
                    type="button"
                    onClick={() => jump(id)}
                    className="w-full text-left px-4 py-3 flex items-start gap-3 group transition-colors cursor-pointer"
                    style={{
                      background: isActive ? t.bgPanel : "transparent",
                      borderLeft: `2px solid ${isActive ? t.accent : "transparent"}`,
                    }}
                  >
                    <span
                      className="mt-0.5 shrink-0"
                      style={{ color: isActive ? t.accent : t.textMuted }}
                    >
                      <Icon size={16} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div
                        className="font-mono text-sm uppercase tracking-wider"
                        style={{
                          color: isActive ? t.textPrimary : t.textMuted,
                        }}
                      >
                        {tr(`settings.nav.${key}`)}
                      </div>
                      <div
                        className="font-mono text-[10px] mt-0.5 truncate"
                        style={{ color: t.textMuted }}
                      >
                        {tr(`settings.nav.${key}_sub`)}
                      </div>
                    </div>
                  </button>
                );
              })}
            </nav>

            <div
              className="px-4 py-4 border-t font-mono text-[10px] space-y-2"
              style={{ borderColor: t.border, color: t.textMuted }}
            >
              <div
                className="uppercase tracking-[0.2em]"
                style={{ color: t.textSoft }}
              >
                // {tr("settings.nav.current")}
              </div>
              <div className="flex justify-between">
                <span>{tr("settings.nav.theme")}</span>
                <span style={{ color: t.textPrimary }}>{themeLabel}</span>
              </div>
              <div className="flex justify-between">
                <span>{tr("settings.nav.font")}</span>
                <span style={{ color: t.textPrimary }}>{fontLabel}</span>
              </div>
              <div className="flex justify-between">
                <span>{tr("settings.nav.rain")}</span>
                <span
                  style={{
                    color: settings.rainOn ? t.accent : t.textMuted,
                  }}
                >
                  {settings.rainOn ? tr("settings.nav.on") : tr("settings.nav.off")}
                </span>
              </div>
              <div className="flex justify-between">
                <span>{tr("settings.nav.channel")}</span>
                <span style={{ color: t.textPrimary }}>{settings.channel}</span>
              </div>
            </div>
          </aside>

          <main
            ref={(el) => {
              scrollRef.current = el;
            }}
            className="flex-1 min-w-0 overflow-y-auto"
            style={{ scrollBehavior: "smooth" }}
          >
            <div className="max-w-3xl mx-auto px-10 py-10">
              <div className="mb-10">
                <div
                  className="font-mono text-[10px] uppercase tracking-[0.3em] mb-2"
                  style={{ color: t.textMuted }}
                >
                  ~/.config/nexussh/settings.toml
                </div>
                <h1
                  className="font-mono text-4xl mb-2"
                  style={{ color: t.textPrimary }}
                >
                  <span style={{ color: t.accent }}>&gt;</span>{" "}
                  {tr("settings.app.title")}
                </h1>
                <p
                  className="font-mono text-sm leading-relaxed max-w-xl"
                  style={{ color: t.textMuted }}
                >
                  {tr("settings.app.subtitle_a")}{" "}
                  <span style={{ color: t.textSoft }}>
                    ~/.config/nexussh/
                  </span>{" "}
                  {tr("settings.app.subtitle_b")}
                </p>
              </div>

              <AppearanceSection s={settings} set={set} t={t} />
              <UpdatesSection s={settings} set={set} t={t} />
              <BehaviorSection s={settings} set={set} t={t} />

              <div
                className="border-t pt-6 mt-12 font-mono text-[11px] flex items-center justify-between flex-wrap gap-2"
                style={{ borderColor: t.border, color: t.textMuted }}
              >
                <span className="flex items-center gap-2">
                  <CheckPulse t={t} /> {tr("settings.app.saved")}
                </span>
                <span>
                  <kbd
                    className="px-1.5 py-0.5 rounded border"
                    style={{ borderColor: t.border, color: t.textSoft }}
                  >
                    Esc
                  </kbd>
                  <span className="ml-2">{tr("settings.app.esc_close")} · </span>
                  <kbd
                    className="px-1.5 py-0.5 rounded border"
                    style={{ borderColor: t.border, color: t.textSoft }}
                  >
                    Ctrl ,
                  </kbd>
                  <span className="ml-2">{tr("settings.app.reopen")}</span>
                </span>
              </div>
            </div>
          </main>
        </div>
      </div>
    </div>
  );
}

function CheckPulse({ t }: { t: ReturnType<typeof useTheme> }) {
  return (
    <span className="relative inline-flex w-2 h-2">
      <span
        className="absolute inset-0 rounded-full animate-ping"
        style={{ background: t.accent, opacity: 0.5 }}
      />
      <span
        className="relative inline-flex w-2 h-2 rounded-full"
        style={{ background: t.accent }}
      />
    </span>
  );
}

// Tiny helper so TS infers the theme type for CheckPulse without bringing in
// the full ThemePalette import there. Keeps this file lean.
function useTheme() {
  // unused at runtime — just a type anchor
  return THEMES.matrix;
}
