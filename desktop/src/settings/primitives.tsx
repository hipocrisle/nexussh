// Settings primitives — Section, Row, Toggle, Slider, NumField, TextField,
// ThemeCard, FontCard. All take the active theme palette `t` so the same
// component re-themes when settings.theme changes.

import { Check } from "lucide-react";
import { ThemePalette, ThemeId, THEMES } from "./themes";
import { FontDef } from "./fonts";

interface SectionProps {
  id: string;
  label: string;
  kicker: string;
  children: React.ReactNode;
  t: ThemePalette;
}

export function Section({ id, label, kicker, children, t }: SectionProps) {
  return (
    <section id={id} className="mb-12">
      <div className="flex items-baseline gap-3 mb-1">
        <span
          className="font-mono text-xs uppercase tracking-[0.2em]"
          style={{ color: t.accent }}
        >
          // {kicker}
        </span>
      </div>
      <h2 className="font-mono text-2xl mb-6" style={{ color: t.textPrimary }}>
        <span style={{ color: t.accent }}>&gt;</span> {label}
      </h2>
      <div className="space-y-6">{children}</div>
    </section>
  );
}

/** A labelled divider that visually groups the Rows under it — used to separate
 *  the VPN types (Xray / OpenConnect / L2TP) so they don't read as one heap. */
export function SubHeader({ label, t }: { label: string; t: ThemePalette }) {
  return (
    <div className="flex items-center gap-3 pt-6 first:pt-0">
      <span
        className="font-mono text-sm uppercase tracking-[0.15em] whitespace-nowrap"
        style={{ color: t.accent }}
      >
        {label}
      </span>
      <div className="flex-1 h-px" style={{ background: t.border }} />
    </div>
  );
}

interface RowProps {
  label: string;
  hint?: string;
  children: React.ReactNode;
  t: ThemePalette;
}

export function Row({ label, hint, children, t }: RowProps) {
  return (
    <div
      className="grid grid-cols-[200px_1fr] gap-6 items-start pb-5 border-b max-md:grid-cols-1 max-md:gap-2 max-md:pb-4"
      style={{ borderColor: t.border + "99" }}
    >
      <div>
        <div
          className="font-mono text-xs uppercase tracking-wider max-md:text-[13px] max-md:normal-case max-md:tracking-normal"
          style={{ color: t.textSoft }}
        >
          {label}
        </div>
        {hint && (
          <div
            className="font-mono text-[11px] mt-1 leading-relaxed max-md:text-[12px]"
            style={{ color: t.textMuted }}
          >
            {hint}
          </div>
        )}
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

interface ToggleProps {
  checked: boolean;
  onChange: (v: boolean) => void;
  t: ThemePalette;
  label?: string;
  onLabel: string;
  offLabel: string;
  enabledLabel: string;
  disabledLabel: string;
}

export function Toggle({
  checked,
  onChange,
  t,
  label,
  onLabel,
  offLabel,
  enabledLabel,
  disabledLabel,
}: ToggleProps) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className="font-mono text-xs flex items-center gap-3 group cursor-pointer"
      style={{ color: t.textPrimary }}
    >
      <span
        className="relative inline-block w-9 h-5 rounded-full transition-colors"
        style={{
          background: checked ? t.accent : t.bgPanel,
          border: `1px solid ${checked ? t.accent : t.border}`,
          boxShadow: checked ? `0 0 12px ${t.accent}44` : "none",
        }}
      >
        <span
          className="absolute top-0.5 w-3.5 h-3.5 rounded-full transition-all"
          style={{
            left: checked ? "18px" : "2px",
            background: checked ? t.bgBase : t.textMuted,
          }}
        />
      </span>
      {label ? (
        <span
          className="uppercase tracking-wider text-[10px]"
          style={{ color: checked ? t.accent : t.textMuted }}
        >
          {checked ? onLabel.toUpperCase() : offLabel.toUpperCase()} · {label}
        </span>
      ) : (
        <span
          className="uppercase tracking-wider text-[10px]"
          style={{ color: checked ? t.accent : t.textMuted }}
        >
          {checked ? enabledLabel : disabledLabel}
        </span>
      )}
    </button>
  );
}

