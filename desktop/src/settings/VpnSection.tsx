// Built-in VPN section — manage subscription profiles used by the per-host
// "route via built-in VPN" toggle. Profiles live locally (per machine), never
// in hosts.json, so the subscription secret doesn't ride the sync.

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { RefreshCw, Trash2, Plus, ShieldCheck, ShieldAlert } from "lucide-react";
import { ThemePalette } from "./themes";
import { Section, Row, TextField } from "./primitives";
import {
  loadProfiles,
  addProfileFromUrl,
  refreshProfile,
  removeProfile,
  type VpnProfile,
  loadCorpProfiles,
  addCorpProfile,
  updateCorpProfile,
  removeCorpProfile,
  corpVpnProbeCert,
  ensureVpnBackend,
  VPN_BACKEND_ID,
  type CorpVpnProfile,
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

  // --- OpenConnect (AnyConnect / ocserv) VPN profiles -----------------------
  const [corp, setCorp] = useState<CorpVpnProfile[]>(() => loadCorpProfiles());
  const [cName, setCName] = useState("");
  const [cServer, setCServer] = useState("");
  const [cUser, setCUser] = useState("");
  const [cGroup, setCGroup] = useState("");
  const [cMtu, setCMtu] = useState("");
  const [cBusy, setCBusy] = useState(false);
  const [cError, setCError] = useState<string | null>(null);

  function onAddCorp() {
    if (!cServer.trim() || !cUser.trim()) return;
    addCorpProfile({
      name: cName.trim() || cServer.trim(),
      server: cServer.trim(),
      username: cUser.trim(),
      serverCert: "",
      authgroup: cGroup.trim(),
      mtu: cMtu.trim(),
    });
    setCorp(loadCorpProfiles());
    setCName(""); setCServer(""); setCUser(""); setCGroup(""); setCMtu("");
    setCError(null);
  }

  async function onTrustCorp(p: CorpVpnProfile) {
    setCBusy(true);
    setCError(null);
    try {
      // Ensure the openconnect backend is downloaded first (probe runs it).
      await ensureVpnBackend(VPN_BACKEND_ID);
      const pin = await corpVpnProbeCert(p);
      if (confirm(tr("settings.vpn.corp.trust_confirm", { server: p.server, pin }))) {
        updateCorpProfile(p.id, { serverCert: pin });
        setCorp(loadCorpProfiles());
      }
    } catch (e) {
      setCError(String(e));
    } finally {
      setCBusy(false);
    }
  }

  function onDeleteCorp(id: string) {
    if (!confirm(tr("settings.vpn.delete_confirm"))) return;
    removeCorpProfile(id);
    setCorp(loadCorpProfiles());
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

      <Row label={tr("settings.vpn.corp.add")} hint={tr("settings.vpn.corp.add_hint")} t={t}>
        <div className="space-y-2 max-w-md">
          <TextField value={cName} onChange={setCName} placeholder={tr("settings.vpn.corp.name_ph")} t={t} />
          <TextField value={cServer} onChange={setCServer} placeholder={tr("settings.vpn.corp.server_ph")} t={t} />
          <TextField value={cUser} onChange={setCUser} placeholder={tr("settings.vpn.corp.user_ph")} t={t} />
          <TextField value={cGroup} onChange={setCGroup} placeholder={tr("settings.vpn.corp.group_ph")} t={t} />
          <TextField value={cMtu} onChange={setCMtu} placeholder={tr("settings.vpn.corp.mtu_ph")} t={t} />
          <button type="button" onClick={onAddCorp} disabled={!cServer.trim() || !cUser.trim()} className={btn} style={btnStyle}>
            <Plus size={12} /> {tr("settings.vpn.corp.add_btn")}
          </button>
          {cError && (
            <div className="font-mono text-[11px] break-all" style={{ color: t.error }}>✗ {cError}</div>
          )}
        </div>
      </Row>

      <Row label={tr("settings.vpn.corp.profiles")} hint={tr("settings.vpn.corp.profiles_hint")} t={t}>
        {corp.length === 0 ? (
          <div className="font-mono text-xs" style={{ color: t.textMuted }}>
            {tr("settings.vpn.corp.empty")}
          </div>
        ) : (
          <div className="space-y-2">
            {corp.map((p) => (
              <div
                key={p.id}
                className="flex items-center gap-3 rounded p-3"
                style={{ background: t.bgPanel, border: `1px solid ${t.border}` }}
              >
                <div className="min-w-0 flex-1 font-mono text-xs">
                  <div className="truncate" style={{ color: t.textPrimary }}>{p.name}</div>
                  <div className="text-[11px] mt-0.5 truncate" style={{ color: t.textMuted }}>
                    {p.username}@{p.server}
                  </div>
                  <div className="text-[11px] mt-1 flex items-center gap-1.5" style={{ color: t.textMuted }}>
                    <span>{tr("settings.vpn.corp.mtu")}</span>
                    <input
                      type="text"
                      inputMode="numeric"
                      value={p.mtu ?? ""}
                      onChange={(e) => {
                        updateCorpProfile(p.id, { mtu: e.target.value.replace(/[^0-9]/g, "") });
                        setCorp(loadCorpProfiles());
                      }}
                      placeholder={tr("settings.vpn.corp.mtu_ph")}
                      className="w-20 px-1.5 py-0.5 rounded font-mono text-[11px] outline-none"
                      style={{ background: t.bgBase, border: `1px solid ${t.border}`, color: t.textSoft }}
                    />
                  </div>
                  <div
                    className="text-[11px] mt-0.5 flex items-center gap-1"
                    style={{ color: p.serverCert ? t.textSoft : t.error }}
                  >
                    {p.serverCert ? (
                      <><ShieldCheck size={11} /> {tr("settings.vpn.corp.trusted")}</>
                    ) : (
                      <><ShieldAlert size={11} /> {tr("settings.vpn.corp.untrusted")}</>
                    )}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => onTrustCorp(p)}
                  disabled={cBusy}
                  title={tr("settings.vpn.corp.trust")}
                  className="p-1.5 disabled:opacity-40"
                  style={{ color: t.textSoft }}
                >
                  <ShieldCheck size={14} />
                </button>
                <button
                  type="button"
                  onClick={() => onDeleteCorp(p.id)}
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
