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
  if (/network|connection|fetch|timeout|unreachable|dns|refused|offline|error sending/i.test(s)) {
    return "Нет соединения с сервером AI. Проверь интернет и попробуй снова.";
  }
  // Серверные коды из ApiError.
  if (/ai not enabled|403/i.test(s)) return "AI-доступ не активен.";
  if (/daily limit|429/i.test(s)) return "Дневной лимит запросов исчерпан.";
  if (/too long|413/i.test(s)) return "Запрос слишком длинный.";
  if (/unavailable|503/i.test(s)) return "AI временно недоступен (общий лимит). Попробуй позже.";
  return s.replace(/^Error:\s*/, "");
}

/**
 * AI-ассистент как hook НА УРОВНЕ App. Так запрос (ask) живёт в родителе, который
 * всегда смонтирован и активен — и продолжает выполняться, даже когда панель
 * свёрнута (WebKitGTK душит JS в скрытом поддереве, из-за чего внутри панели
 * запрос «замирал»). Панель — просто презентация над этим состоянием.
 */
export function useAiAssistant(hostLabel: string | null | undefined) {
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<AiSuggestion[]>([]);
  const [sel, setSel] = useState(0);
  const [navigated, setNavigated] = useState(false);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false); // ответ пришёл, пока панель свёрнута
  const [err, setErr] = useState<string | null>(null);
  const hostRef = useRef(hostLabel);
  hostRef.current = hostLabel;

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
    setNavigated(false);
    setReady(false);
    try {
      const s = await aiSuggest(q, guessOs(hostRef.current));
      setItems(s);
      setSel(0);
      setReady(true);
      if (!s.length) setErr("Модель не вернула команд — уточни запрос.");
      refreshStatus();
    } catch (e) {
      setErr(aiErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }, [query, busy, refreshStatus]);

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
    setSel(0);
    setNavigated(false);
    setErr(null);
    setReady(false);
  }, []);

  const hasDraft = query.trim() !== "" || items.length > 0;

  return {
    status,
    query,
    setQuery,
    items,
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
  };
}

export type AiAssistant = ReturnType<typeof useAiAssistant>;
