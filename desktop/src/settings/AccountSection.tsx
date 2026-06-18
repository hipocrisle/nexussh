// AccountSection — account-based E2E sync (frontend).
//
// The SYNC password is its OWN credential, separate from this device's vault
// master password, and the SAME on every device. Each device keeps its own local
// vault password. Login requires the vault unlocked (the derived key is stashed
// inside it so the session survives restarts). The server only ever sees
// ciphertext. See ../account.ts for the typed bridge.
//
// States: logged-out (register / log in) and logged-in (status, sync now, 2FA,
// log out). Every error is surfaced; in-flight buttons are disabled; password
// fields are cleared from state after use.

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { QRCodeSVG } from "qrcode.react";
import {
  Loader2,
  RefreshCw,
  LogOut,
  Copy,
  Check,
  CheckCircle2,
  ShieldCheck,
  ShieldPlus,
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  ListChecks,
  Info,
  KeyRound,
  Trash2,
} from "lucide-react";
import { ThemePalette } from "./themes";
import { Section, Row, TextField } from "./primitives";
import { SyncHostsDialog } from "./SyncHostsDialog";
import { writeClipboard } from "../clipboard";
import { listHosts } from "../hosts";
import {
  accountStatus,
  accountSetServer,
  accountRegister,
  accountLogin,
  accountLogout,
  accountChangePassword,
  accountRecover,
  accountDelete,
  accountTotpEnroll,
  accountTotpVerify,
  accountSyncNow,
  TOTP_REQUIRED_ERROR,
  type AccountStatus,
  type SyncReport,
  type TotpEnroll,
} from "../account";

interface Props {
  t: ThemePalette;
}

const DEFAULT_SERVER = "https://sync.hipogas.org";

type Mode = "register" | "login";

// A vault-not-unlocked failure can surface a few different ways from Rust; we
// match loosely so the user gets the clear "unlock your vault first" message.
function isVaultLockedError(e: unknown): boolean {
  const s = String(e).toLowerCase();
  return (
    s.includes("vault") &&
    (s.includes("lock") || s.includes("unlock") || s.includes("not unlocked"))
  );
}

export function AccountSection({ t }: Props) {
  const { t: tr } = useTranslation();

  const [status, setStatus] = useState<AccountStatus | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    refresh().finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function refresh() {
    try {
      setStatus(await accountStatus());
    } catch {
      // If status itself fails, treat as not-configured but keep the section
      // usable; individual actions will surface their own errors.
      setStatus(null);
    }
  }

  return (
    <Section
      id="account"
      kicker={tr("settings.account.kicker")}
      label={tr("settings.account.section")}
      t={t}
    >
      <p
        className="font-mono text-xs mb-5 max-w-xl leading-relaxed"
        style={{ color: t.textMuted }}
      >
        {tr("settings.account.intro")}
      </p>

      {loading ? (
        <div
          className="font-mono text-xs flex items-center gap-2"
          style={{ color: t.textMuted }}
        >
          <Loader2 size={12} className="animate-spin" />{" "}
          {tr("settings.account.loading")}
        </div>
      ) : status?.logged_in ? (
        <LoggedIn t={t} status={status} onChanged={refresh} />
      ) : (
        <LoggedOut t={t} status={status} onChanged={refresh} />
      )}
    </Section>
  );
}

// ============================================================
// Small shared bits
// ============================================================

function ErrorLine({ t, msg }: { t: ThemePalette; msg: string }) {
  return (
    <div
      className="font-mono text-[11px] break-all flex items-start gap-1.5"
      style={{ color: t.error }}
    >
      <AlertTriangle size={12} className="mt-0.5 shrink-0" /> <span>{msg}</span>
    </div>
  );
}

function PrimaryButton({
  t,
  onClick,
  busy,
  disabled,
  children,
  icon,
}: {
  t: ThemePalette;
  onClick: () => void;
  busy?: boolean;
  disabled?: boolean;
  children: React.ReactNode;
  icon?: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy || disabled}
      className="font-mono text-sm px-4 py-2 rounded inline-flex items-center gap-2 transition-colors disabled:opacity-50"
      style={{
        background: t.accent,
        color: t.bgBase,
        border: `1px solid ${t.accent}`,
        fontWeight: 700,
      }}
    >
      {busy ? <Loader2 size={14} className="animate-spin" /> : icon}
      {children}
    </button>
  );
}

