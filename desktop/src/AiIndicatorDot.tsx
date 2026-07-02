import type { AiAssistant } from "./useAiAssistant";

/**
 * Точка-индикатор на кнопке AI (абсолютно позиционируется в relative-родителе).
 * Приоритет: красная пульсация = контекст-режим включён (экран читается,
 * privacy-сигнал) > думает > готово > черновик. Скрыта, когда панель открыта.
 * Общая для десктоп-хедера и мобильного топ-бара.
 */
export default function AiIndicatorDot({
  ai,
  panelOpen,
}: {
  ai: AiAssistant;
  panelOpen: boolean;
}) {
  if (panelOpen) return null;
  const ctxOn = ai.useCtx && ai.contextAllowed;
  const base =
    "absolute top-0.5 right-0.5 w-1.5 h-1.5 rounded-full pointer-events-none";
  if (ai.busy)
    return (
      <span
        className={`${base} animate-ping ${ctxOn ? "bg-red-500" : "bg-nx-accent"}`}
        title={ctxOn ? "AI думает (видит экран)" : "AI думает"}
      />
    );
  if (ctxOn)
    return (
      <span
        className={`${base} bg-red-500 animate-pulse`}
        title="Контекст-режим: AI видит экран"
      />
    );
  if (ai.ready)
    return <span className={`${base} bg-green-500`} title="Ответ готов" />;
  if (ai.hasDraft)
    return (
      <span
        className={`${base} bg-nx-accent animate-pulse`}
        title="Есть черновик"
      />
    );
  return null;
}
