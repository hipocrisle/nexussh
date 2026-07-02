import { useEffect, useRef } from "react";
import type { AiAssistant } from "./useAiAssistant";

interface Props {
  open: boolean;
  /** Свернуть панель (state в hook сохраняется). */
  onClose: () => void;
  /** Вставить команду в активный терминал (без выполнения). */
  onInsert: (cmd: string) => void;
  /** Есть ли активная SSH-сессия. */
  hasSession: boolean;
  /** Состояние AI, поднятое на уровень App (живёт при свёрнутой панели). */
  ai: AiAssistant;
}

export default function AiPanel({ open, onClose, onInsert, hasSession, ai }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const {
    status,
    query,
    setQuery,
    items,
    sel,
    setSel,
    navigated,
    setNavigated,
    busy,
    err,
    ask,
    requestAccess,
    clear,
    refreshStatus,
    granted,
    setReady,
    contextAllowed,
    useCtx,
    setUseCtx,
  } = ai;

  useEffect(() => {
    if (!open) return;
    refreshStatus();
    setReady(false); // увидел ответ — гасим «готово»-индикатор
    setTimeout(() => inputRef.current?.focus(), 60);
  }, [open, refreshStatus, setReady]);

  if (!open && !busy) {
    // Панель скрыта — но hook продолжает работать. Держим лёгкую обёртку только
    // ради анимации сворачивания (см. классы ниже), контент не рендерим когда
    // полностью закрыто и не занят.
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
    if (e.key === "ArrowDown" && items.length) {
      e.preventDefault();
      setNavigated(true);
      setSel(Math.min(sel + 1, items.length - 1));
    } else if (e.key === "ArrowUp" && items.length) {
      e.preventDefault();
      setNavigated(true);
      setSel(Math.max(sel - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (navigated && items[sel]) insert(items[sel].cmd);
      else ask();
    }
  }

  const remainLabel =
    granted && status
      ? status.remaining == null
        ? "без лимита"
        : `осталось ${status.remaining} сегодня`
      : "";

  return (
    <div
      className={`fixed inset-0 z-50 flex items-start justify-center pt-24 transition-opacity duration-200 ${
        open ? "bg-black/50 opacity-100" : "bg-transparent opacity-0 pointer-events-none"
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
          {busy && <span className="text-xs text-nx-muted animate-pulse">думает…</span>}
          <span className="ml-auto text-xs text-nx-muted">{remainLabel}</span>
          {granted && ai.hasDraft && (
            <button
              type="button"
              onClick={clear}
              title="Очистить запрос и ответ"
              className="text-xs text-nx-muted hover:text-nx-text px-1.5 py-0.5 rounded"
            >
              Очистить
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            title="Свернуть (Esc) — запрос продолжит выполняться"
            className="text-nx-muted hover:text-nx-text px-1.5 leading-none text-lg"
          >
            —
          </button>
        </div>

        {!granted && (
          <div className="p-5 space-y-3 text-sm">
            {status?.status === "pending" ? (
              <>
                <p>⏳ Запрос отправлен. Ожидает одобрения администратором.</p>
                <p className="text-nx-muted text-xs">
                  Статус обновится автоматически. Долго нет ответа — переотправь.
                </p>
                <div className="flex gap-2">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={requestAccess}
                    className="px-3 py-1.5 rounded-lg bg-nx-accent text-white text-sm disabled:opacity-50"
                  >
                    Переотправить запрос
                  </button>
                  <button
                    type="button"
                    onClick={clear}
                    className="px-3 py-1.5 rounded-lg border border-nx-border text-sm"
                  >
                    Отмена
                  </button>
                </div>
              </>
            ) : status?.status === "denied" ? (
              <>
                <p>⛔ Доступ к AI отклонён.</p>
                <button
                  type="button"
                  disabled={busy}
                  onClick={requestAccess}
                  className="px-4 py-2 rounded-lg bg-nx-accent text-white text-sm disabled:opacity-50"
                >
                  Запросить снова
                </button>
              </>
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
                  setNavigated(false);
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

            {contextAllowed && (
              <div className="rounded-lg border border-nx-border bg-nx-bg/50 px-3 py-2">
                <label className="flex items-center gap-2 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={useCtx}
                    disabled={!hasSession}
                    onChange={(e) => setUseCtx(e.target.checked)}
                    className="accent-nx-accent"
                  />
                  <span className="text-sm">AI видит экран терминала</span>
                  {useCtx && (
                    <span className="ml-auto text-[11px] text-nx-danger">
                      ⚠️ экран уходит в AI
                    </span>
                  )}
                </label>
                {useCtx && (
                  <p className="text-[11px] text-nx-muted mt-1 leading-snug">
                    Последние ~40 строк экрана отправляются модели для точности.
                    Пароли и ключи вырезаются автоматически, но проверяй экран —
                    не гарантия. Выключай для чувствительных сессий.
                  </p>
                )}
              </div>
            )}

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
                          <span className="text-xs text-nx-danger">🔴 опасная</span>
                        )}
                      </div>
                      {it.explain && (
                        <div className="text-xs text-nx-muted mt-0.5">{it.explain}</div>
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
