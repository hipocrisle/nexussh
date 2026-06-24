// Shared UI primitives for the redesigned panels (SFTP / History / HostDialog
// / Popover). Separate from settings/primitives.tsx (which is settings-specific)
// to avoid cross-contamination. All theming via the --nx-* token utilities.

import React, { ReactNode, forwardRef } from "react";
import { Check, Eye, EyeOff } from "lucide-react";

// ============================================================
// Button
// ============================================================

type ButtonVariant = "primary" | "secondary" | "ghost" | "destructive";
type ButtonSize = "sm" | "md";

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  leadingIcon?: ReactNode;
  trailingIcon?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", leadingIcon, trailingIcon, className = "", children, ...rest },
  ref,
) {
  const variantCls = {
    primary:
      "bg-nx-accent text-nx-bg font-semibold " +
      "shadow-[inset_0_1px_0_rgba(255,255,255,0.18),0_0_18px_var(--nx-accent-glow)] " +
      "hover:brightness-110",
    secondary:
      "bg-transparent text-nx-soft border border-nx-border " +
      "hover:bg-nx-elevated hover:border-nx-accent hover:text-nx-accent",
    ghost: "bg-transparent text-nx-muted hover:bg-nx-elevated hover:text-nx-text",
    destructive:
      "bg-transparent text-nx-error border border-[rgba(255,107,107,0.35)] " +
      "hover:bg-[rgba(255,107,107,0.08)] hover:border-nx-error",
  }[variant];

  const sizeCls = size === "sm" ? "px-2.5 py-1 text-meta" : "px-3.5 py-1.5 text-body";

  return (
    <button
      ref={ref}
      className={`nx-focus inline-flex items-center gap-2 rounded-nx font-mono transition-colors duration-[80ms] disabled:opacity-45 disabled:cursor-not-allowed ${sizeCls} ${variantCls} ${className}`}
      {...rest}
    >
      {leadingIcon}
      {children}
      {trailingIcon}
    </button>
  );
});

// ============================================================
// IconButton — square ghost button for toolbar icons
// ============================================================

interface IconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  icon: ReactNode;
}
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
  function IconButton({ icon, className = "", ...rest }, ref) {
    return (
      <button
        ref={ref}
        className={`nx-focus inline-flex items-center justify-center p-1.5 text-nx-muted hover:bg-nx-elevated hover:text-nx-text rounded-nx-sm transition-colors duration-[80ms] disabled:opacity-45 disabled:cursor-not-allowed ${className}`}
        {...rest}
      >
        {icon}
      </button>
    );
  },
);

// ============================================================
// Input
// ============================================================

interface InputBaseProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "onChange"> {
  onChange?: (v: string) => void;
  invalid?: boolean;
}
export const Input = forwardRef<HTMLInputElement, InputBaseProps>(function Input(
  { className = "", invalid, onChange, ...rest },
  ref,
) {
  return (
    <input
      ref={ref}
      onChange={(e) => onChange?.(e.target.value)}
      className={
        "nx-focus block w-full mt-1.5 px-2.5 py-1.5 bg-nx-panel border rounded-nx font-mono text-body text-nx-text placeholder-nx-muted max-md:py-3 max-md:text-[15px] " +
        (invalid
          ? "border-nx-error shadow-[0_0_0_3px_rgba(255,107,107,0.18)] text-nx-error"
          : "border-nx-border") +
        " " +
        className
      }
      {...rest}
    />
  );
});

// ============================================================
// Checkbox
// ============================================================

interface CheckboxProps {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: ReactNode;
  hint?: ReactNode;
  className?: string;
}
export function Checkbox({ checked, onChange, label, hint, className = "" }: CheckboxProps) {
  return (
    <label className={`flex items-start gap-2.5 cursor-pointer ${className}`}>
      <span
        role="checkbox"
        aria-checked={checked}
        tabIndex={0}
        onClick={() => onChange(!checked)}
        onKeyDown={(e) => {
          // Space toggles; Enter is left to bubble (e.g. to submit a form).
          if (e.key === " ") {
            e.preventDefault();
            onChange(!checked);
          }
        }}
        className={
          "nx-focus mt-0.5 w-3 h-3 border rounded-sm inline-flex items-center justify-center shrink-0 transition-colors duration-[80ms] " +
          (checked ? "bg-nx-accent border-nx-accent" : "bg-nx-panel border-nx-border")
        }
      >
        {checked && <Check size={9} className="text-nx-bg" strokeWidth={3} />}
      </span>
      {(label || hint) && (
        <span className="leading-tight">
          {label && <span className="text-body text-nx-text">{label}</span>}
          {hint && (
            <span className="block text-meta text-nx-muted mt-0.5 leading-relaxed">{hint}</span>
          )}
        </span>
      )}
    </label>
  );
}

