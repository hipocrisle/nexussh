import { useEffect, useRef, useState } from "react";
import {
  aiStatus,
  aiRequest,
  aiSuggest,
  guessOs,
  type AiStatus,
  type AiSuggestion,
} from "./ai";

interface Props {
  open: boolean;
  onClose: () => void;
  /** Вставить команду в активный терминал (без выполнения — юзер жмёт Enter). */
  onInsert: (cmd: string) => void;
  /** Метка/имя активного хоста — подсказка платформы (не контекст терминала). */
  hostLabel?: string | null;
  /** Есть ли активная SSH-сессия (иначе вставлять некуда). */
  hasSession: boolean;
}

export default function AiPanel({
  open,
  onClose,
  onInsert,
  hostLabel,
  hasSession,
}: Props) {
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<AiSuggestion[]>([]);
  const [sel, setSel] = useState(0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // При открытии — подтянуть статус доступа и сфокусировать ввод.
  useEffect(() => {
    if (!open) return;
    setErr(null);
    aiStatus()
      .then(setStatus)
      .catch((e) => setErr(String(e)));
    setTimeout(() => inputRef.current?.focus(), 50);
  }, [open]);

  if (!open) return null;

  const granted = status?.status === "granted";

  async function ask() {
    const q = query.trim();
    if (!q || busy) return;
    setBusy(true);
    setErr(null);
    setItems([]);
    try {
      const s = await aiSuggest(q, guessOs(hostLabel));
      setItems(s);
      setSel(0);
      if (!s.length) setErr("Модель не вернула команд — уточни запрос.");
      // Обновим остаток.
      aiStatus().then(setStatus).catch(() => {});
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function requestAccess() {
    setBusy(true);
    try {
      const r = await aiRequest();
      setStatus((p) => (p ? { ...p, status: r.status } : p));
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  function insert(cmd: string) {
    onInsert(cmd);
    onClose();
  }

  function onKey(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      onClose();
      return;
    }
    if (!items.length) {
      if (e.key === "Enter") ask();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSel((s) => Math.min(s + 1, items.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSel((s) => Math.max(s - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const it = items[sel];
      if (it) insert(it.cmd);
    }
  }

  const remainLabel =
    status == null
      ? ""
      : status.remaining == null
        ? "без лимита"
        : `осталось ${status.remaining} сегодня`;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 pt-24"
      onClick={onClose}
    >
      <div
        className="w-[min(680px,92vw)] rounded-xl bg-nx-elevated shadow-2xl border border-nx-border overflow-hidden"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKey}
      >
        <div className="flex items-center gap-2 px-4 py-3 border-b border-nx-border">
          <span className="text-lg">🤖</span>
          <span className="font-medium">AI-подсказка команд</span>
          <span className="ml-auto text-xs text-nx-muted">{remainLabel}</span>
        </div>

        {/* Нет доступа — предложить запросить */}
        {!granted && (
          <div className="p-5 space-y-3 text-sm">
            {status?.status === "pending" ? (
              <p>⏳ Запрос отправлен. Ожидает одобрения администратором.</p>
            ) : status?.status === "denied" ? (
              <p>⛔ Доступ к AI отклонён.</p>
            ) : (
              <>
                <p className="text-nx-muted">
                  AI-подсказки команд требуют одобрения (подписка с лимитом
                  токенов). Отправить запрос администратору?
                </p>
                <button
                  type="button"
                  disabled={busy}
                  onClick={requestAccess}
                  className="px-4 py-2 rounded-lg bg-nx-accent text-white text-sm disabled:opacity-50"
                >
                  Запросить доступ к AI
                </button>
              </>
            )}
            {err && <p className="text-nx-danger text-xs">{err}</p>}
          </div>
        )}

        {/* Есть доступ — рабочая панель */}
        {granted && (
          <div className="p-4 space-y-3">
            <div className="flex gap-2">
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Что нужно сделать? (напр. «показать открытые порты»)"
                className="flex-1 px-3 py-2 rounded-lg bg-nx-bg border border-nx-border text-sm outline-none focus:border-nx-accent"
              />
              <button
                type="button"
                disabled={busy || !query.trim()}
                onClick={ask}
                className="px-4 py-2 rounded-lg bg-nx-accent text-white text-sm disabled:opacity-50"
              >
                {busy ? "…" : "Спросить"}
              </button>
            </div>

            {!hasSession && (
              <p className="text-xs text-nx-muted">
                ⚠️ Нет активного терминала — команду можно только скопировать.
              </p>
            )}
            {err && <p className="text-nx-danger text-xs">{err}</p>}

            {items.length > 0 && (
              <ul className="space-y-1 max-h-[46vh] overflow-auto">
                {items.map((it, i) => (
                  <li key={i}>
                    <button
                      type="button"
                      onMouseEnter={() => setSel(i)}
                      onClick={() => insert(it.cmd)}
                      className={`w-full text-left px-3 py-2 rounded-lg border transition ${
                        i === sel
                          ? "border-nx-accent bg-nx-accent/10"
                          : "border-transparent hover:bg-nx-bg"
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <code className="text-sm font-mono">{it.cmd}</code>
                        {it.danger && (
                          <span className="text-xs text-nx-danger">
                            🔴 опасная
                          </span>
                        )}
                      </div>
                      {it.explain && (
                        <div className="text-xs text-nx-muted mt-0.5">
                          {it.explain}
                        </div>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            )}

            {items.length > 0 && (
              <p className="text-[11px] text-nx-muted">
                ↑/↓ — выбор, Enter — вставить в терминал (не выполняется), Esc —
                закрыть.
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
