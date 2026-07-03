import { useEffect, useRef, useState } from "react";
import { Sparkles, Send, Copy, Check } from "lucide-react";
import type { AiAssistant } from "./useAiAssistant";
import { writeClipboard } from "./clipboard";
import { useIsMobile } from "./useIsMobile";

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
  const isMobile = useIsMobile();
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
    answer,
  } = ai;

  // Перетаскивание панели за шапку (чтобы видеть терминал под ней). Позиция
  // сохраняется в рамках сессии (панель всегда смонтирована на уровне App).
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const dragRef = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null);
  function onHeaderPointerDown(e: React.PointerEvent) {
    if (isMobile) return; // на мобиле панель — bottom-sheet, drag не нужен
    if ((e.target as HTMLElement).closest("button")) return; // не с кнопок шапки
    dragRef.current = { sx: e.clientX, sy: e.clientY, ox: pos.x, oy: pos.y };
    const move = (ev: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      setPos({ x: d.ox + ev.clientX - d.sx, y: d.oy + ev.clientY - d.sy });
    };
    const up = () => {
      dragRef.current = null;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  // Мобайл: поднять bottom-sheet над экранной клавиатурой. Без этого поле ввода
  // прячется за клавиатурой (WebView оверлеит её). Считаем «инсет» снизу по
  // visualViewport и делаем его нижним отступом контейнера.
  const [kbInset, setKbInset] = useState(0);
  useEffect(() => {
    if (!isMobile) return;
    const vv = window.visualViewport;
    if (!vv) return;
    const onResize = () => {
      setKbInset(Math.max(0, window.innerHeight - vv.height - vv.offsetTop));
    };
    vv.addEventListener("resize", onResize);
    vv.addEventListener("scroll", onResize);
    onResize();
    return () => {
      vv.removeEventListener("resize", onResize);
      vv.removeEventListener("scroll", onResize);
    };
  }, [isMobile]);

  // Короткий «Скопировано» тик у кнопки копирования (ключ = что скопировали).
  const [copied, setCopied] = useState<string | null>(null);
  // Ответ показываем свёрнутым (краткая выжимка) + «Развернуть». Сбрасываем на
  // свёрнутый при каждом новом ответе.
  const [answerExpanded, setAnswerExpanded] = useState(false);
  useEffect(() => {
    setAnswerExpanded(false);
  }, [answer]);
  const ANSWER_PREVIEW = 240;
  const answerLong = answer.trim().length > ANSWER_PREVIEW;
  const answerShown =
    answerExpanded || !answerLong
      ? answer.trim()
      : answer.trim().slice(0, ANSWER_PREVIEW).trimEnd() + "…";
  async function copy(text: string, key: string) {
    try {
      await writeClipboard(text);
      setCopied(key);
      setTimeout(() => setCopied((c) => (c === key ? null : c)), 1200);
    } catch {
      /* ignore */
    }
  }

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
  // Прогресс квоты (доля оставшегося) для cyan-бара; null = без лимита.
  const quotaPct =
    granted && status && status.daily_limit != null && status.remaining != null
      ? Math.max(0, Math.min(100, (status.remaining / status.daily_limit) * 100))
      : null;

  return (
    <div
      className={`fixed inset-0 z-50 flex justify-center transition-opacity duration-200 items-start pt-24 max-md:items-end max-md:pt-0 ${
        open ? "bg-black/50 opacity-100" : "bg-transparent opacity-0 pointer-events-none"
      }`}
      style={isMobile && kbInset ? { paddingBottom: kbInset } : undefined}
      onClick={onClose}
      aria-hidden={!open}
    >
      <div
        style={!isMobile ? { transform: `translate(${pos.x}px, ${pos.y}px)` } : undefined}
        className="max-md:w-full"
        onClick={(e) => e.stopPropagation()}
      >
      <div
        className={`nx-modal-enter relative w-[min(680px,92vw)] max-h-[85vh] flex flex-col rounded-nx-lg bg-nx-panel nx-glow-ai border border-nx-border overflow-hidden transition-all duration-200 max-md:w-full max-md:max-h-[88vh] max-md:rounded-b-none max-md:origin-bottom origin-top-right ${
          isMobile
            ? open
              ? "translate-y-0 opacity-100"
              : "translate-y-full opacity-0"
            : open
              ? "scale-100 opacity-100 translate-y-0"
              : "scale-90 opacity-0 -translate-y-6"
        }`}
        onKeyDown={onKey}
      >
        <span className="nx-brackets nx-brackets--ai">
          <i />
        </span>
        <div
          className={`flex items-center gap-2.5 px-4 py-3 border-b border-nx-divider select-none shrink-0 ${
            isMobile ? "" : "cursor-move"
          }`}
          onPointerDown={onHeaderPointerDown}
          title={isMobile ? undefined : "Потяни, чтобы переместить"}
        >
          <span className="nx-ai-orb">
            <Sparkles size={15} />
          </span>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="font-medium text-sm">AI-подсказка команд</span>
              {busy && (
                <span className="text-xs text-nx-accent2 animate-pulse">думает…</span>
              )}
            </div>
            {granted && (
              <div className="flex items-center gap-2 mt-0.5">
                <span className="text-[11px] text-nx-muted whitespace-nowrap">{remainLabel}</span>
                {quotaPct != null && (
                  <span className="nx-ai-bar w-20 max-w-[30vw]">
                    <i style={{ width: `${quotaPct}%` }} />
                  </span>
                )}
              </div>
            )}
          </div>
          {granted && ai.hasDraft && (
            <button
              type="button"
              onClick={clear}
              title="Очистить запрос и ответ"
              className="ml-auto text-xs text-nx-muted hover:text-nx-text px-1.5 py-0.5 rounded"
            >
              Очистить
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            title="Свернуть (Esc) — запрос продолжит выполняться"
            className={`${granted && ai.hasDraft ? "" : "ml-auto"} text-nx-muted hover:text-nx-text px-1.5 leading-none text-lg`}
          >
            —
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
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
                className="px-4 py-2 rounded-lg bg-nx-accent text-nx-bg font-semibold text-sm shadow-glow-sm inline-flex items-center gap-1.5 disabled:opacity-50 disabled:shadow-none"
              >
                <Send size={13} />
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

            {/* Текстовый ответ — свёрнут до краткой выжимки, «Развернуть» для полного.
                Короткий свёрнутый ответ не прячет команды под фолд. */}
            {answer.trim() && (
              <div className="rounded-nx border border-nx-divider bg-nx-bg/40 p-3">
                <div className="text-micro uppercase tracking-[0.22em] text-nx-soft mb-1.5">
                  // ответ
                </div>
                <div className="flex items-start gap-2">
                  <div className="flex-1 text-sm whitespace-pre-wrap break-words leading-snug">
                    {answerShown}
                  </div>
                  <button
                    type="button"
                    onClick={() => copy(answer, "answer")}
                    title="Скопировать ответ"
                    className="shrink-0 text-xs text-nx-muted hover:text-nx-text px-1.5 py-0.5 rounded border border-nx-border"
                  >
                    {copied === "answer" ? "✓" : "Копировать"}
                  </button>
                </div>
                {answerLong && (
                  <button
                    type="button"
                    onClick={() => setAnswerExpanded((v) => !v)}
                    className="mt-1.5 text-xs text-nx-accent hover:underline"
                  >
                    {answerExpanded ? "Свернуть" : "Развернуть"}
                  </button>
                )}
              </div>
            )}

            {items.length > 0 && (
              <div>
                <div className="text-micro uppercase tracking-[0.22em] text-nx-soft mb-1.5">
                  // предложенные команды
                </div>
                <div className="rounded-nx border border-nx-divider overflow-hidden divide-y divide-nx-divider">
                  {items.map((it, i) => (
                    <div
                      key={i}
                      className="nx-row px-3 py-2"
                      data-active={i === sel}
                      onMouseEnter={() => setSel(i)}
                    >
                      <div className="flex items-center gap-2">
                        <code className="flex-1 text-sm font-mono min-w-0 truncate">
                          <span className="text-nx-muted mr-1.5 select-none">$</span>
                          <span className="text-nx-accent">{it.cmd}</span>
                        </code>
                        {it.danger && (
                          <span className="text-[11px] text-nx-danger shrink-0">⚠ опасная</span>
                        )}
                        <button
                          type="button"
                          onClick={() => copy(it.cmd, `cmd${i}`)}
                          title="Скопировать команду"
                          className="shrink-0 text-nx-muted hover:text-nx-text p-1 rounded"
                        >
                          {copied === `cmd${i}` ? <Check size={13} /> : <Copy size={13} />}
                        </button>
                        <button
                          type="button"
                          onClick={() => insert(it.cmd)}
                          className="shrink-0 text-[11px] text-nx-accent border border-nx-accent/40 rounded-full px-2 py-0.5 hover:bg-nx-accent/10"
                        >
                          → выполнить
                        </button>
                      </div>
                      {it.explain && (
                        <div className="text-xs text-nx-muted mt-1">{it.explain}</div>
                      )}
                    </div>
                  ))}
                </div>
                <p className="text-[11px] text-nx-muted mt-1.5">
                  {isMobile
                    ? "Тап «→ выполнить» — вставить в терминал (не запускается), копия — иконкой."
                    : "↑/↓ — выбор, Enter или «→ выполнить» — вставить (не запускается), Esc — свернуть."}
                </p>
              </div>
            )}

            {/* Пустое состояние — до первого запроса. */}
            {!busy && !err && !answer.trim() && items.length === 0 && (
              <div className="rounded-nx border border-nx-divider bg-nx-bg/40 p-3">
                <div className="text-micro uppercase tracking-[0.22em] text-nx-soft mb-1.5">
                  // как это работает
                </div>
                <p className="text-xs text-nx-muted leading-relaxed">
                  Опиши задачу на русском — AI предложит команды или объяснит вывод.
                  Ничего не выполняется само: команда лишь вставляется в терминал по
                  «→ выполнить», запускаешь её ты. Для разбора экрана включи «AI видит
                  экран».
                </p>
              </div>
            )}
          </div>
        )}
        </div>
      </div>
      </div>
    </div>
  );
}
