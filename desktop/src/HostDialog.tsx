// Add/edit host modal.

import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { X, Lock, KeyRound, Shield, ChevronDown, Folder } from "lucide-react";
import { HostRecord, saveHost, newHostId, listHosts, loadKnownFolders } from "./hosts";
import { FolderPicker } from "./FolderPicker";
import { useIsMobile } from "./useIsMobile";
import {
  vaultKeys,
  vaultStatus,
  vaultSet,
  vaultDelete,
  hostPasswordKey,
} from "./vault";
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

export function HostDialog({ initial, knownGroups, onClose, onSaved }: Props) {
  const isMobile = useIsMobile();
  // When caller didn't pre-compute group suggestions (e.g. opened from
  // TabPicker's "+ Новое подключение"), pull them ourselves so the folder
  // dropdown is never empty in CREATE mode.
  const [autoGroups, setAutoGroups] = useState<string[]>([]);
  useEffect(() => {
    if (knownGroups && knownGroups.length > 0) return;
    let cancelled = false;
    (async () => {
      try {
        const list = await listHosts();
        if (cancelled) return;
        const fromHosts = (list.map((h) => h.group).filter(Boolean) as string[]);
        const folders = loadKnownFolders();
        setAutoGroups(Array.from(new Set([...fromHosts, ...folders])));
      } catch {}
    })();
    return () => { cancelled = true; };
  }, [knownGroups]);
  const effectiveGroups = knownGroups && knownGroups.length > 0 ? knownGroups : autoGroups;
  const { t } = useTranslation();
  const [settings] = useSettings();
  const [name, setName] = useState("");
  const [host, setHost] = useState("");
  const [port, setPort] = useState(settings.defaultPort);
  const [user, setUser] = useState(settings.defaultUser);
  const [group, setGroup] = useState("");
  const [folderPickerOpen, setFolderPickerOpen] = useState(false);
  const [note, setNote] = useState("");
  const [authKind, setAuthKind] = useState<AuthKind>("password");
  const [password, setPassword] = useState("");
  const [keyPath, setKeyPath] = useState("");
  const [keyPass, setKeyPass] = useState("");
  const [vaultKey, setVaultKey] = useState("");
  // Set when editing a host whose saved password lives in the vault under
  // its per-host key; lets us keep it if the user doesn't retype.
  const [savedVaultKey, setSavedVaultKey] = useState<string | null>(null);
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
    // Preserve a host's empty login (e.g. imported "address-only" hosts) —
    // don't paper over it with the local default user.
    setUser(initial.user ?? "");
    setGroup(initial.group ?? "");
    setNote(initial.note ?? "");
    setAlwaysAskPassword(!!initial.alwaysAskPassword);
    setUseVpn(!!initial.useVpn);
    setVpnProfileId(initial.vpnProfileId ?? "");
    setVpnExit(initial.vpnExit ?? "auto");
    // A host whose secret lives in the vault under its own per-host key is
    // shown as a normal "password (saved)" host — the vault is an
    // implementation detail. Leave the field blank; keep the existing
    // secret unless the user types a new one.
    if (
      initial.auth.kind === "vault" &&
      initial.auth.key === hostPasswordKey(initial.id)
    ) {
      setAuthKind("password");
      setAlwaysAskPassword(false);
      setPassword("");
      setSavedVaultKey(initial.auth.key);
    } else {
      setAuthKind(initial.auth.kind);
      setSavedVaultKey(null);
      if (initial.auth.kind === "password") {
        setPassword(initial.auth.password);
      } else if (initial.auth.kind === "key") {
        setKeyPath(initial.auth.path);
        setKeyPass(initial.auth.passphrase ?? "");
      } else if (initial.auth.kind === "vault") {
        setVaultKey(initial.auth.key);
      }
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

  // Login is optional — an address-only host asks for the login on connect
  // (like quick-connect). Only the address is required.
  const canSave = host.trim().length > 0;

  async function doSave() {
    setError(null);
    if (!host.trim()) return setError(t("dialog.err_host_required"));
    try {
      const id = initial?.id ?? newHostId();
      // Saved passwords NEVER touch hosts.json in plaintext — they go into
      // the encrypted vault, and the host only references them by key.
      // "always ask" stores nothing. The manual "vault" tab is unchanged.
      let auth: HostRecord["auth"];
      if (authKind === "key") {
        auth = { kind: "key", path: keyPath, passphrase: keyPass || undefined };
      } else if (authKind === "vault") {
        auth = { kind: "vault", key: vaultKey };
      } else if (alwaysAskPassword) {
        // Not saving — drop any previously-vaulted secret for this host.
        if (savedVaultKey) {
          try {
            await vaultDelete(savedVaultKey);
          } catch {
            /* best-effort */
          }
        }
        auth = { kind: "password", password: "" };
      } else if (password.trim() !== "") {
        // Saving a (new/changed) password → vault. Requires it unlocked.
        const st = await vaultStatus();
        if (!st.unlocked) {
          return setError(t("dialog.err_vault_locked"));
        }
        const key = hostPasswordKey(id);
        await vaultSet(key, password);
        auth = { kind: "vault", key };
      } else if (savedVaultKey) {
        // Editing, field left blank → keep the existing vaulted secret.
        auth = { kind: "vault", key: savedVaultKey };
      } else {
        return setError(t("dialog.err_password_required"));
      }
      const rec: HostRecord = {
        id,
        name: name.trim() || (user.trim() ? `${user.trim()}@${host.trim()}` : host.trim()),
        host: host.trim(),
        port,
        user: user.trim(),
        auth,
        group: group.trim() || undefined,
        note: note.trim() || undefined,
        lastUsedAt: initial?.lastUsedAt,
        alwaysAskPassword: auth.kind === "password" ? alwaysAskPassword : undefined,
        useVpn: useVpn || undefined,
        vpnProfileId: useVpn ? vpnProfileId || undefined : undefined,
        vpnExit: useVpn ? vpnExit : undefined,
        order: initial?.order,
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
        className="nx-modal-enter relative w-[720px] max-w-[94vw] max-h-[92vh] overflow-y-auto bg-nx-panel rounded-nx-lg p-8 pt-7 shadow-elev-modal max-md:w-full max-md:max-w-none max-md:h-full max-md:max-h-none max-md:rounded-none max-md:p-4 max-md:pt-[calc(env(safe-area-inset-top)+16px)]"
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
        <div className="grid grid-cols-2 gap-8 max-md:grid-cols-1 max-md:gap-5">
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

            <RowLabel className="mt-4">{t("dialog.user_optional")}</RowLabel>
            <Input
              value={user}
              onChange={setUser}
              placeholder={t("dialog.user_ph_optional")}
            />

            <RowLabel className="mt-4">{t("dialog.group")}</RowLabel>
            <button
              type="button"
              onClick={() => setFolderPickerOpen(true)}
              className="nx-focus w-full mt-1.5 bg-nx-panel border border-nx-border rounded-nx text-body text-nx-text px-2.5 py-1.5 flex items-center gap-2 font-mono hover:bg-nx-elevated"
            >
              <Folder size={13} className="text-nx-muted shrink-0" />
              <span
                className={
                  "flex-1 text-left truncate " + (group ? "" : "text-nx-muted")
                }
              >
                {group || t("dialog.group_ph")}
              </span>
              <ChevronDown size={12} className="text-nx-muted shrink-0" />
            </button>
            {folderPickerOpen && (
              <FolderPicker
                paths={effectiveGroups}
                current={group || null}
                title={t("dialog.group")}
                onClose={() => setFolderPickerOpen(false)}
                onPick={(path) => {
                  setGroup(path ?? "");
                  setFolderPickerOpen(false);
                }}
              />
            )}

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

            {/* Transport — built-in VPN.
             * Hidden on mobile: the Android APK doesn't ship the xray
             * sidecar (per-host VPN is desktop-only for now), and there's
             * a VPN section in Settings anyway. */}
            {!isMobile && (
              <>
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
              </>
            )}
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

