import { useTranslation } from "react-i18next";
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
  const { t } = useTranslation();
  if (panelOpen) return null;
  const ctxOn = ai.useCtx && ai.contextAllowed;
  const base =
    "absolute top-0.5 right-0.5 w-1.5 h-1.5 rounded-full pointer-events-none";
  if (ai.busy)
    return (
      <span
        className={`${base} animate-ping ${ctxOn ? "bg-red-500" : "bg-nx-accent"}`}
        title={ctxOn ? t("ai.dot_thinking_ctx") : t("ai.dot_thinking")}
      />
    );
  if (ctxOn)
    return (
      <span
        className={`${base} bg-red-500 animate-pulse`}
        title={t("ai.dot_ctx")}
      />
    );
  if (ai.ready)
    return <span className={`${base} bg-green-500`} title={t("ai.dot_ready")} />;
  if (ai.hasDraft)
    return (
      <span
        className={`${base} bg-nx-accent animate-pulse`}
        title={t("ai.dot_draft")}
      />
    );
  return null;
}
