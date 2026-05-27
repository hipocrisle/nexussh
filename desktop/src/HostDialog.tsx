// Add/edit host modal.

import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { HostRecord, saveHost, newHostId } from "./hosts";
import { vaultKeys } from "./vault";
import { useSettings } from "./settings/settings-store";
import { useBackdropClose } from "./useBackdropClose";

type AuthKind = "password" | "key" | "vault";

const advancedEnabled = () =>
  localStorage.getItem("nexussh.advanced") === "1";

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
  const [alwaysAskPassword, setAlwaysAskPassword] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const { backdropProps, contentProps } = useBackdropClose(onClose);

  useEffect(() => {
    if (!initial) return;
    setName(initial.name);
    setHost(initial.host);
    setPort(initial.port || settings.defaultPort);
    setUser(initial.user || settings.defaultUser);
    setGroup(initial.group ?? "");
    setNote(initial.note ?? "");
    setAlwaysAskPassword(!!initial.alwaysAskPassword);
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
        // vault locked or not configured — show hint
        setVaultAvailable(false);
        setVaultKeyOptions([]);
      });
  }, [authKind]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
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
      };
      await saveHost(rec);
      onSaved(rec);
    } catch (e) {
      setError(String(e));
    }
  }

  const inputBase =
    "w-full bg-[var(--nx-bg-panel)] border border-[var(--nx-border)] rounded px-3 py-2 text-[var(--nx-text-primary)] " +
    "focus:outline-none focus:border-[var(--nx-accent)] placeholder-[var(--nx-text-muted)] font-mono text-sm";
  const labelBase = "text-xs uppercase tracking-wider text-[var(--nx-text-soft)] mb-1 block";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      {...backdropProps}
    >
      <form
        onSubmit={submit}
        {...contentProps}
        className="w-full max-w-md bg-[var(--nx-bg-base)] border border-[var(--nx-border)] rounded-lg shadow-2xl p-6 max-h-[90vh] overflow-y-auto"
      >
        <h2 className="text-xl font-mono text-[var(--nx-accent)] mb-5">
          &gt; {initial ? t("dialog.edit_host") : t("dialog.new_host")}
        </h2>

        <div className="space-y-3">
          <div>
            <label className={labelBase}>{t("dialog.display_name")}</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("dialog.display_name_ph")}
              className={inputBase}
            />
          </div>
          <div className="flex gap-2">
            <div className="flex-1">
              <label className={labelBase}>{t("dialog.host")}</label>
              <input
                value={host}
                onChange={(e) => setHost(e.target.value)}
                placeholder={t("dialog.host_ph")}
                required
                className={inputBase}
              />
            </div>
            <div className="w-20">
              <label className={labelBase}>{t("dialog.port")}</label>
              <input
                type="number"
                value={port}
                onChange={(e) => setPort(parseInt(e.target.value) || settings.defaultPort)}
                className={inputBase}
              />
            </div>
          </div>
          <div>
            <label className={labelBase}>{t("dialog.user")}</label>
            <input
              value={user}
              onChange={(e) => setUser(e.target.value)}
              placeholder={t("dialog.user_ph")}
              required
              className={inputBase}
            />
          </div>
          <div>
            <label className={labelBase}>{t("dialog.group")}</label>
            <input
              value={group}
              onChange={(e) => setGroup(e.target.value)}
              placeholder={t("dialog.group_ph")}
              list="nexussh-known-groups"
              className={inputBase}
            />
            <datalist id="nexussh-known-groups">
              {knownGroups.map((g) => (
                <option key={g} value={g} />
              ))}
            </datalist>
          </div>

          <div className="flex gap-2 pt-2">
            {(
              advancedEnabled()
                ? (["password", "key", "vault"] as const)
                : (["password", "key"] as const)
            ).map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => setAuthKind(k)}
                className={
                  "px-3 py-1 rounded text-sm font-mono " +
                  (authKind === k
                    ? "bg-[var(--nx-accent)] text-[var(--nx-bg-base)]"
                    : "bg-[var(--nx-bg-panel)] text-[var(--nx-text-soft)] border border-[var(--nx-border)]")
                }
              >
                {t(`dialog.auth_${k}`)}
              </button>
            ))}
          </div>

          {authKind === "password" && (
            <>
              <div>
                <label className={labelBase}>{t("dialog.password")}</label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  disabled={alwaysAskPassword}
                  placeholder={
                    alwaysAskPassword
                      ? t("dialog.password_ask_each_time_ph")
                      : undefined
                  }
                  className={
                    inputBase + (alwaysAskPassword ? " opacity-50" : "")
                  }
                />
              </div>
              <label className="flex items-start gap-2 text-xs font-mono text-[var(--nx-text-primary)] cursor-pointer">
                <input
                  type="checkbox"
                  checked={alwaysAskPassword}
                  onChange={(e) => setAlwaysAskPassword(e.target.checked)}
                  className="mt-0.5 accent-[var(--nx-accent)]"
                />
                <div>
                  <div>{t("dialog.always_ask_password")}</div>
                  <div className="text-[10px] text-[var(--nx-text-muted)]">
                    {t("dialog.always_ask_password_hint")}
                  </div>
                </div>
              </label>
            </>
          )}
          {authKind === "key" && (
            <>
              <div>
                <label className={labelBase}>{t("dialog.key_path")}</label>
                <input
                  value={keyPath}
                  onChange={(e) => setKeyPath(e.target.value)}
                  placeholder={t("dialog.key_path_ph")}
                  className={inputBase}
                />
              </div>
              <div>
                <label className={labelBase}>{t("dialog.passphrase")}</label>
                <input
                  type="password"
                  value={keyPass}
                  onChange={(e) => setKeyPass(e.target.value)}
                  className={inputBase}
                />
              </div>
            </>
          )}
          {authKind === "vault" && (
            <div>
              <label className={labelBase}>{t("dialog.vault_key")}</label>
              <input
                value={vaultKey}
                onChange={(e) => setVaultKey(e.target.value)}
                placeholder={t("dialog.vault_key_ph")}
                list="vault-keys"
                className={inputBase}
              />
              <datalist id="vault-keys">
                {vaultKeyOptions.map((k) => (
                  <option key={k} value={k} />
                ))}
              </datalist>
              {vaultAvailable === false && (
                <div className="text-[var(--nx-warning)] text-xs font-mono mt-1">
                  ⚠ {t("dialog.vault_unavailable")}
                </div>
              )}
            </div>
          )}

          <div>
            <label className={labelBase}>{t("dialog.note")}</label>
            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={2}
              placeholder="..."
              className={inputBase + " resize-none"}
            />
          </div>

          {error && (
            <div className="text-[var(--nx-error)] text-sm font-mono">✗ {error}</div>
          )}

          <div className="flex gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 py-2 bg-[var(--nx-bg-panel)] hover:bg-[var(--nx-border)] text-[var(--nx-text-soft)] font-mono rounded border border-[var(--nx-border)]"
            >
              {t("dialog.cancel")}
            </button>
            <button
              type="submit"
              className="flex-1 py-2 bg-[var(--nx-accent)] hover:bg-[var(--nx-accent)] text-[var(--nx-bg-base)] font-mono font-bold rounded"
            >
              {t("dialog.save")}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}