function GhostButton({
  t,
  onClick,
  busy,
  disabled,
  children,
  icon,
}: {
  t: ThemePalette;
  onClick: () => void;
  busy?: boolean;
  disabled?: boolean;
  children: React.ReactNode;
  icon?: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy || disabled}
      className="font-mono text-xs px-3 py-2 rounded inline-flex items-center gap-1.5 transition-colors disabled:opacity-40"
      style={{ background: t.bgPanel, border: `1px solid ${t.border}`, color: t.textSoft }}
    >
      {busy ? <Loader2 size={12} className="animate-spin" /> : icon}
      {children}
    </button>
  );
}

function CopyField({
  t,
  label,
  value,
  mono = true,
}: {
  t: ThemePalette;
  label: string;
  value: string;
  mono?: boolean;
}) {
  const { t: tr } = useTranslation();
  const [copied, setCopied] = useState(false);
  async function copy() {
    await writeClipboard(value);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }
  return (
    <div>
      <div
        className="text-[10px] uppercase tracking-wider mb-1 font-mono"
        style={{ color: t.textMuted }}
      >
        {label}
      </div>
      <div className="flex items-stretch gap-2">
        <div
          className={
            "flex-1 min-w-0 px-3 py-2 rounded border break-all text-xs " +
            (mono ? "font-mono" : "")
          }
          style={{ background: t.bgPanel, borderColor: t.border, color: t.textPrimary }}
        >
          {value}
        </div>
        <button
          type="button"
          onClick={copy}
          title={tr("settings.account.copy")}
          className="shrink-0 px-2.5 rounded border inline-flex items-center justify-center"
          style={{ background: t.bgPanel, borderColor: t.border, color: copied ? t.accent : t.textSoft }}
        >
          {copied ? <Check size={14} /> : <Copy size={14} />}
        </button>
      </div>
    </div>
  );
}

// ============================================================
// One-time secret panel (recovery key / recovery codes)
// ============================================================

function OneTimeSecretPanel({
  t,
  title,
  warning,
  body,
  codes,
  confirmLabel,
  onConfirm,
}: {
  t: ThemePalette;
  title: string;
  warning: string;
  body?: string;
  codes?: string[];
  confirmLabel: string;
  onConfirm: () => void;
}) {
  const { t: tr } = useTranslation();
  const [copied, setCopied] = useState(false);
  const allText = codes ? codes.join("\n") : body ?? "";
  async function copyAll() {
    await writeClipboard(allText);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }
  return (
    <div
      className="rounded border p-4 space-y-3"
      style={{ background: t.bgPanel, borderColor: t.warning, boxShadow: `0 0 16px ${t.warning}22` }}
    >
      <div
        className="font-mono text-sm flex items-center gap-2"
        style={{ color: t.warning }}
      >
        <AlertTriangle size={15} /> {title}
      </div>
      <div className="font-mono text-[11px] leading-relaxed" style={{ color: t.textSoft }}>
        {warning}
      </div>

      {body && (
        <div
          className="px-3 py-3 rounded border font-mono text-sm break-all select-all"
          style={{ background: t.bgBase, borderColor: t.border, color: t.textPrimary }}
        >
          {body}
        </div>
      )}

      {codes && (
        <div
          className="px-3 py-3 rounded border font-mono text-sm grid grid-cols-2 gap-x-6 gap-y-1 select-all"
          style={{ background: t.bgBase, borderColor: t.border, color: t.textPrimary }}
        >
          {codes.map((c, i) => (
            <div key={i} className="break-all">
              {c}
            </div>
          ))}
        </div>
      )}

      <div className="flex items-center gap-2 flex-wrap">
        <GhostButton
          t={t}
          onClick={copyAll}
          icon={copied ? <Check size={12} /> : <Copy size={12} />}
        >
          {copied ? tr("settings.account.copied") : tr("settings.account.copy_all")}
        </GhostButton>
        <PrimaryButton t={t} onClick={onConfirm} icon={<Check size={14} />}>
          {confirmLabel}
        </PrimaryButton>
      </div>
    </div>
  );
}

// ============================================================
// Server URL (collapsible advanced)
// ============================================================

function ServerField({
  t,
  status,
  onChanged,
}: {
  t: ThemePalette;
  status: AccountStatus | null;
  onChanged: () => void;
}) {
  const { t: tr } = useTranslation();
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState(status?.server_url || DEFAULT_SERVER);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await accountSetServer(url.trim() || DEFAULT_SERVER);
      setSaved(true);
      window.setTimeout(() => setSaved(false), 1500);
      onChanged();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="max-w-md">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="font-mono text-[11px] uppercase tracking-wider inline-flex items-center gap-1.5"
        style={{ color: t.textMuted }}
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        {tr("settings.account.server_advanced")}
        <span style={{ color: t.textSoft }}>
          ({status?.server_url || DEFAULT_SERVER})
        </span>
      </button>
      {open && (
        <div className="mt-2 space-y-2">
          <TextField value={url} onChange={setUrl} placeholder={DEFAULT_SERVER} t={t} />
          <div className="flex items-center gap-2">
            <GhostButton t={t} onClick={save} busy={busy} icon={<Check size={12} />}>
              {tr("settings.account.server_save")}
            </GhostButton>
            {saved && (
              <span className="font-mono text-[11px]" style={{ color: t.accent }}>
                {tr("settings.account.server_saved")}
              </span>
            )}
          </div>
          {error && <ErrorLine t={t} msg={error} />}
        </div>
      )}
    </div>
  );
}

