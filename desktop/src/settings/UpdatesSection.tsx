// Updates section — version, channel, auto-check, manual check, signature verify.
// Wires the manual Check button to the real updater.ts API (no fake setTimeout).

import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Loader2, Download, RefreshCw, Check } from "lucide-react";
import { ThemePalette } from "./themes";
import { Section, Row, Toggle } from "./primitives";
import type { NexuSettings } from "./settings-store";
import {
  checkForUpdate,
  installUpdate,
  markChecked,
  lastCheckAt,
  type UpdateInfo,
} from "../updater";
import { getVersion } from "@tauri-apps/api/app";

type Status = "idle" | "checking" | "available" | "up_to_date" | "installing";

interface Props {
  s: NexuSettings;
  set: (patch: Partial<NexuSettings>) => void;
  t: ThemePalette;
}

export function UpdatesSection({ s, set, t }: Props) {
  const { t: tr } = useTranslation();
  const [status, setStatus] = useState<Status>("idle");
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [lastChecked, setLastChecked] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState<string>("");

  useEffect(() => {
    getVersion().then(setVersion).catch(() => setVersion("0.0.0"));
    const ts = lastCheckAt();
    if (ts > 0) {
      setLastChecked(new Date(ts).toLocaleTimeString());
    }
  }, []);

  async function check() {
    setError(null);
    setStatus("checking");
    try {
      const r = await checkForUpdate();
      markChecked();
      setLastChecked(new Date().toLocaleTimeString());
      if (r) {
        setInfo(r);
        setStatus("available");
      } else {
        setInfo(null);
        setStatus("up_to_date");
      }
    } catch (e) {
      setError(String(e));
      setStatus("idle");
    }
  }

  // Switching the release channel auto-runs the very same check the manual
  // button runs — no separate "now press Check" step. We persist the new
  // channel FIRST (set() writes localStorage synchronously, and
  // checkForUpdate() reads the channel from localStorage, not React state),
  // then reuse check(). Guards: ignore no-op clicks (same channel) and skip
  // while a check/install is already in flight so manual + auto can't race.
  function selectChannel(c: NexuSettings["channel"]) {
    if (c === s.channel) return;
    set({ channel: c });
    if (status === "checking" || status === "installing") return;
    void check();
  }

  async function install() {
    setError(null);
    setStatus("installing");
    try {
      await installUpdate();
      // install_update restarts the app; if we're still here it didn't.
    } catch (e) {
      setError(String(e));
      setStatus("available");
    }
  }

  return (
    <Section
      id="updates"
      kicker={tr("settings.updates.kicker")}
      label={tr("settings.updates.section")}
      t={t}
    >
      <Row
        label={tr("settings.updates.version")}
        hint={tr("settings.updates.version_hint")}
        t={t}
      >
        <div className="flex items-center gap-4 font-mono">
          <div
            className="px-4 py-2 rounded border"
            style={{ background: t.bgPanel, borderColor: t.border }}
          >
            <div
              className="text-[9px] uppercase tracking-wider"
              style={{ color: t.textMuted }}
            >
              {tr("settings.updates.current")}
            </div>
            <div className="text-lg" style={{ color: t.accent }}>
              v{version}
            </div>
          </div>
          {status === "available" && info && (
            <>
              <span style={{ color: t.textMuted }}>→</span>
              <div
                className="px-4 py-2 rounded border"
                style={{
                  background: t.bgPanel,
                  borderColor: t.accent,
                  boxShadow: `0 0 16px ${t.accent}33`,
                }}
              >
                <div
                  className="text-[9px] uppercase tracking-wider"
                  style={{ color: t.textMuted }}
                >
                  {tr("settings.updates.available")}
                </div>
                <div className="text-lg" style={{ color: t.accent }}>
                  v{info.version}
                </div>
              </div>
            </>
          )}
        </div>
      </Row>

      <Row
        label={tr("settings.updates.channel")}
        hint={tr("settings.updates.channel_hint")}
        t={t}
      >
        <div
          className="inline-flex rounded border overflow-hidden font-mono text-xs"
          style={{ borderColor: t.border }}
        >
          {(["stable", "beta"] as const).map((c, i, arr) => (
            <button
              key={c}
              type="button"
              onClick={() => selectChannel(c)}
              className="px-4 py-2 uppercase tracking-wider transition-colors"
              style={{
                background: s.channel === c ? t.bgElevated : t.bgPanel,
                color: s.channel === c ? t.accent : t.textMuted,
                borderRight: i < arr.length - 1 ? `1px solid ${t.border}` : "none",
              }}
            >
              {c}
            </button>
          ))}
        </div>
      </Row>

      <Row
        label={tr("settings.updates.auto")}
        hint={tr("settings.updates.auto_hint")}
        t={t}
      >
        <Toggle
          checked={s.autoUpdate}
          onChange={(v) => set({ autoUpdate: v })}
          t={t}
          label={tr("settings.updates.auto_label")}
          onLabel={tr("settings.nav.on")}
          offLabel={tr("settings.nav.off")}
          enabledLabel={tr("settings.toggle.enabled")}
          disabledLabel={tr("settings.toggle.disabled")}
        />
      </Row>

      <Row
        label={tr("settings.updates.check")}
        hint={
          lastChecked
            ? tr("settings.updates.last_checked", { time: lastChecked })
            : tr("settings.updates.never_checked")
        }
        t={t}
      >
        <div className="space-y-3">
          <button
            type="button"
            onClick={status === "available" ? install : check}
            disabled={status === "checking" || status === "installing"}
            className="font-mono text-sm px-4 py-2 rounded inline-flex items-center gap-2 transition-colors disabled:opacity-60"
            style={{
              background: status === "available" ? t.accent : t.bgPanel,
              color: status === "available" ? t.bgBase : t.textSoft,
              border: `1px solid ${status === "available" ? t.accent : t.border}`,
              fontWeight: status === "available" ? 700 : 400,
            }}
          >
            {(status === "checking" || status === "installing") && (
              <Loader2 size={14} className="animate-spin" />
            )}
            {status === "available" && <Download size={14} />}
            {(status === "idle" || status === "up_to_date") && (
              <RefreshCw size={14} />
            )}
            {status === "checking" && tr("settings.updates.checking")}
            {status === "installing" && tr("settings.updates.installing")}
            {status === "available" && tr("settings.updates.install")}
            {status === "idle" && tr("settings.updates.check_btn")}
            {status === "up_to_date" && tr("settings.updates.check_again")}
          </button>

          {status === "up_to_date" && (
            <div
              className="font-mono text-xs flex items-center gap-2"
              style={{ color: t.accent }}
            >
              <Check size={12} /> {tr("settings.updates.up_to_date")}
            </div>
          )}
          {status === "available" && info && (
            <div
              className="rounded border p-4 font-mono text-xs space-y-2"
              style={{ background: t.bgPanel, borderColor: t.border }}
            >
              <div className="flex items-center justify-between">
                <span style={{ color: t.accent }}>v{info.version}</span>
                {info.date && (
                  <span style={{ color: t.textMuted }}>
                    {tr("settings.updates.released_at", { date: info.date })}
                  </span>
                )}
              </div>
              {info.body && (
                <div
                  className="pt-2 whitespace-pre-wrap max-h-48 overflow-y-auto"
                  style={{ color: t.textPrimary }}
                >
                  {info.body}
                </div>
              )}
            </div>
          )}
          {error && (
            <div className="text-xs font-mono break-all" style={{ color: t.error }}>
              ✗ {error}
            </div>
          )}
        </div>
      </Row>

      <Row
        label={tr("settings.updates.verify")}
        hint={tr("settings.updates.verify_hint")}
        t={t}
      >
        <Toggle
          checked={s.verifySigs}
          onChange={(v) => set({ verifySigs: v })}
          t={t}
          label={tr("settings.updates.verify_label")}
          onLabel={tr("settings.nav.on")}
          offLabel={tr("settings.nav.off")}
          enabledLabel={tr("settings.toggle.enabled")}
          disabledLabel={tr("settings.toggle.disabled")}
        />
      </Row>
    </Section>
  );
}
