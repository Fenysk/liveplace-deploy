import type { HTMLAttributes, ReactElement, ReactNode } from "react";
import { cx } from "./variants.js";

/**
 * Layout / surface primitives (handoff §3 — "primitives de layout/surfaces").
 * Thin, token-only building blocks the screens compose with, so spacing,
 * surfaces and the empty/loading states are uniform and never re-styled ad hoc.
 */

type DivProps = HTMLAttributes<HTMLDivElement>;

/** A neutral page/section surface (`--ui-surface`). */
export function Surface({ className, ...rest }: DivProps): ReactElement {
  return <div className={cx("ui-surface", className)} {...rest} />;
}

/** A raised card (`--ui-surface-raised` + border + elevation + card radius). */
export function Card({ className, ...rest }: DivProps): ReactElement {
  return <div className={cx("ui-card", className)} {...rest} />;
}

/** Vertical stack with token gap. */
export function Stack({ className, ...rest }: DivProps): ReactElement {
  return <div className={cx("ui-stack", className)} {...rest} />;
}

/** Horizontal, vertically-centred row with token gap. */
export function Row({ className, ...rest }: DivProps): ReactElement {
  return <div className={cx("ui-row", className)} {...rest} />;
}

/** Pulsed loading placeholder (respects prefers-reduced-motion). */
export function Skeleton({
  className,
  ...rest
}: DivProps): ReactElement {
  return (
    <div className={cx("ui-skeleton", className)} aria-hidden="true" {...rest} />
  );
}

/** Empty-state surface: a CTA-to-seed slot (planche §4). */
export function EmptyState({
  title,
  children,
  action,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}): ReactElement {
  return (
    <div className="ui-empty">
      <strong>{title}</strong>
      {children}
      {action}
    </div>
  );
}

