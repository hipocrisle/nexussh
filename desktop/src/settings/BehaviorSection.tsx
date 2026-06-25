// Behavior section — defaults, sessions, advanced toggle, about.

import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { FileText, Trash2 } from "lucide-react";
import { historyStats, historyClear } from "../history";
import { askConfirm } from "../dialogs";
import { ThemePalette } from "./themes";
import {
  Section,
  Row,
  Toggle,
  Slider,
  NumField,
  TextField,
} from "./primitives";
import type { NexuSettings } from "./settings-store";
import { ImportHostsPanel } from "../ImportHostsPanel";
import { BulkImportDialog } from "../BulkImportDialog";
import { BundleExportDialog } from "../BundleExportDialog";
import { BundleImportDialog } from "../BundleImportDialog";
import { useIsMobile } from "../useIsMobile";

interface Props {
  s: NexuSettings;
  set: (patch: Partial<NexuSettings>) => void;
  t: ThemePalette;
}

export function BehaviorSection({ s, set, t }: Props) {
  const { t: tr } = useTranslation();
  const [importOpen, setImportOpen] = useState(false);
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bundleExportOpen, setBundleExportOpen] = useState(false);
  const [bundleImportOpen, setBundleImportOpen] = useState(false);
  const isMobile = useIsMobile();
  const [histStats, setHistStats] = useState({ sessions: 0, bytes: 0 });
  const refreshStats = () => {
    historyStats().then(setHistStats).catch(() => {});
  };
  useEffect(() => {
    if (s.historyEnabled) refreshStats();
  }, [s.historyEnabled]);
  const fmtBytes = (n: number) =>
    n < 1024
      ? `${n} B`
      : n < 1048576
        ? `${(n / 1024).toFixed(0)} KB`
        : `${(n / 1048576).toFixed(1)} MB`;

  return (
    <Section
      id="behavior"
      kicker={tr("settings.behavior.kicker")}
      label={tr("settings.behavior.section")}
      t={t}
    >
      <Row
        label={tr("settings.behavior.port")}
        hint={tr("settings.behavior.port_hint")}
        t={t}
      >
        <NumField
          value={s.defaultPort}
          onChange={(v) => set({ defaultPort: v })}
          suffix="tcp"
          min={1}
          max={65535}
          t={t}
        />
      </Row>

      <Row
        label={tr("settings.behavior.user")}
        hint={tr("settings.behavior.user_hint")}
        t={t}
      >
        <div className="max-w-xs">
          <TextField
            value={s.defaultUser}
            onChange={(v) => set({ defaultUser: v })}
            placeholder="root"
            t={t}
          />
        </div>
      </Row>

      <Row
        label={tr("settings.behavior.timeout")}
        hint={tr("settings.behavior.timeout_hint")}
        t={t}
      >
        <Slider
          value={s.timeout}
          onChange={(v) => set({ timeout: v })}
          min={5}
          max={60}
          t={t}
          format={(v) => `${v}s`}
        />
      </Row>

      <Row
        label={tr("settings.behavior.keepalive")}
        hint={tr("settings.behavior.keepalive_hint")}
        t={t}
      >
        <Slider
          value={s.keepalive}
          onChange={(v) => set({ keepalive: v })}
          min={0}
          max={120}
          step={5}
          t={t}
          format={(v) =>
            v === 0 ? tr("settings.behavior.keepalive_off") : `${v}s`
          }
        />
      </Row>

      {!isMobile && (
      <Row
        label={tr("settings.behavior.click")}
        hint={tr("settings.behavior.click_hint")}
        t={t}
      >
        <div className="space-y-2">
          {(
            [
              {
                id: "connect" as const,
                label: tr("settings.behavior.click_connect"),
                sub: tr("settings.behavior.click_connect_sub"),
              },
              {
                id: "select" as const,
                label: tr("settings.behavior.click_select"),
                sub: tr("settings.behavior.click_select_sub"),
              },
            ]
          ).map((opt) => (
            <button
              key={opt.id}
              type="button"
              onClick={() => set({ clickMode: opt.id })}
              className="w-full text-left rounded p-3 transition-colors flex items-start gap-3 cursor-pointer"
              style={{
                background: s.clickMode === opt.id ? t.bgPanel : "transparent",
                border: `1px solid ${s.clickMode === opt.id ? t.accent : t.border}`,
              }}
            >
              <span
                className="mt-0.5 w-3.5 h-3.5 rounded-full border-2 shrink-0 flex items-center justify-center"
                style={{
                  borderColor:
                    s.clickMode === opt.id ? t.accent : t.textMuted,
                }}
              >
                {s.clickMode === opt.id && (
                  <span
                    className="w-1.5 h-1.5 rounded-full"
                    style={{ background: t.accent }}
                  />
                )}
              </span>
              <div className="font-mono text-xs">
                <div style={{ color: t.textPrimary }}>{opt.label}</div>
                <div className="text-[11px] mt-0.5" style={{ color: t.textMuted }}>
                  {opt.sub}
                </div>
              </div>
            </button>
          ))}
        </div>
      </Row>
      )}

      <Row
        label={tr("settings.behavior.restore")}
        hint={tr("settings.behavior.restore_hint")}
        t={t}
      >
        <Toggle
          checked={s.restoreSession}
          onChange={(v) => set({ restoreSession: v })}
          t={t}
          label={tr("settings.behavior.restore_label")}
          onLabel={tr("settings.nav.on")}
          offLabel={tr("settings.nav.off")}
          enabledLabel={tr("settings.toggle.enabled")}
          disabledLabel={tr("settings.toggle.disabled")}
        />
      </Row>

      <Row
        label={tr("settings.behavior.autolock")}
        hint={tr("settings.behavior.autolock_hint")}
        t={t}
      >
        <NumField
          value={s.vaultAutoLockMin}
          onChange={(v) => set({ vaultAutoLockMin: v })}
          suffix={tr("settings.behavior.autolock_suffix")}
          min={0}
          max={240}
          t={t}
        />
      </Row>

      {/* History — desktop only: there's no UI to VIEW recordings on the phone,
          just a toggle, so hide the whole block on mobile. */}
      {!isMobile && (
        <>
      <Row
        label={tr("settings.behavior.history")}
        hint={tr("settings.behavior.history_hint")}
        t={t}
      >
        <Toggle
          checked={s.historyEnabled}
          onChange={(v) => set({ historyEnabled: v })}
          t={t}
          label={tr("settings.behavior.history_label")}
          onLabel={tr("settings.nav.on")}
          offLabel={tr("settings.nav.off")}
          enabledLabel={tr("settings.toggle.enabled")}
          disabledLabel={tr("settings.toggle.disabled")}
        />
      </Row>

      {s.historyEnabled && (
        <>
          <Row
            label={tr("settings.behavior.history_usage")}
            hint={tr("settings.behavior.history_usage_hint")}
            t={t}
          >
            <div className="flex items-center gap-3 flex-wrap">
              <span className="font-mono text-xs" style={{ color: t.textSoft }}>
                {tr("settings.behavior.history_usage_value", {
                  count: histStats.sessions,
                  size: fmtBytes(histStats.bytes),
                })}
              </span>
              <button
                type="button"
                disabled={histStats.sessions === 0}
                onClick={async () => {
                  const ok = await askConfirm(
                    tr("settings.behavior.history_clear_confirm"),
                    { destructive: true },
                  );
                  if (!ok) return;
                  await historyClear().catch(() => {});
                  refreshStats();
                }}
                className="inline-flex items-center gap-2 px-3 py-2 font-mono text-xs rounded disabled:opacity-40"
                style={{
                  background: t.bgPanel,
                  border: `1px solid ${t.border}`,
                  color: t.error,
                }}
              >
                <Trash2 size={12} />
                {tr("settings.behavior.history_clear")}
              </button>
            </div>
          </Row>
        </>
      )}
        </>
      )}

      <Row
        label={tr("settings.behavior.reconnect")}
        hint={tr("settings.behavior.reconnect_hint")}
        t={t}
      >
        <Toggle
          checked={s.autoReconnect}
          onChange={(v) => set({ autoReconnect: v })}
          t={t}
          label={tr("settings.behavior.reconnect_label")}
          onLabel={tr("settings.nav.on")}
          offLabel={tr("settings.nav.off")}
          enabledLabel={tr("settings.toggle.enabled")}
          disabledLabel={tr("settings.toggle.disabled")}
        />
      </Row>

      {!isMobile && (
      <Row
        label={tr("settings.behavior.confirm")}
        hint={tr("settings.behavior.confirm_hint")}
        t={t}
      >
        <Toggle
          checked={s.confirmClose}
          onChange={(v) => set({ confirmClose: v })}
          t={t}
          label={tr("settings.behavior.confirm_label")}
          onLabel={tr("settings.nav.on")}
          offLabel={tr("settings.nav.off")}
          enabledLabel={tr("settings.toggle.enabled")}
          disabledLabel={tr("settings.toggle.disabled")}
        />
      </Row>
      )}

      {!isMobile && (
      <Row
        label={tr("settings.behavior.ssh_config_import")}
        hint={tr("settings.behavior.ssh_config_import_hint")}
        t={t}
      >
        <button
          type="button"
          onClick={() => setImportOpen(true)}
          className="inline-flex items-center gap-2 px-3 py-2 font-mono text-xs rounded"
          style={{
            background: t.bgPanel,
            border: `1px solid ${t.border}`,
            color: t.textSoft,
          }}
        >
          <FileText size={12} />
          {tr("settings.behavior.ssh_config_import_btn")}
        </button>
        {importOpen && (
          <ImportHostsPanel
            onClose={() => setImportOpen(false)}
            onImported={() => setImportOpen(false)}
          />
        )}
      </Row>
      )}

      <Row
        label={tr("settings.behavior.bulk_import")}
        hint={tr("settings.behavior.bulk_import_hint")}
        t={t}
      >
        <button
          type="button"
          onClick={() => setBulkOpen(true)}
          className="inline-flex items-center gap-2 px-3 py-2 font-mono text-xs rounded"
          style={{
            background: t.bgPanel,
            border: `1px solid ${t.border}`,
            color: t.textSoft,
          }}
        >
          <FileText size={12} />
          {tr("settings.behavior.bulk_import_btn")}
        </button>
        {bulkOpen && (
          <BulkImportDialog
            onClose={() => setBulkOpen(false)}
            onImported={() => {}}
          />
        )}
      </Row>

      <Row
        label={tr("settings.behavior.bundle")}
        hint={tr("settings.behavior.bundle_hint")}
        t={t}
      >
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setBundleExportOpen(true)}
            className="inline-flex items-center gap-2 px-3 py-2 font-mono text-xs rounded"
            style={{
              background: t.bgPanel,
              border: `1px solid ${t.border}`,
              color: t.textSoft,
            }}
          >
            <FileText size={12} />
            {tr("settings.behavior.bundle_export_btn")}
          </button>
          <button
            type="button"
            onClick={() => setBundleImportOpen(true)}
            className="inline-flex items-center gap-2 px-3 py-2 font-mono text-xs rounded"
            style={{
              background: t.bgPanel,
              border: `1px solid ${t.border}`,
              color: t.textSoft,
            }}
          >
            <FileText size={12} />
            {tr("settings.behavior.bundle_import_btn")}
          </button>
        </div>
        {bundleExportOpen && (
          <BundleExportDialog onClose={() => setBundleExportOpen(false)} />
        )}
        {bundleImportOpen && (
          <BundleImportDialog onClose={() => setBundleImportOpen(false)} />
        )}
      </Row>

      {!isMobile && (
      <Row
        label={tr("settings.behavior.putty_mouse")}
        hint={tr("settings.behavior.putty_mouse_hint")}
        t={t}
      >
        <Toggle
          checked={s.puttyMouse}
          onChange={(v) => set({ puttyMouse: v })}
          t={t}
          label={tr("settings.behavior.putty_mouse_label")}
          onLabel={tr("settings.nav.on")}
          offLabel={tr("settings.nav.off")}
          enabledLabel={tr("settings.toggle.enabled")}
          disabledLabel={tr("settings.toggle.disabled")}
        />
      </Row>
      )}

      <Row
        label={tr("settings.behavior.advanced")}
        hint={tr("settings.behavior.advanced_hint")}
        t={t}
      >
        <Toggle
          checked={s.advanced}
          onChange={(v) => set({ advanced: v })}
          t={t}
          label={tr("settings.behavior.advanced_label")}
          onLabel={tr("settings.nav.on")}
          offLabel={tr("settings.nav.off")}
          enabledLabel={tr("settings.toggle.enabled")}
          disabledLabel={tr("settings.toggle.disabled")}
        />
      </Row>

    </Section>
  );
}
