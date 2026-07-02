import { invoke } from "@tauri-apps/api/core";

// AI-ассистент команд. Тонкий фронт над Tauri-командами ai_* (которые проксируют
// на sync-server /v1/ai/*). Клиент НЕ хранит Claude-ключ.

export interface AiStatus {
  status: string; // none | pending | granted | denied | expired
  tier: string; // standard | full | unlimited
  model: string; // haiku | sonnet | opus
  context_allowed: boolean;
  used_today: number;
  daily_limit: number | null; // null = без лимита
  remaining: number | null; // null = без лимита
}

export interface AiSuggestion {
  cmd: string;
  explain: string;
  danger: boolean;
}

export async function aiStatus(): Promise<AiStatus> {
  return invoke<AiStatus>("ai_status");
}

export async function aiRequest(): Promise<{ status: string }> {
  return invoke<{ status: string }>("ai_request");
}

export async function aiSuggest(
  query: string,
  os?: string,
  context?: string | null,
): Promise<AiSuggestion[]> {
  const r = await invoke<{ suggestions: AiSuggestion[] }>("ai_suggest", {
    query,
    os,
    context: context ?? null,
  });
  return r.suggestions ?? [];
}

/** Грубая догадка платформы по метке/имени хоста — подсказка модели про синтаксис.
 *  Это НЕ контекст терминала (буфер экрана), а лишь ярлык хоста, поэтому безопасно
 *  даже в MVP-режиме без контекста. */
export function guessOs(hostLabel?: string | null): string {
  const s = (hostLabel || "").toLowerCase();
  if (/(cisco|ios|catalyst|nexus|switch|router)/.test(s)) return "cisco-ios";
  if (/(esxi|vmware|vsphere)/.test(s)) return "esxi";
  if (/(mikrotik|routeros)/.test(s)) return "routeros";
  if (/(juniper|junos)/.test(s)) return "junos";
  return "linux";
}
