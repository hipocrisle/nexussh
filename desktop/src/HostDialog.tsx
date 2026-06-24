// Add/edit host modal.

import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { X, Lock, KeyRound, ChevronDown, Folder, FolderOpen, Pencil, Plus } from "lucide-react";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";

const HAS_TAURI = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
import { HostRecord, saveHost, newHostId, listHosts, loadKnownFolders } from "./hosts";
import { accountRecordTombstones, accountSyncNow } from "./account";
import type { PortForward } from "./tunnel";
import { FolderPicker } from "./FolderPicker";
import { ForwardEditDialog } from "./ForwardEditDialog";
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
import { Select } from "./Select";

type AuthKind = "password" | "key" | "vault";


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
  // All existing hosts — used to warn about duplicate display names and ip:port.
  const [existingHosts, setExistingHosts] = useState<
    { id: string; name: string; host: string; port: number }[]
  >([]);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await listHosts();
        if (cancelled) return;
        setExistingHosts(
          list.map((h) => ({ id: h.id, name: h.name, host: h.host, port: h.port })),
        );
        if (!(knownGroups && knownGroups.length > 0)) {
          const fromHosts = (list.map((h) => h.group).filter(Boolean) as string[]);
          const folders = loadKnownFolders();
          setAutoGroups(Array.from(new Set([...fromHosts, ...folders])));
        }
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
  // "default" = inherit the global on/off; "on"/"off" force this host.
  const [recordHistory, setRecordHistory] = useState<"default" | "on" | "off">(
    "default",
  );
  const [vpnProfileId, setVpnProfileId] = useState("");
  const [vpnExit, setVpnExit] = useState("auto");
  // Opt-in to account-sync. OFF by default — local/work hosts stay on-device.
  const [sync, setSync] = useState(false);
  const [forwards, setForwards] = useState<PortForward[]>([]);
  // Open forward editor: null = closed, { initial?: PortForward } = open.
  // `initial` undefined → adding new; set → editing that forward.
  const [forwardEdit, setForwardEdit] = useState<
    { initial?: PortForward } | null
  >(null);
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
    setSync(!!initial.sync);
    setForwards(initial.forwards ? initial.forwards.map((f) => ({ ...f })) : []);
    {
      const rh = initial.recordHistory;
      // undefined → inherit; off/false → off; anything else (true / legacy
      // "light"/"full") → on (recording is always light now).
      setRecordHistory(
        rh === undefined ? "default" : rh === false || rh === "off" ? "off" : "on",
      );
    }
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

  // Non-blocking warning: another host (different id) already uses this name.
  const trimmedName = name.trim();
  const dupName =
    trimmedName.length > 0 &&
    existingHosts.some(
      (h) =>
        h.id !== initial?.id &&
        h.name.trim().toLowerCase() === trimmedName.toLowerCase(),
    );

  // Non-blocking warning: another host already has this IP:port. Allowed on
  // purpose — e.g. two logins on the same box — so we only hint, never block.
  const trimmedHost = host.trim();
  const dupHostPort =
    trimmedHost.length > 0 &&
    existingHosts.some(
      (h) =>
        h.id !== initial?.id &&
        h.host.trim().toLowerCase() === trimmedHost.toLowerCase() &&
        h.port === port,
    );

  // --- Port-forward (ssh -L) editing ---------------------------------------
  // Add or update a forward returned by ForwardEditDialog. Match by id to
  // decide whether it's an in-place update or a brand-new entry.
  function upsertForward(f: PortForward) {
    setForwards((fs) =>
      fs.some((x) => x.id === f.id)
        ? fs.map((x) => (x.id === f.id ? f : x))
        : [...fs, f],
    );
    setForwardEdit(null);
  }
  function removeForward(id: string) {
    setForwards((fs) => fs.filter((f) => f.id !== id));
  }
  // Toggle autostart inline from the compact list, without opening the editor.
  function setForwardAutoStart(id: string, autoStart: boolean) {
    setForwards((fs) =>
      fs.map((f) => (f.id === id ? { ...f, autoStart: autoStart || undefined } : f)),
    );
  }

  // Compact one-line summary: "name" if set, else "local → host:port".
  function forwardPrimary(f: PortForward): string {
    if (f.name && f.name.trim()) return f.name.trim();
    const local = f.localPort ? String(f.localPort) : "auto";
    return `${local} → ${f.remoteHost}:${f.remotePort}`;
  }
  function forwardSuffix(f: PortForward): string {
    const p = (f.path ?? "").trim();
    const parts: string[] = [];
    if (f.scheme) parts.push(f.scheme);
    if (p) parts.push("/" + p.replace(/^\/+/, ""));
    return parts.join(" ");
  }

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
        sync: sync || undefined,
        recordHistory:
          recordHistory === "default"
            ? undefined
            : recordHistory === "on",
        order: initial?.order,
        // Skip incomplete rows (no remote port). Persist the rest.
        forwards: (() => {
          const cleaned = forwards
            .filter((f) => f.remotePort > 0)
            .map((f) => ({
              ...f,
              name: f.name?.trim() || undefined,
              remoteHost: f.remoteHost.trim() || "127.0.0.1",
              path: f.path?.trim() || undefined,
            }));
          return cleaned.length > 0 ? cleaned : undefined;
        })(),
      };
      await saveHost(rec);
      // Propagate sync changes right away so the host appears (or disappears) on
      // the user's other devices without a manual "sync now".
      const wasSynced = !!initial?.sync;
      if (wasSynced && !sync) {
        // un-flagged a previously-synced host → explicit tombstone (the only way
        // a deletion propagates), then push.
        await accountRecordTombstones([id]).catch(() => {});
        accountSyncNow().catch(() => {});
      } else if (sync) {
        accountSyncNow().catch(() => {});
      }
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

  // Только два реальных способа входа на хост: пароль и ключ. (Внутренний vault —
  // это лишь хранилище СОХРАНЁННОГО пароля, не отдельный способ; ручной vault-tab убран.)
  const authOptions: { value: AuthKind; label: string; icon: React.ReactNode }[] = [
    { value: "password", label: t("dialog.auth_password"), icon: <Lock size={12} /> },
    { value: "key", label: t("dialog.auth_key"), icon: <KeyRound size={12} /> },
  ];

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
            {dupName && (
              <p className="text-nx-warning text-meta font-mono mt-1.5">
                ⚠ {t("dialog.dup_name_warning", { name: trimmedName })}
              </p>
            )}

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
            {dupHostPort && (
              <p className="text-nx-warning text-meta font-mono mt-1.5">
                ⚠ {t("dialog.dup_hostport_warning", { host: trimmedHost, port })}
              </p>
            )}

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
                <div className="flex gap-2 mt-1.5">
                  <div className="flex-1 min-w-0">
                    <Input
                      value={keyPath}
                      onChange={setKeyPath}
                      placeholder={t("dialog.key_path_ph")}
                    />
                  </div>
                  {HAS_TAURI && (
                    <button
                      type="button"
                      onClick={async () => {
                        try {
                          const p = await openFileDialog({ multiple: false, title: t("dialog.key_pick_title") });
                          if (typeof p === "string") setKeyPath(p);
                        } catch { /* cancelled */ }
                      }}
                      className="nx-focus shrink-0 px-3 bg-nx-panel border border-nx-border rounded-nx text-nx-muted hover:text-nx-text hover:bg-nx-elevated inline-flex items-center gap-1.5 font-mono text-meta"
                    >
                      <FolderOpen size={13} /> {t("dialog.key_browse")}
                    </button>
                  )}
                </div>
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
                    <Select
                      value={vpnProfileId}
                      onChange={(v) => {
                        setVpnProfileId(v);
                        setVpnExit("auto");
                      }}
                      placeholder={t("dialog.vpn_pick_profile")}
                      options={vpnProfiles.map((p) => ({ value: p.id, label: p.name }))}
                      className="mt-1.5"
                    />
                  </div>
                  {vpnProfileId && (
                    <div>
                      <RowLabel>{t("dialog.vpn_exit")}</RowLabel>
                      <Select
                        value={vpnExit}
                        onChange={(v) => setVpnExit(v)}
                        options={[
                          { value: "auto", label: t("dialog.vpn_auto") },
                          ...(vpnProfiles.find((p) => p.id === vpnProfileId)?.nodes ?? []).map(
                            (n) => ({ value: n.tag, label: n.tag }),
                          ),
                        ]}
                        className="mt-1.5"
                      />
                    </div>
                  )}
                </div>
              ))}
              </>
            )}

            {/* Per-host session-history override (inherits the global setting
             *  by default). */}
            <div className={kicker + " mt-6 mb-3 block"}>
              // {t("dialog.col_history")}
            </div>
            <RowLabel>{t("dialog.record_history")}</RowLabel>
            <Select
              className="mt-1.5"
              value={recordHistory}
              onChange={(v) =>
                setRecordHistory(v as "default" | "on" | "off")
              }
              options={[
                { value: "default", label: t("dialog.record_default") },
                { value: "on", label: t("dialog.record_on") },
                { value: "off", label: t("dialog.record_off") },
              ]}
            />

            {/* Account-sync opt-in. OFF by default; flagged hosts (passwords
             *  included, E2E) ride the account sync to other devices. */}
            <div className={kicker + " mt-6 mb-3 block"}>
              // {t("dialog.col_sync")}
            </div>
            <Checkbox
              checked={sync}
              onChange={setSync}
              label={t("dialog.sync_host")}
              hint={t("dialog.sync_host_hint")}
            />

            {/* Local port forwards (ssh -L). Rows with autoStart open on connect. */}
            <div className={kicker + " mt-6 mb-3 block"}>
              // {t("dialog.col_forwards")}
            </div>
            {forwards.length === 0 ? (
              <p className="text-meta text-nx-muted font-mono">
                {t("dialog.forwards_empty")}
              </p>
            ) : (
              <div className="space-y-1.5">
                {forwards.map((f) => {
                  const suffix = forwardSuffix(f);
                  return (
                    <div
                      key={f.id}
                      className="flex items-center gap-2 bg-nx-panel border border-nx-border rounded-nx px-2.5 py-1.5"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="font-mono text-body text-nx-text truncate">
                          {forwardPrimary(f)}
                        </div>
                        {suffix && (
                          <div className="font-mono text-micro text-nx-muted truncate">
                            {suffix}
                          </div>
                        )}
                      </div>
                      <label
                        className="shrink-0 flex items-center gap-1.5 cursor-pointer"
                        title={t("dialog.forward_autostart")}
                      >
                        <Checkbox
                          checked={!!f.autoStart}
                          onChange={(v) => setForwardAutoStart(f.id, v)}
                        />
                        <span className="text-micro uppercase tracking-[0.1em] text-nx-muted">
                          {t("dialog.forward_autostart")}
                        </span>
                      </label>
                      <button
                        type="button"
                        onClick={() => setForwardEdit({ initial: f })}
                        title={t("dialog.forward_edit")}
                        className="nx-focus shrink-0 p-1 text-nx-muted hover:text-nx-text rounded-nx-sm"
                      >
                        <Pencil size={13} />
                      </button>
                      <button
                        type="button"
                        onClick={() => removeForward(f.id)}
                        title={t("dialog.forward_remove")}
                        className="nx-focus shrink-0 p-1 text-nx-muted hover:text-nx-error rounded-nx-sm"
                      >
                        <X size={13} />
                      </button>
                    </div>
                  );
                })}
              </div>
            )}
            <Button
              type="button"
              variant="secondary"
              size="sm"
              leadingIcon={<Plus size={13} />}
              onClick={() => setForwardEdit({})}
              className="mt-2.5"
            >
              {t("dialog.add_forward")}
            </Button>
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

      {forwardEdit && (
        <ForwardEditDialog
          initial={forwardEdit.initial}
          onClose={() => setForwardEdit(null)}
          onSave={upsertForward}
        />
      )}
    </div>
  );
}

