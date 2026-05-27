// Themes — palette role mapping is the same across all 4 themes, so the
// component code can re-theme live just by swapping the active theme object.

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
  /** Three representative swatches for the theme card. */
  swatch: [string, string, string];
}

export type ThemeId = "matrix" | "solarized" | "dracula" | "light";

export const THEMES: Record<ThemeId, ThemePalette> = {
  matrix: {
    label: "Matrix Dark",
    bgBase: "#0a0e0e",
    bgSecondary: "#080b0b",
    bgPanel: "#0e1414",
    bgElevated: "#1f3a3a",
    border: "#1f3a3a",
    textPrimary: "#c9d1d9",
    textMuted: "#4a5560",
    textSoft: "#7fd7ff",
    accent: "#00ff95",
    accent2: "#00d4ff",
    warning: "#f5d76e",
    error: "#ff6b6b",
    swatch: ["#0a0e0e", "#00ff95", "#7fd7ff"],
  },
  solarized: {
    label: "Solarized Dark",
    bgBase: "#002b36",
    bgSecondary: "#001f27",
    bgPanel: "#073642",
    bgElevated: "#0d4a59",
    border: "#0d4a59",
    textPrimary: "#93a1a1",
    textMuted: "#586e75",
    textSoft: "#2aa198",
    accent: "#b58900",
    accent2: "#268bd2",
    warning: "#cb4b16",
    error: "#dc322f",
    swatch: ["#002b36", "#b58900", "#268bd2"],
  },
  dracula: {
    label: "Dracula",
    bgBase: "#282a36",
    bgSecondary: "#1e1f29",
    bgPanel: "#343746",
    bgElevated: "#44475a",
    border: "#44475a",
    textPrimary: "#f8f8f2",
    textMuted: "#6272a4",
    textSoft: "#8be9fd",
    accent: "#50fa7b",
    accent2: "#bd93f9",
    warning: "#f1fa8c",
    error: "#ff5555",
    swatch: ["#282a36", "#bd93f9", "#ff79c6"],
  },
  light: {
    label: "Light",
    bgBase: "#f6f8fa",
    bgSecondary: "#eaeef2",
    bgPanel: "#ffffff",
    bgElevated: "#d0d7de",
    border: "#d0d7de",
    textPrimary: "#1f2328",
    textMuted: "#656d76",
    textSoft: "#0969da",
    accent: "#1a7f37",
    accent2: "#0969da",
    warning: "#9a6700",
    error: "#cf222e",
    swatch: ["#ffffff", "#1a7f37", "#0969da"],
  },
};

/** xterm.js terminal theme derived from the active app palette. */
export function xtermThemeOf(t: ThemePalette) {
  return {
    background: t.bgBase,
    foreground: t.textPrimary,
    cursor: t.accent,
    cursorAccent: t.bgBase,
    selectionBackground: t.bgElevated,
    black: t.bgBase,
    red: t.error,
    green: t.accent,
    yellow: t.warning,
    blue: t.accent2,
    magenta: t.accent2,
    cyan: t.textSoft,
    white: t.textPrimary,
    brightBlack: t.textMuted,
    brightRed: t.error,
    brightGreen: t.accent,
    brightYellow: t.warning,
    brightBlue: t.textSoft,
    brightMagenta: t.accent2,
    brightCyan: t.textSoft,
    brightWhite: t.textPrimary,
  };
}
