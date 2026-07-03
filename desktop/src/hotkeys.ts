// Настраиваемые горячие клавиши. Строка биндинга: модификаторы + e.code, напр.
// "Mod+Shift+KeyZ". "Mod" = основной модификатор (Ctrl на Win/Linux, Cmd на mac)
// → матчится как e.ctrlKey || e.metaKey (как везде в App). Используем e.code
// (физическая клавиша) — раскладко-независимо.

export interface Hotkey {
  mod: boolean; // Ctrl/Cmd
  shift: boolean;
  alt: boolean;
  code: string; // e.code, напр. "KeyZ"
}

export function parseHotkey(s: string): Hotkey | null {
  if (!s) return null;
  const parts = s.split("+").map((p) => p.trim());
  const code = parts[parts.length - 1];
  if (!code) return null;
  const mods = parts.slice(0, -1).map((p) => p.toLowerCase());
  return {
    mod: mods.includes("mod") || mods.includes("ctrl") || mods.includes("cmd"),
    shift: mods.includes("shift"),
    alt: mods.includes("alt"),
    code,
  };
}

/** Совпадает ли событие с биндингом. */
export function eventMatches(e: KeyboardEvent | React.KeyboardEvent, binding: string): boolean {
  const h = parseHotkey(binding);
  if (!h) return false;
  const mod = e.ctrlKey || e.metaKey;
  return (
    mod === h.mod &&
    e.shiftKey === h.shift &&
    e.altKey === h.alt &&
    (e as KeyboardEvent).code === h.code
  );
}

/** Событие → строка биндинга, если это валидная комбинация (нужен Mod или Alt +
 *  не-модификаторная клавиша). Иначе null (напр. нажат только Shift). */
export function eventToHotkey(e: KeyboardEvent | React.KeyboardEvent): string | null {
  const code = (e as KeyboardEvent).code;
  if (!code || /^(Control|Shift|Alt|Meta)(Left|Right)?$/.test(code)) return null;
  const mod = e.ctrlKey || e.metaKey;
  if (!mod && !e.altKey) return null; // требуем модификатор — безопасный глобальный хоткей
  const parts: string[] = [];
  if (mod) parts.push("Mod");
  if (e.shiftKey) parts.push("Shift");
  if (e.altKey) parts.push("Alt");
  parts.push(code);
  return parts.join("+");
}

/** Красивая подпись для UI: "Ctrl+Shift+Z". */
export function hotkeyLabel(s: string): string {
  const h = parseHotkey(s);
  if (!h) return "—";
  const parts: string[] = [];
  if (h.mod) parts.push("Ctrl");
  if (h.shift) parts.push("Shift");
  if (h.alt) parts.push("Alt");
  parts.push(h.code.replace(/^Key/, "").replace(/^Digit/, "").replace(/^Arrow/, ""));
  return parts.join("+");
}
