// Add/edit host modal.

import { useState, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { X, Lock, KeyRound, Shield, ChevronDown } from "lucide-react";
import { HostRecord, saveHost, newHostId } from "./hosts";
import { vaultKeys } from "./vault";
import { useSettings } from "./settings/settings-store";
import { useBackdropClose } from "./useBackdropClose";
import {
  Button,
  Input,
  PasswordInput,
  Checkbox,
  SegCtl,
  RowLabel,
  ToggleRow,
} from "./components/primitives";
import { loadProfiles, type VpnProfile } from "./vpn";

type AuthKind = "password" | "key" | "vault";

const advancedEnabled = () => localStorage.getItem("nexussh.advanced") === "1";

interface Props {
  initial?: HostRecord;
  /** Existing group names from other hosts, surfaced as datalist suggestions. */
  knownGroups?: string[];
  onClose: () => void;
  onSaved: (h: HostRecord) => void;
}

export function HostDialog({ initial, knownGroups = [], onClose, onSaved }: Props) {
  const { t } = useTranslation();
  const [settings] = useSettings();
  const [name, setName] = useState("");
  const [host, setHost] = useState("");
  const [port, setPort] = useState(settings.defaultPort);
  const [user, setUser] = useState(settings.defaultUser);
  const [group, setGroup] = useState("");
  const [note, setNote] = useState("");
  const [authKind, setAuthKind] = useState<AuthKind>("password");
  const [password, setPassword] = useState("");
  const [keyPath, setKeyPath] = useState("");
  const [keyPass, setKeyPass] = useState("");
  const [vaultKey, setVaultKey] = useState("");
  const [vaultAvailable, setVaultAvailable] = useState<boolean | null>(null);
  const [vaultKeyOptions, setVaultKeyOptions] = useState<string[]>([]);
  // Default: ask every connect. Inverted in UI as "save password" opt-in.
  const [alwaysAskPassword, setAlwaysAskPassword] = useState<boolean>(true);
  const [useVpn, setUseVpn] = useState(false);
  const [vpnProfileId, setVpnProfileId] = useState("");
  const [vpnExit, setVpnExit] = useState("auto");
  const [vpnProfiles] = useState<VpnProfile[]>(() => loadProfiles());
  const [error, setError] = useState<string | null>(null);
  const { backdropProps, contentProps } = useBackdropClose(onClose);

  const isEdit = !!initial;

  useEffect(() => {
    if (!initial) return;
    setName(initial.name);
    setHost(initial.host);
    setPort(initial.port || settings.defaultPort);
    setUser(initial.user || settings.defaultUser);
    setGroup(initial.group ?? "");
    setNote(initial.note ?? "");
    setAlwaysAskPassword(!!initial.alwaysAskPassword);
    setUseVpn(!!initial.useVpn);
    setVpnProfileId(initial.vpnProfileId ?? "");
    setVpnExit(initial.vpnExit ?? "auto");
    setAuthKind(initial.auth.kind);
    if (initial.auth.kind === "password") {
      setPassword(initial.auth.password);
    } else if (initial.auth.kind === "key") {
      setKeyPath(initial.auth.path);
      setKeyPass(initial.auth.passphrase ?? "");
    } else if (initial.auth.kind === "vault") {
      setVaultKey(initial.auth.key);
    }
  }, [initial]);

  // Probe vault unlock state when user selects vault tab
  useEffect(() => {
    if (authKind !== "vault") return;
    vaultKeys()
      .then((keys) => {
        setVaultAvailable(true);
        setVaultKeyOptions(keys);
      })
      .catch(() => {
        setVaultAvailable(false);
        setVaultKeyOptions([]);
      });
  }, [authKind]);

  const canSave = host.trim().length > 0 && user.trim().length > 0;

  async function doSave() {
    setError(null);
    if (!host.trim()) return setError(t("dialog.err_host_required"));
    if (!user.trim()) return setError(t("dialog.err_user_required"));
    try {
      const auth: HostRecord["auth"] =
        authKind === "password"
          ? { kind: "password", password }
          : authKind === "key"
            ? { kind: "key", path: keyPath, passphrase: keyPass || undefined }
            : { kind: "vault", key: vaultKey };
      const rec: HostRecord = {
        id: initial?.id ?? newHostId(),
        name: name.trim() || `${user}@${host}`,
        host: host.trim(),
        port,
        user: user.trim(),
        auth,
        group: group.trim() || undefined,
        note: note.trim() || undefined,
        lastUsedAt: initial?.lastUsedAt,
        alwaysAskPassword: authKind === "password" ? alwaysAskPassword : undefined,
        useVpn: useVpn || undefined,
        vpnProfileId: useVpn ? vpnProfileId || undefined : undefined,
        vpnExit: useVpn ? vpnExit : undefined,
      };
      await saveHost(rec);
      onSaved(rec);
    } catch (e) {
      setError(String(e));
    }
  }

  function onFormKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && canSave) {
      e.preventDefault();
      doSave();
    }
  }

  // Vault tab is gated behind the advanced flag, but keep it visible when
  // editing a host that already uses vault auth so the value isn't lost.
  const authOptions: { value: AuthKind; label: string; icon: React.ReactNode }[] = [
    { value: "password", label: t("dialog.auth_password"), icon: <Lock size={12} /> },
    { value: "key", label: t("dialog.auth_key"), icon: <KeyRound size={12} /> },
  ];
  if (advancedEnabled() || authKind === "vault") {
    authOptions.push({ value: "vault", label: t("dialog.auth_vault"), icon: <Shield size={12} /> });
  }

  const kicker = "text-micro uppercase tracking-[0.2em] text-nx-accent";

  return (
    <div className="nx-scrim grid place-items-center" {...backdropProps}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          doSave();
        }}
        onKeyDown={onFormKeyDown}
        {...contentProps}
        className="nx-modal-enter relative w-[720px] max-w-[94vw] max-h-[92vh] overflow-y-auto bg-nx-panel rounded-nx-lg p-8 pt-7 shadow-elev-modal"
      >
        <span className="nx-brackets">
          <i />
        </span>

        {/* Title */}
        <div className="flex items-baseline gap-3 pb-4 border-b border-nx-divider mb-6">
          <span className={kicker}>// {isEdit ? t("dialog.edit_kicker") : t("dialog.new_kicker")}</span>
          <div className="text-h2 text-nx-text font-mono">
            <span className="text-nx-accent mr-2">&gt;</span>
            {isEdit ? "edit_host" : "new_host"}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="ml-auto p-1.5 text-nx-muted hover:text-nx-text"
          >
            <X size={14} />
          </button>
        </div>

        {/* Two-column form */}
        <div className="grid grid-cols-2 gap-8">
          {/* Identity */}
          <div>
            <div className={kicker + " mb-3 block"}>// {t("dialog.col_identity")}</div>

            <RowLabel>{t("dialog.display_name")}</RowLabel>
            <Input
              value={name}
              onChange={setName}
              placeholder={t("dialog.display_name_ph")}
              autoFocus
            />

            <div className="grid grid-cols-[1fr_80px] gap-3 mt-4">
              <div>
                <RowLabel>{t("dialog.host")}</RowLabel>
                <Input
                  value={host}
                  onChange={setHost}
                  placeholder={t("dialog.host_ph")}
                  invalid={!host.trim() && !!error}
                />
              </div>
              <div>
                <RowLabel>{t("dialog.port")}</RowLabel>
                <Input
                  value={String(port)}
                  onChange={(v) => setPort(parseInt(v) || settings.defaultPort)}
                  inputMode="numeric"
                />
              </div>
            </div>

            <RowLabel className="mt-4">{t("dialog.user")}</RowLabel>
            <Input
              value={user}
              onChange={setUser}
              placeholder={t("dialog.user_ph")}
              invalid={!user.trim() && !!error}
            />

            <RowLabel className="mt-4">{t("dialog.group")}</RowLabel>
            <GroupCombobox
              value={group}
              onChange={setGroup}
              options={knownGroups}
              placeholder={t("dialog.group_ph")}
            />

            <RowLabel className="mt-4">{t("dialog.note")}</RowLabel>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              className="nx-focus w-full mt-1.5 bg-nx-panel border border-nx-border rounded-nx text-body text-nx-text placeholder-nx-muted px-2.5 py-1.5 h-16 resize-none font-mono"
              placeholder="..."
            />
          </div>

          {/* Authentication */}
          <div>
            <div className={kicker + " mb-3 block"}>// {t("dialog.col_auth")}</div>

            <SegCtl value={authKind} onChange={setAuthKind} options={authOptions} />

            {authKind === "password" && (
              <div className="mt-4">
                <RowLabel>{t("dialog.password")}</RowLabel>
                {alwaysAskPassword ? (
                  <Input
                    value=""
                    onChange={() => {}}
                    disabled
                    placeholder={t("dialog.password_ask_each_time_ph")}
                  />
                ) : (
                  <PasswordInput value={password} onChange={setPassword} />
                )}
                {/* Inverted: stored as `alwaysAskPassword` (asks each time
                 *  when true) but shown to the user as an opt-in "save
                 *  password" toggle. Default is ask-every-time = safer. */}
                <Checkbox
                  checked={!alwaysAskPassword}
                  onChange={(v) => setAlwaysAskPassword(!v)}
                  className="mt-3.5"
                  label={t("dialog.save_password")}
                  hint={t("dialog.save_password_hint")}
                />
              </div>
            )}

            {authKind === "key" && (
              <div className="mt-4">
                <RowLabel>{t("dialog.key_path")}</RowLabel>
                <Input
                  value={keyPath}
                  onChange={setKeyPath}
                  placeholder={t("dialog.key_path_ph")}
                />
                <RowLabel className="mt-3">{t("dialog.passphrase")}</RowLabel>
                <PasswordInput value={keyPass} onChange={setKeyPass} />
              </div>
            )}

            {authKind === "vault" && (
              <div className="mt-4">
                <RowLabel>{t("dialog.vault_key")}</RowLabel>
                <Input
                  value={vaultKey}
                  onChange={setVaultKey}
                  placeholder={t("dialog.vault_key_ph")}
                  list="vault-keys"
                />
                <datalist id="vault-keys">
                  {vaultKeyOptions.map((k) => (
                    <option key={k} value={k} />
                  ))}
                </datalist>
                {vaultAvailable === false && (
                  <p className="text-nx-warning text-meta font-mono mt-2">
                    ⚠ {t("dialog.vault_unavailable")}
                  </p>
                )}
              </div>
            )}

            {/* Transport — built-in VPN */}
            <div className={kicker + " mt-6 mb-3 block"}>// {t("dialog.col_transport")}</div>
            <ToggleRow label={t("dialog.use_vpn")} value={useVpn} onChange={setUseVpn} />
            {useVpn &&
              (vpnProfiles.length === 0 ? (
                <p className="text-nx-warning text-meta font-mono mt-2">
                  ⚠ {t("dialog.vpn_no_profiles")}
                </p>
              ) : (
                <div className="mt-2 space-y-3">
                  <div>
                    <RowLabel>{t("dialog.vpn_profile")}</RowLabel>
                    <select
                      value={vpnProfileId}
                      onChange={(e) => {
                        setVpnProfileId(e.target.value);
                        setVpnExit("auto");
                      }}
                      className="nx-focus w-full mt-1.5 px-2.5 py-1.5 bg-nx-panel border border-nx-border rounded-nx font-mono text-body text-nx-text"
                    >
                      <option value="">{t("dialog.vpn_pick_profile")}</option>
                      {vpnProfiles.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  {vpnProfileId && (
                    <div>
                      <RowLabel>{t("dialog.vpn_exit")}</RowLabel>
                      <select
                        value={vpnExit}
                        onChange={(e) => setVpnExit(e.target.value)}
                        className="nx-focus w-full mt-1.5 px-2.5 py-1.5 bg-nx-panel border border-nx-border rounded-nx font-mono text-body text-nx-text"
                      >
                        <option value="auto">{t("dialog.vpn_auto")}</option>
                        {(vpnProfiles.find((p) => p.id === vpnProfileId)?.nodes ?? []).map((n) => (
                          <option key={n.tag} value={n.tag}>
                            {n.tag}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}
                </div>
              ))}
          </div>
        </div>

        {error && (
          <div className="text-nx-error text-body font-mono mt-5">✗ {error}</div>
        )}

        {/* Footer */}
        <div className="mt-7 pt-4 border-t border-nx-divider flex items-center gap-3">
          <span className="text-meta text-nx-muted">
            ⌘↵ <span className="ml-1">{t("dialog.shortcut_save")}</span>
          </span>
          <span className="text-meta text-nx-muted">
            esc <span className="ml-1">{t("dialog.shortcut_cancel")}</span>
          </span>
          <div className="ml-auto flex gap-2">
            <Button type="button" variant="secondary" onClick={onClose}>
              {t("dialog.cancel")}
            </Button>
            <Button type="submit" variant="primary" disabled={!canSave}>
              {t("dialog.save")}
            </Button>
          </div>
        </div>
      </form>
    </div>
  );
}

// GroupCombobox — themed input + dropdown of existing groups. Replaces the
// browser's native <input list=…> + <datalist> popup, which renders as a
// white WebView2 system menu with no theme support.
function GroupCombobox({
  value,
  onChange,
  options,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  options: string[];
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const filter = value.trim().toLowerCase();
  const filtered = filter
    ? options.filter((g) => g.toLowerCase().includes(filter))
    : options;

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <Input
        value={value}
        onChange={(v) => {
          onChange(v);
          if (!open) setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        placeholder={placeholder}
      />
      {options.length > 0 && (
        <button
          type="button"
          tabIndex={-1}
          onClick={() => setOpen((o) => !o)}
          className="absolute right-1.5 top-1/2 mt-[3px] -translate-y-1/2 p-1 text-nx-muted hover:text-nx-text"
        >
          <ChevronDown size={14} />
        </button>
      )}
      {open && filtered.length > 0 && (
        <div
          className="absolute top-full left-0 right-0 mt-1 max-h-48 overflow-y-auto bg-nx-panel border border-nx-border rounded-nx shadow-elev-modal z-30 font-mono text-sm"
        >
          {filtered.map((opt) => (
            <button
              key={opt}
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                onChange(opt);
                setOpen(false);
              }}
              className="w-full text-left px-3 py-1.5 hover:bg-nx-elevated text-nx-text"
            >
              {opt}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
