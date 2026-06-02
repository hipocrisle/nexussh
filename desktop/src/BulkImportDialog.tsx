// Bulk host import — paste a list of IPs/hostnames (one per line, optional
// :port), set shared user / folder / port once, and create many hosts at
// once. Auth is always "ask each time" — bulk import never stores passwords
// (work fleets use prompt-on-connect; secrets belong in the vault per-host).

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { listHosts, saveHost, newHostId, HostRecord } from "./hosts";
import { useSettings } from "./settings/settings-store";
import { useBackdropClose } from "./useBackdropClose";

interface Props {
  onClose: () => void;
  onImported?: () => void;
}

interface Parsed {
  host: string;
  port: number;
}

// One host per line: `10.0.0.5`, `10.0.0.5:2222`, `host.example.com`, or
// `host.example.com:2222`. Blank lines and `#` comments are ignored.
function parseList(text: string, defaultPort: number): Parsed[] {
  const out: Parsed[] = [];
  for (const lineRaw of text.split(/\r?\n/)) {
    const line = lineRaw.trim();
    if (!line || line.startsWith("#")) continue;
    // Split host:port but tolerate bare IPv6 (no brackets) by only treating
    // a trailing :digits after the LAST colon as a port when there's exactly
    // one colon (plain IPv4 / hostname). IPv6 users can add brackets later.
    const m = line.match(/^(.*?)(?::(\d{1,5}))?$/);
    let host = line;
    let port = defaultPort;
    if (line.split(":").length === 2 && m) {
      host = m[1];
      if (m[2]) port = Math.min(65535, Math.max(1, parseInt(m[2], 10)));
    }
    if (host) out.push({ host, port });
  }
  return out;
}

export function BulkImportDialog({ onClose, onImported }: Props) {
  const { t } = useTranslation();
  const [settings] = useSettings();
  const [text, setText] = useState("");
  const [user, setUser] = useState("");
  const [folder, setFolder] = useState("");
  const [port, setPort] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ added: number; skipped: number } | null>(null);
  const { backdropProps, contentProps } = useBackdropClose(onClose);

  async function loadFile() {
    try {
      const p = await open({ multiple: false, title: t("bulk.pick_file") });
      if (typeof p === "string") {
        const content = await invoke<string>("read_text_file", { path: p });
        setText((prev) => (prev ? prev + "\n" + content : content));
      }
    } catch (e) {
      setError(String(e));
    }
  }

  async function doImport() {
    setError(null);
    const defPort = port.trim() ? parseInt(port, 10) || settings.defaultPort : settings.defaultPort;
    const parsed = parseList(text, defPort);
    if (parsed.length === 0) {
      setError(t("bulk.err_empty"));
      return;
    }
    setBusy(true);
    try {
      const existing = await listHosts();
      const existingKeys = new Set(existing.map((h) => `${h.host}:${h.port}`));
      const group = folder.trim() || "import";
      const u = user.trim() || settings.defaultUser;
      let added = 0;
      let skipped = 0;
      for (const p of parsed) {
        const key = `${p.host}:${p.port}`;
        if (existingKeys.has(key)) {
          skipped += 1;
          continue;
        }
        existingKeys.add(key);
        const rec: HostRecord = {
          id: newHostId(),
          name: p.host,
          host: p.host,
          port: p.port,
          user: u,
          auth: { kind: "password", password: "" },
          alwaysAskPassword: true,
          group,
        };
        await saveHost(rec);
        added += 1;
      }
      setResult({ added, skipped });
      onImported?.();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  const inputBase =
    "w-full bg-[var(--nx-bg-panel)] border border-[var(--nx-border)] rounded px-3 py-2 text-[var(--nx-text-primary)] focus:outline-none focus:border-[var(--nx-accent)] placeholder-[var(--nx-text-muted)] font-mono text-sm";
  const label = "text-xs uppercase tracking-wider text-[var(--nx-text-soft)] mb-1 block";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      {...backdropProps}
    >
      <div
        {...contentProps}
        className="w-full max-w-lg bg-[var(--nx-bg-base)] border border-[var(--nx-border)] rounded-lg shadow-2xl p-6 max-md:max-w-none max-md:h-full max-md:rounded-none max-md:border-0 max-md:overflow-y-auto max-md:pt-[calc(env(safe-area-inset-top)+16px)]"
      >
        <h2 className="text-xl font-mono text-[var(--nx-accent)] mb-1">
          &gt; {t("bulk.title")}
        </h2>
        <p className="text-xs text-[var(--nx-text-muted)] font-mono mb-4">
          {t("bulk.subtitle")}
        </p>

        {result ? (
          <div className="space-y-4">
            <p className="text-sm font-mono text-[var(--nx-text-primary)]">
              {t("bulk.done", { added: result.added, skipped: result.skipped })}
            </p>
            <button
              type="button"
              onClick={onClose}
              className="w-full py-2 bg-[var(--nx-accent)] text-[var(--nx-bg-base)] font-mono font-bold rounded"
            >
              {t("bulk.close")}
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            <div>
              <label className={label}>{t("bulk.list")}</label>
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder={"10.0.0.5\n10.0.0.6:2222\nhost.example.com"}
                rows={7}
                className={inputBase + " resize-y"}
              />
              <button
                type="button"
                onClick={loadFile}
                className="mt-1.5 text-xs font-mono text-[var(--nx-accent)] hover:underline"
              >
                {t("bulk.from_file")}
              </button>
            </div>

            <div className="grid grid-cols-3 gap-2">
              <div>
                <label className={label}>{t("bulk.user")}</label>
                <input
                  value={user}
                  onChange={(e) => setUser(e.target.value)}
                  placeholder={settings.defaultUser}
                  className={inputBase}
                />
              </div>
              <div>
                <label className={label}>{t("bulk.port")}</label>
                <input
                  value={port}
                  onChange={(e) => setPort(e.target.value.replace(/\D/g, ""))}
                  placeholder={String(settings.defaultPort)}
                  className={inputBase}
                />
              </div>
              <div>
                <label className={label}>{t("bulk.folder")}</label>
                <input
                  value={folder}
                  onChange={(e) => setFolder(e.target.value)}
                  placeholder="import"
                  className={inputBase}
                />
              </div>
            </div>

            <p className="text-xs text-[var(--nx-text-muted)] font-mono">
              {t("bulk.hint")}
            </p>

            {error && (
              <div className="text-[var(--nx-error)] text-sm font-mono break-all">
                ✗ {error}
              </div>
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
                type="button"
                onClick={doImport}
                disabled={busy || !text.trim()}
                className="flex-1 py-2 bg-[var(--nx-accent)] disabled:opacity-50 text-[var(--nx-bg-base)] font-mono font-bold rounded"
              >
                {busy ? "..." : t("bulk.import_btn")}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
