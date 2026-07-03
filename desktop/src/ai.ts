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

export interface AiResult {
  /** Команды-подсказки (для вставки в терминал). */
  suggestions: AiSuggestion[];
  /** Текстовый ответ модели (объяснение/анализ экрана) — для вопросов. */
  answer: string;
}

export async function aiSuggest(
  query: string,
  os?: string,
  context?: string | null,
): Promise<AiResult> {
  const r = await invoke<{ suggestions?: AiSuggestion[]; answer?: string }>(
    "ai_suggest",
    { query, os, context: context ?? null },
  );
  return { suggestions: r.suggestions ?? [], answer: r.answer ?? "" };
}

/** Грубая догадка платформы по метке/имени хоста — подсказка модели про синтаксис.
 *  Это НЕ контекст терминала (буфер экрана), а лишь ярлык хоста, поэтому безопасно
 *  даже в MVP-режиме без контекста. */
export function guessOs(hostLabel?: string | null): string {
  const s = (hostLabel || "").toLowerCase();
  if (/(cisco|ios|catalyst|nexus|nx-?os|\bsw\d|switch|router|\brtr\b|\basa\b)/.test(s)) return "cisco-ios";
  if (/(esxi|vmware|vsphere)/.test(s)) return "esxi";
  if (/(mikrotik|routeros)/.test(s)) return "routeros";
  if (/(juniper|junos)/.test(s)) return "junos";
  return "linux";
}

/** Определить платформу по ВЫВОДУ терминала (последние строки). Сильные сигнатуры
 *  сетевых ОС — чтобы не выдавать linux-команды на Cisco и т.п. Возвращает ярлык
 *  или null (тогда падаем на guessOs по имени хоста). ПРИВАТНО: наружу уходит
 *  только ярлык платформы, НЕ текст экрана — работает и без «AI видит экран». */
export function detectPlatform(screenTail?: string | null): string | null {
  const raw = screenTail || "";
  const t = raw.toLowerCase();
  if (!t.trim()) return null;
  // MikroTik / Juniper / VyOS — характерные приглашения/маркеры.
  if (/\[[\w.-]+@[\w.-]+\]\s*>|routeros|mikrotik/.test(t)) return "routeros";
  if (/junos|\{master(:\d+)?\}|\bjuniper\b/.test(t)) return "junos";
  if (/vyos@|\bvyos\b/.test(t)) return "vyos";
  // Cisco IOS/IOS-XE/NX-OS — сильные маркеры вывода.
  if (
    /\(config[^)]*\)\s*#/.test(t) || // config-режим: hostname(config)# / (config-if)#
    /% (invalid input|incomplete command|ambiguous command|bad|unknown command)/.test(t) ||
    /building configuration|line protocol is|show running-config|\bcisco ios\b|ios[ -]xe|nx-?os|catalyst/.test(t) ||
    /(gigabit|fast|ten-?gig)ethernet\d/.test(t)
  )
    return "cisco-ios";
  // По приглашению (когда вывода ещё нет — чистая сессия). Берём последнюю
  // непустую строку экрана.
  const lines = raw.split(/\r?\n/).map((l) => l.replace(/\s+$/, "")).filter((l) => l.trim());
  const last = (lines[lines.length - 1] || "").trim();
  // Явно shell-приглашения → linux (исключаем ложняк ниже).
  if (/^(sh|bash|zsh|ash|dash|ksh)-[\d.]+\s*[#$]\s*$/.test(last)) return null;
  if (/[@:~]|\/.*[#$]\s*$/.test(last)) return null; // user@host:~$ / [root@h ~]# / путь
  // hostname>  — user-exec, у linux такого приглашения не бывает → сеть.
  if (/^[A-Za-z][\w.\-]{0,48}>\s*$/.test(last)) return "cisco-ios";
  // hostname#  — enable-режим, без linux-признаков (нет @ : / — отсеяны выше) → сеть.
  if (/^[A-Za-z][\w.\-]{0,48}#\s*$/.test(last)) return "cisco-ios";
  return null;
}
