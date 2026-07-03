import { useCallback, useEffect, useRef, useState } from "react";
import {
  aiStatus,
  aiRequest,
  aiSuggest,
  guessOs,
  type AiStatus,
  type AiSuggestion,
} from "./ai";

/** Человекочитаемая ошибка (в т.ч. offline). */
function aiErrorMessage(e: unknown): string {
  const s = String(e);
  // Серверные коды из ApiError — проверяем ДО сетевых, чтобы 502/timeout от
  // upstream не мапились ошибочно в «нет интернета» (был разовый 502 → мис-лейбл).
  if (/ai not enabled|403/i.test(s)) return "AI-доступ не активен.";
  if (/daily limit|429/i.test(s)) return "Дневной лимит запросов исчерпан.";
  if (/too long|413/i.test(s)) return "Запрос слишком длинный.";
  if (/unavailable|503/i.test(s)) return "AI временно недоступен (общий лимит). Попробуй позже.";
  // upstream/шлюз/таймаут AI — это НЕ отсутствие интернета у пользователя.
  if (/ai upstream|bad gateway|502|gateway|timeout|504/i.test(s))
    return "AI не смог ответить (сервис перегружен). Попробуй ещё раз.";
  // Только настоящая сетевая ошибка клиента.
  if (/network|connection|fetch|unreachable|dns|refused|offline|error sending/i.test(s)) {
    return "Нет соединения с сервером AI. Проверь интернет и попробуй снова.";
  }
  return s.replace(/^Error:\s*/, "");
}

/**
 * AI-ассистент как hook НА УРОВНЕ App. Так запрос (ask) живёт в родителе, который
 * всегда смонтирован и активен — и продолжает выполняться, даже когда панель
 * свёрнута (WebKitGTK душит JS в скрытом поддереве, из-за чего внутри панели
 * запрос «замирал»). Панель — просто презентация над этим состоянием.
 */
export function useAiAssistant(
  hostLabel: string | null | undefined,
  // Поставщик контекста экрана (App): читает активный терминал + редактирует
  // секреты. Вызывается только когда включён тумблер И у юзера есть право.
  getScreenContext?: () => string | null,
  // Определитель платформы (App): по выводу терминала (Cisco/Mikrotik/…) с
  // фолбэком на имя хоста. Наружу — только ярлык, не экран.
  getOs?: () => string,
) {
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<AiSuggestion[]>([]);
  const [answer, setAnswer] = useState(""); // текстовый ответ (объяснение/анализ)
  const [sel, setSel] = useState(0);
  const [navigated, setNavigated] = useState(false);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false); // ответ пришёл, пока панель свёрнута
  const [err, setErr] = useState<string | null>(null);
  // Тумблер «AI видит экран». Off по умолчанию; живёт на уровне App (всегда
  // смонтирован), поэтому держится в рамках запуска и сбрасывается при рестарте.
  const [useCtx, setUseCtx] = useState(false);
  const hostRef = useRef(hostLabel);
  hostRef.current = hostLabel;
  const ctxProviderRef = useRef(getScreenContext);
  ctxProviderRef.current = getScreenContext;
  const osProviderRef = useRef(getOs);
  osProviderRef.current = getOs;

  const refreshStatus = useCallback(() => {
    return aiStatus()
      .then(setStatus)
      .catch(() => setStatus(null));
  }, []);

  useEffect(() => {
    refreshStatus();
  }, [refreshStatus]);

  // Пока доступ в ожидании — периодически опрашиваем сервер, чтобы pending сам
  // сменился на granted после одобрения в боте (без ручного переоткрытия).
  useEffect(() => {
    if (status?.status !== "pending") return;
    const id = setInterval(refreshStatus, 5000);
    return () => clearInterval(id);
  }, [status?.status, refreshStatus]);

  const ask = useCallback(async () => {
    const q = query.trim();
    if (!q || busy) return;
    setBusy(true);
    setErr(null);
    setItems([]);
    setAnswer("");
    setNavigated(false);
    setReady(false);
    try {
      // Контекст экрана — только при включённом тумблере И наличии права.
      // Сервер всё равно проигнорит его без права, но не гоняем зря и не читаем
      // буфер, если контекст не запрошен.
      const wantCtx = useCtx && status?.context_allowed === true;
      const ctx = wantCtx ? (ctxProviderRef.current?.() ?? null) : null;
      const os = osProviderRef.current?.() || guessOs(hostRef.current);
      const r = await aiSuggest(q, os, ctx);
      setItems(r.suggestions);
      setAnswer(r.answer);
      setSel(0);
      setReady(true);
      if (!r.suggestions.length && !r.answer.trim())
        setErr("Модель не вернула ответ — уточни запрос.");
      refreshStatus();
    } catch (e) {
      setErr(aiErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }, [query, busy, refreshStatus, useCtx, status?.context_allowed]);

  const requestAccess = useCallback(async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await aiRequest();
      setStatus((p) => (p ? { ...p, status: r.status } : p));
    } catch (e) {
      setErr(aiErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }, []);

  const clear = useCallback(() => {
    setQuery("");
    setItems([]);
    setAnswer("");
    setSel(0);
    setNavigated(false);
    setErr(null);
    setReady(false);
  }, []);

  const hasDraft = query.trim() !== "" || items.length > 0 || answer.trim() !== "";

  return {
    status,
    query,
    setQuery,
    items,
    answer,
    sel,
    setSel,
    navigated,
    setNavigated,
    busy,
    ready,
    setReady,
    err,
    ask,
    requestAccess,
    clear,
    refreshStatus,
    hasDraft,
    granted: status?.status === "granted",
    contextAllowed: status?.context_allowed === true,
    useCtx,
    setUseCtx,
  };
}

export type AiAssistant = ReturnType<typeof useAiAssistant>;
