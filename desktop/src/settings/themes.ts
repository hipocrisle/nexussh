// Themes — palette role mapping is the same across all 4 themes.
//
// This file replaces desktop/src/settings/themes.ts.
// Diff vs. current: ThemePalette gets 6 new fields, plus an applyTheme() helper.

export interface ThemePalette {
  label: string;
  bgBase: string;
  bgSecondary: string;
  bgPanel: string;
  bgElevated: string;
  border: string;
  textPrimary: string;
  textMuted: string;
  textSoft: string;
  accent: string;
  accent2: string;
  warning: string;
  error: string;

  /* —— NEW: depth + glow + chrome —— */
  textDim:     string;
  divider:     string;
  edgeTop:     string;
  edgeBot:     string;
  accentGlow:  string;
  rainOverlay: string;

  /** Three representative swatches for the theme card. */
  swatch: [string, string, string];
}

export type ThemeId = "matrix" | "solarized" | "dracula" | "light";

export const THEMES: Record<ThemeId, ThemePalette> = {
  matrix: {
    label: "Matrix Dark",
    bgBase: "#0a0e0e", bgSecondary: "#080b0b", bgPanel: "#0e1414",
    bgElevated: "#1f3a3a", border: "#1f3a3a",
    textPrimary: "#c9d1d9", textMuted: "#4a5560", textSoft: "#7fd7ff",
    accent: "#00ff95", accent2: "#00d4ff", warning: "#f5d76e", error: "#ff6b6b",
    textDim: "#97a8a0",
    divider: "rgba(31, 58, 58, 0.45)",
    edgeTop: "rgba(0, 255, 149, 0.06)",
    edgeBot: "rgba(0, 0, 0, 0.4)",
    accentGlow: "rgba(0, 255, 149, 0.18)",
    rainOverlay: "rgba(0, 255, 149, 0.035)",
    swatch: ["#0a0e0e", "#00ff95", "#7fd7ff"],
  },
  solarized: {
    label: "Solarized Dark",
    bgBase: "#002b36", bgSecondary: "#001f27", bgPanel: "#073642",
    bgElevated: "#0d4a59", border: "#0d4a59",
    textPrimary: "#93a1a1", textMuted: "#586e75", textSoft: "#2aa198",
    accent: "#b58900", accent2: "#268bd2", warning: "#cb4b16", error: "#dc322f",
    textDim: "#c4d2d2",
    divider: "rgba(13, 74, 89, 0.55)",
    edgeTop: "rgba(181, 137, 0, 0.06)",
    edgeBot: "rgba(0, 0, 0, 0.35)",
    accentGlow: "rgba(181, 137, 0, 0.22)",
    rainOverlay: "rgba(42, 161, 152, 0.035)",
    swatch: ["#002b36", "#b58900", "#268bd2"],
  },
  dracula: {
    label: "Dracula",
    bgBase: "#282a36", bgSecondary: "#1e1f29", bgPanel: "#343746",
    bgElevated: "#44475a", border: "#44475a",
    textPrimary: "#f8f8f2", textMuted: "#6272a4", textSoft: "#8be9fd",
    accent: "#50fa7b", accent2: "#bd93f9", warning: "#f1fa8c", error: "#ff5555",
    textDim: "#b1b6cf",
    divider: "rgba(68, 71, 90, 0.7)",
    edgeTop: "rgba(80, 250, 123, 0.05)",
    edgeBot: "rgba(0, 0, 0, 0.45)",
    accentGlow: "rgba(80, 250, 123, 0.18)",
    rainOverlay: "rgba(80, 250, 123, 0.03)",
    swatch: ["#282a36", "#bd93f9", "#ff79c6"],
  },
  light: {
    label: "Light",
    bgBase: "#f6f8fa", bgSecondary: "#eaeef2", bgPanel: "#ffffff",
    bgElevated: "#d0d7de", border: "#d0d7de",
    textPrimary: "#1f2328", textMuted: "#656d76", textSoft: "#0969da",
    accent: "#1a7f37", accent2: "#0969da", warning: "#9a6700", error: "#cf222e",
    textDim: "#424a53",
    divider: "rgba(208, 215, 222, 0.65)",
    edgeTop: "rgba(26, 127, 55, 0.05)",
    edgeBot: "rgba(0, 0, 0, 0.05)",
    accentGlow: "rgba(26, 127, 55, 0.16)",
    rainOverlay: "rgba(26, 127, 55, 0.0)",
    swatch: ["#ffffff", "#1a7f37", "#0969da"],
  },
};

/** xterm.js terminal theme derived from the active app palette. */
export function xtermThemeOf(t: ThemePalette) {
  return {
    background: t.bgBase, foreground: t.textPrimary,
    cursor: t.accent, cursorAccent: t.bgBase,
    // Selection must be clearly visible over coloured glyphs (the old bgElevated
    // was nearly indistinguishable from the background — invisible on mobile).
    // Semi-transparent accent reads on every theme. 8-digit hex (#rrggbbaa).
    selectionBackground: `${t.accent}59`, // ~35%
    selectionInactiveBackground: `${t.accent}33`, // ~20%
    black: t.bgBase, red: t.error, green: t.accent, yellow: t.warning,
    blue: t.accent2, magenta: t.accent2, cyan: t.textSoft, white: t.textPrimary,
    brightBlack: t.textMuted, brightRed: t.error, brightGreen: t.accent,
    brightYellow: t.warning, brightBlue: t.textSoft, brightMagenta: t.accent2,
    brightCyan: t.textSoft, brightWhite: t.textPrimary,
  };
}

/** Pump the active palette to CSS custom properties on :root. */
export function applyTheme(id: ThemeId) {
  const t = THEMES[id];
  const root = document.documentElement;
  const set = (k: string, v: string) => root.style.setProperty(k, v);

  set("--nx-bg-base",      t.bgBase);
  set("--nx-bg-secondary", t.bgSecondary);
  set("--nx-bg-panel",     t.bgPanel);
  set("--nx-bg-elevated",  t.bgElevated);
  set("--nx-border",       t.border);
  set("--nx-text-primary", t.textPrimary);
  set("--nx-text-muted",   t.textMuted);
  set("--nx-text-soft",    t.textSoft);
  set("--nx-accent",       t.accent);
  set("--nx-accent2",      t.accent2);
  set("--nx-warning",      t.warning);
  set("--nx-error",        t.error);

  // new
  set("--nx-text-dim",     t.textDim);
  set("--nx-divider",      t.divider);
  set("--nx-edge-top",     t.edgeTop);
  set("--nx-edge-bot",     t.edgeBot);
  set("--nx-accent-glow",  t.accentGlow);
  set("--nx-rain-overlay", t.rainOverlay);

  root.classList.remove("theme-matrix", "theme-solarized", "theme-dracula", "theme-light");
  root.classList.add(`theme-${id}`);
}