// ============================================================
// Logged-out: register + login
// ============================================================

function LoggedOut({
  t,
  status,
  onChanged,
}: {
  t: ThemePalette;
  status: AccountStatus | null;
  onChanged: () => void;
}) {
  const { t: tr } = useTranslation();
  const [mode, setMode] = useState<Mode>("login");

  return (
    <div className="space-y-6">
      <Row label={tr("settings.account.server")} hint={tr("settings.account.server_hint")} t={t}>
        <ServerField t={t} status={status} onChanged={onChanged} />
      </Row>

      <Row label={tr("settings.account.access")} hint={tr("settings.account.access_hint")} t={t}>
        <div className="space-y-4 max-w-md">
          <div
            className="inline-flex rounded border overflow-hidden font-mono text-xs"
            style={{ borderColor: t.border }}
          >
            {(["login", "register"] as const).map((m, i, arr) => (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                className="px-4 py-2 uppercase tracking-wider transition-colors"
                style={{
                  background: mode === m ? t.bgElevated : t.bgPanel,
                  color: mode === m ? t.accent : t.textMuted,
                  borderRight: i < arr.length - 1 ? `1px solid ${t.border}` : "none",
                }}
              >
                {tr(`settings.account.${m}`)}
              </button>
            ))}
          </div>

          {mode === "login" ? (
            <LoginForm t={t} onChanged={onChanged} />
          ) : (
            <RegisterForm t={t} onChanged={onChanged} />
          )}
        </div>
      </Row>
    </div>
  );
}

function LabeledInput({
  t,
  label,
  value,
  onChange,
  type = "text",
  placeholder,
  autoFocus,
}: {
  t: ThemePalette;
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  placeholder?: string;
  autoFocus?: boolean;
}) {
  return (
    <div>
      <div
        className="text-[10px] uppercase tracking-wider mb-1 font-mono"
        style={{ color: t.textMuted }}
      >
        {label}
      </div>
      <input
        value={value}
        type={type}
        autoFocus={autoFocus}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full px-3 py-2 rounded outline-none border text-sm font-mono"
        style={{ background: t.bgPanel, borderColor: t.border, color: t.textPrimary }}
        onFocus={(e) => (e.target.style.borderColor = t.accent)}
        onBlur={(e) => (e.target.style.borderColor = t.border)}
      />
    </div>
  );
}

