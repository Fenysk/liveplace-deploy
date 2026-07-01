import type { ButtonHTMLAttributes, ReactElement, ReactNode } from "react";
import { buttonClass, type ButtonSize, type ButtonVariant } from "./variants.js";

/**
 * Button (handoff §3.1 / AC2) — the ONE button definition. Every CTA in the app
 * routes through here; no hand-styled `<button>` anywhere. Covers all states:
 * default · hover · focus-visible · active · loading · disabled, across
 * primary/secondary/ghost × sm/md/lg. Token-only styling lives in
 * `styles/components.css`; class mapping is the unit-tested `buttonClass`.
 */
export interface ButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "className"> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Shows a spinner and blocks interaction without collapsing layout. */
  loading?: boolean;
  /** Leading icon (already sized by the caller; inherits currentColor). */
  icon?: ReactNode;
  children?: ReactNode;
  className?: string;
}

export function Button({
  variant = "primary",
  size = "md",
  loading = false,
  icon,
  children,
  disabled,
  type = "button",
  className,
  ...rest
}: ButtonProps): ReactElement {
  return (
    <button
      type={type}
      className={buttonClass(variant, size, className)}
      disabled={disabled || loading}
      data-loading={loading || undefined}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading && <span className="ui-btn__spinner" aria-hidden="true" />}
      {icon}
      {children}
    </button>
  );
}
