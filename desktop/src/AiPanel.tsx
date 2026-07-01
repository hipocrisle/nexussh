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
  /** Свернуть панель (state сохраняется — не закрытие). */
  onClose: () => void;
  /** Вставить команду в активный терминал (без выполнения — юзер жмёт Enter). */
  onInsert: (cmd: string) => void;
  /** Метка/имя активного хоста — подсказка платформы (не контекст терминала). */
  hostLabel?: string | null;
  /** Есть ли активная SSH-сессия. */
  hasSession: boolean;
  /** Сообщить наружу, есть ли незавершённый черновик (для пульс-индикатора). */
  onHasDraftChange?: (hasDraft: boolean) => void;
}

export default function AiPanel({
  open,
  onClose,
  onInsert,
  hostLabel,
  hasSession,
  onHasDraftChange,
}: Props) {
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<AiSuggestion[]>([]);
  const [sel, setSel] = useState(0);
  // Навигировал ли юзер стрелками: пока false — Enter = новый поиск, после — вставка.
  const [navigated, setNavigated] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Подтягиваем статус доступа при разворачивании + фокус ввода.
  useEffect(() => {
    if (!open) return;
    setErr(null);
    aiStatus()
      .then(setStatus)
      .catch((e) => setErr(String(e)));
    setTimeout(() => inputRef.current?.focus(), 60);
  }, [open]);

  // Наличие черновика (для пульс-точки на кнопке AI).
  useEffect(() => {
    onHasDraftChange?.(query.trim() !== "" || items.length > 0);
  }, [query, items, onHasDraftChange]);

  const granted = status?.status === "granted";

  async function ask() {
    const q = query.trim();
    if (!q || busy) return;
    setBusy(true);
    setErr(null);
    setItems([]);
    setNavigated(false);
    try {
      const s = await aiSuggest(q, guessOs(hostLabel));
      setItems(s);
      setSel(0);
      if (!s.length) setErr("Модель не вернула команд — уточни запрос.");
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
    onClose(); // свернуть (черновик остаётся до «Очистить»)
  }

  function clearDraft() {
    setQuery("");
    setItems([]);
    setSel(0);
    setNavigated(false);
    setErr(null);
    inputRef.current?.focus();
  }

  function onKey(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      onClose(); // Esc = свернуть, не сброс
      return;
    }
    if (e.key === "ArrowDown" && items.length) {
      e.preventDefault();
      setNavigated(true);
      setSel((s) => Math.min(s + 1, items.length - 1));
    } else if (e.key === "ArrowUp" && items.length) {
      e.preventDefault();
      setNavigated(true);
      setSel((s) => Math.max(s - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (navigated && items[sel]) insert(items[sel].cmd);
      else ask();
    }
  }

  const remainLabel =
    status == null
      ? ""
      : status.remaining == null
        ? "без лимита"
        : `осталось ${status.remaining} сегодня`;

  const hasDraft = query.trim() !== "" || items.length > 0;

  return (
    // Всегда в DOM — прячем через классы, чтобы state (запрос/ответ) сохранялся
    // при сворачивании, а сворачивание было анимированным.
    <div
      className={`fixed inset-0 z-50 flex items-start justify-center pt-24 transition-opacity duration-200 ${
        open
          ? "bg-black/50 opacity-100"
          : "bg-transparent opacity-0 pointer-events-none"
      }`}
      onClick={onClose}
      aria-hidden={!open}
    >
      <div
        className={`w-[min(680px,92vw)] rounded-xl bg-nx-elevated shadow-2xl border border-nx-border overflow-hidden origin-top-right transition-all duration-200 ${
          open ? "scale-100 opacity-100 translate-y-0" : "scale-90 opacity-0 -translate-y-6"
        }`}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKey}
      >
        <div className="flex items-center gap-2 px-4 py-3 border-b border-nx-border">
          <span className="text-lg">🤖</span>
          <span className="font-medium">AI-подсказка команд</span>
          <span className="ml-auto text-xs text-nx-muted">{remainLabel}</span>
          {granted && hasDraft && (
            <button
              type="button"
              onClick={clearDraft}
              title="Очистить запрос и ответ"
              className="text-xs text-nx-muted hover:text-nx-text px-1.5 py-0.5 rounded"
            >
              Очистить
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            title="Свернуть (Esc) — запрос сохранится"
            className="text-nx-muted hover:text-nx-text px-1.5 leading-none text-lg"
          >
            —
          </button>
        </div>

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

        {granted && (
          <div className="p-4 space-y-3">
            <div className="flex gap-2">
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setNavigated(false); // новый ввод → Enter снова = поиск
                }}
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
                свернуть.
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
