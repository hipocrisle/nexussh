// Monospace font choices. Stack always falls back to a generic monospace.

export type FontId = "jetbrains" | "fira" | "cascadia" | "system";

export interface FontDef {
  id: FontId;
  label: string;
  /** Full CSS font-family value. */
  stack: string;
}

export const FONTS: FontDef[] = [
  { id: "jetbrains", label: "JetBrains Mono", stack: '"JetBrains Mono", monospace' },
  { id: "fira", label: "Fira Code", stack: '"Fira Code", monospace' },
  { id: "cascadia", label: "Cascadia Code", stack: '"Cascadia Code", monospace' },
  { id: "system", label: "System Mono", stack: "ui-monospace, SFMono-Regular, Menlo, monospace" },
];

export function fontStackOf(id: FontId): string {
  return FONTS.find((f) => f.id === id)?.stack ?? FONTS[0].stack;
}
