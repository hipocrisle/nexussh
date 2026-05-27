// Minimal connection form — host/port/user + password or key path.
// Phase 1 scope: just enough to prove the SSH stack works.
// Will be replaced by host list + sidebar in Phase 2.

import { useState } from "react";
import { sshConnect } from "./ssh";

interface Props {
  onConnected: (sessionId: string) => void;
}

export function ConnectForm({ onConnected }: Props) {
  const [host, setHost] = useState("");
  const [port, setPort] = useState(22);
  const [user, setUser] = useState("");
  const [authKind, setAuthKind] = useState<"password" | "key">("password");
  const [password, setPassword] = useState("");
  const [keyPath, setKeyPath] = useState("");
  const [keyPass, setKeyPass] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function connect(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const auth =
        authKind === "password"
          ? { kind: "password" as const, password }
          : {
              kind: "key" as const,
              path: keyPath,
              passphrase: keyPass || undefined,
            };
      const sid = await sshConnect({ host, port, user, auth });
      onConnected(sid);
    } catch (e: unknown) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  const inputBase =
    "w-full bg-[#0e1414] border border-[#1f3a3a] rounded px-3 py-2 text-[#c9d1d9] " +
    "focus:outline-none focus:border-[#00ff95] placeholder-[#4a5560] font-mono text-sm";
  const labelBase = "text-xs uppercase tracking-wider text-[#7fd7ff] mb-1 block";

  return (
    <form
      onSubmit={connect}
      className="max-w-md mx-auto p-6 bg-[#0a0e0e] border border-[#1f3a3a] rounded-lg shadow-lg"
    >
      <h2 className="text-xl font-mono text-[#00ff95] mb-6">
        &gt; new_connection
      </h2>

      <div className="space-y-4">
        <div>
          <label className={labelBase}>Host</label>
          <input
            type="text"
            value={host}
            onChange={(e) => setHost(e.target.value)}
            placeholder="example.com"
            required
            className={inputBase}
          />
        </div>
        <div className="flex gap-3">
          <div className="flex-1">
            <label className={labelBase}>User</label>
            <input
              type="text"
              value={user}
              onChange={(e) => setUser(e.target.value)}
              placeholder="root"
              required
              className={inputBase}
            />
          </div>
          <div className="w-24">
            <label className={labelBase}>Port</label>
            <input
              type="number"
              value={port}
              onChange={(e) => setPort(parseInt(e.target.value) || 22)}
              className={inputBase}
            />
          </div>
        </div>

        <div className="flex gap-2">
          {(["password", "key"] as const).map((k) => (
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
              {k}
            </button>
          ))}
        </div>

        {authKind === "password" ? (
          <div>
            <label className={labelBase}>Password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              className={inputBase}
            />
          </div>
        ) : (
          <>
            <div>
              <label className={labelBase}>Key file path</label>
              <input
                type="text"
                value={keyPath}
                onChange={(e) => setKeyPath(e.target.value)}
                placeholder="/home/user/.ssh/id_ed25519"
                required
                className={inputBase}
              />
            </div>
            <div>
              <label className={labelBase}>Passphrase (optional)</label>
              <input
                type="password"
                value={keyPass}
                onChange={(e) => setKeyPass(e.target.value)}
                className={inputBase}
              />
            </div>
          </>
        )}

        {error && (
          <div className="text-[#ff6b6b] text-sm font-mono break-all">
            ✗ {error}
          </div>
        )}

        <button
          type="submit"
          disabled={busy}
          className="w-full py-2 mt-2 bg-[#00ff95] hover:bg-[#5fffb4] disabled:opacity-50 disabled:cursor-not-allowed text-[#0a0e0e] font-mono font-bold rounded transition-colors"
        >
          {busy ? "connecting..." : "connect"}
        </button>
      </div>
    </form>
  );
}
