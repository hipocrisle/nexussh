// AboutSection — settings tab content: version, links, credits, tagline.
// Rendered as the last section of SettingsScreen, like the other sections.

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Github, ExternalLink, Heart } from "lucide-react";
import type { ThemePalette } from "./themes";
import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";

interface Props {
  t: ThemePalette;
}

export function AboutSection({ t }: Props) {
  const { t: tr } = useTranslation();
  const [version, setVersion] = useState("");

  useEffect(() => {
    getVersion().then(setVersion).catch(() => setVersion("0.0.0"));
  }, []);

  const open = (url: string) => {
    openUrl(url).catch(() => window.open(url, "_blank"));
  };

  return (
    <section id="about" className="mb-12 scroll-mt-6">
      <div
        className="font-mono text-[10px] uppercase tracking-[0.3em] mb-2"
        style={{ color: t.textMuted }}
      >
        // {tr("settings.about.label")}
      </div>
      <h2
        className="font-mono text-2xl mb-6"
        style={{ color: t.textPrimary }}
      >
        <span style={{ color: t.accent }}>&gt;</span>{" "}
        {tr("settings.about.title")}
      </h2>

      <div
        className="rounded-nx-lg p-6 mb-5 border"
        style={{ borderColor: t.border, background: t.bgPanel }}
      >
        <div className="flex items-center gap-3 mb-3">
          <span
            className="inline-flex w-9 h-9 items-center justify-center border rounded-nx shadow-glow-sm"
            style={{
              borderColor: t.accent,
              color: t.accent,
              fontSize: 18,
              fontWeight: 700,
            }}
          >
            &gt;
          </span>
          <div className="font-mono">
            <div className="text-lg" style={{ color: t.accent }}>
              NexuSSH
            </div>
            <div className="text-meta" style={{ color: t.textMuted }}>
              {tr("settings.about.tagline")}
            </div>
          </div>
        </div>
        <div className="font-mono text-meta" style={{ color: t.textSoft }}>
          <span style={{ color: t.textMuted }}>{tr("settings.about.version")}: </span>
          <span style={{ color: t.textPrimary }}>v{version}</span>
        </div>
      </div>

      <div
        className="rounded-nx-lg p-5 mb-5 border"
        style={{ borderColor: t.border, background: t.bgPanel }}
      >
        <div
          className="font-mono text-[10px] uppercase tracking-[0.2em] mb-3"
          style={{ color: t.textMuted }}
        >
          // {tr("settings.about.links")}
        </div>
        <div className="space-y-2 font-mono text-body">
          <button
            type="button"
            onClick={() => open("https://github.com/hipocrisle/nexussh")}
            className="flex items-center gap-2 hover:opacity-80 cursor-pointer"
            style={{ color: t.accent }}
          >
            <Github size={14} />
            <span>github.com/hipocrisle/nexussh</span>
            <ExternalLink size={11} style={{ color: t.textMuted }} />
          </button>
          <button
            type="button"
            onClick={() =>
              open("https://github.com/hipocrisle/nexussh/releases")
            }
            className="flex items-center gap-2 hover:opacity-80 cursor-pointer"
            style={{ color: t.accent }}
          >
            <ExternalLink size={14} />
            <span>{tr("settings.about.releases")}</span>
          </button>
          <button
            type="button"
            onClick={() =>
              open("https://github.com/hipocrisle/nexussh/issues")
            }
            className="flex items-center gap-2 hover:opacity-80 cursor-pointer"
            style={{ color: t.accent }}
          >
            <ExternalLink size={14} />
            <span>{tr("settings.about.issues")}</span>
          </button>
        </div>
      </div>

      <div
        className="rounded-nx-lg p-5 border"
        style={{ borderColor: t.border, background: t.bgPanel }}
      >
        <div
          className="font-mono text-[10px] uppercase tracking-[0.2em] mb-3"
          style={{ color: t.textMuted }}
        >
          // {tr("settings.about.built_with")}
        </div>
        <div
          className="font-mono text-meta leading-relaxed"
          style={{ color: t.textSoft }}
        >
          Tauri 2 · React 19 · Tailwind 4 · xterm.js · russh · russh-sftp ·
          xray-core · age · matrix-js-sdk-style aesthetics
        </div>
      </div>

      <div
        className="font-mono text-meta mt-6 flex items-center gap-1.5"
        style={{ color: t.textMuted }}
      >
        <Heart size={11} style={{ color: t.accent }} />{" "}
        {tr("settings.about.made_with")}
      </div>
    </section>
  );
}