interface NumFieldProps {
  value: number;
  onChange: (v: number) => void;
  suffix?: string;
  min?: number;
  max?: number;
  t: ThemePalette;
  width?: number;
}

export function NumField({
  value,
  onChange,
  suffix,
  min,
  max,
  t,
  width = 120,
}: NumFieldProps) {
  return (
    <div
      className="inline-flex items-center font-mono text-sm"
      style={{ width }}
    >
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        onChange={(e) => onChange(Number(e.target.value))}
        className="flex-1 min-w-0 px-3 py-2 rounded-l outline-none border"
        style={{
          background: t.bgPanel,
          borderColor: t.border,
          color: t.textPrimary,
          fontFamily: "inherit",
        }}
      />
      {suffix && (
        <span
          className="px-2 py-2 text-[10px] uppercase tracking-wider rounded-r border border-l-0"
          style={{
            background: t.bgSecondary,
            borderColor: t.border,
            color: t.textMuted,
          }}
        >
          {suffix}
        </span>
      )}
    </div>
  );
}

interface TextFieldProps {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  /** Input type — "password" masks the value (e.g. a pre-shared key). */
  type?: "text" | "password";
  t: ThemePalette;
}

export function TextField({
  value,
  onChange,
  placeholder,
  type = "text",
  t,
}: TextFieldProps) {
  return (
    <input
      type={type}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className="w-full px-3 py-2 rounded outline-none border text-sm font-mono"
      style={{
        background: t.bgPanel,
        borderColor: t.border,
        color: t.textPrimary,
      }}
      onFocus={(e) => (e.target.style.borderColor = t.accent)}
      onBlur={(e) => (e.target.style.borderColor = t.border)}
    />
  );
}

interface SliderProps {
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  step?: number;
  t: ThemePalette;
  format?: (v: number) => string;
}

export function Slider({
  value,
  onChange,
  min,
  max,
  step = 1,
  t,
  format,
}: SliderProps) {
  const pct = ((value - min) / (max - min)) * 100;
  return (
    <div className="flex items-center gap-4 w-full max-w-md">
      <div
        className="relative flex-1 h-1 rounded-full"
        style={{ background: t.bgPanel, border: `1px solid ${t.border}` }}
      >
        <div
          className="absolute left-0 top-0 h-full rounded-full"
          style={{
            width: `${pct}%`,
            background: t.accent,
            boxShadow: `0 0 8px ${t.accent}88`,
          }}
        />
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          className="absolute inset-0 w-full opacity-0 cursor-pointer"
          style={{ height: "24px", top: "-12px" }}
        />
        <div
          className="absolute w-3 h-3 rounded-full -top-1 pointer-events-none"
          style={{
            left: `calc(${pct}% - 6px)`,
            background: t.accent,
            boxShadow: `0 0 10px ${t.accent}`,
          }}
        />
      </div>
      <span
        className="font-mono text-xs tabular-nums w-20 text-right"
        style={{ color: t.textPrimary }}
      >
        {format ? format(value) : value}
      </span>
    </div>
  );
}

interface ThemeCardProps {
  id: ThemeId;
  theme: ThemePalette;
  themeLabel: string;
  active: boolean;
  onPick: (id: ThemeId) => void;
  /** Outer (active) theme — used for the active-state border/glow. */
  t: ThemePalette;
}

