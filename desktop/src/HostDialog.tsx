// Add/edit host modal.

import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { HostRecord, saveHost, newHostId } from "./hosts";
import { vaultKeys } from "./vault";

type AuthKind = "password" | "key" | "vault";

const advancedEnabled = () =>
  localStorage.getItem("nexussh.advanced") === "1";

interface Props {
  initial?: HostRecord;
  onClose: () => void;
  onSaved: (h: HostRecord) => void;
}

export function HostDialog({ initial, onClose, onSaved }: Props) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [host, setHost] = useState("");
  const [port, setPort] = useState(22);
  const [user, setUser] = useState("");
  const [group, setGroup] = useState("");
  const [note, setNote] = useState("");
  const [authKind, setAuthKind] = useState<AuthKind>("password");
  const [password, setPassword] = useState("");
  const [keyPath, setKeyPath] = useState("");
  const [keyPass, setKeyPass] = useState("");
  const [vaultKey, setVaultKey] = useState("");
  const [vaultAvailable, setVaultAvailable] = useState<boolean | null>(null);
  const [vaultKeyOptions, setVaultKeyOptions] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!initial) return;
    setName(initial.name);
    setHost(initial.host);
    setPort(initial.port);
    setUser(initial.user);
    setGroup(initial.group ?? "");
    setNote(initial.note ?? "");
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
      };
      await saveHost(rec);
      onSaved(rec);
    } catch (e) {
      setError(String(e));
    }
  }

  const inputBase =
    "w-full bg-[#0e1414] border border-[#1f3a3a] rounded px-3 py-2 text-[#c9d1d9] " +
    "focus:outline-none focus:border-[#00ff95] placeholder-[#4a5560] font-mono text-sm";
  const labelBase = "text-xs uppercase tracking-wider text-[#7fd7ff] mb-1 block";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <form
        onSubmit={submit}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md bg-[#0a0e0e] border border-[#1f3a3a] rounded-lg shadow-2xl p-6 max-h-[90vh] overflow-y-auto"
      >
        <h2 className="text-xl font-mono text-[#00ff95] mb-5">
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
                onChange={(e) => setPort(parseInt(e.target.value) || 22)}
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
              className={inputBase}
            />
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
                    ? "bg-[#00ff95] text-[#0a0e0e]"
                    : "bg-[#0e1414] text-[#7fd7ff] border border-[#1f3a3a]")
                }
              >
                {t(`dialog.auth_${k}`)}
              </button>
            ))}
          </div>

          {authKind === "password" && (
            <div>
              <label className={labelBase}>{t("dialog.password")}</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className={inputBase}
              />
            </div>
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
                <div className="text-[#f5d76e] text-xs font-mono mt-1">
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
            <div className="text-[#ff6b6b] text-sm font-mono">✗ {error}</div>
          )}

          <div className="flex gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="flex-1 py-2 bg-[#0e1414] hover:bg-[#1f3a3a] text-[#7fd7ff] font-mono rounded border border-[#1f3a3a]"
            >
              {t("dialog.cancel")}
            </button>
            <button
              type="submit"
              className="flex-1 py-2 bg-[#00ff95] hover:bg-[#5fffb4] text-[#0a0e0e] font-mono font-bold rounded"
            >
              {t("dialog.save")}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}