function LoginForm({ t, onChanged }: { t: ThemePalette; onChanged: () => void }) {
  const { t: tr } = useTranslation();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [totp, setTotp] = useState("");
  const [needTotp, setNeedTotp] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recovering, setRecovering] = useState(false);

  if (recovering) {
    return <RecoverForm t={t} initialUsername={username} onChanged={onChanged} onCancel={() => setRecovering(false)} />;
  }

  async function submit() {
    if (!username.trim() || !password) return;
    setBusy(true);
    setError(null);
    try {
      await accountLogin(password, username.trim(), needTotp ? totp.trim() : undefined);
      // Success — clear secrets from memory and refresh.
      setPassword("");
      setTotp("");
      // First-login pull: immediately fetch everything already synced on other
      // devices so the user's hosts appear right away (no manual "sync now").
      accountSyncNow().catch(() => {});
      onChanged();
    } catch (e) {
      if (String(e).includes(TOTP_REQUIRED_ERROR) && !needTotp) {
        setNeedTotp(true);
        setError(null);
      } else if (isVaultLockedError(e)) {
        setError(tr("settings.account.vault_locked"));
      } else {
        setError(String(e));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      className="space-y-3"
    >
      <LabeledInput
        t={t}
        label={tr("settings.account.username")}
        value={username}
        onChange={setUsername}
        placeholder={tr("settings.account.username_ph")}
        autoFocus
      />
      <LabeledInput
        t={t}
        label={tr("settings.account.password")}
        value={password}
        onChange={setPassword}
        type="password"
        placeholder={tr("settings.account.password_ph")}
      />
      {needTotp && (
        <LabeledInput
          t={t}
          label={tr("settings.account.totp_code")}
          value={totp}
          onChange={setTotp}
          placeholder="000000"
          autoFocus
        />
      )}
      <PrimaryButton t={t} onClick={submit} busy={busy} disabled={!username.trim() || !password}>
        {tr("settings.account.login")}
      </PrimaryButton>
      {error && <ErrorLine t={t} msg={error} />}
      <button
        type="button"
        onClick={() => setRecovering(true)}
        className="text-[11px] font-mono underline-offset-2 hover:underline"
        style={{ color: t.textMuted }}
      >
        {tr("settings.account.forgot_password")}
      </button>
    </form>
  );
}

// Recover access with the emergency-kit recovery key, setting a new password.
function RecoverForm({
  t,
  initialUsername,
  onChanged,
  onCancel,
}: {
  t: ThemePalette;
  initialUsername: string;
  onChanged: () => void;
  onCancel: () => void;
}) {
  const { t: tr } = useTranslation();
  const [username, setUsername] = useState(initialUsername);
  const [key, setKey] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setError(null);
    if (next !== confirm) {
      setError(tr("settings.account.pw_mismatch"));
      return;
    }
    setBusy(true);
    try {
      await accountRecover(username.trim(), key.trim(), next);
      accountSyncNow().catch(() => {});
      onChanged();
    } catch (e) {
      setError(isVaultLockedError(e) ? tr("settings.account.vault_locked") : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="font-mono text-xs" style={{ color: t.textMuted }}>
        {tr("settings.account.recover_hint")}
      </div>
      <LabeledInput t={t} label={tr("settings.account.username")} value={username} onChange={setUsername} />
      <LabeledInput t={t} label={tr("settings.account.recovery_key")} value={key} onChange={setKey} placeholder="xxxx-xxxx-…" />
      <LabeledInput t={t} type="password" label={tr("settings.account.new_password")} value={next} onChange={setNext} />
      <LabeledInput t={t} type="password" label={tr("settings.account.confirm_password")} value={confirm} onChange={setConfirm} />
      {error && <ErrorLine t={t} msg={error} />}
      <div className="flex gap-2">
        <PrimaryButton t={t} onClick={submit} busy={busy} disabled={!username.trim() || !key.trim() || !next}>
          {tr("settings.account.recover_btn")}
        </PrimaryButton>
        <GhostButton t={t} onClick={onCancel}>{tr("settings.account.cancel")}</GhostButton>
      </div>
    </div>
  );
}

// Unmistakable post-register success state. Shows "Account created" + the
// recovery key (emergency kit) prominently with a strong save-it-once warning.
// "I've saved it" logs the user straight into the logged-in view.
function RegisterSuccess({
  t,
  recoveryKey,
  username,
  password,
  onDone,
}: {
  t: ThemePalette;
  recoveryKey: string;
  username: string;
  password: string;
  onDone: () => void;
}) {
  const { t: tr } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function acknowledge() {
    setBusy(true);
    setError(null);
    try {
      // Land the user logged-in. accountRegister already derived the keys, but
      // an explicit login guarantees the logged-in status regardless of backend
      // semantics. If it fails, still proceed — refresh will show actual state.
      try {
        await accountLogin(password, username);
      } catch {
        /* already-logged-in / no-op backends are fine; refresh reflects truth */
      }
      onDone();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      <div
        className="rounded border p-4 flex items-center gap-3"
        style={{
          background: t.bgPanel,
          borderColor: t.accent,
          boxShadow: `0 0 16px ${t.accent}22`,
        }}
      >
        <CheckCircle2 size={22} style={{ color: t.accent }} className="shrink-0" />
        <div>
          <div className="font-mono text-sm" style={{ color: t.accent }}>
            {tr("settings.account.register_success_title")}
          </div>
          <div className="font-mono text-[11px] mt-0.5" style={{ color: t.textSoft }}>
            {tr("settings.account.register_success_sub", { username })}
          </div>
        </div>
      </div>

      <OneTimeSecretPanel
        t={t}
        title={tr("settings.account.recovery_title")}
        warning={tr("settings.account.recovery_warning")}
        body={recoveryKey}
        confirmLabel={busy ? tr("settings.account.finishing") : tr("settings.account.recovery_confirm")}
        onConfirm={acknowledge}
      />
      {error && <ErrorLine t={t} msg={error} />}
    </div>
  );
}

function RegisterForm({ t, onChanged }: { t: ThemePalette; onChanged: () => void }) {
  const { t: tr } = useTranslation();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recoveryKey, setRecoveryKey] = useState<string | null>(null);

  const mismatch = confirm.length > 0 && password !== confirm;
  const canSubmit = username.trim().length > 0 && password.length > 0 && password === confirm;

  async function submit() {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      const res = await accountRegister(password, username.trim());
      // Registration already derived the keys — the user is effectively logged
      // in. Show the recovery key first; we keep the password in state ONLY to
      // land the user in the logged-in view on acknowledge, then clear it.
      setRecoveryKey(res.recovery_key);
    } catch (e) {
      // Do NOT blank the form on failure — keep what they typed so they can fix
      // it. Clear only the recovery state.
      if (isVaultLockedError(e)) {
        setError(tr("settings.account.vault_locked"));
      } else {
        setError(String(e));
      }
    } finally {
      setBusy(false);
    }
  }

  // After register: an unmistakable success panel with the recovery key shown
  // once. Acknowledging logs the user straight in (so they don't drop back to
  // an empty register form), then scrubs the password from memory.
  if (recoveryKey) {
    return (
      <RegisterSuccess
        t={t}
        recoveryKey={recoveryKey}
        username={username.trim()}
        password={password}
        onDone={() => {
          setPassword("");
          setConfirm("");
          setRecoveryKey(null);
          onChanged();
        }}
      />
    );
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      className="space-y-3"
    >
      <div
        className="rounded border px-3 py-2 font-mono text-[11px] leading-relaxed flex items-start gap-2"
        style={{ background: t.bgPanel, borderColor: t.warning + "66", color: t.textSoft }}
      >
        <AlertTriangle size={13} className="mt-0.5 shrink-0" style={{ color: t.warning }} />
        <span>{tr("settings.account.unified_password_note")}</span>
      </div>
      <LabeledInput
        t={t}
        label={tr("settings.account.username")}
        value={username}
        onChange={setUsername}
        placeholder={tr("settings.account.username_ph")}
        autoFocus
      />
      <LabeledInput
        t={t}
        label={tr("settings.account.master_password")}
        value={password}
        onChange={setPassword}
        type="password"
        placeholder={tr("settings.account.password_ph")}
      />
      <LabeledInput
        t={t}
        label={tr("settings.account.confirm_password")}
        value={confirm}
        onChange={setConfirm}
        type="password"
        placeholder={tr("settings.account.password_ph")}
      />
      {mismatch && (
        <div className="font-mono text-[11px]" style={{ color: t.error }}>
          {tr("settings.account.password_mismatch")}
        </div>
      )}
      <PrimaryButton t={t} onClick={submit} busy={busy} disabled={!canSubmit}>
        {tr("settings.account.register")}
      </PrimaryButton>
      {error && <ErrorLine t={t} msg={error} />}
    </form>
  );
}

// ============================================================
// Logged-in: status, sync, 2FA, logout
// ============================================================

function LoggedIn({
  t,
  status,
  onChanged,
}: {
  t: ThemePalette;
  status: AccountStatus;
  onChanged: () => void;
}) {
  const { t: tr } = useTranslation();
  const [manageOpen, setManageOpen] = useState(false);
  // Count of hosts flagged for sync + total, so the UI can explain "0 marked".
  const [counts, setCounts] = useState<{ marked: number; total: number } | null>(
    null,
  );

  async function refreshCounts() {
    try {
      const hs = await listHosts();
      setCounts({ marked: hs.filter((h) => h.sync).length, total: hs.length });
    } catch {
      setCounts(null);
    }
  }

  useEffect(() => {
    refreshCounts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const lastSync = status.last_sync_at
    ? new Date(status.last_sync_at).toLocaleString()
    : tr("settings.account.never_synced");

  return (
    <div className="space-y-6">
      {manageOpen && (
        <SyncHostsDialog
          onClose={() => setManageOpen(false)}
          onSaved={refreshCounts}
        />
      )}
      <Row label={tr("settings.account.account")} hint={tr("settings.account.account_hint")} t={t}>
        <div
          className="rounded border p-4 font-mono text-xs space-y-2 max-w-md"
          style={{ background: t.bgPanel, borderColor: t.border }}
        >
          <div className="flex justify-between gap-4">
            <span style={{ color: t.textMuted }}>{tr("settings.account.username")}</span>
            <span style={{ color: t.textPrimary }}>{status.username}</span>
          </div>
          <div className="flex justify-between gap-4">
            <span style={{ color: t.textMuted }}>{tr("settings.account.server")}</span>
            <span className="break-all text-right" style={{ color: t.textPrimary }}>
              {status.server_url}
            </span>
          </div>
          <div className="flex justify-between gap-4">
            <span style={{ color: t.textMuted }}>{tr("settings.account.two_factor")}</span>
            <span style={{ color: status.totp_enabled ? t.accent : t.textMuted }}>
              {status.totp_enabled
                ? tr("settings.account.enabled")
                : tr("settings.account.disabled")}
            </span>
          </div>
          <div className="flex justify-between gap-4">
            <span style={{ color: t.textMuted }}>{tr("settings.account.last_sync")}</span>
            <span style={{ color: t.textPrimary }}>{lastSync}</span>
          </div>
        </div>
      </Row>

      <Row
        label={tr("settings.account.synced_hosts")}
        hint={tr("settings.account.synced_hosts_hint")}
        t={t}
      >
        <div className="space-y-2">
          <GhostButton
            t={t}
            onClick={() => setManageOpen(true)}
            icon={<ListChecks size={14} />}
          >
            {tr("settings.account.manage_synced_hosts")}
          </GhostButton>
          {counts && (
            <div className="font-mono text-[11px]" style={{ color: t.textMuted }}>
              {tr("settings.account.sync_count", {
                selected: counts.marked,
                total: counts.total,
              })}
            </div>
          )}
        </div>
      </Row>

      <Row label={tr("settings.account.sync")} hint={tr("settings.account.sync_hint")} t={t}>
        <SyncControl
          t={t}
          onSynced={() => {
            onChanged();
            refreshCounts();
          }}
          markedCount={counts?.marked ?? null}
        />
      </Row>

      <Row label={tr("settings.account.two_factor")} hint={tr("settings.account.two_factor_hint")} t={t}>
        <TwoFactorControl t={t} enabled={status.totp_enabled} onChanged={onChanged} />
      </Row>

      <Row label={tr("settings.account.password")} hint={tr("settings.account.password_hint")} t={t}>
        <ChangePasswordControl t={t} totpEnabled={status.totp_enabled} />
      </Row>

      <Row label={tr("settings.account.session")} hint={tr("settings.account.logout_hint")} t={t}>
        <LogoutControl t={t} onChanged={onChanged} />
      </Row>

      <Row label={tr("settings.account.danger")} hint={tr("settings.account.danger_hint")} t={t}>
        <DeleteAccountControl t={t} onChanged={onChanged} />
      </Row>
    </div>
  );
}

// Change the sync password (logged in, knows the current one).
function ChangePasswordControl({ t, totpEnabled }: { t: ThemePalette; totpEnabled: boolean }) {
  const { t: tr } = useTranslation();
  const [open, setOpen] = useState(false);
  const [cur, setCur] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [totp, setTotp] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function submit() {
    setError(null);
    if (next !== confirm) {
      setError(tr("settings.account.pw_mismatch"));
      return;
    }
    setBusy(true);
    try {
      await accountChangePassword(cur, next, totpEnabled ? totp.trim() : undefined);
      setDone(true);
      setOpen(false);
      setCur(""); setNext(""); setConfirm(""); setTotp("");
    } catch (e) {
      setError(isVaultLockedError(e) ? tr("settings.account.vault_locked") : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <div className="space-y-2">
        <GhostButton t={t} onClick={() => { setOpen(true); setDone(false); }} icon={<KeyRound size={14} />}>
          {tr("settings.account.change_password")}
        </GhostButton>
        {done && (
          <div className="font-mono text-[11px]" style={{ color: t.accent }}>
            {tr("settings.account.pw_changed")}
          </div>
        )}
      </div>
    );
  }
  return (
    <div className="space-y-2 max-w-md">
      <LabeledInput t={t} type="password" label={tr("settings.account.current_password")} value={cur} onChange={setCur} />
      <LabeledInput t={t} type="password" label={tr("settings.account.new_password")} value={next} onChange={setNext} />
      <LabeledInput t={t} type="password" label={tr("settings.account.confirm_password")} value={confirm} onChange={setConfirm} />
      {totpEnabled && (
        <LabeledInput t={t} label={tr("settings.account.totp_code")} value={totp} onChange={setTotp} />
      )}
      {error && <ErrorLine t={t} msg={error} />}
      <div className="flex gap-2">
        <PrimaryButton t={t} onClick={submit} busy={busy} disabled={!cur || !next}>
          {tr("settings.account.save")}
        </PrimaryButton>
        <GhostButton t={t} onClick={() => setOpen(false)}>{tr("settings.account.cancel")}</GhostButton>
      </div>
    </div>
  );
}

// Delete the whole account from the server (irreversible). Local hosts kept.
function DeleteAccountControl({ t, onChanged }: { t: ThemePalette; onChanged: () => void }) {
  const { t: tr } = useTranslation();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function del() {
    setBusy(true);
    setError(null);
    try {
      await accountDelete();
      onChanged();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  if (!confirming) {
    return (
      <GhostButton t={t} onClick={() => setConfirming(true)} icon={<Trash2 size={14} />}>
        {tr("settings.account.delete_account")}
      </GhostButton>
    );
  }
  return (
    <div className="space-y-2 max-w-md">
      <div
        className="rounded border p-3 font-mono text-[11px] leading-relaxed"
        style={{ background: t.bgPanel, borderColor: "#b91c1c", color: t.textPrimary }}
      >
        {tr("settings.account.delete_warn")}
      </div>
      {error && <ErrorLine t={t} msg={error} />}
      <div className="flex gap-2">
        <GhostButton t={t} onClick={del} busy={busy} icon={<Trash2 size={14} />}>
          {tr("settings.account.delete_confirm")}
        </GhostButton>
        <GhostButton t={t} onClick={() => setConfirming(false)}>{tr("settings.account.cancel")}</GhostButton>
      </div>
    </div>
  );
}

// Human summary of a sync run, e.g. "Pushed 3, pulled 1." or "Nothing to do."
function syncSummary(
  r: SyncReport,
  tr: (k: string, o?: Record<string, unknown>) => string,
): string {
  const parts: string[] = [];
  if (r.pushed > 0) parts.push(tr("settings.account.sum_pushed", { n: r.pushed }));
  if (r.pulled > 0) parts.push(tr("settings.account.sum_pulled", { n: r.pulled }));
  if (r.deleted_locally > 0)
    parts.push(tr("settings.account.sum_deleted", { n: r.deleted_locally }));
  if (parts.length === 0) return tr("settings.account.sum_noop");
  // Capitalize the joined sentence.
  const s = parts.join(", ");
  return s.charAt(0).toUpperCase() + s.slice(1) + ".";
}

function SyncControl({
  t,
  onSynced,
  markedCount,
}: {
  t: ThemePalette;
  onSynced: () => void;
  /** How many hosts are flagged for sync (null = unknown/not loaded yet). */
  markedCount: number | null;
}) {
  const { t: tr } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<SyncReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      const r = await accountSyncNow();
      setReport(r);
      onSynced();
    } catch (e) {
      setError(isVaultLockedError(e) ? tr("settings.account.vault_locked") : String(e));
    } finally {
      setBusy(false);
    }
  }

  // When zero hosts are flagged, a silent "0/0/0" is confusing — explain it and
  // route the user to the host-selection manager.
  const nothingMarked = markedCount === 0;

  return (
    <div className="space-y-3">
      {nothingMarked && (
        <div
          className="rounded border p-3 font-mono text-[11px] leading-relaxed flex items-start gap-2 max-w-md"
          style={{ background: t.bgPanel, borderColor: t.warning + "66", color: t.textSoft }}
        >
          <Info size={14} className="mt-0.5 shrink-0" style={{ color: t.warning }} />
          {/* Selection lives ONCE, in the "Synced hosts" row above. No duplicate
              "choose hosts" button here. */}
          <div>{tr("settings.account.no_marked_notice")}</div>
        </div>
      )}

      <PrimaryButton t={t} onClick={run} busy={busy} icon={<RefreshCw size={14} />}>
        {busy ? tr("settings.account.syncing") : tr("settings.account.sync_now")}
      </PrimaryButton>

      {report && (
        <div
          className="rounded border p-3 font-mono text-xs space-y-2 max-w-md"
          style={{ background: t.bgPanel, borderColor: t.border }}
        >
          <div className="flex items-center gap-2" style={{ color: t.accent }}>
            <Check size={12} /> {tr("settings.account.sync_done")}
          </div>
          <div style={{ color: t.textPrimary }}>{syncSummary(report, tr)}</div>

          {/* Detail breakdown */}
          <div className="space-y-1 pt-1 border-t" style={{ borderColor: t.border }}>
            <div className="flex justify-between">
              <span style={{ color: t.textMuted }}>{tr("settings.account.pulled")}</span>
              <span style={{ color: t.textPrimary }}>{report.pulled}</span>
            </div>
            <div className="flex justify-between">
              <span style={{ color: t.textMuted }}>{tr("settings.account.pushed")}</span>
              <span style={{ color: t.textPrimary }}>{report.pushed}</span>
            </div>
            <div className="flex justify-between">
              <span style={{ color: t.textMuted }}>{tr("settings.account.deleted_locally")}</span>
              <span style={{ color: t.textPrimary }}>{report.deleted_locally}</span>
            </div>
            <div className="flex justify-between">
              <span style={{ color: t.textMuted }}>{tr("settings.account.conflicts")}</span>
              <span style={{ color: report.conflicts > 0 ? t.warning : t.textPrimary }}>
                {report.conflicts}
              </span>
            </div>
          </div>

          {report.conflicts > 0 && (
            <div
              className="flex items-start gap-1.5 pt-1 text-[11px]"
              style={{ color: t.warning }}
            >
              <AlertTriangle size={12} className="mt-0.5 shrink-0" />
              <span>{tr("settings.account.conflicts_note")}</span>
            </div>
          )}
        </div>
      )}

      {error && <ErrorLine t={t} msg={error} />}
    </div>
  );
}

function TwoFactorControl({
  t,
  enabled,
  onChanged,
}: {
  t: ThemePalette;
  enabled: boolean;
  onChanged: () => void;
}) {
  const { t: tr } = useTranslation();
  const [enroll, setEnroll] = useState<TotpEnroll | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);

  async function begin() {
    setBusy(true);
    setError(null);
    try {
      setEnroll(await accountTotpEnroll());
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function verify() {
    if (!code.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const codes = await accountTotpVerify(code.trim());
      setCode("");
      setEnroll(null);
      setRecoveryCodes(codes);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  // Recovery codes shown once after successful verification.
  if (recoveryCodes) {
    return (
      <OneTimeSecretPanel
        t={t}
        title={tr("settings.account.recovery_codes_title")}
        warning={tr("settings.account.recovery_codes_warning")}
        codes={recoveryCodes}
        confirmLabel={tr("settings.account.recovery_confirm")}
        onConfirm={() => {
          setRecoveryCodes(null);
          onChanged();
        }}
      />
    );
  }

  if (enabled) {
    return (
      <div
        className="font-mono text-xs inline-flex items-center gap-2 px-3 py-2 rounded border"
        style={{ background: t.bgPanel, borderColor: t.accent + "66", color: t.accent }}
      >
        <ShieldCheck size={14} /> {tr("settings.account.two_factor_on")}
      </div>
    );
  }

  if (!enroll) {
    return (
      <div className="space-y-2">
        <GhostButton t={t} onClick={begin} busy={busy} icon={<ShieldPlus size={14} />}>
          {tr("settings.account.enable_2fa")}
        </GhostButton>
        {error && <ErrorLine t={t} msg={error} />}
      </div>
    );
  }

  // Enrollment in progress: scannable QR (qrcode.react) + numbered steps, with
  // the manual secret as a copyable fallback.
  return (
    <div className="space-y-4 max-w-md">
      {/* Step 1 — scan */}
      <div className="space-y-2">
        <div className="font-mono text-[11px] leading-relaxed" style={{ color: t.textSoft }}>
          <span style={{ color: t.accent }}>1.</span> {tr("settings.account.totp_step1")}
        </div>
        <div
          className="inline-block rounded p-3"
          style={{ background: "#ffffff", border: `1px solid ${t.border}` }}
        >
          <QRCodeSVG value={enroll.otpauth_url} size={168} level="M" marginSize={1} />
        </div>
        <div className="font-mono text-[11px]" style={{ color: t.textMuted }}>
          {tr("settings.account.totp_manual_fallback")}
        </div>
        <CopyField t={t} label={tr("settings.account.totp_secret")} value={enroll.secret} />
      </div>

      {/* Step 2 — enter code */}
      <div className="space-y-2">
        <div className="font-mono text-[11px] leading-relaxed" style={{ color: t.textSoft }}>
          <span style={{ color: t.accent }}>2.</span> {tr("settings.account.totp_step2")}
        </div>
        <LabeledInput
          t={t}
          label={tr("settings.account.totp_code")}
          value={code}
          onChange={setCode}
          placeholder="000000"
          autoFocus
        />
      </div>

      <div className="flex items-center gap-2">
        <PrimaryButton t={t} onClick={verify} busy={busy} disabled={!code.trim()}>
          {tr("settings.account.totp_verify")}
        </PrimaryButton>
        <GhostButton
          t={t}
          onClick={() => {
            setEnroll(null);
            setCode("");
            setError(null);
          }}
          disabled={busy}
        >
          {tr("settings.account.cancel")}
        </GhostButton>
      </div>
      {error && <ErrorLine t={t} msg={error} />}
    </div>
  );
}

function LogoutControl({ t, onChanged }: { t: ThemePalette; onChanged: () => void }) {
  const { t: tr } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function logout() {
    setBusy(true);
    setError(null);
    try {
      await accountLogout();
      onChanged();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      <GhostButton t={t} onClick={logout} busy={busy} icon={<LogOut size={14} />}>
        {tr("settings.account.logout")}
      </GhostButton>
      {error && <ErrorLine t={t} msg={error} />}
    </div>
  );
}
