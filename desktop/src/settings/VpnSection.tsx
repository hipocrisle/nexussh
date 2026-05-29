// Built-in VPN section — manage subscription profiles used by the per-host
// "route via built-in VPN" toggle. Profiles live locally (per machine), never
// in hosts.json, so the subscription secret doesn't ride the sync.

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { RefreshCw, Trash2, Plus } from "lucide-react";
import { ThemePalette } from "./themes";
import { Section, Row, TextField } from "./primitives";
import {
  loadProfiles,
  addProfileFromUrl,
  refreshProfile,
  removeProfile,
  type VpnProfile,
} from "../vpn";

interface Props {
  t: ThemePalette;
}

export function VpnSection({ t }: Props) {
  const { t: tr } = useTranslation();
  const [profiles, setProfiles] = useState<VpnProfile[]>(() => loadProfiles());
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onAdd() {
    if (!url.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await addProfileFromUrl(name, url.trim());
      setProfiles(loadProfiles());
      setName("");
      setUrl("");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function onRefresh(id: string) {
    setBusy(true);
    setError(null);
    try {
      await refreshProfile(id);
      setProfiles(loadProfiles());
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  function onDelete(id: string) {
    if (!confirm(tr("settings.vpn.delete_confirm"))) return;
    removeProfile(id);
    setProfiles(loadProfiles());
  }

  const btn = "inline-flex items-center gap-1.5 px-3 py-2 font-mono text-xs rounded disabled:opacity-40";
  const btnStyle = { background: t.bgPanel, border: `1px solid ${t.border}`, color: t.textSoft };

  return (
    <Section
      id="vpn"
      kicker={tr("settings.vpn.kicker")}
      label={tr("settings.vpn.section")}
      t={t}
    >
      <p className="font-mono text-xs mb-5 max-w-xl leading-relaxed" style={{ color: t.textMuted }}>
        {tr("settings.vpn.intro")}
      </p>

      <Row label={tr("settings.vpn.add")} hint={tr("settings.vpn.add_hint")} t={t}>
        <div className="space-y-2 max-w-md">
          <TextField value={name} onChange={setName} placeholder={tr("settings.vpn.name_ph")} t={t} />
          <TextField value={url} onChange={setUrl} placeholder={tr("settings.vpn.url_ph")} t={t} />
          <button type="button" onClick={onAdd} disabled={busy || !url.trim()} className={btn} style={btnStyle}>
            <Plus size={12} /> {busy ? tr("settings.vpn.importing") : tr("settings.vpn.import")}
          </button>
          {error && (
            <div className="font-mono text-[11px] break-all" style={{ color: t.error }}>
              ✗ {error}
            </div>
          )}
        </div>
      </Row>

      <Row label={tr("settings.vpn.profiles")} hint={tr("settings.vpn.profiles_hint")} t={t}>
        {profiles.length === 0 ? (
          <div className="font-mono text-xs" style={{ color: t.textMuted }}>
            {tr("settings.vpn.empty")}
          </div>
        ) : (
          <div className="space-y-2">
            {profiles.map((p) => (
              <div
                key={p.id}
                className="flex items-center gap-3 rounded p-3"
                style={{ background: t.bgPanel, border: `1px solid ${t.border}` }}
              >
                <div className="min-w-0 flex-1 font-mono text-xs">
                  <div className="truncate" style={{ color: t.textPrimary }}>
                    {p.name}
                  </div>
                  <div className="text-[11px] mt-0.5" style={{ color: t.textMuted }}>
                    {tr("settings.vpn.node_count", { n: p.nodes.length })} · {p.updatedAt.slice(0, 10)}
                  </div>
                </div>
                {p.subUrl && (
                  <button
                    type="button"
                    onClick={() => onRefresh(p.id)}
                    disabled={busy}
                    title={tr("settings.vpn.refresh")}
                    className="p-1.5 disabled:opacity-40"
                    style={{ color: t.textSoft }}
                  >
                    <RefreshCw size={14} />
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => onDelete(p.id)}
                  title={tr("settings.vpn.delete")}
                  className="p-1.5"
                  style={{ color: t.error }}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>
        )}
      </Row>
    </Section>
  );
}