// ============================================================
// Toggle (switch)
// ============================================================

interface ToggleProps {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: ReactNode;
}
export function Toggle({ checked, onChange, label }: ToggleProps) {
  return (
    <label className="inline-flex items-center gap-2.5 cursor-pointer">
      <span
        onClick={() => onChange(!checked)}
        className={
          "relative inline-block w-[30px] h-4 rounded-full border transition-colors duration-[80ms] " +
          (checked
            ? "bg-nx-accent border-nx-accent shadow-[0_0_12px_var(--nx-accent-glow)]"
            : "bg-nx-elevated border-nx-border")
        }
      >
        <span
          className={
            "absolute top-[1px] w-3 h-3 rounded-full transition-all duration-[80ms] " +
            (checked ? "left-[16px] bg-nx-bg" : "left-[2px] bg-nx-muted")
          }
        />
      </span>
      {label && <span className="text-body">{label}</span>}
    </label>
  );
}

// ============================================================
// ToggleRow — labeled toggle in a flex row
// ============================================================

export function ToggleRow({
  label,
  value,
  onChange,
}: {
  label: string;
  value?: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between py-1.5">
      <span className="text-body">{label}</span>
      <Toggle checked={!!value} onChange={onChange} />
    </div>
  );
}

// ============================================================
// SegCtl — segmented control
// ============================================================

interface SegOption<V extends string> {
  value: V;
  label: ReactNode;
  icon?: ReactNode;
}
interface SegCtlProps<V extends string> {
  value: V;
  onChange: (v: V) => void;
  options: SegOption<V>[];
}
export function SegCtl<V extends string>({ value, onChange, options }: SegCtlProps<V>) {
  return (
    <div className="inline-flex border border-nx-border rounded-nx overflow-hidden font-mono">
      {options.map((opt, i) => {
        const isOn = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => onChange(opt.value)}
            className={
              "nx-focus px-3 py-1.5 text-meta uppercase tracking-[0.12em] inline-flex items-center gap-1.5 " +
              (i > 0 ? "border-l border-nx-border " : "") +
              (isOn
                ? "bg-nx-elevated text-nx-accent shadow-[inset_0_0_0_1px_var(--nx-accent-glow),inset_0_0_12px_var(--nx-accent-glow)]"
                : "bg-nx-panel text-nx-muted hover:text-nx-text")
            }
          >
            {opt.icon}
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

// ============================================================
// Chip — small inline badge
// ============================================================

type ChipVariant = "default" | "accent" | "warn" | "error" | "soft" | "cyan";

interface ChipProps {
  variant?: ChipVariant;
  children: ReactNode;
  className?: string;
}
export function Chip({ variant = "default", children, className = "" }: ChipProps) {
  const cls = {
    default: "text-nx-soft border-nx-border bg-nx-elevated",
    accent: "text-nx-accent border-[rgba(0,255,149,0.35)] bg-nx-elevated",
    warn: "text-nx-warning border-[rgba(245,215,110,0.35)] bg-nx-elevated",
    error: "text-nx-error border-[rgba(255,107,107,0.35)] bg-nx-elevated",
    soft: "text-nx-soft border-[rgba(127,215,255,0.35)] bg-nx-elevated",
    cyan: "text-nx-accent2 border-[rgba(0,212,255,0.35)] bg-nx-elevated",
  }[variant];
  return (
    <span
      className={`inline-flex items-center px-1.5 py-[1px] text-micro uppercase tracking-[0.08em] rounded-nx-sm border ${cls} ${className}`}
    >
      {children}
    </span>
  );
}

// ============================================================
// RowLabel — uppercase tracked field label
// ============================================================

export function RowLabel({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={`block text-micro uppercase tracking-[0.12em] text-nx-soft ${className}`}>
      {children}
    </label>
  );
}

// ============================================================
// PasswordInput — Input + show/hide eye
// ============================================================

export function PasswordInput({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  const [shown, setShown] = React.useState(false);
  return (
    <div className="relative">
      <Input
        type={shown ? "text" : "password"}
        value={value}
        onChange={onChange}
        placeholder={placeholder}
      />
      <button
        type="button"
        onClick={() => setShown((s) => !s)}
        className="absolute right-1 top-1/2 -translate-y-1/2 p-1.5 text-nx-muted hover:text-nx-text"
      >
        {shown ? <EyeOff size={14} /> : <Eye size={14} />}
      </button>
    </div>
  );
}