export function ThemeCard({
  id,
  theme,
  themeLabel,
  active,
  onPick,
  t,
}: ThemeCardProps) {
  return (
    <button
      type="button"
      onClick={() => onPick(id)}
      className="text-left rounded transition-all relative overflow-hidden"
      style={{
        background: theme.bgBase,
        border: `1px solid ${active ? t.accent : t.border}`,
        boxShadow: active ? `0 0 0 1px ${t.accent}, 0 0 24px ${t.accent}33` : "none",
      }}
    >
      <div
        className="px-3 py-2 border-b flex items-center gap-1.5"
        style={{ background: theme.bgSecondary, borderColor: theme.border }}
      >
        <span
          className="w-1.5 h-1.5 rounded-full"
          style={{ background: theme.error }}
        />
        <span
          className="w-1.5 h-1.5 rounded-full"
          style={{ background: theme.warning }}
        />
        <span
          className="w-1.5 h-1.5 rounded-full"
          style={{ background: theme.accent }}
        />
        <span
          className="ml-2 text-[9px] uppercase tracking-wider font-mono"
          style={{ color: theme.textMuted }}
        >
          nexussh
        </span>
      </div>
      <div className="px-3 py-3 font-mono text-[11px] leading-relaxed h-28">
        <div style={{ color: theme.accent }}>$ ssh root@prod-01.nexussh</div>
        <div style={{ color: theme.textPrimary }}>
          Welcome to{" "}
          <span style={{ color: theme.accent2 }}>Ubuntu 22.04</span>
        </div>
        <div style={{ color: theme.textMuted }}>Last login: Mon May 25 14:32</div>
        <div style={{ color: theme.textPrimary }}>
          root@prod-01:~# <span style={{ color: theme.accent }}>▊</span>
        </div>
      </div>
      <div
        className="px-3 py-2 border-t flex items-center justify-between"
        style={{ borderColor: theme.border, background: theme.bgSecondary }}
      >
        <span
          className="font-mono text-[10px] uppercase tracking-wider"
          style={{ color: theme.textSoft }}
        >
          {themeLabel}
        </span>
        <div className="flex gap-1">
          {theme.swatch.map((c, i) => (
            <span
              key={i}
              className="w-2.5 h-2.5 rounded-sm"
              style={{ background: c, border: `1px solid ${theme.border}` }}
            />
          ))}
        </div>
      </div>
      {active && (
        <div
          className="absolute top-2 right-2 flex items-center justify-center w-5 h-5 rounded-full"
          style={{ background: t.accent, color: t.bgBase }}
        >
          <Check size={12} />
        </div>
      )}
    </button>
  );
}

// keep THEMES import handy
export { THEMES };

interface FontCardProps {
  font: FontDef;
  active: boolean;
  sampleSize: number;
  onPick: (id: FontDef["id"]) => void;
  t: ThemePalette;
  sampleCmd: string;
  sampleCode: string;
  sampleComment: string;
}

export function FontCard({
  font,
  active,
  sampleSize,
  onPick,
  t,
  sampleCmd,
  sampleCode,
  sampleComment,
}: FontCardProps) {
  return (
    <button
      type="button"
      onClick={() => onPick(font.id)}
      className="text-left rounded p-4 transition-all relative"
      style={{
        background: t.bgPanel,
        border: `1px solid ${active ? t.accent : t.border}`,
        boxShadow: active ? `0 0 0 1px ${t.accent}` : "none",
      }}
    >
      <div className="flex items-center justify-between mb-3">
        <span
          className="font-mono text-[10px] uppercase tracking-wider"
          style={{ color: t.textSoft }}
        >
          {font.label}
        </span>
        {active && (
          <span style={{ color: t.accent }}>
            <Check size={12} />
          </span>
        )}
      </div>
      <div
        style={{
          fontFamily: font.stack,
          color: t.textPrimary,
          fontSize: `${sampleSize}px`,
          lineHeight: 1.4,
        }}
      >
        <div style={{ color: t.accent }}>{sampleCmd}</div>
        <div>{sampleCode}</div>
        <div style={{ color: t.textMuted }}>{sampleComment}</div>
      </div>
    </button>
  );
}
